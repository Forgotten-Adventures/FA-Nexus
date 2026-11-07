import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  contentDimensions,
  contentFilename,
  contentFolder,
  contentGrid,
  contentPath,
  inventoryItemKey
} from '../content/cloud-inventory-v2.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import { premiumEntitlementsService } from '../premium/premium-entitlements-service.js';
import { isPremiumAuthFailure, isProTierRefusal, proTierMessage } from '../premium/session-host/auth-state.js';
import { PlacementOverlay, createPlacementSpinner } from '../core/placement/placement-overlay.js';

function clearLockedCardState(cardElement) {
  if (!cardElement) return;
  try { cardElement.classList.remove('locked-token'); } catch (_) {}
  try { cardElement.removeAttribute('data-locked'); } catch (_) {}
}

export class AssetsTabCardHelper {
  constructor(tab) {
    this.tab = tab;
    this._textureRequestId = 0;
    this._pathRequestId = 0;
  }

  _isVideoFilename(value) {
    if (!value) return false;
    return /\.(webm|mp4|m4v|mov)$/i.test(String(value));
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
        const full = await contentSvc.getFullURL('assets', item || {
          id: cardElement.getAttribute('data-content-id') || '',
          selected_source: { ext: '.webp' },
          tier: normalizedTier || 'free'
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

  _bindAssetCardClick(cardElement) {
    if (!cardElement) return;
    this._unbindAssetCardClick(cardElement);
    try {
      const handler = (ev) => this.handleAssetCardClick(ev, cardElement, cardElement._assetItem || null);
      cardElement._faNexusAssetClickHandler = handler;
      cardElement.addEventListener('click', handler);
    } catch (_) {}
  }

  _unbindAssetCardClick(cardElement) {
    try {
      const handler = cardElement?._faNexusAssetClickHandler;
      if (handler) {
        cardElement.removeEventListener('click', handler);
        delete cardElement._faNexusAssetClickHandler;
      }
    } catch (_) {}
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
      if (this._isAuthFailure(error) && code !== 'STATE_MISSING') {
        // An expired login: _handlePremiumAuthFailure signs out and says so.
        await this._handlePremiumAuthFailure(error, {
          featureId,
          label,
          source: 'assets-card:require'
        });
      } else if (isProTierRefusal(error)) {
        ui.notifications?.warn?.(proTierMessage(label));
        try { this.tab?.app?._syncPremiumDisclaimer?.(); } catch (_) {}
      } else if (code === 'STATE_MISSING') {
        ui.notifications?.error?.(`${label} is a Pro tool. Connect Patreon to use it.`);
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
      if ((gridW == null || gridH == null) && item) {
        const [itemGridW, itemGridH] = contentGrid(item);
        if (gridW == null) gridW = parseDimension(itemGridW);
        if (gridH == null) gridH = parseDimension(itemGridH);
      }

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
    if (String(item.source || '').toLowerCase() === 'cloud') return false;
    const filename = contentFilename(item).toLowerCase();
    const hasPattern = /(?:^|[_\-\s])\d+x\d+$/.test(filename.replace(/\.[^/.]+$/, ''));
    if (hasPattern) return false;
    const tab = this.tab;
    if (tab?._isSolidTextureItem?.(item)) return false;
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
          const dims = contentDimensions(item);
          try { cardElement.setAttribute('data-width', String(dims.width)); } catch (_) {}
          try { cardElement.setAttribute('data-height', String(dims.height)); } catch (_) {}
          try { cardElement.setAttribute('data-grid-w', String(dims.gridWidth)); } catch (_) {}
          try { cardElement.setAttribute('data-grid-h', String(dims.gridHeight)); } catch (_) {}
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
      item.actual_width = widthPx;
      item.actual_height = heightPx;
      item.grid = [gridWidth, gridHeight];
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
    const isSolid = tab?._isSolidTextureItem?.(item);
    const filename = contentFilename(item);
    const filePath = tab._resolveFilePath(item);
    const folderPath = tab._resolveFolderPath(item);
    const [gridWidth, gridHeight] = contentGrid(item);
    const dims = contentDimensions(item);
    const fileSize = Number(item?.selected_source?.size || 0);
    if (isSolid) {
      card.classList.add('fa-nexus-solid-texture');
    }
    const cachedPath = item?.cachedLocalPath || '';
    try { card.setAttribute('data-key', tab._computeItemKey(item)); } catch (_) {}
    card.setAttribute('data-content-id', inventoryItemKey(item));
    card.setAttribute('data-content-path', filePath);
    card.setAttribute('data-folder', folderPath || '');
    card.setAttribute('data-name', item?.name || filename || '');
    card.setAttribute('data-grid-w', String(gridWidth));
    card.setAttribute('data-grid-h', String(gridHeight));
    card.setAttribute('data-width', String(item?.actual_width || dims.width));
    card.setAttribute('data-height', String(item?.actual_height || dims.height));
    if (fileSize > 0) card.setAttribute('data-file-size', String(fileSize));
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
    const isVideoAsset = this._isVideoFilename(filename) || this._isVideoFilename(cachedPath) || this._isVideoFilename(filePath);
    const tier = String(item?.tier || '').toLowerCase();
    const canInlineCloudVideo = !isCloud || cachedPath || tier === 'free';
    const useVideo = isVideoAsset && canInlineCloudVideo;
    if (isVideoAsset) {
      try { card.setAttribute('data-media-type', 'video'); } catch (_) {}
    } else {
      try { card.setAttribute('data-media-type', 'image'); } catch (_) {}
    }
    const initialVideoSrc = useVideo && (!isCloud || cachedPath) ? (cachedPath || filePath || '') : '';
    const thumb = document.createElement('div');
    thumb.className = `thumb ${isSolid ? 'fa-nexus-solid-texture-thumb' : 'fa-nexus-thumb-placeholder'}`;
    const media = useVideo ? this._createThumbVideoElement() : document.createElement('img');
    if (useVideo) {
      media.src = initialVideoSrc;
    } else {
      media.alt = item?.name || filename || '';
      media.style.maxWidth = '100%';
      media.style.maxHeight = '100%';
      media.style.objectFit = 'contain';
    }
    thumb.appendChild(media);
    if (isSolid) {
      const colorPicker = document.createElement('label');
      colorPicker.className = 'fa-nexus-solid-color-picker';
      colorPicker.title = 'Pick solid color';
      colorPicker.setAttribute('aria-label', 'Pick solid color');
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.setAttribute('data-fa-nexus-solid-color-input', '');
      colorInput.setAttribute('aria-label', 'Pick solid color');
      const colorIcon = document.createElement('i');
      colorIcon.className = 'fas fa-palette';
      colorPicker.append(colorInput, colorIcon);
      thumb.appendChild(colorPicker);
    }
    const statusIcon = document.createElement('div');
    statusIcon.className = 'fa-nexus-status-icon';
    statusIcon.title = '';
    const gridTag = document.createElement('div');
    gridTag.className = 'fa-nexus-grid-size-tag';
    thumb.append(statusIcon, gridTag);
    card.appendChild(thumb);
    tab.app._collections?.decorate(card, item, tab.id);
    return card;
  }

  _mountSolidTextureCard(cardElement, item) {
    const tab = this.tab;
    const resolvedItem = tab?._getSolidTextureItem?.() || item;
    if (!resolvedItem) return;
    const thumb = cardElement.querySelector('.thumb');
    const img = cardElement.querySelector('img');
    const picker = cardElement.querySelector('.fa-nexus-solid-color-picker');
    const input = cardElement.querySelector('[data-fa-nexus-solid-color-input]');
    const color = resolvedItem.solidColor || tab?._getSolidTextureColor?.() || '#808080';
    const url = resolvedItem.cachedLocalPath || resolvedItem.thumbnail_url || resolvedItem.url || '';

    if (thumb) {
      thumb.classList.remove('fa-nexus-thumb-placeholder');
    }
    cardElement.classList.add('fa-nexus-solid-texture');
    cardElement.style.setProperty('--fa-nexus-solid-color', color);
    if (img) {
      img.src = url;
      img.alt = resolvedItem.name || contentFilename(resolvedItem) || 'Solid Color';
    }
    if (input) {
      input.value = color;
      if (!input._faNexusBound) {
        const stop = (event) => event.stopPropagation();
        let liveCommitTimer = null;
        const clearLiveCommitTimer = () => {
          if (!liveCommitTimer) return;
          try { clearTimeout(liveCommitTimer); } catch (_) {}
          liveCommitTimer = null;
        };
        const scheduleLiveSessionColor = (nextColor) => {
          clearLiveCommitTimer();
          liveCommitTimer = setTimeout(() => {
            liveCommitTimer = null;
            tab?._previewSolidTextureColor?.(nextColor);
          }, 90);
        };
        const applyLiveColorPreview = (event) => {
          stop(event);
          const nextColor = event?.target?.value || color;
          cardElement.style.setProperty('--fa-nexus-solid-color', nextColor);
          if (img) img.style.opacity = '0';
          input.value = nextColor;
          scheduleLiveSessionColor(nextColor);
        };
        const commitColorInput = (event) => {
          stop(event);
          clearLiveCommitTimer();
          const nextColor = event?.target?.value;
          const normalized = tab?._setSolidTextureColor?.(nextColor, {
            persist: true,
            notifyTexturePaint: true
          }) || nextColor || color;
          const updatedItem = tab?._solidTextureItem || tab?._getSolidTextureItem?.() || resolvedItem;
          const nextUrl = updatedItem.cachedLocalPath || updatedItem.thumbnail_url || updatedItem.url || url;
          if (!nextUrl) {
            Logger.error('AssetsTab.solidTextureColor.previewMissing', {
              color: normalized
            });
            return;
          }
          if (img) {
            img.src = nextUrl;
            img.style.opacity = '';
          }
          cardElement.style.setProperty('--fa-nexus-solid-color', normalized);
          cardElement.setAttribute('data-url', nextUrl);
          input.value = normalized;
          cardElement._assetItem = updatedItem;
        };
        if (picker && !picker._faNexusBound) {
          picker.addEventListener('click', stop);
          picker._faNexusBound = true;
        }
        input.addEventListener('click', stop);
        input.addEventListener('pointerdown', stop);
        input.addEventListener('input', applyLiveColorPreview);
        input.addEventListener('change', commitColorInput);
        input._faNexusBound = true;
      }
    }

    try { cardElement.setAttribute('data-source', 'local'); } catch (_) {}
    try { cardElement.setAttribute('data-tier', 'free'); } catch (_) {}
    try { cardElement.setAttribute('data-media-type', 'image'); } catch (_) {}
    if (url) {
      try { cardElement.setAttribute('data-url', url); } catch (_) {}
      try { cardElement.setAttribute('data-cached', 'true'); } catch (_) {}
    }
    try { cardElement.setAttribute('data-content-id', inventoryItemKey(resolvedItem)); } catch (_) {}
    try { cardElement.setAttribute('data-content-path', contentPath(resolvedItem)); } catch (_) {}
    try { cardElement.setAttribute('data-folder', contentFolder(resolvedItem)); } catch (_) {}
    try { cardElement.setAttribute('data-name', resolvedItem.name || contentFilename(resolvedItem) || 'Solid Color'); } catch (_) {}
    const dims = contentDimensions(resolvedItem);
    try { cardElement.setAttribute('data-width', String(dims.width)); } catch (_) {}
    try { cardElement.setAttribute('data-height', String(dims.height)); } catch (_) {}
    try { cardElement.setAttribute('data-grid-w', String(dims.gridWidth)); } catch (_) {}
    try { cardElement.setAttribute('data-grid-h', String(dims.gridHeight)); } catch (_) {}

    this.updateCardGridBadge(cardElement, resolvedItem);
    try { cardElement._assetItem = resolvedItem; } catch (_) {}
    tab.app._collections?.decorate(cardElement, resolvedItem, tab.id);

    const key = tab._keyFromCard(cardElement);
    const selected = key && tab._selection.selectedKeys.has(key);
    tab._setCardSelectionUI(cardElement, !!selected);
    this._bindAssetCardClick(cardElement);
  }

  async mountCard(cardElement, item) {
    const tab = this.tab;
    if (tab?._isSolidTextureItem?.(item)) {
      this._mountSolidTextureCard(cardElement, item);
      return;
    }
    try {
      if (item) {
        const dims = contentDimensions(item);
        cardElement.setAttribute('data-width', String(item.actual_width || dims.width));
        cardElement.setAttribute('data-height', String(item.actual_height || dims.height));
        cardElement.setAttribute('data-grid-w', String(dims.gridWidth));
        cardElement.setAttribute('data-grid-h', String(dims.gridHeight));
        const fileSize = Number(item?.selected_source?.size || 0);
        if (fileSize > 0) cardElement.setAttribute('data-file-size', String(fileSize));
        else cardElement.removeAttribute('data-file-size');
        cardElement.setAttribute('data-content-id', inventoryItemKey(item));
        cardElement.setAttribute('data-content-path', tab._resolveFilePath(item));
        cardElement.setAttribute('data-folder', tab._resolveFolderPath(item) || '');
        cardElement.setAttribute('data-name', item.name || contentFilename(item) || '');
      }
      const thumb = cardElement.querySelector('.thumb');
      let img = cardElement.querySelector('img');
      let video = cardElement.querySelector('video');
      const statusIcon = cardElement.querySelector('.fa-nexus-status-icon');
      const isCloud = (item && item.source === 'cloud') || (cardElement.getAttribute('data-source') === 'cloud');
      const tier = item?.tier || cardElement.getAttribute('data-tier') || '';
      const folderPathAttr = cardElement.getAttribute('data-folder') || tab._resolveFolderPath(item);
      const filePathAttr = cardElement.getAttribute('data-content-path') || tab._resolveFilePath(item);
      if (filePathAttr && !cardElement.getAttribute('data-content-path')) cardElement.setAttribute('data-content-path', filePathAttr);
      if (folderPathAttr && cardElement.getAttribute('data-folder') !== folderPathAttr) cardElement.setAttribute('data-folder', folderPathAttr || '');
      let cachedLocalPath = item?.cachedLocalPath || '';
      try {
        if (!cachedLocalPath && isCloud) {
          const download = tab.downloadManager;
          if (download && typeof download.getLocalPath === 'function') {
            cachedLocalPath = download.getLocalPath('assets', item || {
              id: cardElement.getAttribute('data-content-id') || '',
              selected_source: { ext: '.webp' },
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
      const mediaTypeAttr = cardElement.getAttribute('data-media-type') || (this._isVideoFilename(contentFilename(item)) ? 'video' : 'image');
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
          src = filePathAttr || cardElement.getAttribute('data-url') || cardElement.getAttribute('data-content-path') || '';
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
        clearLockedCardState(cardElement);
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
      this._bindAssetCardClick(cardElement);
    } catch (e) {
      Logger.warn('AssetsTab.mount.error', { error: String(e?.message || e) });
    }
  }

  unmountCard(cardElement) {
    this._unbindAssetCardClick(cardElement);
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
    try { if (cardElement?._faNexusEnsureLocalError) delete cardElement._faNexusEnsureLocalError; } catch (_) {}
  }

  async ensureLocalAssetForCard(cardElement, item, { triggerEvent = null, label = 'Downloading asset...' } = {}) {
    const tab = this.tab;
    if (!tab) return '';
    const resolvedItem = item || cardElement?._assetItem || null;
    const getAttr = (key) => cardElement?.getAttribute?.(key) || '';
    const filename = contentFilename(resolvedItem) || (getAttr('data-content-path').split('/').pop() || '');
    const filePathAttr = getAttr('data-content-path') || tab._resolveFilePath?.(resolvedItem) || '';
    const folderPath = getAttr('data-folder') || tab._resolveFolderPath?.(resolvedItem) || '';
    const tier = getAttr('data-tier') || resolvedItem?.tier || '';
    const sourceAttr = (getAttr('data-source') || resolvedItem?.source || '').toLowerCase();
    const isCloud = sourceAttr === 'cloud';
    const pointerCoords = this._extractPointerScreenCoords(triggerEvent);
    const download = tab.downloadManager;
    const content = tab.contentService;
    let localPath = '';
    let overlayHandle = null;
    try { if (cardElement?._faNexusEnsureLocalError) delete cardElement._faNexusEnsureLocalError; } catch (_) {}

    try {
      const isCached = getAttr('data-cached') === 'true';
      if (isCached) localPath = getAttr('data-url') || '';
      if (!localPath && resolvedItem?.cachedLocalPath) localPath = resolvedItem.cachedLocalPath;
      if (!localPath && !isCloud) {
        localPath = resolvedItem?.cachedLocalPath || contentPath(resolvedItem) || resolvedItem?.url || filePathAttr || '';
      }
      if (!localPath && isCloud && download?.getLocalPath) {
        localPath = download.getLocalPath('assets', resolvedItem || {
          id: getAttr('data-content-id') || '',
          selected_source: { ext: '.webp' },
          tier: tier || 'free'
        }) || '';
        if (localPath) this._markCardAsCached(cardElement, resolvedItem, localPath);
      }
      if (!localPath && isCloud && content?.getFullURL && download?.ensureLocal) {
        if (cardElement) {
          overlayHandle = this._spawnCardDownloadOverlay(cardElement, { pointer: pointerCoords, label });
        }
        const auth = this._readPatreonAuthData();
        const state = auth && auth.authenticated && auth.state ? auth.state : undefined;
        const downloadItem = resolvedItem || {
          id: getAttr('data-content-id') || filePathAttr.replace(/\.[^/.]+$/, ''),
          selected_source: { ext: '.webp' },
          tier: tier || 'free'
        };
        const fullUrl = await content.getFullURL('assets', downloadItem, state);
        localPath = await download.ensureLocal('assets', downloadItem, fullUrl);
        if (localPath) this._markCardAsCached(cardElement, resolvedItem, localPath);
      }
    } catch (error) {
      try { if (cardElement) cardElement._faNexusEnsureLocalError = error; } catch (_) {}
      Logger.warn('AssetsTab.ensureLocal.failed', { label, error: String(error?.message || error) });
      if (error?.faNexusNotified) {
        // The content service already said why (a tier without premium downloads).
      } else if ((error && error.message === 'AUTH') || /auth/i.test(String(error?.message || ''))) {
        ui.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
      } else if (this._isCloudFileMissingError(error)) {
        ui.notifications?.warn?.(error?.userMessage || `Cloud file is listed in the manifest but is missing from R2: ${filename || 'asset'} (404)`);
      } else {
        ui.notifications?.error?.(`Failed to prepare asset: ${error?.message || error}`);
      }
      return '';
    } finally {
      try { overlayHandle?.destroy?.(); } catch (_) {}
    }

    return localPath;
  }

  _markCardAsCached(cardElement, item, localPath) {
    if (!localPath) return;
    // Check if this is a direct CDN URL (not actually cached locally)
    const isDirectUrl = /^https?:\/\/r2-public\.forgotten-adventures\.net\//i.test(localPath);
    if (cardElement) {
      try { cardElement.setAttribute('data-url', localPath); } catch (_) {}
      // Only mark as cached if actually downloaded locally
      if (!isDirectUrl) {
        try { cardElement.setAttribute('data-cached', 'true'); } catch (_) {}
        clearLockedCardState(cardElement);
        const icon = cardElement.querySelector?.('.fa-nexus-status-icon');
        if (icon) {
          icon.classList.remove('cloud-plus', 'cloud', 'premium');
          icon.classList.add('cloud', 'cached');
          icon.title = 'Downloaded';
          icon.innerHTML = '<i class="fas fa-cloud-check"></i>';
        }
      }
    }
    if (item && !isDirectUrl) {
      item.cachedLocalPath = localPath;
    }
  }

  _markSingleToolSessionSelection(cardElement, item, reason = 'tool-session') {
    const tab = this.tab;
    if (!tab?._selection || !cardElement) return;
    const key = tab._keyFromCard?.(cardElement) || tab._computeItemKey?.(item) || '';
    if (!key) {
      Logger.warn('AssetsTab.select.toolSession.keyMissing', {
        tab: tab?.id || null,
        reason,
        filename: contentFilename(item) || cardElement.getAttribute?.('data-content-path') || ''
      });
      return;
    }

    try {
      tab._selection.clearSelection?.();
      tab._selection.selectedKeys.add(key);
      tab._selection.lastClickedIndex = tab._indexOfVisibleKey?.(key, item) ?? -1;
      tab._refreshSelectionUIInView?.();
      Logger.info?.('AssetsTab.select.toolSession', {
        tab: tab?.id || null,
        reason,
        key,
        count: tab._selection.selectedKeys.size
      });
    } catch (error) {
      Logger.warn('AssetsTab.select.toolSession.failed', {
        tab: tab?.id || null,
        reason,
        key,
        error: String(error?.message || error)
      });
    }
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

    const filename = contentFilename(item) || cardElement.getAttribute('data-content-path')?.split('/').pop() || '';
    const isSolid = tab?._isSolidTextureItem?.(item);
    let solidColor = null;
    const requestId = (this._textureRequestId = (this._textureRequestId || 0) + 1);

    let localPath = '';
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
    } catch (e) {
      Logger.warn('AssetsTab.texture.paint.download.failed', { error: String(e?.message || e) });
      if (e?.faNexusNotified) {
        // The content service already said why (a tier without premium downloads).
      } else if ((e && e.message === 'AUTH') || /auth/i.test(String(e?.message))) {
        ui.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
      } else {
        ui.notifications?.error?.(`Failed to prepare texture: ${e?.userMessage || e?.message || e}`);
      }
      return;
    }

    if (isSolid) {
      const solidItem = tab?._getSolidTextureItem?.() || item;
      solidColor = solidItem?.solidColor || tab?._getSolidTextureColor?.() || null;
      localPath = tab?._getSolidTexturePlaceholderPath?.() || 'modules/fa-nexus/images/transparent.png';
    } else {
      localPath = await this.ensureLocalAssetForCard(cardElement, item, {
        triggerEvent,
        label: 'Preparing texture...'
      });
    }

    if (requestId !== this._textureRequestId) {
      return;
    }

    if (!localPath) {
      const ensureError = cardElement?._faNexusEnsureLocalError || null;
      if (!this._isCloudFileMissingError(ensureError)) {
        ui.notifications?.warn?.('Texture not available locally yet. Please try again.');
      }
      return;
    }

    const sanitizedName = filename ? filename.replace(/\.[^.]+$/, '') : 'masked-texture';
    try {
      const startOptions = { pointer: pointerCoords, pointerEvent: triggerEvent };
      if (solidColor) startOptions.solidColor = solidColor;
      await texturePaint?.start?.(localPath, `masked-${sanitizedName}.webp`, startOptions);
      if (requestId === this._textureRequestId) {
        this._markSingleToolSessionSelection(cardElement, item, 'texture-paint-start');
      }
    } catch (error) {
      Logger.warn('AssetsTab.texture.paint.start.failed', { error: String(error?.message || error) });
      if (this._isAuthFailure(error)) {
        await this._handlePremiumAuthFailure(error, {
          featureId: 'texture.paint',
          label: 'Texture Painting',
          source: 'assets-card:texture:start'
        });
      } else if (isProTierRefusal(error)) {
        ui.notifications?.warn?.(proTierMessage('Texture Painting'));
      } else {
        ui.notifications?.error?.(`Failed to start Texture Painting: ${error?.message || error}`);
      }
    }
  }

  async handlePathCardClick(cardElement, item, triggerEvent = null) {
    const tab = this.tab;
    if (!cardElement) return;
    const featureId = 'path.edit.v2';
    const label = 'Path Editing';
    if (!(await this._requirePremiumFeature(featureId, { label }))) return;
    try { await tab._controller.ensureServices(); }
    catch (error) { Logger.warn('AssetsTab.paths.ensure.failed', { error: String(error?.message || error) }); }
    const pathManagerV2 = tab.pathManagerV2;
    if (!pathManagerV2) {
      Logger.warn('AssetsTab.paths.manager.unavailable');
      return;
    }

    const filename = contentFilename(item) || cardElement.getAttribute('data-content-path')?.split('/').pop() || '';
    const requestId = (this._pathRequestId = (this._pathRequestId || 0) + 1);

    let localPath = '';
    const pointerCoords = this._extractPointerScreenCoords(triggerEvent);
    const wasActive = !!pathManagerV2?.isActive;
    try {
      if (!wasActive) {
        await Promise.resolve(pathManagerV2?.stop?.());
      }
    } catch (stopError) {
      Logger.warn('AssetsTab.path.manager.stop.failed', { error: String(stopError?.message || stopError) });
    }
    try {
      localPath = await this.ensureLocalAssetForCard(cardElement, item, {
        triggerEvent,
        label: 'Preparing path texture...'
      });
    } catch (e) {
      Logger.warn('AssetsTab.path.manager.download.failed', { error: String(e?.message || e) });
      if (e?.faNexusNotified) {
        // The content service already said why (a tier without premium downloads).
      } else if ((e && e.message === 'AUTH') || /auth/i.test(String(e?.message))) {
        ui.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
      } else {
        ui.notifications?.error?.(`Failed to prepare path texture: ${e?.userMessage || e?.message || e}`);
      }
      return;
    }

    if (requestId !== this._pathRequestId) {
      return;
    }

    if (!localPath) {
      const ensureError = cardElement?._faNexusEnsureLocalError || null;
      if (!this._isCloudFileMissingError(ensureError)) {
        ui.notifications?.warn?.('Path texture not available locally yet. Please try again.');
      }
      return;
    }

    try {
      cardElement.setAttribute('data-url', localPath);
      if (item) item.cachedLocalPath = localPath;
    } catch (_) {}

    const sanitizedName = filename ? filename.replace(/\.[^.]+$/, '') : 'path-texture';
    try {
      await pathManagerV2?.start?.(localPath, `path-${sanitizedName}.webp`, { pointer: pointerCoords, pointerEvent: triggerEvent });
      if (requestId === this._pathRequestId) {
        this._markSingleToolSessionSelection(cardElement, item, 'path-editor-start');
      }
    } catch (error) {
      Logger.warn('AssetsTab.path.manager.start.failed', { error: String(error?.message || error) });
      if (this._isAuthFailure(error)) {
        await this._handlePremiumAuthFailure(error, {
          featureId,
          label,
          source: 'assets-card:path:start'
        });
      } else if (isProTierRefusal(error)) {
        ui.notifications?.warn?.(proTierMessage(label));
      } else {
        ui.notifications?.error?.(`Failed to start ${label}: ${error?.message || error}`);
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
    return isPremiumAuthFailure(error);
  }

  _isCloudFileMissingError(error) {
    return !!error && (
      error.faNexusCloudFileMissing === true ||
      error.code === 'FA_NEXUS_CLOUD_FILE_MISSING' ||
      Number(error.status) === 404
    );
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
      ui.notifications?.error?.(tab._lockedPremiumAssetMessage?.() || 'Authentication required for premium assets. Please connect Patreon.');
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
      await tab._startPlacementFromSelection().catch((error) => {
        tab._reportAssetPlacementFailure?.('AssetsTab.place.selection.clickFailed', error);
      });
      return;
    }

    const isStickyMode = true;
    try {
      tab._selection.selectedKeys.clear();
      if (key) tab._selection.selectedKeys.add(key);
      tab._selection.lastClickedIndex = visibleIndex;
      tab._refreshSelectionUIInView();
    } catch (_) {}

    return tab._beginAssetPlacement(cardElement, item, isStickyMode, event).catch((error) => {
      tab._reportAssetPlacementFailure?.('AssetsTab.place.clickFailed', error);
    });
  }

}
