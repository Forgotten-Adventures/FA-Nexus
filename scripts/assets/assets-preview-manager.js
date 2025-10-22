import { HoverPreviewManager } from '../core/hover-preview-manager.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

/**
 * AssetPreviewManager (FA Nexus)
 * Specialises HoverPreviewManager with asset-specific metadata formatting,
 * cloud URL resolution, and dimension refinement for texture assets.
 */
export class AssetPreviewManager extends HoverPreviewManager {
  /**
   * @param {import('../content/nexus-content-service.js').NexusContentService|null} [contentService]
   * @param {{setTimeout?:Function,clearTimeout?:Function}|null} [eventManager]
   */
  constructor(contentService = null, eventManager = null) {
    super({ eventManager });
    this._contentService = contentService;
  }

  destroy() {
    super.destroy();
    this._contentService = null;
  }

  async resolveImageSource(cardEl, meta) {
    let url = meta.currentUrl || meta.filePathAttr || '';
    const svc = this._ensureContentService();
    if (svc && meta.source === 'cloud' && !meta.downloaded) {
      try {
        const item = { file_path: meta.filePathAttr || url || '', filename: meta.filename, tier: meta.tier };
        const authState = this._getAuthState();
        const full = await svc.getFullURL?.('assets', item, authState);
        if (full) url = full;
        Logger.debug('AssetPreview.resolveImageSource', { url, source: meta.source, tier: meta.tier, downloaded: meta.downloaded });
      } catch (e) {
        Logger.warn('AssetPreview.resolveImageSource.failed', { error: String(e?.message || e) });
      }
    }
    return { url, alt: meta.filename };
  }

  _updateMeta(cardEl, meta, _metrics = {}) {
    if (!this._dimsEl) return;
    const width = cardEl?.getAttribute('data-width') || meta.widthAttr || '300px';
    const height = cardEl?.getAttribute('data-height') || meta.heightAttr || '300px';
    const normalizeGrid = (value) => {
      if (value === undefined || value === null) return '';
      const raw = String(value).trim();
      if (!raw) return '';
      const num = Number(raw);
      if (!Number.isFinite(num) || num <= 0) return '';
      const normalized = Math.round(num * 100) / 100;
      return normalized.toFixed(2).replace(/\.?0+$/, '');
    };

    const gridWidthAttr = cardEl?.getAttribute('data-grid-w') ?? meta.gridWidthAttr ?? '';
    const gridHeightAttr = cardEl?.getAttribute('data-grid-h') ?? meta.gridHeightAttr ?? '';
    const gridWidth = normalizeGrid(gridWidthAttr);
    const gridHeight = normalizeGrid(gridHeightAttr);
    const scaleAttr = cardEl?.getAttribute('data-scale') || meta.scaleAttr || '1x';
    const fileSize = cardEl?.getAttribute('data-file-size') || meta.fileSizeAttr || '';
    Logger.info('AssetPreviewManager._updatePreviewMeta', { width, height, gridWidth, gridHeight, scale: scaleAttr, fileSize });

    let text = '';
    if (width && height) text += `${width}×${height}px`;
    const gridLabel = (gridWidth && gridHeight) ? `${gridWidth}×${gridHeight}` : '--';
    text += `${text ? ' ' : ''}( ${gridLabel} grid )`;
    if (fileSize && fileSize !== '0') {
      const bytes = Number(fileSize);
      const human = Number.isFinite(bytes) && bytes > 0 ? this._formatBytes(bytes) : fileSize;
      text += ` - ${human}`;
    }
    this._dimsEl.textContent = text;
  }

  async _maybeFetchSize(cardEl, meta) {
    try {
      const svc = this._ensureContentService();
      if (!svc || typeof svc.getFileSize !== 'function') return;
      const existing = cardEl.getAttribute('data-file-size') || meta.fileSizeAttr;
      if (existing && existing !== '0') return;
      const url = cardEl.getAttribute('data-url') || cardEl.getAttribute('data-file-path');
      if (!url) return;
      const size = await svc.getFileSize(url);
      if (Number.isFinite(size) && size > 0) {
        cardEl.setAttribute('data-file-size', String(size));
        meta.fileSizeAttr = String(size);
        this._updateMeta(cardEl, meta);
      }
    } catch (e) {
      Logger.warn('AssetPreviewManager._maybeFetchSize', { error: String(e?.message || e) });
    }
  }

  afterImageReady(cardEl, meta, metrics, context = {}) {
    const mediaEl = context?.mediaEl || this._activeMediaEl || null;
    const loadToken = context?.loadToken || null;
    this._resolveActualDimensions(cardEl, meta, mediaEl, loadToken, metrics);
  }

  _ensureContentService() {
    if (this._contentService) return this._contentService;
    try {
      const app = foundry.applications.instances.get('fa-nexus-app');
      const svc = app?._contentService;
      if (svc) this._contentService = svc;
    } catch (_) {}
    return this._contentService;
  }

  _getAuthState() {
    try {
      const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
      if (auth && auth.authenticated && auth.state) return auth.state;
    } catch (_) {}
    return '';
  }

  _resolveActualDimensions(cardEl, meta, mediaEl = null, loadToken = null, metrics = null) {
    try {
      const resolvedMediaEl = mediaEl || this._activeMediaEl || this._imgEl || this._videoEl;
      if (!resolvedMediaEl || !cardEl) return;
      this._updateGridBadge(cardEl);
      const item = cardEl._assetItem;
      const filenameRaw = String(cardEl.getAttribute('data-filename') || '');
      const pathRaw = String(cardEl.getAttribute('data-path') || '');
      const should = this._shouldRefineDimensions(cardEl);
      const tokenMismatch = loadToken && resolvedMediaEl?.dataset?.previewLoadToken && resolvedMediaEl.dataset.previewLoadToken !== loadToken;
      Logger.debug('AssetPreview.dim.check', {
        filename: filenameRaw,
        path: pathRaw,
        should,
        resolved: !!(item && item._dimsResolved),
        tokenMismatch,
        loadToken
      });
      if (tokenMismatch) {
        Logger.debug('AssetPreview.dim.skipToken', { filename: filenameRaw, path: pathRaw, loadToken });
        return;
      }
      if (!should) return;

      if (item && item._dimsResolved) {
        Logger.debug('AssetPreview.dim.skipResolved', { filename: filenameRaw, path: pathRaw });
        return;
      }

      const tag = String(resolvedMediaEl.tagName || '').toLowerCase();
      let naturalW = Math.round(metrics?.naturalWidth || 0);
      let naturalH = Math.round(metrics?.naturalHeight || 0);

      const readyForVideo = tag === 'video' ? resolvedMediaEl.readyState >= 2 : true;
      const isImageReady = tag !== 'video' ? resolvedMediaEl.complete && resolvedMediaEl.naturalWidth && resolvedMediaEl.naturalHeight : true;

      if (!naturalW || !naturalH) {
        if (tag === 'video') {
          naturalW = Math.round(resolvedMediaEl.videoWidth || 0);
          naturalH = Math.round(resolvedMediaEl.videoHeight || 0);
        } else {
          naturalW = Math.round(resolvedMediaEl.naturalWidth || 0);
          naturalH = Math.round(resolvedMediaEl.naturalHeight || 0);
        }
      }

      const hasDims = naturalW > 0 && naturalH > 0;
      const ready = tag === 'video'
        ? readyForVideo && hasDims
        : hasDims && (isImageReady || (metrics && metrics.naturalWidth && metrics.naturalHeight));
      if (!ready) {
        Logger.debug('AssetPreview.dim.defer', { filename: filenameRaw, naturalW, naturalH, readyForVideo, isImageReady, loadToken });
        const handler = () => {
          const currentToken = resolvedMediaEl?.dataset?.previewLoadToken || '';
          if (loadToken && currentToken && currentToken !== loadToken) return;
          if (tag === 'video') {
            try { resolvedMediaEl.removeEventListener('loadeddata', handler); } catch (_) {}
          } else {
            try { resolvedMediaEl.removeEventListener('load', handler); } catch (_) {}
          }
          try { this._resolveActualDimensions(cardEl, meta, resolvedMediaEl, loadToken); } catch (_) {}
        };
        if (tag === 'video') {
          try { resolvedMediaEl.addEventListener('loadeddata', handler, { once: true }); } catch (_) {}
        } else {
          try { resolvedMediaEl.addEventListener('load', handler, { once: true }); } catch (_) {}
        }
        return;
      }

      const currentW = Number(cardEl.getAttribute('data-width') || 0);
      const currentH = Number(cardEl.getAttribute('data-height') || 0);
      if (currentW === naturalW && currentH === naturalH) return;

      const base = 200;
      const gridW = Math.max(0.01, Math.round((naturalW / base) * 100) / 100);
      const gridH = Math.max(0.01, Math.round((naturalH / base) * 100) / 100);
      cardEl.setAttribute('data-width', String(naturalW));
      cardEl.setAttribute('data-height', String(naturalH));
      cardEl.setAttribute('data-grid-w', String(gridW));
      cardEl.setAttribute('data-grid-h', String(gridH));
      try { cardEl.removeAttribute('data-grid-pending'); } catch (_) {}
      this._updateGridBadge(cardEl);

      const viewportW = window.innerWidth || 1920;
      const viewportH = window.innerHeight || 1080;
      const maxW = Math.max(120, Math.min(600, Math.floor(viewportW * 0.45)));
      const maxH = Math.max(120, Math.min(600, Math.floor(viewportH * 0.9)));
      const scaleFactor = Math.min(1, maxW / naturalW, maxH / naturalH);
      const targetW = Math.max(1, Math.round(naturalW * scaleFactor));
      resolvedMediaEl.style.width = `${targetW}px`;
      resolvedMediaEl.style.height = '';
      resolvedMediaEl.style.aspectRatio = `${naturalW} / ${naturalH}`;
      try {
        resolvedMediaEl.setAttribute('width', String(targetW));
        resolvedMediaEl.removeAttribute('height');
      } catch (_) {}

      try {
        if (item) {
          item.width = naturalW;
          item.height = naturalH;
          item.actual_width = naturalW;
          item.actual_height = naturalH;
          item.grid_width = gridW;
          item.grid_height = gridH;
          item._dimsResolved = true;
        }
      } catch (_) {}

      const updatedMeta = {
        ...meta,
        widthAttr: String(naturalW),
        heightAttr: String(naturalH),
        gridWidthAttr: String(gridW),
        gridHeightAttr: String(gridH)
      };
      this._updateMeta(cardEl, updatedMeta);
      this._updateGridOverlay(cardEl, 0);
    } catch (e) {
      Logger.warn('AssetPreviewManager.dimensions', { error: String(e?.message || e) });
    }
  }

  _shouldRefineDimensions(cardEl) {
    try {
      const filename = String(cardEl.getAttribute('data-filename') || '').toLowerCase();
      const withoutExt = filename.replace(/\.[^/.]+$/, '');
      const hasPattern = /(?:^|[_\-\s])\d+x\d+$/.test(withoutExt);
      const should = !hasPattern;
      const path = String(cardEl.getAttribute('data-path') || '').toLowerCase();
      Logger.debug('AssetPreview.dim.should', { filename, path, hasPattern, should });
      return should;
    } catch (_) {
      return false;
    }
  }

  _updateGridBadge(cardEl) {
    try {
      if (!cardEl) return;
      const badge = cardEl.querySelector('.fa-nexus-grid-size-tag');
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
      const gridW = parseDimension(cardEl.getAttribute('data-grid-w'));
      const gridH = parseDimension(cardEl.getAttribute('data-grid-h'));
      const pending = cardEl.getAttribute('data-grid-pending') === 'true';
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
}
