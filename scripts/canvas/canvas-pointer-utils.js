import { getCanvasInteractionController } from './canvas-interaction-controller.js';

const overlayPointerIds = new Set();

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

export function isPointerOverCanvas(event, options) {
  const info = resolvePointerEvent(event, options);
  return !!(info.overCanvas && info.zOk);
}

export { getElementZIndex };
