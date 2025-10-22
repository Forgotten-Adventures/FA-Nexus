import {
  applyMaskedTilingToTile,
  rehydrateAllMaskedTiles,
  cancelGlobalRehydrate,
  clearMaskedOverlaysOnDelete
} from './texture-render.js';

export { rehydrateAllMaskedTiles };

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateAllMaskedTiles({ attempts: 6, interval: 250 }); } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    try { applyMaskedTilingToTile(tile); } catch (_) {}
  });
  Hooks.on('refreshTile', (tile) => {
    try { applyMaskedTilingToTile(tile); } catch (_) {}
  });
  Hooks.on('updateTile', async (doc, change) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        await applyMaskedTilingToTile(tile);
        rehydrateAllMaskedTiles({ attempts: 2, interval: 200 });
      }
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) clearMaskedOverlaysOnDelete(tile);;
    } catch (_) {}
  });
  Hooks.on('canvasTearDown', () => {
    try { cancelGlobalRehydrate(); } catch (_) {}
  });
} catch (_) {}
