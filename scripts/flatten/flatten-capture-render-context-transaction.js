import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { collectActiveFaNexusSessionBlockers } from '../canvas/active-session-level-switch-guard.js';
import { AssetShadowManager } from '../assets/asset-shadow-manager.js';
import {
  applyMaskedTilingToTile,
  applyStandardTileMaskToTile
} from '../textures/texture-mask-runtime.js';
import { applyPathTile } from '../paths/path-geometry.js';
import {
  applyAssetScatterTile,
  refreshAllAssetScatterViewportLayers,
  restoreAssetScatterCaptureLayer,
  syncAssetScatterCaptureLayer
} from '../assets/asset-scatter-geometry.js';
import {
  getDocumentMembershipInLevel,
  normalizeLevelId,
  normalizeLevelIds
} from './flatten-level-scope.js';

const MODULE_ID = 'fa-nexus';
const DOOR_MEMBERSHIP_OPTIONS = Object.freeze({
  preferHelperForExplicitLevels: true,
  nullWhenHelperUndefined: true
});

export class FlattenCaptureRenderContextTransaction {
  constructor(manager, { logger = Logger } = {}) {
    if (!manager) throw new Error('FlattenCaptureRenderContextTransaction requires manager.');
    this.manager = manager;
    this.logger = logger;
  }

  async begin({ tiles, renderBounds, activeCanvas, renderer, options = {} } = {}) {
    // A native Tile's committed source can be unchanged while a local editor
    // renders draft artwork. Refuse before touching visibility or the ticker.
    if (collectActiveFaNexusSessionBlockers().length) {
      throw new Error('Finish or cancel the active FA Nexus session before flattening or exporting.');
    }
    // Scene.view resolves before the next ticker pass applies Tile render flags.
    // Drain those flags before stopping the ticker or saving capture visibility;
    // otherwise a newly drawn mesh can retain its texture's default size and tint.
    const deadline = Date.now() + 15000;
    while (tiles.some((doc) => !doc.object || doc.object.renderFlags.size)) {
      if (canvas !== activeCanvas || !activeCanvas.ready
        || tiles.some((doc) => doc.parent !== activeCanvas.scene)) {
        throw new Error('The viewed Scene changed while preparing Tile capture.');
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for Foundry Tile rendering before flatten/export.');
      }
      await this.manager._nextFrame();
    }
    const capture = {
      tiles,
      renderGuard: this._suspendCanvasRender(options?.suspendRender),
      visibilityState: null,
      renderContext: null,
      renderContextRestored: false,
      visibilityRestored: false,
      renderGuardRestored: false
    };

    try {
      capture.visibilityState = await this._applyVisibility(tiles, renderBounds, options?.visibility);
      await this._waitForShadowLayers(capture.visibilityState.shadowManager, capture.visibilityState.shadowLayerKeys);
      await this._prepareTilesForCapture(tiles);
      this._forceTilesCaptureVisibility(tiles);
      await this.manager._nextFrame();
      capture.renderContext = this._beginRenderContext({
        activeCanvas,
        renderer,
        options,
        visibilityState: capture.visibilityState
      });
      return capture;
    } catch (error) {
      await this.restore(capture);
      throw error;
    }
  }

  async prepare(capture, options = {}) {
    await this._prepareRenderContext(capture?.renderContext, options);
  }

  updateTransforms(capture, options = {}) {
    this._updateRenderTransforms(capture?.renderContext, options);
  }

  async prepareScatter(capture, renderBounds, reason = 'flatten-capture', options = {}) {
    await this._prepareScatterForCapture(capture?.tiles, renderBounds, reason, options);
  }

  async restoreRenderContext(capture) {
    if (!capture || capture.renderContextRestored) return;
    await this._restoreRenderContext(capture.renderContext, capture.tiles);
    capture.renderContextRestored = true;
  }

  async restore(capture) {
    if (!capture) return;
    try {
      await this.restoreRenderContext(capture);
    } finally {
      try {
        if (!capture.visibilityRestored && capture.visibilityState) {
          await this._restoreVisibility(capture.visibilityState);
          capture.visibilityRestored = true;
        }
      } finally {
        if (!capture.renderGuardRestored && typeof capture.renderGuard === 'function') {
          try { capture.renderGuard(); } catch (_) {}
          capture.renderGuardRestored = true;
        }
      }
    }
  }

  _beginRenderContext({ activeCanvas, renderer, options = {}, visibilityState = null } = {}) {
    const stage = activeCanvas?.stage;
    const primary = activeCanvas?.primary;
    if (!stage || !primary) throw new Error('Canvas stage/primary unavailable');

    const keepBackground = !!options?.visibility?.keepBackground;
    const restorePrimaryRender = keepBackground ? null : this._forcePrimaryTransparentClear(primary);
    const restorePrimaryDisplay = this._usePrimaryChildRendering(primary);

    const originalStageState = {
      scaleX: stage.scale?.x ?? 1,
      scaleY: stage.scale?.y ?? 1,
      positionX: stage.position?.x ?? 0,
      positionY: stage.position?.y ?? 0,
      pivotX: stage.pivot?.x ?? 0,
      pivotY: stage.pivot?.y ?? 0
    };

    const originalScreen = renderer.screen
      ? { width: renderer.screen.width, height: renderer.screen.height }
      : null;

    const rendererBackground = renderer.background || null;
    const previousBackground = rendererBackground
      ? { alpha: rendererBackground.alpha, color: rendererBackground.color }
      : null;
    const hasBackgroundAlpha = typeof renderer.backgroundAlpha === 'number';
    const previousBackgroundAlpha = hasBackgroundAlpha ? renderer.backgroundAlpha : null;

    // Native and custom Tile shaders must not bake the viewed camera's live
    // surface/token occlusion mask into static artwork. Keep ordinary opacity.
    const occlusionState = Array.from(primary.objects || [])
      .filter((object) => Number.isFinite(object?.occludedAlpha) && Number.isFinite(object?.unoccludedAlpha))
      .map((object) => ({ object, occludedAlpha: object.occludedAlpha }));
    for (const { object } of occlusionState) object.occludedAlpha = object.unoccludedAlpha;

    return {
      activeCanvas,
      renderer,
      stage,
      primary,
      visibilityState,
      originalStageState,
      originalScreen,
      rendererBackground,
      previousBackground,
      hasBackgroundAlpha,
      previousBackgroundAlpha,
      occlusionState,
      restorePrimaryDisplay,
      restorePrimaryRender,
      restoreShadowBlur: null,
      stageAdjusted: false
    };
  }

  async _prepareRenderContext(context, {
    resolution,
    screenSize = null,
    position = null,
    logPosition = null,
    logScale = false
  } = {}) {
    const { renderer, stage, rendererBackground, hasBackgroundAlpha } = context;
    if (screenSize && renderer.screen) {
      renderer.screen.width = screenSize.width;
      renderer.screen.height = screenSize.height;
    }

    try {
      if (stage.pivot && typeof stage.pivot.set === 'function') {
        stage.pivot.set(0, 0);
      }
    } catch (_) {}

    if (position) {
      try {
        if (stage.position && typeof stage.position.set === 'function') {
          stage.position.set(position.x, position.y);

          if (logPosition) {
            this.logger.debug?.('TileFlatten.capture.stagePositionSet', {
              renderBounds: logPosition.renderBounds,
              resolution,
              targetPosition: logPosition.targetPosition,
              stagePosition: { x: stage.position.x, y: stage.position.y }
            });
          }
        }
      } catch (_) {}
    }

    try {
      if (stage.scale && typeof stage.scale.set === 'function') {
        stage.scale.set(resolution, resolution);

        if (logScale) {
          this.logger.debug?.('TileFlatten.capture.stageScaleSet', {
            resolution,
            stageScale: { x: stage.scale.x, y: stage.scale.y }
          });
        }
      }
    } catch (_) {}

    context.restoreShadowBlur = this._syncShadowBlurForCapture(context.visibilityState.shadowManager);

    if (rendererBackground) {
      try {
        rendererBackground.alpha = 0;
      } catch (_) {}
    }
    if (hasBackgroundAlpha) {
      try {
        renderer.backgroundAlpha = 0;
      } catch (_) {}
    }

    context.stageAdjusted = true;

    await this.manager._nextFrame();
    this._updateRenderTransforms(context);
    await this.manager._nextFrame();
  }

  _updateRenderTransforms(context, { includeLayers = true } = {}) {
    if (!context) return;
    const { activeCanvas, stage, primary } = context;

    try {
      if (typeof stage.updateTransform === 'function') {
        stage.updateTransform();
      }
    } catch (_) {}

    try {
      if (typeof primary.updateTransform === 'function') {
        primary.updateTransform();
      }
    } catch (_) {}

    if (!includeLayers) return;

    const tilesLayer = activeCanvas.tiles;
    const backgroundLayer = activeCanvas.background;
    try {
      if (tilesLayer && typeof tilesLayer.updateTransform === 'function') {
        tilesLayer.updateTransform();
      }
    } catch (_) {}
    try {
      if (backgroundLayer && typeof backgroundLayer.updateTransform === 'function') {
        backgroundLayer.updateTransform();
      }
    } catch (_) {}
  }

  async _restoreRenderContext(context, tiles) {
    if (!context) return;
    const {
      renderer,
      stage,
      originalStageState,
      originalScreen,
      rendererBackground,
      previousBackground,
      hasBackgroundAlpha,
      previousBackgroundAlpha,
      occlusionState,
      restorePrimaryDisplay,
      restorePrimaryRender,
      restoreShadowBlur
    } = context;

    if (context.stageAdjusted) {
      try {
        if (stage.scale && typeof stage.scale.set === 'function') {
          stage.scale.set(originalStageState.scaleX, originalStageState.scaleY);
        }
      } catch (_) {}

      try {
        if (stage.position && typeof stage.position.set === 'function') {
          stage.position.set(originalStageState.positionX, originalStageState.positionY);
        }
      } catch (_) {}

      try {
        if (stage.pivot && typeof stage.pivot.set === 'function') {
          stage.pivot.set(originalStageState.pivotX, originalStageState.pivotY);
        }
      } catch (_) {}

      if (originalScreen && renderer.screen) {
        renderer.screen.width = originalScreen.width;
        renderer.screen.height = originalScreen.height;
      }

      try {
        if (typeof stage.updateTransform === 'function') {
          stage.updateTransform();
        }
      } catch (_) {}
    }

    if (rendererBackground && previousBackground) {
      try {
        rendererBackground.alpha = previousBackground.alpha;
        rendererBackground.color = previousBackground.color;
      } catch (_) {}
    }
    if (hasBackgroundAlpha && previousBackgroundAlpha !== null) {
      try {
        renderer.backgroundAlpha = previousBackgroundAlpha;
      } catch (_) {}
    }

    for (const { object, occludedAlpha } of occlusionState || []) {
      if (!object.destroyed) object.occludedAlpha = occludedAlpha;
    }

    if (typeof restorePrimaryDisplay === 'function') {
      try { restorePrimaryDisplay(); } catch (_) {}
    }
    if (typeof restorePrimaryRender === 'function') {
      try { restorePrimaryRender(); } catch (_) {}
    }
    if (typeof restoreShadowBlur === 'function') {
      try { restoreShadowBlur(); } catch (_) {}
    }
    await this._restoreScatterAfterCapture(tiles);
  }

  async _prepareTilesForCapture(tiles) {
    const jobs = [];
    const failures = [];
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      try {
        const placeable = doc?.object;
        if (!placeable) continue;
        if (doc.getFlag?.(MODULE_ID, 'maskedTiling')) {
          jobs.push({
            tileId: doc?.id || null,
            task: Promise.resolve(applyMaskedTilingToTile(placeable))
          });
        }
        if (doc.getFlag?.(MODULE_ID, 'standardTileMask')) {
          jobs.push({
            tileId: doc?.id || null,
            task: Promise.resolve(applyStandardTileMaskToTile(placeable))
          });
        }
        if (
          doc.getFlag?.(MODULE_ID, 'pathV2')
          || doc.getFlag?.(MODULE_ID, 'pathsV2')
        ) {
          jobs.push({
            tileId: doc?.id || null,
            task: Promise.resolve(applyPathTile(placeable))
          });
        }
        if (doc.getFlag?.(MODULE_ID, 'assetScatter')) {
          jobs.push({
            tileId: doc?.id || null,
            task: Promise.resolve(applyAssetScatterTile(placeable))
          });
        }
      } catch (error) {
        failures.push(error);
        this.logger.warn?.('TileFlatten.capture.prepareTile.failed', {
          tileId: doc?.id || null,
          error: String(error?.message || error)
        });
      }
    }
    if (jobs.length) {
      const results = await Promise.allSettled(jobs.map((job) => job.task));
      results.forEach((result, index) => {
        if (result.status !== 'rejected') return;
        failures.push(result.reason);
        this.logger.warn?.('TileFlatten.capture.prepareJob.failed', {
          tileId: jobs[index]?.tileId || null,
          error: String(result.reason?.message || result.reason)
        });
      });
    }
    if (failures.length) {
      throw new Error(`Tile flatten capture prep failed for ${failures.length} job(s).`);
    }
  }

  async _prepareScatterForCapture(tiles, renderBounds, reason = 'flatten-capture', options = {}) {
    const scatterTiles = [];
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      try {
        if (!doc?.getFlag?.(MODULE_ID, 'assetScatter')) continue;
        if (renderBounds && !this.manager._tileOverlapsBounds(doc, renderBounds)) continue;
        const placeable = doc.object;
        if (!placeable || placeable.destroyed) {
          throw new Error(`Scatter tile ${doc.id || '(unknown)'} has no active placeable for capture.`);
        }
        const container = placeable?.mesh?.faNexusAssetScatterContainer || placeable?.faNexusAssetScatterContainer || null;
        if (!container || container.destroyed) await applyAssetScatterTile(placeable);
        const localBounds = this._computeScatterCaptureLocalBounds(doc, renderBounds);
        if (!localBounds) {
          throw new Error(`Scatter tile ${doc.id || '(unknown)'} could not resolve capture bounds.`);
        }
        syncAssetScatterCaptureLayer(placeable, localBounds, {
          reason,
          resolution: options?.resolution
        });
        scatterTiles.push(placeable);
      } catch (error) {
        this.logger.warn?.('TileFlatten.capture.scatterPrepare.failed', {
          tileId: doc?.id || null,
          error: String(error?.message || error)
        });
        throw error;
      }
    }

    if (!scatterTiles.length) return;

    const failures = [];
    for (const tile of scatterTiles) {
      const container = tile?.mesh?.faNexusAssetScatterContainer || tile?.faNexusAssetScatterContainer || null;
      if (!container || container.destroyed) {
        failures.push({
          tileId: tile?.document?.id || null,
          reason: 'container-missing'
        });
        continue;
      }
      if (!container.faNexusAssetScatterCached || container.faNexusAssetScatterCacheMode === 'live') continue;
      const cacheStillEnabled = container.faNexusAssetScatterCacheVisualEnabled !== false;
      if (!cacheStillEnabled) continue;
      failures.push({
        tileId: tile?.document?.id || null,
        reason: 'capture-live-layer-unavailable',
        cacheMode: container.faNexusAssetScatterCacheMode || null,
        instances: Array.isArray(container.faNexusAssetScatterInstancesWithBounds)
          ? container.faNexusAssetScatterInstancesWithBounds.length
          : null,
        liveInstances: Number(container.faNexusAssetScatterViewportLiveCount) || 0
      });
    }

    if (failures.length) {
      this.logger.error('TileFlatten.capture.scatterFullResolution.failed', { reason, failures });
      throw new Error('Scatter flatten/export could not switch to full-resolution capture. Try a smaller chunk size or reduce visible scatter density.');
    }
  }

  _computeScatterCaptureLocalBounds(doc, bounds) {
    try {
      if (!doc || !bounds) return null;
      const width = Math.max(1, Number(doc.width) || 0);
      const height = Math.max(1, Number(doc.height) || 0);
      const anchorX = Number(doc?.texture?.anchorX);
      const anchorY = Number(doc?.texture?.anchorY);
      const resolvedAnchorX = Number.isFinite(anchorX) ? anchorX : 0.5;
      const resolvedAnchorY = Number.isFinite(anchorY) ? anchorY : 0.5;
      const scaleX = Number(doc?.texture?.scaleX ?? 1);
      const scaleY = Number(doc?.texture?.scaleY ?? 1);
      const resolvedScaleX = Number.isFinite(scaleX) && Math.abs(scaleX) > 1e-6 ? scaleX : 1;
      const resolvedScaleY = Number.isFinite(scaleY) && Math.abs(scaleY) > 1e-6 ? scaleY : 1;
      const originX = Number(doc.x) || 0;
      const originY = Number(doc.y) || 0;
      const rotation = ((Number(doc.rotation) || 0) * Math.PI) / 180;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const points = [
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        { x: bounds.x, y: bounds.y + bounds.height }
      ];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of points) {
        const dx = (Number(point.x) || 0) - originX;
        const dy = (Number(point.y) || 0) - originY;
        const unrotatedX = (dx * cos) + (dy * sin);
        const unrotatedY = (-dx * sin) + (dy * cos);
        const localX = (unrotatedX / resolvedScaleX) + (width * resolvedAnchorX);
        const localY = (unrotatedY / resolvedScaleY) + (height * resolvedAnchorY);
        minX = Math.min(minX, localX);
        minY = Math.min(minY, localY);
        maxX = Math.max(maxX, localX);
        maxY = Math.max(maxY, localY);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
      const padding = 2;
      return {
        x: minX - padding,
        y: minY - padding,
        width: Math.max(1, (maxX - minX) + (padding * 2)),
        height: Math.max(1, (maxY - minY) + (padding * 2))
      };
    } catch (error) {
      this.logger.warn?.('TileFlatten.capture.scatterBounds.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }

  async _restoreScatterAfterCapture(tiles) {
    try {
      const hasScatter = Array.isArray(tiles)
        && tiles.some((doc) => {
          try { return !!doc?.getFlag?.(MODULE_ID, 'assetScatter'); }
          catch (_) { return false; }
        });
      if (!hasScatter) return;
      for (const doc of tiles) {
        try {
          if (!doc?.getFlag?.(MODULE_ID, 'assetScatter')) continue;
          const placeable = doc.object;
          if (placeable && !placeable.destroyed) restoreAssetScatterCaptureLayer(placeable);
        } catch (error) {
          this.logger.warn?.('TileFlatten.capture.scatterTileRestore.failed', {
            tileId: doc?.id || null,
            error: String(error?.message || error)
          });
        }
      }
      refreshAllAssetScatterViewportLayers('flatten-capture-restore', { force: true });
    } catch (error) {
      this.logger.warn?.('TileFlatten.capture.scatterRestore.failed', {
        error: String(error?.message || error)
      });
    }
  }

  _forceTilesCaptureVisibility(tiles) {
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      try {
        this._forceTileCaptureVisibility(doc?.object);
      } catch (_) {}
    }
  }

  _forceTileCaptureVisibility(placeable) {
    const targets = [placeable, placeable?.root, placeable?.mesh, placeable?.sprite];
    const seen = new Set();
    for (const target of targets) {
      if (!target || target.destroyed || seen.has(target)) continue;
      seen.add(target);
      try { target.visible = true; } catch (_) {}
      try {
        if (typeof target.renderable === 'boolean') target.renderable = true;
      } catch (_) {}
    }

    const containers = [
      placeable?.mesh?.faNexusMaskContainer || placeable?.faNexusMaskContainer || null,
      placeable?.mesh?.faNexusStandardMaskContainer || placeable?.faNexusStandardMaskContainer || null,
      placeable?.mesh?.faNexusPathContainer || placeable?.faNexusPathContainer || null,
      placeable?.mesh?.faNexusAssetScatterContainer || placeable?.faNexusAssetScatterContainer || null
    ];
    for (const container of containers) {
      if (!container || container.destroyed || seen.has(container)) continue;
      seen.add(container);
      try { container.visible = true; } catch (_) {}
      try {
        if (typeof container.renderable === 'boolean') container.renderable = true;
      } catch (_) {}

      const tiling = container.faNexusTilingSprite || null;
      if (tiling && !tiling.destroyed && !seen.has(tiling)) {
        seen.add(tiling);
        try { tiling.visible = true; } catch (_) {}
        try {
          if (typeof tiling.renderable === 'boolean') tiling.renderable = true;
        } catch (_) {}
      }

      const maskSprite = container.faNexusMaskSprite || null;
      if (maskSprite && !maskSprite.destroyed && !seen.has(maskSprite)) {
        seen.add(maskSprite);
        try { maskSprite.visible = true; } catch (_) {}
      }
    }
  }

  _resolveDoorElevation(doc) {
    try {
      const directElevation = doc?.elevation;
      if (Number.isFinite(directElevation)) return Number(directElevation);
    } catch (_) {}
    try {
      const flagElevation = doc?.getFlag?.(MODULE_ID, 'buildingWall')?.elevation;
      if (Number.isFinite(flagElevation)) return Number(flagElevation);
    } catch (_) {}
    try {
      const coreElevation = doc?.getFlag?.('core', 'elevation');
      if (Number.isFinite(coreElevation)) return Number(coreElevation);
    } catch (_) {}
    try {
      const flags = doc?.flags || doc?._source?.flags || {};
      const faElevation = flags?.[MODULE_ID]?.buildingWall?.elevation;
      if (Number.isFinite(Number(faElevation))) return Number(faElevation);
      const coreElevation = flags?.core?.elevation;
      if (Number.isFinite(Number(coreElevation))) return Number(coreElevation);
    } catch (_) {}
    const foregroundElevation = Number(canvas?.primary?.foreground?.elevation);
    return Number.isFinite(foregroundElevation) ? foregroundElevation - 1 : 0;
  }

  _isDoorElevationIncluded(elevation, visibility = null, doc = null) {
    if (!visibility || typeof visibility !== 'object') return true;
    if (visibility.wallIds && doc && !visibility.wallIds.includes(doc.id)) return false;
    const levelIds = normalizeLevelIds(visibility.levelIds);
    if (levelIds.length && doc) {
      const included = levelIds.some((levelId) => getDocumentMembershipInLevel(doc, levelId, DOOR_MEMBERSHIP_OPTIONS) !== false);
      if (!included) return false;
    }
    const minElevation = Number(visibility.minElevation);
    const maxElevation = Number(visibility.maxElevation);
    if (Number.isFinite(minElevation) && elevation < minElevation) return false;
    if (Number.isFinite(maxElevation) && elevation >= maxElevation) return false;
    return true;
  }

  _isDoorVisualProxyIncluded(child, visibility = null) {
    if (!visibility || typeof visibility !== 'object') return true;
    const levelIds = normalizeLevelIds(visibility.levelIds);
    const sourceLevelId = normalizeLevelId(child?.faNexusSourceLevelId);
    if (levelIds.length && sourceLevelId && !levelIds.includes(sourceLevelId)) return false;
    const elevation = Number(
      child?.elevation
      ?? child?._closedPosition?.elevation
      ?? child?._animatedPosition?.elevation
    );
    return this._isDoorElevationIncluded(Number.isFinite(elevation) ? elevation : 0, visibility);
  }

  async _extractDoorMeshesForExport(doorVisibility = null) {
    try {
      const wallsLayer = canvas?.walls;
      const placeables = Array.isArray(wallsLayer?.placeables) ? wallsLayer.placeables : [];
      if (!placeables.length) return null;

      const entries = [];
      const candidateWalls = [];
      for (const wall of placeables) {
        const doc = wall?.document || wall;
        const hasDoorFlag = !!(doc?.getFlag?.(MODULE_ID, 'buildingDoor') || doc?.getFlag?.(MODULE_ID, 'buildingWindow'));
        const doorType = Number(doc?.door ?? doc?._source?.door ?? doc?.data?.door ?? 0);
        if (hasDoorFlag || doorType) candidateWalls.push(wall);
      }

      if (!candidateWalls.length) return null;

      let waitCount = 0;
      while (waitCount < 6) {
        let missing = false;
        for (const wall of candidateWalls) {
          const meshes = wall?.doorMeshes ? Array.from(wall.doorMeshes) : [];
          if (!meshes.length) {
            missing = true;
            break;
          }
        }
        if (!missing) break;
        waitCount += 1;
        await this.manager._nextFrame();
      }

      for (const wall of candidateWalls) {
        const doorMeshes = wall?.doorMeshes ? Array.from(wall.doorMeshes) : [];
        if (!doorMeshes.length) continue;
        const doc = wall?.document || wall;
        const elevation = this._resolveDoorElevation(doc);
        const include = this._isDoorElevationIncluded(elevation, doorVisibility, doc);
        for (const mesh of doorMeshes) {
          if (!mesh || mesh.destroyed) continue;
          entries.push({
            mesh,
            visible: typeof mesh.visible === 'boolean' ? mesh.visible : null,
            renderable: typeof mesh.renderable === 'boolean' ? mesh.renderable : null
          });
          try {
            mesh.visible = !!include;
            if (typeof mesh.renderable === 'boolean') mesh.renderable = !!include;
          } catch (_) {}
        }
      }

      if (!entries.length) return null;

      return { entries };
    } catch (error) {
      this.logger.debug?.('TileFlatten.doorMeshes.captureFailed', { error: String(error?.message || error) });
      return null;
    }
  }

  _restoreDoorMeshesForExport(state) {
    if (!state || typeof state !== 'object') return;
    const entries = Array.isArray(state.entries) ? state.entries : [];
    for (const entry of entries) {
      const mesh = entry?.mesh;
      if (!mesh || mesh.destroyed) continue;
      try {
        if (entry?.visible !== null && typeof entry?.visible === 'boolean') mesh.visible = entry.visible;
        if (entry?.renderable !== null && typeof entry?.renderable === 'boolean') mesh.renderable = entry.renderable;
      } catch (_) {}
    }
  }

  async _applyVisibility(tiles, renderBounds, options = {}) {
    const selectedIds = new Set();
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      if (doc?.id) selectedIds.add(doc.id);
    }

    const doorMeshState = options?.keepDoors
      ? await this._extractDoorMeshesForExport(options?.doorVisibility)
      : null;

    const tilesLayer = canvas?.tiles;
    const placeables = Array.isArray(tilesLayer?.placeables) ? tilesLayer.placeables : [];
    const hiddenTiles = [];

    for (const placeable of placeables) {
      const doc = placeable?.document;
      if (!doc) continue;
      if (selectedIds.has(doc.id)) continue;
      if (renderBounds && !this.manager._tileOverlapsBounds(doc, renderBounds)) continue;
      if (placeable.visible) {
        placeable.visible = false;
        hiddenTiles.push(placeable);
      }
    }

    const backgroundLayer = canvas?.background;
    const backgroundPlaceables = Array.isArray(backgroundLayer?.placeables) ? backgroundLayer.placeables : [];
    const hiddenBackgroundTiles = [];

    for (const placeable of backgroundPlaceables) {
      const doc = placeable?.document;
      if (!doc) continue;
      if (selectedIds.has(doc.id)) {
        try {
          if (!placeable.visible) placeable.visible = true;
        } catch (_) {}
        continue;
      }
      if (renderBounds && !this.manager._tileOverlapsBounds(doc, renderBounds)) continue;
      if (placeable.visible) {
        placeable.visible = false;
        hiddenBackgroundTiles.push(placeable);
      }
    }

    const primary = canvas?.primary;
    const hiddenPrimary = [];
    const forcedDoorVisualProxies = [];
    const retainWallsLayer = !!options?.keepDoors && !doorMeshState;
    if (primary?.children) {
      for (const child of primary.children) {
        if (!child) continue;
        const name = typeof child?.name === 'string' ? child.name : '';
        const keep = this._shouldRetainPrimaryChild(child, options)
          || (retainWallsLayer && (child === canvas?.walls || name === 'walls'));
        if (keep && child.faNexusDoorVisualProxy && (child.visible === false || child.renderable === false)) {
          forcedDoorVisualProxies.push({ child, visible: child.visible, renderable: child.renderable });
          child.visible = true;
          if (typeof child.renderable === 'boolean') child.renderable = true;
        }
        if (!keep && child.visible) {
          hiddenPrimary.push({ child, visible: true });
          child.visible = false;
        }
      }
    }

    const hiddenSceneImages = [];
    const hiddenSceneTargets = new Set();
    const hideSceneTarget = (target) => {
      if (!target || hiddenSceneTargets.has(target)) return;
      if (typeof target.visible !== 'boolean') return;
      if (!target.visible) return;
      hiddenSceneTargets.add(target);
      hiddenSceneImages.push({ target, visible: true });
      target.visible = false;
    };
    const keepBackground = !!options?.keepBackground;
    const keepForeground = !!options?.keepForeground;
    if (!keepBackground) {
      hideSceneTarget(canvas?.primary?.background);
      hideSceneTarget(canvas?.primary?.background?.mesh);
      hideSceneTarget(canvas?.primary?.background?.sprite);
      const backgroundLayerIsPlaceable = Array.isArray(backgroundLayer?.placeables);
      if (backgroundLayer && !backgroundLayerIsPlaceable) {
        hideSceneTarget(backgroundLayer);
      }
    }
    if (!keepForeground) {
      hideSceneTarget(canvas?.primary?.foreground);
      hideSceneTarget(canvas?.primary?.foreground?.mesh);
      hideSceneTarget(canvas?.primary?.foreground?.sprite);
      const foregroundLayer = canvas?.foreground;
      const foregroundLayerIsPlaceable = Array.isArray(foregroundLayer?.placeables);
      if (foregroundLayer && !foregroundLayerIsPlaceable) {
        hideSceneTarget(foregroundLayer);
      }
    }

    const hiddenFrames = [];
    const hiddenControlIcons = [];
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      try {
        const placeable = doc?.object;
        if (placeable?.frame) {
          hiddenFrames.push({ frame: placeable.frame, visible: placeable.frame.visible });
          placeable.frame.visible = false;
        }
        if (placeable?.controlIcon) {
          hiddenControlIcons.push({ icon: placeable.controlIcon, visible: placeable.controlIcon.visible });
          placeable.controlIcon.visible = false;
        }
      } catch (_) {}
    }

    const grid = canvas?.grid;
    const gridVisibilityState = this._captureVisibleProperty(grid);
    const interfaceGrid = canvas?.interface?.grid || null;
    const interfaceGridVisibilityState = this._captureVisibleProperty(interfaceGrid);
    const interfaceHighlightStates = [];

    const effects = canvas?.effects;
    const effectsVisibilityState = this._captureVisibleProperty(effects);
    const lightVisibilityStates = [];
    if (effects) effects.visible = Array.isArray(options?.lightIds) && options.lightIds.length > 0;
    if (effects?.visible) {
      const lightIds = new Set(options.lightIds);
      for (const source of [...effects.allSources(), ...effects.visionSources]) {
        const doc = source.object?.document;
        if (doc?.documentName === 'AmbientLight' && lightIds.has(doc.id)) continue;
        // Preserve Scene ambient illumination, excluding unrelated placed lights
        // and token vision from the portable composition's picture.
        if (doc?.documentName === 'Level') continue;
        for (const layer of Object.values(source.layers || {})) {
          if (!layer.mesh) continue;
          lightVisibilityStates.push(this._captureVisibleProperty(layer.mesh));
          layer.mesh.visible = false;
        }
      }
    }

    // Use interface.grid.highlightLayers (non-deprecated API)
    if (interfaceGrid?.highlightLayers && typeof interfaceGrid.highlightLayers.values === 'function') {
      for (const layer of interfaceGrid.highlightLayers.values()) {
        if (!layer) continue;
        interfaceHighlightStates.push({ layer, visible: !!layer.visible });
        layer.visible = false;
      }
    }

    if (grid) grid.visible = false;
    if (interfaceGrid) interfaceGrid.visible = false;
    const interfaceGroup = canvas?.interface || null;
    const interfaceVisibilityState = this._captureVisibleProperty(interfaceGroup);
    if (interfaceGroup) interfaceGroup.visible = false;

    const shadowState = this._suspendShadowsForFlatten(selectedIds);

    return {
      selectedIds,
      placeables,
      hiddenTiles,
      hiddenBackgroundTiles,
      hiddenSceneImages,
      hiddenPrimary,
      forcedDoorVisualProxies,
      hiddenFrames,
      hiddenControlIcons,
      gridVisibilityState,
      interfaceGridVisibilityState,
      interfaceHighlightStates,
      interfaceVisibilityState,
      effectsVisibilityState,
      lightVisibilityStates,
      doorMeshState,
      ...shadowState
    };
  }

  _captureVisibleProperty(target) {
    if (!target) return null;
    let hadOwn = false;
    try {
      hadOwn = Object.prototype.hasOwnProperty.call(target, 'visible');
    } catch (_) {}
    return {
      target,
      hadOwn,
      value: target.visible
    };
  }

  _restoreVisibleProperty(record) {
    const target = record?.target;
    if (!target) return;
    try {
      if (record.hadOwn) {
        target.visible = record.value;
        return;
      }
      try { delete target.visible; } catch (_) {}
      if (target.visible !== record.value && record.value !== undefined) {
        target.visible = record.value;
      }
    } catch (_) {}
  }

  _shouldRetainPrimaryChild(child, options = {}) {
    try {
      const keepTiles = options?.keepTiles !== false;
      const keepBackground = !!options?.keepBackground;
      const keepForeground = !!options?.keepForeground;
      if (child === canvas.tiles) return keepTiles;
      if (child === canvas.background) return keepBackground;
      if (child === canvas.foreground) return keepForeground;
      if (child === canvas?.primary?.background) return keepBackground;
      if (child === canvas?.primary?.foreground) return keepForeground;
      const keepDoors = !!options?.keepDoors;
      const ctorName = typeof child?.constructor?.name === 'string' ? child.constructor.name : '';
      const name = typeof child?.name === 'string' ? child.name : '';
      if (child?.faNexusDoorVisualProxy || name.startsWith('fa-nexus-door-visual-proxy:')) {
        return keepDoors && this._isDoorVisualProxyIncluded(child, options?.doorVisibility);
      }
      if (name.startsWith('fa-nexus-door-shadow')) return keepDoors;
      if (keepDoors && ctorName === 'DoorMesh') return true;
      if (keepDoors && name.startsWith('Door.')) return true;
      if (name === 'background') return keepBackground;
      if (name === 'foreground') return keepForeground;
      if (!name) return false;
      if (!name.startsWith('fa-nexus-')) return false;
      if (name.endsWith('-preview') || name.endsWith('-ghost')) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  _suspendShadowsForFlatten(selectedIds) {
    const manager = AssetShadowManager?.peek?.();
    if (!manager) {
      return { shadowManager: null, suspendedShadows: [], shadowLayerKeys: [], hiddenShadowContainers: [] };
    }

    const suspendedShadows = [];
    const shadowLayerKeys = new Set();
    const hiddenShadowContainers = [];

    manager.suspendRebuilds();
    try {
      for (const [layerKey, layer] of manager._layers || []) {
        const layerDocs = Array.from(layer?.tiles?.values?.() || []);
        const hasSelectedTile = layerDocs.some((doc) => selectedIds.has(doc?.id));
        if (!hasSelectedTile) {
          const container = layer?.container;
          if (container && container.visible !== false) {
            hiddenShadowContainers.push({ container, visible: container.visible });
            container.visible = false;
          }
          continue;
        }
        for (const doc of layerDocs) {
          if (!doc || selectedIds.has(doc.id)) continue;
          try {
            if (manager.suspendTile(doc)) {
              suspendedShadows.push(doc);
              shadowLayerKeys.add(layerKey);
            }
          } catch (error) {
            this.logger.debug?.('TileFlatten.suspendShadow.failed', { error: String(error?.message || error) });
          }
        }
      }
    } finally {
      manager.resumeRebuilds({ immediate: true });
    }

    return {
      shadowManager: manager,
      suspendedShadows,
      shadowLayerKeys: Array.from(shadowLayerKeys),
      hiddenShadowContainers
    };
  }

  async _waitForShadowLayers(manager, layerKeys) {
    if (!manager || !Array.isArray(layerKeys) || layerKeys.length === 0) return;
    if (typeof manager.waitForRebuilds !== 'function') {
      throw new Error('Asset shadow manager does not expose rebuild readiness.');
    }
    await manager.waitForRebuilds(layerKeys);
  }

  _suspendCanvasRender(shouldSuspend) {
    if (!shouldSuspend) return null;
    try {
      const app = canvas?.app;
      const ticker = app?.ticker;
      const wasRunning = !!ticker?.started;
      if (!wasRunning) return null;
      if (typeof app?.stop === 'function') {
        app.stop();
      } else if (typeof ticker?.stop === 'function') {
        ticker.stop();
      }
      return () => {
        try {
          if (typeof app?.start === 'function') {
            app.start();
          } else if (typeof ticker?.start === 'function') {
            ticker.start();
          }
        } catch (_) {}
      };
    } catch (_) {
      return null;
    }
  }

  _usePrimaryChildRendering(primary) {
    try {
      if (!primary) return null;
      const sprite = primary.sprite ?? null;
      const previousState = {
        displayed: !!primary.displayed,
        spriteVisible: sprite ? !!sprite.visible : null,
        spriteRenderable: sprite && typeof sprite.renderable === 'boolean' ? sprite.renderable : null,
        clearColor: Array.isArray(primary.clearColor) ? primary.clearColor.slice() : null
      };

      primary.displayed = true;
      if (sprite) {
        sprite.visible = false;
        if (typeof sprite.renderable === 'boolean') sprite.renderable = false;
      }
      if (primary.clearColor) {
        try { primary.clearColor = [0, 0, 0, 0]; } catch (_) {}
      }
      try {
        primary.renderDirty = true;
      } catch (_) {}

      return () => {
        try { primary.displayed = previousState.displayed; } catch (_) {}
        if (sprite) {
          try { sprite.visible = previousState.spriteVisible; } catch (_) {}
          if (previousState.spriteRenderable !== null) {
            try { sprite.renderable = previousState.spriteRenderable; } catch (_) {}
          }
        }
        if (previousState.clearColor) {
          try { primary.clearColor = previousState.clearColor; } catch (_) {}
        }
        try { primary.renderDirty = true; } catch (_) {}
      };
    } catch (error) {
      this.logger.debug?.('TileFlatten.capture.primaryDisplayPatchFailed', { error: String(error?.message || error) });
      return null;
    }
  }

  _forcePrimaryTransparentClear(primary) {
    try {
      if (!primary || typeof primary._render !== 'function') return null;
      const originalRender = primary._render;
      primary._render = function patchedPrimaryRender(localRenderer) {
        const activeRenderer = localRenderer || canvas?.app?.renderer;
        const framebuffer = activeRenderer?.framebuffer;
        let restoreClear = null;
        if (framebuffer && typeof framebuffer.clear === 'function') {
          const originalClear = framebuffer.clear;
          framebuffer.clear = function patchedClear(r, g, b, a, mask) {
            return originalClear.call(this, 0, 0, 0, 0, mask);
          };
          restoreClear = () => {
            framebuffer.clear = originalClear;
          };
        }
        try {
          return originalRender.call(this, activeRenderer);
        } finally {
          if (restoreClear) {
            try { restoreClear(); } catch (_) {}
          }
        }
      };
      try { primary.renderDirty = true; } catch (_) {}
      return () => {
        primary._render = originalRender;
        try { primary.renderDirty = true; } catch (_) {}
      };
    } catch (error) {
      this.logger.debug?.('TileFlatten.capture.primaryClearPatchFailed', { error: String(error?.message || error) });
      return null;
    }
  }

  async _restoreVisibility(state) {
    if (!state) return;
    try {
      for (const placeable of state.hiddenTiles || []) {
        if (placeable) placeable.visible = true;
      }
    } catch (_) {}

    try {
      if (state.shadowManager && state.suspendedShadows?.length) {
        state.shadowManager.suspendRebuilds();
        try {
          for (const doc of state.suspendedShadows) {
            try {
              state.shadowManager.resumeTile(doc);
            } catch (error) {
              this.logger.debug?.('TileFlatten.resumeShadow.failed', { error: String(error?.message || error) });
            }
          }
        } finally {
          state.shadowManager.resumeRebuilds({ immediate: true });
        }
        await this._waitForShadowLayers(state.shadowManager, state.shadowLayerKeys);
      }
    } catch (_) {}

    try {
      for (const entry of state.hiddenShadowContainers || []) {
        if (entry?.container) entry.container.visible = entry.visible;
      }
    } catch (_) {}

    try {
      for (const entry of state.hiddenPrimary || []) {
        if (entry?.child) entry.child.visible = !!entry.visible;
      }
    } catch (_) {}

    try {
      for (const entry of state.forcedDoorVisualProxies || []) {
        if (!entry?.child) continue;
        entry.child.visible = entry.visible;
        if (typeof entry.renderable === 'boolean') entry.child.renderable = entry.renderable;
      }
    } catch (error) {
      this.logger.warn?.('TileFlatten.doorVisualProxyVisibility.restoreFailed', {
        error: String(error?.message || error)
      });
    }

    try {
      this._restoreDoorMeshesForExport(state.doorMeshState);
    } catch (_) {}

    try {
      for (const entry of state.hiddenSceneImages || []) {
        if (entry?.target && typeof entry.target.visible === 'boolean') {
          entry.target.visible = !!entry.visible;
        }
      }
    } catch (_) {}

    try {
      for (const placeable of state.hiddenBackgroundTiles || []) {
        if (placeable) placeable.visible = true;
      }
    } catch (_) {}

    try {
      for (const entry of state.hiddenFrames || []) {
        if (entry?.frame) entry.frame.visible = !!entry.visible;
      }
    } catch (_) {}

    try {
      for (const entry of state.hiddenControlIcons || []) {
        if (entry?.icon) entry.icon.visible = !!entry.visible;
      }
    } catch (_) {}

    try {
      this._restoreVisibleProperty(state.gridVisibilityState);
      const interfaceGrid = canvas?.interface?.grid;
      this._restoreVisibleProperty(state.interfaceGridVisibilityState);
      if (Array.isArray(state.interfaceHighlightStates) && interfaceGrid?.highlightLayers) {
        for (const entry of state.interfaceHighlightStates) {
          const layer = entry?.layer;
          if (!layer) continue;
          try { layer.visible = !!entry.visible; } catch (_) {}
        }
      }
      this._restoreVisibleProperty(state.effectsVisibilityState);
      for (const record of state.lightVisibilityStates || []) this._restoreVisibleProperty(record);
      this._restoreVisibleProperty(state.interfaceVisibilityState);
    } catch (_) {}
  }

  _syncShadowBlurForCapture(manager) {
    try {
      const mgr = manager || AssetShadowManager?.peek?.();
      if (!mgr || typeof mgr._onCanvasPan !== 'function') return null;
      mgr._onCanvasPan(); // apply blur for current stage scale
      return () => {
        try { mgr._onCanvasPan(); } catch (_) {}
      };
    } catch (_) {
      return null;
    }
  }
}
