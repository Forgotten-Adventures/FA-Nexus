import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { BuildingWallMesher } from '../buildings/building-wall-mesher.js';
import { cloneDisplayObjectForProxy } from '../canvas/display-object-proxy.js';
import { applyStandardTileMaskToTile } from '../textures/texture-mask-runtime.js';
import { SCATTER_SHADOW_CHUNK_BLEED } from './asset-shadow-bounds.js';
import {
  applyScatterInstanceTransformToSprite,
  resolveScatterInstanceAffine
} from './asset-scatter-instance-transform.js';
import {
  createMeshFromSamples as createPathMesh,
  createPathShader,
  MIN_POINTS_TO_RENDER as PATH_MIN_POINTS
} from '../paths/path-geometry.js';

const SCATTER_VERSION = 1;

function normalizeLayerOpacity(value, fallback = 1) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.min(1, Math.max(0, numeric));
  const fallbackNumeric = Number(fallback);
  if (Number.isFinite(fallbackNumeric)) return Math.min(1, Math.max(0, fallbackNumeric));
  return 1;
}

export class AssetShadowRenderPrimitives {
  constructor(manager) {
    this.manager = manager;
  }



  async getStandardMaskClipStamp(doc, renderer) {
    const manager = this.manager;
    try {
      const tileId = doc?.id;
      if (!tileId || !renderer) return null;
      const flags = manager._readStandardTileMask(doc);
      if (!flags) return null;
      const tile = canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === tileId) || null;
      if (!tile) {
        Logger.error('AssetShadow.standardTileMask.clipTileMissing', { tileId });
        return null;
      }

      await applyStandardTileMaskToTile(tile);
      const { sourceMask } = await manager._waitForStandardMaskOverlay(tile, { tileId });
      if (!sourceMask || sourceMask.destroyed) {
        Logger.error('AssetShadow.standardTileMask.clipMaskMissing', { tileId });
        return null;
      }

      const proxyMask = cloneDisplayObjectForProxy(sourceMask);
      if (!proxyMask || proxyMask.destroyed) {
        Logger.error('AssetShadow.standardTileMask.clipProxyFailed', { tileId });
        return null;
      }
      try { proxyMask.visible = true; } catch (_) {}
      try { proxyMask.renderable = true; } catch (_) {}
      try { proxyMask.alpha = 1; } catch (_) {}

      const { width: docWidth, height: docHeight } = manager._getDocDimensions(doc);
      const maxTex = manager._getMaxTextureSize();
      const renderScale = Math.min(1, maxTex / Math.max(docWidth, docHeight));
      const pixelWidth = Math.max(4, Math.ceil(docWidth * renderScale));
      const pixelHeight = Math.max(4, Math.ceil(docHeight * renderScale));
      if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) {
        try { proxyMask.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        return null;
      }

      const renderTexture = PIXI.RenderTexture.create({
        width: pixelWidth,
        height: pixelHeight,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      const stage = new PIXI.Container();
      stage.eventMode = 'none';
      stage.sortableChildren = false;
      stage.interactiveChildren = false;
      stage.scale.set(renderScale, renderScale);
      stage.addChild(proxyMask);
      renderer.render(stage, { renderTexture, clear: true });

      try { proxyMask.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      try { stage.destroy({ children: false }); } catch (_) {}

      return {
        texture: renderTexture,
        bounds: { x: 0, y: 0, width: docWidth, height: docHeight },
        scale: renderScale
      };
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.clipStamp.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }



  async getStandardMaskShadowStamp(doc, renderer) {
    const manager = this.manager;
    try {
      const tileId = doc?.id;
      if (!tileId || !renderer) return null;
      const flags = manager._readStandardTileMask(doc);
      if (!flags) {
        manager._clearStandardMaskShadowCache(tileId);
        return null;
      }

      const signature = manager._buildStandardMaskShadowSignature(doc, flags);
      const cached = manager._standardMaskShadowCache.get(tileId);
      if (cached && cached.signature === signature && cached.texture && !cached.texture.destroyed) {
        return cached;
      }
      if (cached) manager._clearStandardMaskShadowCache(tileId);

      const tile = canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === tileId) || null;
      if (!tile) {
        Logger.error('AssetShadow.standardTileMask.tileMissing', { tileId });
        return null;
      }

      await applyStandardTileMaskToTile(tile);
      const { sourceContainer, sourceBase, sourceMask } = await manager._waitForStandardMaskOverlay(tile, { tileId });
      if (!sourceContainer || sourceContainer.destroyed || !sourceBase || sourceBase.destroyed || !sourceMask || sourceMask.destroyed) {
        Logger.error('AssetShadow.standardTileMask.overlayMissing', { tileId });
        return null;
      }

      const proxyBase = cloneDisplayObjectForProxy(sourceBase);
      const proxyMask = cloneDisplayObjectForProxy(sourceMask);
      if (!proxyBase || proxyBase.destroyed || !proxyMask || proxyMask.destroyed) {
        try { proxyBase?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        try { proxyMask?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        Logger.error('AssetShadow.standardTileMask.proxyCloneFailed', { tileId });
        return null;
      }
      try { proxyMask.visible = true; } catch (_) {}
      try { proxyMask.renderable = false; } catch (_) {}
      try { proxyMask.alpha = 1; } catch (_) {}
      try { proxyBase.mask = proxyMask; } catch (_) {}

      const { width: docWidth, height: docHeight } = manager._getDocDimensions(doc);
      const maxTex = manager._getMaxTextureSize();
      const renderScale = Math.min(1, maxTex / Math.max(docWidth, docHeight));
      const pixelWidth = Math.max(4, Math.ceil(docWidth * renderScale));
      const pixelHeight = Math.max(4, Math.ceil(docHeight * renderScale));
      if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) {
        try { proxyBase.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        try { proxyMask.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        return null;
      }

      const renderTexture = PIXI.RenderTexture.create({
        width: pixelWidth,
        height: pixelHeight,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      const stage = new PIXI.Container();
      stage.eventMode = 'none';
      stage.sortableChildren = false;
      stage.interactiveChildren = false;
      stage.scale.set(renderScale, renderScale);
      stage.addChild(proxyBase);
      stage.addChild(proxyMask);

      renderer.render(stage, { renderTexture, clear: true });

      try { proxyBase.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      try { proxyMask.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      try { stage.destroy({ children: false }); } catch (_) {}

      const entry = {
        signature,
        texture: renderTexture,
        bounds: { x: 0, y: 0, width: docWidth, height: docHeight },
        scale: renderScale
      };
      manager._standardMaskShadowCache.set(tileId, entry);
      return entry;
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.shadowStamp.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }



  async createMaskedDescriptorShadowStamp(doc, descriptors, standardStamp, renderer, context = {}) {
    const manager = this.manager;
    let bounds = manager._getDescriptorShadowBounds(descriptors);
    if (!bounds || !standardStamp?.texture || !renderer) return null;
    const pathDilation = Math.max(0, Number(context?.dilation || 0) || 0);
    const hasPathDescriptor = (Array.isArray(descriptors) ? descriptors : [])
      .some((descriptor) => descriptor
        && descriptor.kind !== 'building'
        && descriptor.kind !== 'buildingCompositeSprite');
    if (hasPathDescriptor && pathDilation > 0) {
      bounds = {
        minX: bounds.minX - pathDilation,
        minY: bounds.minY - pathDilation,
        maxX: bounds.maxX + pathDilation,
        maxY: bounds.maxY + pathDilation,
        x: bounds.x - pathDilation,
        y: bounds.y - pathDilation,
        width: Math.max(1, bounds.width + (pathDilation * 2)),
        height: Math.max(1, bounds.height + (pathDilation * 2))
      };
    }
    const sourceScale = manager._computeDescriptorStampScale(Number(context?.scale) || 1, bounds);
    const applyMask = context?.applyMask !== false;
    const pixelWidth = Math.max(4, Math.ceil(bounds.width * sourceScale));
    const pixelHeight = Math.max(4, Math.ceil(bounds.height * sourceScale));
    if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) return null;

    const renderTexture = PIXI.RenderTexture.create({
      width: pixelWidth,
      height: pixelHeight,
      scaleMode: PIXI.SCALE_MODES.LINEAR
    });
    const stage = new PIXI.Container();
    const body = new PIXI.Container();
    const tempObjects = [stage, body];
    const ownedTextures = [];
    const expandPathDescriptor = (descriptor) => {
      if (!(pathDilation > 0)) return descriptor;
      const baseWidth = Math.max(1, Number(descriptor?.width) || 1);
      const multiplierDelta = (pathDilation * 2) / baseWidth;
      const expandSamples = (samples) => Array.isArray(samples)
        ? samples.map((sample) => {
          if (!sample) return sample;
          const widthMultiplier = Math.max(0.01, Number(sample.widthMultiplier || 1) || 1);
          return { ...sample, widthMultiplier: widthMultiplier + multiplierDelta };
        })
        : samples;
      return {
        ...descriptor,
        samples: expandSamples(descriptor.samples),
        sourceSamples: expandSamples(descriptor.sourceSamples),
        width: baseWidth,
        maskWidth: baseWidth
      };
    };
    try {
      stage.eventMode = 'none';
      stage.sortableChildren = false;
      stage.interactiveChildren = false;
      body.eventMode = 'none';
      body.sortableChildren = false;
      body.interactiveChildren = false;

      for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
        if (!descriptor) continue;
        const isBuilding = descriptor.kind === 'building';
        const isBuildingCompositeSprite = descriptor.kind === 'buildingCompositeSprite';
        let mesh = null;
        if (isBuilding) {
          const sourceDescriptor = descriptor.sourceWidth
            ? { ...descriptor, width: descriptor.sourceWidth }
            : descriptor;
          mesh = await manager._createBuildingShadowMesh(sourceDescriptor, {
            scale: sourceScale,
            sceneRect: bounds,
            dilationOffset: { x: 0, y: 0 },
            offsetX: 0,
            offsetY: 0
          });
        } else if (isBuildingCompositeSprite) {
          mesh = await manager._createBuildingCompositePartShadowSprite(descriptor, {
            scale: sourceScale,
            sceneRect: bounds,
            dilationOffset: { x: 0, y: 0 },
            offsetX: 0,
            offsetY: 0,
            tempTextures: ownedTextures
          });
        } else if (Array.isArray(descriptor.samples) && descriptor.samples.length >= PATH_MIN_POINTS) {
          const renderDescriptor = expandPathDescriptor(descriptor);
          mesh = await manager._createPathShadowMesh(renderDescriptor, {
            scale: sourceScale,
            sceneRect: bounds,
            dilationOffset: { x: 0, y: 0 },
            offsetX: 0,
            offsetY: 0,
            standardMaskDoc: doc,
            standardMaskTexture: applyMask ? standardStamp.texture : null
          });
        }
        if (!mesh) continue;
        body.addChild(mesh);
      }
      if (!body.children?.length) {
        try { renderTexture.destroy(true); } catch (_) {}
        return null;
      }

      if (!applyMask) {
        stage.addChild(body);
        renderer.render(stage, { renderTexture, clear: true });
        return { texture: renderTexture, bounds, scale: sourceScale };
      }

      const needsClipMask = Array.from(body.children || []).some((child) => !child?.faNexusStandardMaskApplied);
      if (!needsClipMask) {
        stage.addChild(body);
        renderer.render(stage, { renderTexture, clear: true });
        return { texture: renderTexture, bounds, scale: sourceScale };
      }

      const clipMaskTexture = manager._createDescriptorClipMaskTexture(doc, standardStamp, renderer, { bounds, sourceScale, descriptors });
      const maskSprite = clipMaskTexture ? new PIXI.Sprite(clipMaskTexture) : null;
      if (!maskSprite) {
        Logger.error('AssetShadow.standardTileMask.descriptorSourceMaskFailed', {
          tileId: doc?.id || null
        });
        try { renderTexture.destroy(true); } catch (_) {}
        return null;
      }
      tempObjects.push(maskSprite);
      try { maskSprite.visible = true; } catch (_) {}
      try { maskSprite.renderable = false; } catch (_) {}
      try {
        for (const child of Array.isArray(body.children) ? body.children : []) {
          if (child && !child.destroyed) child.mask = maskSprite;
        }
      } catch (_) {}
      stage.addChild(body);
      stage.addChild(maskSprite);
      renderer.render(stage, { renderTexture, clear: true });
      try { clipMaskTexture.destroy(true); } catch (_) {}
      return { texture: renderTexture, bounds, scale: sourceScale };
    } catch (error) {
      Logger.error('AssetShadow.standardTileMask.descriptorSourceStamp.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      try { renderTexture.destroy(true); } catch (_) {}
      return null;
    } finally {
      try { stage.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      for (const obj of tempObjects) {
        try {
          if (obj && !obj.destroyed) obj.destroy({ children: true, texture: false, baseTexture: false });
        } catch (_) {}
      }
      for (const texture of ownedTextures) {
        try { texture?.destroy?.(false); } catch (_) {}
      }
    }
  }



  async getScatterShadowStamp(doc, cfg, scale, renderer) {
    const manager = this.manager;
    try {
      const tileId = doc?.id;
      if (!tileId) return null;
      if (!renderer) return null;
      const payload = manager._readScatterPayload(doc);
      if (!payload || typeof payload !== 'object') {
        manager._clearScatterShadowCache(tileId);
        return null;
      }
      const version = Number(payload.version || SCATTER_VERSION);
      if (version !== SCATTER_VERSION) {
        manager._clearScatterShadowCache(tileId);
        return null;
      }
      const rawInstances = Array.isArray(payload.instances) ? payload.instances : [];
      if (!rawInstances.length) {
        manager._clearScatterShadowCache(tileId);
        return null;
      }

      const renderScale = Math.max(0.01, Number(scale) || 1);
      const dilationRadius = Math.max(0, Number(cfg?.dilation || 0)) * renderScale;
      const offsets = manager._buildScatterDilationOffsets(dilationRadius, rawInstances.length);
      const runtimeStamp = manager._getRuntimeScatterShadowStamp(doc, cfg, renderScale, offsets, rawInstances.length);
      if (runtimeStamp) return runtimeStamp;

      const instances = manager._resolveScatterInstances(doc);
      if (!instances.length) {
        manager._clearScatterShadowCache(tileId);
        return null;
      }

      const bounds = manager._getScatterShadowBounds(doc, instances);
      if (!bounds) return null;
      const signature = manager._buildScatterShadowSignature(instances, cfg, renderScale, {
        c: instances.length,
        chunked: true,
        w: Math.round(bounds.width || 0),
        h: Math.round(bounds.height || 0)
      });
      const cached = manager._scatterShadowCache.get(tileId);
      if (cached && cached.signature === signature && manager._isScatterShadowCacheEntryLive(cached)) {
        return cached;
      }
      if (cached) manager._clearScatterShadowCache(tileId);

      Logger.debug?.('AssetShadow.scatterShadow.instanceChunked', {
        tileId,
        instances: instances.length,
        reason: 'runtime-cache-unavailable'
      });

      const instanceBounds = instances.map((instance) => ({
        instance,
        bounds: manager._computeScatterInstanceBounds(instance)
      }));

      const dilation = Math.max(0, Number(cfg?.dilation || 0));
      const minX = bounds.minX - dilation;
      const minY = bounds.minY - dilation;
      const maxX = bounds.maxX + dilation;
      const maxY = bounds.maxY + dilation;
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);
      const shadowBounds = { minX, minY, maxX, maxY, width, height };
      const chunks = manager._resolveScatterShadowChunks(shadowBounds, renderScale);
      if (!chunks.length) return null;

      const textureCache = new Map();
      const getTexture = async (src) => {
        if (!src) return null;
        if (textureCache.has(src)) return textureCache.get(src);
        const texture = await manager._obtainTexture(src);
        textureCache.set(src, texture);
        return texture;
      };

      const stampChunks = [];
      const instancePadding = dilation + (SCATTER_SHADOW_CHUNK_BLEED / renderScale);
      for (const chunk of chunks) {
        const chunkEntries = [];
        for (const entry of instanceBounds) {
          const expanded = manager._expandBounds(entry.bounds, instancePadding);
          if (manager._rectsIntersect(expanded, chunk.renderBounds)) chunkEntries.push(entry.instance);
        }
        if (!chunkEntries.length) continue;

        const pixelWidth = Math.max(4, Math.ceil(chunk.renderWidth * renderScale));
        const pixelHeight = Math.max(4, Math.ceil(chunk.renderHeight * renderScale));
        if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) continue;

        const rt = PIXI.RenderTexture.create({
          width: pixelWidth,
          height: pixelHeight,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        const drawContainer = new PIXI.Container();
        const tempDisplayObjects = [];
        try {
          for (const instance of chunkEntries) {
            const tex = await getTexture(instance.src);
            if (!tex) continue;
            const baseWidth = Math.max(1, Number(instance.w) || 0) * renderScale;
            const baseHeight = Math.max(1, Number(instance.h) || 0) * renderScale;
            const baseX = ((Number(instance.x) || 0) - chunk.renderX) * renderScale;
            const baseY = ((Number(instance.y) || 0) - chunk.renderY) * renderScale;
            const rotationDeg = Number(instance.r || 0) * (Math.PI / 180);

            for (const offset of offsets) {
              const sprite = new PIXI.Sprite(tex);
              sprite.anchor.set(0.5, 0.5);
              sprite.width = baseWidth;
              sprite.height = baseHeight;
              if (instance.flipH) sprite.scale.x *= -1;
              if (instance.flipV) sprite.scale.y *= -1;
              sprite.position.set(baseX + offset.x, baseY + offset.y);
              sprite.rotation = rotationDeg;
              if (instance.affine) {
                const affine = resolveScatterInstanceAffine(instance);
                applyScatterInstanceTransformToSprite(sprite, {
                  ...instance,
                  x: baseX + offset.x,
                  y: baseY + offset.y,
                  affine: {
                    a: affine.a * renderScale,
                    b: affine.b * renderScale,
                    c: affine.c * renderScale,
                    d: affine.d * renderScale
                  }
                });
              }
              sprite.alpha = 1;
              sprite.eventMode = 'none';
              drawContainer.addChild(sprite);
              tempDisplayObjects.push(sprite);
            }
          }

          if (!tempDisplayObjects.length) {
            try { rt.destroy(true); } catch (_) {}
            continue;
          }

          renderer.render(drawContainer, { renderTexture: rt, clear: true });
          stampChunks.push({
            texture: rt,
            bounds: {
              x: chunk.renderX,
              y: chunk.renderY,
              width: chunk.renderWidth,
              height: chunk.renderHeight
            }
          });
        } catch (error) {
          try { rt.destroy(true); } catch (_) {}
          throw error;
        } finally {
          for (const displayObject of tempDisplayObjects) {
            try { displayObject.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
          }
          try { drawContainer.destroy({ children: false }); } catch (_) {}
        }
      }

      if (!stampChunks.length) {
        return null;
      }

      const entry = {
        signature,
        texture: stampChunks.length === 1 ? stampChunks[0].texture : null,
        chunks: stampChunks,
        bounds: { x: minX, y: minY, width, height },
        scale: renderScale
      };
      manager._scatterShadowCache.set(tileId, entry);
      Logger.debug?.('AssetShadow.scatterShadow.chunked', {
        tileId,
        instances: instances.length,
        chunks: stampChunks.length,
        offsets: offsets.length,
        scale: renderScale
      });
      return entry;
    } catch (error) {
      Logger.warn?.('AssetShadow.scatterShadow.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }



  createDocShadowSprite(texture, doc, localBounds, context = {}) {
    const manager = this.manager;
    try {
      if (!texture || !localBounds) return null;
      const width = Math.max(1, Number(localBounds.width || 0));
      const height = Math.max(1, Number(localBounds.height || 0));
      const scale = Number(context.scale) || 1;
      const sceneRect = context.sceneRect || { x: 0, y: 0 };
      const offsetX = Number(context.offsetX || 0);
      const offsetY = Number(context.offsetY || 0);
      const flipX = Number(context.flipX) < 0 ? -1 : 1;
      const flipY = Number(context.flipY) < 0 ? -1 : 1;
      const anchorMode = context.anchorMode || 'doc';
      const pivotLocal = manager._getDocPivotLocal(doc, { anchorMode });
      const pivotWorld = manager._getDocPivotWorld(doc, { anchorMode });
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(
        (pivotLocal.x - Number(localBounds.x || 0)) / width,
        (pivotLocal.y - Number(localBounds.y || 0)) / height
      );
      sprite.width = width * scale;
      sprite.height = height * scale;
      if (flipX < 0) sprite.scale.x *= -1;
      if (flipY < 0) sprite.scale.y *= -1;
      sprite.position.set(
        ((pivotWorld.x - sceneRect.x) * scale) + offsetX,
        ((pivotWorld.y - sceneRect.y) * scale) + offsetY
      );
      sprite.rotation = (Number(doc?.rotation || 0) * Math.PI) / 180;
      sprite.alpha = 1;
      sprite.eventMode = 'none';
      return sprite;
    } catch (_) {
      return null;
    }
  }



  createWorldBoundsShadowSprite(texture, bounds, context = {}) {
    const manager = this.manager;
    try {
      if (!texture || !bounds) return null;
      const width = Math.max(1, Number(bounds.width || 0));
      const height = Math.max(1, Number(bounds.height || 0));
      const scale = Number(context.scale) || 1;
      const sceneRect = context.sceneRect || { x: 0, y: 0 };
      const offsetX = Number(context.offsetX || 0);
      const offsetY = Number(context.offsetY || 0);
      const x = Number.isFinite(bounds.minX) ? Number(bounds.minX) : Number(bounds.x || 0);
      const y = Number.isFinite(bounds.minY) ? Number(bounds.minY) : Number(bounds.y || 0);
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0, 0);
      sprite.width = width * scale;
      sprite.height = height * scale;
      sprite.position.set(
        ((x - Number(sceneRect.x || 0)) * scale) + offsetX,
        ((y - Number(sceneRect.y || 0)) * scale) + offsetY
      );
      sprite.alpha = 1;
      sprite.eventMode = 'none';
      return sprite;
    } catch (_) {
      return null;
    }
  }



  async createBuildingCompositePartShadowSprite(descriptor, context = {}) {
    const manager = this.manager;
    try {
      if (!descriptor?.textureSrc) return null;
      const sourceTexture = await manager._obtainTexture(descriptor.textureSrc);
      if (!sourceTexture) return null;
      let texture = sourceTexture;
      if (descriptor.sourceFrame) {
        const frame = descriptor.sourceFrame;
        texture = new PIXI.Texture(sourceTexture.baseTexture, new PIXI.Rectangle(
          Number(frame.x), Number(frame.y), Number(frame.width), Number(frame.height)
        ));
        if (Array.isArray(context.tempTextures)) context.tempTextures.push(texture);
      }
      const scale = Number(context.scale) || 1;
      const sceneRect = context.sceneRect || { x: 0, y: 0 };
      const offset = context.dilationOffset || { x: 0, y: 0 };
      const offsetX = Number(context.offsetX || 0) + Number(offset.x || 0);
      const offsetY = Number(context.offsetY || 0) + Number(offset.y || 0);
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0.5, 0.5);
      sprite.tint = 0x000000;
      sprite.width = Math.max(1, Number(descriptor.width || 0)) * scale;
      sprite.height = Math.max(1, Number(descriptor.height || 0)) * scale;
      if (Number(descriptor.flipX) < 0) sprite.scale.x *= -1;
      if (Number(descriptor.flipY) < 0) sprite.scale.y *= -1;
      sprite.position.set(
        ((Number(descriptor.x || 0) - Number(sceneRect.x || 0)) * scale) + offsetX,
        ((Number(descriptor.y || 0) - Number(sceneRect.y || 0)) * scale) + offsetY
      );
      sprite.rotation = Number(descriptor.rotation || 0);
      sprite.alpha = normalizeLayerOpacity(descriptor.alphaMultiplier, 1);
      sprite.eventMode = 'none';
      return sprite;
    } catch (error) {
      Logger.warn('AssetShadow.buildingCompositeSprite.failed', String(error?.message || error));
      return null;
    }
  }



  async createPathShadowMesh(descriptor, context = {}) {
    const manager = this.manager;
    try {
      if (!descriptor || !Array.isArray(descriptor.samples) || !descriptor.samples.length) return null;
      const texture = await manager._obtainPathShadowTexture(descriptor.textureSrc);
      if (!texture) return null;
      const meshOptions = descriptor.meshOptions ? { ...descriptor.meshOptions } : {};
      if (descriptor.useVisibleRows) {
        const visibleData = descriptor.visibleData || texture._cachedVisibleData || manager._detectTextureVisibleRows(texture);
        if (visibleData) {
          texture._cachedVisibleData = visibleData;
          meshOptions.visibleData = visibleData;
        }
      }
      const mesh = createPathMesh(
        descriptor.samples,
        descriptor.width,
        descriptor.repeatSpacing,
        texture,
        meshOptions
      );
      if (!mesh) return null;
      mesh.eventMode = 'none';
      if (context.standardMaskTexture && context.standardMaskDoc) {
        manager._applyStandardMaskShaderToPathMesh(mesh, descriptor, context.standardMaskDoc, texture, context.standardMaskTexture);
      }
      const uniforms = mesh.shader?.uniforms;
      if (uniforms?.uColor instanceof Float32Array) {
        uniforms.uColor[0] = 0;
        uniforms.uColor[1] = 0;
        uniforms.uColor[2] = 0;
        uniforms.uColor[3] = 1;
      } else if (uniforms) {
        mesh.shader.uniforms.uColor = new Float32Array([0, 0, 0, 1]);
      }
      const scale = Number(context.scale) || 1;
      const sceneRect = context.sceneRect || { x: 0, y: 0 };
      mesh.scale.set(scale, scale);
      const offset = context.dilationOffset || { x: 0, y: 0 };
      const offsetX = Number(context.offsetX || 0);
      const offsetY = Number(context.offsetY || 0);
      mesh.position.set(
        (-sceneRect.x * scale) + offset.x + offsetX,
        (-sceneRect.y * scale) + offset.y + offsetY
      );
      mesh.alpha = 1;
      return mesh;
    } catch (error) {
      Logger.warn('AssetShadow.pathMesh.failed', String(error?.message || error));
      return null;
    }
  }



  getBuildingShadowMaterial() {
    const manager = this.manager;
    if (manager._buildingShadowMaterial && !manager._buildingShadowMaterial.destroyed) {
      return manager._buildingShadowMaterial;
    }
    const material = new PIXI.MeshMaterial(PIXI.Texture.WHITE);
    material.alpha = 1;
    material.tint = 0x000000;
    material.blendMode = PIXI.BLEND_MODES.NORMAL;
    manager._buildingShadowMaterial = material;
    return material;
  }



  async createBuildingShadowMesh(descriptor, context = {}) {
    const manager = this.manager;
    try {
      if (!descriptor || !Array.isArray(descriptor.loop)) return null;
      const closed = descriptor.closed !== false;
      const minPoints = closed ? 3 : 2;
      if (descriptor.loop.length < minPoints) return null;
      const options = {
        width: Math.max(2, Number(descriptor.width) || 2),
        closed,
        joinStyle: 'mitre',
        mitreLimit: 4,
        textureRepeatDistance: Math.max(1e-3, Number(descriptor.textureRepeatDistance) || Number(descriptor.width) || 1),
        texturePhaseDistance: Number(descriptor.texturePhaseDistance) || 0,
        centerOffset: Number(descriptor.centerOffset) || 0,
        textureOffset: descriptor.textureOffset || { x: 0, y: 0 },
        textureFlip: descriptor.textureFlip || { horizontal: false, vertical: false },
        startJoinDir: descriptor.startJoinDir || null,
        endJoinDir: descriptor.endJoinDir || null
      };
      const geometryResult = descriptor.preparedGeometryData
        ? {
            geometry: BuildingWallMesher.buildGeometryFromCenterline(descriptor.preparedGeometryData),
            data: descriptor.preparedGeometryData
          }
        : BuildingWallMesher.buildGeometry(descriptor.loop, options);
      const geometry = geometryResult?.geometry;
      if (!geometry) return null;

      let resolvedTexture = null;
      let visibleData = null;
      if (descriptor.textureSrc) {
        const entry = await manager._obtainBuildingShadowTexture(descriptor.textureSrc, descriptor.textureKey);
        resolvedTexture = entry?.texture || null;
        visibleData = entry?.visibleData || resolvedTexture?._cachedVisibleData || null;
      }
      if (visibleData) {
        manager._remapGeometryVisibleRows(geometry, visibleData);
      }

      let mesh = null;
      if (resolvedTexture) {
        const shader = createPathShader(resolvedTexture);
        mesh = new PIXI.Mesh(geometry, shader);
        const uniforms = mesh.shader?.uniforms;
        if (uniforms?.uColor instanceof Float32Array) {
          uniforms.uColor[0] = 0;
          uniforms.uColor[1] = 0;
          uniforms.uColor[2] = 0;
          uniforms.uColor[3] = 1;
        } else if (uniforms) {
          mesh.shader.uniforms.uColor = new Float32Array([0, 0, 0, 1]);
        }
      } else {
        const material = manager._getBuildingShadowMaterial();
        mesh = new PIXI.Mesh(geometry, material);
      }

      mesh.eventMode = 'none';
      const scale = Number(context.scale) || 1;
      const sceneRect = context.sceneRect || { x: 0, y: 0 };
      const offset = context.dilationOffset || { x: 0, y: 0 };
      const offsetX = Number(context.offsetX || 0);
      const offsetY = Number(context.offsetY || 0);
      mesh.scale.set(scale, scale);
      mesh.position.set(
        (-sceneRect.x * scale) + offset.x + offsetX,
        (-sceneRect.y * scale) + offset.y + offsetY
      );
      mesh.alpha = normalizeLayerOpacity(descriptor?.alphaMultiplier, 1);
      return mesh;
    } catch (error) {
      Logger.warn('AssetShadow.buildingMesh.failed', String(error?.message || error));
      return null;
    }
  }
}
