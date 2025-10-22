import { getCanvasInteractionController } from './canvas-interaction-controller.js';
import { resolvePointerEvent } from './canvas-pointer-utils.js';

const DEFAULT_EVENTS = new Set([
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'wheel',
  'contextmenu',
  'keydown',
  'keyup'
]);

function normalizeHandlerSpec(spec) {
  if (typeof spec === 'function') {
    return { handler: spec, respectZIndex: true };
  }
  if (!spec || typeof spec.handler !== 'function') {
    return null;
  }
  return {
    handler: spec.handler,
    respectZIndex: spec.respectZIndex !== undefined ? !!spec.respectZIndex : true
  };
}

export function createCanvasGestureSession(handlerMap = {}, options = {}) {
  const controller = getCanvasInteractionController();
  const eventHandlers = {};

  for (const [eventName, spec] of Object.entries(handlerMap)) {
    const lower = eventName.toLowerCase();
    if (!DEFAULT_EVENTS.has(lower)) continue;
    const normalized = normalizeHandlerSpec(spec);
    if (!normalized) continue;
    eventHandlers[lower] = (event, context) => {
      const pointer = resolvePointerEvent(event, { respectZIndex: normalized.respectZIndex });
      try {
        normalized.handler(event, {
          pointer,
          controllerContext: context,
          controller
        });
      } catch (err) {
        console.error('fa-nexus | canvas gesture handler failed', err);
      }
    };
  }

  const session = controller.startSession(eventHandlers, {
    lockTileInteractivity: options.lockTileInteractivity ?? false,
    lockCanvasLayer: options.lockCanvasLayer ?? null,
    onCanvasTearDown: options.onCanvasTearDown,
    onStop: options.onStop
  });

  return {
    stop(reason = 'manual') {
      try {
        session.stop(reason);
      } catch (_) {
        // no-op
      }
    }
  };
}
