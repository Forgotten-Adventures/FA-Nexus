import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { TileFlattenManager } from '../flatten/flatten-manager.js';
import {
  canLaunchFaNexusTileMask,
  getFaNexusTileEditMode,
  openFaNexusTileMaskEditor
} from '../canvas/tile-hud-edit.js';
import { createCanvasGestureSession } from '../canvas/canvas-gesture-session.js';
import {
  computeNextSortAtElevation,
  normalizeTileDocumentSortForPlacement,
  resolvePlacementSortAtElevation
} from '../canvas/canvas-interaction-controller.js';
import {
  getCurrentLevelElevationRange,
  getCurrentSceneLevel,
  getSceneLevelElevationRanges,
  isElevationWithinCurrentLevelEditScope
} from '../canvas/elevation-band-utils.js';
import {
  analyzeTileBandState,
  getDefaultTilePlacementLevelId,
  resolveTileRenderOrder
} from '../canvas/tile-band-utils.js';
import { onCanvasReady } from '../canvas/canvas-readiness.js';
import {
  collectTileDocuments,
  collectTilePlaceables,
  mapTilePlaceablesById,
  resolveTileDocument,
  resolveTilePlaceable
} from '../canvas/tile-targets.js';
import {
  clearNexusTileSelectionContext,
  preserveTileSelectionDocumentsForNexus
} from '../canvas/tile-selection-context.js';
import { getFaNexusTileCapabilities } from '../canvas/tile-capabilities.js';
import { readDocumentHsbc } from '../core/hsbc.js';
import { clearStandardTileMask } from '../textures/texture-render.js';
import {
  applySceneElevationGroupMetadataLocally,
  cloneElevationGroupMetadata,
  elevationGroupKey,
  getElevationGroupName,
  getSceneElevationGroupMetadata,
  mergeElevationGroupMetadataOnBulkMove,
  mergeElevationGroupMetadataOnMove,
  normalizeElevationGroupMetadata,
  parseElevationInput,
  quantizeElevation,
  serializeElevationGroupMetadata,
  setSceneElevationGroupMetadata
} from './model/elevation-group-metadata.js';
import {
  expandElevationGroupsForDocs as expandLayerManagerElevationGroupsForDocs,
  getFullElevationDocs as getLayerManagerFullElevationDocs,
  getFullGroupNode as getLayerManagerFullGroupNode,
  getMatchingElevationDocs as getLayerManagerMatchingElevationDocs,
  getMatchingElevationGroupKeys as getLayerManagerMatchingElevationGroupKeys,
  getMatchingGroupNode as getLayerManagerMatchingGroupNode,
  setMatchingElevationGroupsCollapsed as setLayerManagerMatchingElevationGroupsCollapsed,
  toggleElevationGroupCollapsed as toggleLayerManagerElevationGroupCollapsed,
  usesNestedGrouping as usesNestedLayerManagerGrouping
} from './model/group-state.js';
import {
  LIST_FILTER_FLAG_KEYS,
  buildFilterChipContext,
  entryMatchesListFilters,
  listFiltersActive,
  parseListSearchQuery
} from './model/list-filters.js';
import {
  DEFAULT_PRIMARY_SORT_LAYERS,
  applyGroupSearchTextToEntries as applyLayerManagerGroupSearchTextModel,
  buildLayerManagerTileEntry as buildLayerManagerTileEntryModel,
  getPrimaryCanvasSortLayers,
  normalizeRenderOrderValue,
  sortLayerManagerRenderEntries,
  sortLayerManagerTileDocs
} from './model/render-entries.js';
import {
  COLLAPSED_STATE_SETTING,
  getDocumentLevelIds,
  getCurrentSceneSessionKey,
  getLayerManagerSessionState,
  isDocumentInActiveLevelListScope,
  reconcileLayerManagerCollapsedState,
  queuePersistLayerManagerCollapsedState,
  syncLayerManagerCollapsedStateFromSettings
} from './model/session-state.js';
import {
  applyLayerManagerFlattenFooterState,
  applyLayerManagerSelectionActionState,
  buildLayerManagerFlattenState,
  buildLayerManagerSelectionActionState
} from './view/action-controls.js';
import {
  buildFlattenContextMenuItem as buildLayerManagerFlattenContextMenuItem,
  deconstructContextMenuDoc,
  flattenContextMenuDocs,
  getContextMenuTileDocs as getLayerManagerContextMenuTileDocs,
  getGroupContextMenuDocs as getLayerManagerGroupContextMenuDocs,
  openContextMenuNexusTileEditor
} from './actions/context-actions.js';
import {
  activateTilesLayer as activateLayerManagerTilesLayer,
  applyRangeFilterChange,
  applySelectionBooleanFilterChange,
  applySkipFilteredChange,
  deleteSelectedDocs,
  getSelectedTileDocs as getLayerManagerSelectedTileDocs,
  handleSelectionListFilterStateChange as handleLayerManagerSelectionListFilterStateChange,
  setLayerManagerActiveClass,
  setSelectionFilterActive
} from './actions/selection-controls.js';
import {
  applyDropIndicator as applyLayerManagerDropIndicator,
  applyDropReorder as applyLayerManagerDropReorder,
  clearDraggedRowState as clearLayerManagerDraggedRowState,
  clearDropIndicator as clearLayerManagerDropIndicator,
  getOrderedDocsByIds as getLayerManagerOrderedDocsByIds,
  handleListDragOver as handleLayerManagerListDragOver,
  prepareListDragStart as prepareLayerManagerListDragStart,
  resolveDraggedTileIds as resolveLayerManagerDraggedTileIds,
  resolveDropTarget as resolveLayerManagerDropTarget,
  setDraggedRowState as setLayerManagerDraggedRowState,
  shouldIgnoreListDragLeave
} from './actions/drag-reorder.js';
import {
  adjustElevationSelection as adjustLayerManagerElevationSelection,
  applyDocsElevationChange as applyLayerManagerDocsElevationChange,
  commitElevationGroupElevationEdit as commitLayerManagerElevationGroupElevationEdit,
  getElevationAnnouncePoint as getLayerManagerElevationAnnouncePoint,
  getElevationShortcutDirection as getLayerManagerElevationShortcutDirection,
  promptDocsElevationChange as promptLayerManagerDocsElevationChange,
  resolveElevationStep as resolveLayerManagerElevationStep,
  resolveTileElevationMove as resolveLayerManagerTileElevationMove,
  restoreSelectionAfterElevationMove as restoreLayerManagerSelectionAfterElevationMove
} from './actions/elevation-controls.js';
import {
  adjustSceneMarkerElevationBlocked,
  clearSceneMarkerSelection as clearLayerManagerSceneMarkerSelection,
  openSceneSettings as openLayerManagerSceneSettings,
  openTileSettings as openLayerManagerTileSettings,
  resolveDoubleContextClick as resolveLayerManagerDoubleContextClick,
  selectSceneMarker as selectLayerManagerSceneMarker
} from './actions/row-actions.js';
import {
  beginElevationGroupElevationEdit as beginLayerManagerElevationGroupElevationEdit,
  beginElevationGroupNameEdit as beginLayerManagerElevationGroupNameEdit,
  beginRename as beginLayerManagerRename,
  cancelElevationGroupElevationEdit as cancelLayerManagerElevationGroupElevationEdit,
  cancelElevationGroupNameEdit as cancelLayerManagerElevationGroupNameEdit,
  cancelRename as cancelLayerManagerRename,
  commitElevationGroupNameEdit as commitLayerManagerElevationGroupNameEdit,
  commitRename as commitLayerManagerRename,
  handleElevationGroupElevationInputKeyDown as handleLayerManagerElevationGroupElevationInputKeyDown,
  handleElevationGroupNameInputKeyDown as handleLayerManagerElevationGroupNameInputKeyDown,
  handleRenameInputKeyDown as handleLayerManagerRenameInputKeyDown,
  isEditableLayerManagerElement,
  resolveRenameTargetId as resolveLayerManagerRenameTargetId,
  shouldHandleRenameHotkey as shouldHandleLayerManagerRenameHotkey
} from './actions/edit-actions.js';
import {
  queueScrollToPreview as queueLayerManagerScrollToPreview,
  queueScrollToTile as queueLayerManagerScrollToTile,
  scrollToPreview as scrollLayerManagerToPreview,
  scrollToTile as scrollLayerManagerToTile,
  syncPreviewScroll as syncLayerManagerPreviewScroll,
  syncSelectionFromCanvas as syncLayerManagerSelectionFromCanvas
} from './selection-sync.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { AbstractSidebarTab, Sidebar } = foundry.applications.sidebar;

const MODULE_ID = 'fa-nexus';
const TAB_ID = 'layer-manager';
const RANGE_MIN_SETTING = 'layerManagerElevationMin';
const RANGE_MAX_SETTING = 'layerManagerElevationMax';
const SKIP_LOCKED_SETTING = 'layerManagerSkipLocked';
const SKIP_HIDDEN_SETTING = 'layerManagerSkipHidden';
const SKIP_FILTERED_SETTING = 'layerManagerSkipFiltered';
const IGNORE_FOREGROUND_SETTING = 'layerManagerIgnoreForeground';
const NESTED_GROUPING_SETTING = 'layerManagerNestedGrouping';
const LAYER_HIDDEN_FLAG = 'layerHidden';
const LEVEL_BACKGROUND_IMAGE_HIDDEN_FLAG = 'layerManagerBackgroundImageHidden';
const LEVEL_FOREGROUND_IMAGE_HIDDEN_FLAG = 'layerManagerForegroundImageHidden';
const CONTEXT_DOUBLE_CLICK_MS = 350;
const MAX_ELEVATION_DECIMALS = 4;
const ELEVATION_SCALE = 10 ** MAX_ELEVATION_DECIMALS;
const ELEVATION_STEP_DEFAULT = 0.01;
const ELEVATION_STEP_FINE = 0.001;
const ELEVATION_STEP_COARSE = 0.1;
const TILE_SORT_STEP = 2;
const LEVEL_BOUNDARY_TOP_BLOCK_RANK = 0;
const LEVEL_BOUNDARY_BOTTOM_BLOCK_RANK = 9;
const EDITING_TILE_SET_KEYS = [
  '__faNexusTextureEditingTileIds',
  '__faNexusBuildingEditingTileIds',
  '__faNexusPathEditingTiles'
];

const selectionFilterState = {
  active: false,
  min: null,
  max: null,
  skipLocked: false,
  skipHidden: false,
  skipFiltered: false,
  listFilterSignature: '',
  listFilterActive: false,
  matchingListTileIds: new Set(),
  ignoreForeground: false
};
const SELECTION_FILTER_BLOCK_KEY = '_faNexusSelectionFilterBlocked';
const TILE_EVENT_MODE_BASE_KEY = '_faNexusForcedEventModeBase';
const TILE_EVENT_MODE_EDIT_BLOCK_KEY = '_faNexusEditEventModeBlocked';
const TILE_EVENT_MODE_SELECTION_BLOCK_KEY = '_faNexusSelectionEventModeBlocked';
const TILE_EVENT_MODE_HIDDEN_BLOCK_KEY = '_faNexusHiddenEventModeBlocked';
const layerHiddenState = {
  hooksBound: false
};
const selectionFilterHookState = {
  hooksBound: false
};

const hoverEventStub = { buttons: 0 };
const clickEventStub = { shiftKey: false, stopPropagation: () => {} };

let _tileFlattenManager = null;
let _altKeyHeld = false;

function getTileFlattenManager() {
  if (!_tileFlattenManager) _tileFlattenManager = new TileFlattenManager();
  return _tileFlattenManager;
}

function hasForcedTileEventModeBlock(tile) {
  return !!(
    tile?.[TILE_EVENT_MODE_EDIT_BLOCK_KEY]
    || tile?.[TILE_EVENT_MODE_SELECTION_BLOCK_KEY]
    || tile?.[TILE_EVENT_MODE_HIDDEN_BLOCK_KEY]
  );
}

function markTileEventModeBlocked(tile, reasonKey) {
  if (!tile || typeof tile.eventMode === 'undefined' || !reasonKey) return;
  if (!hasForcedTileEventModeBlock(tile) && !Object.prototype.hasOwnProperty.call(tile, TILE_EVENT_MODE_BASE_KEY)) {
    try { tile[TILE_EVENT_MODE_BASE_KEY] = tile.eventMode; } catch (_) {}
  }
  try { tile[reasonKey] = true; } catch (_) {}
  if (tile.eventMode !== 'none') {
    try { tile.eventMode = 'none'; } catch (_) {}
  }
}

function clearTileEventModeBlocked(tile, reasonKey) {
  if (!tile || typeof tile.eventMode === 'undefined') return;
  if (reasonKey) {
    try { delete tile[reasonKey]; } catch (_) { tile[reasonKey] = false; }
  }
  if (hasForcedTileEventModeBlock(tile)) {
    if (tile.eventMode !== 'none') {
      try { tile.eventMode = 'none'; } catch (_) {}
    }
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(tile, TILE_EVENT_MODE_BASE_KEY)) return;
  const baseEventMode = tile[TILE_EVENT_MODE_BASE_KEY];
  try { delete tile[TILE_EVENT_MODE_BASE_KEY]; } catch (_) {}
  try { tile.eventMode = baseEventMode; } catch (_) {}
}

function formatElevation(value) {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10000) / 10000;
  const fixed = rounded.toFixed(4).replace(/\.?0+$/, '');
  return fixed || '0';
}

function waitForUiFrame(ms = 0) {
  if (foundry?.utils?.sleep) return foundry.utils.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function hasTileHsbc(doc) {
  return !!readDocumentHsbc(doc, { nullIfMissing: true, nullIfNeutral: true });
}

function hasTileMask(doc) {
  return !!getFaNexusTileCapabilities(doc)?.hasStandardTileMask;
}

function hasTileShadowOnly(doc) {
  return !!(readFaFlag(doc, 'shadow') && readFaFlag(doc, 'shadowOnly'));
}

function isNestedLayerManagerGroupingEnabled() {
  return readSetting(NESTED_GROUPING_SETTING) === true;
}

function applyGroupSearchTextToEntries(entries = [], {
  elevationGroupMetadata = {},
  nestedGrouping = false
} = {}) {
  return applyLayerManagerGroupSearchTextModel(entries, {
    elevationGroupMetadata,
    nestedGrouping,
    getElevationGroupName,
    elevationGroupKey,
    resolveGroupKeys: buildNestedElevationPath
  });
}

function buildLayerManagerTileEntry(doc, index, { selected = false } = {}) {
  return buildLayerManagerTileEntryModel(doc, index, {
    selected,
    computeTileName,
    formatElevation,
    resolveTileType,
    isLayerHidden,
    hasTileHsbc,
    hasTileMask,
    hasTileShadowOnly,
    quantizeElevation,
    elevationGroupKey
  });
}

function buildSelectionListFilterSignature(sessionState) {
  return JSON.stringify({
    sceneKey: getCurrentSceneSessionKey(),
    searchQuery: String(sessionState?.searchQuery ?? ''),
    typeFilters: sessionState?.typeFilters instanceof Set ? Array.from(sessionState.typeFilters).sort() : [],
    flagFilters: LIST_FILTER_FLAG_KEYS.filter((key) => !!sessionState?.flagFilters?.[key])
  });
}

function invalidateSelectionListFilterCache(reason = 'unknown') {
  selectionFilterState.listFilterSignature = '';
  selectionFilterState.listFilterActive = false;
  selectionFilterState.matchingListTileIds = new Set();
  Logger.trace('layerSelectionFilter', 'LayerManager.selectionFilter.listCache.invalidated', { reason });
}

function getLayerManagerSortedTileDocs() {
  if (!canvas?.ready || !canvas?.tiles) return [];
  const hiddenIds = collectEditedTileIds();
  const tiles = collectTilePlaceables();
  const placeablesById = mapTilePlaceablesById(tiles);
  const sourceDocs = collectTileDocuments({ placeables: tiles });
  return sourceDocs
    .filter((doc) => {
      if (!doc) return false;
      if (!isDocumentInActiveLevelListScope(doc)) return false;
      const id = doc?.id || doc?._id;
      if (id && hiddenIds instanceof Set && hiddenIds.has(id)) return false;
      const placeable = id ? placeablesById.get(id) : null;
      if (placeable && placeable.destroyed) return false;
      if (placeable && isTileBeingEdited(placeable, hiddenIds)) return false;
      return true;
    })
    .slice()
    .sort(sortLayerManagerTileDocs);
}

function syncSelectionListFilterCache({ reason = 'unknown', force = false } = {}) {
  const sessionState = getLayerManagerSessionState();
  const signature = buildSelectionListFilterSignature(sessionState);
  const active = listFiltersActive(sessionState);
  if (!force && signature === selectionFilterState.listFilterSignature && active === selectionFilterState.listFilterActive) {
    return {
      active,
      matchingIds: selectionFilterState.matchingListTileIds
    };
  }

  selectionFilterState.listFilterSignature = signature;
  selectionFilterState.listFilterActive = active;
  selectionFilterState.matchingListTileIds = new Set();

  if (!active) {
    Logger.trace('layerSelectionFilter', 'LayerManager.selectionFilter.listCache.synced', {
      reason,
      active: false,
      matchingCount: 0
    });
    return {
      active: false,
      matchingIds: selectionFilterState.matchingListTileIds
    };
  }

  const parsedQuery = parseListSearchQuery(sessionState.searchQuery || '');
  const sortedDocs = getLayerManagerSortedTileDocs();
  const elevationGroupMetadata = getSceneElevationGroupMetadata();
  const nestedGrouping = isNestedLayerManagerGroupingEnabled();
  for (let index = 0; index < sortedDocs.length; index += 1) {
    const doc = sortedDocs[index];
    const entry = buildLayerManagerTileEntry(doc, index);
    applyGroupSearchTextToEntries([entry], {
      elevationGroupMetadata,
      nestedGrouping
    });
    if (!entryMatchesListFilters(entry, sessionState, parsedQuery)) continue;
    if (entry.id) selectionFilterState.matchingListTileIds.add(entry.id);
  }

  Logger.trace('layerSelectionFilter', 'LayerManager.selectionFilter.listCache.synced', {
    reason,
    active: true,
    matchingCount: selectionFilterState.matchingListTileIds.size,
    totalTileCount: sortedDocs.length
  });
  return {
    active: true,
    matchingIds: selectionFilterState.matchingListTileIds
  };
}

function selectionFilterUsesListFilters() {
  if (!selectionFilterState.active || !selectionFilterState.skipFiltered) return false;
  return !!syncSelectionListFilterCache({ reason: 'selection-active-check' }).active;
}

function placeableMatchesSelectionListFilters(placeable) {
  if (!selectionFilterUsesListFilters()) return true;
  const matcher = syncSelectionListFilterCache({ reason: 'placeable-match-check' });
  if (!matcher.active) return true;
  const id = placeable?.document?.id || placeable?.id;
  if (!id) return false;
  return matcher.matchingIds.has(id);
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

function buildNestedElevationPath(value) {
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

function buildPrefixedNestedElevationPath(value, prefix = '') {
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

function buildGroundBandGroupKey({ placementLevelId = null, renderElevation = 0 } = {}) {
  const levelKey = String(placementLevelId || 'none').trim() || 'none';
  return `ground-band:${levelKey}:${elevationGroupKey(renderElevation)}`;
}

function buildGroundExactGroupKey({ placementLevelId = null, groupElevation = 0 } = {}) {
  const levelKey = String(placementLevelId || 'none').trim() || 'none';
  return `ground:${levelKey}:${elevationGroupKey(groupElevation)}`;
}

function buildForegroundBandGroupKey({ placementLevelId = null, renderElevation = 0 } = {}) {
  const levelKey = String(placementLevelId || 'none').trim() || 'none';
  return `foreground-band:${levelKey}:${elevationGroupKey(renderElevation)}`;
}

function buildForegroundExactGroupKey({ placementLevelId = null, groupElevation = 0 } = {}) {
  const levelKey = String(placementLevelId || 'none').trim() || 'none';
  return `foreground:${levelKey}:${elevationGroupKey(groupElevation)}`;
}

function getSharedTopBoundaryUpperGroundBandKey({
  scene = canvas?.scene,
  levelId = null,
  elevation = 0
} = {}) {
  const normalizedLevelId = String(levelId || '').trim();
  if (!normalizedLevelId) return null;
  const boundaryKey = elevationGroupKey(elevation);
  const ranges = getSceneLevelElevationRanges(scene);
  const currentRange = ranges.find((range) => String(range?.levelId || '').trim() === normalizedLevelId) || null;
  if (!currentRange || elevationGroupKey(currentRange?.top) !== boundaryKey) return null;
  const upperRanges = ranges.filter((range) => {
    const rangeLevelId = String(range?.levelId || '').trim();
    if (!rangeLevelId || rangeLevelId === normalizedLevelId) return false;
    return elevationGroupKey(range?.bottom) === boundaryKey;
  });
  upperRanges.sort((left, right) => Number(left?.top ?? 0) - Number(right?.top ?? 0)
    || String(left?.levelName || left?.levelId || '').localeCompare(String(right?.levelName || right?.levelId || '')));
  const upperRange = upperRanges[0] || null;
  const upperLevelId = String(upperRange?.levelId || '').trim();
  if (!upperLevelId) return null;
  return buildGroundBandGroupKey({
    placementLevelId: upperLevelId,
    renderElevation: elevation
  });
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

function getSyntheticBandGroupBlockRank(groupKey, fallbackRank = 2) {
  const normalizedKey = String(groupKey || '').trim();
  if (normalizedKey.startsWith('ground-band:')) return 2;
  if (normalizedKey.startsWith('foreground-band:')) return 4;
  return fallbackRank;
}

function getSyntheticBandSupplementalBlockRank(groupKey, fallbackRank = 1) {
  const normalizedKey = String(groupKey || '').trim();
  if (normalizedKey.startsWith('ground-band:')) return 3;
  if (normalizedKey.startsWith('foreground-band:')) return 5;
  return fallbackRank;
}

function isSyntheticDisplayGroupKey(value) {
  return !Number.isFinite(parseElevationInput(value));
}

function isEditableElevationGroupKey(value) {
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

function buildDisplayGroupingForEntry(entry, { nestedGrouping = false } = {}) {
  const groupElevation = quantizeElevation(Number(entry?.documentElevation ?? entry?.elevation ?? 0) || 0);
  const defaultNumericName = `Elev ${formatElevation(groupElevation)}`;
  const renderKind = String(entry?.renderKind || 'normal').trim().toLowerCase();
  if (renderKind !== 'foreground' && renderKind !== 'ground') {
    const exactKey = String(entry?.documentElevationKey || elevationGroupKey(groupElevation)).trim() || elevationGroupKey(groupElevation);
    const path = nestedGrouping
      ? buildPrefixedNestedElevationPath(groupElevation)
      : [{ key: exactKey, elevation: groupElevation }];
    return {
      exactKey,
      groupElevation,
      path: path.map((segment) => ({
        ...segment,
        defaultName: `Elev ${formatElevation(segment.elevation)}`,
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
  if (!nestedGrouping) {
    return {
      exactKey,
      groupElevation,
      path: [bandSegment],
      defaultName: bandLabel,
      bandKey,
      canRename: false,
      canEditElevation: false,
      canHeaderDrop: false,
      showElevationLabel: false
    };
  }

  const bandPath = buildPrefixedNestedElevationPath(groupElevation, `${renderKind}:${placementLevelId}`)
    .map((segment) => ({
      ...segment,
      defaultName: `Elev ${formatElevation(segment.elevation)}`,
      canRename: true,
      canEditElevation: true,
      canHeaderDrop: true,
      showElevationLabel: true
    }));
  return {
    exactKey,
    groupElevation,
    path: [bandSegment, ...bandPath],
    defaultName: defaultNumericName,
    bandKey,
    canRename: true,
    canEditElevation: true,
    canHeaderDrop: true,
    showElevationLabel: true
  };
}

function buildSupplementalGroupingPath(item, { nestedGrouping = false } = {}) {
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
  if (!nestedGrouping) {
    return [{ key: exactKey, elevation }];
  }
  return buildPrefixedNestedElevationPath(elevation);
}

function createLayerManagerHierarchyNode(key, {
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

function buildLayerManagerElevationHierarchy({
  fullExactGroups = new Map(),
  matchingExactGroups = new Map(),
  resolvePathForGroup = null
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
      if (!parent.children.has(key)) parent.children.set(key, node);
      else if (parent.children.get(key) !== node) {
        Logger.error('LayerManager.nestedHierarchy.parentCollision', {
          key,
          parentKey: parent.key || null
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
      Logger.error('LayerManager.nestedHierarchy.matchingNodeMissing', {
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

function synchronizeElevationGroupMetadataWithHierarchy(metadata = {}, hierarchy = null) {
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

function isAltModifierActive() {
  if (_altKeyHeld) return true;
  try {
    return !!game?.keyboard?.isModifierActive?.('ALT');
  } catch (_) {
    return false;
  }
}

function collectEditedTileIds() {
  const hiddenIds = new Set();
  try {
    for (const key of EDITING_TILE_SET_KEYS) {
      const set = globalThis?.[key];
      if (!(set instanceof Set)) continue;
      for (const id of set) {
        if (id) hiddenIds.add(id);
      }
    }

    const buildingSet = globalThis?.__faNexusBuildingEditingTileIds;
    if (!(buildingSet instanceof Set) || !buildingSet.size) return hiddenIds;

    const wallGroupIds = new Set();
    const primaryIds = new Set();
    const tiles = collectTileDocuments();

    for (const doc of tiles) {
      const id = doc?.id;
      if (!id || !buildingSet.has(id)) continue;
      primaryIds.add(id);
      hiddenIds.add(id);
      const data = doc.getFlag?.('fa-nexus', 'building');
      const meta = data?.meta || {};
      if (meta?.wallGroupId) wallGroupIds.add(meta.wallGroupId);
      if (meta?.fillTileId) hiddenIds.add(meta.fillTileId);
    }

    if (!wallGroupIds.size && !primaryIds.size) return hiddenIds;

    for (const doc of tiles) {
      const id = doc?.id;
      if (!id || hiddenIds.has(id)) continue;
      const data = doc.getFlag?.('fa-nexus', 'building');
      if (data) {
        const meta = data?.meta || {};
        if (meta?.parentWallTileId && primaryIds.has(meta.parentWallTileId)) {
          hiddenIds.add(id);
          continue;
        }
        if (meta?.parentWallGroupId && wallGroupIds.has(meta.parentWallGroupId)) {
          hiddenIds.add(id);
          continue;
        }
        if (meta?.wallGroupId && wallGroupIds.has(meta.wallGroupId)) {
          hiddenIds.add(id);
          continue;
        }
      }
      const door = doc.getFlag?.('fa-nexus', 'buildingDoorFrame');
      if (door?.wallGroupId && wallGroupIds.has(door.wallGroupId)) {
        hiddenIds.add(id);
        continue;
      }
      const sill = doc.getFlag?.('fa-nexus', 'buildingWindowSill');
      const window = doc.getFlag?.('fa-nexus', 'buildingWindowWindow');
      const frame = doc.getFlag?.('fa-nexus', 'buildingWindowFrame');
      const windowFlag = sill || window || frame;
      if (windowFlag?.wallGroupId && wallGroupIds.has(windowFlag.wallGroupId)) {
        hiddenIds.add(id);
        continue;
      }
      const composite = doc.getFlag?.('fa-nexus', 'buildingComposite');
      if (composite?.wallGroupIds?.some?.((groupId) => wallGroupIds.has(groupId))) {
        hiddenIds.add(id);
        continue;
      }
      if (composite?.wallTileId && primaryIds.has(composite.wallTileId)) {
        hiddenIds.add(id);
      }
    }

    return hiddenIds;
  } catch (_) {
    return hiddenIds;
  }
}

function isTileBeingEdited(tile, hiddenIds) {
  try {
    const id = tile?.document?.id || tile?.id;
    if (!id) return false;
    if (hiddenIds instanceof Set) return hiddenIds.has(id);
    for (const key of EDITING_TILE_SET_KEYS) {
      const set = globalThis?.[key];
      if (set instanceof Set && set.has(id)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function isTilesLayerActive() {
  try {
    return !!canvas?.tiles && canvas?.activeLayer === canvas.tiles;
  } catch (_) {
    return false;
  }
}

function forceHideEditedTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    if (!isTileBeingEdited(tile)) return;
    try { tile.visible = false; } catch (_) {}
    try { tile.alpha = 0; } catch (_) {}
    if (tile.mesh && tile.mesh.visible !== false) {
      try { tile.mesh.visible = false; } catch (_) {}
    }
    if (tile.bg && tile.bg.visible !== false) {
      try { tile.bg.visible = false; } catch (_) {}
    }
    if (tile.frame) {
      try { if (tile.frame.border) tile.frame.border.visible = false; } catch (_) {}
    }
    markTileEventModeBlocked(tile, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
  } catch (_) {}
}

function restoreEditedTileFrame(tile) {
  try {
    if (!tile || tile.destroyed) return;
    if (isTileBeingEdited(tile)) return;
    clearTileEventModeBlocked(tile, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
    if (isLayerHidden(tile?.document)) return;
    if (tile.frame && tile.frame.visible === false) {
      try { tile.frame.visible = true; } catch (_) {}
    }
  } catch (_) {}
}

function shouldSuppressTileHover() {
  return !!selectionFilterState.active && isAltModifierActive() && isTilesLayerActive();
}

function clearTileHover({ source = 'unknown', updateLegend = true } = {}) {
  if (!canvas?.tiles) return 0;
  const tiles = [];
  const seen = new Set();
  const addTile = (tile) => {
    if (!tile) return;
    const id = tile?.document?.id || tile?.id || null;
    const key = id || tile;
    if (seen.has(key)) return;
    seen.add(key);
    tiles.push(tile);
  };
  addTile(canvas.tiles.hover);
  try {
    for (const tile of collectTilePlaceables()) {
      if (tile?.hover) addTile(tile);
    }
  } catch (error) {
    Logger.error('LayerManager.tileHover.collectFailed', {
      source,
      error: String(error?.message || error)
    });
  }

  let cleared = 0;
  for (const tile of tiles) {
    try {
      const wasHover = !!tile?.hover || canvas.tiles.hover === tile;
      tile?._onHoverOut?.(hoverEventStub, { updateLegend });
      if (canvas.tiles.hover === tile && !tile?.hover) canvas.tiles.hover = null;
      if (wasHover) cleared += 1;
    } catch (error) {
      Logger.error('LayerManager.tileHover.clearFailed', {
        source,
        tileId: tile?.document?.id || tile?.id || null,
        error: String(error?.message || error)
      });
    }
  }
  return cleared;
}

function setAltKeyHeld(active) {
  const next = !!active;
  if (_altKeyHeld === next) return;
  _altKeyHeld = next;
  if (!selectionFilterState.active) return;
  if (shouldSuppressTileHover()) {
    clearTileHover();
    try { canvas?.highlightObjects?.(false); } catch (_) {}
  }
}

function getVisibleLevelTextures() {
  const scene = canvas?.scene;
  if (!scene?._view) return [];
  const viewedLevel = scene.levels.get(scene._view);
  if (!viewedLevel) return [];
  const textures = [];
  for (const [index, level] of scene.levels.sorted.entries()) {
    const { isView, isVisible } = level || {};
    const background = level?.background || {};
    const foreground = level?.foreground || {};
    if (String(background?.src || '').trim() && (isView || isVisible)) {
      textures.push({
        level,
        name: 'background',
        elevation: level?.elevation?.bottom,
        sort: index,
        zIndex: 0,
        isBackground: true,
        isUpper: !isView && (Number(level?.elevation?.bottom) > Number(viewedLevel?.elevation?.bottom)),
        ...background
      });
    }
    if (String(foreground?.src || '').trim() && (isView || isVisible)) {
      textures.push({
        level,
        name: 'foreground',
        elevation: level?.elevation?.top,
        sort: index,
        zIndex: 1,
        isBackground: false,
        isUpper: !isView && (Number(level?.elevation?.top) > Number(viewedLevel?.elevation?.bottom)),
        ...foreground
      });
    }
  }
  return textures;
}

function readSetting(key) {
  try { return game?.settings?.get?.(MODULE_ID, key) ?? ''; } catch (_) { return ''; }
}

function writeSetting(key, value) {
  try { return game?.settings?.set?.(MODULE_ID, key, value); } catch (_) { return null; }
}

function getElevationRangeFromSettings() {
  const minRaw = readSetting(RANGE_MIN_SETTING);
  const maxRaw = readSetting(RANGE_MAX_SETTING);
  const skipLocked = !!readSetting(SKIP_LOCKED_SETTING);
  const skipHidden = !!readSetting(SKIP_HIDDEN_SETTING);
  const skipFiltered = !!readSetting(SKIP_FILTERED_SETTING);
  const ignoreForeground = !!readSetting(IGNORE_FOREGROUND_SETTING);
  return {
    minRaw,
    maxRaw,
    min: parseElevationInput(minRaw),
    max: parseElevationInput(maxRaw),
    skipLocked,
    skipHidden,
    skipFiltered,
    ignoreForeground
  };
}

function readFaFlag(doc, key) {
  try {
    const direct = doc?.getFlag?.(MODULE_ID, key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
  return flags ? flags[key] : null;
}

function isLayerHidden(doc) {
  return !!readFaFlag(doc, LAYER_HIDDEN_FLAG);
}

function getLevelTextureHiddenFlagKey(kind = 'background') {
  return String(kind || '').trim().toLowerCase() === 'foreground'
    ? LEVEL_FOREGROUND_IMAGE_HIDDEN_FLAG
    : LEVEL_BACKGROUND_IMAGE_HIDDEN_FLAG;
}

function isLevelTextureMarkerHidden(level = null, kind = 'background') {
  return !!readFaFlag(level, getLevelTextureHiddenFlagKey(kind));
}

function ensureSceneLevelTextureVisibilityPatch() {
  const SceneDocument = CONFIG?.Scene?.documentClass || foundry?.documents?.Scene || globalThis.Scene;
  const prototype = SceneDocument?.prototype;
  if (!prototype) {
    Logger.error('LayerManager.levelTextureVisibility.patch.missingScenePrototype', {
      sceneClass: SceneDocument?.name || null
    });
    return false;
  }
  if (prototype._faNexusLevelTextureVisibilityPatched) return true;
  const original = prototype._configureLevelTextures;
  if (typeof original !== 'function') {
    Logger.error('LayerManager.levelTextureVisibility.patch.missingTarget', {
      sceneClass: SceneDocument?.name || null
    });
    return false;
  }
  Object.defineProperty(prototype, '_configureLevelTextures', {
    configurable: true,
    writable: true,
    value: function faNexusConfigureLevelTextures(...args) {
      const textures = original.apply(this, args);
      if (!Array.isArray(textures) || !textures.length) return textures;
      return textures.filter((texture) => {
        const kind = texture?.isBackground ? 'background' : 'foreground';
        return !isLevelTextureMarkerHidden(texture?.level || null, kind);
      });
    }
  });
  Object.defineProperty(prototype, '_faNexusLevelTextureVisibilityPatched', {
    configurable: true,
    writable: false,
    value: true
  });
  return true;
}

function isTileHidden(doc) {
  if (!doc) return false;
  return isLayerHidden(doc);
}

function getTileDocumentId(doc) {
  return String(doc?.id || doc?._id || '').trim();
}

function uniqueTileDocuments(docs = []) {
  const byId = new Map();
  for (const doc of Array.isArray(docs) ? docs : []) {
    const id = getTileDocumentId(doc);
    if (!id || byId.has(id)) continue;
    byId.set(id, doc);
  }
  return [...byId.values()];
}

function requireMutableTileDocuments(docs = [], {
  user = game?.user,
  action = 'update'
} = {}) {
  const targets = uniqueTileDocuments(docs);
  const blocked = targets.filter((doc) => !doc?.canUserModify?.(user, 'update'));
  if (blocked.length) {
    const ids = blocked.map((doc) => getTileDocumentId(doc)).filter(Boolean);
    throw new Error(`You do not have permission to ${action} every targeted layer. Blocked: ${ids.join(', ')}`);
  }
  return targets;
}

function isDocumentInCurrentLevelElevationBand(doc, { scene = canvas?.scene } = {}) {
  if (!doc) return false;
  const currentLevelId = String(getCurrentSceneLevel(scene)?.id || '').trim();
  if (!currentLevelId) return true;
  const visibleLevelIds = getDocumentLevelIds(doc);
  if (visibleLevelIds.length && !visibleLevelIds.includes(currentLevelId)) return false;

  const analysis = analyzeTileBandState(doc, {
    scene,
    visibleLevelIds,
    requireVisibleMembership: false,
    allowSingleLevelInference: true,
    allowCurrentLevelFallback: false
  });
  if (analysis?.inSpecialBand) {
    const placementLevelId = String(analysis?.placementLevelId || '').trim();
    if (placementLevelId) return placementLevelId === currentLevelId;
    const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
    return candidates.some((candidate) => String(candidate?.placementLevelId || '').trim() === currentLevelId);
  }

  return isElevationWithinCurrentLevelEditScope(doc?.elevation ?? 0, { scene });
}

function buildLayerHiddenUpdate(doc, hidden) {
  const id = getTileDocumentId(doc);
  if (!id) return null;
  return hidden
    ? { _id: id, flags: { [MODULE_ID]: { [LAYER_HIDDEN_FLAG]: true } } }
    : { _id: id, flags: { [MODULE_ID]: { [`-=${LAYER_HIDDEN_FLAG}`]: null } } };
}

function buildLayerLockUpdate(doc, locked) {
  const id = getTileDocumentId(doc);
  if (!id) return null;
  return { _id: id, locked };
}

function resolveTileType(doc) {
  if (!doc) return { icon: 'fa-solid fa-image', label: 'Asset', key: 'asset' };
  const capabilities = getFaNexusTileCapabilities(doc);
  if (capabilities?.hasAssetScatter) return { icon: 'fa-solid fa-braille', label: 'Scatter', key: 'scatter' };
  if (capabilities?.isBuildingRelated) return { icon: 'fa-solid fa-building', label: 'Wall/Building', key: 'building' };
  if (capabilities?.hasPathData) {
    return { icon: 'fa-solid fa-route', label: 'Path', key: 'path' };
  }
  if (capabilities?.hasMaskData) return { icon: 'fa-solid fa-paint-roller', label: 'Texture', key: 'texture' };
  return { icon: 'fa-solid fa-image', label: 'Asset', key: 'asset' };
}

function syncSelectionFilterFromSettings() {
  const { min, max, skipLocked, skipHidden, skipFiltered, ignoreForeground } = getElevationRangeFromSettings();
  const wasIgnoreForeground = selectionFilterState.ignoreForeground;
  const wasSkipLocked = selectionFilterState.skipLocked;
  const wasSkipHidden = selectionFilterState.skipHidden;
  const wasSkipFiltered = selectionFilterState.skipFiltered;
  selectionFilterState.min = min;
  selectionFilterState.max = max;
  selectionFilterState.skipLocked = !!skipLocked;
  selectionFilterState.skipHidden = !!skipHidden;
  selectionFilterState.skipFiltered = !!skipFiltered;
  const nextIgnoreForeground = true;
  if (!ignoreForeground) writeSetting(IGNORE_FOREGROUND_SETTING, true);
  selectionFilterState.ignoreForeground = nextIgnoreForeground;
  if (wasSkipFiltered !== selectionFilterState.skipFiltered) invalidateSelectionListFilterCache('settings-sync');
  if (
    wasIgnoreForeground !== nextIgnoreForeground
    || wasSkipLocked !== selectionFilterState.skipLocked
    || wasSkipHidden !== selectionFilterState.skipHidden
    || wasSkipFiltered !== selectionFilterState.skipFiltered
  ) {
    refreshTileInteractionState();
  }
}

function selectionFilterActive() {
  return !!selectionFilterState.active && (
    Number.isFinite(selectionFilterState.min)
    || Number.isFinite(selectionFilterState.max)
    || !!selectionFilterState.skipLocked
    || !!selectionFilterState.skipHidden
    || selectionFilterUsesListFilters()
  );
}

function selectionIgnoresForeground() {
  return !!selectionFilterState.active && !!selectionFilterState.ignoreForeground;
}

function canSelectPlaceable(placeable, { ignoreForeground = false, filterActive = false } = {}) {
  if (!placeable) return false;
  const elevation = Number(placeable?.document?.elevation ?? 0);
  if (ignoreForeground) {
    if (!placeable.visible || !placeable.renderable) return false;
  }
  if (filterActive) {
    if (!elevationInRange(elevation)) return false;
    if (selectionFilterState.skipLocked) {
      const doc = placeable?.document;
      const sourceLocked = typeof doc?._source?.locked === 'boolean' ? doc._source.locked : null;
      const locked = sourceLocked !== null ? sourceLocked : !!doc?.locked;
      if (locked) return false;
    }
    if (selectionFilterState.skipHidden && isTileHidden(placeable?.document)) return false;
    if (selectionFilterState.skipFiltered && !placeableMatchesSelectionListFilters(placeable)) return false;
  }
  return true;
}

function canLayerManagerSelectLockedTile(tile, {
  ignoreForeground = selectionIgnoresForeground(),
  filterActive = selectionFilterActive()
} = {}) {
  if (!selectionFilterState.active || selectionFilterState.skipLocked) return false;
  if (!isTilesLayerActive()) return false;
  if (!tile?.document?.locked) return false;
  if (isTileBeingEdited(tile)) return false;
  if (isLayerHidden(tile.document)) return false;
  return canSelectPlaceable(tile, { ignoreForeground, filterActive });
}

function applyLockedTileSelectionInteractivity(tile, {
  ignoreForeground = selectionIgnoresForeground(),
  filterActive = selectionFilterActive(),
  source = 'unknown'
} = {}) {
  if (!canLayerManagerSelectLockedTile(tile, { ignoreForeground, filterActive })) return false;
  let changed = false;
  try {
    if (tile.eventMode !== 'static') {
      tile.eventMode = 'static';
      changed = true;
    }
  } catch (error) {
    Logger.error('LayerManager.lockedTileSelection.eventModeFailed', {
      source,
      tileId: tile?.document?.id || tile?.id || null,
      error: String(error?.message || error)
    });
    throw error;
  }
  if (typeof tile.interactiveChildren !== 'undefined' && tile.interactiveChildren !== true) {
    try {
      tile.interactiveChildren = true;
      changed = true;
    } catch (error) {
      Logger.error('LayerManager.lockedTileSelection.interactiveChildrenFailed', {
        source,
        tileId: tile?.document?.id || tile?.id || null,
        error: String(error?.message || error)
      });
      throw error;
    }
  }
  if (changed) {
    Logger.trace('layerSelectionFilter', 'LayerManager.lockedTileSelection.interactivityEnabled', {
      source,
      tileId: tile?.document?.id || tile?.id || null,
      eventMode: tile?.eventMode ?? null,
      skipLocked: selectionFilterState.skipLocked
    });
  }
  return true;
}

function elevationInRange(value) {
  if (!selectionFilterActive()) return true;
  if (!Number.isFinite(value)) return false;
  if (Number.isFinite(selectionFilterState.min) && value < selectionFilterState.min) return false;
  if (Number.isFinite(selectionFilterState.max) && value > selectionFilterState.max) return false;
  return true;
}

function refreshTileInteractionState() {
  if (!canvas?.ready || !canvas?.tiles?.setAllRenderFlags) return;
  try { canvas.tiles.setAllRenderFlags({ refreshState: true }); } catch (_) {}
}

function getMouseInteractionManager() {
  return globalThis?.foundry?.canvas?.interaction?.MouseInteractionManager || globalThis?.MouseInteractionManager || null;
}

const bulkTileSelectionState = {
  depth: 0,
  pendingMouseRefresh: false
};

const bulkLayerDocumentUpdateState = {
  depth: 0,
  renderPending: false
};

function flushBulkTileSelectionMouseRefresh() {
  if (!bulkTileSelectionState.pendingMouseRefresh) return;
  bulkTileSelectionState.pendingMouseRefresh = false;
  try {
    getMouseInteractionManager()?.emulateMoveEvent?.();
  } catch (error) {
    Logger.error('LayerManager.bulkTileSelection.mouseRefresh.failed', {
      error: String(error?.message || error)
    });
  }
}

function ensureBulkTileSelectionMousePatch() {
  const mouseManager = getMouseInteractionManager();
  if (!mouseManager || typeof mouseManager.emulateMoveEvent !== 'function') return;
  if (mouseManager._faNexusBulkSelectionMousePatched) return;
  mouseManager._faNexusBulkSelectionMousePatched = true;
  const original = mouseManager.emulateMoveEvent;
  mouseManager._faNexusBulkSelectionMouseOriginal = original;
  mouseManager.emulateMoveEvent = function (...args) {
    if (bulkTileSelectionState.depth > 0) {
      bulkTileSelectionState.pendingMouseRefresh = true;
      return null;
    }
    return original.apply(this, args);
  };
}

function withBulkTileSelectionBatch(operation) {
  if (typeof operation !== 'function') return undefined;
  ensureBulkTileSelectionMousePatch();
  bulkTileSelectionState.depth += 1;
  try {
    return operation();
  } finally {
    bulkTileSelectionState.depth = Math.max(0, bulkTileSelectionState.depth - 1);
    if (bulkTileSelectionState.depth === 0) flushBulkTileSelectionMouseRefresh();
  }
}

function clearSelectionFilterInteractivityBlock(tile) {
  if (!tile) return;
  tile[SELECTION_FILTER_BLOCK_KEY] = false;
  if (typeof tile.interactiveChildren !== 'undefined') {
    try { tile.interactiveChildren = true; } catch (_) {}
  }
  clearTileEventModeBlocked(tile, TILE_EVENT_MODE_SELECTION_BLOCK_KEY);
}

function getTileSelectionInteractionState(tile) {
  const manager = tile?.mouseInteractionManager || null;
  const managerState = Number(manager?.state ?? 0) || 0;
  const grabbedState = Number(manager?.states?.GRABBED ?? 3) || 3;
  const currentManagerObject = canvas?.currentMouseManager?.object || null;
  const currentManagerTile = currentManagerObject?._original || currentManagerObject;
  const currentManagerTileId = currentManagerTile?.document?.id || currentManagerTile?.id || null;
  const tileId = tile?.document?.id || tile?.id || null;
  return {
    tileId,
    controlled: !!tile?.controlled,
    hovered: !!tile?.hover,
    visible: tile?.visible !== false,
    renderable: tile?.renderable !== false,
    dragging: !!manager?.isDragging,
    managerState,
    grabbedState,
    currentManagerOwnsTile: !!tileId && currentManagerTileId === tileId
  };
}

function shouldProtectTileSelectionInteraction(tile, interaction = null) {
  const state = interaction || getTileSelectionInteractionState(tile);
  return !!(state.controlled || state.dragging || state.managerState >= state.grabbedState || state.currentManagerOwnsTile);
}

function shouldProtectTileSelectionRelease(tile, interaction = null, { ignoreForeground = false, filterActive = false } = {}) {
  const state = interaction || getTileSelectionInteractionState(tile);
  if (state.dragging || state.managerState >= state.grabbedState || state.currentManagerOwnsTile) return true;
  if (!state.controlled) return false;
  if (!filterActive) return true;
  if (ignoreForeground && (!state.visible || !state.renderable || state.hovered)) return true;
  return false;
}

function scheduleSelectionFilterRefresh({
  reason = 'unknown',
  source = 'unknown',
  tileIds = null,
  resyncSettings = true
} = {}) {
  const normalizedTileIds = Array.isArray(tileIds)
    ? [...new Set(tileIds.filter((id) => typeof id === 'string' && id.trim()))]
    : [];
  const targetIds = normalizedTileIds.length ? new Set(normalizedTileIds) : null;

  const refresh = () => {
    try {
      if (!canvas?.ready || !canvas?.tiles) return;
      if (resyncSettings) syncSelectionFilterFromSettings();
      const filterActive = selectionFilterActive();
      const ignoreForeground = selectionIgnoresForeground();
      const tiles = collectTilePlaceables();
      for (const tile of tiles) {
        const id = tile?.document?.id || tile?.id;
        if (targetIds && !targetIds.has(id)) continue;
        try { requestTileRefresh(tile); } catch (_) {}
        try { forceHideEditedTile(tile); } catch (_) {}
        try { restoreEditedTileFrame(tile); } catch (_) {}
        applySelectionFilterInteractivity(tile, { ignoreForeground, filterActive });
      }
      refreshTileInteractionState();
      pruneSelectionForFilter();
      try { getMouseInteractionManager()?.emulateMoveEvent?.(); } catch (_) {}
      Logger.trace('layerSelectionFilter', 'LayerManager.selectionFilter.refresh', {
        reason,
        source,
        tileIds: normalizedTileIds,
        active: selectionFilterState.active,
        filterActive,
        ignoreForeground,
        skipFiltered: selectionFilterState.skipFiltered
      });
    } catch (error) {
      Logger.error('LayerManager.selectionFilter.refresh.failed', {
        reason,
        source,
        tileIds: normalizedTileIds,
        error: String(error?.message || error)
      });
    }
  };

  refresh();
  try { queueMicrotask(() => refresh()); } catch (_) {}
  try {
    const root = globalThis?.window ?? globalThis;
    root?.requestAnimationFrame?.(() => refresh());
  } catch (_) {}
  try { setTimeout(() => refresh(), 80); } catch (_) {}
  try { setTimeout(() => refresh(), 180); } catch (_) {}
}

function ensureSelectionFilterRefreshHook() {
  if (selectionFilterHookState.hooksBound) return;
  selectionFilterHookState.hooksBound = true;
  const hooks = globalThis?.Hooks;
  if (!hooks?.on) return;
  try {
    hooks.on('fa-nexus-selection-filter-refresh', (options = {}) => {
      scheduleSelectionFilterRefresh(options);
    });
  } catch (error) {
    Logger.error('LayerManager.selectionFilter.hook.failed', {
      error: String(error?.message || error)
    });
  }
}

function pruneSelectionForFilter() {
  const selection = Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : [];
  if (!selection.length) return;
  const filterActive = selectionFilterActive();
  const ignoreForeground = selectionIgnoresForeground();
  let released = 0;
  withBulkTileSelectionBatch(() => {
    for (const tile of selection) {
      if (canSelectPlaceable(tile, { ignoreForeground, filterActive })) continue;
      const interaction = getTileSelectionInteractionState(tile);
      const protectRelease = shouldProtectTileSelectionRelease(tile, interaction, { ignoreForeground, filterActive });
      if (protectRelease) {
        Logger.trace('layerSelectionFilter', 'LayerManager.selectionFilter.skipProtectedTileRelease', {
          tileId: interaction.tileId,
          controlled: interaction.controlled,
          hovered: interaction.hovered,
          visible: interaction.visible,
          renderable: interaction.renderable,
          dragging: interaction.dragging,
          managerState: interaction.managerState,
          ignoreForeground,
          filterActive
        });
        continue;
      }
      try {
        tile?.release?.({ renderSidebar: false });
        released += 1;
      } catch (error) {
        Logger.error('LayerManager.selectionFilter.release.failed', {
          tileId: interaction.tileId,
          error: String(error?.message || error)
        });
        throw error;
      }
    }
  });
  if (released) renderTileSelectionSidebar();
}

function applySelectionFilterInteractivity(tile, { ignoreForeground = false, filterActive = false } = {}) {
  if (!tile) return;
  const blocked = !canSelectPlaceable(tile, { ignoreForeground, filterActive });
  const wasBlocked = !!tile[SELECTION_FILTER_BLOCK_KEY];
  const interaction = getTileSelectionInteractionState(tile);
  const protectInteraction = blocked && shouldProtectTileSelectionInteraction(tile, interaction);
  if (!blocked || protectInteraction) {
    if (wasBlocked || tile[TILE_EVENT_MODE_SELECTION_BLOCK_KEY] || protectInteraction) {
      clearSelectionFilterInteractivityBlock(tile);
    }
    if (protectInteraction) {
      Logger.trace('layerSelectionFilter', 'LayerManager.selectionFilter.skipProtectedTileBlock', {
        tileId: interaction.tileId,
        controlled: interaction.controlled,
        hovered: interaction.hovered,
        visible: interaction.visible,
        renderable: interaction.renderable,
        dragging: interaction.dragging,
        managerState: interaction.managerState,
        ignoreForeground,
        filterActive
      });
    }
    return;
  }
  tile[SELECTION_FILTER_BLOCK_KEY] = true;
  if (typeof tile.interactiveChildren !== 'undefined') {
    try { tile.interactiveChildren = false; } catch (_) {}
  }
  if (tile.eventMode !== 'none' || !tile[TILE_EVENT_MODE_SELECTION_BLOCK_KEY]) {
    markTileEventModeBlocked(tile, TILE_EVENT_MODE_SELECTION_BLOCK_KEY);
    const mouseManager = globalThis?.foundry?.canvas?.interaction?.MouseInteractionManager || globalThis?.MouseInteractionManager;
    try { mouseManager?.emulateMoveEvent?.(); } catch (_) {}
  }
}

function renderTileSelectionSidebar() {
  try {
    ui?.placeables?.render?.();
    if (game?.activeTool === 'select') ui?.placeablesPalette?.render?.();
  } catch (error) {
    Logger.error('LayerManager.tileSelection.sidebarRender.failed', {
      error: String(error?.message || error)
    });
  }
}

function ensureTileReleaseAllPatch() {
  const TilesLayer = globalThis?.foundry?.canvas?.layers?.TilesLayer || canvas?.tiles?.constructor;
  if (!TilesLayer?.prototype?.releaseAll) return;
  if (TilesLayer.prototype._faNexusReleaseAllPatched) return;
  TilesLayer.prototype._faNexusReleaseAllPatched = true;
  const original = TilesLayer.prototype.releaseAll;
  TilesLayer.prototype._faNexusReleaseAllOriginal = original;

  TilesLayer.prototype.releaseAll = function (options = {}) {
    return withBulkTileSelectionBatch(() => {
      if (!this?.placeables) return original.call(this, options);
      const renderSidebar = options?.renderSidebar !== false;
      const releaseOptions = { ...options, renderSidebar: false };
      let released = 0;
      for (const placeable of this.placeables) {
        if (!placeable?.controlled) continue;
        placeable.release(releaseOptions);
        released += 1;
      }
      if (released && renderSidebar) renderTileSelectionSidebar();
      return released;
    });
  };
}

function ensureTileReleasePatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?.release) return;
  if (Tile.prototype._faNexusReleasePatched) return;
  Tile.prototype._faNexusReleasePatched = true;
  const original = Tile.prototype.release;
  Tile.prototype._faNexusReleaseOriginal = original;

  Tile.prototype.release = function (options = {}) {
    if (bulkLayerDocumentUpdateState.depth <= 0) return original.call(this, options);
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    return original.call(this, {
      ...normalizedOptions,
      renderSidebar: false
    });
  };
}

function ensureTileControlReleaseOthersPatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?.control) return;
  if (Tile.prototype._faNexusControlReleaseOthersPatched) return;
  Tile.prototype._faNexusControlReleaseOthersPatched = true;
  const original = Tile.prototype.control;
  Tile.prototype._faNexusControlReleaseOthersOriginal = original;

  Tile.prototype.control = function (options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const controlOptions = canLayerManagerSelectLockedTile(this)
      ? { ...normalizedOptions, force: true }
      : normalizedOptions;
    if (controlOptions.force && !normalizedOptions.force) {
      Logger.trace('layerSelectionFilter', 'LayerManager.lockedTileSelection.forceControl', {
        tileId: this?.document?.id || this?.id || null,
        source: 'Tile.control',
        releaseOthers: controlOptions.releaseOthers !== false
      });
    }
    if (controlOptions.releaseOthers === false) return original.call(this, controlOptions);
    if (this?.isPreview || !this?.layer?.options?.controllableObjects || !this?.layer?.active) {
      return original.call(this, controlOptions);
    }

    const controlled = Array.isArray(this.layer?.controlled) ? this.layer.controlled : [];
    const others = controlled.filter((object) => object && object !== this);
    if (!others.length) return original.call(this, controlOptions);

    return withBulkTileSelectionBatch(() => {
      const renderSidebar = controlOptions.renderSidebar !== false;
      for (const object of others) {
        try {
          object.release({ renderSidebar: false });
        } catch (error) {
          Logger.error('LayerManager.tileControl.releaseOthers.failed', {
            tileId: object?.document?.id || object?.id || null,
            targetTileId: this?.document?.id || this?.id || null,
            error: String(error?.message || error)
          });
          throw error;
        }
      }

      const controlledTarget = original.call(this, {
        ...controlOptions,
        releaseOthers: false,
        renderSidebar: false
      });
      if (renderSidebar) renderTileSelectionSidebar();
      return controlledTarget;
    });
  };
}

function ensureTileSelectionPatch() {
  const TilesLayer = globalThis?.foundry?.canvas?.layers?.TilesLayer || canvas?.tiles?.constructor;
  if (!TilesLayer?.prototype?.selectObjects) return;
  if (TilesLayer.prototype._faNexusSelectObjectsPatched) return;
  TilesLayer.prototype._faNexusSelectObjectsPatched = true;
  const original = TilesLayer.prototype.selectObjects;
  TilesLayer.prototype._faNexusSelectObjectsOriginal = original;

  TilesLayer.prototype.selectObjects = function ({ x, y, width, height, releaseOptions = {}, controlOptions = {} } = {}, { releaseOthers = true } = {}) {
    const filterActive = selectionFilterActive();
    const ignoreForeground = selectionIgnoresForeground();
    return withBulkTileSelectionBatch(() => {
      if (!filterActive && !ignoreForeground) return original.call(this, { x, y, width, height, releaseOptions, controlOptions }, { releaseOthers });
      if (!this.options.controllableObjects) return false;

      const oldSet = new Set(this.controlled);
      const newSet = new Set();
      const rectangle = new PIXI.Rectangle(x, y, width, height);

      const placeables = ignoreForeground ? this.placeables : this.controllableObjects();
      for (const placeable of placeables) {
        if (!canSelectPlaceable(placeable, { ignoreForeground, filterActive })) continue;
        if (placeable._overlapsSelection(rectangle)) newSet.add(placeable);
      }

      const toRelease = oldSet.difference(newSet);
      const batchedReleaseOptions = { ...releaseOptions, renderSidebar: false };
      if (releaseOthers) toRelease.forEach(placeable => placeable.release(batchedReleaseOptions));

      const batchedControlOptions = {
        ...controlOptions,
        releaseOthers: false,
        renderSidebar: false
      };
      const toControl = newSet.difference(oldSet);
      toControl.forEach(placeable => placeable.control(batchedControlOptions));

      const controlChanged = (releaseOthers && (toRelease.size > 0)) || (toControl.size > 0);
      if (controlChanged) renderTileSelectionSidebar();
      return controlChanged;
    });
  };
}

function ensureTileSelectAllPatch() {
  const TilesLayer = globalThis?.foundry?.canvas?.layers?.TilesLayer || canvas?.tiles?.constructor;
  if (!TilesLayer?.prototype?._onSelectAllKey) return;
  if (TilesLayer.prototype._faNexusSelectAllPatched) return;
  TilesLayer.prototype._faNexusSelectAllPatched = true;
  const original = TilesLayer.prototype._onSelectAllKey;
  TilesLayer.prototype._faNexusSelectAllOriginal = original;

  TilesLayer.prototype._onSelectAllKey = function (event) {
    const filterActive = selectionFilterActive();
    const ignoreForeground = selectionIgnoresForeground();
    return withBulkTileSelectionBatch(() => {
      if (!filterActive && !ignoreForeground) return original.call(this, event);
      if (!this.options.controllableObjects) return false;

      const oldSet = new Set(this.controlled);
      const newSet = new Set();
      const placeables = ignoreForeground ? this.placeables : this.controllableObjects();

      for (const placeable of placeables) {
        if (!canSelectPlaceable(placeable, { ignoreForeground, filterActive })) continue;
        newSet.add(placeable);
      }

      const toRelease = oldSet.difference(newSet);
      toRelease.forEach(placeable => placeable.release({ renderSidebar: false }));

      const toControl = newSet.difference(oldSet);
      const controlOptions = { releaseOthers: false, renderSidebar: false };
      toControl.forEach(placeable => placeable.control(controlOptions));

      if (toRelease.size || toControl.size) renderTileSelectionSidebar();
      return true;
    });
  };
}

function ensureTileForegroundSelectionPatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?._refreshState) return;
  if (Tile.prototype._faNexusIgnoreForegroundPatched) return;
  Tile.prototype._faNexusIgnoreForegroundPatched = true;
  const original = Tile.prototype._refreshState;
  Tile.prototype._faNexusIgnoreForegroundOriginal = original;

  Tile.prototype._refreshState = function (...args) {
    const filterActive = selectionFilterActive();
    const ignoreForeground = selectionIgnoresForeground();
    if (!ignoreForeground) {
      const result = original.apply(this, args);
      try { forceHideEditedTile(this); } catch (_) {}
      try { restoreEditedTileFrame(this); } catch (_) {}
      applySelectionFilterInteractivity(this, { ignoreForeground, filterActive });
      applyLockedTileSelectionInteractivity(this, { ignoreForeground, filterActive, source: 'refreshState' });
      return result;
    }
    const fgTool = ui?.controls?.control?.tools?.foreground;
    if (!fgTool || typeof fgTool.active !== 'boolean') {
      const result = original.apply(this, args);
      if (this.layer?.active && this.eventMode !== 'static') this.eventMode = 'static';
      try { forceHideEditedTile(this); } catch (_) {}
      try { restoreEditedTileFrame(this); } catch (_) {}
      applySelectionFilterInteractivity(this, { ignoreForeground, filterActive });
      applyLockedTileSelectionInteractivity(this, { ignoreForeground, filterActive, source: 'refreshState:noForegroundTool' });
      return result;
    }
    const prev = fgTool.active;
    const currentLevelRange = getCurrentLevelElevationRange(this.document?.parent);
    const foregroundThreshold = Number(currentLevelRange?.top ?? 0);
    const overhead = Number(this.document?.elevation ?? 0) >= foregroundThreshold;
    fgTool.active = overhead;
    try {
      const result = original.apply(this, args);
      try { forceHideEditedTile(this); } catch (_) {}
      try { restoreEditedTileFrame(this); } catch (_) {}
      applySelectionFilterInteractivity(this, { ignoreForeground, filterActive });
      applyLockedTileSelectionInteractivity(this, { ignoreForeground, filterActive, source: 'refreshState:foregroundScope' });
      return result;
    } finally {
      fgTool.active = prev;
    }
  };
}

function ensureTileHoverSuppressionPatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?._onHoverIn) return;
  if (Tile.prototype._faNexusHoverSuppressionPatched) return;
  Tile.prototype._faNexusHoverSuppressionPatched = true;
  const original = Tile.prototype._onHoverIn;
  Tile.prototype._faNexusHoverSuppressionOriginal = original;

  Tile.prototype._onHoverIn = function (...args) {
    if (shouldSuppressTileHover()) return;
    return original.apply(this, args);
  };
}

function ensureCanvasHighlightSuppressionPatch() {
  const Canvas = globalThis?.foundry?.canvas?.Canvas || canvas?.constructor;
  if (!Canvas?.prototype?.highlightObjects) return;
  if (Canvas.prototype._faNexusHighlightSuppressionPatched) return;
  Canvas.prototype._faNexusHighlightSuppressionPatched = true;
  const original = Canvas.prototype.highlightObjects;
  Canvas.prototype._faNexusHighlightSuppressionOriginal = original;

  Canvas.prototype.highlightObjects = function (active) {
    if (active && shouldSuppressTileHover()) return;
    return original.call(this, active);
  };
}

function applyLayerHiddenState(tile) {
  if (!tile || tile.destroyed) return;
  const doc = tile.document;
  if (!isLayerHidden(doc)) return;
  if (tile.mesh && tile.mesh.visible !== false) {
    try { tile.mesh.visible = false; } catch (_) {}
  }
  if (tile.bg && tile.bg.visible !== false) {
    try { tile.bg.visible = false; } catch (_) {}
  }
  if (tile.frame && tile.frame.visible !== false) {
    try { tile.frame.visible = false; } catch (_) {}
  }
  markTileEventModeBlocked(tile, TILE_EVENT_MODE_HIDDEN_BLOCK_KEY);
}

function restoreLayerHiddenState(tile) {
  if (!tile || tile.destroyed) return;
  const doc = tile.document;
  if (isLayerHidden(doc)) return;
  clearTileEventModeBlocked(tile, TILE_EVENT_MODE_HIDDEN_BLOCK_KEY);
  if (tile.mesh && tile.mesh.visible === false) {
    try { tile.mesh.visible = tile.isVisible; } catch (_) {}
  }
  if (tile.bg && tile.bg.visible === false) {
    try { tile.bg.visible = !!tile.layer?.active; } catch (_) {}
  }
  if (tile.frame && tile.frame.visible === false) {
    try { tile.frame.visible = true; } catch (_) {}
  }
}

function hasLayerHiddenChange(changes) {
  if (!changes?.flags) return false;
  const scoped = changes.flags[MODULE_ID];
  if (scoped === null) return true;
  if (!scoped) return false;
  if (Object.prototype.hasOwnProperty.call(scoped, LAYER_HIDDEN_FLAG)) return true;
  const unsetKey = `-=${LAYER_HIDDEN_FLAG}`;
  return Object.prototype.hasOwnProperty.call(scoped, unsetKey);
}

function requestTileRefresh(tile) {
  try { tile?.renderFlags?.set?.({ refreshState: true }); } catch (_) {}
}

function handleLayerHiddenUpdate(doc, changes) {
  const tile = doc?.object;
  if (!tile) return;
  const hiddenNow = isLayerHidden(doc);
  if (hasLayerHiddenChange(changes)) requestTileRefresh(tile);
  if (hiddenNow) applyLayerHiddenState(tile);
  else restoreLayerHiddenState(tile);
}

function applyLayerHiddenToCanvas() {
  if (!canvas?.ready || !canvas?.tiles) return;
  const placeables = collectTilePlaceables();
  for (const tile of placeables) {
    if (isLayerHidden(tile?.document)) applyLayerHiddenState(tile);
    else restoreLayerHiddenState(tile);
  }
}

function ensureLayerHiddenHooks() {
  if (layerHiddenState.hooksBound) return;
  layerHiddenState.hooksBound = true;
  const hooks = globalThis?.Hooks;
  if (hooks && typeof hooks.on === 'function') {
    try { hooks.on('drawTile', (tile) => applyLayerHiddenState(tile)); } catch (_) {}
    try { hooks.on('refreshTile', (tile) => applyLayerHiddenState(tile)); } catch (_) {}
    try { hooks.on('updateTile', (doc, changes) => handleLayerHiddenUpdate(doc, changes)); } catch (_) {}
    try { hooks.on('controlTile', (tile) => applyLayerHiddenState(tile)); } catch (_) {}
  }
  try { onCanvasReady(() => applyLayerHiddenToCanvas(), { hooks }); } catch (_) {}
}

function computeTileName(tile, index) {
  const doc = tile?.document;
  const documentName = String(doc?.name ?? '').trim();
  if (documentName) return documentName;
  const explicitName = readFaFlag(doc, 'name');
  if (explicitName !== null && explicitName !== undefined && String(explicitName).trim()) {
    return String(explicitName).trim();
  }
  const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
  const legacyLabel = flags?.label || doc?.label;
  if (legacyLabel) return String(legacyLabel);
  const masked = readFaFlag(doc, 'maskedTiling');
  if (masked?.baseColor) return 'Solid Color';
  const src = String(doc?.texture?.src || '').trim();
  if (src) {
    const filename = src.split('/').pop() || src;
    const base = filename.replace(/\.[^/.]+$/, '');
    return base || filename;
  }
  return `Tile ${index + 1}`;
}

function resolvePreviewElevation(container) {
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

function resolvePreviewPlacementSort(container) {
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

function resolvePreviewRenderSort(container, fallback = 0) {
  if (!container) return normalizeRenderOrderValue(fallback);
  return normalizeRenderOrderValue(
    container.faNexusSort
    ?? container.sort
    ?? fallback
  );
}

function resolvePreviewPlacementLevelId(container) {
  const normalized = String(container?.faNexusPlacementLevelId || '').trim();
  return normalized || null;
}

function resolvePreviewBandKind(container) {
  const normalized = String(container?.faNexusBandKind || '').trim().toLowerCase();
  return normalized === 'foreground' || normalized === 'ground' ? normalized : null;
}

function resolveSceneLevelName(levelId, scene = canvas?.scene) {
  const normalizedId = String(levelId || '').trim();
  if (!normalizedId) return null;
  const range = getSceneLevelElevationRanges(scene).find((entry) => String(entry?.levelId || '').trim() === normalizedId) || null;
  const normalizedName = String(range?.levelName || '').trim();
  return normalizedName || null;
}

function buildPreviewEntry(container, { label, icon, kind, previewActiveOverride, canDragPreviewOverride }) {
  if (!container || container.destroyed) return null;
  const documentElevation = resolvePreviewElevation(container);
  const placementSort = resolvePreviewPlacementSort(container);
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
  const explicitPlacementLevelId = resolvePreviewPlacementLevelId(container);
  const derivedRenderOrder = resolveTileRenderOrder({ elevation: documentElevation, sort: placementSort }, {
    elevation: documentElevation,
    sort: placementSort,
    placementLevelId: explicitPlacementLevelId || getDefaultTilePlacementLevelId(),
    allowCurrentLevelFallback: true
  });
  const renderKind = resolvePreviewBandKind(container)
    || String(derivedRenderOrder?.kind || 'normal').trim().toLowerCase()
    || 'normal';
  const placementLevelId = explicitPlacementLevelId
    || String(derivedRenderOrder?.placementLevelId || '').trim()
    || null;
  const placementLevelName = resolveSceneLevelName(placementLevelId)
    || String(derivedRenderOrder?.analysis?.placementRange?.levelName || '').trim()
    || null;
  const renderElevation = quantizeElevation(Number(
    container.faNexusElevation
    ?? container.elevation
    ?? derivedRenderOrder?.elevation
    ?? documentElevation
  ) || 0);
  const renderElevationKey = elevationGroupKey(renderElevation);
  const documentElevationKey = elevationGroupKey(documentElevation);
  const sortLayers = getPrimaryCanvasSortLayers();
  const explicitRenderSort = resolvePreviewRenderSort(container, derivedRenderOrder?.sort);
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
    previewKind: kind,
    previewKey,
    previewId: `${kind}-${previewKey}`,
    previewActive,
    previewHasContent,
    canDragPreview: canDragPreviewOverride !== undefined
      ? !!canDragPreviewOverride
      : (previewActive || previewHasContent),
    name: label,
    baseName: label,
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
    typeIcon: icon,
    typeLabel: label
  };
}

function buildSceneMarkerEntry(texture, index = 0) {
  const kind = texture?.isBackground ? 'background' : 'foreground';
  const numeric = Number(texture?.elevation);
  if (!Number.isFinite(numeric)) return null;
  const level = texture?.level || null;
  const rawLevelName = String(level?.name || '').trim();
  const levelLabel = rawLevelName || (Number.isFinite(level?.index) ? `Level ${Number(level.index) + 1}` : 'Level');
  const label = `${levelLabel} ${kind === 'foreground' ? 'Foreground' : 'Background'} Image`;
  const icon = kind === 'foreground' ? 'fa-solid fa-layer-group' : 'fa-solid fa-image';
  const sortLayers = getPrimaryCanvasSortLayers();
  return {
    marker: true,
    markerKind: kind,
    markerId: `scene-${String(level?.id || texture?.sort || 'unknown')}-${kind}`,
    markerLevelId: String(level?.id || ''),
    markerLevelName: levelLabel,
    markerScope: texture?.isUpper ? 'upper' : (level?.isView ? 'viewed' : 'visible'),
    name: label,
    hidden: isLevelTextureMarkerHidden(level, kind),
    canToggleVisibility: !!level?.canUserModify?.(game.user, 'update'),
    elevation: quantizeElevation(numeric),
    elevationKey: elevationGroupKey(numeric),
    sort: normalizeRenderOrderValue(texture?.sort ?? 0),
    sortLayer: normalizeRenderOrderValue(sortLayers.SCENE),
    zIndex: normalizeRenderOrderValue(texture?.zIndex ?? 0),
    lastSortedIndex: normalizeRenderOrderValue(index),
    typeIcon: icon,
    typeLabel: label
  };
}

function buildLevelBoundarySeparatorEntries(scene = canvas?.scene) {
  const currentLevel = getCurrentSceneLevel(scene);
  const currentLevelId = String(currentLevel?.id || '').trim();
  if (!currentLevelId) return [];
  const levelRanges = getSceneLevelElevationRanges(scene);
  const currentRange = levelRanges.find((range) => String(range?.levelId || '').trim() === currentLevelId)
    || getCurrentLevelElevationRange(scene);
  if (!currentRange) return [];
  const sortLayers = getPrimaryCanvasSortLayers();
  const separatorSortLayer = normalizeRenderOrderValue(sortLayers?.SCENE, DEFAULT_PRIMARY_SORT_LAYERS.SCENE) - 1;
  const levelName = String(currentRange?.levelName || currentLevel?.name || '').trim() || 'Level';
  const entries = [{
    kind: 'T',
    elevation: Number(currentRange?.top),
    fallbackOrder: 0
  }, {
    kind: 'B',
    elevation: Number(currentRange?.bottom),
    fallbackOrder: 1
  }]
    .filter((entry) => Number.isFinite(entry?.elevation))
    .sort((left, right) => Number(right?.elevation ?? 0) - Number(left?.elevation ?? 0)
      || Number(left?.fallbackOrder ?? 0) - Number(right?.fallbackOrder ?? 0));

  return entries.map((entry, index) => {
    const boundaryKey = elevationGroupKey(entry.elevation);
    const boundaryKind = String(entry?.kind || '').trim().toUpperCase() || '?';
    const boundaryIconClass = boundaryKind === 'T' ? 'fa-solid fa-arrow-down' : 'fa-solid fa-arrow-up';
    return {
      separator: true,
      levelBoundarySeparator: true,
      levelBoundaryId: `level-boundary-${boundaryKey}-${boundaryKind}`,
      levelBoundaryKey: boundaryKey,
      levelBoundaryLevelIds: currentLevelId,
      levelBoundaryMembers: [{
        levelId: currentLevelId,
        levelName,
        kind: boundaryKind,
        iconClass: boundaryIconClass
      }],
      levelBoundaryLabel: `${levelName}`,
      levelBoundaryElevationLabel: formatElevation(entry.elevation),
      elevation: entry.elevation,
      elevationValue: entry.elevation,
      elevationKey: `level-boundary-${boundaryKey}-${boundaryKind}`,
      sortLayer: separatorSortLayer,
      sort: 0,
      zIndex: 0,
      lastSortedIndex: normalizeRenderOrderValue(index, 0)
    };
  });
}

function collectPreviewEntries() {
  if (!canvas?.ready) return [];
  const roots = new Set();
  if (canvas?.primary) roots.add(canvas.primary);
  if (canvas?.stage) roots.add(canvas.stage);
  const entries = [];
  const seen = new Set();
  const scatterCandidates = [];
  const buildingPreviewRoots = [];
  const buildingFillRoots = [];
  let scatterEntries = 0;
  const shouldInclude = (container) => !!container?.faNexusPreviewActive || !!container?.faNexusPreviewHasContent;
  const push = (container, meta) => {
    if (!container || container.destroyed) return;
    if (seen.has(container)) return;
    const entry = buildPreviewEntry(container, meta);
    if (entry) {
      entries.push(entry);
      seen.add(container);
      if (meta?.kind === 'scatter-preview') scatterEntries += 1;
    }
  };
  const pushScatterCandidate = (container) => {
    if (!container || container.destroyed) return;
    scatterCandidates.push(container);
  };
  const pushBuildingRoot = (container, collection) => {
    if (!container || container.destroyed) return;
    collection.push(container);
  };
  const walk = (container, depth = 0) => {
    if (!container || container.destroyed) return;
    if (container.faNexusAssetPlacementPreview || container.name === 'fa-nexus-asset-preview') {
      if (shouldInclude(container)) {
        push(container, { label: 'Asset Placement Preview', icon: 'fa-solid fa-image', kind: 'asset-placement-preview' });
      }
    } else if (container.faNexusScatterPreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Scatter Preview', icon: 'fa-solid fa-braille', kind: 'scatter-preview' });
      } else {
        pushScatterCandidate(container);
      }
    } else if (container.faNexusPathPreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Path Preview', icon: 'fa-solid fa-route', kind: 'path-preview' });
      }
    } else if (container.faNexusTexturePreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Texture Preview', icon: 'fa-solid fa-paint-roller', kind: 'texture-preview' });
      }
    } else if (container.name === 'fa-nexus-building-preview-root') {
      pushBuildingRoot(container, buildingPreviewRoots);
    } else if (container.name === 'fa-nexus-building-fill-preview-root') {
      pushBuildingRoot(container, buildingFillRoots);
    }
    if (depth >= 3) return;
    const children = Array.isArray(container.children) ? container.children : [];
    for (const child of children) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }

  const buildingManagerActive = (() => {
    try {
      return !!globalThis?.faNexus?.premiumFeatures?.buildingEditor?.activeManager?.isActive;
    } catch (_) {
      return false;
    }
  })();
  const buildingActive = buildingManagerActive || [...buildingPreviewRoots, ...buildingFillRoots].some(
    (container) => !!container?.faNexusPreviewActive
  );
  const hasSpecificBuildingActivePreview = [...buildingPreviewRoots, ...buildingFillRoots].some(
    (container) => !!container?.faNexusPreviewActive
  );
  for (const container of buildingPreviewRoots) {
    push(container, {
      label: 'Building Preview',
      icon: 'fa-solid fa-building',
      kind: 'building-preview',
      previewActiveOverride: buildingActive && !hasSpecificBuildingActivePreview ? true : undefined,
      canDragPreviewOverride: buildingActive ? true : undefined
    });
  }
  for (const container of buildingFillRoots) {
    push(container, {
      label: 'Building Fill Preview',
      icon: 'fa-solid fa-fill-drip',
      kind: 'building-fill-preview',
      previewActiveOverride: undefined,
      canDragPreviewOverride: buildingActive ? true : undefined
    });
  }

  if (!scatterEntries && scatterCandidates.length) {
    let fallback = scatterCandidates[0];
    for (const candidate of scatterCandidates) {
      if (!candidate || candidate.destroyed) continue;
      if (resolvePreviewPlacementSort(candidate) > resolvePreviewPlacementSort(fallback)) {
        fallback = candidate;
      }
    }
    push(fallback, {
      label: 'Scatter Preview',
      icon: 'fa-solid fa-braille',
      kind: 'scatter-preview',
      previewActiveOverride: true
    });
  }

  const numberedKinds = new Set(['path-preview', 'scatter-preview']);
  const grouped = new Map();
  for (const entry of entries) {
    const kind = String(entry?.previewKind || '').trim();
    if (!numberedKinds.has(kind)) continue;
    const list = grouped.get(kind) || [];
    list.push(entry);
    grouped.set(kind, list);
  }
  for (const list of grouped.values()) {
    if (list.length <= 1) continue;
    const ordered = list.slice().sort((left, right) => {
      const elevationDelta = Number(left?.documentElevation ?? left?.elevation ?? 0) - Number(right?.documentElevation ?? right?.elevation ?? 0);
      if (Math.abs(elevationDelta) > 0.0001) return elevationDelta;
      return Number(left?.placementSort ?? left?.sort ?? 0) - Number(right?.placementSort ?? right?.sort ?? 0);
    });
    for (let index = 0; index < ordered.length; index += 1) {
      const entry = ordered[index];
      entry.previewOrdinal = index + 1;
      entry.name = `${entry.baseName || entry.name || 'Preview'} ${index + 1}`;
    }
  }

  return entries;
}

function getFaNexusAppInstance() {
  try {
    return foundry?.applications?.instances?.get?.('fa-nexus-app') || null;
  } catch (_) {
    return null;
  }
}

function getFaNexusTabs() {
  const app = getFaNexusAppInstance();
  const tabManager = app?._tabManager || null;
  try { tabManager?.initializeTabs?.(); } catch (_) {}
  try {
    return tabManager?.getTabs?.() || null;
  } catch (_) {
    return null;
  }
}

function resolvePreviewSessionController(previewKind = '') {
  const kind = String(previewKind || '').trim();
  const tabs = getFaNexusTabs();
  if (!tabs) return null;
  if (kind === 'asset-placement-preview' || kind === 'scatter-preview') {
    return tabs.assets?.placementManager || null;
  }
  if (kind === 'path-preview') {
    return tabs.paths?.pathManagerV2 || null;
  }
  if (kind === 'texture-preview') {
    return tabs.textures?.texturePaintManager || null;
  }
  if (kind === 'building-preview' || kind === 'building-fill-preview') {
    return tabs.buildings?.buildingManager || null;
  }
  return null;
}

function resolveTexturePaintManager() {
  const tabs = getFaNexusTabs();
  return tabs?.textures?.texturePaintManager || null;
}

function resolveSyntheticTargetPlacementLevelId(elevationKey = '') {
  const normalizedKey = String(elevationKey || '').trim();
  if (!normalizedKey) return undefined;
  const match = /^(foreground|ground)(?:-band)?:([^:]+):.+$/.exec(normalizedKey);
  if (!match) return undefined;
  const placementLevelId = String(match[2] || '').trim();
  return placementLevelId && placementLevelId !== 'none' ? placementLevelId : '';
}

function buildEntriesFromCanvas(options = {}) {
  const sessionState = options?.sessionState || getLayerManagerSessionState();
  const parsedQuery = options?.parsedQuery || parseListSearchQuery(sessionState?.searchQuery || '');
  const rawElevationGroupMetadata = options?.elevationGroupMetadata || getSceneElevationGroupMetadata();
  const nestedGrouping = isNestedLayerManagerGroupingEnabled();
  const filtersApplied = listFiltersActive(sessionState);
  const emptyHierarchy = {
    rootKeys: [],
    nodesByKey: new Map(),
    visibleKeys: new Set()
  };
  if (!canvas?.ready || !canvas?.tiles) {
    return {
      entries: [],
      matchingTileIdsByElevation: new Map(),
      fullTileDocsById: new Map(),
      fullTileGroupKeyById: new Map(),
      fullTileIdsInOrder: [],
      fullExactGroupElevationsByKey: new Map(),
      fullElevationGroups: new Map(),
      fullGroupDocsByKey: new Map(),
      fullGroupHierarchy: emptyHierarchy,
      matchingGroupHierarchy: emptyHierarchy,
      elevationGroupMetadata: rawElevationGroupMetadata,
      elevationGroupMetadataDirty: false,
      staleSyntheticMetadataKeys: [],
      nestedGrouping,
      filtersApplied,
      totalTileCount: 0,
      matchingTileCount: 0
    };
  }
  const sortedDocs = getLayerManagerSortedTileDocs();
  const controlled = new Set((canvas.tiles.controlled || []).map(tile => tile.document?.id || tile.id));
  const fullTileDocsById = new Map();
  const fullTileGroupKeyById = new Map();
  const fullTileIdsInOrder = [];
  const fullExactGroupElevationsByKey = new Map();
  const fullExactGroups = new Map();
  const tileEntries = [];
  for (let i = 0; i < sortedDocs.length; i += 1) {
    const doc = sortedDocs[i];
    const entry = buildLayerManagerTileEntry(doc, i, {
      selected: controlled.has(doc?.id || doc?._id)
    });
    const displayGrouping = buildDisplayGroupingForEntry(entry, { nestedGrouping });
    const elevation = Number(displayGrouping?.groupElevation ?? entry?.documentElevation ?? entry?.elevation ?? 0) || 0;
    const elevationKey = String(displayGrouping?.exactKey || entry?.elevationKey || '').trim() || elevationGroupKey(elevation);
    entry.elevationKey = elevationKey;
    entry.groupElevation = elevation;
    entry.groupElevationLabel = formatElevation(elevation);
    entry.groupPath = Array.isArray(displayGrouping?.path) ? displayGrouping.path.slice() : [];
    entry.groupCanRename = displayGrouping?.canRename !== false;
    entry.groupCanEditElevation = displayGrouping?.canEditElevation !== false;
    entry.groupCanHeaderDrop = displayGrouping?.canHeaderDrop !== false;
    entry.groupShowElevationLabel = displayGrouping?.showElevationLabel !== false;
    const id = entry.id;
    if (id) {
      fullTileDocsById.set(id, doc);
      fullTileGroupKeyById.set(id, elevationKey);
      fullTileIdsInOrder.push(id);
    }
    let fullGroup = fullExactGroups.get(elevationKey);
    if (!fullGroup) {
      fullGroup = {
        key: elevationKey,
        elevation,
        renderElevation: Number(entry?.renderElevation ?? entry?.elevation ?? 0) || 0,
        path: Array.isArray(entry?.groupPath) ? entry.groupPath.slice() : [],
        entries: [],
        docs: [],
        canRename: entry.groupCanRename !== false,
        canEditElevation: entry.groupCanEditElevation !== false,
        canHeaderDrop: entry.groupCanHeaderDrop !== false,
        showElevationLabel: entry.groupShowElevationLabel !== false
      };
      fullExactGroups.set(elevationKey, fullGroup);
    }
    fullExactGroupElevationsByKey.set(elevationKey, elevation);
    fullGroup.docs.push(doc);
    tileEntries.push(entry);
    fullGroup.entries.push(entry);
  }

  applyGroupSearchTextToEntries(tileEntries, {
    elevationGroupMetadata: rawElevationGroupMetadata,
    nestedGrouping
  });

  const matchingTileEntries = tileEntries.filter((entry) => entryMatchesListFilters(entry, sessionState, parsedQuery));
  const matchingExactGroups = new Map();
  for (const entry of matchingTileEntries) {
    const key = entry.elevationKey;
    let group = matchingExactGroups.get(key);
    if (!group) {
      group = {
        key,
        elevation: Number(entry.groupElevation ?? entry.documentElevation ?? entry.elevation ?? 0) || 0,
        renderElevation: Number(entry?.renderElevation ?? entry?.elevation ?? 0) || 0,
        path: Array.isArray(entry?.groupPath) ? entry.groupPath.slice() : [],
        entries: [],
        docs: [],
        canRename: entry.groupCanRename !== false,
        canEditElevation: entry.groupCanEditElevation !== false,
        canHeaderDrop: entry.groupCanHeaderDrop !== false,
        showElevationLabel: entry.groupShowElevationLabel !== false
      };
      matchingExactGroups.set(key, group);
    }
    group.entries.push(entry);
    const doc = fullTileDocsById.get(entry.id);
    if (doc) group.docs.push(doc);
  }

  const previewEntries = collectPreviewEntries();
  for (const entry of previewEntries) {
    const displayGrouping = buildDisplayGroupingForEntry(entry, { nestedGrouping });
    const elevation = Number(displayGrouping?.groupElevation ?? entry?.documentElevation ?? entry?.elevation ?? 0) || 0;
    const elevationKey = String(displayGrouping?.exactKey || entry?.documentElevationKey || entry?.elevationKey || '').trim()
      || elevationGroupKey(elevation);
    entry.elevationKey = elevationKey;
    entry.groupElevation = elevation;
    entry.groupElevationLabel = formatElevation(elevation);
    entry.groupPath = Array.isArray(displayGrouping?.path) ? displayGrouping.path.slice() : [];
  }
  const sceneTextureEntries = getVisibleLevelTextures();
  const markerEntries = sceneTextureEntries.map((texture, index) => buildSceneMarkerEntry(texture, index)).filter(Boolean);
  const levelBoundaryEntries = buildLevelBoundarySeparatorEntries(canvas?.scene);
  const supplementalEntries = previewEntries.concat(markerEntries).sort(sortLayerManagerRenderEntries);
  const fullElevationGroups = new Map(
    Array.from(fullExactGroups.entries()).map(([key, group]) => [key, group.docs.slice()])
  );
  const entries = [];
  const matchingTileIdsByElevation = new Map();
  const fullGroupDocsByKey = new Map();
  let elevationGroupMetadata = rawElevationGroupMetadata;
  let elevationGroupMetadataDirty = false;
  let staleSyntheticMetadataKeys = [];
  let fullGroupHierarchy = emptyHierarchy;
  let matchingGroupHierarchy = emptyHierarchy;
  const hierarchy = buildLayerManagerElevationHierarchy({
    fullExactGroups,
    matchingExactGroups,
    resolvePathForGroup: (group) => Array.isArray(group?.path) ? group.path.slice() : []
  });
  const metadataSync = synchronizeElevationGroupMetadataWithHierarchy(rawElevationGroupMetadata, hierarchy.fullVisible);
  elevationGroupMetadata = metadataSync.metadata;
  elevationGroupMetadataDirty = metadataSync.changed;
  staleSyntheticMetadataKeys = metadataSync.staleSyntheticKeys.slice();
  fullGroupHierarchy = hierarchy.fullVisible;
  matchingGroupHierarchy = hierarchy.matchingVisible;
  const collapsedStateSync = reconcileLayerManagerCollapsedState({
    sessionState,
    hierarchy: hierarchy.fullVisible
  });
  if (collapsedStateSync.changed) {
    Logger.info('LayerManager.collapsedState.reconciled', {
      sceneId: canvas?.scene?.id || null,
      staleSyntheticKeys: collapsedStateSync.staleSyntheticKeys
    });
    queuePersistLayerManagerCollapsedState();
  }

  for (const [key, node] of hierarchy.fullVisible.nodesByKey.entries()) {
    fullGroupDocsByKey.set(key, node.fullSubtreeDocs.slice());
  }
  for (const [key, node] of hierarchy.matchingVisible.nodesByKey.entries()) {
    matchingTileIdsByElevation.set(key, node.matchingSubtreeDocs.map((doc) => doc?.id).filter(Boolean));
  }

  const persistentSupplementalsByGroupKey = new Map();
  const exactSupplementalsByGroupKey = new Map();
  const orphanSupplementalsByGroupKey = new Map();
  const topLevelSupplementals = new Map();
  const visibleGroupKeys = hierarchy.matchingVisible.visibleKeys;
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

  for (const item of supplementalEntries) {
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

  const materializeSupplementalBlocks = (blockMap = null, depth = 0) => {
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
      .sort((a, b) => Number(b?.blockElevation ?? 0) - Number(a?.blockElevation ?? 0)
        || Number(a?.blockRank ?? 0) - Number(b?.blockRank ?? 0));
  };
  const applyTreeDepth = (items, depth) => items.map((item) => ({
    ...item,
    treeDepth: depth,
    indentPx: depth * 12
  }));
  const sortBlocks = (left, right) => Number(right?.blockElevation ?? 0) - Number(left?.blockElevation ?? 0)
    || Number(left?.blockRank ?? 0) - Number(right?.blockRank ?? 0);

  const renderGroupBlock = (groupKey) => {
    const node = hierarchy.matchingVisible.nodesByKey.get(groupKey);
    if (!node) return null;
    const matchingDocs = node.matchingSubtreeDocs.filter(Boolean);
    const canRenameGroup = node.canRename !== false;
    const canEditElevation = node.canEditElevation !== false && isEditableElevationGroupKey(groupKey);
    const persistedGroupName = canRenameGroup ? getElevationGroupName(elevationGroupMetadata, groupKey) : '';
    const defaultElevationDisplayName = Number.isFinite(node.elevation)
      ? `Elev ${formatElevation(node.elevation)}`
      : '';
    const groupDisplayName = persistedGroupName
      || node.defaultName
      || defaultElevationDisplayName;
    const hideDuplicateElevationLabel = !!defaultElevationDisplayName
      && String(groupDisplayName || '').trim() === defaultElevationDisplayName;
    const blockEntries = [{
      separator: true,
      elevation: formatElevation(node.elevation),
      elevationValue: node.elevation,
      elevationKey: groupKey,
      groupHasCustomName: !!persistedGroupName || (!canRenameGroup && !!node.defaultName),
      groupName: persistedGroupName || '',
      groupDisplayName,
      groupHidden: matchingDocs.length ? matchingDocs.every((doc) => isLayerHidden(doc)) : false,
      groupLocked: matchingDocs.length ? matchingDocs.every((doc) => !!doc?.locked) : false,
      canToggleVisibility: matchingDocs.some((doc) => doc?.canUserModify?.(game.user, 'update')),
      matchingCount: matchingDocs.length,
      collapsed: !!sessionState?.collapsedElevations?.has?.(groupKey),
      treeDepth: node.depth,
      indentPx: node.depth * 12,
      groupSynthetic: !!node.isSynthetic,
      hasChildGroups: node.childKeys.length > 0,
      groupCanRename: canRenameGroup,
      groupCanEditElevation: canEditElevation,
      groupCanHeaderDrop: node.canHeaderDrop !== false,
      groupShowElevationLabel: node.showElevationLabel !== false && Number.isFinite(node.elevation),
      groupHideDuplicateElevationLabel: hideDuplicateElevationLabel,
      groupClass: node.groupClass || ''
    }];
    const persistentSupplementalEntries = materializeSupplementalBlocks(
      persistentSupplementalsByGroupKey.get(groupKey),
      node.depth + 1
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
    const exactSupplementalItems = materializeSupplementalBlocks(exactSupplementalsByGroupKey.get(groupKey), node.depth + 1)
      .flatMap((block) => Array.isArray(block?.entries) ? block.entries : []);
    const exactItems = node.matchingExactEntries
      .concat(exactSupplementalItems)
      .sort(sortLayerManagerRenderEntries);
    if (exactItems.length) {
      childBlocks.push({
        blockElevation: Number(node.elevation ?? 0),
        blockRank: node.syntheticBand ? 3 : 2,
        entries: applyTreeDepth(exactItems, node.depth + 1)
      });
    }

    childBlocks.push(...materializeSupplementalBlocks(orphanSupplementalsByGroupKey.get(groupKey), node.depth + 1));

    for (const childKey of node.childKeys) {
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
  for (const rootKey of hierarchy.matchingVisible.rootKeys) {
    const block = renderGroupBlock(rootKey);
    if (block) topLevelBlocks.push(block);
  }
  topLevelBlocks.push(...materializeSupplementalBlocks(topLevelSupplementals.get('__root__'), 0));
  topLevelBlocks.sort(sortBlocks);
  for (const boundaryEntry of levelBoundaryEntries) {
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
      const upperGroundKey = getSharedTopBoundaryUpperGroundBandKey({
        scene: canvas?.scene,
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
    fullTileDocsById,
    fullTileGroupKeyById,
    fullTileIdsInOrder,
    fullExactGroupElevationsByKey,
    fullElevationGroups,
    elevationGroupMetadata,
    elevationGroupMetadataDirty,
    staleSyntheticMetadataKeys,
    fullGroupDocsByKey,
    fullGroupHierarchy,
    matchingGroupHierarchy,
    nestedGrouping,
    filtersApplied,
    totalTileCount: tileEntries.length,
    matchingTileCount: matchingTileEntries.length
  };
}

function insertLayerManagerTabIntoSidebar(SidebarClass) {
  const tabs = SidebarClass?.TABS;
  if (!tabs || typeof tabs !== 'object') return false;
  if (tabs[TAB_ID]) return false;
  const descriptor = {
    tooltip: 'FA-NEXUS.LayerManager',
    icon: 'fa-solid fa-layer-group',
    gmOnly: true
  };
  const entries = Object.entries(tabs);
  const next = [];
  let inserted = false;
  for (const [key, value] of entries) {
    next.push([key, value]);
    if (key === 'scenes') {
      next.push([TAB_ID, descriptor]);
      inserted = true;
    }
  }
  if (!inserted) next.push([TAB_ID, descriptor]);
  SidebarClass.TABS = Object.fromEntries(next);
  return true;
}

function insertTabAfterScenes() {
  const sidebarClasses = [
    CONFIG?.ui?.sidebar,
    Sidebar
  ].filter((SidebarClass, index, classes) => (
    SidebarClass && classes.indexOf(SidebarClass) === index
  ));

  for (const SidebarClass of sidebarClasses) {
    insertLayerManagerTabIntoSidebar(SidebarClass);
  }
}

function restoreLayerManagerTileInteractivity({ source = 'unknown' } = {}) {
  if (!canvas?.ready || !canvas?.tiles) return;
  const hoverCleared = clearTileHover({ source, updateLegend: false });
  let blocksCleared = 0;
  let lockedEventModesReset = 0;
  for (const tile of collectTilePlaceables()) {
    const hadSelectionBlock = !!(tile?.[SELECTION_FILTER_BLOCK_KEY] || tile?.[TILE_EVENT_MODE_SELECTION_BLOCK_KEY]);
    if (hadSelectionBlock) {
      clearSelectionFilterInteractivityBlock(tile);
      blocksCleared += 1;
    }
    if (tile?.document?.locked && !selectionFilterState.active && !hasForcedTileEventModeBlock(tile)) {
      const expectedEventMode = tile?.isInteractable ? 'static' : 'none';
      if (typeof tile.eventMode !== 'undefined' && tile.eventMode !== expectedEventMode) {
        try {
          tile.eventMode = expectedEventMode;
          lockedEventModesReset += 1;
        } catch (error) {
          Logger.error('LayerManager.selectionFilter.lockedEventModeResetFailed', {
            source,
            tileId: tile?.document?.id || tile?.id || null,
            expectedEventMode,
            error: String(error?.message || error)
          });
        }
      }
    }
    try { requestTileRefresh(tile); } catch (_) {}
  }
  try { refreshTileInteractionState(); } catch (_) {}
  try { getMouseInteractionManager()?.emulateMoveEvent?.(); } catch (_) {}
  if (hoverCleared || blocksCleared || lockedEventModesReset) {
    Logger.debug?.('LayerManager.selectionFilter.deactivateCleanup', {
      source,
      hoverCleared,
      blocksCleared,
      lockedEventModesReset
    });
  }
}

function registerLayerManagerTab() {
  try {
    insertTabAfterScenes();
    if (!CONFIG.ui[TAB_ID]) CONFIG.ui[TAB_ID] = LayerManagerTab;
    syncSelectionFilterFromSettings();
    ensureSelectionFilterRefreshHook();
    ensureTileReleaseAllPatch();
    ensureTileReleasePatch();
    ensureTileControlReleaseOthersPatch();
    ensureTileSelectionPatch();
    ensureTileSelectAllPatch();
    ensureTileForegroundSelectionPatch();
    ensureTileHoverSuppressionPatch();
    ensureCanvasHighlightSuppressionPatch();
    ensureLayerHiddenHooks();
  } catch (error) {
    Logger.warn('LayerManager.register.failed', { error: String(error?.message || error) });
  }
}

class LayerManagerHelpWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-layer-manager-help',
    tag: 'section',
    position: { width: 460, height: 'auto' },
    window: {
      title: 'Layer Manager Help',
      icon: 'fas fa-circle-question',
      minimizable: true,
      resizable: true
    },
    classes: ['fa-nexus-tool-help-window']
  };

  static PARTS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.PARTS ?? {}),
    {
      body: { template: 'modules/fa-nexus/templates/tool-help-modal.hbs' }
    },
    { inplace: false }
  );

  constructor({ owner = null, helpContext = {} } = {}) {
    super();
    this._owner = owner;
    this._helpContext = helpContext && typeof helpContext === 'object' ? helpContext : {};
  }

  setHelpContext(helpContext = {}, { suppressRender = false } = {}) {
    this._helpContext = helpContext && typeof helpContext === 'object' ? helpContext : {};
    if (this.rendered && !suppressRender) this.render(false);
  }

  _resolveWindowTitle() {
    const label = typeof this._helpContext?.toolLabel === 'string' ? this._helpContext.toolLabel.trim() : '';
    return label ? `${label} Help` : 'Layer Manager Help';
  }

  _syncWindowTitle() {
    const title = this._resolveWindowTitle();
    try {
      if (!this.options.window || typeof this.options.window !== 'object') this.options.window = {};
      this.options.window.title = title;
    } catch (_) {}
    try {
      const appWindow = this.window;
      if (appWindow) {
        if (typeof appWindow.setTitle === 'function') appWindow.setTitle(title);
        else appWindow.title = title;
      }
    } catch (_) {}
    try {
      const headerTitle = this.element?.querySelector('.window-title');
      if (headerTitle) headerTitle.textContent = title;
    } catch (_) {}
  }

  async _prepareContext() {
    const help = this._helpContext && typeof this._helpContext === 'object' ? this._helpContext : {};
    return {
      toolLabel: typeof help.toolLabel === 'string' ? help.toolLabel : '',
      summary: typeof help.summary === 'string' ? help.summary : '',
      selectionSummary: help.selectionSummary ?? null,
      dirty: !!help.dirty,
      sections: Array.isArray(help.sections) ? help.sections : [],
      shortcuts: Array.isArray(help.shortcuts) ? help.shortcuts : [],
      notes: Array.isArray(help.notes) ? help.notes : []
    };
  }

  _onRender(initial, ctx) {
    super._onRender(initial, ctx);
    this._syncWindowTitle();
  }

  _onClose(options = {}) {
    try { this._owner?._handleHelpWindowClosed?.(this); } catch (_) {}
    return super._onClose(options);
  }
}

export class LayerManagerTab extends HandlebarsApplicationMixin(AbstractSidebarTab) {
  static tabName = TAB_ID;

  static DEFAULT_OPTIONS = {
    id: TAB_ID,
    classes: ['fa-nexus-layer-manager'],
    actions: {}
  };

  static PARTS = {
    content: {
      template: 'modules/fa-nexus/templates/layer-manager-tab.hbs',
      scrollable: ['.fa-nexus-layer-manager__list']
    }
  };

  constructor(options = {}) {
    super(options);
    this._hookIds = [];
    this._lastClickedIndex = -1;
    this._lastClickedTileId = null;
    this._hoveredTileId = null;
    this._scrollQueued = false;
    this._scrollTargetId = null;
    this._scrollPreviewQueued = false;
    this._scrollPreviewTargetId = null;
    this._lastActivePreviewId = null;
    this._lastContextClick = { id: null, time: 0 };
    this._wheelSession = null;
    this._selectedSceneMarkers = new Set();
    this._lastElevationAnnounce = 0;
    this._elevationAnnounceTimer = null;
    this._pendingElevationAnnouncePoint = null;
    this._pendingElevationAnnounceMessage = null;
    this._renamingTileId = null;
    this._renameDraft = '';
    this._renameFocusPending = false;
    this._renameSubmitting = false;
    this._editingElevationGroupNameKey = null;
    this._editingElevationGroupNameDraft = '';
    this._editingElevationGroupNameFocusPending = false;
    this._editingElevationGroupElevationKey = null;
    this._editingElevationGroupElevationDraft = '';
    this._editingElevationGroupElevationFocusPending = false;
    this._editingElevationGroupSubmitting = false;
    this._elevationGroupMetadataSyncPending = false;
    this._viewState = null;
    this._dragState = null;
    this._dropIndicator = null;
    this._lastDropTarget = null;
    this._contextMenuCleanup = null;
    this._helpWindow = null;
    this._preservedListScrollTop = null;
    this._suppressPreviewAutoScrollOnce = false;
    this._searchFocusPending = false;
    this._searchSelectionStart = null;
    this._searchSelectionEnd = null;
    this._canvasSelectionSyncQueued = false;
    this._pendingCanvasSelectionSyncOptions = null;
  }

  get title() {
    return game.i18n.localize('FA-NEXUS.LayerManager');
  }

  _onActivate() {
    this._setActiveClass(true);
    this._setFilterActive(true);
    this._ensureHooks();
    this._startWheelSession();
    this._clearHover();
    this._activateTilesLayer();
    this.render({ force: true });
  }

  _onDeactivate() {
    this._setActiveClass(false);
    this._setFilterActive(false);
    this._closeContextMenu();
    this._clearHover();
    this._clearRenameState();
    this._clearElevationGroupEditState();
    this._clearDropIndicator();
    this._dragState = null;
    this._stopWheelSession();
    this._clearElevationAnnounceTimer();
    this._selectedSceneMarkers?.clear?.();
    if (!this.isPopout) this._removeHooks();
  }

  _onClose(options = {}) {
    this._closeContextMenu();
    this._clearHover();
    this._clearRenameState();
    this._clearElevationGroupEditState();
    this._clearDropIndicator();
    this._dragState = null;
    this._stopWheelSession();
    this._clearElevationAnnounceTimer();
    this._selectedSceneMarkers?.clear?.();
    this._removeHooks();
    return super._onClose(options);
  }

  async _prepareContext() {
    const { minRaw, maxRaw, skipLocked, skipHidden, skipFiltered, ignoreForeground } = getElevationRangeFromSettings();
    const sessionState = getLayerManagerSessionState();
    const parsedQuery = parseListSearchQuery(sessionState.searchQuery || '');
    const flattenState = this._getFlattenState();
    const elevationGroupMetadata = getSceneElevationGroupMetadata();
    const viewState = buildEntriesFromCanvas({ sessionState, parsedQuery, elevationGroupMetadata });
    if (selectionFilterState.skipFiltered) syncSelectionListFilterCache({ reason: 'prepare-context' });
    const entries = viewState.entries;
    this._viewState = viewState;
    if (viewState?.elevationGroupMetadataDirty) {
      this._queueElevationGroupMetadataSync(viewState.elevationGroupMetadata);
    }
    let renameFound = false;
    let groupNameEditFound = false;
    let groupElevationEditFound = false;
    for (const entry of entries) {
      if (entry?.separator && !entry?.levelBoundarySeparator) {
        if (entry.elevationKey === this._editingElevationGroupNameKey) {
          entry.editingGroupName = true;
          entry.groupNameValue = this._editingElevationGroupNameDraft;
          groupNameEditFound = true;
        }
        if (entry.elevationKey === this._editingElevationGroupElevationKey) {
          entry.editingGroupElevation = true;
          entry.groupElevationValue = this._editingElevationGroupElevationDraft || formatElevation(entry.elevationValue);
          groupElevationEditFound = true;
        }
      }
      if (!entry?.id || entry?.preview || entry?.marker || entry?.separator) continue;
      if (entry.id !== this._renamingTileId) continue;
      entry.editing = true;
      entry.renameValue = this._renameDraft;
      renameFound = true;
      break;
    }
    if (this._renamingTileId && !renameFound) {
      this._renamingTileId = null;
      this._renameDraft = '';
      this._renameFocusPending = false;
    }
    if (this._editingElevationGroupNameKey && !groupNameEditFound) {
      this._clearElevationGroupNameEditState();
    }
    if (this._editingElevationGroupElevationKey && !groupElevationEditFound) {
      this._clearElevationGroupElevationEditState();
    }
    if (this._selectedSceneMarkers?.size) {
      for (const entry of entries) {
        if (!entry?.marker) continue;
        entry.selected = this._selectedSceneMarkers.has(entry.markerId);
      }
    }
    const selectionActionState = this._getSelectionActionState();
    const matchingGroupKeys = this._getMatchingElevationGroupKeys(viewState);
    const collapsedMatchingGroupCount = matchingGroupKeys.filter((key) => sessionState?.collapsedElevations?.has?.(key)).length;
    return {
      canvasReady: !!canvas?.ready,
      elevationMin: minRaw,
      elevationMax: maxRaw,
      skipLocked,
      skipHidden,
      skipFiltered,
      ignoreForeground,
      selectionOptionsCollapsed: !!sessionState.selectionOptionsCollapsed,
      searchQuery: sessionState.searchQuery,
      filterChips: buildFilterChipContext(sessionState),
      resetFiltersDisabled: !listFiltersActive(sessionState),
      groupToggleAllAction: collapsedMatchingGroupCount === matchingGroupKeys.length ? 'expand' : 'collapse',
      groupToggleAllTitle: collapsedMatchingGroupCount === matchingGroupKeys.length ? 'Expand all visible groups' : 'Collapse all visible groups',
      groupToggleAllIcon: collapsedMatchingGroupCount === matchingGroupKeys.length ? 'fa-angles-down' : 'fa-angles-up',
      groupToggleAllDisabled: !matchingGroupKeys.length,
      selectionActionTitle: selectionActionState.lockTitle,
      selectionActionDisabled: selectionActionState.lockDisabled,
      deleteSelectionDisabled: selectionActionState.deleteDisabled,
      flattenVisible: flattenState.visible,
      flattenDisabled: flattenState.disabled,
      flattenLabel: flattenState.label,
      flattenAriaLabel: flattenState.ariaLabel,
      flattenAction: flattenState.action,
      flattenIconClass: flattenState.iconClass,
      entries
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this._setActiveClass(this.active);
    if (this.active || this.isPopout) this._ensureHooks();
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this._closeContextMenu();
    if (this.active || this.isPopout) this._ensureHooks();
    const root = this.element;
    if (!root) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    const searchInput = root.querySelector('input[data-action="search-layers"]');
    const resetFiltersButton = root.querySelector('button[data-action="reset-filters"]');
    const toggleAllGroupsButton = root.querySelector('button[data-action="toggle-all-groups"]');
    const selectionLockButton = root.querySelector('button[data-action="toggle-selection-lock"]');
    const selectionDeleteButton = root.querySelector('button[data-action="delete-selection"]');
    const minInput = root.querySelector('input[data-range="min"]');
    const maxInput = root.querySelector('input[data-range="max"]');
    const skipLockedInput = root.querySelector('input[data-action="skip-locked"]');
    const skipHiddenInput = root.querySelector('input[data-action="skip-hidden"]');
    const skipFilteredInput = root.querySelector('input[data-action="skip-filtered"]');
    const flattenButton = root.querySelector('button[data-action="flatten"]');
    const renameInput = root.querySelector('.fa-nexus-layer-manager__rename-input');
    const groupNameInput = root.querySelector('.fa-nexus-layer-manager__separator-group-name-input');
    const groupElevationInput = root.querySelector('.fa-nexus-layer-manager__separator-group-elevation-input');
    const selectionOptionsToggle = root.querySelector('button[data-action="toggle-selection-options"]');
    const helpButton = root.querySelector('button[data-action="open-help"]');

    if (selectionOptionsToggle) {
      selectionOptionsToggle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleSelectionOptions();
      });
    }

    if (helpButton) {
      helpButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._openLayerManagerHelp();
      });
    }

    if (list) {
      list.addEventListener('click', (event) => this._onListClick(event));
      list.addEventListener('dblclick', (event) => this._onListDoubleClick(event));
      list.addEventListener('contextmenu', (event) => this._onListContextMenu(event));
      list.addEventListener('mouseover', (event) => this._onListHover(event));
      list.addEventListener('mouseleave', () => this._clearHover());
      list.addEventListener('wheel', (event) => this._onListWheel(event), { passive: false });
      list.addEventListener('dragstart', (event) => this._onListDragStart(event));
      list.addEventListener('dragover', (event) => this._onListDragOver(event));
      list.addEventListener('dragleave', (event) => this._onListDragLeave(event));
      list.addEventListener('drop', (event) => this._onListDrop(event));
      list.addEventListener('dragend', (event) => this._onListDragEnd(event));
    }

    if (searchInput) {
      searchInput.addEventListener('input', (event) => this._onSearchInput(event));
    }

    if (resetFiltersButton) {
      resetFiltersButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._resetListFilters();
      });
    }

    if (toggleAllGroupsButton) {
      toggleAllGroupsButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleAllElevationGroups(toggleAllGroupsButton);
      });
    }

    for (const chipButton of root.querySelectorAll('button[data-action="toggle-filter-chip"]')) {
      chipButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleFilterChip(chipButton);
      });
    }

    if (selectionLockButton) {
      selectionLockButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleSelectionLock();
      });
    }

    if (selectionDeleteButton) {
      selectionDeleteButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._deleteSelection();
      });
    }

    if (minInput) {
      minInput.addEventListener('change', () => this._onRangeChange());
      minInput.addEventListener('input', () => this._onRangeChange(true));
    }

    if (maxInput) {
      maxInput.addEventListener('change', () => this._onRangeChange());
      maxInput.addEventListener('input', () => this._onRangeChange(true));
    }

    if (skipLockedInput) {
      skipLockedInput.addEventListener('change', () => this._onSkipLockedChange());
    }

    if (skipHiddenInput) {
      skipHiddenInput.addEventListener('change', () => this._onSkipHiddenChange());
    }

    if (skipFilteredInput) {
      skipFilteredInput.addEventListener('change', () => this._onSkipFilteredChange());
    }

    if (flattenButton) {
      if (flattenButton._faNexusFlattenHandler) {
        flattenButton.removeEventListener('click', flattenButton._faNexusFlattenHandler);
      }
      const handler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const manager = getTileFlattenManager();
        const state = this._getFlattenState();
        this._updateFlattenFooter();
        if (state.action === 'deconstruct') {
          const selection = TileFlattenManager.getSelectedTiles();
          const doc = Array.isArray(selection) ? selection[0] : null;
          if (!doc) return;
          manager.confirmAndDeconstructTile(doc).catch((error) => {
            Logger.warn('LayerManager.deconstruct.failed', { error: String(error?.message || error) });
            ui?.notifications?.error?.(`Failed to deconstruct tile: ${error?.message || error}`);
          }).finally(() => {
            this._updateFlattenFooter();
          });
          return;
        }
        if (state.action === 'export') {
          manager.showExportDialog().catch((error) => {
            Logger.warn('LayerManager.export.failed', { error: String(error?.message || error) });
            ui?.notifications?.error?.(`Failed to export scene: ${error?.message || error}`);
          }).finally(() => {
            this._updateFlattenFooter();
          });
          return;
        }
        manager.showFlattenDialog().catch((error) => {
          Logger.warn('LayerManager.flatten.failed', { error: String(error?.message || error) });
          ui?.notifications?.error?.(`Failed to flatten tiles: ${error?.message || error}`);
        }).finally(() => {
          this._updateFlattenFooter();
        });
      };
      flattenButton._faNexusFlattenHandler = handler;
      flattenButton.addEventListener('click', handler);
    }

    if (renameInput) {
      renameInput.addEventListener('click', (event) => event.stopPropagation());
      renameInput.addEventListener('dblclick', (event) => event.stopPropagation());
      renameInput.addEventListener('contextmenu', (event) => event.stopPropagation());
      renameInput.addEventListener('input', (event) => {
        this._renameDraft = event.currentTarget?.value ?? '';
      });
      renameInput.addEventListener('keydown', (event) => this._onRenameInputKeyDown(event));
      renameInput.addEventListener('blur', (event) => {
        this._commitRename(event.currentTarget).catch((error) => {
          Logger.warn('LayerManager.rename.failed', { error: String(error?.message || error) });
          ui?.notifications?.error?.(`Failed to rename tile: ${error?.message || error}`);
        });
      });
      if (this._renameFocusPending) {
        this._renameFocusPending = false;
        requestAnimationFrame(() => {
          try {
            renameInput.focus({ preventScroll: true });
            renameInput.select();
          } catch (_) {}
        });
      }
    }

    if (groupNameInput) {
      groupNameInput.addEventListener('click', (event) => event.stopPropagation());
      groupNameInput.addEventListener('dblclick', (event) => event.stopPropagation());
      groupNameInput.addEventListener('contextmenu', (event) => event.stopPropagation());
      groupNameInput.addEventListener('input', (event) => {
        this._editingElevationGroupNameDraft = event.currentTarget?.value ?? '';
      });
      groupNameInput.addEventListener('keydown', (event) => this._onElevationGroupNameInputKeyDown(event));
      groupNameInput.addEventListener('blur', (event) => {
        this._commitElevationGroupNameEdit(event.currentTarget).catch((error) => {
          Logger.error('LayerManager.elevationGroup.rename.failed', {
            elevationKey: this._editingElevationGroupNameKey || null,
            error: String(error?.message || error)
          });
          ui?.notifications?.error?.(`Failed to rename elevation group: ${error?.message || error}`);
        });
      });
      if (this._editingElevationGroupNameFocusPending) {
        this._editingElevationGroupNameFocusPending = false;
        requestAnimationFrame(() => {
          try {
            groupNameInput.focus({ preventScroll: true });
            groupNameInput.select();
          } catch (_) {}
        });
      }
    }

    if (groupElevationInput) {
      groupElevationInput.addEventListener('click', (event) => event.stopPropagation());
      groupElevationInput.addEventListener('dblclick', (event) => event.stopPropagation());
      groupElevationInput.addEventListener('contextmenu', (event) => event.stopPropagation());
      groupElevationInput.addEventListener('input', (event) => {
        this._editingElevationGroupElevationDraft = event.currentTarget?.value ?? '';
      });
      groupElevationInput.addEventListener('keydown', (event) => this._onElevationGroupElevationInputKeyDown(event));
      groupElevationInput.addEventListener('blur', (event) => {
        this._commitElevationGroupElevationEdit(event.currentTarget).catch((error) => {
          Logger.error('LayerManager.elevationGroup.move.failed', {
            elevationKey: this._editingElevationGroupElevationKey || null,
            error: String(error?.message || error)
          });
          ui?.notifications?.error?.(`Failed to move elevation group: ${error?.message || error}`);
        });
      });
      if (this._editingElevationGroupElevationFocusPending) {
        this._editingElevationGroupElevationFocusPending = false;
        requestAnimationFrame(() => {
          try {
            groupElevationInput.focus({ preventScroll: true });
            groupElevationInput.select();
          } catch (_) {}
        });
      }
    }

    if (searchInput && this._searchFocusPending) {
      this._searchFocusPending = false;
      const start = Number.isInteger(this._searchSelectionStart) ? this._searchSelectionStart : searchInput.value.length;
      const end = Number.isInteger(this._searchSelectionEnd) ? this._searchSelectionEnd : searchInput.value.length;
      try {
        searchInput.focus({ preventScroll: true });
        searchInput.setSelectionRange(start, end);
      } catch (_) {}
      this._searchSelectionStart = null;
      this._searchSelectionEnd = null;
    }

    this._updateSelectionActions();
    this._updateFlattenFooter();
    if (this._suppressPreviewAutoScrollOnce) this._suppressPreviewAutoScrollOnce = false;
    else this._syncPreviewScroll();
    this._restorePreservedListScrollTop();
    this._syncHelpWindow({ suppressRender: false });
  }

  _getFlattenState() {
    const selection = TileFlattenManager.getSelectedTiles();
    return buildLayerManagerFlattenState({
      selection,
      flattenManagerClass: TileFlattenManager,
      flattenManager: getTileFlattenManager(),
      canvasReady: !!canvas?.ready
    });
  }

  _updateFlattenFooter() {
    const root = this.element;
    if (!root) return;
    applyLayerManagerFlattenFooterState(root, this._getFlattenState());
  }

  _getSessionState() {
    return getLayerManagerSessionState();
  }

  _closeContextMenu() {
    const cleanup = this._contextMenuCleanup;
    this._contextMenuCleanup = null;
    if (!cleanup) return;
    try { cleanup(); } catch (_) {}
  }

  _showLayerContextMenu(event, items = []) {
    const menuItems = Array.isArray(items) ? items.filter((item) => item && item.label) : [];
    if (!menuItems.length) return;
    this._closeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'fa-nexus-layer-manager__context-menu';
    menu.setAttribute('role', 'menu');

    for (const item of menuItems) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fa-nexus-layer-manager__context-menu-item';
      button.setAttribute('role', 'menuitem');
      if (item.disabled) {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
      }
      if (item.title) button.title = item.title;

      const icon = document.createElement('i');
      icon.className = `${item.iconClass || 'fa-solid fa-circle'} fa-nexus-layer-manager__context-menu-item-icon`;
      icon.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'fa-nexus-layer-manager__context-menu-item-label';
      label.textContent = item.label;

      button.append(icon, label);
      button.addEventListener('click', async (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        if (button.disabled || typeof item.action !== 'function') return;
        this._closeContextMenu();
        try {
          await item.action();
        } catch (error) {
          Logger.error('LayerManager.contextMenu.action.failed', {
            label: item.label,
            error: String(error?.message || error)
          });
          ui?.notifications?.error?.(item.errorMessage || `Failed to ${String(item.label || 'run action').toLowerCase()}: ${error?.message || error}`);
        }
      });
      menu.appendChild(button);
    }

    const root = document.body || this.element;
    if (!root) return;
    root.appendChild(menu);

    const margin = 8;
    const clientX = Number(event?.clientX ?? 0) + 2;
    const clientY = Number(event?.clientY ?? 0) + 2;
    const maxLeft = Math.max(margin, (window.innerWidth || menu.offsetWidth || 0) - menu.offsetWidth - margin);
    const maxTop = Math.max(margin, (window.innerHeight || menu.offsetHeight || 0) - menu.offsetHeight - margin);
    menu.style.left = `${Math.min(Math.max(margin, clientX), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(margin, clientY), maxTop)}px`;

    const onPointerDown = (pointerEvent) => {
      if (menu.contains(pointerEvent?.target)) return;
      this._closeContextMenu();
    };
    const onContextMenu = (contextEvent) => {
      if (menu.contains(contextEvent?.target)) return;
      this._closeContextMenu();
    };
    const onKeyDown = (keyEvent) => {
      if (keyEvent?.key === 'Escape') this._closeContextMenu();
    };
    const onWindowChange = () => this._closeContextMenu();

    let listenersBound = false;
    const bindTimer = window.setTimeout(() => {
      listenersBound = true;
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', onWindowChange);
      window.addEventListener('blur', onWindowChange);
      window.addEventListener('scroll', onWindowChange, true);
    }, 0);

    const cleanup = () => {
      window.clearTimeout(bindTimer);
      try { menu.remove(); } catch (_) {}
      if (!listenersBound) return;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onWindowChange);
      window.removeEventListener('blur', onWindowChange);
      window.removeEventListener('scroll', onWindowChange, true);
    };

    this._contextMenuCleanup = cleanup;
  }

  _positionApplicationNearCursor(app, anchor = null, { offsetX = 14, offsetY = 10 } = {}) {
    const clientX = Number(anchor?.clientX);
    const clientY = Number(anchor?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || typeof app?.setPosition !== 'function') return;
    requestAnimationFrame(() => {
      const element = app?.element;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const margin = 12;
      const maxLeft = Math.max(margin, (window.innerWidth || rect.width || 0) - rect.width - margin);
      const maxTop = Math.max(margin, (window.innerHeight || rect.height || 0) - rect.height - margin);
      const left = Math.min(Math.max(margin, clientX + offsetX), maxLeft);
      const top = Math.min(Math.max(margin, clientY + offsetY), maxTop);
      try {
        app.setPosition({ left, top, width: rect.width, height: rect.height });
      } catch (error) {
        Logger.error('LayerManager.dialog.position.failed', {
          error: String(error?.message || error)
        });
      }
    });
  }

  _buildLayerManagerHelpContext() {
    const totalLayers = Number(this._viewState?.fullTileDocsById?.size ?? canvas?.scene?.tiles?.size ?? 0) || 0;
    const visibleLayers = Array.isArray(this._viewState?.entries)
      ? this._viewState.entries.filter((entry) => entry?.id && !entry?.separator && !entry?.preview && !entry?.marker).length
      : totalLayers;
    const selectedLayers = this._getSelectedTileDocs().length;
    return {
      toolLabel: 'Layer Manager',
      summary: 'Search, filter, rename, regroup, reorder, and batch-edit scene layers by elevation without leaving the sidebar.',
      selectionSummary: `${selectedLayers} selected | ${visibleLayers} visible | ${totalLayers} total`,
      dirty: false,
      sections: [
        { label: 'Search & Filters' },
        { label: 'Elevation Groups' },
        { label: 'Layer Rows' },
        { label: 'Context Menu' },
        { label: 'Flatten & Selection' }
      ],
      shortcuts: [
        { label: 'Help', binding: 'Click ?', description: 'Open layer manager help from the header.' },
        { label: 'Multi-select', binding: 'Ctrl/Cmd+Click', description: 'Add or remove a layer from the current selection.' },
        { label: 'Range Select', binding: 'Shift+Click', description: 'Select a contiguous range of visible layers.' },
        { label: 'Rename Layer', binding: 'F2', description: 'Rename the currently selected layer.' },
        { label: 'Rename Group', binding: 'Double Click', description: 'Rename an elevation group from its header.' },
        { label: 'Actions Menu', binding: 'Right Click', description: 'Open contextual actions for a layer or group.' },
        { label: 'Tile Sheet', binding: 'Double Right Click', description: 'Open the standard Foundry tile sheet for a layer row.' },
        { label: 'Reorder', binding: 'Drag', description: 'Drag layers onto rows or group headers to reorder or change elevation.' },
        { label: 'Elevation Wheel', binding: 'Alt+Wheel', description: 'Nudge selected layers or scene markers by 0.01; Shift uses 0.1 and Ctrl/Cmd uses 0.001.' },
        { label: 'Elevation Keys', binding: 'Alt+[ / ] or Alt+Up / Down', description: 'Adjust the current layer-manager selection without relying on the mouse wheel.' }
      ],
      notes: [
        'Right-click headers for rename, lock, move, and flatten actions on matching group layers.',
        'Collapsed elevation groups remember state per scene and auto-expand to reveal canvas selections.',
        'With active filters, group lock and flatten act on matching layers only, and group elevation moves are blocked.',
        'Quick elevation nudging uses 0.01 by default, 0.001 with Ctrl/Cmd, and 0.1 with Shift.'
      ]
    };
  }

  _openLayerManagerHelp({ focus = true } = {}) {
    const helpContext = this._buildLayerManagerHelpContext();
    if (!this._helpWindow) {
      this._helpWindow = new LayerManagerHelpWindow({ owner: this, helpContext });
    } else {
      this._helpWindow.setHelpContext(helpContext, { suppressRender: true });
    }
    if (!this._helpWindow.rendered) this._helpWindow.render(true);
    else this._helpWindow.render(false);
    if (focus) {
      try { this._helpWindow.bringToFront?.(); } catch (_) {}
    }
    return true;
  }

  _syncHelpWindow({ suppressRender = false } = {}) {
    if (!this._helpWindow) return;
    if (this._helpWindow.state === ApplicationV2.RENDER_STATES.CLOSING) return;
    this._helpWindow.setHelpContext(this._buildLayerManagerHelpContext(), { suppressRender });
    if (!this._helpWindow.rendered) this._helpWindow.render(true);
  }

  _handleHelpWindowClosed(instance) {
    if (this._helpWindow === instance) this._helpWindow = null;
  }

  _getTilePlaceable(tileId) {
    const id = String(tileId || '').trim();
    if (!id) return null;
    return resolveTilePlaceable(id);
  }

  _getContextMenuTileDocs(tileId) {
    return getLayerManagerContextMenuTileDocs({
      tileId,
      viewState: this._viewState,
      selectedDocs: this._getSelectedTileDocs(),
      resolveTileDocument: (id) => this._getTilePlaceable(id)?.document || null
    });
  }

  _getGroupContextMenuDocs(elevationKey) {
    return getLayerManagerGroupContextMenuDocs({
      elevationKey,
      getMatchingElevationDocs: (key) => this._getMatchingElevationDocs(key),
      orderDocsByIds: (ids) => this._getOrderedDocsByIds(ids)
    });
  }

  _triggerTileContextHighlight(tile, event = null) {
    if (!tile) return;
    this._activateTilesLayer();
    const stub = Object.assign({}, clickEventStub, {
      shiftKey: !!event?.shiftKey,
      ctrlKey: !!event?.ctrlKey,
      metaKey: !!event?.metaKey,
      altKey: !!event?.altKey,
      button: 2,
      preventDefault: () => {},
      stopPropagation: () => {},
      stopImmediatePropagation: () => {}
    });
    try { tile._onClickRight?.(stub); } catch (error) {
      Logger.error('LayerManager.contextMenu.highlight.failed', {
        tileId: tile?.document?.id || tile?.id || null,
        error: String(error?.message || error)
      });
    }
    this._syncSelectionFromCanvas();
  }

  _notifyLayerManagerActionError(action, error) {
    const key = String(action || 'action').replace(/[^a-zA-Z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'action';
    Logger.error(`LayerManager.${key}.failed`, {
      sceneId: canvas?.scene?.id || null,
      error: String(error?.message || error)
    });
    ui?.notifications?.error?.(`Failed to ${action}: ${error?.message || error}`);
  }

  _orderTileDocuments(docs = []) {
    const uniqueDocs = uniqueTileDocuments(docs);
    const ids = uniqueDocs.map((doc) => getTileDocumentId(doc)).filter(Boolean);
    if (!ids.length) return [];
    const orderedDocs = this._getOrderedDocsByIds(ids);
    return orderedDocs.length ? orderedDocs : uniqueDocs;
  }

  _preserveTileSelectionContextForNexus(docs = [], source = 'unknown') {
    const selectedDocs = uniqueTileDocuments(docs);
    if (!selectedDocs.length) return false;
    try {
      return preserveTileSelectionDocumentsForNexus(`LayerManager.${source}`, selectedDocs);
    } catch (error) {
      Logger.error('LayerManager.tileSelectionContext.preserveFailed', {
        sceneId: canvas?.scene?.id || null,
        source,
        tileIds: selectedDocs.map((doc) => getTileDocumentId(doc)).filter(Boolean),
        error: String(error?.message || error)
      });
      return false;
    }
  }

  _clearTileSelectionContextForNexus(source = 'unknown') {
    try {
      return clearNexusTileSelectionContext(`LayerManager.${source}`);
    } catch (error) {
      Logger.error('LayerManager.tileSelectionContext.clearFailed', {
        sceneId: canvas?.scene?.id || null,
        source,
        error: String(error?.message || error)
      });
      return false;
    }
  }

  _getSelectedTileDocIds() {
    return this._getSelectedTileDocs().map((doc) => getTileDocumentId(doc)).filter(Boolean);
  }

  _selectTileDocs(docs = [], {
    retainSelection = false,
    force = true,
    source = 'unknown',
    allowAutoExpand = true,
    allowScrollToTile = true
  } = {}) {
    const orderedDocs = this._orderTileDocuments(docs);
    if (!orderedDocs.length) return [];
    const intendedDocs = retainSelection
      ? this._orderTileDocuments([...this._getSelectedTileDocs(), ...orderedDocs])
      : orderedDocs;
    this._activateTilesLayer();
    if (!retainSelection) this._clearSceneMarkerSelection();
    this._setPendingCanvasSelectionSyncOptions({
      allowAutoExpand,
      allowScrollToTile
    });

    const selectedDocs = [];
    withBulkTileSelectionBatch(() => {
      if (!retainSelection) {
        try { canvas?.tiles?.releaseAll?.({ renderSidebar: false }); } catch (error) {
          Logger.error('LayerManager.selection.releaseAll.failed', {
            sceneId: canvas?.scene?.id || null,
            source,
            error: String(error?.message || error)
          });
          throw error;
        }
      }

      for (const doc of orderedDocs) {
        const tileId = getTileDocumentId(doc);
        const tile = this._getTilePlaceable(tileId);
        if (!tile) {
          Logger.debug('LayerManager.selection.missingPlaceable', {
            sceneId: canvas?.scene?.id || null,
            source,
            tileId
          });
          continue;
        }
        try {
          tile.control({ releaseOthers: false, renderSidebar: false, force });
          if (tile.controlled && tile.document) selectedDocs.push(tile.document);
        } catch (error) {
          Logger.error('LayerManager.selection.control.failed', {
            sceneId: canvas?.scene?.id || null,
            source,
            tileId,
            force,
            error: String(error?.message || error)
          });
          throw error;
        }
      }

      renderTileSelectionSidebar();
    });

    this._syncSelectionFromCanvas(null, null, {
      allowAutoExpand,
      allowScrollToTile
    });
    this._queueSelectionSyncFromCanvas({
      allowAutoExpand,
      allowScrollToTile
    });
    const currentSelectedDocs = this._getSelectedTileDocs();
    const currentSelectedIds = new Set(currentSelectedDocs.map((doc) => getTileDocumentId(doc)).filter(Boolean));
    const lockedIntendedDocs = intendedDocs.filter((doc) => {
      const id = getTileDocumentId(doc);
      return id && !!doc?.locked && !currentSelectedIds.has(id);
    });
    const preservedDocs = uniqueTileDocuments([...currentSelectedDocs, ...lockedIntendedDocs]);
    if (preservedDocs.length) {
      this._preserveTileSelectionContextForNexus(preservedDocs, `selection:${source}`);
    }
    if (lockedIntendedDocs.length) {
      Logger.warn('LayerManager.selection.lockedContextPreserved', {
        sceneId: canvas?.scene?.id || null,
        source,
        tileIds: lockedIntendedDocs.map((doc) => getTileDocumentId(doc)).filter(Boolean)
      });
    }
    return selectedDocs;
  }

  _releaseTileDocs(docs = [], {
    source = 'unknown',
    allowAutoExpand = false,
    allowScrollToTile = false
  } = {}) {
    const orderedDocs = this._orderTileDocuments(docs);
    if (!orderedDocs.length) return [];
    this._activateTilesLayer();
    this._setPendingCanvasSelectionSyncOptions({
      allowAutoExpand,
      allowScrollToTile
    });

    const releasedDocs = [];
    withBulkTileSelectionBatch(() => {
      for (const doc of orderedDocs) {
        const tileId = getTileDocumentId(doc);
        const tile = this._getTilePlaceable(tileId);
        if (!tile) {
          Logger.debug('LayerManager.selection.release.missingPlaceable', {
            sceneId: canvas?.scene?.id || null,
            source,
            tileId
          });
          continue;
        }
        if (!tile.controlled) continue;
        try {
          tile.release({ renderSidebar: false });
          if (!tile.controlled && tile.document) releasedDocs.push(tile.document);
        } catch (error) {
          Logger.error('LayerManager.selection.release.failed', {
            sceneId: canvas?.scene?.id || null,
            source,
            tileId,
            error: String(error?.message || error)
          });
          throw error;
        }
      }
      renderTileSelectionSidebar();
    });

    this._syncSelectionFromCanvas(null, null, {
      allowAutoExpand,
      allowScrollToTile
    });
    this._queueSelectionSyncFromCanvas({
      allowAutoExpand,
      allowScrollToTile
    });
    const remainingDocs = this._getSelectedTileDocs();
    if (remainingDocs.length) {
      this._preserveTileSelectionContextForNexus(remainingDocs, `selection:${source}:remaining`);
    } else {
      this._clearTileSelectionContextForNexus(`selection:${source}:empty`);
    }
    return releasedDocs;
  }

  async _restoreSelectionAfterBulkTileUpdate(docIds = [], {
    source = 'unknown',
    allowAutoExpand = true,
    allowScrollToTile = true
  } = {}) {
    const ids = Array.from(new Set((Array.isArray(docIds) ? docIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)));
    if (!ids.length) return [];
    let preservedRestoreContext = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const docs = ids.map((id) => canvas?.scene?.tiles?.get?.(id) || null).filter(Boolean);
      if (docs.length) {
        if (!preservedRestoreContext) {
          this._preserveTileSelectionContextForNexus(docs, `bulkRestore:${source}`);
          preservedRestoreContext = true;
        }
        const selectedDocs = this._selectTileDocs(docs, {
          retainSelection: false,
          force: true,
          source,
          allowAutoExpand,
          allowScrollToTile
        });
        if (selectedDocs.length) {
          await waitForUiFrame(240);
          const controlledIds = new Set((Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : [])
            .map((tile) => tile?.document?.id || tile?.id)
            .filter(Boolean));
          const missingIds = ids.filter((id) => !controlledIds.has(id));
          if (!missingIds.length) return selectedDocs;
          Logger.info('LayerManager.bulk.selectionRestore.retryAfterRefresh', {
            sceneId: canvas?.scene?.id || null,
            source,
            missingCount: missingIds.length,
            tileCount: ids.length
          });
          const retryDocs = ids.map((id) => canvas?.scene?.tiles?.get?.(id) || null).filter(Boolean);
          const retrySelectedDocs = this._selectTileDocs(retryDocs, {
            retainSelection: false,
            force: true,
            source: `${source}:delayed`,
            allowAutoExpand,
            allowScrollToTile
          });
          if (retrySelectedDocs.length) return retrySelectedDocs;
        }
      }
      await waitForUiFrame(80);
    }
    Logger.warn('LayerManager.bulk.selectionRestoreIncomplete', {
      sceneId: canvas?.scene?.id || null,
      source,
      tileIds: ids
    });
    return [];
  }

  async _toggleDocsVisibility(docs = [], {
    source = 'unknown',
    nextHidden = null,
    referenceDoc = null
  } = {}) {
    const orderedDocs = this._orderTileDocuments(docs);
    if (!orderedDocs.length) return [];
    if (!canvas?.scene?.updateEmbeddedDocuments) throw new Error('No active scene available for layer visibility updates.');
    const targets = requireMutableTileDocuments(orderedDocs, {
      user: game?.user,
      action: 'change visibility for'
    });
    if (!targets.length) return [];
    const selectedIds = this._getSelectedTileDocIds();
    if (selectedIds.length) {
      this._preserveTileSelectionContextForNexus(
        this._getOrderedDocsByIds(selectedIds),
        `visibility:${source}:selected`
      );
    }
    const referenceId = getTileDocumentId(referenceDoc);
    const targetReference = referenceId
      ? targets.find((target) => getTileDocumentId(target) === referenceId) || null
      : null;
    const resolvedNextHidden = typeof nextHidden === 'boolean'
      ? nextHidden
      : (targetReference ? !isLayerHidden(targetReference) : !targets.every((target) => isLayerHidden(target)));
    const updates = targets
      .filter((doc) => isLayerHidden(doc) !== resolvedNextHidden)
      .map((doc) => buildLayerHiddenUpdate(doc, resolvedNextHidden))
      .filter(Boolean);

    if (updates.length) {
      this._preserveListScrollTop(this._captureListScrollTop());
      bulkLayerDocumentUpdateState.depth += 1;
      try {
        await canvas.scene.updateEmbeddedDocuments('Tile', updates);
      } finally {
        bulkLayerDocumentUpdateState.depth = Math.max(0, bulkLayerDocumentUpdateState.depth - 1);
        if (bulkLayerDocumentUpdateState.renderPending) {
          bulkLayerDocumentUpdateState.renderPending = false;
          this._scheduleRender();
        }
      }
    }
    Logger.info('LayerManager.bulk.visibility.commit', {
      sceneId: canvas?.scene?.id || null,
      source,
      tileCount: targets.length,
      updateCount: updates.length,
      hidden: resolvedNextHidden
    });
    await this._restoreSelectionAfterBulkTileUpdate(selectedIds, {
      source: `visibility:${source}`,
      allowAutoExpand: false,
      allowScrollToTile: false
    });
    this._updateSelectionActions();
    this._updateFlattenFooter();
    return targets;
  }

  async _toggleDocsLock(docs = [], { source = 'contextMenu' } = {}) {
    const orderedDocs = this._orderTileDocuments(docs);
    if (!orderedDocs.length) return [];
    if (!canvas?.scene?.updateEmbeddedDocuments) throw new Error('No active scene available for layer lock updates.');
    const targets = requireMutableTileDocuments(orderedDocs, {
      user: game?.user,
      action: 'lock'
    });
    if (!targets.length) return [];
    const selectedIds = this._getSelectedTileDocIds();
    if (selectedIds.length) {
      this._preserveTileSelectionContextForNexus(
        this._getOrderedDocsByIds(selectedIds),
        `lock:${source}:selected`
      );
    }
    const allLocked = targets.every((doc) => !!doc?.locked);
    const nextLocked = !allLocked;
    const updates = targets
      .filter((doc) => !!doc?.locked !== nextLocked)
      .map((doc) => buildLayerLockUpdate(doc, nextLocked))
      .filter(Boolean);

    if (updates.length) {
      this._preserveListScrollTop(this._captureListScrollTop());
      bulkLayerDocumentUpdateState.depth += 1;
      try {
        await canvas.scene.updateEmbeddedDocuments('Tile', updates);
      } finally {
        bulkLayerDocumentUpdateState.depth = Math.max(0, bulkLayerDocumentUpdateState.depth - 1);
        if (bulkLayerDocumentUpdateState.renderPending) {
          bulkLayerDocumentUpdateState.renderPending = false;
          this._scheduleRender();
        }
      }
    }
    Logger.info('LayerManager.bulk.lock.commit', {
      sceneId: canvas?.scene?.id || null,
      source,
      tileCount: targets.length,
      updateCount: updates.length,
      locked: nextLocked
    });
    await this._restoreSelectionAfterBulkTileUpdate(selectedIds, { source: `lock:${source}` });
    this._updateSelectionActions();
    this._updateFlattenFooter();
    return targets;
  }

  async _flattenDocs(docs = []) {
    await flattenContextMenuDocs({
      docs,
      orderDocsByIds: (ids) => this._getOrderedDocsByIds(ids),
      flattenManager: getTileFlattenManager(),
      selectTileDocs: (orderedDocs) => this._selectTileDocs(orderedDocs),
      updateFlattenFooter: () => this._updateFlattenFooter()
    });
  }

  async _deconstructDoc(doc) {
    await deconstructContextMenuDoc({
      doc,
      flattenManager: getTileFlattenManager(),
      updateFlattenFooter: () => this._updateFlattenFooter()
    });
  }

  _buildFlattenContextMenuItem(docs = []) {
    return buildLayerManagerFlattenContextMenuItem({
      docs,
      orderDocsByIds: (ids) => this._getOrderedDocsByIds(ids),
      flattenManager: getTileFlattenManager(),
      onFlatten: (orderedDocs) => this._flattenDocs(orderedDocs),
      onDeconstruct: (doc) => this._deconstructDoc(doc)
    });
  }

  async _openNexusTileEditor(doc) {
    await openContextMenuNexusTileEditor(doc);
  }

  async _openTileMaskEditor(doc) {
    if (!doc) throw new Error('Tile document not available.');
    Logger.info('LayerManager.contextMenu.maskEditor.begin', {
      sceneId: canvas?.scene?.id || null,
      tileId: doc?.id || null,
      hasMask: hasTileMask(doc)
    });
    await openFaNexusTileMaskEditor(doc, { source: 'layer-manager-context-menu' });
  }

  async _clearTileMasks(docs = []) {
    const orderedDocs = this._getOrderedDocsByIds(docs.map((doc) => doc?.id).filter(Boolean))
      .filter((doc) => doc && hasTileMask(doc));
    if (!orderedDocs.length) return;
    Logger.info('LayerManager.contextMenu.clearMask.begin', {
      sceneId: canvas?.scene?.id || null,
      tileCount: orderedDocs.length
    });
    for (const doc of orderedDocs) {
      await clearStandardTileMask(doc, { reason: 'layer-manager-context-menu' });
    }
    ui?.notifications?.info?.(`Cleared tile mask${orderedDocs.length === 1 ? '' : 's'}.`);
    this._syncSelectionFromCanvas();
  }

  async _promptDocsElevationChange(docs = [], anchor = null) {
    await promptLayerManagerDocsElevationChange({
      docs,
      anchor,
      orderDocsByIds: (ids) => this._getOrderedDocsByIds(ids),
      user: game?.user,
      formatElevation,
      parseElevationInput,
      positionApplicationNearCursor: (dialog, dialogAnchor) => this._positionApplicationNearCursor(dialog, dialogAnchor),
      applyDocsElevationChange: (orderedDocs, targetElevation) => this._applyDocsElevationChange(orderedDocs, targetElevation)
    });
  }

  _resolveTileElevationMove(doc, requestedElevation) {
    return resolveLayerManagerTileElevationMove({
      doc,
      requestedElevation,
      quantizeElevation
    });
  }

  async _restoreSelectionAfterElevationMove(docIds = [], { source = 'unknown' } = {}) {
    return restoreLayerManagerSelectionAfterElevationMove({
      docIds,
      source,
      scene: canvas?.scene,
      waitForUiFrame,
      selectTileDocs: (docs) => this._selectTileDocs(docs)
    });
  }

  async _applyDocsElevationChange(docs = [], targetElevation) {
    await applyLayerManagerDocsElevationChange({
      docs,
      targetElevation,
      orderDocsByIds: (ids) => this._getOrderedDocsByIds(ids),
      user: game?.user,
      scene: canvas?.scene,
      quantizeElevation,
      elevationGroupKey,
      computeNextSortAtElevation,
      getSceneElevationGroupMetadata,
      mergeElevationGroupMetadataOnBulkMove,
      setSceneElevationGroupMetadata,
      getFullElevationDocs: (key) => this._getFullElevationDocs(key),
      resolveTileElevationMove: ({ doc, requestedElevation }) => this._resolveTileElevationMove(doc, requestedElevation),
      restoreSelectionAfterElevationMove: (docIds, options) => this._restoreSelectionAfterElevationMove(docIds, options)
    });
  }

  _getSelectedTileDocs({ visibleOnly = false } = {}) {
    return getLayerManagerSelectedTileDocs({
      root: this.element,
      viewState: this._viewState,
      visibleOnly,
      controlledTiles: canvas?.tiles?.controlled
    });
  }

  _getSelectionActionState() {
    return buildLayerManagerSelectionActionState(this._getSelectedTileDocs(), { user: game?.user });
  }

  _updateSelectionActions() {
    const root = this.element;
    if (!root) return;
    applyLayerManagerSelectionActionState(root, this._getSelectionActionState());
  }

  async _toggleSelectionLock() {
    try {
      await this._toggleDocsLock(this._getSelectedTileDocs(), { source: 'selectionToolbar' });
    } catch (error) {
      this._notifyLayerManagerActionError('toggle selected layer lock', error);
    }
  }

  async _deleteSelection() {
    await deleteSelectedDocs({
      docs: this._getSelectedTileDocs(),
      user: game?.user,
      deleteEmbeddedDocuments: canvas?.scene?.deleteEmbeddedDocuments?.bind(canvas.scene),
      onSelectionActionsUpdated: () => this._updateSelectionActions()
    });
  }

  _onSearchInput(event) {
    const state = this._getSessionState();
    state.searchQuery = String(event?.currentTarget?.value ?? '');
    this._searchFocusPending = true;
    this._searchSelectionStart = event?.currentTarget?.selectionStart ?? null;
    this._searchSelectionEnd = event?.currentTarget?.selectionEnd ?? null;
    this._handleSelectionListFilterStateChange('search-input');
    this._scheduleRender();
  }

  _toggleFilterChip(buttonEl) {
    const state = this._getSessionState();
    const kind = String(buttonEl?.dataset?.filterKind || '').trim();
    const key = String(buttonEl?.dataset?.filterKey || '').trim();
    if (!kind || !key) return;
    if (kind === 'type') {
      if (state.typeFilters.has(key)) state.typeFilters.delete(key);
      else state.typeFilters.add(key);
    } else if (kind === 'flag' && Object.prototype.hasOwnProperty.call(state.flagFilters, key)) {
      state.flagFilters[key] = !state.flagFilters[key];
    }
    this._handleSelectionListFilterStateChange('chip-toggle');
    this._scheduleRender();
  }

  _resetListFilters() {
    const state = this._getSessionState();
    state.searchQuery = '';
    state.typeFilters.clear();
    for (const key of LIST_FILTER_FLAG_KEYS) {
      state.flagFilters[key] = false;
    }
    this._searchFocusPending = false;
    this._searchSelectionStart = null;
    this._searchSelectionEnd = null;
    this._handleSelectionListFilterStateChange('filters-reset');
    this._scheduleRender();
  }

  _toggleSelectionOptions() {
    const state = this._getSessionState();
    state.selectionOptionsCollapsed = !state.selectionOptionsCollapsed;
    this._scheduleRender();
  }

  _getMatchingElevationGroupKeys(viewState = this._viewState) {
    return getLayerManagerMatchingElevationGroupKeys(viewState || this._viewState);
  }

  _setMatchingElevationGroupsCollapsed(collapsed) {
    const { changed, matchingGroupKeys } = setLayerManagerMatchingElevationGroupsCollapsed({
      viewState: this._viewState,
      sessionState: this._getSessionState(),
      collapsed,
      persistCollapsedState: queuePersistLayerManagerCollapsedState
    });
    if (!changed) return;
    Logger.info(collapsed ? 'LayerManager.elevationGroup.collapseAll' : 'LayerManager.elevationGroup.expandAll', {
      sceneId: canvas?.scene?.id || null,
      groupCount: matchingGroupKeys.length,
      filtersApplied: !!this._viewState?.filtersApplied
    });
    this._scheduleRender();
  }

  _collapseAllElevationGroups() {
    this._setMatchingElevationGroupsCollapsed(true);
  }

  _expandAllElevationGroups() {
    this._setMatchingElevationGroupsCollapsed(false);
  }

  _toggleAllElevationGroups(buttonEl = null) {
    const action = String(buttonEl?.dataset?.groupToggleAllAction || '').trim();
    if (action === 'expand') this._expandAllElevationGroups();
    else this._collapseAllElevationGroups();
  }

  _toggleElevationCollapse(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const key = String(buttonEl?.dataset?.elevationKey || separator?.dataset?.elevationKey || '').trim();
    if (!key) return;
    toggleLayerManagerElevationGroupCollapsed({
      sessionState: this._getSessionState(),
      elevationKey: key,
      persistCollapsedState: queuePersistLayerManagerCollapsedState
    });
    this._scheduleRender();
  }

  _expandElevationGroupsForDocs(docs = []) {
    const { changed, keysToExpand } = expandLayerManagerElevationGroupsForDocs({
      docs,
      viewState: this._viewState,
      sessionState: this._getSessionState(),
      elevationGroupKey,
      resolveDocumentGroupKey: (doc) => this._resolveDisplayElevationKeyForDoc(doc),
      persistCollapsedState: queuePersistLayerManagerCollapsedState
    });
    if (changed) {
      Logger.info('LayerManager.selection.autoExpand', {
        sceneId: canvas?.scene?.id || null,
        groupCount: keysToExpand.length,
        elevationKeys: keysToExpand
      });
    }
    return changed;
  }

  _getMatchingElevationDocs(elevationKey) {
    return getLayerManagerMatchingElevationDocs(this._viewState, elevationKey, {
      resolveDocumentById: (id) => canvas?.scene?.tiles?.get?.(id) || null
    });
  }

  _getFullElevationDocs(elevationKey) {
    return getLayerManagerFullElevationDocs(this._viewState, elevationKey);
  }

  _getFullGroupNode(elevationKey) {
    return getLayerManagerFullGroupNode(this._viewState, elevationKey);
  }

  _getMatchingGroupNode(elevationKey) {
    return getLayerManagerMatchingGroupNode(this._viewState, elevationKey);
  }

  _resolveDisplayElevationKeyForDoc(doc = null) {
    const id = String(doc?.id || doc?._id || '').trim();
    if (!id) return '';
    return String(this._viewState?.fullTileGroupKeyById?.get?.(id) || '').trim();
  }

  _resolveGroupElevation(groupKey = '') {
    const key = String(groupKey || '').trim();
    if (!key) return null;
    const fullNode = this._getFullGroupNode(key);
    if (Number.isFinite(fullNode?.elevation)) return Number(fullNode.elevation);
    const exactElevation = Number(this._viewState?.fullExactGroupElevationsByKey?.get?.(key));
    if (Number.isFinite(exactElevation)) return exactElevation;
    const parsed = parseElevationInput(key);
    return Number.isFinite(parsed) ? parsed : null;
  }

  _usesNestedGrouping() {
    return usesNestedLayerManagerGrouping(this._viewState);
  }

  _queueElevationGroupMetadataSync(metadata) {
    if (this._elevationGroupMetadataSyncPending) return;
    const scene = canvas?.scene;
    if (!scene) return;
    this._elevationGroupMetadataSyncPending = true;
    Promise.resolve()
      .then(() => setSceneElevationGroupMetadata(scene, metadata))
      .catch((error) => {
        Logger.error('LayerManager.elevationGroups.sync.failed', {
          sceneId: scene.id || null,
          error: String(error?.message || error)
        });
      })
      .finally(() => {
        this._elevationGroupMetadataSyncPending = false;
      });
  }

  _collectCompleteVisibleGroupMovesForDelta(movedDocIds, delta) {
    if (!(movedDocIds instanceof Set) || !movedDocIds.size || !Number.isFinite(delta) || !this._usesNestedGrouping()) return [];
    const nodes = this._viewState?.fullGroupHierarchy?.nodesByKey;
    if (!(nodes instanceof Map) || !nodes.size) return [];
    const moves = [];
    for (const node of nodes.values()) {
      if (node?.canEditElevation === false || isSyntheticDisplayGroupKey(node?.key)) continue;
      const fullIds = Array.isArray(node?.fullSubtreeDocs)
        ? node.fullSubtreeDocs.map((doc) => doc?.id).filter(Boolean)
        : [];
      if (!fullIds.length) continue;
      if (!fullIds.every((id) => movedDocIds.has(id))) continue;
      const targetKey = elevationGroupKey((Number(node?.elevation ?? 0) || 0) + delta);
      if (!targetKey || targetKey === node.key) continue;
      moves.push({ sourceKey: node.key, targetKey });
    }
    return moves;
  }

  _resolveDraggedTileIds(originId) {
    return resolveLayerManagerDraggedTileIds({
      originId,
      visibleSelectedDocs: this._getSelectedTileDocs({ visibleOnly: true })
    });
  }

  _getOrderedDocsByIds(tileIds = []) {
    return getLayerManagerOrderedDocsByIds({
      tileIds,
      viewState: this._viewState,
      resolveDocumentById: (id) => canvas?.scene?.tiles?.get?.(id) || null
    });
  }

  _getPreviewEntryById(previewId = '') {
    const targetId = String(previewId || '').trim();
    if (!targetId) return null;
    return Array.isArray(this._viewState?.entries)
      ? this._viewState.entries.find((entry) => entry?.preview === true && String(entry?.previewId || '').trim() === targetId) || null
      : null;
  }

  _setDraggedRowState(tileIds = [], previewIds = []) {
    setLayerManagerDraggedRowState({
      root: this.element,
      tileIds,
      previewIds
    });
  }

  _clearDraggedRowState() {
    clearLayerManagerDraggedRowState({
      root: this.element
    });
  }

  _clearDropIndicator() {
    this._dropIndicator = clearLayerManagerDropIndicator({
      root: this.element
    });
  }

  _applyDropIndicator(target) {
    this._dropIndicator = applyLayerManagerDropIndicator({
      root: this.element,
      target,
      currentDropIndicator: this._dropIndicator
    });
  }

  _resolveDropTarget(event) {
    return resolveLayerManagerDropTarget({
      event,
      dragState: this._dragState
    });
  }

  _serializeDropTarget(target = null) {
    if (!target) return '';
    return JSON.stringify({
      kind: target.kind || null,
      rowId: target.rowId || null,
      previewId: target.previewId || null,
      elevationKey: target.elevationKey || null,
      placeBefore: target.placeBefore !== false
    });
  }

  _buildPreviewSortContext(sort, overrides = {}) {
    const resolvedSort = Number(sort);
    const nextSort = Number.isFinite(resolvedSort) ? resolvedSort : 0;
    const previewSort = Number.isFinite(Number(overrides?.previewSort))
      ? Number(overrides.previewSort)
      : nextSort;
    return {
      sort: nextSort,
      placementSorts: [nextSort],
      previewSort,
      previewSorts: [previewSort],
      strategy: overrides?.strategy || 'layer-manager-preview-drop',
      anchorTileId: overrides?.anchorTileId || null,
      anchorTileSort: Number.isFinite(Number(overrides?.anchorTileSort)) ? Number(overrides.anchorTileSort) : null,
      siblingUpdates: []
    };
  }

  _resolvePreviewDropSortContext(target, targetElevation = null) {
    if (target?.kind === 'row') {
      const docs = Array.isArray(this._viewState?.fullElevationGroups?.get?.(target.elevationKey))
        ? this._viewState.fullElevationGroups.get(target.elevationKey)
        : [];
      const targetId = String(target?.rowId || '').trim();
      const targetDoc = docs.find((doc) => String(doc?.id || '') === targetId) || canvas?.scene?.tiles?.get?.(targetId) || null;
      const targetSortResult = targetDoc
        ? normalizeTileDocumentSortForPlacement(targetDoc, {
          scene: canvas?.scene,
          source: 'layer-manager-preview-drop'
        })
        : null;
      const targetSort = Number(targetSortResult?.sort ?? targetDoc?.sort ?? NaN);
      if (!targetDoc || !Number.isFinite(targetSort)) {
        const fallbackSort = Number.isFinite(targetSort)
          ? targetSort
          : (Number.isFinite(targetElevation) ? computeNextSortAtElevation(targetElevation) : 0);
        return this._buildPreviewSortContext(fallbackSort, {
          strategy: 'layer-manager-preview-drop-missing-row',
          anchorTileId: targetId,
          anchorTileSort: targetSort
        });
      }
      const resolved = resolvePlacementSortAtElevation(targetElevation, {
        scene: canvas?.scene,
        anchorTileId: targetId,
        sortBefore: target.placeBefore !== true,
        count: 1
      });
      const nextSort = Number(resolved?.sort);
      if (Number.isFinite(nextSort) && nextSort !== targetSort) return resolved;
      const fallbackSort = targetSort + (target.placeBefore ? TILE_SORT_STEP : -TILE_SORT_STEP);
      return this._buildPreviewSortContext(fallbackSort, {
        previewSort: fallbackSort,
        strategy: 'layer-manager-preview-drop-adjacent-row',
        anchorTileId: targetId,
        anchorTileSort: targetSort
      });
    }
    if (target?.kind === 'preview') {
      const targetPreviewEntry = this._getPreviewEntryById(target?.previewId);
      const targetSort = Number(targetPreviewEntry?.placementSort ?? targetPreviewEntry?.sort ?? NaN);
      const targetPreviewSort = Number(targetPreviewEntry?.sort ?? targetPreviewEntry?.placementSort ?? NaN);
      if (Number.isFinite(targetSort)) {
        const offset = target.placeBefore ? TILE_SORT_STEP : -TILE_SORT_STEP;
        return this._buildPreviewSortContext(targetSort + offset, {
          previewSort: (Number.isFinite(targetPreviewSort) ? targetPreviewSort : targetSort) + offset,
          strategy: 'layer-manager-preview-drop-preview'
        });
      }
    }
    const fallbackSort = Number.isFinite(targetElevation) ? computeNextSortAtElevation(targetElevation) : 0;
    return this._buildPreviewSortContext(fallbackSort, {
      strategy: 'layer-manager-preview-drop-top'
    });
  }

  _captureListScrollTop() {
    const list = this.element?.querySelector?.('.fa-nexus-layer-manager__list') || null;
    const scrollTop = Number(list?.scrollTop);
    return Number.isFinite(scrollTop) ? scrollTop : null;
  }

  _preserveListScrollTop(scrollTop = null) {
    const numeric = Number(scrollTop);
    if (!Number.isFinite(numeric)) return;
    this._preservedListScrollTop = numeric;
    this._suppressPreviewAutoScrollOnce = true;
  }

  _restorePreservedListScrollTop() {
    const scrollTop = Number(this._preservedListScrollTop);
    this._preservedListScrollTop = null;
    if (!Number.isFinite(scrollTop)) return false;
    const list = this.element?.querySelector?.('.fa-nexus-layer-manager__list') || null;
    if (!list) return false;
    try { list.scrollTop = scrollTop; } catch (_) { return false; }
    return true;
  }

  _onListDragStart(event) {
    if (event?.target?.closest?.('.fa-nexus-layer-manager__rename-input')) {
      event.preventDefault();
      return;
    }
    const previewRow = event?.target?.closest?.('[data-preview-id]');
    const previewId = String(previewRow?.dataset?.previewId || '').trim();
    if (previewId) {
      const previewEntry = this._getPreviewEntryById(previewId);
      const previewKind = String(previewEntry?.previewKind || previewRow?.dataset?.previewKind || '').trim();
      if (!previewEntry?.preview || previewEntry?.canDragPreview === false || !previewKind) {
        event.preventDefault();
        return;
      }
      try {
        if (event?.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', previewId);
        }
      } catch (_) {}
      this._dragState = {
        previewId,
        previewKind
      };
      this._lastActivePreviewId = previewId;
      this._lastDropTarget = null;
      this._setDraggedRowState([], [previewId]);
      this._clearDropIndicator();
      return;
    }
    const row = event?.target?.closest?.('[data-tile-id]');
    const originId = String(row?.dataset?.tileId || '').trim();
    if (!originId) {
      event.preventDefault();
      return;
    }
    this._dragState = prepareLayerManagerListDragStart({
      event,
      originId,
      orderedDocs: this._getOrderedDocsByIds(this._resolveDraggedTileIds(originId)),
      user: game?.user,
      setDraggedRowState: (tileIds) => this._setDraggedRowState(tileIds),
      clearDropIndicator: () => this._clearDropIndicator()
    });
    this._lastDropTarget = null;
  }

  _onListDragOver(event) {
    const target = handleLayerManagerListDragOver({
      event,
      dragState: this._dragState,
      resolveDropTarget: (dragEvent) => this._resolveDropTarget(dragEvent),
      applyDropIndicator: (target) => this._applyDropIndicator(target),
      clearDropIndicator: () => this._clearDropIndicator(),
      preserveIndicatorOnMiss: true
    });
    if (target) this._lastDropTarget = target;
  }

  _onListDragLeave(event) {
    if (shouldIgnoreListDragLeave({
      currentTarget: event?.currentTarget,
      relatedTarget: event?.relatedTarget
    })) return;
    this._lastDropTarget = null;
    this._clearDropIndicator();
  }

  async _onListDrop(event) {
    const hasTileDrag = !!this._dragState?.tileIds?.length;
    const hasPreviewDrag = !!String(this._dragState?.previewId || '').trim();
    if (!hasTileDrag && !hasPreviewDrag) return;
    event.preventDefault();
    const indicatedTarget = this._lastDropTarget || null;
    const resolvedTarget = this._resolveDropTarget(event) || null;
    if (
      indicatedTarget
      && resolvedTarget
      && this._serializeDropTarget(indicatedTarget) !== this._serializeDropTarget(resolvedTarget)
    ) {
      Logger.warn('LayerManager.dropTarget.resolvedDifferentFromIndicator', {
        indicated: this._serializeDropTarget(indicatedTarget),
        resolved: this._serializeDropTarget(resolvedTarget),
        dragKind: hasTileDrag ? 'tile' : 'preview'
      });
    }
    const target = indicatedTarget || resolvedTarget;
    try {
      if (target) {
        if (hasTileDrag) await this._applyDropReorder(target);
        else await this._applyPreviewDropReorder(target);
      }
    } finally {
      this._clearDropIndicator();
      this._clearDraggedRowState();
      this._lastDropTarget = null;
      this._dragState = null;
    }
  }

  _onListDragEnd() {
    this._clearDropIndicator();
    this._clearDraggedRowState();
    this._lastDropTarget = null;
    this._dragState = null;
  }

  async _applyDropReorder(target) {
    this._preserveListScrollTop(this._captureListScrollTop());
    const previewAnchors = this._capturePreviewAnchorsForTileDrop(target);
    await applyLayerManagerDropReorder({
      target,
      dragState: this._dragState,
      viewState: this._viewState,
      user: game?.user,
      updateEmbeddedDocuments: canvas?.scene?.updateEmbeddedDocuments?.bind(canvas.scene),
      elevationGroupKey,
      resolveGroupElevation: (key) => this._resolveGroupElevation(key),
      resolveDisplayElevationKey: (doc) => this._resolveDisplayElevationKeyForDoc(doc),
      resolveDocumentById: (id) => canvas?.scene?.tiles?.get?.(id) || null
    });
    await this._applyPreviewAnchorsAfterTileDrop(previewAnchors);
  }

  _capturePreviewAnchorsForTileDrop(target) {
    const movingIds = new Set((Array.isArray(this._dragState?.tileIds) ? this._dragState.tileIds : []).filter(Boolean));
    const entries = Array.isArray(this._viewState?.entries) ? this._viewState.entries : [];
    const targetElevationKey = String(target?.elevationKey || '').trim();
    if (!movingIds.size || !targetElevationKey || !entries.length) return [];

    const affectedKeys = new Set([targetElevationKey]);
    for (const id of movingIds) {
      const sourceKey = String(this._viewState?.fullTileGroupKeyById?.get?.(id) || '').trim();
      if (sourceKey) affectedKeys.add(sourceKey);
    }

    const anchors = [];
    for (const elevationKey of affectedKeys) {
      const groupEntries = entries.filter((entry) => String(entry?.elevationKey || '').trim() === elevationKey);
      for (let index = 0; index < groupEntries.length; index += 1) {
        const previewEntry = groupEntries[index];
        if (previewEntry?.preview !== true) continue;
        const previewId = String(previewEntry?.previewId || '').trim();
        const previewKind = String(previewEntry?.previewKind || '').trim();
        if (!previewId || !previewKind) continue;

        let previousTile = null;
        for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
          const candidate = groupEntries[previousIndex];
          const candidateId = String(candidate?.id || '').trim();
          if (!candidateId || candidate?.preview || candidate?.separator || candidate?.marker) continue;
          if (movingIds.has(candidateId)) continue;
          previousTile = candidate;
          break;
        }

        let nextTile = null;
        for (let nextIndex = index + 1; nextIndex < groupEntries.length; nextIndex += 1) {
          const candidate = groupEntries[nextIndex];
          const candidateId = String(candidate?.id || '').trim();
          if (!candidateId || candidate?.preview || candidate?.separator || candidate?.marker) continue;
          if (movingIds.has(candidateId)) continue;
          nextTile = candidate;
          break;
        }

        const anchorTile = previousTile || nextTile;
        const anchorTileId = String(anchorTile?.id || '').trim();
        if (!anchorTileId) {
          Logger.debug('LayerManager.tileDrop.previewAnchor.skip', {
            previewId,
            previewKind,
            elevationKey,
            reason: 'no-stable-neighbor',
            movingIds: Array.from(movingIds)
          });
          continue;
        }

        anchors.push({
          previewId,
          previewKind,
          previewKey: previewEntry.previewKey || null,
          elevationKey,
          elevation: Number(previewEntry?.documentElevation ?? previewEntry?.groupElevation ?? previewEntry?.elevation ?? NaN),
          placementLevelId: previewEntry?.placementLevelId ?? resolveSyntheticTargetPlacementLevelId(elevationKey),
          anchorTileId,
          placeBefore: !previousTile
        });
      }
    }
    return anchors;
  }

  async _applyPreviewAnchorsAfterTileDrop(anchors = []) {
    if (!Array.isArray(anchors) || !anchors.length) return;
    for (const anchor of anchors) {
      const previewId = String(anchor?.previewId || '').trim();
      const previewKind = String(anchor?.previewKind || '').trim();
      const anchorTileId = String(anchor?.anchorTileId || '').trim();
      const targetElevationKey = String(anchor?.elevationKey || '').trim();
      if (!previewId || !previewKind || !anchorTileId || !targetElevationKey) continue;

      const rawTargetElevation = this._resolveGroupElevation(targetElevationKey);
      const targetElevation = rawTargetElevation == null ? NaN : Number(rawTargetElevation);
      if (!Number.isFinite(targetElevation)) {
        Logger.warn('LayerManager.tileDrop.previewAnchor.missingElevation', {
          previewId,
          previewKind,
          targetElevationKey,
          anchorTileId,
          sceneId: canvas?.scene?.id || null
        });
        continue;
      }

      const controller = resolvePreviewSessionController(previewKind);
      if (!controller || typeof controller.applyLayerManagerPreviewPlacement !== 'function') {
        Logger.warn('LayerManager.tileDrop.previewAnchor.controllerUnavailable', {
          previewId,
          previewKind,
          targetElevation,
          targetElevationKey,
          anchorTileId,
          sceneId: canvas?.scene?.id || null
        });
        continue;
      }

      const sortBefore = anchor.placeBefore !== true;
      const sortContext = resolvePlacementSortAtElevation(targetElevation, {
        scene: canvas?.scene,
        anchorTileId,
        sortBefore,
        count: 1
      });
      const nextSort = Number(sortContext?.sort);
      const previewSort = Number(sortContext?.previewSort);
      if (!Number.isFinite(nextSort)) {
        Logger.warn('LayerManager.tileDrop.previewAnchor.invalidSort', {
          previewId,
          previewKind,
          targetElevation,
          targetElevationKey,
          anchorTileId,
          sortStrategy: sortContext?.strategy || null,
          sceneId: canvas?.scene?.id || null
        });
        continue;
      }

      Logger.info('LayerManager.tileDrop.previewAnchor.apply', {
        previewId,
        previewKind,
        targetElevationKey,
        targetElevation,
        anchorTileId,
        placeBefore: anchor.placeBefore === true,
        nextSort,
        previewSort: Number.isFinite(previewSort) ? previewSort : null,
        sortStrategy: sortContext?.strategy || null,
        siblingUpdates: Array.isArray(sortContext?.siblingUpdates) ? sortContext.siblingUpdates.length : 0,
        placementLevelId: anchor.placementLevelId ?? null
      });

      const applied = await Promise.resolve(controller.applyLayerManagerPreviewPlacement({
        elevation: targetElevation,
        sort: nextSort,
        previewSort: Number.isFinite(previewSort) ? previewSort : nextSort,
        previewKind,
        previewId,
        previewKey: anchor.previewKey || null,
        placementLevelId: anchor.placementLevelId ?? undefined,
        anchorTileId,
        sortBefore,
        announce: false,
        immediate: true
      }));

      if (!applied) {
        Logger.warn('LayerManager.tileDrop.previewAnchor.noop', {
          previewId,
          previewKind,
          targetElevation,
          targetElevationKey,
          anchorTileId,
          nextSort
        });
      } else {
        this._lastActivePreviewId = previewId;
      }
    }
    this._scheduleRender();
  }

  async _applyPreviewDropReorder(target) {
    const previewId = String(this._dragState?.previewId || '').trim();
    const previewKind = String(this._dragState?.previewKind || '').trim();
    if (!previewId || !previewKind) return;

    const previewEntry = this._getPreviewEntryById(previewId);
    if (!previewEntry?.preview) {
      Logger.debug('LayerManager.previewDrop.missingPreviewEntry', {
        previewId,
        previewKind,
        sceneId: canvas?.scene?.id || null
      });
      return;
    }

    const targetElevationKey = String(target?.elevationKey || '').trim();
    const rawTargetElevation = this._resolveGroupElevation(targetElevationKey);
    const targetElevation = rawTargetElevation == null ? NaN : Number(rawTargetElevation);
    if (!Number.isFinite(targetElevation)) {
      Logger.warn('LayerManager.previewDrop.missingTargetElevation', {
        previewId,
        previewKind,
        targetElevationKey,
        sceneId: canvas?.scene?.id || null
      });
      return;
    }

    const controller = resolvePreviewSessionController(previewKind);
    if (!controller || typeof controller.applyLayerManagerPreviewPlacement !== 'function') {
      Logger.warn('LayerManager.previewDrop.controllerUnavailable', {
        previewId,
        previewKind,
        targetElevation,
        targetElevationKey,
        sceneId: canvas?.scene?.id || null
      });
      return;
    }

    const sortContext = this._resolvePreviewDropSortContext(target, targetElevation);
    const nextSort = Number(sortContext?.sort);
    const previewSort = Number(sortContext?.previewSort);
    const anchorTileId = target?.kind === 'row'
      ? String(target?.rowId || '').trim() || null
      : null;
    const placementLevelId = resolveSyntheticTargetPlacementLevelId(targetElevationKey);
    const listScrollTop = this._captureListScrollTop();
    Logger.info('LayerManager.previewDrop.apply', {
      previewId,
      previewKind,
      targetKind: target?.kind || null,
      targetElevationKey,
      targetElevation,
      nextSort,
      previewSort: Number.isFinite(previewSort) ? previewSort : null,
      sortStrategy: sortContext?.strategy || null,
      siblingUpdates: Array.isArray(sortContext?.siblingUpdates) ? sortContext.siblingUpdates.length : 0,
      anchorTileId,
      placementLevelId: placementLevelId ?? null
    });

    const applied = await Promise.resolve(controller.applyLayerManagerPreviewPlacement({
      elevation: targetElevation,
      sort: nextSort,
      previewSort: Number.isFinite(previewSort) ? previewSort : nextSort,
      previewKind,
      previewId,
      previewKey: previewEntry.previewKey || null,
      targetPreviewId: target?.kind === 'preview' ? String(target?.previewId || '').trim() || null : null,
      placementLevelId,
      anchorTileId,
      sortBefore: target?.kind === 'row' ? target.placeBefore !== true : undefined,
      announce: false,
      immediate: true
    }));

    if (!applied) {
      Logger.warn('LayerManager.previewDrop.noop', {
        previewId,
        previewKind,
        targetElevation,
        targetElevationKey,
        nextSort,
        anchorTileId
      });
      return;
    }

    this._preserveListScrollTop(listScrollTop);
    this._lastActivePreviewId = previewId;
    this._scheduleRender();
  }

  _handlePreviewRowClick(previewRow) {
    const previewId = String(previewRow?.dataset?.previewId || '').trim();
    if (!previewId) return false;
    const previewEntry = this._getPreviewEntryById(previewId);
    if (!previewEntry?.preview) {
      Logger.debug('LayerManager.previewClick.missingPreviewEntry', {
        previewId,
        sceneId: canvas?.scene?.id || null
      });
      return false;
    }
    const previewKind = String(previewEntry?.previewKind || previewRow?.dataset?.previewKind || '').trim();
    const controller = resolvePreviewSessionController(previewKind);
    if (!controller) {
      Logger.warn('LayerManager.previewClick.controllerUnavailable', {
        previewId,
        previewKind,
        sceneId: canvas?.scene?.id || null
      });
      return false;
    }

    const payload = {
      previewId,
      previewKey: previewEntry.previewKey || previewRow?.dataset?.previewKey || null,
      previewKind,
      elevation: Number(previewEntry?.documentElevation ?? previewEntry?.elevation ?? NaN),
      sort: Number(previewEntry?.placementSort ?? NaN),
      previewSort: Number(previewEntry?.sort ?? previewEntry?.placementSort ?? NaN),
      placementLevelId: previewEntry?.placementLevelId ?? undefined,
      announce: false,
      immediate: true
    };

    let applied = false;
    if (typeof controller.selectLayerManagerPreview === 'function') {
      applied = !!controller.selectLayerManagerPreview(payload);
    } else if (typeof controller.applyLayerManagerPreviewPlacement === 'function') {
      applied = !!controller.applyLayerManagerPreviewPlacement(payload);
    } else {
      Logger.warn('LayerManager.previewClick.unsupportedController', {
        previewId,
        previewKind,
        sceneId: canvas?.scene?.id || null
      });
      return false;
    }
    if (applied) this._scheduleRender();
    return applied;
  }

  _resolveMarqueeLayerOperation(event = null) {
    if (event?.altKey) return 'subtract';
    if (event?.shiftKey) return 'add';
    return 'replace';
  }

  _handleTextureMarqueeLayerClick(rowEl, event = null) {
    if (!rowEl || !(event?.ctrlKey || event?.metaKey)) return false;
    const texturePaintManager = resolveTexturePaintManager();
    if (!texturePaintManager?.isActive) return false;
    let marqueeModeActive = false;
    try {
      marqueeModeActive = typeof texturePaintManager.isMarqueeModeActive === 'function'
        ? !!texturePaintManager.isMarqueeModeActive()
        : false;
    } catch (error) {
      Logger.error('LayerManager.textureMarquee.modeCheck.failed', {
        sceneId: canvas?.scene?.id || null,
        error: String(error?.message || error)
      });
      ui?.notifications?.error?.(`Failed to check Texture Painter marquee mode: ${error?.message || error}`);
      return false;
    }
    if (!marqueeModeActive) return false;

    const tileId = String(rowEl?.dataset?.tileId || '').trim();
    const tile = tileId ? this._getTilePlaceable(tileId) : null;
    const doc = tile?.document || canvas?.scene?.tiles?.get?.(tileId) || this._viewState?.fullTileDocsById?.get?.(tileId) || null;
    if (!tile && !doc) {
      Logger.error('LayerManager.textureMarquee.missingLayer', {
        sceneId: canvas?.scene?.id || null,
        tileId: tileId || null
      });
      ui?.notifications?.error?.('Failed to apply layer pixels to the marquee: layer document is unavailable.');
      return true;
    }

    event?.preventDefault?.();
    event?.stopPropagation?.();
    const operation = this._resolveMarqueeLayerOperation(event);
    void Promise.resolve(texturePaintManager.applyLayerPixelsToMarquee(tile || doc, { operation }))
      .then(() => {
        Logger.info('LayerManager.textureMarquee.applyLayerPixels', {
          sceneId: canvas?.scene?.id || null,
          tileId: tileId || doc?.id || null,
          operation
        });
      })
      .catch((error) => {
        Logger.error('LayerManager.textureMarquee.applyLayerPixels.failed', {
          sceneId: canvas?.scene?.id || null,
          tileId: tileId || doc?.id || null,
          operation,
          error: String(error?.message || error)
        });
      });
    return true;
  }

  _ensureHooks() {
    if (!globalThis.Hooks || this._hookIds.length) return;
    const hook = (name, fn) => {
      try { Hooks.on(name, fn); } catch (_) { return; }
      this._hookIds.push({ name, fn });
    };

    const refresh = (reason = 'hook-refresh', { invalidateListCache = true, refreshSelection = true } = {}) => {
      if (invalidateListCache) invalidateSelectionListFilterCache(reason);
      if (this.active || this.isPopout) this._startWheelSession();
      if (bulkLayerDocumentUpdateState.depth > 0 && reason === 'update-tile') {
        bulkLayerDocumentUpdateState.renderPending = true;
        return;
      }
      if (refreshSelection) {
        scheduleSelectionFilterRefresh({
          reason,
          source: 'layer-manager-hooks',
          resyncSettings: false
        });
      }
      this._scheduleRender();
    };
    const syncSelection = () => this._queueSelectionSyncFromCanvas();

    hook('createTile', () => refresh('create-tile'));
    hook('updateTile', () => refresh('update-tile'));
    hook('deleteTile', () => refresh('delete-tile'));
    hook('canvasReady', () => refresh('canvas-ready'));
    hook('canvasTearDown', () => refresh('canvas-teardown'));
    hook('updateScene', () => refresh('update-scene'));
    hook('createLevel', () => refresh('create-level'));
    hook('updateLevel', () => refresh('update-level'));
    hook('deleteLevel', () => refresh('delete-level'));
    hook('drawPrimaryCanvasGroup', () => refresh('draw-primary-group'));
    hook('fa-nexus-preview-layers-changed', () => refresh('preview-layers-changed'));
    hook('fa-nexus-tile-config-selection-sync', (options = {}) => {
      this._queueSelectionSyncFromCanvas({
        allowAutoExpand: options?.allowAutoExpand !== false,
        allowScrollToTile: options?.allowScrollToTile !== false
      });
    });
    hook('controlTile', syncSelection);
    hook('releaseTile', syncSelection);
    hook('updateSetting', (payload) => {
      if (payload?.namespace !== MODULE_ID) return;
      if (payload?.key === COLLAPSED_STATE_SETTING) {
        syncLayerManagerCollapsedStateFromSettings();
        refresh('collapsed-state-updated', { invalidateListCache: false, refreshSelection: false });
        return;
      }
      if (payload?.key !== NESTED_GROUPING_SETTING) return;
      refresh('nested-grouping-updated', { invalidateListCache: false, refreshSelection: false });
    });
  }

  _removeHooks() {
    this._canvasSelectionSyncQueued = false;
    if (!globalThis.Hooks || !this._hookIds.length) return;
    for (const { name, fn } of this._hookIds) {
      try { Hooks.off(name, fn); } catch (_) {}
    }
    this._hookIds = [];
  }

  _scheduleRender() {
    if (!this.rendered || (!this.active && !this.isPopout)) return;
    const explicitScrollQueued = !!this._scrollTargetId || !!this._scrollPreviewTargetId;
    if (!explicitScrollQueued && this._preservedListScrollTop === null) {
      this._preserveListScrollTop(this._captureListScrollTop());
    }
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this.render({ parts: ['content'] });
    });
  }

  _handleSelectionListFilterStateChange(reason) {
    handleLayerManagerSelectionListFilterStateChange({
      reason,
      selectionFilterState,
      invalidateSelectionListFilterCache,
      scheduleSelectionFilterRefresh
    });
  }

  _activateTilesLayer() {
    activateLayerManagerTilesLayer();
  }

  _onRangeChange(isInput = false) {
    applyRangeFilterChange({
      root: this.element,
      isInput,
      selectionFilterState,
      parseElevationInput,
      writeSetting,
      refreshTileInteractionState,
      pruneSelectionForFilter,
      rangeMinSetting: RANGE_MIN_SETTING,
      rangeMaxSetting: RANGE_MAX_SETTING,
      ignoreForegroundSetting: IGNORE_FOREGROUND_SETTING
    });
  }

  _onSkipLockedChange() {
    applySelectionBooleanFilterChange({
      root: this.element,
      action: 'skip-locked',
      selectionFilterState,
      stateKey: 'skipLocked',
      settingKey: SKIP_LOCKED_SETTING,
      writeSetting,
      refreshTileInteractionState,
      pruneSelectionForFilter
    });
  }

  _onSkipHiddenChange() {
    applySelectionBooleanFilterChange({
      root: this.element,
      action: 'skip-hidden',
      selectionFilterState,
      stateKey: 'skipHidden',
      settingKey: SKIP_HIDDEN_SETTING,
      writeSetting,
      refreshTileInteractionState,
      pruneSelectionForFilter
    });
  }

  _onSkipFilteredChange() {
    applySkipFilteredChange({
      root: this.element,
      selectionFilterState,
      invalidateSelectionListFilterCache,
      writeSetting,
      scheduleSelectionFilterRefresh,
      settingKey: SKIP_FILTERED_SETTING
    });
  }

  _setFilterActive(active) {
    const changed = setSelectionFilterActive({
      active,
      selectionFilterState,
      setAltKeyHeld,
      isAltModifierActive,
      refreshTileInteractionState,
      pruneSelectionForFilter
    });
    if (!active) restoreLayerManagerTileInteractivity({ source: 'layer-manager-deactivate' });
    return changed;
  }

  _setActiveClass(active) {
    setLayerManagerActiveClass({
      element: this.element,
      active,
      isPopout: this.isPopout,
      tabId: TAB_ID
    });
  }

  _onListClick(event) {
    if (event.target?.closest?.('.fa-nexus-layer-manager__rename-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-name-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-elevation-input')) return;
    const sceneMarkerVisibilityToggle = event.target?.closest?.('[data-action="toggle-scene-marker-visibility"]');
    if (sceneMarkerVisibilityToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleSceneMarkerVisibility(sceneMarkerVisibilityToggle);
      return;
    }
    const sceneMarker = event.target?.closest?.('[data-scene-marker]');
    if (sceneMarker) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const levelBoundary = event.target?.closest?.('.fa-nexus-layer-manager__separator--level-boundary');
    if (levelBoundary) {
      event.preventDefault();
      event.stopPropagation();
      this._selectCurrentLevelBand(levelBoundary);
      return;
    }

    const elevationToggle = event.target?.closest?.('[data-action="toggle-elevation-visibility"]');
    if (elevationToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleElevationVisibility(elevationToggle);
      return;
    }

    const collapseToggle = event.target?.closest?.('[data-action="toggle-elevation-collapse"]');
    if (collapseToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleElevationCollapse(collapseToggle);
      return;
    }

    const visibilityToggle = event.target?.closest?.('[data-action="toggle-visibility"]');
    if (visibilityToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleVisibility(visibilityToggle);
      return;
    }

    const lockToggle = event.target?.closest?.('[data-action="toggle-lock"]');
    if (lockToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleLock(lockToggle);
      return;
    }

    const previewRow = event.target?.closest?.('[data-preview-id]');
    if (previewRow) {
      event.preventDefault();
      event.stopPropagation();
      this._handlePreviewRowClick(previewRow);
      return;
    }

    const separator = event.target?.closest?.('.fa-nexus-layer-manager__separator:not(.fa-nexus-layer-manager__separator--level-boundary)');
    if (separator) {
      event.preventDefault();
      event.stopPropagation();
      const renameTarget = event.target?.closest?.('.fa-nexus-layer-manager__separator-name, .fa-nexus-layer-manager__separator-elevation');
      if (renameTarget) {
        if ((Number(event?.detail) || 0) > 1) return;
        this._selectElevation(separator, {
          ctrlKey: !!event?.ctrlKey,
          metaKey: !!event?.metaKey,
          shiftKey: !!event?.shiftKey
        });
        return;
      }
      this._selectElevation(separator, event);
      return;
    }

    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const list = target.parentElement;
    const items = list ? Array.from(list.querySelectorAll('[data-tile-id]')) : [target];
    const currentIndex = items.indexOf(target);
    const tileId = target.dataset.tileId;
    if (!tileId) return;
    if (this._handleTextureMarqueeLayerClick(target, event)) return;
    this._lastClickedTileId = tileId;

    this._activateTilesLayer();

    const isMeta = !!(event.ctrlKey || event.metaKey);
    const isShift = !!event.shiftKey;
    const tile = this._getTilePlaceable(tileId);
    if (!tile) {
      const doc = canvas?.scene?.tiles?.get?.(tileId) || this._viewState?.fullTileDocsById?.get?.(tileId) || null;
      if (doc) {
        this._preserveTileSelectionContextForNexus(
          [doc],
          `list.${isShift ? 'shift' : (isMeta ? 'meta' : 'single')}:documentOnly`
        );
        Logger.info('LayerManager.selection.documentOnlyPreserved', {
          sceneId: canvas?.scene?.id || null,
          source: 'list',
          tileId,
          locked: !!doc?.locked,
          hidden: isLayerHidden(doc)
        });
      } else {
        Logger.debug('LayerManager.selection.missingDocumentAndPlaceable', {
          sceneId: canvas?.scene?.id || null,
          tileId
        });
      }
      return;
    }

    if (isShift && this._lastClickedIndex >= 0) {
      const start = Math.min(this._lastClickedIndex, currentIndex);
      const end = Math.max(this._lastClickedIndex, currentIndex);
      const rangeDocs = [];
      for (let i = start; i <= end; i += 1) {
        const rangeId = items[i]?.dataset?.tileId;
        if (!rangeId) continue;
        const rangeTile = this._getTilePlaceable(rangeId);
        const rangeDoc = rangeTile?.document || canvas?.scene?.tiles?.get?.(rangeId) || null;
        if (rangeDoc) rangeDocs.push(rangeDoc);
      }
      try {
        this._selectTileDocs(rangeDocs, {
          retainSelection: isMeta,
          force: true,
          source: 'list.shift'
        });
      } catch (error) {
        this._notifyLayerManagerActionError('select layer range', error);
      }
    } else if (isMeta) {
      try {
        if (tile.controlled) {
          withBulkTileSelectionBatch(() => {
            tile.release({ renderSidebar: false });
            renderTileSelectionSidebar();
          });
          this._syncSelectionFromCanvas();
        } else {
          const doc = tile.document || canvas?.scene?.tiles?.get?.(tileId) || null;
          this._selectTileDocs(doc ? [doc] : [], {
            retainSelection: true,
            force: true,
            source: 'list.meta'
          });
        }
      } catch (error) {
        this._notifyLayerManagerActionError('toggle layer selection', error);
      }
    } else {
      const doc = tile.document || canvas?.scene?.tiles?.get?.(tileId) || null;
      try {
        this._selectTileDocs(doc ? [doc] : [], {
          retainSelection: false,
          force: true,
          source: 'list.single'
        });
      } catch (error) {
        this._notifyLayerManagerActionError('select layer', error);
      }
    }

    this._lastClickedIndex = currentIndex;
    this._syncSelectionFromCanvas();
  }

  _onListDoubleClick(event) {
    if (event.target?.closest?.('.fa-nexus-layer-manager__rename-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-name-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-elevation-input')) return;
    if (event.target?.closest?.('[data-action="toggle-scene-marker-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-lock"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-collapse"]')) return;
    const groupName = event.target?.closest?.('.fa-nexus-layer-manager__separator-name');
    if (groupName) {
      const separator = groupName.closest('.fa-nexus-layer-manager__separator');
      if (separator?.classList?.contains('fa-nexus-layer-manager__separator--level-boundary')) return;
      if (String(separator?.dataset?.groupCanRename || '').trim() === 'false') return;
      const elevationKey = String(separator?.dataset?.elevationKey || '').trim();
      if (!elevationKey) return;
      event.preventDefault();
      event.stopPropagation();
      this._beginElevationGroupNameEdit(elevationKey);
      return;
    }
    if (event.target?.closest?.('[data-scene-marker]')) {
      this._openSceneSettings();
      return;
    }
    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const tileId = target.dataset.tileId;
    if (!tileId) return;
    const tile = this._getTilePlaceable(tileId);
    if (!tile) return;
    this._activateTilesLayer();
    try {
      const center = tile.center || { x: tile.document?.x ?? 0, y: tile.document?.y ?? 0 };
      canvas.animatePan({ x: center.x, y: center.y, duration: 250 });
    } catch (_) {}
  }

  _onListContextMenu(event) {
    if (event.target?.closest?.('.fa-nexus-layer-manager__rename-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-name-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-elevation-input')) return;
    if (event.target?.closest?.('[data-action="toggle-scene-marker-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-lock"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-collapse"]')) return;
    const levelBoundary = event.target?.closest?.('.fa-nexus-layer-manager__separator--level-boundary');
    if (levelBoundary) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleCurrentLevelBandIsolation(levelBoundary);
      return;
    }
    const separator = event.target?.closest?.('.fa-nexus-layer-manager__separator:not(.fa-nexus-layer-manager__separator--level-boundary)');
    if (separator) {
      const elevationKey = String(separator?.dataset?.elevationKey || '').trim();
      if (!elevationKey) return;
      const docs = this._getGroupContextMenuDocs(elevationKey);
      const canUpdateAll = docs.length > 0 && docs.every((doc) => doc?.canUserModify?.(game.user, 'update'));
      const allLocked = docs.length > 0 && docs.every((doc) => !!doc?.locked);
      const filtersApplied = !!this._viewState?.filtersApplied;
      const canRenameGroup = !!canvas?.scene?.canUserModify?.(game.user, 'update')
        && String(separator?.dataset?.groupCanRename || '').trim() !== 'false';
      const canEditElevationGroup = canUpdateAll
        && !filtersApplied
        && String(separator?.dataset?.groupCanEditElevation || '').trim() !== 'false';
      event.preventDefault();
      event.stopPropagation();
      this._showLayerContextMenu(event, [
        {
          label: 'Rename',
          iconClass: 'fa-solid fa-i-cursor',
          disabled: !canRenameGroup,
          action: () => this._beginElevationGroupNameEdit(elevationKey),
          errorMessage: 'Failed to begin elevation group rename.'
        },
        {
          label: 'Change Elevation',
          iconClass: 'fa-solid fa-arrows-up-down',
          disabled: !canEditElevationGroup,
          title: filtersApplied ? 'Clear filters before changing a group elevation.' : '',
          action: () => {
            this._beginElevationGroupElevationEdit(elevationKey);
          },
          errorMessage: 'Failed to begin elevation group edit.'
        },
        {
          label: allLocked ? 'Unlock' : 'Lock',
          iconClass: allLocked ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock',
          disabled: !canUpdateAll,
          action: () => this._toggleDocsLock(docs),
          errorMessage: 'Failed to update layer locks.'
        },
        this._buildFlattenContextMenuItem(docs)
      ]);
      return;
    }

    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const tileId = String(target.dataset.tileId || '').trim();
    if (!tileId) return;
    const clickedTile = this._getTilePlaceable(tileId);
    if (!clickedTile) {
      Logger.debug('LayerManager.contextMenu.tile.missing', { tileId });
      return;
    }
    this._triggerTileContextHighlight(clickedTile, event);
    if (this._isDoubleContextClick(tileId)) {
      event.preventDefault();
      event.stopPropagation();
      this._closeContextMenu();
      this._openTileSettings(clickedTile);
      return;
    }
    const docs = this._getContextMenuTileDocs(tileId);
    if (!docs.length) return;
    const clickedDoc = clickedTile?.document || docs[0] || null;
    const canUpdateAll = docs.every((doc) => doc?.canUserModify?.(game.user, 'update'));
    const allLocked = docs.every((doc) => !!doc?.locked);
    const hasNexusEdit = docs.length === 1 && !!getFaNexusTileEditMode(clickedDoc);
    const canMaskSingle = docs.length === 1 && canLaunchFaNexusTileMask(clickedDoc);
    const clickedHasMask = hasTileMask(clickedDoc);
    const hasAnyMask = docs.some((doc) => hasTileMask(doc));
    const menuAnchor = {
      clientX: Number(event?.clientX ?? 0),
      clientY: Number(event?.clientY ?? 0)
    };
    event.preventDefault();
    event.stopPropagation();
    this._showLayerContextMenu(event, [
      {
        label: 'Rename',
        iconClass: 'fa-solid fa-i-cursor',
        disabled: docs.length !== 1 || !clickedDoc?.canUserModify?.(game.user, 'update'),
        action: () => this._beginRename(tileId),
        errorMessage: 'Failed to begin layer rename.'
      },
      {
        label: 'Change Elevation',
        iconClass: 'fa-solid fa-arrows-up-down',
        disabled: !canUpdateAll,
        action: () => this._promptDocsElevationChange(docs, menuAnchor),
        errorMessage: 'Failed to change layer elevation.'
      },
      {
        label: allLocked ? 'Unlock' : 'Lock',
        iconClass: allLocked ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock',
        disabled: !canUpdateAll,
        action: () => this._toggleDocsLock(docs),
        errorMessage: 'Failed to update layer locks.'
      },
      {
        label: 'Nexus Edit',
        iconClass: 'fa-solid fa-wand-magic-sparkles',
        disabled: !hasNexusEdit,
        action: () => this._openNexusTileEditor(clickedDoc),
        errorMessage: 'Failed to open FA Nexus editor.'
      },
      {
        label: clickedHasMask ? 'Edit Mask' : 'Apply Mask',
        iconClass: 'fa-solid fa-mask',
        disabled: !canMaskSingle,
        action: () => this._openTileMaskEditor(clickedDoc),
        errorMessage: 'Failed to open FA Nexus mask editor.'
      },
      {
        label: 'Clear Mask',
        iconClass: 'fa-solid fa-eraser',
        disabled: !hasAnyMask || !canUpdateAll,
        action: () => this._clearTileMasks(docs),
        errorMessage: 'Failed to clear tile mask.'
      },
      {
        label: 'Configure',
        iconClass: 'fa-solid fa-gear',
        disabled: docs.length !== 1 || !clickedTile,
        action: () => this._openTileSettings(clickedTile),
        errorMessage: 'Failed to open layer configuration.'
      },
      this._buildFlattenContextMenuItem(docs)
    ]);
  }

  _onListHover(event) {
    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const tileId = target.dataset.tileId;
    if (!tileId || tileId === this._hoveredTileId) return;
    this._clearHover();
    const tile = this._getTilePlaceable(tileId);
    if (!tile) return;
    if (isTileBeingEdited(tile)) return;
    try { tile._onHoverIn(hoverEventStub, { hoverOutOthers: true }); } catch (_) {}
    this._hoveredTileId = tileId;
  }

  _startWheelSession() {
    if (this._wheelSession || !canvas?.ready) return;
    this._wheelSession = createCanvasGestureSession({
      wheel: { handler: (event, { pointer }) => this._onCanvasWheel(event, pointer), respectZIndex: true },
      keydown: (event, { pointer }) => this._onCanvasKeyDown(event, pointer),
      keyup: (event) => this._onCanvasKeyUp(event)
    }, {
      onCanvasTearDown: () => this._stopWheelSession()
    });
  }

  _stopWheelSession() {
    if (!this._wheelSession) return;
    try { this._wheelSession.stop('layer-manager'); } catch (_) {}
    this._wheelSession = null;
    this._clearElevationAnnounceTimer();
  }

  _resolveElevationStep({ shiftKey = false, ctrlKey = false, metaKey = false } = {}) {
    return resolveLayerManagerElevationStep({
      shiftKey,
      ctrlKey,
      metaKey,
      defaultStep: ELEVATION_STEP_DEFAULT,
      fineStep: ELEVATION_STEP_FINE,
      coarseStep: ELEVATION_STEP_COARSE
    });
  }

  _getElevationShortcutDirection(event = null) {
    return getLayerManagerElevationShortcutDirection(event);
  }

  _getElevationAnnouncePoint(pointer = null) {
    return getLayerManagerElevationAnnouncePoint({
      pointer,
      controlledTiles: canvas?.tiles?.controlled,
      selectedDocs: this._getSelectedTileDocs(),
      dimensions: canvas?.dimensions,
      scene: canvas?.scene
    });
  }

  _onCanvasKeyDown(event, pointer = null) {
    if (!event) return;
    if (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight') {
      setAltKeyHeld(true);
      return;
    }
    const elevationDirection = event.altKey ? this._getElevationShortcutDirection(event) : 0;
    if (elevationDirection !== 0) {
      if (this._isEditableElement(event.target) || this._isEditableElement(document?.activeElement)) return;
      if (this._adjustElevationSelection(elevationDirection, event, { pointer, source: 'key' })) return;
    }
    if (this._shouldHandleRenameHotkey(event)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      this._beginRenameFromHotkey();
    }
  }

  _onCanvasKeyUp(event) {
    if (!event) return;
    if (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight') {
      setAltKeyHeld(false);
    }
  }

  _onCanvasWheel(event, pointer) {
    if (!this.active && !this.isPopout) return;
    if (!pointer?.overCanvas || !pointer?.zOk) return;
    this._handleElevationWheel(event, pointer);
  }

  _handleElevationWheel(event, pointer = null) {
    const altActive = !!event?.altKey;
    if (event) setAltKeyHeld(altActive);
    if (!altActive) return;
    const direction = event.deltaY < 0 ? 1 : -1;
    this._adjustElevationSelection(direction, event, { pointer, source: 'wheel' });
  }

  _adjustElevationSelection(direction, event = null, { pointer = null, source = 'unknown' } = {}) {
    return adjustLayerManagerElevationSelection({
      direction,
      event,
      pointer,
      source,
      user: game?.user,
      selectedSceneMarkers: this._selectedSceneMarkers,
      adjustSceneMarkerElevation: (markerKind, markerDirection, step, markerPointer) => this._adjustSceneMarkerElevation(markerKind, markerDirection, step, markerPointer),
      controlledTiles: canvas?.tiles?.controlled,
      orderDocsByIds: (ids) => this._getOrderedDocsByIds(ids),
      resolveTileElevationMove: ({ doc, requestedElevation }) => this._resolveTileElevationMove(doc, requestedElevation),
      elevationGroupKey,
      computeNextSortAtElevation,
      getFullElevationDocs: (key) => this._getFullElevationDocs(key),
      getSceneElevationGroupMetadata,
      mergeElevationGroupMetadataOnBulkMove,
      setSceneElevationGroupMetadata,
      restoreSelectionAfterElevationMove: (docIds, options) => this._restoreSelectionAfterElevationMove(docIds, options),
      queueElevationAnnounce: (worldPoint, elevation) => this._queueElevationAnnounce(worldPoint, elevation),
      getElevationAnnouncePoint: (markerPointer) => this._getElevationAnnouncePoint(markerPointer),
      resolveElevationStep: (options) => this._resolveElevationStep(options)
    });
  }

  _onListWheel(event) {
    this._handleElevationWheel(event);
  }

  _clearElevationAnnounceTimer() {
    if (this._elevationAnnounceTimer) {
      clearTimeout(this._elevationAnnounceTimer);
      this._elevationAnnounceTimer = null;
    }
    this._pendingElevationAnnouncePoint = null;
    this._pendingElevationAnnounceMessage = null;
  }

  _queueElevationAnnounce(worldPoint, elevation, options = {}) {
    if (!Number.isFinite(elevation)) return;
    const now = Date.now();
    const delta = now - this._lastElevationAnnounce;
    const throttleMs = 75;
    const immediate = options?.immediate === true;
    this._pendingElevationAnnouncePoint = worldPoint ?? this._pendingElevationAnnouncePoint ?? null;
    this._pendingElevationAnnounceMessage = `Elevation: ${formatElevation(elevation)}`;

    if (immediate || delta >= throttleMs) {
      this._flushElevationAnnounce();
      return;
    }

    const remaining = Math.max(0, throttleMs - delta);
    if (this._elevationAnnounceTimer) clearTimeout(this._elevationAnnounceTimer);
    this._elevationAnnounceTimer = setTimeout(() => {
      this._elevationAnnounceTimer = null;
      this._flushElevationAnnounce();
    }, remaining);
  }

  _flushElevationAnnounce() {
    try {
      this._lastElevationAnnounce = Date.now();
      const worldPoint = this._pendingElevationAnnouncePoint ?? null;
      const message = this._pendingElevationAnnounceMessage ?? '';
      this._pendingElevationAnnouncePoint = null;
      this._pendingElevationAnnounceMessage = null;
      if (!worldPoint || !message) return;
      if (canvas?.interface?.createScrollingText && globalThis.CONST?.TEXT_ANCHOR_POINTS) {
        canvas.interface.createScrollingText(worldPoint, message, {
          anchor: CONST.TEXT_ANCHOR_POINTS.CENTER,
          direction: CONST.TEXT_ANCHOR_POINTS.TOP,
          distance: 60,
          duration: 900,
          fade: 0.8,
          stroke: 0x111111,
          strokeThickness: 4,
          fill: 0xffffff,
          fontSize: 26
        });
      }
    } catch (_) {}
  }

  _clearHover() {
    if (!this._hoveredTileId) return;
    const tile = this._getTilePlaceable(this._hoveredTileId);
    if (tile) {
      try { tile._onHoverOut(hoverEventStub); } catch (_) {}
    }
    this._hoveredTileId = null;
  }

  _shouldHandleRenameHotkey(event) {
    return shouldHandleLayerManagerRenameHotkey({
      event,
      active: this.active,
      isPopout: this.isPopout,
      renameSubmitting: this._renameSubmitting
    });
  }

  _isEditableElement(element) {
    return isEditableLayerManagerElement(element);
  }

  _beginRenameFromHotkey() {
    const tileId = resolveLayerManagerRenameTargetId({
      root: this.element,
      lastClickedTileId: this._lastClickedTileId
    });
    if (!tileId) return;
    this._beginRename(tileId);
  }

  _applyRenameStatePatch(patch = {}) {
    if (!patch || typeof patch !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(patch, 'renamingTileId')) this._renamingTileId = patch.renamingTileId;
    if (Object.prototype.hasOwnProperty.call(patch, 'renameDraft')) this._renameDraft = patch.renameDraft;
    if (Object.prototype.hasOwnProperty.call(patch, 'renameFocusPending')) this._renameFocusPending = patch.renameFocusPending;
  }

  _applyElevationGroupNameEditStatePatch(patch = {}) {
    if (!patch || typeof patch !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(patch, 'editingElevationGroupNameKey')) this._editingElevationGroupNameKey = patch.editingElevationGroupNameKey;
    if (Object.prototype.hasOwnProperty.call(patch, 'editingElevationGroupNameDraft')) this._editingElevationGroupNameDraft = patch.editingElevationGroupNameDraft;
    if (Object.prototype.hasOwnProperty.call(patch, 'editingElevationGroupNameFocusPending')) this._editingElevationGroupNameFocusPending = patch.editingElevationGroupNameFocusPending;
  }

  _applyElevationGroupElevationEditStatePatch(patch = {}) {
    if (!patch || typeof patch !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(patch, 'editingElevationGroupElevationKey')) this._editingElevationGroupElevationKey = patch.editingElevationGroupElevationKey;
    if (Object.prototype.hasOwnProperty.call(patch, 'editingElevationGroupElevationDraft')) this._editingElevationGroupElevationDraft = patch.editingElevationGroupElevationDraft;
    if (Object.prototype.hasOwnProperty.call(patch, 'editingElevationGroupElevationFocusPending')) this._editingElevationGroupElevationFocusPending = patch.editingElevationGroupElevationFocusPending;
  }

  _applyScrollStatePatch(patch = {}) {
    if (!patch || typeof patch !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(patch, 'scrollTargetId')) this._scrollTargetId = patch.scrollTargetId;
    if (Object.prototype.hasOwnProperty.call(patch, 'scrollQueued')) this._scrollQueued = patch.scrollQueued;
  }

  _applyPreviewScrollStatePatch(patch = {}) {
    if (!patch || typeof patch !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(patch, 'scrollPreviewTargetId')) this._scrollPreviewTargetId = patch.scrollPreviewTargetId;
    if (Object.prototype.hasOwnProperty.call(patch, 'scrollPreviewQueued')) this._scrollPreviewQueued = patch.scrollPreviewQueued;
  }

  _setPendingCanvasSelectionSyncOptions(options = null) {
    if (!options || typeof options !== 'object') {
      this._pendingCanvasSelectionSyncOptions = null;
      return null;
    }
    const prior = this._pendingCanvasSelectionSyncOptions && typeof this._pendingCanvasSelectionSyncOptions === 'object'
      ? this._pendingCanvasSelectionSyncOptions
      : {};
    const next = { ...prior };
    if (Object.prototype.hasOwnProperty.call(options, 'allowAutoExpand')) {
      next.allowAutoExpand = options.allowAutoExpand !== false;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'allowScrollToTile')) {
      next.allowScrollToTile = options.allowScrollToTile !== false;
    }
    this._pendingCanvasSelectionSyncOptions = Object.keys(next).length ? next : null;
    return this._pendingCanvasSelectionSyncOptions;
  }

  _beginRename(tileId) {
    return beginLayerManagerRename({
      tileId,
      resolveRenameDocument: (id) => resolveTileDocument(id),
      user: game?.user,
      clearElevationGroupEditState: () => this._clearElevationGroupEditState(),
      root: this.element,
      computeTileName,
      setRenameState: (patch) => this._applyRenameStatePatch(patch),
      scheduleRender: () => this._scheduleRender()
    });
  }

  _clearRenameState() {
    this._applyRenameStatePatch({
      renamingTileId: null,
      renameDraft: '',
      renameFocusPending: false
    });
  }

  _cancelRename() {
    return cancelLayerManagerRename({
      renamingTileId: this._renamingTileId,
      setRenameState: (patch) => this._applyRenameStatePatch(patch),
      scheduleRender: () => this._scheduleRender()
    });
  }

  async _commitRename(inputEl = null) {
    return commitLayerManagerRename({
      inputEl,
      renamingTileId: this._renamingTileId,
      renameSubmitting: this._renameSubmitting,
      resolveRenameDocument: (id) => resolveTileDocument(id),
      readFlag: readFaFlag,
      renameDraft: this._renameDraft,
      moduleId: MODULE_ID,
      user: game?.user,
      setRenameState: (patch) => this._applyRenameStatePatch(patch),
      setRenameSubmitting: (value) => { this._renameSubmitting = !!value; },
      scheduleRender: () => this._scheduleRender()
    });
  }

  _onRenameInputKeyDown(event) {
    return handleLayerManagerRenameInputKeyDown({
      event,
      commitRename: (inputEl) => this._commitRename(inputEl),
      cancelRename: () => this._cancelRename()
    });
  }

  _clearElevationGroupNameEditState() {
    this._applyElevationGroupNameEditStatePatch({
      editingElevationGroupNameKey: null,
      editingElevationGroupNameDraft: '',
      editingElevationGroupNameFocusPending: false
    });
  }

  _clearElevationGroupElevationEditState() {
    this._applyElevationGroupElevationEditStatePatch({
      editingElevationGroupElevationKey: null,
      editingElevationGroupElevationDraft: '',
      editingElevationGroupElevationFocusPending: false
    });
  }

  _clearElevationGroupEditState() {
    this._clearElevationGroupNameEditState();
    this._clearElevationGroupElevationEditState();
  }

  _beginElevationGroupNameEdit(elevationKey) {
    const node = this._getFullGroupNode(elevationKey);
    if (node?.canRename === false) return false;
    return beginLayerManagerElevationGroupNameEdit({
      elevationKey,
      scene: canvas?.scene,
      user: game?.user,
      clearRenameState: () => this._clearRenameState(),
      getSceneElevationGroupMetadata,
      getElevationGroupName,
      clearElevationGroupElevationEditState: () => this._clearElevationGroupElevationEditState(),
      setElevationGroupNameEditState: (patch) => this._applyElevationGroupNameEditStatePatch(patch),
      scheduleRender: () => this._scheduleRender()
    });
  }

  _cancelElevationGroupNameEdit() {
    return cancelLayerManagerElevationGroupNameEdit({
      editingElevationGroupNameKey: this._editingElevationGroupNameKey,
      setElevationGroupNameEditState: (patch) => this._applyElevationGroupNameEditStatePatch(patch),
      scheduleRender: () => this._scheduleRender()
    });
  }

  async _commitElevationGroupNameEdit(inputEl = null) {
    return commitLayerManagerElevationGroupNameEdit({
      inputEl,
      editingElevationGroupNameKey: this._editingElevationGroupNameKey,
      editingElevationGroupSubmitting: this._editingElevationGroupSubmitting,
      scene: canvas?.scene,
      user: game?.user,
      editingElevationGroupNameDraft: this._editingElevationGroupNameDraft,
      setElevationGroupNameEditState: (patch) => this._applyElevationGroupNameEditStatePatch(patch),
      setElevationGroupSubmitting: (value) => { this._editingElevationGroupSubmitting = !!value; },
      getSceneElevationGroupMetadata,
      getElevationGroupName,
      getFullGroupNode: (key) => this._getFullGroupNode(key),
      cloneElevationGroupMetadata,
      setSceneElevationGroupMetadata,
      scheduleRender: () => this._scheduleRender()
    });
  }

  _onElevationGroupNameInputKeyDown(event) {
    return handleLayerManagerElevationGroupNameInputKeyDown({
      event,
      commitElevationGroupNameEdit: (inputEl) => this._commitElevationGroupNameEdit(inputEl),
      cancelElevationGroupNameEdit: () => this._cancelElevationGroupNameEdit(),
      getEditingElevationGroupNameKey: () => this._editingElevationGroupNameKey
    });
  }

  _beginElevationGroupElevationEdit(elevationKey) {
    const node = this._getFullGroupNode(elevationKey);
    if (node?.canEditElevation === false || !isEditableElevationGroupKey(elevationKey)) return false;
    return beginLayerManagerElevationGroupElevationEdit({
      elevationKey,
      scene: canvas?.scene,
      user: game?.user,
      clearRenameState: () => this._clearRenameState(),
      clearElevationGroupNameEditState: () => this._clearElevationGroupNameEditState(),
      setElevationGroupElevationEditState: (patch) => this._applyElevationGroupElevationEditStatePatch(patch),
      initialElevation: Number.isFinite(node?.elevation) ? Number(node.elevation) : this._resolveGroupElevation(elevationKey),
      formatElevation,
      scheduleRender: () => this._scheduleRender()
    });
  }

  _cancelElevationGroupElevationEdit() {
    return cancelLayerManagerElevationGroupElevationEdit({
      editingElevationGroupElevationKey: this._editingElevationGroupElevationKey,
      setElevationGroupElevationEditState: (patch) => this._applyElevationGroupElevationEditStatePatch(patch),
      scheduleRender: () => this._scheduleRender()
    });
  }

  async _commitElevationGroupElevationEdit(inputEl = null) {
    const sourceKey = String(this._editingElevationGroupElevationKey || '').trim();
    if (!sourceKey || this._editingElevationGroupSubmitting) return;
    const scene = canvas?.scene;
    if (!scene?.updateEmbeddedDocuments) {
      this._clearElevationGroupElevationEditState();
      this._scheduleRender();
      return;
    }
    const draft = String(inputEl?.value ?? this._editingElevationGroupElevationDraft ?? '').trim();
    const nextElevation = parseElevationInput(draft);
    this._editingElevationGroupElevationDraft = draft;
    this._editingElevationGroupSubmitting = true;

    try {
      if (!Number.isFinite(nextElevation)) {
        throw new Error('Elevation group value must be a valid number.');
      }
      const result = await commitLayerManagerElevationGroupElevationEdit({
        sourceKey,
        draft,
        scene,
        user: game?.user,
        usesNestedGrouping: this._usesNestedGrouping(),
        filtersApplied: !!this._viewState?.filtersApplied,
        sourceGroupNode: this._getFullGroupNode(sourceKey),
        orderDocsByIds: (ids) => this._getOrderedDocsByIds(ids),
        getFullElevationDocs: (key) => this._getFullElevationDocs(key),
        parseElevationInput,
        quantizeElevation,
        elevationGroupKey,
        computeNextSortAtElevation,
        getSceneElevationGroupMetadata,
        mergeElevationGroupMetadataOnBulkMove,
        setSceneElevationGroupMetadata,
        resolveTileElevationMove: ({ doc, requestedElevation }) => this._resolveTileElevationMove(doc, requestedElevation),
        restoreSelectionAfterElevationMove: (docIds, options) => this._restoreSelectionAfterElevationMove(docIds, options)
      });
      if (!result?.updates?.length && !result?.movedDocIds?.length) {
        this._clearElevationGroupElevationEditState();
        this._scheduleRender();
        return;
      }
      this._clearElevationGroupElevationEditState();
      this._scheduleRender();
    } catch (error) {
      this._editingElevationGroupElevationFocusPending = true;
      this._scheduleRender();
      throw error;
    } finally {
      this._editingElevationGroupSubmitting = false;
    }
  }

  _onElevationGroupElevationInputKeyDown(event) {
    return handleLayerManagerElevationGroupElevationInputKeyDown({
      event,
      commitElevationGroupElevationEdit: (inputEl) => this._commitElevationGroupElevationEdit(inputEl),
      cancelElevationGroupElevationEdit: () => this._cancelElevationGroupElevationEdit(),
      getEditingElevationGroupElevationKey: () => this._editingElevationGroupElevationKey
    });
  }

  _toggleVisibility(buttonEl) {
    const item = buttonEl?.closest?.('[data-tile-id]');
    if (!item) return;
    const tileId = item.dataset.tileId;
    if (!tileId) return;
    const tile = this._getTilePlaceable(tileId) || null;
    const doc = tile?.document || canvas?.scene?.tiles?.get?.(tileId) || null;
    const selectedDocs = this._getSelectedTileDocs();
    const selectedIds = new Set(selectedDocs.map((selectedDoc) => getTileDocumentId(selectedDoc)).filter(Boolean));
    const targets = selectedIds.has(getTileDocumentId(doc)) && selectedDocs.length > 1 ? selectedDocs : [doc];
    const rowSelected = item.classList?.contains('is-selected') || item.getAttribute?.('aria-selected') === 'true';
    if (rowSelected) this._preserveTileSelectionContextForNexus(targets, 'visibility:rowButton:selectedRow');
    void this._toggleDocsVisibility(targets, {
      source: 'rowButton',
      referenceDoc: doc,
      nextHidden: !isLayerHidden(doc)
    }).catch((error) => this._notifyLayerManagerActionError('toggle layer visibility', error));
  }

  _toggleElevationVisibility(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const elevationKey = String(buttonEl?.dataset?.elevationKey || separator?.dataset?.elevationKey || '').trim();
    if (!elevationKey) return;
    const docs = this._getMatchingElevationDocs(elevationKey);
    const orderedDocs = this._orderTileDocuments(docs);
    void this._toggleDocsVisibility(orderedDocs, {
      source: 'elevationHeader',
      nextHidden: !orderedDocs.every((target) => isLayerHidden(target))
    }).catch((error) => this._notifyLayerManagerActionError('toggle elevation visibility', error));
  }

  _toggleSceneMarkerVisibility(buttonEl) {
    const item = buttonEl?.closest?.('[data-scene-marker]');
    const markerId = String(item?.dataset?.sceneMarker || '').trim();
    if (!markerId) return;
    const targetMarkerIds = new Set([markerId]);
    const markerEntries = [];
    const seenTargets = new Set();
    for (const entry of Array.from(this._viewState?.entries || [])) {
      if (!entry?.marker) continue;
      if (!targetMarkerIds.has(String(entry.markerId || '').trim())) continue;
      const markerLevelId = String(entry?.markerLevelId || '').trim();
      const markerKind = String(entry?.markerKind || '').trim().toLowerCase();
      const targetKey = `${markerLevelId}:${markerKind}`;
      if (!markerLevelId || !markerKind || seenTargets.has(targetKey)) continue;
      markerEntries.push(entry);
      seenTargets.add(targetKey);
    }
    const referenceEntry = markerEntries.find((entry) => String(entry?.markerId || '').trim() === markerId)
      || markerEntries[0]
      || null;
    if (!referenceEntry) return;
    const nextHidden = !referenceEntry.hidden;
    const scene = canvas?.scene;
    if (!scene?.updateEmbeddedDocuments) {
      throw new Error('No active scene available for level image visibility updates.');
    }
    const updates = [];
    for (const entry of markerEntries) {
      const levelId = String(entry?.markerLevelId || '').trim();
      const markerKind = String(entry?.markerKind || '').trim().toLowerCase();
      const level = scene.levels.get(levelId) || null;
      if (!level?.canUserModify?.(game.user, 'update')) continue;
      const update = { _id: levelId };
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.${getLevelTextureHiddenFlagKey(markerKind)}`, nextHidden);
      updates.push(update);
    }
    if (!updates.length) return;
    this._preserveListScrollTop(this._captureListScrollTop());
    const requiresCanvasRedraw = scene === canvas?.scene
      && !!canvas?.ready
      && markerEntries.some((entry) => {
        const levelId = String(entry?.markerLevelId || '').trim();
        const level = levelId ? scene.levels.get(levelId) || null : null;
        return !!level?.isView || !!level?.isVisible;
      });
    void scene.updateEmbeddedDocuments('Level', updates)
      .then(async () => {
        if (requiresCanvasRedraw) {
          await canvas.draw(scene);
        }
        Logger.info('LayerManager.sceneMarker.visibility.commit', {
          sceneId: scene?.id || null,
          markerCount: updates.length,
          hidden: nextHidden,
          redraw: requiresCanvasRedraw
        });
        this._scheduleRender();
        this._updateFlattenFooter();
      })
      .catch((error) => this._notifyLayerManagerActionError('toggle level image visibility', error));
  }

  _toggleLock(buttonEl) {
    const item = buttonEl?.closest?.('[data-tile-id]');
    if (!item) return;
    const tileId = item.dataset.tileId;
    if (!tileId) return;
    const tile = this._getTilePlaceable(tileId) || null;
    const doc = tile?.document || canvas?.scene?.tiles?.get?.(tileId) || null;
    const selectedDocs = this._getSelectedTileDocs();
    const selectedIds = new Set(selectedDocs.map((selectedDoc) => getTileDocumentId(selectedDoc)).filter(Boolean));
    const targets = selectedIds.has(getTileDocumentId(doc)) && selectedDocs.length > 1 ? selectedDocs : [doc];
    const rowSelected = item.classList?.contains('is-selected') || item.getAttribute?.('aria-selected') === 'true';
    if (rowSelected) this._preserveTileSelectionContextForNexus(targets, 'lock:rowButton:selectedRow');
    void this._toggleDocsLock(targets, { source: 'rowButton' })
      .catch((error) => this._notifyLayerManagerActionError('toggle layer lock', error));
  }

  _toggleElevationLock(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const elevationKey = String(buttonEl?.dataset?.elevationKey || separator?.dataset?.elevationKey || '').trim();
    if (!elevationKey) return;
    void this._toggleDocsLock(this._getMatchingElevationDocs(elevationKey), { source: 'elevationHeader' })
      .catch((error) => this._notifyLayerManagerActionError('toggle elevation lock', error));
  }

  _clearSceneMarkerSelection() {
    clearLayerManagerSceneMarkerSelection({
      selectedSceneMarkers: this._selectedSceneMarkers,
      scheduleRender: () => this._scheduleRender()
    });
  }

  _selectSceneMarker(markerEl, event = null) {
    const markerId = String(markerEl?.dataset?.sceneMarker || '').trim();
    selectLayerManagerSceneMarker({
      markerId,
      event,
      selectedSceneMarkers: this._selectedSceneMarkers,
      releaseAllTiles: () => canvas?.tiles?.releaseAll?.(),
      scheduleRender: () => this._scheduleRender(),
      updateFlattenFooter: () => this._updateFlattenFooter()
    });
  }

  _adjustSceneMarkerElevation(markerId, direction, step, pointer = null) {
    return adjustSceneMarkerElevationBlocked({
      markerId,
      viewEntries: this._viewState?.entries,
      direction,
      step,
      sceneId: canvas?.scene?.id || null,
      currentLevelId: getCurrentSceneLevel()?.id || null
    });
  }

  _selectElevation(separatorEl, event) {
    const elevationKey = String(separatorEl?.dataset?.elevationKey || '').trim();
    const docs = elevationKey ? this._getMatchingElevationDocs(elevationKey) : [];
    try {
      const retainSelection = !!(event?.ctrlKey || event?.metaKey);
      if (retainSelection && docs.length) {
        const controlledIds = new Set((Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : [])
          .map((tile) => tile?.document?.id || tile?.id)
          .filter(Boolean));
        const allSelected = docs.every((doc) => controlledIds.has(getTileDocumentId(doc)));
        if (allSelected) {
          this._releaseTileDocs(docs, {
            source: 'elevationHeader.meta',
            allowAutoExpand: false,
            allowScrollToTile: false
          });
          return;
        }
      }
      this._selectTileDocs(docs, {
        retainSelection,
        force: true,
        source: 'elevationHeader'
      });
    } catch (error) {
      this._notifyLayerManagerActionError('select elevation group', error);
    }
  }

  _selectCurrentLevelBand(markerEl = null) {
    const scene = canvas?.scene;
    if (!scene) {
      this._notifyLayerManagerActionError('select current level band', new Error('No active scene available.'));
      return;
    }
    const currentLevel = getCurrentSceneLevel(scene);
    const currentLevelId = String(currentLevel?.id || '').trim();
    const currentRange = getCurrentLevelElevationRange(scene);
    if (!currentLevelId || !currentRange) {
      this._notifyLayerManagerActionError('select current level band', new Error('No current level elevation band is available.'));
      return;
    }

    const docs = collectTileDocuments({ scene })
      .filter((doc) => isDocumentInCurrentLevelElevationBand(doc, { scene }));
    if (!docs.length) {
      Logger.info('LayerManager.levelBoundary.selection.noCurrentBandTiles', {
        sceneId: scene?.id || null,
        levelId: currentLevelId,
        markerId: String(markerEl?.dataset?.levelBoundary || '').trim() || null
      });
      return;
    }

    try {
      this._selectTileDocs(docs, {
        retainSelection: false,
        force: true,
        source: 'levelBoundary.selectBand'
      });
    } catch (error) {
      this._notifyLayerManagerActionError('select current level band', error);
    }
  }

  _toggleCurrentLevelBandIsolation(markerEl = null) {
    const scene = canvas?.scene;
    if (!scene) {
      this._notifyLayerManagerActionError('toggle current level visibility', new Error('No active scene available.'));
      return;
    }
    const currentLevel = getCurrentSceneLevel(scene);
    const currentLevelId = String(currentLevel?.id || '').trim();
    const currentRange = getCurrentLevelElevationRange(scene);
    if (!currentLevelId || !currentRange) {
      this._notifyLayerManagerActionError('toggle current level visibility', new Error('No current level elevation band is available.'));
      return;
    }

    const docs = collectTileDocuments()
      .filter((doc) => !isDocumentInCurrentLevelElevationBand(doc, { scene }));
    if (!docs.length) {
      Logger.info('LayerManager.levelBoundary.visibility.noOutOfBandTiles', {
        sceneId: scene?.id || null,
        levelId: currentLevelId,
        markerId: String(markerEl?.dataset?.levelBoundary || '').trim() || null
      });
      return;
    }
    const nextHidden = docs.some((doc) => !isLayerHidden(doc));
    void this._toggleDocsVisibility(docs, {
      source: 'levelBoundary',
      nextHidden
    }).catch((error) => this._notifyLayerManagerActionError('toggle current level visibility', error));
  }

  _isDoubleContextClick(tileId) {
    const { isDouble, nextState } = resolveLayerManagerDoubleContextClick({
      tileId,
      lastContextClick: this._lastContextClick,
      thresholdMs: CONTEXT_DOUBLE_CLICK_MS
    });
    this._lastContextClick = nextState;
    return isDouble;
  }

  _openTileSettings(tile) {
    openLayerManagerTileSettings({
      tile,
      clickEventStub,
      user: game?.user
    });
  }

  _openSceneSettings() {
    openLayerManagerSceneSettings({
      scene: canvas?.scene
    });
  }

  _queueScrollToTile(tileId) {
    return queueLayerManagerScrollToTile({
      tileId,
      active: this.active,
      isPopout: this.isPopout,
      scrollQueued: this._scrollQueued,
      setScrollState: (patch) => this._applyScrollStatePatch(patch),
      getScrollTargetId: () => this._scrollTargetId,
      clearScrollTargetId: () => this._applyScrollStatePatch({ scrollTargetId: null }),
      requestFrame: requestAnimationFrame,
      scrollToTile: (targetId) => this._scrollToTile(targetId)
    });
  }

  _queueScrollToPreview(previewId) {
    return queueLayerManagerScrollToPreview({
      previewId,
      active: this.active,
      isPopout: this.isPopout,
      scrollPreviewQueued: this._scrollPreviewQueued,
      setPreviewScrollState: (patch) => this._applyPreviewScrollStatePatch(patch),
      getPreviewTargetId: () => this._scrollPreviewTargetId,
      clearPreviewTargetId: () => this._applyPreviewScrollStatePatch({ scrollPreviewTargetId: null }),
      requestFrame: requestAnimationFrame,
      scrollToPreview: (targetId) => this._scrollToPreview(targetId)
    });
  }

  _scrollToTile(tileId) {
    return scrollLayerManagerToTile({
      root: this.element,
      tileId
    });
  }

  _scrollToPreview(previewId) {
    return scrollLayerManagerToPreview({
      root: this.element,
      previewId
    });
  }

  _syncPreviewScroll() {
    return syncLayerManagerPreviewScroll({
      root: this.element,
      lastActivePreviewId: this._lastActivePreviewId,
      setLastActivePreviewId: (value) => { this._lastActivePreviewId = value; },
      queueScrollToPreview: (previewId) => this._queueScrollToPreview(previewId)
    });
  }

  _queueSelectionSyncFromCanvas(options = null) {
    if (options && typeof options === 'object') {
      this._setPendingCanvasSelectionSyncOptions(options);
    }
    if (this._canvasSelectionSyncQueued) return true;
    this._canvasSelectionSyncQueued = true;
    const flush = () => {
      this._canvasSelectionSyncQueued = false;
      const nextOptions = this._pendingCanvasSelectionSyncOptions;
      this._pendingCanvasSelectionSyncOptions = null;
      this._syncSelectionFromCanvas(null, null, nextOptions);
    };
    try {
      requestAnimationFrame(flush);
    } catch (_) {
      try { queueMicrotask(flush); } catch (_) { flush(); }
    }
    return true;
  }

  _syncSelectionFromCanvas(tile = null, controlled = null, options = null) {
    return syncLayerManagerSelectionFromCanvas({
      root: this.element,
      tile,
      controlled,
      getSelectedTileDocs: () => this._getSelectedTileDocs(),
      expandElevationGroupsForDocs: (docs) => this._expandElevationGroupsForDocs(docs),
      queueScrollToTile: (tileId) => this._queueScrollToTile(tileId),
      scheduleRender: () => this._scheduleRender(),
      updateSelectionActions: () => this._updateSelectionActions(),
      updateFlattenFooter: () => this._updateFlattenFooter(),
      controlledTiles: canvas?.tiles?.controlled,
      allowAutoExpand: options?.allowAutoExpand !== false,
      allowScrollToTile: options?.allowScrollToTile !== false
    });
  }
}

try {
  Hooks.once('init', () => {
    ensureSceneLevelTextureVisibilityPatch();
    registerLayerManagerTab();
  });
} catch (_) {}

try {
  Hooks.once('canvasReady', () => {
    ensureTileReleaseAllPatch();
    ensureTileReleasePatch();
    ensureTileControlReleaseOthersPatch();
    ensureTileSelectionPatch();
    ensureTileSelectAllPatch();
    ensureTileForegroundSelectionPatch();
    ensureTileHoverSuppressionPatch();
    ensureCanvasHighlightSuppressionPatch();
    ensureLayerHiddenHooks();
  });
} catch (_) {}
