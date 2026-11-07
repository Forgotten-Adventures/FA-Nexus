import { normalizeTileCreatePayloadForV14 } from '../canvas/tile-document-payloads.js';
import { resolveNewLayerLevels } from '../canvas/new-layer-levels.js';

function requireEncodeAssetPath(encodeAssetPath) {
  if (typeof encodeAssetPath !== 'function') {
    throw new TypeError('encodeAssetPath function is required for unencoded placement asset paths');
  }
  return encodeAssetPath;
}

function normalizePlacementShadowAngle(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  let normalized = numeric % 360;
  if (normalized < 0) normalized += 360;
  return normalized;
}

function roundPlacementShadowValue(value, decimals = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const places = Math.max(0, Math.min(6, Math.floor(decimals)));
  const factor = 10 ** places;
  return Math.round(numeric * factor) / factor;
}

function requireShadowOffsetVector(dropShadow) {
  const offsetVector = dropShadow?.offsetVector;
  if (!offsetVector || typeof offsetVector !== 'object') {
    throw new TypeError('dropShadow.offsetVector is required when composing placement shadow flags');
  }
  return offsetVector;
}

function getCenteredTileAnchorPosition({ x = 0, y = 0, width = 0, height = 0 } = {}) {
  return {
    x: (Number(x) || 0) + ((Number(width) || 0) / 2),
    y: (Number(y) || 0) + ((Number(height) || 0) / 2)
  };
}

function applyHsbcUpdateField(update, hsbc) {
  update['flags.fa-nexus.hsbc'] = hsbc || null;
  return update;
}

export function buildPlacementShadowFlagFields(dropShadow, {
  prefix = '',
  enabled = dropShadow != null,
  clearDisabled = false
} = {}) {
  const fields = {};
  const key = (name) => `${prefix}${name}`;
  if (!dropShadow) {
    if (clearDisabled) {
      fields[key('shadow')] = false;
      fields[key('shadowAlpha')] = null;
      fields[key('shadowDilation')] = null;
      fields[key('shadowBlur')] = null;
      fields[key('shadowOffsetDistance')] = null;
      fields[key('shadowOffsetAngle')] = null;
      fields[key('shadowOffsetX')] = null;
      fields[key('shadowOffsetY')] = null;
      fields[key('shadowOnly')] = null;
    }
    return fields;
  }

  const offsetVector = requireShadowOffsetVector(dropShadow);
  fields[key('shadow')] = !!enabled;
  fields[key('shadowAlpha')] = roundPlacementShadowValue(dropShadow.alpha, 3);
  fields[key('shadowDilation')] = roundPlacementShadowValue(dropShadow.dilation, 3);
  fields[key('shadowBlur')] = roundPlacementShadowValue(dropShadow.blur, 3);
  fields[key('shadowOffsetDistance')] = roundPlacementShadowValue(dropShadow.offsetDistance, 2);
  fields[key('shadowOffsetAngle')] = roundPlacementShadowValue(
    normalizePlacementShadowAngle(dropShadow.offsetAngle),
    1
  );
  fields[key('shadowOffsetX')] = roundPlacementShadowValue(offsetVector.x, 2);
  fields[key('shadowOffsetY')] = roundPlacementShadowValue(offsetVector.y, 2);
  fields[key('shadowOnly')] = !!(enabled && dropShadow.shadowOnly);
  return fields;
}

export function createPlacementTextureConfig(assetPath, flipState = null, {
  encoded = false,
  encodeAssetPath = null
} = {}) {
  return {
    src: encoded
      ? String(assetPath || '')
      : requireEncodeAssetPath(encodeAssetPath)(assetPath || ''),
    scaleX: flipState?.horizontal ? -1 : 1,
    scaleY: flipState?.vertical ? -1 : 1
  };
}

export function buildPlacementModuleFlags(baseFlags = {}, {
  hsbc = null,
  dropShadow = null,
  standardTileMask = null,
  placementLevelId = null
} = {}) {
  const moduleFlags = Object.assign({}, baseFlags || {});
  if (hsbc) moduleFlags.hsbc = hsbc;
  else delete moduleFlags.hsbc;

  if (dropShadow) {
    Object.assign(moduleFlags, buildPlacementShadowFlagFields(dropShadow));
  }

  if (standardTileMask) moduleFlags.standardTileMask = standardTileMask;
  if (placementLevelId) moduleFlags.placementLevelId = placementLevelId;
  return moduleFlags;
}

export function buildPlacementTileData({
  assetPath,
  width,
  height,
  x,
  y,
  rotation = 0,
  sort = 0,
  elevation = 0,
  flipState = null,
  encodedAssetPath = false,
  baseFlags = null,
  hsbc = null,
  dropShadow = null,
  standardTileMask = null,
  placementLevelId = null,
  encodeAssetPath = null
} = {}) {
  const textureConfig = createPlacementTextureConfig(assetPath, flipState, {
    encoded: encodedAssetPath,
    encodeAssetPath
  });
  const tileData = normalizeTileCreatePayloadForV14({
    texture: { ...textureConfig, anchorX: 0.5, anchorY: 0.5 },
    width,
    height,
    x,
    y,
    rotation,
    hidden: false,
    locked: false,
    elevation,
    sort: Number(sort || 0) || 0
  }, { scene: null });
  const moduleFlags = buildPlacementModuleFlags(baseFlags || tileData.flags?.['fa-nexus'] || {}, {
    hsbc,
    dropShadow,
    standardTileMask,
    placementLevelId
  });
  if (Object.keys(moduleFlags).length) {
    tileData.flags = tileData.flags || {};
    tileData.flags['fa-nexus'] = moduleFlags;
  }
  // The payload was normalised before its placement Level was known.
  const levels = resolveNewLayerLevels({ placementLevelId });
  if (levels.length) tileData.levels = levels;
  return { tileData, textureConfig };
}

export function buildPlacementTileUpdate({
  tileId,
  x,
  y,
  width,
  height,
  rotation = 0,
  sort = 0,
  elevation = 0,
  textureConfig = {},
  existingTextureSrc = null,
  placementLevelId = null,
  hsbc = null,
  dropShadow = null,
  clearDropShadow = false
} = {}) {
  const update = {
    _id: tileId,
    x,
    y,
    width,
    height,
    rotation,
    elevation,
    sort,
    'texture.scaleX': textureConfig.scaleX,
    'texture.scaleY': textureConfig.scaleY,
    'texture.anchorX': 0.5,
    'texture.anchorY': 0.5
  };
  update['flags.fa-nexus.placementLevelId'] = placementLevelId || null;
  if (textureConfig.src && textureConfig.src !== existingTextureSrc) {
    update['texture.src'] = textureConfig.src;
  }
  applyHsbcUpdateField(update, hsbc);
  Object.assign(update, buildPlacementShadowFlagFields(dropShadow, {
    prefix: 'flags.fa-nexus.',
    clearDisabled: clearDropShadow
  }));
  return update;
}

export function buildPlacementEditingShadowUpdate({
  tileId,
  dropShadow,
  shadowEnabled = dropShadow != null,
  hsbc = null,
  width = null,
  height = null,
  rotation = null,
  flipState = null
} = {}) {
  const update = {
    _id: tileId,
    ...buildPlacementShadowFlagFields(dropShadow, {
      prefix: 'flags.fa-nexus.',
      enabled: shadowEnabled
    })
  };
  applyHsbcUpdateField(update, hsbc);
  if (width !== null) update.width = width;
  if (height !== null) update.height = height;
  if (Number.isFinite(rotation)) update.rotation = rotation;
  update['texture.scaleX'] = flipState?.horizontal ? -1 : 1;
  update['texture.scaleY'] = flipState?.vertical ? -1 : 1;
  update['texture.anchorX'] = 0.5;
  update['texture.anchorY'] = 0.5;
  return update;
}

export function buildScatterPlacementTileData({
  scatterPayload,
  scatterFlagKey,
  elevation = 0,
  sort = 0,
  hsbc = null,
  dropShadow = null,
  placementLevelId = null,
  encodeAssetPath = null
} = {}) {
  if (!scatterPayload) return null;
  const { bounds, scatterFlag, textureSrc } = scatterPayload;
  const { tileData } = buildPlacementTileData({
    assetPath: textureSrc,
    width: bounds.width,
    height: bounds.height,
    ...getCenteredTileAnchorPosition(bounds),
    rotation: 0,
    sort: Number(sort) || 0,
    elevation,
    encodedAssetPath: true,
    baseFlags: { [scatterFlagKey]: scatterFlag },
    hsbc,
    dropShadow,
    placementLevelId,
    encodeAssetPath
  });
  return tileData;
}

export function buildScatterPlacementTileUpdate({
  tileId,
  scatterPayload,
  scatterFlagKey,
  hsbc = null,
  dropShadow = null,
  clearDropShadow = false,
  tilePose = null
} = {}) {
  if (!scatterPayload) return null;
  const { bounds, scatterFlag, textureSrc } = scatterPayload;
  const update = {
    _id: tileId,
    ...(tilePose ? { x: tilePose.x, y: tilePose.y } : getCenteredTileAnchorPosition(bounds)),
    width: tilePose?.width ?? bounds.width,
    height: tilePose?.height ?? bounds.height,
    rotation: tilePose?.rotation ?? 0,
    'texture.src': textureSrc,
    'texture.anchorX': tilePose?.texture?.anchorX ?? 0.5,
    'texture.anchorY': tilePose?.texture?.anchorY ?? 0.5,
    [`flags.fa-nexus.${scatterFlagKey}`]: scatterFlag
  };
  applyHsbcUpdateField(update, hsbc);
  Object.assign(update, buildPlacementShadowFlagFields(dropShadow, {
    prefix: 'flags.fa-nexus.',
    clearDisabled: clearDropShadow
  }));
  return update;
}
