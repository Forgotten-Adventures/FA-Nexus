import { NexusLogger as Logger } from '../core/nexus-logger.js';
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
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) {
      const doc = tile?.document;
      if (!doc) continue;
      if (!sameElevation(doc.elevation, elev)) continue;
      const sort = normalizeTileDocumentSortForPlacement(doc, {
        elevation: doc.elevation,
        sort: doc.sort,
        scene,
        source: 'computeNextSortAtElevation'
      }).sort;
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

function getSceneTileSortEntriesAtElevation(elevation = 0, scene = canvas?.scene) {
  const targetElevation = Number(elevation || 0) || 0;
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
    .filter((doc) => sameElevation(doc?.elevation, targetElevation))
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
  const entries = Array.isArray(siblingEntries) ? siblingEntries.slice().sort(sortTileSortEntries) : [];
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
  const requiredGap = (placementCount + 1) * SORT_STEP;
  let startSort = null;

  if (hasPrevious && !hasNext) {
    startSort = previousSort + SORT_STEP;
  } else if (!hasPrevious && hasNext) {
    startSort = nextSort - (placementCount * SORT_STEP);
  } else if (!hasPrevious && !hasNext) {
    startSort = SORT_STEP;
  } else if ((nextSort - previousSort) >= requiredGap) {
    startSort = previousSort + SORT_STEP;
  }

  const orderedEntries = entries.slice();
  orderedEntries.splice(insertionIndex, 0, ...syntheticEntries);

  if (Number.isFinite(startSort)) {
    for (let index = 0; index < syntheticEntries.length; index += 1) {
      syntheticEntries[index].sort = startSort + (index * SORT_STEP);
    }
    return { orderedEntries, syntheticEntries, previewSorts, reindexed: false };
  }

  for (let index = 0; index < orderedEntries.length; index += 1) {
    orderedEntries[index].sort = (index + 1) * SORT_STEP;
  }
  return { orderedEntries, syntheticEntries, previewSorts, reindexed: true };
}

function resolvePlacementSortAtElevation(elevation = 0, {
  anchorTileId = null,
  anchorTile = null,
  scene = canvas?.scene,
  count = 1,
  sortBefore = false
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
    const siblingEntries = getSceneTileSortEntriesAtElevation(normalizedElevation, scene);
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
    try { layer.activate?.(); } catch (_) { /* no-op */ }
    const state = {
      interactiveChildren: ('interactiveChildren' in layer) ? layer.interactiveChildren : undefined,
      eventMode: ('eventMode' in layer) ? layer.eventMode : undefined,
      placeables: []
    };
    try {
      const list = Array.isArray(layer.placeables) ? layer.placeables : [];
      for (const obj of list) {
        state.placeables.push({
          obj,
          interactive: ('interactive' in obj) ? obj.interactive : undefined,
          eventMode: ('eventMode' in obj) ? obj.eventMode : undefined
        });
        if ('eventMode' in obj) obj.eventMode = 'none';
        if ('interactive' in obj) obj.interactive = false;
      }
    } catch (_) { /* ignore */ }
    if ('interactiveChildren' in layer && state.interactiveChildren !== undefined) {
      layer.interactiveChildren = false;
    }
    if ('eventMode' in layer && state.eventMode !== undefined) {
      layer.eventMode = 'passive';
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
  } catch (_) {
    return null;
  }
}

function lockTileInteractivity() {
  return lockLayerInteractivity('tiles');
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
    this._layerLock = layerName ? lockLayerInteractivity(layerName) : null;
  }

  get eventTypes() {
    return this._eventTypes;
  }

  dispatch(type, event, context) {
    if (this._stopped) return;
    const handler = this._handlers[type];
    if (!handler) return;
    try {
      handler(event, context);
    } catch (err) {
      Logger.error('CanvasInteractionSession.handler.failed', {
        type,
        error: err
      });
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

  _handleEvent(type, event) {
    if (POINTER_EVENT_TYPES.has(type)) {
      this._updatePointerFromEvent(event);
    }

    const context = {
      controller: this,
      pointer: this.getPointerState(),
      overCanvas: CanvasInteractionControllerImpl._isEventOverCanvas(event, this._pointerState)
    };

    for (const session of this._sessions) {
      session.dispatch(type, event, context);
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
  resolvePlacementSortAtElevation,
  announceChange,
  getGridScaleFactor,
  getCanvasElement
};
