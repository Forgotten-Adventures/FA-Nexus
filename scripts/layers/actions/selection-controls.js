import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { isBuildingEditProtectedTile } from '../../buildings/building-edit-delete-guard.js';

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
    ? docs.filter((doc) => doc?.canUserModify?.(user, 'delete') && !isBuildingEditProtectedTile(doc))
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
  try {
    invalidateSelectionListFilterCache?.(reason);
  } catch (error) {
    Logger.error('LayerManager.selectionFilter.listFilterStateChange.failed', {
      reason,
      phase: 'invalidate-cache',
      error: String(error?.message || error)
    });
    throw error;
  }
  if (!selectionFilterState?.active || !selectionFilterState?.skipFiltered) return false;
  try {
    scheduleSelectionFilterRefresh?.({
      reason,
      source: 'layer-manager-list-filters',
      resyncSettings: false
    });
  } catch (error) {
    Logger.error('LayerManager.selectionFilter.listFilterStateChange.failed', {
      reason,
      phase: 'schedule-refresh',
      error: String(error?.message || error)
    });
    throw error;
  }
  return true;
}

export function activateTilesLayer() {
  try {
    if (canvas?.tiles && canvas.activeLayer !== canvas.tiles) canvas.tiles.activate();
    if (!ui?.controls?.tool?.control) {
      if (typeof ui?.controls?.activate !== 'function') {
        throw new Error('Foundry UI controls are unavailable for Tile selection.');
      }
      ui.controls.activate({ tool: 'select' });
      if (!ui?.controls?.tool?.control) {
        throw new Error('Foundry Select tool did not activate for Tile selection.');
      }
    }
  } catch (error) {
    Logger.error('LayerManager.selectionFilter.activateTilesLayer.failed', {
      error: String(error?.message || error)
    });
    throw error;
  }
}

export async function applyRangeFilterChange({
  root = null,
  isInput = false,
  selectionFilterState = null,
  parseElevationInput = null,
  writeSetting = null,
  refreshTileInteractionState = null,
  pruneSelectionForFilter = null,
  rangeMinSetting = '',
  rangeMaxSetting = ''
} = {}) {
  if (!root || !selectionFilterState || typeof parseElevationInput !== 'function') return;
  const minInput = root.querySelector('input[data-range="min"]');
  const maxInput = root.querySelector('input[data-range="max"]');
  const minRaw = minInput?.value ?? '';
  const maxRaw = maxInput?.value ?? '';
  const minValue = minRaw.trim();
  const maxValue = maxRaw.trim();
  const nextMin = parseElevationInput(minValue);
  const nextMax = parseElevationInput(maxValue);
  const previousState = {
    min: selectionFilterState.min,
    max: selectionFilterState.max
  };

  if (isInput) {
    selectionFilterState.min = nextMin;
    selectionFilterState.max = nextMax;
    refreshTileInteractionState?.();
    return;
  }

  try {
    await writeSetting?.(rangeMinSetting, minValue);
    await writeSetting?.(rangeMaxSetting, maxValue);
    selectionFilterState.min = nextMin;
    selectionFilterState.max = nextMax;
  } catch (error) {
    selectionFilterState.min = previousState.min;
    selectionFilterState.max = previousState.max;
    throw error;
  }

  const effectFailures = [];
  try { refreshTileInteractionState?.(); } catch (error) { effectFailures.push(error); }
  try { pruneSelectionForFilter?.(); } catch (error) { effectFailures.push(error); }
  if (effectFailures.length === 1) throw effectFailures[0];
  if (effectFailures.length > 1) throw new AggregateError(effectFailures, 'Layer Manager range filter effects failed.');
}

function readCheckboxValue(root = null, action = '') {
  if (!root) return false;
  const input = root.querySelector(`input[data-action="${action}"]`);
  return !!input?.checked;
}

export async function applySelectionBooleanFilterChange({
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
  const previousValue = selectionFilterState[stateKey];
  try {
    await writeSetting?.(settingKey, value);
  } catch (error) {
    selectionFilterState[stateKey] = previousValue;
    throw error;
  }
  selectionFilterState[stateKey] = value;
  const effectFailures = [];
  try { refreshTileInteractionState?.(); } catch (error) { effectFailures.push(error); }
  try { pruneSelectionForFilter?.(); } catch (error) { effectFailures.push(error); }
  if (effectFailures.length === 1) throw effectFailures[0];
  if (effectFailures.length > 1) throw new AggregateError(effectFailures, 'Layer Manager boolean filter effects failed.');
  return value;
}

export async function applySkipFilteredChange({
  root = null,
  selectionFilterState = null,
  invalidateSelectionListFilterCache = null,
  writeSetting = null,
  scheduleSelectionFilterRefresh = null,
  settingKey = ''
} = {}) {
  if (!root || !selectionFilterState) return false;
  const value = readCheckboxValue(root, 'skip-filtered');
  const previousValue = selectionFilterState.skipFiltered;
  try {
    await writeSetting?.(settingKey, value);
  } catch (error) {
    selectionFilterState.skipFiltered = previousValue;
    throw error;
  }
  selectionFilterState.skipFiltered = value;
  try {
    invalidateSelectionListFilterCache?.('skip-filtered-toggle');
    scheduleSelectionFilterRefresh?.({
      reason: 'skip-filtered-toggle',
      source: 'layer-manager-selection-options',
      resyncSettings: false
    });
  } catch (error) {
    Logger.error('LayerManager.selectionFilter.skipFilteredChange.failed', {
      phase: 'refresh-selection-filter',
      error: String(error?.message || error)
    });
    throw error;
  }
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
  const effectFailures = [];
  if (next) {
    try { setAltKeyHeld?.(!!isAltModifierActive?.()); } catch (error) { effectFailures.push(error); }
  }
  try { refreshTileInteractionState?.(); } catch (error) { effectFailures.push(error); }
  try { pruneSelectionForFilter?.(); } catch (error) { effectFailures.push(error); }
  if (effectFailures.length === 1) throw effectFailures[0];
  if (effectFailures.length > 1) throw new AggregateError(effectFailures, 'Layer Manager activation effects failed.');
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
