import {
  cloneElevationGroupMetadata,
  elevationGroupKey,
  parseElevationInput,
  quantizeElevation,
  serializeElevationGroupMetadata
} from './model/elevation-group-metadata.js';

const MAX_ELEVATION_DECIMALS = 4;
const ELEVATION_SCALE = 10 ** MAX_ELEVATION_DECIMALS;

export function formatLayerManagerElevation(value) {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * ELEVATION_SCALE) / ELEVATION_SCALE;
  const fixed = rounded.toFixed(MAX_ELEVATION_DECIMALS).replace(/\.?0+$/, '');
  return fixed || '0';
}

function elevationKeyToUnits(value) {
  const numeric = parseElevationInput(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(quantizeElevation(numeric) * ELEVATION_SCALE);
}

function unitsToElevation(units) {
  const numeric = Number(units);
  if (!Number.isFinite(numeric)) return 0;
  return quantizeElevation(numeric / ELEVATION_SCALE);
}

function ceilingElevationKeyAtPrecision(value, precision) {
  const digits = Number(precision);
  if (!Number.isInteger(digits) || digits < 1 || digits > MAX_ELEVATION_DECIMALS) {
    throw new Error(`Invalid elevation precision: ${precision}`);
  }
  const units = elevationKeyToUnits(value);
  const step = 10 ** (MAX_ELEVATION_DECIMALS - digits);
  const bucketUnits = Math.ceil(units / step) * step;
  return elevationGroupKey(unitsToElevation(bucketUnits));
}

export function buildNestedElevationPath(value) {
  const numeric = parseElevationInput(value);
  if (!Number.isFinite(numeric)) return [];
  const path = [];
  let lastKey = null;
  for (let digits = 1; digits <= MAX_ELEVATION_DECIMALS; digits += 1) {
    const key = ceilingElevationKeyAtPrecision(numeric, digits);
    if (!key || key === lastKey) continue;
    path.push(key);
    lastKey = key;
  }
  return path;
}

export function buildPrefixedNestedElevationPath(value, prefix = '') {
  const normalizedPrefix = String(prefix || '').trim();
  if (!normalizedPrefix) {
    return buildNestedElevationPath(value).map((key) => ({
      key,
      elevation: parseElevationInput(key)
    }));
  }
  return buildNestedElevationPath(value).map((key) => ({
    key: `${normalizedPrefix}:${key}`,
    elevation: parseElevationInput(key)
  }));
}

export function buildGroundBandGroupKey({ placementLevelId = null, renderElevation = 0 } = {}) {
  const levelKey = String(placementLevelId || 'none').trim() || 'none';
  return `ground-band:${levelKey}:${elevationGroupKey(renderElevation)}`;
}

function buildGroundExactGroupKey({ placementLevelId = null, groupElevation = 0 } = {}) {
  const levelKey = String(placementLevelId || 'none').trim() || 'none';
  return `ground:${levelKey}:${elevationGroupKey(groupElevation)}`;
}

export function buildForegroundBandGroupKey({ placementLevelId = null, renderElevation = 0 } = {}) {
  const levelKey = String(placementLevelId || 'none').trim() || 'none';
  return `foreground-band:${levelKey}:${elevationGroupKey(renderElevation)}`;
}

function buildForegroundExactGroupKey({ placementLevelId = null, groupElevation = 0 } = {}) {
  const levelKey = String(placementLevelId || 'none').trim() || 'none';
  return `foreground:${levelKey}:${elevationGroupKey(groupElevation)}`;
}

export function getSyntheticBandGroupBlockRank(groupKey, fallbackRank = 2) {
  const normalizedKey = String(groupKey || '').trim();
  if (normalizedKey.startsWith('ground-band:')) return 2;
  if (normalizedKey.startsWith('foreground-band:')) return 4;
  return fallbackRank;
}

export function getSyntheticBandSupplementalBlockRank(groupKey, fallbackRank = 1) {
  const normalizedKey = String(groupKey || '').trim();
  if (normalizedKey.startsWith('ground-band:')) return 3;
  if (normalizedKey.startsWith('foreground-band:')) return 5;
  return fallbackRank;
}

export function isSyntheticDisplayGroupKey(value) {
  return !Number.isFinite(parseElevationInput(value));
}

export function isEditableElevationGroupKey(value) {
  const key = String(value || '').trim();
  if (!key) return false;
  if (Number.isFinite(parseElevationInput(key))) return true;
  const match = /^(foreground|ground):([^:]+):(.+)$/.exec(key);
  return !!match && Number.isFinite(parseElevationInput(match[3]));
}

function buildBandDisplayLabel(kind, levelName = '') {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const normalizedLevelName = String(levelName || '').trim();
  const suffix = normalizedKind === 'foreground'
    ? 'Foreground'
    : 'Background';
  if (normalizedLevelName) return `${normalizedLevelName} ${suffix}`;
  return normalizedKind === 'foreground' ? 'Foreground Band' : 'Background Band';
}

export function buildDisplayGroupingForEntry(entry, { nestedGrouping = false } = {}) {
  const groupElevation = quantizeElevation(Number(entry?.documentElevation ?? entry?.elevation ?? 0) || 0);
  const defaultNumericName = `Elev ${formatLayerManagerElevation(groupElevation)}`;
  const renderKind = String(entry?.renderKind || 'normal').trim().toLowerCase();
  if (renderKind !== 'foreground' && renderKind !== 'ground') {
    const exactKey = String(entry?.documentElevationKey || elevationGroupKey(groupElevation)).trim() || elevationGroupKey(groupElevation);
    const path = [{ key: exactKey, elevation: groupElevation }];
    return {
      exactKey,
      groupElevation,
      path: path.map((segment) => ({
        ...segment,
        defaultName: `Elev ${formatLayerManagerElevation(segment.elevation)}`,
        canRename: true,
        canEditElevation: true,
        canHeaderDrop: true,
        showElevationLabel: true
      })),
      defaultName: defaultNumericName,
      canRename: true,
      canEditElevation: true,
      canHeaderDrop: true,
      showElevationLabel: true
    };
  }

  const placementLevelId = String(entry?.placementLevelId || 'none').trim() || 'none';
  const rawRenderElevation = Number(entry?.renderElevation ?? entry?.elevation ?? groupElevation);
  const renderElevation = quantizeElevation(Number.isFinite(rawRenderElevation) ? rawRenderElevation : groupElevation);
  const bandKey = renderKind === 'foreground'
    ? buildForegroundBandGroupKey({ placementLevelId, renderElevation })
    : buildGroundBandGroupKey({ placementLevelId, renderElevation });
  const exactKey = renderKind === 'foreground'
    ? buildForegroundExactGroupKey({ placementLevelId, groupElevation })
    : buildGroundExactGroupKey({ placementLevelId, groupElevation });
  const bandLabel = String(entry?.bandVisualizationLabel || buildBandDisplayLabel(renderKind, entry?.placementLevelName)).trim()
    || buildBandDisplayLabel(renderKind);
  const bandSegment = {
    key: bandKey,
    elevation: renderElevation,
    defaultName: bandLabel,
    forceVisible: true,
    syntheticBand: true,
    canRename: false,
    canEditElevation: false,
    canHeaderDrop: false,
    showElevationLabel: false,
    groupClass: renderKind === 'foreground'
      ? 'fa-nexus-layer-manager__separator--foreground-band'
      : 'fa-nexus-layer-manager__separator--ground-band'
  };
  const elevationSegment = {
    key: exactKey,
    elevation: groupElevation,
    defaultName: defaultNumericName,
    canRename: true,
    canEditElevation: true,
    canHeaderDrop: true,
    showElevationLabel: true
  };
  return {
    exactKey,
    groupElevation,
    path: [bandSegment, elevationSegment],
    defaultName: defaultNumericName,
    bandKey,
    canRename: true,
    canEditElevation: true,
    canHeaderDrop: true,
    showElevationLabel: true
  };
}

export function buildSupplementalGroupingPath(item, { nestedGrouping = false } = {}) {
  if (item?.marker && (item?.markerKind === 'foreground' || item?.markerKind === 'background')) {
    const markerLevelId = String(item?.markerLevelId || 'none').trim() || 'none';
    const markerLevelName = String(item?.markerLevelName || '').trim();
    const markerElevation = Number(item?.elevation ?? 0);
    const isForeground = item?.markerKind === 'foreground';
    return [{
      key: (isForeground ? buildForegroundBandGroupKey : buildGroundBandGroupKey)({
        placementLevelId: markerLevelId,
        renderElevation: Number.isFinite(markerElevation) ? markerElevation : 0
      }),
      elevation: Number.isFinite(markerElevation) ? markerElevation : 0,
      defaultName: buildBandDisplayLabel(isForeground ? 'foreground' : 'ground', markerLevelName),
      forceVisible: true,
      syntheticBand: true,
      canRename: false,
      canEditElevation: false,
      canHeaderDrop: false,
      showElevationLabel: false,
      groupClass: isForeground
        ? 'fa-nexus-layer-manager__separator--foreground-band'
        : 'fa-nexus-layer-manager__separator--ground-band'
    }];
  }
  if (Array.isArray(item?.groupPath) && item.groupPath.length) {
    return item.groupPath.slice();
  }
  const elevation = Number(item?.elevation ?? 0);
  if (!Number.isFinite(elevation)) return [];
  const exactKey = String(item?.elevationKey || elevationGroupKey(elevation)).trim() || elevationGroupKey(elevation);
  return [{ key: exactKey, elevation }];
}

export function createLayerManagerHierarchyNode(key, {
  elevation = null,
  defaultName = '',
  forceVisible = false,
  syntheticBand = false,
  canRename = true,
  canEditElevation = true,
  canHeaderDrop = true,
  showElevationLabel = true,
  groupClass = ''
} = {}) {
  return {
    key,
    elevation: Number.isFinite(elevation) ? Number(elevation) : parseElevationInput(key),
    defaultName: String(defaultName || '').trim(),
    forceVisible: forceVisible === true,
    syntheticBand: syntheticBand === true,
    canRename: canRename !== false,
    canEditElevation: canEditElevation !== false,
    canHeaderDrop: canHeaderDrop !== false,
    showElevationLabel: showElevationLabel !== false,
    groupClass: String(groupClass || '').trim(),
    children: new Map(),
    sortedChildren: [],
    exactEntries: [],
    exactDocs: [],
    matchingExactEntries: [],
    matchingExactDocs: [],
    fullSubtreeDocs: [],
    matchingSubtreeDocs: [],
    hasFullData: false,
    hasMatchingData: false
  };
}

function logHierarchyError(logger, event, data) {
  if (typeof logger?.error === 'function') {
    logger.error(event, data);
  }
}

export function buildLayerManagerElevationHierarchy({
  fullExactGroups = new Map(),
  matchingExactGroups = new Map(),
  resolvePathForGroup = null,
  logger = null
} = {}) {
  const root = createLayerManagerHierarchyNode('__root__', {
    elevation: Infinity,
    forceVisible: true,
    canRename: false,
    canEditElevation: false,
    canHeaderDrop: false,
    showElevationLabel: false
  });
  const nodeIndex = new Map();
  const leafNodeByExactKey = new Map();
  const parentKeyByNodeKey = new Map();
  const ensureNode = (segment) => {
    const key = String(segment?.key || '').trim();
    if (!key) return null;
    let node = nodeIndex.get(key);
    if (!node) {
      node = createLayerManagerHierarchyNode(key, segment || {});
      nodeIndex.set(key, node);
      return node;
    }
    if (Number.isFinite(segment?.elevation) && !Number.isFinite(node.elevation)) node.elevation = Number(segment.elevation);
    if (!node.defaultName && segment?.defaultName) node.defaultName = String(segment.defaultName).trim();
    if (segment?.forceVisible === true) node.forceVisible = true;
    if (segment?.syntheticBand === true) node.syntheticBand = true;
    if (segment?.canRename === false) node.canRename = false;
    if (segment?.canEditElevation === false) node.canEditElevation = false;
    if (segment?.canHeaderDrop === false) node.canHeaderDrop = false;
    if (segment?.showElevationLabel === false) node.showElevationLabel = false;
    if (!node.groupClass && segment?.groupClass) node.groupClass = String(segment.groupClass).trim();
    return node;
  };

  for (const [exactKey, group] of fullExactGroups.entries()) {
    const path = typeof resolvePathForGroup === 'function'
      ? resolvePathForGroup(group) || []
      : [{ key: exactKey, elevation: Number(group?.groupElevation ?? group?.elevation ?? parseElevationInput(exactKey)) || 0 }];
    if (!path.length) continue;
    let parent = root;
    for (const segment of path) {
      const node = ensureNode(segment);
      if (!node) continue;
      const key = node.key;
      const parentKey = parent.key || null;
      const existingParentKey = parentKeyByNodeKey.get(key);
      if (existingParentKey !== undefined && existingParentKey !== parentKey) {
        logHierarchyError(logger, 'LayerManager.nestedHierarchy.parentCollision', {
          key,
          parentKey
        });
        throw new Error(`Nested layer manager hierarchy collision at ${key}.`);
      }
      parentKeyByNodeKey.set(key, parentKey);
      if (!parent.children.has(key)) parent.children.set(key, node);
      else if (parent.children.get(key) !== node) {
        logHierarchyError(logger, 'LayerManager.nestedHierarchy.parentCollision', {
          key,
          parentKey
        });
        throw new Error(`Nested layer manager hierarchy collision at ${key}.`);
      }
      parent = node;
    }
    if (Array.isArray(group?.entries) && group.entries.length) parent.exactEntries.push(...group.entries);
    if (Array.isArray(group?.docs) && group.docs.length) parent.exactDocs.push(...group.docs);
    leafNodeByExactKey.set(exactKey, parent.key);
  }

  for (const [exactKey, group] of matchingExactGroups.entries()) {
    const leafKey = leafNodeByExactKey.get(exactKey) || exactKey;
    const node = nodeIndex.get(leafKey);
    if (!node) {
      logHierarchyError(logger, 'LayerManager.nestedHierarchy.matchingNodeMissing', {
        elevationKey: exactKey
      });
      continue;
    }
    if (Array.isArray(group?.entries) && group.entries.length) node.matchingExactEntries.push(...group.entries);
    if (Array.isArray(group?.docs) && group.docs.length) node.matchingExactDocs.push(...group.docs);
  }

  const annotate = (node) => {
    node.sortedChildren = Array.from(node.children.values())
      .filter(Boolean)
      .sort((a, b) => Number(b?.elevation ?? 0) - Number(a?.elevation ?? 0));
    const fullDocs = node.exactDocs.slice();
    const matchingDocs = node.matchingExactDocs.slice();
    for (const child of node.sortedChildren) {
      annotate(child);
      fullDocs.push(...child.fullSubtreeDocs);
      matchingDocs.push(...child.matchingSubtreeDocs);
    }
    node.fullSubtreeDocs = fullDocs;
    node.matchingSubtreeDocs = matchingDocs;
    node.hasFullData = fullDocs.length > 0;
    node.hasMatchingData = matchingDocs.length > 0;
  };

  for (const child of Array.from(root.children.values())) {
    annotate(child);
  }

  const buildVisibleHierarchy = ({ mode }) => {
    const nodesByKey = new Map();
    const rootKeys = [];
    const modeHasDataKey = mode === 'matching' ? 'hasMatchingData' : 'hasFullData';
    const modeExactEntriesKey = mode === 'matching' ? 'matchingExactEntries' : 'exactEntries';

    const visit = (node, parentKey = null, depth = 0) => {
      if (!node?.[modeHasDataKey]) return;
      const childNodes = node.sortedChildren.filter((child) => child?.[modeHasDataKey]);
      const hasExactEntries = Array.isArray(node?.[modeExactEntriesKey]) && node[modeExactEntriesKey].length > 0;
      if (!node.forceVisible && !hasExactEntries && childNodes.length === 1) {
        visit(childNodes[0], parentKey, depth);
        return;
      }

      const info = {
        key: node.key,
        elevation: node.elevation,
        parentKey,
        depth,
        childKeys: [],
        visibleSubtreeKeys: [],
        isSynthetic: node.syntheticBand || node.exactDocs.length === 0,
        defaultName: node.defaultName,
        forceVisible: node.forceVisible,
        syntheticBand: node.syntheticBand,
        canRename: node.canRename,
        canEditElevation: node.canEditElevation,
        canHeaderDrop: node.canHeaderDrop,
        showElevationLabel: node.showElevationLabel,
        groupClass: node.groupClass,
        exactEntries: node.exactEntries.slice(),
        exactDocs: node.exactDocs.slice(),
        matchingExactEntries: node.matchingExactEntries.slice(),
        matchingExactDocs: node.matchingExactDocs.slice(),
        fullSubtreeDocs: node.fullSubtreeDocs.slice(),
        matchingSubtreeDocs: node.matchingSubtreeDocs.slice()
      };
      nodesByKey.set(node.key, info);
      if (parentKey) nodesByKey.get(parentKey)?.childKeys?.push?.(node.key);
      else rootKeys.push(node.key);
      for (const child of childNodes) {
        visit(child, node.key, depth + 1);
      }
    };

    const rootChildren = Array.from(root.children.values())
      .filter((child) => child?.[modeHasDataKey])
      .sort((a, b) => Number(b?.elevation ?? 0) - Number(a?.elevation ?? 0));
    for (const child of rootChildren) {
      visit(child);
    }

    const collectSubtreeKeys = (key) => {
      const node = nodesByKey.get(key);
      if (!node) return [];
      const keys = [key];
      for (const childKey of node.childKeys) {
        keys.push(...collectSubtreeKeys(childKey));
      }
      node.visibleSubtreeKeys = keys;
      return keys;
    };
    for (const key of rootKeys) {
      collectSubtreeKeys(key);
    }

    return {
      mode,
      rootKeys,
      nodesByKey,
      visibleKeys: new Set(nodesByKey.keys())
    };
  };

  return {
    exactKeys: new Set(fullExactGroups.keys()),
    root,
    nodeIndex,
    fullVisible: buildVisibleHierarchy({ mode: 'full' }),
    matchingVisible: buildVisibleHierarchy({ mode: 'matching' })
  };
}

export function synchronizeElevationGroupMetadataWithHierarchy(metadata = {}, hierarchy = null) {
  const normalized = cloneElevationGroupMetadata(metadata);
  const visibleNodes = hierarchy?.nodesByKey instanceof Map ? hierarchy.nodesByKey : new Map();
  const output = {};
  const staleSyntheticKeys = [];
  for (const [key, value] of Object.entries(normalized)) {
    const name = String(value?.name ?? '').trim();
    if (!name) continue;
    const visibleNode = visibleNodes.get(key) || null;
    if (!visibleNode) {
      if (value?.synthetic === true) staleSyntheticKeys.push(key);
      else output[key] = { name };
      continue;
    }
    output[key] = visibleNode.isSynthetic ? { name, synthetic: true } : { name };
  }
  const currentSerialized = JSON.stringify(serializeElevationGroupMetadata(normalized));
  const nextSerialized = JSON.stringify(serializeElevationGroupMetadata(output));
  return {
    metadata: output,
    staleSyntheticKeys,
    changed: currentSerialized !== nextSerialized
  };
}
