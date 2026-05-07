import { NexusLogger as Logger } from '../core/nexus-logger.js';

const MODULE_ID = 'fa-nexus';
const MIN_LEGACY_PATH_POINTS = 2;
const MIGRATING_TILE_IDS = new Set();

function stringifyError(error) {
  return String(error?.message || error);
}

function readModuleFlag(doc, key) {
  try {
    const direct = doc?.getFlag?.(MODULE_ID, key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  try {
    const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
    return flags ? flags[key] : undefined;
  } catch (_) {
    return undefined;
  }
}

function cloneFlagPayload(value) {
  if (!value || typeof value !== 'object') return null;
  return JSON.parse(JSON.stringify(value));
}

function hasPathV2Data(doc) {
  const v2 = readModuleFlag(doc, 'pathV2');
  if (v2 && Array.isArray(v2.controlPoints) && v2.controlPoints.length >= MIN_LEGACY_PATH_POINTS) return true;
  const merged = readModuleFlag(doc, 'pathsV2');
  return !!(merged && Array.isArray(merged.paths) && merged.paths.some((entry) => (
    entry && Array.isArray(entry.controlPoints) && entry.controlPoints.length >= MIN_LEGACY_PATH_POINTS
  )));
}

function hasLegacyPathData(doc) {
  const legacy = readModuleFlag(doc, 'path');
  return !!(legacy && Array.isArray(legacy.controlPoints) && legacy.controlPoints.length >= MIN_LEGACY_PATH_POINTS);
}

function isActiveGm() {
  try {
    const currentUser = game?.user;
    return !!currentUser?.isGM;
  } catch (_) {
    return false;
  }
}

export function shouldMigrateLegacyPathTile(doc) {
  if (!doc) return false;
  if (hasPathV2Data(doc)) return false;
  return hasLegacyPathData(doc);
}

export function buildMigratedPathV2Flag(doc, { now = Date.now() } = {}) {
  const legacyFlag = readModuleFlag(doc, 'path');
  if (!legacyFlag || typeof legacyFlag !== 'object') {
    throw new Error('Tile does not contain legacy FA Nexus path data.');
  }
  const controlPoints = Array.isArray(legacyFlag.controlPoints) ? legacyFlag.controlPoints : [];
  if (controlPoints.length < MIN_LEGACY_PATH_POINTS) {
    throw new Error('Legacy FA Nexus path data has insufficient control points.');
  }

  const migrated = cloneFlagPayload(legacyFlag);
  if (!migrated || typeof migrated !== 'object') {
    throw new Error('Legacy FA Nexus path data could not be cloned.');
  }
  migrated.version = 2;
  if (!Number.isFinite(Number(migrated.elevation)) && Number.isFinite(Number(doc?.elevation))) {
    migrated.elevation = Number(doc.elevation);
  }
  if (!Number.isFinite(Number(migrated.updatedAt))) migrated.updatedAt = now;
  migrated.migratedFrom = 'path';
  migrated.migratedAt = now;
  return migrated;
}

export async function migrateLegacyPathTileDocument(doc, { reason = 'unspecified', requireGm = true } = {}) {
  const tileId = doc?.id || doc?._id || null;
  if (!doc || !tileId) return { migrated: false, skipped: 'missing-document' };
  if (requireGm && !isActiveGm()) return { migrated: false, skipped: 'not-gm' };
  if (!shouldMigrateLegacyPathTile(doc)) return { migrated: false, skipped: 'not-legacy-path' };
  if (MIGRATING_TILE_IDS.has(tileId)) return { migrated: false, skipped: 'already-migrating' };

  MIGRATING_TILE_IDS.add(tileId);
  try {
    const migrated = buildMigratedPathV2Flag(doc);
    await doc.update({
      'flags.fa-nexus.pathV2': migrated,
      'flags.fa-nexus.path': null
    }, {
      diff: false,
      faNexusLegacyPathMigration: true,
      reason
    });
    Logger.info?.('LegacyPathMigration.tile.migrated', {
      tileId,
      reason,
      points: Array.isArray(migrated.controlPoints) ? migrated.controlPoints.length : 0
    });
    return { migrated: true, tileId };
  } catch (error) {
    Logger.error?.('LegacyPathMigration.tile.failed', {
      tileId,
      reason,
      error: stringifyError(error)
    });
    throw error;
  } finally {
    MIGRATING_TILE_IDS.delete(tileId);
  }
}

function collectSceneTileDocuments(scene) {
  try {
    const contents = scene?.tiles?.contents;
    if (Array.isArray(contents)) return contents.filter(Boolean);
  } catch (_) {}
  try {
    const collection = scene?.tiles;
    if (collection && typeof collection[Symbol.iterator] === 'function') return Array.from(collection).filter(Boolean);
  } catch (_) {}
  return [];
}

export async function migrateLegacyPathTilesInScene(scene = canvas?.scene, { reason = 'scene-scan' } = {}) {
  if (!isActiveGm()) return { scanned: 0, migrated: 0, skipped: 'not-gm' };
  const docs = collectSceneTileDocuments(scene);
  let migrated = 0;
  for (const doc of docs) {
    if (!shouldMigrateLegacyPathTile(doc)) continue;
    try {
      const result = await migrateLegacyPathTileDocument(doc, { reason, requireGm: false });
      if (result?.migrated) migrated += 1;
    } catch (error) {
      Logger.error?.('LegacyPathMigration.sceneTile.failed', {
        sceneId: scene?.id || null,
        tileId: doc?.id || null,
        reason,
        error: stringifyError(error)
      });
    }
  }
  if (migrated > 0) {
    Logger.info?.('LegacyPathMigration.scene.completed', {
      sceneId: scene?.id || null,
      reason,
      scanned: docs.length,
      migrated
    });
  }
  return { scanned: docs.length, migrated };
}
