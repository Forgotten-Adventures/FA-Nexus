import { NexusLogger as Logger } from '../core/nexus-logger.js';

const MODULE_ID = 'fa-nexus';
const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

const state = {
  snapshot: null
};

function nowMs() {
  try { return Date.now(); }
  catch (_) { return 0; }
}

function getSceneId(scene = canvas?.scene) {
  return String(scene?.id || '').trim() || null;
}

function getTileDocument(target) {
  return target?.document || target || null;
}

function getTileId(target) {
  const doc = getTileDocument(target);
  return String(doc?.id || target?.id || '').trim();
}

function getControlledTiles(controlledTiles = canvas?.tiles?.controlled) {
  if (!Array.isArray(controlledTiles)) return [];
  return controlledTiles
    .filter((tile) => tile && !tile.destroyed)
    .filter((tile) => !!getTileId(tile));
}

function getTileSelectionTargets(targets = []) {
  if (!Array.isArray(targets)) return [];
  const byId = new Map();
  for (const target of targets) {
    if (!target || target.destroyed) continue;
    const doc = getTileDocument(target);
    const id = getTileId(target);
    if (!id || !doc || byId.has(id)) continue;
    byId.set(id, target);
  }
  return [...byId.values()];
}

function getDocumentLevelIds(doc) {
  const source = doc?.levels instanceof Set || Array.isArray(doc?.levels)
    ? Array.from(doc.levels)
    : (Array.isArray(doc?._source?.levels) ? doc._source.levels : []);
  return Array.from(new Set(source
    .map((levelId) => String(levelId || '').trim())
    .filter(Boolean)));
}

function createSnapshot(tiles, source = 'unknown') {
  const sceneId = getSceneId();
  const entries = [];
  for (const tile of tiles) {
    const doc = getTileDocument(tile);
    const id = getTileId(tile);
    if (!id || !doc) continue;
    entries.push({
      id,
      elevation: Number(doc?.elevation ?? tile?.elevation),
      sort: Number(doc?.sort ?? tile?.sort),
      levels: getDocumentLevelIds(doc)
    });
  }
  if (!sceneId || !entries.length) return null;
  return {
    sceneId,
    source: String(source || 'unknown'),
    capturedAt: nowMs(),
    entries
  };
}

function findSceneTileDocument(tileId, scene = canvas?.scene) {
  const id = String(tileId || '').trim();
  if (!id || !scene) return null;
  try {
    const doc = scene.tiles?.get?.(id);
    if (doc) return doc;
  } catch (_) {}
  try {
    const contents = Array.isArray(scene.tiles?.contents)
      ? scene.tiles.contents
      : (scene.tiles && typeof scene.tiles[Symbol.iterator] === 'function' ? Array.from(scene.tiles) : []);
    return contents.find((doc) => String(doc?.id || '').trim() === id) || null;
  } catch (_) {}
  return null;
}

function resolveSnapshotTile(entry, scene = canvas?.scene) {
  const id = String(entry?.id || '').trim();
  if (!id) return null;
  try {
    const placeable = canvas?.tiles?.placeables?.find?.((tile) => String(tile?.document?.id || tile?.id || '').trim() === id);
    if (placeable && !placeable.destroyed) return placeable;
  } catch (_) {}
  const doc = findSceneTileDocument(id, scene);
  if (!doc) return null;
  return {
    id,
    document: doc,
    elevation: doc.elevation,
    sort: doc.sort
  };
}

function getSnapshotAge(snapshot) {
  const capturedAt = Number(snapshot?.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return Infinity;
  return Math.max(0, nowMs() - capturedAt);
}

function isSnapshotUsable(snapshot, { scene = canvas?.scene } = {}) {
  if (!snapshot || !Array.isArray(snapshot.entries) || !snapshot.entries.length) return false;
  const activeSceneId = getSceneId(scene);
  if (!activeSceneId || snapshot.sceneId !== activeSceneId) return false;
  return getSnapshotAge(snapshot) <= SNAPSHOT_MAX_AGE_MS;
}

function resolveSnapshot(snapshot, { scene = canvas?.scene } = {}) {
  if (!isSnapshotUsable(snapshot, { scene })) return [];
  const resolved = [];
  for (const entry of snapshot.entries) {
    const tile = resolveSnapshotTile(entry, scene);
    if (tile) resolved.push(tile);
  }
  return resolved;
}

export function preserveCurrentTileSelectionForNexus(source = 'unknown', {
  controlledTiles = canvas?.tiles?.controlled
} = {}) {
  return preserveTileSelectionTargetsForNexus(source, getControlledTiles(controlledTiles), {
    emptyScope: 'current'
  });
}

function preserveTileSelectionTargetsForNexus(source = 'unknown', targets = [], {
  emptyScope = 'targets'
} = {}) {
  const selectedTargets = getTileSelectionTargets(targets);
  if (!selectedTargets.length) {
    Logger.debug('TileSelectionContext.preserve.skippedEmpty', {
      source,
      emptyScope,
      hasSnapshot: !!state.snapshot,
      snapshotAgeMs: state.snapshot ? getSnapshotAge(state.snapshot) : null
    });
    return false;
  }

  const snapshot = createSnapshot(selectedTargets, source);
  if (!snapshot) {
    Logger.warn('TileSelectionContext.preserve.failed', {
      source,
      targetCount: selectedTargets.length,
      sceneId: getSceneId()
    });
    return false;
  }

  state.snapshot = snapshot;
  Logger.debug('TileSelectionContext.preserve.captured', {
    source,
    sceneId: snapshot.sceneId,
    tileIds: snapshot.entries.map((entry) => entry.id),
    elevations: snapshot.entries.map((entry) => Number.isFinite(entry.elevation) ? entry.elevation : null)
  });
  return true;
}

export function preserveTileSelectionDocumentsForNexus(source = 'unknown', documents = []) {
  return preserveTileSelectionTargetsForNexus(source, documents, {
    emptyScope: 'documents'
  });
}

export function resolveTileSelectionForNexusPlacement({
  source = 'unknown',
  controlledTiles = canvas?.tiles?.controlled,
  scene = canvas?.scene
} = {}) {
  const controlled = getControlledTiles(controlledTiles);
  if (controlled.length) return controlled;

  const snapshot = state.snapshot;
  if (!snapshot) return [];
  if (!isSnapshotUsable(snapshot, { scene })) {
    Logger.debug('TileSelectionContext.restore.rejected', {
      source,
      reason: 'stale-or-scene-mismatch',
      snapshotSceneId: snapshot.sceneId || null,
      activeSceneId: getSceneId(scene),
      snapshotAgeMs: getSnapshotAge(snapshot)
    });
    return [];
  }

  const resolved = resolveSnapshot(snapshot, { scene });
  if (!resolved.length) {
    Logger.warn('TileSelectionContext.restore.failed', {
      source,
      snapshotSceneId: snapshot.sceneId || null,
      tileIds: snapshot.entries.map((entry) => entry.id)
    });
    return [];
  }

  Logger.debug('TileSelectionContext.restore.used', {
    source,
    snapshotSource: snapshot.source,
    ageMs: getSnapshotAge(snapshot),
    tileIds: resolved.map((tile) => getTileId(tile)).filter(Boolean)
  });
  return resolved;
}

export function clearNexusTileSelectionContext(source = 'unknown') {
  if (!state.snapshot) return false;
  Logger.debug('TileSelectionContext.clear', {
    source,
    snapshotSource: state.snapshot.source,
    tileIds: state.snapshot.entries.map((entry) => entry.id)
  });
  state.snapshot = null;
  return true;
}

export function installNexusTileSelectionContextHooks() {
  try {
    const hooks = globalThis?.Hooks;
    if (!hooks || hooks._faNexusTileSelectionContextInstalled) return;
    hooks._faNexusTileSelectionContextInstalled = true;
    hooks.on('canvasTearDown', () => clearNexusTileSelectionContext('canvas-teardown'));
    hooks.on('deleteTile', (doc) => {
      const id = String(doc?.id || '').trim();
      if (!id || !state.snapshot?.entries?.some((entry) => entry.id === id)) return;
      clearNexusTileSelectionContext('deleteTile');
    });
  } catch (error) {
    Logger.warn('TileSelectionContext.hooks.installFailed', {
      moduleId: MODULE_ID,
      error: String(error?.message || error)
    });
  }
}
