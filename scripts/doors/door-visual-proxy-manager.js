import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { syncPortalTextureFlipForMesh } from './portal-texture-flip-runtime.js';

const MODULE_ID = 'fa-nexus';
const PROXY_REFRESH_HOOK = 'faNexusDoorVisualProxyRefresh';

let _singleton = null;

function stringifyError(error) {
  return String(error?.message || error);
}

function getActiveSceneId() {
  const id = canvas?.scene?.id ?? game?.scenes?.current?.id ?? null;
  return id ? String(id) : null;
}

function getDocumentSceneId(doc) {
  const id = doc?.parent?.id ?? doc?.scene?.id ?? null;
  return id ? String(id) : null;
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

function hasSmallPortalTextureToken(path) {
  return /(?:^|[\\/_\-\s.])small(?:$|[\\/_\-\s.])/.test(String(path || '').toLowerCase());
}

function parseExplicitPortalTextureGridWidth(path) {
  const match = String(path || '').toLowerCase().match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?=[^0-9]|$)/);
  if (!match) return null;
  const width = Number.parseFloat(String(match[1] || ''));
  return Number.isFinite(width) && width > 0 ? width : null;
}

function isSmallAnimatedWindowDocument(doc) {
  const faFlags = doc?.flags?.[MODULE_ID] || {};
  const buildingWindow = doc?.getFlag?.(MODULE_ID, 'buildingWindow') || faFlags.buildingWindow || null;
  if (!buildingWindow) return false;
  const animation = doc?.animation || doc?._source?.animation || doc?.data?.animation || null;
  const texture = String(animation?.texture || buildingWindow.textureLocal || buildingWindow.textureKey || '');
  const explicitWidth = parseExplicitPortalTextureGridWidth(texture);
  if (Number.isFinite(explicitWidth) && explicitWidth > 1) return false;
  const flagWidth = Number(buildingWindow.textureGridWidth);
  if (Number.isFinite(flagWidth) && flagWidth > 1) return false;
  if (buildingWindow.smallTexture === true) return true;
  if (Number.isFinite(flagWidth) && flagWidth <= 0.5) return true;
  return hasSmallPortalTextureToken(texture);
}

function getTextureWidth(texture) {
  return Number(texture?.width || texture?.baseTexture?.width || 0) || 0;
}

function applySmallAnimatedWindowPadding(doc, mesh, texture, animation = {}) {
  if (!mesh || mesh.destroyed) return false;
  const padding = isSmallAnimatedWindowDocument(doc) ? getTextureWidth(texture || mesh.texture) * 0.25 : 0;
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

function getSortedLevelIndex(scene, level) {
  const sorted = scene?.levels?.sorted || [];
  const index = sorted.findIndex((candidate) => candidate?.id === level?.id);
  return index >= 0 ? index : 0;
}

function getLevelTextureConfig(scene, level) {
  const configs = scene?._configureLevelTextures?.() || [];
  return configs.find((config) => config?.level?.id === level?.id && config.name === 'foreground') || null;
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
  const rawSort = Number(foreground?.sort);
  const sortBase = Number.isFinite(rawSort) ? rawSort : getSortedLevelIndex(scene, level);
  const occlusionMode = isUpperForegroundLevel(scene, level, foreground)
    ? (globalThis?.CONST?.OCCLUSION_MODES?.SURFACE ?? 0)
    : (globalThis?.CONST?.OCCLUSION_MODES?.NONE ?? 0);
  return { elevation, sort: sortBase - 1, occlusionMode };
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
    this._pendingBuilds = new Map();
    this._hooksBound = false;
    this._readyRan = false;
    this._sceneGeneration = 0;
    this._sceneId = null;
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
    try { Hooks.once('ready', () => this._onReady()); } catch (error) { Logger.error?.('DoorVisualProxy.hook.ready.failed', { error: stringifyError(error) }); }
    try { Hooks.on('canvasReady', () => this._onCanvasReady()); } catch (error) { Logger.error?.('DoorVisualProxy.hook.canvasReady.failed', { error: stringifyError(error) }); }
    try { Hooks.on('canvasTearDown', () => this._onCanvasTearDown()); } catch (error) { Logger.error?.('DoorVisualProxy.hook.canvasTearDown.failed', { error: stringifyError(error) }); }
    try { Hooks.on('createWall', (doc) => this._onCreateWall(doc)); } catch (error) { Logger.error?.('DoorVisualProxy.hook.createWall.failed', { error: stringifyError(error) }); }
    try { Hooks.on('updateWall', (doc, diff) => this._onUpdateWall(doc, diff)); } catch (error) { Logger.error?.('DoorVisualProxy.hook.updateWall.failed', { error: stringifyError(error) }); }
    try { Hooks.on('deleteWall', (doc) => this._onDeleteWall(doc)); } catch (error) { Logger.error?.('DoorVisualProxy.hook.deleteWall.failed', { error: stringifyError(error) }); }
    try { Hooks.on('createLevel', () => this._rebuildScene('level.create')); } catch (error) { Logger.error?.('DoorVisualProxy.hook.createLevel.failed', { error: stringifyError(error) }); }
    try { Hooks.on('updateLevel', () => this._rebuildScene('level.update')); } catch (error) { Logger.error?.('DoorVisualProxy.hook.updateLevel.failed', { error: stringifyError(error) }); }
    try { Hooks.on('deleteLevel', () => this._rebuildScene('level.delete')); } catch (error) { Logger.error?.('DoorVisualProxy.hook.deleteLevel.failed', { error: stringifyError(error) }); }
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
    this._sceneGeneration += 1;
    this._sceneId = getActiveSceneId();
    this._clearAll({ notify: false });
    if (!canvas?.ready || !canvas?.scene) return;
    this._rebuildScene('canvas.ready');
  }

  _onCanvasTearDown() {
    const previousSceneId = this._sceneId || getActiveSceneId();
    this._sceneGeneration += 1;
    this._sceneId = null;
    this._clearAll({ notify: true });
    Logger.debug?.('DoorVisualProxy.canvasTearDown.cleared', { sceneId: previousSceneId });
  }

  _onCreateWall(doc) {
    if (!canvas?.ready || !this._isActiveSceneDocument(doc, { phase: 'createWall' })) return;
    this._refreshWall(doc, { force: true, reason: 'wall.create' });
  }

  _onUpdateWall(doc, diff = {}) {
    if (!doc || !canvas?.ready || !this._isActiveSceneDocument(doc, { phase: 'updateWall' })) return;
    if (this._wallUpdateRequiresRebuild(diff)) {
      this._refreshWall(doc, { force: true, reason: 'wall.update' });
      return;
    }
    if ('ds' in (diff || {})) this._animateWall(doc);
  }

  _onDeleteWall(doc) {
    if (!doc?.id || !this._isActiveSceneDocument(doc, { phase: 'deleteWall' })) return;
    this._removeWallEntries(doc.id, { notify: true, doc });
  }

  _isActiveSceneDocument(doc, { phase = 'unknown' } = {}) {
    if (!doc) return false;
    const activeSceneId = this._sceneId || getActiveSceneId();
    const docSceneId = getDocumentSceneId(doc);
    if (activeSceneId && docSceneId && activeSceneId === docSceneId) return true;
    Logger.debug?.('DoorVisualProxy.foreignSceneDocument.ignored', {
      phase,
      wallId: doc?.id || null,
      activeSceneId,
      docSceneId
    });
    return false;
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
      || Object.prototype.hasOwnProperty.call(faFlags, 'buildingWindow');
  }

  _rebuildScene(reason) {
    if (!canvas?.ready || !canvas?.scene) return;
    const walls = canvas.scene.walls || [];
    Logger.debug?.('DoorVisualProxy.scene.rebuild', {
      reason,
      sceneId: this._sceneId || getActiveSceneId(),
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

    const generation = this._sceneGeneration;
    const sceneId = this._sceneId || getActiveSceneId();
    for (const level of sourceLevels) {
      const key = this._entryKey(wallId, level.id);
      if (this._entries.has(key) && !force) {
        const entry = this._entries.get(key);
        entry.doc = doc;
        entry.proxy.document = doc;
        entry.level = level;
        this._retargetEntry(entry);
        continue;
      }
      if (this._pendingBuilds.has(key)) continue;
      const pending = { key, generation, sceneId, cancelled: false, promise: null };
      pending.promise = this._buildEntry(doc, level, { key, generation, sceneId, pending });
      this._pendingBuilds.set(key, pending);
      pending.promise.finally(() => {
        if (this._pendingBuilds.get(key) === pending) this._pendingBuilds.delete(key);
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

    try {
      const DoorMesh = getDoorMeshClass();
      const loadTexture = getLoadTexture();
      const animation = { ...(doc?.animation || {}) };
      const textureSrc = typeof animation.texture === 'string' ? animation.texture.trim() : '';
      if (!textureSrc) throw new Error('Animated wall has no animation.texture.');
      delete animation.texture;
      requireWallCoords(doc);

      const texture = await loadTexture(textureSrc);
      if (!texture) throw new Error(`Failed to load door texture: ${textureSrc}`);
      if (!this._isCurrentSceneScope(generation, sceneId)) return;
      if (pending?.cancelled || this._pendingBuilds.get(key) !== pending) return;

      const proxy = new DoorVisualProxyWall(doc, level);
      const styles = [animation.double ? DoorMesh.DOOR_STYLES.DOUBLE_LEFT : DoorMesh.DOOR_STYLES.SINGLE];
      if (animation.double) styles.push(DoorMesh.DOOR_STYLES.DOUBLE_RIGHT);

      const meshes = [];
      for (const style of styles) {
        const mesh = new DoorMesh({ object: proxy, texture, style, ...animation });
        syncPortalTextureFlipForMesh(doc, mesh, { reason: 'doorVisualProxyBuild' });
        applySmallAnimatedWindowPadding(doc, mesh, texture, { style, ...animation });
        mesh.name = `fa-nexus-door-visual-proxy:${wallId}:${level.id}:${style}`;
        mesh.eventMode = 'none';
        mesh.faNexusDoorVisualProxy = true;
        mesh.faNexusSourceWallId = wallId;
        mesh.faNexusSourceLevelId = level.id;
        try {
          this._retargetMesh(mesh, level);
        } catch (error) {
          try { if (mesh.destroyed === false) mesh.destroy(); } catch (_) { /* ignore */ }
          throw error;
        }
        canvas.primary.addChild(mesh);
        meshes.push(mesh);
      }

      if (pending?.cancelled || this._pendingBuilds.get(key) !== pending) {
        for (const mesh of meshes) {
          try { mesh?.parent?.removeChild?.(mesh); } catch (_) { /* ignore */ }
          try { if (mesh && mesh.destroyed === false) mesh.destroy(); } catch (_) { /* ignore */ }
        }
        return;
      }
      this._entries.set(key, { key, wallId, doc, level, proxy, meshes });
      this._notifyProxyRefresh(doc, 'build');
      Logger.debug?.('DoorVisualProxy.entry.built', { wallId, levelId: level.id, meshes: meshes.length });
    } catch (error) {
      Logger.error?.('DoorVisualProxy.entry.buildFailed', {
        wallId,
        levelId: level?.id || null,
        error: stringifyError(error)
      });
      this._notifyProxyRefresh(doc, 'buildFailed');
    }
  }

  _isCurrentSceneScope(generation = this._sceneGeneration, sceneId = this._sceneId || getActiveSceneId()) {
    const activeSceneId = this._sceneId || getActiveSceneId();
    return generation === this._sceneGeneration
      && !!sceneId
      && !!activeSceneId
      && String(sceneId) === String(activeSceneId)
      && !!canvas?.ready;
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

  _animateWall(doc) {
    const wallId = String(doc?.id || '');
    if (!wallId) return;
    const open = isOpenDoor(doc);
    for (const entry of this._entries.values()) {
      if (entry.wallId !== wallId) continue;
      entry.doc = doc;
      entry.proxy.document = doc;
      for (const mesh of entry.meshes || []) {
        if (!mesh || mesh.destroyed) continue;
        try {
          mesh.animate(open);
        } catch (error) {
          Logger.error?.('DoorVisualProxy.animate.failed', {
            wallId,
            levelId: entry.level?.id || null,
            error: stringifyError(error)
          });
        }
      }
    }
  }

  _removeWallEntries(wallId, { notify = false, doc = null } = {}) {
    const id = String(wallId || '');
    if (!id) return;
    let removed = false;
    for (const key of Array.from(this._entries.keys())) {
      const entry = this._entries.get(key);
      if (entry?.wallId !== id) continue;
      this._removeEntry(key, { notify: false });
      removed = true;
    }
    for (const key of Array.from(this._pendingBuilds.keys())) {
      if (!key.startsWith(`${id}:`)) continue;
      const pending = this._pendingBuilds.get(key);
      if (pending) pending.cancelled = true;
      this._pendingBuilds.delete(key);
    }
    if (notify && (removed || doc)) this._notifyProxyRefresh(doc, 'remove');
  }

  _removeEntry(key, { notify = false } = {}) {
    const entry = this._entries.get(key);
    if (!entry) return;
    for (const mesh of entry.meshes || []) {
      try { mesh?.parent?.removeChild?.(mesh); } catch (error) { Logger.warn?.('DoorVisualProxy.mesh.removeChildFailed', { key, error: stringifyError(error) }); }
      try {
        if (mesh && mesh.destroyed === false) mesh.destroy();
      } catch (error) {
        Logger.warn?.('DoorVisualProxy.mesh.destroyFailed', { key, error: stringifyError(error) });
      }
    }
    this._entries.delete(key);
    if (notify) this._notifyProxyRefresh(entry.doc, 'remove');
  }

  _clearAll({ notify = false } = {}) {
    for (const pending of this._pendingBuilds.values()) {
      if (pending) pending.cancelled = true;
    }
    this._pendingBuilds.clear();
    const docs = new Map();
    for (const entry of this._entries.values()) {
      if (entry.doc?.id) docs.set(entry.doc.id, entry.doc);
    }
    for (const key of Array.from(this._entries.keys())) this._removeEntry(key, { notify: false });
    if (notify) {
      for (const doc of docs.values()) this._notifyProxyRefresh(doc, 'clear');
    }
  }

  _notifyProxyRefresh(doc, reason) {
    if (!doc?.id) return;
    try { Hooks.callAll(PROXY_REFRESH_HOOK, doc, { reason, moduleId: MODULE_ID }); }
    catch (error) { Logger.warn?.('DoorVisualProxy.refreshHook.failed', { wallId: doc.id, error: stringifyError(error) }); }
  }
}

try {
  Hooks.once('ready', () => {
    try { DoorVisualProxyManager.getInstance(); }
    catch (error) { Logger.error?.('DoorVisualProxy.autoInit.failed', { error: stringifyError(error) }); }
  });
} catch (error) {
  Logger.error?.('DoorVisualProxy.autoInit.hookFailed', { error: stringifyError(error) });
}
