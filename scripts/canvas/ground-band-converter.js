import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  isKeepTokensAboveTileElevationsEnabled
} from './elevation-band-utils.js';
import { analyzeTileBandState } from './tile-band-utils.js';
import {
  installTileOcclusionElevationOverride,
  removeTileOcclusionElevationOverride
} from './tile-occlusion.js';

const EPSILON = 1e-4;

function logOcclusionElevationOverrideFailure(action, result, tile, reason) {
  if (!result || (result.status !== 'failed' && result.status !== 'blocked')) return;
  Logger.error('GroundBandConverter.tile.occlusionElevationOverride.failed', {
    action,
    tileId: tile?.document?.id || tile?.id || null,
    reason,
    overrideStatus: result.status,
    overrideReason: result.reason || null,
    error: result.error ? String(result.error?.message || result.error) : null
  });
}

function refreshMeshOcclusionBatchData(mesh, tile, reason) {
  try {
    if (typeof mesh?._updateBatchData === 'function') {
      mesh._updateBatchData();
      return;
    }
    if (mesh?._batchData && Number.isFinite(Number(mesh._occlusionElevation))) {
      mesh._batchData.occlusionElevation = mesh._occlusionElevation;
    }
  } catch (error) {
    Logger.warn('GroundBandConverter.tile.occlusionBatchRefresh.failed', {
      tileId: tile?.document?.id || tile?.id || null,
      reason,
      error: String(error?.message || error)
    });
  }
}

function resolveStoredOrCurrent({
  current,
  storedBase,
  storedApplied,
  storedRender,
  force = false,
  fallback = 0
} = {}) {
  const currentNumeric = Number(current);
  const storedBaseNumeric = Number(storedBase);
  const storedRenderNumeric = Number(storedRender);
  if (
    force
    && Number.isFinite(currentNumeric)
    && (
      !storedApplied
      || !Number.isFinite(storedRenderNumeric)
      || Math.abs(currentNumeric - storedRenderNumeric) > EPSILON
    )
  ) {
    return currentNumeric;
  }
  if (Number.isFinite(storedBaseNumeric)) return storedBaseNumeric;
  if (Number.isFinite(currentNumeric)) return currentNumeric;
  return Number(fallback) || 0;
}

export function getTileGroundBandRenderState(doc, {
  enabled = isKeepTokensAboveTileElevationsEnabled(),
  scene = canvas?.scene
} = {}) {
  if (!doc || !enabled) return null;
  const analysis = analyzeTileBandState(doc, {
    enabled: true,
    scene
  });
  if (!analysis?.canApply || !analysis?.renderOrder) return null;
  return {
    kind: analysis.kind,
    placementLevelId: analysis.placementLevelId,
    documentElevation: analysis.documentElevation,
    documentSort: analysis.documentSort,
    renderElevation: analysis.renderOrder.elevation,
    renderSortLayer: analysis.renderOrder.sortLayer,
    renderSort: analysis.renderOrder.sort,
    localOffset: analysis.localOffset ?? 0
  };
}

export function restoreGroundBandTile(tile, { reason = 'restore' } = {}) {
  try {
    if (!tile || tile.destroyed) return { status: 'skipped', reason: 'missing-tile' };
    const mesh = tile.mesh;
    const doc = tile.document;
    if (!mesh || mesh.destroyed || !doc) return { status: 'skipped', reason: 'missing-mesh-or-document' };

    const wasApplied = !!mesh.faNexusBgBandApplied;
    const baseElevation = Number(doc.elevation ?? mesh.faNexusBgBandBase ?? 0) || 0;
    if (wasApplied && Math.abs((mesh.elevation ?? 0) - baseElevation) > EPSILON) {
      mesh.elevation = baseElevation;
    }

    const baseSort = Number.isFinite(Number(doc.sort)) ? Number(doc.sort) : Number(mesh.faNexusBgBandBaseSort);
    if (wasApplied && Number.isFinite(baseSort) && Math.abs((mesh.sort ?? 0) - baseSort) > EPSILON) {
      mesh.sort = baseSort;
    }

    const baseSortLayer = Number(mesh.faNexusBgBandBaseSortLayer);
    if (wasApplied && Number.isFinite(baseSortLayer) && Math.abs((mesh.sortLayer ?? 0) - baseSortLayer) > EPSILON) {
      mesh.sortLayer = baseSortLayer;
    }

    const baseZIndex = Number(mesh.faNexusBgBandBaseZIndex);
    if (wasApplied && Number.isFinite(baseZIndex) && Math.abs((mesh.zIndex ?? 0) - baseZIndex) > EPSILON) {
      mesh.zIndex = baseZIndex;
    }

    delete mesh.faNexusBgBandApplied;
    delete mesh.faNexusBgBandBase;
    delete mesh.faNexusBgBandBaseSort;
    delete mesh.faNexusBgBandBaseSortLayer;
    delete mesh.faNexusBgBandBaseZIndex;
    if (Object.prototype.hasOwnProperty.call(mesh, 'faNexusBgBandBaseOccludedBySameElevationSurfaces')) {
      mesh._occludedBySameElevationSurfaces = mesh.faNexusBgBandBaseOccludedBySameElevationSurfaces;
    }
    delete mesh.faNexusBgBandBaseOccludedBySameElevationSurfaces;
    delete mesh.faNexusBgBandValue;
    delete mesh.faNexusBgBandKind;
    delete mesh.faNexusBgBandPlacementLevelId;
    delete mesh.faNexusBgBandRenderSort;
    delete mesh.faNexusBgBandRenderSortLayer;
    delete mesh.faNexusBgBandRenderZIndex;

    const overrideResult = removeTileOcclusionElevationOverride(mesh);
    logOcclusionElevationOverrideFailure('remove', overrideResult, tile, reason);
    refreshMeshOcclusionBatchData(mesh, tile, reason);

    if (mesh.parent) mesh.parent.sortDirty = true;
    if (wasApplied) Logger.debug('GroundBandConverter.tile.restore', { tileId: doc.id, baseElevation, reason });
    return { status: wasApplied ? 'restored' : 'skipped', reason: wasApplied ? reason : 'not-applied' };
  } catch (error) {
    Logger.warn('GroundBandConverter.tile.restore.failed', {
      tileId: tile?.document?.id || null,
      reason,
      error: String(error?.message || error)
    });
    return { status: 'failed', reason, error };
  }
}

export function applyGroundBandToTile(tile, {
  reason = 'refresh',
  force = false,
  enabled = isKeepTokensAboveTileElevationsEnabled(),
  scene = canvas?.scene
} = {}) {
  try {
    if (!tile || tile.destroyed) return { status: 'skipped', reason: 'missing-tile' };
    const mesh = tile.mesh;
    const doc = tile.document;
    if (!mesh || mesh.destroyed || !doc) return { status: 'skipped', reason: 'missing-mesh-or-document' };

    if (!enabled) return restoreGroundBandTile(tile, { reason: 'disabled' });

    const state = getTileGroundBandRenderState(doc, { enabled: true, scene });
    if (!state) {
      if (mesh.faNexusBgBandApplied) return restoreGroundBandTile(tile, { reason: 'no-ground-band' });
      return { status: 'skipped', reason: 'outside-ground-band' };
    }

    const occlusionOverrideResult = installTileOcclusionElevationOverride(mesh, doc);
    logOcclusionElevationOverrideFailure('install', occlusionOverrideResult, tile, reason);

    const baseZIndex = resolveStoredOrCurrent({
      current: mesh.zIndex,
      storedBase: mesh.faNexusBgBandBaseZIndex,
      storedApplied: mesh.faNexusBgBandApplied,
      storedRender: mesh.faNexusBgBandRenderZIndex,
      force,
      fallback: state.documentSort
    });

    const baseSortLayer = resolveStoredOrCurrent({
      current: mesh.sortLayer,
      storedBase: mesh.faNexusBgBandBaseSortLayer,
      storedApplied: mesh.faNexusBgBandApplied,
      storedRender: mesh.faNexusBgBandRenderSortLayer,
      force,
      fallback: mesh.sortLayer
    });
    const desiredOccludedBySameElevationSurfaces = state.kind !== 'foreground';
    if (
      mesh.faNexusBgBandApplied
      && !Object.prototype.hasOwnProperty.call(mesh, 'faNexusBgBandBaseOccludedBySameElevationSurfaces')
    ) {
      mesh.faNexusBgBandBaseOccludedBySameElevationSurfaces = mesh._occludedBySameElevationSurfaces;
    }

    if (
      !force
      && mesh.faNexusBgBandApplied
      && Math.abs((mesh.elevation ?? 0) - state.renderElevation) <= EPSILON
      && Math.abs((mesh.sortLayer ?? 0) - state.renderSortLayer) <= EPSILON
      && Math.abs((mesh.sort ?? 0) - state.renderSort) <= EPSILON
      && Math.abs((mesh.zIndex ?? 0) - baseZIndex) <= EPSILON
      && mesh._occludedBySameElevationSurfaces === desiredOccludedBySameElevationSurfaces
    ) {
      return { status: 'unchanged', reason };
    }

    mesh.faNexusBgBandApplied = true;
    mesh.faNexusBgBandBase = state.documentElevation;
    mesh.faNexusBgBandBaseSort = state.documentSort;
    mesh.faNexusBgBandBaseSortLayer = baseSortLayer;
    mesh.faNexusBgBandBaseZIndex = baseZIndex;
    if (!Object.prototype.hasOwnProperty.call(mesh, 'faNexusBgBandBaseOccludedBySameElevationSurfaces')) {
      mesh.faNexusBgBandBaseOccludedBySameElevationSurfaces = mesh._occludedBySameElevationSurfaces;
    }
    mesh.faNexusBgBandValue = state.renderElevation;
    mesh.faNexusBgBandKind = state.kind;
    mesh.faNexusBgBandPlacementLevelId = state.placementLevelId || null;
    mesh.faNexusBgBandRenderSort = state.renderSort;
    mesh.faNexusBgBandRenderSortLayer = state.renderSortLayer;
    mesh.faNexusBgBandRenderZIndex = baseZIndex;

    mesh.elevation = state.renderElevation;
    mesh.sortLayer = state.renderSortLayer;
    mesh.sort = state.renderSort;
    mesh.zIndex = baseZIndex;
    mesh._occludedBySameElevationSurfaces = desiredOccludedBySameElevationSurfaces;
    refreshMeshOcclusionBatchData(mesh, tile, reason);
    if (mesh.parent) mesh.parent.sortDirty = true;

    return {
      status: 'applied',
      reason,
      kind: state.kind,
      placementLevelId: state.placementLevelId,
      documentElevation: state.documentElevation,
      renderElevation: state.renderElevation,
      renderSortLayer: state.renderSortLayer,
      documentSort: state.documentSort,
      renderSort: state.renderSort
    };
  } catch (error) {
    Logger.warn('GroundBandConverter.tile.apply.failed', {
      tileId: tile?.document?.id || null,
      reason,
      error: String(error?.message || error)
    });
    return { status: 'failed', reason, error };
  }
}

export function applyGroundBandToAllTiles(reason = 'refresh', {
  force = false,
  enabled = isKeepTokensAboveTileElevationsEnabled(),
  scene = canvas?.scene,
  tiles = canvas?.tiles?.placeables
} = {}) {
  const placeables = Array.isArray(tiles) ? tiles : [];
  const stats = {
    reason,
    sceneId: scene?.id || canvas?.scene?.id || null,
    sceneName: scene?.name || canvas?.scene?.name || null,
    total: placeables.length,
    applied: 0,
    unchanged: 0,
    restored: 0,
    skipped: 0,
    failed: 0
  };

  for (const tile of placeables) {
    const result = applyGroundBandToTile(tile, { reason, force, enabled, scene });
    if (result.status === 'applied') stats.applied += 1;
    else if (result.status === 'unchanged') stats.unchanged += 1;
    else if (result.status === 'restored') stats.restored += 1;
    else if (result.status === 'failed') stats.failed += 1;
    else stats.skipped += 1;
  }

  if (stats.failed) Logger.warn('GroundBandConverter.scene.failed', stats);
  else if (stats.applied || stats.restored) Logger.info('GroundBandConverter.scene.applied', stats);
  else Logger.debug('GroundBandConverter.scene.noop', stats);
  return stats;
}

export function restoreGroundBandFromAllTiles(reason = 'restore', {
  scene = canvas?.scene,
  tiles = canvas?.tiles?.placeables
} = {}) {
  const placeables = Array.isArray(tiles) ? tiles : [];
  const stats = {
    reason,
    sceneId: scene?.id || canvas?.scene?.id || null,
    sceneName: scene?.name || canvas?.scene?.name || null,
    total: placeables.length,
    restored: 0,
    skipped: 0,
    failed: 0
  };

  for (const tile of placeables) {
    const result = restoreGroundBandTile(tile, { reason });
    if (result.status === 'restored') stats.restored += 1;
    else if (result.status === 'failed') stats.failed += 1;
    else stats.skipped += 1;
  }

  if (stats.failed) Logger.warn('GroundBandConverter.scene.restore.failed', stats);
  else if (stats.restored) Logger.info('GroundBandConverter.scene.restored', stats);
  else Logger.debug('GroundBandConverter.scene.restore.noop', stats);
  return stats;
}
