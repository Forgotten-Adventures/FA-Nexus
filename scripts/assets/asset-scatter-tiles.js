import {
  applyAssetScatterTile,
  rehydrateAllAssetScatterTiles,
  cleanupAssetScatterOverlay,
  clearAssetScatterCache
} from './asset-scatter-geometry.js';

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateAllAssetScatterTiles(); } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    try { applyAssetScatterTile(tile); } catch (_) {}
  });
  Hooks.on('createTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyAssetScatterTile(tile);
    } catch (_) {}
  });
  Hooks.on('updateTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyAssetScatterTile(tile);
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) cleanupAssetScatterOverlay(tile);
    } catch (_) {}
  });
  Hooks.on('canvasTearDown', () => {
    try { clearAssetScatterCache(); } catch (_) {}
  });
} catch (_) {}
