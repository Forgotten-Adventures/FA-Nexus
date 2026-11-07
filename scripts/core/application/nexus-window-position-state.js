const MIN_EXPANDED_WIDTH = 320;
const MIN_EXPANDED_HEIGHT = 240;
const POSITION_KEYS = Object.freeze(['left', 'top', 'width', 'height']);

function copyFinitePosition(position = {}) {
  const result = {};
  for (const key of POSITION_KEYS) {
    const value = Number(position?.[key]);
    if (Number.isFinite(value)) result[key] = value;
  }
  return result;
}

export function isUsableExpandedNexusPosition(position) {
  return Number(position?.width) >= MIN_EXPANDED_WIDTH
    && Number(position?.height) >= MIN_EXPANDED_HEIGHT;
}

export function resolvePersistableNexusPosition(current, lastExpanded = null) {
  if (isUsableExpandedNexusPosition(current)) return copyFinitePosition(current);
  if (isUsableExpandedNexusPosition(lastExpanded)) return copyFinitePosition(lastExpanded);
  return null;
}

export function resolveRestorableNexusPosition(saved, fallback) {
  if (!isUsableExpandedNexusPosition(fallback)) {
    throw new TypeError('Nexus window position recovery requires a usable expanded fallback.');
  }
  if (isUsableExpandedNexusPosition(saved)) return copyFinitePosition(saved);
  const restored = copyFinitePosition(fallback);
  const savedCoordinates = copyFinitePosition(saved);
  if (Number.isFinite(savedCoordinates.left)) restored.left = savedCoordinates.left;
  if (Number.isFinite(savedCoordinates.top)) restored.top = savedCoordinates.top;
  return restored;
}
