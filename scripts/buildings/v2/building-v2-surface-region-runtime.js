import { tessellateBuildingV2WallGeometry } from './building-v2-curve-runtime.js';
import { createBuildingV2SpatialTransform, deriveBuildingV2SpatialPose } from './building-v2-spatial-transform.js';

const MODULE_ID = 'fa-nexus';
export const BUILDING_V2_SURFACE_REGION_RUNTIME_VERSION = 1;

function identity(value, label) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`Building V2 Surface Region requires ${label}.`);
  return result;
}

function point(value) {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) {
    throw new Error('Building V2 Surface Region requires finite compact boundary points.');
  }
  return value;
}

function samePoint(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y) <= 1e-6;
}

/** Validate the compiled boundary against its authored owners without deriving topology. */
export function validateBuildingV2SurfaceRegionProjection(projection, authoring) {
  const topology = authoring?.outerTopology;
  const exteriorIds = topology?.exteriorLoopIds || [];
  const holeIds = topology?.holeLoopIds || [];
  const loopIds = [...exteriorIds, ...holeIds];
  const fail = () => { throw new Error('Building V2 Surface Region compact projection does not match authored outer topology.'); };
  if (projection?.version !== 1 || projection?.role !== 'surface-region' || !exteriorIds.length
    || !Array.isArray(projection.loops) || projection.loops.length !== loopIds.length) fail();
  const weights = (geometry) => geometry?.conicState?.weights || [1, geometry?.conicState?.weight ?? 1, 1];
  for (let index = 0; index < loopIds.length; index += 1) {
    const loop = projection.loops[index];
    const edges = topology.loopsById?.[loopIds[index]]?.edges;
    if (loop?.role !== (index < exteriorIds.length ? 'outer' : 'hole')
      || !Array.isArray(edges) || !Array.isArray(loop.segments) || edges.length !== loop.segments.length) fail();
    edges.forEach((edge, ordinal) => {
      const geometry = authoring.semanticWallsById?.[edge.semanticWallId]?.geometry;
      const segment = loop.segments[ordinal];
      const reverse = edge.direction === 'reverse';
      const start = authoring.topologyVerticesById?.[reverse ? geometry?.endVertexId : geometry?.startVertexId];
      const end = authoring.topologyVerticesById?.[reverse ? geometry?.startVertexId : geometry?.endVertexId];
      if (!samePoint(point(segment?.start), point(start)) || !samePoint(point(segment?.end), point(end))
        || segment.geometry?.kind !== geometry?.kind) fail();
      if (geometry.kind === 'conic') {
        const expectedWeights = [...weights(geometry)];
        if (reverse) expectedWeights.reverse();
        const actualWeights = weights(segment.geometry);
        if (!samePoint(point(segment.geometry.control), point(geometry.control))
          || actualWeights.length !== 3 || expectedWeights.length !== 3
          || actualWeights.some((value, weightIndex) => !Number.isFinite(value)
            || Math.abs(value - expectedWeights[weightIndex]) > 1e-9)) fail();
      }
    });
  }
  return projection;
}

/** Disposable native shapes from compact outer topology, never Inner Paths or openings. */
export function materializeBuildingV2SurfaceRegionShapes(projection, { transform, sceneGridSize = 100 } = {}) {
  if (projection?.version !== BUILDING_V2_SURFACE_REGION_RUNTIME_VERSION
    || projection.role !== 'surface-region'
    || !Array.isArray(projection.loops)
    || !projection.loops.length
    || projection.loops.length > 128
    || !projection.loops.some((loop) => loop?.role === 'outer')
    || typeof transform?.localToWorld !== 'function'
    || !Number.isFinite(sceneGridSize) || sceneGridSize <= 0) {
    throw new Error('Building V2 Surface Region requires an exact outer-topology projection and spatial transform.');
  }
  let segmentCount = 0;
  let pointCount = 0;
  return projection.loops.map((loop) => {
    if (!['outer', 'hole'].includes(loop?.role) || !Array.isArray(loop.segments) || !loop.segments.length) {
      throw new Error('Building V2 Surface Region requires closed outer or hole boundary loops.');
    }
    const points = [];
    for (let index = 0; index < loop.segments.length; index += 1) {
      const segment = loop.segments[index];
      const start = point(segment?.start);
      const end = point(segment?.end);
      if (++segmentCount > 4096 || !samePoint(end, point(loop.segments[(index + 1) % loop.segments.length]?.start))) {
        throw new Error('Building V2 Surface Region has an open or oversized boundary.');
      }
      if (segment.geometry?.kind === 'conic') {
        point(segment.geometry.control);
        const state = segment.geometry.conicState;
        if ((state?.weights !== undefined && (!Array.isArray(state.weights) || state.weights.length !== 3
          || state.weights.some((weight) => !Number.isFinite(weight) || weight <= 0)))
          || (state?.weight !== undefined && (!Number.isFinite(state.weight) || state.weight <= 0))) {
          throw new Error('Building V2 Surface Region has invalid conic weights.');
        }
      }
      const samples = tessellateBuildingV2WallGeometry(start, segment.geometry, end, { sceneGridSize });
      points.push(...samples.slice(0, -1));
    }
    pointCount += points.length;
    const area = points.reduce((sum, entry, index) => {
      const next = points[(index + 1) % points.length];
      return sum + (entry.x * next.y) - (next.x * entry.y);
    }, 0);
    if (points.length < 3 || pointCount > 16384 || Math.abs(area) <= 1e-8) {
      throw new Error('Building V2 Surface Region has an empty or oversized polygon.');
    }
    const centroid = points.reduce((sum, entry, index) => {
      const next = points[(index + 1) % points.length];
      const cross = (entry.x * next.y) - (next.x * entry.y);
      sum.x += (entry.x + next.x) * cross;
      sum.y += (entry.y + next.y) * cross;
      return sum;
    }, { x: 0, y: 0 });
    return {
      type: 'polygon', hole: loop.role === 'hole',
      points: points.flatMap((entry) => {
        const world = point(transform.localToWorld(entry));
        return [world.x, world.y];
      }),
      // Foundry's client shape serializer exposes its computed origin even
      // when the source omitted it. Make that generated pivot explicit so
      // native aggregate verification and subsequent transforms agree.
      origin: point(transform.localToWorld({ x: centroid.x / (3 * area), y: centroid.y / (3 * area) }))
    };
  });
}

export function createBuildingV2SurfaceRegionDefaults({ levels = [], elevation = 0 } = {}) {
  return {
    name: 'Building Surface',
    elevation: typeof elevation === 'object' && elevation !== null
      ? structuredClone(elevation) : { bottom: elevation, top: elevation },
    levels: structuredClone(levels),
    behaviors: [
      { name: 'Define Surface', type: 'defineSurface', system: {
        placement: 'bottom', light: true, move: true, sight: true, sound: true,
        occlusion: true, exposure: false
      }, disabled: false },
      { name: 'Suppress Weather', type: 'suppressWeather', system: {}, disabled: false }
    ]
  };
}

/** Recommit only replaces generated geometry and ownership; Region presentation belongs to its document. */
export function createBuildingV2SurfaceRegionSource({
  projection, rootSource, building, sceneGridSize = 100,
  buildingId, rootTileId, generationId, regionId,
  levels = [], elevation = 0, existingSource = null
} = {}) {
  const owner = {
    version: 1,
    buildingId: identity(buildingId, 'Building identity'),
    rootTileId: identity(rootTileId, 'Root identity'),
    generationId: identity(generationId, 'generation identity'),
    role: 'surface-region', semanticId: null, fragmentOrdinal: 0
  };
  const transform = createBuildingV2SpatialTransform(deriveBuildingV2SpatialPose(rootSource, building));
  const source = existingSource ? structuredClone(existingSource) : createBuildingV2SurfaceRegionDefaults({ levels, elevation });
  source._id = identity(regionId, 'Region identity');
  source.shapes = materializeBuildingV2SurfaceRegionShapes(projection, { transform, sceneGridSize });
  source.flags ||= {};
  source.flags[MODULE_ID] ||= {};
  source.flags[MODULE_ID].buildingGenerated = owner;
  source.flags[MODULE_ID].buildingRegion = {
    ...source.flags[MODULE_ID].buildingRegion,
    wallTileId: owner.rootTileId,
    wallGroupId: owner.buildingId
  };
  return source;
}
