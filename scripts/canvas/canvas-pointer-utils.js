import { getCanvasInteractionController } from './canvas-interaction-controller.js';

const overlayPointerIds = new Set();

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return value;
  if (Number.isFinite(min) && value < min) return min;
  if (Number.isFinite(max) && value > max) return max;
  return value;
}

function getCanvasZoomBounds({ fallbackMin = 0.25, fallbackMax = 4 } = {}) {
  const dimScale = globalThis.canvas?.dimensions?.scale;
  const dimMin = Number(dimScale?.min);
  const dimMax = Number(dimScale?.max);
  if (Number.isFinite(dimMin) || Number.isFinite(dimMax)) {
    return {
      min: Number.isFinite(dimMin) ? dimMin : fallbackMin,
      max: Number.isFinite(dimMax) ? dimMax : fallbackMax
    };
  }

  const cfgMin = Number(globalThis?.CONFIG?.Canvas?.minZoom);
  const cfgMax = Number(globalThis?.CONFIG?.Canvas?.maxZoom);
  return {
    min: Number.isFinite(cfgMin) ? cfgMin : fallbackMin,
    max: Number.isFinite(cfgMax) ? cfgMax : fallbackMax
  };
}

/**
 * Compute a canvas pan target (x, y, scale) which keeps the world position under the cursor fixed while zooming.
 * Uses Foundry's per-scene zoom bounds (`canvas.dimensions.scale`) when available to avoid drift at clamp limits.
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvasEl     The Foundry canvas element
 * @param {number} options.screenX                Client (viewport) X coordinate
 * @param {number} options.screenY                Client (viewport) Y coordinate
 * @param {number} options.targetScale            Desired scale before clamping
 * @param {number} [options.epsilon=1e-6]         Treat scale changes below epsilon as no-op
 * @returns {{x: number, y: number, scale: number}|null}
 */
export function getZoomAtCursorView({ canvasEl, screenX, screenY, targetScale, epsilon = 1e-6 } = {}) {
  const stage = globalThis.canvas?.stage;
  if (!stage || stage.destroyed) return null;
  if (!canvasEl || typeof canvasEl.getBoundingClientRect !== 'function') return null;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return null;
  if (!Number.isFinite(targetScale)) return null;

  const rect = canvasEl.getBoundingClientRect();
  if (!rect) return null;

  const cx = screenX - rect.left;
  const cy = screenY - rect.top;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;

  const currentScale = Number(stage.scale?.x || 1);
  const { min, max } = getCanvasZoomBounds();
  const newScale = clampNumber(targetScale, min, max);
  if (!Number.isFinite(newScale) || !Number.isFinite(currentScale)) return null;
  if (Math.abs(newScale - currentScale) < epsilon) return null;

  const worldUnderCursor = stage.worldTransform.applyInverse(new PIXI.Point(cx, cy));
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const desiredCenterX = worldUnderCursor.x + (centerX - cx) / newScale;
  const desiredCenterY = worldUnderCursor.y + (centerY - cy) / newScale;
  if (!Number.isFinite(desiredCenterX) || !Number.isFinite(desiredCenterY)) return null;

  return { x: desiredCenterX, y: desiredCenterY, scale: newScale };
}

function getElementZIndex(element) {
  if (!element || typeof window === 'undefined' || !window.getComputedStyle) return 0;
  try {
    const style = window.getComputedStyle(element);
    const raw = style?.zIndex;
    if (raw === 'auto' || raw === 'inherit') {
      return element.parentElement ? getElementZIndex(element.parentElement) : 0;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (_) {
    return 0;
  }
}

export function isPointerCapturedByNonCanvasTarget(event, canvasEl) {
  const target = event?.target;
  const pointerId = event?.pointerId == null ? null : Number(event.pointerId);
  if (!target || !Number.isFinite(pointerId)) return false;
  if (target === canvasEl || canvasEl?.contains?.(target)) return false;
  try {
    return target.hasPointerCapture?.(pointerId) === true;
  } catch (_) {
    return false;
  }
}

export function resolvePointerEvent(event, { respectZIndex = true } = {}) {
  const controller = getCanvasInteractionController();
  const pointerState = controller.getPointerState?.() ?? {};
  const screen = {
    x: typeof event?.clientX === 'number' ? event.clientX : pointerState.screen?.x ?? null,
    y: typeof event?.clientY === 'number' ? event.clientY : pointerState.screen?.y ?? null
  };

  const hasCoords = Number.isFinite(screen.x) && Number.isFinite(screen.y);
  const canvasEl = controller.getCanvasElement?.() ?? null;
  const result = {
    overCanvas: false,
    zOk: false,
    screen: hasCoords ? { ...screen } : null,
    world: null,
    target: null,
    canvas: canvasEl
  };

  if (!hasCoords || !canvasEl || typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
    result.world = hasCoords ? controller.worldFromScreen?.(screen.x, screen.y) ?? null : null;
    return result;
  }

  const ElementCtor = typeof Element === 'undefined' ? null : Element;
  const type = typeof event?.type === 'string' ? event.type.toLowerCase() : '';
  const pointerId = typeof event?.pointerId === 'number' ? event.pointerId : null;

  // Pointer capture intentionally keeps the event target on the control that
  // began the gesture. Do not look through that control and reclassify the
  // event as Canvas input merely because elementFromPoint now finds the board.
  if (isPointerCapturedByNonCanvasTarget(event, canvasEl)) {
    if (pointerId != null && (type === 'pointerup' || type === 'pointercancel')) overlayPointerIds.delete(pointerId);
    result.target = event.target;
    return result;
  }

  const isOverlayElement = (element) => {
    if (!element || !ElementCtor || !(element instanceof ElementCtor)) return false;
    return element.closest?.('[data-fa-nexus-tool-overlay="true"]');
  };

  const target = document.elementFromPoint(screen.x, screen.y);
  result.target = target;
  let overlayTarget = isOverlayElement(target);

  if (pointerId != null) {
    if (type === 'pointerdown') {
      if (overlayTarget) overlayPointerIds.add(pointerId);
      else overlayPointerIds.delete(pointerId);
    } else if (type === 'pointermove') {
      if (!overlayTarget && overlayPointerIds.has(pointerId)) overlayTarget = true;
    } else if (type === 'pointerup' || type === 'pointercancel' || type === 'pointerleave' || type === 'pointerout') {
      if (!overlayTarget && overlayPointerIds.has(pointerId)) overlayTarget = true;
      overlayPointerIds.delete(pointerId);
    }
  }

  if (overlayTarget) {
    result.overCanvas = false;
    result.world = null;
    result.zOk = false;
    return result;
  }
  const overCanvas = !!target && (target === canvasEl || canvasEl.contains(target));
  result.overCanvas = overCanvas;
  result.world = controller.worldFromScreen?.(screen.x, screen.y) ?? null;

  if (!overCanvas) {
    result.zOk = false;
    return result;
  }

  if (respectZIndex === false) {
    result.zOk = true;
  } else {
    const targetZ = getElementZIndex(target);
    const canvasZ = getElementZIndex(canvasEl);
    result.zOk = targetZ <= canvasZ;
  }

  return result;
}

/**
 * Resolve a pointer which already owns an active Canvas gesture. The expensive
 * elementFromPoint/computed-style ownership check was completed on pointer-down;
 * repeating it for every high-polling-rate move only starves the render loop.
 */
export function resolveCapturedPointerEvent(event, { canvas: capturedCanvas = null, rect: capturedRect = null } = {}) {
  const controller = getCanvasInteractionController();
  const screen = {
    x: typeof event?.clientX === 'number' ? event.clientX : null,
    y: typeof event?.clientY === 'number' ? event.clientY : null
  };
  const hasCoords = Number.isFinite(screen.x) && Number.isFinite(screen.y);
  const canvasEl = capturedCanvas || controller.getCanvasElement?.() || null;
  const rect = capturedRect || canvasEl?.getBoundingClientRect?.() || null;
  const withinCanvas = !!(hasCoords && rect
    && screen.x >= rect.left && screen.x <= rect.right
    && screen.y >= rect.top && screen.y <= rect.bottom);
  let world = null;
  if (hasCoords && rect && globalThis.canvas?.stage?.worldTransform?.applyInverse && globalThis.PIXI?.Point) {
    try {
      world = globalThis.canvas.stage.worldTransform.applyInverse(new globalThis.PIXI.Point(
        screen.x - rect.left,
        screen.y - rect.top
      ));
      world = { x: Number(world.x), y: Number(world.y) };
    } catch (_) {
      world = null;
    }
  }
  return {
    overCanvas: withinCanvas,
    zOk: withinCanvas,
    screen: hasCoords ? screen : null,
    world,
    target: canvasEl,
    canvas: canvasEl
  };
}

export function isPointerOverCanvas(event, options) {
  const info = resolvePointerEvent(event, options);
  return !!(info.overCanvas && info.zOk);
}

export { getElementZIndex };
