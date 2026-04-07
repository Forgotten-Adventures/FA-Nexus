import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  applyHsbcToDisplayObject,
  readDocumentHsbc
} from '../core/hsbc.js';
import {
  ensureTileMesh,
  getTransparentTexture
} from '../paths/path-geometry.js';
import {
  attachCustomTileOverhead,
  createDisplayProxyFactory,
  detachCustomTileOverhead,
  invalidateCustomTileOverhead
} from '../canvas/custom-tile-overhead.js';
import { getSharedTexture } from '../textures/texture-render.js';

const SCATTER_FLAG_KEY = 'assetScatter';
const SCATTER_VERSION = 1;
const TEXTURE_CACHE = new Map();
const SCATTER_RETRY_TIMERS = new Map();

function ensureScatterMeshTransparent(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (!mesh.faNexusAssetScatterOriginalTexture) {
      mesh.faNexusAssetScatterOriginalTexture = mesh.texture;
    }
    const placeholder = getTransparentTexture();
    if (mesh.texture !== placeholder) mesh.texture = placeholder;
    mesh.alpha = 1;
    mesh.renderable = true;
  } catch (_) {}
}

function restoreScatterMeshTexture(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (mesh.faNexusAssetScatterOriginalTexture) {
      mesh.texture = mesh.faNexusAssetScatterOriginalTexture;
      mesh.faNexusAssetScatterOriginalTexture = null;
    }
  } catch (_) {}
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
  const instances = normalizeInstances(payload.instances || []);
  if (!instances.length) return null;
  return { version, instances };
}

function buildRenderKey(instances) {
  try {
    return JSON.stringify(instances);
  } catch (_) {
    return '';
  }
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
  } catch (_) {}
}

function scheduleScatterRetry(tile, attempt = 1) {
  try {
    if (!tile || tile.destroyed) return;
    clearScatterRetry(tile);
    if (attempt > 4) return;
    const timeout = setTimeout(() => {
      SCATTER_RETRY_TIMERS.delete(tile);
      try { applyAssetScatterTile(tile, { retryAttempt: attempt + 1 }); } catch (_) {}
    }, Math.min(250 * attempt, 1000));
    SCATTER_RETRY_TIMERS.set(tile, { timeout, attempt });
  } catch (_) {}
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

export function cleanupAssetScatterOverlay(tile) {
  try {
    if (!tile) return;
    clearScatterRetry(tile);
    const mesh = tile.mesh;
    const container = tile.faNexusAssetScatterContainer || mesh?.faNexusAssetScatterContainer;
    detachCustomTileOverhead(tile, { kind: 'scatter' });
    if (container) {
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) {
      mesh.faNexusAssetScatterContainer = null;
      restoreScatterMeshTexture(mesh);
    }
    tile.faNexusAssetScatterContainer = null;
  } catch (_) {}
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

    ensureScatterMeshTransparent(mesh);

    const renderKey = buildRenderKey(payload.instances);

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
      const prevChildren = container.children?.slice() || [];
      container.removeChildren();
      for (const child of prevChildren) {
        try { child.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }

      for (const instance of payload.instances) {
        const texture = getTexture(instance.src);
        if (!texture) continue;
        if (texture?.baseTexture && !texture.baseTexture.valid) hasPendingTexture = true;
        const sprite = createSprite(instance, texture, {
          onTextureReady: () => invalidateCustomTileOverhead(tile, 'scatter-texture-ready')
        });
        container.addChild(sprite);
      }

      container.faNexusAssetScatterRenderKey = renderKey;
    }
    mesh.faNexusAssetScatterContainer = container;
    applyHsbcToDisplayObject(
      container,
      readDocumentHsbc(doc, { nullIfMissing: true, nullIfNeutral: true }),
      { slot: 'asset-scatter' }
    );

    syncScatterContainerTransform(container, mesh, doc);
    attachCustomTileOverhead(tile, {
      kind: 'scatter',
      contentContainer: container,
      proxyFactory: createDisplayProxyFactory(container),
      syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
        syncScatterContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    invalidateCustomTileOverhead(tile, 'scatter-refresh');
    if (hasPendingTexture) scheduleScatterRetry(tile, Number(options?.retryAttempt) || 1);
    else clearScatterRetry(tile);
  } catch (error) {
    Logger.warn('AssetScatter.apply.failed', { error: String(error?.message || error), tileId: tile?.document?.id });
  }
}

export function rehydrateAllAssetScatterTiles() {
  try {
    const tiles = canvas?.tiles?.placeables || [];
    for (const tile of tiles) {
      try { applyAssetScatterTile(tile); } catch (_) {}
    }
  } catch (_) {}
}

export function clearAssetScatterCache() {
  try { TEXTURE_CACHE.clear(); } catch (_) {}
  try {
    for (const tile of Array.from(SCATTER_RETRY_TIMERS.keys())) clearScatterRetry(tile);
  } catch (_) {}
}
