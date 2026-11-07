import {
  buildForegroundBandGroupKey,
  buildGroundBandGroupKey,
  buildSupplementalGroupingPath,
  getSyntheticBandGroupBlockRank,
  getSyntheticBandSupplementalBlockRank,
  isEditableElevationGroupKey
} from '../layer-manager-hierarchy.js';
import { elevationGroupKey } from './elevation-group-metadata.js';
import { getLayerManagerFolderDepthColor } from '../actions/section-actions.js';
import { sortLayerManagerRenderEntries } from './render-entries.js';
import { normalizeLayerManagerSections, sectionKey } from './section-metadata.js';

const LEVEL_BOUNDARY_TOP_BLOCK_RANK = 0;
const LEVEL_BOUNDARY_BOTTOM_BLOCK_RANK = 9;

function requireMaterializerDependency(name, value) {
  if (typeof value !== 'function') {
    throw new Error(`materializeLayerManagerViewState requires ${name}`);
  }
  return value;
}

function applyTreeDepth(items = [], depth = 0) {
  return items.map((item) => ({
    ...item,
    treeDepth: depth,
    indentPx: depth * 12
  }));
}

function sortBlocks(left, right) {
  return Number(right?.blockElevation ?? 0) - Number(left?.blockElevation ?? 0)
    || Number(left?.blockRank ?? 0) - Number(right?.blockRank ?? 0);
}

function blockMatchesKey(block, key) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return false;
  return String(block?.groupKey || '').trim() === normalizedKey
    || String(block?.blockKey || '').trim() === normalizedKey;
}

function findTopLevelBlockIndexByKey(blocks = [], key = '') {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return -1;
  const groupIndex = blocks.findIndex((block) => String(block?.groupKey || '').trim() === normalizedKey);
  if (groupIndex >= 0) return groupIndex;
  return blocks.findIndex((block) => String(block?.blockKey || '').trim() === normalizedKey);
}

function findTopLevelBlockEndIndexByKey(blocks = [], key = '') {
  const startIndex = findTopLevelBlockIndexByKey(blocks, key);
  if (startIndex < 0) return -1;
  let endIndex = startIndex;
  while ((endIndex + 1) < blocks.length && blockMatchesKey(blocks[endIndex + 1], key)) {
    endIndex += 1;
  }
  return endIndex;
}

function materializeSupplementalBlocks(blockMap = null, depth = 0) {
  if (!(blockMap instanceof Map)) return [];
  return Array.from(blockMap.values())
    .map((block) => ({
      blockKey: String(block?.key || '').trim(),
      blockElevation: Number(block?.elevation ?? 0),
      blockRank: getSyntheticBandSupplementalBlockRank(block?.key, 1),
      entries: applyTreeDepth(
        (Array.isArray(block?.items) ? block.items.slice() : []).sort(sortLayerManagerRenderEntries),
        depth
      )
    }))
    .sort(sortBlocks);
}

/**
 * A preview row at an Elevation that holds no layer yet has no Elevation header
 * above it. It names its Elevation itself and is indented like a layer, one step
 * in from where that header would stand.
 */
function labelHeaderlessPreviewRows(blocks = [], format) {
  for (const block of blocks) {
    block.entries = block.entries.map((item) => {
      if (!item?.preview) return item;
      const depth = Number(item.treeDepth ?? 0) + 1;
      return {
        ...item,
        previewElevationLabel: format(item.documentElevation ?? item.elevation),
        treeDepth: depth,
        indentPx: depth * 12
      };
    });
  }
  return blocks;
}

function materializeSectionedItems({
  fullItems = [],
  matchingItems = [],
  fullDocs = [],
  sectionMetadata = {},
  sessionState = null,
  elevationKey = '',
  depth = 0,
  isHidden = null,
  user = globalThis.game?.user,
  selectedSectionIds = new Set(),
  fullSectionDocsById = new Map(),
  matchingTileIdsBySection = new Map()
} = {}) {
  const metadata = normalizeLayerManagerSections(sectionMetadata);
  const sections = Object.fromEntries(Object.entries(metadata.sections).filter(([, section]) => (
    !section.elevationKey || section.elevationKey === elevationKey
  )));
  const memberships = metadata.memberships;
  const docsById = new Map((Array.isArray(fullDocs) ? fullDocs : [])
    .map((doc) => [String(doc?.id || '').trim(), doc])
    .filter(([id]) => !!id));
  const fullBySection = new Map();
  const matchingBySection = new Map();
  const rootMatchingItems = [];

  const add = (map, id, item) => {
    const list = map.get(id) || [];
    list.push(item);
    map.set(id, list);
  };
  for (const item of fullItems) {
    const tileId = String(item?.id || '').trim();
    const explicitSectionId = String(item?.sectionId || '').trim();
    const memberSectionId = tileId && sections[memberships[tileId]]
      ? memberships[tileId]
      : (sections[explicitSectionId] ? explicitSectionId : null);
    item.sectionId = memberSectionId;
    if (memberSectionId) add(fullBySection, memberSectionId, item);
  }
  for (const item of matchingItems) {
    const tileId = String(item?.id || '').trim();
    const explicitSectionId = String(item?.sectionId || '').trim();
    const memberSectionId = tileId && sections[memberships[tileId]]
      ? memberships[tileId]
      : (sections[explicitSectionId] ? explicitSectionId : null);
    item.sectionId = memberSectionId;
    if (memberSectionId) add(matchingBySection, memberSectionId, item);
    else rootMatchingItems.push(item);
  }

  const childIdsByParent = new Map();
  for (const [id, section] of Object.entries(sections)) {
    const parentId = section.parentId && sections[section.parentId] ? section.parentId : '';
    const children = childIdsByParent.get(parentId) || [];
    children.push(id);
    childIdsByParent.set(parentId, children);
  }

  const cache = new Map();
  const summarize = (id) => {
    if (cache.has(id)) return cache.get(id);
    const full = (fullBySection.get(id) || []).slice();
    const matching = (matchingBySection.get(id) || []).slice();
    const childIds = childIdsByParent.get(id) || [];
    for (const childId of childIds) {
      const child = summarize(childId);
      full.push(...child.full);
      matching.push(...child.matching);
    }
    full.sort(sortLayerManagerRenderEntries);
    matching.sort(sortLayerManagerRenderEntries);
    const summary = {
      full,
      matching,
      representative: full.find((item) => !item?.preview)
        || matching.find((item) => !item?.preview)
        || full[0]
        || matching[0]
        || null
    };
    cache.set(id, summary);
    return summary;
  };

  const renderSection = (id, sectionDepth) => {
    const section = sections[id];
    const summary = summarize(id);
    if (!section || (!summary.matching.length && (summary.full.length || section.elevationKey !== elevationKey))) return null;
    const key = sectionKey(id);
    const matchingDocs = summary.matching.map((item) => docsById.get(String(item?.id || '').trim())).filter(Boolean);
    const fullSectionDocs = summary.full.map((item) => docsById.get(String(item?.id || '').trim())).filter(Boolean);
    fullSectionDocsById.set(id, fullSectionDocs);
    matchingTileIdsBySection.set(id, matchingDocs.map((doc) => doc.id).filter(Boolean));
    const entries = [{
      separator: true,
      section: true,
      sectionId: id,
      sectionKey: key,
      elevationKey,
      groupDisplayName: section.name,
      groupHasCustomName: true,
      groupHidden: matchingDocs.length ? matchingDocs.every((doc) => isHidden(doc)) : false,
      groupLocked: matchingDocs.length ? matchingDocs.every((doc) => !!doc?.locked) : false,
      canToggleVisibility: matchingDocs.some((doc) => doc?.canUserModify?.(user, 'update')),
      canDragSection: fullSectionDocs.length > 0
        && matchingDocs.length === fullSectionDocs.length
        && fullSectionDocs.every((doc) => doc?.canUserModify?.(user, 'update')),
      selected: selectedSectionIds?.has?.(id) === true,
      matchingCount: matchingDocs.length,
      collapsed: !!sessionState?.collapsedElevations?.has?.(key),
      treeDepth: sectionDepth,
      indentPx: sectionDepth * 12,
      groupColor: getLayerManagerFolderDepthColor(sectionDepth),
      groupClass: 'fa-nexus-layer-manager__separator--section'
    }];
    if (sessionState?.collapsedElevations?.has?.(key)) return { entries, representative: summary.representative };

    const blocks = (matchingBySection.get(id) || []).map((item) => ({
      entries: applyTreeDepth([item], sectionDepth + 1),
      representative: item
    }));
    for (const childId of childIdsByParent.get(id) || []) {
      const block = renderSection(childId, sectionDepth + 1);
      if (block) blocks.push(block);
    }
    blocks.sort((left, right) => !left.representative ? (right.representative ? -1 : 0) : !right.representative ? 1 : sortLayerManagerRenderEntries(left.representative, right.representative));
    for (const block of blocks) entries.push(...block.entries);
    return { entries, representative: summary.representative };
  };

  const rootBlocks = rootMatchingItems.map((item) => ({
    entries: applyTreeDepth([item], depth),
    representative: item
  }));
  for (const id of childIdsByParent.get('') || []) {
    const block = renderSection(id, depth);
    if (block) rootBlocks.push(block);
  }
  rootBlocks.sort((left, right) => !left.representative ? (right.representative ? -1 : 0) : !right.representative ? 1 : sortLayerManagerRenderEntries(left.representative, right.representative));
  return rootBlocks.flatMap((block) => block.entries);
}

// Reuse the same folder-block materialization for keyboard/wheel movement.
// Input ranks are already in native render order; disclosure and search do not
// remove documents from a structural reorder.
export function materializeLayerManagerSectionOrder(orderedDocs, sectionMetadata, elevationKey) {
  const items = orderedDocs.map((doc, index) => ({ id: doc.id, sort: -index }));
  return materializeSectionedItems({
    fullItems: items, matchingItems: items, fullDocs: orderedDocs,
    sectionMetadata, elevationKey, isHidden: () => false
  });
}

export function orderLayerManagerSectionDocuments(orderedDocs, sectionMetadata, elevationKey) {
  const docsById = new Map(orderedDocs.map(doc => [doc.id, doc]));
  return materializeLayerManagerSectionOrder(orderedDocs, sectionMetadata, elevationKey)
    .filter(entry => !entry.separator).map(entry => docsById.get(entry.id));
}

export function materializeLayerManagerViewState({
  hierarchy = null,
  sessionState = null,
  elevationGroupMetadata = {},
  sectionMetadata = {},
  supplementalEntries = [],
  levelBoundaryEntries = [],
  nestedGrouping = false,
  formatElevation = null,
  getElevationGroupName = null,
  isLayerHidden = null,
  resolveSharedTopBoundaryUpperGroundBandKey = null,
  selectedSectionIds = new Set(),
  user = globalThis.game?.user
} = {}) {
  const format = requireMaterializerDependency('formatElevation', formatElevation);
  const getGroupName = requireMaterializerDependency('getElevationGroupName', getElevationGroupName);
  const isHidden = requireMaterializerDependency('isLayerHidden', isLayerHidden);
  const resolveUpperGroundBandKey = requireMaterializerDependency(
    'resolveSharedTopBoundaryUpperGroundBandKey',
    resolveSharedTopBoundaryUpperGroundBandKey
  );

  const entries = [];
  const matchingTileIdsByElevation = new Map();
  const folderElevationKeys = new Set(Object.values(normalizeLayerManagerSections(sectionMetadata).sections).map(section => section.elevationKey));
  const fullGroupDocsByKey = new Map();
  const matchingTileIdsBySection = new Map();
  const fullSectionDocsById = new Map();
  const fullVisible = hierarchy?.fullVisible || {};
  const matchingVisible = hierarchy?.matchingVisible || {};
  const fullNodesByKey = fullVisible?.nodesByKey instanceof Map ? fullVisible.nodesByKey : new Map();
  const matchingNodesByKey = matchingVisible?.nodesByKey instanceof Map ? matchingVisible.nodesByKey : new Map();
  const visibleGroupKeys = matchingVisible?.visibleKeys instanceof Set ? matchingVisible.visibleKeys : new Set();

  for (const [key, node] of fullNodesByKey.entries()) {
    fullGroupDocsByKey.set(key, Array.isArray(node?.fullSubtreeDocs) ? node.fullSubtreeDocs.slice() : []);
  }
  for (const [key, node] of matchingNodesByKey.entries()) {
    const docs = Array.isArray(node?.matchingSubtreeDocs) ? node.matchingSubtreeDocs : [];
    matchingTileIdsByElevation.set(key, docs.map((doc) => doc?.id).filter(Boolean));
  }

  const persistentSupplementalsByGroupKey = new Map();
  const exactSupplementalsByGroupKey = new Map();
  const orphanSupplementalsByGroupKey = new Map();
  const topLevelSupplementals = new Map();

  const resolveSupplementalGroupingElevation = (item, path = null) => {
    const resolvedPath = Array.isArray(path) ? path : buildSupplementalGroupingPath(item, { nestedGrouping });
    const pathElevation = Number(resolvedPath.at(-1)?.elevation);
    if (Number.isFinite(pathElevation)) return pathElevation;
    const groupedElevation = Number(item?.groupElevation ?? item?.documentElevation ?? item?.elevation ?? 0);
    return Number.isFinite(groupedElevation) ? groupedElevation : 0;
  };

  const attachSupplemental = (targetMap, ownerKey, item) => {
    if (!ownerKey) return;
    let exactMap = targetMap.get(ownerKey);
    if (!exactMap) {
      exactMap = new Map();
      targetMap.set(ownerKey, exactMap);
    }
    const path = buildSupplementalGroupingPath(item, { nestedGrouping });
    const exactKey = String(path.at(-1)?.key || item?.elevationKey || '').trim() || elevationGroupKey(item?.elevation ?? 0);
    const groupingElevation = resolveSupplementalGroupingElevation(item, path);
    let block = exactMap.get(exactKey);
    if (!block) {
      block = {
        key: exactKey,
        elevation: groupingElevation,
        items: []
      };
      exactMap.set(exactKey, block);
    }
    if (Number.isFinite(groupingElevation)) block.elevation = groupingElevation;
    block.items.push(item);
  };

  const findVisibleAncestorKey = (item) => {
    const path = buildSupplementalGroupingPath(item, { nestedGrouping });
    let nearest = null;
    for (const segment of path) {
      const key = String(segment?.key || '').trim();
      if (!key || !visibleGroupKeys.has(key)) continue;
      nearest = key;
    }
    return nearest;
  };

  const sortedSupplementalEntries = Array.isArray(supplementalEntries)
    ? supplementalEntries.slice().sort(sortLayerManagerRenderEntries)
    : [];
  for (const item of sortedSupplementalEntries) {
    const path = buildSupplementalGroupingPath(item, { nestedGrouping });
    const exactKey = String(path.at(-1)?.key || item?.elevationKey || '').trim() || elevationGroupKey(item?.elevation ?? 0);
    if (item?.marker) {
      if (visibleGroupKeys.has(exactKey)) {
        attachSupplemental(persistentSupplementalsByGroupKey, exactKey, item);
        continue;
      }
      const ancestorKey = findVisibleAncestorKey(item);
      if (ancestorKey) {
        attachSupplemental(persistentSupplementalsByGroupKey, ancestorKey, item);
        continue;
      }
      attachSupplemental(topLevelSupplementals, '__root__', item);
      continue;
    }
    if (visibleGroupKeys.has(exactKey)) {
      attachSupplemental(exactSupplementalsByGroupKey, exactKey, item);
      continue;
    }
    const ancestorKey = findVisibleAncestorKey(item);
    if (ancestorKey) {
      attachSupplemental(orphanSupplementalsByGroupKey, ancestorKey, item);
      continue;
    }
    attachSupplemental(topLevelSupplementals, '__root__', item);
  }

  const renderGroupBlock = (groupKey) => {
    const node = matchingNodesByKey.get(groupKey);
    if (!node) return null;
    const matchingDocs = Array.isArray(node?.matchingSubtreeDocs)
      ? node.matchingSubtreeDocs.filter(Boolean)
      : [];
    const canRenameGroup = node.canRename !== false;
    const canEditElevation = node.canEditElevation !== false && isEditableElevationGroupKey(groupKey);
    const persistedGroupName = canRenameGroup ? getGroupName(elevationGroupMetadata, groupKey) : '';
    const defaultElevationDisplayName = Number.isFinite(node.elevation)
      ? `Elev ${format(node.elevation)}`
      : '';
    const groupDisplayName = persistedGroupName
      || node.defaultName
      || defaultElevationDisplayName;
    const hideDuplicateElevationLabel = !!defaultElevationDisplayName
      && String(groupDisplayName || '').trim() === defaultElevationDisplayName;
    const blockEntries = [{
      separator: true,
      elevation: format(node.elevation),
      elevationValue: node.elevation,
      elevationKey: groupKey,
      groupHasCustomName: !!persistedGroupName || (!canRenameGroup && !!node.defaultName),
      groupName: persistedGroupName || '',
      groupDisplayName,
      groupHidden: matchingDocs.length ? matchingDocs.every((doc) => isHidden(doc)) : false,
      groupLocked: matchingDocs.length ? matchingDocs.every((doc) => !!doc?.locked) : false,
      canToggleVisibility: matchingDocs.some((doc) => doc?.canUserModify?.(user, 'update')),
      matchingCount: matchingDocs.length,
      collapsed: !!sessionState?.collapsedElevations?.has?.(groupKey),
      treeDepth: node.depth,
      indentPx: node.depth * 12,
      groupSynthetic: !!node.isSynthetic,
      hasChildGroups: Array.isArray(node.childKeys) && node.childKeys.length > 0,
      groupCanRename: canRenameGroup,
      groupCanEditElevation: canEditElevation,
      groupCanHeaderDrop: node.canHeaderDrop !== false,
      groupShowElevationLabel: node.showElevationLabel !== false && Number.isFinite(node.elevation),
      groupHideDuplicateElevationLabel: hideDuplicateElevationLabel,
      groupClass: node.groupClass || ''
    }];
    const persistentSupplementalEntries = materializeSupplementalBlocks(
      persistentSupplementalsByGroupKey.get(groupKey),
      Number(node.depth ?? 0) + 1
    ).flatMap((block) => Array.isArray(block?.entries) ? block.entries : []);
    if (sessionState?.collapsedElevations?.has?.(groupKey)) {
      if (persistentSupplementalEntries.length) {
        blockEntries.push(...persistentSupplementalEntries);
      }
      return {
        groupKey,
        blockElevation: Number(node.elevation ?? 0),
        blockRank: getSyntheticBandGroupBlockRank(groupKey, 2),
        entries: blockEntries
      };
    }

    const childBlocks = [];
    const exactSupplementalItems = materializeSupplementalBlocks(exactSupplementalsByGroupKey.get(groupKey), Number(node.depth ?? 0) + 1)
      .flatMap((block) => Array.isArray(block?.entries) ? block.entries : []);
    const exactItems = (Array.isArray(node.matchingExactEntries) ? node.matchingExactEntries : [])
      .concat(exactSupplementalItems)
      .sort(sortLayerManagerRenderEntries);
    if (exactItems.length || folderElevationKeys.has(groupKey)) {
      childBlocks.push({
        blockElevation: Number(node.elevation ?? 0),
        blockRank: node.syntheticBand ? 3 : 2,
        entries: materializeSectionedItems({
          fullItems: (Array.isArray(node.exactEntries) ? node.exactEntries : []).concat(exactSupplementalItems),
          matchingItems: exactItems,
          fullDocs: node.exactDocs,
          sectionMetadata,
          sessionState,
          elevationKey: groupKey,
          depth: Number(node.depth ?? 0) + 1,
          isHidden,
          user,
          selectedSectionIds,
          fullSectionDocsById,
          matchingTileIdsBySection
        })
      });
    }

    childBlocks.push(...labelHeaderlessPreviewRows(
      materializeSupplementalBlocks(orphanSupplementalsByGroupKey.get(groupKey), Number(node.depth ?? 0) + 1), format));

    const childKeys = Array.isArray(node.childKeys) ? node.childKeys : [];
    for (const childKey of childKeys) {
      const childBlock = renderGroupBlock(childKey);
      if (childBlock) childBlocks.push(childBlock);
    }

    childBlocks.sort(sortBlocks);
    for (const childBlock of childBlocks) {
      blockEntries.push(...childBlock.entries);
    }
    if (persistentSupplementalEntries.length) {
      blockEntries.push(...persistentSupplementalEntries);
    }
    return {
      groupKey,
      blockElevation: Number(node.elevation ?? 0),
      blockRank: getSyntheticBandGroupBlockRank(groupKey, 2),
      entries: blockEntries
    };
  };

  const topLevelBlocks = [];
  const insertBlockSortedWithoutReorderingExisting = (block) => {
    const insertIndex = topLevelBlocks.findIndex((existing) => sortBlocks(block, existing) < 0);
    if (insertIndex >= 0) topLevelBlocks.splice(insertIndex, 0, block);
    else topLevelBlocks.push(block);
  };
  const rootKeys = Array.isArray(matchingVisible?.rootKeys) ? matchingVisible.rootKeys : [];
  for (const rootKey of rootKeys) {
    const block = renderGroupBlock(rootKey);
    if (block) topLevelBlocks.push(block);
  }
  topLevelBlocks.push(...labelHeaderlessPreviewRows(materializeSupplementalBlocks(topLevelSupplementals.get('__root__'), 0), format));
  topLevelBlocks.sort(sortBlocks);

  const boundaries = Array.isArray(levelBoundaryEntries) ? levelBoundaryEntries : [];
  for (const boundaryEntry of boundaries) {
    const boundaryKind = String(boundaryEntry?.levelBoundaryMembers?.[0]?.kind || '').trim().toUpperCase();
    const levelId = String(boundaryEntry?.levelBoundaryLevelIds || '').trim();
    const boundaryBlock = {
      blockKey: String(boundaryEntry?.levelBoundaryKey || '').trim(),
      blockElevation: Number(boundaryEntry?.elevation ?? 0),
      blockRank: boundaryKind === 'B' ? LEVEL_BOUNDARY_BOTTOM_BLOCK_RANK : LEVEL_BOUNDARY_TOP_BLOCK_RANK,
      entries: applyTreeDepth([boundaryEntry], 0)
    };
    if (boundaryKind === 'T' && levelId) {
      const boundaryElevation = Number(boundaryEntry?.elevation ?? 0);
      const targetKey = buildForegroundBandGroupKey({
        placementLevelId: levelId,
        renderElevation: boundaryElevation
      });
      const targetIndex = findTopLevelBlockIndexByKey(topLevelBlocks, targetKey);
      if (targetIndex >= 0) {
        topLevelBlocks.splice(targetIndex, 0, boundaryBlock);
        continue;
      }
      const upperGroundKey = resolveUpperGroundBandKey({
        levelId,
        elevation: boundaryElevation
      });
      const upperGroundIndex = findTopLevelBlockEndIndexByKey(topLevelBlocks, upperGroundKey);
      if (upperGroundIndex >= 0) {
        topLevelBlocks.splice(upperGroundIndex + 1, 0, boundaryBlock);
        continue;
      }
    }
    if (boundaryKind === 'B' && levelId) {
      const targetKey = buildGroundBandGroupKey({
        placementLevelId: levelId,
        renderElevation: Number(boundaryEntry?.elevation ?? 0)
      });
      const targetIndex = topLevelBlocks.findIndex((block) => String(block?.groupKey || '').trim() === targetKey);
      if (targetIndex >= 0) {
        let insertIndex = targetIndex + 1;
        while (insertIndex < topLevelBlocks.length && String(topLevelBlocks[insertIndex]?.blockKey || '').trim() === targetKey) {
          insertIndex += 1;
        }
        topLevelBlocks.splice(insertIndex, 0, boundaryBlock);
        continue;
      }
      const fallbackIndex = topLevelBlocks.findIndex((block) => String(block?.blockKey || '').trim() === targetKey);
      if (fallbackIndex >= 0) {
        let insertIndex = fallbackIndex + 1;
        while (insertIndex < topLevelBlocks.length && String(topLevelBlocks[insertIndex]?.blockKey || '').trim() === targetKey) {
          insertIndex += 1;
        }
        topLevelBlocks.splice(insertIndex, 0, boundaryBlock);
        continue;
      }
    }
    insertBlockSortedWithoutReorderingExisting(boundaryBlock);
  }

  for (const block of topLevelBlocks) {
    entries.push(...block.entries);
  }

  return {
    entries,
    matchingTileIdsByElevation,
    fullGroupDocsByKey,
    matchingTileIdsBySection,
    fullSectionDocsById
  };
}
