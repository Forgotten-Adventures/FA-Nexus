import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { applyTileHsbcToMesh } from './texture-blend-runtime.js';
import { ensureMeshTransparent } from './texture-runtime-core.js';
import {
  applyMaskedTilingToTile,
  applyStandardTileMaskToTile,
  rehydrateAllMaskedTiles,
  rehydrateAllStandardTileMasks,
  cancelGlobalRehydrate,
  clearMaskedOverlaysOnDelete
} from './texture-mask-runtime.js';

export { rehydrateAllMaskedTiles, rehydrateAllStandardTileMasks };

const EDITING_TILE_SET_KEY = '__faNexusTextureEditingTileIds';
const REFRESH_STATE = new WeakMap();
const PATCHED_TILE_DRAW_SYMBOL = Symbol.for('fa-nexus.maskedTiles.tileDrawPrehidePatched');
const ORIGINAL_TILE_DRAW_KEY = '_faNexusOriginalMaskedTileDraw';
const MASKED_TILING_ORIGINAL_TEXTURE_KEY = 'faNexusMaskedTilingOriginalTexture';
const STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY = 'faNexusStandardMaskOriginalTexture';

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
      timers: [],
      timer: null,
      lastSignature: null
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
    if (Array.isArray(state.timers)) {
      for (const timer of state.timers) {
        try { clearTimeout(timer); } catch (_) {}
      }
      state.timers.length = 0;
    } else if (state.timer !== null) {
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

function hasAnyMaskTarget(targets) {
  return !!(targets?.shouldRunMaskedTiling || targets?.shouldRunStandardTileMask);
}

function hasOwn(object, key) {
  return !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

function hasFaNexusFlagChange(changes, flagKey) {
  try {
    if (!changes || typeof changes !== 'object') return false;
    if (hasOwn(changes, `flags.fa-nexus.${flagKey}`)) return true;
    if (hasOwn(changes, `flags.fa-nexus.-=${flagKey}`)) return true;
    const flatModuleFlags = changes['flags.fa-nexus'];
    if (flatModuleFlags && typeof flatModuleFlags === 'object') {
      if (hasOwn(flatModuleFlags, flagKey) || hasOwn(flatModuleFlags, `-=${flagKey}`)) return true;
    }
    const flags = changes.flags;
    if (!flags || typeof flags !== 'object') return false;
    if (hasOwn(flags, `fa-nexus.${flagKey}`)) return true;
    if (hasOwn(flags, `fa-nexus.-=${flagKey}`)) return true;
    const moduleFlags = flags['fa-nexus'];
    if (!moduleFlags || typeof moduleFlags !== 'object') return false;
    return hasOwn(moduleFlags, flagKey) || hasOwn(moduleFlags, `-=${flagKey}`);
  } catch (_) {
    return false;
  }
}

function documentHasMaskFlags(doc) {
  try {
    if (!doc) return false;
    if (doc.getFlag?.('fa-nexus', 'maskedTiling')) return true;
    if (doc.getFlag?.('fa-nexus', 'standardTileMask')) return true;
    const flags = doc.flags?.['fa-nexus'] || doc._source?.flags?.['fa-nexus'] || null;
    return !!(flags?.maskedTiling || flags?.standardTileMask);
  } catch (_) {
    return false;
  }
}

function prehideMaskedTileMesh(tile, reason = 'unknown') {
  try {
    if (!tile || tile.destroyed || !documentHasMaskFlags(tile.document)) return;
    const mesh = tile.mesh || null;
    if (!mesh || mesh.destroyed) return;
    const hasMaskedTiling = !!tile.document?.getFlag?.('fa-nexus', 'maskedTiling');
    const hasStandardTileMask = !!tile.document?.getFlag?.('fa-nexus', 'standardTileMask');
    if (hasMaskedTiling) ensureMeshTransparent(mesh, MASKED_TILING_ORIGINAL_TEXTURE_KEY);
    if (hasStandardTileMask) ensureMeshTransparent(mesh, STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY);
    try {
      mesh.faNexusMaskPrehidden = {
        reason,
        at: Date.now()
      };
    } catch (_) {}
  } catch (error) {
    Logger.error?.('MaskedTiles.prehideMaskedTileMesh.failed', {
      tileId: tile?.document?.id || tile?.id || null,
      reason,
      error: String(error?.message || error)
    });
  }
}

function resolveTilePrototype() {
  try {
    const configured = globalThis?.CONFIG?.Tile?.objectClass?.prototype;
    if (configured?._draw) return configured;
  } catch (_) {}
  try {
    const currentTile = globalThis?.canvas?.tiles?.placeables?.find?.((tile) => tile?._draw);
    const proto = currentTile ? Object.getPrototypeOf(currentTile) : null;
    if (proto?._draw) return proto;
  } catch (_) {}
  return null;
}

function installMaskedTileDrawPrehidePatch() {
  try {
    const prototype = resolveTilePrototype();
    if (!prototype || typeof prototype._draw !== 'function') return false;
    if (prototype[PATCHED_TILE_DRAW_SYMBOL]) return true;

    const originalDraw = prototype._draw;
    prototype[ORIGINAL_TILE_DRAW_KEY] = originalDraw;
    prototype._draw = async function faNexusMaskedTileDrawWithPrehide(options = {}) {
      const result = await originalDraw.call(this, options);
      prehideMaskedTileMesh(this, 'tile-draw');
      return result;
    };
    prototype[PATCHED_TILE_DRAW_SYMBOL] = true;
    Logger.debug?.('MaskedTiles.tileDrawPrehidePatch.installed');
    return true;
  } catch (error) {
    Logger.error?.('MaskedTiles.tileDrawPrehidePatch.failed', {
      error: String(error?.message || error)
    });
    return false;
  }
}

function isMaskRenderRelevantTileUpdate(changes) {
  try {
    if (!changes || typeof changes !== 'object') return false;
    if (hasFaNexusFlagChange(changes, 'maskedTiling')) return true;
    if (hasFaNexusFlagChange(changes, 'standardTileMask')) return true;
    if (hasFaNexusFlagChange(changes, 'hsbc')) return true;
    return [
      'texture',
      'width',
      'height',
      'x',
      'y',
      'rotation',
      'alpha',
      'elevation',
      'sort',
      'hidden',
      'occlusion'
    ].some((key) => hasOwn(changes, key));
  } catch (_) {
    return false;
  }
}

function normalizeFollowupDelays(options, defaultDelay) {
  const raw = Array.isArray(options?.followupDelays) && options.followupDelays.length
    ? options.followupDelays
    : [defaultDelay];
  const delays = [];
  for (const value of raw) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    const delay = Math.max(20, numeric);
    if (!delays.includes(delay)) delays.push(delay);
  }
  if (!delays.length) delays.push(defaultDelay);
  return delays.sort((a, b) => a - b);
}

function maskTargetsReady(tile, targets) {
  try {
    if (!hasAnyMaskTarget(targets)) return true;
    const mesh = tile?.mesh || null;
    if (targets.shouldRunMaskedTiling) {
      const container = mesh?.faNexusMaskContainer || tile?.faNexusMaskContainer || null;
      if (!container || container.destroyed || !mesh?.faNexusMaskReady) return false;
    }
    if (targets.shouldRunStandardTileMask) {
      const container = mesh?.faNexusStandardMaskContainer || tile?.faNexusStandardMaskContainer || null;
      if (!container || container.destroyed || !mesh?.faNexusStandardMaskReady) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function buildMaskRefreshSignature(tile, targets) {
  try {
    const doc = tile?.document || null;
    const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'] || null;
    return JSON.stringify({
      textureSrc: doc?.texture?.src || null,
      width: Number(doc?.width) || 0,
      height: Number(doc?.height) || 0,
      anchorX: Number.isFinite(Number(doc?.texture?.anchorX)) ? Number(doc.texture.anchorX) : 0.5,
      anchorY: Number.isFinite(Number(doc?.texture?.anchorY)) ? Number(doc.texture.anchorY) : 0.5,
      alpha: Number.isFinite(Number(doc?.alpha)) ? Number(doc.alpha) : 1,
      hidden: !!doc?.hidden,
      hsbc: flags?.hsbc || null,
      maskedTiling: targets?.shouldRunMaskedTiling ? (flags?.maskedTiling || null) : null,
      standardTileMask: targets?.shouldRunStandardTileMask ? (flags?.standardTileMask || null) : null
    });
  } catch (error) {
    Logger.error('MaskedTiles.refreshSignature.failed', {
      tileId: tile?.document?.id || tile?.id || null,
      error: String(error?.message || error)
    });
    return null;
  }
}

async function runMaskRefresh(tile, reason = 'unknown') {
  try {
    if (!tile || tile.destroyed || !tile.document) return true;
    if (!tile.isPreview && !tile.document?.scene) return true;
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
    if (!failures.length) return true;
    Logger.error('MaskedTiles.runMaskRefresh.failed', {
      tileId: tile?.document?.id || tile?.id || null,
      reason,
      failures
    });
    return false;
  } catch (error) {
    Logger.error('MaskedTiles.runMaskRefresh.crashed', {
      tileId: tile?.document?.id || tile?.id || null,
      reason,
      error: String(error?.message || error)
    });
    return false;
  }
  return true;
}

function scheduleMaskRefresh(tile, options = {}) {
  try {
    if (!tile || tile.destroyed || !hasMaskedPresentation(tile)) return;
    const reason = String(options?.reason || 'unknown');
    const followupDelay = Math.max(60, Number(options?.followupDelay) || 120);
    const followupDelays = normalizeFollowupDelays(options, followupDelay);
    const forceFollowups = !!options?.forceFollowups;
    const state = getRefreshState(tile);
    if (!state) return;
    const targets = getMaskRefreshTargets(tile);
    const signature = buildMaskRefreshSignature(tile, targets);
    const interactiveOnly = reason.startsWith('controlTile:') || reason.startsWith('hoverTile:');
    if (
      interactiveOnly
      && !isEditingTile(tile)
      && signature
      && state.lastSignature === signature
      && maskTargetsReady(tile, targets)
    ) return;
    state.seq += 1;
    const seq = state.seq;
    cancelRefreshFollowups(tile);

    const scheduleFollowups = (force = false) => {
      const current = REFRESH_STATE.get(tile);
      if (!current || current.seq !== seq || tile.destroyed) return;
      const latestTargets = getMaskRefreshTargets(tile);
      if (!hasAnyMaskTarget(latestTargets)) return;
      if (!force && !isEditingTile(tile) && maskTargetsReady(tile, latestTargets)) return;
      if (typeof requestAnimationFrame === 'function') {
        current.raf = requestAnimationFrame(() => {
          current.raf = null;
          const latest = REFRESH_STATE.get(tile);
          if (!latest || latest.seq !== seq || tile.destroyed) return;
          void Promise.resolve(runMaskRefresh(tile, `${reason}:raf`)).then((success) => {
            if (success) latest.lastSignature = buildMaskRefreshSignature(tile, getMaskRefreshTargets(tile));
          });
        });
      }
      const delays = isEditingTile(tile) ? [0] : followupDelays;
      if (!Array.isArray(current.timers)) current.timers = [];
      for (const delay of delays) {
        const timer = setTimeout(() => {
          const latest = REFRESH_STATE.get(tile);
          if (latest?.timers) latest.timers = latest.timers.filter((entry) => entry !== timer);
          if (latest?.timer === timer) latest.timer = latest.timers?.[latest.timers.length - 1] ?? null;
          if (!latest || latest.seq !== seq || tile.destroyed) return;
          void Promise.resolve(runMaskRefresh(tile, `${reason}:timeout:${delay}`)).then((success) => {
            if (success) latest.lastSignature = buildMaskRefreshSignature(tile, getMaskRefreshTargets(tile));
          });
        }, delay);
        current.timers.push(timer);
        current.timer = timer;
      }
    };

    void Promise.resolve(runMaskRefresh(tile, `${reason}:sync`)).then((success) => {
      const current = REFRESH_STATE.get(tile);
      if (!current || current.seq !== seq || tile.destroyed) return;
      if (success) current.lastSignature = buildMaskRefreshSignature(tile, getMaskRefreshTargets(tile));
      scheduleFollowups(forceFollowups || !success);
    });
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
  installMaskedTileDrawPrehidePatch();
  Hooks.on('canvasReady', () => {
    try { installMaskedTileDrawPrehidePatch(); } catch (_) {}
    try { rehydrateAllMaskedTiles({ attempts: 6, interval: 250 }); } catch (_) {}
    try {
      for (const tile of Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : []) {
        try { applyTileHsbcToMesh(tile); } catch (_) {}
      }
    } catch (_) {}
  });
  Hooks.once('ready', () => {
    if (!installMaskedTileDrawPrehidePatch()) {
      Logger.error?.('MaskedTiles.tileDrawPrehidePatch.unavailable', {
        reason: 'Tile.prototype._draw missing during ready'
      });
    }
  });
  Hooks.on('createTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        scheduleMaskRefresh(tile, {
          reason: 'createTile',
          forceFollowups: documentHasMaskFlags(doc),
          followupDelays: [80, 250, 700]
        });
      }
      if (documentHasMaskFlags(doc)) {
        rehydrateAllMaskedTiles({ attempts: 4, interval: 250 });
      }
    } catch (error) {
      Logger.error('MaskedTiles.createTile.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
    }
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
  Hooks.on('updateTile', async (doc, changes = {}) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        const forceFollowups = isMaskRenderRelevantTileUpdate(changes);
        if (forceFollowups) {
          Logger.debug?.('MaskedTiles.updateTile.forceFollowups', {
            tileId: doc?.id || null,
            changeKeys: changes && typeof changes === 'object' ? Object.keys(changes) : []
          });
        }
        scheduleMaskRefresh(tile, {
          reason: 'updateTile',
          forceFollowups,
          followupDelays: forceFollowups ? [80, 250, 700] : undefined
        });
        rehydrateAllMaskedTiles({
          attempts: forceFollowups ? 4 : 2,
          interval: forceFollowups ? 250 : 200
        });
      } else if (documentHasMaskFlags(doc)) {
        rehydrateAllMaskedTiles({ attempts: 4, interval: 250 });
      }
    } catch (error) {
      Logger.error('MaskedTiles.updateTile.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
    }
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
