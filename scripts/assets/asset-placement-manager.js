import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { getCanvasInteractionController, announceChange } from '../canvas/canvas-interaction-controller.js';
import { getAssetShadowManager } from './asset-shadow-manager.js';
import { readShadowQualityConfig } from './shadow-quality.js';
import {
  getCurrentLevelBottomElevation,
  resolveInitialFaNexusPlacementElevation,
  resolvePlacementAnchorTile
} from '../canvas/elevation-band-utils.js';
import {
  getDefaultTilePlacementLevelId,
  getTileExplicitPlacementLevelId,
  resolveTileRenderOrder
} from '../canvas/tile-band-utils.js';
import {
  buildPlacementTileData,
  buildScatterPlacementTileData,
  buildScatterPlacementTileUpdate
} from './asset-placement-tile-payload.js';
import {
  ASSET_SCATTER_MODE_BRUSH,
  ASSET_SCATTER_MODE_SINGLE,
  DEFAULT_ROTATION,
  DEFAULT_ROTATION_RANDOM_MAX,
  DEFAULT_ROTATION_RANDOM_MIN,
  DEFAULT_SCALE,
  DEFAULT_SCALE_RANDOM_MAX,
  DEFAULT_SCALE_RANDOM_MIN,
  SCATTER_PLACEMENT_TRANSFORM_SETTINGS,
  SCATTER_TRANSFORM_INIT_SETTING,
  clampPlacementRotationRandomValue,
  clampPlacementScale,
  clampPlacementScaleRandomPercent,
  formatPlacementFlipSummary,
  getDefaultPlacementScaleRandomRange,
  getPlacementRotationRandomRange,
  getPlacementScaleRandomRange,
  normalizePlacementRotation,
  normalizePlacementTransformMode,
  resolvePlacementTransformSettingKey,
  samplePlacementFlipState,
  samplePlacementRotationPreviewValue,
  samplePlacementRotationRandomValue,
  samplePlacementScalePreviewValue,
  samplePlacementScaleRandomValue
} from './asset-placement-transform-state.js';
import { AssetPlacementCommitWorkflow } from './asset-placement-commit-workflow.js';
import { AssetPlacementEditShadowCommitWorkflow } from './asset-placement-edit-shadow-commit-workflow.js';
import { AssetScatterCommitWorkflow } from './asset-scatter-commit-workflow.js';
import { AssetPlacementLocalizationWorkflow } from './asset-placement-localization-workflow.js';
import { AssetPlacementPreviewRuntime } from './asset-placement-preview-runtime.js';
import { AssetScatterPlacementSession } from './asset-scatter-placement-session.js';
import { AssetScatterPreviewGroupRuntime } from './asset-scatter-preview-group-runtime.js';
import {
  buildScatterTilePayload,
  computeScatterInstanceBounds,
  computeScatterTileBounds,
  resolveScatterTileTextureSrc
} from './asset-scatter-tile-payload.js';
import {
  buildScatterEditCommit,
  hasScatterEditGeometryChanges
} from './asset-scatter-tile-transform.js';
import { resolveScatterInstanceAffine } from './asset-scatter-instance-transform.js';
import {
  buildPreviewDilationOffsets,
  computeRotatedSpriteBounds,
  resolveSafePreviewRenderTarget,
  resolveSafePreviewRenderTextureLimit
} from './asset-placement-preview-shadow-model.js';
import {
  DEFAULT_SHADOW_OFFSET_MAX,
  DEFAULT_SHADOW_SETTINGS,
  MAX_SHADOW_BLUR,
  MAX_SHADOW_DILATION,
  MIN_SHADOW_OFFSET_MAX,
  SHADOW_OFFSET_MAX_CEILING,
  SHADOW_PRESET_COUNT,
  buildDropShadowContextState as buildDropShadowContextStateData,
  buildDropShadowControlsState as buildDropShadowControlsStateData,
  clampShadowOffsetMax,
  normalizeShadowAngle,
  normalizeShadowSnapshot,
  resolveDropShadowControlChange
} from './asset-placement-drop-shadow-state.js';
import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';
import { resolveLayerManagerPreviewSortNudge } from '../layers/layer-manager-preview-placement-bridge.js';
import { PlacementPrefetchQueue } from '../core/placement/placement-prefetch-queue.js';
import { ScatterPlacementCommitSession } from '../core/placement/scatter-commit-session.js';
import {
  activatePlacementToolOptions,
  deactivatePlacementToolOptions
} from '../core/placement/placement-session-utils.js';
import { getGridSnapStep, snapPlacementPoint } from '../core/grid-snap-utils.js';
import { getSharedTexture } from '../textures/texture-runtime-core.js';
import {
  applyHsbcToDisplayObject,
  buildHsbcToolOptionsControls,
  buildHsbcToolOptionsHandlers,
  buildHsbcToolOptionsState,
  cloneHsbc,
  createNeutralHsbc,
  normalizeHsbc,
  serializeHsbc
} from '../core/hsbc.js';
import {
  createNormalizedToolOptionsDescriptor,
  TOOL_OPTIONS_RENDERER_MODE
} from '../core/tool-options/tool-options-descriptor.js';
import {
  addDeclarativeAxisTogglePairControl,
  addDeclarativeRangeControl,
  addDeclarativeScalarRandomizedControl
} from '../core/tool-options/tool-options-control-builders.js';
import {
  SHORTCUT_ACTION,
  createShortcut,
  resolveEffectivePolarity
} from '../core/editor-shortcuts.js';
import { AssetPlacementEditSession, getTileVisualCenterWorld } from './asset-placement-edit-session.js';
import { AssetPlacementInteractionSession } from './asset-placement-interaction-session.js';
import { AssetPlacementShadowPreviewRenderer } from './asset-placement-preview-shadow-renderer.js';
import { AssetPlacementScatterPreviewShadowRenderer } from './asset-placement-scatter-preview-shadow-renderer.js';
import {
  AssetScatterHoverPreviewRuntime,
  SCATTER_HOVER_PREVIEW_PRIMARY_ALPHA
} from './asset-scatter-hover-preview-runtime.js';
import {
  buildDiscardQuestionText,
  confirmHostedCancelSession,
  createHostedCancelSessionState
} from '../premium/session-host/cancel-session-dialog.js';
import './asset-scatter-tiles.js';
import './shadow-only-runtime.js';

// Shadow settings that belong to the tool, not to a layer: remembered from edit sessions too (design B2).
const SHADOW_TOOL_SETTING_KEYS = new Set(['assetDropShadowCollapsed', 'assetDropShadowPresets', 'assetDropShadowOffsetMax']);

/**
 * @typedef {import('../core/fa-nexus-types.js').FaNexusPoint} FaNexusPoint
 */

const quantizeElevation = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const quantized = Math.round(numeric * 1000) / 1000;
  return Object.is(quantized, -0) ? 0 : quantized;
};

const formatElevation = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  const rounded = Math.round(numeric * 1000) / 1000;
  const normalized = Number(rounded.toFixed(3));
  const safeValue = Object.is(normalized, -0) ? 0 : normalized;
  return safeValue.toString();
};

const ELEVATION_STEP_DEFAULT = 0.001;
const ELEVATION_STEP_FINE = 0.001;
const ELEVATION_STEP_COARSE = 0.1;
const ELEVATION_INPUT_LIMIT = 100000;

const SCATTER_BRUSH_SIZE_DEFAULT = 320;
const SCATTER_BRUSH_SIZE_MIN = 40;
const SCATTER_BRUSH_SIZE_MAX = 2400;
const SCATTER_DENSITY_DEFAULT = 3;
const SCATTER_DENSITY_MIN = 1;
const SCATTER_DENSITY_MAX = 20;
const SCATTER_SPRAY_DEVIATION_DEFAULT = 0.5;
const SCATTER_SPRAY_DEVIATION_MIN = 0;
const SCATTER_SPRAY_DEVIATION_MAX = 1;
const SCATTER_SPACING_DEFAULT = 25;
const SCATTER_SPACING_MIN = 1;
const SCATTER_SPACING_MAX = 200;
const SCATTER_RING_WIDTH = 0.2;
const SCATTER_CENTER_POWER = 2.5;
const SCATTER_FLAG_KEY = 'assetScatter';
const SCATTER_VERSION = 1;
const SCATTER_PREVIEW_Z_INDEX = 999998;
const PREFETCH_COUNT_DEFAULT = 4;
const SCATTER_PREFETCH_MIN = 5;
const SCATTER_HISTORY_LIMIT = 30;
const FREEZE_SHORTCUT_BLOCKED_INPUTS = new Set(['text', 'search', 'email', 'url', 'password', 'tel']);
const PREVIEW_LAYER_HOOK = 'fa-nexus-preview-layers-changed';
const TOOL_OPTIONS_ACTIVITY_EVENT = 'fa-nexus:tool-options-activity';
const DROP_SHADOW_CONTROL_PROPS = Object.freeze({
  alpha: '_dropShadowAlpha',
  dilation: '_dropShadowDilation',
  blur: '_dropShadowBlur',
  offsetDistance: '_dropShadowOffsetDistance',
  offsetAngle: '_dropShadowOffsetAngle'
});

export class AssetPlacementManager {
  constructor(app) {
    this.app = app;
    this.isPlacementActive = false;
    this.isStickyMode = false;
    this.currentAsset = null;
    this.isRandomMode = false;
    this.randomAssets = [];
    this.previewElement = null;
    this._previewContainer = null;
    this._loadingOverlay = null;
    this._scatterMode = this._readStoredScatterMode();
    this._ensureScatterPlacementTransformSettingsInitialized();
    this.currentRotation = this._readPlacementRotation();
    this._rotationRandomEnabled = this._readPlacementRotationRandomEnabled();
    this._rotationRandomMin = this._readPlacementRotationRandomMin();
    this._rotationRandomMax = this._readPlacementRotationRandomMax();
    this.isDownloading = false;
    this.queuedPlacement = null; // {x,y}
    this._assetLocalizationWorkflow = new AssetPlacementLocalizationWorkflow(this);
    this._previewRuntime = new AssetPlacementPreviewRuntime(this);
    this._randomPrefetch = new PlacementPrefetchQueue({
      prefetchCount: PREFETCH_COUNT_DEFAULT,
      getItemKey: (asset) => this._assetKey(asset),
      needsPrefetch: (asset) => this._assetRequiresDownload(asset),
      prefetch: (asset) => this._ensureAssetLocal(asset),
      logger: Logger,
      loggerTag: 'AssetPlacement.prefetch'
    });
    this._interactionController = getCanvasInteractionController();
    this._placementInteractionSession = new AssetPlacementInteractionSession(this, {
      scatterModeBrush: ASSET_SCATTER_MODE_BRUSH
    });
    this._editSession = new AssetPlacementEditSession(this, {
      scatterModeBrush: ASSET_SCATTER_MODE_BRUSH,
      scatterModeSingle: ASSET_SCATTER_MODE_SINGLE
    });
    this._commitWorkflow = new AssetPlacementCommitWorkflow(this);
    this._editShadowCommitWorkflow = new AssetPlacementEditShadowCommitWorkflow(this);
    this._scatterCommitWorkflow = new AssetScatterCommitWorkflow(this);
    this._scatterPlacementSession = new AssetScatterPlacementSession(this);
    this._lastPointer = null;
    this._lastPointerWorld = null;
    this._scatterBrushSize = this._readStoredScatterBrushSize();
    this._scatterDensity = this._readStoredScatterDensity();
    this._scatterSprayDeviation = this._readStoredScatterSprayDeviation();
    this._scatterSpacing = this._readStoredScatterSpacing();
    this._scatterPainting = false;
    this._scatterLastPointerWorld = null;
    this._scatterStrokeDistance = 0;
    this._scatterHoverPreviewRuntime = new AssetScatterHoverPreviewRuntime(this, {
      scatterModeBrush: ASSET_SCATTER_MODE_BRUSH
    });
    this._scatterMergeEnabled = this._readStoredScatterMergeEnabled();
    this._scatterMergeBeforeEdit = null;
    this._scatterEraseEnabled = false;
    this._scatterPolarityInvertHeld = false;
    this._scatterEditing = false;
    this._scatterEditTile = null;
    this._scatterEditState = null;
    this._scatterEditSessionStart = null;
    // The Scatter Preview row was moved in the Layer Manager during this edit: Apply writes its place.
    this._scatterEditPlacementMoved = false;
    this._scatterEditPointerLockScreen = null;
    this._scatterPreviewShadowRenderer = new AssetPlacementScatterPreviewShadowRenderer(this, {
      scatterModeBrush: ASSET_SCATTER_MODE_BRUSH
    });
    this._scatterPreviewGroupRuntime = new AssetScatterPreviewGroupRuntime(this, {
      scatterModeBrush: ASSET_SCATTER_MODE_BRUSH,
      previewZIndex: SCATTER_PREVIEW_Z_INDEX
    });
    this._scatterCommitSession = new ScatterPlacementCommitSession({
      historyLimit: SCATTER_HISTORY_LIMIT,
      quantizeElevation,
      getSessionKey: (elevation) => this._getScatterSessionKey(elevation),
      logger: Logger
    });
    this._scatterShadowBatchActive = false;
    this._scatterShadowBatchManager = null;
    this._toolOptionsPreviewActive = false;
    this._toolOptionsPreviewRestoreWorld = null;
    this._boundToolOptionsActivity = (event) => this._handleToolOptionsActivity(event);
    this._previewFrozen = false;
    this._frozenPreviewWorld = null;
    this._frozenPreviewExact = false;
    this._frozenPointerScreen = null;
    // Track canvas zoom to keep preview sized accurately
    this._zoomWatcherId = null;
    this._lastZoom = 1;
    // Per-placement scale multiplier (Shift+wheel)
    this.currentScale = this._readPlacementScale();
    // Elevation for the active placement session (Alt+wheel)
    this._previewElevation = 0;
    this._previewSort = 0;
    this._previewRenderSort = 0;
    this._previewPlacementLevelId = null;
    this._placementSortAnchorTileId = null;
    this._placementSortAnchorPlacementLevelId = null;
    this._placementSortBeforeAnchor = false;
    this._lastElevationAnnounce = 0;
    this._pendingElevationAnnouncePoint = null;
    this._elevationAnnounceTimer = null;
    // Drop shadow preference for the active placement session; null -> follow global
    this._dropShadowPreference = this._readDropShadowPreference();
    this._dropShadowSettingsHook = null;
    this._dropShadowAlpha = this._readShadowSetting('assetDropShadowAlpha', 0.65, 0, 1);
    this._dropShadowDilation = this._readShadowSetting('assetDropShadowDilation', 1.6, 0, MAX_SHADOW_DILATION);
    this._dropShadowBlur = this._readShadowSetting('assetDropShadowBlur', 1.8, 0, MAX_SHADOW_BLUR);
    this._dropShadowOffsetMax = this._readShadowOffsetMax();
    this._dropShadowOffsetDistance = this._readShadowSetting(
      'assetDropShadowOffsetDistance',
      0,
      0,
      this._getShadowOffsetMax()
    );
    this._dropShadowOffsetAngle = this._readShadowSetting('assetDropShadowOffsetAngle', 135, 0, 359, { wrapAngle: true });
    this._dropShadowOnly = this._readDropShadowOnlySetting();
    this._shadowPresets = this._loadShadowPresets();
    this._shadowSettingsCollapsed = this._readShadowSettingsCollapsed();
    this._shadowElevationContext = { elevation: 0, tileCount: 0, hasTiles: false, source: 'default' };
    this._hsbc = createNeutralHsbc();
    this._previewShadowRenderer = new AssetPlacementShadowPreviewRenderer(this);
    this._pendingRotation = this.currentRotation;
    this._scaleRandomEnabled = this._readPlacementScaleRandomEnabled();
    this._scaleRandomMin = this._readPlacementScaleRandomMin();
    this._scaleRandomMax = this._readPlacementScaleRandomMax();
    this._pendingScale = this.currentScale;
    this._flipHorizontal = this._readPlacementFlipHorizontal();
    this._flipVertical = this._readPlacementFlipVertical();
    this._flipRandomHorizontalEnabled = this._readPlacementFlipRandomHorizontalEnabled();
    this._flipRandomVerticalEnabled = this._readPlacementFlipRandomVerticalEnabled();
    this._flipRandomHorizontalOffset = false;
    this._flipRandomVerticalOffset = false;
    this._pendingFlipHorizontal = this._flipHorizontal;
    this._pendingFlipVertical = this._flipVertical;
    this._editingTile = null;
    this._isEditingExistingTile = false;
    this._pendingEditState = null;
    this._lastElevationUsed = 0;
    this._editingTileObject = null;
    this._editingTileVisibilitySnapshot = null;
    this._editingCommitTimer = null;
    this._editingCommitPromise = Promise.resolve();
    this._editingTileShadowSuspended = false;
    this._replaceOriginalOnPlace = false;
    this._installToolOptionsActivityListener();
    this._installDropShadowSettingsHook();
    this._syncToolOptionsState();
  }

  get _scatterSessionActive() { return this._scatterCommitSession.active; }
  set _scatterSessionActive(value) { this._scatterCommitSession.active = value; }

  get _scatterHistoryDirty() { return this._scatterCommitSession.dirty; }
  set _scatterHistoryDirty(value) { this._scatterCommitSession.dirty = value; }

  get _scatterQueuePromise() { return this._scatterCommitSession.queuePromise; }

  get _scatterModeBrush() { return ASSET_SCATTER_MODE_BRUSH; }

  get _scatterPreviewContainer() { return this._scatterPreviewGroupRuntime?.container || null; }
  set _scatterPreviewContainer(value) {
    if (this._scatterPreviewGroupRuntime) this._scatterPreviewGroupRuntime.container = value;
  }

  get _scatterPreviewGroups() { return this._scatterPreviewGroupRuntime?.groups || new Map(); }
  set _scatterPreviewGroups(value) {
    if (this._scatterPreviewGroupRuntime) this._scatterPreviewGroupRuntime.groups = value;
  }

  get _scatterPreviewActiveKey() { return this._scatterPreviewGroupRuntime?.activeKey || null; }
  set _scatterPreviewActiveKey(value) {
    if (this._scatterPreviewGroupRuntime) this._scatterPreviewGroupRuntime.activeKey = value;
  }

  get _scatterPreviewInstances() { return this._scatterPreviewGroupRuntime?.instances || []; }
  set _scatterPreviewInstances(value) {
    if (this._scatterPreviewGroupRuntime) this._scatterPreviewGroupRuntime.instances = value;
  }

  get _scatterPreviewSprites() { return this._scatterPreviewGroupRuntime?.sprites || new Map(); }
  set _scatterPreviewSprites(value) {
    if (this._scatterPreviewGroupRuntime) this._scatterPreviewGroupRuntime.sprites = value;
  }

  get _scatterPreviewTextures() { return this._scatterPreviewGroupRuntime?.textures || new Map(); }
  set _scatterPreviewTextures(value) {
    if (this._scatterPreviewGroupRuntime) this._scatterPreviewGroupRuntime.textures = value;
  }

  get _scatterPreviewTextureFailures() { return this._scatterPreviewGroupRuntime?.textureFailures || new Set(); }
  set _scatterPreviewTextureFailures(value) {
    if (this._scatterPreviewGroupRuntime) this._scatterPreviewGroupRuntime.textureFailures = value;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    try { this.cancelPlacement('destroy'); }
    catch (error) {
      Logger.warn('Placement.destroy.cancelFailed', { error: String(error?.message || error) });
    }

    this._clearEditingCommitTimer();
    try { this._clearElevationAnnounceTimer(); } catch (_) {}
    try { this._stopInteractionSession(); } catch (_) {}
    try { this._stopZoomWatcher(); } catch (_) {}
    try { this._removePreviewElement(); } catch (_) {}
    try { this._hideLoadingOverlay(); } catch (_) {}
    try { this._clearScatterOverlay(); } catch (_) {}
    try { this._clearScatterPreviewOverlay(); } catch (_) {}
    try { this._clearShadowOffsetPreview(); } catch (_) {}
    try { this._removePlacementFeedback(); } catch (_) {}
    try { this._deactivateToolOptions(); } catch (_) {}
    try { document?.removeEventListener?.(TOOL_OPTIONS_ACTIVITY_EVENT, this._boundToolOptionsActivity); } catch (_) {}

    const hooks = globalThis?.Hooks;
    if (hooks && typeof hooks.off === 'function' && this._dropShadowSettingsHook) {
      try { hooks.off('updateSetting', this._dropShadowSettingsHook); }
      catch (error) {
        Logger.warn('Placement.destroy.dropShadowHookRemoveFailed', { error: String(error?.message || error) });
      }
    }
    this._dropShadowSettingsHook = null;

    try { this._randomPrefetch?.reset?.(); }
    catch (error) {
      Logger.warn('Placement.destroy.prefetchResetFailed', { error: String(error?.message || error) });
    }
    this.app = null;
  }

  _handleDropShadowOffsetChange(distance, angle, commit = false) {
    const numericDistance = Number(distance);
    const numericAngle = Number(angle);
    if (!Number.isFinite(numericDistance) || !Number.isFinite(numericAngle)) {
      this._syncToolOptionsState();
      return false;
    }
    const clampedDistance = Math.min(this._getShadowOffsetMax(), Math.max(0, numericDistance));
    const normalizedAngle = this._normalizeShadowAngle(numericAngle);
    const distanceChanged = Math.abs(clampedDistance - this._dropShadowOffsetDistance) > 0.0005;
    const angleChanged = Math.abs(normalizedAngle - this._dropShadowOffsetAngle) > 0.0005;
    if (!distanceChanged && !angleChanged && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowOffsetDistance = clampedDistance;
    this._dropShadowOffsetAngle = normalizedAngle;
    this._updatePreviewShadow();
    this._syncScatterPreviewShadowSettingsForActiveElevation({ force: commit });
    if (commit) {
      this._persistShadowSetting('assetDropShadowOffsetDistance', clampedDistance);
      this._persistShadowSetting('assetDropShadowOffsetAngle', normalizedAngle);
    }
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowOffsetReset() {
    return this._handleDropShadowOffsetChange(
      DEFAULT_SHADOW_SETTINGS.offsetDistance,
      DEFAULT_SHADOW_SETTINGS.offsetAngle,
      true
    );
  }

  _handleDropShadowCollapseToggle() {
    this._shadowSettingsCollapsed = !this._shadowSettingsCollapsed;
    this._persistShadowCollapsed(this._shadowSettingsCollapsed);
    this._syncToolOptionsState({ suppressRender: false });
  }

  _handleDropShadowPresetAction(index, { save = false } = {}) {
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= SHADOW_PRESET_COUNT) {
      return false;
    }
    if (!Array.isArray(this._shadowPresets)) this._shadowPresets = this._loadShadowPresets();
    if (save) {
      const snapshot = this._normalizeShadowSnapshot(this._currentShadowSnapshot());
      if (!snapshot) {
        this._syncToolOptionsState();
        return false;
      }
      this._shadowPresets[idx] = snapshot;
      this._persistShadowPresets();
      this._syncToolOptionsState({ suppressRender: false });
      try { Logger.info('Placement.shadow.preset.save', { slot: idx + 1, snapshot }); } catch (_) {}
      return true;
    }

    const preset = this._shadowPresets[idx] || null;
    if (!preset) {
      try { ui.notifications?.warn?.('Preset slot is empty. Shift+Click a slot to save the current shadow settings.'); } catch (_) {}
      return false;
    }
    this._applyShadowSettingsSnapshot(preset, { persist: true, notify: true, propagate: true, sync: true, force: true });
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    return true;
  }

  _handleDropShadowReset() {
    this._applyShadowSettingsSnapshot(DEFAULT_SHADOW_SETTINGS, { persist: true, notify: true, propagate: true, sync: true, force: true });
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
  }

  _shouldAutoCommitScatter(reason) {
    if (!this._scatterMergeEnabled) return false;
    const normalized = String(reason || '');
    return (
      normalized === 'tab-switch'
      || normalized === 'tab-deactivate'
      || normalized === 'app-close'
      || normalized === 'canvas-teardown'
      || normalized === 'path-edit'
      || normalized === 'switch-mode'
    );
  }

  _autoCommitScatterSession(reason) {
    if (!this._shouldAutoCommitScatter(reason)) return false;
    if (this._scatterEditing) {
      void this._commitScatterEditChanges({ final: true });
      return true;
    }
    const groups = this._collectScatterCommitGroups();
    if (!groups.length) return false;
    void this._commitScatterGroups(groups);
    return true;
  }

  _hasScatterSessionChanges() {
    if (this._scatterEditing) return this._scatterCommitWorkflow.hasEditSessionChanges();
    return this._scatterCommitSession.hasChanges({
      enabled: this._scatterMergeEnabled,
      editing: this._scatterEditing,
      previewInstances: this._scatterPreviewInstances
    });
  }

  /** The Discard question of every editor (design A1); a second Escape while it is open answers Discard. */
  _confirmScatterCancel({ force = false } = {}) {
    return confirmHostedCancelSession({
      state: createHostedCancelSessionState(this),
      force,
      hasSessionChanges: () => this._hasScatterSessionChanges(),
      ...buildDiscardQuestionText('scatter'),
      logger: Logger,
      loggerPrefix: 'AssetPlacementManager'
    });
  }

  async _requestScatterCancel({ source = 'manual' } = {}) {
    if (!this._hasScatterSessionChanges()) {
      this.cancelPlacement('scatter-discard');
      return true;
    }
    const force = source === 'escape' && !!this._cancelConfirmPromise;
    const confirmed = await this._confirmScatterCancel({ force });
    if (!confirmed) return false;
    if (this._scatterEditing) {
      // The workflow reports a failed restore; the editor stays open with the Tile as it is.
      try { await this._scatterCommitWorkflow.discardEditChanges(); }
      catch (_) { return false; }
    }
    this.cancelPlacement('scatter-discard');
    return true;
  }

  async _handleEditorAction(actionId) {
    const id = String(actionId || '');
    switch (id) {
      case 'scatter-undo':
      case 'scatter-redo': {
        const applied = id === 'scatter-undo' ? this._undoScatterHistory() : this._redoScatterHistory();
        // Scatter Edit keeps the Tile in step with the editor after every stroke; a step back or forward is one too.
        // (A failed write is logged and notified by the workflow; the editor stays open on its preview.)
        if (applied && this._scatterEditing) await this._commitScatterEditChanges().catch(() => {});
        return applied;
      }
      case 'scatter-commit':
        if (this._scatterEditing) {
          const result = await this._commitScatterEditChanges({ final: true });
          if (result?.status === 'committed' || result?.status === 'noop' || result?.status === 'deleted') {
            if (result.status !== 'deleted') this._scatterCommitWorkflow.collapseEditSessionHistory();
            this.cancelPlacement('scatter-commit');
          }
          return result;
        }
        return this._commitScatterMergeSession().finally(() => {
          this.cancelPlacement('scatter-commit');
        });
      case 'scatter-discard':
        return this._requestScatterCancel({ source: 'manual' });
      default:
        return false;
    }
  }

  startPlacement(assetData, stickyMode = false, options = {}) {
    const controlledTiles = Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled.slice() : [];
    const initialElevation = resolveInitialFaNexusPlacementElevation({ fallback: this._lastElevationUsed });
    const placementSortAnchorTileId = this._capturePlacementSortAnchor(controlledTiles);
    try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
    const storedPreference = this._readDropShadowPreference();
    const preservedHsbc = cloneHsbc(this._hsbc);
    this.cancelPlacement('replace');
    this._replaceOriginalOnPlace = false;
    this._ensurePointerSnapshot(options);
    this._dropShadowPreference = storedPreference;
    this._hsbc = preservedHsbc || createNeutralHsbc();
    this._notifyDropShadowChanged();
    this.isPlacementActive = true;
    this.isStickyMode = stickyMode;
    this.currentAsset = assetData;
    this._placementSortAnchorTileId = placementSortAnchorTileId;
    this._placementSortBeforeAnchor = false;
    this.isRandomMode = false;
    this.randomAssets = [];
    this._pendingEditState = null;
    this._scatterMode = this._readStoredScatterMode();
    this._restorePlacementTransformState({ mode: this._scatterMode, regenerateOffsets: true });
    this._previewElevation = initialElevation;
    this._previewPlacementLevelId = this._normalizePlacementLevelId(
      this._placementSortAnchorPlacementLevelId || getDefaultTilePlacementLevelId()
    );
    this._adoptPlacementSortContext(this._resolvePlacementSortContext(initialElevation));
    this._lastElevationUsed = this._previewElevation;
    this._lastElevationAnnounce = 0;
    this._clearElevationAnnounceTimer();
    this._setScatterMode(this._scatterMode);
    this._syncPreviewOrdering();
    this._updateRandomPrefetchCount();
    this._activateToolOptions();
    try { Logger.info('Placement.start', { sticky: !!stickyMode, kind: 'single', asset: assetData?.filename || assetData?.path }); } catch (_) {}
    this._refreshShadowElevationContext({ adopt: true });
    this._activateTilesLayer();
    this._startInteractionSession();
    this._addPlacementFeedback();
    Promise.resolve(this._prepareCurrentAssetPreview({ initial: true })).catch((error) => {
      Logger.warn('Placement.prepare.failed', String(error?.message || error));
    });
  }

  async editTile(tileDocument, options = {}) {
    return this._editSession.editTile(tileDocument, options);
  }

  startPlacementRandom(assetList, stickyMode = true, options = {}) {
    try {
      if (!Array.isArray(assetList) || !assetList.length) { this.startPlacement(assetList?.[0], stickyMode, options); return; }
      const controlledTiles = Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled.slice() : [];
      const initialElevation = resolveInitialFaNexusPlacementElevation({ fallback: this._lastElevationUsed });
      const placementSortAnchorTileId = this._capturePlacementSortAnchor(controlledTiles);
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      const storedPreference = this._readDropShadowPreference();
      const preservedHsbc = cloneHsbc(this._hsbc);
      this.cancelPlacement('replace');
      this._ensurePointerSnapshot(options);
      this._dropShadowPreference = storedPreference;
      this._hsbc = preservedHsbc || createNeutralHsbc();
      this._notifyDropShadowChanged();
      this.isPlacementActive = true;
      this.isStickyMode = stickyMode;
      this.isRandomMode = true;
      this._placementSortAnchorTileId = placementSortAnchorTileId;
      this._placementSortBeforeAnchor = false;
      this.randomAssets = assetList.slice();
      this.currentAsset = null;
      try { this._randomPrefetch?.setPool?.(this.randomAssets); } catch (_) {}
      this._scatterMode = this._readStoredScatterMode();
      this._restorePlacementTransformState({ mode: this._scatterMode, regenerateOffsets: true });
      this._previewElevation = initialElevation;
      this._previewPlacementLevelId = this._normalizePlacementLevelId(
        this._placementSortAnchorPlacementLevelId || getDefaultTilePlacementLevelId()
      );
      this._adoptPlacementSortContext(this._resolvePlacementSortContext(initialElevation));
      this._lastElevationUsed = this._previewElevation;
      this._lastElevationAnnounce = 0;
      this._clearElevationAnnounceTimer();
      this._setScatterMode(this._scatterMode);
      this._syncPreviewOrdering();
      this._activateToolOptions();
      Logger.info('Placement.startRandom', { sticky: !!stickyMode, count: this.randomAssets.length });
      this._activateTilesLayer();
      this._refreshShadowElevationContext({ adopt: true });
      this._startInteractionSession();
      this._addPlacementFeedback();
      this._updateRandomPrefetchCount();
      try { this._randomPrefetch?.prime?.(); } catch (_) {}
      Promise.resolve(this._switchToNextRandomAsset(true)).catch((error) => {
        Logger.error('Placement.startRandom.switchFailed', { error: String(error?.message || error) });
      });
    } catch (error) {
      Logger.error('Placement.startRandom.failed', { error: String(error?.message || error) });
      throw error;
    }
  }

  async updatePlacementAssets(assetList, options = {}) {
    const list = Array.isArray(assetList)
      ? assetList.filter(Boolean)
      : (assetList ? [assetList] : []);
    if (!list.length) return false;
    if (!this.isPlacementActive || this._isEditingExistingTile) return false;
    this._ensurePointerSnapshot(options);
    const useRandom = list.length > 1;
    this.isRandomMode = useRandom;
    if (useRandom) {
      this.randomAssets = list.slice();
      this.currentAsset = null;
      try { this._randomPrefetch?.setPool?.(this.randomAssets); } catch (_) {}
      this._updateRandomPrefetchCount();
      try { this._randomPrefetch?.prime?.(); } catch (_) {}
      await this._switchToNextRandomAsset(true);
    } else {
      this.randomAssets = [];
      this.currentAsset = list[0] || null;
      try { this._randomPrefetch?.reset?.(); } catch (_) {}
      this._updateRandomPrefetchCount();
      await this._prepareCurrentAssetPreview();
    }
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  cancelPlacement(reason = 'user') {
    this._previewRuntime?.invalidatePendingLoads?.();
    this.queuedPlacement = null;
    const wasLayerEdit = this.isPlacementActive && this._isLayerEditSession();
    if (!this.isPlacementActive) {
      this._hsbc = createNeutralHsbc();
      this._setPlacementFreeze(false, { announce: false, sync: false });
      return;
    }
    this._autoCommitScatterSession(reason);
    this.isPlacementActive = false;
    this.isStickyMode = false;
    this._placementSortAnchorTileId = null;
    this._placementSortAnchorPlacementLevelId = null;
    this._restoreEditingTileVisibility();
    this._resumeEditingTileShadow();
    this._editingTileObject = null;
    this._editingTileVisibilitySnapshot = null;
    this._editingTileShadowSuspended = false;
    this._replaceOriginalOnPlace = false;
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    this.currentAsset = null;
    this._clearEditingCommitTimer();
    this._editingTile = null;
    this._isEditingExistingTile = false;
    this._pendingEditState = null;
    this.isRandomMode = false;
    this.randomAssets = [];
    this._scatterPainting = false;
    this._scatterLastPointerWorld = null;
    this._scatterStrokeDistance = 0;
    void this._endScatterPreviewShadowBatch({ awaitQueue: true });
    void this._endScatterShadowBatch({ awaitQueue: true });
    this._resetScatterMergeSession();
    this._resetScatterHistory();
    this._syncToolOptionsState({ suppressRender: false });
    this._clearScatterOverlay();
    this._scatterEditing = false;
    this._scatterEditTile = null;
    this._scatterEditState = null;
    this._scatterEditSessionStart = null;
    // The Scatter Preview row was moved in the Layer Manager during this edit: Apply writes its place.
    this._scatterEditPlacementMoved = false;
    this._scatterEditPointerLockScreen = null;
    this._scatterEraseEnabled = false;
    this._toolOptionsPreviewActive = false;
    this._toolOptionsPreviewRestoreWorld = null;
    if (this._scatterMergeBeforeEdit !== null) {
      this._scatterMergeEnabled = !!this._scatterMergeBeforeEdit;
      this._scatterMergeBeforeEdit = null;
    }
    this._rotationRandomEnabled = false;
    this._scaleRandomEnabled = false;
    const maintainToolUI = reason === 'replace' || reason === 'restart';
    if (!maintainToolUI) {
      this._deactivateToolOptions();
    }
    this.currentRotation = 0;
    this.currentScale = 1;
    this._rotationRandomMin = DEFAULT_ROTATION_RANDOM_MIN;
    this._rotationRandomMax = DEFAULT_ROTATION_RANDOM_MAX;
    this._pendingRotation = 0;
    this._scaleRandomMin = DEFAULT_SCALE_RANDOM_MIN;
    this._scaleRandomMax = DEFAULT_SCALE_RANDOM_MAX;
    this._pendingScale = 1;
    this._flipHorizontal = false;
    this._flipVertical = false;
    this._flipRandomHorizontalEnabled = false;
    this._flipRandomVerticalEnabled = false;
    this._flipRandomHorizontalOffset = false;
    this._flipRandomVerticalOffset = false;
    this._pendingFlipHorizontal = false;
    this._pendingFlipVertical = false;
    this._hsbc = createNeutralHsbc();
    this._updateRotationPreview();
    this._updateScalePreview();
    this._updateFlipPreview();
    this._removePreviewElement();
    this.isDownloading = false;
    this._hideLoadingOverlay();
    this._stopInteractionSession();
    this._removePlacementFeedback();
    this._clearElevationAnnounceTimer();
    this._lastElevationAnnounce = 0;
    this._setPlacementFreeze(false, { announce: false, sync: false });
    // Notify ESC-based cancellation so selection can be cleared by tab
    try {
      if (reason === 'esc') {
        const target = this.app?.element || document;
        target?.dispatchEvent?.(new CustomEvent('fa-nexus:placement-cancelled', { bubbles: true }));
      }
    } catch (_) {}
    // Reset prefetch state
    try { this._randomPrefetch?.reset?.(); Logger.info('Placement.queue.reset', { reason }); } catch (_) {}
    // An edit loaded the edited Tile's shadow into the tool; the next placement starts from the remembered one.
    if (wasLayerEdit) this._restoreRememberedShadowState();
    this._dropShadowPreference = this._readDropShadowPreference();
    this._notifyDropShadowChanged();
  }

  /**
   * True while an existing layer is edited (one Tile, or a Scatter Tile). The values the edit took from that layer
   * are the layer's, not the defaults for new layers, and are not remembered (design B2).
   */
  _isLayerEditSession() {
    return !!(this._isEditingExistingTile || this._isExistingTileReplaceSession() || this._scatterEditing);
  }

  /** The shadow values the constructor reads, read again from the client settings (the one authority). */
  _restoreRememberedShadowState() {
    this._dropShadowAlpha = this._readShadowSetting('assetDropShadowAlpha', 0.65, 0, 1);
    this._dropShadowDilation = this._readShadowSetting('assetDropShadowDilation', 1.6, 0, MAX_SHADOW_DILATION);
    this._dropShadowBlur = this._readShadowSetting('assetDropShadowBlur', 1.8, 0, MAX_SHADOW_BLUR);
    this._dropShadowOffsetMax = this._readShadowOffsetMax();
    this._dropShadowOffsetDistance = this._readShadowSetting('assetDropShadowOffsetDistance', 0, 0, this._getShadowOffsetMax());
    this._dropShadowOffsetAngle = this._readShadowSetting('assetDropShadowOffsetAngle', 135, 0, 359, { wrapAngle: true });
    this._dropShadowOnly = this._readDropShadowOnlySetting();
  }

  _getAssetBasePxPerSquare() { return 200; }

  _buildPlacementDropShadowPayload(settings = null, { shadowOnly = this._dropShadowOnly } = {}) {
    const source = settings || {
      alpha: this._dropShadowAlpha,
      dilation: this._dropShadowDilation,
      blur: this._dropShadowBlur,
      offsetDistance: this._dropShadowOffsetDistance,
      offsetAngle: this._dropShadowOffsetAngle
    };
    return {
      alpha: source.alpha,
      dilation: source.dilation,
      blur: source.blur,
      offsetDistance: source.offsetDistance,
      offsetAngle: source.offsetAngle,
      offsetVector: this._computeShadowOffsetVector(source.offsetDistance, source.offsetAngle),
      shadowOnly
    };
  }

  _buildPlacementTileData({
    assetPath,
    width,
    height,
    x,
    y,
    rotation = 0,
    sort = 0,
    elevation = this._previewElevation,
    flipState = null,
    encodedAssetPath = false,
    baseFlags = null,
    dropShadowEnabled = false,
    standardTileMask = null
  }) {
    const dropShadow = dropShadowEnabled ? this._buildPlacementDropShadowPayload() : null;
    const placementLevelId = this._resolveActivePlacementLevelId();
    return buildPlacementTileData({
      assetPath,
      width,
      height,
      x,
      y,
      rotation,
      sort,
      elevation,
      flipState,
      encodedAssetPath,
      baseFlags,
      hsbc: this._getPersistedHsbc(),
      dropShadow,
      standardTileMask,
      placementLevelId,
      encodeAssetPath: (path) => this._encodeAssetPath(path)
    });
  }

  _getHighestControlledTileElevation() {
    try {
      const controlled = Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : [];
      let highest = null;
      for (const tile of controlled) {
        const elevation = Number(tile?.document?.elevation ?? tile?.elevation);
        if (!Number.isFinite(elevation)) continue;
        if (highest === null || elevation > highest) highest = elevation;
      }
      return highest;
    } catch (error) {
      Logger.warn('Placement.scatterPreview.group.failed', {
        key,
        elevation,
        error: String(error?.message || error)
      });
      return null;
    }
  }

  /**
   * Apply grid snapping to world coordinates for asset placement
   * Uses half-grid increments for more precise positioning (corners, edges, centers)
   * @param {FaNexusPoint} worldCoords - World coordinates {x, y}
   * @returns {FaNexusPoint} Snapped coordinates {x, y}
   */
  _applyGridSnapping(worldCoords) {
    if (!canvas.grid || !canvas.scene || !this.currentAsset) {
      return worldCoords;
    }

    const gridSnapEnabled = typeof toolOptionsController?.isGridSnapEnabled === 'function'
      ? !!toolOptionsController.isGridSnapEnabled()
      : !!game.settings.get('fa-nexus', 'gridSnap');
    if (!gridSnapEnabled) {
      return worldCoords;
    }

    try {
      const gridSize = Number(canvas.scene.grid.size) || 0;
      const snapSubdivisions = typeof toolOptionsController?.getGridSnapSubdivisions === 'function'
        ? toolOptionsController.getGridSnapSubdivisions()
        : undefined;
      return snapPlacementPoint(worldCoords,{gridSize,subdivisions:snapSubdivisions});
    } catch (error) {
      console.warn('fa-nexus | Asset grid snapping failed, using raw coordinates:', error);
      return worldCoords;
    }
  }

  _getScatterBrushSize() {
    let size = Number(this._scatterBrushSize);
    if (!Number.isFinite(size)) size = SCATTER_BRUSH_SIZE_DEFAULT;
    const clamped = Math.min(SCATTER_BRUSH_SIZE_MAX, Math.max(SCATTER_BRUSH_SIZE_MIN, size));
    if (clamped !== this._scatterBrushSize) this._scatterBrushSize = clamped;
    return clamped;
  }

  _getScatterBrushRadius() {
    return this._getScatterBrushSize() / 2;
  }

  _getScatterDensity() {
    let density = Math.round(Number(this._scatterDensity));
    if (!Number.isFinite(density)) density = SCATTER_DENSITY_DEFAULT;
    const clamped = Math.min(SCATTER_DENSITY_MAX, Math.max(SCATTER_DENSITY_MIN, density));
    if (clamped !== this._scatterDensity) this._scatterDensity = clamped;
    return clamped;
  }

  _getScatterSprayDeviation() {
    let deviation = Number(this._scatterSprayDeviation);
    if (!Number.isFinite(deviation)) deviation = SCATTER_SPRAY_DEVIATION_DEFAULT;
    const clamped = Math.min(SCATTER_SPRAY_DEVIATION_MAX, Math.max(SCATTER_SPRAY_DEVIATION_MIN, deviation));
    if (clamped !== this._scatterSprayDeviation) this._scatterSprayDeviation = clamped;
    return clamped;
  }

  _getScatterSpacingPercent() {
    let spacing = Number(this._scatterSpacing);
    if (!Number.isFinite(spacing)) spacing = SCATTER_SPACING_DEFAULT;
    const clamped = Math.min(SCATTER_SPACING_MAX, Math.max(SCATTER_SPACING_MIN, spacing));
    if (clamped !== this._scatterSpacing) this._scatterSpacing = clamped;
    return clamped;
  }

  _getScatterSpacingWorld() {
    const spacingPercent = this._getScatterSpacingPercent();
    if (spacingPercent <= 0) return 0;
    const diameter = this._getScatterBrushRadius() * 2;
    return (spacingPercent / 100) * diameter;
  }

  _sampleScatterOffset(radiusX, radiusY) {
    return this._sampleScatterOffsetWithRandom(radiusX, radiusY, () => Math.random());
  }

  _sampleScatterOffsetWithRandom(radiusX, radiusY, randomFn = Math.random) {
    const deviation = this._getScatterSprayDeviation();
    const nextRandom = typeof randomFn === 'function' ? randomFn : Math.random;
    const theta = nextRandom() * Math.PI * 2;
    let distance = 0;
    if (deviation <= 0.5) {
      const blend = deviation / 0.5;
      const ring = 1 - SCATTER_RING_WIDTH * nextRandom();
      const uniform = Math.sqrt(nextRandom());
      distance = ring * (1 - blend) + uniform * blend;
    } else {
      const blend = (deviation - 0.5) / 0.5;
      const uniform = Math.sqrt(nextRandom());
      const center = Math.pow(nextRandom(), SCATTER_CENTER_POWER);
      distance = uniform * (1 - blend) + center * blend;
    }
    return {
      x: Math.cos(theta) * radiusX * distance,
      y: Math.sin(theta) * radiusY * distance
    };
  }

  _hashScatterPreviewSeed(parts = []) {
    const text = Array.isArray(parts)
      ? parts.map((part) => String(part ?? '')).join('|')
      : String(parts ?? '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  _createScatterPreviewRandom(seed) {
    let state = (Number(seed) || 0) >>> 0;
    return () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let result = Math.imul(state ^ (state >>> 15), 1 | state);
      result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
      return (((result ^ (result >>> 14)) >>> 0) / 4294967296);
    };
  }

  _sampleScatterPreviewRotation(randomFn = Math.random) {
    return samplePlacementRotationPreviewValue({
      baseRotation: this.currentRotation,
      randomEnabled: this._hasRandomRotationEnabled(),
      minValue: this._rotationRandomMin,
      maxValue: this._rotationRandomMax,
      randomFn
    });
  }

  _sampleScatterPreviewScale(randomFn = Math.random) {
    return samplePlacementScalePreviewValue({
      baseScale: this.currentScale,
      randomEnabled: this._hasRandomScaleEnabled(),
      minValue: this._scaleRandomMin,
      maxValue: this._scaleRandomMax,
      randomFn
    });
  }

  _sampleScatterPreviewFlipState(randomFn = Math.random) {
    return samplePlacementFlipState({
      baseHorizontal: this._flipHorizontal,
      baseVertical: this._flipVertical,
      randomHorizontalEnabled: this._flipRandomHorizontalEnabled,
      randomVerticalEnabled: this._flipRandomVerticalEnabled,
      randomFn
    });
  }

  _pickScatterPreviewAsset(randomFn = Math.random) {
    const canPreviewAsset = (asset) => !!asset && !this._assetRequiresDownload(asset) && !!(asset.cachedLocalPath || asset.path || asset.url);
    if (this.isRandomMode && Array.isArray(this.randomAssets) && this.randomAssets.length) {
      const previewable = this.randomAssets.filter(canPreviewAsset);
      if (!previewable.length) return canPreviewAsset(this.currentAsset) ? this.currentAsset : null;
      const index = Math.floor(randomFn() * previewable.length);
      return previewable[index] || (canPreviewAsset(this.currentAsset) ? this.currentAsset : null);
    }
    return canPreviewAsset(this.currentAsset) ? this.currentAsset : null;
  }

  _buildScatterHoverPreviewInstances(worldX, worldY) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return [];
    if (this._isScatterEraseActive()) return [];
    if (!this.currentAsset && (!this.isRandomMode || !Array.isArray(this.randomAssets) || !this.randomAssets.length)) {
      return [];
    }

    const brushRadius = this._getScatterBrushRadius();
    const density = this._getScatterDensity();
    const spacingWorld = this._getScatterSpacingWorld();
    const randomKeys = Array.isArray(this.randomAssets)
      ? this.randomAssets.slice(0, 12).map((asset) => this._assetKey(asset)).join(',')
      : '';
    const baseSeed = this._hashScatterPreviewSeed([
      this._assetKey(this.currentAsset),
      randomKeys,
      Math.round(brushRadius),
      density,
      Math.round(this._getScatterSprayDeviation() * 100),
      Math.round(spacingWorld),
      Math.round(this.currentRotation),
      this._rotationRandomEnabled ? 1 : 0,
      this._rotationRandomMin,
      this._rotationRandomMax,
      Math.round(this.currentScale * 100),
      this._scaleRandomEnabled ? 1 : 0,
      this._scaleRandomMin,
      this._scaleRandomMax,
      this._flipHorizontal ? 1 : 0,
      this._flipVertical ? 1 : 0,
      this._flipRandomHorizontalEnabled ? 1 : 0,
      this._flipRandomVerticalEnabled ? 1 : 0
    ]);

    const instances = [];
    for (let i = 0; i < density; i += 1) {
      const rng = this._createScatterPreviewRandom(this._hashScatterPreviewSeed([baseSeed, 'center', i]));
      const asset = this._pickScatterPreviewAsset(rng);
      if (!asset) continue;
      const offset = this._sampleScatterOffsetWithRandom(brushRadius, brushRadius, rng);
      const snapped = this._applyGridSnapping({
        x: worldX + offset.x,
        y: worldY + offset.y
      });
      const instance = this._buildScatterInstanceData(asset, snapped, {
        rotation: this._sampleScatterPreviewRotation(rng),
        scale: this._sampleScatterPreviewScale(rng),
        flip: this._sampleScatterPreviewFlipState(rng)
      });
      if (!instance) continue;
      instance.previewAlpha = SCATTER_HOVER_PREVIEW_PRIMARY_ALPHA;
      instances.push(instance);
    }

    return instances;
  }

  _normalizeRotation(value) {
    return normalizePlacementRotation(value);
  }

  _clampScaleRandomPercent(value, fallback = DEFAULT_SCALE_RANDOM_MIN) {
    return clampPlacementScaleRandomPercent(value, fallback);
  }

  _getDefaultScaleRandomRange(baseScale = this.currentScale) {
    return getDefaultPlacementScaleRandomRange(baseScale);
  }

  _getScaleRandomRange() {
    return getPlacementScaleRandomRange(this._scaleRandomMin, this._scaleRandomMax);
  }

  _sampleScaleRandomValue() {
    return samplePlacementScaleRandomValue(this._scaleRandomMin, this._scaleRandomMax);
  }

  _clampRotationRandomValue(value, fallback = DEFAULT_ROTATION_RANDOM_MIN) {
    return clampPlacementRotationRandomValue(value, fallback);
  }

  _getRotationRandomRange() {
    return getPlacementRotationRandomRange(this._rotationRandomMin, this._rotationRandomMax);
  }

  _sampleRotationRandomValue() {
    return samplePlacementRotationRandomValue(this._rotationRandomMin, this._rotationRandomMax);
  }

  _hasRandomRotationEnabled() {
    return !!this._rotationRandomEnabled;
  }

  _getPendingRotation() {
    const value = Number(this._pendingRotation);
    if (Number.isFinite(value)) return this._normalizeRotation(value);
    return this._normalizeRotation(this.currentRotation);
  }

  _applyPendingRotationToPreview() {
    try {
      const rotation = this._getPendingRotation();
      if (this._previewContainer?._sprite) {
        this._previewContainer._sprite.rotation = (rotation * Math.PI) / 180;
      }
      this._updatePreviewShadow();
      this._scheduleShadowOffsetPreviewUpdate();
      if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) this._updateScatterCursor();
    } catch (_) {}
  }

  _updateRotationPreview({ regenerateOffset = false, clampOffset = false } = {}) {
    const base = this._normalizeRotation(this.currentRotation);
    if (!this._hasRandomRotationEnabled()) {
      this._pendingRotation = base;
      this._applyPendingRotationToPreview();
      return;
    }
    const range = this._getRotationRandomRange();
    if (regenerateOffset || !Number.isFinite(this._pendingRotation)) {
      this._pendingRotation = this._sampleRotationRandomValue();
    } else if (clampOffset) {
      this._pendingRotation = Math.min(range.max, Math.max(range.min, this._normalizeRotation(this._pendingRotation)));
    }
    this._applyPendingRotationToPreview();
  }

  _prepareNextPlacementRotation() {
    if (!this.isPlacementActive) return;
    const regenerate = this._hasRandomRotationEnabled();
    this._updateRotationPreview({ regenerateOffset: regenerate, clampOffset: true });
    this._syncToolOptionsState();
  }

  _clampScale(value) {
    return clampPlacementScale(value);
  }

  _hasRandomScaleEnabled() {
    return !!this._scaleRandomEnabled;
  }

  _getPendingScale() {
    const value = Number(this._pendingScale);
    if (Number.isFinite(value)) return this._clampScale(value);
    return this._clampScale(this.currentScale);
  }

  _applyPendingScaleToPreview() {
    try {
      const scale = this._getPendingScale();
      if (this._previewContainer) {
        this._previewContainer._scaleMul = scale;
        this._applyZoomToPreview(canvas?.stage?.scale?.x || 1);
      }
      this._updatePreviewShadow();
      this._scheduleShadowOffsetPreviewUpdate();
      if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) this._updateScatterCursor();
    } catch (_) {}
  }

  _updateScalePreview({ regenerateOffset = false, clampOffset = false } = {}) {
    const base = this._clampScale(this.currentScale);
    if (!this._hasRandomScaleEnabled()) {
      this._pendingScale = base;
      this._applyPendingScaleToPreview();
      return;
    }
    const range = this._getScaleRandomRange();
    const minScale = this._clampScale(range.min / 100);
    const maxScale = this._clampScale(range.max / 100);
    if (regenerateOffset || !Number.isFinite(this._pendingScale)) {
      this._pendingScale = this._sampleScaleRandomValue();
    } else if (clampOffset) {
      this._pendingScale = Math.min(maxScale, Math.max(minScale, this._clampScale(this._pendingScale)));
    }
    this._applyPendingScaleToPreview();
  }

  _prepareNextPlacementScale() {
    if (!this.isPlacementActive) return;
    const regenerate = this._hasRandomScaleEnabled();
    this._updateScalePreview({ regenerateOffset: regenerate, clampOffset: true });
    this._syncToolOptionsState();
  }

  _hasRandomFlipEnabled() {
    return !!this._flipRandomHorizontalEnabled || !!this._flipRandomVerticalEnabled;
  }

  _getPendingFlipState() {
    return {
      horizontal: !!this._pendingFlipHorizontal,
      vertical: !!this._pendingFlipVertical
    };
  }

  _applyPendingFlipToPreview({ forceShadow = false, syncShadow = true } = {}) {
    try {
      const sprite = this._previewContainer?._sprite;
      if (!sprite) return;
      const currentX = Number(sprite.scale?.x ?? 1) || 1;
      const currentY = Number(sprite.scale?.y ?? 1) || 1;
      const magnitudeX = Math.abs(currentX) || 1;
      const magnitudeY = Math.abs(currentY) || 1;
      const signX = this._pendingFlipHorizontal ? -1 : 1;
      const signY = this._pendingFlipVertical ? -1 : 1;
      if (!Number.isFinite(sprite.scale.x) || sprite.scale.x !== magnitudeX * signX) {
        sprite.scale.x = magnitudeX * signX;
      }
      if (!Number.isFinite(sprite.scale.y) || sprite.scale.y !== magnitudeY * signY) {
        sprite.scale.y = magnitudeY * signY;
      }
      if (syncShadow) {
        if (forceShadow) this._updatePreviewShadow({ force: true });
        else this._updatePreviewShadow();
      }
      this._scheduleShadowOffsetPreviewUpdate();
      if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) this._updateScatterCursor();
    } catch (_) {}
  }

  _updateFlipPreview({ regenerateOffsets = false } = {}) {
    const baseHorizontal = !!this._flipHorizontal;
    const baseVertical = !!this._flipVertical;

    if (this._flipRandomHorizontalEnabled) {
      if (regenerateOffsets || this._flipRandomHorizontalOffset === null || this._flipRandomHorizontalOffset === undefined) {
        this._flipRandomHorizontalOffset = Math.random() < 0.5;
      }
      this._pendingFlipHorizontal = this._flipRandomHorizontalOffset ? !baseHorizontal : baseHorizontal;
    } else {
      this._flipRandomHorizontalOffset = false;
      this._pendingFlipHorizontal = baseHorizontal;
    }

    if (this._flipRandomVerticalEnabled) {
      if (regenerateOffsets || this._flipRandomVerticalOffset === null || this._flipRandomVerticalOffset === undefined) {
        this._flipRandomVerticalOffset = Math.random() < 0.5;
      }
      this._pendingFlipVertical = this._flipRandomVerticalOffset ? !baseVertical : baseVertical;
    } else {
      this._flipRandomVerticalOffset = false;
      this._pendingFlipVertical = baseVertical;
    }

    this._applyPendingFlipToPreview({ forceShadow: true });
  }

  _prepareNextPlacementFlip() {
    if (!this.isPlacementActive) return;
    const regenerate = this._hasRandomFlipEnabled();
    this._updateFlipPreview({ regenerateOffsets: regenerate });
    this._syncToolOptionsState();
  }

  _isGlobalDropShadowEnabled() {
    try { return !!game.settings.get('fa-nexus', 'assetDropShadow'); }
    catch (_) { return false; }
  }

  setDropShadowEnabled(enabled) {
    return this._handleDropShadowToggleRequest(enabled);
  }

  isDropShadowEnabled() {
    if (this._dropShadowPreference === null || this._dropShadowPreference === undefined) {
      return this._isGlobalDropShadowEnabled();
    }
    return !!this._dropShadowPreference;
  }

  _notifyDropShadowChanged() {
    try {
      const target = this.app?.element || document;
      target?.dispatchEvent?.(new CustomEvent('fa-nexus:drop-shadow-updated', { bubbles: true }));
    } catch (_) {}
    this._syncToolOptionsState();
  }

  _getCurrentHsbc() {
    return normalizeHsbc(this._hsbc);
  }

  _getPersistedHsbc() {
    return serializeHsbc(this._hsbc, { nullIfNeutral: true });
  }

  _buildHsbcToolState() {
    return buildHsbcToolOptionsState(this._hsbc, {
      available: this.isPlacementActive,
      hint: 'Adjust hue, saturation, brightness, and contrast for placed assets and scatter previews.'
    });
  }

  _applyPreviewHsbc() {
    try {
      applyHsbcToDisplayObject(
        this._previewContainer?._sprite,
        this._getPersistedHsbc(),
        { slot: 'asset-preview' }
      );
    } catch (_) {}
  }

  _applyScatterPreviewHsbc() {
    const hsbc = this._getPersistedHsbc();
    try {
      for (const sprite of this._scatterPreviewSprites.values()) {
        applyHsbcToDisplayObject(sprite, hsbc, { slot: 'asset-scatter-preview' });
      }
    } catch (_) {}
  }

  _applyPlacementHsbcPreview() {
    this._applyPreviewHsbc();
    this._applyScatterPreviewHsbc();
  }

  _setHsbc(nextValue, { sync = true, suppressRender = false } = {}) {
    const normalized = normalizeHsbc(nextValue);
    const current = normalizeHsbc(this._hsbc);
    const changed = !current
      || current.hue !== normalized.hue
      || current.saturation !== normalized.saturation
      || current.brightness !== normalized.brightness
      || current.contrast !== normalized.contrast;
    if (!changed) return true;
    this._hsbc = normalized;
    this._applyPlacementHsbcPreview();
    if (sync) this._syncToolOptionsState({ suppressRender });
    return true;
  }

  _activateToolOptions() {
    activatePlacementToolOptions({
      toolId: 'asset.placement',
      label: 'Asset Placement',
      syncToolOptions: (options) => this._syncToolOptionsState(options)
    });
  }

  _deactivateToolOptions() {
    deactivatePlacementToolOptions('asset.placement');
  }

  refreshToolOptions() {
    this._syncToolOptionsState({ suppressRender: false });
  }

  _installToolOptionsActivityListener() {
    try {
      document?.addEventListener?.(TOOL_OPTIONS_ACTIVITY_EVENT, this._boundToolOptionsActivity);
    } catch (_) {}
  }

  _handleToolOptionsActivity(event) {
    const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
    if (String(detail.toolId || '') !== 'asset.placement') {
      this._setToolOptionsPreviewActive(false);
      return;
    }
    this._setToolOptionsPreviewActive(!!detail.active);
  }

  _setToolOptionsPreviewActive(active) {
    const next = !!active && this.isPlacementActive && !this._isEditingExistingTile && !this._previewFrozen;
    if (this._toolOptionsPreviewActive === next) {
      if (next) this._applyPreviewAnchor(this._getPreviewAnchorWorld());
      return next;
    }
    if (next) {
      this._toolOptionsPreviewRestoreWorld = this._getPreviewAnchorWorld(null, { includeToolOptions: false });
      this._toolOptionsPreviewActive = true;
      this._applyPreviewAnchor(this._getPreviewAnchorWorld());
      return true;
    }
    const restoreWorld = this._toolOptionsPreviewRestoreWorld;
    this._toolOptionsPreviewActive = false;
    this._toolOptionsPreviewRestoreWorld = null;
    if (restoreWorld) {
      this._lastPointerWorld = { x: restoreWorld.x, y: restoreWorld.y };
      this._applyPreviewAnchor(restoreWorld);
    }
    return false;
  }

  _getViewportCenterWorldPosition() {
    try {
      const canvasEl = this._interactionController?.getCanvasElement?.() || document?.querySelector?.('canvas#board');
      const rect = canvasEl?.getBoundingClientRect?.();
      const fallbackX = (typeof window !== 'undefined' && Number.isFinite(window.innerWidth)) ? window.innerWidth / 2 : 0;
      const fallbackY = (typeof window !== 'undefined' && Number.isFinite(window.innerHeight)) ? window.innerHeight / 2 : 0;
      const screenX = rect ? rect.left + (rect.width / 2) : fallbackX;
      const screenY = rect ? rect.top + (rect.height / 2) : fallbackY;
      return this._screenToCanvas(screenX, screenY);
    } catch (_) {
      return null;
    }
  }

  _getPreviewAnchorWorld(fallbackWorld = null, { includeToolOptions = true } = {}) {
    const coerce = (point) => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      const world = { x: Number(point.x), y: Number(point.y) };
      return this.currentAsset ? this._applyGridSnapping(world) : world;
    };
    if (this._previewFrozen && this._frozenPreviewWorld) {
      // An edited asset waits where its Tile stands, which need not be on the grid.
      if (this._frozenPreviewExact) return { x: Number(this._frozenPreviewWorld.x), y: Number(this._frozenPreviewWorld.y) };
      return coerce(this._frozenPreviewWorld);
    }
    if (includeToolOptions && this._toolOptionsPreviewActive) {
      const centered = coerce(this._getViewportCenterWorldPosition());
      if (centered) return centered;
    }
    const fallback = coerce(fallbackWorld);
    if (fallback) return fallback;
    if (this._lastPointerWorld && Number.isFinite(this._lastPointerWorld.x) && Number.isFinite(this._lastPointerWorld.y)) {
      return coerce(this._lastPointerWorld);
    }
    if (this._previewContainer && Number.isFinite(this._previewContainer.x) && Number.isFinite(this._previewContainer.y)) {
      return coerce({
        x: Number(this._previewContainer.x),
        y: Number(this._previewContainer.y)
      });
    }
    if (this._lastPointer && Number.isFinite(this._lastPointer.x) && Number.isFinite(this._lastPointer.y)) {
      return coerce(this._screenToCanvas(this._lastPointer.x, this._lastPointer.y));
    }
    return null;
  }

  _applyPreviewAnchor(anchor) {
    if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return null;
    if (this._previewContainer) {
      this._previewContainer.x = anchor.x;
      this._previewContainer.y = anchor.y;
      this._previewShadowRenderer.syncPlacement(undefined, { reorder: false });
    }
    if (this._previewFrozen) {
      this._frozenPreviewWorld = { x: anchor.x, y: anchor.y };
      this._refreshFrozenPointerScreen();
    }
    if (this._loadingOverlay?.overlay) {
      const screen = this._previewFrozen
        ? (this._frozenPointerScreen || this._canvasToScreen(anchor.x, anchor.y))
        : this._canvasToScreen(anchor.x, anchor.y);
      if (screen) this._updateLoadingOverlayPointer(screen.x, screen.y);
    }
    if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) {
      this._updateScatterCursor(anchor.x, anchor.y);
    }
    return anchor;
  }

  _restorePlacementTransformState({ mode = this._scatterMode, regenerateOffsets = true } = {}) {
    const scopedMode = normalizePlacementTransformMode(mode);
    this.currentRotation = this._readPlacementRotation(scopedMode);
    this._rotationRandomEnabled = this._readPlacementRotationRandomEnabled(scopedMode);
    this._rotationRandomMin = this._readPlacementRotationRandomMin(scopedMode);
    this._rotationRandomMax = this._readPlacementRotationRandomMax(scopedMode);
    this._pendingRotation = this.currentRotation;
    this._updateRotationPreview({ regenerateOffset: regenerateOffsets && this._rotationRandomEnabled, clampOffset: true });

    this._scaleRandomEnabled = this._readPlacementScaleRandomEnabled(scopedMode);
    this._scaleRandomMin = this._readPlacementScaleRandomMin(scopedMode);
    this._scaleRandomMax = this._readPlacementScaleRandomMax(scopedMode);
    this.currentScale = this._readPlacementScale(scopedMode);
    this._pendingScale = this.currentScale;
    this._updateScalePreview({ regenerateOffset: regenerateOffsets && this._scaleRandomEnabled, clampOffset: true });

    this._flipHorizontal = this._readPlacementFlipHorizontal(scopedMode);
    this._flipVertical = this._readPlacementFlipVertical(scopedMode);
    this._flipRandomHorizontalEnabled = this._readPlacementFlipRandomHorizontalEnabled(scopedMode);
    this._flipRandomVerticalEnabled = this._readPlacementFlipRandomVerticalEnabled(scopedMode);
    this._flipRandomHorizontalOffset = this._flipRandomHorizontalEnabled ? null : false;
    this._flipRandomVerticalOffset = this._flipRandomVerticalEnabled ? null : false;
    this._pendingFlipHorizontal = this._flipHorizontal;
    this._pendingFlipVertical = this._flipVertical;
    this._updateFlipPreview({ regenerateOffsets: regenerateOffsets && this._hasRandomFlipEnabled() });
  }

  _buildToolOptionsState() {
    const existingTileCommitSupported = this._isExistingTileReplaceSession();
    const globalEnabled = this._isGlobalDropShadowEnabled();
    const preference = this.isDropShadowEnabled();
    const dropShadowEnabled = globalEnabled ? !!preference : false;
    const tooltip = globalEnabled
      ? 'Toggle drop shadows for tiles placed during this session.'
      : 'Enable drop shadows in FA Nexus settings to use this toggle.';
    const hint = globalEnabled
      ? ''
      : 'Enable drop shadows in the FA Nexus module settings to unlock this toggle.';
    const freezeHint = this._previewFrozen
      ? 'Preview frozen — press Space to resume following your cursor.'
      : 'Press Space to freeze the preview while adjusting sliders.';
    const hints = [
      'Click to place; ESC to cancel.',
      'Ctrl/Cmd+Wheel rotates (add Shift for 1° steps);',
      'Shift+Wheel scales;',
      'Alt+Wheel, Alt+[ / ], or Alt+Up / Down adjust elevation (0.001; add Shift for 0.1).',
      'Ctrl/Cmd+Alt+Wheel moves the preview one layer through the current depth level.',
      'Tap S to toggle grid snap; hold S and scroll to change subgrid density.',
      freezeHint
    ];
    const subtoolToggles = this._buildScatterSubtoolToggles();
    const assetScatter = this._buildScatterBrushState();
    const customToggles = this._buildScatterCustomToggles();
    const editorActions = this._buildScatterEditorActions();
    if (existingTileCommitSupported) {
      hints.unshift('Editing existing tile: press Ctrl/Cmd+S to apply changes or click the canvas to commit.');
    }
    if (assetScatter.available) {
      hints.unshift('Scatter mode: drag to paint asset stamps.');
      if (this._scatterEditing) hints.unshift('Editing scatter tile: drag to add, toggle eraser to remove.');
      if (this._scatterMergeEnabled) hints.push('Press Ctrl/Cmd+S to commit the scatter session.');
      if (this._scatterMergeEnabled) hints.push('Press E to toggle scatter erase; hold Alt to invert it temporarily.');
    }
    return {
      dropShadow: {
        available: true,
        enabled: dropShadowEnabled,
        disabled: !globalEnabled,
        tooltip,
        hint
      },
      dropShadowControls: this._buildDropShadowControlsState({
        available: true,
        enabled: dropShadowEnabled
      }),
      subtoolToggles,
      customToggles,
      editorActions,
      flip: this._buildFlipToolState(),
      elevation: this._buildElevationToolState(),
      scale: this._buildScaleToolState(),
      rotation: this._buildRotationToolState(),
      hsbc: this._buildHsbcToolState(),
      assetScatter,
      hints
    };
  }

  _buildToolOptionsDescriptor() {
    const legacyState = this._buildToolOptionsState();
    const polaritySupported = this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterMergeEnabled;
    const existingTileCommitSupported = this._isExistingTileReplaceSession();
    const activeSubtool = this._scatterMode === ASSET_SCATTER_MODE_BRUSH ? 'scatter' : 'single';
    const { controls, sections } = this._buildDeclarativeToolOptionsConfig(legacyState);
    const shortcuts = [
      createShortcut(SHORTCUT_ACTION.HELP, {
        label: 'Help',
        description: 'Open contextual tool help.'
      }),
      createShortcut(SHORTCUT_ACTION.CANCEL, {
        label: 'Cancel',
        description: 'Cancel asset placement.'
      }),
      createShortcut(SHORTCUT_ACTION.TOGGLE_GRID_SNAP, {
        label: 'Grid Snap',
        description: 'Tap to toggle grid snapping.'
      }),
      createShortcut(SHORTCUT_ACTION.ADJUST_GRID_SNAP, {
        label: 'Grid Density',
        description: 'Hold while scrolling to adjust subgrid density without toggling snap.'
      }),
      createShortcut('rotate-preview', {
        binding: 'Ctrl/Cmd+Wheel',
        label: 'Rotate',
        description: 'Rotate the preview; add Shift for 1° steps.'
      }),
      createShortcut('scale-preview', {
        binding: 'Shift+Wheel',
        label: 'Scale',
        description: 'Scale the preview before placement.'
      }),
      createShortcut('adjust-elevation-wheel', {
        binding: 'Alt+Wheel',
        label: 'Elevation Wheel',
        description: 'Adjust elevation by 0.001; add Shift for 0.1.'
      }),
      createShortcut('adjust-layer-order-wheel', {
        binding: 'Ctrl/Cmd+Alt+Wheel',
        label: 'Layer Order',
        description: 'Move the preview one layer up or down within the current depth level.'
      }),
      createShortcut('adjust-elevation-keys', {
        binding: 'Alt+[ / ] or Alt+Up / Down',
        label: 'Elevation Keys',
        description: 'Nudge elevation with the same step modifiers as Alt+Wheel.'
      }),
      createShortcut('toggle-preview-freeze', {
        binding: 'Space',
        label: 'Freeze Preview',
        description: 'Toggle whether the preview follows your cursor.'
      })
    ];
    if (polaritySupported || existingTileCommitSupported) {
      shortcuts.splice(1, 0, createShortcut(SHORTCUT_ACTION.COMMIT, {
        label: 'Commit',
        description: polaritySupported
          ? 'Commit the current scatter session.'
          : 'Commit the current tile edit.'
      }));
    }
    if (polaritySupported) {
      shortcuts.splice(
        2,
        0,
        createShortcut(SHORTCUT_ACTION.UNDO, {
          label: 'Undo',
          description: 'Undo the last scatter stroke.'
        }),
        createShortcut(SHORTCUT_ACTION.REDO, {
          label: 'Redo',
          description: 'Redo the last undone scatter stroke.'
        }),
        createShortcut(SHORTCUT_ACTION.TOGGLE_POLARITY, {
          label: 'Scatter Eraser',
          description: 'Toggle scatter erase mode.'
        }),
        createShortcut(SHORTCUT_ACTION.TEMPORARY_INVERT_POLARITY, {
          label: 'Invert Eraser',
          description: 'Temporarily invert scatter erase mode while held.'
        })
      );
    }
    return createNormalizedToolOptionsDescriptor({
      rendererMode: TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE,
      descriptor: {
        toolId: 'asset.placement',
        toolLabel: 'Asset Placement',
        activeMode: activeSubtool,
        activeSubtool,
        polarity: {
          supported: polaritySupported,
          base: polaritySupported
            ? (this._scatterEraseEnabled ? 'erase' : 'paint')
            : null,
          effective: polaritySupported
            ? resolveEffectivePolarity(this._scatterEraseEnabled ? 'erase' : 'paint', this._scatterPolarityInvertHeld)
            : null,
          inverted: polaritySupported && this._scatterPolarityInvertHeld
        },
        dirty: !!(this._scatterHistoryDirty || this._scatterSessionActive),
        selectionSummary: this._scatterEditing
          ? `${this._scatterPreviewInstances?.length || 0} scatter instances in edit`
          : (this.currentAsset?.name || this.currentAsset?.filename || null),
        helpTopicId: 'asset-placement'
      },
      legacyState,
      controls,
      sections,
      handlers: this._buildToolOptionsHandlers(),
      shortcuts,
      sessionState: {
        scatterMode: activeSubtool,
        scatterEditing: !!this._scatterEditing,
        scatterMergeEnabled: !!this._scatterMergeEnabled,
        dirty: !!(this._scatterHistoryDirty || this._scatterSessionActive),
        previewFrozen: !!this._previewFrozen
      },
      renderState: {
        previewElevation: Number.isFinite(this._previewElevation) ? this._previewElevation : 0,
        previewSort: Number.isFinite(this._previewSort) ? this._previewSort : 0,
        scatterPreviewCount: Array.isArray(this._scatterPreviewInstances) ? this._scatterPreviewInstances.length : 0
      },
      persistedState: {
        documentFlags: ['flags.fa-nexus.hsbc'],
        scatterDefaults: {
          brushSize: this._scatterBrushSize,
          density: this._scatterDensity,
          sprayDeviation: this._scatterSprayDeviation,
          spacing: this._scatterSpacing
        },
        dropShadowPreference: this._dropShadowPreference
      }
    });
  }

  _buildDeclarativeToolOptionsConfig(legacyState = {}) {
    const controls = {};
    const sections = [];
    const addRangeControl = (config) => addDeclarativeRangeControl(controls, config);
    const addAxisTogglePairControl = (config) => addDeclarativeAxisTogglePairControl(controls, config);
    const addScalarRandomizedControl = (config) => addDeclarativeScalarRandomizedControl(controls, config);
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

    const scatterOptions = Array.isArray(legacyState?.customToggles)
      ? legacyState.customToggles.filter((toggle) => String(toggle?.group || '') === 'subtool-option')
      : [];
    if (scatterOptions.length) {
      controls['scatter-options'] = {
        id: 'scatter-options',
        type: 'toggle-list',
        items: scatterOptions
      };
      modeSectionControlIds.push('scatter-options');
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

    if (legacyState?.assetScatter?.available) {
      const scatterControlIds = [];
      const scatterState = legacyState.assetScatter;
      scatterControlIds.push(addRangeControl({
        id: 'scatter-brush-size',
        label: 'Size',
        state: scatterState.brushSize,
        handlerId: 'setScatterBrushSize',
        compact: true,
        ariaLabel: 'Scatter size'
      }));
      scatterControlIds.push(addRangeControl({
        id: 'scatter-density',
        label: 'Density',
        state: scatterState.density,
        handlerId: 'setScatterDensity',
        compact: true,
        ariaLabel: 'Scatter density'
      }));
      scatterControlIds.push(addRangeControl({
        id: 'scatter-spray',
        label: 'Deviation',
        state: scatterState.sprayDeviation,
        handlerId: 'setScatterSprayDeviation',
        compact: true,
        ariaLabel: 'Scatter deviation'
      }));
      scatterControlIds.push(addRangeControl({
        id: 'scatter-spacing',
        label: 'Spacing',
        state: scatterState.spacing,
        handlerId: 'setScatterSpacing',
        compact: true,
        ariaLabel: 'Scatter spacing'
      }));
      if (typeof scatterState.hint === 'string' && scatterState.hint.trim().length) {
        controls['scatter-brush-hint'] = {
          id: 'scatter-brush-hint',
          type: 'hint',
          text: scatterState.hint
        };
        scatterControlIds.push('scatter-brush-hint');
      }
      sections.push({
        id: 'brush-geometry',
        label: 'Scatter Brush Settings',
        controls: scatterControlIds.filter(Boolean)
      });
    }

    const transformControlIds = [];
    if (legacyState?.elevation?.available) {
      transformControlIds.push(addRangeControl({
        id: 'asset-elevation',
        label: 'Elevation',
        state: legacyState.elevation,
        handlerId: 'setElevation',
        inputOnly: true,
        ariaLabel: 'Asset placement elevation'
      }));
    }
    if (legacyState?.scale?.available) {
      transformControlIds.push(addScalarRandomizedControl({
        id: 'asset-scale',
        variant: 'scale',
        label: 'Scale',
        ariaLabel: 'Scale',
        state: legacyState.scale,
        handlerId: 'setScale',
        randomHandlerId: 'toggleScaleRandom',
        randomMinHandlerId: 'setScaleRandomMin',
        randomMaxHandlerId: 'setScaleRandomMax'
      }));
    }
    if (legacyState?.rotation?.available) {
      transformControlIds.push(addScalarRandomizedControl({
        id: 'asset-rotation',
        variant: 'rotation',
        label: 'Rotation',
        ariaLabel: 'Rotation',
        state: legacyState.rotation,
        handlerId: 'setRotation',
        randomHandlerId: 'toggleRotationRandom',
        randomMinHandlerId: 'setRotationRandomMin',
        randomMaxHandlerId: 'setRotationRandomMax'
      }));
    }
    if (legacyState?.flip?.available) {
      transformControlIds.push(addAxisTogglePairControl({
        id: 'asset-flip',
        label: 'Flip / Mirror',
        state: legacyState.flip,
        horizontalHandlerId: 'toggleFlipHorizontal',
        verticalHandlerId: 'toggleFlipVertical',
        horizontalRandomHandlerId: 'toggleFlipHorizontalRandom',
        verticalRandomHandlerId: 'toggleFlipVerticalRandom'
      }));
    }
    if (transformControlIds.length) {
      sections.push({
        id: 'transform',
        label: 'Transform',
        controls: transformControlIds.filter(Boolean)
      });
    }
    buildHsbcToolOptionsControls({
      state: legacyState?.hsbc,
      controls,
      sections,
      addRangeControl,
      sectionId: 'color',
      sectionLabel: 'Color',
      idPrefix: 'asset-hsbc',
      ariaPrefix: 'Asset HSBC'
    });

    if (legacyState?.dropShadow?.available || legacyState?.dropShadowControls?.available) {
      controls['asset-drop-shadow'] = {
        id: 'asset-drop-shadow',
        type: 'drop-shadow',
        toggle: legacyState.dropShadow || {},
        controls: legacyState.dropShadowControls || {}
      };
      sections.push({
        id: 'drop-shadow',
        label: 'Drop Shadow',
        controls: ['asset-drop-shadow']
      });
    }

    const editorActions = Array.isArray(legacyState?.editorActions)
      ? legacyState.editorActions.filter((action) => action && typeof action === 'object')
      : [];
    if (editorActions.length) {
      controls['session-actions'] = {
        id: 'session-actions',
        type: 'action-row',
        actions: editorActions
      };
      sections.push({
        id: 'session',
        label: 'Session',
        region: 'footer',
        collapsible: false,
        controls: ['session-actions']
      });
    }

    return { controls, sections };
  }

  _buildToolOptionsHandlers() {
    return {
      ...buildHsbcToolOptionsHandlers({
        getHsbc: () => this._hsbc,
        setHsbc: (next, { commit } = {}) => this._setHsbc(next, { sync: true, suppressRender: !commit })
      }),
      customToggles: {
        'asset-placement-single': (enabled) => {
          if (!enabled) return true;
          return this._setScatterMode(ASSET_SCATTER_MODE_SINGLE);
        },
        'asset-placement-scatter': (enabled) => {
          if (!enabled) return true;
          return this._setScatterMode(ASSET_SCATTER_MODE_BRUSH);
        },
        'asset-scatter-eraser': (enabled) => this.setScatterEraserEnabled(enabled)
      },
      setDropShadowEnabled: (value) => this._handleDropShadowToggleRequest(value),
      setDropShadowAlpha: (value, commit) => this._handleDropShadowAlphaChange(value, commit),
      setDropShadowDilation: (value, commit) => this._handleDropShadowDilationChange(value, commit),
      setDropShadowBlur: (value, commit) => this._handleDropShadowBlurChange(value, commit),
      setDropShadowOffset: (distance, angle, commit) => this._handleDropShadowOffsetChange(distance, angle, commit),
      setDropShadowOffsetDistance: (value, commit) => this._handleDropShadowOffsetDistanceChange(value, commit),
      setDropShadowOffsetMax: (value, commit) => this._handleDropShadowOffsetMaxChange(value, commit),
      setDropShadowOffsetAngle: (value, commit) => this._handleDropShadowOffsetAngleChange(value, commit),
      setDropShadowOnly: (enabled) => this._handleDropShadowOnlyToggle(enabled),
      toggleDropShadowCollapsed: () => this._handleDropShadowCollapseToggle(),
      handleDropShadowPreset: (index, save) => this._handleDropShadowPresetAction(index, { save: !!save }),
      resetDropShadowOffset: () => this._handleDropShadowOffsetReset(),
      resetDropShadow: () => this._handleDropShadowReset(),
      handleEditorAction: (actionId) => this._handleEditorAction(actionId),
      toggleFlipHorizontal: () => this._handleFlipHorizontalToggle(),
      toggleFlipVertical: () => this._handleFlipVerticalToggle(),
      toggleFlipHorizontalRandom: () => this._handleFlipRandomHorizontalToggle(),
      toggleFlipVerticalRandom: () => this._handleFlipRandomVerticalToggle(),
      setElevation: (value, commit) => this._handleElevationInput(value, commit),
      setScale: (value) => this._handleScaleSliderInput(value),
      toggleScaleRandom: () => this._handleScaleRandomToggle(),
      setScaleRandomMin: (value) => this._handleScaleRandomMin(value),
      setScaleRandomMax: (value) => this._handleScaleRandomMax(value),
      setRotation: (value) => this._handleRotationSliderInput(value),
      toggleRotationRandom: () => this._handleRotationRandomToggle(),
      setRotationRandomMin: (value) => this._handleRotationRandomMin(value),
      setRotationRandomMax: (value) => this._handleRotationRandomMax(value),
      setScatterBrushSize: (value, commit) => this.setScatterBrushSize(value, commit),
      setScatterDensity: (value, commit) => this.setScatterDensity(value, commit),
      setScatterSprayDeviation: (value, commit) => this.setScatterSprayDeviation(value, commit),
      setScatterSpacing: (value, commit) => this.setScatterSpacing(value, commit)
    };
  }

  _getScatterBasePolarity() {
    return this._scatterEraseEnabled ? 'erase' : 'paint';
  }

  _isScatterEraseActive() {
    if (!this._scatterMergeEnabled) return false;
    return resolveEffectivePolarity(this._getScatterBasePolarity(), this._scatterPolarityInvertHeld) === 'erase';
  }

  _setScatterPolarityInvertHeld(active, { sync = false } = {}) {
    const next = !!active;
    if (this._scatterPolarityInvertHeld === next) return next;
    this._scatterPolarityInvertHeld = next;
    if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) this._updateScatterCursor();
    if (sync) this._syncToolOptionsState();
    return next;
  }

  _refreshPlacementAfterGridSnapChange() {
    try {
      this._applyPreviewAnchor(this._getPreviewAnchorWorld());
    } catch (_) {}
  }

  _resolveElevationStep({ shiftKey = false, ctrlKey = false, metaKey = false } = {}) {
    if (shiftKey) return ELEVATION_STEP_COARSE;
    if (ctrlKey || metaKey) return ELEVATION_STEP_FINE;
    return ELEVATION_STEP_DEFAULT;
  }

  _getElevationShortcutDirection(event = null) {
    const code = String(event?.code || '');
    if (code === 'BracketRight' || code === 'ArrowUp') return 1;
    if (code === 'BracketLeft' || code === 'ArrowDown') return -1;
    return 0;
  }

  _getElevationAnnouncePoint(fallbackWorld = null) {
    return this._getPreviewAnchorWorld(fallbackWorld, { includeToolOptions: true });
  }

  _setPreviewElevation(value, {
    announce = true,
    immediate = false,
    syncToolOptions = true,
    worldPoint = null
  } = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      if (syncToolOptions) this._syncToolOptionsState();
      return false;
    }
    const next = quantizeElevation(numeric);
    if (next === this._previewElevation) {
      if (syncToolOptions) this._syncToolOptionsState();
      return false;
    }
    this._previewElevation = next;
    this._lastElevationUsed = next;
    this._syncPreviewOrdering();
    this._refreshShadowElevationContext({ adopt: true });
    if (syncToolOptions) this._syncToolOptionsState();
    if (announce) {
      this._announcePreviewElevation(this._getElevationAnnouncePoint(worldPoint), { immediate });
    }
    return true;
  }

  _buildScatterSubtoolToggles() {
    if (!this.isPlacementActive) return [];
    const scatterActive = this._scatterMode === ASSET_SCATTER_MODE_BRUSH;
    const disabled = !!this._isEditingExistingTile || this._scatterEditing;
    return [
      {
        id: 'asset-placement-single',
        group: 'subtool',
        label: 'Single',
        tooltip: 'Place one asset at a time.',
        enabled: !scatterActive,
        disabled
      },
      {
        id: 'asset-placement-scatter',
        group: 'subtool',
        label: 'Scatter',
        tooltip: 'Paint to scatter multiple assets per stamp.',
        enabled: scatterActive,
        disabled
      }
    ];
  }

  _buildScatterBrushState() {
    if (!this.isPlacementActive || this._isEditingExistingTile || this._scatterMode !== ASSET_SCATTER_MODE_BRUSH) {
      return { available: false };
    }
    const brushSize = Math.round(this._getScatterBrushSize());
    const density = Math.round(this._getScatterDensity());
    const sprayPercent = Math.round(this._getScatterSprayDeviation() * 100);
    const spacingPercent = Math.round(this._getScatterSpacingPercent());
    return {
      available: true,
      brushSize: {
        min: SCATTER_BRUSH_SIZE_MIN,
        max: SCATTER_BRUSH_SIZE_MAX,
        step: 1,
        value: brushSize,
        defaultValue: SCATTER_BRUSH_SIZE_DEFAULT,
        display: `${brushSize}px`,
        tooltip: 'Diameter of the scatter brush in scene pixels.'
      },
      density: {
        min: SCATTER_DENSITY_MIN,
        max: SCATTER_DENSITY_MAX,
        step: 1,
        value: density,
        defaultValue: SCATTER_DENSITY_DEFAULT,
        display: density === 1 ? '1' : `${density}x`,
        tooltip: 'How many assets each scatter stamp places.'
      },
      sprayDeviation: {
        min: 0,
        max: 100,
        step: 1,
        value: sprayPercent,
        defaultValue: Math.round(SCATTER_SPRAY_DEVIATION_DEFAULT * 100),
        display: `${sprayPercent}%`,
        tooltip: 'Bias the scatter toward the edge or the center. 0% favors the edge, 50% is balanced, and 100% favors the center.'
      },
      spacing: {
        min: SCATTER_SPACING_MIN,
        max: SCATTER_SPACING_MAX,
        step: 1,
        value: spacingPercent,
        defaultValue: SCATTER_SPACING_DEFAULT,
        display: `${spacingPercent}%`,
        tooltip: 'Distance between repeated scatter stamps as a percent of the brush diameter.'
      },
      hint: 'Size sets the brush diameter. Density is assets per stamp. Deviation shifts scatter toward the edge or center. Spacing sets the distance between stamp groups.'
    };
  }

  _buildScatterCustomToggles() {
    if (!this.isPlacementActive || this._scatterMode !== ASSET_SCATTER_MODE_BRUSH) return [];
    const toggles = [];
    if (this._scatterMergeEnabled) {
      toggles.push({
        id: 'asset-scatter-eraser',
        group: 'subtool-option',
        label: 'Scatter Eraser',
        tooltip: 'Remove scattered assets with the brush during merge sessions.',
        enabled: !!this._scatterEraseEnabled,
        disabled: false
      });
    }
    return toggles;
  }

  _buildScatterEditorActions() {
    if (!this.isPlacementActive || this._scatterMode !== ASSET_SCATTER_MODE_BRUSH || !this._scatterMergeEnabled) {
      return [];
    }
    const hasInstances = Array.isArray(this._scatterPreviewInstances) && this._scatterPreviewInstances.length > 0;
    const canUndo = this._canUndoScatterHistory();
    const canRedo = this._canRedoScatterHistory();
    // An edit can always be applied or cancelled, also with every instance erased: Apply then deletes the Tile.
    const canCommit = this._scatterEditing
      ? true
      : (this._scatterSessionActive && hasInstances);
    // The same two buttons as the other editors (design A1): Commit, and Cancel that discards.
    const commitLabel = 'Commit';
    const commitTooltip = this._scatterEditing
      ? (hasInstances
        ? 'Commit the scatter edits to the tile.'
        : 'Every instance is erased: Commit deletes the Scatter tile. Undo or Cancel keeps it.')
      : 'Commit the scattered stamps to a tile.';
    const discardLabel = 'Cancel';
    const discardTooltip = 'Discard the current session.';
    return [
      {
        id: 'scatter-undo',
        label: 'Undo',
        tooltip: 'Undo the last scatter stroke.',
        primary: false,
        disabled: !canUndo
      },
      {
        id: 'scatter-redo',
        label: 'Redo',
        tooltip: 'Redo the last undone scatter stroke.',
        primary: false,
        disabled: !canRedo
      },
      {
        id: 'scatter-commit',
        label: commitLabel,
        tooltip: commitTooltip,
        primary: true,
        disabled: !canCommit
      },
      {
        id: 'scatter-discard',
        label: discardLabel,
        tooltip: discardTooltip,
        primary: false,
        disabled: !this._scatterEditing && !hasInstances && !this._scatterSessionActive
      }
    ];
  }

  _togglePlacementFreeze() {
    return this._setPlacementFreeze(!this._previewFrozen);
  }

  _setPlacementFreeze(enabled, { announce = true, sync = true } = {}) {
    const next = !!enabled;
    this._frozenPreviewExact = false;
    if (next) {
      if (!this.isPlacementActive || this._isEditingExistingTile) {
        if (sync) this._syncToolOptionsState();
        return false;
      }
      const anchor = this._getPreviewWorldPosition();
      if (!anchor) {
        if (announce) {
          announceChange('asset-placement-freeze', 'Preview not ready to freeze yet.', { throttleMs: 1200, level: 'info' });
        }
        if (sync) this._syncToolOptionsState();
        return false;
      }
      const snapped = this._applyGridSnapping(anchor);
      this._previewFrozen = true;
      this._frozenPreviewWorld = { x: snapped.x, y: snapped.y };
      this._lastPointerWorld = { x: snapped.x, y: snapped.y };
      this._toolOptionsPreviewActive = false;
      this._toolOptionsPreviewRestoreWorld = null;
      this._refreshFrozenPointerScreen();
      this._applyPreviewAnchor(snapped);
      this._applyPlacementFreezeClass();
      if (announce) {
        announceChange('asset-placement-freeze', 'Preview frozen. Press Space again to unlock.', { throttleMs: 2000 });
      }
      if (sync) this._syncToolOptionsState();
      return true;
    }

    const wasFrozen = this._previewFrozen;
    this._previewFrozen = false;
    this._frozenPreviewWorld = null;
    this._frozenPointerScreen = null;
    this._applyPlacementFreezeClass();
    if (announce && wasFrozen) {
      announceChange('asset-placement-freeze', 'Preview following the cursor again.', { throttleMs: 2000 });
    }
    if (this._loadingOverlay?.overlay && this._lastPointer) {
      this._updateLoadingOverlayPointer(this._lastPointer.x, this._lastPointer.y);
    }
    if (sync) this._syncToolOptionsState();
    return true;
  }

  _getPreviewWorldPosition() {
    return this._getPreviewAnchorWorld();
  }

  _isExistingTileReplaceSession() {
    return !!(this.isPlacementActive && this._replaceOriginalOnPlace && this._editingTile);
  }

  _getExistingTileReplaceCommitTarget() {
    if (!this._isExistingTileReplaceSession()) return null;
    const fallbackWorld = (() => {
      try {
        const doc = this._editingTile?.document ?? this._editingTile;
        if (!doc) return null;
        return getTileVisualCenterWorld(doc);
      } catch (_) {
        return null;
      }
    })();
    const world = this._getPreviewAnchorWorld(fallbackWorld);
    if (!world || !Number.isFinite(world.x) || !Number.isFinite(world.y)) {
      Logger.warn('Placement.editTile.commitTarget.missing', {
        tileId: this._editingTile?.id || null,
        hasPreview: !!this._previewContainer,
        replaceOriginalOnPlace: !!this._replaceOriginalOnPlace
      });
      return null;
    }
    const screen = (this._previewFrozen && this._frozenPointerScreen)
      ? { x: this._frozenPointerScreen.x, y: this._frozenPointerScreen.y }
      : (this._canvasToScreen(world.x, world.y) || (this._lastPointer ? { x: this._lastPointer.x, y: this._lastPointer.y } : null));
    return { world: { x: world.x, y: world.y }, screen };
  }

  async _commitExistingTileReplaceFromShortcut() {
    if (!this._isExistingTileReplaceSession()) return false;
    const target = this._getExistingTileReplaceCommitTarget();
    if (!target?.world) return false;

    if (this.isDownloading) {
      if (!target.screen || !Number.isFinite(target.screen.x) || !Number.isFinite(target.screen.y)) {
        Logger.warn('Placement.editTile.commitShortcut.queueFailed', {
          tileId: this._editingTile?.id || null,
          reason: 'missing-screen-target'
        });
        return false;
      }
      this.queuedPlacement = { x: target.screen.x, y: target.screen.y };
      Logger.info('Placement.editTile.commitShortcut.queued', {
        tileId: this._editingTile?.id || null,
        x: target.screen.x,
        y: target.screen.y
      });
      return true;
    }

    Logger.info('Placement.editTile.commitShortcut', {
      tileId: this._editingTile?.id || null,
      x: target.world.x,
      y: target.world.y
    });
    await this._placeAtWorldCoordinates(target.world, {
      screenX: Number.isFinite(target.screen?.x) ? target.screen.x : null,
      screenY: Number.isFinite(target.screen?.y) ? target.screen.y : null
    });
    return true;
  }

  _applyPlacementFreezeClass() {
    try {
      const el = this.app?.element;
      if (!el) return;
      if (this._previewFrozen) el.classList.add('placement-frozen');
      else el.classList.remove('placement-frozen');
    } catch (_) {}
  }

  _refreshFrozenPointerScreen() {
    if (!this._previewFrozen || !this._frozenPreviewWorld) {
      this._frozenPointerScreen = null;
      return;
    }
    const screen = this._canvasToScreen(this._frozenPreviewWorld.x, this._frozenPreviewWorld.y);
    this._frozenPointerScreen = screen;
    if (screen) {
      this._updateLoadingOverlayPointer(screen.x, screen.y);
    }
  }

  _shouldIgnoreFreezeShortcut(target) {
    if (!target) return false;
    try {
      if (target.isContentEditable) return true;
      const tag = String(target.tagName || '').toLowerCase();
      if (tag === 'textarea') return true;
      if (tag !== 'input') return false;
      const type = String(target.type || '').toLowerCase();
      return FREEZE_SHORTCUT_BLOCKED_INPUTS.has(type);
    } catch (_) {
      return false;
    }
  }

  _shouldIgnorePlacementHotkey(event, key = '') {
    try {
      const target = event?.target ?? document?.activeElement ?? null;
      if (!target || target === document.body) return false;
      if (target.dataset?.faNexusHotkeys === 'allow') return false;
      if (typeof target.isContentEditable === 'boolean' && target.isContentEditable) {
        return key !== 'Escape';
      }
      const tag = target.tagName ? String(target.tagName).toLowerCase() : '';
      if (!tag) return false;
      if (tag === 'input') {
        const type = typeof target.type === 'string' ? target.type.toLowerCase() : '';
        const allowTypes = ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden'];
        if (!type) return true;
        return !allowTypes.includes(type);
      }
      if (tag === 'textarea' || tag === 'select') return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  _formatFlipSummary(state) {
    return formatPlacementFlipSummary(state);
  }

  _buildFlipToolState() {
    const base = { horizontal: !!this._flipHorizontal, vertical: !!this._flipVertical };
    const pending = this._getPendingFlipState();
    const randomActive = this._hasRandomFlipEnabled();
    const baseSummary = this._formatFlipSummary(base);
    const previewSummary = this._formatFlipSummary(pending);
    const previewMatches = base.horizontal === pending.horizontal && base.vertical === pending.vertical;
    const display = randomActive ? `${previewSummary} preview` : baseSummary;
    const previewDisplay = !previewMatches ? `Preview: ${previewSummary}` : '';
    const horizontalPreviewDiff = pending.horizontal !== base.horizontal;
    const verticalPreviewDiff = pending.vertical !== base.vertical;
    const horizontalRandomEnabled = !!this._flipRandomHorizontalEnabled;
    const verticalRandomEnabled = !!this._flipRandomVerticalEnabled;
    return {
      available: true,
      display,
      previewDisplay,
      previewMatchesBase: previewMatches,
      randomActive,
      randomHint: 'Randomizes flips per placement on the selected axes.',
      horizontal: {
        active: base.horizontal,
        pending: pending.horizontal,
        label: 'Flip H',
        tooltip: 'Mirror asset left/right.',
        previewDiff: randomActive && horizontalPreviewDiff,
        aria: 'Toggle horizontal mirroring',
        disabled: false,
        randomEnabled: horizontalRandomEnabled,
        randomLabel: horizontalRandomEnabled ? 'Random On' : 'Random',
        randomTooltip: horizontalRandomEnabled ? 'Disable random horizontal flip' : 'Enable random horizontal flip',
        randomDisabled: false,
        randomAria: 'Toggle random horizontal mirroring',
        randomPreviewDiff: horizontalRandomEnabled && horizontalPreviewDiff
      },
      vertical: {
        active: base.vertical,
        pending: pending.vertical,
        label: 'Flip V',
        tooltip: 'Mirror asset top/bottom.',
        previewDiff: randomActive && verticalPreviewDiff,
        aria: 'Toggle vertical mirroring',
        disabled: false,
        randomEnabled: verticalRandomEnabled,
        randomLabel: verticalRandomEnabled ? 'Random On' : 'Random',
        randomTooltip: verticalRandomEnabled ? 'Disable random vertical flip' : 'Enable random vertical flip',
        randomDisabled: false,
        randomAria: 'Toggle random vertical mirroring',
        randomPreviewDiff: verticalRandomEnabled && verticalPreviewDiff
      }
    };
  }

  _buildScaleToolState() {
    const base = this._clampScale(this.currentScale);
    const preview = this._getPendingScale();
    const basePercent = Math.round(base * 100);
    const previewPercent = Math.round(preview * 100);
    const range = this._getScaleRandomRange();
    const defaultRange = this._getDefaultScaleRandomRange(base);
    const randomToggleOn = !!this._scaleRandomEnabled;
    return {
      available: true,
      min: 10,
      max: 250,
      step: 1,
      value: basePercent,
      defaultValue: Math.round(DEFAULT_SCALE * 100),
      display: randomToggleOn ? `${previewPercent}% preview` : `${basePercent}%`,
      randomEnabled: randomToggleOn,
      randomMode: 'range',
      randomMin: range.min,
      randomMax: range.max,
      randomMinDefault: defaultRange.min,
      randomMaxDefault: defaultRange.max,
      randomMinDisplay: `${range.min}%`,
      randomMaxDisplay: `${range.max}%`,
      randomMinAriaLabel: 'Minimum random scale',
      randomMaxAriaLabel: 'Maximum random scale',
      randomAria: randomToggleOn ? 'Disable random scale' : 'Enable random scale',
      randomLabel: randomToggleOn ? 'On' : 'Off',
      randomTooltip: randomToggleOn ? 'Disable random scale' : 'Enable random scale',
      randomHint: 'Samples a scale between Min and Max for each placement.'
    };
  }

  _buildElevationToolState() {
    const active = !!this.isPlacementActive;
    const value = Number.isFinite(this._previewElevation) ? quantizeElevation(this._previewElevation) : 0;
    return {
      available: active,
      min: -ELEVATION_INPUT_LIMIT,
      max: ELEVATION_INPUT_LIMIT,
      step: ELEVATION_STEP_FINE,
      value,
      defaultValue: quantizeElevation(getCurrentLevelBottomElevation()),
      display: formatElevation(value),
      tooltip: 'Preview tile elevation in Foundry scene units.',
      hint: 'Manual elevation entry for the current placement preview.',
      inputOnly: true,
      disabled: !active
    };
  }

  _buildRotationToolState() {
    const base = this._normalizeRotation(this.currentRotation);
    const preview = this._getPendingRotation();
    const range = this._getRotationRandomRange();
    const randomToggleOn = !!this._rotationRandomEnabled;
    const baseDisplay = `${Math.round(base)}°`;
    const previewDisplay = `${Math.round(preview)}°`;
    return {
      available: true,
      min: 0,
      max: 359,
      step: 1,
      value: base,
      defaultValue: DEFAULT_ROTATION,
      display: randomToggleOn ? `${previewDisplay} preview` : baseDisplay,
      randomEnabled: randomToggleOn,
      randomMode: 'range',
      randomMin: range.min,
      randomMax: range.max,
      randomMinDefault: DEFAULT_ROTATION_RANDOM_MIN,
      randomMaxDefault: DEFAULT_ROTATION_RANDOM_MAX,
      randomMinDisplay: `${range.min}°`,
      randomMaxDisplay: `${range.max}°`,
      randomMinAriaLabel: 'Minimum random rotation',
      randomMaxAriaLabel: 'Maximum random rotation',
      randomAria: randomToggleOn ? 'Disable random rotation' : 'Enable random rotation',
      randomLabel: randomToggleOn ? 'On' : 'Off',
      randomTooltip: randomToggleOn ? 'Disable random rotation' : 'Enable random rotation',
      randomHint: 'Samples a rotation between Min and Max for each placement.'
    };
  }

  _buildDropShadowControlsState({ available, enabled }) {
    const { state, normalized } = buildDropShadowControlsStateData({
      available,
      enabled,
      collapsed: this._shadowSettingsCollapsed,
      settings: {
        alpha: this._dropShadowAlpha,
        dilation: this._dropShadowDilation,
        blur: this._dropShadowBlur,
        offsetDistance: this._dropShadowOffsetDistance,
        offsetAngle: this._dropShadowOffsetAngle
      },
      offsetMax: this._getShadowOffsetMax(),
      previewSource: this._previewShadowRenderer?.offsetPreview,
      shadowOnlyEnabled: this._dropShadowOnly,
      presets: this._shadowPresets,
      context: this._buildDropShadowContextState()
    });
    if (normalized.offsetDistanceChanged) this._dropShadowOffsetDistance = normalized.offsetDistance;
    if (normalized.offsetAngleChanged) this._dropShadowOffsetAngle = normalized.offsetAngle;
    return state;
  }

  _buildDropShadowContextState() {
    return buildDropShadowContextStateData({
      elevation: Number(this._previewElevation ?? 0) || 0,
      context: this._shadowElevationContext,
      formatElevation
    });
  }

  _applyShadowSettingsSnapshot(snapshot = {}, options = {}) {
    if (!snapshot) return false;
    const { persist = false, notify = false, propagate = false, sync = true, force = false } = options;
    let changed = false;
    const assign = (prop, value, transform) => {
      const current = this[prop];
      let next = value;
      if (typeof transform === 'function') next = transform(value);
      if (!Number.isFinite(next)) return;
      if (Math.abs(Number(current || 0) - Number(next || 0)) > 0.0005) {
        this[prop] = next;
        changed = true;
      }
    };
    assign('_dropShadowAlpha', snapshot.alpha, (v) => Math.min(1, Math.max(0, Number(v))));
    assign('_dropShadowDilation', snapshot.dilation, (v) => Math.min(MAX_SHADOW_DILATION, Math.max(0, Number(v))));
    assign('_dropShadowBlur', snapshot.blur, (v) => Math.min(MAX_SHADOW_BLUR, Math.max(0, Number(v))));
    assign('_dropShadowOffsetDistance', snapshot.offsetDistance, (v) => Math.min(this._getShadowOffsetMax(), Math.max(0, Number(v))));
    assign('_dropShadowOffsetAngle', snapshot.offsetAngle, (v) => this._normalizeShadowAngle(v));

    if (changed || force) {
      if (persist) this._persistCurrentShadowSettings();
      if (propagate) this._propagateShadowSettingsToElevation();
      this._updatePreviewShadow({ force: true });
      this._syncScatterPreviewShadowSettingsForActiveElevation({ force: true });
      if (notify) {
        this._notifyDropShadowChanged();
      } else if (sync) {
        this._syncToolOptionsState({ suppressRender: false });
      }
    } else if (force && sync) {
      this._syncToolOptionsState({ suppressRender: false });
    }
    return changed;
  }

  _refreshShadowElevationContext({ adopt = false, sync = true } = {}) {
    try {
      const elevation = Number(this._previewElevation ?? 0) || 0;
      const globalEnabled = this._isGlobalDropShadowEnabled();
      const manager = globalEnabled ? getAssetShadowManager(this.app) : null;
      let snapshot = null;
      if (manager?.getElevationSettings) {
        snapshot = manager.getElevationSettings(elevation) || null;
      }
      const tileCount = Number(snapshot?.tileCount || 0);
      const hasTiles = !!snapshot?.hasTiles && tileCount > 0;
      const mixedOffsets = !!snapshot?.mixedOffset || !!snapshot?.mixedOffsetDistance || !!snapshot?.mixedOffsetAngle;
      const mixedSpread = !!snapshot?.mixedDilation;
      const key = this._getScatterPreviewGroupKey(elevation);
      const cachedSettings = this._scatterPreviewShadowRenderer.getSettings(key) || null;
      let source = this._shadowElevationContext?.source || (hasTiles ? 'existing' : 'default');
      if (adopt && hasTiles) {
        const fallback = cachedSettings || this._snapshotScatterPreviewShadowSettings();
        const mergedSnapshot = {
          alpha: snapshot?.alpha ?? fallback.alpha,
          blur: snapshot?.blur ?? fallback.blur,
          dilation: fallback.dilation,
          offsetDistance: fallback.offsetDistance,
          offsetAngle: fallback.offsetAngle
        };
        this._applyShadowSettingsSnapshot(mergedSnapshot, { persist: false, notify: false, propagate: false, sync: false, force: true });
        source = 'existing';
      } else {
        if (adopt && cachedSettings) {
          this._applyShadowSettingsSnapshot(cachedSettings, { persist: false, notify: false, propagate: false, sync: false, force: true });
        }
        if (!hasTiles) {
          source = 'default';
        }
      }
      this._shadowElevationContext = { elevation, tileCount, hasTiles, source, mixedOffsets, mixedDilation: mixedSpread };
      if (sync) {
        this._syncToolOptionsState({ suppressRender: false });
        this._updatePreviewShadow({ force: true });
      }
      return snapshot;
    } catch (_) {
      return null;
    }
  }

  _propagateShadowSettingsToElevation() {
    try {
      if (!this._isGlobalDropShadowEnabled()) return;
      const manager = getAssetShadowManager(this.app);
      if (!manager?.applyElevationSettings) return;
      const elevation = Number(this._previewElevation ?? 0) || 0;
      const snapshot = manager.getElevationSettings?.(elevation) || null;
      const tileCount = Number(snapshot?.tileCount || 0);
      const hasTiles = !!snapshot?.hasTiles && tileCount > 0;
      if (!hasTiles) {
        this._shadowElevationContext = { elevation, tileCount: 0, hasTiles: false, source: 'default' };
        this._syncToolOptionsState({ suppressRender: false });
        this._updatePreviewShadow({ force: true });
        return;
      }
      const settings = {
        alpha: this._dropShadowAlpha,
        blur: this._dropShadowBlur
      };
      const result = manager.applyElevationSettings(elevation, settings);
      const markSynced = () => {
        this._shadowElevationContext = { elevation, tileCount, hasTiles: true, source: 'custom' };
        this._refreshShadowElevationContext({ adopt: false, sync: false });
        this._syncToolOptionsState({ suppressRender: false });
        this._updatePreviewShadow({ force: true });
      };
      if (result?.then) {
        result.then((updated) => { if (updated) markSynced(); }).catch(() => {});
      } else if (result) {
        markSynced();
      }
    } catch (_) {}
  }

  _syncToolOptionsState({ suppressRender = true } = {}) {
    try {
      const descriptor = this._buildToolOptionsDescriptor();
      toolOptionsController.setToolOptions('asset.placement', {
        ...descriptor,
        suppressRender
      });
    } catch (_) {}
  }

  _handleDropShadowToggleRequest(value) {
    const globalEnabled = this._isGlobalDropShadowEnabled();
    if (value === null || value === undefined) {
      if (this._dropShadowPreference == null) {
        this._syncToolOptionsState();
        return true;
      }
      this._dropShadowPreference = null;
      this._persistDropShadowPreference(null);
      this._updatePreviewShadow({ force: true });
      this._syncDropShadowOnlyPreview();
      this._scheduleScatterPreviewShadowUpdate({ force: true });
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
      return true;
    }
    const next = !!value;
    if (!globalEnabled && next) {
      this._syncToolOptionsState();
      return false;
    }
    if (this._dropShadowPreference === next) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowPreference = next;
    this._persistDropShadowPreference(next);
    this._updatePreviewShadow({ force: true });
    this._syncDropShadowOnlyPreview();
    this._scheduleScatterPreviewShadowUpdate({ force: true });
    this._notifyDropShadowChanged();
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    return true;
  }

  _handleDropShadowOnlyToggle(enabled) {
    const next = !!enabled;
    if (this._dropShadowOnly === next) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowOnly = next;
    this._persistShadowSetting('assetDropShadowOnly', next);
    this._syncDropShadowOnlyPreview();
    this._syncToolOptionsState({ suppressRender: false });
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    return true;
  }

  _handleDropShadowControlChange(control, value, commit = false) {
    const prop = DROP_SHADOW_CONTROL_PROPS[control];
    const change = resolveDropShadowControlChange(control, value, this[prop], {
      commit,
      maxOffsetDistance: this._getShadowOffsetMax()
    });
    if (!change.ok) {
      this._syncToolOptionsState();
      return false;
    }
    if (!change.shouldApply) {
      this._syncToolOptionsState();
      return true;
    }
    this[prop] = change.value;
    this._updatePreviewShadow({ force: control === 'blur' && !!commit });
    this._syncScatterPreviewShadowSettingsForActiveElevation({ force: commit });
    if (commit) this._persistShadowSetting(change.settingKey, change.value);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowAlphaChange(value, commit = false) {
    return this._handleDropShadowControlChange('alpha', value, commit);
  }

  _handleDropShadowDilationChange(value, commit = false) {
    return this._handleDropShadowControlChange('dilation', value, commit);
  }

  _handleDropShadowBlurChange(value, commit = false) {
    return this._handleDropShadowControlChange('blur', value, commit);
  }

  _handleDropShadowOffsetDistanceChange(value, commit = false) {
    return this._handleDropShadowControlChange('offsetDistance', value, commit);
  }

  _handleDropShadowOffsetAngleChange(value, commit = false) {
    return this._handleDropShadowControlChange('offsetAngle', value, commit);
  }

  _handleDropShadowOffsetMaxChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const clamped = Math.min(SHADOW_OFFSET_MAX_CEILING, Math.max(MIN_SHADOW_OFFSET_MAX, numeric));
    if (Math.abs(clamped - this._dropShadowOffsetMax) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowOffsetMax = clamped;
    if (this._dropShadowOffsetDistance > clamped) {
      this._dropShadowOffsetDistance = clamped;
      if (commit) this._persistShadowSetting('assetDropShadowOffsetDistance', clamped);
    }
    this._updatePreviewShadow();
    this._syncScatterPreviewShadowSettingsForActiveElevation({ force: commit });
    if (commit) this._persistShadowSetting('assetDropShadowOffsetMax', clamped);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleScaleSliderInput(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const normalized = this._clampScale(numeric / 100);
    this.currentScale = normalized;
    this._persistPlacementTransformSetting('assetPlacementScale', normalized);
    this._updateScalePreview({ clampOffset: true });
    this._syncToolOptionsState();
    if (this._isEditingExistingTile) this._scheduleEditingCommit();
    return true;
  }

  _handleScaleRandomToggle() {
    const next = !this._scaleRandomEnabled;
    this._scaleRandomEnabled = next;
    if (next) {
      const seededRange = this._getDefaultScaleRandomRange(this.currentScale);
      this._scaleRandomMin = seededRange.min;
      this._scaleRandomMax = seededRange.max;
    }
    this._persistPlacementTransformSetting('assetPlacementScaleRandomEnabled', next);
    this._persistPlacementTransformSetting('assetPlacementScaleRandomMin', this._scaleRandomMin);
    this._persistPlacementTransformSetting('assetPlacementScaleRandomMax', this._scaleRandomMax);
    this._updateScalePreview({ regenerateOffset: next, clampOffset: true });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleScaleRandomMin(value) {
    const current = this._getScaleRandomRange();
    const nextMin = Math.min(current.max, this._clampScaleRandomPercent(value, DEFAULT_SCALE_RANDOM_MIN));
    this._scaleRandomMin = nextMin;
    this._scaleRandomMax = current.max;
    this._persistPlacementTransformSetting('assetPlacementScaleRandomMin', this._scaleRandomMin);
    this._persistPlacementTransformSetting('assetPlacementScaleRandomMax', this._scaleRandomMax);
    this._updateScalePreview({ clampOffset: true });
    this._syncToolOptionsState();
    return true;
  }

  _handleScaleRandomMax(value) {
    const current = this._getScaleRandomRange();
    const nextMax = Math.max(current.min, this._clampScaleRandomPercent(value, DEFAULT_SCALE_RANDOM_MAX));
    this._scaleRandomMin = current.min;
    this._scaleRandomMax = nextMax;
    this._persistPlacementTransformSetting('assetPlacementScaleRandomMin', this._scaleRandomMin);
    this._persistPlacementTransformSetting('assetPlacementScaleRandomMax', this._scaleRandomMax);
    this._updateScalePreview({ clampOffset: true });
    this._syncToolOptionsState();
    return true;
  }

  _handleRotationSliderInput(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const normalized = this._normalizeRotation(numeric);
    this.currentRotation = normalized;
    this._persistPlacementTransformSetting('assetPlacementRotation', normalized);
    this._updateRotationPreview({ clampOffset: true });
    this._syncToolOptionsState();
    if (this._isEditingExistingTile) this._scheduleEditingCommit();
    return true;
  }

  _handleElevationInput(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    this._setPreviewElevation(numeric, {
      announce: !!commit,
      immediate: !!commit,
      syncToolOptions: true,
      worldPoint: this._getElevationAnnouncePoint()
    });
    if (this._isEditingExistingTile) this._scheduleEditingCommit(!!commit);
    return true;
  }

  _handleRotationRandomToggle() {
    const next = !this._rotationRandomEnabled;
    this._rotationRandomEnabled = next;
    const range = this._getRotationRandomRange();
    this._rotationRandomMin = range.min;
    this._rotationRandomMax = range.max;
    this._persistPlacementTransformSetting('assetPlacementRotationRandomEnabled', next);
    this._persistPlacementTransformSetting('assetPlacementRotationRandomMin', this._rotationRandomMin);
    this._persistPlacementTransformSetting('assetPlacementRotationRandomMax', this._rotationRandomMax);
    this._updateRotationPreview({ regenerateOffset: next, clampOffset: true });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleRotationRandomMin(value) {
    const current = this._getRotationRandomRange();
    const nextMin = Math.min(current.max, this._clampRotationRandomValue(value, DEFAULT_ROTATION_RANDOM_MIN));
    this._rotationRandomMin = nextMin;
    this._rotationRandomMax = current.max;
    this._persistPlacementTransformSetting('assetPlacementRotationRandomMin', this._rotationRandomMin);
    this._persistPlacementTransformSetting('assetPlacementRotationRandomMax', this._rotationRandomMax);
    this._updateRotationPreview({ clampOffset: true });
    this._syncToolOptionsState();
    return true;
  }

  _handleRotationRandomMax(value) {
    const current = this._getRotationRandomRange();
    const nextMax = Math.max(current.min, this._clampRotationRandomValue(value, DEFAULT_ROTATION_RANDOM_MAX));
    this._rotationRandomMin = current.min;
    this._rotationRandomMax = nextMax;
    this._persistPlacementTransformSetting('assetPlacementRotationRandomMin', this._rotationRandomMin);
    this._persistPlacementTransformSetting('assetPlacementRotationRandomMax', this._rotationRandomMax);
    this._updateRotationPreview({ clampOffset: true });
    this._syncToolOptionsState();
    return true;
  }

  _setScatterMode(mode) {
    const next = normalizePlacementTransformMode(mode);
    if (this._scatterMode === next) {
      if (
        next === ASSET_SCATTER_MODE_BRUSH
        && this.isPlacementActive
        && !this._isEditingExistingTile
        && !this._scatterEditing
      ) {
        if (!this._scatterMergeEnabled) {
          this._scatterMergeEnabled = true;
          this._persistScatterSetting('assetScatterMerge', true);
        }
        this._ensureScatterOverlay();
        if (this._scatterMergeEnabled) {
          this._ensureScatterPreviewOverlay();
          this._syncScatterPreviewOrdering();
        }
      }
      this._syncPlacementPreviewVisibility();
      if (next === ASSET_SCATTER_MODE_BRUSH) this._updateScatterCursor();
      return true;
    }
    if (this._isEditingExistingTile || this._scatterEditing) {
      this._syncToolOptionsState();
      return false;
    }
    this._scatterMode = next;
    this._persistPlacementSetting('assetPlacementScatterMode', next);
    if (next === ASSET_SCATTER_MODE_BRUSH) {
      if (!this._scatterMergeEnabled) {
        this._scatterMergeEnabled = true;
        this._persistScatterSetting('assetScatterMerge', true);
      }
      this._ensureScatterOverlay();
      if (this._scatterMergeEnabled) this._ensureScatterPreviewOverlay();
      this._scatterPainting = false;
      this._scatterLastPointerWorld = null;
      this._scatterStrokeDistance = 0;
    } else {
      this._autoCommitScatterSession('switch-mode');
      this._resetScatterMergeSession();
      this._resetScatterHistory();
      void this._endScatterShadowBatch({ awaitQueue: true });
      this._stopScatterStroke();
      this._clearScatterOverlay();
    }
    this._restorePlacementTransformState({ mode: next, regenerateOffsets: true });
    this._syncPlacementPreviewVisibility();
    if (next === ASSET_SCATTER_MODE_BRUSH) this._updateScatterCursor();
    this._updateRandomPrefetchCount();
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  setScatterBrushSize(value, commit = false) {
    const numeric = this._coerceScatterControlNumericValue(value, { control: 'brushSize', commit });
    if (numeric === null) return false;
    const clamped = Math.min(SCATTER_BRUSH_SIZE_MAX, Math.max(SCATTER_BRUSH_SIZE_MIN, numeric));
    if (Math.abs(clamped - (this._scatterBrushSize ?? 0)) < 0.0005) {
      if (commit) this._persistScatterSetting('assetScatterBrushSize', Math.round(clamped));
      return true;
    }
    this._scatterBrushSize = clamped;
    if (commit) this._persistScatterSetting('assetScatterBrushSize', Math.round(clamped));
    this._updateScatterCursor();
    this._syncToolOptionsState({ suppressRender: !commit });
    return true;
  }

  setScatterDensity(value, commit = false) {
    const parsed = this._coerceScatterControlNumericValue(value, { control: 'density', commit });
    if (parsed === null) return false;
    const numeric = Math.round(parsed);
    const clamped = Math.min(SCATTER_DENSITY_MAX, Math.max(SCATTER_DENSITY_MIN, numeric));
    if (clamped === this._scatterDensity) {
      if (commit) this._persistScatterSetting('assetScatterDensity', clamped);
      return true;
    }
    this._scatterDensity = clamped;
    if (commit) this._persistScatterSetting('assetScatterDensity', clamped);
    this._updateScatterCursor();
    this._syncToolOptionsState({ suppressRender: !commit });
    return true;
  }

  setScatterSprayDeviation(value, commit = false) {
    const numeric = this._coerceScatterControlNumericValue(value, { control: 'sprayDeviation', commit });
    if (numeric === null) return false;
    const clamped = Math.min(100, Math.max(0, numeric));
    const normalized = clamped / 100;
    if (Math.abs(normalized - (this._scatterSprayDeviation ?? 0)) < 0.0005) {
      if (commit) this._persistScatterSetting('assetScatterSprayDeviation', Math.round(clamped));
      return true;
    }
    this._scatterSprayDeviation = normalized;
    if (commit) this._persistScatterSetting('assetScatterSprayDeviation', Math.round(clamped));
    this._updateScatterCursor();
    this._syncToolOptionsState({ suppressRender: !commit });
    return true;
  }

  setScatterSpacing(value, commit = false) {
    const numeric = this._coerceScatterControlNumericValue(value, { control: 'spacing', commit });
    if (numeric === null) return false;
    const clamped = Math.min(SCATTER_SPACING_MAX, Math.max(SCATTER_SPACING_MIN, numeric));
    if (Math.abs(clamped - (this._scatterSpacing ?? 0)) < 0.0005) {
      if (commit) this._persistScatterSetting('assetScatterSpacing', Math.round(clamped));
      return true;
    }
    this._scatterSpacing = clamped;
    if (commit) this._persistScatterSetting('assetScatterSpacing', Math.round(clamped));
    this._updateScatterCursor();
    this._syncToolOptionsState({ suppressRender: !commit });
    return true;
  }

  _syncPlacementPreviewVisibility() {
    if (!this._previewContainer) return;
    const visible = this._scatterMode !== ASSET_SCATTER_MODE_BRUSH;
    let changed = false;
    if (this._previewContainer.visible !== visible) {
      this._previewContainer.visible = visible;
      changed = true;
    }
    if (this._previewContainer.faNexusPreviewActive !== visible) {
      this._previewContainer.faNexusPreviewActive = visible;
      changed = true;
    }
    if (this._previewContainer.faNexusPreviewHasContent !== visible) {
      this._previewContainer.faNexusPreviewHasContent = visible;
      changed = true;
    }
    this._previewShadowRenderer.syncPlacement(undefined, { reorder: false });
    if (changed) this._notifyPreviewLayerChange('asset-placement');
    this._syncDropShadowOnlyPreview();
  }

  _syncDropShadowOnlyPreview() {
    const shadowOnlyActive = !!(this._isGlobalDropShadowEnabled() && this.isDropShadowEnabled() && this._dropShadowOnly);
    const visible = !shadowOnlyActive;
    try {
      const sprite = this._previewContainer?._sprite || null;
      if (sprite && !sprite.destroyed) {
        sprite.visible = visible;
        sprite.renderable = visible;
      }
    } catch (_) {}
    try {
      for (const sprite of this._scatterPreviewSprites?.values?.() || []) {
        if (!sprite || sprite.destroyed) continue;
        sprite.visible = visible;
        sprite.renderable = visible;
      }
    } catch (_) {}
  }

  _capturePlacementSortAnchor(controlledTiles = canvas?.tiles?.controlled) {
    const anchorTile = resolvePlacementAnchorTile(controlledTiles);
    const anchorDoc = anchorTile?.document || anchorTile || null;
    const anchorTileId = String(anchorTile?.document?.id || anchorTile?.id || '').trim() || null;
    this._placementSortAnchorTileId = anchorTileId;
    this._placementSortAnchorPlacementLevelId = this._resolveDocumentPlacementLevelId(anchorDoc);
    this._placementSortBeforeAnchor = false;
    Logger.debug('Placement.sortAnchor.capture', {
      anchorTileId,
      elevation: Number(anchorTile?.document?.elevation ?? anchorTile?.elevation ?? 0) || 0,
      sort: Number(anchorTile?.document?.sort ?? anchorTile?.sort ?? 0) || 0
    });
    return anchorTileId;
  }

  _adoptPlacementSortAnchor(target) {
    const anchorTileId = String(target?.document?.id || target?.id || '').trim() || null;
    this._placementSortAnchorTileId = anchorTileId;
    this._placementSortAnchorPlacementLevelId = this._resolveDocumentPlacementLevelId(target?.document || target || null);
    this._placementSortBeforeAnchor = false;
    this._previewPlacementLevelId = this._placementSortAnchorPlacementLevelId;
    Logger.debug('Placement.sortAnchor.adopt', {
      anchorTileId,
      elevation: Number(target?.document?.elevation ?? target?.elevation ?? 0) || 0,
      sort: Number(target?.document?.sort ?? target?.sort ?? 0) || 0
    });
    return anchorTileId;
  }

  _resolvePlacementSortContext(elevation = this._previewElevation, { count = 1 } = {}) {
    const normalizedElevation = Number.isFinite(Number(elevation)) ? Number(elevation) : 0;
    const editingDoc = ((this._isEditingExistingTile || this._replaceOriginalOnPlace) && this._editingTile) ? this._editingTile : null;
    if (editingDoc && this._placementSortAnchorTileId === editingDoc?.id && this._placementSortBeforeAnchor !== true) {
      const sort = Number(editingDoc?.sort ?? this._previewSort) || 0;
      return {
        sort,
        placementSorts: [sort],
        previewSort: sort,
        previewSorts: [sort],
        strategy: 'editing-document',
        anchorTileId: editingDoc?.id || null,
        anchorTileSort: sort,
        siblingUpdates: []
      };
    }

    const resolved = this._interactionController?.resolvePlacementSortAtElevation?.(normalizedElevation, {
      anchorTileId: this._placementSortAnchorTileId,
      sortBefore: this._placementSortBeforeAnchor === true,
      scene: canvas?.scene,
      count,
      excludeTileIds: editingDoc?.id ? [editingDoc.id] : []
    });
    if (resolved && Array.isArray(resolved.placementSorts) && resolved.placementSorts.length) {
      return resolved;
    }

    const fallbackSort = this._interactionController?.computeNextSortAtElevation?.(normalizedElevation) ?? this._previewSort ?? 0;
    if (this._placementSortAnchorTileId) {
      Logger.warn('Placement.sort.resolve.missingContext', {
        elevation: normalizedElevation,
        anchorTileId: this._placementSortAnchorTileId,
        count
      });
    } else {
      Logger.debug('Placement.sort.resolve.missingContext', {
        elevation: normalizedElevation,
        anchorTileId: this._placementSortAnchorTileId,
        count
      });
    }
    return {
      sort: Number(fallbackSort) || 0,
      placementSorts: [Number(fallbackSort) || 0],
      previewSort: Number(fallbackSort) || 0,
      previewSorts: [Number(fallbackSort) || 0],
      strategy: 'top-of-elevation',
      anchorTileId: this._placementSortAnchorTileId,
      anchorTileSort: null,
      siblingUpdates: []
    };
  }

  _nudgePlacementSort(direction) {
    const normalizedDirection = Math.sign(Number(direction) || 0);
    if (!normalizedDirection) return false;
    const editingDoc = ((this._isEditingExistingTile || this._replaceOriginalOnPlace) && this._editingTile)
      ? this._editingTile
      : null;
    const previewKind = this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterPreviewContainer
      ? 'scatter-preview'
      : 'asset-placement-preview';
    const target = resolveLayerManagerPreviewSortNudge({
      previewKind,
      direction: normalizedDirection,
      anchorTileId: this._placementSortAnchorTileId,
      sortBefore: this._placementSortBeforeAnchor === true,
      excludeTileIds: editingDoc?.id ? [editingDoc.id] : []
    });
    if (!target || (!target.anchorTileId && !Number.isFinite(Number(target.elevation)))) {
      return false;
    }

    const nextElevation = Number.isFinite(Number(target.elevation)) ? Number(target.elevation) : this._previewElevation;
    this._placementSortAnchorTileId = target.anchorTileId || null;
    this._placementSortBeforeAnchor = target.sortBefore === true;
    const anchorDoc = target.anchorTileId ? canvas?.scene?.tiles?.get?.(target.anchorTileId) || null : null;
    if (anchorDoc) {
      this._placementSortAnchorPlacementLevelId = this._resolveDocumentPlacementLevelId(anchorDoc);
      this._previewPlacementLevelId = this._placementSortAnchorPlacementLevelId;
    }
    const sortContext = this._resolvePlacementSortContext(nextElevation);
    this.applyLayerManagerPreviewPlacement({
      elevation: nextElevation,
      sort: sortContext.sort,
      previewSort: sortContext.previewSort,
      previewKind,
      previewId: target.previewId,
      previewKey: target.previewKey,
      anchorTileId: target.anchorTileId,
      sortBefore: target.sortBefore,
      announce: false
    });
    this._notifyPreviewLayerChange('asset-placement');
    return true;
  }

  _applyPlacementPreviewOrdering(sortContext = null) {
    const context = sortContext || this._resolvePlacementSortContext(this._previewElevation);
    this._adoptPlacementSortContext(context);
    if (!this._previewContainer) return context;
    const renderOrder = this._resolvePreviewRenderOrder(this._previewElevation, this._previewRenderSort);
    this._previewContainer.sortLayer = renderOrder.sortLayer;
    this._previewContainer.sort = renderOrder.sort;
    this._previewContainer.faNexusSort = renderOrder.sort;
    this._previewContainer.faNexusPlacementSort = this._previewSort;
    this._previewContainer.faNexusPlacementAnchorTileId = this._placementSortAnchorTileId;
    this._previewContainer.faNexusPreviewSort = this._previewRenderSort;
    this._previewContainer.faNexusElevationDoc = this._previewElevation;
    this._previewContainer.faNexusElevation = renderOrder.elevation;
    this._previewContainer.faNexusPlacementLevelId = renderOrder.placementLevelId || null;
    this._previewContainer.faNexusBandKind = renderOrder.kind || 'normal';
    this._previewContainer.elevation = renderOrder.elevation;
    this._previewContainer.zIndex = renderOrder.kind !== 'normal' ? this._previewRenderSort : 0;
    const parent = this._previewContainer.parent;
    if (parent && 'sortDirty' in parent) parent.sortDirty = true;
    parent?.sortChildren?.();
    this._previewShadowRenderer.syncPlacement();
    return context;
  }

  _normalizePlacementLevelId(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
  }

  _resolveDocumentPlacementLevelId(doc = null) {
    return this._normalizePlacementLevelId(getTileExplicitPlacementLevelId(doc));
  }

  _adoptPlacementSortContext(context = null) {
    const placementSort = Number(context?.sort);
    const nextSort = Number.isFinite(placementSort)
      ? placementSort
      : (Array.isArray(context?.placementSorts) ? Number(context.placementSorts[0]) : this._previewSort);
    this._previewSort = Number.isFinite(nextSort) ? nextSort : 0;
    const previewSort = Number(
      context?.previewSort
      ?? (Array.isArray(context?.previewSorts) ? context.previewSorts[0] : undefined)
      ?? this._previewSort
    );
    this._previewRenderSort = Number.isFinite(previewSort) ? previewSort : this._previewSort;
    return context;
  }

  _resolveActivePlacementLevelId(doc = null) {
    return this._normalizePlacementLevelId(
      this._previewPlacementLevelId
      ?? this._resolveDocumentPlacementLevelId(doc)
    );
  }

  applyLayerManagerPreviewPlacement({
    elevation = this._previewElevation,
    sort = undefined,
    previewSort = undefined,
    previewKind = 'asset-placement-preview',
    previewId = null,
    previewKey = null,
    placementLevelId = undefined,
    anchorTileId = undefined,
    sortBefore = undefined,
    announce = true,
    immediate = true,
    worldPoint = null
  } = {}) {
    let changed = false;

    if (placementLevelId !== undefined) {
      const nextPlacementLevelId = this._normalizePlacementLevelId(placementLevelId);
      if (nextPlacementLevelId !== this._previewPlacementLevelId) {
        this._previewPlacementLevelId = nextPlacementLevelId;
        changed = true;
      }
    }

    if (anchorTileId !== undefined) {
      const nextAnchorTileId = String(anchorTileId || '').trim() || null;
      if (nextAnchorTileId !== this._placementSortAnchorTileId) {
        this._placementSortAnchorTileId = nextAnchorTileId;
        changed = true;
      }
    }

    if (sortBefore !== undefined) {
      const nextSortBefore = sortBefore === true;
      if (nextSortBefore !== this._placementSortBeforeAnchor) {
        this._placementSortBeforeAnchor = nextSortBefore;
        changed = true;
      }
    }

    const directSort = sort !== undefined && Number.isFinite(Number(sort)) ? Number(sort) : null;
    const directPreviewSort = previewSort !== undefined && Number.isFinite(Number(previewSort))
      ? Number(previewSort)
      : directSort;
    const isScatterPreviewPlacement = directSort !== null && previewKind === 'scatter-preview';

    if (directSort !== null && Number(this._previewSort) !== directSort) {
      this._previewSort = directSort;
      changed = true;
    }
    if (directPreviewSort !== null && Number(this._previewRenderSort) !== directPreviewSort) {
      this._previewRenderSort = directPreviewSort;
      changed = true;
    }

    if (isScatterPreviewPlacement) {
      changed = this._applyScatterPreviewGroupPlacement({
        previewId,
        previewKey,
        elevation,
        sort: directSort,
        previewSort: directPreviewSort
      }) || changed;
    }

    const elevationChanged = this._setPreviewElevation(elevation, {
      announce,
      immediate,
      syncToolOptions: true,
      worldPoint
    });
    changed = changed || elevationChanged;
    if (!changed) return false;
    if (this._scatterEditing) this._scatterEditPlacementMoved = true;
    if (directSort !== null) {
      if (this._previewContainer) {
        this._applyPlacementPreviewOrdering({
          sort: directSort,
          placementSorts: [directSort],
          previewSort: directPreviewSort,
          previewSorts: [directPreviewSort],
          strategy: 'layer-manager-direct-sort',
          anchorTileId: this._placementSortAnchorTileId,
          anchorTileSort: null,
          siblingUpdates: []
        });
      }
      this._applyScatterHoverOrdering();
      this._syncScatterPreviewOrdering();
      this._notifyPreviewLayerChange('asset-placement');
      this._refreshShadowElevationContext({ adopt: true });
      this._syncToolOptionsState();
    } else if (!elevationChanged) {
      this._syncPreviewOrdering();
      this._refreshShadowElevationContext({ adopt: true });
      this._syncToolOptionsState();
    }
    return true;
  }

  _normalizeScatterPreviewGroupKey({ previewKey = null, previewId = null, elevation = null } = {}) {
    return this._scatterPreviewGroupRuntime.normalizeGroupKey({ previewKey, previewId, elevation });
  }

  _applyScatterPreviewGroupPlacement({
    previewId = null,
    previewKey = null,
    elevation = null,
    sort = undefined,
    previewSort = undefined
  } = {}) {
    return this._scatterPreviewGroupRuntime.applyGroupPlacement({
      previewId,
      previewKey,
      elevation,
      sort,
      previewSort
    });
  }

  async _applyPlacementSiblingSortUpdates(siblingUpdates, { reason = 'unknown' } = {}) {
    const updates = Array.isArray(siblingUpdates)
      ? siblingUpdates.filter((entry) => entry && entry._id && Number.isFinite(Number(entry.sort)))
      : [];
    if (!updates.length) return [];
    if (!canvas?.scene) throw new Error(`Canvas scene unavailable while applying sort updates for ${reason}`);
    Logger.debug('Placement.sort.reindex.apply', {
      reason,
      updates: updates.map((entry) => ({ _id: entry._id, sort: Number(entry.sort) }))
    });
    try {
      return await canvas.scene.updateEmbeddedDocuments('Tile', updates, { diff: false });
    } catch (error) {
      Logger.error('Placement.sort.reindex.failed', {
        reason,
        updates: updates.map((entry) => ({ _id: entry._id, sort: Number(entry.sort) })),
        error: String(error?.message || error)
      });
      throw error;
    }
  }

  _coerceScatterControlNumericValue(value, { control = 'unknown', commit = false } = {}) {
    const log = commit ? Logger.warn.bind(Logger) : Logger.debug.bind(Logger);
    if (typeof value === 'boolean') {
      log('Placement.scatter.control.invalidBoolean', { control, value, commit });
      return null;
    }
    if (typeof value === 'string' && !value.trim().length) {
      log('Placement.scatter.control.empty', { control, commit });
      return null;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      log('Placement.scatter.control.invalidNumber', { control, value, commit });
      return null;
    }
    return numeric;
  }

  setScatterMergeEnabled(_enabled, commit = false) {
    const next = true;
    if (next === this._scatterMergeEnabled) {
      this._syncToolOptionsState();
      return true;
    }
    this._scatterMergeEnabled = next;
    if (commit) this._persistScatterSetting('assetScatterMerge', true);
    this._syncToolOptionsState({ suppressRender: !commit });
    return true;
  }

  setScatterEraserEnabled(enabled) {
    if (!this.isPlacementActive || this._isEditingExistingTile || this._scatterMode !== ASSET_SCATTER_MODE_BRUSH || !this._scatterMergeEnabled) {
      this._scatterEraseEnabled = false;
      this._updateScatterCursor();
      this._syncToolOptionsState();
      return false;
    }
    this._scatterEraseEnabled = !!enabled;
    this._updateScatterCursor();
    this._syncToolOptionsState();
    return true;
  }

  _handleFlipHorizontalToggle() {
    this._flipHorizontal = !this._flipHorizontal;
    this._persistPlacementTransformSetting('assetPlacementFlipHorizontal', this._flipHorizontal);
    this._updateFlipPreview();
    this._syncToolOptionsState({ suppressRender: false });
    if (this._isEditingExistingTile) this._scheduleEditingCommit();
    return true;
  }

  _handleFlipVerticalToggle() {
    this._flipVertical = !this._flipVertical;
    this._persistPlacementTransformSetting('assetPlacementFlipVertical', this._flipVertical);
    this._updateFlipPreview();
    this._syncToolOptionsState({ suppressRender: false });
    if (this._isEditingExistingTile) this._scheduleEditingCommit();
    return true;
  }

  _handleFlipRandomHorizontalToggle() {
    const next = !this._flipRandomHorizontalEnabled;
    this._flipRandomHorizontalEnabled = next;
    this._flipRandomHorizontalOffset = next ? null : false;
    this._persistPlacementTransformSetting('assetPlacementFlipRandomHorizontal', next);
    this._updateFlipPreview({ regenerateOffsets: next });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleFlipRandomVerticalToggle() {
    const next = !this._flipRandomVerticalEnabled;
    this._flipRandomVerticalEnabled = next;
    this._flipRandomVerticalOffset = next ? null : false;
    this._persistPlacementTransformSetting('assetPlacementFlipRandomVertical', next);
    this._updateFlipPreview({ regenerateOffsets: next });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _installDropShadowSettingsHook() {
    const hooks = globalThis?.Hooks;
    if (!hooks || typeof hooks.on !== 'function' || this._dropShadowSettingsHook) return;
    const handler = (setting) => {
      if (!setting || setting.namespace !== 'fa-nexus') return;
      if (setting.key === 'assetDropShadow') {
        this._syncToolOptionsState();
        this._scheduleScatterPreviewShadowUpdate({ force: true });
        return;
      }
      switch (setting.key) {
        case 'assetDropShadowAlpha':
          this._dropShadowAlpha = this._coerceShadowNumeric(setting.value, 0, 1, this._dropShadowAlpha);
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          this._syncScatterPreviewShadowSettingsForActiveElevation({ force: true });
          break;
        case 'assetDropShadowDilation':
          this._dropShadowDilation = this._coerceShadowNumeric(setting.value, 0, MAX_SHADOW_DILATION, this._dropShadowDilation);
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          this._syncScatterPreviewShadowSettingsForActiveElevation({ force: true });
          break;
        case 'assetDropShadowBlur':
          this._dropShadowBlur = this._coerceShadowNumeric(setting.value, 0, MAX_SHADOW_BLUR, this._dropShadowBlur);
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          this._syncScatterPreviewShadowSettingsForActiveElevation({ force: true });
          break;
        case 'assetDropShadowOffsetDistance':
          this._dropShadowOffsetDistance = this._coerceShadowNumeric(
            setting.value,
            0,
            this._getShadowOffsetMax(),
            this._dropShadowOffsetDistance
          );
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          this._syncScatterPreviewShadowSettingsForActiveElevation({ force: true });
          break;
        case 'assetDropShadowOffsetMax':
          this._dropShadowOffsetMax = this._readShadowOffsetMax();
          {
            const cap = this._getShadowOffsetMax();
            if (this._dropShadowOffsetDistance > cap) {
              this._dropShadowOffsetDistance = cap;
              this._persistShadowSetting('assetDropShadowOffsetDistance', cap);
            }
          }
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          this._syncScatterPreviewShadowSettingsForActiveElevation({ force: true });
          break;
        case 'assetDropShadowOffsetAngle':
          this._dropShadowOffsetAngle = this._normalizeShadowAngle(setting.value);
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          this._syncScatterPreviewShadowSettingsForActiveElevation({ force: true });
          break;
        case 'assetDropShadowCollapsed':
          this._shadowSettingsCollapsed = !!setting.value;
          this._syncToolOptionsState({ suppressRender: false });
          break;
        case 'assetDropShadowPresets':
          try {
            const parsed = typeof setting.value === 'string'
              ? JSON.parse(setting.value || '[]')
              : Array.isArray(setting.value) ? setting.value : [];
            this._shadowPresets = Array.from({ length: SHADOW_PRESET_COUNT }, (_, index) => this._normalizeShadowSnapshot(parsed?.[index]));
          } catch (_) {
            this._shadowPresets = this._loadShadowPresets();
          }
          this._syncToolOptionsState({ suppressRender: false });
          break;
        case 'assetDropShadowOnly':
          this._dropShadowOnly = !!setting.value;
          this._syncDropShadowOnlyPreview();
          this._syncToolOptionsState({ suppressRender: false });
          break;
        case 'assetDropShadowQuality':
          this._updatePreviewShadow({ force: true });
          this._syncScatterPreviewShadowSettingsForActiveElevation({ force: true });
          break;
        default:
          break;
      }
    };
    try {
      hooks.on('updateSetting', handler);
      this._dropShadowSettingsHook = handler;
    } catch (_) {
      this._dropShadowSettingsHook = null;
    }
  }

  _isPreviewShadowActive() {
    return this._previewShadowRenderer.isActive();
  }

  _ensurePreviewShadowContainer() {
    return this._previewShadowRenderer.ensureContainer();
  }

  _buildPreviewDilationOffsets(radius) {
    return buildPreviewDilationOffsets(radius);
  }

  _computeRotatedSpriteBounds(width, height, rotationRadians) {
    return computeRotatedSpriteBounds(width, height, rotationRadians);
  }

  _getSafePreviewRenderTextureLimit(renderer) {
    try {
      const quality = readShadowQualityConfig();
      const gl = renderer?.gl || renderer?.context?.gl || canvas?.app?.renderer?.gl || canvas?.app?.renderer?.context?.gl;
      const hardwareMaxTextureSize = gl
        ? gl.getParameter(gl.MAX_TEXTURE_SIZE)
        : 4096;
      return resolveSafePreviewRenderTextureLimit({
        hardwareMaxTextureSize,
        previewMaxTextureSize: quality?.previewMaxTextureSize
      });
    } catch (_) {
      return 4096;
    }
  }

  _resolveSafePreviewRenderTarget(width, height, { renderer = null, resolution = 1, minSize = 1 } = {}) {
    const maxTextureSize = this._getSafePreviewRenderTextureLimit(renderer);
    return resolveSafePreviewRenderTarget(width, height, {
      maxTextureSize,
      resolution,
      minSize
    });
  }

  _updatePreviewShadow({ force = false } = {}) {
    return this._previewShadowRenderer.update({ force });
  }

  _cleanupPreviewShadowResources(container) {
    return this._previewShadowRenderer.cleanup(container);
  }

  _isScatterPreviewShadowActive() {
    return this._scatterPreviewShadowRenderer.isActive();
  }

  _snapshotScatterPreviewShadowSettings() {
    return this._scatterPreviewShadowRenderer.snapshotSettings();
  }

  _syncScatterPreviewShadowSettingsForActiveElevation({ force = false } = {}) {
    return this._scatterPreviewShadowRenderer.syncSettingsForActiveElevation({ force });
  }

  _ensureScatterPreviewShadowContainer(container) {
    return this._scatterPreviewShadowRenderer.ensureContainer(container);
  }

  _scheduleScatterPreviewShadowUpdate({ force = false, key = null } = {}) {
    return this._scatterPreviewShadowRenderer.scheduleUpdate({ force, key });
  }

  _registerScatterPreviewShadowTextureListener(baseTexture) {
    return this._scatterPreviewShadowRenderer.registerTextureListener(baseTexture);
  }

  _computeScatterPreviewInstanceBounds(instance) {
    return this._scatterPreviewShadowRenderer.computeInstanceBounds(instance);
  }

  _computeScatterPreviewBounds(instances) {
    return this._scatterPreviewShadowRenderer.computeBounds(instances);
  }

  _updateScatterPreviewShadowForGroup(group, { force = false } = {}) {
    return this._scatterPreviewShadowRenderer.updateGroup(group, { force });
  }

  _computeShadowPreviewSignature() {
    return this._previewShadowRenderer.computeOffsetPreviewSignature();
  }

  _scheduleShadowOffsetPreviewUpdate({ force = false } = {}) {
    return this._previewShadowRenderer.scheduleOffsetPreviewUpdate({ force });
  }

  _renderShadowOffsetPreview(signature, { force = false, requestId = null } = {}) {
    return this._previewShadowRenderer.renderOffsetPreview(signature, { force, requestId });
  }

  _clearShadowOffsetPreview({ notify = true } = {}) {
    return this._previewShadowRenderer.clearOffsetPreview({ notify });
  }

  _createPreviewTexture(asset) {
    const textureUrl = this._encodeAssetPath(asset.url);
    return getSharedTexture(textureUrl);
  }

  _buildPreviewElement() {
    const container = new PIXI.Container();
    container.sortableChildren = true;
    container.eventMode = 'none';
    container.name = 'fa-nexus-asset-preview';
    container.faNexusAssetPlacementPreview = true;
    container.faNexusPreviewHasContent = false;
    container.faNexusPreviewActive = false;
    this._previewContainer = container;

    const texture = this._createPreviewTexture(this.currentAsset);
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5, 0.5);
    sprite.rotation = (this._getPendingRotation() * Math.PI) / 180;
    container.addChild(sprite);
    this._ensurePreviewShadowContainer();

    return { container, sprite };
  }

  _createPreviewElement() {
    if (!this.currentAsset) return;
    const assetPx = this._getAssetBasePxPerSquare();
    const sceneGridSize = canvas?.scene?.grid?.size || 100;
    const zoomLevel = canvas?.stage?.scale?.x || 1;
    const gridScaleFactor = sceneGridSize / assetPx;

    const gridWidth = Math.max(0.01, Number(this.currentAsset.grid_width || 1));
    const gridHeight = Math.max(0.01, Number(this.currentAsset.grid_height || 1));
    const tileWidth = gridWidth * assetPx;
    const tileHeight = gridHeight * assetPx;

    const scaleMul = this._getPendingScale();
    const { container, sprite } = this._buildPreviewElement();

    // Set container properties for sorting
    const primary = canvas?.primary;
    const tilesSortLayer = (() => {
      try { return primary?.constructor?.SORT_LAYERS?.TILES ?? 0; }
      catch (_) { return 0; }
    })();
    container.sortLayer = tilesSortLayer;
    this._applyPlacementPreviewOrdering();

    // Add to canvas
    const parent = primary || canvas?.stage;
    if (parent) {
      parent.addChild(container);
      if ('sortDirty' in parent) parent.sortDirty = true;
      parent.sortChildren?.();
    }

    // Store properties
    container._tileWidth = tileWidth;
    container._tileHeight = tileHeight;
    container._gridScaleFactor = gridScaleFactor;
    container._scaleMul = scaleMul;
    container._sprite = sprite;
    this._applyPreviewHsbc();
    this._lastZoom = zoomLevel;
    this._syncPlacementPreviewVisibility();

    // Ensure initial sizing reflects world scale and canvas zoom
    this._applyZoomToPreview(zoomLevel);
    this._applyPendingRotationToPreview();
    this._applyPendingScaleToPreview();
    this._applyPendingFlipToPreview({ forceShadow: true });
    this._updatePreviewShadow({ force: true });

    // Position at current pointer or frozen world
    try {
      this._applyPreviewAnchor(this._getPreviewAnchorWorld(this._getViewportCenterWorldPosition()));
    } catch (_) {}

    if (this._pendingEditState?.doc) {
      this._applyTileStateToPlacement(this._pendingEditState.doc, { force: true });
    } else if ((this._isEditingExistingTile || this._replaceOriginalOnPlace) && this._editingTile) {
      this._applyTileStateToPlacement(this._editingTile, { force: true });
    }
    this._scheduleShadowOffsetPreviewUpdate({ force: true });
    if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) {
      if (this._scatterMergeEnabled) this._ensureScatterPreviewOverlay();
      this._syncScatterPreviewOrdering();
      this._updateScatterCursor();
    }
  }

  _ensurePointerSnapshot(options = {}) {
    return this._editSession.ensurePointerSnapshot(options);
  }

  _capturePointerSnapshot(options = {}) {
    return this._editSession.capturePointerSnapshot(options);
  }

  _isScreenPointOnCanvas(point) {
    return this._editSession.isScreenPointOnCanvas(point);
  }

  _resolveRendererPointer() {
    return this._editSession.resolveRendererPointer();
  }

  _buildAssetDataFromTile(tileDocument) {
    return this._editSession.buildAssetDataFromTile(tileDocument);
  }

  _readScatterTileData(tileDocument) {
    try {
      const doc = tileDocument?.document ?? tileDocument;
      if (!doc) return null;
      const direct = doc?.getFlag?.('fa-nexus', SCATTER_FLAG_KEY);
      const payload = direct !== undefined ? direct : (doc?.flags?.['fa-nexus']?.[SCATTER_FLAG_KEY] || doc?._source?.flags?.['fa-nexus']?.[SCATTER_FLAG_KEY]);
      if (!payload || typeof payload !== 'object') return null;
      const version = Number(payload.version || SCATTER_VERSION);
      if (version !== SCATTER_VERSION) return null;
      if (!Array.isArray(payload.instances) || !payload.instances.length) return null;
      return payload;
    } catch (_) {
      return null;
    }
  }

  _normalizeScatterInstances(raw = []) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => {
        const normalized = {
          id: typeof entry.id === 'string' ? entry.id : this._createScatterInstanceId(),
          src: typeof entry.src === 'string' ? entry.src : '',
          x: Number(entry.x) || 0,
          y: Number(entry.y) || 0,
          w: Math.max(1, Number(entry.w) || 0),
          h: Math.max(1, Number(entry.h) || 0),
          r: Number(entry.r) || 0,
          flipH: !!entry.flipH,
          flipV: !!entry.flipV
        };
        if (entry.affine) normalized.affine = resolveScatterInstanceAffine(entry);
        return normalized;
      })
      .filter((entry) => entry.src);
  }

  async _editScatterTile(doc, payload, options = {}) {
    return this._editSession.editScatterTile(doc, payload, options);
  }

  _captureTileVisibility(tileObject) {
    try {
      if (!tileObject) return null;
      const snapshot = {
        visible: tileObject.visible,
        renderable: typeof tileObject.renderable === 'boolean' ? tileObject.renderable : undefined,
        alpha: Number.isFinite(tileObject.alpha) ? tileObject.alpha : undefined,
        mesh: null,
        sprite: null,
        root: null
      };
      const mesh = tileObject.mesh;
      if (mesh) {
        snapshot.mesh = {
          visible: mesh.visible,
          renderable: typeof mesh.renderable === 'boolean' ? mesh.renderable : undefined,
          alpha: Number.isFinite(mesh.alpha) ? mesh.alpha : undefined
        };
      }
      const sprite = tileObject.sprite;
      if (sprite) {
        snapshot.sprite = {
          visible: sprite.visible,
          renderable: typeof sprite.renderable === 'boolean' ? sprite.renderable : undefined,
          alpha: Number.isFinite(sprite.alpha) ? sprite.alpha : undefined
        };
      }
      const root = tileObject.root;
      if (root) {
        snapshot.root = {
          visible: root.visible,
          renderable: typeof root.renderable === 'boolean' ? root.renderable : undefined,
          alpha: Number.isFinite(root.alpha) ? root.alpha : undefined
        };
      }
      return snapshot;
    } catch (_) {
      return null;
    }
  }

  _applyTileVisibilitySnapshot(tileObject, snapshot) {
    if (!tileObject || !snapshot) return;
    if (tileObject.destroyed) return;
    try {
      if (snapshot.visible !== undefined) tileObject.visible = snapshot.visible;
      if (snapshot.renderable !== undefined && typeof tileObject.renderable === 'boolean') {
        tileObject.renderable = snapshot.renderable;
      }
      if (snapshot.alpha !== undefined && Number.isFinite(snapshot.alpha)) tileObject.alpha = snapshot.alpha;
      const mesh = tileObject.mesh;
      const meshSnap = snapshot.mesh;
      if (mesh && !mesh.destroyed && meshSnap) {
        if (meshSnap.visible !== undefined) mesh.visible = meshSnap.visible;
        if (meshSnap.renderable !== undefined && typeof mesh.renderable === 'boolean') {
          mesh.renderable = meshSnap.renderable;
        }
        if (meshSnap.alpha !== undefined && Number.isFinite(meshSnap.alpha)) mesh.alpha = meshSnap.alpha;
      }
      const sprite = tileObject.sprite;
      const spriteSnap = snapshot.sprite;
      if (sprite && !sprite.destroyed && spriteSnap) {
        if (spriteSnap.visible !== undefined) sprite.visible = spriteSnap.visible;
        if (spriteSnap.renderable !== undefined && typeof sprite.renderable === 'boolean') {
          sprite.renderable = spriteSnap.renderable;
        }
        if (spriteSnap.alpha !== undefined && Number.isFinite(spriteSnap.alpha)) sprite.alpha = spriteSnap.alpha;
      }
      const root = tileObject.root;
      const rootSnap = snapshot.root;
      if (root && !root.destroyed && rootSnap) {
        if (rootSnap.visible !== undefined) root.visible = rootSnap.visible;
        if (rootSnap.renderable !== undefined && typeof root.renderable === 'boolean') {
          root.renderable = rootSnap.renderable;
        }
        if (rootSnap.alpha !== undefined && Number.isFinite(rootSnap.alpha)) root.alpha = rootSnap.alpha;
      }
    } catch (_) {}
  }

  _hideTileForEditing(tileObject) {
    if (!tileObject || tileObject.destroyed) return;
    try {
      tileObject.visible = false;
      if (typeof tileObject.renderable === 'boolean') tileObject.renderable = false;
      if (Number.isFinite(tileObject.alpha)) tileObject.alpha = 0;
      const mesh = tileObject.mesh;
      if (mesh && !mesh.destroyed) {
        mesh.visible = false;
        if (typeof mesh.renderable === 'boolean') mesh.renderable = false;
        if (Number.isFinite(mesh.alpha)) mesh.alpha = 0;
      }
      const sprite = tileObject.sprite;
      if (sprite && !sprite.destroyed) {
        sprite.visible = false;
        if (typeof sprite.renderable === 'boolean') sprite.renderable = false;
        if (Number.isFinite(sprite.alpha)) sprite.alpha = 0;
      }
      const root = tileObject.root;
      if (root && !root.destroyed) {
        root.visible = false;
        if (typeof root.renderable === 'boolean') root.renderable = false;
        if (Number.isFinite(root.alpha)) root.alpha = 0;
      }
    } catch (_) {}
  }

  _releaseTileSelection(tileObject) {
    try {
      if (tileObject?.controlled && typeof tileObject.release === 'function') {
        tileObject.release();
      }
      const layer = canvas?.tiles;
      const controlled = Array.isArray(layer?.controlled) ? layer.controlled : null;
      if (layer && Array.isArray(controlled) && controlled.length) {
        try { layer.releaseAll?.(); }
        catch (_) {
          for (const placeable of controlled) {
            try { placeable.release?.(); }
            catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  _restoreEditingTileVisibility() {
    try {
      const tileObject = this._editingTileObject;
      const snapshot = this._editingTileVisibilitySnapshot;
      if (!tileObject || !snapshot) {
        this._editingTileVisibilitySnapshot = null;
        return;
      }
      this._applyTileVisibilitySnapshot(tileObject, snapshot);
    } catch (_) {
      // ignore restore failures
    } finally {
      this._editingTileVisibilitySnapshot = null;
    }
  }

  _suspendEditingTileShadow(doc) {
    try {
      const manager = getAssetShadowManager(this.app);
      if (!manager || typeof manager.suspendTile !== 'function') return false;
      return !!manager.suspendTile(doc);
    } catch (_) {
      return false;
    }
  }

  _resumeEditingTileShadow() {
    if (!this._editingTileShadowSuspended) return;
    try {
      const manager = getAssetShadowManager(this.app);
      const tile = this._editingTile || this._scatterEditTile;
      if (manager && typeof manager.resumeTile === 'function' && tile) {
        manager.resumeTile(tile);
      }
    } catch (_) {
      // ignore resume failures
    } finally {
      this._editingTileShadowSuspended = false;
    }
  }

  _applyTileStateToPlacement(tileDocument, { force = false } = {}) {
    return this._editSession.applyTileStateToPlacement(tileDocument, { force });
  }

  _computeWorldSizeForAsset(asset, scaleMul = this._getPendingScale()) {
    try {
      const assetPx = this._getAssetBasePxPerSquare();
      const sceneGridSize = canvas?.scene?.grid?.size || 100;
      const gridScaleFactor = sceneGridSize / assetPx;
      const gw = Math.max(0.01, Number(asset?.grid_width || 1));
      const gh = Math.max(0.01, Number(asset?.grid_height || 1));
      const sm = Number(scaleMul || 1) || 1;
      const worldWidth = gw * assetPx * gridScaleFactor * sm;
      const worldHeight = gh * assetPx * gridScaleFactor * sm;
      return { worldWidth, worldHeight };
    } catch (_) {
      return { worldWidth: 200, worldHeight: 200 };
    }
  }

  _showLoadingOverlay(dimensions = { worldWidth: 200, worldHeight: 200 }) {
    return this._previewRuntime.showLoadingOverlay(dimensions);
  }

  _hideLoadingOverlay() {
    return this._previewRuntime.hideLoadingOverlay();
  }

  _updateLoadingOverlaySize(worldWidth, worldHeight) {
    return this._previewRuntime.updateLoadingOverlaySize(worldWidth, worldHeight);
  }

  _updateLoadingOverlayPointer(screenX, screenY) {
    return this._previewRuntime.updateLoadingOverlayPointer(screenX, screenY);
  }

  _assetRequiresDownload(asset) {
    if (!asset) return false;
    if (asset.cachedLocalPath) return false;
    const source = String(asset.source || '').toLowerCase();
    if (source !== 'cloud') return false;
    return true;
  }

  async _ensureAssetLocal(asset) {
    return this._assetLocalizationWorkflow.ensureAssetLocal(asset);
  }

  async _ensureRandomCommitAssetLocal() {
    return this._assetLocalizationWorkflow.ensureRandomCommitAssetLocal(this.currentAsset);
  }

  async _prepareCurrentAssetPreview(options = {}) {
    return this._previewRuntime.prepareCurrentAssetPreview(options);
  }

  async _flushQueuedPlacement() {
    return this._previewRuntime.flushQueuedPlacement();
  }

  _removePreviewElement() {
    const container = this._previewContainer;
    if (container) {
      this._cleanupPreviewShadowResources(container);
      container.parent?.removeChild(container);
      container.destroy({ children: true });
    }
    this._previewContainer = null;
    this.previewElement = null;
    this._previewShadowRenderer.resetTextureListener();
    this._clearShadowOffsetPreview();
    if (container) this._notifyPreviewLayerChange('asset-placement');
  }

  _ensureScatterOverlay() {
    return this._scatterHoverPreviewRuntime.ensure();
  }

  _clearScatterOverlay() {
    return this._scatterHoverPreviewRuntime.clear();
  }

  _applyScatterHoverOrdering() {
    return this._scatterHoverPreviewRuntime.applyOrdering();
  }

  _syncScatterHoverPreview(worldX = null, worldY = null) {
    return this._scatterHoverPreviewRuntime.syncPreview(worldX, worldY);
  }

  _drawScatterSpacingMarkers(gfx, pos, spacingWorld, color, alpha, brushRadius) {
    return this._scatterHoverPreviewRuntime.drawSpacingMarkers(gfx, pos, spacingWorld, color, alpha, brushRadius);
  }

  _updateScatterCursor(worldX = null, worldY = null) {
    return this._scatterHoverPreviewRuntime.updateCursor(worldX, worldY);
  }

  _ensureScatterPreviewOverlay() {
    return this._scatterPreviewGroupRuntime.ensureOverlay();
  }

  _clearScatterPreviewOverlay() {
    return this._scatterPreviewGroupRuntime.clear();
  }

  _resetScatterPreviewSession() {
    return this._scatterPreviewGroupRuntime.resetSession();
  }

  _beginScatterPreviewSession(instances = [], { elevation = null, shadowSettings = null } = {}) {
    return this._scatterPreviewGroupRuntime.beginSession(instances, { elevation, shadowSettings });
  }

  _getScatterPreviewTexture(src) {
    return this._scatterPreviewGroupRuntime.getTexture(src);
  }

  _addScatterPreviewInstance(instance) {
    return this._scatterPreviewGroupRuntime.addInstance(instance);
  }

  _removeScatterPreviewInstance(instanceId) {
    return this._scatterPreviewGroupRuntime.removeInstance(instanceId);
  }

  _rebuildScatterPreviewSprites() {
    return this._scatterPreviewGroupRuntime.rebuildSprites();
  }

  _createScatterInstanceId() {
    return `scatter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async _collectScatterStampInstances(worldX, worldY) {
    return this._scatterPlacementSession.collectStampInstances(worldX, worldY);
  }

  async _scatterPreviewStampAtWorld(worldX, worldY) {
    return this._scatterPlacementSession.previewStampAtWorld(worldX, worldY);
  }

  _scatterEraseAtWorld(worldX, worldY, { force = false } = {}) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return;
    if (!this._scatterMergeEnabled || (!this._scatterEraseEnabled && !force)) return;
    const radius = this._getScatterBrushRadius();
    if (!radius || radius <= 0) return;
    const radiusSq = radius * radius;
    const nextInstances = [];
    const removedIds = new Set();
    for (const instance of this._scatterPreviewInstances) {
      const dx = instance.x - worldX;
      const dy = instance.y - worldY;
      if ((dx * dx + dy * dy) <= radiusSq) {
        if (instance.id) this._removeScatterPreviewInstance(instance.id);
        if (instance.id) removedIds.add(instance.id);
      } else {
        nextInstances.push(instance);
      }
    }
    this._scatterPreviewInstances = nextInstances;
    if (removedIds.size) this._scatterCommitSession.removeInstancesById(removedIds);
    if (removedIds.size) this._scatterHistoryDirty = true;
  }

  _computeScatterInstanceBounds(instance) {
    return computeScatterInstanceBounds(instance);
  }

  _computeScatterBounds(instances) {
    return computeScatterTileBounds(instances);
  }

  _buildScatterInstanceData(asset, worldPoint, { rotation, scale, flip }) {
    if (!asset || !worldPoint) return null;
    const assetPx = this._getAssetBasePxPerSquare();
    const dims = this._computeWorldSizeForAsset(asset, scale);
    const placedWidth = Math.round(Number(dims.worldWidth || assetPx));
    const placedHeight = Math.round(Number(dims.worldHeight || assetPx));
    const src = this._encodeAssetPath(asset.path || asset.url || '');
    if (!src) return null;
    return {
      id: this._createScatterInstanceId(),
      src,
      x: Math.round(worldPoint.x),
      y: Math.round(worldPoint.y),
      w: placedWidth,
      h: placedHeight,
      r: rotation ?? 0,
      flipH: !!flip?.horizontal,
      flipV: !!flip?.vertical
    };
  }

  _getScatterSessionKey(elevation) {
    const value = Number.isFinite(elevation) ? elevation : 0;
    return String(quantizeElevation(value));
  }

  _quantizeScatterElevation(elevation) {
    return quantizeElevation(elevation);
  }

  _getAssetShadowManager() {
    return getAssetShadowManager(this.app);
  }

  _getScatterPreviewGroupKey(elevation) {
    return this._scatterPreviewGroupRuntime.getGroupKey(elevation);
  }

  _notifyPreviewLayerChange(source = 'scatter') {
    try { Hooks?.callAll?.(PREVIEW_LAYER_HOOK, { source }); } catch (error) {
      Logger.error?.('AssetPlacement.previewLayerHook.failed', {
        source,
        error: String(error?.message || error)
      });
    }
  }

  _syncScatterPreviewFlags() {
    return this._scatterPreviewGroupRuntime.syncFlags();
  }

  _ensureScatterPreviewGroup(elevation, { setActive = true } = {}) {
    return this._scatterPreviewGroupRuntime.ensureGroup(elevation, { setActive });
  }

  _destroyScatterPreviewGroup(group) {
    return this._scatterPreviewGroupRuntime.destroyGroup(group);
  }

  _scatterSessionShadowAccess() {
    return {
      read: (key) => this._scatterPreviewShadowRenderer.getSettings(key),
      write: (key, settings) => this._scatterPreviewShadowRenderer.setSettings(key, settings),
      snapshot: () => this._snapshotScatterPreviewShadowSettings()
    };
  }

  _startScatterMergeSession() {
    this._scatterCommitSession.beginMergeSession({
      editing: this._scatterEditing,
      ensurePreviewSession: () => this._ensureScatterPreviewOverlay(),
      beginPreviewSession: () => this._beginScatterPreviewSession(),
      recordSnapshot: (options) => this._recordScatterHistorySnapshot(options)
    });
  }

  _registerScatterSessionInstances(instances, elevation) {
    if (this._scatterEditing) return;
    this._scatterCommitSession.registerInstances(instances, elevation, this._scatterSessionShadowAccess());
  }

  _resetScatterMergeSession() {
    this._scatterCommitSession.resetMergeSession({
      clearPreviewSession: () => this._clearScatterPreviewOverlay()
    });
  }

  _resetScatterHistory() {
    this._scatterCommitSession.resetHistory();
  }

  _canUndoScatterHistory() {
    return this._scatterCommitSession.canUndo();
  }

  _canRedoScatterHistory() {
    return this._scatterCommitSession.canRedo();
  }

  _recordScatterHistorySnapshot({ force = false } = {}) {
    return this._scatterCommitSession.recordSnapshot({
      enabled: this._scatterMergeEnabled,
      brushModeActive: this._scatterMode === ASSET_SCATTER_MODE_BRUSH,
      editing: this._scatterEditing,
      instances: this._scatterPreviewInstances,
      previewElevation: this._previewElevation,
      shadowSettings: this._scatterPreviewShadowRenderer.settings
    }, {
      force
    });
  }

  _applyScatterHistorySnapshot(snapshot) {
    return this._scatterCommitSession.applySnapshot(snapshot, {
      previewElevation: this._previewElevation,
      beginPreviewSession: (instances, options) => this._beginScatterPreviewSession(instances, options),
      shadow: this._scatterSessionShadowAccess(),
      syncOrdering: () => this._syncScatterPreviewOrdering(),
      syncToolOptions: () => this._syncToolOptionsState({ suppressRender: false })
    });
  }

  _undoScatterHistory() {
    return this._scatterCommitSession.undo({
      previewElevation: this._previewElevation,
      beginPreviewSession: (instances, options) => this._beginScatterPreviewSession(instances, options),
      shadow: this._scatterSessionShadowAccess(),
      syncOrdering: () => this._syncScatterPreviewOrdering(),
      syncToolOptions: () => this._syncToolOptionsState({ suppressRender: false })
    });
  }

  _redoScatterHistory() {
    return this._scatterCommitSession.redo({
      previewElevation: this._previewElevation,
      beginPreviewSession: (instances, options) => this._beginScatterPreviewSession(instances, options),
      shadow: this._scatterSessionShadowAccess(),
      syncOrdering: () => this._syncScatterPreviewOrdering(),
      syncToolOptions: () => this._syncToolOptionsState({ suppressRender: false })
    });
  }

  _resolveScatterTileTextureSrc(instances) {
    return resolveScatterTileTextureSrc(instances);
  }

  _buildScatterGroupTileData(instances, elevationOverride = null, shadowSettings = null, sortOverride = null) {
    const scatterPayload = buildScatterTilePayload(instances, { version: SCATTER_VERSION });
    if (!scatterPayload) return null;
    const elevation = Number.isFinite(elevationOverride) ? elevationOverride : this._previewElevation;
    const numericSortOverride = Number(sortOverride);
    const nextSort = Number.isFinite(numericSortOverride)
      ? numericSortOverride
      : (this._interactionController.computeNextSortAtElevation?.(elevation) ?? 0);
    const globalDropShadowEnabled = this._isGlobalDropShadowEnabled();
    const dropShadowEnabled = globalDropShadowEnabled && this.isDropShadowEnabled();
    const dropShadow = dropShadowEnabled
      ? this._buildPlacementDropShadowPayload(shadowSettings || this._snapshotScatterPreviewShadowSettings())
      : null;
    return buildScatterPlacementTileData({
      scatterPayload,
      scatterFlagKey: SCATTER_FLAG_KEY,
      elevation,
      sort: nextSort,
      hsbc: this._getPersistedHsbc(),
      dropShadow,
      placementLevelId: this._resolveActivePlacementLevelId(),
      encodeAssetPath: (path) => this._encodeAssetPath(path)
    });
  }

  _buildScatterEditAppearanceSignature() {
    const dropShadowEnabled = this._isGlobalDropShadowEnabled() && this.isDropShadowEnabled();
    return JSON.stringify({
      hsbc: this._getPersistedHsbc(),
      dropShadow: dropShadowEnabled ? this._buildPlacementDropShadowPayload() : null
    });
  }

  _buildScatterGroupTileUpdate(instances, tileDoc, {
    includeGeometry = true,
    includeAppearance = true
  } = {}) {
    const commit = buildScatterEditCommit({
      worldInstances: instances,
      tile: this._scatterEditState?.tilePose || tileDoc,
      version: SCATTER_VERSION
    });
    if (!commit) return null;
    const globalDropShadowEnabled = this._isGlobalDropShadowEnabled();
    const dropShadowEnabled = globalDropShadowEnabled && this.isDropShadowEnabled();
    const update = buildScatterPlacementTileUpdate({
      tileId: tileDoc.id,
      scatterPayload: commit.scatterPayload,
      scatterFlagKey: SCATTER_FLAG_KEY,
      hsbc: this._getPersistedHsbc(),
      dropShadow: dropShadowEnabled ? this._buildPlacementDropShadowPayload() : null,
      clearDropShadow: !dropShadowEnabled,
      tilePose: commit.tilePose
    });
    if (!includeGeometry) {
      for (const field of [
        'x',
        'y',
        'width',
        'height',
        'rotation',
        'texture.src',
        'texture.anchorX',
        'texture.anchorY',
        `flags.fa-nexus.${SCATTER_FLAG_KEY}`
      ]) delete update[field];
    }
    if (!includeAppearance) {
      for (const field of [
        'flags.fa-nexus.hsbc',
        'flags.fa-nexus.shadow',
        'flags.fa-nexus.shadowAlpha',
        'flags.fa-nexus.shadowDilation',
        'flags.fa-nexus.shadowBlur',
        'flags.fa-nexus.shadowOffsetDistance',
        'flags.fa-nexus.shadowOffsetAngle',
        'flags.fa-nexus.shadowOffsetX',
        'flags.fa-nexus.shadowOffsetY',
        'flags.fa-nexus.shadowOnly'
      ]) delete update[field];
    }
    return update;
  }

  _hasScatterEditGeometryChanges(instances) {
    return hasScatterEditGeometryChanges(instances, this._scatterEditState?.baselineSignature);
  }

  _hasScatterEditAppearanceChanges() {
    return this._buildScatterEditAppearanceSignature() !== this._scatterEditState?.appearanceSignature;
  }

  _collectScatterCommitGroups() {
    return this._scatterCommitSession.collectCommitGroups({
      previewGroups: this._scatterPreviewGroups,
      fallbackInstances: this._scatterPreviewInstances,
      previewElevation: this._previewElevation,
      previewSort: this._previewSort,
      readShadowSettings: (key) => this._scatterPreviewShadowRenderer.getSettings(key),
      snapshotShadowSettings: () => this._snapshotScatterPreviewShadowSettings()
    });
  }

  async _commitScatterGroups(groups) {
    return this._scatterCommitWorkflow.commitGroups(groups);
  }

  async _commitScatterMergeSession() {
    return this._scatterCommitWorkflow.commitMergeSession();
  }

  async _commitScatterEditChanges(options = {}) {
    return this._scatterCommitWorkflow.commitEditChanges(options);
  }

  _stopScatterStroke() {
    void this._endScatterPreviewShadowBatch({ awaitQueue: true });
    this._scatterPainting = false;
    this._scatterLastPointerWorld = null;
    this._scatterStrokeDistance = 0;
    this._scatterCommitSession.clearQueue();
  }

  _beginScatterPreviewShadowBatch() {
    return this._scatterPreviewShadowRenderer.beginBatch();
  }

  async _endScatterPreviewShadowBatch({ awaitQueue = false } = {}) {
    return this._scatterPreviewShadowRenderer.endBatch({ awaitQueue });
  }

  _beginScatterShadowBatch() {
    if (this._scatterShadowBatchActive) return;
    if (this._scatterMode !== ASSET_SCATTER_MODE_BRUSH) return;
    if (this._scatterMergeEnabled) return;
    if (!this._isGlobalDropShadowEnabled() || !this.isDropShadowEnabled()) return;
    const manager = getAssetShadowManager(this.app);
    if (!manager?.suspendRebuilds) return;
    manager.suspendRebuilds();
    this._scatterShadowBatchManager = manager;
    this._scatterShadowBatchActive = true;
  }

  async _endScatterShadowBatch({ awaitQueue = false } = {}) {
    if (!this._scatterShadowBatchActive) return;
    const manager = this._scatterShadowBatchManager || getAssetShadowManager(this.app);
    this._scatterShadowBatchManager = null;
    this._scatterShadowBatchActive = false;
    const queuePromise = awaitQueue ? this._scatterQueuePromise : null;
    if (queuePromise) {
      await this._scatterCommitSession.drainQueue({
        loggerTag: 'Placement.scatter.shadow.queueDrainFailed'
      });
    }
    manager?.resumeRebuilds?.({ immediate: false });
    this._refreshShadowElevationContext({ adopt: false });
  }

  _resolveScatterQueueAction({ erase = null } = {}) {
    return this._scatterPlacementSession.resolveQueueAction({ erase });
  }

  _queueScatterStamp(worldX, worldY, { erase = null } = {}) {
    this._scatterPlacementSession.queueStamp(worldX, worldY, { erase });
  }

  async _processScatterQueue() {
    return this._scatterPlacementSession.processQueue();
  }

  _scatterPaintAtWorld(worldX, worldY) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return;
    this._updateScatterCursor(worldX, worldY);
    if (this._scatterMergeEnabled) {
      this._ensureScatterPreviewOverlay();
    }
    const spacing = this._getScatterSpacingWorld();
    const erase = this._isScatterEraseActive();
    if (!spacing || spacing <= 0) {
      this._queueScatterStamp(worldX, worldY, { erase });
      this._scatterLastPointerWorld = { x: worldX, y: worldY };
      this._scatterStrokeDistance = 0;
      return;
    }
    if (!this._scatterLastPointerWorld) {
      this._queueScatterStamp(worldX, worldY, { erase });
      this._scatterLastPointerWorld = { x: worldX, y: worldY };
      this._scatterStrokeDistance = 0;
      return;
    }
    const dx = worldX - this._scatterLastPointerWorld.x;
    const dy = worldY - this._scatterLastPointerWorld.y;
    const dist = Math.hypot(dx, dy);
    if (!Number.isFinite(dist) || dist <= 0) return;
    const ux = dx / dist;
    const uy = dy / dist;
    let remaining = dist;
    let distanceSince = Number.isFinite(this._scatterStrokeDistance) ? this._scatterStrokeDistance : 0;
    if (distanceSince >= spacing) distanceSince = distanceSince % spacing;
    let stampX = this._scatterLastPointerWorld.x;
    let stampY = this._scatterLastPointerWorld.y;
    while (distanceSince + remaining >= spacing) {
      const needed = spacing - distanceSince;
      stampX += ux * needed;
      stampY += uy * needed;
      this._queueScatterStamp(stampX, stampY, { erase });
      remaining -= needed;
      distanceSince = 0;
    }
    this._scatterStrokeDistance = distanceSince + remaining;
    this._scatterLastPointerWorld = { x: worldX, y: worldY };
  }

  async _scatterStampAtWorld(worldX, worldY) {
    return this._scatterPlacementSession.tileStampAtWorld(worldX, worldY);
  }

  _pickScatterAsset() {
    if (this.isRandomMode && Array.isArray(this.randomAssets) && this.randomAssets.length) {
      return this._pickRandomAsset() || this.currentAsset;
    }
    return this.currentAsset;
  }

  _getScatterRotation() {
    const base = this._normalizeRotation(this.currentRotation);
    if (!this._hasRandomRotationEnabled()) return base;
    return this._sampleRotationRandomValue();
  }

  _getScatterScale() {
    const base = this._clampScale(this.currentScale);
    if (!this._hasRandomScaleEnabled()) return base;
    return this._sampleScaleRandomValue();
  }

  _getScatterFlipState() {
    const baseHorizontal = !!this._flipHorizontal;
    const baseVertical = !!this._flipVertical;
    const horizontal = this._flipRandomHorizontalEnabled ? (Math.random() < 0.5 ? !baseHorizontal : baseHorizontal) : baseHorizontal;
    const vertical = this._flipRandomVerticalEnabled ? (Math.random() < 0.5 ? !baseVertical : baseVertical) : baseVertical;
    return { horizontal, vertical };
  }

  _buildScatterTileData(asset, worldPoint, { rotation, scale, flip, sort }) {
    if (!asset || !worldPoint) return null;
    const assetPx = this._getAssetBasePxPerSquare();
    const sceneGridSize = canvas?.scene?.grid?.size || 100;
    const gridScaleFactor = sceneGridSize / assetPx;
    const dims = this._computeWorldSizeForAsset(asset, scale);
    const placedWidth = Math.round(Number(dims.worldWidth || assetPx));
    const placedHeight = Math.round(Number(dims.worldHeight || assetPx));
    const globalDropShadowEnabled = this._isGlobalDropShadowEnabled();
    const dropShadowEnabled = globalDropShadowEnabled && this.isDropShadowEnabled();
    const { tileData } = this._buildPlacementTileData({
      assetPath: asset.path || asset.url || '',
      width: placedWidth,
      height: placedHeight,
      x: Math.round(worldPoint.x),
      y: Math.round(worldPoint.y),
      rotation: rotation ?? 0,
      sort,
      elevation: this._previewElevation,
      flipState: flip,
      dropShadowEnabled
    });
    return tileData;
  }

  _startInteractionSession() {
    return this._placementInteractionSession.start();
  }

  _cleanupInteractionSessionState() {
    return this._placementInteractionSession.cleanup();
  }

  _stopInteractionSession() {
    return this._placementInteractionSession.stop();
  }

  async _handleCanvasPlacement(event, pointerContext = null) {
    try {
      if (this._isEditingExistingTile) {
        return;
      }
      if (this._previewFrozen && this._frozenPreviewWorld) {
        const frozenWorld = { x: this._frozenPreviewWorld.x, y: this._frozenPreviewWorld.y };
        const screen = this._frozenPointerScreen ? { ...this._frozenPointerScreen } : null;
        await this._placeAtWorldCoordinates(frozenWorld, {
          screenX: screen?.x ?? null,
          screenY: screen?.y ?? null,
          reason: 'frozen'
        });
        return;
      }
      const screen = pointerContext?.screen;
      const screenX = Number(screen?.x ?? event?.clientX);
      const screenY = Number(screen?.y ?? event?.clientY);
      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
      await this._placeAtScreenCoordinates(screenX, screenY);
    } catch (e) {
      console.error('fa-nexus | place asset failed', e);
      ui.notifications?.error?.(`Failed to place asset: ${e?.message || e}`);
    }
  }

  async _placeAtScreenCoordinates(screenX, screenY) {
    try {
      const world = this._screenToCanvas(screenX, screenY);
      if (!world) return;
      await this._placeAtWorldCoordinates(world, { screenX, screenY, reason: 'screen' });
    } catch (e) {
      console.error('fa-nexus | place asset failed', e);
      ui.notifications?.error?.(`Failed to place asset: ${e?.message || e}`);
    }
  }

  async _placeAtWorldCoordinates(world, { screenX = null, screenY = null } = {}) {
    try {
      await this._commitWorkflow.placeAtWorldCoordinates(world, { screenX, screenY });
    } catch (e) {
      console.error('fa-nexus | place asset failed', e);
      ui.notifications?.error?.(`Failed to place asset: ${e?.message || e}`);
    }
  }

  _screenToCanvas(screenX, screenY) {
    try {
      const world = this._interactionController.worldFromScreen?.(screenX, screenY);
      return world ? { x: world.x, y: world.y } : null;
    } catch (_) {
      return null;
    }
  }

  _canvasToScreen(worldX, worldY) {
    try {
      if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return null;
      const stage = canvas?.stage;
      const canvasEl = this._interactionController?.getCanvasElement?.() || document.querySelector('canvas#board');
      if (!stage || !canvasEl || !stage.worldTransform) return null;
      if (typeof PIXI === 'undefined' || typeof PIXI.Point !== 'function') return null;
      const point = stage.worldTransform.apply(new PIXI.Point(worldX, worldY));
      if (!point) return null;
      const rect = canvasEl.getBoundingClientRect();
      return { x: rect.left + point.x, y: rect.top + point.y };
    } catch (_) {
      return null;
    }
  }

  _readPlacementSetting(key, fallback) {
    try {
      const settings = globalThis?.game?.settings;
      if (!settings || typeof settings.get !== 'function') return fallback;
      const stored = settings.get('fa-nexus', key);
      return stored === undefined || stored === null ? fallback : stored;
    } catch (error) {
      this._logPlacementSettingFailure('read', key, error);
      return fallback;
    }
  }

  _logPlacementSettingFailure(action, key, error) {
    Logger.warn(`Placement.settings.${action}.failed`, {
      key: String(key || ''),
      error: String(error?.message || error)
    });
  }

  _persistPlacementSetting(key, value) {
    try {
      const settings = globalThis?.game?.settings;
      if (!settings || typeof settings.set !== 'function') return;
      const maybe = settings.set('fa-nexus', key, value);
      if (maybe?.catch) {
        maybe.catch((error) => this._logPlacementSettingFailure('persist', key, error));
      }
    } catch (error) {
      this._logPlacementSettingFailure('persist', key, error);
    }
  }

  _resolvePlacementTransformSettingKey(key, { mode = this._scatterMode } = {}) {
    return resolvePlacementTransformSettingKey(key, { mode });
  }

  _readPlacementTransformSetting(key, fallback, options = {}) {
    const scopedKey = this._resolvePlacementTransformSettingKey(key, options);
    return this._readPlacementSetting(scopedKey, fallback);
  }

  _persistPlacementTransformSetting(key, value, options = {}) {
    // A one-Tile edit shows that Tile's scale, rotation and flips. A Scatter edit keeps writing: its transform
    // values are the settings for its new stamps.
    if (this._isEditingExistingTile || this._isExistingTileReplaceSession()) return;
    const scopedKey = this._resolvePlacementTransformSettingKey(key, options);
    this._persistPlacementSetting(scopedKey, value);
  }

  _ensureScatterPlacementTransformSettingsInitialized() {
    if (!!this._readPlacementSetting(SCATTER_TRANSFORM_INIT_SETTING, false)) return;
    for (const [sourceKey, targetKey] of Object.entries(SCATTER_PLACEMENT_TRANSFORM_SETTINGS)) {
      this._persistPlacementSetting(targetKey, this._readPlacementSetting(sourceKey, null));
    }
    this._persistPlacementSetting(SCATTER_TRANSFORM_INIT_SETTING, true);
  }

  _readPlacementScale(mode = this._scatterMode) {
    const raw = Number(this._readPlacementTransformSetting('assetPlacementScale', DEFAULT_SCALE, { mode }));
    if (!Number.isFinite(raw)) return DEFAULT_SCALE;
    return this._clampScale(raw);
  }

  _readPlacementScaleRandomEnabled(mode = this._scatterMode) {
    return !!this._readPlacementTransformSetting('assetPlacementScaleRandomEnabled', false, { mode });
  }

  _readPlacementScaleRandomMin(mode = this._scatterMode) {
    const raw = Number(this._readPlacementTransformSetting('assetPlacementScaleRandomMin', DEFAULT_SCALE_RANDOM_MIN, { mode }));
    return this._clampScaleRandomPercent(raw, DEFAULT_SCALE_RANDOM_MIN);
  }

  _readPlacementScaleRandomMax(mode = this._scatterMode) {
    const raw = Number(this._readPlacementTransformSetting('assetPlacementScaleRandomMax', DEFAULT_SCALE_RANDOM_MAX, { mode }));
    return this._clampScaleRandomPercent(raw, DEFAULT_SCALE_RANDOM_MAX);
  }

  _readPlacementRotation(mode = this._scatterMode) {
    const raw = Number(this._readPlacementTransformSetting('assetPlacementRotation', DEFAULT_ROTATION, { mode }));
    if (!Number.isFinite(raw)) return DEFAULT_ROTATION;
    return this._normalizeRotation(raw);
  }

  _readPlacementRotationRandomEnabled(mode = this._scatterMode) {
    return !!this._readPlacementTransformSetting('assetPlacementRotationRandomEnabled', false, { mode });
  }

  _readPlacementRotationRandomMin(mode = this._scatterMode) {
    const raw = Number(this._readPlacementTransformSetting('assetPlacementRotationRandomMin', DEFAULT_ROTATION_RANDOM_MIN, { mode }));
    return this._clampRotationRandomValue(raw, DEFAULT_ROTATION_RANDOM_MIN);
  }

  _readPlacementRotationRandomMax(mode = this._scatterMode) {
    const raw = Number(this._readPlacementTransformSetting('assetPlacementRotationRandomMax', DEFAULT_ROTATION_RANDOM_MAX, { mode }));
    return this._clampRotationRandomValue(raw, DEFAULT_ROTATION_RANDOM_MAX);
  }

  _readPlacementFlipHorizontal(mode = this._scatterMode) {
    return !!this._readPlacementTransformSetting('assetPlacementFlipHorizontal', false, { mode });
  }

  _readPlacementFlipVertical(mode = this._scatterMode) {
    return !!this._readPlacementTransformSetting('assetPlacementFlipVertical', false, { mode });
  }

  _readPlacementFlipRandomHorizontalEnabled(mode = this._scatterMode) {
    return !!this._readPlacementTransformSetting('assetPlacementFlipRandomHorizontal', false, { mode });
  }

  _readPlacementFlipRandomVerticalEnabled(mode = this._scatterMode) {
    return !!this._readPlacementTransformSetting('assetPlacementFlipRandomVertical', false, { mode });
  }

  _readStoredScatterMode() {
    const stored = String(this._readPlacementSetting('assetPlacementScatterMode', ASSET_SCATTER_MODE_SINGLE) || '');
    return normalizePlacementTransformMode(stored);
  }

  _readDropShadowPreference() {
    const stored = String(this._readPlacementSetting('assetPlacementDropShadowPreference', 'global') || '');
    if (stored === 'on') return true;
    if (stored === 'off') return false;
    return null;
  }

  _persistDropShadowPreference(value) {
    if (this._isLayerEditSession()) return;
    const stored = value === null || value === undefined
      ? 'global'
      : (value ? 'on' : 'off');
    this._persistPlacementSetting('assetPlacementDropShadowPreference', stored);
  }

  _readDropShadowOnlySetting() {
    try { return !!globalThis?.game?.settings?.get?.('fa-nexus', 'assetDropShadowOnly'); }
    catch (_) { return false; }
  }

  _readStoredScatterBrushSize() {
    try {
      const stored = Number(game?.settings?.get?.('fa-nexus', 'assetScatterBrushSize'));
      if (Number.isFinite(stored)) {
        return Math.min(SCATTER_BRUSH_SIZE_MAX, Math.max(SCATTER_BRUSH_SIZE_MIN, stored));
      }
    } catch (_) {}
    return SCATTER_BRUSH_SIZE_DEFAULT;
  }

  _readStoredScatterDensity() {
    try {
      const stored = Number(game?.settings?.get?.('fa-nexus', 'assetScatterDensity'));
      if (Number.isFinite(stored)) {
        const rounded = Math.round(stored);
        return Math.min(SCATTER_DENSITY_MAX, Math.max(SCATTER_DENSITY_MIN, rounded));
      }
    } catch (_) {}
    return SCATTER_DENSITY_DEFAULT;
  }

  _readStoredScatterSprayDeviation() {
    try {
      const stored = Number(game?.settings?.get?.('fa-nexus', 'assetScatterSprayDeviation'));
      if (Number.isFinite(stored)) {
        const clamped = Math.min(100, Math.max(0, stored));
        return clamped / 100;
      }
    } catch (_) {}
    return SCATTER_SPRAY_DEVIATION_DEFAULT;
  }

  _readStoredScatterSpacing() {
    try {
      const stored = Number(game?.settings?.get?.('fa-nexus', 'assetScatterSpacing'));
      if (Number.isFinite(stored)) {
        return Math.min(SCATTER_SPACING_MAX, Math.max(SCATTER_SPACING_MIN, stored));
      }
    } catch (_) {}
    return SCATTER_SPACING_DEFAULT;
  }

  _readStoredScatterMergeEnabled() {
    try {
      const stored = game?.settings?.get?.('fa-nexus', 'assetScatterMerge');
      if (stored === true) return true;
      if (stored === false) {
        this._persistScatterSetting('assetScatterMerge', true);
        return true;
      }
    } catch (_) {}
    return true;
  }

  _persistScatterSetting(key, value) {
    this._persistPlacementSetting(key, value);
  }

  _readShadowSetting(key, fallback, min, max, { wrapAngle = false } = {}) {
    try {
      const settings = globalThis?.game?.settings;
      if (!settings || typeof settings.get !== 'function') return fallback;
      const raw = settings.get('fa-nexus', key);
      if (wrapAngle) return this._normalizeShadowAngle(raw);
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return fallback;
      return Math.min(max, Math.max(min, numeric));
    } catch (_) {
      return fallback;
    }
  }

  _persistShadowSetting(key, value) {
    // In a layer edit the shadow values are the edited layer's. The panel's collapse state, the presets and the
    // offset slider's range belong to the tool and are remembered as always.
    if (this._isLayerEditSession() && !SHADOW_TOOL_SETTING_KEYS.has(key)) return;
    this._persistPlacementSetting(key, value);
  }

  _readShadowOffsetMax() {
    try {
      const raw = game?.settings?.get?.('fa-nexus', 'assetDropShadowOffsetMax');
      return clampShadowOffsetMax(raw);
    } catch (_) {
      return DEFAULT_SHADOW_OFFSET_MAX;
    }
  }

  _getShadowOffsetMax() {
    return clampShadowOffsetMax(this._dropShadowOffsetMax);
  }

  _coerceShadowNumeric(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      if (Number.isFinite(fallback)) return Math.min(max, Math.max(min, fallback));
      return Math.max(min, Math.min(max, min));
    }
    return Math.min(max, Math.max(min, numeric));
  }

  _currentShadowSnapshot() {
    return {
      alpha: Number(this._dropShadowAlpha || 0),
      dilation: Number(this._dropShadowDilation || 0),
      blur: Number(this._dropShadowBlur || 0),
      offsetDistance: Number(this._dropShadowOffsetDistance || 0),
      offsetAngle: this._normalizeShadowAngle(this._dropShadowOffsetAngle || 0)
    };
  }

  _normalizeShadowSnapshot(snapshot) {
    return normalizeShadowSnapshot(snapshot, { maxOffsetDistance: this._getShadowOffsetMax() });
  }

  _readShadowSettingsCollapsed() {
    try { return !!game.settings.get('fa-nexus', 'assetDropShadowCollapsed'); }
    catch (_) { return false; }
  }

  _persistShadowCollapsed(collapsed) {
    this._persistShadowSetting('assetDropShadowCollapsed', !!collapsed);
  }

  _loadShadowPresets() {
    const fallback = Array.from({ length: SHADOW_PRESET_COUNT }, () => null);
    try {
      const raw = game.settings.get('fa-nexus', 'assetDropShadowPresets');
      const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : Array.isArray(raw) ? raw : [];
      const list = Array.from({ length: SHADOW_PRESET_COUNT }, (_, index) => this._normalizeShadowSnapshot(parsed?.[index]));
      return list;
    } catch (_) {
      return fallback;
    }
  }

  _persistShadowPresets() {
    try {
      const payload = JSON.stringify((this._shadowPresets || []).map((snap) => (snap ? {
        alpha: snap.alpha,
        dilation: snap.dilation,
        blur: snap.blur,
        offsetDistance: snap.offsetDistance,
        offsetAngle: snap.offsetAngle
      } : null)));
      this._persistShadowSetting('assetDropShadowPresets', payload);
    } catch (error) {
      this._logPlacementSettingFailure('persist', 'assetDropShadowPresets', error);
    }
  }

  _persistCurrentShadowSettings() {
    this._persistShadowSetting('assetDropShadowAlpha', this._dropShadowAlpha);
    this._persistShadowSetting('assetDropShadowDilation', this._dropShadowDilation);
    this._persistShadowSetting('assetDropShadowBlur', this._dropShadowBlur);
    this._persistShadowSetting('assetDropShadowOffsetMax', this._getShadowOffsetMax());
    this._persistShadowSetting('assetDropShadowOffsetDistance', this._dropShadowOffsetDistance);
    this._persistShadowSetting('assetDropShadowOffsetAngle', this._dropShadowOffsetAngle);
  }

  _normalizeShadowAngle(value) {
    return normalizeShadowAngle(value);
  }

  _clearEditingCommitTimer() {
    return this._editShadowCommitWorkflow.clearTimer();
  }

  _scheduleEditingCommit(immediate = false) {
    return this._editShadowCommitWorkflow.schedule(immediate);
  }

  _commitEditingShadowChanges() {
    return this._editShadowCommitWorkflow.commit();
  }

  _computeShadowOffsetVector(distance = this._dropShadowOffsetDistance, angle = this._dropShadowOffsetAngle) {
    const dist = Math.min(this._getShadowOffsetMax(), Math.max(0, Number(distance) || 0));
    const theta = this._normalizeShadowAngle(angle) * (Math.PI / 180);
    const x = Math.cos(theta) * dist;
    const y = Math.sin(theta) * dist;
    return { x, y };
  }

  _getCanvasElement() {
    try { return this._interactionController.getCanvasElement?.() || null; }
    catch (_) { return null; }
  }

  _activateTilesLayer() {
    try { canvas?.tiles?.activate?.(); }
    catch (_) { /* no-op */ }
  }

  _applyScatterPreviewOrdering(group) {
    return this._scatterPreviewGroupRuntime.applyOrdering(group);
  }

  _resolvePreviewRenderOrder(elevation = this._previewElevation, sort = this._previewSort) {
    const editingDoc = ((this._isEditingExistingTile || this._replaceOriginalOnPlace) && this._editingTile)
      ? this._editingTile
      : null;
    const placementLevelId = this._resolveActivePlacementLevelId(editingDoc);
    if (editingDoc) {
      return resolveTileRenderOrder(editingDoc, { elevation, sort, placementLevelId });
    }
    return resolveTileRenderOrder({ elevation, sort }, {
      elevation,
      sort,
      placementLevelId
    });
  }

  _syncScatterPreviewOrdering() {
    return this._scatterPreviewGroupRuntime.syncOrdering();
  }

  _syncPreviewOrdering() {
    try {
      if (this._previewContainer) this._applyPlacementPreviewOrdering();
      this._applyScatterHoverOrdering();
      this._syncScatterPreviewOrdering();
      this._notifyPreviewLayerChange('asset-placement');
    } catch (error) {
      Logger.warn('Placement.previewOrdering.failed', {
        error: String(error?.message || error),
        elevation: this._previewElevation,
        sort: this._previewSort,
        hasPreview: !!this._previewContainer,
        scatterMode: this._scatterMode
      });
    }
  }

  _clearElevationAnnounceTimer() {
    if (this._elevationAnnounceTimer) {
      clearTimeout(this._elevationAnnounceTimer);
      this._elevationAnnounceTimer = null;
    }
    this._pendingElevationAnnouncePoint = null;
  }

  _announcePreviewElevation(worldPoint, options = {}) {
    try {
      const now = Date.now();
      const delta = now - this._lastElevationAnnounce;
      const throttleMs = 75;
      const immediate = options?.immediate === true;
      this._pendingElevationAnnouncePoint = worldPoint ?? this._pendingElevationAnnouncePoint ?? null;

      if (immediate || delta >= throttleMs) {
        this._flushPreviewElevationAnnounce();
        return;
      }

      const remaining = Math.max(0, throttleMs - delta);
      if (this._elevationAnnounceTimer) clearTimeout(this._elevationAnnounceTimer);
      this._elevationAnnounceTimer = setTimeout(() => {
        this._elevationAnnounceTimer = null;
        this._flushPreviewElevationAnnounce();
      }, remaining);
    } catch (_) {}
  }

  _flushPreviewElevationAnnounce() {
    try {
      this._lastElevationAnnounce = Date.now();
      const worldPoint = this._pendingElevationAnnouncePoint ?? null;
      this._pendingElevationAnnouncePoint = null;
      const text = `Elevation: ${formatElevation(this._previewElevation)}`;
      if (worldPoint && canvas?.interface?.createScrollingText && globalThis.CONST?.TEXT_ANCHOR_POINTS) {
        canvas.interface.createScrollingText(worldPoint, text, {
          anchor: CONST.TEXT_ANCHOR_POINTS.CENTER,
          direction: CONST.TEXT_ANCHOR_POINTS.TOP,
          distance: 60,
          duration: 900,
          fade: 0.8,
          stroke: 0x111111,
          strokeThickness: 4,
          fill: 0xffffff,
          fontSize: 26
        });
      }
    } catch (_) {}
  }

  _encodeAssetPath(p) {
    if (!p) return p;
    if (/^https?:/i.test(p)) return p;
    try {
      return encodeURI(decodeURI(String(p)));
    } catch (_) {
      try { return encodeURI(String(p)); } catch (err) { return p; }
    }
  }

  _addPlacementFeedback() { 
    try { 
      this.app?.element?.classList?.add?.('placement-active'); 
      // Always show sticky mode since it's now the default
      this.app?.element?.classList?.add?.('placement-sticky');
      this._applyPlacementFreezeClass();
    } catch (_) {} 
    const baseMessage = 'Click to place. Tap S to toggle grid snap and hold S while scrolling to change subgrid density. Ctrl/Cmd+Wheel rotates (Shift=1°). Alt+Wheel or Alt+[ / ] / Alt+Up / Down adjust elevation (0.001; Shift 0.1). Ctrl/Cmd+Alt+Wheel moves the preview one layer. Shift+Wheel scales preview. Right-click or ESC to cancel.';
    const scatterMessage = this._scatterMode === ASSET_SCATTER_MODE_BRUSH
      ? 'Scatter mode: drag to paint stamps. Ctrl/Cmd+S commits the current scatter session. Press E to toggle scatter erase and hold Alt to invert it temporarily. '
      : '';
    const message = `${scatterMessage}${baseMessage}`;
    announceChange('asset-placement', message, { throttleMs: 800 });
  }
  _removePlacementFeedback() { 
    try { 
      this.app?.element?.classList?.remove?.('placement-active'); 
      this.app?.element?.classList?.remove?.('placement-sticky'); 
      this.app?.element?.classList?.remove?.('placement-frozen');
    } catch (_) {} 
  }

  /** Keep preview sized to current canvas zoom */
  _applyZoomToPreview(zoomLevel) {
    return this._previewRuntime.applyZoomToPreview(zoomLevel);
  }

  _startZoomWatcher() {
    return this._previewRuntime.startZoomWatcher();
  }

  _stopZoomWatcher() {
    return this._previewRuntime.stopZoomWatcher();
  }

  _pickRandomAsset() {
    try {
      if (!Array.isArray(this.randomAssets) || !this.randomAssets.length) return null;
      const queue = this._randomPrefetch;
      let picked = queue?.next?.(this.currentAsset) || null;
      if (picked) {
        try { Logger.info('Placement.random.pick', { source: 'queue', filename: picked?.filename || picked?.path }); } catch (_) {}
        return picked;
      }
      const idx = Math.floor(Math.random() * this.randomAssets.length);
      picked = this.randomAssets[idx];
      try { Logger.info('Placement.random.pick', { source: 'fallback', index: idx, filename: picked?.filename || picked?.path }); } catch (_) {}
      return picked;
    } catch (_) { return null; }
  }

  _updateRandomPrefetchCount() {
    const hasRandomPool = !!(this.isRandomMode && Array.isArray(this.randomAssets) && this.randomAssets.length);
    if (!hasRandomPool) {
      try { this._randomPrefetch?.setPrefetchCount?.(0); } catch (_) {}
      return;
    }
    const count = this._scatterMode === ASSET_SCATTER_MODE_BRUSH
      ? Math.max(SCATTER_PREFETCH_MIN, this.randomAssets.length)
      : PREFETCH_COUNT_DEFAULT;
    try { this._randomPrefetch?.setPrefetchCount?.(count); } catch (_) {}
  }

  async _switchToNextRandomAsset(initial = false) {
    return this._previewRuntime.switchToNextRandomAsset(initial);
  }

  _updateGridCardDownloaded(filePath, localPath) {
    try {
      if (!filePath || !this.app?.element) return;
      const grid = this.app.element.querySelector('#fa-nexus-grid');
      if (!grid) return;
      const raw = String(filePath || '');
      const id = raw.replace(/\.[^/.]+$/, '');
      const filename = raw.split('/').pop() || '';
      const selectors = [
        `.fa-nexus-card[data-content-path="${CSS.escape(raw)}"]`,
        `.fa-nexus-card[data-content-id="${CSS.escape(id)}"]`,
        filename ? `.fa-nexus-card[data-name="${CSS.escape(filename)}"]` : ''
      ].filter(Boolean);
      let card = null;
      for (const selector of selectors) {
        card = grid.querySelector(selector);
        if (card) break;
      }
      if (!card) return;
      try { if (localPath) card.setAttribute('data-url', localPath); } catch (_) {}
      // Only mark as cached if actually downloaded (not using direct CDN URL)
      const isDirectUrl = localPath && /^https?:\/\/r2-public\.forgotten-adventures\.net\//i.test(localPath);
      if (!isDirectUrl) {
        try { card.setAttribute('data-cached', 'true'); } catch (_) {}
        const statusIcon = card.querySelector('.fa-nexus-status-icon');
        if (statusIcon) {
          statusIcon.classList.remove('cloud-plus', 'cloud', 'premium');
          statusIcon.classList.add('cloud','cached');
          statusIcon.title = 'Downloaded';
          statusIcon.innerHTML = '<i class="fas fa-cloud-check"></i>';
        }
      }
    } catch (_) {}
  }

  _assetKey(asset) {
    return String(asset?.id || asset?.file_path || asset?.path || asset?.filename || '').toLowerCase();
  }
}
