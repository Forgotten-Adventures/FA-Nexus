import { NexusLogger as Logger } from '../core/nexus-logger.js';

const DEFAULT_ALPHA_THRESHOLD = 1 / 255;
const MASK_ALPHA_THRESHOLD = 1 / 255;
const DEFAULT_ALPHA_RESOLUTION = 0.25;
const BUILDING_ALPHA_TARGET_PX = 1024;
const BUILDING_ALPHA_EXPAND_RADIUS = 1;
const MIN_ALPHA_RESOLUTION = 0.05;
const MODULE_ID = 'fa-nexus';
const TILE_SELECTION_SETTING = 'tilePixelSelection';

const _tempPointA = new PIXI.Point();
const _tempPointB = new PIXI.Point();
const _tempPointHandle = new PIXI.Point();

class TileAlphaHitArea {
  constructor(tile) {
    this.tile = tile;
  }

  contains(localX, localY) {
    const tile = this.tile;
    if (!tile || tile.destroyed) return false;
    try {
      const world = tile.worldTransform.apply({ x: localX, y: localY }, _tempPointA);
      if (!world) return false;
      if (TilePixelSelection._pointHitsResizeHandle(tile, world.x, world.y)) return true;
      if (!TilePixelSelection._pointWithinTileBounds(tile, world.x, world.y)) return false;
      return TilePixelSelection._pointHasVisibleAlpha(tile, world.x, world.y);
    } catch (err) {
      Logger.debug('TileAlphaHitArea.contains failed', err);
      return true; // fall back to default behaviour on error
    }
  }
}

export class TilePixelSelection {
  static install() {
    if (this._installed) return;
    this._installed = true;

    this._canvasReady = !!globalThis.canvas?.ready;
    this._settingEnabled = this._getSettingEnabled();
    this._alphaCache = new WeakMap();
    this._active = false;

    Hooks.on('canvasReady', () => {
      this._canvasReady = true;
      this._alphaCache = new WeakMap();
      this._applyActivation({ rebindAll: true });
      this._updateAllResizeHandles();
    });

    Hooks.on('canvasTearDown', () => {
      this._canvasReady = false;
      this._applyActivation({ rebindAll: false });
      this._alphaCache = new WeakMap();
    });

    Hooks.on('drawTile', (tile) => { this._handleTileLifecycle(tile); });
    Hooks.on('refreshTile', (tile) => { this._handleTileLifecycle(tile); });
    Hooks.on('updateTile', (doc) => {
      try {
        const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
        if (tile) this._handleTileLifecycle(tile);
      } catch (_) {}
    });
    Hooks.on('controlTile', (tile) => { this._updateResizeHandleState(tile); });
    Hooks.on('updateSetting', (data) => {
      if (!data || data.namespace !== MODULE_ID) return;
      if (data.key === TILE_SELECTION_SETTING) {
        this._settingEnabled = this._getSettingEnabled();
        this._applyActivation({ rebindAll: true });
        this._updateAllResizeHandles();
      }
    });

    this._applyActivation({ rebindAll: true });
    this._updateAllResizeHandles();
  }

  static _bindAllTiles() {
    if (!this._active) return;
    try {
      const tiles = canvas.tiles?.placeables;
      if (!Array.isArray(tiles)) return;
      for (const tile of tiles) {
        this._updateResizeHandleState(tile);
        this._bindTile(tile);
      }
    } catch (err) {
      Logger.debug('TilePixelSelection._bindAllTiles failed', err);
    }
  }

  static _unbindAllTiles() {
    try {
      const tiles = canvas.tiles?.placeables;
      if (!Array.isArray(tiles)) return;
      for (const tile of tiles) this._unbindTile(tile);
    } catch (err) {
      Logger.debug('TilePixelSelection._unbindAllTiles failed', err);
    }
  }

  static _handleTileLifecycle(tile) {
    if (!tile || tile.destroyed) return;
    this._updateResizeHandleState(tile);
    if (this._active) this._bindTile(tile);
    else this._unbindTile(tile);
  }

  static _bindTile(tile) {
    if (!this._active) return;
    if (!tile || tile.destroyed) return;
    try {
      const existingHitArea = tile._faNexusAlphaHitArea;
      const alreadyWrapped = existingHitArea?.tile === tile;
      if (!alreadyWrapped || tile.hitArea !== existingHitArea) {
        tile._faNexusOriginalHitArea = tile.hitArea ?? null;
      }
      if (!alreadyWrapped) {
        tile._faNexusAlphaHitArea = new TileAlphaHitArea(tile);
      }
      if (tile._faNexusAlphaHitArea) tile.hitArea = tile._faNexusAlphaHitArea;
    } catch (err) {
      Logger.debug('TilePixelSelection._bindTile failed', err);
    }
  }

  static _unbindTile(tile) {
    if (!tile || tile.destroyed) return;
    try {
      const wrapped = tile._faNexusAlphaHitArea?.tile === tile;
      if (!wrapped) return;
      if (tile.hitArea === tile._faNexusAlphaHitArea) {
        tile.hitArea = Object.prototype.hasOwnProperty.call(tile, '_faNexusOriginalHitArea') ? tile._faNexusOriginalHitArea : null;
      }
      delete tile._faNexusAlphaHitArea;
    } catch (err) {
      Logger.debug('TilePixelSelection._unbindTile failed', err);
    }
  }

  static _applyActivation({ rebindAll = false } = {}) {
    try {
      if (typeof this._settingEnabled !== 'boolean') this._settingEnabled = this._getSettingEnabled();
    } catch (_) {
      this._settingEnabled = true;
    }
    const shouldBeActive = !!this._canvasReady && !!this._settingEnabled;
    if (shouldBeActive) {
      if (!this._active) {
        this._active = true;
        this._alphaCache = new WeakMap();
        this._bindAllTiles();
      } else if (rebindAll) {
        this._bindAllTiles();
      }
    } else if (this._active || rebindAll) {
      this._unbindAllTiles();
      this._active = false;
      this._alphaCache = new WeakMap();
    }
  }

  static _getSettingEnabled() {
    try {
      return game?.settings?.get?.(MODULE_ID, TILE_SELECTION_SETTING) !== false;
    } catch (err) {
      if (err) Logger.debug('TilePixelSelection._getSettingEnabled failed', err);
      return true;
    }
  }

  static _pointHasVisibleAlpha(tile, worldX, worldY) {
    try {
      if (!this._tileHasVisibleAlpha(tile)) return false;
      if (this._isVideoTile(tile)) return true; // Video tiles fall back to bounding box
      const mesh = tile?.mesh;
      if (!mesh || mesh.destroyed) return true;

      const maskContainer = mesh.faNexusMaskContainer
        || tile.faNexusMaskContainer
        || mesh.faNexusStandardMaskContainer
        || tile.faNexusStandardMaskContainer;
      if (maskContainer?.faNexusMaskSprite) {
        const maskSprite = maskContainer.faNexusMaskSprite;
        const maskAlpha = this._sampleSpriteAlpha(maskSprite, worldX, worldY, { useLumaWhenOpaque: true });
        if (maskAlpha === null) return true; // if we cannot sample, allow interaction
        return maskAlpha >= MASK_ALPHA_THRESHOLD;
      }

      const pathContainer = mesh.faNexusPathContainer || tile.faNexusPathContainer;
      if (pathContainer) {
        let pathMeshes = Array.isArray(pathContainer.faNexusPathMeshes) && pathContainer.faNexusPathMeshes.length
          ? pathContainer.faNexusPathMeshes
          : (pathContainer.faNexusPathMesh ? [pathContainer.faNexusPathMesh] : []);
        if (!pathMeshes.length && Array.isArray(pathContainer.children)) {
          pathMeshes = pathContainer.children.filter((child) => child && !child.destroyed && child.geometry);
          if (pathMeshes.length) {
            if (!pathContainer.faNexusPathMesh) pathContainer.faNexusPathMesh = pathMeshes[0];
            if (pathMeshes.length > 1) pathContainer.faNexusPathMeshes = pathMeshes;
          }
        }
        let inspectedMesh = false;
        for (const pathMesh of pathMeshes) {
          if (!pathMesh || pathMesh.destroyed) continue;
          inspectedMesh = true;
          if (!this._meshContainsPoint(pathMesh, worldX, worldY)) continue;
          const pathAlpha = this._sampleMeshTextureAlpha(pathMesh, worldX, worldY);
          if (pathAlpha === null) return true;
          if (pathAlpha >= DEFAULT_ALPHA_THRESHOLD) return true;
        }
        if (inspectedMesh) return false;
      }

      const scatterContainer = mesh.faNexusAssetScatterContainer || tile.faNexusAssetScatterContainer;
      if (scatterContainer) {
        const sprites = scatterContainer.children || [];
        let inspected = false;
        let sampled = false;
        for (const sprite of sprites) {
          if (!sprite || sprite.destroyed) continue;
          inspected = true;
          if (!sprite.texture?.valid) continue;
          sampled = true;
          const alpha = this._sampleSpriteAlpha(sprite, worldX, worldY, { useLumaWhenOpaque: true });
          if (alpha === null) return true;
          if (alpha >= DEFAULT_ALPHA_THRESHOLD) return true;
        }
        if (sampled) return false;
        if (inspected) return true;
      }

      const flattenContainer = mesh.faNexusFlattenChunkContainer || tile.faNexusFlattenChunkContainer;
      if (flattenContainer) {
        const sprites = flattenContainer.children || [];
        let inspected = false;
        let sampled = false;
        for (const sprite of sprites) {
          if (!sprite || sprite.destroyed) continue;
          inspected = true;
          if (!sprite.texture?.valid) continue;
          sampled = true;
          const alpha = this._sampleSpriteAlpha(sprite, worldX, worldY, { useLumaWhenOpaque: true });
          if (alpha === null) return true;
          if (alpha >= DEFAULT_ALPHA_THRESHOLD) return true;
        }
        if (sampled) return false;
        if (inspected) return true;
      }

      const buildingContainer = mesh.faNexusBuildingContainer || tile.faNexusBuildingContainer;
      if (buildingContainer) {
        const buildingMeshes = Array.isArray(buildingContainer.faNexusBuildingMeshes) && buildingContainer.faNexusBuildingMeshes.length
          ? buildingContainer.faNexusBuildingMeshes
          : (buildingContainer.children || []);
        let inspectedMesh = false;
        for (const buildingMesh of buildingMeshes) {
          if (!buildingMesh || buildingMesh.destroyed || typeof buildingMesh.render !== 'function') continue;
          inspectedMesh = true;
          if (!this._meshContainsPoint(buildingMesh, worldX, worldY)) continue;
          const buildingAlpha = this._sampleMeshTextureAlpha(buildingMesh, worldX, worldY, {
            target: BUILDING_ALPHA_TARGET_PX,
            expandRadius: BUILDING_ALPHA_EXPAND_RADIUS
          });
          if (buildingAlpha === null) return true;
          if (buildingAlpha >= DEFAULT_ALPHA_THRESHOLD) return true;
        }
        if (inspectedMesh) return false;
      }

      const frameContainer = mesh.faNexusDoorFrameContainer || tile.faNexusDoorFrameContainer;
      if (frameContainer) {
        const sprites = frameContainer.children || [];
        let inspected = false;
        for (const sprite of sprites) {
          if (!sprite || sprite.destroyed || !sprite.texture?.valid) continue;
          inspected = true;
          const alpha = this._sampleSpriteAlpha(sprite, worldX, worldY, { useLumaWhenOpaque: true });
          if (alpha === null) return true;
          if (alpha >= DEFAULT_ALPHA_THRESHOLD) return true;
        }
        if (inspected) return false;
      }

      if (typeof mesh.containsPoint === 'function') {
        return !!mesh.containsPoint({ x: worldX, y: worldY }, DEFAULT_ALPHA_THRESHOLD);
      }

      return true;
    } catch (err) {
      Logger.debug('TilePixelSelection._pointHasVisibleAlpha failed', err);
      return true;
    }
  }

  static _pointWithinTileBounds(tile, worldX, worldY) {
    try {
      // Guard hit-testing to the tile's own rectangle so meshless/color tiles don't swallow the whole canvas.
      // Use world-space bounds first (accounts for canvas zoom/pan), then fall back to scene-space math.
      const worldBounds = tile?.getBounds?.(true);
      if (worldBounds?.contains?.(worldX, worldY)) return true;

      const doc = tile?.document;
      if (!doc) return false;
      let { x = 0, y = 0, width = 0, height = 0, rotation = 0, texture = {} } = doc;
      const scaleX = Math.abs(Number(texture?.scaleX ?? 1)) || 1;
      const scaleY = Math.abs(Number(texture?.scaleY ?? 1)) || 1;
      width *= scaleX;
      height *= scaleY;
      const stage = canvas?.stage ?? canvas?.app?.stage;
      const scenePoint = stage?.worldTransform?.applyInverse?.({ x: worldX, y: worldY }, _tempPointB) ?? { x: worldX, y: worldY };
      let rect = rotation
        ? PIXI.Rectangle.fromRotation(x, y, width, height, Math.toRadians(rotation))
        : new PIXI.Rectangle(x, y, width, height);
      if (typeof rect.normalize === 'function') rect = rect.normalize();
      return rect.contains(scenePoint.x, scenePoint.y);
    } catch (err) {
      Logger.debug('TilePixelSelection._pointWithinTileBounds failed', err);
      return true;
    }
  }

  static _pointHitsResizeHandle(tile, worldX, worldY) {
    try {
      if (!this._tileSupportsResizeHandle(tile)) return false;
      const handle = tile?.frame?.handle;
      if (!handle || handle.destroyed) return false;
      if (!handle.visible || handle.worldAlpha <= 0 || handle.eventMode === 'none') return false;
      if (typeof handle.containsPoint === 'function') {
        return !!handle.containsPoint({ x: worldX, y: worldY });
      }
      const hitArea = handle.hitArea;
      if (!hitArea || typeof hitArea.contains !== 'function') return false;
      const local = handle.worldTransform?.applyInverse?.({ x: worldX, y: worldY }, _tempPointHandle);
      if (!local) return false;
      return !!hitArea.contains(local.x, local.y);
    } catch (err) {
      Logger.debug('TilePixelSelection._pointHitsResizeHandle failed', err);
      return false;
    }
  }

  static _readFaNexusFlag(doc, key) {
    if (!doc || !key) return undefined;
    try {
      const value = doc.getFlag?.(MODULE_ID, key);
      if (value !== undefined) return value;
    } catch (_) {}
    try {
      const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
      if (flags && Object.prototype.hasOwnProperty.call(flags, key)) return flags[key];
    } catch (_) {}
    return undefined;
  }

  static _isFaNexusCustomRenderTile(tile) {
    try {
      const doc = tile?.document;
      if (!doc) return false;
      const mergedPaths = this._readFaNexusFlag(doc, 'pathsV2');
      const scatter = this._readFaNexusFlag(doc, 'assetScatter');
      if (this._readFaNexusFlag(doc, 'path')) return true;
      if (this._readFaNexusFlag(doc, 'pathV2')) return true;
      if (mergedPaths && typeof mergedPaths === 'object' && Array.isArray(mergedPaths.paths)) return true;
      if (this._readFaNexusFlag(doc, 'maskedTiling')) return true;
      if (this._readFaNexusFlag(doc, 'standardTileMask')) return true;
      if (scatter && typeof scatter === 'object' && Array.isArray(scatter.instances)) return true;
      if (this._readFaNexusFlag(doc, 'building')) return true;

      const mesh = tile?.mesh;
      return !!(
        mesh?.faNexusMaskContainer
        || tile?.faNexusMaskContainer
        || mesh?.faNexusStandardMaskContainer
        || tile?.faNexusStandardMaskContainer
        || mesh?.faNexusPathContainer
        || tile?.faNexusPathContainer
        || mesh?.faNexusAssetScatterContainer
        || tile?.faNexusAssetScatterContainer
        || mesh?.faNexusBuildingContainer
        || tile?.faNexusBuildingContainer
      );
    } catch (err) {
      Logger.debug('TilePixelSelection._isFaNexusCustomRenderTile failed', err);
      return false;
    }
  }

  static _tileSupportsResizeHandle(tile) {
    try {
      const doc = tile?.document;
      if (!doc) return true;
      if (this._isFaNexusCustomRenderTile(tile)) return false;
    } catch (err) {
      Logger.debug('TilePixelSelection._tileSupportsResizeHandle failed', err);
    }
    return true;
  }

  static _updateAllResizeHandles() {
    try {
      const tiles = canvas.tiles?.placeables;
      if (!Array.isArray(tiles)) return;
      for (const tile of tiles) this._updateResizeHandleState(tile);
    } catch (err) {
      Logger.debug('TilePixelSelection._updateAllResizeHandles failed', err);
    }
  }

  static _updateResizeHandleState(tile) {
    try {
      const handle = tile?.frame?.handle;
      if (!handle || handle.destroyed) return;
      if (!handle._faNexusHandleDefaults) {
        handle._faNexusHandleDefaults = {
          alpha: typeof handle.alpha === 'number' ? handle.alpha : 1,
          eventMode: handle.eventMode ?? 'static',
          cursor: handle.cursor ?? 'pointer'
        };
      }
      const supported = this._tileSupportsResizeHandle(tile);
      if (!supported) {
        handle.visible = false;
        handle.alpha = 0;
        handle.eventMode = 'none';
        handle.cursor = 'default';
        handle.scale?.set?.(1, 1);
        handle._faNexusHandleUnsupported = true;
        return;
      }

      const defaults = handle._faNexusHandleDefaults;
      handle._faNexusHandleUnsupported = false;
      handle.alpha = defaults.alpha ?? 1;
      handle.cursor = defaults.cursor ?? 'pointer';
      const shouldEnable = !!tile?.controlled && !tile?.document?.locked;
      handle.eventMode = shouldEnable ? (defaults.eventMode ?? 'static') : 'none';
      handle.visible = shouldEnable;
    } catch (err) {
      Logger.debug('TilePixelSelection._updateResizeHandleState failed', err);
    }
  }

  static _tileHasVisibleAlpha(tile) {
    if (!tile) return true;
    const documentAlpha = Number(tile.document?.alpha);
    if (Number.isFinite(documentAlpha) && documentAlpha <= 0) return false;
    const tileAlpha = Number(tile.alpha);
    if (Number.isFinite(tileAlpha) && tileAlpha <= 0) return false;
    const meshAlpha = Number(tile.mesh?.worldAlpha ?? tile.mesh?.alpha);
    if (Number.isFinite(meshAlpha) && meshAlpha <= 0) return false;
    return true;
  }

  static _isVideoTile(tile) {
    try {
      // Check texture source path for video extensions
      const src = tile?.document?.texture?.src;
      if (src && /\.(webm|mp4|ogg|m4v)$/i.test(src)) return true;
      // Check if baseTexture resource is a video element
      const baseTexture = tile?.texture?.baseTexture ?? tile?.mesh?.texture?.baseTexture;
      const resource = baseTexture?.resource;
      if (resource?.source instanceof HTMLVideoElement) return true;
      if (resource?.constructor?.name === 'VideoResource') return true;
    } catch (_) {}
    return false;
  }

  static _resolveMeshTexture(mesh) {
    if (!mesh) return null;
    const candidates = [];
    try {
      if (mesh.texture) candidates.push(mesh.texture);
    } catch (_) {}
    const shader = mesh.shader ?? null;
    if (shader) {
      const uniforms = shader.uniforms ?? shader.uniformGroup?.uniforms ?? null;
      if (uniforms && typeof uniforms === 'object') {
        candidates.push(uniforms.uSampler);
        candidates.push(uniforms.texture);
        candidates.push(uniforms.map);
        candidates.push(uniforms.diffuse);
        candidates.push(uniforms.uTexture);
      }
    }
    const material = mesh.material ?? null;
    if (material) {
      candidates.push(material.texture);
      candidates.push(material.map);
    }
    for (const candidate of candidates) {
      const texture = this._unwrapTextureCandidate(candidate);
      if (texture?.valid || texture?.baseTexture?.valid) return texture;
    }
    return null;
  }

  static _unwrapTextureCandidate(candidate) {
    if (!candidate) return null;
    if (candidate instanceof PIXI.Texture) return candidate;
    if (candidate.texture instanceof PIXI.Texture) return candidate.texture;
    if (candidate.frame && candidate.baseTexture) return candidate;
    return null;
  }

  static _meshContainsPoint(mesh, worldX, worldY) {
    try {
      const local = mesh.worldTransform.applyInverse({ x: worldX, y: worldY }, _tempPointB);
      if (!local) return false;
      const geometry = mesh.geometry;
      if (!geometry) return true;
      const buffer = geometry.getBuffer?.('aVertexPosition') ?? geometry.attributes?.aVertexPosition;
      const indexBuffer = geometry.getIndex?.() ?? geometry.indexBuffer ?? geometry.indexArray;
      const vertices = buffer?.data;
      const indices = indexBuffer?.data ?? indexBuffer;
      if (!vertices || !indices) return true;
      for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i] * 2;
        const ib = indices[i + 1] * 2;
        const ic = indices[i + 2] * 2;
        const ax = vertices[ia];
        const ay = vertices[ia + 1];
        const bx = vertices[ib];
        const by = vertices[ib + 1];
        const cx = vertices[ic];
        const cy = vertices[ic + 1];
        if (this._pointInTriangle(local.x, local.y, ax, ay, bx, by, cx, cy)) return true;
      }
      return false;
    } catch (err) {
      Logger.debug('TilePixelSelection._meshContainsPoint failed', err);
      return true;
    }
  }

  static _sampleMeshTextureAlpha(mesh, worldX, worldY, options = {}) {
    try {
      const texture = this._resolveMeshTexture(mesh);
      if (!texture || (!texture.valid && !texture.baseTexture?.valid)) return null;
      const local = mesh.worldTransform.applyInverse({ x: worldX, y: worldY }, _tempPointB);
      if (!local) return null;

      const geometry = mesh.geometry;
      if (!geometry) return null;
      const vertexBuffer = geometry.getBuffer?.('aVertexPosition') ?? geometry.attributes?.aVertexPosition;
      const uvBuffer = geometry.getBuffer?.('aTextureCoord') ?? geometry.attributes?.aTextureCoord;
      const indexBuffer = geometry.getIndex?.() ?? geometry.indexBuffer ?? geometry.indexArray;
      const vertices = vertexBuffer?.data;
      const uvs = uvBuffer?.data;
      const indices = indexBuffer?.data ?? indexBuffer;
      if (!vertices || !uvs || !indices) return null;

      for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i] * 2;
        const ib = indices[i + 1] * 2;
        const ic = indices[i + 2] * 2;
        const ax = vertices[ia];
        const ay = vertices[ia + 1];
        const bx = vertices[ib];
        const by = vertices[ib + 1];
        const cx = vertices[ic];
        const cy = vertices[ic + 1];

        if (this._pointInTriangle(local.x, local.y, ax, ay, bx, by, cx, cy)) {
          const uva = uvs[ia];
          const vva = uvs[ia + 1];
          const uvb = uvs[ib];
          const vvb = uvs[ib + 1];
          const uvc = uvs[ic];
          const vvc = uvs[ic + 1];

          const bary = this._barycentricCoords(local.x, local.y, ax, ay, bx, by, cx, cy);
          if (!bary) return null;
          let u = bary.u * uva + bary.v * uvb + bary.w * uvc;
          let v = bary.u * vva + bary.v * vvb + bary.w * vvc;

          // Handle repeating textures by wrapping UV coordinates to 0-1 range
          u = ((u % 1) + 1) % 1;
          v = ((v % 1) + 1) % 1;

          const width = Math.max(1, Number(texture.width) || Number(texture.orig?.width) || Number(texture.baseTexture?.realWidth) || 1);
          const height = Math.max(1, Number(texture.height) || Number(texture.orig?.height) || Number(texture.baseTexture?.realHeight) || 1);
          const x = u * width;
          const y = v * height;

          const alphaData = this._getAlphaData(texture, options);
          if (!alphaData) return null;

          const scaleX = alphaData.width / width;
          const scaleY = alphaData.height / height;
          const sx = x * scaleX;
          const sy = y * scaleY;

          // Check bounds against full texture
          if (sx < 0 || sx >= alphaData.width || sy < 0 || sy >= alphaData.height) return 0;

          const px = Math.floor(sx);
          const py = Math.floor(sy);

          const alphaArray = alphaData.alpha;
          if (!alphaArray) return null;
          const alphaWidth = Math.max(1, alphaData.width || 1);
          const alphaHeight = Math.max(1, alphaData.height || 1);
          const lumaArray = alphaData.luma;
          const useLuma = !!(options.useLumaWhenOpaque && lumaArray);

          const sampleAt = (ix, iy) => {
            if (ix < 0 || ix >= alphaWidth || iy < 0 || iy >= alphaHeight) return 0;
            const index = (iy * alphaWidth) + ix;
            if (index < 0 || index >= alphaArray.length) return 0;
            const alphaByte = alphaArray[index];
            let value = Number.isFinite(alphaByte) ? alphaByte / 255 : 0;
            if (useLuma) {
              const lumaByte = lumaArray[index];
              const luma = Number.isFinite(lumaByte) ? lumaByte / 255 : 0;
              value *= luma;
            }
            return value;
          };

          let value = sampleAt(px, py);
          const radius = Math.max(0, Math.floor(Number(options.expandRadius) || 0));
          if (radius > 0 && value <= 0) {
            for (let dy = -radius; dy <= radius; dy += 1) {
              for (let dx = -radius; dx <= radius; dx += 1) {
                if (!dx && !dy) continue;
                const sampled = sampleAt(px + dx, py + dy);
                if (sampled > value) value = sampled;
                if (value >= 1) break;
              }
              if (value >= 1) break;
            }
          }
          return value;
        }
      }
      return 0;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleMeshTextureAlpha failed', err);
      return null;
    }
  }

  static _barycentricCoords(px, py, ax, ay, bx, by, cx, cy) {
    const v0x = bx - ax;
    const v0y = by - ay;
    const v1x = cx - ax;
    const v1y = cy - ay;
    const v2x = px - ax;
    const v2y = py - ay;

    const d00 = v0x * v0x + v0y * v0y;
    const d01 = v0x * v1x + v0y * v1y;
    const d11 = v1x * v1x + v1y * v1y;
    const d20 = v2x * v0x + v2y * v0y;
    const d21 = v2x * v1x + v2y * v1y;
    const denom = d00 * d11 - d01 * d01;

    if (Math.abs(denom) < 1e-8) return null;
    const v = (d11 * d20 - d01 * d21) / denom;
    const w = (d00 * d21 - d01 * d20) / denom;
    const u = 1 - v - w;
    return { u, v, w };
  }

  static _pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
    const v0x = cx - ax;
    const v0y = cy - ay;
    const v1x = bx - ax;
    const v1y = by - ay;
    const v2x = px - ax;
    const v2y = py - ay;

    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;

    const denom = (dot00 * dot11) - (dot01 * dot01);
    if (Math.abs(denom) < 1e-8) return false;
    const invDenom = 1 / denom;
    const u = ((dot11 * dot02) - (dot01 * dot12)) * invDenom;
    const v = ((dot00 * dot12) - (dot01 * dot02)) * invDenom;
    return (u >= -1e-4) && (v >= -1e-4) && (u + v <= 1 + 1e-4);
  }

  static _sampleSpriteAlpha(sprite, worldX, worldY, options = {}) {
    try {
      const texture = sprite?.texture;
      if (!texture?.valid) return null;
      const local = sprite.worldTransform.applyInverse({ x: worldX, y: worldY }, _tempPointB);
      if (!local) return null;

      const width = texture.width;
      const height = texture.height;
      const anchor = sprite.anchor || { x: 0, y: 0 };
      const x = local.x + (anchor.x * width);
      const y = local.y + (anchor.y * height);
      if (x < 0 || y < 0 || x >= width || y >= height) return 0;

      const alphaData = this._getAlphaData(texture, options);
      if (!alphaData) return null;

      const scaleX = alphaData.width / width;
      const scaleY = alphaData.height / height;
      const sx = x * scaleX;
      const sy = y * scaleY;
      const px = Math.floor(sx);
      const py = Math.floor(sy);
      const minX = alphaData.minX ?? 0;
      const minY = alphaData.minY ?? 0;
      const maxX = alphaData.maxX ?? alphaData.width;
      const maxY = alphaData.maxY ?? alphaData.height;
      if (px < minX || px >= maxX || py < minY || py >= maxY) return 0;
      const alphaWidth = Math.max(1, alphaData.width || 1);
      const alphaHeight = Math.max(1, alphaData.height || 1);
      if (px < 0 || px >= alphaWidth || py < 0 || py >= alphaHeight) return 0;
      // Alpha buffers keep the full texture stride; index with actual width to avoid skewed samples.
      const index = (py * alphaWidth) + px;
      const alphaArray = alphaData.alpha;
      if (!alphaArray) return null;
      const lumaArray = alphaData.luma;
      const alphaByte = alphaArray ? alphaArray[index] : 0;
      let value = Number.isFinite(alphaByte) ? alphaByte / 255 : 0;
      if (options.useLumaWhenOpaque && lumaArray) {
        const lumaByte = lumaArray[index];
        const luma = Number.isFinite(lumaByte) ? lumaByte / 255 : 0;
        value *= luma;
      }
      if (value <= 0) return 0;
      if (value >= 1) return 1;
      return value;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleSpriteAlpha failed', err);
      return null;
    }
  }

  static _resolveAlphaResolution(texture, options = {}) {
    const explicit = Number(options?.resolution);
    if (Number.isFinite(explicit) && explicit > 0) {
      return Math.min(1, Math.max(MIN_ALPHA_RESOLUTION, explicit));
    }
    const target = Number(options?.target);
    if (!(Number.isFinite(target) && target > 0)) return DEFAULT_ALPHA_RESOLUTION;
    const width = Math.max(1, Math.round(texture?.orig?.width ?? texture?.width ?? texture?.baseTexture?.realWidth ?? 1));
    const height = Math.max(1, Math.round(texture?.orig?.height ?? texture?.height ?? texture?.baseTexture?.realHeight ?? 1));
    const maxDim = Math.max(width, height);
    if (!Number.isFinite(maxDim) || maxDim <= 0) return DEFAULT_ALPHA_RESOLUTION;
    const desired = target / maxDim;
    return Math.min(1, Math.max(DEFAULT_ALPHA_RESOLUTION, desired));
  }

  static _getAlphaData(texture, options = {}) {
    try {
      const base = texture?.baseTexture;
      if (!base) return null;
      const frame = texture.frame;
      let resolution = this._resolveAlphaResolution(texture, options);
      if (!Number.isFinite(resolution) || resolution <= 0) resolution = DEFAULT_ALPHA_RESOLUTION;
      resolution = Math.round(resolution * 1000) / 1000;
      const key = frame
        ? `${frame.x},${frame.y},${frame.width},${frame.height}|r:${resolution}`
        : `frame:default|r:${resolution}`;
      let frameMap = this._alphaCache?.get(base);
      if (!frameMap) {
        frameMap = new Map();
        this._alphaCache?.set(base, frameMap);
      }
      const currentDirty = Number(base.dirtyId ?? 0);
      let entry = frameMap.get(key);
      if (entry && entry.dirty !== currentDirty) entry = null;
      if (!entry) {
        entry = this._buildAlphaData(texture, resolution);
        if (!entry) return null;
        entry.dirty = currentDirty;
        frameMap.set(key, entry);
      }
      return entry;
    } catch (err) {
      Logger.debug('TilePixelSelection._getAlphaData failed', err);
      return null;
    }
  }

  static _buildAlphaData(texture, resolution = DEFAULT_ALPHA_RESOLUTION) {
    try {
      const renderer = canvas?.app?.renderer;
      if (!renderer) return null;
      const width = Math.max(1, Math.round(texture?.orig?.width ?? texture?.width ?? texture?.baseTexture?.realWidth ?? 1));
      const height = Math.max(1, Math.round(texture?.orig?.height ?? texture?.height ?? texture?.baseTexture?.realHeight ?? 1));
      const resolved = Number.isFinite(resolution) && resolution > 0 ? Math.min(1, Math.max(MIN_ALPHA_RESOLUTION, resolution)) : DEFAULT_ALPHA_RESOLUTION;
      const targetWidth = Math.max(1, Math.round(width * resolved));
      const targetHeight = Math.max(1, Math.round(height * resolved));
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0, 0);
      sprite.width = targetWidth;
      sprite.height = targetHeight;
      const renderTexture = PIXI.RenderTexture.create({ width: targetWidth, height: targetHeight });
      renderer.render(sprite, { renderTexture, clear: true });
      sprite.destroy();
      const pixels = renderer.extract.pixels(renderTexture);
      renderTexture.destroy(true);

      const alpha = new Uint8Array(targetWidth * targetHeight);
      const luma = new Uint8Array(targetWidth * targetHeight);
      let minX = targetWidth;
      let minY = targetHeight;
      let maxX = 0;
      let maxY = 0;
      for (let i = 0, j = 0, y = 0; y < targetHeight; y++) {
        for (let x = 0; x < targetWidth; x++, j++, i += 4) {
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          const a = pixels[i + 3];
          const maxRGB = Math.max(r, g, b);
          alpha[j] = a;
          luma[j] = maxRGB;
          if (a === 0 && maxRGB === 0) continue;
          const effective = Math.max(a, maxRGB);
          if (effective === 0) continue;
          if (x < minX) minX = x;
          if (x >= maxX) maxX = x + 1;
          if (y < minY) minY = y;
          if (y >= maxY) maxY = y + 1;
        }
      }
      if (maxX === 0 && maxY === 0) {
        minX = 0;
        minY = 0;
      }
      return { width: targetWidth, height: targetHeight, minX, minY, maxX, maxY, alpha, luma };
    } catch (err) {
      Logger.debug('TilePixelSelection._buildAlphaData failed', err);
      return null;
    }
  }
}

TilePixelSelection.install();
