import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { PlacementOverlay, createPlacementSpinner } from '../core/placement/placement-overlay.js';
import { loadTexture } from '../textures/texture-runtime-core.js';

export function resolveRandomAssetSwitchOutcome({
  requestGeneration,
  currentGeneration,
  isPlacementActive,
  currentAsset,
  previousAsset,
  nextAsset,
  textureStatus = 'pending'
} = {}) {
  const ownsRequest = requestGeneration === currentGeneration;
  if (!ownsRequest) {
    return {
      status: 'superseded', ownsRequest: false, publishAsset: null, notifyError: false, clearQueuedPlacement: false
    };
  }
  if (!isPlacementActive || currentAsset !== previousAsset) {
    return { status: 'stale', ownsRequest: true, publishAsset: null, notifyError: false, clearQueuedPlacement: false };
  }
  if (textureStatus === 'failed') {
    return { status: 'failed', ownsRequest: true, publishAsset: null, notifyError: true, clearQueuedPlacement: true };
  }
  if (textureStatus === 'loaded') {
    return { status: 'ready', ownsRequest: true, publishAsset: nextAsset, notifyError: false, clearQueuedPlacement: false };
  }
  return { status: 'pending', ownsRequest: true, publishAsset: null, notifyError: false, clearQueuedPlacement: false };
}

export class AssetPlacementPreviewRuntime {
  constructor(manager) {
    if (!manager) throw new Error('AssetPlacementPreviewRuntime requires manager.');
    this.manager = manager;
    this._previewRequestGeneration = 0;
  }

  invalidatePendingLoads() {
    this._previewRequestGeneration += 1;
  }

  showLoadingOverlay(dimensions = { worldWidth: 200, worldHeight: 200 }) {
    const manager = this.manager;
    try {
      const pointer = (() => {
        if (manager._previewFrozen && manager._frozenPointerScreen) {
          return { x: manager._frozenPointerScreen.x, y: manager._frozenPointerScreen.y };
        }
        const anchoredWorld = manager._getPreviewAnchorWorld(null, { includeToolOptions: true });
        const anchoredScreen = anchoredWorld ? manager._canvasToScreen(anchoredWorld.x, anchoredWorld.y) : null;
        if (anchoredScreen) return anchoredScreen;
        return manager._lastPointer ? { x: manager._lastPointer.x, y: manager._lastPointer.y } : null;
      })();
      const worldWidth = Math.max(0.01, Number(dimensions.worldWidth || 200));
      const worldHeight = Math.max(0.01, Number(dimensions.worldHeight || 200));
      this.hideLoadingOverlay();
      let spinner = null;
      const overlay = new PlacementOverlay({
        className: 'fa-nexus-placement-loading',
        pointer,
        worldWidth,
        worldHeight,
        onSizeChange: (screenWidth, screenHeight) => {
          if (spinner) {
            spinner.style.width = `${screenWidth}px`;
            spinner.style.height = `${screenHeight}px`;
          }
        }
      });
      spinner = createPlacementSpinner();
      spinner.style.width = '100%';
      spinner.style.height = '100%';
      overlay.content.appendChild(spinner);
      manager._loadingOverlay = { overlay, spinner, worldWidth, worldHeight };
    } catch (_) {}
  }

  hideLoadingOverlay() {
    const manager = this.manager;
    try { manager._loadingOverlay?.overlay?.destroy?.(); }
    catch (_) {}
    manager._loadingOverlay = null;
  }

  updateLoadingOverlaySize(worldWidth, worldHeight) {
    const manager = this.manager;
    try {
      if (!manager._loadingOverlay?.overlay) return;
      const current = manager._loadingOverlay;
      const ww = Number.isFinite(worldWidth) ? worldWidth : current.worldWidth;
      const wh = Number.isFinite(worldHeight) ? worldHeight : current.worldHeight;
      current.worldWidth = ww;
      current.worldHeight = wh;
      current.overlay.setWorldSize(ww, wh, { trackZoom: true });
    } catch (_) {}
  }

  updateLoadingOverlayPointer(screenX, screenY) {
    const manager = this.manager;
    try {
      if (!manager._loadingOverlay?.overlay) return;
      manager._loadingOverlay.overlay.updatePointer(screenX, screenY);
    } catch (_) {}
  }

  async loadCurrentAssetTexture(asset) {
    const manager = this.manager;
    const src = manager._encodeAssetPath(asset?.url);
    if (!src) return;
    const isVideo = /\.(webm|mp4)$/i.test(asset?.path || asset?.url || '');
    const texture = await loadTexture(src, isVideo ? {
      assetAlias: `fa-nexus-preview-video:${src}`,
      resourceOptions: {
        autoPlay: true,
        loop: true,
        muted: true,
        playsinline: true
      }
    } : {});
    if (!isVideo) return;
    const video = texture?.baseTexture?.resource?.source;
    if (!video || String(video.tagName || '').toUpperCase() !== 'VIDEO') {
      throw new Error(`Video texture did not expose a playable source: ${src}`);
    }
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    await video.play();
  }

  async prepareCurrentAssetPreview(options = {}) {
    const manager = this.manager;
    const asset = manager.currentAsset;
    if (!asset) return;
    const generation = ++this._previewRequestGeneration;
    const isCurrentRequest = () => generation === this._previewRequestGeneration
      && manager.isPlacementActive
      && manager.currentAsset === asset;
    const { worldWidth, worldHeight } = manager._computeWorldSizeForAsset(asset, manager._getPendingScale());
    const needsDownload = manager._assetRequiresDownload(asset);
    manager.isDownloading = true;
    this.showLoadingOverlay({ worldWidth, worldHeight });
    if (needsDownload) {
      manager._removePreviewElement();
      try {
        await manager._ensureAssetLocal(asset);
      } catch (error) {
        if (!isCurrentRequest()) return;
        Logger.warn('Placement.prepare.download.failed', String(error?.message || error));
        // A tier refusal was already explained by the content service.
        if (!error?.faNexusNotified) ui.notifications?.error?.(`Failed to download asset: ${error?.userMessage || error?.message || error}`);
        manager.isDownloading = false;
        this.hideLoadingOverlay();
        manager.cancelPlacement('error');
        return;
      }
    }

    if (!isCurrentRequest()) return;

    try {
      await this.loadCurrentAssetTexture(asset);
    } catch (error) {
      if (!isCurrentRequest()) return;
      Logger.error('Placement.prepare.texture.failed', {
        src: asset?.url || null,
        error: String(error?.message || error)
      });
      ui.notifications?.error?.(`Failed to load asset texture: ${error?.message || error}`);
      manager.isDownloading = false;
      this.hideLoadingOverlay();
      manager.cancelPlacement('error');
      return;
    }
    if (!isCurrentRequest()) return;

    manager._removePreviewElement();
    this.hideLoadingOverlay();
    manager.isDownloading = false;
    manager._createPreviewElement();
    await this.flushQueuedPlacement();
  }

  async flushQueuedPlacement() {
    const manager = this.manager;
    if (!manager.queuedPlacement) return;
    const qp = manager.queuedPlacement;
    manager.queuedPlacement = null;
    try {
      await manager._placeAtScreenCoordinates(qp.x, qp.y);
    } catch (error) {
      Logger.warn('Placement.queued.failed', String(error?.message || error));
    }
  }

  applyZoomToPreview(zoomLevel) {
    const manager = this.manager;
    try {
      const sm = Number(manager._previewContainer?._scaleMul || manager.currentScale || 1) || 1;
      let worldWidth = null;
      let worldHeight = null;
      if (manager._previewContainer) {
        const tw = Number(manager._previewContainer._tileWidth || 0);
        const th = Number(manager._previewContainer._tileHeight || 0);
        const gsf = Number(manager._previewContainer._gridScaleFactor || 1);
        if (tw && th) {
          worldWidth = tw * gsf * sm;
          worldHeight = th * gsf * sm;
          if (manager._previewContainer._sprite) {
            manager._previewContainer._sprite.width = worldWidth;
            manager._previewContainer._sprite.height = worldHeight;
          }
        }
      }
      if ((!worldWidth || !worldHeight) && manager.currentAsset) {
        const dims = manager._computeWorldSizeForAsset(manager.currentAsset, sm);
        worldWidth = dims.worldWidth;
        worldHeight = dims.worldHeight;
      }
      if (!worldWidth || !worldHeight) return;
      manager._applyPendingFlipToPreview({ syncShadow: false });
      this.updateLoadingOverlaySize(worldWidth, worldHeight);
      manager._updatePreviewShadow();
      manager._scheduleShadowOffsetPreviewUpdate();
    } catch (_) {}
  }

  startZoomWatcher() {
    const manager = this.manager;
    try {
      this.stopZoomWatcher();
      const loop = () => {
        if (!manager.isPlacementActive) { manager._zoomWatcherId = null; return; }
        const z = canvas?.stage?.scale?.x || 1;
        if (z !== manager._lastZoom) {
          manager._lastZoom = z;
          this.applyZoomToPreview(z);
        }
        if (manager._previewFrozen) manager._refreshFrozenPointerScreen();
        manager._zoomWatcherId = window.requestAnimationFrame(loop);
      };
      manager._lastZoom = canvas?.stage?.scale?.x || 1;
      if (manager._previewFrozen) manager._refreshFrozenPointerScreen();
      manager._zoomWatcherId = window.requestAnimationFrame(loop);
    } catch (_) {}
  }

  stopZoomWatcher() {
    const manager = this.manager;
    try {
      if (manager._zoomWatcherId) {
        window.cancelAnimationFrame(manager._zoomWatcherId);
        manager._zoomWatcherId = null;
      }
    } catch (_) {}
  }

  async switchToNextRandomAsset(initial = false) {
    const manager = this.manager;
    const next = manager._pickRandomAsset();
    if (!next) return;
    const previousAsset = manager.currentAsset;
    const generation = ++this._previewRequestGeneration;
    const outcome = (textureStatus = 'pending') => resolveRandomAssetSwitchOutcome({
      requestGeneration: generation,
      currentGeneration: this._previewRequestGeneration,
      isPlacementActive: manager.isPlacementActive,
      currentAsset: manager.currentAsset,
      previousAsset,
      nextAsset: next,
      textureStatus
    });
    const isCurrentRequest = () => outcome().status === 'pending';
    if (String(next.source || '').toLowerCase() === 'cloud' && !next.cachedLocalPath) {
      manager.isDownloading = true;
      const dims = manager._computeWorldSizeForAsset(next, manager._getPendingScale());
      this.showLoadingOverlay(dims);
      try {
        await manager._ensureAssetLocal(next);
      } catch (e) {
        const failure = outcome('failed');
        if (failure.status !== 'failed') return;
        Logger.error('Placement.lazyPrime.failed', {
          filename: next?.filename || null,
          path: next?.path || next?.file_path || null,
          error: String(e?.message || e)
        });
        ui.notifications?.error?.(`Failed to prepare the next random asset: ${e?.message || e}`);
        if (failure.clearQueuedPlacement) manager.queuedPlacement = null;
        manager.isDownloading = false;
        this.hideLoadingOverlay();
        if (initial) manager.cancelPlacement('error');
        return;
      }
      if (!isCurrentRequest()) return;
    }
    try {
      await this.loadCurrentAssetTexture(next);
    } catch (error) {
      const failure = outcome('failed');
      if (failure.status !== 'failed') return;
      Logger.error('Placement.lazyPrime.texture.failed', {
        src: next?.url || null,
        error: String(error?.message || error)
      });
      ui.notifications?.error?.(`Failed to load the next random asset texture: ${error?.message || error}`);
      if (failure.clearQueuedPlacement) manager.queuedPlacement = null;
      manager.isDownloading = false;
      this.hideLoadingOverlay();
      if (initial) manager.cancelPlacement('error');
      return;
    }
    const ready = outcome('loaded');
    if (ready.status !== 'ready') return;
    const lastWorld = manager._getPreviewAnchorWorld(null, { includeToolOptions: true });
    const lastScreen = (() => {
      if (manager._previewFrozen && manager._frozenPointerScreen && Number.isFinite(manager._frozenPointerScreen.x) && Number.isFinite(manager._frozenPointerScreen.y)) {
        return { x: manager._frozenPointerScreen.x, y: manager._frozenPointerScreen.y };
      }
      return manager._lastPointer || null;
    })();
    manager.currentAsset = ready.publishAsset;
    manager._removePreviewElement();
    this.hideLoadingOverlay();
    manager._createPreviewElement();
    manager._applyPendingRotationToPreview();
    manager._applyPendingScaleToPreview();
    manager._applyPendingFlipToPreview({ forceShadow: true });
    try {
      let world = null;
      if (lastWorld) {
        world = lastWorld;
      } else if (lastScreen) {
        world = manager._screenToCanvas(lastScreen.x, lastScreen.y);
      }
      if (world && manager._previewContainer) {
        manager._applyPreviewAnchor(world);
      }
    } catch (_) {}
    manager.isDownloading = false;
    try { manager._randomPrefetch?.prime?.(manager.currentAsset); } catch (_) {}
    await this.flushQueuedPlacement();
  }
}
