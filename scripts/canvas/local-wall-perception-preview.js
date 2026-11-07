const RESTRICTION_TYPES = Object.freeze(['move', 'sight', 'light', 'darkness', 'sound']);
const ACTIVE_WALL_PREVIEWS = new WeakMap();

function values(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return Array.from(collection.values());
  return Array.from(collection);
}

function documentName(document) {
  return String(document?.documentName || document?.constructor?.documentName || '');
}

function finiteCoordinates(document) {
  const coordinates = Array.from(document?._source?.c || document?.c || [], Number);
  if (coordinates.length !== 4 || coordinates.some((value) => !Number.isFinite(value))) {
    throw new Error(`Local Wall perception preview requires four finite coordinates for Wall ${String(document?.id || '')}.`);
  }
  return coordinates;
}

function restrictedRegions(scene, levels) {
  return values(scene?.regions).filter((region) => {
    const restriction = region?._source?.restriction || region?.restriction || {};
    const enabled = restriction.enabled === true || !!region?._source?._shapeConstraints;
    if (!enabled) return false;
    const type = String(restriction.type || '').trim();
    if (type && !RESTRICTION_TYPES.includes(type)) return false;
    return levels.some((level) => (
      typeof region?.includedInLevel !== 'function' || region.includedInLevel(level?.id)
    ));
  });
}

function refreshPerception(canvas, restrictions) {
  if (!restrictions.changed) return;
  canvas.perception.update({
    initializeLighting: restrictions.light || restrictions.darkness,
    initializeVision: restrictions.sight,
    initializeSounds: restrictions.sound,
    refreshVision: true
  });
  if (restrictions.move) canvas.tokens.recalculatePlannedMovementPaths();
}

function edgeRestrictions(edges, none) {
  const restrictions = {
    changed: edges.length > 0,
    move: false,
    sight: false,
    light: false,
    darkness: false,
    sound: false
  };
  for (const edge of edges) {
    for (const type of RESTRICTION_TYPES) {
      if (edge?.[type] !== none) restrictions[type] = true;
    }
  }
  return restrictions;
}

function replaceLevelEntries(records, buildEdge = null) {
  const replacements = [];
  for (const record of records) {
    for (const level of record.levels) level.edges.delete(record.edgeId);
    if (buildEdge) {
      const edge = buildEdge(record);
      for (const level of record.includedLevels) level.edges.set(record.edgeId, edge);
      replacements.push(edge);
      record.previewEdge = edge;
    } else {
      for (const entry of record.baselineEntries) {
        if (entry.edge) entry.level.edges.set(record.edgeId, entry.edge);
      }
      record.previewEdge = null;
    }
  }
  return replacements;
}

function releaseOwnership(handle) {
  if (handle.released) return;
  handle.released = true;
  for (const record of handle.records) {
    if (ACTIVE_WALL_PREVIEWS.get(record.document) === handle) {
      ACTIVE_WALL_PREVIEWS.delete(record.document);
    }
  }
}

/**
 * Stage acting-client-only Wall Edges for held transforms without touching WallDocument#edge.
 * The caller owns the returned handle for exactly one gesture and must cancel or complete it.
 */
export function beginLocalWallPerceptionPreview(documents, {
  source = 'local-wall-transform',
  getCanvas = () => globalThis.canvas,
  getEdgeClass = () => globalThis.foundry?.canvas?.geometry?.edges?.Edge,
  getConstants = () => globalThis.CONST
} = {}) {
  const walls = Array.from(new Set((documents || []).filter((document) => documentName(document) === 'Wall')));
  if (!walls.length) return null;
  const canvas = getCanvas();
  const scene = canvas?.scene;
  const Edge = getEdgeClass();
  const none = getConstants()?.EDGE_SENSE_TYPES?.NONE ?? 0;
  if (!scene || canvas?.ready !== true || scene.initializedEdges !== true) {
    throw new Error('Local Wall perception preview requires the active ready Scene with initialized Edges.');
  }
  if (typeof Edge !== 'function' || typeof canvas?.perception?.update !== 'function'
    || typeof canvas?.tokens?.recalculatePlannedMovementPaths !== 'function') {
    throw new Error('Local Wall perception preview requires Foundry v14 Edge and perception APIs.');
  }
  const levels = values(scene.levels);
  if (!levels.length || levels.some((level) => !level?.edges?.set || !level?.edges?.delete)) {
    throw new Error('Local Wall perception preview requires every active Scene Level Edge collection.');
  }
  if (walls.some((wall) => wall?.parent !== scene)) {
    throw new Error('Local Wall perception preview cannot span inactive or different Scenes.');
  }
  const conflicts = walls.filter((wall) => ACTIVE_WALL_PREVIEWS.has(wall));
  if (conflicts.length) {
    throw new Error(`Local Wall perception preview already owns: ${conflicts.map((wall) => wall.id).join(', ')}.`);
  }
  const records = walls.map((document) => {
    const edge = document.edge;
    if (!edge?.id) throw new Error(`Local Wall perception preview requires Wall ${String(document.id || '')} to own an Edge.`);
    finiteCoordinates(document);
    return {
      document,
      edgeId: String(edge.id),
      baselineDocumentEdge: edge,
      levels,
      includedLevels: levels.filter((level) => document.includedInLevel(level.id)),
      baselineEntries: levels.map((level) => ({ level, edge: level.edges.get(edge.id) || null })),
      previewEdge: null
    };
  });
  const restrictions = edgeRestrictions(records.map((record) => record.baselineDocumentEdge), none);
  const blockedRegions = restrictedRegions(scene, levels);
  const handle = {
    source: String(source || 'local-wall-transform'),
    scene,
    records,
    restrictions,
    supported: blockedRegions.length === 0,
    reason: blockedRegions.length ? 'restricted-regions' : null,
    blockedRegionIds: blockedRegions.map((region) => String(region.id || '')),
    applied: false,
    released: false,
    apply() {
      if (this.released) throw new Error(`Local Wall perception preview ${this.source} is already released.`);
      if (!this.supported) return false;
      replaceLevelEntries(this.records, (record) => {
        const baseline = record.baselineDocumentEdge;
        const [x1, y1, x2, y2] = finiteCoordinates(record.document);
        return new Edge({ x: x1, y: y1 }, { x: x2, y: y2 }, {
          id: baseline.id,
          object: record.document,
          type: baseline.type || 'wall',
          direction: baseline.direction,
          light: baseline.light,
          darkness: baseline.darkness,
          move: baseline.move,
          sight: baseline.sight,
          sound: baseline.sound,
          threshold: baseline.threshold ? structuredClone(baseline.threshold) : null,
          priority: baseline.priority
        });
      });
      this.applied = true;
      refreshPerception(canvas, this.restrictions);
      return true;
    },
    restore({ release = false } = {}) {
      if (this.released) return false;
      try {
        if (this.applied && this.supported) {
          replaceLevelEntries(this.records);
          this.applied = false;
          refreshPerception(canvas, this.restrictions);
        }
        return true;
      } finally {
        if (release) releaseOwnership(this);
      }
    },
    cancel() {
      return this.restore({ release: true });
    },
    complete() {
      if (this.released) return false;
      let recovered = false;
      try {
        if (this.supported) {
          for (const record of this.records) {
            const authoritative = record.document.edge;
            const included = record.levels.filter((level) => record.document.includedInLevel(level.id));
            const exact = authoritative?.id === record.edgeId
              && included.every((level) => level.edges.get(record.edgeId) === authoritative)
              && record.levels.filter((level) => !included.includes(level))
                .every((level) => !level.edges.has(record.edgeId));
            if (exact) continue;
            for (const level of record.levels) level.edges.delete(record.edgeId);
            if (authoritative) {
              for (const level of included) level.edges.set(record.edgeId, authoritative);
            }
            recovered = true;
          }
        }
        if (recovered) refreshPerception(canvas, this.restrictions);
        return true;
      } finally {
        releaseOwnership(this);
      }
    }
  };
  for (const record of records) ACTIVE_WALL_PREVIEWS.set(record.document, handle);
  return handle;
}
