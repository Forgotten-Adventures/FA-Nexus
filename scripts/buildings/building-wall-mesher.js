import { NexusLogger as Logger } from '../core/nexus-logger.js';

const EPSILON = 1e-6;

const DEFAULT_SEGMENT_SUBDIVISION = 40;
const CORNER_DOT_THRESHOLD = Math.cos(Math.PI / 12); // ~15°

const DEFAULT_OPTIONS = Object.freeze({
  width: 1,
  closed: false,
  joinStyle: 'mitre',
  mitreLimit: 4,
  textureRepeatDistance: 1,
  maxSegmentLength: DEFAULT_SEGMENT_SUBDIVISION,
  pivot: 'center', // center | left | right (future-proof)
  startJoinDir: null,
  endJoinDir: null
});

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(a, s) {
  return { x: a.x * s, y: a.y * s };
}

function length(a) {
  return Math.hypot(a.x, a.y);
}

function normalize(a) {
  const len = length(a);
  if (len < EPSILON) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}

function normalizeDirection(value) {
  if (!value || typeof value !== 'object') return null;
  const dir = normalize({
    x: Number(value.x) || 0,
    y: Number(value.y) || 0
  });
  if (Math.abs(dir.x) < EPSILON && Math.abs(dir.y) < EPSILON) return null;
  return dir;
}

function rotate90(a) {
  return { x: -a.y, y: a.x };
}

function dot(a, b) {
  return (a.x * b.x) + (a.y * b.y);
}

function cross(a, b) {
  return (a.x * b.y) - (a.y * b.x);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function copyPoint(point) {
  return { x: Number(point.x) || 0, y: Number(point.y) || 0 };
}

function resolveDirection(from, to) {
  const dir = sub(to, from);
  return normalize(dir);
}

function computeSignedArea(points = []) {
  let area = 0;
  const count = points.length;
  if (count < 3) return 0;
  for (let i = 0; i < count; i++) {
    const curr = points[i];
    const next = points[(i + 1) % count];
    area += (curr.x * next.y) - (next.x * curr.y);
  }
  return area / 2;
}

function normalizePolyline(points = [], closed = false) {
  const normalized = [];
  for (const point of points) {
    if (!point) continue;
    const candidate = copyPoint(point);
    if (normalized.length) {
      const last = normalized[normalized.length - 1];
      if (Math.hypot(candidate.x - last.x, candidate.y - last.y) < EPSILON) continue;
    }
    normalized.push(candidate);
  }
  if (closed && normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < EPSILON) {
      normalized.pop();
    }
  }
  return normalized;
}

function cloneSample(sample, overrides = {}) {
  if (!sample) return { x: 0, y: 0, tangent: { x: 1, y: 0 }, distance: 0 };
  const tangent = sample.tangent ? { x: sample.tangent.x, y: sample.tangent.y } : null;
  return {
    x: sample.x,
    y: sample.y,
    distance: sample.distance,
    tangent,
    isCorner: !!sample.isCorner,
    vertexIndex: sample.vertexIndex,
    ...overrides
  };
}

function blend(a, b, factor) {
  return {
    x: (a.x * (1 - factor)) + (b.x * factor),
    y: (a.y * (1 - factor)) + (b.y * factor)
  };
}

function computeJoinOffset(prevDir, nextDir, offset, joinStyle, mitreLimit) {
  const hasPrev = !!prevDir;
  const hasNext = !!nextDir;

  if (!hasPrev && !hasNext) return { x: 0, y: 0 };
  if (!hasPrev) {
    const normal = rotate90(nextDir);
    return scale(normal, offset);
  }
  if (!hasNext) {
    const normal = rotate90(prevDir);
    return scale(normal, offset);
  }

  const normalPrev = rotate90(prevDir);
  const normalNext = rotate90(nextDir);
  const turn = cross(prevDir, nextDir);
  const dotValue = clamp(dot(prevDir, nextDir), -1, 1);

  // Nearly colinear → use simple offset
  if (Math.abs(turn) < EPSILON || Math.abs(1 - dotValue) < EPSILON) {
    return scale(normalNext, offset);
  }

  // 180 degree turn (opposite directions) - use bevel
  if (dotValue < -0.99) {
    return scale(normalNext, offset);
  }

  // Compute miter bisector by averaging the two normals
  const bisectorX = normalPrev.x + normalNext.x;
  const bisectorY = normalPrev.y + normalNext.y;
  const bisectorLen = Math.hypot(bisectorX, bisectorY);
  
  if (bisectorLen < EPSILON) {
    return scale(normalNext, offset);
  }

  // Normalize bisector
  const bisector = { x: bisectorX / bisectorLen, y: bisectorY / bisectorLen };
  
  // Calculate miter length using projection
  const projectionOntoNext = dot(bisector, normalNext);
  
  if (Math.abs(projectionOntoNext) < EPSILON) {
    return scale(normalNext, offset);
  }
  
  const miterLength = offset / projectionOntoNext;
  
  // Use a simple, conservative limit for ALL corners
  // This prevents texture distortion while still closing gaps
  const limit = Math.max(1.5, mitreLimit);
  const maxMiter = Math.abs(offset) * limit;
  const clampedLength = Math.min(Math.abs(miterLength), maxMiter);
  
  return scale(bisector, clampedLength * Math.sign(miterLength));
}

function computeCenterCornerOffset(prevDir, nextDir, offset) {
  if (!Number.isFinite(offset) || Math.abs(offset) < EPSILON) return null;
  if (!prevDir && !nextDir) return null;
  if (!prevDir) prevDir = nextDir;
  if (!nextDir) nextDir = prevDir;

  const normalPrev = rotate90(prevDir);
  const normalNext = rotate90(nextDir);
  const startPoint = scale(normalPrev, offset);
  const endPoint = scale(normalNext, offset);
  const denom = cross(prevDir, nextDir);

  if (Math.abs(denom) < EPSILON) {
    // Nearly colinear – translate along either normal
    return scale(normalNext, offset);
  }

  const diff = sub(endPoint, startPoint);
  const t = cross(diff, nextDir) / denom;
  const intersection = add(startPoint, scale(prevDir, t));
  if (!Number.isFinite(intersection.x) || !Number.isFinite(intersection.y)) {
    return scale(normalNext, offset);
  }
  return intersection;
}

function computeVertexNormal(points, index, closed) {
  if (!Array.isArray(points) || !points.length) return { x: 0, y: 1 };
  const count = points.length;
  const current = points[index];
  const prev = index === 0 ? (closed ? points[count - 1] : null) : points[index - 1];
  const next = index === count - 1 ? (closed ? points[0] : null) : points[index + 1];
  let dir = null;
  if (prev && next) {
    const prevDir = resolveDirection(prev, current);
    const nextDir = resolveDirection(current, next);
    dir = normalize(add(prevDir, nextDir));
  } else if (next) dir = resolveDirection(current, next);
  else if (prev) dir = resolveDirection(prev, current);
  if (!dir || (Math.abs(dir.x) < EPSILON && Math.abs(dir.y) < EPSILON)) {
    dir = { x: 0, y: 1 };
  }
  let normal = rotate90(dir);
  const len = Math.hypot(normal.x, normal.y) || 1;
  normal = { x: normal.x / len, y: normal.y / len };
  return normal;
}

function resolveJoinVectors(points, options, centerOffset = 0) {
  const { width, closed, joinStyle, mitreLimit } = options;
  const halfWidth = Math.max(EPSILON, width / 2);
  const count = points.length;
  const leftOffsets = new Array(count);
  const rightOffsets = new Array(count);
  const hasCenterOffset = Math.abs(centerOffset) > EPSILON;
  const centerOffsets = hasCenterOffset ? new Array(count) : null;
  const startJoinDir = !closed ? normalizeDirection(options?.startJoinDir) : null;
  const endJoinDir = !closed ? normalizeDirection(options?.endJoinDir) : null;

  for (let i = 0; i < count; i++) {
    const curr = points[i];
    const prev = i === 0 ? (closed ? points[count - 1] : null) : points[i - 1];
    const next = i === count - 1 ? (closed ? points[0] : null) : points[i + 1];

    let prevDir = null;
    let nextDir = null;

    if (prev) {
      const vec = resolveDirection(prev, curr);
      if (vec.x || vec.y) prevDir = vec;
    }

    if (next) {
      const vec = resolveDirection(curr, next);
      if (vec.x || vec.y) nextDir = vec;
    }

    if (!prevDir && i === 0 && startJoinDir) prevDir = startJoinDir;
    if (!nextDir && i === count - 1 && endJoinDir) nextDir = endJoinDir;
    if (!prevDir && nextDir) prevDir = nextDir;
    if (!nextDir && prevDir) nextDir = prevDir;

    if (!prevDir && !nextDir) {
      leftOffsets[i] = { x: -halfWidth, y: 0 };
      rightOffsets[i] = { x: halfWidth, y: 0 };
      continue;
    }

    // Use a simpler, more consistent join style
    const effectiveJoinStyle = joinStyle;
    const effectiveMitreLimit = mitreLimit;

    const leftOffset = computeJoinOffset(prevDir, nextDir, halfWidth, effectiveJoinStyle, effectiveMitreLimit);
    const rightOffset = computeJoinOffset(prevDir, nextDir, -halfWidth, effectiveJoinStyle, effectiveMitreLimit);
    const centerShift = hasCenterOffset
      ? computeCenterCornerOffset(prevDir, nextDir, centerOffset)
      : null;

    leftOffsets[i] = leftOffset;
    rightOffsets[i] = rightOffset;
    if (centerOffsets) centerOffsets[i] = centerShift;
  }

  return { leftOffsets, rightOffsets, centerOffsets };
}

export function offsetPolygonPoints(points = [], offset = 0, options = {}) {
  const closed = options.closed ?? true;
  const normalized = normalizePolyline(points, closed);
  if (!normalized.length) return [];
  const offsetValue = Number(offset) || 0;
  if (Math.abs(offsetValue) < EPSILON) return normalized.map(copyPoint);
  const joinOptions = {
    width: Math.max(EPSILON, Number(options.width) || 1),
    closed,
    joinStyle: options.joinStyle || 'mitre',
    mitreLimit: Number.isFinite(options.mitreLimit) ? options.mitreLimit : 4
  };
  const { centerOffsets } = resolveJoinVectors(normalized, joinOptions, offsetValue);
  const result = new Array(normalized.length);
  for (let i = 0; i < normalized.length; i++) {
    const point = normalized[i];
    let shift = centerOffsets ? centerOffsets[i] : null;
    if (!shift) {
      const normal = computeVertexNormal(normalized, i, closed);
      shift = scale(normal, offsetValue);
    }
    result[i] = add(point, shift);
  }
  return result;
}

function buildVertexDataFromSamples(samples, offsets, options, totalLength = 0) {
  const {
    closed,
    textureRepeatDistance,
    width,
    textureOffset = {},
    textureFlip = {}
  } = options || {};
  const repeat = textureRepeatDistance || 1;
  const originalCount = samples.length;
  if (originalCount < 2) return null;

  const workingSamples = closed
    ? [...samples, cloneSample(samples[0], { distance: totalLength })]
    : samples.slice();
  const count = workingSamples.length;

  const halfWidth = Math.max(EPSILON, (width || 1) / 2);
  const positions = [];
  const uvs = [];
  const alphas = [];
  const indices = [];
  const distances = [];
  const originalPoints = offsets?.originalPoints || [];
  const hasJoinOffsets = offsets && offsets.leftOffsets && offsets.rightOffsets && originalPoints.length > 0;
  const offsetX = Number(textureOffset?.x) || 0;
  const offsetY = Number(textureOffset?.y) || 0;
  const flipH = !!textureFlip?.horizontal;
  const flipV = !!textureFlip?.vertical;
  const centerOffsets = offsets?.centerOffsets;

  for (let i = 0; i < count; i++) {
    const sample = workingSamples[i];
    const point = { x: sample.x, y: sample.y };
    let tangent = sample.tangent || { x: 1, y: 0 };

    if ((!sample.tangent || (!sample.tangent.x && !sample.tangent.y)) && count > 1) {
      if (i < count - 1) {
        const nextSample = workingSamples[i + 1];
        const dx = nextSample.x - sample.x;
        const dy = nextSample.y - sample.y;
        const len = Math.hypot(dx, dy);
        if (len > EPSILON) {
          tangent = { x: dx / len, y: dy / len };
        }
      } else if (i > 0) {
        const prevSample = workingSamples[i - 1];
        const dx = sample.x - prevSample.x;
        const dy = sample.y - prevSample.y;
        const len = Math.hypot(dx, dy);
        if (len > EPSILON) {
          tangent = { x: dx / len, y: dy / len };
        }
      }
    }

    if (Math.abs(tangent.x) < EPSILON && Math.abs(tangent.y) < EPSILON) {
      tangent = { x: 1, y: 0 };
    }

    let leftOffset;
    let rightOffset;

    // Use precomputed join offsets at corner vertices
    if (sample.isCorner && sample.vertexIndex !== null && sample.vertexIndex !== undefined && hasJoinOffsets) {
      const idx = sample.vertexIndex;
      if (idx >= 0 && idx < offsets.leftOffsets.length) {
        leftOffset = offsets.leftOffsets[idx];
        rightOffset = offsets.rightOffsets[idx];
      }
    }

    // Fall back to perpendicular offsets for non-corner samples
    let normal = rotate90(tangent);
    const normalLen = Math.hypot(normal.x, normal.y) || 1;
    normal = { x: normal.x / normalLen, y: normal.y / normalLen };

    if (!leftOffset || !rightOffset) {
      leftOffset = scale(normal, halfWidth);
      rightOffset = scale(normal, -halfWidth);
    }

    let offsetShift = null;
    if (sample.isCorner && sample.vertexIndex !== null && sample.vertexIndex !== undefined && centerOffsets) {
      const idx = sample.vertexIndex;
      if (idx >= 0 && idx < centerOffsets.length) {
        offsetShift = centerOffsets[idx];
      }
    }
    if (!offsetShift) {
      offsetShift = scale(normal, offsetY);
    }

    const leftVertex = add(add(point, leftOffset), offsetShift);
    const rightVertex = add(add(point, rightOffset), offsetShift);

    const distance = sample.distance ?? (i > 0 ? (workingSamples[i - 1].distance ?? 0) : 0);
    const mappedDistance = (flipH ? -distance : distance) + (offsetX || 0);
    const u = repeat ? mappedDistance / repeat : mappedDistance;
    const vTop = flipV ? 1 : 0;
    const vBottom = flipV ? 0 : 1;

    positions.push(leftVertex.x, leftVertex.y, rightVertex.x, rightVertex.y);
    uvs.push(u, vTop, u, vBottom);
    alphas.push(1, 1);
    distances.push(distance);
  }

  for (let i = 0; i < count - 1; i++) {
    const base = i * 2;
    indices.push(base, base + 1, base + 2);
    indices.push(base + 1, base + 3, base + 2);
  }

  return { positions, uvs, alphas, indices, distances };
}

function toPIXIGeometry(data) {
  if (!data) return null;
  const { positions, uvs, alphas, indices } = data;
  if (typeof PIXI === 'undefined' || !PIXI?.Geometry) return null;
  try {
    const geometry = new PIXI.Geometry();
    geometry.addAttribute('aVertexPosition', positions, 2);
    geometry.addAttribute('aTextureCoord', uvs, 2);
    if (alphas && Array.isArray(alphas) && alphas.length > 0) {
      geometry.addAttribute('aAlpha', alphas, 1);
    }
    geometry.addIndex(indices);
    return geometry;
  } catch (error) {
    Logger?.error?.('Failed to construct PIXI.Geometry for building wall', error);
    return null;
  }
}

function shouldTreatCornerVertex(prevDir, nextDir, { isEndpoint = false } = {}) {
  if (isEndpoint) return true;
  if (!prevDir || !nextDir) return true;
  const dotValue = clamp(dot(prevDir, nextDir), -1, 1);
  return dotValue <= CORNER_DOT_THRESHOLD;
}

function samplePolygonPerimeter(points, closed, maxSampleDistance = 10, cornerSampleRadius = 5, options = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return { samples: [], totalDistance: 0 };
  }
  const samples = [];
  const count = points.length;
  const segmentCount = closed ? count : Math.max(0, count - 1);
  let totalDistance = 0;
  const cornerRadius = Math.max(2, cornerSampleRadius);
  const rightAngleThreshold = 0.1;
  const sharpCornerThreshold = Math.cos(Math.PI * 0.75);
  const verySharpThreshold = Math.cos(Math.PI * 0.85);
  const startJoinDir = !closed ? normalizeDirection(options?.startJoinDir) : null;
  const endJoinDir = !closed ? normalizeDirection(options?.endJoinDir) : null;

  for (let i = 0; i < segmentCount; i++) {
    const p1 = points[i];
    const p2 = closed ? points[(i + 1) % count] : points[i + 1];
    if (!p1 || !p2) continue;

    const prevIdx = i === 0 ? (closed ? count - 1 : -1) : i - 1;
    const afterNextIdx = i + 2;
    const p0 = prevIdx >= 0 ? points[prevIdx] : null;
    const p3 = closed ? points[afterNextIdx % count] : (afterNextIdx < count ? points[afterNextIdx] : null);

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const segmentLength = Math.hypot(dx, dy);

    if (segmentLength < EPSILON) {
      if (samples.length === 0 || (samples[samples.length - 1].x !== p1.x || samples[samples.length - 1].y !== p1.y)) {
        samples.push({ x: p1.x, y: p1.y, distance: totalDistance, tangent: { x: 1, y: 0 }, isCorner: true, vertexIndex: i });
      }
      continue;
    }

    const segmentTangent = { x: dx / segmentLength, y: dy / segmentLength };

    let prevDir = null;
    let nextSegmentDir = null;
    let isRightAngle = false;
    let isSharpCorner = false;
    let isVerySharpCorner = false;

    if (p0) {
      const prevVec = resolveDirection(p0, p1);
      if (prevVec.x || prevVec.y) prevDir = prevVec;
    } else if (!closed && i === 0 && startJoinDir) {
      prevDir = startJoinDir;
    }

    if (p3) {
      const nextVec = resolveDirection(p2, p3);
      if (nextVec.x || nextVec.y) nextSegmentDir = nextVec;
    } else if (!closed && i === segmentCount - 1 && endJoinDir) {
      nextSegmentDir = endJoinDir;
    }

    const treatCurrentVertexAsCorner = shouldTreatCornerVertex(prevDir, segmentTangent, {
      isEndpoint: !closed && (i === 0)
    });

    let nextVertexCornerHint = null;
    if (closed || i < segmentCount - 1) {
      nextVertexCornerHint = shouldTreatCornerVertex(segmentTangent, nextSegmentDir, {
        isEndpoint: !closed && (i === count - 2)
      });
    }

    if (prevDir && segmentTangent) {
      const dotValue = dot(prevDir, segmentTangent);
      isRightAngle = Math.abs(dotValue) < rightAngleThreshold;
      isSharpCorner = dotValue < sharpCornerThreshold;
      isVerySharpCorner = dotValue < verySharpThreshold;
    }

    // Simplified sampling - don't oversample at corners
    // The join offsets will handle the corner geometry properly
    let baseSampleDistance = maxSampleDistance;
    
    // Only increase sampling for very long segments or curves
    const isCurvedSegment = segmentLength > 0 && prevDir && segmentTangent && Math.abs(dot(prevDir, segmentTangent)) < 0.9;
    if (isCurvedSegment) {
      baseSampleDistance = Math.max(2, maxSampleDistance / 3);
    }

    const numSamples = Math.max(2, Math.ceil(segmentLength / baseSampleDistance));

    for (let j = 0; j < numSamples; j++) {
      const t = j / (numSamples - 1);
      const x = p1.x + (dx * t);
      const y = p1.y + (dy * t);

      let tangent = segmentTangent;
      let isCornerSample = false;
      let vertexIndex = null;

      // Mark corner vertices to use precomputed join offsets
      if (j === 0) {
        if (treatCurrentVertexAsCorner) {
          isCornerSample = true;
          vertexIndex = i;
        }
      } else if (j === numSamples - 1 && (closed ? i === count - 1 : i === segmentCount - 1)) {
        if (nextVertexCornerHint ?? true) {
          isCornerSample = true;
          vertexIndex = closed && i === count - 1 ? 0 : Math.min(count - 1, i + 1);
        }
      }

      if (samples.length > 0) {
        const prevSample = samples[samples.length - 1];
        const dist = Math.hypot(x - prevSample.x, y - prevSample.y);
        totalDistance += dist;
      }

      samples.push({ x, y, distance: totalDistance, tangent, isCorner: isCornerSample, vertexIndex });
    }
  }

  if (!closed && samples.length === 1) {
    samples[0].distance = 0;
  }

  if (closed && samples.length > 1) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < EPSILON) {
      samples.pop();
    }
  }

  return { samples, totalDistance };
}

export class BuildingWallMesher {
  static buildCenterline(centerlinePoints, opts = {}) {
    const points = Array.isArray(centerlinePoints) ? centerlinePoints.map(copyPoint) : [];
    if (points.length < 2) {
      return {
        positions: [],
        uvs: [],
        indices: [],
        distances: [],
        totalLength: 0,
        samples: [],
        options: { ...DEFAULT_OPTIONS, ...opts }
      };
    }

    const options = { ...DEFAULT_OPTIONS, ...opts };
    const closed = !!options.closed;
    if (!closed) options.closed = false;

    const normalizedPoints = normalizePolyline(points, closed);
    if (normalizedPoints.length < 2) {
      return {
        positions: [],
        uvs: [],
        indices: [],
        distances: [],
        totalLength: 0,
        samples: [],
        options
      };
    }

    const explicitCenterOffset = Number(options?.centerOffset);
    const centerOffsetValue = Number.isFinite(explicitCenterOffset)
      ? explicitCenterOffset
      : (Number(options?.textureOffset?.y) || 0);
    const hasCenterOffset = Math.abs(centerOffsetValue) > EPSILON;
    const workingPoints = hasCenterOffset
      ? offsetPolygonPoints(normalizedPoints, centerOffsetValue, {
          closed,
          joinStyle: options.joinStyle,
          mitreLimit: options.mitreLimit,
          width: options.width,
          startJoinDir: options.startJoinDir,
          endJoinDir: options.endJoinDir
        })
      : normalizedPoints;
    const adjustedTextureOffset = hasCenterOffset
      ? { ...(options.textureOffset || {}), y: 0 }
      : (options.textureOffset || { x: 0, y: 0 });
    const geometryOptions = {
      ...options,
      textureOffset: adjustedTextureOffset
    };

    const maxSampleDistance = Math.max(4, options.maxSegmentLength || DEFAULT_SEGMENT_SUBDIVISION);
    const { samples, totalDistance } = samplePolygonPerimeter(
      workingPoints,
      closed,
      maxSampleDistance,
      maxSampleDistance / 2,
      options
    );
    if (!samples || samples.length < 2) {
      return {
        positions: [],
        uvs: [],
        indices: [],
        distances: [],
        totalLength: 0,
        samples: [],
        options: geometryOptions
      };
    }

    const offsets = resolveJoinVectors(workingPoints, geometryOptions);
    if (offsets) {
      offsets.originalPoints = workingPoints;
    }
    const vertexData = buildVertexDataFromSamples(samples, offsets, geometryOptions, totalDistance);
    if (!vertexData) {
      return {
        positions: [],
        uvs: [],
        indices: [],
        distances: [],
        totalLength: 0,
        samples: [],
        options: geometryOptions
      };
    }

    return {
      ...vertexData,
      samples,
      totalLength: totalDistance,
      options: geometryOptions
    };
  }

  static buildGeometry(centerlinePoints, opts = {}) {
    const data = BuildingWallMesher.buildCenterline(centerlinePoints, opts);
    const geometry = toPIXIGeometry(data);
    return { geometry, data };
  }
}

export default BuildingWallMesher;
