import { computeAffineScatterInstanceBounds } from './asset-scatter-instance-transform.js';

export function computeScatterInstanceBounds(instance) {
  if (instance?.affine) return computeAffineScatterInstanceBounds(instance);
  const cx = Number(instance.x) || 0;
  const cy = Number(instance.y) || 0;
  const hw = Math.max(1, Number(instance.w) || 0) / 2;
  const hh = Math.max(1, Number(instance.h) || 0) / 2;
  const rot = ((Number(instance.r) || 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const corners = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh }
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const x = cx + corner.x * cos - corner.y * sin;
    const y = cy + corner.x * sin + corner.y * cos;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function computeScatterTileBounds(instances) {
  if (!Array.isArray(instances) || !instances.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const instance of instances) {
    const bounds = computeScatterInstanceBounds(instance);
    if (!bounds) continue;
    if (bounds.minX < minX) minX = bounds.minX;
    if (bounds.minY < minY) minY = bounds.minY;
    if (bounds.maxX > maxX) maxX = bounds.maxX;
    if (bounds.maxY > maxY) maxY = bounds.maxY;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  // A Tile's position is its centre and is stored in whole pixels. An odd
  // width or height would put the centre on a half pixel; every later edit
  // would then read the instances half a pixel off. Sizes are kept even.
  const even = (value) => Math.max(2, value + (value % 2));
  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: even(Math.ceil(maxX) - Math.floor(minX)),
    height: even(Math.ceil(maxY) - Math.floor(minY))
  };
}

export function resolveScatterTileTextureSrc(instances) {
  if (!Array.isArray(instances)) return null;
  for (const instance of instances) {
    if (instance?.src) return instance.src;
  }
  return null;
}

export function buildScatterLocalInstances(instances, bounds) {
  return instances.map((instance) => {
    const localized = {
      id: instance.id,
      src: instance.src,
      x: Number(instance.x) - bounds.x,
      y: Number(instance.y) - bounds.y,
      w: Math.max(1, Number(instance.w) || 0),
      h: Math.max(1, Number(instance.h) || 0),
      r: Number(instance.r) || 0,
      flipH: !!instance.flipH,
      flipV: !!instance.flipV
    };
    if (instance.affine) localized.affine = structuredClone(instance.affine);
    return localized;
  });
}

export function buildScatterTilePayload(instances, { version = 1 } = {}) {
  const bounds = computeScatterTileBounds(instances);
  if (!bounds) return null;
  const localInstances = buildScatterLocalInstances(instances, bounds);
  const textureSrc = resolveScatterTileTextureSrc(instances);
  if (!textureSrc) return null;
  return {
    bounds,
    localInstances,
    textureSrc,
    scatterFlag: {
      version,
      instances: localInstances
    }
  };
}
