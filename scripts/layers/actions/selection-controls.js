import { NexusLogger as Logger } from '../../core/nexus-logger.js';

export function getOpenTileConfigDocsById() {
  const docsById = new Map();
  const sceneTiles = Array.from(canvas?.scene?.tiles || []);
  for (const doc of sceneTiles) {
    const id = String(doc?.id || doc?._id || '').trim();
    if (!id) continue;
    const sheet = doc?.sheet || null;
    if (!sheet?.rendered) continue;
    const constructorName = String(sheet?.constructor?.name || '').trim();
    if (constructorName && !/TileConfig/i.test(constructorName)) continue;
    docsById.set(id, doc);
  }
  return docsById;
}

export function getSelectedTileDocs({
  root = null,
  viewState = null,
  visibleOnly = false,
  controlledTiles = null
} = {}) {
  const selected = Array.isArray(controlledTiles)
    ? controlledTiles
    : (Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : []);
  const docsById = new Map();
  for (const tile of selected) {
    const doc = tile?.document || null;
    const id = doc?.id || tile?.id;
    if (!doc || !id) continue;
    docsById.set(id, doc);
  }
  if (!docsById.size) return [];

  let allowedIds = null;
  if (visibleOnly) {
    const visibleIds = new Set();
    for (const item of root?.querySelectorAll?.('[data-tile-id]') || []) {
      const id = item?.dataset?.tileId;
      if (id) visibleIds.add(id);
    }
    allowedIds = visibleIds;
  }

  const orderedIds = Array.isArray(viewState?.fullTileIdsInOrder) ? viewState.fullTileIdsInOrder : [...docsById.keys()];
  const docs = [];
  for (const id of orderedIds) {
    if (allowedIds && !allowedIds.has(id)) continue;
    const doc = docsById.get(id);
    if (doc) docs.push(doc);
  }
  return docs;
}

export async function deleteSelectedDocs({
  docs = [],
  user = game?.user,
  deleteEmbeddedDocuments = null,
  onSelectionActionsUpdated = null
} = {}) {
  const targets = Array.isArray(docs)
    ? docs.filter((doc) => doc?.canUserModify?.(user, 'delete'))
    : [];
  const ids = targets.map((doc) => doc?.id).filter(Boolean);
  if (!ids.length || typeof deleteEmbeddedDocuments !== 'function') return false;
  try {
    await deleteEmbeddedDocuments('Tile', ids);
    return true;
  } catch (error) {
    Logger.warn('LayerManager.deleteSelection.failed', { error: String(error?.message || error) });
    ui?.notifications?.error?.(`Failed to delete selected layers: ${error?.message || error}`);
    return false;
  } finally {
    try { onSelectionActionsUpdated?.(); } catch (_) {}
  }
}

export function handleSelectionListFilterStateChange({
  reason,
  selectionFilterState = null,
  invalidateSelectionListFilterCache = null,
  scheduleSelectionFilterRefresh = null
} = {}) {
  try { invalidateSelectionListFilterCache?.(reason); } catch (_) {}
  if (!selectionFilterState?.active || !selectionFilterState?.skipFiltered) return false;
  try {
    scheduleSelectionFilterRefresh?.({
      reason,
      source: 'layer-manager-list-filters',
      resyncSettings: false
    });
  } catch (_) {}
  return true;
}

export function activateTilesLayer() {
  try {
    if (canvas?.tiles && canvas.activeLayer !== canvas.tiles) canvas.tiles.activate();
  } catch (_) {}
}

export function applyRangeFilterChange({
  root = null,
  isInput = false,
  selectionFilterState = null,
  parseElevationInput = null,
  writeSetting = null,
  refreshTileInteractionState = null,
  pruneSelectionForFilter = null,
  rangeMinSetting = '',
  rangeMaxSetting = '',
  ignoreForegroundSetting = ''
} = {}) {
  if (!root || !selectionFilterState || typeof parseElevationInput !== 'function') return;
  const minInput = root.querySelector('input[data-range="min"]');
  const maxInput = root.querySelector('input[data-range="max"]');
  const minRaw = minInput?.value ?? '';
  const maxRaw = maxInput?.value ?? '';
  const minValue = minRaw.trim();
  const maxValue = maxRaw.trim();
  selectionFilterState.min = parseElevationInput(minValue);
  selectionFilterState.max = parseElevationInput(maxValue);

  if ((minValue || maxValue) && !selectionFilterState.ignoreForeground) {
    selectionFilterState.ignoreForeground = true;
    if (!isInput) {
      try { writeSetting?.(ignoreForegroundSetting, true); } catch (_) {}
    }
    try { refreshTileInteractionState?.(); } catch (_) {}
  }

  if (isInput) return;
  try { writeSetting?.(rangeMinSetting, minValue); } catch (_) {}
  try { writeSetting?.(rangeMaxSetting, maxValue); } catch (_) {}
  try { refreshTileInteractionState?.(); } catch (_) {}
  try { pruneSelectionForFilter?.(); } catch (_) {}
}

function readCheckboxValue(root = null, action = '') {
  if (!root) return false;
  const input = root.querySelector(`input[data-action="${action}"]`);
  return !!input?.checked;
}

export function applySelectionBooleanFilterChange({
  root = null,
  action = '',
  selectionFilterState = null,
  stateKey = '',
  settingKey = '',
  writeSetting = null,
  refreshTileInteractionState = null,
  pruneSelectionForFilter = null
} = {}) {
  if (!root || !selectionFilterState || !stateKey) return false;
  const value = readCheckboxValue(root, action);
  selectionFilterState[stateKey] = value;
  try { writeSetting?.(settingKey, value); } catch (_) {}
  try { refreshTileInteractionState?.(); } catch (_) {}
  try { pruneSelectionForFilter?.(); } catch (_) {}
  return value;
}

export function applySkipFilteredChange({
  root = null,
  selectionFilterState = null,
  invalidateSelectionListFilterCache = null,
  writeSetting = null,
  scheduleSelectionFilterRefresh = null,
  settingKey = ''
} = {}) {
  if (!root || !selectionFilterState) return false;
  const value = readCheckboxValue(root, 'skip-filtered');
  selectionFilterState.skipFiltered = value;
  try { invalidateSelectionListFilterCache?.('skip-filtered-toggle'); } catch (_) {}
  try { writeSetting?.(settingKey, value); } catch (_) {}
  try {
    scheduleSelectionFilterRefresh?.({
      reason: 'skip-filtered-toggle',
      source: 'layer-manager-selection-options',
      resyncSettings: false
    });
  } catch (_) {}
  return value;
}

export function setSelectionFilterActive({
  active,
  selectionFilterState = null,
  setAltKeyHeld = null,
  isAltModifierActive = null,
  refreshTileInteractionState = null,
  pruneSelectionForFilter = null
} = {}) {
  if (!selectionFilterState) return false;
  const next = !!active;
  if (selectionFilterState.active === next) return false;
  selectionFilterState.active = next;
  if (next) {
    try { setAltKeyHeld?.(!!isAltModifierActive?.()); } catch (_) {}
  }
  try { refreshTileInteractionState?.(); } catch (_) {}
  try { pruneSelectionForFilter?.(); } catch (_) {}
  return true;
}

export function setLayerManagerActiveClass({
  element = null,
  active = false,
  isPopout = false,
  tabId = 'layer-manager'
} = {}) {
  if (!element) return;
  element.classList.toggle('active', isPopout ? true : !!active);
  if (!element.dataset.tab) element.dataset.tab = tabId;
  if (!element.dataset.group) element.dataset.group = 'primary';
}
