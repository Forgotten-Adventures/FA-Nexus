import { NexusLogger as Logger } from '../core/nexus-logger.js';

const TILE_MESH_WAITERS = new WeakMap();
const TILE_RETRY_TIMERS = new WeakMap();
let TRANSPARENT_TEXTURE = null;
let REHYDRATE_STATE = null;

const TRANSPARENT_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TEXTURE_SCALE_MIN = 0.25;
const TEXTURE_SCALE_MAX = 3;
const DEG_TO_RAD = Math.PI / 180;

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

export function ensureMeshTransparent(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (!mesh.faNexusOriginalTexture) mesh.faNexusOriginalTexture = mesh.texture;
    const placeholder = getTransparentTexture();
    if (mesh.texture !== placeholder) mesh.texture = placeholder;
    if (!Number.isFinite(mesh.alpha)) mesh.alpha = 1;
    mesh.renderable = true;
  } catch (_) {}
}

export function restoreMeshTexture(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (mesh.faNexusOriginalTexture) {
      mesh.texture = mesh.faNexusOriginalTexture;
      mesh.faNexusOriginalTexture = null;
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
      const texture = PIXI.Texture.from(key);
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
    const flags = tile.document.getFlag('fa-nexus', 'maskedTiling');
    const docAlphaRaw = Number(tile?.document?.alpha ?? 1);
    const docAlpha = Number.isFinite(docAlphaRaw) ? Math.min(1, Math.max(0, docAlphaRaw)) : 1;

    const cleanupOverlay = () => {
      try {
        const meshRef = tile?.mesh;
        const cont = meshRef?.faNexusMaskContainer || tile?.faNexusMaskContainer;
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
          if (meshRef.faNexusOriginalTexture) {
            try { meshRef.texture = meshRef.faNexusOriginalTexture; } catch (_) {}
            meshRef.faNexusOriginalTexture = null;
          }
        }
        if (tile) tile.faNexusMaskContainer = null;
      } catch (_) {}
    };

    if (!flags || !flags.baseSrc || !flags.maskSrc) {
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

    ensureMeshTransparent(mesh);

    let reuse = getReusableTextures(tile, flags);
    hidePreview = (!reuse || !reuse.ready) && tile?.isPreview;
    wasVisible = hidePreview ? !!tile.visible : null;
    if (hidePreview && tile.visible) {
      try { tile.visible = false; } catch (_) {}
    }

    let baseTex = reuse?.baseTex || null;
    let maskTex = reuse?.maskTex || null;
    try {
      if (!baseTex || !maskTex) {
        baseTex = await loadTexture(flags.baseSrc);
        maskTex = await loadTexture(flags.maskSrc);
      }
    } catch (texErr) {
      try { Logger.warn('TextureRender.apply.loadFailed', { error: String(texErr?.message || texErr), tileId: tile?.document?.id }); } catch (_) {}
      scheduleMaskedTileRetry(tile, applyMaskedTilingToTile);
      return;
    }

    const meshWidth = Number(mesh?.width);
    const meshHeight = Number(mesh?.height);
    const docWidth = Number(tile?.document?.width);
    const docHeight = Number(tile?.document?.height);
    const w = Math.max(2, Number.isFinite(docWidth) && docWidth > 0 ? docWidth : (Number.isFinite(meshWidth) && meshWidth > 0 ? meshWidth : 2));
    const h = Math.max(2, Number.isFinite(docHeight) && docHeight > 0 ? docHeight : (Number.isFinite(meshHeight) && meshHeight > 0 ? meshHeight : 2));

    let container = mesh.faNexusMaskContainer;
    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      mesh.faNexusMaskContainer = container;
      tile.faNexusMaskContainer = container;
      mesh.addChild(container);
    } else if (container.parent !== mesh) {
      try { container.parent?.removeChild?.(container); } catch (_) {}
      mesh.addChild(container);
      tile.faNexusMaskContainer = container;
    }

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
    try { container.alpha = 1; } catch (_) {}

    if (!maskSprite || !tiling) return;
    try { tiling.alpha = 1; } catch (_) {}
    try { maskSprite.alpha = 1; } catch (_) {}

    const placement = computeMaskPlacement(flags, w, h, maskTex);
    const refreshMaskPlacement = () => {
      try {
        maskSprite.scale.set(placement.scaleX || 1, placement.scaleY || 1);
        maskSprite.position.set(placement.offsetX || 0, placement.offsetY || 0);
        maskSprite.width = w;
        maskSprite.height = h;
      } catch (_) {}
    };

    refreshMaskPlacement();
    applyBaseTilingOffset(tiling, tile, flags);
    try {
      if (typeof tiling._refresh === 'function') tiling._refresh();
      else if (tiling.uvMatrix) tiling.uvMatrix.update();
    } catch (_) {}
    try { mesh.alpha = docAlpha; } catch (_) {}

    container.faNexusMaskSprite = maskSprite;
    container.faNexusTilingSprite = tiling;
    container.faNexusMaskTexture = maskTex;
    container.faNexusBaseTexture = baseTex;
    container.faNexusMaskSrc = flags.maskSrc;
    container.faNexusBaseSrc = flags.baseSrc;

    tiling.mask = maskSprite;

    try {
      const sx = Number(mesh.scale?.x ?? 1) || 1;
      const sy = Number(mesh.scale?.y ?? 1) || 1;
      container.scale.set(1 / sx, 1 / sy);
      const offsetX = -(w / 2) / (sx || 1);
      const offsetY = -(h / 2) / (sy || 1);
      container.position.set(offsetX, offsetY);
    } catch (_) {
      try { container.scale.set(1, 1); } catch (_) {}
      container.position.set(-w / 2, -h / 2);
    }

    try { mesh.faNexusMaskReady = true; } catch (_) {}
  } catch (error) {
    Logger.warn('TextureRender.apply.failed', String(error?.message || error));
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
    if (baseSrc === flags.baseSrc && maskSrc === flags.maskSrc) {
      return {
        baseTex: container.faNexusBaseTexture,
        maskTex: container.faNexusMaskTexture,
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
            if (!tile?.document?.getFlag?.('fa-nexus', 'maskedTiling')) continue;
            jobs.push(applyMaskedTilingToTile(tile));
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
    if (container) {
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) {
      mesh.faNexusMaskContainer = null;
      if (mesh.faNexusOriginalTexture) {
        try { mesh.texture = mesh.faNexusOriginalTexture; } catch (_) {}
        mesh.faNexusOriginalTexture = null;
      }
    }
    if (tile) tile.faNexusMaskContainer = null;
    clearMaskedTileRetry(tile);
  } catch (_) {}
}
