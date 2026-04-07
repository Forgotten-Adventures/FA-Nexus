import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { premiumEntitlementsService } from '../premium/premium-entitlements-service.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import { toolOptionsController } from '../core/tool-options-controller.js';
import { applyBuildingTile, applyDoorFrameTile } from './building-tiles.js';
import { TOOL_OPTIONS_RENDERER_MODE, createNormalizedToolOptionsDescriptor } from '../core/tool-options-descriptor.js';
import {
  createShortcut,
  createStandardEditorShortcuts,
  mergeShortcutLists,
  resolveEffectivePolarity
} from '../core/editor-shortcuts.js';
import { buildHsbcToolOptionsControls } from '../core/hsbc.js';
import { requestSelectionFilterRefresh } from '../canvas/selection-filter-refresh.js';

const MODULE_ID = 'fa-nexus';
const BUILDING_SUBTOOL_SETTING_KEY = 'buildingToolActiveSubtool';
const BUILDING_PERSISTED_SUBTOOL_IDS = new Set(['rectangle', 'ellipse', 'polygon', 'inner-wall']);
const BUILDING_ACTIVE_SUBTOOL_IDS = new Set([
  ...BUILDING_PERSISTED_SUBTOOL_IDS,
  'edit-points',
  'edit-shapes'
]);
const EDITING_TILE_SET_KEY = '__faNexusBuildingEditingTileIds';

const FEATURE_ID = 'building.edit';
const TOOL_LABEL = 'Building Editor';

function getEditingTileSet() {
  try {
    const root = globalThis;
    if (!root) return null;
    let set = root[EDITING_TILE_SET_KEY];
    if (!(set instanceof Set)) {
      set = new Set();
      root[EDITING_TILE_SET_KEY] = set;
    }
    return set;
  } catch (_) {
    return null;
  }
}

function resolveTileId(targetTile) {
  try {
    return targetTile?.document?.id || targetTile?.id || targetTile?.document?._id || null;
  } catch (_) {
    return null;
  }
}

function resolvePlaceableTile(targetTile, tileId) {
  try {
    if (targetTile?.document && targetTile?.mesh) return targetTile;
    const doc = targetTile?.document || targetTile;
    if (doc?.object) return doc.object;
    const id = tileId || doc?.id || doc?._id;
    if (!id) return null;
    return canvas?.tiles?.placeables?.find((tile) => tile?.document?.id === id) || null;
  } catch (_) {
    return null;
  }
}

export class BuildingManager {
  constructor(app) {
    this._app = app;
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._portalMode = false;
    this._onToolOptionsChange = null;
    this._lastPersistedSubtool = null;
    this._toolDefaultsPersistTimer = null;
    this._editingTileId = null;
    this._forcingMeasurementsEnabled = false;
    this._hsbcTarget = 'wall';
  }

  /**
   * Register a callback to be notified when tool options state changes.
   * Useful for updating UI elements like portal texture thumbnails.
   * @param {Function|null} callback - Callback function receiving (state, handlers)
   */
  setToolOptionsChangeCallback(callback) {
    this._onToolOptionsChange = typeof callback === 'function' ? callback : null;
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  hasSessionChanges() {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    try {
      if (typeof delegate?.hasSessionChanges === 'function') {
        return !!delegate.hasSessionChanges();
      }
    } catch (_) {}
    return true;
  }

  canCommitSession() {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    try {
      if (typeof delegate?.canCommitSession === 'function') {
        return !!delegate.canCommitSession();
      }
      if (typeof delegate?._canCommitSession === 'function') {
        return !!delegate._canCommitSession();
      }
    } catch (_) {}
    return this.hasSessionChanges();
  }

  get version() {
    return this._delegate?.version || '0.0.14';
  }

  async start(session = {}) {
    if (Object.prototype.hasOwnProperty.call(session || {}, 'portalMode')) {
      this._portalMode = !!session.portalMode;
    }
    const delegate = await this._ensureDelegate();
    let result;
    try {
      this._clearEditingTile();
      if (typeof delegate?.setPortalMode === 'function') {
        delegate.setPortalMode(this._portalMode);
      }
      result = delegate.start?.(session);
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      // Sync tool options state BEFORE activating the tool to ensure the cached
      // state reflects the new session mode (e.g., 'inner' vs 'outer'). Otherwise,
      // activateTool would use stale cached state from the previous session.
      this._syncToolOptionsState({
        suppressRender: true,
        suppressSubtoolPersistence: true,
        suppressToolDefaultsPersistence: true
      });
      toolOptionsController.activateTool(FEATURE_ID, { label: TOOL_LABEL });
      this._beginToolWindowMonitor(delegate);
      this._restoreSubtoolPreference();
      result = this._wrapSessionLaunchPromise(result, { phase: 'start' });
    } catch (error) {
      await this._handleSessionLaunchFailure(error, { phase: 'start' });
      throw error;
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  async editTile(tileDocument, options = {}) {
    if (Object.prototype.hasOwnProperty.call(options || {}, 'portalMode')) {
      this._portalMode = !!options.portalMode;
    }
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed building editor bundle does not support editing existing tiles.');
    }
    let result;
    try {
      this._markEditingTile(tileDocument);
      if (typeof delegate?.setPortalMode === 'function') {
        delegate.setPortalMode(this._portalMode);
      }
      result = delegate.editTile(tileDocument, options);
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      // Sync tool options state BEFORE activating the tool to ensure the cached
      // state reflects the new session mode. Otherwise, activateTool would use
      // stale cached state from the previous session.
      this._syncToolOptionsState({
        suppressRender: true,
        suppressSubtoolPersistence: true,
        suppressToolDefaultsPersistence: true
      });
      toolOptionsController.activateTool(FEATURE_ID, { label: TOOL_LABEL });
      this._beginToolWindowMonitor(delegate);
      result = this._wrapSessionLaunchPromise(result, {
        phase: 'edit',
        tileId: resolveTileId(tileDocument)
      });
    } catch (error) {
      await this._handleSessionLaunchFailure(error, {
        phase: 'edit',
        tileId: resolveTileId(tileDocument)
      });
      throw error;
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  _wrapSessionLaunchPromise(result, { phase = 'start', tileId = null } = {}) {
    if (!result || typeof result.then !== 'function') return result;
    return Promise.resolve(result).catch(async (error) => {
      await this._handleSessionLaunchFailure(error, { phase, tileId });
      throw error;
    });
  }

  async _handleSessionLaunchFailure(error, { phase = 'start', tileId = null } = {}) {
    Logger.error?.('BuildingManager.session.launchFailed', {
      phase,
      error: String(error?.message || error),
      tileId: tileId || this._editingTileId || null,
      delegateActive: !!this._delegate?.isActive,
      canvasReady: !!canvas?.ready,
      hasCanvasStage: !!canvas?.stage
    });
    this._cancelToolWindowMonitor();
    try {
      await Promise.resolve(this.stop({ reason: `${phase}-failed` }));
    } catch (stopError) {
      Logger.error?.('BuildingManager.session.launchFailed.stopFailed', {
        phase,
        error: String(stopError?.message || stopError)
      });
      this._clearEditingTile();
      try { toolOptionsController.deactivateTool(FEATURE_ID); } catch (_) {}
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
    Logger.error?.('BuildingManager.session.orphaned', {
      reason,
      tileId: this._editingTileId || null,
      delegateActive: !!this._delegate?.isActive,
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
          Logger.error?.('BuildingManager.session.orphaned.stopFailed', {
            reason,
            error: String(stopError?.message || stopError)
          });
        });
      }
    } catch (stopError) {
      Logger.error?.('BuildingManager.session.orphaned.stopFailed', {
        reason,
        error: String(stopError?.message || stopError)
      });
      this._clearEditingTile();
      try { toolOptionsController.deactivateTool(FEATURE_ID); } catch (_) {}
    }
  }

  async updateWallPath(options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate) {
      Logger.warn?.('BuildingManager.updateWallPath.delegateMissing', { options });
      return null;
    }
    if (typeof delegate.updateWallPath !== 'function') {
      Logger.warn?.('BuildingManager.updateWallPath.methodMissing', { options });
      return null;
    }
    try {
      return await delegate.updateWallPath(options);
    } catch (error) {
      Logger.warn?.('BuildingManager.updateWallPath.failed', { error: String(error?.message || error), options });
      throw error;
    }
  }

  async updateFillTexture(options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate) {
      Logger.warn?.('BuildingManager.updateFillTexture.delegateMissing', { options });
      return null;
    }
    if (typeof delegate.updateFillTexture !== 'function') {
      Logger.warn?.('BuildingManager.updateFillTexture.methodMissing', { options });
      return null;
    }
    try {
      return await delegate.updateFillTexture(options);
    } catch (error) {
      Logger.warn?.('BuildingManager.updateFillTexture.failed', { error: String(error?.message || error), options });
      throw error;
    }
  }

  switchActiveMode(mode) {
    if (!this._delegate?.isActive) return;
    try {
      const result = this._delegate.switchActiveMode?.(mode);
      // If the delegate returns a promise (async switch), wait before refreshing UI.
      Promise.resolve(result).finally(() => {
        this._syncToolOptionsState({ suppressRender: false });
      });
      return result;
    } catch (error) {
      Logger.warn?.('BuildingManager.switchActiveMode.failed', { mode, error: String(error?.message || error) });
      return null;
    }
  }

  setActiveTool(toolId) {
    if (!this._delegate?.isActive) return;
    try {
      this._delegate.setActiveTool?.(toolId);
      this._syncToolOptionsState({ suppressRender: false });
    } catch (error) {
      Logger.warn?.('BuildingManager.setActiveTool.failed', { toolId, error: String(error?.message || error) });
    }
  }

  setPortalMode(enabled = false) {
    this._portalMode = !!enabled;
    if (typeof this._delegate?.setPortalMode === 'function') {
      try {
        this._delegate.setPortalMode(this._portalMode);
      } catch (error) {
        Logger.warn?.('BuildingManager.setPortalMode.failed', { enabled, error: String(error?.message || error) });
      }
    }
    this._syncToolOptionsState({ suppressRender: false });
    return this._portalMode;
  }

  forceExitPortalEditing() {
    try { this._delegate?.exitPortalEditingAllSessions?.(); }
    catch (error) { Logger.warn?.('BuildingManager.forceExitPortalEditing.failed', { error: String(error?.message || error) }); }
    this._portalMode = false;
    this._syncToolOptionsState({ suppressRender: false });
  }

  stop(...args) {
    this._cancelToolWindowMonitor();
    toolOptionsController.deactivateTool(FEATURE_ID);
    const finalizeEditingTile = () => {
      try { this._clearEditingTile(); } catch (_) {}
    };
    if (!this._delegate) {
      finalizeEditingTile();
      return;
    }
    try {
      if (this._delegate?.isActive) this._persistDelegateToolDefaults();
      const result = this._delegate.stop?.(...args);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(() => {
          finalizeEditingTile();
        });
      }
      finalizeEditingTile();
      return result;
    } catch (error) {
      finalizeEditingTile();
      Logger.warn?.('BuildingManager.stop.failed', { error: String(error?.message || error) });
      throw error;
    }
  }

  async commitBuilding(options = {}) {
    const delegate = this._delegate;
    if (!delegate?.isActive) return null;
    if (typeof delegate.commitBuilding !== 'function') {
      Logger.warn?.('BuildingManager.commitBuilding.methodMissing', { options });
      return null;
    }
    try {
      const result = await delegate.commitBuilding(options);
      if (!delegate?.isActive) {
        this._cancelToolWindowMonitor();
        toolOptionsController.deactivateTool(FEATURE_ID);
        this._clearEditingTile();
      }
      return result;
    } catch (error) {
      Logger.warn?.('BuildingManager.commitBuilding.failed', { error: String(error?.message || error), options });
      throw error;
    }
  }

  async requestCancelSession(options = {}) {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    if (typeof delegate.requestCancelSession === 'function') {
      try {
        const cancelled = await delegate.requestCancelSession(options);
        if (cancelled && !delegate?.isActive) {
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool(FEATURE_ID);
          this._clearEditingTile();
        }
        return cancelled;
      } catch (error) {
        Logger.warn?.('BuildingManager.cancel.failed', { error: String(error?.message || error), options });
        return false;
      }
    }
    try {
      this.stop?.(options);
      return true;
    } catch (error) {
      Logger.warn?.('BuildingManager.cancel.failed', { error: String(error?.message || error), options });
      return false;
    }
  }

  async _ensureDelegate() {
    if (this._delegate) return this._delegate;
    ensurePremiumFeaturesRegistered();
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const helper = await premiumFeatureBroker.resolve(FEATURE_ID);
      let instance = null;
      if (helper?.create) instance = helper.create(this._app);
      else if (typeof helper === 'function') instance = new helper(this._app);
      if (!instance) throw new Error('Premium building editor bundle missing BuildingManager implementation');
      this._delegate = instance;
      try { instance.attachHost?.(this); }
      catch (_) {}
      try {
        if (typeof instance.setPortalMode === 'function') {
          instance.setPortalMode(this._portalMode);
        }
      } catch (_) {}
      try {
        Logger.info?.('BuildingEditor.bundle.loaded', { version: instance?.version || '0.0.14' });
        Hooks?.callAll?.('fa-nexus-building-editor-loaded', { version: instance?.version || '0.0.14' });
      } catch (logError) {
        Logger.warn?.('BuildingEditor.bundle.loaded.logFailed', String(logError?.message || logError));
      }
      return instance;
    })();
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  }

  _scheduleEntitlementProbe() {
    ensurePremiumFeaturesRegistered();
    if (this._entitlementProbe) return this._entitlementProbe;
    const probe = (async () => {
      try {
        await premiumFeatureBroker.require(FEATURE_ID, { revalidate: true, reason: 'building-edit:revalidate' });
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
    if (!this._hasPremiumAuth()) {
      Logger.info?.('BuildingManager.entitlement.skipDisconnect', {
        code: error?.code || error?.name,
        message: String(error?.message || error)
      });
      return;
    }
    const message = '🔐 Authentication expired - premium building editing has been disabled. Please reconnect Patreon.';
    if (this._isAuthFailure(error)) {
      try { premiumEntitlementsService?.clear?.({ reason: 'building-revalidate-failed' }); }
      catch (_) {}
      try { game?.settings?.set?.('fa-nexus', 'patreon_auth_data', null); }
      catch (_) {}
      ui?.notifications?.warn?.(message);
    } else {
      ui?.notifications?.error?.(`Unable to confirm premium access: ${error?.message || error}`);
    }
    try { Hooks?.callAll?.('fa-nexus-premium-auth-lost', { featureId: FEATURE_ID, error }); }
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
      const auth = game?.settings?.get?.('fa-nexus', 'patreon_auth_data');
      return !!(auth && auth.authenticated && auth.state);
    } catch (_) {
      return false;
    }
  }

  _beginToolWindowMonitor(delegate) {
    this._cancelToolWindowMonitor();
    if (!delegate) return;
    const token = { cancelled: false, handle: null, usingTimeout: false, lastOptionsSync: 0 };
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
    const loop = () => {
      if (token.cancelled) return;
      if (!delegate?.isActive) {
        this._clearEditingTile();
        this._cancelToolWindowMonitor();
        toolOptionsController.deactivateTool(FEATURE_ID);
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
      schedule(loop);
    };
    schedule(loop);
    this._toolMonitor = token;
  }

  _cancelToolWindowMonitor() {
    const token = this._toolMonitor;
    this._toolMonitor = null;
    if (!token) return;
    token.cancelled = true;
    if (token.handle != null) {
      if (token.usingTimeout) clearTimeout(token.handle);
      else cancelAnimationFrame(token.handle);
    }
  }

  _markEditingTile(targetTile) {
    try {
      const tileId = resolveTileId(targetTile);
      if (!tileId) return;
      if (this._editingTileId && this._editingTileId !== tileId) {
        this._clearEditingTile();
      }
      this._editingTileId = tileId;
      const set = getEditingTileSet();
      if (set) set.add(tileId);
      const tile = resolvePlaceableTile(targetTile, tileId);
      if (tile) {
        applyBuildingTile(tile);
        applyDoorFrameTile(tile);
      }
    } catch (_) {}
  }

  _clearEditingTile() {
    let clearedTileId = null;
    const refreshJobs = [];
    try {
      const tileId = this._editingTileId;
      if (!tileId) return null;
      clearedTileId = tileId;
      this._editingTileId = null;
      const set = getEditingTileSet();
      if (set) set.delete(tileId);
      const tile = resolvePlaceableTile(null, tileId);
      if (tile) {
        refreshJobs.push(Promise.resolve(applyBuildingTile(tile)));
        refreshJobs.push(Promise.resolve(applyDoorFrameTile(tile)));
      }
    } catch (_) {}
    this._refreshExitedEditTile(clearedTileId, refreshJobs.length ? Promise.allSettled(refreshJobs) : null);
    return clearedTileId;
  }

  _refreshExitedEditTile(tileId = null, waitFor = null) {
    if (!tileId) return;
    const refresh = () => {
      try {
        const tile = resolvePlaceableTile(null, tileId);
        if (!tile || tile.destroyed) return;
        try {
          if (tile.frame) {
            tile.frame.visible = true;
            if (tile.controlled && tile.frame.border) tile.frame.border.visible = true;
          }
        } catch (_) {}
        try { tile.renderFlags?.set?.({ refreshState: true }); } catch (_) {}
        requestSelectionFilterRefresh({
          reason: 'building-editor-edit-exit',
          source: 'building-manager',
          tileIds: [tileId]
        });
        const mouseManager = globalThis?.foundry?.canvas?.interaction?.MouseInteractionManager || globalThis?.MouseInteractionManager;
        try { mouseManager?.emulateMoveEvent?.(); } catch (_) {}
      } catch (_) {}
    };
    const scheduleRefresh = () => {
      try { queueMicrotask(refresh); } catch (_) { refresh(); }
      try {
        const root = globalThis?.window ?? globalThis;
        root?.requestAnimationFrame?.(() => refresh());
      } catch (_) {}
      try { setTimeout(() => refresh(), 80); } catch (_) {}
      try { setTimeout(() => refresh(), 180); } catch (_) {}
    };
    if (waitFor && typeof waitFor.then === 'function') {
      Promise.resolve(waitFor).finally(scheduleRefresh);
      return;
    }
    scheduleRefresh();
  }

  requestToolOptionsUpdate(options = {}) {
    this._syncToolOptionsState(options);
  }

  _buildToolOptionsState() {
    const baseHints = [];
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
    } else if (typeof delegateState?.hints === 'string' && delegateState.hints.trim()) {
      mergedHints.push(delegateState.hints.trim());
    }
    const state = { ...delegateState, hints: mergedHints };
    const wallHsbcAvailable = !!state?.pathAppearance?.hsbc?.available;
    const fillHsbcAvailable = !!state?.fillHsbc?.available;
    const activeHsbcTarget = fillHsbcAvailable && (!wallHsbcAvailable || this._hsbcTarget === 'fill') ? 'fill' : 'wall';
    this._hsbcTarget = activeHsbcTarget;
    state.colorTarget = {
      available: wallHsbcAvailable || fillHsbcAvailable,
      value: activeHsbcTarget,
      options: [
        {
          id: 'wall',
          label: 'Walls',
          enabled: activeHsbcTarget === 'wall',
          disabled: !wallHsbcAvailable,
          tooltip: 'Adjust wall HSBC settings.'
        },
        {
          id: 'fill',
          label: 'Fill',
          enabled: activeHsbcTarget === 'fill',
          disabled: !fillHsbcAvailable,
          tooltip: fillHsbcAvailable
            ? 'Adjust fill HSBC settings.'
            : 'Select a fill texture to enable fill color controls.'
        }
      ]
    };
    handlers = {
      ...handlers,
      setColorTarget: (target) => {
        this._hsbcTarget = target === 'fill' ? 'fill' : 'wall';
        this.requestToolOptionsUpdate({ suppressRender: true });
        return true;
      }
    };
    return { state, handlers };
  }

  _buildToolOptionsDescriptor() {
    const { state: legacyState, handlers } = this._buildToolOptionsState();
    const activeSubtool = this._extractActiveSubtoolId(legacyState) || null;
    const { controls, sections } = this._buildDeclarativeToolOptionsConfig(legacyState);
    const basePolarity = this._delegate?._baseOperationPolarity || 'add';
    const invertHeld = !!this._delegate?._polarityInvertHeld;
    const shortcuts = mergeShortcutLists(
      createStandardEditorShortcuts({ includePolarity: !this._portalMode }),
      this._portalMode
        ? [
            createShortcut('place-portal', {
              binding: 'Click',
              label: 'Place Portal',
              description: 'Place the configured door or window on the hovered wall.'
            })
          ]
        : [
            createShortcut('select-segment', {
              binding: 'Right-Click',
              label: 'Select Segment',
              description: 'In Edit Shapes, select a wall segment for per-segment wall overrides.'
            }),
            createShortcut('multi-select-segments', {
              binding: 'Ctrl/Cmd+Right-Click',
              label: 'Add Segment',
              description: 'In Edit Shapes, add or toggle a wall segment in the current segment selection.'
            }),
            createShortcut('arc-segment', {
              binding: 'Shift+Click',
              label: 'Arc Segment',
              description: 'Convert the latest or hovered segment into an arc.'
            }),
            createShortcut('finish-open-wall', {
              binding: 'Double-Click',
              label: 'Finish Open Wall',
              description: 'Finish an inner-wall polyline without closing it.'
            }),
            createShortcut('add-vertex', {
              binding: 'Ctrl+Click',
              label: 'Add Vertex',
              description: 'Add a vertex on a segment while editing shapes.'
            }),
            createShortcut('remove-vertex', {
              binding: 'Alt+Click',
              label: 'Remove Vertex',
              description: 'Remove a vertex while editing shapes.'
            }),
            createShortcut('adjust-elevation-wheel', {
              binding: 'Alt+Wheel',
              label: 'Elevation Wheel',
              description: 'Adjust wall elevation by 0.01; add Shift for 0.1 or Ctrl/Cmd for 0.001.'
            }),
            createShortcut('adjust-elevation-keys', {
              binding: 'Alt+[ / ] or Alt+Up / Down',
              label: 'Elevation Keys',
              description: 'Nudge wall elevation with the same step modifiers as Alt+Wheel.'
            })
          ]
    );
    return createNormalizedToolOptionsDescriptor({
      rendererMode: TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE,
      descriptor: {
        toolId: FEATURE_ID,
        toolLabel: TOOL_LABEL,
        activeMode: activeSubtool,
        activeSubtool,
        polarity: {
          supported: !this._portalMode,
          base: !this._portalMode ? basePolarity : null,
          effective: !this._portalMode ? resolveEffectivePolarity(basePolarity, invertHeld) : null,
          inverted: !this._portalMode && invertHeld
        },
        dirty: this.hasSessionChanges(),
        selectionSummary: legacyState?.shapeSelectionId || this._editingTileId || null,
        helpTopicId: 'building-editor'
      },
      legacyState,
      controls,
      sections,
      handlers,
      shortcuts,
      sessionState: {
        editingTileId: this._editingTileId || null,
        activeSubtool,
        portalMode: !!this._portalMode,
        dirty: this.hasSessionChanges()
      },
      renderState: {
        previewElevation: Number.isFinite(this._delegate?._previewElevation) ? Number(this._delegate._previewElevation) : 0,
        pointEditMode: !!this._delegate?._pointEditMode,
        shapeEditMode: !!this._delegate?._shapeEditMode,
        gapEditMode: !!this._delegate?._gapEditMode
      },
      persistedState: {
        documentFlags: ['flags.fa-nexus.building'],
        toolDefaultsSetting: BUILDING_SUBTOOL_SETTING_KEY
      }
    });
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
      headerToggle = null,
      compact = false,
      ariaLabel = '',
      inputOnly = false
    } = {}) => {
      if (!id || !state || typeof state !== 'object') return null;
      controls[id] = {
        id,
        type: 'range',
        label,
        headerToggle: headerToggle && typeof headerToggle === 'object' ? { ...headerToggle } : null,
        compact,
        ariaLabel,
        handlerId,
        min: state.min,
        max: state.max,
        step: state.step,
        value: state.value,
        display: state.display,
        defaultValue: state.defaultValue,
        disabled: !!state.disabled,
        hint: typeof state.hint === 'string' ? state.hint : '',
        tooltip: typeof state.tooltip === 'string' ? state.tooltip : '',
        inputOnly: !!inputOnly || !!state.inputOnly
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
      handlerId = ''
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
        handlerId
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
    const addActionRowControl = ({
      id,
      actions,
      handlerId = ''
    } = {}) => {
      if (!id) return null;
      const list = Array.isArray(actions)
        ? actions.filter((action) => action && typeof action === 'object')
        : [];
      if (!list.length) return null;
      controls[id] = {
        id,
        type: 'action-row',
        handlerId,
        actions: list
      };
      return id;
    };
    const addScalarRandomizedControl = ({
      id,
      label,
      ariaLabel = '',
      state,
      variant = 'scale',
      handlerId,
      randomHandlerId = '',
      strengthHandlerId = ''
    } = {}) => {
      if (!id || !state || typeof state !== 'object') return null;
      controls[id] = {
        id,
        type: 'scalar-randomized',
        variant,
        label: typeof state.label === 'string' && state.label.trim().length ? state.label.trim() : label,
        ariaLabel,
        state,
        handlerId,
        randomHandlerId,
        strengthHandlerId
      };
      return id;
    };

    const modeOptions = Array.isArray(legacyState?.subtoolToggles)
      ? legacyState.subtoolToggles.filter((toggle) => toggle && typeof toggle === 'object')
      : [];
    if (modeOptions.length) {
      controls['tool-mode'] = {
        id: 'tool-mode',
        type: 'segmented',
        options: modeOptions
      };
      sections.push({
        id: 'mode',
        label: 'Mode',
        region: 'header',
        collapsible: false,
        controls: ['tool-mode']
      });
    }

    if (!legacyState?.portalMode) {
      const wallControlIds = [];
      const wallPlacementToggles = Array.isArray(legacyState?.customToggles)
        ? legacyState.customToggles.filter((toggle) => String(toggle?.group || '') === 'placement')
        : [];
      const nextWallStackingToggle = wallPlacementToggles.find((toggle) => String(toggle?.id || '') === 'next-poly-under');
      if (nextWallStackingToggle) {
        wallControlIds.push(addToggleControl({
          id: 'wall-next-stack-mode',
          label: nextWallStackingToggle.enabled ? 'Next Wall Stacking: Under' : 'Next Wall Stacking: Over',
          value: !!nextWallStackingToggle.enabled,
          disabled: !!nextWallStackingToggle.disabled,
          tooltip: nextWallStackingToggle.tooltip || '',
          handlerId: 'setNextWallStackMode'
        }));
      }
      if (legacyState?.pathAppearance?.available) {
        const pathAppearance = legacyState.pathAppearance;
        wallControlIds.push(addHintControl({
          id: 'wall-appearance-hint',
          text: pathAppearance.hint
        }));
        wallControlIds.push(addRangeControl({
          id: 'wall-elevation',
          label: pathAppearance.elevation?.label || 'Elevation',
          state: pathAppearance.elevation,
          handlerId: 'setElevation',
          inputOnly: true,
          ariaLabel: pathAppearance.elevation?.label || 'Wall elevation'
        }));
        wallControlIds.push(addRangeControl({
          id: 'wall-layer-opacity',
          label: 'Wall Opacity',
          state: pathAppearance.layerOpacity,
          handlerId: 'setLayerOpacity',
          ariaLabel: 'Wall opacity'
        }));
        wallControlIds.push(addRangeControl({
          id: 'wall-path-scale',
          label: 'Wall Scale',
          state: pathAppearance.scale,
          handlerId: 'setPathScale',
          ariaLabel: 'Wall path scale'
        }));
        wallControlIds.push(addRangePairControl({
          id: 'wall-texture-offset',
          label: 'Wall Texture Offset',
          state: pathAppearance.textureOffset,
          handlerId: 'setTextureOffset',
          ariaLabelX: 'Wall texture offset X',
          ariaLabelY: 'Wall texture offset Y'
        }));
        wallControlIds.push(addRangeControl({
          id: 'wall-path-tension',
          label: 'Wall Tension',
          state: pathAppearance.tension,
          handlerId: 'setPathTension',
          ariaLabel: 'Wall tension'
        }));
        if (pathAppearance.showWidthTangents?.available) {
          wallControlIds.push(addToggleControl({
            id: 'wall-show-width-tangents',
            label: pathAppearance.showWidthTangents?.label || 'Show Width Tangents',
            value: pathAppearance.showWidthTangents?.enabled,
            disabled: pathAppearance.showWidthTangents?.disabled,
            tooltip: pathAppearance.showWidthTangents?.tooltip || '',
            handlerId: 'setShowWidthTangents'
          }));
        }
      }
      if (legacyState?.flip?.available) {
        wallControlIds.push(addAxisTogglePairControl({
          id: 'wall-flip',
          label: 'Flip / Mirror',
          state: legacyState.flip,
          horizontalHandlerId: 'toggleFlipHorizontal',
          verticalHandlerId: 'toggleFlipVertical',
          horizontalRandomHandlerId: 'toggleFlipHorizontalRandom',
          verticalRandomHandlerId: 'toggleFlipVerticalRandom'
        }));
      }
      if (legacyState?.wallOverrideActions?.available) {
        wallControlIds.push(addActionRowControl({
          id: 'wall-override-actions',
          handlerId: 'handleWallOverrideAction',
          actions: legacyState.wallOverrideActions?.actions
        }));
      }
      if (legacyState?.shapeStacking?.available) {
        controls['wall-stack-order'] = {
          id: 'wall-stack-order',
          type: 'stack-order',
          label: 'Selected Wall',
          state: legacyState.shapeStacking,
          pushTopHandlerId: 'pushSelectedWallToTop',
          pushBottomHandlerId: 'pushSelectedWallToBottom'
        };
        wallControlIds.push('wall-stack-order');
      }
      if (wallControlIds.length) {
        sections.push({
          id: 'wall',
          label: 'Wall Transform',
          controls: wallControlIds.filter(Boolean)
        });
      }

      const fillControlIds = [];
      const hasFillTransform = !!(legacyState?.fillTexture?.available || legacyState?.fillHsbc?.available);
      if (legacyState?.scale?.available) {
        fillControlIds.push(addScalarRandomizedControl({
          id: 'fill-scale',
          variant: 'scale',
          label: 'Scale',
          ariaLabel: 'Scale',
          state: legacyState.scale,
          handlerId: 'setScale',
          randomHandlerId: 'toggleScaleRandom',
          strengthHandlerId: 'setScaleRandomStrength'
        }));
      }
      if (legacyState?.rotation?.available) {
        fillControlIds.push(addScalarRandomizedControl({
          id: 'fill-rotation',
          variant: 'rotation',
          label: 'Rotation',
          ariaLabel: 'Rotation',
          state: legacyState.rotation,
          handlerId: 'setRotation',
          randomHandlerId: 'toggleRotationRandom',
          strengthHandlerId: 'setRotationRandomStrength'
        }));
      }
      if (legacyState?.fillTexture?.available) {
        fillControlIds.push(addRangePairControl({
          id: 'fill-texture-offset',
          label: legacyState.fillTexture?.offset?.label || 'Fill Texture Offset',
          state: legacyState.fillTexture?.offset,
          handlerId: 'setFillTextureOffset',
          ariaLabelX: 'Fill texture offset X',
          ariaLabelY: 'Fill texture offset Y'
        }));
      }
      if (hasFillTransform && legacyState?.fillElevation?.available) {
        fillControlIds.push(addRangeControl({
          id: 'fill-elevation',
          label: legacyState.fillElevation.label || 'Fill Elevation',
          state: legacyState.fillElevation,
          handlerId: 'setFillElevation',
          inputOnly: true,
          ariaLabel: legacyState.fillElevation.label || 'Fill elevation'
        }));
      }
      if (fillControlIds.length) {
        sections.push({
          id: 'fill',
          label: 'Fill Transform',
          controls: fillControlIds.filter(Boolean)
        });
      }
      const colorControlIds = [];
      const activeHsbcTarget = legacyState?.colorTarget?.value === 'fill' && legacyState?.fillHsbc?.available ? 'fill' : 'wall';
      if (legacyState?.colorTarget?.available) {
        controls['building-color-target'] = {
          id: 'building-color-target',
          type: 'segmented',
          handlerId: 'setColorTarget',
          options: legacyState.colorTarget.options
        };
        colorControlIds.push('building-color-target');
      }
      colorControlIds.push(...buildHsbcToolOptionsControls({
        state: activeHsbcTarget === 'fill' ? legacyState?.fillHsbc : legacyState?.pathAppearance?.hsbc,
        addRangeControl,
        addHintControl,
        idPrefix: 'building-color',
        handlerIds: activeHsbcTarget === 'fill'
          ? {
              hue: 'setFillHsbcHue',
              saturation: 'setFillHsbcSaturation',
              brightness: 'setFillHsbcBrightness',
              contrast: 'setFillHsbcContrast'
            }
          : {
              hue: 'setHsbcHue',
              saturation: 'setHsbcSaturation',
              brightness: 'setHsbcBrightness',
              contrast: 'setHsbcContrast'
            },
        compact: true,
        ariaPrefix: activeHsbcTarget === 'fill' ? 'Fill color' : 'Wall color'
      }));
      if (colorControlIds.length) {
        sections.push({
          id: 'color',
          label: 'Color',
          controls: colorControlIds.filter(Boolean)
        });
      }

      if (legacyState?.pathShadow?.available) {
        controls['wall-drop-shadow'] = {
          id: 'wall-drop-shadow',
          type: 'drop-shadow',
          variant: 'path',
          state: legacyState.pathShadow,
          toggleLabel: 'Wall Shadow'
        };
        sections.push({
          id: 'drop-shadow',
          label: 'Drop Shadow',
          controls: ['wall-drop-shadow']
        });
      }
    }

    const portalControlIds = [];
    if (legacyState?.doorControls?.available) {
      controls['door-portal-controls'] = {
        id: 'door-portal-controls',
        type: 'portal-controls',
        variant: 'door',
        state: legacyState.doorControls
      };
      portalControlIds.push('door-portal-controls');
    }
    if (legacyState?.windowControls?.available) {
      controls['window-portal-controls'] = {
        id: 'window-portal-controls',
        type: 'portal-controls',
        variant: 'window',
        state: legacyState.windowControls
      };
      portalControlIds.push('window-portal-controls');
    }
    if (portalControlIds.length) {
      sections.push({
        id: 'portals-selection',
        label: '',
        collapsible: false,
        showHeading: false,
        controls: portalControlIds
      });
    }

    const editorActions = Array.isArray(legacyState?.editorActions)
      ? legacyState.editorActions.filter((action) => action && typeof action === 'object')
      : [];
    if (editorActions.length) {
      controls['building-session-actions'] = {
        id: 'building-session-actions',
        type: 'action-row',
        actions: editorActions
      };
      sections.push({
        id: 'session',
        label: 'Session',
        region: 'footer',
        collapsible: false,
        controls: ['building-session-actions']
      });
    }

    return { controls, sections };
  }

  _syncToolOptionsState({
    suppressRender = true,
    suppressSubtoolPersistence = false,
    suppressToolDefaultsPersistence = false
  } = {}) {
    try {
      this._ensureMeasurementsEnabled();
      const descriptor = this._buildToolOptionsDescriptor();
      toolOptionsController.setToolOptions(FEATURE_ID, {
        ...descriptor,
        suppressRender
      });
      this._persistSubtoolFromState(descriptor.legacyState, { suppress: suppressSubtoolPersistence });
      if (!suppressToolDefaultsPersistence) this._scheduleToolDefaultsPersist();
      // Notify callback listeners of state change
      if (typeof this._onToolOptionsChange === 'function') {
        try {
          this._onToolOptionsChange(descriptor.legacyState, descriptor.handlers);
        } catch (cbError) {
          Logger.warn?.('BuildingManager.toolOptionsChangeCallback.failed', { error: String(cbError?.message || cbError) });
        }
      }
    } catch (_) {}
  }

  _persistDelegateToolDefaults() {
    const delegate = this._delegate;
    if (!delegate) return;
    if (typeof delegate._persistToolDefaults !== 'function') return;
    try { delegate._persistToolDefaults(); } catch (_) {}
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
      const value = game?.settings?.get?.(MODULE_ID, BUILDING_SUBTOOL_SETTING_KEY);
      const normalized = typeof value === 'string' ? value : '';
      return BUILDING_PERSISTED_SUBTOOL_IDS.has(normalized) ? normalized : null;
    } catch (_) {
      return null;
    }
  }

  _persistSubtoolPreference(value) {
    if (!value || !BUILDING_PERSISTED_SUBTOOL_IDS.has(value)) return;
    if (this._lastPersistedSubtool === value) return;
    this._lastPersistedSubtool = value;
    try { game?.settings?.set?.(MODULE_ID, BUILDING_SUBTOOL_SETTING_KEY, value); } catch (_) {}
  }

  _extractActiveSubtoolId(state) {
    const toggles = Array.isArray(state?.subtoolToggles) ? state.subtoolToggles : [];
    for (const toggle of toggles) {
      if (!toggle || typeof toggle !== 'object') continue;
      if (!toggle.enabled) continue;
      const id = String(toggle.id || '');
      if (BUILDING_ACTIVE_SUBTOOL_IDS.has(id)) return id;
    }
    return null;
  }

  _persistSubtoolFromState(state, { suppress = false } = {}) {
    if (suppress) return;
    const active = this._extractActiveSubtoolId(state);
    if (!active) return;
    this._persistSubtoolPreference(active);
  }

  _restoreSubtoolPreference() {
    if (this._portalMode) return;
    const preferred = this._readSubtoolPreference();
    if (!preferred) return;
    this._lastPersistedSubtool = preferred;
    const apply = () => {
      if (!this._delegate?.isActive) return;
      this.setActiveTool(preferred);
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(apply);
    else setTimeout(apply, 0);
  }

  _ensureMeasurementsEnabled() {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    if (this._forcingMeasurementsEnabled) return false;
    if (delegate._measurementOverlayEnabled !== false) return false;
    this._forcingMeasurementsEnabled = true;
    try {
      if (typeof delegate._setMeasurementOverlayEnabled === 'function') {
        delegate._setMeasurementOverlayEnabled(true);
      } else {
        delegate._measurementOverlayEnabled = true;
        try { delegate._refreshMeasurementOverlay?.(); } catch (_) {}
        try { delegate._persistToolDefaults?.(); } catch (_) {}
      }
      return true;
    } catch (error) {
      Logger.warn?.('BuildingManager.ensureMeasurementsEnabled.failed', {
        error: String(error?.message || error)
      });
      return false;
    } finally {
      this._forcingMeasurementsEnabled = false;
    }
  }
}

export default BuildingManager;
