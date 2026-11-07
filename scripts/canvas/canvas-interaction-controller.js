import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { isKeyEventForTextEntry } from '../core/keyboard-text-entry.js';
import { isSessionExitQuestionOpen } from '../premium/session-host/cancel-session-dialog.js';
import { requestSelectionFilterRefresh } from './selection-filter-refresh.js';
import { normalizeGroundBandDocumentSort } from './elevation-band-utils.js';

const GRID_BASE_PX = 200;
const SORT_STEP = 2;
const ELEVATION_EPSILON = 1e-6;

const defaultTarget = typeof window !== 'undefined' ? window : globalThis;
const documentTarget = typeof document !== 'undefined' ? document : null;

const EVENT_CONFIG = {
  pointermove: { target: defaultTarget, options: { capture: true, passive: false } },
  pointerdown: { target: defaultTarget, options: { capture: true, passive: false } },
  pointerup: { target: defaultTarget, options: { capture: true, passive: false } },
  pointercancel: { target: defaultTarget, options: { capture: true, passive: false } },
  wheel: { target: documentTarget || defaultTarget, options: { capture: true, passive: false } },
  keydown: { target: defaultTarget, options: { capture: true } },
  keyup: { target: defaultTarget, options: { capture: true } },
  contextmenu: { target: defaultTarget, options: { capture: true } },
  mousemove: { target: defaultTarget, options: { passive: true } }
};

const POINTER_EVENT_TYPES = new Set(['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'wheel', 'mousemove']);

const ANNOUNCE_THROTTLE = new Map();
const NORMALIZED_SORT_LOGS = new Set();

function normalizeTileDocumentSortForPlacement(doc, {
  elevation = doc?.elevation,
  sort = doc?.sort,
  scene = canvas?.scene,
  source = 'placement-sort'
} = {}) {
  const result = normalizeGroundBandDocumentSort(elevation, sort, { scene });
  if (result.normalized) {
    const logKey = `${source}:${doc?.id || 'unknown'}:${result.originalSort}:${result.localSort}`;
    if (!NORMALIZED_SORT_LOGS.has(logKey)) {
      NORMALIZED_SORT_LOGS.add(logKey);
      Logger.warn('Placement.sort.groundBandDocumentSort.normalized', {
        source,
        tileId: doc?.id || null,
        elevation: Number(elevation ?? 0) || 0,
        originalSort: result.originalSort,
        normalizedSort: result.sort,
        groundBandLocalSort: result.localSort,
        encoding: result.encoding
      });
    }
  }
  return result;
}

function getCanvasElement() {
  try {
    if (typeof document === 'undefined') return null;
    const byId = document.getElementById('board');
    if (byId instanceof HTMLCanvasElement) return byId;
    const query = document.querySelector('canvas#board');
    if (query instanceof HTMLCanvasElement) return query;
  } catch (_) { /* no-op */ }
  try {
    const view = canvas?.app?.renderer?.view;
    if (view instanceof HTMLCanvasElement) return view;
  } catch (_) { /* no-op */ }
  return null;
}

function worldFromScreen(screenX, screenY) {
  try {
    const stage = canvas?.stage;
    if (!stage || typeof stage.worldTransform?.applyInverse !== 'function') return null;
    const board = getCanvasElement();
    if (!board) return null;
    const rect = board.getBoundingClientRect();
    const localX = screenX - rect.left;
    const localY = screenY - rect.top;
    const point = new PIXI.Point(localX, localY);
    const world = stage.worldTransform.applyInverse(point);
    return { x: world.x, y: world.y };
  } catch (_) {
    return null;
  }
}

function worldFromPointer(event) {
  if (!event) return null;
  const x = typeof event.clientX === 'number' ? event.clientX : null;
  const y = typeof event.clientY === 'number' ? event.clientY : null;
  if (x == null || y == null) return null;
  return worldFromScreen(x, y);
}

function computeNextSortAtElevation(elevation = 0, { scene = canvas?.scene } = {}) {
  try {
    const elev = Number(elevation || 0) || 0;
    let maxSort = 0;
    for (const { sort } of getSceneTileSortEntriesAtElevation(elev, scene)) {
      if (sort > maxSort) maxSort = sort;
    }
    return maxSort + SORT_STEP;
  } catch (_) {
    return 35;
  }
}

function computeLowestSortAtElevation(elevation = 0, { scene = canvas?.scene } = {}) {
  try {
    const elev = Number(elevation || 0) || 0;
    let minSort = Infinity;
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) {
      const doc = tile?.document;
      if (!doc) continue;
      if (!sameElevation(doc.elevation, elev)) continue;
      const sort = normalizeTileDocumentSortForPlacement(doc, {
        elevation: doc.elevation,
        sort: doc.sort,
        scene,
        source: 'computeLowestSortAtElevation'
      }).sort;
      if (sort < minSort) minSort = sort;
    }
    if (!Number.isFinite(minSort)) return -SORT_STEP;
    return minSort - SORT_STEP;
  } catch (_) {
    return -SORT_STEP;
  }
}

function sameElevation(left, right) {
  const leftValue = Number(left);
  const rightValue = Number(right);
  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return false;
  return Math.abs(leftValue - rightValue) <= ELEVATION_EPSILON;
}

function resolvePlacementTileDocument(anchorTile = null, anchorTileId = null, scene = canvas?.scene) {
  const directDoc = anchorTile?.document || anchorTile;
  if (directDoc?.id) return directDoc;
  const resolvedId = String(anchorTileId || '').trim();
  if (!resolvedId) return null;
  try {
    const doc = scene?.tiles?.get?.(resolvedId);
    if (doc) return doc;
  } catch (_) { /* no-op */ }
  try {
    const placeable = canvas?.tiles?.placeables?.find((tile) => tile?.document?.id === resolvedId);
    if (placeable?.document) return placeable.document;
  } catch (_) { /* no-op */ }
  return null;
}

function getSceneTileSortEntriesAtElevation(elevation = 0, scene = canvas?.scene, excludeTileIds = []) {
  const targetElevation = Number(elevation || 0) || 0;
  const excludedIds = new Set((Array.isArray(excludeTileIds) ? excludeTileIds : [excludeTileIds])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  const docs = [];
  try {
    const collection = scene?.tiles;
    if (collection?.contents && Array.isArray(collection.contents)) {
      docs.push(...collection.contents);
    } else if (collection && typeof collection[Symbol.iterator] === 'function') {
      docs.push(...Array.from(collection));
    } else {
      const placeables = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
      for (const tile of placeables) {
        if (tile?.document) docs.push(tile.document);
      }
    }
  } catch (_) {
    const placeables = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of placeables) {
      if (tile?.document) docs.push(tile.document);
    }
  }
  return docs
    .filter((doc) => sameElevation(doc?.elevation, targetElevation) && !excludedIds.has(String(doc?.id || '').trim()))
    .map((doc) => {
      const rawSort = Number(doc?.sort || 0) || 0;
      const normalized = normalizeTileDocumentSortForPlacement(doc, {
        elevation: doc?.elevation,
        sort: rawSort,
        scene,
        source: 'resolvePlacementSortAtElevation'
      });
      return {
        id: String(doc?.id || ''),
        sort: Number(normalized.sort || 0) || 0,
        rawSort,
        document: doc
      };
    })
    .filter((entry) => !!entry.id);
}

function sortTileSortEntries(left, right) {
  const leftSort = Number(left?.sort || 0) || 0;
  const rightSort = Number(right?.sort || 0) || 0;
  if (leftSort === rightSort) return String(left?.id || '').localeCompare(String(right?.id || ''));
  return leftSort - rightSort;
}

function resolveAdjacentPlacementSortAnchor(elevation = 0, {
  anchorTileId = null,
  sortBefore = false,
  direction = 0,
  currentSort = null,
  currentTileId = null,
  excludeTileIds = [],
  scene = canvas?.scene
} = {}) {
  const normalizedDirection = Math.sign(Number(direction) || 0);
  if (!normalizedDirection) return null;
  const entries = getSceneTileSortEntriesAtElevation(elevation, scene, excludeTileIds)
    .sort(sortTileSortEntries);
  if (!entries.length) return null;

  const normalizedAnchorId = String(anchorTileId || '').trim();
  const anchorIndex = entries.findIndex((entry) => entry.id === normalizedAnchorId);
  const hasCurrentSort = currentSort !== null
    && currentSort !== undefined
    && Number.isFinite(Number(currentSort));
  let insertionIndex = -1;
  if (anchorIndex >= 0) {
    insertionIndex = anchorIndex + (sortBefore === true ? 0 : 1);
  } else if (hasCurrentSort) {
    const normalizedCurrentSort = Number(currentSort);
    const normalizedCurrentId = String(currentTileId || '').trim();
    insertionIndex = entries.findIndex((entry) => (
      entry.sort > normalizedCurrentSort
      || (entry.sort === normalizedCurrentSort && entry.id.localeCompare(normalizedCurrentId) > 0)
    ));
    if (insertionIndex < 0) insertionIndex = entries.length;
  } else {
    insertionIndex = entries.length;
  }

  const nextInsertionIndex = Math.max(0, Math.min(entries.length, insertionIndex + normalizedDirection));
  if (nextInsertionIndex === insertionIndex) return null;
  if (nextInsertionIndex === 0) {
    return {
      anchorTileId: entries[0].id,
      sortBefore: true,
      insertionIndex: nextInsertionIndex
    };
  }
  return {
    anchorTileId: entries[nextInsertionIndex - 1].id,
    sortBefore: false,
    insertionIndex: nextInsertionIndex
  };
}

function resolveCurrentOrderPlacementSorts({
  previousSort = null,
  nextSort = null,
  placementCount = 1
} = {}) {
  const count = Math.max(1, Math.floor(Number(placementCount) || 1));
  const hasPrevious = Number.isFinite(previousSort);
  const hasNext = Number.isFinite(nextSort);
  if (hasPrevious && hasNext && nextSort > previousSort) {
    const step = (nextSort - previousSort) / (count + 1);
    return Array.from({ length: count }, (_, index) => previousSort + (step * (index + 1)));
  }
  if (hasPrevious && !hasNext) {
    return Array.from({ length: count }, (_, index) => previousSort + (SORT_STEP * (index + 1)));
  }
  if (!hasPrevious && hasNext) {
    return Array.from({ length: count }, (_, index) => nextSort - (SORT_STEP * (count - index)));
  }
  if (hasPrevious && hasNext) {
    return Array.from({ length: count }, (_, index) => previousSort + ((index + 1) / (count + 1)));
  }
  return Array.from({ length: count }, (_, index) => SORT_STEP * (index + 1));
}

function resolveCompactPlacementSorts(siblingEntries = [], anchorEntry = null, placementCount = 1, sortBefore = false) {
  const entries = Array.isArray(siblingEntries)
    ? siblingEntries.map((entry) => ({ ...entry })).sort(sortTileSortEntries)
    : [];
  const anchorIndex = entries.findIndex((entry) => entry?.id === anchorEntry?.id);
  if (anchorIndex < 0) return null;
  const insertionIndex = anchorIndex + (sortBefore === true ? 0 : 1);
  const syntheticEntries = Array.from({ length: placementCount }, (_, index) => ({
    id: `fa-nexus-placement-${Date.now()}-${index}`,
    sort: null
  }));
  const previousSort = insertionIndex > 0 ? Number(entries[insertionIndex - 1]?.sort) : null;
  const nextSort = insertionIndex < entries.length ? Number(entries[insertionIndex]?.sort) : null;
  const hasPrevious = Number.isFinite(previousSort);
  const hasNext = Number.isFinite(nextSort);
  const previewSorts = resolveCurrentOrderPlacementSorts({
    previousSort,
    nextSort,
    placementCount
  });
  let startSort = null;
  let placementStep = SORT_STEP;
  let suffixShift = 0;

  if (hasPrevious && !hasNext) {
    startSort = previousSort + SORT_STEP;
  } else if (!hasPrevious && hasNext) {
    startSort = nextSort - (placementCount * SORT_STEP);
  } else if (!hasPrevious && !hasNext) {
    startSort = SORT_STEP;
  } else {
    const gap = nextSort - previousSort;
    const spacedGap = (placementCount + 1) * SORT_STEP;
    if (gap >= spacedGap) {
      startSort = previousSort + SORT_STEP;
    } else {
      placementStep = 1;
      startSort = previousSort + 1;
      if (gap <= placementCount) {
        const lastPlacementSort = startSort + (placementCount - 1);
        suffixShift = (lastPlacementSort - nextSort) + 1;
      }
    }
  }

  if (Number.isFinite(startSort)) {
    for (let index = 0; index < syntheticEntries.length; index += 1) {
      syntheticEntries[index].sort = startSort + (index * placementStep);
    }
    if (suffixShift > 0) {
      for (let index = insertionIndex; index < entries.length; index += 1) {
        entries[index].sort = Number(entries[index].sort) + suffixShift;
      }
    }
    const orderedEntries = entries.slice();
    orderedEntries.splice(insertionIndex, 0, ...syntheticEntries);
    return { orderedEntries, syntheticEntries, previewSorts, reindexed: suffixShift > 0 };
  }
  return null;
}

function resolvePlacementSortAtElevation(elevation = 0, {
  anchorTileId = null,
  anchorTile = null,
  scene = canvas?.scene,
  count = 1,
  sortBefore = false,
  excludeTileIds = []
} = {}) {
  const targetElevation = Number(elevation);
  const normalizedElevation = Number.isFinite(targetElevation) ? targetElevation : 0;
  const placementCount = Math.max(1, Math.floor(Number(count) || 1));
  const fallback = ({ reason = 'top-of-elevation' } = {}) => {
    const startSort = computeNextSortAtElevation(normalizedElevation, { scene });
    const baseSort = Number.isFinite(startSort) ? startSort : 35;
    const placementSorts = Array.from({ length: placementCount }, (_, index) => baseSort + (index * SORT_STEP));
    Logger.debug('CanvasInteractionController.sort.resolve.topOfElevation', {
      elevation: normalizedElevation,
      reason,
      anchorTileId: String(anchorTileId || '').trim() || null,
      sortBefore: sortBefore === true,
      placementCount,
      placementSorts
    });
    return {
      sort: placementSorts[0] ?? baseSort,
      placementSorts,
      previewSort: placementSorts[0] ?? baseSort,
      previewSorts: placementSorts.slice(),
      strategy: 'top-of-elevation',
      anchorTileId: String(anchorTileId || '').trim() || null,
      anchorTileSort: null,
      siblingUpdates: []
    };
  };

  const anchorDoc = resolvePlacementTileDocument(anchorTile, anchorTileId, scene);
  if (!anchorDoc?.id) return fallback({ reason: 'missing-anchor' });
  const anchorElevation = Number(anchorDoc.elevation);
  if (!Number.isFinite(anchorElevation) || !sameElevation(anchorElevation, normalizedElevation)) {
    return fallback({ reason: 'anchor-elevation-mismatch' });
  }

  try {
    const siblingEntries = getSceneTileSortEntriesAtElevation(normalizedElevation, scene, excludeTileIds);
    const anchorEntry = siblingEntries.find((entry) => entry.id === anchorDoc.id) || null;
    if (!anchorEntry) return fallback({ reason: 'anchor-not-in-scene' });
    const originalSorts = new Map(siblingEntries.map((entry) => [entry.id, entry.rawSort]));
    const resolved = resolveCompactPlacementSorts(siblingEntries, anchorEntry, placementCount, sortBefore);
    if (!resolved) return fallback({ reason: 'compact-sort-resolution-failed' });
    const { orderedEntries, syntheticEntries, previewSorts, reindexed } = resolved;
    const placementSorts = syntheticEntries.map((entry) => Number(entry?.sort || 0) || 0);
    const resolvedPreviewSorts = Array.isArray(previewSorts) && previewSorts.length
      ? previewSorts.map((sort) => Number(sort)).filter((sort) => Number.isFinite(sort))
      : placementSorts.slice();

    const siblingUpdates = [];
    for (const entry of orderedEntries) {
      if (!originalSorts.has(entry.id)) continue;
      const previousSort = originalSorts.get(entry.id);
      const nextSort = Number(entry.sort || 0) || 0;
      if (nextSort === previousSort) continue;
      siblingUpdates.push({ _id: entry.id, sort: nextSort });
    }

    const strategy = reindexed || siblingUpdates.length ? 'after-anchor-reindex' : 'after-anchor';
    Logger.debug('CanvasInteractionController.sort.resolve.afterAnchor', {
      elevation: normalizedElevation,
      anchorTileId: anchorDoc.id,
      anchorTileSort: anchorEntry.sort,
      sortBefore: sortBefore === true,
      placementCount,
      placementSorts,
      previewSorts: resolvedPreviewSorts,
      siblingUpdates: siblingUpdates.length,
      strategy
    });
    return {
      sort: placementSorts[0] ?? anchorEntry.sort,
      placementSorts,
      previewSort: resolvedPreviewSorts[0] ?? placementSorts[0] ?? anchorEntry.sort,
      previewSorts: resolvedPreviewSorts,
      strategy,
      anchorTileId: anchorDoc.id,
      anchorTileSort: anchorEntry.sort,
      siblingUpdates
    };
  } catch (error) {
    Logger.error('CanvasInteractionController.sort.resolve.failed', {
      elevation: normalizedElevation,
      anchorTileId: anchorDoc?.id || null,
      placementCount,
      error: String(error?.message || error)
    });
    return fallback({ reason: 'sort-resolution-failed' });
  }
}

function announceChange(type, message, { throttleMs = 600, level = 'info' } = {}) {
  try {
    if (!message) return;
    // Only text can be announced. A caller that reports an event with a data record instead (the
    // Path editor does when a path ends) would otherwise show the user "[object Object]".
    if (typeof message !== 'string') {
      Logger.warn('CanvasInteractionController.announce.nonText', { type, level, received: typeof message });
      return;
    }
    const key = `${type}:${level}`;
    const now = Date.now();
    const last = ANNOUNCE_THROTTLE.get(key) || 0;
    if (now - last < throttleMs) return;
    ANNOUNCE_THROTTLE.set(key, now);
    const notifier = ui?.notifications?.[level];
    if (typeof notifier === 'function') notifier.call(ui.notifications, message);
  } catch (_) { /* no-op */ }
}

function getSceneGridSize() {
  try { return Number(canvas?.scene?.grid?.size || 100) || 100; }
  catch (_) { return 100; }
}

function getGridScaleFactor(basePx = GRID_BASE_PX) {
  const sceneSize = getSceneGridSize();
  const base = Number(basePx || GRID_BASE_PX) || GRID_BASE_PX;
  return sceneSize / base;
}

function isTilesLayer(layer) {
  try {
    return !!layer && layer === canvas?.tiles;
  } catch (_) {
    return false;
  }
}

function requestTileInteractionRefresh(reason = 'unknown') {
  const refresh = () => {
    try {
      const layer = canvas?.tiles;
      if (!canvas?.ready || !layer) return;
      if (typeof layer.setAllRenderFlags === 'function') {
        layer.setAllRenderFlags({ refreshState: true });
      } else {
        const placeables = Array.isArray(layer.placeables) ? layer.placeables : [];
        for (const tile of placeables) {
          try { tile?.renderFlags?.set?.({ refreshState: true }); } catch (_) {}
        }
      }
      const mouseManager = globalThis?.foundry?.canvas?.interaction?.MouseInteractionManager || globalThis?.MouseInteractionManager;
      try { mouseManager?.emulateMoveEvent?.(); } catch (_) {}
      Logger.debug('CanvasInteractionController.tiles.refreshState', { reason });
    } catch (error) {
      Logger.error('CanvasInteractionController.tiles.refreshState.failed', error);
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

function lockLayerInteractivity(layerName = 'tiles') {
  try {
    const canvasRef = canvas || null;
    if (!canvasRef) return null;
    const requested = String(layerName ?? '').trim();
    if (!requested) return null;
    const key = (requested in canvasRef) ? requested : requested.toLowerCase();
    const layer = canvasRef[key];
    if (!layer) return null;
    try { layer.activate?.(); } catch (error) {
      Logger.error('CanvasInteractionController.layerLock.activate.failed', {
        layer: key,
        error: String(error?.message || error)
      });
    }
    const state = {
      interactiveChildren: ('interactiveChildren' in layer) ? layer.interactiveChildren : undefined,
      eventMode: ('eventMode' in layer) ? layer.eventMode : undefined,
      placeables: []
    };
    let list = [];
    try {
      list = Array.isArray(layer.placeables) ? layer.placeables : [];
    } catch (error) {
      Logger.error('CanvasInteractionController.layerLock.placeables.lookupFailed', {
        layer: key,
        error: String(error?.message || error)
      });
    }
    for (const obj of list) {
      try {
        state.placeables.push({
          obj,
          interactive: ('interactive' in obj) ? obj.interactive : undefined,
          eventMode: ('eventMode' in obj) ? obj.eventMode : undefined
        });
        if ('eventMode' in obj) obj.eventMode = 'none';
        if ('interactive' in obj) obj.interactive = false;
      } catch (error) {
        Logger.error('CanvasInteractionController.layerLock.placeable.blockFailed', {
          layer: key,
          id: obj?.document?.id || obj?.id || null,
          error: String(error?.message || error)
        });
      }
    }
    if ('interactiveChildren' in layer && state.interactiveChildren !== undefined) {
      try {
        layer.interactiveChildren = false;
      } catch (error) {
        Logger.error('CanvasInteractionController.layerLock.layerChildren.blockFailed', {
          layer: key,
          error: String(error?.message || error)
        });
      }
    }
    if ('eventMode' in layer && state.eventMode !== undefined) {
      try {
        layer.eventMode = 'passive';
      } catch (error) {
        Logger.error('CanvasInteractionController.layerLock.layerMode.blockFailed', {
          layer: key,
          error: String(error?.message || error)
        });
      }
    }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        try {
          if (layer && 'interactiveChildren' in layer && state.interactiveChildren !== undefined) {
            try {
              layer.interactiveChildren = state.interactiveChildren;
            } catch (error) {
              Logger.error('CanvasInteractionController.layerLock.release.restoreLayerChildren.failed', {
                layer: key,
                error: String(error?.message || error)
              });
            }
          }
          if (layer && 'eventMode' in layer && state.eventMode !== undefined) {
            try {
              layer.eventMode = state.eventMode;
            } catch (error) {
              Logger.error('CanvasInteractionController.layerLock.release.restoreLayerMode.failed', {
                layer: key,
                error: String(error?.message || error)
              });
            }
          }
          for (const saved of state.placeables || []) {
            const obj = saved?.obj;
            if (!obj) continue;
            try {
              if (saved.eventMode !== undefined && 'eventMode' in obj) obj.eventMode = saved.eventMode;
              if (saved.interactive !== undefined && 'interactive' in obj) obj.interactive = saved.interactive;
            } catch (error) {
              Logger.error('CanvasInteractionController.layerLock.release.restorePlaceable.failed', {
                layer: key,
                id: obj?.document?.id || obj?.id || null,
                error: String(error?.message || error)
              });
            }
          }
        } catch (_) { /* no-op */ }
        if (isTilesLayer(layer)) {
          requestTileInteractionRefresh('layer-lock-release');
          requestSelectionFilterRefresh({
            reason: 'layer-lock-release',
            source: 'canvas-interaction-controller'
          });
        }
      }
    };
  } catch (error) {
    Logger.error('CanvasInteractionController.layerLock.acquire.failed', {
      layer: String(layerName ?? ''),
      error: String(error?.message || error)
    });
    return null;
  }
}

function lockTileInteractivity() {
  return lockLayerInteractivity('tiles');
}

function getPlaceableLayers(canvasRef) {
  let layers = [];
  try {
    layers = Array.isArray(canvasRef?.layers) ? canvasRef.layers : [];
  } catch (error) {
    Logger.error('CanvasInteractionController.placeableLock.layers.lookupFailed', {
      error: String(error?.message || error)
    });
    return [];
  }
  const PlaceablesLayer = globalThis?.foundry?.canvas?.layers?.PlaceablesLayer;
  // V14's TemplateLayer is a compatibility facade over Regions. Reading its
  // placeables accesses deprecated Scene.templates and locks the same objects twice.
  layers = layers.filter(layer => layer?.constructor?.documentName !== 'MeasuredTemplate');
  if (typeof PlaceablesLayer === 'function') {
    return layers.filter((layer) => layer instanceof PlaceablesLayer);
  }
  return layers.filter((layer) => Array.isArray(layer?.placeables) && 'hover' in layer);
}

function clearPlaceableHover(layer) {
  const hovered = layer?.hover;
  if (!hovered) return;
  try {
    hovered._onHoverOut?.({ buttons: 0 });
  } catch (error) {
    Logger.error('CanvasInteractionController.placeableLock.hover.clearFailed', {
      layer: layer?.name || layer?.constructor?.name || 'unknown',
      id: hovered?.document?.id || hovered?.id || null,
      error: String(error?.message || error)
    });
  }
}

function lockPlaceableInteractivity() {
  try {
    const canvasRef = canvas || null;
    if (!canvasRef) return null;
    const layers = getPlaceableLayers(canvasRef);
    const states = [];

    try { globalThis?.game?.keyboard?.releaseKeys?.({ force: true }); }
    catch (error) {
      Logger.error('CanvasInteractionController.placeableLock.keyboard.releaseFailed', {
        error: String(error?.message || error)
      });
    }
    try { canvasRef.highlightObjects?.(false); }
    catch (error) {
      Logger.error('CanvasInteractionController.placeableLock.highlight.clearFailed', {
        error: String(error?.message || error)
      });
    }

    for (const layer of layers) {
      const state = {
        layer,
        active: (typeof layer?.active === 'boolean') ? layer.active : undefined,
        interactiveChildren: ('interactiveChildren' in layer) ? layer.interactiveChildren : undefined,
        eventMode: ('eventMode' in layer) ? layer.eventMode : undefined,
        placeables: []
      };
      clearPlaceableHover(layer);
      let placeables = [];
      try {
        placeables = Array.isArray(layer.placeables) ? layer.placeables : [];
      } catch (error) {
        Logger.error('CanvasInteractionController.placeableLock.placeables.lookupFailed', {
          layer: layer?.name || layer?.constructor?.name || 'unknown',
          error: String(error?.message || error)
        });
      }
      for (const obj of placeables) {
        try {
          state.placeables.push({
            obj,
            interactive: ('interactive' in obj) ? obj.interactive : undefined,
            eventMode: ('eventMode' in obj) ? obj.eventMode : undefined
          });
          if ('eventMode' in obj) obj.eventMode = 'none';
          if ('interactive' in obj) obj.interactive = false;
        } catch (error) {
          Logger.error('CanvasInteractionController.placeableLock.placeable.blockFailed', {
            layer: layer?.name || layer?.constructor?.name || 'unknown',
            id: obj?.document?.id || obj?.id || null,
            error: String(error?.message || error)
          });
        }
      }
      try {
        if (state.interactiveChildren !== undefined) layer.interactiveChildren = false;
        if (state.eventMode !== undefined) layer.eventMode = 'passive';
      } catch (error) {
        Logger.error('CanvasInteractionController.placeableLock.layer.blockFailed', {
          layer: layer?.name || layer?.constructor?.name || 'unknown',
          error: String(error?.message || error)
        });
      }
      states.push(state);
    }

    const statesByLayer = new Map(states.map((state) => [state.layer, state]));
    const hookRegistrations = [];
    let released = false;

    const suppressPlaceable = (obj, layer) => {
      if (released || !obj || !statesByLayer.has(layer)) return;
      try {
        if ('eventMode' in obj) obj.eventMode = 'none';
        if ('interactive' in obj) obj.interactive = false;
      } catch (error) {
        Logger.error('CanvasInteractionController.placeableLock.placeable.relockFailed', {
          layer: layer?.name || layer?.constructor?.name || 'unknown',
          id: obj?.document?.id || obj?.id || null,
          error: String(error?.message || error)
        });
      }
    };

    const suppressLayer = (layer) => {
      if (released || !statesByLayer.has(layer)) return;
      clearPlaceableHover(layer);
      let placeables = [];
      try { placeables = Array.isArray(layer.placeables) ? layer.placeables : []; }
      catch (error) {
        Logger.error('CanvasInteractionController.placeableLock.layer.relockLookupFailed', {
          layer: layer?.name || layer?.constructor?.name || 'unknown',
          error: String(error?.message || error)
        });
      }
      for (const obj of placeables) suppressPlaceable(obj, layer);
      try {
        if ('interactiveChildren' in layer) layer.interactiveChildren = false;
        if ('eventMode' in layer) layer.eventMode = 'passive';
      } catch (error) {
        Logger.error('CanvasInteractionController.placeableLock.layer.relockFailed', {
          layer: layer?.name || layer?.constructor?.name || 'unknown',
          error: String(error?.message || error)
        });
      }
    };

    const captureAndSuppressLayerLifecycle = (layer) => {
      if (released) return;
      const state = statesByLayer.get(layer);
      if (!state) return;
      try {
        if (typeof layer?.active === 'boolean') state.active = layer.active;
        if ('interactiveChildren' in layer) state.interactiveChildren = layer.interactiveChildren;
        if ('eventMode' in layer) state.eventMode = layer.eventMode;
      } catch (error) {
        Logger.error('CanvasInteractionController.placeableLock.layer.lifecycleCaptureFailed', {
          layer: layer?.name || layer?.constructor?.name || 'unknown',
          error: String(error?.message || error)
        });
      }
      suppressLayer(layer);
    };

    const hooksRef = globalThis?.Hooks;
    const registerHook = (name, listener) => {
      if (!hooksRef?.on || !hooksRef?.off) return;
      try {
        const id = hooksRef.on(name, listener);
        hookRegistrations.push({ name, id });
      } catch (error) {
        Logger.error('CanvasInteractionController.placeableLock.hook.registerFailed', {
          hook: name,
          error: String(error?.message || error)
        });
      }
    };

    registerHook('activateCanvasLayer', captureAndSuppressLayerLifecycle);
    const layerHookNames = new Set(states.map((state) => state.layer?.hookName).filter(Boolean));
    for (const hookName of layerHookNames) {
      // Foundry has a generic activation hook, but deactivation is emitted only
      // as deactivate<LayerHookName>. NotesLayer uses that tail to restore its
      // inactive display-toggle interactivity, so suppress after the exact hook.
      registerHook(`deactivate${hookName}`, captureAndSuppressLayerLifecycle);
    }
    const documentNames = new Set(states.map((state) => (
      state.layer?.constructor?.documentName
      || state.layer?.documentName
      || state.placeables[0]?.obj?.document?.documentName
      || null
    )).filter(Boolean));
    for (const documentName of documentNames) {
      const suppressRefreshedPlaceable = (obj) => suppressPlaceable(obj, obj?.layer);
      registerHook(`draw${documentName}`, (obj) => {
        suppressRefreshedPlaceable(obj);
        // Foundry calls draw<Type> immediately before activateListeners(). Re-lock
        // once that synchronous draw tail completes so a new placeable never
        // escapes during the active editor session.
        try { queueMicrotask(() => suppressRefreshedPlaceable(obj)); }
        catch (error) {
          Logger.error('CanvasInteractionController.placeableLock.drawRelock.scheduleFailed', {
            documentName,
            error: String(error?.message || error)
          });
        }
      });
      registerHook(`refresh${documentName}`, suppressRefreshedPlaceable);
    }

    return {
      release() {
        if (released) return;
        released = true;
        for (const { name, id } of hookRegistrations.splice(0)) {
          try { hooksRef?.off?.(name, id); }
          catch (error) {
            Logger.error('CanvasInteractionController.placeableLock.hook.releaseFailed', {
              hook: name,
              error: String(error?.message || error)
            });
          }
        }
        for (const state of states) {
          const layer = state.layer;
          if (!layer) continue;
          try {
            if (state.interactiveChildren !== undefined && 'interactiveChildren' in layer) {
              layer.interactiveChildren = state.interactiveChildren;
            }
            if (state.eventMode !== undefined && 'eventMode' in layer) {
              layer.eventMode = state.eventMode;
            }
            for (const saved of state.placeables) {
              const obj = saved.obj;
              if (!obj) continue;
              if (saved.eventMode !== undefined && 'eventMode' in obj) obj.eventMode = saved.eventMode;
              if (saved.interactive !== undefined && 'interactive' in obj) obj.interactive = saved.interactive;
            }
            const existingPlaceables = new Set(state.placeables.map(({ obj }) => obj));
            const currentPlaceables = Array.isArray(layer.placeables) ? layer.placeables : [];
            for (const obj of currentPlaceables) {
              if (!obj || existingPlaceables.has(obj)) continue;
              obj.activateListeners?.();
            }
            layer.setAllRenderFlags?.({ refreshState: true });
          } catch (error) {
            Logger.error('CanvasInteractionController.placeableLock.release.restoreFailed', {
              layer: layer?.name || layer?.constructor?.name || 'unknown',
              error: String(error?.message || error)
            });
          }
        }
        try {
          const mouseManager = globalThis?.foundry?.canvas?.interaction?.MouseInteractionManager
            || globalThis?.MouseInteractionManager;
          mouseManager?.emulateMoveEvent?.();
        } catch (error) {
          Logger.error('CanvasInteractionController.placeableLock.release.emulateMoveFailed', {
            error: String(error?.message || error)
          });
        }
        if (states.some(({ layer }) => isTilesLayer(layer))) {
          requestSelectionFilterRefresh({
            reason: 'placeable-lock-release',
            source: 'canvas-interaction-controller'
          });
        }
      }
    };
  } catch (error) {
    Logger.error('CanvasInteractionController.placeableLock.acquire.failed', {
      error: String(error?.message || error)
    });
    return null;
  }
}

class CanvasInteractionSession {
  constructor(controller, handlers = {}, options = {}) {
    this._controller = controller;
    this._handlers = {};
    this._eventTypes = new Set();
    this._stopped = false;
    this._options = Object.assign({
      lockTileInteractivity: false,
      lockCanvasLayer: null,
      lockPlaceableInteractivity: false,
      exclusiveInput: false,
      coalescePointerMove: false,
      onCanvasTearDown: null,
      onStop: null
    }, options);

    for (const [key, value] of Object.entries(handlers || {})) {
      if (typeof value !== 'function') continue;
      const type = key.toLowerCase();
      if (!EVENT_CONFIG[type]) continue;
      this._handlers[type] = value;
      this._eventTypes.add(type);
    }

    const requestedLayer = (typeof this._options.lockCanvasLayer === 'string')
      ? this._options.lockCanvasLayer.trim()
      : null;
    const layerName = requestedLayer || (this._options.lockTileInteractivity ? 'tiles' : null);
    this._layerLock = this._options.lockPlaceableInteractivity
      ? lockPlaceableInteractivity()
      : (layerName ? lockLayerInteractivity(layerName) : null);
  }

  get eventTypes() {
    return this._eventTypes;
  }

  get exclusiveInput() {
    return this._options.exclusiveInput === true;
  }

  get coalescePointerMove() {
    return this._options.coalescePointerMove === true;
  }

  dispatch(type, event, context) {
    if (this._stopped) return false;
    const handler = this._handlers[type];
    if (!handler) return false;
    try {
      return handler(event, context) === true;
    } catch (err) {
      Logger.error('CanvasInteractionSession.handler.failed', {
        type,
        error: err
      });
      return false;
    }
  }

  handleCanvasTearDown() {
    try {
      if (typeof this._options.onCanvasTearDown === 'function') {
        this._options.onCanvasTearDown();
      }
    } catch (error) {
      Logger.error('CanvasInteractionSession.canvasTearDown.failed', {
        error
      });
    }
    this.stop('canvas-teardown');
  }

  stop(reason = 'user') {
    if (this._stopped) return;
    this._stopped = true;
    try {
      if (this._layerLock) {
        this._layerLock.release?.();
      }
    } catch (error) {
      Logger.error('CanvasInteractionSession.layerLock.release.failed', {
        reason,
        error
      });
    }
    this._layerLock = null;
    this._controller._removeSession(this);
    try {
      if (typeof this._options.onStop === 'function') {
        this._options.onStop(reason);
      }
    } catch (error) {
      Logger.error('CanvasInteractionSession.onStop.failed', {
        reason,
        error
      });
    }
  }
}

class CanvasInteractionControllerImpl {
  constructor() {
    this._sessions = new Set();
    this._activeEvents = new Map();
    this._pointerState = {
      screen: null,
      world: null
    };
    this._coalescedPointerOwner = null;
    this._pendingPointerMove = null;
    this._pendingPointerMoveFrame = null;
    this._onCanvasTearDown = this._onCanvasTearDown.bind(this);
    try {
      const hooks = globalThis?.Hooks;
      hooks?.on?.('canvasTearDown', this._onCanvasTearDown);
    } catch (_) { /* no-op */ }
  }

  startSession(handlers = {}, options = {}) {
    const session = new CanvasInteractionSession(this, handlers, options);
    if (!session.eventTypes.size) {
      session.stop('no-handlers');
      return session;
    }
    this._sessions.add(session);
    this._refreshEventBindings();
    return session;
  }

  worldFromPointer(event) {
    return worldFromPointer(event);
  }

  worldFromScreen(screenX, screenY) {
    return worldFromScreen(screenX, screenY);
  }

  computeNextSortAtElevation(elevation, options) {
    return computeNextSortAtElevation(elevation, options);
  }

  computeLowestSortAtElevation(elevation, options) {
    return computeLowestSortAtElevation(elevation, options);
  }

  resolvePlacementSortAtElevation(elevation, options) {
    return resolvePlacementSortAtElevation(elevation, options);
  }

  resolveAdjacentPlacementSortAnchor(elevation, options) {
    return resolveAdjacentPlacementSortAnchor(elevation, options);
  }

  announceChange(type, message, options) {
    announceChange(type, message, options);
  }

  getGridScaleFactor(basePx = GRID_BASE_PX) {
    return getGridScaleFactor(basePx);
  }

  getPointerState() {
    const screen = this._pointerState.screen ? { ...this._pointerState.screen } : null;
    const world = this._pointerState.world ? { ...this._pointerState.world } : null;
    return { screen, world };
  }

  getCanvasElement() {
    return getCanvasElement();
  }

  _removeSession(session) {
    if (this._coalescedPointerOwner?.session === session) this._clearCoalescedPointerMove();
    this._sessions.delete(session);
    this._refreshEventBindings();
  }

  _onCanvasTearDown() {
    const list = Array.from(this._sessions);
    for (const session of list) {
      try { session.handleCanvasTearDown(); }
      catch (_) { /* no-op */ }
    }
    this._pointerState = { screen: null, world: null };
    this._clearCoalescedPointerMove();
  }

  _refreshEventBindings() {
    const needed = new Set();
    for (const session of this._sessions) {
      for (const type of session.eventTypes) needed.add(type);
    }

    for (const type of needed) {
      if (!this._activeEvents.has(type)) {
        this._bindEvent(type);
      }
    }

    for (const [type, binding] of Array.from(this._activeEvents.entries())) {
      if (!needed.has(type)) {
        this._unbindEvent(type, binding);
      }
    }
  }

  _bindEvent(type) {
    const config = EVENT_CONFIG[type];
    if (!config || !config.target || typeof config.target.addEventListener !== 'function') return;
    const listener = (event) => this._handleEvent(type, event);
    config.target.addEventListener(type, listener, config.options);
    this._activeEvents.set(type, { listener, target: config.target, options: config.options });
  }

  _unbindEvent(type, binding) {
    if (!binding?.target || typeof binding.target.removeEventListener !== 'function') return;
    binding.target.removeEventListener(type, binding.listener, binding.options);
    this._activeEvents.delete(type);
  }

  _clearCoalescedPointerMove() {
    if (this._pendingPointerMoveFrame != null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this._pendingPointerMoveFrame);
    }
    this._pendingPointerMoveFrame = null;
    this._pendingPointerMove = null;
    this._coalescedPointerOwner = null;
  }

  _matchesCoalescedPointer(event) {
    const owner = this._coalescedPointerOwner;
    if (!owner) return false;
    const eventPointerId = event?.pointerId == null ? null : Number(event.pointerId);
    return owner.pointerId == null || eventPointerId == null || eventPointerId === owner.pointerId;
  }

  _snapshotPointerMove(event) {
    return {
      type: 'pointermove',
      pointerId: event?.pointerId == null ? null : Number(event.pointerId),
      pointerType: String(event?.pointerType || 'mouse'),
      clientX: Number(event?.clientX),
      clientY: Number(event?.clientY),
      button: event?.button == null ? -1 : Number(event.button),
      buttons: event?.buttons == null ? 0 : Number(event.buttons),
      isPrimary: event?.isPrimary !== false,
      isTrusted: event?.isTrusted !== false,
      altKey: event?.altKey === true,
      ctrlKey: event?.ctrlKey === true,
      metaKey: event?.metaKey === true,
      shiftKey: event?.shiftKey === true,
      detail: Number(event?.detail || 0),
      timeStamp: Number(event?.timeStamp || 0),
      preventDefault() {},
      stopImmediatePropagation() {},
      stopPropagation() {}
    };
  }

  _queueCoalescedPointerMove(event) {
    this._pendingPointerMove = this._snapshotPointerMove(event);
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    event?.stopPropagation?.();
    if (this._pendingPointerMoveFrame != null) return;
    const flush = () => {
      this._pendingPointerMoveFrame = null;
      const latest = this._pendingPointerMove;
      this._pendingPointerMove = null;
      if (latest && this._coalescedPointerOwner) this._dispatchEvent('pointermove', latest);
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      this._pendingPointerMoveFrame = globalThis.requestAnimationFrame(flush);
    } else {
      this._pendingPointerMoveFrame = globalThis.setTimeout?.(flush, 0) ?? null;
    }
  }

  _flushCoalescedPointerMove() {
    if (this._pendingPointerMoveFrame != null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this._pendingPointerMoveFrame);
    }
    this._pendingPointerMoveFrame = null;
    const latest = this._pendingPointerMove;
    this._pendingPointerMove = null;
    if (latest && this._coalescedPointerOwner) this._dispatchEvent('pointermove', latest);
  }

  _discardCoalescedPointerMove() {
    if (this._pendingPointerMoveFrame != null) {
      if (typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(this._pendingPointerMoveFrame);
      } else if (typeof globalThis.clearTimeout === 'function') {
        globalThis.clearTimeout(this._pendingPointerMoveFrame);
      }
    }
    this._pendingPointerMoveFrame = null;
    this._pendingPointerMove = null;
  }

  _handleEvent(type, event) {
    // Typed into a text box, a key is not a tool shortcut: Escape in a search box must not
    // cancel the session behind it.
    if ((type === 'keydown' || type === 'keyup') && isKeyEventForTextEntry(event)) return;
    // A key pressed while the leave question is open belongs to that question (Escape = Continue Editing).
    if ((type === 'keydown' || type === 'keyup') && isSessionExitQuestionOpen()) return;
    if (type === 'pointermove' && this._matchesCoalescedPointer(event)) {
      this._queueCoalescedPointerMove(event);
      return;
    }
    const closesCoalescedPointer = (type === 'pointerup' || type === 'pointercancel')
      && this._matchesCoalescedPointer(event);
    // A queued pointermove is older than the terminal event. Dispatching it
    // immediately before release can start stale work after the delegate has
    // chosen its final state. Drop it; the delegate decides whether release
    // freezes its last visible preview or consumes the terminal coordinate.
    if (closesCoalescedPointer) this._discardCoalescedPointerMove();
    this._dispatchEvent(type, event);
    if (closesCoalescedPointer) this._clearCoalescedPointerMove();
  }

  _dispatchEvent(type, event) {
    if (POINTER_EVENT_TYPES.has(type)) {
      this._updatePointerFromEvent(event);
    }

    const context = {
      controller: this,
      pointer: this.getPointerState(),
      overCanvas: CanvasInteractionControllerImpl._isEventOverCanvas(event, this._pointerState)
    };

    const sessions = Array.from(this._sessions).sort((left, right) => (
      Number(right.exclusiveInput) - Number(left.exclusiveInput)
    ));
    for (const session of sessions) {
      const claimed = session.dispatch(type, event, context);
      if (type === 'pointerdown' && claimed && session.exclusiveInput && session.coalescePointerMove) {
        this._coalescedPointerOwner = {
          session,
          pointerId: event?.pointerId == null ? null : Number(event.pointerId)
        };
      }
      if (claimed && session.exclusiveInput) break;
    }
  }

  _updatePointerFromEvent(event) {
    const hasClient = event && typeof event.clientX === 'number' && typeof event.clientY === 'number';
    if (!hasClient) return;
    this._pointerState.screen = { x: event.clientX, y: event.clientY };
    const world = worldFromPointer(event);
    this._pointerState.world = world ? { x: world.x, y: world.y } : null;
  }

  static _isEventOverCanvas(event, pointerState) {
    try {
      if (typeof document === 'undefined') return false;
      const canvasEl = getCanvasElement();
      if (!canvasEl) return false;
      const x = (event && typeof event.clientX === 'number') ? event.clientX : pointerState?.screen?.x;
      const y = (event && typeof event.clientY === 'number') ? event.clientY : pointerState?.screen?.y;
      if (x == null || y == null) return false;
      const el = document.elementFromPoint(x, y);
      if (!el) return false;
      return el === canvasEl || canvasEl.contains(el);
    } catch (_) {
      return false;
    }
  }
}

const CONTROLLER_SYMBOL = Symbol.for('fa-nexus.canvas-interaction-controller');

function getInternalController() {
  if (!globalThis[CONTROLLER_SYMBOL]) {
    Object.defineProperty(globalThis, CONTROLLER_SYMBOL, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: new CanvasInteractionControllerImpl()
    });
  }
  return globalThis[CONTROLLER_SYMBOL];
}

function getCanvasInteractionController() {
  return getInternalController();
}

export {
  GRID_BASE_PX,
  getCanvasInteractionController,
  worldFromScreen,
  worldFromPointer,
  normalizeTileDocumentSortForPlacement,
  computeNextSortAtElevation,
  computeLowestSortAtElevation,
  sameElevation,
  resolvePlacementSortAtElevation,
  resolveAdjacentPlacementSortAnchor,
  announceChange,
  getGridScaleFactor,
  getCanvasElement
};
