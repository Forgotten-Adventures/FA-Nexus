export {
  resolveTileDocument,
  resolveTileId,
  resolveTilePlaceable
} from '../../canvas/tile-targets.js';

export function getSharedEditingTileSet(key) {
  try {
    const root = globalThis || window;
    if (!root) return null;
    let set = root[key];
    if (!(set instanceof Set)) {
      set = new Set();
      root[key] = set;
    }
    return set;
  } catch (_) {
    return null;
  }
}
