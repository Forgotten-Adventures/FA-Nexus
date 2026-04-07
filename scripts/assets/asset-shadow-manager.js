import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { gatherBuildingLoops } from '../buildings/building-shape-helpers.js';
import { BuildingWallMesher } from '../buildings/building-wall-mesher.js';
import { getTileRenderElevation } from '../canvas/elevation-band-utils.js';
import { cloneDisplayObjectForCustomTileProxy } from '../canvas/custom-tile-overhead.js';
import { getOrCreatePixiTexture } from '../core/foundry-texture-loader-patch.js';
import { applyStandardTileMaskToTile, getFlattenedChunkEntries } from '../textures/texture-render.js';
import { readShadowQualityConfig } from './shadow-quality.js';
import {
  computeSamplesFromPoints as computePathSamples,
  computeBoundsFromSamples as computePathBounds,
  createMeshFromSamples as createPathMesh,
  loadPathTexture,
  createPathShader,
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

function normalizeLayerOpacity(value, fallback = 1) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.min(1, Math.max(0, numeric));
  const fallbackNumeric = Number(fallback);
  if (Number.isFinite(fallbackNumeric)) return Math.min(1, Math.max(0, fallbackNumeric));
  return 1;
}

/**
 * Manages aggregated drop-shadow render layers for FA Nexus asset tiles.
 * Proof-of-concept: collects tiles flagged with `flags.fa-nexus.shadow`, groups them
 * by elevation, and renders a shared blurred mask slightly below the tile layer.
 */
export class AssetShadowManager {
  /**
   * @param {import('../nexus-app.js').FaNexusApp} app
   */
  constructor(app) {
    if (_singleton) return _singleton;
    this.app = app;
    this._layers = new Map();
    this._tileIndex = new Map(); // tile id -> elevation key
    this._textureCache = new Map();
    this._scatterShadowCache = new Map();
    this._standardMaskShadowCache = new Map();
    this._rebuildTimers = new Map();
    this._renderer = null;
    this._hooksBound = false;
    this._suspendedTiles = new Map(); // tile id -> { doc, elevation }
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
      if (!tileDocument || !this._isShadowTile(tileDocument)) return;
      if (this._suspendedTiles.has(tileDocument.id)) this._suspendedTiles.delete(tileDocument.id);
      this._addTile(tileDocument);
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
    this._boundCreateTile = (doc) => this._onCreateTile(doc);
    this._boundUpdateTile = (doc) => this._onUpdateTile(doc);
    this._boundDeleteTile = (doc) => this._onDeleteTile(doc);
    this._boundCanvasPan = () => this._onCanvasPan();
    this._boundElevationBandChanged = () => {
      try {
        for (const layer of this._layers.values()) this._syncLayerOrdering(layer);
        const parent = this._getCanvasParent();
        if (parent) parent.sortDirty = true;
      } catch (_) {}
    };

    const hooks = globalThis?.Hooks;
    if (hooks && typeof hooks.on === 'function') {
      try { hooks.on('canvasReady', this._boundCanvasReady); } catch (_) {}
      try { hooks.on('createTile', this._boundCreateTile); } catch (_) {}
      try { hooks.on('updateTile', this._boundUpdateTile); } catch (_) {}
      try { hooks.on('deleteTile', this._boundDeleteTile); } catch (_) {}
      try { hooks.on('canvasPan', this._boundCanvasPan); } catch (_) {}
      try { hooks.on('fa-nexus-token-elevation-offset-changed', this._boundElevationBandChanged); } catch (_) {}
    }

    if (canvas?.ready) {
      // Defer to next microtask so canvas internals finish initialisation
      queueMicrotask(() => this._onCanvasReady());
    }
  }

  _updateRenderer() {
    try {
      this._renderer = canvas?.app?.renderer || null;
    } catch (_) {
      this._renderer = null;
    }
  }

  _onCanvasReady() {
    if (!canvas || !canvas.ready) return;
    this._updateRenderer();
    this._clearAllLayers();
    this._sceneRect = this._getSceneRect();

    const placeables = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const placeable of placeables) {
      const doc = placeable?.document;
      if (!doc || !this._isShadowTile(doc)) continue;
      this._addTile(doc, { deferRebuild: true });
    }

    for (const elevation of this._layers.keys()) {
      this._scheduleRebuild(elevation, true);
    }
  }

  _onCreateTile(doc) {
    if (!doc || !this._isShadowTile(doc)) return;
    this._addTile(doc);
  }

  _onUpdateTile(doc) {
    if (!doc) return;
    const hasShadow = this._isShadowTile(doc);
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
      suspendedEntry.elevation = this._getTileElevation(doc);
      return;
    }

    const elevation = this._getTileElevation(doc);
    if (prevElevation !== undefined && prevElevation !== elevation) {
      this._removeTile(doc);
    }
    this._addTile(doc);
  }

  _onDeleteTile(doc) {
    if (!doc) return;
    if (this._suspendedTiles.has(doc.id)) {
      this._suspendedTiles.delete(doc.id);
    }
    if (!this._tileIndex.has(doc.id)) return;
    this._removeTile(doc);
  }

  _onCanvasPan() {
    try {
      for (const layer of this._layers.values()) {
        this._ensureBlurFilter(layer);
      }
    } catch (e) {
      Logger.warn('AssetShadow.onCanvasPan.failed', String(e?.message || e));
    }
  }

  _addTile(doc, { deferRebuild = false } = {}) {
    try {
      if (!doc) return;
      const elevation = this._getTileElevation(doc);
      const layer = this._ensureLayer(elevation);
      if (!layer) return;
      layer.tiles.set(doc.id, doc);
      this._tileIndex.set(doc.id, elevation);
      if (!deferRebuild) this._scheduleRebuild(elevation);
    } catch (e) {
      Logger.warn('AssetShadow.addTile.failed', String(e?.message || e));
    }
  }

  _removeTile(doc) {
    try {
      const tileId = doc?.id;
      if (!tileId || !this._tileIndex.has(tileId)) return;
      const elevation = this._tileIndex.get(tileId);
      this._tileIndex.delete(tileId);
      this._suspendedTiles.delete(tileId);
      this._clearScatterShadowCache(tileId);
      this._clearStandardMaskShadowCache(tileId);
      const layer = this._layers.get(elevation);
      if (!layer) return;
      layer.tiles.delete(tileId);
      if (!layer.tiles.size) {
        this._destroyLayer(elevation);
        return;
      }
      this._scheduleRebuild(elevation);
    } catch (e) {
      Logger.warn('AssetShadow.removeTile.failed', String(e?.message || e));
    }
  }

  suspendTile(tileDocument) {
    try {
      const doc = tileDocument?.document ?? tileDocument;
      if (!doc) return false;
      const tileId = doc.id;
      if (!tileId) return false;
      if (this._suspendedTiles.has(tileId)) return true;
      const elevation = this._tileIndex.get(tileId);
      if (elevation === undefined) return false;
      const layer = this._layers.get(elevation);
      if (!layer || !layer.tiles.has(tileId)) return false;
      layer.tiles.delete(tileId);
      this._tileIndex.delete(tileId);
      this._suspendedTiles.set(tileId, { doc, elevation });
      this._scheduleRebuild(elevation, true);
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
      const tileId = doc.id;
      if (!tileId) return false;
      const entry = this._suspendedTiles.get(tileId);
      if (!entry) return false;
      this._suspendedTiles.delete(tileId);
      this._addTile(doc);
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

  _scheduleRebuild(elevation, immediate = false) {
    const layer = this._layers.get(elevation);
    if (!layer || !canvas?.ready) return;
    layer.dirty = true;
    const handle = this._rebuildTimers.get(elevation);
    if (handle) {
      try { clearTimeout(handle); } catch (_) {}
      this._rebuildTimers.delete(elevation);
    }
    if (this._rebuildSuspendCount > 0) {
      this._pendingRebuilds.add(elevation);
      if (immediate) this._pendingRebuildImmediate = true;
      return;
    }
    const run = () => {
      this._rebuildTimers.delete(elevation);
      this._rebuildLayer(elevation);
    };
    if (immediate) {
      run();
      return;
    }
    const delay = Math.max(16, Number(this._options.debounce || 0));
    const timer = setTimeout(run, delay);
    this._rebuildTimers.set(elevation, timer);
  }

  async _rebuildLayer(elevation) {
    const layer = this._layers.get(elevation);
    if (!layer || !canvas?.ready) return;
    if (!layer.dirty && !layer.rebuilding) return;
    if (layer.rebuilding) {
      layer.dirty = true;
      return;
    }
    layer.rebuilding = true;
    layer.dirty = false;

    try {
      this._updateRenderer();
      const renderer = this._renderer;
      if (!renderer) return;

      const docs = [];
      for (const doc of layer.tiles.values()) {
        if (!doc || doc.isEmbedded && doc.parent !== canvas.scene) continue;
        docs.push(doc);
      }
      if (!docs.length) {
        this._destroyLayer(elevation);
        return;
      }

      // Resolve shared layer settings and per-tile configuration
      const firstDoc = docs[0];
      const baseOptions = this._extractShadowBaseOptions(firstDoc);
      const tileConfigs = [];
      const pathBoundsList = [];
      let maxOffsetX = Math.abs(baseOptions.offsetX);
      let maxOffsetY = Math.abs(baseOptions.offsetY);
      let maxDilation = baseOptions.dilation;

      for (const doc of docs) {
        const cfg = this._extractTileShadowConfig(doc, baseOptions);
        const pathDescriptors = this._resolveShadowPathDescriptors(doc);
        if (Array.isArray(pathDescriptors) && pathDescriptors.length) {
          for (const descriptor of pathDescriptors) {
            if (descriptor?.bounds) pathBoundsList.push(descriptor.bounds);
          }
        }
        tileConfigs.push({ doc, config: cfg, paths: pathDescriptors });
        if (Math.abs(cfg.offsetX) > maxOffsetX) maxOffsetX = Math.abs(cfg.offsetX);
        if (Math.abs(cfg.offsetY) > maxOffsetY) maxOffsetY = Math.abs(cfg.offsetY);
        if (cfg.dilation > maxDilation) maxDilation = cfg.dilation;
      }

      const layerOptions = {
        alpha: baseOptions.alpha,
        blur: baseOptions.blur,
        maxOffsetX,
        maxOffsetY,
        maxDilation
      };
      layer.options = layerOptions;

      const baseRect = this._getSceneRect();
      let sr = this._expandSceneRectForDocs(baseRect, docs);
      if (pathBoundsList.length) {
        sr = this._expandRectWithPathBounds(sr, pathBoundsList);
      }
      sr = this._applyShadowMargins(sr, {
        offsetX: maxOffsetX,
        offsetY: maxOffsetY,
        dilation: maxDilation,
        blur: layerOptions.blur
      });
      this._sceneRect = sr;
      const scale = this._computeTextureScale(sr);
      const texWidth = Math.max(4, Math.round(sr.width * scale));
      const texHeight = Math.max(4, Math.round(sr.height * scale));

      if (!Number.isFinite(texWidth) || !Number.isFinite(texHeight)) return;

      const drawContainer = new PIXI.Container();
      const tempDisplayObjects = [];
      const dilationCache = new Map();

      const getOffsetsForRadius = (radius) => {
        const key = Number.isFinite(radius) ? radius.toFixed(3) : '0';
        if (dilationCache.has(key)) return dilationCache.get(key);
        const list = this._buildDilationOffsets(radius);
        dilationCache.set(key, list);
        return list;
      };

      for (const entry of tileConfigs) {
        const { doc, config: cfg, paths } = entry;
        const descriptors = Array.isArray(paths) ? paths.filter(Boolean) : [];
        try {
          const dilationRadius = Math.max(0, Number(cfg.dilation || 0)) * scale;
          const offsets = getOffsetsForRadius(dilationRadius);
          const offsetXScaled = Number(cfg.offsetX ?? 0) * scale;
          const offsetYScaled = Number(cfg.offsetY ?? 0) * scale;
          const applyOffsetX = offsetXScaled;
          const applyOffsetY = offsetYScaled;

          if (descriptors.length) {
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
                if (!mesh) continue;
                drawContainer.addChild(mesh);
                tempDisplayObjects.push(mesh);
              }
            }
            continue;
          }

          const scatterStamp = await this._getScatterShadowStamp(doc, cfg, scale, renderer);
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

          const standardMaskFlags = this._readStandardTileMask(doc);
          if (standardMaskFlags) {
            const standardStamp = await this._getStandardMaskShadowStamp(doc, renderer);
            if (!standardStamp?.texture) {
              Logger.error('AssetShadow.standardTileMask.shadowStampFailed', {
                tileId: doc?.id,
                src: doc?.texture?.src || null
              });
              continue;
            }
            for (const offset of offsets) {
              const sprite = this._createDocShadowSprite(standardStamp.texture, doc, standardStamp.bounds, {
                scale,
                sceneRect: sr,
                offsetX: offset.x + applyOffsetX,
                offsetY: offset.y + applyOffsetY,
                anchorMode: 'doc'
              });
              if (!sprite) continue;
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
          Logger.warn('AssetShadow.sprite.failed', String(e?.message || e));
        }
      }

      const renderTexture = this._renderLayerToTexture(layer, drawContainer, renderer, texWidth, texHeight);
      if (renderTexture) this._applyLayerTexture(layer, sr, renderTexture, scale);

      for (const displayObject of tempDisplayObjects) {
        try { displayObject.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      try { drawContainer.destroy({ children: false }); } catch (_) {}

      this._syncLayerOrdering(layer);
    } catch (e) {
      Logger.warn('AssetShadow.rebuild.failed', String(e?.message || e));
    } finally {
      layer.rebuilding = false;
      if (layer.dirty) this._scheduleRebuild(elevation, true);
    }
  }

  _getShadowQualityConfig() {
    return readShadowQualityConfig();
  }

  _renderLayerToTexture(layer, drawContainer, renderer, texWidth, texHeight) {
    try {
      if (layer?.container) layer.container.filters = null;

      let renderTexture = layer.renderTexture || null;
      if (!renderTexture || renderTexture.destroyed || renderTexture.width !== texWidth || renderTexture.height !== texHeight) {
        if (renderTexture && !renderTexture.destroyed) {
          try { renderTexture.destroy(true); } catch (_) {}
        }
        renderTexture = PIXI.RenderTexture.create({
          width: texWidth,
          height: texHeight,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        layer.renderTexture = renderTexture;
      }

      renderer.render(drawContainer, { renderTexture, clear: true });
      return renderTexture;
    } catch (error) {
      Logger.warn('AssetShadow.renderTexture.failed', String(error?.message || error));
      return null;
    }
  }

  _applyLayerTexture(layer, sceneRect, renderTexture, scale) {
    try {
      const sprite = layer.sprite;
      if (!sprite) return;
      sprite.texture = renderTexture;
      sprite.position.set(sceneRect.x, sceneRect.y);
      const invScale = scale ? 1 / scale : 1;
      sprite.scale.set(invScale, invScale);
      sprite.tint = 0x000000;
      sprite.alpha = Number(layer.options.alpha || 0.35);
      sprite.visible = true;

      this._ensureBlurFilter(layer);
      if (layer.container) layer.container.filters = null;
      sprite.filters = layer.blurFilter ? [layer.blurFilter] : null;
    } catch (e) {
      Logger.warn('AssetShadow.applyTexture.failed', String(e?.message || e));
    }
  }

  _extractShadowBaseOptions(doc) {
    const defaults = {
      alpha: Math.min(1, Math.max(0, Number(this._options.alpha ?? 0.65))),
      blur: Math.max(0, Number(this._options.blur ?? 0)),
      dilation: Math.max(0, Number(this._options.dilation ?? 0)),
      offsetDistance: Math.min(MAX_OFFSET_DISTANCE, Math.max(0, Number(this._options.offsetDistance ?? 0))),
      offsetAngle: this._normalizeAngle(this._options.offsetAngle ?? 135)
    };

    const read = (key) => {
      try {
        const value = doc?.getFlag?.('fa-nexus', key);
        if (value === undefined || value === null) return undefined;
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : undefined;
      } catch (_) {
        return undefined;
      }
    };

    const alpha = (() => {
      const value = read('shadowAlpha');
      return value !== undefined ? Math.min(1, Math.max(0, value)) : defaults.alpha;
    })();

    const blur = (() => {
      const value = read('shadowBlur');
      return value !== undefined ? Math.max(0, value) : defaults.blur;
    })();

    const dilation = (() => {
      const value = read('shadowDilation');
      return value !== undefined ? Math.max(0, value) : defaults.dilation;
    })();

    const offsetDistance = (() => {
      const value = read('shadowOffsetDistance');
      return value !== undefined
        ? Math.min(MAX_OFFSET_DISTANCE, Math.max(-MAX_OFFSET_DISTANCE, value))
        : defaults.offsetDistance;
    })();

    const offsetAngle = (() => {
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
    const read = (key) => {
      try {
        const value = doc?.getFlag?.('fa-nexus', key);
        if (value === undefined || value === null) return undefined;
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : undefined;
      } catch (_) {
        return undefined;
      }
    };

    let dilation = (() => {
      const value = read('shadowDilation');
      return value !== undefined ? Math.max(0, value) : Math.max(0, base.dilation);
    })();
    const usesGeometryDilation = this._usesBuildingShadowGeometry(doc);
    if (usesGeometryDilation) dilation = 0;

    const offsetDistance = (() => {
      const value = read('shadowOffsetDistance');
      return value !== undefined
        ? Math.min(MAX_OFFSET_DISTANCE, Math.max(-MAX_OFFSET_DISTANCE, value))
        : Math.min(MAX_OFFSET_DISTANCE, Math.max(-MAX_OFFSET_DISTANCE, base.offsetDistance));
    })();

    const offsetAngle = (() => {
      const value = read('shadowOffsetAngle');
      return value !== undefined ? this._normalizeAngle(value) : this._normalizeAngle(base.offsetAngle);
    })();

    let offsetX = read('shadowOffsetX');
    let offsetY = read('shadowOffsetY');
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
      const vec = this._computeOffsetVector(offsetDistance, offsetAngle);
      offsetX = vec.x;
      offsetY = vec.y;
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
      if (!entry) return;
      if (entry.texture && !entry.texture.destroyed) {
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
      const sourceContainer = tile?.mesh?.faNexusStandardMaskContainer
        || tile?.faNexusStandardMaskContainer
        || null;
      const sourceBase = sourceContainer?.faNexusBaseDisplayObject
        || sourceContainer?.faNexusBaseSprite
        || null;
      const sourceMask = sourceContainer?.faNexusMaskSprite || null;
      if (!sourceContainer || sourceContainer.destroyed || !sourceBase || sourceBase.destroyed || !sourceMask || sourceMask.destroyed) {
        Logger.error('AssetShadow.standardTileMask.overlayMissing', { tileId });
        return null;
      }

      const proxyBase = cloneDisplayObjectForCustomTileProxy(sourceBase);
      const proxyMask = cloneDisplayObjectForCustomTileProxy(sourceMask);
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
      if (!shadow || !shadow.enabled) return null;
      const pointsRaw = Array.isArray(shadow.points) ? shadow.points : [];
      if (pointsRaw.length < PATH_MIN_POINTS) return null;
      const points = [];
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
      if (points.length < PATH_MIN_POINTS) return null;
      const sampleCount = Math.max(2, Math.floor(pathFlags?.samplesPerSegment || PATH_DEFAULT_SEGMENT_SAMPLES));
      const tension = Number(pathFlags?.tension ?? 0) || 0;
      const closed = !!pathFlags?.closed && points.length >= PATH_MIN_POINTS;
      const samples = computePathSamples(points, sampleCount, tension, { closed });
      if (!Array.isArray(samples) || !samples.length) return null;
      const shadowScale = Math.max(0.05, Number(pathFlags?.shadow?.scale) || 1);
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
        width: pathWidth,
        repeatSpacing,
        meshOptions,
        bounds,
        textureSrc,
        useVisibleRows
      };
    } catch (error) {
      Logger.warn('AssetShadow.pathDescriptor.failed', String(error?.message || error));
      return null;
    }
  }

  _resolveBuildingShadowDescriptors(doc) {
    try {
      const data = doc?.getFlag?.('fa-nexus', 'building');
      const shadowState = data?.wall?.pathShadow;
      if (!data || !shadowState || !shadowState.enabled) return [];
      const descriptors = [];
      const renderSegments = Array.isArray(data?.wall?.renderSegments) ? data.wall.renderSegments : [];
      for (const segment of renderSegments) {
        const shadow = segment?.pathShadow || shadowState;
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
        const bounds = worldSamples.length
          ? computePathBounds(worldSamples, effectiveWidth)
          : this._computeLoopBounds(worldLoop, effectiveWidth);
        descriptors.push({
          kind: 'building',
          loop: worldLoop,
          closed,
          width: effectiveWidth,
          centerOffset,
          textureOffset: { ...geometryTextureOffset },
          textureFlip: { ...textureFlip },
          textureRepeatDistance: repeatSpacing,
          bounds,
          textureSrc: segment?.texture || segment?.pathLocal || data?.wall?.texture || null,
          textureKey: segment?.pathKey || data?.wall?.pathKey || null,
          alphaMultiplier,
          startJoinDir: this._rotateDirection(segment?.startJoinDir, doc),
          endJoinDir: this._rotateDirection(segment?.endJoinDir, doc)
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
        const bounds = worldSamples.length
          ? computePathBounds(worldSamples, effectiveWidth)
          : this._computeLoopBounds(worldLoop, effectiveWidth);
        descriptors.push({
          kind: 'building',
          loop: worldLoop,
          closed,
          width: effectiveWidth,
          centerOffset,
          textureOffset: { ...geometryTextureOffset },
          textureFlip: { ...textureFlip },
          textureRepeatDistance: repeatSpacing,
          bounds,
          textureSrc,
          textureKey,
          alphaMultiplier
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

  _getDocPivotWorld(doc, options = {}) {
    const pivotLocal = this._getDocPivotLocal(doc, options);
    return {
      x: (Number(doc?.x) || 0) + pivotLocal.x,
      y: (Number(doc?.y) || 0) + pivotLocal.y
    };
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
    const zoomX = Number(canvas?.stage?.scale?.x);
    const zoomY = Number(canvas?.stage?.scale?.y);
    const zoomCandidates = [];
    if (Number.isFinite(zoomX)) zoomCandidates.push(Math.abs(zoomX));
    if (Number.isFinite(zoomY)) zoomCandidates.push(Math.abs(zoomY));
    const zoom = zoomCandidates.length ? Math.max(...zoomCandidates) : 1;
    const targetBlur = Math.min(64, Math.max(0.25, blurAmount * Math.max(0.05, zoom)));
    layer.blurFilter.blur = targetBlur;
    layer.blurFilter.quality = this._computeBlurQuality(targetBlur);
  }

  _ensureLayer(elevation) {
    if (this._layers.has(elevation)) return this._layers.get(elevation);
    if (!canvas || !canvas.ready) return null;

    const layer = {
      elevation,
      container: null,
      sprite: null,
      renderTexture: null,
      blurFilter: null,
      tiles: new Map(),
      options: { ...this._options },
      rebuilding: false,
      dirty: true
    };

    const container = new PIXI.Container();
    container.eventMode = 'none';
    container.sortableChildren = false;
    container.visible = true;
    container.name = `fa-nexus-shadow:${elevation}`;

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

    this._layers.set(elevation, layer);
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
      const renderElevation = getTileRenderElevation(docElevation);
      const sort = this._computeSortBelow(layer.elevation) - 0.0001;
      if (Number.isFinite(sort)) {
        try { container.sort = sort; } catch (_) {}
        try { container.faNexusSort = sort; } catch (_) {}
        try { container.zIndex = sort; } catch (_) {}
      }
      try { container.faNexusElevationDoc = docElevation; } catch (_) {}
      try { container.faNexusElevation = renderElevation; } catch (_) {}
      try { container.elevation = renderElevation; } catch (_) {}
      const tilesLayer = canvas?.tiles;
      const sortLayer = tilesLayer?.constructor?.SORT_LAYERS?.TILES ?? tilesLayer?.sortLayer ?? 0;
      try { container.sortLayer = sortLayer; } catch (_) {}
    } catch (e) {
      Logger.warn('AssetShadow.syncOrdering.failed', String(e?.message || e));
    }
  }

  _clearAllLayers() {
    for (const elevation of Array.from(this._layers.keys())) {
      this._destroyLayer(elevation);
    }
    this._layers.clear();
    this._tileIndex.clear();
    this._clearScatterShadowCache();
    this._clearStandardMaskShadowCache();
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
    if (layer.renderTexture && !layer.renderTexture.destroyed) {
      try { layer.renderTexture.destroy(true); } catch (_) {}
    }
    if (layer.blurFilter && !layer.blurFilter.destroyed) {
      try { layer.blurFilter.destroy(); } catch (_) {}
      layer.blurFilter = null;
    }
    if (layer.container) {
      try {
        const parent = layer.container.parent;
        if (parent) parent.removeChild(layer.container);
      } catch (_) {}
      try { layer.container.destroy({ children: true }); } catch (_) {}
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
      return !!doc?.getFlag?.(MODULE_ID, 'shadow');
    } catch (_) {
      const hidden = doc?._source?.hidden;
      if (hidden && !game?.user?.isGM) return false;
      const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
      if (!flags) return false;
      if (flags[LAYER_HIDDEN_FLAG]) return false;
      const alpha = Number(doc?.alpha ?? 1);
      if (Number.isFinite(alpha) && alpha <= 0) return false;
      return !!flags.shadow;
    }
  }

  _getTileElevation(doc) {
    try { return Number(doc.elevation ?? 0) || 0; }
    catch (_) { return 0; }
  }

  _computeSortBelow(elevation) {
    try {
      const list = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
      let minSort = Number.POSITIVE_INFINITY;
      for (const tile of list) {
        const doc = tile?.document;
        if (!doc) continue;
        if (Number(doc.elevation || 0) !== Number(elevation || 0)) continue;
        const sort = Number(doc.sort ?? 0) || 0;
        if (sort < minSort) minSort = sort;
      }
      if (!Number.isFinite(minSort)) return 0;
      return minSort - 0.0001;
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
      const layer = this._layers.get(target) || null;
      const docs = layer ? Array.from(layer.tiles.values()) : this._collectShadowTilesAtElevation(target);
      const tileCount = Array.isArray(docs) ? docs.length : 0;
      const baseOptions = { ...this._options };
      if (!tileCount) {
        const offset = this._computeOffsetVector(baseOptions.offsetDistance, baseOptions.offsetAngle);
        return {
          alpha: Number(baseOptions.alpha ?? 0.65),
          dilation: Number(baseOptions.dilation ?? 0),
          blur: Number(baseOptions.blur ?? 0),
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
      const readDocFlag = (key, fallback) => {
        try {
          const value = doc.getFlag('fa-nexus', key);
          if (value === undefined || value === null) return fallback;
          const numeric = Number(value);
          return Number.isFinite(numeric) ? numeric : fallback;
        } catch (_) {
          return fallback;
        }
      };

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
        alpha: Math.min(1, Math.max(0, readDocFlag('shadowAlpha', layer?.options?.alpha ?? this._options.alpha ?? 0.65))),
        dilation: Math.max(0, firstConfig.dilation),
        blur: Math.max(0, readDocFlag('shadowBlur', layer?.options?.blur ?? this._options.blur ?? 0)),
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

      const layer = this._layers.get(Number(elevation ?? 0) || 0) || null;
      if (layer) {
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
    } catch (_) {}
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
    } catch (_) {}
  });
} catch (_) {}

export function getAssetShadowManager(app) {
  return AssetShadowManager.getInstance(app);
}
