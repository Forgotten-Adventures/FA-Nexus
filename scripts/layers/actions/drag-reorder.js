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
  previewIds = []
} = {}) {
  if (!root) return;
  const wanted = new Set((Array.isArray(tileIds) ? tileIds : []).filter(Boolean));
  const previewWanted = new Set((Array.isArray(previewIds) ? previewIds : []).filter(Boolean));
  for (const item of root.querySelectorAll('[data-tile-id]')) {
    const id = item?.dataset?.tileId;
    item.classList.toggle('is-dragging', !!id && wanted.has(id));
  }
  for (const item of root.querySelectorAll('[data-preview-id]')) {
    const id = item?.dataset?.previewId;
    item.classList.toggle('is-dragging', !!id && previewWanted.has(id));
  }
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
    placeBefore: target.placeBefore !== false
  });
  if (currentDropIndicator === nextKey) return currentDropIndicator;
  clearDropIndicator({ root });
  if (target.kind === 'header') {
    target.element.classList.add('is-drop-header');
  } else if (target.placeBefore) {
    target.element.classList.add('is-drop-before');
  } else {
    target.element.classList.add('is-drop-after');
  }
  return nextKey;
}

function buildDropTargetFromElement(element = null, { placeBefore = true } = {}) {
  if (!element?.dataset) return null;
  const previewId = String(element.dataset.previewId || '').trim();
  if (previewId) {
    return {
      kind: 'preview',
      previewId,
      elevationKey: String(element.dataset.elevationKey || '').trim(),
      placeBefore,
      element
    };
  }
  const rowId = String(element.dataset.tileId || '').trim();
  if (!rowId) return null;
  return {
    kind: 'row',
    rowId,
    elevationKey: String(element.dataset.elevationKey || '').trim(),
    placeBefore,
    element
  };
}

function isDropCandidateElement(element = null, dragState = null, elevationKey = '') {
  if (!element?.dataset) return false;
  if (String(element.dataset.elevationKey || '').trim() !== String(elevationKey || '').trim()) return false;
  const draggedTileIds = new Set(Array.isArray(dragState?.tileIds) ? dragState.tileIds : []);
  const draggedPreviewId = String(dragState?.previewId || '').trim();
  const tileId = String(element.dataset.tileId || '').trim();
  if (tileId) return !draggedTileIds.has(tileId);
  const previewId = String(element.dataset.previewId || '').trim();
  if (!previewId || !draggedPreviewId) return false;
  return previewId !== draggedPreviewId;
}

function resolveCanonicalDropTarget(target = null, dragState = null) {
  if (!target?.element || target.kind === 'header' || target.placeBefore !== false) return target;
  const elevationKey = String(target.elevationKey || '').trim();
  if (!elevationKey) return target;
  let sibling = target.element.nextElementSibling;
  while (sibling) {
    if (isDropCandidateElement(sibling, dragState, elevationKey)) {
      return buildDropTargetFromElement(sibling, { placeBefore: true }) || target;
    }
    sibling = sibling.nextElementSibling;
  }
  return target;
}

export function resolveDropTarget({
  event = null,
  dragState = null
} = {}) {
  if (!dragState?.tileIds?.length && !String(dragState?.previewId || '').trim()) return null;
  const header = event?.target?.closest?.('.fa-nexus-layer-manager__separator[data-elevation-key]:not(.fa-nexus-layer-manager__separator--level-boundary)');
  if (header) {
    if (String(header?.dataset?.groupCanHeaderDrop || '').trim() === 'false') return null;
    const elevationKey = String(header?.dataset?.elevationKey || '').trim();
    if (!elevationKey) return null;
    return {
      kind: 'header',
      elevationKey,
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
      return resolveCanonicalDropTarget({
        kind: 'preview',
        previewId,
        elevationKey: String(previewRow?.dataset?.elevationKey || '').trim(),
        placeBefore: Number(event?.clientY ?? 0) <= midpoint,
        element: previewRow
      }, dragState);
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
  return resolveCanonicalDropTarget({
    kind: 'row',
    rowId,
    elevationKey: String(row?.dataset?.elevationKey || '').trim(),
    placeBefore: Number(event?.clientY ?? 0) <= midpoint,
    element: row
  }, dragState);
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
  if (currentLevelIds.includes(targetLevelId)) return null;
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

export async function applyDropReorder({
  target = null,
  dragState = null,
  viewState = null,
  user = game?.user,
  updateEmbeddedDocuments = null,
  elevationGroupKey = null,
  resolveGroupElevation = null,
  resolveDisplayElevationKey = null,
  resolveDocumentById = null
} = {}) {
  const targetElevationKey = String(target?.elevationKey || '').trim();
  if (!targetElevationKey || typeof updateEmbeddedDocuments !== 'function' || typeof elevationGroupKey !== 'function') return;
  const movingDocs = getOrderedDocsByIds({
    tileIds: dragState?.tileIds || [],
    viewState,
    resolveDocumentById
  }).filter((doc) => doc?.canUserModify?.(user, 'update'));
  if (!movingDocs.length) return;
  const movingIds = new Set(movingDocs.map((doc) => doc?.id).filter(Boolean));
  const reorderedGroups = new Map();
  for (const [key, docs] of viewState?.fullElevationGroups || []) {
    reorderedGroups.set(key, (Array.isArray(docs) ? docs : []).filter((doc) => doc?.id && !movingIds.has(doc.id)));
  }
  if (!reorderedGroups.has(targetElevationKey)) reorderedGroups.set(targetElevationKey, []);
  const targetGroup = reorderedGroups.get(targetElevationKey);
  if (!Array.isArray(targetGroup)) return;

  let insertIndex = 0;
  if (target?.kind === 'row') {
    const targetId = String(target?.rowId || '').trim();
    const rowIndex = targetGroup.findIndex((doc) => String(doc?.id || '') === targetId);
    if (rowIndex < 0) return;
    insertIndex = rowIndex + (target.placeBefore ? 0 : 1);
  }
  targetGroup.splice(insertIndex, 0, ...movingDocs);
  const targetPlacementLevelId = resolveSyntheticTargetPlacementLevelId(targetElevationKey);

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
      if (key === targetElevationKey && targetPlacementLevelId !== undefined) {
        const currentPlacementLevelId = readDocumentPlacementLevelId(doc);
        if (currentPlacementLevelId !== targetPlacementLevelId) {
          update['flags.fa-nexus.placementLevelId'] = targetPlacementLevelId;
        }
        const targetLevelMembership = getTargetLevelMembershipUpdate(doc, targetPlacementLevelId);
        if (targetLevelMembership) update.levels = targetLevelMembership;
      }
      if (
        currentElevationKey === key
        && currentSort === nextSort
        && !Object.prototype.hasOwnProperty.call(update, 'flags.fa-nexus.placementLevelId')
        && !Object.prototype.hasOwnProperty.call(update, 'levels')
      ) continue;
      updates.push(update);
    }
  }
  if (!updates.length) return;
  await updateEmbeddedDocuments('Tile', updates);
}
