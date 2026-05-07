import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { getOrCreatePixiTexture } from '../core/foundry-texture-loader-patch.js';
import {
  waitForTileMesh,
  clearTileMeshWaiters as clearSharedTileMeshWaiters
} from '../canvas/tile-mesh-waiter.js';

const SHARED_TEXTURE_CACHE = new Map();
let TRANSPARENT_TEXTURE = null;

const TRANSPARENT_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const LEGACY_ORIGINAL_TEXTURE_KEY = 'faNexusOriginalTexture';
const FLATTENED_FLAG = 'flattened';

function isTextureUsable(texture) {
  if (!texture || texture.destroyed) return false;
  const base = texture.baseTexture;
  if (!base || base.destroyed) return false;
  if (base.valid === false) return false;
  return true;
}

export function getMaxTextureSize() {
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

export function encodeTexturePath(path) {
  if (!path) return path;
  if (/^https?:/i.test(path)) return path;
  try { return encodeURI(decodeURI(String(path))); }
  catch (_) {
    try { return encodeURI(String(path)); }
    catch { return path; }
  }
}

export function getSharedTexture(src) {
  if (!src) return null;
  const encoded = encodeTexturePath(src);
  const cached = SHARED_TEXTURE_CACHE.get(encoded);
  if (cached) {
    if (isTextureUsable(cached)) return cached;
    SHARED_TEXTURE_CACHE.delete(encoded);
  }
  const texture = getOrCreatePixiTexture(encoded);
  SHARED_TEXTURE_CACHE.set(encoded, texture);
  return texture;
}

export function clearSharedTextureCache() {
  const count = SHARED_TEXTURE_CACHE.size;
  try { SHARED_TEXTURE_CACHE.clear(); }
  catch (error) { Logger.warn('TextureRender.sharedTextureCache.clearFailed', String(error?.message || error)); }
  Logger.debug?.('TextureRender.sharedTextureCache.cleared', { count });
  return count;
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
  return waitForTileMesh(tile, {
    ...options,
    scope: 'TextureRender.ensureTileMesh'
  });
}

export function clearTileMeshWaiters() {
  clearSharedTileMeshWaiters('TextureRender.clearTileMeshWaiters');
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
      if (ok) {
        if (canBust) SHARED_TEXTURE_CACHE.set(encoded, texture);
        return texture;
      }
      lastError = new Error('Texture base texture invalid');
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts) await sleep(150 * attempt);
  }
  throw lastError || new Error(`Texture failed to load: ${src}`);
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
