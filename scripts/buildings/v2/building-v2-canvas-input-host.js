import { createCanvasGestureSession } from '../../canvas/canvas-gesture-session.js';
import {
  GRID_SNAP_SUBDIV_SETTING_KEY,
  getGridSnapDivisor,
  getGridSnapStep,
  normalizeGridSnapSubdivision
} from '../../core/grid-snap-utils.js';
import { GRID_SNAP_SETTING_KEY, MODULE_ID, WALL_SNAP_SETTING_KEY } from '../../core/tool-options/shared.js';
import { isGridSnapShortcut, isWallSnapShortcut } from '../../core/editor-shortcuts.js';
import { evaluateBuildingV2Conic } from './building-v2-curve-runtime.js';
import { evaluateBuildingV2Cubic } from './building-v2-spline-runtime.js';
import { buildingV2DoorIndicatorsV14 } from './building-v2-door-indicators-v14.js';

const INPUT_EVENT_NAMES = Object.freeze([
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'keydown',
  'keyup'
]);
const OVERLAY_STATES = new Set(['candidate', 'resolved', 'rectangle-candidate', 'ellipse-candidate', 'polygon-candidate']);
const NATIVE_CAMERA_KEY_CODES = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'NumpadAdd',
  'NumpadSubtract',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9'
]);
const PASSTHROUGH_MODIFIER_KEYS = new Set(['Shift', 'Control', 'Meta']);
const INTERFACE_HANDLE_RADIUS_WORLD = Object.freeze({
  vertex: 5.6,
  typed: 7,
  translate: 8
});
const WALL_SNAP_RADIUS_SCREEN = 10;
const FALLBACK_WALL_CATEGORY_COLORS = Object.freeze({
  blank: 0x555555,
  ethereal: 0xCA81FF,
  invisible: 0x77E7E8,
  normal: 0xFFFFBB,
  terrain: 0x81B90C,
  window: 0xC7D8FF
});

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function immutableCopy(value) {
  return deepFreeze(cloneValue(value));
}

function requirePoint(value, label) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`Building V2 ${label} requires a finite point.`);
  }
  return { x, y };
}

function requireTransform(transform) {
  for (const methodName of ['worldToLocal', 'localToWorld']) {
    if (typeof transform?.[methodName] !== 'function') {
      throw new Error(`Building V2 Canvas input requires spatialTransform.${methodName}().`);
    }
  }
  return transform;
}

function foundryWallCategoryForBehavior(behavior = {}) {
  const senseTypes = globalThis.CONST?.EDGE_SENSE_TYPES || {};
  const none = Number.isFinite(Number(senseTypes.NONE)) ? Number(senseTypes.NONE) : 0;
  const limited = Number.isFinite(Number(senseTypes.LIMITED)) ? Number(senseTypes.LIMITED) : 10;
  const proximity = Number.isFinite(Number(senseTypes.PROXIMITY)) ? Number(senseTypes.PROXIMITY) : 30;
  const distance = Number.isFinite(Number(senseTypes.DISTANCE)) ? Number(senseTypes.DISTANCE) : 40;
  const sight = Number(behavior?.sight);
  const move = Number(behavior?.move);
  const light = Number(behavior?.light);
  const sound = Number(behavior?.sound);
  if (sight === none) {
    if (light + sound + move === none) return 'blank';
    return 'invisible';
  }
  if (sight === limited) return 'terrain';
  if (sight === distance || sight === proximity) return 'window';
  if (move === none) return 'ethereal';
  return 'normal';
}

function foundryWallColorForBehavior(behavior) {
  const category = foundryWallCategoryForBehavior(behavior);
  const configured = globalThis.foundry?.utils?.getDocumentClass?.('Wall')?.CATEGORY_COLORS?.[category]
    ?? globalThis.CONFIG?.Wall?.documentClass?.CATEGORY_COLORS?.[category];
  const numeric = Number(configured);
  return Number.isFinite(numeric) ? numeric : FALLBACK_WALL_CATEGORY_COLORS[category];
}

function createIdentitySpatialTransform() {
  return Object.freeze({
    worldToLocal: (point) => requirePoint(point, 'world-to-local conversion'),
    localToWorld: (point) => requirePoint(point, 'local-to-world conversion')
  });
}

function readGridSnapState() {
  const settings = globalThis.game?.settings;
  if (!settings || typeof settings.get !== 'function') {
    throw new Error('Building V2 world-grid snapping requires FA Nexus client settings.');
  }
  return {
    enabled: settings.get(MODULE_ID, GRID_SNAP_SETTING_KEY) === true,
    subdivisions: normalizeGridSnapSubdivision(settings.get(MODULE_ID, GRID_SNAP_SUBDIV_SETTING_KEY))
  };
}

function readWallSnapEnabled() {
  const settings = globalThis.game?.settings;
  if (!settings || typeof settings.get !== 'function') {
    throw new Error('Building V2 wall snapping requires FA Nexus client settings.');
  }
  return settings.get(MODULE_ID, WALL_SNAP_SETTING_KEY) === true;
}

function projectFoundryWorldPointToClientScreen(point) {
  const world = requirePoint(point, 'wall-snap world point');
  const board = globalThis.canvas?.app?.renderer?.view;
  const stage = globalThis.canvas?.stage;
  const rendererScreen = globalThis.canvas?.app?.renderer?.screen;
  const PIXI = globalThis.PIXI;
  if (!board?.getBoundingClientRect || !stage?.worldTransform?.apply || !rendererScreen || !PIXI?.Point) {
    throw new Error('Building V2 wall snapping requires the active Foundry renderer projection.');
  }
  const boardRect = board.getBoundingClientRect();
  const scaleX = Number(boardRect.width) / Math.max(1, Number(rendererScreen.width));
  const scaleY = Number(boardRect.height) / Math.max(1, Number(rendererScreen.height));
  const rendererPoint = stage.worldTransform.apply(new PIXI.Point(world.x, world.y));
  return requirePoint({
    x: Number(boardRect.left) + (Number(rendererPoint.x) * scaleX),
    y: Number(boardRect.top) + (Number(rendererPoint.y) * scaleY)
  }, 'wall-snap client-screen result');
}

function evaluateWallSnapTargetLocal(target, t) {
  const start = requirePoint(target.startLocal, 'wall-snap Segment start');
  const end = requirePoint(target.endLocal, 'wall-snap Segment end');
  const clamped = Math.max(0, Math.min(1, Number(t)));
  if (target?.geometry?.kind === 'cubic') return evaluateBuildingV2Cubic(start, target.geometry, end, clamped);
  if (target?.geometry?.kind !== 'conic') {
    return {
      x: start.x + ((end.x - start.x) * clamped),
      y: start.y + ((end.y - start.y) * clamped)
    };
  }
  return evaluateBuildingV2Conic(start, target.geometry, end, clamped);
}

function compareWallSnapCandidates(left, right) {
  const distance = Number(left.distance) - Number(right.distance);
  if (Math.abs(distance) > 1e-7) return distance;
  return String(left.key).localeCompare(String(right.key));
}

function snapWorldPointWithFoundryGrid(point, { subdivisions } = {}) {
  const world = requirePoint(point, 'world-grid snap');
  const grid = globalThis.canvas?.grid;
  if (grid?.isGridless === true) return world;
  if (!grid || typeof grid.getSnappedPoint !== 'function') {
    throw new Error('Building V2 world-grid snapping requires the active Foundry Canvas grid.');
  }
  if (grid.isSquare === true) {
    const gridSize = Number(globalThis.canvas?.scene?.grid?.size ?? grid.size);
    const step = getGridSnapStep(gridSize, subdivisions);
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error('Building V2 square-grid snapping requires a positive active Scene grid size.');
    }
    // Preserve the released Building Editor rule: every square subdivision is
    // a grid-aligned lattice, including the even 1/2 and 1/4 divisions.
    return {
      x: Math.round(world.x / step) * step,
      y: Math.round(world.y / step) * step
    };
  }
  const vertexMode = globalThis.CONST?.GRID_SNAPPING_MODES?.VERTEX;
  if (!Number.isFinite(Number(vertexMode))) {
    throw new Error('Building V2 world-grid snapping requires Foundry GRID_SNAPPING_MODES.VERTEX.');
  }
  const snapped = grid.getSnappedPoint(world, {
    mode: Number(vertexMode),
    resolution: getGridSnapDivisor(subdivisions)
  });
  return requirePoint(snapped, 'snapped world result');
}

function createFoundryInterfaceOverlayHost() {
  const PIXI = globalThis.PIXI;
  const target = globalThis.canvas?.interface;
  if (!PIXI?.Container || !PIXI?.Graphics || !target || typeof target.addChild !== 'function') {
    throw new Error('Building V2 interface overlay requires the active Foundry Canvas interface group and PixiJS runtime.');
  }

  const container = new PIXI.Container();
  container.name = 'fa-nexus-building-v2-authoring-overlay';
  container.eventMode = 'none';
  container.interactiveChildren = false;
  container.zIndex = 200100;

  const graphics = new PIXI.Graphics();
  graphics.name = 'fa-nexus-building-v2-authoring-outline';
  graphics.eventMode = 'none';
  container.addChild(graphics);
  const doorGraphics = new PIXI.Graphics();
  doorGraphics.name = 'fa-nexus-building-v2-door-indicators';
  doorGraphics.eventMode = 'none';
  container.addChild(doorGraphics);
  target.addChild(container);
  target.sortChildren?.();
  const moveGlyphs = new Map();
  const clearMoveGlyphs = () => {
    for (const glyph of moveGlyphs.values()) glyph.destroy();
    moveGlyphs.clear();
  };

  let actionBar = null;
  let actionBarSignature = '';
  let actionContext = null;
  let actionTickerMounted = false;
  // Presentation-only brightness; canonical descriptors and hit geometry stay untouched.
  const hoverFadeDurationMS = 140;
  const hoverBrightness = new Map();
  let hoverTicker = null;
  let drawOverlay = null;
  let doorGraphicsPopulated = false;
  const brightnessKey = (category, entry) => JSON.stringify([category, entry.kind || '', entry.id]);
  const stopHoverFade = () => {
    if (hoverTicker) hoverTicker.remove(advanceHoverFade);
    hoverTicker = null;
  };
  const advanceHoverFade = () => {
    try {
      const frameMS = Number(hoverTicker.deltaMS);
      if (!Number.isFinite(frameMS) || frameMS < 0) {
        throw new Error('Building V2 hover fade requires a finite, nonnegative Foundry ticker deltaMS.');
      }
      const step = frameMS / hoverFadeDurationMS;
      for (const entry of hoverBrightness.values()) {
        const difference = entry.target - entry.current;
        entry.current = Math.abs(difference) <= step
          ? entry.target : entry.current + Math.sign(difference) * step;
      }
      drawOverlay();
      if (![...hoverBrightness.values()].some((entry) => entry.current !== entry.target)) stopHoverFade();
    } catch (error) {
      stopHoverFade();
      throw error;
    }
  };
  const prepareHoverFade = (outlines, segments, handles, selection) => {
    const liveKeys = new Set();
    const selectedSegments = selection?.domain === 'segment' ? new Set(selection.ids || []) : new Set();
    for (const [category, entries] of [['outline', outlines], ['segment', segments], ['handle', handles]]) {
      for (const entry of entries) {
        const key = brightnessKey(category, entry);
        liveKeys.add(key);
        const immediate = category !== 'outline' && (entry.selected === true || entry.emphasized === true
          || (category === 'segment' && selectedSegments.has(entry.id)));
        const target = immediate || entry.faded !== true ? 1 : 0;
        const previous = hoverBrightness.get(key);
        if (!previous) hoverBrightness.set(key, { current: target, target });
        else {
          previous.target = target;
          if (immediate) previous.current = 1;
        }
      }
    }
    for (const key of hoverBrightness.keys()) if (!liveKeys.has(key)) hoverBrightness.delete(key);
  };
  const hoverAlpha = (category, entry, normal, faded) => faded
    + (normal - faded) * hoverBrightness.get(brightnessKey(category, entry)).current;
  const scheduleHoverFade = () => {
    if (![...hoverBrightness.values()].some((entry) => entry.current !== entry.target)) {
      stopHoverFade();
      return;
    }
    if (hoverTicker) return;
    const ticker = globalThis.canvas?.app?.ticker;
    if (typeof ticker?.add !== 'function' || typeof ticker?.remove !== 'function') {
      throw new Error('Building V2 hover fade requires the active Foundry Canvas ticker.');
    }
    hoverTicker = ticker;
    ticker.add(advanceHoverFade);
  };
  const clearHoverFade = () => {
    stopHoverFade();
    hoverBrightness.clear();
    drawOverlay = null;
  };

  const positionActionBar = () => {
    if (!actionBar || !actionContext?.pointsWorld?.length) return;
    const board = globalThis.canvas?.app?.renderer?.view;
    const stage = globalThis.canvas?.stage;
    const rendererScreen = globalThis.canvas?.app?.renderer?.screen;
    if (!board?.getBoundingClientRect || !stage?.worldTransform?.apply || !rendererScreen) return;
    const boardRect = board.getBoundingClientRect();
    const scaleX = boardRect.width / Math.max(1, Number(rendererScreen.width));
    const scaleY = boardRect.height / Math.max(1, Number(rendererScreen.height));
    const screenPoints = actionContext.pointsWorld.map((point) => stage.worldTransform.apply(
      new PIXI.Point(point.x, point.y)
    )).map((point) => ({
      x: boardRect.left + (point.x * scaleX),
      y: boardRect.top + (point.y * scaleY)
    }));
    const minX = Math.min(...screenPoints.map((point) => point.x));
    const maxX = Math.max(...screenPoints.map((point) => point.x));
    const minY = Math.min(...screenPoints.map((point) => point.y));
    const maxY = Math.max(...screenPoints.map((point) => point.y));
    const margin = 8;
    const gap = 10;
    const width = Math.max(1, actionBar.offsetWidth || 1);
    const height = Math.max(1, actionBar.offsetHeight || 1);
    let left = ((minX + maxX) / 2) - (width / 2);
    let top = maxY + gap;
    if (top + height > boardRect.bottom - margin) top = minY - height - gap;
    left = Math.max(boardRect.left + margin, Math.min(left, boardRect.right - width - margin));
    top = Math.max(boardRect.top + margin, Math.min(top, boardRect.bottom - height - margin));
    actionBar.style.left = `${Math.round(left)}px`;
    actionBar.style.top = `${Math.round(top)}px`;
  };

  const destroyActionBar = () => {
    if (actionTickerMounted) {
      globalThis.canvas?.app?.ticker?.remove?.(positionActionBar);
      actionTickerMounted = false;
    }
    actionBar?.remove?.();
    actionBar = null;
    actionBarSignature = '';
    actionContext = null;
  };

  const renderActionBar = ({ overlayId = '', actions = [], onAction = null, pointsWorld = [] } = {}) => {
    const normalizedActions = Array.isArray(actions) ? actions : [];
    if (!normalizedActions.length || typeof onAction !== 'function' || typeof document === 'undefined') {
      destroyActionBar();
      return;
    }
    actionContext = { overlayId: String(overlayId || ''), actions: normalizedActions, onAction, pointsWorld };
    const signature = JSON.stringify(normalizedActions.map((action) => [
      String(action.id || ''), String(action.label || '')
    ]));
    if (!actionBar || actionBarSignature !== signature) {
      destroyActionBar();
      actionContext = { overlayId: String(overlayId || ''), actions: normalizedActions, onAction, pointsWorld };
      actionBarSignature = signature;
      actionBar = document.createElement('div');
      // The bar is dark whatever the page's colour scheme, so its buttons take Foundry's dark theme.
      actionBar.className = 'fa-nexus-building-v2-candidate-actions themed theme-dark';
      actionBar.setAttribute('role', 'toolbar');
      actionBar.setAttribute('aria-label', 'Shape candidate actions');
      for (const action of normalizedActions) {
        const actionId = String(action.id || '').trim();
        if (!actionId) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `fa-nexus-building-v2-candidate-actions__button${action.primary === true ? ' is-primary' : ''}${action.status === 'active' ? ' is-active' : ''}`;
        button.textContent = String(action.label || actionId);
        button.setAttribute('aria-disabled', action.disabled === true ? 'true' : 'false');
        button.classList.toggle('is-disabled', action.disabled === true);
        button.dataset.actionId = actionId;
        if (action.status) button.dataset.status = String(action.status);
        const emit = (phase) => {
          const result = actionContext?.onAction?.({
            candidateId: actionContext.overlayId,
            actionId,
            phase
          });
          if (result && typeof result.catch === 'function') {
            Promise.resolve(result).catch((error) => {
              console.error('[FA Nexus] Building V2 candidate action failed.', {
                candidateId: actionContext?.overlayId || null,
                actionId,
                phase,
                error: String(error?.message || error)
              });
              globalThis.ui?.notifications?.error?.(String(error?.message || error));
            });
          }
          return result;
        };
        button.addEventListener('pointerenter', () => emit('enter'));
        button.addEventListener('pointerleave', () => emit('leave'));
        button.addEventListener('focus', () => emit('focus'));
        button.addEventListener('blur', () => emit('blur'));
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const currentAction = actionContext?.actions?.find?.((entry) => String(entry?.id || '') === actionId);
          if (currentAction?.disabled === true) return;
          emit('activate');
        });
        actionBar.appendChild(button);
      }
      document.body.appendChild(actionBar);
      globalThis.canvas?.app?.ticker?.add?.(positionActionBar);
      actionTickerMounted = true;
    }
    for (const action of normalizedActions) {
      const actionId = String(action.id || '').trim();
      const button = Array.from(actionBar.querySelectorAll?.('button[data-action-id]') || [])
        .find((entry) => entry.dataset.actionId === actionId);
      if (!button) continue;
      button.setAttribute('aria-disabled', action.disabled === true ? 'true' : 'false');
      button.classList.toggle('is-disabled', action.disabled === true);
      button.classList.toggle('is-primary', action.primary === true);
      button.classList.toggle('is-active', action.status === 'active');
      if (action.status) button.dataset.status = String(action.status);
      else delete button.dataset.status;
    }
    positionActionBar();
  };

  return {
    render({
      pointsWorld,
      outlinesWorld = [],
      handlesWorld = [],
      openingLinesWorld = [],
      doorIndicatorsWorld = [],
      segmentsWorld = [],
      selection = null,
      closed = true,
      closingSegmentColor = null,
      state = 'candidate',
      color: requestedColor = null,
      overlayId = '',
      contextualActions = [],
      handleContextualAction = null,
      behaviorPresentation = false,
      doorIndicatorsBelowAuthoring = false,
      snapFeedbackWorld = null,
      firstPointWorld = null
    } = {}) {
      const points = Array.isArray(pointsWorld)
        ? pointsWorld.map((point) => requirePoint(point, 'interface-overlay world point'))
        : [];
      const firstPoint = firstPointWorld
        ? requirePoint(firstPointWorld, 'interface-overlay first point')
        : null;
      if (points.length < 2 && !firstPoint && !handlesWorld.length && !openingLinesWorld.length) {
        throw new Error('Building V2 interface overlay requires a world path, handle, Opening centerline, or first-point marker.');
      }
      if (!OVERLAY_STATES.has(state)) throw new Error(`Building V2 interface overlay state is unsupported: ${state}.`);

      const color = requestedColor != null && Number.isFinite(Number(requestedColor))
        ? Number(requestedColor)
        : (state === 'resolved' ? 0x66e3ff : 0xffb347);
      container.faNexusBuildingV2FirstPointWorld = firstPoint
        ? { x: firstPoint.x, y: firstPoint.y }
        : null;
      container.faNexusBuildingV2BehaviorPresentation = behaviorPresentation;
      container.faNexusBuildingV2DoorIndicatorsBelowAuthoring = doorIndicatorsBelowAuthoring === true;
      // Portal authoring keeps the motion guide over its own non-interactive
      // centerline. Edit Geometry instead puts every Wall stroke and handle in
      // front because those marks are the active pointer targets.
      const doorLayerIndex = doorIndicatorsBelowAuthoring === true ? 0 : Math.min(1, container.children.length - 1);
      if (container.children[doorLayerIndex] !== doorGraphics) container.setChildIndex(doorGraphics, doorLayerIndex);
      const handleOnly = (handlesWorld.length > 0 || behaviorPresentation) && state === 'resolved';
      prepareHoverFade(outlinesWorld, segmentsWorld, handlesWorld, selection);
      const liveMoveGlyphs = new Set(handlesWorld.filter((handle) => handle.kind === 'translate')
        .map((handle) => brightnessKey('handle', handle)));
      for (const [key, glyph] of moveGlyphs) if (!liveMoveGlyphs.has(key)) {
        glyph.destroy();
        moveGlyphs.delete(key);
      }
      drawOverlay = () => {
        graphics.clear();
        if (doorGraphicsPopulated || doorIndicatorsWorld.length) doorGraphics.clear();
        doorGraphicsPopulated = false;
        for (const outline of outlinesWorld) {
          const outlinePoints = Array.isArray(outline?.pointsWorld) ? outline.pointsWorld : [];
          if (outlinePoints.length < 2) continue;
          graphics.lineStyle(2, color, hoverAlpha('outline', outline, outline?.kind === 'hole' ? 0.75 : 0.9, 0.18));
          graphics.moveTo(outlinePoints[0].x, outlinePoints[0].y);
          for (const point of outlinePoints.slice(1)) graphics.lineTo(point.x, point.y);
          if (outline?.closed !== false) graphics.closePath();
        }
        if (!handleOnly && points.length >= 2) {
          const shapeCandidate = state === 'rectangle-candidate' || state === 'ellipse-candidate' || state === 'polygon-candidate';
          const strokeWidth = shapeCandidate ? 2 : (state === 'resolved' ? 3 : 2);
          const hasDistinctClosingSegment = closed && closingSegmentColor != null
            && Number.isFinite(Number(closingSegmentColor));
          if (hasDistinctClosingSegment) {
            graphics.lineStyle(0, color, 0);
            graphics.beginFill(color, shapeCandidate ? 0.2 : (state === 'resolved' ? 0.05 : 0.08));
            graphics.moveTo(points[0].x, points[0].y);
            for (const point of points.slice(1)) graphics.lineTo(point.x, point.y);
            graphics.lineTo(points[0].x, points[0].y);
            graphics.closePath();
            graphics.endFill();
            graphics.lineStyle(strokeWidth, color, 0.95);
            graphics.moveTo(points[0].x, points[0].y);
            for (const point of points.slice(1)) graphics.lineTo(point.x, point.y);
            graphics.lineStyle(strokeWidth, Number(closingSegmentColor), 0.95);
            graphics.moveTo(points.at(-1).x, points.at(-1).y);
            graphics.lineTo(points[0].x, points[0].y);
          } else {
            graphics.lineStyle(strokeWidth, color, 0.95);
            if (closed) graphics.beginFill(color, shapeCandidate ? 0.2 : (state === 'resolved' ? 0.05 : 0.08));
            graphics.moveTo(points[0].x, points[0].y);
            for (const point of points.slice(1)) graphics.lineTo(point.x, point.y);
            if (closed) graphics.closePath();
            if (closed) graphics.endFill();
          }
        }
        const selectedSegmentIds = selection?.domain === 'segment' ? new Set(selection.ids || []) : new Set();
        if (behaviorPresentation) {
          for (const segment of segmentsWorld) {
            if (!selectedSegmentIds.has(segment.id)) continue;
            const path = segment.pointsWorld?.length >= 2
              ? segment.pointsWorld
              : [segment.startWorld, segment.endWorld];
            graphics.lineStyle(9, 0xff9829, hoverAlpha('segment', segment, 1, 0.2));
            graphics.moveTo(path[0].x, path[0].y);
            for (const point of path.slice(1)) graphics.lineTo(point.x, point.y);
          }
          for (const segment of segmentsWorld) {
            const path = segment.pointsWorld?.length >= 2
              ? segment.pointsWorld
              : [segment.startWorld, segment.endWorld];
            const segmentAlpha = hoverAlpha('segment', segment, 1, 0.22);
            graphics.lineStyle(5, 0x000000, segmentAlpha);
            graphics.moveTo(path[0].x, path[0].y);
            for (const point of path.slice(1)) graphics.lineTo(point.x, point.y);
            graphics.lineStyle(3, segment.purpose === 'fill-divider' ? 0x80d4e7 : foundryWallColorForBehavior(segment.behavior), segmentAlpha);
            graphics.moveTo(path[0].x, path[0].y);
            for (const point of path.slice(1)) graphics.lineTo(point.x, point.y);
          }
        }
        for (const segment of segmentsWorld) {
          if (behaviorPresentation) continue;
          if (!selectedSegmentIds.has(segment.id)) continue;
          graphics.lineStyle(6, 0xffb347, hoverAlpha('segment', segment, 1, 0.2));
          const path = segment.pointsWorld?.length >= 2
            ? segment.pointsWorld
            : [segment.startWorld, segment.endWorld];
          graphics.moveTo(path[0].x, path[0].y);
          for (const point of path.slice(1)) graphics.lineTo(point.x, point.y);
        }
        for (const line of openingLinesWorld) {
          const [left, right] = Array.isArray(line) ? line : line.points;
          graphics.lineStyle(1, line.hovered === true || line.selected === true ? 0x66e3ff : 0xffffff, 0.85);
          graphics.moveTo(left.x, left.y);
          graphics.lineTo(right.x, right.y);
        }
        for (const handle of handlesWorld) {
          const point = requirePoint(handle?.pointWorld, 'interface-overlay handle world point');
          if (handle?.guideStartWorld) {
            const guide = requirePoint(handle.guideStartWorld, 'interface-overlay handle guide world point');
            graphics.lineStyle(2, 0xffffff, hoverAlpha('handle', handle, 0.8, 0.2));
            graphics.moveTo(guide.x, guide.y);
            graphics.lineTo(point.x, point.y);
          }
          if (handle?.kind === 'translate') {
            const key = brightnessKey('handle', handle);
            let glyph = moveGlyphs.get(key);
            if (!glyph) {
              if (!PIXI.Text) throw new Error('Building V2 move handles require PixiJS Text.');
              // Foundry v14 ships Font Awesome 7 Pro; f0b2 is fa-up-down-left-right.
              glyph = new PIXI.Text('\uf0b2', { fontFamily: 'Font Awesome 7 Pro', fontWeight: '900',
                fontSize: 16, fill: 0xffffff, stroke: 0x000000, strokeThickness: 2, lineJoin: 'round' });
              // Keep the filled arrow silhouette and its outline crisp across Canvas zoom.
              glyph.resolution = 4;
              glyph.name = `fa-nexus-building-v2-move-${handle.id}`;
              glyph.eventMode = 'none';
              glyph.anchor.set(0.5);
              moveGlyphs.set(key, glyph);
              container.addChild(glyph);
            }
            glyph.position.set(point.x, point.y);
            glyph.alpha = hoverAlpha('handle', handle, 1, 0.25);
            glyph.tint = handle.color ?? (handle.selected === true || handle.hovered === true ? 0x66e3ff : 0xffffff);
            continue;
          }
          if (handle?.kind === 'opening-jamb') {
            const normal = requirePoint(handle.normalWorld, 'Opening jamb world normal');
            const length = Math.hypot(normal.x, normal.y);
            if (length <= 1e-10) throw new Error('Opening jamb normal must be nonzero.');
            const dx = normal.x / length * 8, dy = normal.y / length * 8;
            graphics.lineStyle(2, handle.selected === true || handle.hovered === true ? 0x66e3ff : 0xffffff, hoverAlpha('handle', handle, 1, 0.25));
            graphics.moveTo(point.x - dx, point.y - dy);
            graphics.lineTo(point.x + dx, point.y + dy);
            continue;
          }
          const handleAlpha = hoverAlpha('handle', handle, 1, 0.25);
          graphics.lineStyle(2, handle?.selected === true ? 0xff9829 : (handle?.kind ? 0xffffff : 0x000000), handleAlpha);
          const vertexColor = handle?.behavior
            ? foundryWallColorForBehavior(handle.behavior)
            : 0x189cff;
          graphics.beginFill(handle?.kind === 'spline-control' ? 0xa78bfa : handle?.kind === 'rotate' || handle?.kind === 'curve-control'
            ? 0xffb347
            : (handle?.emphasized === true ? 0xffffff : vertexColor), handleAlpha);
          if (handle?.kind === 'resize') graphics.drawRect(point.x - 6, point.y - 6, 12, 12);
          else if (handle?.kind === 'spline-control') graphics.drawPolygon([
            point.x, point.y - 7, point.x + 7, point.y, point.x, point.y + 7, point.x - 7, point.y
          ]);
          else if (handle?.kind === 'curve-control') {
            graphics.moveTo(point.x, point.y - 7);
            graphics.lineTo(point.x + 6, point.y + 4);
            graphics.lineTo(point.x - 6, point.y + 4);
            graphics.closePath();
          }
          else graphics.drawCircle(point.x, point.y,
            handle?.kind
              ? INTERFACE_HANDLE_RADIUS_WORLD.typed
              : INTERFACE_HANDLE_RADIUS_WORLD.vertex * (handle?.emphasized === true ? 1.25 : 1));
          graphics.endFill();
        }
        for (const descriptor of doorIndicatorsWorld) {
          for (const { pivot, guide, travel } of buildingV2DoorIndicatorsV14(descriptor)) {
            doorGraphicsPopulated = true;
            const selected = descriptor.selected === true;
            const motionColor = selected ? 0x66e3ff : 0xd8dee9;
            const pivotColor = selected ? 0xffb347 : 0xffffff;
            const drawPath = (path, width, alpha) => {
              if (!path.length) return;
              doorGraphics.lineStyle(width + 2, 0x000000, 0.9);
              doorGraphics.moveTo(path[0].x, path[0].y);
              for (const point of path.slice(1)) doorGraphics.lineTo(point.x, point.y);
              doorGraphics.lineStyle(width, motionColor, alpha);
              doorGraphics.moveTo(path[0].x, path[0].y);
              for (const point of path.slice(1)) doorGraphics.lineTo(point.x, point.y);
            };
            drawPath(guide, 2, selected ? 0.35 : 0.3);
            drawPath(travel, 2, selected ? 0.95 : 0.75);
            const end = travel.at(-1), previous = travel.at(-2);
            const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
            const headSize = Math.min(9, Math.hypot(end.x - travel[0].x, end.y - travel[0].y) * 0.25);
            drawPath([ { x: end.x - Math.cos(angle - 0.5) * headSize, y: end.y - Math.sin(angle - 0.5) * headSize },
              end, { x: end.x - Math.cos(angle + 0.5) * headSize, y: end.y - Math.sin(angle + 0.5) * headSize } ], 2, 1);
            if (pivot) {
              doorGraphics.lineStyle(5, 0x000000, 0.95);
              // A single swivel shares its pivot with the center move glyph.
              doorGraphics.drawCircle(pivot.x, pivot.y, descriptor.animation.type === 'swivel' ? 11 : 7);
              doorGraphics.lineStyle(2, pivotColor, 1);
              doorGraphics.drawCircle(pivot.x, pivot.y, descriptor.animation.type === 'swivel' ? 11 : 7);
              doorGraphics.lineStyle(1, 0x000000, 1);
              doorGraphics.beginFill(pivotColor, 1);
              doorGraphics.drawCircle(pivot.x, pivot.y, 3);
              doorGraphics.endFill();
            }
          }
        }
        if (firstPoint) {
          graphics.lineStyle(1, 0xffffff, 1);
          graphics.beginFill(color, 0.95);
          graphics.drawCircle(firstPoint.x, firstPoint.y, 3.5);
          graphics.endFill();
          graphics.lineStyle(1, color, 1);
          graphics.drawCircle(firstPoint.x, firstPoint.y, 5);
        }
        if (snapFeedbackWorld) {
          const point = requirePoint(snapFeedbackWorld, 'wall-snap feedback world point');
          graphics.lineStyle(2, 0xfff176, 1);
          graphics.beginFill(0x189cff, 0.9);
          graphics.drawCircle(point.x, point.y, 6);
          graphics.endFill();
        }
      };
      try {
        drawOverlay();
        scheduleHoverFade();
      } catch (error) {
        stopHoverFade();
        throw error;
      }
      renderActionBar({
        overlayId,
        actions: contextualActions,
        onAction: handleContextualAction,
        pointsWorld: points
      });
    },

    clear() {
      clearHoverFade();
      clearMoveGlyphs();
      graphics.clear();
      doorGraphics.clear();
      doorGraphicsPopulated = false;
      container.faNexusBuildingV2FirstPointWorld = null;
      container.faNexusBuildingV2BehaviorPresentation = false;
      destroyActionBar();
    },

    destroy() {
      clearHoverFade();
      clearMoveGlyphs();
      destroyActionBar();
      if (!container.destroyed) container.destroy({ children: true });
    }
  };
}

function normalizeInput(eventName, event, pointer) {
  const screen = pointer?.screen ? requirePoint(pointer.screen, 'pointer screen position') : null;
  const world = pointer?.world ? requirePoint(pointer.world, 'pointer world position') : null;
  const pointerId = event?.pointerId == null ? null : Number(event.pointerId);
  const button = event?.button == null ? null : Number(event.button);
  const buttons = event?.buttons == null ? null : Number(event.buttons);
  const normalized = {
    kind: eventName,
    pointerId: Number.isFinite(pointerId) ? pointerId : null,
    button: Number.isFinite(button) ? button : null,
    buttons: Number.isFinite(buttons) ? buttons : null,
    isPrimary: event?.isPrimary !== false,
    overCanvas: !!(pointer?.overCanvas && pointer?.zOk),
    screen,
    world,
    key: typeof event?.key === 'string' ? event.key : '',
    modifiers: {
      alt: event?.altKey === true,
      control: event?.ctrlKey === true,
      meta: event?.metaKey === true,
      shift: event?.shiftKey === true
    }
  };
  const detail = Number(event?.detail);
  if (Number.isFinite(detail) && detail > 0) normalized.detail = detail;
  const timeStamp = Number(event?.timeStamp);
  if (Number.isFinite(timeStamp) && timeStamp > 0) normalized.timeStamp = timeStamp;
  if (eventName === 'wheel') {
    const deltaY = Number(event?.deltaY);
    normalized.deltaY = Number.isFinite(deltaY) ? deltaY : 0;
  }
  if (eventName === 'keydown' || eventName === 'keyup') {
    normalized.repeat = event?.repeat === true;
  }
  return immutableCopy(normalized);
}

function consumeEvent(event) {
  event?.preventDefault?.();
  event?.stopImmediatePropagation?.();
  event?.stopPropagation?.();
}

function isTextEditingKeyboardTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;
  try {
    if (target.matches?.('textarea, select, [contenteditable="true"], [contenteditable=""]') === true) return true;
    if (target.matches?.('input') !== true) return false;
    const type = String(target.type || target.getAttribute?.('type') || '').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden'].includes(type);
  } catch (_) {
    return false;
  }
}

function isNativeControlKeyboardEvent(event) {
  const target = event?.target;
  if (!target || typeof target !== 'object') return false;
  const key = String(event?.key || '');
  try {
    // Foundry's modal dialogs own native focus traversal, including chooser
    // hover/focus previews. The exclusive Canvas session must not consume Tab.
    if (key === 'Tab' && target.closest?.('dialog[open]')) return true;
    if (target.closest?.('#fa-nexus-building-wall-behavior[open]')) return true;
    if (target.matches?.('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]') === true) {
      return key === 'Enter' || key === ' ' || key === 'Spacebar';
    }
    if (target.matches?.('input[type="checkbox"], input[type="radio"]') === true) {
      return key === ' ' || key === 'Spacebar';
    }
    if (target.matches?.('input[type="range"]') === true) {
      return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key);
    }
  } catch (_) {}
  return false;
}

function isNativeWindowShortcut(event) {
  const key = String(event?.key || '').toLowerCase();
  const code = String(event?.code || '');
  if (code === 'F1' || code === 'F5' || code === 'F12') return true;
  return (event?.ctrlKey === true || event?.metaKey === true) && key === 'r';
}

async function toggleGridSnapWithCanonicalController() {
  const { toolOptionsController } = await import('../../core/tool-options/tool-options-controller.js');
  return toolOptionsController.toggleGridSnapShortcut();
}

async function nudgeGridSnapWithCanonicalController(delta) {
  const { toolOptionsController } = await import('../../core/tool-options/tool-options-controller.js');
  return toolOptionsController.nudgeGridSnapSubdivision(delta);
}

async function toggleWallSnapWithCanonicalController() {
  const { toolOptionsController } = await import('../../core/tool-options/tool-options-controller.js');
  return toolOptionsController.invokeToolHandler('setWallSnapEnabled', !readWallSnapEnabled());
}

function shouldClaimUnhandledInput(eventName, event, input) {
  if (eventName.startsWith('pointer')) {
    if (!input.overCanvas) return false;
    if (eventName === 'pointerdown') return input.button === 0;
    if (eventName === 'pointerup' || eventName === 'pointercancel') {
      return input.button === 0 || ((input.buttons ?? 0) & 1) === 1;
    }
    return eventName === 'pointermove' && (((input.buttons ?? 0) & 1) === 1);
  }
  if (eventName !== 'keydown' && eventName !== 'keyup') return false;
  if (isTextEditingKeyboardTarget(event?.target)) return false;
  if (isNativeControlKeyboardEvent(event)) return false;
  if (isNativeWindowShortcut(event)) return false;
  const key = String(event?.key || '');
  const code = String(event?.code || key);
  if (key === 'Escape') return false;
  if (PASSTHROUGH_MODIFIER_KEYS.has(key)) return false;
  if (NATIVE_CAMERA_KEY_CODES.has(code) || NATIVE_CAMERA_KEY_CODES.has(key)) return false;
  return true;
}

export function createBuildingV2CanvasInputHost({
  sceneId,
  createGestureSession = createCanvasGestureSession,
  createOverlayHost = createFoundryInterfaceOverlayHost,
  getGridSnapState = readGridSnapState,
  getWallSnapEnabled = readWallSnapEnabled,
  snapWorldPoint = snapWorldPointWithFoundryGrid,
  projectWorldToScreen = projectFoundryWorldPointToClientScreen,
  toggleGridSnap = toggleGridSnapWithCanonicalController,
  toggleWallSnap = toggleWallSnapWithCanonicalController,
  nudgeGridSnapSubdivisions = nudgeGridSnapWithCanonicalController,
  spatialTransform = createIdentitySpatialTransform()
} = {}) {
  const normalizedSceneId = String(sceneId || '').trim();
  if (!normalizedSceneId) throw new Error('Building V2 Canvas input host requires a non-empty Scene identity.');
  if (typeof createGestureSession !== 'function') throw new TypeError('Building V2 Canvas input host requires createGestureSession().');
  if (typeof createOverlayHost !== 'function') throw new TypeError('Building V2 Canvas input host requires createOverlayHost().');
  if (typeof getGridSnapState !== 'function') throw new TypeError('Building V2 Canvas input host requires getGridSnapState().');
  if (typeof getWallSnapEnabled !== 'function') throw new TypeError('Building V2 Canvas input host requires getWallSnapEnabled().');
  if (typeof snapWorldPoint !== 'function') throw new TypeError('Building V2 Canvas input host requires snapWorldPoint().');
  if (typeof projectWorldToScreen !== 'function') throw new TypeError('Building V2 Canvas input host requires projectWorldToScreen().');
  if (typeof toggleGridSnap !== 'function') throw new TypeError('Building V2 Canvas input host requires toggleGridSnap().');
  if (typeof toggleWallSnap !== 'function') throw new TypeError('Building V2 Canvas input host requires toggleWallSnap().');
  if (typeof nudgeGridSnapSubdivisions !== 'function') {
    throw new TypeError('Building V2 Canvas input host requires nudgeGridSnapSubdivisions().');
  }
  const transform = requireTransform(spatialTransform);
  const transformProbeLocal = requirePoint(transform.worldToLocal({ x: 0, y: 0 }), 'spatial-transform probe');
  requirePoint(transform.localToWorld(transformProbeLocal), 'inverse spatial-transform probe');

  let gestureSession = null;
  let mountedHandlers = null;
  let overlayHost = null;
  let lastOverlay = null;
  let activePointerGesture = false;
  let activePointerId = null;
  let pendingViewportMove = null;
  let gridSnapShortcutHeld = false;
  let gridSnapShortcutPendingToggle = false;
  let recoveryListenersMounted = false;
  let suspended = false;
  let destroyed = false;

  const requireAvailable = () => {
    if (destroyed) throw new Error('Building V2 Canvas input host is destroyed.');
    if (suspended) throw new Error('Building V2 Canvas input host is suspended for Canvas rebind.');
  };

  const ensureOverlayHost = () => {
    overlayHost ??= createOverlayHost();
    return overlayHost;
  };

  const resetGridSnapShortcutState = () => {
    gridSnapShortcutHeld = false;
    gridSnapShortcutPendingToggle = false;
  };

  const resetTransientKeyboardState = () => {
    resetGridSnapShortcutState();
    try {
      mountedHandlers?.modifiersreset?.();
    } catch (error) {
      console.error('[FA Nexus] Building Editor V2 could not reset transient keyboard modifiers.', error);
    }
  };

  const handleVisibilityLoss = () => {
    if (globalThis.document?.visibilityState === 'hidden') resetTransientKeyboardState();
  };

  const mountRecoveryListeners = () => {
    if (recoveryListenersMounted) return;
    globalThis.window?.addEventListener?.('blur', resetTransientKeyboardState);
    globalThis.document?.addEventListener?.('visibilitychange', handleVisibilityLoss);
    recoveryListenersMounted = true;
  };

  const unmountRecoveryListeners = () => {
    if (!recoveryListenersMounted) return;
    globalThis.window?.removeEventListener?.('blur', resetTransientKeyboardState);
    globalThis.document?.removeEventListener?.('visibilitychange', handleVisibilityLoss);
    recoveryListenersMounted = false;
  };

  const invokeSnapAction = (action, eventName) => {
    try {
      const result = action();
      Promise.resolve(result).catch((error) => {
        console.error(`[FA Nexus] Building Editor V2 ${eventName} failed.`, error);
        globalThis.ui?.notifications?.error?.(String(error?.message || error));
      });
    } catch (error) {
      console.error(`[FA Nexus] Building Editor V2 ${eventName} failed.`, error);
      globalThis.ui?.notifications?.error?.(String(error?.message || error));
    }
  };

  const handleInputFailure = (error, context = {}) => {
    activePointerGesture = false;
    activePointerId = null;
    pendingViewportMove = null;
    resetGridSnapShortcutState();
    consumeEvent(context.event);
    const failure = immutableCopy({
      kind: 'canvas-input-error',
      eventName: String(context.eventName || 'unknown'),
      message: String(error?.message || error || 'Unknown Canvas input error')
    });
    console.error('[FA Nexus] Building Editor V2 Canvas input failed; aborting the active session.', failure, error);
    try {
      globalThis.ui?.notifications?.error?.(
        `Building Editor V2 Canvas input failed during ${failure.eventName}; the active session was aborted. See the console for details.`
      );
    } catch (notificationError) {
      console.error('[FA Nexus] Building Editor V2 could not show its Canvas input failure notification.', notificationError);
    }
    try {
      mountedHandlers?.inputerror?.(failure);
    } catch (abortError) {
      console.error('[FA Nexus] Building Editor V2 Canvas input failure cleanup also failed.', abortError);
    }
    return true;
  };

  const mountGesture = () => {
    if (!mountedHandlers || gestureSession) return;
    const eventHandlers = {};
    for (const eventName of INPUT_EVENT_NAMES) {
      const handler = mountedHandlers[eventName];
      eventHandlers[eventName] = (event, context) => {
        if (eventName === 'pointermove' && event?.isTrusted === false && Number(event?.buttons ?? 0) === 0
          && context?.pointer?.overCanvas && context.pointer.zOk) {
          const sameViewportPointer = !pendingViewportMove
            || pendingViewportMove.pointerId == null
            || event?.pointerId == null
            || Number(event.pointerId) === pendingViewportMove.pointerId;
          // Foundry emits untrusted, buttonless pointer replays after Canvas
          // clicks and pans. Their coordinates can be an older Pixi root
          // pointer position, so provenance identifies them without another
          // coordinate cache. Real pointer moves and held drags remain trusted.
          if (sameViewportPointer) pendingViewportMove = null;
          consumeEvent(event);
          return true;
        }
        const input = normalizeInput(eventName, event, context?.pointer);
        const keyboardInput = eventName === 'keydown' || eventName === 'keyup';
        const escapeKeyboardInput = keyboardInput && String(event?.key || '') === 'Escape';
        const textEditingKeyboardInput = keyboardInput && isTextEditingKeyboardTarget(event?.target);
        const nativeControlKeyboardInput = keyboardInput && isNativeControlKeyboardEvent(event);
        const nativeWindowKeyboardInput = keyboardInput && isNativeWindowShortcut(event);
        const bypassEditorKeyboardInput = (textEditingKeyboardInput && !escapeKeyboardInput)
          || nativeControlKeyboardInput
          || nativeWindowKeyboardInput;
        if (!bypassEditorKeyboardInput && keyboardInput) {
          const wallSnapShortcut = isWallSnapShortcut(event);
          const snapShortcut = isGridSnapShortcut(event);
          const sKey = String(event?.key || '').toLowerCase() === 's';
          if (eventName === 'keydown' && wallSnapShortcut) {
            if (event?.repeat !== true) invokeSnapAction(() => toggleWallSnap(), 'wall snap toggle');
            consumeEvent(event);
            return true;
          }
          if (eventName === 'keyup' && wallSnapShortcut) {
            consumeEvent(event);
            return true;
          }
          if (eventName === 'keydown' && snapShortcut) {
            gridSnapShortcutHeld = true;
            if (event?.repeat !== true) gridSnapShortcutPendingToggle = true;
            consumeEvent(event);
            return true;
          }
          if (eventName === 'keyup' && sKey && gridSnapShortcutHeld) {
            const shouldToggle = gridSnapShortcutPendingToggle && snapShortcut;
            resetGridSnapShortcutState();
            if (shouldToggle) invokeSnapAction(() => toggleGridSnap(), 'grid snap toggle');
            consumeEvent(event);
            return true;
          }
        }
        const handled = !bypassEditorKeyboardInput && typeof handler === 'function' && handler(input) === true;
        if (eventName === 'pointerdown' && handled) {
          activePointerGesture = true;
          activePointerId = input.pointerId;
        }
        const closesActivePointer = activePointerId == null
          || input.pointerId == null
          || activePointerId === input.pointerId;
        if ((eventName === 'pointerup' || eventName === 'pointercancel') && closesActivePointer) {
          activePointerGesture = false;
          activePointerId = null;
          pendingViewportMove = null;
        }
        if (eventName === 'keydown' && handled && input.key === 'Escape') {
          activePointerGesture = false;
          activePointerId = null;
          pendingViewportMove = null;
        }
        const claimed = handled || shouldClaimUnhandledInput(eventName, event, input);
        if (claimed) consumeEvent(event);
        return claimed;
      };
    }
    if (typeof mountedHandlers.pointermove === 'function' || typeof mountedHandlers.wheel === 'function') {
      eventHandlers.wheel = (event, context = {}) => {
        if (gridSnapShortcutHeld
          && !event?.altKey
          && !event?.ctrlKey
          && !event?.metaKey
          && context?.pointer?.overCanvas
          && context?.pointer?.zOk) {
          const deltaY = Number(event?.deltaY);
          if (Number.isFinite(deltaY) && deltaY !== 0) {
            gridSnapShortcutPendingToggle = false;
            invokeSnapAction(
              () => nudgeGridSnapSubdivisions(deltaY < 0 ? 1 : -1),
              'grid snap subdivision adjustment'
            );
            consumeEvent(event);
            return true;
          }
        }
        if (event?.altKey
          && context?.pointer?.overCanvas
          && context?.pointer?.zOk
          && typeof mountedHandlers.wheel === 'function') {
          const input = normalizeInput('wheel', event, context?.pointer);
          const handled = mountedHandlers.wheel(input) === true;
          if (handled) {
            consumeEvent(event);
            return true;
          }
        }
        if (!activePointerGesture) return false;
        const pointer = context.pointer;
        const foundryControlModifier = globalThis.game?.keyboard?.isModifierActive?.('CONTROL') === true;
        const deltaY = Number(event?.deltaY);
        const normalCanvasZoom = pointer?.overCanvas
          && pointer?.zOk
          && pointer?.screen
          && !foundryControlModifier
          && !event?.shiftKey
          && Number.isFinite(deltaY)
          && deltaY !== 0;
        if (normalCanvasZoom) {
          pendingViewportMove = { pointerId: activePointerId };
        }
        // Foundry owns wheel zoom. The following untrusted pointermove is
        // filtered above so it cannot become a Rectangle geometry update.
        return false;
      };
    }
    if (!Object.keys(eventHandlers).length) {
      throw new Error('Building V2 Canvas input mount requires at least one pointer or keyboard handler.');
    }
    const session = createGestureSession(eventHandlers, {
      exclusiveInput: true,
      // High-polling-rate pointer streams are capture-consumed immediately and
      // resolved once per frame from their latest position.
      coalescePointerMove: true,
      // Building authoring owns placeable hover and manipulation across every
      // Foundry layer. The capture boundary still leaves camera input native.
      lockPlaceableInteractivity: true,
      onHandlerError: handleInputFailure,
      onCanvasTearDown: () => {
        resetGridSnapShortcutState();
        mountedHandlers?.canvasteardown?.();
      },
      onStop: () => {
        resetGridSnapShortcutState();
        if (gestureSession === session) gestureSession = null;
      }
    });
    gestureSession = session;
  };

  const renderOverlay = (descriptor) => {
    const state = String(descriptor?.state || 'candidate').trim();
    if (!OVERLAY_STATES.has(state)) throw new Error(`Building V2 interface overlay state is unsupported: ${state}.`);
    const localPoints = Array.isArray(descriptor?.pointsLocal)
      ? descriptor.pointsLocal.map((point) => requirePoint(point, 'interface-overlay local point'))
      : [];
    const closed = descriptor?.closed !== false;
    const operation = descriptor?.operation === 'subtract' ? 'subtract' : (descriptor?.operation === 'add' ? 'add' : null);
    const color = descriptor?.color != null && Number.isFinite(Number(descriptor.color)) ? Number(descriptor.color) : null;
    const closingSegmentColor = descriptor?.closingSegmentColor != null
      && Number.isFinite(Number(descriptor.closingSegmentColor))
      ? Number(descriptor.closingSegmentColor)
      : null;
    const overlayId = String(descriptor?.overlayId || '').trim();
    const handles = Array.isArray(descriptor?.handles)
      ? descriptor.handles.map((handle) => ({
          id: String(handle?.id || ''),
          kind: String(handle?.kind || ''),
          emphasized: handle?.emphasized === true,
          selected: handle?.selected === true,
          hovered: handle?.hovered === true,
          ...(handle?.color != null && Number.isFinite(Number(handle.color)) ? { color: Number(handle.color) } : {}),
          faded: handle?.faded === true,
          ...(handle?.behavior && typeof handle.behavior === 'object'
            ? { behavior: cloneValue(handle.behavior) }
            : {}),
          pointLocal: requirePoint(handle?.pointLocal, 'interface-overlay handle local point'),
          ...(handle?.normalLocal ? {
            normalLocal: requirePoint(handle.normalLocal, 'interface-overlay handle local normal')
          } : {}),
          ...(handle?.guideStartLocal ? {
            guideStartLocal: requirePoint(handle.guideStartLocal, 'interface-overlay handle guide local point')
          } : {})
        }))
      : [];
    const openingLinesLocal = Array.isArray(descriptor?.openingLinesLocal)
      ? descriptor.openingLinesLocal.map((line) => {
          const endpoints = Array.isArray(line) ? line : line?.points;
          if (!Array.isArray(endpoints) || endpoints.length !== 2) throw new Error('Opening centerline requires two local endpoints.');
          const points = endpoints.map((point) => requirePoint(point, 'Opening centerline local endpoint'));
          return Array.isArray(line) ? points : { points, hovered: line.hovered === true, selected: line.selected === true };
        })
      : [];
    const doorIndicatorsLocal = (descriptor?.doorIndicatorsLocal || []).map((indicator) => {
      if (!Array.isArray(indicator.points) || indicator.points.length !== 2) throw new Error('Door indicator requires two local endpoints.');
      return { points: indicator.points.map(point => requirePoint(point, 'Door indicator local endpoint')),
        animation: cloneValue(indicator.animation || {}), selected: indicator.selected === true };
    });
    const outlines = Array.isArray(descriptor?.outlinesLocal)
      ? descriptor.outlinesLocal.map((outline) => ({
          id: String(outline?.id || ''),
          kind: String(outline?.kind || ''),
          closed: outline?.closed !== false,
          faded: outline?.faded === true,
          pointsLocal: Array.isArray(outline?.pointsLocal)
            ? outline.pointsLocal.map((point) => requirePoint(point, 'interface-overlay outline local point'))
            : []
        })).filter((outline) => outline.pointsLocal.length >= 2)
      : [];
    const segments = Array.isArray(descriptor?.segments)
      ? descriptor.segments.map((segment) => ({
          id: String(segment?.id || ''),
          purpose: segment?.purpose === 'fill-divider' ? 'fill-divider' : 'wall',
          faded: segment?.faded === true,
          startLocal: requirePoint(segment?.startLocal, 'interface-overlay Segment start local point'),
          endLocal: requirePoint(segment?.endLocal, 'interface-overlay Segment end local point'),
          ...(segment?.behavior && typeof segment.behavior === 'object'
            ? { behavior: cloneValue(segment.behavior) }
            : {}),
          pointsLocal: Array.isArray(segment?.pointsLocal)
            ? segment.pointsLocal.map((point) => requirePoint(point, 'interface-overlay Segment path local point'))
            : []
        }))
      : [];
    const selection = descriptor?.selection?.domain === 'segment'
      ? { domain: 'segment', ids: (descriptor.selection.ids || []).map((id) => String(id)) }
      : descriptor?.selection?.domain === 'vertex'
        ? { domain: 'vertex', ids: (descriptor.selection.ids || []).map((id) => String(id)) }
        : null;
    const contextualActions = Array.isArray(descriptor?.contextualActions)
      ? descriptor.contextualActions.map((action) => ({
          id: String(action?.id || '').trim(),
          label: String(action?.label || '').trim(),
          primary: action?.primary === true,
          disabled: action?.disabled === true,
          status: String(action?.status || '').trim()
        })).filter((action) => action.id)
      : [];
    const handleContextualAction = typeof descriptor?.handleContextualAction === 'function'
      ? descriptor.handleContextualAction
      : null;
    const behaviorPresentation = descriptor?.behaviorPresentation === true;
    const doorIndicatorsBelowAuthoring = descriptor?.doorIndicatorsBelowAuthoring === true;
    const snapFeedbackLocal = descriptor?.snapFeedbackLocal
      ? requirePoint(descriptor.snapFeedbackLocal, 'wall-snap feedback local point')
      : null;
    const firstPointLocal = descriptor?.firstPointLocal
      ? requirePoint(descriptor.firstPointLocal, 'interface-overlay first local point')
      : null;
    if (localPoints.length < 2 && !firstPointLocal && !handles.length && !openingLinesLocal.length) {
      throw new Error('Building V2 interface overlay requires a local path, handle, Opening centerline, or first-point marker.');
    }
    // All normalized overlay branches above are newly allocated. Preserve the
    // rebind snapshot by freezing that graph directly instead of cloning every
    // outline, tessellated segment, and handle a second time during a drag.
    lastOverlay = deepFreeze({
      state, overlayId, closed, closingSegmentColor, pointsLocal: localPoints, openingLinesLocal, doorIndicatorsLocal, outlinesLocal: outlines, handles, segments, selection, operation, color,
      behaviorPresentation, doorIndicatorsBelowAuthoring, snapFeedbackLocal, firstPointLocal,
      contextualActions, handleContextualAction
    });
    const pointsWorld = localPoints.map((point) => requirePoint(
      transform.localToWorld(point),
      'interface-overlay local-to-world result'
    ));
    const handlesWorld = handles.map((handle) => ({
      id: handle.id,
      kind: handle.kind,
      ...(handle.emphasized === true ? { emphasized: true } : {}),
      ...(handle.selected === true ? { selected: true } : {}),
      ...(handle.hovered === true ? { hovered: true } : {}),
      ...(handle.color != null ? { color: handle.color } : {}),
      ...(handle.faded === true ? { faded: true } : {}),
      ...(handle.behavior ? { behavior: cloneValue(handle.behavior) } : {}),
      pointWorld: requirePoint(transform.localToWorld(handle.pointLocal), 'interface-overlay handle local-to-world result'),
      ...(handle.normalLocal ? {
        normalWorld: (() => {
          const origin = requirePoint(transform.localToWorld(handle.pointLocal), 'Opening jamb world origin');
          const tip = requirePoint(transform.localToWorld({ x: handle.pointLocal.x + handle.normalLocal.x,
            y: handle.pointLocal.y + handle.normalLocal.y }), 'Opening jamb world normal endpoint');
          return { x: tip.x - origin.x, y: tip.y - origin.y };
        })()
      } : {}),
      ...(handle.guideStartLocal ? {
        guideStartWorld: requirePoint(
          transform.localToWorld(handle.guideStartLocal),
          'interface-overlay handle guide local-to-world result'
        )
      } : {})
    }));
    const outlinesWorld = outlines.map((outline) => ({
      id: outline.id,
      kind: outline.kind,
      closed: outline.closed,
      ...(outline.faded === true ? { faded: true } : {}),
      pointsWorld: outline.pointsLocal.map((point) => requirePoint(
        transform.localToWorld(point),
        'interface-overlay outline local-to-world result'
      ))
    }));
    const segmentsWorld = segments.map((segment) => ({
      id: segment.id,
      purpose: segment.purpose,
      ...(segment.faded === true ? { faded: true } : {}),
      startWorld: requirePoint(transform.localToWorld(segment.startLocal), 'interface-overlay Segment start world point'),
      endWorld: requirePoint(transform.localToWorld(segment.endLocal), 'interface-overlay Segment end world point'),
      ...(segment.behavior ? { behavior: cloneValue(segment.behavior) } : {}),
      pointsWorld: segment.pointsLocal.map((point) => requirePoint(
        transform.localToWorld(point),
        'interface-overlay Segment path local-to-world result'
      ))
    }));
    const snapFeedbackWorld = snapFeedbackLocal
      ? requirePoint(transform.localToWorld(snapFeedbackLocal), 'wall-snap feedback local-to-world result')
      : null;
    const firstPointWorld = firstPointLocal
      ? requirePoint(transform.localToWorld(firstPointLocal), 'interface-overlay first-point local-to-world result')
      : null;
    // A mirrored Building turns its doors the other way round in the Scene (see materializeBuildingV2DoorWall).
    // The guide is drawn in the Scene, so it takes the mirrored direction too.
    const origin = transform.localToWorld({ x: 0, y: 0 });
    const alongX = transform.localToWorld({ x: 1, y: 0 });
    const alongY = transform.localToWorld({ x: 0, y: 1 });
    const mirrored = ((alongX.x - origin.x) * (alongY.y - origin.y) - (alongX.y - origin.y) * (alongY.x - origin.x)) < 0;
    ensureOverlayHost().render({
      state, closed, pointsWorld,
      ...(doorIndicatorsLocal.length ? { doorIndicatorsWorld: doorIndicatorsLocal.map(indicator => ({
        animation: mirrored ? { ...indicator.animation, direction: indicator.animation.direction === -1 ? 1 : -1 } : indicator.animation,
        selected: indicator.selected,
        points: indicator.points.map(point => requirePoint(transform.localToWorld(point), 'Door indicator world endpoint')) })) } : {}),
      ...(openingLinesLocal.length ? { openingLinesWorld: openingLinesLocal.map((line) => {
        const points = (Array.isArray(line) ? line : line.points).map((point) => requirePoint(
          transform.localToWorld(point), 'Opening centerline world endpoint'
        ));
        return Array.isArray(line) ? points : { points, hovered: line.hovered, selected: line.selected };
      }) } : {}),
      ...(closingSegmentColor != null ? { closingSegmentColor } : {}),
      ...(overlayId ? { overlayId } : {}),
      ...(operation ? { operation } : {}),
      ...(color != null ? { color } : {}),
      ...(selection ? { selection } : {}),
      ...(outlinesWorld.length ? { outlinesWorld } : {}),
      ...(handlesWorld.length ? { handlesWorld } : {}),
      ...(segmentsWorld.length ? { segmentsWorld } : {}),
      ...(behaviorPresentation ? { behaviorPresentation: true } : {}),
      ...(doorIndicatorsBelowAuthoring ? { doorIndicatorsBelowAuthoring: true } : {}),
      ...(snapFeedbackWorld ? { snapFeedbackWorld } : {}),
      ...(firstPointWorld ? { firstPointWorld } : {}),
      ...(contextualActions.length ? { contextualActions } : {}),
      ...(handleContextualAction ? { handleContextualAction } : {})
    });
  };

  return Object.freeze({
    mount(handlers = {}) {
      requireAvailable();
      if (mountedHandlers) throw new Error('Building V2 Canvas input is already mounted.');
      const snapState = getGridSnapState() || {};
      if (snapState.enabled === true) {
        snapWorldPoint({ x: 0, y: 0 }, {
          subdivisions: normalizeGridSnapSubdivision(snapState.subdivisions)
        });
      }
      ensureOverlayHost().clear?.();
      mountedHandlers = Object.freeze({ ...handlers });
      mountRecoveryListeners();
      try {
        mountGesture();
      } catch (error) {
        unmountRecoveryListeners();
        mountedHandlers = null;
        throw error;
      }
    },

    resolveGeometryPoint(worldPoint, options = {}) {
      requireAvailable();
      const rawWorld = requirePoint(worldPoint, 'geometry input world point');
      const rawLocal = requirePoint(transform.worldToLocal(rawWorld), 'raw geometry world-to-local result');
      const localRadiusForWorld = (radius) => {
        const offsetLocal = requirePoint(transform.worldToLocal({
          x: rawWorld.x + Number(radius),
          y: rawWorld.y
        }), 'geometry handle radius world-to-local result');
        return Math.hypot(offsetLocal.x - rawLocal.x, offsetLocal.y - rawLocal.y);
      };
      const state = getGridSnapState() || {};
      const enabled = state.enabled === true;
      const subdivisions = normalizeGridSnapSubdivision(state.subdivisions);
      const wallSnapRequested = options?.wallSnap?.enabled === true;
      const wallSnapEnabled = wallSnapRequested && getWallSnapEnabled() === true;
      if (enabled) {
        const resolvedWorld = requirePoint(snapWorldPoint(rawWorld, { subdivisions }), 'snapped geometry world point');
        const world = {
          x: Math.round(Number(resolvedWorld.x)),
          y: Math.round(Number(resolvedWorld.y))
        };
        const local = requirePoint(transform.worldToLocal(world), 'geometry world-to-local result');
        return immutableCopy({
          rawWorld,
          rawLocal,
          world,
          local,
          handleRadiusLocal: {
            vertex: localRadiusForWorld(INTERFACE_HANDLE_RADIUS_WORLD.vertex),
            typed: localRadiusForWorld(INTERFACE_HANDLE_RADIUS_WORLD.typed),
            translate: localRadiusForWorld(INTERFACE_HANDLE_RADIUS_WORLD.translate)
          },
          snap: { enabled: true, subdivisions },
          wallSnap: { enabled: wallSnapEnabled, matched: false }
        });
      }
      const pointerScreen = options?.screen
        ? requirePoint(options.screen, 'wall-snap pointer screen position')
        : null;
      const excludeSegmentIds = new Set(
        Array.from(options?.wallSnap?.excludeSegmentIds || [], (id) => String(id || '').trim()).filter(Boolean)
      );
      const excludeVertexIds = new Set(
        Array.from(options?.wallSnap?.excludeVertexIds || [], (id) => String(id || '').trim()).filter(Boolean)
      );
      const targets = wallSnapEnabled && pointerScreen && Array.isArray(options?.wallSnap?.targets)
        ? options.wallSnap.targets
        : [];
      const vertexCandidates = [];
      const segmentCandidates = [];
      const screenDistance = (local) => {
        const world = requirePoint(transform.localToWorld(local), 'wall-snap local-to-world result');
        const screen = requirePoint(projectWorldToScreen(world), 'wall-snap world-to-screen result');
        return {
          screen,
          distance: Math.hypot(screen.x - pointerScreen.x, screen.y - pointerScreen.y)
        };
      };
      for (const target of targets) {
        const segmentId = String(target?.segmentId || '').trim();
        if (!segmentId || excludeSegmentIds.has(segmentId)) continue;
        const startLocal = requirePoint(target?.startLocal, 'wall-snap target start');
        const endLocal = requirePoint(target?.endLocal, 'wall-snap target end');
        for (const [kind, vertexId, local] of [
          ['start', String(target?.startVertexId || '').trim(), startLocal],
          ['end', String(target?.endVertexId || '').trim(), endLocal]
        ]) {
          if (!vertexId || excludeVertexIds.has(vertexId)) continue;
          const projected = screenDistance(local);
          if (projected.distance <= WALL_SNAP_RADIUS_SCREEN) vertexCandidates.push({
            key: `${vertexId}:${kind}:${segmentId}`,
            kind: 'vertex',
            segmentId,
            vertexId,
            local,
            ...projected
          });
        }
        let best = null;
        const sampleCount = 32;
        if (!['conic', 'cubic'].includes(target?.geometry?.kind)) {
          const startScreen = screenDistance(startLocal).screen;
          const endScreen = screenDistance(endLocal).screen;
          const dx = endScreen.x - startScreen.x;
          const dy = endScreen.y - startScreen.y;
          const lengthSquared = (dx * dx) + (dy * dy);
          const t = lengthSquared > 0
            ? Math.max(0, Math.min(1, (((pointerScreen.x - startScreen.x) * dx)
              + ((pointerScreen.y - startScreen.y) * dy)) / lengthSquared))
            : 0;
          const local = evaluateWallSnapTargetLocal(target, t);
          best = { t, local, ...screenDistance(local) };
        } else for (let index = 0; index <= sampleCount; index += 1) {
          const t = index / sampleCount;
          const local = evaluateWallSnapTargetLocal(target, t);
          const projected = screenDistance(local);
          if (!best || projected.distance < best.distance) best = { t, local, ...projected };
        }
        if (['conic', 'cubic'].includes(target?.geometry?.kind) && best) {
          let lower = Math.max(0, best.t - (1 / sampleCount));
          let upper = Math.min(1, best.t + (1 / sampleCount));
          for (let iteration = 0; iteration < 12; iteration += 1) {
            const leftT = lower + ((upper - lower) / 3);
            const rightT = upper - ((upper - lower) / 3);
            const leftLocal = evaluateWallSnapTargetLocal(target, leftT);
            const rightLocal = evaluateWallSnapTargetLocal(target, rightT);
            const left = { t: leftT, local: leftLocal, ...screenDistance(leftLocal) };
            const right = { t: rightT, local: rightLocal, ...screenDistance(rightLocal) };
            if (left.distance <= right.distance) {
              upper = rightT;
              if (left.distance < best.distance) best = left;
            } else {
              lower = leftT;
              if (right.distance < best.distance) best = right;
            }
          }
        }
        if (best?.distance <= WALL_SNAP_RADIUS_SCREEN) segmentCandidates.push({
          key: segmentId,
          kind: 'segment',
          segmentId,
          vertexId: null,
          ...best
        });
      }
      const wallCandidate = vertexCandidates.sort(compareWallSnapCandidates)[0]
        || segmentCandidates.sort(compareWallSnapCandidates)[0]
        || null;
      if (wallCandidate) {
        const local = requirePoint(wallCandidate.local, 'wall-snap winning local point');
        const world = requirePoint(transform.localToWorld(local), 'wall-snap winning world point');
        return immutableCopy({
          rawWorld,
          rawLocal,
          world,
          local,
          handleRadiusLocal: {
            vertex: localRadiusForWorld(INTERFACE_HANDLE_RADIUS_WORLD.vertex),
            typed: localRadiusForWorld(INTERFACE_HANDLE_RADIUS_WORLD.typed),
            translate: localRadiusForWorld(INTERFACE_HANDLE_RADIUS_WORLD.translate)
          },
          snap: { enabled, subdivisions },
          wallSnap: {
            enabled: true,
            matched: true,
            kind: wallCandidate.kind,
            segmentId: wallCandidate.segmentId,
            vertexId: wallCandidate.vertexId,
            pointLocal: local
          }
        });
      }
      const resolvedWorld = { ...rawWorld };
      // Foundry v14 Wall coordinates are integer schema fields. Resolve every
      // durable geometry gesture onto that document lattice before mapping it
      // into Building-local space so authoring, preview, Commit, and recapture
      // all use the same exact endpoints.
      const world = {
        x: Math.round(Number(resolvedWorld.x)),
        y: Math.round(Number(resolvedWorld.y))
      };
      const local = requirePoint(transform.worldToLocal(world), 'geometry world-to-local result');
      return immutableCopy({
        rawWorld,
        rawLocal,
        world,
        local,
        handleRadiusLocal: {
          vertex: localRadiusForWorld(INTERFACE_HANDLE_RADIUS_WORLD.vertex),
          typed: localRadiusForWorld(INTERFACE_HANDLE_RADIUS_WORLD.typed),
          translate: localRadiusForWorld(INTERFACE_HANDLE_RADIUS_WORLD.translate)
        },
        snap: { enabled, subdivisions },
        wallSnap: { enabled: wallSnapEnabled, matched: false }
      });
    },

    renderInterfaceOverlay(descriptor) {
      requireAvailable();
      renderOverlay(descriptor);
    },

    clearInterfaceOverlay({ overlayId = null } = {}) {
      if (destroyed) return false;
      const expectedOverlayId = String(overlayId || '').trim();
      if (expectedOverlayId && lastOverlay?.overlayId !== expectedOverlayId) return false;
      lastOverlay = null;
      overlayHost?.clear?.();
      return true;
    },

    suspend() {
      if (destroyed) throw new Error('Building V2 Canvas input host is destroyed.');
      if (suspended) return false;
      resetTransientKeyboardState();
      suspended = true;
      activePointerGesture = false;
      activePointerId = null;
      pendingViewportMove = null;
      unmountRecoveryListeners();
      gestureSession?.stop?.('canvas-rebind-suspend');
      gestureSession = null;
      overlayHost?.destroy?.();
      overlayHost = null;
      return true;
    },

    resume() {
      if (destroyed) throw new Error('Building V2 Canvas input host is destroyed.');
      if (!suspended) throw new Error('Building V2 Canvas input host was not suspended.');
      suspended = false;
      try {
        mountRecoveryListeners();
        ensureOverlayHost().clear?.();
        mountGesture();
        if (lastOverlay) renderOverlay(lastOverlay);
        return true;
      } catch (error) {
        gestureSession?.stop?.('canvas-rebind-resume-failed');
        gestureSession = null;
        overlayHost?.destroy?.();
        overlayHost = null;
        unmountRecoveryListeners();
        suspended = true;
        throw error;
      }
    },

    destroy() {
      if (destroyed) return false;
      destroyed = true;
      activePointerGesture = false;
      activePointerId = null;
      pendingViewportMove = null;
      resetGridSnapShortcutState();
      unmountRecoveryListeners();
      gestureSession?.stop?.('runtime-lease-release');
      gestureSession = null;
      overlayHost?.destroy?.();
      overlayHost = null;
      mountedHandlers = null;
      lastOverlay = null;
      return true;
    }
  });
}

export {
  createFoundryInterfaceOverlayHost,
  createIdentitySpatialTransform,
  snapWorldPointWithFoundryGrid
};
