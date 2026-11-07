import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';

const formatElevation = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  const rounded = Math.round(numeric * 1000) / 1000;
  const normalized = Number(rounded.toFixed(3));
  const safeValue = Object.is(normalized, -0) ? 0 : normalized;
  return safeValue.toString();
};

export class AssetPlacementShadowPreviewRenderer {
  constructor(manager) {
    this.manager = manager;
    this._textureListener = null;
    this._offsetPreview = null;
    this._frame = null;
    this._pendingSignature = null;
    this._rendering = false;
    this._sequence = 0;
    this._requestedId = 0;
    this._force = false;
  }

  get offsetPreview() {
    return this._offsetPreview;
  }

  _warn(tag, error, context = {}) {
    const payload = {
      ...context,
      error: String(error?.message || error)
    };
    try {
      Logger.warn(tag, payload);
    } catch (loggerError) {
      console.warn?.(tag, payload, loggerError);
    }
  }

  isActive() {
    const manager = this.manager;
    return manager._isGlobalDropShadowEnabled() && manager.isDropShadowEnabled() && !!manager._previewContainer;
  }

  ensureContainer() {
    const container = this.manager._previewContainer;
    if (!container) return null;
    let shadow = container._shadowContainer || null;
    if (!shadow || shadow.destroyed) {
      shadow = new PIXI.Container();
      shadow.sortableChildren = false;
      shadow.eventMode = 'none';
      shadow.visible = false;
      shadow.name = 'fa-nexus-shadow-preview';
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(0.5, 0.5);
      sprite.visible = false;
      sprite.eventMode = 'none';
      shadow.addChild(sprite);
      shadow._sprite = sprite;
      container._shadowContainer = shadow;
      container._shadowSprite = sprite;
      container._shadowRenderTexture = null;
      container._shadowState = null;
    }
    this.syncPlacement(shadow);
    return shadow;
  }

  syncPlacement(shadow = this.manager?._previewContainer?._shadowContainer || null, { reorder = true } = {}) {
    try {
      const manager = this.manager;
      const container = manager?._previewContainer || null;
      if (!container || !shadow || shadow.destroyed) return false;
      let shadowOrder = null;
      if (reorder) {
        const elevation = Number(manager._previewElevation) || 0;
        const sort = Number(manager._previewSort) || 0;
        const renderOrder = manager._resolvePreviewRenderOrder(elevation, sort);
        const shadowManager = manager._getAssetShadowManager();
        if (typeof shadowManager?.resolvePreviewShadowLayerOrder !== 'function') {
          throw new Error('Asset shadow manager cannot resolve placement preview ordering.');
        }
        shadowOrder = shadowManager.resolvePreviewShadowLayerOrder({
          elevation,
          sort,
          renderOrder
        });
      }
      const parent = shadowOrder?.parent || shadow.parent || canvas?.primary || canvas?.stage || null;
      if (!parent?.addChild || typeof container.getGlobalPosition !== 'function' || typeof parent.toLocal !== 'function') {
        throw new Error('Canvas preview shadow coordinate space is unavailable.');
      }
      const globalPosition = container.getGlobalPosition();
      if (shadow.parent !== parent) {
        shadow.parent?.removeChild?.(shadow);
        parent.addChild(shadow);
      }
      const localPosition = parent.toLocal(globalPosition);
      shadow.position.set(
        Number(localPosition?.x ?? container.x) || 0,
        Number(localPosition?.y ?? container.y) || 0
      );
      if (shadowOrder) {
        shadow.sortLayer = shadowOrder.sortLayer;
        shadow.sort = shadowOrder.sort;
        shadow.faNexusSort = shadowOrder.sort;
        shadow.zIndex = shadowOrder.sort;
        shadow.elevation = shadowOrder.elevation;
        shadow.faNexusElevation = shadowOrder.elevation;
        shadow.faNexusElevationDoc = shadowOrder.documentElevation;
        shadow.faNexusPlacementLevelId = shadowOrder.placementLevelId || null;
        shadow.faNexusBandKind = shadowOrder.kind || 'normal';
      }
      shadow.visible = this.isActive() && container.visible !== false;
      if (shadowOrder) {
        if ('sortDirty' in parent) parent.sortDirty = true;
        parent.sortChildren?.();
      }
      return true;
    } catch (error) {
      this._warn('Placement.previewShadow.syncPlacement.failed', error);
      throw error;
    }
  }

  resetTextureListener() {
    this._removeTextureReadyListener();
  }

  _removeTextureReadyListener() {
    const listener = this._textureListener;
    this._textureListener = null;
    if (!listener) return;
    const baseTexture = listener.baseTexture || null;
    const handler = listener.handler || listener;
    if (!baseTexture || typeof handler !== 'function') return;
    for (const eventName of ['loaded', 'update']) {
      try {
        if (typeof baseTexture.off === 'function') baseTexture.off(eventName, handler);
        else if (typeof baseTexture.removeListener === 'function') baseTexture.removeListener(eventName, handler);
      } catch (error) {
        this._warn('Placement.previewShadow.textureReadyListenerRemove.failed', error, { eventName });
      }
    }
  }

  _registerTextureReadyListener(baseTexture, callback) {
    if (!baseTexture || typeof baseTexture.once !== 'function') return false;
    if (this._textureListener?.baseTexture === baseTexture) return true;
    this._removeTextureReadyListener();
    let fired = false;
    const handler = () => {
      if (fired) return;
      fired = true;
      this._removeTextureReadyListener();
      callback();
    };
    this._textureListener = { baseTexture, handler };
    try {
      baseTexture.once('loaded', handler);
      baseTexture.once('update', handler);
    } catch (error) {
      this._removeTextureReadyListener();
      this._warn('Placement.previewShadow.textureReadyListenerRegister.failed', error);
      return false;
    }
    return true;
  }

  update({ force = false } = {}) {
    try {
      const manager = this.manager;
      const container = manager._previewContainer;
      if (!container) return;
      if (!this.isActive()) {
        if (container._shadowContainer) container._shadowContainer.visible = false;
        this.scheduleOffsetPreviewUpdate({ force });
        return;
      }
      const sprite = container._sprite;
      if (!sprite || !sprite.texture) return;
      const texture = sprite.texture;
      const baseTexture = texture.baseTexture;
      if (baseTexture && !baseTexture.valid) {
        this._registerTextureReadyListener(baseTexture, () => this.update({ force: true }));
        return;
      }

      const renderer = canvas?.app?.renderer;
      if (!renderer) return;

      const worldWidth = Math.abs(Number(sprite.width || 0));
      const worldHeight = Math.abs(Number(sprite.height || 0));
      if (!Number.isFinite(worldWidth) || !Number.isFinite(worldHeight) || worldWidth <= 0 || worldHeight <= 0) return;
      const spriteScaleX = Number(sprite.scale?.x ?? 1) || 1;
      const spriteScaleY = Number(sprite.scale?.y ?? 1) || 1;
      const flipX = spriteScaleX < 0 ? -1 : 1;
      const flipY = spriteScaleY < 0 ? -1 : 1;

      const rotation = Number(sprite.rotation || 0);
      const rotated = manager._computeRotatedSpriteBounds(worldWidth, worldHeight, rotation);
      const alpha = Math.min(1, Math.max(0, Number(manager._dropShadowAlpha || 0)));
      const dilation = Math.max(0, Number(manager._dropShadowDilation || 0));
      const blur = Math.max(0, Number(manager._dropShadowBlur || 0));
      const offset = manager._computeShadowOffsetVector();
      const zoom = Math.max(0.1, Number(canvas?.stage?.scale?.x || 1));

      const blurMargin = blur * 12;
      const marginX = Math.abs(offset.x) + dilation + blurMargin;
      const marginY = Math.abs(offset.y) + dilation + blurMargin;
      const paddedWidth = Math.max(8, Math.ceil(rotated.width + marginX * 2));
      const paddedHeight = Math.max(8, Math.ceil(rotated.height + marginY * 2));
      const renderTarget = manager._resolveSafePreviewRenderTarget(paddedWidth, paddedHeight, {
        renderer,
        resolution: 1,
        minSize: 8
      });
      const centerX = paddedWidth / 2;
      const centerY = paddedHeight / 2;

      const signature = `${baseTexture?.uid || baseTexture?.cacheId || 'tex'}:${worldWidth}:${worldHeight}:${rotation}:${alpha}:${dilation}:${blur}:${offset.x}:${offset.y}:${zoom}:${paddedWidth}:${paddedHeight}:${renderTarget.textureWidth}:${renderTarget.textureHeight}:${flipX}:${flipY}`;
      const shadow = this.ensureContainer();
      if (!shadow) return;
      const previousSignature = container._shadowState?.signature || null;
      if (!force && previousSignature === signature) {
        this.scheduleOffsetPreviewUpdate({ force: false });
        return;
      }

      shadow.visible = container.visible !== false;
      shadow.alpha = 1;

      const shadowSprite = container._shadowSprite || shadow._sprite;
      if (!shadowSprite) return;

      const previousRenderTexture = container._shadowRenderTexture || null;
      let renderTexture = previousRenderTexture;
      let replacingRenderTexture = false;
      if (!renderTexture || renderTexture.width !== renderTarget.textureWidth || renderTexture.height !== renderTarget.textureHeight) {
        renderTexture = PIXI.RenderTexture.create({
          width: renderTarget.textureWidth,
          height: renderTarget.textureHeight,
          resolution: renderTarget.resolution,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        replacingRenderTexture = true;
      }

      let drawContainer = new PIXI.Container();
      try {
        if (renderTarget.drawScaleX !== 1 || renderTarget.drawScaleY !== 1) {
          drawContainer.scale.set(renderTarget.drawScaleX, renderTarget.drawScaleY);
        }
        const offsets = manager._buildPreviewDilationOffsets(dilation);
        for (const sample of offsets) {
          const clone = new PIXI.Sprite(texture);
          clone.anchor.set(0.5, 0.5);
          clone.width = worldWidth;
          clone.height = worldHeight;
          if (flipX < 0) clone.scale.x *= -1;
          if (flipY < 0) clone.scale.y *= -1;
          clone.rotation = rotation;
          clone.position.set(centerX + offset.x + sample.x, centerY + offset.y + sample.y);
          clone.alpha = 1;
          drawContainer.addChild(clone);
        }

        try {
          renderer.render(drawContainer, { renderTexture, clear: true });
        } catch (error) {
          if (replacingRenderTexture && renderTexture && !renderTexture.destroyed) {
            try { renderTexture.destroy(true); }
            catch (destroyError) { this._warn('Placement.previewShadow.renderTextureDestroyFailed', destroyError); }
          }
          throw error;
        }
      } finally {
        if (drawContainer) {
          try { drawContainer.destroy({ children: true, texture: false, baseTexture: false }); }
          catch (error) { this._warn('Placement.previewShadow.drawContainerDestroyFailed', error); }
          drawContainer = null;
        }
      }
      if (replacingRenderTexture) {
        container._shadowRenderTexture = renderTexture;
        if (previousRenderTexture && previousRenderTexture !== renderTexture && !previousRenderTexture.destroyed) {
          try { previousRenderTexture.destroy(true); }
          catch (error) { this._warn('Placement.previewShadow.renderTextureDestroyFailed', error); }
        }
      }

      shadowSprite.texture = renderTexture;
      shadowSprite.tint = 0x000000;
      shadowSprite.alpha = alpha;
      shadowSprite.position.set(0, 0);
      shadowSprite.anchor.set(0.5, 0.5);
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
      this.scheduleOffsetPreviewUpdate({ force });
    } catch (error) {
      this._warn('Placement.previewShadow.update.failed', error);
    }
  }

  cleanup(container) {
    if (!container) return;
    if (container._shadowRenderTexture && !container._shadowRenderTexture.destroyed) {
      try { container._shadowRenderTexture.destroy(true); }
      catch (error) { this._warn('Placement.previewShadow.cleanup.renderTextureDestroyFailed', error); }
    }
    container._shadowRenderTexture = null;
    if (container._shadowBlurFilter && !container._shadowBlurFilter.destroyed) {
      try { container._shadowBlurFilter.destroy(); }
      catch (error) { this._warn('Placement.previewShadow.cleanup.blurFilterDestroyFailed', error); }
    }
    container._shadowBlurFilter = null;
    if (container._shadowSprite) {
      try {
        container._shadowSprite.texture = PIXI.Texture.EMPTY;
        container._shadowSprite.visible = false;
        container._shadowSprite.filters = null;
      } catch (error) {
        this._warn('Placement.previewShadow.cleanup.spriteResetFailed', error);
      }
    }
    const shadowContainer = container._shadowContainer || null;
    if (shadowContainer && !shadowContainer.destroyed) {
      try {
        shadowContainer.visible = false;
        shadowContainer.parent?.removeChild?.(shadowContainer);
        shadowContainer.destroy({ children: true, texture: false, baseTexture: false });
      } catch (error) {
        this._warn('Placement.previewShadow.cleanup.containerDestroyFailed', error);
        throw error;
      }
    }
    container._shadowContainer = null;
    container._shadowSprite = null;
    container._shadowState = null;
  }

  computeOffsetPreviewSignature() {
    try {
      const manager = this.manager;
      const container = manager._previewContainer;
      const sprite = container?._sprite;
      if (!container || !sprite) return null;
      const texture = sprite.texture || null;
      const baseTexture = texture?.baseTexture || null;
      const assetKey = (() => {
        if (baseTexture?.uid) return baseTexture.uid;
        if (baseTexture?.cacheId) return baseTexture.cacheId;
        if (texture?.cacheId) return texture.cacheId;
        if (manager.currentAsset) return manager._assetKey(manager.currentAsset);
        return 'fa-nexus-preview';
      })();
      const width = Number(sprite.width || 0).toFixed(3);
      const height = Number(sprite.height || 0).toFixed(3);
      const rotation = Number(sprite.rotation || 0).toFixed(4);
      const scaleX = Number(sprite.scale?.x || 0).toFixed(4);
      const scaleY = Number(sprite.scale?.y || 0).toFixed(4);
      const pendingScale = Number(manager._getPendingScale() || 0).toFixed(4);
      const pendingRotation = Number(manager._getPendingRotation() || 0).toFixed(4);
      const flips = `${manager._pendingFlipHorizontal ? 1 : 0}:${manager._pendingFlipVertical ? 1 : 0}`;
      const dropShadowActive = this.isActive() ? 1 : 0;
      const dropSignature = dropShadowActive
        ? [
            Number(manager._dropShadowAlpha || 0).toFixed(3),
            Number(manager._dropShadowDilation || 0).toFixed(3),
            Number(manager._dropShadowBlur || 0).toFixed(3),
            Number(manager._dropShadowOffsetDistance || 0).toFixed(3),
            Number(manager._dropShadowOffsetAngle || 0).toFixed(3)
          ].join(':')
        : 'off';
      const elevation = formatElevation(manager._previewElevation || 0);
      return `${assetKey}:${width}:${height}:${rotation}:${scaleX}:${scaleY}:${pendingScale}:${pendingRotation}:${flips}:${dropShadowActive}:${dropSignature}:${elevation}`;
    } catch (error) {
      this._warn('Placement.previewShadow.signature.failed', error);
      return null;
    }
  }

  scheduleOffsetPreviewUpdate({ force = false } = {}) {
    try {
      if (typeof window === 'undefined') return;
      const manager = this.manager;
      if (!manager._previewContainer || !manager._previewContainer._sprite) return;
      const signature = this.computeOffsetPreviewSignature();
      const currentSignature = this._offsetPreview?.signature || null;
      if (!force && signature && currentSignature === signature && !this._pendingSignature) return;
      this._pendingSignature = signature;
      if (force) this._force = true;
      const requestId = ++this._sequence;
      this._requestedId = requestId;
      if (this._rendering) return;
      if (this._frame) {
        window.cancelAnimationFrame(this._frame);
      }
      this._frame = window.requestAnimationFrame(() => {
        this._frame = null;
        const pendingSignature = this._pendingSignature;
        const shouldForce = this._force;
        this._pendingSignature = null;
        this._force = false;
        if (!pendingSignature) return;
        this.renderOffsetPreview(pendingSignature, { force: shouldForce, requestId: this._requestedId });
      });
    } catch (error) {
      this._warn('Placement.previewShadow.offsetPreviewSchedule.failed', error);
    }
  }

  renderOffsetPreview(signature, { force = false, requestId = null } = {}) {
    let renderRoot = null;
    let shadowDraw = null;
    let renderTexture = null;
    const createdFilters = [];
    const createdTextures = [];
    const cleanup = () => {
      if (shadowDraw) {
        try { shadowDraw.destroy({ children: true, texture: false, baseTexture: false }); }
        catch (error) { this._warn('Placement.previewShadow.offsetPreviewShadowDrawDestroyFailed', error); }
        shadowDraw = null;
      }
      if (renderRoot) {
        try { renderRoot.destroy({ children: true, texture: false, baseTexture: false }); }
        catch (error) { this._warn('Placement.previewShadow.offsetPreviewRootDestroyFailed', error); }
        renderRoot = null;
      }
      for (const filter of createdFilters) {
        if (filter && typeof filter.destroy === 'function') {
          try { filter.destroy(true); }
          catch (error) { this._warn('Placement.previewShadow.offsetPreviewFilterDestroyFailed', error); }
        }
      }
      createdFilters.length = 0;
      for (const tex of createdTextures) {
        if (tex && !tex.destroyed) {
          try { tex.destroy(true); }
          catch (error) { this._warn('Placement.previewShadow.offsetPreviewTextureDestroyFailed', error); }
        }
      }
      createdTextures.length = 0;
      if (renderTexture && !renderTexture.destroyed) {
        try { renderTexture.destroy(true); }
        catch (error) { this._warn('Placement.previewShadow.offsetPreviewFinalTextureDestroyFailed', error); }
      }
      renderTexture = null;
    };

    try {
      const manager = this.manager;
      const container = manager._previewContainer;
      const sprite = container?._sprite;
      const renderer = canvas?.app?.renderer;
      if (!container || !sprite || !renderer) return;
      const texture = sprite.texture;
      const baseTexture = texture?.baseTexture || null;
      if (!texture || !baseTexture) return;
      if (!baseTexture.valid) {
        this._registerTextureReadyListener(baseTexture, () => this.scheduleOffsetPreviewUpdate({ force: true }));
        return;
      }

      const targetSignature = signature || this.computeOffsetPreviewSignature();
      if (!force && targetSignature && this._offsetPreview?.signature === targetSignature) {
        this._rendering = false;
        return;
      }

      this._rendering = true;
      const renderId = requestId ?? ++this._sequence;

      const circleSize = 160;
      const marginPx = 8;
      const availableSize = circleSize - marginPx * 2;

      const worldWidth = Math.max(0.001, Math.abs(Number(sprite.width || 0)));
      const worldHeight = Math.max(0.001, Math.abs(Number(sprite.height || 0)));
      const spriteScaleX = Number(sprite.scale?.x ?? 1) || 1;
      const spriteScaleY = Number(sprite.scale?.y ?? 1) || 1;
      const flipX = spriteScaleX < 0 ? -1 : 1;
      const flipY = spriteScaleY < 0 ? -1 : 1;
      const rotation = Number(sprite.rotation || 0);
      const rotated = manager._computeRotatedSpriteBounds(worldWidth, worldHeight, rotation);
      const alpha = Math.min(1, Math.max(0, Number(manager._dropShadowAlpha || 0)));
      const dilation = Math.max(0, Number(manager._dropShadowDilation || 0));
      const blur = Math.max(0, Number(manager._dropShadowBlur || 0));
      const offset = manager._computeShadowOffsetVector();
      const blurMargin = blur * 12;
      const marginWorldX = Math.abs(offset.x) + dilation + blurMargin;
      const marginWorldY = Math.abs(offset.y) + dilation + blurMargin;
      const fitWidth = rotated.width + marginWorldX * 2;
      const fitHeight = rotated.height + marginWorldY * 2;
      const baseScale = availableSize / Math.max(rotated.width, rotated.height);
      const fitScale = availableSize / Math.max(fitWidth, fitHeight);
      const minScale = baseScale * 0.68;
      const scale = Math.max(minScale, Math.min(baseScale, fitScale));

      renderRoot = new PIXI.Container();
      renderRoot.sortableChildren = false;

      const center = circleSize / 2;
      const sourceTint = typeof sprite.tint === 'number' ? sprite.tint : null;
      const buildClone = () => {
        const clone = new PIXI.Sprite(texture);
        clone.anchor.set(0.5, 0.5);
        clone.width = worldWidth;
        clone.height = worldHeight;
        clone.rotation = rotation;
        clone.scale.x *= flipX;
        clone.scale.y *= flipY;
        if (sourceTint != null) clone.tint = sourceTint;
        return clone;
      };

      const dropShadowActive = this.isActive();
      if (dropShadowActive) {
        shadowDraw = new PIXI.Container();
        shadowDraw.position.set(center, center);
        shadowDraw.scale.set(scale);
        const dilationSamples = manager._buildPreviewDilationOffsets(dilation);
        for (const sample of dilationSamples) {
          const clone = buildClone();
          clone.position.set(offset.x + sample.x, offset.y + sample.y);
          clone.tint = 0x000000;
          clone.alpha = 1;
          shadowDraw.addChild(clone);
        }
        if (blur > 0) {
          const filter = new PIXI.BlurFilter();
          filter.quality = 4;
          filter.repeatEdgePixels = true;
          filter.blur = Math.max(0.25, blur * scale);
          shadowDraw.filters = [filter];
          createdFilters.push(filter);
        }
        const shadowTexture = PIXI.RenderTexture.create({
          width: circleSize,
          height: circleSize,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        renderer.render(shadowDraw, { renderTexture: shadowTexture, clear: true });
        const shadowSprite = new PIXI.Sprite(shadowTexture);
        shadowSprite.anchor.set(0.5, 0.5);
        shadowSprite.position.set(center, center);
        shadowSprite.tint = 0x000000;
        shadowSprite.alpha = alpha;
        shadowSprite.blendMode = PIXI.BLEND_MODES.NORMAL;
        renderRoot.addChild(shadowSprite);
        createdTextures.push(shadowTexture);
        try { shadowDraw.destroy({ children: true, texture: false, baseTexture: false }); }
        catch (error) { this._warn('Placement.previewShadow.offsetPreviewShadowDrawDestroyFailed', error); }
        shadowDraw = null;
      }

      const assetContainer = new PIXI.Container();
      assetContainer.position.set(center, center);
      assetContainer.scale.set(scale);

      const assetClone = buildClone();
      assetClone.position.set(0, 0);
      assetClone.alpha = 1;
      assetContainer.addChild(assetClone);

      renderRoot.addChild(assetContainer);

      renderTexture = PIXI.RenderTexture.create({
        width: circleSize,
        height: circleSize,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      renderer.render(renderRoot, { renderTexture, clear: true });
      const extraction = renderer.extract?.base64?.(renderTexture);

      const finalize = (dataUrl, ok = true) => {
        cleanup();
        const latestRequested = this._requestedId;
        const hasPending = this._pendingSignature != null;
        if (ok && renderId === latestRequested && !hasPending && typeof dataUrl === 'string' && dataUrl.length) {
          const previewData = {
            src: dataUrl,
            width: circleSize,
            height: circleSize,
            signature: targetSignature || null,
            updatedAt: typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(),
            alt: 'Asset drop shadow preview'
          };
          this._offsetPreview = previewData;
          try { toolOptionsController.updateDropShadowPreview('asset.placement', previewData); }
          catch (error) { this._warn('Placement.previewShadow.offsetPreviewNotify.failed', error); }
        }
        this._rendering = false;
        if (this._pendingSignature) {
          this.scheduleOffsetPreviewUpdate({ force: this._force });
        }
      };

      if (extraction && typeof extraction.then === 'function') {
        extraction
          .then((dataUrl) => finalize(dataUrl, true))
          .catch((error) => {
            this._warn('Placement.previewShadow.offsetPreviewExtract.failed', error);
            finalize(null, false);
          });
      } else {
        finalize(extraction, true);
      }
    } catch (error) {
      cleanup();
      this._rendering = false;
      this._warn('Placement.previewShadow.offsetPreviewRender.failed', error);
    }
  }

  clearOffsetPreview({ notify = true } = {}) {
    try {
      if (this._frame && typeof window !== 'undefined') {
        window.cancelAnimationFrame(this._frame);
        this._frame = null;
      }
    } catch (error) {
      this._frame = null;
      this._warn('Placement.previewShadow.offsetPreviewCancelFrame.failed', error);
    }
    this._pendingSignature = null;
    this._force = false;
    this._requestedId = ++this._sequence;
    this._rendering = false;
    if (notify) {
      try { toolOptionsController.updateDropShadowPreview('asset.placement', null); }
      catch (error) { this._warn('Placement.previewShadow.offsetPreviewClearNotify.failed', error); }
    }
    this._offsetPreview = null;
  }
}
