import { NexusLogger as Logger } from '../core/nexus-logger.js';
import BuildingWallMesher from '../buildings/building-wall-mesher.js';
import { getOrCreatePixiTexture } from '../core/foundry-texture-loader-patch.js';
import {
  applyHsbcToDisplayObject,
  cloneHsbc,
  normalizeHsbc,
  readDocumentHsbc
} from '../core/hsbc.js';
import {
  attachCustomTileOverhead,
  createDisplayProxyFactory,
  detachCustomTileOverhead,
  invalidateCustomTileOverhead
} from '../canvas/custom-tile-overhead.js';

export const DEFAULT_SEGMENT_SAMPLES = 200;
export const MIN_POINTS_TO_RENDER = 2;
export const MIN_WIDTH_MULTIPLIER = 0.01;
export const MAX_WIDTH_MULTIPLIER = 5;
const FEATHER_GROW_MULTIPLIER = 1.5;
const EPSILON = 1e-6;
const CORNER_DOT_THRESHOLD = Math.cos(Math.PI / 12); // ~15°

const TILE_MESH_WAITERS = new WeakMap();
let TRANSPARENT_TEXTURE = null;
let PATH_PROGRAM = null;
const VISIBLE_ALPHA_THRESHOLD = 10;
const LINEAR_TENSION_THRESHOLD = 0.999;
const WIDTH_MULTIPLIER_EPSILON = 1e-3;
const EDITING_TILES_KEY = '__faNexusPathEditingTiles';
const PATH_WALL_DELETE_QUEUE = new Map();
const SHARED_PATH_TEXTURE_CACHE = new Map();
const PATH_HSBC_SLOT = 'path-runtime';

function isEditingTile(doc) {
  try {
    const id = doc?.id;
    if (!id) return false;
    const set = globalThis?.[EDITING_TILES_KEY];
    return set instanceof Set && set.has(id);
  } catch (_) {
    return false;
  }
}

function applyMeshOpacity(mesh, alpha) {
  try {
    if (!mesh || mesh.destroyed) return;
    mesh.alpha = alpha;
    const shader = mesh.shader || mesh.material?.shader || null;
    const uniforms = shader?.uniforms || null;
    if (uniforms && uniforms.uColor) {
      const color = uniforms.uColor;
      if (Array.isArray(color)) {
        if (color.length >= 4) {
          color[0] = alpha;
          color[1] = alpha;
          color[2] = alpha;
          color[3] = alpha;
        }
      } else if (color instanceof Float32Array) {
        if (color.length >= 4) {
          color[0] = alpha;
          color[1] = alpha;
          color[2] = alpha;
          color[3] = alpha;
        }
      } else if (typeof color === 'object' && color !== null && typeof color.length === 'number') {
        if (color.length >= 4) {
          color[0] = alpha;
          color[1] = alpha;
          color[2] = alpha;
          color[3] = alpha;
        }
      } else {
        uniforms.uColor = new Float32Array([alpha, alpha, alpha, alpha]);
      }
    }
  } catch (_) {}
}

export function normalizeTension(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(-1, Math.min(1, num));
}

function shouldUseWallMesher(controlPoints, data) {
  if (!Array.isArray(controlPoints) || controlPoints.length < 2) return false;
  const tension = normalizeTension(data?.tension);
  if (tension < LINEAR_TENSION_THRESHOLD) return false;
  const feather = normalizeFeather(data?.feather);
  if (feather.startMode !== 'none' || feather.endMode !== 'none') return false;
  if (feather.startLength > 0 || feather.endLength > 0) return false;
  for (const point of controlPoints) {
    if (!point) continue;
    if (Number.isFinite(point.widthLeft) && Math.abs(point.widthLeft - 1) > WIDTH_MULTIPLIER_EPSILON) return false;
    if (Number.isFinite(point.widthRight) && Math.abs(point.widthRight - 1) > WIDTH_MULTIPLIER_EPSILON) return false;
  }
  return true;
}

function createWallMesherPathMesh(controlPoints, data, texture, options = {}) {
  try {
    if (!controlPoints?.length || !texture) return null;
    const geometryData = BuildingWallMesher.buildCenterline(controlPoints, {
      width: Math.max(1, Number(data?.width) || 1),
      closed: !!data?.closed,
      joinStyle: 'mitre',
      mitreLimit: 4,
      textureRepeatDistance: Math.max(1e-3, Number(data?.repeatSpacing) || Number(data?.width) || 1),
      textureOffset: data?.textureOffset || { x: 0, y: 0 },
      textureFlip: data?.textureFlip || { horizontal: false, vertical: false }
    });
    const positions = geometryData?.positions || [];
    const uvs = geometryData?.uvs || [];
    const indices = geometryData?.indices || [];
    if (!positions.length || !uvs.length || !indices.length) return null;
    const distances = geometryData?.distances || [];
    const totalLength = Math.max(0, Number(geometryData?.totalLength) || Number(distances[distances.length - 1]) || 0);
    const opacityFeather = normalizeOpacityFeather(data?.opacityFeather);
    const alphas = [];
    for (let i = 0; i < distances.length; i++) {
      const alpha = computeOpacityMultiplier(distances[i], totalLength, opacityFeather);
      alphas.push(alpha, alpha);
    }
    if (alphas.length !== positions.length / 2) {
      const fallback = new Array(positions.length / 2).fill(1);
      alphas.length = 0;
      alphas.push(...fallback);
    }
    const geometry = new PIXI.Geometry()
      .addAttribute('aVertexPosition', positions, 2)
      .addAttribute('aTextureCoord', uvs, 2)
      .addAttribute('aAlpha', alphas, 1)
      .addIndex(indices);
    if (options?.visibleData) {
      remapVisibleRows(geometry, options.visibleData);
    }
    const shader = createPathShader(texture);
    const mesh = new PIXI.Mesh(geometry, shader);
    try { mesh.state.blendMode = PIXI.BLEND_MODES.NORMAL; }
    catch (_) {}
    mesh.eventMode = 'none';
    applyHsbcToDisplayObject(mesh, cloneHsbc(options?.hsbc), { slot: PATH_HSBC_SLOT });
    return mesh;
  } catch (error) {
    Logger.warn('PathGeometry.createWallMesh.failed', { error: String(error?.message || error) });
    return null;
  }
}

export function computeSegmentParameters(p0, p1, p2, p3) {
  const alpha = 0.5;
  const epsilon = 1e-4;
  const getT = (ti, a, b) => {
    if (!a || !b) return ti + epsilon;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = Math.pow(Math.max(dist, epsilon), alpha);
    return ti + step;
  };
  const t0 = 0;
  const t1 = getT(t0, p0, p1);
  const t2 = getT(t1, p1, p2);
  const t3 = getT(t2, p2, p3);
  return { t0, t1, t2, t3 };
}

export function computeSegmentTangents(p0, p1, p2, p3, params, tension) {
  const tightness = normalizeTension(tension);
  const scale = 1 - tightness;
  const { t0, t1, t2, t3 } = params;
  const dt21 = Math.max(t2 - t1, 1e-4);
  const dt20 = Math.max(t2 - t0, 1e-4);
  const dt31 = Math.max(t3 - t1, 1e-4);
  const m1 = {
    x: scale * (p2.x - p0.x) * (dt21 / dt20),
    y: scale * (p2.y - p0.y) * (dt21 / dt20)
  };
  const m2 = {
    x: scale * (p3.x - p1.x) * (dt21 / dt31),
    y: scale * (p3.y - p1.y) * (dt21 / dt31)
  };
  return { m1, m2, dt: dt21 };
}

export function evaluateHermite(p1, p2, m1, m2, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return {
    x: h00 * p1.x + h10 * m1.x + h01 * p2.x + h11 * m2.x,
    y: h00 * p1.y + h10 * m1.y + h01 * p2.y + h11 * m2.y
  };
}

export function evaluateHermiteTangent(p1, p2, m1, m2, t, dt) {
  const t2 = t * t;
  const dh00 = 6 * t2 - 6 * t;
  const dh10 = 3 * t2 - 4 * t + 1;
  const dh01 = -6 * t2 + 6 * t;
  const dh11 = 3 * t2 - 2 * t;
  const invDt = 1 / (dt || 1);
  return {
    x: (dh00 * p1.x + dh10 * m1.x + dh01 * p2.x + dh11 * m2.x) * invDt,
    y: (dh00 * p1.y + dh10 * m1.y + dh01 * p2.y + dh11 * m2.y) * invDt
  };
}

export function lerp(a, b, t) {
  return a + ((b - a) * Math.min(1, Math.max(0, t)));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(vec, value) {
  return { x: vec.x * value, y: vec.y * value };
}

function rotate90(vec) {
  return { x: -vec.y, y: vec.x };
}

function dot(a, b) {
  return (a.x * b.x) + (a.y * b.y);
}

function cross(a, b) {
  return (a.x * b.y) - (a.y * b.x);
}

function resolveDirection(from, to) {
  if (!from || !to) return null;
  const dx = Number(to.x) - Number(from.x);
  const dy = Number(to.y) - Number(from.y);
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < EPSILON) return null;
  return { x: dx / len, y: dy / len };
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

  if (Math.abs(turn) < EPSILON || Math.abs(1 - dotValue) < EPSILON) {
    return scale(normalNext, offset);
  }

  if (dotValue < -0.99) {
    return scale(normalNext, offset);
  }

  const bisectorX = normalPrev.x + normalNext.x;
  const bisectorY = normalPrev.y + normalNext.y;
  const bisectorLen = Math.hypot(bisectorX, bisectorY);
  if (bisectorLen < EPSILON) {
    return scale(normalNext, offset);
  }

  const bisector = { x: bisectorX / bisectorLen, y: bisectorY / bisectorLen };
  const projectionOntoNext = dot(bisector, normalNext);
  if (Math.abs(projectionOntoNext) < EPSILON) {
    return scale(normalNext, offset);
  }

  const miterLength = offset / projectionOntoNext;
  const limit = Math.max(1.5, Number.isFinite(mitreLimit) ? mitreLimit : 4);
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

function shouldTreatCornerVertex(prevDir, nextDir, { isEndpoint = false } = {}) {
  if (isEndpoint) return true;
  if (!prevDir || !nextDir) return true;
  const dotValue = clamp(dot(prevDir, nextDir), -1, 1);
  return dotValue <= CORNER_DOT_THRESHOLD;
}

function buildCornerInfo(points, closed) {
  const info = new Array(points.length);
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const current = points[i];
    const prev = i === 0 ? (closed ? points[count - 1] : null) : points[i - 1];
    const next = i === count - 1 ? (closed ? points[0] : null) : points[i + 1];
    const prevDir = resolveDirection(prev, current);
    const nextDir = resolveDirection(current, next);
    const isEndpoint = !closed && (i === 0 || i === count - 1);
    const isCorner = shouldTreatCornerVertex(prevDir, nextDir, { isEndpoint });
    info[i] = { prevDir, nextDir, isCorner };
  }
  return info;
}

export function clampWidthMultiplier(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(MIN_WIDTH_MULTIPLIER, Math.min(MAX_WIDTH_MULTIPLIER, numeric));
}

export function sampleSegment(
  p0,
  p1,
  p2,
  p3,
  segmentIndex,
  sampleCount = DEFAULT_SEGMENT_SAMPLES,
  tension = 0,
  startWidth = 1,
  endWidth = 1
) {
  const out = [];
  const params = computeSegmentParameters(p0, p1, p2, p3);
  const tangents = computeSegmentTangents(p0, p1, p2, p3, params, tension);
  const widthStart = clampWidthMultiplier(startWidth);
  const widthEnd = clampWidthMultiplier(endWidth);
  const count = Math.max(2, sampleCount);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const pos = evaluateHermite(p1, p2, tangents.m1, tangents.m2, t);
    const tangent = evaluateHermiteTangent(p1, p2, tangents.m1, tangents.m2, t, tangents.dt);
    const widthMultiplier = lerp(widthStart, widthEnd, t);
    out.push({ x: pos.x, y: pos.y, tangent, segmentIndex, widthMultiplier, progress: t });
  }
  return out;
}

function sampleLinearSegment(
  p1,
  p2,
  segmentIndex,
  sampleCount = DEFAULT_SEGMENT_SAMPLES,
  startWidth = 1,
  endWidth = 1
) {
  const out = [];
  const count = Math.max(2, sampleCount);
  const widthStart = clampWidthMultiplier(startWidth);
  const widthEnd = clampWidthMultiplier(endWidth);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const segLen = Math.hypot(dx, dy);
  const tangent = segLen > EPSILON ? { x: dx / segLen, y: dy / segLen } : { x: 1, y: 0 };
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const posX = p1.x + (dx * t);
    const posY = p1.y + (dy * t);
    const widthMultiplier = lerp(widthStart, widthEnd, t);
    out.push({ x: posX, y: posY, tangent, segmentIndex, widthMultiplier, progress: t });
  }
  return out;
}

export function computeSamplesFromPoints(points, sampleCount = DEFAULT_SEGMENT_SAMPLES, tension = 0, options = {}) {
  if (!Array.isArray(points) || points.length < MIN_POINTS_TO_RENDER) return [];
  const closed = !!options.closed && points.length >= MIN_POINTS_TO_RENDER;
  const samples = [];
  let lastPos = null;
  let totalDistance = 0;
  const segments = Math.max(2, sampleCount);
  const normalizedTension = normalizeTension(tension);
  const useLinear = normalizedTension >= 0.999;
  const cornerInfo = useLinear ? buildCornerInfo(points, closed) : null;
  const totalPoints = points.length;
  const limit = closed ? totalPoints : totalPoints - 1;
  for (let i = 0; i < limit; i++) {
    const idx0 = closed ? ((i - 1 + totalPoints) % totalPoints) : Math.max(0, i - 1);
    const idx1 = i % totalPoints;
    const idx2 = closed ? ((i + 1) % totalPoints) : (i + 1);
    const idx3 = closed ? ((i + 2) % totalPoints) : Math.min(totalPoints - 1, i + 2);
    const p0 = points[idx0] || points[idx1];
    const p1 = points[idx1];
    const p2 = points[idx2];
    const p3 = points[idx3] || points[idx2];
    if (!p1 || !p2) continue;
    const startWidth = resolveOutgoingWidth(p1);
    const endWidth = resolveIncomingWidth(p2);
    const segSamples = useLinear
      ? sampleLinearSegment(p1, p2, i, segments, startWidth, endWidth)
      : sampleSegment(p0, p1, p2, p3, i, segments, normalizedTension, startWidth, endWidth);
    for (let j = 0; j < segSamples.length; j++) {
      const sample = segSamples[j];
      if (!sample) continue;
      if (useLinear) {
        let cornerIndex = null;
        if (j === 0) cornerIndex = idx1;
        if (closed && i === limit - 1 && j === segSamples.length - 1) cornerIndex = idx2;
        if (cornerIndex !== null) {
          const info = cornerInfo?.[cornerIndex];
          if (info?.isCorner) {
            sample.isCorner = true;
            sample.vertexIndex = cornerIndex;
            if (info.prevDir) sample.prevDir = { x: info.prevDir.x, y: info.prevDir.y };
            if (info.nextDir) sample.nextDir = { x: info.nextDir.x, y: info.nextDir.y };
          }
        }
      }
      if (lastPos && j === 0 && i > 0 && !useLinear) continue;
      if (lastPos) {
        const dx = sample.x - lastPos.x;
        const dy = sample.y - lastPos.y;
        totalDistance += Math.sqrt(dx * dx + dy * dy);
      }
      sample.distance = totalDistance;
      samples.push(sample);
      lastPos = { x: sample.x, y: sample.y };
    }
  }
  return samples;
}

export function resolveIncomingWidth(point) {
  if (!point) return 1;
  if (Number.isFinite(point.widthLeft)) return clampWidthMultiplier(point.widthLeft);
  if (Number.isFinite(point.widthRight)) return clampWidthMultiplier(point.widthRight);
  return 1;
}

export function resolveOutgoingWidth(point) {
  if (!point) return 1;
  if (Number.isFinite(point.widthRight)) return clampWidthMultiplier(point.widthRight);
  if (Number.isFinite(point.widthLeft)) return clampWidthMultiplier(point.widthLeft);
  return 1;
}

export function createMeshFromSamples(samples, pathWidth, repeatSpacing, texture, options = {}) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  if (!texture || texture.destroyed) return null;
  try {
    const width = Math.max(1, Number(pathWidth) || 1);
    const halfWidthBase = width / 2;
    const spacing = Math.max(1e-3, Number(repeatSpacing) || width);
    const vertices = [];
    const uvs = [];
    const alphas = [];
    const indices = [];
    let lastNormal = { x: 0, y: -1 };
    let lastCenter = null;
    let offsetDistance = 0;
    const offsetX = Number(options?.textureOffset?.x) || 0;
    const offsetY = Number(options?.textureOffset?.y) || 0;
    const flipH = !!options?.textureFlip?.horizontal;
    const flipV = !!options?.textureFlip?.vertical;
    const feather = normalizeFeather(options?.feather);
    const opacityFeather = normalizeOpacityFeather(options?.opacityFeather);
    const totalLength = Math.max(0, Number(samples[samples.length - 1]?.distance) || 0);
    const baseTex = texture?.baseTexture || null;
    const texWidth = Math.max(1, Number(baseTex?.realWidth || texture?.width) || 1);
    const texHeight = Math.max(1, Number(baseTex?.realHeight || texture?.height) || 1);
    const uMargin = Math.min(0.25, 0.5 / texWidth);
    const vMargin = Math.min(0.25, 0.5 / texHeight);
    const repeatScaleU = Math.max(1e-4, 1 - (uMargin * 2));
    const marginBase = flipH ? (1 - uMargin) : uMargin;

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      let tangent = sample.tangent || { x: 1, y: 0 };
      const len = Math.hypot(tangent.x, tangent.y) || 1;
      tangent = { x: tangent.x / len, y: tangent.y / len };
      let normal = { x: -tangent.y, y: tangent.x };
      const nLen = Math.hypot(normal.x, normal.y);
      if (nLen < 1e-3) {
        normal = lastNormal;
      } else {
        normal = { x: normal.x / nLen, y: normal.y / nLen };
      }
      lastNormal = normal;

      const distance = Number(sample.distance) || 0;
      const widthMultiplier = clampWidthMultiplier(
        (Number(sample.widthMultiplier) || 1) * computeFeatherMultiplier(distance, totalLength, feather)
      );
      const halfWidth = halfWidthBase * widthMultiplier;

      const useCornerOffsets = !!sample.isCorner && (sample.prevDir || sample.nextDir);
      let leftOffset = null;
      let rightOffset = null;
      let offsetShift = null;
      if (useCornerOffsets) {
        const joinStyle = options?.joinStyle || 'mitre';
        const mitreLimit = Number.isFinite(options?.mitreLimit) ? options.mitreLimit : 4;
        leftOffset = computeJoinOffset(sample.prevDir, sample.nextDir, halfWidth, joinStyle, mitreLimit);
        rightOffset = computeJoinOffset(sample.prevDir, sample.nextDir, -halfWidth, joinStyle, mitreLimit);
        if (Math.abs(offsetY) > EPSILON) {
          offsetShift = computeCenterCornerOffset(sample.prevDir, sample.nextDir, offsetY);
        }
      }
      if (!leftOffset || !rightOffset) {
        leftOffset = { x: normal.x * halfWidth, y: normal.y * halfWidth };
        rightOffset = { x: -normal.x * halfWidth, y: -normal.y * halfWidth };
      }
      if (!offsetShift) {
        offsetShift = { x: normal.x * offsetY, y: normal.y * offsetY };
      }

      // Translate the strip by the Y offset so the whole texture slides instead of wrapping.
      const centerX = sample.x + offsetShift.x;
      const centerY = sample.y + offsetShift.y;
      if (lastCenter) {
        const dx = centerX - lastCenter.x;
        const dy = centerY - lastCenter.y;
        offsetDistance += Math.hypot(dx, dy);
      }
      lastCenter = { x: centerX, y: centerY };
      const mappedDistance = offsetDistance;
      const leftX = sample.x + offsetShift.x + leftOffset.x;
      const leftY = sample.y + offsetShift.y + leftOffset.y;
      const rightX = sample.x + offsetShift.x + rightOffset.x;
      const rightY = sample.y + offsetShift.y + rightOffset.y;

      const uRaw = ((flipH ? -mappedDistance : mappedDistance) + offsetX) / spacing;
      const u = (uRaw * repeatScaleU) + marginBase;
      let vTop = flipV ? (1 - vMargin) : vMargin;
      let vBottom = flipV ? vMargin : (1 - vMargin);
      const alpha = computeOpacityMultiplier(distance, totalLength, opacityFeather);

      vertices.push(leftX, leftY, rightX, rightY);
      uvs.push(u, vBottom, u, vTop);
      alphas.push(alpha, alpha);
    }

    for (let i = 0; i < samples.length - 1; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = (i + 1) * 2;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }

    try {
      if (baseTex) {
        baseTex.wrapMode = PIXI.WRAP_MODES.REPEAT;
        baseTex.mipmap = PIXI.MIPMAP_MODES.OFF;
      }
    } catch (_) {}

    const geometry = new PIXI.Geometry()
      .addAttribute('aVertexPosition', vertices, 2)
      .addAttribute('aTextureCoord', uvs, 2)
      .addAttribute('aAlpha', alphas, 1)
      .addIndex(indices);
    if (options?.visibleData) {
      remapVisibleRows(geometry, options.visibleData);
    }

    const shader = createPathShader(texture);
    const mesh = new PIXI.Mesh(geometry, shader);
    try { mesh.state.blendMode = PIXI.BLEND_MODES.NORMAL; }
    catch (_) {}
    mesh.eventMode = 'none';
    applyHsbcToDisplayObject(mesh, cloneHsbc(options?.hsbc), { slot: PATH_HSBC_SLOT });
    return mesh;
  } catch (error) {
    Logger.warn('PathGeometry.createMesh.failed', { error: String(error?.message || error) });
    return null;
  }
}

export function normalizeFeather(raw = {}) {
  const startMode = String(raw.startMode || '').toLowerCase();
  const endMode = String(raw.endMode || '').toLowerCase();
  return {
    startMode: ['shrink', 'grow'].includes(startMode) ? startMode : 'none',
    endMode: ['shrink', 'grow'].includes(endMode) ? endMode : 'none',
    startLength: Math.max(0, Number(raw.startLength) || 0),
    endLength: Math.max(0, Number(raw.endLength) || 0)
  };
}

export function normalizeOpacityFeather(raw = {}) {
  return {
    startEnabled: !!raw.startEnabled,
    endEnabled: !!raw.endEnabled,
    startLength: Math.max(0, Number(raw.startLength) || 0),
    endLength: Math.max(0, Number(raw.endLength) || 0)
  };
}

export function computeFeatherMultiplier(distance, totalLength, feather = {}) {
  let multiplier = 1;
  const startLength = Math.max(0, Number(feather.startLength) || 0);
  if (startLength > 0) {
    const t = Math.min(distance / startLength, 1);
    if (feather.startMode === 'shrink') multiplier *= Math.max(MIN_WIDTH_MULTIPLIER, t);
    else if (feather.startMode === 'grow') multiplier *= 1 + ((FEATHER_GROW_MULTIPLIER - 1) * (1 - t));
  }
  const endLength = Math.max(0, Number(feather.endLength) || 0);
  if (endLength > 0) {
    const remaining = Math.max(totalLength - distance, 0);
    const t = Math.min(remaining / endLength, 1);
    if (feather.endMode === 'shrink') multiplier *= Math.max(MIN_WIDTH_MULTIPLIER, t);
    else if (feather.endMode === 'grow') multiplier *= 1 + ((FEATHER_GROW_MULTIPLIER - 1) * (1 - t));
  }
  return Math.max(MIN_WIDTH_MULTIPLIER, Math.min(MAX_WIDTH_MULTIPLIER, multiplier));
}

export function computeOpacityMultiplier(distance, totalLength, opacity = {}) {
  let alpha = 1;
  if (opacity.startEnabled && opacity.startLength > 0) {
    const t = Math.min(Math.max(distance / opacity.startLength, 0), 1);
    alpha *= t;
  }
  if (opacity.endEnabled && opacity.endLength > 0) {
    const remaining = Math.max(totalLength - distance, 0);
    const t = Math.min(Math.max(remaining / opacity.endLength, 0), 1);
    alpha *= t;
  }
  return Math.min(1, Math.max(0, alpha));
}

export function getPathProgram() {
  if (PATH_PROGRAM) return PATH_PROGRAM;
  const vertexSrc = `
    precision highp float;
    attribute vec2 aVertexPosition;
    attribute vec2 aTextureCoord;
    attribute float aAlpha;
    uniform mat3 translationMatrix;
    uniform mat3 projectionMatrix;
    varying vec2 vTextureCoord;
    varying float vAlpha;
    void main(void){
      vAlpha = aAlpha;
      vTextureCoord = aTextureCoord;
      vec3 position = projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0);
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;
  const fragmentSrc = `
    precision mediump float;
    varying vec2 vTextureCoord;
    varying float vAlpha;
    uniform sampler2D uSampler;
    uniform vec4 uColor;
    void main(void){
      vec4 color = texture2D(uSampler, vTextureCoord) * uColor;
      color.rgb *= vAlpha;
      color.a *= vAlpha;
      if (color.a <= 0.001) discard;
      gl_FragColor = color;
    }
  `;
  PATH_PROGRAM = PIXI.Program.from(vertexSrc, fragmentSrc);
  return PATH_PROGRAM;
}

export function createPathShader(texture) {
  const program = getPathProgram();
  return new PIXI.Shader(program, {
    uSampler: texture,
    uColor: new Float32Array([1, 1, 1, 1])
  });
}

export function encodePath(path) {
  if (!path) return path;
  if (/^https?:/i.test(path)) return path;
  try { return encodeURI(decodeURI(String(path))); }
  catch (_) {
    try { return encodeURI(String(path)); }
    catch { return path; }
  }
}

function normalizeVisibleData(raw, texture) {
  if (!raw || typeof raw !== 'object') return null;
  const base = texture?.baseTexture;
  const totalHeight = Math.max(1, Number(raw.totalHeight) || Number(base?.height) || Number(base?.realHeight) || 0);
  if (!Number.isFinite(totalHeight) || totalHeight <= 0) return null;
  const topRow = Math.max(0, Math.min(totalHeight - 1, Number(raw.topRow) || 0));
  const bottomRow = Math.max(topRow, Math.min(totalHeight - 1, Number(raw.bottomRow ?? (totalHeight - 1))));
  const visibleHeight = Math.max(1, bottomRow - topRow + 1);
  return { topRow, bottomRow, totalHeight, visibleHeight };
}

function detectVisibleRows(texture) {
  if (!texture) return null;
  const cached = normalizeVisibleData(texture._cachedVisibleData, texture);
  if (cached) {
    texture._cachedVisibleData = cached;
    return cached;
  }
  const base = texture.baseTexture;
  if (!base || !base.valid) return null;
  if (typeof document === 'undefined') return null;
  try {
    const resource = base.resource;
    const source = resource?.source;
    if (!source) return null;
    const width = base.width;
    const height = base.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const canvasEl = document.createElement('canvas');
    canvasEl.width = width;
    canvasEl.height = height;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let top = 0;
    let bottom = height - 1;
    const rowVisible = (y) => {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] > VISIBLE_ALPHA_THRESHOLD) return true;
      }
      return false;
    };
    while (top < height && !rowVisible(top)) top += 1;
    while (bottom > top && !rowVisible(bottom)) bottom -= 1;
    const data = normalizeVisibleData({ topRow: top, bottomRow: bottom, totalHeight: height }, texture);
    if (data) texture._cachedVisibleData = data;
    return data;
  } catch (_) {
    return null;
  }
}

function remapVisibleRows(geometry, visibleData) {
  if (!geometry || !visibleData) return;
  const texHeight = Math.max(1, Number(visibleData.totalHeight) || 0);
  if (!texHeight) return;
  const uvBuffer = geometry.getBuffer('aTextureCoord');
  if (!uvBuffer?.data) return;
  const topRow = Number.isFinite(visibleData.topRow) ? Number(visibleData.topRow) : 0;
  const bottomRow = Number.isFinite(visibleData.bottomRow) ? Number(visibleData.bottomRow) : (texHeight - 1);
  const vMin = topRow / texHeight;
  const vMax = (bottomRow + 1) / texHeight;
  const vRange = vMax - vMin;
  if (!(vRange > 0)) return;
  const data = uvBuffer.data;
  for (let i = 1; i < data.length; i += 2) {
    data[i] = vMin + (data[i] * vRange);
  }
  uvBuffer.update();
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

export async function loadPathTexture(src, options = {}) {
  if (!src) throw new Error('Missing texture source');
  const { attempts = 4, timeout = 5000, bustCacheOnRetry = true } = options;
  const encoded = encodePath(src);
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      const canBust = bustCacheOnRetry && attempt > 1 && !/^data:/i.test(encoded);
      const key = canBust ? `${encoded}${encoded.includes('?') ? '&' : '?'}v=${Date.now()}` : encoded;
      let texture = null;
      if (canBust) {
        texture = getOrCreatePixiTexture(key);
      } else {
        texture = SHARED_PATH_TEXTURE_CACHE.get(encoded);
        if (!texture || texture.destroyed || texture.baseTexture?.destroyed) {
          texture = getOrCreatePixiTexture(encoded);
          SHARED_PATH_TEXTURE_CACHE.set(encoded, texture);
        }
      }
      const ok = await waitForBaseTexture(texture?.baseTexture, timeout);
      if (ok) {
        try {
          const base = texture?.baseTexture;
          if (base) {
            base.wrapMode = PIXI.WRAP_MODES.REPEAT;
            base.mipmap = PIXI.MIPMAP_MODES.OFF;
          }
        } catch (_) {}
        return texture;
      }
      lastError = new Error('Texture base texture invalid');
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts) {
      await sleep(150 * attempt);
    }
  }
  throw lastError || new Error(`Texture failed to load: ${src}`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function computeBoundsFromSamples(samples, pathWidth) {
  if (!samples || !samples.length) return null;
  const half = Math.max(1, Number(pathWidth) || 1) / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sample of samples) {
    const sx = Number(sample?.x);
    const sy = Number(sample?.y);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
    minX = Math.min(minX, sx - half);
    minY = Math.min(minY, sy - half);
    maxX = Math.max(maxX, sx + half);
    maxY = Math.max(maxY, sy + half);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  const width = Math.max(4, maxX - minX);
  const height = Math.max(4, maxY - minY);
  return { minX, minY, maxX, maxY, width, height };
}

export function getTransparentTextureSrc() {
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
}

export function getTransparentTexture() {
  try {
    if (!TRANSPARENT_TEXTURE || TRANSPARENT_TEXTURE.destroyed) {
      TRANSPARENT_TEXTURE = PIXI.Texture.from(getTransparentTextureSrc());
      TRANSPARENT_TEXTURE.baseTexture.wrapMode = PIXI.WRAP_MODES.CLAMP;
    }
    return TRANSPARENT_TEXTURE;
  } catch (_) {
    return PIXI.Texture.EMPTY;
  }
}

export function ensureMeshTransparent(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (!mesh.faNexusPathOriginalTexture) mesh.faNexusPathOriginalTexture = mesh.texture;
    const placeholder = getTransparentTexture();
    if (mesh.texture !== placeholder) mesh.texture = placeholder;
    mesh.alpha = 1;
    mesh.renderable = true;
  } catch (_) {}
}

export function restoreMeshTexture(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (mesh.faNexusPathOriginalTexture) {
      mesh.texture = mesh.faNexusPathOriginalTexture;
      mesh.faNexusPathOriginalTexture = null;
    }
  } catch (_) {}
}

export function cleanupPathOverlay(tile) {
  try {
    if (!tile) return;
    const mesh = tile.mesh;
    const container = tile.faNexusPathContainer || mesh?.faNexusPathContainer;
    detachCustomTileOverhead(tile, { kind: 'path' });
    if (container) {
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) {
      mesh.faNexusPathContainer = null;
      restoreMeshTexture(mesh);
    }
    tile.faNexusPathContainer = null;
  } catch (_) {}
}

async function deletePathWallsRobustly(scene, wallIds = []) {
  const uniqueIds = Array.from(new Set(
    (Array.isArray(wallIds) ? wallIds : []).filter(Boolean)
  ));
  if (!scene || !uniqueIds.length) return false;
  const errors = [];
  let deleted = false;
  for (const wallId of uniqueIds) {
    try {
      const doc = scene.walls?.get?.(wallId);
      if (!doc || doc._destroyed) continue;
      await scene.deleteEmbeddedDocuments('Wall', [wallId]);
      deleted = true;
    } catch (error) {
      const message = String(error?.message || error);
      if (!message.includes('does not exist')) {
        errors.push({ wallId, error: message });
      }
    }
  }
  if (errors.length) {
    Logger.warn('PathGeometry.cleanupWalls.failed', { errors });
    return false;
  }
  return deleted || uniqueIds.length > 0;
}

function queuePathWallDeletes(scene, wallIds = []) {
  const uniqueIds = Array.from(new Set(
    (Array.isArray(wallIds) ? wallIds : []).filter(Boolean)
  ));
  if (!scene || !uniqueIds.length) return Promise.resolve(false);
  const queueKey = scene.uuid || scene.id || null;
  if (!queueKey) return deletePathWallsRobustly(scene, uniqueIds);
  let entry = PATH_WALL_DELETE_QUEUE.get(queueKey);
  if (!entry) {
    entry = {
      scene,
      wallIds: new Set(),
      task: null
    };
    PATH_WALL_DELETE_QUEUE.set(queueKey, entry);
  }
  entry.scene = scene;
  for (const wallId of uniqueIds) entry.wallIds.add(wallId);
  if (entry.task) return entry.task;
  entry.task = (async () => {
    let deleted = false;
    await sleep(150);
    while (entry.wallIds.size) {
      const pendingIds = Array.from(entry.wallIds);
      entry.wallIds.clear();
      deleted = (await deletePathWallsRobustly(entry.scene, pendingIds)) || deleted;
      if (entry.wallIds.size) await sleep(75);
    }
    return deleted;
  })().finally(() => {
    PATH_WALL_DELETE_QUEUE.delete(queueKey);
  });
  return entry.task;
}

function collectLinkedPathWallIds(doc, scene) {
  const tileId = doc?.id || null;
  const walls = scene?.walls || null;
  if (!tileId || !walls?.size) return [];
  const ids = new Set();
  const groupIds = new Set();
  for (const wall of walls) {
    if (!wall?.id) continue;
    const flag = wall.getFlag?.('fa-nexus', 'pathWall');
    if (flag?.tileId === tileId) ids.add(wall.id);
  }
  const { payloads } = resolvePathPayloads(doc);
  for (const payload of payloads) {
    const foundryWalls = payload?.foundryWalls || null;
    if (Array.isArray(foundryWalls?.wallIds)) {
      for (const wallId of foundryWalls.wallIds) {
        if (wallId) ids.add(wallId);
      }
    }
    if (foundryWalls?.groupId) groupIds.add(foundryWalls.groupId);
  }
  if (groupIds.size) {
    for (const wall of walls) {
      if (!wall?.id) continue;
      const flag = wall.getFlag?.('fa-nexus', 'pathWall');
      if (flag?.groupId && groupIds.has(flag.groupId)) ids.add(wall.id);
    }
  }
  return [...ids];
}

export async function cleanupPathWallsForTile(tileLike) {
  try {
    if (!game?.user?.isGM) return false;
    const doc = tileLike?.document || tileLike || null;
    const tileId = doc?.id;
    if (!tileId) return false;
    const scene = doc?.parent || canvas?.scene;
    const ids = collectLinkedPathWallIds(doc, scene);
    if (!ids.length) return false;
    return await queuePathWallDeletes(scene, ids);
  } catch (error) {
    Logger.warn('PathGeometry.cleanupWalls.failed', { error: String(error?.message || error) });
    return false;
  }
}

export async function ensureTileMesh(tile, options = {}) {
  try {
    if (!tile || tile.destroyed) return null;
    if (tile.mesh && !tile.mesh.destroyed) return tile.mesh;
    const { attempts = 6, delay = 60 } = options || {};
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

function readPathFlag(doc, key) {
  try {
    const direct = doc?.getFlag?.('fa-nexus', key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
  return flags ? flags[key] : null;
}

function resolvePathPayloads(doc) {
  const merged = readPathFlag(doc, 'pathsV2');
  if (merged && Array.isArray(merged.paths)) {
    const list = merged.paths.filter((entry) => entry && Array.isArray(entry.controlPoints));
    if (list.length) {
      const ordered = list
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => {
          const aOrder = Number.isFinite(a.entry?.zOrder) ? Number(a.entry.zOrder) : a.index;
          const bOrder = Number.isFinite(b.entry?.zOrder) ? Number(b.entry.zOrder) : b.index;
          if (aOrder === bOrder) return a.index - b.index;
          return aOrder - bOrder;
        })
        .map((item) => item.entry);
      return { kind: 'v2', payloads: ordered };
    }
  }
  const v2 = readPathFlag(doc, 'pathV2');
  if (v2 && Array.isArray(v2.controlPoints)) return { kind: 'v2', payloads: [v2] };
  const v1 = readPathFlag(doc, 'path');
  if (v1 && Array.isArray(v1.controlPoints)) return { kind: 'v1', payloads: [v1] };
  return { kind: null, payloads: [] };
}

function shouldSkipV1Runtime(doc) {
  if (!globalThis?.faNexusPathTilesPremium) return false;
  const v2 = readPathFlag(doc, 'pathV2');
  if (v2 && Array.isArray(v2.controlPoints)) return false;
  const merged = readPathFlag(doc, 'pathsV2');
  if (merged && Array.isArray(merged.paths)) return false;
  return true;
}

function normalizeControlPoints(controlPointsRaw = []) {
  if (!Array.isArray(controlPointsRaw)) return [];
  return controlPointsRaw.map((p) => {
    if (!p) return { x: 0, y: 0, widthLeft: 1, widthRight: 1 };
    if (Array.isArray(p)) {
      const x = Number(p[0]) || 0;
      const y = Number(p[1]) || 0;
      const width = Number(p[2]) || 1;
      return { x, y, widthLeft: width, widthRight: width };
    }
    const point = {
      x: Number(p.x) || 0,
      y: Number(p.y) || 0
    };
    if (Number.isFinite(p.widthLeft)) point.widthLeft = Number(p.widthLeft);
    if (Number.isFinite(p.widthRight)) point.widthRight = Number(p.widthRight);
    return point;
  });
}

function buildRenderKey(payloads = []) {
  try {
    return JSON.stringify(payloads);
  } catch (_) {
    return '';
  }
}

function syncPathContainerTransform(container, mesh, doc) {
  if (!container || container.destroyed || !mesh || mesh.destroyed) return;
  const docWidth = Math.max(1, Number(doc?.width) || 0) || Math.max(1, Number(mesh?.width) || 1);
  const docHeight = Math.max(1, Number(doc?.height) || 0) || Math.max(1, Number(mesh?.height) || 1);
  const rawSx = Number(mesh?.scale?.x ?? 1) || 1;
  const rawSy = Number(mesh?.scale?.y ?? 1) || 1;
  const sx = Math.abs(rawSx) > 1.001 ? rawSx : (Math.sign(rawSx || 1) || 1) * docWidth;
  const sy = Math.abs(rawSy) > 1.001 ? rawSy : (Math.sign(rawSy || 1) || 1) * docHeight;
  container.scale?.set?.(1 / sx, 1 / sy);
  container.position?.set?.(-(docWidth / 2) / (sx || 1), -(docHeight / 2) / (sy || 1));
}

function resolvePathMeshes(container) {
  if (!container || container.destroyed) return [];
  const stored = Array.isArray(container.faNexusPathMeshes) && container.faNexusPathMeshes.length
    ? container.faNexusPathMeshes
    : (container.faNexusPathMesh ? [container.faNexusPathMesh] : []);
  if (stored.length) return stored;
  const children = Array.isArray(container.children) ? container.children : [];
  const meshes = children.filter((child) => child && !child.destroyed && child.geometry);
  if (meshes.length) {
    if (!container.faNexusPathMesh) container.faNexusPathMesh = meshes[0];
    if (meshes.length > 1) container.faNexusPathMeshes = meshes;
  }
  return meshes;
}

export async function applyPathTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    if (shouldSkipV1Runtime(doc)) return;
    if (isEditingTile(doc)) {
      cleanupPathOverlay(tile);
      return;
    }
    const { payloads, kind } = resolvePathPayloads(doc);
    if (!payloads.length) {
      cleanupPathOverlay(tile);
      return;
    }

    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;

    ensureMeshTransparent(mesh);

    const containerAlpha = 1;
    const renderKey = buildRenderKey(payloads);

    let container = tile.faNexusPathContainer;
    if (container && !container.destroyed && container.faNexusPathRenderKey === renderKey) {
      if (!container.parent) {
        mesh.addChild(container);
      }
        try { container.alpha = containerAlpha; }
      catch (_) {}
      const prevContainerAlpha = 1;
      const existingMeshes = resolvePathMeshes(container);
      for (const meshPath of existingMeshes) {
        let entryAlpha = Number.isFinite(meshPath?.faNexusPathAlpha) ? Number(meshPath.faNexusPathAlpha) : null;
        if (!Number.isFinite(entryAlpha)) {
          const meshAlpha = Number(meshPath?.alpha);
          const divisor = prevContainerAlpha > 0 ? prevContainerAlpha : 1;
          if (Number.isFinite(meshAlpha)) entryAlpha = meshAlpha / divisor;
        }
        if (!Number.isFinite(entryAlpha)) entryAlpha = 1;
        entryAlpha = Math.min(1, Math.max(0, entryAlpha));
        applyMeshOpacity(meshPath, containerAlpha * entryAlpha);
        if (!Number.isFinite(meshPath?.faNexusPathAlpha)) {
          try { meshPath.faNexusPathAlpha = entryAlpha; } catch (_) {}
        }
      }
      container.faNexusPathContainerAlpha = containerAlpha;
      mesh.faNexusPathContainer = container;
    } else {
      if (!container || container.destroyed) {
        container = new PIXI.Container();
        container.eventMode = 'none';
        container.sortableChildren = false;
        tile.faNexusPathContainer = container;
        mesh.addChild(container);
      } else if (!container.parent) {
        mesh.addChild(container);
      }
      try { container.alpha = containerAlpha; }
      catch (_) {}

      const prevChildren = container.children?.slice() || [];
      container.removeChildren();
      for (const child of prevChildren) {
        try { child.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      const meshPaths = [];
      const textureCache = new Map();
      const visibleCache = new Map();
      const useVisibleRows = kind === 'v2';
      const tileHsbc = readDocumentHsbc(doc, { nullIfMissing: true, nullIfNeutral: true });
      for (const data of payloads) {
        const baseSrc = data?.baseSrc;
        if (!baseSrc) continue;
        let texture = textureCache.get(baseSrc);
        if (!texture) {
          try {
            texture = await loadPathTexture(baseSrc);
            try { texture.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT; }
            catch (_) {}
            textureCache.set(baseSrc, texture);
          } catch (err) {
            Logger.warn('PathGeometry.apply.loadFailed', { error: String(err?.message || err), tileId: doc?.id });
            continue;
          }
        }

        const controlPoints = normalizeControlPoints(data.controlPoints);
        if (controlPoints.length < MIN_POINTS_TO_RENDER) continue;

        let visibleData = null;
        if (useVisibleRows) {
          if (visibleCache.has(baseSrc)) {
            visibleData = visibleCache.get(baseSrc);
          } else {
            visibleData = detectVisibleRows(texture);
            visibleCache.set(baseSrc, visibleData);
          }
        }

        let meshPath = null;
        if (shouldUseWallMesher(controlPoints, data)) {
          meshPath = createWallMesherPathMesh(controlPoints, data, texture, {
            visibleData,
            hsbc: normalizeHsbc(data?.hsbc ?? tileHsbc, null)
          });
        } else {
          const samples = computeSamplesFromPoints(
            controlPoints,
            Number(data.samplesPerSegment) || DEFAULT_SEGMENT_SAMPLES,
            data?.tension,
            { closed: !!data?.closed }
          );
          if (!samples.length) continue;
          meshPath = createMeshFromSamples(
            samples,
            data.width,
            data.repeatSpacing,
              texture,
              {
                textureOffset: data?.textureOffset,
                textureFlip: data?.textureFlip,
                feather: data?.feather,
                opacityFeather: data?.opacityFeather,
                visibleData,
                hsbc: normalizeHsbc(data?.hsbc ?? tileHsbc, null)
              }
            );
        }
        if (!meshPath) continue;

        const entryAlpha = Number.isFinite(data?.layerOpacity) ? Number(data.layerOpacity) : 1;
        applyMeshOpacity(meshPath, containerAlpha * entryAlpha);
        try { meshPath.faNexusPathAlpha = entryAlpha; } catch (_) {}
        container.addChild(meshPath);
        meshPaths.push(meshPath);
      }
      if (!meshPaths.length) {
        cleanupPathOverlay(tile);
        return;
      }
      container.faNexusPathMesh = meshPaths[0] || null;
      if (meshPaths.length > 1) container.faNexusPathMeshes = meshPaths;
      else container.faNexusPathMeshes = null;
      container.faNexusPathRenderKey = renderKey;
      container.faNexusPathContainerAlpha = containerAlpha;
      mesh.faNexusPathContainer = container;
    }

    if (!mesh || mesh.destroyed || !container || container.destroyed) {
      cleanupPathOverlay(tile);
      return;
    }
    syncPathContainerTransform(container, mesh, doc);
    attachCustomTileOverhead(tile, {
      kind: 'path',
      contentContainer: container,
      proxyFactory: createDisplayProxyFactory(container),
      syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
        syncPathContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    invalidateCustomTileOverhead(tile, 'path-refresh');
  } catch (err) {
    Logger.warn('PathGeometry.apply.failed', String(err?.message || err));
  }
}

export function rehydrateAllPathTiles() {
  try {
    if (!canvas?.ready) return;
    const list = Array.isArray(canvas.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of list) {
      try {
        const doc = tile?.document;
        if (shouldSkipV1Runtime(doc)) continue;
        const { payloads } = resolvePathPayloads(doc);
        if (payloads.length) applyPathTile(tile);
        else cleanupPathOverlay(tile);
      } catch (_) {}
    }
  } catch (_) {}
}

export function clearTileMeshWaiters() {
  try { TILE_MESH_WAITERS.clear(); }
  catch (_) {}
}
