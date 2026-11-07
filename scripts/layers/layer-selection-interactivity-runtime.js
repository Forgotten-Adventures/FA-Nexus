import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { bulkLayerDocumentUpdateState } from './actions/visibility-command-workflow.js';

export const SELECTION_FILTER_BLOCK_KEY = '_faNexusSelectionFilterBlocked';
export const TILE_EVENT_MODE_BASE_KEY = '_faNexusForcedEventModeBase';
export const TILE_EVENT_MODE_EDIT_BLOCK_KEY = '_faNexusEditEventModeBlocked';
export const TILE_EVENT_MODE_SELECTION_BLOCK_KEY = '_faNexusSelectionEventModeBlocked';
export const TILE_EVENT_MODE_HIDDEN_BLOCK_KEY = '_faNexusHiddenEventModeBlocked';

let runtimeAdapters = {};

export function configureLayerSelectionInteractivityRuntime(adapters = {}) {
  runtimeAdapters = { ...runtimeAdapters, ...adapters };
}

function requireAdapter(name) {
  const adapter = runtimeAdapters[name];
  if (typeof adapter !== 'function') {
    throw new Error(`Layer selection interactivity runtime missing ${name} adapter.`);
  }
  return adapter;
}

function getSelectionFilterState() {
  const state = requireAdapter('getSelectionFilterState')();
  if (!state || typeof state !== 'object') {
    throw new Error('Layer selection interactivity runtime missing selection filter state.');
  }
  return state;
}

function getTileId(tile) {
  return tile?.document?.id || tile?.id || null;
}

export function hasForcedTileEventModeBlock(tile) {
  return !!(
    tile?.[TILE_EVENT_MODE_EDIT_BLOCK_KEY]
    || tile?.[TILE_EVENT_MODE_SELECTION_BLOCK_KEY]
    || tile?.[TILE_EVENT_MODE_HIDDEN_BLOCK_KEY]
  );
}

export function markTileEventModeBlocked(tile, reasonKey) {
  if (!tile || typeof tile.eventMode === 'undefined' || !reasonKey) return;
  if (!hasForcedTileEventModeBlock(tile) && !Object.prototype.hasOwnProperty.call(tile, TILE_EVENT_MODE_BASE_KEY)) {
    try { tile[TILE_EVENT_MODE_BASE_KEY] = tile.eventMode; } catch (error) {
      Logger.error('LayerManager.tileEventMode.blockBaseStore.failed', {
        tileId: getTileId(tile),
        reasonKey,
        error: String(error?.message || error)
      });
      throw error;
    }
  }
  try { tile[reasonKey] = true; } catch (error) {
    Logger.error('LayerManager.tileEventMode.blockMarker.failed', {
      tileId: getTileId(tile),
      reasonKey,
      error: String(error?.message || error)
    });
    throw error;
  }
  if (tile.eventMode !== 'none') {
    try { tile.eventMode = 'none'; } catch (error) {
      Logger.error('LayerManager.tileEventMode.blockApply.failed', {
        tileId: getTileId(tile),
        reasonKey,
        error: String(error?.message || error)
      });
      throw error;
    }
  }
}

export function clearTileEventModeBlocked(tile, reasonKey) {
  if (!tile || typeof tile.eventMode === 'undefined') return;
  const otherBlockActive = [
    TILE_EVENT_MODE_EDIT_BLOCK_KEY,
    TILE_EVENT_MODE_SELECTION_BLOCK_KEY,
    TILE_EVENT_MODE_HIDDEN_BLOCK_KEY
  ].some((key) => key !== reasonKey && !!tile[key]);
  if (otherBlockActive) {
    if (tile.eventMode !== 'none') {
      try { tile.eventMode = 'none'; } catch (error) {
        Logger.error('LayerManager.tileEventMode.clearReblock.failed', {
          tileId: getTileId(tile),
          reasonKey,
          error: String(error?.message || error)
        });
        throw error;
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(tile, TILE_EVENT_MODE_BASE_KEY)) {
    const baseEventMode = tile[TILE_EVENT_MODE_BASE_KEY];
    try { tile.eventMode = baseEventMode; } catch (error) {
      Logger.error('LayerManager.tileEventMode.restore.failed', {
        tileId: getTileId(tile),
        reasonKey,
        eventMode: baseEventMode,
        error: String(error?.message || error)
      });
      throw error;
    }
    try { delete tile[TILE_EVENT_MODE_BASE_KEY]; } catch (error) {
      Logger.error('LayerManager.tileEventMode.baseDelete.failed', {
        tileId: getTileId(tile),
        reasonKey,
        error: String(error?.message || error)
      });
      throw error;
    }
  }
  if (reasonKey) {
    try { delete tile[reasonKey]; } catch (error) {
      Logger.error('LayerManager.tileEventMode.clearMarkerDelete.failed', {
        tileId: getTileId(tile),
        reasonKey,
        error: String(error?.message || error)
      });
      throw error;
    }
  }
}

export function refreshTileInteractionState() {
  const tiles = globalThis.canvas?.tiles;
  if (!globalThis.canvas?.ready || !tiles?.setAllRenderFlags) return;
  try {
    tiles.setAllRenderFlags({ refreshState: true });
  } catch (error) {
    Logger.error('LayerManager.selectionFilter.renderFlags.failed', {
      error: String(error?.message || error)
    });
    throw error;
  }
}

export function getMouseInteractionManager() {
  return globalThis?.foundry?.canvas?.interaction?.MouseInteractionManager || globalThis?.MouseInteractionManager || null;
}

const bulkTileSelectionState = {
  depth: 0,
  pendingMouseRefresh: false
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

export function withBulkTileSelectionBatch(operation) {
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

export function clearSelectionFilterInteractivityBlock(tile) {
  if (!tile) return;
  if (typeof tile.interactiveChildren !== 'undefined') {
    try { tile.interactiveChildren = true; } catch (error) {
      Logger.error('LayerManager.selectionFilter.interactiveChildrenRestore.failed', {
        tileId: getTileId(tile),
        error: String(error?.message || error)
      });
      throw error;
    }
  }
  clearTileEventModeBlocked(tile, TILE_EVENT_MODE_SELECTION_BLOCK_KEY);
  try {
    tile[SELECTION_FILTER_BLOCK_KEY] = false;
  } catch (error) {
    Logger.error('LayerManager.selectionFilter.blockMarkerClear.failed', {
      tileId: getTileId(tile),
      error: String(error?.message || error)
    });
    throw error;
  }
}

export function getTileSelectionInteractionState(tile) {
  const manager = tile?.mouseInteractionManager || null;
  const managerState = Number(manager?.state ?? 0) || 0;
  const grabbedState = Number(manager?.states?.GRABBED ?? 3) || 3;
  const currentManagerObject = globalThis.canvas?.currentMouseManager?.object || null;
  const currentManagerTile = currentManagerObject?._original || currentManagerObject;
  const currentManagerTileId = getTileId(currentManagerTile);
  const tileId = getTileId(tile);
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

export function shouldProtectTileSelectionInteraction(tile, interaction = null) {
  const state = interaction || getTileSelectionInteractionState(tile);
  return !!(state.controlled || state.dragging || state.managerState >= state.grabbedState || state.currentManagerOwnsTile);
}

export function shouldProtectTileSelectionRelease(tile, interaction = null, { selectionActive = false, filterActive = false } = {}) {
  const state = interaction || getTileSelectionInteractionState(tile);
  if (state.dragging || state.managerState >= state.grabbedState || state.currentManagerOwnsTile) return true;
  if (!state.controlled) return false;
  if (!filterActive) return true;
  if (selectionActive && (!state.visible || !state.renderable || state.hovered)) return true;
  return false;
}

export function canLayerManagerSelectLockedTile(tile, {
  selectionActive = requireAdapter('selectionSessionActive')(),
  filterActive = requireAdapter('selectionFilterActive')()
} = {}) {
  const selectionFilterState = getSelectionFilterState();
  if (!selectionFilterState.active || selectionFilterState.skipLocked) return false;
  if (!requireAdapter('isTilesLayerActive')()) return false;
  if (!tile?.document?.locked) return false;
  if (requireAdapter('isTileBeingEdited')(tile)) return false;
  if (requireAdapter('isLayerHidden')(tile.document)) return false;
  return requireAdapter('canSelectPlaceable')(tile, { selectionActive, filterActive });
}

export function applyLockedTileSelectionInteractivity(tile, {
  selectionActive = requireAdapter('selectionSessionActive')(),
  filterActive = requireAdapter('selectionFilterActive')(),
  source = 'unknown'
} = {}) {
  if (!canLayerManagerSelectLockedTile(tile, { selectionActive, filterActive })) return false;
  let changed = false;
  try {
    if (tile.eventMode !== 'static') {
      tile.eventMode = 'static';
      changed = true;
    }
  } catch (error) {
    Logger.error('LayerManager.lockedTileSelection.eventModeFailed', {
      source,
      tileId: getTileId(tile),
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
        tileId: getTileId(tile),
        error: String(error?.message || error)
      });
      throw error;
    }
  }
  if (changed) {
    const selectionFilterState = getSelectionFilterState();
    Logger.trace('layerSelectionFilter', 'LayerManager.lockedTileSelection.interactivityEnabled', {
      source,
      tileId: getTileId(tile),
      eventMode: tile?.eventMode ?? null,
      skipLocked: selectionFilterState.skipLocked
    });
  }
  return true;
}

export function pruneSelectionForFilter() {
  const selection = Array.isArray(globalThis.canvas?.tiles?.controlled) ? globalThis.canvas.tiles.controlled : [];
  if (!selection.length) return;
  const selectionActive = requireAdapter('selectionSessionActive')();
  const filterActive = requireAdapter('selectionFilterActive')();
  const canSelectPlaceable = requireAdapter('canSelectPlaceable');
  let released = 0;
  withBulkTileSelectionBatch(() => {
    for (const tile of selection) {
      if (canSelectPlaceable(tile, { selectionActive, filterActive })) continue;
      const interaction = getTileSelectionInteractionState(tile);
      const protectRelease = shouldProtectTileSelectionRelease(tile, interaction, { selectionActive, filterActive });
      if (protectRelease) {
        Logger.trace('layerSelectionFilter', 'LayerManager.selectionFilter.skipProtectedTileRelease', {
          tileId: interaction.tileId,
          controlled: interaction.controlled,
          hovered: interaction.hovered,
          visible: interaction.visible,
          renderable: interaction.renderable,
          dragging: interaction.dragging,
          managerState: interaction.managerState,
          selectionActive,
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
  if (released) requireAdapter('renderTileSelectionSidebar')();
}

export function applySelectionFilterInteractivity(tile, { selectionActive = false, filterActive = false } = {}) {
  if (!tile) return;
  const blocked = !requireAdapter('canSelectPlaceable')(tile, { selectionActive, filterActive });
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
        selectionActive,
        filterActive
      });
    }
    return;
  }
  tile[SELECTION_FILTER_BLOCK_KEY] = true;
  if (typeof tile.interactiveChildren !== 'undefined') {
    try { tile.interactiveChildren = false; } catch (error) {
      Logger.error('LayerManager.selectionFilter.interactiveChildrenBlock.failed', {
        tileId: getTileId(tile),
        error: String(error?.message || error)
      });
      throw error;
    }
  }
  if (tile.eventMode !== 'none' || !tile[TILE_EVENT_MODE_SELECTION_BLOCK_KEY]) {
    markTileEventModeBlocked(tile, TILE_EVENT_MODE_SELECTION_BLOCK_KEY);
    try {
      getMouseInteractionManager()?.emulateMoveEvent?.();
    } catch (error) {
      Logger.error('LayerManager.selectionFilter.mouseRefresh.failed', {
        tileId: getTileId(tile),
        error: String(error?.message || error)
      });
      throw error;
    }
  }
}

export function requestTileRefresh(tile) {
  try {
    tile?.renderFlags?.set?.({ refreshState: true });
  } catch (error) {
    Logger.error('LayerManager.tileRefresh.failed', {
      tileId: getTileId(tile),
      error: String(error?.message || error)
    });
    throw error;
  }
}

export function ensureTileReleaseAllPatch() {
  const TilesLayer = globalThis?.foundry?.canvas?.layers?.TilesLayer || globalThis.canvas?.tiles?.constructor;
  if (!TilesLayer?.prototype?.releaseAll) return;
  if (TilesLayer.prototype._faNexusReleaseAllPatched) return;
  TilesLayer.prototype._faNexusReleaseAllPatched = true;
  const original = TilesLayer.prototype.releaseAll;
  TilesLayer.prototype._faNexusReleaseAllOriginal = original;

  TilesLayer.prototype.releaseAll = function (options = {}) {
    if (!requireAdapter('selectionSessionActive')()) return original.call(this, options);
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
      if (released && renderSidebar) requireAdapter('renderTileSelectionSidebar')();
      return released;
    });
  };
}

export function ensureTileReleasePatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || globalThis.canvas?.tiles?.constructor?.placeableClass
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

export function ensureTileControlReleaseOthersPatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || globalThis.canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?.control) return;
  if (Tile.prototype._faNexusControlReleaseOthersPatched) return;
  Tile.prototype._faNexusControlReleaseOthersPatched = true;
  const original = Tile.prototype.control;
  Tile.prototype._faNexusControlReleaseOthersOriginal = original;

  Tile.prototype.control = function (options = {}) {
    if (!requireAdapter('selectionSessionActive')()) return original.call(this, options);
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const controlOptions = canLayerManagerSelectLockedTile(this)
      ? { ...normalizedOptions, force: true }
      : normalizedOptions;
    if (controlOptions.force && !normalizedOptions.force) {
      Logger.trace('layerSelectionFilter', 'LayerManager.lockedTileSelection.forceControl', {
        tileId: getTileId(this),
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
            tileId: getTileId(object),
            targetTileId: getTileId(this),
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
      if (renderSidebar) requireAdapter('renderTileSelectionSidebar')();
      return controlledTarget;
    });
  };
}

export function ensureTileSelectionPatch() {
  const TilesLayer = globalThis?.foundry?.canvas?.layers?.TilesLayer || globalThis.canvas?.tiles?.constructor;
  if (!TilesLayer?.prototype?.selectObjects) return;
  if (TilesLayer.prototype._faNexusSelectObjectsPatched) return;
  TilesLayer.prototype._faNexusSelectObjectsPatched = true;
  const original = TilesLayer.prototype.selectObjects;
  TilesLayer.prototype._faNexusSelectObjectsOriginal = original;

  TilesLayer.prototype.selectObjects = function ({ x, y, width, height, releaseOptions = {}, controlOptions = {} } = {}, { releaseOthers = true } = {}) {
    const selectionActive = requireAdapter('selectionSessionActive')();
    const filterActive = requireAdapter('selectionFilterActive')();
    const canSelectPlaceable = requireAdapter('canSelectPlaceable');
    if (!selectionActive) return original.call(this, { x, y, width, height, releaseOptions, controlOptions }, { releaseOthers });
    return withBulkTileSelectionBatch(() => {
      if (!this.options.controllableObjects) return false;

      const oldSet = new Set(this.controlled);
      const newSet = new Set();
      const rectangle = new globalThis.PIXI.Rectangle(x, y, width, height);

      const placeables = this.placeables;
      for (const placeable of placeables) {
        if (!canSelectPlaceable(placeable, { selectionActive, filterActive })) continue;
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
      if (controlChanged) requireAdapter('renderTileSelectionSidebar')();
      return controlChanged;
    });
  };
}

export function ensureTileSelectAllPatch() {
  const TilesLayer = globalThis?.foundry?.canvas?.layers?.TilesLayer || globalThis.canvas?.tiles?.constructor;
  if (!TilesLayer?.prototype?._onSelectAllKey) return;
  if (TilesLayer.prototype._faNexusSelectAllPatched) return;
  TilesLayer.prototype._faNexusSelectAllPatched = true;
  const original = TilesLayer.prototype._onSelectAllKey;
  TilesLayer.prototype._faNexusSelectAllOriginal = original;

  TilesLayer.prototype._onSelectAllKey = function (event) {
    const selectionActive = requireAdapter('selectionSessionActive')();
    const filterActive = requireAdapter('selectionFilterActive')();
    const canSelectPlaceable = requireAdapter('canSelectPlaceable');
    if (!selectionActive) return original.call(this, event);
    return withBulkTileSelectionBatch(() => {
      if (!this.options.controllableObjects) return false;

      const oldSet = new Set(this.controlled);
      const newSet = new Set();
      const placeables = this.placeables;

      for (const placeable of placeables) {
        if (!canSelectPlaceable(placeable, { selectionActive, filterActive })) continue;
        newSet.add(placeable);
      }

      const toRelease = oldSet.difference(newSet);
      toRelease.forEach(placeable => placeable.release({ renderSidebar: false }));

      const toControl = newSet.difference(oldSet);
      const controlOptions = { releaseOthers: false, renderSidebar: false };
      toControl.forEach(placeable => placeable.control(controlOptions));

      if (toRelease.size || toControl.size) requireAdapter('renderTileSelectionSidebar')();
      return true;
    });
  };
}

export function ensureTileSelectionStatePatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || globalThis.canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?._refreshState) return;
  if (Tile.prototype._faNexusSelectionStatePatched) return;
  Tile.prototype._faNexusSelectionStatePatched = true;
  const original = Tile.prototype._refreshState;
  Tile.prototype._faNexusSelectionStateOriginal = original;

  Tile.prototype._refreshState = function (...args) {
    const result = original.apply(this, args);
    const selectionActive = requireAdapter('selectionSessionActive')();
    const edited = requireAdapter('isTileBeingEdited')(this);
    const needsSelectionCleanup = !!(
      this?.[SELECTION_FILTER_BLOCK_KEY]
      || this?.[TILE_EVENT_MODE_SELECTION_BLOCK_KEY]
    );
    const needsEditCleanup = !!this?.[TILE_EVENT_MODE_EDIT_BLOCK_KEY];
    if (!selectionActive && !edited && !needsSelectionCleanup && !needsEditCleanup) return result;

    const filterActive = (selectionActive || needsSelectionCleanup)
      ? requireAdapter('selectionFilterActive')()
      : false;
    try {
      if (edited) requireAdapter('forceHideEditedTile')(this);
      else if (needsEditCleanup) requireAdapter('restoreEditedTileFrame')(this);
      if (selectionActive || needsSelectionCleanup) {
        applySelectionFilterInteractivity(this, { selectionActive, filterActive });
      }
      if (selectionActive) {
        applyLockedTileSelectionInteractivity(this, { selectionActive, filterActive, source: 'refreshState' });
      }
    } catch (error) {
      Logger.error('LayerManager.tileRefreshState.postProcess.failed', {
        tileId: getTileId(this),
        selectionActive,
        filterActive,
        edited,
        needsSelectionCleanup,
        needsEditCleanup,
        error: String(error?.message || error)
      });
      throw error;
    }
    return result;
  };
}

export function ensureTileHoverSuppressionPatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || globalThis.canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?._onHoverIn) return;
  if (Tile.prototype._faNexusHoverSuppressionPatched) return;
  Tile.prototype._faNexusHoverSuppressionPatched = true;
  const original = Tile.prototype._onHoverIn;
  Tile.prototype._faNexusHoverSuppressionOriginal = original;

  Tile.prototype._onHoverIn = function (...args) {
    if (requireAdapter('shouldSuppressTileHover')()) return;
    return original.apply(this, args);
  };
}

export function ensureCanvasHighlightSuppressionPatch() {
  const Canvas = globalThis?.foundry?.canvas?.Canvas || globalThis.canvas?.constructor;
  if (!Canvas?.prototype?.highlightObjects) return;
  if (Canvas.prototype._faNexusHighlightSuppressionPatched) return;
  Canvas.prototype._faNexusHighlightSuppressionPatched = true;
  const original = Canvas.prototype.highlightObjects;
  Canvas.prototype._faNexusHighlightSuppressionOriginal = original;

  Canvas.prototype.highlightObjects = function (active) {
    if (active && requireAdapter('shouldSuppressTileHover')()) return;
    return original.call(this, active);
  };
}

export function ensureLayerSelectionInteractivityPatches() {
  ensureTileReleaseAllPatch();
  ensureTileReleasePatch();
  ensureTileControlReleaseOthersPatch();
  ensureTileSelectionPatch();
  ensureTileSelectAllPatch();
  ensureTileSelectionStatePatch();
  ensureTileHoverSuppressionPatch();
  ensureCanvasHighlightSuppressionPatch();
}

export function restoreLayerManagerTileInteractivity({ source = 'unknown' } = {}) {
  if (!globalThis.canvas?.ready || !globalThis.canvas?.tiles) return;
  const failures = [];
  let hoverCleared = 0;
  try {
    hoverCleared = requireAdapter('clearTileHover')({ source, updateLegend: false });
  } catch (error) {
    failures.push(error);
  }
  const selectionFilterState = getSelectionFilterState();
  let blocksCleared = 0;
  let lockedEventModesReset = 0;
  for (const tile of requireAdapter('collectTilePlaceables')()) {
    const hadSelectionBlock = !!(tile?.[SELECTION_FILTER_BLOCK_KEY] || tile?.[TILE_EVENT_MODE_SELECTION_BLOCK_KEY]);
    if (hadSelectionBlock) {
      try {
        clearSelectionFilterInteractivityBlock(tile);
        blocksCleared += 1;
      } catch (error) {
        failures.push(error);
      }
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
            tileId: getTileId(tile),
            expectedEventMode,
            error: String(error?.message || error)
          });
          failures.push(error);
        }
      }
    }
    try {
      requestTileRefresh(tile);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    refreshTileInteractionState();
  } catch (error) {
    failures.push(error);
  }
  try {
    getMouseInteractionManager()?.emulateMoveEvent?.();
  } catch (error) {
    failures.push(error);
  }
  if (hoverCleared || blocksCleared || lockedEventModesReset) {
    Logger.debug?.('LayerManager.selectionFilter.deactivateCleanup', {
      source,
      hoverCleared,
      blocksCleared,
      lockedEventModesReset
    });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `Layer Manager interactivity restoration failed during ${source}.`);
  }
}
