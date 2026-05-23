import { NexusLogger as Logger } from '../core/nexus-logger.js';
import BuildingWallMesher from './building-wall-mesher.js';
import { gatherBuildingLoops } from './building-shape-helpers.js';
import {
  attachCustomTileOverhead,
  detachCustomTileOverhead,
  invalidateCustomTileOverhead
} from '../canvas/custom-tile-overhead.js';
import { resolveTileId } from '../canvas/tile-targets.js';
import { createDisplayProxyFactory } from '../canvas/display-object-proxy.js';
import {
  loadTexture,
  ensureMeshTransparent,
  restoreMeshTexture
} from '../textures/texture-runtime-core.js';
import { syncStandardMaskCustomSourceSuppression } from '../textures/standard-mask-custom-base.js';
import {
  applyHsbcToDisplayObject,
  normalizeHsbc,
  readDocumentHsbc
} from '../core/hsbc.js';
import {
  waitForTileMesh,
  clearTileMeshWaiters as clearSharedTileMeshWaiters
} from '../canvas/tile-mesh-waiter.js';

const EDITING_TILE_SET_KEY = '__faNexusBuildingEditingTileIds';
const BUILDING_WALL_DELETE_QUEUE = new Map();
const BUILDING_TILE_DELETE_IN_FLIGHT = new Map();
const PRESERVE_LINKED_TILE_CLEANUP_OPTION = 'faNexusPreserveLinkedTileCleanup';
const SUPPRESS_FILL_TRIGGERED_BUILDING_CLEANUP_OPTION = 'faNexusSuppressFillTriggeredBuildingCleanup';
const SKIP_LINKED_BUILDING_FILL_DELETE_OPTION = 'faNexusSkipLinkedBuildingFillDelete';

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

function isBuildingCompositeSillDocument(doc = null) {
  const composite = readBuildingFlag(doc, 'buildingComposite');
  return String(composite?.role || '').toLowerCase() === 'sill';
}

function shouldSkipLinkedBuildingDeletes(doc = null, options = {}) {
  try {
    if (isBuildingFillDocument(doc) && options?.[SUPPRESS_FILL_TRIGGERED_BUILDING_CLEANUP_OPTION]) return true;
    if (options?.[PRESERVE_LINKED_TILE_CLEANUP_OPTION]) return true;
    if (globalThis?.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE) return true;
    if (globalThis?.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE) return true;
    const suppressedIds = globalThis?.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE_IDS;
    const docId = doc?.id || doc?._id || null;
    return !!(docId && suppressedIds instanceof Set && suppressedIds.has(docId));
  } catch (_) {
    return false;
  }
}

function getEditingTileSet() {
  try {
    const root = globalThis;
    if (!root) return null;
    const existing = root[EDITING_TILE_SET_KEY];
    return existing instanceof Set ? existing : null;
  } catch (_) {
    return null;
  }
}

function isEditingTile(tile) {
  try {
    const set = getEditingTileSet();
    if (!set) return false;
    const id = resolveTileId(tile);
    return !!id && set.has(id);
  } catch (_) {
    return false;
  }
}

const DEFAULT_GRID_SCALE = 200;

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
      const doc = collection?.get?.(wallId);
      return (!!doc && !doc._destroyed) || hasEmbeddedSourceDocument(targetScene, 'Wall', wallId);
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
    const deleted = await liveScene.deleteEmbeddedDocuments('Wall', requestedIds);
    for (const wallId of normalizeDeletedIds(deleted)) deletedIds.add(wallId);
  } catch (error) {
    const message = String(error?.message || error);
    if (isMissingEmbeddedDocumentError(error) && existingIds.length) {
      try {
        const deleted = await liveScene.deleteEmbeddedDocuments('Wall', existingIds);
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
      const retried = await liveScene.deleteEmbeddedDocuments('Wall', survivingIds, { noHook: true });
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
    const composite = isSill ? readBuildingFlag(doc, 'buildingComposite') : null;
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
      const sillTileId = data?.meta?.sillTileId || data?.meta?.composite?.sillTileId || null;
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
    const existingIds = requestedIds.filter((tileId) => {
      const doc = collection?.get?.(tileId);
      return !!doc && !doc._destroyed;
    });
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
    await liveScene.deleteEmbeddedDocuments('Tile', existingIds, options || {});
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

function cleanupContainerChildren(container) {
  if (!container) return;
  const children = container.children ? [...container.children] : [];
  container.removeChildren();
  for (const child of children) {
    try { child.destroy?.({ children: true, texture: false, baseTexture: false }); }
    catch (_) {}
  }
  container.faNexusBuildingMeshes = null;
}

function cleanupDoorFrameOverlay(tile) {
  try {
    if (!tile) return;
    const mesh = tile.mesh;
    const container = tile.faNexusDoorFrameContainer || mesh?.faNexusDoorFrameContainer;
    detachCustomTileOverhead(tile, { kind: 'building-door-frame' });
    if (container) {
      cleanupContainerChildren(container);
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) mesh.faNexusDoorFrameContainer = null;
    tile.faNexusDoorFrameContainer = null;
  } catch (_) {}
}

export function cleanupBuildingCompositeOverlay(tile) {
  try {
    if (!tile) return;
    const mesh = tile.mesh;
    const container = tile.faNexusBuildingCompositeContainer || mesh?.faNexusBuildingCompositeContainer;
    detachCustomTileOverhead(tile, { kind: 'building-composite' });
    if (container) {
      cleanupContainerChildren(container);
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) mesh.faNexusBuildingCompositeContainer = null;
    tile.faNexusBuildingCompositeContainer = null;
  } catch (_) {}
}

function normalizeTextureOffset(offset) {
  const data = offset && typeof offset === 'object' ? offset : {};
  const x = Number(data.x);
  const y = Number(data.y);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0
  };
}

function normalizeTextureFlip(flip) {
  if (!flip || typeof flip !== 'object') {
    return { horizontal: false, vertical: false };
  }
  return {
    horizontal: !!flip.horizontal,
    vertical: !!flip.vertical
  };
}

function normalizeLayerOpacity(value, fallback = 1) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.min(1, Math.max(0, numeric));
  const fallbackNumeric = Number(fallback);
  if (Number.isFinite(fallbackNumeric)) return Math.min(1, Math.max(0, fallbackNumeric));
  return 1;
}

function hsbcValuesEqual(a = null, b = null) {
  const left = normalizeHsbc(a, null);
  const right = normalizeHsbc(b, null);
  if (!left && !right) return true;
  if (!left || !right) return false;
  return Math.abs(left.hue - right.hue) < 0.001
    && Math.abs(left.saturation - right.saturation) < 0.001
    && Math.abs(left.brightness - right.brightness) < 0.001
    && Math.abs(left.contrast - right.contrast) < 0.001;
}

function getBuildingWallTextureSrc(data) {
  return data?.wall?.texture || data?.meta?.wallTexture?.src || null;
}

function collectBuildingRenderSections(data) {
  const fallbackTextureSrc = getBuildingWallTextureSrc(data);
  const rootHsbc = normalizeHsbc(data?.wall?.hsbc || null, null);
  const innerFallbackHsbc = normalizeHsbc(data?.meta?.innerDefaults?.hsbc || rootHsbc, null);
  const renderSegments = Array.isArray(data?.wall?.renderSegments) ? data.wall.renderSegments : [];
  const normalizedSegments = renderSegments
    .filter((segment) => segment && Array.isArray(segment.points))
    .map((segment, index) => {
      const closed = segment?.closed !== false;
      const points = segment.points
        .map((point) => ({
          x: Number(point?.x) || 0,
          y: Number(point?.y) || 0
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      return {
        order: Number.isFinite(Number(segment?.order)) ? Number(segment.order) : index,
        closed,
        points,
        textureSrc: segment?.texture || segment?.pathLocal || fallbackTextureSrc,
        textureKey: segment?.pathKey || data?.wall?.pathKey || null,
        width: Number(segment?.width),
        repeatDistance: Number(segment?.repeatDistance),
        scalePercent: Number(segment?.scalePercent) || 100,
        textureOffset: normalizeTextureOffset(segment?.textureOffset),
        textureFlip: normalizeTextureFlip(segment?.textureFlip),
        startJoinDir: segment?.startJoinDir ? {
          x: Number(segment.startJoinDir.x) || 0,
          y: Number(segment.startJoinDir.y) || 0
        } : null,
        endJoinDir: segment?.endJoinDir ? {
          x: Number(segment.endJoinDir.x) || 0,
          y: Number(segment.endJoinDir.y) || 0
        } : null,
        layerOpacity: normalizeLayerOpacity(segment?.layerOpacity, data?.wall?.layerOpacity),
        hsbc: normalizeHsbc(
          segment?.appearance?.hsbc
          || segment?.hsbc
          || (segment?.wallType === 'inner' ? innerFallbackHsbc : rootHsbc),
          null
        ),
        wallType: segment?.wallType || segment?.loopRef?.wallType || data?.meta?.wallType || data?.wall?.mode || 'outer',
        pathShadow: segment?.pathShadow || null
      };
    })
    .filter((segment) => segment.points.length >= (segment.closed ? 3 : 2));
  if (normalizedSegments.length) return normalizedSegments;

  const loops = gatherBuildingLoops(data);
  if (!loops.length) return [];

  const wallWidth = Math.max(10, Number(data?.wall?.width) || DEFAULT_GRID_SCALE / 2);
  const wallOpacity = normalizeLayerOpacity(data?.wall?.layerOpacity, 1);
  const textureOffset = normalizeTextureOffset(data?.wall?.textureOffset);
  const textureFlip = normalizeTextureFlip(data?.wall?.textureFlip);
  return loops
    .filter((loop) => Array.isArray(loop) && loop.length >= (loop?.closed === false ? 2 : 3))
    .map((loop, index) => {
      const wallType = loop?.wallType || data?.meta?.wallType || data?.wall?.mode || 'outer';
      return {
        order: index,
        closed: loop?.closed !== false,
        points: loop.map((point) => ({
          x: Number(point?.x) || 0,
          y: Number(point?.y) || 0
        })),
        textureSrc: fallbackTextureSrc,
        textureKey: data?.wall?.pathKey || null,
        width: wallWidth,
        repeatDistance: Number(data?.wall?.repeatDistance),
        scalePercent: Number(data?.wall?.scalePercent) || 100,
        textureOffset: { ...textureOffset },
        textureFlip: { ...textureFlip },
        layerOpacity: wallOpacity,
        hsbc: wallType === 'inner' ? innerFallbackHsbc : rootHsbc,
        wallType,
        pathShadow: data?.wall?.pathShadow || null
      };
    });
}

async function loadBuildingTextureEntry(textureSrc) {
  if (!textureSrc) return null;
  const texture = await loadTexture(textureSrc);
  const base = texture?.baseTexture;
  if (base) {
    base.wrapMode = PIXI.WRAP_MODES.REPEAT;
    base.mipmap = PIXI.MIPMAP_MODES.OFF;
  }
  const visibleData = await detectVisibleRows(texture);
  return { texture, visibleData };
}

function resetBuildingOverlayToTransparent(tile, mesh, doc) {
  ensureMeshTransparent(mesh, 'faNexusBuildingOriginalTexture');
  const container = ensureBuildingContainer(tile, mesh);
  cleanupContainerChildren(container);
  container.faNexusBuildingRenderKey = null;
  container.faNexusBuildingMeshes = [];
  container.alpha = 1;
  setContainerTransform(container, mesh, doc);
  detachCustomTileOverhead(tile, { kind: 'building' });
  return container;
}

export function cleanupBuildingOverlay(tile, options = {}) {
  try {
    const preserveTexture = !!options.preserveTexture;
    if (!tile) return;
    const mesh = tile.mesh;
    const container = tile.faNexusBuildingContainer || mesh?.faNexusBuildingContainer;
    detachCustomTileOverhead(tile, { kind: 'building' });
    if (container) {
      cleanupContainerChildren(container);
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) {
      mesh.faNexusBuildingContainer = null;
      if (!preserveTexture) restoreMeshTexture(mesh, 'faNexusBuildingOriginalTexture');
    }
    tile.faNexusBuildingContainer = null;
  } catch (_) {}
}

async function ensureTileMesh(tile, options = {}) {
  return waitForTileMesh(tile, {
    attempts: Math.max(2, Number(options?.attempts) || 8),
    delay: Math.max(30, Number(options?.delay) || 60),
    scope: 'BuildingTiles.ensureTileMesh'
  });
}

function ensureBuildingContainer(tile, mesh) {
  let container = tile.faNexusBuildingContainer;
  if (!container || container.destroyed) {
    container = new PIXI.Container();
    container.eventMode = 'none';
    container.sortableChildren = false;
    tile.faNexusBuildingContainer = container;
    mesh.addChild(container);
  } else if (!container.parent) {
    mesh.addChild(container);
  }
  mesh.faNexusBuildingContainer = container;
  return container;
}

function ensureDoorFrameContainer(tile, mesh) {
  let container = tile.faNexusDoorFrameContainer;
  if (!container || container.destroyed) {
    container = new PIXI.Container();
    container.eventMode = 'none';
    container.sortableChildren = false;
    tile.faNexusDoorFrameContainer = container;
    mesh.addChild(container);
  } else if (!container.parent) {
    mesh.addChild(container);
  }
  mesh.faNexusDoorFrameContainer = container;
  return container;
}

function ensureBuildingCompositeContainer(tile, mesh) {
  let container = tile.faNexusBuildingCompositeContainer;
  if (!container || container.destroyed) {
    container = new PIXI.Container();
    container.eventMode = 'none';
    container.sortableChildren = true;
    tile.faNexusBuildingCompositeContainer = container;
    mesh.addChild(container);
  } else if (!container.parent) {
    mesh.addChild(container);
  }
  mesh.faNexusBuildingCompositeContainer = container;
  return container;
}

function raiseBackgroundCompositeAboveFill(tile, mesh, container) {
  try {
    if (!tile || !mesh || !container || container.destroyed) return;
    const maskContainer = tile.faNexusMaskContainer || mesh.faNexusMaskContainer || null;
    const standardMaskContainer = tile.faNexusStandardMaskContainer || mesh.faNexusStandardMaskContainer || null;
    if (maskContainer && !maskContainer.destroyed) maskContainer.zIndex = Math.min(Number(maskContainer.zIndex) || 0, 0);
    if (standardMaskContainer && !standardMaskContainer.destroyed) standardMaskContainer.zIndex = Math.min(Number(standardMaskContainer.zIndex) || 0, 0);
    container.zIndex = Math.max(Number(container.zIndex) || 0, 10);
    mesh.sortableChildren = true;
    if (container.parent === mesh) mesh.addChild(container);
    mesh.sortChildren?.();
  } catch (error) {
    Logger.warn?.('BuildingTiles.buildingComposite.order.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
  }
}

function applyMeshAlpha(mesh, alpha) {
  try {
    if (!mesh || mesh.destroyed) return;
    mesh.alpha = alpha;
    const shader = mesh.shader || mesh.material?.shader || null;
    const uniforms = shader?.uniforms || null;
    if (!uniforms) return;
    const target = uniforms.uColor;
    if (target instanceof Float32Array && target.length >= 4) {
      target[0] = target[1] = target[2] = target[3] = alpha;
    } else if (Array.isArray(target) && target.length >= 4) {
      target[0] = target[1] = target[2] = target[3] = alpha;
    } else if (target && typeof target.length === 'number' && target.length >= 4) {
      target[0] = target[1] = target[2] = target[3] = alpha;
    } else {
      uniforms.uColor = new Float32Array([alpha, alpha, alpha, alpha]);
    }
  } catch (_) {}
}

function setContainerTransform(container, mesh, doc) {
  if (!container || !mesh || mesh.destroyed) return;
  const docWidth = Math.max(1, Number(doc?.width) || Number(mesh?.width) || 1);
  const docHeight = Math.max(1, Number(doc?.height) || Number(mesh?.height) || 1);
  const rawSx = Number(mesh.scale?.x ?? 1) || 1;
  const rawSy = Number(mesh.scale?.y ?? 1) || 1;
  const sx = Math.abs(rawSx) > 1.001 ? rawSx : (Math.sign(rawSx || 1) || 1) * docWidth;
  const sy = Math.abs(rawSy) > 1.001 ? rawSy : (Math.sign(rawSy || 1) || 1) * docHeight;
  const anchorX = Number(doc?.texture?.anchorX);
  const anchorY = Number(doc?.texture?.anchorY);
  const ax = Number.isFinite(anchorX) ? anchorX : 0.5;
  const ay = Number.isFinite(anchorY) ? anchorY : 0.5;
  container.scale.set(1 / sx, 1 / sy);
  container.position.set(-(docWidth * ax) / (sx || 1), -(docHeight * ay) / (sy || 1));
}

function hasRenderableChildren(container) {
  try {
    return !!(container && !container.destroyed && Array.isArray(container.children)
      && container.children.some((child) => child && !child.destroyed));
  } catch (_) {
    return false;
  }
}

function buildRenderKey(label, parts, tileId = null) {
  try {
    return JSON.stringify(parts);
  } catch (error) {
    Logger.error?.(`BuildingTiles.${label}.renderKey.failed`, {
      tileId,
      error: String(error?.message || error)
    });
    return null;
  }
}

function getTileRenderSignature(doc) {
  return {
    width: Number(doc?.width) || 0,
    height: Number(doc?.height) || 0,
    anchorX: Number.isFinite(Number(doc?.texture?.anchorX)) ? Number(doc.texture.anchorX) : 0.5,
    anchorY: Number.isFinite(Number(doc?.texture?.anchorY)) ? Number(doc.texture.anchorY) : 0.5,
    alpha: Number.isFinite(Number(doc?.alpha)) ? Number(doc.alpha) : 1,
    hidden: !!doc?.hidden,
    textureSrc: doc?.texture?.src || null,
    hsbc: readDocumentHsbc(doc, { nullIfMissing: true, nullIfNeutral: true }) || null
  };
}

function syncReusableBuildingRuntime(tile, mesh, doc, container, reason) {
  if (!container || container.destroyed) return;
  tile.faNexusBuildingContainer = container;
  mesh.faNexusBuildingContainer = container;
  if (!container.parent) mesh.addChild(container);
  setContainerTransform(container, mesh, doc);
  attachCustomTileOverhead(tile, {
    kind: 'building',
    contentContainer: container,
    proxyFactory: createDisplayProxyFactory(container),
    syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
      setContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
    }
  });
  try {
    syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), reason);
  } catch (error) {
    Logger.warn?.('BuildingTiles.standardMaskSuppression.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
  }
}

function syncReusableDoorFrameRuntime(tile, mesh, doc, container, reason) {
  if (!container || container.destroyed) return;
  tile.faNexusDoorFrameContainer = container;
  mesh.faNexusDoorFrameContainer = container;
  if (!container.parent) mesh.addChild(container);
  setContainerTransform(container, mesh, doc);
  attachCustomTileOverhead(tile, {
    kind: 'building-door-frame',
    contentContainer: container,
    proxyFactory: createDisplayProxyFactory(container),
    syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
      setContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
    }
  });
  try {
    syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), reason);
  } catch (error) {
    Logger.warn?.('BuildingTiles.doorFrame.standardMaskSuppression.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
  }
}

function syncReusableBuildingCompositeRuntime(tile, mesh, doc, container, reason) {
  if (!container || container.destroyed) return;
  tile.faNexusBuildingCompositeContainer = container;
  mesh.faNexusBuildingCompositeContainer = container;
  if (!container.parent) mesh.addChild(container);
  setContainerTransform(container, mesh, doc);
  if (doc?.getFlag?.('fa-nexus', 'buildingComposite')?.role === 'background') {
    raiseBackgroundCompositeAboveFill(tile, mesh, container);
  }
  attachCustomTileOverhead(tile, {
    kind: 'building-composite',
    contentContainer: container,
    proxyFactory: createDisplayProxyFactory(container),
    syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
      setContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
    }
  });
  try {
    syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), reason);
  } catch (error) {
    Logger.warn?.('BuildingTiles.buildingComposite.standardMaskSuppression.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
  }
}

function computeTextureRepeatDistance(texture, data) {
  const assetPxOverride = Number(
    data?.wall?.assetGridSize ??
    data?.meta?.assetGridSize ??
    data?.meta?.wallTexture?.gridSize
  );
  const assetPx = Math.max(1, assetPxOverride || DEFAULT_GRID_SCALE);
  const sceneGridSize = Math.max(1, Number(canvas?.scene?.grid?.size) || DEFAULT_GRID_SCALE);
  const gridScaleFactor = sceneGridSize / assetPx;
  const texWidth = Math.max(1, Number(texture?.width) || assetPx);
  return texWidth * gridScaleFactor;
}

function getTileWorldOrigin(doc) {
  const width = Math.max(1, Number(doc?.width) || 1);
  const height = Math.max(1, Number(doc?.height) || 1);
  const anchorX = Number.isFinite(Number(doc?.texture?.anchorX)) ? Number(doc.texture.anchorX) : 0.5;
  const anchorY = Number.isFinite(Number(doc?.texture?.anchorY)) ? Number(doc.texture.anchorY) : 0.5;
  return {
    x: (Number(doc?.x) || 0) - (width * anchorX),
    y: (Number(doc?.y) || 0) - (height * anchorY),
    width,
    height
  };
}

function getCompositePartTexturePath(part = {}) {
  const texture = part?.texture && typeof part.texture === 'object' ? part.texture : {};
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  const flagKey = part?.flagKey || '';
  const typedFlag = flagKey ? (flags?.[flagKey] || {}) : {};
  return texture.src
    || part.textureSrc
    || typedFlag.sourceTextureLocal
    || typedFlag.sourceTextureKey
    || '';
}

function normalizeCompositePartHsbc(part = {}) {
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  const typedFlag = part?.flagKey ? (flags?.[part.flagKey] || {}) : {};
  return normalizeHsbc(part.hsbc ?? flags.hsbc ?? typedFlag.hsbc ?? null, null);
}

function getCompositePartFlag(part = {}) {
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  const flagKey = part?.flagKey || '';
  return flagKey ? (flags?.[flagKey] || {}) : {};
}

function createCompositePartRoot(part = {}, doc = null) {
  const origin = getTileWorldOrigin(doc);
  const width = Math.max(1, Number(part?.width) || 1);
  const height = Math.max(1, Number(part?.height) || 1);
  const centerX = (Number(part?.x) || 0) - origin.x;
  const centerY = (Number(part?.y) || 0) - origin.y;
  const rotation = (Number(part?.rotation) || 0) * (Math.PI / 180);
  const root = new PIXI.Container();
  root.eventMode = 'none';
  root.sortableChildren = false;
  root.interactiveChildren = false;
  root.position.set(centerX, centerY);
  root.pivot.set(width / 2, height / 2);
  root.rotation = rotation;
  root.alpha = Number.isFinite(Number(part?.alpha)) ? Math.max(0, Math.min(1, Number(part.alpha))) : 1;
  root.zIndex = Number.isFinite(Number(part?.sort)) ? Number(part.sort) : 0;
  return { root, width, height, rotation };
}

function resolveCompositeShadowOffset(part = {}, rotationRad = 0) {
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  let x = Number(flags.shadowOffsetX);
  let y = Number(flags.shadowOffsetY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const distance = Number(flags.shadowOffsetDistance);
    const angleDeg = Number(flags.shadowOffsetAngle);
    if (Number.isFinite(distance) && Number.isFinite(angleDeg)) {
      const angle = angleDeg * (Math.PI / 180);
      x = Math.cos(angle) * distance;
      y = Math.sin(angle) * distance;
    } else {
      x = 0;
      y = 0;
    }
  }
  const cos = Math.cos(-rotationRad || 0);
  const sin = Math.sin(-rotationRad || 0);
  return {
    x: (x * cos) - (y * sin),
    y: (x * sin) + (y * cos)
  };
}

function addCompositeSpriteShadow(root, texture, part, width, height, rotationRad = 0) {
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  if (!flags.shadow) return;
  const base = texture?.baseTexture;
  if (!base?.valid) return;
  const alpha = Number.isFinite(Number(flags.shadowAlpha)) ? Math.max(0, Math.min(1, Number(flags.shadowAlpha))) : 0.35;
  if (alpha <= 0.001) return;
  const blur = Math.max(0, Number(flags.shadowBlur) || 0);
  const dilation = Math.max(0, Number(flags.shadowDilation) || 0);
  const offset = resolveCompositeShadowOffset(part, rotationRad);
  const shadow = new PIXI.Sprite(texture);
  shadow.anchor.set(0.5, 0.5);
  shadow.position.set((width / 2) + offset.x, (height / 2) + offset.y);
  const scaleYSign = Number(part?.texture?.scaleY) < 0 ? -1 : 1;
  shadow.scale.set(
    (width + (dilation * 2)) / Math.max(1, Number(base.width) || 1),
    ((height + (dilation * 2)) / Math.max(1, Number(base.height) || 1)) * scaleYSign
  );
  shadow.tint = 0x000000;
  shadow.alpha = alpha;
  if (blur > 0 && PIXI?.BlurFilter) {
    try {
      const filter = new PIXI.BlurFilter();
      filter.blur = blur;
      shadow.filters = [filter];
    } catch (_) {}
  }
  root.addChild(shadow);
}

function addSimpleCompositeSprite(root, texture, part, width, height, rotationRad = 0) {
  const base = texture?.baseTexture;
  if (!texture || !base?.valid) return false;
  addCompositeSpriteShadow(root, texture, part, width, height, rotationRad);
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.5);
  sprite.position.set(width / 2, height / 2);
  const scaleYSign = Number(part?.texture?.scaleY) < 0 ? -1 : 1;
  sprite.scale.set(
    width / Math.max(1, Number(base.width) || 1),
    (height / Math.max(1, Number(base.height) || 1)) * scaleYSign
  );
  applyHsbcToDisplayObject(sprite, normalizeCompositePartHsbc(part));
  root.addChild(sprite);
  return true;
}

function addDoorFrameCompositeSprites(root, texture, part, width, height) {
  const base = texture?.baseTexture;
  if (!texture || !base?.valid) return false;
  const data = getCompositePartFlag(part);
  const gridSize = Number.isFinite(Number(data?.assetGridSize))
    ? Number(data.assetGridSize)
    : Math.max(1, Number(canvas?.scene?.grid?.size) || DEFAULT_GRID_SCALE);
  const baseAssetScale = gridSize / DEFAULT_GRID_SCALE;
  const userScaleRaw = Number.isFinite(Number(data?.scale)) ? Number(data.scale) : 1;
  const userScale = Math.min(3, Math.max(0.1, userScaleRaw));
  const assetScale = baseAssetScale * userScale;
  const offsetX = Number.isFinite(Number(data?.offsetX)) ? Number(data.offsetX) : 0;
  const offsetY = Number.isFinite(Number(data?.offsetY)) ? Number(data.offsetY) : 0;
  const spriteRotation = Number.isFinite(Number(data?.rotation)) ? Number(data.rotation) * (Math.PI / 180) : 0;
  const gapLength = Number.isFinite(Number(data?.gapLength)) ? Number(data.gapLength) : width;
  const rawMode = String(data?.mode || '').toLowerCase();
  const mode = rawMode === 'scale' ? 'scale' : (rawMode === 'pillar' ? 'pillar' : 'split');
  const heightScene = Math.max(1, Number(base.height) || 1) * assetScale;

  if (mode === 'scale') {
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5, 0.5);
    sprite.position.set(width / 2, heightScene / 2);
    sprite.scale.set(width / Math.max(1, Number(base.width) || 1), assetScale);
    root.addChild(sprite);
  } else if (mode === 'pillar') {
    const pillarWidthPx = Math.max(1, Number(base.width) || 1);
    const pillarWidthScene = pillarWidthPx * assetScale;
    const targetWidth = Math.max(width, pillarWidthScene * 2 + 1, gapLength + pillarWidthScene * 2);
    const offsetXPx = offsetX * targetWidth * 0.5;
    const offsetYPx = offsetY * heightScene * 0.5;
    const left = new PIXI.Sprite(texture);
    left.anchor.set(0.5, 0.5);
    left.position.set(pillarWidthScene * 0.5 + offsetXPx, heightScene * 0.5 + offsetYPx);
    left.scale.set(assetScale, assetScale);
    left.rotation = spriteRotation;
    const right = new PIXI.Sprite(texture);
    right.anchor.set(0.5, 0.5);
    right.position.set(targetWidth - pillarWidthScene * 0.5 - offsetXPx, heightScene * 0.5 + offsetYPx);
    right.scale.set(-assetScale, assetScale);
    right.rotation = -spriteRotation;
    root.addChild(left, right);
  } else {
    const pillarWidthPx = Math.max(1, Math.min(base.height, Math.floor(base.width / 2)));
    const pillarWidthScene = pillarWidthPx * assetScale;
    const targetWidth = Math.max(width, pillarWidthScene * 2 + 1, gapLength + pillarWidthScene * 2);
    const offsetXPx = offsetX * targetWidth * 0.5;
    const offsetYPx = offsetY * heightScene * 0.5;
    const leftRect = new PIXI.Rectangle(0, 0, pillarWidthPx, base.height);
    const rightRect = new PIXI.Rectangle(Math.max(0, base.width - pillarWidthPx), 0, pillarWidthPx, base.height);
    const left = new PIXI.Sprite(new PIXI.Texture(base, leftRect));
    left.anchor.set(0.5, 0.5);
    left.position.set(pillarWidthScene * 0.5 + offsetXPx, heightScene * 0.5 + offsetYPx);
    left.scale.set(assetScale, assetScale);
    const right = new PIXI.Sprite(new PIXI.Texture(base, rightRect));
    right.anchor.set(0.5, 0.5);
    right.position.set(targetWidth - pillarWidthScene * 0.5 - offsetXPx, heightScene * 0.5 + offsetYPx);
    right.scale.set(assetScale, assetScale);
    root.addChild(left, right);
  }

  applyHsbcToDisplayObject(root, normalizeCompositePartHsbc(part));
  return true;
}

async function addCompositePart(container, doc, part) {
  const texturePath = getCompositePartTexturePath(part);
  if (!texturePath) {
    Logger.warn?.('BuildingTiles.buildingComposite.partTextureMissing', {
      tileId: doc?.id || null,
      kind: part?.kind || null,
      partId: part?.id || null
    });
    return false;
  }
  let texture = null;
  try {
    texture = await loadTexture(texturePath);
    const base = texture?.baseTexture;
    if (base) {
      base.mipmap = PIXI.MIPMAP_MODES.OFF;
      base.wrapMode = PIXI.WRAP_MODES.CLAMP;
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.buildingComposite.texture.loadFailed', {
      tileId: doc?.id || null,
      partId: part?.id || null,
      texturePath,
      error: String(error?.message || error)
    });
    return false;
  }
  const base = texture?.baseTexture;
  if (!texture || !base?.valid) return false;
  const { root, width, height, rotation } = createCompositePartRoot(part, doc);
  const kind = String(part?.kind || part?.elementType || '').toLowerCase();
  const rendered = kind === 'doorframe' || kind === 'door-frame' || part?.flagKey === 'buildingDoorFrame'
    ? addDoorFrameCompositeSprites(root, texture, part, width, height)
    : addSimpleCompositeSprite(root, texture, part, width, height, rotation);
  if (!rendered || !root.children?.length) {
    try { root.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    return false;
  }
  container.addChild(root);
  return true;
}

async function detectVisibleRows(texture) {
  if (!texture || !texture.baseTexture) return null;
  if (texture.faNexusBuildingVisibleData) return texture.faNexusBuildingVisibleData;
  const base = texture.baseTexture;
  if (!base.valid) {
    await new Promise((resolve) => {
      const done = () => { base.off?.('loaded', done); base.off?.('error', done); resolve(); };
      base.once?.('loaded', done);
      base.once?.('error', done);
      if (base.valid) done();
    });
  }
  try {
    const resource = base.resource;
    const source = resource?.source;
    if (!source) return null;
    const width = base.width;
    const height = base.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const alphaThreshold = 10;
    let top = 0;
    let bottom = height - 1;
    const rowVisible = (y) => {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] > alphaThreshold) return true;
      }
      return false;
    };
    while (top < height && !rowVisible(top)) top += 1;
    while (bottom > top && !rowVisible(bottom)) bottom -= 1;
    const data = {
      topRow: top,
      bottomRow: bottom,
      totalHeight: height
    };
    texture.faNexusBuildingVisibleData = data;
    return data;
  } catch (_) {
    return null;
  }
}

function remapVisibleRows(geometry, visibleData) {
  if (!geometry || !visibleData) return;
  const texHeight = Math.max(1, visibleData.totalHeight || 0);
  if (!texHeight) return;
  const uvBuffer = geometry.getBuffer('aTextureCoord');
  if (!uvBuffer?.data) return;
  const vMin = visibleData.topRow / texHeight;
  const vMax = (visibleData.bottomRow + 1) / texHeight;
  const range = Math.max(0.001, vMax - vMin);
  const data = uvBuffer.data;
  for (let i = 1; i < data.length; i += 2) {
    data[i] = vMin + (data[i] * range);
  }
  uvBuffer.update();
}

function createWallShader(texture) {
  if (!texture) return null;
  try {
    if (PIXI?.MeshMaterial) {
      const material = new PIXI.MeshMaterial(texture);
      material.alpha = 1;
      if (material.uvMatrix) {
        material.uvMatrix.isSimple = false;
        material.uvMatrix.clampOffset = false;
        material.uvMatrix.clampMargin = -0.5;
        material.uvMatrix.update();
      }
      return material;
    }
    if (PIXI?.Mesh?.Material) {
      const material = new PIXI.Mesh.Material(texture);
      material.alpha = 1;
      if (material.uvMatrix) {
        material.uvMatrix.isSimple = false;
        material.uvMatrix.clampOffset = false;
        material.uvMatrix.clampMargin = -0.5;
        material.uvMatrix.update();
      }
      return material;
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.shader.create.failed', { error: String(error?.message || error) });
  }
  try {
    const material = new PIXI.MeshMaterial(texture);
    if (material.uvMatrix) {
      material.uvMatrix.isSimple = false;
      material.uvMatrix.clampOffset = false;
      material.uvMatrix.clampMargin = -0.5;
      material.uvMatrix.update();
    }
    return material;
  } catch (_) {
    return null;
  }
}

export async function applyBuildingTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    if (isEditingTile(tile)) {
      cleanupBuildingOverlay(tile, { preserveTexture: true });
      let mesh = tile.mesh;
      if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
      if (!mesh || mesh.destroyed) return;
      ensureMeshTransparent(mesh, 'faNexusBuildingOriginalTexture');
      return;
    }
    const data = doc?.getFlag?.('fa-nexus', 'building');
    if (!data) {
      cleanupBuildingOverlay(tile);
      return;
    }
    const renderSections = collectBuildingRenderSections(data);
    const compositeData = doc?.getFlag?.('fa-nexus', 'buildingComposite');
    const foregroundParts = compositeData?.role === 'foreground' && Array.isArray(compositeData?.parts)
      ? compositeData.parts.filter((part) => part && typeof part === 'object')
      : [];
    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;
    if (!renderSections.length && !foregroundParts.length) {
      resetBuildingOverlayToTransparent(tile, mesh, doc);
      return;
    }
    ensureMeshTransparent(mesh, 'faNexusBuildingOriginalTexture');

    const renderKey = buildRenderKey('building', {
      tile: getTileRenderSignature(doc),
      data,
      foregroundParts,
      renderSections
    }, doc?.id);
    const reusableContainer = tile.faNexusBuildingContainer || mesh.faNexusBuildingContainer;
    if (
      renderKey
      && reusableContainer?.faNexusBuildingRenderKey === renderKey
      && hasRenderableChildren(reusableContainer)
    ) {
      syncReusableBuildingRuntime(tile, mesh, doc, reusableContainer, 'building-reuse');
      return;
    }

    const visibleSections = renderSections.filter((section) => normalizeLayerOpacity(section?.layerOpacity, 1) > 0.001);
    const textureSources = Array.from(new Set(visibleSections.map((section) => section.textureSrc).filter(Boolean)));
    const textureEntries = new Map();
    await Promise.all(textureSources.map(async (textureSrc) => {
      try {
        const entry = await loadBuildingTextureEntry(textureSrc);
        if (entry?.texture) textureEntries.set(textureSrc, entry);
      } catch (error) {
        Logger.warn?.('BuildingTiles.texture.loadFailed', {
          error: String(error?.message || error),
          tileId: doc?.id,
          textureSrc
        });
      }
    }));

	    const container = ensureBuildingContainer(tile, mesh);
	    const rootHsbc = normalizeHsbc(readDocumentHsbc(doc, { nullIfMissing: true, nullIfNeutral: true }), null);
	    cleanupContainerChildren(container);
	    container.faNexusBuildingMeshes = [];
	    const sectionMeshes = [];
	    let useContainerHsbc = foregroundParts.length <= 0;

    const isOverWallPart = (part) => {
      const kind = String(part?.kind || part?.elementType || '').toLowerCase();
      return kind === 'doorframe' || kind === 'door-frame' || part?.flagKey === 'buildingDoorFrame';
    };
    const underWallParts = foregroundParts.filter((part) => !isOverWallPart(part));
    const overWallParts = foregroundParts.filter((part) => isOverWallPart(part));
    for (const part of underWallParts) {
      await addCompositePart(container, doc, part);
    }

	    const orderedSections = renderSections
	      .map((section, renderIndex) => ({ ...section, renderIndex }))
	      .sort((a, b) => {
	        const orderDelta = (Number(a?.order) || 0) - (Number(b?.order) || 0);
	        if (Math.abs(orderDelta) > 1e-6) return orderDelta;
	        return (Number(a?.renderIndex) || 0) - (Number(b?.renderIndex) || 0);
	      });
	    let meshIndex = 0;
	    for (const section of orderedSections) {
	      const layerOpacity = normalizeLayerOpacity(section?.layerOpacity, 1);
	      if (layerOpacity <= 0.001) continue;
      const textureSrc = section?.textureSrc || getBuildingWallTextureSrc(data);
      const textureEntry = textureSources.length ? textureEntries.get(textureSrc) : null;
      const texture = textureEntry?.texture || null;
      if (!texture) continue;
      const closed = section?.closed !== false;
      const points = Array.isArray(section?.points) ? section.points : [];
      const minPoints = closed ? 3 : 2;
      if (points.length < minPoints) continue;
      const wallWidth = Math.max(10, Number(section?.width) || Number(data?.wall?.width) || DEFAULT_GRID_SCALE / 2);
      const repeatDistance = (() => {
        const stored = Number(section?.repeatDistance);
        if (Number.isFinite(stored) && stored > 0) return stored;
        return computeTextureRepeatDistance(texture, data);
      })();
	      const geometryResult = BuildingWallMesher.buildGeometry(points, {
	        width: wallWidth,
	        closed,
        joinStyle: 'mitre',
        mitreLimit: 4,
        textureRepeatDistance: repeatDistance,
        textureOffset: normalizeTextureOffset(section?.textureOffset),
        textureFlip: normalizeTextureFlip(section?.textureFlip),
        startJoinDir: section?.startJoinDir || null,
        endJoinDir: section?.endJoinDir || null
      });
	      const geometry = geometryResult?.geometry;
	      if (!geometry || !geometryResult?.data?.positions?.length) continue;
	      remapVisibleRows(geometry, textureEntry?.visibleData);
	      const shader = createWallShader(texture);
	      if (!shader) continue;
	      const sectionMesh = new PIXI.Mesh(geometry, shader);
	      sectionMesh.name = `fa-nexus-building-wall-${doc?.id || 'tile'}-${meshIndex}`;
	      sectionMesh.eventMode = 'none';
	      sectionMesh.interactiveChildren = false;
	      container.addChild(sectionMesh);
	      container.faNexusBuildingMeshes.push(sectionMesh);
	      applyMeshAlpha(sectionMesh, layerOpacity);
	      const sectionHsbc = normalizeHsbc(section?.hsbc ?? rootHsbc, null);
	      if (!hsbcValuesEqual(sectionHsbc, rootHsbc)) useContainerHsbc = false;
	      sectionMeshes.push({ mesh: sectionMesh, hsbc: sectionHsbc });
	      meshIndex += 1;
	    }

    for (const part of overWallParts) {
      await addCompositePart(container, doc, part);
    }

	    if (!container.children?.length) {
	      resetBuildingOverlayToTransparent(tile, mesh, doc);
      return;
    }

    container.alpha = 1;
    container.faNexusBuildingRenderKey = renderKey;
    applyHsbcToDisplayObject(container, useContainerHsbc ? rootHsbc : null);
    if (useContainerHsbc) {
      for (const { mesh: sectionMesh } of sectionMeshes) {
        applyHsbcToDisplayObject(sectionMesh, null);
      }
    } else {
      for (const { mesh: sectionMesh, hsbc } of sectionMeshes) {
        applyHsbcToDisplayObject(sectionMesh, hsbc);
      }
    }
    setContainerTransform(container, mesh, doc);
    attachCustomTileOverhead(tile, {
      kind: 'building',
      contentContainer: container,
      proxyFactory: createDisplayProxyFactory(container),
      syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
        setContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    try {
      syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), 'building-refresh');
    } catch (error) {
      Logger.warn?.('BuildingTiles.standardMaskSuppression.failed', {
        tileId: tile?.document?.id,
        error: String(error?.message || error)
      });
    }
    invalidateCustomTileOverhead(tile, 'building-refresh');
  } catch (error) {
    Logger.warn?.('BuildingTiles.apply.failed', { error: String(error?.message || error) });
  }
}

export async function applyDoorFrameTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    if (isEditingTile(tile)) {
      cleanupDoorFrameOverlay(tile);
      let mesh = tile.mesh;
      if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
      if (!mesh || mesh.destroyed) return;
      ensureMeshTransparent(mesh, 'faNexusBuildingOriginalTexture');
      return;
    }
    const data = doc?.getFlag?.('fa-nexus', 'buildingDoorFrame');
    if (!data) {
      cleanupDoorFrameOverlay(tile);
      return;
    }

    const texturePath = data?.sourceTextureLocal || data?.sourceTextureKey || '';
    if (!texturePath) {
      cleanupDoorFrameOverlay(tile);
      return;
    }

    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;
    ensureMeshTransparent(mesh, 'faNexusBuildingOriginalTexture');

    const renderKey = buildRenderKey('doorFrame', {
      tile: getTileRenderSignature(doc),
      data,
      texturePath
    }, doc?.id);
    const reusableContainer = tile.faNexusDoorFrameContainer || mesh.faNexusDoorFrameContainer;
    if (
      renderKey
      && reusableContainer?.faNexusDoorFrameRenderKey === renderKey
      && hasRenderableChildren(reusableContainer)
    ) {
      syncReusableDoorFrameRuntime(tile, mesh, doc, reusableContainer, 'building-door-frame-reuse');
      return;
    }

    let texture = null;
    try {
      texture = await loadTexture(texturePath);
      const base = texture?.baseTexture;
      if (base) {
        base.mipmap = PIXI.MIPMAP_MODES.OFF;
        base.wrapMode = PIXI.WRAP_MODES.CLAMP;
      }
    } catch (error) {
      Logger.warn?.('BuildingTiles.doorFrame.texture.loadFailed', { error: String(error?.message || error), tileId: doc?.id, texturePath });
      cleanupDoorFrameOverlay(tile);
      return;
    }

    const base = texture?.baseTexture;
    if (!texture || !base?.valid) {
      cleanupDoorFrameOverlay(tile);
      return;
    }

    const container = ensureDoorFrameContainer(tile, mesh);
    cleanupContainerChildren(container);
    container.name = 'fa-nexus-building-door-frame';
    container.faNexusDoorFrameRenderKey = renderKey;

    const docWidth = Math.max(2, Number(doc?.width) || Number(tile?.width) || 0);
    const docHeight = Math.max(2, Number(doc?.height) || Number(tile?.height) || 0);
    const gridSize = Number.isFinite(Number(data?.assetGridSize))
      ? Number(data.assetGridSize)
      : Math.max(1, Number(canvas?.scene?.grid?.size) || DEFAULT_GRID_SCALE);
    const baseAssetScale = gridSize / DEFAULT_GRID_SCALE; // FRAME_ASSET_GRID_PX === 200
    const userScaleRaw = Number.isFinite(Number(data?.scale)) ? Number(data.scale) : 1;
    const userScale = Math.min(3, Math.max(0.1, userScaleRaw));
    const assetScale = baseAssetScale * userScale;
    const offsetX = Number.isFinite(Number(data?.offsetX)) ? Number(data.offsetX) : 0;
    const offsetY = Number.isFinite(Number(data?.offsetY)) ? Number(data.offsetY) : 0;
    const rotation = Number.isFinite(Number(data?.rotation)) ? Number(data.rotation) : 0;
    const rotationRad = rotation * (Math.PI / 180);
    const gapLength = Number.isFinite(Number(data?.gapLength)) ? Number(data.gapLength) : docWidth;
    const rawMode = String(data?.mode || '').toLowerCase();
    const mode = rawMode === 'scale' ? 'scale' : (rawMode === 'pillar' ? 'pillar' : 'split');

    const heightScene = Math.max(1, Number(base.height) || 1) * assetScale;

    if (mode === 'scale') {
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0.5, 0.5);
      sprite.position.set(docWidth / 2, heightScene / 2);
      sprite.scale.set(docWidth / Math.max(1, Number(base.width) || 1), assetScale);
      container.addChild(sprite);
    } else if (mode === 'pillar') {
      // Pillar mode: duplicate the full texture and flip for right side
      const pillarWidthPx = base.width;
      const pillarWidthScene = pillarWidthPx * assetScale;
      const targetWidth = Math.max(docWidth, pillarWidthScene * 2 + 1, gapLength + pillarWidthScene * 2);
      const offsetXPx = offsetX * targetWidth * 0.5;
      const offsetYPx = offsetY * heightScene * 0.5;

      const left = new PIXI.Sprite(texture);
      left.anchor.set(0.5, 0.5);
      left.position.set(pillarWidthScene * 0.5 + offsetXPx, heightScene * 0.5 + offsetYPx);
      left.scale.set(assetScale, assetScale);
      left.rotation = rotationRad;

      const right = new PIXI.Sprite(texture);
      right.anchor.set(0.5, 0.5);
      right.position.set(targetWidth - pillarWidthScene * 0.5 - offsetXPx, heightScene * 0.5 + offsetYPx);
      right.scale.set(-assetScale, assetScale); // Flip horizontally
      right.rotation = -rotationRad; // Counter-rotate for flipped sprite

      container.addChild(left, right);
    } else {
      // Split mode: split door frame texture in half
      const pillarWidthPx = Math.max(1, Math.min(base.height, Math.floor(base.width / 2)));
      const pillarWidthScene = pillarWidthPx * assetScale;
      const targetWidth = Math.max(docWidth, pillarWidthScene * 2 + 1, gapLength + pillarWidthScene * 2);
      const offsetXPx = offsetX * targetWidth * 0.5;
      const offsetYPx = offsetY * heightScene * 0.5;
      const leftRect = new PIXI.Rectangle(0, 0, pillarWidthPx, base.height);
      const rightRect = new PIXI.Rectangle(Math.max(0, base.width - pillarWidthPx), 0, pillarWidthPx, base.height);
      const leftTex = new PIXI.Texture(base, leftRect);
      const rightTex = new PIXI.Texture(base, rightRect);
      const left = new PIXI.Sprite(leftTex);
      left.anchor.set(0.5, 0.5);
      left.position.set(pillarWidthScene * 0.5 + offsetXPx, heightScene * 0.5 + offsetYPx);
      left.scale.set(assetScale, assetScale);
      const right = new PIXI.Sprite(rightTex);
      right.anchor.set(0.5, 0.5);
      right.position.set(targetWidth - pillarWidthScene * 0.5 - offsetXPx, heightScene * 0.5 + offsetYPx);
      right.scale.set(assetScale, assetScale);
      container.addChild(left, right);
    }

    container.alpha = 1;
    applyHsbcToDisplayObject(container, readDocumentHsbc(doc));
    setContainerTransform(container, mesh, doc);
    attachCustomTileOverhead(tile, {
      kind: 'building-door-frame',
      contentContainer: container,
      proxyFactory: createDisplayProxyFactory(container),
      syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
        setContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    try {
      syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), 'building-door-frame-refresh');
    } catch (error) {
      Logger.warn?.('BuildingTiles.doorFrame.standardMaskSuppression.failed', {
        tileId: tile?.document?.id,
        error: String(error?.message || error)
      });
    }
    invalidateCustomTileOverhead(tile, 'building-door-frame-refresh');
  } catch (error) {
    Logger.warn?.('BuildingTiles.doorFrame.apply.failed', { error: String(error?.message || error) });
  }
}

export async function applyBuildingCompositeTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    if (isEditingTile(tile)) {
      cleanupBuildingCompositeOverlay(tile);
      return;
    }
    const data = doc?.getFlag?.('fa-nexus', 'buildingComposite');
    if (!data) {
      cleanupBuildingCompositeOverlay(tile);
      return;
    }
    if (data?.role === 'foreground' && doc?.getFlag?.('fa-nexus', 'building')) {
      cleanupBuildingCompositeOverlay(tile);
      return;
    }
    const parts = Array.isArray(data?.parts) ? data.parts.filter((part) => part && typeof part === 'object') : [];
    if (!parts.length) {
      cleanupBuildingCompositeOverlay(tile);
      return;
    }

    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;

    const renderKey = buildRenderKey('buildingComposite', {
      tile: getTileRenderSignature(doc),
      data
    }, doc?.id);
    const reusableContainer = tile.faNexusBuildingCompositeContainer || mesh.faNexusBuildingCompositeContainer;
    if (
      renderKey
      && reusableContainer?.faNexusBuildingCompositeRenderKey === renderKey
      && hasRenderableChildren(reusableContainer)
    ) {
      syncReusableBuildingCompositeRuntime(tile, mesh, doc, reusableContainer, 'building-composite-reuse');
      return;
    }

    const container = ensureBuildingCompositeContainer(tile, mesh);
    cleanupContainerChildren(container);
    container.name = 'fa-nexus-building-composite';
    container.alpha = 1;
    container.faNexusBuildingCompositeRenderKey = renderKey;

    const orderedParts = parts
      .map((part, index) => ({ ...part, __index: index }))
      .sort((left, right) => {
        const sortDelta = (Number(left?.sort) || 0) - (Number(right?.sort) || 0);
        if (Math.abs(sortDelta) > 1e-6) return sortDelta;
        return (Number(left?.__index) || 0) - (Number(right?.__index) || 0);
      });
    let renderedCount = 0;
    for (const part of orderedParts) {
      if (await addCompositePart(container, doc, part)) renderedCount += 1;
    }
    if (!renderedCount) {
      cleanupBuildingCompositeOverlay(tile);
      return;
    }

    setContainerTransform(container, mesh, doc);
    if (data?.role === 'background') raiseBackgroundCompositeAboveFill(tile, mesh, container);
    attachCustomTileOverhead(tile, {
      kind: 'building-composite',
      contentContainer: container,
      proxyFactory: createDisplayProxyFactory(container),
      syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
        setContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    try {
      syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), 'building-composite-refresh');
    } catch (error) {
      Logger.warn?.('BuildingTiles.buildingComposite.standardMaskSuppression.failed', {
        tileId: tile?.document?.id,
        error: String(error?.message || error)
      });
    }
    invalidateCustomTileOverhead(tile, 'building-composite-refresh');
  } catch (error) {
    Logger.warn?.('BuildingTiles.buildingComposite.apply.failed', { error: String(error?.message || error) });
  }
}

export function rehydrateBuildingTiles() {
  try {
    if (!canvas?.ready) return;
    const tiles = Array.isArray(canvas.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) {
      try {
        const data = tile?.document?.getFlag?.('fa-nexus', 'building');
        if (data) applyBuildingTile(tile);
        else cleanupBuildingOverlay(tile);

        const frameData = tile?.document?.getFlag?.('fa-nexus', 'buildingDoorFrame');
        if (frameData) applyDoorFrameTile(tile);
        else cleanupDoorFrameOverlay(tile);

        const compositeData = tile?.document?.getFlag?.('fa-nexus', 'buildingComposite');
        if (compositeData) applyBuildingCompositeTile(tile);
        else cleanupBuildingCompositeOverlay(tile);
      } catch (_) {}
    }
  } catch (_) {}
}

export function clearBuildingTileMeshWaiters() {
  clearSharedTileMeshWaiters('BuildingTiles.clearBuildingTileMeshWaiters');
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
        if (!linkedTile || linkedTile?._destroyed || linkedGroupId !== groupId) {
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
        if (!wall || wall?._destroyed || !flag) {
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
          || linkedTile?._destroyed
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
    await resolvedScene.deleteEmbeddedDocuments('Region', [...regionIds]);
    Logger.info?.('BuildingTiles.delete.regions.deleted', {
      tileId: doc.id || null,
      wallGroupId: wallGroupId || null,
      regionIds: [...regionIds]
    });
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.regions.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function cleanupLinkedBuildingTiles(doc, options = {}) {
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
      const triggerOptions = isFillTrigger
        ? { [SKIP_LINKED_BUILDING_FILL_DELETE_OPTION]: true }
        : null;
      await deleteLinkedTilesRobustly(
        scene,
        ownerTileIds,
        triggerOptions,
        isFillTrigger ? 'BuildingTiles.delete.fillOwners' : 'BuildingTiles.delete.sillOwners'
      );
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

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateBuildingTiles(); } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    try { applyBuildingTile(tile); } catch (_) {}
    try { applyDoorFrameTile(tile); } catch (_) {}
    try { applyBuildingCompositeTile(tile); } catch (_) {}
  });
  Hooks.on('updateTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        applyBuildingTile(tile);
        applyDoorFrameTile(tile);
        applyBuildingCompositeTile(tile);
      }
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc, options) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        cleanupBuildingOverlay(tile);
        cleanupDoorFrameOverlay(tile);
        cleanupBuildingCompositeOverlay(tile);
      }
    } catch (_) {}
    if (!shouldSkipLinkedBuildingDeletes(doc, options)) {
      Promise.resolve(cleanupLinkedBuildingTiles(doc, options)).catch((error) => {
        Logger.warn?.('BuildingTiles.deleteTile.cleanup.failed', {
          tileId: doc?.id || null,
          error: String(error?.message || error)
        });
      });
    }
  });
  Hooks.on('canvasTearDown', () => {
    try { clearBuildingTileMeshWaiters(); } catch (_) {}
  });
} catch (_) {}
