import { normalizeBuildingV2PortalTiming, normalizeBuildingV2PortalSound, getBuildingV2PortalOptionFields } from './building-v2-portal-options.js';
import { materializeBuildingV2DoorAnimation, materializeBuildingV2DoorWall, normalizeBuildingV2DoorAppearance } from './building-v2-opening-runtime.js';
import { normalizeBuildingV2DoorFrame, compileBuildingV2DoorFrame } from './building-v2-door-frame.js';
import { compileBuildingV2SeamlessSurface, transformBuildingV2SeamlessSurface, measureBuildingV2SeamlessSurface } from './building-v2-seamless.js';
import { loadTexture } from '../../textures/texture-runtime-core.js';
import {
  normalizeBuildingV2WindowSetup,
  compileBuildingV2WindowArtwork,
  compileBuildingV2WindowSills,
  materializeBuildingV2WindowSills,
  transformBuildingV2WindowSills,
  materializeBuildingV2WindowWall,
  resolveBuildingV2WindowSillsPlacement
} from './building-v2-window.js';
import {
  buildingV2DoorCarrierNormal,
  materializeBuildingV2DoorShadowForChord,
  materializeBuildingV2DoorShadowForRoot,
  materializeBuildingV2DoorShadow,
  normalizeBuildingV2DoorShadow
} from './building-v2-door-shadow.js';
import { createBuildingV2CanvasInputHost } from './building-v2-canvas-input-host.js';
import {
  createBuildingV2SurfaceRegionSource,
  createBuildingV2SurfaceRegionDefaults,
  materializeBuildingV2SurfaceRegionShapes
} from './building-v2-surface-region-runtime.js';
import {
  createBuildingV2LocalVisualHost,
  inspectBuildingV2WallTextureRows,
  resolveBuildingV2WallTextureMetrics,
  mergeRenderEnvelopes,
  measureBuildingV2WallRenderEnvelope
} from './building-v2-local-visual-host.js';
import { createBuildingV2NativeSimulationV14 } from './building-v2-native-simulation-v14.js';
import { createBuildingV2CommitRuntime } from './building-v2-commit-runtime.js';
import { createBuildingV2ExistingEditRuntime } from './building-v2-existing-edit-runtime.js';
import { createBuildingV053MigrationPreflightCapture } from './building-v2-v053-migration-preflight.js';
import {
  BUILDING_V2_CURVE_RUNTIME_VERSION,
  tessellateBuildingV2WallGeometry,
  planBuildingV2NativeWallFragments
} from './building-v2-curve-runtime.js';
import {
  BUILDING_V2_FILL_MASK_RUNTIME_VERSION,
  compileBuildingV2FillMaskSource,
  createBuildingV2FillMaskRuntime,
  measureBuildingV2FillMaskRegions,
  projectBuildingV2FillMaskToManagedTile
} from './building-v2-fill-mask-runtime.js';
import {
  BUILDING_V2_WALL_BEHAVIOR_RUNTIME_VERSION,
  createBuildingV2WallBehaviorRuntime
} from './building-v2-wall-behavior-runtime.js';
import { resolvePlacementSortAtElevation } from '../../canvas/canvas-interaction-controller.js';
import { getCurrentLevelElevationRange } from '../../canvas/elevation-band-utils.js';
import {
  getFaNexusPlacementOcclusionDefaults,
  getFaNexusPlacementRestrictionDefaults
} from '../../canvas/tile-document-payloads.js';
import { resolveNewLayerLevels } from '../../canvas/new-layer-levels.js';
import { resolveLayerManagerPreviewSortNudge } from '../../layers/layer-manager-preview-placement-bridge.js';

/**
 * Public, premium-safe entry point for Building Editor V2 runtime services.
 *
 * This contract owns the exclusive local session lease and the disposable
 * Foundry Canvas input/coordinate host mounted beneath that lease.
 * It must stay free of Foundry document mutations and legacy authoring imports.
 */
export const BUILDING_V2_RUNTIME_ID = 'fa-nexus.building-v2-runtime';
export const BUILDING_V2_RUNTIME_CONTRACT_VERSION = 34;

const FALLBACK_MODULE_VERSION = 'unknown';

function snapshotPortalId(snapshot, wall) {
  const source = wall?._source || wall;
  const owner = source?.flags?.['fa-nexus']?.buildingGenerated;
  if (owner?.role === 'portal') return owner.semanticId;
  if (snapshot?.sourceKind !== 'v053') return null;
  const id = wall?.id || source?._id;
  const flags = source?.flags?.['fa-nexus'];
  const portalId = flags?.buildingDoor?.gapId || flags?.buildingWindow?.gapId;
  return portalId && snapshot.ownership.portalDocumentIds[portalId] === id ? portalId : null;
}

export function reconcileBuildingV2PortalLiveState(fragment, wall) {
  const door = fragment?.door;
  if (!door || !wall) throw new Error('Building V2 Door live-state source lost its exact owned Wall.');
  const expectedType = Number(door.type);
  const currentType = Number(wall.door);
  const intent = fragment.liveStateIntent;
  if (intent && (![0, 1, 2].includes(intent.state) || ![0, 1, 2].includes(intent.baseline)
    || ![0, 1, 2].includes(Number(wall.ds)))) throw new Error('Building V2 Portal requires an exact live-state intent and native baseline.');
  if (fragment.kindConversion) {
    const { from, to } = fragment.kindConversion;
    const allowed = kind => kind === 'door' ? [1] : kind === 'window' ? [0, 2] : kind === 'seamlessSecretDoor' ? [2] : [];
    if (!allowed(from).includes(currentType) || !allowed(to).includes(expectedType)) throw new Error('Building V2 Portal conversion lost its compatible native role.');
    return { ...fragment, door: { ...door, state: expectedType === 0 ? 0 : currentType > 0 ? intent?.state ?? Number(wall.ds) : door.state } };
  }
  if (door.portalKind === 'window') {
    if (![0, 2].includes(expectedType) || ![0, 2].includes(currentType)) {
      throw new Error('Building V2 Window live-state source has an incompatible native Wall type.');
    }
    return {
      ...fragment,
      door: {
        ...door,
        // A static Wall has no Portal live state to transfer. A Window becoming
        // animated therefore starts closed; a Window becoming static always
        // settles ds=0. Only an already animated Window owns reusable live ds.
        state: expectedType === 2 ? currentType === 2 ? intent?.state ?? Number(wall.ds) : door.state : 0
      }
    };
  }
  if (Number.isFinite(expectedType) && currentType !== expectedType) {
    throw new Error('Building V2 Door live-state source lost its exact owned Wall.');
  }
  return { ...fragment, door: { ...door, state: intent?.state ?? Number(wall.ds) } };
}

function resolveModuleVersion() {
  return globalThis.game?.modules?.get?.('fa-nexus')?.version || FALLBACK_MODULE_VERSION;
}

function requireSceneId(sceneId) {
  if (typeof sceneId !== 'string' || !sceneId.trim()) {
    throw new TypeError('Building V2 runtime lease acquisition requires a non-empty sceneId.');
  }
  return sceneId;
}

function previewLayerPlacementSignature(projection) {
  const placement = projection?.placement || {};
  const fillPlacement = projection?.fillPlacement || {};
  return JSON.stringify([
    String(projection?.projectionId || ''),
    Number(placement.elevation),
    Number(placement.sort),
    Number(placement.previewSort ?? placement.sort),
    String(placement.placementLevelId || ''),
    String(placement.anchorTileId || ''),
    placement.sortBefore === true,
    Number(fillPlacement.elevation),
    Number(fillPlacement.sort),
    Number(fillPlacement.previewSort ?? fillPlacement.sort),
    String(fillPlacement.placementLevelId || ''),
    String(fillPlacement.anchorTileId || ''),
    fillPlacement.sortBefore === true,
    projection?.sills?.length || 0,
    projection?.sillsPlacement || null,
    String(projection?.activePlacementPreviewKind || '')
  ]);
}

/**
 * Creates an isolated Building V2 public-runtime contract.
 *
 * The factory exists for deterministic tests and must not be used to create a
 * second production authority. Production callers use the canonical getter.
 */
export function createBuildingV2RuntimeCapabilities({
  moduleVersion = resolveModuleVersion(),
  createCanvasInputHost = createBuildingV2CanvasInputHost,
  createLocalVisualHost = createBuildingV2LocalVisualHost,
  createNativeSimulation = createBuildingV2NativeSimulationV14,
  createCommitRuntime = createBuildingV2CommitRuntime,
  createExistingEditRuntime = createBuildingV2ExistingEditRuntime,
  createMigrationPreflightCapture = createBuildingV053MigrationPreflightCapture,
  notifyPreviewLayersChanged = (details) => globalThis.Hooks?.callAll?.('fa-nexus-preview-layers-changed', details),
  resolvePreviewSortNudge = resolveLayerManagerPreviewSortNudge,
  resolvePlacementSort = resolvePlacementSortAtElevation,
  getCanvas = () => globalThis.canvas
} = {}) {
  if (typeof moduleVersion !== 'string' || !moduleVersion.trim()) {
    throw new TypeError('Building V2 runtime capabilities require a non-empty moduleVersion.');
  }
  if (typeof createCanvasInputHost !== 'function') {
    throw new TypeError('Building V2 runtime capabilities require createCanvasInputHost().');
  }
  if (typeof createLocalVisualHost !== 'function' || typeof createNativeSimulation !== 'function') {
    throw new TypeError('Building V2 runtime capabilities require local visual and native simulation host factories.');
  }
  if (typeof createCommitRuntime !== 'function') {
    throw new TypeError('Building V2 runtime capabilities require the public commit runtime factory.');
  }
  if (typeof createExistingEditRuntime !== 'function') {
    throw new TypeError('Building V2 runtime capabilities require the public existing-Edit runtime factory.');
  }
  if (typeof createMigrationPreflightCapture !== 'function') {
    throw new TypeError('Building V2 runtime capabilities require the public v0.5.3 migration preflight capture factory.');
  }
  if (typeof notifyPreviewLayersChanged !== 'function') {
    throw new TypeError('Building V2 runtime capabilities require notifyPreviewLayersChanged().');
  }
  if (typeof resolvePreviewSortNudge !== 'function' || typeof resolvePlacementSort !== 'function') {
    throw new TypeError('Building V2 runtime capabilities require Layer Manager preview placement resolvers.');
  }

  let activeState = null;
  let leaseAcquisitionPending = false;
  const commitRuntime = createCommitRuntime();
  const fillMaskRuntime = createBuildingV2FillMaskRuntime();
  const existingEditRuntime = createExistingEditRuntime();
  let replacementSuppressionTail = Promise.resolve();
  const ensurePreparedReplacement = async (state) => {
    if (!state.currentSnapshot || state.replacementSuppression) return;
    if (!state.pendingReplacementSuppression) {
      const epoch = state.replacementSuppressionEpoch;
      const operation = replacementSuppressionTail.then(async () => {
        if (activeState !== state || state.suspended || epoch !== state.replacementSuppressionEpoch) return;
        const suppression = await existingEditRuntime.beginPreparedReplacement(state.currentSnapshot);
        if (activeState !== state || state.suspended || epoch !== state.replacementSuppressionEpoch) {
          existingEditRuntime.releasePreparedReplacement(suppression, { restore: true });
          return;
        }
        state.replacementSuppression = suppression;
      });
      // A later acquisition may proceed after an earlier caller observes failure.
      // In particular, old-lease restoration must finish before new suppression.
      replacementSuppressionTail = operation.then(() => {}, () => {});
      const pending = operation.finally(() => {
        if (state.pendingReplacementSuppression === pending) state.pendingReplacementSuppression = null;
      });
      state.pendingReplacementSuppression = pending;
    }
    await state.pendingReplacementSuppression;
    if (activeState === state && !state.suspended && !state.replacementSuppression) {
      // A same-Scene redraw may supersede an acquisition while it is pending.
      return ensurePreparedReplacement(state);
    }
  };
  let wallBehaviorRuntime = null;
  const requireWallBehaviorRuntime = () => {
    wallBehaviorRuntime ||= createBuildingV2WallBehaviorRuntime();
    return wallBehaviorRuntime;
  };
  const captureMigrationPreflight = createMigrationPreflightCapture({ getCanvas });

  const surfaceRegionElevation = (elevation) => {
    const range = getCurrentLevelElevationRange(getCanvas()?.scene);
    return range ? {
      bottom: Number.isFinite(Number(range.bottom)) ? Number(range.bottom) : null,
      top: Number.isFinite(Number(range.top)) ? Number(range.top) : null
    } : { bottom: Number(elevation), top: Number(elevation) };
  };

  const materializeSurfaceRegions = (state, projection, transform) => {
    if (projection.continuousGesture) return null;
    const baseline = state.currentSnapshot?.durable?.regions || [];
    const sources = (projection.surfaceRegionPlans || []).map((plan) => {
      const source = plan.inheritsRegionPresentation && baseline[0]
        ? structuredClone(baseline[0])
        : createBuildingV2SurfaceRegionDefaults({ elevation: surfaceRegionElevation(projection.placement?.elevation) });
      source.shapes = materializeBuildingV2SurfaceRegionShapes(plan.projection, {
        transform, sceneGridSize: Number(projection.placement?.sceneGridSize || 100)
      });
      delete source._id;
      delete source._stats;
      if (source.flags?.['fa-nexus']) {
        delete source.flags['fa-nexus'].buildingGenerated;
        delete source.flags['fa-nexus'].buildingRegion;
      }
      return source;
    });
    return sources.length || baseline.length ? {
      sources, replacedRegionIds: baseline.map(region => region._id)
    } : null;
  };

  const prepareSeamlessProjection = async projection => {
    const fragments = projection.nativeFragments || [];
    if (!fragments.some(fragment => fragment.door?.seamlessSource)) return projection;
    const portalSurfaces = [];
    const nativeFragments = await Promise.all(fragments.map(async fragment => {
      const source = fragment.door?.seamlessSource;
      if (!source) return fragment;
      const metrics = new Map();
      await Promise.all(source.parts.map(async ({ section }) => {
        const texture = await loadTexture(section.textureSrc);
        if (!texture?.valid) throw new Error(`Seamless Secret Door wall texture failed to load: ${section.textureSrc}`);
        const visibleRows = inspectBuildingV2WallTextureRows(texture);
        metrics.set(section.sectionId, { ...resolveBuildingV2WallTextureMetrics(section, texture, visibleRows), visibleRows });
      }));
      const surfacePlan = compileBuildingV2SeamlessSurface(source, metrics);
      portalSurfaces.push({ portalId: fragment.portalId, surfacePlan });
      const { seamlessSource, ...door } = fragment.door;
      return { ...fragment, door: { ...door, surfacePlan } };
    }));
    return { ...projection, nativeFragments, portalSurfaces };
  };

  const materializeProjection = (state, projection) => {
    if (projection?.coordinateSpace !== 'building-local') return {
      ...projection,
      doorSceneScale: 1,
      nativeSurfaceRegions: materializeSurfaceRegions(state, projection, { localToWorld: point => point })
    };
    const transform = existingEditRuntime.createSpatialTransform(state.currentSnapshot);
    const scale = Number(state.currentSnapshot?.pose?.scale ?? 1);
    const reflected = !!state.currentSnapshot?.pose?.flipX !== !!state.currentSnapshot?.pose?.flipY;
    if (!(scale > 0)) {
      throw new Error('Building V2 local projection requires a positive Building Instance Scale.');
    }
    // Projection inputs are immutable. Materialize only the coordinate-bearing
    // branches instead of structured-cloning the complete artwork, appearance,
    // placement, and provenance graph on every continuous gesture frame.
    const materializeSections = (sections) => (sections || []).map((section) => {
      const materialized = {
        ...section,
        points: (section.points || []).map((point) => ({ ...point })),
        startJoinDir: section.startJoinDir ? { ...section.startJoinDir } : section.startJoinDir,
        endJoinDir: section.endJoinDir ? { ...section.endJoinDir } : section.endJoinDir,
        textureOffset: section.textureOffset ? { ...section.textureOffset } : section.textureOffset,
        pathShadow: section.pathShadow ? { ...section.pathShadow } : section.pathShadow
      };
      materialized.points = materialized.points.map((point) => transform.localToWorld(point));
      if (materialized.startJoinDir) materialized.startJoinDir = transform.localDirectionToWorld(materialized.startJoinDir);
      if (materialized.endJoinDir) materialized.endJoinDir = transform.localDirectionToWorld(materialized.endJoinDir);
      if (materialized.startCapNormal) materialized.startCapNormal = transform.localDirectionToWorld(materialized.startCapNormal);
      if (materialized.endCapNormal) materialized.endCapNormal = transform.localDirectionToWorld(materialized.endCapNormal);
      if (Number.isFinite(Number(materialized.sceneGridSize))) materialized.sceneGridSize = Number(materialized.sceneGridSize) * scale;
      if (Number.isFinite(Number(materialized.width)) && Number(materialized.width) > 0) materialized.width = Number(materialized.width) * scale;
      if (Number.isFinite(Number(materialized.repeatDistance)) && Number(materialized.repeatDistance) > 0) {
        materialized.repeatDistance = Number(materialized.repeatDistance) * scale;
      }
      if (Number.isFinite(Number(materialized.texturePhaseDistance))) {
        materialized.texturePhaseDistance = Number(materialized.texturePhaseDistance) * scale;
      }
      if (materialized.textureOffset && typeof materialized.textureOffset === 'object') {
        materialized.textureOffset.x = Number(materialized.textureOffset.x || 0) * scale;
        materialized.textureOffset.y = Number(materialized.textureOffset.y || 0) * scale;
      }
      if (materialized.pathShadow && typeof materialized.pathShadow === 'object') {
        for (const key of ['offset', 'dilation']) {
          if (Number.isFinite(Number(materialized.pathShadow[key]))) {
            materialized.pathShadow[key] = Number(materialized.pathShadow[key]) * scale;
          }
        }
      }
      if(reflected) {
        materialized.textureFlip = {...materialized.textureFlip, vertical: !materialized.textureFlip?.vertical};
        if(materialized.textureOffset)materialized.textureOffset.y *= -1;
        if(materialized.pathShadow?.offset != null)materialized.pathShadow.offset *= -1;
      }
      return materialized;
    });
    const materializeSills = (parts) => {
      if (!Array.isArray(parts)) {
        throw new Error('Building V2 local projection requires an exact Window Sills part list.');
      }
      if (!parts.length) return [];
      const elevation = Number(parts[0]?.elevation);
      const sort = Number(parts[0]?.sort);
      if (!Number.isFinite(elevation) || !Number.isFinite(sort)
        || parts.some((part) => Number(part?.elevation) !== elevation || Number(part?.sort) !== sort)) {
        throw new Error('Building V2 local projection requires one shared finite Window Sills placement.');
      }
      return transformBuildingV2WindowSills(parts, {
        pose: state.currentSnapshot.pose,
        elevation,
        sort
      });
    };
    const copy = {
      ...projection,
      doorSceneScale: scale, doorReflected: reflected,
      nativeSurfaceRegions: materializeSurfaceRegions(state, projection, transform),
      visualSections: materializeSections(projection.visualSections),
      sills: materializeSills(projection.sills || []),
      portalArtwork: (projection.portalArtwork || []).map(portal => {
        if (!['door-frame', 'window-surface', 'window-frame'].includes(portal?.kind)) {
          throw new Error(`Building V2 cannot materialize unknown Portal artwork kind ${String(portal?.kind || 'missing')}.`);
        }
        const artwork=portal.artwork.map(sprite=>({...sprite, ...transform.localToWorld(sprite),
          width:sprite.width*scale,height:sprite.height*scale,
          rotation:Number(state.currentSnapshot.pose.rotation)*Math.PI/180+(reflected?-sprite.rotation:sprite.rotation),
          flipX:(sprite.flipX || 1)*(state.currentSnapshot.pose.flipX?-1:1),
          flipY:(sprite.flipY || 1)*(state.currentSnapshot.pose.flipY?-1:1)}));
        const b=portal.bounds,points=[{x:b.minX,y:b.minY},{x:b.maxX,y:b.minY},{x:b.maxX,y:b.maxY},{x:b.minX,y:b.maxY}].map(p=>transform.localToWorld(p));
        const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y));
        return {...portal,artwork,bounds:{minX,minY,maxX,maxY,width:maxX-minX,height:maxY-minY},
          endpointsLocal:portal.endpointsLocal.map(p=>transform.localToWorld(p)),
          shadow:portal.shadow?materializeBuildingV2DoorShadow(portal.shadow,{scale,transform}):null};
      }),
      nativeFragments: (projection.nativeFragments || []).map((fragment) => ({
        ...fragment,
        door: fragment.door ? { ...fragment.door } : fragment.door,
        a: fragment.a ? { ...fragment.a } : fragment.a,
        b: fragment.b ? { ...fragment.b } : fragment.b
      }))
    };
    if (projection.fillProjection?.active === true) {
      const localGridSize = Number(projection.fillProjection.sceneGridSize);
      const localPadding = Number(projection.fillProjection.presentationPadding || 0);
      const localTextureOrigin = projection.fillProjection.textureBasis?.origin || { x: 0, y: 0 };
      copy.fillProjection = {
        ...projection.fillProjection,
        textureBasis: {
          ...(projection.fillProjection.textureBasis || {}),
          origin: transform.localToWorld(localTextureOrigin)
        },
        sceneGridSize: localGridSize * scale,
        presentationPadding: localPadding * scale,
        // Keep the compact Fill Mask Source in its canonical Building-local
        // authority. The visual host materializes it with the authored grid,
        // then applies this exact instance pose once to the sampled vertices.
        maskSceneGridSize: localGridSize,
        maskSpatialPose: {
          originX: Number(state.currentSnapshot?.pose?.originX),
          originY: Number(state.currentSnapshot?.pose?.originY),
          rotation: Number(state.currentSnapshot?.pose?.rotation || 0),
          scale, flipX: state.currentSnapshot?.pose?.flipX, flipY: state.currentSnapshot?.pose?.flipY
        }
      };
    }
    copy.coordinateSpace = 'scene-world';
    for (const fragment of copy.nativeFragments || []) {
      const sourceA = fragment.a;
      const sourceB = fragment.b;
      fragment.a = transform.localToWorld(fragment.a);
      fragment.b = transform.localToWorld(fragment.b);
      if (fragment.door?.surfacePlan) fragment.door.surfacePlan = transformBuildingV2SeamlessSurface(fragment.door.surfacePlan, {
        a: fragment.a, b: fragment.b, scale, reflected, sceneGridSize: Number(globalThis.canvas?.scene?.grid?.size || fragment.door.surfacePlan.textureGridSize)
      });
      if (fragment.door?.shadow) fragment.door.shadow = materializeBuildingV2DoorShadowForChord(fragment.door.shadow, {
        sourceA, sourceB, targetA: fragment.a, targetB: fragment.b, scale: 1, reflected
      });
    }
    return copy;
  };

  const applyCurrentDoorState = (state, projection) => {
    projection.nativeFragments = (projection.nativeFragments || []).map(fragment => ({ ...fragment }));
    for (let index = 0; index < projection.nativeFragments.length; index += 1) {
      const fragment = projection.nativeFragments[index];
      if (!fragment.portalId || !fragment.door
        || (fragment.door.portalKind === 'window' && fragment.door.type !== 2)) continue;
      const documentId = state.currentSnapshot?.ownership?.semanticWallDocumentIds?.[fragment.portalId];
      if (!documentId) continue;
      const wall = globalThis.canvas?.scene?.walls?.get(documentId);
      if (!wall || snapshotPortalId(state.currentSnapshot, wall) !== fragment.portalId) {
        throw new Error('Building V2 Door live-state source lost its exact owned Wall.');
      }
      projection.nativeFragments[index] = {
        ...reconcileBuildingV2PortalLiveState(fragment, wall),
        ...(fragment.liveStateIntent ? { liveStateConflict: fragment.liveStateIntent.baseline !== Number(wall.ds) } : {}),
        nativeDocumentId: documentId
      };
    }
    return projection;
  };
  const doorStateSignature = projection => JSON.stringify((projection.nativeFragments || [])
    .filter(fragment => fragment.portalId && fragment.door
      && (fragment.door.portalKind !== 'window' || fragment.door.type === 2))
    .map(fragment => [fragment.portalId, fragment.door?.state, fragment.liveStateConflict === true]));
  const sharedDoorStateChanged = (leftSignature, rightSignature) => {
    const right = new Map(JSON.parse(rightSignature || '[]'));
    return JSON.parse(leftSignature || '[]').some(([portalId, state]) => (
      right.has(portalId) && right.get(portalId) !== state
    ));
  };
  const currentDoorStateSignature = (state, projection) => doorStateSignature(
    applyCurrentDoorState(state, materializeProjection(state, projection)));
  const retainNativeStructureWithCurrentDoors = (priorProjection, currentProjection) => ({
    ...priorProjection,
    requestGeneration: currentProjection.requestGeneration,
    semanticRevision: currentProjection.semanticRevision,
    placementRevision: currentProjection.placementRevision,
    openings: currentProjection.openings,
    nativeFragments: [
      ...(priorProjection.nativeFragments || []).filter((fragment) => !fragment.portalId),
      ...(currentProjection.nativeFragments || []).filter((fragment) => fragment.portalId)
    ]
  });
  // Publish synchronously after the final native prepare: no async boundary may
  // separate the live-state validation from ownership transfer and readiness.
  const prepareCurrentNative = async (state, projection, isCurrent, publish) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!isCurrent()) return false;
      const materialized = applyCurrentDoorState(state, materializeProjection(state, await prepareSeamlessProjection(projection)));
      const signature = doorStateSignature(materialized);
      const native = await state.nativeHost.prepare(materialized);
      if (!isCurrent()) { state.nativeHost.release(native); return false; }
      let currentSignature;
      try { currentSignature = currentDoorStateSignature(state, projection); }
      catch (error) { state.nativeHost.release(native); throw error; }
      if (signature !== currentSignature) {
        state.nativeHost.release(native);
        continue;
      }
      try { publish(native, signature); }
      catch (error) { state.nativeHost.release(native); throw error; }
      return true;
    }
    throw new Error('Building V2 Door live state did not stabilize during native preparation.');
  };
  const detachDoorStateListener = state => {
    if (state?.doorStateHook != null) globalThis.Hooks.off('updateWall', state.doorStateHook);
    if (state) state.doorStateHook = null;
  };
  const attachDoorStateListener = state => {
    const ids = new Set((state.currentSnapshot?.durable?.walls || [])
      .filter(wall => snapshotPortalId(state.currentSnapshot, wall)
        && (wall.door == null || [1, 2].includes(wall.door)))
      .map(wall => wall._id));
    if (!ids.size) return;
    state.doorStateHook = globalThis.Hooks.on('updateWall', (wall, changes) => {
      // A Commit writes this Building's own Walls; those are not door-state changes made by others.
      if (!Object.hasOwn(changes, 'ds') || !ids.has(wall.id) || activeState !== state || state.suspended || state.committing) return;
      const prior = state.activeProjection;
      if (!prior || state.latestProjection !== prior.projection) return;
      const epoch = state.doorStateEpoch = (state.doorStateEpoch || 0) + 1;
      const readiness = state.readiness;
      state.readiness = Object.freeze({ ...readiness, status: 'preparing' });
      state.portalStateListener?.();
      const isCurrent = () => activeState === state && !state.suspended
        && state.activeProjection === prior && state.doorStateEpoch === epoch
        && state.latestProjection === prior.projection;
      Promise.resolve().then(() => prepareCurrentNative(state, prior.nativeProjection || prior.projection, isCurrent, (native, signature) => {
        state.nativeHost.activate(native);
        const old = prior.native;
        prior.native = native;
        prior.nativeDoorStateSignature = signature;
        prior.doorPresentationStateSignature = signature;
        state.nativeHost.release(old);
        state.readiness = Object.freeze({ ...readiness, status: prior.projection.openings?.unresolved?.length ? 'unresolved' : 'ready' });
        state.portalStateListener?.();
      })).catch(error => {
        if (isCurrent())
          state.readiness = Object.freeze({ ...readiness, status: 'failed', message: String(error.message || error) });
        console.error('[FA Nexus] Building V2 Door live-state preview failed.', error);
      });
    });
  };

  const buildMaterializationReceipt = (state, projection, receipt) => {
    if (!receipt) return null;
    const portalSurfaces = (receipt.portalSurfaces || []).map(entry => ({ ...entry,
      renderEnvelope: measureBuildingV2SeamlessSurface(entry.surfacePlan) }));
    if (projection?.coordinateSpace !== 'building-local' && !portalSurfaces.length) return receipt;
    if (projection?.coordinateSpace !== 'building-local') return Object.freeze({ ...receipt, portalSurfaces,
      renderEnvelope: mergeRenderEnvelopes([receipt.renderEnvelope, ...portalSurfaces.map(entry => entry.renderEnvelope)]) });
    const scale = Number(state.currentSnapshot?.pose?.scale ?? 1);
    if (!(scale > 0)) {
      throw new Error('Building V2 materialization receipt requires a positive Building Instance Scale.');
    }
    const metricsBySectionId = new Map((receipt.visualSections || []).map((entry) => [entry.sectionId, entry]));
    const localSections = (projection.visualSections || []).map((section) => {
      const metrics = metricsBySectionId.get(section.sectionId) || {};
      return {
        ...section,
        width: Number(metrics.width) / scale,
        repeatDistance: Number(metrics.repeatDistance) / scale
      };
    });
    const localSectionById = new Map(localSections.map((section) => [section.sectionId, section]));
    const fillRegionEnvelopes = projection.fillProjection?.active === true
      ? measureBuildingV2FillMaskRegions(fillMaskRuntime.materialize(projection.fillProjection.maskSource, {
          sceneGridSize: projection.fillProjection.sceneGridSize
        })) : [];
    return Object.freeze({
      ...receipt,
      portalSurfaces,
      portalArtwork: Object.freeze((projection.portalArtwork || []).map(portal => Object.freeze({
        portalId: portal.portalId, bounds: Object.freeze({ ...portal.bounds }), artworkCount: portal.artwork.length
      }))),
      visualSections: Object.freeze((receipt.visualSections || []).map((entry) => Object.freeze({
        ...entry,
        width: Number(entry.width) / scale,
        repeatDistance: Number(entry.repeatDistance) / scale,
        renderEnvelope: measureBuildingV2WallRenderEnvelope([localSectionById.get(entry.sectionId)].filter(Boolean))
      }))),
      ...(receipt.fill ? { fill: Object.freeze({ ...receipt.fill,
        regionRenderEnvelopes: Object.freeze(fillRegionEnvelopes.map((region) => Object.freeze({
          regionId: region.regionId, renderEnvelope: Object.freeze({ ...region.renderEnvelope })
        })))
      }) } : {}),
      buildingLocalRenderEnvelope: mergeRenderEnvelopes([measureBuildingV2WallRenderEnvelope(localSections),
        ...portalSurfaces.map(entry => entry.renderEnvelope),
        ...(projection.portalArtwork || []).map(portal => portal.bounds),
        ...fillRegionEnvelopes.map((region) => region.renderEnvelope)])
    });
  };

  const announcePreviewLayersChanged = (source) => {
    try {
      notifyPreviewLayersChanged({ source });
    } catch (error) {
      console.error('[FA Nexus] Building V2 failed to notify Layer Manager about a local preview change.', error);
    }
  };

  const requireActiveState = (lease) => {
    if (!activeState) throw new Error('Building V2 runtime has no active lease.');
    if (lease !== activeState.lease) {
      throw new Error('Building V2 runtime operation requires the exact active lease.');
    }
    return activeState;
  };

  const resolveLocalPlacement = (state, {
    elevation = 0,
    anchorTileId = null,
    sortBefore = false,
    excludeTileIds = [],
    count = 1
  } = {}) => {
    const scene = getCanvas()?.scene;
    if (!scene || String(scene.id || '') !== state.sceneId) {
      throw new Error('Building V2 Layer Manager placement requires the active leased Scene Canvas.');
    }
    const numericElevation = Number(elevation);
    if (!Number.isFinite(numericElevation)) {
      throw new TypeError('Building V2 placement resolution requires a finite elevation.');
    }
    const normalizedAnchorTileId = String(anchorTileId || '').trim() || null;
    const context = resolvePlacementSort(numericElevation, {
      scene,
      anchorTileId: normalizedAnchorTileId,
      sortBefore: sortBefore === true,
      excludeTileIds,
      count
    });
    const sort = Number(context?.sort);
    const previewSort = Number(context?.previewSort ?? sort);
    if (!Number.isFinite(sort) || !Number.isFinite(previewSort)) return null;
    const placementSorts = Array.isArray(context?.placementSorts)
      ? context.placementSorts.map((value) => Number(value)).filter(Number.isFinite)
      : [sort];
    const siblingTileUpdates = Array.isArray(context?.siblingUpdates)
      ? context.siblingUpdates.map((update) => ({ _id: String(update?._id || ''), sort: Number(update?.sort) }))
        .filter((update) => update._id && Number.isFinite(update.sort))
      : [];
    const siblingTilePreconditions = siblingTileUpdates.map((update) => {
      const document = scene.tiles?.get?.(update._id)
        || Array.from(scene.tiles || []).find((entry) => String(entry?.id || entry?._id || '') === update._id);
      return { _id: update._id, sort: Number(document?.sort ?? document?._source?.sort) };
    });
    if (siblingTilePreconditions.some((entry) => !Number.isFinite(entry.sort))) {
      throw new Error('Building V2 placement resolution could not capture exact sibling Tile sort preconditions.');
    }
    return Object.freeze({
      elevation: numericElevation,
      sort,
      previewSort,
      anchorTileId: normalizedAnchorTileId,
      sortBefore: sortBefore === true,
      placementSorts: Object.freeze(placementSorts),
      siblingTileUpdates: Object.freeze(siblingTileUpdates.map(Object.freeze)),
      siblingTilePreconditions: Object.freeze(siblingTilePreconditions.map(Object.freeze)),
      placementStrategy: String(context?.strategy || '')
    });
  };

  const capabilities = {
    id: BUILDING_V2_RUNTIME_ID,
    contractVersion: BUILDING_V2_RUNTIME_CONTRACT_VERSION,
    transformSeamlessSurface: transformBuildingV2SeamlessSurface,
    getDefaultTileOcclusion() {
      return getFaNexusPlacementOcclusionDefaults({ modes: [], alpha: 0 });
    },
    getDefaultTileRestrictions() {
      return getFaNexusPlacementRestrictionDefaults();
    },
    /** The Level membership of a new Root, Fill or Sills Tile placed on the given Level (world setting). */
    getDefaultTileLevels(placementLevelId = null) {
      return resolveNewLayerLevels({ placementLevelId });
    },
    moduleVersion,
    curveRuntimeVersion: BUILDING_V2_CURVE_RUNTIME_VERSION,
    fillMaskRuntimeVersion: BUILDING_V2_FILL_MASK_RUNTIME_VERSION,
    wallBehaviorRuntimeVersion: BUILDING_V2_WALL_BEHAVIOR_RUNTIME_VERSION,

    getWallBehaviorPresets() {
      return requireWallBehaviorRuntime().getPresets();
    },

    getWallBehaviorFields({ sceneId } = {}) {
      const scene = globalThis.game?.scenes?.get(sceneId);
      if (!scene) throw new Error('Building V2 Wall Behavior requires its active Scene.');
      return requireWallBehaviorRuntime().getFields().map(field => ({
        ...field, units: field.input === 'number' ? scene.grid.units : null
      }));
    },

    patchWallBehavior(value, changes, options = {}) {
      return requireWallBehaviorRuntime().patch(value, changes, options);
    },

    normalizeWallBehaviorDefault(value) {
      return requireWallBehaviorRuntime().normalizeDefault(value);
    },

    normalizeWallBehaviorOverride(value, options = {}) {
      return requireWallBehaviorRuntime().normalizeOverride(value, options);
    },

    materializeDoorAnimation: materializeBuildingV2DoorAnimation,
    normalizeDoorAppearance: normalizeBuildingV2DoorAppearance,
    normalizeDoorFrame: normalizeBuildingV2DoorFrame,
    compileDoorFrame: compileBuildingV2DoorFrame,
    materializeDoorWall: materializeBuildingV2DoorWall,
    normalizeWindowSetup: normalizeBuildingV2WindowSetup,
    compileWindowArtwork: compileBuildingV2WindowArtwork,
    compileWindowSills: compileBuildingV2WindowSills,
    materializeWindowSills: materializeBuildingV2WindowSills,
    materializeWindowWall: materializeBuildingV2WindowWall,
    normalizePortalTiming: normalizeBuildingV2PortalTiming,
    normalizePortalSound: normalizeBuildingV2PortalSound,
    getPortalOptionFields: getBuildingV2PortalOptionFields,
    resolveWindowSillsPlacement: resolveBuildingV2WindowSillsPlacement,
    normalizeDoorShadow: normalizeBuildingV2DoorShadow,
    resolveDoorCarrierNormal: buildingV2DoorCarrierNormal,
    materializeDoorShadowForChord: materializeBuildingV2DoorShadowForChord,
    materializeDoorShadowForRoot: materializeBuildingV2DoorShadowForRoot,

    resolveWallBehavior(options = {}) {
      return requireWallBehaviorRuntime().resolve(options);
    },

    identifyWallBehaviorPreset(value) {
      return requireWallBehaviorRuntime().identifyPreset(value);
    },

    tessellateWallGeometry(start, geometry, end, options = {}) {
      return tessellateBuildingV2WallGeometry(start, geometry, end, options);
    },

    planNativeWallFragments(options = {}) {
      return planBuildingV2NativeWallFragments(options);
    },

    compileBuildingV2FillMaskSource(authoring, options = {}) {
      return compileBuildingV2FillMaskSource(authoring, options);
    },

    createBuildingV2SurfaceRegionSource(options) {
      return createBuildingV2SurfaceRegionSource(options);
    },

    projectBuildingV2FillMaskToManagedTile(source, {
      sceneGridSize,
      building,
      rootSource,
      textureBasis,
      appearance
    } = {}) {
      const materialization = fillMaskRuntime.materialize(source, { sceneGridSize });
      return projectBuildingV2FillMaskToManagedTile({
        materialization, building, rootSource, textureBasis, appearance
      });
    },

    captureV053MigrationPreflight({ sceneId, rootTileId } = {}) {
      return captureMigrationPreflight({ sceneId, rootTileId });
    },

    acquireRuntimeLease({ sceneId, rootTileId = null, migration = null } = {}) {
      requireSceneId(sceneId);
      if (activeState || leaseAcquisitionPending) {
        throw new Error('Building V2 runtime already has an active lease; concurrent sessions are not supported.');
      }
      const activate = (currentSnapshot = null) => {
        if (activeState) {
          throw new Error('Building V2 runtime already has an active lease; concurrent sessions are not supported.');
        }
        const lease = Object.freeze(Object.create(null));
        const spatialTransform = currentSnapshot
          ? existingEditRuntime.createSpatialTransform(currentSnapshot)
          : undefined;
        const canvasInputHost = createCanvasInputHost({ sceneId, ...(spatialTransform ? { spatialTransform } : {}) });
        activeState = {
          lease,
          sceneId,
          rootTileId: currentSnapshot?.reference?.rootTileId || null,
          currentSnapshot,
          replacementSuppression: null,
          pendingReplacementSuppression: null,
          replacementSuppressionEpoch: 0,
          canvasInputHost,
          visualHost: createLocalVisualHost({ sceneId }),
          nativeHost: createNativeSimulation({ sceneId }),
          activeProjection: null,
          latestProjection: null,
          latestRequestGeneration: 0,
          suspended: false,
          readiness: Object.freeze({ status: 'idle', requestGeneration: 0 })
        };
        attachDoorStateListener(activeState);
        return lease;
      };
      const normalizedRootId = String(rootTileId || '').trim();
      if (!normalizedRootId) return activate();
      leaseAcquisitionPending = true;
      return Promise.resolve(migration
        ? existingEditRuntime.captureImported({ sceneId, rootTileId: normalizedRootId, migration })
        : existingEditRuntime.capture({ sceneId, rootTileId: normalizedRootId }))
        .then(activate)
        .finally(() => { leaseAcquisitionPending = false; });
    },

    captureCurrentBuildingSnapshot(lease, { rootTileId } = {}) {
      const state = requireActiveState(lease);
      if (!state.currentSnapshot || String(rootTileId || '') !== state.rootTileId) {
        throw new Error('Building V2 runtime lease does not own the requested Current Building Snapshot.');
      }
      return globalThis.structuredClone
        ? globalThis.structuredClone(state.currentSnapshot)
        : JSON.parse(JSON.stringify(state.currentSnapshot));
    },

    readLocalBuildingPortalStates(lease) {
      const state = requireActiveState(lease), result = {};
      for (const baseline of state.currentSnapshot?.durable?.walls || []) {
        const portalId = snapshotPortalId(state.currentSnapshot, baseline);
        if (!portalId) continue;
        const wall = globalThis.canvas?.scene?.walls?.get(baseline._id);
        if (!wall || snapshotPortalId(state.currentSnapshot, wall) !== portalId
          || ![0, 1, 2].includes(Number(wall.ds))) {
          throw new Error('Building V2 Portal live-state source lost its exact owned Wall.');
        }
        result[portalId] = { documentId: baseline._id, state: Number(wall.ds), type: Number(wall.door) };
      }
      return result;
    },

    setLocalBuildingPortalStateListener(lease, listener) {
      if (typeof listener !== 'function') throw new Error('Building V2 Portal state listener must be callable.');
      requireActiveState(lease).portalStateListener = listener;
    },

    resolveCurrentBuildingRefit(lease, options = {}) {
      const state = requireActiveState(lease);
      if (!state.currentSnapshot) {
        throw new Error('Building V2 Root refit requires an existing Current Building Snapshot.');
      }
      return existingEditRuntime.createRefitPlan(state.currentSnapshot, options);
    },

    releaseRuntimeLease(lease) {
      const state = requireActiveState(lease);
      const progress = state.releaseProgress ||= {
        shadowPreview: false,
        activeNative: false,
        activeVisual: false,
        pendingNative: false,
        pendingVisual: false,
        replacement: false,
        canvasInput: false,
        announced: !state.activeProjection
      };
      const errors = [];
      const attempt = (key, operation) => {
        if (progress[key]) return true;
        try { operation(); progress[key] = true; return true; }
        catch (error) { errors.push(error); return false; }
      };
      attempt('shadowPreview', () => state.visualHost.clearShadowElevationPreview?.());
      if (state.activeProjection) {
        const nativeReleased = attempt('activeNative', () => state.nativeHost.release(state.activeProjection.native));
        const visualReleased = attempt('activeVisual', () => state.visualHost.release(state.activeProjection.visual));
        if (nativeReleased && visualReleased) {
          state.activeProjection = null;
        }
      } else {
        progress.activeNative = true;
        progress.activeVisual = true;
      }
      if (progress.activeNative && progress.activeVisual) {
        attempt('announced', () => announcePreviewLayersChanged('building-v2-runtime-release'));
      }
      attempt('pendingNative', () => state.nativeHost.releasePending?.());
      attempt('pendingVisual', () => state.visualHost.releasePending?.());
      if (state.replacementSuppression
        && attempt('replacement', () => existingEditRuntime.releasePreparedReplacement(state.replacementSuppression, { restore: true }))) {
        state.replacementSuppression = null;
      } else if (!state.replacementSuppression) progress.replacement = true;
      attempt('canvasInput', () => state.canvasInputHost.destroy());
      if (errors.length) throw new AggregateError(errors, 'Building V2 runtime lease cleanup failed.');
      detachDoorStateListener(activeState);
      activeState = null;
    },

    mountCanvasInteraction(lease, handlers) {
      return requireActiveState(lease).canvasInputHost.mount(handlers);
    },

    resolveGeometryPoint(lease, worldPoint, options = {}) {
      return requireActiveState(lease).canvasInputHost.resolveGeometryPoint(worldPoint, options);
    },

    renderInterfaceOverlay(lease, descriptor) {
      return requireActiveState(lease).canvasInputHost.renderInterfaceOverlay(descriptor);
    },

    clearInterfaceOverlay(lease, options = {}) {
      return requireActiveState(lease).canvasInputHost.clearInterfaceOverlay(options);
    },

    getLocalBuildingShadowElevationSettings(lease, { elevation = 0 } = {}) {
      const state = requireActiveState(lease);
      if (typeof state.visualHost.getShadowElevationSettings !== 'function') {
        throw new Error('Building V2 runtime requires the public elevation shadow settings host.');
      }
      return state.visualHost.getShadowElevationSettings(elevation);
    },

    replaceLocalBuildingShadowElevationPreview(lease, { elevation = 0, alpha, blur } = {}) {
      const state = requireActiveState(lease);
      if (typeof state.visualHost.replaceShadowElevationPreview !== 'function') {
        throw new Error('Building V2 runtime requires the public elevation shadow preview host.');
      }
      return state.visualHost.replaceShadowElevationPreview(elevation, { alpha, blur });
    },

    clearLocalBuildingShadowElevationPreview(lease) {
      const state = requireActiveState(lease);
      return state.visualHost.clearShadowElevationPreview?.() === true;
    },

    resolveLocalBuildingPreviewPlacement(lease, placement = {}) {
      return resolveLocalPlacement(requireActiveState(lease), placement);
    },

    resolveLocalBuildingPreviewPlacementNudge(lease, {
      previewKind = 'building-fill-preview',
      mode = 'sort',
      direction = 0,
      currentElevation = 0,
      step = 0.001,
      anchorTileId = null,
      sortBefore = false,
      excludeTileIds = []
    } = {}) {
      const state = requireActiveState(lease);
      const normalizedDirection = Math.sign(Number(direction) || 0);
      if (!normalizedDirection) return null;
      const normalizedMode = String(mode || '').trim();
      let target;
      if (normalizedMode === 'sort') {
        target = resolvePreviewSortNudge({
          previewKind,
          direction: normalizedDirection,
          anchorTileId,
          sortBefore,
          excludeTileIds,
          announce: false
        });
        if (!target) return null;
      } else if (normalizedMode === 'elevation') {
        const elevation = Number(currentElevation);
        const elevationStep = Math.abs(Number(step));
        if (!Number.isFinite(elevation) || !Number.isFinite(elevationStep) || elevationStep <= 0) {
          throw new TypeError('Building V2 elevation nudge requires a finite elevation and positive step.');
        }
        target = {
          elevation: Math.round((elevation + (normalizedDirection * elevationStep)) * 10000) / 10000,
          anchorTileId: null,
          sortBefore: false
        };
      } else {
        throw new Error(`Building V2 Layer Manager placement nudge mode is unsupported: ${normalizedMode}.`);
      }
      return resolveLocalPlacement(state, {
        elevation: target.elevation,
        anchorTileId: target.anchorTileId || null,
        sortBefore: target.sortBefore === true,
        excludeTileIds
      });
    },

    probeLocalBuildingProjectionCapabilities(lease, { placementLevelId = null } = {}) {
      const state = requireActiveState(lease);
      state.visualHost.probe({ sceneId: state.sceneId });
      state.nativeHost.probe({ sceneId: state.sceneId, placementLevelId });
      return true;
    },

    async replaceLocalBuildingProjection(lease, projection) {
      const state = requireActiveState(lease);
      const requestGeneration = Number(projection?.requestGeneration);
      if (!Number.isInteger(requestGeneration) || requestGeneration <= state.latestRequestGeneration) {
        throw new Error('Building V2 projection replacement requires a new monotonic request generation.');
      }
      if (String(projection?.sceneId || '') !== state.sceneId) {
        throw new Error('Building V2 projection Scene does not match the active runtime lease.');
      }
      const prior = state.activeProjection;
      const priorReadiness = state.readiness;
      state.doorStateEpoch = (state.doorStateEpoch || 0) + 1;
      state.latestRequestGeneration = requestGeneration;
      state.latestProjection = projection;
      state.readiness = Object.freeze({
        status: 'loading',
        requestGeneration,
        semanticRevision: projection.semanticRevision,
        placementRevision: projection.placementRevision
      });
      let visual = null;
      let native = null;
      let ownsNative = false;
      let doorPresentation = null;
      let doorReplacement = null;
      let retainedDoorStateChanged = false;
      let doorReplacementCleanupError = null;
      try {
        const seamlessProjection = await prepareSeamlessProjection(projection);
        const materializedProjection = applyCurrentDoorState(state, materializeProjection(state, seamlessProjection));
        const preparedDoorStateSignature = doorStateSignature(materializedProjection);
        // Rebuilding and swapping hundreds of Foundry Edge instances on every
        // held-pointer generation schedules repeated perception, lighting, and
        // planned-movement refreshes. Those native refreshes compound while the
        // pointer keeps moving even though the authoring centerline is already
        // represented by the synchronized visual projection. Retain the last
        // active native simulation during the held gesture, then replace it with
        // the exact final projection on pointer release.
        const hasDoors = materializedProjection.nativeFragments?.some(fragment => fragment.portalId);
        // Continuous geometry projections deliberately omit ordinary Wall
        // fragments. A Portal chord does not make that partial output a complete
        // native replacement. Door placement/setup gestures use exact projections.
        const retainedNative = projection?.continuousGesture === true ? prior?.native : null;
        const nativeProjection = retainedNative
          ? retainNativeStructureWithCurrentDoors(prior.nativeProjection || prior.projection, projection)
          : projection;
        // Retain structural Edges and their expensive perception state, but
        // prepare the lightweight Door meshes against the current held jambs.
        // They are swapped only after this request is still proven current.
        const retainedProjectionHasDoors = retainedNative && (
          (prior.nativeProjection || prior.projection).nativeFragments || []
        ).some((fragment) => fragment.portalId);
        const doorPresentationInput = source => JSON.stringify([
          source.coordinateSpace, source.placement,
          (source.nativeFragments || []).filter(fragment => fragment.portalId)
        ]);
        const unchangedDoorPresentation = retainedNative
          && preparedDoorStateSignature === (prior.doorPresentationStateSignature || prior.nativeDoorStateSignature)
          && doorPresentationInput(projection) === doorPresentationInput(prior.projection);
        // A new Inner Wall tip does not move existing Portals. Preserve their
        // mounted meshes and Seamless surfaces when every presentation input
        // and the live gameplay state still match the active owner.
        if (retainedNative && (hasDoors || retainedProjectionHasDoors) && !unchangedDoorPresentation) {
          if (typeof state.nativeHost.prepareDoorPresentation !== 'function'
            || typeof state.nativeHost.replaceDoorPresentation !== 'function'
            || typeof state.nativeHost.finalizeDoorPresentationReplacement !== 'function'
            || typeof state.nativeHost.rollbackDoorPresentationReplacement !== 'function'
            || typeof state.nativeHost.releaseDoorPresentation !== 'function') {
            throw new Error('Building V2 continuous Door preview requires transactional native Door presentation replacement capabilities.');
          }
          doorPresentation = await state.nativeHost.prepareDoorPresentation(materializedProjection, {
            reusableNative: retainedNative
          });
        }
        native = retainedNative || (hasDoors ? null : await state.nativeHost.prepare(materializedProjection));
        ownsNative = !retainedNative;
        visual = await state.visualHost.prepare(materializedProjection, {
          isCurrent: () => activeState === state
            && !state.suspended
            && requestGeneration === state.latestRequestGeneration,
          // The exact mouse-up generation should adopt the live continuous Wall
          // mesh too. Reallocating it at release leaves the last held frame on
          // screen until a fresh mesh settles, producing a visible placement jump.
          reusableVisual: prior?.visual || null
        });
        if (!activeState || activeState !== state || requestGeneration !== state.latestRequestGeneration || state.suspended) {
          if (ownsNative) state.nativeHost.release(native);
          if (doorPresentation) state.nativeHost.releaseDoorPresentation(doorPresentation);
          state.visualHost.release(visual);
          return Object.freeze({ status: 'stale', requestGeneration });
        }
        if (state.currentSnapshot && !state.replacementSuppression) {
          await ensurePreparedReplacement(state);
        }
        if (!activeState || activeState !== state || state.suspended) {
          if (state.replacementSuppression) {
            existingEditRuntime.releasePreparedReplacement(state.replacementSuppression, { restore: true });
            state.replacementSuppression = null;
          }
          if (ownsNative) state.nativeHost.release(native);
          if (doorPresentation) state.nativeHost.releaseDoorPresentation(doorPresentation);
          state.visualHost.release(visual);
          announcePreviewLayersChanged('building-v2-projection-released-after-late-suppression');
          return Object.freeze({ status: 'stale', requestGeneration });
        }
        if (requestGeneration !== state.latestRequestGeneration) {
          if (ownsNative) state.nativeHost.release(native);
          if (doorPresentation) state.nativeHost.releaseDoorPresentation(doorPresentation);
          state.visualHost.release(visual);
          return Object.freeze({ status: 'stale', requestGeneration });
        }
        const currentRetainedDoorStateSignature = retainedNative
          ? currentDoorStateSignature(state, nativeProjection)
          : null;
        retainedDoorStateChanged = retainedNative && (
          sharedDoorStateChanged(prior.nativeDoorStateSignature, currentRetainedDoorStateSignature)
          || sharedDoorStateChanged(preparedDoorStateSignature, currentRetainedDoorStateSignature)
        );
        const publish = (preparedNative, nativeDoorStateSignature = preparedDoorStateSignature) => {
          native = preparedNative;
          const retainedNativeOwner = retainedNative && ownsNative === false && preparedNative === retainedNative;
          // Door activation is fallible and may partially mount its candidate.
          // Complete it while the prior visual still owns every reusable Wall
          // and shadow resource, so activation rollback can retain one coherent
          // prior projection without undoing an ownership transfer.
          if (retainedNative && doorPresentation) {
            doorReplacement = state.nativeHost.replaceDoorPresentation(native, doorPresentation);
            doorPresentation = null;
          }
          if (ownsNative) {
            try {
              state.nativeHost.activate(native);
            } catch (error) {
              state.visualHost.release(visual);
              throw error;
            }
          }
          try {
            state.visualHost.activate(visual);
          } catch (error) {
            if (ownsNative) state.nativeHost.release(native);
            throw error;
          }
          if (visual?.reusedSectionCount > 0 || visual?.reusedShadow === true) {
            if (typeof state.visualHost.adoptReusableSections !== 'function') {
              throw new Error('Building V2 continuous projection requires public unchanged-section ownership transfer.');
            }
            state.visualHost.adoptReusableSections(visual, prior.visual);
          }
          state.activeProjection = {
            visual,
            native,
            projection,
            nativeProjection,
            nativeDoorStateSignature: retainedNativeOwner
              ? prior.nativeDoorStateSignature
              : nativeDoorStateSignature,
            doorPresentationStateSignature: retainedNativeOwner
              ? preparedDoorStateSignature
              : nativeDoorStateSignature
          };
          state.suspendedNativeProjection = null;
          if (doorReplacement) {
            const finalized = state.nativeHost.finalizeDoorPresentationReplacement(doorReplacement);
            doorReplacement = null;
            doorReplacementCleanupError = finalized?.cleanupError || null;
          }
          if (prior) {
            if (prior.native !== native) state.nativeHost.release(prior.native);
            state.visualHost.release(prior.visual);
          }
          state.readiness = Object.freeze({
            status: projection.openings?.unresolved?.length ? 'unresolved' : 'ready',
            ...(projection.openings?.unresolved?.length ? { message: 'Resolve or delete invalid Openings before Commit.' } : {}),
            projectionId: projection.projectionId,
            requestGeneration,
            semanticRevision: projection.semanticRevision,
            placementRevision: projection.placementRevision,
            materializationReceipt: projection?.continuousGesture === true
              ? (priorReadiness?.materializationReceipt || visual.materializationReceipt)
              : buildMaterializationReceipt(state, projection, { ...visual.materializationReceipt,
                ...(seamlessProjection.portalSurfaces ? { portalSurfaces: seamlessProjection.portalSurfaces } : {}) })
          });
          if (!prior || previewLayerPlacementSignature(prior.projection) !== previewLayerPlacementSignature(projection)) {
            announcePreviewLayersChanged('building-v2-projection-ready');
          }
          if (doorReplacementCleanupError) {
            throw doorReplacementCleanupError;
          }
        };
        // A state event may arrive while artwork prepares. Reconcile against
        // the complete projection owned by the retained native handle; the held
        // artwork projection intentionally lacks ordinary structural fragments.
        if ((hasDoors && !retainedNative) || retainedDoorStateChanged) {
          if (doorPresentation) {
            state.nativeHost.releaseDoorPresentation(doorPresentation);
            doorPresentation = null;
          }
          native = null;
          ownsNative = true;
          const published = await prepareCurrentNative(state, nativeProjection,
            () => activeState === state && !state.suspended && requestGeneration === state.latestRequestGeneration,
            publish);
          if (!published) {
            state.visualHost.release(visual);
            return Object.freeze({ status: 'stale', requestGeneration });
          }
        } else publish(native);
        return state.readiness;
      } catch (error) {
        // Replacement cleanup can fail only after the coherent successor has
        // become the active owner. Preserve that exact published projection and
        // keep the failure observable; lease cleanup will retry the superseded
        // Door handle retained by the native host.
        if (doorReplacementCleanupError === error && state.activeProjection?.projection === projection) {
          if (activeState === state && requestGeneration === state.latestRequestGeneration) {
            state.readiness = Object.freeze({
              ...state.readiness,
              status: 'failed',
              message: String(error?.message || error)
            });
          }
          throw error;
        }
        if (doorReplacement) {
          try {
            state.nativeHost.rollbackDoorPresentationReplacement(doorReplacement);
          } catch (cleanupError) {
            error = new AggregateError(
              [error, cleanupError],
              'Building V2 Door presentation publication rollback failed.'
            );
          }
          doorReplacement = null;
        }
        if (native && ownsNative) state.nativeHost.release(native);
        if (doorPresentation) state.nativeHost.releaseDoorPresentation(doorPresentation);
        if (visual) state.visualHost.release(visual);
        if (activeState === state && requestGeneration === state.latestRequestGeneration) {
          if (prior) {
            state.activeProjection = prior;
            state.latestProjection = prior.projection;
            state.readiness = projection.nativeFragments?.some(fragment => fragment.portalId)
              ? Object.freeze({ ...priorReadiness, status: 'failed', message: String(error?.message || error) })
              : priorReadiness;
          } else {
            state.readiness = Object.freeze({
              status: 'failed',
              requestGeneration,
              semanticRevision: projection?.semanticRevision,
              placementRevision: projection?.placementRevision,
              message: String(error?.message || error)
            });
          }
        }
        throw error;
      }
    },

    clearLocalBuildingProjection(lease, { requestGeneration } = {}) {
      const state = requireActiveState(lease);
      const generation = Number(requestGeneration);
      if (!Number.isInteger(generation) || generation <= state.latestRequestGeneration) {
        throw new Error('Building V2 projection cleanup requires a new monotonic request generation.');
      }
      state.latestRequestGeneration = generation;
      state.latestProjection = null;
      const hadActiveProjection = !!state.activeProjection;
      if (hadActiveProjection) {
        state.nativeHost.release(state.activeProjection.native);
        state.visualHost.release(state.activeProjection.visual);
        state.activeProjection = null;
      }
      state.readiness = Object.freeze({ status: 'idle', requestGeneration: generation });
      if (hadActiveProjection) announcePreviewLayersChanged('building-v2-projection-clear');
      return state.readiness;
    },

    getLocalBuildingProjectionReadiness(lease) {
      return requireActiveState(lease).readiness;
    },

    async captureLocalBuildingCommitContext(lease, { elevation = 0 } = {}) {
      const state = requireActiveState(lease);
      const context = await commitRuntime.capture({ sceneId: state.sceneId, elevation: Number(elevation) });
      return Object.freeze({ ...context, surfaceRegionElevation: surfaceRegionElevation(elevation) });
    },

    commitLocalBuildingProjection(lease, plan) {
      const state = requireActiveState(lease);
      if (state.suspended) throw new Error('Building V2 Commit cannot run while the runtime lease is suspended.');
      if (!state.activeProjection || state.readiness?.status !== 'ready') {
        throw new Error('Building V2 Commit requires an active ready local projection.');
      }
      const activeProjection = state.activeProjection.projection;
      const identity = plan?.projectionIdentity || {};
      if (identity.projectionId !== activeProjection.projectionId
        || Number(identity.requestGeneration) !== Number(activeProjection.requestGeneration)
        || Number(identity.semanticRevision) !== Number(activeProjection.semanticRevision)
        || Number(identity.placementRevision) !== Number(activeProjection.placementRevision)) {
        throw new Error('Building V2 Commit plan does not match the exact active projection revision.');
      }
      // While the Commit writes this Building's own Walls the door-state listener stands by.
      const settle = () => { state.committing = false; };
      const swap = {
        swapLocalProjection: async ({ activateCommitted }) => {
          if (activeState !== state || state.activeProjection?.projection !== activeProjection) {
            throw new Error('Building V2 Commit lost ownership of its active local projection before handoff.');
          }
          state.visualHost.clearShadowElevationPreview?.();
          activateCommitted();
          state.nativeHost.release(state.activeProjection.native);
          state.visualHost.release(state.activeProjection.visual);
          state.activeProjection = null;
          if (state.replacementSuppression) {
            existingEditRuntime.releasePreparedReplacement(state.replacementSuppression, { restore: false });
            state.replacementSuppression = null;
          }
          announcePreviewLayersChanged('building-v2-commit-handoff');
          state.canvasInputHost.destroy();
          detachDoorStateListener(activeState);
        activeState = null;
        }
      };
      state.committing = true;
      let commit;
      try { commit = commitRuntime.execute(plan, swap); }
      catch (error) { settle(); throw error; }
      return Promise.resolve(commit).finally(settle);
    },

    completeLocalBuildingNoOp(lease, { sceneId, rootTileId } = {}) {
      const state = requireActiveState(lease);
      if (!state.currentSnapshot || String(sceneId || '') !== state.sceneId || String(rootTileId || '') !== state.rootTileId) {
        throw new Error('Building V2 no-op completion requires the exact existing-Building lease.');
      }
      state.visualHost.clearShadowElevationPreview?.();
      if (state.activeProjection) {
        state.nativeHost.release(state.activeProjection.native);
        state.visualHost.release(state.activeProjection.visual);
        state.activeProjection = null;
      }
      if (state.replacementSuppression) {
        existingEditRuntime.releasePreparedReplacement(state.replacementSuppression, { restore: true });
        state.replacementSuppression = null;
      }
      state.canvasInputHost.destroy();
      detachDoorStateListener(activeState);
      activeState = null;
      announcePreviewLayersChanged('building-v2-existing-no-op');
      return Object.freeze({ status: 'no-op', kind: 'existing-edit', sceneId: state.sceneId, rootTileId: state.rootTileId });
    },

    suspendRuntimeLease(lease) {
      const state = requireActiveState(lease);
      state.suspended = true;
      state.resumeEpoch = (state.resumeEpoch || 0) + 1;
      state.replacementSuppressionEpoch += 1;
      state.visualHost.clearShadowElevationPreview?.();
      if (state.activeProjection) {
        state.suspendedNativeProjection = state.activeProjection.nativeProjection || state.activeProjection.projection;
        state.nativeHost.release(state.activeProjection.native);
        state.visualHost.release(state.activeProjection.visual);
        state.activeProjection = null;
        announcePreviewLayersChanged('building-v2-runtime-suspend');
      }
      if (state.replacementSuppression) {
        existingEditRuntime.releasePreparedReplacement(state.replacementSuppression, { restore: true });
        state.replacementSuppression = null;
      }
      return state.canvasInputHost.suspend();
    },

    resumeRuntimeLease(lease) {
      const state = requireActiveState(lease);
      state.suspended = false;
      const resumeEpoch = state.resumeEpoch = (state.resumeEpoch || 0) + 1;
      const resumed = state.canvasInputHost.resume();
      if (state.latestProjection) {
        const projection = state.latestProjection;
        const nativeProjection = state.suspendedNativeProjection || projection;
        state.readiness = Object.freeze({
          status: 'loading',
          requestGeneration: projection.requestGeneration,
          semanticRevision: projection.semanticRevision,
          placementRevision: projection.placementRevision
        });
        return Promise.resolve().then(async () => {
          const seamlessProjection = await prepareSeamlessProjection(projection);
          const materializedProjection = applyCurrentDoorState(state, materializeProjection(state, seamlessProjection));
          let native = null;
          let visual = null;
          try {
            visual = await state.visualHost.prepare(materializedProjection, {
              isCurrent: () => activeState === state
                && !state.suspended
                && state.latestProjection === projection && state.resumeEpoch === resumeEpoch
            });
          }
          catch (error) {
            state.nativeHost.release(native);
            throw error;
          }
          if (!activeState || activeState !== state || state.suspended || state.latestProjection !== projection || state.resumeEpoch !== resumeEpoch) {
            state.nativeHost.release(native);
            state.visualHost.release(visual);
            return;
          }
          if (state.currentSnapshot && !state.replacementSuppression) {
            await ensurePreparedReplacement(state).catch(error => {
              state.visualHost.release(visual);
              throw error;
            });
          }
          const published = await prepareCurrentNative(state, nativeProjection,
            () => activeState === state && !state.suspended && state.latestProjection === projection && state.resumeEpoch === resumeEpoch,
            (preparedNative, nativeDoorStateSignature) => {
              native = preparedNative;
              state.visualHost.activate(visual);
              state.nativeHost.activate(native);
              state.activeProjection = { visual, native, projection, nativeProjection, nativeDoorStateSignature,
                doorPresentationStateSignature: nativeDoorStateSignature };
              state.suspendedNativeProjection = null;
              state.readiness = Object.freeze({
                status: projection.openings?.unresolved?.length ? 'unresolved' : 'ready',
                ...(projection.openings?.unresolved?.length ? { message: 'Resolve or delete invalid Openings before Commit.' } : {}),
                projectionId: projection.projectionId,
                requestGeneration: projection.requestGeneration,
                semanticRevision: projection.semanticRevision,
                placementRevision: projection.placementRevision,
                materializationReceipt: buildMaterializationReceipt(state, projection, { ...visual.materializationReceipt,
                  ...(seamlessProjection.portalSurfaces ? { portalSurfaces: seamlessProjection.portalSurfaces } : {}) })
              });
            }).catch(error => { state.visualHost.release(visual); throw error; });
          if (!published) { state.visualHost.release(visual); return; }
          announcePreviewLayersChanged('building-v2-projection-resume');
          return state.readiness;
        }).catch((error) => {
          if (activeState === state && state.latestProjection === projection && state.resumeEpoch === resumeEpoch) {
            state.readiness = Object.freeze({
              status: 'failed',
              requestGeneration: projection.requestGeneration,
              semanticRevision: projection.semanticRevision,
              placementRevision: projection.placementRevision,
              message: String(error?.message || error)
            });
          }
          console.error('[FA Nexus] Building V2 failed to restore its local projection after Canvas rebind.', error);
          return state.readiness;
        });
      }
      return resumed;
    }
  };

  return Object.freeze(capabilities);
}

let canonicalCapabilities = null;

/** Returns the one public Building V2 runtime authority for this client. */
export function getBuildingV2RuntimeCapabilities() {
  canonicalCapabilities ??= createBuildingV2RuntimeCapabilities();
  return canonicalCapabilities;
}

export function validateBuildingV2RuntimeCapabilities(capabilities) {
  if (!capabilities || capabilities.id !== BUILDING_V2_RUNTIME_ID) {
    throw new Error(`Building V2 requires the ${BUILDING_V2_RUNTIME_ID} runtime contract.`);
  }
  if (Number(capabilities.contractVersion) !== BUILDING_V2_RUNTIME_CONTRACT_VERSION) {
    throw new Error(
      `Building V2 requires runtime contract version ${BUILDING_V2_RUNTIME_CONTRACT_VERSION}; received ${capabilities.contractVersion ?? 'missing'}.`
    );
  }
  if (typeof capabilities.moduleVersion !== 'string' || !capabilities.moduleVersion.trim()) {
    throw new Error('Building V2 runtime contract requires a non-empty moduleVersion.');
  }
  for (const methodName of [
    'materializeDoorAnimation',
    'materializeDoorWall',
    'normalizeDoorAppearance',
    'normalizeDoorFrame',
    'compileDoorFrame',
    'normalizeDoorShadow',
    'resolveDoorCarrierNormal',
    'materializeDoorShadowForChord',
    'materializeDoorShadowForRoot',
    'captureV053MigrationPreflight',
    'acquireRuntimeLease',
    'captureCurrentBuildingSnapshot',
    'resolveCurrentBuildingRefit',
    'normalizeWindowSetup',
    'compileWindowArtwork',
    'compileWindowSills',
    'materializeWindowSills',
    'materializeWindowWall',
    'normalizePortalTiming',
    'normalizePortalSound',
    'getPortalOptionFields',
    'readLocalBuildingPortalStates',
    'setLocalBuildingPortalStateListener',
    'resolveWindowSillsPlacement',
    'compileBuildingV2FillMaskSource',
    'createBuildingV2SurfaceRegionSource',
    'getDefaultTileOcclusion',
    'getDefaultTileRestrictions',
    'getDefaultTileLevels',
    'getWallBehaviorFields',
    'patchWallBehavior',
    'projectBuildingV2FillMaskToManagedTile',
    'releaseRuntimeLease',
    'mountCanvasInteraction',
    'resolveGeometryPoint',
    'renderInterfaceOverlay',
    'clearInterfaceOverlay',
    'getLocalBuildingShadowElevationSettings',
    'replaceLocalBuildingShadowElevationPreview',
    'clearLocalBuildingShadowElevationPreview',
    'resolveLocalBuildingPreviewPlacement',
    'resolveLocalBuildingPreviewPlacementNudge',
    'probeLocalBuildingProjectionCapabilities',
    'replaceLocalBuildingProjection',
    'clearLocalBuildingProjection',
    'getLocalBuildingProjectionReadiness',
    'captureLocalBuildingCommitContext',
    'commitLocalBuildingProjection',
    'completeLocalBuildingNoOp',
    'suspendRuntimeLease',
    'resumeRuntimeLease'
  ]) {
    if (typeof capabilities[methodName] !== 'function') {
      throw new Error(`Building V2 runtime contract requires ${methodName}().`);
    }
  }
  return capabilities;
}
