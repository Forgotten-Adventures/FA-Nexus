const REPEAT_TRANSFORM_VERSION = 1;
const LEGACY_SCALE_MIN = 0.25;
const LEGACY_SCALE_MAX = 3;
const DEG_TO_RAD = Math.PI / 180;
const DEFAULT_ASSET_PIXELS_PER_GRID = 200;

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function resolveMaskedTilingBaseGridScale(
  sceneGridSize,
  assetPixelsPerGrid = DEFAULT_ASSET_PIXELS_PER_GRID
) {
  const gridSize = finite(sceneGridSize);
  const assetPixels = finite(assetPixelsPerGrid);
  if (gridSize == null || !(gridSize > 0) || assetPixels == null || !(assetPixels > 0)) {
    throw new Error('Masked tiling base grid scale requires positive Scene-grid and artwork pixel sizes.');
  }
  return gridSize / assetPixels;
}

function clean(value, places = 9) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function hasOwn(object, key) {
  return !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

// A repeat transform is stored only when its key holds a value. Foundry drops `undefined` when a
// document is serialised, so an own property set to `undefined` states nothing. The Texture
// editor sends one when it commits a never-resized Tile without changing the mask's shape.
function hasStoredRepeatTransform(maskedTiling) {
  return hasOwn(maskedTiling, 'textureRepeatTransform') && maskedTiling.textureRepeatTransform !== undefined;
}

function legacyScale(value) {
  const numeric = finite(value);
  if (numeric == null || numeric <= 0) return 1;
  return Math.min(LEGACY_SCALE_MAX, Math.max(LEGACY_SCALE_MIN, numeric));
}

function normalizedDegrees(value) {
  const numeric = finite(value) ?? 0;
  return ((numeric % 360) + 360) % 360;
}

function legacyRepeatMatrix(maskedTiling = {}) {
  const scale = legacyScale(maskedTiling.textureScale);
  const rotation = normalizedDegrees(maskedTiling.textureRotation);
  const radians = rotation * DEG_TO_RAD;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    a: cosine * scale,
    b: sine * scale,
    c: -sine * scale,
    d: cosine * scale,
    sourceScale: scale,
    sourceRotation: rotation
  };
}

function validMatrix(value) {
  if (!value || typeof value !== 'object') return null;
  const matrix = {
    a: finite(value.a),
    b: hasOwn(value, 'b') ? finite(value.b) : 0,
    c: hasOwn(value, 'c') ? finite(value.c) : 0,
    d: finite(value.d)
  };
  if (Object.values(matrix).some((entry) => entry == null)) return null;
  const determinant = (matrix.a * matrix.d) - (matrix.b * matrix.c);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  return matrix;
}

function multiply(left, right) {
  return {
    a: (left.a * right.a) + (left.c * right.b),
    b: (left.b * right.a) + (left.d * right.b),
    c: (left.a * right.c) + (left.c * right.d),
    d: (left.b * right.c) + (left.d * right.d)
  };
}

function inverse(matrix) {
  const determinant = (matrix.a * matrix.d) - (matrix.b * matrix.c);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error('Masked tiling repeat transform is not invertible.');
  }
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant
  };
}

function serializeRepeatTransform(matrix, { sourceScale, sourceRotation } = {}) {
  return {
    version: REPEAT_TRANSFORM_VERSION,
    a: clean(matrix.a),
    b: clean(matrix.b),
    c: clean(matrix.c),
    d: clean(matrix.d),
    sourceScale: clean(legacyScale(sourceScale)),
    sourceRotation: clean(normalizedDegrees(sourceRotation))
  };
}

export function resolveMaskedTilingRepeatTransform(maskedTiling = {}) {
  const legacy = legacyRepeatMatrix(maskedTiling);
  const hasStored = hasStoredRepeatTransform(maskedTiling);
  const stored = validMatrix(maskedTiling?.textureRepeatTransform);
  if (!hasStored) return serializeRepeatTransform(legacy, legacy);
  if (!stored) {
    throw new Error('Stored masked tiling repeat transform is malformed or not invertible.');
  }
  const sourceScale = finite(maskedTiling.textureRepeatTransform?.sourceScale);
  const sourceRotation = finite(maskedTiling.textureRepeatTransform?.sourceRotation);
  return serializeRepeatTransform(stored, {
    sourceScale: sourceScale != null && sourceScale > 0 ? sourceScale : legacy.sourceScale,
    sourceRotation: sourceRotation ?? legacy.sourceRotation
  });
}

export function mergeMaskedTilingRepeatTransform(currentMaskedTiling, incomingMaskedTiling) {
  const incoming = clone(incomingMaskedTiling);
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (hasStoredRepeatTransform(incoming)) {
    resolveMaskedTilingRepeatTransform(incoming);
    return incoming;
  }
  delete incoming.textureRepeatTransform;
  const currentHasStored = hasStoredRepeatTransform(currentMaskedTiling);
  const currentStored = validMatrix(currentMaskedTiling?.textureRepeatTransform);
  if (currentHasStored && !currentStored) resolveMaskedTilingRepeatTransform(currentMaskedTiling);
  if (!currentStored) return incoming;

  const current = resolveMaskedTilingRepeatTransform(currentMaskedTiling);
  const previousBase = legacyRepeatMatrix({
    textureScale: current.sourceScale,
    textureRotation: current.sourceRotation
  });
  const nextBase = legacyRepeatMatrix(incoming);
  const rebased = multiply(multiply(current, inverse(previousBase)), nextBase);
  incoming.textureRepeatTransform = serializeRepeatTransform(rebased, nextBase);
  return incoming;
}

function scaledPoint(point, scaleX, scaleY) {
  if (!point || typeof point !== 'object') return clone(point);
  const next = clone(point);
  if (finite(point.x) != null) next.x = clean(Number(point.x) * scaleX);
  if (finite(point.y) != null) next.y = clean(Number(point.y) * scaleY);
  return next;
}

function scalePointArray(points, scaleX, scaleY) {
  if (!Array.isArray(points)) return clone(points);
  if (points.every((value) => finite(value) != null)) {
    return points.map((value, index) => clean(Number(value) * (index % 2 ? scaleY : scaleX)));
  }
  return points.map((point) => scaledPoint(point, scaleX, scaleY));
}

function scaleMaskShape(shape, scaleX, scaleY) {
  if (!shape || typeof shape !== 'object') return clone(shape);
  const next = clone(shape);
  for (const field of ['x', 'width', 'radiusX']) {
    if (finite(shape[field]) != null) next[field] = clean(Number(shape[field]) * scaleX);
  }
  for (const field of ['y', 'height', 'radiusY']) {
    if (finite(shape[field]) != null) next[field] = clean(Number(shape[field]) * scaleY);
  }
  if (shape.topLeft) next.topLeft = scaledPoint(shape.topLeft, scaleX, scaleY);
  if (shape.center) next.center = scaledPoint(shape.center, scaleX, scaleY);
  if (shape.size) next.size = scaledPoint(shape.size, scaleX, scaleY);
  if (shape.radius) next.radius = scaledPoint(shape.radius, scaleX, scaleY);
  if (shape.vertices) next.vertices = scalePointArray(shape.vertices, scaleX, scaleY);
  if (shape.points) next.points = scalePointArray(shape.points, scaleX, scaleY);
  return next;
}

function scaleMaskShapes(maskShapes, scaleX, scaleY) {
  if (Array.isArray(maskShapes)) {
    return maskShapes.map((shape) => scaleMaskShape(shape, scaleX, scaleY));
  }
  if (!maskShapes || typeof maskShapes !== 'object') return clone(maskShapes);
  const next = clone(maskShapes);
  if (Array.isArray(maskShapes.shapes)) {
    next.shapes = maskShapes.shapes.map((shape) => scaleMaskShape(shape, scaleX, scaleY));
  }
  return next;
}

function tileAnchor(tile) {
  const texture = tile?.texture || {};
  return {
    x: Math.min(1, Math.max(0, finite(texture.anchorX ?? tile?.anchorX) ?? 0.5)),
    y: Math.min(1, Math.max(0, finite(texture.anchorY ?? tile?.anchorY) ?? 0.5))
  };
}

function tileGeometry(tile, label) {
  const geometry = {
    x: finite(tile?.x),
    y: finite(tile?.y),
    width: finite(tile?.width),
    height: finite(tile?.height),
    rotation: finite(tile?.rotation) ?? 0,
    anchor: tileAnchor(tile)
  };
  if ([geometry.x, geometry.y, geometry.width, geometry.height].some((value) => value == null)) {
    throw new Error(`Masked tiling resize requires finite ${label} Tile geometry.`);
  }
  if (!(geometry.width > 0) || !(geometry.height > 0)) {
    throw new Error(`Masked tiling resize requires positive ${label} Tile dimensions.`);
  }
  return geometry;
}

function hashString(value) {
  const input = String(value ?? '');
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) + input.charCodeAt(index);
    hash &= 0xffffffff;
  }
  return (hash >>> 0).toString(16);
}

export function deriveMaskedTilingResizeCommit({
  maskedTiling,
  originalTile,
  finalTile
} = {}) {
  if (!maskedTiling || typeof maskedTiling !== 'object') {
    throw new Error('Masked tiling resize requires stored maskedTiling metadata.');
  }
  const original = tileGeometry(originalTile, 'original');
  const final = tileGeometry(finalTile, 'final');
  const scaleX = final.width / original.width;
  const scaleY = final.height / original.height;
  const next = clone(maskedTiling);

  // Composite Regions share the owning Tile's coordinate frame. Scene Group
  // previews consume this same resize contract before compensating their live
  // sprites for the mesh scale, so every Region needs the next mask and repeat
  // transform here, just as a standalone masked texture does.
  if (maskedTiling.maskType === 'composite') {
    next.regions = maskedTiling.regions.map((region) => ({
      ...clone(region),
      maskedTiling: region.maskedTiling
        ? deriveMaskedTilingResizeCommit({ maskedTiling: region.maskedTiling, originalTile, finalTile })
        : region.maskedTiling
    }));
  }

  if (next.maskShapes) {
    next.maskShapes = scaleMaskShapes(maskedTiling.maskShapes, scaleX, scaleY);
    next.maskShapeKey = hashString(JSON.stringify(next.maskShapes));
  }
  if (next.textureOffset) next.textureOffset = scaledPoint(maskedTiling.textureOffset, scaleX, scaleY);

  if (next.maskWorld && typeof next.maskWorld === 'object') {
    next.maskWorld = clone(maskedTiling.maskWorld);
    if (maskedTiling.maskWorld.scale) {
      next.maskWorld.scale = scaledPoint(maskedTiling.maskWorld.scale, scaleX, scaleY);
    }
    if (maskedTiling.maskWorld.offset) {
      const originX = finite(maskedTiling.maskWorld.origin?.x);
      const originY = finite(maskedTiling.maskWorld.origin?.y);
      next.maskWorld.offset = originX != null && originY != null
        ? {
            x: clean(final.x - (final.width * final.anchor.x) - originX),
            y: clean(final.y - (final.height * final.anchor.y) - originY)
          }
        : scaledPoint(maskedTiling.maskWorld.offset, scaleX, scaleY);
    }
    const sourceTileMetadata = maskedTiling.maskWorld.tile || {};
    next.maskWorld.tile = {
      ...clone(sourceTileMetadata),
      x: clean(final.x),
      y: clean(final.y),
      width: clean(final.width),
      height: clean(final.height)
    };
    if (hasOwn(sourceTileMetadata, 'rotation')) next.maskWorld.tile.rotation = clean(final.rotation);
    if (hasOwn(sourceTileMetadata, 'anchorX')) next.maskWorld.tile.anchorX = clean(final.anchor.x);
    if (hasOwn(sourceTileMetadata, 'anchorY')) next.maskWorld.tile.anchorY = clean(final.anchor.y);
  }

  const scaledPhase = scaledPoint(maskedTiling.texturePhase || { x: 0, y: 0 }, scaleX, scaleY);
  const originX = finite(maskedTiling.maskWorld?.origin?.x);
  const originY = finite(maskedTiling.maskWorld?.origin?.y);
  if (originX != null && originY != null) {
    const originalDeltaX = original.x - (original.width * original.anchor.x) - originX;
    const originalDeltaY = original.y - (original.height * original.anchor.y) - originY;
    const finalDeltaX = final.x - (final.width * final.anchor.x) - originX;
    const finalDeltaY = final.y - (final.height * final.anchor.y) - originY;
    scaledPhase.x = clean(scaledPhase.x + finalDeltaX - (originalDeltaX * scaleX));
    scaledPhase.y = clean(scaledPhase.y + finalDeltaY - (originalDeltaY * scaleY));
  }
  next.texturePhase = scaledPhase;

  next.textureRepeatTransform = scaleMaskedTilingRepeatTransform(
    maskedTiling,
    scaleX,
    scaleY
  ).textureRepeatTransform;
  return next;
}

export function deriveMaskedTilingTransformPreview({
  maskedTiling,
  originalTile,
  finalTile
} = {}) {
  const originalWidth = Number(originalTile?.width);
  const originalHeight = Number(originalTile?.height);
  const finalWidth = Number(finalTile?.width);
  const finalHeight = Number(finalTile?.height);
  if (
    Number.isFinite(originalWidth)
    && Number.isFinite(originalHeight)
    && Number.isFinite(finalWidth)
    && Number.isFinite(finalHeight)
    && originalWidth === finalWidth
    && originalHeight === finalHeight
  ) return maskedTiling;
  return deriveMaskedTilingResizeCommit({ maskedTiling, originalTile, finalTile });
}

export function scaleMaskedTilingRepeatTransform(maskedTiling, scaleX, scaleY = scaleX) {
  if (!maskedTiling || typeof maskedTiling !== 'object') return clone(maskedTiling);
  const x = finite(scaleX);
  const y = finite(scaleY);
  if (x == null || y == null || !(x > 0) || !(y > 0)) {
    throw new Error('Masked tiling repeat scaling requires positive per-axis factors.');
  }
  const next = clone(maskedTiling);
  const repeat = resolveMaskedTilingRepeatTransform(maskedTiling);
  const resized = multiply({ a: x, b: 0, c: 0, d: y }, repeat);
  next.textureRepeatTransform = serializeRepeatTransform(resized, repeat);
  return next;
}

export function applyMaskedTilingRepeatTransform(tiling, maskedTiling, baseScale = 1) {
  if (!tiling || tiling.destroyed) return null;
  const repeat = resolveMaskedTilingRepeatTransform(maskedTiling);
  const gridScale = finite(baseScale);
  if (gridScale == null || !(gridScale > 0)) {
    throw new Error('Masked tiling repeat transform requires a positive base scale.');
  }
  const Matrix = globalThis.PIXI?.Matrix;
  if (typeof Matrix !== 'function' || typeof tiling.tileTransform?.setFromMatrix !== 'function') {
    throw new Error('Foundry v14 Pixi tileTransform matrix API is unavailable.');
  }
  const matrix = new Matrix(
    repeat.a * gridScale,
    repeat.b * gridScale,
    repeat.c * gridScale,
    repeat.d * gridScale,
    0,
    0
  );
  tiling.tileTransform.setFromMatrix(matrix);
  return repeat;
}
