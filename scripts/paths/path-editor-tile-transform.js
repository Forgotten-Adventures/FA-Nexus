const DEG_TO_RAD = Math.PI / 180;
const POSE_FIELDS = [
  ['x', 'position.x'],
  ['y', 'position.y'],
  ['width', 'bounds.width'],
  ['height', 'bounds.height'],
  ['rotation', 'rotationDegrees'],
  ['texture.anchorX', 'anchor.x'],
  ['texture.anchorY', 'anchor.y']
];

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clean(value, places = 9) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function readPathValue(source, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], source);
}

function resolvePoint(point, label) {
  const x = finite(Array.isArray(point) ? point[0] : point?.x);
  const y = finite(Array.isArray(point) ? point[1] : point?.y);
  if (x == null || y == null) {
    throw new Error(`Path editor ${label} requires finite x and y.`);
  }
  return { x, y };
}

function transformEntryPoints(entry, transformPoint) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Path editor re-entry requires Path metadata.');
  }
  const next = clone(entry);
  const controlPoints = Array.isArray(entry.controlPoints) ? entry.controlPoints : [];
  next.controlPoints = controlPoints.map((point, index) => ({
    ...(Array.isArray(point) ? {} : clone(point)),
    ...transformPoint(point, `controlPoints[${index}]`)
  }));
  if (entry.shadow && typeof entry.shadow === 'object') {
    next.shadow = clone(entry.shadow);
    if (Array.isArray(entry.shadow.points)) {
      next.shadow.points = entry.shadow.points.map((point, index) => ({
        ...(Array.isArray(point) ? {} : clone(point)),
        ...transformPoint(point, `shadow.points[${index}]`)
      }));
    }
  }
  return next;
}

export function resolvePathEditorTileTransform(tile) {
  const x = finite(tile?.x);
  const y = finite(tile?.y);
  const width = finite(tile?.width);
  const height = finite(tile?.height);
  if ([x, y, width, height].some((value) => value == null)) {
    throw new Error('Path editor re-entry requires finite live Tile geometry.');
  }
  if (!(width > 0) || !(height > 0)) {
    throw new Error('Path editor re-entry requires positive Tile dimensions.');
  }

  const anchor = {
    x: finite(tile?.texture?.anchorX) ?? 0.5,
    y: finite(tile?.texture?.anchorY) ?? 0.5
  };
  const rotationDegrees = finite(tile?.rotation) ?? 0;
  return {
    position: { x: clean(x), y: clean(y) },
    pivot: {
      x: clean(width * anchor.x),
      y: clean(height * anchor.y)
    },
    rotation: rotationDegrees * DEG_TO_RAD,
    rotationDegrees: clean(rotationDegrees),
    anchor,
    bounds: {
      x: clean(x - (width * anchor.x)),
      y: clean(y - (height * anchor.y)),
      width: clean(width),
      height: clean(height)
    }
  };
}

export function pathTileLocalPointToWorld(tile, point, label = 'Tile-local point') {
  const transform = resolvePathEditorTileTransform(tile);
  const local = resolvePoint(point, label);
  const x = local.x - transform.pivot.x;
  const y = local.y - transform.pivot.y;
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  return {
    x: clean(transform.position.x + (x * cosine) - (y * sine)),
    y: clean(transform.position.y + (x * sine) + (y * cosine))
  };
}

export function pathWorldPointToTileLocal(tile, point, label = 'world point') {
  const transform = resolvePathEditorTileTransform(tile);
  const world = resolvePoint(point, label);
  const x = world.x - transform.position.x;
  const y = world.y - transform.position.y;
  const cosine = Math.cos(-transform.rotation);
  const sine = Math.sin(-transform.rotation);
  return {
    x: clean((x * cosine) - (y * sine) + transform.pivot.x),
    y: clean((x * sine) + (y * cosine) + transform.pivot.y)
  };
}

export function hydratePathEntryAtTilePose(tile, entry) {
  resolvePathEditorTileTransform(tile);
  return transformEntryPoints(entry, (point, label) => (
    pathTileLocalPointToWorld(tile, point, label)
  ));
}

export function serializePathEntryAtTilePose(tile, entry) {
  resolvePathEditorTileTransform(tile);
  return transformEntryPoints(entry, (point, label) => (
    pathWorldPointToTileLocal(tile, point, label)
  ));
}

export function refitPathEditorTilePose(tile, localBounds) {
  const transform = resolvePathEditorTileTransform(tile);
  const minX = finite(localBounds?.minX);
  const minY = finite(localBounds?.minY);
  const maxX = finite(localBounds?.maxX);
  const maxY = finite(localBounds?.maxY);
  if ([minX, minY, maxX, maxY].some((value) => value == null)) {
    throw new Error('Path editor Tile refit requires finite local bounds.');
  }
  if (maxX < minX || maxY < minY) {
    throw new Error('Path editor Tile refit requires ordered local bounds.');
  }

  // Foundry quantizes Tile x/y to whole scene pixels. A one-pixel inset on
  // every local edge absorbs the inverse-rotated projection of that rounding
  // without clipping the refitted Path.
  const localX = Math.floor(minX) - 1;
  const localY = Math.floor(minY) - 1;
  const width = Math.max(1, (Math.ceil(maxX) + 1) - localX);
  const height = Math.max(1, (Math.ceil(maxY) + 1) - localY);
  const position = pathTileLocalPointToWorld(tile, {
    x: localX + (width * transform.anchor.x),
    y: localY + (height * transform.anchor.y)
  }, 'refitted Tile anchor');

  return {
    x: Math.round(position.x),
    y: Math.round(position.y),
    width,
    height,
    rotation: transform.rotationDegrees,
    texture: clone(tile?._source?.texture || tile.texture || {
      anchorX: transform.anchor.x,
      anchorY: transform.anchor.y
    })
  };
}

export function comparePathTilePose(expectedTile, actualTile, { tolerance = 1e-9 } = {}) {
  const expected = resolvePathEditorTileTransform(expectedTile);
  const actual = resolvePathEditorTileTransform(actualTile);
  const mismatches = [];
  for (const [field, transformPath] of POSE_FIELDS) {
    const expectedValue = readPathValue(expected, transformPath);
    const actualValue = readPathValue(actual, transformPath);
    if (Math.abs(expectedValue - actualValue) <= tolerance) continue;
    mismatches.push({
      field,
      expected: clean(expectedValue),
      actual: clean(actualValue)
    });
  }
  return {
    matches: mismatches.length === 0,
    mismatches
  };
}
