import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { resolveTileSelectionForNexusPlacement } from './tile-selection-context.js';
const MODULE_ID = 'fa-nexus';
const SETTING_KEY = 'tokenElevationOffset';
const BAND_SIZE = 1;
const DEFAULT_LEVEL_BASE = 0;
const EPSILON = 1e-6;
const GROUND_BAND_SORT_SCALE = 1_000_000;
const GROUND_BAND_DOCUMENT_SORT_SCALE = 1_000_000;
const GROUND_BAND_SORT_LEAK_MIN = 100_000;
const GROUND_BAND_SORT_LEAK_MAX_REMAINDER = 100_000;
const CURRENT_LEVEL_RESOLUTION_WARNED = new Set();
let tokenElevationOffsetReadWarned = false;

export function isKeepTokensAboveTileElevationsEnabled() {
  try {
    return game?.settings?.get?.(MODULE_ID, SETTING_KEY) !== false;
  } catch (error) {
    if (!tokenElevationOffsetReadWarned) {
      tokenElevationOffsetReadWarned = true;
      Logger.warn('ElevationBand.tokenElevationOffset.readFailed', {
        error: String(error?.message || error)
      });
    }
    return true;
  }
}

export function getSceneLevels(scene = canvas?.scene) {
  const explicitSorted = Array.isArray(scene?.levels?.sorted) ? scene.levels.sorted.slice() : null;
  const levels = explicitSorted ?? (scene?.levels ? Array.from(scene.levels) : []);
  return levels.filter(Boolean);
}

function getLevelBottomElevation(level) {
  const numeric = Number(level?.elevation?.bottom);
  return Number.isFinite(numeric) ? numeric : DEFAULT_LEVEL_BASE;
}

function getLevelTopElevation(level) {
  const numeric = Number(level?.elevation?.top);
  return Number.isFinite(numeric) ? numeric : Infinity;
}

export function getLevelElevationRange(level) {
  if (!level) return null;
  return {
    level,
    levelId: level.id || null,
    levelName: String(level?.name || '').trim(),
    bottom: getLevelBottomElevation(level),
    top: getLevelTopElevation(level)
  };
}

export function getSceneLevelElevationRanges(scene = canvas?.scene) {
  return getSceneLevels(scene)
    .map((level) => getLevelElevationRange(level))
    .filter(Boolean);
}

function rangesShareBoundary(lowerRange, upperRange) {
  const lowerTop = Number(lowerRange?.top);
  const upperBottom = Number(upperRange?.bottom);
  if (!Number.isFinite(lowerTop) || !Number.isFinite(upperBottom)) return false;
  return Math.abs(lowerTop - upperBottom) <= EPSILON;
}

function isElevationWithinLevelRange(elevation, range, { nextRange = null } = {}) {
  const numeric = Number(elevation);
  if (!Number.isFinite(numeric) || !range) return false;
  if (numeric < (range.bottom - EPSILON)) return false;
  if (rangesShareBoundary(range, nextRange)) {
    return numeric < (range.top - EPSILON);
  }
  if (numeric > (range.top + EPSILON)) return false;
  return true;
}

function getSceneLevelBandBases(scene = canvas?.scene) {
  const levels = getSceneLevels(scene);
  const bases = [];
  const seen = new Set();
  for (const level of levels) {
    const base = getLevelBottomElevation(level);
    if (!Number.isFinite(base)) continue;
    const key = String(base);
    if (seen.has(key)) continue;
    seen.add(key);
    bases.push(base);
  }
  if (!bases.length) return [DEFAULT_LEVEL_BASE];
  return bases.sort((left, right) => left - right);
}

export function getCurrentSceneLevel(scene = canvas?.scene) {
  try {
    if (scene && scene === canvas?.scene && canvas?.level?.parent === scene) return canvas.level;
  } catch (_) {}

  const viewId = scene?._view ?? scene?._viewPosition?.level ?? scene?.initialLevel?.id ?? scene?.initialLevel ?? null;
  try {
    if (viewId && scene?.levels?.get) {
      const level = scene.levels.get(viewId);
      if (level) return level;
    }
  } catch (_) {}

  const levels = getSceneLevels(scene);
  if (levels.length) {
    const sceneKey = String(scene?.id || scene?.name || 'unknown-scene');
    if (!CURRENT_LEVEL_RESOLUTION_WARNED.has(sceneKey)) {
      CURRENT_LEVEL_RESOLUTION_WARNED.add(sceneKey);
      Logger.warn('ElevationBand.currentLevel.unresolved', {
        sceneId: scene?.id || null,
        sceneName: scene?.name || null,
        levelCount: levels.length,
        viewId: viewId || null,
        canvasLevelId: canvas?.level?.id || null
      });
    }
  }
  return null;
}

/**
 * Return a `levels[]` membership array that scopes document visibility to only the current viewed level.
 */
export function getCurrentViewedLevelIds(scene = canvas?.scene) {
  const level = getCurrentSceneLevel(scene);
  const levelId = String(level?.id || '').trim();
  return levelId ? [levelId] : [];
}

/**
 * Backward-compatible alias used by existing premium bundles.
 * Fresh FA Nexus tile placement is intentionally unscoped so tiles appear on every level.
 */
export function getDefaultFaNexusPlacementLevels() {
  return [];
}

export function getCurrentLevelElevationRange(scene = canvas?.scene) {
  return getLevelElevationRange(getCurrentSceneLevel(scene));
}

export function findSceneLevelElevationRangeForElevation(elevation, {
  scene = canvas?.scene,
  ranges = null
} = {}) {
  const numeric = Number(elevation);
  if (!Number.isFinite(numeric)) return null;
  const levelRanges = Array.isArray(ranges) ? ranges : getSceneLevelElevationRanges(scene);
  for (let index = 0; index < levelRanges.length; index += 1) {
    const range = levelRanges[index];
    if (!range) continue;
    const nextRange = levelRanges[index + 1] || null;
    if (isElevationWithinLevelRange(numeric, range, { nextRange })) return range;
  }
  return null;
}

export function getCurrentLevelBottomElevation(scene = canvas?.scene) {
  const range = getCurrentLevelElevationRange(scene);
  if (!range) return DEFAULT_LEVEL_BASE;
  return Number.isFinite(range.bottom) ? range.bottom : DEFAULT_LEVEL_BASE;
}

function getControlledTileTargets(controlledTiles = canvas?.tiles?.controlled, {
  source = 'elevation-band'
} = {}) {
  const values = Array.isArray(controlledTiles)
    ? controlledTiles
    : (controlledTiles && typeof controlledTiles[Symbol.iterator] === 'function' ? Array.from(controlledTiles) : []);
  const controlled = values.filter((tile) => tile && !tile.destroyed);
  if (controlled.length) return controlled;
  try {
    return resolveTileSelectionForNexusPlacement({
      source,
      controlledTiles: values,
      scene: canvas?.scene
    }).filter((tile) => tile && !tile.destroyed);
  } catch (error) {
    Logger.error('ElevationBand.selectionContext.resolveFailed', {
      source,
      error: String(error?.message || error)
    });
    return [];
  }
}

export function resolvePlacementAnchorTile(controlledTiles = canvas?.tiles?.controlled, options = {}) {
  const controlled = getControlledTileTargets(controlledTiles, {
    source: options?.source || 'placement-anchor'
  });
  let anchorTile = null;
  let anchorElevation = -Infinity;
  let anchorSort = -Infinity;
  let anchorIndex = -1;
  for (let index = 0; index < controlled.length; index += 1) {
    const tile = controlled[index];
    if (!tile) continue;
    const doc = tile?.document || tile;
    const elevation = Number(doc?.elevation ?? tile?.elevation);
    if (!Number.isFinite(elevation)) continue;
    const sort = Number(doc?.sort ?? tile?.sort);
    const normalizedSort = Number.isFinite(sort) ? sort : 0;
    const beatsAnchor = (
      !anchorTile
      || (elevation > (anchorElevation + EPSILON))
      || (
        Math.abs(elevation - anchorElevation) <= EPSILON
        && (
          normalizedSort > anchorSort
          || (normalizedSort === anchorSort && index > anchorIndex)
        )
      )
    );
    if (!beatsAnchor) continue;
    anchorTile = tile;
    anchorElevation = elevation;
    anchorSort = normalizedSort;
    anchorIndex = index;
  }
  return anchorTile;
}

export function getHighestControlledTileElevation(controlledTiles = canvas?.tiles?.controlled) {
  const anchorTile = resolvePlacementAnchorTile(controlledTiles, { source: 'highest-controlled-elevation' });
  const elevation = Number(anchorTile?.document?.elevation ?? anchorTile?.elevation);
  return Number.isFinite(elevation) ? elevation : null;
}

export function resolveInitialFaNexusPlacementElevation({
  scene = canvas?.scene,
  controlledTiles = canvas?.tiles?.controlled,
  fallback = DEFAULT_LEVEL_BASE,
  source = 'initial-placement-elevation'
} = {}) {
  const anchorTile = resolvePlacementAnchorTile(controlledTiles, { source });
  const selectedElevation = Number(anchorTile?.document?.elevation ?? anchorTile?.elevation);
  if (Number.isFinite(selectedElevation)) return selectedElevation;
  const currentLevelBottom = getCurrentLevelBottomElevation(scene);
  if (Number.isFinite(currentLevelBottom)) return currentLevelBottom;
  const numericFallback = Number(fallback);
  if (Number.isFinite(numericFallback)) return numericFallback;
  return DEFAULT_LEVEL_BASE;
}

export function isElevationWithinCurrentLevelEditScope(elevation, { scene = canvas?.scene } = {}) {
  const numeric = Number(elevation);
  if (!Number.isFinite(numeric)) return false;
  const range = getCurrentLevelElevationRange(scene);
  if (!range) return true;
  const ranges = getSceneLevelElevationRanges(scene);
  const rangeIndex = ranges.findIndex((entry) => entry?.levelId === range.levelId);
  const nextRange = rangeIndex >= 0 ? (ranges[rangeIndex + 1] || null) : null;
  return isElevationWithinLevelRange(numeric, range, { nextRange });
}

export function findBackgroundElevationBandBase(elevation, { scene = canvas?.scene } = {}) {
  const numeric = Number(elevation);
  if (!Number.isFinite(numeric)) return null;
  const bases = getSceneLevelBandBases(scene);
  for (let index = bases.length - 1; index >= 0; index -= 1) {
    const base = bases[index];
    if ((numeric + EPSILON) < base) continue;
    if (numeric < (base + BAND_SIZE - EPSILON)) return base;
  }
  return null;
}

export function getGroundBandLocalOffset(documentElevation, {
  enabled = isKeepTokensAboveTileElevationsEnabled(),
  scene = canvas?.scene
} = {}) {
  const numeric = Number(documentElevation ?? 0);
  const elevation = Number.isFinite(numeric) ? numeric : 0;
  if (!enabled) return null;
  const bandBase = findBackgroundElevationBandBase(elevation, { scene });
  if (bandBase === null) return null;
  const localOffset = elevation - bandBase;
  if (!Number.isFinite(localOffset)) return 0;
  return Math.max(0, Math.min(BAND_SIZE - EPSILON, localOffset));
}

export function getGroundBandLocalSort(documentElevation, {
  enabled = isKeepTokensAboveTileElevationsEnabled(),
  scene = canvas?.scene
} = {}) {
  const localOffset = getGroundBandLocalOffset(documentElevation, { enabled, scene });
  if (localOffset === null) return null;
  return Math.max(0, Math.round(localOffset * GROUND_BAND_SORT_SCALE));
}

export function getGroundBandDocumentSortOffset(documentSort = 0) {
  const numeric = Number(documentSort);
  if (!Number.isFinite(numeric) || numeric === 0) return 0;
  return numeric / GROUND_BAND_DOCUMENT_SORT_SCALE;
}

export function normalizeGroundBandDocumentSort(documentElevation, documentSort, {
  enabled = isKeepTokensAboveTileElevationsEnabled(),
  scene = canvas?.scene
} = {}) {
  const originalSort = Number(documentSort);
  const fallbackSort = Number.isFinite(originalSort) ? originalSort : 0;
  const localSort = getGroundBandLocalSort(documentElevation, { enabled, scene });
  if (localSort === null || localSort < GROUND_BAND_SORT_LEAK_MIN) {
    return {
      sort: fallbackSort,
      normalized: false,
      originalSort,
      localSort,
      encoding: null
    };
  }

  const remainder = fallbackSort - localSort;
  let normalizedSort = null;
  let encoding = null;
  if (Math.abs(remainder) <= EPSILON) {
    normalizedSort = 0;
    encoding = 'integer-render-sort';
  } else if (remainder > 0 && remainder < 1) {
    const decoded = Math.round(remainder * GROUND_BAND_DOCUMENT_SORT_SCALE);
    if (decoded >= 0 && decoded <= GROUND_BAND_SORT_LEAK_MAX_REMAINDER) {
      normalizedSort = decoded;
      encoding = 'fractional-render-sort';
    }
  } else {
    const rounded = Math.round(remainder);
    if (
      Math.abs(remainder - rounded) <= EPSILON
      && rounded >= 0
      && rounded <= GROUND_BAND_SORT_LEAK_MAX_REMAINDER
    ) {
      normalizedSort = rounded;
      encoding = 'integer-render-sort';
    }
  }

  if (normalizedSort === null) {
    return {
      sort: fallbackSort,
      normalized: false,
      originalSort,
      localSort,
      encoding: null
    };
  }

  return {
    sort: normalizedSort,
    normalized: true,
    originalSort,
    localSort,
    encoding
  };
}

export function getGroundBandRenderSort(documentElevation, documentSort = 0, {
  enabled = isKeepTokensAboveTileElevationsEnabled(),
  scene = canvas?.scene
} = {}) {
  const localSort = getGroundBandLocalSort(documentElevation, { enabled, scene });
  if (localSort === null) return null;
  return localSort + getGroundBandDocumentSortOffset(documentSort);
}

/**
 * Convert a tile document elevation into the render-elevation we want to use on the mesh.
 * Each scene level reserves its first 1-unit band above the level bottom for FA Nexus ground art.
 * Tiles in that band render on the level floor plane while keeping their fractional authored
 * elevation as local ordering for tiles and shadows.
 */
export function getTileRenderElevation(documentElevation, {
  enabled = isKeepTokensAboveTileElevationsEnabled(),
  scene = canvas?.scene
} = {}) {
  const numeric = Number(documentElevation ?? 0);
  const elevation = Number.isFinite(numeric) ? numeric : 0;
  if (!enabled) return elevation;
  const bandBase = findBackgroundElevationBandBase(elevation, { scene });
  if (bandBase === null) return elevation;
  return bandBase;
}
