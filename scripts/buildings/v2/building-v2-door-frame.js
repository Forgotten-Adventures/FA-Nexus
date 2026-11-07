import { normalizeBuildingV2DoorShadow } from './building-v2-door-shadow.js';

const FRAME_KEYS = new Set([
  'texture', 'sourceWidth', 'sourceHeight', 'gridSize', 'mode', 'scale',
  'offsetX', 'offsetY', 'rotation', 'hsbc', 'opaqueBounds'
]);
const TEXTURE_KEYS = new Set(['key', 'src']);
const HSBC_KEYS = new Set(['hue', 'saturation', 'brightness', 'contrast']);
const OPAQUE_BOUNDS_KEYS = new Set(['minX', 'minY', 'maxX', 'maxY']);

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error(`Building V2 Door frame requires an exact ${label}.`);
  }
  return value;
}

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw new Error(`Building V2 Door frame requires finite ${label}.`);
  return value;
}

function boundedNumber(value, min, max, label) {
  const numeric = finiteNumber(value, label);
  if (numeric < min || numeric > max) {
    throw new Error(`Building V2 Door frame ${label} must be between ${min} and ${max}.`);
  }
  return numeric;
}

function normalizeFrameHsbc(value) {
  if (value == null) return null;
  exactObject(value, HSBC_KEYS, 'HSBC value');
  return {
    hue: boundedNumber(value.hue, -180, 180, 'HSBC hue'),
    saturation: boundedNumber(value.saturation, 0, 2, 'HSBC saturation'),
    brightness: boundedNumber(value.brightness, 0, 2, 'HSBC brightness'),
    contrast: boundedNumber(value.contrast, 0, 2, 'HSBC contrast')
  };
}

function normalizeOpaqueBounds(value, sourceWidth, sourceHeight) {
  if (value == null) return null;
  exactObject(value, OPAQUE_BOUNDS_KEYS, 'opaque bounds');
  const bounds = Object.fromEntries([...OPAQUE_BOUNDS_KEYS].map((key) => {
    const coordinate = value[key];
    const numeric = finiteNumber(coordinate, `opaque bounds ${key}`);
    if (!Number.isInteger(numeric)) {
      throw new Error(`Building V2 Door frame opaque bounds ${key} must be an integer pixel edge.`);
    }
    return [key, numeric];
  }));
  if (bounds.minX < 0 || bounds.minY < 0
    || bounds.maxX > sourceWidth || bounds.maxY > sourceHeight
    || bounds.minX >= bounds.maxX || bounds.minY >= bounds.maxY) {
    throw new Error('Building V2 Door frame requires non-empty opaque bounds inside its captured source dimensions.');
  }
  return bounds;
}

function normalizePoint(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['x', 'y'].includes(key))) {
    throw new Error(`Building V2 Door frame requires exact ${label}.`);
  }
  return { x: finiteNumber(value.x, `${label} x`), y: finiteNumber(value.y, `${label} y`) };
}

function spriteBounds(sprite) {
  const halfWidth = sprite.width / 2;
  const halfHeight = sprite.height / 2;
  const cosine = Math.cos(sprite.rotation);
  const sine = Math.sin(sprite.rotation);
  const corners = [
    [-halfWidth, -halfHeight], [halfWidth, -halfHeight],
    [halfWidth, halfHeight], [-halfWidth, halfHeight]
  ].map(([x, y]) => ({
    x: sprite.x + (x * cosine) - (y * sine),
    y: sprite.y + (x * sine) + (y * cosine)
  }));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return {
    minX: Math.min(...xs), minY: Math.min(...ys),
    maxX: Math.max(...xs), maxY: Math.max(...ys)
  };
}

function projectedRectangleRange({ bounds, sourceWidth, sourceHeight, assetScale, flipX, rotation }) {
  const left = (bounds.minX - (sourceWidth / 2)) * assetScale;
  const right = (bounds.maxX - (sourceWidth / 2)) * assetScale;
  const top = (bounds.minY - (sourceHeight / 2)) * assetScale;
  const bottom = (bounds.maxY - (sourceHeight / 2)) * assetScale;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const projected = [[left, top], [right, top], [right, bottom], [left, bottom]]
    .map(([x, y]) => (flipX * x * cosine) - (y * sine));
  return { min: Math.min(...projected), max: Math.max(...projected) };
}

export function positionBuildingV2DoorFramePillars({
  sourceWidth,
  sourceHeight,
  opaqueBounds = null,
  assetScale,
  gapLength,
  targetWidth,
  offsetX = 0,
  rotation = 0
} = {}) {
  const width = finiteNumber(sourceWidth, 'positive source width');
  const height = finiteNumber(sourceHeight, 'positive source height');
  const scale = finiteNumber(assetScale, 'positive asset scale');
  const gap = finiteNumber(gapLength, 'positive jamb chord length');
  const target = finiteNumber(targetWidth, 'positive target width');
  const horizontalOffset = finiteNumber(offsetX, 'horizontal offset');
  const pillarRotation = finiteNumber(rotation, 'pillar rotation');
  if (!(width > 0) || !(height > 0) || !(scale > 0) || !(gap > 0) || !(target > 0)) {
    throw new Error('Building V2 Door frame pillar positioning requires positive dimensions.');
  }
  const alongOffset = horizontalOffset * target * 0.5;
  if (!opaqueBounds) {
    const pillarWidth = width * scale;
    return {
      left: -((target - pillarWidth) / 2) + alongOffset,
      right: ((target - pillarWidth) / 2) - alongOffset
    };
  }
  const bounds = normalizeOpaqueBounds(opaqueBounds, width, height);
  const leftRange = projectedRectangleRange({
    bounds, sourceWidth: width, sourceHeight: height, assetScale: scale, flipX: 1, rotation: pillarRotation
  });
  const rightRange = projectedRectangleRange({
    bounds, sourceWidth: width, sourceHeight: height, assetScale: scale, flipX: -1, rotation: -pillarRotation
  });
  return {
    left: -(gap / 2) - leftRange.max + alongOffset,
    right: (gap / 2) - rightRange.min - alongOffset
  };
}

export function normalizeBuildingV2DoorFrame(value) {
  if (value == null) return null;
  exactObject(value, FRAME_KEYS, 'frame value');
  const texture = exactObject(value.texture, TEXTURE_KEYS, 'frame texture snapshot');
  const src = typeof texture.src === 'string' ? texture.src.trim() : '';
  const key = typeof texture.key === 'string' ? texture.key.trim() : '';
  if (!src || !key) throw new Error('Building V2 Door frame requires its captured texture identity and source.');
  const sourceWidth = finiteNumber(value.sourceWidth, 'positive source width');
  const sourceHeight = finiteNumber(value.sourceHeight, 'positive source height');
  const gridSize = finiteNumber(value.gridSize, 'positive Building-local grid size');
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(gridSize > 0)) {
    throw new Error('Building V2 Door frame requires positive source dimensions and Building-local grid size.');
  }
  const mode = String(value.mode || '').toLowerCase();
  if (!['split', 'pillar'].includes(mode)) {
    throw new Error('Building V2 Door frame mode must be split or pillar.');
  }
  const rotation = boundedNumber(value.rotation, -180, 180, 'pillar rotation');
  const opaqueBounds = normalizeOpaqueBounds(value.opaqueBounds, sourceWidth, sourceHeight);
  if (opaqueBounds && mode !== 'pillar') {
    throw new Error('Building V2 Door frame opaque bounds are supported only for pillar frames.');
  }
  return {
    texture: { key, src },
    sourceWidth,
    sourceHeight,
    gridSize,
    mode,
    scale: boundedNumber(value.scale, 0.1, 3, 'scale'),
    offsetX: boundedNumber(value.offsetX, -1, 1, 'horizontal offset'),
    offsetY: boundedNumber(value.offsetY, -1, 1, 'vertical offset'),
    rotation: mode === 'pillar' ? rotation : 0,
    hsbc: normalizeFrameHsbc(value.hsbc),
    ...(opaqueBounds ? { opaqueBounds } : {})
  };
}

export function compileBuildingV2DoorFrame({
  portalId,
  frame,
  endpointsLocal,
  gridSize = frame?.gridSize,
  shadow
} = {}) {
  const normalizedFrame = normalizeBuildingV2DoorFrame(frame);
  if (!normalizedFrame) return null;
  const normalizedPortalId = typeof portalId === 'string' ? portalId.trim() : '';
  if (!normalizedPortalId) throw new Error('Building V2 Door frame requires its Portal identity.');
  if (!Array.isArray(endpointsLocal) || endpointsLocal.length !== 2) {
    throw new Error('Building V2 Door frame requires two exact Building-local jamb endpoints.');
  }
  const a = normalizePoint(endpointsLocal[0], 'first jamb endpoint');
  const b = normalizePoint(endpointsLocal[1], 'second jamb endpoint');
  const resolvedGridSize = finiteNumber(gridSize, 'positive Building-local grid size');
  if (!(resolvedGridSize > 0) || Math.abs(resolvedGridSize - normalizedFrame.gridSize) > 1e-6) {
    throw new Error('Building V2 Door frame grid size must match its captured Building-local grid basis.');
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const gapLength = Math.hypot(dx, dy);
  if (!(gapLength > 0)) throw new Error('Building V2 Door frame requires a non-zero jamb chord.');
  const ux = dx / gapLength;
  const uy = dy / gapLength;
  const nx = -uy;
  const ny = ux;
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const assetScale = (resolvedGridSize / 200) * normalizedFrame.scale;
  const pillarSourceWidth = normalizedFrame.mode === 'pillar'
    ? normalizedFrame.sourceWidth
    : Math.max(1, Math.min(normalizedFrame.sourceHeight, Math.floor(normalizedFrame.sourceWidth / 2)));
  const pillarWidth = pillarSourceWidth * assetScale;
  const height = normalizedFrame.sourceHeight * assetScale;
  const targetWidth = Math.max((pillarWidth * 2) + 1, gapLength + (pillarWidth * 2));
  const normalOffset = normalizedFrame.offsetY * height * 0.5;
  const chordRotation = Math.atan2(dy, dx);
  const pillarRotation = normalizedFrame.rotation * (Math.PI / 180);
  const pillarPositions = normalizedFrame.mode === 'pillar'
    ? positionBuildingV2DoorFramePillars({
      sourceWidth: normalizedFrame.sourceWidth,
      sourceHeight: normalizedFrame.sourceHeight,
      opaqueBounds: normalizedFrame.opaqueBounds,
      assetScale,
      gapLength,
      targetWidth,
      offsetX: normalizedFrame.offsetX,
      rotation: pillarRotation
    })
    : null;
  const makeSprite = (side) => {
    const sign = side === 'left' ? -1 : 1;
    const alongOffset = normalizedFrame.offsetX * targetWidth * 0.5;
    const along = pillarPositions?.[side]
      ?? (sign * ((targetWidth - pillarWidth) / 2) - (sign * alongOffset));
    const rotation = chordRotation + (normalizedFrame.mode === 'pillar' ? sign * -pillarRotation : 0);
    const sourceFrame = normalizedFrame.mode === 'split' ? {
      x: side === 'left' ? 0 : normalizedFrame.sourceWidth - pillarSourceWidth,
      y: 0,
      width: pillarSourceWidth,
      height: normalizedFrame.sourceHeight
    } : null;
    return {
      id: `${normalizedPortalId}:frame:${side}`,
      side,
      textureSrc: normalizedFrame.texture.src,
      sourceFrame,
      x: center.x + (ux * along) + (nx * normalOffset),
      y: center.y + (uy * along) + (ny * normalOffset),
      width: pillarWidth,
      height,
      rotation,
      flipX: normalizedFrame.mode === 'pillar' && side === 'right' ? -1 : 1,
      flipY: 1,
      hsbc: normalizedFrame.hsbc
    };
  };
  const artwork = [makeSprite('left'), makeSprite('right')];
  const spriteEnvelopes = artwork.map(spriteBounds);
  const minX = Math.min(...spriteEnvelopes.map((bounds) => bounds.minX));
  const minY = Math.min(...spriteEnvelopes.map((bounds) => bounds.minY));
  const maxX = Math.max(...spriteEnvelopes.map((bounds) => bounds.maxX));
  const maxY = Math.max(...spriteEnvelopes.map((bounds) => bounds.maxY));
  const normalizedShadow = shadow == null ? null : normalizeBuildingV2DoorShadow(shadow);
  return {
    kind: 'door-frame',
    portalId: normalizedPortalId,
    frame: normalizedFrame,
    endpointsLocal: [a, b],
    gridSize: resolvedGridSize,
    shadow: normalizedShadow,
    bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
    artwork
  };
}
