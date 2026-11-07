import { deriveMaskedTilingResizeCommit } from '../textures/masked-tiling-resize-contract.js';
import { deriveScatterNativeResizeCommit } from '../assets/asset-scatter-tile-transform.js';
import { derivePathResizeCommit } from '../paths/path-resize-contract.js';
import {
  transformSemanticTileFlags,
  translateSemanticTileFlags
} from '../composition/scene-group-tile-transform.js';

const MODULE_ID = 'fa-nexus';
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone !== 'function') {
    throw new Error('Flattened Tile transforms require structuredClone.');
  }
  return structuredClone(value);
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

function normalizeAngle(value) {
  return clean(((Number(value) % 360) + 360) % 360);
}

function validateTilePose(tile, label) {
  const pose = readFlattenedTilePose(tile);
  if (['x', 'y', 'width', 'height'].some((field) => finite(pose[field]) == null)) {
    throw new Error(`Flattened Tile transform requires finite ${label} Tile geometry.`);
  }
  if (!(pose.width > 0) || !(pose.height > 0)) {
    throw new Error(`Flattened Tile transform requires positive ${label} Tile dimensions.`);
  }
  return pose;
}

export function readFlattenedTilePose(tile) {
  const source = tile?._source || tile || {};
  const texture = source.texture || tile?.texture || {};
  return {
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
}

function localPointToWorld(tile, point) {
  const radians = tile.rotation * DEG_TO_RAD;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point.x - (tile.width * tile.texture.anchorX);
  const y = point.y - (tile.height * tile.texture.anchorY);
  return {
    x: clean(tile.x + (x * cosine) - (y * sine)),
    y: clean(tile.y + (x * sine) + (y * cosine))
  };
}

function worldPointToLocal(tile, point) {
  const radians = -tile.rotation * DEG_TO_RAD;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point.x - tile.x;
  const y = point.y - tile.y;
  return {
    x: clean((x * cosine) - (y * sine) + (tile.width * tile.texture.anchorX)),
    y: clean((x * sine) + (y * cosine) + (tile.height * tile.texture.anchorY))
  };
}

function createWrapperTransform(originalTile, finalTile) {
  let scaleX = finalTile.width / originalTile.width;
  let scaleY = finalTile.height / originalTile.height;
  const integerRoundingDelta = (0.5 / originalTile.width) + (0.5 / originalTile.height);
  if (Math.abs(scaleX - scaleY) <= integerRoundingDelta + 1e-9) {
    // Scene Group scaling is uniform, but Foundry persists integer Tile width
    // and height independently. Project that bounded rounding noise back onto
    // one affine scale before transforming rotated flattened source Tiles;
    // otherwise a valid gesture can be misclassified as unrepresentable shear.
    const uniformScale = (scaleX + scaleY) / 2;
    scaleX = uniformScale;
    scaleY = uniformScale;
  }
  return {
    scaleX,
    scaleY,
    point(point) {
      const local = worldPointToLocal(originalTile, point);
      return localPointToWorld(finalTile, {
        x: local.x * scaleX,
        y: local.y * scaleY
      });
    }
  };
}

function readBoundsCorners(bounds) {
  if (!bounds || typeof bounds !== 'object') return clone(bounds);
  const x = finite(bounds.x ?? bounds.minX);
  const y = finite(bounds.y ?? bounds.minY);
  const width = finite(bounds.width)
    ?? (finite(bounds.maxX) != null && x != null ? finite(bounds.maxX) - x : null);
  const height = finite(bounds.height)
    ?? (finite(bounds.maxY) != null && y != null ? finite(bounds.maxY) - y : null);
  if ([x, y, width, height].some((value) => value == null)) return null;
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height }
  ];
}

function transformBounds(bounds, transform, priorCorners = null) {
  const sourceCorners = Array.isArray(priorCorners) && priorCorners.length === 4
    && priorCorners.every((point) => finite(point?.x) != null && finite(point?.y) != null)
    ? priorCorners
    : readBoundsCorners(bounds);
  if (!sourceCorners) return { bounds: clone(bounds), corners: null };
  const corners = sourceCorners.map((point) => transform.point(point));
  const minX = Math.min(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxX = Math.max(...corners.map((point) => point.x));
  const maxY = Math.max(...corners.map((point) => point.y));
  const next = clone(bounds);
  if ('x' in bounds) next.x = clean(minX);
  if ('y' in bounds) next.y = clean(minY);
  if ('minX' in bounds) next.minX = clean(minX);
  if ('minY' in bounds) next.minY = clean(minY);
  if ('maxX' in bounds) next.maxX = clean(maxX);
  if ('maxY' in bounds) next.maxY = clean(maxY);
  if ('width' in bounds) next.width = clean(maxX - minX);
  if ('height' in bounds) next.height = clean(maxY - minY);
  return { bounds: next, corners };
}

const BUILDING_SEMANTIC_FLAGS = [
  'building',
  'buildingComposite',
  'buildingDoorFrame',
  'buildingWindowFrame',
  'buildingWindowWindow',
  'buildingWindowSill'
];
const SCALE_SENSITIVE_SHADOW_FIELDS = [
  'shadowBlur',
  'shadowDilation',
  'shadowOffsetDistance',
  'shadowOffsetX',
  'shadowOffsetY'
];

function vectorDistance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function assertRepresentableTileAxes({ xAxis, yAxis, next, sourceId }) {
  const radians = next.rotation * DEG_TO_RAD;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const representedX = { x: cosine * next.width, y: sine * next.width };
  const representedY = { x: -sine * next.height, y: cosine * next.height };
  const cornerError = Math.max(
    vectorDistance(xAxis, representedX),
    vectorDistance(yAxis, representedY)
  );
  // Foundry persists integer Tile dimensions. Half-pixel rounding on both axes can
  // move an endpoint by at most sqrt(0.5^2 + 0.5^2) pixels; anything larger is
  // affine shear that the Tile schema cannot encode.
  if (cornerError <= Math.SQRT1_2 + 1e-6) return;
  throw new Error(
    `Flattened source Tile ${sourceId} would require shear after this resize; `
    + `Foundry Tiles cannot represent it within the ${Math.SQRT1_2.toFixed(6)}px rounded-corner bound `
    + `(error ${cornerError.toFixed(6)}px).`
  );
}

function hasBuildingSemanticFlags(faFlags) {
  return BUILDING_SEMANTIC_FLAGS.some((key) => faFlags[key]);
}

function transformScaleSensitiveFlags(nextFlags, faFlags, pose, next, sourceId, {
  skipShadows = false,
  shadowScaleX = null,
  shadowScaleY = null
} = {}) {
  const scaleX = next.width / pose.width;
  const scaleY = next.height / pose.height;
  if (scaleX === 1 && scaleY === 1) return;

  if (faFlags.pathV2 || faFlags.pathsV2) {
    const resized = derivePathResizeCommit({
      pathV2: faFlags.pathV2 || null,
      pathsV2: faFlags.pathsV2 || null,
      originalTile: pose,
      finalTile: next
    });
    if (faFlags.pathV2) nextFlags.pathV2 = resized.pathV2;
    if (faFlags.pathsV2) nextFlags.pathsV2 = resized.pathsV2;
  }
  if (faFlags.assetScatter) {
    nextFlags.assetScatter = deriveScatterNativeResizeCommit({
      scatter: faFlags.assetScatter,
      originalTile: pose,
      finalTile: next
    }).scatter;
  }

  const shadowFields = skipShadows
    ? []
    : SCALE_SENSITIVE_SHADOW_FIELDS.filter((field) => finite(faFlags[field]) != null);
  if (!shadowFields.length) return;
  const resolvedScaleX = finite(shadowScaleX) ?? scaleX;
  const resolvedScaleY = finite(shadowScaleY) ?? scaleY;
  const meanScale = (resolvedScaleX + resolvedScaleY) / 2;

  for (const field of ['shadowBlur', 'shadowDilation']) {
    if (finite(faFlags[field]) != null) nextFlags[field] = clean(Number(faFlags[field]) * meanScale);
  }

  const sourceDistance = finite(faFlags.shadowOffsetDistance);
  const sourceAngle = finite(faFlags.shadowOffsetAngle) ?? 0;
  const sourceOffsetX = finite(faFlags.shadowOffsetX);
  const sourceOffsetY = finite(faFlags.shadowOffsetY);
  const radians = sourceAngle * DEG_TO_RAD;
  const vectorX = sourceOffsetX ?? (sourceDistance == null ? null : Math.cos(radians) * sourceDistance);
  const vectorY = sourceOffsetY ?? (sourceDistance == null ? null : Math.sin(radians) * sourceDistance);
  if (vectorX != null || vectorY != null) {
    const transformedX = (vectorX ?? 0) * resolvedScaleX;
    const transformedY = (vectorY ?? 0) * resolvedScaleY;
    if (sourceOffsetX != null) nextFlags.shadowOffsetX = clean(transformedX);
    if (sourceOffsetY != null) nextFlags.shadowOffsetY = clean(transformedY);
    if (sourceDistance != null) {
      nextFlags.shadowOffsetDistance = clean(Math.hypot(transformedX, transformedY));
    }
    if (finite(faFlags.shadowOffsetAngle) != null) {
      nextFlags.shadowOffsetAngle = normalizeAngle(Math.atan2(transformedY, transformedX) * RAD_TO_DEG);
    }
  }
}

function buildingSemanticSubset(faFlags) {
  const keys = new Set([...BUILDING_SEMANTIC_FLAGS, ...SCALE_SENSITIVE_SHADOW_FIELDS, 'maskedTiling']);
  return Object.fromEntries(
    Object.entries(faFlags).filter(([key]) => keys.has(key))
  );
}

function applyBuildingSemanticTransform(faFlags, pose, next, sourceId) {
  let flags = buildingSemanticSubset(faFlags);
  const scaleX = next.width / pose.width;
  const scaleY = next.height / pose.height;
  const dimensionsChanged = next.width !== pose.width || next.height !== pose.height;
  const averageScale = (scaleX + scaleY) / 2;
  const uniformTolerance = Math.max(0.002, Math.abs(averageScale) * 0.002);
  if (dimensionsChanged) {
    if (Math.abs(scaleX - scaleY) > uniformTolerance) {
      throw new Error(
        `Flattened Building source Tile ${sourceId} requires uniform stored geometry; `
        + `received ${scaleX.toFixed(6)} x ${scaleY.toFixed(6)}.`
      );
    }
    flags = transformSemanticTileFlags({
      flags,
      pivot: { x: pose.x, y: pose.y },
      transform: { operation: 'scale', factor: averageScale },
      targetTile: { ...pose, width: next.width, height: next.height }
    });
  }

  const rotationDelta = next.rotation - pose.rotation;
  if (rotationDelta) {
    flags = transformSemanticTileFlags({
      flags,
      pivot: { x: pose.x, y: pose.y },
      transform: { operation: 'rotate', angle: rotationDelta },
      targetTile: { ...pose, width: next.width, height: next.height, rotation: next.rotation }
    });
  }

  const delta = { x: next.x - pose.x, y: next.y - pose.y };
  if (delta.x || delta.y) {
    flags = translateSemanticTileFlags({ flags, delta, targetTile: next });
  }
  return flags;
}

function transformStoredTilePose(data, transform, sourceId = 'unknown') {
  if (!data || typeof data !== 'object') return clone(data);
  const pose = validateTilePose(data, 'stored source');
  const center = transform.point({ x: pose.x, y: pose.y });
  const radians = pose.rotation * DEG_TO_RAD;
  const xAxisEnd = transform.point({
    x: pose.x + (Math.cos(radians) * pose.width),
    y: pose.y + (Math.sin(radians) * pose.width)
  });
  const yAxisEnd = transform.point({
    x: pose.x - (Math.sin(radians) * pose.height),
    y: pose.y + (Math.cos(radians) * pose.height)
  });
  const xAxis = { x: xAxisEnd.x - center.x, y: xAxisEnd.y - center.y };
  const yAxis = { x: yAxisEnd.x - center.x, y: yAxisEnd.y - center.y };
  const next = clone(data);
  next.x = Math.round(center.x);
  next.y = Math.round(center.y);
  next.width = Math.max(1, Math.round(Math.hypot(xAxis.x, xAxis.y)));
  next.height = Math.max(1, Math.round(Math.hypot(yAxis.x, yAxis.y)));
  next.rotation = normalizeAngle(Math.atan2(xAxis.y, xAxis.x) * RAD_TO_DEG);
  assertRepresentableTileAxes({ xAxis, yAxis, next, sourceId });
  const faFlags = data.flags?.[MODULE_ID];
  if (faFlags && typeof faFlags === 'object') {
    next.flags = clone(data.flags);
    const nextFlags = clone(faFlags);
    const buildingSemantic = hasBuildingSemanticFlags(faFlags);
    transformScaleSensitiveFlags(nextFlags, faFlags, pose, next, sourceId, {
      skipShadows: buildingSemantic,
      shadowScaleX: transform.scaleX,
      shadowScaleY: transform.scaleY
    });
    if (!buildingSemantic && faFlags.maskedTiling && typeof faFlags.maskedTiling === 'object') {
      const resized = deriveMaskedTilingResizeCommit({
        maskedTiling: faFlags.maskedTiling,
        originalTile: pose,
        finalTile: next
      });
      if (resized.maskWorld && typeof resized.maskWorld === 'object') {
        resized.maskWorld = clone(resized.maskWorld);
        const originalTopLeft = {
          x: pose.x - (pose.width * pose.texture.anchorX),
          y: pose.y - (pose.height * pose.texture.anchorY)
        };
        const finalTopLeft = {
          x: next.x - (next.width * pose.texture.anchorX),
          y: next.y - (next.height * pose.texture.anchorY)
        };
        if (faFlags.maskedTiling.maskWorld?.origin) {
          resized.maskWorld.origin = {
            x: clean(Number(faFlags.maskedTiling.maskWorld.origin.x) + finalTopLeft.x - originalTopLeft.x),
            y: clean(Number(faFlags.maskedTiling.maskWorld.origin.y) + finalTopLeft.y - originalTopLeft.y)
          };
        }
        if (resized.maskWorld.origin && faFlags.maskedTiling.maskWorld?.offset) {
          resized.maskWorld.offset = {
            x: clean(finalTopLeft.x - resized.maskWorld.origin.x),
            y: clean(finalTopLeft.y - resized.maskWorld.origin.y)
          };
        }
        resized.maskWorld.tile = {
          ...clone(faFlags.maskedTiling.maskWorld?.tile || {}),
          x: next.x,
          y: next.y,
          width: next.width,
          height: next.height,
          rotation: next.rotation,
          anchorX: pose.texture.anchorX,
          anchorY: pose.texture.anchorY
        };
      }
      nextFlags.maskedTiling = resized;
    }
    if (buildingSemantic) {
      Object.assign(nextFlags, applyBuildingSemanticTransform(faFlags, pose, next, sourceId));
    }
    if (faFlags.flattened && typeof faFlags.flattened === 'object') {
      nextFlags.flattened = deriveFlattenedTileTransformCommit({
        flattened: faFlags.flattened,
        originalTile: pose,
        finalTile: next
      }).flattened;
    }
    next.flags[MODULE_ID] = nextFlags;
  }
  return next;
}

function buildWrapperSnapshot(finalTile) {
  const anchorX = finalTile.texture.anchorX;
  const anchorY = finalTile.texture.anchorY;
  return {
    x: clean(finalTile.x),
    y: clean(finalTile.y),
    width: clean(finalTile.width),
    height: clean(finalTile.height),
    rotation: normalizeAngle(finalTile.rotation),
    anchorX: clean(anchorX),
    anchorY: clean(anchorY),
    scaleX: clean(finalTile.texture.scaleX),
    scaleY: clean(finalTile.texture.scaleY),
    topLeftX: clean(finalTile.x - (finalTile.width * anchorX)),
    topLeftY: clean(finalTile.y - (finalTile.height * anchorY))
  };
}

export function deriveFlattenedTileTransformCommit({ flattened, originalTile, finalTile } = {}) {
  if (!flattened || typeof flattened !== 'object') {
    throw new Error('Flattened Tile transform requires stored flatten metadata.');
  }
  const original = validateTilePose(originalTile, 'original');
  const final = validateTilePose(finalTile, 'final');
  const transform = createWrapperTransform(original, final);
  const next = clone(flattened);

  const logicalGeometry = transformBounds(
    flattened.logicalBounds,
    transform,
    flattened.transformGeometry?.logicalBoundsCorners
  );
  const renderGeometry = transformBounds(
    flattened.renderBounds,
    transform,
    flattened.transformGeometry?.renderBoundsCorners
  );
  next.logicalBounds = logicalGeometry.bounds;
  next.renderBounds = renderGeometry.bounds;
  next.transformGeometry = {
    ...clone(flattened.transformGeometry || {}),
    logicalBoundsCorners: logicalGeometry.corners,
    renderBoundsCorners: renderGeometry.corners
  };
  if (flattened.originalPosition && typeof flattened.originalPosition === 'object') {
    next.originalPosition = transform.point(flattened.originalPosition);
  }
  next.wrapperTransform = buildWrapperSnapshot(final);

  if (Array.isArray(flattened.chunks)) {
    next.chunks = flattened.chunks.map((chunk) => ({
      ...clone(chunk),
      x: clean((finite(chunk?.x) ?? 0) * transform.scaleX),
      y: clean((finite(chunk?.y) ?? 0) * transform.scaleY),
      width: clean((finite(chunk?.width) ?? 0) * transform.scaleX),
      height: clean((finite(chunk?.height) ?? 0) * transform.scaleY)
    }));
  }

  if (Array.isArray(flattened.tiles)) {
    next.tiles = flattened.tiles.map((entry) => {
      const clonedEntry = clone(entry);
      const sourceId = entry?.id || entry?.data?._id || 'unknown';
      clonedEntry.data = transformStoredTilePose(entry?.data, transform, sourceId);
      const faFlags = clonedEntry.data?.flags?.[MODULE_ID];
      if (faFlags && typeof faFlags === 'object') clonedEntry.faFlags = clone(faFlags);
      return clonedEntry;
    });
  }

  if (flattened.paddingInsets && typeof flattened.paddingInsets === 'object') {
    next.paddingInsets = clone(flattened.paddingInsets);
    for (const field of ['left', 'right']) {
      if (finite(flattened.paddingInsets[field]) != null) {
        next.paddingInsets[field] = clean(Number(flattened.paddingInsets[field]) * transform.scaleX);
      }
    }
    for (const field of ['top', 'bottom']) {
      if (finite(flattened.paddingInsets[field]) != null) {
        next.paddingInsets[field] = clean(Number(flattened.paddingInsets[field]) * transform.scaleY);
      }
    }
    if (finite(flattened.paddingInsets.max) != null) {
      next.paddingInsets.max = clean(Number(flattened.paddingInsets.max) * Math.max(transform.scaleX, transform.scaleY));
    }
  }
  if (finite(flattened.padding) != null) {
    next.padding = clean(Number(flattened.padding) * Math.max(transform.scaleX, transform.scaleY));
  }
  if (finite(flattened.paddingExtra) != null) {
    next.paddingExtra = clean(Number(flattened.paddingExtra) * Math.max(transform.scaleX, transform.scaleY));
  }
  if (flattened.chunking && typeof flattened.chunking === 'object') {
    next.chunking = clone(flattened.chunking);
    if (finite(flattened.chunking.worldWidth) != null) {
      next.chunking.worldWidth = clean(Number(flattened.chunking.worldWidth) * transform.scaleX);
    }
    if (finite(flattened.chunking.worldHeight) != null) {
      next.chunking.worldHeight = clean(Number(flattened.chunking.worldHeight) * transform.scaleY);
    }
  }

  return {
    flattened: next,
    originalTile: original,
    finalTile: final,
    scaleX: clean(transform.scaleX),
    scaleY: clean(transform.scaleY),
    rotationDelta: clean(final.rotation - original.rotation),
    delta: { x: clean(final.x - original.x), y: clean(final.y - original.y) }
  };
}

export function transformFlattenedMetadataForTarget(flattened, finalTile) {
  return deriveFlattenedTileTransformCommit({
    flattened,
    originalTile: flattened?.wrapperTransform,
    finalTile
  }).flattened;
}

function hasOwn(object, key) {
  return !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

function readChange(changes, path, fallback) {
  if (hasOwn(changes, path)) return changes[path];
  const value = String(path).split('.').reduce((entry, key) => entry?.[key], changes);
  return value === undefined ? fallback : value;
}

function finalTilePose(original, changes) {
  return {
    x: finite(readChange(changes, 'x', original.x)),
    y: finite(readChange(changes, 'y', original.y)),
    width: finite(readChange(changes, 'width', original.width)),
    height: finite(readChange(changes, 'height', original.height)),
    rotation: finite(readChange(changes, 'rotation', original.rotation)) ?? 0,
    texture: {
      anchorX: finite(readChange(changes, 'texture.anchorX', original.texture.anchorX)) ?? 0.5,
      anchorY: finite(readChange(changes, 'texture.anchorY', original.texture.anchorY)) ?? 0.5,
      scaleX: finite(readChange(changes, 'texture.scaleX', original.texture.scaleX)) ?? 1,
      scaleY: finite(readChange(changes, 'texture.scaleY', original.texture.scaleY)) ?? 1
    }
  };
}

export function readFlattenedMetadata(document) {
  const direct = document?.getFlag?.(MODULE_ID, 'flattened');
  if (direct !== undefined) return direct;
  return document?._source?.flags?.[MODULE_ID]?.flattened
    ?? document?.flags?.[MODULE_ID]?.flattened
    ?? null;
}

function hasExplicitFlattenedChange(changes) {
  if (hasOwn(changes, `flags.${MODULE_ID}.flattened`)) return true;
  const moduleFlags = changes?.flags?.[MODULE_ID];
  return hasOwn(moduleFlags, 'flattened') || hasOwn(moduleFlags, '-=flattened');
}

function writeFlattenedChange(changes, flattened) {
  const flatKey = `flags.${MODULE_ID}.flattened`;
  if (hasOwn(changes, flatKey)) {
    changes[flatKey] = flattened;
    return;
  }
  changes.flags ||= {};
  changes.flags[MODULE_ID] ||= {};
  changes.flags[MODULE_ID].flattened = flattened;
}

function tilePoseChanged(original, final) {
  return ['x', 'y', 'width', 'height', 'rotation'].some((field) => original[field] !== final[field])
    || ['anchorX', 'anchorY', 'scaleX', 'scaleY'].some((field) => (
      original.texture[field] !== final.texture[field]
    ));
}

export function applyFlattenedNativeTransformToChanges(document, changes = {}, options = {}) {
  if (!document || !changes || typeof changes !== 'object') {
    return { changed: false, reason: 'invalid-input' };
  }
  if (
    options?.faNexusSceneGroupCommand
    || options?.faNexusFlattenedNativeTransform
    || options?.faNexusFlattenedNativeRollback
  ) {
    return { changed: false, reason: 'managed-transform' };
  }
  const flattened = readFlattenedMetadata(document);
  if (!flattened || typeof flattened !== 'object') {
    return { changed: false, reason: 'not-flattened' };
  }
  if (hasExplicitFlattenedChange(changes)) {
    return { changed: false, reason: 'explicit-flattened-update' };
  }
  const originalTile = validateTilePose(document, 'original');
  const finalTile = validateTilePose(finalTilePose(originalTile, changes), 'final');
  if (!tilePoseChanged(originalTile, finalTile)) {
    return { changed: false, reason: 'pose-unchanged', originalTile, finalTile };
  }
  const commit = deriveFlattenedTileTransformCommit({ flattened, originalTile, finalTile });
  writeFlattenedChange(changes, commit.flattened);
  return {
    changed: true,
    reason: 'native-flattened-transform',
    tileId: String(document?.id || ''),
    ...commit
  };
}
