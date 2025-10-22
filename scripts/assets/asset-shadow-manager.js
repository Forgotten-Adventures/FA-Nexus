import { NexusLogger as Logger } from '../core/nexus-logger.js';

let _singleton = null;
const MAX_OFFSET_DISTANCE = 40;

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
    this._rebuildTimers = new Map();
    this._renderer = null;
    this._hooksBound = false;
    this._sceneRect = { x: 0, y: 0, width: 0, height: 0 };
    this._options = {
      alpha: 0.65,
      dilation: 1.6,
      blur: 1.8,
      offsetDistance: 0,
      offsetAngle: 135,
      debounce: 2
    };

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

    const hooks = globalThis?.Hooks;
    if (hooks && typeof hooks.on === 'function') {
      try { hooks.on('canvasReady', this._boundCanvasReady); } catch (_) {}
      try { hooks.on('createTile', this._boundCreateTile); } catch (_) {}
      try { hooks.on('updateTile', this._boundUpdateTile); } catch (_) {}
      try { hooks.on('deleteTile', this._boundDeleteTile); } catch (_) {}
      try { hooks.on('canvasPan', this._boundCanvasPan); } catch (_) {}
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

    if (!hasShadow) {
      if (prevElevation !== undefined) this._removeTile(doc);
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

  _scheduleRebuild(elevation, immediate = false) {
    const layer = this._layers.get(elevation);
    if (!layer || !canvas?.ready) return;
    layer.dirty = true;
    const handle = this._rebuildTimers.get(elevation);
    if (handle) {
      try { clearTimeout(handle); } catch (_) {}
      this._rebuildTimers.delete(elevation);
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

      // Update layer options from first tile's flags
      const firstDoc = docs[0];
      const layerOptions = { ...this._options };
      try {
        const alpha = firstDoc.getFlag('fa-nexus', 'shadowAlpha');
        if (alpha !== undefined) {
          const numericAlpha = Number(alpha);
          if (Number.isFinite(numericAlpha)) layerOptions.alpha = Math.min(1, Math.max(0, numericAlpha));
        }
        const dilation = firstDoc.getFlag('fa-nexus', 'shadowDilation');
        if (dilation !== undefined) {
          const numericDilation = Number(dilation);
          if (Number.isFinite(numericDilation)) layerOptions.dilation = Math.max(0, numericDilation);
        }
        const blur = firstDoc.getFlag('fa-nexus', 'shadowBlur');
        if (blur !== undefined) {
          const numericBlur = Number(blur);
          if (Number.isFinite(numericBlur)) layerOptions.blur = Math.max(0, numericBlur);
        }
        let explicitOffset = null;
        const offsetDistance = firstDoc.getFlag('fa-nexus', 'shadowOffsetDistance');
        if (offsetDistance !== undefined) {
          const numericDistance = Number(offsetDistance);
          if (Number.isFinite(numericDistance)) layerOptions.offsetDistance = Math.min(MAX_OFFSET_DISTANCE, Math.max(0, numericDistance));
        }
        const offsetAngle = firstDoc.getFlag('fa-nexus', 'shadowOffsetAngle');
        if (offsetAngle !== undefined) {
          const numericAngle = Number(offsetAngle);
          if (Number.isFinite(numericAngle)) layerOptions.offsetAngle = this._normalizeAngle(numericAngle);
        }
        const offsetXFlag = firstDoc.getFlag('fa-nexus', 'shadowOffsetX');
        const offsetYFlag = firstDoc.getFlag('fa-nexus', 'shadowOffsetY');
        if (offsetXFlag !== undefined || offsetYFlag !== undefined) {
          const ox = Number(offsetXFlag);
          const oy = Number(offsetYFlag);
          const finiteX = Number.isFinite(ox) ? ox : 0;
          const finiteY = Number.isFinite(oy) ? oy : 0;
          if (Number.isFinite(ox) || Number.isFinite(oy)) {
            explicitOffset = { x: finiteX, y: finiteY };
          }
        }
        if (explicitOffset) {
          layerOptions.offsetX = explicitOffset.x;
          layerOptions.offsetY = explicitOffset.y;
          const dist = Math.min(MAX_OFFSET_DISTANCE, Math.hypot(explicitOffset.x, explicitOffset.y));
          if (dist > 0.0001) {
            layerOptions.offsetDistance = dist;
            layerOptions.offsetAngle = this._normalizeAngle(Math.atan2(explicitOffset.y, explicitOffset.x) * (180 / Math.PI));
          }
        }
      } catch (_) {}
      const computedOffset = this._computeOffsetVector(layerOptions.offsetDistance, layerOptions.offsetAngle);
      layerOptions.offsetX = Number.isFinite(Number(layerOptions.offsetX)) ? Number(layerOptions.offsetX) : computedOffset.x;
      layerOptions.offsetY = Number.isFinite(Number(layerOptions.offsetY)) ? Number(layerOptions.offsetY) : computedOffset.y;
      layer.options = layerOptions;

      const baseRect = this._getSceneRect();
      let sr = this._expandSceneRectForDocs(baseRect, docs);
      sr = this._applyShadowMargins(sr, layerOptions);
      this._sceneRect = sr;
      const scale = this._computeTextureScale(sr);
      const texWidth = Math.max(4, Math.round(sr.width * scale));
      const texHeight = Math.max(4, Math.round(sr.height * scale));

      if (!Number.isFinite(texWidth) || !Number.isFinite(texHeight)) return;

      let rt = layer.renderTexture;
      if (!rt || rt.destroyed || rt.width !== texWidth || rt.height !== texHeight) {
        if (rt && !rt.destroyed) {
          try { rt.destroy(true); } catch (_) {}
        }
        rt = PIXI.RenderTexture.create({ width: texWidth, height: texHeight, scaleMode: PIXI.SCALE_MODES.LINEAR });
        layer.renderTexture = rt;
      } else {
        renderer.render(new PIXI.Container(), { renderTexture: rt, clear: true });
      }

      const drawContainer = new PIXI.Container();
      const tempSprites = [];
      const dilationWorld = Math.max(0, Number(layer.options.dilation || 0));
      const dilationOffsets = this._buildDilationOffsets(dilationWorld * scale);
      const offsetXScaled = Number(layer.options.offsetX ?? 0) * scale;
      const offsetYScaled = Number(layer.options.offsetY ?? 0) * scale;

      for (const doc of docs) {
        try {
          const tex = await this._obtainTexture(doc?.texture?.src);
          if (!tex) continue;
          const texScaleX = Number(doc?.texture?.scaleX ?? 1) || 1;
          const texScaleY = Number(doc?.texture?.scaleY ?? 1) || 1;
          const flipX = texScaleX < 0 ? -1 : 1;
          const flipY = texScaleY < 0 ? -1 : 1;
          const baseWidth = Math.max(1, Number(doc.width || doc.shape?.width || 0)) * scale;
          const baseHeight = Math.max(1, Number(doc.height || doc.shape?.height || 0)) * scale;
          const dx = ((Number(doc.x) || 0) - sr.x) + (Number(doc.width) || 0) / 2;
          const dy = ((Number(doc.y) || 0) - sr.y) + (Number(doc.height) || 0) / 2;
          const baseX = dx * scale;
          const baseY = dy * scale;
          const rotationDeg = Number(doc.rotation || 0) * (Math.PI / 180);

          for (const offset of dilationOffsets) {
            const sprite = new PIXI.Sprite(tex);
            sprite.anchor.set(0.5, 0.5);
            sprite.width = baseWidth;
            sprite.height = baseHeight;
            if (flipX < 0) sprite.scale.x *= -1;
            if (flipY < 0) sprite.scale.y *= -1;
            sprite.position.set(baseX + offset.x + offsetXScaled, baseY + offset.y + offsetYScaled);
            sprite.rotation = rotationDeg;
            sprite.alpha = 1;
            drawContainer.addChild(sprite);
            tempSprites.push(sprite);
          }
        } catch (e) {
          Logger.warn('AssetShadow.sprite.failed', String(e?.message || e));
        }
      }

      renderer.render(drawContainer, { renderTexture: rt, clear: true });

      for (const sprite of tempSprites) {
        try { sprite.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      try { drawContainer.destroy({ children: false }); } catch (_) {}

      this._applyLayerTexture(layer, sr, rt, scale);
      this._syncLayerOrdering(layer);
    } catch (e) {
      Logger.warn('AssetShadow.rebuild.failed', String(e?.message || e));
    } finally {
      layer.rebuilding = false;
      if (layer.dirty) this._scheduleRebuild(elevation, true);
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
      sprite.filters = layer.blurFilter ? [layer.blurFilter] : null;
    } catch (e) {
      Logger.warn('AssetShadow.applyTexture.failed', String(e?.message || e));
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
    const dist = Math.min(MAX_OFFSET_DISTANCE, Math.max(0, Number(distance || 0)));
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
      blur.quality = 4;
      blur.repeatEdgePixels = true;
      layer.blurFilter = blur;
    }
    const zoom = Math.max(0.1, canvas?.stage?.scale?.x || 1);
    layer.blurFilter.blur = blurAmount * zoom;
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
      const targetElevation = Number(layer.elevation || 0);
      const sort = this._computeSortBelow(layer.elevation) - 0.0001;
      if (Number.isFinite(sort)) {
        try { container.sort = sort; } catch (_) {}
        try { container.faNexusSort = sort; } catch (_) {}
        try { container.zIndex = sort; } catch (_) {}
      }
      try { container.faNexusElevation = targetElevation; } catch (_) {}
      try { container.elevation = targetElevation; } catch (_) {}
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
      return !!doc?.getFlag?.('fa-nexus', 'shadow');
    } catch (_) {
      const flags = doc?.flags;
      return !!(flags && flags['fa-nexus'] && flags['fa-nexus'].shadow);
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

      const alpha = Math.min(1, Math.max(0, readFlag('shadowAlpha', baseOptions.alpha)));
      const dilation = Math.max(0, readFlag('shadowDilation', baseOptions.dilation));
      const blur = Math.max(0, readFlag('shadowBlur', baseOptions.blur));
      const offsetDistance = Math.min(MAX_OFFSET_DISTANCE, Math.max(0, readFlag('shadowOffsetDistance', baseOptions.offsetDistance)));
      const offsetAngle = this._normalizeAngle(readFlag('shadowOffsetAngle', baseOptions.offsetAngle));
      let offsetX = readFlag('shadowOffsetX', undefined);
      let offsetY = readFlag('shadowOffsetY', undefined);
      if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
        const vec = this._computeOffsetVector(offsetDistance, offsetAngle);
        offsetX = vec.x;
        offsetY = vec.y;
      }

      return {
        alpha,
        dilation,
        blur,
        offsetDistance,
        offsetAngle,
        offsetX,
        offsetY,
        tileCount,
        hasTiles: tileCount > 0
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
      const alpha = Math.min(1, Math.max(0, Number(settings.alpha ?? this._options.alpha ?? 0.65)));
      const dilation = Math.max(0, Number(settings.dilation ?? this._options.dilation ?? 0));
      const blur = Math.max(0, Number(settings.blur ?? this._options.blur ?? 0));
      const offsetDistance = Math.min(MAX_OFFSET_DISTANCE, Math.max(0, Number(settings.offsetDistance ?? this._options.offsetDistance ?? 0)));
      const offsetAngle = this._normalizeAngle(settings.offsetAngle ?? this._options.offsetAngle ?? 135);
      const explicitOffsetX = Number(settings.offsetX);
      const explicitOffsetY = Number(settings.offsetY);
      const vector = (Number.isFinite(explicitOffsetX) && Number.isFinite(explicitOffsetY))
        ? { x: explicitOffsetX, y: explicitOffsetY }
        : this._computeOffsetVector(offsetDistance, offsetAngle);

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

        assign('shadowAlpha', alpha);
        assign('shadowDilation', dilation);
        assign('shadowBlur', blur);
        assign('shadowOffsetDistance', offsetDistance);
        assign('shadowOffsetAngle', offsetAngle);
        assign('shadowOffsetX', vector.x);
        assign('shadowOffsetY', vector.y);

        if (changed) updates.push(update);
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

  _expandSceneRectForDocs(baseRect, docs) {
    const rect = baseRect && Number.isFinite(baseRect.width) && Number.isFinite(baseRect.height)
      ? { x: baseRect.x, y: baseRect.y, width: baseRect.width, height: baseRect.height }
      : { x: 0, y: 0, width: 0, height: 0 };

    let minX = Number.isFinite(rect.x) ? rect.x : Infinity;
    let minY = Number.isFinite(rect.y) ? rect.y : Infinity;
    let maxX = Number.isFinite(rect.x + rect.width) ? rect.x + rect.width : -Infinity;
    let maxY = Number.isFinite(rect.y + rect.height) ? rect.y + rect.height : -Infinity;

    if (!Array.isArray(docs) || !docs.length) {
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return { x: 0, y: 0, width: 4096, height: 4096 };
      }
      return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
    }

    for (const doc of docs) {
      const bounds = this._computeTileBounds(doc);
      if (!bounds) continue;
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return rect;
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
      const width = Number(doc?.width || doc?.shape?.width || 0) || 0;
      const height = Number(doc?.height || doc?.shape?.height || 0) || 0;
      if (width <= 0 || height <= 0) return null;
      const x = Number(doc?.x || 0) || 0;
      const y = Number(doc?.y || 0) || 0;
      const rotation = Number(doc?.rotation || 0) * (Math.PI / 180);
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const hw = width / 2;
      const hh = height / 2;
      const cx = x + hw;
      const cy = y + hh;
      const corners = [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: hw, y: hh },
        { x: -hw, y: hh }
      ];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const corner of corners) {
        const px = cx + corner.x * cos - corner.y * sin;
        const py = cy + corner.x * sin + corner.y * cos;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
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

  _getMaxTextureSize() {
    try {
      const gl = this._renderer?.gl || this._renderer?.context?.gl || canvas?.app?.renderer?.gl;
      if (!gl) return 4096;
      const val = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const max = Number(val || 4096) || 4096;
      return Math.max(1024, Math.min(max, 8192));
    } catch (_) { return 4096; }
  }

  async _obtainTexture(src) {
    if (!src) return null;
    if (/\.(webm|mp4|ogg)$/i.test(src)) return null;
    const key = AssetShadowManager._encode(src);
    const cached = this._textureCache.get(key);
    if (cached && cached.texture && !cached.texture.baseTexture?.destroyed) {
      return cached.texture;
    }
    const texture = PIXI.Texture.from(key);
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
      if (!setting || setting.namespace !== 'fa-nexus' || setting.key !== 'assetDropShadow') return;
      if (setting.value) {
        const mgr = AssetShadowManager.getInstance();
        mgr?.refreshAll?.();
      } else {
        const mgr = AssetShadowManager.peek();
        mgr?._clearAllLayers?.();
      }
    } catch (_) {}
  });
} catch (_) {}

export function getAssetShadowManager(app) {
  return AssetShadowManager.getInstance(app);
}
