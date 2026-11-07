export const MIN_SCALE = 0.1;
export const MAX_SCALE = 2.5;
export const DEFAULT_SCALE = 1;
export const DEFAULT_ROTATION = 0;
export const DEFAULT_SCALE_RANDOM_MIN = 80;
export const DEFAULT_SCALE_RANDOM_MAX = 120;
export const DEFAULT_ROTATION_RANDOM_MIN = 0;
export const DEFAULT_ROTATION_RANDOM_MAX = 359;
export const ASSET_SCATTER_MODE_SINGLE = 'single';
export const ASSET_SCATTER_MODE_BRUSH = 'scatter';
export const SCATTER_TRANSFORM_INIT_SETTING = 'assetScatterPlacementTransformsInitialized';

const SCALE_RANDOM_DELTA = 20;

export const SCATTER_PLACEMENT_TRANSFORM_SETTINGS = Object.freeze({
  assetPlacementScale: 'assetScatterPlacementScale',
  assetPlacementScaleRandomEnabled: 'assetScatterPlacementScaleRandomEnabled',
  assetPlacementScaleRandomMin: 'assetScatterPlacementScaleRandomMin',
  assetPlacementScaleRandomMax: 'assetScatterPlacementScaleRandomMax',
  assetPlacementRotation: 'assetScatterPlacementRotation',
  assetPlacementRotationRandomEnabled: 'assetScatterPlacementRotationRandomEnabled',
  assetPlacementRotationRandomMin: 'assetScatterPlacementRotationRandomMin',
  assetPlacementRotationRandomMax: 'assetScatterPlacementRotationRandomMax',
  assetPlacementFlipHorizontal: 'assetScatterPlacementFlipHorizontal',
  assetPlacementFlipVertical: 'assetScatterPlacementFlipVertical',
  assetPlacementFlipRandomHorizontal: 'assetScatterPlacementFlipRandomHorizontal',
  assetPlacementFlipRandomVertical: 'assetScatterPlacementFlipRandomVertical'
});

export function normalizePlacementTransformMode(mode) {
  return mode === ASSET_SCATTER_MODE_BRUSH ? ASSET_SCATTER_MODE_BRUSH : ASSET_SCATTER_MODE_SINGLE;
}

export function resolvePlacementTransformSettingKey(key, { mode = ASSET_SCATTER_MODE_SINGLE } = {}) {
  const rawKey = String(key || '');
  if (!rawKey) return '';
  if (normalizePlacementTransformMode(mode) !== ASSET_SCATTER_MODE_BRUSH) return rawKey;
  return SCATTER_PLACEMENT_TRANSFORM_SETTINGS[rawKey] || rawKey;
}

export function normalizePlacementRotation(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return ((num % 360) + 360) % 360;
}

export function clampPlacementRotationRandomValue(value, fallback = DEFAULT_ROTATION_RANDOM_MIN) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(359, Math.max(0, Math.round(numeric)));
}

export function getPlacementRotationRandomRange(minValue, maxValue) {
  const min = clampPlacementRotationRandomValue(minValue, DEFAULT_ROTATION_RANDOM_MIN);
  const max = clampPlacementRotationRandomValue(maxValue, DEFAULT_ROTATION_RANDOM_MAX);
  return min <= max ? { min, max } : { min: max, max: min };
}

export function samplePlacementRotationRandomValue(minValue, maxValue, randomFn = Math.random) {
  const range = getPlacementRotationRandomRange(minValue, maxValue);
  if (range.max <= range.min) return range.min;
  return range.min + Math.floor(randomFn() * (range.max - range.min + 1));
}

export function samplePlacementRotationPreviewValue({
  baseRotation = DEFAULT_ROTATION,
  randomEnabled = false,
  minValue = DEFAULT_ROTATION_RANDOM_MIN,
  maxValue = DEFAULT_ROTATION_RANDOM_MAX,
  randomFn = Math.random
} = {}) {
  const base = normalizePlacementRotation(baseRotation);
  if (!randomEnabled) return base;
  return samplePlacementRotationRandomValue(minValue, maxValue, randomFn);
}

export function clampPlacementScale(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, num));
}

export function clampPlacementScaleRandomPercent(value, fallback = DEFAULT_SCALE_RANDOM_MIN) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(250, Math.max(10, Math.round(numeric)));
}

export function getDefaultPlacementScaleRandomRange(baseScale = DEFAULT_SCALE) {
  const basePercent = Math.round(clampPlacementScale(baseScale) * 100);
  const min = clampPlacementScaleRandomPercent(basePercent - SCALE_RANDOM_DELTA, DEFAULT_SCALE_RANDOM_MIN);
  const max = clampPlacementScaleRandomPercent(basePercent + SCALE_RANDOM_DELTA, DEFAULT_SCALE_RANDOM_MAX);
  return min <= max ? { min, max } : { min: max, max: min };
}

export function getPlacementScaleRandomRange(minValue, maxValue) {
  const min = clampPlacementScaleRandomPercent(minValue, DEFAULT_SCALE_RANDOM_MIN);
  const max = clampPlacementScaleRandomPercent(maxValue, DEFAULT_SCALE_RANDOM_MAX);
  return min <= max ? { min, max } : { min: max, max: min };
}

export function samplePlacementScaleRandomValue(minValue, maxValue, randomFn = Math.random) {
  const range = getPlacementScaleRandomRange(minValue, maxValue);
  const percent = range.max <= range.min
    ? range.min
    : (range.min + Math.floor(randomFn() * (range.max - range.min + 1)));
  return clampPlacementScale(percent / 100);
}

export function samplePlacementScalePreviewValue({
  baseScale = DEFAULT_SCALE,
  randomEnabled = false,
  minValue = DEFAULT_SCALE_RANDOM_MIN,
  maxValue = DEFAULT_SCALE_RANDOM_MAX,
  randomFn = Math.random
} = {}) {
  const base = clampPlacementScale(baseScale);
  if (!randomEnabled) return base;
  const range = getPlacementScaleRandomRange(minValue, maxValue);
  const minScale = clampPlacementScale(range.min / 100);
  const maxScale = clampPlacementScale(range.max / 100);
  if (maxScale <= minScale) return minScale;
  return minScale + (randomFn() * (maxScale - minScale));
}

export function samplePlacementFlipState({
  baseHorizontal = false,
  baseVertical = false,
  randomHorizontalEnabled = false,
  randomVerticalEnabled = false,
  randomFn = Math.random
} = {}) {
  const horizontal = !!baseHorizontal;
  const vertical = !!baseVertical;
  return {
    horizontal: randomHorizontalEnabled ? (randomFn() < 0.5 ? !horizontal : horizontal) : horizontal,
    vertical: randomVerticalEnabled ? (randomFn() < 0.5 ? !vertical : vertical) : vertical
  };
}

export function formatPlacementFlipSummary(state) {
  const horizontal = !!state?.horizontal;
  const vertical = !!state?.vertical;
  if (horizontal && vertical) return 'H & V';
  if (horizontal) return 'H';
  if (vertical) return 'V';
  return 'None';
}
