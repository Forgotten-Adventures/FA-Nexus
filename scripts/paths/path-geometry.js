import { NexusLogger as Logger } from '../core/nexus-logger.js';

export const DEFAULT_SEGMENT_SAMPLES = 200;
export const MIN_POINTS_TO_RENDER = 2;
export const MIN_WIDTH_MULTIPLIER = 0.01;
export const MAX_WIDTH_MULTIPLIER = 5;
const FEATHER_GROW_MULTIPLIER = 1.5;

const TILE_MESH_WAITERS = new WeakMap();
let TRANSPARENT_TEXTURE = null;
let PATH_PROGRAM = null;

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

export function computeSamplesFromPoints(points, sampleCount = DEFAULT_SEGMENT_SAMPLES, tension = 0, options = {}) {
  if (!Array.isArray(points) || points.length < MIN_POINTS_TO_RENDER) return [];
  const closed = !!options.closed && points.length >= MIN_POINTS_TO_RENDER;
  const samples = [];
  let lastPos = null;
  let totalDistance = 0;
  const segments = Math.max(2, sampleCount);
  const normalizedTension = normalizeTension(tension);
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
    const segSamples = sampleSegment(p0, p1, p2, p3, i, segments, normalizedTension, startWidth, endWidth);
    for (let j = 0; j < segSamples.length; j++) {
      const sample = segSamples[j];
      if (!sample) continue;
      if (lastPos && j === 0 && i > 0) continue;
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

      // Translate the strip by the Y offset so the whole texture slides instead of wrapping.
      const centerX = sample.x + (normal.x * offsetY);
      const centerY = sample.y + (normal.y * offsetY);
      if (lastCenter) {
        const dx = centerX - lastCenter.x;
        const dy = centerY - lastCenter.y;
        offsetDistance += Math.hypot(dx, dy);
      }
      lastCenter = { x: centerX, y: centerY };
      const mappedDistance = offsetDistance;
      const leftX = centerX + normal.x * halfWidth;
      const leftY = centerY + normal.y * halfWidth;
      const rightX = centerX - normal.x * halfWidth;
      const rightY = centerY - normal.y * halfWidth;

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

    const shader = createPathShader(texture);
    const mesh = new PIXI.Mesh(geometry, shader);
    try { mesh.state.blendMode = PIXI.BLEND_MODES.NORMAL; }
    catch (_) {}
    mesh.eventMode = 'none';
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
      const texture = PIXI.Texture.from(key);
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

export async function applyPathTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    const data = doc?.getFlag?.('fa-nexus', 'path');
    if (!data || !Array.isArray(data.controlPoints) || !data.baseSrc) {
      cleanupPathOverlay(tile);
      return;
    }

    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;

    ensureMeshTransparent(mesh);

    let texture = null;
    try {
      texture = await loadPathTexture(data.baseSrc);
      try { texture.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT; }
      catch (_) {}
    }
    catch (err) {
      Logger.warn('PathGeometry.apply.loadFailed', { error: String(err?.message || err), tileId: doc?.id });
      return;
    }

    const controlPointsRaw = data.controlPoints || [];
    const controlPoints = controlPointsRaw.map((p) => {
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
    if (controlPoints.length < MIN_POINTS_TO_RENDER) {
      cleanupPathOverlay(tile);
      return;
    }

    const samples = computeSamplesFromPoints(
      controlPoints,
      Number(data.samplesPerSegment) || DEFAULT_SEGMENT_SAMPLES,
      data?.tension,
      { closed: !!data?.closed }
    );
    if (!samples.length) {
      cleanupPathOverlay(tile);
      return;
    }

    const meshPath = createMeshFromSamples(
      samples,
      data.width,
      data.repeatSpacing,
      texture,
      {
        textureOffset: data?.textureOffset,
        textureFlip: data?.textureFlip,
        feather: data?.feather,
        opacityFeather: data?.opacityFeather
      }
    );
    if (!meshPath) {
      cleanupPathOverlay(tile);
      return;
    }

    let container = tile.faNexusPathContainer;
    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      tile.faNexusPathContainer = container;
      mesh.addChild(container);
    } else if (container.parent !== mesh) {
      try { container.parent?.removeChild?.(container); } catch (_) {}
      mesh.addChild(container);
    }

    const docAlpha = Number(doc?.alpha);
    const containerAlpha = Number.isFinite(docAlpha) ? Math.min(1, Math.max(0, docAlpha)) : 1;
    try { container.alpha = containerAlpha; }
    catch (_) {}

    const prevChildren = container.children?.slice() || [];
    container.removeChildren();
    for (const child of prevChildren) {
      try { child.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    }
    container.addChild(meshPath);
    applyMeshOpacity(meshPath, containerAlpha);
    container.faNexusPathMesh = meshPath;
    mesh.faNexusPathContainer = container;

    const docWidth = Math.max(1, Number(doc?.width) || 0) || Math.max(1, Number(mesh?.width) || 1);
    const docHeight = Math.max(1, Number(doc?.height) || 0) || Math.max(1, Number(mesh?.height) || 1);
    const sx = Number(mesh.scale?.x ?? 1) || 1;
    const sy = Number(mesh.scale?.y ?? 1) || 1;
    container.scale.set(1 / sx, 1 / sy);
    container.position.set(-(docWidth / 2) / (sx || 1), -(docHeight / 2) / (sy || 1));
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
        const data = tile?.document?.getFlag?.('fa-nexus', 'path');
        if (data) applyPathTile(tile);
        else cleanupPathOverlay(tile);
      } catch (_) {}
    }
  } catch (_) {}
}

export function clearTileMeshWaiters() {
  try { TILE_MESH_WAITERS.clear(); }
  catch (_) {}
}
