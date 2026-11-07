import { buildScatterTilePayload } from './asset-scatter-tile-payload.js';
import {
  resolveScatterInstanceAffine,
  roundScatterTransformNumber,
  transformScatterInstanceGeometry
} from './asset-scatter-instance-transform.js';

const DEG_TO_RAD = Math.PI / 180;

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone !== 'function') throw new Error('Scatter transforms require structuredClone.');
  return structuredClone(value);
}

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function validateTilePose(tile, label) {
  if (!tile || !['x', 'y', 'width', 'height', 'rotation'].every((field) => finite(tile[field]) != null)) {
    throw new Error(`Scatter transform requires finite ${label} Tile geometry.`);
  }
  if (!(Number(tile.width) > 0) || !(Number(tile.height) > 0)) {
    throw new Error(`Scatter transform requires positive ${label} Tile dimensions.`);
  }
}

export function readScatterTilePose(tile, { label = 'source' } = {}) {
  const source = tile?._source || tile || {};
  const texture = source.texture || tile?.texture || {};
  const pose = {
    x: finite(source.x ?? tile?.x),
    y: finite(source.y ?? tile?.y),
    width: finite(source.width ?? tile?.width),
    height: finite(source.height ?? tile?.height),
    rotation: finite(source.rotation ?? tile?.rotation) ?? 0,
    texture: {
      anchorX: finite(texture.anchorX) ?? 0.5,
      anchorY: finite(texture.anchorY) ?? 0.5,
      scaleX: finite(texture.scaleX) ?? 1,
      scaleY: finite(texture.scaleY) ?? 1
    }
  };
  validateTilePose(pose, label);
  return pose;
}

function rotationMatrix(degrees) {
  const radians = Number(degrees) * DEG_TO_RAD;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { a: cosine, b: sine, c: -sine, d: cosine };
}

export function scatterTileLocalPointToWorld(tile, point) {
  validateTilePose(tile, 'source');
  const x = finite(point?.x);
  const y = finite(point?.y);
  if (x == null || y == null) throw new Error('Scatter transform requires a finite local point.');
  const matrix = rotationMatrix(tile.rotation);
  const localX = x - (tile.width * tile.texture.anchorX);
  const localY = y - (tile.height * tile.texture.anchorY);
  return {
    x: roundScatterTransformNumber(tile.x + (matrix.a * localX) + (matrix.c * localY)),
    y: roundScatterTransformNumber(tile.y + (matrix.b * localX) + (matrix.d * localY))
  };
}

export function scatterWorldPointToTileLocal(tile, point) {
  validateTilePose(tile, 'source');
  const x = finite(point?.x);
  const y = finite(point?.y);
  if (x == null || y == null) throw new Error('Scatter transform requires a finite world point.');
  const matrix = rotationMatrix(-tile.rotation);
  const deltaX = x - tile.x;
  const deltaY = y - tile.y;
  return {
    x: roundScatterTransformNumber(
      (matrix.a * deltaX) + (matrix.c * deltaY) + (tile.width * tile.texture.anchorX)
    ),
    y: roundScatterTransformNumber(
      (matrix.b * deltaX) + (matrix.d * deltaY) + (tile.height * tile.texture.anchorY)
    )
  };
}

function transformInstanceAroundTile(instance, tile, degrees) {
  const center = degrees >= 0
    ? scatterTileLocalPointToWorld(tile, instance)
    : scatterWorldPointToTileLocal(tile, instance);
  const matrix = rotationMatrix(degrees);
  const transformed = transformScatterInstanceGeometry(instance, matrix);
  transformed.x = center.x;
  transformed.y = center.y;
  return transformed;
}

export function hydrateScatterInstancesForEdit(instances, tile) {
  const pose = readScatterTilePose(tile);
  return Array.from(instances || []).map((instance) => transformInstanceAroundTile(instance, pose, pose.rotation));
}

export function scatterInstanceGeometrySignature(instances) {
  return JSON.stringify(Array.from(instances || []).map((instance) => ({
    id: String(instance?.id || ''),
    src: String(instance?.src || ''),
    x: roundScatterTransformNumber(Number(instance?.x) || 0),
    y: roundScatterTransformNumber(Number(instance?.y) || 0),
    w: roundScatterTransformNumber(Number(instance?.w) || 0),
    h: roundScatterTransformNumber(Number(instance?.h) || 0),
    r: roundScatterTransformNumber(Number(instance?.r) || 0),
    flipH: !!instance?.flipH,
    flipV: !!instance?.flipV,
    affine: instance?.affine ? resolveScatterInstanceAffine(instance) : null
  })));
}

export function createScatterEditState({ instances, tile } = {}) {
  const tilePose = readScatterTilePose(tile);
  const worldInstances = hydrateScatterInstancesForEdit(instances, tilePose);
  return {
    tilePose,
    worldInstances,
    baselineSignature: scatterInstanceGeometrySignature(worldInstances)
  };
}

export function hasScatterEditGeometryChanges(instances, baselineSignature) {
  return scatterInstanceGeometrySignature(instances) !== String(baselineSignature || '');
}

function localizeWorldInstancesForTile(instances, tile) {
  const inverseRotation = rotationMatrix(-tile.rotation);
  return Array.from(instances || []).map((instance) => {
    const localCenter = scatterWorldPointToTileLocal(tile, instance);
    const transformed = transformScatterInstanceGeometry(instance, inverseRotation);
    transformed.x = localCenter.x;
    transformed.y = localCenter.y;
    return transformed;
  });
}

export function buildScatterEditCommit({ worldInstances, tile, version = 1 } = {}) {
  const pose = readScatterTilePose(tile);
  const tileAlignedInstances = localizeWorldInstancesForTile(worldInstances, pose);
  const scatterPayload = buildScatterTilePayload(tileAlignedInstances, { version });
  if (!scatterPayload) return null;
  const { bounds } = scatterPayload;
  const anchorLocal = {
    x: bounds.x + (bounds.width * pose.texture.anchorX),
    y: bounds.y + (bounds.height * pose.texture.anchorY)
  };
  const anchorWorld = scatterTileLocalPointToWorld(pose, anchorLocal);
  return {
    scatterPayload,
    tilePose: {
      x: anchorWorld.x,
      y: anchorWorld.y,
      width: bounds.width,
      height: bounds.height,
      rotation: pose.rotation,
      texture: clone(pose.texture)
    }
  };
}

export function deriveScatterNativeResizeCommit({ scatter, originalTile, finalTile } = {}) {
  const original = readScatterTilePose(originalTile, { label: 'original' });
  const final = readScatterTilePose(finalTile, { label: 'final' });
  const scaleX = final.width / original.width;
  const scaleY = final.height / original.height;
  if (![scaleX, scaleY].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Scatter native resize requires positive finite scale factors.');
  }
  const next = clone(scatter);
  next.instances = Array.from(scatter?.instances || []).map((instance) => (
    transformScatterInstanceGeometry(instance, { a: scaleX, b: 0, c: 0, d: scaleY })
  ));
  return {
    scaleX: roundScatterTransformNumber(scaleX),
    scaleY: roundScatterTransformNumber(scaleY),
    scatter: next
  };
}

export { resolveScatterInstanceAffine } from './asset-scatter-instance-transform.js';
