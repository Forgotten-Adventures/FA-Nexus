import {
  applyPathTile,
  rehydrateAllPathTiles,
  cleanupPathOverlay,
  cleanupPathWallsForTile,
  clearTileMeshWaiters
} from './path-geometry.js';

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

function shouldHandlePathWallCleanup(userId) {
  try {
    const currentUserId = game?.user?.id || null;
    if (!currentUserId) return false;
    if (userId) return userId === currentUserId;
    const activeGmIds = Array.from(game?.users || [])
      .filter((user) => user?.active && user?.isGM && user?.id)
      .map((user) => user.id)
      .sort();
    if (!activeGmIds.length) return true;
    return activeGmIds[0] === currentUserId;
  } catch (_) {
    return false;
  }
}

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateAllPathTiles(); } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    try { applyPathTile(tile); } catch (_) {}
  });
  Hooks.on('createTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyPathTile(tile);
    } catch (_) {}
  });
  Hooks.on('updateTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyPathTile(tile);
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc, options, userId) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) cleanupPathOverlay(tile);
    } catch (_) {}
    if (shouldHandlePathWallCleanup(userId) && !shouldSkipPathWallCleanup(doc, options)) {
      try { cleanupPathWallsForTile(doc); } catch (_) {}
    }
  });
  Hooks.on('canvasTearDown', () => {
    try { clearTileMeshWaiters(); } catch (_) {}
  });
} catch (_) {}
