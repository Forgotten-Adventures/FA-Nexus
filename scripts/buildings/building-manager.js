import { appendBuildingV2PortalControls, appendBuildingV2InteriorPathControls, buildingV2WindowBehaviorControls } from './v2/building-v2-tool-options.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { waitForNativeTileTransformTransactions } from '../canvas/native-tile-transform-transactions.js';
import {
  resolveTileDocument,
  resolveTileId,
  resolveTilePlaceable
} from '../premium/session-host/editing-targets.js';
import { resolvePremiumFeatureDelegate } from '../premium/session-host/delegate-bootstrap.js';
import { getPremiumRuntimeAdapter } from '../premium/session-host/premium-runtime-adapter.js';
import { callRequiredDelegateMethod } from '../premium/session-host/delegate-methods.js';
import { callRequiredPreviewPlacementAdapterMethod } from '../premium/session-host/preview-placement-adapter.js';
import {
  buildHostedSessionContextDetails,
  canRecoverHostedSessionFromCanvasTeardown,
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
  canCommitHostedSession,
  handleSessionLaunchFailure as handleHostedSessionLaunchFailure,
  hasHostedSessionChanges,
  hasHostedSessionUnresolvedTransientState,
  runHostedSessionLaunch,
  syncHostedPreviewLaunchState,
  stopSessionWithFinalize,
  stopOrphanedSession as stopHostedOrphanedSession
} from '../premium/session-host/session-lifecycle.js';
import {
  askHostedSessionExitQuestion,
  buildDiscardQuestionText,
  confirmHostedCancelSession,
  createHostedCancelSessionState
} from '../premium/session-host/cancel-session-dialog.js';
import {
  handleEntitlementRevalidationFailure,
  scheduleEntitlementRevalidation
} from '../premium/session-host/entitlement-revalidation.js';
import {
  notifyHostedPreviewLayerChangeIfNeeded,
  syncHostedToolOptions
} from '../premium/session-host/tool-options-sync.js';
import { createSubtoolPreferenceBridge } from '../premium/session-host/subtool-preference-bridge.js';
import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';
import { WALL_SNAP_SETTING_KEY } from '../core/tool-options/shared.js';
import { applyBuildingTile, applyBuildingCompositeTile, applyDoorFrameTile } from './building-tiles.js';
import { TOOL_OPTIONS_RENDERER_MODE, createNormalizedToolOptionsDescriptor } from '../core/tool-options/tool-options-descriptor.js';
import {
  addDeclarativeActionRowControl,
  addDeclarativeAxisTogglePairControl,
  addDeclarativeHintControl,
  addDeclarativeRangeControl,
  addDeclarativeRangePairControl,
  addDeclarativeScalarControl,
  addDeclarativeSelectControl,
  addDeclarativeToggleControl
} from '../core/tool-options/tool-options-control-builders.js';
import {
  SHORTCUT_ACTION,
  createShortcut,
  createStandardEditorShortcuts,
  mergeShortcutLists,
  resolveEffectivePolarity
} from '../core/editor-shortcuts.js';
import { buildHsbcToolOptionsControls } from '../core/hsbc.js';
import {
  getCurrentLevelBottomElevation,
  getCurrentLevelElevationRange,
  getCurrentSceneLevel,
  getHighestControlledTileElevation,
  resolvePlacementAnchorTile
} from '../canvas/elevation-band-utils.js';
import { requestSelectionFilterRefresh } from '../canvas/selection-filter-refresh.js';
import { PREMIUM_RUNTIME_CAPABILITY } from '../premium/session-host/runtime-adapter-factory.js';

const MODULE_ID = 'fa-nexus';
const BUILDING_SUBTOOL_SETTING_KEY = 'buildingToolActiveSubtool';
const BUILDING_PERSISTED_SUBTOOL_IDS = new Set(['rectangle', 'ellipse', 'polygon', 'inner-wall']);
// ADR 0002/0004: Edit Shapes is the sole geometry and structural-segment workspace — there is
// no Edit Points subtool and no Wall Behavior subtool to switch to.
const BUILDING_ACTIVE_SUBTOOL_IDS = new Set([
  ...BUILDING_PERSISTED_SUBTOOL_IDS,
  'edit-shapes',
  'edit-geometry'
]);
const EDITING_TILE_SET_KEY = '__faNexusBuildingEditingTileIds';

const FEATURE_ID = 'building.edit';
const TOOL_LABEL = 'Building Editor';
const BUILDING_EDITOR_ARCHITECTURE_V2 = 'building-editor-v2';
const BUILDING_EDITOR_V2_HOST = Object.freeze({
  id: 'fa-nexus.building-editor-v2-host',
  contractVersion: 1
});
const BUILDING_EDITOR_V2_RUNTIME_CAPABILITIES = Object.freeze([
  PREMIUM_RUNTIME_CAPABILITY.BUILDING_V2_GET_RUNTIME_CAPABILITIES,
  PREMIUM_RUNTIME_CAPABILITY.BUILDING_PORTAL_PICKER_GET_DEPS
]);
const CANVAS_REBIND_TIMEOUT_MS = 15000;
const HOST_CONTEXT_GRACE_MS = 5000;
const CANVAS_REBIND_GUARDS = new WeakMap();

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
    this.premiumRuntimeAdapter = getPremiumRuntimeAdapter(app);
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._canvasRebindState = null;
    this._portalMode = false;
    this._onToolOptionsChange = null;
    this._editingTileId = null;
    this._forcingMeasurementsEnabled = false;
    this._lastPreviewLayerSignature = null;
    this._pendingLaunchPlacementAnchorTileId = undefined;
    this._currentBuildingLaunchTail = null;
    this._applicationClosePending = false;
    this._applicationClosePromise = null;
    this._subtoolPreferenceBridge = createSubtoolPreferenceBridge({
      moduleId: MODULE_ID,
      settingKey: BUILDING_SUBTOOL_SETTING_KEY,
      activeSubtoolIds: BUILDING_ACTIVE_SUBTOOL_IDS,
      persistedSubtoolIds: BUILDING_PERSISTED_SUBTOOL_IDS,
      getDelegate: () => this._delegate,
      requestSubtoolToggle: (id, enabled) => {
        if (this._portalMode) return false;
        return enabled ? this.setActiveTool(id) : true;
      },
      loggerPrefix: 'BuildingManager'
    });
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

  get isCurrentBuildingEditSessionActive() {
    return this.isActive;
  }

  hasSessionChanges() {
    return hasHostedSessionChanges(this._delegate);
  }

  hasUnresolvedTransientState() {
    return hasHostedSessionUnresolvedTransientState(this._delegate, { loggerPrefix: 'BuildingManager' });
  }

  canCommitSession() {
    return canCommitHostedSession(this._delegate, { loggerPrefix: 'BuildingManager' });
  }

  get version() {
    return this._delegate?.version || null;
  }

  _serializeBuildingLaunch(operation) {
    if (typeof operation !== 'function') throw new TypeError('Building launch serialization requires an operation.');
    const prior = this._currentBuildingLaunchTail || Promise.resolve();
    const run = prior.then(operation, operation);
    const tail = run.catch(() => {});
    this._currentBuildingLaunchTail = tail;
    return run.finally(() => {
      if (this._currentBuildingLaunchTail === tail) this._currentBuildingLaunchTail = null;
    });
  }

  requestApplicationClose({ reason = 'closing FA Nexus' } = {}) {
    if (this._applicationClosePromise) return this._applicationClosePromise;
    this._applicationClosePending = true;
    const run = this._serializeBuildingLaunch(async () => {

      const exit = await this._decideSessionExit({ reason: 'app-close', leaveLabel: String(reason || 'closing FA Nexus') });
      if (!exit.proceed) return Object.freeze({ kind: exit.kind });
      return Object.freeze({ kind: exit.kind === 'none' ? 'ready' : `closed-${exit.kind}` });
    });
    const pending = run.then((outcome) => {
      if (['continued', 'blocked'].includes(outcome?.kind)) this._applicationClosePending = false;
      return outcome;
    }, (error) => {
      this._applicationClosePending = false;
      throw error;
    }).finally(() => {
      if (this._applicationClosePromise === pending) this._applicationClosePromise = null;
    });
    this._applicationClosePromise = pending;
    return pending;
  }

  /**
   * Leaving the Building editor by opening another Nexus tab. Resolves { proceed, kind }; see _decideSessionExit.
   */
  requestSessionExit({ reason = 'tab-switch', leaveLabel = 'opening another tab' } = {}) {
    if (this._sessionExitPromise) return this._sessionExitPromise;
    const pending = this._serializeBuildingLaunch(() => this._decideSessionExit({ reason, leaveLabel }))
      .finally(() => { if (this._sessionExitPromise === pending) this._sessionExitPromise = null; });
    this._sessionExitPromise = pending;
    return pending;
  }

  /**
   * The one decision behind every way out of a Building session that is not Commit or Cancel (NUX-016, design A2,
   * Building slice). A Commit in progress or an unfinished step refuses, with a message saying why; a session
   * without changes ends; one with changes asks Commit / Discard / Continue Editing. A Commit or Discard that
   * leaves the session open refuses too. Every refusal is shown here, so no caller can leave it unsaid.
   * Resolves { proceed, kind } with kind 'none', 'ended', 'committed', 'discarded', 'continued' or 'blocked'.
   */
  async _decideSessionExit({ reason, leaveLabel }) {
    const delegate = this._delegate;
    if (delegate?.architecture !== BUILDING_EDITOR_ARCHITECTURE_V2 || !delegate?.isActive) return { proceed: true, kind: 'none' };
    const refuse = (message, kind = 'blocked', level = 'warn') => {
      Logger.info?.('BuildingManager.sessionExit.refused', { reason, kind, message });
      ui.notifications[level](message);
      return { proceed: false, kind };
    };
    if (delegate.isCommitting) return refuse('The Building is still being committed. Try again when it has finished.');
    if (hasHostedSessionUnresolvedTransientState(delegate, { loggerPrefix: 'BuildingManager' })) {
      return refuse('Finish or cancel the step in progress in the Building editor first: a staged shape, a wall being drawn or a pending choice.');
    }
    if (!hasHostedSessionChanges(delegate, { loggerPrefix: 'BuildingManager' })) {
      await Promise.resolve(this.stop({ reason: `${reason}-clean` }));
      if (this.isActive) return refuse('The Building session could not be ended. Use Cancel in Tool Options.', 'blocked', 'error');
      return { proceed: true, kind: 'ended' };
    }
    const answer = await askHostedSessionExitQuestion({
      state: this._sessionExitQuestionState ||= {},
      noun: 'building',
      leaveLabel,
      commitUnavailableReason: this.canCommitSession()
        ? null
        : 'the Building is not ready to commit. Choose Continue Editing to see why beside the Commit button.'
    });
    if (answer === 'continue') return { proceed: false, kind: 'continued' };
    if (answer === 'discard') {
      await Promise.resolve(this.stop({ reason: `${reason}-discard` }));
      if (this.isActive) return refuse('The Building session stays open: its edits could not be discarded.', 'blocked', 'error');
      return { proceed: true, kind: 'discarded' };
    }
    let failure = null;
    try { await this.commitBuilding(); }
    catch (error) { failure = error; }
    if (this.isActive) {
      const detail = failure ? ` (${String(failure?.message || failure)})` : '';
      return refuse(`The Building session stays open: its edits could not be committed${detail}.`, 'blocked', 'error');
    }
    return { proceed: true, kind: 'committed' };
  }

  cancelApplicationClose() {
    if (this._applicationClosePromise) {
      throw new Error('Cannot cancel FA Nexus application close while its Building exit decision is pending.');
    }
    this._applicationClosePending = false;
  }

  start(session = {}) {
    if (this._applicationClosePending) {
      return Promise.reject(new Error('Cannot start a Building workflow while FA Nexus is closing.'));
    }
    return this._serializeBuildingLaunch(() => this._startSerialized(session));
  }

  async _startSerialized(session = {}) {

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
    const currentLevelId = String(getCurrentSceneLevel(canvas?.scene)?.id || '').trim();
    const wallPlacementLevelId = String(startSession.wallPlacementLevelId || currentLevelId || placementLevelId).trim() || null;
    if (!Object.prototype.hasOwnProperty.call(startSession, 'wallPlacementLevelId') && wallPlacementLevelId) {
      startSession.wallPlacementLevelId = wallPlacementLevelId;
    }
    if (!Object.prototype.hasOwnProperty.call(startSession, 'wallPlacementLevels') && wallPlacementLevelId) {
      startSession.wallPlacementLevels = [wallPlacementLevelId];
    }
    const fillAnchorElevation = Number.isFinite(selectedElevation) ? selectedElevation : fallbackElevation;
    const currentLevelRange = getCurrentLevelElevationRange(canvas?.scene);
    const wallElevation = Number.isFinite(currentLevelRange?.top)
      ? Number(currentLevelRange.top)
      : fillAnchorElevation;
    if (!Object.prototype.hasOwnProperty.call(startSession, 'elevation') && Number.isFinite(wallElevation)) {
      startSession.elevation = wallElevation;
    }
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
    if (!Object.prototype.hasOwnProperty.call(startSession, 'sceneGridSize')) {
      const sceneGridSize = Number(canvas?.scene?.grid?.size);
      if (Number.isFinite(sceneGridSize) && sceneGridSize > 0) startSession.sceneGridSize = sceneGridSize;
    }
    const delegate = await this._ensureDelegate();
    return runHostedSessionLaunch({
      awaitLaunch: true,
      beforeLaunch: () => {
        this._clearEditingTile();
        this._callRequiredDelegateCommand('setPortalMode', 'setPortalMode', {
          args: [this._portalMode],
          context: { phase: 'start', enabled: this._portalMode },
          rethrow: true
        });
      },
      launchSession: () => callRequiredDelegateMethod({
        delegate,
        methodName: 'start',
        args: [startSession],
        loggerPrefix: 'BuildingManager',
        logScope: 'sessionLaunch',
        bundleLabel: 'building editor'
      }),
      afterLaunch: () => {
        syncHostedPreviewLaunchState({
          applyLaunchPlacementAnchorTileId: () => this._applyPendingLaunchPlacementAnchorTileId(),
          syncPreviewRenderSort: () => this._syncDelegatePreviewRenderSort(),
          applyCurrentPreviewLayerOrdering: () => this._applyCurrentPreviewLayerOrdering()
        });
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

  editTile(tileDocument, options = {}) {
    if (this._applicationClosePending) {
      return Promise.reject(new Error('Cannot edit a Building while FA Nexus is closing.'));
    }
    return this._serializeBuildingLaunch(() => this._editTileSerialized(tileDocument, options));
  }

  async _editTileSerialized(tileDocument, options = {}) {

    // Resolve the edit target BEFORE anything dereferences it. A caller may legitimately hand
    // over a placeable, a document, or a Tile id, and any of those may name a Tile that is no
    // longer on the Scene (it was committed away, deleted, or the id was recorded in an earlier
    // session). Without this, the first thing to touch the target is the native-transform
    // transaction key, which reports the internal "require scene and Tile ids" — a message that
    // says nothing about the real problem and points the user nowhere.
    const doc = resolveTileDocument(tileDocument) || null;
    if (!doc?.id || !doc?.parent?.id) {
      const requested = String(resolveTileId(tileDocument) || (typeof tileDocument === 'string' ? tileDocument : '') || '').trim();
      throw new Error(
        `Building Tile ${requested || '(unidentified)'} is not on this Scene any more, so it cannot be opened for editing.`
        + ' Select the Building on the canvas and edit it from its Tile HUD.'
      );
    }
    await waitForNativeTileTransformTransactions(doc);
    if (Object.prototype.hasOwnProperty.call(options || {}, 'portalMode')) {
      this._portalMode = !!options.portalMode;
    }
    const editOptions = { ...(options || {}) };
    const sceneId = String(canvas?.scene?.id || '').trim();
    if (!Object.prototype.hasOwnProperty.call(editOptions, 'sceneId') && sceneId) {
      editOptions.sceneId = sceneId;
    }
    const documentLevelIds = getDocumentLevelIds(doc);
    if (!Object.prototype.hasOwnProperty.call(editOptions, 'placementLevels') && documentLevelIds.length) {
      editOptions.placementLevels = documentLevelIds;
    }
    if (!Object.prototype.hasOwnProperty.call(editOptions, 'placementLevelId') && documentLevelIds.length === 1) {
      editOptions.placementLevelId = documentLevelIds[0];
    }
    if (!Object.prototype.hasOwnProperty.call(editOptions, 'fillElevation')) {
      editOptions.fillElevation = getCurrentLevelBottomElevation(canvas?.scene);
    }
    if (!Object.prototype.hasOwnProperty.call(editOptions, 'fillPlacementLevelId')) {
      editOptions.fillPlacementLevelId = getCurrentSceneLevel(canvas?.scene)?.id || null;
    }
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed building editor bundle does not support editing existing tiles.');
    }
    if (delegate.isActive) {
      if (hasHostedSessionUnresolvedTransientState(delegate, { loggerPrefix: 'BuildingManager' })) {
        throw new Error('Apply or cancel the staged Rectangle before editing another Tile.');
      }
      if (hasHostedSessionChanges(delegate, { loggerPrefix: 'BuildingManager' })) {
        throw new Error('Finish or cancel the active Building Editor session before editing another Tile.');
      }
      await Promise.resolve(this.stop({ reason: 'edit-reentry' }));
    }
    const tileId = resolveTileId(doc);
    return runHostedSessionLaunch({
      awaitLaunch: true,
      beforeLaunch: () => {
        this._markEditingTile(doc);
        this._callRequiredDelegateCommand('setPortalMode', 'setPortalMode', {
          args: [this._portalMode],
          context: { phase: 'edit', enabled: this._portalMode, tileId },
          rethrow: true
        });
      },
      launchSession: () => delegate.editTile(doc, editOptions),
      afterLaunch: () => {
        syncHostedPreviewLaunchState({
          syncPreviewRenderSort: () => this._syncDelegatePreviewRenderSort(),
          applyCurrentPreviewLayerOrdering: () => this._applyCurrentPreviewLayerOrdering()
        });
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
    const call = this._callRequiredDelegateCommand('setActiveTool', 'setActiveTool', {
      args: [toolId],
      context: { toolId }
    });
    if (!call.ok) return call.result;
    this._syncToolOptionsState({ suppressRender: false });
    return call.result;
  }

  setPortalMode(enabled = false) {
    this._portalMode = !!enabled;
    if (!this._delegate) return this._portalMode;
    const call = this._callRequiredDelegateCommand('setPortalMode', 'setPortalMode', {
      args: [this._portalMode],
      context: { enabled }
    });
    if (!call.ok) return this._portalMode;
    this._syncToolOptionsState({ suppressRender: false });
    return this._portalMode;
  }

  forceExitPortalEditing() {
    this._callOptionalDelegateMethod('forceExitPortalEditing', 'exitPortalEditingAllSessions');
    this._portalMode = false;
    this._syncToolOptionsState({ suppressRender: false });
  }

  canHandlePortalPanelActions() {
    return !!this._delegate;
  }

  getPortalPanelState() {
    if (!this._delegate) return null;
    const call = this._callRequiredDelegateCommand('getPortalPanelState', 'getPortalPanelState', {
      missingReturn: null
    });
    return call.result;
  }

  setPortalPanelKind(kind) {
    const call = this._callRequiredDelegateCommand('setPortalPanelKind', 'setPortalPanelKind', {
      args: [kind],
      context: { kind },
      missingReturn: null
    });
    return call.result;
  }

  clearPortalTexture(pickerType) {
    const call = this._callRequiredDelegateCommand('clearPortalTexture', 'clearPortalTexture', {
      args: [pickerType],
      context: { pickerType },
      missingReturn: false
    });
    return call.result;
  }

  openPortalTexturePicker(pickerType) {
    const call = this._callRequiredDelegateCommand('openPortalTexturePicker', 'openPortalTexturePicker', {
      args: [pickerType],
      context: { pickerType },
      missingReturn: false
    });
    return call.result;
  }

  stop(...args) {
    if (this._delegate?.architecture === BUILDING_EDITOR_ARCHITECTURE_V2 && this._delegate.isCommitting) return false;
    return stopSessionWithFinalize({
      delegate: this._delegate,
      beforeStop: () => {
        this._cancelToolWindowMonitor();
        this._clearCanvasRebindState();
        toolOptionsController.deactivateTool(FEATURE_ID);
      },
      persistToolDefaults: () => this._persistDelegateToolDefaults(),
      stopSession: (delegate) => {
        const guardedStop = CANVAS_REBIND_GUARDS.get(delegate)?.originalStop || null;
        return callRequiredDelegateMethod({
          delegate: guardedStop ? { stop: guardedStop } : delegate,
          methodName: 'stop',
          args,
          loggerPrefix: 'BuildingManager',
          logScope: 'sessionStop',
          bundleLabel: 'building editor'
        });
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
    try {
      const result = await callRequiredDelegateMethod({
        delegate,
        methodName: 'commitBuilding',
        args: [options],
        loggerPrefix: 'BuildingManager',
        logScope: 'sessionCompletion',
        bundleLabel: 'building editor'
      });
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
    try {
      const cancelled = await callRequiredDelegateMethod({
        delegate,
        methodName: 'requestCancelSession',
        args: [{ ...options, confirmDiscard: () => this._confirmDiscardSession(options) }],
        loggerPrefix: 'BuildingManager',
        logScope: 'sessionCompletion',
        bundleLabel: 'building editor'
      });
      if (cancelled && !delegate?.isActive) {
        this._cancelToolWindowMonitor();
        toolOptionsController.deactivateTool(FEATURE_ID);
        this._clearEditingTile();
      }
      return cancelled;
    } catch (error) {
      if (typeof delegate?.requestCancelSession !== 'function') throw error;
      Logger.warn?.('BuildingManager.cancel.failed', { error: String(error?.message || error), options });
      return false;
    }
  }

  /**
   * Asked by the editor before Escape or Cancel discards a session with unsaved changes. A second Escape while
   * the question is open answers it with Discard, as in the Texture and Path editors.
   */
  _confirmDiscardSession({ reason } = {}) {
    const state = createHostedCancelSessionState(this);
    return confirmHostedCancelSession({
      state,
      force: reason === 'esc' && !!state.promise,
      ...buildDiscardQuestionText('building'),
      logger: Logger,
      loggerPrefix: 'BuildingManager'
    });
  }

  _assertDelegateArchitecture(delegate) {
    const actual = String(delegate?.architecture || '').trim();
    if (actual !== BUILDING_EDITOR_ARCHITECTURE_V2) {
      throw new Error(`Building Editor V2 is required, but the premium bundle resolved ${actual || 'an unidentified editor'}. Legacy fallback is disabled.`);
    }
    return delegate;
  }

  async _ensureDelegate() {
    if (this._delegate) {
      try {
        return this._assertDelegateArchitecture(this._delegate);
      } catch (error) {
        if (this._delegate?.isActive) throw error;
        this._delegate = null;
      }
    }
    if (this._loading) {
      const pending = await this._loading;
      return this._assertDelegateArchitecture(pending);
    }
    this._loading = resolvePremiumFeatureDelegate({
      featureId: FEATURE_ID,
      app: this._app,
      creationApp: null,
      host: this,
      assignDelegate: (instance) => {
        this._delegate = instance;
      },
      missingMessage: 'Premium building editor bundle missing BuildingManager implementation',
      validateInstance: (instance) => this._assertDelegateArchitecture(instance),
      attachmentHost: Object.freeze({
            ...BUILDING_EDITOR_V2_HOST,
            requestToolOptionsUpdate: (options = {}) => this.requestToolOptionsUpdate(options),
            prepareEditingTileExit: (options = {}) => this.prepareEditingTileExit(options),
            restoreEditingTile: (options = {}) => this.restoreEditingTile(options)
          }),
      exposedRuntimeCapabilities: BUILDING_EDITOR_V2_RUNTIME_CAPABILITIES,
      loadedLogName: 'BuildingEditor.bundle.loaded',
      loadedHookName: 'fa-nexus-building-editor-loaded',
      afterAttach: (instance) => {
        try { this._installCanvasRebindGuard(instance); }
        catch (error) {
          Logger.error?.('BuildingManager.canvasRebindGuard.installFailed', {
            error: String(error?.message || error)
          });
        }
        this._callRequiredDelegateCommand('setPortalMode', 'setPortalMode', {
          delegate: instance,
          args: [this._portalMode],
          context: { phase: 'afterAttach', enabled: this._portalMode },
          rethrow: true
        });
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

  _callRequiredDelegateCommand(action, methodName, {
    delegate = this._delegate,
    args = [],
    context = {},
    missingReturn = undefined,
    rethrow = false
  } = {}) {
    const details = context && typeof context === 'object' ? context : {};
    if (!delegate) {
      const error = new Error(`Building delegate missing required ${methodName}`);
      Logger.error?.(`BuildingManager.${action}.delegateMissing`, details);
      if (rethrow) throw error;
      return { ok: false, result: missingReturn, error };
    }
    const method = delegate?.[methodName];
    if (typeof method !== 'function') {
      const error = new Error(`Building delegate missing required ${methodName}`);
      Logger.error?.(`BuildingManager.${action}.methodMissing`, details);
      if (rethrow) throw error;
      return { ok: false, result: missingReturn, error };
    }
    try {
      return {
        ok: true,
        result: method.call(delegate, ...(Array.isArray(args) ? args : []))
      };
    } catch (error) {
      Logger.warn?.(`BuildingManager.${action}.failed`, {
        error: stringifyError(error),
        ...details
      });
      if (rethrow) throw error;
      return { ok: false, result: missingReturn, error };
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
      editorLabel: 'Building Editor session'
    });
  }

  _installCanvasRebindGuard(delegate) {
    if (!delegate || CANVAS_REBIND_GUARDS.has(delegate)) return;
    const originalStop = typeof delegate.stop === 'function' ? delegate.stop.bind(delegate) : null;
    if (!originalStop) return;
    delegate.stop = (...args) => {
      if (delegate.architecture === BUILDING_EDITOR_ARCHITECTURE_V2 && delegate.isCommitting) return false;
      if (this._shouldRecoverFromCanvasTeardown(delegate, args)) {
        return this._handleCanvasTeardownRecovery(delegate);
      }
      this._clearCanvasRebindState({ delegate });
      return originalStop(...args);
    };
    CANVAS_REBIND_GUARDS.set(delegate, { originalStop });
  }

  _callRequiredCanvasRebindDelegateMethod(delegate, methodName, args = []) {
    return callRequiredDelegateMethod({
      delegate,
      methodName,
      args,
      loggerPrefix: 'BuildingManager',
      logScope: 'canvasRebind',
      bundleLabel: 'building editor'
    });
  }

  _callRequiredPreviewPlacementDelegateMethod(methodName, args = []) {
    return callRequiredPreviewPlacementAdapterMethod({
      delegate: this._delegate,
      adapterKind: 'building',
      methodName,
      args,
      loggerPrefix: 'BuildingManager',
      bundleLabel: 'building editor'
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
    const rebindHostState = this._callRequiredCanvasRebindDelegateMethod(delegate, 'getCanvasRebindHostState');
    const expectedSceneId = String(rebindHostState?.sceneId || canvas?.scene?.id || '').trim();
    Logger.warn?.('BuildingManager.session.canvasTeardownIntercepted', buildHostedSessionContextDetails({
      app: this._app,
      delegate,
      includeAppState: true,
      extra: {
        expectedSceneId: expectedSceneId || null
      }
    }));

    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    const finish = (value) => {
      this._clearCanvasRebindState({ delegate });
      resolvePromise?.(value);
      return value;
    };

    const logStopDelegateRejection = (reason, error) => {
      Logger.error?.('BuildingManager.session.canvasRebindStopDelegateFailed', {
        reason,
        expectedSceneId: expectedSceneId || null,
        error: stringifyError(error)
      });
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
      const stopFn = CANVAS_REBIND_GUARDS.get(delegate)?.originalStop || delegate?.stop;
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

    try {
      this._callRequiredCanvasRebindDelegateMethod(delegate, 'prepareCanvasRebindRecovery');
    } catch (error) {
      return stopDelegate('canvas-rebind-prepare-failed', error);
    }

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
        this._callRequiredCanvasRebindDelegateMethod(delegate, 'resumeCanvasRebindRecovery');
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
        stopDelegate('canvas-rebind-ready-hook-threw', error).catch((stopError) => {
          logStopDelegateRejection('canvas-rebind-ready-hook-threw', stopError);
        });
      });
    };

    const timeoutId = setTimeout(() => {
      Promise.resolve(stopDelegate('canvas-rebind-timeout')).catch((error) => {
        logStopDelegateRejection('canvas-rebind-timeout', error);
      });
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
    beginHostedToolWindowMonitor(this, {
      delegate,
      toolId: FEATURE_ID,
      isHostReady: () => this._isEditorHostReady(),
      clearEditingTile: () => this._clearEditingTile(),
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
    cancelHostedToolWindowMonitor(this);
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
        applyBuildingCompositeTile(tile);
        applyDoorFrameTile(tile);
      }
    } catch (_) {}
  }

  _clearEditingTile() {
    return this._endEditingTileWithRefresh().tileId;
  }

  _endEditingTileWithRefresh({ deferRefresh = false } = {}) {
    const refreshJobs = [];
    const { tileId, refreshPromise } = endEditingTileWithRefresh(this, {
      sharedSetKey: EDITING_TILE_SET_KEY,
      loggerPrefix: 'BuildingManager',
      collectRefreshJobs: ({ tile }) => {
        if (deferRefresh) return [];
        refreshJobs.push(Promise.resolve(applyBuildingTile(tile)));
        refreshJobs.push(Promise.resolve(applyBuildingCompositeTile(tile)));
        refreshJobs.push(Promise.resolve(applyDoorFrameTile(tile)));
        return refreshJobs;
      }
    });
    const combinedRefresh = refreshPromise || (refreshJobs.length ? Promise.all(refreshJobs) : null);
    if (!deferRefresh) this._refreshExitedEditTile(tileId, combinedRefresh);
    return { tileId, refreshPromise: combinedRefresh };
  }

  async prepareEditingTileExit({ linkedTileIds = [], deferRefresh = false } = {}) {
    const result = this._endEditingTileWithRefresh({ deferRefresh });
    if (result.refreshPromise) await result.refreshPromise;
    const linkedIds = Array.from(new Set(
      (Array.isArray(linkedTileIds) ? linkedTileIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    ));
    for (const tileId of deferRefresh ? [] : linkedIds) {
      const tile = resolveTilePlaceable(null, tileId);
      if (!tile || tile.destroyed) {
        throw new Error(`Building exit handoff could not resolve linked Tile ${tileId}.`);
      }
      await Promise.all([
        Promise.resolve(applyBuildingTile(tile)),
        Promise.resolve(applyBuildingCompositeTile(tile)),
        Promise.resolve(applyDoorFrameTile(tile))
      ]);
      try { tile.renderFlags?.set?.({ refreshState: true }); } catch (_) {}
    }
    const root = globalThis?.window ?? globalThis;
    if (typeof root?.requestAnimationFrame === 'function') {
      await new Promise((resolve) => {
        root.requestAnimationFrame(() => root.requestAnimationFrame(resolve));
      });
    }
    return {
      tileId: result.tileId || null,
      linkedTileIds: linkedIds,
      refreshed: deferRefresh ? false : (!!result.refreshPromise || linkedIds.length > 0)
    };
  }

  restoreEditingTile({ tileId = null } = {}) {
    const normalizedTileId = String(tileId || '').trim();
    const document = normalizedTileId ? globalThis.canvas?.scene?.tiles?.get?.(normalizedTileId) : null;
    if (!document) throw new Error(`Building edit handoff could not restore Tile ${normalizedTileId || '(missing)'}.`);
    this._markEditingTile(document);
    return true;
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
    const delegate = this._delegate;
    if (delegate) {
      const descriptor = callRequiredDelegateMethod({
        delegate,
        methodName: 'getToolOptionsDescriptor',
        loggerPrefix: 'BuildingManager',
        logScope: 'toolOptionsDescriptor',
        bundleLabel: 'building editor'
      });
      if (!descriptor || typeof descriptor !== 'object') {
        Logger.error?.('BuildingManager.toolOptionsDescriptor.invalidDescriptor', {
          descriptorType: typeof descriptor
        });
        throw new Error('Building editor bundle returned invalid tool-options descriptor.');
      }
      if (descriptor.state && typeof descriptor.state === 'object') delegateState = descriptor.state;
      if (descriptor.handlers && typeof descriptor.handlers === 'object') handlers = descriptor.handlers;
    }
    const delegateEditorActionHandler = handlers.handleEditorAction;
    const delegateCustomToggleHandlers = handlers.customToggles && typeof handlers.customToggles === 'object'
      ? handlers.customToggles
      : {};
    const subtoolToggleHandlers = Object.fromEntries(
      (Array.isArray(delegateState?.subtoolToggles) ? delegateState.subtoolToggles : [])
        .map((toggle) => String(toggle?.id || '').trim())
        .filter(Boolean)
        .map((id) => [id, (enabled) => (enabled ? this.setActiveTool(id) : true)])
    );
    handlers = {
      ...handlers,
      setWallSnapEnabled: async (enabled) => {
        await game.settings.set(MODULE_ID, WALL_SNAP_SETTING_KEY, enabled === true);
        this._syncToolOptionsState({ suppressRender: false, forcePreviewLayerNotify: false });
        return true;
      },
      setBuildingWorkspaceMode: (modeId) => {
        const id = String(modeId || '').trim();
        if (id === 'outer-walls') {
          const activeShape = (delegateState?.subtoolToggles || []).find((toggle) => (
            toggle?.enabled === true && ['rectangle', 'ellipse', 'polygon'].includes(String(toggle?.id || ''))
          ));
          return activeShape ? true : this.setActiveTool('rectangle');
        }
        if (id === 'inner-walls') return this.setActiveTool('inner-wall');
        if (id === 'portals') return this.setActiveTool(id);
        if (id === 'edit-geometry') return this.setActiveTool('edit-geometry');
        if (id === 'fill') return this.setActiveTool('fill');
        return false;
      },
      setOuterShapeTool: (shapeId) => {
        const id = String(shapeId || '').trim();
        return ['rectangle', 'ellipse', 'polygon'].includes(id) ? this.setActiveTool(id) : false;
      },
      customToggles: {
        ...delegateCustomToggleHandlers,
        ...subtoolToggleHandlers
      },
      handleEditorAction: (actionId) => {
        const id = String(actionId || '').trim();
        if (id === 'commit') return this.commitBuilding({ reason: 'button' });
        if (id === 'cancel') return this.requestCancelSession({ reason: 'button' });
        if (id === 'undo' || id === 'redo') {
          return this._callRequiredDelegateCommand(id, id, {
            context: { source: 'tool-options' },
            rethrow: true
          }).result;
        }
        return typeof delegateEditorActionHandler === 'function'
          ? delegateEditorActionHandler(actionId)
          : false;
      }
    };
    const mergedHints = [...baseHints];
    if (Array.isArray(delegateState?.hints)) {
      for (const hint of delegateState.hints) {
        if (typeof hint === 'string' && hint.trim()) mergedHints.push(hint.trim());
      }
    } else if (typeof delegateState?.hints === 'string' && delegateState.hints.trim()) {
      mergedHints.push(delegateState.hints.trim());
    }
    const state = {
      ...delegateState,
      hints: mergedHints,
      wallSnap: {
        available: true,
        enabled: game.settings.get(MODULE_ID, WALL_SNAP_SETTING_KEY) === true
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
    const hostState = this._getPreviewLayerHostState();
    const fillElevation = Number(descriptor?.legacyState?.fillElevation?.value ?? hostState?.fillElevation ?? NaN);
    const previewState = {
      active: !!hostState?.active,
      elevation: Number.isFinite(hostState?.elevation) ? Number(hostState.elevation) : null,
      fillElevation: Number.isFinite(fillElevation) ? fillElevation : null,
      sort: Number.isFinite(hostState?.sort) ? Number(hostState.sort) : null,
      portalMode: !!this._portalMode,
      placementToggles: customToggles
    };
    notifyHostedPreviewLayerChangeIfNeeded({
      previewState,
      source,
      force,
      lastSignature: this._lastPreviewLayerSignature,
      setLastSignature: (signature) => { this._lastPreviewLayerSignature = signature; },
      loggerPrefix: 'BuildingManager'
    });
  }

  _getPreviewLayerHostState() {
    if (!this._delegate) {
      return { active: false, elevation: null, fillElevation: null, sort: null };
    }
    return this._callRequiredPreviewPlacementDelegateMethod('getPreviewLayerHostState');
  }

  _applyPendingLaunchPlacementAnchorTileId() {
    if (this._pendingLaunchPlacementAnchorTileId === undefined) return null;
    const anchorTileId = this._pendingLaunchPlacementAnchorTileId || null;
    this._pendingLaunchPlacementAnchorTileId = undefined;
    if (!this._delegate) return anchorTileId;
    this._callRequiredPreviewPlacementDelegateMethod('applyLaunchPlacementAnchorTileId', [anchorTileId]);
    Logger.debug?.('BuildingManager.sortAnchor.launchApply', { anchorTileId });
    return anchorTileId;
  }

  _syncDelegatePreviewRenderSort() {
    if (!this._delegate) return null;
    return this._callRequiredPreviewPlacementDelegateMethod('syncPreviewRenderSort', [{
      editingTileId: this._editingTileId || null
    }]);
  }

  _applyCurrentPreviewLayerOrdering({
    fillElevation = null,
    fillSort = null,
    ensurePreviewLayer = true,
    ensureFillLayer = true
  } = {}) {
    if (!this._delegate) return false;
    return this._callRequiredPreviewPlacementDelegateMethod('applyCurrentPreviewLayerOrdering', [{
      fillElevation,
      fillSort,
      ensurePreviewLayer,
      ensureFillLayer
    }]);
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
    if (!this._delegate) return false;
    const changed = !!this._callRequiredPreviewPlacementDelegateMethod('applyLayerManagerPreviewPlacement', [{
      elevation,
      sort,
      previewSort,
      previewKind,
      placementLevelId,
      anchorTileId,
      sortBefore
    }]);
    if (!changed) return false;
    this._syncToolOptionsState({
      suppressRender: false,
      suppressSubtoolPersistence: true,
      suppressToolDefaultsPersistence: true
    });
    this._notifyPreviewLayerChangeIfNeeded(null, { force: true, source: 'building-preview-layer-manager' });
    return true;
  }

  canReindexLayerManagerPreviewSiblings() {
    return false;
  }

  canStageLayerManagerPreviewSiblingReindex() {
    return true;
  }

  canApplyLayerManagerPreviewLevel({ placementLevelId = undefined } = {}) {
    return this._callRequiredPreviewPlacementDelegateMethod('canApplyLayerManagerPreviewLevel', [{
      placementLevelId
    }]) === true;
  }

  selectLayerManagerPreview({
    previewId = null,
    previewKey = null,
    previewKind = 'building-preview',
    elevation = null,
    sort = undefined,
    previewSort = undefined,
    placementLevelId = undefined
  } = {}) {
    if (!this._delegate) return false;
    const selected = !!this._callRequiredPreviewPlacementDelegateMethod('selectLayerManagerPreview', [{
      previewId,
      previewKey,
      previewKind
    }]);
    if (!selected) return false;
    this._syncToolOptionsState({
      suppressRender: false,
      suppressSubtoolPersistence: true,
      suppressToolDefaultsPersistence: true
    });
    this._notifyPreviewLayerChangeIfNeeded(null, { force: true, source: 'building-preview-layer-manager-select' });
    return true;
  }

  _buildToolOptionsDescriptor() {
    const { state: legacyState, handlers } = this._buildToolOptionsState();
    const activeSubtool = this._extractActiveSubtoolId(legacyState) || null;
    const { controls, sections } = this._buildDeclarativeToolOptionsConfig(legacyState, handlers);
    const hostState = this._getToolOptionsHostState();
    const basePolarity = hostState.basePolarity || 'add';
    const invertHeld = hostState.polarityInvertHeld === true;
    const shortcuts = mergeShortcutLists(
      createStandardEditorShortcuts({ includePolarity: false }),
      [
        createShortcut(SHORTCUT_ACTION.TOGGLE_WALL_SNAP, {
          label: 'Wall Snap',
          description: 'Toggle snapping authored points to the current Building Walls.'
        })
      ],
      this._portalMode
        ? [
            createShortcut('place-portal', {
              binding: 'Click',
              label: 'Place Portal',
              description: 'Place the configured door or window on the hovered wall.'
            })
          ]
        : [
            createShortcut(SHORTCUT_ACTION.TOGGLE_POLARITY, {
              label: 'Toggle Add/Subtract',
              description: 'Switch the current construction operation between Add and Subtract.'
            }),
            createShortcut(SHORTCUT_ACTION.TEMPORARY_INVERT_POLARITY, {
              label: 'Temporary Add/Subtract',
              description: 'Temporarily preview and use the opposite Add/Subtract operation while held.'
            }),
            createShortcut('toggle-staged-placement', {
              binding: 'Shift+E',
              label: 'Toggle Staged',
              description: 'Toggle staged placement. Turning it off discards the current staged shape.'
            }),
            createShortcut('select-segment', {
              binding: 'Click / Ctrl/Cmd+Click / Shift+Click',
              label: 'Select Wall Segments',
              description: 'In Edit Geometry, select one Segment, toggle one Segment, or toggle its complete Outer loop or Inner Path for shared appearance and Behavior edits.'
            }),
            createShortcut('convert-segment', {
              binding: 'Shift+Right-Click',
              label: 'Straight / Curve',
              description: 'In Edit Geometry, toggle the hovered Segment between Straight and the current exact Curve scaffold.'
            }),
            createShortcut('finish-polygon', {
              binding: 'Double-Click / Enter',
              label: 'Finish Polygon',
              description: 'Close the current Polygon sketch and resolve it through Direct or Staged placement. While sketching, Shift+Click ends a curved side and the next click sets its bend.'
            }),
            createShortcut('add-vertex', {
              binding: 'Ctrl/Cmd+Right-Click',
              label: 'Add Vertex',
              description: 'Insert a vertex on the hovered straight Segment in Edit Geometry or on a staged candidate Segment in Edit Points.'
            }),
            createShortcut('remove-vertex', {
              binding: 'Alt+Right-Click',
              label: 'Remove Vertex',
              description: 'Remove an eligible hovered vertex in Edit Geometry or staged Edit Points. Alt does not change Add/Subtract while staged Edit Points is active.'
            }),
            createShortcut('adjust-elevation-wheel', {
              binding: 'Alt+Wheel',
              label: 'Elevation Wheel',
              description: 'Adjust wall elevation by 0.001; add Shift for 0.1.'
            }),
            createShortcut('adjust-layer-order-wheel', {
              binding: 'Ctrl/Cmd+Alt+Wheel',
              label: 'Layer Order',
              description: 'Move the building preview one layer up or down within the current depth level.'
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
        previewElevation: Number.isFinite(hostState.previewElevation) ? Number(hostState.previewElevation) : 0,
        shapeEditMode: hostState.shapeEditMode === true,
        gapEditMode: hostState.gapEditMode === true
      },
      persistedState: {
        documentFlags: ['flags.fa-nexus.building'],
        toolDefaultsSetting: BUILDING_SUBTOOL_SETTING_KEY
      }
    });
  }

  _getToolOptionsHostState() {
    const delegate = this._delegate;
    if (!delegate) return {};
    const state = callRequiredDelegateMethod({
      delegate,
      methodName: 'getToolOptionsHostState',
      loggerPrefix: 'BuildingManager',
      logScope: 'toolOptionsHostState',
      bundleLabel: 'building editor'
    });
    if (state && typeof state === 'object') return state;
    Logger.error?.('BuildingManager.toolOptionsHostState.invalidState', {
      stateType: typeof state
    });
    throw new Error('Building editor bundle returned invalid tool-options host state.');
  }

  _buildDeclarativeToolOptionsConfig(legacyState = {}, handlers = {}) {
    const controls = {};
    const sections = [];
    const addHintControl = (config) => addDeclarativeHintControl(controls, config);
    const addRangeControl = (config) => addDeclarativeRangeControl(controls, config, {
      includeHeaderToggle: true
    });
    const addRangePairControl = (config) => addDeclarativeRangePairControl(controls, config);
    const addToggleControl = (config) => addDeclarativeToggleControl(controls, config);
    const addAxisTogglePairControl = (config) => addDeclarativeAxisTogglePairControl(controls, config);
    const addActionRowControl = (config) => addDeclarativeActionRowControl(controls, config, {
      includeHandlerId: true
    });
    const addScalarControl = (config) => addDeclarativeScalarControl(controls, config);

    const modeOptions = Array.isArray(legacyState?.modeToggles)
      ? legacyState.modeToggles.filter((toggle) => toggle && typeof toggle === 'object')
      : [];
    if (modeOptions.length) {
      controls['building-workspace-mode'] = {
        id: 'building-workspace-mode',
        type: 'segmented',
        variant: 'mode-rail',
        handlerId: 'setBuildingWorkspaceMode',
        options: modeOptions
      };
      sections.push({
        id: 'building-workspace',
        label: 'Building Workspace',
        region: 'header',
        collapsible: false,
        controls: ['building-workspace-mode']
      });
    }

    const outerModeActive = modeOptions.some((option) => option?.id === 'outer-walls' && option?.enabled === true);
    const shapeOptions = Array.isArray(legacyState?.subtoolToggles)
      ? legacyState.subtoolToggles.filter((toggle) => toggle && typeof toggle === 'object')
      : [];
    if (outerModeActive && shapeOptions.length) {
      controls['outer-shape-tool'] = {
        id: 'outer-shape-tool',
        type: 'segmented',
        handlerId: 'setOuterShapeTool',
        options: shapeOptions
      };
      sections.push({
        id: 'outer-shape',
        label: 'Shape',
        region: 'header',
        collapsible: false,
        controls: ['outer-shape-tool']
      });
    }

    const rectangleConstruction = legacyState?.rectangleConstruction;
    if (outerModeActive && rectangleConstruction?.available) {
      const effectiveOperation = rectangleConstruction.operation === 'subtract' ? 'subtract' : 'add';
      controls['rectangle-construction-mode'] = {
        id: 'rectangle-construction-mode',
        type: 'segmented',
        variant: 'construction-mode',
        multiple: true,
        handlerId: 'setRectangleConstructionOption',
        options: [
          {
            id: 'add',
            label: 'Add',
            tone: 'add',
            enabled: effectiveOperation === 'add',
            disabled: rectangleConstruction.operationDisabled === true,
            tooltip: 'Add the dragged shape to the Building.'
          },
          {
            id: 'staged',
            label: 'Staged',
            tone: 'staged',
            enabled: rectangleConstruction.staged === true,
            disabled: rectangleConstruction.stagedDisabled === true,
            tooltip: 'Keep an adjustable candidate before applying it.'
          },
          {
            id: 'subtract',
            label: 'Subtract',
            tone: 'subtract',
            enabled: effectiveOperation === 'subtract',
            disabled: rectangleConstruction.operationDisabled === true,
            tooltip: 'Subtract the dragged shape from the Building.'
          }
        ]
      };
      sections.push({
        id: 'rectangle-construction',
        label: 'Construction',
        region: 'header',
        collapsible: false,
        controls: ['rectangle-construction-mode']
      });
      if (typeof handlers.setRoomConstructionEnabled === 'function') {
        addToggleControl({ id: 'room-construction', label: 'Room Construction',
          value: rectangleConstruction.roomConstructionEnabled === true,
          disabled: rectangleConstruction.roomConstructionDisabled === true,
          tooltip: 'Add preserves room seams; Subtract trims affected Interior Paths to the remaining building. Ordinary construction is unchanged when off.',
          handlerId: 'setRoomConstructionEnabled' });
        sections.push({ id: 'room-construction', label: 'Room Construction', region: 'header',
          collapsible: false, controls: ['room-construction'] });
        if (rectangleConstruction.roomConstructionEnabled && typeof handlers.setRoomConstructionInnerOnly === 'function') {
          controls['room-construction-scope'] = { id: 'room-construction-scope', type: 'segmented', variant: 'construction-mode',
            handlerId: 'setRoomConstructionScope', options: [
              { id: 'full', label: 'Outer + Inner', enabled: !rectangleConstruction.roomConstructionInnerOnly,
                disabled: rectangleConstruction.roomConstructionDisabled },
              { id: 'inner', label: 'Inner Only', enabled: rectangleConstruction.roomConstructionInnerOnly === true,
                disabled: rectangleConstruction.roomConstructionDisabled,
                tooltip: 'Add room walls inside the existing outline without expanding it. Subtract still trims the building.' }
            ] };
          sections.at(-1).controls.push('room-construction-scope');
        }
      }
    }

    if (legacyState?.stickyJoints?.available && typeof handlers.setStickyJointsEnabled === 'function') {
      addToggleControl({ id: 'sticky-joints', label: 'Sticky Joints',
        value: legacyState.stickyJoints.enabled === true,
        disabled: legacyState.stickyJoints.disabled === true,
        tooltip: 'Keep touching wall vertices together and keep attached endpoints on their walls during geometry edits. Turn off to separate a joint.',
        handlerId: 'setStickyJointsEnabled' });
      sections.push({ id: 'sticky-joints', label: 'Edit Geometry', region: 'header',
        collapsible: false, controls: ['sticky-joints'] });
    }

    if (legacyState?.wallSnap?.available) {
      addToggleControl({
        id: 'wall-snap',
        label: 'Walls',
        value: legacyState.wallSnap.enabled === true,
        disabled: false,
        tooltip: 'Snap authored vertices to this Building\'s current Outer and Inner Walls without joining their semantic identities. Shift+S toggles Wall Snap; Grid Snap takes priority while enabled.',
        handlerId: 'setWallSnapEnabled'
      });
      sections.push({
        id: 'wall-snap',
        label: 'Snapping',
        region: 'footer-snap',
        collapsible: false,
        controls: ['wall-snap']
      });
    }

    const consolidatedPortals = legacyState.portalControlsLayout === 'consolidated';
    const portalBehaviorControlIds = consolidatedPortals
      ? buildingV2WindowBehaviorControls(controls, legacyState.windowControls) : [];
    if (legacyState?.opening?.available && (!consolidatedPortals || legacyState.opening.unresolved)) {
      const opening = legacyState.opening;
      sections.push({ id: 'opening-controls', label: `${opening.selected ? 'Selected' : 'Place'} ${opening.kind === 'door' ? 'Door' : 'Opening'}`, collapsible: false,
        controls: [
          addHintControl({ id: 'opening-instructions', text: opening.unresolved || (opening.kind === 'door' ? 'Choose Door artwork, then hover a wall and click to place. Drag the center to move or either jamb to resize. Right-click deselects; right-drag pans. Undo/Redo restores complete Door edits.' : 'Hover a wall and click to place a one-grid-wide Opening. Drag its center to move or either jamb to resize. Right-click deselects; right-drag pans without deselecting. Tab cycles overlapping wall targets. Escape clears the active gesture or selection; Escape again cancels the session.') })
        ].filter(Boolean)
      });
    }

    if (legacyState?.doorBehavior?.available) {
      const door = legacyState.doorBehavior;
      const addSelect = (id, label, value, options, handlerId) => addDeclarativeSelectControl(controls, {
        id, label, state: { value, options, disabled: door.disabled }, handlerId
      });
      const addToggle = (id, label, value, handlerId) => addToggleControl({
        id, label, value, disabled: door.disabled, handlerId
      });
      const behaviorControls = [
        addSelect('door-animation', 'Animation', door.animation, door.animations, 'setDoorAnimation'),
        addSelect('door-direction', 'Open Direction', door.direction, [
          { value: 1, label: 'Default' }, { value: -1, label: 'Reversed' }
        ], 'setDoorDirection'),
        addToggle('door-hinge-flip', 'Flip Hinge', door.directionFlip, 'setDoorHingeFlip'),
        addToggle('door-double', 'Double Door', door.double, 'setDoorDouble'),
        !door.inheritsWallTexture && addToggle('door-texture-flip-horizontal', 'Flip Horizontal', door.textureFlip.horizontal, 'setDoorTextureFlipHorizontal'),
        !door.inheritsWallTexture && addToggle('door-texture-flip-vertical', 'Flip Vertical', door.textureFlip.vertical, 'setDoorTextureFlipVertical')
      ].filter(Boolean);
      if (consolidatedPortals) portalBehaviorControlIds.push(...behaviorControls);
      else sections.push({ id: 'door-behavior', label: 'Door Setup', collapsible: false, controls: behaviorControls });
    }

    if (legacyState?.portalOptions?.available) {
      const portal = legacyState.portalOptions;
      const portalControls = [...portalBehaviorControlIds,
        addHintControl({ id: 'portal-options-scope', text: `${portal.scopeLabel}: ${portal.summary}` }),
        addActionRowControl({ id: 'portal-options-actions', handlerId: 'editPortalOptions', actions: [
          { id: 'custom', label: 'Custom Behavior…', disabled: portal.disabled }
        ] }),
        ...(consolidatedPortals ? [addActionRowControl({ id: 'portal-options-reset', handlerId: 'resetPortalOptions', actions: [
          { id: 'reset-custom-behavior', label: 'Reset Custom Behavior', disabled: portal.disabled || !portal.canReset }
        ] })] : [])
      ];
      if (portal.state?.available) {
        portalControls.push(addDeclarativeSelectControl(controls, {
          id: 'portal-state', label: portal.state.label,
          state: { value: portal.state.value, options: portal.state.options, disabled: portal.disabled }, handlerId: 'setPortalState'
        }));
        portalControls.push(addHintControl({ id: 'portal-state-hint', text: portal.hint }));
      }
      if (portal.conflict) {
        portalControls.push(addHintControl({ id: 'portal-state-conflict', text: portal.conflict }));
        portalControls.push(addActionRowControl({ id: 'portal-state-keep', handlerId: 'keepPortalLiveState', actions: [
          { id: 'keep', label: 'Keep My State Edit', disabled: portal.disabled }
        ] }));
        portalControls.push(addActionRowControl({ id: 'portal-state-current', handlerId: 'useCurrentPortalLiveState', actions: [
          { id: 'current', label: 'Use Current State', disabled: portal.disabled }
        ] }));
      }
      sections.push({ id: 'portal-options', label: consolidatedPortals ? 'Behavior' : 'Portal Behavior', collapsible: consolidatedPortals, controls: portalControls.filter(Boolean) });
    }

    if (legacyState?.doorAppearance?.available && !consolidatedPortals) {
      const appearance = legacyState.doorAppearance;
      sections.push({ id: 'door-appearance', label: 'Door Artwork', collapsible: false, controls: [
        addHintControl({ id: 'door-artwork-hint', text: 'Artwork width changes the leaf thickness; the opening stays jamb-to-jamb. Amber marks the pivot; the blue arrow shows opening travel.' }),
        addToggleControl({
          id: 'door-artwork-lock-aspect-ratio',
          label: 'Lock Aspect Ratio',
          value: appearance.lockAspectRatio === true,
          disabled: appearance.widthScale.disabled,
          tooltip: 'Scale artwork thickness proportionally when this Door\'s jamb-to-jamb width changes. Enabling the lock keeps the current dimensions.',
          handlerId: 'setDoorAspectRatioLock'
        }),
        ...[['widthScale', 'Artwork Width', 'setDoorArtworkWidth']].map(([field, label, handlerId]) => addRangeControl({
            id: `door-artwork-${field}`, label, state: appearance[field], handlerId, ariaLabel: `Door ${label.toLowerCase()}`
          }))
      ].filter(Boolean) });
    }

    if (legacyState?.geometrySelectionHint) {
      sections.push({ id: 'geometry-selection', label: '', showHeading: false, collapsible: false,
        controls: [addHintControl({ id: 'geometry-selection-hint', text: legacyState.geometrySelectionHint })] });
    }

    if (legacyState?.fillRegionSelection?.available) {
      const selection = legacyState.fillRegionSelection;
      sections.push({ id: 'fill-region-selection', label: 'Fill Regions', collapsible: false,
        controls: [
          addHintControl({ id: 'fill-region-summary', text: selection.summary }),
          addHintControl({ id: 'fill-region-hint', text: selection.hint })
        ].filter(Boolean)
      });
    }

    if (legacyState?.wallBehavior?.available) {
      const wallBehavior = legacyState.wallBehavior;
      const wallBehaviorControlIds = [];
      if (Array.isArray(wallBehavior.scopeOptions) && wallBehavior.scopeOptions.length > 1) {
        controls['wall-behavior-scope'] = {
          id: 'wall-behavior-scope',
          type: 'segmented',
          handlerId: 'setWallBehaviorScope',
          options: wallBehavior.scopeOptions
        };
        wallBehaviorControlIds.push('wall-behavior-scope');
      }
      wallBehaviorControlIds.push(addHintControl({
        id: 'wall-behavior-status',
        text: `${wallBehavior.scopeLabel}: ${wallBehavior.status}`
      }));
      wallBehaviorControlIds.push(addActionRowControl({
        id: 'wall-behavior-actions',
        handlerId: 'handleWallBehaviorAction',
        previewHandlerId: 'previewWallBehaviorAction',
        actions: wallBehavior.actions
      }));
      sections.push({
        id: 'wall-behavior',
        label: 'Behavior',
        collapsible: consolidatedPortals,
        controls: wallBehaviorControlIds.filter(Boolean)
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
          raiseHandlerId: typeof handlers.raiseSelectedWall === 'function' ? 'raiseSelectedWall' : '',
          lowerHandlerId: typeof handlers.lowerSelectedWall === 'function' ? 'lowerSelectedWall' : '',
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
        fillControlIds.push(addScalarControl({
          id: 'fill-scale',
          variant: 'scale',
          label: 'Scale',
          ariaLabel: 'Scale',
          state: legacyState.scale,
          handlerId: 'setScale'
        }));
      }
      if (legacyState?.rotation?.available) {
        fillControlIds.push(addScalarControl({
          id: 'fill-rotation',
          variant: 'rotation',
          label: 'Rotation',
          ariaLabel: 'Rotation',
          state: legacyState.rotation,
          handlerId: 'setRotation'
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
        if (legacyState.fillTexture?.opacity?.available) {
          fillControlIds.push(addRangeControl({
            id: 'fill-opacity',
            label: 'Fill Opacity',
            state: legacyState.fillTexture.opacity,
            handlerId: 'setFillOpacity',
            ariaLabel: 'Fill opacity'
          }));
        }
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
          label: activeHsbcTarget === 'fill' ? 'Fill Color' : 'Wall Color',
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

    appendBuildingV2InteriorPathControls(controls, sections, legacyState);
    if (consolidatedPortals) appendBuildingV2PortalControls(controls, sections, legacyState);
    const portalControlIds = [];
    if (legacyState?.doorControls?.available && !consolidatedPortals) {
      controls['door-portal-controls'] = {
        id: 'door-portal-controls',
        type: 'portal-controls',
        variant: 'door',
        state: legacyState.doorControls
      };
      portalControlIds.push('door-portal-controls');
    }
    if (legacyState?.windowControls?.available && !consolidatedPortals) {
      controls['window-portal-controls'] = {
        id: 'window-portal-controls',
        type: 'portal-controls',
        variant: 'window',
        state: legacyState.windowControls
      };
      portalControlIds.push('window-portal-controls');
    }
    if (legacyState?.seamlessSecretDoorControls?.available) {
      controls['seamless-secret-door-portal-controls'] = {
        id: 'seamless-secret-door-portal-controls',
        type: 'portal-controls',
        variant: 'seamlessSecretDoor',
        state: legacyState.seamlessSecretDoorControls
      };
      portalControlIds.push('seamless-secret-door-portal-controls');
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
    this._subtoolPreferenceBridge.persistDelegateToolDefaults();
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
    if (this._portalMode) return;
    this._subtoolPreferenceBridge.restoreSubtoolPreference();
  }

  _ensureMeasurementsEnabled() {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    if (this._forcingMeasurementsEnabled) return false;
    this._forcingMeasurementsEnabled = true;
    try {
      return callRequiredDelegateMethod({
        delegate,
        methodName: 'ensureMeasurementsEnabled',
        loggerPrefix: 'BuildingManager',
        logScope: 'delegateMeasurements',
        bundleLabel: 'building editor'
      }) === true;
    } catch (error) {
      Logger.error?.('BuildingManager.ensureMeasurementsEnabled.failed', {
        error: String(error?.message || error)
      });
      throw error;
    } finally {
      this._forcingMeasurementsEnabled = false;
    }
  }
}

export default BuildingManager;
