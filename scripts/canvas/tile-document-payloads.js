import { getCurrentViewedLevelIds } from './elevation-band-utils.js';
import {
  getRawLevelIds,
  hasOwnLevelField
} from './tile-level-membership.js';
import {
  getSurfaceTileOcclusionModes,
  normalizeTileOcclusionForV14
} from './tile-occlusion.js';

export const LEVEL_POLICY_INHERIT_CURRENT = 'inherit-current';
export const LEVEL_POLICY_PRESERVE = 'preserve';
export const LEVEL_POLICY_UNSCOPED = 'unscoped';
export {
  getRawLevelIds,
  hasOwnLevelField
};

export function getActiveCanvasLevelIds(scene = canvas?.scene) {
  return getCurrentViewedLevelIds(scene);
}

export function normalizeTileRestrictionsForV14(restrictions, { roof = false } = {}) {
  const normalized = {
    light: !!(roof || restrictions?.light),
    weather: !!(roof || restrictions?.weather)
  };
  if (!normalized.light && !normalized.weather) return undefined;
  return normalized;
}

function clonePayloadValue(value) {
  if (value === undefined) return undefined;
  const foundryUtils = globalThis.foundry?.utils;
  if (foundryUtils?.deepClone) return foundryUtils.deepClone(value);
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function readDocumentSourceValue(doc, path) {
  if (!doc || !path) return undefined;
  const foundryUtils = globalThis.foundry?.utils;
  let value;
  try { value = foundryUtils?.getProperty?.(doc?._source, path); } catch (_) { value = undefined; }
  if (value !== undefined) return value;
  try { value = foundryUtils?.getProperty?.(doc, path); } catch (_) { value = undefined; }
  return value;
}

function setPayloadValue(payload, path, value) {
  if (!payload || (typeof payload !== 'object') || !path) return;
  if (Object.prototype.hasOwnProperty.call(payload, path)) {
    payload[path] = value;
    return;
  }
  const root = String(path).split('.')[0];
  const hasDotPathSibling = !!root && Object.keys(payload).some((key) => key.startsWith(`${root}.`));
  if (hasDotPathSibling) {
    payload[path] = value;
    return;
  }
  const foundryUtils = globalThis.foundry?.utils;
  if (typeof foundryUtils?.setProperty === 'function') {
    try {
      foundryUtils.setProperty(payload, path, value);
      return;
    } catch (_) {}
  }
  payload[path] = value;
}

function preserveDocumentLevels(doc, payload) {
  if (!doc || !payload || (typeof payload !== 'object')) return;
  payload.levels = getRawLevelIds(doc);
}

function preserveDocumentOverhead(doc, payload) {
  if (!doc || !payload || (typeof payload !== 'object')) return;
  const sourceOcclusion = readDocumentSourceValue(doc, 'occlusion');
  if (sourceOcclusion !== undefined) {
    payload.occlusion = normalizeTileOcclusionForV14(clonePayloadValue(sourceOcclusion), {
      sourceOcclusion
    });
  }

  const sourceRestrictions = readDocumentSourceValue(doc, 'restrictions');
  if (sourceRestrictions !== undefined) {
    payload.restrictions = normalizeTileRestrictionsForV14(sourceRestrictions) || { light: false, weather: false };
  }

  const alphaThreshold = readDocumentSourceValue(doc, 'texture.alphaThreshold');
  if (alphaThreshold !== undefined) setPayloadValue(payload, 'texture.alphaThreshold', alphaThreshold);
}

function applyFaNexusPlacementCreateDefaults(payload) {
  if (!payload || (typeof payload !== 'object')) return;

  const occlusion = normalizeTileOcclusionForV14(payload.occlusion);
  payload.occlusion = {
    ...occlusion,
    modes: getSurfaceTileOcclusionModes()
  };

  const restrictions = normalizeTileRestrictionsForV14(payload.restrictions, {
    roof: payload.roof === true
  }) || {};
  payload.restrictions = {
    light: true,
    weather: !!restrictions.weather
  };
}

export function preserveTileDocumentCustomSettingsForUpdate(doc, payload, {
  preserveLevels = true,
  preserveOverhead = true
} = {}) {
  if (!payload || (typeof payload !== 'object')) return payload;
  const normalized = payload;
  if (preserveLevels) preserveDocumentLevels(doc, normalized);
  if (preserveOverhead) preserveDocumentOverhead(doc, normalized);
  return normalized;
}

export function migrateLegacyTilePositionForV14(data, { force = false } = {}) {
  if (!data || (typeof data !== 'object')) return false;

  const texture = data.texture && (typeof data.texture === 'object') ? data.texture : (data.texture = {});
  const hasAnchorX = Number.isFinite(Number(texture.anchorX));
  const hasAnchorY = Number.isFinite(Number(texture.anchorY));
  if (!force && hasAnchorX && hasAnchorY) return false;

  const rotation = Number(data.rotation);
  const width = Number(data.width);
  const height = Number(data.height);
  const scaleX = Number(texture.scaleX);
  const scaleY = Number(texture.scaleY);
  if ((Number.isFinite(rotation) ? rotation : 0) === 0) {
    if (Number.isFinite(scaleX) && scaleX < 0) {
      texture.anchorX = 0.5;
      if (Number.isFinite(width)) data.x = Math.round((Number(data.x) || 0) + (width / 2));
    } else {
      texture.anchorX = 0;
    }
    if (Number.isFinite(scaleY) && scaleY < 0) {
      texture.anchorY = 0.5;
      if (Number.isFinite(height)) data.y = Math.round((Number(data.y) || 0) + (height / 2));
    } else {
      texture.anchorY = 0;
    }
    return true;
  }

  texture.anchorX = 0.5;
  texture.anchorY = 0.5;
  if (Number.isFinite(width)) data.x = Math.round((Number(data.x) || 0) + (width / 2));
  if (Number.isFinite(height)) data.y = Math.round((Number(data.y) || 0) + (height / 2));
  return true;
}

export function normalizeTileCreatePayloadForV14(data, options = {}) {
  if (!data || (typeof data !== 'object')) return data;

  const {
    levelPolicy = LEVEL_POLICY_UNSCOPED,
    scene = canvas?.scene
  } = options;
  const applyFaNexusPlacementDefaults = options.applyFaNexusPlacementDefaults ?? levelPolicy !== LEVEL_POLICY_PRESERVE;
  const normalized = data;
  migrateLegacyTilePositionForV14(normalized);
  const hasLevelField = hasOwnLevelField(normalized);
  const levelIds = getRawLevelIds(normalized);
  const currentLevelIds = levelPolicy === LEVEL_POLICY_INHERIT_CURRENT
    ? getActiveCanvasLevelIds(scene)
    : [];

  switch (levelPolicy) {
    case LEVEL_POLICY_PRESERVE:
      if (hasLevelField) normalized.levels = levelIds;
      else delete normalized.levels;
      break;
    case LEVEL_POLICY_INHERIT_CURRENT:
      if (levelIds.length) normalized.levels = levelIds;
      else if (hasLevelField) normalized.levels = [];
      else if (currentLevelIds.length) normalized.levels = currentLevelIds;
      else delete normalized.levels;
      break;
    case LEVEL_POLICY_UNSCOPED:
    default:
      delete normalized.levels;
      break;
  }

  normalized.occlusion = normalizeTileOcclusionForV14(normalized.occlusion);

  const restrictions = normalizeTileRestrictionsForV14(normalized.restrictions, {
    roof: normalized.roof === true
  });
  if (restrictions) normalized.restrictions = restrictions;
  else delete normalized.restrictions;

  if (applyFaNexusPlacementDefaults) applyFaNexusPlacementCreateDefaults(normalized);

  delete normalized.overhead;
  delete normalized.roof;
  return normalized;
}

export function normalizeTileCreatePayloadsForV14(payloads, options = {}) {
  if (!Array.isArray(payloads)) return [];
  return payloads.map((payload) => normalizeTileCreatePayloadForV14(payload, options));
}
