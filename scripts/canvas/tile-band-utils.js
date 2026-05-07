import {
  getCurrentSceneLevel,
  getGroundBandLocalOffset,
  getGroundBandRenderSort,
  getSceneLevelElevationRanges,
  isKeepTokensAboveTileElevationsEnabled
} from './elevation-band-utils.js';
import { getRawLevelIds } from './tile-level-membership.js';

const MODULE_ID = 'fa-nexus';
export const FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG = 'placementLevelId';

const BAND_SIZE = 1;
const EPSILON = 1e-6;
const DEFAULT_SORT_LAYERS = Object.freeze({
  SCENE: 0,
  TILES: 500
});
const FOREGROUND_SORT_BASE = 0.25;
const FOREGROUND_SORT_SPAN = 0.5;
const FOREGROUND_SORT_DOCUMENT_SCALE = 1_000_000;

function normalizeId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function getSortLayers() {
  const source = canvas?.primary?.constructor?.SORT_LAYERS
    || foundry?.canvas?.groups?.PrimaryCanvasGroup?.SORT_LAYERS
    || DEFAULT_SORT_LAYERS;
  const scene = Number(source?.SCENE);
  const tiles = Number(source?.TILES);
  return {
    SCENE: Number.isFinite(scene) ? scene : DEFAULT_SORT_LAYERS.SCENE,
    TILES: Number.isFinite(tiles) ? tiles : DEFAULT_SORT_LAYERS.TILES
  };
}

function getSceneRangeById(levelId, { scene = canvas?.scene, ranges = null } = {}) {
  const normalizedId = normalizeId(levelId);
  if (!normalizedId) return null;
  const levelRanges = Array.isArray(ranges) ? ranges : getSceneLevelElevationRanges(scene);
  return levelRanges.find((range) => normalizeId(range?.levelId) === normalizedId) || null;
}

function getSoleSceneRange(scene = canvas?.scene, ranges = null) {
  const levelRanges = Array.isArray(ranges) ? ranges : getSceneLevelElevationRanges(scene);
  if (levelRanges.length !== 1) return null;
  return levelRanges[0] || null;
}

function getLevelRangeIndex(levelId, ranges = []) {
  const normalizedId = normalizeId(levelId);
  if (!normalizedId) return -1;
  return ranges.findIndex((range) => normalizeId(range?.levelId) === normalizedId);
}

function rangesShareBoundary(lowerRange, upperRange) {
  const lowerTop = Number(lowerRange?.top);
  const upperBottom = Number(upperRange?.bottom);
  if (!Number.isFinite(lowerTop) || !Number.isFinite(upperBottom)) return false;
  return Math.abs(lowerTop - upperBottom) <= EPSILON;
}

function isInBand(elevation, base) {
  const numericElevation = Number(elevation);
  const numericBase = Number(base);
  if (!Number.isFinite(numericElevation) || !Number.isFinite(numericBase)) return false;
  return numericElevation >= (numericBase - EPSILON) && numericElevation < (numericBase + BAND_SIZE - EPSILON);
}

function buildBandCandidates(elevation, ranges = []) {
  const candidates = [];
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (!range) continue;
    if (isInBand(elevation, range.bottom)) {
      candidates.push({
        kind: 'ground',
        placementLevelId: normalizeId(range.levelId),
        placementRange: range,
        placementRangeIndex: index,
        upperRange: ranges[index + 1] || null
      });
    }
    const upperRange = ranges[index + 1] || null;
    if (upperRange && !rangesShareBoundary(range, upperRange)) continue;
    if (!isInBand(elevation, range.top)) continue;
    candidates.push({
      kind: 'foreground',
      placementLevelId: normalizeId(range.levelId),
      placementRange: range,
      placementRangeIndex: index,
      upperRange
    });
  }
  return candidates;
}

export function getDefaultTilePlacementLevelId(scene = canvas?.scene) {
  return normalizeId(getCurrentSceneLevel(scene)?.id);
}

export function getTileVisibleLevelIds(target) {
  return getRawLevelIds(target);
}

export function getTileExplicitPlacementLevelId(target) {
  let raw;
  try {
    raw = target?.getFlag?.(MODULE_ID, FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG);
  } catch (_) {
    raw = undefined;
  }
  if (raw === undefined) {
    raw = target?.flags?.[MODULE_ID]?.[FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG]
      ?? target?._source?.flags?.[MODULE_ID]?.[FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG];
  }
  return normalizeId(raw);
}

export function resolveTilePlacementLevelId(target, {
  scene = canvas?.scene,
  placementLevelId = null,
  visibleLevelIds = null,
  allowSingleLevelInference = true,
  requireVisibleMembership = true
} = {}) {
  const ranges = getSceneLevelElevationRanges(scene);
  const visibleIds = Array.isArray(visibleLevelIds) ? visibleLevelIds.slice() : getTileVisibleLevelIds(target);
  const explicit = normalizeId(placementLevelId) || getTileExplicitPlacementLevelId(target);
  if (explicit) {
    const range = getSceneRangeById(explicit, { scene, ranges });
    const visible = !visibleIds.length || visibleIds.includes(explicit);
    if (range && (!requireVisibleMembership || visible)) {
      return { levelId: explicit, range, source: 'explicit' };
    }
  }

  if (allowSingleLevelInference && visibleIds.length === 1) {
    const inferredId = normalizeId(visibleIds[0]);
    const range = getSceneRangeById(inferredId, { scene, ranges });
    if (range) return { levelId: inferredId, range, source: 'single-level' };
  }

  if (!explicit && allowSingleLevelInference && !visibleIds.length) {
    const soleRange = getSoleSceneRange(scene, ranges);
    const soleLevelId = normalizeId(soleRange?.levelId);
    if (soleRange && soleLevelId) {
      return {
        levelId: soleLevelId,
        range: soleRange,
        source: 'scene-single-level'
      };
    }
  }

  return {
    levelId: null,
    range: null,
    source: explicit ? 'invalid-explicit' : 'unresolved'
  };
}

export function analyzeTileBandState(target, {
  scene = canvas?.scene,
  enabled = isKeepTokensAboveTileElevationsEnabled(),
  elevation = null,
  sort = null,
  visibleLevelIds = null,
  placementLevelId = null,
  allowSingleLevelInference = true,
  requireVisibleMembership = true,
  allowCurrentLevelFallback = false
} = {}) {
  const doc = target?.document || target || null;
  const documentElevation = Number(elevation ?? doc?.elevation ?? 0) || 0;
  const documentSort = Number(sort ?? doc?.sort ?? 0) || 0;
  const ranges = getSceneLevelElevationRanges(scene);
  const visibleIds = Array.isArray(visibleLevelIds) ? visibleLevelIds.slice() : getTileVisibleLevelIds(doc);
  const candidates = buildBandCandidates(documentElevation, ranges);
  const sortLayers = getSortLayers();

  if (!enabled) {
    return {
      enabled: false,
      documentElevation,
      documentSort,
      visibleLevelIds: visibleIds,
      placementLevelId: null,
      placementLevelSource: 'disabled',
      placementRange: null,
      upperRange: null,
      kind: null,
      inSpecialBand: false,
      canApply: false,
      reason: 'disabled',
      candidates,
      renderOrder: null,
      sortLayers
    };
  }

  let placement = resolveTilePlacementLevelId(doc, {
    scene,
    placementLevelId,
    visibleLevelIds: visibleIds,
    allowSingleLevelInference,
    requireVisibleMembership
  });

  if (!placement.levelId && allowCurrentLevelFallback) {
    const currentLevelId = getDefaultTilePlacementLevelId(scene);
    const range = getSceneRangeById(currentLevelId, { scene, ranges });
    if (currentLevelId && range) {
      placement = {
        levelId: currentLevelId,
        range,
        source: 'current-view'
      };
    }
  }

  const matchingCandidate = placement.levelId
    ? (candidates.find((candidate) => candidate.placementLevelId === placement.levelId) || null)
    : null;

  if (!matchingCandidate) {
    return {
      enabled: true,
      documentElevation,
      documentSort,
      visibleLevelIds: visibleIds,
      placementLevelId: placement.levelId,
      placementLevelSource: placement.source,
      placementRange: placement.range,
      upperRange: null,
      kind: null,
      inSpecialBand: candidates.length > 0,
      canApply: false,
      reason: candidates.length ? 'missing-placement-level' : 'outside-band',
      candidates,
      renderOrder: null,
      sortLayers
    };
  }

  if (matchingCandidate.kind === 'ground') {
    const renderSort = getGroundBandRenderSort(documentElevation, documentSort, { enabled: true, scene });
    const renderElevation = Number(matchingCandidate?.placementRange?.bottom);
    const renderOrder = renderSort === null ? null : {
      elevation: Number.isFinite(renderElevation) ? renderElevation : documentElevation,
      sortLayer: sortLayers.TILES,
      sort: renderSort,
      zIndex: 0
    };
    return {
      enabled: true,
      documentElevation,
      documentSort,
      visibleLevelIds: visibleIds,
      placementLevelId: placement.levelId,
      placementLevelSource: placement.source,
      placementRange: matchingCandidate.placementRange,
      upperRange: matchingCandidate.upperRange,
      kind: 'ground',
      inSpecialBand: true,
      canApply: !!renderOrder,
      reason: renderOrder ? 'ok' : 'outside-band',
      candidates,
      localOffset: getGroundBandLocalOffset(documentElevation, { enabled: true, scene }),
      renderOrder,
      sortLayers
    };
  }

  const rangeIndex = Number.isFinite(matchingCandidate.placementRangeIndex)
    ? matchingCandidate.placementRangeIndex
    : getLevelRangeIndex(placement.levelId, ranges);
  const localOffset = Math.max(0, Math.min(BAND_SIZE - EPSILON, documentElevation - Number(matchingCandidate.placementRange?.top ?? documentElevation)));
  const renderSort = rangeIndex
    + FOREGROUND_SORT_BASE
    + (localOffset * FOREGROUND_SORT_SPAN)
    + (documentSort / FOREGROUND_SORT_DOCUMENT_SCALE);

  return {
    enabled: true,
    documentElevation,
    documentSort,
    visibleLevelIds: visibleIds,
    placementLevelId: placement.levelId,
    placementLevelSource: placement.source,
    placementRange: matchingCandidate.placementRange,
    upperRange: matchingCandidate.upperRange,
    kind: 'foreground',
    inSpecialBand: true,
    canApply: true,
    reason: 'ok',
    candidates,
    localOffset,
    renderOrder: {
      elevation: Number.isFinite(Number(matchingCandidate?.placementRange?.top))
        ? Number(matchingCandidate.placementRange.top)
        : documentElevation,
      sortLayer: sortLayers.SCENE,
      sort: renderSort,
      zIndex: 0
    },
    sortLayers
  };
}

export function resolveTileRenderOrder(target, options = {}) {
  const analysis = analyzeTileBandState(target, options);
  if (analysis?.renderOrder) {
    return {
      kind: analysis.kind,
      placementLevelId: analysis.placementLevelId,
      analysis,
      ...analysis.renderOrder
    };
  }

  const doc = target?.document || target || null;
  const sortLayers = analysis?.sortLayers || getSortLayers();
  const elevation = Number(options?.elevation ?? doc?.elevation ?? 0) || 0;
  const sort = Number(options?.sort ?? doc?.sort ?? 0) || 0;
  return {
    kind: 'normal',
    placementLevelId: analysis?.placementLevelId || null,
    analysis,
    elevation,
    sortLayer: sortLayers.TILES,
    sort,
    zIndex: 0
  };
}
