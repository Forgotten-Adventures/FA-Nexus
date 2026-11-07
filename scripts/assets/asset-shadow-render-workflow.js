import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { MIN_POINTS_TO_RENDER as PATH_MIN_POINTS } from '../paths/path-geometry.js';

// Scatter stamps use the active quality ceiling; this guard only prevents runaway sizes above the
// current highest experimental tier and still respects the detected GPU cap.
const SHADOW_BLANK_VALIDATION_MAX_PIXELS = 4_000_000;
const SHADOW_BLANK_RECOVERY_COOLDOWN_MS = 10_000;

export class AssetShadowRenderWorkflow {
  constructor(manager) {
    this.manager = manager;
  }

  async buildLayerDrawContainer(entries, context = {}) {
    const manager = this.manager;
    const drawContainer = new PIXI.Container();
    const renderer = context.renderer || manager._renderer;
    const scale = Number(context.scale) || 1;
    const sr = context.sceneRect || manager._sceneRect || { x: 0, y: 0 };
    const assertCurrentRebuild = typeof context.assertCurrentRebuild === 'function'
      ? context.assertCurrentRebuild
      : () => {};
    const tempDisplayObjects = Array.isArray(context.tempDisplayObjects) ? context.tempDisplayObjects : [];
    const tempTextures = Array.isArray(context.tempTextures) ? context.tempTextures : [];
    const tempTextureViews = Array.isArray(context.tempTextureViews) ? context.tempTextureViews : [];
    const dilationCache = new Map();

    const getOffsetsForRadius = (radius) => {
      const key = Number.isFinite(radius) ? radius.toFixed(3) : '0';
      if (dilationCache.has(key)) return dilationCache.get(key);
      const list = manager._buildDilationOffsets(radius);
      dilationCache.set(key, list);
      return list;
    };

    for (const entry of Array.isArray(entries) ? entries : []) {
      const { doc, config: cfg, paths } = entry || {};
      if (!doc || !cfg) continue;
      const descriptors = Array.isArray(paths) ? paths.filter(Boolean) : [];
      try {
        const dilationRadius = Math.max(0, Number(cfg.dilation || 0)) * scale;
        const offsets = getOffsetsForRadius(dilationRadius);
        const offsetXScaled = Number(cfg.offsetX ?? 0) * scale;
        const offsetYScaled = Number(cfg.offsetY ?? 0) * scale;
        const applyOffsetX = offsetXScaled;
        const applyOffsetY = offsetYScaled;

        const standardMaskFlags = manager._readStandardTileMask(doc);
        let standardMaskShadowStamp = null;
        const getStandardMaskShadowStamp = async () => {
          if (!standardMaskFlags) return null;
          if (standardMaskShadowStamp) return standardMaskShadowStamp;
          standardMaskShadowStamp = await manager._getStandardMaskShadowStamp(doc, renderer);
          assertCurrentRebuild();
          if (!standardMaskShadowStamp?.texture) {
            Logger.error('AssetShadow.standardTileMask.shadowStampFailed', {
              tileId: doc?.id,
              src: doc?.texture?.src || null
            });
            return null;
          }
          return standardMaskShadowStamp;
        };

        if (descriptors.length) {
          await this._renderDescriptorShadows({
            doc,
            cfg,
            descriptors,
            renderer,
            scale,
            sceneRect: sr,
            standardMaskFlags,
            dilationRadius,
            offsets,
            applyOffsetX,
            applyOffsetY,
            getOffsetsForRadius,
            drawContainer,
            tempDisplayObjects,
            tempTextures,
            tempTextureViews,
            assertCurrentRebuild
          });
          continue;
        }

        if (standardMaskFlags) {
          const standardStamp = await getStandardMaskShadowStamp();
          if (!standardStamp?.texture) continue;
          const texScaleX = Number(doc?.texture?.scaleX ?? 1) || 1;
          const texScaleY = Number(doc?.texture?.scaleY ?? 1) || 1;
          for (const offset of offsets) {
            const sprite = manager._createDocShadowSprite(standardStamp.texture, doc, standardStamp.bounds, {
              scale,
              sceneRect: sr,
              offsetX: offset.x + applyOffsetX,
              offsetY: offset.y + applyOffsetY,
              flipX: texScaleX,
              flipY: texScaleY,
              anchorMode: 'doc'
            });
            if (!sprite) continue;
            drawContainer.addChild(sprite);
            tempDisplayObjects.push(sprite);
          }
          continue;
        }

        const scatterStamp = await manager._getScatterShadowStamp(doc, cfg, scale, renderer);
        assertCurrentRebuild();
        if (scatterStamp?.texture || Array.isArray(scatterStamp?.chunks)) {
          const chunks = Array.isArray(scatterStamp.chunks) && scatterStamp.chunks.length
            ? scatterStamp.chunks
            : [{ texture: scatterStamp.texture, bounds: scatterStamp.bounds }];
          const stampOffsets = Array.isArray(scatterStamp.offsets) && scatterStamp.offsets.length
            ? scatterStamp.offsets
            : [{ x: 0, y: 0 }];
          for (const chunk of chunks) {
            if (!chunk?.texture || !chunk?.bounds) continue;
            for (const stampOffset of stampOffsets) {
              const sprite = manager._createDocShadowSprite(chunk.texture, doc, chunk.bounds, {
                scale,
                sceneRect: sr,
                offsetX: applyOffsetX + (Number(stampOffset?.x || 0) || 0),
                offsetY: applyOffsetY + (Number(stampOffset?.y || 0) || 0),
                anchorMode: 'doc'
              });
              if (sprite) {
                drawContainer.addChild(sprite);
                tempDisplayObjects.push(sprite);
              }
            }
          }
          continue;
        }

        // Building tiles with path-shadow geometry enabled can legitimately have no drawable wall
        // loops after 100% gaps (e.g. freestanding portals). In that case, don't fall back to a
        // rectangle sprite shadow, as it will incorrectly shadow the portal itself.
        if (manager._usesBuildingShadowGeometry(doc)) continue;

        const tex = await manager._obtainTexture(doc?.texture?.src);
        assertCurrentRebuild();
        if (!tex) continue;
        const texScaleX = Number(doc?.texture?.scaleX ?? 1) || 1;
        const texScaleY = Number(doc?.texture?.scaleY ?? 1) || 1;
        const { width: docWidth, height: docHeight } = manager._getDocDimensions(doc);

        for (const offset of offsets) {
          const sprite = manager._createDocShadowSprite(tex, doc, {
            x: 0,
            y: 0,
            width: docWidth,
            height: docHeight
          }, {
            scale,
            sceneRect: sr,
            offsetX: offset.x + applyOffsetX,
            offsetY: offset.y + applyOffsetY,
            flipX: texScaleX,
            flipY: texScaleY,
            anchorMode: 'doc'
          });
          if (!sprite) continue;
          drawContainer.addChild(sprite);
          tempDisplayObjects.push(sprite);
        }
      } catch (e) {
        if (e?.faNexusStaleRebuild) throw e;
        Logger.warn('AssetShadow.sprite.failed', String(e?.message || e));
      }
    }

    return drawContainer;
  }

  async _renderDescriptorShadows({
    doc,
    cfg,
    descriptors,
    renderer,
    scale,
    sceneRect,
    standardMaskFlags,
    dilationRadius,
    offsets,
    applyOffsetX,
    applyOffsetY,
    getOffsetsForRadius,
    drawContainer,
    tempDisplayObjects,
    tempTextures,
    tempTextureViews,
    assertCurrentRebuild
  }) {
    const manager = this.manager;
    const standardStamp = standardMaskFlags ? await manager._getStandardMaskClipStamp(doc, renderer) : null;
    if (standardMaskFlags) {
      if (!standardStamp?.texture) return;
      const descriptorDilation = descriptors.reduce((max, descriptor) => Math.max(max, Number(descriptor?.shadowDilation || 0)), 0);
      const pathMaskedSpread = descriptors.some((descriptor) => descriptor?.kind !== 'building')
        ? Math.max(Number(cfg.dilation || 0), descriptorDilation)
        : 0;
      const maskedStamp = await manager._createMaskedDescriptorShadowStamp(doc, descriptors, standardStamp, renderer, {
        scale,
        applyMask: true,
        dilation: pathMaskedSpread
      });
      assertCurrentRebuild();
      if (!maskedStamp?.texture) {
        Logger.error('AssetShadow.standardTileMask.descriptorStampFailed', {
          tileId: doc?.id
        });
        try { standardStamp.texture.destroy(true); } catch (_) {}
        return;
      }
      tempTextures.push(maskedStamp.texture);
      const maskedOffsets = pathMaskedSpread > 0
        ? [{ x: 0, y: 0 }]
        : getOffsetsForRadius(Math.max(dilationRadius, descriptorDilation * scale));
      for (const offset of maskedOffsets) {
        const sprite = manager._createWorldBoundsShadowSprite(maskedStamp.texture, maskedStamp.bounds, {
          scale,
          sceneRect,
          offsetX: offset.x + applyOffsetX,
          offsetY: offset.y + applyOffsetY
        });
        if (!sprite) continue;
        drawContainer.addChild(sprite);
        tempDisplayObjects.push(sprite);
      }
      tempTextures.push(standardStamp.texture);
      return;
    }

    for (const descriptor of descriptors) {
      if (!descriptor) continue;
      const isBuilding = descriptor.kind === 'building';
      const isBuildingCompositeSprite = descriptor.kind === 'buildingCompositeSprite';
      if (!isBuilding && !isBuildingCompositeSprite && (!Array.isArray(descriptor.samples) || descriptor.samples.length < PATH_MIN_POINTS)) continue;
      const descriptorOffsets = descriptor.resolvedShadow === true ? [{ x: 0, y: 0 }] : offsets;
      for (const offset of descriptorOffsets) {
        let displayObject = null;
        if (isBuilding) {
          displayObject = await manager._createBuildingShadowMesh(descriptor, {
            scale,
            sceneRect,
            dilationOffset: offset,
            offsetX: applyOffsetX,
            offsetY: applyOffsetY
          });
        } else if (isBuildingCompositeSprite) {
          displayObject = await manager._createBuildingCompositePartShadowSprite(descriptor, {
            scale,
            sceneRect,
            dilationOffset: offset,
            offsetX: descriptor.resolvedShadow === true ? 0 : applyOffsetX,
            offsetY: descriptor.resolvedShadow === true ? 0 : applyOffsetY,
            tempTextures: tempTextureViews
          });
        } else {
          displayObject = await manager._createPathShadowMesh(descriptor, {
            scale,
            sceneRect,
            dilationOffset: offset,
            offsetX: applyOffsetX,
            offsetY: applyOffsetY
          });
        }
        try { assertCurrentRebuild(); }
        catch (error) {
          try { displayObject?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
          throw error;
        }
        if (!displayObject) continue;
        drawContainer.addChild(displayObject);
        tempDisplayObjects.push(displayObject);
      }
    }
  }

  renderLayerToTexture(layer, drawContainer, renderer, texWidth, texHeight, context = {}) {
    const manager = this.manager;
    try {
      if (layer?.container) layer.container.filters = null;
      const target = context?.renderTarget || layer;
      const scale = Number(context?.scale) || 1;
      const options = context?.layerOptions || layer?.options || {};
      const blurAmount = Math.max(0, Number(options.blur || 0));
      const blurPixels = blurAmount * scale;

      let renderTexture = target.renderTexture || null;
      if (!renderTexture || renderTexture.destroyed || renderTexture.width !== texWidth || renderTexture.height !== texHeight) {
        if (renderTexture && !renderTexture.destroyed) {
          try { renderTexture.destroy(true); } catch (_) {}
        }
        renderTexture = PIXI.RenderTexture.create({
          width: texWidth,
          height: texHeight,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        target.renderTexture = renderTexture;
      }

      if (blurPixels <= 0.01) {
        if (target.rawRenderTexture && !target.rawRenderTexture.destroyed) {
          try { target.rawRenderTexture.destroy(true); } catch (_) {}
        }
        target.rawRenderTexture = null;
        renderer.render(drawContainer, { renderTexture, clear: true });
        if (target === layer || context?.setLayerPrimary) layer.renderTexture = renderTexture;
        return renderTexture;
      }

      let rawRenderTexture = target.rawRenderTexture || null;
      if (!rawRenderTexture || rawRenderTexture.destroyed || rawRenderTexture.width !== texWidth || rawRenderTexture.height !== texHeight) {
        if (rawRenderTexture && !rawRenderTexture.destroyed) {
          try { rawRenderTexture.destroy(true); } catch (_) {}
        }
        rawRenderTexture = PIXI.RenderTexture.create({
          width: texWidth,
          height: texHeight,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        target.rawRenderTexture = rawRenderTexture;
      }

      renderer.render(drawContainer, { renderTexture: rawRenderTexture, clear: true });

      const blur = new PIXI.BlurFilter();
      blur.blur = Math.min(64, Math.max(0.25, blurPixels));
      blur.quality = manager._computeBlurQuality(blur.blur);
      blur.repeatEdgePixels = true;
      try {
        blur.padding = Math.ceil((blur.blur * 12) + Math.max(0, Number(options?.maxDilation || options?.dilation || 0)) + 4);
      } catch (_) {}

      const blurSprite = new PIXI.Sprite(rawRenderTexture);
      blurSprite.anchor.set(0, 0);
      blurSprite.position.set(0, 0);
      blurSprite.width = texWidth;
      blurSprite.height = texHeight;
      blurSprite.eventMode = 'none';
      blurSprite.filters = [blur];
      try {
        blurSprite.filterArea = new PIXI.Rectangle(0, 0, texWidth, texHeight);
      } catch (_) {}

      try {
        renderer.render(blurSprite, { renderTexture, clear: true });
      } finally {
        try { blurSprite.filters = null; } catch (_) {}
        try { blur.destroy(); } catch (_) {}
        try { blurSprite.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      if (target === layer || context?.setLayerPrimary) layer.renderTexture = renderTexture;
      return renderTexture;
    } catch (error) {
      Logger.warn('AssetShadow.renderTexture.failed', String(error?.message || error));
      return null;
    }
  }

  isLayerRenderTextureBlank(renderTexture, renderer, context = {}) {
    const manager = this.manager;
    try {
      const childCount = Number(context?.childCount || 0);
      if (!renderTexture || renderTexture.destroyed || !renderer || childCount <= 0) return false;
      if (manager._blankRenderValidationBudget <= 0) return false;
      manager._blankRenderValidationBudget -= 1;

      const width = Math.max(0, Math.round(Number(renderTexture.width || 0)));
      const height = Math.max(0, Math.round(Number(renderTexture.height || 0)));
      const pixelCount = width * height;
      if (!width || !height || !Number.isFinite(pixelCount)) return false;
      if (pixelCount > SHADOW_BLANK_VALIDATION_MAX_PIXELS) {
        Logger.debug?.('AssetShadow.renderTexture.blankValidationSkipped', {
          elevation: context?.elevation,
          sceneId: context?.sceneId,
          generation: context?.generation,
          width,
          height,
          pixelCount,
          maxPixels: SHADOW_BLANK_VALIDATION_MAX_PIXELS
        });
        return false;
      }

      const pixels = renderer.extract?.pixels?.(renderTexture);
      if (!pixels) return false;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 0) return false;
      }
      return true;
    } catch (error) {
      Logger.warn('AssetShadow.renderTexture.blankValidationFailed', {
        error: String(error?.message || error),
        elevation: context?.elevation,
        sceneId: context?.sceneId,
        generation: context?.generation
      });
      return false;
    }
  }

  handleBlankLayerRender(elevation, details = {}) {
    const manager = this.manager;
    try {
      const now = Date.now();
      const payload = {
        elevation,
        sceneId: details.sceneId || manager._sceneId || manager._getActiveSceneId(),
        generation: details.generation ?? manager._sceneGeneration,
        childCount: Number(details.childCount || 0),
        width: Number(details.width || 0),
        height: Number(details.height || 0),
        tileIds: Array.isArray(details.tileIds) ? details.tileIds : []
      };
      if (manager._blankLayerRecoveryActive || now < manager._blankLayerRecoveryCooldownUntil) {
        Logger.error('AssetShadow.renderTexture.blankAfterRecovery', payload);
        return;
      }
      manager._blankLayerRecoveryActive = true;
      manager._blankLayerRecoveryCooldownUntil = now + SHADOW_BLANK_RECOVERY_COOLDOWN_MS;
      Logger.warn('AssetShadow.renderTexture.blankDetected', payload);
      setTimeout(() => {
        manager._blankLayerRecoveryActive = false;
        manager._recoverRendererResources('blank-render-texture');
      }, 0);
    } catch (error) {
      Logger.error('AssetShadow.renderTexture.blankRecoveryFailed', {
        elevation,
        error: String(error?.message || error)
      });
    }
  }

  applyLayerTexture(layer, sceneRect, renderTexture, scale) {
    const manager = this.manager;
    try {
      if (!layer || !sceneRect || !renderTexture || renderTexture.destroyed) return;
      if (layer.container?.destroyed) return;
      const sprite = layer.sprite;
      if (!sprite) return;
      if (sprite.destroyed || !sprite.position || !sprite.scale) return;
      sprite.texture = renderTexture;
      sprite.position.set(sceneRect.x, sceneRect.y);
      const invScale = scale ? 1 / scale : 1;
      sprite.scale.set(invScale, invScale);
      sprite.tint = 0x000000;
      sprite.alpha = Number(layer.options.alpha || 0.35);
      sprite.visible = true;

      if (layer.container) layer.container.filters = null;
      manager._syncShadowLayerFilters(layer);
    } catch (e) {
      Logger.warn('AssetShadow.applyTexture.failed', String(e?.message || e));
    }
  }

  applyLayerChunkTexture(layer, chunk, sceneRect, renderTexture, scale) {
    const manager = this.manager;
    try {
      if (!layer || !chunk || !sceneRect || !renderTexture || renderTexture.destroyed) return;
      if (layer.container?.destroyed) return;
      const sprite = chunk.sprite;
      if (!sprite || sprite.destroyed || !sprite.position || !sprite.scale) return;
      sprite.texture = renderTexture;
      sprite.position.set(sceneRect.x, sceneRect.y);
      const invScale = scale ? 1 / scale : 1;
      sprite.scale.set(invScale, invScale);
      sprite.tint = 0x000000;
      sprite.alpha = Number(chunk.options?.alpha ?? layer.options.alpha ?? 0.35);
      sprite.visible = true;
      sprite.renderable = true;
      chunk.sceneRect = sceneRect;
      chunk.scale = scale;
      if (!layer.renderTexture || layer.renderTexture.destroyed) layer.renderTexture = renderTexture;

      if (layer.container) layer.container.filters = null;
      manager._syncShadowLayerFilters(layer);
      manager._previewSuppressionController?.applyChunkVisibility?.(layer.key, chunk);
    } catch (e) {
      Logger.warn('AssetShadow.applyChunkTexture.failed', String(e?.message || e));
    }
  }

  syncLayerRenderChunks(layer, renderChunks) {
    const manager = this.manager;
    const chunkList = Array.isArray(renderChunks) ? renderChunks : [];
    if (!layer.renderChunks) layer.renderChunks = new Map();
    const activeKeys = new Set(chunkList.map((chunk) => String(chunk?.key || '')).filter(Boolean));

    for (const [key, chunk] of Array.from(layer.renderChunks.entries())) {
      if (activeKeys.has(key)) continue;
      this.destroyLayerRenderChunk(layer, chunk);
      layer.renderChunks.delete(key);
    }

    for (const chunkInfo of chunkList) {
      const key = String(chunkInfo?.key || '').trim();
      if (!key) continue;
      if (!layer.renderChunks.has(key)) {
        layer.renderChunks.set(key, this.createLayerRenderChunk(layer, key));
      }
    }

    const ordered = new Map();
    for (const chunkInfo of chunkList) {
      const key = String(chunkInfo?.key || '').trim();
      const chunk = layer.renderChunks.get(key);
      if (!key || !chunk) continue;
      const tileIds = Array.isArray(chunkInfo?.entries)
        ? chunkInfo.entries.map((entry) => entry?.doc?.id || entry?.doc?._id).filter(Boolean)
        : [];
      chunk.shadowEntryKeys = new Set((chunkInfo?.entries || [])
        .map((entry) => String(entry?.shadowEntryKey || '').trim())
        .filter(Boolean));
      manager._previewSuppressionController?.syncChunk?.(layer.key, chunk, tileIds);
      ordered.set(key, chunk);
      try { layer.container?.addChild?.(chunk.sprite); } catch (_) {}
    }
    layer.renderChunks = ordered;

    const first = ordered.values().next().value || null;
    layer.renderTexture = first?.renderTexture || null;
    return ordered;
  }

  createLayerRenderChunk(layer, key) {
    const manager = this.manager;
    const occlusionMesh = manager._shouldLayerUseShadowOcclusion(layer)
      ? manager._createShadowOcclusionChunkMesh(layer, key)
      : null;
    const sprite = occlusionMesh || new PIXI.Sprite(PIXI.Texture.EMPTY);
    sprite.anchor.set(0, 0);
    sprite.visible = false;
    sprite.eventMode = 'none';
    sprite.name = `fa-nexus-shadow-chunk:${key}`;
    try { layer.container?.addChild?.(sprite); } catch (_) {}
    return {
      key,
      sprite,
      renderTexture: null,
      tileIds: new Set(),
      shadowEntryKeys: new Set(),
      rawRenderTexture: null,
      occlusionFilter: null,
      blurFilter: null,
      usesOcclusionMesh: !!occlusionMesh,
      sceneRect: null,
      scale: 1
    };
  }

  destroyRenderResource(resource, destroyTexture = false) {
    if (!resource || resource.destroyed) return;
    try {
      if (destroyTexture) resource.destroy(true);
      else resource.destroy();
    } catch (_) {}
  }

  hideLayerRenderChunk(layer, chunk) {
    try {
      if (!chunk?.sprite || chunk.sprite.destroyed) return;
      const previousTexture = chunk.renderTexture || null;
      chunk.sprite.visible = false;
      chunk.sprite.filters = null;
      this.destroyRenderResource(chunk.occlusionFilter);
      chunk.occlusionFilter = null;
      this.destroyRenderResource(chunk.renderTexture, true);
      this.destroyRenderResource(chunk.rawRenderTexture, true);
      chunk.renderTexture = null;
      chunk.rawRenderTexture = null;
      if (layer?.renderTexture === previousTexture) layer.renderTexture = null;
    } catch (_) {}
  }

  destroyLayerRenderChunk(layer, chunk) {
    if (!chunk) return;
    const previousTexture = chunk.renderTexture || null;
    try { chunk.sprite && (chunk.sprite.filters = null); } catch (_) {}
    this.destroyRenderResource(chunk.renderTexture, true);
    this.destroyRenderResource(chunk.rawRenderTexture, true);
    this.destroyRenderResource(chunk.blurFilter);
    this.destroyRenderResource(chunk.occlusionFilter);
    try { chunk.sprite?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    chunk.renderTexture = null;
    chunk.rawRenderTexture = null;
    if (layer?.renderTexture === previousTexture) layer.renderTexture = null;
  }
}
