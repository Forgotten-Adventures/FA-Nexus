import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  PRESERVE_LINKED_TILE_CLEANUP_OPTION,
  shouldSkipLinkedTileCleanup
} from '../canvas/linked-tile-cleanup-guard.js';

export { PRESERVE_LINKED_TILE_CLEANUP_OPTION };
export const SUPPRESS_FILL_TRIGGERED_BUILDING_CLEANUP_OPTION = 'faNexusSuppressFillTriggeredBuildingCleanup';
export const SKIP_LINKED_BUILDING_FILL_DELETE_OPTION = 'faNexusSkipLinkedBuildingFillDelete';
// Every delete this cascade issues carries this marker. The #101 vanish defect (memory
// building-commit-created-docs-vanish.md) was only attributable because its root deletion carried
// NO fa-nexus option keys — the one signature nothing in this module was supposed to produce, yet
// this file's owner-escalation did exactly that. A cascade delete that names itself can be traced
// across clients; one that does not reads as user intent to every downstream reconciler.
export const BUILDING_LINKED_CLEANUP_DELETE_OPTION = 'faNexusBuildingLinkedCleanup';

const BUILDING_WALL_DELETE_QUEUE = new Map();
const BUILDING_TILE_DELETE_IN_FLIGHT = new Map();
const BUILDING_REGION_DELETE_IN_FLIGHT = new Map();

function resolveLiveSceneDocument(scene = null) {
  const activeScene = canvas?.scene || null;
  const sceneId = scene?.id || scene?._id || null;
  if (sceneId) {
    if (activeScene?.id && String(activeScene.id) === String(sceneId)) return activeScene;
    const worldScene = game?.scenes?.get?.(sceneId) || null;
    if (worldScene) return worldScene;
  }
  return scene || activeScene || null;
}

function readBuildingFlag(doc = null, key = '') {
  try {
    const direct = doc?.getFlag?.('fa-nexus', key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'] || null;
  return flags && key ? (flags[key] ?? null) : null;
}

function readBuildingWallFlag(doc = null) {
  return readBuildingFlag(doc, 'buildingWall');
}

function readBuildingRegionFlag(doc = null) {
  return readBuildingFlag(doc, 'buildingRegion');
}

function isBuildingTileDocument(doc = null) {
  return !!readBuildingFlag(doc, 'building');
}

function isBuildingFillDocument(doc = null) {
  return !!readBuildingFlag(doc, 'buildingFill');
}

// A sill parts container, whether it is the retired legacy composite or the current-state
// managed sills Tile. Both are owned Building outputs, so both follow the same delete cascade.
function isBuildingCompositeSillDocument(doc = null) {
  if (readBuildingFlag(doc, 'buildingSills')) return true;
  const composite = readBuildingFlag(doc, 'buildingComposite');
  return String(composite?.role || '').toLowerCase() === 'sill';
}

export function shouldSkipLinkedBuildingDeletes(doc = null, options = {}) {
  try {
    if (isBuildingFillDocument(doc) && options?.[SUPPRESS_FILL_TRIGGERED_BUILDING_CLEANUP_OPTION]) return true;
    // A Building Edit transaction OWNS the documents it generates for the duration of the Commit.
    // This cascade is a second writer to that state, and it runs ASYNCHRONOUSLY (it yields before
    // deleting), so it lands after the transaction has verified itself and returned: a managed
    // sills Tile created by the same plan that retired the legacy sill was cascaded away, leaving a
    // Commit that reported success with its replacement destroyed. Every option a Building write
    // declares itself with must make this inert — `faNexusBuildingCurrentEdit` is the one every
    // current-state Commit carries, and it was the only one missing here.
    if (
      options?.faNexusSceneGroupDelete
      || options?.faNexusSceneGroupRollback
      || options?.faNexusBuildingEditorDocumentWrite
      || options?.faNexusBuildingCurrentEdit
      || options?.faNexusBuildingCommitMutex
      || options?.faNexusBuildingNativeTransform
      || options?.faNexusBuildingNativeTransformRollback
      || options?.faNexusPreviewDocument
      || options?.faNexusSceneGroupCommand
    ) return true;
    const documentUuid = String(doc?.uuid || '').trim();
    const registry = doc?.parent?.getFlag?.('fa-nexus', 'compositionRegistry') || null;
    if (documentUuid && (Array.isArray(registry?.relationships) ? registry.relationships : []).some((relationship) => (
      String(relationship?.ownerUuid || '').trim() === documentUuid
      && String(relationship?.type || '').trim() === 'generated-by'
      && String(relationship?.generator || '').trim() === 'building'
    ))) return true;
    return shouldSkipLinkedTileCleanup(doc, options, { includeBuildingSuppression: true });
  } catch (error) {
    // FAIL CLOSED: an unreadable registry means ownership of this document is UNKNOWN, and a
    // cascade that proceeds anyway is exactly how a Commit's generated documents get destroyed
    // behind a live owner. Skipping the cascade is the safe refusal, and it is observable.
    Logger.warn?.('BuildingLinkedCleanup.shouldSkipLinkedBuildingDeletes.failedClosed', {
      documentUuid: String(doc?.uuid || ''),
      error: String(error?.message || error)
    });
    return true;
  }
}

// #101 OWNER-LIVENESS RULE: a current-state managed document (managed sills Tile, managed Fill,
// managed Region) may only be cleaned up when its owning Building root is actually GONE. While the
// owner root is live in the Scene, these documents are the Building's OUTPUTS — deleting them
// behind a live owner is exactly how a Commit's freshly created sills Tile was destroyed moments
// after the Commit verified it (memory building-commit-created-docs-vanish.md). Returns the live
// owner root Tile id when the document is protected, null when cleanup may proceed.
//
// LIVENESS is membership of the Scene collection. Foundry's `document._destroyed` is not that
// test: it is set when a placeable is destroyed and stays set after the canvas draws the
// document again, so after a Level switch or a return to the Scene every live document carries
// it. Reading it as deletion voided this rule and made the cascade skip linked Tiles and Regions.
const MANAGED_DEPENDENT_FLAG_KEYS = Object.freeze(['buildingSills', 'buildingFill', 'buildingRegion']);

function resolveLiveManagedOwnerTileId(scene, doc) {
  for (const flagKey of MANAGED_DEPENDENT_FLAG_KEYS) {
    const flag = readBuildingFlag(doc, flagKey);
    if (!flag) continue;
    const ownerTileId = String(flag?.wallTileId || '').trim();
    if (!ownerTileId) continue;
    const owner = scene?.tiles?.get?.(ownerTileId) || null;
    if (owner && readBuildingFlag(owner, 'building')) return ownerTileId;
  }
  return null;
}

// Partition candidate ids into deletable ids and observably refused live-owner protections.
function partitionManagedDependents(scene, collection, ids, logCode) {
  const refused = [];
  const deletableIds = (Array.isArray(ids) ? ids : []).filter((id) => {
    const doc = collection?.get?.(id) || null;
    const ownerTileId = doc ? resolveLiveManagedOwnerTileId(scene, doc) : null;
    if (!ownerTileId) return true;
    refused.push({ id, ownerTileId });
    return false;
  });
  if (refused.length) {
    Logger.warn?.('BuildingTiles.delete.managedDependentRefused', {
      logCode,
      sceneId: scene?.id || null,
      refused,
      reason: 'These documents are current-state managed outputs of a Building whose root is still'
        + ' live in the Scene. Linked cleanup only removes documents whose owner is actually gone.'
    });
  }
  return deletableIds;
}

function sleep(ms = 60) {
  if (foundry?.utils?.sleep) return foundry.utils.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSceneQueueKey(scene) {
  if (!scene) return null;
  return scene.uuid || scene.id || null;
}

function isMissingEmbeddedDocumentError(error) {
  return String(error?.message || error).includes('does not exist');
}

function hasEmbeddedSourceDocument(scene, type, id) {
  const documentId = String(id || '').trim();
  if (!scene || !documentId) return null;
  const sourceKey = type === 'Tile' ? 'tiles' : type === 'Wall' ? 'walls' : null;
  if (!sourceKey) return null;
  const source = scene?._source?.[sourceKey];
  if (!Array.isArray(source)) return null;
  return source.some((entry) => String(entry?._id || entry?.id || '').trim() === documentId);
}

async function deleteWallsRobustly(scene, wallIds = [], logCode = 'BuildingTiles.delete.walls') {
  const requestedIds = Array.from(new Set(
    (Array.isArray(wallIds) ? wallIds : []).filter(Boolean)
  ));
  if (!scene || !requestedIds.length) return;
  const liveScene = resolveLiveSceneDocument(scene);
  const collectExistingIds = (targetScene, ids) => {
    const collection = targetScene?.walls;
    return (Array.isArray(ids) ? ids : []).filter((wallId) => {
      if (!wallId) return false;
      return !!collection?.get?.(wallId) || hasEmbeddedSourceDocument(targetScene, 'Wall', wallId);
    });
  };
  const normalizeDeletedIds = (deleted) => Array.from(new Set(
    (Array.isArray(deleted) ? deleted : []).map((entry) => {
      if (typeof entry === 'string') return entry;
      return entry?.id || entry?._id || null;
    }).filter(Boolean)
  ));
  const errors = [];
  const deletedIds = new Set();

  // Tile delete hooks can fire while Foundry is still reconciling document collections.
  // Yield once so linked wall cleanup runs against settled scene state.
  await sleep(75);

  const existingIds = collectExistingIds(liveScene, requestedIds);
  const missingCollectionIds = requestedIds.filter((wallId) => !existingIds.includes(wallId));
  if (missingCollectionIds.length) {
    Logger.debug?.(`${logCode}.collectionMissingBeforeDelete`, {
      sceneId: liveScene?.id || null,
      sceneName: liveScene?.name || null,
      requestedIds,
      existingIds,
      missingCollectionIds,
      viewedLevelId: canvas?.scene?.id === liveScene?.id ? (canvas?.scene?._view || null) : null
    });
  }

  Logger.debug?.(`${logCode}.deleteAttempt`, {
    sceneId: liveScene?.id || null,
    sceneName: liveScene?.name || null,
    requestedIds,
    existingIds,
    viewedLevelId: canvas?.scene?.id === liveScene?.id ? (canvas?.scene?._view || null) : null
  });

  try {
    const deleted = await liveScene.deleteEmbeddedDocuments('Wall', requestedIds, {
      [BUILDING_LINKED_CLEANUP_DELETE_OPTION]: true
    });
    for (const wallId of normalizeDeletedIds(deleted)) deletedIds.add(wallId);
  } catch (error) {
    const message = String(error?.message || error);
    if (isMissingEmbeddedDocumentError(error) && existingIds.length) {
      try {
        const deleted = await liveScene.deleteEmbeddedDocuments('Wall', existingIds, {
          [BUILDING_LINKED_CLEANUP_DELETE_OPTION]: true
        });
        for (const wallId of normalizeDeletedIds(deleted)) deletedIds.add(wallId);
      } catch (retryError) {
        const retryMessage = String(retryError?.message || retryError);
        if (!isMissingEmbeddedDocumentError(retryError)) {
          errors.push({ phase: 'initialExistingBatch', error: retryMessage, wallIds: existingIds });
        }
      }
    } else if (!isMissingEmbeddedDocumentError(error)) {
      errors.push({ phase: 'initialBatch', error: message, wallIds: requestedIds });
    }
  }

  await sleep(50);
  let survivingIds = collectExistingIds(liveScene, requestedIds);

  if (survivingIds.length) {
    Logger.warn?.(`${logCode}.survivorsAfterBatch`, {
      sceneId: liveScene?.id || null,
      sceneName: liveScene?.name || null,
      requestedIds,
      existingIds,
      deletedIds: [...deletedIds],
      survivingIds
    });
    try {
      // No `noHook` here — EVER. A hook-suppressed delete is invisible to every observer this
      // module's own defect investigation depends on (#101): pre-delete guards cannot veto it and
      // session-initiator tracking cannot see it. If a pre-delete hook vetoes this retry, that veto
      // is a protection speaking, not an obstacle to silence.
      const retried = await liveScene.deleteEmbeddedDocuments('Wall', survivingIds, {
        [BUILDING_LINKED_CLEANUP_DELETE_OPTION]: true
      });
      for (const wallId of normalizeDeletedIds(retried)) deletedIds.add(wallId);
    } catch (error) {
      const message = String(error?.message || error);
      if (!isMissingEmbeddedDocumentError(error)) {
        errors.push({ phase: 'retryNoHook', error: message, wallIds: survivingIds });
      }
    }
    await sleep(50);
    survivingIds = collectExistingIds(liveScene, requestedIds);
  }

  if (errors.length) {
    Logger.warn?.(`${logCode}.failed`, {
      sceneId: liveScene?.id || null,
      sceneName: liveScene?.name || null,
      requestedIds,
      deletedIds: [...deletedIds],
      survivingIds,
      errors
    });
  }
  if (survivingIds.length) {
    Logger.error?.(`${logCode}.persisted`, {
      sceneId: liveScene?.id || null,
      sceneName: liveScene?.name || null,
      requestedIds,
      deletedIds: [...deletedIds],
      survivingIds
    });
  } else {
    Logger.debug?.(`${logCode}.complete`, {
      sceneId: liveScene?.id || null,
      sceneName: liveScene?.name || null,
      requestedIds,
      deletedIds: [...deletedIds]
    });
  }
}

function queueWallDeletes(scene, wallIds = [], logCode = 'BuildingTiles.delete.walls') {
  const uniqueIds = Array.from(new Set(
    (Array.isArray(wallIds) ? wallIds : []).filter(Boolean)
  ));
  if (!scene || !uniqueIds.length) return Promise.resolve();
  const queueKey = getSceneQueueKey(scene);
  if (!queueKey) return deleteWallsRobustly(scene, uniqueIds, logCode);
  let entry = BUILDING_WALL_DELETE_QUEUE.get(queueKey);
  if (!entry) {
    entry = {
      scene,
      wallIds: new Set(),
      logCode,
      task: null
    };
    BUILDING_WALL_DELETE_QUEUE.set(queueKey, entry);
  }
  entry.scene = scene;
  entry.logCode = logCode || entry.logCode;
  for (const wallId of uniqueIds) entry.wallIds.add(wallId);
  if (entry.task) return entry.task;
  entry.task = (async () => {
    await sleep(150);
    while (entry.wallIds.size) {
      const pendingIds = Array.from(entry.wallIds);
      entry.wallIds.clear();
      await deleteWallsRobustly(entry.scene, pendingIds, entry.logCode);
      if (entry.wallIds.size) await sleep(75);
    }
  })().finally(() => {
    BUILDING_WALL_DELETE_QUEUE.delete(queueKey);
  });
  return entry.task;
}

function resolveBuildingCleanupTargets(doc, scene = null) {
  try {
    const buildingData = readBuildingFlag(doc, 'building');
    if (buildingData) return [{ doc, data: buildingData }];
    const isFill = !!readBuildingFlag(doc, 'buildingFill');
    const isSill = isBuildingCompositeSillDocument(doc);
    if (!isFill && !isSill) return [];
    const resolvedScene = resolveLiveSceneDocument(scene || doc.parent || canvas?.scene);
    if (!resolvedScene?.tiles?.size) return [];
    const targets = [];
    const composite = isSill
      ? (readBuildingFlag(doc, 'buildingSills') || readBuildingFlag(doc, 'buildingComposite'))
      : null;
    const explicitWallTileId = String(composite?.wallTileId || '').trim();
    if (explicitWallTileId) {
      const owner = resolvedScene.tiles?.get?.(explicitWallTileId) || null;
      const ownerData = readBuildingFlag(owner, 'building');
      if (ownerData) targets.push({ doc: owner, data: ownerData });
    }
    for (const tileDoc of resolvedScene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      const data = readBuildingFlag(tileDoc, 'building');
      if (!data) continue;
      const fillTileId = data?.meta?.fillTileId || null;
      const sillTileId = data?.meta?.sillsTileId || data?.meta?.sillTileId
        || data?.meta?.composite?.sillTileId || null;
      if (isFill && fillTileId === doc.id) targets.push({ doc: tileDoc, data });
      else if (isSill && sillTileId === doc.id && !targets.some((target) => target?.doc?.id === tileDoc.id)) {
        targets.push({ doc: tileDoc, data });
      }
    }
    return targets;
  } catch (_) {
    return [];
  }
}

function resolveBuildingWallTileGroupId(tileDoc) {
  try {
    const building = readBuildingFlag(tileDoc, 'building');
    if (!building) return null;
    return building?.meta?.wallGroupId || building?.wall?.wallGroupId || null;
  } catch (_) {
    return null;
  }
}

function summarizeSceneBuildingWallCandidates(scene, { tileId = null, groupId = null, wallIds = [] } = {}) {
  const walls = scene?.walls || null;
  const wallIdSet = new Set((Array.isArray(wallIds) ? wallIds : []).filter(Boolean));
  const summary = {
    buildingWallCount: 0,
    tileMatches: [],
    groupMatches: [],
    wallIdMatches: []
  };
  if (!walls?.size) return summary;
  for (const wall of walls) {
    if (!wall?.id) continue;
    const flag = readBuildingWallFlag(wall);
    if (!flag) continue;
    summary.buildingWallCount += 1;
    const entry = {
      id: wall.id,
      tileId: flag.tileId || null,
      groupId: flag.groupId || null,
      levels: Array.isArray(wall.levels) ? wall.levels : Array.from(wall.levels || wall._source?.levels || [])
    };
    if (tileId && flag.tileId === tileId) summary.tileMatches.push(entry);
    if (groupId && flag.groupId === groupId) summary.groupMatches.push(entry);
    if (wallIdSet.has(wall.id)) summary.wallIdMatches.push(entry);
  }
  return summary;
}

async function deleteLinkedTilesRobustly(scene, tileIds = [], options = null, logCode = 'BuildingTiles.delete.tiles') {
  const uniqueIds = Array.from(new Set(
    (Array.isArray(tileIds) ? tileIds : []).filter(Boolean)
  ));
  if (!scene || !uniqueIds.length) return false;
  const liveScene = resolveLiveSceneDocument(scene);
  if (!liveScene) return false;
  const queueKey = getSceneQueueKey(liveScene);
  let inFlightIds = null;
  if (queueKey) {
    inFlightIds = BUILDING_TILE_DELETE_IN_FLIGHT.get(queueKey);
    if (!inFlightIds) {
      inFlightIds = new Set();
      BUILDING_TILE_DELETE_IN_FLIGHT.set(queueKey, inFlightIds);
    }
  }
  const requestedIds = uniqueIds.filter((tileId) => {
    if (!inFlightIds) return true;
    if (inFlightIds.has(tileId)) return false;
    inFlightIds.add(tileId);
    return true;
  });
  const duplicateInFlightIds = uniqueIds.filter((tileId) => !requestedIds.includes(tileId));
  if (duplicateInFlightIds.length) {
    Logger.debug?.(`${logCode}.duplicateInFlightSkipped`, {
      sceneId: liveScene?.id || null,
      sceneName: liveScene?.name || null,
      requestedIds: uniqueIds,
      duplicateInFlightIds
    });
  }
  if (!requestedIds.length) return false;

  try {
    // Delete hooks may chain while Foundry is still removing placeables. Yield once
    // and only ask Foundry to delete IDs still present in the embedded collection.
    await sleep(50);
    const collection = liveScene.tiles;
    const existingIds = requestedIds.filter((tileId) => !!collection?.get?.(tileId));
    const missingCollectionIds = requestedIds.filter((tileId) => !existingIds.includes(tileId));
    if (missingCollectionIds.length) {
      Logger.debug?.(`${logCode}.collectionMissingBeforeDelete`, {
        sceneId: liveScene?.id || null,
        sceneName: liveScene?.name || null,
        requestedIds,
        existingIds,
        missingCollectionIds,
        viewedLevelId: canvas?.scene?.id === liveScene?.id ? (canvas?.scene?._view || null) : null
      });
    }
    if (!existingIds.length) return false;
    const deletableIds = partitionManagedDependents(liveScene, collection, existingIds, logCode);
    if (!deletableIds.length) return false;
    await liveScene.deleteEmbeddedDocuments('Tile', deletableIds, {
      [BUILDING_LINKED_CLEANUP_DELETE_OPTION]: true,
      ...(options || {})
    });
    return true;
  } catch (error) {
    if (isMissingEmbeddedDocumentError(error)) {
      Logger.debug?.(`${logCode}.alreadyMissingDuringDelete`, {
        error: String(error?.message || error),
        tileIds: requestedIds
      });
      return false;
    }
    Logger.warn?.(`${logCode}.failed`, {
      error: String(error?.message || error),
      tileIds: requestedIds
    });
    return false;
  } finally {
    if (inFlightIds) {
      for (const tileId of requestedIds) inFlightIds.delete(tileId);
      if (!inFlightIds.size && queueKey) BUILDING_TILE_DELETE_IN_FLIGHT.delete(queueKey);
    }
  }
}

async function deleteLinkedFillAndWalls(doc, { scene = null, data = null, options = null } = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const buildingData = data ?? readBuildingFlag(doc, 'building');
    if (!buildingData) return;
    const resolvedScene = resolveLiveSceneDocument(scene || doc.parent || canvas?.scene);
    if (!resolvedScene) return;
    const meta = buildingData?.meta || {};
    const fillTileId = meta?.fillTileId;
    if (fillTileId && fillTileId !== doc.id && !options?.[SKIP_LINKED_BUILDING_FILL_DELETE_OPTION]) {
      await deleteLinkedTilesRobustly(resolvedScene, [fillTileId], {
        [SUPPRESS_FILL_TRIGGERED_BUILDING_CLEANUP_OPTION]: true
      }, 'BuildingTiles.delete.fill');
    }
    const sillTileId = meta?.sillTileId || meta?.composite?.sillTileId || null;
    if (sillTileId && sillTileId !== doc.id) {
      await deleteLinkedTilesRobustly(resolvedScene, [sillTileId], {
        [PRESERVE_LINKED_TILE_CLEANUP_OPTION]: true
      }, 'BuildingTiles.delete.sillComposite');
    }
    // NOTE: We intentionally do NOT use meta.wallIds here, as those can be stale.
    // When multiple islands are committed, wall IDs may get reassigned to different
    // tiles during _assignWallsToCommittedIslands. The meta.wallIds stored at commit
    // time may contain walls that were later claimed by other islands.
    // Instead, we rely exclusively on the wall's actual flag.tileId and flag.groupId
    // which are the authoritative sources after commit.
    const wallIds = new Set();
    const staleWallLinks = [];
    const groupId = meta?.wallGroupId || null;
    const collection = resolvedScene.walls;
    if (collection?.size) {
      for (const wall of collection) {
        if (!wall) continue;
        const flag = readBuildingWallFlag(wall);
        if (!flag) continue;
        // Only delete walls where the flag actually points to this tile
        if (flag.tileId === doc.id) {
          wallIds.add(wall.id);
          continue;
        }
        if (!groupId || flag.groupId !== groupId) continue;
        if (!flag.tileId) {
          // Also catch walls that have our groupId but no specific tileId
          // (e.g., from interrupted commits or legacy data)
          wallIds.add(wall.id);
          continue;
        }

        const linkedTile = resolvedScene.tiles?.get?.(flag.tileId) || null;
        const linkedGroupId = resolveBuildingWallTileGroupId(linkedTile);
        if (!linkedTile || linkedGroupId !== groupId) {
          wallIds.add(wall.id);
          staleWallLinks.push({
            wallId: wall.id,
            staleTileId: flag.tileId,
            flagGroupId: flag.groupId || null,
            linkedGroupId: linkedGroupId || null,
            deletingTileId: doc.id
          });
        }
      }
    }
    if (staleWallLinks.length) {
      Logger.warn?.('BuildingTiles.delete.walls.staleTileLinks', {
        tileId: doc.id,
        wallGroupId: groupId,
        staleWallLinks
      });
    }
    const expectedWallIds = Array.isArray(meta?.wallIds) ? meta.wallIds.filter(Boolean) : [];
    if (!wallIds.size) {
      const fallbackWallIds = [];
      const skippedFallbackWallIds = [];
      for (const wallId of expectedWallIds) {
        const wall = collection?.get?.(wallId) || null;
        const flag = readBuildingWallFlag(wall);
        if (!wall || !flag) {
          fallbackWallIds.push(wallId);
          continue;
        }
        const flagGroupId = flag.groupId || null;
        const linkedTile = flag.tileId ? (resolvedScene.tiles?.get?.(flag.tileId) || null) : null;
        const linkedGroupId = resolveBuildingWallTileGroupId(linkedTile);
        const safeToDelete = flag.tileId === doc.id
          || (!!groupId && flagGroupId === groupId)
          || !flag.tileId
          || !linkedTile
          || (!!groupId && linkedGroupId !== groupId);
        if (safeToDelete) {
          fallbackWallIds.push(wallId);
        } else {
          skippedFallbackWallIds.push({
            wallId,
            claimedTileId: flag.tileId || null,
            flagGroupId,
            linkedGroupId: linkedGroupId || null
          });
        }
      }
      if (fallbackWallIds.length) {
        for (const wallId of fallbackWallIds) wallIds.add(wallId);
        Logger.warn?.('BuildingTiles.delete.walls.usingStoredFallbackIds', {
          tileId: doc.id,
          sceneId: resolvedScene?.id || null,
          sceneName: resolvedScene?.name || null,
          wallGroupId: groupId,
          fallbackWallIds,
          skippedFallbackWallIds
        });
      }
    }
    if (!wallIds.size) {
      if (groupId || expectedWallIds.length) {
        Logger.warn?.('BuildingTiles.delete.walls.missingLinkedWalls', {
          tileId: doc.id,
          sceneId: resolvedScene?.id || null,
          sceneName: resolvedScene?.name || null,
          wallGroupId: groupId,
          expectedWallIds,
          candidates: summarizeSceneBuildingWallCandidates(resolvedScene, {
            tileId: doc.id,
            groupId,
            wallIds: expectedWallIds
          })
        });
      }
      return;
    }
    Logger.debug?.('BuildingTiles.delete.walls.start', {
      tileId: doc.id,
      sceneId: resolvedScene?.id || null,
      sceneName: resolvedScene?.name || null,
      wallGroupId: groupId,
      wallIds: [...wallIds],
      expectedWallIds: Array.isArray(meta?.wallIds) ? meta.wallIds.filter(Boolean) : []
    });
    await queueWallDeletes(resolvedScene, [...wallIds], 'BuildingTiles.delete.walls');
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function deleteLinkedDoorFrameTiles(doc, { scene = null, data = null } = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const buildingData = data ?? readBuildingFlag(doc, 'building');
    if (!buildingData) return;
    const resolvedScene = resolveLiveSceneDocument(scene || doc.parent || canvas?.scene);
    if (!resolvedScene?.tiles?.size) return;
    const meta = buildingData?.meta || {};
    const wallGroupId = meta?.wallGroupId || null;
    if (!wallGroupId) return;
    const frameTileIds = [];
    for (const tileDoc of resolvedScene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      const flag = readBuildingFlag(tileDoc, 'buildingDoorFrame');
      if (flag?.wallGroupId === wallGroupId) {
        frameTileIds.push(tileDoc.id);
      }
    }
    if (!frameTileIds.length) return;
    await deleteLinkedTilesRobustly(resolvedScene, frameTileIds, null, 'BuildingTiles.delete.doorFrames');
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.doorFrames.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function deleteLinkedWindowTiles(doc, { scene = null, data = null } = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const buildingData = data ?? readBuildingFlag(doc, 'building');
    if (!buildingData) return;
    const resolvedScene = resolveLiveSceneDocument(scene || doc.parent || canvas?.scene);
    if (!resolvedScene?.tiles?.size) return;
    const meta = buildingData?.meta || {};
    const wallGroupId = meta?.wallGroupId || null;
    if (!wallGroupId) return;
    const windowTileIds = [];
    for (const tileDoc of resolvedScene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      // Check for window sill, window texture, or window frame tiles
      const sillFlag = readBuildingFlag(tileDoc, 'buildingWindowSill');
      const windowFlag = readBuildingFlag(tileDoc, 'buildingWindowWindow');
      const frameFlag = readBuildingFlag(tileDoc, 'buildingWindowFrame');
      const flag = sillFlag || windowFlag || frameFlag;
      if (flag?.wallGroupId === wallGroupId) {
        windowTileIds.push(tileDoc.id);
      }
    }
    if (!windowTileIds.length) return;
    await deleteLinkedTilesRobustly(resolvedScene, windowTileIds, null, 'BuildingTiles.delete.windowTiles');
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.windowTiles.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function deleteLinkedInnerWallTiles(doc, { scene = null, data = null } = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const buildingData = data ?? readBuildingFlag(doc, 'building');
    if (!buildingData) return;
    const resolvedScene = resolveLiveSceneDocument(scene || doc.parent || canvas?.scene);
    if (!resolvedScene?.tiles?.size) return;
    const meta = buildingData?.meta || {};
    // Only outer wall tiles should cascade delete their inner walls
    const wallType = meta?.wallType || buildingData?.wall?.mode;
    if (wallType === 'inner') return;
    const wallGroupId = meta?.wallGroupId || null;
    const innerWallTileIds = [];
    for (const tileDoc of resolvedScene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      const innerData = readBuildingFlag(tileDoc, 'building');
      if (!innerData) continue;
      const innerMeta = innerData.meta || {};
      const innerWallType = innerMeta?.wallType || innerData?.wall?.mode;
      // Only consider inner wall tiles
      if (innerWallType !== 'inner') continue;
      // Check if this inner tile is linked to the deleted outer tile
      const matchesTileId = innerMeta.parentWallTileId === doc.id;
      const matchesGroupId = wallGroupId && innerMeta.parentWallGroupId === wallGroupId;
      if (matchesTileId || matchesGroupId) {
        innerWallTileIds.push(tileDoc.id);
      }
    }
    if (!innerWallTileIds.length) return;
    await deleteLinkedTilesRobustly(resolvedScene, innerWallTileIds, null, 'BuildingTiles.delete.innerWallTiles');
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.innerWallTiles.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function deleteLinkedBuildingRegions(doc, { scene = null, data = null } = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const buildingData = data ?? readBuildingFlag(doc, 'building');
    if (!buildingData) return;
    const resolvedScene = resolveLiveSceneDocument(scene || doc.parent || canvas?.scene);
    if (!resolvedScene?.regions?.size) return;
    const meta = buildingData?.meta || {};
    const explicitRegionIds = new Set((Array.isArray(meta?.regionIds) ? meta.regionIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean));
    const wallGroupId = String(meta?.wallGroupId || '').trim();
    const regionIds = new Set();
    for (const regionDoc of resolvedScene.regions) {
      if (!regionDoc) continue;
      const flag = readBuildingRegionFlag(regionDoc);
      if (!flag) continue;
      const regionId = String(regionDoc.id || '').trim();
      const matchesExplicit = regionId && explicitRegionIds.has(regionId);
      const matchesWallTile = String(flag?.wallTileId || '').trim() === doc.id;
      const matchesWallGroup = !!wallGroupId && String(flag?.wallGroupId || '').trim() === wallGroupId;
      if (matchesExplicit || matchesWallTile || matchesWallGroup) regionIds.add(regionId);
    }
    if (!regionIds.size) return;
    const queueKey = getSceneQueueKey(resolvedScene);
    let inFlightIds = null;
    if (queueKey) {
      inFlightIds = BUILDING_REGION_DELETE_IN_FLIGHT.get(queueKey);
      if (!inFlightIds) {
        inFlightIds = new Set();
        BUILDING_REGION_DELETE_IN_FLIGHT.set(queueKey, inFlightIds);
      }
    }
    const requestedIds = [...regionIds].filter((regionId) => {
      if (!inFlightIds) return true;
      if (inFlightIds.has(regionId)) return false;
      inFlightIds.add(regionId);
      return true;
    });
    const duplicateInFlightIds = [...regionIds].filter((regionId) => !requestedIds.includes(regionId));
    if (duplicateInFlightIds.length) {
      Logger.debug?.('BuildingTiles.delete.regions.duplicateInFlightSkipped', {
        sceneId: resolvedScene.id || null,
        tileId: doc.id || null,
        duplicateInFlightIds
      });
    }
    if (!requestedIds.length) return;
    try {
      await sleep(50);
      const existingIds = requestedIds.filter((regionId) => !!resolvedScene.regions?.get?.(regionId));
      if (!existingIds.length) return;
      const deletableIds = partitionManagedDependents(
        resolvedScene, resolvedScene.regions, existingIds, 'BuildingTiles.delete.regions'
      );
      if (!deletableIds.length) return;
      await resolvedScene.deleteEmbeddedDocuments('Region', deletableIds, {
        [BUILDING_LINKED_CLEANUP_DELETE_OPTION]: true
      });
      Logger.info?.('BuildingTiles.delete.regions.deleted', {
        tileId: doc.id || null,
        wallGroupId: wallGroupId || null,
        regionIds: deletableIds
      });
    } finally {
      if (inFlightIds) {
        for (const regionId of requestedIds) inFlightIds.delete(regionId);
        if (!inFlightIds.size && queueKey) BUILDING_REGION_DELETE_IN_FLIGHT.delete(queueKey);
      }
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.regions.cleanup.failed', { error: String(error?.message || error) });
  }
}

export async function cleanupLinkedBuildingTiles(doc, options = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const scene = resolveLiveSceneDocument(doc.parent || canvas?.scene);
    if (!scene) return;
    const targets = resolveBuildingCleanupTargets(doc, scene);
    if (!targets.length) return;
    const isFillTrigger = !isBuildingTileDocument(doc) && isBuildingFillDocument(doc);
    const isSillTrigger = !isBuildingTileDocument(doc) && isBuildingCompositeSillDocument(doc);
    if (isFillTrigger || isSillTrigger) {
      const ownerTileIds = Array.from(new Set(
        targets.map((target) => target?.doc?.id).filter(Boolean)
      ));
      if (!ownerTileIds.length) return;
      if (isSillTrigger) {
        // ROOT CAUSE of the #101 vanish defect (memory building-commit-created-docs-vanish.md):
        // this branch used to ESCALATE a sill-container deletion into deleting the OWNER Building
        // root — with no fa-nexus option keys, so the delete read as user intent everywhere. Any
        // client whose delete-options guard did not recognize the triggering deletion (a peer tab
        // on the same world observing a Commit's legacy-sill delete over the socket) would destroy
        // the freshly migrated root, and the Scene Group native-deletion cascade then correctly
        // removed every dependent. A sills container — legacy composite or current-state managed —
        // is a dependent OUTPUT of its Building: its disappearance must never destroy the owner.
        // Registry pruning for a natively deleted dependent belongs to the Scene Group
        // native-deletion reconciliation, which already owns that policy. Report observably, act on
        // nothing.
        Logger.warn?.('BuildingTiles.delete.sillOwners.refused', {
          deletedSillTileId: doc.id || null,
          ownerTileIds,
          sceneId: scene?.id || null,
          reason: 'A sill container is a generated dependent of its Building. Deleting it never'
            + ' deletes the owning Building root; the Scene Group native-deletion reconciliation'
            + ' prunes its registry entries instead.'
        });
        return;
      }
      // THE LAST SURVIVING dependent→owner ESCALATION (#101, legacy-composite migration): this
      // branch fired for a Building FILL — and every legacy composite carries exactly such a Tile
      // (`buildingFill.wallTileId` back-link plus a `buildingComposite` role:'background' block) —
      // and deleted the LIVE owner Building root through deleteLinkedTilesRobustly. That delete is
      // DEFERRED (the helper yields before issuing it), so the Foundry stack no longer shows this
      // trigger, and before the BUILDING_LINKED_CLEANUP_DELETE_OPTION marker existed it carried NO
      // fa-nexus option keys — the exact recorded signature of the root deletion that destroyed a
      // freshly migrated Building. The root's death then read as a native deletion to the Scene
      // Group runtime (the linked-cleanup marker is deliberately NOT in its ignore policy), whose
      // reconciliation CORRECTLY cascaded fill + managed sills + Region + walls away
      // (`faNexusSceneGroupDelete` + `faNexusNativeRelationshipCascade`) — the recorded symptom.
      // Every earlier guard missed this branch: `sillOwners.refused` covers only sill containers,
      // `managedDependentRefused` protects managed DEPENDENTS (the root is an owner, never a
      // dependent), and the foreign-session gate is inert on the session that initiated the fill
      // deletion. The rule is uniform: a generated dependent's disappearance never destroys its
      // live owner. Report observably, act on nothing.
      Logger.warn?.('BuildingTiles.delete.fillOwners.refused', {
        deletedFillTileId: doc.id || null,
        ownerTileIds,
        sceneId: scene?.id || null,
        reason: 'A Building Fill is a generated dependent of its Building. Deleting it never'
          + ' deletes the owning Building root; the Scene Group native-deletion reconciliation'
          + ' prunes its registry entries instead.'
      });
      return;
    }
    for (const target of targets) {
      if (!target?.doc || !target?.data) continue;
      await deleteLinkedFillAndWalls(target.doc, { scene, data: target.data, options });
      await deleteLinkedDoorFrameTiles(target.doc, { scene, data: target.data });
      await deleteLinkedWindowTiles(target.doc, { scene, data: target.data });
      await deleteLinkedInnerWallTiles(target.doc, { scene, data: target.data });
      await deleteLinkedBuildingRegions(target.doc, { scene, data: target.data });
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.linked.cleanup.failed', { error: String(error?.message || error) });
  }
}
