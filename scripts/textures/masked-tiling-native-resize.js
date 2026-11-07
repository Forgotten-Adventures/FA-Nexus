import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  deriveMaskedTilingResizeCommit,
  mergeMaskedTilingRepeatTransform
} from './masked-tiling-resize-contract.js';
import { FOUNDRY_OPERATOR_IDENTIFIER } from '../canvas/document-operators.js';

const MODULE_ID = 'fa-nexus';
const FLAG_KEY = 'maskedTiling';

function hasOwn(object, key) {
  return !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

function readMaskedTiling(document) {
  if (typeof document?.getFlag === 'function') return document.getFlag(MODULE_ID, FLAG_KEY);
  return document?.flags?.[MODULE_ID]?.[FLAG_KEY]
    ?? document?._source?.flags?.[MODULE_ID]?.[FLAG_KEY]
    ?? null;
}

// Only PLAIN DATA can be merged. Foundry v14 reconstructs a `DataFieldOperator` from its wire form
// while it cleans an incoming change set, so a change value reaching this hook can be a live class
// instance whose object graph reaches the Window — cloning it throws, and the thrown clone used to
// cancel the whole update. An operator value is also authoritative by definition ("this subtree is
// exactly this"), so there is nothing here to merge into it either way.
function isPlainMaskedTilingData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return !Object.hasOwn(value, FOUNDRY_OPERATOR_IDENTIFIER);
}

// The same holds for an operator nested anywhere inside the change. Scene Group Undo states a
// field its command introduced (a first `maskWorld.tile.rotation`, say) as a nested
// ForcedReplacement or ForcedDeletion. Merged like plain data, the replacement keeps the field
// it was meant to remove and a deletion is stored as an empty object, after which earlier
// commands no longer match the Tile and cannot be undone.
function containsMaskedTilingOperator(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsMaskedTilingOperator);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return true;
  if (Object.hasOwn(value, FOUNDRY_OPERATOR_IDENTIFIER)) return true;
  return Object.values(value).some(containsMaskedTilingOperator);
}

function readMaskedTilingChange(changes) {
  const flatKey = `flags.${MODULE_ID}.${FLAG_KEY}`;
  if (hasOwn(changes, flatKey)) return { present: true, value: changes[flatKey] };
  const moduleFlags = changes?.flags?.[MODULE_ID];
  if (hasOwn(moduleFlags, FLAG_KEY)) return { present: true, value: moduleFlags[FLAG_KEY] };
  if (hasOwn(moduleFlags, `-=${FLAG_KEY}`)) return { present: true, value: null, deleted: true };
  return { present: false, value: null };
}

function writeMaskedTilingChange(changes, value) {
  const flatKey = `flags.${MODULE_ID}.${FLAG_KEY}`;
  if (hasOwn(changes, flatKey)) {
    changes[flatKey] = value;
    return;
  }
  const setProperty = globalThis.foundry?.utils?.setProperty;
  if (typeof setProperty === 'function') {
    setProperty(changes, `flags.${MODULE_ID}.${FLAG_KEY}`, value);
    return;
  }
  changes.flags ||= {};
  changes.flags[MODULE_ID] ||= {};
  changes.flags[MODULE_ID][FLAG_KEY] = value;
}

function mergeUndoState(current, previous) {
  const restored = structuredClone(current);
  const merge = (target, source) => {
    for (const [key, value] of Object.entries(source || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const child = target[key];
        target[key] = child && typeof child === 'object' && !Array.isArray(child)
          ? child
          : {};
        merge(target[key], value);
      } else {
        target[key] = structuredClone(value);
      }
    }
    return target;
  };
  merge(restored, previous);
  // Fields the undone update added are stated as deletions by its history entry
  // (canvas/tile-flag-undo-history.js); a field missing here is one the update left alone.
  return restored;
}

function tileSnapshot(document) {
  const source = document?._source || document || {};
  return {
    x: Number(source.x ?? document?.x),
    y: Number(source.y ?? document?.y),
    width: Number(source.width ?? document?.width),
    height: Number(source.height ?? document?.height),
    rotation: Number(source.rotation ?? document?.rotation ?? 0),
    texture: {
      anchorX: Number(source.texture?.anchorX ?? document?.texture?.anchorX ?? 0.5),
      anchorY: Number(source.texture?.anchorY ?? document?.texture?.anchorY ?? 0.5)
    }
  };
}

function finalTileSnapshot(original, changes) {
  const texture = changes?.texture || {};
  return {
    x: hasOwn(changes, 'x') ? Number(changes.x) : original.x,
    y: hasOwn(changes, 'y') ? Number(changes.y) : original.y,
    width: hasOwn(changes, 'width') ? Number(changes.width) : original.width,
    height: hasOwn(changes, 'height') ? Number(changes.height) : original.height,
    rotation: hasOwn(changes, 'rotation') ? Number(changes.rotation) : original.rotation,
    texture: {
      anchorX: hasOwn(texture, 'anchorX') ? Number(texture.anchorX) : original.texture.anchorX,
      anchorY: hasOwn(texture, 'anchorY') ? Number(texture.anchorY) : original.texture.anchorY
    }
  };
}

export function applyMaskedTilingResizeToChanges(document, changes = {}, options = {}) {
  if (!document || !changes || typeof changes !== 'object') return { changed: false, reason: 'invalid-input' };
  // A Building Edit transaction OWNS the mask state of the documents it generates, and states it
  // exactly. This integration is a second writer to that state: amending or vetoing a Building
  // write mid-transaction makes the committed document disagree with the plan, which the commit
  // then correctly detects as a mismatch and rolls back. So it is inert for Building-owned writes.
  const generated = document?.getFlag?.('fa-nexus', 'buildingGenerated')
    ?? document?._source?.flags?.['fa-nexus']?.buildingGenerated;
  const backlink = document?.getFlag?.('fa-nexus', 'buildingFill')
    ?? document?._source?.flags?.['fa-nexus']?.buildingFill;
  const managedBuildingFill = generated?.role === 'fill'
    && String(generated?.rootTileId || '').trim()
    && String(backlink?.wallTileId || '').trim() === String(generated.rootTileId);
  const buildingAggregateWrite = managedBuildingFill && (
    options?.faNexusBuildingNativeTransform === true
    || options?.faNexusSceneGroupCommand === true
    || options?.faNexusBuildingEditorDocumentWrite === true
  );
  if (options?.faNexusBuildingCurrentEdit === true || buildingAggregateWrite) {
    return { changed: false, reason: 'building-owned-write' };
  }
  const current = readMaskedTiling(document);
  if (!current || typeof current !== 'object') return { changed: false, reason: 'not-masked-tiling' };

  const explicit = readMaskedTilingChange(changes);
  if (explicit.present) {
    if (explicit.deleted || !explicit.value || typeof explicit.value !== 'object') {
      return { changed: false, reason: 'explicit-removal' };
    }
    // An operator or any other live value states the mask subtree exactly; it is never merged into.
    if (!isPlainMaskedTilingData(explicit.value) || containsMaskedTilingOperator(explicit.value)) {
      return { changed: false, reason: 'authoritative-masked-tiling-operator' };
    }
    if (options?.isUndo === true) {
      const restored = mergeUndoState(current, explicit.value);
      writeMaskedTilingChange(changes, restored);
      return {
        changed: true,
        reason: 'authoritative-undo',
        maskedTiling: restored
      };
    }
    const merged = mergeMaskedTilingRepeatTransform(current, explicit.value);
    if (merged?.textureRepeatTransform && !explicit.value?.textureRepeatTransform) {
      writeMaskedTilingChange(changes, merged);
      return { changed: true, reason: 'preserved-editor-repeat-transform', maskedTiling: merged };
    }
    return { changed: false, reason: 'explicit-masked-tiling-update' };
  }

  const originalTile = tileSnapshot(document);
  const finalTile = finalTileSnapshot(originalTile, changes);
  if (originalTile.width === finalTile.width && originalTile.height === finalTile.height) {
    return { changed: false, reason: 'dimensions-unchanged' };
  }

  const maskedTiling = deriveMaskedTilingResizeCommit({
    maskedTiling: current,
    originalTile,
    finalTile
  });
  writeMaskedTilingChange(changes, maskedTiling);
  return {
    changed: true,
    reason: 'native-resize',
    tileId: String(document?.id || ''),
    originalTile,
    finalTile,
    maskedTiling
  };
}

export function registerMaskedTilingNativeResizeHooks() {
  if (!globalThis.Hooks?.on) {
    throw new Error('Foundry Hooks are unavailable for masked tiling native resize integration.');
  }
  Hooks.on('preUpdateTile', (document, changes, options) => {
    try {
      const result = applyMaskedTilingResizeToChanges(document, changes, options);
      if (result.changed && result.reason === 'native-resize') {
        Logger.debug('MaskedTiling.nativeResize.planned', {
          tileId: result.tileId,
          original: result.originalTile,
          final: result.finalTile
        });
      }
      return true;
    } catch (error) {
      const details = {
        tileId: String(document?.id || ''),
        changeKeys: Object.keys(changes || {}),
        error: String(error?.message || error)
      };
      Logger.error('MaskedTiling.nativeResize.failed', details);
      globalThis.ui?.notifications?.error?.(
        `Masked Texture resize was cancelled because its repeat transform could not be preserved: ${details.error}`
      );
      return false;
    }
  });
}

if (globalThis.Hooks?.on) registerMaskedTilingNativeResizeHooks();
