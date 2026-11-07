import { onFoundryBoot } from '../core/foundry-boot-hooks.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { applyHsbcToDisplayObject, clearHsbcFromDisplayObject, isNeutralHsbc } from '../core/hsbc.js';
import { normalizeBuildingV2DoorAppearance } from '../buildings/v2/building-v2-door-appearance.js';
import { needsPortalTextureMeshRefresh } from './portal-texture-scale.js';
import { applySeamlessSecretDoorMeshPresentationForDocument } from './seamless-secret-door-runtime.js';

const MODULE_ID = 'fa-nexus';
const SYNC_RETRY_ATTEMPTS = 24;
const SYNC_RETRY_DELAY_MS = 100;

const mirroredTextureCache = new WeakMap();
const mirrorFailureKeys = new Set();
const pendingDocumentSyncs = new Map();

function stringifyError(error) {
  return String(error?.message || error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBuildingV2Portal(doc) {
  const generated = doc?.getFlag?.(MODULE_ID, 'buildingGenerated') || doc?.flags?.[MODULE_ID]?.buildingGenerated;
  return generated?.version === 1 && generated.role === 'portal' ? generated : null;
}

function getPortalFlags(doc) {
  const faFlags = doc?.flags?.[MODULE_ID] || null;
  const generated = doc?.getFlag?.(MODULE_ID, 'buildingGenerated') || faFlags?.buildingGenerated;
  if (generated?.version === 1 && generated.role === 'portal') return { textureFlip: generated.textureFlip || {} };
  const buildingDoor = doc?.getFlag?.(MODULE_ID, 'buildingDoor') || faFlags?.buildingDoor || null;
  if (buildingDoor && typeof buildingDoor === 'object') return buildingDoor;
  const buildingWindow = doc?.getFlag?.(MODULE_ID, 'buildingWindow') || faFlags?.buildingWindow || null;
  if (buildingWindow && typeof buildingWindow === 'object') return buildingWindow;
  return null;
}

export function getPortalTextureFlip(doc) {
  const portal = getPortalFlags(doc);
  if (!portal) return { horizontal: false, vertical: false };
  const raw = portal.textureFlip && typeof portal.textureFlip === 'object' ? portal.textureFlip : null;
  const hasHorizontal = raw && Object.prototype.hasOwnProperty.call(raw, 'horizontal');
  const hasVertical = raw && Object.prototype.hasOwnProperty.call(raw, 'vertical');
  return {
    horizontal: hasHorizontal ? !!raw.horizontal : !!(portal.flipHorizontal ?? portal.flipX),
    vertical: hasVertical ? !!raw.vertical : !!(portal.flip ?? doc?.animation?.flip)
  };
}

function getTextureFailureKey(texture) {
  return String(texture?.baseTexture?.uid || texture?.baseTexture?.cacheId || texture?.uid || texture?.textureCacheIds?.[0] || '');
}

function createHorizontallyMirroredTexture(texture) {
  const base = texture?.baseTexture;
  const source = base?.resource?.source;
  if (!texture || !base || !source) {
    throw new Error('Door texture source is unavailable for horizontal mirroring.');
  }

  const frame = texture.frame || null;
  const sourceWidth = Math.max(1, Math.round(Number(frame?.width || texture.width || base.width) || 0));
  const sourceHeight = Math.max(1, Math.round(Number(frame?.height || texture.height || base.height) || 0));
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error(`Door texture has invalid mirror dimensions: ${sourceWidth}x${sourceHeight}.`);
  }

  const canvasEl = document.createElement('canvas');
  canvasEl.width = sourceWidth;
  canvasEl.height = sourceHeight;
  const ctx = canvasEl.getContext('2d');
  if (!ctx) throw new Error('Could not create 2D context for mirrored door texture.');

  const sx = Math.max(0, Math.round(Number(frame?.x || 0)));
  const sy = Math.max(0, Math.round(Number(frame?.y || 0)));
  ctx.translate(sourceWidth, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(source, sx, sy, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);

  const mirroredBase = PIXI.BaseTexture.from(canvasEl);
  mirroredBase.mipmap = PIXI.MIPMAP_MODES?.OFF ?? mirroredBase.mipmap;
  mirroredBase.wrapMode = PIXI.WRAP_MODES?.CLAMP ?? mirroredBase.wrapMode;
  const mirrored = new PIXI.Texture(mirroredBase);
  try { mirrored.defaultAnchor.copyFrom(texture.defaultAnchor); } catch (_) {}
  return mirrored;
}

function getHorizontallyMirroredTexture(texture) {
  if (!texture || texture.destroyed) return null;
  const cached = mirroredTextureCache.get(texture);
  if (cached && !cached.destroyed) return cached;
  const mirrored = createHorizontallyMirroredTexture(texture);
  mirroredTextureCache.set(texture, mirrored);
  return mirrored;
}

function restoreOriginalTexture(mesh, { reason = 'unknown' } = {}) {
  const original = mesh?.faNexusPortalTextureOriginal || null;
  if (!mesh || mesh.destroyed || !original || original.destroyed) return false;
  if (mesh.texture !== original) mesh.texture = original;
  mesh.faNexusPortalTextureOriginal = null;
  mesh.faNexusPortalTextureMirroredHorizontal = false;
  Logger.debug?.('PortalTextureFlip.restoreHorizontal', {
    reason,
    meshName: mesh.name || null,
    wallId: mesh?.object?.document?.id || mesh?.faNexusSourceWallId || null
  });
  return true;
}

function resolveOriginalTexture(mesh) {
  const original = mesh?.faNexusPortalTextureOriginal;
  if (original && !original.destroyed) return original;
  return mesh?.texture && !mesh.texture.destroyed ? mesh.texture : null;
}

export function syncPortalTextureFlipForMesh(doc, mesh, { reason = 'unknown', strict = false } = {}) {
  if (!doc || !mesh || mesh.destroyed) return false;
  const generated = getBuildingV2Portal(doc);
  if (generated) {
    strict = true;
    const { hsbc } = normalizeBuildingV2DoorAppearance(generated.appearance);
    const filter = applyHsbcToDisplayObject(mesh, hsbc, { slot: 'building-v2-door-leaf' });
    if (!isNeutralHsbc(hsbc) && !filter) throw new Error('Building V2 Door HSBC filter could not be applied.');
  }
  const flip = getPortalTextureFlip(doc);
  if (!flip.horizontal) return restoreOriginalTexture(mesh, { reason });

  const original = resolveOriginalTexture(mesh);
  if (!original) {
    if (strict) throw new Error('Building V2 Door original texture is unavailable for horizontal mirroring.');
    Logger.error?.('PortalTextureFlip.originalTexture.missing', {
      reason,
      wallId: doc?.id || null,
      meshName: mesh?.name || null
    });
    return false;
  }

  try {
    const mirrored = getHorizontallyMirroredTexture(original);
    if (!mirrored) throw new Error('Mirrored texture was not created.');
    mesh.faNexusPortalTextureOriginal = original;
    mesh.faNexusPortalTextureMirroredHorizontal = true;
    if (mesh.texture !== mirrored) mesh.texture = mirrored;
    Logger.debug?.('PortalTextureFlip.applyHorizontal', {
      reason,
      wallId: doc?.id || null,
      meshName: mesh?.name || null
    });
    return true;
  } catch (error) {
    if (strict) throw error;
    const key = getTextureFailureKey(original) || `${doc?.id || 'unknown'}:${mesh?.name || 'mesh'}`;
    if (!mirrorFailureKeys.has(key)) {
      mirrorFailureKeys.add(key);
      Logger.error?.('PortalTextureFlip.applyHorizontal.failed', {
        reason,
        wallId: doc?.id || null,
        meshName: mesh?.name || null,
        error: stringifyError(error)
      });
    }
    return false;
  }
}

export function syncPortalTextureFlipForDocument(
  doc,
  meshes = [],
  {
    reason = 'unknown',
    refreshGeometry = false
  } = {}
) {
  if (!doc || !Array.isArray(meshes) || !meshes.length) return false;
  let changed = false;
  const useCurrentDocumentEdge = refreshGeometry && !!getBuildingV2Portal(doc);
  for (const mesh of meshes) {
    if (refreshGeometry && mesh && !mesh.destroyed && typeof mesh.initialize === 'function') {
      if (useCurrentDocumentEdge) initializeDoorMeshTransformPreview(doc, mesh);
      else mesh.initialize(doc.animation || doc?._source?.animation || {});
      changed = true;
    }
    changed = syncPortalTextureFlipForMesh(doc, mesh, { reason }) || changed;
    if (refreshGeometry && mesh && !mesh.destroyed) applySeamlessSecretDoorMeshPresentationForDocument(doc, mesh);
  }
  return changed;
}

function getTransformPreviewEdge(doc) {
  const coords = Array.from(doc?.c || doc?._source?.c || []).slice(0, 4).map(Number);
  if (coords.length !== 4 || !coords.every(Number.isFinite)) {
    throw new Error(`Animated Wall ${doc?.id || '(unknown)'} has invalid transform-preview coordinates.`);
  }
  return {
    a: { x: coords[0], y: coords[1] },
    b: { x: coords[2], y: coords[3] }
  };
}

export function initializeDoorMeshTransformPreview(doc, mesh) {
  if (!mesh || mesh.destroyed) return false;
  if (typeof mesh.initialize !== 'function') {
    throw new Error(`DoorMesh ${mesh.name || '(unnamed)'} cannot refresh transform-preview geometry.`);
  }
  const object = mesh.object;
  if (!object) throw new Error(`DoorMesh ${mesh.name || '(unnamed)'} has no Wall render owner.`);
  const priorEdge = Object.getOwnPropertyDescriptor(object, 'edge');
  Object.defineProperty(object, 'edge', {
    configurable: true,
    value: getTransformPreviewEdge(doc)
  });
  try {
    mesh.initialize({ ...(doc.animation || doc?._source?.animation || {}) });
  } finally {
    if (priorEdge) Object.defineProperty(object, 'edge', priorEdge);
    else delete object.edge;
  }
  return true;
}

export function syncDoorMeshTransformPreview(doc) {
  const documentName = String(doc?.documentName || doc?.constructor?.documentName || '');
  if (documentName !== 'Wall') return false;
  const meshes = Array.from(doc?.object?.doorMeshes || [])
    .filter((mesh) => mesh && !mesh.destroyed);
  if (!meshes.length) return false;
  for (const mesh of meshes) {
    initializeDoorMeshTransformPreview(doc, mesh);
    applySeamlessSecretDoorMeshPresentationForDocument(doc, mesh);
  }
  syncPortalTextureFlipForDocument(doc, meshes, { reason: 'transformPreview' });
  return true;
}

function getNativeDoorMeshes(doc) {
  const wallId = String(doc?.id || '');
  if (!wallId || !canvas?.walls?.get) return [];
  const wall = canvas.walls.get(wallId);
  return wall?.doorMeshes ? Array.from(wall.doorMeshes).filter(Boolean) : [];
}

function getDocumentLevelIds(doc) {
  const levels = doc?.levels;
  if (levels?.size) return Array.from(levels).map((id) => String(id)).filter(Boolean);
  const sourceLevels = doc?._source?.levels || doc?.data?.levels || null;
  return Array.isArray(sourceLevels) ? sourceLevels.map((id) => String(id)).filter(Boolean) : [];
}

export function shouldSyncNativeDoorMeshes(doc) {
  if (!doc?.id) return false;
  const scene = canvas?.scene || null;
  // Group visibility deliberately turns Doors into non-Doors. Native Foundry
  // removes their meshes; absence is expected until the Door is shown again.
  if (!(Number(doc.door ?? doc._source?.door) > 0)) return false;
  if (doc.parent && doc.parent !== scene) return false;
  if (scene?.walls?.get && scene.walls.get(doc.id) !== doc) return false;
  const levelIds = getDocumentLevelIds(doc);
  if (!scene?.levels || !levelIds.length) return true;
  if (doc?.viewed === true) return true;
  Logger.debug?.('PortalTextureFlip.nativeMeshes.skippedInactiveLevel', {
    wallId: doc.id,
    viewedLevelId: scene?._view || null,
    wallLevelIds: levelIds
  });
  return false;
}

function hasAnimatedPortal(doc) {
  const portal = getPortalFlags(doc);
  if (!portal) return false;
  const animation = doc?.animation || doc?._source?.animation || doc?.data?.animation || null;
  return !!(animation?.type && animation?.texture);
}

export function needsPortalTextureDocumentMeshRefresh(doc, diff = {}) {
  return needsPortalTextureMeshRefresh(diff)
    || (!!getBuildingV2Portal(doc) && Object.prototype.hasOwnProperty.call(diff || {}, 'c'));
}

async function syncNativeDoorMeshesWithRetry(
  doc,
  {
    reason = 'unknown',
    refreshGeometry = false,
    isCurrent = () => true
  } = {}
) {
  if (!doc?.id || !hasAnimatedPortal(doc)) return false;
  if (!shouldSyncNativeDoorMeshes(doc)) return false;
  for (let attempt = 0; attempt < SYNC_RETRY_ATTEMPTS; attempt += 1) {
    if (!canvas?.ready || !isCurrent()) return false;
    if (!shouldSyncNativeDoorMeshes(doc)) return false;
    const meshes = getNativeDoorMeshes(doc);
    if (meshes.length) {
      return syncPortalTextureFlipForDocument(doc, meshes, { reason, refreshGeometry });
    }
    await sleep(SYNC_RETRY_DELAY_MS);
  }
  if (!isCurrent() || !shouldSyncNativeDoorMeshes(doc)) return false;
  if (getBuildingV2Portal(doc)) throw new Error(`Building V2 Door native meshes unavailable after ${SYNC_RETRY_ATTEMPTS} attempts.`);
  Logger.warn?.('PortalTextureFlip.nativeMeshes.unavailable', {
    reason,
    wallId: doc?.id || null,
    attempts: SYNC_RETRY_ATTEMPTS
  });
  return false;
}

function scheduleNativeDoorMeshSync(doc, reason, { refreshGeometry = false } = {}) {
  const id = String(doc?.id || '');
  if (!id) return;
  const existing = pendingDocumentSyncs.get(id);
  if (existing?.timeout) clearTimeout(existing.timeout);
  const shouldRefreshGeometry = !!refreshGeometry || !!existing?.refreshGeometry;
  const job = { timeout: null, refreshGeometry: shouldRefreshGeometry };
  pendingDocumentSyncs.set(id, job);
  job.timeout = setTimeout(() => {
    syncNativeDoorMeshesWithRetry(doc, {
      reason,
      refreshGeometry: shouldRefreshGeometry,
      isCurrent: () => pendingDocumentSyncs.get(id) === job
    }).catch((error) => {
      if (getBuildingV2Portal(doc)) globalThis.ui?.notifications?.error?.(`Building V2 Door appearance failed: ${stringifyError(error)}`);
      Logger.error?.('PortalTextureFlip.nativeSync.failed', {
        reason,
        wallId: id,
        error: stringifyError(error)
      });
    }).finally(() => {
      if (pendingDocumentSyncs.get(id) === job) pendingDocumentSyncs.delete(id);
    });
  }, 0);
}

function syncWallPlaceable(wall, reason) {
  const doc = wall?.document || wall;
  if (!doc?.id || !getPortalFlags(doc)) return;
  if (!shouldSyncNativeDoorMeshes(doc)) return;
  const meshes = wall?.doorMeshes ? Array.from(wall.doorMeshes).filter(Boolean) : [];
  if (meshes.length) {
    syncPortalTextureFlipForDocument(doc, meshes, { reason });
    return;
  }
  scheduleNativeDoorMeshSync(doc, reason);
}

function installWallCreateDoorMeshesPatch() {
  const WallClass = globalThis?.foundry?.canvas?.placeables?.Wall
    || globalThis?.Wall
    || canvas?.walls?.placeables?.[0]?.constructor
    || null;
  const proto = WallClass?.prototype;
  if (!proto || typeof proto.createDoorMeshes !== 'function') return false;
  // Native Wall replacement, deletion and teardown all release through this
  // method. Pixi destroys the mesh but does not own our shared HSBC slot.
  if (typeof proto.destroyDoorMeshes === 'function' && !proto.destroyDoorMeshes.faNexusPortalTextureFlipPatched) {
    const destroyDoorMeshes = proto.destroyDoorMeshes;
    const destroyPatched = function faNexusDestroyDoorMeshesWithAppearance(...args) {
      if (getBuildingV2Portal(this.document)) {
        for (const mesh of this.doorMeshes || []) {
          clearHsbcFromDisplayObject(mesh, { slot: 'building-v2-door-leaf' });
        }
      }
      return destroyDoorMeshes.apply(this, args);
    };
    destroyPatched.faNexusPortalTextureFlipPatched = true;
    proto.destroyDoorMeshes = destroyPatched;
  }
  if (proto.createDoorMeshes.faNexusPortalTextureFlipPatched) return true;

  const original = proto.createDoorMeshes;
  const patched = async function faNexusCreateDoorMeshesWithTextureFlip(...args) {
    const result = await original.apply(this, args);
    try {
      syncWallPlaceable(this, 'createDoorMeshes');
    } catch (error) {
      if (getBuildingV2Portal(this?.document)) throw error;
      Logger.error?.('PortalTextureFlip.createDoorMeshes.syncFailed', {
        wallId: this?.document?.id || null,
        error: stringifyError(error)
      });
    }
    return result;
  };
  patched.faNexusPortalTextureFlipPatched = true;
  proto.createDoorMeshes = patched;
  Logger.debug?.('PortalTextureFlip.wallPatch.installed');
  return true;
}

function syncSceneDoorMeshes(reason) {
  if (!canvas?.ready || !canvas?.scene?.walls) return;
  for (const doc of canvas.scene.walls) {
    if (getPortalFlags(doc)) scheduleNativeDoorMeshSync(doc, reason);
  }
}

function installPortalTextureFlipRuntime() {
  installWallCreateDoorMeshesPatch();
  try { Hooks.on('drawWall', (wall) => syncWallPlaceable(wall, 'drawWall')); } catch (error) { Logger.error?.('PortalTextureFlip.hook.drawWall.failed', { error: stringifyError(error) }); }
  try { Hooks.on('refreshWall', (wall) => syncWallPlaceable(wall, 'refreshWall')); } catch (error) { Logger.error?.('PortalTextureFlip.hook.refreshWall.failed', { error: stringifyError(error) }); }
  try { Hooks.on('createWall', (doc) => scheduleNativeDoorMeshSync(doc, 'createWall')); } catch (error) { Logger.error?.('PortalTextureFlip.hook.createWall.failed', { error: stringifyError(error) }); }
  try {
    Hooks.on('updateWall', (doc, diff) => scheduleNativeDoorMeshSync(doc, 'updateWall', {
      refreshGeometry: needsPortalTextureDocumentMeshRefresh(doc, diff)
    }));
  } catch (error) {
    Logger.error?.('PortalTextureFlip.hook.updateWall.failed', { error: stringifyError(error) });
  }
  try {
    Hooks.on('canvasReady', () => {
      installWallCreateDoorMeshesPatch();
      syncSceneDoorMeshes('canvasReady');
    });
  } catch (error) {
    Logger.error?.('PortalTextureFlip.hook.canvasReady.failed', { error: stringifyError(error) });
  }
  if (canvas?.ready) syncSceneDoorMeshes('moduleLoad');
}

try { onFoundryBoot('init', () => installWallCreateDoorMeshesPatch()); } catch (error) { Logger.error?.('PortalTextureFlip.hook.init.failed', { error: stringifyError(error) }); }
try { onFoundryBoot('ready', () => installPortalTextureFlipRuntime()); } catch (error) { Logger.error?.('PortalTextureFlip.hook.ready.failed', { error: stringifyError(error) }); }
