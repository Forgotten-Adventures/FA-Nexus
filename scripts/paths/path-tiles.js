import {
  applyPathTile,
  rehydrateAllPathTiles,
  cleanupPathOverlay,
  clearTileMeshWaiters
} from './path-geometry.js';

export { applyPathTile, rehydrateAllPathTiles, cleanupPathOverlay };

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateAllPathTiles(); } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    try { applyPathTile(tile); } catch (_) {}
  });
  Hooks.on('refreshTile', (tile) => {
    try { applyPathTile(tile); } catch (_) {}
  });
  Hooks.on('updateTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyPathTile(tile);
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) cleanupPathOverlay(tile);
    } catch (_) {}
  });
  Hooks.on('canvasTearDown', () => {
    try { clearTileMeshWaiters(); } catch (_) {}
  });
} catch (_) {}
