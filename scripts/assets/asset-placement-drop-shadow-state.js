export const DEFAULT_SHADOW_OFFSET_MAX = 40;
export const MIN_SHADOW_OFFSET_MAX = 1;
export const SHADOW_OFFSET_MAX_CEILING = 512;
export const MAX_SHADOW_DILATION = 20;
export const MAX_SHADOW_BLUR = 12;
export const SHADOW_PRESET_COUNT = 5;
export const DEFAULT_SHADOW_SETTINGS = Object.freeze({
  alpha: 0.65,
  dilation: 1.6,
  blur: 1.8,
  offsetDistance: 0,
  offsetAngle: 135
});

const SHADOW_COMPARE_EPSILON = 0.0005;
const DROP_SHADOW_CONTROL_CONFIG = Object.freeze({
  alpha: Object.freeze({ settingKey: 'assetDropShadowAlpha', min: 0, max: 100, percent: true }),
  dilation: Object.freeze({ settingKey: 'assetDropShadowDilation', min: 0, max: MAX_SHADOW_DILATION }),
  blur: Object.freeze({ settingKey: 'assetDropShadowBlur', min: 0, max: MAX_SHADOW_BLUR }),
  offsetDistance: Object.freeze({ settingKey: 'assetDropShadowOffsetDistance', min: 0, offsetMax: true }),
  offsetAngle: Object.freeze({ settingKey: 'assetDropShadowOffsetAngle', angle: true })
});

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function formatElevationValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  const rounded = Math.round(numeric * 1000) / 1000;
  const normalized = Number(rounded.toFixed(3));
  const safeValue = Object.is(normalized, -0) ? 0 : normalized;
  return safeValue.toString();
}

function createCurrentShadowSnapshot(settings = {}, normalized = {}) {
  const offsetDistance = normalized.offsetDistanceChanged
    ? normalized.offsetDistance
    : settings.offsetDistance;
  const offsetAngle = normalized.offsetAngleChanged
    ? normalized.offsetAngle
    : settings.offsetAngle;
  return {
    alpha: Number(settings.alpha || 0),
    dilation: Number(settings.dilation || 0),
    blur: Number(settings.blur || 0),
    offsetDistance: Number(offsetDistance || 0),
    offsetAngle: normalizeShadowAngle(offsetAngle || 0)
  };
}

export function normalizeShadowAngle(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  let normalized = numeric % 360;
  if (normalized < 0) normalized += 360;
  return normalized;
}

export function clampShadowOffsetMax(value, fallback = DEFAULT_SHADOW_OFFSET_MAX) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(SHADOW_OFFSET_MAX_CEILING, Math.max(MIN_SHADOW_OFFSET_MAX, numeric));
}

export function normalizeShadowSnapshot(snapshot, { maxOffsetDistance = DEFAULT_SHADOW_OFFSET_MAX } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const alpha = Number(snapshot.alpha);
  const dilation = Number(snapshot.dilation);
  const blur = Number(snapshot.blur);
  const offsetDistance = Number(snapshot.offsetDistance);
  const offsetAngle = Number(snapshot.offsetAngle);
  if (!Number.isFinite(alpha) || !Number.isFinite(dilation) || !Number.isFinite(blur) || !Number.isFinite(offsetDistance) || !Number.isFinite(offsetAngle)) {
    return null;
  }
  return {
    alpha: Math.min(1, Math.max(0, alpha)),
    dilation: Math.min(MAX_SHADOW_DILATION, Math.max(0, dilation)),
    blur: Math.min(MAX_SHADOW_BLUR, Math.max(0, blur)),
    offsetDistance: Math.min(clampShadowOffsetMax(maxOffsetDistance), Math.max(0, offsetDistance)),
    offsetAngle: normalizeShadowAngle(offsetAngle)
  };
}

export function resolveDropShadowControlChange(control, value, currentValue, {
  commit = false,
  maxOffsetDistance = DEFAULT_SHADOW_OFFSET_MAX
} = {}) {
  const config = DROP_SHADOW_CONTROL_CONFIG[control];
  if (!config) throw new Error(`Unknown drop-shadow control: ${control}`);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return {
      ok: false,
      control,
      settingKey: config.settingKey,
      value: null,
      changed: false,
      shouldApply: false
    };
  }
  const max = config.offsetMax
    ? clampShadowOffsetMax(maxOffsetDistance)
    : config.max;
  const nextValue = config.angle
    ? normalizeShadowAngle(numeric)
    : clampNumber(numeric, config.min, max) / (config.percent ? 100 : 1);
  const current = Number(currentValue);
  const changed = !Number.isFinite(current) || Math.abs(nextValue - current) >= SHADOW_COMPARE_EPSILON;
  return {
    ok: true,
    control,
    settingKey: config.settingKey,
    value: nextValue,
    changed,
    shouldApply: changed || !!commit
  };
}

export function compareShadowSnapshots(a, b) {
  if (!a || !b) return false;
  const approx = (x, y, tol = SHADOW_COMPARE_EPSILON) => Math.abs(Number(x || 0) - Number(y || 0)) <= tol;
  if (!approx(a.alpha, b.alpha)) return false;
  if (!approx(a.dilation, b.dilation)) return false;
  if (!approx(a.blur, b.blur)) return false;
  if (!approx(a.offsetDistance, b.offsetDistance)) return false;
  const angleA = normalizeShadowAngle(a.offsetAngle);
  const angleB = normalizeShadowAngle(b.offsetAngle);
  const angleDelta = Math.abs(angleA - angleB) % 360;
  return angleDelta <= 0.1 || angleDelta >= 359.9;
}

export function buildDropShadowPresetState(currentSnapshot, presets = [], { presetCount = SHADOW_PRESET_COUNT } = {}) {
  const presetList = Array.isArray(presets) ? presets : [];
  const list = [];
  let matchedIndex = -1;
  for (let i = 0; i < presetCount; i += 1) {
    const preset = presetList[i] || null;
    const saved = !!preset;
    const active = saved && compareShadowSnapshots(currentSnapshot, preset);
    if (active && matchedIndex === -1) matchedIndex = i;
    const indexLabel = String(i + 1);
    const tooltipParts = [];
    if (saved) {
      tooltipParts.push(`Click to apply preset ${indexLabel}.`);
      tooltipParts.push('Shift+Click to overwrite with current settings.');
    } else {
      tooltipParts.push(`Shift+Click to save current settings into slot ${indexLabel}.`);
      tooltipParts.push('Click to apply once saved.');
    }
    list.push({
      index: i,
      label: indexLabel,
      saved,
      active,
      tooltip: tooltipParts.join(' ')
    });
  }
  return { list, matchedIndex };
}

export function buildDropShadowContextState({
  elevation = 0,
  context = null,
  formatElevation = formatElevationValue
} = {}) {
  const resolvedElevation = Number(elevation ?? 0) || 0;
  const ctx = context || { elevation: resolvedElevation, tileCount: 0, hasTiles: false, source: 'default' };
  const display = formatElevation(resolvedElevation);
  const tileCount = Number(ctx.tileCount || 0);
  const hasTiles = !!ctx.hasTiles && tileCount > 0;
  const source = ctx.source || (hasTiles ? 'existing' : 'default');
  const mixedOffsets = !!ctx.mixedOffsets;
  const mixedSpread = !!ctx.mixedDilation;
  let status;
  if (hasTiles) {
    const assetText = tileCount === 1 ? '1 asset' : `${tileCount} assets`;
    if (mixedOffsets || mixedSpread) {
      const mixedDetails = [
        mixedSpread ? 'spread' : null,
        mixedOffsets ? 'offset' : null
      ].filter(Boolean).join(' & ');
      status = `Mixed ${mixedDetails} settings across ${assetText}.`;
    } else {
      status = source === 'existing'
        ? `Matched ${assetText} on this elevation.`
        : `Synced with ${assetText} on this elevation.`;
    }
  } else {
    status = 'No assets on this elevation yet.';
  }
  const note = 'Blur & opacity follow elevation; offset & spread can be per asset.';
  return {
    display,
    status,
    note,
    tileCount,
    hasTiles,
    source
  };
}

export function buildDropShadowControlsState({
  available = false,
  enabled = false,
  collapsed = false,
  settings = {},
  offsetMax = DEFAULT_SHADOW_OFFSET_MAX,
  previewSource = null,
  shadowOnlyEnabled = false,
  presets = [],
  context = null
} = {}) {
  const allowed = !!available;
  const active = !!enabled;
  const disabled = !(allowed && active);
  const maxDistance = clampShadowOffsetMax(offsetMax);
  const alphaPercent = clampNumber(Number(settings.alpha) * 100, 0, 100);
  const dilation = clampNumber(settings.dilation, 0, MAX_SHADOW_DILATION);
  const blur = clampNumber(settings.blur, 0, MAX_SHADOW_BLUR);
  const offsetDistance = clampNumber(settings.offsetDistance, 0, maxDistance);
  const offsetAngle = normalizeShadowAngle(settings.offsetAngle);
  const offsetDistanceChanged = Math.abs(offsetDistance - Number(settings.offsetDistance)) > SHADOW_COMPARE_EPSILON;
  const offsetAngleChanged = Math.abs(offsetAngle - Number(settings.offsetAngle)) > SHADOW_COMPARE_EPSILON;
  const distanceDisplay = Math.abs(offsetDistance - Math.round(offsetDistance)) < 0.05
    ? `${Math.round(offsetDistance)}`
    : offsetDistance.toFixed(1);
  const angleDisplay = Math.round(offsetAngle);
  const currentSnapshot = createCurrentShadowSnapshot(settings, {
    offsetDistance,
    offsetAngle,
    offsetDistanceChanged,
    offsetAngleChanged
  });
  const presetState = buildDropShadowPresetState(currentSnapshot, presets);
  const preview = previewSource
    ? {
        src: previewSource.src,
        width: previewSource.width,
        height: previewSource.height,
        alt: previewSource.alt || 'Asset drop shadow preview'
      }
    : null;
  return {
    state: {
      available: allowed,
      disabled,
      collapsed: !!collapsed,
      activePreset: presetState.matchedIndex,
      presets: presetState.list,
      alpha: {
        label: 'Opacity',
        value: Math.round(alphaPercent),
        min: 0,
        max: 100,
        step: 1,
        defaultValue: Math.round(DEFAULT_SHADOW_SETTINGS.alpha * 100),
        display: `${Math.round(alphaPercent)}%`,
        hint: 'Transparency of the rendered shadow.',
        disabled
      },
      dilation: {
        label: 'Spread',
        value: dilation.toFixed(1),
        min: 0,
        max: MAX_SHADOW_DILATION,
        step: 0.1,
        defaultValue: DEFAULT_SHADOW_SETTINGS.dilation,
        display: `${dilation.toFixed(1)} px`,
        hint: 'Expands the shadow mask before blurring (world pixels).',
        disabled
      },
      blur: {
        label: 'Blur',
        value: blur.toFixed(1),
        min: 0,
        max: MAX_SHADOW_BLUR,
        step: 0.1,
        defaultValue: DEFAULT_SHADOW_SETTINGS.blur,
        display: `${blur.toFixed(1)} px`,
        hint: 'Softens the shadow edges using a post-process blur.',
        disabled
      },
      offset: {
        mode: 'polar',
        distance: offsetDistance,
        angle: offsetAngle,
        maxDistance,
        maxDistanceDefault: DEFAULT_SHADOW_OFFSET_MAX,
        maxDistanceMin: MIN_SHADOW_OFFSET_MAX,
        maxDistanceLimit: SHADOW_OFFSET_MAX_CEILING,
        maxDistanceStep: 1,
        maxDistanceHint: 'Upper limit (px) for offset distance on the ring control.',
        offsetMaxHandlerId: 'setDropShadowOffsetMax',
        displayDistance: `${distanceDisplay} px`,
        displayAngle: `${angleDisplay}\u00B0`,
        hint: `Drag the handle to shift the shadow (max ${Math.round(maxDistance)} px). Outwards increases distance; clockwise changes direction.`,
        disabled
      },
      preview,
      shadowOnly: {
        available: allowed,
        enabled: !!shadowOnlyEnabled,
        label: 'Shadow only',
        tooltip: 'Hide the placed asset art while keeping its FA Nexus shadow visible.',
        disabled
      },
      context
    },
    normalized: {
      offsetDistance,
      offsetAngle,
      offsetDistanceChanged,
      offsetAngleChanged
    }
  };
}
