import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { isKeyEventForTextEntry } from '../core/keyboard-text-entry.js';
import { waitForNativeTileTransformTransactions } from '../canvas/native-tile-transform-transactions.js';
import {
  resolveTileDocument
} from '../premium/session-host/editing-targets.js';
import { resolvePremiumFeatureDelegate } from '../premium/session-host/delegate-bootstrap.js';
import { getPremiumRuntimeAdapter } from '../premium/session-host/premium-runtime-adapter.js';
import { callRequiredDelegateMethod } from '../premium/session-host/delegate-methods.js';
import { callRequiredPreviewPlacementAdapterMethod } from '../premium/session-host/preview-placement-adapter.js';
import {
  buildHostedSessionContextDetails,
  isApplicationHostReady
} from '../premium/session-host/host-context.js';
import {
  beginHostedToolWindowMonitor,
  cancelHostedToolWindowMonitor
} from '../premium/session-host/tool-window-monitor.js';
import {
  beginEditingTileTracking,
  endEditingTileWithRefresh
} from '../premium/session-host/editing-session-state.js';
import {
  handleSessionLaunchFailure as handleHostedSessionLaunchFailure,
  hasHostedSessionChanges,
  runHostedSessionLaunch,
  syncHostedPreviewLaunchState,
  stopSessionWithFinalize
} from '../premium/session-host/session-lifecycle.js';
import {
  handleInactiveHostedSceneSessionStop,
  isHostedSceneSessionHostReady,
  snapshotHostedSessionScene,
  stopOrphanedHostedSceneSession
} from '../premium/session-host/scene-session-guard.js';
import {
  handleEntitlementRevalidationFailure,
  scheduleEntitlementRevalidation
} from '../premium/session-host/entitlement-revalidation.js';
import {
  notifyHostedPreviewLayerChangeIfNeeded,
  syncHostedToolOptions
} from '../premium/session-host/tool-options-sync.js';
import { createSubtoolPreferenceBridge } from '../premium/session-host/subtool-preference-bridge.js';
import { applyPathTile, cleanupPathOverlay } from './path-tiles.js';
import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';
import {
  createNormalizedToolOptionsDescriptor,
  TOOL_OPTIONS_RENDERER_MODE
} from '../core/tool-options/tool-options-descriptor.js';
import {
  addDeclarativeActionRowControl,
  addDeclarativeAxisTogglePairControl,
  addDeclarativeHintControl,
  addDeclarativeRangeControl,
  addDeclarativeRangePairControl,
  addDeclarativeToggleControl,
  addDeclarativeToggleListControl
} from '../core/tool-options/tool-options-control-builders.js';
import { createShortcut, createStandardEditorShortcuts, mergeShortcutLists } from '../core/editor-shortcuts.js';
import { buildHsbcToolOptionsControls } from '../core/hsbc.js';
import { requestSelectionFilterRefresh } from '../canvas/selection-filter-refresh.js';
import { getCurrentViewedLevelIds, resolvePlacementAnchorTile } from '../canvas/elevation-band-utils.js';
import { PathGeneratedWallOwnership } from './path-generated-wall-ownership.js';
import {
  PATH_WALL_BEHAVIORS,
  PATH_WALL_BEHAVIOR_OFF_TOOLTIP,
  PATH_WALL_BEHAVIOR_TOOLTIPS,
  normalizePathWallBehavior
} from './path-wall-behavior.js';

const MODULE_ID = 'fa-nexus';
const PATH_SUBTOOL_SETTING_KEY = 'pathToolActiveSubtool';
const PATH_ACTIVE_SUBTOOL_IDS = new Set(['curve', 'draw', 'edit-shapes']);
const PATH_PERSISTED_SUBTOOL_IDS = new Set(['curve', 'draw']);
const EDITING_TILES_KEY = '__faNexusPathEditingTiles';

export class PathManagerV2 {
  constructor(app) {
    this._app = app;
    this.premiumRuntimeAdapter = getPremiumRuntimeAdapter(app);
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._sessionSceneId = null;
    this._hostUnavailableReason = 'host-context-unavailable';
    this._pendingLaunchPlacementAnchorTileId = undefined;
    this._generatedWallOwnership = new PathGeneratedWallOwnership();
    this._subtoolPreferenceBridge = createSubtoolPreferenceBridge({
      moduleId: MODULE_ID,
      settingKey: PATH_SUBTOOL_SETTING_KEY,
      activeSubtoolIds: PATH_ACTIVE_SUBTOOL_IDS,
      persistedSubtoolIds: PATH_PERSISTED_SUBTOOL_IDS,
      getDelegate: () => this._delegate,
      requestSubtoolToggle: (id, enabled) => toolOptionsController?.requestCustomToggle?.(id, enabled),
      loggerPrefix: 'PathManagerV2'
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
      loadedHookName: 'fa-nexus-path-editor-v2-loaded'
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
      awaitLaunch: true,
      beforeLaunch: () => {
        this._captureLaunchPlacementAnchorTileId();
        this._snapshotSessionScene(null, 'start');
        this._cancelPlacementSessions();
        this._refreshDelegateToolDefaults();
      },
      launchSession: () => callRequiredDelegateMethod({
        delegate,
        methodName: 'start',
        args,
        loggerPrefix: 'PathManagerV2',
        logScope: 'sessionLaunch',
        bundleLabel: 'path editor'
      }),
      afterLaunch: () => {
        syncHostedPreviewLaunchState({
          applyLaunchPlacementAnchorTileId: () => this._applyPendingLaunchPlacementAnchorTileId(),
          syncPreviewRenderSort: () => this._syncDelegatePreviewRenderSort(),
          applyCurrentPreviewLayerOrdering: () => this._applyCurrentPreviewLayerOrdering()
        });
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
    const doc = resolveTileDocument(targetTile);
    await waitForNativeTileTransformTransactions(doc);
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed path editor bundle does not support editing existing tiles.');
    }
    if (doc) this._markEditingTile(doc);
    return runHostedSessionLaunch({
      beforeLaunch: () => {
        this._snapshotSessionScene(targetTile, 'edit');
        this._cancelPlacementSessions();
        this._refreshDelegateToolDefaults();
      },
      launchSession: () => delegate.editTile(targetTile, options),
      afterLaunch: () => {
        syncHostedPreviewLaunchState({
          syncPreviewRenderSort: () => this._syncDelegatePreviewRenderSort(),
          applyCurrentPreviewLayerOrdering: () => this._applyCurrentPreviewLayerOrdering()
        });
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
    return snapshotHostedSessionScene(this, {
      target,
      phase,
      loggerPrefix: 'PathManagerV2'
    });
  }

  _isSessionHostReady() {
    return isHostedSceneSessionHostReady(this, {
      app: this._app,
      isEditorHostReady: () => this._isEditorHostReady()
    });
  }

  _handleInactiveMonitorStop() {
    return handleInactiveHostedSceneSessionStop(this, {
      loggerPrefix: 'PathManagerV2',
      details: {
        editingTileId: this._editingTileId || null
      }
    });
  }

  _stopOrphanedSession({ reason = 'host-context-unavailable' } = {}) {
    return stopOrphanedHostedSceneSession(this, {
      reason,
      loggerPrefix: 'PathManagerV2',
      app: this._app,
      delegate: this._delegate,
      contextDetails: {
        editingTileId: this._editingTileId || null,
      },
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
    // An "x" typed into a search or name box is text, also while the pointer rests on a path.
    if (isKeyEventForTextEntry(event)) return;
    if (!this._delegate?.isActive) return;
    const applied = this._callRequiredPathEditingDelegateMethod('splitHoveredPath', [{
      keyEvent: event
    }]);
    if (!applied) {
      Logger.debug?.('PathManagerV2.pathSplit.shortcutIgnored');
      return;
    }
    this._syncToolOptionsState({
      suppressSubtoolPersistence: true,
      suppressToolDefaultsPersistence: true
    });
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  _callRequiredPathEditingDelegateMethod(methodName, args = []) {
    return callRequiredDelegateMethod({
      delegate: this._delegate,
      methodName,
      args,
      loggerPrefix: 'PathManagerV2',
      logScope: 'pathEditing',
      bundleLabel: 'path editor'
    });
  }

  stop(...args) {
    return stopSessionWithFinalize({
      delegate: this._delegate,
      beforeStop: () => {
        this._cancelToolWindowMonitor();
        this._removeSessionShortcutListener();
      },
      persistToolDefaults: () => this._persistDelegateToolDefaults(),
      stopSession: (delegate) => callRequiredDelegateMethod({
        delegate,
        methodName: 'stop',
        args,
        loggerPrefix: 'PathManagerV2',
        logScope: 'sessionStop',
        bundleLabel: 'path editor'
      }),
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
    return callRequiredDelegateMethod({
      delegate,
      methodName: 'savePath',
      args,
      loggerPrefix: 'PathManagerV2',
      logScope: 'persistence',
      bundleLabel: 'path editor'
    });
  }

  async save(...args) {
    const delegate = await this._ensureDelegate();
    return callRequiredDelegateMethod({
      delegate,
      methodName: 'save',
      args,
      loggerPrefix: 'PathManagerV2',
      logScope: 'persistence',
      bundleLabel: 'path editor'
    });
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
      editorLabel: 'Path Editor session'
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
    beginHostedToolWindowMonitor(this, {
      delegate,
      toolId,
      isHostReady: () => this._isSessionHostReady(),
      clearEditingTile: () => this._clearEditingTile(),
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
    cancelHostedToolWindowMonitor(this);
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
    return endEditingTileWithRefresh(this, {
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

  async reconcileGeneratedPathWalls({ tileIds = [] } = {}) {
    return await this._generatedWallOwnership.reconcileTileIds({
      scene: canvas?.scene,
      user: game?.user,
      tileIds
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
      'Alt+Wheel, Alt+[ / ], or Alt+Up / Down change elevation (0.001; add Shift for 0.1).',
      'Ctrl/Cmd+Alt+Wheel moves the preview one layer through the current depth level.',
      'Press Ctrl/Cmd+S to commit; tap S toggles grid snap and S + wheel changes subgrid density; ESC cancels.'
    ];
    let delegateState = {};
    let handlers = {};
    const delegate = this._delegate;
    if (delegate) {
      const descriptor = callRequiredDelegateMethod({
        delegate,
        methodName: 'getToolOptionsDescriptor',
        loggerPrefix: 'PathManagerV2',
        logScope: 'toolOptionsDescriptor',
        bundleLabel: 'path editor'
      });
      if (!descriptor || typeof descriptor !== 'object') {
        Logger.error?.('PathManagerV2.toolOptionsDescriptor.invalidDescriptor', {
          descriptorType: typeof descriptor
        });
        throw new Error('Path editor bundle returned invalid tool-options descriptor.');
      }
      if (descriptor.state && typeof descriptor.state === 'object') delegateState = descriptor.state;
      if (descriptor.handlers && typeof descriptor.handlers === 'object') handlers = descriptor.handlers;
    }
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
    const hostState = this._getPreviewLayerHostState();
    const previewState = {
      active: !!hostState?.active,
      elevation: Number.isFinite(hostState?.elevation) ? Number(hostState.elevation) : null,
      sort: Number.isFinite(hostState?.sort) ? Number(hostState.sort) : null,
      activePathId: hostState?.activePathId || null,
      mode: descriptor?.descriptor?.activeMode || null
    };
    notifyHostedPreviewLayerChangeIfNeeded({
      previewState,
      source,
      force,
      lastSignature: this._lastPreviewLayerSignature,
      setLastSignature: (signature) => { this._lastPreviewLayerSignature = signature; },
      loggerPrefix: 'PathManagerV2'
    });
  }

  async prepareEditingTileExit() {
    const result = this._clearEditingTile();
    if (result?.refreshPromise) await result.refreshPromise;
    return {
      tileId: result?.tileId || null,
      refreshed: !!result?.refreshPromise
    };
  }

  _callRequiredPreviewPlacementDelegateMethod(methodName, args = []) {
    return callRequiredPreviewPlacementAdapterMethod({
      delegate: this._delegate,
      adapterKind: 'path',
      methodName,
      args,
      loggerPrefix: 'PathManagerV2',
      bundleLabel: 'path editor'
    });
  }

  _getPreviewLayerHostState() {
    if (!this._delegate) {
      return { active: false, elevation: null, sort: null, activePathId: null };
    }
    return this._callRequiredPreviewPlacementDelegateMethod('getPreviewLayerHostState');
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
    this._callRequiredPreviewPlacementDelegateMethod('applyLaunchPlacementAnchorTileId', [anchorTileId]);
    Logger.debug?.('PathManagerV2.sortAnchor.launchApply', { anchorTileId });
    return anchorTileId;
  }

  _syncDelegatePreviewRenderSort() {
    if (!this._delegate) return null;
    return this._callRequiredPreviewPlacementDelegateMethod('syncPreviewRenderSort', [{
      editingTileId: this._editingTileId || null
    }]);
  }

  _applyPathPreviewPlacementMetadata() {
    if (!this._delegate) return false;
    return this._callRequiredPreviewPlacementDelegateMethod('applyPathPreviewPlacementMetadata');
  }

  _applyCurrentPreviewLayerOrdering() {
    if (!this._delegate) return false;
    return this._callRequiredPreviewPlacementDelegateMethod('applyCurrentPreviewLayerOrdering');
  }

  /**
   * A Path belongs to the Level it is drawn on: its Foundry Walls are created
   * there. Its preview is not moved to an Elevation of another Level.
   */
  canApplyLayerManagerPreviewLevel({ placementLevelId = undefined } = {}) {
    const targetLevelId = String(placementLevelId || '').trim();
    if (!targetLevelId) return true;
    return getCurrentViewedLevelIds(canvas?.scene).includes(targetLevelId);
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
    if (!this._delegate) return false;
    const changed = !!this._callRequiredPreviewPlacementDelegateMethod('applyLayerManagerPreviewPlacement', [{
      elevation,
      sort,
      previewSort,
      previewId,
      previewKey,
      anchorTileId,
      sortBefore
    }]);
    if (!changed) return false;
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
    if (!this._delegate) return false;
    const selected = !!this._callRequiredPreviewPlacementDelegateMethod('selectLayerManagerPreview', [{
      previewId,
      previewKey,
      elevation
    }]);
    if (!selected) {
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

  _buildToolOptionsDescriptor() {
    const { state: legacyState, handlers } = this._buildToolOptionsState();
    const hostState = this._getPreviewLayerHostState();
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
          description: 'Adjust tile elevation by 0.001; add Shift for 0.1.'
        }),
        createShortcut('adjust-layer-order-wheel', {
          binding: 'Ctrl/Cmd+Alt+Wheel',
          label: 'Layer Order',
          description: 'Move the preview one layer up or down within the current depth level.'
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
        selectionSummary: hostState?.activePathId
          ? `Editing path ${hostState.activePathId}`
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
        previewElevation: Number.isFinite(hostState?.elevation) ? Number(hostState.elevation) : 0,
        editShapesMode: !!hostState?.editShapesMode,
        activePathId: hostState?.activePathId || null
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
    const addHintControl = (config) => addDeclarativeHintControl(controls, config);
    const addRangeControl = (config) => addDeclarativeRangeControl(controls, config, {
      includeHandlerArg: true,
      includeHeaderToggle: true
    });
    const addRangePairControl = (config) => addDeclarativeRangePairControl(controls, config);
    const addToggleControl = (config) => addDeclarativeToggleControl(controls, config, {
      includeHandlerArg: true
    });
    const addAxisTogglePairControl = (config) => addDeclarativeAxisTogglePairControl(controls, config);
    const addToggleListControl = (config) => addDeclarativeToggleListControl(controls, config);
    const addActionRowControl = (config) => addDeclarativeActionRowControl(controls, config);

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
      modeSectionControlIds.push(addToggleListControl({
        id: 'path-mode-options',
        items: subtoolOptions
      }));
    }

    // What the Foundry Walls of the path block: the presets the walls of a Building have. Always laid out, and
    // greyed out while "Foundry Walls" is off, so the panel keeps its shape when the toggle or the selected
    // path changes (values are synced in place; a new control would need a new layout).
    const wallBehavior = legacyState?.wallBehavior;
    if (wallBehavior && typeof wallBehavior === 'object') {
      const chosen = normalizePathWallBehavior(wallBehavior.value);
      const wallsOn = !!wallBehavior.available;
      controls['path-wall-behavior'] = {
        id: 'path-wall-behavior',
        type: 'segmented',
        variant: 'construction-mode',
        handlerId: 'setWallBehavior',
        options: PATH_WALL_BEHAVIORS.map((name) => ({
          id: name,
          label: name,
          enabled: name === chosen,
          disabled: !wallsOn || !!wallBehavior.disabled,
          tooltip: wallsOn ? PATH_WALL_BEHAVIOR_TOOLTIPS[name] : PATH_WALL_BEHAVIOR_OFF_TOOLTIP
        }))
      };
      modeSectionControlIds.push('path-wall-behavior');
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
      sections.push({
        id: 'session',
        label: 'Session',
        region: 'footer',
        collapsible: false,
        controls: [addActionRowControl({
          id: 'path-session-actions',
          actions: editorActions
        })]
      });
    }

    return { controls, sections };
  }

}

export default PathManagerV2;
