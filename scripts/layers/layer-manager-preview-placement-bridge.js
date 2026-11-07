import {
  computeNextSortAtElevation,
  normalizeTileDocumentSortForPlacement,
  resolvePlacementSortAtElevation
} from '../canvas/canvas-interaction-controller.js';
import { getSceneLevelElevationRanges, resolvePlacementAnchorTile } from '../canvas/elevation-band-utils.js';
import { getDefaultTilePlacementLevelId } from '../canvas/tile-band-utils.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  elevationGroupKey,
  quantizeElevation
} from './model/elevation-group-metadata.js';
import {
  buildLayerManagerPreviewEntry,
  getPrimaryCanvasSortLayers,
  resolveLayerManagerPreviewPlacementSort
} from './model/render-entries.js';
import { getSceneLayerManagerSections } from './model/section-metadata.js';
import { analyzeTileBandState } from '../canvas/tile-band-utils.js';
import { buildDisplayGroupingForEntry } from './layer-manager-hierarchy.js';
import {
  resolveAdjacentElevationNudgeTarget,
  resolveLayerManagerPreviewSortStep
} from './actions/drag-reorder.js';

const TILE_SORT_STEP = 2;
const previewContainersById = new Map();
const previewSectionIdsById = new Map();
const previewSectionAnchorIdsById = new Map();
let previewSectionSceneId = null;

function getElevationBandIdentity(elevationKey = '') {
  const match = /^(ground|foreground):([^:]+):/.exec(String(elevationKey || '').trim());
  return match ? `${match[1]}:${match[2]}` : 'normal';
}

function resolveDocumentDisplayGrouping(doc) {
  const documentElevation = quantizeElevation(doc?.elevation ?? 0);
  const analysis = analyzeTileBandState(doc);
  return buildDisplayGroupingForEntry({
    documentElevation,
    documentElevationKey: elevationGroupKey(documentElevation),
    elevation: Number(analysis?.renderOrder?.elevation ?? documentElevation),
    renderElevation: Number(analysis?.renderOrder?.elevation ?? documentElevation),
    renderKind: analysis?.kind || 'normal',
    placementLevelId: analysis?.placementLevelId || null
  }, { nestedGrouping: false });
}

function resolvePreviewPlacementSort(container) {
  return resolveLayerManagerPreviewPlacementSort(container);
}

function applyPreviewSectionIntent(previewId, container, sectionId) {
  const normalizedPreviewId = String(previewId || '').trim();
  if (!normalizedPreviewId || !container || container.destroyed) return false;
  const normalizedSectionId = String(sectionId || '').trim() || null;
  if (normalizedSectionId) container.faNexusSectionId = normalizedSectionId;
  else delete container.faNexusSectionId;
  container.faNexusSectionIntentExplicit = true;
  previewSectionIdsById.set(normalizedPreviewId, normalizedSectionId);
  previewSectionAnchorIdsById.delete(normalizedPreviewId);
  return true;
}

function resolveSceneLevelName(levelId, scene = canvas?.scene) {
  const normalizedId = String(levelId || '').trim();
  if (!normalizedId) return null;
  const range = getSceneLevelElevationRanges(scene).find((entry) => String(entry?.levelId || '').trim() === normalizedId) || null;
  const normalizedName = String(range?.levelName || '').trim();
  return normalizedName || null;
}

function buildPreviewEntry(container, { label, icon, kind, previewActiveOverride, canDragPreviewOverride }) {
  return buildLayerManagerPreviewEntry(container, {
    label,
    icon,
    kind,
    previewActiveOverride,
    canDragPreviewOverride
  }, {
    quantizeElevation,
    elevationGroupKey,
    getDefaultTilePlacementLevelId,
    resolveSceneLevelName,
    getSortLayers: getPrimaryCanvasSortLayers
  });
}

export function collectLayerManagerPreviewEntries() {
  previewContainersById.clear();
  const sceneId = String(canvas?.scene?.id || '').trim() || null;
  if (!canvas?.ready) {
    previewSectionIdsById.clear();
    previewSectionAnchorIdsById.clear();
    previewSectionSceneId = sceneId;
    return [];
  }
  if (sceneId !== previewSectionSceneId) {
    previewSectionIdsById.clear();
    previewSectionAnchorIdsById.clear();
    previewSectionSceneId = sceneId;
  }
  const roots = new Set();
  if (canvas?.primary) roots.add(canvas.primary);
  if (canvas?.stage) roots.add(canvas.stage);
  const entries = [];
  const seen = new Set();
  const scatterCandidates = [];
  const buildingPreviewRoots = [];
  const buildingFillRoots = [];
  const buildingSillsRoots = [];
  let scatterEntries = 0;
  const shouldInclude = (container) => !!container?.faNexusPreviewActive || !!container?.faNexusPreviewHasContent;
  const push = (container, meta) => {
    if (!container || container.destroyed) return;
    if (seen.has(container)) return;
    const entry = buildPreviewEntry(container, meta);
    if (entry) {
      const anchorTileId = String(
        container.faNexusPlacementAnchorTileId
        || resolvePlacementAnchorTile()?.document?.id
        || ''
      ).trim();
      const inferredAnchorTileId = String(previewSectionAnchorIdsById.get(entry.previewId) || '').trim();
      const launchAnchorChanged = !!(anchorTileId && inferredAnchorTileId && anchorTileId !== inferredAnchorTileId);
      if (container.faNexusSectionIntentExplicit === true) {
        const explicitSectionId = String(container.faNexusSectionId || '').trim() || null;
        if (explicitSectionId) container.faNexusSectionId = explicitSectionId;
        else delete container.faNexusSectionId;
        entry.sectionId = explicitSectionId;
        previewSectionIdsById.set(entry.previewId, explicitSectionId);
        previewSectionAnchorIdsById.set(entry.previewId, anchorTileId);
      } else if (previewSectionIdsById.has(entry.previewId) && !launchAnchorChanged) {
        const storedSectionId = String(previewSectionIdsById.get(entry.previewId) || '').trim() || null;
        if (storedSectionId) container.faNexusSectionId = storedSectionId;
        else delete container.faNexusSectionId;
        entry.sectionId = storedSectionId;
      } else {
        const metadata = getSceneLayerManagerSections(canvas?.scene);
        const inferredSectionId = String(entry.sectionId || metadata.memberships[anchorTileId] || '').trim() || null;
        if (inferredSectionId) container.faNexusSectionId = inferredSectionId;
        else delete container.faNexusSectionId;
        entry.sectionId = inferredSectionId;
        if (inferredSectionId || anchorTileId) {
          previewSectionIdsById.set(entry.previewId, inferredSectionId);
          previewSectionAnchorIdsById.set(entry.previewId, anchorTileId);
        }
      }
      entries.push(entry);
      previewContainersById.set(entry.previewId, container);
      seen.add(container);
      if (meta?.kind === 'scatter-preview') scatterEntries += 1;
    }
  };
  const pushScatterCandidate = (container) => {
    if (!container || container.destroyed) return;
    scatterCandidates.push(container);
  };
  const pushBuildingRoot = (container, collection) => {
    if (!container || container.destroyed) return;
    collection.push(container);
  };
  const walk = (container, depth = 0) => {
    if (!container || container.destroyed) return;
    if (container.faNexusAssetPlacementPreview || container.name === 'fa-nexus-asset-preview') {
      if (shouldInclude(container)) {
        push(container, { label: 'Asset Placement Preview', icon: 'fa-solid fa-image', kind: 'asset-placement-preview' });
      }
    } else if (container.faNexusScatterPreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Scatter Preview', icon: 'fa-solid fa-braille', kind: 'scatter-preview' });
      } else {
        pushScatterCandidate(container);
      }
    } else if (container.faNexusPathPreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Path Preview', icon: 'fa-solid fa-route', kind: 'path-preview' });
      }
    } else if (container.faNexusTexturePreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Texture Preview', icon: 'fa-solid fa-paint-roller', kind: 'texture-preview' });
      }
    } else if (container.name === 'fa-nexus-building-preview-root') {
      pushBuildingRoot(container, buildingPreviewRoots);
    } else if (container.name === 'fa-nexus-building-fill-preview-root') {
      pushBuildingRoot(container, buildingFillRoots);
    } else if (container.name === 'fa-nexus-building-sills-preview-root') {
      pushBuildingRoot(container, buildingSillsRoots);
    }
    if (depth >= 3) return;
    const children = Array.isArray(container.children) ? container.children : [];
    for (const child of children) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }

  const buildingManagerActive = (() => {
    try {
      return !!globalThis?.faNexus?.premiumFeatures?.buildingEditor?.activeManager?.isActive;
    } catch (_) {
      return false;
    }
  })();
  const buildingActive = buildingManagerActive || [...buildingPreviewRoots, ...buildingFillRoots, ...buildingSillsRoots].some(
    (container) => !!container?.faNexusPreviewActive
  );
  const hasSpecificBuildingActivePreview = [...buildingPreviewRoots, ...buildingFillRoots, ...buildingSillsRoots].some(
    (container) => !!container?.faNexusPreviewActive
  );
  for (const container of buildingPreviewRoots) {
    push(container, {
      label: 'Building Preview',
      icon: 'fa-solid fa-building',
      kind: 'building-preview',
      previewActiveOverride: buildingActive && !hasSpecificBuildingActivePreview ? true : undefined,
      canDragPreviewOverride: buildingActive ? true : undefined
    });
  }
  for (const container of buildingFillRoots) {
    push(container, {
      label: 'Building Fill Preview',
      icon: 'fa-solid fa-fill-drip',
      kind: 'building-fill-preview',
      previewActiveOverride: undefined,
      canDragPreviewOverride: buildingActive ? true : undefined
    });
  }

  for (const container of buildingSillsRoots) {
    push(container, {label:'Building Sills Preview', icon:'fa-solid fa-window-maximize',
      kind:'building-sills-preview', canDragPreviewOverride:buildingActive ? true : undefined});
  }

  if (!scatterEntries && scatterCandidates.length) {
    let fallback = scatterCandidates[0];
    for (const candidate of scatterCandidates) {
      if (!candidate || candidate.destroyed) continue;
      if (resolvePreviewPlacementSort(candidate) > resolvePreviewPlacementSort(fallback)) {
        fallback = candidate;
      }
    }
    push(fallback, {
      label: 'Scatter Preview',
      icon: 'fa-solid fa-braille',
      kind: 'scatter-preview',
      previewActiveOverride: true
    });
  }

  const numberedKinds = new Set(['path-preview', 'scatter-preview']);
  const grouped = new Map();
  for (const entry of entries) {
    const kind = String(entry?.previewKind || '').trim();
    if (!numberedKinds.has(kind)) continue;
    const list = grouped.get(kind) || [];
    list.push(entry);
    grouped.set(kind, list);
  }
  for (const list of grouped.values()) {
    if (list.length <= 1) continue;
    const ordered = list.slice().sort((left, right) => {
      const elevationDelta = Number(left?.documentElevation ?? left?.elevation ?? 0) - Number(right?.documentElevation ?? right?.elevation ?? 0);
      if (Math.abs(elevationDelta) > 0.0001) return elevationDelta;
      return Number(left?.placementSort ?? left?.sort ?? 0) - Number(right?.placementSort ?? right?.sort ?? 0);
    });
    for (let index = 0; index < ordered.length; index += 1) {
      const entry = ordered[index];
      entry.previewOrdinal = index + 1;
      entry.name = `${entry.baseName || entry.name || 'Preview'} ${index + 1}`;
    }
  }

  const activeIds = new Set(entries.map((entry) => String(entry?.previewId || '').trim()).filter(Boolean));
  for (const previewId of previewSectionIdsById.keys()) {
    if (!activeIds.has(previewId)) {
      previewSectionIdsById.delete(previewId);
      previewSectionAnchorIdsById.delete(previewId);
    }
  }

  return entries;
}

export function getLayerManagerPreviewEntryById(viewState, previewId = '') {
  const targetId = String(previewId || '').trim();
  if (!targetId) return null;
  return Array.isArray(viewState?.entries)
    ? viewState.entries.find((entry) => entry?.preview === true && String(entry?.previewId || '').trim() === targetId) || null
    : null;
}

export function routeLayerManagerPreviewWheelAdjustment(event, {
  nudgeSort,
  nudgeElevation
} = {}) {
  if (!event?.altKey) return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  const rawDelta = Number(event.deltaY);
  if (!Number.isFinite(rawDelta) || rawDelta === 0) return true;
  const direction = rawDelta < 0 ? 1 : -1;
  const mode = event.ctrlKey || event.metaKey ? 'sort' : 'elevation';
  const callback = mode === 'sort' ? nudgeSort : nudgeElevation;
  if (typeof callback !== 'function') {
    throw new TypeError('Preview wheel adjustment requires a matching sort or elevation callback.');
  }
  callback(direction, event);
  return true;
}

export function resolveLayerManagerPreviewSortNudge({
  previewKind = '',
  direction = 0,
  anchorTileId = null,
  sortBefore = false,
  excludeTileIds = [],
  announce = true
} = {}) {
  const kind = String(previewKind || '').trim();
  const normalizedDirection = Math.sign(Number(direction) || 0);
  if (!kind || !normalizedDirection) return null;
  const entries = collectLayerManagerPreviewEntries();
  const entry = entries.find((candidate) => candidate?.previewKind === kind && candidate?.previewActive === true)
    || entries.find((candidate) => candidate?.previewKind === kind)
    || null;
  const previewId = String(entry?.previewId || '').trim();
  const container = previewContainersById.get(previewId) || null;
  const elevation = Number(entry?.documentElevation ?? entry?.groupElevation ?? entry?.elevation);
  const currentSort = Number(entry?.placementSort ?? entry?.sort);
  if (!previewId || !container || !Number.isFinite(elevation) || !Number.isFinite(currentSort)) return null;
  const excluded = new Set((Array.isArray(excludeTileIds) ? excludeTileIds : [excludeTileIds]).map(String).filter(Boolean));
  const currentGrouping = buildDisplayGroupingForEntry(entry, { nestedGrouping: false });
  const currentElevationKey = String(currentGrouping?.exactKey || elevationGroupKey(elevation)).trim();
  const currentBandIdentity = getElevationBandIdentity(currentElevationKey);
  const groupedDocs = new Map();
  for (const doc of Array.from(canvas?.scene?.tiles || [])) {
    if (excluded.has(String(doc?.id || ''))) continue;
    const grouping = resolveDocumentDisplayGrouping(doc);
    const elevationKey = String(grouping?.exactKey || '').trim();
    if (!elevationKey || getElevationBandIdentity(elevationKey) !== currentBandIdentity) continue;
    const group = groupedDocs.get(elevationKey) || {
      elevationKey,
      elevation: Number(grouping?.groupElevation ?? doc?.elevation ?? 0),
      docs: []
    };
    group.docs.push(doc);
    groupedDocs.set(elevationKey, group);
  }
  const docs = groupedDocs.get(currentElevationKey)?.docs || [];
  let target = resolveLayerManagerPreviewSortStep({
    docs,
    sectionMetadata: getSceneLayerManagerSections(canvas?.scene),
    sectionId: entry.sectionId,
    currentSort,
    anchorTileId,
    sortBefore,
    direction: normalizedDirection
  });
  if (!target) {
    const adjacent = resolveAdjacentElevationNudgeTarget({
      groups: Array.from(groupedDocs.values()),
      currentElevationKey,
      currentElevation: elevation,
      direction: normalizedDirection
    });
    if (!adjacent) return null;
    const ordered = adjacent.docs.slice().sort((left, right) => Number(left?.sort ?? 0) - Number(right?.sort ?? 0));
    const anchor = adjacent.edge === 'bottom' ? ordered[0] : ordered.at(-1);
    target = {
      anchorTileId: String(anchor?.id || '').trim() || null,
      sortBefore: adjacent.edge === 'bottom',
      sectionId: null,
      elevation: adjacent.elevation,
      elevationKey: adjacent.elevationKey,
      createdElevation: adjacent.created
    };
  } else {
    target.elevation = elevation;
    target.elevationKey = currentElevationKey;
    target.createdElevation = false;
  }
  const nextSectionId = String(target.sectionId || '').trim() || null;
  applyPreviewSectionIntent(previewId, container, nextSectionId);
  entry.sectionId = nextSectionId;
  if (announce !== false) queueMicrotask(() => {
    const refreshedEntries = collectLayerManagerPreviewEntries();
    const refreshedEntry = refreshedEntries.find((candidate) => (
      candidate?.previewKind === kind
      && candidate?.previewActive === true
      && Math.abs(Number(candidate?.documentElevation) - Number(target.elevation)) < 0.0001
    )) || null;
    const refreshedPreviewId = String(refreshedEntry?.previewId || '').trim();
    const refreshedContainer = previewContainersById.get(refreshedPreviewId) || null;
    if (refreshedPreviewId && refreshedPreviewId !== previewId && refreshedContainer) {
      previewSectionIdsById.delete(previewId);
      previewSectionAnchorIdsById.delete(previewId);
      applyPreviewSectionIntent(refreshedPreviewId, refreshedContainer, nextSectionId);
    }
    Hooks?.callAll?.('fa-nexus-preview-layers-changed', { source: 'preview-sort-nudge', previewId, previewKind: kind });
  });
  return { ...target, previewId, previewKey: entry.previewKey || null };
}

function buildPreviewSortContext(sort, overrides = {}) {
  const resolvedSort = Number(sort);
  const nextSort = Number.isFinite(resolvedSort) ? resolvedSort : 0;
  const previewSort = Number.isFinite(Number(overrides?.previewSort))
    ? Number(overrides.previewSort)
    : nextSort;
  return {
    sort: nextSort,
    placementSorts: [nextSort],
    previewSort,
    previewSorts: [previewSort],
    strategy: overrides?.strategy || 'layer-manager-preview-drop',
    anchorTileId: overrides?.anchorTileId || null,
    anchorTileSort: Number.isFinite(Number(overrides?.anchorTileSort)) ? Number(overrides.anchorTileSort) : null,
    siblingUpdates: []
  };
}

function resolvePreviewDropSortContext({
  target = null,
  targetElevation = null,
  viewState = null
} = {}) {
  if (target?.kind === 'section' || target?.kind === 'section-boundary') {
    const sectionId = String(
      (target?.kind === 'section' ? target?.sectionId : target?.boundarySectionId) || ''
    ).trim();
    const docs = sectionId
      ? (viewState?.fullSectionDocsById?.get?.(sectionId) || [])
      : (viewState?.fullElevationGroups?.get?.(target?.elevationKey) || []);
    const placeBefore = target?.kind === 'section' ? true : target?.placeBefore === true;
    const targetDoc = placeBefore ? docs[0] : docs.at(-1);
    const targetId = String(targetDoc?.id || '').trim();
    if (targetId) {
      return resolvePlacementSortAtElevation(targetElevation, {
        scene: canvas?.scene,
        anchorTileId: targetId,
        sortBefore: !placeBefore,
        count: 1
      });
    }
  }
  if (target?.kind === 'row') {
    const docs = Array.isArray(viewState?.fullElevationGroups?.get?.(target.elevationKey))
      ? viewState.fullElevationGroups.get(target.elevationKey)
      : [];
    const targetId = String(target?.rowId || '').trim();
    const targetDoc = docs.find((doc) => String(doc?.id || '') === targetId) || canvas?.scene?.tiles?.get?.(targetId) || null;
    const targetSortResult = targetDoc
      ? normalizeTileDocumentSortForPlacement(targetDoc, {
        scene: canvas?.scene,
        source: 'layer-manager-preview-drop'
      })
      : null;
    const targetSort = Number(targetSortResult?.sort ?? targetDoc?.sort ?? NaN);
    if (!targetDoc || !Number.isFinite(targetSort)) {
      const fallbackSort = Number.isFinite(targetSort)
        ? targetSort
        : (Number.isFinite(targetElevation) ? computeNextSortAtElevation(targetElevation) : 0);
      return buildPreviewSortContext(fallbackSort, {
        strategy: 'layer-manager-preview-drop-missing-row',
        anchorTileId: targetId,
        anchorTileSort: targetSort
      });
    }
    const resolved = resolvePlacementSortAtElevation(targetElevation, {
      scene: canvas?.scene,
      anchorTileId: targetId,
      sortBefore: target.placeBefore !== true,
      count: 1
    });
    const nextSort = Number(resolved?.sort);
    if (Number.isFinite(nextSort) && nextSort !== targetSort) return resolved;
    const fallbackSort = targetSort + (target.placeBefore ? TILE_SORT_STEP : -TILE_SORT_STEP);
    return buildPreviewSortContext(fallbackSort, {
      previewSort: fallbackSort,
      strategy: 'layer-manager-preview-drop-adjacent-row',
      anchorTileId: targetId,
      anchorTileSort: targetSort
    });
  }
  if (target?.kind === 'preview') {
    const targetPreviewEntry = getLayerManagerPreviewEntryById(viewState, target?.previewId);
    const targetSort = Number(targetPreviewEntry?.placementSort ?? targetPreviewEntry?.sort ?? NaN);
    const targetPreviewSort = Number(targetPreviewEntry?.sort ?? targetPreviewEntry?.placementSort ?? NaN);
    if (Number.isFinite(targetSort)) {
      const offset = target.placeBefore ? TILE_SORT_STEP : -TILE_SORT_STEP;
      return buildPreviewSortContext(targetSort + offset, {
        previewSort: (Number.isFinite(targetPreviewSort) ? targetPreviewSort : targetSort) + offset,
        strategy: 'layer-manager-preview-drop-preview'
      });
    }
  }
  const fallbackSort = Number.isFinite(targetElevation) ? computeNextSortAtElevation(targetElevation) : 0;
  return buildPreviewSortContext(fallbackSort, {
    strategy: 'layer-manager-preview-drop-top'
  });
}

export function canApplyLayerManagerPreviewDropWithoutSceneWrites({
  controller = null,
  siblingUpdates = []
} = {}) {
  const updates = Array.isArray(siblingUpdates) ? siblingUpdates : [];
  if (!updates.length) return true;
  if (controller?.canReindexLayerManagerPreviewSiblings?.() !== false) return true;
  return controller?.canStageLayerManagerPreviewSiblingReindex?.() === true;
}

export function shouldApplyLayerManagerPreviewSiblingUpdatesImmediately({
  controller = null,
  siblingUpdates = []
} = {}) {
  const updates = Array.isArray(siblingUpdates) ? siblingUpdates : [];
  return updates.length > 0 && controller?.canReindexLayerManagerPreviewSiblings?.() !== false;
}

export function canApplyLayerManagerPreviewDropWithinViewedLevel({
  controller = null,
  placementLevelId = undefined
} = {}) {
  return controller?.canApplyLayerManagerPreviewLevel?.({ placementLevelId }) !== false;
}

function resolveSyntheticTargetPlacementLevelId(elevationKey = '') {
  const normalizedKey = String(elevationKey || '').trim();
  if (!normalizedKey) return undefined;
  const match = /^(foreground|ground)(?:-band)?:([^:]+):.+$/.exec(normalizedKey);
  if (!match) return undefined;
  const placementLevelId = String(match[2] || '').trim();
  return placementLevelId && placementLevelId !== 'none' ? placementLevelId : '';
}

export function captureLayerManagerPreviewAnchorsForTileDrop({
  target = null,
  dragState = null,
  viewState = null
} = {}) {
  const movingIds = new Set((Array.isArray(dragState?.tileIds) ? dragState.tileIds : []).filter(Boolean));
  const entries = Array.isArray(viewState?.entries) ? viewState.entries : [];
  const targetElevationKey = String(target?.elevationKey || '').trim();
  if (!movingIds.size || !targetElevationKey || !entries.length) return [];

  const affectedKeys = new Set([targetElevationKey]);
  for (const id of movingIds) {
    const sourceKey = String(viewState?.fullTileGroupKeyById?.get?.(id) || '').trim();
    if (sourceKey) affectedKeys.add(sourceKey);
  }

  const anchors = [];
  for (const elevationKey of affectedKeys) {
    const groupEntries = entries.filter((entry) => String(entry?.elevationKey || '').trim() === elevationKey);
    for (let index = 0; index < groupEntries.length; index += 1) {
      const previewEntry = groupEntries[index];
      if (previewEntry?.preview !== true) continue;
      const previewId = String(previewEntry?.previewId || '').trim();
      const previewKind = String(previewEntry?.previewKind || '').trim();
      if (!previewId || !previewKind) continue;

      let previousTile = null;
      for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
        const candidate = groupEntries[previousIndex];
        const candidateId = String(candidate?.id || '').trim();
        if (!candidateId || candidate?.preview || candidate?.separator || candidate?.marker) continue;
        if (movingIds.has(candidateId)) continue;
        previousTile = candidate;
        break;
      }

      let nextTile = null;
      for (let nextIndex = index + 1; nextIndex < groupEntries.length; nextIndex += 1) {
        const candidate = groupEntries[nextIndex];
        const candidateId = String(candidate?.id || '').trim();
        if (!candidateId || candidate?.preview || candidate?.separator || candidate?.marker) continue;
        if (movingIds.has(candidateId)) continue;
        nextTile = candidate;
        break;
      }

      const anchorTile = previousTile || nextTile;
      const anchorTileId = String(anchorTile?.id || '').trim();
      if (!anchorTileId) {
        Logger.debug('LayerManager.tileDrop.previewAnchor.skip', {
          previewId,
          previewKind,
          elevationKey,
          reason: 'no-stable-neighbor',
          movingIds: Array.from(movingIds)
        });
        continue;
      }

      anchors.push({
        previewId,
        previewKind,
        previewKey: previewEntry.previewKey || null,
        elevationKey,
        elevation: Number(previewEntry?.documentElevation ?? previewEntry?.groupElevation ?? previewEntry?.elevation ?? NaN),
        placementLevelId: previewEntry?.placementLevelId ?? resolveSyntheticTargetPlacementLevelId(elevationKey),
        anchorTileId,
        placeBefore: !previousTile
      });
    }
  }
  return anchors;
}

export async function applyLayerManagerPreviewAnchorsAfterTileDrop({
  anchors = [],
  resolveGroupElevation = null,
  resolvePreviewSessionController = null,
  setLastActivePreviewId = null,
  scheduleRender = null
} = {}) {
  if (!Array.isArray(anchors) || !anchors.length) return;
  for (const anchor of anchors) {
    const previewId = String(anchor?.previewId || '').trim();
    const previewKind = String(anchor?.previewKind || '').trim();
    const anchorTileId = String(anchor?.anchorTileId || '').trim();
    const targetElevationKey = String(anchor?.elevationKey || '').trim();
    if (!previewId || !previewKind || !anchorTileId || !targetElevationKey) continue;

    const rawTargetElevation = resolveGroupElevation(targetElevationKey);
    const targetElevation = rawTargetElevation == null ? NaN : Number(rawTargetElevation);
    if (!Number.isFinite(targetElevation)) {
      Logger.warn('LayerManager.tileDrop.previewAnchor.missingElevation', {
        previewId,
        previewKind,
        targetElevationKey,
        anchorTileId,
        sceneId: canvas?.scene?.id || null
      });
      continue;
    }

    const controller = resolvePreviewSessionController(previewKind);
    if (!controller || typeof controller.applyLayerManagerPreviewPlacement !== 'function') {
      Logger.warn('LayerManager.tileDrop.previewAnchor.controllerUnavailable', {
        previewId,
        previewKind,
        targetElevation,
        targetElevationKey,
        anchorTileId,
        sceneId: canvas?.scene?.id || null
      });
      continue;
    }

    const sortBefore = anchor.placeBefore !== true;
    const sortContext = resolvePlacementSortAtElevation(targetElevation, {
      scene: canvas?.scene,
      anchorTileId,
      sortBefore,
      count: 1
    });
    const nextSort = Number(sortContext?.sort);
    const previewSort = Number(sortContext?.previewSort);
    if (!Number.isFinite(nextSort)) {
      Logger.warn('LayerManager.tileDrop.previewAnchor.invalidSort', {
        previewId,
        previewKind,
        targetElevation,
        targetElevationKey,
        anchorTileId,
        sortStrategy: sortContext?.strategy || null,
        sceneId: canvas?.scene?.id || null
      });
      continue;
    }

    Logger.info('LayerManager.tileDrop.previewAnchor.apply', {
      previewId,
      previewKind,
      targetElevationKey,
      targetElevation,
      anchorTileId,
      placeBefore: anchor.placeBefore === true,
      nextSort,
      previewSort: Number.isFinite(previewSort) ? previewSort : null,
      sortStrategy: sortContext?.strategy || null,
      siblingUpdates: Array.isArray(sortContext?.siblingUpdates) ? sortContext.siblingUpdates.length : 0,
      placementLevelId: anchor.placementLevelId ?? null
    });

    const applied = await Promise.resolve(controller.applyLayerManagerPreviewPlacement({
      elevation: targetElevation,
      sort: nextSort,
      previewSort: Number.isFinite(previewSort) ? previewSort : nextSort,
      previewKind,
      previewId,
      previewKey: anchor.previewKey || null,
      placementLevelId: anchor.placementLevelId ?? undefined,
      anchorTileId,
      sortBefore,
      announce: false,
      immediate: true
    }));

    if (!applied) {
      Logger.warn('LayerManager.tileDrop.previewAnchor.noop', {
        previewId,
        previewKind,
        targetElevation,
        targetElevationKey,
        anchorTileId,
        nextSort
      });
    } else {
      setLastActivePreviewId(previewId);
    }
  }
  scheduleRender();
}

export async function applyLayerManagerPreviewDropReorder({
  target = null,
  dragState = null,
  viewState = null,
  resolveGroupElevation = null,
  resolvePreviewSessionController = null,
  captureListScrollTop = null,
  preserveListScrollTop = null,
  setLastActivePreviewId = null,
  scheduleRender = null
} = {}) {
  const previewId = String(dragState?.previewId || '').trim();
  const previewKind = String(dragState?.previewKind || '').trim();
  if (!previewId || !previewKind) return;

  const previewEntry = getLayerManagerPreviewEntryById(viewState, previewId);
  if (!previewEntry?.preview) {
    Logger.debug('LayerManager.previewDrop.missingPreviewEntry', {
      previewId,
      previewKind,
      sceneId: canvas?.scene?.id || null
    });
    return;
  }

  const targetElevationKey = String(target?.elevationKey || '').trim();
  const rawTargetElevation = resolveGroupElevation(targetElevationKey);
  const targetElevation = rawTargetElevation == null ? NaN : Number(rawTargetElevation);
  if (!Number.isFinite(targetElevation)) {
    Logger.warn('LayerManager.previewDrop.missingTargetElevation', {
      previewId,
      previewKind,
      targetElevationKey,
      sceneId: canvas?.scene?.id || null
    });
    return;
  }

  const controller = resolvePreviewSessionController(previewKind);
  if (!controller || typeof controller.applyLayerManagerPreviewPlacement !== 'function') {
    Logger.warn('LayerManager.previewDrop.controllerUnavailable', {
      previewId,
      previewKind,
      targetElevation,
      targetElevationKey,
      sceneId: canvas?.scene?.id || null
    });
    return;
  }

  const sortContext = resolvePreviewDropSortContext({ target, targetElevation, viewState });
  const nextSort = Number(sortContext?.sort);
  const previewSort = Number(sortContext?.previewSort);
  const anchorTileId = String(sortContext?.anchorTileId || '').trim() || null;
  const sortBefore = target?.kind === 'section'
    ? false
    : (target?.kind === 'row' || target?.kind === 'section-boundary'
      ? target.placeBefore !== true
      : undefined);
  const placementLevelId = resolveSyntheticTargetPlacementLevelId(targetElevationKey);
  let previewContainer = previewContainersById.get(previewId) || null;
  const targetSectionId = String(target?.sectionId || '').trim() || null;
  const currentSectionId = String(
    previewContainer?.faNexusSectionId || previewEntry?.sectionId || ''
  ).trim() || null;
  const sectionChanged = currentSectionId !== targetSectionId;
  const listScrollTop = captureListScrollTop();
  if (!canApplyLayerManagerPreviewDropWithinViewedLevel({ controller, placementLevelId })) {
    Logger.warn('LayerManager.previewDrop.blockedCrossLevel', {
      previewId,
      previewKind,
      targetElevationKey,
      targetElevation,
      placementLevelId: placementLevelId ?? null,
      sceneId: canvas?.scene?.id || null
    });
    globalThis.ui?.notifications?.warn?.(
      'This preview stays within the currently viewed Level. View the target Level before moving it there.'
    );
    return;
  }
  const siblingUpdates = Array.isArray(sortContext?.siblingUpdates) ? sortContext.siblingUpdates : [];
  if (!canApplyLayerManagerPreviewDropWithoutSceneWrites({ controller, siblingUpdates })) {
    Logger.warn('LayerManager.previewDrop.blockedSceneWrite', {
      previewId,
      previewKind,
      targetElevationKey,
      targetElevation,
      siblingUpdates: siblingUpdates.length,
      sceneId: canvas?.scene?.id || null
    });
    globalThis.ui?.notifications?.warn?.(
      'That preview position has no free stacking slot. Move it beside another layer; Building Editor V2 will not reorder Scene Tiles before Commit.'
    );
    return;
  }
  Logger.info('LayerManager.previewDrop.apply', {
    previewId,
    previewKind,
    targetKind: target?.kind || null,
    targetElevationKey,
    targetElevation,
    nextSort,
    previewSort: Number.isFinite(previewSort) ? previewSort : null,
    sortStrategy: sortContext?.strategy || null,
    siblingUpdates: Array.isArray(sortContext?.siblingUpdates) ? sortContext.siblingUpdates.length : 0,
    anchorTileId,
    placementLevelId: placementLevelId ?? null
  });

  const applied = await Promise.resolve(controller.applyLayerManagerPreviewPlacement({
    elevation: targetElevation,
    sort: nextSort,
    previewSort: Number.isFinite(previewSort) ? previewSort : nextSort,
    previewKind,
    previewId,
    previewKey: previewEntry.previewKey || null,
    targetPreviewId: target?.kind === 'preview' ? String(target?.previewId || '').trim() || null : null,
    placementLevelId,
    anchorTileId,
    sortBefore,
    sortOverride: true,
    announce: false,
    immediate: true
  }));

  if (!applied && !sectionChanged) {
    Logger.warn('LayerManager.previewDrop.noop', {
      previewId,
      previewKind,
      targetElevation,
      targetElevationKey,
      nextSort,
      anchorTileId
    });
    return;
  }

  if (shouldApplyLayerManagerPreviewSiblingUpdatesImmediately({ controller, siblingUpdates })) {
    await canvas?.scene?.updateEmbeddedDocuments?.('Tile', siblingUpdates);
    if (Number.isFinite(nextSort) && previewSort !== nextSort) {
      await Promise.resolve(controller.applyLayerManagerPreviewPlacement({
        elevation: targetElevation,
        sort: nextSort,
        previewSort: nextSort,
        previewKind,
        previewId,
        previewKey: previewEntry.previewKey || null,
        targetPreviewId: target?.kind === 'preview' ? String(target?.previewId || '').trim() || null : null,
        placementLevelId,
        anchorTileId,
        sortBefore,
        sortOverride: true,
        announce: false,
        immediate: true
      }));
    }
  }
  const refreshedEntries = collectLayerManagerPreviewEntries();
  const refreshedEntry = refreshedEntries.find((entry) => (
    String(entry?.previewId || '').trim() === previewId
    && Math.abs(Number(entry?.documentElevation) - targetElevation) < 0.0001
  ))
    || refreshedEntries.find((entry) => (
      entry?.previewKind === previewKind
      && String(entry?.previewKey || '').trim() === String(previewEntry?.previewKey || '').trim()
      && Math.abs(Number(entry?.documentElevation) - targetElevation) < 0.0001
    ))
    || refreshedEntries.find((entry) => (
      entry?.previewKind === previewKind
      && entry?.previewActive === true
      && Math.abs(Number(entry?.documentElevation) - targetElevation) < 0.0001
    ))
    || null;
  const effectivePreviewId = String(refreshedEntry?.previewId || previewId).trim();
  const previousPreviewContainer = previewContainer;
  previewContainer = previewContainersById.get(effectivePreviewId) || previewContainer;
  if (previousPreviewContainer && previousPreviewContainer !== previewContainer && !previousPreviewContainer.destroyed) {
    delete previousPreviewContainer.faNexusSectionId;
  }
  previewSectionIdsById.delete(previewId);
  previewSectionIdsById.delete(effectivePreviewId);
  previewSectionAnchorIdsById.delete(previewId);
  previewSectionAnchorIdsById.delete(effectivePreviewId);
  applyPreviewSectionIntent(effectivePreviewId, previewContainer, targetSectionId);
  preserveListScrollTop(listScrollTop);
  setLastActivePreviewId(effectivePreviewId);
  scheduleRender();
}
