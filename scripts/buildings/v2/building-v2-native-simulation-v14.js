import { createBuildingV2SurfaceRegionSimulationV14 } from './building-v2-surface-region-simulation-v14.js';
import { createBuildingV2DoorSimulationV14 } from './building-v2-door-simulation-v14.js';
import { materializeBuildingV2WindowWall } from './building-v2-window.js';

const RESTRICTION_TYPES = Object.freeze(['move', 'sight', 'light', 'darkness', 'sound']);

function nativeEdgeThreshold(threshold, scene) {
  if (!threshold) return null;
  const toPixels = value => {
    if (value == null || value === 0) return 0;
    const distancePixels = scene?.dimensions?.distancePixels;
    if (!Number.isFinite(distancePixels) || distancePixels <= 0) {
      throw new Error('Building V2 native thresholds require the Scene distance-to-pixel conversion.');
    }
    return value * distancePixels;
  };
  // Match WallDocument's v14 Edge construction. Authored/native Wall payloads
  // store Scene distance units; Edge.applyThreshold consumes Canvas pixels.
  return { light: toPixels(threshold.light), sight: toPixels(threshold.sight),
    sound: toPixels(threshold.sound), attenuation: threshold.attenuation === true };
}

function collectionValues(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return Array.from(collection.values());
  return Array.from(collection);
}

function hasRestrictedRegions(scene, level) {
  return collectionValues(scene?.regions).some((region) => {
    const restriction = region?._source?.restriction || region?.restriction || {};
    const enabled = restriction.enabled === true || !!region?._source?._shapeConstraints;
    if (!enabled) return false;
    if (typeof region?.includedInLevel === 'function' && !region.includedInLevel(level?.id)) return false;
    const type = String(restriction.type || '').trim();
    return !type || RESTRICTION_TYPES.includes(type);
  });
}

function refreshNativeEffects(canvas, level) {
  if (level?.isView !== false) {
    canvas?.perception?.update?.({ initializeVision: true });
    canvas?.tokens?.recalculatePlannedMovementPaths?.();
  }
  if (level?.isVisible !== false) {
    canvas?.perception?.update?.({
      refreshVision: true,
      initializeLighting: true,
      initializeSounds: true
    });
  }
}

function destroyPrepared(prepared, getCanvas, surfaceHost, doorHost) {
  if (!prepared || prepared.released) return false;
  const canvas = prepared.canvas || getCanvas();
  const errors = [];
  if (prepared.mounted) for (const edge of prepared.edges || []) {
    try {
      if (canvas.edges.get(edge.id) === edge) canvas.edges.delete(edge.id);
    } catch (error) { errors.push(error); }
  }
  try { if (prepared.doors) doorHost.release(prepared.doors); } catch (error) { errors.push(error); }
  try { if (prepared.surface) surfaceHost.release(prepared.surface); } catch (error) { errors.push(error); }
  try { if (prepared.mounted) refreshNativeEffects(canvas, prepared.level); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Building V2 native simulation cleanup failed.');
  prepared.released = true;
  return true;
}

export function createBuildingV2NativeSimulationV14({
  getCanvas = () => globalThis.canvas,
  getEdgeClass = () => globalThis.foundry?.canvas?.geometry?.edges?.Edge,
  getConstants = () => globalThis.CONST,
  createSurfaceSimulation = createBuildingV2SurfaceRegionSimulationV14,
  createDoorSimulation = createBuildingV2DoorSimulationV14
} = {}) {
  const surfaceHost = createSurfaceSimulation({ getCanvas });
  const doorHost = createDoorSimulation({ getCanvas });
  return Object.freeze({
    probe({ sceneId, placementLevelId } = {}) {
      const canvas = getCanvas();
      const level = canvas?.level;
      if (String(canvas?.scene?.id || '') !== String(sceneId || '')) {
        throw new Error('Building V2 native simulation requires the active Scene Canvas.');
      }
      if (canvas?.ready !== true || canvas?.scene?.initializedEdges !== true) {
        throw new Error('Building V2 native simulation requires a ready Canvas with initialized Scene edges.');
      }
      if (!canvas?.edges?.set || !canvas?.edges?.get || !canvas?.edges?.delete || !canvas?.edges?.getEdges || typeof getEdgeClass() !== 'function') {
        throw new Error('Building V2 native simulation requires Foundry v14 Edge and canvas.edges APIs.');
      }
      if (typeof canvas?.perception?.update !== 'function'
        || typeof canvas?.tokens?.recalculatePlannedMovementPaths !== 'function') {
        throw new Error('Building V2 native simulation requires Foundry perception and planned-movement refresh APIs.');
      }
      const targetLevelId = String(placementLevelId || '').trim();
      if (targetLevelId && String(level?.id || '') !== targetLevelId) {
        throw new Error('Building V2 Gate A native simulation currently requires the planned placement Level to be the viewed Canvas Level.');
      }
      if (hasRestrictedRegions(canvas.scene, level)) {
        throw new Error('Building V2 Gate A cannot simulate native restrictions while active restricted Regions would require Scene document updates.');
      }
      return { canvas, level };
    },

    async prepare(projection) {
      if (!projection || Number(projection.version) !== 1 || !Array.isArray(projection.nativeFragments)) {
        throw new Error('Building V2 native simulation requires compiler contract version 1 and native fragments.');
      }
      const { canvas, level } = this.probe({
        sceneId: projection.sceneId,
        placementLevelId: projection.placement?.levels?.length === 1 ? projection.placement.levels[0] : null
      });
      if (projection.placement?.levels?.length && !projection.placement.levels.includes(level?.id)) {
        throw new Error('Building V2 native simulation requires a viewed Level included in its native Wall scope.');
      }
      const Edge = getEdgeClass();
      const constants = getConstants();
      const normal = constants?.EDGE_SENSE_TYPES?.NORMAL ?? constants?.WALL_MOVEMENT_TYPES?.NORMAL ?? 20;
      const both = constants?.EDGE_DIRECTIONS?.BOTH ?? 0;
      const edges = projection.nativeFragments.map((fragment, index) => {
        const authoredBehavior = fragment?.behavior || {};
        const windowNative = fragment?.door?.portalKind === 'window'
          ? materializeBuildingV2WindowWall(fragment.door.setup, {
            a: fragment.a,
            b: fragment.b,
            dir: authoredBehavior.dir || 0,
            state: fragment.door.state, behavior: fragment.door.customBehavior ? authoredBehavior : null,
            reflected: projection.doorReflected === true, scale: projection.doorSceneScale ?? 1,
            sceneGridSize: projection.placement?.sceneGridSize
          })
          : null;
        const behavior = windowNative ? {
          ...authoredBehavior,
          light: windowNative.light,
          sight: windowNative.sight,
          threshold: windowNative.threshold
        } : authoredBehavior;
        const open = fragment.door?.state === (constants?.WALL_DOOR_STATES?.OPEN ?? 1);
        return new Edge(fragment.a, fragment.b, {
          id: `fa-nexus-building-v2.${projection.projectionId}.${projection.requestGeneration}.${fragment.fragmentId || index}`,
          type: 'wall',
          direction: projection.doorReflected === true && [1, 2].includes(Number(behavior.dir))
            ? 3 - Number(behavior.dir)
            : (Number.isFinite(Number(behavior.dir)) ? Number(behavior.dir) : both),
          move: open ? 0 : (Number.isFinite(Number(behavior.move)) ? Number(behavior.move) : normal),
          sight: open ? 0 : (Number.isFinite(Number(behavior.sight)) ? Number(behavior.sight) : normal),
          light: open ? 0 : (Number.isFinite(Number(behavior.light)) ? Number(behavior.light) : normal),
          darkness: open ? 0 : normal,
          sound: open ? 0 : (Number.isFinite(Number(behavior.sound)) ? Number(behavior.sound) : normal),
          threshold: nativeEdgeThreshold(behavior.threshold, canvas.scene),
          priority: 0
        });
      });
      const prepared = { projection, canvas, scene: canvas.scene, level, edges, surface: null, doors: null, mounted: false, released: false };
      try {
        prepared.doors = await doorHost.prepare(projection);
        prepared.surface = projection.nativeSurfaceRegions ? surfaceHost.prepare(projection.nativeSurfaceRegions) : null;
        return prepared;
      } catch (error) {
        try { destroyPrepared(prepared, getCanvas, surfaceHost, doorHost); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Building V2 native preparation and cleanup failed.');
        }
        throw error;
      }
    },

    async prepareDoorPresentation(projection, { reusableNative = null } = {}) {
      if (!projection || Number(projection.version) !== 1 || !Array.isArray(projection.nativeFragments)) {
        throw new Error('Building V2 Door presentation requires compiler contract version 1 and native fragments.');
      }
      const { level } = this.probe({
        sceneId: projection.sceneId,
        placementLevelId: projection.placement?.levels?.length === 1 ? projection.placement.levels[0] : null
      });
      if (projection.placement?.levels?.length && !projection.placement.levels.includes(level?.id)) {
        throw new Error('Building V2 Door presentation requires a viewed Level included in its native Wall scope.');
      }
      return doorHost.prepare(projection, { reusable: reusableNative?.doors || null });
    },

    replaceDoorPresentation(prepared, doors) {
      if (!prepared || prepared.released || prepared.mounted !== true || getCanvas()?.scene !== prepared.scene) {
        throw new Error('Building V2 cannot replace Door presentation on an inactive native projection.');
      }
      if (!doors || doors.released || doors.scene !== prepared.scene) {
        throw new Error('Building V2 cannot activate a released or stale Door presentation.');
      }
      const prior = prepared.doors;
      try {
        doorHost.activate(doors);
      } catch (error) {
        try { doorHost.release(doors); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Building V2 Door presentation activation cleanup failed.');
        }
        throw error;
      }
      prepared.doors = doors;
      return { prepared, prior, candidate: doors, status: 'pending' };
    },

    finalizeDoorPresentationReplacement(replacement) {
      if (!replacement || replacement.status !== 'pending'
        || replacement.prepared?.doors !== replacement.candidate) {
        throw new Error('Building V2 cannot finalize an inactive Door presentation replacement.');
      }
      replacement.status = 'finalized';
      let cleanupError = null;
      try {
        if (replacement.prior) doorHost.release(replacement.prior);
      } catch (error) {
        // Door release destroys every resource it can and retains the handle for
        // releasePending when any cleanup step fails. The published candidate is
        // now the only live owner; expose the retained cleanup debt to runtime.
        cleanupError = error;
      }
      return Object.freeze({ prepared: replacement.prepared, cleanupError });
    },

    rollbackDoorPresentationReplacement(replacement) {
      if (!replacement || replacement.status !== 'pending'
        || replacement.prepared?.doors !== replacement.candidate) {
        throw new Error('Building V2 cannot roll back an inactive Door presentation replacement.');
      }
      replacement.prepared.doors = replacement.prior;
      replacement.status = 'rolled-back';
      // release retains any failed candidate cleanup for releasePending while
      // the untouched prior presentation remains the coherent live owner.
      doorHost.release(replacement.candidate);
      return replacement.prepared;
    },

    releaseDoorPresentation(prepared) {
      return doorHost.release(prepared);
    },

    activate(prepared) {
      if (!prepared || prepared.released) throw new Error('Building V2 native simulation cannot activate a released projection.');
      const canvas = getCanvas();
      if (canvas?.scene !== prepared.scene) throw new Error('Building V2 native simulation cannot activate a stale Scene projection.');
      if (prepared.mounted) throw new Error('Building V2 native simulation projection is already active.');
      try {
        prepared.mounted = true;
        if (prepared.surface) surfaceHost.activate(prepared.surface);
        if (prepared.doors) doorHost.activate(prepared.doors);
        for (const edge of prepared.edges) canvas.edges.set(edge.id, edge);
        refreshNativeEffects(canvas, prepared.level);
        return prepared;
      } catch (error) {
        try { destroyPrepared(prepared, getCanvas, surfaceHost, doorHost); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Building V2 native activation and cleanup failed.');
        }
        throw error;
      }
    },

    release(prepared) {
      return destroyPrepared(prepared, getCanvas, surfaceHost, doorHost);
    },

    releasePending() {
      return doorHost.releasePending?.() || 0;
    }
  });
}
