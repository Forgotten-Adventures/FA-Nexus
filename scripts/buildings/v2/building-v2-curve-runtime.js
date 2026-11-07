import { evaluateBuildingV2Cubic } from './building-v2-spline-runtime.js';

/**
 * Public deterministic materialization for compact Building V2 conics and spline-derived cubics.
 *
 * Authoring owns the compact geometry and Boolean decisions. This module owns
 * only disposable, zoom-independent point/Wall-fragment projections which must
 * also be available when the premium editor is absent.
 */

const EPSILON = 1e-9;
const DEFAULT_NATIVE_MAX_SEGMENTS = 12;
// Long curves must not consume the budget before their final spans receive
// artwork-detail subdivision. Native restriction Walls retain their own cap.
const DEFAULT_ARTWORK_MAX_SEGMENTS = 1024;

function finitePoint(value, label) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`Building V2 ${label} requires a finite point.`);
  }
  return { x, y };
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function geometryWeights(geometry) {
  const stored = geometry?.conicState?.weights;
  if (Array.isArray(stored) && stored.length === 3) {
    const weights = stored.map(Number);
    if (weights.every((weight) => Number.isFinite(weight) && weight > 0)) return weights;
  }
  const middle = finitePositive(geometry?.conicState?.weight, 1);
  return [1, middle, 1];
}

function homogeneous(point, weight) {
  return { x: point.x * weight, y: point.y * weight, w: weight };
}

function lerpHomogeneous(left, right, t) {
  return {
    x: left.x + ((right.x - left.x) * t),
    y: left.y + ((right.y - left.y) * t),
    w: left.w + ((right.w - left.w) * t)
  };
}

function cartesian(point) {
  if (!(Math.abs(point.w) > EPSILON)) throw new Error('Building V2 conic materialization reached a zero homogeneous weight.');
  return { x: point.x / point.w, y: point.y / point.w };
}

function conicControlPolygon(startValue, geometry, endValue) {
  const start = finitePoint(startValue, 'conic start');
  const control = finitePoint(geometry?.control, 'conic control');
  const end = finitePoint(endValue, 'conic end');
  const weights = geometryWeights(geometry);
  return [homogeneous(start, weights[0]), homogeneous(control, weights[1]), homogeneous(end, weights[2])];
}

function evaluateHomogeneous(control, t) {
  const first = lerpHomogeneous(control[0], control[1], t);
  const second = lerpHomogeneous(control[1], control[2], t);
  return lerpHomogeneous(first, second, t);
}

export function evaluateBuildingV2Conic(start, geometry, end, t) {
  const parameter = Math.min(1, Math.max(0, Number(t)));
  if (!Number.isFinite(parameter)) throw new TypeError('Building V2 conic evaluation requires a finite parameter.');
  return cartesian(evaluateHomogeneous(conicControlPolygon(start, geometry, end), parameter));
}

function midpointDeviation(start, midpoint, end) {
  const chordMidpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  return Math.hypot(midpoint.x - chordMidpoint.x, midpoint.y - chordMidpoint.y);
}

/**
 * Adaptive subdivision is deterministic because it depends only on compact
 * geometry and explicit projection settings, never Canvas zoom or renderer FPS.
 */
export function tessellateBuildingV2Conic(startValue, geometry, endValue, {
  maxChordLength = Infinity,
  maxDeviation = 0.5,
  maxSegments = DEFAULT_ARTWORK_MAX_SEGMENTS,
  minSegments = 1
} = {}) {
  const start = finitePoint(startValue, 'conic start');
  const end = finitePoint(endValue, 'conic end');
  const chordLimit = finitePositive(maxChordLength, Infinity);
  const deviationLimit = finitePositive(maxDeviation, 0.5);
  const segmentLimit = Math.max(1, Math.min(1024, Math.trunc(finitePositive(maxSegments, DEFAULT_ARTWORK_MAX_SEGMENTS))));
  const minimum = Math.max(1, Math.min(segmentLimit, Math.trunc(finitePositive(minSegments, 1))));
  const points = [start];
  const stack = [{ t0: 0, t1: 1, a: start, b: end, depth: 0 }];
  while (stack.length) {
    const span = stack.pop();
    const tm = (span.t0 + span.t1) / 2;
    const evaluate = geometry.kind === 'cubic' ? evaluateBuildingV2Cubic : evaluateBuildingV2Conic;
    const midpoint = evaluate(start, geometry, end, tm);
    // Cubic inflections can put the midpoint exactly on the chord. Quarter
    // checks keep those spans from degenerating into a straight projection.
    const cubicDeviation = geometry.kind === 'cubic' ? Math.max(
      midpointDeviation(span.a, evaluate(start, geometry, end, (span.t0 + tm) / 2), midpoint),
      midpointDeviation(midpoint, evaluate(start, geometry, end, (tm + span.t1) / 2), span.b)
    ) : 0;
    const projectedSegments = points.length + stack.length;
    const mustMeetMinimum = span.depth < Math.ceil(Math.log2(minimum));
    const requiresSplit = mustMeetMinimum
      || Math.hypot(span.b.x - span.a.x, span.b.y - span.a.y) > chordLimit
      || Math.max(midpointDeviation(span.a, midpoint, span.b), cubicDeviation) > deviationLimit;
    if (requiresSplit && projectedSegments < segmentLimit && span.depth < 20) {
      stack.push({ t0: tm, t1: span.t1, a: midpoint, b: span.b, depth: span.depth + 1 });
      stack.push({ t0: span.t0, t1: tm, a: span.a, b: midpoint, depth: span.depth + 1 });
    } else {
      points.push(span.b);
    }
  }
  return points;
}

export function tessellateBuildingV2WallGeometry(start, geometry, end, {
  purpose = 'artwork',
  sceneGridSize = 100
} = {}) {
  const a = finitePoint(start, 'wall start');
  const b = finitePoint(end, 'wall end');
  if (geometry?.kind === 'line') return [a, b];
  if (!['conic', 'cubic'].includes(geometry?.kind)) throw new Error(`Building V2 cannot tessellate unsupported wall geometry ${geometry?.kind || '(missing)'}.`);
  const grid = finitePositive(sceneGridSize, 100);
  if (purpose === 'native-wall') {
    return tessellateBuildingV2Conic(a, geometry, b, {
      maxChordLength: grid * 0.9,
      maxDeviation: grid * 0.06,
      minSegments: 2,
      maxSegments: DEFAULT_NATIVE_MAX_SEGMENTS
    });
  }
  return tessellateBuildingV2Conic(a, geometry, b, {
    maxChordLength: grid * 0.18,
    maxDeviation: Math.max(0.25, grid * 0.006),
    minSegments: 4,
    maxSegments: DEFAULT_ARTWORK_MAX_SEGMENTS
  });
}

export function planBuildingV2NativeWallFragments({
  semanticWallId,
  componentId,
  start,
  geometry,
  end,
  sceneGridSize = 100,
  behavior = { preset: 'Solid' },
  provenance = null
} = {}) {
  const semanticId = String(semanticWallId || '').trim();
  if (!semanticId) throw new Error('Building V2 native Wall planning requires a semanticWallId.');
  const points = tessellateBuildingV2WallGeometry(start, geometry, end, { purpose: 'native-wall', sceneGridSize });
  const count = Math.max(1, points.length - 1);
  return points.slice(0, -1).map((point, fragmentOrdinal) => ({
    fragmentId: `${semanticId}:${fragmentOrdinal}`,
    semanticWallId: semanticId,
    fragmentOrdinal,
    componentId: componentId == null ? null : String(componentId),
    semanticRange: { start: fragmentOrdinal / count, end: (fragmentOrdinal + 1) / count },
    provenance: provenance ? { ...provenance } : null,
    a: point,
    b: points[fragmentOrdinal + 1],
    behavior: { ...behavior }
  }));
}

export const BUILDING_V2_CURVE_RUNTIME_VERSION = 1;
