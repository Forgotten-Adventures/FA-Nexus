const GET_CACHE_PATCH_KEY = '__faNexusTextureLoaderGetCachePatched';
const LOAD_TEXTURE_PATCH_KEY = '__faNexusTextureLoaderLoadTexturePatched';

function unwrapCachedTexture(candidate) {
  try {
    if (!candidate || candidate.destroyed) return null;
    if (candidate instanceof PIXI.Texture) {
      return candidate.destroyed ? null : candidate;
    }
    const directTexture = candidate?.texture;
    if (directTexture instanceof PIXI.Texture && !directTexture.destroyed) {
      return directTexture;
    }
    const baseTexture = (
      (candidate instanceof PIXI.BaseTexture) ? candidate : null
    ) || candidate?.baseTexture || null;
    if (baseTexture && !baseTexture.destroyed) {
      try { return new PIXI.Texture(baseTexture); } catch (_) {}
    }
  } catch (_) {}
  return null;
}

export function getCachedPixiTexture(key) {
  if (!key) return null;

  const candidates = [];
  try { candidates.push(PIXI?.Assets?.get?.(key)); } catch (_) {}
  try { candidates.push(PIXI?.Cache?.get?.(key)); } catch (_) {}
  try {
    const textureCache = PIXI?.utils?.TextureCache || PIXI?.TextureCache || null;
    if (textureCache && Object.prototype.hasOwnProperty.call(textureCache, key)) {
      candidates.push(textureCache[key]);
    }
  } catch (_) {}
  try {
    const baseTextureCache = PIXI?.utils?.BaseTextureCache || PIXI?.BaseTextureCache || null;
    if (baseTextureCache && Object.prototype.hasOwnProperty.call(baseTextureCache, key)) {
      candidates.push(baseTextureCache[key]);
    }
  } catch (_) {}

  for (const candidate of candidates) {
    const texture = unwrapCachedTexture(candidate);
    if (texture) return texture;
  }
  return null;
}

export function getOrCreatePixiTexture(key) {
  const cached = getCachedPixiTexture(key);
  if (cached) return cached;
  return PIXI.Texture.from(key);
}

function resolveTextureLoader() {
  try {
    return globalThis?.foundry?.canvas?.TextureLoader?.loader
      || globalThis?.TextureLoader?.loader
      || null;
  } catch (_) {
    return null;
  }
}

function normalizeCachedAsset(src) {
  if (!src) return null;
  try {
    const texture = getCachedPixiTexture(src);
    const baseTexture = texture?.baseTexture || null;
    if (baseTexture?.valid && !baseTexture.destroyed) return baseTexture;
  } catch (_) {}
  return null;
}

function patchTextureLoaderGetCache(loader) {
  if (!loader || loader[GET_CACHE_PATCH_KEY]) return false;
  const originalGetCache = loader.getCache;
  if (typeof originalGetCache !== 'function') return false;

  loader.getCache = function faNexusPatchedGetCache(src, ...args) {
    const asset = originalGetCache.call(this, src, ...args);
    const baseTexture = asset instanceof PIXI?.Spritesheet ? asset.baseTexture : asset;
    if (baseTexture?.valid && !baseTexture?.destroyed) return asset;

    const cachedAsset = normalizeCachedAsset(src);
    if (!cachedAsset) return asset;
    try { this.setCache?.(src, cachedAsset); } catch (_) {}
    return cachedAsset;
  };

  loader[GET_CACHE_PATCH_KEY] = true;
  loader.__faNexusOriginalGetCache = originalGetCache;
  return true;
}

function patchTextureLoaderLoadTexture(loader) {
  if (!loader || loader[LOAD_TEXTURE_PATCH_KEY]) return false;
  const originalLoadTexture = loader.loadTexture;
  if (typeof originalLoadTexture !== 'function') return false;

  loader.loadTexture = async function faNexusPatchedLoadTexture(src, ...args) {
    try {
      const asset = this.getCache?.(src);
      const baseTexture = asset instanceof PIXI?.Spritesheet ? asset.baseTexture : asset;
      if (baseTexture?.valid && !baseTexture?.destroyed) return asset;
    } catch (_) {}
    return await originalLoadTexture.call(this, src, ...args);
  };

  loader[LOAD_TEXTURE_PATCH_KEY] = true;
  loader.__faNexusOriginalLoadTexture = originalLoadTexture;
  return true;
}

export function installFoundryTextureLoaderCachePatch() {
  const loader = resolveTextureLoader();
  if (!loader) return false;
  patchTextureLoaderGetCache(loader);
  patchTextureLoaderLoadTexture(loader);
  return true;
}

installFoundryTextureLoaderCachePatch();

try { Hooks.once('init', () => installFoundryTextureLoaderCachePatch()); } catch (_) {}
try { Hooks.once('ready', () => installFoundryTextureLoaderCachePatch()); } catch (_) {}
