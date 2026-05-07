import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG,
  analyzeTileBandState,
  getDefaultTilePlacementLevelId,
  getTileExplicitPlacementLevelId
} from './tile-band-utils.js';
import {
  getRawLevelIds,
  hasOwnLevelField
} from './tile-level-membership.js';

const MODULE_ID = 'fa-nexus';

function isActiveScene(scene) {
  const sceneId = String(scene?.id || '').trim();
  return !!sceneId && sceneId === String(canvas?.scene?.id || '').trim();
}

function setPlacementLevelId(update, levelId, { doc = null } = {}) {
  const normalizedLevelId = String(levelId || '').trim();
  const path = `flags.${MODULE_ID}.${FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG}`;
  foundry.utils.setProperty(update, path, normalizedLevelId);
  if (doc && typeof doc.updateSource === 'function') {
    doc.updateSource({ [path]: normalizedLevelId });
  }
  return update;
}

function buildNextTileData(doc, changes = {}) {
  const source = doc?.toObject ? doc.toObject() : foundry.utils.deepClone(doc?._source ?? {});
  return foundry.utils.mergeObject(source, changes, {
    inplace: false,
    insertKeys: true,
    insertValues: true,
    overwrite: true,
    recursive: true
  });
}

function hasPlacementLevelField(data) {
  if (!data || typeof data !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(data, `flags.${MODULE_ID}.${FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG}`)) return true;
  const moduleFlags = data.flags?.[MODULE_ID];
  return !!(moduleFlags && Object.prototype.hasOwnProperty.call(moduleFlags, FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG));
}

function syncSingleVisibleLevel(update, visibleLevelIds = [], { doc = null, tileId = null, phase = 'unknown' } = {}) {
  const singleLevelId = visibleLevelIds.length === 1 ? String(visibleLevelIds[0] || '').trim() : '';
  if (!singleLevelId) return false;
  setPlacementLevelId(update, singleLevelId, { doc });
  Logger.info('TilePlacementLevel.autoSync.singleLevel', {
    tileId,
    phase,
    placementLevelId: singleLevelId
  });
  return true;
}

function assignCurrentLevelOnCreate(update, {
  doc = null,
  scene = canvas?.scene,
  tileId = null,
  visibleLevelIds = []
} = {}) {
  if (getTileExplicitPlacementLevelId(update)) return false;
  if (!isActiveScene(scene)) {
    Logger.warn('TilePlacementLevel.autoSync.createCurrentLevel.inactiveScene', {
      tileId,
      sceneId: scene?.id || null,
      activeSceneId: canvas?.scene?.id || null,
      visibleLevelIds
    });
    return false;
  }

  const currentLevelId = getDefaultTilePlacementLevelId(scene);
  if (!currentLevelId) {
    Logger.warn('TilePlacementLevel.autoSync.createCurrentLevel.unresolved', {
      tileId,
      sceneId: scene?.id || null,
      visibleLevelIds
    });
    return false;
  }

  setPlacementLevelId(update, currentLevelId, { doc });
  Logger.info('TilePlacementLevel.autoSync.createCurrentLevel', {
    tileId,
    placementLevelId: currentLevelId,
    visibleLevelIds
  });
  return true;
}

function assignCurrentLevelOnVisibleLevelsAdded(update, {
  doc = null,
  nextData = null,
  scene = canvas?.scene,
  tileId = null,
  previousVisibleLevelIds = [],
  nextVisibleLevelIds = []
} = {}) {
  if (!hasOwnLevelField(update)) return false;
  if (hasPlacementLevelField(update)) return false;
  if (getTileExplicitPlacementLevelId(doc) || getTileExplicitPlacementLevelId(update)) return false;
  if (nextData && getTileExplicitPlacementLevelId(nextData)) return false;
  if (previousVisibleLevelIds.length || nextVisibleLevelIds.length <= 1) return false;
  if (!isActiveScene(scene)) {
    Logger.warn('TilePlacementLevel.autoSync.visibleLevelsAdded.inactiveScene', {
      tileId,
      sceneId: scene?.id || null,
      activeSceneId: canvas?.scene?.id || null,
      previousVisibleLevelIds,
      nextVisibleLevelIds
    });
    return false;
  }

  const currentLevelId = getDefaultTilePlacementLevelId(scene);
  if (!currentLevelId) {
    Logger.warn('TilePlacementLevel.autoSync.visibleLevelsAdded.unresolved', {
      tileId,
      sceneId: scene?.id || null,
      previousVisibleLevelIds,
      nextVisibleLevelIds
    });
    return false;
  }

  setPlacementLevelId(update, currentLevelId);
  Logger.info('TilePlacementLevel.autoSync.visibleLevelsAdded', {
    tileId,
    placementLevelId: currentLevelId,
    previousVisibleLevelIds,
    nextVisibleLevelIds
  });
  return true;
}

function autoAssignCurrentLevelForBandEntry(update, analysis, {
  doc = null,
  scene = canvas?.scene,
  tileId = null,
  phase = 'unknown',
  visibleLevelIds = []
} = {}) {
  if (analysis?.placementLevelSource === 'explicit') return false;
  const normalizedVisibleLevelIds = Array.isArray(visibleLevelIds)
    ? visibleLevelIds.map((levelId) => String(levelId || '').trim()).filter(Boolean)
    : [];
  if (normalizedVisibleLevelIds.length > 1) {
    Logger.info('TilePlacementLevel.autoSync.bandEntryBlockedAmbiguous', {
      tileId,
      phase,
      visibleLevelIds: normalizedVisibleLevelIds,
      documentElevation: analysis?.documentElevation ?? null
    });
    return false;
  }
  const currentLevelId = isActiveScene(scene) ? getDefaultTilePlacementLevelId(scene) : null;
  if (!currentLevelId) return false;
  setPlacementLevelId(update, currentLevelId, { doc });
  Logger.info('TilePlacementLevel.autoSync.bandEntry', {
    tileId,
    phase,
    placementLevelId: currentLevelId,
    documentElevation: analysis?.documentElevation ?? null
  });
  return true;
}

function maybeAutoAssignPlacementLevelOnCreate(doc, data = {}, userId) {
  if (userId && userId !== game.user?.id) return;
  const explicitPlacementLevelId = getTileExplicitPlacementLevelId(data);
  if (explicitPlacementLevelId) {
    setPlacementLevelId(data, explicitPlacementLevelId, { doc });
    return;
  }

  const visibleLevelIds = getRawLevelIds(data);
  if (syncSingleVisibleLevel(data, visibleLevelIds, {
    doc,
    tileId: doc?.id || null,
    phase: 'create'
  })) {
    return;
  }

  const scene = doc?.parent || canvas?.scene;
  if (assignCurrentLevelOnCreate(data, {
    doc,
    scene,
    tileId: doc?.id || null,
    visibleLevelIds
  })) {
    return;
  }

  const analysis = analyzeTileBandState(data, {
    scene,
    visibleLevelIds,
    placementLevelId: explicitPlacementLevelId,
    allowSingleLevelInference: false
  });
  if (analysis?.inSpecialBand && !analysis?.canApply) {
    autoAssignCurrentLevelForBandEntry(data, analysis, {
      doc,
      scene,
      tileId: doc?.id || null,
      phase: 'create',
      visibleLevelIds
    });
  }
}

function maybeAutoAssignPlacementLevelOnUpdate(doc, changes = {}, userId) {
  if (!doc || (userId && userId !== game.user?.id)) return;
  const previousVisibleLevelIds = getRawLevelIds(doc);
  const nextData = buildNextTileData(doc, changes);
  const nextVisibleLevelIds = getRawLevelIds(nextData);
  if (syncSingleVisibleLevel(changes, nextVisibleLevelIds, {
    tileId: doc?.id || null,
    phase: 'update'
  })) {
    return;
  }

  const scene = doc?.parent || canvas?.scene;
  if (assignCurrentLevelOnVisibleLevelsAdded(changes, {
    doc,
    nextData,
    scene,
    tileId: doc?.id || null,
    previousVisibleLevelIds,
    nextVisibleLevelIds
  })) {
    return;
  }

  const previousAnalysis = analyzeTileBandState(doc, { scene });
  const nextAnalysis = analyzeTileBandState(nextData, {
    scene,
    visibleLevelIds: nextVisibleLevelIds,
    placementLevelId: getTileExplicitPlacementLevelId(nextData),
    allowSingleLevelInference: false
  });
  const enteringSpecialBand = !previousAnalysis?.inSpecialBand && !!nextAnalysis?.inSpecialBand;
  if (!enteringSpecialBand || nextAnalysis?.canApply) return;
  autoAssignCurrentLevelForBandEntry(changes, nextAnalysis, {
    scene,
    tileId: doc?.id || null,
    phase: 'update',
    visibleLevelIds: nextVisibleLevelIds
  });
}

try {
  Hooks.on('preCreateTile', (doc, data, options, userId) => {
    try {
      maybeAutoAssignPlacementLevelOnCreate(doc, data, userId);
    } catch (error) {
      Logger.warn('TilePlacementLevel.preCreateTile.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
    }
  });

  Hooks.on('preUpdateTile', (doc, changes, options, userId) => {
    try {
      maybeAutoAssignPlacementLevelOnUpdate(doc, changes, userId);
    } catch (error) {
      Logger.warn('TilePlacementLevel.preUpdateTile.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
    }
  });
} catch (error) {
  Logger.warn('TilePlacementLevel.init.failed', {
    error: String(error?.message || error)
  });
}
