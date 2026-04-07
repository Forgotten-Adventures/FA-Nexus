const MODULE_ID = 'fa-nexus';

export const DEFAULT_SHADOW_QUALITY = 'high';

export const SHADOW_QUALITY_CONFIGS = Object.freeze({
  ultra: Object.freeze({
    key: 'ultra',
    label: 'Ultra (8192)',
    maxTextureSize: 8192,
    previewMaxTextureSize: 8192
  }),
  high: Object.freeze({
    key: 'high',
    label: 'High (4096) - recommended',
    maxTextureSize: 4096,
    previewMaxTextureSize: 4096
  }),
  medium: Object.freeze({
    key: 'medium',
    label: 'Medium (2048)',
    maxTextureSize: 2048,
    previewMaxTextureSize: 2048
  }),
  low: Object.freeze({
    key: 'low',
    label: 'Low (1024) - best performance',
    maxTextureSize: 1024,
    previewMaxTextureSize: 1024
  })
});

const LEGACY_SHADOW_QUALITY_ALIASES = Object.freeze({
  chunkedUltra: 'ultra'
});

export const SHADOW_QUALITY_CHOICES = Object.freeze(
  Object.fromEntries(
    Object.values(SHADOW_QUALITY_CONFIGS).map((entry) => [entry.key, entry.label])
  )
);

export function normalizeShadowQualityKey(value, fallback = DEFAULT_SHADOW_QUALITY) {
  const requested = String(value || '').trim();
  const aliased = LEGACY_SHADOW_QUALITY_ALIASES[requested];
  if (aliased && Object.prototype.hasOwnProperty.call(SHADOW_QUALITY_CONFIGS, aliased)) return aliased;
  if (Object.prototype.hasOwnProperty.call(SHADOW_QUALITY_CONFIGS, requested)) return requested;
  return Object.prototype.hasOwnProperty.call(SHADOW_QUALITY_CONFIGS, fallback) ? fallback : DEFAULT_SHADOW_QUALITY;
}

export function getShadowQualityConfig(value, { fallback = DEFAULT_SHADOW_QUALITY } = {}) {
  const key = normalizeShadowQualityKey(value, fallback);
  return SHADOW_QUALITY_CONFIGS[key] || SHADOW_QUALITY_CONFIGS[DEFAULT_SHADOW_QUALITY];
}

export function readShadowQualityConfig({ moduleId = MODULE_ID, fallback = DEFAULT_SHADOW_QUALITY } = {}) {
  try {
    const value = game?.settings?.get?.(moduleId, 'assetDropShadowQuality');
    return getShadowQualityConfig(value, { fallback });
  } catch (_) {
    return getShadowQualityConfig(fallback);
  }
}
