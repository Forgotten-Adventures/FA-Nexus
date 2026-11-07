import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { resolveFlattenedChunkEntries, resolveFlattenedChunkContainerTransform } from './flatten-chunk-layout.js';
import {
  attachCustomTileOverhead,
  detachCustomTileOverhead
} from '../canvas/custom-tile-overhead.js';
import { createDisplayProxyFactory } from '../canvas/display-object-proxy.js';
import {
  encodeTexturePath,
  ensureTileMesh,
  getTransparentTextureSrc,
  loadTexture,
  prepareCustomTileRendererMesh,
  restoreMeshTexture
} from '../textures/texture-runtime-core.js';
import {
  collectTileDocuments,
  collectTilePlaceables,
  mapTilePlaceablesById,
  resolveTilePlaceable
} from '../canvas/tile-targets.js';
import {
  requestCustomTileRenderRefresh,
  registerCustomTileRenderLifecycle,
  scheduleCustomTileRenderApply
} from '../canvas/custom-tile-render-scheduler.js';

const MODULE_ID = 'fa-nexus';
const REPAIR_ATTEMPTS = new Map();
const REPAIR_COOLDOWN_MS = 10000;

function forgetRepairAttemptForTile(target) {
  const id = target?.document?.id || target?.id || target?._id || null;
  if (id) REPAIR_ATTEMPTS.delete(id);
}

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

function buildRenderKey(chunks) {
  if (!chunks?.length) return '';
  return chunks.map((chunk) => `${chunk.src}|${chunk.x}|${chunk.y}|${chunk.width}|${chunk.height}`).join(';');
}

function requestFlattenedChunkRefresh(tile, reason = 'flatten-refresh') {
  requestCustomTileRenderRefresh(tile, {
    reason,
    logger: Logger,
    logCode: 'TileFlatten.chunkRefresh.failed',
    logLevel: 'debug'
  });
}

function tileHasFlattenChunkOverlay(tile) {
  return !!(tile?.faNexusFlattenChunkContainer || tile?.mesh?.faNexusFlattenChunkContainer);
}

function scheduleFlattenedChunkApply(doc, reason = 'tile-change') {
  scheduleCustomTileRenderApply(doc, {
    reason,
    shouldApplyDocument: resolveFlattenedMeta,
    hasOverlay: tileHasFlattenChunkOverlay,
    applyTile: applyFlattenedChunks,
    afterApply: (tile) => scheduleFlattenedChunkTransformSettle(tile, reason),
    logger: Logger,
    logCode: 'TileFlatten.chunkApply',
    logLevel: 'debug',
    refreshLogLevel: 'debug'
  });
}

function scheduleFlattenedChunkTransformSettle(tile, reason) {
  const syncLatest = () => {
    try {
      if (!tile || tile.destroyed || !tile.mesh || tile.mesh.destroyed) return;
      const container = tile.faNexusFlattenChunkContainer
        || tile.mesh.faNexusFlattenChunkContainer
        || null;
      if (!container || container.destroyed || !resolveFlattenedMeta(tile.document)) return;
      syncFlattenContainerTransform(container, tile.mesh, tile.document);
    } catch (error) {
      Logger.error('TileFlatten.chunkTransformSettle.failed', {
        tileId: tile?.document?.id || tile?.id || null,
        reason,
        error: String(error?.stack || error?.message || error)
      });
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(syncLatest));
  setTimeout(syncLatest, 120);
}

export function syncFlattenContainerTransform(container, mesh, doc, previewScale = null) {
  if (!container || container.destroyed || !mesh || mesh.destroyed) return;
  if (container[Symbol.for('fa-nexus.scene-group-display-transform-preview')]) return;
  const docWidth = Math.max(1, Number(doc?.width) || 0) || Math.max(1, Number(mesh?.width) || 1);
  const docHeight = Math.max(1, Number(doc?.height) || 0) || Math.max(1, Number(mesh?.height) || 1);
  try {
    const transform = resolveFlattenedChunkContainerTransform(mesh, doc, previewScale);
    container.scale?.set?.(transform.scaleX, transform.scaleY);
    container.position?.set?.(transform.x, transform.y);
  } catch (_) {
    try { container.scale?.set?.(1, 1); } catch (_) {}
    container.position?.set?.(-docWidth / 2, -docHeight / 2);
  }
}

export function isFlattenChunkTargetLive(tile, mesh, container, build) {
  if (!tile || tile.destroyed || !mesh || mesh.destroyed || tile.mesh !== mesh) return false;
  if (build && tile._faNexusFlattenChunkBuild !== build) return false;
  if (!container) return true;
  if (container.destroyed) return false;
  return tile.faNexusFlattenChunkContainer === container || mesh.faNexusFlattenChunkContainer === container;
}

export function isFlattenChunkBuildReusable(tile, mesh, container, build, renderKey) {
  return Boolean(
    build
      && build.key === renderKey
      && build.mesh === mesh
      && build.container === container
      && build.promise
      && isFlattenChunkTargetLive(tile, mesh, container, build)
  );
}

function ensureFlattenChunkContainerParent(container, mesh) {
  if (!container || !mesh || container.destroyed || mesh.destroyed || container.parent === mesh) return false;
  try { container.parent?.removeChild?.(container); } catch (_) {}
  mesh.addChild(container);
  return container.parent === mesh;
}

export function destroyFlattenChunkSprites(sprites) {
  for (const sprite of sprites || []) {
    try { sprite.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
  }
}

export async function applyFlattenedChunks(tile) {
  try {
    if (!tile || tile.destroyed) return;
    if (tile[Symbol.for('fa-nexus.scene-group-display-transform-preview')]) return;
    const doc = tile.document;
    const meta = resolveFlattenedMeta(doc);
    const chunks = resolveFlattenedChunkEntries(meta);
    const standardMask = doc?.getFlag?.(MODULE_ID, 'standardTileMask')
      || doc?.flags?.[MODULE_ID]?.standardTileMask
      || doc?._source?.flags?.[MODULE_ID]?.standardTileMask
      || null;
    if (standardMask) {
      const hadOverlay = tileHasFlattenChunkOverlay(tile);
      if (hadOverlay) cleanupFlattenedChunks(tile);
      if (chunks.length || hadOverlay) {
        Logger.trace?.('flatten-chunks', 'TileFlatten.applyChunks.skippedForStandardMask', {
          tileId: doc?.id || null
        });
      }
      return;
    }
    if (!chunks.length) {
      if (meta) await repairFlattenedTileTexture(doc, meta, tile);
      cleanupFlattenedChunks(tile);
      return;
    }

    const mesh = await prepareCustomTileRendererMesh(tile, {
      originalTextureSlotKey: 'faNexusFlattenOriginalTexture'
    });
    if (!isFlattenChunkTargetLive(tile, mesh)) return;

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
    } else if (container.parent !== mesh) {
      ensureFlattenChunkContainerParent(container, mesh);
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
        refreshReason: 'flatten-refresh',
        syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
          syncFlattenContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
        }
      });
      requestFlattenedChunkRefresh(tile, 'flatten-reuse');
      return;
    }

    const existingBuild = tile._faNexusFlattenChunkBuild;
    if (isFlattenChunkBuildReusable(tile, mesh, container, existingBuild, renderKey)) {
      return existingBuild.promise;
    }

    const build = { key: renderKey, mesh, container, promise: null };
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

      if (!isFlattenChunkTargetLive(tile, mesh, container, build)
        || tile[Symbol.for('fa-nexus.scene-group-display-transform-preview')]) {
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

      if (!isFlattenChunkTargetLive(tile, mesh, container, build)) {
        destroyFlattenChunkSprites(nextSprites);
        return;
      }

      const prevChildren = container.children?.slice() || [];
      container.removeChildren();
      destroyFlattenChunkSprites(prevChildren);
      for (const sprite of nextSprites) {
        container.addChild(sprite);
      }

      container.faNexusFlattenChunkRenderKey = renderKey;
      // Release the held scale at the same instant the new chunk geometry lands.
      delete container[Symbol.for('fa-nexus.scene-group-display-transform-preview')];
      syncFlattenContainerTransform(container, mesh, doc);
      mesh.faNexusFlattenChunkContainer = container;
      tile.faNexusFlattenChunkContainer = container;
      attachCustomTileOverhead(tile, {
        kind: 'flatten',
        contentContainer: container,
        proxyFactory: createDisplayProxyFactory(container),
        refreshReason: 'flatten-refresh',
        syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
          syncFlattenContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
        }
      });
      requestFlattenedChunkRefresh(tile, 'flatten-build');
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
    if (mesh) restoreMeshTexture(mesh, 'faNexusFlattenOriginalTexture');
    if (mesh) mesh.faNexusFlattenChunkContainer = null;
    tile.faNexusFlattenChunkContainer = null;
  } catch (_) {}
}

export async function rehydrateAllFlattenedChunks() {
  try {
    const tiles = collectTilePlaceables();
    for (const tile of tiles) {
      try { applyFlattenedChunks(tile); } catch (_) {}
    }

    const docs = collectTileDocuments({ placeables: tiles });
    if (!docs.length) return;
    const placeablesById = mapTilePlaceablesById(tiles);
    for (const doc of docs) {
      if (!doc) continue;
      const meta = resolveFlattenedMeta(doc);
      if (!meta) continue;
      if (Array.isArray(meta?.chunks) && meta.chunks.length) continue;
      const hasPlaceable = !!placeablesById.get(doc.id);
      if (hasPlaceable) continue;
      await repairFlattenedTileTexture(doc, meta, null);
    }
  } catch (_) {}
}

try {
  registerCustomTileRenderLifecycle({
    id: 'flatten-chunks',
    callback: applyFlattenedChunks,
    logCode: 'TileFlatten.lifecycle.failed'
  });
  Hooks.on('canvasReady', () => {
    try { rehydrateAllFlattenedChunks(); } catch (_) {}
  });
  Hooks.on('createTile', (doc) => {
    try {
      scheduleFlattenedChunkApply(doc, 'createTile');
    } catch (_) {}
  });
  Hooks.on('updateTile', (doc) => {
    try {
      scheduleFlattenedChunkApply(doc, 'updateTile');
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc) => {
    try {
      if (!resolveFlattenedMeta(doc)) return;
      forgetRepairAttemptForTile(doc);
      const tile = resolveTilePlaceable(doc);
      if (tile) cleanupFlattenedChunks(tile);
    } catch (_) {}
  });
  Hooks.on('destroyTile', (tile) => {
    forgetRepairAttemptForTile(tile);
    cleanupFlattenedChunks(tile);
  });
  Hooks.on('canvasTearDown', () => {
    REPAIR_ATTEMPTS.clear();
  });
} catch (_) {}
