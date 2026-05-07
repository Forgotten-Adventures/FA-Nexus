import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  resolveTileDocument
} from '../premium/session-host/editing-targets.js';
import { resolvePremiumFeatureDelegate } from '../premium/session-host/delegate-bootstrap.js';
import {
  buildHostedSessionContextDetails,
  getCurrentSceneId,
  isHostedSessionSceneCurrent,
  isApplicationHostReady
} from '../premium/session-host/host-context.js';
import {
  cancelToolWindowMonitor,
  startHostedToolWindowMonitor
} from '../premium/session-host/tool-window-monitor.js';
import {
  beginEditingTileTracking,
  endEditingTileWithRefresh
} from '../premium/session-host/editing-session-state.js';
import {
  handleSessionLaunchFailure as handleHostedSessionLaunchFailure,
  hasHostedSessionChanges,
  runHostedSessionLaunch,
  stopSessionWithFinalize,
  stopOrphanedSession as stopHostedOrphanedSession
} from '../premium/session-host/session-lifecycle.js';
import {
  handleEntitlementRevalidationFailure,
  scheduleEntitlementRevalidation
} from '../premium/session-host/entitlement-revalidation.js';
import {
  syncHostedToolOptions
} from '../premium/session-host/tool-options-sync.js';
import { createSubtoolPreferenceBridge } from '../premium/session-host/subtool-preference-bridge.js';
import { applyPathTile, cleanupPathOverlay } from './path-tiles.js';
import { toolOptionsController } from '../core/tool-options-controller.js';
import {
  createNormalizedToolOptionsDescriptor,
  TOOL_OPTIONS_RENDERER_MODE
} from '../core/tool-options-descriptor.js';
import { createShortcut, createStandardEditorShortcuts, mergeShortcutLists } from '../core/editor-shortcuts.js';
import { buildHsbcToolOptionsControls } from '../core/hsbc.js';
import { requestSelectionFilterRefresh } from '../canvas/selection-filter-refresh.js';
import { resolvePlacementAnchorTile } from '../canvas/elevation-band-utils.js';
import { resolvePlacementSortAtElevation } from '../canvas/canvas-interaction-controller.js';

const MODULE_ID = 'fa-nexus';
const PATH_SUBTOOL_SETTING_KEY = 'pathToolActiveSubtool';
const PATH_ACTIVE_SUBTOOL_IDS = new Set(['curve', 'draw', 'edit-shapes']);
const PATH_PERSISTED_SUBTOOL_IDS = new Set(['curve', 'draw']);
const EDITING_TILES_KEY = '__faNexusPathEditingTiles';
const PATH_MIN_SPLITTABLE_POINTS = 3;
const PREVIEW_LAYER_HOOK = 'fa-nexus-preview-layers-changed';

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
    this._sessionSceneId = null;
    this._hostUnavailableReason = 'host-context-unavailable';
    this._pendingLaunchPlacementAnchorTileId = undefined;
    this._subtoolPreferenceBridge = createSubtoolPreferenceBridge({
      moduleId: MODULE_ID,
      settingKey: PATH_SUBTOOL_SETTING_KEY,
      activeSubtoolIds: PATH_ACTIVE_SUBTOOL_IDS,
      persistedSubtoolIds: PATH_PERSISTED_SUBTOOL_IDS,
      getDelegate: () => this._delegate,
      requestSubtoolToggle: (id, enabled) => toolOptionsController?.requestCustomToggle?.(id, enabled)
    });
    this._editingTileId = null;
    this._sessionShortcutKeydownHandler = null;
    this._lastPreviewLayerSignature = null;
    this._syncToolOptionsState();
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  hasSessionChanges() {
    return hasHostedSessionChanges(this._delegate);
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
    if (this._loading) return this._loading;
    this._loading = resolvePremiumFeatureDelegate({
      featureId: 'path.edit.v2',
      app: this._app,
      host: this,
      assignDelegate: (instance) => {
        this._delegate = instance;
      },
      missingMessage: 'Premium path editor v2 bundle missing PathManagerV2 implementation',
      loadedLogName: 'PathEditorV2.bundle.loaded',
      loadedHookName: 'fa-nexus-path-editor-v2-loaded',
      fallbackVersion: '0.0.15'
    });
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  }

  async start(...args) {
    const delegate = await this._ensureDelegate();
    const wasActive = !!delegate?.isActive;
    if (!wasActive) this._clearEditingTile();
    return runHostedSessionLaunch({
      beforeLaunch: () => {
        this._captureLaunchPlacementAnchorTileId();
        this._snapshotSessionScene(null, 'start');
        this._cancelPlacementSessions();
        this._refreshDelegateToolDefaults();
      },
      launchSession: () => delegate.start?.(...args),
      afterLaunch: () => {
        try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
        this._applyPendingLaunchPlacementAnchorTileId();
        this._syncDelegatePreviewRenderSort();
        this._applyCurrentPreviewLayerOrdering();
        this._syncToolOptionsState({
          suppressSubtoolPersistence: true,
          suppressToolDefaultsPersistence: true
        });
        toolOptionsController.activateTool('path.edit.v2', { label: 'Path Editor v2' });
        this._beginToolWindowMonitor('path.edit.v2', delegate);
        this._installSessionShortcutListener();
        if (!wasActive) this._restoreSubtoolPreference();
      },
      handleLaunchFailure: (error) => this._handleSessionLaunchFailure(error, { phase: 'start' }),
      scheduleEntitlementProbe: () => this._scheduleEntitlementProbe()
    });
  }

  async editTile(targetTile, options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed path editor bundle does not support editing existing tiles.');
    }
    const doc = resolveTileDocument(targetTile);
    if (doc) this._markEditingTile(doc);
    return runHostedSessionLaunch({
      beforeLaunch: () => {
        this._snapshotSessionScene(targetTile, 'edit');
        this._cancelPlacementSessions();
        this._refreshDelegateToolDefaults();
      },
      launchSession: () => delegate.editTile(targetTile, options),
      afterLaunch: () => {
        try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
        this._syncDelegatePreviewRenderSort();
        this._applyCurrentPreviewLayerOrdering();
        this._syncToolOptionsState({
          suppressSubtoolPersistence: true,
          suppressToolDefaultsPersistence: true
        });
        toolOptionsController.activateTool('path.edit.v2', { label: 'Path Editor v2' });
        this._beginToolWindowMonitor('path.edit.v2', delegate);
        this._installSessionShortcutListener();
      },
      handleLaunchFailure: (error) => this._handleSessionLaunchFailure(error, { phase: 'edit', tileDoc: doc }),
      scheduleEntitlementProbe: () => this._scheduleEntitlementProbe()
    });
  }

  async _handleSessionLaunchFailure(error, { phase = 'start', tileDoc = null } = {}) {
    return handleHostedSessionLaunchFailure({
      error,
      phase,
      loggerPrefix: 'PathManagerV2',
      details: buildHostedSessionContextDetails({
        app: this._app,
        delegate: this._delegate,
        editingTileId: tileDoc?.id || this._editingTileId || null
      }),
      cancelToolWindowMonitor: () => this._cancelToolWindowMonitor(),
      stopSession: ({ reason }) => this.stop({ reason }),
      onFallbackCleanup: () => {
        try { toolOptionsController.deactivateTool('path.edit.v2'); } catch (_) {}
        this._clearEditingTile(tileDoc);
      }
    });
  }

  _isEditorHostReady() {
    return isApplicationHostReady(this._app);
  }

  _snapshotSessionScene(target = null, phase = 'start') {
    const doc = resolveTileDocument(target);
    const sceneId = String(doc?.parent?.id || getCurrentSceneId() || '').trim();
    this._sessionSceneId = sceneId || null;
    if (!sceneId) {
      Logger.warn?.('PathManagerV2.session.sceneIdMissing', { phase });
    }
    return this._sessionSceneId;
  }

  _isSessionHostReady() {
    if (!this._isEditorHostReady()) {
      this._hostUnavailableReason = 'host-context-unavailable';
      return false;
    }
    if (!isHostedSessionSceneCurrent(this._sessionSceneId)) {
      this._hostUnavailableReason = 'scene-changed-during-editor-session';
      return false;
    }
    this._hostUnavailableReason = 'host-context-unavailable';
    return true;
  }

  _handleInactiveMonitorStop() {
    if (this._sessionSceneId && !isHostedSessionSceneCurrent(this._sessionSceneId)) {
      Logger.warn?.('PathManagerV2.session.sceneChangedInactive', {
        reason: 'scene-changed-during-editor-session',
        sessionSceneId: this._sessionSceneId || null,
        currentSceneId: getCurrentSceneId() || null,
        editingTileId: this._editingTileId || null
      });
    }
    this._sessionSceneId = null;
  }

  _stopOrphanedSession({ reason = 'host-context-unavailable' } = {}) {
    return stopHostedOrphanedSession({
      reason,
      loggerPrefix: 'PathManagerV2',
      details: buildHostedSessionContextDetails({
        app: this._app,
        delegate: this._delegate,
        includeAppState: true,
        editingTileId: this._editingTileId || null,
        extra: {
          sessionSceneId: this._sessionSceneId || null,
          currentSceneId: getCurrentSceneId() || null
        }
      }),
      cancelToolWindowMonitor: () => this._cancelToolWindowMonitor(),
      stopSession: ({ reason: stopReason }) => this.stop({ reason: stopReason }),
      onFallbackCleanup: () => {
        this._sessionSceneId = null;
        try { toolOptionsController.deactivateTool('path.edit.v2'); } catch (_) {}
        this._clearEditingTile();
      }
    });
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
    return stopSessionWithFinalize({
      delegate: this._delegate,
      beforeStop: () => {
        this._cancelToolWindowMonitor();
        this._removeSessionShortcutListener();
      },
      persistToolDefaults: () => this._persistDelegateToolDefaults(),
      stopSession: (delegate) => delegate.stop?.(...args),
      finalize: () => {
        this._sessionSceneId = null;
        this._clearEditingTile();
        toolOptionsController.deactivateTool('path.edit.v2');
        requestSelectionFilterRefresh({
          reason: 'path-editor-v2-stop',
          source: 'path-manager-v2'
        });
      },
      onStopError: (error) => {
        Logger.warn?.('PathManagerV2.stop.failed', { error: String(error?.message || error) });
      }
    });
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
    return scheduleEntitlementRevalidation(this, {
      featureId: 'path.edit.v2',
      revalidateReason: 'path-edit-v2:revalidate',
      onFailure: (error) => this._handleEntitlementFailure(error)
    });
  }

  async _handleEntitlementFailure(error) {
    return handleEntitlementRevalidationFailure({
      error,
      featureId: 'path.edit.v2',
      loggerPrefix: 'PathManagerV2',
      clearReason: 'path-revalidate-failed',
      warningMessage: 'Authentication expired - premium path editing v2 has been disabled. Please reconnect Patreon.',
      stopSession: () => this.stop?.(),
      resetState: () => {
        this._delegate = null;
      }
    });
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
    this._toolMonitor = startHostedToolWindowMonitor({
      delegate,
      toolId,
      isHostReady: () => this._isSessionHostReady(),
      clearEditingTile: () => this._clearEditingTile(),
      cancelMonitor: () => this._cancelToolWindowMonitor(),
      stopOrphanedSession: (details) => this._stopOrphanedSession({
        ...details,
        reason: this._hostUnavailableReason || details?.reason
      }),
      onInactive: () => {
        this._handleInactiveMonitorStop();
        requestSelectionFilterRefresh({
          reason: 'path-editor-v2-monitor-stop',
          source: 'path-manager-v2'
        });
      },
      assignMonitorToken: (nextToken) => {
        this._toolMonitor = nextToken;
      },
      syncToolOptions: () => {
        this._syncToolOptionsState({
          suppressRender: true,
          suppressSubtoolPersistence: true,
          suppressToolDefaultsPersistence: true
        });
      },
      monitorSyncLoggerPrefix: 'PathManagerV2'
    });
  }

  _cancelToolWindowMonitor() {
    this._toolMonitor = cancelToolWindowMonitor(this._toolMonitor);
  }

  _markEditingTile(doc) {
    const { tileId: id, tile } = beginEditingTileTracking(this, {
      target: doc,
      sharedSetKey: EDITING_TILES_KEY,
      onReplace: (previousTileId) => this._clearEditingTile(previousTileId)
    });
    if (!id) return;
    if (tile) {
      try { cleanupPathOverlay(tile); } catch (_) {}
    }
  }

  _clearEditingTile(target = null) {
    endEditingTileWithRefresh(this, {
      target,
      sharedSetKey: EDITING_TILES_KEY,
      loggerPrefix: 'PathManagerV2',
      collectRefreshJobs: ({ tile }) => applyPathTile(tile),
      refreshAfterJobs: ({ tileId }) => requestSelectionFilterRefresh({
        reason: 'path-editor-v2-edit-exit',
        source: 'path-manager-v2',
        tileIds: [tileId]
      })
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

  _notifyPreviewLayerChangeIfNeeded(descriptor = null, { force = false, source = 'path-preview' } = {}) {
    const previewState = {
      active: !!this._delegate?.isActive,
      elevation: Number.isFinite(this._delegate?._previewElevation) ? Number(this._delegate._previewElevation) : null,
      sort: Number.isFinite(this._delegate?._previewSort) ? Number(this._delegate._previewSort) : null,
      activePathId: this._delegate?._activePathId || null,
      mode: descriptor?.descriptor?.activeMode || null
    };
    const signature = JSON.stringify(previewState);
    if (!force && signature === this._lastPreviewLayerSignature) return;
    this._lastPreviewLayerSignature = signature;
    try { Hooks?.callAll?.(PREVIEW_LAYER_HOOK, { source, previewState }); } catch (_) {}
  }

  _captureLaunchPlacementAnchorTileId(controlledTiles = canvas?.tiles?.controlled) {
    const anchorTile = resolvePlacementAnchorTile(controlledTiles, { source: 'path-manager-v2-start' });
    const anchorTileId = String(anchorTile?.document?.id || anchorTile?.id || '').trim() || null;
    this._pendingLaunchPlacementAnchorTileId = anchorTileId;
    Logger.debug?.('PathManagerV2.sortAnchor.launchCapture', {
      anchorTileId,
      elevation: Number(anchorTile?.document?.elevation ?? anchorTile?.elevation ?? 0) || 0,
      sort: Number(anchorTile?.document?.sort ?? anchorTile?.sort ?? 0) || 0
    });
    return anchorTileId;
  }

  _applyPendingLaunchPlacementAnchorTileId() {
    if (this._pendingLaunchPlacementAnchorTileId === undefined) return null;
    const anchorTileId = this._pendingLaunchPlacementAnchorTileId || null;
    this._pendingLaunchPlacementAnchorTileId = undefined;
    if (!this._delegate) return anchorTileId;
    try { this._delegate._placementSortAnchorTileId = anchorTileId; } catch (_) {}
    try { this._delegate._placementSortBeforeAnchor = false; } catch (_) {}
    Logger.debug?.('PathManagerV2.sortAnchor.launchApply', { anchorTileId });
    return anchorTileId;
  }

  _syncDelegatePreviewRenderSort() {
    const delegate = this._delegate;
    if (!delegate) return null;
    const currentSort = Number(delegate?._previewSort ?? 0);
    if (this._editingTileId) {
      const resolvedSort = Number.isFinite(currentSort) ? currentSort : 0;
      try { delegate._previewRenderSort = resolvedSort; } catch (_) {}
      return resolvedSort;
    }
    const elevation = Number(delegate?._previewElevation ?? 0);
    const normalizedElevation = Number.isFinite(elevation) ? elevation : 0;
    const resolved = resolvePlacementSortAtElevation(normalizedElevation, {
      anchorTileId: delegate?._placementSortAnchorTileId,
      sortBefore: delegate?._placementSortBeforeAnchor === true,
      scene: canvas?.scene,
      count: 1
    });
    const placementSort = Number(resolved?.sort ?? currentSort);
    if (Number.isFinite(placementSort) && Number.isFinite(currentSort) && Math.abs(placementSort - currentSort) > 0.000001) {
      Logger.warn?.('PathManagerV2.previewSort.delegateMismatch', {
        delegateSort: currentSort,
        resolvedSort: placementSort,
        elevation: normalizedElevation,
        anchorTileId: delegate?._placementSortAnchorTileId || null
      });
      try { delegate._previewSort = placementSort; } catch (_) {}
    }
    const renderSort = Number(resolved?.previewSort ?? placementSort);
    const nextRenderSort = Number.isFinite(renderSort)
      ? renderSort
      : (Number.isFinite(placementSort) ? placementSort : 0);
    try { delegate._previewRenderSort = nextRenderSort; } catch (_) {}
    const key = normalizedElevation.toFixed(3);
    const group = delegate?._previewGroups?.get?.(key) || null;
    if (group) {
      try { group.placementSort = Number.isFinite(placementSort) ? placementSort : currentSort; } catch (_) {}
      try { group.sort = nextRenderSort; } catch (_) {}
    }
    return nextRenderSort;
  }

  _applyPathPreviewPlacementMetadata() {
    const delegate = this._delegate;
    if (!delegate) return;
    const placementSort = Number.isFinite(Number(delegate?._previewSort)) ? Number(delegate._previewSort) : 0;
    const renderSort = Number.isFinite(Number(delegate?._previewRenderSort)) ? Number(delegate._previewRenderSort) : placementSort;
    const applyMetadata = (container, finalSort, previewSort) => {
      if (!container || container.destroyed) return;
      try { container.faNexusPlacementSort = finalSort; } catch (_) {}
      try { container.faNexusPreviewSort = previewSort; } catch (_) {}
    };
    applyMetadata(delegate._layer, placementSort, renderSort);
    if (!delegate._previewGroups?.size) return;
    for (const group of delegate._previewGroups.values()) {
      const groupPlacementSort = Number.isFinite(Number(group?.placementSort))
        ? Number(group.placementSort)
        : placementSort;
      const groupRenderSort = Number.isFinite(Number(group?.sort)) ? Number(group.sort) : groupPlacementSort;
      applyMetadata(group?.container, groupPlacementSort, groupRenderSort);
    }
  }

  _applyCurrentPreviewLayerOrdering() {
    const placementSort = Number(this._delegate?._previewSort ?? 0);
    const renderSort = Number(this._delegate?._previewRenderSort ?? this._syncDelegatePreviewRenderSort() ?? placementSort);
    try { this._delegate?._syncElevationGroupOrdering?.(); } catch (_) {}
    try { this._delegate?._applyPreviewLayerOrdering?.(Number.isFinite(renderSort) ? renderSort : placementSort); } catch (_) {}
    this._applyPathPreviewPlacementMetadata();
  }

  _normalizePreviewGroupKey({ previewKey = null, previewId = null, elevation = null } = {}) {
    const explicit = String(previewKey || '').trim();
    if (explicit) return explicit;
    const id = String(previewId || '').trim();
    if (id.startsWith('path-preview-')) return id.slice('path-preview-'.length);
    const numeric = Number(elevation);
    return Number.isFinite(numeric) ? numeric.toFixed(3) : '';
  }

  _getPathEntryElevation(entry, fallback = this._delegate?._previewElevation) {
    const delegate = this._delegate;
    try {
      if (typeof delegate?._getEntryElevation === 'function') {
        const resolved = Number(delegate._getEntryElevation(entry, fallback));
        if (Number.isFinite(resolved)) return resolved;
      }
    } catch (_) {}
    const direct = Number(entry?.elevation);
    if (Number.isFinite(direct)) return direct;
    const fallbackNumber = Number(fallback);
    return Number.isFinite(fallbackNumber) ? fallbackNumber : 0;
  }

  _applyPathPreviewGroupPlacement({
    previewKey = null,
    previewId = null,
    elevation = null,
    sort = undefined,
    previewSort = undefined
  } = {}) {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    const sourceKey = this._normalizePreviewGroupKey({ previewKey, previewId, elevation });
    const targetElevation = Number(elevation);
    const targetKey = Number.isFinite(targetElevation) ? targetElevation.toFixed(3) : sourceKey;
    const nextSort = Number(sort);
    let changed = false;

    if (sourceKey && targetKey && sourceKey !== targetKey && Array.isArray(delegate._sessionPaths)) {
      for (const entry of delegate._sessionPaths) {
        const entryKey = this._getPathEntryElevation(entry).toFixed(3);
        if (entryKey !== sourceKey) continue;
        entry.elevation = targetElevation;
        changed = true;
      }
      if (Number(delegate._previewElevation).toFixed(3) === sourceKey) {
        delegate._previewElevation = targetElevation;
        changed = true;
      }
      if (changed) {
        try { delegate._syncSessionMeshOrder?.({ includeActive: true }); } catch (_) {}
      }
    }

    if (Number.isFinite(nextSort)) {
      const nextPreviewSort = Number.isFinite(Number(previewSort)) ? Number(previewSort) : nextSort;
      const group = delegate._previewGroups?.get?.(targetKey)
        || delegate._previewGroups?.get?.(sourceKey)
        || null;
      if (group && (Number(group.placementSort) !== nextSort || Number(group.sort) !== nextPreviewSort)) {
        group.placementSort = nextSort;
        group.sort = nextPreviewSort;
        changed = true;
      }
    }

    return changed;
  }

  applyLayerManagerPreviewPlacement({
    elevation = null,
    sort = undefined,
    previewSort = undefined,
    previewId = null,
    previewKey = null,
    anchorTileId = undefined,
    sortBefore = undefined
  } = {}) {
    if (!this._delegate?.isActive) return false;
    const { handlers } = this._buildToolOptionsState();
    let changed = false;

    if (anchorTileId !== undefined) {
      const nextAnchorTileId = String(anchorTileId || '').trim() || null;
      if (String(this._delegate?._placementSortAnchorTileId || '').trim() !== String(nextAnchorTileId || '').trim()) {
        try { this._delegate._placementSortAnchorTileId = nextAnchorTileId; } catch (_) {}
        changed = true;
      }
    }

    if (sortBefore !== undefined) {
      const nextSortBefore = sortBefore === true;
      if (this._delegate?._placementSortBeforeAnchor !== nextSortBefore) {
        try { this._delegate._placementSortBeforeAnchor = nextSortBefore; } catch (_) {}
        changed = true;
      }
    }

    if (Number.isFinite(Number(elevation))) {
      const nextElevation = Number(elevation);
      if (Number(this._delegate?._previewElevation) !== nextElevation) {
        if (typeof handlers?.setElevation === 'function') handlers.setElevation(nextElevation, true);
        else this._delegate._previewElevation = nextElevation;
        changed = true;
      }
    }

    if (sort !== undefined && Number.isFinite(Number(sort))) {
      const nextSort = Number(sort);
      if (Number(this._delegate?._previewSort) !== nextSort) {
        try { this._delegate._previewSort = nextSort; } catch (_) {}
        changed = true;
      }
      const nextPreviewSort = previewSort !== undefined && Number.isFinite(Number(previewSort))
        ? Number(previewSort)
        : nextSort;
      if (Number(this._delegate?._previewRenderSort) !== nextPreviewSort) {
        try { this._delegate._previewRenderSort = nextPreviewSort; } catch (_) {}
        changed = true;
      }
    }

    changed = this._applyPathPreviewGroupPlacement({
      previewId,
      previewKey,
      elevation,
      sort,
      previewSort
    }) || changed;

    if (!changed) return false;
    this._applyCurrentPreviewLayerOrdering();
    try { this._delegate?._refreshCursorPreview?.(); } catch (_) {}
    this._syncToolOptionsState({
      suppressRender: false,
      suppressSubtoolPersistence: true,
      suppressToolDefaultsPersistence: true
    });
    this._notifyPreviewLayerChangeIfNeeded(null, { force: true, source: 'path-preview-layer-manager' });
    return true;
  }

  selectLayerManagerPreview({
    previewId = null,
    previewKey = null,
    elevation = null
  } = {}) {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    const sourceKey = this._normalizePreviewGroupKey({ previewKey, previewId, elevation });
    const targetElevation = Number(elevation);
    const targetKey = sourceKey || (Number.isFinite(targetElevation) ? targetElevation.toFixed(3) : '');
    let activatedEditShapes = false;
    if (!delegate._editShapesMode && typeof delegate._setSubtoolMode === 'function') {
      activatedEditShapes = !!delegate._setSubtoolMode('edit-shapes');
      if (!activatedEditShapes) {
        Logger.warn('PathManagerV2.previewSelect.editShapesUnavailable', {
          previewId,
          previewKey,
          elevation: Number.isFinite(targetElevation) ? targetElevation : null
        });
        return false;
      }
    }

    const entries = Array.isArray(delegate._sessionPaths) ? delegate._sessionPaths : [];
    const matching = entries.filter((entry) => this._getPathEntryElevation(entry).toFixed(3) === targetKey);
    const activeEntry = matching.find((entry) => entry?.id && entry.id === delegate._activePathId) || null;
    const targetEntry = activeEntry || matching[matching.length - 1] || null;
    if (!targetEntry?.id) {
      Logger.warn('PathManagerV2.previewSelect.pathMissing', {
        previewId,
        previewKey,
        elevation: Number.isFinite(targetElevation) ? targetElevation : null,
        targetKey,
        editShapesMode: !!delegate._editShapesMode,
        activatedEditShapes
      });
      return false;
    }

    const selected = typeof delegate._selectSessionPath === 'function'
      ? !!delegate._selectSessionPath(targetEntry.id)
      : false;
    if (!selected) {
      Logger.warn('PathManagerV2.previewSelect.failed', {
        previewId,
        previewKey,
        pathId: targetEntry.id,
        targetKey
      });
      return false;
    }
    this._syncToolOptionsState({
      suppressRender: false,
      suppressSubtoolPersistence: true,
      suppressToolDefaultsPersistence: true
    });
    this._notifyPreviewLayerChangeIfNeeded(null, { force: true, source: 'path-preview-layer-manager-select' });
    return true;
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
    const descriptor = this._buildToolOptionsDescriptor();
    syncHostedToolOptions({
      toolId: 'path.edit.v2',
      descriptor,
      suppressRender,
      legacyState: descriptor.legacyState,
      persistSubtoolFromState: (state) => this._persistSubtoolFromState(state),
      suppressSubtoolPersistence,
      scheduleToolDefaultsPersist: () => this._scheduleToolDefaultsPersist(),
      suppressToolDefaultsPersistence,
      loggerPrefix: 'PathManagerV2'
    });
    this._notifyPreviewLayerChangeIfNeeded(descriptor, { source: 'path-preview' });
  }

  requestToolOptionsUpdate(options = {}) {
    this._syncToolOptionsState(options);
  }

  _persistDelegateToolDefaults() {
    this._subtoolPreferenceBridge.persistDelegateToolDefaults();
  }

  _refreshDelegateToolDefaults() {
    this._subtoolPreferenceBridge.refreshDelegateToolDefaults();
  }

  _scheduleToolDefaultsPersist() {
    this._subtoolPreferenceBridge.scheduleToolDefaultsPersist();
  }

  _extractActiveSubtoolId(state) {
    return this._subtoolPreferenceBridge.extractActiveSubtoolId(state);
  }

  _persistSubtoolFromState(state, options = {}) {
    this._subtoolPreferenceBridge.persistSubtoolFromState(state, options);
  }

  _restoreSubtoolPreference() {
    this._subtoolPreferenceBridge.restoreSubtoolPreference();
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

}

export default PathManagerV2;
