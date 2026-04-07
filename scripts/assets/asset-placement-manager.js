import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { createCanvasGestureSession } from '../canvas/canvas-gesture-session.js';
import { getCanvasInteractionController, announceChange } from '../canvas/canvas-interaction-controller.js';
import { getAssetShadowManager } from './asset-shadow-manager.js';
import { readShadowQualityConfig } from './shadow-quality.js';
import { getTileRenderElevation } from '../canvas/elevation-band-utils.js';
import { toolOptionsController } from '../core/tool-options-controller.js';
import { PlacementOverlay, createPlacementSpinner } from '../core/placement/placement-overlay.js';
import { PlacementPrefetchQueue } from '../core/placement/placement-prefetch-queue.js';
import { getGridSnapStep } from '../core/grid-snap-utils.js';
import { getZoomAtCursorView } from '../canvas/canvas-pointer-utils.js';
import { getSharedTexture } from '../textures/texture-render.js';
import {
  applyHsbcToDisplayObject,
  buildHsbcToolOptionsControls,
  buildHsbcToolOptionsHandlers,
  buildHsbcToolOptionsState,
  cloneHsbc,
  createNeutralHsbc,
  normalizeHsbc,
  readDocumentHsbc,
  serializeHsbc
} from '../core/hsbc.js';
import {
  createNormalizedToolOptionsDescriptor,
  TOOL_OPTIONS_RENDERER_MODE
} from '../core/tool-options-descriptor.js';
import {
  SHORTCUT_ACTION,
  createShortcut,
  isCommitShortcut,
  isHelpShortcut,
  isGridSnapShortcut,
  isPolarityShortcut,
  resolveEffectivePolarity
} from '../core/editor-shortcuts.js';
import './asset-scatter-tiles.js';

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

const ELEVATION_STEP_DEFAULT = 0.01;
const ELEVATION_STEP_FINE = 0.001;
const ELEVATION_STEP_COARSE = 0.1;
const ELEVATION_INPUT_LIMIT = 100000;

const MIN_SCALE = 0.1;
const MAX_SCALE = 2.5;
const DEFAULT_SCALE = 1;
const DEFAULT_ROTATION = 0;
const SCALE_RANDOM_DELTA = 20;
const DEFAULT_SCALE_RANDOM_MIN = 80;
const DEFAULT_SCALE_RANDOM_MAX = 120;
const DEFAULT_ROTATION_RANDOM_MIN = 0;
const DEFAULT_ROTATION_RANDOM_MAX = 359;
const ASSET_SCATTER_MODE_SINGLE = 'single';
const ASSET_SCATTER_MODE_BRUSH = 'scatter';
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
const SCATTER_HOVER_PREVIEW_PRIMARY_ALPHA = 0.85;
const PREFETCH_COUNT_DEFAULT = 4;
const SCATTER_PREFETCH_MIN = 5;
const SCATTER_HISTORY_LIMIT = 30;
const DEFAULT_SHADOW_OFFSET_MAX = 40;
const MIN_SHADOW_OFFSET_MAX = 1;
const SHADOW_OFFSET_MAX_CEILING = 512;
const MAX_SHADOW_DILATION = 20;
const MAX_SHADOW_BLUR = 12;
const SHADOW_PRESET_COUNT = 5;
const DEFAULT_SHADOW_SETTINGS = Object.freeze({
  alpha: 0.65,
  dilation: 1.6,
  blur: 1.8,
  offsetDistance: 0,
  offsetAngle: 135
});
const FREEZE_SHORTCUT_BLOCKED_INPUTS = new Set(['text', 'search', 'email', 'url', 'password', 'tel']);
const PREVIEW_LAYER_HOOK = 'fa-nexus-preview-layers-changed';
const TOOL_OPTIONS_ACTIVITY_EVENT = 'fa-nexus:tool-options-activity';
const SCATTER_TRANSFORM_INIT_SETTING = 'assetScatterPlacementTransformsInitialized';
const SCATTER_PLACEMENT_TRANSFORM_SETTINGS = Object.freeze({
  assetPlacementScale: 'assetScatterPlacementScale',
  assetPlacementScaleRandomEnabled: 'assetScatterPlacementScaleRandomEnabled',
  assetPlacementScaleRandomMin: 'assetScatterPlacementScaleRandomMin',
  assetPlacementScaleRandomMax: 'assetScatterPlacementScaleRandomMax',
  assetPlacementRotation: 'assetScatterPlacementRotation',
  assetPlacementRotationRandomEnabled: 'assetScatterPlacementRotationRandomEnabled',
  assetPlacementRotationRandomMin: 'assetScatterPlacementRotationRandomMin',
  assetPlacementRotationRandomMax: 'assetScatterPlacementRotationRandomMax',
  assetPlacementFlipHorizontal: 'assetScatterPlacementFlipHorizontal',
  assetPlacementFlipVertical: 'assetScatterPlacementFlipVertical',
  assetPlacementFlipRandomHorizontal: 'assetScatterPlacementFlipRandomHorizontal',
  assetPlacementFlipRandomVertical: 'assetScatterPlacementFlipRandomVertical'
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
    this._randomPrefetch = new PlacementPrefetchQueue({
      prefetchCount: PREFETCH_COUNT_DEFAULT,
      getItemKey: (asset) => this._assetKey(asset),
      needsPrefetch: (asset) => this._assetRequiresDownload(asset),
      prefetch: (asset) => this._ensureAssetLocal(asset),
      logger: Logger,
      loggerTag: 'AssetPlacement.prefetch'
    });
    this._interactionController = getCanvasInteractionController();
    this._gestureSession = null;
    this._suppressDragSelect = false;
    this._lastPointer = null;
    this._lastPointerWorld = null;
    this._scatterBrushSize = this._readStoredScatterBrushSize();
    this._scatterDensity = this._readStoredScatterDensity();
    this._scatterSprayDeviation = this._readStoredScatterSprayDeviation();
    this._scatterSpacing = this._readStoredScatterSpacing();
    this._scatterPainting = false;
    this._scatterLastPointerWorld = null;
    this._scatterStrokeDistance = 0;
    this._scatterQueue = [];
    this._scatterQueueRunning = false;
    this._scatterQueuePromise = null;
    this._scatterOverlay = null;
    this._scatterGfx = null;
    this._scatterGhostContainer = null;
    this._scatterGhostSprites = [];
    this._scatterMergeEnabled = this._readStoredScatterMergeEnabled();
    this._scatterMergeBeforeEdit = null;
    this._scatterEraseEnabled = false;
    this._scatterPolarityInvertHeld = false;
    this._scatterEditing = false;
    this._scatterEditTile = null;
    this._scatterPreviewContainer = null;
    this._scatterPreviewGroups = new Map();
    this._scatterPreviewActiveKey = null;
    this._scatterPreviewInstances = [];
    this._scatterPreviewSprites = new Map();
    this._scatterPreviewTextures = new Map();
    this._scatterPreviewShadowFrame = null;
    this._scatterPreviewShadowForce = false;
    this._scatterPreviewShadowDirty = new Set();
    this._scatterPreviewShadowSettings = new Map();
    this._scatterPreviewShadowTextureListeners = new WeakMap();
    this._scatterSessionActive = false;
    this._scatterSessionGroups = new Map();
    this._scatterShadowBatchActive = false;
    this._scatterShadowBatchManager = null;
    this._scatterPreviewShadowBatchActive = false;
    this._scatterPreviewShadowBatchForce = false;
    this._scatterPreviewShadowBatchNeedsAll = false;
    this._scatterPreviewShadowBatchDirty = new Set();
    this._scatterHistory = [];
    this._scatterHistoryIndex = -1;
    this._scatterHistoryDirty = false;
    this._scatterCancelConfirmPromise = null;
    this._scatterCancelConfirmDialog = null;
    this._toolOptionsPreviewActive = false;
    this._toolOptionsPreviewRestoreWorld = null;
    this._boundToolOptionsActivity = (event) => this._handleToolOptionsActivity(event);
    this._previewFrozen = false;
    this._frozenPreviewWorld = null;
    this._frozenPointerScreen = null;
    // Track canvas zoom to keep preview sized accurately
    this._zoomWatcherId = null;
    this._lastZoom = 1;
    // Per-placement scale multiplier (Shift+wheel)
    this.currentScale = this._readPlacementScale();
    // Elevation for the active placement session (Alt+wheel)
    this._previewElevation = 0;
    this._previewSort = 0;
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
    this._shadowPresets = this._loadShadowPresets();
    this._shadowSettingsCollapsed = this._readShadowSettingsCollapsed();
    this._shadowElevationContext = { elevation: 0, tileCount: 0, hasTiles: false, source: 'default' };
    this._hsbc = createNeutralHsbc();
    this._shadowPreviewTextureListener = null;
    this._shadowOffsetPreview = null;
    this._shadowPreviewFrame = null;
    this._shadowPreviewPendingSignature = null;
    this._shadowPreviewRendering = false;
    this._shadowPreviewSequence = 0;
    this._shadowPreviewRequestedId = 0;
    this._shadowPreviewForce = false;
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
    this._editingTileShadowSuspended = false;
    this._replaceOriginalOnPlace = false;
    this._gridSnapShortcutHeld = false;
    this._gridSnapShortcutPendingToggle = false;
    this._installToolOptionsActivityListener();
    this._installDropShadowSettingsHook();
    this._syncToolOptionsState();
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
      void this._commitScatterEditChanges();
      return true;
    }
    const groups = this._collectScatterCommitGroups();
    if (!groups.length) return false;
    void this._commitScatterGroups(groups);
    return true;
  }

  _hasScatterSessionChanges() {
    if (!this._scatterMergeEnabled) return false;
    if (this._scatterEditing) return true;
    const instances = Array.isArray(this._scatterPreviewInstances) ? this._scatterPreviewInstances.length : 0;
    const sessions = this._scatterSessionGroups?.size || 0;
    return instances > 0 || sessions > 0;
  }

  _forceScatterCancelDialog() {
    const dialog = this._scatterCancelConfirmDialog;
    if (!dialog) return false;
    try {
      const button = dialog.element?.querySelector?.('button[data-action="yes"]');
      if (button) {
        button.click();
        return true;
      }
    } catch (_) {}
    try { dialog.close?.({ submitted: true }); } catch (_) {}
    return true;
  }

  async _confirmScatterCancel({ force = false } = {}) {
    if (!this._hasScatterSessionChanges()) return true;
    if (this._scatterCancelConfirmPromise) {
      if (force) this._forceScatterCancelDialog();
      return this._scatterCancelConfirmPromise;
    }
    const message = 'Cancel the current scatter session? This cannot be undone.';
    try {
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (DialogV2?.wait) {
        const promise = DialogV2.wait({
          window: { title: 'Cancel Scatter Session' },
          modal: true,
          content: `<p>${message}</p>`,
          buttons: [
            { action: 'yes', label: 'Cancel', icon: 'fas fa-trash', default: false, callback: () => true },
            { action: 'no', label: 'Keep Editing', default: true, callback: () => false }
          ],
          close: () => false,
          render: (_event, dialog) => {
            this._scatterCancelConfirmDialog = dialog;
          }
        });
        this._scatterCancelConfirmPromise = Promise.resolve(promise)
          .then((result) => {
            this._scatterCancelConfirmPromise = null;
            this._scatterCancelConfirmDialog = null;
            return !!result;
          })
          .catch(() => {
            this._scatterCancelConfirmPromise = null;
            this._scatterCancelConfirmDialog = null;
            return false;
          });
        if (force) this._forceScatterCancelDialog();
        return this._scatterCancelConfirmPromise;
      }
    } catch (_) {}
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(message);
    }
    return true;
  }

  async _requestScatterCancel({ source = 'manual' } = {}) {
    if (!this._hasScatterSessionChanges()) {
      this.cancelPlacement('scatter-discard');
      return true;
    }
    const force = source === 'escape' && !!this._scatterCancelConfirmPromise;
    const confirmed = await this._confirmScatterCancel({ force });
    if (!confirmed) return false;
    this.cancelPlacement('scatter-discard');
    return true;
  }

  async _handleEditorAction(actionId) {
    const id = String(actionId || '');
    switch (id) {
      case 'scatter-undo':
        return this._undoScatterHistory();
      case 'scatter-redo':
        return this._redoScatterHistory();
      case 'scatter-commit':
        if (this._scatterEditing) {
          return this._commitScatterEditChanges().finally(() => {
            this.cancelPlacement('scatter-commit');
          });
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
    const selectedElevation = this._getHighestControlledTileElevation();
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
    this.isRandomMode = false;
    this.randomAssets = [];
    this._pendingEditState = null;
    this._scatterMode = this._readStoredScatterMode();
    this._restorePlacementTransformState({ mode: this._scatterMode, regenerateOffsets: true });
    this._setScatterMode(this._scatterMode);
    this._updateRandomPrefetchCount();
    this._activateToolOptions();
    try { Logger.info('Placement.start', { sticky: !!stickyMode, kind: 'single', asset: assetData?.filename || assetData?.path }); } catch (_) {}
    const initialElevation = Number.isFinite(selectedElevation)
      ? selectedElevation
      : (Number.isFinite(this._lastElevationUsed) ? this._lastElevationUsed : 0);
    this._previewElevation = initialElevation;
    this._previewSort = this._interactionController.computeNextSortAtElevation?.(initialElevation) ?? 0;
    this._lastElevationUsed = this._previewElevation;
    this._lastElevationAnnounce = 0;
    this._clearElevationAnnounceTimer();
    this._refreshShadowElevationContext({ adopt: true });
    this._activateTilesLayer();
    this._startInteractionSession();
    this._addPlacementFeedback();
    Promise.resolve(this._prepareCurrentAssetPreview({ initial: true })).catch((error) => {
      Logger.warn('Placement.prepare.failed', String(error?.message || error));
    });
  }

  async editTile(tileDocument, options = {}) {
    try {
      if (!tileDocument) throw new Error('Tile document required');
      const doc = tileDocument.document ?? tileDocument;
      if (!doc) throw new Error('Tile document unavailable');
      const scatterPayload = this._readScatterTileData(doc);
      if (scatterPayload) {
        await this._editScatterTile(doc, scatterPayload, options);
        return;
      }
      if (!doc.texture || !doc.texture.src) throw new Error('Tile is missing a texture source');

      const assetData = this._buildAssetDataFromTile(doc);
      if (!assetData) throw new Error('Unable to derive asset data from tile');

      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this.cancelPlacement('replace');

      this.currentAsset = assetData;
      this.isPlacementActive = true;
      this.isStickyMode = false;
      this.isRandomMode = false;
      this.randomAssets = [];
      this._editingTile = doc;
      this._replaceOriginalOnPlace = true;
      this._isEditingExistingTile = true;
      this._scatterMode = ASSET_SCATTER_MODE_SINGLE;
      this._stopScatterStroke();
      this._clearScatterOverlay();
      this._pendingEditState = null;

      const tileObj = doc?.object || null;
      this._editingTileObject = tileObj || null;
      this._editingTileVisibilitySnapshot = tileObj ? this._captureTileVisibility(tileObj) : null;
      if (tileObj) {
        this._releaseTileSelection(tileObj);
        this._hideTileForEditing(tileObj);
      }
      this._editingTileShadowSuspended = this._suspendEditingTileShadow(doc);

      const centerWorld = (() => {
        if (options.pointerWorld && Number.isFinite(options.pointerWorld.x) && Number.isFinite(options.pointerWorld.y)) {
          return { x: Number(options.pointerWorld.x), y: Number(options.pointerWorld.y) };
        }
        const px = Number(doc.x || 0);
        const py = Number(doc.y || 0);
        const w = Number(doc.width || 0);
        const h = Number(doc.height || 0);
        return { x: px + w / 2, y: py + h / 2 };
      })();

      const pointerOption = (() => {
        if (options.pointer && Number.isFinite(options.pointer.x) && Number.isFinite(options.pointer.y)) {
          return { x: Number(options.pointer.x), y: Number(options.pointer.y) };
        }
        if (canvas?.stage && centerWorld) {
          try {
            const stagePoint = canvas.stage.worldTransform.apply(new PIXI.Point(centerWorld.x, centerWorld.y));
            const canvasEl = canvas.app?.view || document.querySelector('canvas#board');
            if (canvasEl) {
              const rect = canvasEl.getBoundingClientRect();
              return { x: rect.left + stagePoint.x, y: rect.top + stagePoint.y };
            }
          } catch (_) {}
        }
        return null;
      })();

      this._ensurePointerSnapshot({
        pointer: pointerOption || options.pointer || null,
        pointerWorld: options.pointerWorld || centerWorld
      });

      const initialElevation = Number.isFinite(doc.elevation) ? Number(doc.elevation) : (Number.isFinite(this._lastElevationUsed) ? this._lastElevationUsed : 0);
      this._previewElevation = initialElevation;
      this._lastElevationUsed = this._previewElevation;
      this._previewSort = Number(doc.sort ?? 0) || 0;
      this._lastElevationAnnounce = 0;
      this._clearElevationAnnounceTimer();

      this._activateToolOptions();
      this._activateTilesLayer();
      this._removePreviewElement();
      this._createPreviewElement();

      if (this._previewContainer) {
        this._previewContainer.x = centerWorld.x;
        this._previewContainer.y = centerWorld.y;
      }
      this._lastPointer = null;
      this._lastPointerWorld = { ...centerWorld };

      this._applyTileStateToPlacement(doc, { force: true });
      this._isEditingExistingTile = false;
      this._refreshShadowElevationContext({ adopt: false, sync: true });
      this._syncToolOptionsState({ suppressRender: false });
      this._setPlacementFreeze(true, { announce: false });

      this._startInteractionSession();
      return true;
    } catch (error) {
      Logger.warn('Placement.editTile.failed', String(error?.message || error));
      ui.notifications?.error?.(`Unable to edit asset: ${error?.message || error}`);
      this._restoreEditingTileVisibility();
      this._resumeEditingTileShadow();
      this._editingTileObject = null;
      this._editingTileVisibilitySnapshot = null;
      this._editingTile = null;
      this._isEditingExistingTile = false;
      this._pendingEditState = null;
      this._replaceOriginalOnPlace = false;
      this._editingTileShadowSuspended = false;
      return false;
    }
  }

  startPlacementRandom(assetList, stickyMode = true, options = {}) {
    try {
      if (!Array.isArray(assetList) || !assetList.length) { this.startPlacement(assetList?.[0], stickyMode, options); return; }
      const selectedElevation = this._getHighestControlledTileElevation();
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
      this.randomAssets = assetList.slice();
      this.currentAsset = null;
      try { this._randomPrefetch?.setPool?.(this.randomAssets); } catch (_) {}
      this._scatterMode = this._readStoredScatterMode();
      this._restorePlacementTransformState({ mode: this._scatterMode, regenerateOffsets: true });
      this._setScatterMode(this._scatterMode);
      this._activateToolOptions();
      const initialElevation = Number.isFinite(selectedElevation)
        ? selectedElevation
        : (Number.isFinite(this._lastElevationUsed) ? this._lastElevationUsed : 0);
      this._previewElevation = initialElevation;
      this._previewSort = this._interactionController.computeNextSortAtElevation?.(initialElevation) ?? 0;
      this._lastElevationUsed = this._previewElevation;
      this._lastElevationAnnounce = 0;
      this._clearElevationAnnounceTimer();
      Logger.info('Placement.startRandom', { sticky: !!stickyMode, count: this.randomAssets.length });
      this._activateTilesLayer();
      this._refreshShadowElevationContext({ adopt: true });
      this._startInteractionSession();
      this._addPlacementFeedback();
      this._updateRandomPrefetchCount();
      try { this._randomPrefetch?.prime?.(); } catch (_) {}
      this._switchToNextRandomAsset(true);
    } catch (_) {
      this.startPlacement(assetList?.[0], stickyMode, options);
    }
  }

  async updatePlacementAssets(assetList, options = {}) {
    const list = Array.isArray(assetList)
      ? assetList.filter(Boolean)
      : (assetList ? [assetList] : []);
    if (!list.length) return false;
    if (!this.isPlacementActive || this._isEditingExistingTile || this._scatterEditing) return false;
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
    if (!this.isPlacementActive) {
      this._hsbc = createNeutralHsbc();
      this._setPlacementFreeze(false, { announce: false, sync: false });
      return;
    }
    this._autoCommitScatterSession(reason);
    this.isPlacementActive = false;
    this.isStickyMode = false;
    this.currentAsset = null;
    this._restoreEditingTileVisibility();
    this._resumeEditingTileShadow();
    this._editingTileObject = null;
    this._editingTileVisibilitySnapshot = null;
    this._editingTileShadowSuspended = false;
    this._replaceOriginalOnPlace = false;
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    if (this._editingCommitTimer) {
      try { clearTimeout(this._editingCommitTimer); }
      catch (_) {}
      this._editingCommitTimer = null;
    }
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
    this._resetScatterHistory();
    this._scatterQueue = [];
    this._scatterQueueRunning = false;
    this._scatterQueuePromise = null;
    this._clearScatterOverlay();
    this._scatterEditing = false;
    this._scatterEditTile = null;
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
    this._dropShadowPreference = this._readDropShadowPreference();
    this._notifyDropShadowChanged();
  }

  _getAssetBasePxPerSquare() { return 200; }

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
    } catch (_) {
      return null;
    }
  }

  /**
   * Apply grid snapping to world coordinates for asset placement
   * Uses half-grid increments for more precise positioning (corners, edges, centers)
   * @param {Object} worldCoords - World coordinates {x, y}
   * @returns {Object} Snapped coordinates {x, y}
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
      const snapStep = getGridSnapStep(gridSize, snapSubdivisions);
      if (!snapStep || !Number.isFinite(snapStep)) return worldCoords;
      const snapX = Math.round(worldCoords.x / snapStep) * snapStep;
      const snapY = Math.round(worldCoords.y / snapStep) * snapStep;

      return { x: snapX, y: snapY };
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
    const base = this._normalizeRotation(this.currentRotation);
    if (!this._hasRandomRotationEnabled()) return base;
    const range = this._getRotationRandomRange();
    if (range.max <= range.min) return range.min;
    return range.min + Math.floor(randomFn() * (range.max - range.min + 1));
  }

  _sampleScatterPreviewScale(randomFn = Math.random) {
    const base = this._clampScale(this.currentScale);
    if (!this._hasRandomScaleEnabled()) return base;
    const range = this._getScaleRandomRange();
    const minScale = this._clampScale(range.min / 100);
    const maxScale = this._clampScale(range.max / 100);
    if (maxScale <= minScale) return minScale;
    return minScale + (randomFn() * (maxScale - minScale));
  }

  _sampleScatterPreviewFlipState(randomFn = Math.random) {
    const baseHorizontal = !!this._flipHorizontal;
    const baseVertical = !!this._flipVertical;
    return {
      horizontal: this._flipRandomHorizontalEnabled ? (randomFn() < 0.5 ? !baseHorizontal : baseHorizontal) : baseHorizontal,
      vertical: this._flipRandomVerticalEnabled ? (randomFn() < 0.5 ? !baseVertical : baseVertical) : baseVertical
    };
  }

  _pickScatterPreviewAsset(randomFn = Math.random) {
    if (this.isRandomMode && Array.isArray(this.randomAssets) && this.randomAssets.length) {
      const index = Math.floor(randomFn() * this.randomAssets.length);
      return this.randomAssets[index] || this.currentAsset;
    }
    return this.currentAsset;
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
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return ((num % 360) + 360) % 360;
  }

  _clampScaleRandomPercent(value, fallback = DEFAULT_SCALE_RANDOM_MIN) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(250, Math.max(10, Math.round(numeric)));
  }

  _getDefaultScaleRandomRange(baseScale = this.currentScale) {
    const basePercent = Math.round(this._clampScale(baseScale) * 100);
    const min = this._clampScaleRandomPercent(basePercent - SCALE_RANDOM_DELTA, DEFAULT_SCALE_RANDOM_MIN);
    const max = this._clampScaleRandomPercent(basePercent + SCALE_RANDOM_DELTA, DEFAULT_SCALE_RANDOM_MAX);
    return min <= max ? { min, max } : { min: max, max: min };
  }

  _getScaleRandomRange() {
    const min = this._clampScaleRandomPercent(this._scaleRandomMin, DEFAULT_SCALE_RANDOM_MIN);
    const max = this._clampScaleRandomPercent(this._scaleRandomMax, DEFAULT_SCALE_RANDOM_MAX);
    return min <= max ? { min, max } : { min: max, max: min };
  }

  _sampleScaleRandomValue() {
    const range = this._getScaleRandomRange();
    const percent = range.max <= range.min
      ? range.min
      : (range.min + Math.floor(Math.random() * (range.max - range.min + 1)));
    return this._clampScale(percent / 100);
  }

  _clampRotationRandomValue(value, fallback = DEFAULT_ROTATION_RANDOM_MIN) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(359, Math.max(0, Math.round(numeric)));
  }

  _getRotationRandomRange() {
    const min = this._clampRotationRandomValue(this._rotationRandomMin, DEFAULT_ROTATION_RANDOM_MIN);
    const max = this._clampRotationRandomValue(this._rotationRandomMax, DEFAULT_ROTATION_RANDOM_MAX);
    return min <= max ? { min, max } : { min: max, max: min };
  }

  _sampleRotationRandomValue() {
    const range = this._getRotationRandomRange();
    if (range.max <= range.min) return range.min;
    return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
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
    const num = Number(value);
    if (!Number.isFinite(num)) return MIN_SCALE;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, num));
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

  _applyHsbcToModuleFlags(moduleFlags = {}) {
    const hsbc = this._getPersistedHsbc();
    if (hsbc) moduleFlags.hsbc = hsbc;
    else delete moduleFlags.hsbc;
    return moduleFlags;
  }

  _applyHsbcToTileUpdate(update = {}) {
    update['flags.fa-nexus.hsbc'] = this._getPersistedHsbc() || null;
    return update;
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
    try {
      this._syncToolOptionsState({ suppressRender: false });
      toolOptionsController.activateTool('asset.placement', { label: 'Asset Placement' });
    } catch (_) {}
  }

  _deactivateToolOptions() {
    try { toolOptionsController.deactivateTool('asset.placement'); } catch (_) {}
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
    if (this._previewFrozen && this._frozenPreviewWorld) return coerce(this._frozenPreviewWorld);
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
    const scopedMode = mode === ASSET_SCATTER_MODE_BRUSH ? ASSET_SCATTER_MODE_BRUSH : ASSET_SCATTER_MODE_SINGLE;
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
      'Alt+Wheel, Alt+[ / ], or Alt+Up / Down adjust elevation (default 0.01, Shift 0.1, Ctrl/Cmd 0.001).',
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
        description: 'Adjust elevation by 0.01; add Shift for 0.1 or Ctrl/Cmd for 0.001.'
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
    const addRangeControl = ({
      id,
      label,
      state,
      handlerId,
      inputOnly = false,
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
        min: state.min,
        max: state.max,
        step: state.step,
        value: state.value,
        display: state.display,
        defaultValue: state.defaultValue,
        disabled: !!state.disabled,
        tooltip: typeof state.tooltip === 'string' ? state.tooltip : '',
        hint: typeof state.hint === 'string' ? state.hint : '',
        inputOnly: !!inputOnly || !!state.inputOnly
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
    const addScalarRandomizedControl = ({
      id,
      label,
      ariaLabel = '',
      state,
      variant = 'scale',
      handlerId,
      randomHandlerId = '',
      strengthHandlerId = '',
      randomMinHandlerId = '',
      randomMaxHandlerId = ''
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
        strengthHandlerId,
        randomMinHandlerId,
        randomMaxHandlerId
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
    const canCommit = this._scatterEditing
      ? hasInstances
      : (this._scatterSessionActive && hasInstances);
    const commitLabel = this._scatterEditing ? 'Apply' : 'Commit';
    const commitTooltip = this._scatterEditing
      ? 'Apply the scatter edits to the tile.'
      : 'Commit the scattered stamps to a tile.';
    const discardLabel = 'Cancel';
    const discardTooltip = this._scatterEditing
      ? 'Cancel the scatter edits.'
      : 'Cancel the current scatter session.';
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
        disabled: !hasInstances && !this._scatterSessionActive
      }
    ];
  }

  _togglePlacementFreeze() {
    return this._setPlacementFreeze(!this._previewFrozen);
  }

  _setPlacementFreeze(enabled, { announce = true, sync = true } = {}) {
    const next = !!enabled;
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
        const x = Number(doc.x || 0);
        const y = Number(doc.y || 0);
        const width = Number(doc.width || 0);
        const height = Number(doc.height || 0);
        return { x: x + (width / 2), y: y + (height / 2) };
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
    const horizontal = !!state?.horizontal;
    const vertical = !!state?.vertical;
    if (horizontal && vertical) return 'H & V';
    if (horizontal) return 'H';
    if (vertical) return 'V';
    return 'None';
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
      defaultValue: 0,
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
    const allowed = !!available;
    const active = !!enabled;
    const disabled = !(allowed && active);
    const clamp = (value, min, max) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return min;
      return Math.min(max, Math.max(min, num));
    };
    const alphaPercent = clamp(this._dropShadowAlpha * 100, 0, 100);
    const dilation = clamp(this._dropShadowDilation, 0, MAX_SHADOW_DILATION);
    const blur = clamp(this._dropShadowBlur, 0, MAX_SHADOW_BLUR);
    const offsetDistance = clamp(this._dropShadowOffsetDistance, 0, this._getShadowOffsetMax());
    const offsetAngle = this._normalizeShadowAngle(this._dropShadowOffsetAngle);
    const clampedDistanceChanged = Math.abs(offsetDistance - this._dropShadowOffsetDistance) > 0.0005;
    if (clampedDistanceChanged) this._dropShadowOffsetDistance = offsetDistance;
    const normalizedAngleChanged = Math.abs(offsetAngle - this._dropShadowOffsetAngle) > 0.0005;
    if (normalizedAngleChanged) this._dropShadowOffsetAngle = offsetAngle;
    const distanceDisplay = Math.abs(offsetDistance - Math.round(offsetDistance)) < 0.05
      ? `${Math.round(offsetDistance)}`
      : offsetDistance.toFixed(1);
    const angleDisplay = Math.round(offsetAngle);
    const currentSnapshot = this._currentShadowSnapshot();
    const presetState = this._buildDropShadowPresetState(currentSnapshot);
    const preview = this._shadowOffsetPreview
      ? {
          src: this._shadowOffsetPreview.src,
          width: this._shadowOffsetPreview.width,
          height: this._shadowOffsetPreview.height,
          alt: this._shadowOffsetPreview.alt || 'Asset drop shadow preview'
        }
      : null;
    return {
      available: allowed,
      disabled,
      collapsed: !!this._shadowSettingsCollapsed,
      activePreset: presetState.matchedIndex,
      presets: presetState.list,
      alpha: {
        label: 'Opacity',
        value: Math.round(alphaPercent),
        min: 0,
        max: 100,
        step: 1,
        display: `${Math.round(alphaPercent)}%`,
        hint: 'Transparency of the rendered shadow.',
        disabled
      },
      dilation: {
        label: 'Spread',
        value: dilation.toFixed(1),
        min: 0,
        max: MAX_SHADOW_DILATION,
        step: 0.1,
        display: `${dilation.toFixed(1)} px`,
        hint: 'Expands the shadow mask before blurring (world pixels).',
        disabled
      },
      blur: {
        label: 'Blur',
        value: blur.toFixed(1),
        min: 0,
        max: MAX_SHADOW_BLUR,
        step: 0.1,
        display: `${blur.toFixed(1)} px`,
        hint: 'Softens the shadow edges using a post-process blur.',
        disabled
      },
      offset: {
        mode: 'polar',
        distance: offsetDistance,
        angle: offsetAngle,
        maxDistance: this._getShadowOffsetMax(),
        maxDistanceMin: MIN_SHADOW_OFFSET_MAX,
        maxDistanceLimit: SHADOW_OFFSET_MAX_CEILING,
        maxDistanceStep: 1,
        maxDistanceHint: 'Upper limit (px) for offset distance on the ring control.',
        offsetMaxHandlerId: 'setDropShadowOffsetMax',
        displayDistance: `${distanceDisplay} px`,
        displayAngle: `${angleDisplay}°`,
        hint: `Drag the handle to shift the shadow (max ${Math.round(this._getShadowOffsetMax())} px). Outwards increases distance; clockwise changes direction.`,
        disabled
      },
      preview,
      context: this._buildDropShadowContextState()
    };
  }

  _buildDropShadowContextState() {
    const elevation = Number(this._previewElevation ?? 0) || 0;
    const ctx = this._shadowElevationContext || { elevation, tileCount: 0, hasTiles: false, source: 'default' };
    const display = formatElevation(elevation);
    const tileCount = Number(ctx.tileCount || 0);
    const hasTiles = !!ctx.hasTiles && tileCount > 0;
    const source = ctx.source || (hasTiles ? 'existing' : 'default');
    const mixedOffsets = !!ctx.mixedOffsets;
    const mixedSpread = !!ctx.mixedDilation;
    let status;
    if (hasTiles) {
      const assetText = tileCount === 1 ? '1 asset' : `${tileCount} assets`;
      if (mixedOffsets || mixedSpread) {
        const mixedDetails = [
          mixedSpread ? 'spread' : null,
          mixedOffsets ? 'offset' : null
        ].filter(Boolean).join(' & ');
        status = `Mixed ${mixedDetails} settings across ${assetText}.`;
      } else {
        status = source === 'existing'
          ? `Matched ${assetText} on this elevation.`
          : `Synced with ${assetText} on this elevation.`;
      }
    } else {
      status = 'No assets on this elevation yet.';
    }
    const note = 'Blur & opacity follow elevation; offset & spread can be per asset.';
    return {
      display,
      status,
      note,
      tileCount,
      hasTiles,
      source
    };
  }

  _buildDropShadowPresetState(currentSnapshot) {
    const presets = Array.isArray(this._shadowPresets) ? this._shadowPresets : [];
    const list = [];
    let matchedIndex = -1;
    for (let i = 0; i < SHADOW_PRESET_COUNT; i += 1) {
      const preset = presets[i] || null;
      const saved = !!preset;
      const active = saved && this._compareShadowSnapshots(currentSnapshot, preset);
      if (active && matchedIndex === -1) matchedIndex = i;
      const indexLabel = String(i + 1);
      const tooltipParts = [];
      if (saved) {
        tooltipParts.push(`Click to apply preset ${indexLabel}.`);
        tooltipParts.push('Shift+Click to overwrite with current settings.');
      } else {
        tooltipParts.push(`Shift+Click to save current settings into slot ${indexLabel}.`);
        tooltipParts.push('Click to apply once saved.');
      }
      list.push({
        index: i,
        label: indexLabel,
        saved,
        active,
        tooltip: tooltipParts.join(' ')
      });
    }
    return { list, matchedIndex };
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
      const cachedSettings = this._scatterPreviewShadowSettings?.get?.(key) || null;
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
    this._scheduleScatterPreviewShadowUpdate({ force: true });
    this._notifyDropShadowChanged();
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    return true;
  }

  _handleDropShadowAlphaChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const clampedPercent = Math.min(100, Math.max(0, numeric));
    const normalized = clampedPercent / 100;
    if (Math.abs(normalized - this._dropShadowAlpha) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowAlpha = normalized;
    this._updatePreviewShadow();
    this._syncScatterPreviewShadowSettingsForActiveElevation({ force: commit });
    if (commit) this._persistShadowSetting('assetDropShadowAlpha', normalized);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowDilationChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const clamped = Math.min(MAX_SHADOW_DILATION, Math.max(0, numeric));
    if (Math.abs(clamped - this._dropShadowDilation) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowDilation = clamped;
    this._updatePreviewShadow();
    this._syncScatterPreviewShadowSettingsForActiveElevation({ force: commit });
    if (commit) this._persistShadowSetting('assetDropShadowDilation', clamped);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowBlurChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const clamped = Math.min(MAX_SHADOW_BLUR, Math.max(0, numeric));
    if (Math.abs(clamped - this._dropShadowBlur) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowBlur = clamped;
    this._updatePreviewShadow({ force: commit });
    this._syncScatterPreviewShadowSettingsForActiveElevation({ force: commit });
    if (commit) this._persistShadowSetting('assetDropShadowBlur', clamped);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowOffsetDistanceChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const clamped = Math.min(this._getShadowOffsetMax(), Math.max(0, numeric));
    if (Math.abs(clamped - this._dropShadowOffsetDistance) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowOffsetDistance = clamped;
    this._updatePreviewShadow();
    this._syncScatterPreviewShadowSettingsForActiveElevation({ force: commit });
    if (commit) this._persistShadowSetting('assetDropShadowOffsetDistance', clamped);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowOffsetAngleChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const normalized = this._normalizeShadowAngle(numeric);
    if (Math.abs(normalized - this._dropShadowOffsetAngle) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowOffsetAngle = normalized;
    this._updatePreviewShadow();
    this._syncScatterPreviewShadowSettingsForActiveElevation({ force: commit });
    if (commit) this._persistShadowSetting('assetDropShadowOffsetAngle', normalized);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
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
    const next = mode === ASSET_SCATTER_MODE_BRUSH ? ASSET_SCATTER_MODE_BRUSH : ASSET_SCATTER_MODE_SINGLE;
    if (this._scatterMode === next) {
      if (
        next === ASSET_SCATTER_MODE_BRUSH
        && this.isPlacementActive
        && !this._isEditingExistingTile
        && !this._scatterEditing
      ) {
        this._ensureScatterOverlay();
        if (this._scatterMergeEnabled) this._ensureScatterPreviewOverlay();
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
    this._previewContainer.visible = this._scatterMode !== ASSET_SCATTER_MODE_BRUSH;
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
    return this._isGlobalDropShadowEnabled() && this.isDropShadowEnabled() && !!this._previewContainer;
  }

  _ensurePreviewShadowContainer() {
    if (!this._previewContainer) return null;
    let shadow = this._previewContainer._shadowContainer || null;
    if (!shadow || shadow.destroyed) {
      shadow = new PIXI.Container();
      shadow.sortableChildren = false;
      shadow.eventMode = 'none';
      shadow.visible = false;
      shadow.name = 'fa-nexus-shadow-preview';
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(0.5, 0.5);
      sprite.visible = false;
      sprite.eventMode = 'none';
      shadow.addChild(sprite);
      shadow._sprite = sprite;
      this._previewContainer.addChildAt(shadow, 0);
      this._previewContainer._shadowContainer = shadow;
      this._previewContainer._shadowSprite = sprite;
      this._previewContainer._shadowRenderTexture = null;
      this._previewContainer._shadowState = null;
    }
    return shadow;
  }

  _buildPreviewDilationOffsets(radius) {
    const offsets = [{ x: 0, y: 0 }];
    const r = Math.max(0, Number(radius || 0));
    if (r < 0.05) return offsets;
    const steps = 16;
    const full = Math.PI * 2;
    for (let i = 0; i < steps; i++) {
      const angle = (full * i) / steps;
      offsets.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    const inner = r * 0.55;
    if (inner >= 0.05) {
      for (let i = 0; i < steps; i++) {
        const angle = (full * i) / steps + (full / (steps * 2));
        offsets.push({ x: Math.cos(angle) * inner, y: Math.sin(angle) * inner });
      }
    }
    return offsets;
  }

  _computeRotatedSpriteBounds(width, height, rotationRadians) {
    const w = Math.max(0, Math.abs(Number(width) || 0));
    const h = Math.max(0, Math.abs(Number(height) || 0));
    if (!w && !h) return { width: 0, height: 0 };
    const theta = Number(rotationRadians) || 0;
    const sin = Math.abs(Math.sin(theta));
    const cos = Math.abs(Math.cos(theta));
    const rotatedWidth = (w * cos) + (h * sin);
    const rotatedHeight = (w * sin) + (h * cos);
    return {
      width: Math.max(0, rotatedWidth),
      height: Math.max(0, rotatedHeight)
    };
  }

  _getSafePreviewRenderTextureLimit(renderer) {
    try {
      const quality = readShadowQualityConfig();
      const gl = renderer?.gl || renderer?.context?.gl || canvas?.app?.renderer?.gl || canvas?.app?.renderer?.context?.gl;
      if (!gl) return Math.max(1024, Math.min(4096, Number(quality?.previewMaxTextureSize || 4096) || 4096));
      const value = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const max = Number(value || 4096) || 4096;
      return Math.max(1024, Math.min(max, Number(quality?.previewMaxTextureSize || 4096) || 4096));
    } catch (_) {
      return 4096;
    }
  }

  _resolveSafePreviewRenderTarget(width, height, { renderer = null, resolution = 1, minSize = 1 } = {}) {
    const requestedWidth = Math.max(minSize, Math.ceil(Number(width) || 0));
    const requestedHeight = Math.max(minSize, Math.ceil(Number(height) || 0));
    const safeResolution = Math.max(0.01, Number(resolution) || 1);
    const maxTextureSize = this._getSafePreviewRenderTextureLimit(renderer);
    const maxLogicalSize = Math.max(minSize, Math.floor(maxTextureSize / safeResolution));
    const scale = Math.min(
      1,
      maxLogicalSize / Math.max(1, requestedWidth),
      maxLogicalSize / Math.max(1, requestedHeight)
    );
    const textureWidth = Math.max(minSize, Math.min(requestedWidth, Math.floor(requestedWidth * scale) || minSize));
    const textureHeight = Math.max(minSize, Math.min(requestedHeight, Math.floor(requestedHeight * scale) || minSize));
    return {
      requestedWidth,
      requestedHeight,
      textureWidth,
      textureHeight,
      drawScaleX: textureWidth / Math.max(1, requestedWidth),
      drawScaleY: textureHeight / Math.max(1, requestedHeight),
      resolution: safeResolution
    };
  }

  _updatePreviewShadow({ force = false } = {}) {
    try {
      const container = this._previewContainer;
      if (!container) return;
      if (!this._isPreviewShadowActive()) {
        if (container._shadowContainer) container._shadowContainer.visible = false;
        this._scheduleShadowOffsetPreviewUpdate({ force });
        return;
      }
      const sprite = container._sprite;
      if (!sprite || !sprite.texture) return;
      const texture = sprite.texture;
      const baseTexture = texture.baseTexture;
      if (baseTexture && !baseTexture.valid) {
        if (!this._shadowPreviewTextureListener && typeof baseTexture.once === 'function') {
          const handler = () => {
            this._shadowPreviewTextureListener = null;
            this._updatePreviewShadow({ force: true });
          };
          this._shadowPreviewTextureListener = handler;
          baseTexture.once('loaded', handler);
          baseTexture.once('update', handler);
        }
        return;
      }

      const renderer = canvas?.app?.renderer;
      if (!renderer) return;

      const worldWidth = Math.abs(Number(sprite.width || 0));
      const worldHeight = Math.abs(Number(sprite.height || 0));
      if (!Number.isFinite(worldWidth) || !Number.isFinite(worldHeight) || worldWidth <= 0 || worldHeight <= 0) return;
      const spriteScaleX = Number(sprite.scale?.x ?? 1) || 1;
      const spriteScaleY = Number(sprite.scale?.y ?? 1) || 1;
      const flipX = spriteScaleX < 0 ? -1 : 1;
      const flipY = spriteScaleY < 0 ? -1 : 1;

      const rotation = Number(sprite.rotation || 0);
      const rotated = this._computeRotatedSpriteBounds(worldWidth, worldHeight, rotation);
      const alpha = Math.min(1, Math.max(0, Number(this._dropShadowAlpha || 0)));
      const dilation = Math.max(0, Number(this._dropShadowDilation || 0));
      const blur = Math.max(0, Number(this._dropShadowBlur || 0));
      const offset = this._computeShadowOffsetVector();
      const zoom = Math.max(0.1, Number(canvas?.stage?.scale?.x || 1));

      const blurMargin = blur * 12;
      const marginX = Math.abs(offset.x) + dilation + blurMargin;
      const marginY = Math.abs(offset.y) + dilation + blurMargin;
      const paddedWidth = Math.max(8, Math.ceil(rotated.width + marginX * 2));
      const paddedHeight = Math.max(8, Math.ceil(rotated.height + marginY * 2));
      const renderTarget = this._resolveSafePreviewRenderTarget(paddedWidth, paddedHeight, {
        renderer,
        resolution: 1,
        minSize: 8
      });
      const centerX = paddedWidth / 2;
      const centerY = paddedHeight / 2;

      const signature = `${baseTexture?.uid || baseTexture?.cacheId || 'tex'}:${worldWidth}:${worldHeight}:${rotation}:${alpha}:${dilation}:${blur}:${offset.x}:${offset.y}:${zoom}:${paddedWidth}:${paddedHeight}:${renderTarget.textureWidth}:${renderTarget.textureHeight}:${flipX}:${flipY}`;
      const previousSignature = container._shadowState?.signature || null;
      if (!force && previousSignature === signature) {
        this._scheduleShadowOffsetPreviewUpdate({ force: false });
        return;
      }

      const shadow = this._ensurePreviewShadowContainer();
      if (!shadow) return;
      shadow.visible = true;
      shadow.alpha = 1;

      const shadowSprite = container._shadowSprite || shadow._sprite;
      if (!shadowSprite) return;

      let renderTexture = container._shadowRenderTexture || null;
      if (!renderTexture || renderTexture.width !== renderTarget.textureWidth || renderTexture.height !== renderTarget.textureHeight) {
        if (renderTexture && !renderTexture.destroyed) {
          try { renderTexture.destroy(true); } catch (_) {}
        }
        renderTexture = PIXI.RenderTexture.create({
          width: renderTarget.textureWidth,
          height: renderTarget.textureHeight,
          resolution: renderTarget.resolution,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        container._shadowRenderTexture = renderTexture;
      }

      const drawContainer = new PIXI.Container();
      if (renderTarget.drawScaleX !== 1 || renderTarget.drawScaleY !== 1) {
        drawContainer.scale.set(renderTarget.drawScaleX, renderTarget.drawScaleY);
      }
      const offsets = this._buildPreviewDilationOffsets(dilation);
      for (const sample of offsets) {
        const clone = new PIXI.Sprite(texture);
        clone.anchor.set(0.5, 0.5);
        clone.width = worldWidth;
        clone.height = worldHeight;
        if (flipX < 0) clone.scale.x *= -1;
        if (flipY < 0) clone.scale.y *= -1;
        clone.rotation = rotation;
        clone.position.set(centerX + offset.x + sample.x, centerY + offset.y + sample.y);
        clone.alpha = 1;
        drawContainer.addChild(clone);
      }

      renderer.render(drawContainer, { renderTexture, clear: true });
      try { drawContainer.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}

      shadowSprite.texture = renderTexture;
      shadowSprite.tint = 0x000000;
      shadowSprite.alpha = alpha;
      shadowSprite.position.set(0, 0);
      shadowSprite.anchor.set(0.5, 0.5);
      shadowSprite.width = paddedWidth;
      shadowSprite.height = paddedHeight;
      shadowSprite.visible = true;

      if (blur > 0) {
        let filter = container._shadowBlurFilter || null;
        if (!filter || filter.destroyed) {
          filter = new PIXI.BlurFilter();
          filter.quality = 4;
          filter.repeatEdgePixels = true;
          container._shadowBlurFilter = filter;
        }
        filter.blur = blur * zoom;
        shadowSprite.filters = [filter];
      } else if (shadowSprite.filters) {
        shadowSprite.filters = null;
      }

      container._shadowState = { signature };
      this._scheduleShadowOffsetPreviewUpdate({ force });
    } catch (_) {}
  }

  _cleanupPreviewShadowResources(container) {
    if (!container) return;
    if (container._shadowRenderTexture && !container._shadowRenderTexture.destroyed) {
      try { container._shadowRenderTexture.destroy(true); } catch (_) {}
    }
    container._shadowRenderTexture = null;
    if (container._shadowBlurFilter && !container._shadowBlurFilter.destroyed) {
      try { container._shadowBlurFilter.destroy(); } catch (_) {}
    }
    container._shadowBlurFilter = null;
    if (container._shadowSprite) {
      try {
        container._shadowSprite.texture = PIXI.Texture.EMPTY;
        container._shadowSprite.visible = false;
        container._shadowSprite.filters = null;
      } catch (_) {}
    }
    if (container._shadowContainer && !container._shadowContainer.destroyed) {
      try { container._shadowContainer.visible = false; } catch (_) {}
    }
    container._shadowState = null;
  }

  _isScatterPreviewShadowActive() {
    return this._isGlobalDropShadowEnabled() && this.isDropShadowEnabled() && !!this._scatterPreviewGroups?.size;
  }

  _snapshotScatterPreviewShadowSettings() {
    return {
      alpha: Math.min(1, Math.max(0, Number(this._dropShadowAlpha || 0))),
      dilation: Math.max(0, Number(this._dropShadowDilation || 0)),
      blur: Math.max(0, Number(this._dropShadowBlur || 0)),
      offsetDistance: Math.min(this._getShadowOffsetMax(), Math.max(0, Number(this._dropShadowOffsetDistance || 0))),
      offsetAngle: this._normalizeShadowAngle(this._dropShadowOffsetAngle ?? 0)
    };
  }

  _syncScatterPreviewShadowSettingsForActiveElevation({ force = false } = {}) {
    try {
      const key = this._getScatterPreviewGroupKey(this._previewElevation);
      const settings = this._snapshotScatterPreviewShadowSettings();
      this._scatterPreviewShadowSettings.set(key, settings);
      const group = this._scatterPreviewGroups.get(key);
      if (group) group.shadow = { ...settings };
      const sessionGroup = this._scatterSessionGroups.get(key);
      if (sessionGroup) sessionGroup.shadowSettings = { ...settings };
      if (group) this._scheduleScatterPreviewShadowUpdate({ force, key: group.key });
    } catch (_) {}
  }

  _ensureScatterPreviewShadowContainer(container) {
    const target = container || this._scatterPreviewContainer;
    if (!target) return null;
    const containerRef = target;
    let shadow = containerRef._shadowContainer || null;
    if (!shadow || shadow.destroyed) {
      shadow = new PIXI.Container();
      shadow.sortableChildren = false;
      shadow.eventMode = 'none';
      shadow.visible = false;
      shadow.name = 'fa-nexus-scatter-shadow-preview';
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(0, 0);
      sprite.visible = false;
      sprite.eventMode = 'none';
      shadow.addChild(sprite);
      shadow._sprite = sprite;
      containerRef.addChildAt(shadow, 0);
      containerRef._shadowContainer = shadow;
      containerRef._shadowSprite = sprite;
      containerRef._shadowRenderTexture = null;
      containerRef._shadowState = null;
    } else if (typeof containerRef.getChildIndex === 'function' && containerRef.getChildIndex(shadow) !== 0) {
      try { containerRef.setChildIndex(shadow, 0); } catch (_) {}
    }
    return shadow;
  }

  _scheduleScatterPreviewShadowUpdate({ force = false, key = null } = {}) {
    try {
      if (typeof window === 'undefined') return;
      if (!this._scatterPreviewGroups?.size) return;
      if (this._scatterPreviewShadowBatchActive) {
        if (force) this._scatterPreviewShadowBatchForce = true;
        if (!key) this._scatterPreviewShadowBatchNeedsAll = true;
        if (key) this._scatterPreviewShadowBatchDirty.add(key);
        return;
      }
      if (force) this._scatterPreviewShadowForce = true;
      if (key) this._scatterPreviewShadowDirty.add(key);
      if (this._scatterPreviewShadowFrame) return;
      this._scatterPreviewShadowFrame = window.requestAnimationFrame(() => {
        this._scatterPreviewShadowFrame = null;
        const shouldForce = this._scatterPreviewShadowForce;
        this._scatterPreviewShadowForce = false;
        const keys = shouldForce
          ? Array.from(this._scatterPreviewGroups.keys())
          : Array.from(this._scatterPreviewShadowDirty);
        this._scatterPreviewShadowDirty.clear();
        if (!keys.length) {
          if (this._scatterPreviewActiveKey) {
            keys.push(this._scatterPreviewActiveKey);
          } else if (this._scatterPreviewGroups?.size) {
            keys.push(...this._scatterPreviewGroups.keys());
          }
        }
        if (!keys.length) return;
        for (const groupKey of keys) {
          const group = this._scatterPreviewGroups.get(groupKey);
          if (!group) continue;
          this._updateScatterPreviewShadowForGroup(group, { force: shouldForce });
        }
      });
    } catch (_) {}
  }

  _registerScatterPreviewShadowTextureListener(baseTexture) {
    try {
      if (!baseTexture || typeof baseTexture.once !== 'function') return;
      if (this._scatterPreviewShadowTextureListeners.has(baseTexture)) return;
      const handler = () => {
        if (this._scatterPreviewShadowTextureListeners.get(baseTexture) === handler) {
          this._scatterPreviewShadowTextureListeners.delete(baseTexture);
        }
        this._scheduleScatterPreviewShadowUpdate({ force: true });
      };
      this._scatterPreviewShadowTextureListeners.set(baseTexture, handler);
      baseTexture.once('loaded', handler);
      baseTexture.once('update', handler);
    } catch (_) {}
  }

  _computeScatterPreviewInstanceBounds(instance) {
    const cx = Number(instance?.x) || 0;
    const cy = Number(instance?.y) || 0;
    const hw = Math.max(1, Number(instance?.w) || 0) / 2;
    const hh = Math.max(1, Number(instance?.h) || 0) / 2;
    const rot = ((Number(instance?.r) || 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const corners = [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh }
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const corner of corners) {
      const x = cx + corner.x * cos - corner.y * sin;
      const y = cy + corner.x * sin + corner.y * cos;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  _computeScatterPreviewBounds(instances) {
    if (!Array.isArray(instances) || !instances.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const instance of instances) {
      if (!instance) continue;
      const bounds = this._computeScatterPreviewInstanceBounds(instance);
      if (!bounds) continue;
      if (bounds.minX < minX) minX = bounds.minX;
      if (bounds.minY < minY) minY = bounds.minY;
      if (bounds.maxX > maxX) maxX = bounds.maxX;
      if (bounds.maxY > maxY) maxY = bounds.maxY;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY)
    };
  }

  _updateScatterPreviewShadowForGroup(group, { force = false } = {}) {
    try {
      const container = group?.container;
      if (!container) return;
      if (!this._isScatterPreviewShadowActive()) {
        if (container._shadowContainer) container._shadowContainer.visible = false;
        return;
      }
      const instances = Array.isArray(group?.instances) ? group.instances : [];
      if (!instances.length) {
        if (container._shadowContainer) container._shadowContainer.visible = false;
        return;
      }
      const renderer = canvas?.app?.renderer;
      if (!renderer) return;

      const bounds = this._computeScatterPreviewBounds(instances);
      if (!bounds) return;

      const shadowSettings = group?.shadow
        || this._scatterPreviewShadowSettings.get(group?.key)
        || this._snapshotScatterPreviewShadowSettings();
      const alpha = Math.min(1, Math.max(0, Number(shadowSettings?.alpha ?? this._dropShadowAlpha ?? 0)));
      const dilation = Math.max(0, Number(shadowSettings?.dilation ?? this._dropShadowDilation ?? 0));
      const blur = Math.max(0, Number(shadowSettings?.blur ?? this._dropShadowBlur ?? 0));
      const offsetDistance = Number(shadowSettings?.offsetDistance ?? this._dropShadowOffsetDistance ?? 0);
      const offsetAngle = shadowSettings?.offsetAngle ?? this._dropShadowOffsetAngle ?? 0;
      const offset = this._computeShadowOffsetVector(offsetDistance, offsetAngle);
      const zoom = Math.max(0.1, Number(canvas?.stage?.scale?.x || 1));

      const blurMargin = blur * 12;
      const marginX = Math.abs(offset.x) + dilation + blurMargin;
      const marginY = Math.abs(offset.y) + dilation + blurMargin;
      const paddedWidth = Math.max(8, Math.ceil(bounds.width + marginX * 2));
      const paddedHeight = Math.max(8, Math.ceil(bounds.height + marginY * 2));
      const renderTarget = this._resolveSafePreviewRenderTarget(paddedWidth, paddedHeight, {
        renderer,
        resolution: 1,
        minSize: 8
      });
      const originX = bounds.minX - marginX;
      const originY = bounds.minY - marginY;

      const signature = (() => {
        try {
          return JSON.stringify({
            a: Number(alpha.toFixed(3)),
            d: Number(dilation.toFixed(3)),
            b: Number(blur.toFixed(3)),
            ox: Number((offset.x || 0).toFixed(3)),
            oy: Number((offset.y || 0).toFixed(3)),
            w: paddedWidth,
            h: paddedHeight,
            tw: renderTarget.textureWidth,
            th: renderTarget.textureHeight,
            i: instances
          });
        } catch (_) {
          return '';
        }
      })();
      const previousSignature = container._shadowState?.signature || null;
      if (!force && previousSignature === signature) return;

      const shadow = this._ensureScatterPreviewShadowContainer(container);
      if (!shadow) return;
      shadow.visible = true;
      shadow.alpha = 1;

      const shadowSprite = container._shadowSprite || shadow._sprite;
      if (!shadowSprite) return;

      let renderTexture = container._shadowRenderTexture || null;
      if (!renderTexture || renderTexture.width !== renderTarget.textureWidth || renderTexture.height !== renderTarget.textureHeight) {
        if (renderTexture && !renderTexture.destroyed) {
          try { renderTexture.destroy(true); } catch (_) {}
        }
        renderTexture = PIXI.RenderTexture.create({
          width: renderTarget.textureWidth,
          height: renderTarget.textureHeight,
          resolution: renderTarget.resolution,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        container._shadowRenderTexture = renderTexture;
      }

      const drawContainer = new PIXI.Container();
      if (renderTarget.drawScaleX !== 1 || renderTarget.drawScaleY !== 1) {
        drawContainer.scale.set(renderTarget.drawScaleX, renderTarget.drawScaleY);
      }
      const offsets = this._buildPreviewDilationOffsets(dilation);
      let drawCount = 0;
      for (const instance of instances) {
        const texture = this._getScatterPreviewTexture(instance?.src);
        if (!texture) continue;
        const baseTexture = texture.baseTexture;
        if (baseTexture && !baseTexture.valid) {
          this._registerScatterPreviewShadowTextureListener(baseTexture);
          continue;
        }
        const baseWidth = Math.max(1, Number(instance?.w) || 0);
        const baseHeight = Math.max(1, Number(instance?.h) || 0);
        const baseX = (Number(instance?.x) || 0) - originX + offset.x;
        const baseY = (Number(instance?.y) || 0) - originY + offset.y;
        const rotation = ((Number(instance?.r) || 0) * Math.PI) / 180;
        for (const sample of offsets) {
          const clone = new PIXI.Sprite(texture);
          clone.anchor.set(0.5, 0.5);
          clone.width = baseWidth;
          clone.height = baseHeight;
          if (instance?.flipH) clone.scale.x *= -1;
          if (instance?.flipV) clone.scale.y *= -1;
          clone.rotation = rotation;
          clone.position.set(baseX + sample.x, baseY + sample.y);
          clone.alpha = 1;
          drawContainer.addChild(clone);
          drawCount += 1;
        }
      }

      if (!drawCount) {
        if (container._shadowContainer) container._shadowContainer.visible = false;
        try { drawContainer.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        return;
      }

      renderer.render(drawContainer, { renderTexture, clear: true });
      try { drawContainer.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}

      shadowSprite.texture = renderTexture;
      shadowSprite.tint = 0x000000;
      shadowSprite.alpha = alpha;
      shadowSprite.position.set(originX, originY);
      shadowSprite.anchor.set(0, 0);
      shadowSprite.width = paddedWidth;
      shadowSprite.height = paddedHeight;
      shadowSprite.visible = true;

      if (blur > 0) {
        let filter = container._shadowBlurFilter || null;
        if (!filter || filter.destroyed) {
          filter = new PIXI.BlurFilter();
          filter.quality = 4;
          filter.repeatEdgePixels = true;
          container._shadowBlurFilter = filter;
        }
        filter.blur = blur * zoom;
        shadowSprite.filters = [filter];
      } else if (shadowSprite.filters) {
        shadowSprite.filters = null;
      }

      container._shadowState = { signature };
    } catch (_) {}
  }

  _computeShadowPreviewSignature() {
    try {
      const container = this._previewContainer;
      const sprite = container?._sprite;
      if (!container || !sprite) return null;
      const texture = sprite.texture || null;
      const baseTexture = texture?.baseTexture || null;
      const assetKey = (() => {
        if (baseTexture?.uid) return baseTexture.uid;
        if (baseTexture?.cacheId) return baseTexture.cacheId;
        if (texture?.cacheId) return texture.cacheId;
        if (this.currentAsset) return this._assetKey(this.currentAsset);
        return 'fa-nexus-preview';
      })();
      const width = Number(sprite.width || 0).toFixed(3);
      const height = Number(sprite.height || 0).toFixed(3);
      const rotation = Number(sprite.rotation || 0).toFixed(4);
      const scaleX = Number(sprite.scale?.x || 0).toFixed(4);
      const scaleY = Number(sprite.scale?.y || 0).toFixed(4);
      const pendingScale = Number(this._getPendingScale() || 0).toFixed(4);
      const pendingRotation = Number(this._getPendingRotation() || 0).toFixed(4);
      const flips = `${this._pendingFlipHorizontal ? 1 : 0}:${this._pendingFlipVertical ? 1 : 0}`;
      const dropShadowActive = this._isPreviewShadowActive() ? 1 : 0;
      const dropSignature = dropShadowActive
        ? [
            Number(this._dropShadowAlpha || 0).toFixed(3),
            Number(this._dropShadowDilation || 0).toFixed(3),
            Number(this._dropShadowBlur || 0).toFixed(3),
            Number(this._dropShadowOffsetDistance || 0).toFixed(3),
            Number(this._dropShadowOffsetAngle || 0).toFixed(3)
          ].join(':')
        : 'off';
      const elevation = formatElevation(this._previewElevation || 0);
      return `${assetKey}:${width}:${height}:${rotation}:${scaleX}:${scaleY}:${pendingScale}:${pendingRotation}:${flips}:${dropShadowActive}:${dropSignature}:${elevation}`;
    } catch (_) {
      return null;
    }
  }

  _scheduleShadowOffsetPreviewUpdate({ force = false } = {}) {
    try {
      if (typeof window === 'undefined') return;
      if (!this._previewContainer || !this._previewContainer._sprite) return;
      const signature = this._computeShadowPreviewSignature();
      const currentSignature = this._shadowOffsetPreview?.signature || null;
      if (!force && signature && currentSignature === signature && !this._shadowPreviewPendingSignature) return;
      this._shadowPreviewPendingSignature = signature;
      if (force) this._shadowPreviewForce = true;
      const requestId = ++this._shadowPreviewSequence;
      this._shadowPreviewRequestedId = requestId;
      if (this._shadowPreviewRendering) return;
      if (this._shadowPreviewFrame) {
        window.cancelAnimationFrame(this._shadowPreviewFrame);
      }
      this._shadowPreviewFrame = window.requestAnimationFrame(() => {
        this._shadowPreviewFrame = null;
        const pendingSignature = this._shadowPreviewPendingSignature;
        const shouldForce = this._shadowPreviewForce;
        this._shadowPreviewPendingSignature = null;
        this._shadowPreviewForce = false;
        if (!pendingSignature) return;
        this._renderShadowOffsetPreview(pendingSignature, { force: shouldForce, requestId: this._shadowPreviewRequestedId });
      });
    } catch (_) {}
  }

  _renderShadowOffsetPreview(signature, { force = false, requestId = null } = {}) {
    try {
      const container = this._previewContainer;
      const sprite = container?._sprite;
      const renderer = canvas?.app?.renderer;
      if (!container || !sprite || !renderer) return;
      const texture = sprite.texture;
      const baseTexture = texture?.baseTexture || null;
      if (!texture || !baseTexture) return;
      if (!baseTexture.valid) {
        if (!this._shadowPreviewTextureListener && typeof baseTexture.once === 'function') {
          const handler = () => {
            if (this._shadowPreviewTextureListener === handler) this._shadowPreviewTextureListener = null;
            this._scheduleShadowOffsetPreviewUpdate({ force: true });
          };
          this._shadowPreviewTextureListener = handler;
          baseTexture.once('loaded', handler);
          baseTexture.once('update', handler);
        }
        return;
      }

      const targetSignature = signature || this._computeShadowPreviewSignature();
      if (!force && targetSignature && this._shadowOffsetPreview?.signature === targetSignature) {
        this._shadowPreviewRendering = false;
        return;
      }

      this._shadowPreviewRendering = true;
      const renderId = requestId ?? ++this._shadowPreviewSequence;

      const circleSize = 160;
      const marginPx = 8;
      const availableSize = circleSize - marginPx * 2;

      const worldWidth = Math.max(0.001, Math.abs(Number(sprite.width || 0)));
      const worldHeight = Math.max(0.001, Math.abs(Number(sprite.height || 0)));
      const spriteScaleX = Number(sprite.scale?.x ?? 1) || 1;
      const spriteScaleY = Number(sprite.scale?.y ?? 1) || 1;
      const flipX = spriteScaleX < 0 ? -1 : 1;
      const flipY = spriteScaleY < 0 ? -1 : 1;
      const rotation = Number(sprite.rotation || 0);
      const rotated = this._computeRotatedSpriteBounds(worldWidth, worldHeight, rotation);
      const alpha = Math.min(1, Math.max(0, Number(this._dropShadowAlpha || 0)));
      const dilation = Math.max(0, Number(this._dropShadowDilation || 0));
      const blur = Math.max(0, Number(this._dropShadowBlur || 0));
      const offset = this._computeShadowOffsetVector();
      const blurMargin = blur * 12;
      const marginWorldX = Math.abs(offset.x) + dilation + blurMargin;
      const marginWorldY = Math.abs(offset.y) + dilation + blurMargin;
      const fitWidth = rotated.width + marginWorldX * 2;
      const fitHeight = rotated.height + marginWorldY * 2;
      const baseScale = availableSize / Math.max(rotated.width, rotated.height);
      const fitScale = availableSize / Math.max(fitWidth, fitHeight);
      const minScale = baseScale * 0.68;
      const scale = Math.max(minScale, Math.min(baseScale, fitScale));

      const renderRoot = new PIXI.Container();
      renderRoot.sortableChildren = false;

      const center = circleSize / 2;
      const createdFilters = [];
      const createdTextures = [];
      const sourceTint = typeof sprite.tint === 'number' ? sprite.tint : null;
      const buildClone = () => {
        const clone = new PIXI.Sprite(texture);
        clone.anchor.set(0.5, 0.5);
        clone.width = worldWidth;
        clone.height = worldHeight;
        clone.rotation = rotation;
        clone.scale.x *= flipX;
        clone.scale.y *= flipY;
        if (sourceTint != null) clone.tint = sourceTint;
        return clone;
      };

      const dropShadowActive = this._isPreviewShadowActive();
      if (dropShadowActive) {
        const shadowDraw = new PIXI.Container();
        shadowDraw.position.set(center, center);
        shadowDraw.scale.set(scale);
        const dilationSamples = this._buildPreviewDilationOffsets(dilation);
        for (const sample of dilationSamples) {
          const clone = buildClone();
          clone.position.set(offset.x + sample.x, offset.y + sample.y);
          clone.tint = 0x000000;
          clone.alpha = 1;
          shadowDraw.addChild(clone);
        }
        if (blur > 0) {
          const filter = new PIXI.BlurFilter();
          filter.quality = 4;
          filter.repeatEdgePixels = true;
          filter.blur = Math.max(0.25, blur * scale);
          shadowDraw.filters = [filter];
          createdFilters.push(filter);
        }
        const shadowTexture = PIXI.RenderTexture.create({
          width: circleSize,
          height: circleSize,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        renderer.render(shadowDraw, { renderTexture: shadowTexture, clear: true });
        const shadowSprite = new PIXI.Sprite(shadowTexture);
        shadowSprite.anchor.set(0.5, 0.5);
        shadowSprite.position.set(center, center);
        shadowSprite.tint = 0x000000;
        shadowSprite.alpha = alpha;
        shadowSprite.blendMode = PIXI.BLEND_MODES.NORMAL;
        renderRoot.addChild(shadowSprite);
        createdTextures.push(shadowTexture);
        shadowDraw.destroy({ children: true, texture: false, baseTexture: false });
      }

      const assetContainer = new PIXI.Container();
      assetContainer.position.set(center, center);
      assetContainer.scale.set(scale);

      const assetClone = buildClone();
      assetClone.position.set(0, 0);
      assetClone.alpha = 1;
      assetContainer.addChild(assetClone);

      renderRoot.addChild(assetContainer);

      const renderTexture = PIXI.RenderTexture.create({
        width: circleSize,
        height: circleSize,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      renderer.render(renderRoot, { renderTexture, clear: true });
      const extraction = renderer.extract?.base64?.(renderTexture);

      const cleanup = () => {
        try { renderRoot.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        for (const filter of createdFilters) {
          if (filter && typeof filter.destroy === 'function') {
            try { filter.destroy(true); } catch (_) {}
          }
        }
        for (const tex of createdTextures) {
          if (tex && !tex.destroyed) {
            try { tex.destroy(true); } catch (_) {}
          }
        }
        if (renderTexture && !renderTexture.destroyed) {
          try { renderTexture.destroy(true); } catch (_) {}
        }
      };

      const finalize = (dataUrl, ok = true) => {
        cleanup();
        const latestRequested = this._shadowPreviewRequestedId;
        const hasPending = this._shadowPreviewPendingSignature != null;
        if (ok && renderId === latestRequested && !hasPending && typeof dataUrl === 'string' && dataUrl.length) {
          const previewData = {
            src: dataUrl,
            width: circleSize,
            height: circleSize,
            signature: targetSignature || null,
            updatedAt: typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(),
            alt: 'Asset drop shadow preview'
          };
          this._shadowOffsetPreview = previewData;
          try { toolOptionsController.updateDropShadowPreview('asset.placement', previewData); } catch (_) {}
        }
        this._shadowPreviewRendering = false;
        if (this._shadowPreviewPendingSignature) {
          this._scheduleShadowOffsetPreviewUpdate({ force: this._shadowPreviewForce });
        }
      };

      if (extraction && typeof extraction.then === 'function') {
        extraction.then((dataUrl) => finalize(dataUrl, true)).catch(() => finalize(null, false));
      } else {
        finalize(extraction, true);
      }
    } catch (_) {
      this._shadowPreviewRendering = false;
    }
  }

  _clearShadowOffsetPreview({ notify = true } = {}) {
    try {
      if (this._shadowPreviewFrame) {
        window.cancelAnimationFrame(this._shadowPreviewFrame);
        this._shadowPreviewFrame = null;
      }
    } catch (_) {
      this._shadowPreviewFrame = null;
    }
    this._shadowPreviewPendingSignature = null;
    this._shadowPreviewRendering = false;
    if (notify) {
      try { toolOptionsController.updateDropShadowPreview('asset.placement', null); } catch (_) {}
    }
    this._shadowOffsetPreview = null;
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

     // Create PIXI container for preview
    const container = new PIXI.Container();
    container.sortableChildren = true;
    container.eventMode = 'none';
    container.name = 'fa-nexus-asset-preview';
    this._previewContainer = container;

     // Create sprite
     const textureUrl = this._encodeAssetPath(this.currentAsset.url);
     let texture;
     const isVideo = /\.(webm|mp4)$/i.test(this.currentAsset.path || '');
     if (isVideo) {
       // For videos, create a video element and use it as texture
       const video = document.createElement('video');
       video.muted = true;
       video.loop = true;
       video.playsInline = true;
       video.autoplay = true;

       // For cross-origin URLs, fetch as blob to avoid CORS issues with PIXI textures
       const isCrossOrigin = /^https?:/i.test(textureUrl);
       if (isCrossOrigin) {
         // Attempt blob fetch for cross-origin videos
         fetch(textureUrl)
           .then((res) => {
             if (!res.ok) throw new Error(`HTTP ${res.status}`);
             return res.blob();
           })
           .then((blob) => {
             const objectUrl = URL.createObjectURL(blob);
             video.src = objectUrl;
             video.load();
           })
           .catch((err) => {
             Logger.warn('Placement.video.fetch.cors', { url: textureUrl, error: err?.message || err });
             // Cannot use cross-origin video with PIXI without CORS headers - notify user
             if (ui?.notifications?.error) {
               ui.notifications.error('Video placement failed: S3 bucket requires CORS configuration for video assets.');
             }
           });
       } else {
         video.src = textureUrl;
         video.load();
       }
       texture = PIXI.Texture.from(video);
     } else {
       texture = getSharedTexture(textureUrl);
     }

    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5, 0.5);
    sprite.rotation = (this._getPendingRotation() * Math.PI) / 180;
    container.addChild(sprite);
    this._ensurePreviewShadowContainer();

     // Set container properties for sorting
     const primary = canvas?.primary;
     const tilesSortLayer = (() => {
       try { return primary?.constructor?.SORT_LAYERS?.TILES ?? 0; }
       catch (_) { return 0; }
     })();
     container.sortLayer = tilesSortLayer;
     container.sort = this._previewSort;
     container.faNexusSort = this._previewSort;
     const renderElevation = getTileRenderElevation(this._previewElevation);
     container.faNexusElevationDoc = this._previewElevation;
     container.faNexusElevation = renderElevation;
     container.elevation = renderElevation;
     container.zIndex = 0;

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
    if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) this._updateScatterCursor();
  }

  _ensurePointerSnapshot(options = {}) {
    const snapshot = this._capturePointerSnapshot(options);
    if (snapshot?.screen) {
      this._lastPointer = { x: snapshot.screen.x, y: snapshot.screen.y };
    } else if (!snapshot) {
      this._lastPointer = null;
    }
    if (snapshot?.world) {
      this._lastPointerWorld = { x: snapshot.world.x, y: snapshot.world.y };
    } else if (snapshot?.screen) {
      const world = this._screenToCanvas(snapshot.screen.x, snapshot.screen.y);
      this._lastPointerWorld = world ? { x: world.x, y: world.y } : null;
    } else if (!snapshot) {
      this._lastPointerWorld = null;
    }
    return snapshot;
  }

  _capturePointerSnapshot(options = {}) {
    const candidates = [];
    const push = (screen, world, weight) => {
      if (!screen) return;
      const x = Number(screen.x);
      const y = Number(screen.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const entry = {
        screen: { x, y },
        world: null,
        weight: Number(weight) || 0
      };
      if (world && Number.isFinite(world.x) && Number.isFinite(world.y)) {
        entry.world = { x: Number(world.x), y: Number(world.y) };
      }
      candidates.push(entry);
    };

    try {
      const pointerEvent = options?.pointerEvent;
      if (pointerEvent && typeof pointerEvent.clientX === 'number' && typeof pointerEvent.clientY === 'number') {
        const screen = { x: Number(pointerEvent.clientX), y: Number(pointerEvent.clientY) };
        const world = this._screenToCanvas(screen.x, screen.y);
        const weight = this._isScreenPointOnCanvas(screen) ? 6 : 2.5;
        push(screen, world, weight);
      }
    } catch (_) { /* no-op */ }

    if (options?.pointer && Number.isFinite(options.pointer.x) && Number.isFinite(options.pointer.y)) {
      const screen = { x: Number(options.pointer.x), y: Number(options.pointer.y) };
      const pointerWorld = options.pointerWorld;
      const world = (pointerWorld && Number.isFinite(pointerWorld.x) && Number.isFinite(pointerWorld.y))
        ? { x: Number(pointerWorld.x), y: Number(pointerWorld.y) }
        : this._screenToCanvas(screen.x, screen.y);
      const weight = this._isScreenPointOnCanvas(screen) ? 5 : 2;
      push(screen, world, weight);
    }

    try {
      const controllerState = this._interactionController?.getPointerState?.();
      if (controllerState?.screen && Number.isFinite(controllerState.screen.x) && Number.isFinite(controllerState.screen.y)) {
        const screen = { x: Number(controllerState.screen.x), y: Number(controllerState.screen.y) };
        const world = (controllerState.world && Number.isFinite(controllerState.world.x) && Number.isFinite(controllerState.world.y))
          ? { x: Number(controllerState.world.x), y: Number(controllerState.world.y) }
          : this._screenToCanvas(screen.x, screen.y);
        const weight = this._isScreenPointOnCanvas(screen) ? 4 : 1.5;
        push(screen, world, weight);
      }
    } catch (_) { /* no-op */ }

    const rendererPointer = this._resolveRendererPointer();
    if (rendererPointer) {
      const world = this._screenToCanvas(rendererPointer.x, rendererPointer.y);
      const weight = this._isScreenPointOnCanvas(rendererPointer) ? 4.5 : 1.8;
      push(rendererPointer, world, weight);
    }

    if (!candidates.length) {
      const width = (typeof window !== 'undefined' && typeof window.innerWidth === 'number') ? window.innerWidth : 1920;
      const height = (typeof window !== 'undefined' && typeof window.innerHeight === 'number') ? window.innerHeight : 1080;
      const screen = { x: width / 2, y: height / 2 };
      const world = this._screenToCanvas(screen.x, screen.y);
      push(screen, world, 0);
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.weight - a.weight);
    const best = candidates[0];
    return {
      screen: best.screen,
      world: best.world
    };
  }

  _isScreenPointOnCanvas(point) {
    if (!point) return false;
    try {
      const canvasEl = this._interactionController?.getCanvasElement?.();
      const rect = canvasEl?.getBoundingClientRect?.();
      if (!rect) return false;
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    } catch (_) {
      return false;
    }
  }

  _resolveRendererPointer() {
    try {
      const canvasEl = this._interactionController?.getCanvasElement?.();
      const rect = canvasEl?.getBoundingClientRect?.();
      if (!rect) return null;
      const candidates = [];
      const add = (pt, weight = 1) => {
        if (!pt) return;
        const x = Number(pt.x);
        const y = Number(pt.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        candidates.push({ x: rect.left + x, y: rect.top + y, weight: Number(weight) || 1 });
      };

      const eventPointer = canvas?.app?.renderer?.events?.pointer?.global;
      if (eventPointer) add(eventPointer, 2.2);

      const interactionPointer = canvas?.app?.renderer?.plugins?.interaction?.mouse?.global;
      if (interactionPointer) add(interactionPointer, 1.6);

      const eventSystemPointer = canvas?.app?.renderer?.eventSystem?.pointer?.global;
      if (eventSystemPointer) add(eventSystemPointer, 1.9);

      if (!candidates.length) return null;
      candidates.sort((a, b) => b.weight - a.weight);
      const top = candidates[0];
      return { x: top.x, y: top.y };
    } catch (_) {
      return null;
    }
  }

  _buildAssetDataFromTile(tileDocument) {
    try {
      const doc = tileDocument?.document ?? tileDocument;
      if (!doc) return null;
      const texture = doc.texture || {};
      const src = String(texture.src || '').trim();
      if (!src) return null;
      const gridSize = Number(canvas?.scene?.grid?.size || 100) || 100;
      const width = Math.max(1, Number(doc.width || 0) || gridSize);
      const height = Math.max(1, Number(doc.height || 0) || gridSize);
      const gridWidth = Math.max(0.01, width / gridSize);
      const gridHeight = Math.max(0.01, height / gridSize);
      const isRemote = /^https?:/i.test(src);
      const filename = src.split('/').pop() || '';
      return {
        source: isRemote ? 'cloud' : 'local',
        tier: isRemote ? 'premium' : 'local',
        file_path: src,
        folder_path: '',
        cachedLocalPath: src,
        path: src,
        url: src,
        filename,
        grid_width: gridWidth,
        grid_height: gridHeight,
        width,
        height,
        actual_width: width,
        actual_height: height
      };
    } catch (error) {
      Logger.warn('Placement.assetDataFromTile.failed', String(error?.message || error));
      return null;
    }
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
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : this._createScatterInstanceId(),
        src: typeof entry.src === 'string' ? entry.src : '',
        x: Number(entry.x) || 0,
        y: Number(entry.y) || 0,
        w: Math.max(1, Number(entry.w) || 0),
        h: Math.max(1, Number(entry.h) || 0),
        r: Number(entry.r) || 0,
        flipH: !!entry.flipH,
        flipV: !!entry.flipV
      }))
      .filter((entry) => entry.src);
  }

  async _editScatterTile(doc, payload, options = {}) {
    try {
      this.cancelPlacement('replace');
      this.isPlacementActive = true;
      this.isStickyMode = false;
      this._scatterMode = ASSET_SCATTER_MODE_BRUSH;
      this._restorePlacementTransformState({ mode: this._scatterMode, regenerateOffsets: true });
      this._scatterPainting = false;
      this._scatterLastPointerWorld = null;
      this._scatterStrokeDistance = 0;
      this._scatterMergeBeforeEdit = this._scatterMergeEnabled;
      this._scatterMergeEnabled = true;
      this._scatterEditing = true;
      this._scatterEraseEnabled = false;
      this._scatterEditTile = doc;
      this._previewFrozen = false;
      this._hsbc = readDocumentHsbc(doc, { nullIfMissing: false }) || createNeutralHsbc();

      const tileObj = doc?.object || null;
      this._editingTileObject = tileObj || null;
      this._editingTileVisibilitySnapshot = tileObj ? this._captureTileVisibility(tileObj) : null;
      if (tileObj) {
        this._releaseTileSelection(tileObj);
        this._hideTileForEditing(tileObj);
      }

      const instances = this._normalizeScatterInstances(payload.instances || []);
      const originX = Number(doc.x || 0);
      const originY = Number(doc.y || 0);
      const worldInstances = instances.map((instance) => ({
        ...instance,
        x: instance.x + originX,
        y: instance.y + originY
      }));

      const initialElevation = Number.isFinite(doc.elevation) ? Number(doc.elevation) : (Number.isFinite(this._lastElevationUsed) ? this._lastElevationUsed : 0);
      this._previewElevation = initialElevation;
      this._lastElevationUsed = this._previewElevation;
      this._previewSort = Number(doc.sort ?? 0) || 0;
      this._beginScatterPreviewSession(worldInstances, { elevation: this._previewElevation });
      this._applyScatterPreviewHsbc();
      this._resetScatterHistory();
      this._recordScatterHistorySnapshot({ force: true });

      const centerWorld = (() => {
        if (options.pointerWorld && Number.isFinite(options.pointerWorld.x) && Number.isFinite(options.pointerWorld.y)) {
          return { x: Number(options.pointerWorld.x), y: Number(options.pointerWorld.y) };
        }
        const w = Number(doc.width || 0);
        const h = Number(doc.height || 0);
        return { x: originX + w / 2, y: originY + h / 2 };
      })();

      const pointerOption = (() => {
        if (options.pointer && Number.isFinite(options.pointer.x) && Number.isFinite(options.pointer.y)) {
          return { x: Number(options.pointer.x), y: Number(options.pointer.y) };
        }
        if (canvas?.stage && centerWorld) {
          try {
            const stagePoint = canvas.stage.worldTransform.apply(new PIXI.Point(centerWorld.x, centerWorld.y));
            const canvasEl = canvas.app?.view || document.querySelector('canvas#board');
            if (canvasEl) {
              const rect = canvasEl.getBoundingClientRect();
              return { x: rect.left + stagePoint.x, y: rect.top + stagePoint.y };
            }
          } catch (_) {}
        }
        return null;
      })();

      this._ensurePointerSnapshot({
        pointer: pointerOption || options.pointer || null,
        pointerWorld: options.pointerWorld || centerWorld
      });
      this._syncScatterPreviewOrdering();
      this._activateToolOptions();
      this._activateTilesLayer();
      this._ensureScatterOverlay();
      this._startInteractionSession();
      this._addPlacementFeedback();
    } catch (error) {
      Logger.warn('Placement.editScatter.failed', String(error?.message || error));
      this.cancelPlacement('error');
    }
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
      if (manager && typeof manager.resumeTile === 'function' && this._editingTile) {
        manager.resumeTile(this._editingTile);
      }
    } catch (_) {
      // ignore resume failures
    } finally {
      this._editingTileShadowSuspended = false;
    }
  }

  _applyTileStateToPlacement(tileDocument, { force = false } = {}) {
    try {
      if (!tileDocument) return;
      const doc = tileDocument.document ?? tileDocument;
      if (!doc) return;
      this._editingTile = doc;
      const shadowEnabled = !!doc.getFlag('fa-nexus', 'shadow');
      this._dropShadowPreference = shadowEnabled ? true : false;

      const readFlag = (key, fallback) => {
        try {
          const value = doc.getFlag('fa-nexus', key);
          if (value === undefined || value === null) return fallback;
          const numeric = Number(value);
          return Number.isFinite(numeric) ? numeric : fallback;
        } catch (_) {
          return fallback;
        }
      };

      const alpha = readFlag('shadowAlpha', this._dropShadowAlpha);
      this._dropShadowAlpha = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : this._dropShadowAlpha));

      const blur = readFlag('shadowBlur', this._dropShadowBlur);
      this._dropShadowBlur = Math.max(0, Number.isFinite(blur) ? blur : this._dropShadowBlur);

      const dilation = readFlag('shadowDilation', this._dropShadowDilation);
      this._dropShadowDilation = Math.min(MAX_SHADOW_DILATION, Math.max(0, Number.isFinite(dilation) ? dilation : this._dropShadowDilation));

      let offsetDistance = readFlag('shadowOffsetDistance', this._dropShadowOffsetDistance);
      offsetDistance = Math.min(this._getShadowOffsetMax(), Math.max(0, Number.isFinite(offsetDistance) ? offsetDistance : this._dropShadowOffsetDistance));
      let offsetAngle = readFlag('shadowOffsetAngle', this._dropShadowOffsetAngle);
      offsetAngle = this._normalizeShadowAngle(Number.isFinite(offsetAngle) ? offsetAngle : this._dropShadowOffsetAngle);
      let offsetX = readFlag('shadowOffsetX', null);
      let offsetY = readFlag('shadowOffsetY', null);
      if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
        offsetDistance = Math.min(this._getShadowOffsetMax(), Math.hypot(offsetX, offsetY));
        offsetAngle = this._normalizeShadowAngle(Math.atan2(offsetY, offsetX) * (180 / Math.PI));
      } else {
        const vecFallback = this._computeShadowOffsetVector(offsetDistance, offsetAngle);
        offsetX = vecFallback.x;
        offsetY = vecFallback.y;
      }
      this._dropShadowOffsetDistance = offsetDistance;
      this._dropShadowOffsetAngle = offsetAngle;
      this._hsbc = readDocumentHsbc(doc, { nullIfMissing: false }) || createNeutralHsbc();

      const canApply = this._isEditingExistingTile || force;
      if (!canApply) {
        this._pendingEditState = { doc };
        this._refreshShadowElevationContext({ adopt: false, sync: true });
        this._notifyDropShadowChanged();
        return;
      }
      if (!this._previewContainer) {
        this._pendingEditState = { doc };
        this._refreshShadowElevationContext({ adopt: false, sync: true });
        this._notifyDropShadowChanged();
        return;
      }

      this._pendingEditState = null;

      const center = {
        x: Number(doc.x || 0) + Number(doc.width || 0) / 2,
        y: Number(doc.y || 0) + Number(doc.height || 0) / 2
      };
      this._lastPointerWorld = { ...center };
      this._previewContainer.x = center.x;
      this._previewContainer.y = center.y;

      this._previewElevation = Number(doc.elevation ?? 0) || 0;
      this._lastElevationUsed = this._previewElevation;
      this._previewSort = Number(doc.sort ?? 0) || 0;
      this._applyPreviewHsbc();
      this._syncPreviewOrdering();

      this.currentRotation = this._normalizeRotation(doc.rotation || 0);
      this._pendingRotation = this.currentRotation;
      this._updateRotationPreview({ clampOffset: true });

      this.currentScale = 1;
      this._pendingScale = this.currentScale;
      this._updateScalePreview({ clampOffset: true });

      const texScaleX = Number(doc?.texture?.scaleX ?? 1);
      const texScaleY = Number(doc?.texture?.scaleY ?? 1);
      this._flipHorizontal = texScaleX < 0;
      this._flipVertical = texScaleY < 0;
      this._pendingFlipHorizontal = this._flipHorizontal;
      this._pendingFlipVertical = this._flipVertical;
      this._applyPendingFlipToPreview({ forceShadow: true });

      this._updatePreviewShadow({ force: true });

      this._refreshShadowElevationContext({ adopt: false, sync: true });
      this._notifyDropShadowChanged();
    } catch (error) {
      Logger.warn('Placement.applyTileState.failed', String(error?.message || error));
    }
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
    try {
      const pointer = (() => {
        if (this._previewFrozen && this._frozenPointerScreen) {
          return { x: this._frozenPointerScreen.x, y: this._frozenPointerScreen.y };
        }
        const anchoredWorld = this._getPreviewAnchorWorld(null, { includeToolOptions: true });
        const anchoredScreen = anchoredWorld ? this._canvasToScreen(anchoredWorld.x, anchoredWorld.y) : null;
        if (anchoredScreen) return anchoredScreen;
        return this._lastPointer ? { x: this._lastPointer.x, y: this._lastPointer.y } : null;
      })();
      const worldWidth = Math.max(0.01, Number(dimensions.worldWidth || 200));
      const worldHeight = Math.max(0.01, Number(dimensions.worldHeight || 200));
      this._hideLoadingOverlay();
      let spinner = null;
      const overlay = new PlacementOverlay({
        className: 'fa-nexus-placement-loading',
        pointer,
        worldWidth,
        worldHeight,
        onSizeChange: (screenWidth, screenHeight) => {
          if (spinner) {
            spinner.style.width = `${screenWidth}px`;
            spinner.style.height = `${screenHeight}px`;
          }
        }
      });
      spinner = createPlacementSpinner();
      spinner.style.width = '100%';
      spinner.style.height = '100%';
      overlay.content.appendChild(spinner);
      this._loadingOverlay = { overlay, spinner, worldWidth, worldHeight };
    } catch (_) {}
  }

  _hideLoadingOverlay() {
    try { this._loadingOverlay?.overlay?.destroy?.(); }
    catch (_) {}
    this._loadingOverlay = null;
  }

  _updateLoadingOverlaySize(worldWidth, worldHeight) {
    try {
      if (!this._loadingOverlay?.overlay) return;
      const current = this._loadingOverlay;
      const ww = Number.isFinite(worldWidth) ? worldWidth : current.worldWidth;
      const wh = Number.isFinite(worldHeight) ? worldHeight : current.worldHeight;
      current.worldWidth = ww;
      current.worldHeight = wh;
      current.overlay.setWorldSize(ww, wh, { trackZoom: true });
    } catch (_) {}
  }

  _updateLoadingOverlayPointer(screenX, screenY) {
    try {
      if (!this._loadingOverlay?.overlay) return;
      this._loadingOverlay.overlay.updatePointer(screenX, screenY);
    } catch (_) {}
  }

  _assetRequiresDownload(asset) {
    if (!asset) return false;
    if (asset.cachedLocalPath) return false;
    const source = String(asset.source || '').toLowerCase();
    if (source !== 'cloud') return false;
    return true;
  }

  async _ensureAssetLocal(asset) {
    if (!asset) return null;
    if (asset.cachedLocalPath) return asset.cachedLocalPath;
    const source = String(asset.source || '').toLowerCase();
    if (source !== 'cloud') return asset.path || asset.url || null;
    const filename = String(asset.filename || '');
    const item = {
      file_path: asset.file_path || asset.path,
      filename,
      tier: asset.tier || 'free',
      path: asset.folder_path || asset.path || asset.file_path || ''
    };
    const app = this.app;
    const content = app?._contentService;
    const dl = app?._downloadManager;
    if (!content || !dl) throw new Error('Content services unavailable');
    const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
    const authed = !!(auth && auth.authenticated && auth.state);
    const fullUrl = await content.getFullURL('assets', item, authed ? auth.state : undefined);
    const local = await dl.ensureLocal('assets', item, fullUrl);
    if (local) {
      // Only set cachedLocalPath if actually downloaded (not using direct CDN URL)
      const isDirectUrl = /^https?:\/\/r2-public\.forgotten-adventures\.net\//i.test(local);
      if (!isDirectUrl) {
        asset.cachedLocalPath = local;
      }
      asset.path = local;
      asset.url = local;
      try { this._updateGridCardDownloaded(asset.file_path || asset.path, local); }
      catch (_) {}
    }
    return local;
  }

  async _prepareCurrentAssetPreview(options = {}) {
    const { initial = false } = options || {};
    const asset = this.currentAsset;
    if (!asset) return;
    const { worldWidth, worldHeight } = this._computeWorldSizeForAsset(asset, this._getPendingScale());
    const needsDownload = this._assetRequiresDownload(asset);
    if (needsDownload) {
      this.isDownloading = true;
      this._removePreviewElement();
      this._showLoadingOverlay({ worldWidth, worldHeight });
      try {
        await this._ensureAssetLocal(asset);
      } catch (error) {
        Logger.warn('Placement.prepare.download.failed', String(error?.message || error));
        ui.notifications?.error?.(`Failed to download asset: ${error?.message || error}`);
        this.isDownloading = false;
        this._hideLoadingOverlay();
        if (initial) this.cancelPlacement('error');
        return;
      }
    }

    if (!this.isPlacementActive) {
      this.isDownloading = false;
      this._hideLoadingOverlay();
      return;
    }

    if (asset !== this.currentAsset) {
      this.isDownloading = false;
      this._hideLoadingOverlay();
      return;
    }

    this._removePreviewElement();
    this._hideLoadingOverlay();
    this.isDownloading = false;
    this._createPreviewElement();
    await this._flushQueuedPlacement();
  }

  async _flushQueuedPlacement() {
    if (!this.queuedPlacement) return;
    const qp = this.queuedPlacement;
    this.queuedPlacement = null;
    try {
      await this._placeAtScreenCoordinates(qp.x, qp.y);
    } catch (error) {
      Logger.warn('Placement.queued.failed', String(error?.message || error));
    }
  }

  _removePreviewElement() {
    try {
      if (this._previewContainer) {
        this._cleanupPreviewShadowResources(this._previewContainer);
        this._previewContainer.parent?.removeChild(this._previewContainer);
        this._previewContainer.destroy({ children: true });
      }
    } catch (_) {}
    this._previewContainer = null;
    this.previewElement = null;
    this._shadowPreviewTextureListener = null;
    this._clearShadowOffsetPreview();
  }

  _ensureScatterOverlay() {
    if (this._scatterOverlay && !this._scatterOverlay.destroyed && this._scatterGfx && this._scatterGhostContainer) return;
    try {
      const overlay = new PIXI.Container();
      overlay.eventMode = 'none';
      overlay.zIndex = 999999;
      const ghostContainer = new PIXI.Container();
      ghostContainer.eventMode = 'none';
      ghostContainer.sortableChildren = false;
      ghostContainer.name = 'fa-nexus-scatter-hover-preview';
      const gfx = new PIXI.Graphics();
      gfx.eventMode = 'none';
      overlay.addChild(ghostContainer);
      overlay.addChild(gfx);
      const parent = canvas?.stage || canvas?.primary;
      parent?.addChild?.(overlay);
      if (parent && 'sortDirty' in parent) parent.sortDirty = true;
      parent?.sortChildren?.();
      this._scatterOverlay = overlay;
      this._scatterGfx = gfx;
      this._scatterGhostContainer = ghostContainer;
    } catch (_) {
      this._scatterOverlay = null;
      this._scatterGfx = null;
      this._scatterGhostContainer = null;
    }
  }

  _clearScatterOverlay() {
    if (Array.isArray(this._scatterGhostSprites)) {
      for (const sprite of this._scatterGhostSprites) {
        try { sprite.parent?.removeChild?.(sprite); } catch (_) {}
        try { sprite.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
    }
    this._scatterGhostSprites = [];
    this._scatterGhostContainer = null;
    if (this._scatterGfx) {
      try { this._scatterGfx.clear(); } catch (_) {}
    }
    if (this._scatterOverlay) {
      try { this._scatterOverlay.parent?.removeChild?.(this._scatterOverlay); } catch (_) {}
      try { this._scatterOverlay.destroy?.({ children: true }); } catch (_) {}
    }
    this._scatterOverlay = null;
    this._scatterGfx = null;
  }

  _syncScatterHoverPreview(worldX = null, worldY = null) {
    const container = this._scatterGhostContainer;
    if (!container) return;
    const instances = this._buildScatterHoverPreviewInstances(worldX, worldY);
    if (!instances.length) {
      container.visible = false;
      for (const sprite of this._scatterGhostSprites) {
        if (sprite) sprite.visible = false;
      }
      return;
    }

    while (this._scatterGhostSprites.length < instances.length) {
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(0.5);
      sprite.eventMode = 'none';
      container.addChild(sprite);
      this._scatterGhostSprites.push(sprite);
    }

    for (let i = 0; i < this._scatterGhostSprites.length; i += 1) {
      const sprite = this._scatterGhostSprites[i];
      const instance = instances[i];
      if (!sprite) continue;
      if (!instance) {
        sprite.visible = false;
        continue;
      }
      const texture = this._getScatterPreviewTexture(instance.src) || PIXI.Texture.EMPTY;
      if (sprite.texture !== texture) sprite.texture = texture;
      sprite.scale.set(1, 1);
      sprite.width = instance.w;
      sprite.height = instance.h;
      if (instance.flipH) sprite.scale.x *= -1;
      if (instance.flipV) sprite.scale.y *= -1;
      sprite.position.set(instance.x, instance.y);
      sprite.rotation = ((instance.r || 0) * Math.PI) / 180;
      sprite.alpha = Math.min(1, Math.max(0.05, Number(instance.previewAlpha) || SCATTER_HOVER_PREVIEW_PRIMARY_ALPHA));
      sprite.visible = true;
    }

    container.visible = true;
  }

  _drawScatterSpacingMarkers(gfx, pos, spacingWorld, color, alpha, brushRadius) {
    if (!gfx || !pos || !Number.isFinite(spacingWorld) || spacingWorld <= 0) return;
    const markerRadius = Math.max(4, Math.min(10, brushRadius * 0.05));
    const connectorPadding = markerRadius + 5;
    for (const direction of [-1, 1]) {
      const markerX = pos.x + spacingWorld * direction;
      const startX = pos.x + (brushRadius + 5) * direction;
      const endX = markerX - connectorPadding * direction;
      if (Math.abs(endX - startX) > 2) {
        gfx.lineStyle(1, color, alpha);
        gfx.moveTo(startX, pos.y);
        gfx.lineTo(endX, pos.y);
      }
      gfx.beginFill(color, alpha * 0.35);
      gfx.lineStyle(1, color, alpha);
      gfx.drawCircle(markerX, pos.y, markerRadius);
      gfx.endFill();
    }
  }

  _updateScatterCursor(worldX = null, worldY = null) {
    if (this._scatterMode !== ASSET_SCATTER_MODE_BRUSH) return;
    if (!this._scatterGfx) return;
    const gfx = this._scatterGfx;
    const pos = (() => {
      if (Number.isFinite(worldX) && Number.isFinite(worldY)) return { x: worldX, y: worldY };
      return this._getPreviewAnchorWorld();
    })();
    gfx.clear();
    this._syncScatterHoverPreview(pos?.x ?? null, pos?.y ?? null);
    if (!pos) return;
    const radius = this._getScatterBrushRadius();
    const eraseActive = this._isScatterEraseActive();
    const color = eraseActive ? 0xff6666 : 0x66ccff;
    gfx.beginFill(color, eraseActive ? 0.08 : 0.04);
    gfx.lineStyle(2, color, 0.85);
    gfx.drawCircle(pos.x, pos.y, Math.max(1, radius));
    gfx.endFill();
    if (!eraseActive) {
      this._drawScatterSpacingMarkers(
        gfx,
        pos,
        this._getScatterSpacingWorld(),
        color,
        0.28,
        radius
      );
    }
  }

  _ensureScatterPreviewOverlay() {
    const elevation = Number.isFinite(this._previewElevation) ? this._previewElevation : 0;
    const group = this._ensureScatterPreviewGroup(elevation, { setActive: true });
    if (group) {
      this._scheduleScatterPreviewShadowUpdate({ force: true, key: group.key });
    }
  }

  _clearScatterPreviewOverlay() {
    if (this._scatterPreviewGroups?.size) {
      for (const group of this._scatterPreviewGroups.values()) {
        this._destroyScatterPreviewGroup(group);
      }
    }
    if (this._scatterPreviewShadowFrame && typeof window !== 'undefined') {
      try { window.cancelAnimationFrame(this._scatterPreviewShadowFrame); } catch (_) {}
    }
    this._scatterPreviewShadowFrame = null;
    this._scatterPreviewShadowForce = false;
    this._scatterPreviewShadowDirty = new Set();
    this._scatterPreviewShadowSettings = new Map();
    this._scatterPreviewShadowTextureListeners = new WeakMap();
    this._scatterPreviewShadowBatchActive = false;
    this._scatterPreviewShadowBatchForce = false;
    this._scatterPreviewShadowBatchNeedsAll = false;
    this._scatterPreviewShadowBatchDirty.clear();
    this._scatterPreviewGroups = new Map();
    this._scatterPreviewContainer = null;
    this._scatterPreviewActiveKey = null;
    this._scatterPreviewInstances = [];
    this._scatterPreviewSprites.clear();
    this._notifyPreviewLayerChange();
  }

  _resetScatterPreviewSession() {
    this._clearScatterPreviewOverlay();
  }

  _beginScatterPreviewSession(instances = [], { elevation = null, shadowSettings = null } = {}) {
    this._resetScatterPreviewSession();
    if (shadowSettings) {
      const entries = shadowSettings instanceof Map
        ? Array.from(shadowSettings.entries())
        : (Array.isArray(shadowSettings) ? shadowSettings : null);
      if (entries) {
        this._scatterPreviewShadowSettings = new Map(entries.map(([key, settings]) => [
          key,
          settings && typeof settings === 'object' ? { ...settings } : settings
        ]));
      }
    }
    const targetElevation = Number.isFinite(elevation) ? elevation : this._previewElevation;
    if (Array.isArray(instances) && instances.length) {
      const key = this._getScatterPreviewGroupKey(targetElevation);
      for (const instance of instances) {
        if (!instance) continue;
        instance._scatterGroupKey = instance._scatterGroupKey || key;
        instance._scatterElevation = Number.isFinite(instance._scatterElevation)
          ? instance._scatterElevation
          : quantizeElevation(Number(targetElevation) || 0);
        this._scatterPreviewInstances.push(instance);
        this._addScatterPreviewInstance(instance);
      }
      this._scheduleScatterPreviewShadowUpdate({ force: true });
    }
  }

  _getScatterPreviewTexture(src) {
    if (!src) return null;
    if (this._scatterPreviewTextures.has(src)) return this._scatterPreviewTextures.get(src);
    const texture = getSharedTexture(src);
    this._scatterPreviewTextures.set(src, texture);
    return texture;
  }

  _addScatterPreviewInstance(instance) {
    if (!instance) return;
    const src = instance.src;
    if (!src) return;
    const elevation = Number.isFinite(instance._scatterElevation) ? instance._scatterElevation : this._previewElevation;
    const group = this._ensureScatterPreviewGroup(elevation, { setActive: this._getScatterPreviewGroupKey(elevation) === this._getScatterPreviewGroupKey(this._previewElevation) });
    if (!group?.container) return;
    instance._scatterGroupKey = instance._scatterGroupKey || group.key;
    instance._scatterElevation = group.elevation;
    if (!group.instances.includes(instance)) group.instances.push(instance);
    const texture = this._getScatterPreviewTexture(src);
    if (!texture) return;
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.position.set(instance.x, instance.y);
    sprite.rotation = ((instance.r || 0) * Math.PI) / 180;
    sprite.width = instance.w;
    sprite.height = instance.h;
    if (instance.flipH) sprite.scale.x *= -1;
    if (instance.flipV) sprite.scale.y *= -1;
    sprite.eventMode = 'none';
    applyHsbcToDisplayObject(sprite, this._getPersistedHsbc(), { slot: 'asset-scatter-preview' });
    group.container.addChild(sprite);
    if (instance.id) {
      this._scatterPreviewSprites.set(instance.id, sprite);
    }
    this._syncScatterPreviewFlags();
    this._scheduleScatterPreviewShadowUpdate({ key: group.key });
  }

  _removeScatterPreviewInstance(instanceId) {
    if (!instanceId) return;
    const sprite = this._scatterPreviewSprites.get(instanceId);
    if (!sprite) return;
    const instance = this._scatterPreviewInstances.find((entry) => entry?.id === instanceId) || null;
    const groupKey = instance?._scatterGroupKey;
    try { sprite.parent?.removeChild?.(sprite); } catch (_) {}
    try { sprite.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    this._scatterPreviewSprites.delete(instanceId);
    if (groupKey && this._scatterPreviewGroups?.size) {
      const group = this._scatterPreviewGroups.get(groupKey);
      if (group) {
        group.instances = (group.instances || []).filter((entry) => entry?.id !== instanceId);
        if (!group.instances.length) {
          this._scatterPreviewGroups.delete(groupKey);
          this._destroyScatterPreviewGroup(group);
          if (this._scatterPreviewActiveKey === groupKey) {
            this._scatterPreviewActiveKey = null;
            this._scatterPreviewContainer = null;
          }
          this._scatterPreviewShadowDirty.delete(groupKey);
        }
      }
    }
    this._syncScatterPreviewFlags();
    this._scheduleScatterPreviewShadowUpdate({ key: groupKey || null });
  }

  _rebuildScatterPreviewSprites() {
    const instances = Array.isArray(this._scatterPreviewInstances) ? this._scatterPreviewInstances : [];
    this._resetScatterPreviewSession();
    this._scatterPreviewInstances = [];
    for (const instance of instances) {
      this._scatterPreviewInstances.push(instance);
      this._addScatterPreviewInstance(instance);
    }
    this._scheduleScatterPreviewShadowUpdate({ force: true });
  }

  _createScatterInstanceId() {
    return `scatter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async _collectScatterStampInstances(worldX, worldY) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return [];
    if (!this.currentAsset && (!this.isRandomMode || !Array.isArray(this.randomAssets) || !this.randomAssets.length)) {
      return [];
    }
    const center = this._applyGridSnapping({ x: worldX, y: worldY });
    const brushRadius = this._getScatterBrushRadius();
    const density = this._getScatterDensity();
    const instances = [];
    for (let i = 0; i < density; i += 1) {
      const asset = this._pickScatterAsset();
      if (!asset) continue;
      if (this._assetRequiresDownload(asset)) {
        try { await this._ensureAssetLocal(asset); } catch (_) { continue; }
      }
      const offset = this._sampleScatterOffset(brushRadius, brushRadius);
      const pos = { x: center.x + offset.x, y: center.y + offset.y };
      const snapped = this._applyGridSnapping(pos);
      const rotation = this._getScatterRotation();
      const scale = this._getScatterScale();
      const flip = this._getScatterFlipState();
      const instance = this._buildScatterInstanceData(asset, snapped, { rotation, scale, flip });
      if (instance) instances.push(instance);
    }
    return instances;
  }

  async _scatterPreviewStampAtWorld(worldX, worldY) {
    try {
      if (this._scatterMergeEnabled && !this._scatterEditing && !this._scatterSessionActive) {
        this._startScatterMergeSession();
      }
      const instances = await this._collectScatterStampInstances(worldX, worldY);
      if (!instances.length) return;
      if (this._scatterMergeEnabled && this._scatterSessionActive && !this._scatterEditing) {
        this._registerScatterSessionInstances(instances, this._previewElevation);
      } else {
        const key = this._getScatterPreviewGroupKey(this._previewElevation);
        const elevation = quantizeElevation(Number(this._previewElevation) || 0);
        for (const instance of instances) {
          if (!instance) continue;
          instance._scatterGroupKey = instance._scatterGroupKey || key;
          instance._scatterElevation = Number.isFinite(instance._scatterElevation) ? instance._scatterElevation : elevation;
        }
      }
      for (const instance of instances) {
        this._scatterPreviewInstances.push(instance);
        this._addScatterPreviewInstance(instance);
      }
      this._scatterHistoryDirty = true;
    } catch (_) {
      // no-op
    }
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
    if (this._scatterSessionActive && removedIds.size) {
      for (const [key, group] of this._scatterSessionGroups) {
        const filtered = (group.instances || []).filter((instance) => !removedIds.has(instance.id));
        if (filtered.length) {
          group.instances = filtered;
        } else {
          this._scatterSessionGroups.delete(key);
        }
      }
    }
    if (removedIds.size) this._scatterHistoryDirty = true;
  }

  _computeScatterInstanceBounds(instance) {
    const cx = Number(instance.x) || 0;
    const cy = Number(instance.y) || 0;
    const hw = Math.max(1, Number(instance.w) || 0) / 2;
    const hh = Math.max(1, Number(instance.h) || 0) / 2;
    const rot = ((Number(instance.r) || 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const corners = [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh }
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const corner of corners) {
      const x = cx + corner.x * cos - corner.y * sin;
      const y = cy + corner.x * sin + corner.y * cos;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  _computeScatterBounds(instances) {
    if (!Array.isArray(instances) || !instances.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const instance of instances) {
      const bounds = this._computeScatterInstanceBounds(instance);
      if (!bounds) continue;
      if (bounds.minX < minX) minX = bounds.minX;
      if (bounds.minY < minY) minY = bounds.minY;
      if (bounds.maxX > maxX) maxX = bounds.maxX;
      if (bounds.maxY > maxY) maxY = bounds.maxY;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
    return {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.max(1, Math.ceil(maxX - minX)),
      height: Math.max(1, Math.ceil(maxY - minY))
    };
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

  _getScatterPreviewGroupKey(elevation) {
    return this._getScatterSessionKey(elevation);
  }

  _notifyPreviewLayerChange() {
    try { Hooks?.callAll?.(PREVIEW_LAYER_HOOK, { source: 'scatter' }); } catch (_) {}
  }

  _syncScatterPreviewFlags() {
    if (!this._scatterPreviewGroups?.size) return false;
    const activeKey = this._scatterPreviewActiveKey;
    let changed = false;
    for (const group of this._scatterPreviewGroups.values()) {
      const container = group?.container;
      if (!container) continue;
      const hasContent = Array.isArray(group.instances) && group.instances.length > 0;
      const isActive = !!activeKey && group.key === activeKey;
      if (container.faNexusPreviewHasContent !== hasContent) {
        container.faNexusPreviewHasContent = hasContent;
        changed = true;
      }
      if (container.faNexusPreviewActive !== isActive) {
        container.faNexusPreviewActive = isActive;
        changed = true;
      }
    }
    if (changed) this._notifyPreviewLayerChange();
    return changed;
  }

  _ensureScatterPreviewGroup(elevation, { setActive = true } = {}) {
    const key = this._getScatterPreviewGroupKey(elevation);
    let group = this._scatterPreviewGroups.get(key);
    if (group?.container && !group.container.destroyed) {
      if (setActive) {
        this._scatterPreviewContainer = group.container;
        this._scatterPreviewActiveKey = key;
        this._syncScatterPreviewFlags();
      }
      return group;
    }

    try {
      const overlay = new PIXI.Container();
      overlay.eventMode = 'none';
      overlay.sortableChildren = false;
      overlay.name = `fa-nexus-scatter-preview-${key}`;
      overlay.faNexusScatterPreview = true;
      overlay.faNexusScatterPreviewKey = key;
      overlay.faNexusPreviewHasContent = false;
      overlay.faNexusPreviewActive = false;
      const parent = canvas?.primary || canvas?.stage;
      overlay.zIndex = parent === canvas?.stage ? SCATTER_PREVIEW_Z_INDEX : 0;
      parent?.addChild?.(overlay);
      if (parent && 'sortDirty' in parent) parent.sortDirty = true;
      parent?.sortChildren?.();

      const normalizedElevation = quantizeElevation(Number(elevation) || 0);
      const currentKey = this._getScatterPreviewGroupKey(this._previewElevation);
      let sort = 0;
      if (currentKey === key && Number.isFinite(this._previewSort)) {
        sort = this._previewSort;
      } else {
        const computed = this._interactionController.computeNextSortAtElevation?.(normalizedElevation);
        sort = Number.isFinite(computed) ? computed : (Number.isFinite(this._previewSort) ? this._previewSort : 0);
      }

      const cachedShadow = this._scatterPreviewShadowSettings.get(key);
      const shadowSettings = cachedShadow ? { ...cachedShadow } : this._snapshotScatterPreviewShadowSettings();
      if (!cachedShadow) this._scatterPreviewShadowSettings.set(key, { ...shadowSettings });

      group = {
        key,
        elevation: normalizedElevation,
        sort,
        container: overlay,
        instances: [],
        shadow: shadowSettings
      };
      this._scatterPreviewGroups.set(key, group);
      this._applyScatterPreviewOrdering(group);

      if (setActive) {
        this._scatterPreviewContainer = overlay;
        this._scatterPreviewActiveKey = key;
      }
      this._syncScatterPreviewFlags();
      return group;
    } catch (_) {
      return null;
    }
  }

  _destroyScatterPreviewGroup(group) {
    if (!group?.container) return;
    const container = group.container;
    this._cleanupPreviewShadowResources(container);
    const prevChildren = container.children?.slice() || [];
    container.removeChildren();
    for (const child of prevChildren) {
      try { child.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    }
    try { container.parent?.removeChild?.(container); } catch (_) {}
    try { container.destroy?.({ children: true }); } catch (_) {}
  }

  _startScatterMergeSession() {
    if (this._scatterEditing) return;
    if (this._scatterSessionActive) {
      this._ensureScatterPreviewOverlay();
      return;
    }
    this._scatterSessionActive = true;
    this._scatterSessionGroups = new Map();
    this._beginScatterPreviewSession();
    this._resetScatterHistory();
    this._recordScatterHistorySnapshot({ force: true });
  }

  _registerScatterSessionInstances(instances, elevation) {
    if (!this._scatterSessionActive || this._scatterEditing) return;
    if (!Array.isArray(instances) || !instances.length) return;
    const key = this._getScatterSessionKey(elevation);
    let group = this._scatterSessionGroups.get(key);
    if (!group) {
      const normalizedElevation = quantizeElevation(Number(elevation) || 0);
      const cachedShadow = this._scatterPreviewShadowSettings.get(key);
      const shadowSettings = cachedShadow ? { ...cachedShadow } : this._snapshotScatterPreviewShadowSettings();
      if (!cachedShadow) this._scatterPreviewShadowSettings.set(key, { ...shadowSettings });
      group = { elevation: normalizedElevation, instances: [], shadowSettings };
      this._scatterSessionGroups.set(key, group);
    }
    for (const instance of instances) {
      if (!instance) continue;
      instance._scatterGroupKey = key;
      instance._scatterElevation = group.elevation;
      group.instances.push(instance);
    }
  }

  _resetScatterMergeSession() {
    this._scatterSessionActive = false;
    this._scatterSessionGroups = new Map();
    this._clearScatterPreviewOverlay();
  }

  _resetScatterHistory() {
    this._scatterHistory = [];
    this._scatterHistoryIndex = -1;
    this._scatterHistoryDirty = false;
  }

  _canUndoScatterHistory() {
    return this._scatterHistoryIndex > 0;
  }

  _canRedoScatterHistory() {
    return this._scatterHistoryIndex >= 0 && this._scatterHistoryIndex < this._scatterHistory.length - 1;
  }

  _recordScatterHistorySnapshot({ force = false } = {}) {
    if (!this._scatterMergeEnabled || this._scatterMode !== ASSET_SCATTER_MODE_BRUSH) return false;
    if (!this._scatterSessionActive && !this._scatterEditing) return false;
    if (!force && !this._scatterHistoryDirty) return false;
    const instances = Array.isArray(this._scatterPreviewInstances) ? this._scatterPreviewInstances : [];
    const snapshotInstances = instances.map((instance) => ({ ...instance }));
    const groups = [];
    for (const [key, group] of this._scatterSessionGroups.entries()) {
      groups.push({
        key,
        elevation: Number.isFinite(group?.elevation) ? group.elevation : 0,
        sort: Number.isFinite(group?.sort) ? group.sort : null,
        shadowSettings: group?.shadowSettings ? { ...group.shadowSettings } : null
      });
    }
    const shadowSettings = Array.from(this._scatterPreviewShadowSettings.entries()).map(([key, settings]) => [
      key,
      settings && typeof settings === 'object' ? { ...settings } : settings
    ]);
    const snapshot = {
      instances: snapshotInstances,
      groups,
      shadowSettings,
      previewElevation: this._previewElevation,
      sessionActive: !!this._scatterSessionActive
    };
    if (this._scatterHistoryIndex < this._scatterHistory.length - 1) {
      this._scatterHistory.splice(this._scatterHistoryIndex + 1);
    }
    this._scatterHistory.push(snapshot);
    if (this._scatterHistory.length > SCATTER_HISTORY_LIMIT) {
      const overflow = this._scatterHistory.length - SCATTER_HISTORY_LIMIT;
      this._scatterHistory.splice(0, overflow);
      this._scatterHistoryIndex = Math.max(-1, this._scatterHistoryIndex - overflow);
    }
    this._scatterHistoryIndex = this._scatterHistory.length - 1;
    this._scatterHistoryDirty = false;
    return true;
  }

  _applyScatterHistorySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const instances = Array.isArray(snapshot.instances)
      ? snapshot.instances.map((entry) => ({ ...entry }))
      : [];
    const groupMap = new Map();
    if (Array.isArray(snapshot.groups)) {
      for (const group of snapshot.groups) {
        if (!group?.key) continue;
        groupMap.set(group.key, { ...group });
      }
    }
    const shadowMap = (() => {
      if (snapshot.shadowSettings instanceof Map) return new Map(snapshot.shadowSettings);
      if (Array.isArray(snapshot.shadowSettings)) {
        return new Map(snapshot.shadowSettings.map(([key, settings]) => [
          key,
          settings && typeof settings === 'object' ? { ...settings } : settings
        ]));
      }
      return new Map();
    })();
    const fallbackElevation = quantizeElevation(Number(this._previewElevation) || 0);
    for (const instance of instances) {
      const rawElevation = Number.isFinite(instance?._scatterElevation) ? instance._scatterElevation : null;
      const keyCandidate = instance?._scatterGroupKey || (rawElevation != null ? this._getScatterSessionKey(rawElevation) : null);
      const group = keyCandidate ? groupMap.get(keyCandidate) : null;
      const elevation = Number.isFinite(rawElevation) ? rawElevation : (group?.elevation ?? fallbackElevation);
      const key = keyCandidate || this._getScatterSessionKey(elevation);
      instance._scatterGroupKey = key;
      instance._scatterElevation = quantizeElevation(elevation);
      if (!groupMap.has(key)) {
        groupMap.set(key, { key, elevation: instance._scatterElevation });
      }
    }

    this._scatterSessionActive = !!snapshot.sessionActive || !!instances.length;
    this._scatterSessionGroups = new Map();
    this._beginScatterPreviewSession(instances, { elevation: this._previewElevation, shadowSettings: shadowMap });
    if (this._scatterSessionActive) {
      const grouped = new Map();
      for (const instance of instances) {
        const key = instance?._scatterGroupKey || this._getScatterSessionKey(instance?._scatterElevation);
        if (!key) continue;
        let group = grouped.get(key);
        if (!group) {
          group = { elevation: instance._scatterElevation ?? fallbackElevation, instances: [] };
          grouped.set(key, group);
        }
        group.instances.push(instance);
      }
      for (const group of grouped.values()) {
        this._registerScatterSessionInstances(group.instances, group.elevation);
      }
    }
    this._syncScatterPreviewOrdering();
    this._scatterHistoryDirty = false;
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _undoScatterHistory() {
    if (!this._canUndoScatterHistory()) return false;
    this._scatterHistoryIndex -= 1;
    const snapshot = this._scatterHistory[this._scatterHistoryIndex];
    return this._applyScatterHistorySnapshot(snapshot);
  }

  _redoScatterHistory() {
    if (!this._canRedoScatterHistory()) return false;
    this._scatterHistoryIndex += 1;
    const snapshot = this._scatterHistory[this._scatterHistoryIndex];
    return this._applyScatterHistorySnapshot(snapshot);
  }

  _resolveScatterTileTextureSrc(instances) {
    if (!Array.isArray(instances)) return null;
    for (const instance of instances) {
      if (instance?.src) return instance.src;
    }
    return null;
  }

  _buildScatterGroupTileData(instances, elevationOverride = null, shadowSettings = null) {
    const bounds = this._computeScatterBounds(instances);
    if (!bounds) return null;
    const localInstances = instances.map((instance) => ({
      id: instance.id,
      src: instance.src,
      x: Number(instance.x) - bounds.x,
      y: Number(instance.y) - bounds.y,
      w: Math.max(1, Number(instance.w) || 0),
      h: Math.max(1, Number(instance.h) || 0),
      r: Number(instance.r) || 0,
      flipH: !!instance.flipH,
      flipV: !!instance.flipV
    }));
    const textureSrc = this._resolveScatterTileTextureSrc(instances);
    if (!textureSrc) return null;
    const elevation = Number.isFinite(elevationOverride) ? elevationOverride : this._previewElevation;
    const nextSort = this._interactionController.computeNextSortAtElevation?.(elevation) ?? 0;
    const moduleFlags = {
      [SCATTER_FLAG_KEY]: {
        version: SCATTER_VERSION,
        instances: localInstances
      }
    };
    this._applyHsbcToModuleFlags(moduleFlags);
    const globalDropShadowEnabled = this._isGlobalDropShadowEnabled();
    const dropShadowEnabled = globalDropShadowEnabled && this.isDropShadowEnabled();
    if (dropShadowEnabled) {
      const settings = shadowSettings || this._snapshotScatterPreviewShadowSettings();
      const offsetVec = this._computeShadowOffsetVector(settings.offsetDistance, settings.offsetAngle);
      moduleFlags.shadow = true;
      moduleFlags.shadowAlpha = this._roundShadowValue(settings.alpha, 3);
      moduleFlags.shadowDilation = this._roundShadowValue(settings.dilation, 3);
      moduleFlags.shadowBlur = this._roundShadowValue(settings.blur, 3);
      moduleFlags.shadowOffsetDistance = this._roundShadowValue(settings.offsetDistance, 2);
      moduleFlags.shadowOffsetAngle = this._roundShadowValue(this._normalizeShadowAngle(settings.offsetAngle), 1);
      moduleFlags.shadowOffsetX = this._roundShadowValue(offsetVec.x, 2);
      moduleFlags.shadowOffsetY = this._roundShadowValue(offsetVec.y, 2);
    }
    return {
      texture: { src: textureSrc },
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      rotation: 0,
      hidden: false,
      locked: false,
      elevation,
      sort: Number(nextSort) || 0,
      overhead: false,
      roof: false,
      occlusion: { mode: 0, alpha: 0 },
      flags: {
        'fa-nexus': moduleFlags
      }
    };
  }

  _buildScatterGroupTileUpdate(instances, tileDoc) {
    const bounds = this._computeScatterBounds(instances);
    if (!bounds) return null;
    const localInstances = instances.map((instance) => ({
      id: instance.id,
      src: instance.src,
      x: Number(instance.x) - bounds.x,
      y: Number(instance.y) - bounds.y,
      w: Math.max(1, Number(instance.w) || 0),
      h: Math.max(1, Number(instance.h) || 0),
      r: Number(instance.r) || 0,
      flipH: !!instance.flipH,
      flipV: !!instance.flipV
    }));
    const textureSrc = this._resolveScatterTileTextureSrc(instances);
    if (!textureSrc) return null;
    const update = {
      _id: tileDoc.id,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      rotation: 0,
      'texture.src': textureSrc,
      [`flags.fa-nexus.${SCATTER_FLAG_KEY}`]: {
        version: SCATTER_VERSION,
        instances: localInstances
      }
    };
    this._applyHsbcToTileUpdate(update);
    const globalDropShadowEnabled = this._isGlobalDropShadowEnabled();
    const dropShadowEnabled = globalDropShadowEnabled && this.isDropShadowEnabled();
    if (dropShadowEnabled) {
      update['flags.fa-nexus.shadow'] = true;
      update['flags.fa-nexus.shadowAlpha'] = this._roundShadowValue(this._dropShadowAlpha, 3);
      update['flags.fa-nexus.shadowDilation'] = this._roundShadowValue(this._dropShadowDilation, 3);
      update['flags.fa-nexus.shadowBlur'] = this._roundShadowValue(this._dropShadowBlur, 3);
      update['flags.fa-nexus.shadowOffsetDistance'] = this._roundShadowValue(this._dropShadowOffsetDistance, 2);
      update['flags.fa-nexus.shadowOffsetAngle'] = this._roundShadowValue(this._normalizeShadowAngle(this._dropShadowOffsetAngle), 1);
      const offsetVec = this._computeShadowOffsetVector();
      update['flags.fa-nexus.shadowOffsetX'] = this._roundShadowValue(offsetVec.x, 2);
      update['flags.fa-nexus.shadowOffsetY'] = this._roundShadowValue(offsetVec.y, 2);
    }
    return update;
  }

  _collectScatterCommitGroups() {
    const groups = [];
    for (const group of this._scatterSessionGroups.values()) {
      if (!group?.instances?.length) continue;
      groups.push({
        elevation: group.elevation,
        instances: group.instances.slice(),
        shadowSettings: group.shadowSettings ? { ...group.shadowSettings } : null
      });
    }
    const fallbackInstances = Array.isArray(this._scatterPreviewInstances) ? this._scatterPreviewInstances : [];
    if (!groups.length && fallbackInstances.length) {
      const key = this._getScatterSessionKey(this._previewElevation);
      const shadowSettings = this._scatterPreviewShadowSettings.get(key) || this._snapshotScatterPreviewShadowSettings();
      groups.push({ elevation: this._previewElevation, instances: fallbackInstances.slice(), shadowSettings });
    }
    return groups;
  }

  async _commitScatterGroups(groups) {
    if (!Array.isArray(groups) || !groups.length || !canvas?.scene) return;
    const tileDataList = [];
    for (const group of groups) {
      const elevation = Number.isFinite(group.elevation) ? group.elevation : this._previewElevation;
      const tileData = this._buildScatterGroupTileData(group.instances, elevation, group.shadowSettings || null);
      if (tileData) tileDataList.push(tileData);
    }
    if (!tileDataList.length) return;
    try {
      await canvas.scene.createEmbeddedDocuments('Tile', tileDataList);
      if (this.isPlacementActive) this._syncPreviewOrdering();
    } catch (error) {
      Logger.warn('Placement.scatter.merge.failed', String(error?.message || error));
    }
  }

  async _commitScatterMergeSession() {
    if (this._scatterEditing) {
      this._resetScatterMergeSession();
      return;
    }
    if (!this._scatterSessionActive) {
      this._resetScatterMergeSession();
      return;
    }
    try {
      if (this._scatterQueuePromise) await this._scatterQueuePromise;
    } catch (_) {}

    const groups = this._collectScatterCommitGroups();
    this._resetScatterMergeSession();
    await this._commitScatterGroups(groups);
  }

  async _commitScatterEditChanges() {
    if (!this._scatterEditing || !this._scatterEditTile || !canvas?.scene) return;
    const instances = Array.isArray(this._scatterPreviewInstances) ? this._scatterPreviewInstances : [];
    if (!instances.length) {
      try { await canvas.scene.deleteEmbeddedDocuments('Tile', [this._scatterEditTile.id]); } catch (_) {}
      this.cancelPlacement('scatter-empty');
      return;
    }
    const update = this._buildScatterGroupTileUpdate(instances, this._scatterEditTile);
    if (!update) return;
    try {
      const updated = await canvas.scene.updateEmbeddedDocuments('Tile', [update], { diff: false });
      if (Array.isArray(updated) && updated[0]) {
        this._scatterEditTile = updated[0];
      }
    } catch (error) {
      Logger.warn('Placement.scatter.edit.failed', String(error?.message || error));
    }
  }

  _stopScatterStroke() {
    void this._endScatterPreviewShadowBatch({ awaitQueue: true });
    this._scatterPainting = false;
    this._scatterLastPointerWorld = null;
    this._scatterStrokeDistance = 0;
    this._scatterQueue = [];
    this._scatterQueueRunning = false;
    this._scatterQueuePromise = null;
  }

  _beginScatterPreviewShadowBatch() {
    if (this._scatterPreviewShadowBatchActive) return;
    if (this._scatterMode !== ASSET_SCATTER_MODE_BRUSH) return;
    if (!this._scatterMergeEnabled) return;
    if (!this._isGlobalDropShadowEnabled() || !this.isDropShadowEnabled()) return;
    this._scatterPreviewShadowBatchActive = true;
    this._scatterPreviewShadowBatchForce = false;
    this._scatterPreviewShadowBatchNeedsAll = false;
    this._scatterPreviewShadowBatchDirty.clear();
  }

  async _endScatterPreviewShadowBatch({ awaitQueue = false } = {}) {
    if (!this._scatterPreviewShadowBatchActive) return;
    const queuePromise = awaitQueue ? this._scatterQueuePromise : null;
    if (queuePromise) {
      try { await queuePromise; } catch (_) {}
    }
    this._scatterPreviewShadowBatchActive = false;
    const force = this._scatterPreviewShadowBatchForce;
    const needsAll = this._scatterPreviewShadowBatchNeedsAll;
    const keys = Array.from(this._scatterPreviewShadowBatchDirty);
    this._scatterPreviewShadowBatchForce = false;
    this._scatterPreviewShadowBatchNeedsAll = false;
    this._scatterPreviewShadowBatchDirty.clear();
    if (!this._scatterPreviewGroups?.size) return;
    if (force || needsAll || !keys.length) {
      this._scheduleScatterPreviewShadowUpdate({ force: true });
      return;
    }
    for (const key of keys) {
      this._scheduleScatterPreviewShadowUpdate({ key });
    }
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
      try { await queuePromise; } catch (_) {}
    }
    manager?.resumeRebuilds?.({ immediate: false });
    this._refreshShadowElevationContext({ adopt: false });
  }

  _resolveScatterQueueAction({ erase = null } = {}) {
    if (this._scatterMergeEnabled) {
      const effectiveErase = erase == null ? this._isScatterEraseActive() : !!erase;
      if (effectiveErase) return 'erase';
      return 'preview';
    }
    return 'tile';
  }

  _queueScatterStamp(worldX, worldY, { erase = null } = {}) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return;
    const action = this._resolveScatterQueueAction({ erase });
    this._scatterQueue.push({ x: worldX, y: worldY, action });
    if (!this._scatterQueueRunning) {
      this._processScatterQueue();
    }
  }

  async _processScatterQueue() {
    if (this._scatterQueueRunning) return;
    this._scatterQueueRunning = true;
    const runner = (async () => {
      try {
        while (this._scatterQueue.length && this.isPlacementActive && this._scatterMode === ASSET_SCATTER_MODE_BRUSH) {
          const point = this._scatterQueue.shift();
          if (!point) continue;
          if (point.action === 'preview') {
            await this._scatterPreviewStampAtWorld(point.x, point.y);
          } else if (point.action === 'erase') {
            this._scatterEraseAtWorld(point.x, point.y, { force: true });
          } else {
            await this._scatterStampAtWorld(point.x, point.y);
          }
        }
      } catch (_) {
        // no-op
      }
    })();
    this._scatterQueuePromise = runner;
    try {
      await runner;
    } finally {
      this._scatterQueueRunning = false;
      if (this._scatterQueuePromise === runner) this._scatterQueuePromise = null;
    }
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
    try {
      if (!this.currentAsset) return;
      if (!canvas || !canvas.scene) return;
      const center = this._applyGridSnapping({ x: worldX, y: worldY });
      const brushRadius = this._getScatterBrushRadius();
      const density = this._getScatterDensity();
      const positions = [];
      for (let i = 0; i < density; i += 1) {
        const offset = this._sampleScatterOffset(brushRadius, brushRadius);
        positions.push({ x: center.x + offset.x, y: center.y + offset.y });
      }
      if (!positions.length) return;

      const controller = this._interactionController;
      let nextSort = controller?.computeNextSortAtElevation?.(this._previewElevation);
      if (!Number.isFinite(nextSort)) nextSort = this._previewSort || 0;

      const tileDataList = [];
      for (const pos of positions) {
        const asset = this._pickScatterAsset();
        if (!asset) continue;
        if (this._assetRequiresDownload(asset)) {
          try { await this._ensureAssetLocal(asset); }
          catch (_) { continue; }
        }
        const snapped = this._applyGridSnapping(pos);
        const rotation = this._getScatterRotation();
        const scale = this._getScatterScale();
        const flip = this._getScatterFlipState();
        const tileData = this._buildScatterTileData(asset, snapped, {
          rotation,
          scale,
          flip,
          sort: nextSort
        });
        if (!tileData) continue;
        tileDataList.push(tileData);
        nextSort += 2;
      }

      if (!tileDataList.length) return;
      const created = await canvas.scene.createEmbeddedDocuments('Tile', tileDataList);
      const createdDocs = Array.isArray(created) ? created : [created];
      const dropShadowEnabled = this._isGlobalDropShadowEnabled() && this.isDropShadowEnabled();
      if (dropShadowEnabled) {
        try {
          const manager = getAssetShadowManager(this.app);
          for (const doc of createdDocs) {
            manager?.registerTile?.(doc);
          }
          if (!this._scatterShadowBatchActive) {
            this._refreshShadowElevationContext({ adopt: false });
          }
        } catch (_) {}
      }
      this._previewSort = nextSort;
      if (this.isPlacementActive) {
        this._syncPreviewOrdering();
      }
    } catch (_) {
      // no-op
    }
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
    const x = Math.round(worldPoint.x - placedWidth / 2);
    const y = Math.round(worldPoint.y - placedHeight / 2);
    const textureConfig = {
      src: this._encodeAssetPath(asset.path || asset.url || ''),
      scaleX: flip?.horizontal ? -1 : 1,
      scaleY: flip?.vertical ? -1 : 1
    };
    const tileData = {
      texture: textureConfig,
      width: placedWidth,
      height: placedHeight,
      x,
      y,
      rotation: rotation ?? 0,
      hidden: false,
      locked: false,
      elevation: this._previewElevation,
      sort: Number(sort || 0) || 0,
      overhead: false,
      roof: false,
      occlusion: { mode: 0, alpha: 0 }
    };
    const globalDropShadowEnabled = this._isGlobalDropShadowEnabled();
    const dropShadowEnabled = globalDropShadowEnabled && this.isDropShadowEnabled();
    if (dropShadowEnabled) {
      tileData.flags = tileData.flags || {};
      const moduleFlags = Object.assign({}, tileData.flags['fa-nexus'] || {});
      this._applyHsbcToModuleFlags(moduleFlags);
      moduleFlags.shadow = true;
      moduleFlags.shadowAlpha = this._roundShadowValue(this._dropShadowAlpha, 3);
      moduleFlags.shadowDilation = this._roundShadowValue(this._dropShadowDilation, 3);
      moduleFlags.shadowBlur = this._roundShadowValue(this._dropShadowBlur, 3);
      moduleFlags.shadowOffsetDistance = this._roundShadowValue(this._dropShadowOffsetDistance, 2);
      moduleFlags.shadowOffsetAngle = this._roundShadowValue(this._normalizeShadowAngle(this._dropShadowOffsetAngle), 1);
      const offsetVec = this._computeShadowOffsetVector();
      moduleFlags.shadowOffsetX = this._roundShadowValue(offsetVec.x, 2);
      moduleFlags.shadowOffsetY = this._roundShadowValue(offsetVec.y, 2);
      tileData.flags['fa-nexus'] = moduleFlags;
    } else {
      const moduleFlags = this._applyHsbcToModuleFlags(Object.assign({}, tileData.flags?.['fa-nexus'] || {}));
      if (Object.keys(moduleFlags).length) {
        tileData.flags = tileData.flags || {};
        tileData.flags['fa-nexus'] = moduleFlags;
      }
    }
    return tileData;
  }

  _startInteractionSession() {
    this._stopInteractionSession();
    if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) {
      this._ensureScatterOverlay();
      this._updateScatterCursor();
    }

    const pointerMoveHandler = (event, { pointer }) => {
      if (!this.isPlacementActive) return;
      if (this._isEditingExistingTile) return;
      this._setScatterPolarityInvertHeld(!!event?.altKey && this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterMergeEnabled, {
        sync: false
      });
      if (pointer?.screen) {
        this._lastPointer = { x: pointer.screen.x, y: pointer.screen.y };
      }
      let worldCoords = pointer?.world || null;
      if ((!worldCoords || !Number.isFinite(worldCoords.x) || !Number.isFinite(worldCoords.y)) && pointer?.screen) {
        worldCoords = this._screenToCanvas(pointer.screen.x, pointer.screen.y);
      }
      if (worldCoords && Number.isFinite(worldCoords.x) && Number.isFinite(worldCoords.y)) {
        this._lastPointerWorld = { x: worldCoords.x, y: worldCoords.y };
      }
      let displayCoords = worldCoords;
      if (displayCoords && this.currentAsset) {
        displayCoords = this._applyGridSnapping(displayCoords);
      }
      this._applyPreviewAnchor(this._getPreviewAnchorWorld(displayCoords));

      if (this._suppressDragSelect && (event.buttons & 1) === 1 && pointer?.overCanvas && pointer?.zOk) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
        } catch (_) { /* no-op */ }
      }

      if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterPainting) {
        if ((event.buttons & 1) !== 1 || !pointer?.overCanvas || !pointer?.zOk) return;
        if (worldCoords && Number.isFinite(worldCoords.x) && Number.isFinite(worldCoords.y)) {
          this._scatterPaintAtWorld(worldCoords.x, worldCoords.y);
        }
      }
    };

    const wheelHandler = (event, { pointer }) => {
      if (!this.isPlacementActive) return;
      if (this._isEditingExistingTile) return;
      const screen = pointer?.screen;
      if (!pointer?.overCanvas || !pointer.zOk || !screen) return;

      if (this._gridSnapShortcutHeld && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        this._gridSnapShortcutPendingToggle = false;
        const delta = event.deltaY < 0 ? 1 : -1;
        void toolOptionsController.nudgeGridSnapSubdivision(delta);
        this._refreshPlacementAfterGridSnapChange();
        return;
      }

      if (event.altKey) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          const dir = event.deltaY < 0 ? 1 : -1;
          const step = this._resolveElevationStep(event);
          const current = Number.isFinite(this._previewElevation) ? this._previewElevation : 0;
          this._setPreviewElevation(current + (dir * step), {
            announce: true,
            syncToolOptions: true,
            worldPoint: pointer?.world || null
          });
        } catch (_) { /* no-op */ }
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const baseStep = Number(this._rotationStep || 15) || 15;
        const step = event.shiftKey ? 1 : baseStep;
        const dir = event.deltaY > 0 ? 1 : -1;
        if (this._rotationRandomEnabled) {
          const range = this._getRotationRandomRange();
          let nextMin = range.min + dir * step;
          let nextMax = range.max + dir * step;
          if (nextMin < 0) {
            nextMax = Math.min(359, nextMax - nextMin);
            nextMin = 0;
          }
          if (nextMax > 359) {
            nextMin = Math.max(0, nextMin - (nextMax - 359));
            nextMax = 359;
          }
          this._rotationRandomMin = this._clampRotationRandomValue(nextMin, range.min);
          this._rotationRandomMax = this._clampRotationRandomValue(Math.max(this._rotationRandomMin, nextMax), range.max);
          this._persistPlacementTransformSetting('assetPlacementRotationRandomMin', this._rotationRandomMin);
          this._persistPlacementTransformSetting('assetPlacementRotationRandomMax', this._rotationRandomMax);
        } else {
          this.currentRotation = ((this.currentRotation + dir * step) % 360 + 360) % 360;
          this._persistPlacementTransformSetting('assetPlacementRotation', this.currentRotation);
        }
        this._updateRotationPreview({ clampOffset: true });
        this._syncToolOptionsState();
        return;
      }

      if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          const step = 1.05;
          // macOS external mice remap Shift+wheel onto deltaX and zero deltaY.
          const delta = Number(event.deltaY) || Number(event.deltaX) || 0;
          const dir = delta < 0 ? 1 : -1;
          if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) {
            const current = this._getScatterBrushSize();
            let next = current * Math.pow(step, dir);
            next = Math.round(next);
            this.setScatterBrushSize(next, true);
            return;
          }
          if (this._scaleRandomEnabled) {
            const range = this._getScaleRandomRange();
            const factor = Math.pow(step, dir);
            const nextMin = this._clampScaleRandomPercent(range.min * factor, range.min);
            const nextMax = this._clampScaleRandomPercent(range.max * factor, range.max);
            this._scaleRandomMin = Math.min(nextMin, nextMax);
            this._scaleRandomMax = Math.max(nextMin, nextMax);
            this._persistPlacementTransformSetting('assetPlacementScaleRandomMin', this._scaleRandomMin);
            this._persistPlacementTransformSetting('assetPlacementScaleRandomMax', this._scaleRandomMax);
          } else {
            const current = Number(this.currentScale || 1) || 1;
            let next = current * Math.pow(step, dir);
            next = this._clampScale(next);
            this.currentScale = next;
            this._persistPlacementTransformSetting('assetPlacementScale', this.currentScale);
          }
          this._updateScalePreview({ clampOffset: true });
          this._syncToolOptionsState();
        } catch (_) { /* no-op */ }
        return;
      }

      try {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const canvasEl = pointer?.canvas || this._interactionController.getCanvasElement?.();
        if (!canvasEl) return;
        const stage = canvas?.stage; if (!stage) return;
        const currentScale = Number(stage.scale?.x || 1);
        const step = 1.25;
        const dir = event.deltaY < 0 ? 1 : -1;
        const targetScale = currentScale * Math.pow(step, dir);
        const view = getZoomAtCursorView({
          canvasEl,
          screenX: screen.x,
          screenY: screen.y,
          targetScale
        });
        if (!view) return;
        if (typeof canvas?.animatePan === 'function') {
          canvas.animatePan({ ...view, duration: 50 });
        } else {
          stage.scale.set(view.scale, view.scale);
          const rect = canvasEl.getBoundingClientRect();
          const centerX = rect.width / 2;
          const centerY = rect.height / 2;
          stage.position.set(centerX - view.scale * view.x, centerY - view.scale * view.y);
        }
      } catch (_) { /* no-op */ }
    };

    const pointerDownHandler = async (event, { pointer }) => {
      if (!this.isPlacementActive) return;
      this._setScatterPolarityInvertHeld(!!event?.altKey && this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterMergeEnabled, {
        sync: false
      });
      if (event.button !== 0) return;
      if (this._isEditingExistingTile) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
        } catch (_) {}
        return false;
      }
      const screen = pointer?.screen;
      if (!pointer?.overCanvas || !pointer.zOk || !screen) return;
      if (screen) {
        this._lastPointer = { x: screen.x, y: screen.y };
        const world = (pointer?.world && Number.isFinite(pointer.world.x) && Number.isFinite(pointer.world.y))
          ? pointer.world
          : this._screenToCanvas(screen.x, screen.y);
        if (world && Number.isFinite(world.x) && Number.isFinite(world.y)) {
          this._lastPointerWorld = { x: world.x, y: world.y };
        }
      }
      this._suppressDragSelect = true;

      if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        this._scatterPainting = true;
        this._scatterLastPointerWorld = null;
        this._scatterStrokeDistance = 0;
        this._beginScatterShadowBatch();
        this._beginScatterPreviewShadowBatch();
        if (this._scatterMergeEnabled) {
          if (this._scatterEditing) {
            this._ensureScatterPreviewOverlay();
          } else {
            this._startScatterMergeSession();
          }
        }
        if (this._lastPointerWorld) {
          this._scatterPaintAtWorld(this._lastPointerWorld.x, this._lastPointerWorld.y);
        }
        return false;
      }

      if (this.isDownloading) {
        const queued = (this._previewFrozen && this._frozenPointerScreen)
          ? { x: this._frozenPointerScreen.x, y: this._frozenPointerScreen.y }
          : { x: screen.x, y: screen.y };
        this.queuedPlacement = queued;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      await this._handleCanvasPlacement(event, pointer);
      return false;
    };

    const pointerUpHandler = async () => {
      if (!this.isPlacementActive) return;
      this._suppressDragSelect = false;
      if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH) {
        this._scatterPainting = false;
        this._scatterLastPointerWorld = null;
        this._scatterStrokeDistance = 0;
        if (this._scatterMergeEnabled) {
          try {
            if (this._scatterQueuePromise) await this._scatterQueuePromise;
          } catch (_) {}
          if (this._scatterEditing) {
            await this._commitScatterEditChanges();
          }
          if (this._scatterHistoryDirty) {
            this._recordScatterHistorySnapshot();
            this._syncToolOptionsState({ suppressRender: false });
          }
          await this._endScatterPreviewShadowBatch({ awaitQueue: false });
        } else {
          await this._endScatterShadowBatch({ awaitQueue: true });
        }
        this._stopScatterStroke();
      }
    };

    const keyDownHandler = (event) => {
      if (!this.isPlacementActive) return;
      this._setScatterPolarityInvertHeld(!!event.altKey && this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterMergeEnabled, {
        sync: !!event.altKey
      });
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        if (this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterMergeEnabled) {
          void this._requestScatterCancel({ source: 'escape' });
        } else {
          this.cancelPlacement('esc');
        }
        return;
      }
      const keyName = typeof event?.key === 'string' ? event.key : '';
      const keyLower = keyName.toLowerCase();
      const hasModifier = !!(event.ctrlKey || event.metaKey);
      const isUndo = hasModifier && keyLower === 'z' && !event.shiftKey;
      const isRedo = hasModifier && (keyLower === 'y' || (keyLower === 'z' && event.shiftKey));
      if ((isUndo || isRedo) && this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterMergeEnabled) {
        if (this._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        void this._handleEditorAction(isUndo ? 'scatter-undo' : 'scatter-redo');
        return;
      }
      if (typeof isHelpShortcut === 'function' && isHelpShortcut(event)) {
        if (this._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        toolOptionsController.openActiveToolHelp?.({ focus: true });
        return;
      }
      if (isCommitShortcut(event) && this._isExistingTileReplaceSession()) {
        if (this._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        void this._commitExistingTileReplaceFromShortcut();
        return;
      }
      if (isCommitShortcut(event) && this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterMergeEnabled) {
        if (this._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        void this._handleEditorAction('scatter-commit');
        return;
      }
      if (isGridSnapShortcut(event)) {
        if (this._shouldIgnorePlacementHotkey(event, keyName)) return;
        this._gridSnapShortcutHeld = true;
        if (!event.repeat) this._gridSnapShortcutPendingToggle = true;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        return;
      }
      if (this._isEditingExistingTile) return;
      const elevationDirection = event.altKey ? this._getElevationShortcutDirection(event) : 0;
      if (elevationDirection !== 0) {
        if (this._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const step = this._resolveElevationStep(event);
        const current = Number.isFinite(this._previewElevation) ? this._previewElevation : 0;
        this._setPreviewElevation(current + (elevationDirection * step), {
          announce: true,
          syncToolOptions: true,
          worldPoint: this._getElevationAnnouncePoint()
        });
        return;
      }
      if (isPolarityShortcut(event) && this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterMergeEnabled) {
        if (this._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        this.setScatterEraserEnabled(!this._scatterEraseEnabled);
        return;
      }
      const isSpace = event.code === 'Space' || event.key === ' ';
      if (!isSpace || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (this._shouldIgnoreFreezeShortcut(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      this._togglePlacementFreeze();
    };

    const keyUpHandler = (event) => {
      if (String(event?.key || '').toLowerCase() === 's') {
        const shouldToggle = this._gridSnapShortcutHeld && this._gridSnapShortcutPendingToggle;
        this._gridSnapShortcutHeld = false;
        this._gridSnapShortcutPendingToggle = false;
        if (shouldToggle) {
          event.preventDefault?.();
          event.stopPropagation?.();
          event.stopImmediatePropagation?.();
          void toolOptionsController.toggleGridSnapShortcut();
          this._refreshPlacementAfterGridSnapChange();
        }
      }
      this._setScatterPolarityInvertHeld(!!event.altKey && this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterMergeEnabled, {
        sync: true
      });
    };

    this._gestureSession = createCanvasGestureSession({
      pointermove: { handler: pointerMoveHandler, respectZIndex: false },
      wheel: { handler: wheelHandler, respectZIndex: true },
      pointerdown: pointerDownHandler,
      pointerup: pointerUpHandler,
      pointercancel: pointerUpHandler,
      keydown: keyDownHandler,
      keyup: keyUpHandler
    }, {
      lockTileInteractivity: true,
      onCanvasTearDown: () => this.cancelPlacement('canvas-teardown'),
      onStop: () => {
        this._gestureSession = null;
        this._stopZoomWatcher();
        this._suppressDragSelect = false;
        this._gridSnapShortcutHeld = false;
        this._gridSnapShortcutPendingToggle = false;
        this._setScatterPolarityInvertHeld(false, { sync: false });
      }
    });

    this._startZoomWatcher();
  }

  _stopInteractionSession() {
    if (this._gestureSession) {
      try { this._gestureSession.stop('manual'); }
      catch (_) { /* no-op */ }
      return;
    }
    this._stopZoomWatcher();
    this._suppressDragSelect = false;
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
      if (!world || !Number.isFinite(world.x) || !Number.isFinite(world.y)) return;
      const worldPoint = { x: Number(world.x), y: Number(world.y) };
      if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
        this._lastPointer = { x: Number(screenX), y: Number(screenY) };
      } else {
        const estimated = this._canvasToScreen(worldPoint.x, worldPoint.y);
        if (estimated && Number.isFinite(estimated.x) && Number.isFinite(estimated.y)) {
          this._lastPointer = { x: estimated.x, y: estimated.y };
        }
      }
      this._lastPointerWorld = { x: worldPoint.x, y: worldPoint.y };
      const snappedWorld = this._applyGridSnapping(worldPoint);
      this._announcePreviewElevation(snappedWorld, { immediate: true });
      if (this._previewFrozen) {
        this._frozenPreviewWorld = { x: snappedWorld.x, y: snappedWorld.y };
        this._refreshFrozenPointerScreen();
      }
      if (!this.currentAsset) return;
      const editingDoc = ((this._isEditingExistingTile || this._replaceOriginalOnPlace) && this._editingTile) ? this._editingTile : null;
      // Re-evaluate sort order before every placement so consecutive drops
      // during the same session continue stacking correctly.
      if (editingDoc) {
        this._previewSort = Number(editingDoc.sort ?? 0) || 0;
        if (this._previewContainer) {
          this._previewContainer.sort = this._previewSort;
          this._previewContainer.faNexusSort = this._previewSort;
          const parent = this._previewContainer.parent;
          if (parent && 'sortDirty' in parent) parent.sortDirty = true;
          parent?.sortChildren?.();
        }
      } else {
        try {
          const controller = this._interactionController;
          const computed = controller?.computeNextSortAtElevation?.(this._previewElevation);
          if (Number.isFinite(computed)) {
            this._previewSort = computed;
            if (this._previewContainer) {
              this._previewContainer.sort = computed;
              this._previewContainer.faNexusSort = computed;
              const parent = this._previewContainer.parent;
              if (parent && 'sortDirty' in parent) parent.sortDirty = true;
              parent?.sortChildren?.();
            }
          }
        } catch (_) { /* no-op */ }
      }
      this._syncScatterPreviewOrdering();
      // If in random lazy mode and the current asset is cloud without local cache, ensure now
      if (this.isRandomMode && this.currentAsset && String(this.currentAsset.source || '').toLowerCase() === 'cloud' && !this.currentAsset.cachedLocalPath) {
        try {
          const app = this.app;
          const content = app?._contentService;
          const dl = app?._downloadManager;
          const filename = String(this.currentAsset.filename || '');
          const item = { file_path: this.currentAsset.file_path || this.currentAsset.path, filename, tier: this.currentAsset.tier || 'free' };
          const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
          const authed = !!(auth && auth.authenticated && auth.state);
          const fullUrl = content?.getFullURL ? await content.getFullURL('assets', item, authed ? auth.state : undefined) : null;
          const local = dl?.ensureLocal && fullUrl ? await dl.ensureLocal('assets', item, fullUrl) : null;
          if (local) {
            // Only set cachedLocalPath if actually downloaded (not using direct CDN URL)
            const isDirectUrl = /^https?:\/\/r2-public\.forgotten-adventures\.net\//i.test(local);
            if (!isDirectUrl) {
              this.currentAsset.cachedLocalPath = local;
            }
            this.currentAsset.path = local;
            this.currentAsset.url = local;
            Logger.info('Placement.lazyDownload.done', { filename, local });
            // Reflect in grid UI if possible
            try { this._updateGridCardDownloaded(this.currentAsset.file_path || this.currentAsset.path, local); } catch (_) {}
          }
        } catch (e) {
          Logger.warn('Placement.lazyDownload.failed', String(e?.message || e));
        }
      }
      const assetPx = this._getAssetBasePxPerSquare();
      const sceneGridSize = canvas?.scene?.grid?.size || 100;
      const gridScaleFactor = sceneGridSize / assetPx;
      const sm = this._getPendingScale();
      const placedWidth = Math.round((this._previewContainer?._tileWidth || assetPx) * gridScaleFactor * sm);
      const placedHeight = Math.round((this._previewContainer?._tileHeight || assetPx) * gridScaleFactor * sm);
      const x = Math.round(snappedWorld.x - placedWidth / 2);
      const y = Math.round(snappedWorld.y - placedHeight / 2);
      const globalDropShadowEnabled = this._isGlobalDropShadowEnabled();
      const dropShadowEnabled = globalDropShadowEnabled && this.isDropShadowEnabled();
      const placementRotation = this._getPendingRotation();
      const flipState = this._getPendingFlipState();
      const textureConfig = {
        src: this._encodeAssetPath(this.currentAsset.path),
        scaleX: flipState.horizontal ? -1 : 1,
        scaleY: flipState.vertical ? -1 : 1
      };
      const tileData = {
        texture: textureConfig,
        width: placedWidth, height: placedHeight, x, y,
        rotation: placementRotation, hidden: false, locked: false,
        elevation: this._previewElevation, sort: this._previewSort,
        overhead: false, roof: false, occlusion: { mode: 0, alpha: 0 }
      };
      if (dropShadowEnabled) {
        tileData.flags = tileData.flags || {};
        const moduleFlags = Object.assign({}, tileData.flags['fa-nexus'] || {});
        this._applyHsbcToModuleFlags(moduleFlags);
        moduleFlags.shadow = true;
        moduleFlags.shadowAlpha = this._roundShadowValue(this._dropShadowAlpha, 3);
        moduleFlags.shadowDilation = this._roundShadowValue(this._dropShadowDilation, 3);
        moduleFlags.shadowBlur = this._roundShadowValue(this._dropShadowBlur, 3);
        moduleFlags.shadowOffsetDistance = this._roundShadowValue(this._dropShadowOffsetDistance, 2);
        moduleFlags.shadowOffsetAngle = this._roundShadowValue(this._normalizeShadowAngle(this._dropShadowOffsetAngle), 1);
        const offsetVec = this._computeShadowOffsetVector();
        moduleFlags.shadowOffsetX = this._roundShadowValue(offsetVec.x, 2);
        moduleFlags.shadowOffsetY = this._roundShadowValue(offsetVec.y, 2);
        tileData.flags['fa-nexus'] = moduleFlags;
      } else {
        const moduleFlags = this._applyHsbcToModuleFlags(Object.assign({}, tileData.flags?.['fa-nexus'] || {}));
        if (Object.keys(moduleFlags).length) {
          tileData.flags = tileData.flags || {};
          tileData.flags['fa-nexus'] = moduleFlags;
        }
      }
      if (!canvas || !canvas.scene) throw new Error('Canvas unavailable');

      const replaceDoc = (this._replaceOriginalOnPlace && this._editingTile) ? this._editingTile : null;
      if (replaceDoc) {
        let standardTileMask = null;
        try { standardTileMask = replaceDoc.getFlag?.('fa-nexus', 'standardTileMask') ?? null; } catch (_) {}
        if (standardTileMask) {
          const deepClone = foundry?.utils?.deepClone;
          if (typeof deepClone !== 'function') {
            Logger.error('Placement.replaceTile.standardMaskCloneUnavailable', { tileId: replaceDoc.id || null });
            throw new Error('foundry.utils.deepClone unavailable while preserving standard tile mask');
          }
          tileData.flags = tileData.flags || {};
          const moduleFlags = Object.assign({}, tileData.flags['fa-nexus'] || {});
          moduleFlags.standardTileMask = deepClone(standardTileMask);
          tileData.flags['fa-nexus'] = moduleFlags;
          Logger.info('Placement.replaceTile.standardMaskPreserved', {
            tileId: replaceDoc.id || null,
            maskType: standardTileMask?.maskType || null
          });
        }
      }

      if (editingDoc && !replaceDoc) {
        const update = {
          _id: editingDoc.id,
          x,
          y,
          width: placedWidth,
          height: placedHeight,
          rotation: placementRotation,
          elevation: this._previewElevation,
          sort: this._previewSort,
          'texture.scaleX': textureConfig.scaleX,
          'texture.scaleY': textureConfig.scaleY
        };
        if (textureConfig.src && textureConfig.src !== editingDoc.texture?.src) {
          update['texture.src'] = textureConfig.src;
        }
        if (dropShadowEnabled) {
          this._applyHsbcToTileUpdate(update);
          update['flags.fa-nexus.shadow'] = true;
          update['flags.fa-nexus.shadowAlpha'] = this._roundShadowValue(this._dropShadowAlpha, 3);
          update['flags.fa-nexus.shadowDilation'] = this._roundShadowValue(this._dropShadowDilation, 3);
          update['flags.fa-nexus.shadowBlur'] = this._roundShadowValue(this._dropShadowBlur, 3);
          update['flags.fa-nexus.shadowOffsetDistance'] = this._roundShadowValue(this._dropShadowOffsetDistance, 2);
          update['flags.fa-nexus.shadowOffsetAngle'] = this._roundShadowValue(this._normalizeShadowAngle(this._dropShadowOffsetAngle), 1);
          const offsetVec = this._computeShadowOffsetVector();
          update['flags.fa-nexus.shadowOffsetX'] = this._roundShadowValue(offsetVec.x, 2);
          update['flags.fa-nexus.shadowOffsetY'] = this._roundShadowValue(offsetVec.y, 2);
        } else {
          this._applyHsbcToTileUpdate(update);
          update['flags.fa-nexus.shadow'] = false;
          update['flags.fa-nexus.shadowAlpha'] = null;
          update['flags.fa-nexus.shadowDilation'] = null;
          update['flags.fa-nexus.shadowBlur'] = null;
          update['flags.fa-nexus.shadowOffsetDistance'] = null;
          update['flags.fa-nexus.shadowOffsetAngle'] = null;
          update['flags.fa-nexus.shadowOffsetX'] = null;
          update['flags.fa-nexus.shadowOffsetY'] = null;
        }
        const updated = await canvas.scene.updateEmbeddedDocuments('Tile', [update], { diff: false });
        if (Array.isArray(updated) && updated[0]) {
          this._editingTile = updated[0];
        }
        this._setPlacementFreeze(false, { announce: false });
        this.cancelPlacement('completed');
        return;
      }

      const created = await canvas.scene.createEmbeddedDocuments('Tile', [tileData]);
      const createdDocs = Array.isArray(created) ? created : [created];
      const primaryCreated = createdDocs[0] || null;
      try { Logger.info('Placement.placed', { path: this.currentAsset?.path, w: placedWidth, h: placedHeight, x, y, rot: placementRotation }); } catch (_) {}

      if (replaceDoc) {
        try {
          await canvas.scene.deleteEmbeddedDocuments('Tile', [replaceDoc.id]);
        } catch (error) {
          Logger.warn('Placement.replaceTile.delete.failed', String(error?.message || error));
          ui.notifications?.warn?.(`Failed to remove original tile: ${error?.message || error}`);
          this._restoreEditingTileVisibility();
          this._resumeEditingTileShadow();
        }
        this._editingTileObject = null;
        this._editingTileVisibilitySnapshot = null;
        this._editingTile = primaryCreated ?? null;
        this._replaceOriginalOnPlace = false;
        this._editingTileShadowSuspended = false;
      }

      if (dropShadowEnabled) {
        try {
          const manager = getAssetShadowManager(this.app);
          for (const doc of createdDocs) {
            manager?.registerTile?.(doc);
          }
          this._refreshShadowElevationContext({ adopt: false });
       } catch (e) {
          Logger.warn('Placement.shadow.register.failed', String(e?.message || e));
        }
      }

      if (this.isPlacementActive) {
        // Prepare preview for the next placement using the newly created tile as context.
        this._syncPreviewOrdering();
        this._prepareNextPlacementRotation();
        this._prepareNextPlacementScale();
        this._prepareNextPlacementFlip();
      }
      this._setPlacementFreeze(false, { announce: false });
      
      // Continue random mode by switching preview to next asset
      if (this.isStickyMode && this.isRandomMode) {
        await this._switchToNextRandomAsset();
        return; // remain active
      }

      // Only cancel placement if not in sticky mode
      if (!this.isStickyMode) { this.cancelPlacement('completed'); }
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
    } catch (_) {
      return fallback;
    }
  }

  _persistPlacementSetting(key, value) {
    try {
      const settings = globalThis?.game?.settings;
      if (!settings || typeof settings.set !== 'function') return;
      const maybe = settings.set('fa-nexus', key, value);
      if (maybe?.catch) maybe.catch(() => {});
    } catch (_) {
      // no-op
    }
  }

  _resolvePlacementTransformSettingKey(key, { mode = this._scatterMode } = {}) {
    const rawKey = String(key || '');
    if (!rawKey) return '';
    const scopedMode = mode === ASSET_SCATTER_MODE_BRUSH ? ASSET_SCATTER_MODE_BRUSH : ASSET_SCATTER_MODE_SINGLE;
    if (scopedMode !== ASSET_SCATTER_MODE_BRUSH) return rawKey;
    return SCATTER_PLACEMENT_TRANSFORM_SETTINGS[rawKey] || rawKey;
  }

  _readPlacementTransformSetting(key, fallback, options = {}) {
    const scopedKey = this._resolvePlacementTransformSettingKey(key, options);
    return this._readPlacementSetting(scopedKey, fallback);
  }

  _persistPlacementTransformSetting(key, value, options = {}) {
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
    return stored === ASSET_SCATTER_MODE_BRUSH ? ASSET_SCATTER_MODE_BRUSH : ASSET_SCATTER_MODE_SINGLE;
  }

  _readDropShadowPreference() {
    const stored = String(this._readPlacementSetting('assetPlacementDropShadowPreference', 'global') || '');
    if (stored === 'on') return true;
    if (stored === 'off') return false;
    return null;
  }

  _persistDropShadowPreference(value) {
    const stored = value === null || value === undefined
      ? 'global'
      : (value ? 'on' : 'off');
    this._persistPlacementSetting('assetPlacementDropShadowPreference', stored);
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
    try {
      const settings = globalThis?.game?.settings;
      if (!settings || typeof settings.set !== 'function') return;
      const maybe = settings.set('fa-nexus', key, value);
      if (maybe?.catch) maybe.catch(() => {});
    } catch (_) {
      // no-op
    }
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
    try {
      const settings = globalThis?.game?.settings;
      if (!settings || typeof settings.set !== 'function') return;
      const maybe = settings.set('fa-nexus', key, value);
      if (maybe?.catch) maybe.catch(() => {});
    } catch (_) {
      // no-op
    }
  }

  _readShadowOffsetMax() {
    try {
      const raw = game?.settings?.get?.('fa-nexus', 'assetDropShadowOffsetMax');
      const n = Number(raw);
      if (!Number.isFinite(n)) return DEFAULT_SHADOW_OFFSET_MAX;
      return Math.min(SHADOW_OFFSET_MAX_CEILING, Math.max(MIN_SHADOW_OFFSET_MAX, n));
    } catch (_) {
      return DEFAULT_SHADOW_OFFSET_MAX;
    }
  }

  _getShadowOffsetMax() {
    const n = Number(this._dropShadowOffsetMax);
    if (!Number.isFinite(n)) return DEFAULT_SHADOW_OFFSET_MAX;
    return Math.min(SHADOW_OFFSET_MAX_CEILING, Math.max(MIN_SHADOW_OFFSET_MAX, n));
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
    if (!snapshot || typeof snapshot !== 'object') return null;
    const alpha = Number(snapshot.alpha);
    const dilation = Number(snapshot.dilation);
    const blur = Number(snapshot.blur);
    const offsetDistance = Number(snapshot.offsetDistance);
    const offsetAngle = Number(snapshot.offsetAngle);
    if (!Number.isFinite(alpha) || !Number.isFinite(dilation) || !Number.isFinite(blur) || !Number.isFinite(offsetDistance) || !Number.isFinite(offsetAngle)) {
      return null;
    }
    return {
      alpha: Math.min(1, Math.max(0, alpha)),
      dilation: Math.min(MAX_SHADOW_DILATION, Math.max(0, dilation)),
      blur: Math.min(MAX_SHADOW_BLUR, Math.max(0, blur)),
      offsetDistance: Math.min(this._getShadowOffsetMax(), Math.max(0, offsetDistance)),
      offsetAngle: this._normalizeShadowAngle(offsetAngle)
    };
  }

  _compareShadowSnapshots(a, b) {
    if (!a || !b) return false;
    const approx = (x, y, tol = 0.0005) => Math.abs(Number(x || 0) - Number(y || 0)) <= tol;
    if (!approx(a.alpha, b.alpha)) return false;
    if (!approx(a.dilation, b.dilation)) return false;
    if (!approx(a.blur, b.blur)) return false;
    if (!approx(a.offsetDistance, b.offsetDistance)) return false;
    const angleA = this._normalizeShadowAngle(a.offsetAngle);
    const angleB = this._normalizeShadowAngle(b.offsetAngle);
    const angleDelta = Math.abs(angleA - angleB) % 360;
    return angleDelta <= 0.1 || angleDelta >= 359.9;
  }

  _readShadowSettingsCollapsed() {
    try { return !!game.settings.get('fa-nexus', 'assetDropShadowCollapsed'); }
    catch (_) { return false; }
  }

  _persistShadowCollapsed(collapsed) {
    try {
      const result = game.settings.set('fa-nexus', 'assetDropShadowCollapsed', !!collapsed);
      if (result?.catch) result.catch(() => {});
    } catch (_) {}
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
      const result = game.settings.set('fa-nexus', 'assetDropShadowPresets', payload);
      if (result?.catch) result.catch(() => {});
    } catch (_) {}
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
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    let normalized = numeric % 360;
    if (normalized < 0) normalized += 360;
    return normalized;
  }

  _roundShadowValue(value, decimals = 2) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    const places = Math.max(0, Math.min(6, Math.floor(decimals)));
    const factor = 10 ** places;
    return Math.round(numeric * factor) / factor;
  }

  _scheduleEditingCommit(immediate = false) {
    if (!this._isEditingExistingTile) return;
    if (this._editingCommitTimer) {
      try { clearTimeout(this._editingCommitTimer); }
      catch (_) {}
      this._editingCommitTimer = null;
    }
    if (immediate) {
      this._commitEditingShadowChanges();
      return;
    }
    this._editingCommitTimer = setTimeout(() => {
      this._editingCommitTimer = null;
      this._commitEditingShadowChanges();
    }, 150);
  }

  _commitEditingShadowChanges() {
    if (!this._isEditingExistingTile || !this._editingTile || !canvas?.scene) return;
    if (this._editingCommitTimer) {
      try { clearTimeout(this._editingCommitTimer); }
      catch (_) {}
      this._editingCommitTimer = null;
    }
    const doc = this._editingTile;
    const enabled = this.isDropShadowEnabled();
    const offsetVec = this._computeShadowOffsetVector();
    let placedWidth = null;
    let placedHeight = null;
    try {
      const dims = this._computeWorldSizeForAsset(this.currentAsset, this._getPendingScale());
      if (dims && Number.isFinite(dims.worldWidth) && Number.isFinite(dims.worldHeight)) {
        placedWidth = Math.max(1, Math.round(dims.worldWidth));
        placedHeight = Math.max(1, Math.round(dims.worldHeight));
      }
    } catch (_) {}
    const rotation = this._getPendingRotation();
    const flipState = this._getPendingFlipState();

    const payload = {
      _id: doc.id,
      'flags.fa-nexus.shadow': !!enabled,
      'flags.fa-nexus.shadowAlpha': this._roundShadowValue(this._dropShadowAlpha, 3),
      'flags.fa-nexus.shadowBlur': this._roundShadowValue(this._dropShadowBlur, 3),
      'flags.fa-nexus.shadowDilation': this._roundShadowValue(this._dropShadowDilation, 3),
      'flags.fa-nexus.shadowOffsetDistance': this._roundShadowValue(this._dropShadowOffsetDistance, 2),
      'flags.fa-nexus.shadowOffsetAngle': this._roundShadowValue(this._normalizeShadowAngle(this._dropShadowOffsetAngle), 1),
      'flags.fa-nexus.shadowOffsetX': this._roundShadowValue(offsetVec.x, 2),
      'flags.fa-nexus.shadowOffsetY': this._roundShadowValue(offsetVec.y, 2)
    };
    this._applyHsbcToTileUpdate(payload);

    if (placedWidth !== null) payload.width = placedWidth;
    if (placedHeight !== null) payload.height = placedHeight;
    if (Number.isFinite(rotation)) payload.rotation = rotation;
    payload['texture.scaleX'] = flipState.horizontal ? -1 : 1;
    payload['texture.scaleY'] = flipState.vertical ? -1 : 1;

    const applyUpdates = canvas.scene.updateEmbeddedDocuments('Tile', [payload], { diff: false })
      .then((updated) => {
        const nextDoc = (Array.isArray(updated) && updated[0]) ? updated[0] : doc;
        if (this._isEditingExistingTile && nextDoc) this._editingTile = nextDoc;
        if (this.currentAsset && nextDoc) {
          try {
            this.currentAsset.width = nextDoc.width;
            this.currentAsset.height = nextDoc.height;
            const sceneGridSize = Number(canvas?.scene?.grid?.size || 100) || 100;
            const gw = Number(nextDoc.width || 0) / sceneGridSize;
            const gh = Number(nextDoc.height || 0) / sceneGridSize;
            if (Number.isFinite(gw) && gw > 0) this.currentAsset.grid_width = gw;
            if (Number.isFinite(gh) && gh > 0) this.currentAsset.grid_height = gh;
            this.currentAsset.actual_width = nextDoc.width;
            this.currentAsset.actual_height = nextDoc.height;
          } catch (_) {}
        }
        try {
          const manager = getAssetShadowManager(this.app);
          const elevation = Number((nextDoc && nextDoc.elevation) ?? doc.elevation ?? 0) || 0;
          manager?._scheduleRebuild?.(elevation, true);
        } catch (_) {}
        this._refreshShadowElevationContext({ adopt: false, sync: true });
      })
      .catch((error) => {
        try { Logger.warn('Placement.editTile.update.failed', String(error?.message || error)); }
        catch (_) {}
      });
    if (applyUpdates?.catch) applyUpdates.catch(() => {});
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
    const container = group?.container;
    if (!container) return;
    const primary = canvas?.primary;
    const tilesSortLayer = (() => {
      try { return primary?.constructor?.SORT_LAYERS?.TILES ?? 0; }
      catch (_) { return 0; }
    })();
    container.sortLayer = tilesSortLayer;
    const nextSort = Number.isFinite(group?.sort) ? group.sort : 0;
    container.sort = nextSort;
    container.faNexusSort = nextSort;
    const elevation = Number.isFinite(group?.elevation) ? group.elevation : 0;
    const renderElevation = getTileRenderElevation(elevation);
    container.faNexusElevationDoc = elevation;
    container.faNexusElevation = renderElevation;
    container.elevation = renderElevation;
    if (container.parent === canvas?.stage) container.zIndex = SCATTER_PREVIEW_Z_INDEX;
    else if (container.parent) container.zIndex = 0;
    const parent = container.parent;
    if (parent && 'sortDirty' in parent) parent.sortDirty = true;
    parent?.sortChildren?.();
  }

  _syncScatterPreviewOrdering() {
    try {
      const key = this._getScatterPreviewGroupKey(this._previewElevation);
      let group = this._scatterPreviewGroups.get(key);
      if (!group && this.isPlacementActive && this._scatterMode === ASSET_SCATTER_MODE_BRUSH && this._scatterMergeEnabled) {
        this._ensureScatterPreviewOverlay();
        group = this._scatterPreviewGroups.get(key);
      }
      if (!group) {
        this._scatterPreviewContainer = null;
        this._scatterPreviewActiveKey = null;
        this._syncScatterPreviewFlags();
        return;
      }
      if (Number.isFinite(this._previewSort)) group.sort = this._previewSort;
      this._scatterPreviewContainer = group.container;
      this._scatterPreviewActiveKey = key;
      this._applyScatterPreviewOrdering(group);
      this._syncScatterPreviewFlags();
    } catch (_) {}
  }

  _syncPreviewOrdering() {
    try {
      if (this._previewContainer) {
        const controller = this._interactionController;
        const nextSort = controller.computeNextSortAtElevation?.(this._previewElevation) ?? this._previewSort;
        this._previewSort = nextSort;
        this._previewContainer.sort = nextSort;
        this._previewContainer.faNexusSort = nextSort;
        const renderElevation = getTileRenderElevation(this._previewElevation);
        this._previewContainer.faNexusElevationDoc = this._previewElevation;
        this._previewContainer.faNexusElevation = renderElevation;
        this._previewContainer.elevation = renderElevation;
        const parent = this._previewContainer.parent;
        if (parent && 'sortDirty' in parent) parent.sortDirty = true;
        parent?.sortChildren?.();
      }
      this._syncScatterPreviewOrdering();
    } catch (_) {}
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
    const baseMessage = 'Click to place. Tap S to toggle grid snap and hold S while scrolling to change subgrid density. Ctrl/Cmd+Wheel rotates (Shift=1°). Alt+Wheel or Alt+[ / ] / Alt+Up / Down adjust elevation (default 0.01, Shift 0.1, Ctrl/Cmd 0.001). Shift+Wheel scales preview. Right-click or ESC to cancel.';
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
    try {
      const sm = Number(this._previewContainer?._scaleMul || this.currentScale || 1) || 1;
      let worldWidth = null;
      let worldHeight = null;
      if (this._previewContainer) {
        const tw = Number(this._previewContainer._tileWidth || 0);
        const th = Number(this._previewContainer._tileHeight || 0);
        const gsf = Number(this._previewContainer._gridScaleFactor || 1);
        if (tw && th) {
          worldWidth = tw * gsf * sm;
          worldHeight = th * gsf * sm;
          if (this._previewContainer._sprite) {
            this._previewContainer._sprite.width = worldWidth;
            this._previewContainer._sprite.height = worldHeight;
          }
        }
      }
      if ((!worldWidth || !worldHeight) && this.currentAsset) {
        const dims = this._computeWorldSizeForAsset(this.currentAsset, sm);
        worldWidth = dims.worldWidth;
        worldHeight = dims.worldHeight;
      }
      if (!worldWidth || !worldHeight) return;
      this._applyPendingFlipToPreview({ syncShadow: false });
      this._updateLoadingOverlaySize(worldWidth, worldHeight);
      this._updatePreviewShadow();
      this._scheduleShadowOffsetPreviewUpdate();
    } catch (_) { /* no-op */ }
  }

  _startZoomWatcher() {
    try {
      this._stopZoomWatcher();
      const loop = () => {
        if (!this.isPlacementActive) { this._zoomWatcherId = null; return; }
        const z = canvas?.stage?.scale?.x || 1;
        if (z !== this._lastZoom) {
          this._lastZoom = z;
          this._applyZoomToPreview(z);
        }
        if (this._previewFrozen) this._refreshFrozenPointerScreen();
        this._zoomWatcherId = window.requestAnimationFrame(loop);
      };
      this._lastZoom = canvas?.stage?.scale?.x || 1;
      if (this._previewFrozen) this._refreshFrozenPointerScreen();
      this._zoomWatcherId = window.requestAnimationFrame(loop);
    } catch (_) { /* no-op */ }
  }

  _stopZoomWatcher() {
    try {
      if (this._zoomWatcherId) {
        window.cancelAnimationFrame(this._zoomWatcherId);
        this._zoomWatcherId = null;
      }
    } catch (_) { /* no-op */ }
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
    const next = this._pickRandomAsset();
    if (!next) return;
    // If cloud and not cached, fetch now before preview
    if (String(next.source || '').toLowerCase() === 'cloud' && !next.cachedLocalPath) {
      this.isDownloading = true;
      const dims = this._computeWorldSizeForAsset(next, this._getPendingScale());
      this._removePreviewElement();
      this._showLoadingOverlay(dims);
      try {
        await this._ensureAssetLocal(next);
      } catch (e) {
        Logger.warn('Placement.lazyPrime.failed', String(e?.message || e));
      }
    }
    this.currentAsset = next;
    const lastWorld = this._getPreviewAnchorWorld(null, { includeToolOptions: true });
    const lastScreen = (() => {
      if (this._previewFrozen && this._frozenPointerScreen && Number.isFinite(this._frozenPointerScreen.x) && Number.isFinite(this._frozenPointerScreen.y)) {
        return { x: this._frozenPointerScreen.x, y: this._frozenPointerScreen.y };
      }
      return this._lastPointer || null;
    })();
    this._removePreviewElement();
    this._hideLoadingOverlay();
    this._createPreviewElement();
    this._applyPendingRotationToPreview();
    this._applyPendingScaleToPreview();
    this._applyPendingFlipToPreview({ forceShadow: true });
    try {
      let world = null;
      if (lastWorld) {
        world = lastWorld;
      } else if (lastScreen) {
        world = this._screenToCanvas(lastScreen.x, lastScreen.y);
      }
      if (world && this._previewContainer) {
        this._applyPreviewAnchor(world);
      }
    } catch (_) {}
    this.isDownloading = false;
    // Refill prefetch queue for smoother next placements
    try { this._randomPrefetch?.prime?.(this.currentAsset); } catch (_) {}
    // If user clicked during download, place now at queued coords
    await this._flushQueuedPlacement();
  }

  _updateGridCardDownloaded(filePath, localPath) {
    try {
      if (!filePath || !this.app?.element) return;
      const grid = this.app.element.querySelector('#fa-nexus-grid');
      if (!grid) return;
      const sel = `.fa-nexus-card[data-file-path="${CSS.escape(String(filePath))}"]`;
      const card = grid.querySelector(sel) || grid.querySelector(`.fa-nexus-card[data-filename="${CSS.escape(String((filePath||'').split('/').pop()||''))}"]`);
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
    return String(asset?.file_path || asset?.path || asset?.filename || '').toLowerCase();
  }
}
