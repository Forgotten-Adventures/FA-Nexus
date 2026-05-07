import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { applyTileHsbcToMesh } from '../textures/texture-blend-runtime.js';
import {
  applyMaskedTilingToTile,
  applyStandardTileMaskToTile
} from '../textures/texture-mask-runtime.js';
import { applyFlattenedChunks } from '../flatten/tile-flatten-chunks.js';
import { applyPathTile } from '../paths/path-tiles.js';
import { applyAssetScatterTile } from '../assets/asset-scatter-geometry.js';
import {
  applyBuildingTile,
  applyDoorFrameTile,
  applyBuildingCompositeTile
} from '../buildings/building-tiles.js';
import { flushAllCustomTileOverheads } from './custom-tile-overhead.js';

const MODULE_ID = 'fa-nexus';
const PATCHED_CAPTURE_SYMBOL = Symbol.for('fa-nexus.sceneTransitionReadiness.capturePatched');
const PATCHED_CANVAS_DRAW_SYMBOL = Symbol.for('fa-nexus.sceneTransitionReadiness.canvasDrawPatched');
const PATCHED_TRANSITION_HOLD_SYMBOL = Symbol.for('fa-nexus.sceneTransitionReadiness.transitionHoldPatched');
const LEVEL_DRAW_HOLD_STATE_KEY = '_faNexusLevelDrawHoldState';
const ORIGINAL_CAPTURE_KEY = '_faNexusOriginalCaptureNextScene';
const ORIGINAL_CANVAS_DRAW_KEY = '_faNexusOriginalCanvasDraw';
const ORIGINAL_CAPTURE_CURRENT_KEY = '_faNexusOriginalCaptureCurrentScene';
const ORIGINAL_TRANSITION_RESET_KEY = '_faNexusOriginalTransitionReset';
const JOB_TIMEOUT_MS = 8000;

let preparePromise = null;
let levelDrawHoldSeq = 0;

function nowMs() {
  try { return globalThis.performance?.now?.() ?? Date.now(); }
  catch (_) { return Date.now(); }
}

function getCanvas() {
  try { return globalThis.canvas || null; }
  catch (_) { return null; }
}

function normalizeId(value) {
  try {
    if (value && typeof value === 'object' && typeof value.id === 'string') return String(value.id).trim();
    return String(value ?? '').trim();
  } catch (_) {
    return '';
  }
}

function publishReadinessState(patch = {}) {
  try {
    const current = globalThis.faNexus?.sceneTransitionReadiness || {};
    globalThis.faNexus = Object.assign(globalThis.faNexus || {}, {
      sceneTransitionReadiness: {
        ...current,
        ...patch
      }
    });
  } catch (_) {}
}

function readFaFlags(doc) {
  try {
    const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
    if (flags && typeof flags === 'object') return flags;
  } catch (_) {}
  return {};
}

function readFaFlag(doc, key) {
  try {
    const direct = doc?.getFlag?.(MODULE_ID, key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  const flags = readFaFlags(doc);
  return flags?.[key];
}

function hasPathPayload(doc) {
  try {
    const pathV2 = readFaFlag(doc, 'pathV2');
    if (pathV2 && Array.isArray(pathV2.controlPoints)) return true;
    const pathsV2 = readFaFlag(doc, 'pathsV2');
    if (pathsV2 && Array.isArray(pathsV2.paths) && pathsV2.paths.length) return true;
    const legacy = readFaFlag(doc, 'path');
    return !!(legacy && typeof legacy === 'object');
  } catch (_) {
    return false;
  }
}

function hasFlattenedChunks(doc) {
  try {
    const flattened = readFaFlag(doc, 'flattened');
    return !!(flattened && Array.isArray(flattened.chunks) && flattened.chunks.length);
  } catch (_) {
    return false;
  }
}

function hasScatterPayload(doc) {
  try {
    const scatter = readFaFlag(doc, 'assetScatter');
    return !!(scatter && typeof scatter === 'object' && Array.isArray(scatter.instances) && scatter.instances.length);
  } catch (_) {
    return false;
  }
}

function hasHsbc(doc) {
  try {
    const flags = readFaFlags(doc);
    return Object.prototype.hasOwnProperty.call(flags, 'hsbc');
  } catch (_) {
    return false;
  }
}

function describeTile(tile) {
  const currentCanvas = getCanvas();
  return {
    tileId: tile?.document?.id || tile?.id || null,
    sceneId: tile?.document?.parent?.id || currentCanvas?.scene?.id || null,
    sceneName: tile?.document?.parent?.name || currentCanvas?.scene?.name || null
  };
}

async function withTimeout(job, label, tile) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(job),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} did not finish within ${JOB_TIMEOUT_MS}ms`));
        }, JOB_TIMEOUT_MS);
      })
    ]);
  } catch (error) {
    Logger.error?.('SceneTransitionReadiness.renderer.failed', {
      renderer: label,
      ...describeTile(tile),
      error: String(error?.message || error)
    });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pushTileJob(jobs, tile, renderer, fn) {
  jobs.push({
    renderer,
    tile,
    run: () => withTimeout(fn, renderer, tile)
  });
}

function collectTileJobs(tile) {
  const jobs = [];
  const doc = tile?.document;
  if (!tile || tile.destroyed || !doc) return jobs;

  if (readFaFlag(doc, 'maskedTiling')) {
    pushTileJob(jobs, tile, 'maskedTiling', () => applyMaskedTilingToTile(tile));
  }
  if (readFaFlag(doc, 'standardTileMask')) {
    pushTileJob(jobs, tile, 'standardTileMask', () => applyStandardTileMaskToTile(tile));
  }
  if (hasFlattenedChunks(doc)) {
    pushTileJob(jobs, tile, 'flattenedChunks', () => applyFlattenedChunks(tile));
  }
  if (hasPathPayload(doc)) {
    pushTileJob(jobs, tile, 'pathTile', () => applyPathTile(tile));
  }
  if (hasScatterPayload(doc)) {
    pushTileJob(jobs, tile, 'assetScatter', () => applyAssetScatterTile(tile));
  }
  if (readFaFlag(doc, 'building')) {
    pushTileJob(jobs, tile, 'buildingTile', () => applyBuildingTile(tile));
  }
  if (readFaFlag(doc, 'buildingDoorFrame')) {
    pushTileJob(jobs, tile, 'buildingDoorFrame', () => applyDoorFrameTile(tile));
  }
  if (readFaFlag(doc, 'buildingComposite')) {
    pushTileJob(jobs, tile, 'buildingComposite', () => applyBuildingCompositeTile(tile));
  }
  if (hasHsbc(doc)) {
    pushTileJob(jobs, tile, 'tileHsbc', () => applyTileHsbcToMesh(tile));
  }

  return jobs;
}

function waitForNextFrame() {
  return new Promise((resolve) => {
    try {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
        return;
      }
    } catch (_) {}
    setTimeout(resolve, 0);
  });
}

function shouldExpectSceneTransitions() {
  try { return !!globalThis.CONFIG?.Canvas?.sceneTransitions; }
  catch (_) { return false; }
}

function hasExplicitTransition(viewOptions) {
  try {
    const transition = viewOptions?.transition || null;
    if (!transition) return false;
    const transitionType = transition.type ?? null;
    return !!(transitionType && globalThis.CONFIG?.Canvas?.sceneTransitions?.[transitionType]);
  } catch (_) {
    return false;
  }
}

function getNextDrawScene(canvasRef, sceneArg) {
  try {
    if (sceneArg !== undefined) return sceneArg;
    return globalThis.game?.scenes?.current || null;
  } catch (_) {
    return null;
  }
}

function getLevelDrawReadinessDetails(canvasRef, sceneArg) {
  try {
    if (!canvasRef?.initialized || !canvasRef?.scene) return null;
    const viewOptions = canvasRef?._viewOptions || {};
    if (!Object.prototype.hasOwnProperty.call(viewOptions, 'level')) return null;
    if (hasExplicitTransition(viewOptions)) return null;

    const currentSceneId = normalizeId(canvasRef.scene?.id);
    const nextScene = getNextDrawScene(canvasRef, sceneArg);
    const nextSceneId = normalizeId(nextScene?.id);
    if (!currentSceneId || !nextSceneId || currentSceneId !== nextSceneId) return null;

    const currentLevelId = normalizeId(canvasRef.level?.id || canvasRef.scene?._view);
    const nextLevelId = normalizeId(viewOptions.level);
    if (!nextLevelId || nextLevelId === currentLevelId) return null;

    return {
      sceneId: currentSceneId,
      sceneName: canvasRef.scene?.name || nextScene?.name || null,
      fromLevelId: currentLevelId || null,
      toLevelId: nextLevelId
    };
  } catch (error) {
    Logger.error?.('SceneTransitionReadiness.levelDraw.inspectFailed', {
      error: String(error?.message || error)
    });
    return null;
  }
}

function isCurrentLevelDraw(canvasRef, details) {
  try {
    if (!canvasRef || !details) return false;
    return normalizeId(canvasRef.scene?.id) === details.sceneId
      && normalizeId(canvasRef.level?.id || canvasRef.scene?._view) === details.toLevelId;
  } catch (_) {
    return false;
  }
}

function beginLevelDrawTransitionHold(canvasRef, details) {
  try {
    const transition = canvasRef?.transition || null;
    if (!transition || !details) return null;
    const state = {
      token: ++levelDrawHoldSeq,
      details,
      deferReset: false,
      releasing: false
    };
    transition[LEVEL_DRAW_HOLD_STATE_KEY] = state;
    return state;
  } catch (error) {
    Logger.error?.('SceneTransitionReadiness.levelDraw.holdBeginFailed', {
      ...details,
      error: String(error?.message || error)
    });
    return null;
  }
}

function releaseLevelDrawTransitionHold(canvasRef, state, reason = 'complete') {
  try {
    const transition = canvasRef?.transition || null;
    if (!transition || !state) return;
    if (transition[LEVEL_DRAW_HOLD_STATE_KEY] !== state) return;
    state.releasing = true;
    transition[LEVEL_DRAW_HOLD_STATE_KEY] = null;
    if (state.deferReset && typeof transition._reset === 'function') {
      transition._reset();
    }
    Logger.debug?.('SceneTransitionReadiness.levelDraw.holdReleased', {
      ...state.details,
      reason
    });
  } catch (error) {
    Logger.error?.('SceneTransitionReadiness.levelDraw.holdReleaseFailed', {
      ...state?.details,
      reason,
      error: String(error?.message || error)
    });
  }
}

async function prepareCustomTileRenderersForLevelDraw(canvasRef, details, holdState = null) {
  if (!canvasRef || !details) return null;
  const started = nowMs();
  try {
    if (!isCurrentLevelDraw(canvasRef, details)) return null;

    Logger.debug?.('SceneTransitionReadiness.levelDraw.prepare.start', details);
    const summary = await prepareCustomTileRenderersForSceneTransition({
      transitionType: 'level-switch'
    });

    if (summary?.failures?.length) {
      Logger.error?.('SceneTransitionReadiness.levelDraw.prepare.failed', {
        ...details,
        failures: summary.failures,
        elapsedMs: Math.round(nowMs() - started)
      });
    } else {
      Logger.debug?.('SceneTransitionReadiness.levelDraw.prepare.done', {
        ...details,
        jobCount: summary?.jobCount ?? 0,
        elapsedMs: Math.round(nowMs() - started)
      });
    }
    return summary;
  } catch (error) {
    Logger.error?.('SceneTransitionReadiness.levelDraw.prepare.crashed', {
      ...details,
      error: String(error?.message || error)
    });
    return null;
  } finally {
    releaseLevelDrawTransitionHold(canvasRef, holdState, 'level-readiness-complete');
  }
}

async function prepareCustomTileRenderersForSceneTransition({ transitionType = null } = {}) {
  if (preparePromise) return preparePromise;

  preparePromise = (async () => {
    const currentCanvas = getCanvas();
    if (!currentCanvas?.ready || !Array.isArray(currentCanvas?.tiles?.placeables)) {
      const summary = {
        ok: true,
        skipped: true,
        reason: 'canvas-not-ready'
      };
      publishReadinessState({ lastSummary: summary });
      return summary;
    }

    const sceneId = currentCanvas?.scene?.id || null;
    const sceneName = currentCanvas?.scene?.name || null;
    const tiles = currentCanvas.tiles.placeables.filter((tile) => tile && !tile.destroyed);
    const jobs = tiles.flatMap((tile) => collectTileJobs(tile));
    if (!jobs.length) {
      const overhead = flushAllCustomTileOverheads('scene-transition-precapture:no-jobs');
      const summary = {
        ok: true,
        sceneId,
        sceneName,
        transitionType,
        tileCount: tiles.length,
        jobCount: 0,
        overhead
      };
      publishReadinessState({ lastSummary: summary });
      return summary;
    }

    const started = nowMs();
    Logger.debug?.('SceneTransitionReadiness.prepare.start', {
      sceneId,
      sceneName,
      transitionType,
      tileCount: tiles.length,
      jobCount: jobs.length
    });

    const settled = await Promise.allSettled(jobs.map((job) => job.run()));
    await waitForNextFrame();
    const overhead = flushAllCustomTileOverheads('scene-transition-precapture');

    const failures = [];
    for (let i = 0; i < settled.length; i += 1) {
      const result = settled[i];
      if (result.status !== 'rejected') continue;
      failures.push({
        renderer: jobs[i]?.renderer || 'unknown',
        tileId: jobs[i]?.tile?.document?.id || jobs[i]?.tile?.id || null,
        error: String(result.reason?.message || result.reason || 'unknown error')
      });
    }

    const elapsedMs = Math.round(nowMs() - started);
    const summary = {
      ok: failures.length === 0,
      sceneId,
      sceneName,
      transitionType,
      tileCount: tiles.length,
      jobCount: jobs.length,
      failures,
      overhead,
      elapsedMs
    };

    if (failures.length) Logger.error?.('SceneTransitionReadiness.prepare.failed', summary);
    else Logger.debug?.('SceneTransitionReadiness.prepare.done', summary);
    publishReadinessState({ lastSummary: summary });
    return summary;
  })().finally(() => {
    preparePromise = null;
  });

  return preparePromise;
}

function patchTransitionCapture() {
  try {
    const currentCanvas = getCanvas();
    const transition = currentCanvas?.transition || null;
    const TransitionContainer = globalThis?.foundry?.canvas?.TransitionContainer
      || transition?.constructor
      || null;
    const prototype = TransitionContainer?.prototype || transition || null;
    if (!prototype || typeof prototype._captureNextScene !== 'function') return false;
    if (prototype[PATCHED_CAPTURE_SYMBOL]) return true;

    const original = prototype._captureNextScene;
    prototype[ORIGINAL_CAPTURE_KEY] = original;
    prototype._captureNextScene = async function faNexusCaptureNextSceneWithReadiness(options = {}) {
      try {
        await prepareCustomTileRenderersForSceneTransition({
          transitionType: options?.transitionType || null
        });
      } catch (error) {
        Logger.error?.('SceneTransitionReadiness.prepare.crashed', {
          sceneId: getCanvas()?.scene?.id || null,
          sceneName: getCanvas()?.scene?.name || null,
          transitionType: options?.transitionType || null,
          error: String(error?.message || error)
        });
      }
      return original.call(this, options);
    };
    prototype[PATCHED_CAPTURE_SYMBOL] = true;

    publishReadinessState({
      prepare: prepareCustomTileRenderersForSceneTransition,
      patched: true
    });

    Logger.debug?.('SceneTransitionReadiness.patch.installed');
    return true;
  } catch (error) {
    Logger.error?.('SceneTransitionReadiness.patch.failed', {
      error: String(error?.message || error)
    });
    return false;
  }
}

function patchTransitionHoldForLevelReadiness() {
  try {
    const currentCanvas = getCanvas();
    const transition = currentCanvas?.transition || null;
    const TransitionContainer = globalThis?.foundry?.canvas?.TransitionContainer
      || transition?.constructor
      || null;
    const prototype = TransitionContainer?.prototype || transition || null;
    if (!prototype) return false;
    if (prototype[PATCHED_TRANSITION_HOLD_SYMBOL]) return true;
    if (typeof prototype._captureCurrentScene !== 'function') return false;
    if (typeof prototype._reset !== 'function') return false;

    const originalCaptureCurrent = prototype._captureCurrentScene;
    const originalReset = prototype._reset;
    prototype[ORIGINAL_CAPTURE_CURRENT_KEY] = originalCaptureCurrent;
    prototype[ORIGINAL_TRANSITION_RESET_KEY] = originalReset;

    prototype._captureCurrentScene = function faNexusCaptureCurrentSceneWithLevelHold(options = {}) {
      const result = originalCaptureCurrent.call(this, options);
      try {
        const state = this[LEVEL_DRAW_HOLD_STATE_KEY] || null;
        if (state && !state.releasing) state.deferReset = true;
      } catch (_) {}
      return result;
    };

    prototype._reset = function faNexusTransitionResetWithLevelHold(...args) {
      try {
        const state = this[LEVEL_DRAW_HOLD_STATE_KEY] || null;
        if (state?.deferReset && !state.releasing) {
          Logger.debug?.('SceneTransitionReadiness.levelDraw.transitionResetDeferred', state.details);
          return;
        }
      } catch (_) {}
      return originalReset.apply(this, args);
    };

    prototype[PATCHED_TRANSITION_HOLD_SYMBOL] = true;
    publishReadinessState({ transitionHoldPatched: true });
    Logger.debug?.('SceneTransitionReadiness.transitionHoldPatch.installed');
    return true;
  } catch (error) {
    Logger.error?.('SceneTransitionReadiness.transitionHoldPatch.failed', {
      error: String(error?.message || error)
    });
    return false;
  }
}

function patchCanvasDrawForLevelReadiness() {
  try {
    const currentCanvas = getCanvas();
    const CanvasClass = globalThis?.foundry?.canvas?.Canvas
      || currentCanvas?.constructor
      || null;
    const prototype = CanvasClass?.prototype || currentCanvas || null;
    if (!prototype || typeof prototype.draw !== 'function') return false;
    if (prototype[PATCHED_CANVAS_DRAW_SYMBOL]) return true;

    const original = prototype.draw;
    prototype[ORIGINAL_CANVAS_DRAW_KEY] = original;
    prototype.draw = async function faNexusDrawWithLevelReadiness(sceneArg) {
      const levelDetails = getLevelDrawReadinessDetails(this, sceneArg);
      const holdState = levelDetails ? beginLevelDrawTransitionHold(this, levelDetails) : null;
      try {
        const result = await original.call(this, sceneArg);
        if (levelDetails) await prepareCustomTileRenderersForLevelDraw(this, levelDetails, holdState);
        return result;
      } catch (error) {
        releaseLevelDrawTransitionHold(this, holdState, 'canvas-draw-error');
        throw error;
      }
    };
    prototype[PATCHED_CANVAS_DRAW_SYMBOL] = true;

    publishReadinessState({
      prepare: prepareCustomTileRenderersForSceneTransition,
      prepareLevelDraw: prepareCustomTileRenderersForLevelDraw,
      canvasDrawPatched: true
    });

    Logger.debug?.('SceneTransitionReadiness.canvasDrawPatch.installed');
    return true;
  } catch (error) {
    Logger.error?.('SceneTransitionReadiness.canvasDrawPatch.failed', {
      error: String(error?.message || error)
    });
    return false;
  }
}

try {
  patchTransitionCapture();
  patchTransitionHoldForLevelReadiness();
  patchCanvasDrawForLevelReadiness();
  Hooks.on('canvasInit', () => {
    if (!patchTransitionCapture()) {
      const details = { reason: 'TransitionContainer._captureNextScene missing during canvasInit' };
      if (shouldExpectSceneTransitions()) Logger.error?.('SceneTransitionReadiness.patch.unavailable', details);
      else Logger.debug?.('SceneTransitionReadiness.patch.unavailable', details);
    }
    if (!patchCanvasDrawForLevelReadiness()) {
      Logger.error?.('SceneTransitionReadiness.canvasDrawPatch.unavailable', {
        reason: 'Canvas.prototype.draw missing during canvasInit'
      });
    }
    if (!patchTransitionHoldForLevelReadiness()) {
      Logger.error?.('SceneTransitionReadiness.transitionHoldPatch.unavailable', {
        reason: 'TransitionContainer hold methods missing during canvasInit'
      });
    }
  });
  Hooks.once('ready', () => {
    if (!patchTransitionCapture()) {
      const details = { reason: 'TransitionContainer._captureNextScene missing during ready' };
      if (shouldExpectSceneTransitions()) Logger.error?.('SceneTransitionReadiness.patch.unavailable', details);
      else Logger.debug?.('SceneTransitionReadiness.patch.unavailable', details);
    }
    if (!patchCanvasDrawForLevelReadiness()) {
      Logger.error?.('SceneTransitionReadiness.canvasDrawPatch.unavailable', {
        reason: 'Canvas.prototype.draw missing during ready'
      });
    }
    if (!patchTransitionHoldForLevelReadiness()) {
      Logger.error?.('SceneTransitionReadiness.transitionHoldPatch.unavailable', {
        reason: 'TransitionContainer hold methods missing during ready'
      });
    }
  });
} catch (error) {
  Logger.error?.('SceneTransitionReadiness.register.failed', {
    error: String(error?.message || error)
  });
}

export {
  prepareCustomTileRenderersForSceneTransition,
  prepareCustomTileRenderersForLevelDraw
};
