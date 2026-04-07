const HUE_MIN = -180;
const HUE_MAX = 180;
const FACTOR_MIN = 0;
const FACTOR_MAX = 2;
const FACTOR_STEP = 0.01;
const HUE_STEP = 1;
const EPSILON = 0.0005;
const DISPLAY_SCALE = 100;
const OFFSET_MIN = -DISPLAY_SCALE;
const OFFSET_MAX = DISPLAY_SCALE;
const FILTER_STATE_KEY = Symbol('faNexusHsbcFilterState');
const MANAGED_FILTER_KEY = Symbol('faNexusManagedHsbcFilter');
const HOOKS_INSTALLED_KEY = '__faNexusHsbcHooksInstalled';

export const HSBC_DEFAULTS = Object.freeze({
  hue: 0,
  saturation: 1,
  brightness: 1,
  contrast: 1
});

export const DEFAULT_HSBC = HSBC_DEFAULTS;

const HSBC_FRAGMENT_SRC = `
precision mediump float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform float hue;
uniform float saturation;
uniform float brightness;
uniform float contrast;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec4 color = texture2D(uSampler, vTextureCoord);
  if (color.a <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 baseRgb = color.rgb / max(color.a, 1.0e-10);
  vec3 hsv = rgb2hsv(baseRgb);
  hsv.x = fract(hsv.x + hue);
  hsv.y = clamp(hsv.y * saturation, 0.0, 1.0);
  vec3 rgb = hsv2rgb(hsv);
  rgb *= brightness;
  rgb = ((rgb - 0.5) * contrast) + 0.5;
  rgb = clamp(rgb, 0.0, 1.0);
  gl_FragColor = vec4(rgb * color.a, color.a);
}
`;

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function roundValue(value, places = 3) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** Math.max(0, places);
  return Math.round(value * factor) / factor;
}

function roundHue(value) {
  return Math.round(clampNumber(value, HUE_MIN, HUE_MAX, 0));
}

function roundFactor(value) {
  return roundValue(clampNumber(value, FACTOR_MIN, FACTOR_MAX, 1), 3);
}

function normalizeBase(value) {
  const source = value && typeof value === 'object' ? value : HSBC_DEFAULTS;
  return {
    hue: roundHue(source.hue),
    saturation: roundFactor(source.saturation),
    brightness: roundFactor(source.brightness),
    contrast: roundFactor(source.contrast)
  };
}

function getFilterState(displayObject, { create = false } = {}) {
  if (!displayObject) return null;
  let state = displayObject[FILTER_STATE_KEY] || null;
  if (state || !create) return state;
  state = { slots: new Map() };
  try {
    Object.defineProperty(displayObject, FILTER_STATE_KEY, {
      value: state,
      configurable: true
    });
  } catch (_) {
    try { displayObject[FILTER_STATE_KEY] = state; } catch (_) {}
  }
  return displayObject[FILTER_STATE_KEY] || state;
}

function syncDisplayObjectFilters(displayObject) {
  if (!displayObject || displayObject.destroyed) return null;
  const state = getFilterState(displayObject);
  const slotFilters = new Set(state?.slots?.values?.() || []);
  const current = Array.isArray(displayObject.filters) ? displayObject.filters.filter(Boolean) : [];
  const external = current.filter((filter) => !slotFilters.has(filter) && !filter?.[MANAGED_FILTER_KEY]);
  const slotList = state ? Array.from(state.slots.values()).filter(Boolean) : [];
  const next = [...external, ...slotList];
  displayObject.filters = next.length ? next : null;
  return displayObject.filters;
}

function scheduleFilterDestroy(filter) {
  if (!filter || filter.destroyed) return;
  const destroy = () => {
    try {
      if (!filter.destroyed) filter.destroy?.();
    } catch (_) {}
  };
  try {
    if (typeof globalThis?.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => {
        try { globalThis.setTimeout?.(destroy, 0); }
        catch (_) { destroy(); }
      });
      return;
    }
  } catch (_) {}
  try { globalThis.setTimeout?.(destroy, 0); }
  catch (_) { destroy(); }
}

function createHsbcFilter(initial = HSBC_DEFAULTS) {
  const filter = new PIXI.Filter(
    PIXI.Filter.defaultVertexSrc,
    HSBC_FRAGMENT_SRC,
    {
      hue: 0,
      saturation: 1,
      brightness: 1,
      contrast: 1
    }
  );
  filter.padding = 0;
  try {
    Object.defineProperty(filter, MANAGED_FILTER_KEY, {
      value: true,
      configurable: true
    });
  } catch (_) {
    try { filter[MANAGED_FILTER_KEY] = true; } catch (_) {}
  }
  updateHsbcFilter(filter, initial);
  return filter;
}

export function createNeutralHsbc() {
  return { ...HSBC_DEFAULTS };
}

export function getDefaultHsbc() {
  return createNeutralHsbc();
}

export function normalizeHsbc(value, fallback = HSBC_DEFAULTS) {
  if (value == null || typeof value !== 'object') {
    return fallback == null ? null : normalizeBase(fallback);
  }
  const base = fallback == null ? normalizeBase(HSBC_DEFAULTS) : normalizeBase(fallback);
  return {
    hue: roundHue(clampNumber(value.hue, HUE_MIN, HUE_MAX, base.hue)),
    saturation: roundFactor(clampNumber(value.saturation, FACTOR_MIN, FACTOR_MAX, base.saturation)),
    brightness: roundFactor(clampNumber(value.brightness, FACTOR_MIN, FACTOR_MAX, base.brightness)),
    contrast: roundFactor(clampNumber(value.contrast, FACTOR_MIN, FACTOR_MAX, base.contrast))
  };
}

export function cloneHsbc(value, options = {}) {
  const { fallback = HSBC_DEFAULTS, nullIfNeutral = false } = options;
  const normalized = normalizeHsbc(value, fallback);
  if (!normalized) return null;
  if (nullIfNeutral && isNeutralHsbc(normalized)) return null;
  return { ...normalized };
}

export function serializeHsbc(value, options = {}) {
  const { fallback = HSBC_DEFAULTS, nullIfNeutral = false } = options;
  const normalized = normalizeHsbc(value, fallback);
  if (!normalized) return null;
  if (nullIfNeutral && isNeutralHsbc(normalized)) return null;
  return { ...normalized };
}

export function mergeHsbc(base, override, options = {}) {
  const { nullIfNeutral = false } = options;
  const normalizedBase = normalizeHsbc(base);
  const normalized = normalizeHsbc(override, normalizedBase);
  if (!normalized) return null;
  if (nullIfNeutral && isNeutralHsbc(normalized)) return null;
  return normalized;
}

export function isNeutralHsbc(value) {
  const normalized = normalizeHsbc(value, null);
  if (!normalized) return true;
  return Math.abs(normalized.hue - HSBC_DEFAULTS.hue) < EPSILON
    && Math.abs(normalized.saturation - HSBC_DEFAULTS.saturation) < EPSILON
    && Math.abs(normalized.brightness - HSBC_DEFAULTS.brightness) < EPSILON
    && Math.abs(normalized.contrast - HSBC_DEFAULTS.contrast) < EPSILON;
}

export function readDocumentHsbc(doc, options = {}) {
  const { nullIfMissing = true, nullIfNeutral = false } = options;
  let raw;
  try {
    raw = doc?.getFlag?.('fa-nexus', 'hsbc');
  } catch (_) {
    raw = undefined;
  }
  if (raw === undefined) {
    const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'] || null;
    raw = flags ? flags.hsbc : undefined;
  }
  if (raw == null) {
    return nullIfMissing ? null : createNeutralHsbc();
  }
  return serializeHsbc(raw, { fallback: null, nullIfNeutral });
}

export function updateHsbcFilter(filter, value) {
  if (!filter || filter.destroyed) return null;
  const normalized = normalizeHsbc(value);
  if (!normalized) return null;
  let uniforms = null;
  try { uniforms = filter.uniforms; } catch (_) { return null; }
  if (!uniforms) return null;
  uniforms.hue = roundValue(normalized.hue / 360, 6);
  uniforms.saturation = normalized.saturation;
  uniforms.brightness = normalized.brightness;
  uniforms.contrast = normalized.contrast;
  return filter;
}

export function applyHsbcToDisplayObject(displayObject, hsbc, options = {}) {
  if (!displayObject || displayObject.destroyed) return null;
  const slot = String(options?.slot || 'hsbc');
  const state = getFilterState(displayObject, { create: true });
  if (!state?.slots) return null;
  const nextHsbc = serializeHsbc(hsbc, { fallback: null, nullIfNeutral: true });
  const existing = state.slots.get(slot) || null;
  if (!nextHsbc) {
    if (existing) {
      state.slots.delete(slot);
      syncDisplayObjectFilters(displayObject);
      scheduleFilterDestroy(existing);
      return null;
    }
    return null;
  }
  let filter = existing;
  if (!filter || filter.destroyed) {
    filter = createHsbcFilter(nextHsbc);
    state.slots.set(slot, filter);
  } else {
    updateHsbcFilter(filter, nextHsbc);
  }
  syncDisplayObjectFilters(displayObject);
  return filter;
}

export function clearHsbcFromDisplayObject(displayObject, options = {}) {
  return applyHsbcToDisplayObject(displayObject, null, options);
}

function toDisplayOffset(value) {
  return Math.round((clampNumber(value, FACTOR_MIN, FACTOR_MAX, 1) - 1) * DISPLAY_SCALE);
}

function fromDisplayOffset(value) {
  return roundFactor((clampNumber(value, OFFSET_MIN, OFFSET_MAX, 0) / DISPLAY_SCALE) + 1);
}

function formatSignedDisplay(value, suffix = '') {
  const rounded = Math.round(Number(value) || 0);
  if (!rounded) return `0${suffix}`;
  return `${rounded > 0 ? '+' : ''}${rounded}${suffix}`;
}

export function buildHsbcToolOptionsState(value, options = {}) {
  const available = options?.available !== false;
  if (!available) return { available: false };
  const hsbc = normalizeHsbc(value);
  const hueValue = roundHue(hsbc.hue);
  const saturationValue = toDisplayOffset(hsbc.saturation);
  const brightnessValue = toDisplayOffset(hsbc.brightness);
  const contrastValue = toDisplayOffset(hsbc.contrast);
  return {
    available: true,
    hint: typeof options?.hint === 'string' ? options.hint : 'Adjust hue, saturation, brightness, and contrast for the current artwork.',
    hue: {
      min: HUE_MIN,
      max: HUE_MAX,
      step: HUE_STEP,
      value: hueValue,
      defaultValue: 0,
      display: `${hueValue}\u00b0`,
      tooltip: 'Rotate the source colors around the hue wheel.'
    },
    saturation: {
      min: OFFSET_MIN,
      max: OFFSET_MAX,
      step: FACTOR_STEP * DISPLAY_SCALE,
      value: saturationValue,
      defaultValue: 0,
      display: formatSignedDisplay(saturationValue),
      tooltip: 'Increase or reduce color intensity.'
    },
    brightness: {
      min: OFFSET_MIN,
      max: OFFSET_MAX,
      step: FACTOR_STEP * DISPLAY_SCALE,
      value: brightnessValue,
      defaultValue: 0,
      display: formatSignedDisplay(brightnessValue),
      tooltip: 'Darken or brighten the current texture.'
    },
    contrast: {
      min: OFFSET_MIN,
      max: OFFSET_MAX,
      step: FACTOR_STEP * DISPLAY_SCALE,
      value: contrastValue,
      defaultValue: 0,
      display: formatSignedDisplay(contrastValue),
      tooltip: 'Push darks and lights apart or flatten them.'
    }
  };
}

export function buildHsbcToolOptionsControls(config = {}) {
  const {
    state,
    controls,
    sections,
    addRangeControl,
    addHintControl = null,
    sectionId = 'hsbc',
    sectionLabel = 'Color',
    idPrefix = 'hsbc',
    handlerIds = {},
    compact = true,
    ariaPrefix = 'HSBC'
  } = config;
  if (!state?.available || typeof addRangeControl !== 'function') return [];
  const controlIds = [];
  controlIds.push(addRangeControl({
    id: `${idPrefix}-hue`,
    label: 'Hue',
    state: state.hue,
    handlerId: handlerIds.hue || 'setHue',
    compact,
    ariaLabel: `${ariaPrefix} hue`
  }));
  controlIds.push(addRangeControl({
    id: `${idPrefix}-saturation`,
    label: 'Saturation',
    state: state.saturation,
    handlerId: handlerIds.saturation || 'setSaturation',
    compact,
    ariaLabel: `${ariaPrefix} saturation`
  }));
  controlIds.push(addRangeControl({
    id: `${idPrefix}-brightness`,
    label: 'Brightness',
    state: state.brightness,
    handlerId: handlerIds.brightness || 'setBrightness',
    compact,
    ariaLabel: `${ariaPrefix} brightness`
  }));
  controlIds.push(addRangeControl({
    id: `${idPrefix}-contrast`,
    label: 'Contrast',
    state: state.contrast,
    handlerId: handlerIds.contrast || 'setContrast',
    compact,
    ariaLabel: `${ariaPrefix} contrast`
  }));
  if (typeof addHintControl === 'function' && typeof state.hint === 'string' && state.hint.trim().length) {
    controlIds.push(addHintControl({
      id: `${idPrefix}-hint`,
      text: state.hint
    }));
  }
  if (Array.isArray(sections)) {
    sections.push({
      id: sectionId,
      label: sectionLabel,
      controls: controlIds.filter(Boolean)
    });
  }
  return controlIds.filter(Boolean);
}

export function buildHsbcToolOptionsHandlers(config = {}) {
  const {
    getHsbc = () => createNeutralHsbc(),
    setHsbc = () => false,
    names = {}
  } = config;
  const update = (key, rawValue, commit = false) => {
    const current = normalizeHsbc(getHsbc?.());
    if (!current) return false;
    const next = { ...current };
    if (key === 'hue') {
      next.hue = roundHue(rawValue);
    } else {
      next[key] = fromDisplayOffset(rawValue);
    }
    const changed = Math.abs((next[key] ?? 0) - (current[key] ?? 0)) >= EPSILON;
    if (!changed) {
      if (!commit) return true;
      const result = setHsbc(next, { key, commit, value: next[key] });
      return result !== false;
    }
    const result = setHsbc(next, { key, commit, value: next[key] });
    return result !== false;
  };
  return {
    [names.hue || 'setHue']: (value, commit) => update('hue', value, commit),
    [names.saturation || 'setSaturation']: (value, commit) => update('saturation', value, commit),
    [names.brightness || 'setBrightness']: (value, commit) => update('brightness', value, commit),
    [names.contrast || 'setContrast']: (value, commit) => update('contrast', value, commit)
  };
}

function resolveTilePlaceable(tileOrDoc) {
  if (!tileOrDoc) return null;
  if (tileOrDoc.mesh || tileOrDoc.document) return tileOrDoc;
  const docId = tileOrDoc.id || tileOrDoc._id || null;
  if (!docId) return null;
  const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
  return tiles.find((tile) => tile?.document?.id === docId) || tileOrDoc.object || null;
}

function getFaNexusDocumentFlags(doc) {
  if (!doc) return null;
  return doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'] || null;
}

function shouldSkipGenericTileHsbc(doc) {
  const flags = getFaNexusDocumentFlags(doc);
  if (!flags || typeof flags !== 'object') return false;
  return !!(
    flags.assetScatter
    || flags.maskedTiling
    || flags.standardTileMask
    || flags.pathV2
    || flags.pathsV2
    || flags.building
    || flags.buildingDoorFrame
  );
}

export function applyTileHsbc(tileOrDoc) {
  try {
    const tile = resolveTilePlaceable(tileOrDoc);
    const mesh = tile?.mesh;
    const doc = tile?.document || tileOrDoc || null;
    if (!tile || !mesh || mesh.destroyed) return false;
    if (shouldSkipGenericTileHsbc(doc)) {
      clearHsbcFromDisplayObject(mesh, { slot: 'tile-mesh' });
      return false;
    }
    const hsbc = readDocumentHsbc(doc, {
      nullIfMissing: true,
      nullIfNeutral: true
    });
    applyHsbcToDisplayObject(mesh, hsbc, { slot: 'tile-mesh' });
    return true;
  } catch (_) {
    return false;
  }
}

export function clearTileHsbc(tileOrDoc) {
  try {
    const tile = resolveTilePlaceable(tileOrDoc);
    clearHsbcFromDisplayObject(tile?.mesh, { slot: 'tile-mesh' });
    return true;
  } catch (_) {
    return false;
  }
}

export function rehydrateAllTileHsbc() {
  try {
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) applyTileHsbc(tile);
  } catch (_) {}
}

function installTileHsbcHooks() {
  if (globalThis?.[HOOKS_INSTALLED_KEY]) return;
  try {
    globalThis[HOOKS_INSTALLED_KEY] = true;
  } catch (_) {
    return;
  }
  try {
    Hooks.on('canvasReady', () => {
      try { rehydrateAllTileHsbc(); } catch (_) {}
    });
    Hooks.on('drawTile', (tile) => {
      try { applyTileHsbc(tile); } catch (_) {}
    });
    Hooks.on('refreshTile', (tile) => {
      try { applyTileHsbc(tile); } catch (_) {}
    });
    Hooks.on('controlTile', (tile) => {
      try { applyTileHsbc(tile); } catch (_) {}
    });
    Hooks.on('hoverTile', (tile) => {
      try { applyTileHsbc(tile); } catch (_) {}
    });
    Hooks.on('createTile', (doc) => {
      try { applyTileHsbc(doc); } catch (_) {}
    });
    Hooks.on('updateTile', (doc) => {
      try { applyTileHsbc(doc); } catch (_) {}
    });
    Hooks.on('deleteTile', (doc) => {
      try { clearTileHsbc(doc); } catch (_) {}
    });
  } catch (_) {}
}

installTileHsbcHooks();
