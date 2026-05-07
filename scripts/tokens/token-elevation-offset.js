import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  applyGroundBandToAllTiles,
  applyGroundBandToTile,
  restoreGroundBandFromAllTiles
} from '../canvas/ground-band-converter.js';

// --- Optional: preserve tile elevation when moving via keyboard ---------------
// Foundry v13 floors placeable elevation during keyboard movement to the grid distance,
// which destroys micro-elevations (e.g. 0.50 -> 0.00) when nudging tiles with WASD.
// We restore the current tile document elevation when dz == 0.

const PLACEABLE_SHIFTED_POS_PATCH = Symbol.for('fa-nexus.PlaceableObject.getShiftedPosition.patched');

function logTokenElevationOffsetFailure(action, error, context = {}) {
  Logger.warn(`TokenElevationOffset.${action}.failed`, {
    ...context,
    error: String(error?.message || error)
  });
}

function patchTileKeyboardMoveElevation() {
  try {
    const PlaceableObject = foundry?.canvas?.placeables?.PlaceableObject ?? globalThis?.PlaceableObject;
    const TileClass = foundry?.canvas?.placeables?.Tile ?? null;
    if (!PlaceableObject?.prototype || PlaceableObject.prototype[PLACEABLE_SHIFTED_POS_PATCH]) return;
    const original = PlaceableObject.prototype._getShiftedPosition;
    if (typeof original !== 'function') return;

    PlaceableObject.prototype._getShiftedPosition = function faNexusGetShiftedPosition(dx, dy, dz) {
      const result = original.call(this, dx, dy, dz);
      try {
        if (dz) return result;
        if (TileClass && !(this instanceof TileClass)) return result;
        const currentElevation = Number(this?.document?.elevation);
        if (Number.isFinite(currentElevation)) result.elevation = currentElevation;
      } catch (error) {
        logTokenElevationOffsetFailure('keyboardMoveRestore', error, {
          documentId: this?.document?.id || null
        });
      }
      return result;
    };
    PlaceableObject.prototype[PLACEABLE_SHIFTED_POS_PATCH] = true;
    Logger.info('TileKeyboardMoveElevation.patched');
  } catch (error) {
    Logger.warn('TileKeyboardMoveElevation.patchFailed', String(error?.message || error));
  }
}

// --- Hook wiring --------------------------------------------------------------

try {
  Hooks.on('refreshTile', (tile) => applyGroundBandToTile(tile, { reason: 'refresh' }));
  Hooks.on('drawTile', (tile) => applyGroundBandToTile(tile, { reason: 'draw', force: true }));
  Hooks.on('canvasReady', () => {
    applyGroundBandToAllTiles('canvasReady', { force: true });
  });
  Hooks.on('updateScene', (scene, updates) => {
    try {
      if (!scene || scene.id !== canvas?.scene?.id) return;
      const levelPayloadChanged = Array.isArray(updates?.levels);
      const initialLevelChanged = updates?.initialLevel !== undefined;
      if (!levelPayloadChanged && !initialLevelChanged) return;
      applyGroundBandToAllTiles('updateScene', { force: true });
    } catch (error) {
      logTokenElevationOffsetFailure('updateScene', error, { sceneId: scene?.id || null });
    }
  });
  Hooks.on('createLevel', (level) => {
    try {
      if (level?.parent?.id !== canvas?.scene?.id) return;
      applyGroundBandToAllTiles('createLevel', { force: true });
    } catch (error) {
      logTokenElevationOffsetFailure('createLevel', error, { levelId: level?.id || null });
    }
  });
  Hooks.on('updateLevel', (level) => {
    try {
      if (level?.parent?.id !== canvas?.scene?.id) return;
      applyGroundBandToAllTiles('updateLevel', { force: true });
    } catch (error) {
      logTokenElevationOffsetFailure('updateLevel', error, { levelId: level?.id || null });
    }
  });
  Hooks.on('deleteLevel', (level) => {
    try {
      if (level?.parent?.id !== canvas?.scene?.id) return;
      applyGroundBandToAllTiles('deleteLevel', { force: true });
    } catch (error) {
      logTokenElevationOffsetFailure('deleteLevel', error, { levelId: level?.id || null });
    }
  });
  Hooks.on('updateTile', (...args) => {
    try {
      const doc = (args?.[0]?.documentName === 'Tile') ? args[0] : args[1];
      if (!doc?.id) return;
      const tile = canvas?.tiles?.get?.(doc.id);
      if (tile) applyGroundBandToTile(tile, { reason: 'update', force: true });
    } catch (error) {
      logTokenElevationOffsetFailure('updateTile', error);
    }
  });
  Hooks.on('fa-nexus-token-elevation-offset-changed', ({ enabled }) => {
    try {
      if (enabled) {
        applyGroundBandToAllTiles('setting-enabled', { force: true });
      } else {
        restoreGroundBandFromAllTiles('setting-disabled');
      }
    } catch (error) {
      logTokenElevationOffsetFailure('settingChanged', error, { enabled: !!enabled });
    }
  });

  Hooks.once('ready', () => {
    try {
      patchTileKeyboardMoveElevation();
      // Apply once on initial ready if the canvas is already up.
      if (canvas?.ready) {
        applyGroundBandToAllTiles('ready', { force: true });
      }
    } catch (error) {
      logTokenElevationOffsetFailure('ready', error);
    }
  });
} catch (error) {
  Logger.warn('TokenElevationOffset.init.failed', { error: String(error?.message || error) });
}
