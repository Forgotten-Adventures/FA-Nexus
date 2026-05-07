import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  applyAssetScatterTile,
  rehydrateAllAssetScatterTiles,
  cleanupAssetScatterOverlay,
  clearAssetScatterCache
} from './asset-scatter-geometry.js';

function logScatterHookFailure(hook, error, details = {}) {
  Logger.warn('AssetScatter.hook.failed', {
    hook,
    error: String(error?.message || error),
    ...details
  });
}

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateAllAssetScatterTiles(); }
    catch (error) { logScatterHookFailure('canvasReady', error); }
  });
  Hooks.on('drawTile', (tile) => {
    try { applyAssetScatterTile(tile); }
    catch (error) { logScatterHookFailure('drawTile', error, { tileId: tile?.document?.id || '' }); }
  });
  Hooks.on('createTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyAssetScatterTile(tile);
    } catch (error) { logScatterHookFailure('createTile', error, { tileId: doc?.id || '' }); }
  });
  Hooks.on('updateTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyAssetScatterTile(tile);
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
