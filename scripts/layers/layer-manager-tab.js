import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { onFoundryBoot } from '../core/foundry-boot-hooks.js';
import { LAYER_MANAGER_TAB_ID, insertLayerManagerSidebarSlot } from './layer-manager-sidebar-slot.js';
import { isSceneGroupOperationBlocked, notifySceneGroupFailure } from '../composition/scene-group-notifications.js';
import { TileFlattenManager } from '../flatten/flatten-manager.js';
import {
  canLaunchFaNexusTileMask,
  getFaNexusTileEditMode,
  getFaNexusTileEditRefusal,
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
  isElevationWithinCurrentLevelEditScope,
  resolvePlacementAnchorTile
} from '../canvas/elevation-band-utils.js';
import { analyzeTileBandState } from '../canvas/tile-band-utils.js';
import { onCanvasReady } from '../canvas/canvas-readiness.js';
import {
  buildLayerHiddenUpdate,
  hasLayerHiddenChange,
  isLayerHidden
} from '../canvas/layer-hidden-state.js';
import { resolveTileDisplayName } from '../canvas/tile-display-name.js';
import { writeSceneDocumentDragData, writeLayerTreeDragData } from '../composition/scene-group-drag-data.js';
import { buildLayerManagerSceneTree } from '../composition/scene-group-layer-tree.js';
import { resolveSceneGroupDragSelection } from '../composition/scene-group-drag-selection.js';
import { sceneGroupInteractionRuntime } from '../composition/scene-group-interaction-runtime.js';
import { confirmDeleteSceneGroups, resolveStandaloneCompositeDeleteMembers } from '../composition/scene-group-delete-command.js';
import {
  SCENE_GROUP_INTERACTION_HOOK,
  sceneGroupInteractionState
} from '../composition/scene-group-interaction-state.js';
import {
  getSceneGroupInteractionIndex
} from '../composition/scene-group-interaction-resolver.js';
import {
  SCENE_GROUP_MEMBER_SELECTION_SETTING,
  buildSceneGroupMemberSelectionControl,
  deriveSceneGroupMemberPresentation,
  normalizeSceneGroupMemberSelectionMode,
  readSceneGroupMemberSelectionMode,
  resolveSceneGroupMemberSelection
} from '../composition/scene-group-member-selection.js';
import { isSceneGroupsEnabled } from '../core/feature-areas.js';
import {
  collectTileDocuments,
  collectTilePlaceables,
  mapTilePlaceablesById,
  resolveTileDocument,
  resolveTilePlaceable
} from '../canvas/tile-targets.js';
import { LayerManagerListInteractionController } from './layer-manager-list-interaction-controller.js';
import { routeLayerManagerRowHover } from './layer-manager-row-hover.js';
import {
  clearNexusTileSelectionContext,
  preserveTileSelectionDocumentsForNexus
} from '../canvas/tile-selection-context.js';
import { getFaNexusTileCapabilities } from '../canvas/tile-capabilities.js';
import { readDocumentHsbc } from '../core/hsbc.js';
import {
  clearStandardTileMask,
  getTransparentTextureSrc
} from '../textures/texture-render.js';
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
  setSceneElevationGroupMetadata
} from './model/elevation-group-metadata.js';
import {
  buildDisplayGroupingForEntry,
  buildGroundBandGroupKey,
  buildLayerManagerElevationHierarchy,
  buildNestedElevationPath,
  formatLayerManagerElevation,
  isEditableElevationGroupKey,
  isSyntheticDisplayGroupKey,
  synchronizeElevationGroupMetadataWithHierarchy
} from './layer-manager-hierarchy.js';
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
  buildLayerManagerSceneMarkerEntry as buildLayerManagerSceneMarkerEntryModel,
  buildLayerManagerTileEntry as buildLayerManagerTileEntryModel,
  getPrimaryCanvasSortLayers,
  normalizeRenderOrderValue,
  sortLayerManagerTileDocs
} from './model/render-entries.js';
import { materializeLayerManagerViewState, orderLayerManagerSectionDocuments } from './model/view-materialization.js';
import {
  applySceneLayerManagerSectionsLocally,
  cloneLayerManagerSections,
  getSceneLayerManagerSections,
  getSectionDescendantIds,
  getSectionMoveRootIds,
  getSectionTileIds,
  getTileSectionId,
  removeLayerManagerSection,
  sectionKey,
  setSceneLayerManagerSections,
  updateSceneLayerManagerSections
} from './model/section-metadata.js';
import {
  applyLayerManagerPreviewAnchorsAfterTileDrop,
  applyLayerManagerPreviewDropReorder,
  captureLayerManagerPreviewAnchorsForTileDrop,
  collectLayerManagerPreviewEntries,
  getLayerManagerPreviewEntryById
} from './layer-manager-preview-placement-bridge.js';
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
  buildGroupContextMenuItems as buildLayerManagerGroupContextMenuItems,
  buildSectionContextMenuItems as buildLayerManagerSectionContextMenuItems,
  buildTileContextMenuItems as buildLayerManagerTileContextMenuItems
} from './actions/context-menu-planner.js';
import {
  getContiguousSectionSlice,
  planElevationGroupToFolder,
  planHigherElevationShifts,
  planSectionPromotion,
  resolveSectionWrapSelection
} from './actions/section-actions.js';
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
import { createSelectionFilterLifecycle } from './actions/selection-filter-lifecycle.js';
import {
  applyDropIndicator as applyLayerManagerDropIndicator,
  applyDropReorder as applyLayerManagerDropReorder,
  clearDraggedRowState as clearLayerManagerDraggedRowState,
  clearDropIndicator as clearLayerManagerDropIndicator,
  getOrderedDocsByIds as getLayerManagerOrderedDocsByIds,
  handleListDragOver as handleLayerManagerListDragOver,
  prepareListDragStart as prepareLayerManagerListDragStart,
  resolveAdjacentElevationNudgeTarget as resolveLayerManagerAdjacentElevationNudgeTarget,
  resolveAdjacentSortDropTarget as resolveLayerManagerAdjacentSortDropTarget,
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
  LayerVisibilityCommandWorkflow,
  bulkLayerDocumentUpdateState
} from './actions/visibility-command-workflow.js';
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
import {
  SELECTION_FILTER_BLOCK_KEY,
  TILE_EVENT_MODE_EDIT_BLOCK_KEY,
  TILE_EVENT_MODE_HIDDEN_BLOCK_KEY,
  TILE_EVENT_MODE_SELECTION_BLOCK_KEY,
  applySelectionFilterInteractivity,
  clearTileEventModeBlocked,
  configureLayerSelectionInteractivityRuntime,
  ensureLayerSelectionInteractivityPatches,
  getMouseInteractionManager,
  markTileEventModeBlocked,
  pruneSelectionForFilter,
  refreshTileInteractionState,
  requestTileRefresh,
  restoreLayerManagerTileInteractivity,
  withBulkTileSelectionBatch
} from './layer-selection-interactivity-runtime.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { AbstractSidebarTab } = foundry.applications.sidebar;

const MODULE_ID = 'fa-nexus';
const TAB_ID = LAYER_MANAGER_TAB_ID;
const RANGE_MIN_SETTING = 'layerManagerElevationMin';
const RANGE_MAX_SETTING = 'layerManagerElevationMax';
const SKIP_LOCKED_SETTING = 'layerManagerSkipLocked';
const SKIP_HIDDEN_SETTING = 'layerManagerSkipHidden';
const SKIP_FILTERED_SETTING = 'layerManagerSkipFiltered';
const NESTED_GROUPING_SETTING = 'layerManagerNestedGrouping';
const LEVEL_BACKGROUND_IMAGE_HIDDEN_FLAG = 'layerManagerBackgroundImageHidden';
const LEVEL_FOREGROUND_IMAGE_HIDDEN_FLAG = 'layerManagerForegroundImageHidden';
const CONTEXT_DOUBLE_CLICK_MS = 350;
const ELEVATION_STEP_DEFAULT = 0.001;
const ELEVATION_STEP_FINE = 0.001;
const ELEVATION_STEP_COARSE = 0.1;
const FOLDER_HISTORY_OPTION = 'faNexusFolderHistory';
const EDITING_TILE_SET_KEYS = [
  '__faNexusTextureEditingTileIds',
  '__faNexusBuildingEditingTileIds',
  '__faNexusPathEditingTiles'
];

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

export function getTileFlattenManager() {
  if (!_tileFlattenManager) _tileFlattenManager = new TileFlattenManager();
  return _tileFlattenManager;
}

function formatElevation(value) {
  return formatLayerManagerElevation(value);
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
  return false;
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

const selectionFilterLifecycle = createSelectionFilterLifecycle({
  logger: Logger,
  getSceneKey: getCurrentSceneSessionKey,
  getListFilterFlagKeys: () => LIST_FILTER_FLAG_KEYS,
  getSessionState: getLayerManagerSessionState,
  listFiltersActive,
  parseListSearchQuery,
  getSortedTileDocs: getLayerManagerSortedTileDocs,
  getElevationGroupMetadata: getSceneElevationGroupMetadata,
  getSectionMetadata: getSceneLayerManagerSections,
  isNestedGroupingEnabled: isNestedLayerManagerGroupingEnabled,
  buildTileEntry: buildLayerManagerTileEntry,
  applyGroupSearchTextToEntries,
  applySectionSearchTextToEntries,
  entryMatchesListFilters,
  getElevationRangeFromSettings,
  refreshTileInteractionState
});
const selectionFilterState = selectionFilterLifecycle.state;
const invalidateSelectionListFilterCache = (...args) => selectionFilterLifecycle.invalidateListFilterCache(...args);
const syncSelectionListFilterCache = (...args) => selectionFilterLifecycle.syncListFilterCache(...args);
const placeableMatchesSelectionListFilters = (...args) => selectionFilterLifecycle.placeableMatchesListFilters(...args);
const selectionFilterActive = (...args) => selectionFilterLifecycle.active(...args);
const selectionSessionActive = () => !!selectionFilterState.active;
const elevationInRange = (...args) => selectionFilterLifecycle.elevationInRange(...args);

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
      if (meta?.sillTileId) hiddenIds.add(meta.sillTileId);
      if ([4, 5].includes(Number(data?.schemaVersion))) {
        for (const expected of Array.isArray(data?.runtime?.expectedGeneratedDocuments)
          ? data.runtime.expectedGeneratedDocuments
          : []) {
          if (expected?.documentName === 'Tile' && ['fill', 'sill'].includes(expected?.role) && expected?.documentId) {
            hiddenIds.add(String(expected.documentId));
          }
        }
      }
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
  const id = tile?.document?.id || tile?.id;
  if (!id) return false;
  if (hiddenIds instanceof Set) return hiddenIds.has(id);
  for (const key of EDITING_TILE_SET_KEYS) {
    const set = globalThis?.[key];
    if (set instanceof Set && set.has(id)) return true;
  }
  return false;
}

function isTilesLayerActive() {
  try {
    return !!canvas?.tiles && canvas?.activeLayer === canvas.tiles;
  } catch (_) {
    return false;
  }
}

function forceHideEditedTile(tile) {
  if (!tile || tile.destroyed || !isTileBeingEdited(tile)) return false;
  try {
    markTileEventModeBlocked(tile, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
    tile.visible = false;
    tile.alpha = 0;
    if (tile.mesh && tile.mesh.visible !== false) tile.mesh.visible = false;
    if (tile.bg && tile.bg.visible !== false) tile.bg.visible = false;
    if (tile.frame?.border) tile.frame.border.visible = false;
    return true;
  } catch (error) {
    Logger.error('LayerManager.editedTile.forceHide.failed', {
      tileId: tile?.document?.id || tile?.id || null,
      error: String(error?.message || error)
    });
    throw error;
  }
}

function restoreEditedTileFrame(tile) {
  if (!tile || tile.destroyed || isTileBeingEdited(tile)) return false;
  try {
    if (!isLayerHidden(tile?.document) && tile.frame?.visible === false) tile.frame.visible = true;
    clearTileEventModeBlocked(tile, TILE_EVENT_MODE_EDIT_BLOCK_KEY);
    return true;
  } catch (error) {
    Logger.error('LayerManager.editedTile.restoreFrame.failed', {
      tileId: tile?.document?.id || tile?.id || null,
      error: String(error?.message || error)
    });
    throw error;
  }
}

function shouldSuppressTileHover() {
  return !!selectionFilterState.active && isAltModifierActive() && isTilesLayerActive();
}

function clearTileHover({ source = 'unknown', updateLegend = true } = {}) {
  if (!canvas?.tiles) return 0;
  const failures = [];
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
    failures.push(error);
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
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `Layer Manager hover cleanup failed during ${source}.`);
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
  try {
    return game?.settings?.get?.(MODULE_ID, key) ?? '';
  } catch (error) {
    Logger.error('LayerManager.setting.read.failed', {
      key,
      error: String(error?.message || error)
    });
    throw error;
  }
}

function logSettingWriteFailure(key, value, error) {
  Logger.error('LayerManager.setting.write.failed', {
    key,
    value,
    error: String(error?.message || error)
  });
}

function writeSetting(key, value) {
  try {
    const result = game?.settings?.set?.(MODULE_ID, key, value);
    if (result && typeof result.then === 'function') {
      return result.catch((error) => {
        logSettingWriteFailure(key, value, error);
        throw error;
      });
    }
    return result;
  } catch (error) {
    logSettingWriteFailure(key, value, error);
    throw error;
  }
}

function getElevationRangeFromSettings() {
  const minRaw = readSetting(RANGE_MIN_SETTING);
  const maxRaw = readSetting(RANGE_MAX_SETTING);
  const skipLocked = !!readSetting(SKIP_LOCKED_SETTING);
  const skipHidden = !!readSetting(SKIP_HIDDEN_SETTING);
  const skipFiltered = !!readSetting(SKIP_FILTERED_SETTING);
  return {
    minRaw,
    maxRaw,
    min: parseElevationInput(minRaw),
    max: parseElevationInput(maxRaw),
    skipLocked,
    skipHidden,
    skipFiltered
  };
}

/** Canvas area capture uses the same persisted limits and current Tile list filter. */
export function getLayerManagerSelectionOptions() {
  const options=getElevationRangeFromSettings();
  const list=options.skipFiltered?syncSelectionListFilterCache({reason:'scene-group-capture'}):null;
  return {...options,matchingTileIds:list?.active?[...list.matchingIds]:null};
}

function readFaFlag(doc, key) {
  try {
    const direct = doc?.getFlag?.(MODULE_ID, key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
  return flags ? flags[key] : null;
}

function getLevelTextureHiddenFlagKey(kind = 'background') {
  return String(kind || '').trim().toLowerCase() === 'foreground'
    ? LEVEL_FOREGROUND_IMAGE_HIDDEN_FLAG
    : LEVEL_BACKGROUND_IMAGE_HIDDEN_FLAG;
}

function isLevelTextureMarkerHidden(level = null, kind = 'background') {
  return !!readFaFlag(level, getLevelTextureHiddenFlagKey(kind));
}

function shouldPreserveHiddenLevelTextureForCanvas(texture, kind = 'background') {
  return kind === 'background' && !!texture?.level?.isView;
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
      const visibleTextures = [];
      for (const texture of textures) {
        const kind = texture?.isBackground ? 'background' : 'foreground';
        if (!isLevelTextureMarkerHidden(texture?.level || null, kind)) {
          visibleTextures.push(texture);
          continue;
        }
        if (!shouldPreserveHiddenLevelTextureForCanvas(texture, kind)) continue;
        visibleTextures.push({
          ...texture,
          src: getTransparentTextureSrc()
        });
      }
      return visibleTextures;
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

const syncSelectionFilterFromSettings = (...args) => selectionFilterLifecycle.syncFromSettings(...args);

function canSelectPlaceable(placeable, { selectionActive = false, filterActive = false } = {}) {
  if (!placeable) return false;
  const elevation = Number(placeable?.document?.elevation ?? 0);
  if (selectionActive) {
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

configureLayerSelectionInteractivityRuntime({
  getSelectionFilterState: () => selectionFilterState,
  selectionSessionActive,
  selectionFilterActive,
  canSelectPlaceable,
  isTilesLayerActive,
  isTileBeingEdited,
  isLayerHidden,
  collectTilePlaceables,
  forceHideEditedTile,
  restoreEditedTileFrame,
  shouldSuppressTileHover,
  clearTileHover,
  renderTileSelectionSidebar
});

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
      const selectionActive = selectionSessionActive();
      const tiles = collectTilePlaceables();
      if (!selectionActive) {
        for (const tile of tiles) {
          const id = tile?.document?.id || tile?.id;
          if (targetIds && !targetIds.has(id)) continue;
          const needsSelectionCleanup = !!(
            tile?.[SELECTION_FILTER_BLOCK_KEY]
            || tile?.[TILE_EVENT_MODE_SELECTION_BLOCK_KEY]
          );
          const needsEditCleanup = !!tile?.[TILE_EVENT_MODE_EDIT_BLOCK_KEY];
          if (!needsSelectionCleanup && !needsEditCleanup) continue;
          if (needsEditCleanup) {
            if (isTileBeingEdited(tile)) forceHideEditedTile(tile);
            else restoreEditedTileFrame(tile);
          }
          if (needsSelectionCleanup) {
            applySelectionFilterInteractivity(tile, { selectionActive: false, filterActive: false });
          }
          requestTileRefresh(tile);
        }
        return;
      }
      if (resyncSettings) syncSelectionFilterFromSettings();
      const filterActive = selectionFilterActive();
      for (const tile of tiles) {
        const id = tile?.document?.id || tile?.id;
        if (targetIds && !targetIds.has(id)) continue;
        requestTileRefresh(tile);
        if (isTileBeingEdited(tile)) forceHideEditedTile(tile);
        else if (tile?.[TILE_EVENT_MODE_EDIT_BLOCK_KEY]) restoreEditedTileFrame(tile);
        applySelectionFilterInteractivity(tile, { selectionActive, filterActive });
      }
      refreshTileInteractionState();
      pruneSelectionForFilter();
      getMouseInteractionManager()?.emulateMoveEvent?.();
      Logger.trace('layerSelectionFilter', 'LayerManager.selectionFilter.refresh', {
        reason,
        source,
        tileIds: normalizedTileIds,
        active: selectionFilterState.active,
        filterActive,
        skipFiltered: selectionFilterState.skipFiltered
      });
    } catch (error) {
      Logger.error('LayerManager.selectionFilter.refresh.failed', {
        reason,
        source,
        tileIds: normalizedTileIds,
        error: String(error?.message || error)
      });
      throw error;
    }
  };

  refresh();
}

function applySectionSearchTextToEntries(entries = [], sectionMetadata = {}) {
  const sections = sectionMetadata?.sections || {};
  const memberships = sectionMetadata?.memberships || {};
  const namesFor = (sectionId) => {
    const names = [];
    const visited = new Set();
    let id = String(sectionId || '').trim();
    while (id && sections[id] && !visited.has(id)) {
      visited.add(id);
      names.push(String(sections[id].name || '').trim());
      id = String(sections[id].parentId || '').trim();
    }
    return names.filter(Boolean);
  };
  for (const entry of entries) {
    const tileId = String(entry?.id || '').trim();
    if (!tileId) continue;
    const sectionId = String(memberships[tileId] || '').trim();
    entry.sectionId = sectionId || null;
    if (!sectionId) continue;
    entry.searchText = [entry.searchText, ...namesFor(sectionId)].filter(Boolean).join(' ').toLowerCase();
  }
  return entries;
}

function getElevationBandIdentity(elevationKey) {
  const key = String(elevationKey || '').trim();
  const match = /^(ground|foreground):([^:]+):/.exec(key);
  return match ? `${match[1]}:${match[2]}` : 'normal';
}

function buildSiblingElevationKey(sourceKey, elevation) {
  const exactKey = elevationGroupKey(elevation);
  const match = /^(ground|foreground):([^:]+):/.exec(String(sourceKey || '').trim());
  return match ? `${match[1]}:${match[2]}:${exactKey}` : exactKey;
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
  return resolveTileDisplayName(tile, index);
}

function buildSceneMarkerEntry(texture, index = 0) {
  return buildLayerManagerSceneMarkerEntryModel(texture, index, {
    quantizeElevation,
    elevationGroupKey,
    isLevelTextureMarkerHidden,
    user: game?.user,
    getSortLayers: getPrimaryCanvasSortLayers
  });
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
    const rootDropElevationKey = boundaryKind === 'B'
      ? `ground:${currentLevelId}:${boundaryKey}`
      : '';
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
      levelBoundaryRootDropTarget: !!rootDropElevationKey,
      levelBoundaryRootDropElevationKey: rootDropElevationKey,
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
  if (['building-preview', 'building-fill-preview', 'building-sills-preview'].includes(kind)) {
    return tabs.buildings?.buildingManager || null;
  }
  return null;
}

function resolveTexturePaintManager() {
  const tabs = getFaNexusTabs();
  return tabs?.textures?.texturePaintManager || null;
}

function buildEntriesFromCanvas(options = {}) {
  const sessionState = options?.sessionState || getLayerManagerSessionState();
  const parsedQuery = options?.parsedQuery || parseListSearchQuery(sessionState?.searchQuery || '');
  const rawElevationGroupMetadata = options?.elevationGroupMetadata || getSceneElevationGroupMetadata();
  const sectionMetadata = options?.sectionMetadata || getSceneLayerManagerSections();
  const selectedSectionIds = options?.selectedSectionIds instanceof Set
    ? options.selectedSectionIds
    : new Set();
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
      matchingTileIdsBySection: new Map(),
      fullSectionDocsById: new Map(),
      fullTileDocsById: new Map(),
      fullTileGroupKeyById: new Map(),
      fullTileIdsInOrder: [],
      fullExactGroupElevationsByKey: new Map(),
      fullElevationGroups: new Map(),
      fullGroupDocsByKey: new Map(),
      fullGroupHierarchy: emptyHierarchy,
      matchingGroupHierarchy: emptyHierarchy,
      elevationGroupMetadata: rawElevationGroupMetadata,
      sectionMetadata,
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
  const sceneGroupState = sceneGroupInteractionState.snapshot(canvas.scene);
  const sceneGroupIndex = getSceneGroupInteractionIndex(canvas.scene);
  const sceneGroupMode = readSceneGroupMemberSelectionMode();
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
    entry.sceneGroupMembership = deriveSceneGroupMemberPresentation({
      documentUuid: doc?.uuid,
      mode: sceneGroupMode,
      index: sceneGroupIndex,
      selectedGroupIds: sceneGroupState.selectedGroupIds
    });
    entry.sceneGroupMember = entry.sceneGroupMembership.selectedGroupMember;
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
  applySectionSearchTextToEntries(tileEntries, sectionMetadata);

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

  const previewEntries = collectLayerManagerPreviewEntries();
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
  const supplementalEntries = previewEntries.concat(markerEntries);
  const fullElevationGroups = new Map(
    Array.from(fullExactGroups.entries()).map(([key, group]) => [key, group.docs.slice()])
  );
  let elevationGroupMetadata = rawElevationGroupMetadata;
  let elevationGroupMetadataDirty = false;
  let staleSyntheticMetadataKeys = [];
  let fullGroupHierarchy = emptyHierarchy;
  let matchingGroupHierarchy = emptyHierarchy;
  const hierarchy = buildLayerManagerElevationHierarchy({
    fullExactGroups,
    matchingExactGroups,
    resolvePathForGroup: (group) => Array.isArray(group?.path) ? group.path.slice() : [],
    logger: Logger
  });
  const metadataSync = synchronizeElevationGroupMetadataWithHierarchy(rawElevationGroupMetadata, hierarchy.fullVisible);
  elevationGroupMetadata = metadataSync.metadata;
  elevationGroupMetadataDirty = metadataSync.changed;
  staleSyntheticMetadataKeys = metadataSync.staleSyntheticKeys.slice();
  fullGroupHierarchy = hierarchy.fullVisible;
  matchingGroupHierarchy = hierarchy.matchingVisible;
  const collapsedStateSync = reconcileLayerManagerCollapsedState({
    sessionState,
    hierarchy: hierarchy.fullVisible,
    extraVisibleKeys: Object.keys(sectionMetadata?.sections || {}).map(sectionKey)
  });
  if (collapsedStateSync.changed) {
    Logger.info('LayerManager.collapsedState.reconciled', {
      sceneId: canvas?.scene?.id || null,
      staleSyntheticKeys: collapsedStateSync.staleSyntheticKeys
    });
    queuePersistLayerManagerCollapsedState();
  }

  const materializedViewState = materializeLayerManagerViewState({
    hierarchy,
    sessionState,
    elevationGroupMetadata,
    sectionMetadata,
    supplementalEntries,
    levelBoundaryEntries,
    nestedGrouping,
    formatElevation,
    getElevationGroupName,
    isLayerHidden,
    resolveSharedTopBoundaryUpperGroundBandKey: ({ levelId, elevation }) => getSharedTopBoundaryUpperGroundBandKey({
      scene: canvas?.scene,
      levelId,
      elevation
    }),
    selectedSectionIds,
    user: game?.user
  });
  const entries = materializedViewState.entries;
  const matchingTileIdsByElevation = materializedViewState.matchingTileIdsByElevation;
  const fullGroupDocsByKey = materializedViewState.fullGroupDocsByKey;
  const matchingTileIdsBySection = materializedViewState.matchingTileIdsBySection;
  const fullSectionDocsById = materializedViewState.fullSectionDocsById;

  return {
    entries,
    matchingTileIdsByElevation,
    matchingTileIdsBySection,
    fullSectionDocsById,
    fullTileDocsById,
    fullTileGroupKeyById,
    fullTileIdsInOrder,
    fullExactGroupElevationsByKey,
    fullElevationGroups,
    elevationGroupMetadata,
    sectionMetadata,
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

function registerLayerManagerTab() {
  try {
    insertLayerManagerSidebarSlot();
    if (!CONFIG.ui[TAB_ID]) CONFIG.ui[TAB_ID] = LayerManagerTab;
    // Loaded after Foundry built its interface (a slow host can deliver this module after init): Foundry created its
    // sidebar tabs from CONFIG.ui without this one, so create it and render it into the slot the sidebar holds for it.
    if (globalThis.ui?.sidebar && !globalThis.ui[TAB_ID]) {
      globalThis.ui[TAB_ID] = new LayerManagerTab();
      if (globalThis.ui.sidebar.rendered) {
        globalThis.ui.sidebar.render({ parts: [TAB_ID] }).catch((error) => {
          Logger.error('LayerManager.register.lateRender.failed', { error: String(error?.message || error) });
        });
      }
      Logger.info?.('LayerManager.register.late', { sidebarRendered: !!globalThis.ui.sidebar.rendered });
    }
    syncSelectionFilterFromSettings();
    ensureSelectionFilterRefreshHook();
    ensureLayerSelectionInteractivityPatches();
    ensureLayerHiddenHooks();
  } catch (error) {
    Logger.error('LayerManager.register.failed', { error: String(error?.message || error) });
    throw error;
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
      body: { template: 'modules/fa-nexus/templates/tool-options/tool-help-modal.hbs' }
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
      template: 'modules/fa-nexus/templates/layers/layer-manager-tab.hbs',
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
    this._selectedSectionIds = new Set();
    this._lastElevationAnnounce = 0;
    this._elevationAnnounceTimer = null;
    this._pendingElevationAnnouncePoint = null;
    this._pendingElevationAnnounceMessage = null;
    this._renamingTileId = null;
    this._renameDraft = '';
    this._renameFocusPending = false;
    this._renameSubmitting = false;
    this._editingSectionNameId = null;
    this._editingSectionNameDraft = '';
    this._editingSectionNameFocusPending = false;
    this._editingSectionNameSubmitting = false;
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
    this._sortNudgeQueue = Promise.resolve();
    this._folderHistoryQueue = Promise.resolve();
    this._folderHistoryCaptureDepth = 0;
    this._folderHistoryRenderPending = false;
    this._folderHistoryRedo = [];
    this._folderHistoryRestoring = false;
    // Layers that left a Folder only because their Elevation changed or they were deleted: tileId -> { sceneId, sectionId }.
    // Undo brings such a Tile back; this puts it back into its Folder. Kept for the session, like the Undo history.
    this._formerSectionMemberships = new Map();
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
    this._listInteractionController = new LayerManagerListInteractionController(this);
    this._visibilityWorkflow = new LayerVisibilityCommandWorkflow({
      getTileDocumentId,
      isLayerHidden,
      buildLayerHiddenUpdate,
      requireMutableTileDocuments,
      getLevelTextureHiddenFlagKey,
      orderTileDocuments: (docs) => this._orderTileDocuments(docs),
      getScene: () => canvas?.scene || null,
      getSelectedTileDocIds: () => this._getSelectedTileDocIds(),
      orderDocsByIds: (ids) => this._getOrderedDocsByIds(ids),
      preserveSelectionContext: (docs, source) => this._preserveTileSelectionContextForNexus(docs, source),
      captureListScrollTop: () => this._captureListScrollTop(),
      preserveListScrollTop: (scrollTop) => this._preserveListScrollTop(scrollTop),
      updateTileDocuments: (updates, options) => canvas.scene.updateEmbeddedDocuments('Tile', updates, options),
      storeTileHistory: (data) => canvas.tiles.storeHistory('update', data),
      updateLevelDocuments: (scene, updates) => scene.updateEmbeddedDocuments('Level', updates),
      drawCanvas: (scene) => canvas.draw(scene),
      isCanvasReady: () => !!canvas?.ready,
      getViewEntries: () => this._viewState?.entries || [],
      scheduleRender: () => this._scheduleRender(),
      restoreSelectionAfterBulkTileUpdate: (ids, options) => this._restoreSelectionAfterBulkTileUpdate(ids, options),
      updateSelectionActions: () => this._updateSelectionActions(),
      updateFlattenFooter: () => this._updateFlattenFooter(),
      notifyActionError: (action, error) => this._notifyLayerManagerActionError(action, error)
    });
  }

  get title() {
    return 'Layer Manager';
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
    this._selectedSectionIds?.clear?.();
    // Keep document hooks alive while another sidebar tab owns the placement UI.
    // Section inheritance and reconciliation must continue after leaving this tab.
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
    this._selectedSectionIds?.clear?.();
    this._removeHooks();
    return super._onClose(options);
  }

  async _prepareContext() {
    const { minRaw, maxRaw, skipLocked, skipHidden, skipFiltered } = getElevationRangeFromSettings();
    const sessionState = getLayerManagerSessionState();
    const parsedQuery = parseListSearchQuery(sessionState.searchQuery || '');
    const flattenState = this._getFlattenState();
    const elevationGroupMetadata = getSceneElevationGroupMetadata();
    const sectionMetadata = getSceneLayerManagerSections();
    for (const sectionId of Array.from(this._selectedSectionIds || [])) {
      if (!sectionMetadata?.sections?.[sectionId]) this._selectedSectionIds.delete(sectionId);
    }
    const viewState = buildEntriesFromCanvas({
      sessionState,
      parsedQuery,
      elevationGroupMetadata,
      sectionMetadata,
      selectedSectionIds: new Set(this._selectedSectionIds || [])
    });
    if (selectionFilterState.skipFiltered) syncSelectionListFilterCache({ reason: 'prepare-context' });
    const entries = viewState.entries;
    this._viewState = viewState;
    if (viewState?.elevationGroupMetadataDirty) {
      this._queueElevationGroupMetadataSync(viewState.elevationGroupMetadata);
    }
    let renameFound = false;
    let folderNameEditFound = false;
    let groupNameEditFound = false;
    let groupElevationEditFound = false;
    for (const entry of entries) {
      if (entry?.section && entry.sectionId === this._editingSectionNameId) {
        entry.editingFolderName = true;
        entry.folderNameValue = this._editingSectionNameDraft;
        folderNameEditFound = true;
      }
      if (entry?.separator && !entry?.levelBoundarySeparator && !entry?.section) {
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
    if (this._editingSectionNameId && !folderNameEditFound) this._clearSectionNameEditState();
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
    const sceneGroupMemberSelection = buildSceneGroupMemberSelectionControl(
      this._readSceneGroupMemberSelectionMode()
    );
    return {
      canvasReady: !!canvas?.ready,
      elevationMin: minRaw,
      elevationMax: maxRaw,
      skipLocked,
      skipHidden,
      skipFiltered,
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
      sceneGroupMemberSelection,
      sceneGroupsEnabled: isSceneGroupsEnabled(),
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
    if (this.active || this.isPopout) this._ensureHooks();
    const root = this.element;
    if (!root) return;
    this._listInteractionController.bindRender(root);

    this._updateSelectionActions();
    this._updateFlattenFooter();
    if (this._suppressPreviewAutoScrollOnce) this._suppressPreviewAutoScrollOnce = false;
    else this._syncPreviewScroll();
    this._restorePreservedListScrollTop();
    this._syncHelpWindow({ suppressRender: false });
  }

  _readSceneGroupMemberSelectionMode() {
    try {
      return readSceneGroupMemberSelectionMode();
    } catch (error) {
      this._notifyLayerManagerActionError('read Scene Member Selection Mode', error);
      return normalizeSceneGroupMemberSelectionMode(null);
    }
  }

  _setSceneGroupMemberSelectionMode(value) {
    const mode = normalizeSceneGroupMemberSelectionMode(value);
    Promise.resolve(game?.settings?.set?.(
      MODULE_ID,
      SCENE_GROUP_MEMBER_SELECTION_SETTING,
      mode
    )).catch((error) => {
      this._notifyLayerManagerActionError('save Scene Member Selection Mode', error);
    });
  }

  _bindSelectionFilterControls({ minInput, maxInput, skipLockedInput, skipHiddenInput, skipFilteredInput } = {}) {
    this._attachSelectionFilterOptionChange(minInput, 'update selection filter range', () => this._onRangeChange());
    if (minInput) minInput.addEventListener('input', () => this._onRangeChange(true));

    this._attachSelectionFilterOptionChange(maxInput, 'update selection filter range', () => this._onRangeChange());
    if (maxInput) maxInput.addEventListener('input', () => this._onRangeChange(true));

    this._attachSelectionFilterOptionChange(skipLockedInput, 'toggle skip locked selection filter', () => this._onSkipLockedChange());
    this._attachSelectionFilterOptionChange(skipHiddenInput, 'toggle skip hidden selection filter', () => this._onSkipHiddenChange());
    this._attachSelectionFilterOptionChange(skipFilteredInput, 'toggle skip filtered selection filter', () => this._onSkipFilteredChange());
  }

  _bindInlineEditInputs({ renameInput, folderNameInput, groupNameInput, groupElevationInput } = {}) {
    this._bindInlineEditInput(renameInput, {
      onInput: (value) => { this._renameDraft = value; },
      onKeyDown: (event) => this._onRenameInputKeyDown(event),
      commit: (inputEl) => this._commitRename(inputEl),
      onCommitError: (error) => {
        Logger.warn('LayerManager.rename.failed', { error: String(error?.message || error) });
        ui?.notifications?.error?.(`Failed to rename tile: ${error?.message || error}`);
      },
      focusPending: this._renameFocusPending,
      clearFocusPending: () => { this._renameFocusPending = false; }
    });

    this._bindInlineEditInput(folderNameInput, {
      onInput: (value) => { this._editingSectionNameDraft = value; },
      onKeyDown: (event) => this._onSectionNameInputKeyDown(event),
      commit: (inputEl) => this._commitSectionNameEdit(inputEl),
      onCommitError: (error) => this._notifyLayerManagerActionError('rename Folder', error),
      focusPending: this._editingSectionNameFocusPending,
      clearFocusPending: () => { this._editingSectionNameFocusPending = false; }
    });

    this._bindInlineEditInput(groupNameInput, {
      onInput: (value) => { this._editingElevationGroupNameDraft = value; },
      onKeyDown: (event) => this._onElevationGroupNameInputKeyDown(event),
      commit: (inputEl) => this._commitElevationGroupNameEdit(inputEl),
      onCommitError: (error) => {
        Logger.error('LayerManager.elevationGroup.rename.failed', {
          elevationKey: this._editingElevationGroupNameKey || null,
          error: String(error?.message || error)
        });
        ui?.notifications?.error?.(`Failed to rename elevation group: ${error?.message || error}`);
      },
      focusPending: this._editingElevationGroupNameFocusPending,
      clearFocusPending: () => { this._editingElevationGroupNameFocusPending = false; }
    });

    this._bindInlineEditInput(groupElevationInput, {
      onInput: (value) => { this._editingElevationGroupElevationDraft = value; },
      onKeyDown: (event) => this._onElevationGroupElevationInputKeyDown(event),
      commit: (inputEl) => this._commitElevationGroupElevationEdit(inputEl),
      onCommitError: (error) => {
        Logger.error('LayerManager.elevationGroup.move.failed', {
          elevationKey: this._editingElevationGroupElevationKey || null,
          error: String(error?.message || error)
        });
        ui?.notifications?.error?.(`Failed to move elevation group: ${error?.message || error}`);
      },
      focusPending: this._editingElevationGroupElevationFocusPending,
      clearFocusPending: () => { this._editingElevationGroupElevationFocusPending = false; }
    });
  }

  _restoreSearchFocus(searchInput) {
    if (!searchInput || !this._searchFocusPending) return;
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

  _onFlattenFooterClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const manager = getTileFlattenManager();
    const state = this._getFlattenState();
    this._updateFlattenFooter();
    if (state.action === 'deconstruct') {
      const selection = TileFlattenManager.getSelectedTiles();
      const doc = Array.isArray(selection) ? selection[0] : null;
      if (!doc) return;
      this._runFlattenFooterAction(
        () => manager.confirmAndDeconstructTile(doc),
        'LayerManager.deconstruct.failed',
        'Failed to deconstruct tile'
      );
      return;
    }
    if (state.action === 'export') {
      this._runFlattenFooterAction(
        () => manager.showExportDialog(),
        'LayerManager.export.failed',
        'Failed to export scene'
      );
      return;
    }
    this._runFlattenFooterAction(
      () => manager.showFlattenDialog(),
      'LayerManager.flatten.failed',
      'Failed to flatten tiles'
    );
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

  _runFlattenFooterAction(promiseFactory, logKey, messagePrefix) {
    promiseFactory().catch((error) => {
      Logger.warn(logKey, { error: String(error?.message || error) });
      ui?.notifications?.error?.(`${messagePrefix}: ${error?.message || error}`);
    }).finally(() => {
      this._updateFlattenFooter();
    });
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
    const menuItems = Array.isArray(items) ? items.filter((item) => item && (item.label || item.separator)) : [];
    if (!menuItems.length) return;
    this._closeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'fa-nexus-layer-manager__context-menu';
    menu.setAttribute('role', 'menu');

    const appendItem = (parent, item) => {
      if (item.separator) {
        const separator = document.createElement('div');
        separator.className = 'fa-nexus-context-menu-separator'; separator.setAttribute('role','separator');
        parent.append(separator); return;
      }
      if (item.children?.length) {
        const section = document.createElement('details');
        section.className = 'fa-nexus-layer-manager__context-subgroup';
        const summary = document.createElement('summary');
        summary.className = 'fa-nexus-layer-manager__context-menu-item';
        summary.setAttribute('aria-label', item.label);
        const icon = document.createElement('i');
        icon.className = `${item.iconClass} fa-nexus-layer-manager__context-menu-item-icon`;
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = item.label;
        label.className = 'fa-nexus-layer-manager__context-menu-item-label';
        const arrow = document.createElement('i');
        arrow.className = 'fa-solid fa-chevron-right';
        arrow.setAttribute('aria-hidden', 'true');
        summary.append(icon, label, arrow);
        section.append(summary);
        for (const child of item.children) appendItem(section, child);
        section.addEventListener('toggle', () => {
          if (!section.open) return;
          for (const sibling of menu.querySelectorAll('details')) if (sibling !== section) sibling.open = false;
          menu.style.top = `${Math.max(8, Math.min(parseFloat(menu.style.top) || 8, innerHeight - menu.offsetHeight - 8))}px`;
        });
        parent.append(section);
        return;
      }
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
          Logger[isSceneGroupOperationBlocked(error) ? 'debug' : (error?.userMessage ? 'warn' : 'error')]('LayerManager.contextMenu.action.failed', {
            label: item.label,
            identities: error?.identities || [],
            error: String(error?.message || error)
          });
          if (error?.name === 'SceneGroupWorkflowError') notifySceneGroupFailure(error, `Failed to ${String(item.label || 'run action').toLowerCase()}`);
          // A refusal that already says why in the user's words (for example Nexus Edit without the Pro tools).
          else if (error?.userMessage) ui?.notifications?.warn?.(error.userMessage);
          else {
            // The item's own sentence names the action; the reason always follows it.
            const lead = item.errorMessage ? String(item.errorMessage).replace(/[.\s]+$/, '') : `Failed to ${String(item.label || 'run action').toLowerCase()}`;
            ui?.notifications?.error?.(`${lead}: ${error?.message || error}`);
          }
        }
      });
      parent.appendChild(button);
    };
    for (const item of menuItems) appendItem(menu, item);

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
      if (keyEvent?.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopImmediatePropagation();
      this._closeContextMenu();
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
        { label: 'Multi-select', binding: 'Ctrl/Cmd+Click', description: 'Add or remove a layer or Folder header from the current selection.' },
        { label: 'Select Folder Contents', binding: 'Ctrl/Cmd+Shift+Click', description: 'Select or deselect every visible layer inside a Folder.' },
        { label: 'Range Select', binding: 'Shift+Click', description: 'Select a contiguous range of visible layers.' },
        { label: 'Rename Layer or Folder', binding: 'F2', description: 'Rename the currently selected layer or Folder.' },
        { label: 'Rename Group', binding: 'Double Click', description: 'Rename an elevation group from its header.' },
        { label: 'Actions Menu', binding: 'Right Click', description: 'Open contextual actions for a layer or group.' },
        { label: 'Tile Sheet', binding: 'Double Right Click', description: 'Open the standard Foundry tile sheet for a layer row.' },
        { label: 'Reorder', binding: 'Drag', description: 'Drag layers onto rows or group headers to reorder or change elevation.' },
        { label: 'Fine Reorder', binding: 'Ctrl/Cmd+Alt+Wheel', description: 'Move the selected layer stack one position while keeping the pointer in place.' },
        { label: 'Elevation Wheel', binding: 'Alt+Wheel', description: 'Nudge selected layers or scene markers by one 0.001 depth level; Shift uses 0.1.' },
        { label: 'Elevation Keys', binding: 'Alt+[ / ] or Alt+Up / Down', description: 'Adjust the current layer-manager selection without relying on the mouse wheel.' }
      ],
      notes: [
        'Right-click headers for rename, lock, move, and flatten actions on matching group layers.',
        'Collapsed elevation groups remember state per scene and auto-expand to reveal canvas selections.',
        'Click selects a Folder header, Ctrl/Cmd+Click adds or removes the header, and Ctrl/Cmd+Shift+Click selects its contents.',
        'Selected Folders can be dragged into other Folders.',
        'With active filters, group lock and flatten act on matching layers only, and group elevation moves are blocked.',
        'Quick elevation nudging uses one 0.001 depth level by default and 0.1 with Shift.'
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
    Logger[isSceneGroupOperationBlocked(error) ? 'debug' : 'error'](`LayerManager.${key}.failed`, {
      sceneId: canvas?.scene?.id || null,
      identities: error?.identities || [],
      error: String(error?.message || error)
    });
    if (error?.name === 'SceneGroupWorkflowError') notifySceneGroupFailure(error, `Failed to ${action}`);
    else ui?.notifications?.error?.(`Failed to ${action}: ${error?.message || error}`);
  }

  _bindInlineEditInput(input, {
    onInput,
    onKeyDown,
    commit,
    onCommitError,
    focusPending = false,
    clearFocusPending
  } = {}) {
    if (!input) return;
    if (
      typeof onInput !== 'function'
      || typeof onKeyDown !== 'function'
      || typeof commit !== 'function'
      || typeof onCommitError !== 'function'
      || typeof clearFocusPending !== 'function'
    ) {
      throw new Error('Layer manager inline edit inputs require input, keydown, commit, error, and focus handlers.');
    }
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('dblclick', (event) => event.stopPropagation());
    input.addEventListener('contextmenu', (event) => event.stopPropagation());
    input.addEventListener('input', (event) => {
      onInput(event.currentTarget?.value ?? '', event);
    });
    input.addEventListener('keydown', (event) => onKeyDown(event));
    input.addEventListener('blur', (event) => {
      commit(event.currentTarget).catch((error) => {
        onCommitError(error);
      });
    });
    if (focusPending) {
      clearFocusPending();
      requestAnimationFrame(() => {
        try {
          input.focus({ preventScroll: true });
          input.select();
        } catch (_) {}
      });
    }
  }

  _attachSelectionFilterOptionChange(input, action, callback) {
    if (!input) return;
    input.addEventListener('change', () => {
      this._runSelectionFilterOptionChange(action, callback).catch(() => {});
    });
  }

  async _runSelectionFilterOptionChange(action, callback) {
    try {
      return await callback?.();
    } catch (error) {
      this._notifyLayerManagerActionError(action, error);
      try {
        syncSelectionFilterFromSettings();
        await this.render({ parts: ['content'] });
      } catch (rollbackError) {
        Logger.error('LayerManager.selectionFilter.optionRollback.failed', {
          action,
          error: String(rollbackError?.message || rollbackError)
        });
      }
      throw error;
    }
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
      try { canvas?.tiles?.releaseAll?.({ renderSidebar: false }); } catch (error) {
        Logger.error('LayerManager.selection.releaseAll.failed', {
          sceneId: canvas?.scene?.id || null,
          source,
          error: String(error?.message || error)
        });
        throw error;
      }

      for (const doc of intendedDocs) {
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
    return this._visibilityWorkflow.toggleTileDocsVisibility(docs, { source, nextHidden, referenceDoc });
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
      selectTileDocs: (docs) => this._selectTileDocs(docs, {
        source: `elevation:${source}`,
        allowScrollToTile: false
      })
    });
  }

  async _applyDocsElevationChange(docs = [], targetElevation) {
    const previousPreservedListScrollTop = this._preservedListScrollTop;
    const previousSuppressPreviewAutoScrollOnce = this._suppressPreviewAutoScrollOnce;
    const listScrollTop = this._captureListScrollTop();
    this._preserveListScrollTop(listScrollTop);
    let changed = false;
    try {
      const result = await applyLayerManagerDocsElevationChange({
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
      changed = result?.updated === true;
      return changed;
    } catch (error) {
      changed = error?.faNexusLayerManagerElevationChangeState?.updated === true;
      throw error;
    } finally {
      if (changed) this._preserveListScrollTop(listScrollTop);
      else {
        this._preservedListScrollTop = previousPreservedListScrollTop;
        this._suppressPreviewAutoScrollOnce = previousSuppressPreviewAutoScrollOnce;
      }
    }
  }

  _getSelectedTileDocs({ visibleOnly = false } = {}) {
    const editedIds = collectEditedTileIds();
    return getLayerManagerSelectedTileDocs({
      root: this.element,
      viewState: this._viewState,
      visibleOnly,
      controlledTiles: canvas?.tiles?.controlled
    }).filter((doc) => !editedIds.has(String(doc?.id || doc?._id || '')));
  }

  _getSelectedSectionDocs() {
    return uniqueTileDocuments(Array.from(this._selectedSectionIds || [])
      .flatMap((sectionId) => this._getFullSectionDocs(sectionId)));
  }

  _getSelectionActionState() {
    const tileDocs = this._getSelectedTileDocs();
    const state = buildLayerManagerSelectionActionState(
      uniqueTileDocuments([...tileDocs, ...this._getSelectedSectionDocs()]),
      { user: game?.user }
    );
    state.deleteDisabled = buildLayerManagerSelectionActionState(tileDocs, { user: game?.user }).deleteDisabled;
    return state;
  }

  _updateSelectionActions() {
    const root = this.element;
    if (!root) return;
    applyLayerManagerSelectionActionState(root, this._getSelectionActionState());
  }

  async _toggleSelectionLock() {
    try {
      await this._toggleDocsLock(
        uniqueTileDocuments([...this._getSelectedTileDocs(), ...this._getSelectedSectionDocs()]),
        { source: 'selectionToolbar' }
      );
    } catch (error) {
      this._notifyLayerManagerActionError('toggle selected layer lock', error);
    }
  }

  async _deleteSelection() {
    const docs = this._getSelectedTileDocs();
    if (!docs.length) return false;
    try {
      // A registered Building or Path is one composite. Deleted natively, its generated parts
      // go as separate Undo entries per layer and Ctrl+Z brings back pieces: a Root with no
      // Walls and no ownership. It is deleted through the same command as the Delete key.
      const memberUuids = resolveStandaloneCompositeDeleteMembers(canvas?.scene, docs);
      if (memberUuids) {
        const deleted = await confirmDeleteSceneGroups({ scene: canvas.scene, groupIds: [], memberUuids });
        this._updateSelectionActions();
        return !!deleted;
      }
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (!DialogV2?.confirm) throw new Error('Foundry DialogV2.confirm is unavailable.');
      const count = docs.length;
      const confirmed = await DialogV2.confirm({
        window: { title: count === 1 ? 'Delete Layer' : 'Delete Layers' },
        content: `<p>Delete ${count} selected ${count === 1 ? 'layer' : 'layers'}? This cannot be undone.</p>`,
        modal: true,
        rejectClose: false,
        yes: { icon: 'fas fa-trash', label: 'Delete' },
        no: { icon: 'fas fa-times', label: 'Cancel' }
      });
      if (!confirmed) return false;
      const confirmedIds = new Set(docs.map((doc) => String(doc?.id || '')).filter(Boolean));
      const currentDocs = this._getSelectedTileDocs().filter((doc) => confirmedIds.has(String(doc?.id || '')));
      if (!currentDocs.length) return false;
      return await deleteSelectedDocs({
        docs: currentDocs,
        user: game?.user,
        deleteEmbeddedDocuments: canvas?.scene?.deleteEmbeddedDocuments?.bind(canvas.scene),
        onSelectionActionsUpdated: () => this._updateSelectionActions()
      });
    } catch (error) {
      this._notifyLayerManagerActionError('delete selected layers', error);
      return false;
    }
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

  _toggleSectionCollapse(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const sectionId = String(buttonEl?.dataset?.sectionId || separator?.dataset?.sectionId || '').trim();
    const key = sectionKey(sectionId);
    if (!key) return;
    toggleLayerManagerElevationGroupCollapsed({
      sessionState: this._getSessionState(),
      elevationKey: key,
      persistCollapsedState: queuePersistLayerManagerCollapsedState
    });
    this._scheduleRender();
  }

  _expandElevationGroupsForDocs(docs = []) {
    const result = expandLayerManagerElevationGroupsForDocs({
      docs,
      viewState: this._viewState,
      sessionState: this._getSessionState(),
      elevationGroupKey,
      resolveDocumentGroupKey: (doc) => this._resolveDisplayElevationKeyForDoc(doc),
      persistCollapsedState: queuePersistLayerManagerCollapsedState
    });
    const keysToExpand = new Set(result.keysToExpand || []);
    const state = this._getSessionState();
    const metadata = this._viewState?.sectionMetadata || getSceneLayerManagerSections();
    for (const doc of docs) {
      const visited = new Set();
      let sectionId = getTileSectionId(metadata, getTileDocumentId(doc));
      while (sectionId && metadata.sections?.[sectionId] && !visited.has(sectionId)) {
        visited.add(sectionId);
        keysToExpand.add(sectionKey(sectionId));
        sectionId = metadata.sections[sectionId].parentId || null;
      }
    }
    let sectionChanged = false;
    for (const key of keysToExpand) {
      if (!String(key).startsWith('section:')) continue;
      if (state?.collapsedElevations?.delete?.(key)) sectionChanged = true;
    }
    if (sectionChanged) queuePersistLayerManagerCollapsedState();
    const changed = result.changed || sectionChanged;
    if (changed) {
      Logger.info('LayerManager.selection.autoExpand', {
        sceneId: canvas?.scene?.id || null,
        groupCount: keysToExpand.size,
        elevationKeys: Array.from(keysToExpand)
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
    const selected = this._getSelectedTileDocs({ visibleOnly: true })
      .map((document) => ({ kind: 'document', id: getTileDocumentId(document) }))
      .filter((entry) => entry.id);
    return resolveSceneGroupDragSelection({
      origin: { kind: 'document', id: originId },
      selected
    }).memberUuids;
  }

  _writeSceneGroupDocumentDragData(event, documents = []) {
    if (!event?.dataTransfer) throw new Error('Layer Manager drag is missing a DataTransfer object.');
    writeSceneDocumentDragData(event.dataTransfer, uniqueTileDocuments(documents).map((document) => ({
      uuid: document?.uuid
    })));
  }

  _resolveDraggedSectionIds(originId) {
    const id = String(originId || '').trim();
    if (!id) return [];
    const selectedIds = this._selectedSectionIds?.has?.(id)
      ? Array.from(this._selectedSectionIds)
      : [id];
    const renderedIds = new Set(Array.from(this.element?.querySelectorAll?.(
      '.fa-nexus-layer-manager__separator[data-section-id]'
    ) || []).map((row) => String(row?.dataset?.sectionId || '').trim()).filter(Boolean));
    const candidates = selectedIds.filter((sectionId) => sectionId === id || renderedIds.has(sectionId));
    const metadata = this._viewState?.sectionMetadata || getSceneLayerManagerSections();
    return getSectionMoveRootIds(metadata, candidates);
  }

  _getOrderedDocsByIds(tileIds = []) {
    return getLayerManagerOrderedDocsByIds({
      tileIds,
      viewState: this._viewState,
      resolveDocumentById: (id) => canvas?.scene?.tiles?.get?.(id) || null
    });
  }

  _getPreviewEntryById(previewId = '') {
    return getLayerManagerPreviewEntryById(this._viewState, previewId);
  }

  _setDraggedRowState(tileIds = [], previewIds = [], sectionIds = []) {
    setLayerManagerDraggedRowState({
      root: this.element,
      tileIds,
      previewIds,
      sectionIds
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
    const metadata = this._viewState?.sectionMetadata || getSceneLayerManagerSections();
    const target = resolveLayerManagerDropTarget({
      event,
      dragState: this._dragState,
      getSectionParentId: (sectionId) => metadata?.sections?.[String(sectionId || '').trim()]?.parentId || null
    });
    const sourceSectionIds = Array.from(new Set([
      ...(Array.isArray(this._dragState?.sectionIds) ? this._dragState.sectionIds : []),
      this._dragState?.sectionId
    ].map((id) => String(id || '').trim()).filter(Boolean)));
    if (!target || !sourceSectionIds.length) return target;
    const blockedSectionIds = new Set(sourceSectionIds.flatMap((id) => getSectionDescendantIds(metadata, id)));
    if (target.kind === 'section-boundary' && blockedSectionIds.has(String(target.boundarySectionId || '').trim())) {
      return null;
    }
    return blockedSectionIds.has(String(target.sectionId || '').trim()) ? null : target;
  }

  _serializeDropTarget(target = null) {
    if (!target) return '';
    return JSON.stringify({
      kind: target.kind || null,
      rowId: target.rowId || null,
      previewId: target.previewId || null,
      elevationKey: target.elevationKey || null,
      sectionId: target.sectionId || null,
      boundarySectionId: target.boundarySectionId || null,
      placeBefore: target.placeBefore !== false
    });
  }

  _captureListScrollTop() {
    const list = this.element?.querySelector?.('.fa-nexus-layer-manager__list') || null;
    const scrollTop = Number(list?.scrollTop);
    return Number.isFinite(scrollTop) ? scrollTop : null;
  }

  _preserveListScrollTop(scrollTop = null) {
    if (scrollTop == null) return;
    const numeric = Number(scrollTop);
    if (!Number.isFinite(numeric)) return;
    this._preservedListScrollTop = numeric;
    this._suppressPreviewAutoScrollOnce = true;
  }

  _restorePreservedListScrollTop() {
    if (this._preservedListScrollTop == null) return false;
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
    const sectionRow = event?.target?.closest?.('.fa-nexus-layer-manager__separator[data-section-id]');
    const sectionId = String(sectionRow?.dataset?.sectionId || '').trim();
    const elevationRow = event.target?.closest?.('.fa-nexus-layer-manager__separator[data-elevation-key]:not([data-section-id])');
    if (elevationRow && !elevationRow.classList.contains('fa-nexus-layer-manager__separator--level-boundary')) {
      const key = elevationRow.dataset.elevationKey, docs = this._getFullElevationDocs(key);
      if (!docs.length || this._viewState.filtersApplied) { event.preventDefault(); return; }
      this._writeSceneGroupDocumentDragData(event, docs);
      const metadata = getSceneLayerManagerSections();
      const build = node => {
        const name = getElevationGroupName(getSceneElevationGroupMetadata(), node.key) || node.defaultName || `Elev ${formatElevation(node.elevation)}`;
        const tree = buildLayerManagerSceneTree({documents:node.exactDocs || [],metadata,name});
        for (const childKey of node.childKeys || []) tree.nodes[0].children.push(build(this._getFullGroupNode(childKey)));
        return tree.nodes[0];
      };
      writeLayerTreeDragData(event.dataTransfer, canvas.scene.id, {nodes:[build(this._getFullGroupNode(key))], memberUuids:[]});
      event.dataTransfer.effectAllowed = 'move';
      this._dragState = null;
      return;
    }
    if (sectionId) {
      const sectionIds = this._resolveDraggedSectionIds(sectionId);
      const renderedRows = Array.from(this.element?.querySelectorAll?.(
        '.fa-nexus-layer-manager__separator[data-section-id]'
      ) || []);
      const sectionRows = sectionIds.map((id) => renderedRows.find(
        (row) => String(row?.dataset?.sectionId || '').trim() === id
      ));
      const sectionDocs = uniqueTileDocuments(sectionIds.flatMap((id) => this._getFullSectionDocs(id)));
      const sectionDocIds = new Set(sectionDocs.map((doc) => getTileDocumentId(doc)).filter(Boolean));
      const looseDocs = this._selectedSectionIds?.has?.(sectionId)
        ? this._getSelectedTileDocs({ visibleOnly: true }).filter((doc) => !sectionDocIds.has(getTileDocumentId(doc)))
        : [];
      const docs = uniqueTileDocuments([...sectionDocs, ...looseDocs]);
      const looseTileIds = looseDocs.map((doc) => getTileDocumentId(doc)).filter(Boolean);
      if (
        !sectionIds.length
        || sectionRows.some((row) => row?.draggable !== true)
        || !docs.length
        || docs.some((doc) => !doc?.canUserModify?.(game?.user, 'update'))
      ) {
        event.preventDefault();
        return;
      }
      const tileIds = docs.map((doc) => getTileDocumentId(doc)).filter(Boolean);
      try {
        if (event?.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', sectionId);
          this._writeSceneGroupDocumentDragData(event, docs);
          writeLayerTreeDragData(event.dataTransfer, canvas.scene.id, buildLayerManagerSceneTree({documents:docs,
            metadata:getSceneLayerManagerSections(), sectionIds}));
        }
      } catch (error) {
        event.preventDefault();
        this._notifyLayerManagerActionError('begin Folder drag', error);
        return;
      }
      this._dragState = { sectionId, sectionIds, tileIds, looseTileIds, originId: sectionId };
      this._lastDropTarget = null;
      this._setDraggedRowState(tileIds, [], sectionIds);
      this._clearDropIndicator();
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
    const visibleSelectedDocs = this._getSelectedTileDocs({ visibleOnly: true });
    const originIsSelected = visibleSelectedDocs.some((doc) => getTileDocumentId(doc) === originId);
    const selectedSectionId = originIsSelected ? Array.from(this._selectedSectionIds || [])[0] : null;
    const sectionIds = selectedSectionId ? this._resolveDraggedSectionIds(selectedSectionId) : [];
    const renderedRows = Array.from(this.element?.querySelectorAll?.(
      '.fa-nexus-layer-manager__separator[data-section-id]'
    ) || []);
    const sectionRows = sectionIds.map((id) => renderedRows.find(
      (sectionRow) => String(sectionRow?.dataset?.sectionId || '').trim() === id
    ));
    const sectionDocs = uniqueTileDocuments(sectionIds.flatMap((id) => this._getFullSectionDocs(id)));
    if (
      sectionRows.some((sectionRow) => sectionRow?.draggable !== true)
      || sectionDocs.some((doc) => !doc?.canUserModify?.(game?.user, 'update'))
    ) {
      event.preventDefault();
      return;
    }
    const sectionDocIds = new Set(sectionDocs.map((doc) => getTileDocumentId(doc)).filter(Boolean));
    const looseTileIds = this._resolveDraggedTileIds(originId).filter((id) => !sectionDocIds.has(id));
    this._dragState = prepareLayerManagerListDragStart({
      event,
      originId,
      orderedDocs: this._getOrderedDocsByIds([...looseTileIds, ...sectionDocIds]),
      user: game?.user,
      setDraggedRowState: (tileIds) => this._setDraggedRowState(tileIds),
      clearDropIndicator: () => this._clearDropIndicator()
    });
    if (this._dragState) {
      try {
        this._writeSceneGroupDocumentDragData(event, this._getOrderedDocsByIds(this._dragState.tileIds));
        if (sectionIds.length) writeLayerTreeDragData(event.dataTransfer, canvas.scene.id, buildLayerManagerSceneTree({
          documents:this._getOrderedDocsByIds(this._dragState.tileIds),metadata:getSceneLayerManagerSections(),sectionIds}));
      } catch (error) {
        event.preventDefault();
        this._dragState = null;
        this._notifyLayerManagerActionError('begin Scene Group document drag', error);
        return;
      }
    }
    if (this._dragState && sectionIds.length) {
      this._dragState.sectionId = sectionIds[0];
      this._dragState.sectionIds = sectionIds;
      this._dragState.looseTileIds = looseTileIds;
      this._setDraggedRowState(this._dragState.tileIds, [], sectionIds);
    }
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
    const hasSectionDrag = !!String(this._dragState?.sectionId || '').trim();
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
        dragKind: hasSectionDrag ? 'section' : (hasTileDrag ? 'tile' : 'preview')
      });
    }
    const target = indicatedTarget || resolvedTarget;
    try {
      if (target) {
        if (hasSectionDrag) await this._applySectionDrop(target);
        else if (hasTileDrag) await this._applyDropReorder(target);
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

  async _applyDropReorder(target, dragState = this._dragState, { updateSectionMemberships = true, hierarchicalOrder = false } = {}) {
    if (updateSectionMemberships && this._folderHistoryCaptureDepth === 0) {
      return this._runFolderHistoryAction('Move Layers', () => this._applyDropReorder(target, dragState, { updateSectionMemberships, hierarchicalOrder }));
    }
    this._preserveListScrollTop(this._captureListScrollTop());
    const previewAnchors = this._capturePreviewAnchorsForTileDrop(target, dragState);
    const result = await applyLayerManagerDropReorder({
      target,
      dragState,
      viewState: this._viewState,
      hierarchicalOrder,
      user: game?.user,
      updateEmbeddedDocuments: (type, updates, options) => this._updateEmbeddedDocumentsForFolderHistory(type, updates, options),
      elevationGroupKey,
      resolveGroupElevation: (key) => this._resolveGroupElevation(key),
      resolveDisplayElevationKey: (doc) => this._resolveDisplayElevationKeyForDoc(doc),
      resolveDocumentById: (id) => canvas?.scene?.tiles?.get?.(id) || null,
      updateSectionMemberships: updateSectionMemberships
        ? (tileIds, sectionId, elevationKey) => this._updateSectionMembershipsForDrop(tileIds, sectionId, elevationKey)
        : null
    });
    if (result?.reason === 'composite-level-change') {
      const name = resolveTileDisplayName(result.document) || 'This layer';
      ui?.notifications?.warn?.(`${name} was not moved: its other parts (Walls, Regions, further layers) stay on their Level. Move it within its own Level.`);
    }
    if (result?.applied) {
      await this._applyPreviewAnchorsAfterTileDrop(previewAnchors);
      if (hierarchicalOrder) {
        const collapsed = this._getSessionState().collapsedElevations;
        let expanded = collapsed.delete(target.elevationKey);
        if (target.sectionId && collapsed.delete(sectionKey(target.sectionId))) expanded = true;
        if (expanded) queuePersistLayerManagerCollapsedState();
        this._scheduleRender();
      }
    }
    return result;
  }

  async _applySectionDrop(target) {
    if (this._folderHistoryCaptureDepth === 0) {
      return this._runFolderHistoryAction('Move Folder', () => this._applySectionDrop(target));
    }
    const sectionIds = Array.from(new Set([
      ...(Array.isArray(this._dragState?.sectionIds) ? this._dragState.sectionIds : []),
      this._dragState?.sectionId
    ].map((id) => String(id || '').trim()).filter(Boolean)));
    const targetSectionId = String(target?.sectionId || '').trim() || null;
    const targetElevationKey = String(target?.elevationKey || '').trim();
    const looseTileIds = Array.from(new Set((this._dragState?.looseTileIds || [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)));
    const scene = canvas?.scene;
    if (!sectionIds.length || !targetElevationKey || !scene) return false;
    const metadata = this._viewState?.sectionMetadata || getSceneLayerManagerSections();
    const movedSectionIds = Array.from(new Set(sectionIds.flatMap((id) => getSectionDescendantIds(metadata, id))));
    if (!movedSectionIds.length || (targetSectionId && movedSectionIds.includes(targetSectionId))) return false;

    this._sectionElevationMutationDepth = Number(this._sectionElevationMutationDepth || 0) + 1;
    try {
      const result = await this._applyDropReorder(target, this._dragState, { updateSectionMemberships: false });
      if (!result?.applied) return false;
      const updatedSections = await updateSceneLayerManagerSections(scene, (current) => {
        for (const sectionId of sectionIds) {
          if (!current.sections[sectionId]) throw new Error('Dragged Folder no longer exists.');
        }
        if (targetSectionId && !current.sections[targetSectionId]) throw new Error('Drop target Folder no longer exists.');
        const descendants = new Set(sectionIds.flatMap((id) => getSectionDescendantIds(current, id)));
        if (targetSectionId && descendants.has(targetSectionId)) throw new Error('A Folder cannot be nested inside itself.');
        for (const sectionId of sectionIds) current.sections[sectionId].parentId = targetSectionId;
        for (const movedId of descendants) current.sections[movedId].elevationKey = targetElevationKey;
        for (const tileId of looseTileIds) {
          if (targetSectionId) current.memberships[tileId] = targetSectionId;
          else delete current.memberships[tileId];
        }
        let removedEmptySection = true;
        while (removedEmptySection) {
          removedEmptySection = false;
          const occupied = new Set(Object.values(current.memberships));
          const parents = new Set(Object.values(current.sections).map((section) => section.parentId).filter(Boolean));
          for (const id of Object.keys(current.sections)) {
            if (occupied.has(id) || parents.has(id) || sectionIds.includes(id) || id === targetSectionId) continue;
            delete current.sections[id];
            removedEmptySection = true;
          }
        }
        return current;
      });
      for (const sectionId of sectionIds) {
        if ((updatedSections.sections[sectionId]?.parentId || null) !== targetSectionId) {
          throw new Error('Dragged Folder parent did not persist after the Folder drop transaction.');
        }
      }
      await waitForUiFrame(32);
    } finally {
      this._sectionElevationMutationDepth = Math.max(0, Number(this._sectionElevationMutationDepth || 0) - 1);
    }
    if (this._sectionElevationReconcilePending) {
      this._sectionElevationReconcilePending = false;
      await this._reconcileSectionElevations({
        parentOverrides: Object.fromEntries(sectionIds.map((sectionId) => [sectionId, targetSectionId]))
      });
      const reconciledSections = getSceneLayerManagerSections(scene);
      for (const sectionId of sectionIds) {
        if ((reconciledSections.sections[sectionId]?.parentId || null) !== targetSectionId) {
          throw new Error('Dragged Folder parent was cleared during Folder elevation reconciliation.');
        }
      }
    }
    Logger.info('LayerManager.section.moved', {
      sceneId: scene.id || null,
      sectionIds,
      parentId: targetSectionId,
      elevationKey: targetElevationKey
    });
    this._scheduleRender();
    return true;
  }

  async _updateSectionMembershipsForDrop(tileIds = [], sectionId = null, elevationKey = '') {
    const ids = Array.from(new Set(tileIds.map((id) => String(id || '').trim()).filter(Boolean)));
    if (!ids.length) return;
    // A drop says where the layer belongs; an earlier Folder is not returned to.
    for (const id of ids) this._formerSectionMemberships.delete(id);
    const targetSectionId = String(sectionId || '').trim() || null;
    await updateSceneLayerManagerSections(canvas?.scene, (metadata) => {
      if (targetSectionId && !metadata.sections[targetSectionId]) {
        throw new Error('Drop target Folder no longer exists.');
      }
      // The Folders the moved layers leave. One that this move empties is removed, and a parent it was the last
      // content of; every other empty Folder stays, to receive later drops.
      const left = ids.map((tileId) => metadata.memberships[tileId]).filter(Boolean);
      for (const tileId of ids) {
        if (targetSectionId) metadata.memberships[tileId] = targetSectionId;
        else delete metadata.memberships[tileId];
      }
      if (targetSectionId && !metadata.sections[targetSectionId].elevationKey) {
        metadata.sections[targetSectionId].elevationKey = String(elevationKey || '').trim() || null;
      }
      const emptied = [...new Set(left)];
      while (emptied.length) {
        const id = emptied.pop();
        const section = metadata.sections[id];
        if (!section || id === targetSectionId) continue;
        const occupied = Object.values(metadata.memberships).includes(id);
        const parent = Object.values(metadata.sections).some((other) => other.parentId === id);
        if (occupied || parent) continue;
        delete metadata.sections[id];
        if (section.parentId) emptied.push(section.parentId);
      }
      return metadata;
    });
  }

  _capturePreviewAnchorsForTileDrop(target, dragState = this._dragState) {
    return captureLayerManagerPreviewAnchorsForTileDrop({
      target,
      dragState,
      viewState: this._viewState
    });
  }

  async _applyPreviewAnchorsAfterTileDrop(anchors = []) {
    return applyLayerManagerPreviewAnchorsAfterTileDrop({
      anchors,
      resolveGroupElevation: (key) => this._resolveGroupElevation(key),
      resolvePreviewSessionController,
      setLastActivePreviewId: (previewId) => { this._lastActivePreviewId = previewId; },
      scheduleRender: () => this._scheduleRender()
    });
  }

  async _applyPreviewDropReorder(target) {
    return applyLayerManagerPreviewDropReorder({
      target,
      dragState: this._dragState,
      viewState: this._viewState,
      resolveGroupElevation: (key) => this._resolveGroupElevation(key),
      resolvePreviewSessionController,
      captureListScrollTop: () => this._captureListScrollTop(),
      preserveListScrollTop: (scrollTop) => this._preserveListScrollTop(scrollTop),
      setLastActivePreviewId: (previewId) => { this._lastActivePreviewId = previewId; },
      scheduleRender: () => this._scheduleRender()
    });
  }

  _handlePreviewRowClick(previewRow) {
    const previewId = String(previewRow?.dataset?.previewId || '').trim();
    if (!previewId) return false;
    this._clearSectionSelection({ scheduleRender: false });
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

  /**
   * An edited layer is committed where its preview row was dragged. A new layer takes the row's
   * Folder when it is created; an edited one is written by its editor as an update, so the row's
   * Folder is applied here: into the Folder the row was in, or out of the one the layer was in.
   */
  async _applyPreviewSectionToEditedTile(doc, changes, options = {}) {
    // A Building writes its Commit outside Foundry's Undo history and marks the write "isUndo" for that. It is a
    // commit all the same; only its rollback after a failed Commit is an undo.
    const buildingCommit = options?.faNexusBuildingEditorDocumentWrite === true
      && options?.faNexusBuildingV2CommitRollback !== true;
    if ((options?.isUndo && !buildingCommit) || !changes || !(('sort' in changes) || ('elevation' in changes))) return false;
    // Preview rows exist only while an editor or a placement is open; without one there is nothing to look up.
    if (!(globalThis.faNexus?.collectActiveSessionLevelSwitchBlockers?.() || []).length) return false;
    const scene = canvas?.scene;
    const tileId = getTileDocumentId(doc);
    if (!scene || !tileId || doc?.parent !== scene) return false;
    const exactKeyOf = (entry) => String(buildDisplayGroupingForEntry(entry, { nestedGrouping: false })?.exactKey || '').trim();
    const tileKey = exactKeyOf(buildLayerManagerTileEntry(doc, 0));
    const tileSort = Number(doc?.sort);
    if (!tileKey || !Number.isFinite(tileSort)) return false;
    const matches = collectLayerManagerPreviewEntries().filter((candidate) => candidate?.preview === true
      && exactKeyOf(candidate) === tileKey
      && Math.abs(Number(candidate?.placementSort) - tileSort) < 0.001);
    const match = matches.find((candidate) => candidate?.previewId === this._lastActivePreviewId) || matches[0] || null;
    if (!match) return false;
    const metadata = getSceneLayerManagerSections(scene);
    const targetSectionId = String(match.sectionId || '').trim() || null;
    const currentSectionId = metadata.memberships[tileId] || null;
    if (targetSectionId === currentSectionId || (targetSectionId && !metadata.sections[targetSectionId])) return false;
    this._formerSectionMemberships.delete(tileId);
    await updateSceneLayerManagerSections(scene, (current) => {
      if (targetSectionId) current.memberships[tileId] = targetSectionId;
      else delete current.memberships[tileId];
      return current;
    });
    Logger.info('LayerManager.section.previewPlacementApplied', { tabId: TAB_ID, tileId, sectionId: targetSectionId });
    return true;
  }

  async _inheritSectionForCreatedTile(doc) {
    const scene = canvas?.scene;
    const tileId = getTileDocumentId(doc);
    if (!scene || !tileId) return false;
    const metadata = getSceneLayerManagerSections(scene);
    const entry = buildLayerManagerTileEntry(doc, 0);
    const createdKey = String(buildDisplayGroupingForEntry(entry, { nestedGrouping: false })?.exactKey || '').trim();
    const createdSort = Number(doc?.sort);
    const previewMatches = collectLayerManagerPreviewEntries().filter((candidate) => {
      if (candidate?.preview !== true) return false;
      if (!metadata?.sections?.[String(candidate?.sectionId || '').trim()]) return false;
      const candidateKey = String(buildDisplayGroupingForEntry(candidate, { nestedGrouping: false })?.exactKey || '').trim();
      return candidateKey === createdKey
        && Number.isFinite(createdSort)
        && Math.abs(Number(candidate?.placementSort) - createdSort) < 0.001;
    });
    const previewMatch = previewMatches.find((candidate) => candidate?.previewId === this._lastActivePreviewId)
      || previewMatches[0]
      || null;
    if (previewMatch) {
      const previewSectionId = String(previewMatch.sectionId || '').trim();
      await updateSceneLayerManagerSections(scene, (current) => {
        if (current.sections[previewSectionId]) current.memberships[tileId] = previewSectionId;
        return current;
      });
      Logger.info('LayerManager.section.placementInherited', {
        tabId: TAB_ID,
        source: 'preview'
      });
      return true;
    }
    const anchor = resolvePlacementAnchorTile(canvas?.tiles?.controlled, { source: 'layer-manager-section-inheritance' });
    const anchorDoc = anchor?.document || anchor;
    const anchorId = getTileDocumentId(anchorDoc);
    if (!anchorId || anchorId === tileId) return false;
    const sectionId = getTileSectionId(metadata, anchorId);
    if (!sectionId) return false;
    const anchorKey = String(this._viewState?.fullTileGroupKeyById?.get?.(anchorId) || '').trim();
    if (!anchorKey || anchorKey !== createdKey) return false;
    const anchorSort = Number(anchorDoc?.sort);
    if (!Number.isFinite(anchorSort) || !Number.isFinite(createdSort) || createdSort <= anchorSort) return false;
    const blockingDoc = collectTileDocuments({ scene }).find((candidate) => {
      const candidateId = getTileDocumentId(candidate);
      if (!candidateId || candidateId === anchorId || candidateId === tileId) return false;
      const candidateSort = Number(candidate?.sort);
      if (!Number.isFinite(candidateSort) || candidateSort <= anchorSort || candidateSort >= createdSort) return false;
      const candidateEntry = buildLayerManagerTileEntry(candidate, 0);
      const candidateKey = String(buildDisplayGroupingForEntry(candidateEntry, { nestedGrouping: false })?.exactKey || '').trim();
      if (candidateKey !== createdKey) return false;
      return getTileSectionId(metadata, candidateId) !== sectionId;
    });
    if (blockingDoc) return false;
    await updateSceneLayerManagerSections(scene, (current) => {
      if (!current.sections[sectionId]) return current;
      current.memberships[tileId] = sectionId;
      return current;
    });
    Logger.info('LayerManager.section.placementInherited', {
      sceneId: scene.id || null,
      sectionId,
      anchorTileId: anchorId,
      tileId
    });
    return true;
  }

  _queueSectionElevationReconcile() {
    if (Number(this._sectionElevationMutationDepth || 0) > 0 || this._folderHistoryCaptureDepth > 0) {
      this._sectionElevationReconcilePending = true;
      return;
    }
    if (this._sectionElevationReconcileQueued) return;
    this._sectionElevationReconcileQueued = true;
    setTimeout(() => {
      this._sectionElevationReconcileQueued = false;
      if (this._folderHistoryCaptureDepth > 0) {
        this._sectionElevationReconcilePending = true;
        return;
      }
      void this._reconcileSectionElevations()
        .catch((error) => this._notifyLayerManagerActionError('reconcile Folder elevation', error));
    }, 0);
  }

  async _reconcileSectionElevations({ parentOverrides = {} } = {}) {
    const scene = canvas?.scene;
    if (!scene) return false;
    const expectedParents = new Map(Object.entries(parentOverrides || {}).map(([sectionId, parentId]) => [
      String(sectionId || '').trim(),
      String(parentId || '').trim() || null
    ]).filter(([sectionId]) => sectionId));
    let changed = false;
    const former = this._formerSectionMemberships;
    const exactKeyOf = (doc) => String(buildDisplayGroupingForEntry(buildLayerManagerTileEntry(doc, 0), { nestedGrouping: false })?.exactKey || '').trim();
    await updateSceneLayerManagerSections(scene, (metadata) => {
      // A layer that left its Folder with its Elevation or by being deleted, and is back (Undo): it returns to the Folder.
      for (const [tileId, record] of former) {
        if (record.sceneId !== scene.id) continue;
        const section = metadata.sections[record.sectionId];
        if (!section || metadata.memberships[tileId]) { former.delete(tileId); continue; }
        const doc = scene.tiles?.get?.(tileId);
        if (!doc || !section.elevationKey || exactKeyOf(doc) !== section.elevationKey) continue;
        metadata.memberships[tileId] = record.sectionId;
        former.delete(tileId);
        changed = true;
      }
      const keyByTileId = new Map();
      for (const [tileId, sectionId] of Object.entries(metadata.memberships)) {
        const doc = scene.tiles?.get?.(tileId);
        if (!doc || !metadata.sections[sectionId]) {
          if (metadata.sections[sectionId]) former.set(tileId, { sceneId: scene.id, sectionId });
          delete metadata.memberships[tileId];
          changed = true;
          continue;
        }
        const entry = buildLayerManagerTileEntry(doc, 0);
        const key = String(buildDisplayGroupingForEntry(entry, { nestedGrouping: false })?.exactKey || '').trim();
        keyByTileId.set(tileId, key);
      }
      for (const [sectionId, section] of Object.entries(metadata.sections)) {
        const counts = new Map();
        for (const tileId of getSectionTileIds(metadata, sectionId)) {
          const key = keyByTileId.get(tileId);
          if (key) counts.set(key, (counts.get(key) || 0) + 1);
        }
        if (!counts?.size) continue;
        let keepKey = section.elevationKey && counts.has(section.elevationKey) ? section.elevationKey : '';
        if (!keepKey) {
          keepKey = Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] || '';
        }
        if (section.elevationKey !== keepKey) {
          section.elevationKey = keepKey || null;
          changed = true;
        }
        if (counts.size > 1) {
          for (const [tileId, memberSectionId] of Object.entries(metadata.memberships)) {
            if (memberSectionId !== sectionId) continue;
            const key = keyByTileId.get(tileId) || '';
            if (key === keepKey) continue;
            former.set(tileId, { sceneId: scene.id, sectionId });
            delete metadata.memberships[tileId];
            changed = true;
          }
        }
      }
      for (const [sectionId, section] of Object.entries(metadata.sections)) {
        if (expectedParents.has(sectionId)) continue;
        const parent = section.parentId ? metadata.sections[section.parentId] : null;
        if (parent && parent.elevationKey && section.elevationKey && parent.elevationKey !== section.elevationKey) {
          section.parentId = null;
          changed = true;
        }
      }
      for (const [sectionId, parentId] of expectedParents) {
        const section = metadata.sections[sectionId];
        if (!section || (parentId && !metadata.sections[parentId])) continue;
        if ((section.parentId || null) === parentId) continue;
        section.parentId = parentId;
        changed = true;
      }
      // Empty folders created explicitly remain available as drop destinations.
      return changed ? metadata : undefined;
    });
    return changed;
  }

  _expandGroupsForActivePreviews() {
    const state = this._getSessionState();
    if (!(state?.collapsedElevations instanceof Set) || !state.collapsedElevations.size) return false;
    const previews = collectLayerManagerPreviewEntries().filter((entry) => entry?.previewActive === true);
    if (!previews.length) return false;
    const keys = new Set();
    const metadata = this._viewState?.sectionMetadata || getSceneLayerManagerSections();
    for (const entry of previews) {
      const grouping = buildDisplayGroupingForEntry(entry, { nestedGrouping: false });
      const groupKey = String(grouping?.exactKey || '').trim();
      let node = groupKey ? this._getFullGroupNode(groupKey) : null;
      if (groupKey && !node) keys.add(groupKey);
      while (node) {
        keys.add(node.key);
        node = node.parentKey ? this._getFullGroupNode(node.parentKey) : null;
      }
      const visited = new Set();
      let sectionId = String(entry?.sectionId || '').trim();
      while (sectionId && metadata.sections?.[sectionId] && !visited.has(sectionId)) {
        visited.add(sectionId);
        keys.add(sectionKey(sectionId));
        sectionId = metadata.sections[sectionId].parentId || null;
      }
    }
    let changed = false;
    for (const key of keys) {
      if (state.collapsedElevations.delete(key)) changed = true;
    }
    if (changed) queuePersistLayerManagerCollapsedState();
    return changed;
  }

  _ensureHooks() {
    if (!globalThis.Hooks || this._hookIds.length) return;
    const hook = (name, fn) => {
      try { Hooks.on(name, fn); } catch (_) { return; }
      this._hookIds.push({ name, fn });
    };

    const refresh = (reason = 'hook-refresh', { invalidateListCache = true, refreshSelection = true } = {}) => {
      // Native row right-click selects its Tile and refreshes group selection.
      // Keep the menu through that render; document/lifecycle changes invalidate
      // its captured actions before refreshing the list.
      if (reason !== 'scene-group-interaction') this._closeContextMenu();
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

    hook('createTile', (doc) => {
      void this._inheritSectionForCreatedTile(doc)
        .catch((error) => this._notifyLayerManagerActionError('inherit placement Folder', error))
        .finally(() => {
          if (this._formerSectionMemberships.has(doc?.id)) this._queueSectionElevationReconcile();
          refresh('create-tile');
        });
    });
    hook('updateTile', (doc, changes, options = {}) => {
      if (this._handleNativeFolderHistoryUndo(options)) {
        refresh('folder-history-undo');
        return;
      }
      void this._applyPreviewSectionToEditedTile(doc, changes, options)
        .catch((error) => this._notifyLayerManagerActionError('apply the preview row\'s Folder', error))
        .finally(() => {
          this._queueSectionElevationReconcile();
          refresh('update-tile');
        });
    });
    hook('deleteTile', () => {
      this._queueSectionElevationReconcile();
      refresh('delete-tile');
    });
    hook('canvasReady', () => refresh('canvas-ready'));
    hook('canvasTearDown', () => refresh('canvas-teardown'));
    hook('updateScene', () => refresh('update-scene'));
    hook('createLevel', () => refresh('create-level'));
    hook('updateLevel', () => refresh('update-level'));
    hook('deleteLevel', () => refresh('delete-level'));
    hook('drawPrimaryCanvasGroup', () => refresh('draw-primary-group'));
    hook('fa-nexus-preview-layers-changed', () => {
      this._expandGroupsForActivePreviews();
      refresh('preview-layers-changed');
    });
    hook('fa-nexus-tile-config-selection-sync', (options = {}) => {
      this._queueSelectionSyncFromCanvas({
        allowAutoExpand: options?.allowAutoExpand !== false,
        allowScrollToTile: options?.allowScrollToTile !== false
      });
    });
    hook(SCENE_GROUP_INTERACTION_HOOK, () => refresh('scene-group-interaction', {
      invalidateListCache: false,
      refreshSelection: false
    }));
    hook('controlTile', syncSelection);
    hook('releaseTile', syncSelection);
    hook('updateSetting', (payload) => {
      if (payload?.namespace !== MODULE_ID) return;
      if (payload?.key === COLLAPSED_STATE_SETTING) {
        syncLayerManagerCollapsedStateFromSettings();
        refresh('collapsed-state-updated', { invalidateListCache: false, refreshSelection: false });
        return;
      }
      if (payload?.key === SCENE_GROUP_MEMBER_SELECTION_SETTING) {
        refresh('scene-group-member-selection-mode-updated', {
          invalidateListCache: false,
          refreshSelection: false
        });
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
    if (this._folderHistoryCaptureDepth > 0) {
      this._folderHistoryRenderPending = true;
      return;
    }
    const explicitScrollQueued = !!this._scrollTargetId || !!this._scrollPreviewTargetId;
    if (!explicitScrollQueued && this._preservedListScrollTop === null) {
      this._preserveListScrollTop(this._captureListScrollTop());
    }
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      if (this._folderHistoryCaptureDepth > 0) {
        this._folderHistoryRenderPending = true;
        return;
      }
      this.render({ parts: ['content'] });
    });
  }

  _handleSelectionListFilterStateChange(reason) {
    try {
      return handleLayerManagerSelectionListFilterStateChange({
        reason,
        selectionFilterState,
        invalidateSelectionListFilterCache,
        scheduleSelectionFilterRefresh
      });
    } catch (error) {
      this._notifyLayerManagerActionError('update layer list filters', error);
      return false;
    }
  }

  _activateTilesLayer() {
    activateLayerManagerTilesLayer();
  }

  async _onRangeChange(isInput = false) {
    return applyRangeFilterChange({
      root: this.element,
      isInput,
      selectionFilterState,
      parseElevationInput,
      writeSetting,
      refreshTileInteractionState,
      pruneSelectionForFilter,
      rangeMinSetting: RANGE_MIN_SETTING,
      rangeMaxSetting: RANGE_MAX_SETTING
    });
  }

  async _onSkipLockedChange() {
    return applySelectionBooleanFilterChange({
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

  async _onSkipHiddenChange() {
    return applySelectionBooleanFilterChange({
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

  async _onSkipFilteredChange() {
    return applySkipFilteredChange({
      root: this.element,
      selectionFilterState,
      invalidateSelectionListFilterCache,
      writeSetting,
      scheduleSelectionFilterRefresh,
      settingKey: SKIP_FILTERED_SETTING
    });
  }

  _setFilterActive(active) {
    let changed = false;
    let activationError = null;
    try {
      changed = setSelectionFilterActive({
        active,
        selectionFilterState,
        setAltKeyHeld,
        isAltModifierActive,
        refreshTileInteractionState,
        pruneSelectionForFilter
      });
    } catch (error) {
      activationError = error;
    }
    let restorationError = null;
    if (!active) {
      try {
        restoreLayerManagerTileInteractivity({ source: 'layer-manager-deactivate' });
      } catch (error) {
        restorationError = error;
      }
    }
    if (activationError && restorationError) {
      throw new AggregateError([activationError, restorationError], 'Layer Manager deactivation and interactivity restoration failed.');
    }
    if (activationError) throw activationError;
    if (restorationError) throw restorationError;
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
    return this._listInteractionController.handleListClick(event);
  }

  _selectVisibleListRange(items, currentIndex, { retainSelection = false } = {}) {
    const start = Math.min(this._lastClickedIndex, currentIndex);
    const end = Math.max(this._lastClickedIndex, currentIndex);
    const rangeDocs = [];
    const sectionIds = [];
    for (let i = start; i <= end; i += 1) {
      const item = items[i];
      const sectionId = String(item?.dataset?.sectionId || '').trim();
      if (sectionId && item?.classList?.contains('fa-nexus-layer-manager__separator--section')) {
        sectionIds.push(sectionId);
        continue;
      }
      const rangeId = String(item?.dataset?.tileId || '').trim();
      if (!rangeId) continue;
      const rangeTile = this._getTilePlaceable(rangeId);
      const rangeDoc = rangeTile?.document || canvas?.scene?.tiles?.get?.(rangeId) || null;
      if (rangeDoc) rangeDocs.push(rangeDoc);
    }
    if (!retainSelection) this._selectedSectionIds.clear();
    for (const sectionId of sectionIds) this._selectedSectionIds.add(sectionId);
    this._selectTileDocs(rangeDocs, {
      retainSelection,
      force: true,
      source: 'list.shift'
    });
    this._scheduleRender();
    this._updateSelectionActions();
    this._updateFlattenFooter();
  }

  _handleListTileClick(event, target) {
    const list = target.closest?.('.fa-nexus-layer-manager__list') || target.parentElement;
    const items = list
      ? Array.from(list.querySelectorAll('[data-tile-id], .fa-nexus-layer-manager__separator--section[data-section-id]'))
      : [target];
    const currentIndex = items.indexOf(target);
    const tileId = target.dataset.tileId;
    if (!tileId) return;
    if (this._handleTextureMarqueeLayerClick(target, event)) return;
    this._lastClickedTileId = tileId;

    const scene = canvas?.scene;
    const document = scene?.tiles?.get?.(tileId) || this._viewState?.fullTileDocsById?.get?.(tileId) || null;
    if (document) {
      try {
        const selection = resolveSceneGroupMemberSelection({
          documentUuid: document.uuid,
          mode: this._readSceneGroupMemberSelectionMode(),
          index: getSceneGroupInteractionIndex(scene),
          event
        });
        if (selection.kind === 'group') {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          sceneGroupInteractionRuntime.selectCanvasGroup(scene, selection.groupId, event);
          return;
        }
        if (!(event?.ctrlKey || event?.metaKey || event?.shiftKey) && !document.object?.controlled
          && sceneGroupInteractionState.snapshot(scene).selectedGroupIds.length) {
          sceneGroupInteractionState.clear(scene, 'exclusive-layer-row');
        }
      } catch (error) {
        this._notifyLayerManagerActionError('resolve Scene Member Selection Mode', error);
        return;
      }
    }

    this._activateTilesLayer();

    const isMeta = !!(event.ctrlKey || event.metaKey);
    const isShift = !!event.shiftKey;
    if (!isMeta && !isShift) this._clearSectionSelection({ scheduleRender: true });
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
      try {
        this._selectVisibleListRange(items, currentIndex, { retainSelection: isMeta });
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
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-folder-name-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-elevation-input')) return;
    if (event.target?.closest?.('[data-action="toggle-scene-marker-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-section-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-lock"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-collapse"]')) return;
    if (event.target?.closest?.('[data-action="toggle-section-collapse"]')) return;
    const groupName = event.target?.closest?.('.fa-nexus-layer-manager__separator-name');
    if (groupName) {
      const separator = groupName.closest('.fa-nexus-layer-manager__separator');
      if (separator?.classList?.contains('fa-nexus-layer-manager__separator--level-boundary')) return;
      const sectionId = String(separator?.dataset?.sectionId || '').trim();
      if (sectionId) {
        event.preventDefault();
        event.stopPropagation();
        this._beginSectionNameEdit(sectionId);
        return;
      }
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
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-folder-name-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-elevation-input')) return;
    if (event.target?.closest?.('[data-action="toggle-scene-marker-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-section-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-lock"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-collapse"]')) return;
    if (event.target?.closest?.('[data-action="toggle-section-collapse"]')) return;
    const levelBoundary = event.target?.closest?.('.fa-nexus-layer-manager__separator--level-boundary');
    if (levelBoundary) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleCurrentLevelBandIsolation(levelBoundary);
      return;
    }
    const separator = event.target?.closest?.('.fa-nexus-layer-manager__separator:not(.fa-nexus-layer-manager__separator--level-boundary)');
    if (separator) {
      const sectionId = String(separator?.dataset?.sectionId || '').trim();
      if (sectionId) {
        const docs = this._getMatchingSectionDocs(sectionId);
        const fullDocs = this._getFullSectionDocs(sectionId);
        const canUpdateAll = docs.length > 0 && docs.every((doc) => doc?.canUserModify?.(game.user, 'update'));
        const canEditSection = !!canvas?.scene?.canUserModify?.(game.user, 'update');
        const canPromote = canEditSection
          && !this._viewState?.filtersApplied
          && fullDocs.length > 0
          && fullDocs.every((doc) => doc?.canUserModify?.(game.user, 'update'));
        event.preventDefault();
        event.stopPropagation();
        this._showLayerContextMenu(event, buildLayerManagerSectionContextMenuItems({
          sectionId,
          docs,
          canUpdateAll,
          canEditSection,
          canPromote,
          flattenItem: this._buildFlattenContextMenuItem(docs),
          onRename: (id) => this._beginSectionNameEdit(id),
          onAddFolder: id => this._addFolder({parentId:id}),
          onChangeElevation: targetDocs => this._promptDocsElevationChange(targetDocs, event),
          removeFromGroupItem: this._removeFromSceneGroupItem(docs),
          onPromote: (id) => this._promoteSection(id),
          onRemove: (id) => this._removeSection(id),
          onToggleLock: (targetDocs) => this._toggleDocsLock(targetDocs)
        }));
        return;
      }
      const elevationKey = String(separator?.dataset?.elevationKey || '').trim();
      if (!elevationKey) return;
      const docs = this._getGroupContextMenuDocs(elevationKey);
      const canUpdateAll = docs.length > 0 && docs.every((doc) => doc?.canUserModify?.(game.user, 'update'));
      const filtersApplied = !!this._viewState?.filtersApplied;
      const canRenameGroup = !!canvas?.scene?.canUserModify?.(game.user, 'update')
        && String(separator?.dataset?.groupCanRename || '').trim() !== 'false';
      const canEditElevationGroup = canUpdateAll
        && !filtersApplied
        && String(separator?.dataset?.groupCanEditElevation || '').trim() !== 'false';
      const canConvertToFolder = canEditElevationGroup && !!this._resolveElevationToFolderTarget(elevationKey);
      event.preventDefault();
      event.stopPropagation();
      this._showLayerContextMenu(event, buildLayerManagerGroupContextMenuItems({
        elevationKey,
        docs,
        canUpdateAll,
        filtersApplied,
        canRenameGroup,
        canAddFolder: !!canvas?.scene?.canUserModify?.(game.user, 'update'),
        canEditElevationGroup,
        canConvertToFolder,
        flattenItem: this._buildFlattenContextMenuItem(docs),
        onRenameGroup: (key) => this._beginElevationGroupNameEdit(key),
        onAddFolder: elevationKey => this._addFolder({elevationKey}),
        removeFromGroupItem: this._removeFromSceneGroupItem(docs),
        onChangeElevation: (key) => this._beginElevationGroupElevationEdit(key),
        onConvertToFolder: (key) => this._convertElevationToFolder(key),
        onToggleLock: (targetDocs) => this._toggleDocsLock(targetDocs)
      }));
      return;
    }

    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const tileId = String(target.dataset.tileId || '').trim();
    if (!tileId) return;
    const selectedSectionIds = this._getSelectedTileDocs().some((doc) => getTileDocumentId(doc) === tileId)
      ? Array.from(this._selectedSectionIds || [])
      : [];
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
    const hasNexusEdit = docs.length === 1 && !!getFaNexusTileEditMode(clickedDoc);
    const canMaskSingle = docs.length === 1 && canLaunchFaNexusTileMask(clickedDoc);
    const clickedHasMask = hasTileMask(clickedDoc);
    const hasAnyMask = docs.some((doc) => hasTileMask(doc));
    const menuAnchor = {
      clientX: Number(event?.clientX ?? 0),
      clientY: Number(event?.clientY ?? 0)
    };
    const sectionCreation = this._resolveSectionCreation(docs, { selectedSectionIds });
    event.preventDefault();
    event.stopPropagation();
    this._showLayerContextMenu(event, buildLayerManagerTileContextMenuItems({
      removeFromGroupItem: this._removeFromSceneGroupItem(docs),
      tileId,
      docs,
      clickedDoc,
      clickedTile,
      user: game?.user,
      canUpdateAll,
      hasNexusEdit,
      nexusEditDisabledReason: docs.length === 1 ? (getFaNexusTileEditRefusal(clickedDoc)?.message || '') : '',
      canResetBuildingScale: docs.length === 1 && canUpdateAll
        && [4, 5].includes(Number(clickedDoc?.flags?.['fa-nexus']?.building?.schemaVersion)),
      onResetBuildingScale: async (doc) => {
        const { SceneGroupWorkflow } = await import('../composition/scene-group-workflow.js');
        await new SceneGroupWorkflow().execute({ scene: doc.parent, user: game.user,
          action: { type: 'reset-building-scale', ownerUuid: doc.uuid } });
      },
      canMaskSingle,
      clickedHasMask,
      hasAnyMask,
      menuAnchor,
      canCreateSection: !!sectionCreation,
      canCreateDepthLayer: !!this._resolveDepthLayerCreation(docs),
      flattenItem: this._buildFlattenContextMenuItem(docs),
      onRename: (targetTileId) => this._beginRename(targetTileId),
      onChangeElevation: (targetDocs, anchor) => this._promptDocsElevationChange(targetDocs, anchor),
      onCreateSection: (targetDocs) => this._createSection(targetDocs, { selectedSectionIds }),
      onCreateDepthLayer: (targetDocs) => this._promoteSelectionToDepthLayer(targetDocs),
      onToggleLock: (targetDocs) => this._toggleDocsLock(targetDocs),
      onOpenNexusTileEditor: (doc) => this._openNexusTileEditor(doc),
      onOpenTileMaskEditor: (doc) => this._openTileMaskEditor(doc),
      onClearTileMasks: (targetDocs) => this._clearTileMasks(targetDocs),
      onOpenTileSettings: (tile) => this._openTileSettings(tile)
    }));
  }

  _removeFromSceneGroupItem(docs) {
    if (!isSceneGroupsEnabled()) return null;
    const registry = canvas.scene?.getFlag('fa-nexus','compositionRegistry');
    const memberships = new Set(Object.values(registry?.groups || {}).flatMap(group => group.directMemberUuids));
    const uuids = docs.map(doc => doc.uuid).filter(uuid => memberships.has(uuid));
    if (!uuids.length) return null;
    return {label:'Remove from Scene Group',iconClass:'fa-solid fa-arrow-right-from-bracket',action:async()=>{
      const {SceneGroupWorkflow} = await import('../composition/scene-group-workflow.js');
      return new SceneGroupWorkflow().execute({scene:canvas.scene,user:game.user,
        action:{type:'reparent-items',memberUuids:uuids,parentGroupId:null}});
    }};
  }

  async _addFolder({parentId = null, elevationKey = null}) {
    const metadata = getSceneLayerManagerSections();
    if (parentId && !metadata.sections[parentId]) throw new Error('The parent Folder no longer exists.');
    elevationKey ||= metadata.sections[parentId]?.elevationKey;
    if (!elevationKey) throw new Error('The destination Elevation is unavailable.');
    const id = foundry.utils.randomID();
    await this._runFolderHistoryAction('Add Folder', () => updateSceneLayerManagerSections(canvas.scene, current => {
      current.sections = {[id]:{name:'New Folder',parentId,elevationKey}, ...current.sections};
      return current;
    }));
    if (parentId) this._getSessionState().collapsedElevations.delete(sectionKey(parentId));
    this._getSessionState().collapsedElevations.delete(elevationKey);
    this._beginSectionNameEdit(id);
    return id;
  }

  _getMatchingSectionDocs(sectionId) {
    const ids = this._viewState?.matchingTileIdsBySection?.get?.(String(sectionId || '').trim()) || [];
    return this._getOrderedDocsByIds(ids);
  }

  _getFullSectionDocs(sectionId) {
    return (this._viewState?.fullSectionDocsById?.get?.(String(sectionId || '').trim()) || []).slice();
  }

  _resolveContiguousElevationSelection(docs = []) {
    const orderedDocs = this._getOrderedDocsByIds(docs.map((doc) => getTileDocumentId(doc)).filter(Boolean));
    if (!orderedDocs.length || this._viewState?.filtersApplied) return null;
    if (!canvas?.scene?.canUserModify?.(game?.user, 'update')) return null;
    if (orderedDocs.some((doc) => !doc?.canUserModify?.(game?.user, 'update'))) return null;
    const groupKeys = new Set(orderedDocs.map((doc) => this._viewState?.fullTileGroupKeyById?.get?.(getTileDocumentId(doc))));
    if (groupKeys.size !== 1) return null;
    const elevationKey = String(groupKeys.values().next().value || '').trim();
    const groupDocs = this._getFullElevationDocs(elevationKey);
    const slice = getContiguousSectionSlice(groupDocs, orderedDocs.map((doc) => getTileDocumentId(doc)));
    if (!slice) return null;
    return { orderedDocs, elevationKey, groupDocs };
  }

  _resolveSectionCreation(docs = [], { selectedSectionIds = Array.from(this._selectedSectionIds || []) } = {}) {
    const metadata = this._viewState?.sectionMetadata || getSceneLayerManagerSections();
    const wrap = resolveSectionWrapSelection({ metadata, selectedDocs: docs, selectedSectionIds });
    if (!wrap) return null;
    const sectionDocs = uniqueTileDocuments(wrap.sectionIds.flatMap((id) => this._getFullSectionDocs(id)));
    const resolved = this._resolveContiguousElevationSelection(uniqueTileDocuments([...wrap.looseDocs, ...sectionDocs]));
    if (!resolved) return null;
    if (wrap.sectionIds.some((id) => {
      const elevationKey = String(metadata.sections[id]?.elevationKey || '').trim();
      return elevationKey && elevationKey !== resolved.elevationKey;
    })) return null;
    return {
      ...resolved,
      allOrderedDocs: resolved.orderedDocs,
      orderedDocs: this._getOrderedDocsByIds(wrap.looseDocs.map((doc) => getTileDocumentId(doc))),
      sectionIds: wrap.sectionIds,
      parentId: wrap.parentId
    };
  }

  _resolveDepthLayerCreation(docs = []) {
    const resolved = this._resolveContiguousElevationSelection(docs);
    if (!resolved) return null;
    return resolved.orderedDocs.length < resolved.groupDocs.length ? resolved : null;
  }

  async _createSection(docs = [], options = {}) {
    const resolved = this._resolveSectionCreation(docs, options);
    if (!resolved) throw new Error('Select one contiguous stack range within a single Elevation to create a Folder.');
    const name = 'New Folder';
    const sectionId = foundry?.utils?.randomID?.() || crypto.randomUUID().replace(/-/g, '');
    await this._runFolderHistoryAction('Create Folder', () => updateSceneLayerManagerSections(canvas?.scene, (metadata) => {
      metadata.sections[sectionId] = {
        name,
        parentId: resolved.parentId,
        elevationKey: resolved.elevationKey
      };
      for (const childSectionId of resolved.sectionIds) {
        if (!metadata.sections[childSectionId]) throw new Error('Selected Folder no longer exists.');
        metadata.sections[childSectionId].parentId = sectionId;
      }
      for (const doc of resolved.orderedDocs) metadata.memberships[getTileDocumentId(doc)] = sectionId;
      return metadata;
    }));
    Logger.info('LayerManager.section.created', {
      sceneId: canvas?.scene?.id || null,
      sectionId,
      parentId: resolved.parentId,
      elevationKey: resolved.elevationKey,
      tileCount: resolved.allOrderedDocs.length,
      sectionCount: resolved.sectionIds.length
    });
    // As Add Folder does: show the new Folder and put the cursor in its name.
    if (resolved.parentId) this._getSessionState().collapsedElevations.delete(sectionKey(resolved.parentId));
    this._getSessionState().collapsedElevations.delete(resolved.elevationKey);
    this._beginSectionNameEdit(sectionId);
    return true;
  }

  _beginSectionNameEdit(sectionId) {
    const id = String(sectionId || '').trim();
    const metadata = getSceneLayerManagerSections();
    const section = metadata.sections[id];
    if (!section) throw new Error('Folder no longer exists.');
    if (!canvas?.scene?.canUserModify?.(game?.user, 'update')) {
      ui?.notifications?.warn?.('You do not have permission to rename Folders.');
      return false;
    }
    this._clearRenameState();
    this._clearElevationGroupEditState();
    this._editingSectionNameId = id;
    this._editingSectionNameDraft = section.name;
    this._editingSectionNameFocusPending = true;
    this._scheduleRender();
    return true;
  }

  async _removeSection(sectionId) {
    const id = String(sectionId || '').trim();
    const metadata = this._viewState?.sectionMetadata || getSceneLayerManagerSections();
    if (!metadata?.sections?.[id]) throw new Error('Folder no longer exists.');
    const confirmed = await foundry?.applications?.api?.DialogV2?.confirm?.({
      window: { title: 'Remove Folder' },
      content: '<p>Remove this Folder? Its layers will keep their current elevation and stacking order.</p>',
      modal: true,
      rejectClose: false,
      yes: { icon: 'fas fa-folder-minus', label: 'Remove' },
      no: { icon: 'fas fa-times', label: 'Cancel' }
    });
    if (!confirmed) return false;
    await this._runFolderHistoryAction('Remove Folder', () => updateSceneLayerManagerSections(canvas?.scene, (current) => {
      if (!current.sections[id]) throw new Error('Folder no longer exists.');
      return removeLayerManagerSection(current, id);
    }));
    this._getSessionState()?.collapsedElevations?.delete?.(sectionKey(id));
    queuePersistLayerManagerCollapsedState();
    this._scheduleRender();
    return true;
  }

  async _promoteSection(sectionId) {
    const id = String(sectionId || '').trim();
    const metadata = cloneLayerManagerSections(this._viewState?.sectionMetadata || getSceneLayerManagerSections());
    const section = metadata.sections[id];
    if (!canvas?.scene || !section) throw new Error('Folder no longer exists.');
    if (this._viewState?.filtersApplied) throw new Error('Clear Layer Manager filters before promoting a Folder.');
    const sectionDocs = this._getFullSectionDocs(id);
    if (!sectionDocs.length) throw new Error('Folder has no layers to promote.');
    const sourceKey = String(section.elevationKey || this._viewState?.fullTileGroupKeyById?.get?.(getTileDocumentId(sectionDocs[0])) || '').trim();
    return this._promoteDepthRange({
      selectedDocs: sectionDocs,
      sourceKey,
      sectionId: id,
      sectionName: section.name,
      sectionMetadata: metadata
    });
  }

  async _promoteSelectionToDepthLayer(docs = []) {
    const resolved = this._resolveDepthLayerCreation(docs);
    if (!resolved) throw new Error('Select one contiguous stack range within an Elevation.');
    return this._promoteDepthRange({
      selectedDocs: resolved.orderedDocs,
      sourceKey: resolved.elevationKey
    });
  }

  _getAdjacentElevationGroups(sourceKey) {
    const sourceElevation = Number(this._viewState?.fullExactGroupElevationsByKey?.get?.(sourceKey) ?? this._resolveGroupElevation(sourceKey));
    const bandIdentity = getElevationBandIdentity(sourceKey);
    return Array.from(this._viewState?.fullExactGroupElevationsByKey || [])
      .filter(([groupKey, elevation]) => groupKey !== sourceKey
        && getElevationBandIdentity(groupKey) === bandIdentity
        && Number.isFinite(Number(elevation)))
      .map(([elevationKey, elevation]) => ({
        elevationKey,
        elevation: Number(elevation),
        docs: this._getFullElevationDocs(elevationKey).slice().sort(sortLayerManagerTileDocs)
      }))
      .concat(Number.isFinite(sourceElevation) ? [{
        elevationKey: sourceKey,
        elevation: sourceElevation,
        docs: this._getFullElevationDocs(sourceKey).slice().sort(sortLayerManagerTileDocs)
      }] : []);
  }

  _resolveElevationToFolderTarget(sourceKey) {
    const sourceElevation = Number(this._viewState?.fullExactGroupElevationsByKey?.get?.(sourceKey) ?? this._resolveGroupElevation(sourceKey));
    if (!Number.isFinite(sourceElevation)) return null;
    const candidates = this._getAdjacentElevationGroups(sourceKey).filter((group) => group.elevation !== sourceElevation);
    const lower = candidates
      .filter((group) => group.elevation < sourceElevation)
      .sort((left, right) => right.elevation - left.elevation)[0] || null;
    if (lower) return { ...lower, placement: 'above' };
    const upper = candidates
      .filter((group) => group.elevation > sourceElevation)
      .sort((left, right) => left.elevation - right.elevation)[0] || null;
    return upper ? { ...upper, placement: 'below' } : null;
  }

  async _convertElevationToFolder(sourceKey) {
    if (this._folderHistoryCaptureDepth === 0) {
      return this._runFolderHistoryAction('Convert Elevation to Folder', () => this._convertElevationToFolder(sourceKey));
    }
    const scene = canvas?.scene;
    const key = String(sourceKey || '').trim();
    const target = this._resolveElevationToFolderTarget(key);
    if (!scene || !key || !target) throw new Error('This Elevation has no lower sibling Elevation to convert into.');
    if (this._viewState?.filtersApplied) throw new Error('Clear Layer Manager filters before converting an Elevation to a Folder.');
    const sourceDocs = this._getFullElevationDocs(key).slice().sort(sortLayerManagerTileDocs);
    if (!sourceDocs.length) throw new Error('Elevation has no layers to convert.');
    if (sourceDocs.some((doc) => !doc?.canUserModify?.(game?.user, 'update'))) {
      throw new Error('You do not have permission to move every layer in this Elevation.');
    }
    const updates = planElevationGroupToFolder({
      sourceDocs,
      targetDocs: target.docs,
      targetElevation: target.elevation,
      placement: target.placement
    });
    const metadata = cloneLayerManagerSections(this._viewState?.sectionMetadata || getSceneLayerManagerSections(scene));
    const folderId = foundry?.utils?.randomID?.() || crypto.randomUUID().replace(/-/g, '');
    const elevationMetadata = cloneElevationGroupMetadata(getSceneElevationGroupMetadata(scene));
    const node = this._getFullGroupNode(key);
    const folderName = String(elevationMetadata[key]?.name || node?.defaultName || `Elev ${formatElevation(this._resolveGroupElevation(key))}`).trim();
    const sourceSectionIds = new Set(Object.entries(metadata.sections)
      .filter(([, section]) => String(section?.elevationKey || '').trim() === key)
      .map(([id]) => id));
    const rootSourceSectionIds = Array.from(sourceSectionIds).filter((id) => !sourceSectionIds.has(metadata.sections[id]?.parentId));
    const sourceTileIds = new Set(sourceDocs.map((doc) => getTileDocumentId(doc)).filter(Boolean));

    this._sectionElevationMutationDepth = Number(this._sectionElevationMutationDepth || 0) + 1;
    try {
      await this._updateEmbeddedDocumentsForFolderHistory('Tile', updates);
      await updateSceneLayerManagerSections(scene, (current) => {
        current.sections[folderId] = { name: folderName, parentId: null, elevationKey: target.elevationKey };
        for (const sectionId of sourceSectionIds) {
          if (!current.sections[sectionId]) continue;
          current.sections[sectionId].elevationKey = target.elevationKey;
        }
        for (const sectionId of rootSourceSectionIds) {
          if (current.sections[sectionId]) current.sections[sectionId].parentId = folderId;
        }
        for (const tileId of sourceTileIds) {
          const memberId = current.memberships[tileId];
          if (!memberId || !sourceSectionIds.has(memberId)) current.memberships[tileId] = folderId;
        }
        return current;
      });
      delete elevationMetadata[key];
      await setSceneElevationGroupMetadata(scene, elevationMetadata);
    } finally {
      this._sectionElevationMutationDepth = Math.max(0, Number(this._sectionElevationMutationDepth || 0) - 1);
      this._sectionElevationReconcilePending = false;
    }
    this._getSessionState()?.collapsedElevations?.delete?.(key);
    queuePersistLayerManagerCollapsedState();
    this._scheduleRender();
    return true;
  }

  async _promoteDepthRange({
    selectedDocs = [],
    sourceKey = '',
    sectionId = null,
    sectionName = '',
    sectionMetadata = null
  } = {}) {
    if (this._folderHistoryCaptureDepth === 0) {
      return this._runFolderHistoryAction('Promote to Elevation', () => this._promoteDepthRange({
        selectedDocs,
        sourceKey,
        sectionId,
        sectionName,
        sectionMetadata
      }));
    }
    const scene = canvas?.scene;
    if (!scene) throw new Error('No active scene available.');
    if (this._viewState?.filtersApplied) throw new Error('Clear Layer Manager filters before creating an Elevation.');
    const sourceDocs = this._getFullElevationDocs(sourceKey);
    const sourceElevation = Number(this._viewState?.fullExactGroupElevationsByKey?.get?.(sourceKey));
    const plan = planSectionPromotion({
      orderedDocs: sourceDocs,
      sectionTileIds: selectedDocs.map((doc) => getTileDocumentId(doc)),
      sourceElevation,
      step: ELEVATION_STEP_FINE
    });
    const bandIdentity = getElevationBandIdentity(sourceKey);
    const higherGroups = [];
    for (const [groupKey, elevation] of this._viewState?.fullExactGroupElevationsByKey || []) {
      if (getElevationBandIdentity(groupKey) !== bandIdentity || Number(elevation) <= sourceElevation) continue;
      higherGroups.push({ groupKey, elevation: Number(elevation), docs: this._getFullElevationDocs(groupKey) });
    }
    const plannedHigherGroups = planHigherElevationShifts({
      groups: higherGroups,
      occupiedThrough: plan.above.length ? plan.upperElevation : plan.promotedElevation,
      step: ELEVATION_STEP_FINE
    });
    const shiftedHigherGroups = plannedHigherGroups.filter((group) => group.shifted);
    const affectedDocs = [...plan.selected, ...plan.above, ...shiftedHigherGroups.flatMap((group) => group.docs)];
    if (affectedDocs.some((doc) => !doc?.canUserModify?.(game?.user, 'update'))) {
      throw new Error('You do not have permission to move every affected layer.');
    }
    const updatesById = new Map();
    const setElevation = (docsToMove, elevation) => {
      for (const doc of docsToMove) updatesById.set(getTileDocumentId(doc), { _id: getTileDocumentId(doc), elevation: quantizeElevation(elevation) });
    };
    setElevation(plan.selected, plan.promotedElevation);
    if (plan.above.length) setElevation(plan.above, plan.upperElevation);
    for (const group of shiftedHigherGroups) setElevation(group.docs, group.targetElevation);
    const updates = Array.from(updatesById.values()).filter((update) => {
      const doc = scene.tiles?.get?.(update._id);
      return quantizeElevation(doc?.elevation ?? 0) !== update.elevation;
    });
    if (updates.length) {
      this._sectionElevationMutationDepth = Number(this._sectionElevationMutationDepth || 0) + 1;
      try {
        await this._updateEmbeddedDocumentsForFolderHistory('Tile', updates);
        await waitForUiFrame(0);
      } finally {
        this._sectionElevationMutationDepth = Math.max(0, Number(this._sectionElevationMutationDepth || 0) - 1);
      }
    }

    const selectedTileIds = plan.selected.map((doc) => getTileDocumentId(doc)).filter(Boolean);
    const metadata = cloneLayerManagerSections(sectionMetadata || this._viewState?.sectionMetadata || getSceneLayerManagerSections());
    const directTileIds = sectionId
      ? Object.entries(metadata.memberships)
        .filter(([, memberSectionId]) => memberSectionId === sectionId)
        .map(([tileId]) => tileId)
      : [];
    const childSectionIds = sectionId
      ? Object.entries(metadata.sections)
        .filter(([, candidate]) => candidate.parentId === sectionId)
        .map(([childId]) => childId)
      : [];
    const hasSelectedMemberships = selectedTileIds.some((tileId) => !!metadata.memberships[tileId]);
    if (sectionId || hasSelectedMemberships) {
      await updateSceneLayerManagerSections(scene, (current) => {
        if (sectionId) {
          if (!current.sections[sectionId]) throw new Error('Promoted Folder no longer exists.');
          const nextSections = removeLayerManagerSection(current, sectionId);
          for (const tileId of directTileIds) delete nextSections.memberships[tileId];
          for (const childId of childSectionIds) {
            if (nextSections.sections[childId]) nextSections.sections[childId].parentId = null;
          }
          return nextSections;
        }
        for (const tileId of selectedTileIds) delete current.memberships[tileId];
        return current;
      });
    }
    const promotionKey = buildSiblingElevationKey(sourceKey, plan.promotedElevation);
    let elevationMetadata = cloneElevationGroupMetadata(getSceneElevationGroupMetadata(scene));
    const moves = shiftedHigherGroups.map((group) => ({
      sourceKey: group.groupKey,
      targetKey: buildSiblingElevationKey(group.groupKey, group.targetElevation)
    }));
    elevationMetadata = mergeElevationGroupMetadataOnBulkMove({ metadata: elevationMetadata, moves });
    if (!plan.below.length && sectionName) delete elevationMetadata[sourceKey];
    if (sectionName) elevationMetadata[promotionKey] = { name: sectionName };
    if (moves.length || sectionName) await setSceneElevationGroupMetadata(scene, elevationMetadata);
    if (this._sectionElevationReconcilePending) {
      this._sectionElevationReconcilePending = false;
      this._queueSectionElevationReconcile();
    }
    Logger.info(sectionId ? 'LayerManager.section.promoted' : 'LayerManager.selection.promoted', {
      sceneId: scene.id || null,
      sectionId,
      sourceKey,
      promotionKey,
      shiftedHigherGroupCount: shiftedHigherGroups.length,
      tileUpdateCount: updates.length
    });
    await waitForUiFrame(32);
    this._scheduleRender();
    return true;
  }

  _captureFolderHistorySnapshot(scene = canvas?.scene) {
    if (!scene) throw new Error('No active scene available for Folder history.');
    const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const tiles = Array.from(scene.tiles || []).map((doc) => {
      const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID] || {};
      return {
        _id: getTileDocumentId(doc),
        elevation: Number(doc?.elevation ?? 0) || 0,
        sort: Number(doc?.sort ?? 0) || 0,
        levels: clone(doc?.levels ?? doc?._source?.levels ?? []),
        placementLevelId: String(flags?.placementLevelId || '').trim() || null
      };
    }).filter((entry) => entry._id);
    return {
      sections: cloneLayerManagerSections(getSceneLayerManagerSections(scene)),
      elevationGroups: cloneElevationGroupMetadata(getSceneElevationGroupMetadata(scene)),
      tiles
    };
  }

  _folderHistorySnapshotsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  _buildFolderHistoryTileUpdates(snapshot) {
    return (snapshot?.tiles || []).map((wanted) => {
      const update = {
        _id: wanted._id,
        elevation: wanted.elevation,
        sort: wanted.sort,
        levels: wanted.levels ?? []
      };
      if (wanted.placementLevelId) update[`flags.${MODULE_ID}.placementLevelId`] = wanted.placementLevelId;
      else update[`flags.${MODULE_ID}.-=placementLevelId`] = null;
      return update;
    }).filter((update) => update._id);
  }

  _getFolderHistoryRecord(entry) {
    if (entry?.type !== 'update') return null;
    const record = entry?.options?.[FOLDER_HISTORY_OPTION];
    return record && typeof record === 'object' ? record : null;
  }

  _storeFolderHistoryRecord(record) {
    const layer = canvas?.tiles;
    if (typeof layer?._storeHistory !== 'function') {
      throw new Error('The active Tiles layer does not expose Foundry update history.');
    }
    layer._storeHistory('update', this._buildFolderHistoryTileUpdates(record.before), {
      diff: false,
      [FOLDER_HISTORY_OPTION]: record
    });
  }

  async _runFolderHistoryAction(label, action) {
    if (typeof action !== 'function') throw new TypeError('Folder history action must be a function.');
    if (this._folderHistoryRestoring || this._folderHistoryCaptureDepth > 0) return action();
    const scene = canvas?.scene;
    if (!scene) throw new Error('No active scene available for Folder action.');
    const before = this._captureFolderHistorySnapshot(scene);
    this._folderHistoryCaptureDepth += 1;
    try {
      const result = await action();
      const after = this._captureFolderHistorySnapshot(scene);
      if (!this._folderHistorySnapshotsEqual(before, after)) {
        this._storeFolderHistoryRecord({
          label: String(label || 'Folder change'),
          sceneId: scene.id || null,
          before,
          after
        });
        this._folderHistoryRedo.length = 0;
      }
      return result;
    } finally {
      this._folderHistoryCaptureDepth = Math.max(0, this._folderHistoryCaptureDepth - 1);
      // Sort and folder membership are one visible history action. Painting
      // between the Tile and Scene writes makes a single wheel step jump twice.
      if (this._sectionElevationReconcilePending) {
        this._sectionElevationReconcilePending = false;
        this._queueSectionElevationReconcile();
      }
      if (this._folderHistoryRenderPending) {
        this._folderHistoryRenderPending = false;
        this._scheduleRender();
      }
    }
  }

  _updateEmbeddedDocumentsForFolderHistory(type, updates, options = {}) {
    const scene = canvas?.scene;
    if (!scene?.updateEmbeddedDocuments) throw new Error('No active scene available for layer updates.');
    const historyOptions = this._folderHistoryCaptureDepth > 0
      ? { ...options, isUndo: true, faNexusFolderHistoryCapture: true }
      : options;
    return scene.updateEmbeddedDocuments(type, updates, historyOptions);
  }

  async _restoreFolderHistoryMetadata(snapshot) {
    const scene = canvas?.scene;
    if (!scene || !snapshot) return false;
    applySceneLayerManagerSectionsLocally(scene, snapshot.sections);
    applySceneElevationGroupMetadataLocally(scene, snapshot.elevationGroups);
    // The local Scene already shows the restored state: the save must be sent all the same.
    await setSceneLayerManagerSections(scene, snapshot.sections, { force: true });
    await setSceneElevationGroupMetadata(scene, snapshot.elevationGroups, { force: true });
    return true;
  }

  async _restoreFolderHistorySnapshot(snapshot) {
    const scene = canvas?.scene;
    if (!scene || !snapshot) return false;
    const wantedById = new Map((snapshot.tiles || []).map((entry) => [entry._id, entry]));
    const updates = [];
    for (const doc of Array.from(scene.tiles || [])) {
      const wanted = wantedById.get(getTileDocumentId(doc));
      if (!wanted) continue;
      const update = { _id: wanted._id };
      if (Number(doc.elevation) !== Number(wanted.elevation)) update.elevation = wanted.elevation;
      if (Number(doc.sort) !== Number(wanted.sort)) update.sort = wanted.sort;
      if (JSON.stringify(doc.levels ?? doc?._source?.levels ?? []) !== JSON.stringify(wanted.levels ?? [])) {
        update.levels = wanted.levels ?? [];
      }
      const currentPlacementLevelId = String(doc?.flags?.[MODULE_ID]?.placementLevelId || '').trim() || null;
      if (currentPlacementLevelId !== wanted.placementLevelId) {
        if (wanted.placementLevelId) update[`flags.${MODULE_ID}.placementLevelId`] = wanted.placementLevelId;
        else update[`flags.${MODULE_ID}.-=placementLevelId`] = null;
      }
      if (Object.keys(update).length > 1) updates.push(update);
    }
    this._folderHistoryRestoring = true;
    this._sectionElevationMutationDepth = Number(this._sectionElevationMutationDepth || 0) + 1;
    try {
      if (updates.length) await scene.updateEmbeddedDocuments('Tile', updates, { isUndo: true, faNexusFolderHistoryRestore: true });
      await this._restoreFolderHistoryMetadata(snapshot);
    } finally {
      this._sectionElevationMutationDepth = Math.max(0, Number(this._sectionElevationMutationDepth || 0) - 1);
      this._folderHistoryRestoring = false;
      this._sectionElevationReconcilePending = false;
    }
    this._scheduleRender();
    return true;
  }

  async _undoFolderHistory() {
    const history = canvas?.tiles?.history;
    const entry = Array.isArray(history) ? history.at(-1) : null;
    const record = this._getFolderHistoryRecord(entry);
    if (!record || record.sceneId !== (canvas?.scene?.id || null)) return false;
    history.pop();
    await this._restoreFolderHistorySnapshot(record.before);
    this._folderHistoryRedo.push({
      entry,
      historyLength: history.length,
      historyTop: history.at(-1) || null
    });
    ui?.notifications?.info?.(`Undid ${record.label}.`);
    return true;
  }

  _handleNativeFolderHistoryUndo(options = {}) {
    const record = options?.[FOLDER_HISTORY_OPTION];
    if (!options?.isUndo || !record || options.faNexusFolderHistoryHandled) return false;
    options.faNexusFolderHistoryHandled = true;
    if (record.sceneId !== (canvas?.scene?.id || null)) return false;
    const history = canvas?.tiles?.history;
    if (!Array.isArray(history)) return false;
    applySceneLayerManagerSectionsLocally(canvas.scene, record.before.sections);
    applySceneElevationGroupMetadataLocally(canvas.scene, record.before.elevationGroups);
    const entry = {
      type: 'update',
      data: this._buildFolderHistoryTileUpdates(record.before),
      options: { diff: false, [FOLDER_HISTORY_OPTION]: record }
    };
    this._folderHistoryRedo.push({
      entry,
      historyLength: history.length,
      historyTop: history.at(-1) || null
    });
    this._folderHistoryQueue = this._folderHistoryQueue
      .then(() => this._restoreFolderHistoryMetadata(record.before))
      .then(() => this._scheduleRender())
      .catch((error) => this._notifyLayerManagerActionError('restore native Folder undo metadata', error));
    return true;
  }

  async _redoFolderHistoryChange() {
    const history = canvas?.tiles?.history;
    const redo = this._folderHistoryRedo.at(-1);
    if (!Array.isArray(history) || !redo) return false;
    const record = this._getFolderHistoryRecord(redo.entry);
    if (!record || record.sceneId !== (canvas?.scene?.id || null)
      || history.length !== redo.historyLength
      || (history.at(-1) || null) !== redo.historyTop) {
      this._folderHistoryRedo.length = 0;
      return false;
    }
    await this._restoreFolderHistorySnapshot(record.after);
    this._storeFolderHistoryRecord(record);
    this._folderHistoryRedo.pop();
    ui?.notifications?.info?.(`Redid ${record.label}.`);
    return true;
  }

  _handleFolderHistoryShortcut(event) {
    if ((!this.active && !this.isPopout) || this._isEditableElement(event?.target) || this._isEditableElement(document?.activeElement)) return false;
    // A confirmation that is open owns the keyboard: nothing is undone behind it.
    if (document?.querySelector?.('dialog:modal')) return false;
    const hasModifier = !!(event?.ctrlKey || event?.metaKey);
    const key = String(event?.key || '').toLowerCase();
    const undo = hasModifier && key === 'z' && !event?.shiftKey;
    const redo = hasModifier && (key === 'y' || (key === 'z' && event?.shiftKey));
    const canUndo = undo && !!this._getFolderHistoryRecord(canvas?.tiles?.history?.at?.(-1));
    const canRedo = redo && this._folderHistoryRedo.length > 0;
    if (!canUndo && !canRedo) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    this._folderHistoryQueue = this._folderHistoryQueue
      .then(() => canUndo ? this._undoFolderHistory() : this._redoFolderHistoryChange())
      .catch((error) => this._notifyLayerManagerActionError(canUndo ? 'undo Folder change' : 'redo Folder change', error));
    return true;
  }

  _onListHover(event) {
    return routeLayerManagerRowHover({
      event,
      hoveredTileId: this._hoveredTileId,
      clearHover: () => this._clearHover(),
      getTilePlaceable: (tileId) => this._getTilePlaceable(tileId),
      isTileBeingEdited,
      hoverEvent: hoverEventStub,
      setHoveredTileId: (tileId) => { this._hoveredTileId = tileId; }
    });
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
    if (this._handleFolderHistoryShortcut(event)) return;
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
    if (collectLayerManagerPreviewEntries().some((entry) => entry?.previewActive === true)) return false;
    const direction = event.deltaY < 0 ? 1 : -1;
    if (event?.ctrlKey || event?.metaKey) {
      if (!this._getSelectedTileDocs().length) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      this._sortNudgeQueue = this._sortNudgeQueue
        .then(() => this._nudgeSortSelection(direction))
        .catch((error) => this._notifyLayerManagerActionError('reorder selected layers', error));
      return true;
    }
    this._adjustElevationSelection(direction, event, { pointer, source: 'wheel' });
  }

  async _nudgeSortSelection(direction) {
    if (this._folderHistoryCaptureDepth === 0) {
      return this._runFolderHistoryAction('Reorder Layers', () => this._nudgeSortSelection(direction));
    }
    // Queued wheel events must consume the previous event's committed folders
    // and elevation, even when the coalesced window render has not run yet.
    this._viewState = buildEntriesFromCanvas({
      sessionState: this._getSessionState(),
      selectedSectionIds: new Set(this._selectedSectionIds || [])
    });
    const selectedDocs = this._getSelectedTileDocs();
    if (!selectedDocs.length) return false;
    if (selectedDocs.some((doc) => !doc?.canUserModify?.(game?.user, 'update'))) {
      throw new Error('You do not have permission to reorder every selected layer.');
    }
    const groupKeys = new Set(selectedDocs.map((doc) => this._resolveDisplayElevationKeyForDoc(doc)).filter(Boolean));
    if (groupKeys.size !== 1) return false;
    const elevationKey = groupKeys.values().next().value;
    const metadata = this._viewState?.sectionMetadata || getSceneLayerManagerSections();
    const orderedDocs = orderLayerManagerSectionDocuments(
      this._getFullElevationDocs(elevationKey).slice().sort(sortLayerManagerTileDocs), metadata, elevationKey);
    const movingIds = selectedDocs.map((doc) => getTileDocumentId(doc)).filter(Boolean);
    const target = resolveLayerManagerAdjacentSortDropTarget({
      orderedDocs,
      movingIds,
      direction,
      elevationKey,
      sectionMetadata: metadata
    });
    if (!target) {
      const movingSet = new Set(movingIds);
      const selectedIndexes = orderedDocs
        .map((doc, index) => movingSet.has(getTileDocumentId(doc)) ? index : -1)
        .filter((index) => index >= 0);
      const atBoundary = selectedIndexes.length === movingIds.length
        && movingIds.every(id => !getTileSectionId(metadata, id))
        && (Math.max(...selectedIndexes) - Math.min(...selectedIndexes) + 1) === selectedIndexes.length
        && (direction > 0 ? Math.min(...selectedIndexes) === 0 : Math.max(...selectedIndexes) === orderedDocs.length - 1);
      if (!atBoundary) return false;
      const sourceElevation = Number(this._viewState?.fullExactGroupElevationsByKey?.get?.(elevationKey) ?? selectedDocs[0]?.elevation);
      const adjacent = resolveLayerManagerAdjacentElevationNudgeTarget({
        groups: this._getAdjacentElevationGroups(elevationKey),
        currentElevationKey: elevationKey,
        currentElevation: sourceElevation,
        direction
      });
      if (!adjacent) return false;
      const crossTarget = { kind: 'elevation-edge', elevationKey: adjacent.elevationKey,
        sectionId: null, placeBefore: adjacent.edge === 'top' };
      const result = await this._applyDropReorder(crossTarget, { tileIds: movingIds }, { hierarchicalOrder: true });
      return !!result?.applied;
    }
    const result = await this._applyDropReorder(target, { tileIds: movingIds }, { hierarchicalOrder: true });
    return !!result?.applied;
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
      renameSubmitting: this._renameSubmitting || this._editingSectionNameSubmitting
    });
  }

  _isEditableElement(element) {
    return isEditableLayerManagerElement(element);
  }

  _beginRenameFromHotkey() {
    const selectedFolderIds = Array.from(this._selectedSectionIds || []);
    if (selectedFolderIds.length === 1) {
      this._beginSectionNameEdit(selectedFolderIds[0]);
      return;
    }
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

  _clearSectionNameEditState() {
    this._editingSectionNameId = null;
    this._editingSectionNameDraft = '';
    this._editingSectionNameFocusPending = false;
  }

  _cancelSectionNameEdit() {
    if (!this._editingSectionNameId) return false;
    this._clearSectionNameEditState();
    this._scheduleRender();
    return true;
  }

  async _commitSectionNameEdit(inputEl = null) {
    const sectionId = String(this._editingSectionNameId || '').trim();
    if (!sectionId || this._editingSectionNameSubmitting) return false;
    const nextName = String(inputEl?.value ?? this._editingSectionNameDraft ?? '').trim();
    if (!nextName) throw new Error('Folder name cannot be empty.');
    const current = getSceneLayerManagerSections(canvas?.scene);
    const section = current.sections[sectionId];
    if (!section) {
      this._clearSectionNameEditState();
      this._scheduleRender();
      return false;
    }
    if (section.name === nextName) {
      this._clearSectionNameEditState();
      this._scheduleRender();
      return false;
    }
    this._editingSectionNameSubmitting = true;
    try {
      await this._runFolderHistoryAction('Rename Folder', async () => updateSceneLayerManagerSections(canvas?.scene, (metadata) => {
        if (!metadata.sections[sectionId]) throw new Error('Folder no longer exists.');
        metadata.sections[sectionId].name = nextName;
        return metadata;
      }));
      this._clearSectionNameEditState();
      this._scheduleRender();
      return true;
    } catch (error) {
      this._editingSectionNameFocusPending = true;
      this._scheduleRender();
      throw error;
    } finally {
      this._editingSectionNameSubmitting = false;
    }
  }

  _onSectionNameInputKeyDown(event) {
    if (event?.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void this._commitSectionNameEdit(event.currentTarget).catch((error) => this._notifyLayerManagerActionError('rename Folder', error));
      return true;
    }
    if (event?.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      return this._cancelSectionNameEdit();
    }
    return false;
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
      referenceDoc: doc
    }).catch((error) => this._notifyLayerManagerActionError('toggle layer visibility', error));
  }

  _toggleElevationVisibility(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const elevationKey = String(buttonEl?.dataset?.elevationKey || separator?.dataset?.elevationKey || '').trim();
    if (!elevationKey) return;
    const docs = this._getMatchingElevationDocs(elevationKey);
    void this._toggleDocsVisibility(docs, {
      source: 'elevationHeader'
    }).catch((error) => this._notifyLayerManagerActionError('toggle elevation visibility', error));
  }

  _toggleSectionVisibility(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const sectionId = String(buttonEl?.dataset?.sectionId || separator?.dataset?.sectionId || '').trim();
    if (!sectionId) return;
    void this._toggleDocsVisibility(this._getMatchingSectionDocs(sectionId), {
      source: 'sectionHeader'
    }).catch((error) => this._notifyLayerManagerActionError('toggle Folder visibility', error));
  }

  _toggleSceneMarkerVisibility(buttonEl) {
    const item = buttonEl?.closest?.('[data-scene-marker]');
    const markerId = String(item?.dataset?.sceneMarker || '').trim();
    if (!markerId) return;
    this._visibilityWorkflow.toggleSceneMarkerVisibility(markerId);
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

  _clearSectionSelection({ scheduleRender = true } = {}) {
    if (!this._selectedSectionIds?.size) return false;
    this._selectedSectionIds.clear();
    if (scheduleRender) this._scheduleRender();
    return true;
  }

  _selectSceneMarker(markerEl, event = null) {
    this._clearSectionSelection({ scheduleRender: false });
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
    this._clearSectionSelection({ scheduleRender: false });
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

  _selectSection(separatorEl, event) {
    const sectionId = String(separatorEl?.dataset?.sectionId || '').trim();
    if (!sectionId) return;
    const list = separatorEl.closest?.('.fa-nexus-layer-manager__list') || separatorEl.parentElement;
    const items = list
      ? Array.from(list.querySelectorAll('[data-tile-id], .fa-nexus-layer-manager__separator--section[data-section-id]'))
      : [separatorEl];
    const currentIndex = items.indexOf(separatorEl);
    const docs = sectionId ? this._getMatchingSectionDocs(sectionId) : [];
    try {
      const isMeta = !!(event?.ctrlKey || event?.metaKey);
      if (event?.shiftKey && !isMeta && this._lastClickedIndex >= 0) {
        this._activateTilesLayer();
        this._selectVisibleListRange(items, currentIndex, { retainSelection: isMeta });
        this._lastClickedIndex = currentIndex;
        this._lastClickedTileId = null;
        this._syncSelectionFromCanvas();
        return;
      }
      this._lastClickedIndex = currentIndex;
      this._lastClickedTileId = null;
      const selectChildren = isMeta && !!event?.shiftKey;
      if (!selectChildren) {
        if (isMeta) {
          if (this._selectedSectionIds.has(sectionId)) this._selectedSectionIds.delete(sectionId);
          else this._selectedSectionIds.add(sectionId);
          this._scheduleRender();
          this._updateSelectionActions();
          this._updateFlattenFooter();
          return;
        }

        this._selectedSectionIds.clear();
        this._selectedSectionIds.add(sectionId);
        this._clearSceneMarkerSelection();
        this._clearTileSelectionContextForNexus('sectionHeader');
        this._activateTilesLayer();
        canvas?.tiles?.releaseAll?.({ renderSidebar: false });
        renderTileSelectionSidebar();
        this._scheduleRender();
        this._updateSelectionActions();
        this._updateFlattenFooter();
        return;
      }

      this._clearSectionSelection({ scheduleRender: true });
      if (docs.length) {
        const controlledIds = new Set((Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : [])
          .map((tile) => tile?.document?.id || tile?.id)
          .filter(Boolean));
        if (docs.every((doc) => controlledIds.has(getTileDocumentId(doc)))) {
          this._releaseTileDocs(docs, {
            source: 'sectionHeader.meta',
            allowAutoExpand: false,
            allowScrollToTile: false
          });
          return;
        }
      }
      this._selectTileDocs(docs, {
        retainSelection: true,
        force: true,
        source: 'sectionHeader'
      });
    } catch (error) {
      this._notifyLayerManagerActionError('select Section', error);
    }
  }

  _selectCurrentLevelBand(markerEl = null) {
    this._clearSectionSelection({ scheduleRender: false });
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
    void this._toggleDocsVisibility(docs, {
      source: 'levelBoundary'
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
  onFoundryBoot('init', () => {
    ensureSceneLevelTextureVisibilityPatch();
    registerLayerManagerTab();
  });
} catch (_) {}

try {
  Hooks.once('canvasReady', () => {
    ensureLayerSelectionInteractivityPatches();
    ensureLayerHiddenHooks();
  });
} catch (_) {}
