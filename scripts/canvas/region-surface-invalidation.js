import { NexusLogger as Logger } from '../core/nexus-logger.js';

const DEFINE_SURFACE_TYPE = 'defineSurface';

let refreshScheduled = false;
let pendingReasons = [];

function stringifyError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.stack || error.message || String(error);
  return String(error);
}

function getSceneForDocument(document) {
  let current = document;
  for (let i = 0; i < 5 && current; i += 1) {
    if (current.documentName === 'Scene') return current;
    current = current.parent ?? current.scene ?? null;
  }
  return null;
}

function hasDefineSurfaceBehavior(region) {
  try {
    return Array.from(region?.behaviors ?? []).some((behavior) => behavior?.type === DEFINE_SURFACE_TYPE);
  } catch (error) {
    Logger.warn?.('RegionSurfaceInvalidation.behaviorScanFailed', {
      regionId: region?.id ?? null,
      error: stringifyError(error)
    });
    return false;
  }
}

function isActiveCanvasScene(scene) {
  return !!scene && !!globalThis.canvas?.ready && globalThis.canvas?.scene?.id === scene.id;
}

function queueSurfaceRefresh(reason, document, details = {}) {
  const scene = getSceneForDocument(document);
  if (!scene) {
    Logger.warn?.('RegionSurfaceInvalidation.sceneMissing', {
      reason,
      documentName: document?.documentName ?? null,
      documentId: document?.id ?? null,
      ...details
    });
    return;
  }
  if (!isActiveCanvasScene(scene)) return;

  pendingReasons.push({
    reason,
    documentName: document?.documentName ?? null,
    documentId: document?.id ?? null,
    ...details
  });
  if (refreshScheduled) return;

  refreshScheduled = true;
  setTimeout(() => {
    refreshScheduled = false;
    const reasons = pendingReasons;
    pendingReasons = [];
    refreshActiveSceneSurfaces(reasons);
  }, 0);
}

function refreshActiveSceneSurfaces(reasons) {
  const activeCanvas = globalThis.canvas;
  const scene = activeCanvas?.scene;
  if (!activeCanvas?.ready || !scene) return;

  try {
    if (typeof scene._invalidateSurfaces !== 'function') {
      Logger.error?.('RegionSurfaceInvalidation.invalidateUnavailable', {
        sceneId: scene.id,
        reasons
      });
      return;
    }

    scene._invalidateSurfaces();
    if (typeof activeCanvas.perception?.update !== 'function') {
      Logger.error?.('RegionSurfaceInvalidation.perceptionUnavailable', {
        sceneId: scene.id,
        reasons
      });
      return;
    }
    activeCanvas.perception.update({
      refreshOcclusion: true,
      refreshOccludedSurfaces: true,
      refreshOcclusionMask: true
    });
    Logger.debug?.('RegionSurfaceInvalidation.refreshed', {
      sceneId: scene.id,
      reasons
    });
  } catch (error) {
    Logger.error?.('RegionSurfaceInvalidation.refreshFailed', {
      sceneId: scene?.id ?? null,
      reasons,
      error: stringifyError(error)
    });
  }
}

function behaviorIsDefineSurface(document, changes = null) {
  return document?.type === DEFINE_SURFACE_TYPE || changes?.type === DEFINE_SURFACE_TYPE;
}

function regionUpdateMayAffectSurfaces(changes = {}) {
  return ['elevation', 'levels', 'shapes', 'hidden'].some((key) => key in changes);
}

function registerRegionSurfaceInvalidationHooks() {
  try {
    Hooks.on('createRegion', (document) => {
      if (hasDefineSurfaceBehavior(document)) queueSurfaceRefresh('createRegion', document);
    });
    Hooks.on('updateRegion', (document, changes) => {
      if (!hasDefineSurfaceBehavior(document)) return;
      if (!regionUpdateMayAffectSurfaces(changes)) return;
      queueSurfaceRefresh('updateRegion', document, { changedKeys: Object.keys(changes ?? {}) });
    });
    Hooks.on('deleteRegion', (document) => {
      queueSurfaceRefresh('deleteRegion', document);
    });

    Hooks.on('createRegionBehavior', (document) => {
      if (behaviorIsDefineSurface(document)) queueSurfaceRefresh('createRegionBehavior', document);
    });
    Hooks.on('updateRegionBehavior', (document, changes) => {
      if (!behaviorIsDefineSurface(document, changes) && !('system' in (changes ?? {}))) return;
      queueSurfaceRefresh('updateRegionBehavior', document, { changedKeys: Object.keys(changes ?? {}) });
    });
    Hooks.on('deleteRegionBehavior', (document) => {
      if (behaviorIsDefineSurface(document)) queueSurfaceRefresh('deleteRegionBehavior', document);
    });
  } catch (error) {
    Logger.error?.('RegionSurfaceInvalidation.registerFailed', { error: stringifyError(error) });
  }
}

registerRegionSurfaceInvalidationHooks();
