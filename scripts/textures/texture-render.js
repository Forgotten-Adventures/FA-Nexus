import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { getOrCreatePixiTexture } from '../core/foundry-texture-loader-patch.js';
import {
  applyHsbcToDisplayObject,
  readDocumentHsbc
} from '../core/hsbc.js';
import {
  attachCustomTileOverhead,
  cloneDisplayObjectForCustomTileProxy,
  detachCustomTileOverhead,
  invalidateCustomTileOverhead
} from '../canvas/custom-tile-overhead.js';

const TILE_MESH_WAITERS = new WeakMap();
const TILE_RETRY_TIMERS = new WeakMap();
const SHARED_TEXTURE_CACHE = new Map();
let TRANSPARENT_TEXTURE = null;
let REHYDRATE_STATE = null;

const TRANSPARENT_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TEXTURE_SCALE_MIN = 0.25;
const TEXTURE_SCALE_MAX = 3;
const DEG_TO_RAD = Math.PI / 180;
const MASK_TYPE_ARRAY = 'array';
const ARC_SAMPLE_SPACING = 20;
const ARC_SAMPLE_MIN = 8;
const ARC_SAMPLE_MAX = 72;
const ARC_DUPLICATE_EPSILON = 0.5;
const ARC_CIRCULAR_ALIGNMENT_RATIO = 0.02;
const ARC_CIRCULAR_ALIGNMENT_MIN = 0.75;
const ARC_CIRCULAR_ANGLE_EPSILON = Math.PI / 90;
const ARC_CIRCULAR_DOT_RATIO = 0.001;
const ARC_CIRCULAR_CENTER_RATIO = 0.45;
const TAU = Math.PI * 2;
const RIGHT_ANGLE = Math.PI / 2;
const EDITING_TILE_SET_KEY = '__faNexusTextureEditingTileIds';
const SOLID_COLOR_FULL_RE = /^#([0-9a-f]{6})$/i;
const SOLID_COLOR_SHORT_RE = /^#([0-9a-f]{3})$/i;
const MASKED_TILING_FLAG = 'maskedTiling';
const STANDARD_TILE_MASK_FLAG = 'standardTileMask';
const FLATTENED_FLAG = 'flattened';
const MASKED_OVERHEAD_KIND = 'masked';
const STANDARD_MASK_OVERHEAD_KIND = 'standard-mask';
const LEGACY_ORIGINAL_TEXTURE_KEY = 'faNexusOriginalTexture';
const MASKED_TILING_ORIGINAL_TEXTURE_KEY = 'faNexusMaskedTilingOriginalTexture';
const STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY = 'faNexusStandardMaskOriginalTexture';

function getEditingTileSet() {
  try {
    const root = globalThis;
    if (!root) return null;
    const existing = root[EDITING_TILE_SET_KEY];
    return existing instanceof Set ? existing : null;
  } catch (_) {
    return null;
  }
}

function resolveTileId(tile) {
  try {
    return tile?.document?.id || tile?.document?._id || tile?.id || null;
  } catch (_) {
    return null;
  }
}

function isEditingTile(tile) {
  try {
    const set = getEditingTileSet();
    if (!set) return false;
    const id = resolveTileId(tile);
    return !!id && set.has(id);
  } catch (_) {
    return false;
  }
}

function normalizeSolidColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const full = SOLID_COLOR_FULL_RE.exec(trimmed);
  if (full) return `#${full[1].toLowerCase()}`;
  const short = SOLID_COLOR_SHORT_RE.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function parseSolidColorTint(value) {
  const normalized = normalizeSolidColor(value);
  if (!normalized) return null;
  return Number.parseInt(normalized.slice(1), 16);
}

function getSolidColorTexture() {
  try {
    if (PIXI?.Texture?.WHITE) return PIXI.Texture.WHITE;
  } catch (_) {}
  return PIXI.Texture.EMPTY;
}

export function encodeTexturePath(path) {
  if (!path) return path;
  if (/^https?:/i.test(path)) return path;
  try { return encodeURI(decodeURI(String(path))); }
  catch (_) {
    try { return encodeURI(String(path)); }
    catch { return path; }
  }
}

export function normalizeOffset(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const round = (n) => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
  return {
    x: Number.isFinite(x) ? round(x) : 0,
    y: Number.isFinite(y) ? round(y) : 0
  };
}

export function roundValue(value, places = 3) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** Math.max(0, places);
  return Math.round(value * factor) / factor;
}

function clampTextureScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.min(TEXTURE_SCALE_MAX, Math.max(TEXTURE_SCALE_MIN, numeric));
}

function normalizeTextureRotation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = ((numeric % 360) + 360) % 360;
  return normalized * DEG_TO_RAD;
}

function getBaseGridScale() {
  try {
    const assetPx = 200;
    const sceneGridSize = Number(canvas?.scene?.grid?.size || 100) || 100;
    if (!Number.isFinite(sceneGridSize) || sceneGridSize <= 0) return 1;
    return sceneGridSize / assetPx;
  } catch (_) {
    return 1;
  }
}

function applyTilingSamplingFix(tiling) {
  try {
    const base = tiling?.texture?.baseTexture;
    if (base) {
      base.wrapMode = PIXI.WRAP_MODES.REPEAT;
      base.mipmap = PIXI.MIPMAP_MODES.OFF;
    }
    const uv = tiling?.uvMatrix;
    if (uv) {
      uv.clampMargin = -0.5;
      uv.update();
    }
  } catch (_) {}
}

export function getSharedTexture(src) {
  if (!src) return null;
  const encoded = encodeTexturePath(src);
  const cached = SHARED_TEXTURE_CACHE.get(encoded);
  if (cached && !cached.destroyed) return cached;
  const texture = getOrCreatePixiTexture(encoded);
  SHARED_TEXTURE_CACHE.set(encoded, texture);
  return texture;
}

function copyProxyTransform(source, target) {
  if (!source || !target) return;
  try { target.position?.copyFrom?.(source.position); } catch (_) {
    try { target.position?.set?.(source.position?.x ?? 0, source.position?.y ?? 0); } catch (_) {}
  }
  try { target.scale?.copyFrom?.(source.scale); } catch (_) {
    try { target.scale?.set?.(source.scale?.x ?? 1, source.scale?.y ?? 1); } catch (_) {}
  }
  try { target.pivot?.copyFrom?.(source.pivot); } catch (_) {}
  try { target.skew?.copyFrom?.(source.skew); } catch (_) {}
  try { target.rotation = source.rotation ?? 0; } catch (_) {}
  try { target.angle = source.angle ?? 0; } catch (_) {}
  try { target.visible = source.visible !== false; } catch (_) {}
  try { target.renderable = source.renderable !== false; } catch (_) {}
  try { target.alpha = Number.isFinite(Number(source.alpha)) ? Number(source.alpha) : 1; } catch (_) {}
  try { target.eventMode = 'none'; } catch (_) {}
}

function createMaskedProxyFactory(container) {
  return () => {
    try {
      const liveContainer = container;
      const liveMask = liveContainer?.faNexusMaskSprite || null;
      if (!liveContainer || liveContainer.destroyed || !liveMask || liveMask.destroyed) {
        return cloneDisplayObjectForCustomTileProxy(liveContainer);
      }
      const proxyContainer = new PIXI.Container();
      proxyContainer.eventMode = 'none';
      proxyContainer.sortableChildren = false;
      proxyContainer.interactiveChildren = false;
      copyProxyTransform(liveContainer, proxyContainer);
      const proxyMask = cloneDisplayObjectForCustomTileProxy(liveMask);
      if (!proxyMask || proxyMask.destroyed) return proxyContainer;
      try { proxyMask.visible = true; } catch (_) {}
      try { proxyMask.renderable = true; } catch (_) {}
      proxyContainer.addChild(proxyMask);
      return proxyContainer;
    } catch (_) {
      return cloneDisplayObjectForCustomTileProxy(container);
    }
  };
}

function getMaxTextureSize() {
  try {
    const gl = canvas?.app?.renderer?.gl || canvas?.app?.renderer?.context?.gl;
    if (!gl) return 4096;
    const val = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const max = Number(val || 4096) || 4096;
    return Math.max(1024, Math.min(max, 8192));
  } catch (_) {
    return 4096;
  }
}

function isTextureUsable(texture) {
  if (!texture || texture.destroyed) return false;
  const base = texture.baseTexture;
  if (!base || base.destroyed) return false;
  if (base.valid === false) return false;
  return true;
}

function clampValue(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function pointsEqual(a, b, epsilon = ARC_DUPLICATE_EPSILON) {
  if (!a || !b) return false;
  return Math.abs((a.x ?? 0) - (b.x ?? 0)) <= epsilon
    && Math.abs((a.y ?? 0) - (b.y ?? 0)) <= epsilon;
}

function distanceBetween(a, b) {
  if (!a || !b) return 0;
  const dx = (b.x ?? 0) - (a.x ?? 0);
  const dy = (b.y ?? 0) - (a.y ?? 0);
  return Math.hypot(dx, dy);
}

function segmentSide(a, b, point, epsilon = 1e-4) {
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
}

function sampleQuadraticBezier(start, control, end, segments = ARC_SAMPLE_MIN) {
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
}

function dedupeSequentialPoints(points = [], epsilon = ARC_DUPLICATE_EPSILON) {
  if (!Array.isArray(points) || points.length <= 1) return points;
  const result = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = result[result.length - 1];
    const current = points[i];
    if (!pointsEqual(prev, current, epsilon)) result.push(current);
  }
  return result;
}

function resolveArcSnapStep() {
  const grid = Number(canvas?.scene?.grid?.size || 0);
  if (Number.isFinite(grid) && grid > 0) return grid;
  return 200;
}

function getArcSampleCount(distance) {
  const spacing = Math.max(6, ARC_SAMPLE_SPACING);
  const estimate = Math.max(ARC_SAMPLE_MIN, Math.ceil(distance / spacing) * 2);
  return clampValue(estimate, ARC_SAMPLE_MIN, ARC_SAMPLE_MAX);
}

function isQuarterAxisAligned(vec, tolerance) {
  if (!vec) return false;
  const alignedX = Math.abs(vec.x ?? 0) <= tolerance;
  const alignedY = Math.abs(vec.y ?? 0) <= tolerance;
  if (alignedX && alignedY) return false;
  return alignedX || alignedY;
}

function resolveQuarterCircleCenters(startPoint, endPoint, controlPoint) {
  if (!startPoint || !endPoint || !controlPoint) return [];
  if (Math.abs((endPoint.x ?? 0) - (startPoint.x ?? 0)) <= ARC_DUPLICATE_EPSILON) return [];
  if (Math.abs((endPoint.y ?? 0) - (startPoint.y ?? 0)) <= ARC_DUPLICATE_EPSILON) return [];
  const snapStep = Math.abs(resolveArcSnapStep()) || 200;
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
}

function resolveArcOrientationFromControl(startPoint, endPoint, controlPoint, prevPoint) {
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
}

function buildCircularArcFromCenter(startPoint, endPoint, center, options = {}) {
  if (!startPoint || !endPoint || !center) return null;
  const snapStep = Math.abs(resolveArcSnapStep()) || 200;
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
}

function buildCircularArcPoints(startPoint, endPoint, controlPoint, options = {}) {
  if (!startPoint || !endPoint || !controlPoint) return null;
  const centers = resolveQuarterCircleCenters(startPoint, endPoint, controlPoint);
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
}

function buildEllipticalArcPoints(startPoint, endPoint, controlPoint, options = {}) {
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

  for (let i = 0; i <= segments; i++) {
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
}

function buildArcSamplePoints(startPoint, endPoint, options = {}) {
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
      prevPoint: options.prevPoint,
      segments: segmentCount,
      sourceControlPoint: options.controlPoint
    });
    if (circular) return circular;

    const elliptical = buildEllipticalArcPoints(startPoint, endPoint, options.controlPoint, {
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
}

function expandPolygonVertices(vertices = []) {
  if (!Array.isArray(vertices) || !vertices.length) return [];
  const points = [];
  for (let i = 0; i < vertices.length; i += 1) {
    const current = vertices[i];
    const point = { x: Number(current?.x ?? 0), y: Number(current?.y ?? 0) };
    if (i === 0) {
      points.push(point);
      continue;
    }
    const arc = current?.arc;
    const controlX = Number.isFinite(arc?.controlX) ? Number(arc.controlX)
      : (Number.isFinite(arc?.control?.x) ? Number(arc.control.x) : null);
    const controlY = Number.isFinite(arc?.controlY) ? Number(arc.controlY)
      : (Number.isFinite(arc?.control?.y) ? Number(arc.control.y) : null);
    if (Number.isFinite(controlX) && Number.isFinite(controlY)) {
      const prevPoint = vertices[i - 2] ? { x: Number(vertices[i - 2].x ?? 0), y: Number(vertices[i - 2].y ?? 0) } : null;
      const arcResult = buildArcSamplePoints(
        { x: Number(vertices[i - 1].x ?? 0), y: Number(vertices[i - 1].y ?? 0) },
        point,
        { controlPoint: { x: controlX, y: controlY }, prevPoint }
      );
      const samples = Array.isArray(arcResult?.points) ? arcResult.points : [];
      if (samples.length) {
        for (let j = 1; j < samples.length; j += 1) {
          points.push({ x: samples[j].x, y: samples[j].y });
        }
        continue;
      }
    }
    points.push(point);
  }
  return points;
}

function hashString(value) {
  const input = String(value ?? '');
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash &= 0xffffffff;
  }
  return (hash >>> 0).toString(16);
}

function isArrayMask(flags) {
  return flags?.maskType === MASK_TYPE_ARRAY
    && (Array.isArray(flags?.maskShapes) || Array.isArray(flags?.maskShapes?.shapes));
}

function getMaskShapeData(flags) {
  const raw = flags?.maskShapes ?? null;
  const shapes = Array.isArray(raw) ? raw : (Array.isArray(raw?.shapes) ? raw.shapes : []);
  if (!shapes.length) return null;
  const key = flags?.maskShapeKey || hashString(JSON.stringify(raw));
  return { shapes, key };
}

function resolveMaskKey(flags) {
  if (isArrayMask(flags)) {
    const data = getMaskShapeData(flags);
    return data?.key || null;
  }
  return flags?.maskSrc || null;
}

function buildMaskTextureFromShapes(shapes, width, height) {
  try {
    if (!Array.isArray(shapes) || !shapes.length) return null;
    const renderer = canvas?.app?.renderer;
    if (!renderer) return null;
    const targetWidth = Math.max(2, Math.ceil(Number(width) || 2));
    const targetHeight = Math.max(2, Math.ceil(Number(height) || 2));
    const maxTex = getMaxTextureSize();
    const rtWidth = Math.max(2, Math.min(targetWidth, maxTex));
    const rtHeight = Math.max(2, Math.min(targetHeight, maxTex));
    const scaleX = rtWidth / targetWidth;
    const scaleY = rtHeight / targetHeight;
    const useScale = scaleX !== 1 || scaleY !== 1;
    const rt = PIXI.RenderTexture.create({
      width: rtWidth,
      height: rtHeight,
      resolution: 1
    });
    const g = new PIXI.Graphics();
    const container = useScale ? new PIXI.Container() : null;
    if (container) {
      container.scale.set(scaleX, scaleY);
      container.addChild(g);
    }
    let first = true;
    for (const shape of shapes) {
      if (!shape || !shape.type) continue;
      const blend = shape.operation === 'subtract' ? PIXI.BLEND_MODES.ERASE : PIXI.BLEND_MODES.NORMAL;
      g.clear();
      g.beginFill(0xFFFFFF, 1);
      if (shape.type === 'rectangle') {
        const x = Number(shape.x ?? shape?.topLeft?.x ?? 0);
        const y = Number(shape.y ?? shape?.topLeft?.y ?? 0);
        const w = Math.max(1, Number(shape.width ?? shape?.size?.width ?? 0));
        const h = Math.max(1, Number(shape.height ?? shape?.size?.height ?? 0));
        g.drawRect(x, y, w, h);
      } else if (shape.type === 'ellipse') {
        const cx = Number(shape.x ?? shape?.center?.x ?? 0);
        const cy = Number(shape.y ?? shape?.center?.y ?? 0);
        const rx = Math.max(0.5, Number(shape.radiusX ?? shape?.radius?.x ?? 0));
        const ry = Math.max(0.5, Number(shape.radiusY ?? shape?.radius?.y ?? 0));
        g.drawEllipse(cx, cy, rx, ry);
      } else if (shape.type === 'polygon') {
        const verts = Array.isArray(shape.vertices) ? shape.vertices : (Array.isArray(shape.points) ? shape.points : []);
        const expanded = expandPolygonVertices(verts);
        if (expanded.length >= 3) {
          const coords = [];
          for (const point of expanded) coords.push(point.x, point.y);
          g.drawPolygon(coords);
        }
      }
      g.endFill();
      g.blendMode = blend;
      renderer.render(container || g, { renderTexture: rt, clear: first });
      first = false;
    }
    if (container) {
      try { container.removeChild(g); } catch (_) {}
      try { container.destroy({ children: false }); } catch (_) {}
    }
    g.destroy({ children: true });
    if (!isTextureUsable(rt)) {
      try { rt.destroy(true); } catch (_) {}
      return null;
    }
    return rt;
  } catch (_) {
    return null;
  }
}

export function getTransparentTextureSrc() {
  return TRANSPARENT_SRC;
}

export function getTransparentTexture() {
  try {
    if (!TRANSPARENT_TEXTURE || TRANSPARENT_TEXTURE.destroyed) {
      const tex = PIXI.Texture.from(TRANSPARENT_SRC);
      tex.baseTexture.wrapMode = PIXI.WRAP_MODES.CLAMP;
      TRANSPARENT_TEXTURE = tex;
    }
    return TRANSPARENT_TEXTURE;
  } catch (_) {
    return PIXI.Texture.EMPTY;
  }
}

function resolveOriginalTextureSlotKey(slotKey) {
  return (typeof slotKey === 'string' && slotKey.trim())
    ? slotKey.trim()
    : LEGACY_ORIGINAL_TEXTURE_KEY;
}

function migrateLegacyOriginalTextureSlot(mesh, slotKey) {
  try {
    if (!mesh || mesh.destroyed) return;
    const key = resolveOriginalTextureSlotKey(slotKey);
    if (key === LEGACY_ORIGINAL_TEXTURE_KEY) return;
    if (mesh[key]) return;
    if (!mesh[LEGACY_ORIGINAL_TEXTURE_KEY]) return;
    mesh[key] = mesh[LEGACY_ORIGINAL_TEXTURE_KEY];
    mesh[LEGACY_ORIGINAL_TEXTURE_KEY] = null;
  } catch (_) {}
}

export function ensureMeshTransparent(mesh, slotKey = LEGACY_ORIGINAL_TEXTURE_KEY) {
  try {
    if (!mesh || mesh.destroyed) return;
    const key = resolveOriginalTextureSlotKey(slotKey);
    migrateLegacyOriginalTextureSlot(mesh, key);
    if (!mesh[key]) mesh[key] = mesh.texture;
    const placeholder = getTransparentTexture();
    if (mesh.texture !== placeholder) mesh.texture = placeholder;
    if (mesh.material) mesh.material.texture = placeholder;
    const uniforms = mesh.shader?.uniforms || null;
    if (uniforms) {
      if ('uSampler' in uniforms) uniforms.uSampler = placeholder;
      if ('texture' in uniforms) uniforms.texture = placeholder;
    }
    if (!Number.isFinite(mesh.alpha)) mesh.alpha = 1;
    mesh.renderable = true;
  } catch (_) {}
}

export function applyTileHsbcToMesh(tile, mesh = null) {
  try {
    const maskedContainer = tile?.faNexusMaskContainer
      || tile?.mesh?.faNexusMaskContainer
      || mesh?.faNexusMaskContainer
      || null;
    const standardContainer = tile?.faNexusStandardMaskContainer
      || tile?.mesh?.faNexusStandardMaskContainer
      || mesh?.faNexusStandardMaskContainer
      || null;
    const target = maskedContainer?.faNexusTilingSprite
      || standardContainer?.faNexusBaseDisplayObject
      || standardContainer?.faNexusBaseSprite
      || null;
    if (!target || target.destroyed) return null;
    return applyHsbcToDisplayObject(
      target,
      readDocumentHsbc(tile?.document, { nullIfMissing: true, nullIfNeutral: true }),
      { slot: maskedContainer ? 'masked-tiling' : 'standard-tile-mask' }
    );
  } catch (_) {
    return null;
  }
}

function resolveFlattenedMeta(doc) {
  if (!doc) return null;
  try {
    const meta = doc.getFlag?.('fa-nexus', FLATTENED_FLAG);
    if (meta && typeof meta === 'object') return meta;
  } catch (_) {}
  try {
    const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
    if (flags?.[FLATTENED_FLAG] && typeof flags[FLATTENED_FLAG] === 'object') return flags[FLATTENED_FLAG];
  } catch (_) {}
  return null;
}

export function getFlattenedChunkEntries(doc) {
  const meta = resolveFlattenedMeta(doc);
  const chunks = Array.isArray(meta?.chunks) ? meta.chunks : [];
  if (!chunks.length) return [];
  const normalized = [];
  for (const chunk of chunks) {
    const src = String(chunk?.src || '').trim();
    if (!src) continue;
    const width = Number(chunk?.width) || 0;
    const height = Number(chunk?.height) || 0;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
    normalized.push({
      src,
      x: Number(chunk?.x) || 0,
      y: Number(chunk?.y) || 0,
      width,
      height,
      pixelWidth: Number.isFinite(Number(chunk?.pixelWidth)) ? Number(chunk?.pixelWidth) : null,
      pixelHeight: Number.isFinite(Number(chunk?.pixelHeight)) ? Number(chunk?.pixelHeight) : null
    });
  }
  return normalized;
}

function buildFlattenedChunkKey(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) return '';
  return chunks.map((chunk) => (
    `${chunk.src}|${chunk.x}|${chunk.y}|${chunk.width}|${chunk.height}|${chunk.pixelWidth ?? ''}|${chunk.pixelHeight ?? ''}`
  )).join(';');
}

function getTileAnchor(doc) {
  return {
    x: clampValue(Number(doc?.texture?.anchorX), 0, 1, 0.5),
    y: clampValue(Number(doc?.texture?.anchorY), 0, 1, 0.5)
  };
}

function syncTileLocalContainerTransform(
  container,
  mesh,
  width,
  height,
  anchor = { x: 0.5, y: 0.5 },
  { preserveFlipSign = false } = {}
) {
  if (!container || container.destroyed || !mesh || mesh.destroyed) return;
  try {
    const rawSx = Number(mesh.scale?.x ?? 1) || 1;
    const rawSy = Number(mesh.scale?.y ?? 1) || 1;
    const sx = Math.abs(rawSx) > 1.001 ? Math.abs(rawSx) : Math.max(1, Number(width) || 1);
    const sy = Math.abs(rawSy) > 1.001 ? Math.abs(rawSy) : Math.max(1, Number(height) || 1);
    const scaleX = preserveFlipSign ? (1 / sx) : ((Math.sign(rawSx || 1) || 1) / sx);
    const scaleY = preserveFlipSign ? (1 / sy) : ((Math.sign(rawSy || 1) || 1) / sy);
    container.scale.set(scaleX, scaleY);
    const offsetX = -((Number(width) || 0) * clampValue(Number(anchor?.x), 0, 1, 0.5)) / (sx || 1);
    const offsetY = -((Number(height) || 0) * clampValue(Number(anchor?.y), 0, 1, 0.5)) / (sy || 1);
    container.position.set(offsetX, offsetY);
  } catch (_) {
    try { container.scale.set(1, 1); } catch (_) {}
    container.position.set(
      -((Number(width) || 0) * clampValue(Number(anchor?.x), 0, 1, 0.5)),
      -((Number(height) || 0) * clampValue(Number(anchor?.y), 0, 1, 0.5))
    );
  }
}

function syncMaskedContainerTransform(container, mesh, width, height) {
  syncTileLocalContainerTransform(container, mesh, width, height, { x: 0.5, y: 0.5 }, { preserveFlipSign: false });
}

function syncStandardMaskContainerTransform(container, mesh, width, height, doc) {
  syncTileLocalContainerTransform(container, mesh, width, height, getTileAnchor(doc), { preserveFlipSign: true });
}

export function restoreMeshTexture(mesh, slotKey = LEGACY_ORIGINAL_TEXTURE_KEY) {
  try {
    if (!mesh || mesh.destroyed) return;
    const key = resolveOriginalTextureSlotKey(slotKey);
    migrateLegacyOriginalTextureSlot(mesh, key);
    if (mesh[key]) {
      const original = mesh[key];
      mesh.texture = original;
      if (mesh.material) mesh.material.texture = original;
      const uniforms = mesh.shader?.uniforms || null;
      if (uniforms) {
        if ('uSampler' in uniforms) uniforms.uSampler = original;
        if ('texture' in uniforms) uniforms.texture = original;
      }
      mesh[key] = null;
    }
  } catch (_) {}
}

export async function ensureTileMesh(tile, options = {}) {
  try {
    if (!tile || tile.destroyed) return null;
    if (tile.mesh && !tile.mesh.destroyed) return tile.mesh;
    const { attempts = 8, delay = 60 } = options || {};
    if (TILE_MESH_WAITERS.has(tile)) return TILE_MESH_WAITERS.get(tile);
    const waiter = (async () => {
      if (typeof tile.draw === 'function') {
        try { await Promise.resolve(tile.draw()); } catch (_) {}
        if (tile.mesh && !tile.mesh.destroyed) return tile.mesh;
      }
      for (let i = 0; i < attempts; i++) {
        await sleep(delay);
        if (!tile || tile.destroyed || !tile.document?.scene) break;
        if (tile.mesh && !tile.mesh.destroyed) return tile.mesh;
      }
      return tile?.mesh && !tile.mesh.destroyed ? tile.mesh : null;
    })();
    TILE_MESH_WAITERS.set(tile, waiter);
    try {
      const mesh = await waiter;
      return mesh;
    } finally {
      TILE_MESH_WAITERS.delete(tile);
    }
  } catch (_) {
    return null;
  }
}

export function clearTileMeshWaiters() {
  try { TILE_MESH_WAITERS.clear(); }
  catch (_) {}
}

export async function loadTexture(src, options = {}) {
  if (!src) throw new Error('Missing texture source');
  const { attempts = 4, timeout = 5000, bustCacheOnRetry = true } = options;
  const encoded = encodeTexturePath(src);
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      const canBust = bustCacheOnRetry && attempt > 1 && !/^data:/i.test(encoded);
      const key = canBust ? `${encoded}${encoded.includes('?') ? '&' : '?'}v=${Date.now()}` : encoded;
      const texture = canBust ? getOrCreatePixiTexture(key) : getSharedTexture(encoded);
      const ok = await waitForBaseTexture(texture?.baseTexture, timeout);
      if (ok) return texture;
      lastError = new Error('Texture base texture invalid');
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts) await sleep(150 * attempt);
  }
  throw lastError || new Error(`Texture failed to load: ${src}`);
}

export async function waitForBaseTexture(baseTexture, timeout = 5000) {
  if (!baseTexture) return false;
  if (baseTexture.valid) return true;
  return await new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const cleanup = () => {
      if (!baseTexture) return;
      try { baseTexture.off?.('loaded', onLoad); } catch (_) {}
      try { baseTexture.off?.('error', onError); } catch (_) {}
      if (timer) clearTimeout(timer);
    };
    const onLoad = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(true);
    };
    const onError = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(false);
    };
    if (baseTexture.valid) {
      resolve(true);
      return;
    }
    try { baseTexture.once?.('loaded', onLoad); }
    catch (_) { resolve(baseTexture.valid); return; }
    try { baseTexture.once?.('error', onError); } catch (_) {}
    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(!!baseTexture?.valid);
    }, Math.max(500, timeout));
    if (baseTexture.valid) {
      cleanup();
      resolve(true);
    }
  });
}

export async function sleep(ms) {
  try {
    if (!ms || ms <= 0) return;
    if (foundry?.utils?.sleep) {
      await foundry.utils.sleep(ms);
      return;
    }
  } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function computeMaskPlacement(flags, tileWidth, tileHeight, maskTex) {
  try {
    const mw = Math.max(1, maskTex?.baseTexture?.realWidth || maskTex?.width || 1);
    const mh = Math.max(1, maskTex?.baseTexture?.realHeight || maskTex?.height || 1);
    const meta = flags || {};
    const version = Number(meta.maskVersion || 1);
    if (version >= 2) {
      const scaleX = Number.isFinite(tileWidth / mw) && tileWidth > 0 ? tileWidth / mw : 1;
      const scaleY = Number.isFinite(tileHeight / mh) && tileHeight > 0 ? tileHeight / mh : 1;
      return {
        scaleX: Math.max(1e-6, scaleX),
        scaleY: Math.max(1e-6, scaleY),
        offsetX: 0,
        offsetY: 0,
        version
      };
    }
    const original = meta.maskOriginalSize || {};
    const crop = meta.maskCrop || {};
    const originalWidth = Math.max(1, Number(original.width) || mw);
    const originalHeight = Math.max(1, Number(original.height) || mh);
    const cropX = Math.max(0, Number(crop.x) || 0);
    const cropY = Math.max(0, Number(crop.y) || 0);
    const cropWidth = Math.max(1, Number(crop.width) || originalWidth);
    const cropHeight = Math.max(1, Number(crop.height) || originalHeight);

    const scaleFromOriginalX = tileWidth / originalWidth;
    const scaleFromOriginalY = tileHeight / originalHeight;
    const displayWidth = cropWidth * scaleFromOriginalX;
    const displayHeight = cropHeight * scaleFromOriginalY;

    const rawScaleX = displayWidth / mw;
    const rawScaleY = displayHeight / mh;
    const offsetX = cropX * scaleFromOriginalX;
    const offsetY = cropY * scaleFromOriginalY;

    const safeScaleX = Number.isFinite(rawScaleX) && rawScaleX > 0 ? rawScaleX : (tileWidth / mw);
    const safeScaleY = Number.isFinite(rawScaleY) && rawScaleY > 0 ? rawScaleY : (tileHeight / mh);
    const clampWidth = Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : tileWidth;
    const clampHeight = Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : tileHeight;
    const maxOffsetX = Math.max(0, tileWidth - clampWidth);
    const maxOffsetY = Math.max(0, tileHeight - clampHeight);
    const safeOffsetX = Number.isFinite(offsetX) ? Math.min(Math.max(0, offsetX), maxOffsetX) : 0;
    const safeOffsetY = Number.isFinite(offsetY) ? Math.min(Math.max(0, offsetY), maxOffsetY) : 0;

    return {
      scaleX: safeScaleX,
      scaleY: safeScaleY,
      offsetX: safeOffsetX,
      offsetY: safeOffsetY
    };
  } catch (_) {
    const mw = Math.max(1, maskTex?.baseTexture?.realWidth || maskTex?.width || 1);
    const mh = Math.max(1, maskTex?.baseTexture?.realHeight || maskTex?.height || 1);
    return {
      scaleX: tileWidth / mw,
      scaleY: tileHeight / mh,
      offsetX: 0,
      offsetY: 0
    };
  }
}

export function applyBaseTilingOffset(tiling, tile, flags) {
  try {
    if (!tiling || tiling.destroyed) return;
    const tilePos = tiling.tilePosition;
    const version = Number(flags?.maskVersion || 1);
    if (!tilePos || typeof tilePos.set !== 'function') return;
    if (!tile || !tile.document) {
      tilePos.set(0, 0);
      return;
    }
    const doc = tile.document;
    const origin = flags?.maskWorld?.origin || {};
    const originX = Number(origin.x) || 0;
    const originY = Number(origin.y) || 0;
    const deltaX = Number(doc?.x) - originX;
    const deltaY = Number(doc?.y) - originY;
    if (version >= 3) {
      const phase = normalizeOffset(flags?.texturePhase) || { x: 0, y: 0 };
      const userOffset = normalizeOffset(flags?.textureOffset) || { x: 0, y: 0 };
      const liveDelta = getLiveTileDelta(tile, flags);
      tilePos.x = roundValue((phase.x + userOffset.x) - deltaX + liveDelta.x);
      tilePos.y = roundValue((phase.y + userOffset.y) - deltaY + liveDelta.y);
      return;
    }
    if (version < 2) {
      tilePos.set(0, 0);
      return;
    }
    tilePos.x = roundValue(-deltaX);
    tilePos.y = roundValue(-deltaY);
  } catch (_) {}
}

export function getLiveTileDelta(tile, flags) {
  try {
    if (!tile || !tile.document) return { x: 0, y: 0 };
    const doc = tile.document;
    const anchor = flags?.maskWorld?.tile || {};
    const anchorX = Number(anchor.x);
    const anchorY = Number(anchor.y);
    const docX = Number(doc.x);
    const docY = Number(doc.y);
    const deltaX = (Number.isFinite(anchorX) && Number.isFinite(docX)) ? roundValue(docX - anchorX) : 0;
    const deltaY = (Number.isFinite(anchorY) && Number.isFinite(docY)) ? roundValue(docY - anchorY) : 0;
    if (!deltaX && !deltaY) return { x: 0, y: 0 };
    return { x: deltaX, y: deltaY };
  } catch (_) {
    return { x: 0, y: 0 };
  }
}

export function scheduleMaskedTileRetry(tile, applyFn) {
  try {
    if (!tile || tile.destroyed) return;
    const retries = TILE_RETRY_TIMERS;
    const existing = retries.get(tile) || { attempts: 0, timeout: null };
    if (existing.timeout) {
      try { clearTimeout(existing.timeout); } catch (_) {}
    }
    const next = (existing.attempts || 0) + 1;
    if (next > 8) {
      retries.delete(tile);
      return;
    }
    const timeout = setTimeout(() => {
      try { retries.delete(tile); } catch (_) {}
      if (typeof applyFn === 'function') applyFn(tile);
    }, Math.min(150 * next, 600));
    retries.set(tile, { attempts: next, timeout });
  } catch (_) {}
}

export function clearMaskedTileRetry(tile) {
  try {
    if (!tile) return;
    const retries = TILE_RETRY_TIMERS;
    const existing = retries.get(tile);
    if (!existing) return;
    if (existing.timeout) {
      try { clearTimeout(existing.timeout); } catch (_) {}
    }
    retries.delete(tile);
  } catch (_) {}
}

export async function applyMaskedTilingToTile(tile) {
  let hidePreview = false;
  let wasVisible = null;
  try {
    if (!tile || !tile.document) return;
    const editing = isEditingTile(tile);
    const flags = tile.document.getFlag('fa-nexus', MASKED_TILING_FLAG);
    const arrayMask = isArrayMask(flags);
    const solidColor = normalizeSolidColor(flags?.baseColor);
    const solidTint = parseSolidColorTint(solidColor);
    const cleanupOverlay = (options = {}) => {
      const preserveTexture = !!options.preserveTexture;
      try {
        const meshRef = tile?.mesh;
        const cont = meshRef?.faNexusMaskContainer || tile?.faNexusMaskContainer;
        if (tile) detachCustomTileOverhead(tile, { kind: MASKED_OVERHEAD_KIND });
        if (cont) {
          try { cont.parent?.removeChild?.(cont); } catch (_) {}
          try { cont.destroy({ children: true }); } catch (_) {}
          cont.faNexusTilingSprite = null;
          cont.faNexusMaskSprite = null;
          cont.faNexusBaseTexture = null;
          cont.faNexusMaskTexture = null;
          cont.faNexusBaseSrc = null;
          cont.faNexusMaskSrc = null;
        }
        if (meshRef) {
          meshRef.faNexusMaskContainer = null;
          meshRef.faNexusMaskReady = false;
          if (!preserveTexture && meshRef[MASKED_TILING_ORIGINAL_TEXTURE_KEY]) {
            if (meshRef.faNexusStandardMaskContainer || tile?.faNexusStandardMaskContainer) {
              Logger.error('TextureRender.maskedTiling.cleanup.restoreBlockedByStandardMask', {
                tileId: tile?.document?.id || tile?.id || null
              });
            } else {
              restoreMeshTexture(meshRef, MASKED_TILING_ORIGINAL_TEXTURE_KEY);
            }
          }
        }
        if (tile) tile.faNexusMaskContainer = null;
      } catch (_) {}
    };

    if (editing) {
      cleanupOverlay({ preserveTexture: true });
      clearMaskedTileRetry(tile);
      let mesh = tile.mesh;
      if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
      if (mesh && !mesh.destroyed) {
        ensureMeshTransparent(mesh, MASKED_TILING_ORIGINAL_TEXTURE_KEY);
        try { mesh.alpha = 0; } catch (_) {}
      }
      return;
    }

    if (!flags || (!flags.baseSrc && !solidColor) || (!flags.maskSrc && !arrayMask)) {
      cleanupOverlay();
      clearMaskedTileRetry(tile);
      return;
    }

    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);

    if (!mesh || mesh.destroyed) {
      scheduleMaskedTileRetry(tile, applyMaskedTilingToTile);
      return;
    }

    clearMaskedTileRetry(tile);

    ensureMeshTransparent(mesh, MASKED_TILING_ORIGINAL_TEXTURE_KEY);

    let reuse = getReusableTextures(tile, flags);
    hidePreview = (!reuse || !reuse.ready) && tile?.isPreview;
    wasVisible = hidePreview ? !!tile.visible : null;
    if (hidePreview && tile.visible) {
      try { tile.visible = false; } catch (_) {}
    }

    const meshWidth = Number(mesh?.width);
    const meshHeight = Number(mesh?.height);
    const docWidth = Number(tile?.document?.width);
    const docHeight = Number(tile?.document?.height);
    const w = Math.max(2, Number.isFinite(docWidth) && docWidth > 0 ? docWidth : (Number.isFinite(meshWidth) && meshWidth > 0 ? meshWidth : 2));
    const h = Math.max(2, Number.isFinite(docHeight) && docHeight > 0 ? docHeight : (Number.isFinite(meshHeight) && meshHeight > 0 ? meshHeight : 2));
    const maskData = arrayMask ? getMaskShapeData(flags) : null;

    let baseTex = reuse?.baseTex || null;
    let maskTex = reuse?.maskTex || null;
    if (solidTint !== null) baseTex = getSolidColorTexture();
    try {
      if (!baseTex || !maskTex) {
        baseTex = solidTint !== null ? getSolidColorTexture() : await loadTexture(flags.baseSrc);
        if (arrayMask) {
          maskTex = buildMaskTextureFromShapes(maskData?.shapes, w, h);
          if (!maskTex) throw new Error('Mask shape render failed');
        } else {
          maskTex = await loadTexture(flags.maskSrc);
        }
      }
    } catch (texErr) {
      try { Logger.warn('TextureRender.apply.loadFailed', { error: String(texErr?.message || texErr), tileId: tile?.document?.id }); } catch (_) {}
      scheduleMaskedTileRetry(tile, applyMaskedTilingToTile);
      return;
    }
    if (!isTextureUsable(baseTex)) throw new Error('Base texture invalid');
    if (!isTextureUsable(maskTex)) throw new Error('Mask texture invalid');
    const maskKey = resolveMaskKey(flags);

    let container = mesh.faNexusMaskContainer;
    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      mesh.faNexusMaskContainer = container;
      tile.faNexusMaskContainer = container;
      mesh.addChild(container);
    } else {
      mesh.faNexusMaskContainer = container;
      tile.faNexusMaskContainer = container;
      if (!container.parent) mesh.addChild(container);
    }
    const previousMaskTex = container.faNexusMaskTexture || null;

    let maskSprite = container.faNexusMaskSprite || null;
    let tiling = container.faNexusTilingSprite || null;
    if (!tiling || tiling.destroyed) {
      tiling = new PIXI.TilingSprite(baseTex, w, h);
      tiling.position.set(0, 0);
      tiling.tilePosition.set(0, 0);
      tiling.alpha = 1;
      container.addChild(tiling);
      container.faNexusTilingSprite = tiling;
    }

    if (!tiling || tiling.destroyed) return;
    if (tiling.texture !== baseTex) {
      try { tiling.texture = baseTex; } catch (_) {}
    }
    try {
      tiling.width = w;
      tiling.height = h;
    } catch (_) {}

    const baseGridScale = getBaseGridScale();
    const userScale = clampTextureScale(flags?.textureScale);
    const combinedScale = baseGridScale * userScale;
    const finalScale = (Number.isFinite(combinedScale) && combinedScale > 0) ? combinedScale : 1;
    const rotationRad = normalizeTextureRotation(flags?.textureRotation);

    try { tiling.tileScale.set(finalScale, finalScale); }
    catch (_) { tiling.scale?.set?.(finalScale, finalScale); }
    applyTilingSamplingFix(tiling);
    try {
      if (tiling.tileTransform && typeof tiling.tileTransform.rotation === 'number') {
        tiling.tileTransform.rotation = rotationRad;
      } else {
        tiling.rotation = rotationRad;
      }
    } catch (_) {}

    if (!maskSprite || maskSprite.destroyed) {
      maskSprite = new PIXI.Sprite(maskTex);
      container.addChild(maskSprite);
      container.faNexusMaskSprite = maskSprite;
    } else if (maskSprite.texture !== maskTex) {
      try { maskSprite.texture = maskTex; } catch (_) {}
    }

    if (!maskSprite || !tiling) return;

    const placement = computeMaskPlacement(flags, w, h, maskTex);
    const refreshMaskPlacement = () => {
      try {
        maskSprite.scale.set(placement.scaleX || 1, placement.scaleY || 1);
        maskSprite.position.set(placement.offsetX || 0, placement.offsetY || 0);
        maskSprite.width = w;
        maskSprite.height = h;
      } catch (_) {}
      try { tiling.tint = solidTint !== null ? solidTint : 0xFFFFFF; } catch (_) {}
    };

    refreshMaskPlacement();
    applyBaseTilingOffset(tiling, tile, flags);
    try {
      if (typeof tiling._refresh === 'function') tiling._refresh();
      else if (tiling.uvMatrix) tiling.uvMatrix.update();
    } catch (_) {}

    container.faNexusMaskSprite = maskSprite;
    container.faNexusTilingSprite = tiling;
    container.faNexusMaskTexture = maskTex;
    container.faNexusBaseTexture = baseTex;
    container.faNexusMaskSrc = maskKey;
    container.faNexusBaseSrc = flags.baseSrc;
    applyHsbcToDisplayObject(
      tiling,
      tile?.document
        ? readDocumentHsbc(tile.document, { nullIfMissing: true, nullIfNeutral: true })
        : null,
      { slot: 'masked-tiling' }
    );

    if (arrayMask && previousMaskTex && previousMaskTex !== maskTex) {
      try { previousMaskTex.destroy(true); } catch (_) {}
    }

    tiling.mask = maskSprite;
    try { maskSprite.renderable = false; } catch (_) {}

    syncMaskedContainerTransform(container, mesh, w, h);

    try { mesh.faNexusMaskReady = true; } catch (_) {}
    attachCustomTileOverhead(tile, {
      kind: MASKED_OVERHEAD_KIND,
      contentContainer: container,
      proxyFactory: createMaskedProxyFactory(container),
      filterMode: 'container',
      syncContent: ({ mesh: currentMesh, entry }) => {
        syncMaskedContainerTransform(entry?.contentContainer, currentMesh, w, h);
      }
    });
    invalidateCustomTileOverhead(tile, 'masked-refresh');
  } catch (error) {
    Logger.warn('TextureRender.apply.failed', String(error?.message || error));
    try {
      const cont = tile?.mesh?.faNexusMaskContainer || tile?.faNexusMaskContainer;
      const invalid = cont && (!isTextureUsable(cont.faNexusBaseTexture) || !isTextureUsable(cont.faNexusMaskTexture));
      if (invalid) {
        if (tile) clearMaskedOverlaysOnDelete(tile);
      }
    } catch (_) {}
  } finally {
    if (hidePreview && wasVisible !== null) {
      try { tile.visible = wasVisible; } catch (_) {}
    }
  }
}

function getReusableStandardMaskTextures(tile, flags, baseSrc) {
  try {
    const mesh = tile?.mesh;
    if (!mesh) return null;
    const container = mesh.faNexusStandardMaskContainer;
    if (!container) return null;
    const maskTex = container.faNexusMaskTexture;
    const expectedMask = resolveMaskKey(flags);
    if (container.faNexusBaseSrc !== baseSrc) return null;
    if (container.faNexusMaskSrc !== expectedMask) return null;
    const baseKind = container.faNexusBaseKind || 'sprite';
    if (baseKind !== 'flattened-chunks' && !isTextureUsable(container.faNexusBaseTexture)) return null;
    if (!isTextureUsable(maskTex)) return null;
    if (isArrayMask(flags) && maskTex) {
      const maxTex = getMaxTextureSize();
      const texW = Number(maskTex?.baseTexture?.realWidth || maskTex?.width || 0);
      const texH = Number(maskTex?.baseTexture?.realHeight || maskTex?.height || 0);
      if ((Number.isFinite(texW) && texW > maxTex) || (Number.isFinite(texH) && texH > maxTex)) return null;
    }
    return {
      baseTex: container.faNexusBaseTexture,
      maskTex,
      ready: !!mesh.faNexusStandardMaskReady
    };
  } catch (_) {
    return null;
  }
}

function destroyStandardBaseDisplay(container, content = null) {
  try {
    const display = container?.faNexusBaseDisplayObject || container?.faNexusBaseSprite || null;
    if (!display || display.destroyed) return;
    try {
      const parent = display.parent || content || null;
      parent?.removeChild?.(display);
    } catch (_) {}
    try { display.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
  } catch (_) {}
  try { if (container) container.faNexusBaseDisplayObject = null; } catch (_) {}
  try { if (container) container.faNexusBaseSprite = null; } catch (_) {}
  try { if (container) container.faNexusBaseKind = null; } catch (_) {}
  try { if (container) container.faNexusBaseChunkKey = null; } catch (_) {}
  try { if (container) container.faNexusBaseTexture = null; } catch (_) {}
}

function ensureSpriteStandardBaseDisplay(content, container, baseTex, width, height) {
  let baseSprite = container?.faNexusBaseSprite || null;
  const baseDisplay = container?.faNexusBaseDisplayObject || null;
  const needsReset = !baseSprite
    || baseSprite.destroyed
    || container?.faNexusBaseKind !== 'sprite'
    || (baseDisplay && baseDisplay !== baseSprite);
  if (needsReset) {
    destroyStandardBaseDisplay(container, content);
    baseSprite = new PIXI.Sprite(baseTex);
    baseSprite.eventMode = 'none';
    content.addChildAt(baseSprite, 0);
    container.faNexusBaseDisplayObject = baseSprite;
    container.faNexusBaseSprite = baseSprite;
    container.faNexusBaseKind = 'sprite';
  } else if (baseSprite.parent !== content) {
    content.addChildAt(baseSprite, 0);
  }
  if (baseSprite.texture !== baseTex) {
    try { baseSprite.texture = baseTex; } catch (_) {}
  }
  try {
    baseSprite.position.set(0, 0);
    baseSprite.width = width;
    baseSprite.height = height;
    baseSprite.alpha = 1;
    baseSprite.tint = 0xFFFFFF;
  } catch (_) {}
  try { container.faNexusBaseChunkKey = null; } catch (_) {}
  return baseSprite;
}

async function ensureChunkedStandardBaseDisplay(content, container, chunkEntries, chunkKey, tileId = null) {
  let baseDisplay = container?.faNexusBaseDisplayObject || null;
  const needsReset = !baseDisplay
    || baseDisplay.destroyed
    || container?.faNexusBaseKind !== 'flattened-chunks'
    || (baseDisplay instanceof PIXI.Sprite);
  if (needsReset) {
    destroyStandardBaseDisplay(container, content);
    baseDisplay = new PIXI.Container();
    baseDisplay.eventMode = 'none';
    baseDisplay.sortableChildren = false;
    content.addChildAt(baseDisplay, 0);
    container.faNexusBaseDisplayObject = baseDisplay;
    container.faNexusBaseSprite = null;
    container.faNexusBaseKind = 'flattened-chunks';
  } else if (baseDisplay.parent !== content) {
    content.addChildAt(baseDisplay, 0);
  }

  if (container?.faNexusBaseChunkKey === chunkKey) return baseDisplay;

  const results = await Promise.all(chunkEntries.map(async (chunk) => {
    try {
      const texture = await loadTexture(chunk.src, { attempts: 3, timeout: 6000 });
      return { chunk, texture };
    } catch (error) {
      Logger.error('TextureRender.standardTileMask.chunkTextureLoadFailed', {
        tileId,
        src: chunk?.src || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }));

  const nextSprites = [];
  for (const result of results) {
    if (!result?.texture) continue;
    const { chunk, texture } = result;
    const sprite = new PIXI.Sprite(texture);
    sprite.eventMode = 'none';
    sprite.position.set(Number(chunk?.x) || 0, Number(chunk?.y) || 0);
    sprite.width = Number(chunk?.width) || 1;
    sprite.height = Number(chunk?.height) || 1;
    nextSprites.push(sprite);
  }

  if (!nextSprites.length) {
    Logger.error('TextureRender.standardTileMask.chunkBaseMissing', {
      tileId,
      chunks: Array.isArray(chunkEntries) ? chunkEntries.length : 0
    });
    throw new Error('Chunked flattened tile did not produce any standard mask base sprites');
  }

  const prevChildren = baseDisplay.children?.slice() || [];
  try { baseDisplay.removeChildren(); } catch (_) {}
  for (const child of prevChildren) {
    try { child.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
  }
  for (const sprite of nextSprites) {
    baseDisplay.addChild(sprite);
  }

  try { container.faNexusBaseChunkKey = chunkKey; } catch (_) {}
  Logger.info('TextureRender.standardTileMask.chunkBaseReady', {
    tileId,
    chunks: nextSprites.length
  });
  return baseDisplay;
}

export function clearStandardTileMaskOverlay(tile, options = {}) {
  const preserveTexture = !!options?.preserveTexture;
  try {
    if (!tile) return;
    const mesh = tile.mesh;
    const container = mesh?.faNexusStandardMaskContainer || tile.faNexusStandardMaskContainer;
    detachCustomTileOverhead(tile, { kind: STANDARD_MASK_OVERHEAD_KIND });
    if (container) {
      const previousMaskTex = container.faNexusMaskTexture || null;
      const destroyMaskTexture = isArrayMask(tile?.document?.getFlag?.('fa-nexus', STANDARD_TILE_MASK_FLAG))
        && previousMaskTex
        && !previousMaskTex.destroyed;
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
      if (destroyMaskTexture) {
        try { previousMaskTex.destroy(true); } catch (_) {}
      }
    }
    if (mesh) {
      mesh.faNexusStandardMaskContainer = null;
      mesh.faNexusStandardMaskReady = false;
      if (!preserveTexture && mesh[STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY]) {
        if (mesh.faNexusMaskContainer || tile?.faNexusMaskContainer) {
          Logger.error('TextureRender.standardTileMask.cleanup.restoreBlockedByMaskedTiling', {
            tileId: tile?.document?.id || tile?.id || null
          });
        } else {
          restoreMeshTexture(mesh, STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY);
        }
      }
    }
    tile.faNexusStandardMaskContainer = null;
  } catch (_) {}
}

export async function applyStandardTileMaskToTile(tile) {
  let hidePreview = false;
  let wasVisible = null;
  try {
    if (!tile || !tile.document) return;
    const editing = isEditingTile(tile);
    const flags = tile.document.getFlag('fa-nexus', STANDARD_TILE_MASK_FLAG);
    const arrayMask = isArrayMask(flags);
    const chunkEntries = getFlattenedChunkEntries(tile.document);
    const chunkBaseKey = buildFlattenedChunkKey(chunkEntries);
    const isChunkedBase = !!chunkBaseKey;
    const src = String(tile.document?.texture?.src || '').trim();

    if (editing) {
      clearStandardTileMaskOverlay(tile, { preserveTexture: true });
      clearMaskedTileRetry(tile);
      let mesh = tile.mesh;
      if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
      if (mesh && !mesh.destroyed) {
        ensureMeshTransparent(mesh, STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY);
        try { mesh.alpha = 0; } catch (_) {}
      }
      return;
    }

    if (!flags || (!flags.maskSrc && !arrayMask) || !src) {
      clearStandardTileMaskOverlay(tile);
      clearMaskedTileRetry(tile);
      return;
    }
    if (/\.(webm|mp4)$/i.test(src)) {
      Logger.error('TextureRender.applyStandardTileMaskToTile.unsupportedVideo', {
        tileId: tile?.document?.id,
        src
      });
      clearStandardTileMaskOverlay(tile);
      clearMaskedTileRetry(tile);
      return;
    }

    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) {
      scheduleMaskedTileRetry(tile, applyStandardTileMaskToTile);
      return;
    }

    clearMaskedTileRetry(tile);
    ensureMeshTransparent(mesh, STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY);

    const meshWidth = Number(mesh?.width);
    const meshHeight = Number(mesh?.height);
    const docWidth = Number(tile?.document?.width);
    const docHeight = Number(tile?.document?.height);
    const w = Math.max(2, Number.isFinite(docWidth) && docWidth > 0 ? docWidth : (Number.isFinite(meshWidth) && meshWidth > 0 ? meshWidth : 2));
    const h = Math.max(2, Number.isFinite(docHeight) && docHeight > 0 ? docHeight : (Number.isFinite(meshHeight) && meshHeight > 0 ? meshHeight : 2));
    const baseSrc = isChunkedBase ? `flattened-chunks:${chunkBaseKey}` : encodeTexturePath(src);
    const maskData = arrayMask ? getMaskShapeData(flags) : null;
    const reuse = getReusableStandardMaskTextures(tile, flags, baseSrc);

    hidePreview = (!reuse || !reuse.ready) && tile?.isPreview;
    wasVisible = hidePreview ? !!tile.visible : null;
    if (hidePreview && tile.visible) {
      try { tile.visible = false; } catch (_) {}
    }

    let baseTex = reuse?.baseTex || null;
    let maskTex = reuse?.maskTex || null;
    try {
      if (!isChunkedBase && !baseTex) baseTex = getSharedTexture(baseSrc);
      if (!maskTex) {
        if (arrayMask) {
          maskTex = buildMaskTextureFromShapes(maskData?.shapes, w, h);
          if (!maskTex) throw new Error('Standard tile mask shape render failed');
        } else {
          maskTex = await loadTexture(flags.maskSrc);
        }
      }
    } catch (texErr) {
      Logger.error('TextureRender.applyStandardTileMaskToTile.textureLoadFailed', {
        tileId: tile?.document?.id,
        error: String(texErr?.message || texErr),
        src: baseSrc,
        maskSrc: flags?.maskSrc || null
      });
      scheduleMaskedTileRetry(tile, applyStandardTileMaskToTile);
      return;
    }
    if (!isChunkedBase && !isTextureUsable(baseTex)) throw new Error('Standard tile base texture invalid');
    if (!isTextureUsable(maskTex)) throw new Error('Standard tile mask texture invalid');

    let container = mesh.faNexusStandardMaskContainer;
    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      mesh.faNexusStandardMaskContainer = container;
      tile.faNexusStandardMaskContainer = container;
      mesh.addChild(container);
    } else {
      mesh.faNexusStandardMaskContainer = container;
      tile.faNexusStandardMaskContainer = container;
      if (!container.parent) mesh.addChild(container);
    }
    const previousMaskTex = container.faNexusMaskTexture || null;

    let content = container.faNexusContentContainer || null;
    if (!content || content.destroyed) {
      content = new PIXI.Container();
      content.eventMode = 'none';
      content.sortableChildren = false;
      container.addChild(content);
      container.faNexusContentContainer = content;
    }

    let baseDisplay = container.faNexusBaseDisplayObject || container.faNexusBaseSprite || null;
    let baseSprite = container.faNexusBaseSprite || null;
    let maskSprite = container.faNexusMaskSprite || null;
    if (isChunkedBase) {
      baseDisplay = await ensureChunkedStandardBaseDisplay(content, container, chunkEntries, chunkBaseKey, tile?.document?.id || null);
      baseSprite = null;
      container.faNexusBaseTexture = null;
    } else {
      baseSprite = ensureSpriteStandardBaseDisplay(content, container, baseTex, w, h);
      baseDisplay = baseSprite;
      container.faNexusBaseTexture = baseTex;
    }

    if (!maskSprite || maskSprite.destroyed) {
      maskSprite = new PIXI.Sprite(maskTex);
      maskSprite.eventMode = 'none';
      content.addChild(maskSprite);
      container.faNexusMaskSprite = maskSprite;
    } else if (maskSprite.texture !== maskTex) {
      try { maskSprite.texture = maskTex; } catch (_) {}
    }
    const placement = computeMaskPlacement(flags, w, h, maskTex);
    try {
      maskSprite.position.set(placement.offsetX || 0, placement.offsetY || 0);
      maskSprite.scale.set(placement.scaleX || 1, placement.scaleY || 1);
      maskSprite.alpha = 1;
      maskSprite.visible = true;
      maskSprite.renderable = false;
    } catch (_) {}

    try { if (baseDisplay) baseDisplay.mask = maskSprite; } catch (_) {}

    container.faNexusMaskTexture = maskTex;
    container.faNexusBaseDisplayObject = baseDisplay;
    container.faNexusMaskSrc = resolveMaskKey(flags);
    container.faNexusBaseSrc = baseSrc;
    container.faNexusMaskFlagKey = STANDARD_TILE_MASK_FLAG;
    container.faNexusWidth = w;
    container.faNexusHeight = h;

    applyHsbcToDisplayObject(
      baseDisplay,
      tile?.document
        ? readDocumentHsbc(tile.document, { nullIfMissing: true, nullIfNeutral: true })
        : null,
      { slot: 'standard-tile-mask' }
    );

    if (arrayMask && previousMaskTex && previousMaskTex !== maskTex) {
      try { previousMaskTex.destroy(true); } catch (_) {}
    }

    syncStandardMaskContainerTransform(container, mesh, w, h, tile.document);

    try { mesh.faNexusStandardMaskReady = true; } catch (_) {}
    attachCustomTileOverhead(tile, {
      kind: STANDARD_MASK_OVERHEAD_KIND,
      contentContainer: container,
      proxyFactory: createMaskedProxyFactory(container),
      filterMode: 'container',
      syncContent: ({ mesh: currentMesh, entry }) => {
        syncStandardMaskContainerTransform(entry?.contentContainer, currentMesh, w, h, tile.document);
      }
    });
    invalidateCustomTileOverhead(tile, 'standard-mask-refresh');
  } catch (error) {
    Logger.error('TextureRender.applyStandardTileMaskToTile.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
    try {
      const cont = tile?.mesh?.faNexusStandardMaskContainer || tile?.faNexusStandardMaskContainer;
      const baseKind = cont?.faNexusBaseKind || 'sprite';
      const invalidBase = baseKind === 'flattened-chunks'
        ? !(cont?.faNexusBaseDisplayObject && !cont.faNexusBaseDisplayObject.destroyed)
        : !isTextureUsable(cont?.faNexusBaseTexture);
      const invalid = cont && (invalidBase || !isTextureUsable(cont?.faNexusMaskTexture));
      if (invalid) clearStandardTileMaskOverlay(tile);
    } catch (_) {}
  } finally {
    if (hidePreview && wasVisible !== null) {
      try { tile.visible = wasVisible; } catch (_) {}
    }
  }
}

function getReusableTextures(tile, flags) {
  try {
    const mesh = tile?.mesh;
    if (!mesh) return null;
    const container = mesh.faNexusMaskContainer;
    if (!container) return null;
    const baseSrc = container.faNexusBaseSrc;
    const maskSrc = container.faNexusMaskSrc;
    const maskTex = container.faNexusMaskTexture;
    const expectedMask = resolveMaskKey(flags);
    if (baseSrc === flags.baseSrc && maskSrc === expectedMask) {
      if (!isTextureUsable(container.faNexusBaseTexture) || !isTextureUsable(maskTex)) return null;
      if (isArrayMask(flags) && maskTex) {
        const maxTex = getMaxTextureSize();
        const texW = Number(maskTex?.baseTexture?.realWidth || maskTex?.width || 0);
        const texH = Number(maskTex?.baseTexture?.realHeight || maskTex?.height || 0);
        if ((Number.isFinite(texW) && texW > maxTex) || (Number.isFinite(texH) && texH > maxTex)) {
          return null;
        }
      }
      return {
        baseTex: container.faNexusBaseTexture,
        maskTex,
        ready: !!mesh.faNexusMaskReady
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

export function rehydrateAllMaskedTiles(options = {}) {
  try {
    if (!canvas?.ready) return;
    const state = REHYDRATE_STATE || (REHYDRATE_STATE = {
      remaining: Math.max(1, Number(options?.attempts) || 1),
      interval: Math.max(50, Number(options?.interval) || 200),
      timer: null
    });

    const addAttempts = Math.max(0, Number(options?.attempts ?? 0));
    state.remaining = Math.max(state.remaining, addAttempts);
    if (Number.isFinite(options?.interval) && options.interval > 0) state.interval = Math.max(50, options.interval);
    if (state.timer) return;

    const run = async () => {
      state.timer = null;
      try {
        if (!canvas || !canvas.ready) { REHYDRATE_STATE = null; return; }
        const tiles = Array.isArray(canvas.tiles?.placeables) ? canvas.tiles.placeables : [];
        const jobs = [];
        for (const tile of tiles) {
          try {
            const hasMaskedTiling = !!tile?.document?.getFlag?.('fa-nexus', MASKED_TILING_FLAG);
            const hasStandardTileMask = !!tile?.document?.getFlag?.('fa-nexus', STANDARD_TILE_MASK_FLAG);
            if (!hasMaskedTiling && !hasStandardTileMask) continue;
            if (hasMaskedTiling) jobs.push(applyMaskedTilingToTile(tile));
            if (hasStandardTileMask) jobs.push(applyStandardTileMaskToTile(tile));
          } catch (_) {}
        }
        if (jobs.length) await Promise.allSettled(jobs);
      } catch (_) {}
      if (state) {
        state.remaining = Math.max(0, (state.remaining || 0) - 1);
        if (state.remaining > 0) {
          state.timer = setTimeout(run, state.interval);
        } else {
          REHYDRATE_STATE = null;
        }
      }
    };

    state.remaining = Math.max(1, state.remaining || 1);
    state.timer = setTimeout(run, 0);
  } catch (_) {}
}

export function rehydrateAllStandardTileMasks(options = {}) {
  return rehydrateAllMaskedTiles(options);
}

export function cancelGlobalRehydrate() {
  try {
    const state = REHYDRATE_STATE;
    if (!state) return;
    if (state.timer) {
      try { clearTimeout(state.timer); } catch (_) {}
    }
    REHYDRATE_STATE = null;
  } catch (_) {}
}

export function clearMaskedOverlaysOnDelete(tile) {
  try {
    if (!tile) return;
    const mesh = tile.mesh;
    const container = mesh?.faNexusMaskContainer || tile.faNexusMaskContainer;
    detachCustomTileOverhead(tile, { kind: MASKED_OVERHEAD_KIND });
    if (container) {
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) {
      mesh.faNexusMaskContainer = null;
      mesh.faNexusMaskReady = false;
      if (mesh[MASKED_TILING_ORIGINAL_TEXTURE_KEY]) restoreMeshTexture(mesh, MASKED_TILING_ORIGINAL_TEXTURE_KEY);
      if (mesh[STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY]) restoreMeshTexture(mesh, STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY);
      if (mesh[LEGACY_ORIGINAL_TEXTURE_KEY]) restoreMeshTexture(mesh, LEGACY_ORIGINAL_TEXTURE_KEY);
    }
    if (tile) tile.faNexusMaskContainer = null;
    clearMaskedTileRetry(tile);
  } catch (_) {}
  try {
    clearStandardTileMaskOverlay(tile);
  } catch (_) {}
}
