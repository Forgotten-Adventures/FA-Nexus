export const DEFAULT_CHUNKING = Object.freeze({
  preferredMin: 2600,
  preferredMax: 3400,
  hardMax: 4000
});

function normalizeThresholds(overrides = {}) {
  const baseHardMax = Number.isFinite(Number(overrides.hardMax))
    ? Number(overrides.hardMax)
    : DEFAULT_CHUNKING.hardMax;
  const textureMax = Number.isFinite(Number(overrides.maxTextureSize))
    ? Number(overrides.maxTextureSize)
    : null;
  const hardMax = Number.isFinite(textureMax) && textureMax > 0
    ? Math.min(baseHardMax, textureMax)
    : baseHardMax;
  let preferredMax = Number.isFinite(Number(overrides.preferredMax))
    ? Number(overrides.preferredMax)
    : DEFAULT_CHUNKING.preferredMax;
  preferredMax = Math.min(preferredMax, hardMax);
  let preferredMin = Number.isFinite(Number(overrides.preferredMin))
    ? Number(overrides.preferredMin)
    : DEFAULT_CHUNKING.preferredMin;
  preferredMin = Math.min(preferredMin, preferredMax);
  return { preferredMin, preferredMax, hardMax };
}

function resolveDimension(pixelSize, thresholds) {
  const size = Number(pixelSize);
  if (!Number.isFinite(size) || size <= 0) {
    return { count: 1, chunkSize: Math.max(0, size || 0) };
  }
  if (size <= thresholds.hardMax) {
    return { count: 1, chunkSize: size };
  }

  let count = Math.ceil(size / thresholds.hardMax);
  let chunkSize = size / count;

  if (chunkSize > thresholds.preferredMax) {
    const altCount = Math.ceil(size / thresholds.preferredMax);
    const altChunk = size / altCount;
    if (altChunk >= thresholds.preferredMin) {
      count = altCount;
      chunkSize = altChunk;
    }
  }

  return { count, chunkSize };
}

export function resolveAutoChunking(pixelWidth, pixelHeight, overrides = {}) {
  const thresholds = normalizeThresholds(overrides);
  const widthPlan = resolveDimension(pixelWidth, thresholds);
  const heightPlan = resolveDimension(pixelHeight, thresholds);
  const columns = Math.max(1, widthPlan.count);
  const rows = Math.max(1, heightPlan.count);
  const enabled = columns > 1 || rows > 1;
  const width = Number(pixelWidth);
  const height = Number(pixelHeight);
  const chunkPixelWidth = Number.isFinite(width) && width > 0 ? (width / columns) : 0;
  const chunkPixelHeight = Number.isFinite(height) && height > 0 ? (height / rows) : 0;
  return {
    enabled,
    columns,
    rows,
    chunkPixelWidth,
    chunkPixelHeight,
    thresholds
  };
}
