import {
  resolveTileDocument,
  resolveTilePlaceable
} from './tile-targets.js';

const MODULE_ID = 'fa-nexus';

const CUSTOM_RENDER_CONTAINER_FEATURES = Object.freeze([
  ['faNexusMaskContainer', 'maskedTiling'],
  ['faNexusStandardMaskContainer', 'standardTileMask'],
  ['faNexusPathContainer', 'pathV2'],
  ['faNexusAssetScatterContainer', 'assetScatter'],
  ['faNexusBuildingContainer', 'building'],
  ['faNexusDoorFrameContainer', 'buildingDoorFrame'],
  ['faNexusBuildingCompositeContainer', 'buildingComposite']
]);

function readModuleFlag(doc, key) {
  if (!doc || !key) return undefined;
  try {
    const direct = doc.getFlag?.(MODULE_ID, key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  try {
    const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
    if (flags && Object.prototype.hasOwnProperty.call(flags, key)) return flags[key];
  } catch (_) {}
  return undefined;
}

function isObjectLike(value) {
  return !!value && (typeof value === 'object');
}

function hasControlPoints(value) {
  return isObjectLike(value) && Array.isArray(value.controlPoints) && value.controlPoints.length > 0;
}

function hasMergedPathEntries(value) {
  return isObjectLike(value)
    && Array.isArray(value.paths)
    && value.paths.some((entry) => entry && Array.isArray(entry.controlPoints) && entry.controlPoints.length > 0);
}

function hasScatterInstances(value) {
  return isObjectLike(value) && Array.isArray(value.instances) && value.instances.length > 0;
}

function isVideoTextureSrc(src) {
  return /\.(webm|mp4)$/i.test(String(src || '').trim());
}

function pushUnique(list, value) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function detectRuntimeOverlayFeatures(tile) {
  const features = [];
  if (!tile || tile.destroyed) return features;
  const mesh = tile?.mesh;
  for (const [key, feature] of CUSTOM_RENDER_CONTAINER_FEATURES) {
    if (mesh?.[key] || tile?.[key]) pushUnique(features, feature);
  }
  if (!features.length) {
    const hasRuntimeOverlay = !!(
      mesh?.faNexusCustomOverheadState
      || tile?.faNexusCustomOverheadState
      || tile?.faNexusOverheadProxy
      || mesh?.faNexusOverheadProxy
    );
    if (hasRuntimeOverlay) pushUnique(features, 'runtimeOverlay');
  }
  return features;
}

function buildCustomRenderFeatures({
  hasLegacyPath = false,
  hasPathV2 = false,
  hasPathsV2 = false,
  hasMaskedTiling = false,
  hasStandardTileMask = false,
  hasAssetScatter = false,
  hasBuilding = false,
  hasBuildingFill = false,
  hasBuildingDoorFrame = false,
  hasBuildingComposite = false,
  hasBuildingSills = false,
  runtimeOverlayFeatures = []
} = {}) {
  const features = [];
  if (hasLegacyPath) pushUnique(features, 'pathLegacy');
  if (hasPathV2) pushUnique(features, 'pathV2');
  if (hasPathsV2) pushUnique(features, 'pathsV2');
  if (hasMaskedTiling) pushUnique(features, 'maskedTiling');
  if (hasStandardTileMask) pushUnique(features, 'standardTileMask');
  if (hasAssetScatter) pushUnique(features, 'assetScatter');
  if (hasBuilding) pushUnique(features, 'building');
  if (hasBuildingFill) pushUnique(features, 'buildingFill');
  if (hasBuildingDoorFrame) pushUnique(features, 'buildingDoorFrame');
  if (hasBuildingComposite) pushUnique(features, 'buildingComposite');
  if (hasBuildingSills) pushUnique(features, 'buildingSills');
  for (const feature of runtimeOverlayFeatures) pushUnique(features, feature);
  return features;
}

export function getFaNexusTileCapabilities(target) {
  const document = resolveTileDocument(target) || target?.document || target || null;
  const tile = resolveTilePlaceable(target) || document?.object || null;

  const legacyPath = readModuleFlag(document, 'path');
  const pathV2 = readModuleFlag(document, 'pathV2');
  const pathsV2 = readModuleFlag(document, 'pathsV2');
  const maskedTiling = readModuleFlag(document, 'maskedTiling');
  const standardTileMask = readModuleFlag(document, 'standardTileMask');
  const assetScatter = readModuleFlag(document, 'assetScatter');
  const building = readModuleFlag(document, 'building');
  const buildingFill = readModuleFlag(document, 'buildingFill');
  const buildingDoorFrame = readModuleFlag(document, 'buildingDoorFrame');
  const buildingComposite = readModuleFlag(document, 'buildingComposite');
  const buildingSills = readModuleFlag(document, 'buildingSills');
  const flattened = readModuleFlag(document, 'flattened');

  const hasLegacyPath = hasControlPoints(legacyPath);
  const hasPathV2 = hasControlPoints(pathV2);
  const hasPathsV2 = hasMergedPathEntries(pathsV2);
  const hasMaskedTiling = isObjectLike(maskedTiling);
  const hasStandardTileMask = isObjectLike(standardTileMask);
  const hasAssetScatter = hasScatterInstances(assetScatter);
  const hasBuilding = isObjectLike(building);
  const hasBuildingFill = isObjectLike(buildingFill);
  const hasBuildingDoorFrame = isObjectLike(buildingDoorFrame);
  const hasBuildingComposite = isObjectLike(buildingComposite);
  const hasBuildingSills = isObjectLike(buildingSills);
  const hasFlattened = isObjectLike(flattened);

  const runtimeOverlayFeatures = detectRuntimeOverlayFeatures(tile);
  const customRenderFeatures = buildCustomRenderFeatures({
    hasLegacyPath,
    hasPathV2,
    hasPathsV2,
    hasMaskedTiling,
    hasStandardTileMask,
    hasAssetScatter,
    hasBuilding,
    hasBuildingFill,
    hasBuildingDoorFrame,
    hasBuildingComposite,
    hasBuildingSills,
    runtimeOverlayFeatures
  });

  const hasPathData = hasLegacyPath || hasPathV2 || hasPathsV2;
  const hasMaskData = hasMaskedTiling || hasStandardTileMask;
  const isBuildingRelated = hasBuilding || hasBuildingFill || hasBuildingDoorFrame
    || hasBuildingComposite || hasBuildingSills;
  const isCustomRendered = customRenderFeatures.length > 0;

  const textureSrc = String(document?.texture?.src || '').trim();
  const hasTexture = !!textureSrc;
  const hasVideoTexture = hasTexture && isVideoTextureSrc(textureSrc);
  const hasImageTexture = hasTexture && !hasVideoTexture;

  let editMode = null;
  if (hasPathData) editMode = 'paths';
  else if (hasMaskedTiling) editMode = 'textures';
  else if (isBuildingRelated) editMode = 'buildings';
  // A flattened picture has no editor of its own: the asset editor would replace the section's picture with one
  // asset. Its actions are Apply Mask and Deconstruct.
  else if (hasFlattened) editMode = null;
  else if (hasAssetScatter || hasTexture) editMode = 'assets';

  const preferredPathEditor = hasPathV2 || hasPathsV2
    ? 'v2'
    : (hasLegacyPath ? 'legacy' : null);

  const requiresLegacyPathMigration = !!globalThis?.faNexusPathTilesPremium
    && hasLegacyPath
    && !hasPathV2
    && !hasPathsV2;

  return {
    document,
    tile,
    editMode,
    preferredPathEditor,
    hasTexture,
    hasImageTexture,
    hasVideoTexture,
    hasPathData,
    hasMaskData,
    isBuildingRelated,
    isCustomRendered,
    requiresLegacyPathMigration,
    customRenderFeatures,
    runtimeOverlayFeatures,
    hasLegacyPath,
    hasPathV2,
    hasPathsV2,
    hasMaskedTiling,
    hasStandardTileMask,
    hasAssetScatter,
    hasBuilding,
    hasBuildingFill,
    hasBuildingDoorFrame,
    hasBuildingComposite,
    hasBuildingSills,
    hasFlattened
  };
}
