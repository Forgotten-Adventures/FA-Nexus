import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  getCurrentLevelElevationRange,
  getCurrentSceneLevel,
  getCurrentViewedLevelIds,
  getSceneLevelElevationRanges,
  isElevationWithinCurrentLevelEditScope
} from '../canvas/elevation-band-utils.js';
import { analyzeTileBandState } from '../canvas/tile-band-utils.js';
import {
  getRawLevelIds,
  hasOwnLevelField
} from '../canvas/tile-document-payloads.js';

export const LEVEL_BAND_SIZE = 1;
export const LEVEL_ELEVATION_EPSILON = 1e-6;

const ambiguousLevelBandWarnings = new Set();
const STRICT_MEMBERSHIP_LOGGING = Object.freeze({
  warnOnExplicitMismatch: true,
  logHelperFailures: true
});

export function normalizeLevelId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function normalizeLevelIds(values) {
  return Array.isArray(values)
    ? values.map((levelId) => normalizeLevelId(levelId)).filter(Boolean)
    : [];
}

export function getLevelRangeDisplayName(range, fallback = 'Level') {
  const name = String(range?.levelName || '').trim();
  if (name) return name;
  const levelName = String(range?.level?.name || '').trim();
  if (levelName) return levelName;
  const levelId = normalizeLevelId(range?.levelId);
  return levelId || fallback;
}

export function describeLevelRange(range) {
  const label = getLevelRangeDisplayName(range, 'level');
  const bottom = Number(range?.bottom);
  const top = Number(range?.top);
  if (Number.isFinite(bottom) && Number.isFinite(top)) return `${label} (${bottom} to ${top})`;
  return label;
}

export function getTileElevationValue(doc) {
  const raw = Number(doc?.elevation ?? doc?._source?.elevation ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

export function getDocumentMembershipInLevel(doc, levelId, {
  logger = Logger,
  preferHelperForExplicitLevels = false,
  nullWhenHelperUndefined = false,
  warnOnExplicitMismatch = false,
  logHelperFailures = false
} = {}) {
  const normalizedLevelId = normalizeLevelId(levelId);
  if (!normalizedLevelId) return null;

  const hasExplicitLevels = hasOwnLevelField(doc) || hasOwnLevelField(doc?._source) || !!doc?.schema?.has?.('levels');
  if (hasExplicitLevels) {
    const levelIds = getRawLevelIds(doc);
    const included = !levelIds.length || levelIds.includes(normalizedLevelId);
    if (typeof doc?.includedInLevel === 'function') {
      try {
        const helperResult = doc.includedInLevel(normalizedLevelId);
        if (preferHelperForExplicitLevels && helperResult !== undefined) return !!helperResult;
        const helperIncluded = !!helperResult;
        if (warnOnExplicitMismatch && helperIncluded !== included) {
          logger?.warn?.('TileFlatten.levelMembershipCheck.mismatch', {
            tileId: doc?.id || null,
            levelId: normalizedLevelId,
            helperIncluded,
            explicitIncluded: included,
            explicitLevels: levelIds
          });
        }
      } catch (error) {
        if (logHelperFailures) {
          logger?.warn?.('TileFlatten.levelMembershipCheck.failed', {
            tileId: doc?.id || null,
            levelId: normalizedLevelId,
            error: String(error?.message || error)
          });
        }
      }
    }
    return included;
  }

  if (typeof doc?.includedInLevel === 'function') {
    try {
      const helperResult = doc.includedInLevel(normalizedLevelId);
      if (nullWhenHelperUndefined && helperResult === undefined) return null;
      return !!helperResult;
    } catch (error) {
      if (logHelperFailures) {
        logger?.warn?.('TileFlatten.levelMembershipCheck.failed', {
          tileId: doc?.id || null,
          levelId: normalizedLevelId,
          error: String(error?.message || error)
        });
      }
    }
  }

  return null;
}

export function getTileMembershipInCurrentViewedLevel(doc, { scene = canvas?.scene } = {}) {
  const currentLevelId = getCurrentViewedLevelId(scene);
  if (!currentLevelId) return null;
  return getDocumentMembershipInLevel(doc, currentLevelId, STRICT_MEMBERSHIP_LOGGING);
}

export function getCurrentViewedLevelId(scene = canvas?.scene) {
  const levelIds = getCurrentViewedLevelIds(scene);
  const levelId = Array.isArray(levelIds) ? levelIds[0] : null;
  return normalizeLevelId(levelId);
}

export function isElevationWithinLevelExportRangeValue(elevation, range) {
  const numeric = Number(elevation);
  if (!Number.isFinite(numeric) || !range) return false;
  const bottom = Number(range.bottom);
  const top = Number(range.top);
  if (Number.isFinite(bottom) && numeric < (bottom - LEVEL_ELEVATION_EPSILON)) return false;
  if (Number.isFinite(top) && numeric >= (top + LEVEL_BAND_SIZE - LEVEL_ELEVATION_EPSILON)) return false;
  return true;
}

export function getTileBandAnalysisForFlatten(doc, { scene = canvas?.scene, logger = Logger } = {}) {
  try {
    return analyzeTileBandState(doc, {
      scene,
      // Placement ownership is independent of the optional token render offset.
      enabled: true,
      visibleLevelIds: getRawLevelIds(doc),
      requireVisibleMembership: false,
      allowSingleLevelInference: true,
      allowCurrentLevelFallback: false
    });
  } catch (error) {
    logger?.warn?.('TileFlatten.levelBand.analysisFailed', {
      tileId: doc?.id || null,
      error: String(error?.message || error)
    });
    return null;
  }
}

function warnAmbiguousLevelBand(doc, range, analysis, { logger = Logger } = {}) {
  const levelId = normalizeLevelId(range?.levelId);
  const tileId = doc?.id || doc?._id || null;
  const key = `${canvas?.scene?.id || 'scene'}:${tileId || 'unknown'}:${levelId || 'level'}`;
  if (ambiguousLevelBandWarnings.has(key)) return;
  ambiguousLevelBandWarnings.add(key);
  logger?.warn?.('TileFlatten.levelBand.ambiguousPlacementLevel', {
    tileId,
    tileName: doc?.name || doc?.texture?.src || null,
    levelId,
    levelName: getLevelRangeDisplayName(range, ''),
    elevation: getTileElevationValue(doc),
    candidates: Array.isArray(analysis?.candidates)
      ? analysis.candidates.map((candidate) => ({
        kind: candidate?.kind || null,
        levelId: normalizeLevelId(candidate?.placementLevelId)
      }))
      : []
  });
}

function mapBandAnalysisKindToLayerRole(kind) {
  if (kind === 'ground') return 'background';
  if (kind === 'foreground') return 'foreground';
  return null;
}

export function resolveTileLevelLayerRole(doc, range, { scene = canvas?.scene, logger = Logger, rejectAmbiguous = false } = {}) {
  if (!doc || !range) return null;
  const levelId = normalizeLevelId(range?.levelId);
  if (levelId) {
    const membership = getDocumentMembershipInLevel(doc, levelId, { logger, ...STRICT_MEMBERSHIP_LOGGING });
    if (membership === false) return null;
  }

  const elevation = getTileElevationValue(doc);
  if (!isElevationWithinLevelExportRangeValue(elevation, range)) return null;

  const analysis = getTileBandAnalysisForFlatten(doc, { scene, logger });
  if (analysis?.inSpecialBand) {
    const placementLevelId = normalizeLevelId(analysis?.placementLevelId);
    if (placementLevelId) {
      if (levelId && placementLevelId !== levelId) return null;
      const role = mapBandAnalysisKindToLayerRole(analysis?.kind);
      if (role) return role;
    } else {
      const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
      const matching = levelId
        ? candidates.filter((candidate) => normalizeLevelId(candidate?.placementLevelId) === levelId)
        : candidates;
      if (matching.length === 1 && candidates.length === 1) {
        const role = mapBandAnalysisKindToLayerRole(matching[0]?.kind);
        if (role) return role;
      }
      if (matching.length) {
        if (rejectAmbiguous) {
          throw new Error(`Ambiguous Level placement for Tile "${doc.name || doc.id}" (${doc.id}). Assign this Tile to a Level in Layer Manager before flattening or exporting.`);
        }
        warnAmbiguousLevelBand(doc, range, analysis, { logger });
      }
      return null;
    }
  }

  const bottom = Number(range?.bottom);
  const top = Number(range?.top);
  if (Number.isFinite(top) && elevation >= (top - LEVEL_ELEVATION_EPSILON)) return 'foreground';
  const base = Number(range?.base ?? bottom);
  if (Number.isFinite(base) && elevation >= base - LEVEL_ELEVATION_EPSILON
    && elevation < (base + LEVEL_BAND_SIZE - LEVEL_ELEVATION_EPSILON)) return 'background';
  return 'middle';
}

export function isTileInCurrentLevelEditScope(doc, { scene = canvas?.scene } = {}) {
  const range = getCurrentLevelElevationRange(scene);
  if (range) {
    if (resolveTileLevelLayerRole(doc, range, { scene })) return true;
    const analysis = getTileBandAnalysisForFlatten(doc, { scene });
    if (analysis?.inSpecialBand) return false;
  }
  const membership = getTileMembershipInCurrentViewedLevel(doc, { scene });
  if (membership === false) return false;
  return isElevationWithinCurrentLevelEditScope(getTileElevationValue(doc), { scene });
}

export function describeCurrentLevelEditScope(scene = canvas?.scene) {
  const range = getCurrentLevelElevationRange(scene);
  if (!range) return 'current viewed level';
  if (range.levelName) return `level "${range.levelName}"`;
  const bottom = Number(range.bottom);
  const top = Number(range.top);
  if (Number.isFinite(bottom) && Number.isFinite(top)) {
    return `current viewed level (${bottom} to ${top})`;
  }
  return 'current viewed level';
}

export function getFlattenExportLevelRanges(scope = 'level', { scene = canvas?.scene } = {}) {
  const ranges = getSceneLevelElevationRanges(scene);
  if (scope === 'scene') return ranges;

  const currentRange = getCurrentLevelElevationRange(scene);
  if (currentRange) return [currentRange];

  const currentLevel = getCurrentSceneLevel(scene);
  const currentLevelId = normalizeLevelId(currentLevel?.id);
  const byCurrentLevel = currentLevelId
    ? ranges.find((range) => normalizeLevelId(range?.levelId) === currentLevelId)
    : null;
  if (byCurrentLevel) return [byCurrentLevel];
  if (ranges.length === 1) return [ranges[0]];
  return [];
}

export function buildFlattenDoorVisibility(minElevation = null, maxElevation = null, { levelIds = [] } = {}) {
  const visibility = {};
  const min = Number(minElevation);
  const max = Number(maxElevation);
  if (minElevation != null && Number.isFinite(min)) visibility.minElevation = min;
  if (maxElevation != null && Number.isFinite(max)) visibility.maxElevation = max;
  const normalizedLevelIds = normalizeLevelIds(levelIds);
  if (normalizedLevelIds.length) visibility.levelIds = Array.from(new Set(normalizedLevelIds));
  return Object.keys(visibility).length ? visibility : null;
}

export function resolveFlattenedTileParentLevelId(metadata, fallbackLevels = []) {
  const explicit = normalizeLevelId(metadata?.levelRange?.levelId);
  if (explicit) return explicit;
  const levelIds = Array.isArray(metadata?.levelIds) ? normalizeLevelIds(metadata.levelIds) : [];
  if (levelIds.length === 1) return levelIds[0];
  const fallback = Array.isArray(fallbackLevels) ? normalizeLevelIds(fallbackLevels) : [];
  return fallback.length === 1 ? fallback[0] : null;
}

export function resolveUniformLevelMembership(documents = [], { logger = Logger } = {}) {
  const list = Array.isArray(documents) ? documents : [];
  const memberships = new Map();

  for (const doc of list) {
    const levelIds = getRawLevelIds(doc);
    const key = JSON.stringify(levelIds);
    if (!memberships.has(key)) memberships.set(key, levelIds);
  }

  if (memberships.size <= 1) return Array.from(memberships.values())[0] || [];

  const variants = Array.from(memberships.values());
  logger?.error?.('TileFlatten.flattenTiles.mixedLevelMembership', {
    memberships: variants,
    tileIds: list.map((doc) => doc?.id).filter(Boolean)
  });
  throw new Error('Cannot flatten tiles with mixed level membership. Flatten one visibility group at a time.');
}

export function resolveFlattenedTileLevels(metadata, { logger = Logger } = {}) {
  if (Array.isArray(metadata?.levelIds)) return normalizeLevelIds(metadata.levelIds);
  const entries = Array.isArray(metadata?.tiles) ? metadata.tiles : [];
  return resolveUniformLevelMembership(entries.map((entry) => entry?.data).filter(Boolean), { logger });
}

export function buildFlattenLevelRangeMetadata(levelRange) {
  return levelRange ? {
    levelId: normalizeLevelId(levelRange.levelId),
    levelName: String(levelRange.levelName || levelRange.level?.name || '').trim(),
    bottom: Number.isFinite(Number(levelRange.bottom)) ? Number(levelRange.bottom) : null,
    top: Number.isFinite(Number(levelRange.top)) ? Number(levelRange.top) : null
  } : null;
}
