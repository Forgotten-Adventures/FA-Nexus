// The words Flatten, Deconstruct and Export use in what the user reads (designs D1 and D3). A "layer" is a row of the
// Layer Manager; a "picture" is what Flatten makes. Not used in messages: section, band, tile, wrapper, composition.

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "Flattened 14 layers into 2 pictures." / "Flattened 31 layers on 3 Levels into 6 pictures." */
export function flattenedClause({ layers = 0, pictures = 0, levels = 1 } = {}) {
  return `Flattened ${count(layers, 'layer', 'layers')}${levels > 1 ? ` on ${levels} Levels` : ''} into ${count(pictures, 'picture', 'pictures')}.`;
}

/** "1 hidden layer was left as it is." / "3 hidden layers were left as they are."; empty for none. */
export function hiddenLeftOutClause(n = 0) {
  if (!(n > 0)) return '';
  return n === 1 ? '1 hidden layer was left as it is.' : `${n} hidden layers were left as they are.`;
}

/** "Restored 14 layers." */
export function restoredClause(n = 0) {
  return `Restored ${count(n, 'layer', 'layers')}.`;
}

/** "3 pictures saved to <folder>." */
export function exportedClause(n = 0, folder = '') {
  return `${count(n, 'picture', 'pictures')} saved${folder ? ` to ${folder}` : ''}.`;
}

export const GAMEPLAY_KEEPS_WORKING = 'Walls, doors and Regions keep working.';

export function joinMessage(...parts) {
  return parts.filter(Boolean).join(' ');
}
