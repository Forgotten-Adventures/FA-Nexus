import { NexusLogger as Logger } from './nexus-logger.js';

/**
 * HoverPreviewManager
 * Shared hover preview controller used by assets and tokens grids.
 * Handles singleton element lifecycle, delayed hover display, positioning,
 * image loading (with premium gating), grid overlay, and responsive sizing.
 * Subclasses provide data-service hooks and metadata formatting.
 */
export class HoverPreviewManager {
  /**
   * @param {{eventManager?: {setTimeout?:Function, clearTimeout?:Function}}} [options]
   */
  constructor({ eventManager = null } = {}) {
    this._previewEl = null;
    this._imgEl = null;
    this._filenameEl = null;
    this._pathEl = null;
    this._dimsEl = null;
    this._videoEl = null;
    this._activeMediaEl = null;
    this._activeMediaKind = 'image';
    this._activeLoadToken = null;
    this._activeLoadToken = null;

    this._eventManager = eventManager;

    this._showRaf = null;
    this._posRaf = null;
    this._overlayRaf = null;
    this._delayId = null;
    this._currentId = 0;
    this._activeCard = null;
    this._imgResizeObserver = null;
  }

  /** Ensure preview element exists (reuses existing singleton if already on DOM) */
  initialize() {
    if (this._previewEl) return;
    try { Logger.debug('Preview.init'); } catch (_) {}

    const existing = Array.from(document.querySelectorAll('.fa-nexus-hover-preview'));
    if (existing.length > 0) {
      const keep = existing[0];
      for (let i = 1; i < existing.length; i++) {
        try { existing[i].remove(); } catch (_) {}
      }
      this._previewEl = keep;
      this._imgEl = keep.querySelector('img');
      let video = keep.querySelector('video');
      if (!video) {
        video = document.createElement('video');
        video.muted = true;
        video.defaultMuted = true;
        video.autoplay = false;
        video.loop = false;
        video.controls = false;
        video.playsInline = true;
        video.preload = 'metadata';
        video.style.display = 'none';
        video.style.maxWidth = '100%';
        video.style.maxHeight = '600px';
        video.style.borderRadius = '4px';
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.setAttribute('preload', 'metadata');
        const infoNode = keep.querySelector('.preview-info');
        if (infoNode && infoNode.parentNode === keep) {
          keep.insertBefore(video, infoNode);
        } else {
          keep.appendChild(video);
        }
      }
      this._videoEl = video;
      const info = keep.querySelector('.preview-info');
      this._filenameEl = info?.querySelector('.preview-filename') || null;
      this._pathEl = info?.querySelector('.preview-path') || null;
      this._dimsEl = info?.querySelector('.preview-meta') || null;
      this._activeMediaEl = this._imgEl || this._videoEl || null;
      this._activeMediaKind = this._activeMediaEl === this._videoEl ? 'video' : 'image';
      return;
    }

    const el = document.createElement('div');
    el.className = 'fa-nexus-hover-preview';
    el.style.display = 'none';

    const img = document.createElement('img');
    const info = document.createElement('div');
    info.className = 'preview-info';
    const name = document.createElement('div');
    name.className = 'preview-filename';
    const path = document.createElement('div');
    path.className = 'preview-path';
    const meta = document.createElement('div');
    meta.className = 'preview-meta';
    info.appendChild(name);
    info.appendChild(path);
    info.appendChild(meta);

    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = false;
    video.loop = false;
    video.controls = false;
    video.playsInline = true;
    video.preload = 'metadata';
    video.style.display = 'none';
    video.style.maxWidth = '100%';
    video.style.maxHeight = '600px';
    video.style.borderRadius = '4px';
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.setAttribute('preload', 'metadata');

    el.appendChild(img);
    el.appendChild(video);
    el.appendChild(info);
    document.body.appendChild(el);

    this._previewEl = el;
    this._imgEl = img;
    this._videoEl = video;
    this._filenameEl = name;
    this._pathEl = path;
    this._dimsEl = meta;
    this._activeMediaEl = img;
    this._activeMediaKind = 'image';
  }

  /** Dispose timers/observers and remove the preview element */
  destroy() {
    if (this._delayId) this._clearTimeout(this._delayId);
    if (this._showRaf) cancelAnimationFrame(this._showRaf);
    if (this._posRaf) cancelAnimationFrame(this._posRaf);
    if (this._overlayRaf) cancelAnimationFrame(this._overlayRaf);
    this._showRaf = this._posRaf = this._overlayRaf = null;

    try {
      if (this._imgResizeObserver) {
        this._imgResizeObserver.disconnect();
        this._imgResizeObserver = null;
      }
    } catch (_) {}

    if (this._previewEl && this._previewEl.parentNode) {
      this._previewEl.parentNode.removeChild(this._previewEl);
    }

    this._previewEl = null;
    this._imgEl = null;
    this._videoEl = null;
    this._activeMediaEl = null;
    this._activeMediaKind = 'image';
    this._filenameEl = null;
    this._pathEl = null;
    this._dimsEl = null;
    this._eventManager = null;
  }

  /** Show preview after delay if card is eligible */
  showPreviewWithDelay(mediaEl, cardEl, delay = 300) {
    if (!mediaEl || !cardEl) return;
    if (!this.canPreviewCard(cardEl)) return;
    if (this._delayId) this._clearTimeout(this._delayId);
    this._delayId = this._setTimeout(() => {
      this._delayId = null;
      this._show(mediaEl, cardEl);
    }, delay);
  }

  /** Hide preview immediately */
  hidePreview() {
    if (this._delayId) this._clearTimeout(this._delayId);
    const el = this._previewEl;
    if (!el) return;
    try { Logger.debug('Preview.hide'); } catch (_) {}
    el.classList.remove('visible');
    this._setTimeout(() => {
      if (this._previewEl) this._previewEl.style.display = 'none';
    }, 100);
    this._activeCard = null;
    try {
      if (this._imgResizeObserver) {
        this._imgResizeObserver.disconnect();
        this._imgResizeObserver = null;
      }
    } catch (_) {}
    if (this._overlayRaf) {
      cancelAnimationFrame(this._overlayRaf);
      this._overlayRaf = null;
    }
    if (this._imgEl) {
      this._imgEl.style.backgroundImage = '';
      this._imgEl.style.backgroundSize = '';
      this._imgEl.style.backgroundPosition = '';
      this._imgEl.style.boxShadow = '';
      this._imgEl.style.width = '';
      this._imgEl.style.height = '';
      this._imgEl.style.aspectRatio = '';
      this._imgEl.style.display = '';
      this._imgEl.style.opacity = '';
      this._imgEl.style.objectFit = '';
      this._imgEl.style.objectPosition = '';
      try {
        this._imgEl.removeAttribute('width');
        this._imgEl.removeAttribute('height');
      } catch (_) {}
      try { this._imgEl.src = ''; } catch (_) {}
    }
    if (this._videoEl) {
      try { this._videoEl.pause(); } catch (_) {}
      try { this._videoEl.removeAttribute('src'); this._videoEl.load(); } catch (_) {}
      this._videoEl.style.backgroundImage = '';
      this._videoEl.style.backgroundSize = '';
      this._videoEl.style.backgroundPosition = '';
      this._videoEl.style.boxShadow = '';
      this._videoEl.style.width = '';
      this._videoEl.style.height = '';
      this._videoEl.style.aspectRatio = '';
      this._videoEl.style.display = 'none';
      this._videoEl.style.opacity = '';
    }
    this._activeMediaEl = this._imgEl;
    this._activeMediaKind = 'image';
    this._activeLoadToken = null;
  }

  /** Determine whether premium card should be blocked (unauthenticated cloud) */
  canPreviewCard(cardEl) {
    try {
      const source = cardEl.getAttribute('data-source') || '';
      const tier = cardEl.getAttribute('data-tier') || '';
      const downloaded = cardEl.getAttribute('data-cached') === 'true';
      if (source === 'cloud' && tier === 'premium' && !downloaded) {
        const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
        const authed = !!(auth && auth.authenticated && auth.state);
        return authed;
      }
    } catch (_) {}
    return true;
  }

  /** Core display routine shared by subclasses */
  async _show(mediaTriggerEl, cardEl) {
    if (!this._previewEl) return;
    try { Logger.debug('Preview.show', { file: cardEl?.getAttribute?.('data-filename') }); } catch (_) {}

    this._currentId++;
    const id = this._currentId;

    if (this._activeCard === cardEl && this._previewEl.style.display === 'block') {
      return;
    }
    this._activeCard = cardEl;

    this._activeMediaEl = this._imgEl;
    this._activeMediaKind = 'image';
    if (this._videoEl) {
      try { this._videoEl.pause(); } catch (_) {}
      try { this._videoEl.removeAttribute('src'); this._videoEl.load(); } catch (_) {}
      this._videoEl.style.display = 'none';
      this._videoEl.style.opacity = '0';
    }

    const loadToken = `${Date.now()}-${id}`;
    this._activeLoadToken = loadToken;
    try {
      if (this._imgEl) this._imgEl.dataset.previewLoadToken = loadToken;
      if (this._videoEl) this._videoEl.dataset.previewLoadToken = loadToken;
    } catch (_) {}

    const meta = this._collectCardInfo(cardEl);
    this._populateInfo(meta);
    this._preparePlaceholder(meta);

    this._previewEl.style.display = 'block';
    this._previewEl.classList.remove('visible');
    this._updateGridOverlay(cardEl, 0);

    if (this._posRaf) cancelAnimationFrame(this._posRaf);
    this._posRaf = requestAnimationFrame(() => {
      this._positionRelativeToCard(this._previewEl, cardEl);
      this._posRaf = null;
      this._showRaf = requestAnimationFrame(() => {
        if (this._currentId === id) this._previewEl.classList.add('visible');
        this._showRaf = null;
      });
    });

    let resolved = {};
    try {
      resolved = await this.resolveImageSource(cardEl, meta);
    } catch (e) {
      try { Logger.warn('Preview.resolve.error', { error: String(e?.message || e) }); } catch (_) {}
      resolved = {};
    }

    let url = resolved?.url ?? meta.currentUrl ?? meta.filePathAttr ?? '';
    const altText = resolved?.alt ?? meta.filename ?? '';
    const wantsVideo = this._isVideoMeta(meta, url);
    const useBlob = !wantsVideo && this.shouldUseBlobFetch(cardEl, meta, url);

    const finalizeAfterLoad = (mediaEl, metrics) => {
      if (this._currentId !== id || !mediaEl) return;
      const isVideo = mediaEl === this._videoEl;

      try { mediaEl.dataset.previewLoadToken = loadToken; }
      catch (_) {}

      const appliedMetrics = (metrics && typeof metrics === 'object' && (metrics.naturalWidth || metrics.naturalHeight))
        ? metrics
        : this._collectMediaMetrics(mediaEl);

      if (isVideo) {
        if (this._imgEl) {
          this._imgEl.style.opacity = '0';
          this._imgEl.style.display = 'none';
          try { this._imgEl.src = ''; } catch (_) {}
        }
        mediaEl.style.display = 'block';
      } else {
        if (this._videoEl && this._videoEl !== mediaEl) {
          try { this._videoEl.pause(); } catch (_) {}
          this._videoEl.style.display = 'none';
          this._videoEl.style.opacity = '0';
        }
        if (this._imgEl) this._imgEl.style.display = 'block';
      }

      try {
        mediaEl.style.objectFit = '';
        mediaEl.style.objectPosition = '';
      } catch (_) {}
      mediaEl.style.opacity = '0';

      this._activeMediaEl = mediaEl;
      this._activeMediaKind = isVideo ? 'video' : 'image';

      this._applyMediaSizing(mediaEl, appliedMetrics);
      mediaEl.style.opacity = '1';

      if (isVideo) {
        this._startPreviewVideo(mediaEl);
      }

      this._posRaf = requestAnimationFrame(() => {
        this._positionRelativeToCard(this._previewEl, cardEl);
        this._posRaf = null;
      });

      this._updateGridOverlay(cardEl, 0);
      this._updateMeta(cardEl, meta, appliedMetrics);
      this._maybeFetchSize(cardEl, meta, appliedMetrics);
      this.afterImageReady(cardEl, meta, appliedMetrics, { mediaEl, loadToken, url });

      try {
        if (this._imgResizeObserver) this._imgResizeObserver.disconnect();
        this._imgResizeObserver = new ResizeObserver(() => this._updateGridOverlay(cardEl, 0));
        this._imgResizeObserver.observe(mediaEl);
      } catch (_) {}
    };

    let mediaEl = null;
    let metrics = null;

    if (wantsVideo && this._videoEl && url) {
      try {
        await this._loadVideoMedia(url, id, altText);
        if (this._currentId === id) {
          mediaEl = this._videoEl;
          metrics = this._collectMediaMetrics(mediaEl);
        }
      } catch (e) {
        try { Logger.warn('Preview.video.error', { error: String(e?.message || e) }); } catch (_) {}
      }
    }

    if (!mediaEl && !wantsVideo) {
      try {
        const loadMetrics = useBlob && url
          ? await this._loadImageWithFetch(url, id, altText)
          : await this._loadImageWithImgSrc(url, id, altText);
        if (this._currentId === id) {
          mediaEl = this._imgEl;
          if (loadMetrics && loadMetrics.naturalWidth && loadMetrics.naturalHeight) {
            metrics = loadMetrics;
          } else {
            metrics = this._collectMediaMetrics(mediaEl);
          }
        }
      } catch (e) {
        try { Logger.warn('Preview.load.error', { error: String(e?.message || e) }); } catch (_) {}
      }
    }

    if (mediaEl) {
      finalizeAfterLoad(mediaEl, metrics || this._collectMediaMetrics(mediaEl));
    }
  }

  /** Extract commonly-used metadata from the card element */
  _collectCardInfo(cardEl) {
    const filename = cardEl.getAttribute('data-filename') || '';
    const filePathAttr = cardEl.getAttribute('data-file-path') || '';
    const pathAttr = cardEl.getAttribute('data-path') || '';
    const path = pathAttr || (filePathAttr && filePathAttr.includes('/') ? filePathAttr.split('/').slice(0, -1).join('/') : '');
    const widthAttr = cardEl.getAttribute('data-width') || '';
    const heightAttr = cardEl.getAttribute('data-height') || '';
    const gridWidthAttr = cardEl.getAttribute('data-grid-w') || '1';
    const gridHeightAttr = cardEl.getAttribute('data-grid-h') || '1';
    const scaleAttr = cardEl.getAttribute('data-scale') || '1x';
    const fileSizeAttr = cardEl.getAttribute('data-file-size') || '';
    const currentUrl = cardEl.getAttribute('data-url') || '';
    const source = cardEl.getAttribute('data-source') || '';
    const tier = cardEl.getAttribute('data-tier') || '';
    const downloaded = cardEl.getAttribute('data-cached') === 'true';
    const mediaType = cardEl.getAttribute('data-media-type') || '';
    return {
      filename,
      path,
      filePathAttr,
      widthAttr,
      heightAttr,
      gridWidthAttr,
      gridHeightAttr,
      scaleAttr,
      fileSizeAttr,
      currentUrl,
      source,
      tier,
      downloaded,
      mediaType
    };
  }

  /** Populate filename/path/meta placeholders prior to image load */
  _populateInfo(meta) {
    if (this._filenameEl) this._filenameEl.textContent = meta.filename;
    if (this._pathEl) this._pathEl.textContent = meta.path;
    this._updateMeta(null, meta, {});
  }

  /** Reserve layout space and display spinner */
  _preparePlaceholder(meta) {
    if (!this._imgEl) return;
    const numericWidth = parseFloat(String(meta.widthAttr).replace(/[^0-9.]/g, '')) || 0;
    const numericHeight = parseFloat(String(meta.heightAttr).replace(/[^0-9.]/g, '')) || 0;

    if (numericWidth > 0 && numericHeight > 0) {
      const viewportW = window.innerWidth || 1920;
      const viewportH = window.innerHeight || 1080;
      const maxW = Math.max(120, Math.min(600, Math.floor(viewportW * 0.45)));
      const maxH = Math.max(120, Math.min(600, Math.floor(viewportH * 0.9)));
      const scaleFactor = Math.min(1, maxW / numericWidth, maxH / numericHeight);
      const placeholderW = Math.max(1, Math.round(numericWidth * scaleFactor));
      this._imgEl.style.display = 'block';
      this._imgEl.style.aspectRatio = `${numericWidth} / ${numericHeight}`;
      this._imgEl.style.width = `${placeholderW}px`;
      this._imgEl.style.height = '';
      try {
        this._imgEl.removeAttribute('height');
        this._imgEl.setAttribute('width', String(placeholderW));
      } catch (_) {}
    } else {
      this._imgEl.style.display = 'block';
      this._imgEl.style.aspectRatio = '';
      this._imgEl.style.width = '';
      this._imgEl.style.height = '';
    }

    this._imgEl.style.opacity = '1';
    try {
      this._imgEl.style.objectFit = 'none';
      this._imgEl.style.objectPosition = 'center';
      const spinnerSvg = `<svg width="70" height="70" fill="hsl(0, 0.00%, 80.00%)" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="12" r="3" opacity="1"><animate id="spinner_qYjJ" begin="0;spinner_t4KZ.end-0.25s" attributeName="opacity" dur="0.75s" values="1;.2" fill="freeze"/></circle><circle cx="12" cy="12" r="3" opacity=".4"><animate begin="spinner_qYjJ.begin+0.15s" attributeName="opacity" dur="0.75s" values="1;.2" fill="freeze"/></circle><circle cx="20" cy="12" r="3" opacity=".3"><animate id="spinner_t4KZ" begin="spinner_qYjJ.begin+0.3s" attributeName="opacity" dur="0.75s" values="1;.2" fill="freeze"/></circle></svg>`;
      const spinnerDataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(spinnerSvg);
      this._imgEl.alt = 'Loading preview…';
      this._imgEl.src = spinnerDataUrl;
    } catch (_) {
      this._imgEl.src = '';
    }
  }

  /** Allow subclasses to resolve cloud URLs or adjust alt text */
  async resolveImageSource(_cardEl, meta) {
    return { url: meta.currentUrl, alt: meta.filename };
  }

  _isVideoMeta(meta, url = '') {
    if (!meta) return false;
    const mediaAttr = String(meta.mediaType || '').toLowerCase();
    if (mediaAttr === 'video') return true;
    const combined = [meta.filename, meta.filePathAttr, meta.currentUrl, url]
      .filter(Boolean)
      .join('|')
      .toLowerCase();
    return /\.(webm|mp4|m4v|mov|ogg)$/i.test(combined);
  }

  _collectMediaMetrics(el) {
    if (!el) return { naturalWidth: 0, naturalHeight: 0 };
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'video') {
      return {
        naturalWidth: el.videoWidth || 0,
        naturalHeight: el.videoHeight || 0
      };
    }
    return {
      naturalWidth: el.naturalWidth || el.width || 0,
      naturalHeight: el.naturalHeight || el.height || 0
    };
  }

  /** Determine whether to fetch image via blob (premium cloud scenario) */
  shouldUseBlobFetch(cardEl, meta, url) {
    if (!url) return false;
    const source = meta?.source || cardEl.getAttribute('data-source') || '';
    const tier = meta?.tier || cardEl.getAttribute('data-tier') || '';
    const downloaded = meta?.downloaded ?? (cardEl.getAttribute('data-cached') === 'true');
    if (source === 'cloud' && tier === 'premium' && !downloaded) {
      return true;
    }
    return false;
  }

  /** Resize loaded media to fit viewport while maintaining ratio */
  _applyMediaSizing(mediaEl, metrics) {
    const el = mediaEl || this._activeMediaEl || this._imgEl;
    if (!el) return;
    const { naturalWidth, naturalHeight } = metrics || {};
    if (naturalWidth > 0 && naturalHeight > 0) {
      const viewportW = window.innerWidth || 1920;
      const viewportH = window.innerHeight || 1080;
      const maxW = Math.max(120, Math.min(600, Math.floor(viewportW * 0.45)));
      const maxH = Math.max(120, Math.min(600, Math.floor(viewportH * 0.9)));
      const scaleFactor = Math.min(1, maxW / naturalWidth, maxH / naturalHeight);
      const targetW = Math.max(1, Math.round(naturalWidth * scaleFactor));
      el.style.width = `${targetW}px`;
      el.style.height = '';
      el.style.aspectRatio = `${naturalWidth} / ${naturalHeight}`;
      try {
        el.setAttribute('width', String(targetW));
        el.removeAttribute('height');
      } catch (_) {}
    } else {
      el.style.width = '';
      el.style.height = '';
      el.style.aspectRatio = '';
      try {
        el.removeAttribute('width');
        el.removeAttribute('height');
      } catch (_) {}
    }
  }

  /** Update meta text shown under preview (subclasses may override) */
  _updateMeta(_cardEl, meta, metrics = {}) {
    if (!this._dimsEl) return;
    const width = metrics.naturalWidth || parseFloat(String(meta.widthAttr).replace(/[^0-9.]/g, '')) || '';
    const height = metrics.naturalHeight || parseFloat(String(meta.heightAttr).replace(/[^0-9.]/g, '')) || '';
    const gridWidth = parseFloat(String(meta.gridWidthAttr)) || 1;
    const gridHeight = parseFloat(String(meta.gridHeightAttr)) || 1;
    let text = '';
    if (width && height) text += `${Math.round(width)}×${Math.round(height)}px`;
    text += `${text ? ' ' : ''}( ${gridWidth}×${gridHeight} grid )`;
    const fileSizeAttr = meta.fileSizeAttr;
    if (fileSizeAttr && fileSizeAttr !== '0') {
      const bytes = Number(fileSizeAttr);
      const human = Number.isFinite(bytes) && bytes > 0 ? this._formatBytes(bytes) : fileSizeAttr;
      text += ` - ${human}`;
    }
    this._dimsEl.textContent = text;
  }

  /** Hook for subclasses to fetch missing file size (no-op by default) */
  // eslint-disable-next-line no-unused-vars
  _maybeFetchSize(_cardEl, _meta, _metrics) {}

  /** Hook for subclasses to run custom logic once image is visible */
  // eslint-disable-next-line no-unused-vars
  afterImageReady(_cardEl, _meta, _metrics, _context) {}

  _updateGridOverlay(cardEl, attempt = 0) {
    try {
      if (this._overlayRaf) {
        cancelAnimationFrame(this._overlayRaf);
        this._overlayRaf = null;
      }
      this._overlayRaf = requestAnimationFrame(() => {
        const mediaEl = this._activeMediaEl || this._imgEl || this._videoEl;
        const imageRect = mediaEl?.getBoundingClientRect?.();
        if (!imageRect || imageRect.width < 2 || imageRect.height < 2) {
          if (attempt < 5) this._updateGridOverlay(cardEl, attempt + 1);
          return;
        }
        const gw = parseFloat(cardEl.getAttribute('data-grid-w') || '1') || 1;
        const gh = parseFloat(cardEl.getAttribute('data-grid-h') || '1') || 1;
        const scAttr = cardEl.getAttribute('data-scale') || '1';
        const sc = parseFloat(String(scAttr).replace(/x$/i, '')) || 1;
        const visualW = gw * sc;
        const visualH = gh * sc;
        const gridSizeX = imageRect.width / visualW;
        const gridSizeY = imageRect.height / visualH;
        const gridSize = Math.max(1, Math.min(gridSizeX, gridSizeY));
        const offsetX = ((visualW - gw) / 2) * gridSize;
        const offsetY = ((visualH - gh) / 2) * gridSize;
        if (!mediaEl) return;
        mediaEl.style.backgroundImage = 'linear-gradient(to right, rgba(255,255,255,0.15) 1px, transparent 1px),linear-gradient(to bottom, rgba(255,255,255,0.15) 1px, transparent 1px)';
        mediaEl.style.backgroundSize = `${gridSize}px ${gridSize}px`;
        mediaEl.style.backgroundPosition = `${offsetX}px ${offsetY}px`;
        mediaEl.style.boxShadow = 'inset 1px 0 0 rgba(255,255,255,0.15), inset 0 1px 0 rgba(255,255,255,0.15), inset -1px 0 0 rgba(255,255,255,0.15), inset 0 -1px 0 rgba(255,255,255,0.15)';
      });
    } catch (_) {}
  }

  _startPreviewVideo(videoEl) {
    if (!videoEl) return;
    try { videoEl.loop = true; } catch (_) {}
    try { videoEl.muted = true; videoEl.defaultMuted = true; } catch (_) {}
    const attemptPlay = () => {
      try { videoEl.currentTime = 0; } catch (_) {}
      try {
        const playResult = videoEl.play?.();
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch((error) => {
            try { Logger.warn('Preview.video.play.failed', { error: String(error?.message || error) }); } catch (_) {}
          });
        }
      } catch (error) {
        try { Logger.warn('Preview.video.play.error', { error: String(error?.message || error) }); } catch (_) {}
      }
    };

    if (videoEl.readyState >= 2) {
      attemptPlay();
      return;
    }

    const onReady = () => {
      try { videoEl.removeEventListener('loadeddata', onReady); } catch (_) {}
      attemptPlay();
    };
    try { videoEl.addEventListener('loadeddata', onReady, { once: true }); }
    catch (_) { attemptPlay(); }
  }

  /** Load video element and wait for first frame */
  async _loadVideoMedia(url, id, alt = '') {
    if (!url || !this._videoEl) return;
    if (this._currentId !== id) return;
    const video = this._videoEl;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        try { video.removeEventListener('loadeddata', onLoaded); } catch (_) {}
        try { video.removeEventListener('error', onError); } catch (_) {}
      };
      const onLoaded = () => {
        cleanup();
        try { video.currentTime = 0; } catch (_) {}
        resolve();
      };
      const onError = (e) => {
        cleanup();
        reject(e);
      };
      if (this._currentId !== id) {
        cleanup();
        resolve();
        return;
      }
      try { video.addEventListener('loadeddata', onLoaded); } catch (_) {}
      try { video.addEventListener('error', onError); } catch (_) {}
      video.style.display = 'block';
      video.style.opacity = '0';
      try { video.setAttribute('aria-label', alt || 'Preview video'); } catch (_) {}
      try { video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); } catch (_) {}
      try { video.crossOrigin = 'anonymous'; } catch (_) {}
      try {
        if (video.src) {
          video.removeAttribute('src');
          video.load();
        }
      } catch (_) {}
      video.src = url;
      try { video.load(); } catch (_) {}
    });
  }

  /** Fetch image via blob -> object URL to avoid CORS cache issues */
  async _loadImageWithFetch(url, id, alt = '') {
    if (!url) return null;
    if (this._currentId !== id) return null;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Preview fetch failed: ${res.status}`);
    if (this._currentId !== id) return null;
    const blob = await res.blob();
    const metrics = await this._measureImageBlob(blob);
    const objectURL = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      const onLoad = () => { cleanupListeners(); resolve(); };
      const onError = (e) => { cleanupListeners(); reject(e); };
      const cleanupListeners = () => {
        try { URL.revokeObjectURL(objectURL); } catch (_) {}
        if (!this._imgEl) return;
        this._imgEl.removeEventListener('load', onLoad);
        this._imgEl.removeEventListener('error', onError);
      };
      if (this._currentId !== id) {
        cleanupListeners();
        resolve();
        return;
      }
      if (!this._imgEl) { cleanupListeners(); resolve(); return; }
      this._imgEl.addEventListener('load', onLoad);
      this._imgEl.addEventListener('error', onError);
      this._imgEl.alt = alt;
      this._imgEl.src = objectURL;
    });
    return metrics;
  }

  async _measureImageBlob(blob) {
    if (!blob) return null;
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob);
        const dims = {
          naturalWidth: bitmap.width || 0,
          naturalHeight: bitmap.height || 0
        };
        try { bitmap.close?.(); } catch (_) {}
        return dims;
      } catch (_) {}
    }

    return new Promise((resolve) => {
      const probe = new Image();
      let tempUrl = '';
      const cleanup = () => {
        try {
          if (tempUrl) URL.revokeObjectURL(tempUrl);
        } catch (_) {}
        probe.onload = null;
        probe.onerror = null;
      };
      probe.onload = () => {
        const dims = {
          naturalWidth: probe.naturalWidth || probe.width || 0,
          naturalHeight: probe.naturalHeight || probe.height || 0
        };
        cleanup();
        resolve(dims);
      };
      probe.onerror = () => {
        cleanup();
        resolve(null);
      };
      try {
        tempUrl = URL.createObjectURL(blob);
        probe.src = tempUrl;
      } catch (_) {
        cleanup();
        resolve(null);
      }
    });
  }

  /** Load image via direct src assignment with load/error guards */
  async _loadImageWithImgSrc(url, id, alt = '') {
    const metrics = await new Promise((resolve, reject) => {
      if (!this._imgEl) { resolve(null); return; }
      if (!url) {
        this._imgEl.alt = alt;
        this._imgEl.src = '';
        resolve(null);
        return;
      }
      const loader = new Image();
      const cleanupLoader = () => {
        loader.onload = null;
        loader.onerror = null;
      };
      loader.onload = () => {
        const dims = {
          naturalWidth: loader.naturalWidth || loader.width || 0,
          naturalHeight: loader.naturalHeight || loader.height || 0
        };
        try {
          if (this._currentId !== id || !this._imgEl) { cleanupLoader(); resolve(dims); return; }
          this._imgEl.src = '';
          this._imgEl.alt = alt;
          this._imgEl.src = url;
        } finally {
          cleanupLoader();
          resolve(dims);
        }
      };
      loader.onerror = (e) => {
        cleanupLoader();
        reject(e);
      };
      try { loader.crossOrigin = 'anonymous'; } catch (_) {}
      loader.src = url;
    });
    return metrics;
  }

  _formatBytes(bytes) {
    const thresh = 1024;
    if (!Number.isFinite(bytes)) return String(bytes);
    if (Math.abs(bytes) < thresh) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let u = -1;
    let value = bytes;
    do {
      value /= thresh;
      ++u;
    } while (Math.abs(value) >= thresh && u < units.length - 1);
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[u]}`;
  }

  _positionRelativeToCard(preview, card) {
    if (!preview || !card) return;
    const rect = card.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const pRect = preview.getBoundingClientRect();

    let left = rect.right + 10;
    let top = rect.top;
    if (left + pRect.width > viewportW - 10) left = rect.left - pRect.width - 10;
    if (left < 10) left = Math.max(10, (viewportW - pRect.width) / 2);
    if (top + pRect.height > viewportH - 10) top = Math.max(10, viewportH - pRect.height - 10);
    left = Math.max(10, Math.min(left, viewportW - pRect.width - 10));
    top = Math.max(10, Math.min(top, viewportH - pRect.height - 10));
    preview.style.left = `${left}px`;
    preview.style.top = `${top}px`;
  }

  _setTimeout(fn, ms) {
    if (this._eventManager && typeof this._eventManager.setTimeout === 'function') {
      return this._eventManager.setTimeout(fn, ms);
    }
    return setTimeout(fn, ms);
  }

  _clearTimeout(id) {
    if (this._eventManager && typeof this._eventManager.clearTimeout === 'function') {
      this._eventManager.clearTimeout(id);
      return;
    }
    clearTimeout(id);
  }
}
