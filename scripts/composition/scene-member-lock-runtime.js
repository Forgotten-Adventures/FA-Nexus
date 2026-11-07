import { isSceneMemberLocked } from './scene-member-lock-state.js';

const MARKER = Symbol.for('fa-nexus.scene-member-lock');
export function initializeSceneMemberLocks() {
  for (const type of ['Tile', 'Wall', 'AmbientLight', 'AmbientSound', 'Region']) {
    const prototype = CONFIG[type]?.objectClass?.prototype;
    if (!prototype || typeof prototype._canDrag !== 'function') throw new Error(`Missing ${type} drag permission contract.`);
    if (Object.hasOwn(prototype, MARKER)) continue;
    const original = prototype._canDrag;
    prototype._canDrag = function(...args) {
      return !isSceneMemberLocked(this.document) && original.apply(this, args);
    };
    Object.defineProperty(prototype, MARKER, { value: true });
  }
  const prototype = foundry.canvas.layers.PlaceablesLayer.prototype;
  if (Object.hasOwn(prototype, MARKER)) return;
  const original = prototype._getMovableObjects;
  if (typeof original !== 'function') throw new Error('Missing Foundry movable-object contract.');
  prototype._getMovableObjects = function(ids, includeLocked = false) {
    const objects = original.call(this, ids, includeLocked);
    return includeLocked ? objects : objects.filter(object => !isSceneMemberLocked(object.document));
  };
  Object.defineProperty(prototype, MARKER, { value: true });
}
