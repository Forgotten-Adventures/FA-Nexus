import {
  createBuildingV2RefitPlan,
  createBuildingV2SpatialTransform,
  deriveBuildingV2SpatialPose
} from './building-v2-spatial-transform.js';
import {
  hasActiveBuildingV2Fill,
  representativeBuildingV2Fill,
  compileBuildingV2FillMaskSource,
  materializeBuildingV2FillMask,
  projectBuildingV2FillMaskToManagedTile,
  validateBuildingV2FillMaskSource
} from './building-v2-fill-mask-runtime.js';
import { invalidateCustomTileOverhead } from '../../canvas/custom-tile-overhead.js';
import { resolveMaskedTilingRepeatTransform } from '../../textures/masked-tiling-resize-contract.js';
import {
  clearTileEventModeBlocked,
  markTileEventModeBlocked,
  TILE_EVENT_MODE_EDIT_BLOCK_KEY
} from '../../layers/layer-selection-interactivity-runtime.js';
import { createBuildingV2WallBehaviorRuntime } from './building-v2-wall-behavior-runtime.js';
import { validateBuildingV2OpeningProjection, validateBuildingV2DoorWall, validateBuildingV2WindowWall, materializeBuildingV2DoorWall } from './building-v2-opening-runtime.js';
import { materializeBuildingV2WindowSills, materializeBuildingV2WindowWall } from './building-v2-window.js';
import { materializeBuildingV2SurfaceRegionShapes, validateBuildingV2SurfaceRegionProjection } from './building-v2-surface-region-runtime.js';
import { createBuildingV053MigrationPreflightCapture } from './building-v2-v053-migration-preflight.js';
import { resolveBuildingV2SplineSpan } from './building-v2-spline-runtime.js';

const MODULE_ID = 'fa-nexus';

function clone(value) {
  if (value === undefined) return undefined;
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function immutableCopy(value) {
  return deepFreeze(clone(value));
}

async function waitForTwoClientFrames() {
  if (typeof globalThis.requestAnimationFrame !== 'function') return;
  await new Promise((resolve) => globalThis.requestAnimationFrame(() => {
    globalThis.requestAnimationFrame(resolve);
  }));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  const input = JSON.stringify(canonicalize(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function sameValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function fingerprintBuildingV2Authoring(value) {
  return fingerprint(value);
}

/** Native Wall visibility is independent of the Root's artwork Parent Level. */
export function readBuildingV2NativeWallLevelIds(root) {
  const building = readFlag(root, 'building');
  const expected = building?.runtime?.expectedGeneratedDocuments;
  if (![4, 5].includes(Number(building?.schemaVersion)) || !Array.isArray(expected)) {
    throw new Error('Building V2 edit Level requires a committed generated-document manifest.');
  }
  const walls = expected.filter(entry => entry?.documentName === 'Wall' && ['wall', 'portal'].includes(entry.role))
    .map(entry => {
      const wall = collectionGet(root.parent?.walls, entry.documentId);
      const owner = readFlag(wall, 'buildingGenerated');
      if (!wall || owner?.rootTileId !== root.id || owner?.buildingId !== building.buildingId
        || owner?.generationId !== building.runtime.generationId || owner?.role !== entry.role) {
        throw new Error(`Building V2 edit Level cannot resolve owned native Wall ${entry.documentId}.`);
      }
      return sourceOf(wall);
    });
  const levels = clone(walls[0]?.levels || []);
  if (!walls.every(wall => sameValue(wall.levels || [], levels))) {
    throw new Error('Building V2 Current Building Snapshot requires one exact shared native Wall Level scope.');
  }
  return levels;
}

function sameFiniteNumber(left, right, epsilon = 1e-6) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;
}

function requireManagedFillAuthoring(fill) {
  fill = representativeBuildingV2Fill(fill);
  const key = String(fill?.asset?.key || '').trim();
  const src = String(fill?.asset?.src || '').trim();
  const gridWidth = Number(fill?.asset?.gridWidth);
  const gridHeight = Number(fill?.asset?.gridHeight);
  const opacity = Number(fill?.appearance?.opacity);
  const basisVersion = Number(fill?.textureBasis?.version);
  const originX = Number(fill?.textureBasis?.origin?.x);
  const originY = Number(fill?.textureBasis?.origin?.y);
  const hsbc = fill?.appearance?.hsbc;
  if (!key || !src || !(gridWidth > 0) || !(gridHeight > 0)
    || !Number.isFinite(opacity) || opacity < 0 || opacity > 1
    || basisVersion !== 1 || !Number.isFinite(originX) || !Number.isFinite(originY)
    || !hsbc || !['hue', 'saturation', 'brightness', 'contrast']
      .every((field) => Number.isFinite(Number(hsbc[field])))) {
    throw new Error('Building V2 Current Building Snapshot requires exact active Fill authoring state.');
  }
  return { key, src };
}

function managedFillPoseMatchesRoot(fillSource, rootSource) {
  return ['x', 'y', 'width', 'height', 'rotation'].every((path) => (
    sameFiniteNumber(fillSource?.[path], rootSource?.[path])
  )) && ['anchorX', 'anchorY'].every((path) => (
    sameFiniteNumber(fillSource?.texture?.[path], rootSource?.texture?.[path])
  ));
}

const BUILDING_SILLS_TEXTURE_SRC = 'modules/fa-nexus/images/transparent.png';
const BUILDING_SILLS_SOURCE = 'building-v2-window-sills';
const BUILDING_SILLS_FLAG_KEYS = Object.freeze([
  'version', 'source', 'wallTileId', 'buildingId', 'partsKey', 'parts'
]);

function managedSillsPoseMatchesRoot(sillsSource, rootSource) {
  return ['x', 'y', 'width', 'height', 'rotation'].every((path) => (
    sameFiniteNumber(sillsSource?.[path], rootSource?.[path])
  )) && ['anchorX', 'anchorY'].every((path) => (
    sameFiniteNumber(sillsSource?.texture?.[path], rootSource?.texture?.[path])
  ));
}

function exactBuildingSillsFlag(flag, { rootTileId, buildingId } = {}) {
  return !!flag && Object.keys(flag).sort().join('|') === [...BUILDING_SILLS_FLAG_KEYS].sort().join('|')
    && Number(flag.version) === 1 && flag.source === BUILDING_SILLS_SOURCE
    && flag.wallTileId === rootTileId && flag.buildingId === buildingId
    && Array.isArray(flag.parts) && flag.parts.length > 0 && flag.partsKey === fingerprint(flag.parts);
}

function requireCompatibleFillProjectionBaseline(maskedTiling, rootSource) {
  const prior = maskedTiling?.maskWorld?.tile;
  const originalSize = maskedTiling?.maskOriginalSize;
  const origin = maskedTiling?.maskWorld?.origin;
  if (!prior || !originalSize || !origin
    || !['rotation', 'anchorX', 'anchorY'].every((field) => Number.isFinite(Number(prior[field])))
    || !['width', 'height'].every((field) => Number.isFinite(Number(originalSize[field])))
    || !['x', 'y'].every((field) => Number.isFinite(Number(origin[field])))) {
    throw new Error('Building V2 Current Building Snapshot managed Fill lacks an exact projection baseline.');
  }
  if (!(Number(rootSource?.width) > 0) || !(Number(rootSource?.height) > 0)
    || !(Number(originalSize.width) > 0) || !(Number(originalSize.height) > 0)) {
    throw new Error('Building V2 Current Building Snapshot managed Fill projection is incompatible with the current Root transform.');
  }
  const width = Number(originalSize.width);
  const height = Number(originalSize.height);
  const anchorX = Number(prior.anchorX);
  const anchorY = Number(prior.anchorY);
  return {
    x: Number(origin.x) + (width * anchorX),
    y: Number(origin.y) + (height * anchorY),
    width,
    height,
    rotation: Number(prior.rotation),
    texture: { anchorX, anchorY }
  };
}

function rendererProjectionAuthority(value) {
  const projection = clone(value || {});
  if (projection.maskType === 'composite') {
    projection.regions = (projection.regions || []).map((region) => ({
      ...region,
      ...(region.maskedTiling ? { maskedTiling: rendererProjectionAuthority(region.maskedTiling) } : {})
    }));
  }
  if (projection?.maskWorld) delete projection.maskWorld.tile;
  if (projection?.maskWorld?.origin) {
    const cleanOriginNumber = (candidate) => {
      const rounded = Math.round(Number(candidate) * 1e9) / 1e9;
      return Object.is(rounded, -0) ? 0 : rounded;
    };
    projection.maskWorld.origin = {
      x: cleanOriginNumber(projection.maskWorld.origin.x),
      y: cleanOriginNumber(projection.maskWorld.origin.y)
    };
  }
  projection.textureRepeatTransform = resolveMaskedTilingRepeatTransform(projection);
  return projection;
}

function rendererProjectionMismatchFields(actual, expected) {
  const fields = [
    'regions', 'maskType', 'maskVersion', 'maskShapes', 'maskShapeKey', 'maskOriginalSize', 'maskCrop',
    'maskWorld', 'texturePhase', 'textureOffset', 'buildingLocalTextureBasis', 'sourceFingerprint',
    'textureRepeatTransform'
  ];
  return fields.filter((field) => !sameValue(actual?.[field], expected?.[field]));
}

function projectedOuterAppearance(value = {}) {
  const finiteOr = (candidate, fallback) => Number.isFinite(Number(candidate)) ? Number(candidate) : fallback;
  return {
    scalePercent: finiteOr(value.scalePercent, 100),
    textureOffset: {
      x: finiteOr(value.textureOffset?.x, 0),
      y: finiteOr(value.textureOffset?.y, 0)
    },
    textureFlip: {
      horizontal: value.textureFlip?.horizontal === true,
      vertical: value.textureFlip?.vertical === true
    },
    layerOpacity: finiteOr(value.layerOpacity, 1),
    hsbc: {
      hue: finiteOr(value.hsbc?.hue, 0),
      saturation: finiteOr(value.hsbc?.saturation, 1),
      brightness: finiteOr(value.hsbc?.brightness, 1),
      contrast: finiteOr(value.hsbc?.contrast, 1)
    },
    pathShadow: clone(value.pathShadow || null)
  };
}

function recoverInterruptedOuterAppearance(building, authoring) {
  // This legacy recovery proves agreement for one complete outer-only section.
  // Never infer aggregate defaults from just the first loop of a larger Building.
  if (authoring?.outerTopology?.exteriorLoopIds?.length !== 1
    || authoring?.outerTopology?.holeLoopIds?.length
    || Object.keys(authoring?.innerWallPathsById || {}).length
    || Object.keys(authoring?.interiorPathsById || {}).length) return null;
  const loopId = authoring?.outerTopology?.exteriorLoopIds?.[0];
  const loop = loopId ? authoring?.outerTopology?.loopsById?.[loopId] : null;
  const semanticIds = Array.isArray(loop?.edges)
    ? loop.edges.map((edge) => String(edge?.semanticWallId || ''))
    : [];
  const runtimeSections = building?.runtime?.wallSections;
  const renderSegments = building?.wall?.renderSegments;
  if (semanticIds.length < 3 || runtimeSections?.length !== 1 || renderSegments?.length !== 1) return null;
  if (!sameValue(runtimeSections[0]?.semanticWallIds || [], semanticIds)) return null;
  if (semanticIds.some((id) => authoring?.semanticWallsById?.[id]?.appearanceOverride != null)) return null;

  const sectionAppearance = projectedOuterAppearance(runtimeSections[0]);
  const compatibilityAppearance = projectedOuterAppearance(building.wall);
  const segmentAppearance = projectedOuterAppearance(renderSegments[0]);
  if (!sameValue(sectionAppearance, compatibilityAppearance)
    || !sameValue(sectionAppearance, segmentAppearance)) return null;

  const authoredAppearance = projectedOuterAppearance(authoring?.defaults?.outerWallAppearance);
  if (sameValue(authoredAppearance, sectionAppearance)) return null;
  const recovered = clone(authoring);
  recovered.defaults.outerWallAppearance = {
    ...recovered.defaults.outerWallAppearance,
    ...clone(sectionAppearance)
  };
  return recovered;
}

function sourceOf(document) {
  return clone(document?.toObject?.() || document?._source || document || {});
}

function collectionGet(collection, id) {
  return collection?.get?.(id)
    || Array.from(collection || []).find((entry) => String(entry?.id || entry?._id || '') === id)
    || null;
}

function collectionValues(collection) {
  if (typeof collection?.values === 'function') return Array.from(collection.values());
  return Array.from(collection || []);
}

function readFlag(document, key) {
  try {
    const value = document?.getFlag?.(MODULE_ID, key);
    if (value !== undefined) return value;
  } catch (_) {}
  return document?.flags?.[MODULE_ID]?.[key] ?? document?._source?.flags?.[MODULE_ID]?.[key];
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Building V2 Current Building Snapshot requires finite ${label}.`);
  return number;
}

const TOPOLOGY_EPSILON = 1e-6;

function samePoint(left, right) {
  return Math.abs(Number(left?.x) - Number(right?.x)) <= TOPOLOGY_EPSILON
    && Math.abs(Number(left?.y) - Number(right?.y)) <= TOPOLOGY_EPSILON;
}

function crossProduct(a, b, c) {
  return ((Number(b.x) - Number(a.x)) * (Number(c.y) - Number(a.y)))
    - ((Number(b.y) - Number(a.y)) * (Number(c.x) - Number(a.x)));
}

function pointOnSegment(point, start, end) {
  return Math.abs(crossProduct(start, end, point)) <= TOPOLOGY_EPSILON
    && Number(point.x) >= Math.min(Number(start.x), Number(end.x)) - TOPOLOGY_EPSILON
    && Number(point.x) <= Math.max(Number(start.x), Number(end.x)) + TOPOLOGY_EPSILON
    && Number(point.y) >= Math.min(Number(start.y), Number(end.y)) - TOPOLOGY_EPSILON
    && Number(point.y) <= Math.max(Number(start.y), Number(end.y)) + TOPOLOGY_EPSILON;
}

function segmentsIntersectOrTouch(a, b, c, d) {
  const abC = crossProduct(a, b, c);
  const abD = crossProduct(a, b, d);
  const cdA = crossProduct(c, d, a);
  const cdB = crossProduct(c, d, b);
  if (((abC > TOPOLOGY_EPSILON && abD < -TOPOLOGY_EPSILON) || (abC < -TOPOLOGY_EPSILON && abD > TOPOLOGY_EPSILON))
    && ((cdA > TOPOLOGY_EPSILON && cdB < -TOPOLOGY_EPSILON) || (cdA < -TOPOLOGY_EPSILON && cdB > TOPOLOGY_EPSILON))) {
    return true;
  }
  return (Math.abs(abC) <= TOPOLOGY_EPSILON && pointOnSegment(c, a, b))
    || (Math.abs(abD) <= TOPOLOGY_EPSILON && pointOnSegment(d, a, b))
    || (Math.abs(cdA) <= TOPOLOGY_EPSILON && pointOnSegment(a, c, d))
    || (Math.abs(cdB) <= TOPOLOGY_EPSILON && pointOnSegment(b, c, d));
}

function signedPolygonArea(points) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + (Number(point.x) * Number(next.y)) - (Number(next.x) * Number(point.y));
  }, 0) / 2;
}

function loopsIntersectOrTouch(left, right) {
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (segmentsIntersectOrTouch(
        left[leftIndex], left[(leftIndex + 1) % left.length],
        right[rightIndex], right[(rightIndex + 1) % right.length]
      )) return true;
    }
  }
  return false;
}

function pointInPolygonStrict(point, polygon) {
  if (polygon.some((start, index) => pointOnSegment(point, start, polygon[(index + 1) % polygon.length]))) return false;
  let inside = false;
  for (let index = 0, prior = polygon.length - 1; index < polygon.length; prior = index, index += 1) {
    const start = polygon[index];
    const end = polygon[prior];
    const crosses = ((Number(start.y) > Number(point.y)) !== (Number(end.y) > Number(point.y)))
      && (Number(point.x) < ((Number(end.x) - Number(start.x)) * (Number(point.y) - Number(start.y))
        / (Number(end.y) - Number(start.y))) + Number(start.x));
    if (crosses) inside = !inside;
  }
  return inside;
}

function exteriorInteriorsOverlap(left, right) {
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const a = left[leftIndex];
    const b = left[(leftIndex + 1) % left.length];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const c = right[rightIndex];
      const d = right[(rightIndex + 1) % right.length];
      const side = (start, end, point) => {
        const cross = crossProduct(start, end, point);
        return Math.abs(cross) <= TOPOLOGY_EPSILON ? 0 : Math.sign(cross);
      };
      const abC = side(a, b, c);
      const abD = side(a, b, d);
      if (abC * abD < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
      if (abC === 0 && abD === 0) {
        const axis = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'x' : 'y';
        const overlap = Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]))
          - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]));
        if (overlap > TOPOLOGY_EPSILON) return true;
      }
    }
  }
  // Midpoints also detect interior spans whose endpoints only touch the other
  // boundary. Isolated boundary contacts never count as interior containment.
  const entersInterior = (loop, polygon) => loop.some((point, index) => {
    const next = loop[(index + 1) % loop.length];
    return pointInPolygonStrict(point, polygon)
      || pointInPolygonStrict({ x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 }, polygon);
  });
  return entersInterior(left, right) || entersInterior(right, left);
}

function directedLoopPoints(authoring, loopId, expectedKind) {
  const loop = authoring?.outerTopology?.loopsById?.[loopId];
  if (!loop || loop.id !== loopId || loop.kind !== expectedKind || !Array.isArray(loop.edges) || loop.edges.length < 3) {
    throw new Error(`Building V2 Current Building Snapshot requires a canonical ${expectedKind} loop.`);
  }
  const spans = loop.edges.map((edge) => {
    const direction = edge?.direction;
    const semanticId = String(edge?.semanticWallId || '');
    const wall = authoring?.semanticWallsById?.[semanticId];
    const start = authoring?.topologyVerticesById?.[wall?.geometry?.startVertexId];
    const end = authoring?.topologyVerticesById?.[wall?.geometry?.endVertexId];
    if (!wall || wall?.owner?.kind !== 'outer-loop' || wall.owner.id !== loopId
      || !['forward', 'reverse'].includes(direction) || !start || !end
      || !Number.isFinite(Number(start.x)) || !Number.isFinite(Number(start.y))
      || !Number.isFinite(Number(end.x)) || !Number.isFinite(Number(end.y))) {
      throw new Error(`Building V2 Current Building Snapshot ${expectedKind} loop has invalid directed Segment ownership.`);
    }
    const span = direction === 'reverse'
      ? { startId: wall.geometry.endVertexId, endId: wall.geometry.startVertexId, start: end, end: start }
      : { startId: wall.geometry.startVertexId, endId: wall.geometry.endVertexId, start, end };
    if (span.startId === span.endId || samePoint(span.start, span.end)) {
      throw new Error(`Building V2 Current Building Snapshot ${expectedKind} loop has a zero-length directed Segment.`);
    }
    return span;
  });
  if (new Set(spans.map((span) => span.startId)).size !== spans.length) {
    throw new Error(`Building V2 Current Building Snapshot ${expectedKind} loop repeats a Topology Vertex.`);
  }
  for (let index = 0; index < spans.length; index += 1) {
    const next = spans[(index + 1) % spans.length];
    if (spans[index].endId !== next.startId || !samePoint(spans[index].end, next.start)) {
      throw new Error(`Building V2 Current Building Snapshot ${expectedKind} loop Segments are not one ordered closed ring.`);
    }
  }
  const points = spans.map((span) => ({ x: Number(span.start.x), y: Number(span.start.y) }));
  const area = signedPolygonArea(points);
  if (Math.abs(area) < 1 || (expectedKind === 'exterior' ? area <= 0 : area >= 0)) {
    throw new Error(`Building V2 Current Building Snapshot ${expectedKind} loop has invalid winding or area.`);
  }
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (firstNext === second || secondNext === first) continue;
      if (segmentsIntersectOrTouch(points[first], points[firstNext], points[second], points[secondNext])) {
        throw new Error(`Building V2 Current Building Snapshot ${expectedKind} loop self-intersects.`);
      }
    }
  }
  return points;
}

function validateDirectedOuterTopology(authoring) {
  const exteriors = authoring.outerTopology.exteriorLoopIds.map((exteriorId) => (
    directedLoopPoints(authoring, exteriorId, 'exterior')
  ));
  for (let first = 0; first < exteriors.length; first += 1) {
    for (let second = first + 1; second < exteriors.length; second += 1) {
      if (exteriorInteriorsOverlap(exteriors[first], exteriors[second])) {
        throw new Error('Building V2 Current Building Snapshot requires separate exterior loops without crossing, overlapping edges, or interior containment.');
      }
    }
  }
  const holes = authoring.outerTopology.holeLoopIds.map((holeId) => directedLoopPoints(authoring, holeId, 'hole'));
  for (const hole of holes) {
    const owners = exteriors.filter((exterior) => (
      !loopsIntersectOrTouch(exterior, hole) && hole.every((point) => pointInPolygonStrict(point, exterior))
    ));
    if (owners.length !== 1 || exteriors.some((exterior) => loopsIntersectOrTouch(exterior, hole))) {
      throw new Error('Building V2 Current Building Snapshot requires every hole to remain strictly inside exactly one exterior without touching it.');
    }
  }
  for (let first = 0; first < holes.length; first += 1) {
    for (let second = first + 1; second < holes.length; second += 1) {
      if (loopsIntersectOrTouch(holes[first], holes[second])
        || pointInPolygonStrict(holes[first][0], holes[second])
        || pointInPolygonStrict(holes[second][0], holes[first])) {
        throw new Error('Building V2 Current Building Snapshot requires separate non-overlapping hole loops.');
      }
    }
  }
}

function normalizeRegistry(scene) {
  const value = scene?.getFlag?.(MODULE_ID, 'compositionRegistry')
    ?? scene?.flags?.[MODULE_ID]?.compositionRegistry
    ?? scene?._source?.flags?.[MODULE_ID]?.compositionRegistry
    ?? {};
  return {
    schemaVersion: 1,
    groups: clone(value.groups || {}),
    relationships: clone(Array.isArray(value.relationships) ? value.relationships : []),
    wallVisibilityStates: clone(value.wallVisibilityStates || {})
  };
}

/** A Building's Fill and Sills are written by their Building's plan alone. The
 * drop-shadow settings shared by the shadowed Tiles of one Elevation are not
 * written to them a second time by the same plan. */
function isBuildingGeneratedTile(document) {
  const flags = document?.flags?.[MODULE_ID] || document?._source?.flags?.[MODULE_ID] || {};
  return !!(flags.buildingGenerated || flags.buildingFill || flags.buildingSills || flags.buildingComposite);
}

function shadowTileSnapshot(document) {
  const flags = document?.flags?.[MODULE_ID] || document?._source?.flags?.[MODULE_ID] || {};
  return {
    id: String(document?.id || document?._id || ''),
    elevation: Number(document?.elevation ?? document?._source?.elevation ?? 0) || 0,
    shadowAlpha: readFlag(document, 'shadowAlpha'),
    shadowBlur: readFlag(document, 'shadowBlur'),
    hasShadowAlpha: Object.prototype.hasOwnProperty.call(flags, 'shadowAlpha'),
    hasShadowBlur: Object.prototype.hasOwnProperty.call(flags, 'shadowBlur')
  };
}

function refreshNativeEffects(canvas) {
  canvas?.perception?.update?.({ initializeVision: true, refreshVision: true, initializeLighting: true, initializeSounds: true });
  canvas?.tokens?.recalculatePlannedMovementPaths?.();
}

export function createBuildingV2ExistingEditRuntime({
  getCanvas = () => globalThis.canvas,
  getHooks = () => globalThis.Hooks,
  getShadowManager = async () => {
    const { getAssetShadowManager } = await import('../../assets/asset-shadow-manager.js');
    return getAssetShadowManager();
  },
  createWallBehaviorRuntime = createBuildingV2WallBehaviorRuntime
} = {}) {
  let wallBehaviorRuntime = null;
  const requireWallBehaviorRuntime = () => {
    wallBehaviorRuntime ||= createWallBehaviorRuntime();
    return wallBehaviorRuntime;
  };
  const captureImported = async ({ sceneId, rootTileId, migration }) => {
    const scene = getCanvas()?.scene;
    const current = createBuildingV053MigrationPreflightCapture({ getCanvas })({ sceneId, rootTileId });
    if (current.status !== 'captured' || current.facts.missing.length || current.facts.ambiguous.length
      || !sameValue(current.aggregate, migration?.preflight?.aggregate)) {
      throw new Error('Building v0.5.3 source changed or lost exact ownership during import.');
    }
    if (migration.version !== 1 || !migration.buildingId || migration.authoring?.version !== 2
      || !migration.authoring.defaults || !migration.portalDocumentIds) {
      throw new Error('Building v0.5.3 requires a complete premium-authored import descriptor.');
    }
    const { root, building, linked, compositionRegistry } = current.aggregate;
    const fill = linked.tiles.find(entry => entry.flags?.buildingFill && !entry.ownerConflict)?.source || null;
    const sills = linked.tiles.find(entry => entry.flags?.buildingComposite?.role === 'sill' && !entry.ownerConflict)?.source || null;
    const regions = linked.regions.filter(entry => !entry.ownerConflict && (entry.tileMatch || entry.groupMatch)).map(entry => entry.source);
    const walls = linked.walls.filter(entry => !entry.ownerConflict && (entry.tileMatch || entry.groupMatch)).map(entry => entry.source);
    const portalDocumentIds = clone(migration.portalDocumentIds);
    for (const [portalId, documentId] of Object.entries(portalDocumentIds)) {
      const wall = walls.find(source => source._id === documentId);
      const owner = wall?.flags?.[MODULE_ID];
      if (!wall || (owner.buildingDoor?.gapId || owner.buildingWindow?.gapId) !== portalId) {
        throw new Error(`Building v0.5.3 Portal ${portalId} lost its exact captured native Wall.`);
      }
    }
    const retainedTileIds = new Set([root._id, fill?._id, sills?._id].filter(Boolean));
    const allTiles = [...new Map([root, ...linked.innerRoots.map(entry => entry.source), ...linked.tiles.map(entry => entry.source)]
      .map(source => [source._id, source])).values()];
    const retiredTiles = allTiles.filter(source => !retainedTileIds.has(source._id));
    const pose = {
      x: finite(root.x, 'Root x'), y: finite(root.y, 'Root y'), width: finite(root.width, 'Root width'), height: finite(root.height, 'Root height'),
      rotation: 0, anchorX: finite(root.texture?.anchorX ?? 0.5, 'Root anchor X'), anchorY: finite(root.texture?.anchorY ?? 0.5, 'Root anchor Y'), scale: 1
    };
    pose.originX = pose.x - pose.width * pose.anchorX;
    pose.originY = pose.y - pose.height * pose.anchorY;
    const presentation = source => source ? { elevation: Number(source.elevation) || 0, sort: Number(source.sort) || 0,
      hidden: source.hidden === true, locked: source.locked === true, levels: clone(source.levels || []) } : null;
    const shadowManager = await getShadowManager();
    if (typeof shadowManager?._collectShadowTilesAtElevation !== 'function') throw new Error('Building import requires the canonical Asset Shadow manager.');
    const shadowTiles = shadowManager._collectShadowTilesAtElevation(Number(root.elevation) || 0)
      .filter(document => !isBuildingGeneratedTile(document))
      .map(document => shadowTileSnapshot(document)).sort((a, b) => a.id.localeCompare(b.id));
    const wallLevels = [...new Set(walls.flatMap(source => source.levels || []))];
    const authoring = clone(migration.authoring);
    return immutableCopy({
      version: 1, sourceKind: 'v053', reference: { sceneId, rootTileId, buildingId: migration.buildingId, generationId: null },
      authoring, baselineAuthoring: clone(authoring),
      runtime: { authoringFingerprint: fingerprint(authoring), fillProjection: null, sills: [] },
      pose, presentation: { ...presentation(root), wallLevels, fill: presentation(fill), sills: presentation(sills) },
      ownership: {
        wallIds: walls.map(source => source._id), tileIds: allTiles.map(source => source._id), portalDocumentIds,
        semanticWallDocumentIds: clone(portalDocumentIds),
        relationshipIdsBySemanticId: {}, fillTileId: fill?._id || null, fillRelationshipId: null,
        sillsTileId: sills?._id || null, sillsRelationshipId: null, regionId: regions[0]?._id || null, regionRelationshipId: null
      },
      baselines: { semantic: fingerprint(authoring), pose: fingerprint(pose), ownership: fingerprint({ walls, fill, sills, regions, retiredTiles }) },
      durable: { root, building, walls, fill, sills, regions, retiredTiles, relationships: [], compositionRegistry: normalizeRegistry(scene), shadowTiles },
      migration: { version: 1, source: current.expectedProvenance, portalDocumentIds, aggregate: clone(current.aggregate) }
    });
  };
  const capture = async ({ sceneId, rootTileId } = {}) => {
    const canvas = getCanvas();
    const scene = canvas?.scene;
    const normalizedSceneId = String(sceneId || '').trim();
    const normalizedRootId = String(rootTileId || '').trim();
    if (!scene || String(scene.id || '') !== normalizedSceneId || !normalizedRootId) {
      throw new Error('Building V2 Current Building Snapshot requires the active Root Scene Canvas.');
    }
    const root = collectionGet(scene.tiles, normalizedRootId);
    const building = readFlag(root, 'building');
    if (!root || ![4, 5].includes(Number(building?.schemaVersion)) || !building?.authoring || !building?.runtime) {
      throw new Error('Building V2 M2 Gate A can open only a native schema-v4 or schema-v5 V2 Building Root.');
    }
    if (fingerprint(building.authoring) !== building.runtime.authoringFingerprint) {
      throw new Error('Building V2 Current Building Snapshot authoring/runtime fingerprint mismatch.');
    }
    const baselineAuthoring = clone(building.authoring);
    const recoveredAuthoring = recoverInterruptedOuterAppearance(building, baselineAuthoring);
    const authoring = recoveredAuthoring || baselineAuthoring;
    const vertexIds = Object.keys(authoring.topologyVerticesById || {});
    const controlIds = Object.keys(authoring.splineControlsById || {});
    if (controlIds.some(id => Object.hasOwn(authoring.topologyVerticesById || {}, id))) throw new Error('Building V2 spline controls and Topology Vertices require distinct identities.');
    const interiorSchema = Number(building.schemaVersion) === 5;
    if (interiorSchema && (Number(authoring.version) !== 2 || authoring.innerWallPathsById != null)) {
      throw new Error('Building V2 schema-v5 requires canonical Interior Paths and authoring version 2.');
    }
    const outerSegments = authoring.semanticWallsById || {};
    const interiorSegments = interiorSchema ? authoring.interiorPathSegmentsById || {} : {};
    if (Object.keys(interiorSegments).some((id) => Object.hasOwn(outerSegments, id))) {
      throw new Error('Building V2 Interior Path Segment identities must be unique from Outer Semantic Walls.');
    }
    const geometrySegments = { ...outerSegments, ...interiorSegments };
    const semanticIds = Object.keys(geometrySegments);
    const exteriorIds = authoring.outerTopology?.exteriorLoopIds || [];
    const holeIds = authoring.outerTopology?.holeLoopIds || [];
    const loopIds = [...exteriorIds, ...holeIds];
    const loops = loopIds.map((loopId) => authoring.outerTopology?.loopsById?.[loopId]);
    const loopSemanticIds = loops.flatMap((loop) => (loop?.edges || []).map((edge) => String(edge?.semanticWallId || '')));
    const innerPathEntries = Object.entries((interiorSchema ? authoring.interiorPathsById : authoring.innerWallPathsById) || {});
    const innerPathSemanticIds = innerPathEntries.flatMap(([, path]) => (
      (path?.edges || []).map((edge) => String(edge?.semanticWallId || ''))
    ));
    const claimedSemanticIds = [...loopSemanticIds, ...innerPathSemanticIds];
    const claimedVertexIds = claimedSemanticIds.flatMap((semanticId) => {
      const geometry = geometrySegments[semanticId]?.geometry;
      if (geometry?.kind === 'spline-span') return [];
      return [String(geometry?.startVertexId || ''), String(geometry?.endVertexId || '')];
    });
    const expectedLoopKinds = loops.every((loop, index) => (
      loop
      && loop.kind === (index < exteriorIds.length ? 'exterior' : 'hole')
      && Array.isArray(loop.edges)
      && loop.edges.length >= 3
    ));
    const validInnerPaths = innerPathEntries.every(([pathId, path]) => {
      const spline = path?.family === 'spline';
      const pointIds = spline ? path.controlIds : path?.vertexIds;
      const pathVertexIds = Array.isArray(pointIds) ? pointIds.map(String) : [];
      const pointStore = spline ? authoring.splineControlsById : authoring.topologyVerticesById;
      const edges = Array.isArray(path?.edges) ? path.edges : [];
      const closed = path?.closed === true;
      const minimumVertexCount = closed ? 3 : 2;
      const expectedEdgeCount = pathVertexIds.length - (closed ? 0 : 1);
      if (interiorSchema && (!['wall', 'fill-divider'].includes(path?.purpose)
        || typeof path?.fillParticipation !== 'boolean' || typeof path?.hasWallState !== 'boolean'
        || (path.purpose === 'wall' && path.hasWallState !== true))) return false;
      if (path?.id !== pathId || !['polyline', 'spline'].includes(path?.family) || ![true, false].includes(path?.closed)
        || (spline && (!interiorSchema || !Number.isFinite(path.tension) || path.tension < 0 || path.tension > 1 || Object.hasOwn(path, 'vertexIds')))
        || pathVertexIds.length < minimumVertexCount || edges.length !== expectedEdgeCount
        || new Set(pathVertexIds).size !== pathVertexIds.length) return false;
      return edges.every((edge, index) => {
        const wall = geometrySegments[String(edge?.semanticWallId || '')];
        const direction = edge?.direction;
        const forward = direction === 'forward';
        const start = pointStore?.[pathVertexIds[index]];
        const nextVertexId = pathVertexIds[(index + 1) % pathVertexIds.length];
        const end = pointStore?.[nextVertexId];
        const geometryKind = wall?.geometry?.kind;
        const validConic = geometryKind === 'conic'
          && Number.isFinite(Number(wall.geometry?.control?.x))
          && Number.isFinite(Number(wall.geometry?.control?.y));
        return ['forward', 'reverse'].includes(direction)
          && [start?.x, start?.y, end?.x, end?.y].every((value) => Number.isFinite(Number(value)))
          && Math.hypot(Number(end.x) - Number(start.x), Number(end.y) - Number(start.y)) > 1e-6
          && wall?.owner?.kind === (interiorSchema ? 'interior-path' : 'inner-path') && wall.owner.id === pathId
          && (spline ? geometryKind === 'spline-span' && !Object.hasOwn(wall.geometry, 'controls') && !Object.hasOwn(wall.geometry, 'control')
            && !Object.hasOwn(wall.geometry, 'startVertexId') && !Object.hasOwn(wall.geometry, 'endVertexId') : geometryKind === 'line' || validConic)
          && wall.geometry[spline ? 'startControlId' : 'startVertexId'] === (forward ? pathVertexIds[index] : nextVertexId)
          && wall.geometry[spline ? 'endControlId' : 'endVertexId'] === (forward ? nextVertexId : pathVertexIds[index]);
      });
    });
    const minimumVertexCount = exteriorIds.length ? 3 : 2;
    if (vertexIds.length + controlIds.length < minimumVertexCount || (!exteriorIds.length && !innerPathEntries.length)
      || (holeIds.length > 0 && !exteriorIds.length)
      || !expectedLoopKinds || new Set(loopIds).size !== loopIds.length
      || !validInnerPaths || claimedSemanticIds.length !== semanticIds.length
      || new Set(claimedSemanticIds).size !== semanticIds.length
      || semanticIds.some((semanticId) => !claimedSemanticIds.includes(semanticId))) {
      throw new Error('Building V2 current Edit requires admitted Outer loops and/or exact Poly-line Inner Wall Paths.');
    }
    for (const semanticId of semanticIds) {
      const semantic = geometrySegments[semanticId];
      if (semantic.geometry?.kind === 'spline-span') {
        resolveBuildingV2SplineSpan(authoring, semantic);
        continue;
      }
      const start = authoring.topologyVerticesById[semantic?.geometry?.startVertexId];
      const end = authoring.topologyVerticesById[semantic?.geometry?.endVertexId];
      const kind = semantic?.geometry?.kind;
      const control = semantic?.geometry?.control;
      const weights = semantic?.geometry?.conicState?.weights;
      const validConic = kind === 'conic' && start && end
        && Number.isFinite(Number(control?.x)) && Number.isFinite(Number(control?.y))
        && (!Array.isArray(weights) || (weights.length === 3
          && weights.every((weight) => Number.isFinite(Number(weight)) && Number(weight) > 0)));
      if (!start || !end || (kind !== 'line' && !validConic)) {
        throw new Error('Building V2 M7 requires finite line or compact rational-conic Semantic Walls.');
      }
    }
    if (exteriorIds.length) validateDirectedOuterTopology(authoring);
    if (new Set(claimedVertexIds).size !== vertexIds.length || vertexIds.some((vertexId) => !claimedVertexIds.includes(vertexId))) {
      throw new Error('Building V2 Current Building Snapshot requires every Topology Vertex to belong to admitted Outer or Inner geometry.');
    }
    const claimedControls = innerPathEntries.flatMap(([, path]) => path.family === 'spline' ? path.controlIds : []);
    if (new Set(claimedControls).size !== claimedControls.length || claimedControls.length !== controlIds.length
      || controlIds.some(id => !claimedControls.includes(id) || authoring.splineControlsById[id]?.id !== id)) {
      throw new Error('Building V2 requires every Spline Control to belong to exactly one admitted Path.');
    }
    const wallSemanticIds = interiorSchema ? [
      ...Object.keys(outerSegments),
      ...innerPathEntries.filter(([, path]) => path.purpose === 'wall')
        .flatMap(([, path]) => path.edges.map((edge) => String(edge.semanticWallId)))
    ] : semanticIds;
    if (interiorSchema && (loopSemanticIds.some((id) => !Object.hasOwn(outerSegments, id))
      || innerPathSemanticIds.some((id) => !Object.hasOwn(interiorSegments, id)))) {
      throw new Error('Building V2 schema-v5 requires separate Outer and Interior Segment ownership.');
    }
    const runtimeProjection = building.runtime;
    const openingAdmission = validateBuildingV2OpeningProjection(building);
    if (interiorSchema && (!Array.isArray(runtimeProjection.wallSections)
      || runtimeProjection.wallSections.some((section) => !Array.isArray(section.semanticWallIds)
        || !section.semanticWallIds.length || section.semanticWallIds.some((id) => !wallSemanticIds.includes(String(id)))))) {
      throw new Error('Building V2 Fill Divider Segments cannot own Wall artwork.');
    }
    const expected = runtimeProjection.expectedGeneratedDocuments || [];
    const wallExpected = expected.filter((entry) => entry?.documentName === 'Wall' && ['wall', 'portal'].includes(entry?.role));
    const fillActive = hasActiveBuildingV2Fill(authoring.fill);
    const fillExpected = expected.filter((entry) => entry?.documentName === 'Tile' && entry?.role === 'fill');
    const sillsExpected = expected.filter((entry) => entry?.documentName === 'Tile' && entry?.role === 'sill');
    const sillParts = runtimeProjection.sills ?? [];
    const sillsActive = Array.isArray(sillParts) && sillParts.length > 0;
    const regionExpected = expected.filter((entry) => entry?.documentName === 'Region' && entry?.role === 'surface-region');
    const regionProjections = runtimeProjection.regions ?? [];
    if (!Array.isArray(regionProjections) || regionExpected.length > 1
      || regionProjections.length !== regionExpected.length
      || (regionExpected.length && (!exteriorIds.length || regionExpected[0].semanticId !== null
        || Number(regionExpected[0].fragmentOrdinal) !== 0 || !String(regionExpected[0].documentId || '').trim()))) {
      throw new Error('Building V2 Current Building Snapshot requires exact singleton Surface Region ownership.');
    }
    if (!Array.isArray(sillParts)
      || expected.length !== wallExpected.length + fillExpected.length + sillsExpected.length + regionExpected.length
      || (!wallExpected.length && !openingAdmission.openingCount)
      || runtimeProjection.nativeWallProjection?.length !== wallExpected.length
      || wallSemanticIds.some((semanticId) => !openingAdmission.fullyOpenedSemanticIds.has(semanticId)
        && !wallExpected.some((entry) => String(entry?.semanticId || '') === semanticId))
      || (sillsActive ? sillsExpected.length !== 1 : sillsExpected.length !== 0)
      || (fillActive ? fillExpected.length !== 1 || runtimeProjection.fillProjection?.active !== true
        : fillExpected.length !== 0 || runtimeProjection.fillProjection != null)) {
      throw new Error('Building V2 Current Building Snapshot requires exact generated Wall fragments and managed Tile ownership matching authored state.');
    }
    if (fillActive && (fillExpected[0]?.semanticId !== null
      || Number(fillExpected[0]?.fragmentOrdinal) !== 0
      || !String(fillExpected[0]?.documentId || '').trim())) {
      throw new Error('Building V2 Current Building Snapshot requires one exact managed Fill manifest identity.');
    }
    if (sillsActive && (sillsExpected[0]?.semanticId !== null
      || Number(sillsExpected[0]?.fragmentOrdinal) !== 0
      || !String(sillsExpected[0]?.documentId || '').trim())) {
      throw new Error('Building V2 Current Building Snapshot requires one exact managed Sills manifest identity.');
    }
    const fragmentKeys = new Set();
    for (const semanticId of [...wallSemanticIds, ...Object.values(authoring.portalsById || {})
      .filter(entry => ['door', 'window', 'seamlessSecretDoor'].includes(entry.kind)).map(entry => entry.id)]) {
      const entries = wallExpected.filter((entry) => String(entry?.semanticId || '') === semanticId)
        .sort((left, right) => Number(left?.fragmentOrdinal || 0) - Number(right?.fragmentOrdinal || 0));
      for (let ordinal = 0; ordinal < entries.length; ordinal += 1) {
        const fragmentOrdinal = Number(entries[ordinal]?.fragmentOrdinal || 0);
        const documentId = String(entries[ordinal]?.documentId || '').trim();
        const key = `${semanticId}:${fragmentOrdinal}`;
        if (!Number.isSafeInteger(fragmentOrdinal) || fragmentOrdinal !== ordinal || !documentId || fragmentKeys.has(key)) {
          throw new Error(`Building V2 M7 requires contiguous unique native Wall fragments for Semantic Wall ${semanticId}.`);
        }
        fragmentKeys.add(key);
      }
    }
    if (fragmentKeys.size !== wallExpected.length) {
      throw new Error('Building V2 M7 native Wall fragment ownership contains an unknown or duplicate Semantic Wall identity.');
    }
    const buildingId = String(building.buildingId || '').trim();
    const generationId = String(runtimeProjection.generationId || '').trim();
    const rootUuid = `Scene.${normalizedSceneId}.Tile.${normalizedRootId}`;
    const registry = normalizeRegistry(scene);
    const walls = [];
    const relationships = [];
    const semanticWallDocumentIds = {};
    const relationshipIdsBySemanticId = {};
    for (const entry of wallExpected) {
      const portalKind = authoring.portalsById?.[entry.semanticId]?.kind;
      const isPortal = ['door', 'window', 'seamlessSecretDoor'].includes(portalKind);
      if (entry.role !== (isPortal ? 'portal' : 'wall')) {
        throw new Error('Building V2 generated Wall role must match its semantic Portal or structural identity.');
      }
      const wallId = String(entry.documentId || '').trim();
      const semanticId = String(entry.semanticId || '').trim();
      const wall = collectionGet(scene.walls, wallId);
      const owner = readFlag(wall, 'buildingGenerated');
      const fragmentOrdinal = Number(entry.fragmentOrdinal || 0);
      if (!wall || owner?.buildingId !== buildingId || owner?.rootTileId !== normalizedRootId
        || owner?.generationId !== generationId || owner?.role !== entry.role
        || owner?.semanticId !== semanticId || Number(owner?.fragmentOrdinal) !== fragmentOrdinal) {
        throw new Error(`Building V2 Current Building Snapshot generated Wall ${wallId || '(missing)'} failed exact ownership validation.`);
      }
      const dependentUuid = `Scene.${normalizedSceneId}.Wall.${wallId}`;
      const matches = registry.relationships.filter((relationship) => relationship?.type === 'generated-by'
        && relationship?.generator === 'building'
        && relationship?.ownerUuid === rootUuid
        && relationship?.dependentUuid === dependentUuid);
      if (matches.length !== 1) {
        throw new Error(`Building V2 Current Building Snapshot requires one exact generated-by relationship for Wall ${wallId}.`);
      }
      walls.push(sourceOf(wall));
      relationships.push(clone(matches[0]));
      const identityKey = fragmentOrdinal === 0 ? semanticId : `${semanticId}:${fragmentOrdinal}`;
      semanticWallDocumentIds[identityKey] = wallId;
      relationshipIdsBySemanticId[identityKey] = matches[0].id;
    }
    const rootSource = sourceOf(root);
    const wallLevels = readBuildingV2NativeWallLevelIds(root);
    const pose = deriveBuildingV2SpatialPose(rootSource, building);
    const regions = [];
    let regionId = null;
    let regionRelationshipId = null;
    const ownedRegions = collectionValues(scene.regions).filter((region) => {
      const owner = readFlag(region, 'buildingGenerated');
      const backlink = readFlag(region, 'buildingRegion');
      return owner?.rootTileId === normalizedRootId || backlink?.wallTileId === normalizedRootId
        || owner?.buildingId === buildingId || backlink?.wallGroupId === buildingId;
    });
    const regionRelationships = registry.relationships.filter((relationship) => relationship?.type === 'generated-by'
      && relationship?.generator === 'building' && relationship?.ownerUuid === rootUuid
      && String(relationship?.dependentUuid || '').startsWith(`Scene.${normalizedSceneId}.Region.`));
    if (ownedRegions.length !== regionExpected.length || regionRelationships.length !== regionExpected.length) {
      throw new Error('Building V2 Current Building Snapshot found unmanifested or missing Surface Region ownership.');
    }
    if (regionExpected.length) {
      regionId = String(regionExpected[0].documentId);
      const region = collectionGet(scene.regions, regionId);
      const owner = readFlag(region, 'buildingGenerated');
      const backlink = readFlag(region, 'buildingRegion');
      if (!region || ownedRegions[0] !== region || Number(owner?.version) !== 1
        || owner?.buildingId !== buildingId || owner?.rootTileId !== normalizedRootId
        || owner?.generationId !== generationId || owner?.role !== 'surface-region'
        || owner?.semanticId !== null || Number(owner?.fragmentOrdinal) !== 0
        || backlink?.wallTileId !== normalizedRootId || backlink?.wallGroupId !== buildingId) {
        throw new Error('Building V2 Current Building Snapshot Surface Region failed exact ownership validation.');
      }
      const dependentUuid = `Scene.${normalizedSceneId}.Region.${regionId}`;
      const matches = registry.relationships.filter((relationship) => relationship?.type === 'generated-by'
        && relationship?.dependentUuid === dependentUuid);
      regionRelationshipId = String(matches[0]?.id || '').trim();
      if (matches.length !== 1 || matches[0].generator !== 'building' || matches[0].ownerUuid !== rootUuid
        || !regionRelationshipId || registry.relationships.filter((entry) => entry?.id === regionRelationshipId).length !== 1) {
        throw new Error('Building V2 Current Building Snapshot requires one exact generated-by relationship for the Surface Region.');
      }
      validateBuildingV2SurfaceRegionProjection(regionProjections[0], authoring);
      const shapes = materializeBuildingV2SurfaceRegionShapes(regionProjections[0], {
        transform: createBuildingV2SpatialTransform(pose), sceneGridSize: finite(scene.grid?.size, 'Scene grid size')
      });
      // Preserve serialized presentation (not prepared Color instances or
      // behavior models) across the premium/public data-only contract.
      const regionSource = clone(region.toObject?.(true) || region._source || region);
      if (!Array.isArray(regionSource.shapes) || regionSource.shapes.length !== shapes.length
        || shapes.some((shape, index) => {
          const actual = regionSource.shapes[index];
          return actual?.type !== shape.type || actual?.hole !== shape.hole
            || !Array.isArray(actual.points) || actual.points.length !== shape.points.length
            || actual.points.some((value, pointIndex) => !sameFiniteNumber(value, shape.points[pointIndex]));
        })) {
        throw new Error('Building V2 Current Building Snapshot Surface Region does not match the current Root projection.');
      }
      regions.push(regionSource);
      relationships.push(clone(matches[0]));
    }
    let fillSource = null;
    let fillRelationship = null;
    let fillTileId = null;
    let fillRelationshipId = null;
    if (fillActive) {
      const resolvedFill = representativeBuildingV2Fill(authoring.fill);
      const authoredFill = requireManagedFillAuthoring(authoring.fill);
      if (!sameValue(building.fill, authoring.fill)) {
        throw new Error('Building V2 Current Building Snapshot authored and compatibility Fill state do not match.');
      }
      const compiledMaskSource = compileBuildingV2FillMaskSource(authoring);
      const storedMaskSource = validateBuildingV2FillMaskSource(runtimeProjection.fillProjection?.maskSource);
      if ((authoring.fill?.default && Number(runtimeProjection.fillProjection?.version) !== 2)
        || !sameValue(compiledMaskSource, storedMaskSource)
        || runtimeProjection.fillProjection?.maskSourceFingerprint !== storedMaskSource.fingerprint
        || !sameValue(runtimeProjection.fillProjection?.asset, resolvedFill.asset)
        || !sameValue(runtimeProjection.fillProjection?.appearance, resolvedFill.appearance)
        || !sameValue(runtimeProjection.fillProjection?.textureBasis, authoring.fill.textureBasis)) {
        throw new Error('Building V2 Current Building Snapshot requires an exact compact Fill runtime projection.');
      }
      fillTileId = String(fillExpected[0].documentId);
      const ownedFillTiles = collectionValues(scene.tiles).filter((tile) => {
        const owner = readFlag(tile, 'buildingGenerated');
        return owner?.buildingId === buildingId && owner?.rootTileId === normalizedRootId && owner?.role === 'fill';
      });
      const fillDocument = collectionGet(scene.tiles, fillTileId);
      if (ownedFillTiles.length !== 1 || ownedFillTiles[0] !== fillDocument || !fillDocument) {
        throw new Error('Building V2 Current Building Snapshot requires exactly one matching managed Fill Tile.');
      }
      fillSource = sourceOf(fillDocument);
      const owner = readFlag(fillDocument, 'buildingGenerated');
      const backlink = readFlag(fillDocument, 'buildingFill');
      const maskedTiling = readFlag(fillDocument, 'maskedTiling');
      const hsbc = readFlag(fillDocument, 'hsbc');
      if (Number(owner?.version) !== 1 || owner?.buildingId !== buildingId
        || owner?.rootTileId !== normalizedRootId || owner?.generationId !== generationId
        || owner?.role !== 'fill' || owner?.semanticId !== null || Number(owner?.fragmentOrdinal) !== 0
        || Number(backlink?.version) !== 1 || backlink?.wallTileId !== normalizedRootId
        || backlink?.fillTextureKey !== authoredFill.key
        || String(fillSource?.texture?.src || '') !== authoredFill.src
        || !managedFillPoseMatchesRoot(fillSource, rootSource)
        || !sameFiniteNumber(fillSource?.alpha, resolvedFill.appearance.opacity)
        || !sameValue(hsbc, resolvedFill.appearance.hsbc)) {
        throw new Error('Building V2 Current Building Snapshot managed Fill failed exact durable ownership or appearance validation.');
      }
      const baselineRoot = requireCompatibleFillProjectionBaseline(maskedTiling, rootSource);
      const materialization = materializeBuildingV2FillMask(storedMaskSource, {
        sceneGridSize: finite(scene.grid?.size, 'Scene grid size')
      });
      const expectedMaskedTiling = {
        baseSrc: authoredFill.src,
        textureScale: 1,
        textureRotation: 0,
        ...projectBuildingV2FillMaskToManagedTile({
          materialization,
          building,
          rootSource: baselineRoot,
          textureBasis: authoring.fill.textureBasis,
          appearance: resolvedFill.appearance
        })
      };
      const actualRendererProjection = rendererProjectionAuthority(maskedTiling);
      const expectedRendererProjection = rendererProjectionAuthority(expectedMaskedTiling);
      if (!sameValue(actualRendererProjection, expectedRendererProjection)) {
        const mismatches = rendererProjectionMismatchFields(actualRendererProjection, expectedRendererProjection);
        throw new Error(
          `Building V2 Current Building Snapshot managed Fill renderer projection does not match its compact source (${mismatches.join(', ') || 'unknown fields'}).`
        );
      }
      const dependentUuid = `Scene.${normalizedSceneId}.Tile.${fillTileId}`;
      const matches = registry.relationships.filter((relationship) => relationship?.type === 'generated-by'
        && relationship?.generator === 'building'
        && relationship?.ownerUuid === rootUuid
        && relationship?.dependentUuid === dependentUuid);
      if (matches.length !== 1) {
        throw new Error('Building V2 Current Building Snapshot requires one exact generated-by relationship for the managed Fill.');
      }
      fillRelationship = clone(matches[0]);
      fillRelationshipId = String(matches[0].id || '').trim();
      if (!fillRelationshipId) {
        throw new Error('Building V2 Current Building Snapshot managed Fill relationship requires an identity.');
      }
      relationships.push(fillRelationship);
    } else {
      const ownedFillTiles = collectionValues(scene.tiles).filter((tile) => {
        const owner = readFlag(tile, 'buildingGenerated');
        return owner?.buildingId === buildingId && owner?.rootTileId === normalizedRootId && owner?.role === 'fill';
      });
      if (ownedFillTiles.length || hasActiveBuildingV2Fill(building.fill)) {
        throw new Error('Building V2 Current Building Snapshot No Fill state cannot retain a managed Fill authority.');
      }
    }
    let sillsSource = null;
    let sillsTileId = null;
    let sillsRelationshipId = null;
    const ownedSillsTiles = collectionValues(scene.tiles).filter((tile) => {
      const owner = readFlag(tile, 'buildingGenerated');
      const backlink = readFlag(tile, 'buildingSills');
      return (owner?.role === 'sill' && (owner?.buildingId === buildingId
        || owner?.rootTileId === normalizedRootId))
        || (backlink && (backlink?.buildingId === buildingId || backlink?.wallTileId === normalizedRootId));
    });
    if (sillsActive) {
      sillsTileId = String(sillsExpected[0].documentId);
      const sillsDocument = collectionGet(scene.tiles, sillsTileId);
      if (ownedSillsTiles.length !== 1 || ownedSillsTiles[0] !== sillsDocument || !sillsDocument) {
        throw new Error('Building V2 Current Building Snapshot requires exactly one matching managed Sills Tile.');
      }
      sillsSource = sourceOf(sillsDocument);
      const owner = readFlag(sillsDocument, 'buildingGenerated');
      const sillsFlag = readFlag(sillsDocument, 'buildingSills');
      const elevation = Number(sillsSource?.elevation);
      const sort = Number(sillsSource?.sort);
      if (Number(owner?.version) !== 1 || owner?.buildingId !== buildingId
        || owner?.rootTileId !== normalizedRootId || owner?.generationId !== generationId
        || owner?.role !== 'sill' || owner?.semanticId !== null || Number(owner?.fragmentOrdinal) !== 0
        || String(sillsSource?.texture?.src || '') !== BUILDING_SILLS_TEXTURE_SRC
        || Number(sillsSource?.alpha) !== 1 || !managedSillsPoseMatchesRoot(sillsSource, rootSource)
        || !Number.isFinite(elevation) || !Number.isFinite(sort)
        || !exactBuildingSillsFlag(sillsFlag, { rootTileId: normalizedRootId, buildingId })
        || sillsFlag.parts.some((part) => !Number.isFinite(Number(part?.elevation))
          || !Number.isFinite(Number(part?.sort)))) {
        throw new Error('Building V2 Current Building Snapshot managed Sills failed exact durable ownership or projection validation.');
      }
      const partElevation = Number(sillsFlag.parts[0].elevation);
      const partSort = Number(sillsFlag.parts[0].sort);
      const materializedSillParts = materializeBuildingV2WindowSills(sillParts, {
        rootSource, building, elevation: partElevation, sort: partSort
      });
      if (!sameValue(sillsFlag.parts, materializedSillParts)) {
        throw new Error('Building V2 Current Building Snapshot managed Sills parts do not materialize its Building-local runtime projection.');
      }
      const dependentUuid = `Scene.${normalizedSceneId}.Tile.${sillsTileId}`;
      const matches = registry.relationships.filter((relationship) => relationship?.dependentUuid === dependentUuid);
      sillsRelationshipId = String(matches[0]?.id || '').trim();
      if (matches.length !== 1 || matches[0]?.type !== 'generated-by'
        || matches[0]?.generator !== 'building' || matches[0]?.ownerUuid !== rootUuid
        || !sillsRelationshipId
        || registry.relationships.filter((entry) => entry?.id === sillsRelationshipId).length !== 1) {
        throw new Error('Building V2 Current Building Snapshot requires one exact generated-by relationship for managed Sills.');
      }
      relationships.push(clone(matches[0]));
    } else if (ownedSillsTiles.length) {
      throw new Error('Building V2 Current Building Snapshot without sill parts cannot retain managed Sills authority.');
    }
    const ownedTileRelationships = registry.relationships.filter((relationship) => relationship?.type === 'generated-by'
      && relationship?.generator === 'building' && relationship?.ownerUuid === rootUuid
      && String(relationship?.dependentUuid || '').startsWith(`Scene.${normalizedSceneId}.Tile.`));
    if (ownedTileRelationships.length !== (fillActive ? 1 : 0) + (sillsActive ? 1 : 0)) {
      throw new Error('Building V2 Current Building Snapshot found ambiguous or unmanifested generated Tile ownership.');
    }
    const { x, y, width, height, rotation, anchorX, anchorY } = pose;
    const spatialTransform = createSpatialTransform({ pose });
    for (let index = 0; index < wallExpected.length; index += 1) {
      const entry = wallExpected[index];
      const projectionMatches = (runtimeProjection.nativeWallProjection || []).filter((projection) => (
        String(projection?.semanticWallId || '') === String(entry.semanticId || '')
        && Number(projection?.fragmentOrdinal) === Number(entry.fragmentOrdinal)
      ));
      const occupation = authoring.portalsById?.[entry.semanticId];
      if (['door', 'seamlessSecretDoor'].includes(occupation?.kind)) {
        validateBuildingV2DoorWall(occupation, projectionMatches[0], walls[index], { scale: pose.scale, reflected: pose.flipX !== pose.flipY,
          sceneGridSize: finite(scene.grid?.size, 'Scene grid size') });
      } else if (occupation?.kind === 'window') {
        validateBuildingV2WindowWall(occupation, projectionMatches[0]);
      }
      const endpoints = projectionMatches[0]?.localEndpoints;
      const resolvedBehavior = requireWallBehaviorRuntime().resolve({
        defaults: projectionMatches[0]?.resolvedBehavior || { preset: 'Solid' }
      });
      const coordinates = Array.from(walls[index]?.c || []).map(Number);
      if (projectionMatches.length !== 1
        || !Array.isArray(endpoints)
        || endpoints.length !== 2
        || coordinates.length !== 4
        || !coordinates.every(Number.isFinite)) {
        throw new Error(`Building V2 Current Building Snapshot generated Wall ${String(entry.documentId || '')} has no exact runtime projection.`);
      }
      const startWorld = spatialTransform.localToWorld({
        x: finite(endpoints[0]?.x, `${entry.semanticId} start x`),
        y: finite(endpoints[0]?.y, `${entry.semanticId} start y`)
      });
      const endWorld = spatialTransform.localToWorld({
        x: finite(endpoints[1]?.x, `${entry.semanticId} end x`),
        y: finite(endpoints[1]?.y, `${entry.semanticId} end y`)
      });
      if (occupation?.kind === 'seamlessSecretDoor') validateBuildingV2DoorWall(occupation, projectionMatches[0], walls[index], {
        scale: pose.scale, reflected: pose.flipX !== pose.flipY, worldEndpoints: [startWorld, endWorld]
      });
      if (occupation?.kind === 'window') {
        const liveProjection = clone(projectionMatches[0]);
        liveProjection.door.state = walls[index].ds;
        validateBuildingV2WindowWall(occupation, liveProjection, walls[index], {
          scale: pose.scale, reflected: pose.flipX !== pose.flipY,
          sceneGridSize: finite(scene.grid?.size, 'Scene grid size'),
          worldEndpoints: [startWorld, endWorld]
        });
      }
      const nativePortal = ['door', 'seamlessSecretDoor'].includes(occupation?.kind) ? materializeBuildingV2DoorWall(projectionMatches[0].door,
        { a: startWorld, b: endWorld, dir: resolvedBehavior.dir, scale: pose.scale, reflected: pose.flipX !== pose.flipY,
          sceneGridSize: finite(scene.grid?.size, 'Scene grid size') })
        : occupation?.kind === 'window' ? materializeBuildingV2WindowWall(occupation.setup, {
          a: startWorld, b: endWorld, dir: resolvedBehavior.dir, state: walls[index]?.ds, behavior: occupation.behavior, scale: pose.scale, reflected: pose.flipX !== pose.flipY,
          sceneGridSize: finite(scene.grid?.size, 'Scene grid size')
        }) : null;
      const projected = nativePortal?.c || [startWorld.x, startWorld.y, endWorld.x, endWorld.y];
      if (coordinates.some((coordinate, coordinateIndex) => (
        Math.abs(coordinate - projected[coordinateIndex]) > 0.500001
      ))) {
        throw new Error(
          `Building V2 Current Building Snapshot generated Wall ${String(entry.documentId || '')} does not match the current Root projection.`
        );
      }
      const durableThreshold = walls[index]?.threshold || {};
      const durableBehavior = {
        move: clone(walls[index]?.move),
        light: clone(walls[index]?.light),
        sight: clone(walls[index]?.sight),
        sound: clone(walls[index]?.sound),
        dir: clone(walls[index]?.dir),
        threshold: Object.fromEntries(
          ['light', 'sight', 'sound', 'attenuation']
            .map((key) => [key, clone(durableThreshold[key])])
        )
      };
      const projectedBehavior = occupation?.kind === 'window' ? {
        ...resolvedBehavior,
        dir: nativePortal.dir,
        light: nativePortal.light,
        sight: nativePortal.sight,
        threshold: clone(nativePortal.threshold)
      } : nativePortal ? { ...resolvedBehavior, dir: nativePortal.dir } : { ...resolvedBehavior, dir: pose.flipX !== pose.flipY && resolvedBehavior.dir ? 3 - resolvedBehavior.dir : resolvedBehavior.dir };
      if (!resolvedBehavior || !sameValue(durableBehavior, projectedBehavior)) {
        throw new Error(
          `Building V2 Current Building Snapshot generated Wall ${String(entry.documentId || '')} does not match its resolved structural Behavior.`
        );
      }
    }
    const shadowManager = await getShadowManager();
    if (!shadowManager || typeof shadowManager._collectShadowTilesAtElevation !== 'function') {
      throw new Error('Building V2 Current Building Snapshot requires the canonical Asset Shadow manager.');
    }
    const elevation = finite(rootSource.elevation ?? 0, 'Root elevation');
    const shadowTiles = shadowManager._collectShadowTilesAtElevation(elevation)
      .filter((document) => !isBuildingGeneratedTile(document))
      .map((document) => shadowTileSnapshot(document))
      .sort((left, right) => left.id.localeCompare(right.id));
    return immutableCopy({
      version: 1,
      sourceKind: 'v2',
      reference: { sceneId: normalizedSceneId, rootTileId: normalizedRootId, buildingId, generationId },
      authoring,
      baselineAuthoring,
      recovery: recoveredAuthoring ? {
        kind: 'interrupted-outer-appearance-draft',
        source: 'agreed-runtime-wall-projection'
      } : null,
      runtime: {
        authoringFingerprint: runtimeProjection.authoringFingerprint,
        fillProjection: clone(runtimeProjection.fillProjection || null),
        sills: clone(sillParts)
      },
      pose,
      presentation: {
        elevation, sort: Number(rootSource.sort) || 0, hidden: rootSource.hidden === true,
        locked: rootSource.locked === true, levels: clone(rootSource.levels || []),
        wallLevels,
        fill: fillSource ? {
          elevation: Number(fillSource.elevation) || 0,
          sort: Number(fillSource.sort) || 0,
          hidden: fillSource.hidden === true,
          locked: fillSource.locked === true,
          levels: clone(fillSource.levels || [])
        } : null,
        sills: sillsSource ? {
          elevation: Number(sillsSource.elevation), sort: Number(sillsSource.sort),
          hidden: sillsSource.hidden === true, locked: sillsSource.locked === true,
          levels: clone(sillsSource.levels || [])
        } : null
      },
      ownership: {
        wallIds: wallExpected.map((entry) => String(entry.documentId)),
        semanticWallDocumentIds,
        relationshipIdsBySemanticId,
        fillTileId,
        fillRelationshipId,
        sillsTileId,
        sillsRelationshipId,
        regionId,
        regionRelationshipId
      },
      baselines: {
        semantic: fingerprint(authoring), pose: fingerprint({ x, y, width, height, rotation, anchorX, anchorY }),
        ownership: fingerprint({ walls, fill: fillSource, sills: sillsSource, regions, relationships })
      },
      durable: {
        root: rootSource,
        building: clone(building),
        walls,
        fill: fillSource,
        sills: sillsSource,
        regions,
        relationships,
        compositionRegistry: registry,
        shadowTiles
      }
    });
  };

  const createSpatialTransform = (snapshot) => {
    return createBuildingV2SpatialTransform(snapshot?.pose);
  };

  const createRefitPlan = (snapshot, { renderEnvelope, nativeFragments } = {}) => {
    const plan = createBuildingV2RefitPlan(snapshot?.pose, { renderEnvelope, nativeFragments });
    let result = plan;
    if (hasActiveBuildingV2Fill(snapshot?.authoring?.fill)) {
      if (!snapshot?.ownership?.fillTileId || !snapshot?.durable?.fill) {
        throw new Error('Building V2 managed Fill refit requires the captured Fill identity and durable source.');
      }
      result = {
        ...result,
        fill: {
          tileId: snapshot.ownership.fillTileId,
          ...clone(plan.root),
          presentation: clone(snapshot.presentation?.fill || null)
        }
      };
    }
    if (snapshot?.runtime?.sills?.length) {
      if (!snapshot?.ownership?.sillsTileId || !snapshot?.durable?.sills) {
        throw new Error('Building V2 managed Sills refit requires the captured Sills identity and durable source.');
      }
      result = {
        ...result,
        sills: {
          tileId: snapshot.ownership.sillsTileId,
          ...clone(plan.root),
          presentation: clone(snapshot.presentation?.sills || null)
        }
      };
    }
    return immutableCopy(result);
  };

  const restoreSuppressedDisplay = (suppressed) => {
    for (const [displayObject, prior] of suppressed.displayStates) {
      if (!displayObject || displayObject.destroyed) continue;
      displayObject.visible = prior.visible;
      displayObject.renderable = prior.renderable;
    }
    suppressed.displayStates.clear();
  };

  const beginPreparedReplacement = async (snapshot) => {
    const canvas = getCanvas();
    const scene = canvas?.scene;
    if (!scene || String(scene.id || '') !== snapshot?.reference?.sceneId) {
      throw new Error('Building V2 prepared replacement requires the captured active Scene.');
    }
    const removedEdges = [];
    const suppressedTiles = [];
    const suppressedDoors = { displayStates: new Map() };
    const ownedWallIds = new Set(snapshot.ownership.wallIds);
    const suppressionHookIds = [];
    let primaryChildListener = null;
    const root = collectionGet(scene.tiles, snapshot.reference.rootTileId);
    let shadowManager = null;
    const suspendedShadowTiles = [];
    const captureDisplayState = (suppressed, displayObject) => {
      if (!displayObject || displayObject.destroyed || suppressed.displayStates.has(displayObject)) return;
      suppressed.displayStates.set(displayObject, {
        visible: displayObject.visible,
        renderable: displayObject.renderable
      });
    };
    const suppressDisplayObject = (suppressed, displayObject) => {
      if (!displayObject || displayObject.destroyed) return;
      captureDisplayState(suppressed, displayObject);
      displayObject.visible = false;
      displayObject.renderable = false;
    };
    const suppressPlaceableDisplay = (suppressed, placeable) => {
      if (!placeable) return;
      suppressDisplayObject(suppressed, placeable);
      suppressDisplayObject(suppressed, placeable.mesh);
      suppressDisplayObject(suppressed,
        placeable.faNexusMaskContainer || placeable.mesh?.faNexusMaskContainer || null);
    };
    const releaseSuppressionHooks = () => {
      if (primaryChildListener) {
        canvas.primary.off('childAdded', primaryChildListener);
        primaryChildListener = null;
      }
      const hooks = getHooks?.();
      if (typeof hooks?.off !== 'function') return;
      for (const [hook, id] of suppressionHookIds) hooks.off(hook, id);
      suppressionHookIds.length = 0;
    };
    const enforceSuppression = (documentOrPlaceable) => {
      const document = documentOrPlaceable?.document || documentOrPlaceable;
      const tileId = String(document?.id || document?._id || '');
      const suppressed = suppressedTiles.find((entry) => entry.tileId === tileId);
      if (!suppressed) return false;
      const placeable = documentOrPlaceable?.document
        ? documentOrPlaceable
        : document?.object || collectionGet(scene.tiles, tileId)?.object || suppressed.placeable;
      if (!placeable) return false;
      if (placeable !== suppressed.placeable) {
        clearTileEventModeBlocked(suppressed.placeable, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
        suppressed.placeable = placeable;
      }
      suppressPlaceableDisplay(suppressed, placeable);
      markTileEventModeBlocked(placeable, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
      invalidateCustomTileOverhead(placeable, 'building-v2-existing-edit-suppressed-refresh');
      return true;
    };
    const suppressDoorMesh = (mesh) => {
      const document = mesh?.object?.document;
      if (!ownedWallIds.has(document?.id) || collectionGet(scene.walls, document.id) !== document) return;
      suppressDisplayObject(suppressedDoors, mesh);
    };
    const enforceWallSuppression = (documentOrPlaceable) => {
      const wall = documentOrPlaceable?.document || documentOrPlaceable;
      if (!ownedWallIds.has(wall?.id) || collectionGet(scene.walls, wall.id) !== wall) return;
      const edge = wall.edge || wall.object?.edge;
      if (edge) canvas.edges.delete(edge.id);
      for (const mesh of wall.object?.doorMeshes || []) suppressDoorMesh(mesh);
    };
    const restoreCurrentWallEdges = () => {
      for (const wallId of ownedWallIds) {
        const wall = collectionGet(scene.walls, wallId);
        // An external gameplay update may have replaced the captured Edge during Edit.
        const edge = wall?.edge || wall?.object?.edge;
        if (edge) canvas.edges.set(edge.id, edge);
      }
    };
    try {
      for (const wallId of snapshot.ownership.wallIds) {
        const wall = collectionGet(scene.walls, wallId);
        const edge = canvas?.edges?.get?.(wallId) || wall?.edge || wall?.object?.edge || null;
        if (edge && canvas?.edges?.delete?.(edge.id ?? wallId)) removedEdges.push(edge);
        for (const mesh of wall?.object?.doorMeshes || []) suppressDoorMesh(mesh);
      }
      // v14 creates replacement DoorMeshes asynchronously; childAdded fires before their first render.
      if (typeof canvas.primary?.on === 'function' && typeof canvas.primary?.off === 'function') {
        primaryChildListener = suppressDoorMesh;
        canvas.primary.on('childAdded', primaryChildListener);
      } else if (suppressedDoors.displayStates.size) {
        throw new Error('Building V2 Door suppression requires primary container child lifecycle events.');
      }
      for (const tileId of snapshot.ownership.tileIds || [snapshot.reference.rootTileId, snapshot.ownership.fillTileId,
        snapshot.ownership.sillsTileId].filter(Boolean)) {
        const placeable = collectionGet(scene.tiles, tileId)?.object || null;
        if (!placeable) continue;
        const displayStates = new Map();
        const suppressed = { tileId, placeable, displayStates };
        placeable.release?.();
        suppressPlaceableDisplay(suppressed, placeable);
        markTileEventModeBlocked(placeable, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
        invalidateCustomTileOverhead(placeable, 'building-v2-existing-edit-suppressed');
        suppressedTiles.push(suppressed);
      }
      const hooks = getHooks?.();
      if (typeof hooks?.on === 'function') {
        for (const hook of ['drawTile', 'refreshTile', 'controlTile']) {
          suppressionHookIds.push([hook, hooks.on(hook, enforceSuppression)]);
        }
        for (const hook of ['updateWall', 'drawWall', 'refreshWall']) {
          suppressionHookIds.push([hook, hooks.on(hook, enforceWallSuppression)]);
        }
      }
      shadowManager = await getShadowManager();
      // Managed Sills cast through the shared shadow renderer independently of
      // both the Building Root and their own hidden Tile display subtree.
      for (const tile of (snapshot.ownership.tileIds || [root?.id, snapshot.ownership.sillsTileId])
        .map(id => collectionGet(scene.tiles, id)).filter(Boolean)) {
        if (shadowManager?.suspendTile?.(tile) === true) suspendedShadowTiles.push(tile);
      }
      refreshNativeEffects(canvas);
      await waitForTwoClientFrames();
      for (const suppressed of suppressedTiles) {
        const currentPlaceable = collectionGet(scene.tiles, suppressed.tileId)?.object || suppressed.placeable;
        if (currentPlaceable !== suppressed.placeable) {
          clearTileEventModeBlocked(suppressed.placeable, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
          suppressed.placeable = currentPlaceable;
        }
        currentPlaceable.release?.();
        suppressPlaceableDisplay(suppressed, currentPlaceable);
        markTileEventModeBlocked(currentPlaceable, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
        invalidateCustomTileOverhead(currentPlaceable, 'building-v2-existing-edit-suppressed-settled');
      }
      return {
        snapshot,
        removedEdges,
        suppressedTiles,
        suppressedDoors,
        restoreCurrentWallEdges,
        suppressionHookIds,
        releaseSuppressionHooks,
        shadowManager,
        suspendedShadowTiles,
        released: false
      };
    } catch (error) {
      releaseSuppressionHooks();
      restoreCurrentWallEdges();
      restoreSuppressedDisplay(suppressedDoors);
      for (const suppressed of suppressedTiles) {
        restoreSuppressedDisplay(suppressed);
        clearTileEventModeBlocked(suppressed.placeable, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
        suppressed.placeable.renderFlags?.set?.({ refreshState: true });
        invalidateCustomTileOverhead(suppressed.placeable, 'building-v2-existing-edit-suppression-failed');
      }
      for (const tile of suspendedShadowTiles) shadowManager?.resumeTile?.(tile, { immediate: false });
      refreshNativeEffects(canvas);
      throw error;
    }
  };

  const releasePreparedReplacement = (handle, { restore = true } = {}) => {
    if (!handle || handle.released) return false;
    handle.released = true;
    handle.releaseSuppressionHooks?.();
    if (handle.suppressedDoors) restoreSuppressedDisplay(handle.suppressedDoors);
    const canvas = getCanvas();
    const scene = canvas?.scene;
    for (const suppressed of handle.suppressedTiles || []) {
      const currentPlaceable = collectionGet(scene?.tiles, suppressed.tileId)?.object || suppressed.placeable;
      if (currentPlaceable) {
        restoreSuppressedDisplay(suppressed);
        clearTileEventModeBlocked(currentPlaceable, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
        currentPlaceable.renderFlags?.set?.({ refreshState: true });
        invalidateCustomTileOverhead(currentPlaceable, 'building-v2-existing-edit-restored');
      }
    }
    if (restore) {
      handle.restoreCurrentWallEdges();
      for (const tile of handle.suspendedShadowTiles) handle.shadowManager?.resumeTile?.(tile, { immediate: false });
    } else {
      for (const wallId of handle.snapshot.ownership.wallIds) {
        const wall = collectionGet(scene?.walls, wallId);
        const edge = wall?.edge || wall?.object?.edge || canvas?.edges?.get?.(wallId) || null;
        if (edge) canvas?.edges?.set?.(edge.id ?? wallId, edge);
      }
    }
    refreshNativeEffects(canvas);
    return true;
  };

  return Object.freeze({
    capture,
    captureImported,
    createSpatialTransform,
    createRefitPlan,
    beginPreparedReplacement,
    releasePreparedReplacement
  });
}
