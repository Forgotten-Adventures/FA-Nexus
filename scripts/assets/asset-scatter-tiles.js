import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  applyAssetScatterTile,
  rehydrateAllAssetScatterTiles,
  cleanupAssetScatterOverlay,
  clearAssetScatterCache,
  queueRefreshAllAssetScatterViewportLayers
} from './asset-scatter-geometry.js';

const SCATTER_TILE_APPLY_RETRY_DELAYS = [0, 16, 60, 140, 300];

function logScatterHookFailure(hook, error, details = {}) {
  Logger.warn('AssetScatter.hook.failed', {
    hook,
    error: String(error?.message || error),
    ...details
  });
}

function resolveTilePlaceable(doc) {
  const id = doc?.id || doc?._id;
  if (!id) return null;
  const placeables = canvas?.tiles?.placeables;
  if (!Array.isArray(placeables)) return null;
  return placeables.find((tile) => tile?.document?.id === id) || null;
}

function docHasScatterFlag(doc) {
  try {
    const direct = doc?.getFlag?.('fa-nexus', 'assetScatter');
    if (direct !== undefined) return !!direct;
  } catch (_) {}
  try {
    return !!(doc?.flags?.['fa-nexus']?.assetScatter || doc?._source?.flags?.['fa-nexus']?.assetScatter);
  } catch (_) {
    return false;
  }
}

function tileHasScatterOverlay(tile) {
  return !!(tile?.faNexusAssetScatterContainer || tile?.mesh?.faNexusAssetScatterContainer);
}

function requestScatterTileRefresh(tile, reason = 'scatter-refresh') {
  const refresh = () => {
    try {
      if (!canvas?.ready || !tile || tile.destroyed) return;
      try { tile.renderFlags?.set?.({ refreshState: true }); } catch (_) {}
      try { canvas?.tiles?.setAllRenderFlags?.({ refreshState: true }); } catch (_) {}
    } catch (error) {
      logScatterHookFailure('refresh', error, {
        tileId: tile?.document?.id || '',
        reason
      });
    }
  };
  refresh();
  try { requestAnimationFrame(() => refresh()); } catch (_) {}
  try { setTimeout(refresh, 80); } catch (_) {}
}

function scheduleAssetScatterApply(doc, reason = 'tile-change') {
  const id = doc?.id || doc?._id || '';
  if (!id) return;
  const initialTile = resolveTilePlaceable(doc);
  if (!docHasScatterFlag(doc) && !tileHasScatterOverlay(initialTile)) return;
  const run = (attempt = 0) => {
    try {
      const tile = resolveTilePlaceable(doc);
      if (tile && !tile.destroyed) {
        Promise.resolve(applyAssetScatterTile(tile))
          .then(() => {
            requestScatterTileRefresh(tile, reason);
            queueRefreshAllAssetScatterViewportLayers(reason);
          })
          .catch((error) => logScatterHookFailure(reason, error, { tileId: id, attempt }));
        return;
      }
      const nextDelay = SCATTER_TILE_APPLY_RETRY_DELAYS[attempt + 1];
      if (Number.isFinite(nextDelay)) setTimeout(() => run(attempt + 1), nextDelay);
    } catch (error) {
      logScatterHookFailure(reason, error, { tileId: id, attempt });
    }
  };
  run(0);
}

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateAllAssetScatterTiles(); }
    catch (error) { logScatterHookFailure('canvasReady', error); }
  });
  Hooks.on('canvasPan', () => {
    try { queueRefreshAllAssetScatterViewportLayers('canvas-pan'); }
    catch (error) { logScatterHookFailure('canvasPan', error); }
  });
  Hooks.on('drawTile', (tile) => {
    try { applyAssetScatterTile(tile); }
    catch (error) { logScatterHookFailure('drawTile', error, { tileId: tile?.document?.id || '' }); }
  });
  Hooks.on('createTile', (doc) => {
    try {
      scheduleAssetScatterApply(doc, 'createTile');
    } catch (error) { logScatterHookFailure('createTile', error, { tileId: doc?.id || '' }); }
  });
  Hooks.on('updateTile', (doc) => {
    try {
      scheduleAssetScatterApply(doc, 'updateTile');
    } catch (error) { logScatterHookFailure('updateTile', error, { tileId: doc?.id || '' }); }
  });
  Hooks.on('deleteTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) cleanupAssetScatterOverlay(tile);
    } catch (error) { logScatterHookFailure('deleteTile', error, { tileId: doc?.id || '' }); }
  });
  Hooks.on('canvasTearDown', () => {
    try { clearAssetScatterCache(); }
    catch (error) { logScatterHookFailure('canvasTearDown', error); }
  });
} catch (error) {
  Logger.warn('AssetScatter.hooks.register.failed', { error: String(error?.message || error) });
}
