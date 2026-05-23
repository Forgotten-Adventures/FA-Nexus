import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  applyHsbcToDisplayObject,
  readDocumentHsbc
} from '../core/hsbc.js';
import {
  attachCustomTileOverhead,
  detachCustomTileOverhead,
  invalidateCustomTileOverhead
} from '../canvas/custom-tile-overhead.js';
import { cloneDisplayObjectForProxy } from '../canvas/display-object-proxy.js';
import {
  ensureTileMesh,
  ensureMeshTransparent,
  getSharedTexture,
  restoreMeshTexture
} from '../textures/texture-runtime-core.js';
import { syncStandardMaskCustomSourceSuppression } from '../textures/standard-mask-custom-base.js';
import { syncShadowOnlyCustomContainer } from './shadow-only-runtime.js';

const SCATTER_FLAG_KEY = 'assetScatter';
const SCATTER_VERSION = 1;
const SCATTER_CACHE_INSTANCE_THRESHOLD = 32;
const SCATTER_CACHE_MIN_SIZE = 2;
const SCATTER_CACHE_TEXTURE_FALLBACK = 4096;
const SCATTER_CACHE_TEXTURE_CAP = 4096;
const SCATTER_CACHE_CHUNK_BLEED = 1;
const SCATTER_TEXTURE_READY_REFRESH_DELAY = 100;
const SCATTER_VIEWPORT_LIVE_MIN_SCALE = 0.35;
const SCATTER_VIEWPORT_PADDING_SCREEN_PX = 96;
const SCATTER_VIEWPORT_KEY_GRANULARITY = 128;
const SCATTER_VIEWPORT_MAX_LIVE_SPRITES = 8000;
const SCATTER_CAPTURE_MAX_LIVE_SPRITES = 60000;
const SCATTER_VIEWPORT_REFRESH_DELAY = 50;
const TEXTURE_CACHE = new Map();
const SCATTER_RETRY_TIMERS = new Map();
const SCATTER_REFRESH_TIMERS = new Map();
const SCATTER_PAYLOAD_CACHE = new WeakMap();
let scatterViewportRefreshTimer = null;

function logScatterFailure(event, error, details = {}) {
  Logger.warn('AssetScatter.runtime.failed', {
    event,
    error: String(error?.message || error),
    ...details
  });
}

function notifyScatterCacheReady(tile, container, mode) {
  try {
    if (!tile || !container?.faNexusAssetScatterCached) return;
    globalThis?.Hooks?.callAll?.('fa-nexus-asset-scatter-cache-ready', tile, {
      mode,
      cacheKey: container.faNexusAssetScatterCacheKey || null,
      contentVersion: Number(container.faNexusAssetScatterContentVersion) || 0
    });
  } catch (error) {
    logScatterFailure('cacheReadyHook', error, { tileId: tile?.document?.id || '' });
  }
}

function readScatterFlag(doc) {
  try {
    const direct = doc?.getFlag?.('fa-nexus', SCATTER_FLAG_KEY);
    if (direct !== undefined) return direct;
  } catch (_) {}
  const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
  return flags ? flags[SCATTER_FLAG_KEY] : null;
}

function normalizeInstances(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : null,
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

function resolveScatterPayload(doc) {
  const payload = readScatterFlag(doc);
  if (!payload || typeof payload !== 'object') return null;
  const version = Number(payload.version || SCATTER_VERSION);
  if (version !== SCATTER_VERSION) return null;
  const rawInstances = payload.instances || [];
  const cached = doc && SCATTER_PAYLOAD_CACHE.get(doc);
  if (cached
    && cached.source === payload
    && cached.rawInstances === rawInstances
    && cached.rawLength === rawInstances.length
    && cached.version === version) {
    return cached.value;
  }
  const instances = normalizeInstances(payload.instances || []);
  if (!instances.length) return null;
  const value = {
    version,
    instances,
    instanceKey: buildInstanceRenderKey(instances)
  };
  if (doc) {
    SCATTER_PAYLOAD_CACHE.set(doc, {
      source: payload,
      rawInstances,
      rawLength: rawInstances.length,
      version,
      value
    });
  }
  return value;
}

function buildInstanceRenderKey(instances) {
  try {
    const key = JSON.stringify(Array.isArray(instances) ? instances : []);
    return typeof key === 'string' ? key : '';
  } catch (_) {
    return '';
  }
}

function buildRenderKey(payload, doc = null) {
  const instanceKey = typeof payload?.instanceKey === 'string'
    ? payload.instanceKey
    : buildInstanceRenderKey(Array.isArray(payload) ? payload : payload?.instances);
  const width = Math.max(1, Math.round(Number(doc?.width) || 1));
  const height = Math.max(1, Math.round(Number(doc?.height) || 1));
  const sizeKey = `${width}x${height}`;
  if (payload && typeof payload === 'object' && payload.renderSizeKey === sizeKey && typeof payload.renderKey === 'string') {
    return payload.renderKey;
  }
  const renderKey = `${sizeKey}:${instanceKey}`;
  try {
    if (payload && typeof payload === 'object') {
      payload.renderSizeKey = sizeKey;
      payload.renderKey = renderKey;
    }
  } catch (_) {}
  return renderKey;
}

function buildScatterOverheadKey(doc, container, hsbc) {
  try {
    return JSON.stringify({
      contentVersion: Number(container?.faNexusAssetScatterContentVersion) || 0,
      hsbc: hsbc || null,
      alpha: Number(doc?.alpha ?? 1) || 1,
      shadowOnly: !!doc?.getFlag?.('fa-nexus', 'shadowOnly'),
      standardTileMask: !!doc?.getFlag?.('fa-nexus', 'standardTileMask'),
      restrictsLight: !!doc?.restrictions?.light,
      restrictsWeather: !!doc?.restrictions?.weather,
      occlusionModes: doc?.occlusion?.modes ?? null
    });
  } catch (_) {
    return `${Number(container?.faNexusAssetScatterContentVersion) || 0}`;
  }
}

function bumpScatterContentVersion(container) {
  if (!container) return;
  container.faNexusAssetScatterContentVersion = (Number(container.faNexusAssetScatterContentVersion) || 0) + 1;
}

function syncScatterContainerTransform(container, mesh, doc) {
  if (!container || container.destroyed || !mesh || mesh.destroyed) return;
  const docWidth = Math.max(1, Number(doc?.width) || 0) || Math.max(1, Number(mesh?.width) || 1);
  const docHeight = Math.max(1, Number(doc?.height) || 0) || Math.max(1, Number(mesh?.height) || 1);
  const rawSx = Number(mesh?.scale?.x ?? 1) || 1;
  const rawSy = Number(mesh?.scale?.y ?? 1) || 1;
  const sx = Math.abs(rawSx) > 1.001 ? rawSx : (Math.sign(rawSx || 1) || 1) * docWidth;
  const sy = Math.abs(rawSy) > 1.001 ? rawSy : (Math.sign(rawSy || 1) || 1) * docHeight;
  const anchorX = Number(doc?.texture?.anchorX);
  const anchorY = Number(doc?.texture?.anchorY);
  const ax = Number.isFinite(anchorX) ? anchorX : 0.5;
  const ay = Number.isFinite(anchorY) ? anchorY : 0.5;
  container.scale?.set?.(1 / sx, 1 / sy);
  container.position?.set?.(-(docWidth * ax) / (sx || 1), -(docHeight * ay) / (sy || 1));
}

function getRenderer() {
  return canvas?.app?.renderer || null;
}

function getCanvasScale() {
  const sx = Number(canvas?.stage?.scale?.x);
  const sy = Number(canvas?.stage?.scale?.y);
  const scale = Math.max(
    Number.isFinite(sx) && sx > 0 ? sx : 0,
    Number.isFinite(sy) && sy > 0 ? sy : 0
  );
  return scale || 1;
}

function getMaxScatterCacheTextureSize() {
  try {
    const renderer = getRenderer();
    const gl = renderer?.gl || renderer?.context?.gl;
    if (!gl) return SCATTER_CACHE_TEXTURE_FALLBACK;
    const value = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) || SCATTER_CACHE_TEXTURE_FALLBACK) || SCATTER_CACHE_TEXTURE_FALLBACK;
    return Math.max(1024, Math.min(value, SCATTER_CACHE_TEXTURE_CAP));
  } catch (_) {
    return SCATTER_CACHE_TEXTURE_FALLBACK;
  }
}

function resolveScatterCacheSize(doc) {
  const docWidth = Math.max(SCATTER_CACHE_MIN_SIZE, Math.round(Number(doc?.width) || SCATTER_CACHE_MIN_SIZE));
  const docHeight = Math.max(SCATTER_CACHE_MIN_SIZE, Math.round(Number(doc?.height) || SCATTER_CACHE_MIN_SIZE));
  return {
    docWidth,
    docHeight,
    textureWidth: docWidth,
    textureHeight: docHeight,
    scaleX: 1,
    scaleY: 1,
    key: `${docWidth}x${docHeight}`
  };
}

function computeScatterInstanceBounds(instance) {
  const width = Math.max(1, Number(instance?.w) || 0);
  const height = Math.max(1, Number(instance?.h) || 0);
  const cx = Number(instance?.x) || 0;
  const cy = Number(instance?.y) || 0;
  const halfW = width / 2;
  const halfH = height / 2;
  const rotation = ((Number(instance?.r) || 0) * Math.PI) / 180;
  if (Math.abs(rotation) < 1e-8) {
    return {
      minX: cx - halfW,
      minY: cy - halfH,
      maxX: cx + halfW,
      maxY: cy + halfH
    };
  }
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const corners = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH }
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const x = cx + (corner.x * cos) - (corner.y * sin);
    const y = cy + (corner.x * sin) + (corner.y * cos);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function attachScatterBounds(instances) {
  if (!Array.isArray(instances)) return [];
  return instances.map((instance) => ({
    instance,
    bounds: computeScatterInstanceBounds(instance)
  }));
}

function resolveScatterContentBounds(instances) {
  if (!Array.isArray(instances) || !instances.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const instance of instances) {
    const bounds = computeScatterInstanceBounds(instance);
    if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)
      || !Number.isFinite(bounds.maxX) || !Number.isFinite(bounds.maxY)) continue;
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  return {
    minX: Math.floor(minX),
    minY: Math.floor(minY),
    maxX: Math.ceil(maxX),
    maxY: Math.ceil(maxY)
  };
}

function rectanglesIntersect(a, b) {
  if (!a || !b) return false;
  return a.minX < b.maxX
    && a.maxX > b.minX
    && a.minY < b.maxY
    && a.maxY > b.minY;
}

function resolveScatterCacheChunks(instances, maxSize) {
  const bounds = resolveScatterContentBounds(instances);
  if (!bounds) return [];
  const bleed = Math.max(0, Math.min(SCATTER_CACHE_CHUNK_BLEED, Math.floor((maxSize - SCATTER_CACHE_MIN_SIZE) / 2)));
  const chunkSize = Math.max(SCATTER_CACHE_MIN_SIZE, maxSize - (bleed * 2));
  const totalWidth = Math.max(SCATTER_CACHE_MIN_SIZE, bounds.maxX - bounds.minX);
  const totalHeight = Math.max(SCATTER_CACHE_MIN_SIZE, bounds.maxY - bounds.minY);
  const chunks = [];

  for (let y = bounds.minY; y < bounds.minY + totalHeight; y += chunkSize) {
    const height = Math.min(chunkSize, bounds.minY + totalHeight - y);
    for (let x = bounds.minX; x < bounds.minX + totalWidth; x += chunkSize) {
      const width = Math.min(chunkSize, bounds.minX + totalWidth - x);
      chunks.push({
        x,
        y,
        width,
        height,
        renderX: x - bleed,
        renderY: y - bleed,
        renderWidth: width + (bleed * 2),
        renderHeight: height + (bleed * 2),
        bleed,
        renderBounds: {
          minX: x - bleed,
          minY: y - bleed,
          maxX: x + width + bleed,
          maxY: y + height + bleed
        },
        key: `${x},${y},${width},${height},${bleed}`
      });
    }
  }

  return chunks;
}

function resolveScatterRenderCachePlan(instances, doc) {
  if (!Array.isArray(instances) || instances.length < SCATTER_CACHE_INSTANCE_THRESHOLD) return { mode: 'live' };
  const size = resolveScatterCacheSize(doc);
  const maxSize = getMaxScatterCacheTextureSize();
  if (size.textureWidth <= maxSize && size.textureHeight <= maxSize) {
    return { mode: 'single', size, maxSize };
  }
  const chunks = resolveScatterCacheChunks(instances, maxSize);
  if (!chunks.length) return { mode: 'live', size, maxSize };
  return { mode: 'chunked', size, maxSize, chunks };
}

function getTexture(src) {
  if (!src) return PIXI.Texture.EMPTY;
  if (TEXTURE_CACHE.has(src)) return TEXTURE_CACHE.get(src);
  const texture = getSharedTexture(src);
  TEXTURE_CACHE.set(src, texture);
  return texture;
}

function clearScatterRetry(tile) {
  try {
    const existing = SCATTER_RETRY_TIMERS.get(tile);
    if (!existing) return;
    if (existing.timeout) clearTimeout(existing.timeout);
    SCATTER_RETRY_TIMERS.delete(tile);
  } catch (error) {
    logScatterFailure('retryClear', error, { tileId: tile?.document?.id || '' });
  }
}

function clearScatterRefresh(tile) {
  try {
    const existing = SCATTER_REFRESH_TIMERS.get(tile);
    if (!existing) return;
    if (existing.timeout) clearTimeout(existing.timeout);
    SCATTER_REFRESH_TIMERS.delete(tile);
  } catch (error) {
    logScatterFailure('refreshClear', error, { tileId: tile?.document?.id || '' });
  }
}

function scheduleScatterRetry(tile, attempt = 1) {
  try {
    if (!tile || tile.destroyed) return;
    clearScatterRetry(tile);
    if (attempt > 4) return;
    const timeout = setTimeout(() => {
      SCATTER_RETRY_TIMERS.delete(tile);
      try { applyAssetScatterTile(tile, { retryAttempt: attempt + 1 }); }
      catch (error) { logScatterFailure('retryApply', error, { tileId: tile?.document?.id || '', attempt: attempt + 1 }); }
    }, Math.min(250 * attempt, 1000));
    SCATTER_RETRY_TIMERS.set(tile, { timeout, attempt });
  } catch (error) {
    logScatterFailure('retrySchedule', error, { tileId: tile?.document?.id || '', attempt });
  }
}

function applySpriteSizing(sprite, instance) {
  if (!sprite || !instance) return;
  const width = Math.max(1, Number(instance.w) || 0);
  const height = Math.max(1, Number(instance.h) || 0);
  const baseScaleX = Number.isFinite(sprite.scale?.x) && sprite.scale.x !== 0 ? Math.abs(sprite.scale.x) : 1;
  const baseScaleY = Number.isFinite(sprite.scale?.y) && sprite.scale.y !== 0 ? Math.abs(sprite.scale.y) : 1;
  sprite.scale.set(baseScaleX, baseScaleY);
  sprite.width = width;
  sprite.height = height;
  if (instance.flipH) sprite.scale.x *= -1;
  if (instance.flipV) sprite.scale.y *= -1;
}

function createSprite(instance, texture, { onTextureReady = null } = {}) {
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.position.set(instance.x, instance.y);
  sprite.rotation = ((instance.r || 0) * Math.PI) / 180;
  applySpriteSizing(sprite, instance);
  const base = texture?.baseTexture;
  if (base && !base.valid && typeof texture?.once === 'function') {
    texture.once('update', () => {
      if (sprite.destroyed) return;
      applySpriteSizing(sprite, instance);
      try { onTextureReady?.(); } catch (_) {}
    });
  }
  sprite.eventMode = 'none';
  return sprite;
}

function destroySprites(sprites) {
  if (!Array.isArray(sprites)) return;
  for (const sprite of sprites) {
    try { sprite?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
  }
}

function clearScatterTextureWatchers(container) {
  try {
    const watchers = container?.faNexusAssetScatterTextureWatchers;
    if (!(watchers instanceof Map)) return;
    for (const watcher of watchers.values()) {
      try { watcher.base?.off?.('loaded', watcher.onReady); } catch (_) {}
      try { watcher.base?.off?.('update', watcher.onReady); } catch (_) {}
      try { watcher.texture?.off?.('update', watcher.onReady); } catch (_) {}
    }
    watchers.clear();
  } catch (error) {
    logScatterFailure('textureWatchClear', error);
  }
}

function destroyScatterCache(container) {
  try {
    clearScatterTextureWatchers(container);
    clearScatterViewportLayer(container, { showCache: false });
    const cacheSprites = [];
    if (Array.isArray(container?.faNexusAssetScatterCacheSprites)) {
      cacheSprites.push(...container.faNexusAssetScatterCacheSprites);
    }
    if (container?.faNexusAssetScatterCacheSprite) cacheSprites.push(container.faNexusAssetScatterCacheSprite);
    for (const sprite of new Set(cacheSprites)) {
      if (!sprite || sprite.destroyed) continue;
      try { sprite.parent?.removeChild?.(sprite); } catch (_) {}
      try { sprite.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    }

    const displayTextures = Array.isArray(container?.faNexusAssetScatterDisplayTextures)
      ? container.faNexusAssetScatterDisplayTextures
      : [];
    for (const texture of new Set(displayTextures)) {
      if (!texture || texture.destroyed) continue;
      try { texture.destroy(false); } catch (_) {}
    }

    const renderTextures = [];
    if (Array.isArray(container?.faNexusAssetScatterCacheTextures)) {
      renderTextures.push(...container.faNexusAssetScatterCacheTextures);
    }
    if (container?.faNexusAssetScatterCacheTexture) renderTextures.push(container.faNexusAssetScatterCacheTexture);
    for (const texture of new Set(renderTextures)) {
      if (!texture || texture.destroyed) continue;
      try { texture.destroy(true); } catch (_) {}
    }
    if (container) {
      container.faNexusAssetScatterCacheSprite = null;
      container.faNexusAssetScatterCacheSprites = [];
      container.faNexusAssetScatterCacheTexture = null;
      container.faNexusAssetScatterCacheTextures = [];
      container.faNexusAssetScatterDisplayTextures = [];
      container.faNexusAssetScatterCacheKey = null;
      container.faNexusAssetScatterCacheMode = null;
      container.faNexusAssetScatterCached = false;
      container.faNexusAssetScatterRenderKey = null;
      container.faNexusAssetScatterOverheadKey = null;
    }
  } catch (error) {
    logScatterFailure('cacheDestroy', error);
  }
}

function clearScatterChildren(container) {
  if (!container || container.destroyed) return;
  destroyScatterCache(container);
  const prevChildren = container.children?.slice() || [];
  container.removeChildren();
  destroySprites(prevChildren);
}

function queueCachedScatterRefresh(tile, container, reason = 'texture-ready') {
  try {
    if (!tile || tile.destroyed || !container || container.destroyed) return;
    clearScatterRefresh(tile);
    const timeout = setTimeout(() => {
      SCATTER_REFRESH_TIMERS.delete(tile);
      try {
        if (!tile || tile.destroyed || !container || container.destroyed) return;
        container.faNexusAssetScatterRenderKey = null;
        invalidateCustomTileOverhead(tile, `scatter-${reason}`);
        void applyAssetScatterTile(tile, { retryAttempt: 1, reason });
      } catch (error) {
        logScatterFailure('cacheRefreshApply', error, { tileId: tile?.document?.id || '', reason });
      }
    }, SCATTER_TEXTURE_READY_REFRESH_DELAY);
    SCATTER_REFRESH_TIMERS.set(tile, { timeout, reason });
  } catch (error) {
    logScatterFailure('cacheRefreshQueue', error, { tileId: tile?.document?.id || '', reason });
  }
}

function watchPendingScatterTextures(container, tile, pendingTextures) {
  try {
    clearScatterTextureWatchers(container);
    if (!container || container.destroyed || !Array.isArray(pendingTextures) || !pendingTextures.length) return;
    const watchers = new Map();
    container.faNexusAssetScatterTextureWatchers = watchers;
    for (const entry of pendingTextures) {
      const texture = entry?.texture;
      const base = texture?.baseTexture;
      if (!base || base.destroyed || base.valid) continue;
      const key = String(entry?.key || base.uid || texture.uid || watchers.size);
      if (watchers.has(key)) continue;
      const onReady = () => {
        try { base.off?.('loaded', onReady); } catch (_) {}
        try { base.off?.('update', onReady); } catch (_) {}
        try { texture.off?.('update', onReady); } catch (_) {}
        watchers.delete(key);
        queueCachedScatterRefresh(tile, container, 'texture-ready');
      };
      try { base.on?.('loaded', onReady); } catch (_) {}
      try { base.on?.('update', onReady); } catch (_) {}
      try { texture.on?.('update', onReady); } catch (_) {}
      watchers.set(key, { base, texture, onReady });
    }
    if (!watchers.size) queueCachedScatterRefresh(tile, container, 'texture-ready');
  } catch (error) {
    logScatterFailure('textureWatch', error, { tileId: tile?.document?.id || '' });
  }
}

function ensureScatterCacheTexture(container, size) {
  let texture = container.faNexusAssetScatterCacheTexture;
  if (texture && !texture.destroyed && container.faNexusAssetScatterCacheKey === size.key) return texture;
  if (texture && !texture.destroyed) {
    try { texture.destroy(true); } catch (_) {}
  }
  texture = PIXI.RenderTexture.create({
    width: size.textureWidth,
    height: size.textureHeight,
    resolution: 1,
    scaleMode: PIXI.SCALE_MODES?.LINEAR
  });
  try {
    if (texture?.baseTexture) texture.baseTexture.clearColor = [0, 0, 0, 0];
  } catch (_) {}
  container.faNexusAssetScatterCacheTexture = texture;
  container.faNexusAssetScatterCacheKey = size.key;
  return texture;
}

function createScatterRenderTexture(width, height) {
  const texture = PIXI.RenderTexture.create({
    width: Math.max(SCATTER_CACHE_MIN_SIZE, Math.ceil(Number(width) || SCATTER_CACHE_MIN_SIZE)),
    height: Math.max(SCATTER_CACHE_MIN_SIZE, Math.ceil(Number(height) || SCATTER_CACHE_MIN_SIZE)),
    resolution: 1,
    scaleMode: PIXI.SCALE_MODES?.LINEAR
  });
  try {
    if (texture?.baseTexture) texture.baseTexture.clearColor = [0, 0, 0, 0];
  } catch (_) {}
  return texture;
}

function createScatterCacheSprite(texture, chunk, name) {
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0);
  sprite.position.set(chunk.x, chunk.y);
  sprite.width = chunk.width;
  sprite.height = chunk.height;
  sprite.visible = true;
  sprite.renderable = true;
  sprite.eventMode = 'none';
  sprite.name = name;
  sprite.faNexusAssetScatterCacheSprite = true;
  sprite.faNexusAssetScatterCacheChunk = {
    x: chunk.x,
    y: chunk.y,
    width: chunk.width,
    height: chunk.height
  };
  return sprite;
}

function getScatterCacheSprites(container) {
  if (!container || container.destroyed) return [];
  if (Array.isArray(container.faNexusAssetScatterCacheSprites)) {
    return container.faNexusAssetScatterCacheSprites.filter((sprite) => sprite && !sprite.destroyed);
  }
  const sprite = container.faNexusAssetScatterCacheSprite;
  return sprite && !sprite.destroyed ? [sprite] : [];
}

function setScatterCacheVisualEnabled(container, enabled) {
  for (const sprite of getScatterCacheSprites(container)) {
    try { sprite.visible = !!enabled; } catch (_) {}
    try { sprite.renderable = !!enabled; } catch (_) {}
  }
  if (container) container.faNexusAssetScatterCacheVisualEnabled = !!enabled;
}

function ensureScatterViewportLayer(container) {
  if (!container || container.destroyed) return null;
  let layer = container.faNexusAssetScatterViewportLayer;
  if (layer && !layer.destroyed) {
    if (layer.parent !== container) {
      try { layer.parent?.removeChild?.(layer); } catch (_) {}
      try { container.addChild(layer); } catch (_) {}
    }
    return layer;
  }
  layer = new PIXI.Container();
  layer.name = 'fa-nexus-asset-scatter-live-viewport';
  layer.eventMode = 'none';
  layer.sortableChildren = false;
  layer.interactiveChildren = false;
  layer.visible = false;
  layer.renderable = false;
  layer.faNexusAssetScatterViewportLayer = true;
  container.faNexusAssetScatterViewportLayer = layer;
  try { container.addChild(layer); } catch (_) {}
  return layer;
}

function clearScatterViewportLayer(container, { showCache = true } = {}) {
  try {
    const layer = container?.faNexusAssetScatterViewportLayer;
    if (layer && !layer.destroyed) {
      const children = layer.children?.slice() || [];
      try { layer.removeChildren(); } catch (_) {}
      destroyScatterLayerChildren(children);
      layer.visible = false;
      layer.renderable = false;
    }
    if (container) {
      container.faNexusAssetScatterViewportKey = null;
      container.faNexusAssetScatterViewportLiveCount = 0;
      if (showCache) setScatterCacheVisualEnabled(container, true);
    }
  } catch (error) {
    logScatterFailure('viewportClear', error);
  }
}

function suspendScatterViewportLayer(container) {
  try {
    const layer = container?.faNexusAssetScatterViewportLayer;
    if (layer && !layer.destroyed) {
      layer.visible = false;
      layer.renderable = false;
    }
    if (container) setScatterCacheVisualEnabled(container, true);
  } catch (error) {
    logScatterFailure('viewportSuspend', error);
  }
}

function resolveScatterViewportBounds(container) {
  try {
    if (!container || container.destroyed) return null;
    const renderer = getRenderer();
    const screen = renderer?.screen || null;
    const width = Math.max(1, Number(screen?.width) || Number(renderer?.view?.clientWidth) || 1);
    const height = Math.max(1, Number(screen?.height) || Number(renderer?.view?.clientHeight) || 1);
    const transform = container.worldTransform;
    if (!transform?.applyInverse) return null;
    const points = [
      transform.applyInverse({ x: 0, y: 0 }),
      transform.applyInverse({ x: width, y: 0 }),
      transform.applyInverse({ x: width, y: height }),
      transform.applyInverse({ x: 0, y: height })
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, Number(point?.x));
      minY = Math.min(minY, Number(point?.y));
      maxX = Math.max(maxX, Number(point?.x));
      maxY = Math.max(maxY, Number(point?.y));
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
    const padding = SCATTER_VIEWPORT_PADDING_SCREEN_PX / Math.max(0.01, getCanvasScale());
    return {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding
    };
  } catch (error) {
    logScatterFailure('viewportBounds', error);
    return null;
  }
}

function buildScatterViewportKey(bounds, scale, contentKey) {
  const unit = SCATTER_VIEWPORT_KEY_GRANULARITY;
  const bucket = (value) => Math.round((Number(value) || 0) / unit);
  return [
    Math.round((Number(scale) || 1) * 100),
    bucket(bounds?.minX),
    bucket(bounds?.minY),
    bucket(bounds?.maxX),
    bucket(bounds?.maxY),
    contentKey || ''
  ].join(':');
}

function isScatterViewportTileVisible(tile, container) {
  try {
    const doc = tile?.document;
    if (doc?.hidden === true || doc?._source?.hidden === true) return false;
    const mesh = tile?.mesh;
    if (tile?.visible === false || tile?.renderable === false) return false;
    if (mesh?.visible === false || mesh?.renderable === false) return false;
    if (container?.visible === false || container?.renderable === false) return false;
  } catch (_) {
    return false;
  }
  return true;
}

function syncScatterViewportLayer(tile, container, { force = false, reason = null } = {}) {
  try {
    if (!tile || tile.destroyed || !container || container.destroyed) return;
    if (!container.faNexusAssetScatterCached || container.faNexusAssetScatterCacheMode === 'live') {
      clearScatterViewportLayer(container, { showCache: true });
      return;
    }
    if (!isScatterViewportTileVisible(tile, container)) {
      clearScatterViewportLayer(container, { showCache: true });
      return;
    }

    const scale = getCanvasScale();
    if (scale < SCATTER_VIEWPORT_LIVE_MIN_SCALE) {
      clearScatterViewportLayer(container, { showCache: true });
      return;
    }

    const instancesWithBounds = Array.isArray(container.faNexusAssetScatterInstancesWithBounds)
      ? container.faNexusAssetScatterInstancesWithBounds
      : [];
    if (!instancesWithBounds.length) {
      clearScatterViewportLayer(container, { showCache: true });
      return;
    }

    const viewportBounds = resolveScatterViewportBounds(container);
    if (!viewportBounds) {
      clearScatterViewportLayer(container, { showCache: true });
      return;
    }

    const viewportKey = buildScatterViewportKey(
      viewportBounds,
      scale,
      Number(container.faNexusAssetScatterContentVersion) || 0
    );
    const layer = ensureScatterViewportLayer(container);
    if (!layer) return;
    if (!force && layer.visible && container.faNexusAssetScatterViewportKey === viewportKey) return;

    const visibleEntries = [];
    for (const entry of instancesWithBounds) {
      if (!rectanglesIntersect(entry?.bounds, viewportBounds)) continue;
      visibleEntries.push(entry);
      if (visibleEntries.length > SCATTER_VIEWPORT_MAX_LIVE_SPRITES) break;
    }

    if (visibleEntries.length > SCATTER_VIEWPORT_MAX_LIVE_SPRITES) {
      clearScatterViewportLayer(container, { showCache: true });
      const warnKey = `${viewportKey}:${visibleEntries.length}`;
      if (container.faNexusAssetScatterViewportWarnKey !== warnKey) {
        container.faNexusAssetScatterViewportWarnKey = warnKey;
        Logger.warn?.('AssetScatter.viewportLive.skipped', {
          tileId: tile?.document?.id || null,
          reason: 'visible-instance-cap',
          visibleInstances: visibleEntries.length,
          maxInstances: SCATTER_VIEWPORT_MAX_LIVE_SPRITES,
          scale,
          trigger: reason
        });
      }
      return;
    }

    const previous = layer.children?.slice() || [];
    try { layer.removeChildren(); } catch (_) {}
    destroySprites(previous);

    for (const entry of visibleEntries) {
      const texture = getTexture(entry.instance?.src);
      if (!texture) continue;
      const sprite = createSprite(entry.instance, texture);
      sprite.faNexusAssetScatterViewportSprite = true;
      layer.addChild(sprite);
    }

    layer.visible = true;
    layer.renderable = true;
    container.faNexusAssetScatterViewportKey = viewportKey;
    container.faNexusAssetScatterViewportLiveCount = visibleEntries.length;
    setScatterCacheVisualEnabled(container, false);
  } catch (error) {
    logScatterFailure('viewportSync', error, { tileId: tile?.document?.id || '', reason });
    clearScatterViewportLayer(container, { showCache: true });
  }
}

function normalizeScatterCaptureBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const minX = Number(bounds.minX ?? bounds.x);
  const minY = Number(bounds.minY ?? bounds.y);
  const rawMaxX = Number(bounds.maxX);
  const rawMaxY = Number(bounds.maxY);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  const maxX = Number.isFinite(rawMaxX) ? rawMaxX : minX + width;
  const maxY = Number.isFinite(rawMaxY) ? rawMaxY : minY + height;
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

function textureIsReady(texture) {
  if (!texture || texture.destroyed) return false;
  const base = texture.baseTexture;
  if (!base || base.destroyed) return false;
  return base.valid !== false && texture.valid !== false;
}

function destroyScatterLayerChildren(children) {
  if (!Array.isArray(children)) return;
  for (const sprite of children) {
    const ownsTexture = sprite?.faNexusAssetScatterOwnsTexture === true;
    try {
      sprite?.destroy?.({
        children: true,
        texture: ownsTexture,
        baseTexture: ownsTexture
      });
    } catch (_) {}
  }
}

function resolveTextureCanvasSource(texture) {
  const source = texture?.baseTexture?.resource?.source
    || texture?.baseTexture?.resource?.bitmap
    || texture?.source
    || null;
  if (!source) return null;
  const width = Number(source.naturalWidth || source.videoWidth || source.width) || 0;
  const height = Number(source.naturalHeight || source.videoHeight || source.height) || 0;
  if (width <= 0 || height <= 0) return null;
  if ('complete' in source && source.complete === false) return null;
  return { source, width, height };
}

function resolveTextureFrame(texture, sourceInfo) {
  const frame = texture?.frame || null;
  const x = Number(frame?.x);
  const y = Number(frame?.y);
  const width = Number(frame?.width);
  const height = Number(frame?.height);
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { x, y, width, height };
  }
  return {
    x: 0,
    y: 0,
    width: sourceInfo.width,
    height: sourceInfo.height
  };
}

function createScatterCanvasCaptureSprite(visibleEntries, bounds, resolution) {
  const scale = Math.max(0.01, Number(resolution) || 1);
  const width = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) * scale));
  const height = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) * scale));
  const canvasEl = document.createElement('canvas');
  canvasEl.width = width;
  canvasEl.height = height;
  const ctx = canvasEl.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Scatter capture could not create a 2D canvas context');

  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  try { ctx.imageSmoothingQuality = 'high'; } catch (_) {}

  const pendingTextures = [];
  const missingSources = [];
  for (const entry of visibleEntries) {
    const instance = entry?.instance;
    if (!instance) continue;
    const texture = getTexture(instance.src);
    if (!textureIsReady(texture)) {
      pendingTextures.push(instance.src || '(unknown)');
      continue;
    }
    const sourceInfo = resolveTextureCanvasSource(texture);
    if (!sourceInfo) {
      missingSources.push(instance.src || '(unknown)');
      continue;
    }
    const frame = resolveTextureFrame(texture, sourceInfo);
    const drawWidth = Math.max(1, Number(instance.w) || 0) * scale;
    const drawHeight = Math.max(1, Number(instance.h) || 0) * scale;
    const drawX = ((Number(instance.x) || 0) - bounds.minX) * scale;
    const drawY = ((Number(instance.y) || 0) - bounds.minY) * scale;
    ctx.save();
    try {
      ctx.translate(drawX, drawY);
      ctx.rotate(((Number(instance.r) || 0) * Math.PI) / 180);
      ctx.scale(instance.flipH ? -1 : 1, instance.flipV ? -1 : 1);
      ctx.drawImage(
        sourceInfo.source,
        frame.x,
        frame.y,
        frame.width,
        frame.height,
        -drawWidth / 2,
        -drawHeight / 2,
        drawWidth,
        drawHeight
      );
    } finally {
      ctx.restore();
    }
  }

  if (pendingTextures.length) {
    canvasEl.width = 0;
    canvasEl.height = 0;
    throw new Error(`Scatter capture textures are not ready: ${[...new Set(pendingTextures)].slice(0, 5).join(', ')}`);
  }
  if (missingSources.length) {
    canvasEl.width = 0;
    canvasEl.height = 0;
    throw new Error(`Scatter capture texture sources are unavailable for canvas composition: ${[...new Set(missingSources)].slice(0, 5).join(', ')}`);
  }

  const texture = PIXI.Texture.from(canvasEl);
  try {
    if (texture?.baseTexture) {
      texture.baseTexture.scaleMode = PIXI?.SCALE_MODES?.LINEAR ?? texture.baseTexture.scaleMode;
      texture.baseTexture.mipmap = PIXI?.MIPMAP_MODES?.OFF ?? 0;
      texture.baseTexture.clearColor = [0, 0, 0, 0];
      texture.baseTexture.update?.();
    }
  } catch (_) {}

  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0);
  sprite.position.set(bounds.minX, bounds.minY);
  sprite.width = bounds.maxX - bounds.minX;
  sprite.height = bounds.maxY - bounds.minY;
  sprite.eventMode = 'none';
  sprite.visible = true;
  sprite.renderable = true;
  sprite.name = 'fa-nexus-asset-scatter-capture-canvas';
  sprite.faNexusAssetScatterViewportSprite = true;
  sprite.faNexusAssetScatterOwnsTexture = true;
  return sprite;
}

export function syncAssetScatterCaptureLayer(tile, localBounds, { reason = 'capture', resolution = 1 } = {}) {
  try {
    const mesh = tile?.mesh;
    const container = tile?.faNexusAssetScatterContainer || mesh?.faNexusAssetScatterContainer;
    if (!tile || tile.destroyed || !container || container.destroyed) {
      throw new Error('Scatter capture layer requires an active tile container');
    }

    if (!container.faNexusAssetScatterCached || container.faNexusAssetScatterCacheMode === 'live') {
      clearScatterViewportLayer(container, { showCache: true });
      return {
        mode: 'live',
        visibleInstances: Array.isArray(container.children) ? container.children.length : 0
      };
    }

    const bounds = normalizeScatterCaptureBounds(localBounds);
    if (!bounds) throw new Error('Scatter capture bounds are invalid');

    const instancesWithBounds = Array.isArray(container.faNexusAssetScatterInstancesWithBounds)
      ? container.faNexusAssetScatterInstancesWithBounds
      : [];
    if (!instancesWithBounds.length) {
      clearScatterViewportLayer(container, { showCache: false });
      setScatterCacheVisualEnabled(container, false);
      return { mode: 'capture', visibleInstances: 0 };
    }

    const visibleEntries = [];
    for (const entry of instancesWithBounds) {
      if (!rectanglesIntersect(entry?.bounds, bounds)) continue;
      visibleEntries.push(entry);
      if (visibleEntries.length > SCATTER_CAPTURE_MAX_LIVE_SPRITES) {
        throw new Error(`Scatter capture would require ${visibleEntries.length} live sprites; maximum is ${SCATTER_CAPTURE_MAX_LIVE_SPRITES}`);
      }
    }

    const layer = ensureScatterViewportLayer(container);
    if (!layer) throw new Error('Scatter capture layer could not be created');

    const previous = layer.children?.slice() || [];
    try { layer.removeChildren(); } catch (_) {}
    destroyScatterLayerChildren(previous);

    const captureResolution = Number(resolution);
    if (Number.isFinite(captureResolution) && captureResolution > 0) {
      const captureSprite = createScatterCanvasCaptureSprite(visibleEntries, bounds, captureResolution);
      layer.addChild(captureSprite);
    } else {
      const pendingTextures = [];
      for (const entry of visibleEntries) {
        const texture = getTexture(entry.instance?.src);
        if (!textureIsReady(texture)) {
          pendingTextures.push(entry.instance?.src || '(unknown)');
          continue;
        }
        const sprite = createSprite(entry.instance, texture);
        sprite.faNexusAssetScatterViewportSprite = true;
        layer.addChild(sprite);
      }
      if (pendingTextures.length) {
        clearScatterViewportLayer(container, { showCache: true });
        throw new Error(`Scatter capture textures are not ready: ${[...new Set(pendingTextures)].slice(0, 5).join(', ')}`);
      }
    }

    layer.visible = true;
    layer.renderable = true;
    container.faNexusAssetScatterViewportKey = `capture:${reason}:${bounds.minX}:${bounds.minY}:${bounds.maxX}:${bounds.maxY}:${Number(container.faNexusAssetScatterContentVersion) || 0}`;
    container.faNexusAssetScatterViewportLiveCount = visibleEntries.length;
    setScatterCacheVisualEnabled(container, false);
    return {
      mode: 'capture',
      visibleInstances: visibleEntries.length,
      bounds
    };
  } catch (error) {
    logScatterFailure('captureSync', error, { tileId: tile?.document?.id || '', reason });
    throw error;
  }
}

export function restoreAssetScatterCaptureLayer(tile) {
  try {
    const mesh = tile?.mesh;
    const container = tile?.faNexusAssetScatterContainer || mesh?.faNexusAssetScatterContainer;
    if (!container || container.destroyed) return;
    clearScatterViewportLayer(container, { showCache: true });
  } catch (error) {
    logScatterFailure('captureRestore', error, { tileId: tile?.document?.id || '' });
  }
}

function removeScatterViewportLayersFromProxy(root) {
  if (!root || root.destroyed) return;
  const children = Array.isArray(root.children) ? root.children.slice() : [];
  for (const child of children) {
    if (!child || child.destroyed) continue;
    if (child.faNexusAssetScatterViewportLayer === true || child.faNexusAssetScatterViewportSprite === true) {
      try { child.parent?.removeChild?.(child); } catch (_) {}
      try { child.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      continue;
    }
    if (child.faNexusAssetScatterCacheSprite === true) {
      try { child.visible = true; } catch (_) {}
      try { child.renderable = true; } catch (_) {}
    }
    removeScatterViewportLayersFromProxy(child);
  }
}

function createScatterProxyFactory(container) {
  return () => {
    const clone = cloneDisplayObjectForProxy(container);
    removeScatterViewportLayersFromProxy(clone);
    return clone;
  };
}

function renderScatterSpritesToSingleCache(tile, container, sprites, plan) {
  const renderer = getRenderer();
  if (!renderer) throw new Error('PIXI renderer is unavailable');
  if (!PIXI?.RenderTexture) throw new Error('PIXI.RenderTexture is unavailable');

  const size = plan?.size || resolveScatterCacheSize(tile?.document);
  const renderTexture = ensureScatterCacheTexture(container, size);
  const stage = new PIXI.Container();
  stage.eventMode = 'none';
  stage.sortableChildren = false;
  stage.interactiveChildren = false;
  stage.scale.set(size.scaleX, size.scaleY);

  try {
    for (const sprite of sprites) stage.addChild(sprite);
    renderer.render(stage, {
      renderTexture,
      clear: true,
      skipUpdateTransform: false
    });
  } finally {
    try { stage.removeChildren(); } catch (_) {}
    try { stage.destroy({ children: false }); } catch (_) {}
  }

  const cacheSprite = createScatterCacheSprite(renderTexture, {
    x: 0,
    y: 0,
    width: size.docWidth,
    height: size.docHeight
  }, 'fa-nexus-asset-scatter-cache');
  container.faNexusAssetScatterCacheSprite = cacheSprite;
  container.faNexusAssetScatterCacheSprites = [cacheSprite];
  container.faNexusAssetScatterCacheTextures = [renderTexture];
  container.faNexusAssetScatterCacheMode = 'single';
  container.faNexusAssetScatterCached = true;
  return [cacheSprite];
}

function createScatterChunkDisplayTexture(renderTexture, chunk) {
  if (!chunk?.bleed || !PIXI?.Texture || !PIXI?.Rectangle || !renderTexture?.baseTexture) return renderTexture;
  return new PIXI.Texture(
    renderTexture.baseTexture,
    new PIXI.Rectangle(chunk.bleed, chunk.bleed, chunk.width, chunk.height)
  );
}

function renderScatterSpritesToChunkCache(tile, container, sprites, plan) {
  const renderer = getRenderer();
  if (!renderer) throw new Error('PIXI renderer is unavailable');
  if (!PIXI?.RenderTexture) throw new Error('PIXI.RenderTexture is unavailable');
  if (!Array.isArray(plan?.chunks) || !plan.chunks.length) throw new Error('Scatter chunk plan is empty');

  const stage = new PIXI.Container();
  stage.eventMode = 'none';
  stage.sortableChildren = false;
  stage.interactiveChildren = false;

  const cacheSprites = [];
  const renderTextures = [];
  const displayTextures = [];
  let completed = false;
  try {
    for (const chunk of plan.chunks) {
      stage.position.set(-chunk.renderX, -chunk.renderY);
      let childCount = 0;
      for (const sprite of sprites) {
        if (!sprite || sprite.destroyed) continue;
        const bounds = sprite.faNexusAssetScatterInstanceBounds;
        if (!rectanglesIntersect(bounds, chunk.renderBounds)) continue;
        stage.addChild(sprite);
        childCount += 1;
      }
      if (!childCount) {
        continue;
      }
      const renderTexture = createScatterRenderTexture(chunk.renderWidth, chunk.renderHeight);
      renderTextures.push(renderTexture);
      renderer.render(stage, {
        renderTexture,
        clear: true,
        skipUpdateTransform: false
      });
      try { stage.removeChildren(); } catch (_) {}

      const displayTexture = createScatterChunkDisplayTexture(renderTexture, chunk);
      const cacheSprite = createScatterCacheSprite(displayTexture, chunk, 'fa-nexus-asset-scatter-cache-chunk');
      cacheSprites.push(cacheSprite);
      if (displayTexture !== renderTexture) displayTextures.push(displayTexture);
    }
    completed = true;
  } finally {
    try { stage.removeChildren(); } catch (_) {}
    try { stage.destroy({ children: false }); } catch (_) {}
    if (!completed) {
      destroySprites(cacheSprites);
      for (const texture of displayTextures) {
        try { texture?.destroy?.(false); } catch (_) {}
      }
      for (const texture of renderTextures) {
        try { texture?.destroy?.(true); } catch (_) {}
      }
    }
  }

  if (!cacheSprites.length) {
    for (const texture of displayTextures) {
      try { texture?.destroy?.(false); } catch (_) {}
    }
    for (const texture of renderTextures) {
      try { texture?.destroy?.(true); } catch (_) {}
    }
    throw new Error('Scatter chunk cache produced no sprites');
  }

  container.faNexusAssetScatterCacheSprite = cacheSprites.length === 1 ? cacheSprites[0] : null;
  container.faNexusAssetScatterCacheSprites = cacheSprites;
  container.faNexusAssetScatterCacheTextures = renderTextures;
  container.faNexusAssetScatterDisplayTextures = displayTextures;
  container.faNexusAssetScatterCacheKey = plan.chunks.map((chunk) => chunk.key).join('|');
  container.faNexusAssetScatterCacheMode = 'chunked';
  container.faNexusAssetScatterCached = true;

  Logger.debug?.('AssetScatter.cache.chunked', {
    tileId: tile?.document?.id || null,
    instances: sprites.length,
    chunks: cacheSprites.length,
    maxSize: plan.maxSize,
    width: Number(tile?.document?.width) || null,
    height: Number(tile?.document?.height) || null
  });

  return cacheSprites;
}

function renderScatterSpritesToCache(tile, container, sprites, plan) {
  if (plan?.mode === 'chunked') return renderScatterSpritesToChunkCache(tile, container, sprites, plan);
  return renderScatterSpritesToSingleCache(tile, container, sprites, plan);
}

function createScatterSprites(instances, {
  onTextureReady = null,
  collectPending = true
} = {}) {
  const sprites = [];
  const pendingTextures = [];
  for (const instance of instances) {
    const texture = getTexture(instance.src);
    if (!texture) continue;
    if (collectPending && texture?.baseTexture && !texture.baseTexture.valid) {
      pendingTextures.push({ key: instance.src, texture });
    }
    const sprite = createSprite(instance, texture, { onTextureReady });
    sprite.faNexusAssetScatterInstanceBounds = computeScatterInstanceBounds(instance);
    sprites.push(sprite);
  }
  return {
    sprites,
    pendingTextures,
    hasPendingTexture: pendingTextures.length > 0
  };
}

function populateScatterContainer(tile, container, instances) {
  const cachePlan = resolveScatterRenderCachePlan(instances, tile?.document);
  const useCache = cachePlan.mode !== 'live';
  container.faNexusAssetScatterInstancesWithBounds = attachScatterBounds(instances);
  container.faNexusAssetScatterInstances = instances;
  if (!useCache && instances.length >= SCATTER_CACHE_INSTANCE_THRESHOLD) {
    Logger.warn?.('AssetScatter.cache.skipped', {
      tileId: tile?.document?.id || null,
      instances: instances.length,
      width: Number(tile?.document?.width) || null,
      height: Number(tile?.document?.height) || null,
      maxSize: cachePlan.maxSize || getMaxScatterCacheTextureSize(),
      reason: 'no-cache-plan'
    });
  }
  const { sprites, pendingTextures, hasPendingTexture } = createScatterSprites(instances, {
    onTextureReady: useCache
      ? null
      : () => invalidateCustomTileOverhead(tile, 'scatter-texture-ready')
  });

  if (!useCache) {
    destroyScatterCache(container);
    for (const sprite of sprites) container.addChild(sprite);
    container.faNexusAssetScatterCached = false;
    bumpScatterContentVersion(container);
    return { hasPendingTexture };
  }

  try {
    const cacheSprites = renderScatterSpritesToCache(tile, container, sprites, cachePlan);
    destroySprites(sprites);
    for (const cacheSprite of cacheSprites) container.addChild(cacheSprite);
    watchPendingScatterTextures(container, tile, pendingTextures);
    bumpScatterContentVersion(container);
    notifyScatterCacheReady(tile, container, cachePlan.mode);
    return { hasPendingTexture };
  } catch (error) {
    Logger.error?.('AssetScatter.cache.failed', {
      tileId: tile?.document?.id || null,
      instances: instances.length,
      mode: cachePlan.mode,
      error: String(error?.message || error)
    });
    destroyScatterCache(container);
    clearScatterTextureWatchers(container);
    for (const sprite of sprites) container.addChild(sprite);
    container.faNexusAssetScatterCached = false;
    bumpScatterContentVersion(container);
    return { hasPendingTexture };
  }
}

export function cleanupAssetScatterOverlay(tile) {
  try {
    if (!tile) return;
    clearScatterRetry(tile);
    clearScatterRefresh(tile);
    const mesh = tile.mesh;
    const container = tile.faNexusAssetScatterContainer || mesh?.faNexusAssetScatterContainer;
    detachCustomTileOverhead(tile, { kind: 'scatter' });
    if (container) {
      destroyScatterCache(container);
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) {
      mesh.faNexusAssetScatterContainer = null;
      restoreMeshTexture(mesh, 'faNexusAssetScatterOriginalTexture');
    }
    tile.faNexusAssetScatterContainer = null;
  } catch (error) {
    logScatterFailure('cleanup', error, { tileId: tile?.document?.id || '' });
  }
}

export async function applyAssetScatterTile(tile, options = {}) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    const payload = resolveScatterPayload(doc);
    if (!payload) {
      cleanupAssetScatterOverlay(tile);
      return;
    }

    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;

    ensureMeshTransparent(mesh, 'faNexusAssetScatterOriginalTexture');

    const renderKey = buildRenderKey(payload, doc);

    let container = tile.faNexusAssetScatterContainer;
    const reuse = !!(container && !container.destroyed && container.faNexusAssetScatterRenderKey === renderKey);
    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      tile.faNexusAssetScatterContainer = container;
      mesh.addChild(container);
    } else if (!container.parent) {
      mesh.addChild(container);
      tile.faNexusAssetScatterContainer = container;
    }
    try { container.alpha = 1; } catch (_) {}

    let hasPendingTexture = false;
    if (!reuse) {
      clearScatterChildren(container);
      const result = populateScatterContainer(tile, container, payload.instances);
      hasPendingTexture = !!result?.hasPendingTexture;
      container.faNexusAssetScatterRenderKey = renderKey;
    }
    mesh.faNexusAssetScatterContainer = container;
    const hsbc = readDocumentHsbc(doc, { nullIfMissing: true, nullIfNeutral: true });
    applyHsbcToDisplayObject(container, hsbc, { slot: 'asset-scatter' });
    syncShadowOnlyCustomContainer(tile, container);

    syncScatterContainerTransform(container, mesh, doc);
    syncScatterViewportLayer(tile, container, { force: !reuse, reason: reuse ? 'reuse' : 'apply' });
    const overheadState = attachCustomTileOverhead(tile, {
      kind: 'scatter',
      contentContainer: container,
      proxyFactory: createScatterProxyFactory(container),
      filterMode: 'container',
      syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
        syncScatterContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    try {
      syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), 'scatter-refresh');
    } catch (error) {
      Logger.warn('AssetScatter.standardMaskSuppression.failed', {
        tileId: tile?.document?.id,
        error: String(error?.message || error)
      });
    }
    const overheadKey = buildScatterOverheadKey(doc, container, hsbc);
    const shouldRefreshOverhead = container.faNexusAssetScatterOverheadKey !== overheadKey
      || !overheadState?.proxyTexture
      || overheadState.proxyTexture.destroyed;
    container.faNexusAssetScatterOverheadKey = overheadKey;
    if (shouldRefreshOverhead) invalidateCustomTileOverhead(tile, 'scatter-refresh');
    if (hasPendingTexture && !container.faNexusAssetScatterCached) {
      scheduleScatterRetry(tile, Number(options?.retryAttempt) || 1);
    } else {
      clearScatterRetry(tile);
    }
  } catch (error) {
    Logger.warn('AssetScatter.apply.failed', { error: String(error?.message || error), tileId: tile?.document?.id });
  }
}

export function rehydrateAllAssetScatterTiles() {
  try {
    const tiles = canvas?.tiles?.placeables || [];
    for (const tile of tiles) {
      try { applyAssetScatterTile(tile); }
      catch (error) { logScatterFailure('rehydrateTile', error, { tileId: tile?.document?.id || '' }); }
    }
  } catch (error) {
    logScatterFailure('rehydrateAll', error);
  }
}

export function refreshAllAssetScatterViewportLayers(reason = 'refresh', { force = false } = {}) {
  try {
    const tiles = canvas?.tiles?.placeables || [];
    for (const tile of tiles) {
      try {
        const mesh = tile?.mesh;
        const container = tile?.faNexusAssetScatterContainer || mesh?.faNexusAssetScatterContainer;
        if (!container) continue;
        syncScatterViewportLayer(tile, container, { force, reason });
      } catch (error) {
        logScatterFailure('viewportRefreshTile', error, { tileId: tile?.document?.id || '', reason });
      }
    }
  } catch (error) {
    logScatterFailure('viewportRefreshAll', error, { reason });
  }
}

export function queueRefreshAllAssetScatterViewportLayers(reason = 'refresh') {
  try {
    if (scatterViewportRefreshTimer) clearTimeout(scatterViewportRefreshTimer);
    try {
      const tiles = canvas?.tiles?.placeables || [];
      for (const tile of tiles) {
        const mesh = tile?.mesh;
        const container = tile?.faNexusAssetScatterContainer || mesh?.faNexusAssetScatterContainer;
        if (container?.faNexusAssetScatterCached) suspendScatterViewportLayer(container);
      }
    } catch (error) {
      logScatterFailure('viewportRefreshPrepare', error, { reason });
    }
    scatterViewportRefreshTimer = setTimeout(() => {
      scatterViewportRefreshTimer = null;
      refreshAllAssetScatterViewportLayers(reason);
    }, SCATTER_VIEWPORT_REFRESH_DELAY);
  } catch (error) {
    logScatterFailure('viewportRefreshQueue', error, { reason });
  }
}

export function clearAssetScatterCache() {
  try {
    const tiles = canvas?.tiles?.placeables || [];
    for (const tile of tiles) {
      const mesh = tile?.mesh;
      const container = tile?.faNexusAssetScatterContainer || mesh?.faNexusAssetScatterContainer;
      if (container) destroyScatterCache(container);
    }
  } catch (error) {
    logScatterFailure('renderCacheClear', error);
  }
  try { TEXTURE_CACHE.clear(); }
  catch (error) { logScatterFailure('textureCacheClear', error); }
  try {
    for (const tile of Array.from(SCATTER_RETRY_TIMERS.keys())) clearScatterRetry(tile);
  } catch (error) {
    logScatterFailure('retryCacheClear', error);
  }
  try {
    for (const tile of Array.from(SCATTER_REFRESH_TIMERS.keys())) clearScatterRefresh(tile);
  } catch (error) {
    logScatterFailure('refreshCacheClear', error);
  }
  try {
    if (scatterViewportRefreshTimer) clearTimeout(scatterViewportRefreshTimer);
    scatterViewportRefreshTimer = null;
  } catch (error) {
    logScatterFailure('viewportTimerClear', error);
  }
}
