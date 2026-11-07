import { clearHsbcFromDisplayObject } from '../../core/hsbc.js';
import { loadFoundryTexture } from '../../core/foundry-texture-cache.js';
import { materializeBuildingV2DoorWall } from './building-v2-opening-runtime.js';
import { syncPortalTextureFlipForMesh } from '../../portals/portal-texture-flip-runtime.js';
import { DoorShadowManager } from '../../portals/door-shadow-manager.js';
import { materializeBuildingV2DoorShadow } from './building-v2-door-shadow.js';
import {
  materializeBuildingV2WindowWall,
  normalizeBuildingV2WindowSetup
} from './building-v2-window.js';
import { isSmallPortalTexturePath } from '../../portals/portal-texture-path.js';
import { reconstructSeamlessSecretDoorSurface, applySeamlessSecretDoorMeshPresentation } from '../../portals/seamless-secret-door-runtime.js';

// Mirror v14 Wall.createDoorMeshes, but keep preparation detached and failures observable.
export function createBuildingV2DoorSimulationV14({
  getCanvas = () => globalThis.canvas,
  getWallDocumentClass = () => globalThis.CONFIG?.Wall?.documentClass,
  getWallClass = () => globalThis.CONFIG?.Wall?.objectClass,
  getDoorMeshClass = () => globalThis.foundry?.canvas?.containers?.DoorMesh,
  getEdgeClass = () => globalThis.foundry?.canvas?.geometry?.edges?.Edge,
  textureLoader = loadFoundryTexture,
  applyTextureFlip = syncPortalTextureFlipForMesh,
  getDoorShadowManager = () => DoorShadowManager.getInstance(),
  randomID = () => globalThis.foundry.utils.randomID()
} = {}) {
  const pendingCleanup = new Set();

  function release(prepared) {
    if (!prepared || prepared.released) return false;
    const errors = [];
    for (const handle of prepared.shadowHandles || []) {
      try { getDoorShadowManager().releaseDetachedPreview(handle); } catch (error) { errors.push(error); }
    }
    for (const resource of [...prepared.meshes, ...prepared.objects]) {
      try {
        if (prepared.meshes.includes(resource)) clearHsbcFromDisplayObject(resource, { slot: 'building-v2-door-leaf' });
        resource.parent?.removeChild(resource);
        if (!resource.destroyed) resource.destroy({ children: true });
      } catch (error) { errors.push(error); }
    }
    for (const surface of prepared.seamlessSurfaces || []) {
      try { surface.destroy(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      pendingCleanup.add(prepared);
      throw new AggregateError(errors, 'Building V2 Door simulation cleanup failed.');
    }
    pendingCleanup.delete(prepared);
    prepared.released = true;
    return true;
  }

  function releasePending() {
    const errors = [];
    let released = 0;
    for (const prepared of Array.from(pendingCleanup)) {
      try {
        if (release(prepared)) released += 1;
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Building V2 Door pending cleanup failed.');
    return released;
  }
  return Object.freeze({
    async prepare(projection, { reusable = null } = {}) {
      const canvas = getCanvas();
      const prepared = { canvas, scene: canvas.scene, objects: [], meshes: [], shadowHandles: [], seamlessSurfaces: [], textureEntries: new Map(), released: false };
      try {
        for (const fragment of projection.nativeFragments.filter((entry) => entry.door)) {
          const { door, behavior = {} } = fragment;
          const isSeamless = door.type === 2 && door.portalKind === 'seamlessSecretDoor';
          const isDoor = (door.type === 1 && door.portalKind == null) || isSeamless;
          const isAnimatedWindow = door.type === 2 && door.portalKind === 'window';
          const isStaticWindow = door.type === 0 && door.portalKind === 'window';
          if (![0, 1, 2].includes(door.state) || (!isDoor && !isAnimatedWindow && !isStaticWindow)) {
            throw new Error('Building V2 Portal simulation requires an exact Door or Window role and valid state.');
          }
          const windowSetup = (isAnimatedWindow || isStaticWindow)
            ? normalizeBuildingV2WindowSetup(door.setup) : null;
          if ((isAnimatedWindow && !windowSetup.animated) || (isStaticWindow && windowSetup.animated)) {
            throw new Error('Building V2 Window native role must match its exact static/animated setup.');
          }
          if (isStaticWindow) {
            continue;
          }
          const native = isAnimatedWindow
            ? materializeBuildingV2WindowWall(windowSetup, {
              a: fragment.a, b: fragment.b, dir: behavior.dir || 0,
              state: door.state, behavior: door.customBehavior ? behavior : null, reflected: projection.doorReflected === true, scale: projection.doorSceneScale ?? 1,
              sceneGridSize: projection.placement?.sceneGridSize
            })
            : materializeBuildingV2DoorWall(door, {
              a: fragment.a, b: fragment.b, dir: behavior.dir || 0, reflected: projection.doorReflected === true, scale: projection.doorSceneScale ?? 1,
              sceneGridSize: projection.placement?.sceneGridSize
            });
          const shadow = isDoor && door.shadow
            ? materializeBuildingV2DoorShadow(door.shadow, { scale: projection.doorSceneScale ?? 1 })
            : (isAnimatedWindow ? native.windowShadow : null);
          const WallDocument = getWallDocumentClass();
          const Wall = getWallClass();
          const DoorMesh = getDoorMeshClass();
          const Edge = getEdgeClass();
          if (![WallDocument, Wall, DoorMesh, Edge].every((value) => typeof value === 'function')
            || typeof canvas.primary?.addChild !== 'function') {
            throw new Error('Building V2 Door simulation requires Foundry v14 WallDocument, Wall, DoorMesh, Edge, and primary APIs.');
          }
          const textureSource = String(native.animation?.texture || '');
          const seamlessSurface = isSeamless ? await reconstructSeamlessSecretDoorSurface(door.surfacePlan) : null;
          if (seamlessSurface) prepared.seamlessSurfaces.push(seamlessSurface);
          const texture = seamlessSurface?.texture || prepared.textureEntries.get(textureSource)
            || reusable?.textureEntries?.get(textureSource)
            || await textureLoader(textureSource);
          if (!texture?.valid || !(texture.width > 0) || !(texture.height > 0)) {
            throw new Error(`Building V2 Portal artwork could not be loaded: ${textureSource}`);
          }
          if (!seamlessSurface) prepared.textureEntries.set(textureSource, texture);
          // Construct only: never insert into scene.walls or invoke document creation/draw hooks.
          const document = new WallDocument(structuredClone({
            ...behavior, _id: randomID(), c: native.c, dir: native.dir,
            ...(isAnimatedWindow ? { light: native.light, sight: native.sight, threshold: native.threshold } : {}),
            door: native.door ?? door.type, ds: native.ds ?? door.state, animation: native.animation,
            ...(native.doorSound !== undefined ? { doorSound: native.doorSound } : {}),
            flags: { core: { textureGridSize: native.textureGridSize },
              'fa-nexus': { buildingGenerated: { version: 1, role: 'portal',
                ...(isAnimatedWindow ? { portalKind: 'window', windowSetup } : {}),
                textureFlip: native.textureFlip, ...(native.appearance ? { appearance: native.appearance } : {}),
                ...(shadow ? { doorShadowNormal: shadow.normal } : {}) },
              ...(isAnimatedWindow ? { buildingWindow: {
                gapId: fragment.portalId, animation: native.animation.type,
                textureKey: door.setup.surface.asset.key, textureLocal: door.setup.surface.asset.src,
                smallTexture: isSmallPortalTexturePath(door.setup.surface.asset.src),
                hsbc: door.setup.surface.hsbc, textureFlip: native.textureFlip
              } } : {}),
              ...(isSeamless ? { buildingSeamlessSecretDoor: { gapId: fragment.portalId, surfacePlan: door.surfacePlan } } : {}),
              ...(shadow ? { [isAnimatedWindow ? 'windowShadow' : 'doorShadow']: {
                enabled: shadow.enabled, alpha: shadow.alpha, blur: shadow.blur,
                dilation: shadow.dilation, offset: shadow.offset
              } } : {}) } },
            levels: [...(projection.placement?.levels || [])]
          }), { parent: canvas.scene });
          const object = new Wall(document);
          object._previewType = 'api';
          prepared.objects.push(object);
          // Native slide animation reads Wall.edge even during initialization.
          // Keep this derived animation edge detached: initializeEdge() would
          // register the temporary document in Scene Level perception geometry.
          Object.defineProperty(object, 'edge', { value: new Edge(
            { x: native.c[0], y: native.c[1] }, { x: native.c[2], y: native.c[3] },
            { type: 'wall', direction: native.dir }
          ) });
          const { texture: source, ...animation } = document.animation;
          const styles = animation.double
            ? [DoorMesh.DOOR_STYLES.DOUBLE_LEFT, DoorMesh.DOOR_STYLES.DOUBLE_RIGHT]
            : [DoorMesh.DOOR_STYLES.SINGLE];
          const fragmentMeshes = [];
          for (const style of styles) {
            const mesh = new DoorMesh({ object, texture: seamlessSurface?.textureForStyle(style, DoorMesh) || texture, style, ...animation });
            prepared.meshes.push(mesh);
            fragmentMeshes.push(mesh);
            applyTextureFlip(document, mesh, { reason: 'buildingV2DoorPreview', strict: true });
            if (seamlessSurface) applySeamlessSecretDoorMeshPresentation(mesh, seamlessSurface.presentationPlan, seamlessSurface.meshOffset);
          }
          if (shadow) {
            try {
              prepared.shadowHandles.push(await getDoorShadowManager().prepareDetachedPreview({
                document, meshes: fragmentMeshes
              }));
            } catch (error) {
              const cleanupHandle = error?.faNexusDoorShadowCleanupHandle;
              if (cleanupHandle && !prepared.shadowHandles.includes(cleanupHandle)) {
                prepared.shadowHandles.push(cleanupHandle);
              }
              throw error;
            }
          }
        }
        return prepared;
      } catch (error) {
        try { release(prepared); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Building V2 Door preparation and cleanup failed.');
        }
        throw error;
      }
    },
    activate(prepared) {
      if (!prepared || prepared.released || getCanvas()?.scene !== prepared.scene) {
        throw new Error('Building V2 Door simulation cannot activate a released or stale Scene projection.');
      }
      for (const mesh of prepared.meshes) prepared.canvas.primary.addChild(mesh);
      for (const handle of prepared.shadowHandles) getDoorShadowManager().activateDetachedPreview(handle);
      return prepared;
    },
    release,
    releasePending
  });
}
