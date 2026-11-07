import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  createNeutralHsbc,
  isNeutralHsbc,
  normalizeHsbc,
  readDocumentHsbc,
  applyTileHsbc
} from '../core/hsbc.js';
import { applyTileHsbcToMesh } from '../textures/texture-blend-runtime.js';
import { AssetShadowManager, getAssetShadowManager } from '../assets/asset-shadow-manager.js';
import { applyAssetScatterTile } from '../assets/asset-scatter-geometry.js';
import { applyPathTile, computePathShadowPoints } from '../paths/path-geometry.js';
import {
  applyBuildingTile,
  applyBuildingTileHsbcToExistingRenderer
} from '../buildings/building-tiles.js';
import {
  applyMaskedTilingToTile,
  applyStandardTileMaskToTile,
  clearStandardTileMask
} from '../textures/texture-render.js';
import { getSceneLevelElevationRanges } from './elevation-band-utils.js';
import { getFaNexusTileCapabilities } from './tile-capabilities.js';
import { isBuildingManagedSillsDocument } from '../buildings/building-generated-document-runtime.js';
import {
  analyzeTileBandState,
  FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG,
  getTileExplicitPlacementLevelId,
  resolveTilePlacementLevelId
} from './tile-band-utils.js';
import {
  bindTileConfigShadowOffsetControl,
  queueTileConfigShadowOffsetLayoutSync,
  syncTileConfigShadowOffsetHandle,
  updateTileConfigShadowOffsetHeaderDisplay,
  updateTileConfigShadowOffsetInputs
} from './tile-config-shadow-offset-control.js';
import { TileConfigSubmitWorkflow } from './tile-config-submit-workflow.js';

const MODULE_ID = 'fa-nexus';
const TAB_ID = 'fa-nexus';
const TAB_SELECTOR = '[data-fa-nexus-tile-config-tab]';
const NAV_SELECTOR = '[data-fa-nexus-tile-config-nav]';
const TILE_PALETTE_SECTION_SELECTOR = '[data-fa-nexus-tile-palette-section]';
const TILE_PALETTE_PARENT_LEVEL_SELECTOR = '[data-fa-nexus-tile-palette-parent-level]';
const TILE_PALETTE_PARENT_LEVEL_FIELD = `flags.${MODULE_ID}.${FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG}`;
const APP_STATE_KEY = Symbol('faNexusTileConfigState');
const DEFAULT_SHADOW_SETTINGS = Object.freeze({
  alpha: 0.65,
  dilation: 1.6,
  blur: 1.8,
  offsetDistance: 0,
  offsetAngle: 135
});
const DEFAULT_SHADOW_OFFSET_MAX = 40;
const SHADOW_OFFSET_MAX_CEILING = 512;
const STANDARD_SHADOW_BLUR_MAX = 12;
const PATH_SHADOW_OFFSET_GRID_RANGE = 2;
const PATH_SHADOW_OFFSET_GRID_STEP = 0.01;
const PATH_SHADOW_SCALE_PERCENT_MIN = 10;
const PATH_SHADOW_SCALE_PERCENT_MAX = 250;
const BUILDING_SHADOW_SCALE_PERCENT_MIN = 25;
const BUILDING_SHADOW_SCALE_PERCENT_MAX = 400;
const PATH_SHADOW_SCALE_PERCENT_STEP = 1;
const PATH_SHADOW_SCALE_DEFAULT = 1;
const PATH_SHADOW_ALPHA_DEFAULT = 0.65;
const PATH_SHADOW_BLUR_DEFAULT = 2.5;
const PATH_SHADOW_BLUR_MAX = 50;
const PATH_SHADOW_DILATION_DEFAULT = 1.6;
const BUILDING_SHADOW_ALPHA_DEFAULT = 0.6;
const BUILDING_SHADOW_BLUR_DEFAULT = 12;
const BUILDING_SHADOW_BLUR_MAX = 20;
const BUILDING_SHADOW_DILATION_DEFAULT = 10;
const SHADOW_DILATION_MAX = 20;
const SHADOW_VALUE_EPSILON = 0.0005;
let tilePaletteFaNexusDetailsOpen = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampNumber(value, min, max, fallback) {
  const numeric = normalizeNumber(value, fallback);
  return Math.min(max, Math.max(min, numeric));
}

function approxNumber(left, right, epsilon = SHADOW_VALUE_EPSILON) {
  return Math.abs(Number(left || 0) - Number(right || 0)) < epsilon;
}

function roundNumber(value, decimals = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** Math.max(0, Number(decimals) || 0);
  return Math.round(numeric * factor) / factor;
}

function normalizePercent(value, min, max, fallback = 100) {
  return roundNumber(clampNumber(value, min, max, fallback), 1);
}

function normalizeShadowScale(value, fallback = PATH_SHADOW_SCALE_DEFAULT) {
  const numeric = normalizeNumber(value, fallback);
  return Math.max(0.05, numeric);
}

function shadowScaleToPercent(value, min, max) {
  return normalizePercent(normalizeShadowScale(value) * 100, min, max, 100);
}

function shadowScalePercentToRatio(value, min, max) {
  return roundNumber(normalizePercent(value, min, max, 100) / 100, 4);
}

function hsbcFactorToDisplayOffset(value) {
  return Math.round((clampNumber(value, 0, 2, 1) - 1) * 100);
}

function hsbcDisplayOffsetToFactor(value) {
  return roundNumber(1 + (clampNumber(value, -100, 100, 0) / 100), 3);
}

function getHsbcControlValue(field, hsbc) {
  if (field === 'hue') return Math.round(clampNumber(hsbc?.hue, -180, 180, 0));
  return hsbcFactorToDisplayOffset(hsbc?.[field]);
}

function getHsbcFlagValue(field, controlValue) {
  if (field === 'hue') return Math.round(clampNumber(controlValue, -180, 180, 0));
  return hsbcDisplayOffsetToFactor(controlValue);
}

function normalizeAngle(value, fallback = DEFAULT_SHADOW_SETTINGS.offsetAngle) {
  const numeric = normalizeNumber(value, fallback);
  let normalized = numeric % 360;
  if (normalized < 0) normalized += 360;
  return normalized;
}

function computeShadowOffsetVector(distance = DEFAULT_SHADOW_SETTINGS.offsetDistance, angle = DEFAULT_SHADOW_SETTINGS.offsetAngle) {
  const normalizedDistance = Math.max(0, normalizeNumber(distance, DEFAULT_SHADOW_SETTINGS.offsetDistance));
  const normalizedAngle = normalizeAngle(angle, DEFAULT_SHADOW_SETTINGS.offsetAngle);
  const theta = normalizedAngle * (Math.PI / 180);
  return {
    x: Math.cos(theta) * normalizedDistance,
    y: Math.sin(theta) * normalizedDistance
  };
}

function getSceneGridSize(scene = null) {
  const raw = Number(
    scene?.grid?.size
    ?? canvas?.scene?.grid?.size
    ?? canvas?.grid?.size
    ?? canvas?.dimensions?.size
    ?? 200
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
}

function normalizePathShadowOffsetGrid(value) {
  return roundNumber(clampNumber(value, -PATH_SHADOW_OFFSET_GRID_RANGE, PATH_SHADOW_OFFSET_GRID_RANGE, 0), 2);
}

function convertPathShadowOffsetGridToPx(value, scene = null) {
  return roundNumber(normalizePathShadowOffsetGrid(value) * getSceneGridSize(scene), 3);
}

function convertPathShadowOffsetPxToGrid(value, scene = null) {
  const gridSize = getSceneGridSize(scene);
  if (!gridSize) return 0;
  return normalizePathShadowOffsetGrid((Number(value) || 0) / gridSize);
}

function readModuleFlagRaw(doc, key) {
  let raw;
  try {
    raw = doc?.getFlag?.(MODULE_ID, key);
  } catch (_) {
    raw = undefined;
  }
  if (raw === undefined) raw = doc?.flags?.[MODULE_ID]?.[key] ?? doc?._source?.flags?.[MODULE_ID]?.[key];
  return raw;
}

function getPathShadowPayloadState(doc) {
  const merged = readModuleFlagRaw(doc, 'pathsV2');
  if (merged && Array.isArray(merged.paths) && merged.paths.some((entry) => entry && Array.isArray(entry.controlPoints))) {
    return {
      key: 'pathsV2',
      payload: merged,
      entries: merged.paths.filter((entry) => entry && Array.isArray(entry.controlPoints))
    };
  }
  const v2 = readModuleFlagRaw(doc, 'pathV2');
  if (v2 && Array.isArray(v2.controlPoints)) {
    return {
      key: 'pathV2',
      payload: v2,
      entries: [v2]
    };
  }
  return null;
}

function readFirstShadowNumber(entries, key, fallback) {
  const values = (Array.isArray(entries) ? entries : [])
    .map((entry) => Number(entry?.shadow?.[key]))
    .filter(Number.isFinite);
  const first = values.length ? values[0] : fallback;
  return {
    value: first,
    inconsistent: values.some((value) => !approxNumber(value, first))
  };
}

function getPathShadowUiState(doc) {
  const payloadState = getPathShadowPayloadState(doc);
  if (!payloadState?.entries?.length) return null;
  const offsets = payloadState.entries
    .map((entry) => Number(entry?.shadow?.offset))
    .filter(Number.isFinite);
  const firstOffsetPx = offsets.length ? offsets[0] : 0;
  const scale = readFirstShadowNumber(payloadState.entries, 'scale', PATH_SHADOW_SCALE_DEFAULT);
  const alpha = readFirstShadowNumber(payloadState.entries, 'alpha', PATH_SHADOW_ALPHA_DEFAULT);
  const blur = readFirstShadowNumber(payloadState.entries, 'blur', PATH_SHADOW_BLUR_DEFAULT);
  const dilation = readFirstShadowNumber(payloadState.entries, 'dilation', PATH_SHADOW_DILATION_DEFAULT);
  return {
    payloadState,
    offsetPx: roundNumber(firstOffsetPx, 3),
    offsetGrid: convertPathShadowOffsetPxToGrid(firstOffsetPx, doc?.parent || canvas?.scene),
    scale: normalizeShadowScale(scale.value, PATH_SHADOW_SCALE_DEFAULT),
    scalePercent: shadowScaleToPercent(scale.value, PATH_SHADOW_SCALE_PERCENT_MIN, PATH_SHADOW_SCALE_PERCENT_MAX),
    alpha: clampNumber(alpha.value, 0, 1, PATH_SHADOW_ALPHA_DEFAULT),
    blur: clampNumber(blur.value, 0, PATH_SHADOW_BLUR_MAX, PATH_SHADOW_BLUR_DEFAULT),
    dilation: clampNumber(dilation.value, 0, SHADOW_DILATION_MAX, PATH_SHADOW_DILATION_DEFAULT),
    manual: payloadState.entries.some((entry) => !!entry?.shadow?.manual),
    editMode: payloadState.entries.some((entry) => !!entry?.shadow?.editMode),
    inconsistentOffset: offsets.some((value) => !approxNumber(value, firstOffsetPx)),
    inconsistentScale: scale.inconsistent,
    count: payloadState.entries.length
  };
}

function getBuildingShadowUiState(doc) {
  const building = readModuleFlagRaw(doc, 'building');
  const wall = building?.wall;
  if (!wall || typeof wall !== 'object') return null;
  const entries = [];
  if (wall.pathShadow && typeof wall.pathShadow === 'object') entries.push(wall.pathShadow);
  if (Array.isArray(wall.renderSegments)) {
    for (const segment of wall.renderSegments) {
      if (segment?.pathShadow && typeof segment.pathShadow === 'object') entries.push(segment.pathShadow);
    }
  }
  const offsets = entries
    .map((entry) => Number(entry?.offset))
    .filter(Number.isFinite);
  const firstOffsetPx = offsets.length ? offsets[0] : 0;
  const read = (key, fallback) => {
    const values = entries
      .map((entry) => Number(entry?.[key]))
      .filter(Number.isFinite);
    const first = values.length ? values[0] : fallback;
    return {
      value: first,
      inconsistent: values.some((value) => !approxNumber(value, first))
    };
  };
  const scale = read('scale', PATH_SHADOW_SCALE_DEFAULT);
  const alpha = read('alpha', BUILDING_SHADOW_ALPHA_DEFAULT);
  const blur = read('blur', BUILDING_SHADOW_BLUR_DEFAULT);
  const dilation = read('dilation', BUILDING_SHADOW_DILATION_DEFAULT);
  return {
    offsetPx: roundNumber(firstOffsetPx, 3),
    offsetGrid: convertPathShadowOffsetPxToGrid(firstOffsetPx, doc?.parent || canvas?.scene),
    scale: normalizeShadowScale(scale.value, PATH_SHADOW_SCALE_DEFAULT),
    scalePercent: shadowScaleToPercent(scale.value, BUILDING_SHADOW_SCALE_PERCENT_MIN, BUILDING_SHADOW_SCALE_PERCENT_MAX),
    alpha: clampNumber(alpha.value, 0, 1, BUILDING_SHADOW_ALPHA_DEFAULT),
    blur: clampNumber(blur.value, 0, BUILDING_SHADOW_BLUR_MAX, BUILDING_SHADOW_BLUR_DEFAULT),
    dilation: clampNumber(dilation.value, 0, SHADOW_DILATION_MAX, BUILDING_SHADOW_DILATION_DEFAULT),
    manual: entries.some((entry) => !!entry?.manual),
    editMode: entries.some((entry) => !!entry?.editMode),
    inconsistentOffset: offsets.some((value) => !approxNumber(value, firstOffsetPx)),
    inconsistentScale: scale.inconsistent,
    count: Math.max(1, entries.length || (Array.isArray(wall.renderSegments) ? wall.renderSegments.length : 1))
  };
}

function getResolvedShadowOffsetState(doc) {
  let offsetDistance = Math.max(0, readFlagNumber(doc, 'shadowOffsetDistance', DEFAULT_SHADOW_SETTINGS.offsetDistance));
  let offsetAngle = normalizeAngle(readFlagNumber(doc, 'shadowOffsetAngle', DEFAULT_SHADOW_SETTINGS.offsetAngle));
  let offsetX = readOptionalFlagNumber(doc, 'shadowOffsetX');
  let offsetY = readOptionalFlagNumber(doc, 'shadowOffsetY');
  if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
    offsetDistance = Math.max(0, Math.hypot(offsetX, offsetY));
    offsetAngle = normalizeAngle(Math.atan2(offsetY, offsetX) * (180 / Math.PI), DEFAULT_SHADOW_SETTINGS.offsetAngle);
  } else {
    const vector = computeShadowOffsetVector(offsetDistance, offsetAngle);
    offsetX = vector.x;
    offsetY = vector.y;
  }
  return {
    offsetDistance,
    offsetAngle,
    offsetX,
    offsetY
  };
}

function formatHsbcControlDisplay(field, value) {
  const numeric = normalizeNumber(value, 0);
  if (field === 'hue') return `${Math.round(numeric)}deg`;
  const rounded = Math.round(numeric);
  if (!rounded) return '0';
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function formatShadowDisplay(field, value) {
  const numeric = normalizeNumber(value, 0);
  if (field === 'alpha') return numeric.toFixed(2);
  if (field === 'scale') return `${normalizeNumber(value, 100).toFixed(Number.isInteger(Number(value)) ? 0 : 1)}%`;
  if (field === 'offsetAngle') return `${Math.round(numeric)}deg`;
  if (field === 'offsetDistance') return `${Math.round(numeric)} px`;
  if (field === 'pathOffset') return `${normalizePathShadowOffsetGrid(numeric).toFixed(2)} grid`;
  if (field === 'blur' || field === 'dilation') return `${numeric.toFixed(2)} px`;
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
}

function resolveHostElement(element) {
  if (element instanceof HTMLElement) return element;
  if (element?.[0] instanceof HTMLElement) return element[0];
  if (element?.element instanceof HTMLElement) return element.element;
  return null;
}

function getAppState(app) {
  if (app?.[APP_STATE_KEY]) return app[APP_STATE_KEY];
  const state = {
    syncFrame: 0,
    hsbcPreviewSequence: 0,
    cleanupWrapped: false,
    updateWrapped: false,
    shadow: {
      pointerCleanup: null,
      previewElevation: null,
      layoutObserver: null,
      layoutSyncFrame: 0
    }
  };
  try {
    Object.defineProperty(app, APP_STATE_KEY, {
      value: state,
      configurable: true
    });
  } catch (_) {
    app[APP_STATE_KEY] = state;
  }
  return app[APP_STATE_KEY] || state;
}

function readFlagNumber(doc, key, fallback) {
  let raw;
  try {
    raw = doc?.getFlag?.(MODULE_ID, key);
  } catch (_) {
    raw = undefined;
  }
  if (raw === undefined) {
    raw = doc?.flags?.[MODULE_ID]?.[key] ?? doc?._source?.flags?.[MODULE_ID]?.[key];
  }
  return normalizeNumber(raw, fallback);
}

function readOptionalFlagNumber(doc, key) {
  let raw;
  try {
    raw = doc?.getFlag?.(MODULE_ID, key);
  } catch (_) {
    raw = undefined;
  }
  if (raw === undefined) {
    raw = doc?.flags?.[MODULE_ID]?.[key] ?? doc?._source?.flags?.[MODULE_ID]?.[key];
  }
  if (raw === undefined || raw === null || raw === '') return undefined;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function readFlagBoolean(doc, key, fallback = false) {
  let raw;
  try {
    raw = doc?.getFlag?.(MODULE_ID, key);
  } catch (_) {
    raw = undefined;
  }
  if (raw === undefined) {
    raw = doc?.flags?.[MODULE_ID]?.[key] ?? doc?._source?.flags?.[MODULE_ID]?.[key];
  }
  return raw == null ? !!fallback : !!raw;
}

function readShadowOffsetUiMax() {
  try {
    const raw = game?.settings?.get?.(MODULE_ID, 'assetDropShadowOffsetMax');
    return clampNumber(raw, 1, SHADOW_OFFSET_MAX_CEILING, DEFAULT_SHADOW_OFFSET_MAX);
  } catch (_) {
    return DEFAULT_SHADOW_OFFSET_MAX;
  }
}

function getDocumentElevation(target, fallback = 0) {
  const numeric = Number(target?.elevation ?? target?._source?.elevation ?? fallback);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readSubmitDataValue(formData, key, fallback = undefined) {
  if (!formData || typeof formData !== 'object' || !key) return fallback;
  if (Object.prototype.hasOwnProperty.call(formData, key)) return formData[key];
  return foundry?.utils?.getProperty?.(formData, key) ?? fallback;
}

function coerceSubmitBoolean(value, fallback = false) {
  if (value === undefined || value === null) return !!fallback;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'off', 'no', ''].includes(normalized)) return false;
  }
  return !!value;
}

function readSubmitShadowEnabled(formData, doc) {
  const current = readFlagBoolean(doc, 'shadow', false);
  return coerceSubmitBoolean(readSubmitDataValue(formData, `flags.${MODULE_ID}.shadow`, current), current);
}

function readSubmitShadowNumber(formData, doc, key, fallback) {
  return normalizeNumber(
    readSubmitDataValue(formData, `flags.${MODULE_ID}.${key}`, readFlagNumber(doc, key, fallback)),
    fallback
  );
}

function readSubmitShadowSettings(formData, doc, existing = {}) {
  const alphaFallback = Number.isFinite(Number(existing.alpha))
    ? Number(existing.alpha)
    : readFlagNumber(doc, 'shadowAlpha', DEFAULT_SHADOW_SETTINGS.alpha);
  const blurFallback = Number.isFinite(Number(existing.blur))
    ? Number(existing.blur)
    : readFlagNumber(doc, 'shadowBlur', DEFAULT_SHADOW_SETTINGS.blur);
  const dilationFallback = Number.isFinite(Number(existing.dilation))
    ? Number(existing.dilation)
    : readFlagNumber(doc, 'shadowDilation', DEFAULT_SHADOW_SETTINGS.dilation);
  return {
    alpha: clampNumber(readSubmitShadowNumber(formData, doc, 'shadowAlpha', alphaFallback), 0, 1, DEFAULT_SHADOW_SETTINGS.alpha),
    blur: Math.max(0, readSubmitShadowNumber(formData, doc, 'shadowBlur', blurFallback)),
    dilation: Math.max(0, readSubmitShadowNumber(formData, doc, 'shadowDilation', dilationFallback))
  };
}

function readSubmitShadowOffsetState(formData, doc) {
  const current = getResolvedShadowOffsetState(doc);
  let offsetDistance = Math.max(0, readSubmitShadowNumber(formData, doc, 'shadowOffsetDistance', current.offsetDistance));
  let offsetAngle = normalizeAngle(readSubmitShadowNumber(formData, doc, 'shadowOffsetAngle', current.offsetAngle));
  let offsetX = normalizeNumber(readSubmitDataValue(formData, `flags.${MODULE_ID}.shadowOffsetX`, current.offsetX), current.offsetX);
  let offsetY = normalizeNumber(readSubmitDataValue(formData, `flags.${MODULE_ID}.shadowOffsetY`, current.offsetY), current.offsetY);
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
    const vector = computeShadowOffsetVector(offsetDistance, offsetAngle);
    offsetX = vector.x;
    offsetY = vector.y;
  } else {
    offsetDistance = Math.max(0, Math.hypot(offsetX, offsetY));
    offsetAngle = normalizeAngle(Math.atan2(offsetY, offsetX) * (180 / Math.PI), DEFAULT_SHADOW_SETTINGS.offsetAngle);
  }
  return {
    offsetDistance: roundNumber(offsetDistance, 3),
    offsetAngle: roundNumber(offsetAngle, 3),
    offsetX: roundNumber(offsetX, 3),
    offsetY: roundNumber(offsetY, 3)
  };
}

function writeSubmitDataValue(formData, key, value) {
  if (!formData || typeof formData !== 'object' || !key) return;
  const setProperty = foundry?.utils?.setProperty;
  if (typeof setProperty === 'function') {
    setProperty(formData, key, value);
    return;
  }
  formData[key] = value;
}

function deleteSubmitDataValue(formData, key) {
  if (!formData || typeof formData !== 'object' || !key) return;
  if (Object.prototype.hasOwnProperty.call(formData, key)) delete formData[key];
  const parts = String(key).split('.').filter(Boolean);
  if (!parts.length) return;
  let parent = formData;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!parent || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, part)) return;
    parent = parent[part];
  }
  const lastPart = parts[parts.length - 1];
  if (parent && typeof parent === 'object' && lastPart) delete parent[lastPart];
}

function cloneSubmitDataValue(value) {
  const deepClone = foundry?.utils?.deepClone || globalThis?.structuredClone;
  if (typeof deepClone === 'function') {
    try { return deepClone(value); } catch (_) {}
  }
  if (Array.isArray(value)) return value.map((entry) => cloneSubmitDataValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneSubmitDataValue(entry)]));
  }
  return value;
}

function collectSubmitDataDescendants(formData, key) {
  if (!formData || typeof formData !== 'object' || !key) return [];
  const prefix = `${String(key)}.`;
  return Object.entries(formData)
    .filter(([entryKey]) => entryKey.startsWith(prefix))
    .map(([entryKey, value]) => ({
      path: entryKey.slice(prefix.length),
      value
    }))
    .filter((entry) => entry.path);
}

function buildSubmitDataBranchValue(formData, key, fallback = null) {
  const sourceValue = readSubmitDataValue(formData, key, undefined);
  const baseValue = sourceValue === undefined ? fallback : sourceValue;
  if (baseValue == null) return null;
  const output = cloneSubmitDataValue(baseValue);
  const setProperty = foundry?.utils?.setProperty;
  if (!output || typeof output !== 'object' || typeof setProperty !== 'function') return output;
  for (const descendant of collectSubmitDataDescendants(formData, key)) {
    setProperty(output, descendant.path, cloneSubmitDataValue(descendant.value));
  }
  return output;
}

function replaceSubmitDataBranch(formData, key, value) {
  deleteSubmitDataValue(formData, key);
  for (const descendant of collectSubmitDataDescendants(formData, key)) {
    if (Object.prototype.hasOwnProperty.call(formData, `${key}.${descendant.path}`)) {
      delete formData[`${key}.${descendant.path}`];
    }
  }
  writeSubmitDataValue(formData, key, value);
}

function removeSubmitDataBranch(formData, key) {
  deleteSubmitDataValue(formData, key);
  for (const descendant of collectSubmitDataDescendants(formData, key)) {
    const descendantKey = `${key}.${descendant.path}`;
    if (Object.prototype.hasOwnProperty.call(formData, descendantKey)) {
      delete formData[descendantKey];
    }
  }
}

function cloneHsbcSubmitValue(value) {
  if (!value) return null;
  return {
    hue: value.hue,
    saturation: value.saturation,
    brightness: value.brightness,
    contrast: value.contrast
  };
}

function hasOwnPropertyValue(value, key) {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

function shouldApplySubmitHsbc(appInstance) {
  const root = getTileConfigTabRoot(appInstance);
  const toggle = root?.querySelector?.('[data-fa-nexus-hsbc-enabled]') || null;
  if (!toggle) return true;
  return toggle.dataset.touched === 'true';
}

function readSubmitHsbcState(formData, doc, appInstance = null) {
  const raw = buildSubmitDataBranchValue(
    formData,
    `flags.${MODULE_ID}.hsbc`,
    readModuleFlagRaw(doc, 'hsbc') || createNeutralHsbc()
  );
  const normalized = normalizeHsbc(raw, createNeutralHsbc());
  const persisted = normalized && !isNeutralHsbc(normalized)
    ? cloneHsbcSubmitValue(normalized)
    : null;
  return {
    normalized,
    persisted,
    shouldApply: shouldApplySubmitHsbc(appInstance)
  };
}

function applyPathHsbcSubmit(appInstance, submitData, hsbcState) {
  const doc = appInstance?.document || null;
  const capabilities = doc ? getFaNexusTileCapabilities(doc) : null;
  if (!doc || !(capabilities?.hasPathV2 || capabilities?.hasPathsV2)) return false;
  const nextHsbc = cloneHsbcSubmitValue(hsbcState?.persisted);

  const merged = buildSubmitDataBranchValue(submitData, `flags.${MODULE_ID}.pathsV2`, readModuleFlagRaw(doc, 'pathsV2'));
  if (merged && Array.isArray(merged.paths) && merged.paths.some((entry) => entry && Array.isArray(entry.controlPoints))) {
    const cloned = cloneSubmitDataValue(merged);
    cloned.paths = cloned.paths.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      return {
        ...entry,
        hsbc: cloneHsbcSubmitValue(nextHsbc)
      };
    });
    replaceSubmitDataBranch(submitData, `flags.${MODULE_ID}.pathsV2`, cloned);
    return true;
  }

  const pathV2 = buildSubmitDataBranchValue(submitData, `flags.${MODULE_ID}.pathV2`, readModuleFlagRaw(doc, 'pathV2'));
  if (pathV2 && Array.isArray(pathV2.controlPoints)) {
    const cloned = {
      ...cloneSubmitDataValue(pathV2),
      hsbc: cloneHsbcSubmitValue(nextHsbc)
    };
    replaceSubmitDataBranch(submitData, `flags.${MODULE_ID}.pathV2`, cloned);
    return true;
  }

  Logger.error('TileConfig.hsbc.submit.pathPayloadMissing', {
    tileId: doc?.id || null,
    hasPathV2: !!capabilities?.hasPathV2,
    hasPathsV2: !!capabilities?.hasPathsV2
  });
  throw new Error('Path HSBC submit requires a pathV2 or pathsV2 payload.');
}

function applyBuildingHsbcSubmit(appInstance, submitData, hsbcState) {
  const doc = appInstance?.document || null;
  const capabilities = doc ? getFaNexusTileCapabilities(doc) : null;
  if (!doc || !capabilities?.hasBuilding) return false;
  const building = buildSubmitDataBranchValue(submitData, `flags.${MODULE_ID}.building`, readModuleFlagRaw(doc, 'building'));
  if (!building?.wall || typeof building.wall !== 'object') {
    Logger.error('TileConfig.hsbc.submit.buildingPayloadMissing', {
      tileId: doc?.id || null
    });
    throw new Error('Building HSBC submit requires building wall payload.');
  }

  const nextHsbc = cloneHsbcSubmitValue(hsbcState?.persisted);
  const cloned = cloneSubmitDataValue(building);
  cloned.wall = {
    ...cloned.wall,
    hsbc: cloneHsbcSubmitValue(nextHsbc)
  };

  if (Array.isArray(cloned.wall.renderSegments)) {
    cloned.wall.renderSegments = cloned.wall.renderSegments.map((segment) => {
      if (!segment || typeof segment !== 'object') return segment;
      const nextSegment = {
        ...segment,
        hsbc: cloneHsbcSubmitValue(nextHsbc)
      };
      if (segment.appearance && typeof segment.appearance === 'object') {
        nextSegment.appearance = {
          ...segment.appearance,
          hsbc: cloneHsbcSubmitValue(nextHsbc)
        };
      }
      return nextSegment;
    });
  }

  if (cloned.meta?.innerDefaults && typeof cloned.meta.innerDefaults === 'object') {
    cloned.meta = {
      ...cloned.meta,
      innerDefaults: {
        ...cloned.meta.innerDefaults,
        hsbc: cloneHsbcSubmitValue(nextHsbc)
      }
    };
  }

  replaceSubmitDataBranch(submitData, `flags.${MODULE_ID}.building`, cloned);
  return true;
}

function preservePathHsbcSubmit(appInstance, submitData) {
  const doc = appInstance?.document || null;
  const capabilities = doc ? getFaNexusTileCapabilities(doc) : null;
  if (!doc || !(capabilities?.hasPathV2 || capabilities?.hasPathsV2)) return false;

  const existingMerged = readModuleFlagRaw(doc, 'pathsV2');
  if (existingMerged && Array.isArray(existingMerged.paths) && existingMerged.paths.some((entry) => entry && Array.isArray(entry.controlPoints))) {
    const merged = buildSubmitDataBranchValue(submitData, `flags.${MODULE_ID}.pathsV2`, existingMerged);
    if (!merged || !Array.isArray(merged.paths)) return false;
    const cloned = cloneSubmitDataValue(merged);
    cloned.paths = cloned.paths.map((entry, index) => {
      if (!entry || typeof entry !== 'object') return entry;
      const existingEntry = existingMerged.paths?.[index] || null;
      if (!hasOwnPropertyValue(existingEntry, 'hsbc')) return entry;
      return {
        ...entry,
        hsbc: cloneHsbcSubmitValue(existingEntry.hsbc)
      };
    });
    replaceSubmitDataBranch(submitData, `flags.${MODULE_ID}.pathsV2`, cloned);
    return true;
  }

  const existingPathV2 = readModuleFlagRaw(doc, 'pathV2');
  if (existingPathV2 && Array.isArray(existingPathV2.controlPoints)) {
    const pathV2 = buildSubmitDataBranchValue(submitData, `flags.${MODULE_ID}.pathV2`, existingPathV2);
    if (!pathV2 || !Array.isArray(pathV2.controlPoints)) return false;
    const cloned = cloneSubmitDataValue(pathV2);
    if (hasOwnPropertyValue(existingPathV2, 'hsbc')) cloned.hsbc = cloneHsbcSubmitValue(existingPathV2.hsbc);
    replaceSubmitDataBranch(submitData, `flags.${MODULE_ID}.pathV2`, cloned);
    return true;
  }

  return false;
}

function preserveBuildingHsbcSubmit(appInstance, submitData) {
  const doc = appInstance?.document || null;
  const capabilities = doc ? getFaNexusTileCapabilities(doc) : null;
  if (!doc || !capabilities?.hasBuilding) return false;

  const existingBuilding = readModuleFlagRaw(doc, 'building');
  if (!existingBuilding?.wall || typeof existingBuilding.wall !== 'object') return false;
  const building = buildSubmitDataBranchValue(submitData, `flags.${MODULE_ID}.building`, existingBuilding);
  if (!building?.wall || typeof building.wall !== 'object') return false;

  const cloned = cloneSubmitDataValue(building);
  if (hasOwnPropertyValue(existingBuilding.wall, 'hsbc')) {
    cloned.wall = {
      ...cloned.wall,
      hsbc: cloneHsbcSubmitValue(existingBuilding.wall.hsbc)
    };
  }

  if (Array.isArray(cloned.wall.renderSegments) && Array.isArray(existingBuilding.wall.renderSegments)) {
    cloned.wall.renderSegments = cloned.wall.renderSegments.map((segment, index) => {
      if (!segment || typeof segment !== 'object') return segment;
      const existingSegment = existingBuilding.wall.renderSegments[index] || null;
      const nextSegment = { ...segment };
      if (hasOwnPropertyValue(existingSegment, 'hsbc')) {
        nextSegment.hsbc = cloneHsbcSubmitValue(existingSegment.hsbc);
      }
      if (segment.appearance && typeof segment.appearance === 'object' && hasOwnPropertyValue(existingSegment?.appearance, 'hsbc')) {
        nextSegment.appearance = {
          ...segment.appearance,
          hsbc: cloneHsbcSubmitValue(existingSegment.appearance.hsbc)
        };
      }
      return nextSegment;
    });
  }

  if (hasOwnPropertyValue(existingBuilding.meta?.innerDefaults, 'hsbc')) {
    cloned.meta = {
      ...(cloned.meta || {}),
      innerDefaults: {
        ...(cloned.meta?.innerDefaults || {}),
        hsbc: cloneHsbcSubmitValue(existingBuilding.meta.innerDefaults.hsbc)
      }
    };
  }

  replaceSubmitDataBranch(submitData, `flags.${MODULE_ID}.building`, cloned);
  return true;
}

function applyCustomRendererHsbcSubmit(appInstance, submitData) {
  const doc = appInstance?.document || null;
  if (!doc) return false;
  const hsbcState = readSubmitHsbcState(submitData, doc, appInstance);
  if (!hsbcState.shouldApply) {
    removeSubmitDataBranch(submitData, `flags.${MODULE_ID}.hsbc`);
    preservePathHsbcSubmit(appInstance, submitData);
    preserveBuildingHsbcSubmit(appInstance, submitData);
    return false;
  }
  replaceSubmitDataBranch(submitData, `flags.${MODULE_ID}.hsbc`, cloneHsbcSubmitValue(hsbcState.persisted));
  const pathUpdated = applyPathHsbcSubmit(appInstance, submitData, hsbcState);
  const buildingUpdated = applyBuildingHsbcSubmit(appInstance, submitData, hsbcState);
  return pathUpdated || buildingUpdated;
}

function requestLayerManagerSelectionSync(options = {}) {
  try {
    Hooks?.callAll?.('fa-nexus-tile-config-selection-sync', {
      allowAutoExpand: options?.allowAutoExpand !== false,
      allowScrollToTile: options?.allowScrollToTile !== false
    });
  } catch (error) {
    Logger.warn('TileConfig.selectionSync.request.failed', {
      tileId: options?.tileId || null,
      error: String(error?.message || error)
    });
  }
}

function getTileConfigTabRoot(app) {
  const formRoot = app?.form instanceof HTMLElement ? app.form.querySelector(TAB_SELECTOR) : null;
  if (formRoot) return formRoot;
  const host = resolveHostElement(app?.element);
  return host?.querySelector?.(TAB_SELECTOR) || null;
}

function supportsTileShadowControls(target) {
  const capabilities = getFaNexusTileCapabilities(target);
  return !capabilities?.hasMaskedTiling && !isBuildingManagedSillsDocument(capabilities?.document);
}

function getShadowPreviewManager(app) {
  const existing = AssetShadowManager.peek?.();
  if (existing) return existing;
  try {
    if (!game?.settings?.get?.(MODULE_ID, 'assetDropShadow')) return null;
  } catch (_) {
    return null;
  }
  try {
    const nexusApp = globalThis?.faNexus?.app || null;
    return getAssetShadowManager(nexusApp);
  } catch (error) {
    Logger.warn('TileConfig.preview.shadow.manager.failed', {
      tileId: app?.document?.id || null,
      error: String(error?.message || error)
    });
    return null;
  }
}

function getTileConfigShadowState(doc, app) {
  const manager = getShadowPreviewManager(app);
  const elevation = getDocumentElevation(doc);
  const elevationSettings = manager?.getElevationSettings?.(elevation) || null;
  const offsetState = getResolvedShadowOffsetState(doc);
  const capabilities = getFaNexusTileCapabilities(doc);
  const pathShadow = capabilities?.hasPathData && !capabilities?.requiresLegacyPathMigration
    ? getPathShadowUiState(doc)
    : (capabilities?.hasBuilding ? getBuildingShadowUiState(doc) : null);
  const isBuildingShadow = !!capabilities?.hasBuilding && !!pathShadow;
  return {
    alpha: pathShadow
      ? pathShadow.alpha
      : clampNumber(elevationSettings?.alpha, 0, 1, readFlagNumber(doc, 'shadowAlpha', DEFAULT_SHADOW_SETTINGS.alpha)),
    dilation: pathShadow
      ? pathShadow.dilation
      : Math.max(0, readFlagNumber(doc, 'shadowDilation', DEFAULT_SHADOW_SETTINGS.dilation)),
    blur: pathShadow
      ? pathShadow.blur
      : Math.max(0, normalizeNumber(elevationSettings?.blur, readFlagNumber(doc, 'shadowBlur', DEFAULT_SHADOW_SETTINGS.blur))),
    blurMax: pathShadow
      ? (isBuildingShadow ? BUILDING_SHADOW_BLUR_MAX : PATH_SHADOW_BLUR_MAX)
      : STANDARD_SHADOW_BLUR_MAX,
    offsetDistance: offsetState.offsetDistance,
    offsetAngle: offsetState.offsetAngle,
    offsetX: offsetState.offsetX,
    offsetY: offsetState.offsetY,
    offsetMode: pathShadow ? 'path-scalar' : 'radial',
    scale: pathShadow?.scale ?? PATH_SHADOW_SCALE_DEFAULT,
    scalePercent: pathShadow?.scalePercent ?? 100,
    scaleMin: isBuildingShadow ? BUILDING_SHADOW_SCALE_PERCENT_MIN : PATH_SHADOW_SCALE_PERCENT_MIN,
    scaleMax: isBuildingShadow ? BUILDING_SHADOW_SCALE_PERCENT_MAX : PATH_SHADOW_SCALE_PERCENT_MAX,
    scaleStep: PATH_SHADOW_SCALE_PERCENT_STEP,
    scaleDefault: 100,
    pathOffsetGrid: pathShadow?.offsetGrid ?? 0,
    pathOffsetPx: pathShadow?.offsetPx ?? 0,
    pathShadowCount: pathShadow?.count ?? 0,
    pathShadowManual: !!pathShadow?.manual,
    pathShadowEditMode: !!pathShadow?.editMode,
    pathShadowInconsistent: !!pathShadow?.inconsistentOffset,
    pathShadowInconsistentScale: !!pathShadow?.inconsistentScale,
    elevationContext: elevationSettings
  };
}

function buildLevelOptions(scene, explicitPlacementLevelId) {
  const ranges = getSceneLevelElevationRanges(scene);
  const options = [{
    value: '',
    label: 'Auto / Unset'
  }];
  for (const range of ranges) {
    options.push({
      value: String(range?.levelId || '').trim(),
      label: String(range?.levelName || range?.levelId || 'Level').trim() || 'Level'
    });
  }
  const explicitId = String(explicitPlacementLevelId || '').trim();
  if (explicitId && !options.some((option) => option.value === explicitId)) {
    options.push({
      value: explicitId,
      label: `(Missing Level) ${explicitId}`
    });
  }
  return options;
}

function buildBandStatus(doc, scene) {
  const explicitPlacementLevelId = getTileExplicitPlacementLevelId(doc);
  const resolvedPlacement = resolveTilePlacementLevelId(doc, { scene });
  const analysis = analyzeTileBandState(doc, { scene });
  if (analysis?.canApply && analysis?.kind === 'foreground') {
    const lowerName = String(analysis?.placementRange?.levelName || analysis?.placementLevelId || 'Level').trim() || 'Level';
    const upperName = String(analysis?.upperRange?.levelName || analysis?.upperRange?.levelId || 'Upper Level').trim() || 'Upper Level';
    return {
      tone: 'info',
      text: `Active FA band: Foreground from ${lowerName} to ${upperName}.`
    };
  }
  if (analysis?.canApply && analysis?.kind === 'ground') {
    const levelName = String(analysis?.placementRange?.levelName || analysis?.placementLevelId || 'Level').trim() || 'Level';
    return {
      tone: 'info',
      text: `Active FA band: Ground band on ${levelName}.`
    };
  }
  if (analysis?.inSpecialBand) {
    // The tile lies next to the floor or ceiling of a Level that is not its Parent Level (or it has none): it is
    // drawn like an ordinary tile. Say which Level that is, which Parent Level the tile has, and what to change.
    const nameOf = (range, fallback) => String(range?.levelName || range?.levelId || fallback).trim() || fallback;
    const candidates = Array.isArray(analysis.candidates) ? analysis.candidates : [];
    const bandLevels = [...new Set(candidates.map((candidate) => nameOf(candidate?.placementRange, 'a Level')))];
    const bands = [...new Set(candidates.map((candidate) => (
      `${candidate?.kind === 'foreground' ? 'foreground band' : 'ground band'} of ${nameOf(candidate?.placementRange, 'a Level')}`
    )))].join(' and the ');
    const parentId = explicitPlacementLevelId || resolvedPlacement?.levelId || null;
    const parentName = parentId ? String(scene?.levels?.get?.(parentId)?.name || '').trim() : '';
    const choose = bandLevels.length === 1 ? `Choose ${bandLevels[0]} as Parent Level` : `Choose one of ${bandLevels.join(', ')} as Parent Level`;
    return {
      tone: 'warn',
      text: parentName
        ? `This tile lies in the ${bands}, but its Parent Level is ${parentName}, so it is drawn like an ordinary tile. ${choose} to have it drawn in that band, or give the tile an elevation of ${parentName}.`
        : `This tile lies in the ${bands} and has no Parent Level, so it is drawn like an ordinary tile. ${choose} to have it drawn in that band.`
    };
  }
  if (explicitPlacementLevelId || resolvedPlacement?.levelId) {
    return {
      tone: 'info',
      text: 'Parent Level is stored, but FA band rendering only applies when this tile enters an FA ground or foreground band.'
    };
  }
  return {
    tone: 'muted',
    text: 'Parent Level is only needed for FA band rendering on multi-level tiles.'
  };
}

function buildRangeNumberInputs({
  name = '',
  value,
  min,
  max,
  step,
  defaultValue,
  dataAttributes = '',
  disabled = false,
  inputmode = 'decimal',
  ariaLabel = '',
  title = '',
  hiddenName = '',
  hiddenValue = '',
  hiddenDataAttributes = ''
} = {}) {
  const disabledAttr = disabled ? ' disabled' : '';
  const nameAttr = name ? ` name="${escapeHtml(name)}"` : '';
  const ariaAttr = ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : '';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  const normalizedDataAttributes = String(dataAttributes || '').trim();
  const normalizedHiddenDataAttributes = String(hiddenDataAttributes || '').trim();
  return `
        <input
          type="range"${nameAttr}
          min="${escapeHtml(min)}"
          max="${escapeHtml(max)}"
          step="${escapeHtml(step)}"
          value="${escapeHtml(value)}"
          data-fa-nexus-default-value="${escapeHtml(defaultValue)}"
          ${normalizedDataAttributes}
          ${ariaAttr}${disabledAttr}
        />
        <input
          type="number"
          class="fa-nexus-tool-options__value"
          min="${escapeHtml(min)}"
          max="${escapeHtml(max)}"
          step="${escapeHtml(step)}"
          value="${escapeHtml(value)}"
          inputmode="${escapeHtml(inputmode)}"
          data-fa-nexus-default-value="${escapeHtml(defaultValue)}"
          ${normalizedDataAttributes}
          ${titleAttr}${ariaAttr}${disabledAttr}
        />
        ${hiddenName
          ? `<input type="hidden" name="${escapeHtml(hiddenName)}" value="${escapeHtml(hiddenValue)}" ${normalizedHiddenDataAttributes} />`
          : ''}
  `;
}

function buildPathShadowOffsetHtml(shadow) {
  const offsetGrid = normalizePathShadowOffsetGrid(shadow.pathOffsetGrid);
  const hintParts = ['Shadow offset uses the same scalar slider as path and wall editors.'];
  if (shadow.pathShadowCount > 1) hintParts.push('Applying it here updates every path-style shadow on this tile.');
  if (shadow.pathShadowInconsistent) hintParts.push('This tile currently stores mixed path-shadow offsets; this slider will unify them.');
  if (shadow.pathShadowManual) hintParts.push('Changing it resets edited/manual shadow geometry back to auto.');
  if (shadow.pathShadowEditMode) hintParts.push('Offset is locked while path shadow edit mode is active.');
  const inputDisabled = !!shadow.pathShadowEditMode;
  return `
    <div class="form-group slim" data-fa-nexus-shadow-path-offset-row>
      <label>Offset</label>
      <div class="form-fields">
        ${buildRangeNumberInputs({
          value: offsetGrid,
          min: -PATH_SHADOW_OFFSET_GRID_RANGE,
          max: PATH_SHADOW_OFFSET_GRID_RANGE,
          step: PATH_SHADOW_OFFSET_GRID_STEP,
          defaultValue: 0,
          dataAttributes: `data-fa-nexus-shadow-path-offset data-initial-value="${escapeHtml(offsetGrid)}" data-edit-locked="${inputDisabled ? 'true' : 'false'}"`,
          disabled: inputDisabled,
          ariaLabel: 'Path shadow offset'
        })}
      </div>
      <p class="hint">${escapeHtml(hintParts.join(' '))}</p>
    </div>
  `;
}

function buildRadialShadowOffsetHtml(shadow, offsetMax) {
  const distance = Math.max(0, normalizeNumber(shadow.offsetDistance, DEFAULT_SHADOW_SETTINGS.offsetDistance));
  const angle = normalizeAngle(shadow.offsetAngle, DEFAULT_SHADOW_SETTINGS.offsetAngle);
  const offsetX = normalizeNumber(shadow.offsetX, 0);
  const offsetY = normalizeNumber(shadow.offsetY, 0);
  const maxDistance = clampNumber(offsetMax, 1, SHADOW_OFFSET_MAX_CEILING, DEFAULT_SHADOW_OFFSET_MAX);
  return `
    <div class="fa-nexus-drop-shadow__row fa-nexus-drop-shadow__offset" data-fa-nexus-shadow-offset-row>
      <div class="fa-nexus-drop-shadow__row-header">
        <span class="fa-nexus-drop-shadow__row-label">Offset</span>
        <div class="fa-nexus-drop-shadow__offset-values">
          <span class="fa-nexus-drop-shadow__offset-value">
            <span class="fa-nexus-drop-shadow__offset-value-label">Distance</span>
            <span class="fa-nexus-drop-shadow__offset-value-text" data-fa-nexus-shadow-offset-distance-display>${escapeHtml(formatShadowDisplay('offsetDistance', distance))}</span>
          </span>
          <span class="fa-nexus-drop-shadow__offset-value">
            <span class="fa-nexus-drop-shadow__offset-value-label">Max</span>
            <input
              type="number"
              class="fa-nexus-tool-options__value fa-nexus-drop-shadow__offset-max-input"
              min="1"
              max="${escapeHtml(SHADOW_OFFSET_MAX_CEILING)}"
              step="1"
              value="${escapeHtml(maxDistance)}"
              inputmode="numeric"
              data-fa-nexus-shadow-offset-max
              aria-label="Maximum shadow offset distance in pixels"
            />
          </span>
          <span class="fa-nexus-drop-shadow__offset-value">
            <span class="fa-nexus-drop-shadow__offset-value-label">Angle</span>
            <span class="fa-nexus-drop-shadow__offset-value-text" data-fa-nexus-shadow-offset-angle-display>${escapeHtml(formatShadowDisplay('offsetAngle', angle))}</span>
          </span>
        </div>
      </div>
      <div
        class="fa-nexus-drop-shadow__offset-control"
        data-fa-nexus-shadow-offset-control
        data-max-distance="${escapeHtml(maxDistance)}"
        data-disabled="false"
        role="application"
        aria-label="Shadow offset control"
      >
        <div class="fa-nexus-drop-shadow__offset-circle" data-fa-nexus-shadow-offset-circle>
          <div class="fa-nexus-drop-shadow__offset-crosshair fa-nexus-drop-shadow__offset-crosshair--x"></div>
          <div class="fa-nexus-drop-shadow__offset-crosshair fa-nexus-drop-shadow__offset-crosshair--y"></div>
          <div class="fa-nexus-drop-shadow__offset-handle" data-fa-nexus-shadow-offset-handle></div>
        </div>
      </div>
      <input type="hidden" name="flags.${MODULE_ID}.shadowOffsetDistance" value="${escapeHtml(distance)}" data-fa-nexus-shadow-field="offsetDistance" />
      <input type="hidden" name="flags.${MODULE_ID}.shadowOffsetAngle" value="${escapeHtml(angle)}" data-fa-nexus-shadow-field="offsetAngle" />
      <input type="hidden" name="flags.${MODULE_ID}.shadowOffsetX" value="${escapeHtml(offsetX)}" data-fa-nexus-shadow-field="offsetX" />
      <input type="hidden" name="flags.${MODULE_ID}.shadowOffsetY" value="${escapeHtml(offsetY)}" data-fa-nexus-shadow-field="offsetY" />
    </div>
  `;
}

function buildShadowOffsetHtml(shadow, offsetMax) {
  if (shadow?.offsetMode === 'path-scalar') return buildPathShadowOffsetHtml(shadow);
  return buildRadialShadowOffsetHtml(shadow, offsetMax);
}

// Quick HSBC is a control of the whole Tile: saving it gives every path of the Tile the values of the panel. On a
// Tile with several paths the panel says so, and says when the paths have colours of their own that it does not show.
function describePathHsbcScope(doc) {
  const paths = readModuleFlagRaw(doc, 'pathsV2')?.paths;
  if (!Array.isArray(paths)) return null;
  const drawn = paths.filter((entry) => entry && Array.isArray(entry.controlPoints));
  if (drawn.length < 2) return null;
  const tileHsbc = readDocumentHsbc(doc, { nullIfMissing: false, nullIfNeutral: false }) || createNeutralHsbc();
  const colours = new Set(drawn.map((entry) => JSON.stringify(normalizeHsbc(entry.hsbc ?? tileHsbc))));
  return {
    count: drawn.length,
    mixed: colours.size > 1,
    text: colours.size > 1
      ? `The ${drawn.length} paths of this tile have colour adjustments of their own that differ. They are not shown here, and saving Quick HSBC replaces them all with the values below. To change one path, use Nexus Edit.`
      : `Applies to all ${drawn.length} paths of this tile.`
  };
}

function buildTabHtml(app, doc, scene) {
  const capabilities = getFaNexusTileCapabilities(doc);
  const hsbc = readDocumentHsbc(doc, { nullIfMissing: false, nullIfNeutral: false }) || createNeutralHsbc();
  const hsbcEnabled = !isNeutralHsbc(hsbc);
  const pathHsbcScope = describePathHsbcScope(doc);
  const supportsShadowControls = supportsTileShadowControls(doc);
  const shadowEnabled = readFlagBoolean(doc, 'shadow', false);
  const shadow = getTileConfigShadowState(doc, app);
  const explicitPlacementLevelId = getTileExplicitPlacementLevelId(doc);
  const levelOptions = buildLevelOptions(scene, explicitPlacementLevelId);
  const bandStatus = buildBandStatus(doc, scene);
  const statusColor = bandStatus.tone === 'warn'
    ? '#a54700'
    : bandStatus.tone === 'info'
      ? '#2d5b84'
      : '#666';
  const shadowOffsetMax = readShadowOffsetUiMax();
  const pathShadowIsBuilding = shadow.offsetMode === 'path-scalar' && !!capabilities?.hasBuilding;

  const renderLevelOptions = levelOptions
    .map((option) => {
      const selected = option.value === String(explicitPlacementLevelId || '').trim() ? ' selected' : '';
      return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
    })
    .join('');

  const hsbcControls = [
    { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, value: getHsbcControlValue('hue', hsbc), defaultValue: 0 },
    { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, value: getHsbcControlValue('saturation', hsbc), defaultValue: 0 },
    { key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, value: getHsbcControlValue('brightness', hsbc), defaultValue: 0 },
    { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, value: getHsbcControlValue('contrast', hsbc), defaultValue: 0 }
  ].map((control) => {
    const hiddenValue = getHsbcFlagValue(control.key, control.value);
    return `
    <div class="form-group slim">
      <label>${escapeHtml(control.label)}</label>
      <div class="form-fields">
        ${buildRangeNumberInputs({
          value: control.value,
          min: control.min,
          max: control.max,
          step: control.step,
          defaultValue: control.defaultValue,
          dataAttributes: `data-fa-nexus-hsbc-field="${escapeHtml(control.key)}"`,
          ariaLabel: control.label,
          title: formatHsbcControlDisplay(control.key, control.value),
          hiddenName: `flags.${MODULE_ID}.hsbc.${control.key}`,
          hiddenValue,
          hiddenDataAttributes: `data-fa-nexus-hsbc-hidden="${escapeHtml(control.key)}"`
        })}
      </div>
    </div>
  `;
  }).join('');

  const pathShadowDefaultAlpha = pathShadowIsBuilding ? BUILDING_SHADOW_ALPHA_DEFAULT : PATH_SHADOW_ALPHA_DEFAULT;
  const pathShadowDefaultBlur = pathShadowIsBuilding ? BUILDING_SHADOW_BLUR_DEFAULT : PATH_SHADOW_BLUR_DEFAULT;
  const pathShadowDefaultDilation = pathShadowIsBuilding ? BUILDING_SHADOW_DILATION_DEFAULT : PATH_SHADOW_DILATION_DEFAULT;
  const renderShadowControls = (controls) => controls.map((control) => `
    <div class="form-group slim">
      <label>${escapeHtml(control.label)}</label>
      <div class="form-fields">
        ${buildRangeNumberInputs({
          name: control.key ? `flags.${MODULE_ID}.${control.key}` : '',
          value: control.value,
          min: control.min,
          max: control.max,
          step: control.step,
          defaultValue: control.defaultValue,
          dataAttributes: control.dataAttributes,
          ariaLabel: control.label,
          title: formatShadowDisplay(control.displayKey, control.value)
        })}
      </div>
    </div>
  `).join('');
  const tileShadowControls = renderShadowControls([
    ...(shadow.offsetMode === 'path-scalar'
      ? [{
        key: null,
        label: 'Scale',
        min: shadow.scaleMin,
        max: shadow.scaleMax,
        step: shadow.scaleStep,
        value: shadow.scalePercent,
        defaultValue: shadow.scaleDefault,
        displayKey: 'scale',
        dataAttributes: `data-fa-nexus-shadow-path-scale data-initial-value="${escapeHtml(shadow.scalePercent)}"`
      }]
      : []),
    {
      key: 'shadowDilation',
      label: 'Dilation',
      min: 0,
      max: SHADOW_DILATION_MAX,
      step: 0.1,
      value: roundNumber(shadow.dilation, 2),
      defaultValue: shadow.offsetMode === 'path-scalar' ? roundNumber(pathShadowDefaultDilation, 2) : DEFAULT_SHADOW_SETTINGS.dilation,
      displayKey: 'dilation',
      dataAttributes: 'data-fa-nexus-shadow-field="dilation"'
    }
  ]);
  const elevationShadowControls = renderShadowControls([
    {
      key: 'shadowAlpha',
      label: 'Opacity',
      min: 0,
      max: 1,
      step: 0.01,
      value: roundNumber(shadow.alpha, 2),
      defaultValue: shadow.offsetMode === 'path-scalar' ? roundNumber(pathShadowDefaultAlpha, 2) : DEFAULT_SHADOW_SETTINGS.alpha,
      displayKey: 'alpha',
      dataAttributes: 'data-fa-nexus-shadow-field="alpha"'
    },
    {
      key: 'shadowBlur',
      label: 'Blur',
      min: 0,
      max: shadow.blurMax,
      step: 0.1,
      value: roundNumber(shadow.blur, 2),
      defaultValue: shadow.offsetMode === 'path-scalar' ? roundNumber(pathShadowDefaultBlur, 2) : DEFAULT_SHADOW_SETTINGS.blur,
      displayKey: 'blur',
      dataAttributes: 'data-fa-nexus-shadow-field="blur"'
    }
  ]);

  return `
    <div class="tab scrollable" data-group="sheet" data-tab="${TAB_ID}" data-fa-nexus-tile-config-tab>
      <p class="hint">FA Nexus quick controls for band ownership, HSBC, and tile shadow preview.</p>

      <fieldset class="form-group stacked">
        <legend>Band Ownership</legend>
        <div class="form-group">
          <label>Parent Level</label>
          <div class="form-fields">
            <select name="flags.${MODULE_ID}.${FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG}">
              ${renderLevelOptions}
            </select>
          </div>
          <p class="hint">The Level this tile is drawn with when it lies next to that Level's floor or ceiling. It does not change which Levels show the tile; that is the tile's own Levels field.</p>
          <p class="hint" data-fa-nexus-band-status style="color: ${escapeHtml(statusColor)};">${escapeHtml(bandStatus.text)}</p>
        </div>
      </fieldset>

      <fieldset class="form-group stacked">
        <legend>HSBC</legend>
        <div class="form-group">
          <label>Quick HSBC</label>
          <div class="form-fields">
            <label class="checkbox">
              <input type="checkbox" data-fa-nexus-hsbc-enabled data-initial-checked="${hsbcEnabled ? 'true' : 'false'}"${hsbcEnabled ? ' checked' : ''} />
              Enable quick HSBC
            </label>
          </div>
          ${pathHsbcScope ? `<p class="hint" data-fa-nexus-hsbc-scope>${escapeHtml(pathHsbcScope.text)}</p>` : ''}
        </div>
        <div data-fa-nexus-hsbc-panel>
          ${hsbcControls}
        </div>
      </fieldset>

      ${capabilities?.hasStandardTileMask
        ? `
          <fieldset class="form-group stacked">
            <legend>Mask Tile</legend>
            <div class="form-group">
              <label>Tile Mask</label>
              <div class="form-fields">
                <button type="button" data-fa-nexus-clear-mask>
                  <i class="fa-solid fa-eraser" inert></i>
                  Clear Mask
                </button>
              </div>
              <p class="hint">Removes the FA Nexus mask from this tile.</p>
            </div>
          </fieldset>
        `
        : ''}

      ${supportsShadowControls
        ? `
          <fieldset class="form-group stacked">
            <legend>Shadow</legend>
            <div class="form-group">
              <label>Tile Shadow</label>
              <div class="form-fields">
                <label class="checkbox">
                  <input type="checkbox" name="flags.${MODULE_ID}.shadow"${shadowEnabled ? ' checked' : ''} data-fa-nexus-shadow-enabled />
                  Enable tile shadow
                </label>
              </div>
            </div>
            <div data-fa-nexus-shadow-panel>
              ${tileShadowControls}
              ${buildShadowOffsetHtml(shadow, shadowOffsetMax)}
              <div class="fa-nexus-shadow-scope-group">
                <div class="fa-nexus-shadow-scope-heading" data-fa-nexus-shadow-scope-heading>Elevation Shared</div>
                ${elevationShadowControls}
              </div>
            </div>
          </fieldset>
        `
        : `
          <fieldset class="form-group stacked">
            <legend>Shadow</legend>
            <p class="hint">Tile shadow quick controls are unavailable for texture tiles.</p>
          </fieldset>
        `}
    </div>
  `;
}

function buildTilePaletteFaNexusHtml(app) {
  const doc = app?.document || null;
  const scene = doc?.parent || canvas?.scene || null;
  const explicitPlacementLevelId = getTileExplicitPlacementLevelId(doc);
  const levelOptions = buildLevelOptions(scene, explicitPlacementLevelId);
  const renderLevelOptions = levelOptions
    .map((option) => {
      const selected = option.value === String(explicitPlacementLevelId || '').trim() ? ' selected' : '';
      return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
    })
    .join('');

  return `
    <details data-sync="fa-nexus-details" data-fa-nexus-tile-palette-section${tilePaletteFaNexusDetailsOpen ? ' open' : ''}>
      <summary>FA Nexus</summary>
      <fieldset>
        <legend data-action="closeDetails">FA Nexus</legend>
        <div class="form-group">
          <label>Parent Level</label>
          <div class="form-fields">
            <select name="${escapeHtml(TILE_PALETTE_PARENT_LEVEL_FIELD)}" data-fa-nexus-tile-palette-parent-level>
              ${renderLevelOptions}
            </select>
          </div>
          <p class="hint">The Level this tile is drawn with when it lies next to that Level's floor or ceiling. It does not change which Levels show the tile; that is the tile's own Levels field.</p>
        </div>
      </fieldset>
    </details>
  `;
}

function getTilePaletteControlledParentLevelValues(app) {
  if (!app?.isSelect) return [];
  const controlled = Array.isArray(app?.controlled) ? app.controlled : [];
  return controlled.map((doc) => getTileExplicitPlacementLevelId(doc) || '');
}

function hasTilePaletteMixedParentLevels(app) {
  const values = getTilePaletteControlledParentLevelValues(app);
  return values.length > 1 && new Set(values).size > 1;
}

function setTilePaletteParentLevelMultiPlaceholder(app, section) {
  if (!hasTilePaletteMixedParentLevels(app)) return;
  const select = section?.querySelector?.(TILE_PALETTE_PARENT_LEVEL_SELECTOR) || null;
  if (!select) return;
  const ownerDocument = select.ownerDocument || globalThis.document;
  if (!ownerDocument) return;
  const placeholder = ownerDocument.createElement('option');
  placeholder.textContent = game?.i18n?.localize?.('PLACEABLE_PALETTE.MultipleValues') || 'Multiple Values';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.dataset.multiPlaceholder = '';
  select.insertAdjacentElement('afterbegin', placeholder);
  select.selectedIndex = 0;
  select.classList.add('multiple-values');
}

function bindTilePaletteFaNexusSection(app, section) {
  if (!section) return;
  section.addEventListener('toggle', () => {
    tilePaletteFaNexusDetailsOpen = !!section.open;
  });

  const select = section.querySelector(TILE_PALETTE_PARENT_LEVEL_SELECTOR);
  select?.addEventListener('change', () => {
    select.querySelector('option[data-multi-placeholder]')?.remove();
    select.classList.remove('multiple-values');
    Logger.debug('TilePalette.parentLevel.changed', {
      placementLevelId: String(select.value || '').trim() || null,
      selectedCount: app?.controlled?.length ?? 0,
      isSelect: !!app?.isSelect
    });
  });
}

function inferStepDecimals(step) {
  const numeric = Number(step);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1) return 0;
  const text = String(step);
  const exponentMatch = text.match(/e-(\d+)$/i);
  if (exponentMatch) return Number(exponentMatch[1]) || 0;
  const dotIndex = text.indexOf('.');
  return dotIndex === -1 ? 0 : Math.max(0, text.length - dotIndex - 1);
}

function formatControlValue(value, step) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '');
  const decimals = inferStepDecimals(step);
  return String(Number(numeric.toFixed(decimals)));
}

function readLinkedNumericControlValue(input, { commit = false, logTag = 'TileConfig.control.invalidNumericInput' } = {}) {
  if (!input) return null;
  if (input.type === 'number') {
    if (!String(input.value || '').trim() || input.validity?.badInput) {
      if (commit) {
        Logger.warn(logTag, {
          field: input.dataset?.faNexusHsbcField || input.dataset?.faNexusShadowField || null,
          rawValue: input.value
        });
      }
      return null;
    }
  }
  const numeric = Number(input.value);
  if (!Number.isFinite(numeric)) {
    if (commit) {
      Logger.warn(logTag, {
        field: input.dataset?.faNexusHsbcField || input.dataset?.faNexusShadowField || null,
        rawValue: input.value
      });
    }
    return null;
  }
  return numeric;
}

function syncLinkedNumberControls(root, selector, source, { commit = false, logTag } = {}) {
  const controls = Array.from(root?.querySelectorAll?.(selector) || [])
    .filter((control) => control instanceof HTMLInputElement && (control.type === 'range' || control.type === 'number'));
  if (!controls.length || !source) return null;
  const rawValue = readLinkedNumericControlValue(source, { commit, logTag });
  if (rawValue === null) return null;
  const min = Number(source.min);
  const max = Number(source.max);
  const fallback = Number(source.dataset?.faNexusDefaultValue ?? source.defaultValue ?? 0);
  const value = clampNumber(
    rawValue,
    Number.isFinite(min) ? min : -Infinity,
    Number.isFinite(max) ? max : Infinity,
    Number.isFinite(fallback) ? fallback : 0
  );
  const formatted = formatControlValue(value, source.step || 'any');
  for (const control of controls) {
    if (control === source && control.value === formatted) continue;
    control.value = formatted;
    if (control.title) control.title = formatted;
  }
  return value;
}

function updateHsbcOutput(root, field, value) {
  const output = root.querySelector(`[data-fa-nexus-output="hsbc:${field}"]`);
  if (output) output.textContent = formatHsbcControlDisplay(field, value);
}

function updateShadowOutput(root, field, value) {
  const output = root.querySelector(`[data-fa-nexus-output="shadow:${field}"]`);
  if (output) output.textContent = formatShadowDisplay(field, value);
}

function syncHsbcControl(root, field, source, options = {}) {
  const value = syncLinkedNumberControls(root, `[data-fa-nexus-hsbc-field="${field}"]`, source, {
    commit: !!options.commit,
    logTag: 'TileConfig.hsbc.invalidNumericInput'
  });
  if (value === null) return null;
  const hidden = root?.querySelector?.(`[data-fa-nexus-hsbc-hidden="${field}"]`) || null;
  if (hidden) hidden.value = String(getHsbcFlagValue(field, value));
  updateHsbcOutput(root, field, value);
  return value;
}

function syncShadowControl(root, field, source, options = {}) {
  const value = syncLinkedNumberControls(root, `[data-fa-nexus-shadow-field="${field}"]`, source, {
    commit: !!options.commit,
    logTag: 'TileConfig.shadow.invalidNumericInput'
  });
  if (value === null) return null;
  updateShadowOutput(root, field, value);
  return value;
}

function syncPathShadowOffsetControl(root, source, options = {}) {
  const value = syncLinkedNumberControls(root, '[data-fa-nexus-shadow-path-offset]', source, {
    commit: !!options.commit,
    logTag: 'TileConfig.pathShadowOffset.invalidNumericInput'
  });
  if (value === null) return null;
  updateShadowOutput(root, 'pathOffset', value);
  return value;
}

function syncPathShadowScaleControl(root, source, options = {}) {
  const value = syncLinkedNumberControls(root, '[data-fa-nexus-shadow-path-scale]', source, {
    commit: !!options.commit,
    logTag: 'TileConfig.pathShadowScale.invalidNumericInput'
  });
  if (value === null) return null;
  updateShadowOutput(root, 'scale', value);
  return value;
}

function getShadowOffsetControlRuntime() {
  return {
    defaultSettings: DEFAULT_SHADOW_SETTINGS,
    offsetMaxCeiling: SHADOW_OFFSET_MAX_CEILING,
    normalizeNumber,
    clampNumber,
    normalizeAngle,
    computeShadowOffsetVector,
    formatShadowDisplay,
    readShadowOffsetUiMax,
    getAppState,
    schedulePreviewSync
  };
}

function updateShadowOffsetHeaderDisplay(root, { distance, angle } = {}) {
  return updateTileConfigShadowOffsetHeaderDisplay(root, { distance, angle }, getShadowOffsetControlRuntime());
}

function syncPanelState(panel, enabled, { opacity = '0.6' } = {}) {
  if (!panel) return;
  panel.style.opacity = enabled ? '1' : opacity;
  panel.style.pointerEvents = enabled ? '' : 'none';
}

function getPreviewDocument(app) {
  return app?._preview || null;
}

function createPreviewTileDocumentProxy(tile, doc) {
  if (!tile || !doc || tile.document === doc) return tile;
  return new Proxy(tile, {
    get(target, property, receiver) {
      if (property === 'document') return doc;
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      return Reflect.set(target, property, value, receiver);
    }
  });
}

function getPreviewTileForApp(app, previewDoc) {
  return previewDoc?.object || getLiveTileForDocument(app?.document) || app?.document?.object || null;
}

function buildPreviewSubmitData(app) {
  const FormDataExtended = globalThis?.foundry?.applications?.ux?.FormDataExtended;
  if (!FormDataExtended || !app?.form || typeof app?._prepareSubmitData !== 'function') return null;
  const formData = new FormDataExtended(app.form);
  return app._prepareSubmitData(null, app.form, formData);
}

function syncPreviewDocumentFromForm(app) {
  if (!app?.options?.preview || !app?._preview || typeof app?._previewChanges !== 'function') return false;
  try {
    const submitData = buildPreviewSubmitData(app);
    if (!submitData) return false;
    applyCustomRendererHsbcSubmit(app, submitData);
    app._previewChanges(submitData);
    return true;
  } catch (error) {
    Logger.warn('TileConfig.preview.sync.failed', {
      tileId: app?.document?.id || null,
      error: String(error?.message || error)
    });
    return false;
  }
}

function updateBandStatus(root, app) {
  const previewDoc = getPreviewDocument(app) || app?.document || null;
  if (!previewDoc) return;
  const scene = previewDoc.parent || app?.document?.parent || canvas?.scene;
  const status = buildBandStatus(previewDoc, scene);
  const node = root.querySelector('[data-fa-nexus-band-status]');
  if (!node) return;
  node.textContent = status.text;
  node.style.color = status.tone === 'warn'
    ? '#a54700'
    : status.tone === 'info'
      ? '#2d5b84'
      : '#666';
}

function applyPreviewHsbc(app) {
  const previewDoc = getPreviewDocument(app);
  const previewTile = getPreviewTileForApp(app, previewDoc);
  if (!previewDoc || !previewTile) return;
  const state = getAppState(app);
  state.hsbcPreviewSequence = Number(state.hsbcPreviewSequence || 0) + 1;
  const previewSequence = state.hsbcPreviewSequence;
  const previewRenderTile = createPreviewTileDocumentProxy(previewTile, previewDoc);
  const capabilities = getFaNexusTileCapabilities(previewDoc);
  const rendererJobs = [];
  const needsDeferredMaskHsbc = !!(capabilities?.hasMaskedTiling || capabilities?.hasStandardTileMask);
  const applyPreviewMaskHsbc = () => {
    try { applyTileHsbcToMesh(previewRenderTile, previewTile.mesh); } catch (error) {
      Logger.warn('TileConfig.preview.hsbc.maskedApply.failed', {
        tileId: app?.document?.id || null,
        error: String(error?.message || error)
      });
    }
  };
  const queueRendererJob = (label, promiseFactory) => {
    const job = Promise.resolve()
      .then(promiseFactory)
      .catch((error) => {
        Logger.warn(`TileConfig.preview.hsbc.${label}.failed`, {
          tileId: app?.document?.id || null,
          error: String(error?.message || error)
        });
      });
    rendererJobs.push(job);
  };
  if (capabilities?.hasAssetScatter) {
    queueRendererJob('scatterApply', () => applyAssetScatterTile(previewRenderTile));
  }
  if (capabilities?.hasPathV2 || capabilities?.hasPathsV2) {
    queueRendererJob('pathApply', () => applyPathTile(previewRenderTile));
  }
  if (capabilities?.hasMaskedTiling) {
    queueRendererJob('maskedApply', () => applyMaskedTilingToTile(previewRenderTile));
  }
  if (capabilities?.hasBuilding) {
    try { applyBuildingTileHsbcToExistingRenderer(previewRenderTile); } catch (error) {
      Logger.warn('TileConfig.preview.hsbc.buildingPreview.failed', {
        tileId: app?.document?.id || null,
        error: String(error?.message || error)
      });
    }
  }
  if (capabilities?.hasStandardTileMask) {
    Promise.allSettled(rendererJobs)
      .then(async () => {
        if (getAppState(app).hsbcPreviewSequence !== previewSequence) return;
        await applyStandardTileMaskToTile(previewRenderTile);
        if (getAppState(app).hsbcPreviewSequence !== previewSequence) {
          schedulePreviewSync(app, getTileConfigTabRoot(app), { hsbc: true, shadow: false });
          return;
        }
        applyPreviewMaskHsbc();
      })
      .catch((error) => {
        Logger.warn('TileConfig.preview.hsbc.standardMaskApply.failed', {
          tileId: app?.document?.id || null,
          error: String(error?.message || error)
        });
      });
  } else if (capabilities?.hasMaskedTiling) {
    Promise.allSettled(rendererJobs).then(() => {
      if (getAppState(app).hsbcPreviewSequence !== previewSequence) return;
      applyPreviewMaskHsbc();
    });
  }
  try { applyTileHsbc(previewDoc); } catch (error) {
    Logger.warn('TileConfig.preview.hsbc.apply.failed', {
      tileId: app?.document?.id || null,
      error: String(error?.message || error)
    });
  }
  if (!needsDeferredMaskHsbc) applyPreviewMaskHsbc();
}

function applyImmediateBuildingPreviewHsbc(app) {
  const previewDoc = getPreviewDocument(app);
  const previewTile = getPreviewTileForApp(app, previewDoc);
  if (!previewDoc || !previewTile || !getFaNexusTileCapabilities(previewDoc)?.hasBuilding) return;
  const previewRenderTile = createPreviewTileDocumentProxy(previewTile, previewDoc);
  try { applyBuildingTileHsbcToExistingRenderer(previewRenderTile); } catch (error) {
    Logger.warn('TileConfig.preview.hsbc.buildingImmediate.failed', {
      tileId: app?.document?.id || null,
      error: String(error?.message || error)
    });
  }
}

function getLiveTileForDocument(doc) {
  if (!doc) return null;
  const direct = doc.object || null;
  if (direct?.document === doc || direct?.document?.id === doc.id || direct?.id === doc.id) return direct;
  const placeables = canvas?.tiles?.placeables;
  if (Array.isArray(placeables)) {
    return placeables.find((tile) => tile?.document === doc || tile?.document?.id === doc.id || tile?.id === doc.id) || null;
  }
  return null;
}

const tileConfigSubmitWorkflow = new TileConfigSubmitWorkflow({
  Logger,
  getFaNexusTileCapabilities,
  getLiveTileForDocument,
  createPreviewTileDocumentProxy,
  applyAssetScatterTile,
  applyPathTile,
  applyBuildingTile,
  applyMaskedTilingToTile,
  applyStandardTileMaskToTile,
  applyTileHsbc,
  applyTileHsbcToMesh,
  applyCustomRendererHsbcSubmit,
  applyPathShadowOffsetSubmit,
  applyBuildingPathShadowSubmit,
  supportsTileShadowControls,
  buildElevationShadowSubmit,
  stripElevationShadowSubmit,
  getShadowPreviewManager,
  getDocumentElevation,
  shouldApplyElevationShadowSettings
});

async function refreshCustomRenderedTileDocument(doc, { reason = 'tile-config-close' } = {}) {
  return tileConfigSubmitWorkflow.refreshCustomRenderedTileDocument(doc, { reason });
}

function scheduleCustomRendererRefreshAfterClose(app, { reason = 'tile-config-close' } = {}) {
  return tileConfigSubmitWorkflow.scheduleCustomRendererRefreshAfterClose(app, { reason });
}

function cleanupPreviewShadow(app) {
  const state = getAppState(app);
  try { state.shadow.pointerCleanup?.(); } catch (_) {}
  if (state.syncFrame) {
    try { cancelAnimationFrame(state.syncFrame); } catch (_) {}
    state.syncFrame = 0;
  }
  if (state.shadow.layoutSyncFrame) {
    try { cancelAnimationFrame(state.shadow.layoutSyncFrame); } catch (_) {}
    state.shadow.layoutSyncFrame = 0;
  }
  try { state.shadow.layoutObserver?.disconnect?.(); } catch (_) {}
  state.shadow.pointerCleanup = null;
  state.shadow.layoutObserver = null;
  const manager = getShadowPreviewManager(app);
  try { manager?.clearTilePreviewShadowOverride?.(app?.document, { immediate: false }); } catch (_) {}
  if (Number.isFinite(state.shadow.previewElevation)) {
    try { manager?.clearElevationPreviewShadowOverride?.(state.shadow.previewElevation, { immediate: false }); } catch (_) {}
  }
  state.shadow.previewElevation = null;
}

function cleanupPreviewHsbc(app) {
  const doc = app?.document || null;
  if (!doc) return;
  const tile = getLiveTileForDocument(doc) || doc.object || null;
  try { applyTileHsbc(doc); } catch (error) {
    Logger.warn('TileConfig.preview.hsbc.cleanupApply.failed', {
      tileId: doc?.id || null,
      error: String(error?.message || error)
    });
  }
  try { applyTileHsbcToMesh(tile || doc, tile?.mesh); } catch (error) {
    Logger.warn('TileConfig.preview.hsbc.cleanupMeshApply.failed', {
      tileId: doc?.id || null,
      error: String(error?.message || error)
    });
  }
  try { applyBuildingTileHsbcToExistingRenderer(tile); } catch (error) {
    Logger.warn('TileConfig.preview.hsbc.buildingCleanup.failed', {
      tileId: doc?.id || null,
      error: String(error?.message || error)
    });
  }
}

function applyPreviewShadow(app, root = null) {
  const doc = app?.document || null;
  if (!doc) return;
  const manager = getShadowPreviewManager(app);
  if (!manager) return;
  const state = getAppState(app);
  if (!supportsTileShadowControls(doc)) {
    manager.clearTilePreviewShadowOverride?.(doc, { immediate: true });
    if (Number.isFinite(state.shadow.previewElevation)) {
      manager.clearElevationPreviewShadowOverride?.(state.shadow.previewElevation, { immediate: false });
      state.shadow.previewElevation = null;
    }
    return;
  }
  const previewDoc = getPreviewDocument(app) || doc;
  const tileOverride = {
    enabled: readFlagBoolean(previewDoc, 'shadow', false),
    shadowDilation: Math.max(0, readFlagNumber(previewDoc, 'shadowDilation', DEFAULT_SHADOW_SETTINGS.dilation))
  };
  const pathOffsetState = readPathShadowOffsetControlState(root, previewDoc);
  const pathScaleState = readPathShadowScaleControlState(root);
  if (pathOffsetState || pathScaleState) {
    if (pathOffsetState) tileOverride.pathShadowOffsetPx = pathOffsetState.offsetPx;
    if (pathScaleState) tileOverride.pathShadowScale = pathScaleState.scale;
  } else {
    const offsetState = getResolvedShadowOffsetState(previewDoc);
    tileOverride.shadowOffsetDistance = offsetState.offsetDistance;
    tileOverride.shadowOffsetAngle = offsetState.offsetAngle;
    tileOverride.shadowOffsetX = offsetState.offsetX;
    tileOverride.shadowOffsetY = offsetState.offsetY;
  }
  const elevation = getDocumentElevation(previewDoc, getDocumentElevation(doc));
  const elevationOverride = {
    shadowAlpha: clampNumber(readFlagNumber(previewDoc, 'shadowAlpha', DEFAULT_SHADOW_SETTINGS.alpha), 0, 1, DEFAULT_SHADOW_SETTINGS.alpha),
    shadowBlur: Math.max(0, readFlagNumber(previewDoc, 'shadowBlur', DEFAULT_SHADOW_SETTINGS.blur))
  };
  try {
    if (Number.isFinite(state.shadow.previewElevation) && state.shadow.previewElevation !== elevation) {
      manager.clearElevationPreviewShadowOverride?.(state.shadow.previewElevation, { immediate: false });
      state.shadow.previewElevation = null;
    }
    manager.setTilePreviewShadowOverride?.(doc, tileOverride, { immediate: false });
    manager.setElevationPreviewShadowOverride?.(elevation, elevationOverride, { immediate: false });
    state.shadow.previewElevation = elevation;
  } catch (error) {
    Logger.warn('TileConfig.preview.shadow.apply.failed', {
      tileId: doc?.id || null,
      error: String(error?.message || error)
    });
  }
}

function normalizePreviewSyncOptions(options = {}) {
  return {
    bandStatus: options?.bandStatus !== false,
    hsbc: options?.hsbc !== false,
    shadow: options?.shadow !== false
  };
}

function finalizePreviewSync(app, root, options = {}) {
  const syncOptions = normalizePreviewSyncOptions(options);
  try {
    if (syncOptions.bandStatus) updateBandStatus(root, app);
    if (syncOptions.hsbc) applyPreviewHsbc(app);
    if (syncOptions.shadow) applyPreviewShadow(app, root);
  } catch (error) {
    Logger.warn('TileConfig.preview.finalize.failed', {
      tileId: app?.document?.id || null,
      error: String(error?.message || error)
    });
  }
}

function schedulePreviewSync(app, root = null, options = {}) {
  const state = getAppState(app);
  const targetRoot = root || getTileConfigTabRoot(app);
  const syncOptions = normalizePreviewSyncOptions(options);
  syncPreviewDocumentFromForm(app);
  if (syncOptions.hsbc) applyImmediateBuildingPreviewHsbc(app);
  if (state.syncFrame) {
    try { cancelAnimationFrame(state.syncFrame); } catch (_) {}
  }
  state.syncFrame = requestAnimationFrame(() => {
    state.syncFrame = 0;
    finalizePreviewSync(app, targetRoot, syncOptions);
  });
}

function syncShadowOffsetHandle(root) {
  return syncTileConfigShadowOffsetHandle(root, getShadowOffsetControlRuntime());
}

function queueShadowOffsetLayoutSync(app, root) {
  return queueTileConfigShadowOffsetLayoutSync(app, root, getShadowOffsetControlRuntime());
}

function updateShadowOffsetInputs(root, {
  distance = DEFAULT_SHADOW_SETTINGS.offsetDistance,
  angle = DEFAULT_SHADOW_SETTINGS.offsetAngle
} = {}) {
  return updateTileConfigShadowOffsetInputs(root, { distance, angle }, getShadowOffsetControlRuntime());
}

function bindShadowOffsetControl(app, root) {
  return bindTileConfigShadowOffsetControl(app, root, getShadowOffsetControlRuntime());
}

function bindTab(root, app) {
  const hsbcToggle = root.querySelector('[data-fa-nexus-hsbc-enabled]');
  const hsbcPanel = root.querySelector('[data-fa-nexus-hsbc-panel]');
  const shadowToggle = root.querySelector('[data-fa-nexus-shadow-enabled]');
  const shadowPanel = root.querySelector('[data-fa-nexus-shadow-panel]');
  if (!hsbcToggle || !hsbcPanel) return;

  root.addEventListener('contextmenu', (event) => {
    const input = event.target?.closest?.('input[data-fa-nexus-default-value]');
    if (!(input instanceof HTMLInputElement) || !root.contains(input) || input.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    input.value = input.getAttribute('data-fa-nexus-default-value') ?? '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const hsbcNeutral = {
    hue: 0,
    saturation: 0,
    brightness: 0,
    contrast: 0
  };

  const syncHsbcPanel = () => {
    const enabled = !!hsbcToggle.checked;
    syncPanelState(hsbcPanel, enabled);
  };

  const syncShadowPanel = () => {
    if (!shadowToggle || !shadowPanel) return;
    const enabled = !!shadowToggle.checked;
    syncPanelState(shadowPanel, enabled, { opacity: '0.7' });
    const control = root.querySelector('[data-fa-nexus-shadow-offset-control]');
    if (control) {
      control.dataset.disabled = enabled ? 'false' : 'true';
      control.classList.toggle('is-disabled', !enabled);
    }
    for (const pathOffsetInput of root.querySelectorAll('[data-fa-nexus-shadow-path-offset]')) {
      pathOffsetInput.disabled = !enabled || pathOffsetInput.dataset.editLocked === 'true';
    }
    for (const pathScaleInput of root.querySelectorAll('[data-fa-nexus-shadow-path-scale]')) {
      pathScaleInput.disabled = !enabled;
    }
    syncShadowOffsetHandle(root);
  };

  hsbcToggle.addEventListener('change', () => {
    hsbcToggle.dataset.touched = 'true';
    if (!hsbcToggle.checked) {
      for (const [field, neutralValue] of Object.entries(hsbcNeutral)) {
        const input = root.querySelector(`[data-fa-nexus-hsbc-field="${field}"]`);
        if (!input) continue;
        input.value = String(neutralValue);
        syncHsbcControl(root, field, input, { commit: true });
      }
    }
    syncHsbcPanel();
    schedulePreviewSync(app, root, { hsbc: true, shadow: false });
  });

  for (const field of ['hue', 'saturation', 'brightness', 'contrast']) {
    for (const input of root.querySelectorAll(`[data-fa-nexus-hsbc-field="${field}"]`)) {
      input.addEventListener('input', (event) => {
        hsbcToggle.dataset.touched = 'true';
        if (syncHsbcControl(root, field, event.currentTarget, { commit: false }) !== null) {
          schedulePreviewSync(app, root, { hsbc: true, shadow: false });
        }
      });
      input.addEventListener('change', (event) => {
        hsbcToggle.dataset.touched = 'true';
        if (syncHsbcControl(root, field, event.currentTarget, { commit: true }) !== null) {
          schedulePreviewSync(app, root, { hsbc: true, shadow: false });
        }
      });
    }
  }

  for (const field of ['hue', 'saturation', 'brightness', 'contrast']) {
    const input = root.querySelector(`[data-fa-nexus-hsbc-field="${field}"]`);
    if (input) syncHsbcControl(root, field, input);
  }

  if (shadowToggle && shadowPanel) {
    shadowToggle.addEventListener('change', () => {
      syncShadowPanel();
      schedulePreviewSync(app, root, { hsbc: false, shadow: true });
    });

    for (const field of ['alpha', 'dilation', 'blur']) {
      for (const input of root.querySelectorAll(`[data-fa-nexus-shadow-field="${field}"]`)) {
        input.addEventListener('input', (event) => {
          if (syncShadowControl(root, field, event.currentTarget, { commit: false }) !== null) {
            schedulePreviewSync(app, root, { hsbc: false, shadow: true });
          }
        });
        input.addEventListener('change', (event) => {
          if (syncShadowControl(root, field, event.currentTarget, { commit: true }) !== null) {
            schedulePreviewSync(app, root, { hsbc: false, shadow: true });
          }
        });
      }
      const input = root.querySelector(`[data-fa-nexus-shadow-field="${field}"]`);
      if (input) syncShadowControl(root, field, input);
    }

    for (const input of root.querySelectorAll('[data-fa-nexus-shadow-path-offset]')) {
      input.addEventListener('input', (event) => {
        if (syncPathShadowOffsetControl(root, event.currentTarget, { commit: false }) !== null) {
          schedulePreviewSync(app, root, { hsbc: false, shadow: true });
        }
      });
      input.addEventListener('change', (event) => {
        if (syncPathShadowOffsetControl(root, event.currentTarget, { commit: true }) !== null) {
          schedulePreviewSync(app, root, { hsbc: false, shadow: true });
        }
      });
    }
    const pathOffsetInput = root.querySelector('[data-fa-nexus-shadow-path-offset]');
    if (pathOffsetInput) syncPathShadowOffsetControl(root, pathOffsetInput);

    for (const input of root.querySelectorAll('[data-fa-nexus-shadow-path-scale]')) {
      input.addEventListener('input', (event) => {
        if (syncPathShadowScaleControl(root, event.currentTarget, { commit: false }) !== null) {
          schedulePreviewSync(app, root, { hsbc: false, shadow: true });
        }
      });
      input.addEventListener('change', (event) => {
        if (syncPathShadowScaleControl(root, event.currentTarget, { commit: true }) !== null) {
          schedulePreviewSync(app, root, { hsbc: false, shadow: true });
        }
      });
    }
    const pathScaleInput = root.querySelector('[data-fa-nexus-shadow-path-scale]');
    if (pathScaleInput) syncPathShadowScaleControl(root, pathScaleInput);

    bindShadowOffsetControl(app, root);
  }

  const clearMaskButton = root.querySelector('[data-fa-nexus-clear-mask]');
  clearMaskButton?.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const doc = app?.document || null;
    if (!doc) return;
    clearMaskButton.disabled = true;
    try {
      await clearStandardTileMask(doc, { reason: 'tile-config' });
      ui?.notifications?.info?.('Cleared tile mask.');
      requestLayerManagerSelectionSync({
        tileId: doc?.id || null,
        allowAutoExpand: false,
        allowScrollToTile: false
      });
      try { app?.render?.(true); } catch (_) {}
    } catch (error) {
      Logger.error('TileConfig.clearMask.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      ui?.notifications?.error?.(`Failed to clear tile mask: ${error?.message || error}`);
      clearMaskButton.disabled = false;
    }
  });

  const parentLevelSelect = root.querySelector(`select[name="${TILE_PALETTE_PARENT_LEVEL_FIELD}"]`);
  parentLevelSelect?.addEventListener('change', () => {
    schedulePreviewSync(app, root, { hsbc: false, shadow: false });
  });

  syncHsbcPanel();
  syncShadowPanel();
  updateBandStatus(root, app);
}

// Fields whose values only make sense together are kept or dropped together.
const UNTOUCHED_FIELD_GROUPS = Object.freeze([
  ['shadowAlpha', 'shadowBlur'],
  ['shadowOffsetDistance', 'shadowOffsetAngle', 'shadowOffsetX', 'shadowOffsetY']
].map((keys) => keys.map((key) => `flags.${MODULE_ID}.${key}`)));

function readControlValue(element) {
  return element.type === 'checkbox' || element.type === 'radio'
    ? `${element.value}:${element.checked}`
    : String(element.value);
}

function readNexusFieldValues(form) {
  const values = new Map();
  for (const element of form?.querySelectorAll?.(`[name^="flags.${MODULE_ID}."]`) || []) {
    const value = readControlValue(element);
    values.set(element.name, values.has(element.name) ? `${values.get(element.name)}|${value}` : value);
  }
  return values;
}

// Every control of the FA Nexus tab, named or not (the Path scale and offset sliders are not).
function readNexusTabSignature(form) {
  const root = form?.querySelector?.(TAB_SELECTOR) || null;
  return JSON.stringify(Array.from(root?.querySelectorAll?.('input, select, textarea') || [], readControlValue));
}

function captureInitialNexusFieldValues(app, host) {
  const state = getAppState(app);
  state.initialFieldValues = readNexusFieldValues(host);
  state.initialTabSignature = readNexusTabSignature(host);
}

// Removing a nested field (`hsbc.hue`) must not leave its emptied parent behind: an empty
// object would be written where the Tile had none.
function dropEmptiedNexusContainers(submitData) {
  const prune = (container) => {
    for (const [key, value] of Object.entries(container)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) continue;
      prune(value);
      if (!Object.keys(value).length) delete container[key];
    }
  };
  const flags = submitData?.flags;
  if (!flags || typeof flags !== 'object' || !flags[MODULE_ID] || typeof flags[MODULE_ID] !== 'object') return;
  prune(flags[MODULE_ID]);
  if (!Object.keys(flags[MODULE_ID]).length) delete flags[MODULE_ID];
  if (!Object.keys(flags).length) delete submitData.flags;
}

// A control the user did not touch must not write. A range input snaps the stored value to
// its step, the hidden offset inputs are re-derived (a zero-length offset loses its angle) and
// submit as strings, Opacity and Blur show the elevation band's shared values rather than the
// Tile's own, and the Path and Building shadow steps rewrite their data from whatever the form
// holds. Saving the form unchanged used to rewrite all of them, on this Tile and on every
// other shadowed Tile at its elevation.
//
// Returns false when nothing in the FA Nexus tab was changed: every Nexus field is then removed
// from the submission and the Nexus submit steps are skipped. Otherwise only the grouped
// fields are removed, and only when their whole group was left alone.
function pruneUntouchedNexusFields(app, form, submitData) {
  const state = getAppState(app);
  const initial = state.initialFieldValues;
  if (!(initial instanceof Map) || !form || !submitData || typeof submitData !== 'object') return true;
  const current = readNexusFieldValues(form);
  const untouched = (name) => initial.has(name) && current.get(name) === initial.get(name);
  if (readNexusTabSignature(form) === state.initialTabSignature && [...current.keys()].every(untouched)) {
    for (const name of current.keys()) deleteSubmitDataValue(submitData, name);
    dropEmptiedNexusContainers(submitData);
    return false;
  }
  for (const group of UNTOUCHED_FIELD_GROUPS) {
    const present = group.filter((name) => current.has(name));
    if (present.length && present.every(untouched)) {
      for (const name of present) deleteSubmitDataValue(submitData, name);
    }
  }
  dropEmptiedNexusContainers(submitData);
  return true;
}

function hasSubmitDataValue(formData, key) {
  return readSubmitDataValue(formData, key, undefined) !== undefined;
}

function buildElevationShadowSubmit(app, formData) {
  const doc = app?.document || null;
  // Opacity and Blur belong to the whole elevation band. Left untouched, neither is applied.
  if (!hasSubmitDataValue(formData, `flags.${MODULE_ID}.shadowAlpha`)
    && !hasSubmitDataValue(formData, `flags.${MODULE_ID}.shadowBlur`)) return null;
  return {
    alpha: clampNumber(
      readSubmitDataValue(formData, `flags.${MODULE_ID}.shadowAlpha`, readFlagNumber(doc, 'shadowAlpha', DEFAULT_SHADOW_SETTINGS.alpha)),
      0,
      1,
      DEFAULT_SHADOW_SETTINGS.alpha
    ),
    blur: Math.max(
      0,
      normalizeNumber(
        readSubmitDataValue(formData, `flags.${MODULE_ID}.shadowBlur`, readFlagNumber(doc, 'shadowBlur', DEFAULT_SHADOW_SETTINGS.blur)),
        DEFAULT_SHADOW_SETTINGS.blur
      )
    )
  };
}

function stripElevationShadowSubmit(formData) {
  deleteSubmitDataValue(formData, `flags.${MODULE_ID}.shadowAlpha`);
  deleteSubmitDataValue(formData, `flags.${MODULE_ID}.shadowBlur`);
}

function readPathShadowOffsetControlState(root, doc) {
  const input = root?.querySelector?.('[data-fa-nexus-shadow-path-offset]') || null;
  if (!input) return null;
  const offsetGrid = normalizePathShadowOffsetGrid(input.value);
  const initialGrid = normalizePathShadowOffsetGrid(input.dataset.initialValue ?? offsetGrid);
  return {
    offsetGrid,
    offsetPx: convertPathShadowOffsetGridToPx(offsetGrid, doc?.parent || canvas?.scene),
    changed: !approxNumber(offsetGrid, initialGrid)
  };
}

function readPathShadowScaleControlState(root, shadowState = null) {
  const input = root?.querySelector?.('[data-fa-nexus-shadow-path-scale]') || null;
  if (!input) return null;
  const min = Number(input.min);
  const max = Number(input.max);
  const scalePercent = normalizePercent(
    input.value,
    Number.isFinite(min) ? min : PATH_SHADOW_SCALE_PERCENT_MIN,
    Number.isFinite(max) ? max : PATH_SHADOW_SCALE_PERCENT_MAX,
    100
  );
  const initialPercent = normalizePercent(
    input.dataset.initialValue ?? shadowState?.scalePercent ?? scalePercent,
    Number.isFinite(min) ? min : PATH_SHADOW_SCALE_PERCENT_MIN,
    Number.isFinite(max) ? max : PATH_SHADOW_SCALE_PERCENT_MAX,
    100
  );
  return {
    scalePercent,
    scale: shadowScalePercentToRatio(
      scalePercent,
      Number.isFinite(min) ? min : PATH_SHADOW_SCALE_PERCENT_MIN,
      Number.isFinite(max) ? max : PATH_SHADOW_SCALE_PERCENT_MAX
    ),
    changed: !approxNumber(scalePercent, initialPercent)
  };
}

function applyPathShadowOffsetSubmit(appInstance, submitData) {
  const doc = appInstance?.document || null;
  if (!doc || !getFaNexusTileCapabilities(doc)?.hasPathData) return false;
  const root = getTileConfigTabRoot(appInstance);
  const offsetState = readPathShadowOffsetControlState(root, doc);
  const existingUiState = getPathShadowUiState(doc);
  const scaleState = readPathShadowScaleControlState(root, existingUiState);
  const wantsShadowEnabled = readSubmitShadowEnabled(submitData, doc);

  const payloadState = (() => {
    const merged = buildSubmitDataBranchValue(submitData, `flags.${MODULE_ID}.pathsV2`, readModuleFlagRaw(doc, 'pathsV2'));
    if (merged && Array.isArray(merged.paths) && merged.paths.some((entry) => entry && Array.isArray(entry.controlPoints))) {
      return {
        key: 'pathsV2',
        payload: merged,
        entries: merged.paths.filter((entry) => entry && Array.isArray(entry.controlPoints))
      };
    }
    const v2 = buildSubmitDataBranchValue(submitData, `flags.${MODULE_ID}.pathV2`, readModuleFlagRaw(doc, 'pathV2'));
    if (v2 && Array.isArray(v2.controlPoints)) {
      return {
        key: 'pathV2',
        payload: v2,
        entries: [v2]
      };
    }
    return null;
  })();
  if (!payloadState?.entries?.length || !payloadState?.key) {
    if (!offsetState?.changed && !scaleState?.changed && !wantsShadowEnabled) return false;
    Logger.error('TileConfig.pathShadow.submit.missingPayload', {
      tileId: doc?.id || null,
      requiresLegacyPathMigration: !!getFaNexusTileCapabilities(doc)?.requiresLegacyPathMigration
    });
    return false;
  }
  const needsEnable = wantsShadowEnabled && payloadState.entries.some((entry) => !entry?.shadow?.enabled);
  const hasShadowSettingsChange = payloadState.entries.some((entry) => {
    const existingShadow = entry?.shadow || {};
    const shadowSettings = readSubmitShadowSettings(submitData, doc, existingShadow);
    const nextScale = scaleState?.scale ?? Math.max(0.05, normalizeNumber(existingShadow.scale, PATH_SHADOW_SCALE_DEFAULT));
    return !approxNumber(shadowSettings.alpha, existingShadow.alpha ?? PATH_SHADOW_ALPHA_DEFAULT)
      || !approxNumber(shadowSettings.blur, existingShadow.blur ?? PATH_SHADOW_BLUR_DEFAULT)
      || !approxNumber(shadowSettings.dilation, existingShadow.dilation ?? PATH_SHADOW_DILATION_DEFAULT)
      || !approxNumber(nextScale, Math.max(0.05, normalizeNumber(existingShadow.scale, PATH_SHADOW_SCALE_DEFAULT)));
  });
  if (!offsetState?.changed && !scaleState?.changed && !needsEnable && !hasShadowSettingsChange) return false;

  const clonedPayload = cloneSubmitDataValue(payloadState.payload);
  const clonedEntries = payloadState.key === 'pathsV2'
    ? clonedPayload?.paths
    : [clonedPayload];
  const nextOffsetPx = roundNumber(
    offsetState?.changed ? offsetState.offsetPx : (existingUiState?.offsetPx ?? 0),
    3
  );

  for (const entry of clonedEntries) {
    if (!entry || !Array.isArray(entry.controlPoints) || entry.controlPoints.length < 2) {
      Logger.error('TileConfig.pathShadow.submit.invalidControlPoints', {
        tileId: doc?.id || null,
        payloadKey: payloadState.key
      });
      throw new Error('Path shadow offset submit requires control points.');
    }
    const nextPoints = computePathShadowPoints(entry.controlPoints, nextOffsetPx, {
      closed: !!entry.closed,
      feather: entry.feather || null
    });
    if (!Array.isArray(nextPoints) || nextPoints.length < 2) {
      Logger.error('TileConfig.pathShadow.submit.invalidShadowPoints', {
        tileId: doc?.id || null,
        payloadKey: payloadState.key,
        offsetPx: nextOffsetPx
      });
      throw new Error('Path shadow offset submit failed to derive shadow points.');
    }
    const existingShadow = entry.shadow || {};
    const shadowSettings = readSubmitShadowSettings(submitData, doc, existingShadow);
    entry.shadow = {
      ...existingShadow,
      enabled: wantsShadowEnabled ? true : !!existingShadow.enabled,
      alpha: shadowSettings.alpha,
      blur: shadowSettings.blur,
      dilation: shadowSettings.dilation,
      scale: scaleState?.scale ?? Math.max(0.05, normalizeNumber(existingShadow.scale, PATH_SHADOW_SCALE_DEFAULT)),
      offset: nextOffsetPx,
      manual: false,
      editMode: false,
      points: nextPoints
    };
  }

  replaceSubmitDataBranch(submitData, `flags.${MODULE_ID}.${payloadState.key}`, clonedPayload);
  writeSubmitDataValue(submitData, `flags.${MODULE_ID}.shadowOffsetDistance`, 0);
  writeSubmitDataValue(submitData, `flags.${MODULE_ID}.shadowOffsetAngle`, 0);
  writeSubmitDataValue(submitData, `flags.${MODULE_ID}.shadowOffsetX`, 0);
  writeSubmitDataValue(submitData, `flags.${MODULE_ID}.shadowOffsetY`, 0);
  if (wantsShadowEnabled) writeSubmitDataValue(submitData, `flags.${MODULE_ID}.shadow`, true);
  return true;
}

function applyBuildingPathShadowSubmit(appInstance, submitData) {
  const doc = appInstance?.document || null;
  const capabilities = doc ? getFaNexusTileCapabilities(doc) : null;
  if (!doc || !capabilities?.hasBuilding) return false;
  if (!readSubmitShadowEnabled(submitData, doc)) return false;

  const building = buildSubmitDataBranchValue(submitData, `flags.${MODULE_ID}.building`, readModuleFlagRaw(doc, 'building'));
  if (!building?.wall || typeof building.wall !== 'object') {
    Logger.error('TileConfig.buildingShadow.submit.missingPayload', {
      tileId: doc?.id || null
    });
    throw new Error('Building shadow submit requires building wall payload.');
  }

  const currentShadow = building.wall.pathShadow || {};
  const shadowSettings = readSubmitShadowSettings(submitData, doc, currentShadow);
  const root = getTileConfigTabRoot(appInstance);
  const existingUiState = getBuildingShadowUiState(doc);
  const pathOffsetState = readPathShadowOffsetControlState(root, doc);
  const scaleState = readPathShadowScaleControlState(root, existingUiState);
  const radialOffsetState = readSubmitShadowOffsetState(submitData, doc);
  const nextOffset = pathOffsetState
    ? (pathOffsetState.changed || !Number.isFinite(Number(currentShadow.offset))
      ? pathOffsetState.offsetPx
      : Number(currentShadow.offset))
    : (Number.isFinite(Number(currentShadow.offset)) ? Number(currentShadow.offset) : radialOffsetState.offsetY);
  const nextShadow = {
    ...currentShadow,
    enabled: true,
    alpha: shadowSettings.alpha,
    blur: shadowSettings.blur,
    dilation: shadowSettings.dilation,
    offset: roundNumber(nextOffset, 3),
    scale: scaleState?.scale ?? Math.max(0.05, normalizeNumber(currentShadow.scale, PATH_SHADOW_SCALE_DEFAULT)),
    manual: false,
    editMode: false
  };

  building.wall.pathShadow = nextShadow;
  if (Array.isArray(building.wall.renderSegments)) {
    building.wall.renderSegments = building.wall.renderSegments.map((segment) => {
      if (!segment || typeof segment !== 'object') return segment;
      return {
        ...segment,
        pathShadow: {
          ...(segment.pathShadow || nextShadow),
          ...nextShadow,
          enabled: true
        }
      };
    });
  }

  replaceSubmitDataBranch(submitData, `flags.${MODULE_ID}.building`, building);
  writeSubmitDataValue(submitData, `flags.${MODULE_ID}.shadow`, true);
  writeSubmitDataValue(submitData, `flags.${MODULE_ID}.shadowOffsetDistance`, 0);
  writeSubmitDataValue(submitData, `flags.${MODULE_ID}.shadowOffsetAngle`, 0);
  writeSubmitDataValue(submitData, `flags.${MODULE_ID}.shadowOffsetX`, 0);
  writeSubmitDataValue(submitData, `flags.${MODULE_ID}.shadowOffsetY`, 0);
  return true;
}

function shouldApplyElevationShadowSettings(manager, elevation, requested) {
  if (!manager || !requested) return false;
  const docs = typeof manager?._collectShadowTilesAtElevation === 'function'
    ? manager._collectShadowTilesAtElevation(elevation)
    : [];
  if (!Array.isArray(docs) || !docs.length) return false;

  const layerKeys = typeof manager?._resolveLayerKeys === 'function'
    ? manager._resolveLayerKeys(elevation)
    : [];
  const firstLayer = Array.isArray(layerKeys)
    ? layerKeys.map((layerKey) => manager?._layers?.get?.(layerKey) || null).find(Boolean)
    : null;
  const fallbackAlpha = Number(firstLayer?.options?.alpha ?? manager?._options?.alpha ?? DEFAULT_SHADOW_SETTINGS.alpha);
  const fallbackBlur = Number(firstLayer?.options?.blur ?? manager?._options?.blur ?? DEFAULT_SHADOW_SETTINGS.blur);

  const readCurrent = (doc, key, fallback) => {
    const raw = readModuleFlagRaw(doc, key);
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : fallback;
  };

  return docs.some((doc) => {
    const currentAlpha = clampNumber(readCurrent(doc, 'shadowAlpha', fallbackAlpha), 0, 1, fallbackAlpha);
    const currentBlur = Math.max(0, normalizeNumber(readCurrent(doc, 'shadowBlur', fallbackBlur), fallbackBlur));
    return !approxNumber(currentAlpha, requested?.alpha) || !approxNumber(currentBlur, requested?.blur);
  });
}

function ensureCleanupWrapper(app) {
  const state = getAppState(app);
  if (state.cleanupWrapped) return;
  state.cleanupWrapped = true;
  const originalPreClose = typeof app?._preClose === 'function' ? app._preClose.bind(app) : null;
  app._preClose = async function _faNexusTileConfigPreClose(options) {
    try { cleanupPreviewShadow(this); } catch (error) {
      Logger.warn('TileConfig.preview.cleanup.failed', {
        tileId: this?.document?.id || null,
        error: String(error?.message || error)
      });
    }
    try { cleanupPreviewHsbc(this); } catch (error) {
      Logger.warn('TileConfig.preview.hsbc.cleanup.failed', {
        tileId: this?.document?.id || null,
        error: String(error?.message || error)
      });
    }
    requestLayerManagerSelectionSync({
      tileId: this?.document?.id || null,
      allowAutoExpand: false,
      allowScrollToTile: false
    });
    const result = originalPreClose ? await originalPreClose(options) : undefined;
    scheduleCustomRendererRefreshAfterClose(this, { reason: 'tile-config-close' });
    return result;
  };
}

function ensureUpdateWrapper(app) {
  const state = getAppState(app);
  if (state.updateWrapped) return;
  state.updateWrapped = true;
  const originalProcessSubmitData = typeof app?._processSubmitData === 'function' ? app._processSubmitData.bind(app) : null;
  if (originalProcessSubmitData) {
    app._processSubmitData = async function _faNexusTileConfigProcessSubmitData(event, form, submitData, options = {}) {
      if (!pruneUntouchedNexusFields(app, form, submitData)) {
        return originalProcessSubmitData(event, form, submitData, { ...options, faNexusTileConfigSubmit: true });
      }
      return tileConfigSubmitWorkflow.wrapElevationShadowSubmit(
        this,
        submitData,
        (nextSubmitData) => originalProcessSubmitData(event, form, nextSubmitData, {
          ...options,
          faNexusTileConfigSubmit: true
        }),
        { app }
      );
    };
    return;
  }

  const originalUpdateObject = typeof app?._updateObject === 'function' ? app._updateObject.bind(app) : null;
  if (!originalUpdateObject) return;
  app._updateObject = async function _faNexusTileConfigUpdateObject(event, formData) {
    return tileConfigSubmitWorkflow.wrapElevationShadowSubmit(
      this,
      formData,
      (nextFormData) => originalUpdateObject(event, nextFormData, {
        faNexusTileConfigSubmit: true
      }),
      { app }
    );
  };
}

function injectTileConfigTab(app, element) {
  const host = resolveHostElement(element);
  if (!host) return;
  host.querySelectorAll(NAV_SELECTOR).forEach((node) => node.remove());
  host.querySelectorAll(TAB_SELECTOR).forEach((node) => node.remove());

  const doc = app?.document || null;
  if (!doc) return;
  const scene = doc.parent || canvas?.scene;

  const nav = host.querySelector('.sheet-tabs.tabs[data-group="sheet"], .sheet-tabs.tabs');
  const lastTab = host.querySelector('.tab[data-group="sheet"][data-tab="overhead"]')
    || host.querySelector('.tab[data-group="sheet"]:last-of-type');
  if (!nav || !lastTab) return;

  nav.insertAdjacentHTML('beforeend', `
    <a data-action="tab" data-group="sheet" data-tab="${TAB_ID}" data-fa-nexus-tile-config-nav>
      <i class="fa-solid fa-wand-magic-sparkles" inert></i>
      <span>FA Nexus</span>
    </a>
  `);
  lastTab.insertAdjacentHTML('afterend', buildTabHtml(app, doc, scene));

  ensureCleanupWrapper(app);
  ensureUpdateWrapper(app);

  const root = host.querySelector(TAB_SELECTOR);
  if (!root) return;
  bindTab(root, app);
  captureInitialNexusFieldValues(app, host);
  requestLayerManagerSelectionSync({
    tileId: doc?.id || null,
    allowAutoExpand: false,
    allowScrollToTile: false
  });

  // Show the sheet's current tab, which may be the FA Nexus tab added above. Not through app.changeTab: while the
  // sheet is still rendering Foundry 14 defers that call, and when the sheet closes first (Submit) the deferred call
  // reads the closed sheet and throws an uncaught error. The tab group state is already this tab; only the classes
  // of the injected and native tabs need to agree with it.
  const activeTab = String(app?.tabGroups?.sheet || 'position').trim() || 'position';
  for (const tab of host.querySelectorAll('.tabs [data-group="sheet"][data-tab], .tab[data-group="sheet"][data-tab]')) {
    const active = tab.dataset.tab === activeTab;
    tab.classList.toggle('active', active);
    if (tab.matches('.tabs [data-tab]') && tab.tagName === 'BUTTON') tab.ariaPressed = String(active);
  }
}

function injectTilePaletteFaNexusSection(app, element) {
  const host = resolveHostElement(element);
  if (!host) {
    Logger.warn('TilePalette.render.inject.missingHost', {
      appId: app?.id || null
    });
    return;
  }

  host.querySelectorAll(TILE_PALETTE_SECTION_SELECTOR).forEach((node) => node.remove());
  const body = host.querySelector('.standard-form.scrollable');
  if (!body) {
    Logger.error('TilePalette.render.inject.missingBody', {
      appId: app?.id || null
    });
    return;
  }

  const videoSection = body.querySelector('details[data-sync="details-video"]');
  if (!videoSection) {
    Logger.error('TilePalette.render.inject.missingVideoSection', {
      appId: app?.id || null
    });
    return;
  }
  const html = buildTilePaletteFaNexusHtml(app);
  videoSection.insertAdjacentHTML('afterend', html);

  const section = host.querySelector(TILE_PALETTE_SECTION_SELECTOR);
  if (!section) {
    Logger.error('TilePalette.render.inject.sectionMissing', {
      appId: app?.id || null
    });
    return;
  }
  setTilePaletteParentLevelMultiPlaceholder(app, section);
  bindTilePaletteFaNexusSection(app, section);
  Logger.debug('TilePalette.render.injected', {
    appId: app?.id || null,
    selectedCount: app?.controlled?.length ?? 0,
    isSelect: !!app?.isSelect
  });
}

try {
  Hooks.on('renderTileConfig', (app, element) => {
    try {
      injectTileConfigTab(app, element);
    } catch (error) {
      Logger.warn('TileConfig.render.inject.failed', {
        tileId: app?.document?.id || null,
        error: String(error?.message || error)
      });
    }
  });

  Hooks.on('renderTilePalette', (app, element) => {
    try {
      injectTilePaletteFaNexusSection(app, element);
    } catch (error) {
      Logger.error('TilePalette.render.inject.failed', {
        appId: app?.id || null,
        error: String(error?.message || error)
      });
      throw error;
    }
  });
} catch (error) {
  Logger.warn('TileConfig.init.failed', {
    error: String(error?.message || error)
  });
}
