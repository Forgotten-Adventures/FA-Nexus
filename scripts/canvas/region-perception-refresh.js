import { NexusLogger as Logger } from '../core/nexus-logger.js';

const ADJUST_DARKNESS_TYPE = 'adjustDarknessLevel';
const ELEVATION_EPSILON = 1e-6;

let refreshScheduled = false;
let waitingForCanvasReady = false;
let pendingReasons = [];

function stringifyError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.stack || error.message || String(error);
  return String(error);
}

function hasLevelChanged(movement) {
  const originLevel = movement?.origin?.level;
  const destinationLevel = movement?.destination?.level;
  return originLevel !== undefined
    && destinationLevel !== undefined
    && originLevel !== destinationLevel;
}

function shouldRefreshAfterMovement(movement, operation) {
  return hasLevelChanged(movement) && operation?.animate === false;
}

function getSceneForTokenDocument(tokenDocument) {
  const scene = tokenDocument?.parent ?? tokenDocument?.scene ?? null;
  return scene?.documentName === 'Scene' ? scene : null;
}

function getSceneForDocument(document) {
  let current = document;
  for (let i = 0; i < 5 && current; i += 1) {
    if (current.documentName === 'Scene') return current;
    current = current.parent ?? current.scene ?? null;
  }
  return null;
}

function buildTokenReason(reason, tokenDocument, movement = null, operation = null, user = null) {
  const scene = getSceneForTokenDocument(tokenDocument);
  if (!scene) {
    Logger.error('RegionPerceptionRefresh.sceneMissing', {
      reason,
      tokenId: tokenDocument?.id ?? null,
      tokenName: tokenDocument?.name ?? null
    });
    return null;
  }

  return {
    reason,
    sceneId: scene.id,
    tokenId: tokenDocument?.id ?? null,
    tokenName: tokenDocument?.name ?? null,
    originLevel: movement?.origin?.level ?? null,
    destinationLevel: movement?.destination?.level ?? null,
    movementMethod: movement?.method ?? null,
    animate: operation?.animate ?? null,
    userId: user?.id ?? null
  };
}

function buildDocumentReason(reason, document, details = {}) {
  const scene = getSceneForDocument(document);
  if (!scene) {
    Logger.error('RegionPerceptionRefresh.documentSceneMissing', {
      reason,
      documentName: document?.documentName ?? null,
      documentId: document?.id ?? null
    });
    return null;
  }

  return {
    reason,
    sceneId: scene.id,
    documentName: document?.documentName ?? null,
    documentId: document?.id ?? null,
    ...details
  };
}

function buildCanvasReason(reason) {
  const activeCanvas = globalThis.canvas;
  const scene = activeCanvas?.scene;
  if (!scene) return null;
  return {
    reason,
    sceneId: scene.id,
    levelId: activeCanvas?.level?.id ?? null
  };
}

function queueRefresh(reason, { waitForCanvasReady = false } = {}) {
  if (!reason) return;
  pendingReasons.push(reason);

  const activeCanvas = globalThis.canvas;
  if (!activeCanvas?.ready || (waitForCanvasReady && activeCanvas.loading)) {
    waitForReadyCanvas();
    return;
  }

  scheduleRefresh();
}

function scheduleRefresh() {
  if (refreshScheduled) return;
  refreshScheduled = true;
  setTimeout(flushPendingRefreshes, 0);
}

function waitForReadyCanvas() {
  if (waitingForCanvasReady) return;
  const hooks = globalThis.Hooks;
  if (typeof hooks?.once !== 'function') {
    Logger.error('RegionPerceptionRefresh.canvasReadyHookUnavailable', { pendingReasons });
    return;
  }

  waitingForCanvasReady = true;
  hooks.once('canvasReady', () => {
    waitingForCanvasReady = false;
    scheduleRefresh();
  });
  Logger.debug('RegionPerceptionRefresh.waitingForCanvasReady', { pendingReasons });
}

function flushPendingRefreshes() {
  refreshScheduled = false;
  if (!pendingReasons.length) return;

  const activeCanvas = globalThis.canvas;
  if (!activeCanvas?.ready) {
    waitForReadyCanvas();
    return;
  }

  const reasons = pendingReasons;
  pendingReasons = [];
  refreshActiveCanvas(activeCanvas, reasons);
}

function collectAffectedTokens(tokenLayer, reasons) {
  if (typeof tokenLayer?.get !== 'function') {
    Logger.error('RegionPerceptionRefresh.tokenLayerGetUnavailable', { reasons });
    return [];
  }

  const byId = new Map();
  for (const reason of reasons) {
    if (!reason.tokenId) continue;
    const token = tokenLayer.get(reason.tokenId);
    if (!token) {
      Logger.debug('RegionPerceptionRefresh.tokenNotRendered', reason);
      continue;
    }
    byId.set(token.document?.id ?? token.id, token);
  }

  for (const token of tokenLayer.controlled ?? []) {
    if (!token) continue;
    byId.set(token.document?.id ?? token.id, token);
  }
  return Array.from(byId.values());
}

function behaviorIsAdjustDarkness(document, changes = null) {
  return document?.type === ADJUST_DARKNESS_TYPE || changes?.type === ADJUST_DARKNESS_TYPE;
}

function regionHasAdjustDarknessBehavior(region) {
  try {
    return Array.from(region?.behaviors ?? []).some((behavior) => behavior?.type === ADJUST_DARKNESS_TYPE);
  } catch (error) {
    Logger.error('RegionPerceptionRefresh.behaviorScanFailed', {
      regionId: region?.id ?? null,
      error: stringifyError(error)
    });
    return false;
  }
}

function regionUpdateMayAffectAdjustDarkness(changes = {}) {
  return ['hidden', 'levels', 'elevation', 'shapes', 'restriction'].some((key) => key in changes);
}

function getRegionDocumentForMesh(mesh) {
  return mesh?.region?.document ?? mesh?.region ?? null;
}

function getBehaviorIdForMesh(mesh) {
  const name = String(mesh?.name ?? '');
  const marker = '.RegionBehavior.';
  if (!name.includes(marker)) return null;
  return name.slice(name.lastIndexOf(marker) + marker.length) || null;
}

function getRegionLevels(region) {
  try {
    const levels = region?.levels;
    if (!levels) return [];
    if (typeof levels === 'string') return levels ? [levels] : [];
    return Array.from(levels)
      .map((level) => String(level?.id ?? level ?? '').trim())
      .filter(Boolean);
  } catch (error) {
    Logger.error('RegionPerceptionRefresh.regionLevelsReadFailed', {
      regionId: region?.id ?? null,
      regionName: region?.name ?? null,
      error: stringifyError(error)
    });
    return null;
  }
}

function getLevelBase(level) {
  const base = Number(level?.elevation?.base ?? level?.elevation?.bottom);
  return Number.isFinite(base) ? base : null;
}

function getLevelTop(level) {
  const top = Number(level?.elevation?.top);
  return Number.isFinite(top) ? top : null;
}

function getSceneLevels(scene) {
  try {
    if (!scene?.levels) return [];
    if (Array.isArray(scene.levels.sorted)) return scene.levels.sorted.filter(Boolean);
    return Array.from(scene.levels).filter(Boolean);
  } catch (error) {
    Logger.error('RegionPerceptionRefresh.sceneLevelsReadFailed', {
      sceneId: scene?.id ?? null,
      sceneName: scene?.name ?? null,
      error: stringifyError(error)
    });
    return [];
  }
}

function getLevelById(scene, levelId) {
  try {
    return scene?.levels?.get?.(levelId) ?? null;
  } catch (error) {
    Logger.error('RegionPerceptionRefresh.levelReadFailed', {
      sceneId: scene?.id ?? null,
      levelId,
      error: stringifyError(error)
    });
    return null;
  }
}

function rangesOverlap(region, level) {
  const regionBottom = Number(region?.elevation?.bottom);
  const regionTop = Number(region?.elevation?.top);
  const levelBottom = getLevelBase(level);
  const levelTop = getLevelTop(level);

  if (!Number.isFinite(regionBottom) || !Number.isFinite(regionTop) || levelBottom == null || levelTop == null) {
    Logger.error('RegionPerceptionRefresh.elevationRangeUnavailable', {
      regionId: region?.id ?? null,
      regionName: region?.name ?? null,
      levelId: level?.id ?? null,
      levelName: level?.name ?? null,
      regionBottom,
      regionTop,
      levelBottom,
      levelTop
    });
    return false;
  }

  const regionTopInclusive = region?.elevation?.topInclusive !== false;
  const regionStartsBeforeLevelEnds = regionBottom < (levelTop + ELEVATION_EPSILON);
  const regionEndsAfterLevelStarts = regionTopInclusive
    ? regionTop >= (levelBottom - ELEVATION_EPSILON)
    : regionTop > (levelBottom + ELEVATION_EPSILON);
  return regionStartsBeforeLevelEnds && regionEndsAfterLevelStarts;
}

function getLevelsInRegionElevationRange(scene, region) {
  return getSceneLevels(scene).filter((level) => rangesOverlap(region, level));
}

function levelCanContributeToView(targetLevel, viewLevel) {
  if (!targetLevel || !viewLevel) return false;
  if (targetLevel.id === viewLevel.id) return true;

  try {
    return viewLevel.visibility?.levels?.has?.(targetLevel.id) === true;
  } catch (error) {
    Logger.error('RegionPerceptionRefresh.levelVisibilityReadFailed', {
      targetLevelId: targetLevel?.id ?? null,
      viewLevelId: viewLevel?.id ?? null,
      error: stringifyError(error)
    });
    return false;
  }
}

function getAdjustDarknessMeshContext(mesh) {
  const region = getRegionDocumentForMesh(mesh);
  if (!region) return null;

  const behaviorId = getBehaviorIdForMesh(mesh);
  if (!behaviorId) return null;

  const behavior = region?.behaviors?.get?.(behaviorId) ?? null;
  if (!behavior || behavior.type !== ADJUST_DARKNESS_TYPE) return null;

  return { region, behavior };
}

function shouldRenderAdjustDarknessMesh(region, behavior, level) {
  if (region?.hidden || behavior?.disabled) return false;

  const levelId = String(level?.id ?? '').trim();
  if (!levelId) {
    Logger.error('RegionPerceptionRefresh.currentLevelUnavailable', {
      regionId: region?.id ?? null,
      regionName: region?.name ?? null,
      behaviorId: behavior?.id ?? null,
      levelId
    });
    return false;
  }

  const regionLevels = getRegionLevels(region);
  if (!regionLevels) return false;
  const scene = region?.parent ?? level?.parent ?? null;
  if (!scene) {
    Logger.error('RegionPerceptionRefresh.sceneUnavailableForMesh', {
      regionId: region?.id ?? null,
      regionName: region?.name ?? null,
      behaviorId: behavior?.id ?? null,
      levelId
    });
    return false;
  }

  if (regionLevels.length) {
    return regionLevels.some((regionLevelId) => {
      const regionLevel = getLevelById(scene, regionLevelId);
      if (!regionLevel) {
        Logger.error('RegionPerceptionRefresh.regionLevelMissing', {
          regionId: region?.id ?? null,
          regionName: region?.name ?? null,
          behaviorId: behavior?.id ?? null,
          regionLevelId,
          sceneId: scene?.id ?? null
        });
        return false;
      }
      return levelCanContributeToView(regionLevel, level);
    });
  }

  const regionLevelsByElevation = getLevelsInRegionElevationRange(scene, region);
  if (!regionLevelsByElevation.length) {
    Logger.error('RegionPerceptionRefresh.regionElevationLevelsMissing', {
      regionId: region?.id ?? null,
      regionName: region?.name ?? null,
      behaviorId: behavior?.id ?? null,
      sceneId: scene?.id ?? null,
      levelId,
      regionBottom: region?.elevation?.bottom ?? null,
      regionTop: region?.elevation?.top ?? null,
      topInclusive: region?.elevation?.topInclusive ?? null
    });
    return false;
  }

  return regionLevelsByElevation.some((regionLevel) => levelCanContributeToView(regionLevel, level));
}

function collectMeshContainerEntries(activeCanvas) {
  return [
    {
      key: 'effects.illumination.darknessLevelMeshes',
      meshes: activeCanvas?.effects?.illumination?.darknessLevelMeshes
    },
    {
      key: 'visibility.vision.light.global.meshes',
      meshes: activeCanvas?.visibility?.vision?.light?.global?.meshes
    }
  ];
}

function iterateMeshes(meshes, key, reasons) {
  if (!meshes) {
    Logger.error('RegionPerceptionRefresh.adjustDarknessMeshContainerMissing', { key, reasons });
    return [];
  }

  try {
    if (typeof meshes[Symbol.iterator] === 'function') return Array.from(meshes);
    if (Array.isArray(meshes.children)) return meshes.children.slice();
  } catch (error) {
    Logger.error('RegionPerceptionRefresh.adjustDarknessMeshContainerReadFailed', {
      key,
      reasons,
      error: stringifyError(error)
    });
    return [];
  }

  Logger.error('RegionPerceptionRefresh.adjustDarknessMeshContainerUnsupported', {
    key,
    reasons,
    type: meshes?.constructor?.name ?? typeof meshes
  });
  return [];
}

function synchronizeAdjustDarknessMeshes(activeCanvas, reasons) {
  const level = activeCanvas?.level ?? null;
  const stats = {
    total: 0,
    active: 0,
    hidden: 0
  };

  for (const { key, meshes } of collectMeshContainerEntries(activeCanvas)) {
    for (const mesh of iterateMeshes(meshes, key, reasons)) {
      const context = getAdjustDarknessMeshContext(mesh);
      if (!context) continue;

      stats.total += 1;
      const render = shouldRenderAdjustDarknessMesh(context.region, context.behavior, level);
      mesh.visible = render;
      mesh.renderable = render;
      if (render) stats.active += 1;
      else stats.hidden += 1;
    }
  }

  return stats;
}

function refreshToken(token, reasons) {
  if (typeof token?.renderFlags?.set !== 'function') {
    Logger.error('RegionPerceptionRefresh.renderFlagsUnavailable', {
      tokenId: token?.document?.id ?? token?.id ?? null,
      reasons
    });
  } else {
    token.renderFlags.set({
      refreshVisibility: true,
      refreshElevation: true,
      refreshState: true,
      refreshRuler: true
    });
  }

  if (typeof token?.initializeSources !== 'function') {
    Logger.error('RegionPerceptionRefresh.initializeSourcesUnavailable', {
      tokenId: token?.document?.id ?? token?.id ?? null,
      reasons
    });
    return;
  }
  token.initializeSources();
}

function applyTokenRenderFlags(token, reasons) {
  if (typeof token?.applyRenderFlags !== 'function') {
    Logger.error('RegionPerceptionRefresh.applyTokenRenderFlagsUnavailable', {
      tokenId: token?.document?.id ?? token?.id ?? null,
      reasons
    });
    return;
  }
  token.applyRenderFlags();
}

function invalidateRegionRenderCaches(activeCanvas, reasons) {
  if (typeof activeCanvas.hidden?.invalidateMasks !== 'function') {
    Logger.error('RegionPerceptionRefresh.invalidateMasksUnavailable', { reasons });
  } else {
    activeCanvas.hidden.invalidateMasks();
  }

  if (typeof activeCanvas.effects?.illumination?.invalidateDarknessLevelContainer !== 'function') {
    Logger.error('RegionPerceptionRefresh.invalidateDarknessUnavailable', { reasons });
  } else {
    activeCanvas.effects.illumination.invalidateDarknessLevelContainer(true);
  }
}

function flushCanvasRender(activeCanvas, tokens, reasons) {
  if (typeof activeCanvas.perception?.applyRenderFlags !== 'function') {
    Logger.error('RegionPerceptionRefresh.applyPerceptionFlagsUnavailable', { reasons });
  } else {
    activeCanvas.perception.applyRenderFlags();
  }

  for (const token of tokens) applyTokenRenderFlags(token, reasons);

  if (typeof activeCanvas.app?.render !== 'function') {
    Logger.error('RegionPerceptionRefresh.canvasRenderUnavailable', { reasons });
    return;
  }
  activeCanvas.app.render();
}

function refreshActiveCanvas(activeCanvas, reasons) {
  const sceneId = activeCanvas?.scene?.id ?? null;
  const activeReasons = reasons.filter((entry) => entry.sceneId === sceneId);
  if (!activeReasons.length) return;

  try {
    const meshStatsBefore = synchronizeAdjustDarknessMeshes(activeCanvas, activeReasons);
    invalidateRegionRenderCaches(activeCanvas, activeReasons);

    const tokens = collectAffectedTokens(activeCanvas.tokens, activeReasons);
    for (const token of tokens) refreshToken(token, activeReasons);

    if (typeof activeCanvas.perception?.update !== 'function') {
      Logger.error('RegionPerceptionRefresh.perceptionUnavailable', { reasons: activeReasons });
      return;
    }

    activeCanvas.perception.update({
      initializeLightSources: true,
      initializeVision: true,
      refreshLighting: true,
      refreshVision: true,
      refreshPrimary: true,
      refreshOcclusion: true,
      refreshSounds: true
    });
    const meshStatsAfter = synchronizeAdjustDarknessMeshes(activeCanvas, activeReasons);
    flushCanvasRender(activeCanvas, tokens, activeReasons);
    Logger.debug('RegionPerceptionRefresh.refreshed', {
      sceneId,
      tokenCount: tokens.length,
      meshStatsBefore,
      meshStatsAfter,
      reasons: activeReasons
    });
  } catch (error) {
    Logger.error('RegionPerceptionRefresh.refreshFailed', {
      sceneId,
      reasons: activeReasons,
      error: stringifyError(error)
    });
  }
}

function registerRegionPerceptionRefreshHooks() {
  try {
    const hooks = globalThis.Hooks;
    if (typeof hooks?.on !== 'function') throw new Error('Foundry Hooks API is unavailable');

    hooks.on('canvasReady', () => {
      queueRefresh(buildCanvasReason('canvasReady'));
    });

    hooks.on('controlToken', (token, controlled) => {
      if (!controlled) return;
      queueRefresh(
        buildTokenReason('controlToken', token?.document),
        { waitForCanvasReady: true }
      );
    });

    hooks.on('moveToken', (tokenDocument, movement, operation, user) => {
      if (!shouldRefreshAfterMovement(movement, operation)) return;
      queueRefresh(
        buildTokenReason('moveToken', tokenDocument, movement, operation, user),
        { waitForCanvasReady: true }
      );
    });

    hooks.on('createRegion', (document) => {
      if (!regionHasAdjustDarknessBehavior(document)) return;
      queueRefresh(buildDocumentReason('createRegion', document));
    });

    hooks.on('updateRegion', (document, changes) => {
      if (!regionHasAdjustDarknessBehavior(document)) return;
      if (!regionUpdateMayAffectAdjustDarkness(changes)) return;
      queueRefresh(buildDocumentReason('updateRegion', document, { changedKeys: Object.keys(changes ?? {}) }));
    });

    hooks.on('deleteRegion', (document) => {
      if (!regionHasAdjustDarknessBehavior(document)) return;
      queueRefresh(buildDocumentReason('deleteRegion', document));
    });

    hooks.on('createRegionBehavior', (document) => {
      if (!behaviorIsAdjustDarkness(document)) return;
      queueRefresh(buildDocumentReason('createRegionBehavior', document));
    });

    hooks.on('updateRegionBehavior', (document, changes) => {
      if (!behaviorIsAdjustDarkness(document, changes)) return;
      if (!['type', 'system', 'disabled'].some((key) => key in (changes ?? {}))) return;
      queueRefresh(buildDocumentReason('updateRegionBehavior', document, { changedKeys: Object.keys(changes ?? {}) }));
    });

    hooks.on('deleteRegionBehavior', (document) => {
      if (!behaviorIsAdjustDarkness(document)) return;
      queueRefresh(buildDocumentReason('deleteRegionBehavior', document));
    });
  } catch (error) {
    Logger.error('RegionPerceptionRefresh.registerFailed', { error: stringifyError(error) });
  }
}

registerRegionPerceptionRefreshHooks();
