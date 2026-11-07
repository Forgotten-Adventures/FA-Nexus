import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { resolveCanvasTilePlaceable } from '../canvas/tile-targets.js';
import {
  applyAssetScatterTile,
  rehydrateAllAssetScatterTiles,
  cleanupAssetScatterOverlay,
  clearAssetScatterCache,
  queueRefreshAllAssetScatterViewportLayers
} from './asset-scatter-geometry.js';
import {
  requestCustomTileRenderRefresh,
  registerCustomTileRenderLifecycle,
  scheduleCustomTileRenderApply
} from '../canvas/custom-tile-render-scheduler.js';

function logScatterHookFailure(hook, error, details = {}) {
  Logger.warn('AssetScatter.hook.failed', {
    hook,
    error: String(error?.message || error),
    ...details
  });
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
  requestCustomTileRenderRefresh(tile, {
    reason,
    logger: Logger,
    logCode: 'AssetScatter.refresh.failed',
    logLevel: 'warn'
  });
}

function scheduleAssetScatterApply(doc, reason = 'tile-change') {
  scheduleCustomTileRenderApply(doc, {
    reason,
    shouldApplyDocument: docHasScatterFlag,
    hasOverlay: tileHasScatterOverlay,
    applyTile: applyAssetScatterTile,
    afterApply: () => queueRefreshAllAssetScatterViewportLayers(reason),
    logger: Logger,
    logCode: 'AssetScatter.apply',
    logLevel: 'warn',
    refreshLogLevel: 'warn'
  });
}

try {
  registerCustomTileRenderLifecycle({
    id: 'asset-scatter',
    callback: applyAssetScatterTile,
    logCode: 'AssetScatter.lifecycle.failed'
  });
  Hooks.on('canvasReady', () => {
    try { rehydrateAllAssetScatterTiles(); }
    catch (error) { logScatterHookFailure('canvasReady', error); }
  });
  Hooks.on('canvasPan', () => {
    try { queueRefreshAllAssetScatterViewportLayers('canvas-pan'); }
    catch (error) { logScatterHookFailure('canvasPan', error); }
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
      const tile = resolveCanvasTilePlaceable(doc);
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
