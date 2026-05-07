import { NexusLogger as Logger } from '../../core/nexus-logger.js';

export function clearSceneMarkerSelection({
  selectedSceneMarkers = null,
  scheduleRender = null
} = {}) {
  if (!selectedSceneMarkers?.size) return false;
  selectedSceneMarkers.clear();
  try { scheduleRender?.(); } catch (_) {}
  return true;
}

export function selectSceneMarker({
  markerId = '',
  event = null,
  selectedSceneMarkers = null,
  releaseAllTiles = null,
  scheduleRender = null,
  updateFlattenFooter = null
} = {}) {
  const id = String(markerId || '').trim();
  if (!id || !(selectedSceneMarkers instanceof Set)) return false;
  const isMeta = !!(event?.ctrlKey || event?.metaKey);
  const isShift = !!event?.shiftKey;
  const allowMulti = isMeta || isShift;
  if (!allowMulti) {
    try { releaseAllTiles?.(); } catch (_) {}
    selectedSceneMarkers.clear();
    selectedSceneMarkers.add(id);
  } else if (selectedSceneMarkers.has(id)) {
    selectedSceneMarkers.delete(id);
  } else {
    selectedSceneMarkers.add(id);
  }
  try { scheduleRender?.(); } catch (_) {}
  try { updateFlattenFooter?.(); } catch (_) {}
  return true;
}

export function adjustSceneMarkerElevationBlocked({
  markerId = '',
  viewEntries = [],
  direction,
  step,
  sceneId = canvas?.scene?.id || null,
  currentLevelId = null
} = {}) {
  const markerEntry = Array.isArray(viewEntries)
    ? viewEntries.find((entry) => entry?.marker && entry.markerId === markerId) || null
    : null;
  Logger.warn('LayerManager.levelMarker.adjust.blocked', {
    markerId: markerId || null,
    kind: markerEntry?.markerKind || null,
    levelId: markerEntry?.markerLevelId || null,
    scope: markerEntry?.markerScope || null,
    direction,
    step,
    sceneId,
    levelId: currentLevelId
  });
  ui?.notifications?.warn?.('Level background/foreground marker elevation editing is not migrated yet. Edit the level directly for now.');
  return false;
}

export function resolveDoubleContextClick({
  tileId = '',
  lastContextClick = null,
  thresholdMs = 350,
  now = Date.now()
} = {}) {
  const last = lastContextClick || { id: null, time: 0 };
  return {
    isDouble: last.id === tileId && (now - last.time) < thresholdMs,
    nextState: { id: tileId, time: now }
  };
}

export function openTileSettings({
  tile = null,
  clickEventStub = null,
  user = game?.user
} = {}) {
  const canView = tile?.document?.testUserPermission?.(user, 'LIMITED');
  if (!canView) return false;
  const stub = Object.assign({}, clickEventStub || {});
  if (typeof tile?._onClickRight2 === 'function') {
    try { tile._onClickRight2(stub); } catch (_) {}
    return true;
  }
  try {
    tile?.sheet?.render?.({ force: true });
    return true;
  } catch (_) {
    return false;
  }
}

export function openSceneSettings({
  scene = canvas?.scene
} = {}) {
  try {
    scene?.sheet?.render?.({ force: true });
    return true;
  } catch (_) {
    return false;
  }
}
