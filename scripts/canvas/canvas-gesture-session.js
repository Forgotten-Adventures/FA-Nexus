import { getCanvasInteractionController } from './canvas-interaction-controller.js';
import { resolveCapturedPointerEvent, resolvePointerEvent } from './canvas-pointer-utils.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

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
  let capturedPointerId = null;
  let capturedCanvas = null;
  let capturedRect = null;

  for (const [eventName, spec] of Object.entries(handlerMap)) {
    const lower = eventName.toLowerCase();
    if (!DEFAULT_EVENTS.has(lower)) continue;
    const normalized = normalizeHandlerSpec(spec);
    if (!normalized) continue;
    eventHandlers[lower] = (event, context) => {
      const eventPointerId = event?.pointerId == null ? null : Number(event.pointerId);
      const capturedPointer = capturedPointerId != null
        && (eventPointerId == null || eventPointerId === capturedPointerId)
        && (lower === 'pointermove' || lower === 'pointerup' || lower === 'pointercancel');
      const pointer = capturedPointer
        ? resolveCapturedPointerEvent(event, { canvas: capturedCanvas, rect: capturedRect })
        : resolvePointerEvent(event, { respectZIndex: normalized.respectZIndex });
      try {
        const handled = normalized.handler(event, {
          pointer,
          controllerContext: context,
          controller
        });
        if (lower === 'pointerdown' && handled === true && pointer.overCanvas && pointer.zOk) {
          capturedPointerId = eventPointerId;
          capturedCanvas = pointer.canvas || null;
          try { capturedRect = capturedCanvas?.getBoundingClientRect?.() || null; }
          catch (_) { capturedRect = null; }
        }
        if ((lower === 'pointerup' || lower === 'pointercancel') && capturedPointer) {
          capturedPointerId = null;
          capturedCanvas = null;
          capturedRect = null;
        }
        return handled;
      } catch (err) {
        if (lower === 'pointerup' || lower === 'pointercancel') {
          capturedPointerId = null;
          capturedCanvas = null;
          capturedRect = null;
        }
        Logger.error('CanvasGestureSession.handler.failed', {
          eventName: lower,
          error: err
        });
        if (typeof options.onHandlerError === 'function') {
          try {
            return options.onHandlerError(err, {
              eventName: lower,
              event,
              pointer,
              controllerContext: context,
              controller
            }) === true;
          } catch (handlerError) {
            Logger.error('CanvasGestureSession.handlerErrorCallback.failed', {
              eventName: lower,
              error: handlerError
            });
          }
        }
        return false;
      }
    };
  }

  const session = controller.startSession(eventHandlers, {
    lockTileInteractivity: options.lockTileInteractivity ?? false,
    lockCanvasLayer: options.lockCanvasLayer ?? null,
    lockPlaceableInteractivity: options.lockPlaceableInteractivity ?? false,
    exclusiveInput: options.exclusiveInput ?? false,
    onCanvasTearDown: options.onCanvasTearDown,
    onStop: options.onStop
  });

  return {
    stop(reason = 'manual') {
      try {
        session.stop(reason);
      } catch (error) {
        Logger.error('CanvasGestureSession.stop.failed', {
          reason,
          error
        });
      }
    }
  };
}
