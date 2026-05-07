import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  ensureMeshTransparent,
  ensureTileMesh,
  restoreMeshTexture
} from '../textures/texture-runtime-core.js';

export const SHADOW_ONLY_FLAG_KEY = 'shadowOnly';

const MODULE_ID = 'fa-nexus';
const SHADOW_ONLY_ORIGINAL_TEXTURE_KEY = 'faNexusShadowOnlyOriginalTexture';
const SCATTER_FLAG_KEY = 'assetScatter';

function readModuleFlags(doc) {
  try {
    const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
    return flags && typeof flags === 'object' ? flags : {};
  } catch (_) {
    return {};
  }
}

export function readShadowOnlyFlag(doc) {
  try {
    const direct = doc?.getFlag?.(MODULE_ID, SHADOW_ONLY_FLAG_KEY);
    if (direct !== undefined) return !!direct;
  } catch (_) {}
  return !!readModuleFlags(doc)?.[SHADOW_ONLY_FLAG_KEY];
}

function readShadowEnabled(doc) {
  try {
    const direct = doc?.getFlag?.(MODULE_ID, 'shadow');
    if (direct !== undefined) return !!direct;
  } catch (_) {}
  return !!readModuleFlags(doc)?.shadow;
}

export function isShadowOnlyActive(doc) {
  return !!(doc && readShadowEnabled(doc) && readShadowOnlyFlag(doc));
}

export function isShadowOnlyStateActive(state) {
  return !!(state && state.enabled && state.shadowOnly);
}

export function syncShadowOnlyDisplayObject(displayObject, active) {
  if (!displayObject || displayObject.destroyed) return false;
  const visible = !active;
  try { displayObject.faNexusShadowOnlySuppressed = !!active; } catch (_) {}
  try { displayObject.visible = visible; } catch (_) {}
  try { displayObject.renderable = visible; } catch (_) {}
  return active;
}

export function syncShadowOnlyCustomContainer(tile, container) {
  const active = isShadowOnlyActive(tile?.document);
  syncShadowOnlyDisplayObject(container, active);
  return active;
}

function hasCustomVisualRuntime(doc) {
  const flags = readModuleFlags(doc);
  return !!(
    flags?.[SCATTER_FLAG_KEY]
    || flags?.pathV2
    || flags?.pathsV2
    || flags?.path
  );
}

function syncKnownCustomContainers(tile, active) {
  try {
    const mesh = tile?.mesh || null;
    syncShadowOnlyDisplayObject(tile?.faNexusAssetScatterContainer || mesh?.faNexusAssetScatterContainer, active);
    syncShadowOnlyDisplayObject(tile?.faNexusPathContainer || mesh?.faNexusPathContainer, active);
  } catch (error) {
    Logger.warn('ShadowOnly.customContainer.syncFailed', {
      tileId: tile?.document?.id || null,
      error: String(error?.message || error)
    });
  }
}

export async function applyShadowOnlyTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    const active = isShadowOnlyActive(doc);
    syncKnownCustomContainers(tile, active);

    let mesh = tile.mesh || null;
    if (hasCustomVisualRuntime(doc)) {
      if (mesh && !mesh.destroyed) restoreMeshTexture(mesh, SHADOW_ONLY_ORIGINAL_TEXTURE_KEY);
      return;
    }

    if (active) {
      if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
      if (!mesh || mesh.destroyed) return;
      ensureMeshTransparent(mesh, SHADOW_ONLY_ORIGINAL_TEXTURE_KEY);
      return;
    }

    if (mesh && !mesh.destroyed) restoreMeshTexture(mesh, SHADOW_ONLY_ORIGINAL_TEXTURE_KEY);
  } catch (error) {
    Logger.warn('ShadowOnly.apply.failed', {
      tileId: tile?.document?.id || null,
      error: String(error?.message || error)
    });
  }
}

export function cleanupShadowOnlyTile(tile) {
  try {
    const mesh = tile?.mesh || null;
    if (mesh && !mesh.destroyed) restoreMeshTexture(mesh, SHADOW_ONLY_ORIGINAL_TEXTURE_KEY);
    syncKnownCustomContainers(tile, false);
  } catch (error) {
    Logger.warn('ShadowOnly.cleanup.failed', {
      tileId: tile?.document?.id || null,
      error: String(error?.message || error)
    });
  }
}

export function rehydrateAllShadowOnlyTiles() {
  try {
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) {
      try { void applyShadowOnlyTile(tile); }
      catch (error) {
        Logger.warn('ShadowOnly.rehydrateTile.failed', {
          tileId: tile?.document?.id || null,
          error: String(error?.message || error)
        });
      }
    }
  } catch (error) {
    Logger.warn('ShadowOnly.rehydrateAll.failed', {
      error: String(error?.message || error)
    });
  }
}

export function cleanupAllShadowOnlyTiles() {
  try {
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) {
      cleanupShadowOnlyTile(tile);
    }
  } catch (error) {
    Logger.warn('ShadowOnly.cleanupAll.failed', {
      error: String(error?.message || error)
    });
  }
}

function findTileForDocument(doc) {
  try {
    const id = doc?.id || doc?._id || null;
    if (!id) return null;
    return canvas?.tiles?.placeables?.find?.((tile) => tile?.document?.id === id) || null;
  } catch (_) {
    return null;
  }
}

try {
  Hooks.on('canvasReady', () => {
    rehydrateAllShadowOnlyTiles();
  });
  Hooks.on('drawTile', (tile) => {
    void applyShadowOnlyTile(tile);
  });
  Hooks.on('createTile', (doc) => {
    const tile = findTileForDocument(doc);
    if (tile) void applyShadowOnlyTile(tile);
  });
  Hooks.on('updateTile', (doc) => {
    const tile = findTileForDocument(doc);
    if (tile) void applyShadowOnlyTile(tile);
  });
  Hooks.on('deleteTile', (doc) => {
    const tile = findTileForDocument(doc);
    if (tile) cleanupShadowOnlyTile(tile);
  });
  Hooks.on('canvasTearDown', () => {
    cleanupAllShadowOnlyTiles();
  });
} catch (error) {
  Logger.warn('ShadowOnly.hooks.registerFailed', {
    error: String(error?.message || error)
  });
}
