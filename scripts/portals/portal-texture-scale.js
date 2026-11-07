export const DEFAULT_PORTAL_TEXTURE_GRID_SIZE = 200;
export const MIN_PORTAL_TEXTURE_WIDTH_SCALE = 0.1;
export const MAX_PORTAL_TEXTURE_WIDTH_SCALE = 3;

function positiveNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return numeric;
}

export function normalizePortalTextureWidthScale(
  value,
  {
    fallback = 1
  } = {}
) {
  if (value === undefined) {
    return positiveNumber(fallback, 'Portal texture width fallback');
  }
  return positiveNumber(value, 'Portal texture width scale');
}

export function resolvePortalTextureGridSize({
  widthScale = 1,
  baseTextureGridSize = DEFAULT_PORTAL_TEXTURE_GRID_SIZE
} = {}) {
  const scale = positiveNumber(widthScale, 'Portal texture width scale');
  const base = positiveNumber(baseTextureGridSize, 'Portal base texture grid size');
  return base / scale;
}

export function scalePortalTextureGridSize({
  textureGridSize = DEFAULT_PORTAL_TEXTURE_GRID_SIZE,
  factor
} = {}) {
  const current = positiveNumber(textureGridSize, 'Portal texture grid size');
  const scaleFactor = positiveNumber(factor, 'Portal Scene Group scale factor');
  return current / scaleFactor;
}

export function needsPortalTextureMeshRefresh(diff = {}) {
  if (!diff || typeof diff !== 'object') return false;
  const coreFlags = diff.flags?.core || {};
  const faFlags = diff.flags?.['fa-nexus'] || {};
  return Object.prototype.hasOwnProperty.call(diff, 'flags.core.textureGridSize')
    || Object.prototype.hasOwnProperty.call(diff, 'flags.core.-=textureGridSize')
    || Object.prototype.hasOwnProperty.call(coreFlags, '-=textureGridSize')
    || Object.prototype.hasOwnProperty.call(coreFlags, 'textureGridSize')
    || Object.prototype.hasOwnProperty.call(faFlags, 'buildingDoor')
    || Object.prototype.hasOwnProperty.call(faFlags, 'buildingWindow');
}
