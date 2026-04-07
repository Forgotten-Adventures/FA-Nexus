import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  applyMaskedTilingToTile,
  applyStandardTileMaskToTile,
  applyTileHsbcToMesh,
  rehydrateAllMaskedTiles,
  rehydrateAllStandardTileMasks,
  cancelGlobalRehydrate,
  clearMaskedOverlaysOnDelete
} from './texture-render.js';

export { rehydrateAllMaskedTiles, rehydrateAllStandardTileMasks };

const EDITING_TILE_SET_KEY = '__faNexusTextureEditingTileIds';
const REFRESH_STATE = new WeakMap();

function isEditingTile(tile) {
  try {
    const id = tile?.document?.id || tile?.id;
    if (!id) return false;
    const set = globalThis?.[EDITING_TILE_SET_KEY];
    return set instanceof Set && set.has(id);
  } catch (_) {
    return false;
  }
}

function getRefreshState(tile) {
  try {
    if (!tile) return null;
    let state = REFRESH_STATE.get(tile) || null;
    if (state) return state;
    state = {
      seq: 0,
      raf: null,
      timer: null
    };
    REFRESH_STATE.set(tile, state);
    return state;
  } catch (_) {
    return null;
  }
}

function cancelRefreshFollowups(tile) {
  try {
    const state = tile ? REFRESH_STATE.get(tile) : null;
    if (!state) return;
    if (state.raf !== null && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(state.raf); } catch (_) {}
    }
    if (state.timer !== null) {
      try { clearTimeout(state.timer); } catch (_) {}
    }
    state.raf = null;
    state.timer = null;
  } catch (_) {}
}

function hasMaskedPresentation(tile) {
  try {
    if (!tile?.document) return false;
    if (
      tile?.mesh?.faNexusMaskContainer
      || tile?.mesh?.faNexusStandardMaskContainer
      || tile?.faNexusMaskContainer
      || tile?.faNexusStandardMaskContainer
    ) return true;
    const flags = tile.document.flags?.['fa-nexus'] || tile.document._source?.flags?.['fa-nexus'] || null;
    return !!(flags?.maskedTiling || flags?.standardTileMask);
  } catch (_) {
    return false;
  }
}

function getMaskRefreshTargets(tile) {
  try {
    const flags = tile?.document?.flags?.['fa-nexus'] || tile?.document?._source?.flags?.['fa-nexus'] || null;
    const hasMaskedTilingFlag = !!flags?.maskedTiling;
    const hasStandardTileMaskFlag = !!flags?.standardTileMask;
    const hasMaskedContainer = !!(
      tile?.mesh?.faNexusMaskContainer
      || tile?.faNexusMaskContainer
    );
    const hasStandardContainer = !!(
      tile?.mesh?.faNexusStandardMaskContainer
      || tile?.faNexusStandardMaskContainer
    );
    return {
      hasMaskedTilingFlag,
      hasStandardTileMaskFlag,
      hasMaskedContainer,
      hasStandardContainer,
      shouldRunMaskedTiling: hasMaskedTilingFlag || (hasMaskedContainer && !hasStandardTileMaskFlag),
      shouldRunStandardTileMask: hasStandardTileMaskFlag || (hasStandardContainer && !hasMaskedTilingFlag)
    };
  } catch (_) {
    return {
      hasMaskedTilingFlag: false,
      hasStandardTileMaskFlag: false,
      hasMaskedContainer: false,
      hasStandardContainer: false,
      shouldRunMaskedTiling: false,
      shouldRunStandardTileMask: false
    };
  }
}

async function runMaskRefresh(tile, reason = 'unknown') {
  try {
    if (!tile || tile.destroyed || !tile.document?.scene) return;
    const targets = getMaskRefreshTargets(tile);
    if (targets.hasMaskedTilingFlag && targets.hasStandardTileMaskFlag) {
      Logger.error('MaskedTiles.runMaskRefresh.conflictingModes', {
        tileId: tile?.document?.id || tile?.id || null,
        reason
      });
    }
    const failures = [];
    if (targets.shouldRunMaskedTiling) {
      try {
        await Promise.resolve(applyMaskedTilingToTile(tile));
      } catch (error) {
        failures.push({
          step: 'maskedTiling',
          error: String(error?.message || error || 'unknown error')
        });
      }
    }
    if (targets.shouldRunStandardTileMask) {
      try {
        await Promise.resolve(applyStandardTileMaskToTile(tile));
      } catch (error) {
        failures.push({
          step: 'standardTileMask',
          error: String(error?.message || error || 'unknown error')
        });
      }
    }
    if (targets.shouldRunMaskedTiling || targets.shouldRunStandardTileMask) {
      try {
        await Promise.resolve(applyTileHsbcToMesh(tile));
      } catch (error) {
        failures.push({
          step: 'hsbc',
          error: String(error?.message || error || 'unknown error')
        });
      }
    }
    if (!failures.length) return;
    Logger.error('MaskedTiles.runMaskRefresh.failed', {
      tileId: tile?.document?.id || tile?.id || null,
      reason,
      failures
    });
  } catch (error) {
    Logger.error('MaskedTiles.runMaskRefresh.crashed', {
      tileId: tile?.document?.id || tile?.id || null,
      reason,
      error: String(error?.message || error)
    });
  }
}

function scheduleMaskRefresh(tile, options = {}) {
  try {
    if (!tile || tile.destroyed || !hasMaskedPresentation(tile)) return;
    const reason = String(options?.reason || 'unknown');
    const followupDelay = Math.max(60, Number(options?.followupDelay) || 120);
    const state = getRefreshState(tile);
    if (!state) return;
    state.seq += 1;
    const seq = state.seq;
    cancelRefreshFollowups(tile);
    void runMaskRefresh(tile, `${reason}:sync`);
    if (typeof requestAnimationFrame === 'function') {
      state.raf = requestAnimationFrame(() => {
        state.raf = null;
        const current = REFRESH_STATE.get(tile);
        if (!current || current.seq !== seq || tile.destroyed) return;
        void runMaskRefresh(tile, `${reason}:raf`);
      });
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      const current = REFRESH_STATE.get(tile);
      if (!current || current.seq !== seq || tile.destroyed) return;
      void runMaskRefresh(tile, `${reason}:timeout`);
    }, isEditingTile(tile) ? 0 : followupDelay);
  } catch (_) {}
}

function refreshMaskedTilesForLayer(reason = 'activateCanvasLayer') {
  try {
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) scheduleMaskRefresh(tile, { reason });
    rehydrateAllMaskedTiles({ attempts: 3, interval: 120 });
  } catch (error) {
    Logger.error('MaskedTiles.refreshMaskedTilesForLayer.failed', {
      reason,
      error: String(error?.message || error)
    });
  }
}

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateAllMaskedTiles({ attempts: 6, interval: 250 }); } catch (_) {}
    try {
      for (const tile of Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : []) {
        try { applyTileHsbcToMesh(tile); } catch (_) {}
      }
    } catch (_) {}
  });
  Hooks.on('createTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) scheduleMaskRefresh(tile, { reason: 'createTile' });
    } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    scheduleMaskRefresh(tile, { reason: 'drawTile' });
  });
  Hooks.on('refreshTile', (tile) => {
    scheduleMaskRefresh(tile, { reason: 'refreshTile' });
  });
  Hooks.on('controlTile', (tile, controlled) => {
    scheduleMaskRefresh(tile, { reason: `controlTile:${controlled ? 'on' : 'off'}` });
  });
  Hooks.on('hoverTile', (tile, hovered) => {
    scheduleMaskRefresh(tile, { reason: `hoverTile:${hovered ? 'on' : 'off'}` });
  });
  Hooks.on('activateCanvasLayer', (layer) => {
    const layerName = layer?.options?.name || layer?.name || 'unknown';
    refreshMaskedTilesForLayer(`activateCanvasLayer:${layerName}`);
  });
  Hooks.on('updateTile', async (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        scheduleMaskRefresh(tile, { reason: 'updateTile' });
        rehydrateAllMaskedTiles({ attempts: 2, interval: 200 });
      }
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        cancelRefreshFollowups(tile);
        REFRESH_STATE.delete(tile);
        clearMaskedOverlaysOnDelete(tile);
      }
    } catch (_) {}
  });
  Hooks.on('canvasTearDown', () => {
    try {
      const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
      for (const tile of tiles) cancelRefreshFollowups(tile);
    } catch (_) {}
    try { cancelGlobalRehydrate(); } catch (_) {}
  });
} catch (_) {}
