import { onFoundryBoot } from '../core/foundry-boot-hooks.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { prepareLocalCompositionShadows } from './asset-shadow-local-composition.js';
import { gatherBuildingLoops } from '../buildings/building-shape-helpers.js';
import { BuildingWallMesher } from '../buildings/building-wall-mesher.js';
import { resolveBuildingV2RootFrameOffset } from '../buildings/v2/building-v2-root-frame.js';
import {
  createBuildingV2SpatialTransform,
  deriveBuildingV2SpatialPose
} from '../buildings/v2/building-v2-spatial-transform.js';
import { onCanvasReady } from '../canvas/canvas-readiness.js';
import { getCurrentViewedLevelIds } from '../canvas/elevation-band-utils.js';
import { getFaNexusPlacementOcclusionDefaults } from '../canvas/tile-document-payloads.js';
import { getRawLevelIds } from '../canvas/tile-level-membership.js';
import { resolveTileRenderOrder } from '../canvas/tile-band-utils.js';
import { loadFoundryTexture } from '../core/foundry-texture-cache.js';
import {
  clearSharedTextureCache,
  getFlattenedChunkEntries
} from '../textures/texture-runtime-core.js';
import {
  applyStandardTileMaskToTile,
  rehydrateAllMaskedTiles
} from '../textures/texture-mask-runtime.js';
import { getStandardMaskCustomBaseKey } from '../textures/standard-mask-custom-base.js';
import { readShadowQualityConfig } from './shadow-quality.js';
import {
  AssetShadowRebuildWorkflow,
  buildLayerShadowRenderInputs
} from './asset-shadow-rebuild-workflow.js';
import { AssetShadowRenderWorkflow } from './asset-shadow-render-workflow.js';
import { AssetShadowRenderPrimitives } from './asset-shadow-render-primitives.js';
import { AssetShadowOcclusionRuntime } from './asset-shadow-occlusion-runtime.js';
import { AssetShadowTileLifecycleWorkflow } from './asset-shadow-tile-lifecycle-workflow.js';
import { getAssetShadowPreviewSuppressionController } from './asset-shadow-preview-suppression.js';
import {
  applyAssetShadowElevationSettings,
  getAssetShadowElevationSettings
} from './asset-shadow-elevation-settings.js';
import {
  clearAssetScatterCache,
  rehydrateAllAssetScatterTiles
} from './asset-scatter-geometry.js';
import { resolveScatterInstanceAffine } from './asset-scatter-instance-transform.js';
import {
  SCATTER_SHADOW_CHUNK_BLEED,
  SCATTER_SHADOW_MAX_DIMENSION,
  buildScatterDilationOffsets,
  buildScatterShadowSignature,
  computeScatterBounds,
  computeScatterInstanceBounds,
  computeScatterShadowInstanceLimit,
  computeScatterShadowScale,
  expandBounds,
  inflateWorldBounds,
  mergeWorldBounds,
  normalizeWorldBounds,
  planLayerShadowRenderChunks,
  rectFromWorldBounds,
  rectsIntersect,
  resolveScatterShadowChunks,
  sampleScatterShadowInstances,
  shadowRenderProfileKey,
  worldBoundsIntersect
} from './asset-shadow-bounds.js';
import {
  computeSamplesFromPoints as computePathSamples,
  computeBoundsFromSamples as computePathBounds,
  computePathShadowPoints,
  loadPathTexture,
  clearPathTextureCache,
  rehydrateAllPathTiles,
  DEFAULT_SEGMENT_SAMPLES as PATH_DEFAULT_SEGMENT_SAMPLES,
  MIN_POINTS_TO_RENDER as PATH_MIN_POINTS
} from '../paths/path-geometry.js';

const SHADOW_BLUR_QUALITY_MIN = 3;
const SHADOW_BLUR_QUALITY_STEP = 4;
const SHADOW_BLUR_QUALITY_MAX = 9;
const MODULE_ID = 'fa-nexus';
const LAYER_HIDDEN_FLAG = 'layerHidden';
const SCATTER_FLAG_KEY = 'assetScatter';
const STANDARD_TILE_MASK_FLAG = 'standardTileMask';
const SCATTER_VERSION = 1;

let _singleton = null;
// Allow generous range so wall/window shadows can reuse wall shadow offsets (±5 grid @200px ≈ 1000px).
const MAX_OFFSET_DISTANCE = 1200;
const SHADOW_BLANK_RECOVERY_COOLDOWN_MS = 10_000;
const SHADOW_BLANK_VALIDATION_BUDGET = 12;
const SHADOW_RENDERER_RECOVERY_DEBOUNCE_MS = 1_000;
const LOCAL_BUILDING_SHADOW_TEXTURE_POOL_LIMIT = 2;

function logShadowLifecycleFailure(event, error, details = {}) {
  Logger.warn('AssetShadow.lifecycle.failed', {
    event,
    error: String(error?.message || error),
    ...details
  });
}

function normalizeLayerOpacity(value, fallback = 1) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.min(1, Math.max(0, numeric));
  const fallbackNumeric = Number(fallback);
  if (Number.isFinite(fallbackNumeric)) return Math.min(1, Math.max(0, fallbackNumeric));
  return 1;
}

/**
 * Manages aggregated drop-shadow render layers for FA Nexus asset tiles.
 * Collects shadow-capable tile flags by elevation and renders shared blurred masks
 * slightly below the tile layer.
 */
export class AssetShadowManager {
  /**
   * @param {import('../nexus-app.js').FaNexusApp} app
   */
  constructor(app) {
    if (_singleton) return _singleton;
    this.app = app;
    this._rebuildWorkflow = new AssetShadowRebuildWorkflow(this);
    this._renderWorkflow = new AssetShadowRenderWorkflow(this);
    this._renderPrimitives = new AssetShadowRenderPrimitives(this);
    this._occlusionRuntime = new AssetShadowOcclusionRuntime(this);
    this._tileLifecycleWorkflow = new AssetShadowTileLifecycleWorkflow(this);
    this._layers = new Map();
    this._tileIndex = new Map(); // tile id -> shadow layer key
    this._textureCache = new Map();
    this._scatterShadowCache = new Map();
    this._standardMaskShadowCache = new Map();
    this._localBuildingShadowTexturePool = new Map();
    this._localBuildingShadowTexturePoolTimer = null;
    this._localBuildingShadowDescriptorBySectionId = new Map();
    this._renderer = null;
    this._hooksBound = false;
    this._suspendedTiles = new Map(); // tile id -> { doc, layerKey }
    this._previewSuppressionController = getAssetShadowPreviewSuppressionController(this);
    this._sceneRect = { x: 0, y: 0, width: 0, height: 0 };
    this._options = {
      alpha: 0.65,
      dilation: 1.6,
      blur: 1.8,
      offsetDistance: 0,
      offsetAngle: 135,
      debounce: 2
    };
    this._buildingShadowMaterial = null;
    this._sceneId = null;
    this._sceneGeneration = 0;
    this._levelScopeWarnings = new Set();
    this._rendererContextView = null;
    this._rendererContextRunner = null;
    this._pixiContextRecoveryTarget = null;
    this._blankLayerRecoveryActive = false;
    this._blankLayerRecoveryCooldownUntil = 0;
    this._blankRenderValidationBudget = 0;
    this._rendererRecoveryCooldownUntil = 0;
    this._previewShadowOverrides = new Map();
    this._previewElevationOverrides = new Map();

    this._bindHooks();
    this._updateRenderer();
    _singleton = this;
  }

  static getInstance(app) {
    if (_singleton) {
      if (app && !_singleton.app) _singleton.app = app;
      return _singleton;
    }
    return new AssetShadowManager(app);
  }

  static peek() {
    return _singleton;
  }

  registerTile(tileDocument) {
    try {
      const doc = tileDocument?.document ?? tileDocument;
      if (!doc || !this._isActiveSceneDocument(doc, { phase: 'registerTile' }) || !this._isShadowRenderableTile(doc, { phase: 'registerTile' })) return;
      if (this._suspendedTiles.has(doc.id)) this._suspendedTiles.delete(doc.id);
      this._addTile(doc);
    } catch (e) {
      Logger.warn('AssetShadow.registerTile.failed', String(e?.message || e));
    }
  }

  /** Clear all layers and rebuild from the current scene */
  refreshAll() {
    try {
      this._onCanvasReady();
    } catch (e) {
      Logger.warn('AssetShadow.refreshAll.failed', String(e?.message || e));
    }
  }

  prepareForSceneTransitionCapture() {
    return this._tileLifecycleWorkflow.prepareForSceneTransitionCapture();
  }

  /** Bind Foundry canvas hooks once */
  _bindHooks() {
    if (this._hooksBound) return;
    this._hooksBound = true;
    this._boundCanvasReady = () => this._onCanvasReady();
    this._boundCanvasTearDown = () => this._onCanvasTearDown();
    this._boundCreateTile = (doc) => this._onCreateTile(doc);
    this._boundUpdateTile = (doc, changes) => this._onUpdateTile(doc, changes);
    this._boundDeleteTile = (doc) => this._onDeleteTile(doc);
    this._boundCanvasPan = () => this._onCanvasPan();
    this._boundScatterCacheReady = (tile) => this._onScatterCacheReady(tile);
    this._boundElevationBandChanged = () => {
      try {
        for (const layer of this._layers.values()) this._syncLayerOrdering(layer);
        const parent = this._getCanvasParent();
        if (parent) parent.sortDirty = true;
      } catch (error) {
        logShadowLifecycleFailure('elevation-band-sync', error);
      }
    };

    const hooks = globalThis?.Hooks;
    try { onCanvasReady(this._boundCanvasReady, { hooks }); }
    catch (error) { logShadowLifecycleFailure('canvas-ready-registration', error); }
    if (hooks && typeof hooks.on === 'function') {
      try { hooks.on('createTile', this._boundCreateTile); }
      catch (error) { logShadowLifecycleFailure('hook-registration', error, { hook: 'createTile' }); }
      try { hooks.on('updateTile', this._boundUpdateTile); }
      catch (error) { logShadowLifecycleFailure('hook-registration', error, { hook: 'updateTile' }); }
      try { hooks.on('deleteTile', this._boundDeleteTile); }
      catch (error) { logShadowLifecycleFailure('hook-registration', error, { hook: 'deleteTile' }); }
      try { hooks.on('canvasTearDown', this._boundCanvasTearDown); }
      catch (error) { logShadowLifecycleFailure('hook-registration', error, { hook: 'canvasTearDown' }); }
      try { hooks.on('canvasPan', this._boundCanvasPan); }
      catch (error) { logShadowLifecycleFailure('hook-registration', error, { hook: 'canvasPan' }); }
      try { hooks.on('fa-nexus-token-elevation-offset-changed', this._boundElevationBandChanged); }
      catch (error) { logShadowLifecycleFailure('hook-registration', error, { hook: 'fa-nexus-token-elevation-offset-changed' }); }
      try { hooks.on('fa-nexus-asset-scatter-cache-ready', this._boundScatterCacheReady); }
      catch (error) { logShadowLifecycleFailure('hook-registration', error, { hook: 'fa-nexus-asset-scatter-cache-ready' }); }
    }
  }

  _updateRenderer() {
    try {
      this._renderer = canvas?.app?.renderer || null;
    } catch (_) {
      this._renderer = null;
    }
    this._bindRendererContextRecovery();
  }

  _bindRendererContextRecovery() {
    try {
      const renderer = this._renderer || canvas?.app?.renderer || null;
      const view = canvas?.app?.view || renderer?.view || canvas?.app?.canvas || null;
      if (view && this._rendererContextView !== view) {
        this._unbindRendererViewContextRecovery();
        this._boundWebglContextLost = this._boundWebglContextLost || ((event) => {
          try { event?.preventDefault?.(); } catch (_) {}
          Logger.warn('AssetShadow.webglContextLost', {
            sceneId: this._sceneId || this._getActiveSceneId(),
            generation: this._sceneGeneration
          });
        });
        this._boundWebglContextRestored = this._boundWebglContextRestored || (() => {
          this._recoverRendererResources('webglcontextrestored');
        });
        try { view.addEventListener?.('webglcontextlost', this._boundWebglContextLost, false); }
        catch (error) { logShadowLifecycleFailure('webglcontextlost-registration', error); }
        try { view.addEventListener?.('webglcontextrestored', this._boundWebglContextRestored, false); }
        catch (error) { logShadowLifecycleFailure('webglcontextrestored-registration', error); }
        this._rendererContextView = view;
      }

      const runner = renderer?.runners?.contextChange || null;
      if (runner && this._rendererContextRunner !== runner) {
        this._unbindPixiContextRecovery();
        this._pixiContextRecoveryTarget = this._pixiContextRecoveryTarget || {
          contextChange: () => this._recoverRendererResources('pixi-contextChange')
        };
        try {
          runner.add?.(this._pixiContextRecoveryTarget);
          this._rendererContextRunner = runner;
        } catch (error) {
          logShadowLifecycleFailure('pixi-contextChange-registration', error);
        }
      }
    } catch (error) {
      logShadowLifecycleFailure('renderer-context-registration', error);
    }
  }

  _unbindRendererViewContextRecovery() {
    const view = this._rendererContextView;
    if (!view) return;
    try {
      if (this._boundWebglContextLost) view.removeEventListener?.('webglcontextlost', this._boundWebglContextLost, false);
    } catch (_) {}
    try {
      if (this._boundWebglContextRestored) view.removeEventListener?.('webglcontextrestored', this._boundWebglContextRestored, false);
    } catch (_) {}
    this._rendererContextView = null;
  }

  _unbindPixiContextRecovery() {
    try {
      if (this._rendererContextRunner && this._pixiContextRecoveryTarget) {
        this._rendererContextRunner.remove?.(this._pixiContextRecoveryTarget);
      }
    } catch (_) {}
    this._rendererContextRunner = null;
  }

  _recoverRendererResources(reason = 'unknown') {
    try {
      const now = Date.now();
      if (now < this._rendererRecoveryCooldownUntil) {
        Logger.debug?.('AssetShadow.rendererResources.recoveryDebounced', {
          reason,
          sceneId: this._sceneId || this._getActiveSceneId(),
          generation: this._sceneGeneration
        });
        return;
      }
      this._rendererRecoveryCooldownUntil = now + SHADOW_RENDERER_RECOVERY_DEBOUNCE_MS;
      Logger.warn('AssetShadow.rendererResources.recovering', {
        reason,
        sceneId: this._sceneId || this._getActiveSceneId(),
        generation: this._sceneGeneration
      });
      this._clearSourceTextureCache(reason, {
        includeSharedRuntime: true,
        resetPrograms: true
      });
      try { this._clearScatterShadowCache(); } catch (_) {}
      try { this._clearStandardMaskShadowCache(); } catch (_) {}
      try { rehydrateAllPathTiles?.(); }
      catch (error) { logShadowLifecycleFailure('path-rehydrate-after-context-recovery', error, { reason }); }
      try { rehydrateAllAssetScatterTiles?.(); }
      catch (error) { logShadowLifecycleFailure('scatter-rehydrate-after-context-recovery', error, { reason }); }
      try { rehydrateAllMaskedTiles?.({ reason: `asset-shadow-${reason}` }); }
      catch (error) { logShadowLifecycleFailure('masked-rehydrate-after-context-recovery', error, { reason }); }
      this._blankLayerRecoveryCooldownUntil = Math.max(this._blankLayerRecoveryCooldownUntil, now + SHADOW_BLANK_RECOVERY_COOLDOWN_MS);
      this.refreshAll();
    } catch (error) {
      Logger.error('AssetShadow.rendererResources.recoveryFailed', {
        reason,
        error: String(error?.message || error)
      });
    }
  }

  _getActiveSceneId() {
    try {
      const id = canvas?.scene?.id ?? game?.scenes?.current?.id ?? null;
      return id ? String(id) : null;
    } catch (_) {
      return null;
    }
  }

  _getDocumentSceneId(doc) {
    try {
      const id = doc?.parent?.id ?? doc?.scene?.id ?? null;
      return id ? String(id) : null;
    } catch (_) {
      return null;
    }
  }

  _isCurrentSceneScope(generation = this._sceneGeneration, sceneId = this._sceneId || this._getActiveSceneId()) {
    const activeSceneId = this._sceneId || this._getActiveSceneId();
    return generation === this._sceneGeneration
      && !!sceneId
      && !!activeSceneId
      && String(sceneId) === String(activeSceneId)
      && !!canvas?.ready;
  }

  _isActiveSceneDocument(doc, { phase = 'unknown', log = true } = {}) {
    if (!doc) return false;
    const activeSceneId = this._sceneId || this._getActiveSceneId();
    const docSceneId = this._getDocumentSceneId(doc);
    if (!activeSceneId || !docSceneId) {
      if (log) {
        Logger.debug?.('AssetShadow.sceneOwnership.missing', {
          phase,
          tileId: doc?.id || null,
          activeSceneId,
          docSceneId
        });
      }
      return false;
    }
    if (docSceneId === activeSceneId) return true;
    if (log) {
      Logger.debug?.('AssetShadow.foreignSceneDocument.ignored', {
        phase,
        tileId: doc?.id || null,
        activeSceneId,
        docSceneId
      });
    }
    return false;
  }

  _onCanvasReady() {
    return this._tileLifecycleWorkflow.onCanvasReady();
  }

  _onCanvasTearDown() {
    return this._tileLifecycleWorkflow.onCanvasTearDown();
  }

  _onCreateTile(doc) {
    return this._tileLifecycleWorkflow.onCreateTile(doc);
  }

  _onUpdateTile(doc, changes = {}) {
    return this._tileLifecycleWorkflow.onUpdateTile(doc, changes);
  }

  _onDeleteTile(doc) {
    return this._tileLifecycleWorkflow.onDeleteTile(doc);
  }

  _onCanvasPan() {
    try {
      for (const layer of this._layers.values()) {
        this._syncShadowLayerFilters(layer);
      }
    } catch (e) {
      Logger.warn('AssetShadow.onCanvasPan.failed', String(e?.message || e));
    }
  }

  _onScatterCacheReady(tile) {
    try {
      const doc = tile?.document ?? tile;
      const tileId = doc?.id;
      if (!tileId) return;
      const layerKey = this._tileIndex.get(tileId);
      if (!layerKey) return;
      this._clearScatterShadowCache(tileId);
      this._scheduleRebuild(layerKey);
    } catch (e) {
      Logger.warn('AssetShadow.scatterCacheReady.failed', String(e?.message || e));
    }
  }

  _addTile(doc, { deferRebuild = false } = {}) {
    return this._tileLifecycleWorkflow.addTile(doc, { deferRebuild });
  }

  _removeTile(doc) {
    return this._tileLifecycleWorkflow.removeTile(doc);
  }

  suspendTile(tileDocument) {
    return this._tileLifecycleWorkflow.suspendTile(tileDocument);
  }

  async suspendTileAndWait(tileDocument, options = {}) {
    const doc = tileDocument?.document ?? tileDocument;
    const layerKey = doc?.id ? this._tileIndex.get(doc.id) : undefined;
    const suspended = this.suspendTile(doc);
    if (!suspended) return false;
    if (layerKey !== undefined && this._layers.has(layerKey)) {
      try {
        await this.waitForRebuilds([layerKey], options);
      } catch (error) {
        try {
          const resumed = this.resumeTile(doc);
          if (resumed !== true) {
            throw new Error(`Asset Shadow could not resume Tile ${doc?.id || 'unknown'} after suspension rebuild failure.`);
          }
        } catch (resumeError) {
          throw new AggregateError(
            [error, resumeError],
            'Asset Shadow suspension rebuild failed and the Tile could not be resumed.'
          );
        }
        throw error;
      }
    }
    return true;
  }

  resumeTile(tileDocument, options = {}) {
    return this._tileLifecycleWorkflow.resumeTile(tileDocument, options);
  }

  suspendRebuilds() {
    return this._rebuildWorkflow.suspend();
  }

  resumeRebuilds({ immediate = false } = {}) {
    return this._rebuildWorkflow.resume({ immediate });
  }

  waitForRebuilds(targets, options = {}) {
    return this._rebuildWorkflow.waitFor(targets, options);
  }

  prepareLocalCompositionShadows(documents, pivot) {
    return prepareLocalCompositionShadows(this, documents, pivot);
  }

  beginTransformPreviewSuppression({ documents = [], source = 'unknown', operation = 'suppress', pivot = null } = {}) {
    return this._previewSuppressionController.begin({ documents, source, operation, pivot });
  }

  /**
   * Prepare a client-local translation/rotation/uniform-scale preview for one committed render chunk.
   * The original chunk remains visible while both partitions rasterize. The
   * returned owner activates them atomically, transforms only the selected
   * partition, and destroys every temporary GPU resource on release. Rotation
   * and scale are intentionally cached-bitmap approximations: baked effects
   * transform with the bitmap until the authoritative rebuild on pointer-up.
   */
  async prepareTransformPreviewShadowSplit({
    sessionId = 'unknown',
    layerKey = 'unknown',
    layer = null,
    chunk = null,
    movingTileIds = []
  } = {}) {
    if (!layer || !chunk || chunk?.sprite?.destroyed) {
      throw new Error(`Asset shadow preview chunk ${layerKey}/${chunk?.key || 'unknown'} is unavailable.`);
    }
    const generation = this._sceneGeneration;
    const sceneId = this._sceneId || this._getActiveSceneId();
    const assertCurrentPreviewScope = () => {
      const layerIsCurrent = Array.from(this._layers.values()).includes(layer);
      if (
        !this._isCurrentSceneScope(generation, sceneId)
        || !layerIsCurrent
        || layer?.container?.destroyed
        || chunk?.sprite?.destroyed
        || layer?.renderChunks?.get?.(chunk.key) !== chunk
      ) {
        const error = new Error(`Asset shadow preview chunk ${layerKey}/${chunk?.key || 'unknown'} left its canvas scope.`);
        error.faNexusStalePreview = true;
        throw error;
      }
    };
    assertCurrentPreviewScope();
    this._updateRenderer();
    const renderer = this._renderer;
    if (!renderer) throw new Error('Asset shadow preview renderer is unavailable.');

    const selectedIds = new Set(Array.from(movingTileIds || []).map(String).filter(Boolean));
    const sourceDocs = Array.from(chunk.tileIds || [])
      .map((id) => layer.tiles?.get?.(id) || layer.tiles?.get?.(String(id)) || null)
      .filter(Boolean);
    const docs = sourceDocs.map((doc) => (
      typeof doc?.clone === 'function' ? doc.clone({}, { keepId: true }) : doc
    ));
    this._sortLayerShadowDocs(docs);
    const { tileConfigs } = buildLayerShadowRenderInputs(this, docs, layer);
    const chunkEntryKeys = chunk.shadowEntryKeys instanceof Set ? chunk.shadowEntryKeys : new Set();
    const chunkProfileKey = shadowRenderProfileKey(chunk.options || {}, this._options);
    const chunkEntries = chunkEntryKeys.size
      ? tileConfigs.filter((entry) => chunkEntryKeys.has(String(entry?.shadowEntryKey || '')))
      : tileConfigs.filter((entry) => shadowRenderProfileKey(entry?.config || {}, this._options) === chunkProfileKey);
    const movingEntries = chunkEntries.filter((entry) => selectedIds.has(String(entry?.doc?.id || entry?.doc?._id || '')));
    const stationaryEntries = chunkEntries.filter((entry) => !selectedIds.has(String(entry?.doc?.id || entry?.doc?._id || '')));
    if (!movingEntries.length) {
      throw new Error(`Asset shadow preview chunk ${layerKey}/${chunk.key} contains no selected Tile entries.`);
    }

    const committedSceneRect = chunk.sceneRect ? { ...chunk.sceneRect } : null;
    const scale = Number(chunk.scale) || 1;
    if (!committedSceneRect) throw new Error(`Asset shadow preview chunk ${layerKey}/${chunk.key} has no render bounds.`);
    const options = {
      alpha: Number(chunk.options?.alpha ?? layer.options?.alpha ?? 0.35),
      blur: Number(chunk.options?.blur ?? layer.options?.blur ?? 0),
      maxDilation: Number(chunk.options?.maxDilation ?? layer.options?.maxDilation ?? 0)
    };

    const resolvePartitionSceneRect = (entries) => {
      let bounds = null;
      let maxOffsetX = 0;
      let maxOffsetY = 0;
      let maxDilation = 0;
      for (const entry of entries) {
        bounds = this._mergeWorldBounds(bounds, this._computeShadowEntryBounds(entry));
        maxOffsetX = Math.max(maxOffsetX, Math.abs(Number(entry?.config?.offsetX || 0)));
        maxOffsetY = Math.max(maxOffsetY, Math.abs(Number(entry?.config?.offsetY || 0)));
        maxDilation = Math.max(maxDilation, Number(entry?.config?.dilation || 0));
      }
      const padded = this._rectFromWorldBounds(bounds, 8) || committedSceneRect;
      return this._applyShadowMargins(padded, {
        offsetX: maxOffsetX,
        offsetY: maxOffsetY,
        dilation: maxDilation,
        blur: options.blur
      });
    };

    const createPartition = async (entries, kind) => {
      if (!entries.length) return null;
      assertCurrentPreviewScope();
      const sceneRect = resolvePartitionSceneRect(entries);
      const texWidth = Math.max(4, Math.round(sceneRect.width * scale));
      const texHeight = Math.max(4, Math.round(sceneRect.height * scale));
      if (!Number.isFinite(texWidth) || !Number.isFinite(texHeight)) {
        throw new Error(`Asset shadow ${kind} preview partition has invalid texture dimensions.`);
      }
      const target = this._createLayerRenderChunk(
        layer,
        `preview:${sessionId}:${chunk.key}:${kind}`
      );
      target.options = { ...options };
      target.tileIds = new Set(entries.map((entry) => String(entry?.doc?.id || entry?.doc?._id || '')).filter(Boolean));
      const tempDisplayObjects = [];
      const tempTextures = [];
      const tempTextureViews = [];
      let drawContainer = null;
      try {
        drawContainer = await this._buildLayerShadowDrawContainer(entries, {
          renderer,
          scale,
          sceneRect,
          tempDisplayObjects,
          tempTextures,
          tempTextureViews
        });
        assertCurrentPreviewScope();
        if (!drawContainer?.children?.length) {
          try { layer.container?.removeChild?.(target.sprite); } catch (_) {}
          this._destroyLayerRenderChunk(layer, target);
          return null;
        }
        const renderTexture = this._renderLayerToTexture(
          layer,
          drawContainer,
          renderer,
          texWidth,
          texHeight,
          { renderTarget: target, scale, layerOptions: options }
        );
        if (!renderTexture) {
          throw new Error(`Asset shadow ${kind} preview partition produced no render texture.`);
        }
        assertCurrentPreviewScope();
        const previousPrimary = layer.renderTexture;
        this._applyLayerChunkTexture(layer, target, sceneRect, renderTexture, scale);
        layer.renderTexture = previousPrimary;
        if (target.usesOcclusionMesh) {
          this._syncShadowOcclusionMeshRuntime(layer, target.sprite);
        } else {
          const occlusionFilter = this._ensureShadowOcclusionFilter(layer, target);
          target.sprite.filters = occlusionFilter && !occlusionFilter.destroyed
            ? [occlusionFilter]
            : null;
        }
        target.sprite.visible = false;
        target.sprite.renderable = false;
        target.sprite.name = `fa-nexus-shadow-preview:${sessionId}:${chunk.key}:${kind}`;
        target.sprite.faNexusShadowPreview = {
          sessionId: String(sessionId),
          sourceChunkKey: String(chunk.key),
          kind,
          tileIds: Array.from(target.tileIds).sort(),
          basePosition: {
            x: Number(target.sprite.position?.x) || 0,
            y: Number(target.sprite.position?.y) || 0
          },
          baseScale: {
            x: Number(target.sprite.scale?.x) || 1,
            y: Number(target.sprite.scale?.y) || 1
          }
        };
        return {
          target,
          baseX: Number(target.sprite.position?.x) || 0,
          baseY: Number(target.sprite.position?.y) || 0,
          baseScaleX: Number(target.sprite.scale?.x) || 1,
          baseScaleY: Number(target.sprite.scale?.y) || 1
        };
      } catch (error) {
        try { layer.container?.removeChild?.(target.sprite); } catch (_) {}
        this._destroyLayerRenderChunk(layer, target);
        throw error;
      } finally {
        for (const displayObject of tempDisplayObjects) {
          try { displayObject?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        }
        for (const texture of tempTextures) {
          try { texture?.destroy?.(true); } catch (_) {}
        }
        for (const texture of tempTextureViews) {
          try { texture?.destroy?.(false); } catch (_) {}
        }
        try { drawContainer?.destroy?.({ children: false }); } catch (_) {}
      }
    };

    let stationary = null;
    let moving = null;
    let destroyed = false;
    try {
      stationary = await createPartition(stationaryEntries, 'stationary');
      moving = await createPartition(movingEntries, 'moving');
      if (!stationary && !moving) {
        throw new Error(`Asset shadow preview chunk ${layerKey}/${chunk.key} produced no drawable partitions.`);
      }
    } catch (error) {
      for (const partition of [stationary, moving]) {
        if (!partition) continue;
        try { layer.container?.removeChild?.(partition.target.sprite); } catch (_) {}
        this._destroyLayerRenderChunk(layer, partition.target);
      }
      throw error;
    }

    const destroyPartition = (partition) => {
      if (!partition) return;
      try { layer.container?.removeChild?.(partition.target.sprite); } catch (_) {}
      this._destroyLayerRenderChunk(layer, partition.target);
    };
    return {
      activate() {
        if (destroyed) return false;
        for (const partition of [stationary, moving]) {
          const sprite = partition?.target?.sprite;
          if (!sprite || sprite.destroyed) continue;
          sprite.visible = true;
          sprite.renderable = true;
        }
        return true;
      },
      updateTranslation(delta = {}) {
        const sprite = moving?.target?.sprite;
        if (destroyed || !sprite || sprite.destroyed) return false;
        const x = Number(delta?.x);
        const y = Number(delta?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        sprite.position.set(moving.baseX + x, moving.baseY + y);
        return true;
      },
      updateRotation(transform = {}) {
        const sprite = moving?.target?.sprite;
        if (destroyed || !sprite || sprite.destroyed) return false;
        const angle = Number(transform?.angle);
        const pivotX = Number(transform?.pivot?.x);
        const pivotY = Number(transform?.pivot?.y);
        if (![angle, pivotX, pivotY].every(Number.isFinite)) return false;
        const localPivotX = (pivotX - moving.baseX) / moving.baseScaleX;
        const localPivotY = (pivotY - moving.baseY) / moving.baseScaleY;
        sprite.pivot.set(localPivotX, localPivotY);
        sprite.position.set(pivotX, pivotY);
        sprite.angle = angle;
        if (sprite.faNexusShadowPreview) {
          sprite.faNexusShadowPreview.rotationPreview = {
            angle,
            pivot: { x: pivotX, y: pivotY }
          };
        }
        return true;
      },
      updateScale(transform = {}) {
        const sprite = moving?.target?.sprite;
        if (destroyed || !sprite || sprite.destroyed) return false;
        const factor = Number(transform?.factor);
        const pivotX = Number(transform?.pivot?.x);
        const pivotY = Number(transform?.pivot?.y);
        if (!Number.isFinite(factor) || factor <= 0 || ![pivotX, pivotY].every(Number.isFinite)) return false;
        const localPivotX = (pivotX - moving.baseX) / moving.baseScaleX;
        const localPivotY = (pivotY - moving.baseY) / moving.baseScaleY;
        sprite.pivot.set(localPivotX, localPivotY);
        sprite.position.set(pivotX, pivotY);
        sprite.scale.set(moving.baseScaleX * factor, moving.baseScaleY * factor);
        if (sprite.faNexusShadowPreview) {
          sprite.faNexusShadowPreview.scalePreview = {
            factor,
            pivot: { x: pivotX, y: pivotY }
          };
        }
        return true;
      },
      destroy: () => {
        if (destroyed) return false;
        destroyed = true;
        destroyPartition(stationary);
        destroyPartition(moving);
        stationary = null;
        moving = null;
        return true;
      }
    };
  }

  getTransformPreviewSuppressionDiagnostics() {
    return this._previewSuppressionController.diagnostics();
  }

  _scheduleRebuild(target, immediate = false) {
    return this._rebuildWorkflow.schedule(target, immediate);
  }

  async _rebuildLayer(elevation, options = {}) {
    return this._rebuildWorkflow.rebuildLayer(elevation, options);
  }

  _sortLayerShadowDocs(docs = []) {
    if (!Array.isArray(docs) || docs.length < 2) return docs;
    const readOrder = (doc) => {
      let renderOrder = null;
      try { renderOrder = resolveTileRenderOrder(doc); } catch (_) { renderOrder = null; }
      return {
        sortLayer: Number(renderOrder?.sortLayer ?? 0) || 0,
        elevation: Number(renderOrder?.elevation ?? doc?.elevation ?? 0) || 0,
        sort: Number(renderOrder?.sort ?? doc?.sort ?? 0) || 0,
        documentSort: Number(doc?.sort ?? 0) || 0,
        id: String(doc?.id || doc?._id || '')
      };
    };
    docs.sort((a, b) => {
      const orderA = readOrder(a);
      const orderB = readOrder(b);
      const sortLayerDelta = orderA.sortLayer - orderB.sortLayer;
      if (Math.abs(sortLayerDelta) > 1e-9) return sortLayerDelta;
      const elevationDelta = orderA.elevation - orderB.elevation;
      if (Math.abs(elevationDelta) > 1e-9) return elevationDelta;
      const sortDelta = orderA.sort - orderB.sort;
      if (Math.abs(sortDelta) > 1e-9) return sortDelta;
      const documentSortDelta = orderA.documentSort - orderB.documentSort;
      if (Math.abs(documentSortDelta) > 1e-9) return documentSortDelta;
      return orderA.id.localeCompare(orderB.id);
    });
    return docs;
  }

  resolveStandardMaskPreviewConfig(doc, { phase = 'texture-mask-preview' } = {}) {
    try {
      if (!doc) return null;
      if (!this._isShadowRenderableTile(doc, { phase, log: false })) return null;
      const baseOptions = this._extractShadowBaseOptions(doc, { elevation: doc?.elevation });
      const tileOptions = this._extractTileShadowConfig(doc, baseOptions);
      const dilation = Math.max(0, Number(tileOptions?.dilation ?? baseOptions?.dilation ?? 0));
      return {
        alpha: Math.min(1, Math.max(0, Number(baseOptions?.alpha ?? 0.65))),
        blur: Math.max(0, Number(baseOptions?.blur ?? 0)),
        dilation,
        offsetX: Number(tileOptions?.offsetX ?? baseOptions?.offsetX ?? 0) || 0,
        offsetY: Number(tileOptions?.offsetY ?? baseOptions?.offsetY ?? 0) || 0
      };
    } catch (error) {
      Logger.warn('AssetShadow.standardMaskPreview.configFailed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }

  computeStandardMaskPreviewBlurQuality(blurPixels) {
    return this._computeBlurQuality(blurPixels);
  }

  _resolveStandardMaskPreviewDocBounds(doc) {
    try {
      const { width, height } = this._getDocDimensions(doc);
      const pivotLocal = this._getDocPivotLocal(doc, { anchorMode: 'doc' });
      const pivotWorld = this._getDocPivotWorld(doc, { anchorMode: 'doc' });
      const rotation = (Number(doc?.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const corners = [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height }
      ];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const corner of corners) {
        const dx = Number(corner.x || 0) - Number(pivotLocal.x || 0);
        const dy = Number(corner.y || 0) - Number(pivotLocal.y || 0);
        const x = Number(pivotWorld.x || 0) + (dx * cos) - (dy * sin);
        const y = Number(pivotWorld.y || 0) + (dx * sin) + (dy * cos);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
      return { x: minX, y: minY, minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
    } catch (_) {
      return null;
    }
  }

  _expandStandardMaskPreviewBounds(rect, bounds) {
    try {
      if (!bounds) return rect;
      const minX = Number.isFinite(bounds.minX) ? Number(bounds.minX) : Number(bounds.x);
      const minY = Number.isFinite(bounds.minY) ? Number(bounds.minY) : Number(bounds.y);
      const maxX = Number.isFinite(bounds.maxX) ? Number(bounds.maxX) : (Number(bounds.x) + Number(bounds.width));
      const maxY = Number.isFinite(bounds.maxY) ? Number(bounds.maxY) : (Number(bounds.y) + Number(bounds.height));
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return rect;
      if (!rect) return { x: minX, y: minY, minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
      const nextMinX = Math.min(Number(rect.minX ?? rect.x ?? 0), minX);
      const nextMinY = Math.min(Number(rect.minY ?? rect.y ?? 0), minY);
      const nextMaxX = Math.max(Number(rect.maxX ?? ((rect.x ?? 0) + (rect.width ?? 0))), maxX);
      const nextMaxY = Math.max(Number(rect.maxY ?? ((rect.y ?? 0) + (rect.height ?? 0))), maxY);
      return {
        x: nextMinX,
        y: nextMinY,
        minX: nextMinX,
        minY: nextMinY,
        maxX: nextMaxX,
        maxY: nextMaxY,
        width: Math.max(1, nextMaxX - nextMinX),
        height: Math.max(1, nextMaxY - nextMinY)
      };
    } catch (_) {
      return rect;
    }
  }

  _resolveStandardMaskPreviewSceneRect(doc, descriptors = [], config = {}) {
    let rect = this._resolveStandardMaskPreviewDocBounds(doc)
      || { x: Number(doc?.x || 0) || 0, y: Number(doc?.y || 0) || 0, width: Math.max(1, Number(doc?.width || 1)), height: Math.max(1, Number(doc?.height || 1)) };
    for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
      if (descriptor?.bounds) rect = this._expandStandardMaskPreviewBounds(rect, descriptor.bounds);
    }
    const descriptorDilation = (Array.isArray(descriptors) ? descriptors : [])
      .reduce((max, descriptor) => Math.max(max, Number(descriptor?.shadowDilation || 0)), 0);
    const expanded = this._applyShadowMargins(rect, {
      offsetX: Math.abs(Number(config.offsetX || 0)),
      offsetY: Math.abs(Number(config.offsetY || 0)),
      dilation: Math.max(Number(config.dilation || 0), descriptorDilation),
      blur: Number(config.blur || 0)
    });
    const x = Math.floor(Number(expanded?.x || 0));
    const y = Math.floor(Number(expanded?.y || 0));
    const width = Math.max(1, Math.ceil(Number(expanded?.width || 1)));
    const height = Math.max(1, Math.ceil(Number(expanded?.height || 1)));
    return { x, y, width, height, minX: x, minY: y, maxX: x + width, maxY: y + height };
  }

  _ensureStandardMaskPreviewRenderTexture(renderTexture, width, height) {
    const safeWidth = Math.max(4, Math.round(Number(width || 0) || 4));
    const safeHeight = Math.max(4, Math.round(Number(height || 0) || 4));
    if (renderTexture && !renderTexture.destroyed && renderTexture.width === safeWidth && renderTexture.height === safeHeight) {
      return renderTexture;
    }
    try { renderTexture?.destroy?.(true); } catch (_) {}
    return PIXI.RenderTexture.create({
      width: safeWidth,
      height: safeHeight,
      resolution: 1,
      scaleMode: PIXI.SCALE_MODES.LINEAR
    });
  }

  async renderStandardMaskPreviewComposite({
    doc,
    renderer = this._renderer,
    config = {},
    standardMaskStamp = null,
    sourceStamp = null,
    renderTexture = null
  } = {}) {
    const drawContainer = new PIXI.Container();
    const tempObjects = [drawContainer];
    const tempTextures = [];
    let targetTexture = renderTexture || null;
    try {
      if (!doc || !renderer || !standardMaskStamp?.texture) return { rendered: false, texture: targetTexture };
      const descriptors = (this._resolveShadowPathDescriptors(doc) || []).filter(Boolean);
      const sceneRect = this._resolveStandardMaskPreviewSceneRect(doc, descriptors, config || {});
      if (!sceneRect) return { rendered: false, texture: targetTexture };
      const scale = this._computeTextureScale(sceneRect);
      const texWidth = Math.max(4, Math.round(sceneRect.width * scale));
      const texHeight = Math.max(4, Math.round(sceneRect.height * scale));
      const offsetXScaled = (Number(config.offsetX || 0) || 0) * scale;
      const offsetYScaled = (Number(config.offsetY || 0) || 0) * scale;
      drawContainer.eventMode = 'none';
      drawContainer.sortableChildren = false;
      drawContainer.interactiveChildren = false;

      if (descriptors.length) {
        const descriptorDilation = descriptors.reduce((max, descriptor) => Math.max(max, Number(descriptor?.shadowDilation || 0)), 0);
        const pathMaskedSpread = descriptors.some((descriptor) => descriptor?.kind !== 'building')
          ? Math.max(Number(config.dilation || 0), descriptorDilation)
          : 0;
        const maskedStamp = await this._createMaskedDescriptorShadowStamp(doc, descriptors, standardMaskStamp, renderer, {
          scale,
          applyMask: true,
          dilation: pathMaskedSpread
        });
        if (!maskedStamp?.texture) return { rendered: false, texture: targetTexture, sceneRect, scale };
        tempTextures.push(maskedStamp.texture);
        const offsets = pathMaskedSpread > 0
          ? [{ x: 0, y: 0 }]
          : this._buildDilationOffsets(Math.max(Number(config.dilation || 0), descriptorDilation) * scale);
        for (const offset of offsets) {
          const sprite = this._createWorldBoundsShadowSprite(maskedStamp.texture, maskedStamp.bounds, {
            scale,
            sceneRect,
            offsetX: (Number(offset?.x || 0) || 0) + offsetXScaled,
            offsetY: (Number(offset?.y || 0) || 0) + offsetYScaled
          });
          if (!sprite) continue;
          drawContainer.addChild(sprite);
          tempObjects.push(sprite);
        }
      } else {
        if (!sourceStamp?.texture) {
          return { rendered: false, needsSourceStamp: true, texture: targetTexture, sceneRect, scale };
        }
        const offsets = this._buildDilationOffsets(Math.max(0, Number(config.dilation || 0)) * scale);
        const texScaleX = Number(doc?.texture?.scaleX ?? 1) || 1;
        const texScaleY = Number(doc?.texture?.scaleY ?? 1) || 1;
        const sourceBounds = sourceStamp.bounds || standardMaskStamp.bounds || { x: 0, y: 0, width: 1, height: 1 };
        for (const offset of offsets) {
          const sprite = this._createDocShadowSprite(sourceStamp.texture, doc, sourceBounds, {
            scale,
            sceneRect,
            offsetX: (Number(offset?.x || 0) || 0) + offsetXScaled,
            offsetY: (Number(offset?.y || 0) || 0) + offsetYScaled,
            flipX: texScaleX,
            flipY: texScaleY,
            anchorMode: 'doc'
          });
          if (!sprite) continue;
          drawContainer.addChild(sprite);
          tempObjects.push(sprite);
        }
      }

      if (!drawContainer.children?.length) return { rendered: false, texture: targetTexture, sceneRect, scale };
      targetTexture = this._ensureStandardMaskPreviewRenderTexture(targetTexture, texWidth, texHeight);
      if (!targetTexture) return { rendered: false, texture: targetTexture, sceneRect, scale };
      renderer.render(drawContainer, { renderTexture: targetTexture, clear: true });
      return { rendered: true, texture: targetTexture, sceneRect, scale };
    } catch (error) {
      Logger.warn('AssetShadow.standardMaskPreview.compositeFailed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return { rendered: false, texture: targetTexture };
    } finally {
      for (const object of tempObjects) {
        try {
          if (object && object !== drawContainer && !object.destroyed) object.destroy({ children: true, texture: false, baseTexture: false });
        } catch (_) {}
      }
      try { drawContainer.destroy({ children: false }); } catch (_) {}
      for (const texture of tempTextures) {
        try { texture?.destroy?.(true); } catch (_) {}
      }
    }
  }

  _getShadowQualityConfig() {
    return readShadowQualityConfig();
  }

  async _buildLayerShadowDrawContainer(entries, context = {}) {
    return this._renderWorkflow.buildLayerDrawContainer(entries, context);
  }

  _renderLayerToTexture(layer, drawContainer, renderer, texWidth, texHeight, context = {}) {
    return this._renderWorkflow.renderLayerToTexture(layer, drawContainer, renderer, texWidth, texHeight, context);
  }

  _isLayerRenderTextureBlank(renderTexture, renderer, context = {}) {
    return this._renderWorkflow.isLayerRenderTextureBlank(renderTexture, renderer, context);
  }

  _handleBlankLayerRender(elevation, details = {}) {
    return this._renderWorkflow.handleBlankLayerRender(elevation, details);
  }

  _applyLayerTexture(layer, sceneRect, renderTexture, scale) {
    return this._renderWorkflow.applyLayerTexture(layer, sceneRect, renderTexture, scale);
  }

  _applyLayerChunkTexture(layer, chunk, sceneRect, renderTexture, scale) {
    return this._renderWorkflow.applyLayerChunkTexture(layer, chunk, sceneRect, renderTexture, scale);
  }

  _buildLayerShadowRenderChunks(tileConfigs, { fallbackRect = null, layerOptions = {} } = {}) {
    try {
      const entries = Array.isArray(tileConfigs) ? tileConfigs.filter((entry) => entry?.doc) : [];
      if (!entries.length) return [];
      const entryPlans = entries.map((entry) => ({
        entry,
        bounds: this._computeShadowEntryBounds(entry)
      }));
      return planLayerShadowRenderChunks(entryPlans, {
        fallbackRect,
        layerOptions,
        defaultOptions: this._options
      });
    } catch (error) {
      Logger.warn('AssetShadow.renderChunks.failed', String(error?.message || error));
      const rect = fallbackRect || this._getSceneRect();
      return [{
        key: 'fallback',
        entries: Array.isArray(tileConfigs) ? tileConfigs.filter((entry) => entry?.doc) : [],
        bounds: rect,
        alpha: Math.min(1, Math.max(0, Number(layerOptions.alpha ?? this._options.alpha ?? 0.65))),
        blur: Math.max(0, Number(layerOptions.blur ?? this._options.blur ?? 0)),
        maxOffsetX: Math.abs(Number(layerOptions.maxOffsetX || 0)),
        maxOffsetY: Math.abs(Number(layerOptions.maxOffsetY || 0)),
        maxDilation: Math.max(0, Number(layerOptions.maxDilation || 0))
      }];
    }
  }

  _shadowRenderProfileKey(options = {}) {
    return shadowRenderProfileKey(options, this._options);
  }

  _computeShadowEntryBounds(entry) {
    try {
      if (!entry?.doc) return null;
      let bounds = this._computeTileBounds(entry.doc);
      const descriptors = Array.isArray(entry.paths) ? entry.paths : [];
      for (const descriptor of descriptors) {
        const descriptorBounds = this._normalizeWorldBounds(descriptor?.bounds);
        if (descriptorBounds) bounds = this._mergeWorldBounds(bounds, descriptorBounds);
      }
      return bounds;
    } catch (_) {
      return null;
    }
  }

  _normalizeWorldBounds(bounds) {
    return normalizeWorldBounds(bounds);
  }

  _mergeWorldBounds(a, b) {
    return mergeWorldBounds(a, b);
  }

  _inflateWorldBounds(bounds, options = {}) {
    return inflateWorldBounds(bounds, options);
  }

  _worldBoundsIntersect(a, b) {
    return worldBoundsIntersect(a, b);
  }

  _rectFromWorldBounds(bounds, pad = 0) {
    return rectFromWorldBounds(bounds, pad);
  }

  _extractShadowBaseOptions(doc, { elevation = null } = {}) {
    const targetElevation = Number(elevation ?? doc?.elevation ?? 0);
    const previewOverride = this._getElevationPreviewShadowOverride(targetElevation);
    const defaults = {
      alpha: Math.min(1, Math.max(0, Number(previewOverride?.alpha ?? this._options.alpha ?? 0.65))),
      blur: Math.max(0, Number(previewOverride?.blur ?? this._options.blur ?? 0)),
      dilation: Math.max(0, Number(this._options.dilation ?? 0)),
      offsetDistance: Math.min(MAX_OFFSET_DISTANCE, Math.max(0, Number(this._options.offsetDistance ?? 0))),
      offsetAngle: this._normalizeAngle(this._options.offsetAngle ?? 135)
    };

    const independentPortalShadow = this._getIndependentBuildingPortalShadow(doc);
    let buildingWallShadowEnabled = false;
    try {
      const building = doc?.getFlag?.('fa-nexus', 'building')
        || doc?.flags?.['fa-nexus']?.building
        || doc?._source?.flags?.['fa-nexus']?.building;
      buildingWallShadowEnabled = building?.wall?.pathShadow?.enabled === true;
    } catch (_) {}
    if (independentPortalShadow && !buildingWallShadowEnabled && !previewOverride) {
      return {
        alpha: independentPortalShadow.alpha,
        blur: independentPortalShadow.blur,
        dilation: 0,
        offsetDistance: 0,
        offsetAngle: 135,
        offsetX: 0,
        offsetY: 0
      };
    }

    const read = (key) => this._readTileShadowNumber(doc, key);

    const alpha = (() => {
      if (previewOverride && Number.isFinite(Number(previewOverride.alpha))) {
        return Math.min(1, Math.max(0, Number(previewOverride.alpha)));
      }
      const value = read('shadowAlpha');
      return value !== undefined ? Math.min(1, Math.max(0, value)) : defaults.alpha;
    })();

    const blur = (() => {
      if (previewOverride && Number.isFinite(Number(previewOverride.blur))) {
        return Math.max(0, Number(previewOverride.blur));
      }
      const value = read('shadowBlur');
      return value !== undefined ? Math.max(0, value) : defaults.blur;
    })();

    const dilation = (() => {
      const value = read('shadowDilation');
      return value !== undefined ? Math.max(0, value) : defaults.dilation;
    })();

    let offsetDistance = (() => {
      const value = read('shadowOffsetDistance');
      return value !== undefined
        ? Math.min(MAX_OFFSET_DISTANCE, Math.max(-MAX_OFFSET_DISTANCE, value))
        : defaults.offsetDistance;
    })();

    let offsetAngle = (() => {
      const value = read('shadowOffsetAngle');
      return value !== undefined ? this._normalizeAngle(value) : defaults.offsetAngle;
    })();

    let offsetX = read('shadowOffsetX');
    let offsetY = read('shadowOffsetY');
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
      const vec = this._computeOffsetVector(offsetDistance, offsetAngle);
      offsetX = vec.x;
      offsetY = vec.y;
    } else {
      offsetDistance = Math.min(MAX_OFFSET_DISTANCE, Math.hypot(offsetX, offsetY));
      offsetAngle = this._normalizeAngle(Math.atan2(offsetY, offsetX) * (180 / Math.PI));
      offsetX = Math.max(-MAX_OFFSET_DISTANCE, Math.min(MAX_OFFSET_DISTANCE, offsetX));
      offsetY = Math.max(-MAX_OFFSET_DISTANCE, Math.min(MAX_OFFSET_DISTANCE, offsetY));
    }

    return {
      alpha,
      blur,
      dilation,
      offsetDistance,
      offsetAngle,
      offsetX,
      offsetY
    };
  }

  _extractTileShadowConfig(doc, defaults) {
    const base = defaults || this._extractShadowBaseOptions(null);
    const read = (key) => this._readTileShadowNumber(doc, key);

    let dilation = (() => {
      const value = read('shadowDilation');
      return value !== undefined ? Math.max(0, value) : Math.max(0, base.dilation);
    })();
    const usesGeometryDilation = this._usesBuildingShadowGeometry(doc);
    if (usesGeometryDilation) dilation = 0;

    let offsetDistance = (() => {
      const value = read('shadowOffsetDistance');
      return value !== undefined
        ? Math.min(MAX_OFFSET_DISTANCE, Math.max(-MAX_OFFSET_DISTANCE, value))
        : Math.min(MAX_OFFSET_DISTANCE, Math.max(-MAX_OFFSET_DISTANCE, base.offsetDistance));
    })();

    let offsetAngle = (() => {
      const value = read('shadowOffsetAngle');
      return value !== undefined ? this._normalizeAngle(value) : this._normalizeAngle(base.offsetAngle);
    })();

    let offsetX = read('shadowOffsetX');
    let offsetY = read('shadowOffsetY');
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
      const vec = this._computeOffsetVector(offsetDistance, offsetAngle);
      offsetX = vec.x;
      offsetY = vec.y;
    } else {
      offsetDistance = Math.min(MAX_OFFSET_DISTANCE, Math.hypot(offsetX, offsetY));
      offsetAngle = this._normalizeAngle(Math.atan2(offsetY, offsetX) * (180 / Math.PI));
    }
    offsetX = Math.max(-MAX_OFFSET_DISTANCE, Math.min(MAX_OFFSET_DISTANCE, Number(offsetX || 0)));
    offsetY = Math.max(-MAX_OFFSET_DISTANCE, Math.min(MAX_OFFSET_DISTANCE, Number(offsetY || 0)));

    return {
      dilation,
      offsetDistance,
      offsetAngle,
      offsetX,
      offsetY
    };
  }

  _usesBuildingShadowGeometry(doc) {
    try {
      const building = doc?.getFlag?.('fa-nexus', 'building');
      return !!building?.wall?.pathShadow?.enabled;
    } catch (_) {
      return false;
    }
  }

  _getIndependentBuildingPortalShadow(doc) {
    try {
      const building = doc?.getFlag?.('fa-nexus', 'building')
        || doc?.flags?.['fa-nexus']?.building
        || doc?._source?.flags?.['fa-nexus']?.building;
      const shadows = (building?.runtime?.portalArtwork || [])
        .filter((portal) => portal?.kind === 'window-surface'
          && portal?.shadow?.enabled !== false
          && Array.isArray(portal?.artwork)
          && portal.artwork.length > 0)
        .map((portal) => portal.shadow)
        .filter((shadow) => Number(shadow?.alpha) > 0.001);
      if (!shadows.length) return null;
      return {
        alpha: Math.max(...shadows.map((shadow) => Math.min(1, Math.max(0, Number(shadow.alpha) || 0)))),
        blur: Math.max(...shadows.map((shadow) => Math.min(20, Math.max(0, Number(shadow.blur) || 0))))
      };
    } catch (_) {
      return null;
    }
  }

  _resolveShadowPathDescriptors(doc) {
    const descriptors = [];
    try {
      const pathDescriptors = this._resolvePathShadowDescriptorsFromPath(doc);
      if (Array.isArray(pathDescriptors) && pathDescriptors.length) {
        descriptors.push(...pathDescriptors);
      }
    } catch (_) {}
    try {
      const buildingDescriptors = this._resolveBuildingShadowDescriptors(doc);
      if (Array.isArray(buildingDescriptors) && buildingDescriptors.length) {
        descriptors.push(...buildingDescriptors);
      }
    } catch (_) {}
    try {
      const compositeDescriptors = this._resolveBuildingCompositeShadowDescriptors(doc);
      if (Array.isArray(compositeDescriptors) && compositeDescriptors.length) {
        descriptors.push(...compositeDescriptors);
      }
    } catch (_) {}
    return descriptors;
  }

  _readBuildingCompositePayload(doc) {
    try {
      const direct = doc?.getFlag?.(MODULE_ID, 'buildingComposite');
      if (direct) return direct;
    } catch (_) {}
    try {
      const sills = doc?.getFlag?.(MODULE_ID, 'buildingSills');
      if (sills) return { ...sills, role: 'sill' };
    } catch (_) {}
    const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
    if (flags?.buildingComposite) return flags.buildingComposite;
    return flags?.buildingSills ? { ...flags.buildingSills, role: 'sill' } : null;
  }

  _getBuildingCompositeShadowParts(doc) {
    const composite = this._readBuildingCompositePayload(doc);
    const parts = Array.isArray(composite?.parts) ? composite.parts : [];
    if (!parts.length) return [];
    const compositeRole = String(composite?.role || '').toLowerCase();
    return parts.filter((part) => {
      if (!part || typeof part !== 'object') return false;
      const flags = part.flags && typeof part.flags === 'object' ? part.flags : {};
      if (!flags.shadow) return false;
      const kind = String(part.kind || part.elementType || '').toLowerCase();
      const role = String(part.role || '').toLowerCase();
      return compositeRole === 'sill'
        || role === 'sill'
        || kind === 'sill'
        || part.flagKey === 'buildingWindowSill';
    });
  }

  _hasBuildingCompositeSillShadowParts(doc) {
    return this._getBuildingCompositeShadowParts(doc).length > 0;
  }

  _readBuildingCompositeShadowNumber(doc, key) {
    for (const part of this._getBuildingCompositeShadowParts(doc)) {
      const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
      if (!Object.prototype.hasOwnProperty.call(flags, key)) continue;
      const numeric = Number(flags[key]);
      if (Number.isFinite(numeric)) return numeric;
    }
    return undefined;
  }

  _resolveBuildingCompositePartShadowConfig(part = {}) {
    const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
    const config = {};
    const read = (key) => {
      if (!Object.prototype.hasOwnProperty.call(flags, key) || flags[key] === null) return undefined;
      const numeric = Number(flags[key]);
      return Number.isFinite(numeric) ? numeric : undefined;
    };
    const alpha = read('shadowAlpha');
    const blur = read('shadowBlur');
    const dilation = read('shadowDilation');

    let offsetX = read('shadowOffsetX');
    let offsetY = read('shadowOffsetY');
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
      const distance = read('shadowOffsetDistance');
      const angle = read('shadowOffsetAngle');
      if (Number.isFinite(distance) && Number.isFinite(angle)) {
        const vector = this._computeOffsetVector(distance, angle);
        offsetX = vector.x;
        offsetY = vector.y;
      }
    }
    if (![alpha, blur, dilation, offsetX, offsetY].every(Number.isFinite)) return null;
    config.alpha = Math.min(1, Math.max(0, alpha));
    config.blur = Math.max(0, blur);
    config.dilation = Math.max(0, dilation);
    config.offsetX = Math.max(-MAX_OFFSET_DISTANCE, Math.min(MAX_OFFSET_DISTANCE, offsetX));
    config.offsetY = Math.max(-MAX_OFFSET_DISTANCE, Math.min(MAX_OFFSET_DISTANCE, offsetY));
    return config;
  }

  _getBuildingCompositePartTextureSrc(part = {}) {
    const texture = part?.texture && typeof part.texture === 'object' ? part.texture : {};
    const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
    const typedFlag = part?.flagKey ? (flags?.[part.flagKey] || {}) : {};
    return texture.src
      || part.textureSrc
      || typedFlag.sourceTextureLocal
      || typedFlag.sourceTextureKey
      || '';
  }

  _computeBuildingCompositePartBounds(part = {}) {
    const x = Number(part?.x);
    const y = Number(part?.y);
    const width = Math.max(1, Number(part?.width) || 0);
    const height = Math.max(1, Number(part?.height) || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !width || !height) return null;
    const rotation = (Number(part?.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const corners = [
      { x: -halfWidth, y: -halfHeight },
      { x: halfWidth, y: -halfHeight },
      { x: halfWidth, y: halfHeight },
      { x: -halfWidth, y: halfHeight }
    ].map((corner) => ({
      x: x + (corner.x * cos) - (corner.y * sin),
      y: y + (corner.x * sin) + (corner.y * cos)
    }));
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  _resolveBuildingCompositeShadowDescriptors(doc) {
    const descriptors = [];
    try {
      const parts = this._getBuildingCompositeShadowParts(doc);
      for (const part of parts) {
        const textureSrc = this._getBuildingCompositePartTextureSrc(part);
        const bounds = this._computeBuildingCompositePartBounds(part);
        if (!textureSrc || !bounds) continue;
        const texture = part?.texture && typeof part.texture === 'object' ? part.texture : {};
        descriptors.push({
          kind: 'buildingCompositeSprite',
          textureSrc,
          x: Number(part.x) || 0,
          y: Number(part.y) || 0,
          width: Math.max(1, Number(part.width) || 1),
          height: Math.max(1, Number(part.height) || 1),
          rotation: (Number(part.rotation || 0) * Math.PI) / 180,
          flipX: Number(texture.scaleX ?? 1) < 0 ? -1 : 1,
          flipY: Number(texture.scaleY ?? 1) < 0 ? -1 : 1,
          bounds,
          shadowDilation: Math.max(0, Number(part?.flags?.shadowDilation || 0)),
          alphaMultiplier: normalizeLayerOpacity(part.alpha, 1),
          shadowConfig: this._resolveBuildingCompositePartShadowConfig(part)
        });
      }
    } catch (error) {
      Logger.warn('AssetShadow.buildingCompositeDescriptor.failed', String(error?.message || error));
    }
    return descriptors;
  }

  _readScatterPayload(doc) {
    try {
      const direct = doc?.getFlag?.('fa-nexus', SCATTER_FLAG_KEY);
      if (direct !== undefined) return direct;
    } catch (_) {}
    const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
    return flags ? flags[SCATTER_FLAG_KEY] : null;
  }

  _resolveScatterInstances(doc) {
    try {
      const payload = this._readScatterPayload(doc);
      if (!payload || typeof payload !== 'object') return [];
      const version = Number(payload.version || SCATTER_VERSION);
      if (version !== SCATTER_VERSION) return [];
      const raw = Array.isArray(payload.instances) ? payload.instances : [];
      if (!raw.length) return [];
      return raw
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => {
          const normalized = {
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
    } catch (_) {
      return [];
    }
  }

  _buildScatterShadowSignature(instances, cfg, scale, extra = null) {
    return buildScatterShadowSignature(instances, cfg, scale, extra);
  }

  _getScatterShadowBounds(doc, instances) {
    try {
      const docWidth = Math.max(1, Number(doc?.width || 0));
      const docHeight = Math.max(1, Number(doc?.height || 0));
      if (Number.isFinite(docWidth) && Number.isFinite(docHeight) && docWidth > 0 && docHeight > 0) {
        return {
          minX: 0,
          minY: 0,
          maxX: docWidth,
          maxY: docHeight,
          width: docWidth,
          height: docHeight
        };
      }
    } catch (_) {}
    return this._computeScatterBounds(instances);
  }

  _computeScatterShadowScale(baseScale, bounds) {
    return computeScatterShadowScale(baseScale, bounds, {
      maxTextureSize: this._getMaxTextureSize(),
      maxDimension: SCATTER_SHADOW_MAX_DIMENSION
    });
  }

  _computeScatterShadowInstanceLimit(offsetCount) {
    return computeScatterShadowInstanceLimit(offsetCount);
  }

  _sampleScatterShadowInstances(instances, limit) {
    return sampleScatterShadowInstances(instances, limit);
  }

  _buildScatterDilationOffsets(radius, instanceCount = 0) {
    return buildScatterDilationOffsets(radius, instanceCount);
  }

  _computeScatterInstanceBounds(instance) {
    return computeScatterInstanceBounds(instance);
  }

  _computeScatterBounds(instances) {
    return computeScatterBounds(instances);
  }

  _rectsIntersect(a, b) {
    return rectsIntersect(a, b);
  }

  _expandBounds(bounds, amount = 0) {
    return expandBounds(bounds, amount);
  }

  _resolveScatterShadowChunks(bounds, renderScale) {
    return resolveScatterShadowChunks(bounds, renderScale, {
      maxTextureSize: this._getMaxTextureSize(),
      maxDimension: SCATTER_SHADOW_MAX_DIMENSION,
      bleedPixels: SCATTER_SHADOW_CHUNK_BLEED
    });
  }

  _clearSourceTextureCache(reason = 'unknown', options = {}) {
    const includeSharedRuntime = !!options?.includeSharedRuntime;
    const resetPrograms = !!options?.resetPrograms;
    const result = {
      managerTextureCount: 0,
      pathTextureCount: null,
      sharedTextureCount: null
    };
    try {
      result.managerTextureCount = Number(this._textureCache?.size || 0);
      this._textureCache?.clear?.();
    } catch (error) {
      logShadowLifecycleFailure('source-texture-cache-clear', error, { reason });
    }

    if (includeSharedRuntime) {
      try { result.pathTextureCount = clearPathTextureCache?.({ resetProgram: resetPrograms }); }
      catch (error) { logShadowLifecycleFailure('path-texture-cache-clear', error, { reason }); }
      try { clearAssetScatterCache?.(); }
      catch (error) { logShadowLifecycleFailure('scatter-texture-cache-clear', error, { reason }); }
      try { result.sharedTextureCount = clearSharedTextureCache?.(); }
      catch (error) { logShadowLifecycleFailure('shared-texture-cache-clear', error, { reason }); }
    }

    if (resetPrograms && this._buildingShadowMaterial) {
      try { this._buildingShadowMaterial.destroy?.(); } catch (_) {}
      this._buildingShadowMaterial = null;
    }

    Logger.debug?.('AssetShadow.sourceTextureCache.cleared', {
      reason,
      includeSharedRuntime,
      resetPrograms,
      ...result
    });
    return result;
  }

  _clearScatterShadowCache(tileId = null) {
    try {
      const destroyEntry = (entry) => {
        if (!entry) return;
        if (entry.ownsTextures === false) return;
        if (entry.texture && !entry.texture.destroyed) {
          try { entry.texture.destroy(true); } catch (_) {}
        }
        if (Array.isArray(entry.chunks)) {
          for (const chunk of entry.chunks) {
            if (chunk?.texture && !chunk.texture.destroyed) {
              try { chunk.texture.destroy(true); } catch (_) {}
            }
          }
        }
      };
      if (!tileId) {
        for (const entry of this._scatterShadowCache.values()) {
          destroyEntry(entry);
        }
        this._scatterShadowCache.clear();
        return;
      }
      const entry = this._scatterShadowCache.get(tileId);
      if (!entry) return;
      destroyEntry(entry);
      this._scatterShadowCache.delete(tileId);
    } catch (_) {}
  }

  _isScatterShadowCacheEntryLive(entry) {
    if (!entry) return false;
    const isLiveTexture = (texture) => !!texture && !texture.destroyed && !texture.baseTexture?.destroyed;
    if (entry.texture) return isLiveTexture(entry.texture);
    if (Array.isArray(entry.chunks) && entry.chunks.length) {
      return entry.chunks.every((chunk) => isLiveTexture(chunk?.texture));
    }
    return false;
  }

  _getRuntimeScatterContainer(doc) {
    try {
      const tileId = doc?.id || doc?._id;
      if (!tileId) return null;
      const placeables = canvas?.tiles?.placeables;
      if (!Array.isArray(placeables)) return null;
      const tile = placeables.find((entry) => entry?.document?.id === tileId);
      if (!tile || tile.destroyed) return null;
      return tile.faNexusAssetScatterContainer || tile.mesh?.faNexusAssetScatterContainer || null;
    } catch (_) {
      return null;
    }
  }

  _getRuntimeScatterShadowStamp(doc, cfg, scale, offsets, instanceCount = 0) {
    try {
      const tileId = doc?.id || doc?._id;
      if (!tileId) return null;
      const container = this._getRuntimeScatterContainer(doc);
      if (!container || container.destroyed || !container.faNexusAssetScatterCached) return null;

      const sourceSprites = Array.isArray(container.faNexusAssetScatterCacheSprites)
        ? container.faNexusAssetScatterCacheSprites
        : (container.faNexusAssetScatterCacheSprite ? [container.faNexusAssetScatterCacheSprite] : []);
      if (!sourceSprites.length) return null;

      const chunks = [];
      const textureKeys = [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (let i = 0; i < sourceSprites.length; i += 1) {
        const sprite = sourceSprites[i];
        if (!sprite || sprite.destroyed) continue;
        const texture = sprite.texture;
        const baseTexture = texture?.baseTexture;
        if (!texture || texture.destroyed || baseTexture?.destroyed) continue;
        const chunk = sprite.faNexusAssetScatterCacheChunk || {};
        const x = Number(chunk.x ?? sprite.x ?? 0) || 0;
        const y = Number(chunk.y ?? sprite.y ?? 0) || 0;
        const width = Math.max(1, Number(chunk.width ?? sprite.width ?? texture.width ?? 0) || 0);
        const height = Math.max(1, Number(chunk.height ?? sprite.height ?? texture.height ?? 0) || 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue;

        chunks.push({
          texture,
          bounds: { x, y, width, height }
        });
        textureKeys.push(`${baseTexture?.uid ?? texture.uid ?? i}:${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}`);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
      }

      if (!chunks.length) return null;

      const safeScale = Number(scale) || 1;
      const signature = JSON.stringify({
        kind: 'runtime-cache',
        tileId,
        contentVersion: Number(container.faNexusAssetScatterContentVersion) || 0,
        cacheMode: String(container.faNexusAssetScatterCacheMode || ''),
        cacheKey: String(container.faNexusAssetScatterCacheKey || ''),
        instanceCount: Number(instanceCount) || 0,
        chunkCount: chunks.length,
        textureKeys,
        dilation: Math.round((Number(cfg?.dilation) || 0) * 1000) / 1000,
        scale: Math.round(safeScale * 10000) / 10000,
        offsets: Array.isArray(offsets) ? offsets.length : 0
      });

      const cached = this._scatterShadowCache.get(tileId);
      if (cached && cached.signature === signature && this._isScatterShadowCacheEntryLive(cached)) {
        return cached;
      }
      if (cached) this._clearScatterShadowCache(tileId);

      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        minX = 0;
        minY = 0;
        maxX = Math.max(1, Number(doc?.width || 0));
        maxY = Math.max(1, Number(doc?.height || 0));
      }

      const entry = {
        signature,
        texture: chunks.length === 1 ? chunks[0].texture : null,
        chunks,
        bounds: {
          x: minX,
          y: minY,
          width: Math.max(1, maxX - minX),
          height: Math.max(1, maxY - minY)
        },
        scale: safeScale,
        offsets: Array.isArray(offsets) && offsets.length
          ? offsets.map((offset) => ({
            x: Number(offset?.x || 0) || 0,
            y: Number(offset?.y || 0) || 0
          }))
          : [{ x: 0, y: 0 }],
        ownsTextures: false,
        source: 'runtime-cache'
      };
      this._scatterShadowCache.set(tileId, entry);
      Logger.debug?.('AssetShadow.scatterShadow.runtimeCache', {
        tileId,
        instances: Number(instanceCount) || 0,
        chunks: chunks.length,
        offsets: entry.offsets.length,
        scale: safeScale
      });
      return entry;
    } catch (error) {
      Logger.warn?.('AssetShadow.scatterShadow.runtimeCacheFailed', {
        tileId: doc?.id || doc?._id || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }

  _clearStandardMaskShadowCache(tileId = null) {
    try {
      if (!this._standardMaskShadowCache) this._standardMaskShadowCache = new Map();
      if (!tileId) {
        for (const entry of this._standardMaskShadowCache.values()) {
          if (entry?.texture && !entry.texture.destroyed) {
            try { entry.texture.destroy(true); } catch (_) {}
          }
        }
        this._standardMaskShadowCache.clear();
        return;
      }
      const entry = this._standardMaskShadowCache.get(tileId);
      if (entry?.texture && !entry.texture.destroyed) {
        try { entry.texture.destroy(true); } catch (_) {}
      }
      this._standardMaskShadowCache.delete(tileId);
    } catch (_) {}
  }

  _readStandardTileMask(doc) {
    try {
      const direct = doc?.getFlag?.('fa-nexus', STANDARD_TILE_MASK_FLAG);
      if (direct !== undefined) return direct;
    } catch (_) {}
    const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
    return flags ? flags[STANDARD_TILE_MASK_FLAG] : null;
  }

  _buildStandardMaskShadowSignature(doc, flags) {
    try {
      const anchor = this._getDocAnchor(doc, { anchorMode: 'doc' });
      const chunkKey = (() => {
        const chunks = Array.isArray(getFlattenedChunkEntries?.(doc)) ? getFlattenedChunkEntries(doc) : [];
        if (!chunks.length) return null;
        return chunks.map((chunk) => `${chunk.src}|${chunk.x}|${chunk.y}|${chunk.width}|${chunk.height}`).join(';');
      })();
      const payload = {
        src: String(doc?.texture?.src || ''),
        customBase: getStandardMaskCustomBaseKey(doc) || null,
        mask: String(flags?.maskShapeKey || flags?.maskSrc || ''),
        maskVersion: Number(flags?.maskVersion || 1),
        maskCrop: flags?.maskCrop || null,
        maskOriginalSize: flags?.maskOriginalSize || null,
        width: Math.round(Number(doc?.width || 0)),
        height: Math.round(Number(doc?.height || 0)),
        rotation: Math.round((Number(doc?.rotation || 0) || 0) * 1000) / 1000,
        anchorX: Math.round((Number(anchor?.x || 0) || 0) * 1000) / 1000,
        anchorY: Math.round((Number(anchor?.y || 0) || 0) * 1000) / 1000,
        flipX: Number(doc?.texture?.scaleX ?? 1) < 0 ? -1 : 1,
        flipY: Number(doc?.texture?.scaleY ?? 1) < 0 ? -1 : 1,
        flattenedChunks: chunkKey
      };
      return JSON.stringify(payload);
    } catch (_) {
      return '';
    }
  }

  _resolveStandardMaskOverlay(tile) {
    const sourceContainer = tile?.mesh?.faNexusStandardMaskContainer
      || tile?.faNexusStandardMaskContainer
      || null;
    const sourceBase = sourceContainer?.faNexusBaseDisplayObject
      || sourceContainer?.faNexusBaseSprite
      || null;
    const sourceMask = sourceContainer?.faNexusMaskSprite || null;
    return { sourceContainer, sourceBase, sourceMask };
  }

  async _waitForStandardMaskOverlay(tile, { tileId = null, attempts = 6, interval = 120 } = {}) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let overlay = this._resolveStandardMaskOverlay(tile);
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      if (
        overlay.sourceContainer
        && !overlay.sourceContainer.destroyed
        && overlay.sourceBase
        && !overlay.sourceBase.destroyed
        && overlay.sourceMask
        && !overlay.sourceMask.destroyed
      ) return overlay;
      if (attempt >= attempts) break;
      await wait(interval);
      if (attempt === Math.floor(attempts / 2)) {
        try { await applyStandardTileMaskToTile(tile); }
        catch (error) {
          Logger.warn('AssetShadow.standardTileMask.overlayRetryFailed', {
            tileId,
            attempt,
            error: String(error?.message || error)
          });
        }
      }
      overlay = this._resolveStandardMaskOverlay(tile);
    }
    return overlay;
  }
  async _getStandardMaskClipStamp(doc, renderer) {
    return this._renderPrimitives.getStandardMaskClipStamp(doc, renderer);
  }
  async _getStandardMaskShadowStamp(doc, renderer) {
    return this._renderPrimitives.getStandardMaskShadowStamp(doc, renderer);
  }

  _getDescriptorShadowBounds(descriptors = []) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
      const bounds = descriptor?.bounds || null;
      if (!bounds) continue;
      if (Number.isFinite(bounds.minX)) minX = Math.min(minX, bounds.minX);
      else if (Number.isFinite(bounds.x)) minX = Math.min(minX, bounds.x);
      if (Number.isFinite(bounds.minY)) minY = Math.min(minY, bounds.minY);
      else if (Number.isFinite(bounds.y)) minY = Math.min(minY, bounds.y);
      if (Number.isFinite(bounds.maxX)) maxX = Math.max(maxX, bounds.maxX);
      else if (Number.isFinite(bounds.x + bounds.width)) maxX = Math.max(maxX, bounds.x + bounds.width);
      if (Number.isFinite(bounds.maxY)) maxY = Math.max(maxY, bounds.maxY);
      else if (Number.isFinite(bounds.y + bounds.height)) maxY = Math.max(maxY, bounds.y + bounds.height);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    return { minX, minY, maxX, maxY, x: minX, y: minY, width, height };
  }

  _computeDescriptorStampScale(baseScale, bounds) {
    const safeScale = Number(baseScale) || 1;
    const width = Math.max(1, Number(bounds?.width || 0));
    const height = Math.max(1, Number(bounds?.height || 0));
    const maxDim = Math.max(width * safeScale, height * safeScale);
    const maxTextureSize = this._getMaxTextureSize();
    if (maxDim <= maxTextureSize) return safeScale;
    return Math.max(0.01, safeScale * (maxTextureSize / maxDim));
  }

  _computeAveragePointDelta(targetPoints = [], sourcePoints = []) {
    try {
      const count = Math.min(
        Array.isArray(targetPoints) ? targetPoints.length : 0,
        Array.isArray(sourcePoints) ? sourcePoints.length : 0
      );
      if (!count) return null;
      let sumX = 0;
      let sumY = 0;
      let used = 0;
      for (let i = 0; i < count; i += 1) {
        const target = targetPoints[i];
        const source = sourcePoints[i];
        const tx = Number(target?.x);
        const ty = Number(target?.y);
        const sx = Number(source?.x);
        const sy = Number(source?.y);
        if (![tx, ty, sx, sy].every(Number.isFinite)) continue;
        sumX += tx - sx;
        sumY += ty - sy;
        used += 1;
      }
      if (!used) return null;
      return { x: sumX / used, y: sumY / used };
    } catch (_) {
      return null;
    }
  }

  _computePointDeltaOffsets(targetPoints = [], sourcePoints = [], { maxOffsets = 9 } = {}) {
    const offsets = [];
    const seen = new Set();
    try {
      const count = Math.min(
        Array.isArray(targetPoints) ? targetPoints.length : 0,
        Array.isArray(sourcePoints) ? sourcePoints.length : 0
      );
      if (!count) return offsets;
      const add = (index) => {
        const target = targetPoints[index];
        const source = sourcePoints[index];
        const tx = Number(target?.x);
        const ty = Number(target?.y);
        const sx = Number(source?.x);
        const sy = Number(source?.y);
        if (![tx, ty, sx, sy].every(Number.isFinite)) return;
        const x = tx - sx;
        const y = ty - sy;
        if (Math.hypot(x, y) < 0.5) return;
        const key = `${Math.round(x * 10) / 10}:${Math.round(y * 10) / 10}`;
        if (seen.has(key)) return;
        seen.add(key);
        offsets.push({ x, y });
      };
      const slots = Math.max(1, Math.min(Math.floor(Number(maxOffsets) || 1), count));
      for (let i = 0; i < slots; i += 1) {
        add(Math.round((count - 1) * (slots === 1 ? 0 : (i / (slots - 1)))));
      }
    } catch (_) {}
    return offsets;
  }

  _resolveDescriptorClipOffsets(descriptors = []) {
    const offsets = [];
    const seen = new Set();
    const add = (xRaw, yRaw) => {
      const x = Number(xRaw);
      const y = Number(yRaw);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (Math.hypot(x, y) < 0.5) return;
      const key = `${Math.round(x * 100) / 100}:${Math.round(y * 100) / 100}`;
      if (seen.has(key)) return;
      seen.add(key);
      offsets.push({ x, y });
    };
    try {
      for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
        add(descriptor?.clipOffsetX, descriptor?.clipOffsetY);
      }
    } catch (_) {}
    return offsets;
  }

  _getStandardMaskPathProgram() {
    try {
      if (this._standardMaskPathProgram) return this._standardMaskPathProgram;
      const vertexSrc = `
        precision highp float;
        attribute vec2 aVertexPosition;
        attribute vec2 aTextureCoord;
        attribute float aAlpha;
        attribute vec2 aMaskCoord;
        uniform mat3 translationMatrix;
        uniform mat3 projectionMatrix;
        varying vec2 vTextureCoord;
        varying float vAlpha;
        varying vec2 vMaskCoord;
        void main(void){
          vAlpha = aAlpha;
          vTextureCoord = aTextureCoord;
          vMaskCoord = aMaskCoord;
          vec3 position = projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0);
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `;
      const fragmentSrc = `
        precision mediump float;
        varying vec2 vTextureCoord;
        varying float vAlpha;
        varying vec2 vMaskCoord;
        uniform sampler2D uSampler;
        uniform sampler2D uMaskSampler;
        uniform vec4 uColor;
        void main(void){
          vec4 color = texture2D(uSampler, vTextureCoord) * uColor;
          float inside = step(0.0, vMaskCoord.x) * step(0.0, vMaskCoord.y) * step(vMaskCoord.x, 1.0) * step(vMaskCoord.y, 1.0);
          float maskAlpha = texture2D(uMaskSampler, vMaskCoord).a * inside;
          color.rgb *= vAlpha;
          color.a *= vAlpha * maskAlpha;
          if (color.a <= 0.001) discard;
          gl_FragColor = color;
        }
      `;
      this._standardMaskPathProgram = PIXI.Program.from(vertexSrc, fragmentSrc);
      return this._standardMaskPathProgram;
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.pathProgramFailed', {
        error: String(error?.message || error)
      });
      return null;
    }
  }

  _transformWorldPointToDocLocal(doc, point, options = {}) {
    try {
      if (!point) return null;
      const worldX = Number(point.x);
      const worldY = Number(point.y);
      if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return null;
      const pivotLocal = this._getDocPivotLocal(doc, options);
      const pivotWorld = this._getDocPivotWorld(doc, options);
      const rotation = (Number(doc?.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const dx = worldX - pivotWorld.x;
      const dy = worldY - pivotWorld.y;
      return {
        x: pivotLocal.x + (dx * cos) + (dy * sin),
        y: pivotLocal.y - (dx * sin) + (dy * cos)
      };
    } catch (_) {
      return null;
    }
  }

  _getGeometryAttributeBuffer(mesh, name) {
    try {
      const geometry = mesh?.geometry;
      if (!geometry) return null;
      const attr = geometry.getAttribute?.(name) || geometry.attributes?.[name] || null;
      const buffer = geometry.getBuffer?.(name) || attr?.buffer || null;
      const data = buffer?.data || attr?.data || null;
      if (!data || typeof data.length !== 'number') return null;
      return { attr, buffer, data };
    } catch (_) {
      return null;
    }
  }

  _createStandardMaskPathShader(pathTexture, maskTexture) {
    try {
      const program = this._getStandardMaskPathProgram();
      if (!program || !pathTexture || !maskTexture) return null;
      return new PIXI.Shader(program, {
        uSampler: pathTexture,
        uMaskSampler: maskTexture,
        uColor: new Float32Array([0, 0, 0, 1])
      });
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.pathShaderFailed', {
        error: String(error?.message || error)
      });
      return null;
    }
  }

  _applyStandardMaskShaderToPathMesh(mesh, descriptor, doc, pathTexture, maskTexture) {
    try {
      if (!mesh || mesh.destroyed || !descriptor || !doc || !pathTexture || !maskTexture) return false;
      const sourceSamples = Array.isArray(descriptor.sourceSamples) ? descriptor.sourceSamples : [];
      if (sourceSamples.length < PATH_MIN_POINTS) return false;
      const positionBuffer = this._getGeometryAttributeBuffer(mesh, 'aVertexPosition');
      const vertexCount = Math.floor(Number(positionBuffer?.data?.length || 0) / 2);
      if (vertexCount !== sourceSamples.length * 2) {
        Logger.error('AssetShadow.standardTileMask.pathMaskCoordVertexMismatch', {
          tileId: doc?.id || null,
          sampleCount: sourceSamples.length,
          vertexCount
        });
        return false;
      }

      const maskCoords = new Float32Array(vertexCount * 2);
      const baseWidth = Math.max(1, Number(descriptor.maskWidth || descriptor.sourceWidth || descriptor.width || 1));
      const halfWidthBase = baseWidth / 2;
      for (let i = 0; i < sourceSamples.length; i += 1) {
        const sample = sourceSamples[i];
        if (!sample) continue;
        let tangent = sample.tangent || null;
        if (!tangent) {
          const prev = sourceSamples[Math.max(0, i - 1)] || sample;
          const next = sourceSamples[Math.min(sourceSamples.length - 1, i + 1)] || sample;
          tangent = { x: Number(next.x || 0) - Number(prev.x || 0), y: Number(next.y || 0) - Number(prev.y || 0) };
        }
        const tangentLength = Math.hypot(Number(tangent.x || 0), Number(tangent.y || 0)) || 1;
        const normal = { x: -(Number(tangent.y || 0) / tangentLength), y: Number(tangent.x || 0) / tangentLength };
        const halfWidth = halfWidthBase * Math.max(0.01, Number(sample.widthMultiplier || 1) || 1);
        const center = { x: Number(sample.x || 0), y: Number(sample.y || 0) };
        const left = { x: center.x + (normal.x * halfWidth), y: center.y + (normal.y * halfWidth) };
        const right = { x: center.x - (normal.x * halfWidth), y: center.y - (normal.y * halfWidth) };
        const leftLocal = this._transformWorldPointToDocLocal(doc, left, { anchorMode: 'center' });
        const rightLocal = this._transformWorldPointToDocLocal(doc, right, { anchorMode: 'center' });
        const width = Math.max(1, Number(doc?.width || 0) || 1);
        const height = Math.max(1, Number(doc?.height || 0) || 1);
        const leftOffset = i * 4;
        const rightOffset = leftOffset + 2;
        maskCoords[leftOffset] = Number(leftLocal?.x ?? -1) / width;
        maskCoords[leftOffset + 1] = Number(leftLocal?.y ?? -1) / height;
        maskCoords[rightOffset] = Number(rightLocal?.x ?? -1) / width;
        maskCoords[rightOffset + 1] = Number(rightLocal?.y ?? -1) / height;
      }
      try { mesh.geometry.addAttribute('aMaskCoord', maskCoords, 2); } catch (error) {
        Logger.error('AssetShadow.standardTileMask.pathMaskCoordAttributeFailed', {
          tileId: doc?.id || null,
          error: String(error?.message || error)
        });
        return false;
      }
      const shader = this._createStandardMaskPathShader(pathTexture, maskTexture);
      if (!shader) return false;
      try { mesh.shader = shader; } catch (_) {}
      try { mesh.material = shader; } catch (_) {}
      mesh.faNexusStandardMaskApplied = true;
      return true;
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.pathShaderApplyFailed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return false;
    }
  }

  _createStandardMaskInverseTexture(standardStamp, renderer) {
    let renderTexture = null;
    const tempObjects = [];
    try {
      if (!standardStamp?.texture || !renderer) return null;
      const width = Math.max(4, Math.ceil(Number(standardStamp.texture.width || 0)));
      const height = Math.max(4, Math.ceil(Number(standardStamp.texture.height || 0)));
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      renderTexture = PIXI.RenderTexture.create({
        width,
        height,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      const stage = new PIXI.Container();
      const fill = new PIXI.Graphics();
      const maskSprite = new PIXI.Sprite(standardStamp.texture);
      tempObjects.push(stage, fill, maskSprite);
      stage.eventMode = 'none';
      stage.sortableChildren = false;
      stage.interactiveChildren = false;
      fill.beginFill(0xFFFFFF, 1);
      fill.drawRect(0, 0, width, height);
      fill.endFill();
      maskSprite.position.set(0, 0);
      maskSprite.width = width;
      maskSprite.height = height;
      maskSprite.blendMode = PIXI.BLEND_MODES.ERASE;
      stage.addChild(fill);
      stage.addChild(maskSprite);
      renderer.render(stage, { renderTexture, clear: true });
      return renderTexture;
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.inverseTexture.failed', {
        error: String(error?.message || error)
      });
      try { renderTexture?.destroy?.(true); } catch (_) {}
      return null;
    } finally {
      for (const object of tempObjects) {
        try { object?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
    }
  }

  _addStandardMaskInverseEraseSprites(drawContainer, doc, standardStamp, renderer, context = {}) {
    const tempObjects = Array.isArray(context?.tempObjects) ? context.tempObjects : null;
    const tempTextures = Array.isArray(context?.tempTextures) ? context.tempTextures : null;
    try {
      if (!drawContainer || !doc || !standardStamp?.texture || !renderer) return false;
      const scale = Number(context.scale) || 1;
      const sceneRect = context.sceneRect || { x: 0, y: 0 };
      const baseOffsetX = Number(context.baseOffsetX || 0) || 0;
      const baseOffsetY = Number(context.baseOffsetY || 0) || 0;
      const texScaleX = Number(doc?.texture?.scaleX ?? 1) || 1;
      const texScaleY = Number(doc?.texture?.scaleY ?? 1) || 1;
      const projectedOffsets = Array.isArray(context.projectedOffsets) && context.projectedOffsets.length
        ? context.projectedOffsets
        : [{ x: 0, y: 0 }];
      const expansionRadius = Math.max(0, Number(context.expansionRadius || 0) || 0);
      const expansionOffsets = this._buildDilationOffsets(expansionRadius * scale);
      const inverseMaskTexture = this._createStandardMaskInverseTexture(standardStamp, renderer);
      if (!inverseMaskTexture) {
        Logger.error('AssetShadow.standardTileMask.inverseEraseTextureMissing', {
          tileId: doc?.id || null
        });
        return false;
      }
      tempTextures?.push(inverseMaskTexture);

      let added = 0;
      for (const projectedOffset of projectedOffsets) {
        const projectedX = (Number(projectedOffset?.x || 0) || 0) * scale;
        const projectedY = (Number(projectedOffset?.y || 0) || 0) * scale;
        for (const expansionOffset of expansionOffsets) {
          const sprite = this._createDocShadowSprite(inverseMaskTexture, doc, standardStamp.bounds, {
            scale,
            sceneRect,
            offsetX: baseOffsetX + projectedX + (Number(expansionOffset?.x || 0) || 0),
            offsetY: baseOffsetY + projectedY + (Number(expansionOffset?.y || 0) || 0),
            flipX: texScaleX,
            flipY: texScaleY,
            anchorMode: 'doc'
          });
          if (!sprite) continue;
          sprite.blendMode = PIXI.BLEND_MODES.ERASE;
          try { sprite.visible = true; sprite.renderable = true; sprite.alpha = 1; } catch (_) {}
          drawContainer.addChild(sprite);
          tempObjects?.push(sprite);
          added += 1;
        }
      }
      return added > 0;
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.inverseEraseSprites.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return false;
    }
  }

  _createDescriptorClipMaskTexture(doc, standardStamp, renderer, { bounds = null, sourceScale = 1, descriptors = [] } = {}) {
    let renderTexture = null;
    const tempObjects = [];
    let inverseMaskTexture = null;
    try {
      if (!doc || !standardStamp?.texture || !renderer || !bounds) return null;
      const scale = Number(sourceScale) || 1;
      const width = Math.max(1, Number(bounds.width || 0));
      const height = Math.max(1, Number(bounds.height || 0));
      const pixelWidth = Math.max(4, Math.ceil(width * scale));
      const pixelHeight = Math.max(4, Math.ceil(height * scale));
      if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) return null;

      renderTexture = PIXI.RenderTexture.create({
        width: pixelWidth,
        height: pixelHeight,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      const stage = new PIXI.Container();
      const outsideOpaque = new PIXI.Graphics();
      tempObjects.push(stage, outsideOpaque);
      stage.eventMode = 'none';
      stage.sortableChildren = false;
      stage.interactiveChildren = false;
      outsideOpaque.beginFill(0xFFFFFF, 1);
      outsideOpaque.drawRect(0, 0, pixelWidth, pixelHeight);
      outsideOpaque.endFill();
      stage.addChild(outsideOpaque);

      const texScaleX = Number(doc?.texture?.scaleX ?? 1) || 1;
      const texScaleY = Number(doc?.texture?.scaleY ?? 1) || 1;
      const clearDocSprite = this._createDocShadowSprite(PIXI.Texture.WHITE, doc, standardStamp.bounds, {
        scale,
        sceneRect: bounds,
        offsetX: 0,
        offsetY: 0,
        flipX: texScaleX,
        flipY: texScaleY,
        anchorMode: 'doc'
      });
      const docMaskSprite = this._createDocShadowSprite(standardStamp.texture, doc, standardStamp.bounds, {
        scale,
        sceneRect: bounds,
        offsetX: 0,
        offsetY: 0,
        flipX: texScaleX,
        flipY: texScaleY,
        anchorMode: 'doc'
      });
      if (!clearDocSprite || !docMaskSprite) {
        Logger.error('AssetShadow.standardTileMask.descriptorClipMaskSpriteFailed', {
          tileId: doc?.id || null
        });
        try { renderTexture.destroy(true); } catch (_) {}
        return null;
      }
      tempObjects.push(clearDocSprite, docMaskSprite);
      clearDocSprite.blendMode = PIXI.BLEND_MODES.ERASE;
      docMaskSprite.blendMode = PIXI.BLEND_MODES.NORMAL;
      try { clearDocSprite.visible = true; clearDocSprite.renderable = true; clearDocSprite.alpha = 1; } catch (_) {}
      try { docMaskSprite.visible = true; docMaskSprite.renderable = true; docMaskSprite.alpha = 1; } catch (_) {}
      stage.addChild(clearDocSprite);
      stage.addChild(docMaskSprite);

      const projectedOffsets = this._resolveDescriptorClipOffsets(descriptors);
      if (projectedOffsets.length) {
        inverseMaskTexture = this._createStandardMaskInverseTexture(standardStamp, renderer);
        if (inverseMaskTexture) {
          for (const projectedOffset of projectedOffsets) {
            const inverseSprite = this._createDocShadowSprite(inverseMaskTexture, doc, standardStamp.bounds, {
              scale,
              sceneRect: bounds,
              offsetX: (Number(projectedOffset.x || 0) || 0) * scale,
              offsetY: (Number(projectedOffset.y || 0) || 0) * scale,
              flipX: texScaleX,
              flipY: texScaleY,
              anchorMode: 'doc'
            });
            if (!inverseSprite) continue;
            inverseSprite.blendMode = PIXI.BLEND_MODES.ERASE;
            try { inverseSprite.visible = true; inverseSprite.renderable = true; inverseSprite.alpha = 1; } catch (_) {}
            tempObjects.push(inverseSprite);
            stage.addChild(inverseSprite);
          }
        }
      }

      renderer.render(stage, { renderTexture, clear: true });
      return renderTexture;
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.descriptorClipMask.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      try { renderTexture?.destroy?.(true); } catch (_) {}
      return null;
    } finally {
      for (const obj of tempObjects) {
        try {
          if (obj && !obj.destroyed) obj.destroy({ children: true, texture: false, baseTexture: false });
        } catch (_) {}
      }
      try { inverseMaskTexture?.destroy?.(true); } catch (_) {}
    }
  }
  async _createMaskedDescriptorShadowStamp(doc, descriptors, standardStamp, renderer, context = {}) {
    return this._renderPrimitives.createMaskedDescriptorShadowStamp(doc, descriptors, standardStamp, renderer, context);
  }
  async _getScatterShadowStamp(doc, cfg, scale, renderer) {
    return this._renderPrimitives.getScatterShadowStamp(doc, cfg, scale, renderer);
  }

  _resolvePathShadowDescriptorsFromPath(doc) {
    const descriptors = [];
    try {
      const payloads = this._collectPathShadowPayloads(doc);
      if (!payloads.length) return descriptors;
      for (const pathFlags of payloads) {
        const descriptor = this._resolvePathShadowDescriptorFromFlags(pathFlags, doc);
        if (descriptor) descriptors.push(descriptor);
      }
    } catch (error) {
      Logger.warn('AssetShadow.pathDescriptor.failed', String(error?.message || error));
    }
    return descriptors;
  }

  _collectPathShadowPayloads(doc) {
    const readFlag = (key) => {
      try {
        const value = doc?.getFlag?.('fa-nexus', key);
        if (value !== undefined) return value;
      } catch (_) {}
      const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
      return flags ? flags[key] : null;
    };
    const annotate = (entry, kind) => ({ ...entry, _faNexusPathKind: kind });
    const merged = readFlag('pathsV2');
    if (merged && Array.isArray(merged.paths)) {
      return merged.paths
        .filter((entry) => entry && Array.isArray(entry.controlPoints))
        .map((entry) => annotate(entry, 'v2'));
    }
    const v2 = readFlag('pathV2');
    if (v2 && Array.isArray(v2.controlPoints)) return [annotate(v2, 'v2')];
    const v1 = readFlag('path');
    if (v1 && Array.isArray(v1.controlPoints)) return [annotate(v1, 'v1')];
    return [];
  }

  _resolvePathShadowDescriptorFromFlags(pathFlags, doc) {
    try {
      const shadow = pathFlags?.shadow;
      const previewOverride = this._getTilePreviewShadowOverride(doc);
      const previewForcesEnabled = previewOverride && Object.prototype.hasOwnProperty.call(previewOverride, 'enabled') && !!previewOverride.enabled;
      if ((!shadow || !shadow.enabled) && !previewForcesEnabled) return null;
      const previewOffsetPx = Number(previewOverride?.pathShadowOffsetPx);
      const shadowState = shadow || {};
      const useAutoShadowGeometry = Number.isFinite(previewOffsetPx) || previewForcesEnabled || (!shadowState?.manual && !shadowState?.editMode);
      const pointsRaw = useAutoShadowGeometry
        ? computePathShadowPoints(
            pathFlags?.controlPoints || [],
            Number.isFinite(previewOffsetPx) ? previewOffsetPx : (Number(shadowState?.offset) || 0),
            {
              closed: !!pathFlags?.closed,
              feather: pathFlags?.feather || null
            }
          )
        : (Array.isArray(shadowState.points) ? shadowState.points : []);
      const sourcePointsRaw = useAutoShadowGeometry
        ? computePathShadowPoints(
            pathFlags?.controlPoints || [],
            0,
            {
              closed: !!pathFlags?.closed,
              feather: pathFlags?.feather || null
            }
          )
        : [];
      if (!useAutoShadowGeometry && pointsRaw.length < PATH_MIN_POINTS) {
        Logger.error('AssetShadow.pathDescriptor.manualPointsMissing', {
          tileId: doc?.id || null,
          pathKind: pathFlags?._faNexusPathKind || null,
          manual: !!shadowState?.manual,
          editMode: !!shadowState?.editMode
        });
      }
      if (pointsRaw.length < PATH_MIN_POINTS) return null;
      const points = [];
      const sourcePoints = [];
      for (const raw of pointsRaw) {
        if (!raw) continue;
        const worldPoint = this._transformDocLocalPoint(doc, {
          x: Number(raw.x) || 0,
          y: Number(raw.y) || 0
        }, { anchorMode: 'center' });
        if (!worldPoint) continue;
        points.push({
          x: worldPoint.x,
          y: worldPoint.y,
          widthLeft: Number.isFinite(raw.widthLeft) ? Number(raw.widthLeft) : 1,
          widthRight: Number.isFinite(raw.widthRight) ? Number(raw.widthRight) : 1
        });
      }
      for (const raw of sourcePointsRaw) {
        if (!raw) continue;
        const worldPoint = this._transformDocLocalPoint(doc, {
          x: Number(raw.x) || 0,
          y: Number(raw.y) || 0
        }, { anchorMode: 'center' });
        if (!worldPoint) continue;
        sourcePoints.push({
          x: worldPoint.x,
          y: worldPoint.y,
          widthLeft: Number.isFinite(raw.widthLeft) ? Number(raw.widthLeft) : 1,
          widthRight: Number.isFinite(raw.widthRight) ? Number(raw.widthRight) : 1
        });
      }
      if (points.length < PATH_MIN_POINTS) return null;
      const sampleCount = Math.max(2, Math.floor(pathFlags?.samplesPerSegment || PATH_DEFAULT_SEGMENT_SAMPLES));
      const tension = Number(pathFlags?.tension ?? 0) || 0;
      const closed = !!pathFlags?.closed && points.length >= PATH_MIN_POINTS;
      const samples = computePathSamples(points, sampleCount, tension, { closed });
      if (!Array.isArray(samples) || !samples.length) return null;
      const sourceSamples = sourcePoints.length >= PATH_MIN_POINTS
        ? computePathSamples(sourcePoints, sampleCount, tension, { closed })
        : [];
      const clipOffset = this._computeAveragePointDelta(samples, sourceSamples);
      const clipOffsets = this._computePointDeltaOffsets(samples, sourceSamples);
      const previewScale = Number(previewOverride?.pathShadowScale);
      const shadowScale = Math.max(0.05, Number.isFinite(previewScale) ? previewScale : (Number(shadowState?.scale) || 1));
      const baseWidth = Math.max(1, Number(pathFlags?.width) || Number(doc?.width) || 1);
      const pathWidth = baseWidth * shadowScale;
      const repeatBase = Math.max(1e-3, Number(pathFlags?.repeatSpacing) || baseWidth);
      const repeatSpacing = repeatBase * shadowScale;
      const useVisibleRows = pathFlags?._faNexusPathKind === 'v2';
      const meshOptions = {
        textureOffset: {
          x: Number(pathFlags?.textureOffset?.x) || 0,
          y: Number(pathFlags?.textureOffset?.y) || 0
        },
        textureFlip: {
          horizontal: !!pathFlags?.textureFlip?.horizontal,
          vertical: !!pathFlags?.textureFlip?.vertical
        },
        feather: pathFlags?.feather || {},
        opacityFeather: pathFlags?.opacityFeather || {}
      };
      const bounds = computePathBounds(samples, pathWidth);
      const textureSrc = pathFlags?.baseSrc || doc?.texture?.src || null;
      return {
        samples,
        sourceSamples,
        width: pathWidth,
        sourceWidth: baseWidth,
        repeatSpacing,
        meshOptions,
        bounds,
        textureSrc,
        useVisibleRows,
        clipOffsetX: Number(clipOffset?.x || 0) || 0,
        clipOffsetY: Number(clipOffset?.y || 0) || 0,
        clipOffsets
      };
    } catch (error) {
      Logger.warn('AssetShadow.pathDescriptor.failed', String(error?.message || error));
      return null;
    }
  }

  _buildBuildingShadowDescriptorFromLoop(doc, loop, options = {}) {
    const closed = options.closed !== false;
    const minPoints = closed ? 3 : 2;
    if (!Array.isArray(loop) || loop.length < minPoints) return null;
    const transformPoint = typeof options.transformPoint === 'function'
      ? options.transformPoint
      : (point) => this._transformDocLocalPoint(doc, point, { anchorMode: 'center' });
    const worldLoop = loop
      .map((point) => transformPoint(point))
      .filter(Boolean);
    if (worldLoop.length < minPoints) return null;
    worldLoop.closed = closed;

    const effectiveWidth = Math.max(2, Number(options.width) || 2);
    const scaledWidth = Math.max(2, Number(options.sourceWidth) || effectiveWidth);
    const textureOffset = options.textureOffset || { x: 0, y: 0 };
    const textureFlip = options.textureFlip || { horizontal: false, vertical: false };
    const repeatSpacing = Math.max(1, Number(options.textureRepeatDistance) || effectiveWidth);
    const texturePhaseDistance = Number(options.texturePhaseDistance) || 0;
    const centerOffset = Number(options.centerOffset) || 0;
    const sourceCenterOffset = Number(options.sourceCenterOffset) || 0;
    const metricScaleValue = Number(options.metricScale);
    const metricScale = Number.isFinite(metricScaleValue) && metricScaleValue > 0 ? metricScaleValue : 1;
    const centerlineInput = options.reuseCenterlineGeometry === true ? worldLoop : loop;
    const centerline = BuildingWallMesher.buildCenterline(centerlineInput, {
      width: effectiveWidth,
      closed,
      joinStyle: 'mitre',
      mitreLimit: 4,
      centerOffset,
      textureRepeatDistance: repeatSpacing,
      texturePhaseDistance,
      textureOffset,
      textureFlip,
      startJoinDir: options.startJoinDir || null,
      endJoinDir: options.endJoinDir || null
    });
    // Width does not alter centerline samples. When source and effective offsets
    // match (the common zero-offset shadow), reuse the samples used for bounds
    // and mesh geometry instead of compiling the same polyline again.
    const sourceCenterline = Math.abs(centerOffset - sourceCenterOffset) <= 1e-6
      ? centerline
      : BuildingWallMesher.buildCenterline(centerlineInput, {
          width: scaledWidth,
          closed,
          joinStyle: 'mitre',
          mitreLimit: 4,
          centerOffset: sourceCenterOffset,
          textureRepeatDistance: repeatSpacing,
          texturePhaseDistance,
          textureOffset,
          textureFlip,
          startJoinDir: options.startJoinDir || null,
          endJoinDir: options.endJoinDir || null
        });
    const samples = Array.isArray(centerline?.samples) ? centerline.samples : [];
    const worldSamples = samples
      .map((sample) => {
        const worldPoint = transformPoint(sample);
        if (!worldPoint) return null;
        return {
          ...sample,
          x: worldPoint.x,
          y: worldPoint.y
        };
      })
      .filter(Boolean);
    const sourceWorldSamples = sourceCenterline === centerline
      ? worldSamples
      : (Array.isArray(sourceCenterline?.samples) ? sourceCenterline.samples : [])
        .map((sample) => {
          const worldPoint = transformPoint(sample);
          if (!worldPoint) return null;
          return {
            ...sample,
            x: worldPoint.x,
            y: worldPoint.y
          };
        })
        .filter(Boolean);
    const clipOffset = this._computeAveragePointDelta(worldSamples, sourceWorldSamples);
    const clipOffsets = this._computePointDeltaOffsets(worldSamples, sourceWorldSamples);
    const worldWidth = effectiveWidth * metricScale;
    const worldSourceWidth = scaledWidth * metricScale;
    const worldShadowDilation = Math.max(0, Number(options.shadowDilation) || 0) * metricScale;
    const worldCenterOffset = centerOffset * metricScale;
    const worldTextureOffset = {
      x: (Number(textureOffset?.x) || 0) * metricScale,
      y: (Number(textureOffset?.y) || 0) * metricScale
    };
    const worldRepeatSpacing = repeatSpacing * metricScale;
    const worldTexturePhaseDistance = texturePhaseDistance * metricScale;
    const bounds = worldSamples.length
      ? computePathBounds(worldSamples, worldWidth)
      : this._computeLoopBounds(worldLoop, worldWidth);
    const descriptor = {
      kind: 'building',
      loop: worldLoop,
      closed,
      width: worldWidth,
      sourceWidth: worldSourceWidth,
      shadowDilation: worldShadowDilation,
      centerOffset: worldCenterOffset,
      textureOffset: worldTextureOffset,
      textureFlip: { ...textureFlip },
      textureRepeatDistance: worldRepeatSpacing,
      texturePhaseDistance: worldTexturePhaseDistance,
      bounds,
      textureSrc: options.textureSrc || null,
      textureKey: options.textureKey || null,
      alphaMultiplier: normalizeLayerOpacity(options.alphaMultiplier, 1),
      clipOffsetX: Number(clipOffset?.x || 0) || 0,
      clipOffsetY: Number(clipOffset?.y || 0) || 0,
      clipOffsets,
      preparedGeometryData: options.reuseCenterlineGeometry === true ? centerline : null
    };
    if (Object.prototype.hasOwnProperty.call(options, 'startJoinDir')) descriptor.startJoinDir = options.startJoinDir || null;
    if (Object.prototype.hasOwnProperty.call(options, 'endJoinDir')) descriptor.endJoinDir = options.endJoinDir || null;
    return descriptor;
  }

  _resolveBuildingShadowDescriptors(doc) {
    try {
      const data = doc?.getFlag?.('fa-nexus', 'building');
      const previewOverride = this._getTilePreviewShadowOverride(doc);
      const previewForcesEnabled = previewOverride && Object.prototype.hasOwnProperty.call(previewOverride, 'enabled') && !!previewOverride.enabled;
      const applyPreviewOverride = (source = {}) => {
        const base = source && typeof source === 'object' ? source : {};
        if (!previewOverride) {
          return {
            ...base,
            scale: Math.max(0.05, Number(base?.scale) || 1)
          };
        }
        const previewPathOffsetPx = Number(previewOverride?.pathShadowOffsetPx);
        const previewScale = Number(previewOverride?.pathShadowScale);
        return {
          ...base,
          alpha: Number.isFinite(Number(previewOverride?.shadowAlpha)) ? Number(previewOverride.shadowAlpha) : base.alpha,
          blur: Number.isFinite(Number(previewOverride?.shadowBlur)) ? Number(previewOverride.shadowBlur) : base.blur,
          dilation: Number.isFinite(Number(previewOverride?.shadowDilation)) ? Number(previewOverride.shadowDilation) : base.dilation,
          offset: Number.isFinite(previewPathOffsetPx)
            ? previewPathOffsetPx
            : (Number.isFinite(Number(previewOverride?.shadowOffsetY)) ? Number(previewOverride.shadowOffsetY) : base.offset),
          scale: Math.max(0.05, Number.isFinite(previewScale) ? previewScale : (Number(base?.scale) || 1))
        };
      };
      let shadowState = data?.wall?.pathShadow;
      if ((!shadowState || !shadowState.enabled) && previewForcesEnabled) {
        shadowState = applyPreviewOverride({
          ...(shadowState || {}),
          enabled: true,
          alpha: Number(shadowState?.alpha ?? 0.65),
          blur: Number(shadowState?.blur ?? 0),
          dilation: Number(shadowState?.dilation ?? 0),
          offset: Number(shadowState?.offset ?? 0)
        });
      }
      if (shadowState && previewOverride) {
        shadowState = applyPreviewOverride(shadowState);
      }
      if (!data) return [];
      const hasIndependentPortalShadow = (data?.runtime?.portalArtwork || []).some((portal) => (
        portal?.kind === 'window-surface'
        && portal?.shadow?.enabled !== false
        && Number(portal?.shadow?.alpha) > 0.001
        && Array.isArray(portal?.artwork)
        && portal.artwork.length > 0
      ));
      if ((!shadowState || !shadowState.enabled) && !hasIndependentPortalShadow) return [];
      const descriptors = [];
      const rootFrame = resolveBuildingV2RootFrameOffset(data);
      let transformPoint;
      let transformDirection = (direction) => direction;
      let metricScale = 1;
      let rootRotation = 0;
      if (rootFrame.version === 1) {
        const spatialPose = deriveBuildingV2SpatialPose(doc, data);
        const spatialTransform = createBuildingV2SpatialTransform(spatialPose);
        transformPoint = (point) => spatialTransform.localToWorld(point);
        transformDirection = (direction) => spatialTransform.localDirectionToWorld(direction);
        metricScale = spatialPose.scale;
        rootRotation = Number(spatialPose.rotation || 0) * (Math.PI / 180);
      }
      const portalDescriptors = [];
      for (const portal of data?.runtime?.portalArtwork || []) {
        const portalShadow = portal?.shadow;
        if (!['door-frame', 'window-surface'].includes(portal?.kind)
          || !portalShadow || portalShadow.enabled === false) continue;
        const direction = transformDirection(portalShadow.normal || { x: 0, y: 0 });
        const offset = (Number(portalShadow.offset) || 0) * metricScale;
        const dilation = Math.max(0, Number(portalShadow.dilation) || 0)
          * (portal?.kind === 'window-surface' ? 1 : metricScale);
        for (const artwork of portal?.artwork || []) {
          const center = transformPoint ? transformPoint({ x: artwork.x, y: artwork.y }) : { x: artwork.x, y: artwork.y };
          const x = Number(center?.x) + (Number(direction?.x) * offset);
          const y = Number(center?.y) + (Number(direction?.y) * offset);
          const width = (Number(artwork.width) * metricScale) + (dilation * 2);
          const height = (Number(artwork.height) * metricScale) + (dilation * 2);
          const rotation = Number(artwork.rotation) + rootRotation;
          if (![x, y, width, height, rotation].every(Number.isFinite) || !(width > 0) || !(height > 0)) continue;
          portalDescriptors.push({
            kind: 'buildingCompositeSprite',
            textureSrc: artwork.textureSrc,
            sourceFrame: artwork.sourceFrame || null,
            x, y, width, height, rotation,
            flipX: Number(artwork.flipX) < 0 ? -1 : 1,
            flipY: Number(artwork.flipY) < 0 ? -1 : 1,
            bounds: this._computeBuildingCompositePartBounds({
              x, y, width, height, rotation: rotation * (180 / Math.PI)
            }),
            shadowDilation: 0,
            alphaMultiplier: 1,
            resolvedShadow: true,
            shadowConfig: {
              ...(portalShadow.alpha !== null && Number.isFinite(Number(portalShadow.alpha))
                ? { alpha: Math.min(1, Math.max(0, Number(portalShadow.alpha))) }
                : {}),
              ...(portalShadow.blur !== null && Number.isFinite(Number(portalShadow.blur))
                ? { blur: Math.max(0, Number(portalShadow.blur)) }
                : {}),
              dilation: 0,
              offsetX: 0,
              offsetY: 0
            }
          });
        }
      }
      const renderSegments = Array.isArray(data?.wall?.renderSegments) ? data.wall.renderSegments : [];
      for (const segment of renderSegments) {
        const segmentShadow = segment?.pathShadow;
        const shadow = applyPreviewOverride(previewForcesEnabled && (!segmentShadow || !segmentShadow.enabled)
          ? { ...shadowState, ...(segmentShadow || {}), enabled: true }
          : (segmentShadow || shadowState));
        if (!shadow?.enabled) continue;
        const closed = segment?.closed !== false;
        const minPoints = closed ? 3 : 2;
        const localLoop = Array.isArray(segment?.points)
          ? segment.points.map((point) => ({
            x: Number(point?.x) || 0,
            y: Number(point?.y) || 0
          }))
          : [];
        if (localLoop.length < minPoints) continue;
        const alphaMultiplier = normalizeLayerOpacity(segment?.layerOpacity, data?.wall?.layerOpacity);
        if (alphaMultiplier <= 0.001) continue;
        const baseWidth = Math.max(1, Number(segment?.width) || Number(data?.wall?.width) || Number(doc?.width) || 1);
        const repeatBase = Math.max(1e-3, Number(segment?.repeatDistance) || baseWidth);
        const shadowScale = Math.max(0.05, Number(shadow?.scale) || 1);
        const dilation = Math.max(0, Number(shadow?.dilation) || 0);
        const scaledWidth = Math.max(2, baseWidth * shadowScale);
        const effectiveWidth = Math.max(2, scaledWidth + (dilation * 2));
        const repeatSpacing = Math.max(1, repeatBase * shadowScale);
        const segmentOffsetX = Number(segment?.textureOffset?.x);
        const segmentOffsetY = Number(segment?.textureOffset?.y);
        const textureOffset = {
          x: Number.isFinite(segmentOffsetX) ? segmentOffsetX : (Number(data?.wall?.textureOffset?.x) || 0),
          y: Number.isFinite(segmentOffsetY) ? segmentOffsetY : (Number(data?.wall?.textureOffset?.y) || 0)
        };
        const shadowOffset = Number(shadow?.offset) || 0;
        const centerOffset = textureOffset.y + shadowOffset;
        const geometryTextureOffset = {
          x: textureOffset.x,
          y: 0
        };
        const textureFlip = {
          horizontal: segment?.textureFlip && Object.prototype.hasOwnProperty.call(segment.textureFlip, 'horizontal')
            ? !!segment.textureFlip.horizontal
            : !!data?.wall?.textureFlip?.horizontal,
          vertical: segment?.textureFlip && Object.prototype.hasOwnProperty.call(segment.textureFlip, 'vertical')
            ? !!segment.textureFlip.vertical
            : !!data?.wall?.textureFlip?.vertical
        };
        const descriptor = this._buildBuildingShadowDescriptorFromLoop(doc, localLoop, {
          closed,
          width: effectiveWidth,
          sourceWidth: scaledWidth,
          shadowDilation: dilation,
          centerOffset,
          sourceCenterOffset: textureOffset.y,
          textureOffset: geometryTextureOffset,
          textureFlip,
          textureRepeatDistance: repeatSpacing,
          texturePhaseDistance: (Number(segment?.texturePhaseDistance) || 0) * shadowScale,
          textureSrc: segment?.texture || segment?.pathLocal || data?.wall?.texture || null,
          textureKey: segment?.pathKey || data?.wall?.pathKey || null,
          alphaMultiplier,
          transformPoint,
          metricScale,
          startJoinDir: this._rotateDirection(segment?.startJoinDir, doc),
          endJoinDir: this._rotateDirection(segment?.endJoinDir, doc)
        });
        if (descriptor) descriptors.push(descriptor);
      }
      if (renderSegments.length) return [...descriptors, ...portalDescriptors];
      if (!shadowState?.enabled) return portalDescriptors;

      const loops = gatherBuildingLoops(data);
      if (!loops.length) return portalDescriptors;
      const baseWidth = Math.max(1, Number(data?.wall?.width) || Number(doc?.width) || 1);
      const repeatBase = Math.max(1e-3, Number(data?.wall?.repeatDistance) || baseWidth);
      const shadowScale = Math.max(0.05, Number(shadowState?.scale) || 1);
      const dilation = Math.max(0, Number(shadowState?.dilation) || 0);
      const scaledWidth = Math.max(2, baseWidth * shadowScale);
      const effectiveWidth = Math.max(2, scaledWidth + (dilation * 2));
      const repeatSpacing = Math.max(1, repeatBase * shadowScale);
      const textureOffset = {
        x: Number(data?.wall?.textureOffset?.x) || 0,
        y: Number(data?.wall?.textureOffset?.y) || 0
      };
      const shadowOffset = Number(shadowState?.offset) || 0;
      const centerOffset = textureOffset.y + shadowOffset;
      const geometryTextureOffset = {
        x: textureOffset.x,
        y: 0
      };
      const textureFlip = {
        horizontal: !!data?.wall?.textureFlip?.horizontal,
        vertical: !!data?.wall?.textureFlip?.vertical
      };
      const textureSrc = data?.wall?.texture || null;
      const textureKey = data?.wall?.pathKey || null;
      const alphaMultiplier = normalizeLayerOpacity(data?.wall?.layerOpacity, 1);
      if (alphaMultiplier <= 0.001) return [];
      for (const loop of loops) {
        if (!Array.isArray(loop)) continue;
        const closed = loop?.closed !== false;
        const minPoints = closed ? 3 : 2;
        if (loop.length < minPoints) continue;
        const descriptor = this._buildBuildingShadowDescriptorFromLoop(doc, loop, {
          closed,
          width: effectiveWidth,
          sourceWidth: scaledWidth,
          shadowDilation: dilation,
          centerOffset,
          sourceCenterOffset: textureOffset.y,
          textureOffset: geometryTextureOffset,
          textureFlip,
          textureRepeatDistance: repeatSpacing,
          textureSrc,
          textureKey,
          alphaMultiplier,
          transformPoint,
          metricScale
        });
        if (descriptor) descriptors.push(descriptor);
      }
      return [...descriptors, ...portalDescriptors];
    } catch (error) {
      Logger.warn('AssetShadow.buildingDescriptor.failed', String(error?.message || error));
      return [];
    }
  }

  _buildDilationOffsets(radius) {
    const offsets = [{ x: 0, y: 0 }];
    const r = Math.max(0, Number(radius || 0));
    if (r < 0.5) return offsets;
    const steps = 16;
    const full = Math.PI * 2;
    for (let i = 0; i < steps; i++) {
      const angle = (full * i) / steps;
      offsets.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    const inner = r * 0.55;
    if (inner >= 0.5) {
      for (let i = 0; i < steps; i++) {
        const angle = (full * i) / steps + (full / (steps * 2));
        offsets.push({ x: Math.cos(angle) * inner, y: Math.sin(angle) * inner });
      }
    }
    return offsets;
  }

  _remapGeometryVisibleRows(geometry, visibleData) {
    try {
      if (!geometry || !visibleData) return;
      const texHeight = Math.max(1, Number(visibleData.totalHeight) || 0);
      if (!texHeight) return;
      const uvBuffer = geometry.getBuffer('aTextureCoord');
      if (!uvBuffer?.data) return;
      const topRow = Number.isFinite(visibleData.topRow) ? Number(visibleData.topRow) : 0;
      const bottomRow = Number.isFinite(visibleData.bottomRow)
        ? Number(visibleData.bottomRow)
        : (texHeight - 1);
      const vMin = topRow / texHeight;
      const vMax = (bottomRow + 1) / texHeight;
      const vRange = vMax - vMin;
      if (!(vRange > 0)) return;
      const uvData = uvBuffer.data;
      for (let i = 1; i < uvData.length; i += 2) {
        uvData[i] = vMin + (uvData[i] * vRange);
      }
      uvBuffer.update();
    } catch (_) {
      /* ignore */
    }
  }

  _detectTextureVisibleRows(texture) {
    try {
      const baseTexture = texture?.baseTexture;
      if (!baseTexture?.valid) return null;
      const width = Math.max(1, Number(baseTexture.width) || 0);
      const height = Math.max(1, Number(baseTexture.height) || 0);
      const resource = baseTexture.resource;
      const source = resource?.source;
      if (!source || !width || !height) return null;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(source, 0, 0);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      const alphaThreshold = 10;
      let top = 0;
      let bottom = height - 1;
      const rowVisible = (y) => {
        for (let x = 0; x < width; x++) {
          if (pixels[(y * width + x) * 4 + 3] > alphaThreshold) return true;
        }
        return false;
      };
      while (top < height && !rowVisible(top)) top += 1;
      while (bottom > top && !rowVisible(bottom)) bottom -= 1;
      const visibleHeight = Math.max(1, bottom - top + 1);
      return {
        visibleHeight,
        topRow: top,
        bottomRow: bottom,
        totalHeight: height
      };
    } catch (error) {
      Logger.warn('AssetShadow.visibleRows.detect.failed', String(error?.message || error));
      return null;
    }
  }

  _computeLoopBounds(points, width = 0) {
    if (!Array.isArray(points) || !points.length) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    }
    const padding = Math.max(0, Number(width || 0) / 2);
    const expanded = {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding
    };
    expanded.width = expanded.maxX - expanded.minX;
    expanded.height = expanded.maxY - expanded.minY;
    return expanded;
  }

  _getDocDimensions(doc) {
    return {
      width: Math.max(1, Number(doc?.width || doc?.shape?.width || 0) || 1),
      height: Math.max(1, Number(doc?.height || doc?.shape?.height || 0) || 1)
    };
  }

  _getDocAnchor(doc, { anchorMode = 'doc' } = {}) {
    if (anchorMode === 'center') return { x: 0.5, y: 0.5 };
    const anchorX = Number(doc?.texture?.anchorX);
    const anchorY = Number(doc?.texture?.anchorY);
    return {
      x: Number.isFinite(anchorX) ? anchorX : 0.5,
      y: Number.isFinite(anchorY) ? anchorY : 0.5
    };
  }

  _getDocPivotLocal(doc, options = {}) {
    const { width, height } = this._getDocDimensions(doc);
    const anchor = this._getDocAnchor(doc, options);
    return {
      x: width * anchor.x,
      y: height * anchor.y
    };
  }

  _getDocAnchorWorld(doc, { anchorMode = 'doc' } = {}) {
    const { width, height } = this._getDocDimensions(doc);
    const actualAnchor = this._getDocAnchor(doc, { anchorMode: 'doc' });
    const actualAnchorWorld = {
      x: Number(doc?.x) || 0,
      y: Number(doc?.y) || 0
    };
    if (anchorMode === 'center') {
      return {
        x: actualAnchorWorld.x + (width * (0.5 - actualAnchor.x)),
        y: actualAnchorWorld.y + (height * (0.5 - actualAnchor.y))
      };
    }
    return actualAnchorWorld;
  }

  _getDocPivotWorld(doc, options = {}) {
    return this._getDocAnchorWorld(doc, options);
  }

  _transformDocLocalPoint(doc, point, options = {}) {
    try {
      if (!point) return null;
      const localX = Number(point.x);
      const localY = Number(point.y);
      if (!Number.isFinite(localX) || !Number.isFinite(localY)) return null;
      const pivotLocal = this._getDocPivotLocal(doc, options);
      const pivotWorld = this._getDocPivotWorld(doc, options);
      const rotation = (Number(doc?.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const dx = localX - pivotLocal.x;
      const dy = localY - pivotLocal.y;
      return {
        x: pivotWorld.x + (dx * cos) - (dy * sin),
        y: pivotWorld.y + (dx * sin) + (dy * cos)
      };
    } catch (_) {
      return null;
    }
  }

  _rotateDirection(direction, doc) {
    try {
      if (!direction) return null;
      const dx = Number(direction.x);
      const dy = Number(direction.y);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
      const rotation = (Number(doc?.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      return {
        x: (dx * cos) - (dy * sin),
        y: (dx * sin) + (dy * cos)
      };
    } catch (_) {
      return null;
    }
  }
  _createDocShadowSprite(texture, doc, localBounds, context = {}) {
    return this._renderPrimitives.createDocShadowSprite(texture, doc, localBounds, context);
  }
  _createWorldBoundsShadowSprite(texture, bounds, context = {}) {
    return this._renderPrimitives.createWorldBoundsShadowSprite(texture, bounds, context);
  }

  _computeBlurQuality(blurPixels) {
    const numeric = Number(blurPixels);
    if (!Number.isFinite(numeric)) return SHADOW_BLUR_QUALITY_MIN;
    const normalized = Math.max(0, numeric);
    const dynamic = SHADOW_BLUR_QUALITY_MIN + Math.floor(normalized / SHADOW_BLUR_QUALITY_STEP);
    return Math.min(SHADOW_BLUR_QUALITY_MAX, dynamic);
  }

  async _obtainPathShadowTexture(src) {
    if (!src) return null;
    const encoded = AssetShadowManager._encode(src);
    const key = `path:${encoded}`;
    const cached = this._textureCache.get(key);
    if (cached && cached.texture && !cached.texture.baseTexture?.destroyed) {
      return cached.texture;
    }
    try {
      const texture = await loadPathTexture(src, { attempts: 2, timeout: 6000 });
      const base = texture?.baseTexture;
      if (base) {
        try { base.wrapMode = PIXI.WRAP_MODES.REPEAT; } catch (_) {}
        try { base.mipmap = PIXI.MIPMAP_MODES.OFF; } catch (_) {}
      }
      this._textureCache.set(key, { texture, ts: Date.now() });
      return texture;
    } catch (error) {
      Logger.warn('AssetShadow.pathTexture.failed', String(error?.message || error));
      return null;
    }
  }

  async _obtainBuildingShadowTexture(src, textureKey) {
    if (!src) return null;
    const encoded = AssetShadowManager._encode(src);
    const suffix = textureKey ? `?key=${encodeURIComponent(textureKey)}` : '';
    const cacheKey = `building:${encoded}${suffix}`;
    const cached = this._textureCache.get(cacheKey);
    if (cached?.texture && !cached.texture.baseTexture?.destroyed) {
      return {
        texture: cached.texture,
        visibleData: cached.visibleData || cached.texture._cachedVisibleData || null
      };
    }
    try {
      const texture = await loadPathTexture(src, { attempts: 2, timeout: 6000 });
      const visibleData = this._detectTextureVisibleRows(texture);
      if (visibleData) texture._cachedVisibleData = visibleData;
      this._textureCache.set(cacheKey, { texture, visibleData, ts: Date.now() });
      return { texture, visibleData };
    } catch (error) {
      Logger.warn('AssetShadow.buildingTexture.failed', String(error?.message || error));
      return null;
    }
  }
  async _createBuildingCompositePartShadowSprite(descriptor, context = {}) {
    return this._renderPrimitives.createBuildingCompositePartShadowSprite(descriptor, context);
  }
  async _createPathShadowMesh(descriptor, context = {}) {
    return this._renderPrimitives.createPathShadowMesh(descriptor, context);
  }
  _getBuildingShadowMaterial() {
    return this._renderPrimitives.getBuildingShadowMaterial();
  }
  async _createBuildingShadowMesh(descriptor, context = {}) {
    return this._renderPrimitives.createBuildingShadowMesh(descriptor, context);
  }

  _applyShadowMargins(sceneRect, options = {}) {
    try {
      const rect = sceneRect && Number.isFinite(sceneRect.width) && Number.isFinite(sceneRect.height)
        ? { x: Number(sceneRect.x || 0), y: Number(sceneRect.y || 0), width: Math.max(1, Number(sceneRect.width || 0)), height: Math.max(1, Number(sceneRect.height || 0)) }
        : { x: 0, y: 0, width: 0, height: 0 };
      const offsetX = Math.abs(Number(options.offsetX || 0)) || 0;
      const offsetY = Math.abs(Number(options.offsetY || 0)) || 0;
      const dilation = Math.max(0, Number(options.dilation || 0)) || 0;
      const blur = Math.max(0, Number(options.blur || 0)) || 0;
      const blurMargin = blur * 12;
      const marginX = offsetX + dilation + blurMargin;
      const marginY = offsetY + dilation + blurMargin;
      const expanded = {
        x: Math.floor(rect.x - marginX),
        y: Math.floor(rect.y - marginY),
        width: Math.max(1, Math.ceil(rect.width + marginX * 2)),
        height: Math.max(1, Math.ceil(rect.height + marginY * 2))
      };
      if (!Number.isFinite(expanded.x) || !Number.isFinite(expanded.y) || !Number.isFinite(expanded.width) || !Number.isFinite(expanded.height)) {
        return sceneRect;
      }
      return expanded;
    } catch (_) {
      return sceneRect;
    }
  }

  _computeOffsetVector(distance, angle) {
    const dist = Math.min(MAX_OFFSET_DISTANCE, Math.max(-MAX_OFFSET_DISTANCE, Number(distance || 0)));
    const theta = this._normalizeAngle(angle) * (Math.PI / 180);
    return {
      x: Math.cos(theta) * dist,
      y: Math.sin(theta) * dist
    };
  }

  _normalizeAngle(angle) {
    const numeric = Number(angle);
    if (!Number.isFinite(numeric)) return 0;
    let normalized = numeric % 360;
    if (normalized < 0) normalized += 360;
    return normalized;
  }

  _ensureBlurFilter(layer) {
    const blurAmount = Math.max(0, Number(layer.options.blur || 0));
    if (blurAmount <= 0) {
      if (layer.blurFilter) {
        try { layer.blurFilter.destroy(); } catch (_) {}
        layer.blurFilter = null;
      }
      return;
    }
    if (!layer.blurFilter || layer.blurFilter.destroyed) {
      const blur = new PIXI.BlurFilter();
      blur.quality = SHADOW_BLUR_QUALITY_MIN;
      blur.repeatEdgePixels = true;
      layer.blurFilter = blur;
    }
    const zoom = this._getCanvasZoomScale();
    const targetBlur = Math.min(64, Math.max(0.25, blurAmount * Math.max(0.05, zoom)));
    layer.blurFilter.blur = targetBlur;
    layer.blurFilter.quality = this._computeBlurQuality(targetBlur);
    try {
      layer.blurFilter.padding = Math.ceil((targetBlur * 12) + Math.max(0, Number(layer.options?.maxDilation || layer.options?.dilation || 0)) + 4);
    } catch (_) {}
  }

  _getTileShadowOcclusionMask(doc) {
    return this._occlusionRuntime.getTileShadowOcclusionMask(doc);
  }

  _getSurfaceShadowOcclusionMask() {
    return this._occlusionRuntime.getSurfaceShadowOcclusionMask();
  }

  _isSurfaceOnlyShadowOcclusionMask(mask) {
    return this._occlusionRuntime.isSurfaceOnlyShadowOcclusionMask(mask);
  }

  _getTileShadowOccludedAlpha(doc) {
    return this._occlusionRuntime.getTileShadowOccludedAlpha(doc);
  }

  _getTileShadowOcclusionProfile(doc) {
    return this._occlusionRuntime.getTileShadowOcclusionProfile(doc);
  }

  _shouldLayerUseShadowOcclusion(layer) {
    return this._occlusionRuntime.shouldLayerUseShadowOcclusion(layer);
  }

  _ensureShadowOcclusionFilter(layer, holder = layer) {
    return this._occlusionRuntime.ensureShadowOcclusionFilter(layer, holder);
  }

  _syncShadowLayerFilters(layer) {
    return this._occlusionRuntime.syncShadowLayerFilters(layer);
  }

  _getLayerOcclusionDoc(layer) {
    return this._occlusionRuntime.getLayerOcclusionDoc(layer);
  }

  _syncShadowOcclusionMeshRuntime(layer, displayObject) {
    return this._occlusionRuntime.syncShadowOcclusionMeshRuntime(layer, displayObject);
  }

  _getTilePlaceableForDocument(doc) {
    return this._occlusionRuntime.getTilePlaceableForDocument(doc);
  }

  _prepareShadowOcclusionUniforms(layer, uniforms) {
    return this._occlusionRuntime.prepareShadowOcclusionUniforms(layer, uniforms);
  }

  _logShadowOcclusionIssue(layer, code, details = {}) {
    return this._occlusionRuntime.logShadowOcclusionIssue(layer, code, details);
  }

  _clearShadowOcclusionIssue(layer) {
    return this._occlusionRuntime.clearShadowOcclusionIssue(layer);
  }

  _getCanvasZoomScale() {
    const zoomX = Number(canvas?.stage?.scale?.x);
    const zoomY = Number(canvas?.stage?.scale?.y);
    const zoomCandidates = [];
    if (Number.isFinite(zoomX)) zoomCandidates.push(Math.abs(zoomX));
    if (Number.isFinite(zoomY)) zoomCandidates.push(Math.abs(zoomY));
    return zoomCandidates.length ? Math.max(...zoomCandidates) : 1;
  }

  _syncLayerRenderChunks(layer, renderChunks) {
    return this._renderWorkflow.syncLayerRenderChunks(layer, renderChunks);
  }

  _createLayerRenderChunk(layer, key) {
    return this._renderWorkflow.createLayerRenderChunk(layer, key);
  }

  _createShadowOcclusionChunkMesh(layer, key) {
    return this._occlusionRuntime.createShadowOcclusionChunkMesh(layer, key);
  }

  _destroyRenderResource(resource, destroyTexture = false) {
    return this._renderWorkflow.destroyRenderResource(resource, destroyTexture);
  }

  _hideLayerRenderChunk(layer, chunk) {
    return this._renderWorkflow.hideLayerRenderChunk(layer, chunk);
  }

  _destroyLayerRenderChunk(layer, chunk) {
    return this._renderWorkflow.destroyLayerRenderChunk(layer, chunk);
  }

  _ensureLayer(layerState) {
    const layerKey = layerState?.key;
    if (!layerKey) return null;
    if (this._layers.has(layerKey)) return this._layers.get(layerKey);
    if (!canvas || !canvas.ready) return null;

    const layer = {
      key: layerKey,
      elevation: Number(layerState?.elevation ?? 0) || 0,
      kind: String(layerState?.kind || 'normal').trim() || 'normal',
      placementLevelId: String(layerState?.placementLevelId || '').trim() || null,
      renderOrder: layerState?.renderOrder || null,
      shadowOcclusionKey: String(layerState?.shadowOcclusionKey || 'none'),
      shadowOcclusionProfile: layerState?.shadowOcclusionProfile || null,
      sceneId: this._sceneId || this._getActiveSceneId(),
      generation: this._sceneGeneration,
      container: null,
      sprite: null,
      renderTexture: null,
      renderChunks: new Map(),
      blurFilter: null,
      occlusionFilter: null,
      occlusionIssueKey: null,
      tiles: new Map(),
      options: { ...this._options },
      rebuilding: false,
      lastRebuildError: null,
      dirty: true
    };

    const container = new PIXI.Container();
    container.eventMode = 'none';
    container.sortableChildren = false;
    container.visible = true;
    container.name = `fa-nexus-shadow:${layerKey}`;

    const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
    sprite.anchor.set(0, 0);
    sprite.visible = false;
    sprite.eventMode = 'none';
    container.addChild(sprite);

    const parent = this._getCanvasParent();
    if (!parent) return null;
    parent.addChild(container);

    layer.container = container;
    layer.sprite = sprite;

    this._layers.set(layerKey, layer);
    this._syncLayerOrdering(layer);
    return layer;
  }

  _getCanvasParent() {
    try {
      if (canvas?.primary && typeof canvas.primary.addChild === 'function') return canvas.primary;
      if (canvas?.stage && typeof canvas.stage.addChild === 'function') return canvas.stage;
    } catch (_) {}
    return null;
  }

  /**
   * Materialize one client-local Building preview shadow through the same
   * descriptor, mesh, quality, blur, bounds, and ordering implementation used
   * by committed Building Tile shadows. The returned resources are detached;
   * the caller owns activation and must release them with
   * releaseLocalBuildingShadow().
   * `sills` are canonical managed-Sill parts already materialized into scene-world
   * coordinates, including their world normal, offset, and dilation.
   */
  async prepareLocalBuildingShadow({
    projectionId = '',
    requestGeneration = null,
    sections = [],
    portalArtwork = [],
    sills = [],
    placement = {},
    renderOrder = null,
    maxPixelCount = null
  } = {}) {
    const renderer = this._renderer || canvas?.app?.renderer;
    if (!renderer || !PIXI?.Container || !PIXI?.Sprite || !PIXI?.RenderTexture) {
      throw new Error('Local Building shadow preparation requires the active Pixi renderer.');
    }

    const normalizedSections = Array.isArray(sections) ? sections : [];
    const descriptors = [];
    for (const section of normalizedSections) {
      if (!section?.pathShadow || typeof section.pathShadow !== 'object') continue;
      const shadow = section.pathShadow;
      const enabled = shadow.enabled !== false;
      const layerOpacity = normalizeLayerOpacity(section?.layerOpacity, 1);
      const shadowAlpha = Math.min(1, Math.max(0, Number(shadow.alpha ?? 0.6)));
      if (!enabled || layerOpacity <= 0.001 || shadowAlpha <= 0.001) continue;
      const closed = section?.closed !== false;
      const minPoints = closed ? 3 : 2;
      const points = Array.isArray(section?.points)
        ? section.points.map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        : [];
      if (points.length < minPoints) continue;

      const baseWidth = Math.max(1, Number(section?.width) || 1);
      const repeatBase = Math.max(1e-3, Number(section?.repeatDistance) || baseWidth);
      const shadowScale = Math.min(4, Math.max(0.25, Number(shadow.scale) || 1));
      const dilation = Math.min(20, Math.max(0, Number(shadow.dilation) || 0));
      const scaledWidth = Math.max(2, baseWidth * shadowScale);
      const effectiveWidth = Math.max(2, scaledWidth + (dilation * 2));
      const textureOffset = {
        x: Number(section?.textureOffset?.x) || 0,
        y: Number(section?.textureOffset?.y) || 0
      };
      const descriptorOptions = {
        closed,
        width: effectiveWidth,
        sourceWidth: scaledWidth,
        shadowDilation: dilation,
        centerOffset: textureOffset.y + (Number(shadow.offset) || 0),
        sourceCenterOffset: textureOffset.y,
        textureOffset: { x: textureOffset.x, y: 0 },
        textureFlip: {
          horizontal: !!section?.textureFlip?.horizontal,
          vertical: !!section?.textureFlip?.vertical
        },
        textureRepeatDistance: Math.max(1, repeatBase * shadowScale),
        texturePhaseDistance: (Number(section?.texturePhaseDistance) || 0) * shadowScale,
        textureSrc: section?.textureSrc || null,
        textureKey: section?.textureKey || null,
        alphaMultiplier: layerOpacity,
        startJoinDir: section?.startJoinDir || null,
        endJoinDir: section?.endJoinDir || null,
        transformPoint: (point) => ({ x: Number(point?.x) || 0, y: Number(point?.y) || 0 }),
        reuseCenterlineGeometry: true
      };
      const sectionId = String(section?.sectionId || '');
      const descriptorSignature = JSON.stringify({ points, ...descriptorOptions, transformPoint: null });
      const cachedDescriptor = sectionId ? this._localBuildingShadowDescriptorBySectionId.get(sectionId) : null;
      let descriptor = cachedDescriptor?.signature === descriptorSignature ? cachedDescriptor.descriptor : null;
      if (!descriptor) {
        descriptor = this._buildBuildingShadowDescriptorFromLoop(null, points, descriptorOptions);
        if (descriptor && sectionId) {
          this._localBuildingShadowDescriptorBySectionId.delete(sectionId);
          this._localBuildingShadowDescriptorBySectionId.set(sectionId, { signature: descriptorSignature, descriptor });
          while (this._localBuildingShadowDescriptorBySectionId.size > 64) {
            this._localBuildingShadowDescriptorBySectionId.delete(this._localBuildingShadowDescriptorBySectionId.keys().next().value);
          }
        }
      }
      if (!descriptor) continue;
      descriptors.push({
        ...descriptor,
        localShadowConfig: {
          alpha: shadowAlpha,
          blur: Math.min(20, Math.max(0, Number(shadow.blur) || 0)),
          dilation: 0,
          offsetX: 0,
          offsetY: 0
        }
      });
    }

    for (const portal of Array.isArray(portalArtwork) ? portalArtwork : []) {
      const shadow = portal?.shadow;
      if (!shadow || shadow.enabled === false) continue;
      const shadowAlpha = Math.min(1, Math.max(0, Number(shadow.alpha) || 0));
      if (shadowAlpha <= 0.001) continue;
      const dilation = Math.max(0, Number(shadow.dilation) || 0);
      const offset = Number(shadow.offset) || 0;
      const normalX = Number(shadow.normal?.x);
      const normalY = Number(shadow.normal?.y);
      if (![normalX, normalY].every(Number.isFinite)) {
        throw new Error(`Local Building Door frame shadow is missing a finite carrier normal: ${String(portal?.portalId || '')}.`);
      }
      for (const artwork of portal?.artwork || []) {
        const width = Number(artwork?.width);
        const height = Number(artwork?.height);
        const x = Number(artwork?.x) + (normalX * offset);
        const y = Number(artwork?.y) + (normalY * offset);
        if (![width, height, x, y, Number(artwork?.rotation)].every(Number.isFinite) || !(width > 0) || !(height > 0)) {
          throw new Error(`Local Building Door frame shadow has non-finite artwork: ${String(portal?.portalId || '')}.`);
        }
        const expandedWidth = width + (dilation * 2);
        const expandedHeight = height + (dilation * 2);
        descriptors.push({
          kind: 'buildingCompositeSprite',
          textureSrc: artwork.textureSrc,
          sourceFrame: artwork.sourceFrame || null,
          x,
          y,
          width: expandedWidth,
          height: expandedHeight,
          rotation: Number(artwork.rotation),
          flipX: Number(artwork.flipX) < 0 ? -1 : 1,
          flipY: Number(artwork.flipY) < 0 ? -1 : 1,
          bounds: this._computeBuildingCompositePartBounds({ x, y, width: expandedWidth, height: expandedHeight,
            rotation: Number(artwork.rotation) * (180 / Math.PI) }),
          shadowDilation: 0,
          alphaMultiplier: 1,
          localShadowConfig: {
            alpha: shadowAlpha,
            blur: Math.min(20, Math.max(0, Number(shadow.blur) || 0)),
            dilation: 0,
            offsetX: 0,
            offsetY: 0
          }
        });
      }
    }

    for (const sill of Array.isArray(sills) ? sills : []) {
      const sillKind = String(sill?.kind || sill?.elementType || '').toLowerCase();
      if (sill?.role !== 'sill' || (sillKind !== 'sill' && sill?.flagKey !== 'buildingWindowSill')) {
        throw new Error(`Local Building Window sill shadow has an invalid owned part: ${String(sill?.id || '')}.`);
      }
      const shadow = sill?.shadow;
      if (!shadow || shadow.enabled === false) continue;
      const shadowAlpha = Math.min(1, Math.max(0, Number(shadow.alpha) || 0));
      if (shadowAlpha <= 0.001) continue;
      const normalX = Number(shadow.normal?.x);
      const normalY = Number(shadow.normal?.y);
      const offset = Number(shadow.offset);
      const dilation = Math.max(0, Number(shadow.dilation) || 0);
      const x = Number(sill.x);
      const y = Number(sill.y);
      const width = Number(sill.width);
      const height = Number(sill.height);
      const rotationDegrees = Number(sill.rotation);
      const textureSrc = this._getBuildingCompositePartTextureSrc(sill);
      if (![normalX, normalY, offset, x, y, width, height, rotationDegrees].every(Number.isFinite)
        || !(width > 0) || !(height > 0) || !textureSrc) {
        throw new Error(`Local Building Window sill shadow has non-finite artwork: ${String(sill?.id || '')}.`);
      }
      const bounds = this._computeBuildingCompositePartBounds(sill);
      if (!bounds) {
        throw new Error(`Local Building Window sill shadow has no finite bounds: ${String(sill?.id || '')}.`);
      }
      const texture = sill?.texture && typeof sill.texture === 'object' ? sill.texture : {};
      descriptors.push({
        kind: 'buildingCompositeSprite',
        textureSrc,
        sourceFrame: sill.sourceFrame || null,
        x,
        y,
        width,
        height,
        rotation: rotationDegrees * (Math.PI / 180),
        flipX: Number(texture.scaleX ?? sill.flipX ?? 1) < 0 ? -1 : 1,
        flipY: Number(texture.scaleY ?? sill.flipY ?? 1) < 0 ? -1 : 1,
        bounds,
        shadowDilation: dilation,
        alphaMultiplier: normalizeLayerOpacity(sill.alpha, 1),
        localShadowConfig: {
          alpha: shadowAlpha,
          blur: Math.min(20, Math.max(0, Number(shadow.blur) || 0)),
          dilation,
          offsetX: normalX * offset,
          offsetY: normalY * offset
        }
      });
    }

    if (!descriptors.length) {
      return {
        projectionId: String(projectionId || ''),
        root: null,
        renderEnvelope: null,
        released: false
      };
    }

    const profileGroups = new Map();
    let descriptorBounds = null;
    for (const descriptor of descriptors) {
      const config = descriptor.localShadowConfig || {};
      const alpha = Math.min(1, Math.max(0, Number(config.alpha) || 0));
      const blur = Math.min(20, Math.max(0, Number(config.blur) || 0));
      const dilation = Math.max(0, Number(config.dilation) || 0);
      const offsetX = Number(config.offsetX) || 0;
      const offsetY = Number(config.offsetY) || 0;
      if (alpha <= 0.001) continue;
      const key = JSON.stringify([alpha, blur]);
      let group = profileGroups.get(key);
      if (!group) {
        group = { alpha, blur, descriptors: [] };
        profileGroups.set(key, group);
      }
      group.descriptors.push(descriptor);

      const bounds = normalizeWorldBounds(descriptor.bounds);
      if (!bounds) continue;
      const margin = dilation + (blur * 12);
      descriptorBounds = mergeWorldBounds(descriptorBounds, {
        minX: bounds.minX + offsetX - margin,
        minY: bounds.minY + offsetY - margin,
        maxX: bounds.maxX + offsetX + margin,
        maxY: bounds.maxY + offsetY + margin
      });
    }
    if (!profileGroups.size || !descriptorBounds) {
      throw new Error('Local Building shadow descriptors produced no finite bounds.');
    }
    let sceneRect = rectFromWorldBounds(descriptorBounds, 0);
    const pixelBudget = Number(maxPixelCount);
    const budgetScale = Number.isFinite(pixelBudget) && pixelBudget > 0
      ? Math.sqrt(pixelBudget / Math.max(1, sceneRect.width * sceneRect.height * profileGroups.size))
      : 1;
    const scale = Math.min(this._computeTextureScale(sceneRect), budgetScale);
    let texWidth = Math.max(4, Math.round(sceneRect.width * scale));
    let texHeight = Math.max(4, Math.round(sceneRect.height * scale));
    if (!Number.isFinite(texWidth) || !Number.isFinite(texHeight)) {
      throw new Error('Local Building shadow produced an invalid render target.');
    }

    const drawContainers = [];
    const resources = [];
    const ownedTextures = [];
    if (!(Number.isFinite(pixelBudget) && pixelBudget > 0)) {
      const textureLimit = this._getMaxTextureSize();
      const paddedDimension = (value) => {
        const headroom = Math.min(512, Math.max(128, value * 0.125));
        return Math.min(textureLimit, Math.ceil((value + headroom) / 256) * 256);
      };
      texWidth = Math.max(texWidth, paddedDimension(texWidth));
      texHeight = Math.max(texHeight, paddedDimension(texHeight));
    }
    const renderTargets = Array.from(profileGroups.values()).map((group) => ({
      group,
      target: this._acquireLocalBuildingShadowTextureTarget(texWidth, texHeight)
    }));
    // Direct Rectangle construction changes the prospective shadow bounds by a
    // few pixels on nearly every frame. Keep an acquired full-quality target at
    // least as large as its previous allocation and render into transparent
    // padding instead of destroying and reallocating two GPU textures each time.
    // The scale remains exact; only the invisible right/bottom envelope grows.
    if (!(Number.isFinite(pixelBudget) && pixelBudget > 0)) {
      const retainedWidth = renderTargets.reduce((max, { target }) => Math.max(
        max,
        Number(target.renderTexture?.width) || 0,
        Number(target.rawRenderTexture?.width) || 0
      ), 0);
      const retainedHeight = renderTargets.reduce((max, { target }) => Math.max(
        max,
        Number(target.renderTexture?.height) || 0,
        Number(target.rawRenderTexture?.height) || 0
      ), 0);
      texWidth = Math.max(texWidth, retainedWidth);
      texHeight = Math.max(texHeight, retainedHeight);
      sceneRect = {
        ...sceneRect,
        width: texWidth / scale,
        height: texHeight / scale
      };
    }
    let root = null;
    try {
      root = new PIXI.Container();
      root.name = `fa-nexus-building-v2-shadow:${String(projectionId || 'preview')}`;
      root.faNexusBuildingV2RequestGeneration = Number(requestGeneration);
      root.eventMode = 'none';
      root.interactiveChildren = false;
      for (const { group, target } of renderTargets) {
        const drawContainer = new PIXI.Container();
        drawContainer.eventMode = 'none';
        drawContainer.interactiveChildren = false;
        drawContainers.push(drawContainer);
        for (const descriptor of group.descriptors) {
          const config = descriptor.localShadowConfig || {};
          const dilationRadius = Math.max(0, Number(config.dilation) || 0) * scale;
          const offsets = descriptor.kind === 'buildingCompositeSprite' && dilationRadius >= 0.5
            ? this._buildDilationOffsets(dilationRadius)
            : [{ x: 0, y: 0 }];
          for (const dilationOffset of offsets) {
            const mesh = descriptor.kind === 'buildingCompositeSprite'
              ? await this._createBuildingCompositePartShadowSprite(descriptor, {
                  scale,
                  sceneRect,
                  dilationOffset,
                  offsetX: (Number(config.offsetX) || 0) * scale,
                  offsetY: (Number(config.offsetY) || 0) * scale,
                  tempTextures: ownedTextures
                })
              : await this._createBuildingShadowMesh(descriptor, { scale, sceneRect });
            if (!mesh) throw new Error('Local Building shadow mesh materialization failed.');
            drawContainer.addChild(mesh);
            resources.push(mesh);
          }
        }
        const renderTexture = this._renderLayerToTexture(
          { container: null, options: { alpha: group.alpha, blur: group.blur, maxDilation: 0 }, renderTexture: null },
          drawContainer,
          renderer,
          texWidth,
          texHeight,
          { renderTarget: target, scale, layerOptions: { alpha: group.alpha, blur: group.blur, maxDilation: 0 } }
        );
        if (!renderTexture) throw new Error('Local Building shadow render produced no texture.');

        const sprite = new PIXI.Sprite(renderTexture);
        sprite.name = `fa-nexus-building-v2-shadow-sprite:${String(projectionId || 'preview')}:${shadowRenderProfileKey(group, this._options)}`;
        sprite.faNexusBuildingV2RequestGeneration = Number(requestGeneration);
        sprite.anchor.set(0, 0);
        sprite.position.set(sceneRect.x, sceneRect.y);
        sprite.width = sceneRect.width;
        sprite.height = sceneRect.height;
        sprite.alpha = group.alpha;
        sprite.eventMode = 'none';
        root.addChild(sprite);
      }
      const primaryTarget = renderTargets[0]?.target || null;
      const prepared = {
        projectionId: String(projectionId || ''),
        root,
        parent: null,
        renderEnvelope: {
          minX: sceneRect.x,
          minY: sceneRect.y,
          maxX: sceneRect.x + sceneRect.width,
          maxY: sceneRect.y + sceneRect.height,
          width: sceneRect.width,
          height: sceneRect.height
        },
        released: false,
        renderTargets: renderTargets.map(({ target }) => target),
        renderTexture: primaryTarget?.renderTexture || null,
        rawRenderTexture: primaryTarget?.rawRenderTexture || null
      };
      this.syncLocalBuildingShadowOrdering(prepared, { placement, renderOrder });
      return prepared;
    } catch (error) {
      try {
        for (const child of root?.children || []) child.texture = PIXI.Texture.EMPTY;
      } catch (_) {}
      try { root?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      for (const { target } of renderTargets) {
        try { target.renderTexture?.destroy?.(true); } catch (_) {}
        try { target.rawRenderTexture?.destroy?.(true); } catch (_) {}
      }
      throw error;
    } finally {
      for (const resource of resources) {
        try { resource?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      for (const texture of ownedTextures) {
        try { texture?.destroy?.(false); } catch (_) {}
      }
      for (const drawContainer of drawContainers) {
        try { drawContainer.destroy({ children: false }); } catch (_) {}
      }
    }
  }

  syncLocalBuildingShadowOrdering(prepared, { placement = {}, renderOrder = null } = {}) {
    const root = prepared?.root || null;
    if (!root || prepared?.released) return false;
    const predicted = this.resolvePreviewShadowLayerOrder({
      elevation: Number(placement?.elevation) || 0,
      sort: Number(placement?.previewSort ?? placement?.sort) || 0,
      renderOrder
    });
    Object.assign(root, {
      sort: predicted.sort,
      faNexusSort: predicted.sort,
      zIndex: predicted.sort,
      sortLayer: predicted.sortLayer,
      elevation: predicted.elevation,
      faNexusElevation: predicted.elevation,
      faNexusElevationDoc: predicted.documentElevation,
      faNexusPlacementLevelId: predicted.placementLevelId,
      faNexusBandKind: predicted.kind
    });
    prepared.parent = predicted.parent;
    const parent = root.parent || prepared.parent;
    if (parent && 'sortDirty' in parent) parent.sortDirty = true;
    parent?.sortChildren?.();
    return true;
  }

  releaseLocalBuildingShadow(prepared) {
    if (!prepared || prepared.released) return false;
    prepared.released = true;
    try { prepared.root?.parent?.removeChild?.(prepared.root); } catch (_) {}
    try {
      for (const child of prepared.root?.children || []) child.texture = PIXI.Texture.EMPTY;
    } catch (_) {}
    try { prepared.root?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    const renderTargets = Array.isArray(prepared.renderTargets) && prepared.renderTargets.length
      ? prepared.renderTargets
      : [{ renderTexture: prepared.renderTexture, rawRenderTexture: prepared.rawRenderTexture }];
    for (const target of renderTargets) this._recycleLocalBuildingShadowTextureTarget(target);
    prepared.root = null;
    prepared.renderTargets = null;
    prepared.renderTexture = null;
    prepared.rawRenderTexture = null;
    return true;
  }

  _localBuildingShadowTextureTargetKey(renderTexture, rawRenderTexture) {
    const width = Number(renderTexture?.width);
    const height = Number(renderTexture?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)
      || width < 1 || height < 1
      || rawRenderTexture?.width !== width || rawRenderTexture?.height !== height) return null;
    return `${width}x${height}`;
  }

  _acquireLocalBuildingShadowTextureTarget(width, height) {
    if (this._localBuildingShadowTexturePoolTimer != null) {
      clearTimeout(this._localBuildingShadowTexturePoolTimer);
      this._localBuildingShadowTexturePoolTimer = null;
    }
    const key = `${Number(width)}x${Number(height)}`;
    const pooled = this._localBuildingShadowTexturePool.get(key) || null;
    if (pooled) this._localBuildingShadowTexturePool.delete(key);
    if (pooled?.renderTexture && pooled?.rawRenderTexture
      && pooled.renderTexture.destroyed !== true && pooled.rawRenderTexture.destroyed !== true) return pooled;
    try { pooled?.renderTexture?.destroy?.(true); } catch (_) {}
    try { pooled?.rawRenderTexture?.destroy?.(true); } catch (_) {}
    // A held geometry gesture commonly changes the shadow bounds by a pixel or
    // two every generation. Reuse one differently-sized inactive target and let
    // the render workflow resize it, rather than retaining an unbounded map of
    // full-size GPU textures until the pointer finally stops moving.
    const fallbackEntry = this._localBuildingShadowTexturePool.entries().next().value || null;
    if (fallbackEntry) {
      const [fallbackKey, fallback] = fallbackEntry;
      this._localBuildingShadowTexturePool.delete(fallbackKey);
      if (fallback?.renderTexture?.destroyed !== true && fallback?.rawRenderTexture?.destroyed !== true) {
        return fallback;
      }
      try { fallback?.renderTexture?.destroy?.(true); } catch (_) {}
      try { fallback?.rawRenderTexture?.destroy?.(true); } catch (_) {}
    }
    return { renderTexture: null, rawRenderTexture: null };
  }

  _recycleLocalBuildingShadowTextureTarget(target) {
    const key = this._localBuildingShadowTextureTargetKey(target?.renderTexture, target?.rawRenderTexture);
    if (!key || target.renderTexture.destroyed === true || target.rawRenderTexture.destroyed === true) {
      try { target?.renderTexture?.destroy?.(true); } catch (_) {}
      try { target?.rawRenderTexture?.destroy?.(true); } catch (_) {}
      return false;
    }
    const displaced = this._localBuildingShadowTexturePool.get(key) || null;
    if (displaced) {
      try { displaced.renderTexture?.destroy?.(true); } catch (_) {}
      try { displaced.rawRenderTexture?.destroy?.(true); } catch (_) {}
    }
    this._localBuildingShadowTexturePool.set(key, target);
    while (this._localBuildingShadowTexturePool.size > LOCAL_BUILDING_SHADOW_TEXTURE_POOL_LIMIT) {
      const oldestKey = this._localBuildingShadowTexturePool.keys().next().value;
      const oldest = this._localBuildingShadowTexturePool.get(oldestKey);
      this._localBuildingShadowTexturePool.delete(oldestKey);
      try { oldest?.renderTexture?.destroy?.(true); } catch (_) {}
      try { oldest?.rawRenderTexture?.destroy?.(true); } catch (_) {}
    }
    if (this._localBuildingShadowTexturePoolTimer != null) clearTimeout(this._localBuildingShadowTexturePoolTimer);
    this._localBuildingShadowTexturePoolTimer = setTimeout(() => {
      this._localBuildingShadowTexturePoolTimer = null;
      this._clearLocalBuildingShadowTexturePool();
    }, 1500);
    return true;
  }

  _clearLocalBuildingShadowTexturePool() {
    if (this._localBuildingShadowTexturePoolTimer != null) {
      clearTimeout(this._localBuildingShadowTexturePoolTimer);
      this._localBuildingShadowTexturePoolTimer = null;
    }
    for (const target of this._localBuildingShadowTexturePool.values()) {
      try { target.renderTexture?.destroy?.(true); } catch (_) {}
      try { target.rawRenderTexture?.destroy?.(true); } catch (_) {}
    }
    this._localBuildingShadowTexturePool.clear();
    this._localBuildingShadowDescriptorBySectionId?.clear?.();
  }

  resolvePreviewShadowLayerOrder({ elevation = 0, sort = 0, renderOrder = null } = {}) {
    const documentElevation = Number(elevation) || 0;
    const documentSort = Number(sort) || 0;
    const placementLevelId = String(renderOrder?.placementLevelId || '').trim() || null;
    const kind = String(renderOrder?.kind || 'normal').trim() || 'normal';
    const targetSortLayer = Number(renderOrder?.sortLayer ?? 0) || 0;
    const rawTargetRenderElevation = Number(renderOrder?.renderElevation ?? renderOrder?.elevation);
    const targetRenderElevation = Number.isFinite(rawTargetRenderElevation) ? rawTargetRenderElevation : documentElevation;
    const shadowOcclusionProfile = this._getTileShadowOcclusionProfile({
      occlusion: getFaNexusPlacementOcclusionDefaults()
    });
    const matchingLayers = Array.from(this._layers.values()).filter((layer) => (
      layer?.container
      && !layer.container.destroyed
      && Number(layer.elevation ?? 0) === documentElevation
      && (String(layer.placementLevelId || '').trim() || null) === placementLevelId
      && String(layer.kind || 'normal') === kind
      && (Number(layer.renderOrder?.sortLayer ?? 0) || 0) === targetSortLayer
      && (Number(layer.renderOrder?.renderElevation ?? layer.renderOrder?.elevation ?? layer.elevation ?? 0) || 0) === targetRenderElevation
      && layer.shadowOcclusionKey === shadowOcclusionProfile.key
    ));
    const matchedLayer = matchingLayers[0] || null;
    const predictionLayer = matchedLayer || {
      elevation: documentElevation,
      placementLevelId,
      renderOrder,
      tiles: new Map()
    };
    const predictedOrder = predictionLayer.renderOrder || renderOrder;
    return {
      parent: this._getCanvasParent(),
      sortLayer: Number(predictedOrder?.sortLayer ?? targetSortLayer) || 0,
      sort: this._computeSortBelow(predictionLayer, { additionalSorts: [documentSort] }),
      elevation: Number.isFinite(Number(predictedOrder?.renderElevation ?? predictedOrder?.elevation))
        ? Number(predictedOrder.renderElevation ?? predictedOrder.elevation)
        : targetRenderElevation,
      documentElevation,
      placementLevelId,
      kind,
      shadowOcclusionKey: shadowOcclusionProfile.key
    };
  }

  _syncLayerOrdering(layer) {
    if (!layer || !layer.container) return;
    try {
      const container = layer.container;
      const docElevation = Number(layer.elevation || 0);
      const sort = this._computeSortBelow(layer);
      const renderOrder = layer.renderOrder || resolveTileRenderOrder({ elevation: docElevation, sort: 0 }, {
        elevation: docElevation,
        placementLevelId: layer.placementLevelId || null
      });
      if (Number.isFinite(sort)) {
        try { container.sort = sort; } catch (_) {}
        try { container.faNexusSort = sort; } catch (_) {}
        try { container.zIndex = sort; } catch (_) {}
      }
      try { container.faNexusElevationDoc = docElevation; } catch (_) {}
      try { container.faNexusElevation = renderOrder.elevation; } catch (_) {}
      try { container.faNexusPlacementLevelId = layer.placementLevelId || null; } catch (_) {}
      try { container.faNexusBandKind = layer.kind || 'normal'; } catch (_) {}
      try { container.elevation = renderOrder.elevation; } catch (_) {}
      try { container.sortLayer = renderOrder.sortLayer; } catch (_) {}
      const parent = container.parent;
      if (parent && 'sortDirty' in parent) {
        try { parent.sortDirty = true; } catch (_) {}
      }
      try { parent?.sortChildren?.(); } catch (_) {}
    } catch (e) {
      Logger.warn('AssetShadow.syncOrdering.failed', String(e?.message || e));
    }
  }

  _clearAllLayers() {
    this._previewSuppressionController?.cancelAll?.('clear-all-layers');
    this._rebuildWorkflow.clearAll();
    for (const elevation of Array.from(this._layers.keys())) {
      this._destroyLayer(elevation);
    }
    this._layers.clear();
    this._tileIndex.clear();
    this._clearSourceTextureCache('clear-all-layers');
    this._clearScatterShadowCache();
    this._clearStandardMaskShadowCache();
    this._clearLocalBuildingShadowTexturePool();
    this._levelScopeWarnings.clear();
    this._blankRenderValidationBudget = SHADOW_BLANK_VALIDATION_BUDGET;
    this._previewElevationOverrides.clear();
    this._previewShadowOverrides.clear();
  }

  _destroyLayer(elevation) {
    const layer = this._layers.get(elevation);
    if (!layer) return;
    this._rebuildWorkflow.clearTimer(elevation);
    if (layer.sprite) {
      try { layer.sprite.filters = null; } catch (_) {}
    }
    if (layer.container) {
      try { layer.container.filters = null; } catch (_) {}
    }
    if (layer.renderChunks?.size) {
      for (const chunk of layer.renderChunks.values()) {
        this._destroyLayerRenderChunk(layer, chunk);
      }
      layer.renderChunks.clear();
    }
    this._destroyRenderResource(layer.renderTexture, true);
    this._destroyRenderResource(layer.rawRenderTexture, true);
    layer.renderTexture = null;
    layer.rawRenderTexture = null;
    this._destroyRenderResource(layer.blurFilter);
    layer.blurFilter = null;
    this._destroyRenderResource(layer.occlusionFilter);
    layer.occlusionFilter = null;
    if (layer.container) {
      try {
        const parent = layer.container.parent;
        if (parent) parent.removeChild(layer.container);
      } catch (_) {}
      try { layer.container.destroy({ children: true }); } catch (_) {}
    }
    for (const tileId of layer.tiles?.keys?.() || []) {
      if (this._tileIndex.get(tileId) === elevation) this._tileIndex.delete(tileId);
      this._suspendedTiles.delete(tileId);
    }
    this._layers.delete(elevation);
  }

  _isShadowTile(doc) {
    try {
      const hidden = doc?.hidden ?? doc?._source?.hidden;
      if (hidden && !game?.user?.isGM) return false;
      const alpha = Number(doc?.alpha ?? 1);
      if (Number.isFinite(alpha) && alpha <= 0) return false;
      if (doc?.getFlag?.(MODULE_ID, LAYER_HIDDEN_FLAG)) return false;
      return this._resolveShadowEnabled(doc);
    } catch (_) {
      const hidden = doc?._source?.hidden;
      if (hidden && !game?.user?.isGM) return false;
      const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
      if (!flags) return false;
      if (flags[LAYER_HIDDEN_FLAG]) return false;
      const alpha = Number(doc?.alpha ?? 1);
      if (Number.isFinite(alpha) && alpha <= 0) return false;
      return this._resolveShadowEnabled(doc);
    }
  }

  _getTilePreviewShadowOverride(doc) {
    const tileId = String(doc?.id || doc?._id || '').trim();
    if (!tileId) return null;
    return this._previewShadowOverrides.get(tileId) || null;
  }

  _readTileShadowNumber(doc, key) {
    const override = this._getTilePreviewShadowOverride(doc);
    if (override && Object.prototype.hasOwnProperty.call(override, key)) {
      const numeric = Number(override[key]);
      if (Number.isFinite(numeric)) return numeric;
    }
    try {
      const value = doc?.getFlag?.(MODULE_ID, key);
      if (value !== undefined && value !== null) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
      }
    } catch (_) {}
    try {
      const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
      if (flags && Object.prototype.hasOwnProperty.call(flags, key)) {
        const numeric = Number(flags[key]);
        if (Number.isFinite(numeric)) return numeric;
      }
    } catch (_) {}
    return this._readBuildingCompositeShadowNumber(doc, key);
  }

  _resolveShadowEnabled(doc) {
    const override = this._getTilePreviewShadowOverride(doc);
    if (override && Object.prototype.hasOwnProperty.call(override, 'enabled')) {
      return !!override.enabled;
    }
    if (this._getIndependentBuildingPortalShadow(doc)) return true;
    try {
      const value = doc?.getFlag?.(MODULE_ID, 'shadow');
      if (value !== undefined && value !== null) return !!value;
    } catch (_) {}
    const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
    return !!flags?.shadow || this._hasBuildingCompositeSillShadowParts(doc);
  }

  _normalizePreviewShadowOverride(override = {}) {
    if (!override || typeof override !== 'object') return null;
    const normalized = {};
    if (Object.prototype.hasOwnProperty.call(override, 'enabled')) {
      normalized.enabled = !!override.enabled;
    }
    if (Object.prototype.hasOwnProperty.call(override, 'shadowAlpha') || Object.prototype.hasOwnProperty.call(override, 'alpha')) {
      normalized.shadowAlpha = Math.min(1, Math.max(0, Number(override.shadowAlpha ?? override.alpha ?? this._options.alpha ?? 0.65)));
    }
    if (Object.prototype.hasOwnProperty.call(override, 'shadowDilation') || Object.prototype.hasOwnProperty.call(override, 'dilation')) {
      normalized.shadowDilation = Math.max(0, Number(override.shadowDilation ?? override.dilation ?? this._options.dilation ?? 0));
    }
    if (Object.prototype.hasOwnProperty.call(override, 'shadowBlur') || Object.prototype.hasOwnProperty.call(override, 'blur')) {
      normalized.shadowBlur = Math.max(0, Number(override.shadowBlur ?? override.blur ?? this._options.blur ?? 0));
    }
    if (Object.prototype.hasOwnProperty.call(override, 'shadowOffsetDistance') || Object.prototype.hasOwnProperty.call(override, 'offsetDistance')) {
      normalized.shadowOffsetDistance = Math.min(
        MAX_OFFSET_DISTANCE,
        Math.max(0, Number(override.shadowOffsetDistance ?? override.offsetDistance ?? this._options.offsetDistance ?? 0))
      );
    }
    if (Object.prototype.hasOwnProperty.call(override, 'shadowOffsetAngle') || Object.prototype.hasOwnProperty.call(override, 'offsetAngle')) {
      normalized.shadowOffsetAngle = this._normalizeAngle(override.shadowOffsetAngle ?? override.offsetAngle ?? this._options.offsetAngle ?? 135);
    }
    if (Object.prototype.hasOwnProperty.call(override, 'shadowOffsetX') || Object.prototype.hasOwnProperty.call(override, 'offsetX')) {
      normalized.shadowOffsetX = Math.max(
        -MAX_OFFSET_DISTANCE,
        Math.min(MAX_OFFSET_DISTANCE, Number(override.shadowOffsetX ?? override.offsetX ?? 0))
      );
    }
    if (Object.prototype.hasOwnProperty.call(override, 'shadowOffsetY') || Object.prototype.hasOwnProperty.call(override, 'offsetY')) {
      normalized.shadowOffsetY = Math.max(
        -MAX_OFFSET_DISTANCE,
        Math.min(MAX_OFFSET_DISTANCE, Number(override.shadowOffsetY ?? override.offsetY ?? 0))
      );
    }
    if (Object.prototype.hasOwnProperty.call(override, 'pathShadowOffsetPx')) {
      normalized.pathShadowOffsetPx = Math.max(
        -MAX_OFFSET_DISTANCE,
        Math.min(MAX_OFFSET_DISTANCE, Number(override.pathShadowOffsetPx ?? 0))
      );
    }
    if (Object.prototype.hasOwnProperty.call(override, 'pathShadowScale') || Object.prototype.hasOwnProperty.call(override, 'shadowScale') || Object.prototype.hasOwnProperty.call(override, 'scale')) {
      const rawScale = Number(override.pathShadowScale ?? override.shadowScale ?? override.scale);
      if (Number.isFinite(rawScale)) normalized.pathShadowScale = Math.max(0.05, rawScale);
    }
    return Object.keys(normalized).length ? normalized : null;
  }

  _getElevationPreviewShadowOverride(elevation) {
    const numericElevation = Number(elevation);
    if (!Number.isFinite(numericElevation)) return null;
    const stack = this._previewElevationOverrides.get(numericElevation);
    if (stack && !Array.isArray(stack)) return stack;
    if (!stack?.length) return null;
    return stack[stack.length - 1]?.override || null;
  }

  _normalizeElevationPreviewShadowOverride(override = {}) {
    if (!override || typeof override !== 'object') return null;
    const normalized = {};
    if (Object.prototype.hasOwnProperty.call(override, 'shadowAlpha') || Object.prototype.hasOwnProperty.call(override, 'alpha')) {
      normalized.alpha = Math.min(1, Math.max(0, Number(override.shadowAlpha ?? override.alpha ?? this._options.alpha ?? 0.65)));
    }
    if (Object.prototype.hasOwnProperty.call(override, 'shadowBlur') || Object.prototype.hasOwnProperty.call(override, 'blur')) {
      normalized.blur = Math.max(0, Number(override.shadowBlur ?? override.blur ?? this._options.blur ?? 0));
    }
    return Object.keys(normalized).length ? normalized : null;
  }

  setElevationPreviewShadowOverride(elevation, override = null, { immediate = true, owner = null } = {}) {
    try {
      const numericElevation = Number(elevation);
      if (!Number.isFinite(numericElevation)) return false;
      const ownerToken = owner || this;
      const currentStack = this._previewElevationOverrides.get(numericElevation);
      const stack = Array.isArray(currentStack)
        ? currentStack.filter((entry) => entry?.owner !== ownerToken)
        : (currentStack ? [{ owner: this, override: currentStack }] : [])
          .filter((entry) => entry.owner !== ownerToken);
      const normalizedOverride = this._normalizeElevationPreviewShadowOverride(override);
      if (normalizedOverride) stack.push({ owner: ownerToken, override: normalizedOverride });
      if (stack.length) this._previewElevationOverrides.set(numericElevation, stack);
      else this._previewElevationOverrides.delete(numericElevation);
      this._scheduleRebuild(numericElevation, immediate);
      return true;
    } catch (error) {
      Logger.warn('AssetShadow.previewElevationOverride.failed', {
        elevation,
        error: String(error?.message || error)
      });
      return false;
    }
  }

  clearElevationPreviewShadowOverride(elevation, options = {}) {
    return this.setElevationPreviewShadowOverride(elevation, null, options);
  }

  setTilePreviewShadowOverride(tileDocument, override = null, { immediate = true } = {}) {
    try {
      const doc = tileDocument?.document ?? tileDocument;
      const tileId = String(doc?.id || doc?._id || '').trim();
      if (!doc || !tileId) return false;
      if (!this._isActiveSceneDocument(doc, { phase: 'previewShadowOverride' })) return false;

      const previousRenderable = this._isShadowRenderableTile(doc, { phase: 'previewShadowOverride:before', log: false });
      const previousLayerKey = this._tileIndex.get(tileId) || null;
      const normalizedOverride = this._normalizePreviewShadowOverride(override);
      if (normalizedOverride) this._previewShadowOverrides.set(tileId, normalizedOverride);
      else this._previewShadowOverrides.delete(tileId);

      const nextRenderable = this._isShadowRenderableTile(doc, { phase: 'previewShadowOverride:after', log: false });
      const nextLayerKey = nextRenderable ? (this._getTileLayerState(doc)?.key || null) : null;

      if (previousRenderable && (!nextRenderable || (previousLayerKey && nextLayerKey && previousLayerKey !== nextLayerKey))) {
        this._removeTile(doc);
      }
      if (nextRenderable) {
        this._addTile(doc, { deferRebuild: true });
      }

      const rebuildTargets = new Set([previousLayerKey, nextLayerKey].filter(Boolean));
      for (const target of rebuildTargets) {
        this._scheduleRebuild(target, immediate);
      }
      return true;
    } catch (error) {
      Logger.warn('AssetShadow.previewOverride.failed', {
        tileId: tileDocument?.id || tileDocument?._id || tileDocument?.document?.id || null,
        error: String(error?.message || error)
      });
      return false;
    }
  }

  clearTilePreviewShadowOverride(tileDocument, options = {}) {
    return this.setTilePreviewShadowOverride(tileDocument, null, options);
  }

  _isShadowRenderableTile(doc, { phase = 'unknown', log = true, changes = null } = {}) {
    if (!this._isShadowTile(doc)) return false;
    return this._isTileInCurrentLevelScope(doc, { phase, log, changes });
  }

  _isTileInCurrentLevelScope(doc, { phase = 'unknown', log = true, changes = null } = {}) {
    let tileLevelIds = [];
    try {
      tileLevelIds = getRawLevelIds(doc);
    } catch (error) {
      Logger.warn('AssetShadow.levelScope.readFailed', {
        phase,
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return false;
    }

    if (!tileLevelIds.length) return true;

    let currentLevelIds = [];
    try {
      currentLevelIds = getCurrentViewedLevelIds(doc?.parent || canvas?.scene);
    } catch (error) {
      Logger.warn('AssetShadow.levelScope.currentLevelReadFailed', {
        phase,
        tileId: doc?.id || null,
        tileLevelIds,
        error: String(error?.message || error)
      });
      return false;
    }

    const currentSet = new Set((Array.isArray(currentLevelIds) ? currentLevelIds : [])
      .map((levelId) => String(levelId || '').trim())
      .filter(Boolean));
    const usesNativeLevelScope = typeof doc?.includedInLevel === 'function' && currentSet.size > 0;
    if (usesNativeLevelScope) {
      try {
        if (Array.from(currentSet).some((levelId) => doc.includedInLevel(levelId))) return true;
      } catch (error) {
        Logger.warn('AssetShadow.levelScope.nativeCheckFailed', {
          phase,
          tileId: doc?.id || null,
          tileLevelIds,
          currentLevelIds: Array.from(currentSet),
          error: String(error?.message || error)
        });
        return false;
      }
    } else if (tileLevelIds.some((levelId) => currentSet.has(String(levelId || '').trim()))) {
      return true;
    }

    if (log) {
      const sceneId = this._getDocumentSceneId(doc) || this._sceneId || this._getActiveSceneId() || 'unknown-scene';
      const warningKey = `${sceneId}:${doc?.id || 'unknown-tile'}:${tileLevelIds.join(',')}:${Array.from(currentSet).join(',')}`;
      const payload = {
        phase,
        tileId: doc?.id || null,
        sceneId,
        tileLevelIds,
        currentLevelIds: Array.from(currentSet),
        nativeLevelScope: usesNativeLevelScope,
        levelChanged: Object.prototype.hasOwnProperty.call(changes || {}, 'levels')
      };
      if (!currentSet.size && !this._levelScopeWarnings.has(warningKey)) {
        this._levelScopeWarnings.add(warningKey);
        Logger.warn('AssetShadow.levelScope.currentLevelMissing', payload);
      } else {
        Logger.debug?.('AssetShadow.levelScope.excluded', payload);
      }
    }
    return false;
  }

  _getTileElevation(doc) {
    try { return Number(doc.elevation ?? 0) || 0; }
    catch (_) { return 0; }
  }

  _getTileLayerState(doc) {
    const elevation = this._getTileElevation(doc);
    const renderOrder = resolveTileRenderOrder(doc);
    const placementLevelId = String(renderOrder?.placementLevelId || '').trim() || null;
    const kind = String(renderOrder?.kind || 'normal').trim() || 'normal';
    const renderElevation = Number(renderOrder?.elevation ?? elevation) || elevation;
    const sortLayer = Number(renderOrder?.sortLayer ?? 0) || 0;
    const shadowOcclusionProfile = this._getTileShadowOcclusionProfile(doc);
    const shadowOcclusionKey = shadowOcclusionProfile.key;
    return {
      key: `${kind}:${elevation}:${placementLevelId || 'none'}:${sortLayer}:${renderElevation}:${shadowOcclusionKey}`,
      elevation,
      renderOrder,
      placementLevelId,
      kind,
      shadowOcclusionKey,
      shadowOcclusionProfile
    };
  }

  _resolveLayerKeys(target) {
    if (target == null) return [];
    if (this._layers.has(target)) return [target];
    const numericTarget = Number(target);
    if (!Number.isFinite(numericTarget)) return [];
    const matching = [];
    for (const [layerKey, layer] of this._layers.entries()) {
      if (Number(layer?.elevation ?? 0) !== numericTarget) continue;
      matching.push(layerKey);
    }
    return matching;
  }

  _computeSortBelow(layer, { additionalSorts = [] } = {}) {
    try {
      const docs = Array.from(layer?.tiles?.values?.() || []);
      const baseDoc = docs[0] || null;
      const minSort = [...docs.map((doc) => doc?.sort), ...additionalSorts].reduce((lowest, value) => {
        const numericSort = Number(value ?? 0) || 0;
        return Math.min(lowest, numericSort);
      }, Number.POSITIVE_INFINITY);
      const renderOrder = resolveTileRenderOrder(baseDoc || { elevation: layer?.elevation ?? 0, sort: 0 }, {
        elevation: layer?.elevation ?? 0,
        sort: Number.isFinite(minSort) ? minSort : 0,
        placementLevelId: layer?.placementLevelId || null
      });
      if (!Number.isFinite(Number(renderOrder?.sort))) return -5;
      return Number(renderOrder.sort) - 0.0001;
    } catch (_) { return -5; }
  }

  _collectShadowTilesAtElevation(elevation) {
    const target = Number(elevation ?? 0) || 0;
    const tiles = [];
    try {
      const placeables = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
      for (const placeable of placeables) {
        const doc = placeable?.document;
        if (!doc || !this._isShadowTile(doc)) continue;
        if (Number(doc.elevation ?? 0) !== target) continue;
        tiles.push(doc);
      }
    } catch (_) {}
    return tiles;
  }

  getElevationSettings(elevation, { ignorePreview = false } = {}) {
    return getAssetShadowElevationSettings(this, elevation, {
      maxOffsetDistance: MAX_OFFSET_DISTANCE,
      ignorePreview
    });
  }

  async applyElevationSettings(elevation, settings = {}) {
    return applyAssetShadowElevationSettings(this, elevation, settings, { maxOffsetDistance: MAX_OFFSET_DISTANCE });
  }

  _expandRectWithPathBounds(rect, boundsList) {
    try {
      if (!rect || !Array.isArray(boundsList) || !boundsList.length) return rect;
      let minX = Number.isFinite(rect?.x) ? rect.x : Infinity;
      let minY = Number.isFinite(rect?.y) ? rect.y : Infinity;
      let maxX = Number.isFinite(rect?.x + rect?.width) ? rect.x + rect.width : -Infinity;
      let maxY = Number.isFinite(rect?.y + rect?.height) ? rect.y + rect.height : -Infinity;
      for (const bounds of boundsList) {
        if (!bounds) continue;
        if (Number.isFinite(bounds.minX)) minX = Math.min(minX, bounds.minX);
        if (Number.isFinite(bounds.minY)) minY = Math.min(minY, bounds.minY);
        if (Number.isFinite(bounds.maxX)) maxX = Math.max(maxX, bounds.maxX);
        if (Number.isFinite(bounds.maxY)) maxY = Math.max(maxY, bounds.maxY);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return rect;
      }
      return {
        x: Math.floor(minX),
        y: Math.floor(minY),
        width: Math.max(1, Math.ceil(maxX) - Math.floor(minX)),
        height: Math.max(1, Math.ceil(maxY) - Math.floor(minY))
      };
    } catch (_) {
      return rect;
    }
  }

  _expandSceneRectForDocs(baseRect, docs) {
    const fallbackRect = baseRect && Number.isFinite(baseRect.width) && Number.isFinite(baseRect.height)
      ? {
        x: Number(baseRect.x || 0) || 0,
        y: Number(baseRect.y || 0) || 0,
        width: Math.max(1, Number(baseRect.width || 0)),
        height: Math.max(1, Number(baseRect.height || 0))
      }
      : { x: 0, y: 0, width: 4096, height: 4096 };

    if (!Array.isArray(docs) || !docs.length) return fallbackRect;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let foundBounds = false;

    for (const doc of docs) {
      const bounds = this._computeTileBounds(doc);
      if (!bounds) continue;
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
      foundBounds = true;
    }

    if (!foundBounds || !Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return fallbackRect;
    }

    const pad = 8; // soften edges slightly to avoid clipping due to rotation rounding
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;

    return {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.max(1, Math.ceil(maxX) - Math.floor(minX)),
      height: Math.max(1, Math.ceil(maxY) - Math.floor(minY))
    };
  }

  _computeTileBounds(doc) {
    try {
      const { width, height } = this._getDocDimensions(doc);
      if (width <= 0 || height <= 0) return null;
      const corners = [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height }
      ];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const corner of corners) {
        const world = this._transformDocLocalPoint(doc, corner, { anchorMode: 'doc' });
        if (!world) continue;
        if (world.x < minX) minX = world.x;
        if (world.y < minY) minY = world.y;
        if (world.x > maxX) maxX = world.x;
        if (world.y > maxY) maxY = world.y;
      }
      return { minX, minY, maxX, maxY };
    } catch (_) { return null; }
  }

  _getSceneRect() {
    try {
      const d = canvas?.dimensions;
      if (d) {
        const sr = d.sceneRect || d.sceneRectangle || null;
        if (sr && Number.isFinite(sr.width) && Number.isFinite(sr.height)) {
          const x = Number(sr.x || 0) || 0;
          const y = Number(sr.y || 0) || 0;
          const w = Math.max(1, Math.round(Number(sr.width || 0)));
          const h = Math.max(1, Math.round(Number(sr.height || 0)));
          return { x, y, width: w, height: h };
        }
        const x = Number((d.sceneX ?? 0) || 0) || 0;
        const y = Number((d.sceneY ?? 0) || 0) || 0;
        const w = Number((d.sceneWidth ?? d.width ?? canvas?.scene?.width) || 0) || 0;
        const h = Number((d.sceneHeight ?? d.height ?? canvas?.scene?.height) || 0) || 0;
        if (w > 0 && h > 0) return { x, y, width: w, height: h };
      }
      const grid = Number(canvas?.scene?.grid?.size || 100) || 100;
      const sw = Math.max(1, Number(canvas?.scene?.width || 50));
      const sh = Math.max(1, Number(canvas?.scene?.height || 50));
      const pad = Number(canvas?.scene?.padding || 0) || 0;
      const padPxX = Math.round(pad * sw * grid);
      const padPxY = Math.round(pad * sh * grid);
      return { x: -padPxX, y: -padPxY, width: sw * grid + 2 * padPxX, height: sh * grid + 2 * padPxY };
    } catch (_) {
      return { x: 0, y: 0, width: 4096, height: 4096 };
    }
  }

  _computeTextureScale(sceneRect) {
    const sr = sceneRect || this._sceneRect;
    const max = this._getMaxTextureSize();
    if (!sr || !sr.width || !sr.height) return 1;
    const sx = max / Math.max(1, sr.width);
    const sy = max / Math.max(1, sr.height);
    const scale = Math.min(1, sx, sy);
    return scale <= 0 ? 1 : scale;
  }

  _getShadowQualityCap() {
    try {
      return Math.max(1024, Number(this._getShadowQualityConfig()?.maxTextureSize || 4096) || 4096);
    } catch (_) {
      return 4096;
    }
  }

  _getMaxTextureSize() {
    try {
      const qualityCap = this._getShadowQualityCap();
      const gl = this._renderer?.gl || this._renderer?.context?.gl || canvas?.app?.renderer?.gl;
      if (!gl) return Math.max(1024, Math.min(4096, qualityCap));
      const val = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const max = Number(val || 4096) || 4096;
      return Math.max(1024, Math.min(max, qualityCap));
    } catch (_) {
      return Math.max(1024, Math.min(4096, this._getShadowQualityCap()));
    }
  }

  async _obtainTexture(src) {
    if (!src) return null;
    if (/\.(webm|mp4)$/i.test(src)) return null;
    const key = AssetShadowManager._encode(src);
    const cached = this._textureCache.get(key);
    if (cached && cached.texture && !cached.texture.baseTexture?.destroyed) {
      return cached.texture;
    }
    const texture = await loadFoundryTexture(key);
    const ok = await AssetShadowManager._waitForBaseTexture(texture?.baseTexture, 5000);
    if (!ok) return null;
    this._textureCache.set(key, { texture, ts: Date.now() });
    return texture;
  }

  static _encode(p) {
    if (!p) return p;
    if (/^https?:/i.test(p)) return p;
    try { return encodeURI(decodeURI(String(p))); }
    catch (_) {
      try { return encodeURI(String(p)); }
      catch { return p; }
    }
  }

  static async _waitForBaseTexture(baseTexture, timeout = 5000) {
    if (!baseTexture) return false;
    if (baseTexture.valid) return true;
    return new Promise((resolve) => {
      let finished = false;
      const cleanup = () => {
        if (!baseTexture) return;
        try { baseTexture.off?.('loaded', onLoad); } catch (_) {}
        try { baseTexture.off?.('error', onError); } catch (_) {}
      };
      const onLoad = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(true);
      };
      const onError = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(false);
      };
      try { baseTexture.once?.('loaded', onLoad); } catch (_) { resolve(baseTexture.valid); return; }
      try { baseTexture.once?.('error', onError); } catch (_) {}
      setTimeout(() => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(baseTexture.valid);
      }, timeout);
    });
  }
}

try {
  onFoundryBoot('ready', () => {
    try {
      if (game.settings.get('fa-nexus', 'assetDropShadow')) {
        AssetShadowManager.getInstance();
      }
    } catch (error) {
      logShadowLifecycleFailure('ready', error);
    }
  });

  Hooks.on('updateSetting', (setting) => {
    try {
      if (!setting || setting.namespace !== MODULE_ID) return;
      if (setting.key === 'assetDropShadow') {
        if (setting.value) {
          const mgr = AssetShadowManager.getInstance();
          mgr?.refreshAll?.();
        } else {
          const mgr = AssetShadowManager.peek();
          mgr?._clearAllLayers?.();
        }
        return;
      }
      if (setting.key === 'assetDropShadowQuality') {
        if (!game?.settings?.get?.(MODULE_ID, 'assetDropShadow')) return;
        const mgr = AssetShadowManager.peek() ?? AssetShadowManager.getInstance();
        mgr?.refreshAll?.();
      }
    } catch (error) {
      logShadowLifecycleFailure('update-setting', error, {
        namespace: setting?.namespace || '',
        key: setting?.key || ''
      });
    }
  });
} catch (error) {
  logShadowLifecycleFailure('hook-setup', error);
}

export function getAssetShadowManager(app) {
  return AssetShadowManager.getInstance(app);
}
