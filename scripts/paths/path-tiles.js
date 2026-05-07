import {
  applyPathTile,
  rehydrateAllPathTiles,
  cleanupPathOverlay,
  cleanupPathWallsForTile,
  clearTileMeshWaiters
} from './path-geometry.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  migrateLegacyPathTileDocument,
  migrateLegacyPathTilesInScene
} from './legacy-path-migration.js';

export { applyPathTile, rehydrateAllPathTiles, cleanupPathOverlay };

const PRESERVE_LINKED_TILE_CLEANUP_OPTION = 'faNexusPreserveLinkedTileCleanup';

function shouldSkipPathWallCleanup(doc = null, options = {}) {
  try {
    if (options?.[PRESERVE_LINKED_TILE_CLEANUP_OPTION]) return true;
    if (globalThis?.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE) return true;
    const suppressedIds = globalThis?.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE_IDS;
    const docId = doc?.id || doc?._id || null;
    return !!(docId && suppressedIds instanceof Set && suppressedIds.has(docId));
  } catch (_) {
    return false;
  }
}

function stringifyError(error) {
  return String(error?.message || error);
}

function findTileForDocument(doc) {
  try {
    const tileId = doc?.id || doc?._id || null;
    if (!tileId) return null;
    return canvas?.tiles?.placeables?.find((tile) => tile?.document?.id === tileId) || null;
  } catch (_) {
    return null;
  }
}

async function migrateAndApplyPathTile(doc, reason) {
  try {
    await migrateLegacyPathTileDocument(doc, { reason });
  } catch (error) {
    Logger.error?.('LegacyPathMigration.hook.failed', {
      tileId: doc?.id || doc?._id || null,
      reason,
      error: stringifyError(error)
    });
  }
  const tile = findTileForDocument(doc);
  if (tile) await applyPathTile(tile);
}

try {
  Hooks.on('canvasReady', () => {
    void (async () => {
      await migrateLegacyPathTilesInScene(canvas?.scene, { reason: 'canvasReady' });
      rehydrateAllPathTiles();
    })().catch((error) => {
      Logger.error?.('LegacyPathMigration.canvasReady.failed', { error: stringifyError(error) });
    });
  });
  Hooks.on('drawTile', (tile) => {
    try { applyPathTile(tile); } catch (_) {}
  });
  Hooks.on('createTile', (doc) => {
    void migrateAndApplyPathTile(doc, 'createTile').catch((error) => {
      Logger.error?.('PathTiles.createTile.failed', {
        tileId: doc?.id || null,
        error: stringifyError(error)
      });
    });
  });
  Hooks.on('updateTile', (doc) => {
    void migrateAndApplyPathTile(doc, 'updateTile').catch((error) => {
      Logger.error?.('PathTiles.updateTile.failed', {
        tileId: doc?.id || null,
        error: stringifyError(error)
      });
    });
  });
  Hooks.on('deleteTile', (doc, options) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) cleanupPathOverlay(tile);
    } catch (_) {}
    if (!shouldSkipPathWallCleanup(doc, options)) {
      Promise.resolve(cleanupPathWallsForTile(doc)).catch((error) => {
        Logger.warn?.('PathTiles.deleteTile.cleanup.failed', {
          tileId: doc?.id || null,
          error: stringifyError(error)
        });
      });
    }
  });
  Hooks.on('canvasTearDown', () => {
    try { clearTileMeshWaiters(); } catch (_) {}
  });
} catch (_) {}
