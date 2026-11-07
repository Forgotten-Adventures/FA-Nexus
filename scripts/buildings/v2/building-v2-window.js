import { normalizeBuildingV2PortalTiming, normalizeBuildingV2PortalSound } from './building-v2-portal-options.js';
import { normalizeBuildingStructuralWallBehavior } from '../building-wall-restrictions.js';
import { isSmallPortalTexturePath } from '../../portals/portal-texture-path.js';
import { compileBuildingV2DoorFrame, normalizeBuildingV2DoorFrame } from './building-v2-door-frame.js';
import { materializeBuildingV2DoorShadow, normalizeBuildingV2DoorShadow } from './building-v2-door-shadow.js';
import { createBuildingV2SpatialTransform, deriveBuildingV2SpatialPose, roundBuildingV2NativeCoordinate } from './building-v2-spatial-transform.js';

const SETUP_KEYS = new Set([
  'sill', 'surface', 'frame', 'animated', 'animation', 'direction',
  'directionFlip', 'double', 'textureFlip', 'duration', 'strength', 'doorSound', 'lockAspectRatio'
]);
const ELEMENT_KEYS = new Set([
  'asset', 'sourceWidth', 'sourceHeight', 'gridSize', 'scale', 'offsetX', 'offsetY', 'hsbc'
]);
const ASSET_KEYS = new Set(['key', 'src']);
const HSBC_KEYS = new Set(['hue', 'saturation', 'brightness', 'contrast']);
const SOURCE_GRID_PIXELS = 200;
const FOUNDRY_V14_PROXIMITY_SENSE = 30;
const WINDOW_SILL_FLOOR_OFFSET = 0.5;
const WINDOW_CONTAINED_SHADOW = Object.freeze({
  enabled: true,
  alpha: 0.3,
  blur: 1,
  dilation: 2.5,
  offset: 0
});
export const BUILDING_V2_WINDOW_ANIMATION_TYPES = Object.freeze(['ascend', 'descend', 'slide', 'swing', 'swivel']);

function normalizeTextureFlip(value) {
  exactObject(value, new Set(['horizontal', 'vertical']), 'texture flip intent');
  if (typeof value.horizontal !== 'boolean' || typeof value.vertical !== 'boolean') {
    throw new Error('Building V2 Window texture flips require horizontal/vertical boolean intent.');
  }
  return { horizontal: value.horizontal, vertical: value.vertical };
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error(`Building V2 Window requires an exact ${label}.`);
  }
  return value;
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`Building V2 Window requires finite ${label}.`);
  return value;
}

function bounded(value, min, max, label) {
  const numeric = finite(value, label);
  if (numeric < min || numeric > max) {
    throw new Error(`Building V2 Window ${label} must be between ${min} and ${max}.`);
  }
  return numeric;
}

function normalizeHsbc(value) {
  if (value == null) return null;
  exactObject(value, HSBC_KEYS, 'element HSBC value');
  return {
    hue: bounded(value.hue, -180, 180, 'HSBC hue'),
    saturation: bounded(value.saturation, 0, 2, 'HSBC saturation'),
    brightness: bounded(value.brightness, 0, 2, 'HSBC brightness'),
    contrast: bounded(value.contrast, 0, 2, 'HSBC contrast')
  };
}

function normalizePoint(value, label) {
  exactObject(value, new Set(['x', 'y']), label);
  return { x: finite(value.x, `${label} x`), y: finite(value.y, `${label} y`) };
}

export function normalizeBuildingV2WindowElement(value, { label = 'element', allowAspectScale = false } = {}) {
  if (value == null) return null;
  exactObject(value, ELEMENT_KEYS, label);
  const asset = exactObject(value.asset, ASSET_KEYS, `${label} asset snapshot`);
  const key = typeof asset.key === 'string' ? asset.key.trim() : '';
  const src = typeof asset.src === 'string' ? asset.src.trim() : '';
  if (!key || !src) throw new Error(`Building V2 Window ${label} requires its captured asset identity and source.`);
  const sourceWidth = finite(value.sourceWidth, `${label} positive intrinsic source width`);
  const sourceHeight = finite(value.sourceHeight, `${label} positive intrinsic source height`);
  const gridSize = finite(value.gridSize, `${label} positive Building-local grid basis`);
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(gridSize > 0)) {
    throw new Error(`Building V2 Window ${label} requires positive intrinsic source dimensions and Building-local grid basis.`);
  }
  const scale = allowAspectScale ? finite(value.scale, `${label} scale`) : bounded(value.scale, 0.1, 3, `${label} scale`);
  if (!(scale > 0)) throw new Error(`Building V2 Window ${label} scale must be positive.`);
  return {
    asset: { key, src }, sourceWidth, sourceHeight, gridSize,
    scale,
    offsetX: bounded(value.offsetX, -1, 1, `${label} horizontal offset`),
    offsetY: bounded(value.offsetY, -1, 1, `${label} vertical offset`),
    hsbc: normalizeHsbc(value.hsbc)
  };
}

export function normalizeBuildingV2WindowSetup(value) {
  exactObject(value, SETUP_KEYS, 'setup snapshot');
  if (value.lockAspectRatio !== undefined && typeof value.lockAspectRatio !== 'boolean') {
    throw new Error('Building V2 Window lockAspectRatio must be boolean.');
  }
  if (typeof value.animated !== 'boolean' || typeof value.directionFlip !== 'boolean'
    || typeof value.double !== 'boolean') {
    throw new Error('Building V2 Window setup requires exact animated, hinge, and Double boolean intent.');
  }
  const animation = typeof value.animation === 'string' ? value.animation.trim().toLowerCase() : '';
  if (!BUILDING_V2_WINDOW_ANIMATION_TYPES.includes(animation) || ![1, -1].includes(value.direction)) {
    throw new Error('Building V2 Window setup requires a supported Foundry v14 animation type and direction.');
  }
  const timing = normalizeBuildingV2PortalTiming(value);
  normalizeBuildingV2PortalSound(value.doorSound);
  const surface = normalizeBuildingV2WindowElement(value.surface, { label: 'surface element', allowAspectScale: true });
  if (value.animated && !surface) {
    throw new Error('Building V2 animated Window requires a snapshotted surface element.');
  }
  return {
    sill: normalizeBuildingV2WindowElement(value.sill, { label: 'sill element' }),
    surface,
    frame: normalizeBuildingV2DoorFrame(value.frame),
    ...(value.duration !== undefined ? { duration: timing.duration } : {}),
    ...(value.strength !== undefined ? { strength: timing.strength } : {}),
    ...(value.doorSound !== undefined ? { doorSound: value.doorSound } : {}),
    animated: value.animated,
    ...(value.lockAspectRatio !== undefined ? { lockAspectRatio: value.lockAspectRatio } : {}),
    animation,
    direction: value.direction,
    directionFlip: value.directionFlip,
    double: value.double,
    textureFlip: normalizeTextureFlip(value.textureFlip)
  };
}

function requireChord(endpointsLocal) {
  if (!Array.isArray(endpointsLocal) || endpointsLocal.length !== 2) {
    throw new Error('Building V2 Window requires two exact Building-local jamb endpoints.');
  }
  const a = normalizePoint(endpointsLocal[0], 'first jamb endpoint');
  const b = normalizePoint(endpointsLocal[1], 'second jamb endpoint');
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) throw new Error('Building V2 Window requires a non-zero jamb chord.');
  return {
    a, b, dx, dy, length,
    ux: dx / length, uy: dy / length,
    nx: (-dy / length) || 0, ny: (dx / length) || 0,
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    rotation: Math.atan2(dy, dx)
  };
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
  const xs = corners.map(({ x }) => x);
  const ys = corners.map(({ y }) => y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...xs), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function compileElementSprite({ portalId, element, chord, role, textureFlip = null }) {
  const widthMultiplier = isSmallPortalTexturePath(element.asset.src) ? 2 : 1;
  const width = chord.length * widthMultiplier;
  const height = element.sourceHeight * (element.gridSize / SOURCE_GRID_PIXELS) * element.scale;
  const along = element.offsetX * width * 0.5;
  const normal = element.offsetY * height * 0.5;
  return {
    id: `${portalId}:${role}`,
    role,
    textureSrc: element.asset.src,
    sourceFrame: null,
    x: chord.center.x + (chord.ux * along) + (chord.nx * normal),
    y: chord.center.y + (chord.uy * along) + (chord.ny * normal),
    width,
    height,
    rotation: chord.rotation,
    flipX: textureFlip?.horizontal ? -1 : 1,
    flipY: textureFlip?.vertical ? -1 : 1,
    hsbc: element.hsbc
  };
}

function materializeSillShadowFlags(shadow) {
  const normalized = normalizeBuildingV2DoorShadow(shadow);
  if (!normalized.enabled) return { shadow: false };
  const offsetX = normalized.normal.x * normalized.offset;
  const offsetY = normalized.normal.y * normalized.offset;
  return {
    shadow: true,
    shadowAlpha: normalized.alpha,
    shadowBlur: normalized.blur,
    shadowDilation: normalized.dilation,
    shadowOffsetDistance: Math.abs(normalized.offset),
    shadowOffsetAngle: ((Math.atan2(offsetY, offsetX) * (180 / Math.PI)) + 360) % 360,
    shadowOffsetX: offsetX,
    shadowOffsetY: offsetY
  };
}

export function createBuildingV2WindowContainedShadow(normal = { x: 0, y: 1 }) {
  return normalizeBuildingV2DoorShadow({ ...WINDOW_CONTAINED_SHADOW, normal });
}

export function compileBuildingV2WindowArtwork({ portalId, setup, endpointsLocal } = {}) {
  const id = typeof portalId === 'string' ? portalId.trim() : '';
  if (!id) throw new Error('Building V2 Window artwork requires its Portal identity.');
  const normalized = normalizeBuildingV2WindowSetup(setup);
  const chord = requireChord(endpointsLocal);
  const entries = [];
  if (!normalized.animated && normalized.surface) {
    const sprite = compileElementSprite({
      portalId: id, element: normalized.surface, chord, role: 'surface', textureFlip: normalized.textureFlip
    });
    entries.push({
      kind: 'window-surface', portalId: id, setup: normalized,
      endpointsLocal: [chord.a, chord.b],
      shadow: createBuildingV2WindowContainedShadow({ x: chord.nx, y: chord.ny }),
      bounds: spriteBounds(sprite), artwork: [sprite]
    });
  }
  if (normalized.frame) {
    const compiled = compileBuildingV2DoorFrame({
      portalId: id, frame: normalized.frame, endpointsLocal: [chord.a, chord.b], gridSize: normalized.frame.gridSize
    });
    entries.push({ ...compiled, kind: 'window-frame', setup: normalized });
  }
  return entries;
}

export function compileBuildingV2WindowSills({
  portalId,
  setup,
  endpointsLocal,
  shadow,
  elevation = 0,
  sort = 0
} = {}) {
  const id = typeof portalId === 'string' ? portalId.trim() : '';
  if (!id) throw new Error('Building V2 Window sill projection requires its Portal identity.');
  const normalized = normalizeBuildingV2WindowSetup(setup);
  const chord = requireChord(endpointsLocal);
  if (!normalized.sill) return [];
  const normalizedShadow = normalizeBuildingV2DoorShadow(shadow);
  const shadowFlags = materializeSillShadowFlags(normalizedShadow);
  const sprite = compileElementSprite({ portalId: id, element: normalized.sill, chord, role: 'sill' });
  const element = normalized.sill;
  const resolvedElevation = finite(elevation, 'sill-part elevation');
  const resolvedSort = finite(sort, 'sill-part sort');
  return [{
    id: `${id}:sill`, kind: 'sill', role: 'sill', elementType: 'sill',
    flagKey: 'buildingWindowSill', gapId: id,
    x: sprite.x, y: sprite.y, width: sprite.width, height: sprite.height,
    rotation: sprite.rotation * (180 / Math.PI), alpha: 1,
    elevation: resolvedElevation, sort: resolvedSort,
    texture: { src: element.asset.src, anchorX: 0.5, anchorY: 0.5 },
    endpointsLocal: [chord.a, chord.b],
    shadow: normalizedShadow,
    flags: {
      buildingWindowSill: {
        gapId: id, sourceTextureKey: element.asset.key, sourceTextureLocal: element.asset.src,
        sourceWidth: element.sourceWidth, sourceHeight: element.sourceHeight, assetGridSize: element.gridSize,
        scale: element.scale, offsetX: element.offsetX, offsetY: element.offsetY,
        elementType: 'sill', hsbc: element.hsbc, gapLength: chord.length,
        ...shadowFlags
      },
      hsbc: element.hsbc,
      ...shadowFlags
    },
    hsbc: element.hsbc
  }];
}

export function materializeBuildingV2WindowWall(setup, {
  a,
  b,
  dir = 0,
  state = 0,
  behavior = null,
  scale = 1,
  sceneGridSize, reflected = false
} = {}) {
  const normalized = normalizeBuildingV2WindowSetup(setup);
  const chord = requireChord([a, b]);
  const sceneScale = finite(scale, 'positive Building Instance Scale');
  const currentSceneGridSize = finite(sceneGridSize, 'positive Scene grid size');
  if (!(sceneScale > 0)) throw new Error('Building V2 Window requires a positive Building Instance Scale.');
  if (!(currentSceneGridSize > 0)) throw new Error('Building V2 Window requires a positive Scene grid size.');
  if (![0, 1, 2].includes(dir) || ![0, 1, 2].includes(state)) {
    throw new Error('Building V2 Window requires a valid native direction and state.');
  }
  if (!normalized.animated && state !== 0) {
    throw new Error('Building V2 static Window cannot retain native Portal live state.');
  }
  const endpoints = normalized.animated && normalized.directionFlip ? [chord.b, chord.a] : [chord.a, chord.b];
  const result = {
    c: endpoints.flatMap((point) => [roundBuildingV2NativeCoordinate(point.x), roundBuildingV2NativeCoordinate(point.y)]),
    door: normalized.animated ? 2 : 0,
    ds: normalized.animated ? state : 0,
    light: FOUNDRY_V14_PROXIMITY_SENSE,
    sight: FOUNDRY_V14_PROXIMITY_SENSE,
    threshold: { light: 10, sight: 10, sound: null, attenuation: true },
    ...(behavior ? normalizeBuildingStructuralWallBehavior(behavior, { constants: globalThis.CONST, sparse: false, path: 'Window Behavior' }) : {}),
    // Hinge mapping is applied after semantic structural direction.
    dir: normalized.animated && normalized.directionFlip && dir ? 3 - dir : dir,
    ...(normalized.doorSound !== undefined ? { doorSound: normalized.doorSound } : {}),
    textureFlip: normalized.textureFlip,
    textureGridSize: normalized.surface
      ? (SOURCE_GRID_PIXELS * currentSceneGridSize)
        / (normalized.surface.gridSize * normalized.surface.scale * sceneScale)
      : SOURCE_GRID_PIXELS
  };
  if (normalized.animated) {
    result.animation = {
      type: normalized.animation,
      direction: normalized.direction,
      double: normalized.double,
      ...normalizeBuildingV2PortalTiming(normalized),
      flip: normalized.textureFlip.vertical,
      texture: normalized.surface.asset.src
    };
    const { normal: _normal, ...windowShadow } = createBuildingV2WindowContainedShadow();
    result.windowShadow = windowShadow;
  }
  if (reflected) {
    result.dir = result.dir ? 3 - result.dir : 0;
    result.textureFlip = { ...result.textureFlip, vertical: !result.textureFlip.vertical };
    if (result.animation) { result.animation.direction *= -1; result.animation.flip = !result.animation.flip; }
  }
  return result;
}

export function materializeBuildingV2WindowSills(parts, { rootSource, building, elevation, sort } = {}) {
  return transformBuildingV2WindowSills(parts, { pose: deriveBuildingV2SpatialPose(rootSource, building), elevation, sort });
}

export function transformBuildingV2WindowSills(parts, { pose, elevation, sort } = {}) {
  if (!Array.isArray(parts)) throw new Error('Building V2 Window sill materialization requires Building-local parts.');
  const resolvedElevation = finite(elevation, 'managed sill elevation');
  const resolvedSort = finite(sort, 'managed sill sort');
  const transform = createBuildingV2SpatialTransform(pose);
  return parts.map((part) => {
    if (!part || part.role !== 'sill' || part.flagKey !== 'buildingWindowSill'
      || !Number.isFinite(part.x) || !Number.isFinite(part.y)
      || !(Number.isFinite(part.width) && part.width > 0)
      || !(Number.isFinite(part.height) && part.height > 0)
      || !Number.isFinite(part.rotation)) {
      throw new Error('Building V2 Window sill materialization requires exact positive Building-local sill parts.');
    }
    const center = transform.localToWorld({ x: part.x, y: part.y });
    const shadow = materializeBuildingV2DoorShadow(part.shadow, { scale: pose.scale, transform });
    const shadowFlags = materializeSillShadowFlags(shadow);
    return {
      ...structuredClone(part),
      x: center.x,
      y: center.y,
      width: part.width * pose.scale,
      height: part.height * pose.scale,
      rotation: ((pose.flipX === true) !== (pose.flipY === true) ? -part.rotation : part.rotation) + pose.rotation,
      ...(pose.flipX || pose.flipY ? { texture: { ...part.texture, scaleX: (Number(part.texture?.scaleX) || 1) * (pose.flipX ? -1 : 1), scaleY: (Number(part.texture?.scaleY) || 1) * (pose.flipY ? -1 : 1) } } : {}),
      elevation: resolvedElevation,
      sort: resolvedSort,
      shadow,
      flags: {
        ...structuredClone(part.flags),
        buildingWindowSill: {
          ...structuredClone(part.flags.buildingWindowSill),
          ...shadowFlags
        },
        ...shadowFlags
      }
    };
  });
}

export function resolveBuildingV2WindowSillsPlacement({ fillElevation, fillSort } = {}) {
  return {
    elevation: finite(fillElevation, 'Fill elevation') + WINDOW_SILL_FLOOR_OFFSET,
    sort: finite(fillSort, 'Fill sort')
  };
}

export function scaleBuildingV2WindowSetupGridBasis(setup, scale) {
  const normalized = normalizeBuildingV2WindowSetup(setup);
  const factor = finite(scale, 'positive materialization scale');
  if (!(factor > 0)) throw new Error('Building V2 Window materialization scale must be positive.');
  const scaleElement = (element) => element ? { ...element, gridSize: element.gridSize * factor } : null;
  return {
    ...normalized,
    sill: scaleElement(normalized.sill),
    surface: scaleElement(normalized.surface),
    frame: normalized.frame ? { ...normalized.frame, gridSize: normalized.frame.gridSize * factor } : null
  };
}
