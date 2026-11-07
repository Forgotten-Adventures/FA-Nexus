import { normalizeLayerManagerSections } from '../model/section-metadata.js';
import { materializeLayerManagerSectionOrder } from '../model/view-materialization.js';

function quantizeElevation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const quantized = Math.round(numeric * 10000) / 10000;
  return Object.is(quantized, -0) ? 0 : quantized;
}

export function resolveAdjacentElevationNudgeTarget({
  groups = [],
  currentElevationKey = '',
  currentElevation = 0,
  direction = 0
} = {}) {
  const normalizedDirection = Math.sign(Number(direction) || 0);
  const sourceElevation = quantizeElevation(currentElevation);
  if (!normalizedDirection) return null;
  const candidates = (Array.isArray(groups) ? groups : [])
    .map((group) => ({
      ...group,
      elevationKey: String(group?.elevationKey || '').trim(),
      elevation: quantizeElevation(group?.elevation),
      docs: Array.isArray(group?.docs) ? group.docs : []
    }))
    .filter((group) => group.elevationKey && group.elevationKey !== currentElevationKey)
    .sort((left, right) => left.elevation - right.elevation);
  const adjacent = normalizedDirection > 0
    ? candidates.find((group) => group.elevation > sourceElevation)
    : candidates.slice().reverse().find((group) => group.elevation < sourceElevation);
  if (adjacent) {
    return {
      elevationKey: adjacent.elevationKey,
      elevation: adjacent.elevation,
      docs: adjacent.docs,
      edge: normalizedDirection > 0 ? 'bottom' : 'top',
      created: false
    };
  }
  return null;
}

export function resolveLayerManagerPreviewSortStep({
  docs = [],
  sectionMetadata = {},
  sectionId = null,
  currentSort = null,
  anchorTileId = null,
  sortBefore = false,
  direction = 0
} = {}) {
  const normalizedDirection = Math.sign(Number(direction) || 0);
  const normalizedSort = Number(currentSort);
  if (!normalizedDirection || !Number.isFinite(normalizedSort)) return null;
  const metadata = normalizeLayerManagerSections(sectionMetadata);
  const scopeId = metadata.sections[String(sectionId || '').trim()] ? String(sectionId).trim() : null;
  const orderedDocs = (Array.isArray(docs) ? docs : [])
    .filter((doc) => doc?.id && Number.isFinite(Number(doc?.sort)))
    .slice()
    .sort((left, right) => Number(left.sort) - Number(right.sort));
  if (!orderedDocs.length) return null;

  const descendantIds = (rootId) => {
    const ids = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, section] of Object.entries(metadata.sections)) {
        if (!ids.has(section.parentId) || ids.has(id)) continue;
        ids.add(id);
        changed = true;
      }
    }
    return ids;
  };
  const validMembership = (doc) => {
    const membership = metadata.memberships[String(doc?.id || '').trim()];
    return metadata.sections[membership] ? membership : null;
  };
  const blocks = orderedDocs
    .filter((doc) => validMembership(doc) === scopeId)
    .map((doc) => ({ docs: [doc], representativeSort: Number(doc.sort) }));
  for (const [childId, section] of Object.entries(metadata.sections)) {
    if ((section.parentId || null) !== scopeId) continue;
    const childIds = descendantIds(childId);
    const childDocs = orderedDocs.filter((doc) => childIds.has(validMembership(doc)));
    if (!childDocs.length) continue;
    blocks.push({ docs: childDocs, representativeSort: Number(childDocs.at(-1).sort) });
  }
  blocks.sort((left, right) => left.representativeSort - right.representativeSort);

  const normalizedAnchorId = String(anchorTileId || '').trim();
  const anchorBlockIndex = normalizedAnchorId
    ? blocks.findIndex((block) => block.docs.some((doc) => String(doc?.id || '') === normalizedAnchorId))
    : -1;
  let insertionIndex = anchorBlockIndex >= 0
    ? anchorBlockIndex + (sortBefore === true ? 0 : 1)
    : blocks.findIndex((block) => block.representativeSort > normalizedSort);
  if (insertionIndex < 0) insertionIndex = blocks.length;
  const crossedBlock = normalizedDirection > 0 ? blocks[insertionIndex] : blocks[insertionIndex - 1];
  if (crossedBlock) {
    const anchor = normalizedDirection > 0 ? crossedBlock.docs.at(-1) : crossedBlock.docs[0];
    return {
      anchorTileId: String(anchor.id),
      sortBefore: normalizedDirection < 0,
      sectionId: scopeId
    };
  }
  if (!scopeId) return null;
  const scopeIds = descendantIds(scopeId);
  const scopeDocs = orderedDocs.filter((doc) => scopeIds.has(validMembership(doc)));
  if (!scopeDocs.length) return null;
  const anchor = normalizedDirection > 0 ? scopeDocs.at(-1) : scopeDocs[0];
  return {
    anchorTileId: String(anchor.id),
    sortBefore: normalizedDirection < 0,
    sectionId: metadata.sections[scopeId]?.parentId || null
  };
}

export function resolveDraggedTileIds({
  originId = '',
  visibleSelectedDocs = []
} = {}) {
  const selectedDocs = Array.isArray(visibleSelectedDocs) ? visibleSelectedDocs : [];
  const visibleSelectedIds = new Set(selectedDocs.map((doc) => doc?.id).filter(Boolean));
  if (originId && visibleSelectedIds.has(originId) && visibleSelectedIds.size > 1) {
    return selectedDocs.map((doc) => doc?.id).filter(Boolean);
  }
  return originId ? [originId] : [];
}

export function getOrderedDocsByIds({
  tileIds = [],
  viewState = null,
  resolveDocumentById = null
} = {}) {
  const wanted = new Set((Array.isArray(tileIds) ? tileIds : []).filter(Boolean));
  if (!wanted.size) return [];
  const docs = [];
  const orderedIds = Array.isArray(viewState?.fullTileIdsInOrder) ? viewState.fullTileIdsInOrder : [];
  for (const id of orderedIds) {
    if (!wanted.has(id)) continue;
    const doc = viewState?.fullTileDocsById?.get?.(id) || resolveDocumentById?.(id) || null;
    if (doc) docs.push(doc);
  }
  if (docs.length >= wanted.size) return docs;
  for (const id of wanted) {
    if (docs.some((doc) => doc?.id === id)) continue;
    const doc = viewState?.fullTileDocsById?.get?.(id) || resolveDocumentById?.(id) || null;
    if (doc) docs.push(doc);
  }
  return docs;
}

export function setDraggedRowState({
  root = null,
  tileIds = [],
  previewIds = [],
  sectionIds = []
} = {}) {
  if (!root) return;
  const wanted = new Set((Array.isArray(tileIds) ? tileIds : []).filter(Boolean));
  const previewWanted = new Set((Array.isArray(previewIds) ? previewIds : []).filter(Boolean));
  const sectionWanted = new Set((Array.isArray(sectionIds) ? sectionIds : []).filter(Boolean));
  for (const item of root.querySelectorAll('[data-tile-id]')) {
    const id = item?.dataset?.tileId;
    item.classList.toggle('is-dragging', !!id && wanted.has(id));
  }
  for (const item of root.querySelectorAll('[data-preview-id]')) {
    const id = item?.dataset?.previewId;
    item.classList.toggle('is-dragging', !!id && previewWanted.has(id));
  }
  for (const item of root.querySelectorAll('.fa-nexus-layer-manager__separator[data-section-id]')) {
    const id = item?.dataset?.sectionId;
    item.classList.toggle('is-dragging', !!id && sectionWanted.has(id));
  }
}

export function resolveAdjacentSortDropTarget({
  orderedDocs = [],
  movingIds = [],
  direction = 0,
  elevationKey = '',
  sectionMetadata = {}
} = {}) {
  const docs = Array.isArray(orderedDocs) ? orderedDocs : [];
  const wanted = new Set((Array.isArray(movingIds) ? movingIds : []).map(String).filter(Boolean));
  const key = String(elevationKey || '').trim();
  if (!docs.length || !wanted.size || !key || !direction) return null;
  const rows = materializeLayerManagerSectionOrder(docs, sectionMetadata, key);
  const root = { children: [], parent: null };
  const stack = [root];
  const tiles = new Map();
  for (const row of rows) {
    stack.length = row.treeDepth + 1;
    const parent = stack.at(-1);
    const node = { id: row.id, sectionId: row.sectionId, folder: row.section === true, children: [], parent };
    parent.children.push(node);
    if (node.folder) stack.push(node);
    else tiles.set(node.id, node);
  }
  const selectedScopes = new Set(Array.from(wanted, id => tiles.get(id)?.parent));
  if (selectedScopes.size !== 1) return null;
  const scope = selectedScopes.values().next().value;
  if (!scope) return null;
  const scopeId = scope.sectionId || null;
  const selectedIndexes = scope.children
    .map((node, index) => !node.folder && wanted.has(node.id) ? index : -1)
    .filter((index) => index >= 0);
  if (selectedIndexes.length !== wanted.size) return null;
  const start = Math.min(...selectedIndexes);
  const end = Math.max(...selectedIndexes);
  if ((end - start + 1) !== selectedIndexes.length) return null;
  const neighbor = direction > 0 ? scope.children[start - 1] : scope.children[end + 1];
  if (neighbor?.folder) {
    return { kind: 'section-boundary', boundarySectionId: neighbor.sectionId,
      sectionId: neighbor.sectionId, elevationKey: key, placeBefore: direction < 0 };
  }
  if (!neighbor) {
    if (!scopeId) return null;
    return { kind: 'section-boundary', boundarySectionId: scopeId,
      sectionId: scope.parent.sectionId || null, elevationKey: key, placeBefore: direction > 0 };
  }
  return {
    kind: 'row',
    rowId: neighbor.id,
    elevationKey: key,
    sectionId: scopeId,
    placeBefore: direction > 0
  };
}

export function clearDraggedRowState({
  root = null
} = {}) {
  if (!root) return;
  for (const item of root.querySelectorAll('.is-dragging')) {
    item.classList.remove('is-dragging');
  }
}

export function clearDropIndicator({
  root = null
} = {}) {
  if (!root) return null;
  for (const item of root.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-header')) {
    item.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-header');
  }
  return null;
}

export function applyDropIndicator({
  root = null,
  target = null,
  currentDropIndicator = null
} = {}) {
  if (!target?.element) return clearDropIndicator({ root });
  const nextKey = JSON.stringify({
    kind: target.kind,
    rowId: target.rowId || null,
    previewId: target.previewId || null,
    elevationKey: target.elevationKey || null,
    sectionId: target.sectionId || null,
    boundarySectionId: target.boundarySectionId || null,
    placeBefore: target.placeBefore !== false
  });
  if (currentDropIndicator === nextKey) return currentDropIndicator;
  clearDropIndicator({ root });
  if (target.kind === 'header' || target.kind === 'section') {
    target.element.classList.add('is-drop-header');
  } else if (target.placeBefore) {
    target.element.classList.add('is-drop-before');
  } else {
    target.element.classList.add('is-drop-after');
  }
  const depth = Number(target.dropDepth);
  target.element.style?.setProperty?.('--fa-nexus-drop-line-left', `${4 + (Number.isFinite(depth) ? Math.max(0, depth) * 12 : 0)}px`);
  return nextKey;
}

function sectionContainsSection(sectionId = '', candidateId = '', getSectionParentId = null) {
  const targetId = String(sectionId || '').trim();
  let currentId = String(candidateId || '').trim();
  while (targetId && currentId) {
    if (currentId === targetId) return true;
    currentId = String(getSectionParentId?.(currentId) || '').trim();
  }
  return false;
}

function isLastVisibleItemInSection(element, sectionId, elevationKey, getSectionParentId) {
  let sibling = element?.nextElementSibling || null;
  while (sibling) {
    const siblingElevationKey = String(sibling?.dataset?.elevationKey || '').trim();
    if (siblingElevationKey && siblingElevationKey !== elevationKey) return true;
    const siblingSectionId = String(sibling?.dataset?.sectionId || '').trim();
    if (siblingSectionId && sectionContainsSection(sectionId, siblingSectionId, getSectionParentId)) return false;
    if (sibling?.matches?.('[data-tile-id], [data-preview-id], .fa-nexus-layer-manager__separator[data-section-id]')) return true;
    sibling = sibling.nextElementSibling;
  }
  return true;
}

export function resolveDropTarget({
  event = null,
  dragState = null,
  getSectionParentId = null
} = {}) {
  if (!dragState?.tileIds?.length && !String(dragState?.previewId || '').trim()) return null;
  const rootBoundary = event?.target?.closest?.(
    '.fa-nexus-layer-manager__separator--root-drop-target[data-root-drop-elevation-key]'
  );
  if (rootBoundary) {
    const elevationKey = String(rootBoundary?.dataset?.rootDropElevationKey || '').trim();
    if (!elevationKey) return null;
    return {
      kind: 'section-boundary',
      elevationKey,
      sectionId: null,
      boundarySectionId: null,
      placeBefore: false,
      dropDepth: 0,
      element: rootBoundary
    };
  }
  const header = event?.target?.closest?.('.fa-nexus-layer-manager__separator[data-elevation-key]:not(.fa-nexus-layer-manager__separator--level-boundary)');
  if (header) {
    if (String(header?.dataset?.groupCanHeaderDrop || '').trim() === 'false') return null;
    const elevationKey = String(header?.dataset?.elevationKey || '').trim();
    if (!elevationKey) return null;
    const sectionId = String(header?.dataset?.sectionId || '').trim();
    const rect = header.getBoundingClientRect();
    const relativeY = Number(event?.clientY ?? rect.top) - rect.top;
    if (sectionId && relativeY <= rect.height * 0.3) {
      return {
        kind: 'section-boundary',
        elevationKey,
        sectionId: String(getSectionParentId?.(sectionId) || '').trim() || null,
        boundarySectionId: sectionId,
        placeBefore: true,
        dropDepth: Math.max(0, Number(header?.dataset?.treeDepth || 0)),
        element: header
      };
    }
    if (sectionId && relativeY >= rect.height * 0.75 && isLastVisibleItemInSection(
      header,
      sectionId,
      elevationKey,
      getSectionParentId
    )) {
      return {
        kind: 'section-boundary',
        elevationKey,
        sectionId: String(getSectionParentId?.(sectionId) || '').trim() || null,
        boundarySectionId: sectionId,
        placeBefore: false,
        dropDepth: Math.max(0, Number(header?.dataset?.treeDepth || 0) - 1),
        element: header
      };
    }
    return {
      kind: sectionId ? 'section' : 'header',
      elevationKey,
      sectionId: sectionId || null,
      dropDepth: Number(header?.dataset?.treeDepth || 0) + (sectionId ? 1 : 0),
      element: header
    };
  }
  const draggedPreviewId = String(dragState?.previewId || '').trim();
  if (draggedPreviewId) {
    const previewRow = event?.target?.closest?.('[data-preview-id]');
    if (previewRow) {
      const previewId = String(previewRow?.dataset?.previewId || '').trim();
      if (!previewId || previewId === draggedPreviewId) return null;
      const rect = previewRow.getBoundingClientRect();
      const midpoint = rect.top + (rect.height / 2);
      const sectionId = String(previewRow?.dataset?.sectionId || '').trim() || null;
      const relativeY = Number(event?.clientY ?? rect.top) - rect.top;
      if (sectionId && relativeY >= rect.height * 0.75 && isLastVisibleItemInSection(
        previewRow,
        sectionId,
        String(previewRow?.dataset?.elevationKey || '').trim(),
        getSectionParentId
      )) {
        return {
          kind: 'section-boundary',
          elevationKey: String(previewRow?.dataset?.elevationKey || '').trim(),
          sectionId: String(getSectionParentId?.(sectionId) || '').trim() || null,
          boundarySectionId: sectionId,
          placeBefore: false,
          dropDepth: Math.max(0, Number(previewRow?.dataset?.treeDepth || 0) - 1),
          element: previewRow
        };
      }
      return {
        kind: 'preview',
        previewId,
        elevationKey: String(previewRow?.dataset?.elevationKey || '').trim(),
        sectionId,
        placeBefore: Number(event?.clientY ?? 0) <= midpoint,
        dropDepth: Number(previewRow?.dataset?.treeDepth || 0),
        element: previewRow
      };
    }
  }
  const row = event?.target?.closest?.('[data-tile-id]');
  if (!row) return null;
  const rowId = String(row?.dataset?.tileId || '').trim();
  if (!rowId) return null;
  const draggedIds = new Set(dragState.tileIds);
  if (draggedIds.has(rowId)) return null;
  const rect = row.getBoundingClientRect();
  const midpoint = rect.top + (rect.height / 2);
  const sectionId = String(row?.dataset?.sectionId || '').trim() || null;
  const relativeY = Number(event?.clientY ?? rect.top) - rect.top;
  if (sectionId && relativeY >= rect.height * 0.75 && isLastVisibleItemInSection(
    row,
    sectionId,
    String(row?.dataset?.elevationKey || '').trim(),
    getSectionParentId
  )) {
    return {
      kind: 'section-boundary',
      elevationKey: String(row?.dataset?.elevationKey || '').trim(),
      sectionId: String(getSectionParentId?.(sectionId) || '').trim() || null,
      boundarySectionId: sectionId,
      placeBefore: false,
      dropDepth: Math.max(0, Number(row?.dataset?.treeDepth || 0) - 1),
      element: row
    };
  }
  return {
    kind: 'row',
    rowId,
    elevationKey: String(row?.dataset?.elevationKey || '').trim(),
    sectionId,
    placeBefore: Number(event?.clientY ?? 0) <= midpoint,
    dropDepth: Number(row?.dataset?.treeDepth || 0),
    element: row
  };
}

export function prepareListDragStart({
  event = null,
  originId = '',
  orderedDocs = [],
  user = game?.user,
  setDraggedRowState: setDraggedRowStateHook = null,
  clearDropIndicator: clearDropIndicatorHook = null
} = {}) {
  const docs = Array.isArray(orderedDocs) ? orderedDocs : [];
  const tileIds = docs
    .filter((doc) => doc?.canUserModify?.(user, 'update'))
    .map((doc) => doc?.id)
    .filter(Boolean);
  if (!tileIds.length) {
    event?.preventDefault?.();
    return null;
  }
  try {
    if (event?.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', tileIds.join(','));
    }
  } catch (_) {}
  try { setDraggedRowStateHook?.(tileIds); } catch (_) {}
  try { clearDropIndicatorHook?.(); } catch (_) {}
  return { tileIds, originId };
}

export function handleListDragOver({
  event = null,
  dragState = null,
  resolveDropTarget: resolveDropTargetHook = null,
  applyDropIndicator: applyDropIndicatorHook = null,
  clearDropIndicator: clearDropIndicatorHook = null,
  preserveIndicatorOnMiss = false
} = {}) {
  if (!dragState?.tileIds?.length && !String(dragState?.previewId || '').trim()) return null;
  const target = resolveDropTargetHook?.(event) || null;
  if (!target) {
    if (preserveIndicatorOnMiss) {
      event?.preventDefault?.();
      try {
        if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
      } catch (_) {}
    } else {
      try { clearDropIndicatorHook?.(); } catch (_) {}
    }
    return null;
  }
  event?.preventDefault?.();
  try {
    if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
  } catch (_) {}
  try { applyDropIndicatorHook?.(target); } catch (_) {}
  return target;
}

export function shouldIgnoreListDragLeave({
  currentTarget = null,
  relatedTarget = null
} = {}) {
  return !!currentTarget && !!relatedTarget && currentTarget.contains(relatedTarget);
}

function readDocumentPlacementLevelId(doc) {
  try {
    const direct = doc?.getFlag?.('fa-nexus', 'placementLevelId');
    if (direct !== undefined) return String(direct || '').trim();
  } catch (_) {}
  return String(
    doc?.flags?.['fa-nexus']?.placementLevelId
    ?? doc?._source?.flags?.['fa-nexus']?.placementLevelId
    ?? ''
  ).trim();
}

function normalizeDocumentLevelIds(levels) {
  const values = [];
  const append = (value) => {
    const normalized = String(value || '').trim();
    if (normalized) values.push(normalized);
  };
  if (levels instanceof Set || Array.isArray(levels)) {
    for (const value of levels) append(value);
  } else if (levels && typeof levels.values === 'function') {
    for (const value of levels.values()) append(value);
  }
  return Array.from(new Set(values));
}

function readDocumentLevelIds(doc) {
  const direct = doc?.levels;
  const directIds = normalizeDocumentLevelIds(direct);
  if (directIds.length) return directIds;
  return normalizeDocumentLevelIds(doc?._source?.levels);
}

function getTargetLevelMembershipUpdate(doc, targetPlacementLevelId) {
  if (targetPlacementLevelId === undefined) return null;
  const targetLevelId = String(targetPlacementLevelId || '').trim();
  if (!targetLevelId) return null;
  const currentLevelIds = readDocumentLevelIds(doc);
  // A layer of every Level stays one. (Its empty membership was read as "no Level" here, and a move to another
  // Level left it on that Level only.)
  if (!currentLevelIds.length) return null;
  if (currentLevelIds.includes(targetLevelId)) return null;
  // A layer of its own Level only goes with it; a layer of several Levels gains the new one.
  if (currentLevelIds.length === 1 && currentLevelIds[0] === readDocumentPlacementLevelId(doc)) return [targetLevelId];
  return [...currentLevelIds, targetLevelId].sort((left, right) => left.localeCompare(right));
}

function resolveSyntheticTargetPlacementLevelId(elevationKey = '') {
  const normalizedKey = String(elevationKey || '').trim();
  if (!normalizedKey) return undefined;
  const match = /^(foreground|ground)(?:-band)?:([^:]+):.+$/.exec(normalizedKey);
  if (!match) return undefined;
  const placementLevelId = String(match[2] || '').trim();
  return placementLevelId && placementLevelId !== 'none' ? placementLevelId : '';
}

/** Whether the Tile owns, or is one of, the generated parts of a composition. */
function hasGeneratedCompanions(doc) {
  const flags = doc?.flags?.['fa-nexus'] || {};
  if (flags.building || flags.buildingFill || flags.buildingSills || flags.flattened?.composition) return true;
  const relationships = doc?.parent?.flags?.['fa-nexus']?.compositionRegistry?.relationships;
  return Array.isArray(relationships)
    && relationships.some((relationship) => relationship.ownerUuid === doc.uuid || relationship.dependentUuid === doc.uuid);
}

function resolveSparseReorderSort(docs, index, currentSort) {
  const above = docs[index - 1] || null;
  const below = docs[index + 1] || null;
  const aboveSort = above ? Number(above.sort) : null;
  const belowSort = below ? Number(below.sort) : null;
  if ((above && !Number.isFinite(aboveSort)) || (below && !Number.isFinite(belowSort))) return null;
  if (
    Number.isFinite(currentSort)
    && (!above || currentSort < aboveSort)
    && (!below || currentSort > belowSort)
  ) return currentSort;
  if (!above && !below) return Number.isFinite(currentSort) ? currentSort : 2;
  if (!above) return belowSort + 2;
  if (!below) return aboveSort - 2;
  if ((aboveSort - belowSort) <= 1) return null;
  const nextSort = Math.floor((aboveSort + belowSort) / 2);
  return nextSort < aboveSort && nextSort > belowSort ? nextSort : null;
}

export async function applyDropReorder({
  target = null,
  dragState = null,
  viewState = null,
  user = game?.user,
  updateEmbeddedDocuments = null,
  elevationGroupKey = null,
  resolveGroupElevation = null,
  resolveDisplayElevationKey = null,
  resolveDocumentById = null,
  updateSectionMemberships = null,
  hierarchicalOrder = false
} = {}) {
  const targetElevationKey = String(target?.elevationKey || '').trim();
  if (!targetElevationKey || typeof updateEmbeddedDocuments !== 'function' || typeof elevationGroupKey !== 'function') {
    return { applied: false, reason: 'invalid-target' };
  }
  const movingDocs = getOrderedDocsByIds({
    tileIds: dragState?.tileIds || [],
    viewState,
    resolveDocumentById
  }).filter((doc) => doc?.canUserModify?.(user, 'update'));
  if (!movingDocs.length) return { applied: false, reason: 'no-editable-documents' };
  // A Building, a Path with Walls and a flattened section are more than their
  // row: Walls, Regions and further Tiles of theirs stay on the Level they are
  // on. One row moved to another Level would leave the rest behind.
  const targetLevelId = resolveSyntheticTargetPlacementLevelId(targetElevationKey);
  if (targetLevelId && typeof resolveDisplayElevationKey === 'function') {
    const leavesItsLevel = (doc) => {
      const currentLevelId = resolveSyntheticTargetPlacementLevelId(resolveDisplayElevationKey(doc));
      return !!currentLevelId && currentLevelId !== targetLevelId;
    };
    const held = movingDocs.find((doc) => leavesItsLevel(doc) && hasGeneratedCompanions(doc));
    if (held) return { applied: false, reason: 'composite-level-change', document: held };
  }
  const movingIds = new Set(movingDocs.map((doc) => doc?.id).filter(Boolean));
  const reorderedGroups = new Map();
  const sectionRowsByGroup = new Map();
  for (const [key, docs] of viewState?.fullElevationGroups || []) {
    const allDocs = (Array.isArray(docs) ? docs : []).filter(doc => doc?.id);
    const byId = new Map(allDocs.map(doc => [doc.id, doc]));
    const rows = hierarchicalOrder ? materializeLayerManagerSectionOrder(allDocs, viewState.sectionMetadata, key) : allDocs;
    sectionRowsByGroup.set(key, rows);
    // Preserve the original block order before removing a folder's leading Tile.
    reorderedGroups.set(key, rows.filter(row => !row.separator && !movingIds.has(row.id)).map(row => byId.get(row.id)));
  }
  if (!reorderedGroups.has(targetElevationKey)) reorderedGroups.set(targetElevationKey, []);
  const targetGroup = reorderedGroups.get(targetElevationKey);
  if (!Array.isArray(targetGroup)) return { applied: false, reason: 'missing-target-group' };
  const getStationarySectionDocs = (sectionId) => (
    viewState?.fullSectionDocsById?.get?.(sectionId) || []
  ).filter((doc) => doc?.id && !movingIds.has(doc.id));

  let insertIndex = 0;
  const targetSectionId = String(target?.sectionId || '').trim() || null;
  if (target?.kind === 'row') {
    const targetId = String(target?.rowId || '').trim();
    const rowIndex = targetGroup.findIndex((doc) => String(doc?.id || '') === targetId);
    if (rowIndex < 0) return { applied: false, reason: 'missing-target-row' };
    insertIndex = rowIndex + (target.placeBefore ? 0 : 1);
  } else if (target?.kind === 'section' && targetSectionId) {
    const sectionDocs = getStationarySectionDocs(targetSectionId);
    const firstId = String(sectionDocs[0]?.id || '').trim();
    const sectionIndex = firstId ? targetGroup.findIndex((doc) => String(doc?.id || '') === firstId) : -1;
    insertIndex = sectionIndex >= 0 ? sectionIndex : 0;
  } else if (target?.kind === 'section-boundary') {
    const boundarySectionId = String(target?.boundarySectionId || '').trim();
    if (hierarchicalOrder) {
      const rows = sectionRowsByGroup.get(targetElevationKey) || [];
      const start = rows.findIndex(row => row.section && row.sectionId === boundarySectionId);
      if (start < 0) return { applied: false, reason: 'missing-target-section' };
      let boundary = start;
      if (!target.placeBefore) {
        boundary = start + 1;
        while (boundary < rows.length && rows[boundary].treeDepth > rows[start].treeDepth) boundary++;
      }
      insertIndex = rows.slice(0, boundary).filter(row => !row.separator && !movingIds.has(row.id)).length;
    } else {
      const sectionDocs = getStationarySectionDocs(boundarySectionId);
      const boundaryDoc = target.placeBefore ? sectionDocs[0] : sectionDocs.at(-1);
      const boundaryIndex = boundaryDoc
        ? targetGroup.findIndex((doc) => String(doc?.id || '') === String(boundaryDoc?.id || ''))
        : -1;
      insertIndex = boundaryIndex >= 0 ? boundaryIndex + (target.placeBefore ? 0 : 1) : targetGroup.length;
    }
  } else if (target?.kind === 'elevation-edge') {
    insertIndex = target.placeBefore ? 0 : targetGroup.length;
  }
  targetGroup.splice(insertIndex, 0, ...movingDocs);
  const targetPlacementLevelId = resolveSyntheticTargetPlacementLevelId(targetElevationKey);
  const applyTargetMembership = (doc, update) => {
    if (targetPlacementLevelId === undefined) return;
    const currentPlacementLevelId = readDocumentPlacementLevelId(doc);
    if (currentPlacementLevelId !== targetPlacementLevelId) {
      update['flags.fa-nexus.placementLevelId'] = targetPlacementLevelId;
    }
    const targetLevelMembership = getTargetLevelMembershipUpdate(doc, targetPlacementLevelId);
    if (targetLevelMembership) update.levels = targetLevelMembership;
  };

  const stationaryTarget = targetGroup.filter(doc => !movingIds.has(doc.id));
  const stationarySortsDescend = stationaryTarget.every((doc, index) => !index
    || Number(stationaryTarget[index - 1].sort) > Number(doc.sort));
  if (movingDocs.length === 1 && (!hierarchicalOrder || stationarySortsDescend)) {
    const doc = movingDocs[0];
    const targetIndex = targetGroup.findIndex((candidate) => candidate?.id === doc.id);
    const nextElevation = Number(resolveGroupElevation?.(targetElevationKey));
    const currentSort = Number(doc?.sort ?? 0) || 0;
    const nextSort = targetIndex >= 0 ? resolveSparseReorderSort(targetGroup, targetIndex, currentSort) : null;
    if (Number.isFinite(nextElevation) && Number.isFinite(nextSort)) {
      const currentElevationKey = resolveDisplayElevationKey?.(doc) || elevationGroupKey(doc?.elevation ?? 0);
      const update = { _id: doc.id, elevation: nextElevation, sort: nextSort };
      applyTargetMembership(doc, update);
      let updateCount = 0;
      if (
        currentElevationKey !== targetElevationKey
        || currentSort !== nextSort
        || Object.prototype.hasOwnProperty.call(update, 'flags.fa-nexus.placementLevelId')
        || Object.prototype.hasOwnProperty.call(update, 'levels')
      ) {
        await updateEmbeddedDocuments('Tile', [update]);
        updateCount = 1;
      }
      await updateSectionMemberships?.(movingDocs.map((movingDoc) => movingDoc.id), targetSectionId, targetElevationKey);
      return { applied: true, updateCount, movedIds: movingDocs.map((movingDoc) => movingDoc.id) };
    }
  }

  const affectedKeys = new Set([
    targetElevationKey,
    ...movingDocs.map((doc) => resolveDisplayElevationKey?.(doc) || elevationGroupKey(doc?.elevation ?? 0))
  ]);
  const updates = [];
  for (const key of affectedKeys) {
    const docs = reorderedGroups.get(key) || [];
    const nextElevation = Number(resolveGroupElevation?.(key));
    if (!Number.isFinite(nextElevation)) continue;
    const total = docs.length;
    for (let index = 0; index < docs.length; index += 1) {
      const doc = docs[index];
      const nextSort = (total - index) * 2;
      const currentElevationKey = resolveDisplayElevationKey?.(doc) || elevationGroupKey(doc?.elevation ?? 0);
      const currentSort = Number(doc?.sort ?? 0) || 0;
      const update = {
        _id: doc.id,
        elevation: nextElevation,
        sort: nextSort
      };
      if (key === targetElevationKey) applyTargetMembership(doc, update);
      if (
        currentElevationKey === key
        && currentSort === nextSort
        && !Object.prototype.hasOwnProperty.call(update, 'flags.fa-nexus.placementLevelId')
        && !Object.prototype.hasOwnProperty.call(update, 'levels')
      ) continue;
      updates.push(update);
    }
  }
  if (updates.length) await updateEmbeddedDocuments('Tile', updates);
  await updateSectionMemberships?.(movingDocs.map((doc) => doc.id), targetSectionId, targetElevationKey);
  return { applied: true, updateCount: updates.length, movedIds: movingDocs.map((doc) => doc.id) };
}
