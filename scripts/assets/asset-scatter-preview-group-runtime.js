import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { applyHsbcToDisplayObject } from '../core/hsbc.js';
import { getSharedTexture, loadTexture } from '../textures/texture-runtime-core.js';
import { applyScatterInstanceTransformToSprite } from './asset-scatter-instance-transform.js';

export class AssetScatterPreviewGroupRuntime {
  constructor(manager, { scatterModeBrush, previewZIndex = 999998 } = {}) {
    if (!manager) throw new Error('AssetScatterPreviewGroupRuntime requires manager.');
    this.manager = manager;
    this.scatterModeBrush = scatterModeBrush;
    this.previewZIndex = previewZIndex;
    this._container = null;
    this._groups = new Map();
    this._activeKey = null;
    this._instances = [];
    this._sprites = new Map();
    this._textures = new Map();
    this._textureLoads = new Map();
    this._textureFailures = new Set();
    this._textureLoadGeneration = 0;
  }

  get container() { return this._container; }
  set container(value) { this._container = value || null; }

  get groups() { return this._groups; }
  set groups(value) { this._groups = value instanceof Map ? value : new Map(); }

  get activeKey() { return this._activeKey; }
  set activeKey(value) { this._activeKey = value || null; }

  get instances() { return this._instances; }
  set instances(value) { this._instances = Array.isArray(value) ? value : []; }

  get sprites() { return this._sprites; }
  set sprites(value) { this._sprites = value instanceof Map ? value : new Map(); }

  get textures() { return this._textures; }
  set textures(value) { this._textures = value instanceof Map ? value : new Map(); }

  get textureFailures() { return this._textureFailures; }
  set textureFailures(value) { this._textureFailures = value instanceof Set ? value : new Set(); }

  getGroupKey(elevation) {
    return this.manager._getScatterSessionKey(elevation);
  }

  ensureOverlay() {
    const manager = this.manager;
    const elevation = Number.isFinite(manager._previewElevation) ? manager._previewElevation : 0;
    const group = this.ensureGroup(elevation, { setActive: true });
    if (group) {
      manager._scheduleScatterPreviewShadowUpdate({ force: true, key: group.key });
    }
  }

  clear() {
    const manager = this.manager;
    this._textureLoadGeneration += 1;
    this._textureLoads.clear();
    if (this._groups?.size) {
      for (const group of this._groups.values()) {
        this.destroyGroup(group);
      }
    }
    manager._scatterPreviewShadowRenderer.reset();
    this._groups = new Map();
    this._container = null;
    this._activeKey = null;
    this._instances = [];
    this._sprites.clear();
    this._textureFailures.clear();
    manager._notifyPreviewLayerChange();
  }

  resetSession() {
    this.clear();
  }

  beginSession(instances = [], { elevation = null, shadowSettings = null } = {}) {
    const manager = this.manager;
    this.resetSession();
    if (shadowSettings) {
      manager._scatterPreviewShadowRenderer.replaceSettings(shadowSettings);
    }
    const targetElevation = Number.isFinite(elevation) ? elevation : manager._previewElevation;
    if (Array.isArray(instances) && instances.length) {
      const key = this.getGroupKey(targetElevation);
      for (const instance of instances) {
        if (!instance) continue;
        instance._scatterGroupKey = instance._scatterGroupKey || key;
        instance._scatterElevation = Number.isFinite(instance._scatterElevation)
          ? instance._scatterElevation
          : manager._quantizeScatterElevation(Number(targetElevation) || 0);
        this._instances.push(instance);
        this.addInstance(instance);
      }
      manager._scheduleScatterPreviewShadowUpdate({ force: true });
    }
  }

  getTexture(src) {
    if (!src) return null;
    if (this._textures.has(src)) return this._textures.get(src);
    try {
      const texture = getSharedTexture(src);
      this._textures.set(src, texture);
      return texture;
    } catch (_) {
      this.queueTexture(src);
      return null;
    }
  }

  queueTexture(src) {
    if (!src || this._textureLoads.has(src)) return;
    const generation = this._textureLoadGeneration;
    const request = loadTexture(src)
      .then((texture) => {
        if (generation !== this._textureLoadGeneration || this._textureLoads.get(src) !== request) return;
        this._textures.set(src, texture);
        this._textureFailures.delete(src);
        this.rebuildSprites({ src });
        this.manager._syncScatterHoverPreview();
      })
      .catch((error) => {
        if (generation !== this._textureLoadGeneration || this._textureLoads.get(src) !== request) return;
        if (!this._textureFailures.has(src)) {
          this._textureFailures.add(src);
          Logger.error('Placement.scatterPreview.texture.failed', {
            src,
            error: String(error?.message || error)
          });
        }
      })
      .finally(() => {
        if (this._textureLoads.get(src) === request) this._textureLoads.delete(src);
      });
    this._textureLoads.set(src, request);
  }

  addInstance(instance) {
    if (!instance) return;
    const manager = this.manager;
    const src = instance.src;
    if (!src) return;
    const elevation = Number.isFinite(instance._scatterElevation) ? instance._scatterElevation : manager._previewElevation;
    const group = this.ensureGroup(elevation, { setActive: this.getGroupKey(elevation) === this.getGroupKey(manager._previewElevation) });
    if (!group?.container) return;
    instance._scatterGroupKey = instance._scatterGroupKey || group.key;
    instance._scatterElevation = group.elevation;
    if (!group.instances.includes(instance)) group.instances.push(instance);
    const texture = this.getTexture(src);
    if (!texture) return;
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.position.set(instance.x, instance.y);
    sprite.rotation = ((instance.r || 0) * Math.PI) / 180;
    sprite.width = instance.w;
    sprite.height = instance.h;
    if (instance.flipH) sprite.scale.x *= -1;
    if (instance.flipV) sprite.scale.y *= -1;
    applyScatterInstanceTransformToSprite(sprite, instance);
    sprite.eventMode = 'none';
    applyHsbcToDisplayObject(sprite, manager._getPersistedHsbc(), { slot: 'asset-scatter-preview' });
    group.container.addChild(sprite);
    if (instance.id) {
      this._sprites.set(instance.id, sprite);
    }
    manager._syncDropShadowOnlyPreview();
    this.syncFlags();
    manager._scheduleScatterPreviewShadowUpdate({ key: group.key });
  }

  removeInstance(instanceId) {
    if (!instanceId) return;
    const manager = this.manager;
    const sprite = this._sprites.get(instanceId);
    if (!sprite) return;
    const instance = this._instances.find((entry) => entry?.id === instanceId) || null;
    const groupKey = instance?._scatterGroupKey;
    try { sprite.parent?.removeChild?.(sprite); } catch (_) {}
    try { sprite.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    this._sprites.delete(instanceId);
    if (groupKey && this._groups?.size) {
      const group = this._groups.get(groupKey);
      if (group) {
        group.instances = (group.instances || []).filter((entry) => entry?.id !== instanceId);
        if (!group.instances.length) {
          this._groups.delete(groupKey);
          this.destroyGroup(group);
          if (this._activeKey === groupKey) {
            this._activeKey = null;
            this._container = null;
          }
          manager._scatterPreviewShadowRenderer.deleteDirty(groupKey);
        }
      }
    }
    this.syncFlags();
    manager._scheduleScatterPreviewShadowUpdate({ key: groupKey || null });
  }

  rebuildSprites({ src = null } = {}) {
    const instances = Array.isArray(this._instances) ? this._instances : [];
    const rebuiltGroups = new Set();
    for (const instance of instances) {
      if (src && instance?.src !== src) continue;
      if (instance?.id && this._sprites.has(instance.id)) continue;
      this.addInstance(instance);
      if (instance?._scatterGroupKey) rebuiltGroups.add(instance._scatterGroupKey);
    }
    for (const key of rebuiltGroups) {
      this.manager._scheduleScatterPreviewShadowUpdate({ force: true, key });
    }
  }

  normalizeGroupKey({ previewKey = null, previewId = null, elevation = null } = {}) {
    const explicit = String(previewKey || '').trim();
    if (explicit) return explicit;
    const id = String(previewId || '').trim();
    if (id.startsWith('scatter-preview-')) return id.slice('scatter-preview-'.length);
    const numeric = Number(elevation);
    return Number.isFinite(numeric) ? this.getGroupKey(numeric) : '';
  }

  applyGroupPlacement({
    previewId = null,
    previewKey = null,
    elevation = null,
    sort = undefined,
    previewSort = undefined
  } = {}) {
    const manager = this.manager;
    if (!this._groups?.size) return false;
    const sourceKey = this.normalizeGroupKey({ previewId, previewKey, elevation });
    const targetElevation = Number(elevation);
    const targetKey = Number.isFinite(targetElevation) ? this.getGroupKey(targetElevation) : sourceKey;
    const nextSort = Number(sort);
    const group = this._groups.get(sourceKey);
    if (!group) {
      Logger.warn('Placement.scatter.previewGroup.missing', {
        previewId,
        previewKey,
        sourceKey,
        targetKey
      });
      return false;
    }

    let changed = false;
    if (targetKey && sourceKey !== targetKey) {
      const existingTarget = this._groups.get(targetKey);
      if (existingTarget && existingTarget !== group) {
        Logger.warn('Placement.scatter.previewGroup.targetExists', {
          previewId,
          sourceKey,
          targetKey,
          targetElevation
        });
        return false;
      }
      this._groups.delete(sourceKey);
      group.key = targetKey;
      group.elevation = Number.isFinite(targetElevation) ? manager._quantizeScatterElevation(targetElevation) : group.elevation;
      this._groups.set(targetKey, group);
      if (group.container) {
        group.container.faNexusScatterPreviewKey = targetKey;
        group.container.name = `fa-nexus-scatter-preview-${targetKey}`;
      }
      for (const instance of group.instances || []) {
        if (!instance) continue;
        instance._scatterGroupKey = targetKey;
        instance._scatterElevation = group.elevation;
      }
      manager._scatterCommitSession.moveGroup(sourceKey, targetKey, {
        elevation: group.elevation,
        sort: group.sort
      });
      manager._scatterPreviewShadowRenderer.moveSettings(sourceKey, targetKey);
      if (this._activeKey === sourceKey) this._activeKey = targetKey;
      changed = true;
    }

    if (Number.isFinite(nextSort) && Number(group.sort) !== nextSort) {
      group.sort = nextSort;
      manager._scatterCommitSession.updateGroupSort(targetKey, nextSort);
      changed = true;
    }
    const nextPreviewSort = Number(previewSort);
    if (Number.isFinite(nextPreviewSort) && Number(group.previewSort) !== nextPreviewSort) {
      group.previewSort = nextPreviewSort;
      changed = true;
    }

    this._container = group.container;
    this._activeKey = targetKey;
    this.applyOrdering(group);
    this.syncFlags();
    return changed;
  }

  syncFlags() {
    if (!this._groups?.size) return false;
    const activeKey = this._activeKey;
    let changed = false;
    for (const group of this._groups.values()) {
      const container = group?.container;
      if (!container) continue;
      const hasContent = Array.isArray(group.instances) && group.instances.length > 0;
      const isActive = !!activeKey && group.key === activeKey;
      if (container.faNexusPreviewHasContent !== hasContent) {
        container.faNexusPreviewHasContent = hasContent;
        changed = true;
      }
      if (container.faNexusPreviewActive !== isActive) {
        container.faNexusPreviewActive = isActive;
        changed = true;
      }
    }
    if (changed) this.manager._notifyPreviewLayerChange();
    return changed;
  }

  ensureGroup(elevation, { setActive = true } = {}) {
    const manager = this.manager;
    const key = this.getGroupKey(elevation);
    let group = this._groups.get(key);
    if (group?.container && !group.container.destroyed) {
      if (setActive) {
        this._container = group.container;
        this._activeKey = key;
        this.syncFlags();
      }
      return group;
    }

    try {
      const overlay = new PIXI.Container();
      overlay.eventMode = 'none';
      overlay.sortableChildren = false;
      overlay.name = `fa-nexus-scatter-preview-${key}`;
      overlay.faNexusScatterPreview = true;
      overlay.faNexusScatterPreviewKey = key;
      overlay.faNexusPreviewHasContent = false;
      overlay.faNexusPreviewActive = false;
      const parent = canvas?.primary || canvas?.stage;
      overlay.zIndex = parent === canvas?.stage ? this.previewZIndex : 0;
      parent?.addChild?.(overlay);
      if (parent && 'sortDirty' in parent) parent.sortDirty = true;
      parent?.sortChildren?.();

      const normalizedElevation = manager._quantizeScatterElevation(Number(elevation) || 0);
      const currentKey = this.getGroupKey(manager._previewElevation);
      let sort = 0;
      if (currentKey === key && Number.isFinite(manager._previewSort)) {
        sort = manager._previewSort;
      } else {
        const computed = manager._interactionController.computeNextSortAtElevation?.(normalizedElevation);
        sort = Number.isFinite(computed) ? computed : (Number.isFinite(manager._previewSort) ? manager._previewSort : 0);
      }

      const cachedShadow = manager._scatterPreviewShadowRenderer.getSettings(key);
      const shadowSettings = cachedShadow ? { ...cachedShadow } : manager._snapshotScatterPreviewShadowSettings();
      if (!cachedShadow) manager._scatterPreviewShadowRenderer.setSettings(key, { ...shadowSettings });

      group = {
        key,
        elevation: normalizedElevation,
        sort,
        container: overlay,
        instances: [],
        shadow: shadowSettings
      };
      this._groups.set(key, group);
      this.applyOrdering(group);

      if (setActive) {
        this._container = overlay;
        this._activeKey = key;
      }
      this.syncFlags();
      return group;
    } catch (_) {
      return null;
    }
  }

  destroyGroup(group) {
    if (!group?.container) return;
    const container = group.container;
    this.manager._cleanupPreviewShadowResources(container);
    const prevChildren = container.children?.slice() || [];
    container.removeChildren();
    for (const child of prevChildren) {
      try { child.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    }
    try { container.parent?.removeChild?.(container); } catch (_) {}
    try { container.destroy?.({ children: true }); } catch (_) {}
  }

  applyOrdering(group) {
    const manager = this.manager;
    const container = group?.container;
    if (!container) return;
    const nextSort = Number.isFinite(group?.sort) ? group.sort : 0;
    const nextPreviewSort = Number.isFinite(group?.previewSort) ? group.previewSort : nextSort;
    const elevation = Number.isFinite(group?.elevation) ? group.elevation : 0;
    const renderOrder = manager._resolvePreviewRenderOrder(elevation, nextPreviewSort);
    container.sortLayer = renderOrder.sortLayer;
    container.sort = renderOrder.sort;
    container.faNexusSort = renderOrder.sort;
    container.faNexusPlacementSort = nextSort;
    container.faNexusPlacementAnchorTileId = manager._placementSortAnchorTileId || null;
    container.faNexusPreviewSort = nextPreviewSort;
    container.faNexusElevationDoc = elevation;
    container.faNexusElevation = renderOrder.elevation;
    container.faNexusPlacementLevelId = renderOrder.placementLevelId || null;
    container.faNexusBandKind = renderOrder.kind || 'normal';
    container.elevation = renderOrder.elevation;
    if (container.parent === canvas?.stage) container.zIndex = this.previewZIndex;
    else if (container.parent) container.zIndex = renderOrder.kind !== 'normal' ? nextPreviewSort : 0;
    const parent = container.parent;
    if (parent && 'sortDirty' in parent) parent.sortDirty = true;
    parent?.sortChildren?.();
  }

  syncOrdering() {
    const manager = this.manager;
    try {
      const key = this.getGroupKey(manager._previewElevation);
      let group = this._groups.get(key);
      if (!group && manager.isPlacementActive && manager._scatterMode === this.scatterModeBrush && manager._scatterMergeEnabled) {
        this.ensureOverlay();
        group = this._groups.get(key);
      }
      if (!group) {
        this._container = null;
        this._activeKey = null;
        this.syncFlags();
        return;
      }
      if (Number.isFinite(manager._previewSort)) group.sort = manager._previewSort;
      if (Number.isFinite(manager._previewRenderSort)) group.previewSort = manager._previewRenderSort;
      this._container = group.container;
      this._activeKey = key;
      this.applyOrdering(group);
      this.syncFlags();
    } catch (error) {
      Logger.warn('Placement.scatterPreviewOrdering.failed', {
        error: String(error?.message || error),
        elevation: manager._previewElevation,
        sort: manager._previewSort,
        scatterMode: manager._scatterMode,
        mergeEnabled: !!manager._scatterMergeEnabled
      });
    }
  }
}
