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
import { registerCustomTileRenderLifecycle } from '../canvas/custom-tile-render-scheduler.js';
import { shouldSkipLinkedTileCleanup } from '../canvas/linked-tile-cleanup-guard.js';
import { resolveCanvasTilePlaceable } from '../canvas/tile-targets.js';
import { shouldIgnoreSceneGroupNativeDeletion } from '../composition/scene-group-native-deletion-policy.js';

const localDeletes = new WeakSet();

export { applyPathTile, rehydrateAllPathTiles, cleanupPathOverlay };

function stringifyError(error) {
  return String(error?.message || error);
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
  const tile = resolveCanvasTilePlaceable(doc);
  if (tile) await applyPathTile(tile);
}

try {
  registerCustomTileRenderLifecycle({
    id: 'path-tiles',
    callback: applyPathTile,
    logCode: 'PathTiles.lifecycle.failed'
  });
  Hooks.on('canvasReady', () => {
    void (async () => {
      await migrateLegacyPathTilesInScene(canvas?.scene, { reason: 'canvasReady' });
      rehydrateAllPathTiles();
    })().catch((error) => {
      Logger.error?.('LegacyPathMigration.canvasReady.failed', { error: stringifyError(error) });
    });
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
  Hooks.on('preDeleteTile', (doc) => { localDeletes.add(doc); });
  Hooks.on('deleteTile', (doc, options) => {
    try {
      const tile = resolveCanvasTilePlaceable(doc);
      if (tile) cleanupPathOverlay(tile);
    } catch (_) {}
    const initiatedHere = localDeletes.delete(doc);
    const registeredOwner = doc.parent?.getFlag?.('fa-nexus', 'compositionRegistry')?.relationships?.some(
      relation => relation.ownerUuid === doc.uuid && relation.type === 'generated-by' && relation.generator === 'path-v2');
    // Registered ownership and atomic group commands have their own complete
    // cascade. This older hook must never become a second destructive writer.
    if (initiatedHere && !registeredOwner && !shouldIgnoreSceneGroupNativeDeletion(options)
      && !options?.faNexusSceneGroupCommand && !shouldSkipLinkedTileCleanup(doc, options)) {
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
