import { normalizeTileTypeKey } from './list-filters.js';
import { resolveTileRenderOrder } from '../../canvas/tile-band-utils.js';

export const DEFAULT_PRIMARY_SORT_LAYERS = Object.freeze({
  SCENE: 0,
  TILES: 500,
  DRAWINGS: 600,
  TOKENS: 700,
  WEATHER: 1000
});

export function getPrimaryCanvasSortLayers() {
  return foundry?.canvas?.groups?.PrimaryCanvasGroup?.SORT_LAYERS || DEFAULT_PRIMARY_SORT_LAYERS;
}

export function normalizeRenderOrderValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number(fallback) || 0;
}

export function comparePrimaryRenderOrder(a, b) {
  return (normalizeRenderOrderValue(a?.elevation) - normalizeRenderOrderValue(b?.elevation))
    || (normalizeRenderOrderValue(a?.sortLayer) - normalizeRenderOrderValue(b?.sortLayer))
    || (normalizeRenderOrderValue(a?.sort) - normalizeRenderOrderValue(b?.sort))
    || (normalizeRenderOrderValue(a?.zIndex) - normalizeRenderOrderValue(b?.zIndex))
    || (normalizeRenderOrderValue(a?.lastSortedIndex) - normalizeRenderOrderValue(b?.lastSortedIndex));
}

export function getTileRenderOrder(doc, indexFallback = 0) {
  const sortLayers = getPrimaryCanvasSortLayers();
  const placeable = doc?.object || null;
  const derived = resolveTileRenderOrder(doc);
  return {
    elevation: normalizeRenderOrderValue(derived?.elevation ?? placeable?.elevation ?? doc?.elevation ?? 0),
    sortLayer: normalizeRenderOrderValue(derived?.sortLayer ?? placeable?.sortLayer, sortLayers.TILES),
    sort: normalizeRenderOrderValue(derived?.sort ?? placeable?.sort ?? doc?.sort ?? 0),
    zIndex: normalizeRenderOrderValue(placeable?.zIndex ?? derived?.zIndex ?? 0),
    lastSortedIndex: normalizeRenderOrderValue(placeable?._lastSortedIndex, indexFallback),
    kind: String(derived?.kind || 'normal').trim() || 'normal',
    analysis: derived?.analysis || null,
    placementLevelId: String(derived?.placementLevelId || '').trim() || null
  };
}

export function sortLayerManagerRenderEntries(a, b) {
  const buildingPreviewTieRank = (entry) => entry?.previewKind === 'building-preview'
    ? 0
    : (entry?.previewKind === 'building-fill-preview' ? 1 : 2);
  const aBuildingPreviewRank = buildingPreviewTieRank(a);
  const bBuildingPreviewRank = buildingPreviewTieRank(b);
  if (aBuildingPreviewRank < 2 && bBuildingPreviewRank < 2) {
    const renderDiffWithoutInsertionOrder = (normalizeRenderOrderValue(b?.elevation) - normalizeRenderOrderValue(a?.elevation))
      || (normalizeRenderOrderValue(b?.sortLayer) - normalizeRenderOrderValue(a?.sortLayer))
      || (normalizeRenderOrderValue(b?.sort) - normalizeRenderOrderValue(a?.sort))
      || (normalizeRenderOrderValue(b?.zIndex) - normalizeRenderOrderValue(a?.zIndex));
    if (renderDiffWithoutInsertionOrder) return renderDiffWithoutInsertionOrder;
    return aBuildingPreviewRank - bBuildingPreviewRank;
  }
  const renderDiff = comparePrimaryRenderOrder(b, a);
  if (renderDiff) return renderDiff;
  const aRank = a?.levelBoundarySeparator ? 3 : (a?.marker ? 2 : (a?.preview ? 1 : 0));
  const bRank = b?.levelBoundarySeparator ? 3 : (b?.marker ? 2 : (b?.preview ? 1 : 0));
  if (aRank !== bRank) return aRank - bRank;
  const aKey = String(a?.previewId ?? a?.markerId ?? a?.levelBoundaryId ?? a?.id ?? '');
  const bKey = String(b?.previewId ?? b?.markerId ?? b?.levelBoundaryId ?? b?.id ?? '');
  if (aKey && bKey) return aKey.localeCompare(bKey);
  return 0;
}

export function sortLayerManagerTileDocs(a, b) {
  const renderDiff = comparePrimaryRenderOrder(getTileRenderOrder(b), getTileRenderOrder(a));
  if (renderDiff) return renderDiff;
  const aId = String(a?.id ?? a?._id ?? '');
  const bId = String(b?.id ?? b?._id ?? '');
  if (aId && bId) return aId.localeCompare(bId);
  if (aId) return -1;
  if (bId) return 1;
  return 0;
}

function requireEntryDependency(name, value, caller) {
  if (typeof value !== 'function') {
    throw new Error(`${caller} requires ${name}`);
  }
  return value;
}

function resolveLayerManagerPreviewElevation(container, quantizeElevation) {
  if (!container) return 0;
  const candidate = Number(
    container.faNexusPathPreviewElevation
    ?? container.faNexusElevationDoc
    ?? container.faNexusElevation
    ?? container.elevation
    ?? 0
  );
  return quantizeElevation(candidate);
}

export function resolveLayerManagerPreviewPlacementSort(container) {
  if (!container) return 0;
  const candidate = Number(
    container.faNexusPlacementSort
    ?? container.zIndex
    ?? container.faNexusSort
    ?? container.sort
    ?? 0
  );
  return Number.isFinite(candidate) ? candidate : 0;
}

function resolveLayerManagerPreviewRenderSort(container, fallback = 0) {
  if (!container) return normalizeRenderOrderValue(fallback);
  return normalizeRenderOrderValue(
    container.faNexusSort
    ?? container.sort
    ?? fallback
  );
}

function resolveLayerManagerPreviewPlacementLevelId(container) {
  const normalized = String(container?.faNexusPlacementLevelId || '').trim();
  return normalized || null;
}

function resolveLayerManagerPreviewBandKind(container) {
  const normalized = String(container?.faNexusBandKind || '').trim().toLowerCase();
  return normalized === 'foreground' || normalized === 'ground' ? normalized : null;
}

export function buildLayerManagerPreviewEntry(container, {
  label,
  icon,
  kind,
  previewActiveOverride,
  canDragPreviewOverride
} = {}, {
  quantizeElevation = null,
  elevationGroupKey = null,
  getDefaultTilePlacementLevelId = null,
  resolveSceneLevelName = null,
  getSortLayers = getPrimaryCanvasSortLayers,
  getRenderOrder = resolveTileRenderOrder
} = {}) {
  if (!container || container.destroyed) return null;
  const caller = 'buildLayerManagerPreviewEntry';
  const quantize = requireEntryDependency('quantizeElevation', quantizeElevation, caller);
  const groupKey = requireEntryDependency('elevationGroupKey', elevationGroupKey, caller);
  const defaultPlacementLevelId = requireEntryDependency('getDefaultTilePlacementLevelId', getDefaultTilePlacementLevelId, caller);
  const levelNameForId = requireEntryDependency('resolveSceneLevelName', resolveSceneLevelName, caller);
  const resolveOrder = requireEntryDependency('getRenderOrder', getRenderOrder, caller);
  const sortLayersForCanvas = requireEntryDependency('getSortLayers', getSortLayers, caller);
  const previewKind = String(kind || '').trim();
  if (!previewKind) throw new Error(`${caller} requires kind`);
  const baseLabel = String(label || '').trim();
  if (!baseLabel) throw new Error(`${caller} requires label`);
  const typeIcon = String(icon || '').trim();
  if (!typeIcon) throw new Error(`${caller} requires icon`);

  const documentElevation = resolveLayerManagerPreviewElevation(container, quantize);
  const placementSort = resolveLayerManagerPreviewPlacementSort(container);
  const previewKey = String(
    container?.faNexusPathPreviewKey
    || container?.faNexusScatterPreviewKey
    || container?.faNexusTexturePreviewKey
    || container?.faNexusBuildingPreviewKey
    || container?.name
    || String(documentElevation)
  ).trim();
  const previewActive = previewActiveOverride !== undefined
    ? !!previewActiveOverride
    : !!container?.faNexusPreviewActive;
  const previewHasContent = !!container?.faNexusPreviewHasContent;
  const explicitPlacementLevelId = resolveLayerManagerPreviewPlacementLevelId(container);
  const derivedRenderOrder = resolveOrder({ elevation: documentElevation, sort: placementSort }, {
    elevation: documentElevation,
    sort: placementSort,
    placementLevelId: explicitPlacementLevelId || defaultPlacementLevelId(),
    allowCurrentLevelFallback: true
  });
  const renderKind = resolveLayerManagerPreviewBandKind(container)
    || String(derivedRenderOrder?.kind || 'normal').trim().toLowerCase()
    || 'normal';
  const placementLevelId = explicitPlacementLevelId
    || String(derivedRenderOrder?.placementLevelId || '').trim()
    || null;
  const placementLevelName = levelNameForId(placementLevelId)
    || String(derivedRenderOrder?.analysis?.placementRange?.levelName || '').trim()
    || null;
  const renderElevation = quantize(Number(
    container.faNexusElevation
    ?? container.elevation
    ?? derivedRenderOrder?.elevation
    ?? documentElevation
  ) || 0);
  const renderElevationKey = groupKey(renderElevation);
  const documentElevationKey = groupKey(documentElevation);
  const sortLayers = sortLayersForCanvas();
  const explicitRenderSort = resolveLayerManagerPreviewRenderSort(container, derivedRenderOrder?.sort);
  const explicitSortLayer = normalizeRenderOrderValue(container?.sortLayer, derivedRenderOrder?.sortLayer ?? sortLayers.TILES);
  const explicitZIndex = normalizeRenderOrderValue(container?.zIndex ?? derivedRenderOrder?.zIndex ?? 0);
  const bandVisualizationLabel = renderKind === 'foreground'
    ? (placementLevelName ? `${placementLevelName} Foreground` : 'Foreground Band')
    : (renderKind === 'ground'
      ? (placementLevelName ? `${placementLevelName} Background` : 'Background Band')
      : null);
  const isSpecialBand = renderKind === 'foreground' || renderKind === 'ground';
  return {
    preview: true,
    previewKind,
    previewKey,
    previewId: `${previewKind}-${previewKey}`,
    previewActive,
    previewHasContent,
    sectionId: String(container?.faNexusSectionId || '').trim() || null,
    canDragPreview: canDragPreviewOverride !== undefined
      ? !!canDragPreviewOverride
      : (previewActive || previewHasContent),
    name: baseLabel,
    baseName: baseLabel,
    elevation: renderElevation,
    documentElevation,
    documentElevationKey,
    renderElevation,
    renderElevationKey,
    placementSort,
    sort: isSpecialBand
      ? normalizeRenderOrderValue(explicitRenderSort, derivedRenderOrder?.sort)
      : explicitRenderSort,
    sortLayer: isSpecialBand
      ? normalizeRenderOrderValue(explicitSortLayer, derivedRenderOrder?.sortLayer)
      : explicitSortLayer,
    zIndex: isSpecialBand
      ? normalizeRenderOrderValue(explicitZIndex, derivedRenderOrder?.zIndex)
      : explicitZIndex,
    lastSortedIndex: normalizeRenderOrderValue(container?._lastSortedIndex ?? 0),
    renderKind,
    placementLevelId,
    placementLevelName,
    bandVisualizationLabel,
    typeIcon,
    typeLabel: baseLabel
  };
}

export function buildLayerManagerSceneMarkerEntry(texture, index = 0, {
  quantizeElevation = null,
  elevationGroupKey = null,
  isLevelTextureMarkerHidden = null,
  user = globalThis.game?.user,
  getSortLayers = getPrimaryCanvasSortLayers
} = {}) {
  const caller = 'buildLayerManagerSceneMarkerEntry';
  const quantize = requireEntryDependency('quantizeElevation', quantizeElevation, caller);
  const groupKey = requireEntryDependency('elevationGroupKey', elevationGroupKey, caller);
  const isMarkerHidden = requireEntryDependency('isLevelTextureMarkerHidden', isLevelTextureMarkerHidden, caller);
  const sortLayersForCanvas = requireEntryDependency('getSortLayers', getSortLayers, caller);
  const kind = texture?.isBackground ? 'background' : 'foreground';
  const numeric = Number(texture?.elevation);
  if (!Number.isFinite(numeric)) return null;
  const level = texture?.level || null;
  const rawLevelName = String(level?.name || '').trim();
  const levelLabel = rawLevelName || (Number.isFinite(level?.index) ? `Level ${Number(level.index) + 1}` : 'Level');
  const label = `${levelLabel} ${kind === 'foreground' ? 'Foreground' : 'Background'} Image`;
  const icon = kind === 'foreground' ? 'fa-solid fa-layer-group' : 'fa-solid fa-image';
  const sortLayers = sortLayersForCanvas();
  return {
    marker: true,
    markerKind: kind,
    markerId: `scene-${String(level?.id || texture?.sort || 'unknown')}-${kind}`,
    markerLevelId: String(level?.id || ''),
    markerLevelName: levelLabel,
    markerScope: texture?.isUpper ? 'upper' : (level?.isView ? 'viewed' : 'visible'),
    name: label,
    hidden: isMarkerHidden(level, kind),
    canToggleVisibility: !!level?.canUserModify?.(user, 'update'),
    elevation: quantize(numeric),
    elevationKey: groupKey(numeric),
    sort: normalizeRenderOrderValue(texture?.sort ?? 0),
    sortLayer: normalizeRenderOrderValue(sortLayers?.SCENE),
    zIndex: normalizeRenderOrderValue(texture?.zIndex ?? 0),
    lastSortedIndex: normalizeRenderOrderValue(index),
    typeIcon: icon,
    typeLabel: label
  };
}

export function buildTileSearchText(entry) {
  const tokens = [
    entry?.name,
    entry?.typeLabel,
    entry?.typeKey,
    entry?.elevationLabel,
    entry?.locked ? 'locked' : 'unlocked',
    entry?.hidden ? 'hidden' : 'visible',
    entry?.renderKind === 'foreground' ? 'foreground band boundary' : '',
    entry?.renderKind === 'ground' ? 'ground band background boundary' : '',
    entry?.bandVisualizationLabel || '',
    entry?.hasHsbc ? 'hsbc hue saturation brightness contrast' : '',
    entry?.hasMask ? 'mask masked masking tile mask' : '',
    entry?.hasShadowOnly ? 'shadow only shadow-only shadowonly drop shadow' : '',
    entry?.typeKey === 'building' ? 'wall building' : ''
  ];
  return tokens
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

export function collectEntryGroupSearchTokens(entry, {
  elevationGroupMetadata = {},
  nestedGrouping = false,
  getElevationGroupName = null,
  elevationGroupKey = null,
  resolveGroupKeys = null
} = {}) {
  if (typeof getElevationGroupName !== 'function') return [];
  if (typeof elevationGroupKey !== 'function') return [];
  const elevation = Number(entry?.documentElevation ?? entry?.elevation ?? 0);
  const exactKey = String(entry?.documentElevationKey || entry?.elevationKey || elevationGroupKey(elevation)).trim();
  if (!exactKey) return [];
  const keys = nestedGrouping && typeof resolveGroupKeys === 'function'
    ? resolveGroupKeys(elevation)
    : [exactKey];
  const tokens = [];
  for (const key of keys) {
    const groupName = getElevationGroupName(elevationGroupMetadata, key);
    if (!groupName) continue;
    tokens.push(groupName);
  }
  return tokens;
}

export function applyGroupSearchTextToEntries(entries = [], {
  elevationGroupMetadata = {},
  nestedGrouping = false,
  getElevationGroupName = null,
  elevationGroupKey = null,
  resolveGroupKeys = null
} = {}) {
  if (!Array.isArray(entries) || !entries.length) return entries;
  for (const entry of entries) {
    if (!entry || entry.preview || entry.marker || entry.separator) continue;
    const baseSearchText = buildTileSearchText(entry);
    const groupTokens = collectEntryGroupSearchTokens(entry, {
      elevationGroupMetadata,
      nestedGrouping,
      getElevationGroupName,
      elevationGroupKey,
      resolveGroupKeys
    });
    entry.searchText = [baseSearchText, ...groupTokens]
      .map((value) => String(value ?? '').trim().toLowerCase())
      .filter(Boolean)
      .join(' ');
  }
  return entries;
}

export function buildLayerManagerTileEntry(doc, index, {
  selected = false,
  computeTileName = null,
  formatElevation = null,
  resolveTileType = null,
  isLayerHidden = null,
  hasTileHsbc = null,
  hasTileMask = null,
  hasTileShadowOnly = null,
  quantizeElevation = null,
  elevationGroupKey = null,
  typeNormalizer = normalizeTileTypeKey,
  getRenderOrder = getTileRenderOrder
} = {}) {
  if (typeof computeTileName !== 'function') {
    throw new Error('buildLayerManagerTileEntry requires computeTileName');
  }
  if (typeof formatElevation !== 'function') {
    throw new Error('buildLayerManagerTileEntry requires formatElevation');
  }
  if (typeof resolveTileType !== 'function') {
    throw new Error('buildLayerManagerTileEntry requires resolveTileType');
  }
  if (typeof isLayerHidden !== 'function') {
    throw new Error('buildLayerManagerTileEntry requires isLayerHidden');
  }
  if (typeof hasTileHsbc !== 'function') {
    throw new Error('buildLayerManagerTileEntry requires hasTileHsbc');
  }
  if (typeof hasTileMask !== 'function') {
    throw new Error('buildLayerManagerTileEntry requires hasTileMask');
  }
  if (typeof quantizeElevation !== 'function') {
    throw new Error('buildLayerManagerTileEntry requires quantizeElevation');
  }
  if (typeof elevationGroupKey !== 'function') {
    throw new Error('buildLayerManagerTileEntry requires elevationGroupKey');
  }

  const safeIndex = Number.isFinite(index) ? index : 0;
  const renderOrder = getRenderOrder(doc, safeIndex);
  const elevation = quantizeElevation(renderOrder.elevation);
  const documentElevation = quantizeElevation(Number(doc?.elevation ?? elevation) || 0);
  const analysis = renderOrder?.analysis || null;
  const placementLevelId = String(renderOrder?.placementLevelId || analysis?.placementLevelId || '').trim() || null;
  const placementLevelName = String(analysis?.placementRange?.levelName || placementLevelId || '').trim() || null;
  const renderKind = String(renderOrder?.kind || 'normal').trim() || 'normal';
  const renderElevationKey = elevationGroupKey(elevation);
  const documentElevationKey = elevationGroupKey(documentElevation);
  const bandVisualizationKey = renderKind === 'foreground'
    ? `foreground:${placementLevelId || 'none'}:${renderElevationKey}`
    : (renderKind === 'ground'
      ? `ground:${placementLevelId || 'none'}:${renderElevationKey}`
      : null);
  const bandVisualizationLabel = renderKind === 'foreground'
    ? (placementLevelName ? `${placementLevelName} Foreground` : 'Foreground Band')
    : (renderKind === 'ground'
      ? (placementLevelName ? `${placementLevelName} Background` : 'Background Band')
      : null);
  const entry = {
    id: doc?.id || doc?._id,
    name: computeTileName({ document: doc }, safeIndex),
    elevation,
    elevationKey: documentElevationKey,
    elevationLabel: formatElevation(documentElevation),
    documentElevation,
    documentElevationKey,
    renderElevation: elevation,
    renderElevationKey,
    sort: renderOrder.sort,
    sortLayer: renderOrder.sortLayer,
    zIndex: renderOrder.zIndex,
    lastSortedIndex: renderOrder.lastSortedIndex,
    selected: !!selected,
    hidden: isLayerHidden(doc),
    locked: !!doc?.locked,
    canToggleVisibility: !!doc?.canUserModify?.(game.user, 'update'),
    canToggleLock: !!doc?.canUserModify?.(game.user, 'update'),
    canReorder: !!doc?.canUserModify?.(game.user, 'update'),
    index: safeIndex,
    renderKind,
    placementLevelId,
    placementLevelName,
    bandVisualizationKey,
    bandVisualizationLabel
  };
  const typeInfo = resolveTileType(doc) || {};
  entry.typeIcon = typeInfo.icon;
  entry.typeLabel = typeInfo.label;
  entry.typeKey = typeInfo.key || typeNormalizer(typeInfo.label) || 'asset';
  entry.hasHsbc = hasTileHsbc(doc);
  entry.hasMask = hasTileMask(doc);
  entry.hasShadowOnly = typeof hasTileShadowOnly === 'function' ? hasTileShadowOnly(doc) : false;
  entry.searchText = buildTileSearchText(entry);
  return entry;
}
