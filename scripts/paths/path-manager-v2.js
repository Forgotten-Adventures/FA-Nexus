import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { premiumEntitlementsService } from '../premium/premium-entitlements-service.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import { applyPathTile, cleanupPathOverlay } from './path-tiles.js';
import { toolOptionsController } from '../core/tool-options-controller.js';
import {
  createNormalizedToolOptionsDescriptor,
  TOOL_OPTIONS_RENDERER_MODE
} from '../core/tool-options-descriptor.js';
import { createShortcut, createStandardEditorShortcuts, mergeShortcutLists } from '../core/editor-shortcuts.js';
import { buildHsbcToolOptionsControls } from '../core/hsbc.js';
import { requestSelectionFilterRefresh } from '../canvas/selection-filter-refresh.js';

const MODULE_ID = 'fa-nexus';
const PATH_SUBTOOL_SETTING_KEY = 'pathToolActiveSubtool';
const PATH_ACTIVE_SUBTOOL_IDS = new Set(['curve', 'draw', 'edit-shapes']);
const PATH_PERSISTED_SUBTOOL_IDS = new Set(['curve', 'draw']);
const EDITING_TILES_KEY = '__faNexusPathEditingTiles';
const PATH_MIN_SPLITTABLE_POINTS = 3;

function getEditingTileSet() {
  try {
    const root = globalThis || window;
    const existing = root?.[EDITING_TILES_KEY];
    if (existing instanceof Set) return existing;
    const created = new Set();
    if (root) root[EDITING_TILES_KEY] = created;
    return created;
  } catch (_) {
    return new Set();
  }
}

function resolveTileDocument(target) {
  if (!target) return null;
  const TileDocument = globalThis?.foundry?.documents?.TileDocument;
  if (TileDocument && target instanceof TileDocument) return target;
  if (TileDocument && target?.document instanceof TileDocument) return target.document;
  if (target?.document) return target.document;
  if (typeof target === 'string' && canvas?.scene?.tiles?.get) {
    try { return canvas.scene.tiles.get(target) || null; } catch (_) { return null; }
  }
  return null;
}

function resolveTilePlaceableById(id) {
  if (!id) return null;
  try {
    const list = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    return list.find((tile) => tile?.document?.id === id) || null;
  } catch (_) {
    return null;
  }
}

function clonePathControlPoint(point = {}) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    widthLeft: Number.isFinite(point?.widthLeft) ? Number(point.widthLeft) : 1,
    widthRight: Number.isFinite(point?.widthRight) ? Number(point.widthRight) : 1
  };
}

function clonePathShadowPoint(point = {}) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    widthLeft: Number.isFinite(point?.widthLeft) ? Number(point.widthLeft) : 1,
    widthRight: Number.isFinite(point?.widthRight) ? Number(point.widthRight) : 1,
    offset: Number.isFinite(point?.offset) ? Number(point.offset) : 0,
    _anchorX: Number.isFinite(point?._anchorX) ? Number(point._anchorX) : undefined,
    _anchorY: Number.isFinite(point?._anchorY) ? Number(point._anchorY) : undefined,
    _anchorSegment: Number.isFinite(point?._anchorSegment) ? Number(point._anchorSegment) : undefined,
    _anchorT: Number.isFinite(point?._anchorT) ? Number(point._anchorT) : undefined
  };
}

export class PathManagerV2 {
  constructor(app) {
    this._app = app;
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._lastPersistedSubtool = null;
    this._toolDefaultsPersistTimer = null;
    this._editingTileId = null;
    this._sessionShortcutKeydownHandler = null;
    this._syncToolOptionsState();
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  hasSessionChanges() {
    if (!this._delegate?.isActive) return false;
    try {
      if (typeof this._delegate?.hasSessionChanges === 'function') {
        return !!this._delegate.hasSessionChanges();
      }
    } catch (_) {}
    return true;
  }

  get pathTension() {
    return this._delegate?.pathTension ?? 0;
  }

  setPathTension(value) {
    if (!this._delegate) return value;
    return this._delegate.setPathTension(value);
  }

  async _ensureDelegate() {
    if (this._delegate) return this._delegate;
    ensurePremiumFeaturesRegistered();
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const helper = await premiumFeatureBroker.resolve('path.edit.v2');
      let instance = null;
      if (helper?.create) instance = helper.create(this._app);
      else if (typeof helper === 'function') instance = new helper(this._app);
      if (!instance) throw new Error('Premium path editor v2 bundle missing PathManager implementation');
      this._delegate = instance;
      try { instance.attachHost?.(this); }
      catch (_) {}
      try {
        Logger.info?.('PathEditorV2.bundle.loaded', { version: instance?.version || '0.0.15' });
        const hooks = globalThis?.Hooks;
        hooks?.callAll?.('fa-nexus-path-editor-v2-loaded', { version: instance?.version || '0.0.15' });
      } catch (logError) {
        Logger.warn?.('PathEditorV2.bundle.loaded.logFailed', String(logError?.message || logError));
      }
      return instance;
    })();
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  }

  async start(...args) {
    this._cancelPlacementSessions();
    const delegate = await this._ensureDelegate();
    const wasActive = !!delegate?.isActive;
    if (!wasActive) this._clearEditingTile();
    let result;
    try {
      this._refreshDelegateToolDefaults();
      result = delegate.start?.(...args);
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({
        suppressSubtoolPersistence: true,
        suppressToolDefaultsPersistence: true
      });
      toolOptionsController.activateTool('path.edit.v2', { label: 'Path Editor v2' });
      this._beginToolWindowMonitor('path.edit.v2', delegate);
      this._installSessionShortcutListener();
      if (!wasActive) this._restoreSubtoolPreference();
      result = this._wrapSessionLaunchPromise(result, { phase: 'start' });
    } catch (error) {
      await this._handleSessionLaunchFailure(error, { phase: 'start' });
      throw error;
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  async editTile(targetTile, options = {}) {
    this._cancelPlacementSessions();
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed path editor bundle does not support editing existing tiles.');
    }
    const doc = resolveTileDocument(targetTile);
    if (doc) this._markEditingTile(doc);
    let result;
    try {
      this._refreshDelegateToolDefaults();
      result = delegate.editTile(targetTile, options);
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({
        suppressSubtoolPersistence: true,
        suppressToolDefaultsPersistence: true
      });
      toolOptionsController.activateTool('path.edit.v2', { label: 'Path Editor v2' });
      this._beginToolWindowMonitor('path.edit.v2', delegate);
      this._installSessionShortcutListener();
      result = this._wrapSessionLaunchPromise(result, { phase: 'edit', tileDoc: doc });
    } catch (error) {
      await this._handleSessionLaunchFailure(error, { phase: 'edit', tileDoc: doc });
      throw error;
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  _wrapSessionLaunchPromise(result, { phase = 'start', tileDoc = null } = {}) {
    if (!result || typeof result.then !== 'function') return result;
    return Promise.resolve(result).catch(async (error) => {
      await this._handleSessionLaunchFailure(error, { phase, tileDoc });
      throw error;
    });
  }

  async _handleSessionLaunchFailure(error, { phase = 'start', tileDoc = null } = {}) {
    Logger.error?.('PathManagerV2.session.launchFailed', {
      phase,
      error: String(error?.message || error),
      delegateActive: !!this._delegate?.isActive,
      editingTileId: tileDoc?.id || this._editingTileId || null,
      canvasReady: !!canvas?.ready,
      hasCanvasStage: !!canvas?.stage
    });
    this._cancelToolWindowMonitor();
    try {
      await Promise.resolve(this.stop({ reason: `${phase}-failed` }));
    } catch (stopError) {
      Logger.error?.('PathManagerV2.session.launchFailed.stopFailed', {
        phase,
        error: String(stopError?.message || stopError)
      });
      try { toolOptionsController.deactivateTool('path.edit.v2'); } catch (_) {}
      this._clearEditingTile(tileDoc);
    }
  }

  _isEditorHostReady() {
    try {
      if (!canvas?.ready || !canvas?.stage) return false;
      if (!this._app) return false;
      if (this._app.rendered === false) return false;
      if (!this._app.element) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  _stopOrphanedSession({ reason = 'host-context-unavailable' } = {}) {
    Logger.error?.('PathManagerV2.session.orphaned', {
      reason,
      delegateActive: !!this._delegate?.isActive,
      editingTileId: this._editingTileId || null,
      canvasReady: !!canvas?.ready,
      hasCanvasStage: !!canvas?.stage,
      appRendered: !!this._app?.rendered,
      hasAppElement: !!this._app?.element
    });
    this._cancelToolWindowMonitor();
    try {
      const result = this.stop({ reason });
      if (result && typeof result.catch === 'function') {
        result.catch((stopError) => {
          Logger.error?.('PathManagerV2.session.orphaned.stopFailed', {
            reason,
            error: String(stopError?.message || stopError)
          });
        });
      }
    } catch (stopError) {
      Logger.error?.('PathManagerV2.session.orphaned.stopFailed', {
        reason,
        error: String(stopError?.message || stopError)
      });
      try { toolOptionsController.deactivateTool('path.edit.v2'); } catch (_) {}
      this._clearEditingTile();
    }
  }

  _installSessionShortcutListener() {
    this._removeSessionShortcutListener();
    const root = globalThis?.window || globalThis;
    if (!root?.addEventListener) return;
    this._sessionShortcutKeydownHandler = (event) => this._handleSessionShortcutKeydown(event);
    root.addEventListener('keydown', this._sessionShortcutKeydownHandler, true);
  }

  _removeSessionShortcutListener() {
    const root = globalThis?.window || globalThis;
    const handler = this._sessionShortcutKeydownHandler;
    if (handler && root?.removeEventListener) {
      try { root.removeEventListener('keydown', handler, true); } catch (_) {}
    }
    this._sessionShortcutKeydownHandler = null;
  }

  _handleSessionShortcutKeydown(event) {
    const keyName = typeof event?.key === 'string' ? event.key : '';
    const keyLower = keyName.toLowerCase();
    if (keyLower !== 'x' || event?.repeat) return;
    if (event?.altKey || event?.ctrlKey || event?.metaKey) return;
    const delegate = this._delegate;
    if (!delegate?.isActive) return;
    if (typeof delegate?._shouldIgnoreKeyEvent === 'function' && delegate._shouldIgnoreKeyEvent(event, keyName)) return;
    const applied = this._splitHoveredPath();
    if (!applied) {
      Logger.debug?.('PathManagerV2.pathSplit.shortcutIgnored', {
        activePathId: delegate?._activePathId || null,
        editShapesMode: !!delegate?._editShapesMode,
        hasPointerWorld: !!delegate?._lastPointerWorld
      });
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  stop(...args) {
    this._cancelToolWindowMonitor();
    this._removeSessionShortcutListener();
    const finalize = () => {
      this._clearEditingTile();
      toolOptionsController.deactivateTool('path.edit.v2');
      requestSelectionFilterRefresh({
        reason: 'path-editor-v2-stop',
        source: 'path-manager-v2'
      });
    };
    if (!this._delegate) {
      finalize();
      return;
    }
    try {
      if (this._delegate?.isActive) this._persistDelegateToolDefaults();
      const result = this._delegate.stop?.(...args);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(finalize);
      }
      finalize();
      return result;
    } catch (error) {
      finalize();
      throw error;
    }
  }

  async savePath(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.savePath?.(...args);
  }

  async save(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.save?.(...args);
  }

  _scheduleEntitlementProbe() {
    ensurePremiumFeaturesRegistered();
    if (this._entitlementProbe) return this._entitlementProbe;
    const probe = (async () => {
      try {
        await premiumFeatureBroker.require('path.edit.v2', { revalidate: true, reason: 'path-edit-v2:revalidate' });
      } catch (error) {
        this._handleEntitlementFailure(error);
      } finally {
        if (this._entitlementProbe === probe) this._entitlementProbe = null;
      }
    })();
    this._entitlementProbe = probe;
    probe.catch(() => {});
    return probe;
  }

  _handleEntitlementFailure(error) {
    try { this.stop?.(); }
    catch (_) {}
    this._delegate = null;
    const hasAuth = this._hasPremiumAuth();
    if (!hasAuth) {
      Logger.info?.('PathManager.entitlement.skipDisconnect', {
        code: error?.code || error?.name,
        message: String(error?.message || error)
      });
      return;
    }
    const message = '🔐 Authentication expired - premium path editing v2 has been disabled. Please reconnect Patreon.';
    if (this._isAuthFailure(error)) {
      try { premiumEntitlementsService?.clear?.({ reason: 'path-revalidate-failed' }); }
      catch (_) {}
      try { game?.settings?.set?.('fa-nexus', 'patreon_auth_data', null); }
      catch (_) {}
      ui?.notifications?.warn?.(message);
    } else {
      const fallback = `Unable to confirm premium access: ${error?.message || error}`;
      ui?.notifications?.error?.(fallback);
    }
    try { Hooks?.callAll?.('fa-nexus-premium-auth-lost', { featureId: 'path.edit.v2', error }); }
    catch (_) {}
  }

  _isAuthFailure(error) {
    if (!error) return false;
    const code = String(error?.code || error?.name || '').toUpperCase();
    if (code && (/AUTH/.test(code) || ['STATE_MISSING', 'ENTITLEMENT_REQUIRED', 'HTTP_401', 'HTTP_403', 'SESSION_EXPIRED', 'STATE_INVALID'].includes(code))) {
      return true;
    }
    const message = String(error?.message || '').toLowerCase();
    return message.includes('auth') || message.includes('state');
  }

  _hasPremiumAuth() {
    try {
      const authData = game?.settings?.get?.('fa-nexus', 'patreon_auth_data');
      return !!(authData && authData.authenticated && authData.state);
    } catch (_) {
      return false;
    }
  }

  _cancelPlacementSessions() {
    try {
      const tabs = this._app?._tabManager?.getTabs?.();
      const assetsTab = tabs?.assets;
      const activeTab = this._app?._tabManager?.getActiveTab?.();
      const managers = [
        assetsTab?.placementManager,
        assetsTab?._placement,
        assetsTab?._controller?.placementManager,
        activeTab?.placementManager,
        activeTab?._placement,
        activeTab?._controller?.placementManager
      ];
      for (const manager of managers) {
        if (manager?.cancelPlacement) {
          try { manager.cancelPlacement('path-edit'); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  _beginToolWindowMonitor(toolId, delegate) {
    this._cancelToolWindowMonitor();
    if (!delegate) return;
    const token = { cancelled: false, handle: null, usingTimeout: false, toolId, lastOptionsSync: 0 };
    const schedule = (callback) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        token.usingTimeout = false;
        token.handle = window.requestAnimationFrame(callback);
      } else {
        token.usingTimeout = true;
        token.handle = setTimeout(callback, 200);
      }
    };
    const maybeSyncToolOptions = () => {
      const now = Date.now();
      if (token.lastOptionsSync && now - token.lastOptionsSync < 200) return;
      token.lastOptionsSync = now;
      this._syncToolOptionsState({
        suppressRender: true,
        suppressSubtoolPersistence: true,
        suppressToolDefaultsPersistence: true
      });
    };
    const tick = () => {
      if (token.cancelled) return;
      let active = false;
      try { active = !!delegate?.isActive; }
      catch (_) { active = false; }
      if (!active) {
        this._clearEditingTile();
        toolOptionsController.deactivateTool(toolId);
        this._cancelToolWindowMonitor();
        requestSelectionFilterRefresh({
          reason: 'path-editor-v2-monitor-stop',
          source: 'path-manager-v2'
        });
        return;
      }
      if (!this._isEditorHostReady()) {
        if (!token.hostFailureHandled) {
          token.hostFailureHandled = true;
          this._stopOrphanedSession({ reason: 'host-context-unavailable' });
        }
        return;
      }
      maybeSyncToolOptions();
      schedule(tick);
    };
    this._toolMonitor = token;
    schedule(tick);
  }

  _cancelToolWindowMonitor() {
    const token = this._toolMonitor;
    if (!token) return;
    token.cancelled = true;
    if (token.handle != null) {
      try {
        if (token.usingTimeout) clearTimeout(token.handle);
        else if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(token.handle);
      } catch (_) {}
    }
    this._toolMonitor = null;
  }

  _markEditingTile(doc) {
    const id = doc?.id;
    if (!id) return;
    if (this._editingTileId && this._editingTileId !== id) {
      this._clearEditingTile(this._editingTileId);
    }
    this._editingTileId = id;
    try { getEditingTileSet().add(id); } catch (_) {}
    const tile = doc?.object || resolveTilePlaceableById(id);
    if (tile) {
      try { cleanupPathOverlay(tile); } catch (_) {}
    }
  }

  _clearEditingTile(target = null) {
    const id = typeof target === 'string' ? target : target?.id || this._editingTileId;
    if (!id) return;
    try { getEditingTileSet().delete(id); } catch (_) {}
    if (this._editingTileId === id) this._editingTileId = null;
    const tile = (typeof target === 'object' && target?.object) ? target.object : resolveTilePlaceableById(id);
    if (tile) {
      try {
        Promise.resolve(applyPathTile(tile)).finally(() => {
          requestSelectionFilterRefresh({
            reason: 'path-editor-v2-edit-exit',
            source: 'path-manager-v2',
            tileIds: [id]
          });
        });
      } catch (_) {}
      return;
    }
    requestSelectionFilterRefresh({
      reason: 'path-editor-v2-edit-exit',
      source: 'path-manager-v2',
      tileIds: [id]
    });
  }

  _buildToolOptionsState() {
    const baseHints = [
      'LMB adds control points;',
      'LMB Drag existing points to adjust;',
      'Shift+LMB inserts along the path;',
      'Alt+LMB deletes the closest point.',
      'X splits the hovered open path at the hovered non-endpoint.',
      'Double-click ends the current path.',
      'Ctrl/Cmd+Wheel adjusts scale;',
      'Alt+Wheel, Alt+[ / ], or Alt+Up / Down change elevation (default 0.01, Shift 0.1, Ctrl/Cmd 0.001).',
      'Press Ctrl/Cmd+S to commit; tap S toggles grid snap and S + wheel changes subgrid density; ESC cancels.'
    ];
    let delegateState = {};
    let handlers = {};
    try {
      const descriptor = this._delegate?.getToolOptionsDescriptor?.();
      if (descriptor) {
        if (descriptor.state && typeof descriptor.state === 'object') delegateState = descriptor.state;
        if (descriptor.handlers && typeof descriptor.handlers === 'object') handlers = descriptor.handlers;
      }
    } catch (_) {}
    const mergedHints = [...baseHints];
    if (Array.isArray(delegateState?.hints)) {
      for (const hint of delegateState.hints) {
        if (typeof hint === 'string' && hint.trim()) mergedHints.push(hint.trim());
      }
    }
    const state = { ...delegateState, hints: mergedHints };
    return { state, handlers };
  }

  _resolveHoveredSplitTarget() {
    const delegate = this._delegate;
    if (!delegate?.isActive || !delegate?._editShapesMode) return null;
    if (delegate?._dragState) return null;
    if (typeof delegate?._isShadowEditing === 'function' && delegate._isShadowEditing()) return null;
    const pointerWorld = delegate?._lastPointerWorld;
    if (!pointerWorld || !Number.isFinite(pointerWorld.x) || !Number.isFinite(pointerWorld.y)) return null;
    if (typeof delegate?._selectSessionPathAtPoint === 'function') {
      const picked = !!delegate._selectSessionPathAtPoint(pointerWorld.x, pointerWorld.y);
      if (!picked) return null;
    }
    if (!delegate?._activePathId || delegate?._isClosed) return null;
    const points = Array.isArray(delegate?._points) ? delegate._points : [];
    if (points.length < PATH_MIN_SPLITTABLE_POINTS) return null;
    const splitIndex = typeof delegate?._findNearestPointIndex === 'function'
      ? delegate._findNearestPointIndex(pointerWorld.x, pointerWorld.y, 30, points)
      : -1;
    if (!Number.isInteger(splitIndex) || splitIndex <= 0 || splitIndex >= (points.length - 1)) return null;
    return {
      activePathId: delegate._activePathId || null,
      pointerWorld: { x: pointerWorld.x, y: pointerWorld.y },
      splitIndex
    };
  }

  _splitHoveredPath() {
    const target = this._resolveHoveredSplitTarget();
    if (!target) return false;
    const applied = this._splitPathAtIndex(target.splitIndex, { sourcePathId: target.activePathId });
    if (!applied) return false;
    try { this._delegate?._refreshCursorPreview?.(); } catch (_) {}
    this._syncToolOptionsState({
      suppressSubtoolPersistence: true,
      suppressToolDefaultsPersistence: true
    });
    return true;
  }

  _splitPathAtIndex(splitIndex, { sourcePathId = null } = {}) {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    const numericSplitIndex = Number(splitIndex);
    const snapshot = delegate?._captureHistorySnapshot?.();
    if (!snapshot || !Array.isArray(snapshot.sessionPaths)) {
      Logger.error?.('PathManagerV2.pathSplit.snapshotMissing', {
        splitIndex: numericSplitIndex,
        activePathId: delegate?._activePathId || null
      });
      return false;
    }
    const resolvedSourcePathId = sourcePathId || snapshot.activePathId || delegate?._activePathId || null;
    const sourceIndex = snapshot.sessionPaths.findIndex((entry) => entry?.id === resolvedSourcePathId);
    if (sourceIndex < 0) {
      Logger.error?.('PathManagerV2.pathSplit.pathMissing', {
        splitIndex: numericSplitIndex,
        activePathId: resolvedSourcePathId
      });
      return false;
    }
    const sourceEntry = snapshot.sessionPaths[sourceIndex];
    const sourcePoints = Array.isArray(sourceEntry?.controlPoints)
      ? sourceEntry.controlPoints.map(clonePathControlPoint)
      : [];
    if (sourceEntry?.closed || sourcePoints.length < PATH_MIN_SPLITTABLE_POINTS) {
      Logger.error?.('PathManagerV2.pathSplit.invalidSource', {
        splitIndex: numericSplitIndex,
        activePathId: resolvedSourcePathId,
        closed: !!sourceEntry?.closed,
        pointCount: sourcePoints.length
      });
      return false;
    }
    if (!Number.isInteger(numericSplitIndex) || numericSplitIndex <= 0 || numericSplitIndex >= (sourcePoints.length - 1)) {
      Logger.error?.('PathManagerV2.pathSplit.invalidIndex', {
        splitIndex: numericSplitIndex,
        activePathId: resolvedSourcePathId,
        pointCount: sourcePoints.length
      });
      return false;
    }

    const sourceShadowPoints = Array.isArray(sourceEntry?.shadowPoints)
      ? sourceEntry.shadowPoints.map(clonePathShadowPoint)
      : [];
    const hasManualShadowSplit = sourceShadowPoints.length === sourcePoints.length;
    let pathIdCounter = Number.isFinite(snapshot.pathIdCounter) ? snapshot.pathIdCounter : 0;
    const nextPathId = () => `path_${++pathIdCounter}`;
    const now = Date.now();
    const buildSplitEntry = (controlPoints, shadowPoints) => {
      const entry = typeof delegate?._cloneSessionPathEntry === 'function'
        ? delegate._cloneSessionPathEntry(sourceEntry)
        : { ...sourceEntry };
      entry.id = nextPathId();
      entry.controlPoints = controlPoints.map(clonePathControlPoint);
      entry.closed = false;
      entry.wallGroupId = null;
      entry.wallIds = [];
      entry.createdAt = now;
      if (hasManualShadowSplit) {
        entry.shadowPoints = shadowPoints.map(clonePathShadowPoint);
      } else {
        entry.shadowPoints = [];
        if (entry.shadow?.manual) {
          entry.shadow = {
            ...entry.shadow,
            manual: false,
            editMode: false
          };
        }
      }
      return entry;
    };

    const leadingEntry = buildSplitEntry(
      sourcePoints.slice(0, numericSplitIndex + 1),
      sourceShadowPoints.slice(0, numericSplitIndex + 1)
    );
    const trailingEntry = buildSplitEntry(
      sourcePoints.slice(numericSplitIndex),
      sourceShadowPoints.slice(numericSplitIndex)
    );

    snapshot.sessionPaths.splice(sourceIndex, 1, leadingEntry, trailingEntry);
    snapshot.activeSnapshot = null;
    snapshot.activePathId = trailingEntry.id;
    snapshot.lastPlacedPathId = trailingEntry.id;
    snapshot.pathIdCounter = pathIdCounter;

    const restored = delegate?._restoreHistorySnapshot?.(snapshot);
    if (!restored) {
      Logger.error?.('PathManagerV2.pathSplit.restoreFailed', {
        splitIndex: numericSplitIndex,
        sourcePathId: resolvedSourcePathId,
        leadingPathId: leadingEntry.id,
        trailingPathId: trailingEntry.id
      });
      return false;
    }
    delegate?._recordHistorySnapshot?.();
    Logger.info?.('PathManagerV2.pathSplit.applied', {
      splitIndex: numericSplitIndex,
      sourcePathId: resolvedSourcePathId,
      leadingPathId: leadingEntry.id,
      trailingPathId: trailingEntry.id,
      sourcePointCount: sourcePoints.length
    });
    return true;
  }

  _buildToolOptionsDescriptor() {
    const { state: legacyState, handlers } = this._buildToolOptionsState();
    const activeSubtool = this._extractActiveSubtoolId(legacyState) || null;
    const { controls, sections } = this._buildDeclarativeToolOptionsConfig(legacyState);
    const shortcuts = mergeShortcutLists(
      createStandardEditorShortcuts({ includePolarity: false }),
      [
        createShortcut('insert-point', {
          binding: 'Shift+LMB',
          label: 'Insert Point',
          description: 'Insert a point along the current path.'
        }),
        createShortcut('delete-point', {
          binding: 'Alt+LMB',
          label: 'Delete Point',
          description: 'Delete the closest point.'
        }),
        createShortcut('split-path', {
          binding: 'X',
          label: 'Split Path',
          description: 'In Edit Shapes, split the hovered open path at the hovered non-endpoint.'
        }),
        createShortcut('finish-path', {
          binding: 'Double-Click',
          label: 'Finish Path',
          description: 'Finish the current path.'
        }),
        createShortcut('scale-texture', {
          binding: 'Ctrl/Cmd+Wheel',
          label: 'Scale',
          description: 'Adjust the repeating texture scale.'
        }),
        createShortcut('adjust-elevation-wheel', {
          binding: 'Alt+Wheel',
          label: 'Elevation Wheel',
          description: 'Adjust tile elevation by 0.01; add Shift for 0.1 or Ctrl/Cmd for 0.001.'
        }),
        createShortcut('adjust-elevation-keys', {
          binding: 'Alt+[ / ] or Alt+Up / Down',
          label: 'Elevation Keys',
          description: 'Nudge tile elevation with the same step modifiers as Alt+Wheel.'
        })
      ]
    );
    return createNormalizedToolOptionsDescriptor({
      rendererMode: TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE,
      descriptor: {
        toolId: 'path.edit.v2',
        toolLabel: 'Path Editor v2',
        activeMode: activeSubtool,
        activeSubtool,
        dirty: this.hasSessionChanges(),
        selectionSummary: this._delegate?._activePathId
          ? `Editing path ${this._delegate._activePathId}`
          : (activeSubtool || null),
        helpTopicId: 'path-editor-v2'
      },
      legacyState,
      controls,
      sections,
      handlers,
      shortcuts,
      sessionState: {
        editingTileId: this._editingTileId || null,
        activeSubtool,
        dirty: this.hasSessionChanges()
      },
      renderState: {
        previewElevation: Number.isFinite(this._delegate?._previewElevation) ? Number(this._delegate._previewElevation) : 0,
        editShapesMode: !!this._delegate?._editShapesMode,
        activePathId: this._delegate?._activePathId || null
      },
      persistedState: {
        documentFlags: ['flags.fa-nexus.pathV2', 'flags.fa-nexus.pathsV2', 'flags.fa-nexus.hsbc'],
        toolDefaultsSetting: PATH_SUBTOOL_SETTING_KEY
      }
    });
  }

  _syncToolOptionsState({
    suppressRender = false,
    suppressSubtoolPersistence = false,
    suppressToolDefaultsPersistence = false
  } = {}) {
    try {
      const descriptor = this._buildToolOptionsDescriptor();
      toolOptionsController.setToolOptions('path.edit.v2', {
        ...descriptor,
        suppressRender
      });
      this._persistSubtoolFromState(descriptor.legacyState, { suppress: suppressSubtoolPersistence });
      if (!suppressToolDefaultsPersistence) this._scheduleToolDefaultsPersist();
    } catch (_) {}
  }

  requestToolOptionsUpdate(options = {}) {
    this._syncToolOptionsState(options);
  }

  _persistDelegateToolDefaults() {
    const delegate = this._delegate;
    if (!delegate) return;
    if (typeof delegate._persistToolDefaults !== 'function') return;
    try { delegate._persistToolDefaults(); } catch (_) {}
  }

  _refreshDelegateToolDefaults() {
    const delegate = this._delegate;
    if (!delegate) return;
    try {
      if (typeof delegate._readToolDefaults === 'function') {
        const defaults = delegate._readToolDefaults();
        delegate._toolDefaults = defaults && typeof defaults === 'object' ? defaults : null;
      } else if ('_toolDefaults' in delegate) {
        delegate._toolDefaults = null;
      }
    } catch (_) {}
  }

  _scheduleToolDefaultsPersist() {
    if (!this._delegate?.isActive) return;
    if (this._toolDefaultsPersistTimer) return;
    this._toolDefaultsPersistTimer = setTimeout(() => {
      this._toolDefaultsPersistTimer = null;
      if (!this._delegate?.isActive) return;
      this._persistDelegateToolDefaults();
    }, 200);
  }

  _readSubtoolPreference() {
    try {
      const value = game?.settings?.get?.(MODULE_ID, PATH_SUBTOOL_SETTING_KEY);
      const normalized = typeof value === 'string' ? value : '';
      return PATH_PERSISTED_SUBTOOL_IDS.has(normalized) ? normalized : null;
    } catch (_) {
      return null;
    }
  }

  _persistSubtoolPreference(value) {
    if (!value || !PATH_PERSISTED_SUBTOOL_IDS.has(value)) return;
    if (this._lastPersistedSubtool === value) return;
    this._lastPersistedSubtool = value;
    try { game?.settings?.set?.(MODULE_ID, PATH_SUBTOOL_SETTING_KEY, value); } catch (_) {}
  }

  _extractActiveSubtoolId(state) {
    const toggles = Array.isArray(state?.subtoolToggles) ? state.subtoolToggles : [];
    for (const toggle of toggles) {
      if (!toggle || typeof toggle !== 'object') continue;
      if (!toggle.enabled) continue;
      const id = String(toggle.id || '');
      if (PATH_ACTIVE_SUBTOOL_IDS.has(id)) return id;
    }
    return null;
  }

  _buildDeclarativeToolOptionsConfig(legacyState = {}) {
    const controls = {};
    const sections = [];
    const addHintControl = ({ id, text } = {}) => {
      if (!id || typeof text !== 'string' || !text.trim().length) return null;
      controls[id] = {
        id,
        type: 'hint',
        text: text.trim()
      };
      return id;
    };
    const addRangeControl = ({
      id,
      label,
      state,
      handlerId,
      handlerArg,
      headerToggle = null,
      compact = false,
      ariaLabel = ''
    } = {}) => {
      if (!id || !state || typeof state !== 'object') return null;
      controls[id] = {
        id,
        type: 'range',
        label,
        compact,
        ariaLabel,
        handlerId,
        handlerArg,
        headerToggle: headerToggle && typeof headerToggle === 'object' ? { ...headerToggle } : null,
        min: state.min,
        max: state.max,
        step: state.step,
        value: state.value,
        display: state.display,
        defaultValue: state.defaultValue,
        disabled: !!state.disabled,
        hint: typeof state.hint === 'string' ? state.hint : '',
        tooltip: typeof state.tooltip === 'string' ? state.tooltip : '',
        inputOnly: !!state.inputOnly
      };
      return id;
    };
    const addRangePairControl = ({
      id,
      label,
      state,
      handlerId,
      ariaLabelX = '',
      ariaLabelY = ''
    } = {}) => {
      if (!id || !state || typeof state !== 'object') return null;
      controls[id] = {
        id,
        type: 'range-pair',
        label,
        handlerId,
        hint: typeof state.hint === 'string' ? state.hint : '',
        items: [
          {
            id: 'x',
            label: 'X',
            ariaLabel: ariaLabelX,
            handlerArg: 'x',
            ...(state.x && typeof state.x === 'object' ? state.x : {})
          },
          {
            id: 'y',
            label: 'Y',
            ariaLabel: ariaLabelY,
            handlerArg: 'y',
            ...(state.y && typeof state.y === 'object' ? state.y : {})
          }
        ]
      };
      return id;
    };
    const addToggleControl = ({
      id,
      label,
      value = false,
      disabled = false,
      tooltip = '',
      hint = '',
      handlerId = '',
      handlerArg
    } = {}) => {
      if (!id) return null;
      controls[id] = {
        id,
        type: 'toggle',
        label,
        value: !!value,
        disabled: !!disabled,
        tooltip,
        hint,
        handlerId,
        handlerArg
      };
      return id;
    };
    const addAxisTogglePairControl = ({
      id,
      label,
      state,
      horizontalHandlerId,
      verticalHandlerId,
      horizontalRandomHandlerId = '',
      verticalRandomHandlerId = ''
    } = {}) => {
      if (!id || !state || typeof state !== 'object') return null;
      controls[id] = {
        id,
        type: 'axis-toggle-pair',
        label,
        state,
        horizontalHandlerId,
        verticalHandlerId,
        horizontalRandomHandlerId,
        verticalRandomHandlerId
      };
      return id;
    };

    const modeSectionControlIds = [];
    const modeOptions = Array.isArray(legacyState?.subtoolToggles)
      ? legacyState.subtoolToggles.filter((toggle) => toggle && typeof toggle === 'object')
      : [];
    if (modeOptions.length) {
      controls['tool-mode'] = {
        id: 'tool-mode',
        type: 'segmented',
        options: modeOptions
      };
      modeSectionControlIds.push('tool-mode');
    }

    const customToggleList = Array.isArray(legacyState?.customToggles)
      ? legacyState.customToggles.filter((toggle) => toggle && typeof toggle === 'object')
      : [];
    const subtoolOptions = customToggleList.filter((toggle) => String(toggle?.group || '') === 'subtool-option');
    if (subtoolOptions.length) {
      controls['path-mode-options'] = {
        id: 'path-mode-options',
        type: 'toggle-list',
        items: subtoolOptions
      };
      modeSectionControlIds.push('path-mode-options');
    }

    if (modeSectionControlIds.length) {
      sections.push({
        id: 'mode',
        label: 'Mode',
        region: 'header',
        collapsible: false,
        controls: modeSectionControlIds
      });
    }

    if (legacyState?.pathAppearance?.freehandSimplify?.available) {
      sections.push({
        id: 'brush-geometry',
        label: 'Brush / Geometry',
        controls: [
          addRangeControl({
            id: 'path-simplify',
            label: 'Draw Simplification',
            state: legacyState.pathAppearance.freehandSimplify,
            handlerId: 'setFreehandSimplify',
            ariaLabel: 'Draw simplification'
          })
        ].filter(Boolean)
      });
    }

    const pathControlIds = [];
    if (legacyState?.pathAppearance?.available) {
      const pathAppearance = legacyState.pathAppearance;
      const nextPathStackingToggle = customToggleList.find((toggle) => String(toggle?.id || '') === 'next-poly-under');
      if (nextPathStackingToggle) {
        pathControlIds.push(addToggleControl({
          id: 'path-next-stack-mode',
          label: nextPathStackingToggle.enabled ? 'Next Path Stacking: Under' : 'Next Path Stacking: Over',
          value: !!nextPathStackingToggle.enabled,
          disabled: !!nextPathStackingToggle.disabled,
          tooltip: nextPathStackingToggle.tooltip || '',
          handlerId: 'setNextPathStackMode'
        }));
      }
      pathControlIds.push(addHintControl({
        id: 'path-appearance-hint',
        text: pathAppearance.hint
      }));
      pathControlIds.push(addRangeControl({
        id: 'path-elevation',
        label: 'Elevation',
        state: pathAppearance.elevation,
        handlerId: 'setElevation',
        ariaLabel: 'Path elevation'
      }));
      pathControlIds.push(addRangeControl({
        id: 'path-layer-opacity',
        label: 'Opacity',
        state: pathAppearance.layerOpacity,
        handlerId: 'setLayerOpacity',
        ariaLabel: 'Path opacity'
      }));
      pathControlIds.push(addRangeControl({
        id: 'path-scale',
        label: 'Scale',
        state: pathAppearance.scale,
        handlerId: 'setPathScale',
        ariaLabel: 'Path scale'
      }));
      pathControlIds.push(addRangePairControl({
        id: 'path-texture-offset',
        label: 'Texture Offset',
        state: pathAppearance.textureOffset,
        handlerId: 'setTextureOffset',
        ariaLabelX: 'Path texture offset X',
        ariaLabelY: 'Path texture offset Y'
      }));
      pathControlIds.push(addRangeControl({
        id: 'path-tension',
        label: 'Tension',
        state: pathAppearance.tension,
        handlerId: 'setPathTension',
        ariaLabel: 'Path tension'
      }));
      pathControlIds.push(addToggleControl({
        id: 'path-show-width-tangents',
        label: pathAppearance.showWidthTangents?.label || 'Show Width Tangents',
        value: pathAppearance.showWidthTangents?.enabled,
        disabled: pathAppearance.showWidthTangents?.disabled,
        tooltip: pathAppearance.showWidthTangents?.tooltip || '',
        handlerId: 'setShowWidthTangents'
      }));
    }
    if (legacyState?.flip?.available) {
      pathControlIds.push(addAxisTogglePairControl({
        id: 'path-flip',
        label: 'Flip / Mirror',
        state: legacyState.flip,
        horizontalHandlerId: 'toggleFlipHorizontal',
        verticalHandlerId: 'toggleFlipVertical',
        horizontalRandomHandlerId: 'toggleFlipHorizontalRandom',
        verticalRandomHandlerId: 'toggleFlipVerticalRandom'
      }));
    }
    const placementControlIds = [];
    if (legacyState?.shapeStacking?.available) {
      controls['path-stack-order'] = {
        id: 'path-stack-order',
        type: 'stack-order',
        label: 'Selected Path',
        state: legacyState.shapeStacking,
        pushTopHandlerId: 'pushSelectedWallToTop',
        pushBottomHandlerId: 'pushSelectedWallToBottom'
      };
      placementControlIds.push('path-stack-order');
    }
    if (placementControlIds.length) {
      sections.push({
        id: 'placement',
        label: 'Placement',
        controls: placementControlIds
      });
    }

    if (pathControlIds.length) {
      sections.push({
        id: 'transform',
        label: 'Transform',
        controls: pathControlIds.filter(Boolean)
      });
    }
    buildHsbcToolOptionsControls({
      state: legacyState?.pathAppearance?.hsbc,
      addRangeControl,
      addHintControl,
      sections,
      sectionId: 'color',
      sectionLabel: 'Color',
      idPrefix: 'path-color',
      handlerIds: {
        hue: 'setPathHsbcHue',
        saturation: 'setPathHsbcSaturation',
        brightness: 'setPathHsbcBrightness',
        contrast: 'setPathHsbcContrast'
      },
      compact: true,
      ariaPrefix: 'Path color'
    });

    const featheringControlIds = [];
    if (legacyState?.pathFeather?.available) {
      const pathFeather = legacyState.pathFeather;
      const unitLabel = typeof pathFeather.unitLabel === 'string' ? pathFeather.unitLabel.trim() : '';
      featheringControlIds.push(addRangeControl({
        id: 'path-feather-start-length',
        label: unitLabel ? `Start Length (${unitLabel})` : 'Start Length',
        state: pathFeather.start?.length,
        handlerId: 'setFeatherLength',
        handlerArg: 'start',
        headerToggle: {
          label: 'Shrink Start',
          value: !!pathFeather.start?.enabled,
          tooltip: 'Toggle shrink at the start of the path.',
          handlerId: 'setFeatherShrinkEnabled',
          handlerArg: 'start'
        },
        ariaLabel: 'Path feather start length'
      }));
      featheringControlIds.push(addRangeControl({
        id: 'path-feather-end-length',
        label: unitLabel ? `End Length (${unitLabel})` : 'End Length',
        state: pathFeather.end?.length,
        handlerId: 'setFeatherLength',
        handlerArg: 'end',
        headerToggle: {
          label: 'Shrink End',
          value: !!pathFeather.end?.enabled,
          tooltip: 'Toggle shrink at the end of the path.',
          handlerId: 'setFeatherShrinkEnabled',
          handlerArg: 'end'
        },
        ariaLabel: 'Path feather end length'
      }));
      featheringControlIds.push(addHintControl({
        id: 'path-feather-hint',
        text: pathFeather.hint
      }));
    }
    if (legacyState?.opacityFeather?.available) {
      const opacityFeather = legacyState.opacityFeather;
      const unitLabel = typeof opacityFeather.unitLabel === 'string' ? opacityFeather.unitLabel.trim() : '';
      featheringControlIds.push(addRangeControl({
        id: 'opacity-feather-start-length',
        label: unitLabel ? `Start Length (${unitLabel})` : 'Start Length',
        state: opacityFeather.start?.length,
        handlerId: 'setOpacityFeatherLength',
        handlerArg: 'start',
        headerToggle: {
          label: 'Fade In',
          value: !!opacityFeather.start?.enabled,
          tooltip: 'Toggle fade at the start of the path.',
          handlerId: 'setOpacityFeatherEnabled',
          handlerArg: 'start'
        },
        ariaLabel: 'Opacity feather fade in length'
      }));
      featheringControlIds.push(addRangeControl({
        id: 'opacity-feather-end-length',
        label: unitLabel ? `End Length (${unitLabel})` : 'End Length',
        state: opacityFeather.end?.length,
        handlerId: 'setOpacityFeatherLength',
        handlerArg: 'end',
        headerToggle: {
          label: 'Fade Out',
          value: !!opacityFeather.end?.enabled,
          tooltip: 'Toggle fade at the end of the path.',
          handlerId: 'setOpacityFeatherEnabled',
          handlerArg: 'end'
        },
        ariaLabel: 'Opacity feather fade out length'
      }));
      featheringControlIds.push(addHintControl({
        id: 'opacity-feather-hint',
        text: opacityFeather.hint
      }));
    }
    if (featheringControlIds.length) {
      sections.push({
        id: 'feathering',
        label: 'Starting/Ending',
        controls: featheringControlIds
      });
    }

    if (legacyState?.pathShadow?.available) {
      controls['path-drop-shadow'] = {
        id: 'path-drop-shadow',
        type: 'drop-shadow',
        variant: 'path',
        state: legacyState.pathShadow,
        toggleLabel: 'Path Shadow'
      };
      sections.push({
        id: 'drop-shadow',
        label: 'Drop Shadow',
        controls: ['path-drop-shadow']
      });
    }

    const editorActions = Array.isArray(legacyState?.editorActions)
      ? legacyState.editorActions.filter((action) => action && typeof action === 'object')
      : [];
    if (editorActions.length) {
      controls['path-session-actions'] = {
        id: 'path-session-actions',
        type: 'action-row',
        actions: editorActions
      };
      sections.push({
        id: 'session',
        label: 'Session',
        region: 'footer',
        collapsible: false,
        controls: ['path-session-actions']
      });
    }

    return { controls, sections };
  }

  _persistSubtoolFromState(state, { suppress = false } = {}) {
    if (suppress) return;
    const active = this._extractActiveSubtoolId(state);
    if (!active) return;
    this._persistSubtoolPreference(active);
  }

  _restoreSubtoolPreference() {
    const preferred = this._readSubtoolPreference();
    if (!preferred) return;
    this._lastPersistedSubtool = preferred;
    const apply = () => {
      try {
        const result = toolOptionsController?.requestCustomToggle?.(preferred, true);
        if (result === false) {
          setTimeout(() => {
            try { toolOptionsController?.requestCustomToggle?.(preferred, true); } catch (_) {}
          }, 50);
        }
      } catch (_) {}
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(apply);
    else setTimeout(apply, 0);
  }
}

export default PathManagerV2;
