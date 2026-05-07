import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { gatherBuildingLoops } from '../buildings/building-shape-helpers.js';
import { BuildingWallMesher } from '../buildings/building-wall-mesher.js';
import { onCanvasReady } from '../canvas/canvas-readiness.js';
import { getCurrentViewedLevelIds } from '../canvas/elevation-band-utils.js';
import { getRawLevelIds } from '../canvas/tile-level-membership.js';
import { resolveTileRenderOrder } from '../canvas/tile-band-utils.js';
import {
  getTileOcclusionMask,
  getSurfaceTileOcclusionModes,
  mapTileOcclusionElevation
} from '../canvas/tile-occlusion.js';
import { cloneDisplayObjectForProxy } from '../canvas/display-object-proxy.js';
import { getOrCreatePixiTexture } from '../core/foundry-texture-loader-patch.js';
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
  clearAssetScatterCache,
  rehydrateAllAssetScatterTiles
} from './asset-scatter-geometry.js';
import {
  computeSamplesFromPoints as computePathSamples,
  computeBoundsFromSamples as computePathBounds,
  computePathShadowPoints,
  createMeshFromSamples as createPathMesh,
  loadPathTexture,
  createPathShader,
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
const SCATTER_SHADOW_MAX_SPRITES = 60000;
const SCATTER_SHADOW_MAX_INSTANCES = 8000;
// Scatter stamps use the active quality ceiling; this guard only prevents runaway sizes above the
// current highest experimental tier and still respects the detected GPU cap.
const SCATTER_SHADOW_MAX_DIMENSION = 8192;
const SHADOW_BLANK_VALIDATION_MAX_PIXELS = 4_000_000;
const SHADOW_BLANK_RECOVERY_COOLDOWN_MS = 10_000;
const SHADOW_BLANK_VALIDATION_BUDGET = 12;
const SHADOW_RENDERER_RECOVERY_DEBOUNCE_MS = 1_000;

const SHADOW_OCCLUSION_FRAGMENT_SHADER = `
varying vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform sampler2D occlusionTexture;
uniform vec2 screenDimensions;
uniform float occlusionElevation;
uniform float unoccludedAlpha;
uniform float occludedAlpha;
uniform float fadeOcclusion;
uniform float radialOcclusion;
uniform float visionOcclusion;
uniform float surfaceOcclusion;

void main() {
  vec4 color = texture2D(uSampler, vTextureCoord);
  vec2 maskCoord = gl_FragCoord.xy / max(screenDimensions, vec2(1.0));
  vec4 occluded = 1.0 - step(vec4(occlusionElevation), texture2D(occlusionTexture, maskCoord));
  float occlusion = max(
    max(occluded.r * fadeOcclusion, occluded.g * radialOcclusion),
    max(occluded.b * visionOcclusion, occluded.a * surfaceOcclusion)
  );
  gl_FragColor = color * mix(unoccludedAlpha, occludedAlpha, occlusion);
}
`;

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

function clampUnit(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.min(1, Math.max(0, numeric));
  return Math.min(1, Math.max(0, Number(fallback) || 0));
}

function getTransparentTexture() {
  try {
    return PIXI.Texture.EMPTY;
  } catch (_) {
    return null;
  }
}

function createAssetShadowOcclusionFilter(manager, layer) {
  const FilterClass = globalThis.PIXI?.Filter;
  if (!FilterClass) return null;
  return new (class extends FilterClass {
    constructor() {
      super(undefined, SHADOW_OCCLUSION_FRAGMENT_SHADER, {
        screenDimensions: [1, 1],
        occlusionTexture: getTransparentTexture(),
        occlusionElevation: 0,
        unoccludedAlpha: 1,
        occludedAlpha: 0,
        fadeOcclusion: 0,
        radialOcclusion: 0,
        visionOcclusion: 0,
        surfaceOcclusion: 0
      });
      this.manager = manager;
      this.layer = layer;
    }

    apply(filterManager, input, output, clear, currentState) {
      try {
        this.manager?._prepareShadowOcclusionUniforms?.(this.layer, this.uniforms);
      } catch (error) {
        Logger.warn('AssetShadow.occlusionFilter.prepareFailed', {
          layerKey: this.layer?.key || null,
          error: String(error?.message || error)
        });
      }
      super.apply(filterManager, input, output, clear, currentState);
    }
  })();
}

function getPrimaryShadowOcclusionMeshClasses() {
  try {
    const PrimarySpriteMesh = globalThis?.foundry?.canvas?.primary?.PrimarySpriteMesh;
    const PrimaryBaseSamplerShader = globalThis?.foundry?.canvas?.rendering?.shaders?.PrimaryBaseSamplerShader;
    if (typeof PrimarySpriteMesh !== 'function' || typeof PrimaryBaseSamplerShader !== 'function') return null;
    return { PrimarySpriteMesh, PrimaryBaseSamplerShader };
  } catch (_) {
    return null;
  }
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
    this._layers = new Map();
    this._tileIndex = new Map(); // tile id -> shadow layer key
    this._textureCache = new Map();
    this._scatterShadowCache = new Map();
    this._standardMaskShadowCache = new Map();
    this._rebuildTimers = new Map();
    this._renderer = null;
    this._hooksBound = false;
    this._suspendedTiles = new Map(); // tile id -> { doc, layerKey }
    this._sceneRect = { x: 0, y: 0, width: 0, height: 0 };
    this._options = {
      alpha: 0.65,
      dilation: 1.6,
      blur: 1.8,
      offsetDistance: 0,
      offsetAngle: 135,
      debounce: 2
    };
    this._rebuildSuspendCount = 0;
    this._pendingRebuilds = new Set();
    this._pendingRebuildImmediate = false;
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
    if (!canvas || !canvas.ready) return;
    this._sceneGeneration += 1;
    this._sceneId = this._getActiveSceneId();
    this._updateRenderer();
    this._clearAllLayers();
    this._sceneRect = this._getSceneRect();

    const placeables = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const placeable of placeables) {
      const doc = placeable?.document;
      if (!doc || !this._isShadowRenderableTile(doc, { phase: 'canvasReady' })) continue;
      this._addTile(doc, { deferRebuild: true });
    }

    for (const elevation of this._layers.keys()) {
      this._scheduleRebuild(elevation, true);
    }
  }

  _onCanvasTearDown() {
    this._sceneGeneration += 1;
    const previousSceneId = this._sceneId || this._getActiveSceneId();
    this._sceneId = null;
    this._clearAllLayers();
    Logger.debug?.('AssetShadow.canvasTearDown.cleared', { sceneId: previousSceneId });
  }

  _onCreateTile(doc) {
    if (!doc || !this._isActiveSceneDocument(doc, { phase: 'createTile' }) || !this._isShadowRenderableTile(doc, { phase: 'createTile' })) return;
    this._addTile(doc);
  }

  _onUpdateTile(doc, changes = {}) {
    if (!doc) return;
    if (!this._isActiveSceneDocument(doc, { phase: 'updateTile' })) return;
    const hasShadow = this._isShadowRenderableTile(doc, { phase: 'updateTile', changes });
    const tileId = doc.id;
    const prevElevation = this._tileIndex.get(tileId);
    const suspendedEntry = tileId ? this._suspendedTiles.get(tileId) : null;
    this._clearStandardMaskShadowCache(tileId);

      if (!hasShadow) {
        if (suspendedEntry) {
          this._suspendedTiles.delete(tileId);
        } else if (prevElevation !== undefined) {
          this._removeTile(doc);
      }
      return;
    }

      if (suspendedEntry) {
        suspendedEntry.doc = doc;
        suspendedEntry.layerKey = this._getTileLayerState(doc).key;
        return;
      }

      const layerState = this._getTileLayerState(doc);
      if (prevElevation !== undefined && prevElevation !== layerState.key) {
        this._removeTile(doc);
      }
      this._addTile(doc);
  }

  _onDeleteTile(doc) {
    if (!doc) return;
    if (!this._isActiveSceneDocument(doc, { phase: 'deleteTile' })) return;
    if (this._suspendedTiles.has(doc.id)) {
      this._suspendedTiles.delete(doc.id);
    }
    if (!this._tileIndex.has(doc.id)) return;
    this._removeTile(doc);
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

    _addTile(doc, { deferRebuild = false } = {}) {
      try {
        if (!doc) return;
        if (!this._isActiveSceneDocument(doc, { phase: 'addTile' })) return;
        if (!this._isShadowRenderableTile(doc, { phase: 'addTile' })) return;
        const layerState = this._getTileLayerState(doc);
        const layer = this._ensureLayer(layerState);
        if (!layer) return;
        layer.tiles.set(doc.id, doc);
        layer.renderOrder = layerState.renderOrder;
        layer.shadowOcclusionKey = layerState.shadowOcclusionKey;
        layer.shadowOcclusionProfile = layerState.shadowOcclusionProfile;
        this._tileIndex.set(doc.id, layerState.key);
        if (!deferRebuild) this._scheduleRebuild(layerState.key);
      } catch (e) {
        Logger.warn('AssetShadow.addTile.failed', String(e?.message || e));
      }
    }

  _removeTile(doc) {
    try {
        const tileId = doc?.id;
        if (!this._isActiveSceneDocument(doc, { phase: 'removeTile' })) return;
        if (!tileId || !this._tileIndex.has(tileId)) return;
        const layerKey = this._tileIndex.get(tileId);
        this._tileIndex.delete(tileId);
        this._suspendedTiles.delete(tileId);
        this._clearScatterShadowCache(tileId);
        this._clearStandardMaskShadowCache(tileId);
        const layer = this._layers.get(layerKey);
        if (!layer) return;
        layer.tiles.delete(tileId);
        if (!layer.tiles.size) {
          this._destroyLayer(layerKey);
          return;
        }
        this._scheduleRebuild(layerKey);
      } catch (e) {
        Logger.warn('AssetShadow.removeTile.failed', String(e?.message || e));
      }
    }

  suspendTile(tileDocument) {
    try {
      const doc = tileDocument?.document ?? tileDocument;
      if (!doc) return false;
      if (!this._isActiveSceneDocument(doc, { phase: 'suspendTile' })) return false;
      const tileId = doc.id;
        if (!tileId) return false;
        if (this._suspendedTiles.has(tileId)) return true;
        const layerKey = this._tileIndex.get(tileId);
        if (layerKey === undefined) return false;
        const layer = this._layers.get(layerKey);
        if (!layer || !layer.tiles.has(tileId)) return false;
        layer.tiles.delete(tileId);
        this._tileIndex.delete(tileId);
        this._suspendedTiles.set(tileId, { doc, layerKey });
        this._scheduleRebuild(layerKey, true);
        return true;
      } catch (e) {
        Logger.warn('AssetShadow.suspendTile.failed', String(e?.message || e));
      return false;
    }
  }

  resumeTile(tileDocument) {
    try {
      const doc = tileDocument?.document ?? tileDocument;
      if (!doc) return false;
      if (!this._isActiveSceneDocument(doc, { phase: 'resumeTile' })) return false;
      const tileId = doc.id;
      if (!tileId) return false;
      const entry = this._suspendedTiles.get(tileId);
      if (!entry) return false;
      const liveDoc = canvas?.scene?.tiles?.get?.(tileId) || entry.doc || doc;
      const previousLayerKey = entry.layerKey || null;
      const nextLayerKey = this._isActiveSceneDocument(liveDoc, { phase: 'resumeTile:live', log: false })
        && this._isShadowRenderableTile(liveDoc, { phase: 'resumeTile:live', log: false })
        ? this._getTileLayerState(liveDoc).key
        : null;
      this._suspendedTiles.delete(tileId);
      if (nextLayerKey) this._addTile(liveDoc, { deferRebuild: true });
      const rebuildTargets = new Set([previousLayerKey, nextLayerKey].filter(Boolean));
      for (const target of rebuildTargets) this._scheduleRebuild(target, true);
      return true;
    } catch (e) {
      Logger.warn('AssetShadow.resumeTile.failed', String(e?.message || e));
      return false;
    }
  }

  suspendRebuilds() {
    this._rebuildSuspendCount += 1;
  }

  resumeRebuilds({ immediate = false } = {}) {
    if (this._rebuildSuspendCount <= 0) return false;
    this._rebuildSuspendCount -= 1;
    if (this._rebuildSuspendCount > 0) return true;
    if (!this._pendingRebuilds.size) {
      this._pendingRebuildImmediate = false;
      return true;
    }
    const pending = Array.from(this._pendingRebuilds);
    this._pendingRebuilds.clear();
    const runImmediate = !!immediate || this._pendingRebuildImmediate;
    this._pendingRebuildImmediate = false;
    for (const elevation of pending) {
      this._scheduleRebuild(elevation, runImmediate);
    }
    return true;
  }

  _scheduleRebuild(target, immediate = false) {
    const layerKeys = this._resolveLayerKeys(target);
    if (!layerKeys.length) return;
    for (const layerKey of layerKeys) {
      const layer = this._layers.get(layerKey);
      if (!layer || !canvas?.ready) continue;
      layer.dirty = true;
      const handle = this._rebuildTimers.get(layerKey);
      if (handle) {
        try { clearTimeout(handle); } catch (_) {}
        this._rebuildTimers.delete(layerKey);
      }
      if (this._rebuildSuspendCount > 0) {
        this._pendingRebuilds.add(layerKey);
        if (immediate) this._pendingRebuildImmediate = true;
        continue;
      }
      const generation = this._sceneGeneration;
      const sceneId = this._sceneId || this._getActiveSceneId();
      const run = () => {
        this._rebuildTimers.delete(layerKey);
        if (!this._isCurrentSceneScope(generation, sceneId)) {
          Logger.debug?.('AssetShadow.rebuild.staleTimerDiscarded', { layerKey, sceneId, generation });
          return;
        }
        this._rebuildLayer(layerKey, { generation, sceneId });
      };
      if (immediate) {
        run();
        continue;
      }
      const delay = Math.max(16, Number(this._options.debounce || 0));
      const timer = setTimeout(run, delay);
      this._rebuildTimers.set(layerKey, timer);
    }
  }

  async _rebuildLayer(elevation, { generation = this._sceneGeneration, sceneId = this._sceneId || this._getActiveSceneId() } = {}) {
    const layer = this._layers.get(elevation);
    if (!layer || !canvas?.ready) return;
    if (!this._isCurrentSceneScope(generation, sceneId)) return;
    if (layer.sceneId && sceneId && layer.sceneId !== sceneId) {
      Logger.debug?.('AssetShadow.rebuild.sceneMismatchDiscarded', {
        elevation,
        layerSceneId: layer.sceneId,
        sceneId
      });
      return;
    }
    if (!layer.dirty && !layer.rebuilding) return;
    if (layer.rebuilding) {
      layer.dirty = true;
      return;
    }
    layer.rebuilding = true;
    layer.dirty = false;

    let rebuildDrawContainer = null;
    const rebuildTempDisplayObjects = [];
    const rebuildTempTextures = [];
    const staleRebuildAbort = new Error('stale shadow rebuild scope');
    staleRebuildAbort.faNexusStaleRebuild = true;
    const assertCurrentRebuild = () => {
      if (!this._isCurrentSceneScope(generation, sceneId)) throw staleRebuildAbort;
    };

    try {
      this._updateRenderer();
      const renderer = this._renderer;
      if (!renderer) return;

      const docs = [];
      const staleTileIds = [];
      for (const [tileId, doc] of layer.tiles.entries()) {
        if (
          !doc
          || !this._isActiveSceneDocument(doc, { phase: 'rebuildLayer', log: false })
          || !this._isShadowRenderableTile(doc, { phase: 'rebuildLayer', log: false })
        ) {
          staleTileIds.push(tileId);
          continue;
        }
        docs.push(doc);
      }
      if (staleTileIds.length) {
        for (const tileId of staleTileIds) {
          layer.tiles.delete(tileId);
          if (this._tileIndex.get(tileId) === elevation) this._tileIndex.delete(tileId);
          this._suspendedTiles.delete(tileId);
          this._clearScatterShadowCache(tileId);
          this._clearStandardMaskShadowCache(tileId);
        }
        Logger.debug?.('AssetShadow.rebuild.removedStaleTiles', {
          elevation,
          sceneId,
          tileIds: staleTileIds
        });
      }
      if (!docs.length) {
        this._destroyLayer(elevation);
        return;
      }
      this._sortLayerShadowDocs(docs);

      // Resolve per-tile configuration. Alpha/blur are render-profile settings, so keep
      // them with each entry; mixed building/window shadows at one elevation must not let
      // the first tile in the layer decide the whole layer's blur.
      const tileConfigs = [];
      let maxOffsetX = 0;
      let maxOffsetY = 0;
      let maxDilation = 0;
      let maxAlpha = 0;
      let maxBlur = 0;

      for (const doc of docs) {
        const docBaseOptions = this._extractShadowBaseOptions(doc, { elevation: layer?.elevation });
        const cfg = {
          ...this._extractTileShadowConfig(doc, docBaseOptions),
          alpha: docBaseOptions.alpha,
          blur: docBaseOptions.blur
        };
        const pathDescriptors = this._resolveShadowPathDescriptors(doc);
        tileConfigs.push({ doc, config: cfg, paths: pathDescriptors });
        if (Math.abs(cfg.offsetX) > maxOffsetX) maxOffsetX = Math.abs(cfg.offsetX);
        if (Math.abs(cfg.offsetY) > maxOffsetY) maxOffsetY = Math.abs(cfg.offsetY);
        if (cfg.dilation > maxDilation) maxDilation = cfg.dilation;
        if (cfg.alpha > maxAlpha) maxAlpha = cfg.alpha;
        if (cfg.blur > maxBlur) maxBlur = cfg.blur;
      }

      const layerOptions = {
        alpha: maxAlpha,
        blur: maxBlur,
        maxOffsetX,
        maxOffsetY,
        maxDilation
      };
      layer.options = layerOptions;

      const baseRect = this._getSceneRect();
      const renderChunks = this._buildLayerShadowRenderChunks(tileConfigs, {
        fallbackRect: baseRect,
        layerOptions
      });
      const chunkStates = this._syncLayerRenderChunks(layer, renderChunks);

      for (const renderChunk of renderChunks) {
        const chunkState = chunkStates.get(renderChunk.key);
        if (!chunkState) continue;

        let sr = renderChunk.bounds || baseRect;
        sr = this._applyShadowMargins(sr, {
          offsetX: renderChunk.maxOffsetX,
          offsetY: renderChunk.maxOffsetY,
          dilation: renderChunk.maxDilation,
          blur: Number(renderChunk.blur ?? layerOptions.blur ?? 0)
        });
        this._sceneRect = sr;
        const scale = this._computeTextureScale(sr);
        const texWidth = Math.max(4, Math.round(sr.width * scale));
        const texHeight = Math.max(4, Math.round(sr.height * scale));
        if (!Number.isFinite(texWidth) || !Number.isFinite(texHeight)) continue;

        const chunkTempDisplayObjects = [];
        const chunkTempTextures = [];
        let chunkDrawContainer = null;
        try {
          chunkDrawContainer = await this._buildLayerShadowDrawContainer(renderChunk.entries, {
            renderer,
            scale,
            sceneRect: sr,
            assertCurrentRebuild,
            tempDisplayObjects: chunkTempDisplayObjects,
            tempTextures: chunkTempTextures
          });
          assertCurrentRebuild();

          const childCount = Number(chunkDrawContainer?.children?.length || 0);
          if (childCount <= 0) {
            this._hideLayerRenderChunk(layer, chunkState);
            continue;
          }

          const renderTexture = this._renderLayerToTexture(layer, chunkDrawContainer, renderer, texWidth, texHeight, {
            renderTarget: chunkState,
            scale,
            layerOptions: {
              ...layerOptions,
              alpha: Number(renderChunk.alpha ?? layerOptions.alpha ?? 0.35),
              blur: Number(renderChunk.blur ?? layerOptions.blur ?? 0),
              maxDilation: Number(renderChunk.maxDilation ?? layerOptions.maxDilation ?? 0)
            }
          });
          if (!renderTexture) continue;
          if (this._isLayerRenderTextureBlank(renderTexture, renderer, { elevation, sceneId, generation, childCount })) {
            this._handleBlankLayerRender(elevation, {
              sceneId,
              generation,
              childCount,
              width: Number(renderTexture.width || 0),
              height: Number(renderTexture.height || 0),
              tileIds: renderChunk.entries.map((entry) => entry?.doc?.id).filter(Boolean)
            });
          }
          chunkState.options = {
            alpha: Number(renderChunk.alpha ?? layerOptions.alpha ?? 0.35),
            blur: Number(renderChunk.blur ?? layerOptions.blur ?? 0),
            maxDilation: Number(renderChunk.maxDilation ?? layerOptions.maxDilation ?? 0)
          };
          this._applyLayerChunkTexture(layer, chunkState, sr, renderTexture, scale);
        } finally {
          for (const displayObject of chunkTempDisplayObjects) {
            try { displayObject.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
          }
          for (const texture of chunkTempTextures) {
            try { texture?.destroy?.(true); } catch (_) {}
          }
          try { chunkDrawContainer?.destroy?.({ children: false }); } catch (_) {}
        }
      }

      this._syncLayerOrdering(layer);
    } catch (e) {
      if (e?.faNexusStaleRebuild) {
        Logger.debug?.('AssetShadow.rebuild.staleAbort', { elevation, sceneId, generation });
      } else {
        Logger.warn('AssetShadow.rebuild.failed', String(e?.message || e));
      }
    } finally {
      for (const displayObject of rebuildTempDisplayObjects) {
        try { displayObject.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      for (const texture of rebuildTempTextures) {
        try { texture?.destroy?.(true); } catch (_) {}
      }
      try { rebuildDrawContainer?.destroy?.({ children: false }); } catch (_) {}
      if (this._layers.get(elevation) !== layer || !this._isCurrentSceneScope(generation, sceneId)) {
        Logger.debug?.('AssetShadow.rebuild.staleDiscarded', { elevation, sceneId, generation });
        return;
      }
      layer.rebuilding = false;
      if (layer.dirty) this._scheduleRebuild(elevation, true);
    }
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

  _getShadowQualityConfig() {
    return readShadowQualityConfig();
  }

  async _buildLayerShadowDrawContainer(entries, context = {}) {
    const drawContainer = new PIXI.Container();
    const renderer = context.renderer || this._renderer;
    const scale = Number(context.scale) || 1;
    const sr = context.sceneRect || this._sceneRect || { x: 0, y: 0 };
    const assertCurrentRebuild = typeof context.assertCurrentRebuild === 'function'
      ? context.assertCurrentRebuild
      : () => {};
    const tempDisplayObjects = Array.isArray(context.tempDisplayObjects) ? context.tempDisplayObjects : [];
    const tempTextures = Array.isArray(context.tempTextures) ? context.tempTextures : [];
    const dilationCache = new Map();

    const getOffsetsForRadius = (radius) => {
      const key = Number.isFinite(radius) ? radius.toFixed(3) : '0';
      if (dilationCache.has(key)) return dilationCache.get(key);
      const list = this._buildDilationOffsets(radius);
      dilationCache.set(key, list);
      return list;
    };

    for (const entry of Array.isArray(entries) ? entries : []) {
      const { doc, config: cfg, paths } = entry || {};
      if (!doc || !cfg) continue;
      const descriptors = Array.isArray(paths) ? paths.filter(Boolean) : [];
      try {
        const dilationRadius = Math.max(0, Number(cfg.dilation || 0)) * scale;
        const offsets = getOffsetsForRadius(dilationRadius);
        const offsetXScaled = Number(cfg.offsetX ?? 0) * scale;
        const offsetYScaled = Number(cfg.offsetY ?? 0) * scale;
        const applyOffsetX = offsetXScaled;
        const applyOffsetY = offsetYScaled;

        const standardMaskFlags = this._readStandardTileMask(doc);
        let standardMaskShadowStamp = null;
        const getStandardMaskShadowStamp = async () => {
          if (!standardMaskFlags) return null;
          if (standardMaskShadowStamp) return standardMaskShadowStamp;
          standardMaskShadowStamp = await this._getStandardMaskShadowStamp(doc, renderer);
          assertCurrentRebuild();
          if (!standardMaskShadowStamp?.texture) {
            Logger.error('AssetShadow.standardTileMask.shadowStampFailed', {
              tileId: doc?.id,
              src: doc?.texture?.src || null
            });
            return null;
          }
          return standardMaskShadowStamp;
        };

        if (descriptors.length) {
          const standardStamp = standardMaskFlags ? await this._getStandardMaskClipStamp(doc, renderer) : null;
          if (standardMaskFlags) {
            if (!standardStamp?.texture) continue;
            const descriptorDilation = descriptors.reduce((max, descriptor) => Math.max(max, Number(descriptor?.shadowDilation || 0)), 0);
            const pathMaskedSpread = descriptors.some((descriptor) => descriptor?.kind !== 'building')
              ? Math.max(Number(cfg.dilation || 0), descriptorDilation)
              : 0;
            const maskedStamp = await this._createMaskedDescriptorShadowStamp(doc, descriptors, standardStamp, renderer, {
              scale,
              applyMask: true,
              dilation: pathMaskedSpread
            });
            assertCurrentRebuild();
            if (!maskedStamp?.texture) {
              Logger.error('AssetShadow.standardTileMask.descriptorStampFailed', {
                tileId: doc?.id
              });
              try { standardStamp.texture.destroy(true); } catch (_) {}
              continue;
            }
            tempTextures.push(maskedStamp.texture);
            const maskedOffsets = pathMaskedSpread > 0
              ? [{ x: 0, y: 0 }]
              : getOffsetsForRadius(Math.max(dilationRadius, descriptorDilation * scale));
            for (const offset of maskedOffsets) {
              const sprite = this._createWorldBoundsShadowSprite(maskedStamp.texture, maskedStamp.bounds, {
                scale,
                sceneRect: sr,
                offsetX: offset.x + applyOffsetX,
                offsetY: offset.y + applyOffsetY
              });
              if (!sprite) continue;
              drawContainer.addChild(sprite);
              tempDisplayObjects.push(sprite);
            }
            tempTextures.push(standardStamp.texture);
            continue;
          }

          for (const descriptor of descriptors) {
            if (!descriptor) continue;
            const isBuilding = descriptor.kind === 'building';
            if (!isBuilding && (!Array.isArray(descriptor.samples) || descriptor.samples.length < PATH_MIN_POINTS)) continue;
            for (const offset of offsets) {
              let mesh = null;
              if (isBuilding) {
                mesh = await this._createBuildingShadowMesh(descriptor, {
                  scale,
                  sceneRect: sr,
                  dilationOffset: offset,
                  offsetX: applyOffsetX,
                  offsetY: applyOffsetY
                });
              } else {
                mesh = await this._createPathShadowMesh(descriptor, {
                  scale,
                  sceneRect: sr,
                  dilationOffset: offset,
                  offsetX: applyOffsetX,
                  offsetY: applyOffsetY
                });
              }
              try { assertCurrentRebuild(); }
              catch (error) {
                try { mesh?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
                throw error;
              }
              if (!mesh) continue;
              drawContainer.addChild(mesh);
              tempDisplayObjects.push(mesh);
            }
          }
          continue;
        }

        if (standardMaskFlags) {
          const standardStamp = await getStandardMaskShadowStamp();
          if (!standardStamp?.texture) continue;
          const texScaleX = Number(doc?.texture?.scaleX ?? 1) || 1;
          const texScaleY = Number(doc?.texture?.scaleY ?? 1) || 1;
          for (const offset of offsets) {
            const sprite = this._createDocShadowSprite(standardStamp.texture, doc, standardStamp.bounds, {
              scale,
              sceneRect: sr,
              offsetX: offset.x + applyOffsetX,
              offsetY: offset.y + applyOffsetY,
              flipX: texScaleX,
              flipY: texScaleY,
              anchorMode: 'doc'
            });
            if (!sprite) continue;
            drawContainer.addChild(sprite);
            tempDisplayObjects.push(sprite);
          }
          continue;
        }

        const scatterStamp = await this._getScatterShadowStamp(doc, cfg, scale, renderer);
        assertCurrentRebuild();
        if (scatterStamp?.texture) {
          const sprite = this._createDocShadowSprite(scatterStamp.texture, doc, scatterStamp.bounds, {
            scale,
            sceneRect: sr,
            offsetX: applyOffsetX,
            offsetY: applyOffsetY,
            anchorMode: 'doc'
          });
          if (sprite) {
            drawContainer.addChild(sprite);
            tempDisplayObjects.push(sprite);
          }
          continue;
        }

        // Building tiles with path-shadow geometry enabled can legitimately have no drawable wall
        // loops after 100% gaps (e.g. freestanding portals). In that case, don't fall back to a
        // rectangle sprite shadow, as it will incorrectly shadow the portal itself.
        if (this._usesBuildingShadowGeometry(doc)) continue;

        const tex = await this._obtainTexture(doc?.texture?.src);
        assertCurrentRebuild();
        if (!tex) continue;
        const texScaleX = Number(doc?.texture?.scaleX ?? 1) || 1;
        const texScaleY = Number(doc?.texture?.scaleY ?? 1) || 1;
        const { width: docWidth, height: docHeight } = this._getDocDimensions(doc);

        for (const offset of offsets) {
          const sprite = this._createDocShadowSprite(tex, doc, {
            x: 0,
            y: 0,
            width: docWidth,
            height: docHeight
          }, {
            scale,
            sceneRect: sr,
            offsetX: offset.x + applyOffsetX,
            offsetY: offset.y + applyOffsetY,
            flipX: texScaleX,
            flipY: texScaleY,
            anchorMode: 'doc'
          });
          if (!sprite) continue;
          drawContainer.addChild(sprite);
          tempDisplayObjects.push(sprite);
        }
      } catch (e) {
        if (e?.faNexusStaleRebuild) throw e;
        Logger.warn('AssetShadow.sprite.failed', String(e?.message || e));
      }
    }

    return drawContainer;
  }

  _renderLayerToTexture(layer, drawContainer, renderer, texWidth, texHeight, context = {}) {
    try {
      if (layer?.container) layer.container.filters = null;
      const target = context?.renderTarget || layer;
      const scale = Number(context?.scale) || 1;
      const options = context?.layerOptions || layer?.options || {};
      const blurAmount = Math.max(0, Number(options.blur || 0));
      const blurPixels = blurAmount * scale;

      let renderTexture = target.renderTexture || null;
      if (!renderTexture || renderTexture.destroyed || renderTexture.width !== texWidth || renderTexture.height !== texHeight) {
        if (renderTexture && !renderTexture.destroyed) {
          try { renderTexture.destroy(true); } catch (_) {}
        }
        renderTexture = PIXI.RenderTexture.create({
          width: texWidth,
          height: texHeight,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        target.renderTexture = renderTexture;
      }

      if (blurPixels <= 0.01) {
        if (target.rawRenderTexture && !target.rawRenderTexture.destroyed) {
          try { target.rawRenderTexture.destroy(true); } catch (_) {}
        }
        target.rawRenderTexture = null;
        renderer.render(drawContainer, { renderTexture, clear: true });
        if (target === layer || context?.setLayerPrimary) layer.renderTexture = renderTexture;
        return renderTexture;
      }

      let rawRenderTexture = target.rawRenderTexture || null;
      if (!rawRenderTexture || rawRenderTexture.destroyed || rawRenderTexture.width !== texWidth || rawRenderTexture.height !== texHeight) {
        if (rawRenderTexture && !rawRenderTexture.destroyed) {
          try { rawRenderTexture.destroy(true); } catch (_) {}
        }
        rawRenderTexture = PIXI.RenderTexture.create({
          width: texWidth,
          height: texHeight,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        target.rawRenderTexture = rawRenderTexture;
      }

      renderer.render(drawContainer, { renderTexture: rawRenderTexture, clear: true });

      const blur = new PIXI.BlurFilter();
      blur.blur = Math.min(64, Math.max(0.25, blurPixels));
      blur.quality = this._computeBlurQuality(blur.blur);
      blur.repeatEdgePixels = true;
      try {
        blur.padding = Math.ceil((blur.blur * 12) + Math.max(0, Number(options?.maxDilation || options?.dilation || 0)) + 4);
      } catch (_) {}

      const blurSprite = new PIXI.Sprite(rawRenderTexture);
      blurSprite.anchor.set(0, 0);
      blurSprite.position.set(0, 0);
      blurSprite.width = texWidth;
      blurSprite.height = texHeight;
      blurSprite.eventMode = 'none';
      blurSprite.filters = [blur];
      try {
        blurSprite.filterArea = new PIXI.Rectangle(0, 0, texWidth, texHeight);
      } catch (_) {}

      try {
        renderer.render(blurSprite, { renderTexture, clear: true });
      } finally {
        try { blurSprite.filters = null; } catch (_) {}
        try { blur.destroy(); } catch (_) {}
        try { blurSprite.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      if (target === layer || context?.setLayerPrimary) layer.renderTexture = renderTexture;
      return renderTexture;
    } catch (error) {
      Logger.warn('AssetShadow.renderTexture.failed', String(error?.message || error));
      return null;
    }
  }

  _isLayerRenderTextureBlank(renderTexture, renderer, context = {}) {
    try {
      const childCount = Number(context?.childCount || 0);
      if (!renderTexture || renderTexture.destroyed || !renderer || childCount <= 0) return false;
      if (this._blankRenderValidationBudget <= 0) return false;
      this._blankRenderValidationBudget -= 1;

      const width = Math.max(0, Math.round(Number(renderTexture.width || 0)));
      const height = Math.max(0, Math.round(Number(renderTexture.height || 0)));
      const pixelCount = width * height;
      if (!width || !height || !Number.isFinite(pixelCount)) return false;
      if (pixelCount > SHADOW_BLANK_VALIDATION_MAX_PIXELS) {
        Logger.debug?.('AssetShadow.renderTexture.blankValidationSkipped', {
          elevation: context?.elevation,
          sceneId: context?.sceneId,
          generation: context?.generation,
          width,
          height,
          pixelCount,
          maxPixels: SHADOW_BLANK_VALIDATION_MAX_PIXELS
        });
        return false;
      }

      const pixels = renderer.extract?.pixels?.(renderTexture);
      if (!pixels) return false;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 0) return false;
      }
      return true;
    } catch (error) {
      Logger.warn('AssetShadow.renderTexture.blankValidationFailed', {
        error: String(error?.message || error),
        elevation: context?.elevation,
        sceneId: context?.sceneId,
        generation: context?.generation
      });
      return false;
    }
  }

  _handleBlankLayerRender(elevation, details = {}) {
    try {
      const now = Date.now();
      const payload = {
        elevation,
        sceneId: details.sceneId || this._sceneId || this._getActiveSceneId(),
        generation: details.generation ?? this._sceneGeneration,
        childCount: Number(details.childCount || 0),
        width: Number(details.width || 0),
        height: Number(details.height || 0),
        tileIds: Array.isArray(details.tileIds) ? details.tileIds : []
      };
      if (this._blankLayerRecoveryActive || now < this._blankLayerRecoveryCooldownUntil) {
        Logger.error('AssetShadow.renderTexture.blankAfterRecovery', payload);
        return;
      }
      this._blankLayerRecoveryActive = true;
      this._blankLayerRecoveryCooldownUntil = now + SHADOW_BLANK_RECOVERY_COOLDOWN_MS;
      Logger.warn('AssetShadow.renderTexture.blankDetected', payload);
      setTimeout(() => {
        this._blankLayerRecoveryActive = false;
        this._recoverRendererResources('blank-render-texture');
      }, 0);
    } catch (error) {
      Logger.error('AssetShadow.renderTexture.blankRecoveryFailed', {
        elevation,
        error: String(error?.message || error)
      });
    }
  }

  _applyLayerTexture(layer, sceneRect, renderTexture, scale) {
    try {
      if (!layer || !sceneRect || !renderTexture || renderTexture.destroyed) return;
      if (layer.container?.destroyed) return;
      const sprite = layer.sprite;
      if (!sprite) return;
      if (sprite.destroyed || !sprite.position || !sprite.scale) return;
      sprite.texture = renderTexture;
      sprite.position.set(sceneRect.x, sceneRect.y);
      const invScale = scale ? 1 / scale : 1;
      sprite.scale.set(invScale, invScale);
      sprite.tint = 0x000000;
      sprite.alpha = Number(layer.options.alpha || 0.35);
      sprite.visible = true;

      if (layer.container) layer.container.filters = null;
      this._syncShadowLayerFilters(layer);
    } catch (e) {
      Logger.warn('AssetShadow.applyTexture.failed', String(e?.message || e));
    }
  }

  _applyLayerChunkTexture(layer, chunk, sceneRect, renderTexture, scale) {
    try {
      if (!layer || !chunk || !sceneRect || !renderTexture || renderTexture.destroyed) return;
      if (layer.container?.destroyed) return;
      const sprite = chunk.sprite;
      if (!sprite || sprite.destroyed || !sprite.position || !sprite.scale) return;
      sprite.texture = renderTexture;
      sprite.position.set(sceneRect.x, sceneRect.y);
      const invScale = scale ? 1 / scale : 1;
      sprite.scale.set(invScale, invScale);
      sprite.tint = 0x000000;
      sprite.alpha = Number(chunk.options?.alpha ?? layer.options.alpha ?? 0.35);
      sprite.visible = true;
      chunk.sceneRect = sceneRect;
      chunk.scale = scale;
      if (!layer.renderTexture || layer.renderTexture.destroyed) layer.renderTexture = renderTexture;

      if (layer.container) layer.container.filters = null;
      this._syncShadowLayerFilters(layer);
    } catch (e) {
      Logger.warn('AssetShadow.applyChunkTexture.failed', String(e?.message || e));
    }
  }

  _buildLayerShadowRenderChunks(tileConfigs, { fallbackRect = null, layerOptions = {} } = {}) {
    try {
      const entries = Array.isArray(tileConfigs) ? tileConfigs.filter((entry) => entry?.doc) : [];
      if (!entries.length) return [];
      const items = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const bounds = this._computeShadowEntryBounds(entry);
        const rectBounds = bounds || this._normalizeWorldBounds(fallbackRect);
        if (!rectBounds) continue;
        const config = entry.config || {};
        const alpha = Math.min(1, Math.max(0, Number(config.alpha ?? layerOptions.alpha ?? this._options.alpha ?? 0.65)));
        const blur = Math.max(0, Number(config.blur ?? layerOptions.blur ?? this._options.blur ?? 0));
        const profileKey = this._shadowRenderProfileKey({ alpha, blur });
        const expanded = this._inflateWorldBounds(rectBounds, {
          offsetX: Math.max(Math.abs(Number(config.offsetX || 0)), Math.abs(Number(layerOptions.maxOffsetX || 0))),
          offsetY: Math.max(Math.abs(Number(config.offsetY || 0)), Math.abs(Number(layerOptions.maxOffsetY || 0))),
          dilation: Math.max(Number(config.dilation || 0), Number(layerOptions.maxDilation || 0)),
          blur
        });
        items.push({
          index,
          entry,
          alpha,
          blur,
          profileKey,
          bounds: rectBounds,
          expanded
        });
      }
      if (!items.length && fallbackRect) {
        return [{
          key: 'fallback',
          entries,
          bounds: fallbackRect,
          alpha: Math.min(1, Math.max(0, Number(layerOptions.alpha ?? this._options.alpha ?? 0.65))),
          blur: Math.max(0, Number(layerOptions.blur ?? this._options.blur ?? 0)),
          profileKey: this._shadowRenderProfileKey(layerOptions),
          maxOffsetX: Math.abs(Number(layerOptions.maxOffsetX || 0)),
          maxOffsetY: Math.abs(Number(layerOptions.maxOffsetY || 0)),
          maxDilation: Math.max(0, Number(layerOptions.maxDilation || 0))
        }];
      }

      const parent = items.map((_, index) => index);
      const find = (index) => {
        let current = index;
        while (parent[current] !== current) current = parent[current];
        while (parent[index] !== index) {
          const next = parent[index];
          parent[index] = current;
          index = next;
        }
        return current;
      };
      const union = (a, b) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent[rootB] = rootA;
      };

      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          if (items[i].profileKey !== items[j].profileKey) continue;
          if (this._worldBoundsIntersect(items[i].expanded, items[j].expanded)) union(i, j);
        }
      }

      const groups = new Map();
      for (let i = 0; i < items.length; i += 1) {
        const root = find(i);
        let group = groups.get(root);
        const item = items[i];
        if (!group) {
          group = {
            entries: [],
            bounds: null,
            alpha: item.alpha,
            blur: item.blur,
            profileKey: item.profileKey,
            maxOffsetX: 0,
            maxOffsetY: 0,
            maxDilation: 0
          };
          groups.set(root, group);
        }
        group.entries.push(item.entry);
        group.bounds = this._mergeWorldBounds(group.bounds, item.bounds);
        const config = item.entry?.config || {};
        group.maxOffsetX = Math.max(group.maxOffsetX, Math.abs(Number(config.offsetX || 0)), Math.abs(Number(layerOptions.maxOffsetX || 0)));
        group.maxOffsetY = Math.max(group.maxOffsetY, Math.abs(Number(config.offsetY || 0)), Math.abs(Number(layerOptions.maxOffsetY || 0)));
        group.maxDilation = Math.max(group.maxDilation, Number(config.dilation || 0), Number(layerOptions.maxDilation || 0));
        group.alpha = Math.max(group.alpha, item.alpha);
        group.blur = Math.max(group.blur, item.blur);
      }

      return Array.from(groups.values())
        .map((group, index) => {
          const ids = group.entries
            .map((entry) => String(entry?.doc?.id || entry?.doc?._id || 'tile').trim())
            .filter(Boolean)
            .sort();
          const padded = this._rectFromWorldBounds(group.bounds, 8) || fallbackRect;
          return {
            key: `${group.profileKey}:${ids.length ? ids.join('|') : `chunk:${index}`}`,
            entries: group.entries,
            bounds: padded,
            alpha: group.alpha,
            blur: group.blur,
            maxOffsetX: group.maxOffsetX,
            maxOffsetY: group.maxOffsetY,
            maxDilation: group.maxDilation
          };
        })
        .filter((chunk) => chunk.bounds && chunk.entries.length)
        .sort((a, b) => {
          const ay = Number(a.bounds?.y || 0);
          const by = Number(b.bounds?.y || 0);
          if (ay !== by) return ay - by;
          const ax = Number(a.bounds?.x || 0);
          const bx = Number(b.bounds?.x || 0);
          if (ax !== bx) return ax - bx;
          return String(a.key).localeCompare(String(b.key));
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
    const alpha = Math.min(1, Math.max(0, Number(options.alpha ?? this._options.alpha ?? 0.65)));
    const blur = Math.max(0, Number(options.blur ?? this._options.blur ?? 0));
    return `a${alpha.toFixed(3)}:b${blur.toFixed(3)}`;
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
    try {
      if (!bounds) return null;
      const minX = Number.isFinite(Number(bounds.minX)) ? Number(bounds.minX) : Number(bounds.x);
      const minY = Number.isFinite(Number(bounds.minY)) ? Number(bounds.minY) : Number(bounds.y);
      const maxX = Number.isFinite(Number(bounds.maxX))
        ? Number(bounds.maxX)
        : (Number.isFinite(Number(bounds.width)) ? minX + Number(bounds.width) : NaN);
      const maxY = Number.isFinite(Number(bounds.maxY))
        ? Number(bounds.maxY)
        : (Number.isFinite(Number(bounds.height)) ? minY + Number(bounds.height) : NaN);
      if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
      return {
        minX: Math.min(minX, maxX),
        minY: Math.min(minY, maxY),
        maxX: Math.max(minX, maxX),
        maxY: Math.max(minY, maxY)
      };
    } catch (_) {
      return null;
    }
  }

  _mergeWorldBounds(a, b) {
    const left = this._normalizeWorldBounds(a);
    const right = this._normalizeWorldBounds(b);
    if (!left) return right;
    if (!right) return left;
    return {
      minX: Math.min(left.minX, right.minX),
      minY: Math.min(left.minY, right.minY),
      maxX: Math.max(left.maxX, right.maxX),
      maxY: Math.max(left.maxY, right.maxY)
    };
  }

  _inflateWorldBounds(bounds, options = {}) {
    const normalized = this._normalizeWorldBounds(bounds);
    if (!normalized) return null;
    const offsetX = Math.abs(Number(options.offsetX || 0)) || 0;
    const offsetY = Math.abs(Number(options.offsetY || 0)) || 0;
    const dilation = Math.max(0, Number(options.dilation || 0)) || 0;
    const blur = Math.max(0, Number(options.blur || 0)) || 0;
    const marginX = offsetX + dilation + (blur * 12) + 8;
    const marginY = offsetY + dilation + (blur * 12) + 8;
    return {
      minX: normalized.minX - marginX,
      minY: normalized.minY - marginY,
      maxX: normalized.maxX + marginX,
      maxY: normalized.maxY + marginY
    };
  }

  _worldBoundsIntersect(a, b) {
    const left = this._normalizeWorldBounds(a);
    const right = this._normalizeWorldBounds(b);
    if (!left || !right) return false;
    return left.minX <= right.maxX
      && left.maxX >= right.minX
      && left.minY <= right.maxY
      && left.maxY >= right.minY;
  }

  _rectFromWorldBounds(bounds, pad = 0) {
    const normalized = this._normalizeWorldBounds(bounds);
    if (!normalized) return null;
    const padding = Math.max(0, Number(pad || 0));
    const minX = normalized.minX - padding;
    const minY = normalized.minY - padding;
    const maxX = normalized.maxX + padding;
    const maxY = normalized.maxY + padding;
    return {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.max(1, Math.ceil(maxX - minX)),
      height: Math.max(1, Math.ceil(maxY - minY))
    };
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
        .map((entry) => ({
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
    } catch (_) {
      return [];
    }
  }

  _buildScatterShadowSignature(instances, cfg, scale, extra = null) {
    const dilation = Number(cfg?.dilation) || 0;
    const safeScale = Number(scale) || 1;
    const roundedDilation = Math.round(dilation * 1000) / 1000;
    const roundedScale = Math.round(safeScale * 10000) / 10000;
    try {
      const payload = { d: roundedDilation, s: roundedScale, i: instances };
      if (extra && typeof extra === 'object') {
        Object.assign(payload, extra);
      }
      return JSON.stringify(payload);
    } catch (_) {
      return '';
    }
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
    const safeScale = Number(baseScale) || 1;
    const width = Math.max(1, Number(bounds?.width || 0));
    const height = Math.max(1, Number(bounds?.height || 0));
    if (!width || !height) return safeScale;
    const pixelWidth = width * safeScale;
    const pixelHeight = height * safeScale;
    const maxDim = Math.max(pixelWidth, pixelHeight);
    const maxTextureSize = this._getMaxTextureSize();
    const scatterCap = Math.max(1024, Math.min(SCATTER_SHADOW_MAX_DIMENSION, maxTextureSize));
    if (maxDim <= scatterCap) return safeScale;
    const factor = scatterCap / maxDim;
    return Math.max(0.01, safeScale * factor);
  }

  _computeScatterShadowInstanceLimit(offsetCount) {
    const offsets = Math.max(1, Number(offsetCount) || 1);
    const maxBySprites = Math.floor(SCATTER_SHADOW_MAX_SPRITES / offsets);
    if (!Number.isFinite(maxBySprites) || maxBySprites <= 0) return 1;
    return Math.max(1, Math.min(SCATTER_SHADOW_MAX_INSTANCES, maxBySprites));
  }

  _sampleScatterShadowInstances(instances, limit) {
    if (!Array.isArray(instances)) return { instances: [], stride: 1 };
    if (!Number.isFinite(limit) || limit <= 0 || instances.length <= limit) {
      return { instances, stride: 1 };
    }
    const stride = Math.ceil(instances.length / limit);
    const sampled = [];
    for (let i = 0; i < instances.length; i += stride) {
      sampled.push(instances[i]);
    }
    return { instances: sampled, stride };
  }

  _buildScatterDilationOffsets(radius, instanceCount = 0) {
    const offsets = [{ x: 0, y: 0 }];
    const r = Math.max(0, Number(radius || 0));
    if (r < 0.5) return offsets;
    let steps = 16;
    if (instanceCount > 8000) steps = 6;
    else if (instanceCount > 4000) steps = 8;
    else if (instanceCount > 2000) steps = 12;
    const full = Math.PI * 2;
    for (let i = 0; i < steps; i += 1) {
      const angle = (full * i) / steps;
      offsets.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    const inner = r * 0.55;
    if (inner >= 0.5 && steps >= 8) {
      const innerSteps = Math.max(4, Math.floor(steps * 0.75));
      for (let i = 0; i < innerSteps; i += 1) {
        const angle = (full * i) / innerSteps + (full / (innerSteps * 2));
        offsets.push({ x: Math.cos(angle) * inner, y: Math.sin(angle) * inner });
      }
    }
    return offsets;
  }

  _computeScatterInstanceBounds(instance) {
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

  _computeScatterBounds(instances) {
    if (!Array.isArray(instances) || !instances.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const instance of instances) {
      if (!instance) continue;
      const bounds = this._computeScatterInstanceBounds(instance);
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
      if (!tileId) {
        for (const entry of this._scatterShadowCache.values()) {
          if (entry?.texture && !entry.texture.destroyed) {
            try { entry.texture.destroy(true); } catch (_) {}
          }
        }
        this._scatterShadowCache.clear();
        return;
      }
      const entry = this._scatterShadowCache.get(tileId);
      if (!entry) return;
      if (entry.texture && !entry.texture.destroyed) {
        try { entry.texture.destroy(true); } catch (_) {}
      }
      this._scatterShadowCache.delete(tileId);
    } catch (_) {}
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
    try {
      const tileId = doc?.id;
      if (!tileId || !renderer) return null;
      const flags = this._readStandardTileMask(doc);
      if (!flags) return null;
      const tile = canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === tileId) || null;
      if (!tile) {
        Logger.error('AssetShadow.standardTileMask.clipTileMissing', { tileId });
        return null;
      }

      await applyStandardTileMaskToTile(tile);
      const { sourceMask } = await this._waitForStandardMaskOverlay(tile, { tileId });
      if (!sourceMask || sourceMask.destroyed) {
        Logger.error('AssetShadow.standardTileMask.clipMaskMissing', { tileId });
        return null;
      }

      const proxyMask = cloneDisplayObjectForProxy(sourceMask);
      if (!proxyMask || proxyMask.destroyed) {
        Logger.error('AssetShadow.standardTileMask.clipProxyFailed', { tileId });
        return null;
      }
      try { proxyMask.visible = true; } catch (_) {}
      try { proxyMask.renderable = true; } catch (_) {}
      try { proxyMask.alpha = 1; } catch (_) {}

      const { width: docWidth, height: docHeight } = this._getDocDimensions(doc);
      const maxTex = this._getMaxTextureSize();
      const renderScale = Math.min(1, maxTex / Math.max(docWidth, docHeight));
      const pixelWidth = Math.max(4, Math.ceil(docWidth * renderScale));
      const pixelHeight = Math.max(4, Math.ceil(docHeight * renderScale));
      if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) {
        try { proxyMask.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        return null;
      }

      const renderTexture = PIXI.RenderTexture.create({
        width: pixelWidth,
        height: pixelHeight,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      const stage = new PIXI.Container();
      stage.eventMode = 'none';
      stage.sortableChildren = false;
      stage.interactiveChildren = false;
      stage.scale.set(renderScale, renderScale);
      stage.addChild(proxyMask);
      renderer.render(stage, { renderTexture, clear: true });

      try { proxyMask.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      try { stage.destroy({ children: false }); } catch (_) {}

      return {
        texture: renderTexture,
        bounds: { x: 0, y: 0, width: docWidth, height: docHeight },
        scale: renderScale
      };
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.clipStamp.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }

  async _getStandardMaskShadowStamp(doc, renderer) {
    try {
      const tileId = doc?.id;
      if (!tileId || !renderer) return null;
      const flags = this._readStandardTileMask(doc);
      if (!flags) {
        this._clearStandardMaskShadowCache(tileId);
        return null;
      }

      const signature = this._buildStandardMaskShadowSignature(doc, flags);
      const cached = this._standardMaskShadowCache.get(tileId);
      if (cached && cached.signature === signature && cached.texture && !cached.texture.destroyed) {
        return cached;
      }
      if (cached) this._clearStandardMaskShadowCache(tileId);

      const tile = canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === tileId) || null;
      if (!tile) {
        Logger.error('AssetShadow.standardTileMask.tileMissing', { tileId });
        return null;
      }

      await applyStandardTileMaskToTile(tile);
      const { sourceContainer, sourceBase, sourceMask } = await this._waitForStandardMaskOverlay(tile, { tileId });
      if (!sourceContainer || sourceContainer.destroyed || !sourceBase || sourceBase.destroyed || !sourceMask || sourceMask.destroyed) {
        Logger.error('AssetShadow.standardTileMask.overlayMissing', { tileId });
        return null;
      }

      const proxyBase = cloneDisplayObjectForProxy(sourceBase);
      const proxyMask = cloneDisplayObjectForProxy(sourceMask);
      if (!proxyBase || proxyBase.destroyed || !proxyMask || proxyMask.destroyed) {
        try { proxyBase?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        try { proxyMask?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        Logger.error('AssetShadow.standardTileMask.proxyCloneFailed', { tileId });
        return null;
      }
      try { proxyMask.visible = true; } catch (_) {}
      try { proxyMask.renderable = false; } catch (_) {}
      try { proxyMask.alpha = 1; } catch (_) {}
      try { proxyBase.mask = proxyMask; } catch (_) {}

      const { width: docWidth, height: docHeight } = this._getDocDimensions(doc);
      const maxTex = this._getMaxTextureSize();
      const renderScale = Math.min(1, maxTex / Math.max(docWidth, docHeight));
      const pixelWidth = Math.max(4, Math.ceil(docWidth * renderScale));
      const pixelHeight = Math.max(4, Math.ceil(docHeight * renderScale));
      if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) {
        try { proxyBase.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        try { proxyMask.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        return null;
      }

      const renderTexture = PIXI.RenderTexture.create({
        width: pixelWidth,
        height: pixelHeight,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      const stage = new PIXI.Container();
      stage.eventMode = 'none';
      stage.sortableChildren = false;
      stage.interactiveChildren = false;
      stage.scale.set(renderScale, renderScale);
      stage.addChild(proxyBase);
      stage.addChild(proxyMask);

      renderer.render(stage, { renderTexture, clear: true });

      try { proxyBase.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      try { proxyMask.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      try { stage.destroy({ children: false }); } catch (_) {}

      const entry = {
        signature,
        texture: renderTexture,
        bounds: { x: 0, y: 0, width: docWidth, height: docHeight },
        scale: renderScale
      };
      this._standardMaskShadowCache.set(tileId, entry);
      return entry;
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.shadowStamp.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return null;
    }
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
    let bounds = this._getDescriptorShadowBounds(descriptors);
    if (!bounds || !standardStamp?.texture || !renderer) return null;
    const pathDilation = Math.max(0, Number(context?.dilation || 0) || 0);
    const hasPathDescriptor = (Array.isArray(descriptors) ? descriptors : [])
      .some((descriptor) => descriptor && descriptor.kind !== 'building');
    if (hasPathDescriptor && pathDilation > 0) {
      bounds = {
        minX: bounds.minX - pathDilation,
        minY: bounds.minY - pathDilation,
        maxX: bounds.maxX + pathDilation,
        maxY: bounds.maxY + pathDilation,
        x: bounds.x - pathDilation,
        y: bounds.y - pathDilation,
        width: Math.max(1, bounds.width + (pathDilation * 2)),
        height: Math.max(1, bounds.height + (pathDilation * 2))
      };
    }
    const sourceScale = this._computeDescriptorStampScale(Number(context?.scale) || 1, bounds);
    const applyMask = context?.applyMask !== false;
    const pixelWidth = Math.max(4, Math.ceil(bounds.width * sourceScale));
    const pixelHeight = Math.max(4, Math.ceil(bounds.height * sourceScale));
    if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) return null;

    const renderTexture = PIXI.RenderTexture.create({
      width: pixelWidth,
      height: pixelHeight,
      scaleMode: PIXI.SCALE_MODES.LINEAR
    });
    const stage = new PIXI.Container();
    const body = new PIXI.Container();
    const tempObjects = [stage, body];
    const expandPathDescriptor = (descriptor) => {
      if (!(pathDilation > 0)) return descriptor;
      const baseWidth = Math.max(1, Number(descriptor?.width) || 1);
      const multiplierDelta = (pathDilation * 2) / baseWidth;
      const expandSamples = (samples) => Array.isArray(samples)
        ? samples.map((sample) => {
          if (!sample) return sample;
          const widthMultiplier = Math.max(0.01, Number(sample.widthMultiplier || 1) || 1);
          return { ...sample, widthMultiplier: widthMultiplier + multiplierDelta };
        })
        : samples;
      return {
        ...descriptor,
        samples: expandSamples(descriptor.samples),
        sourceSamples: expandSamples(descriptor.sourceSamples),
        width: baseWidth,
        maskWidth: baseWidth
      };
    };
    try {
      stage.eventMode = 'none';
      stage.sortableChildren = false;
      stage.interactiveChildren = false;
      body.eventMode = 'none';
      body.sortableChildren = false;
      body.interactiveChildren = false;

      for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
        if (!descriptor) continue;
        const isBuilding = descriptor.kind === 'building';
        let mesh = null;
        if (isBuilding) {
          const sourceDescriptor = descriptor.sourceWidth
            ? { ...descriptor, width: descriptor.sourceWidth }
            : descriptor;
          mesh = await this._createBuildingShadowMesh(sourceDescriptor, {
            scale: sourceScale,
            sceneRect: bounds,
            dilationOffset: { x: 0, y: 0 },
            offsetX: 0,
            offsetY: 0
          });
        } else if (Array.isArray(descriptor.samples) && descriptor.samples.length >= PATH_MIN_POINTS) {
          const renderDescriptor = expandPathDescriptor(descriptor);
          mesh = await this._createPathShadowMesh(renderDescriptor, {
            scale: sourceScale,
            sceneRect: bounds,
            dilationOffset: { x: 0, y: 0 },
            offsetX: 0,
            offsetY: 0,
            standardMaskDoc: doc,
            standardMaskTexture: applyMask ? standardStamp.texture : null
          });
        }
        if (!mesh) continue;
        body.addChild(mesh);
      }
      if (!body.children?.length) {
        try { renderTexture.destroy(true); } catch (_) {}
        return null;
      }

      if (!applyMask) {
        stage.addChild(body);
        renderer.render(stage, { renderTexture, clear: true });
        return { texture: renderTexture, bounds, scale: sourceScale };
      }

      const needsClipMask = Array.from(body.children || []).some((child) => !child?.faNexusStandardMaskApplied);
      if (!needsClipMask) {
        stage.addChild(body);
        renderer.render(stage, { renderTexture, clear: true });
        return { texture: renderTexture, bounds, scale: sourceScale };
      }

      const clipMaskTexture = this._createDescriptorClipMaskTexture(doc, standardStamp, renderer, { bounds, sourceScale, descriptors });
      const maskSprite = clipMaskTexture ? new PIXI.Sprite(clipMaskTexture) : null;
      if (!maskSprite) {
        Logger.error('AssetShadow.standardTileMask.descriptorSourceMaskFailed', {
          tileId: doc?.id || null
        });
        try { renderTexture.destroy(true); } catch (_) {}
        return null;
      }
      tempObjects.push(maskSprite);
      try { maskSprite.visible = true; } catch (_) {}
      try { maskSprite.renderable = false; } catch (_) {}
      try {
        for (const child of Array.isArray(body.children) ? body.children : []) {
          if (child && !child.destroyed) child.mask = maskSprite;
        }
      } catch (_) {}
      stage.addChild(body);
      stage.addChild(maskSprite);
      renderer.render(stage, { renderTexture, clear: true });
      try { clipMaskTexture.destroy(true); } catch (_) {}
      return { texture: renderTexture, bounds, scale: sourceScale };
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.descriptorSourceStamp.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      try { renderTexture.destroy(true); } catch (_) {}
      return null;
    } finally {
      try { stage.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      for (const obj of tempObjects) {
        try {
          if (obj && !obj.destroyed) obj.destroy({ children: true, texture: false, baseTexture: false });
        } catch (_) {}
      }
    }
  }

  async _getScatterShadowStamp(doc, cfg, scale, renderer) {
    try {
      const tileId = doc?.id;
      if (!tileId) return null;
      if (!renderer) return null;
      const instances = this._resolveScatterInstances(doc);
      if (!instances.length) {
        this._clearScatterShadowCache(tileId);
        return null;
      }

      const bounds = this._getScatterShadowBounds(doc, instances);
      if (!bounds) return null;

      const renderScale = this._computeScatterShadowScale(scale, bounds);
      const dilationRadius = Math.max(0, Number(cfg?.dilation || 0)) * renderScale;
      const offsets = this._buildScatterDilationOffsets(dilationRadius, instances.length);
      const instanceLimit = this._computeScatterShadowInstanceLimit(offsets.length);
      const sample = this._sampleScatterShadowInstances(instances, instanceLimit);
      const sampledInstances = sample.instances;

      const signature = this._buildScatterShadowSignature(sampledInstances, cfg, renderScale, {
        c: instances.length,
        t: sample.stride,
        w: Math.round(bounds.width || 0),
        h: Math.round(bounds.height || 0)
      });
      const cached = this._scatterShadowCache.get(tileId);
      if (cached && cached.signature === signature && cached.texture && !cached.texture.destroyed) {
        return cached;
      }
      if (cached) this._clearScatterShadowCache(tileId);

      const dilation = Math.max(0, Number(cfg?.dilation || 0));
      const minX = bounds.minX - dilation;
      const minY = bounds.minY - dilation;
      const maxX = bounds.maxX + dilation;
      const maxY = bounds.maxY + dilation;
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);

      const pixelWidth = Math.max(4, Math.ceil(width * renderScale));
      const pixelHeight = Math.max(4, Math.ceil(height * renderScale));
      if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) return null;

      const rt = PIXI.RenderTexture.create({
        width: pixelWidth,
        height: pixelHeight,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });

      const drawContainer = new PIXI.Container();
      const tempDisplayObjects = [];
      const textureCache = new Map();
      const getTexture = async (src) => {
        if (!src) return null;
        if (textureCache.has(src)) return textureCache.get(src);
        const texture = await this._obtainTexture(src);
        textureCache.set(src, texture);
        return texture;
      };

      for (const instance of sampledInstances) {
        const tex = await getTexture(instance.src);
        if (!tex) continue;
        const baseWidth = Math.max(1, Number(instance.w) || 0) * renderScale;
        const baseHeight = Math.max(1, Number(instance.h) || 0) * renderScale;
        const baseX = ((Number(instance.x) || 0) - minX) * renderScale;
        const baseY = ((Number(instance.y) || 0) - minY) * renderScale;
        const rotationDeg = Number(instance.r || 0) * (Math.PI / 180);

        for (const offset of offsets) {
          const sprite = new PIXI.Sprite(tex);
          sprite.anchor.set(0.5, 0.5);
          sprite.width = baseWidth;
          sprite.height = baseHeight;
          if (instance.flipH) sprite.scale.x *= -1;
          if (instance.flipV) sprite.scale.y *= -1;
          sprite.position.set(baseX + offset.x, baseY + offset.y);
          sprite.rotation = rotationDeg;
          sprite.alpha = 1;
          sprite.eventMode = 'none';
          drawContainer.addChild(sprite);
          tempDisplayObjects.push(sprite);
        }
      }

      if (!tempDisplayObjects.length) {
        try { rt.destroy(true); } catch (_) {}
        return null;
      }

      renderer.render(drawContainer, { renderTexture: rt, clear: true });

      for (const displayObject of tempDisplayObjects) {
        try { displayObject.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      try { drawContainer.destroy({ children: false }); } catch (_) {}

      const entry = {
        signature,
        texture: rt,
        bounds: { x: minX, y: minY, width, height },
        scale: renderScale
      };
      this._scatterShadowCache.set(tileId, entry);
      return entry;
    } catch (_) {
      return null;
    }
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
      if (!data || !shadowState || !shadowState.enabled) return [];
      const descriptors = [];
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
        const worldLoop = localLoop
          .map((point) => this._transformDocLocalPoint(doc, point, { anchorMode: 'center' }))
          .filter(Boolean);
        if (worldLoop.length < minPoints) continue;
        worldLoop.closed = closed;
        const centerline = BuildingWallMesher.buildCenterline(localLoop, {
          width: effectiveWidth,
          closed,
          centerOffset,
          textureRepeatDistance: repeatSpacing,
          textureOffset: geometryTextureOffset,
          textureFlip
        });
        const sourceCenterline = BuildingWallMesher.buildCenterline(localLoop, {
          width: scaledWidth,
          closed,
          centerOffset: textureOffset.y,
          textureRepeatDistance: repeatSpacing,
          textureOffset: geometryTextureOffset,
          textureFlip
        });
        const samples = Array.isArray(centerline?.samples) ? centerline.samples : [];
        const worldSamples = samples
          .map((sample) => {
            const worldPoint = this._transformDocLocalPoint(doc, sample, { anchorMode: 'center' });
            if (!worldPoint) return null;
            return {
              ...sample,
              x: worldPoint.x,
              y: worldPoint.y
            };
          })
          .filter(Boolean);
        const sourceWorldSamples = (Array.isArray(sourceCenterline?.samples) ? sourceCenterline.samples : [])
          .map((sample) => {
            const worldPoint = this._transformDocLocalPoint(doc, sample, { anchorMode: 'center' });
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
        const bounds = worldSamples.length
          ? computePathBounds(worldSamples, effectiveWidth)
          : this._computeLoopBounds(worldLoop, effectiveWidth);
        descriptors.push({
          kind: 'building',
          loop: worldLoop,
          closed,
          width: effectiveWidth,
          sourceWidth: scaledWidth,
          shadowDilation: dilation,
          centerOffset,
          textureOffset: { ...geometryTextureOffset },
          textureFlip: { ...textureFlip },
          textureRepeatDistance: repeatSpacing,
          bounds,
          textureSrc: segment?.texture || segment?.pathLocal || data?.wall?.texture || null,
          textureKey: segment?.pathKey || data?.wall?.pathKey || null,
          alphaMultiplier,
          startJoinDir: this._rotateDirection(segment?.startJoinDir, doc),
          endJoinDir: this._rotateDirection(segment?.endJoinDir, doc),
          clipOffsetX: Number(clipOffset?.x || 0) || 0,
          clipOffsetY: Number(clipOffset?.y || 0) || 0,
          clipOffsets
        });
      }
      if (renderSegments.length) return descriptors;

      const loops = gatherBuildingLoops(data);
      if (!loops.length) return [];
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
        const worldLoop = loop
          .map((point) => this._transformDocLocalPoint(doc, point, { anchorMode: 'center' }))
          .filter(Boolean);
        if (worldLoop.length < minPoints) continue;
        worldLoop.closed = closed;
        const centerline = BuildingWallMesher.buildCenterline(loop, {
          width: effectiveWidth,
          closed,
          centerOffset,
          textureRepeatDistance: repeatSpacing,
          textureOffset: geometryTextureOffset,
          textureFlip
        });
        const sourceCenterline = BuildingWallMesher.buildCenterline(loop, {
          width: scaledWidth,
          closed,
          centerOffset: textureOffset.y,
          textureRepeatDistance: repeatSpacing,
          textureOffset: geometryTextureOffset,
          textureFlip
        });
        const samples = Array.isArray(centerline?.samples) ? centerline.samples : [];
        const worldSamples = samples
          .map((sample) => {
            const worldPoint = this._transformDocLocalPoint(doc, sample, { anchorMode: 'center' });
            if (!worldPoint) return null;
            return {
              ...sample,
              x: worldPoint.x,
              y: worldPoint.y
            };
          })
          .filter(Boolean);
        const sourceWorldSamples = (Array.isArray(sourceCenterline?.samples) ? sourceCenterline.samples : [])
          .map((sample) => {
            const worldPoint = this._transformDocLocalPoint(doc, sample, { anchorMode: 'center' });
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
        const bounds = worldSamples.length
          ? computePathBounds(worldSamples, effectiveWidth)
          : this._computeLoopBounds(worldLoop, effectiveWidth);
        descriptors.push({
          kind: 'building',
          loop: worldLoop,
          closed,
          width: effectiveWidth,
          sourceWidth: scaledWidth,
          shadowDilation: dilation,
          centerOffset,
          textureOffset: { ...geometryTextureOffset },
          textureFlip: { ...textureFlip },
          textureRepeatDistance: repeatSpacing,
          bounds,
          textureSrc,
          textureKey,
          alphaMultiplier,
          clipOffsetX: Number(clipOffset?.x || 0) || 0,
          clipOffsetY: Number(clipOffset?.y || 0) || 0,
          clipOffsets
        });
      }
      return descriptors;
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
    try {
      if (!texture || !localBounds) return null;
      const width = Math.max(1, Number(localBounds.width || 0));
      const height = Math.max(1, Number(localBounds.height || 0));
      const scale = Number(context.scale) || 1;
      const sceneRect = context.sceneRect || { x: 0, y: 0 };
      const offsetX = Number(context.offsetX || 0);
      const offsetY = Number(context.offsetY || 0);
      const flipX = Number(context.flipX) < 0 ? -1 : 1;
      const flipY = Number(context.flipY) < 0 ? -1 : 1;
      const anchorMode = context.anchorMode || 'doc';
      const pivotLocal = this._getDocPivotLocal(doc, { anchorMode });
      const pivotWorld = this._getDocPivotWorld(doc, { anchorMode });
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(
        (pivotLocal.x - Number(localBounds.x || 0)) / width,
        (pivotLocal.y - Number(localBounds.y || 0)) / height
      );
      sprite.width = width * scale;
      sprite.height = height * scale;
      if (flipX < 0) sprite.scale.x *= -1;
      if (flipY < 0) sprite.scale.y *= -1;
      sprite.position.set(
        ((pivotWorld.x - sceneRect.x) * scale) + offsetX,
        ((pivotWorld.y - sceneRect.y) * scale) + offsetY
      );
      sprite.rotation = (Number(doc?.rotation || 0) * Math.PI) / 180;
      sprite.alpha = 1;
      sprite.eventMode = 'none';
      return sprite;
    } catch (_) {
      return null;
    }
  }

  _createWorldBoundsShadowSprite(texture, bounds, context = {}) {
    try {
      if (!texture || !bounds) return null;
      const width = Math.max(1, Number(bounds.width || 0));
      const height = Math.max(1, Number(bounds.height || 0));
      const scale = Number(context.scale) || 1;
      const sceneRect = context.sceneRect || { x: 0, y: 0 };
      const offsetX = Number(context.offsetX || 0);
      const offsetY = Number(context.offsetY || 0);
      const x = Number.isFinite(bounds.minX) ? Number(bounds.minX) : Number(bounds.x || 0);
      const y = Number.isFinite(bounds.minY) ? Number(bounds.minY) : Number(bounds.y || 0);
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0, 0);
      sprite.width = width * scale;
      sprite.height = height * scale;
      sprite.position.set(
        ((x - Number(sceneRect.x || 0)) * scale) + offsetX,
        ((y - Number(sceneRect.y || 0)) * scale) + offsetY
      );
      sprite.alpha = 1;
      sprite.eventMode = 'none';
      return sprite;
    } catch (_) {
      return null;
    }
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
      const texture = await loadPathTexture(src, { attempts: 2, timeout: 6000, bustCacheOnRetry: false });
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
      const texture = await loadPathTexture(src, { attempts: 2, timeout: 6000, bustCacheOnRetry: false });
      const visibleData = this._detectTextureVisibleRows(texture);
      if (visibleData) texture._cachedVisibleData = visibleData;
      this._textureCache.set(cacheKey, { texture, visibleData, ts: Date.now() });
      return { texture, visibleData };
    } catch (error) {
      Logger.warn('AssetShadow.buildingTexture.failed', String(error?.message || error));
      return null;
    }
  }

  async _createPathShadowMesh(descriptor, context = {}) {
    try {
      if (!descriptor || !Array.isArray(descriptor.samples) || !descriptor.samples.length) return null;
      const texture = await this._obtainPathShadowTexture(descriptor.textureSrc);
      if (!texture) return null;
      const meshOptions = descriptor.meshOptions ? { ...descriptor.meshOptions } : {};
      if (descriptor.useVisibleRows) {
        const visibleData = descriptor.visibleData || texture._cachedVisibleData || this._detectTextureVisibleRows(texture);
        if (visibleData) {
          texture._cachedVisibleData = visibleData;
          meshOptions.visibleData = visibleData;
        }
      }
      const mesh = createPathMesh(
        descriptor.samples,
        descriptor.width,
        descriptor.repeatSpacing,
        texture,
        meshOptions
      );
      if (!mesh) return null;
      mesh.eventMode = 'none';
      if (context.standardMaskTexture && context.standardMaskDoc) {
        this._applyStandardMaskShaderToPathMesh(mesh, descriptor, context.standardMaskDoc, texture, context.standardMaskTexture);
      }
      const uniforms = mesh.shader?.uniforms;
      if (uniforms?.uColor instanceof Float32Array) {
        uniforms.uColor[0] = 0;
        uniforms.uColor[1] = 0;
        uniforms.uColor[2] = 0;
        uniforms.uColor[3] = 1;
      } else if (uniforms) {
        mesh.shader.uniforms.uColor = new Float32Array([0, 0, 0, 1]);
      }
      const scale = Number(context.scale) || 1;
      const sceneRect = context.sceneRect || { x: 0, y: 0 };
      mesh.scale.set(scale, scale);
      const offset = context.dilationOffset || { x: 0, y: 0 };
      const offsetX = Number(context.offsetX || 0);
      const offsetY = Number(context.offsetY || 0);
      mesh.position.set(
        (-sceneRect.x * scale) + offset.x + offsetX,
        (-sceneRect.y * scale) + offset.y + offsetY
      );
      mesh.alpha = 1;
      return mesh;
    } catch (error) {
      Logger.warn('AssetShadow.pathMesh.failed', String(error?.message || error));
      return null;
    }
  }

  _getBuildingShadowMaterial() {
    if (this._buildingShadowMaterial && !this._buildingShadowMaterial.destroyed) {
      return this._buildingShadowMaterial;
    }
    const material = new PIXI.MeshMaterial(PIXI.Texture.WHITE);
    material.alpha = 1;
    material.tint = 0x000000;
    material.blendMode = PIXI.BLEND_MODES.NORMAL;
    this._buildingShadowMaterial = material;
    return material;
  }

  async _createBuildingShadowMesh(descriptor, context = {}) {
    try {
      if (!descriptor || !Array.isArray(descriptor.loop)) return null;
      const closed = descriptor.closed !== false;
      const minPoints = closed ? 3 : 2;
      if (descriptor.loop.length < minPoints) return null;
      const options = {
        width: Math.max(2, Number(descriptor.width) || 2),
        closed,
        joinStyle: 'mitre',
        mitreLimit: 4,
        textureRepeatDistance: Math.max(1e-3, Number(descriptor.textureRepeatDistance) || Number(descriptor.width) || 1),
        centerOffset: Number(descriptor.centerOffset) || 0,
        textureOffset: descriptor.textureOffset || { x: 0, y: 0 },
        textureFlip: descriptor.textureFlip || { horizontal: false, vertical: false },
        startJoinDir: descriptor.startJoinDir || null,
        endJoinDir: descriptor.endJoinDir || null
      };
      const geometryResult = BuildingWallMesher.buildGeometry(descriptor.loop, options);
      const geometry = geometryResult?.geometry;
      if (!geometry) return null;

      let resolvedTexture = null;
      let visibleData = null;
      if (descriptor.textureSrc) {
        const entry = await this._obtainBuildingShadowTexture(descriptor.textureSrc, descriptor.textureKey);
        resolvedTexture = entry?.texture || null;
        visibleData = entry?.visibleData || resolvedTexture?._cachedVisibleData || null;
      }
      if (visibleData) {
        this._remapGeometryVisibleRows(geometry, visibleData);
      }

      let mesh = null;
      if (resolvedTexture) {
        const shader = createPathShader(resolvedTexture);
        mesh = new PIXI.Mesh(geometry, shader);
        const uniforms = mesh.shader?.uniforms;
        if (uniforms?.uColor instanceof Float32Array) {
          uniforms.uColor[0] = 0;
          uniforms.uColor[1] = 0;
          uniforms.uColor[2] = 0;
          uniforms.uColor[3] = 1;
        } else if (uniforms) {
          mesh.shader.uniforms.uColor = new Float32Array([0, 0, 0, 1]);
        }
      } else {
        const material = this._getBuildingShadowMaterial();
        mesh = new PIXI.Mesh(geometry, material);
      }

      mesh.eventMode = 'none';
      const scale = Number(context.scale) || 1;
      const sceneRect = context.sceneRect || { x: 0, y: 0 };
      const offset = context.dilationOffset || { x: 0, y: 0 };
      const offsetX = Number(context.offsetX || 0);
      const offsetY = Number(context.offsetY || 0);
      mesh.scale.set(scale, scale);
      mesh.position.set(
        (-sceneRect.x * scale) + offset.x + offsetX,
        (-sceneRect.y * scale) + offset.y + offsetY
      );
      mesh.alpha = normalizeLayerOpacity(descriptor?.alphaMultiplier, 1);
      return mesh;
    } catch (error) {
      Logger.warn('AssetShadow.buildingMesh.failed', String(error?.message || error));
      return null;
    }
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
    try {
      return getTileOcclusionMask(doc?.occlusion, { sourceOcclusion: doc?._source?.occlusion });
    } catch (error) {
      Logger.warn('AssetShadow.occlusionMask.readFailed', {
        tileId: doc?.id || doc?._id || null,
        error: String(error?.message || error)
      });
      return 0;
    }
  }

  _getSurfaceShadowOcclusionMask() {
    return getSurfaceTileOcclusionModes()
      .map((mode) => Number(mode))
      .filter((mode) => Number.isInteger(mode) && mode > 0)
      .reduce((resolvedMask, mode) => resolvedMask | mode, 0);
  }

  _isSurfaceOnlyShadowOcclusionMask(mask) {
    const numericMask = Number(mask) || 0;
    const surfaceMask = this._getSurfaceShadowOcclusionMask();
    return !!surfaceMask && numericMask === surfaceMask;
  }

  _getTileShadowOccludedAlpha(doc) {
    const alpha = Number(doc?.occlusion?.alpha ?? doc?._source?.occlusion?.alpha);
    return clampUnit(alpha, 0);
  }

  _getTileShadowOcclusionProfile(doc) {
    const mask = this._getTileShadowOcclusionMask(doc);
    if (!mask) return {
      key: 'none',
      mask: 0,
      shareable: false,
      type: 'none'
    };

    if (this._isSurfaceOnlyShadowOcclusionMask(mask)) {
      const alphaKey = this._getTileShadowOccludedAlpha(doc).toFixed(3);
      return {
        key: `occlusion:surface:${mask}:a${alphaKey}`,
        mask,
        shareable: true,
        type: 'surface',
        alphaKey
      };
    }

    const tileId = String(doc?.id || doc?._id || '').trim();
    if (!tileId) {
      Logger.error('AssetShadow.occlusionKey.missingTileId', { mask });
      return {
        key: `occlusion:missing:${mask}`,
        mask,
        shareable: false,
        type: 'tile'
      };
    }
    return {
      key: `occlusion:${tileId}:${mask}`,
      mask,
      shareable: false,
      type: 'tile'
    };
  }

  _shouldLayerUseShadowOcclusion(layer) {
    return !!layer && String(layer.shadowOcclusionKey || 'none') !== 'none';
  }

  _ensureShadowOcclusionFilter(layer, holder = layer) {
    if (!this._shouldLayerUseShadowOcclusion(layer)) {
      if (holder?.occlusionFilter && !holder.occlusionFilter.destroyed) {
        try { holder.occlusionFilter.destroy(); } catch (_) {}
      }
      if (holder) holder.occlusionFilter = null;
      return null;
    }
    if (!globalThis.PIXI?.Filter) {
      this._logShadowOcclusionIssue(layer, 'AssetShadow.occlusionFilter.pixMissing');
      return null;
    }
    if (!holder.occlusionFilter || holder.occlusionFilter.destroyed) {
      holder.occlusionFilter = createAssetShadowOcclusionFilter(this, layer);
    }
    return holder.occlusionFilter;
  }

  _syncShadowLayerFilters(layer) {
    if (!layer) return;
    if (layer.blurFilter && !layer.blurFilter.destroyed) {
      try { layer.blurFilter.destroy(); } catch (_) {}
    }
    layer.blurFilter = null;

    const chunks = Array.from(layer.renderChunks?.values?.() || []);
    const targets = chunks.length ? chunks : [{ sprite: layer.sprite, occlusionFilter: layer.occlusionFilter }];
    for (const target of targets) {
      if (!target?.sprite || target.sprite.destroyed) continue;
      if (target.usesOcclusionMesh) {
        try { target.sprite.filters = null; } catch (_) {}
        this._syncShadowOcclusionMeshRuntime(layer, target.sprite);
        continue;
      }
      const filters = [];
      const occlusionFilter = this._ensureShadowOcclusionFilter(layer, target);
      if (occlusionFilter && !occlusionFilter.destroyed) filters.push(occlusionFilter);
      try { target.sprite.filters = filters.length ? filters : null; }
      catch (error) {
        Logger.warn('AssetShadow.filters.syncFailed', {
          layerKey: layer?.key || null,
          error: String(error?.message || error)
        });
      }
    }
    if (!chunks.length && targets[0]) layer.occlusionFilter = targets[0].occlusionFilter || null;
  }

  _getLayerOcclusionDoc(layer) {
    if (!this._shouldLayerUseShadowOcclusion(layer)) return null;
    const docs = Array.from(layer?.tiles?.values?.() || []);
    const doc = docs[0] || null;
    if (!doc) {
      this._logShadowOcclusionIssue(layer, 'AssetShadow.occlusionFilter.missingDoc');
      return null;
    }
    if (docs.length > 1) {
      const profile = layer?.shadowOcclusionProfile || null;
      const incompatibleDocs = profile?.shareable
        ? docs.filter((entry) => this._getTileShadowOcclusionProfile(entry).key !== layer.shadowOcclusionKey)
        : docs;
      if (profile?.shareable && !incompatibleDocs.length) return doc;

      const tileIds = docs
        .map((entry) => entry?.id || entry?._id || null)
        .filter(Boolean);
      this._logShadowOcclusionIssue(layer, 'AssetShadow.occlusionFilter.sharedLayer', {
        tileIds,
        shareable: !!profile?.shareable,
        incompatibleTileIds: incompatibleDocs
          .map((entry) => entry?.id || entry?._id || null)
          .filter(Boolean)
      });
      return null;
    }
    return doc;
  }

  _syncShadowOcclusionMeshRuntime(layer, displayObject) {
    if (!displayObject || displayObject.destroyed) return false;
    try {
      const doc = this._getLayerOcclusionDoc(layer);
      const tile = doc ? this._getTilePlaceableForDocument(doc) : null;
      const sourceMesh = tile?.mesh || null;
      const sourceState = sourceMesh?._occlusionState || null;
      const targetState = displayObject._occlusionState || null;
      if (!doc || !tile || !sourceMesh || !sourceState || !targetState) {
        if (targetState) {
          targetState.fade = 0;
          targetState.radial = 0;
          targetState.vision = 0;
          targetState.surface = 0;
        }
        displayObject.occlusionMode = 0;
        displayObject.occluded = false;
        displayObject.unoccludedAlpha = 1;
        displayObject.occludedAlpha = 0;
        this._logShadowOcclusionIssue(layer, 'AssetShadow.occlusionMesh.missingMeshState', {
          tileId: doc?.id || doc?._id || null,
          hasTile: !!tile,
          hasMesh: !!sourceMesh,
          hasState: !!sourceState
        });
        return false;
      }

      displayObject.elevation = sourceMesh.elevation ?? doc.elevation ?? layer?.elevation ?? 0;
      displayObject._occludedBySameElevationSurfaces = sourceMesh._occludedBySameElevationSurfaces !== false;
      displayObject.occlusionMode = Number(sourceMesh.occlusionMode ?? this._getTileShadowOcclusionMask(doc) ?? 0) || 0;
      displayObject.occluded = !!sourceMesh.occluded;
      displayObject.unoccludedAlpha = 1;
      displayObject.occludedAlpha = clampUnit(sourceMesh.occludedAlpha ?? doc?.occlusion?.alpha, 0);
      targetState.fade = clampUnit(sourceState.fade, 0);
      targetState.radial = clampUnit(sourceState.radial, 0);
      targetState.vision = clampUnit(sourceState.vision, 0);
      targetState.surface = clampUnit(sourceState.surface, 0);
      if (typeof displayObject._updateBatchData === 'function') displayObject._updateBatchData();
      this._clearShadowOcclusionIssue(layer);
      return true;
    } catch (error) {
      Logger.warn('AssetShadow.occlusionMesh.syncFailed', {
        layerKey: layer?.key || null,
        error: String(error?.message || error)
      });
      return false;
    }
  }

  _getTilePlaceableForDocument(doc) {
    try {
      const tileId = String(doc?.id || doc?._id || '').trim();
      if (!tileId) return null;
      const direct = canvas?.tiles?.get?.(tileId);
      if (direct) return direct;
      const placeables = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
      return placeables.find((tile) => tile?.document === doc || String(tile?.document?.id || tile?.document?._id || '') === tileId) || null;
    } catch (_) {
      return null;
    }
  }

  _prepareShadowOcclusionUniforms(layer, uniforms) {
    if (!uniforms) return;
    const doc = this._getLayerOcclusionDoc(layer);
    const tile = doc ? this._getTilePlaceableForDocument(doc) : null;
    const mesh = tile?.mesh || null;
    const state = mesh?._occlusionState || null;
    const occlusionMask = canvas?.masks?.occlusion || null;

    uniforms.screenDimensions = canvas?.screenDimensions || [1, 1];
    uniforms.occlusionTexture = occlusionMask?.renderTexture || getTransparentTexture();
    uniforms.occlusionElevation = mapTileOcclusionElevation(tile || doc, {
      mesh,
      document: doc,
      occlusionMask,
      fallback: layer?.elevation ?? 0
    }) ?? occlusionMask?.mapElevation?.(mesh?.elevation ?? doc?.elevation ?? layer?.elevation ?? 0) ?? 0;
    uniforms.unoccludedAlpha = 1;
    uniforms.occludedAlpha = clampUnit(mesh?.occludedAlpha ?? doc?.occlusion?.alpha, 0);

    if (!doc || !tile || !mesh || !state) {
      uniforms.fadeOcclusion = 0;
      uniforms.radialOcclusion = 0;
      uniforms.visionOcclusion = 0;
      uniforms.surfaceOcclusion = 0;
      this._logShadowOcclusionIssue(layer, 'AssetShadow.occlusionFilter.missingMeshState', {
        tileId: doc?.id || doc?._id || null,
        hasTile: !!tile,
        hasMesh: !!mesh,
        hasState: !!state
      });
      return;
    }

    uniforms.fadeOcclusion = clampUnit(state.fade, 0);
    uniforms.radialOcclusion = clampUnit(state.radial, 0);
    uniforms.visionOcclusion = clampUnit(state.vision, 0);
    uniforms.surfaceOcclusion = clampUnit(state.surface, 0);
    this._clearShadowOcclusionIssue(layer);
  }

  _logShadowOcclusionIssue(layer, code, details = {}) {
    try {
      const key = `${code}:${JSON.stringify(details)}`;
      if (layer && layer.occlusionIssueKey === key) return;
      if (layer) layer.occlusionIssueKey = key;
      Logger.error(code, {
        layerKey: layer?.key || null,
        shadowOcclusionKey: layer?.shadowOcclusionKey || null,
        ...details
      });
    } catch (_) {}
  }

  _clearShadowOcclusionIssue(layer) {
    try { if (layer) layer.occlusionIssueKey = null; } catch (_) {}
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
    const chunkList = Array.isArray(renderChunks) ? renderChunks : [];
    if (!layer.renderChunks) layer.renderChunks = new Map();
    const activeKeys = new Set(chunkList.map((chunk) => String(chunk?.key || '')).filter(Boolean));

    for (const [key, chunk] of Array.from(layer.renderChunks.entries())) {
      if (activeKeys.has(key)) continue;
      this._destroyLayerRenderChunk(layer, chunk);
      layer.renderChunks.delete(key);
    }

    for (const chunkInfo of chunkList) {
      const key = String(chunkInfo?.key || '').trim();
      if (!key) continue;
      if (!layer.renderChunks.has(key)) {
        layer.renderChunks.set(key, this._createLayerRenderChunk(layer, key));
      }
    }

    const ordered = new Map();
    for (const chunkInfo of chunkList) {
      const key = String(chunkInfo?.key || '').trim();
      const chunk = layer.renderChunks.get(key);
      if (!key || !chunk) continue;
      ordered.set(key, chunk);
      try { layer.container?.addChild?.(chunk.sprite); } catch (_) {}
    }
    layer.renderChunks = ordered;

    const first = ordered.values().next().value || null;
    layer.renderTexture = first?.renderTexture || null;
    return ordered;
  }

  _createLayerRenderChunk(layer, key) {
    const occlusionMesh = this._shouldLayerUseShadowOcclusion(layer)
      ? this._createShadowOcclusionChunkMesh(layer, key)
      : null;
    const sprite = occlusionMesh || new PIXI.Sprite(PIXI.Texture.EMPTY);
    sprite.anchor.set(0, 0);
    sprite.visible = false;
    sprite.eventMode = 'none';
    sprite.name = `fa-nexus-shadow-chunk:${key}`;
    try { layer.container?.addChild?.(sprite); } catch (_) {}
    return {
      key,
      sprite,
      renderTexture: null,
      rawRenderTexture: null,
      occlusionFilter: null,
      blurFilter: null,
      usesOcclusionMesh: !!occlusionMesh,
      sceneRect: null,
      scale: 1
    };
  }

  _createShadowOcclusionChunkMesh(layer, key) {
    try {
      const classes = getPrimaryShadowOcclusionMeshClasses();
      if (!classes) {
        if (!this._shadowOcclusionMeshUnavailableLogged) {
          this._shadowOcclusionMeshUnavailableLogged = true;
          Logger.error('AssetShadow.occlusionMesh.unavailable', {
            layerKey: layer?.key || null
          });
        }
        return null;
      }
      const rendererPlugins = canvas?.app?.renderer?.plugins || null;
      if (!rendererPlugins?.batchOcclusion) {
        if (!this._shadowOcclusionBatchUnavailableLogged) {
          this._shadowOcclusionBatchUnavailableLogged = true;
          Logger.error('AssetShadow.occlusionMesh.batchPluginUnavailable', {
            layerKey: layer?.key || null
          });
        }
        return null;
      }

      const { PrimarySpriteMesh, PrimaryBaseSamplerShader } = classes;
      const mesh = new PrimarySpriteMesh(PIXI.Texture.EMPTY, PrimaryBaseSamplerShader);
      mesh.name = `fa-nexus-shadow-occlusion-chunk:${key}`;
      mesh.eventMode = 'none';
      mesh.pluginName = 'batchOcclusion';
      mesh.unoccludedAlpha = 1;
      mesh.occludedAlpha = 0;
      mesh.occlusionMode = 0;
      mesh.occluded = false;
      this._syncShadowOcclusionMeshRuntime(layer, mesh);

      const manager = this;
      const originalUpdateTransform = mesh.updateTransform;
      mesh.updateTransform = function faNexusShadowOcclusionUpdateTransform(...args) {
        const result = originalUpdateTransform.apply(this, args);
        manager._syncShadowOcclusionMeshRuntime(layer, this);
        return result;
      };
      return mesh;
    } catch (error) {
      Logger.error('AssetShadow.occlusionMesh.createFailed', {
        layerKey: layer?.key || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }

  _hideLayerRenderChunk(layer, chunk) {
    try {
      if (!chunk?.sprite || chunk.sprite.destroyed) return;
      const previousTexture = chunk.renderTexture || null;
      chunk.sprite.visible = false;
      chunk.sprite.filters = null;
      if (chunk.occlusionFilter && !chunk.occlusionFilter.destroyed) {
        try { chunk.occlusionFilter.destroy(); } catch (_) {}
      }
      chunk.occlusionFilter = null;
      if (chunk.renderTexture && !chunk.renderTexture.destroyed) {
        try { chunk.renderTexture.destroy(true); } catch (_) {}
      }
      if (chunk.rawRenderTexture && !chunk.rawRenderTexture.destroyed) {
        try { chunk.rawRenderTexture.destroy(true); } catch (_) {}
      }
      chunk.renderTexture = null;
      chunk.rawRenderTexture = null;
      if (layer?.renderTexture === previousTexture) layer.renderTexture = null;
    } catch (_) {}
  }

  _destroyLayerRenderChunk(layer, chunk) {
    if (!chunk) return;
    const previousTexture = chunk.renderTexture || null;
    try { chunk.sprite && (chunk.sprite.filters = null); } catch (_) {}
    if (chunk.renderTexture && !chunk.renderTexture.destroyed) {
      try { chunk.renderTexture.destroy(true); } catch (_) {}
    }
    if (chunk.rawRenderTexture && !chunk.rawRenderTexture.destroyed) {
      try { chunk.rawRenderTexture.destroy(true); } catch (_) {}
    }
    if (chunk.blurFilter && !chunk.blurFilter.destroyed) {
      try { chunk.blurFilter.destroy(); } catch (_) {}
    }
    if (chunk.occlusionFilter && !chunk.occlusionFilter.destroyed) {
      try { chunk.occlusionFilter.destroy(); } catch (_) {}
    }
    try { chunk.sprite?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    chunk.renderTexture = null;
    chunk.rawRenderTexture = null;
    if (layer?.renderTexture === previousTexture) layer.renderTexture = null;
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
    for (const timer of this._rebuildTimers.values()) {
      try { clearTimeout(timer); } catch (_) {}
    }
    this._rebuildTimers.clear();
    this._pendingRebuilds.clear();
    this._pendingRebuildImmediate = false;
    this._rebuildSuspendCount = 0;
    for (const elevation of Array.from(this._layers.keys())) {
      this._destroyLayer(elevation);
    }
    this._layers.clear();
    this._tileIndex.clear();
    this._clearSourceTextureCache('clear-all-layers');
    this._clearScatterShadowCache();
    this._clearStandardMaskShadowCache();
    this._levelScopeWarnings.clear();
    this._blankRenderValidationBudget = SHADOW_BLANK_VALIDATION_BUDGET;
    this._previewElevationOverrides.clear();
    this._previewShadowOverrides.clear();
  }

  _destroyLayer(elevation) {
    const layer = this._layers.get(elevation);
    if (!layer) return;
    const timer = this._rebuildTimers.get(elevation);
    if (timer) {
      try { clearTimeout(timer); } catch (_) {}
      this._rebuildTimers.delete(elevation);
    }
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
    if (layer.renderTexture && !layer.renderTexture.destroyed) {
      try { layer.renderTexture.destroy(true); } catch (_) {}
    }
    if (layer.rawRenderTexture && !layer.rawRenderTexture.destroyed) {
      try { layer.rawRenderTexture.destroy(true); } catch (_) {}
    }
    layer.renderTexture = null;
    layer.rawRenderTexture = null;
    if (layer.blurFilter && !layer.blurFilter.destroyed) {
      try { layer.blurFilter.destroy(); } catch (_) {}
      layer.blurFilter = null;
    }
    if (layer.occlusionFilter && !layer.occlusionFilter.destroyed) {
      try { layer.occlusionFilter.destroy(); } catch (_) {}
      layer.occlusionFilter = null;
    }
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
      if (!flags || !Object.prototype.hasOwnProperty.call(flags, key)) return undefined;
      const numeric = Number(flags[key]);
      return Number.isFinite(numeric) ? numeric : undefined;
    } catch (_) {
      return undefined;
    }
  }

  _resolveShadowEnabled(doc) {
    const override = this._getTilePreviewShadowOverride(doc);
    if (override && Object.prototype.hasOwnProperty.call(override, 'enabled')) {
      return !!override.enabled;
    }
    try {
      const value = doc?.getFlag?.(MODULE_ID, 'shadow');
      if (value !== undefined && value !== null) return !!value;
    } catch (_) {}
    const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
    return !!flags?.shadow;
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
    return this._previewElevationOverrides.get(numericElevation) || null;
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

  setElevationPreviewShadowOverride(elevation, override = null, { immediate = true } = {}) {
    try {
      const numericElevation = Number(elevation);
      if (!Number.isFinite(numericElevation)) return false;
      const normalizedOverride = this._normalizeElevationPreviewShadowOverride(override);
      if (normalizedOverride) this._previewElevationOverrides.set(numericElevation, normalizedOverride);
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

  _computeSortBelow(layer) {
    try {
      const docs = Array.from(layer?.tiles?.values?.() || []);
      const baseDoc = docs[0] || null;
      const minSort = docs.reduce((lowest, doc) => {
        const numericSort = Number(doc?.sort ?? 0) || 0;
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

  getElevationSettings(elevation) {
    try {
      const target = Number(elevation ?? 0) || 0;
      const docs = this._collectShadowTilesAtElevation(target);
      const tileCount = Array.isArray(docs) ? docs.length : 0;
      const baseOptions = { ...this._options };
      const layerKeys = this._resolveLayerKeys(target);
      const layers = layerKeys
        .map((layerKey) => this._layers.get(layerKey) || null)
        .filter(Boolean);
      const firstLayer = layers[0] || null;
      const previewOverride = this._getElevationPreviewShadowOverride(target);
      if (!tileCount) {
        const offset = this._computeOffsetVector(baseOptions.offsetDistance, baseOptions.offsetAngle);
        return {
          alpha: Number(previewOverride?.alpha ?? baseOptions.alpha ?? 0.65),
          dilation: Number(baseOptions.dilation ?? 0),
          blur: Number(previewOverride?.blur ?? baseOptions.blur ?? 0),
          offsetDistance: Number(baseOptions.offsetDistance ?? 0),
          offsetAngle: Number(baseOptions.offsetAngle ?? 135),
          offsetX: Number(offset.x || 0),
          offsetY: Number(offset.y || 0),
          tileCount,
          hasTiles: false
        };
      }

      const doc = docs[0];
      const approx = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.0005;
      const firstConfig = this._extractTileShadowConfig(doc, baseOptions);
      let dilationMixed = false;
      let offsetMixed = false;
      let distanceMixed = false;
      let angleMixed = false;

      for (let i = 1; i < docs.length; i += 1) {
        const otherConfig = this._extractTileShadowConfig(docs[i], baseOptions);
        if (!dilationMixed && !approx(otherConfig.dilation, firstConfig.dilation)) dilationMixed = true;
        if (!offsetMixed && (!approx(otherConfig.offsetX, firstConfig.offsetX) || !approx(otherConfig.offsetY, firstConfig.offsetY))) offsetMixed = true;
        if (!distanceMixed && !approx(otherConfig.offsetDistance, firstConfig.offsetDistance)) distanceMixed = true;
        if (!angleMixed && !approx(otherConfig.offsetAngle, firstConfig.offsetAngle)) angleMixed = true;
      }

      return {
        alpha: Math.min(1, Math.max(0, Number(previewOverride?.alpha ?? firstLayer?.options?.alpha ?? this._readTileShadowNumber(doc, 'shadowAlpha') ?? this._options.alpha ?? 0.65))),
        dilation: Math.max(0, firstConfig.dilation),
        blur: Math.max(0, Number(previewOverride?.blur ?? firstLayer?.options?.blur ?? this._readTileShadowNumber(doc, 'shadowBlur') ?? this._options.blur ?? 0)),
        offsetDistance: Math.min(MAX_OFFSET_DISTANCE, Math.max(0, firstConfig.offsetDistance)),
        offsetAngle: this._normalizeAngle(firstConfig.offsetAngle),
        offsetX: firstConfig.offsetX,
        offsetY: firstConfig.offsetY,
        tileCount,
        hasTiles: tileCount > 0,
        mixedDilation: dilationMixed,
        mixedOffset: offsetMixed,
        mixedOffsetDistance: distanceMixed,
        mixedOffsetAngle: angleMixed
      };
    } catch (error) {
      Logger.warn('AssetShadow.getElevation.failed', String(error?.message || error));
      return null;
    }
  }

  async applyElevationSettings(elevation, settings = {}) {
    try {
      if (!canvas?.scene) return false;
      const docs = this._collectShadowTilesAtElevation(elevation);
      if (!docs.length) return false;
      const hasAlpha = Object.prototype.hasOwnProperty.call(settings, 'alpha');
      const hasBlur = Object.prototype.hasOwnProperty.call(settings, 'blur');
      const hasDilation = Object.prototype.hasOwnProperty.call(settings, 'dilation');
      const hasOffsetDistance = Object.prototype.hasOwnProperty.call(settings, 'offsetDistance');
      const hasOffsetAngle = Object.prototype.hasOwnProperty.call(settings, 'offsetAngle');
      const hasOffsetX = Object.prototype.hasOwnProperty.call(settings, 'offsetX');
      const hasOffsetY = Object.prototype.hasOwnProperty.call(settings, 'offsetY');
      const wantsOffsets = hasOffsetDistance || hasOffsetAngle || hasOffsetX || hasOffsetY;

      const alpha = hasAlpha
        ? Math.min(1, Math.max(0, Number(settings.alpha)))
        : null;
      const blur = hasBlur
        ? Math.max(0, Number(settings.blur))
        : null;
      const dilation = hasDilation
        ? Math.max(0, Number(settings.dilation))
        : null;
      const offsetDistance = hasOffsetDistance
        ? Math.min(MAX_OFFSET_DISTANCE, Math.max(0, Number(settings.offsetDistance)))
        : null;
      const offsetAngle = hasOffsetAngle
        ? this._normalizeAngle(settings.offsetAngle)
        : null;
      const explicitOffsetX = hasOffsetX ? Number(settings.offsetX) : null;
      const explicitOffsetY = hasOffsetY ? Number(settings.offsetY) : null;

      let vector = null;
      if (wantsOffsets) {
        if (Number.isFinite(explicitOffsetX) && Number.isFinite(explicitOffsetY)) {
          vector = {
            x: Math.max(-MAX_OFFSET_DISTANCE, Math.min(MAX_OFFSET_DISTANCE, explicitOffsetX)),
            y: Math.max(-MAX_OFFSET_DISTANCE, Math.min(MAX_OFFSET_DISTANCE, explicitOffsetY))
          };
        } else {
          const dist = offsetDistance !== null ? offsetDistance : Math.min(MAX_OFFSET_DISTANCE, Math.max(0, Number(this._options.offsetDistance ?? 0)));
          const ang = offsetAngle !== null ? offsetAngle : this._normalizeAngle(this._options.offsetAngle ?? 135);
          vector = this._computeOffsetVector(dist, ang);
        }
      }

      const updates = [];
      const approx = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.0005;

      for (const doc of docs) {
        if (!doc) continue;
        const update = { _id: doc.id };
        let changed = false;

        const assign = (key, value) => {
          const next = Number(value);
          if (!Number.isFinite(next)) return;
          const current = doc.getFlag('fa-nexus', key);
          if (current === undefined || current === null || !approx(current, next)) {
            update[`flags.fa-nexus.${key}`] = next;
            changed = true;
          }
        };

        if (!doc.getFlag('fa-nexus', 'shadow')) {
          update['flags.fa-nexus.shadow'] = true;
          changed = true;
        }

        if (hasAlpha && alpha !== null) assign('shadowAlpha', alpha);
        if (hasDilation && dilation !== null) assign('shadowDilation', dilation);
        if (hasBlur && blur !== null) assign('shadowBlur', blur);
        if (wantsOffsets && vector) {
          if (hasOffsetDistance && offsetDistance !== null) assign('shadowOffsetDistance', offsetDistance);
          if (hasOffsetAngle && offsetAngle !== null) assign('shadowOffsetAngle', offsetAngle);
          assign('shadowOffsetX', vector.x);
          assign('shadowOffsetY', vector.y);
        }

        if (changed) updates.push(update);
      }

        const matchingLayerKeys = this._resolveLayerKeys(Number(elevation ?? 0) || 0);
        for (const layerKey of matchingLayerKeys) {
          const layer = this._layers.get(layerKey) || null;
          if (!layer) continue;
          if (hasAlpha && alpha !== null) layer.options.alpha = Math.min(1, Math.max(0, Number(alpha)));
          if (hasBlur && blur !== null) layer.options.blur = Math.max(0, Number(blur));
        }

      if (!updates.length) return false;
      await canvas.scene.updateEmbeddedDocuments('Tile', updates, { diff: false });
      this._scheduleRebuild(Number(elevation ?? 0) || 0, true);
      return true;
    } catch (error) {
      Logger.warn('AssetShadow.applyElevation.failed', String(error?.message || error));
      return false;
    }
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
        width: Math.max(1, Math.ceil(maxX - minX)),
        height: Math.max(1, Math.ceil(maxY - minY))
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
      width: Math.max(1, Math.ceil(maxX - minX)),
      height: Math.max(1, Math.ceil(maxY - minY))
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
    const texture = getOrCreatePixiTexture(key);
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
  Hooks.once('ready', () => {
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
