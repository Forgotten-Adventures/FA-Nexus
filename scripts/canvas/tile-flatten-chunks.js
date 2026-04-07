import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  attachCustomTileOverhead,
  createDisplayProxyFactory,
  detachCustomTileOverhead,
  invalidateCustomTileOverhead
} from './custom-tile-overhead.js';
import {
  encodeTexturePath,
  ensureTileMesh,
  getTransparentTexture,
  getTransparentTextureSrc,
  loadTexture
} from '../textures/texture-render.js';

const MODULE_ID = 'fa-nexus';
const REPAIR_ATTEMPTS = new Map();
const REPAIR_COOLDOWN_MS = 10000;

function normalizeSrc(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

function resolveMetaTextureSrc(meta) {
  return normalizeSrc(meta?.filePath || '');
}

function isTransparentSrc(src) {
  if (!src) return true;
  const placeholder = normalizeSrc(getTransparentTextureSrc());
  return src === placeholder;
}

function shouldAttemptRepair(doc) {
  const id = doc?.id || null;
  if (!id) return true;
  const last = REPAIR_ATTEMPTS.get(id) || 0;
  const now = Date.now();
  if (now - last < REPAIR_COOLDOWN_MS) return false;
  REPAIR_ATTEMPTS.set(id, now);
  return true;
}

async function repairFlattenedTileTexture(doc, meta, tile = null) {
  try {
    if (!doc || !meta) return false;
    if (Array.isArray(meta?.chunks) && meta.chunks.length) return false;
    const rawTextureSrc = normalizeSrc(doc?.texture?.src || '');
    const fallbackSrc = normalizeSrc(doc?.img || doc?._source?.img || doc?._source?.texture?.src);
    const targetSrc = resolveMetaTextureSrc(meta) || fallbackSrc;
    const needsRepair = isTransparentSrc(rawTextureSrc);
    if (!targetSrc || isTransparentSrc(targetSrc) || !needsRepair) return false;
    if (!shouldAttemptRepair(doc)) return false;
    const encoded = encodeTexturePath(targetSrc);
    let updated = false;
    if (typeof doc.update === 'function') {
      try {
        const updateData = { 'texture.src': encoded };
        if (doc?.img !== undefined) updateData.img = encoded;
        await doc.update(updateData);
        updated = true;
      } catch (error) {
        Logger.debug?.('TileFlatten.repairTexture.updateFailed', {
          error: String(error?.message || error),
          tileId: doc?.id
        });
      }
    }
    if (!updated && tile) {
      try {
        const mesh = await ensureTileMesh(tile);
        if (mesh && !mesh.destroyed) {
          const texture = await loadTexture(encoded, { attempts: 2, timeout: 4000 });
          if (texture) {
            mesh.texture = texture;
            mesh.alpha = 1;
            mesh.renderable = true;
          }
        }
      } catch (error) {
        Logger.debug?.('TileFlatten.repairTexture.meshFailed', {
          error: String(error?.message || error),
          tileId: doc?.id
        });
      }
    }
    return updated;
  } catch (_) {
    return false;
  }
}

function resolveFlattenedMeta(doc) {
  if (!doc) return null;
  try {
    const meta = doc.getFlag?.(MODULE_ID, 'flattened');
    if (meta && typeof meta === 'object') return meta;
  } catch (_) {}
  try {
    const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
    if (flags?.flattened && typeof flags.flattened === 'object') return flags.flattened;
  } catch (_) {}
  return null;
}

function resolveChunkEntriesFromMeta(meta) {
  const chunks = Array.isArray(meta?.chunks) ? meta.chunks : [];
  if (!chunks.length) return [];
  const normalized = [];
  for (const chunk of chunks) {
    const src = String(chunk?.src || '').trim();
    if (!src) continue;
    const width = Number(chunk?.width) || 0;
    const height = Number(chunk?.height) || 0;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
    normalized.push({
      src,
      x: Number(chunk?.x) || 0,
      y: Number(chunk?.y) || 0,
      width,
      height
    });
  }
  return normalized;
}

function resolveChunkEntries(doc) {
  const meta = resolveFlattenedMeta(doc);
  return resolveChunkEntriesFromMeta(meta);
}

function buildRenderKey(chunks) {
  if (!chunks?.length) return '';
  return chunks.map((chunk) => `${chunk.src}|${chunk.x}|${chunk.y}|${chunk.width}|${chunk.height}`).join(';');
}

function ensureFlattenMeshTransparent(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (!mesh.faNexusFlattenOriginalTexture) mesh.faNexusFlattenOriginalTexture = mesh.texture;
    const placeholder = getTransparentTexture();
    if (mesh.texture !== placeholder) mesh.texture = placeholder;
    mesh.alpha = 1;
    mesh.renderable = true;
  } catch (_) {}
}

function restoreFlattenMeshTexture(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (mesh.faNexusFlattenOriginalTexture) {
      mesh.texture = mesh.faNexusFlattenOriginalTexture;
      mesh.faNexusFlattenOriginalTexture = null;
    }
  } catch (_) {}
}

function syncFlattenContainerTransform(container, mesh, doc) {
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
  try {
    container.scale?.set?.(1 / sx, 1 / sy);
    container.position?.set?.(-(docWidth * ax) / (sx || 1), -(docHeight * ay) / (sy || 1));
  } catch (_) {
    try { container.scale?.set?.(1, 1); } catch (_) {}
    container.position?.set?.(-docWidth / 2, -docHeight / 2);
  }
}

export async function applyFlattenedChunks(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    const standardMask = doc?.getFlag?.(MODULE_ID, 'standardTileMask')
      || doc?.flags?.[MODULE_ID]?.standardTileMask
      || doc?._source?.flags?.[MODULE_ID]?.standardTileMask
      || null;
    if (standardMask) {
      cleanupFlattenedChunks(tile);
      Logger.info?.('TileFlatten.applyChunks.skippedForStandardMask', {
        tileId: doc?.id || null
      });
      return;
    }
    const meta = resolveFlattenedMeta(doc);
    const chunks = resolveChunkEntriesFromMeta(meta);
    if (!chunks.length) {
      if (meta) await repairFlattenedTileTexture(doc, meta, tile);
      cleanupFlattenedChunks(tile);
      return;
    }

    const mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;

    ensureFlattenMeshTransparent(mesh);

    let container = tile.faNexusFlattenChunkContainer || mesh.faNexusFlattenChunkContainer;
    const renderKey = buildRenderKey(chunks);
    const reuse = container && !container.destroyed && container.faNexusFlattenChunkRenderKey === renderKey;

    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      mesh.addChild(container);
      mesh.faNexusFlattenChunkContainer = container;
      tile.faNexusFlattenChunkContainer = container;
    } else if (!container.parent) {
      mesh.addChild(container);
      mesh.faNexusFlattenChunkContainer = container;
      tile.faNexusFlattenChunkContainer = container;
    }

    try {
      container.alpha = 1;
    } catch (_) {}

    syncFlattenContainerTransform(container, mesh, doc);

    if (reuse) {
      attachCustomTileOverhead(tile, {
        kind: 'flatten',
        contentContainer: container,
        proxyFactory: createDisplayProxyFactory(container),
        syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
          syncFlattenContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
        }
      });
      invalidateCustomTileOverhead(tile, 'flatten-refresh');
      return;
    }

    const existingBuild = tile._faNexusFlattenChunkBuild;
    if (existingBuild && existingBuild.key === renderKey) {
      return existingBuild.promise;
    }

    const build = { key: renderKey, promise: null };
    tile._faNexusFlattenChunkBuild = build;
    build.promise = (async () => {
      const loadJobs = chunks.map(async (chunk) => {
        try {
          const texture = await loadTexture(chunk.src, { attempts: 3, timeout: 5000 });
          return { chunk, texture };
        } catch (error) {
          Logger.debug?.('TileFlatten.chunkTextureFailed', {
            error: String(error?.message || error),
            src: chunk.src
          });
          return null;
        }
      });
      const results = await Promise.all(loadJobs);

      if (tile._faNexusFlattenChunkBuild !== build) {
        return;
      }

      const nextSprites = [];
      for (const result of results) {
        if (!result) continue;
        const { chunk, texture } = result;
        const sprite = new PIXI.Sprite(texture);
        sprite.eventMode = 'none';
        sprite.position.set(chunk.x, chunk.y);
        sprite.width = chunk.width;
        sprite.height = chunk.height;
        nextSprites.push(sprite);
      }

      if (tile._faNexusFlattenChunkBuild !== build) {
        for (const sprite of nextSprites) {
          try { sprite.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        }
        return;
      }

      const prevChildren = container.children?.slice() || [];
      container.removeChildren();
      for (const child of prevChildren) {
        try { child.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      for (const sprite of nextSprites) {
        container.addChild(sprite);
      }

      container.faNexusFlattenChunkRenderKey = renderKey;
      mesh.faNexusFlattenChunkContainer = container;
      tile.faNexusFlattenChunkContainer = container;
      attachCustomTileOverhead(tile, {
        kind: 'flatten',
        contentContainer: container,
        proxyFactory: createDisplayProxyFactory(container),
        syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
          syncFlattenContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
        }
      });
      invalidateCustomTileOverhead(tile, 'flatten-refresh');
    })();

    try {
      await build.promise;
    } finally {
      if (tile._faNexusFlattenChunkBuild === build) {
        delete tile._faNexusFlattenChunkBuild;
      }
    }
  } catch (error) {
    Logger.debug?.('TileFlatten.applyChunks.failed', { error: String(error?.message || error) });
  }
}

export function cleanupFlattenedChunks(tile) {
  try {
    if (!tile) return;
    try { delete tile._faNexusFlattenChunkBuild; } catch (_) {}
    const mesh = tile.mesh;
    const container = mesh?.faNexusFlattenChunkContainer || tile.faNexusFlattenChunkContainer;
    detachCustomTileOverhead(tile, { kind: 'flatten' });
    if (container) {
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    }
    if (mesh) restoreFlattenMeshTexture(mesh);
    if (mesh) mesh.faNexusFlattenChunkContainer = null;
    tile.faNexusFlattenChunkContainer = null;
  } catch (_) {}
}

export async function rehydrateAllFlattenedChunks() {
  try {
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) {
      try { applyFlattenedChunks(tile); } catch (_) {}
    }

    const docs = canvas?.scene?.tiles ? Array.from(canvas.scene.tiles) : [];
    if (!docs.length) return;
    for (const doc of docs) {
      if (!doc) continue;
      const meta = resolveFlattenedMeta(doc);
      if (!meta) continue;
      if (Array.isArray(meta?.chunks) && meta.chunks.length) continue;
      const hasPlaceable = !!tiles.find((tile) => tile?.document?.id === doc.id);
      if (hasPlaceable) continue;
      await repairFlattenedTileTexture(doc, meta, null);
    }
  } catch (_) {}
}

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateAllFlattenedChunks(); } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    try { applyFlattenedChunks(tile); } catch (_) {}
  });
  Hooks.on('createTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyFlattenedChunks(tile);
    } catch (_) {}
  });
  Hooks.on('updateTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyFlattenedChunks(tile);
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) cleanupFlattenedChunks(tile);
    } catch (_) {}
  });
} catch (_) {}
