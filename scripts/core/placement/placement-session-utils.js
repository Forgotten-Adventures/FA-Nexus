import { createCanvasGestureSession } from '../../canvas/canvas-gesture-session.js';
import { NexusLogger as Logger } from '../nexus-logger.js';
import { toolOptionsController } from '../tool-options-controller.js';

export function activatePlacementToolOptions({
  label = '',
  syncToolOptions = null,
  toolId
} = {}) {
  try {
    syncToolOptions?.({ suppressRender: false });
    toolOptionsController.activateTool(toolId, { label });
  } catch (_) {}
}

export function deactivatePlacementToolOptions(toolId) {
  try { toolOptionsController.deactivateTool(toolId); } catch (_) {}
}

export function createManagedPlacementGestureSession(handlers, {
  cancelPlacement = null,
  lockCanvasLayer = null,
  lockTileInteractivity = false,
  onStop = null
} = {}) {
  const sessionOptions = {
    onCanvasTearDown: () => cancelPlacement?.('canvas-teardown'),
    onStop
  };
  if (lockCanvasLayer) sessionOptions.lockCanvasLayer = lockCanvasLayer;
  if (lockTileInteractivity) sessionOptions.lockTileInteractivity = true;
  return createCanvasGestureSession(handlers, sessionOptions);
}

function logPlacementSessionFailure(stage, error) {
  try {
    Logger.error(`PlacementSession.${stage}.failed`, error);
  } catch (_) {
    console.error(`[fa-nexus] PlacementSession.${stage}.failed`, error);
  }
}

export function stopManagedPlacementGestureSession(session, {
  cleanup = null,
  fallback = null,
  reason = 'manual'
} = {}) {
  const runCleanup = () => {
    try { cleanup?.(); } catch (error) { logPlacementSessionFailure('cleanup', error); }
  };
  if (session) {
    try {
      session.stop(reason);
    } catch (error) {
      logPlacementSessionFailure('stop', error);
    }
    runCleanup();
    return true;
  }
  try { fallback?.(); } catch (error) { logPlacementSessionFailure('fallback', error); }
  runCleanup();
  return false;
}
