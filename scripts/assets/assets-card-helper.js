import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import { premiumEntitlementsService } from '../premium/premium-entitlements-service.js';
import { PlacementOverlay, createPlacementSpinner } from '../core/placement/placement-overlay.js';

export class AssetsTabCardHelper {
  constructor(tab) {
    this.tab = tab;
    this._textureRequestId = 0;
    this._pathRequestId = 0;
  }

  _isVideoFilename(value) {
    if (!value) return false;
    return /\.(webm|mp4|m4v|mov|ogg)$/i.test(String(value));
  }

  _createThumbVideoElement() {
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.autoplay = false;
    video.loop = false;
    video.controls = false;
    video.preload = 'metadata';
    video.style.maxWidth = '100%';
    video.style.maxHeight = '100%';
    video.style.objectFit = 'contain';
    video.style.transition = 'opacity 0.25s ease';
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.setAttribute('preload', 'metadata');
    return video;
  }

  _getAuthState() {
    try {
      const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
      if (auth && auth.authenticated && auth.state) return auth.state;
    } catch (_) {}
    return '';
  }

  async _ensureVideoSourceForCard(cardElement, videoEl, item, { filePathAttr, cachedLocalPath, isCloud, tier, contentSvc }) {
    if (!videoEl || !cardElement) return '';
    const resolvedAttr = videoEl.getAttribute('data-resolved-src');
    if (resolvedAttr) return resolvedAttr;

    let src = '';
    if (cachedLocalPath) src = cachedLocalPath;
    if (!src) {
      const direct = cardElement.getAttribute('data-url') || '';
      if (/^https?:\/\//i.test(direct)) src = direct;
    }
    if (!src && !isCloud) {
      src = filePathAttr || '';
    }

    const normalizedTier = String(tier || '').toLowerCase();
    const isPremium = normalizedTier === 'premium';
    if (!src && isCloud && contentSvc && typeof contentSvc.getFullURL === 'function') {
      const state = isPremium ? this._getAuthState() : undefined;
      if (isPremium && !state) {
        return '';
      }
      try {
        const full = await contentSvc.getFullURL('assets', {
          file_path: filePathAttr || item?.file_path || '',
          filename: item?.filename || cardElement.getAttribute('data-filename') || '',
          tier: item?.tier || (normalizedTier || 'free')
        }, state);
        if (full) src = full;
      } catch (error) {
        Logger.warn('AssetsTab.video.source.failed', { error: String(error?.message || error) });
        return '';
      }
    }

    if (!src) return '';

    videoEl.setAttribute('data-resolved-src', src);
    requestAnimationFrame(() => {
      try {
        if (videoEl.src !== src) {
          videoEl.src = src;
          videoEl.load();
        }
      } catch (_) {}
    });
    if (cardElement.getAttribute('data-url') !== src) {
      try { cardElement.setAttribute('data-url', src); }
      catch (_) {}
    }
    return src;
  }

  async _requirePremiumFeature(featureId, { label }) {
    ensurePremiumFeaturesRegistered();
    try {
      await premiumFeatureBroker.require(featureId, { reason: `assets-card:require:${featureId}` });
      return true;
    } catch (error) {
      const code = error?.code || error?.name;
      Logger.warn('AssetsTab.premium.require.failed', {
        featureId,
        code,
        message: String(error?.message || error)
      });
      if (this._isAuthFailure(error)) {
        await this._handlePremiumAuthFailure(error, {
          featureId,
          label,
          source: 'assets-card:require'
        });
      }
      if (code === 'ENTITLEMENT_REQUIRED') {
        ui.notifications?.warn?.(`${label} is a premium feature. Please connect Patreon to unlock it.`);
      } else if (code === 'STATE_MISSING') {
        ui.notifications?.error?.(`Authentication required for ${label}. Please connect Patreon.`);
      } else if (code === 'MODULE_UPDATE_REQUIRED') {
        ui.notifications?.error?.(`Update FA Nexus to the latest version to use ${label}.`);
      } else if (code === 'MODULE_TOO_NEW') {
        ui.notifications?.error?.(`${label} is not yet compatible with this FA Nexus build. Check for a premium bundle update.`);
      } else {
        ui.notifications?.error?.(`Unable to start ${label}: ${error?.message || error}`);
      }
      return false;
    }
  }

  updateCardGridBadge(cardElement, item = null) {
    try {
      if (!cardElement) return;
      const badge = cardElement.querySelector('.fa-nexus-grid-size-tag');
      if (!badge) return;
      const parseDimension = (value) => {
        if (value === undefined || value === null) return null;
        if (typeof value === 'string' && value.trim() === '') return null;
        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0) return null;
        return Math.round(num * 100) / 100;
      };
      const formatDimension = (value) => {
        const normalized = Math.round(value * 100) / 100;
        return normalized.toFixed(2).replace(/\.?0+$/, '');
      };
      let gridW = parseDimension(cardElement.getAttribute('data-grid-w'));
      let gridH = parseDimension(cardElement.getAttribute('data-grid-h'));
      if (gridW == null && item) gridW = parseDimension(item.grid_width);
      if (gridH == null && item) gridH = parseDimension(item.grid_height);

      let pending = false;
      if (item) {
        try {
          pending = this.needsActualDimensions(item) && !item._dimsResolved;
        } catch (_) {
          pending = false;
        }
      } else {
        pending = cardElement.getAttribute('data-grid-pending') === 'true';
      }

      if (pending) {
        try { cardElement.setAttribute('data-grid-pending', 'true'); } catch (_) {}
      } else {
        try { cardElement.removeAttribute('data-grid-pending'); } catch (_) {}
      }

      if (!pending && gridW != null && gridH != null) {
        badge.textContent = `${formatDimension(gridW)}x${formatDimension(gridH)}`;
        badge.style.display = 'inline-flex';
        try { badge.removeAttribute('data-pending'); } catch (_) {}
      } else {
        badge.textContent = '--';
        badge.style.display = 'inline-flex';
        if (pending) {
          try { badge.setAttribute('data-pending', 'true'); } catch (_) {}
        } else {
          try { badge.removeAttribute('data-pending'); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  needsActualDimensions(item) {
    if (!item) return false;
    const filename = String(item.filename || '').toLowerCase();
    const hasPattern = /(?:^|[_\-\s])\d+x\d+$/.test(filename.replace(/\.[^/.]+$/, ''));
    if (hasPattern) return false;
    const tab = this.tab;
    const looksPath = filename.includes('path');
    const inTextures = tab._isTextureItem(item);
    const inPaths = tab._isPathsItem(item);
    if (!looksPath && !inTextures && !inPaths) return false;
    return true;
  }

  hasLocalAssetFile(item) {
    if (!item) return false;
    if (item.cachedLocalPath) return true;
    const source = String(item.source || '').toLowerCase();
    if (source === 'local') return true;
    return false;
  }

  async ensureAccurateDimensions(item, cardElement) {
    const tab = this.tab;
    try {
      if (item?._dimsResolved) {
        if (cardElement && cardElement.isConnected) {
          try { cardElement.setAttribute('data-width', String(item.width ?? '')); } catch (_) {}
          try { cardElement.setAttribute('data-height', String(item.height ?? '')); } catch (_) {}
          try { cardElement.setAttribute('data-grid-w', String(item.grid_width ?? '')); } catch (_) {}
          try { cardElement.setAttribute('data-grid-h', String(item.grid_height ?? '')); } catch (_) {}
          this.updateCardGridBadge(cardElement, item);
        }
        return true;
      }
      if (!this.needsActualDimensions(item)) return false;
      if (!this.hasLocalAssetFile(item)) return false;
      const assets = tab.assetsService;
      if (!assets || typeof assets.getActualDimensions !== 'function') return false;
      const dims = await assets.getActualDimensions(item);
      if (!dims || !dims.width || !dims.height) return false;
      const base = 200;
      const widthPx = Math.max(1, Math.round(dims.width));
      const heightPx = Math.max(1, Math.round(dims.height));
      const gridWidth = Math.max(0.01, Math.round((widthPx / base) * 100) / 100);
      const gridHeight = Math.max(0.01, Math.round((heightPx / base) * 100) / 100);
      item.width = widthPx;
      item.height = heightPx;
      item.actual_width = widthPx;
      item.actual_height = heightPx;
      item.grid_width = gridWidth;
      item.grid_height = gridHeight;
      item._dimsResolved = true;
      if (cardElement && cardElement.isConnected) {
        try { cardElement.setAttribute('data-width', String(widthPx)); } catch (_) {}
        try { cardElement.setAttribute('data-height', String(heightPx)); } catch (_) {}
        try { cardElement.setAttribute('data-grid-w', String(gridWidth)); } catch (_) {}
        try { cardElement.setAttribute('data-grid-h', String(gridHeight)); } catch (_) {}
        try { cardElement.removeAttribute('data-grid-pending'); } catch (_) {}
        this.updateCardGridBadge(cardElement, item);
      }
      return true;
    } catch (e) {
      Logger.warn('AssetsTab.dimensions.error', { error: String(e?.message || e) });
      return false;
    }
  }
  createCard(item) {
    const tab = this.tab;
    const card = document.createElement('div');
    card.className = 'fa-nexus-card';
    const filePath = tab._resolveFilePath(item);
    const folderPath = tab._resolveFolderPath(item);
    const cachedPath = item.cachedLocalPath || '';
    try { card.setAttribute('data-key', tab._computeItemKey(item)); } catch (_) {}
    card.setAttribute('data-filename', item.filename || '');
    card.setAttribute('data-file-path', filePath);
    card.setAttribute('data-path', folderPath || '');
    const initialGridW = Number(item?.grid_width);
    const initialGridH = Number(item?.grid_height);
    if (Number.isFinite(initialGridW) && initialGridW > 0) card.setAttribute('data-grid-w', String(initialGridW));
    if (Number.isFinite(initialGridH) && initialGridH > 0) card.setAttribute('data-grid-h', String(initialGridH));
    if (item.width != null) card.setAttribute('data-width', String(item.width));
    if (item.height != null) card.setAttribute('data-height', String(item.height));
    if (item.file_size != null) card.setAttribute('data-file-size', String(item.file_size));
    const isCloud = (item && item.source === 'cloud');
    const dataSource = isCloud ? 'cloud' : (item?.source || 'local');
    card.setAttribute('data-source', dataSource);
    if (isCloud && item.tier) card.setAttribute('data-tier', String(item.tier));
    if (cachedPath) {
      card.setAttribute('data-cached', 'true');
      card.setAttribute('data-url', cachedPath);
    } else if (filePath) {
      card.setAttribute('data-url', filePath);
    }
    const isVideoAsset = this._isVideoFilename(item?.filename) || this._isVideoFilename(cachedPath) || this._isVideoFilename(filePath);
    const tier = String(item?.tier || '').toLowerCase();
    const canInlineCloudVideo = !isCloud || cachedPath || tier === 'free';
    const useVideo = isVideoAsset && canInlineCloudVideo;
    if (isVideoAsset) {
      try { card.setAttribute('data-media-type', 'video'); } catch (_) {}
    } else {
      try { card.setAttribute('data-media-type', 'image'); } catch (_) {}
    }
    const initialVideoSrc = useVideo && (!isCloud || cachedPath) ? (cachedPath || filePath || '') : '';
    const media = useVideo
      ? `<video src="${initialVideoSrc}" muted playsinline preload="metadata" style="max-width:100%;max-height:100%;object-fit:contain"></video>`
      : `<img alt="${item.filename || ''}" style="max-width:100%;max-height:100%;object-fit:contain"/>`;
    card.innerHTML = `
      <div class="thumb fa-nexus-thumb-placeholder">
        ${media}
        <div class="fa-nexus-status-icon" title=""></div>
        <div class="fa-nexus-grid-size-tag"></div>
      </div>
      `;
    return card;
  }

  async mountCard(cardElement, item) {
    const tab = this.tab;
    try {
      if (item && item.width != null) cardElement.setAttribute('data-width', String(item.width)); else cardElement.removeAttribute('data-width');
      if (item && item.height != null) cardElement.setAttribute('data-height', String(item.height)); else cardElement.removeAttribute('data-height');
      if (item && item.grid_width != null) cardElement.setAttribute('data-grid-w', String(item.grid_width)); else cardElement.removeAttribute('data-grid-w');
      if (item && item.grid_height != null) cardElement.setAttribute('data-grid-h', String(item.grid_height)); else cardElement.removeAttribute('data-grid-h');
      if (item && item.file_size != null) cardElement.setAttribute('data-file-size', String(item.file_size)); else cardElement.removeAttribute('data-file-size');
      const thumb = cardElement.querySelector('.thumb');
      let img = cardElement.querySelector('img');
      let video = cardElement.querySelector('video');
      const statusIcon = cardElement.querySelector('.fa-nexus-status-icon');
      const isCloud = (item && item.source === 'cloud') || (cardElement.getAttribute('data-source') === 'cloud');
      const tier = item?.tier || cardElement.getAttribute('data-tier') || '';
      const folderPathAttr = cardElement.getAttribute('data-path') || tab._resolveFolderPath(item);
      const filePathAttr = cardElement.getAttribute('data-file-path') || tab._resolveFilePath(item);
      if (filePathAttr && !cardElement.getAttribute('data-file-path')) cardElement.setAttribute('data-file-path', filePathAttr);
      if (folderPathAttr && cardElement.getAttribute('data-path') !== folderPathAttr) cardElement.setAttribute('data-path', folderPathAttr || '');
      let cachedLocalPath = item?.cachedLocalPath || '';
      try {
        if (!cachedLocalPath && isCloud) {
          const download = tab.downloadManager;
          if (download && typeof download.getLocalPath === 'function') {
            cachedLocalPath = download.getLocalPath('assets', item || {
              file_path: filePathAttr,
              filename: cardElement.getAttribute('data-filename') || '',
              tier
            }) || '';
          }
        }
      } catch (_) {}
      if (cachedLocalPath) {
        cardElement.setAttribute('data-url', cachedLocalPath);
        cardElement.setAttribute('data-cached', 'true');
      } else if (!cardElement.getAttribute('data-url') && filePathAttr) {
        cardElement.setAttribute('data-url', filePathAttr);
      }
      if (isCloud && !cachedLocalPath) tab._enqueueCacheProbe(cardElement, item);

      const contentSvc = tab.contentService;
      const mediaTypeAttr = cardElement.getAttribute('data-media-type') || (this._isVideoFilename(item?.filename) ? 'video' : 'image');
      if (!cardElement.getAttribute('data-media-type') && mediaTypeAttr) {
        try { cardElement.setAttribute('data-media-type', mediaTypeAttr); } catch (_) {}
      }
      const normalizedTier = String(tier || '').toLowerCase();
      const shouldInlineVideo = mediaTypeAttr === 'video' && (!isCloud || cachedLocalPath || normalizedTier === 'free');
      if (shouldInlineVideo && !video) {
        video = this._createThumbVideoElement();
        if (img && img.parentNode) {
          img.parentNode.replaceChild(video, img);
        } else if (thumb) {
          thumb.insertBefore(video, thumb.firstChild || null);
        }
        img = null;
      }

      if (video) {
        if (cachedLocalPath) {
          try { video.removeAttribute('data-resolved-src'); }
          catch (_) {}
        }
        try {
          video.addEventListener('loadeddata', () => {
            try { video.currentTime = 0; } catch (_) {}
            try { video.pause(); } catch (_) {}
            try { thumb?.classList.remove('fa-nexus-thumb-placeholder'); } catch (_) {}
          }, { once: true });
          video.addEventListener('error', () => {
            try { thumb?.classList.add('fa-nexus-thumb-placeholder'); } catch (_) {}
          }, { once: true });
        } catch (_) {}

        const resolved = await this._ensureVideoSourceForCard(cardElement, video, item, {
          filePathAttr,
          cachedLocalPath,
          isCloud,
          tier: normalizedTier,
          contentSvc
        });
        if (!resolved) {
          try { thumb?.classList.add('fa-nexus-thumb-placeholder'); } catch (_) {}
        } else if (video.readyState >= 2) {
          try { thumb?.classList.remove('fa-nexus-thumb-placeholder'); } catch (_) {}
        }
        try { cardElement.removeAttribute('data-enhanced-thumbnail'); } catch (_) {}
      } else if (img) {
        let src = '';
        if (isCloud) {
          try { src = contentSvc?.getThumbnailURL?.('assets', item) || ''; } catch (_) { src = ''; }
        } else if (item && item.thumbnail_url) {
          src = item.thumbnail_url;
          if (item.enhanced_thumbnail) {
            try { cardElement.setAttribute('data-enhanced-thumbnail', 'true'); } catch (_) {}
          } else {
            try { cardElement.removeAttribute('data-enhanced-thumbnail'); } catch (_) {}
          }
        } else {
          src = filePathAttr || cardElement.getAttribute('data-url') || cardElement.getAttribute('data-file-path') || '';
          try { cardElement.removeAttribute('data-enhanced-thumbnail'); } catch (_) {}
        }
        tab._queueImageLoad(cardElement, img, src, () => {
          try { thumb.classList.remove('fa-nexus-thumb-placeholder'); } catch(_){ }
        }, () => {
          try { thumb.classList.add('fa-nexus-thumb-placeholder'); } catch(_){ }
        });
      }

      const needsRefinement = this.needsActualDimensions(item) && !item?._dimsResolved;
      if (needsRefinement) {
        try { cardElement.setAttribute('data-grid-pending', 'true'); } catch (_) {}
      } else {
        try { cardElement.removeAttribute('data-grid-pending'); } catch (_) {}
      }
      this.updateCardGridBadge(cardElement, item);

      await this.ensureAccurateDimensions(item, cardElement);
      try { cardElement._assetItem = item; } catch (_) {}

      if (statusIcon) {
        statusIcon.classList.remove('local','cloud','premium','cached','cloud-plus');
        let icon = 'fa-cloud';
        let title = 'Cloud';
        const source = (cardElement.getAttribute('data-source') || item?.source || '').toLowerCase();
        const isLocal = source === 'local';
        const isPremium = tier === 'premium';
        let authed = false;
        try {
          const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
          authed = !!(auth && auth.authenticated && auth.state);
        } catch (_) {}
        cardElement.classList.remove('locked-token');
        if (isLocal) {
          statusIcon.classList.add('local');
          icon = 'fa-folder';
          title = 'Local storage';
        } else if (source === 'cloud') {
          if (cachedLocalPath) {
            statusIcon.classList.add('cloud', 'cached');
            icon = 'fa-cloud-check';
            title = 'Downloaded';
          } else if (isPremium && !authed) {
            statusIcon.classList.add('premium');
            icon = 'fa-lock';
            title = 'Premium (locked)';
            cardElement.classList.add('locked-token');
          } else {
            statusIcon.classList.add(isPremium ? 'cloud-plus' : 'cloud');
            icon = isPremium ? 'fa-cloud-plus' : 'fa-cloud';
            title = isPremium ? 'Premium (unlocked)' : 'Cloud';
          }
        } else {
          statusIcon.classList.add('local');
          icon = 'fa-folder';
          title = 'Local storage';
        }
        statusIcon.innerHTML = `<i class="fas ${icon}"></i>`;
        statusIcon.title = title;
      }

      const key = tab._keyFromCard(cardElement);
      const selected = key && tab._selection.selectedKeys.has(key);
      tab._setCardSelectionUI(cardElement, !!selected);
      cardElement.addEventListener('click', (ev) => this.handleAssetCardClick(ev, cardElement, item));
    } catch (e) {
      Logger.warn('AssetsTab.mount.error', { error: String(e?.message || e) });
    }
  }

  unmountCard(cardElement) {
    try {
      const img = cardElement.querySelector('img');
      if (img) {
        this.tab._cancelImageLoad(cardElement);
        img.onload = img.onerror = null;
        img.src = '';
      }
    } catch(_) {}
    try { const v = cardElement.querySelector('video'); if (v) { v.src = ''; } } catch(_) {}
    try { if (cardElement?._assetItem) delete cardElement._assetItem; } catch (_) {}
    try { if (cardElement?._probeJob) { cardElement._probeJob.cancelled = true; delete cardElement._probeJob; } } catch (_) {}
  }


  async handleTextureCardClick(cardElement, item, triggerEvent = null) {
    const tab = this.tab;
    if (!cardElement) return;
    if (!(await this._requirePremiumFeature('texture.paint', { label: 'Texture Painting' }))) return;
    try { await tab._controller.ensureServices(); }
    catch (error) { Logger.warn('AssetsTab.texture.paint.ensure.failed', { error: String(error?.message || error) }); }
    const texturePaint = tab.texturePaintManager;
    if (!texturePaint) {
      Logger.warn('AssetsTab.texture.paint.unavailable');
      return;
    }

    const filename = cardElement.getAttribute('data-filename') || item?.filename || '';
    const filePathAttr = cardElement.getAttribute('data-file-path') || tab._resolveFilePath(item);
    const folderPath = cardElement.getAttribute('data-path') || tab._resolveFolderPath(item);
    const isCloud = (cardElement.getAttribute('data-source') === 'cloud');
    const tier = cardElement.getAttribute('data-tier') || item?.tier || '';
    const download = tab.downloadManager;
    const content = tab.contentService;
    const requestId = (this._textureRequestId = (this._textureRequestId || 0) + 1);

    let localPath = '';
    let overlayHandle = null;
    const pointerCoords = this._extractPointerScreenCoords(triggerEvent);
    try {
      const wasActive = !!texturePaint?.isActive;
      try {
        if (!wasActive) {
          await Promise.resolve(texturePaint?.stop?.());
        }
      } catch (stopError) {
        Logger.warn('AssetsTab.texture.paint.stop.failed', { error: String(stopError?.message || stopError) });
      }
      const isCached = (cardElement.getAttribute('data-cached') === 'true');
      if (isCached) localPath = cardElement.getAttribute('data-url') || '';
      if (!localPath) {
        localPath = download?.getLocalPath?.('assets', { filename, file_path: filePathAttr, path: folderPath }) || '';
      }
      if (!localPath && isCloud && content && download) {
        overlayHandle = this._spawnCardDownloadOverlay(cardElement, { pointer: pointerCoords });
        const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
        const authed = !!(auth && auth.authenticated && auth.state);
        const downloadItem = { file_path: filePathAttr, filename, tier: tier || 'free' };
        const fullUrl = await content.getFullURL('assets', downloadItem, authed ? auth.state : undefined);
        localPath = await download.ensureLocal('assets', downloadItem, fullUrl);
        if (localPath) {
          try { cardElement.setAttribute('data-cached', 'true'); cardElement.setAttribute('data-url', localPath); } catch (_) {}
          try {
            const icon = cardElement.querySelector('.fa-nexus-status-icon');
            if (icon) {
              icon.classList.remove('cloud-plus', 'cloud', 'premium');
              icon.classList.add('cloud', 'cached');
              icon.title = 'Downloaded';
              icon.innerHTML = '<i class="fas fa-cloud-check"></i>';
            }
          } catch (_) {}
          if (item) item.cachedLocalPath = localPath;
        }
      }
    } catch (e) {
      Logger.warn('AssetsTab.texture.paint.download.failed', { error: String(e?.message || e) });
      if ((e && e.message === 'AUTH') || /auth/i.test(String(e?.message))) {
        ui.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
      } else {
        ui.notifications?.error?.(`Failed to prepare texture: ${e?.message || e}`);
      }
      return;
    } finally {
      try { overlayHandle?.destroy?.(); }
      catch (_) {}
    }

    if (requestId !== this._textureRequestId) {
      return;
    }

    if (!localPath) {
      ui.notifications?.warn?.('Texture not available locally yet. Please try again.');
      return;
    }

    const sanitizedName = filename ? filename.replace(/\.[^.]+$/, '') : 'masked-texture';
    try {
      await texturePaint?.start?.(localPath, `masked-${sanitizedName}.webp`, { pointer: pointerCoords, pointerEvent: triggerEvent });
    } catch (error) {
      Logger.warn('AssetsTab.texture.paint.start.failed', { error: String(error?.message || error) });
      if (this._isAuthFailure(error)) {
        await this._handlePremiumAuthFailure(error, {
          featureId: 'texture.paint',
          label: 'Texture Painting',
          source: 'assets-card:texture:start'
        });
      } else {
        ui.notifications?.error?.(`Failed to start Texture Painting: ${error?.message || error}`);
      }
    }
  }

  async handlePathCardClick(cardElement, item, triggerEvent = null) {
    const tab = this.tab;
    if (!cardElement) return;
    if (!(await this._requirePremiumFeature('path.edit', { label: 'Path Editing' }))) return;
    try { await tab._controller.ensureServices(); }
    catch (error) { Logger.warn('AssetsTab.paths.ensure.failed', { error: String(error?.message || error) }); }
    const pathManager = tab.pathManager;
    if (!pathManager) {
      Logger.warn('AssetsTab.paths.manager.unavailable');
      return;
    }

    const filename = cardElement.getAttribute('data-filename') || item?.filename || '';
    const filePathAttr = cardElement.getAttribute('data-file-path') || tab._resolveFilePath(item);
    const folderPath = cardElement.getAttribute('data-path') || tab._resolveFolderPath(item);
    const isCloud = (cardElement.getAttribute('data-source') === 'cloud');
    const tier = cardElement.getAttribute('data-tier') || item?.tier || '';
    const download = tab.downloadManager;
    const content = tab.contentService;
    const requestId = (this._pathRequestId = (this._pathRequestId || 0) + 1);

    let localPath = '';
    let overlayHandle = null;
    const pointerCoords = this._extractPointerScreenCoords(triggerEvent);
    const wasActive = !!pathManager?.isActive;
    try {
      if (!wasActive) {
        await Promise.resolve(pathManager?.stop?.());
      }
    } catch (stopError) {
      Logger.warn('AssetsTab.path.manager.stop.failed', { error: String(stopError?.message || stopError) });
    }
    try {
      const isCached = (cardElement.getAttribute('data-cached') === 'true');
      if (isCached) localPath = cardElement.getAttribute('data-url') || '';
      if (!localPath) {
        localPath = download?.getLocalPath?.('assets', { filename, file_path: filePathAttr, path: folderPath }) || '';
      }
      if (!localPath && isCloud && content && download) {
        overlayHandle = this._spawnCardDownloadOverlay(cardElement, { pointer: pointerCoords });
        const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
        const authed = !!(auth && auth.authenticated && auth.state);
        const downloadItem = { file_path: filePathAttr, filename, tier: tier || 'free' };
        const fullUrl = await content.getFullURL('assets', downloadItem, authed ? auth.state : undefined);
        localPath = await download.ensureLocal('assets', downloadItem, fullUrl);
        if (localPath) {
          try { cardElement.setAttribute('data-cached', 'true'); cardElement.setAttribute('data-url', localPath); } catch (_) {}
          try {
            const icon = cardElement.querySelector('.fa-nexus-status-icon');
            if (icon) {
              icon.classList.remove('cloud-plus', 'cloud', 'premium');
              icon.classList.add('cloud', 'cached');
              icon.title = 'Downloaded';
              icon.innerHTML = '<i class="fas fa-cloud-check"></i>';
            }
          } catch (_) {}
          if (item) item.cachedLocalPath = localPath;
        }
      }
    } catch (e) {
      Logger.warn('AssetsTab.path.manager.download.failed', { error: String(e?.message || e) });
      if ((e && e.message === 'AUTH') || /auth/i.test(String(e?.message))) {
        ui.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
      } else {
        ui.notifications?.error?.(`Failed to prepare path texture: ${e?.message || e}`);
      }
      return;
    } finally {
      try { overlayHandle?.destroy?.(); }
      catch (_) {}
    }

    if (requestId !== this._pathRequestId) {
      return;
    }

    if (!localPath) {
      ui.notifications?.warn?.('Path texture not available locally yet. Please try again.');
      return;
    }

    try {
      cardElement.setAttribute('data-url', localPath);
      if (item) item.cachedLocalPath = localPath;
    } catch (_) {}

    const sanitizedName = filename ? filename.replace(/\.[^.]+$/, '') : 'path-texture';
    try {
      await pathManager?.start?.(localPath, `path-${sanitizedName}.webp`, { pointer: pointerCoords, pointerEvent: triggerEvent });
    } catch (error) {
      Logger.warn('AssetsTab.path.manager.start.failed', { error: String(error?.message || error) });
      if (this._isAuthFailure(error)) {
        await this._handlePremiumAuthFailure(error, {
          featureId: 'path.edit',
          label: 'Path Editing',
          source: 'assets-card:path:start'
        });
      } else {
        ui.notifications?.error?.(`Failed to start Path Editing: ${error?.message || error}`);
      }
    }
  }

  _spawnCardDownloadOverlay(cardElement, { label = 'Downloading...', pointer = null } = {}) {
    try {
      let resolvedPointer = null;
      let width = 140;
      let height = 140;
      if (pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) {
        resolvedPointer = { x: Number(pointer.x), y: Number(pointer.y) };
        width = height = 120;
      } else {
        const rect = cardElement?.getBoundingClientRect();
        if (rect) {
          resolvedPointer = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          width = rect.width || 140;
          height = rect.height || 140;
        } else {
          resolvedPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        }
      }
      const overlay = new PlacementOverlay({
        className: 'fa-nexus-placement-loading',
        pointer: resolvedPointer,
        screenWidth: Math.max(40, Math.round(width)),
        screenHeight: Math.max(40, Math.round(height)),
        trackZoom: false
      });
      const spinner = createPlacementSpinner({ label });
      spinner.style.width = '100%';
      spinner.style.height = '100%';
      overlay.content.appendChild(spinner);
      if (pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) {
        const moveHandler = (event) => {
          const x = Number.isFinite(event?.clientX) ? event.clientX : Number.isFinite(event?.pageX) ? event.pageX : resolvedPointer.x;
          const y = Number.isFinite(event?.clientY) ? event.clientY : Number.isFinite(event?.pageY) ? event.pageY : resolvedPointer.y;
          overlay.updatePointer(x, y);
        };
        window.addEventListener('pointermove', moveHandler);
        const originalDestroy = overlay.destroy.bind(overlay);
        overlay.destroy = () => {
          try { window.removeEventListener('pointermove', moveHandler); }
          catch (_) {}
          originalDestroy();
        };
      }
      return overlay;
    } catch (_) {
      return null;
    }
  }

  _extractPointerScreenCoords(trigger) {
    if (!trigger) return null;
    const evt = trigger?.originalEvent || trigger;
    if (!evt) return null;
    const toNumber = (value) => Number.isFinite(value) ? value : null;
    const cx = toNumber(evt.clientX ?? evt.x);
    const cy = toNumber(evt.clientY ?? evt.y);
    if (cx != null && cy != null) return { x: cx, y: cy };
    const px = toNumber(evt.pageX);
    const py = toNumber(evt.pageY);
    if (px != null && py != null) return { x: px, y: py };
    if (typeof evt === 'object' && toNumber(evt.x) != null && toNumber(evt.y) != null) {
      return { x: toNumber(evt.x), y: toNumber(evt.y) };
    }
    return null;
  }

  _isAuthFailure(error) {
    if (!error) return false;
    const code = String(error?.code || error?.name || '').toUpperCase();
    if (code && (/AUTH/.test(code) || ['STATE_MISSING', 'ENTITLEMENT_REQUIRED', 'HTTP_401', 'HTTP_403', 'SESSION_EXPIRED', 'STATE_INVALID'].includes(code))) {
      return true;
    }
    const message = String(error?.message || '').toLowerCase();
    return message.includes('auth') || message.includes('state');
  }

  async _handlePremiumAuthFailure(error, { featureId, label, source }) {
    const message = '🔐 Authentication expired - please reconnect to access premium content.';
    const tab = this.tab;
    const content = tab?.contentService;
    const authData = this._readPatreonAuthData();
    const hasAuth = !!(authData && authData.authenticated && authData.state);
    if (!hasAuth) {
      Logger.info('AssetsTab.premium.auth.skipDisconnect', {
        featureId,
        label,
        source,
        code: error?.code || error?.name,
        message: String(error?.message || error)
      });
      return;
    }
    try {
      if (content?._handleAuthFailure) {
        await content._handleAuthFailure({
          reason: error?.code || 'AUTH',
          kind: featureId,
          source,
          message,
          notify: true
        });
        return;
      }
    } catch (_) {}

    try { await game.settings.set('fa-nexus', 'patreon_auth_data', null); } catch (_) {}
    try { premiumEntitlementsService?.clear?.({ reason: 'assets-auth-failure' }); }
    catch (_) {}
    ui.notifications?.warn?.(message);
    Logger.warn('AssetsTab.premium.auth.disconnect', {
      featureId,
      label,
      source,
      code: error?.code || error?.name,
      message: String(error?.message || error)
    });
  }

  _readPatreonAuthData() {
    try {
      return game?.settings?.get?.('fa-nexus', 'patreon_auth_data') || null;
    } catch (_) {
      return null;
    }
  }


  async handleAssetCardClick(event, cardElement, item) {
    const tab = this.tab;
    event.preventDefault();
    event.stopPropagation();

    if (tab.isTexturesMode) {
      return this.handleTextureCardClick(cardElement, item, event);
    }

    if (tab.isPathsMode) {
      return this.handlePathCardClick(cardElement, item, event);
    }

    const ctrl = !!(event.ctrlKey || event.metaKey);
    const shift = !!event.shiftKey;
    const key = tab._keyFromCard(cardElement) || tab._computeItemKey(item);
    const visibleIndex = tab._indexOfVisibleKey(key, item);
    const authed = typeof tab._hasPremiumAuth === 'function' ? tab._hasPremiumAuth() : false;

    if (typeof tab._isAssetLocked === 'function' && tab._isAssetLocked(item, cardElement, { authed })) {
      Logger.info('AssetsTab.select.blocked.locked', { key, mode: ctrl ? (shift ? 'range-add' : 'toggle') : (shift ? 'range' : 'single') });
      ui.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
      try { tab._selection.selectedKeys.delete(key); } catch (_) {}
      try { tab._selection.lastClickedIndex = -1; } catch (_) {}
      try { tab._setCardSelectionUI(cardElement, false); } catch (_) {}
      try { tab._refreshSelectionUIInView(); } catch (_) {}
      return;
    }

    if (ctrl || shift) {
      try {
        if (shift) {
          const last = Number.isInteger(tab._selection.lastClickedIndex) && tab._selection.lastClickedIndex >= 0
            ? tab._selection.lastClickedIndex
            : visibleIndex;
          const from = last;
          const to = visibleIndex;
          if (ctrl) {
            tab._applyRangeSelection(from, to, 'add');
            Logger.info('AssetsTab.select.range', { from, to, mode: 'additive', keep: true, count: tab._selection.selectedKeys.size });
          } else {
            tab._applyRangeSelectionExclusive(from, to);
            Logger.info('AssetsTab.select.range', { from, to, mode: 'exclusive', count: tab._selection.selectedKeys.size });
          }
        } else if (ctrl) {
          if (tab._selection.selectedKeys.has(key)) tab._selection.selectedKeys.delete(key);
          else tab._selection.selectedKeys.add(key);
          Logger.info('AssetsTab.select.toggle', { key, selected: tab._selection.selectedKeys.has(key), count: tab._selection.selectedKeys.size });
        }
        tab._selection.lastClickedIndex = visibleIndex;
        tab._refreshSelectionUIInView();
      } catch (_) {}
      await tab._startPlacementFromSelection().catch(() => {});
      return;
    }

    const isStickyMode = true;
    try {
      tab._selection.selectedKeys.clear();
      if (key) tab._selection.selectedKeys.add(key);
      tab._selection.lastClickedIndex = visibleIndex;
      tab._refreshSelectionUIInView();
    } catch (_) {}

    return tab._beginAssetPlacement(cardElement, item, isStickyMode, event).catch(() => {});
  }

}
