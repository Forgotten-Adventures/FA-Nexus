import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  applyScatterInstanceTransformToSprite,
  computeAffineScatterInstanceBounds
} from './asset-scatter-instance-transform.js';

export class AssetPlacementScatterPreviewShadowRenderer {
  constructor(manager, { scatterModeBrush } = {}) {
    this.manager = manager;
    this.scatterModeBrush = scatterModeBrush;
    this._scatterPreviewShadowFrame = null;
    this._scatterPreviewShadowForce = false;
    this._scatterPreviewShadowDirty = new Set();
    this._scatterPreviewShadowSettings = new Map();
    this._scatterPreviewShadowTextureListeners = new WeakMap();
    this._scatterPreviewShadowBatchActive = false;
    this._scatterPreviewShadowBatchForce = false;
    this._scatterPreviewShadowBatchNeedsAll = false;
    this._scatterPreviewShadowBatchDirty = new Set();
  }

  get settings() {
    return this._scatterPreviewShadowSettings;
  }

  getSettings(key) {
    return this._scatterPreviewShadowSettings.get(key);
  }

  setSettings(key, settings) {
    return this._scatterPreviewShadowSettings.set(key, settings);
  }

  hasSettings(key) {
    return this._scatterPreviewShadowSettings.has(key);
  }

  deleteSettings(key) {
    return this._scatterPreviewShadowSettings.delete(key);
  }

  deleteDirty(key) {
    return this._scatterPreviewShadowDirty.delete(key);
  }

  moveSettings(sourceKey, targetKey) {
    const settings = this.getSettings(sourceKey);
    if (settings && !this.hasSettings(targetKey)) this.setSettings(targetKey, settings);
    this.deleteSettings(sourceKey);
  }

  replaceSettings(shadowSettings) {
    const entries = shadowSettings instanceof Map
      ? Array.from(shadowSettings.entries())
      : (Array.isArray(shadowSettings) ? shadowSettings : null);
    if (!entries) return false;
    this._scatterPreviewShadowSettings = new Map(entries.map(([key, settings]) => [
      key,
      settings && typeof settings === 'object' ? { ...settings } : settings
    ]));
    return true;
  }

  reset() {
    if (this._scatterPreviewShadowFrame && typeof window !== 'undefined') {
      try { window.cancelAnimationFrame(this._scatterPreviewShadowFrame); } catch (_) {}
    }
    this._scatterPreviewShadowFrame = null;
    this._scatterPreviewShadowForce = false;
    this._scatterPreviewShadowDirty = new Set();
    this._scatterPreviewShadowSettings = new Map();
    this._scatterPreviewShadowTextureListeners = new WeakMap();
    this._scatterPreviewShadowBatchActive = false;
    this._scatterPreviewShadowBatchForce = false;
    this._scatterPreviewShadowBatchNeedsAll = false;
    this._scatterPreviewShadowBatchDirty.clear();
  }

  isActive() {
    const manager = this.manager;
    return manager._isGlobalDropShadowEnabled() && manager.isDropShadowEnabled() && !!manager._scatterPreviewGroups?.size;
  }

  snapshotSettings() {
    const manager = this.manager;
    return {
      alpha: Math.min(1, Math.max(0, Number(manager._dropShadowAlpha || 0))),
      dilation: Math.max(0, Number(manager._dropShadowDilation || 0)),
      blur: Math.max(0, Number(manager._dropShadowBlur || 0)),
      offsetDistance: Math.min(manager._getShadowOffsetMax(), Math.max(0, Number(manager._dropShadowOffsetDistance || 0))),
      offsetAngle: manager._normalizeShadowAngle(manager._dropShadowOffsetAngle ?? 0)
    };
  }

  syncSettingsForActiveElevation({ force = false } = {}) {
    try {
      const manager = this.manager;
      const key = manager._getScatterPreviewGroupKey(manager._previewElevation);
      const settings = this.snapshotSettings();
      this._scatterPreviewShadowSettings.set(key, settings);
      const group = manager._scatterPreviewGroups.get(key);
      if (group) group.shadow = { ...settings };
      manager._scatterCommitSession.updateGroupShadowSettings(key, settings);
      if (group) this.scheduleUpdate({ force, key: group.key });
    } catch (error) {
      Logger.warn('Placement.scatterPreview.shadowSettingsSync.failed', {
        error: String(error?.message || error)
      });
    }
  }

  ensureContainer(container) {
    const manager = this.manager;
    const target = container || manager._scatterPreviewContainer;
    if (!target) return null;
    const containerRef = target;
    let shadow = containerRef._shadowContainer || null;
    if (!shadow || shadow.destroyed) {
      shadow = new PIXI.Container();
      shadow.sortableChildren = false;
      shadow.eventMode = 'none';
      shadow.visible = false;
      shadow.name = 'fa-nexus-scatter-shadow-preview';
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(0, 0);
      sprite.visible = false;
      sprite.eventMode = 'none';
      shadow.addChild(sprite);
      shadow._sprite = sprite;
      containerRef.addChildAt(shadow, 0);
      containerRef._shadowContainer = shadow;
      containerRef._shadowSprite = sprite;
      containerRef._shadowRenderTexture = null;
      containerRef._shadowState = null;
    } else if (typeof containerRef.getChildIndex === 'function' && containerRef.getChildIndex(shadow) !== 0) {
      try { containerRef.setChildIndex(shadow, 0); } catch (_) {}
    }
    return shadow;
  }

  scheduleUpdate({ force = false, key = null } = {}) {
    try {
      const manager = this.manager;
      if (typeof window === 'undefined') return;
      if (!manager._scatterPreviewGroups?.size) return;
      if (this._scatterPreviewShadowBatchActive) {
        if (force) this._scatterPreviewShadowBatchForce = true;
        if (!key) this._scatterPreviewShadowBatchNeedsAll = true;
        if (key) this._scatterPreviewShadowBatchDirty.add(key);
        return;
      }
      if (force) this._scatterPreviewShadowForce = true;
      if (key) this._scatterPreviewShadowDirty.add(key);
      if (this._scatterPreviewShadowFrame) return;
      this._scatterPreviewShadowFrame = window.requestAnimationFrame(() => {
        this._scatterPreviewShadowFrame = null;
        const shouldForce = this._scatterPreviewShadowForce;
        this._scatterPreviewShadowForce = false;
        const keys = shouldForce
          ? Array.from(manager._scatterPreviewGroups.keys())
          : Array.from(this._scatterPreviewShadowDirty);
        this._scatterPreviewShadowDirty.clear();
        if (!keys.length) {
          if (manager._scatterPreviewActiveKey) {
            keys.push(manager._scatterPreviewActiveKey);
          } else if (manager._scatterPreviewGroups?.size) {
            keys.push(...manager._scatterPreviewGroups.keys());
          }
        }
        if (!keys.length) return;
        for (const groupKey of keys) {
          const group = manager._scatterPreviewGroups.get(groupKey);
          if (!group) continue;
          this.updateGroup(group, { force: shouldForce });
        }
      });
    } catch (_) {}
  }

  registerTextureListener(baseTexture) {
    try {
      if (!baseTexture || typeof baseTexture.once !== 'function') return;
      if (this._scatterPreviewShadowTextureListeners.has(baseTexture)) return;
      const handler = () => {
        if (this._scatterPreviewShadowTextureListeners.get(baseTexture) === handler) {
          this._scatterPreviewShadowTextureListeners.delete(baseTexture);
        }
        this.scheduleUpdate({ force: true });
      };
      this._scatterPreviewShadowTextureListeners.set(baseTexture, handler);
      baseTexture.once('loaded', handler);
      baseTexture.once('update', handler);
    } catch (_) {}
  }

  computeInstanceBounds(instance) {
    if (instance?.affine) return computeAffineScatterInstanceBounds(instance);
    const cx = Number(instance?.x) || 0;
    const cy = Number(instance?.y) || 0;
    const hw = Math.max(1, Number(instance?.w) || 0) / 2;
    const hh = Math.max(1, Number(instance?.h) || 0) / 2;
    const rot = ((Number(instance?.r) || 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const corners = [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh }
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const corner of corners) {
      const x = cx + corner.x * cos - corner.y * sin;
      const y = cy + corner.x * sin + corner.y * cos;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  computeBounds(instances) {
    if (!Array.isArray(instances) || !instances.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const instance of instances) {
      if (!instance) continue;
      const bounds = this.computeInstanceBounds(instance);
      if (!bounds) continue;
      if (bounds.minX < minX) minX = bounds.minX;
      if (bounds.minY < minY) minY = bounds.minY;
      if (bounds.maxX > maxX) maxX = bounds.maxX;
      if (bounds.maxY > maxY) maxY = bounds.maxY;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY)
    };
  }

  updateGroup(group, { force = false } = {}) {
    try {
      const manager = this.manager;
      const container = group?.container;
      if (!container) return;
      if (!this.isActive()) {
        if (container._shadowContainer) container._shadowContainer.visible = false;
        return;
      }
      const instances = Array.isArray(group?.instances) ? group.instances : [];
      if (!instances.length) {
        if (container._shadowContainer) container._shadowContainer.visible = false;
        return;
      }
      const renderer = canvas?.app?.renderer;
      if (!renderer) return;

      const bounds = this.computeBounds(instances);
      if (!bounds) return;

      const shadowSettings = group?.shadow
        || this._scatterPreviewShadowSettings.get(group?.key)
        || this.snapshotSettings();
      const alpha = Math.min(1, Math.max(0, Number(shadowSettings?.alpha ?? manager._dropShadowAlpha ?? 0)));
      const dilation = Math.max(0, Number(shadowSettings?.dilation ?? manager._dropShadowDilation ?? 0));
      const blur = Math.max(0, Number(shadowSettings?.blur ?? manager._dropShadowBlur ?? 0));
      const offsetDistance = Number(shadowSettings?.offsetDistance ?? manager._dropShadowOffsetDistance ?? 0);
      const offsetAngle = shadowSettings?.offsetAngle ?? manager._dropShadowOffsetAngle ?? 0;
      const offset = manager._computeShadowOffsetVector(offsetDistance, offsetAngle);
      const zoom = Math.max(0.1, Number(canvas?.stage?.scale?.x || 1));

      const blurMargin = blur * 12;
      const marginX = Math.abs(offset.x) + dilation + blurMargin;
      const marginY = Math.abs(offset.y) + dilation + blurMargin;
      const paddedWidth = Math.max(8, Math.ceil(bounds.width + marginX * 2));
      const paddedHeight = Math.max(8, Math.ceil(bounds.height + marginY * 2));
      const renderTarget = manager._resolveSafePreviewRenderTarget(paddedWidth, paddedHeight, {
        renderer,
        resolution: 1,
        minSize: 8
      });
      const originX = bounds.minX - marginX;
      const originY = bounds.minY - marginY;

      const signature = (() => {
        try {
          return JSON.stringify({
            a: Number(alpha.toFixed(3)),
            d: Number(dilation.toFixed(3)),
            b: Number(blur.toFixed(3)),
            ox: Number((offset.x || 0).toFixed(3)),
            oy: Number((offset.y || 0).toFixed(3)),
            w: paddedWidth,
            h: paddedHeight,
            tw: renderTarget.textureWidth,
            th: renderTarget.textureHeight,
            i: instances
          });
        } catch (_) {
          return '';
        }
      })();
      const previousSignature = container._shadowState?.signature || null;
      if (!force && previousSignature === signature) return;

      const shadow = this.ensureContainer(container);
      if (!shadow) return;
      shadow.visible = true;
      shadow.alpha = 1;

      const shadowSprite = container._shadowSprite || shadow._sprite;
      if (!shadowSprite) return;

      let renderTexture = container._shadowRenderTexture || null;
      if (!renderTexture || renderTexture.width !== renderTarget.textureWidth || renderTexture.height !== renderTarget.textureHeight) {
        if (renderTexture && !renderTexture.destroyed) {
          try { renderTexture.destroy(true); } catch (_) {}
        }
        renderTexture = PIXI.RenderTexture.create({
          width: renderTarget.textureWidth,
          height: renderTarget.textureHeight,
          resolution: renderTarget.resolution,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        container._shadowRenderTexture = renderTexture;
      }

      const drawContainer = new PIXI.Container();
      if (renderTarget.drawScaleX !== 1 || renderTarget.drawScaleY !== 1) {
        drawContainer.scale.set(renderTarget.drawScaleX, renderTarget.drawScaleY);
      }
      const offsets = manager._buildPreviewDilationOffsets(dilation);
      let drawCount = 0;
      for (const instance of instances) {
        const texture = manager._getScatterPreviewTexture(instance?.src);
        if (!texture) continue;
        const baseTexture = texture.baseTexture;
        if (baseTexture && !baseTexture.valid) {
          this.registerTextureListener(baseTexture);
          continue;
        }
        const baseWidth = Math.max(1, Number(instance?.w) || 0);
        const baseHeight = Math.max(1, Number(instance?.h) || 0);
        const baseX = (Number(instance?.x) || 0) - originX + offset.x;
        const baseY = (Number(instance?.y) || 0) - originY + offset.y;
        const rotation = ((Number(instance?.r) || 0) * Math.PI) / 180;
        for (const sample of offsets) {
          const clone = new PIXI.Sprite(texture);
          clone.anchor.set(0.5, 0.5);
          clone.width = baseWidth;
          clone.height = baseHeight;
          if (instance?.flipH) clone.scale.x *= -1;
          if (instance?.flipV) clone.scale.y *= -1;
          clone.rotation = rotation;
          clone.position.set(baseX + sample.x, baseY + sample.y);
          if (instance?.affine) {
            applyScatterInstanceTransformToSprite(clone, {
              ...instance,
              x: baseX + sample.x,
              y: baseY + sample.y
            });
          }
          clone.alpha = 1;
          drawContainer.addChild(clone);
          drawCount += 1;
        }
      }

      if (!drawCount) {
        if (container._shadowContainer) container._shadowContainer.visible = false;
        try { drawContainer.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        return;
      }

      renderer.render(drawContainer, { renderTexture, clear: true });
      try { drawContainer.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}

      shadowSprite.texture = renderTexture;
      shadowSprite.tint = 0x000000;
      shadowSprite.alpha = alpha;
      shadowSprite.position.set(originX, originY);
      shadowSprite.anchor.set(0, 0);
      shadowSprite.width = paddedWidth;
      shadowSprite.height = paddedHeight;
      shadowSprite.visible = true;

      if (blur > 0) {
        let filter = container._shadowBlurFilter || null;
        if (!filter || filter.destroyed) {
          filter = new PIXI.BlurFilter();
          filter.quality = 4;
          filter.repeatEdgePixels = true;
          container._shadowBlurFilter = filter;
        }
        filter.blur = blur * zoom;
        shadowSprite.filters = [filter];
      } else if (shadowSprite.filters) {
        shadowSprite.filters = null;
      }

      container._shadowState = { signature };
    } catch (_) {}
  }

  beginBatch() {
    const manager = this.manager;
    if (this._scatterPreviewShadowBatchActive) return;
    if (manager._scatterMode !== this.scatterModeBrush) return;
    if (!manager._scatterMergeEnabled) return;
    if (!manager._isGlobalDropShadowEnabled() || !manager.isDropShadowEnabled()) return;
    this._scatterPreviewShadowBatchActive = true;
    this._scatterPreviewShadowBatchForce = false;
    this._scatterPreviewShadowBatchNeedsAll = false;
    this._scatterPreviewShadowBatchDirty.clear();
  }

  async endBatch({ awaitQueue = false } = {}) {
    const manager = this.manager;
    if (!this._scatterPreviewShadowBatchActive) return;
    const queuePromise = awaitQueue ? manager._scatterQueuePromise : null;
    if (queuePromise) {
      await manager._scatterCommitSession.drainQueue({
        loggerTag: 'Placement.scatter.previewShadow.queueDrainFailed'
      });
    }
    this._scatterPreviewShadowBatchActive = false;
    const force = this._scatterPreviewShadowBatchForce;
    const needsAll = this._scatterPreviewShadowBatchNeedsAll;
    const keys = Array.from(this._scatterPreviewShadowBatchDirty);
    this._scatterPreviewShadowBatchForce = false;
    this._scatterPreviewShadowBatchNeedsAll = false;
    this._scatterPreviewShadowBatchDirty.clear();
    if (!manager._scatterPreviewGroups?.size) return;
    if (force || needsAll || !keys.length) {
      this.scheduleUpdate({ force: true });
      return;
    }
    for (const key of keys) {
      this.scheduleUpdate({ key });
    }
  }
}
