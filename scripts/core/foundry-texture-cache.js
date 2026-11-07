const TEXTURE_VIEWS = new WeakMap();
const OWNED_RECOVERY_ASSETS = new Map();
let RECOVERY_LOAD_GENERATION = 0;

function getCachedAssetKey(src) {
  const cache = globalThis?.PIXI?.Assets?.cache;
  if (typeof cache?.has !== 'function') throw new Error('PIXI.Assets cache is unavailable.');
  if (cache.has(src)) return src;

  const getCacheBustURL = globalThis?.foundry?.utils?.getCacheBustURL;
  const cacheBustSrc = typeof getCacheBustURL === 'function' ? getCacheBustURL(src) : null;
  return cacheBustSrc && cache.has(cacheBustSrc) ? cacheBustSrc : null;
}

function getTextureAliases(src) {
  const aliases = new Set([src]);
  const cacheBustSrc = foundry.utils.getCacheBustURL(src);
  if (cacheBustSrc) aliases.add(cacheBustSrc);
  for (const alias of [...aliases]) {
    const resolved = PIXI.Assets.resolver.resolve(alias);
    if (typeof resolved === 'string') aliases.add(resolved);
    else if (resolved?.src) aliases.add(resolved.src);
    try { aliases.add(new URL(alias, document.baseURI).href); } catch (_) {}
  }
  return aliases;
}

function normalizeTexture(candidate) {
  if (!candidate || candidate.destroyed) return null;
  if (candidate instanceof PIXI.Texture) {
    const baseTexture = candidate.baseTexture;
    return baseTexture && !baseTexture.destroyed && baseTexture.valid !== false ? candidate : null;
  }

  const baseTexture = candidate instanceof PIXI.BaseTexture
    ? candidate
    : candidate.baseTexture;
  if (!baseTexture || baseTexture.destroyed || baseTexture.valid === false) return null;
  const existing = TEXTURE_VIEWS.get(baseTexture);
  if (existing && !existing.destroyed) return existing;
  const texture = new PIXI.Texture(baseTexture);
  TEXTURE_VIEWS.set(baseTexture, texture);
  return texture;
}

function adoptLegacyCachedTexture(src) {
  for (const alias of getTextureAliases(src)) {
    const legacyTexture = PIXI.utils.TextureCache[alias];
    if (legacyTexture) {
      const texture = normalizeTexture(legacyTexture);
      if (texture) {
        PIXI.Assets.cache.set(src, texture);
        return texture;
      }
      PIXI.Texture.removeFromCache(alias);
    }

    const legacyBaseTexture = PIXI.utils.BaseTextureCache[alias];
    if (legacyBaseTexture) {
      const texture = normalizeTexture(legacyBaseTexture);
      if (texture) {
        PIXI.Assets.cache.set(src, texture);
        return texture;
      }
      PIXI.BaseTexture.removeFromCache(alias);
    }
  }
  return null;
}

async function unloadInvalidAsset(cacheKey, candidate) {
  const baseTexture = candidate instanceof PIXI.BaseTexture
    ? candidate
    : candidate?.baseTexture;
  PIXI.Texture.removeFromCache(candidate);
  PIXI.BaseTexture.removeFromCache(baseTexture);
  await PIXI.Assets.unload(cacheKey);
}

export function getCachedFoundryTexture(src) {
  if (!src) return null;
  const cacheKey = getCachedAssetKey(src);
  const texture = cacheKey
    ? normalizeTexture(PIXI.Assets.get(cacheKey))
    : adoptLegacyCachedTexture(src);
  return texture;
}

export async function loadFoundryTexture(src, { assetAlias = null, resourceOptions = null } = {}) {
  if (!src) throw new Error('Missing texture source.');
  const cacheKey = getCachedAssetKey(src);
  if (cacheKey) {
    const candidate = PIXI.Assets.get(cacheKey);
    const cached = normalizeTexture(candidate);
    if (cached) return cached;
    await unloadInvalidAsset(cacheKey, candidate);
  }

  const legacyTexture = adoptLegacyCachedTexture(src);
  if (legacyTexture) return legacyTexture;

  // Nexus owns the lifetime of its custom render sources; use the canonical Pixi cache
  // without enrolling them in Foundry's scene-texture TTL accounting.
  const loadAsset = resourceOptions || assetAlias
    ? {
      alias: assetAlias || `fa-nexus-texture:${src}`,
      src,
      ...(resourceOptions ? { data: { resourceOptions } } : {})
    }
    : src;
  const texture = normalizeTexture(await PIXI.Assets.load(loadAsset));
  if (!texture) throw new Error(`PIXI.Assets returned an invalid texture for ${src}`);
  return texture;
}

export async function recoverFoundryTexture(src, options = {}) {
  if (!src) throw new Error('Missing texture source.');
  const previousOwned = OWNED_RECOVERY_ASSETS.get(src) || null;
  const aliases = new Set(getTextureAliases(src));
  if (previousOwned?.alias) aliases.add(previousOwned.alias);
  if (previousOwned?.source) aliases.add(previousOwned.source);
  for (const alias of aliases) {
    if (PIXI.Assets.cache.has(alias)) {
      await unloadInvalidAsset(alias, PIXI.Assets.get(alias));
    }
    PIXI.Texture.removeFromCache(alias);
    PIXI.BaseTexture.removeFromCache(alias);
    if (
      PIXI.Assets.cache.has(alias)
      || PIXI.utils.TextureCache[alias]
      || PIXI.utils.BaseTextureCache[alias]
    ) {
      throw new Error(`Failed to evict stale texture cache alias ${alias}`);
    }
  }
  RECOVERY_LOAD_GENERATION += 1;
  const recoveryAlias = `fa-nexus-recovery:${RECOVERY_LOAD_GENERATION}:${encodeURIComponent(src)}`;
  const cacheBustSrc = foundry.utils.getCacheBustURL(src);
  const recoverySrc = cacheBustSrc || `${src}${String(src).includes('#') ? '&' : '#'}faNexusRecovery=${RECOVERY_LOAD_GENERATION}`;
  OWNED_RECOVERY_ASSETS.set(src, { alias: recoveryAlias, source: recoverySrc });
  return await loadFoundryTexture(recoverySrc, { ...options, assetAlias: recoveryAlias });
}
