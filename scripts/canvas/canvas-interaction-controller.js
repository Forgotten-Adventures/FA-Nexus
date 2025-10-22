const GRID_BASE_PX = 200;

const defaultTarget = typeof window !== 'undefined' ? window : globalThis;
const documentTarget = typeof document !== 'undefined' ? document : null;

const EVENT_CONFIG = {
  pointermove: { target: defaultTarget, options: { capture: true, passive: false } },
  pointerdown: { target: defaultTarget, options: { capture: true, passive: false } },
  pointerup: { target: defaultTarget, options: { capture: true, passive: true } },
  pointercancel: { target: defaultTarget, options: { capture: true, passive: true } },
  wheel: { target: documentTarget || defaultTarget, options: { capture: true, passive: false } },
  keydown: { target: defaultTarget, options: { capture: true } },
  keyup: { target: defaultTarget, options: { capture: true } },
  contextmenu: { target: defaultTarget, options: { capture: true } },
  mousemove: { target: defaultTarget, options: { passive: true } }
};

const POINTER_EVENT_TYPES = new Set(['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'wheel', 'mousemove']);

const ANNOUNCE_THROTTLE = new Map();

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

function computeNextSortAtElevation(elevation = 0) {
  try {
    const elev = Number(elevation || 0) || 0;
    let maxSort = 0;
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) {
      const doc = tile?.document;
      if (!doc) continue;
      if (Number(doc.elevation || 0) !== elev) continue;
      const sort = Number(doc.sort || 0) || 0;
      if (sort > maxSort) maxSort = sort;
    }
    return maxSort + 2;
  } catch (_) {
    return 35;
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
            layer.interactiveChildren = state.interactiveChildren;
          }
          if (layer && 'eventMode' in layer && state.eventMode !== undefined) {
            layer.eventMode = state.eventMode;
          }
          for (const saved of state.placeables || []) {
            const obj = saved?.obj;
            if (!obj) continue;
            if (saved.eventMode !== undefined && 'eventMode' in obj) obj.eventMode = saved.eventMode;
            if (saved.interactive !== undefined && 'interactive' in obj) obj.interactive = saved.interactive;
          }
        } catch (_) { /* no-op */ }
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
      console.error('fa-nexus | CanvasInteractionSession handler failed', err);
    }
  }

  handleCanvasTearDown() {
    try {
      if (typeof this._options.onCanvasTearDown === 'function') {
        this._options.onCanvasTearDown();
      }
    } catch (_) { /* no-op */ }
    this.stop('canvas-teardown');
  }

  stop(reason = 'user') {
    if (this._stopped) return;
    this._stopped = true;
    try {
      if (this._layerLock) {
        this._layerLock.release?.();
      }
    } catch (_) { /* no-op */ }
    this._layerLock = null;
    this._controller._removeSession(this);
    try {
      if (typeof this._options.onStop === 'function') {
        this._options.onStop(reason);
      }
    } catch (_) { /* no-op */ }
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

  computeNextSortAtElevation(elevation) {
    return computeNextSortAtElevation(elevation);
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
  computeNextSortAtElevation,
  announceChange,
  getGridScaleFactor,
  getCanvasElement
};
