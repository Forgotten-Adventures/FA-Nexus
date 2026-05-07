import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  resolveTileId,
  resolveTilePlaceable
} from '../premium/session-host/editing-targets.js';
import { resolvePremiumFeatureDelegate } from '../premium/session-host/delegate-bootstrap.js';
import {
  buildHostedSessionContextDetails,
  canRecoverHostedSessionFromCanvasTeardown,
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
  canCommitHostedSession,
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
import {
  getCurrentLevelBottomElevation,
  getCurrentSceneLevel,
  getGroundBandRenderSort,
  getHighestControlledTileElevation,
  getTileRenderElevation,
  resolvePlacementAnchorTile
} from '../canvas/elevation-band-utils.js';
import {
  getDefaultTilePlacementLevelId,
  resolveTileRenderOrder
} from '../canvas/tile-band-utils.js';
import { resolvePlacementSortAtElevation } from '../canvas/canvas-interaction-controller.js';
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
const CANVAS_REBIND_TIMEOUT_MS = 15000;
const HOST_CONTEXT_GRACE_MS = 5000;
const PREVIEW_LAYER_HOOK = 'fa-nexus-preview-layers-changed';

function stringifyError(error) {
  return String(error?.message || error);
}

function getDocumentLevelIds(target) {
  const direct = target?.levels;
  const source = direct instanceof Set || Array.isArray(direct)
    ? Array.from(direct)
    : (target?._source?.levels || []);
  return Array.from(new Set(source
    .map((levelId) => String(levelId || '').trim())
    .filter(Boolean)));
}

export class BuildingManager {
  constructor(app) {
    this._app = app;
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._canvasRebindState = null;
    this._portalMode = false;
    this._onToolOptionsChange = null;
    this._lastPersistedSubtool = null;
    this._toolDefaultsPersistTimer = null;
    this._editingTileId = null;
    this._forcingMeasurementsEnabled = false;
    this._hsbcTarget = 'wall';
    this._lastPreviewLayerSignature = null;
    this._pendingLaunchPlacementAnchorTileId = undefined;
  }

  /**
   * Register a callback to be notified when tool options state changes.
   * Useful for updating UI elements like portal texture thumbnails.
   * @param {Function|null} callback - Callback function receiving (state, handlers)
   */
  setToolOptionsChangeCallback(callback) {
    const nextCallback = typeof callback === 'function' ? callback : null;
    this._onToolOptionsChange = nextCallback;
    return () => {
      if (!nextCallback || this._onToolOptionsChange === nextCallback) {
        this._onToolOptionsChange = null;
      }
    };
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  hasSessionChanges() {
    return hasHostedSessionChanges(this._delegate);
  }

  canCommitSession() {
    return canCommitHostedSession(this._delegate, {
      fallback: () => this.hasSessionChanges()
    });
  }

  get version() {
    return this._delegate?.version || '0.0.14';
  }

  async start(session = {}) {
    const startSession = { ...(session || {}) };
    const sceneId = String(canvas?.scene?.id || '').trim();
    if (!Object.prototype.hasOwnProperty.call(startSession, 'sceneId') && sceneId) {
      startSession.sceneId = sceneId;
    }
    if (Object.prototype.hasOwnProperty.call(startSession, 'portalMode')) {
      this._portalMode = !!startSession.portalMode;
    }
    const controlledTiles = Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : [];
    const anchorTile = resolvePlacementAnchorTile(controlledTiles);
    const anchorDoc = anchorTile?.document || anchorTile || null;
    const selectedElevation = getHighestControlledTileElevation(controlledTiles);
    const fallbackElevation = getCurrentLevelBottomElevation(canvas?.scene);
    const selectedDoc = anchorDoc;
    let placementLevels = getDocumentLevelIds(startSession);
    let placementLevelId = String(startSession.placementLevelId || '').trim();
    if (!placementLevels.length && placementLevelId) placementLevels = [placementLevelId];
    if (!placementLevels.length && selectedDoc) {
      placementLevels = getDocumentLevelIds(selectedDoc);
    }
    if (!placementLevelId && selectedDoc) {
      const selectedLevelIds = getDocumentLevelIds(selectedDoc);
      if (selectedLevelIds.length === 1) placementLevelId = selectedLevelIds[0];
    }
    if (!placementLevelId) {
      placementLevelId = String(getCurrentSceneLevel(canvas?.scene)?.id || '').trim();
    }
    if (!placementLevels.length && placementLevelId) placementLevels = [placementLevelId];
    const fillAnchorElevation = Number.isFinite(selectedElevation) ? selectedElevation : fallbackElevation;
    if (!Object.prototype.hasOwnProperty.call(startSession, 'selectedElevation') && Number.isFinite(fillAnchorElevation)) {
      startSession.selectedElevation = fillAnchorElevation;
    }
    if (!Object.prototype.hasOwnProperty.call(startSession, 'fillElevation') && Number.isFinite(fillAnchorElevation)) {
      startSession.fillElevation = fillAnchorElevation;
    }
    if (!Object.prototype.hasOwnProperty.call(startSession, 'selectedSort')) {
      startSession.selectedSort = Number.isFinite(Number(anchorDoc?.sort)) ? Number(anchorDoc.sort) : null;
    }
    if (!Object.prototype.hasOwnProperty.call(startSession, 'placementAnchorElevation') && Number.isFinite(fillAnchorElevation)) {
      startSession.placementAnchorElevation = fillAnchorElevation;
    }
    if (!Object.prototype.hasOwnProperty.call(startSession, 'placementAnchorTileId')) {
      startSession.placementAnchorTileId = anchorDoc?.id || null;
    }
    this._pendingLaunchPlacementAnchorTileId = startSession.placementAnchorTileId || null;
    if (!Object.prototype.hasOwnProperty.call(startSession, 'placementLevels') && placementLevels.length) {
      startSession.placementLevels = placementLevels;
    }
    if (!Object.prototype.hasOwnProperty.call(startSession, 'placementLevelId') && placementLevelId) {
      startSession.placementLevelId = placementLevelId;
    }
    const delegate = await this._ensureDelegate();
    return runHostedSessionLaunch({
      beforeLaunch: () => {
        this._clearEditingTile();
        if (typeof delegate?.setPortalMode === 'function') {
          delegate.setPortalMode(this._portalMode);
        }
      },
      launchSession: () => delegate.start?.(startSession),
      afterLaunch: () => {
        try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
        this._applyPendingLaunchPlacementAnchorTileId();
        this._syncDelegatePreviewRenderSort();
        this._applyCurrentPreviewLayerOrdering();
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
      },
      handleLaunchFailure: (error) => this._handleSessionLaunchFailure(error, { phase: 'start' }),
      scheduleEntitlementProbe: () => this._scheduleEntitlementProbe()
    });
  }

  async editTile(tileDocument, options = {}) {
    if (Object.prototype.hasOwnProperty.call(options || {}, 'portalMode')) {
      this._portalMode = !!options.portalMode;
    }
    const editOptions = { ...(options || {}) };
    const sceneId = String(canvas?.scene?.id || '').trim();
    if (!Object.prototype.hasOwnProperty.call(editOptions, 'sceneId') && sceneId) {
      editOptions.sceneId = sceneId;
    }
    const doc = tileDocument?.document || tileDocument || null;
    const documentLevelIds = getDocumentLevelIds(doc);
    if (!Object.prototype.hasOwnProperty.call(editOptions, 'placementLevels') && documentLevelIds.length) {
      editOptions.placementLevels = documentLevelIds;
    }
    if (!Object.prototype.hasOwnProperty.call(editOptions, 'placementLevelId') && documentLevelIds.length === 1) {
      editOptions.placementLevelId = documentLevelIds[0];
    }
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed building editor bundle does not support editing existing tiles.');
    }
    const tileId = resolveTileId(tileDocument);
    return runHostedSessionLaunch({
      beforeLaunch: () => {
        this._markEditingTile(tileDocument);
        if (typeof delegate?.setPortalMode === 'function') {
          delegate.setPortalMode(this._portalMode);
        }
      },
      launchSession: () => delegate.editTile(tileDocument, editOptions),
      afterLaunch: () => {
        try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
        this._syncDelegatePreviewRenderSort();
        this._applyCurrentPreviewLayerOrdering();
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
      },
      handleLaunchFailure: (error) => this._handleSessionLaunchFailure(error, {
        phase: 'edit',
        tileId
      }),
      scheduleEntitlementProbe: () => this._scheduleEntitlementProbe()
    });
  }

  async _handleSessionLaunchFailure(error, { phase = 'start', tileId = null } = {}) {
    return handleHostedSessionLaunchFailure({
      error,
      phase,
      loggerPrefix: 'BuildingManager',
      details: buildHostedSessionContextDetails({
        app: this._app,
        delegate: this._delegate,
        tileId: tileId || this._editingTileId || null
      }),
      cancelToolWindowMonitor: () => this._cancelToolWindowMonitor(),
      stopSession: ({ reason }) => this.stop({ reason }),
      onFallbackCleanup: () => {
        this._clearEditingTile();
        try { toolOptionsController.deactivateTool(FEATURE_ID); } catch (_) {}
      }
    });
  }

  _isEditorHostReady() {
    return isApplicationHostReady(this._app);
  }

  _stopOrphanedSession({ reason = 'host-context-unavailable' } = {}) {
    return stopHostedOrphanedSession({
      reason,
      loggerPrefix: 'BuildingManager',
      details: buildHostedSessionContextDetails({
        app: this._app,
        delegate: this._delegate,
        includeAppState: true,
        tileId: this._editingTileId || null
      }),
      cancelToolWindowMonitor: () => this._cancelToolWindowMonitor(),
      stopSession: ({ reason: stopReason }) => this.stop({ reason: stopReason }),
      onFallbackCleanup: () => {
        this._clearEditingTile();
        try { toolOptionsController.deactivateTool(FEATURE_ID); } catch (_) {}
      }
    });
  }

  async updateWallPath(options = {}) {
    return this._callRequiredDelegateMethod('updateWallPath', 'updateWallPath', {
      args: [options],
      context: { options },
      missingReturn: null,
      rethrow: true
    });
  }

  async updateFillTexture(options = {}) {
    return this._callRequiredDelegateMethod('updateFillTexture', 'updateFillTexture', {
      args: [options],
      context: { options },
      missingReturn: null,
      rethrow: true
    });
  }

  switchActiveMode(mode) {
    if (!this._delegate?.isActive) return;
    const call = this._callOptionalDelegateMethod('switchActiveMode', 'switchActiveMode', {
      args: [mode],
      context: { mode },
      failureReturn: null
    });
    if (!call.ok) return call.result;
    // If the delegate returns a promise (async switch), wait before refreshing UI.
    Promise.resolve(call.result).finally(() => {
      this._syncToolOptionsState({ suppressRender: false });
    });
    return call.result;
  }

  setActiveTool(toolId) {
    if (!this._delegate?.isActive) return;
    const call = this._callOptionalDelegateMethod('setActiveTool', 'setActiveTool', {
      args: [toolId],
      context: { toolId }
    });
    if (call.ok) this._syncToolOptionsState({ suppressRender: false });
  }

  setPortalMode(enabled = false) {
    this._portalMode = !!enabled;
    this._callOptionalDelegateMethod('setPortalMode', 'setPortalMode', {
      args: [this._portalMode],
      context: { enabled }
    });
    this._syncToolOptionsState({ suppressRender: false });
    return this._portalMode;
  }

  forceExitPortalEditing() {
    this._callOptionalDelegateMethod('forceExitPortalEditing', 'exitPortalEditingAllSessions');
    this._portalMode = false;
    this._syncToolOptionsState({ suppressRender: false });
  }

  stop(...args) {
    return stopSessionWithFinalize({
      delegate: this._delegate,
      beforeStop: () => {
        this._cancelToolWindowMonitor();
        this._clearCanvasRebindState();
        toolOptionsController.deactivateTool(FEATURE_ID);
      },
      persistToolDefaults: () => this._persistDelegateToolDefaults(),
      stopSession: (delegate) => {
        const stopFn = delegate?.__faNexusOriginalStop || delegate?.stop;
        return stopFn?.(...args);
      },
      finalize: () => {
        try { this._clearEditingTile(); } catch (_) {}
      },
      onStopError: (error) => {
        Logger.warn?.('BuildingManager.stop.failed', { error: String(error?.message || error) });
      }
    });
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
    if (this._delegate) {
      this._installDelegatePreviewOrderingGuard(this._delegate);
      return this._delegate;
    }
    if (this._loading) return this._loading;
    this._loading = resolvePremiumFeatureDelegate({
      featureId: FEATURE_ID,
      app: this._app,
      host: this,
      assignDelegate: (instance) => {
        this._delegate = instance;
      },
      missingMessage: 'Premium building editor bundle missing BuildingManager implementation',
      loadedLogName: 'BuildingEditor.bundle.loaded',
      loadedHookName: 'fa-nexus-building-editor-loaded',
      fallbackVersion: '0.0.14',
      afterAttach: (instance) => {
        try { this._installCanvasRebindGuard(instance); }
        catch (error) {
          Logger.error?.('BuildingManager.canvasRebindGuard.installFailed', {
            error: String(error?.message || error)
          });
        }
        try { this._installDelegatePreviewOrderingGuard(instance); }
        catch (error) {
          Logger.error?.('BuildingManager.previewOrderingGuard.installFailed', {
            error: String(error?.message || error)
          });
        }
        try {
          if (typeof instance.setPortalMode === 'function') {
            instance.setPortalMode(this._portalMode);
          }
        } catch (_) {}
      }
    });
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  }

  async _callRequiredDelegateMethod(action, methodName, {
    args = [],
    context = {},
    missingReturn = null,
    rethrow = false
  } = {}) {
    const delegate = await this._ensureDelegate();
    const details = context && typeof context === 'object' ? context : {};
    if (!delegate) {
      Logger.warn?.(`BuildingManager.${action}.delegateMissing`, details);
      return missingReturn;
    }
    const method = delegate?.[methodName];
    if (typeof method !== 'function') {
      Logger.warn?.(`BuildingManager.${action}.methodMissing`, details);
      return missingReturn;
    }
    try {
      return await method.call(delegate, ...(Array.isArray(args) ? args : []));
    } catch (error) {
      Logger.warn?.(`BuildingManager.${action}.failed`, {
        error: stringifyError(error),
        ...details
      });
      if (rethrow) throw error;
      return missingReturn;
    }
  }

  _callOptionalDelegateMethod(action, methodName, {
    args = [],
    context = {},
    failureReturn = undefined
  } = {}) {
    const delegate = this._delegate;
    const method = delegate?.[methodName];
    if (typeof method !== 'function') return { ok: true, result: undefined };
    try {
      return {
        ok: true,
        result: method.call(delegate, ...(Array.isArray(args) ? args : []))
      };
    } catch (error) {
      Logger.warn?.(`BuildingManager.${action}.failed`, {
        error: stringifyError(error),
        ...(context && typeof context === 'object' ? context : {})
      });
      return { ok: false, result: failureReturn, error };
    }
  }

  _scheduleEntitlementProbe() {
    return scheduleEntitlementRevalidation(this, {
      featureId: FEATURE_ID,
      revalidateReason: 'building-edit:revalidate',
      onFailure: (error) => this._handleEntitlementFailure(error)
    });
  }

  async _handleEntitlementFailure(error) {
    return handleEntitlementRevalidationFailure({
      error,
      featureId: FEATURE_ID,
      loggerPrefix: 'BuildingManager',
      clearReason: 'building-revalidate-failed',
      warningMessage: 'Authentication expired - premium building editing has been disabled. Please reconnect Patreon.',
      stopSession: () => this.stop?.(),
      resetState: () => {
        this._delegate = null;
      }
    });
  }

  _installCanvasRebindGuard(delegate) {
    if (!delegate || delegate.__faNexusCanvasRebindGuardInstalled) return;
    const originalStop = typeof delegate.stop === 'function' ? delegate.stop.bind(delegate) : null;
    if (!originalStop) return;
    Object.defineProperty(delegate, '__faNexusOriginalStop', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: originalStop
    });
    delegate.stop = (...args) => {
      if (this._shouldRecoverFromCanvasTeardown(delegate, args)) {
        return this._handleCanvasTeardownRecovery(delegate);
      }
      this._clearCanvasRebindState({ delegate });
      return originalStop(...args);
    };
    Object.defineProperty(delegate, '__faNexusCanvasRebindGuardInstalled', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: true
    });
  }

  _shouldRecoverFromCanvasTeardown(delegate, args = []) {
    if (!delegate?.isActive) return false;
    if (Array.isArray(args) && args.length) return false;
    const existing = this._canvasRebindState;
    if (existing?.delegate === delegate) return true;
    return canRecoverHostedSessionFromCanvasTeardown(this._app);
  }

  _clearCanvasRebindState({ delegate = null } = {}) {
    const state = this._canvasRebindState;
    if (!state) return;
    if (delegate && state.delegate && state.delegate !== delegate) return;
    this._canvasRebindState = null;
    if (state.timeoutId != null) {
      try { clearTimeout(state.timeoutId); } catch (_) {}
    }
    if (state.readyHook && Hooks?.off) {
      try { Hooks.off('canvasReady', state.readyHook); } catch (_) {}
    }
  }

  _handleCanvasTeardownRecovery(delegate) {
    const existing = this._canvasRebindState;
    if (existing?.delegate === delegate) return existing.promise;
    this._clearCanvasRebindState({ delegate });
    this._cancelToolWindowMonitor();
    const expectedSceneId = String(delegate?._session?.sceneId || canvas?.scene?.id || '').trim();
    Logger.warn?.('BuildingManager.session.canvasTeardownIntercepted', buildHostedSessionContextDetails({
      app: this._app,
      delegate,
      includeAppState: true,
      extra: {
        expectedSceneId: expectedSceneId || null
      }
    }));
    try { delegate._removeInteractionHandlers?.(); } catch (_) {}
    try { delegate._clearDebugPreview?.(); } catch (_) {}
    try { delegate._destroyOverlayLayer?.(); } catch (_) {}

    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    const finish = (value) => {
      this._clearCanvasRebindState({ delegate });
      resolvePromise?.(value);
      return value;
    };

    const stopDelegate = async (reason, error = null) => {
      if (error) {
        Logger.error?.('BuildingManager.session.canvasTeardownRecoveryFailed', {
          reason,
          expectedSceneId: expectedSceneId || null,
          error: String(error?.message || error)
        });
      } else {
        Logger.warn?.('BuildingManager.session.canvasTeardownRecoveryAborted', {
          reason,
          expectedSceneId: expectedSceneId || null
        });
      }
      const stopFn = delegate?.__faNexusOriginalStop || delegate?.stop;
      try {
        await Promise.resolve(stopFn?.({ reason }));
      } catch (stopError) {
        Logger.error?.('BuildingManager.session.canvasTeardownRecoveryStopFailed', {
          reason,
          expectedSceneId: expectedSceneId || null,
          error: String(stopError?.message || stopError)
        });
      }
      return finish(false);
    };

    const resume = async () => {
      if (!delegate?.isActive) {
        return finish(false);
      }
      const resumedSceneId = String(canvas?.scene?.id || '').trim();
      if (expectedSceneId && resumedSceneId && expectedSceneId !== resumedSceneId) {
        return stopDelegate('scene-changed-during-canvas-rebind');
      }
      if (!this._isEditorHostReady()) {
        return stopDelegate('canvas-rebind-host-not-ready');
      }
      try {
        delegate._installInteractionHandlers?.();
        delegate._ensureOverlayLayer?.();
        delegate._updateWallTexturePreview?.();
        delegate._updateFillTexturePreview?.();
        delegate._updateShadowPreview?.();
        delegate._updateDoorFramePreview?.();
        delegate._updateWindowPreview?.();
        if (delegate._shapeEditMode) delegate._refreshShapeEditState?.({ immediate: true });
        if (delegate._gapEditMode) delegate._refreshGapOverlay?.();
        if (delegate._pointEditMode) {
          delegate._refreshPointHandles?.();
          delegate._updateEditOverlayVisibility?.();
        }
        this._syncToolOptionsState({
          suppressRender: false,
          suppressSubtoolPersistence: true,
          suppressToolDefaultsPersistence: true
        });
        this._beginToolWindowMonitor(delegate);
        Logger.warn?.('BuildingManager.session.canvasTeardownRecovered', buildHostedSessionContextDetails({
          app: this._app,
          delegate,
          extra: {
            expectedSceneId: expectedSceneId || null,
            resumedSceneId: resumedSceneId || null
          }
        }));
        return finish(true);
      } catch (error) {
        return stopDelegate('canvas-rebind-resume-failed', error);
      }
    };

    const readyHook = () => {
      Promise.resolve(resume()).catch((error) => {
        stopDelegate('canvas-rebind-ready-hook-threw', error).catch?.(() => {});
      });
    };

    const timeoutId = setTimeout(() => {
      Promise.resolve(stopDelegate('canvas-rebind-timeout')).catch(() => {});
    }, CANVAS_REBIND_TIMEOUT_MS);

    this._canvasRebindState = {
      delegate,
      expectedSceneId,
      promise,
      readyHook,
      timeoutId
    };
    try { Hooks?.on?.('canvasReady', readyHook); } catch (_) {}
    return promise;
  }

  _beginToolWindowMonitor(delegate) {
    this._cancelToolWindowMonitor();
    if (!delegate) return;
    this._toolMonitor = startHostedToolWindowMonitor({
      delegate,
      toolId: FEATURE_ID,
      isHostReady: () => this._isEditorHostReady(),
      clearEditingTile: () => this._clearEditingTile(),
      cancelMonitor: () => this._cancelToolWindowMonitor(),
      deactivateBeforeCancel: false,
      stopOrphanedSession: (details) => this._stopOrphanedSession(details),
      hostFailureGraceMs: HOST_CONTEXT_GRACE_MS,
      onHostFirstUnavailable: ({ durationMs }) => {
        Logger.warn?.('BuildingManager.session.hostTransientlyUnavailable', buildHostedSessionContextDetails({
          app: this._app,
          delegate,
          includeAppState: true,
          tileId: this._editingTileId || null,
          extra: {
            durationMs
          }
        }));
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
      monitorSyncLoggerPrefix: 'BuildingManager'
    });
  }

  _cancelToolWindowMonitor() {
    this._toolMonitor = cancelToolWindowMonitor(this._toolMonitor);
  }

  _markEditingTile(targetTile) {
    try {
      const { tileId, tile } = beginEditingTileTracking(this, {
        target: targetTile,
        sharedSetKey: EDITING_TILE_SET_KEY,
        onReplace: () => this._clearEditingTile()
      });
      if (!tileId) return;
      if (tile) {
        applyBuildingTile(tile);
        applyDoorFrameTile(tile);
      }
    } catch (_) {}
  }

  _clearEditingTile() {
    const refreshJobs = [];
    const { tileId, refreshPromise } = endEditingTileWithRefresh(this, {
      sharedSetKey: EDITING_TILE_SET_KEY,
      loggerPrefix: 'BuildingManager',
      collectRefreshJobs: ({ tile }) => {
        refreshJobs.push(Promise.resolve(applyBuildingTile(tile)));
        refreshJobs.push(Promise.resolve(applyDoorFrameTile(tile)));
        return refreshJobs;
      }
    });
    this._refreshExitedEditTile(tileId, refreshPromise || (refreshJobs.length ? Promise.allSettled(refreshJobs) : null));
    return tileId;
  }

  _refreshExitedEditTile(tileId = null, waitFor = null) {
    if (!tileId) return;
    const refresh = () => {
      try {
        const tile = resolveTilePlaceable(null, tileId);
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
    } catch (error) {
      Logger.warn?.('BuildingManager.toolOptionsState.delegateFailed', { error: stringifyError(error) });
    }
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

  _notifyPreviewLayerChangeIfNeeded(descriptor = null, { force = false, source = 'building-preview' } = {}) {
    const customToggles = Array.isArray(descriptor?.legacyState?.customToggles)
      ? descriptor.legacyState.customToggles
        .filter((toggle) => String(toggle?.group || '') === 'placement')
        .map((toggle) => ({ id: String(toggle?.id || ''), enabled: !!toggle?.enabled }))
      : [];
    const fillElevation = Number(descriptor?.legacyState?.fillElevation?.value ?? NaN);
    const previewState = {
      active: !!this._delegate?.isActive,
      elevation: Number.isFinite(this._delegate?._previewElevation) ? Number(this._delegate._previewElevation) : null,
      fillElevation: Number.isFinite(fillElevation) ? fillElevation : null,
      sort: Number.isFinite(this._delegate?._previewSort) ? Number(this._delegate._previewSort) : null,
      portalMode: !!this._portalMode,
      placementToggles: customToggles
    };
    const signature = JSON.stringify(previewState);
    if (!force && signature === this._lastPreviewLayerSignature) return;
    this._lastPreviewLayerSignature = signature;
    try { Hooks?.callAll?.(PREVIEW_LAYER_HOOK, { source, previewState }); } catch (_) {}
  }

  _getLayerManagerPreviewPlacementStore() {
    const delegate = this._delegate;
    if (!delegate) return null;
    if (!delegate.__faNexusLayerManagerPreviewPlacement || typeof delegate.__faNexusLayerManagerPreviewPlacement !== 'object') {
      try {
        Object.defineProperty(delegate, '__faNexusLayerManagerPreviewPlacement', {
          configurable: true,
          enumerable: false,
          writable: true,
          value: {}
        });
      } catch (_) {
        delegate.__faNexusLayerManagerPreviewPlacement = {};
      }
    }
    return delegate.__faNexusLayerManagerPreviewPlacement;
  }

  _rememberLayerManagerPreviewPlacement({
    previewKind = 'building-preview',
    elevation = undefined,
    sort = undefined,
    previewSort = undefined,
    placementLevelId = undefined,
    anchorTileId = undefined,
    sortBefore = undefined
  } = {}) {
    const delegate = this._delegate;
    const store = this._getLayerManagerPreviewPlacementStore();
    if (!delegate || !store) return null;
    const targetIsFill = previewKind === 'building-fill-preview';
    const key = targetIsFill ? 'fill' : 'wall';
    const currentElevation = targetIsFill
      ? Number(delegate._fillElevation ?? NaN)
      : Number(delegate._previewElevation ?? NaN);
    const currentSort = targetIsFill
      ? Number(delegate._fillPreviewSort ?? NaN)
      : Number(delegate._previewSort ?? NaN);
    const currentPreviewSort = targetIsFill
      ? Number(delegate._fillPreviewRenderSort ?? NaN)
      : Number(delegate._previewRenderSort ?? NaN);
    const nextElevation = Number.isFinite(Number(elevation))
      ? Number(elevation)
      : currentElevation;
    const nextSort = Number.isFinite(Number(sort))
      ? Number(sort)
      : currentSort;
    const nextPreviewSort = Number.isFinite(Number(previewSort))
      ? Number(previewSort)
      : (Number.isFinite(currentPreviewSort) ? currentPreviewSort : nextSort);
    if (!Number.isFinite(nextElevation) || !Number.isFinite(nextSort)) return null;
    store[key] = {
      previewKind: targetIsFill ? 'building-fill-preview' : 'building-preview',
      elevation: nextElevation,
      sort: nextSort,
      previewSort: Number.isFinite(nextPreviewSort) ? nextPreviewSort : nextSort,
      placementLevelId: placementLevelId !== undefined
        ? (String(placementLevelId || '').trim() || null)
        : (String(delegate?._session?.placementLevelId || '').trim() || null),
      anchorTileId: anchorTileId !== undefined
        ? (String(anchorTileId || '').trim() || null)
        : (String(delegate?._placementSortAnchorTileId || '').trim() || null),
      sortBefore: sortBefore !== undefined
        ? sortBefore === true
        : delegate?._placementSortBeforeAnchor === true
    };
    return store[key];
  }

  _reassertLayerManagerPreviewPlacement(previewKind = 'building-preview', { source = 'building-preview-ordering-guard' } = {}) {
    const delegate = this._delegate;
    const store = delegate?.__faNexusLayerManagerPreviewPlacement || null;
    if (!delegate || !store) return false;
    const targetIsFill = previewKind === 'building-fill-preview';
    const key = targetIsFill ? 'fill' : 'wall';
    const placement = store[key] || null;
    if (!placement) return false;
    const currentElevation = targetIsFill
      ? Number(delegate._fillElevation ?? NaN)
      : Number(delegate._previewElevation ?? NaN);
    const storedElevation = Number(placement.elevation);
    if (!Number.isFinite(currentElevation) || !Number.isFinite(storedElevation) || Math.abs(currentElevation - storedElevation) > 0.0005) {
      delete store[key];
      Logger.debug?.('BuildingManager.previewOrderingGuard.cleared', {
        previewKind: placement.previewKind || previewKind,
        source,
        currentElevation: Number.isFinite(currentElevation) ? currentElevation : null,
        storedElevation: Number.isFinite(storedElevation) ? storedElevation : null
      });
      return false;
    }
    const nextSort = Number(placement.sort);
    const nextPreviewSort = Number(placement.previewSort);
    if (!Number.isFinite(nextSort)) return false;
    try {
      if (targetIsFill) {
        delegate._fillPreviewSort = nextSort;
        delegate._fillPreviewRenderSort = Number.isFinite(nextPreviewSort) ? nextPreviewSort : nextSort;
      } else {
        delegate._previewSort = nextSort;
        delegate._previewRenderSort = Number.isFinite(nextPreviewSort) ? nextPreviewSort : nextSort;
      }
    } catch (_) {}
    this._applyCurrentPreviewLayerOrdering({
      fillElevation: targetIsFill ? storedElevation : null,
      fillSort: targetIsFill ? nextSort : null,
      ensurePreviewLayer: false,
      ensureFillLayer: false
    });
    this._notifyPreviewLayerChangeIfNeeded(null, { force: true, source });
    return true;
  }

  _installDelegatePreviewOrderingGuard(delegate) {
    if (!delegate || delegate.__faNexusPreviewOrderingGuardInstalled) return;
    const originalPreviewOrdering = typeof delegate._syncPreviewOrdering === 'function'
      ? delegate._syncPreviewOrdering
      : null;
    const originalFillOrdering = typeof delegate._syncFillPreviewLayerOrdering === 'function'
      ? delegate._syncFillPreviewLayerOrdering
      : null;
    if (!originalPreviewOrdering && !originalFillOrdering) return;

    if (originalPreviewOrdering) {
      const manager = this;
      delegate._syncPreviewOrdering = function faNexusGuardedSyncPreviewOrdering(...args) {
        const result = originalPreviewOrdering.apply(this, args);
        manager._reassertLayerManagerPreviewPlacement('building-preview', {
          source: 'building-preview-ordering-guard'
        });
        return result;
      };
    }

    if (originalFillOrdering) {
      const manager = this;
      delegate._syncFillPreviewLayerOrdering = function faNexusGuardedSyncFillPreviewLayerOrdering(...args) {
        const result = originalFillOrdering.apply(this, args);
        manager._reassertLayerManagerPreviewPlacement('building-fill-preview', {
          source: 'building-fill-preview-ordering-guard'
        });
        return result;
      };
    }

    try {
      Object.defineProperty(delegate, '__faNexusPreviewOrderingGuardInstalled', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: true
      });
    } catch (_) {
      delegate.__faNexusPreviewOrderingGuardInstalled = true;
    }
  }

  _applyPendingLaunchPlacementAnchorTileId() {
    if (this._pendingLaunchPlacementAnchorTileId === undefined) return null;
    const anchorTileId = this._pendingLaunchPlacementAnchorTileId || null;
    this._pendingLaunchPlacementAnchorTileId = undefined;
    if (!this._delegate) return anchorTileId;
    try { this._delegate._placementSortAnchorTileId = anchorTileId; } catch (_) {}
    try { this._delegate._placementSortBeforeAnchor = false; } catch (_) {}
    const session = this._delegate._session && typeof this._delegate._session === 'object'
      ? this._delegate._session
      : (this._delegate._session = {});
    session.placementAnchorTileId = anchorTileId;
    Logger.debug?.('BuildingManager.sortAnchor.launchApply', { anchorTileId });
    return anchorTileId;
  }

  _syncDelegatePreviewRenderSort() {
    const delegate = this._delegate;
    if (!delegate) return null;
    const currentPlacementSort = Number(delegate?._previewSort ?? 0);
    if (this._editingTileId) {
      const resolvedSort = Number.isFinite(currentPlacementSort) ? currentPlacementSort : 0;
      try { delegate._previewRenderSort = resolvedSort; } catch (_) {}
      return resolvedSort;
    }
    const elevation = Number(delegate?._previewElevation ?? delegate?._fillElevation ?? 0);
    const resolved = resolvePlacementSortAtElevation(Number.isFinite(elevation) ? elevation : 0, {
      anchorTileId: delegate?._placementSortAnchorTileId,
      sortBefore: delegate?._placementSortBeforeAnchor === true,
      scene: canvas?.scene,
      count: 1
    });
    const placementSort = Number(resolved?.sort ?? currentPlacementSort);
    if (Number.isFinite(placementSort) && Number.isFinite(currentPlacementSort) && Math.abs(placementSort - currentPlacementSort) > 0.000001) {
      Logger.debug?.('BuildingManager.previewSort.launchResolved', {
        previousSort: currentPlacementSort,
        resolvedSort: placementSort,
        elevation: Number.isFinite(elevation) ? elevation : 0,
        anchorTileId: delegate?._placementSortAnchorTileId || null
      });
      try { delegate._previewSort = placementSort; } catch (_) {}
    }
    const renderSort = Number(resolved?.previewSort ?? placementSort);
    const nextRenderSort = Number.isFinite(renderSort)
      ? renderSort
      : (Number.isFinite(placementSort) ? placementSort : 0);
    try { delegate._previewRenderSort = nextRenderSort; } catch (_) {}
    this._rememberLayerManagerPreviewPlacement({
      previewKind: 'building-preview',
      elevation,
      sort: placementSort,
      previewSort: nextRenderSort,
      placementLevelId: delegate?._session?.placementLevelId,
      anchorTileId: delegate?._placementSortAnchorTileId,
      sortBefore: delegate?._placementSortBeforeAnchor === true
    });
    if (Number.isFinite(Number(delegate?._fillPreviewSort)) && !Number.isFinite(Number(delegate?._fillPreviewRenderSort))) {
      try { delegate._fillPreviewRenderSort = Number(delegate._fillPreviewSort); } catch (_) {}
    }
    return nextRenderSort;
  }

  _applyCurrentPreviewLayerOrdering({
    fillElevation = null,
    fillSort = null,
    ensurePreviewLayer = true,
    ensureFillLayer = true
  } = {}) {
    const delegate = this._delegate;
    if (!delegate) return;
    const applyLayerOrdering = (layer, elevation, sort, renderSortOverride = undefined) => {
      if (!layer || layer.destroyed) return;
      const resolvedSort = Number.isFinite(Number(sort)) ? Number(sort) : 0;
      const resolvedRenderSort = Number.isFinite(Number(renderSortOverride)) ? Number(renderSortOverride) : resolvedSort;
      const resolvedElevation = Number.isFinite(Number(elevation)) ? Number(elevation) : 0;
      const placementLevelId = String(delegate?._session?.placementLevelId || getDefaultTilePlacementLevelId() || '').trim() || null;
      const renderOrder = resolveTileRenderOrder({ elevation: resolvedElevation, sort: resolvedRenderSort }, {
        elevation: resolvedElevation,
        sort: resolvedRenderSort,
        placementLevelId,
        allowCurrentLevelFallback: true
      });
      const renderSort = Number.isFinite(Number(renderOrder?.sort)) ? Number(renderOrder.sort) : resolvedRenderSort;
      const renderElevation = Number.isFinite(Number(renderOrder?.elevation)) ? Number(renderOrder.elevation) : getTileRenderElevation(resolvedElevation);
      const zIndex = Number.isFinite(Number(renderOrder?.zIndex)) ? Number(renderOrder.zIndex) : (getGroundBandRenderSort(resolvedElevation, resolvedRenderSort) !== null ? resolvedRenderSort : resolvedRenderSort);
      const sortLayer = Number.isFinite(Number(renderOrder?.sortLayer)) ? Number(renderOrder.sortLayer) : layer.sortLayer;
      try { delegate?._applyTileSortLayer?.(layer); } catch (_) {}
      try { layer.faNexusElevationDoc = resolvedElevation; } catch (_) {}
      try { layer.faNexusElevation = renderElevation; } catch (_) {}
      try { layer.faNexusPlacementLevelId = renderOrder?.placementLevelId || placementLevelId || null; } catch (_) {}
      try { layer.faNexusBandKind = renderOrder?.kind || 'normal'; } catch (_) {}
      try { layer.elevation = renderElevation; } catch (_) {}
      try { layer.faNexusSort = renderSort; } catch (_) {}
      try { layer.faNexusPlacementSort = resolvedSort; } catch (_) {}
      try { layer.faNexusPreviewSort = resolvedRenderSort; } catch (_) {}
      try { layer.sort = renderSort; } catch (_) {}
      try { layer.sortLayer = sortLayer; } catch (_) {}
      try { layer.zIndex = zIndex; } catch (_) {}
      const parent = layer.parent;
      if (!parent) return;
      try {
        if ('sortDirty' in parent) parent.sortDirty = true;
        parent.sortChildren?.();
      } catch (_) {}
    };

    const previewRenderSort = Number.isFinite(Number(delegate._previewRenderSort))
      ? Number(delegate._previewRenderSort)
      : this._syncDelegatePreviewRenderSort();
    if ((!delegate._previewLayer || delegate._previewLayer.destroyed) && ensurePreviewLayer) {
      try { delegate._ensurePreviewLayer?.(delegate._previewElevation); } catch (_) {}
    }
    if (delegate._previewLayer && !delegate._previewLayer.destroyed) {
      applyLayerOrdering(delegate._previewLayer, delegate._previewElevation, delegate._previewSort, previewRenderSort);
    }
    const storedFillSort = delegate._fillPreviewSort === null || delegate._fillPreviewSort === undefined
      ? NaN
      : Number(delegate._fillPreviewSort);
    const resolvedFillElevation = Number.isFinite(Number(fillElevation))
      ? Number(fillElevation)
      : Number(delegate._fillElevation ?? NaN);
    const resolvedFillSort = Number.isFinite(Number(fillSort))
      ? Number(fillSort)
      : (Number.isFinite(storedFillSort)
        ? storedFillSort
        : Number(delegate._previewSort ?? NaN));
    const resolvedFillRenderSort = Number.isFinite(Number(delegate._fillPreviewRenderSort))
      ? Number(delegate._fillPreviewRenderSort)
      : resolvedFillSort;
    if ((!delegate._fillPreviewLayer || delegate._fillPreviewLayer.destroyed) && ensureFillLayer) {
      try { delegate._ensureFillPreviewLayer?.(resolvedFillElevation); } catch (_) {}
    }
    if (delegate._fillPreviewLayer && !delegate._fillPreviewLayer.destroyed) {
      applyLayerOrdering(delegate._fillPreviewLayer, resolvedFillElevation, resolvedFillSort, resolvedFillRenderSort);
    }
  }

  applyLayerManagerPreviewPlacement({
    elevation = null,
    sort = undefined,
    previewSort = undefined,
    previewKind = 'building-preview',
    placementLevelId = undefined,
    anchorTileId = undefined,
    sortBefore = undefined
  } = {}) {
    if (!this._delegate?.isActive) return false;
    const { state, handlers } = this._buildToolOptionsState();
    let changed = false;
    const targetIsFill = previewKind === 'building-fill-preview';

    if (placementLevelId !== undefined) {
      const nextPlacementLevelId = String(placementLevelId || '').trim() || null;
      const session = this._delegate._session && typeof this._delegate._session === 'object'
        ? this._delegate._session
        : (this._delegate._session = {});
      const currentPlacementLevelId = String(session.placementLevelId || '').trim() || null;
      if (currentPlacementLevelId !== nextPlacementLevelId) {
        session.placementLevelId = nextPlacementLevelId;
        session.placementLevels = nextPlacementLevelId ? [nextPlacementLevelId] : [];
        changed = true;
      }
      for (const layer of [this._delegate._previewLayer, this._delegate._fillPreviewLayer]) {
        if (!layer || layer.destroyed) continue;
        try { layer.faNexusPlacementLevelId = nextPlacementLevelId; } catch (_) {}
      }
    }

    if (anchorTileId !== undefined) {
      const nextAnchorTileId = String(anchorTileId || '').trim() || null;
      if (String(this._delegate._placementSortAnchorTileId || '').trim() !== String(nextAnchorTileId || '').trim()) {
        this._delegate._placementSortAnchorTileId = nextAnchorTileId;
        const session = this._delegate._session && typeof this._delegate._session === 'object'
          ? this._delegate._session
          : (this._delegate._session = {});
        session.placementAnchorTileId = nextAnchorTileId;
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
      const currentElevation = targetIsFill
        ? Number(state?.fillElevation?.value ?? NaN)
        : Number(this._delegate?._previewElevation ?? NaN);
      if (!Number.isFinite(currentElevation) || currentElevation !== nextElevation) {
        const handlerId = targetIsFill ? 'setFillElevation' : 'setElevation';
        if (typeof handlers?.[handlerId] === 'function') handlers[handlerId](nextElevation, true);
        else if (!targetIsFill) this._delegate._previewElevation = nextElevation;
        changed = true;
      }
    }

    if (sort !== undefined && Number.isFinite(Number(sort))) {
      const nextSort = Number(sort);
      const previousSort = targetIsFill
        ? Number(this._delegate?._fillPreviewSort ?? NaN)
        : Number(this._delegate?._previewSort ?? NaN);
      if (previousSort !== nextSort) {
        try {
          if (targetIsFill) this._delegate._fillPreviewSort = nextSort;
          else this._delegate._previewSort = nextSort;
        } catch (_) {}
        changed = true;
      }
      const nextPreviewSort = previewSort !== undefined && Number.isFinite(Number(previewSort))
        ? Number(previewSort)
        : nextSort;
      const previousPreviewSort = targetIsFill
        ? Number(this._delegate?._fillPreviewRenderSort ?? NaN)
        : Number(this._delegate?._previewRenderSort ?? NaN);
      if (previousPreviewSort !== nextPreviewSort) {
        try {
          if (targetIsFill) this._delegate._fillPreviewRenderSort = nextPreviewSort;
          else this._delegate._previewRenderSort = nextPreviewSort;
        } catch (_) {}
        changed = true;
      }
    }

    const requestedPlacementUpdate = (
      placementLevelId !== undefined
      || anchorTileId !== undefined
      || sortBefore !== undefined
      || Number.isFinite(Number(elevation))
      || sort !== undefined
      || previewSort !== undefined
    );
    if (!changed && !requestedPlacementUpdate) return false;
    const resolvedFillElevation = previewKind === 'building-fill-preview' && Number.isFinite(Number(elevation))
      ? Number(elevation)
      : Number(state?.fillElevation?.value ?? this._delegate?._fillElevation ?? NaN);
    const resolvedFillSort = previewKind === 'building-fill-preview' && Number.isFinite(Number(sort))
      ? Number(this._delegate?._fillPreviewSort ?? sort)
      : Number(this._delegate?._fillPreviewSort ?? NaN);
    this._rememberLayerManagerPreviewPlacement({
      previewKind,
      elevation: targetIsFill
        ? resolvedFillElevation
        : Number(this._delegate?._previewElevation ?? elevation ?? NaN),
      sort: targetIsFill
        ? resolvedFillSort
        : Number(this._delegate?._previewSort ?? sort ?? NaN),
      previewSort: targetIsFill
        ? Number(this._delegate?._fillPreviewRenderSort ?? previewSort ?? NaN)
        : Number(this._delegate?._previewRenderSort ?? previewSort ?? NaN),
      placementLevelId,
      anchorTileId,
      sortBefore
    });
    this._applyCurrentPreviewLayerOrdering({ fillElevation: resolvedFillElevation, fillSort: resolvedFillSort });
    try {
      if (this._delegate?._previewLayer) this._delegate._previewLayer.faNexusPreviewActive = !targetIsFill;
      if (this._delegate?._fillPreviewLayer) this._delegate._fillPreviewLayer.faNexusPreviewActive = targetIsFill;
    } catch (_) {}
    try { this._delegate?._updateWallTexturePreview?.(); } catch (_) {}
    try { this._delegate?._updateFillTexturePreview?.(); } catch (_) {}
    try { this._delegate?._updateDoorFramePreview?.(); } catch (_) {}
    try { this._delegate?._updateWindowPreview?.(); } catch (_) {}
    this._applyCurrentPreviewLayerOrdering({
      fillElevation: resolvedFillElevation,
      fillSort: resolvedFillSort,
      ensurePreviewLayer: false,
      ensureFillLayer: false
    });
    try {
      if (this._delegate?._previewLayer) this._delegate._previewLayer.faNexusPreviewActive = !targetIsFill;
      if (this._delegate?._fillPreviewLayer) this._delegate._fillPreviewLayer.faNexusPreviewActive = targetIsFill;
    } catch (_) {}
    this._syncToolOptionsState({
      suppressRender: false,
      suppressSubtoolPersistence: true,
      suppressToolDefaultsPersistence: true
    });
    this._notifyPreviewLayerChangeIfNeeded(null, { force: true, source: 'building-preview-layer-manager' });
    return true;
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
    const descriptor = this._buildToolOptionsDescriptor();
    syncHostedToolOptions({
      toolId: FEATURE_ID,
      descriptor,
      suppressRender,
      legacyState: descriptor.legacyState,
      persistSubtoolFromState: (state) => this._persistSubtoolFromState(state),
      suppressSubtoolPersistence,
      scheduleToolDefaultsPersist: () => this._scheduleToolDefaultsPersist(),
      suppressToolDefaultsPersistence,
      beforeSync: () => this._ensureMeasurementsEnabled(),
      afterSync: ({ legacyState, handlers }) => {
        if (typeof this._onToolOptionsChange !== 'function') return;
        try {
          this._onToolOptionsChange(legacyState, handlers);
        } catch (cbError) {
          Logger.warn?.('BuildingManager.toolOptionsChangeCallback.failed', { error: String(cbError?.message || cbError) });
        }
      },
      loggerPrefix: 'BuildingManager'
    });
    this._notifyPreviewLayerChangeIfNeeded(descriptor, { source: 'building-preview' });
  }

  _persistDelegateToolDefaults() {
    const delegate = this._delegate;
    if (!delegate) return;
    if (typeof delegate._persistToolDefaults !== 'function') return;
    try {
      delegate._persistToolDefaults();
    } catch (error) {
      Logger.warn?.('BuildingManager.delegateToolDefaults.persistFailed', { error: stringifyError(error) });
    }
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
