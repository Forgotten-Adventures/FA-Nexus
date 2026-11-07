const ARC_SAMPLE_SPACING = 20;
const ARC_SAMPLE_MIN = 8;
const ARC_SAMPLE_MAX = 72;
const ARC_DUPLICATE_EPSILON = 0.5;
const ARC_CIRCULAR_ALIGNMENT_RATIO = 0.02;
const ARC_CIRCULAR_ALIGNMENT_MIN = 0.75;
const ARC_CIRCULAR_ANGLE_EPSILON = Math.PI / 90;
const ARC_CIRCULAR_DOT_RATIO = 0.001;
const ARC_CIRCULAR_CENTER_RATIO = 0.45;
const DEFAULT_ARC_SNAP_STEP = 200;
const TAU = Math.PI * 2;
const RIGHT_ANGLE = Math.PI / 2;

const clampValue = (value, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
};

export const pointsEqual = (a, b, epsilon = ARC_DUPLICATE_EPSILON) => {
  if (!a || !b) return false;
  return Math.abs((a.x ?? 0) - (b.x ?? 0)) <= epsilon
    && Math.abs((a.y ?? 0) - (b.y ?? 0)) <= epsilon;
};

const distanceBetween = (a, b) => {
  if (!a || !b) return 0;
  const dx = (b.x ?? 0) - (a.x ?? 0);
  const dy = (b.y ?? 0) - (a.y ?? 0);
  return Math.hypot(dx, dy);
};

const segmentSide = (a, b, point, epsilon = 1e-4) => {
  if (!a || !b || !point) return 0;
  const ax = a.x ?? 0;
  const ay = a.y ?? 0;
  const bx = b.x ?? 0;
  const by = b.y ?? 0;
  const px = point.x ?? 0;
  const py = point.y ?? 0;
  const cross = ((bx - ax) * (py - ay)) - ((by - ay) * (px - ax));
  if (Math.abs(cross) <= epsilon) return 0;
  return cross > 0 ? 1 : -1;
};

const sampleQuadraticBezier = (start, control, end, segments = ARC_SAMPLE_MIN) => {
  const count = clampValue(Math.trunc(segments), ARC_SAMPLE_MIN, ARC_SAMPLE_MAX);
  const points = [];
  if (!start || !control || !end) return points;
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const mt = 1 - t;
    const x = (mt * mt * (start.x ?? 0))
      + (2 * mt * t * (control.x ?? 0))
      + (t * t * (end.x ?? 0));
    const y = (mt * mt * (start.y ?? 0))
      + (2 * mt * t * (control.y ?? 0))
      + (t * t * (end.y ?? 0));
    points.push({ x, y });
  }
  return points;
};

const dedupeSequentialPoints = (points = [], epsilon = ARC_DUPLICATE_EPSILON) => {
  if (!Array.isArray(points) || points.length <= 1) return points;
  const result = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = result[result.length - 1];
    const current = points[i];
    if (!pointsEqual(prev, current, epsilon)) result.push(current);
  }
  return result;
};

export const resolveArcSnapStep = ({
  snapStep = null,
  gridSize = null,
  subdivision = null,
  divisors = null,
  defaultStep = DEFAULT_ARC_SNAP_STEP
} = {}) => {
  const directStep = Number(snapStep);
  if (Number.isFinite(directStep) && directStep > 0) return directStep;

  const grid = Number(gridSize);
  if (Number.isFinite(grid) && grid > 0) {
    const gridDivisors = Array.isArray(divisors) && divisors.length ? divisors : null;
    if (gridDivisors) {
      const index = clampValue(Math.round(Number(subdivision) || 0), 0, gridDivisors.length - 1);
      const divisor = Number(gridDivisors[index]) || 1;
      return grid / Math.max(1, divisor);
    }
    return grid;
  }

  const fallback = Number(defaultStep);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_ARC_SNAP_STEP;
};

const getArcSampleCount = (distance) => {
  const spacing = Math.max(6, ARC_SAMPLE_SPACING);
  const estimate = Math.max(ARC_SAMPLE_MIN, Math.ceil(distance / spacing) * 2);
  return clampValue(estimate, ARC_SAMPLE_MIN, ARC_SAMPLE_MAX);
};

const isQuarterAxisAligned = (vec, tolerance) => {
  if (!vec) return false;
  const alignedX = Math.abs(vec.x ?? 0) <= tolerance;
  const alignedY = Math.abs(vec.y ?? 0) <= tolerance;
  if (alignedX && alignedY) return false;
  return alignedX || alignedY;
};

const resolveQuarterCircleCenters = (startPoint, endPoint, controlPoint, options = {}) => {
  if (!startPoint || !endPoint || !controlPoint) return [];
  if (Math.abs((endPoint.x ?? 0) - (startPoint.x ?? 0)) <= ARC_DUPLICATE_EPSILON) return [];
  if (Math.abs((endPoint.y ?? 0) - (startPoint.y ?? 0)) <= ARC_DUPLICATE_EPSILON) return [];
  const snapStep = Math.abs(resolveArcSnapStep(options)) || DEFAULT_ARC_SNAP_STEP;
  const centerTolerance = Math.max(ARC_CIRCULAR_ALIGNMENT_MIN, snapStep * ARC_CIRCULAR_CENTER_RATIO);
  const candidates = [
    { x: startPoint.x, y: endPoint.y },
    { x: endPoint.x, y: startPoint.y }
  ];
  const unique = [];
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) continue;
    const exists = unique.some((existing) => Math.abs(existing.x - candidate.x) <= ARC_DUPLICATE_EPSILON
      && Math.abs(existing.y - candidate.y) <= ARC_DUPLICATE_EPSILON);
    if (!exists) unique.push(candidate);
  }
  const centers = [];
  let hasPreferred = false;
  unique.forEach((center) => {
    const distance = distanceBetween(center, controlPoint);
    const preferred = Number.isFinite(distance) && distance <= centerTolerance;
    const weight = preferred ? distance : distance + centerTolerance;
    centers.push({ center, weight, preferred });
    if (preferred) hasPreferred = true;
  });
  if (!hasPreferred) return [];
  centers.sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0));
  return centers;
};

const resolveArcOrientationFromControl = (startPoint, endPoint, controlPoint, prevPoint) => {
  const chord = {
    x: (endPoint?.x ?? 0) - (startPoint?.x ?? 0),
    y: (endPoint?.y ?? 0) - (startPoint?.y ?? 0)
  };
  const controlVec = controlPoint ? {
    x: (controlPoint.x ?? 0) - (startPoint?.x ?? 0),
    y: (controlPoint.y ?? 0) - (startPoint?.y ?? 0)
  } : chord;
  let cross = (controlVec.x * chord.y) - (controlVec.y * chord.x);
  if (Math.abs(cross) <= 1e-6 && prevPoint) {
    const prevVec = {
      x: (startPoint?.x ?? 0) - (prevPoint?.x ?? 0),
      y: (startPoint?.y ?? 0) - (prevPoint?.y ?? 0)
    };
    cross = (prevVec.x * chord.y) - (prevVec.y * chord.x);
  }
  if (Math.abs(cross) <= 1e-6) {
    return chord.y >= 0 ? 1 : -1;
  }
  return cross >= 0 ? 1 : -1;
};

const buildCircularArcFromCenter = (startPoint, endPoint, center, options = {}) => {
  if (!startPoint || !endPoint || !center) return null;
  const snapStep = Math.abs(resolveArcSnapStep(options)) || DEFAULT_ARC_SNAP_STEP;
  const axisTolerance = Math.max(ARC_CIRCULAR_ALIGNMENT_MIN, snapStep * ARC_CIRCULAR_ALIGNMENT_RATIO);
  const startVec = {
    x: (startPoint.x ?? 0) - (center.x ?? 0),
    y: (startPoint.y ?? 0) - (center.y ?? 0)
  };
  const endVec = {
    x: (endPoint.x ?? 0) - (center.x ?? 0),
    y: (endPoint.y ?? 0) - (center.y ?? 0)
  };
  if (!isQuarterAxisAligned(startVec, axisTolerance)) return null;
  if (!isQuarterAxisAligned(endVec, axisTolerance)) return null;

  const startRadius = Math.hypot(startVec.x, startVec.y);
  const endRadius = Math.hypot(endVec.x, endVec.y);
  if (!Number.isFinite(startRadius) || !Number.isFinite(endRadius)) return null;
  if (startRadius <= axisTolerance || endRadius <= axisTolerance) return null;
  if (Math.abs(startRadius - endRadius) > axisTolerance) return null;
  const radius = (startRadius + endRadius) / 2;

  const dot = (startVec.x * endVec.x) + (startVec.y * endVec.y);
  const dotTolerance = Math.max(1, radius * radius * ARC_CIRCULAR_DOT_RATIO);
  if (Math.abs(dot) > dotTolerance) return null;
  const cross = (startVec.x * endVec.y) - (startVec.y * endVec.x);
  if (Math.abs(cross) <= dotTolerance) return null;
  const orientation = cross >= 0 ? 1 : -1;

  let startAngle = Math.atan2(startVec.y, startVec.x);
  let endAngle = Math.atan2(endVec.y, endVec.x);
  let delta = endAngle - startAngle;
  if (orientation > 0 && delta < 0) delta += TAU;
  if (orientation < 0 && delta > 0) delta -= TAU;
  const angleDelta = Math.abs(delta);
  const angleTolerance = Math.max(ARC_CIRCULAR_ANGLE_EPSILON, angleDelta * 0.05);
  if (Math.abs(angleDelta - RIGHT_ANGLE) > angleTolerance) return null;

  const segments = clampValue(Math.trunc(options?.segments ?? ARC_SAMPLE_MIN), ARC_SAMPLE_MIN, ARC_SAMPLE_MAX);
  const step = delta / segments;
  const points = [];
  for (let i = 0; i <= segments; i += 1) {
    const theta = startAngle + (step * i);
    points.push({
      x: Number(((center.x ?? 0) + (Math.cos(theta) * radius)).toFixed(3)),
      y: Number(((center.y ?? 0) + (Math.sin(theta) * radius)).toFixed(3))
    });
  }
  const samples = dedupeSequentialPoints(points);
  if (!samples.length) return null;
  samples[0] = { x: startPoint.x, y: startPoint.y };
  samples[samples.length - 1] = { x: endPoint.x, y: endPoint.y };
  return { points: samples, mode: 'circular', orientation };
};

const buildCircularArcPoints = (startPoint, endPoint, controlPoint, options = {}) => {
  if (!startPoint || !endPoint || !controlPoint) return null;
  const centers = resolveQuarterCircleCenters(startPoint, endPoint, controlPoint, options);
  if (!centers.length) return null;
  const desiredSide = segmentSide(startPoint, endPoint, options.sourceControlPoint || controlPoint);
  let fallback = null;
  for (const candidate of centers) {
    const arc = buildCircularArcFromCenter(startPoint, endPoint, candidate.center, options);
    if (!arc) continue;
    const midSample = arc.points[Math.floor(arc.points.length / 2)] || arc.points[0];
    const arcSide = segmentSide(startPoint, endPoint, midSample);
    if (desiredSide && arcSide && desiredSide === arcSide) {
      return arc;
    }
    if (!fallback || candidate.weight < fallback.weight) {
      fallback = { arc, weight: candidate.weight };
    }
  }
  return fallback?.arc ?? null;
};

const buildEllipticalArcPoints = (startPoint, endPoint, controlPoint, options = {}) => {
  if (!startPoint || !endPoint || !controlPoint) return null;

  const cx = controlPoint.x;
  const cy = controlPoint.y;
  const u = { x: startPoint.x - cx, y: startPoint.y - cy };
  const v = { x: endPoint.x - cx, y: endPoint.y - cy };

  const dot = (u.x * v.x) + (u.y * v.y);
  const magU = Math.hypot(u.x, u.y);
  const magV = Math.hypot(v.x, v.y);
  if (magU < 1 || magV < 1) return null;

  const cosTheta = dot / (magU * magV);
  if (Math.abs(cosTheta) > 0.02) return null;

  const center = {
    x: startPoint.x + v.x,
    y: startPoint.y + v.y
  };

  const segments = clampValue(Math.trunc(options?.segments ?? ARC_SAMPLE_MIN), ARC_SAMPLE_MIN, ARC_SAMPLE_MAX);
  const points = [];
  const axis1 = { x: startPoint.x - center.x, y: startPoint.y - center.y };
  const axis2 = { x: endPoint.x - center.x, y: endPoint.y - center.y };

  for (let i = 0; i <= segments; i += 1) {
    const t = (i / segments) * (Math.PI / 2);
    const ct = Math.cos(t);
    const st = Math.sin(t);
    points.push({
      x: center.x + axis1.x * ct + axis2.x * st,
      y: center.y + axis1.y * ct + axis2.y * st
    });
  }

  const samples = dedupeSequentialPoints(points);
  if (!samples.length) return null;
  samples[0] = { x: startPoint.x, y: startPoint.y };
  samples[samples.length - 1] = { x: endPoint.x, y: endPoint.y };

  const orientation = resolveArcOrientationFromControl(startPoint, endPoint, controlPoint, options.prevPoint);
  return { points: samples, mode: 'manual', orientation };
};

export const buildArcSamplePoints = (startPoint, endPoint, options = {}) => {
  if (!startPoint || !endPoint) return { points: [], mode: 'line', orientation: 0 };
  const distance = distanceBetween(startPoint, endPoint);
  if (distance <= ARC_DUPLICATE_EPSILON) {
    return {
      points: [
        { x: startPoint.x, y: startPoint.y },
        { x: endPoint.x, y: endPoint.y }
      ],
      mode: 'line',
      orientation: 0
    };
  }
  const segmentCount = getArcSampleCount(distance);
  if (options.controlPoint) {
    const circular = buildCircularArcPoints(startPoint, endPoint, options.controlPoint, {
      ...options,
      prevPoint: options.prevPoint,
      segments: segmentCount,
      sourceControlPoint: options.controlPoint
    });
    if (circular) return circular;

    const elliptical = buildEllipticalArcPoints(startPoint, endPoint, options.controlPoint, {
      ...options,
      prevPoint: options.prevPoint,
      segments: segmentCount
    });
    if (elliptical) return elliptical;

    const bezierPoints = dedupeSequentialPoints(sampleQuadraticBezier(
      startPoint,
      options.controlPoint,
      endPoint,
      segmentCount
    ));
    if (bezierPoints.length) {
      bezierPoints[0] = { x: startPoint.x, y: startPoint.y };
      bezierPoints[bezierPoints.length - 1] = { x: endPoint.x, y: endPoint.y };
    }
    if (!bezierPoints.length) {
      bezierPoints.push({ x: startPoint.x, y: startPoint.y });
      bezierPoints.push({ x: endPoint.x, y: endPoint.y });
    }
    const orientation = resolveArcOrientationFromControl(startPoint, endPoint, options.controlPoint, options.prevPoint);
    return { points: bezierPoints, mode: 'manual', orientation };
  }
  return {
    points: [
      { x: startPoint.x, y: startPoint.y },
      { x: endPoint.x, y: endPoint.y }
    ],
    mode: 'line',
    orientation: 0
  };
};
