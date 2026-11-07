// Pure Path resize contract, shared by native Tiles and flattened restoration data.
export function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone !== 'function') {
    throw new Error('Native Path transforms require structuredClone.');
  }
  return structuredClone(value);
}

export function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function roundTransformNumber(value, places = 9) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function validateTileGeometry(tile, label) {
  if (['x', 'y', 'width', 'height'].some((field) => finite(tile?.[field]) == null)) {
    throw new Error(`Native Path transform requires finite ${label} Tile geometry.`);
  }
  if (!(tile.width > 0) || !(tile.height > 0)) {
    throw new Error(`Native Path transform requires positive ${label} Tile dimensions.`);
  }
}

function scaled(value, factor) {
  const numeric = finite(value);
  return numeric == null ? value : roundTransformNumber(numeric * factor);
}

function scalePoint(point, scaleX, scaleY) {
  if (!point || typeof point !== 'object') return clone(point);
  const next = clone(point);
  if (finite(point.x) != null) next.x = scaled(point.x, scaleX);
  if (finite(point.y) != null) next.y = scaled(point.y, scaleY);
  return next;
}

function scalarResizeFactor(scaleX, scaleY) {
  const average = (Math.abs(scaleX) + Math.abs(scaleY)) / 2;
  const tolerance = Math.max(0.002, average * 0.002);
  if (Math.abs(Math.abs(scaleX) - Math.abs(scaleY)) <= tolerance) return average;
  return Math.sqrt(Math.abs(scaleX * scaleY));
}

function resizePathShadow(shadow, scaleX, scaleY, scalarFactor) {
  if (!shadow || typeof shadow !== 'object') return clone(shadow);
  const next = clone(shadow);
  for (const field of ['blur', 'dilation', 'offset']) {
    if (finite(shadow[field]) != null) next[field] = scaled(shadow[field], scalarFactor);
  }
  if (Array.isArray(shadow.points)) {
    next.points = shadow.points.map((point) => {
      const resized = scalePoint(point, scaleX, scaleY);
      if (finite(point?.offset) != null) resized.offset = scaled(point.offset, scalarFactor);
      return resized;
    });
  }
  return next;
}

export function resizePathEntry(entry, scaleX, scaleY) {
  if (!entry || typeof entry !== 'object') return clone(entry);
  if (![scaleX, scaleY].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Native Path resize requires positive finite x and y scale factors.');
  }
  const scalarFactor = scalarResizeFactor(scaleX, scaleY);
  const next = clone(entry);
  if (Array.isArray(entry.controlPoints)) {
    next.controlPoints = entry.controlPoints.map((point) => scalePoint(point, scaleX, scaleY));
  }
  for (const field of ['width', 'repeatSpacing']) {
    if (finite(entry[field]) != null) next[field] = scaled(entry[field], scalarFactor);
  }
  if (entry.textureOffset && typeof entry.textureOffset === 'object') {
    next.textureOffset = scalePoint(entry.textureOffset, scaleX, scaleY);
  }
  for (const field of ['feather', 'opacityFeather']) {
    if (!entry[field] || typeof entry[field] !== 'object') continue;
    next[field] = clone(entry[field]);
    for (const lengthField of ['startLength', 'endLength']) {
      if (finite(entry[field][lengthField]) != null) {
        next[field][lengthField] = scaled(entry[field][lengthField], scalarFactor);
      }
    }
  }
  next.shadow = resizePathShadow(entry.shadow, scaleX, scaleY, scalarFactor);
  return next;
}

export function derivePathResizeCommit({ pathV2 = null, pathsV2 = null, originalTile, finalTile } = {}) {
  validateTileGeometry(originalTile, 'original');
  validateTileGeometry(finalTile, 'final');
  const scaleX = finalTile.width / originalTile.width;
  const scaleY = finalTile.height / originalTile.height;
  return {
    scaleX,
    scaleY,
    pathV2: pathV2 ? resizePathEntry(pathV2, scaleX, scaleY) : null,
    pathsV2: pathsV2 && typeof pathsV2 === 'object'
      ? {
          ...clone(pathsV2),
          paths: Array.isArray(pathsV2.paths)
            ? pathsV2.paths.map((entry) => resizePathEntry(entry, scaleX, scaleY))
            : pathsV2.paths
        }
      : null
  };
}
