import { onFoundryBoot } from '../core/foundry-boot-hooks.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  getSmallAnimatedWindowTexturePadding,
  isSmallAnimatedWindowDocument
} from './small-animated-window-texture.js';
import {
  initializeDoorMeshTransformPreview,
  syncPortalTextureFlipForMesh
} from './portal-texture-flip-runtime.js';
import {
  applySeamlessSecretDoorMeshPresentation,
  loadSeamlessSecretDoorTextureForDocument
} from './seamless-secret-door-runtime.js';
import {
  DoorSceneLifecycleOwner,
  getActiveDoorSceneId
} from './door-scene-lifecycle-owner.js';
import { getFaNexusTileCapabilities } from '../canvas/tile-capabilities.js';
import { isLayerHidden } from '../canvas/layer-hidden-state.js';
import { resolveFlattenedChunkEntries, resolveFlattenedChunkContainerTransform } from '../flatten/flatten-chunk-layout.js';

const MODULE_ID = 'fa-nexus';
const PROXY_REFRESH_HOOK = 'faNexusDoorVisualProxyRefresh';
const PROXY_SETTING = 'crossLevelDoorSightGating';
const VISIBILITY_ALPHA_THRESHOLD = 0.75;
const VISIBILITY_BLOCKER_ALPHA_RESOLUTION = 0.05;
const VISIBILITY_SAMPLE_COLUMNS = 7;
const VISIBILITY_SAMPLE_ROWS = 3;
const VISIBILITY_WALL_FACE_OFFSET = 1;

let _singleton = null;
const tileBlockerCache = new Map();

export function cleanupDoorVisualProxyTileBlockerCache(cache = tileBlockerCache) {
  const cleanupErrors = [];
  for (const [owner, { mesh } = {}] of Array.from(cache.entries())) {
    try {
      mesh?.destroy?.();
      cache.delete(owner);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, 'Door visual proxy tile-blocker cleanup failed.');
  }
}

function stringifyError(error) {
  const message = String(error?.message || error);
  if (!(error instanceof AggregateError)) return message;
  const details = Array.from(error.errors || []).map((entry) => stringifyError(entry));
  return details.length ? `${message}: ${details.join(' | ')}` : message;
}

export function resolveDoorVisualProxyFailureNotification(error, {
  wallId = '',
  previousSignature = ''
} = {}) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const detail = stringifyError(failure);
  const signature = `${String(wallId || '')}:${failure.name}:${detail}`;
  return {
    failure,
    signature,
    shouldNotify: signature !== String(previousSignature || ''),
    message: `FA Nexus could not render a cross-level Portal: ${detail}`
  };
}

export function cleanupDoorVisualProxyBuildResources({
  meshes = [],
  seamlessSurface = null,
  cause = null
} = {}) {
  const cleanupErrors = [];
  for (const mesh of new Set(Array.isArray(meshes) ? meshes.filter(Boolean) : [])) {
    try {
      mesh.parent?.removeChild?.(mesh);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (mesh.destroyed === false) mesh.destroy();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    seamlessSurface?.destroy?.();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cause && cleanupErrors.length) {
    throw new AggregateError(
      [cause, ...cleanupErrors],
      'Door visual proxy build and cleanup failed.'
    );
  }
  if (cause) throw cause;
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, 'Door visual proxy build cleanup failed.');
  }
}

export function cleanupDoorVisualProxyEntryResources(entry = {}) {
  return cleanupDoorVisualProxyBuildResources({
    meshes: entry?.meshes,
    seamlessSurface: entry?.seamlessSurface
  });
}

function getActiveSceneId() {
  return getActiveDoorSceneId();
}

function normalizeWallCoords(doc) {
  const coords = doc?.c || doc?._source?.c || doc?.data?.c || null;
  if (!Array.isArray(coords) || coords.length < 4) return null;
  const normalized = coords.slice(0, 4).map((value) => Number(value));
  return normalized.every(Number.isFinite) ? normalized : null;
}

function requireWallCoords(doc) {
  const coords = normalizeWallCoords(doc);
  if (!coords) throw new Error(`Animated wall ${doc?.id || '(unknown)'} has invalid coordinates.`);
  return coords;
}

function getDoorState(doc) {
  return Number(doc?.ds ?? doc?._source?.ds ?? doc?.data?.ds ?? 0);
}

function isOpenDoor(doc) {
  const states = globalThis?.CONST?.WALL_DOOR_STATES || {};
  return getDoorState(doc) === states.OPEN;
}

function isAnimatedDoorDocument(doc) {
  const doorTypes = globalThis?.CONST?.WALL_DOOR_TYPES || {};
  const doorType = Number(doc?.door ?? doc?._source?.door ?? doc?.data?.door ?? doorTypes.NONE ?? 0);
  if (!(doorType > (doorTypes.NONE ?? 0))) return false;
  const animation = doc?.animation || doc?._source?.animation || doc?.data?.animation || null;
  const type = typeof animation?.type === 'string' ? animation.type.trim() : '';
  const texture = typeof animation?.texture === 'string' ? animation.texture.trim() : '';
  return !!(type && texture);
}

function applySmallAnimatedWindowPadding(doc, mesh, texture, animation = {}) {
  if (!mesh || mesh.destroyed) return false;
  const padding = getSmallAnimatedWindowTexturePadding(texture || mesh.texture, isSmallAnimatedWindowDocument(doc));
  const current = Number(mesh.faNexusSmallWindowTexturePadding || 0);
  if (Math.abs(current - padding) < 0.001) return false;
  try {
    mesh.texturePadding = padding;
    mesh.faNexusSmallWindowTexturePadding = padding;
    if (typeof mesh.initialize === 'function') mesh.initialize(animation);
    Logger.debug?.('DoorVisualProxy.smallWindowPadding.applied', {
      wallId: doc?.id || null,
      padding
    });
    return true;
  } catch (error) {
    Logger.warn?.('DoorVisualProxy.smallWindowPadding.failed', {
      wallId: doc?.id || null,
      padding,
      error: stringifyError(error)
    });
    return false;
  }
}

function getDoorMeshClass() {
  const cls = globalThis?.foundry?.canvas?.containers?.DoorMesh;
  if (!cls) throw new Error('Foundry DoorMesh class is unavailable.');
  return cls;
}

function getLoadTexture() {
  const loadTexture = globalThis?.foundry?.canvas?.loadTexture;
  if (typeof loadTexture !== 'function') throw new Error('Foundry loadTexture function is unavailable.');
  return loadTexture;
}

function getRayClass() {
  const Ray = globalThis?.foundry?.canvas?.geometry?.Ray;
  if (!Ray) throw new Error('Foundry Ray class is unavailable.');
  return Ray;
}

function getLevelTextureConfig(scene, level) {
  const configs = scene?._configureLevelTextures?.() || [];
  return configs.find((config) => config?.level?.id === level?.id && config.name === 'foreground') || null;
}

function getLevelForegroundSort(level, foregroundConfig = null) {
  const rawSort = Number(foregroundConfig?.sort ?? level?.foreground?.sort ?? 0);
  return Number.isFinite(rawSort) ? rawSort : 0;
}

function isUpperForegroundLevel(scene, level, foregroundConfig = null) {
  if (typeof foregroundConfig?.isUpper === 'boolean') return foregroundConfig.isUpper;
  const viewedLevel = scene?._view ? scene?.levels?.get?.(scene._view) : null;
  if (!viewedLevel || !level || level.isView) return false;
  const levelTop = Number(level?.elevation?.top);
  const viewedBottom = Number(viewedLevel?.elevation?.bottom);
  return Number.isFinite(levelTop) && Number.isFinite(viewedBottom) && levelTop > viewedBottom;
}

function resolveLevelDoorRenderState(scene, level) {
  const foreground = getLevelTextureConfig(scene, level);
  const rawElevation = Number(foreground?.elevation ?? level?.elevation?.top);
  if (Number.isNaN(rawElevation)) throw new Error(`Level ${level?.id || '(unknown)'} has no usable foreground elevation.`);
  const elevation = rawElevation;
  const sortBase = getLevelForegroundSort(level, foreground);
  const occlusionMode = isUpperForegroundLevel(scene, level, foreground)
    ? (globalThis?.CONST?.OCCLUSION_MODES?.SURFACE ?? 0)
    : (globalThis?.CONST?.OCCLUSION_MODES?.NONE ?? 0);
  return { elevation, sort: sortBase - 1, occlusionMode };
}

function getTileBlockerGeometry(doc, chunks) {
  const shape = doc?.shape;
  const config = doc?.texture;
  const signature = [config?.src, shape?.x, shape?.y, shape?.width, shape?.height, shape?.rotation,
    shape?.anchorX, shape?.anchorY, config?.fit, config?.scaleX, config?.scaleY, chunks.length > 0].join('|');
  const cached = tileBlockerCache.get(doc);
  if (cached?.signature === signature && !cached.mesh?.destroyed) return cached;
  cached?.mesh?.destroy?.();
  if (chunks.length) {
    // Match the renderer's one-pixel carrier transform without allocating a
    // display mesh or treating any one chunk as the complete floor image.
    const transform = new PIXI.Transform();
    transform.position.set(shape.x, shape.y);
    transform.scale.set(shape.width * (Number(config.scaleX) || 1), shape.height * (Number(config.scaleY) || 1));
    transform.rotation = Number(shape.rotation) * Math.PI / 180;
    transform.updateLocalTransform();
    const placement = resolveFlattenedChunkContainerTransform(transform, doc);
    const canvasTransform = transform.localTransform.clone();
    if (canvas.primary.canvasTransform) canvasTransform.prepend(canvas.primary.canvasTransform);
    const geometry = { signature, canvasTransform,
      chunkTransform: new PIXI.Matrix(placement.scaleX, 0, 0, placement.scaleY, placement.x, placement.y) };
    tileBlockerCache.set(doc, geometry);
    return geometry;
  }
  const texture = globalThis?.foundry?.canvas?.getTexture?.(config?.src);
  const Mesh = globalThis?.foundry?.canvas?.primary?.PrimarySpriteMesh;
  const TextureLoader = globalThis?.foundry?.canvas?.TextureLoader;
  if (!texture?.valid || !Mesh || !TextureLoader) {
    throw new Error(`Opaque tile ${doc?.id || '(unknown)'} has no cached texture mesh.`);
  }
  const mesh = new Mesh({ name: `fa-nexus-door-visibility-blocker:${doc.id}`, texture, object: null });
  mesh._textureAlphaData = TextureLoader.getTextureAlphaData(texture, VISIBILITY_BLOCKER_ALPHA_RESOLUTION);
  mesh.position.set(shape.x, shape.y);
  mesh.resize(shape.width, shape.height, { fit: config.fit, scaleX: config.scaleX, scaleY: config.scaleY });
  mesh.anchor.set(shape.anchorX, shape.anchorY);
  mesh.angle = shape.rotation;
  canvas.primary.addChild(mesh);
  try {
    mesh.updateCanvasTransform();
  } finally {
    canvas.primary.removeChild(mesh);
  }
  const geometry = { signature, mesh };
  tileBlockerCache.set(doc, geometry);
  return geometry;
}

function tileBlockerContainsPoint({ doc, chunks }, point) {
  const { mesh, canvasTransform, chunkTransform } = getTileBlockerGeometry(doc, chunks);
  if (!chunks.length) return mesh.containsCanvasPoint(point, VISIBILITY_ALPHA_THRESHOLD);
  const local = chunkTransform.applyInverse(canvasTransform.applyInverse(point));
  for (const chunk of chunks) {
    const x = (local.x - chunk.x) / chunk.width;
    const y = (local.y - chunk.y) / chunk.height;
    if (x < 0 || x >= 1 || y < 0 || y >= 1) continue;
    const texture = foundry.canvas.getTexture(chunk.src);
    if (!texture?.valid) throw new Error(`Opaque flattened tile ${doc.id} has an unloaded chunk: ${chunk.src}`);
    const alpha = foundry.canvas.TextureLoader.getTextureAlphaData(texture, VISIBILITY_BLOCKER_ALPHA_RESOLUTION);
    const pixelX = Math.floor(x * alpha.width), pixelY = Math.floor(y * alpha.height);
    if (pixelX < alpha.minX || pixelX >= alpha.maxX || pixelY < alpha.minY || pixelY >= alpha.maxY) continue;
    const index = (pixelY - alpha.minY) * (alpha.maxX - alpha.minX) + pixelX - alpha.minX;
    if (alpha.data[index] / 255 >= VISIBILITY_ALPHA_THRESHOLD) return true;
  }
  return false;
}

function getOpaqueVisibilityBlockers() {
  const blockers = [];
  for (const doc of canvas?.scene?.tiles || []) {
    if (doc?.hidden || isLayerHidden(doc) || Number(doc?.alpha) < 1 || !doc?.levels?.size) continue;
    const chunks = resolveFlattenedChunkEntries(doc.flags?.[MODULE_ID]?.flattened);
    const capabilities = getFaNexusTileCapabilities(doc);
    if (capabilities.isCustomRendered
      && !(chunks.length && capabilities.customRenderFeatures.every((feature) => feature === 'runtimeOverlay'))) continue;
    const area = Number(doc?.shape?.width) * Number(doc?.shape?.height);
    if (!Number.isFinite(area)) throw new Error(`Opaque tile ${doc?.id || '(unknown)'} has invalid geometry.`);
    for (const levelId of doc.levels) {
      const elevation = Number(canvas.scene.levels.get(levelId)?.elevation?.base);
      if (!Number.isFinite(elevation) || Number(doc.elevation) !== elevation) continue;
      blockers.push({ doc, elevation, area, chunks });
    }
  }
  // ponytail: test broad floor plates first so common fully-covered points short-circuit before detail tiles.
  return blockers.sort((a, b) => b.area - a.area);
}

async function prepareVisibilityBlockerTextures() {
  const sources = new Set(getOpaqueVisibilityBlockers().flatMap(({ doc, chunks }) => chunks.length ? chunks.map(chunk => chunk.src) : [doc.texture.src]));
  const loadTexture = getLoadTexture();
  await Promise.all(Array.from(sources, async (src) => {
    const texture = await loadTexture(src);
    if (!texture?.valid) throw new Error(`Failed to load portal visibility blocker texture: ${src}`);
  }));
}

function getOpaqueDoorSamplePoints(entry) {
  const points = [];
  const localPoint = { x: 0, y: 0 };
  const canvasPoint = { x: 0, y: 0 };
  for (const mesh of entry?.meshes || []) {
    if (!mesh || mesh.destroyed) continue;
    if (typeof mesh.containsCanvasPoint !== 'function' || typeof mesh.canvasTransform?.apply !== 'function') {
      throw new Error('Door proxy mesh has no usable alpha geometry.');
    }
    const texture = mesh.texture;
    const original = texture?.orig;
    const sampleBounds = texture?.trim || original;
    if (!original || !sampleBounds) throw new Error('Door proxy mesh has no usable texture bounds.');
    mesh.updateCanvasTransform?.();
    const x0 = Number(sampleBounds.x) - (Number(mesh.anchor?.x) * Number(original.width));
    const y0 = Number(sampleBounds.y) - (Number(mesh.anchor?.y) * Number(original.height));
    // ponytail: 7x3 bounds sight-refresh cost; use adaptive edge sampling if narrow visible slivers prove common.
    for (let column = 0; column < VISIBILITY_SAMPLE_COLUMNS; column += 1) {
      localPoint.x = x0 + (Number(sampleBounds.width) * (column + 0.5) / VISIBILITY_SAMPLE_COLUMNS);
      for (let row = 0; row < VISIBILITY_SAMPLE_ROWS; row += 1) {
        localPoint.y = y0 + (Number(sampleBounds.height) * (row + 0.5) / VISIBILITY_SAMPLE_ROWS);
        mesh.canvasTransform.apply(localPoint, canvasPoint);
        if (!mesh.containsCanvasPoint(canvasPoint, VISIBILITY_ALPHA_THRESHOLD)) continue;
        points.push({ x: canvasPoint.x, y: canvasPoint.y });
      }
    }
  }
  return points;
}

function getDoorVisibilityElevation(level) {
  const base = Number(level?.elevation?.base);
  const top = Number(level?.elevation?.top);
  if (!Number.isFinite(base)) {
    throw new Error(`Level ${level?.id || '(unknown)'} has no usable visibility elevation.`);
  }
  const fallbackHeight = Number(canvas?.grid?.distance) || 1;
  return Number.isFinite(top) ? top : base + fallbackHeight;
}

function createDoorVisibilityConfig(points, level, elevation) {
  return {
    object: null,
    level,
    tests: points.map(({ x, y }) => ({ point: { x, y, elevation }, level, los: new Map() }))
  };
}

function offsetSightPointsTowardSource(points, visionSource) {
  const sourceX = Number(visionSource?.origin?.x);
  const sourceY = Number(visionSource?.origin?.y);
  if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY)) {
    throw new Error('Active vision source has no usable position.');
  }
  return points.map((point) => {
    const dx = sourceX - point.x;
    const dy = sourceY - point.y;
    const distance = Math.hypot(dx, dy);
    if (!(distance > VISIBILITY_WALL_FACE_OFFSET)) return point;
    const scale = VISIBILITY_WALL_FACE_OFFSET / distance;
    return { x: point.x + (dx * scale), y: point.y + (dy * scale) };
  });
}

class DoorVisualProxyWall {
  constructor(doc, level) {
    this.document = doc;
    this.level = level;
    this.id = `${doc?.id || 'unknown'}:${level?.id || 'unknown'}`;
  }

  get isOpen() {
    return isOpenDoor(this.document);
  }

  get midpoint() {
    const coords = requireWallCoords(this.document);
    return [(coords[0] + coords[2]) / 2, (coords[1] + coords[3]) / 2];
  }

  get center() {
    const [x, y] = this.midpoint;
    return new PIXI.Point(x, y);
  }

  get edge() {
    const edge = this.document?.edge;
    if (edge?.a && edge?.b) return edge;
    const coords = requireWallCoords(this.document);
    return {
      a: { x: coords[0], y: coords[1] },
      b: { x: coords[2], y: coords[3] }
    };
  }

  toRay() {
    const Ray = getRayClass();
    const coords = requireWallCoords(this.document);
    return Ray.fromArrays(coords.slice(0, 2), coords.slice(2, 4));
  }
}

export class DoorVisualProxyManager {
  constructor() {
    if (_singleton) return _singleton;
    this._entries = new Map();
    this._lifecycle = new DoorSceneLifecycleOwner({
      logger: Logger,
      foreignLogKey: 'DoorVisualProxy.foreignSceneDocument.ignored'
    });
    this._hooksBound = false;
    this._readyRan = false;
    this._enabled = globalThis.game.settings.get(MODULE_ID, PROXY_SETTING) !== false;
    this._transformPreviewSuppressionCounts = new Map();
    this._transformPreviewDynamicStates = new Map();
    this._buildFailureNotificationSignatures = new Map();
    this._settingFailureNotificationSignature = '';
    this._tileBlockerCache = tileBlockerCache;
    this._bindHooks();
    this._ensureLifecycleCatchup();
    _singleton = this;
  }

  static getInstance() {
    return _singleton ?? new DoorVisualProxyManager();
  }

  static peek() {
    return _singleton;
  }

  getDoorMeshes(wallId) {
    const id = String(wallId || '');
    if (!id) return [];
    const meshes = [];
    for (const entry of this._entries.values()) {
      if (entry.wallId !== id) continue;
      for (const mesh of entry.meshes || []) {
        if (mesh && !mesh.destroyed) meshes.push(mesh);
      }
    }
    return meshes;
  }

  syncDoorTransformPreview(doc) {
    const wallId = String(doc?.id || '').trim();
    if (!wallId) return false;
    let changed = false;
    for (const entry of this._entries.values()) {
      if (entry.wallId !== wallId) continue;
      entry.doc = doc;
      entry.proxy.document = doc;
      for (const mesh of entry.meshes || []) {
        if (!mesh || mesh.destroyed) continue;
        initializeDoorMeshTransformPreview(doc, mesh);
        if (entry.seamlessSurface) {
          const plan = doc.flags?.[MODULE_ID]?.buildingSeamlessSecretDoor?.surfacePlan;
          applySeamlessSecretDoorMeshPresentation(
            mesh,
            plan || entry.seamlessSurface.presentationPlan,
            plan?.visualOffset || entry.seamlessSurface.meshOffset
          );
        }
        syncPortalTextureFlipForMesh(doc, mesh, { reason: 'transformPreview' });
        this._retargetMesh(mesh, entry.level);
        changed = true;
      }
    }
    return changed;
  }

  setDoorTransformPreviewSuppressed(wallId, suppressed) {
    const id = String(wallId || '').trim();
    if (!id) return;
    const current = this._transformPreviewSuppressionCounts.get(id) || 0;
    const next = suppressed ? current + 1 : Math.max(0, current - 1);
    if (next) this._transformPreviewSuppressionCounts.set(id, next);
    else this._transformPreviewSuppressionCounts.delete(id);
    if (next) {
      for (const mesh of this.getDoorMeshes(id)) this._suppressDynamicPreviewMesh(id, mesh);
      return;
    }
    for (const [mesh, state] of Array.from(this._transformPreviewDynamicStates)) {
      if (state.wallId !== id) continue;
      this._transformPreviewDynamicStates.delete(mesh);
      if (!mesh || mesh.destroyed) continue;
      mesh.visible = state.visible;
      mesh.renderable = state.renderable;
    }
  }

  _suppressDynamicPreviewMesh(wallId, mesh) {
    if (!mesh || mesh.destroyed) return;
    // Existing targets were already captured by the door-runtime controller
    // before the manager hold was activated. Only manager-created replacement
    // meshes still expose a renderable state here and need their own snapshot.
    if (!this._transformPreviewDynamicStates.has(mesh)
      && (mesh.visible !== false || mesh.renderable !== false)) {
      this._transformPreviewDynamicStates.set(mesh, {
        wallId,
        visible: mesh.visible,
        renderable: mesh.renderable
      });
    }
    mesh.visible = false;
    mesh.renderable = false;
  }

  isDoorVisualReady(wallId, document = null) {
    const id = String(wallId || '').trim();
    if (!id) return false;
    if (!this._enabled) return true;
    const doc = document || canvas?.scene?.walls?.get?.(id) || null;
    if (!doc) return false;
    const expectedLevels = this._getProxySourceLevels(doc);
    for (const level of expectedLevels) {
      const key = this._entryKey(id, level?.id);
      if (this._lifecycle.hasPendingBuild(key)) return false;
      const entry = this._entries.get(key);
      const meshes = Array.from(entry?.meshes || []).filter((mesh) => mesh && !mesh.destroyed);
      if (!meshes.length) return false;
    }
    return true;
  }

  getProxyDocuments() {
    const docs = new Map();
    for (const entry of this._entries.values()) {
      if (entry.doc?.id) docs.set(entry.doc.id, entry.doc);
    }
    return Array.from(docs.values());
  }

  _bindHooks() {
    if (this._hooksBound) return;
    this._hooksBound = true;
    try { Hooks.on('canvasReady', () => this._onCanvasReady()); } catch (error) { Logger.error?.('DoorVisualProxy.hook.canvasReady.failed', { error: stringifyError(error) }); }
    try { Hooks.on('canvasTearDown', () => this._onCanvasTearDown()); } catch (error) { Logger.error?.('DoorVisualProxy.hook.canvasTearDown.failed', { error: stringifyError(error) }); }
    try { Hooks.on('createWall', (doc) => this._onCreateWall(doc)); } catch (error) { Logger.error?.('DoorVisualProxy.hook.createWall.failed', { error: stringifyError(error) }); }
    try { Hooks.on('updateWall', (doc, diff) => this._onUpdateWall(doc, diff)); } catch (error) { Logger.error?.('DoorVisualProxy.hook.updateWall.failed', { error: stringifyError(error) }); }
    try { Hooks.on('deleteWall', (doc) => this._onDeleteWall(doc)); } catch (error) { Logger.error?.('DoorVisualProxy.hook.deleteWall.failed', { error: stringifyError(error) }); }
    for (const hook of ['createTile', 'updateTile', 'deleteTile']) {
      Hooks.on(hook, (doc) => { void this._onVisibilityBlockerChange(doc); });
    }
    try { Hooks.on('sightRefresh', () => this._refreshVisibility()); } catch (error) { Logger.error?.('DoorVisualProxy.hook.sightRefresh.failed', { error: stringifyError(error) }); }
    try {
      Hooks.on('fa-nexus-cross-level-door-proxies-changed', ({ enabled }) => {
        this._applyEnabledState(enabled);
      });
    } catch (error) { Logger.error?.('DoorVisualProxy.hook.proxySetting.failed', { error: stringifyError(error) }); }
    try { Hooks.on('createLevel', () => this._rebuildScene('level.create')); } catch (error) { Logger.error?.('DoorVisualProxy.hook.createLevel.failed', { error: stringifyError(error) }); }
    try { Hooks.on('updateLevel', () => this._rebuildScene('level.update')); } catch (error) { Logger.error?.('DoorVisualProxy.hook.updateLevel.failed', { error: stringifyError(error) }); }
    try { Hooks.on('deleteLevel', () => this._rebuildScene('level.delete')); } catch (error) { Logger.error?.('DoorVisualProxy.hook.deleteLevel.failed', { error: stringifyError(error) }); }
    // Last, so that a manager created after ready (a late-loaded module) runs its ready step with every hook bound.
    try { onFoundryBoot('ready', () => this._onReady()); } catch (error) { Logger.error?.('DoorVisualProxy.hook.ready.failed', { error: stringifyError(error) }); }
  }

  _ensureLifecycleCatchup() {
    try {
      const alreadyReady = this._readyRan || game?.ready === true || game?.application?.ready === true;
      if (alreadyReady) {
        this._onReady();
        return;
      }
      if (canvas?.ready) this._onCanvasReady();
    } catch (error) {
      Logger.error?.('DoorVisualProxy.lifecycle.catchup.failed', { error: stringifyError(error) });
    }
  }

  _onReady() {
    this._readyRan = true;
    this._onCanvasReady();
  }

  _onCanvasReady() {
    this._lifecycle.beginCanvasReady();
    this._clearAll({ notify: false });
    if (!canvas?.ready || !canvas?.scene) return;
    this._rebuildScene('canvas.ready');
  }

  _onCanvasTearDown() {
    const previousSceneId = this._lifecycle.beginCanvasTearDown();
    this._clearAll({ notify: true });
    Logger.debug?.('DoorVisualProxy.canvasTearDown.cleared', { sceneId: previousSceneId });
  }

  _applyEnabledState(enabled) {
    const nextEnabled = enabled === true;
    this._enabled = false;
    try {
      this._clearAll({ notify: true });
    } catch (error) {
      const notification = resolveDoorVisualProxyFailureNotification(error, {
        wallId: PROXY_SETTING,
        previousSignature: this._settingFailureNotificationSignature
      });
      if (notification.shouldNotify) {
        this._settingFailureNotificationSignature = notification.signature;
        globalThis.ui?.notifications?.error?.(notification.message);
      }
      throw error;
    }
    this._settingFailureNotificationSignature = '';
    if (!nextEnabled) return;
    this._enabled = true;
    this._rebuildScene('setting.enabled');
  }

  _onCreateWall(doc) {
    if (!this._enabled || !canvas?.ready || !this._isActiveSceneDocument(doc, { phase: 'createWall' })) return;
    this._refreshWall(doc, { force: true, reason: 'wall.create' });
  }

  _onUpdateWall(doc, diff = {}) {
    if (!this._enabled || !doc || !canvas?.ready || !this._isActiveSceneDocument(doc, { phase: 'updateWall' })) return;
    if (this._wallUpdateRequiresRebuild(diff)) {
      this._refreshWall(doc, { force: true, reason: 'wall.update' });
      return;
    }
    if ('ds' in (diff || {})) this._animateWall(doc);
  }

  _onDeleteWall(doc) {
    if (!this._enabled || !doc?.id || !this._isActiveSceneDocument(doc, { phase: 'deleteWall' })) return;
    this._removeWallEntries(doc.id, { notify: true, doc });
  }

  async _onVisibilityBlockerChange(doc) {
    if (!this._enabled || !canvas?.ready || !this._entries.size
      || !this._isActiveSceneDocument(doc, { phase: 'visibilityBlockerChange', log: false })) return;
    const generation = this._lifecycle.sceneGeneration;
    const sceneId = this._lifecycle.sceneId;
    try {
      await prepareVisibilityBlockerTextures();
      if (this._isCurrentSceneScope(generation, sceneId)) this._refreshVisibility();
    } catch (error) {
      if (!this._isCurrentSceneScope(generation, sceneId)) return;
      Logger.error?.('DoorVisualProxy.visibilityBlockerChange.failed', { tileId: doc.id, error: stringifyError(error) });
      globalThis.ui?.notifications?.error?.(`FA Nexus could not refresh cross-level Portal visibility: ${stringifyError(error)}`);
    }
  }

  _isActiveSceneDocument(doc, { phase = 'unknown' } = {}) {
    return this._lifecycle.isActiveSceneDocument(doc, { phase });
  }

  _wallUpdateRequiresRebuild(diff = {}) {
    if (!diff || typeof diff !== 'object') return false;
    const coreFlags = diff.flags?.core || {};
    const faFlags = diff.flags?.[MODULE_ID] || {};
    return ('c' in diff)
      || ('levels' in diff)
      || ('door' in diff)
      || ('animation' in diff)
      || Object.prototype.hasOwnProperty.call(coreFlags, 'textureGridSize')
      || Object.prototype.hasOwnProperty.call(faFlags, 'buildingDoor')
      || Object.prototype.hasOwnProperty.call(faFlags, 'buildingWindow')
      || Object.prototype.hasOwnProperty.call(faFlags, 'buildingSeamlessSecretDoor');
  }

  _rebuildScene(reason) {
    if (!this._enabled || !canvas?.ready || !canvas?.scene) return;
    const walls = canvas.scene.walls || [];
    Logger.debug?.('DoorVisualProxy.scene.rebuild', {
      reason,
      sceneId: this._lifecycle.sceneId || getActiveSceneId(),
      walls: walls.size ?? walls.length ?? null
    });
    for (const doc of walls) this._refreshWall(doc, { force: false, reason });
  }

  _refreshWall(doc, { force = false, reason = 'refresh' } = {}) {
    const wallId = doc?.id ? String(doc.id) : '';
    if (!wallId || !canvas?.ready) return;
    if (!this._isActiveSceneDocument(doc, { phase: reason })) return;
    if (force) this._removeWallEntries(wallId, { notify: false, doc });

    const sourceLevels = this._getProxySourceLevels(doc);
    if (!sourceLevels.length) {
      this._removeWallEntries(wallId, { notify: true, doc });
      return;
    }

    const wantedKeys = new Set(sourceLevels.map((level) => this._entryKey(wallId, level.id)));
    let removedStale = false;
    for (const key of Array.from(this._entries.keys())) {
      const entry = this._entries.get(key);
      if (entry?.wallId === wallId && !wantedKeys.has(key)) {
        this._removeEntry(key, { notify: false });
        removedStale = true;
      }
    }
    if (removedStale) this._notifyProxyRefresh(doc, 'removeStale');

    for (const level of sourceLevels) {
      const key = this._entryKey(wallId, level.id);
      if (this._entries.has(key) && !force) {
        const entry = this._entries.get(key);
        entry.doc = doc;
        entry.proxy.document = doc;
        entry.level = level;
        this._retargetEntry(entry);
        this._refreshEntryVisibility(entry);
        continue;
      }
      if (this._lifecycle.hasPendingBuild(key)) continue;
      const pending = this._lifecycle.createPendingBuild(key, { key });
      pending.promise = this._buildEntry(doc, level, {
        key,
        generation: pending.generation,
        sceneId: pending.sceneId,
        pending
      });
      pending.promise.finally(() => {
        this._lifecycle.settlePendingBuild(key, pending);
      });
    }
  }

  _getProxySourceLevels(doc) {
    if (!isAnimatedDoorDocument(doc)) return [];
    if (doc?.viewed) return [];
    const scene = canvas?.scene;
    if (!scene?._view || !scene?.levels) return [];
    const levels = doc?.levels;
    if (!levels?.size) return [];
    const result = [];
    for (const levelId of levels) {
      const level = scene.levels.get?.(levelId);
      if (!level || level.isView || !level.isVisible) continue;
      result.push(level);
    }
    return result;
  }

  async _buildEntry(doc, level, { key, generation, sceneId, pending = null } = {}) {
    if (!this._isCurrentSceneScope(generation, sceneId)) return;
    const wallId = String(doc?.id || '');
    if (!wallId || !level?.id) return;

    let seamlessSurface = null;
    const meshes = [];
    try {
      const DoorMesh = getDoorMeshClass();
      const loadTexture = getLoadTexture();
      const animation = { ...(doc?.animation || {}) };
      const textureSrc = typeof animation.texture === 'string' ? animation.texture.trim() : '';
      if (!textureSrc) throw new Error('Animated wall has no animation.texture.');
      delete animation.texture;
      requireWallCoords(doc);

      seamlessSurface = await loadSeamlessSecretDoorTextureForDocument(doc);
      const texture = seamlessSurface?.texture || await loadTexture(textureSrc);
      if (!texture) throw new Error(`Failed to load door texture: ${textureSrc}`);
      // Off-Level floor Tiles may never receive a native mesh. Their alpha
      // geometry still gates sight to this proxy, so prepare it through the
      // same Foundry texture cache before publishing a ready Door visual.
      await prepareVisibilityBlockerTextures();
      if (!this._isCurrentSceneScope(generation, sceneId)) {
        cleanupDoorVisualProxyBuildResources({ meshes, seamlessSurface });
        return;
      }
      if (pending?.cancelled || this._lifecycle.getPendingBuild(key) !== pending) {
        cleanupDoorVisualProxyBuildResources({ meshes, seamlessSurface });
        return;
      }

      const proxy = new DoorVisualProxyWall(doc, level);
      const styles = [animation.double ? DoorMesh.DOOR_STYLES.DOUBLE_LEFT : DoorMesh.DOOR_STYLES.SINGLE];
      if (animation.double) styles.push(DoorMesh.DOOR_STYLES.DOUBLE_RIGHT);

      for (const style of styles) {
        const meshTexture = seamlessSurface?.textureForStyle?.(style, DoorMesh) || texture;
        const mesh = new DoorMesh({ object: proxy, texture: meshTexture, style, ...animation });
        meshes.push(mesh);
        if (seamlessSurface) {
          applySeamlessSecretDoorMeshPresentation(mesh, seamlessSurface.presentationPlan, seamlessSurface.meshOffset);
        }
        syncPortalTextureFlipForMesh(doc, mesh, { reason: 'doorVisualProxyBuild' });
        applySmallAnimatedWindowPadding(doc, mesh, texture, { style, ...animation });
        mesh.name = `fa-nexus-door-visual-proxy:${wallId}:${level.id}:${style}`;
        mesh.eventMode = 'none';
        mesh.faNexusDoorVisualProxy = true;
        mesh.faNexusSourceWallId = wallId;
        mesh.faNexusSourceLevelId = level.id;
        this._retargetMesh(mesh, level);
        canvas.primary.addChild(mesh);
        if (seamlessSurface) mesh.faNexusSeamlessSecretDoorSurface = seamlessSurface;
      }

      if (pending?.cancelled || this._lifecycle.getPendingBuild(key) !== pending) {
        cleanupDoorVisualProxyBuildResources({ meshes, seamlessSurface });
        return;
      }
      this._entries.set(key, { key, wallId, doc, level, proxy, meshes, seamlessSurface });
      this._buildFailureNotificationSignatures.delete(key);
      this._refreshEntryVisibility(this._entries.get(key));
      this._notifyProxyRefresh(doc, 'build');
      Logger.debug?.('DoorVisualProxy.entry.built', { wallId, levelId: level.id, meshes: meshes.length });
    } catch (error) {
      let visibleError = error;
      try {
        cleanupDoorVisualProxyBuildResources({ meshes, seamlessSurface, cause: error });
      } catch (cleanupError) {
        visibleError = cleanupError;
      }
      const existing = this._entries.get(key);
      if (existing?.meshes === meshes) this._entries.delete(key);
      Logger.error?.('DoorVisualProxy.entry.buildFailed', {
        wallId,
        levelId: level?.id || null,
        error: stringifyError(visibleError)
      });
      const notification = resolveDoorVisualProxyFailureNotification(visibleError, {
        wallId,
        previousSignature: this._buildFailureNotificationSignatures.get(key) || ''
      });
      if (notification.shouldNotify) {
        this._buildFailureNotificationSignatures.set(key, notification.signature);
        globalThis.ui?.notifications?.error?.(notification.message);
      }
      this._notifyProxyRefresh(doc, 'buildFailed');
    }
  }

  _isCurrentSceneScope(generation = this._lifecycle.sceneGeneration, sceneId = this._lifecycle.sceneId || getActiveSceneId()) {
    return this._lifecycle.isCurrentSceneScope(generation, sceneId);
  }

  _entryKey(wallId, levelId) {
    return `${wallId}:${levelId}`;
  }

  _retargetEntry(entry) {
    if (!entry?.meshes?.length || !entry.level) return;
    for (const mesh of entry.meshes) {
      try {
        this._retargetMesh(mesh, entry.level);
      } catch (error) {
        Logger.error?.('DoorVisualProxy.retarget.failed', {
          wallId: entry.wallId || null,
          levelId: entry.level?.id || null,
          error: stringifyError(error)
        });
      }
    }
  }

  _retargetMesh(mesh, level) {
    if (!mesh || mesh.destroyed || !level) return;
    const { elevation, sort, occlusionMode } = resolveLevelDoorRenderState(canvas?.scene, level);
    if (mesh._closedPosition) {
      mesh._closedPosition.elevation = elevation;
      mesh._closedPosition.sort = sort;
    }
    if (mesh._animatedPosition) {
      mesh._animatedPosition.elevation = elevation;
      mesh._animatedPosition.sort = sort;
    }
    mesh.elevation = elevation;
    mesh.sort = sort;
    mesh.occlusionMode = occlusionMode;
    mesh.unoccludedAlpha = 1;
    mesh.occludedAlpha = 0;
    mesh.hoverFade = false;
    mesh.sortLayer = globalThis?.foundry?.canvas?.groups?.PrimaryCanvasGroup?.SORT_LAYERS?.SCENE ?? 0;
    mesh.zIndex = Number.isFinite(mesh.zIndex) ? mesh.zIndex : 0;
  }

  _refreshVisibility() {
    if (!this._enabled) return;
    const hasActiveVision = Array.from(canvas?.effects?.visionSources || []).some((source) => source?.active);
    const blockers = hasActiveVision ? getOpaqueVisibilityBlockers() : null;
    for (const entry of this._entries.values()) this._refreshEntryVisibility(entry, blockers);
  }

  _refreshEntryVisibility(entry, blockers = null) {
    let visible = false;
    try {
      visible = this._isEntryVisible(entry, blockers);
    } catch (error) {
      Logger.error?.('DoorVisualProxy.visibility.failed', {
        wallId: entry?.wallId || null,
        levelId: entry?.level?.id || null,
        error: stringifyError(error)
      });
    }
    for (const mesh of entry?.meshes || []) {
      if (!mesh || mesh.destroyed) continue;
      if (this._transformPreviewSuppressionCounts.has(entry?.wallId)) {
        this._suppressDynamicPreviewMesh(entry.wallId, mesh);
      } else {
        mesh.visible = visible;
      }
    }
  }

  _isEntryVisible(entry, blockers) {
    if (!canvas?.visibility?.tokenVision) return false;
    const visionSources = Array.from(canvas?.effects?.visionSources || []).filter((source) => source?.active);
    if (!visionSources.length) return false;
    const detectionModes = globalThis?.CONFIG?.Canvas?.detectionModes;
    if (!detectionModes?.basicSight || !detectionModes?.lightPerception) {
      throw new Error('Foundry detection modes are unavailable.');
    }
    blockers ??= getOpaqueVisibilityBlockers();
    const points = getOpaqueDoorSamplePoints(entry);
    if (!points.length) return false;
    const targetElevation = getDoorVisibilityElevation(entry?.level);
    for (const visionSource of visionSources) {
      if (visionSource.isBlinded) continue;
      const modes = visionSource?.object?.document?.detectionModes;
      if (!modes) throw new Error('Active vision source has no detection modes.');
      const sourceElevation = Number(visionSource?.origin?.elevation);
      if (!Number.isFinite(sourceElevation)) throw new Error('Active vision source has no usable elevation.');
      const lowerElevation = Math.min(sourceElevation, targetElevation);
      const upperElevation = Math.max(sourceElevation, targetElevation);
      const coveringBlockers = blockers.filter(({ elevation }) => (
        elevation >= lowerElevation && elevation < upperElevation
      ));
      const uncoveredPoints = points.filter((point) => !coveringBlockers.some((blocker) => (
        tileBlockerContainsPoint(blocker, point)
      )));
      if (!uncoveredPoints.length) continue;
      // Closed door pixels sit on their blocking wall edge. Test the near face so Foundry does not
      // reject a visible door merely because the target is the wall's mathematical centerline.
      const sightPoints = offsetSightPointsTowardSource(uncoveredPoints, visionSource);
      const config = createDoorVisibilityConfig(sightPoints, entry?.level, targetElevation);
      if (modes.basicSight && detectionModes.basicSight.testVisibility(visionSource, modes.basicSight, config)) return true;
      if (modes.lightPerception
        && detectionModes.lightPerception.testVisibility(visionSource, modes.lightPerception, config)) return true;
    }
    return false;
  }

  _animateWall(doc) {
    const wallId = String(doc?.id || '');
    if (!wallId) return;
    const open = isOpenDoor(doc);
    for (const entry of this._entries.values()) {
      if (entry.wallId !== wallId) continue;
      entry.doc = doc;
      entry.proxy.document = doc;
      const animations = [];
      for (const mesh of entry.meshes || []) {
        if (!mesh || mesh.destroyed) continue;
        try {
          animations.push(mesh.animate(open));
        } catch (error) {
          Logger.error?.('DoorVisualProxy.animate.failed', {
            wallId,
            levelId: entry.level?.id || null,
            error: stringifyError(error)
          });
        }
      }
      Promise.all(animations).then(() => this._refreshEntryVisibility(entry)).catch((error) => {
        Logger.error?.('DoorVisualProxy.animate.failed', {
          wallId,
          levelId: entry.level?.id || null,
          error: stringifyError(error)
        });
      });
    }
  }

  _removeWallEntries(wallId, { notify = false, doc = null } = {}) {
    const id = String(wallId || '');
    if (!id) return;
    let removed = false;
    const cleanupErrors = [];
    for (const key of Array.from(this._entries.keys())) {
      const entry = this._entries.get(key);
      if (entry?.wallId !== id) continue;
      try {
        this._removeEntry(key, { notify: false });
        removed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    this._lifecycle.cancelPendingBuildsWhere((key) => key.startsWith(`${id}:`));
    for (const key of Array.from(this._buildFailureNotificationSignatures.keys())) {
      if (key.startsWith(`${id}:`) && !this._entries.has(key)) {
        this._buildFailureNotificationSignatures.delete(key);
      }
    }
    if (notify && (removed || doc)) this._notifyProxyRefresh(doc, 'remove');
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, `Cross-level Door visual proxy cleanup failed for Wall ${id}.`);
    }
  }

  _removeEntry(key, { notify = false } = {}) {
    const entry = this._entries.get(key);
    if (!entry) return;
    for (const mesh of entry.meshes || []) {
      this._transformPreviewDynamicStates.delete(mesh);
    }
    try {
      cleanupDoorVisualProxyEntryResources(entry);
    } catch (error) {
      Logger.error?.('DoorVisualProxy.entry.cleanupFailed', { key, error: stringifyError(error) });
      const notification = resolveDoorVisualProxyFailureNotification(error, {
        wallId: entry.wallId,
        previousSignature: this._buildFailureNotificationSignatures.get(key) || ''
      });
      if (notification.shouldNotify) {
        this._buildFailureNotificationSignatures.set(key, notification.signature);
        globalThis.ui?.notifications?.error?.(notification.message);
      }
      throw error;
    }
    this._entries.delete(key);
    this._buildFailureNotificationSignatures.delete(key);
    if (notify) this._notifyProxyRefresh(entry.doc, 'remove');
  }

  _clearAll({ notify = false } = {}) {
    this._lifecycle.cancelAllPendingBuilds();
    const cleanupErrors = [];
    try {
      cleanupDoorVisualProxyTileBlockerCache(this._tileBlockerCache);
    } catch (error) {
      cleanupErrors.push(error);
    }
    const docs = new Map();
    for (const entry of this._entries.values()) {
      if (entry.doc?.id) docs.set(entry.doc.id, entry.doc);
    }
    for (const key of Array.from(this._entries.keys())) {
      try {
        this._removeEntry(key, { notify: false });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    this._transformPreviewSuppressionCounts.clear();
    this._transformPreviewDynamicStates.clear();
    for (const key of Array.from(this._buildFailureNotificationSignatures.keys())) {
      if (!this._entries.has(key)) this._buildFailureNotificationSignatures.delete(key);
    }
    if (notify) {
      for (const doc of docs.values()) this._notifyProxyRefresh(doc, 'clear');
    }
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, 'Cross-level Door visual proxy cleanup failed.');
    }
  }

  _notifyProxyRefresh(doc, reason) {
    if (!doc?.id) return;
    try { Hooks.callAll(PROXY_REFRESH_HOOK, doc, { reason, moduleId: MODULE_ID }); }
    catch (error) { Logger.warn?.('DoorVisualProxy.refreshHook.failed', { wallId: doc.id, error: stringifyError(error) }); }
  }
}

try {
  onFoundryBoot('ready', () => {
    try { DoorVisualProxyManager.getInstance(); }
    catch (error) { Logger.error?.('DoorVisualProxy.autoInit.failed', { error: stringifyError(error) }); }
  });
} catch (error) {
  Logger.error?.('DoorVisualProxy.autoInit.hookFailed', { error: stringifyError(error) });
}
