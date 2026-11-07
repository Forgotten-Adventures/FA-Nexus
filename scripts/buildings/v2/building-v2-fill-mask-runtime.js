import { evaluateBuildingV2Conic, tessellateBuildingV2WallGeometry } from './building-v2-curve-runtime.js';
import { evaluateBuildingV2Cubic, resolveBuildingV2SplineSpan, restrictBuildingV2Cubic } from './building-v2-spline-runtime.js';
import { resolveBuildingV2PresentationFrame } from './building-v2-root-frame.js';
import { deriveBuildingV2InstanceScale } from './building-v2-instance-scale.js';

/** Public, renderer-independent compiler for Building V2 array Fill masks. */
export const BUILDING_V2_FILL_MASK_RUNTIME_VERSION = 1;
export const BUILDING_V2_FILL_MASK_LIMITS = Object.freeze({
  maxLoops: 128,
  maxSegments: 4096,
  maxPoints: 16384,
  maxShapes: 128,
  maxSerializedBytes: 1024 * 1024
});

export class BuildingV2FillMaskError extends Error {
  constructor(message, code = 'invalid-fill-mask') {
    super(message);
    this.name = 'BuildingV2FillMaskError';
    this.code = code;
  }
}

function fail(message, code) { throw new BuildingV2FillMaskError(message, code); }
function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`Building V2 Fill Mask ${label} must be finite.`, 'non-finite');
  return number;
}
function positive(value, label) {
  const number = finite(value, label);
  if (!(number > 0)) fail(`Building V2 Fill Mask ${label} must be greater than zero.`, 'non-positive');
  return number;
}
function copyFreeze(value) {
  const copy = globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return entry;
    for (const child of Object.values(entry)) visit(child);
    return Object.freeze(entry);
  };
  return visit(copy);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function fnv1a(value) {
  const text = JSON.stringify(stable(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function cleanTransformNumber(value, places = 9) {
  const factor = 10 ** places;
  const rounded = Math.round(Number(value) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}
function sourcePayload(source) {
  if (Number(source.version) === 2) return { version: 2, textureBasis: source.textureBasis, regions: source.regions };
  return { version: source.version, verticesById: source.verticesById, loops: source.loops };
}
function sourceFingerprint(source) { return fnv1a(sourcePayload(source)); }
function byteSize(value) { return new TextEncoder().encode(JSON.stringify(value)).length; }
function id(value, label) {
  const result = String(value || '').trim();
  if (!result) fail(`Building V2 Fill Mask ${label} requires a non-empty id.`, 'missing-id');
  return result;
}
function point(value, label) { return { x: finite(value?.x, `${label} x`), y: finite(value?.y, `${label} y`) }; }

const FILL_SCALE_PERCENT_MIN = 25;
const FILL_SCALE_PERCENT_MAX = 300;
const HSBC_DEFAULTS = Object.freeze({ hue: 0, saturation: 1, brightness: 1, contrast: 1 });

function normalizedFillHsbc(value) {
  const source = value && typeof value === 'object' ? value : {};
  const clamp = (candidate, min, max, fallback) => {
    const number = candidate == null ? fallback : finite(candidate, 'Fill HSBC value');
    return Math.min(max, Math.max(min, number));
  };
  const round = (candidate, places = 3) => cleanTransformNumber(candidate, places);
  return {
    hue: round(clamp(source.hue, -180, 180, HSBC_DEFAULTS.hue), 0),
    saturation: round(clamp(source.saturation, 0, 2, HSBC_DEFAULTS.saturation)),
    brightness: round(clamp(source.brightness, 0, 2, HSBC_DEFAULTS.brightness)),
    contrast: round(clamp(source.contrast, 0, 2, HSBC_DEFAULTS.contrast))
  };
}

/**
 * Normalize the authored Fill appearance at the public projection boundary.
 * The texture basis remains the sole phase authority; these values only
 * describe its local sampling transform and presentation.
 */
export function normalizeBuildingV2FillAppearance(value = {}) {
  const appearance = value && typeof value === 'object' ? value : {};
  const optionalFinite = (candidate, fallback, label) => (
    candidate == null ? fallback : finite(candidate, label)
  );
  const scalePercent = optionalFinite(appearance.scalePercent, 100, 'Fill scalePercent');
  if (scalePercent < FILL_SCALE_PERCENT_MIN || scalePercent > FILL_SCALE_PERCENT_MAX) {
    fail(
      `Building V2 Fill scalePercent must be between ${FILL_SCALE_PERCENT_MIN} and ${FILL_SCALE_PERCENT_MAX}.`,
      'invalid-appearance-scale'
    );
  }
  const rotationDegrees = optionalFinite(appearance.rotationDegrees, 0, 'Fill rotationDegrees');
  if (rotationDegrees < 0 || rotationDegrees >= 360) {
    fail('Building V2 Fill rotationDegrees must be between 0 and 359.', 'invalid-appearance-rotation');
  }
  const offset = {
    x: optionalFinite(appearance.offset?.x, 0, 'Fill offset x'),
    y: optionalFinite(appearance.offset?.y, 0, 'Fill offset y')
  };
  if (Math.abs(offset.x) > 1000 || Math.abs(offset.y) > 1000) {
    fail('Building V2 Fill offsets must be between -1000 and 1000.', 'invalid-appearance-offset');
  }
  const opacity = optionalFinite(appearance.opacity, 1, 'Fill opacity');
  if (opacity < 0 || opacity > 1) fail('Building V2 Fill opacity must be between 0 and 1.', 'invalid-appearance-opacity');
  return copyFreeze({
    scalePercent: cleanTransformNumber(scalePercent),
    rotationDegrees: cleanTransformNumber(rotationDegrees),
    offset: {
      x: cleanTransformNumber(offset.x),
      y: cleanTransformNumber(offset.y)
    },
    opacity: cleanTransformNumber(opacity),
    hsbc: normalizedFillHsbc(appearance.hsbc)
  });
}

export function resolveBuildingV2FillIntent(fillDefault = {}, override = null) {
  const allowedFields = (value, fields, label) => {
    if (value == null) return;
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
      fail(`Building V2 Fill ${label} contains unsupported fields.`, 'invalid-fill-override');
    }
  };
  allowedFields(override, ['fillMode', 'asset', 'appearance'], 'Region override');
  allowedFields(override?.appearance, ['scalePercent', 'rotationDegrees', 'offset', 'opacity', 'hsbc'], 'Region appearance');
  allowedFields(override?.appearance?.offset, ['x', 'y'], 'Region offset');
  allowedFields(override?.appearance?.hsbc, ['hue', 'saturation', 'brightness', 'contrast'], 'Region HSBC');
  if (override && Object.hasOwn(override, 'fillMode') && !['asset', 'no-fill'].includes(override.fillMode)) fail('Building V2 Fill override has an invalid mode.', 'invalid-fill-mode');
  if (override && Object.hasOwn(override, 'asset') && (typeof override.asset?.key !== 'string' || !override.asset.key.trim()
    || typeof override.asset?.src !== 'string' || !override.asset.src.trim())) fail('Building V2 Fill override requires its exact asset source and key.', 'missing-asset');
  const base = fillDefault?.appearance || {};
  const patch = override?.appearance || {};
  const active = override?.fillMode === 'no-fill' ? false
    : override?.fillMode === 'asset' || override?.asset != null ? true : fillDefault?.active === true;
  const asset = override?.asset ?? fillDefault?.asset ?? null;
  if (active && (typeof asset?.key !== 'string' || !asset.key.trim() || typeof asset?.src !== 'string' || !asset.src.trim())) fail('Building V2 active Fill requires its exact asset source and key.', 'missing-asset');
  return copyFreeze({ active, asset, appearance: normalizeBuildingV2FillAppearance({
    ...base, ...patch, offset: { ...base.offset, ...patch.offset }, hsbc: { ...base.hsbc, ...patch.hsbc }
  }) });
}

export function representativeBuildingV2Fill(fill) {
  if (!fill?.default) return fill || null;
  const intent = Object.keys(fill.regionsById || {}).sort().map((key) => resolveBuildingV2FillIntent(fill.default, fill.regionsById[key].override))
    .find((entry) => entry.active) || resolveBuildingV2FillIntent({ ...fill.default, active: false });
  return copyFreeze({ ...intent, appearance: normalizeBuildingV2FillAppearance(), textureBasis: fill.textureBasis });
}

export function hasActiveBuildingV2Fill(fill) { return representativeBuildingV2Fill(fill)?.active === true; }

// Restrict the homogeneous quadratic directly; no arrangement or sampled geometry is reconstructed.
function boundSpan(authoring, span) {
  const outer = authoring.semanticWallsById?.[span.semanticWallId];
  const interior = authoring.interiorPathSegmentsById?.[span.semanticWallId];
  const wall = outer || interior;
  if (!wall) fail(`Building V2 Fill binding references missing segment ${span.semanticWallId}.`, 'missing-segment');
  if (outer && interior) fail('Building V2 Fill binding has ambiguous segment ownership.', 'invalid-binding-owner');
  if (interior) {
    const path = authoring.interiorPathsById?.[span.pathId];
    if (!span.pathId || wall.owner?.kind !== 'interior-path' || wall.owner.id !== span.pathId || !path
      || !path.edges?.some((edge) => edge.semanticWallId === span.semanticWallId)
      || !['wall', 'fill-divider'].includes(path.purpose)
      || (path.purpose === 'wall' && path.fillParticipation === false)) {
      fail('Building V2 Fill binding references a nonparticipating or mismatched Interior Path.', 'invalid-binding-owner');
    }
  } else {
    const topology = authoring.outerTopology;
    const loopId = wall.owner?.id;
    if (span.pathId != null || wall.owner?.kind !== 'outer-loop'
      || ![...(topology?.exteriorLoopIds || []), ...(topology?.holeLoopIds || [])].includes(loopId)
      || !topology?.loopsById?.[loopId]?.edges?.some((edge) => edge.semanticWallId === span.semanticWallId)) {
      fail('Building V2 Fill binding references a mismatched outer boundary.', 'invalid-binding-owner');
    }
  }
  const spline = wall.geometry.kind === 'spline-span' ? resolveBuildingV2SplineSpan(authoring, wall) : null;
  const geometry = spline?.geometry || normalizeGeometry(wall, span.semanticWallId);
  const start = spline?.start || point(authoring.topologyVerticesById?.[wall.geometry.startVertexId], 'bound start');
  const end = spline?.end || point(authoring.topologyVerticesById?.[wall.geometry.endVertexId], 'bound end');
  if (!Array.isArray(span.range) || span.range.length !== 2) fail('Building V2 Fill binding requires a range.', 'invalid-range');
  const [a, b] = span.range.map((value) => finite(value, 'binding range'));
  if (a < 0 || a > 1 || b < 0 || b > 1 || a === b) fail('Building V2 Fill binding has an invalid range.', 'invalid-range');
  if (geometry.kind === 'cubic') return restrictBuildingV2Cubic(start, geometry, end, a, b);
  const mix = (p, q, t) => p.map((v, i) => v + (q[i] - v) * t);
  if (geometry.kind === 'line') {
    const at = (t) => ({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
    return { start: at(a), end: at(b), geometry };
  }
  const controls = [start, geometry.control, end].map((p, i) => {
    const w = geometry.conicState.weights[i]; return [p.x * w, p.y * w, w];
  });
  const blossom = (u, v) => mix(mix(controls[0], controls[1], u), mix(controls[1], controls[2], u), v);
  const restricted = [blossom(a, a), blossom(a, b), blossom(b, b)];
  const cart = (p) => ({ x: p[0] / p[2], y: p[1] / p[2] });
  return { start: cart(restricted[0]), end: cart(restricted[2]), geometry: {
    kind: 'conic', control: cart(restricted[1]), conicState: { weights: restricted.map((p) => p[2]) }
  } };
}

function deriveCompositeSource(authoring, regionFaces, limits) {
  const fill = authoring.fill;
  const faces = regionFaces ?? Object.keys(fill.regionsById || {}).map((key) => {
    const region = fill.regionsById[key];
    if (region.faceBinding?.version !== 1) fail('Building V2 Fill Region requires a supported face binding.', 'invalid-binding');
    return { id: key, override: region.override, loops: region.faceBinding.boundaryIncidence.map((cycle) => ({
      kind: cycle.role === 'outer' ? 'exterior' : cycle.role === 'hole' ? 'hole' : null,
      segments: cycle.spans.map((span) => boundSpan(authoring, span))
    })) };
  });
  const seen = new Set();
  if (faces.length > limits.maxShapes) fail('Building V2 composite Fill exceeds Region limit.', 'limit-shapes');
  const regions = [...faces].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0).map((face) => {
    const regionId = id(face.id, 'Region');
    if (seen.has(regionId)) fail('Building V2 Fill repeats a Region id.', 'duplicate-region');
    seen.add(regionId);
    // Stable generated loop ids make durable-binding and prospective compact inputs equivalent.
    const normalizeNumbers = (value) => typeof value === 'number' ? cleanTransformNumber(value)
      : Array.isArray(value) ? value.map(normalizeNumbers)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeNumbers(entry)])) : value;
    const loops = face.loops.map((loop, index) => {
      // Region cycles already encode confirmed semantic intersections. Their
      // independent compact evaluations can straddle the 9-place rounding
      // boundary. Normalize each shared endpoint once, before rounding, within
      // the same numerical bound used to admit the intersection. This does not
      // discover contacts or change the strict general projection-loop input.
      const segments = loop.segments || [];
      const vertices = segments.map((segment, ordinal) => {
        const start = point(segment.start, 'Region boundary start');
        const end = point(segments[(ordinal + segments.length - 1) % segments.length].end, 'Region boundary end');
        const scale = Math.max(1, Math.abs(start.x), Math.abs(start.y), Math.abs(end.x), Math.abs(end.y));
        if (Math.hypot(start.x - end.x, start.y - end.y) > Math.max(1e-9, Number.EPSILON * scale * 64)) {
          fail(`Building V2 Fill Region ${regionId} is not a continuous closed chain.`, 'open-loop');
        }
        return start.x < end.x || (start.x === end.x && start.y <= end.y) ? start : end;
      });
      return { ...normalizeNumbers({ ...loop, segments: segments.map((segment, ordinal) => ({ ...segment,
        start: vertices[ordinal], end: vertices[(ordinal + 1) % vertices.length]
      })) }), loopId: `${regionId}:loop:${index}` };
    });
    return { regionId, ...resolveBuildingV2FillIntent(fill.default, face.override),
      maskSource: deriveBuildingV2FillMaskSourceFromProjectionTopology({ loops }, { limits }) };
  });
  const source = { version: 2, textureBasis: fill.textureBasis, regions };
  const result = { ...source, fingerprint: sourceFingerprint(source) };
  if (byteSize(result) > limits.maxSerializedBytes) fail('Building V2 composite Fill exceeds serialized-byte limit.', 'limit-bytes');
  return copyFreeze(result);
}

function normalizeGeometry(wall, semanticWallId) {
  const geometry = wall?.geometry;
  if (geometry?.kind === 'line') return { kind: 'line' };
  if (geometry?.kind === 'cubic') {
    if (!Array.isArray(geometry.controls) || geometry.controls.length !== 2) fail('Building V2 cubic Fill span requires two controls.', 'unsupported-geometry');
    return { kind: 'cubic', controls: geometry.controls.map(value => point(value, `cubic ${semanticWallId} control`)) };
  }
  if (geometry?.kind !== 'conic') fail(`Building V2 Fill Mask semantic Wall ${semanticWallId} has unsupported geometry.`, 'unsupported-geometry');
  const control = point(geometry.control, `conic ${semanticWallId} control`);
  const weights = geometry?.conicState?.weights;
  const normalizedWeights = Array.isArray(weights) && weights.length === 3
    ? weights.map((value) => positive(value, `conic ${semanticWallId} weight`))
    : [1, positive(geometry?.conicState?.weight ?? 1, `conic ${semanticWallId} weight`), 1];
  return { kind: 'conic', control, conicState: { weights: normalizedWeights } };
}

/** Derive compact semantic source; sampled points never enter this authority. */
export function deriveBuildingV2FillMaskSource(authoring, { limits = BUILDING_V2_FILL_MASK_LIMITS } = {}) {
  const topology = authoring?.outerTopology;
  const loopsById = topology?.loopsById;
  const walls = authoring?.semanticWallsById;
  const vertices = authoring?.topologyVerticesById;
  if (!loopsById || !walls || !vertices) fail('Building V2 Fill Mask Source requires schema-v4 outer topology, semantic Walls, and vertices.', 'missing-authoring');
  const ordered = [
    ...(Array.isArray(topology.exteriorLoopIds) ? topology.exteriorLoopIds.map((loopId) => [loopId, 'add']) : []),
    ...(Array.isArray(topology.holeLoopIds) ? topology.holeLoopIds.map((loopId) => [loopId, 'subtract']) : [])
  ];
  if (!ordered.length) fail('Building V2 Fill Mask Source requires at least one exterior loop.', 'empty-topology');
  if (ordered.length > limits.maxLoops) fail('Building V2 Fill Mask Source exceeds loop limit.', 'limit-loops');
  const seenLoops = new Set();
  const usedVertices = {};
  let segmentCount = 0;
  const loops = ordered.map(([rawLoopId, operation]) => {
    const loopId = id(rawLoopId, 'loop');
    if (seenLoops.has(loopId)) fail(`Building V2 Fill Mask Source repeats loop ${loopId}.`, 'duplicate-loop');
    seenLoops.add(loopId);
    const loop = loopsById[loopId];
    if (!loop || !Array.isArray(loop.edges) || loop.edges.length < 2) fail(`Building V2 Fill Mask loop ${loopId} must have at least two ordered edges.`, 'malformed-loop');
    const segments = loop.edges.map((edge, index) => {
      const semanticWallId = id(edge?.semanticWallId, `loop ${loopId} edge ${index}`);
      const wall = walls[semanticWallId];
      const startVertexId = id(wall?.geometry?.startVertexId, `semantic Wall ${semanticWallId} start vertex`);
      const endVertexId = id(wall?.geometry?.endVertexId, `semantic Wall ${semanticWallId} end vertex`);
      if (!vertices[startVertexId] || !vertices[endVertexId]) fail(`Building V2 Fill Mask semantic Wall ${semanticWallId} references a missing vertex.`, 'missing-vertex');
      usedVertices[startVertexId] = point(vertices[startVertexId], `vertex ${startVertexId}`);
      usedVertices[endVertexId] = point(vertices[endVertexId], `vertex ${endVertexId}`);
      segmentCount += 1;
      if (segmentCount > limits.maxSegments) fail('Building V2 Fill Mask Source exceeds segment limit.', 'limit-segments');
      const direction = edge?.direction === 'reverse' ? 'reverse' : edge?.direction === 'forward' ? 'forward' : null;
      if (!direction) fail(`Building V2 Fill Mask loop ${loopId} has invalid edge direction.`, 'invalid-direction');
      return { semanticWallId, startVertexId, endVertexId, direction, geometry: normalizeGeometry(wall, semanticWallId) };
    });
    for (let index = 0; index < segments.length; index += 1) {
      const current = segments[index];
      const next = segments[(index + 1) % segments.length];
      const exit = current.direction === 'forward' ? current.endVertexId : current.startVertexId;
      const enter = next.direction === 'forward' ? next.startVertexId : next.endVertexId;
      if (exit !== enter) fail(`Building V2 Fill Mask loop ${loopId} is not an ordered closed chain.`, 'open-loop');
    }
    if (segments.length === 2) {
      if (!segments.some((segment) => segment.geometry.kind !== 'line')) fail(`Building V2 Fill Mask loop ${loopId} has two straight edges.`, 'degenerate-loop');
      // Validation-only samples establish a nonzero lens; compact geometry remains the source authority.
      const samples = segments.flatMap((segment) => {
        const start = usedVertices[segment.startVertexId];
        const end = usedVertices[segment.endVertexId];
        const count = segment.geometry.kind !== 'line' ? 32 : 1;
        return Array.from({ length: count }, (_, index) => {
          const t = segment.direction === 'forward' ? index / count : 1 - index / count;
          return segment.geometry.kind === 'cubic' ? evaluateBuildingV2Cubic(start, segment.geometry, end, t)
            : segment.geometry.kind === 'conic' ? evaluateBuildingV2Conic(start, segment.geometry, end, t)
            : { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
        });
      });
      const origin = samples[0];
      const twiceArea = samples.reduce((sum, sample, index) => {
        const next = samples[(index + 1) % samples.length];
        return sum + (sample.x - origin.x) * (next.y - origin.y) - (next.x - origin.x) * (sample.y - origin.y);
      }, 0);
      const extent = Math.max(...samples.map((sample) => Math.hypot(sample.x - origin.x, sample.y - origin.y)));
      if (Math.abs(twiceArea) <= Number.EPSILON * extent * extent * 64) fail(`Building V2 Fill Mask loop ${loopId} encloses no area.`, 'degenerate-loop');
    }
    return { loopId, operation, segments };
  });
  if (!loops.some((loop) => loop.operation === 'add')) fail('Building V2 Fill Mask Source requires an exterior loop.', 'missing-exterior');
  const candidate = { version: BUILDING_V2_FILL_MASK_RUNTIME_VERSION, verticesById: usedVertices, loops };
  const result = { ...candidate, fingerprint: sourceFingerprint(candidate) };
  if (byteSize(result) > limits.maxSerializedBytes) fail('Building V2 Fill Mask Source exceeds serialized-byte limit.', 'limit-bytes');
  return copyFreeze(result);
}

export function deriveBuildingV2FillMaskSourceFromProjectionTopology(
  projectionTopology,
  { limits = BUILDING_V2_FILL_MASK_LIMITS } = {}
) {
  const loops = projectionTopology?.loops;
  if (!Array.isArray(loops)) {
    fail('Building V2 prospective Fill Mask Source requires projection Boundary Loops.', 'missing-projection-topology');
  }
  const authoring = {
    topologyVerticesById: {},
    semanticWallsById: {},
    outerTopology: { loopsById: {}, exteriorLoopIds: [], holeLoopIds: [] }
  };
  const assignVertex = (vertexId, value, label) => {
    const normalized = point(value, label);
    const prior = authoring.topologyVerticesById[vertexId];
    if (prior && (prior.x !== normalized.x || prior.y !== normalized.y)) {
      fail(`Building V2 prospective Fill Mask loop is not a continuous closed chain at ${vertexId}.`, 'open-loop');
    }
    authoring.topologyVerticesById[vertexId] = normalized;
  };
  for (const [loopOrdinal, loop] of loops.entries()) {
    const loopId = id(loop?.loopId || `projection-loop-${loopOrdinal}`, 'projection loop');
    if (!['exterior', 'hole'].includes(loop?.kind)) {
      fail(`Building V2 prospective Fill Mask loop ${loopId} has an invalid kind.`, 'invalid-operation');
    }
    const operation = loop.kind === 'hole' ? 'subtract' : 'add';
    const segments = Array.isArray(loop?.segments) ? loop.segments : [];
    if (segments.length < 2) {
      fail(`Building V2 prospective Fill Mask loop ${loopId} must have at least three segments.`, 'malformed-loop');
    }
    const edges = segments.map((segment, segmentOrdinal) => {
      const semanticWallId = `${loopId}:fill-wall:${segmentOrdinal}`;
      const startVertexId = `${loopId}:fill-vertex:${segmentOrdinal}`;
      const endVertexId = `${loopId}:fill-vertex:${(segmentOrdinal + 1) % segments.length}`;
      const start = segment?.start || loop?.points?.[segmentOrdinal];
      const end = segment?.end || loop?.points?.[(segmentOrdinal + 1) % segments.length];
      assignVertex(startVertexId, start, `projection loop ${loopId} start ${segmentOrdinal}`);
      assignVertex(endVertexId, end, `projection loop ${loopId} end ${segmentOrdinal}`);
      const geometry = segment?.geometry?.kind === 'cubic'
        ? { ...normalizeGeometry(segment, semanticWallId), startVertexId, endVertexId }
        : segment?.geometry?.kind === 'conic'
        ? {
            kind: 'conic',
            startVertexId,
            endVertexId,
            control: point(segment.geometry.control, `projection conic ${semanticWallId} control`),
            conicState: copyFreeze(segment.geometry.conicState || {})
          }
        : { kind: 'line', startVertexId, endVertexId };
      authoring.semanticWallsById[semanticWallId] = { geometry };
      return { semanticWallId, direction: 'forward' };
    });
    authoring.outerTopology.loopsById[loopId] = { edges };
    authoring.outerTopology[operation === 'subtract' ? 'holeLoopIds' : 'exteriorLoopIds'].push(loopId);
  }
  return deriveBuildingV2FillMaskSource(authoring, { limits });
}

// Capability-contract entry point. Prospective topology is the exact current
// Add/Subtract result; settled projection continues to accept durable authoring.
export function compileBuildingV2FillMaskSource(authoring, {
  regionFaces = null,
  projectionTopology = null,
  limits = BUILDING_V2_FILL_MASK_LIMITS
} = {}) {
  if (authoring?.fill?.default) return deriveCompositeSource(authoring, regionFaces, limits);
  return projectionTopology
    ? deriveBuildingV2FillMaskSourceFromProjectionTopology(projectionTopology, { limits })
    : deriveBuildingV2FillMaskSource(authoring, { limits });
}

export function validateBuildingV2FillMaskSource(source, { limits = BUILDING_V2_FILL_MASK_LIMITS } = {}) {
  if (Number(source?.version) === 2) {
    if (source.fingerprint !== sourceFingerprint(source)) fail('Building V2 composite Fill fingerprint mismatch.', 'stale-fingerprint');
    if (!Array.isArray(source.regions) || source.regions.length > limits.maxShapes || byteSize(source) > limits.maxSerializedBytes) fail('Building V2 composite Fill exceeds limits.', 'invalid-source');
    const seen = new Set();
    for (const region of source.regions) {
      const regionId = id(region.regionId, 'Region');
      if (seen.has(regionId)) fail('Building V2 composite Fill repeats a Region.', 'duplicate-region');
      seen.add(regionId);
      resolveBuildingV2FillIntent(region);
      if (Number(region.maskSource?.version) !== 1) fail('Building V2 Region mask must be compact version 1.', 'unsupported-version');
      validateBuildingV2FillMaskSource(region.maskSource, { limits });
    }
    return copyFreeze(source);
  }
  if (!source || Number(source.version) !== BUILDING_V2_FILL_MASK_RUNTIME_VERSION) fail('Building V2 Fill Mask Source has an unsupported version.', 'unsupported-version');
  if (String(source.fingerprint || '') !== sourceFingerprint(source)) fail('Building V2 Fill Mask Source fingerprint does not match its compact authority.', 'stale-fingerprint');
  // Re-derive through the same strict topology validator without accepting caller-owned samples.
  const authoring = { topologyVerticesById: source.verticesById, semanticWallsById: {}, outerTopology: { loopsById: {}, exteriorLoopIds: [], holeLoopIds: [] } };
  for (const loop of source.loops || []) {
    const isAdd = loop?.operation === 'add';
    const isSubtract = loop?.operation === 'subtract';
    if (!isAdd && !isSubtract) fail('Building V2 Fill Mask Source has an invalid loop operation.', 'invalid-operation');
    authoring.outerTopology[isAdd ? 'exteriorLoopIds' : 'holeLoopIds'].push(loop.loopId);
    authoring.outerTopology.loopsById[loop.loopId] = { edges: (loop.segments || []).map((segment) => ({ semanticWallId: segment.semanticWallId, direction: segment.direction })) };
    for (const segment of loop.segments || []) authoring.semanticWallsById[segment.semanticWallId] = { geometry: { ...segment.geometry, startVertexId: segment.startVertexId, endVertexId: segment.endVertexId } };
  }
  const normalized = deriveBuildingV2FillMaskSource(authoring, { limits });
  if (normalized.fingerprint !== source.fingerprint || byteSize(source) > limits.maxSerializedBytes) fail('Building V2 Fill Mask Source is malformed or exceeds limits.', 'invalid-source');
  return normalized;
}

export function createBuildingV2FillMaskCacheKey(source, { sceneGridSize } = {}) {
  const checked = validateBuildingV2FillMaskSource(source);
  return checkedFillMaskCacheKey(checked, sceneGridSize);
}

function checkedFillMaskCacheKey(checked, sceneGridSize) {
  return `building-v2-fill-mask:${checked.version}:${checked.fingerprint}:grid-${positive(sceneGridSize, 'scene grid size')}`;
}

export function materializeBuildingV2FillMask(source, { sceneGridSize, limits = BUILDING_V2_FILL_MASK_LIMITS } = {}) {
  const checked = validateBuildingV2FillMaskSource(source, { limits });
  const grid = positive(sceneGridSize, 'scene grid size');
  return materializeCheckedFillMask(checked, grid, limits);
}

// The public entry validates the complete composite, including every child.
// Internal recursion and cache-key construction consume that same checked graph
// instead of repeatedly cloning, hashing and validating it at each level.
function materializeCheckedFillMask(checked, grid, limits) {
  if (checked.version === 2) {
    const result = { version: 2, sourceFingerprint: checked.fingerprint,
    cacheKey: checkedFillMaskCacheKey(checked, grid), sceneGridSize: grid,
    regions: checked.regions.map(({ maskSource, ...intent }) => ({ ...intent,
      materialization: materializeCheckedFillMask(maskSource, grid, limits) })) };
    const shapes = result.regions.flatMap((region) => region.materialization.shapes);
    if (shapes.length > limits.maxShapes || shapes.reduce((count, shape) => count + shape.vertices.length, 0) > limits.maxPoints
      || byteSize(result) > limits.maxSerializedBytes) fail('Building V2 composite Fill materialization exceeds limits.', 'limit-composite');
    return copyFreeze(result);
  }
  const shapes = [];
  let pointCount = 0;
  for (const loop of checked.loops) {
    const vertices = [];
    for (const segment of loop.segments) {
      const forward = segment.direction === 'forward';
      const start = checked.verticesById[forward ? segment.startVertexId : segment.endVertexId];
      const end = checked.verticesById[forward ? segment.endVertexId : segment.startVertexId];
      // Reversing a rational conic also reverses its endpoint weights. The
      // control point remains the same geometric point.
      const geometry = forward ? segment.geometry : segment.geometry.kind === 'line'
        ? segment.geometry
        : segment.geometry.kind === 'cubic' ? { kind: 'cubic', controls: segment.geometry.controls.toReversed() }
        : {
            ...segment.geometry,
            control: segment.geometry.control,
            conicState: { ...segment.geometry.conicState, weights: [...segment.geometry.conicState.weights].reverse() }
          };
      const points = tessellateBuildingV2WallGeometry(start, geometry, end, { purpose: 'artwork', sceneGridSize: grid });
      vertices.push(...points.slice(0, -1));
    }
    if (vertices.length < 3) fail(`Building V2 Fill Mask loop ${loop.loopId} materialized fewer than three points.`, 'degenerate-loop');
    pointCount += vertices.length;
    if (pointCount > limits.maxPoints) fail('Building V2 Fill Mask materialization exceeds point limit.', 'limit-points');
    shapes.push({ type: 'polygon', operation: loop.operation, vertices });
  }
  if (shapes.length > limits.maxShapes) fail('Building V2 Fill Mask materialization exceeds shape limit.', 'limit-shapes');
  const result = { version: BUILDING_V2_FILL_MASK_RUNTIME_VERSION, sourceFingerprint: checked.fingerprint, sceneGridSize: grid, cacheKey: checkedFillMaskCacheKey(checked, grid), shapes };
  if (byteSize(result) > limits.maxSerializedBytes) fail('Building V2 Fill Mask materialization exceeds serialized-byte limit.', 'limit-bytes');
  return copyFreeze(result);
}

export function createBuildingV2FillMaskCache({ maxEntries = 32 } = {}) {
  const capacity = Math.max(1, Math.min(256, Math.trunc(positive(maxEntries, 'cache maxEntries'))));
  const entries = new Map();
  return Object.freeze({
    materialize(source, settings) {
      const limits = settings?.limits || BUILDING_V2_FILL_MASK_LIMITS;
      const checked = validateBuildingV2FillMaskSource(source, { limits });
      const grid = positive(settings?.sceneGridSize, 'scene grid size');
      const key = `${checkedFillMaskCacheKey(checked, grid)}:limits-${JSON.stringify([
        limits.maxLoops, limits.maxSegments, limits.maxPoints, limits.maxShapes, limits.maxSerializedBytes
      ])}`;
      if (entries.has(key)) {
        const hit = entries.get(key);
        entries.delete(key); entries.set(key, hit);
        return hit;
      }
      const value = materializeCheckedFillMask(checked, grid, limits);
      entries.set(key, value);
      while (entries.size > capacity) entries.delete(entries.keys().next().value);
      return value;
    },
    clear() { entries.clear(); },
    get size() { return entries.size; }
  });
}

export const createBuildingV2FillMaskRuntime = createBuildingV2FillMaskCache;

/** Disposable extent of the same sampled masks used to draw the Fill. */
export function measureBuildingV2FillMaskRegions(materialization, { transform = null } = {}) {
  const regions = materialization?.version === 2
    ? materialization.regions.filter((region) => region.active)
    : materialization ? [{ regionId: null, materialization }] : [];
  return regions.map((region) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const shape of region.materialization.shapes) {
      if (shape.operation !== 'add') continue;
      for (const vertex of shape.vertices) {
        const point = transform ? transform.localToWorld(vertex) : vertex;
        minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
      }
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite))
      fail('Active Building V2 Fill requires a materialized exterior extent.', 'missing-fill-extent');
    return { regionId: region.regionId, renderEnvelope: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY } };
  });
}

/** Project Building-local materialized shapes into the managed Fill Tile frame. */
export function projectBuildingV2FillMaskToTile({
  materialization,
  building,
  rootSource,
  textureBasis = { origin: { x: 0, y: 0 } },
  appearance = null
} = {}) {
  if (materialization?.version === 2) {
    const regions = materialization.regions.map(({ materialization: mask, ...intent }) => ({ ...intent,
      maskedTiling: projectBuildingV2FillMaskToTile({ materialization: mask, building, rootSource, textureBasis, appearance: intent.appearance }) }));
    const first = regions.find((region) => region.active) || regions[0];
    return copyFreeze({ ...first?.maskedTiling, maskType: 'composite', maskVersion: 1,
      sourceFingerprint: materialization.sourceFingerprint, regions });
  }
  if (!materialization?.shapes || !Array.isArray(materialization.shapes)) fail('Building V2 Fill Tile projection requires a materialized Fill Mask.', 'missing-materialization');
  const frame = resolveBuildingV2PresentationFrame(building);
  const width = positive(rootSource?.width, 'Root width');
  const height = positive(rootSource?.height, 'Root height');
  const { scale } = deriveBuildingV2InstanceScale({ width, height, envelopeWidth: frame.width, envelopeHeight: frame.height });
  const x = finite(rootSource?.x, 'Root x');
  const y = finite(rootSource?.y, 'Root y');
  const rotation = finite(rootSource?.rotation ?? 0, 'Root rotation');
  const anchorX = finite(rootSource?.texture?.anchorX ?? rootSource?.anchorX ?? 0.5, 'Root anchorX');
  const anchorY = finite(rootSource?.texture?.anchorY ?? rootSource?.anchorY ?? 0.5, 'Root anchorY');
  const origin = point(textureBasis?.origin, 'texture basis origin');
  const fillAppearance = normalizeBuildingV2FillAppearance(appearance);
  const authoredScale = fillAppearance.scalePercent / 100;
  const authoredRotationRadians = fillAppearance.rotationDegrees * (Math.PI / 180);
  const cosine = Math.cos(authoredRotationRadians);
  const sine = Math.sin(authoredRotationRadians);
  const repeatScale = scale * authoredScale;
  const shapes = materialization.shapes.map((shape) => ({ ...shape, vertices: shape.vertices.map((vertex) => ({ x: (vertex.x - frame.minX) * scale, y: (vertex.y - frame.minY) * scale })) }));
  const localOrigin = { x: (origin.x - frame.minX) * scale, y: (origin.y - frame.minY) * scale };
  const localOffset = {
    x: fillAppearance.offset.x * scale,
    y: fillAppearance.offset.y * scale
  };
  const maskShapes = { version: BUILDING_V2_FILL_MASK_RUNTIME_VERSION, sourceFingerprint: materialization.sourceFingerprint, shapes };
  const result = {
    maskType: 'array', maskVersion: 3, maskShapes, maskShapeKey: fnv1a(maskShapes),
    maskOriginalSize: { width, height }, maskCrop: { x: 0, y: 0, width, height },
    // The generic renderer measures its tile delta from its unrotated
    // anchor-compatible top-left; matching that origin keeps the local Fill
    // basis stable while the Root moves or rotates.
    maskWorld: {
      origin: {
        x: cleanTransformNumber(x - (width * anchorX)),
        y: cleanTransformNumber(y - (height * anchorY))
      },
      scale: { x: scale, y: scale }, offset: { x: 0, y: 0 },
      tile: { x, y, width, height, rotation, anchorX, anchorY }
    },
    texturePhase: localOrigin, textureOffset: localOffset,
    buildingLocalTextureBasis: { version: 1, origin }, sourceFingerprint: materialization.sourceFingerprint,
    textureRepeatTransform: {
      version: 1,
      a: cleanTransformNumber(cosine * repeatScale),
      b: cleanTransformNumber(sine * repeatScale),
      c: cleanTransformNumber(-sine * repeatScale),
      d: cleanTransformNumber(cosine * repeatScale),
      sourceScale: cleanTransformNumber(authoredScale),
      sourceRotation: cleanTransformNumber(fillAppearance.rotationDegrees)
    }
  };
  return copyFreeze(result);
}

export const projectBuildingV2FillMaskToManagedTile = projectBuildingV2FillMaskToTile;
