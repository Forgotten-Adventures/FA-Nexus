import { FOUNDRY_OPERATOR_IDENTIFIER } from './document-operators.js';

const MODULE_ID = 'fa-nexus';

function hasOwn(object, key) {
  return !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && !hasOwn(value, FOUNDRY_OPERATOR_IDENTIFIER);
}

/**
 * Foundry's layer history keeps, for every field an update changed, the value it had before. A
 * field the update added has no earlier value and is left out, so Undo restores what changed and
 * keeps what was added: Ctrl+Z after switching a drop shadow on left the shadow on, and Ctrl+Z
 * after a Texture edit kept the mask fields that edit introduced. Foundry closes that gap for a
 * whole flag scope by storing a deletion in the history entry. This does the same inside the FA
 * Nexus scope of a Tile: every field the applied update added is marked for deletion in the
 * entry that undoes it. A field an Undo does not state is one the update left alone.
 */
export function markAddedFieldsForUndo(original, applied, createDeletion) {
  let marked = 0;
  for (const [key, value] of Object.entries(applied || {})) {
    if (key.startsWith('-=') || key.startsWith('==')) continue;
    if (!hasOwn(original, key)) {
      original[key] = createDeletion();
      marked += 1;
    } else if (isPlainObject(value) && isPlainObject(original[key])) {
      marked += markAddedFieldsForUndo(original[key], value, createDeletion);
    }
  }
  return marked;
}

// The entry Foundry stored for an update is the newest one naming the Tile that was pushed after
// the update's own pre-update step.
const historyTopBeforeUpdate = new Map();

function rememberHistoryTop(tile, changes, options = {}) {
  if (options?.isUndo === true || !tile?.uuid) return;
  const history = globalThis.canvas?.tiles?.history;
  if (Array.isArray(history)) historyTopBeforeUpdate.set(tile.uuid, history.at(-1) ?? null);
}

function completeUndoEntry(tile, applied, options = {}, userId = null) {
  const uuid = tile?.uuid;
  if (!uuid || !historyTopBeforeUpdate.has(uuid)) return;
  const top = historyTopBeforeUpdate.get(uuid);
  historyTopBeforeUpdate.delete(uuid);
  if (options?.isUndo === true || userId !== globalThis.game?.user?.id) return;
  const appliedFlags = applied?.flags?.[MODULE_ID];
  if (!isPlainObject(appliedFlags)) return;
  const history = globalThis.canvas?.tiles?.history;
  if (!Array.isArray(history) || tile.parent !== globalThis.canvas?.scene) return;
  const ForcedDeletion = globalThis.foundry?.data?.operators?.ForcedDeletion;
  if (typeof ForcedDeletion !== 'function') {
    throw new Error('Foundry ForcedDeletion is unavailable for exact FA Nexus Tile Undo.');
  }
  const oldest = top ? history.lastIndexOf(top) + 1 : 0;
  for (let index = history.length - 1; index >= oldest; index -= 1) {
    const entry = history[index];
    if (entry?.type !== 'update' || !Array.isArray(entry.data)) continue;
    const original = entry.data.find((data) => data?._id === tile.id);
    if (!original) continue;
    // A scope the update created is already stored as one deletion by Foundry.
    const originalFlags = original.flags?.[MODULE_ID];
    if (isPlainObject(originalFlags)) markAddedFieldsForUndo(originalFlags, appliedFlags, () => new ForcedDeletion());
    return;
  }
}

if (globalThis.Hooks?.on) {
  Hooks.on('preUpdateTile', rememberHistoryTop);
  Hooks.on('updateTile', completeUndoEntry);
}
