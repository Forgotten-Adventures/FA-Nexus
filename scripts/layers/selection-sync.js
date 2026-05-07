import { getOpenTileConfigDocsById } from './actions/selection-controls.js';

function getListElement(root = null) {
  return root?.querySelector?.('.fa-nexus-layer-manager__list') || null;
}

function scrollToListItem(root = null, selector = '') {
  if (!root || !selector) return false;
  const list = getListElement(root);
  if (!list) return false;
  const item = list.querySelector(selector);
  if (!item) return false;
  const listRect = list.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
    try { item.scrollIntoView({ block: 'nearest' }); } catch (_) {}
  }
  return true;
}

function queueScroll({
  targetId = '',
  active = false,
  isPopout = false,
  queued = false,
  setState = null,
  getTargetId = null,
  clearTargetId = null,
  requestFrame = requestAnimationFrame,
  onScroll = null
} = {}) {
  const id = String(targetId || '').trim();
  if (!id || (!active && !isPopout)) return false;
  setState?.({ targetId: id });
  if (queued) return true;
  setState?.({ queued: true });
  requestFrame(() => {
    setState?.({ queued: false });
    const nextTargetId = getTargetId?.() || null;
    clearTargetId?.();
    onScroll?.(nextTargetId);
  });
  return true;
}

export function queueScrollToTile({
  tileId = '',
  active = false,
  isPopout = false,
  scrollQueued = false,
  setScrollState = null,
  getScrollTargetId = null,
  clearScrollTargetId = null,
  requestFrame = requestAnimationFrame,
  scrollToTile = null
} = {}) {
  return queueScroll({
    targetId: tileId,
    active,
    isPopout,
    queued: scrollQueued,
    setState: (patch) => {
      const nextPatch = {};
      if (Object.prototype.hasOwnProperty.call(patch || {}, 'targetId')) nextPatch.scrollTargetId = patch.targetId;
      if (Object.prototype.hasOwnProperty.call(patch || {}, 'queued')) nextPatch.scrollQueued = patch.queued;
      setScrollState?.(nextPatch);
    },
    getTargetId: getScrollTargetId,
    clearTargetId: clearScrollTargetId,
    requestFrame,
    onScroll: scrollToTile
  });
}

export function queueScrollToPreview({
  previewId = '',
  active = false,
  isPopout = false,
  scrollPreviewQueued = false,
  setPreviewScrollState = null,
  getPreviewTargetId = null,
  clearPreviewTargetId = null,
  requestFrame = requestAnimationFrame,
  scrollToPreview = null
} = {}) {
  return queueScroll({
    targetId: previewId,
    active,
    isPopout,
    queued: scrollPreviewQueued,
    setState: (patch) => {
      const nextPatch = {};
      if (Object.prototype.hasOwnProperty.call(patch || {}, 'targetId')) nextPatch.scrollPreviewTargetId = patch.targetId;
      if (Object.prototype.hasOwnProperty.call(patch || {}, 'queued')) nextPatch.scrollPreviewQueued = patch.queued;
      setPreviewScrollState?.(nextPatch);
    },
    getTargetId: getPreviewTargetId,
    clearTargetId: clearPreviewTargetId,
    requestFrame,
    onScroll: scrollToPreview
  });
}

export function scrollToTile({
  root = null,
  tileId = ''
} = {}) {
  const id = String(tileId || '').trim();
  if (!id) return false;
  return scrollToListItem(root, `[data-tile-id="${CSS.escape(id)}"]`);
}

export function scrollToPreview({
  root = null,
  previewId = ''
} = {}) {
  const id = String(previewId || '').trim();
  if (!id) return false;
  return scrollToListItem(root, `[data-preview-id="${CSS.escape(id)}"]`);
}

export function syncPreviewScroll({
  root = null,
  lastActivePreviewId = null,
  setLastActivePreviewId = null,
  queueScrollToPreview = null
} = {}) {
  const list = getListElement(root);
  if (!list) return false;
  const previousId = String(lastActivePreviewId || '').trim();
  const previousActivePreview = previousId
    ? list.querySelector(`.fa-nexus-layer-manager__item.is-preview.is-selected[data-preview-id="${CSS.escape(previousId)}"]`)
    : null;
  const hasKnownActivePreview = !!previousId && !!previousActivePreview;
  const activePreview = previousActivePreview
    || list.querySelector('.fa-nexus-layer-manager__item.is-preview.is-selected');
  if (!activePreview) {
    setLastActivePreviewId?.(null);
    return false;
  }
  const previewId = activePreview.dataset?.previewId || null;
  if (!previewId) return false;
  if (previewId !== previousId) {
    setLastActivePreviewId?.(previewId);
    if (!hasKnownActivePreview) return false;
    queueScrollToPreview?.(previewId);
    return true;
  }
  if (!hasKnownActivePreview) return false;
  const listRect = list.getBoundingClientRect();
  const itemRect = activePreview.getBoundingClientRect();
  if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
    queueScrollToPreview?.(previewId);
    return true;
  }
  return false;
}

export function syncSelectionFromCanvas({
  root = null,
  tile = null,
  controlled = null,
  getSelectedTileDocs = null,
  expandElevationGroupsForDocs = null,
  queueScrollToTile = null,
  scheduleRender = null,
  updateSelectionActions = null,
  updateFlattenFooter = null,
  controlledTiles = canvas?.tiles?.controlled,
  allowAutoExpand = true,
  allowScrollToTile = true
} = {}) {
  const list = getListElement(root);
  if (!list) return false;
  const openTileConfigDocIds = new Set(Array.from(getOpenTileConfigDocsById().keys()));
  const selectedDocs = tile
    ? (() => {
      const tileId = String(tile?.document?.id || tile?.id || '').trim();
      const isSelected = controlled === null
        ? (!!tile?.controlled || openTileConfigDocIds.has(tileId))
        : (!!controlled || openTileConfigDocIds.has(tileId));
      return isSelected && tile?.document ? [tile.document] : [];
    })()
    : (getSelectedTileDocs?.() || []);

  const expandedGroups = !!allowAutoExpand && !!expandElevationGroupsForDocs?.(selectedDocs);
  if (expandedGroups) {
    const scrollTargetId = tile?.document?.id || selectedDocs[0]?.id || null;
    if (allowScrollToTile && scrollTargetId) queueScrollToTile?.(scrollTargetId);
    scheduleRender?.();
    updateSelectionActions?.();
    updateFlattenFooter?.();
    return true;
  }

  if (tile) {
    const id = tile?.document?.id || tile?.id || null;
    if (!id) return false;
    const item = list.querySelector(`[data-tile-id="${CSS.escape(id)}"]`);
    if (item) {
      const isSelected = controlled === null
        ? (!!tile.controlled || openTileConfigDocIds.has(id))
        : (!!controlled || openTileConfigDocIds.has(id));
      item.classList.toggle('is-selected', isSelected);
      item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      if (allowScrollToTile && isSelected) queueScrollToTile?.(id);
    }
    updateSelectionActions?.();
    updateFlattenFooter?.();
    return true;
  }

  const selectedIds = new Set((Array.isArray(controlledTiles) ? controlledTiles : [])
    .map((entry) => entry?.document?.id || entry?.id)
    .filter(Boolean));
  for (const id of openTileConfigDocIds) {
    selectedIds.add(id);
  }
  const singleSelectedId = selectedIds.size === 1
    ? Array.from(selectedIds)[0] || null
    : null;
  for (const item of list.querySelectorAll('[data-tile-id]')) {
    const id = item.dataset.tileId;
    const isSelected = selectedIds.has(id);
    item.classList.toggle('is-selected', isSelected);
    item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  }
  // Keep external single-row selection changes visible even when no group had to expand first.
  if (allowScrollToTile && singleSelectedId) queueScrollToTile?.(singleSelectedId);
  updateSelectionActions?.();
  updateFlattenFooter?.();
  return true;
}
