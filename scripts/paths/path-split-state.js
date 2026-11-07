const DEFAULT_PATH_SEGMENT_SAMPLES = 200;
const MIN_SPLITTABLE_PATH_POINTS = 3;

const quantizeElevation = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const quantized = Math.round(numeric * 1000) / 1000;
  return Object.is(quantized, -0) ? 0 : quantized;
};

function normalizeFeather(raw = {}) {
  const startModeRaw = String(raw.startMode || '').toLowerCase();
  const endModeRaw = String(raw.endMode || '').toLowerCase();
  const normalizeMode = (mode) => (mode === 'shrink' ? 'shrink' : mode === 'grow' ? 'shrink' : 'none');
  return {
    startMode: normalizeMode(startModeRaw),
    endMode: normalizeMode(endModeRaw),
    startLength: Math.max(0, Number(raw.startLength) || 0),
    endLength: Math.max(0, Number(raw.endLength) || 0)
  };
}

function normalizeOpacityFeather(raw = {}) {
  return {
    startEnabled: !!raw.startEnabled,
    endEnabled: !!raw.endEnabled,
    startLength: Math.max(0, Number(raw.startLength) || 0),
    endLength: Math.max(0, Number(raw.endLength) || 0)
  };
}

function clonePathControlPoint(point = {}) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    widthLeft: Number.isFinite(point?.widthLeft) ? Number(point.widthLeft) : 1,
    widthRight: Number.isFinite(point?.widthRight) ? Number(point.widthRight) : 1
  };
}

function clonePathShadowPoint(point = {}) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    widthLeft: Number.isFinite(point?.widthLeft) ? Number(point.widthLeft) : 1,
    widthRight: Number.isFinite(point?.widthRight) ? Number(point.widthRight) : 1,
    offset: Number.isFinite(point?.offset) ? Number(point.offset) : 0,
    _anchorX: Number.isFinite(point?._anchorX) ? Number(point._anchorX) : undefined,
    _anchorY: Number.isFinite(point?._anchorY) ? Number(point._anchorY) : undefined,
    _anchorSegment: Number.isFinite(point?._anchorSegment) ? Number(point._anchorSegment) : undefined,
    _anchorT: Number.isFinite(point?._anchorT) ? Number(point._anchorT) : undefined
  };
}

function clonePathSessionEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    texturePath: entry.texturePath || '',
    texture: entry.texture || null,
    basePathWidth: Number.isFinite(entry.basePathWidth) ? entry.basePathWidth : null,
    baseRepeatSpacing: Number.isFinite(entry.baseRepeatSpacing) ? entry.baseRepeatSpacing : null,
    controlPoints: Array.isArray(entry.controlPoints)
      ? entry.controlPoints.map(clonePathControlPoint)
      : [],
    closed: !!entry.closed,
    width: Number(entry.width) || 0,
    repeatSpacing: Number(entry.repeatSpacing) || 0,
    tension: Number(entry.tension) || 0,
    samplesPerSegment: Math.max(2, Math.floor(entry.samplesPerSegment || DEFAULT_PATH_SEGMENT_SAMPLES)),
    textureOffset: {
      x: Number(entry.textureOffset?.x) || 0,
      y: Number(entry.textureOffset?.y) || 0
    },
    textureFlip: {
      horizontal: !!entry.textureFlip?.horizontal,
      vertical: !!entry.textureFlip?.vertical
    },
    feather: normalizeFeather(entry.feather || {}),
    opacityFeather: normalizeOpacityFeather(entry.opacityFeather || {}),
    layerOpacity: Number.isFinite(entry.layerOpacity) ? entry.layerOpacity : 1,
    // The colour of the path goes with both halves of a split.
    ...(entry.hsbc && typeof entry.hsbc === 'object' ? { hsbc: { ...entry.hsbc } } : {}),
    elevation: Number.isFinite(entry.elevation) ? quantizeElevation(entry.elevation) : 0,
    shadow: entry.shadow ? { ...entry.shadow } : null,
    shadowPoints: Array.isArray(entry.shadowPoints)
      ? entry.shadowPoints.map(clonePathShadowPoint)
      : [],
    spawnWalls: !!entry.spawnWalls,
    // What the path's Foundry Walls block goes with both halves of a split.
    ...(entry.wallBehavior ? { wallBehavior: entry.wallBehavior } : {}),
    wallGroupId: entry.wallGroupId || null,
    wallIds: Array.isArray(entry.wallIds) ? [...entry.wallIds] : [],
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null
  };
}

function failure(reason, details) {
  return { ok: false, reason, details };
}

export function splitPathSessionSnapshot(snapshot, splitIndex, {
  sourcePathId = null,
  activePathId = null,
  now = null
} = {}) {
  const numericSplitIndex = Number(splitIndex);
  if (!snapshot || !Array.isArray(snapshot.sessionPaths)) {
    return failure('snapshotMissing', {
      splitIndex: numericSplitIndex,
      activePathId: activePathId || null
    });
  }

  const resolvedSourcePathId = sourcePathId || snapshot.activePathId || activePathId || null;
  const sourceIndex = snapshot.sessionPaths.findIndex((entry) => entry?.id === resolvedSourcePathId);
  if (sourceIndex < 0) {
    return failure('pathMissing', {
      splitIndex: numericSplitIndex,
      activePathId: resolvedSourcePathId
    });
  }

  const sourceEntry = snapshot.sessionPaths[sourceIndex];
  const sourcePoints = Array.isArray(sourceEntry?.controlPoints)
    ? sourceEntry.controlPoints.map(clonePathControlPoint)
    : [];
  if (sourceEntry?.closed || sourcePoints.length < MIN_SPLITTABLE_PATH_POINTS) {
    return failure('invalidSource', {
      splitIndex: numericSplitIndex,
      activePathId: resolvedSourcePathId,
      closed: !!sourceEntry?.closed,
      pointCount: sourcePoints.length
    });
  }
  if (!Number.isInteger(numericSplitIndex) || numericSplitIndex <= 0 || numericSplitIndex >= (sourcePoints.length - 1)) {
    return failure('invalidIndex', {
      splitIndex: numericSplitIndex,
      activePathId: resolvedSourcePathId,
      pointCount: sourcePoints.length
    });
  }

  const sourceShadowPoints = Array.isArray(sourceEntry?.shadowPoints)
    ? sourceEntry.shadowPoints.map(clonePathShadowPoint)
    : [];
  const hasManualShadowSplit = sourceShadowPoints.length === sourcePoints.length;
  let pathIdCounter = Number.isFinite(snapshot.pathIdCounter) ? snapshot.pathIdCounter : 0;
  const nextPathId = () => `path_${++pathIdCounter}`;
  const createdAt = Number.isFinite(now) ? Number(now) : Date.now();
  const buildSplitEntry = (controlPoints, shadowPoints) => {
    const entry = clonePathSessionEntry(sourceEntry);
    if (!entry) {
      return null;
    }
    entry.id = nextPathId();
    entry.controlPoints = controlPoints.map(clonePathControlPoint);
    entry.closed = false;
    entry.wallGroupId = null;
    entry.wallIds = [];
    entry.createdAt = createdAt;
    if (hasManualShadowSplit) {
      entry.shadowPoints = shadowPoints.map(clonePathShadowPoint);
    } else {
      entry.shadowPoints = [];
      if (entry.shadow?.manual) {
        entry.shadow = {
          ...entry.shadow,
          manual: false,
          editMode: false
        };
      }
    }
    return entry;
  };

  const leadingEntry = buildSplitEntry(
    sourcePoints.slice(0, numericSplitIndex + 1),
    sourceShadowPoints.slice(0, numericSplitIndex + 1)
  );
  const trailingEntry = buildSplitEntry(
    sourcePoints.slice(numericSplitIndex),
    sourceShadowPoints.slice(numericSplitIndex)
  );
  if (!leadingEntry || !trailingEntry) {
    return failure('cloneFailed', {
      splitIndex: numericSplitIndex,
      activePathId: resolvedSourcePathId
    });
  }

  const nextSnapshot = {
    ...snapshot,
    sessionPaths: snapshot.sessionPaths.map(clonePathSessionEntry)
  };
  nextSnapshot.sessionPaths.splice(sourceIndex, 1, leadingEntry, trailingEntry);
  nextSnapshot.activeSnapshot = null;
  nextSnapshot.activePathId = trailingEntry.id;
  nextSnapshot.lastPlacedPathId = trailingEntry.id;
  nextSnapshot.pathIdCounter = pathIdCounter;

  return {
    ok: true,
    snapshot: nextSnapshot,
    splitIndex: numericSplitIndex,
    sourcePathId: resolvedSourcePathId,
    leadingPathId: leadingEntry.id,
    trailingPathId: trailingEntry.id,
    sourcePointCount: sourcePoints.length
  };
}
