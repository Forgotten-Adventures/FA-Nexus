/**
 * TokenDragDropManager (Foundry DragDrop Edition)
 * Uses foundry.applications.ux.DragDrop to handle drag starts from grid cards.
 * The dragstart callback returns a data object which DragDrop attaches to DataTransfer.
 */

import { ActorFactory } from './actor-factory.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { PlacementOverlay, createPlacementSpinner } from '../core/placement/placement-overlay.js';

const TOKEN_PREVIEW_Z_INDEX = 30; // Keep queued previews under FA Nexus UI chrome

export class TokenDragDropManager {
  // Track window transparency state across overlapping drags
  static _transparencyLocks = 0;
  static _pendingTransparentTimeout = null;
  static _pendingRestoreTimeout = null;
  // Suppress hover previews while a drag is being armed or active
  static _suppressHoverPreviews = false;
  static setHoverSuppressed(suppress) { try { TokenDragDropManager._suppressHoverPreviews = !!suppress; } catch (_) {} }
  static isHoverSuppressed() { return !!TokenDragDropManager._suppressHoverPreviews; }

  /**
   * @param {HTMLElement} gridElement - The scrollable grid container
   * @param {ApplicationV2|null} [app] - Optional parent app to resolve services from
   */
  constructor(gridElement, app = null) {
    this.grid = gridElement;
    this.app = app;
    this._dragDrop = null;
    this._rebindRaf = null;
    this._boundMouseDownHandler = null;
    this._boundDragEndHandler = null;
    this._lastCanvasScale = null;
  }

  /** Public: Preload drag preview canvas for a given card (called on hover) */
  async preloadForCard(cardElement) {
    try {
      const source = cardElement.getAttribute('data-source') || '';
      const downloaded = (cardElement.getAttribute('data-cached') === 'true') || false;
      if (source === 'cloud' && !downloaded) return;
      if (!cardElement || !this.grid?.contains(cardElement)) return;
      await this._preloadDragCanvas(cardElement);
    } catch (_) {}
  }

  /** Bind Foundry DragDrop to the grid */
  initialize() {
    if (!this.grid) return;
    
    // Setup mousedown preloading and drag event listeners
    this._setupDragEventListeners();
    
    // Initialize canvas scale tracking
    this._lastCanvasScale = canvas?.stage?.scale?.x || 1;
    
    // No native DragDrop binding necessary with unified queued drag
  }

  /** Cleanup resources and unbind listeners */
  destroy() {
    this._cleanupDragEventListeners();
    try { this._dragDrop?.unbind?.(); } catch (_) {}
    this._dragDrop = null;
    if (this._rebindRaf) { cancelAnimationFrame(this._rebindRaf); this._rebindRaf = null; }
  }

  /**
   * Schedule a DragDrop.bind against the grid so newly mounted cards are bound.
   */
  scheduleRebind() {
    if (!this.grid || !this._dragDrop) return;
    if (this._rebindRaf) cancelAnimationFrame(this._rebindRaf);
    this._rebindRaf = requestAnimationFrame(() => {
      this._rebindRaf = null;
      try { this._dragDrop.bind(this.grid); } catch (_) {}
    });
  }

  /**
   * Back-compat: called from onMountItem; just schedule a rebind
   * @param {HTMLElement} _card
   */
  enableForCard(_card) { this.scheduleRebind(); }

  /** Back-compat: schedule a rebind after data changes */
  refreshForMountedCards() { this.scheduleRebind(); }

  /**
   * Setup mousedown event listener for drag preloading
   */
  _setupDragEventListeners() {
    this._cleanupDragEventListeners();
    
    this._boundMouseDownHandler = async (event) => {
      Logger.info('TokenDragDropManager._boundMouseDownHandler', { event });
      // Only respond to left-click (button 0). Right-click opens variants.
      if (event.button !== 0) return;
      const card = event.target?.closest('.fa-nexus-card');
      if (!card || !this.grid.contains(card)) return;
      // Start pre-downloading cloud token to local so dragstart is fast
      try { await this._prepareCloudForDrag(card); } catch (_) {}
      // No need to track last mouse pos for native drag; unified queued drag will use live coords

      // Arm a queued drag on movement for all eligible cards (except locked premium)
      const isCloud = (card.getAttribute('data-source') || '') === 'cloud';
      const tier = card.getAttribute('data-tier') || '';
      let authed = false; try { const auth = game.settings.get('fa-nexus', 'patreon_auth_data'); authed = !!(auth && auth.authenticated && auth.state); } catch(_) {}
      const downloaded = (card.getAttribute('data-cached') === 'true') || false;
      const lockedPremium = (tier === 'premium' && !authed && !downloaded);
      if (!lockedPremium) {
        const startX = event.clientX, startY = event.clientY;
        const threshold = 4;
        const move = (ev) => {
          const dx = Math.abs((ev.clientX||0) - startX);
          const dy = Math.abs((ev.clientY||0) - startY);
          if (dx + dy > threshold) {
            // Suppress hover previews immediately while we arm a queued drag
            try { TokenDragDropManager.setHoverSuppressed(true); } catch (_) {}
            document.removeEventListener('mousemove', move, true);
            document.removeEventListener('mouseup', up, true);
            const x = ev.clientX, y = ev.clientY;
            this._startQueuedDrag(card, x, y);
          }
        };
        const up = () => {
          document.removeEventListener('mousemove', move, true);
          document.removeEventListener('mouseup', up, true);
        };
        document.addEventListener('mousemove', move, true);
        document.addEventListener('mouseup', up, true);
      }
    };
    
    // Remove native dragend listeners; queued drag handles its own cleanup
    this._boundDragEndHandler = null;
    
    document.addEventListener('mousedown', this._boundMouseDownHandler, { capture: true });
  }

  async _prepareCloudForDrag(card) {
    try {
      const source = card.getAttribute('data-source') || '';
      const tier = card.getAttribute('data-tier') || '';
      if (source !== 'cloud') return;
      const filename = card.getAttribute('data-filename') || '';
      const filePath = card.getAttribute('data-url') || card.getAttribute('data-path') || '';
      const app = this.app || foundry.applications.instances.get('fa-nexus-app');
      const svc = app?._contentService; const dl = app?._downloadManager;
      if (!svc || !dl) return;
      const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
      if (tier === 'premium' && (!auth || !auth.authenticated || !auth.state)) return;
      const downloaded = (card.getAttribute('data-cached') === 'true') || false;
      Logger.info('TokenDrag.cloudprep.downloaded', { downloaded, tier });
      if (tier === 'premium' && downloaded) return; // do not prompt; dragstart will handle
      const item = { file_path: filePath, filename, tier };
      // Kick off ensureLocal early and cache the promise
      const p = (async () => {
        try {
          const fullUrl = await svc.getFullURL('tokens', item, auth?.state);
          const local = await dl.ensureLocal('tokens', item, fullUrl);
          // Update card attribute so dragstart can read it immediately
          try { card.setAttribute('data-url', local); } catch (_) {}
          card._resolvedLocalPath = local;
          card._ensureLocalReady = true;
          try { card.setAttribute('data-cached', 'true'); } catch (_) {}
          // Update status icon to indicate cached/local
          try {
            const statusIcon = card.querySelector('.fa-nexus-status-icon');
            if (statusIcon) {
              statusIcon.classList.remove('cloud-plus', 'cloud');
              statusIcon.classList.add('cloud','cached');
              statusIcon.title = 'Downloaded';
              statusIcon.innerHTML = '<i class="fas fa-cloud-check"></i>';
            }
          } catch (_) {}
          // No need to enable native draggable; unified queued drag handles all sources
          Logger.info('TokenDrag.prep.localReady', { filename });
          return local;
        } catch (e) {
          Logger.warn('TokenDrag.prep.failed', String(e?.message||e));
          throw e;
        }
      })();
      card._ensureLocalPromise = p;
      await Promise.race([p, new Promise(r => setTimeout(r, 10))]); // yield quickly; don't block mousedown
    } catch (_) {}
  }

  async _createQueuedPreview(card, cursorX, cursorY) {
    return TokenDragDropManager.createPreviewForCard(card, { cursorX, cursorY });
  }

  static createPreviewForCard(card, { cursorX, cursorY, deferImage = false } = {}) {
    const sizeInfo = TokenDragDropManager._readSizeInfoFromCard(card);
    const gridSize = canvas?.scene?.grid?.size || 100;
    const zoom = canvas?.stage?.scale?.x || 1;
    const pointer = (Number.isFinite(cursorX) && Number.isFinite(cursorY)) ? { x: cursorX, y: cursorY } : null;
    const worldWidth = Math.max(8, (sizeInfo?.gridWidth || 1) * gridSize * (sizeInfo?.scale || 1));
    const worldHeight = Math.max(8, (sizeInfo?.gridHeight || 1) * gridSize * (sizeInfo?.scale || 1));

    let loadingDiv = null;
    let img = null;

    const source = (card?.getAttribute?.('data-source') || '').toLowerCase();
    const isCloudSource = source === 'cloud';
    const isCached = card?.getAttribute?.('data-cached') === 'true';
    const spinnerNeeded = !!deferImage || !!card?._ensureLocalPromise || (isCloudSource && !isCached);

    const overlay = new PlacementOverlay({
      className: 'fa-nexus-queued-drag',
      pointer,
      worldWidth,
      worldHeight,
      zIndex: TOKEN_PREVIEW_Z_INDEX,
      onSizeChange: (screenWidth, screenHeight) => {
        if (loadingDiv) {
          loadingDiv.style.width = `${screenWidth}px`;
          loadingDiv.style.height = `${screenHeight}px`;
        }
        if (img) {
          img._nexusOrigW = screenWidth;
          img._nexusOrigH = screenHeight;
          img.style.width = `${screenWidth}px`;
          img.style.height = `${screenHeight}px`;
        }
      }
    });

    overlay.element.style.transformOrigin = 'center center';
    overlay.content.style.position = 'relative';
    overlay.content.style.transformOrigin = 'center center';

    if (spinnerNeeded) {
      loadingDiv = createPlacementSpinner();
      loadingDiv.classList.add('fa-nexus-loading-preview');
      loadingDiv.style.width = '100%';
      loadingDiv.style.height = '100%';
      loadingDiv.style.transformOrigin = 'center center';
      loadingDiv.style.transform = 'scale(1)';
      loadingDiv.style.transition = 'transform 120ms ease-out';
      loadingDiv.style.willChange = 'transform';
      overlay.content.appendChild(loadingDiv);
    }

    img = document.createElement('img');
    img.alt = card.getAttribute('data-filename') || '';
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;max-width:none !important;max-height:none !important;';
    img._nexusOrigW = Math.round(worldWidth * zoom);
    img._nexusOrigH = Math.round(worldHeight * zoom);
    img.style.transformOrigin = 'center center';
    img.style.transform = 'scale(1)';
    img.style.transition = 'transform 120ms ease-out';
    img.style.willChange = 'transform';
    img.style.display = spinnerNeeded ? 'none' : 'block';
    img.style.opacity = spinnerNeeded ? '0' : '1';
    overlay.content.appendChild(img);

    const preview = {
      overlay,
      box: overlay.element,
      img,
      loadingDiv,
      sizeInfo,
      _manualScale: 1,
      _rotation: 0,
      _mirrorX: false,
      _mirrorY: false,
      _deferredImage: !!deferImage
    };

    TokenDragDropManager._applyZoomToPreview(preview, zoom);
    TokenDragDropManager._updatePreviewTransform(preview);
    TokenDragDropManager._startPreviewZoomTracking(preview);
    TokenDragDropManager._applyImageTransform(preview);
    if (!deferImage) {
      TokenDragDropManager._loadPreviewImageForCard(card, img, loadingDiv);
    }

    return preview;
  }

  static _readSizeInfoFromCard(card) {
    const gridWidth = parseFloat(card.getAttribute('data-grid-w') || '1') || 1;
    const gridHeight = parseFloat(card.getAttribute('data-grid-h') || '1') || 1;
    const scaleAttr = card.getAttribute('data-scale') || '1x';
    const scale = typeof scaleAttr === 'string' && scaleAttr.endsWith('x') ? Number(scaleAttr.replace('x', '')) : Number(scaleAttr) || 1;
    return { gridWidth, gridHeight, scale };
  }

  static async _loadPreviewImageForCard(card, img, loadingDiv) {
    try {
      const looksLikeFile = (p) => /\.(webp|png|jpg|jpeg|gif|svg)$/i.test(String(p || ''));
      let localPath = card._resolvedLocalPath || '';
      if (!localPath) {
        const urlAttr = card.getAttribute('data-url') || '';
        const pathAttr = card.getAttribute('data-path') || '';
        localPath = looksLikeFile(urlAttr) ? urlAttr : (looksLikeFile(pathAttr) ? pathAttr : (urlAttr || pathAttr));
      }
      if (card._ensureLocalPromise) {
        try { localPath = await card._ensureLocalPromise; } catch (_) {}
      }
      try {
        const filename = card.getAttribute('data-filename') || '';
        if ((!localPath || !looksLikeFile(localPath)) && filename) {
          const base = card.getAttribute('data-path') || card.getAttribute('data-url') || '';
          if (base) {
            const sep = base.endsWith('/') ? '' : '/';
            localPath = `${base}${sep}${filename}`;
          }
        }
      } catch (_) {}
      Logger.info('TokenDrag.preview.localPath', { localPath, card });

      if (localPath) {
        img.src = localPath;
        Logger.info('TokenDrag.preview.src', { src: img.src, card });
      } else {
        const thumb = card.querySelector('img');
        if (thumb && thumb.src) img.src = thumb.src;
        Logger.warn('TokenDrag.preview.no-src', { card });
      }

      if (img.src) {
        if (!(img.complete && img.naturalWidth > 0)) {
          await new Promise((resolve, reject) => {
            const done = () => {
              img.onload = null;
              img.onerror = null;
            };
            img.onload = () => { done(); resolve(); };
            img.onerror = (ev) => { done(); reject(ev instanceof Error ? ev : new Error('Image load failed')); };
            setTimeout(() => {
              done();
              reject(new Error('Image load timeout'));
            }, 3000);
          });
        }
        img.style.display = 'block';
        img.style.opacity = '1';
        if (loadingDiv) loadingDiv.style.display = 'none';
        Logger.info('TokenDrag.preview.imageLoaded', { src: img.src });
      } else {
        Logger.warn('TokenDrag.preview.noImageSource', { card });
      }
    } catch (error) {
      Logger.warn('TokenDrag.preview.imageLoadFailed', { error: error.message, card });
    }
  }

  static _applyZoomToPreview(preview, zoomLevel) {
    try {
      if (!preview || !preview.overlay) return;
      const gridSize = canvas?.scene?.grid?.size || 100;
      const { gridWidth = 1, gridHeight = 1, scale = 1 } = preview.sizeInfo || {};
      const worldWidth = Math.max(0.01, gridWidth * gridSize * scale);
      const worldHeight = Math.max(0.01, gridHeight * gridSize * scale);
      const zoom = Number(zoomLevel) || Number(canvas?.stage?.scale?.x || 1) || 1;
      const w = Math.max(8, Math.round(worldWidth * zoom));
      const h = Math.max(8, Math.round(worldHeight * zoom));
      preview._baseWidth = w;
      preview._baseHeight = h;
      if (preview.box) {
        preview.box.style.width = `${w}px`;
        preview.box.style.height = `${h}px`;
      }
      preview.overlay.setWorldSize(worldWidth, worldHeight, { trackZoom: true });
      if (preview.img) {
        preview.img._nexusOrigW = w;
        preview.img._nexusOrigH = h;
        preview.img.style.width = `${w}px`;
        preview.img.style.height = `${h}px`;
      }
      if (preview.loadingDiv) {
      preview.loadingDiv.style.width = `${w}px`;
      preview.loadingDiv.style.height = `${h}px`;
    }
    preview._lastZoom = zoomLevel;
    TokenDragDropManager._applyImageTransform(preview);
    TokenDragDropManager._updatePreviewTransform(preview);
  } catch (_) {}
}

  static _startPreviewZoomTracking(preview) {
    if (!preview?.overlay) return;
    preview._lastZoom = canvas?.stage?.scale?.x || 1;
    preview.overlay.startZoomTracking?.();
  }

  static _stopPreviewZoomTracking(preview) {
    try { preview?.overlay?.stopZoomTracking?.(); }
    catch (_) {}
  }

  static _maybeAdjustPreviewForActorsSidebar(preview, clientX) {
    try {
      if (!preview?.img) return;
      const sidebarContent = document.querySelector('#sidebar-content');
      const actorsExpanded = !!(sidebarContent && sidebarContent.classList.contains('active-actors') && sidebarContent.classList.contains('expanded'));
      if (!actorsExpanded) {
        TokenDragDropManager._resetPreviewSize(preview);
        return;
      }
      const sidebar = document.querySelector('#sidebar');
      const reservedRight = sidebar?.getBoundingClientRect()?.width || 0;
      const viewportW = window.innerWidth;
      const maxRight = viewportW - reservedRight - 10;
      const origW = preview._baseWidth || preview.img._nexusOrigW || preview.img.offsetWidth || 0;
      if (!origW) return;
      const cursorTooClose = clientX > maxRight - 20;
      if (cursorTooClose) {
        const allowableHalf = Math.max(40, maxRight - clientX);
        const scale = Math.max(0.2, Math.min(1, (allowableHalf * 2) / origW));
        TokenDragDropManager._setPreviewScale(preview, scale);
      } else {
        TokenDragDropManager._setPreviewScale(preview, 1);
      }
    } catch (_) {}
  }

  static _resetPreviewSize(preview) {
    try {
      if (!preview?.img) return;
      const origW = preview._baseWidth || preview.img._nexusOrigW || preview.img.offsetWidth || 0;
      const origH = preview._baseHeight || preview.img._nexusOrigH || preview.img.offsetHeight || 0;
      if (!origW || !origH) return;
      preview.img._nexusOrigW = origW;
      preview.img._nexusOrigH = origH;
      preview.box.style.width = `${origW}px`;
      preview.box.style.height = `${origH}px`;
      preview.img.style.width = `${origW}px`;
      preview.img.style.height = `${origH}px`;
      if (preview.loadingDiv && preview.loadingDiv.style.display !== 'none') {
        preview.loadingDiv.style.width = `${origW}px`;
        preview.loadingDiv.style.height = `${origH}px`;
      }
      TokenDragDropManager._setPreviewScale(preview, 1);
    } catch (_) {}
  }

  static _setPreviewScale(preview, scale) {
    if (!preview) return;
    const clamped = Math.max(0.2, Math.min(1, Number(scale) || 1));
    if (Math.abs((preview._manualScale ?? 1) - clamped) < 1e-4) return;
    preview._manualScale = clamped;
    const img = preview.img;
    TokenDragDropManager._applyImageTransform(preview);
    const loading = preview.loadingDiv;
    if (loading) {
      loading.style.transformOrigin = 'center center';
      loading.style.transform = `scale(${clamped})`;
    }
    TokenDragDropManager._updatePreviewTransform(preview);
  }

  static setPreviewMirror(preview, { mirrorX = false, mirrorY = false, force = false } = {}) {
    if (!preview) return;
    const nextX = !!mirrorX;
    const nextY = !!mirrorY;
    const changed = force || preview._mirrorX !== nextX || preview._mirrorY !== nextY;
    if (!changed) return;
    preview._mirrorX = nextX;
    preview._mirrorY = nextY;
    TokenDragDropManager._applyImageTransform(preview);
  }

  static _applyImageTransform(preview) {
    try {
      if (!preview?.img) return;
      const scale = Number(preview._manualScale ?? 1) || 1;
      const sx = scale * (preview._mirrorX ? -1 : 1);
      const sy = scale * (preview._mirrorY ? -1 : 1);
      preview.img.style.transformOrigin = 'center center';
      preview.img.style.transform = `scale(${sx}, ${sy})`;
    } catch (_) {}
  }

  static _updatePreviewTransform(preview) {
    try {
      if (!preview?.box) return;
      const rotation = Number(preview._rotation || 0);
      let transform = 'translate(-50%, -50%)';
      if (rotation) transform += ` rotate(${rotation}deg)`;
      preview.box.style.transform = transform;
    } catch (_) {}
  }

  _cleanupQueuedDrag() {
    const q = this._activeQueuedDrag;
    if (!q) return;
    try {
      TokenDragDropManager.setHoverSuppressed(false);
      document.removeEventListener('mousemove', q.handlers.mousemove, true);
      document.removeEventListener('mouseup', q.handlers.mouseup, true);
      document.removeEventListener('keydown', q.handlers.keydown, true);
    } catch (_) {}
    try { TokenDragDropManager._stopPreviewZoomTracking(q.preview); } catch (_) {}
    try { q.preview?.overlay?.destroy?.(); } catch (_) {}
    try { q.preview?.box?.remove?.(); } catch (_) {}
    // Remove any lingering actor highlight from queued drag
    try { document.querySelectorAll('.actor-drop-target').forEach(el => el.classList.remove('actor-drop-target')); } catch (_) {}
    this._activeQueuedDrag = null;
    // Restore window transparency similar to normal drag end
    try { setTimeout(() => { TokenDragDropManager._setWindowTransparency(false); }, 400); } catch (_) {}
  }

  async _startQueuedDrag(card, startX, startY) {
    if (this._activeQueuedDrag) { this._cleanupQueuedDrag(); }
    // Hide any visible hover preview immediately
    try {
      const app = foundry.applications.instances.get('fa-nexus-app');
      if (app && app._tokenPreview && typeof app._tokenPreview.hidePreview === 'function') { app._tokenPreview.hidePreview(); }
      else { const existing = document.querySelector('.fa-nexus-hover-preview'); if (existing) existing.style.display = 'none'; }
    } catch (_) {}
    // Mirror normal drag UX: dim window and hide color variants panel
    try { TokenDragDropManager._setWindowTransparency(true); } catch (_) {}
    try {
      const app = foundry.applications.instances.get('fa-nexus-app');
      if (app && typeof app._hideColorVariantsPanel === 'function') {
        setTimeout(() => { try { app._hideColorVariantsPanel(); } catch (_) {} }, 150);
      }
    } catch (_) {}
    const preview = await this._createQueuedPreview(card, startX, startY);
    // Track hovered actor element for queued drag (non-native drag)
    const actorSelector = '.directory-item.actor, .document[data-document-type="Actor"], [data-document-type="Actor"][data-entry-id], [data-document-id][data-document-type="Actor"], .document.actor';
    let highlightedActorEl = null;
    const handleQueuedMove = (ev) => {
      const x = ev.clientX, y = ev.clientY;
      preview.box.style.left = `${x}px`;
      preview.box.style.top = `${y}px`;
      try { preview?.overlay?.updatePointer?.(x, y); } catch (_) {}
      TokenDragDropManager._maybeAdjustPreviewForActorsSidebar(preview, x);
      // Highlight valid actor under cursor during queued drag
      try {
        const under = document.elementFromPoint(x, y);
        const candidate = under?.closest?.(actorSelector);
        const isFolder = candidate && (candidate.classList?.contains('folder') || candidate.getAttribute?.('data-document-type') === 'Folder');
        const actorEl = (!isFolder && candidate) ? candidate : null;
        if (actorEl !== highlightedActorEl) {
          if (highlightedActorEl) highlightedActorEl.classList.remove('actor-drop-target');
          if (actorEl) actorEl.classList.add('actor-drop-target');
          highlightedActorEl = actorEl;
        }
      } catch (_) {}
    };
    const handleQueuedMouseUp = async (ev) => {
      // Check if this is a right-click - if so, cancel the drag
      if (ev.button === 2) {
        this._cleanupQueuedDrag();
        return;
      }
      
      // On mouseup, try to complete the download and place on canvas
      try {
        const filename = card.getAttribute('data-filename') || '';
        const gridWidth = parseInt(card.getAttribute('data-grid-w') || '1', 10) || 1;
        const gridHeight = parseInt(card.getAttribute('data-grid-h') || '1', 10) || 1;
        const scaleAttr = card.getAttribute('data-scale') || '1x';
        const scale = typeof scaleAttr === 'string' && scaleAttr.endsWith('x') ? Number(scaleAttr.replace('x','')) : Number(scaleAttr) || 1;

        // Prefer resolved local path, then file-like data-url, then file-like data-path
        const looksFile = (p) => /\.(webp|png|jpg|jpeg|gif|svg)$/i.test(String(p||''));
        let localPath = card._resolvedLocalPath || '';
        if (!localPath) {
          const urlAttr = card.getAttribute('data-url') || '';
          const pathAttr = card.getAttribute('data-path') || '';
          localPath = looksFile(urlAttr) ? urlAttr : (looksFile(pathAttr) ? pathAttr : (urlAttr || pathAttr));
        }
        if (card._ensureLocalPromise) {
          try { localPath = await card._ensureLocalPromise; } catch (_) {}
        }
        if (!localPath) { this._cleanupQueuedDrag(); return; }

        // Build drag data (include origin source/tier from card attributes)
        const originSource = card.getAttribute('data-source') || '';
        const originTier = card.getAttribute('data-tier') || '';
        const displayName = card.getAttribute('data-display-name') || '';
        const dragData = { type: 'fa-nexus-token', source: 'fa-nexus', filename, url: localPath, tokenSize: { gridWidth, gridHeight, scale }, originSource, originTier, displayName };
        Logger.info('TokenDrag.queued.dragData', { dragData });
        // If we're over an actor in the sidebar, handle as ActorDrop instead of canvas place
        const x = ev.clientX, y = ev.clientY;
        let actorEl = highlightedActorEl;
        try {
          if (!actorEl) {
            const under = document.elementFromPoint(x, y);
            const candidate = under?.closest?.(actorSelector);
            const isFolder = candidate && (candidate.classList?.contains('folder') || candidate.getAttribute?.('data-document-type') === 'Folder');
            actorEl = (!isFolder && candidate) ? candidate : null;
          }
        } catch (_) { actorEl = null; }

        if (actorEl) {
          const fauxEvent = { clientX: x, clientY: y, shiftKey: !!ev.shiftKey };
          // Immediately end queued drag UX before showing dialog to avoid stuck preview and extra clicks
          try { this._cleanupQueuedDrag(); } catch (_) {}
          try { await TokenDragDropManager.handleActorDrop(actorEl, dragData, fauxEvent); }
          catch (e) { console.warn('fa-nexus | queued drag actor drop failed', e); }
          return;
        } else {
          // If over the actors panel but not an actor (e.g., a folder), cancel silently
          try {
            const under = document.elementFromPoint(x, y);
            const inActorsPanel = under?.closest?.('.actors-sidebar, #actors, .directory[data-tab="actors"], .app.sidebar-tab[data-tab="actors"], .actors.directory');
            const isFolder = under?.closest?.('.folder');
            if (inActorsPanel && isFolder) {
              return;
            }
          } catch (_) {}
          // Otherwise, place on canvas
          const drop = TokenDragDropManager.transformCoordinates(ev, canvas, dragData.tokenSize);
          // Validate drop bounds before creating the actor/token
          if (!TokenDragDropManager.isValidDropLocation(drop.world, canvas)) {
            ui.notifications?.warn?.('Cannot drop token outside the scene boundaries');
            return;
          }
          try { await ActorFactory.createActorFromDragData(dragData, drop); }
          catch (e) { console.warn('fa-nexus | queued drag place failed', e); }
        }
      } finally {
        this._cleanupQueuedDrag();
      }
    };
    const handleQueuedKey = (ev) => { 
      if (ev.key === 'Escape') { 
        ev.preventDefault();
        ev.stopPropagation();
        this._cleanupQueuedDrag(); 
      } 
    };
    document.addEventListener('mousemove', handleQueuedMove, true);
    document.addEventListener('mouseup', handleQueuedMouseUp, true);
    document.addEventListener('keydown', handleQueuedKey, true);
    this._activeQueuedDrag = { preview, handlers: { mousemove: handleQueuedMove, mouseup: handleQueuedMouseUp, keydown: handleQueuedKey } };
  }

  /**
   * Cleanup drag event listeners
   */
  _cleanupDragEventListeners() {
    if (this._boundMouseDownHandler) {
      document.removeEventListener('mousedown', this._boundMouseDownHandler, { capture: true });
      this._boundMouseDownHandler = null;
    }
    this._boundDragEndHandler = null;
    this._boundDragLeaveHandler = null;
    this._boundDropHandler = null;
  }

  // Native drag preview preloading removed; unified queued drag does not need it

  /**
   * Calculate drag preview pixel dimensions based on token size, scene grid, and canvas zoom
   * @param {{gridWidth:number, gridHeight:number, scale:number}} sizeInfo
   * @param {number} gridSize - Scene grid size in pixels
   * @param {number} zoomLevel - Current canvas zoom
   * @returns {{width:number, height:number}}
   */
  static calcDragPreviewPixelDims(sizeInfo, gridSize = 100, zoomLevel = 1) {
    const { gridWidth = 1, gridHeight = 1, scale = 1 } = sizeInfo || {};
    const width = gridWidth * gridSize * scale * zoomLevel;
    const height = gridHeight * gridSize * scale * zoomLevel;
    return {
      width: Math.round(width),
      height: Math.round(height)
    };
  }

  // Native DragDrop dragstart removed

  /**
   * Setup drag preview using preloaded canvas (matches Token Browser implementation)
   * @param {DragEvent} event - The drag event
   * @param {HTMLElement} card - The card element
   * @param {number} gridWidth - Grid width in squares
   * @param {number} gridHeight - Grid height in squares
   * @param {number} scale - Scale modifier
   */
  // Native drag preview setup removed

  /**
   * Handle canvas drop events from Foundry's dropCanvasData hook
   * @param {Canvas} canvas - The canvas instance
   * @param {Object} data - Drop data from the hook
   * @param {DragEvent} event - The drop event
   * @returns {boolean} True if handled, false to allow other handlers
   */
  // Canvas drop handler for native DragDrop removed; queued drag places directly

  /**
   * Transform screen coordinates to world coordinates with grid snapping
   * @param {DragEvent} event - The drop event
   * @param {Canvas} canvas - The canvas instance
   * @param {Object} tokenSize - Token size info {gridWidth, gridHeight, scale}
   * @returns {Object} Coordinates object with screen and world properties
   */
  static transformCoordinates(event, canvas, tokenSize = { gridWidth: 1, gridHeight: 1, scale: 1 }) {
    // Get screen coordinates from the drop event
    const screenX = event.clientX;
    const screenY = event.clientY;
    
    // Transform screen coordinates to world coordinates
    const worldCoords = canvas.canvasCoordinatesFromClient({ x: screenX, y: screenY });
    
    // Apply grid snapping
    const snappedCoords = TokenDragDropManager.applyGridSnapping(worldCoords, canvas, tokenSize);
    
    return {
      screen: { x: screenX, y: screenY },
      world: snappedCoords
    };
  }

  /**
   * Apply grid snapping to world coordinates based on token size
   * @param {Object} worldCoords - World coordinates {x, y}
   * @param {Canvas} canvas - The Foundry VTT canvas
   * @param {Object} tokenSize - Token size info {gridWidth, gridHeight, scale}
   * @returns {Object} Snapped coordinates {x, y}
   */
  static applyGridSnapping(worldCoords, canvas, tokenSize = { gridWidth: 1, gridHeight: 1, scale: 1 }) {
    // Check if grid snapping is enabled and we have a grid
    if (!canvas.grid || !canvas.scene) {
      return worldCoords;
    }

    try {
      const gridSize = canvas.scene.grid.size;
      const { gridWidth, gridHeight } = tokenSize;

      let snapX, snapY;

      if (gridWidth % 2 === 0) {
        // Even-sized tokens (2x2, 4x4) snap to grid intersections
        // Use Math.round to snap to nearest intersection
        snapX = Math.round(worldCoords.x / gridSize) * gridSize;
        snapY = Math.round(worldCoords.y / gridSize) * gridSize;
      } else {
        // Odd-sized tokens (1x1, 3x3) snap to grid centers
        // Use Math.floor to stay in current grid square, then add center offset
        snapX = Math.floor(worldCoords.x / gridSize) * gridSize + (gridSize / 2);
        snapY = Math.floor(worldCoords.y / gridSize) * gridSize + (gridSize / 2);
      }

      return { x: snapX, y: snapY };
      
    } catch (error) {
      console.warn('fa-nexus | Grid snapping failed, using raw coordinates:', error);
      return worldCoords;
    }
  }

  /**
   * Check if drop location is within valid canvas bounds
   * @param {Object} worldCoords - World coordinates {x, y}
   * @param {Canvas} canvas - The canvas instance
   * @returns {boolean} True if location is valid
   */
  static isValidDropLocation(worldCoords, canvas) {
    if (!canvas || !canvas.scene) return false;
    
    const { x, y } = worldCoords;
    const scene = canvas.scene;
    
    // Get the actual grid size from the scene
    const gridSize = scene.grid?.size || canvas.grid?.size || 100;
    
    // Use actual canvas dimensions instead of scene dimensions
    const canvasBounds = {
      width: canvas.dimensions?.width || scene.width,
      height: canvas.dimensions?.height || scene.height
    };
    
    // Be more lenient with boundaries - tokens can be placed in the buffer areas
    const margin = gridSize;
    
    const isWithinBounds = x >= -margin && y >= -margin && 
                          x <= canvasBounds.width + margin && y <= canvasBounds.height + margin;
    
    return isWithinBounds;
  }

  /**
   * Handle drop onto actor in the actors sidebar
   * @param {HTMLElement} actorElement - The actor element that was dropped onto
   * @param {Object} data - The drag data
   * @param {DragEvent} event - The drop event
   * @returns {boolean} True if handled, false if not our drop
   */
  static async handleActorDrop(actorElement, data, event) {
    // Handle different data formats that might come through 
    let dropData = data;
    
    // If we got a DragEvent, try to extract our data from DataTransfer
    if (event && event.dataTransfer) {
      try {
        const transferData = event.dataTransfer.getData('text/plain');
        if (transferData) {
          dropData = JSON.parse(transferData);
        }
      } catch (parseError) {
        // Not JSON data, ignore
        return false;
      }
    }
    
    // Check if this is a drop from our FA Nexus
    const isOurDrop = dropData && dropData.source === 'fa-nexus' && 
      dropData.type === 'fa-nexus-token';
    
    if (!isOurDrop) {
      return false; // Not our drop, let other handlers process
    }
    
    try {
      // Validate required data
      if (!dropData.filename || !dropData.url) {
        throw new Error('Invalid drag data: missing filename or URL');
      }
      
      // Extract actor ID from the element
      const actorId = actorElement.getAttribute('data-entry-id') || 
                     actorElement.getAttribute('data-document-id') ||
                     actorElement.getAttribute('data-actor-id');
      
      if (!actorId) {
        throw new Error('Could not determine actor ID from drop target');
      }
      
      // Get the actor
      const actor = game.actors.get(actorId);
      if (!actor) {
        throw new Error(`Actor not found: ${actorId}`);
      }
      
      // Check if Shift key is held - if so, bypass confirmation dialog
      if (event && event.shiftKey) {
        // Auto-accept with default settings
        await ActorFactory.updateActorPrototypeToken(actor, dropData, {
          updateActorImage: true,
          useWildcard: false
        });
        ui.notifications.info(`Updated prototype token for "${actor.name}" (Shift+Drop)`);
      } else {
        // Restore FA Nexus window before prompting so the dialog is fully visible.
        try { TokenDragDropManager._setWindowTransparency(false); } catch (_) {}
        // Show confirmation dialog and handle the prototype update
        const confirmed = await TokenDragDropManager._showActorUpdateConfirmation(actor, dropData, event);
        if (confirmed) {
          await ActorFactory.updateActorPrototypeToken(actor, dropData, {
            updateActorImage: dropData._updateActorImage || false,
            useWildcard: dropData._useWildcard || false
          });
          ui.notifications.info(`Updated prototype token for "${actor.name}"`);
        }
      }
      
      return true; // We handled this drop successfully
      
    } catch (error) {
      console.error('fa-nexus | Actor Drop: Error processing drop:', error);
      ui.notifications.error(`Failed to update actor token: ${error.message}`);
      return true; // We handled it (even if it failed)
    }
  }

  /**
   * Show confirmation dialog for actor token update
   * @param {Actor} actor - The actor to update
   * @param {Object} dropData - The drop data
   * @param {DragEvent} event - The drop event
   * @returns {Promise<boolean>} True if confirmed, false if cancelled
   */
  static async _showActorUpdateConfirmation(actor, dropData, event) {
    return new Promise((resolve) => {
      const cursorX = event?.clientX || window.innerWidth / 2;
      const cursorY = event?.clientY || window.innerHeight / 2;
      const dialog = new TokenDragDropManager.ActorUpdateDialog(actor, dropData, resolve, cursorX, cursorY);
      dialog.render(true);
    });
  }

  /**
   * ApplicationV2 dialog for actor token updates (matches Token Browser style)
   */
  static ActorUpdateDialog = class extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    constructor(actor, dropData, resolveCallback, cursorX, cursorY) {
      const left = Math.max((cursorX || window.innerWidth / 2) - 430, 20);
      const top = Math.max((cursorY || window.innerHeight / 2) - 200, 20);
      super({ position: { left, top, width: 400, height: 'auto' } });
      this.actor = actor;
      this.dropData = dropData;
      this.resolveCallback = resolveCallback;
      this._resolved = false;
    }
    
    static DEFAULT_OPTIONS = {
      id: 'fa-nexus-actor-update',
      tag: 'div',
      window: {
        frame: true,
        positioned: true,
        resizable: false,
        title: 'Update Actor Token'
      },
      position: {
        width: 400,
        height: 'auto'
      }
    };
    
    static PARTS = {
      form: {
        template: 'modules/fa-nexus/templates/tokens/actor-update-dialog.hbs'
      }
    };
    
    async _prepareContext() {
      const tokenSize = this.dropData.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };

      const canUseWildcard = true; // Enable in Nexus UI; access control happens server-side

      // Extract display name from filename
      const filename = this.dropData.filename || '';
      const displayName = this.dropData.displayName || '';

      // Determine token source
      const source = this.dropData.originSource || 'local';
      const isCloudToken = source === 'cloud';
      const tier = this.dropData.originTier || null;

      return {
        actor: this.actor,
        dropData: this.dropData,
        newTokenSrc: this.dropData.url,
        displayName: displayName,
        tokenSource: source,
        isCloudToken: isCloudToken,
        tier: tier,
        tokenSize: tokenSize,
        hasScale: tokenSize.scale !== 1,
        updateActorImageDefault: true,
        canUseWildcard: canUseWildcard
      };
    }
    
    _onRender(context, options) {
      super._onRender(context, options);
      
      // Apply FA theme class to dialog to match host theme
      try {
        const body = document.body;
        const isDark = body.classList.contains('theme-dark');
        this.element.classList.toggle('fa-theme-dark', isDark);
        this.element.classList.toggle('fa-theme-light', !isDark);
      } catch (e) {}

      // Add event listeners using event delegation
      this.element.addEventListener('click', (event) => {
        const action = event.target.closest('[data-action]')?.getAttribute('data-action');
        
        if (action === 'confirm') {
          const updateActorImage = this.element.querySelector('#update-actor-image')?.checked || false;
          const useWildcard = this.element.querySelector('#use-wildcard-token')?.checked || false;
          this.dropData._updateActorImage = updateActorImage;
          this.dropData._useWildcard = useWildcard;
          this._resolve(true);
          this.close();
        } else if (action === 'cancel') {
          this._resolve(false);
          this.close();
        }
      });
      
      // Handle escape key
      const escapeHandler = (event) => {
        if (event.key === 'Escape') {
          this._resolve(false);
          this.close();
        }
      };
      
      document.addEventListener('keydown', escapeHandler);
      
      this.addEventListener('close', () => {
        document.removeEventListener('keydown', escapeHandler);
      });
    }

    _resolve(result) {
      if (this._resolved) return;
      this._resolved = true;
      try { this.resolveCallback?.(result); }
      catch (_) {}
    }

    async close(options) {
      if (!this._resolved) this._resolve(false);
      return super.close(options);
    }
  }

  /**
   * Setup canvas as a drop zone for FA Nexus tokens
   */
  static setupCanvasDropZone() { /* no-op in unified queued drag mode */ }

  /**
   * Setup actors sidebar as a drop zone for FA Nexus tokens
   */
  static setupActorDropZone() { /* no-op in unified queued drag mode */ }

  /**
   * Make FA Nexus window semi-transparent/non-interactive during drag, then restore.
   * @param {boolean} transparent
   */
  static _setWindowTransparency(transparent) {
    try {
      // Prefer the main Nexus app element; fall back to any matching shell
      const app = foundry.applications.instances.get('fa-nexus-app');
      const appEl = app?.element;
      if (!appEl) return;

      const cls = TokenDragDropManager; // static context

      if (transparent) {
        // Increment lock count to handle overlapping drags
        cls._transparencyLocks = (cls._transparencyLocks || 0) + 1;

        // Capture original styles once using computed values
        if (appEl._nexusOriginalOpacity === undefined) {
          const cs = window.getComputedStyle(appEl);
          appEl._nexusOriginalOpacity = cs.opacity || '1';
          appEl._nexusOriginalPointerEvents = cs.pointerEvents || 'auto';
        }

        // Cancel any pending restore
        if (cls._pendingRestoreTimeout) { clearTimeout(cls._pendingRestoreTimeout); cls._pendingRestoreTimeout = null; }

        // Avoid rescheduling if already dimmed
        if (appEl.style.opacity === '0.02' && appEl.style.pointerEvents === 'none') return;

        // Cancel previous dim timer and schedule a short delay to avoid interrupting native drag
        if (cls._pendingTransparentTimeout) { clearTimeout(cls._pendingTransparentTimeout); cls._pendingTransparentTimeout = null; }
        appEl.style.transition = 'opacity 0.2s ease-in-out';
        cls._pendingTransparentTimeout = setTimeout(() => {
          cls._pendingTransparentTimeout = null;
          // Only apply if there is still at least one active lock
          if ((cls._transparencyLocks || 0) > 0) {
            appEl.style.opacity = '0.02';
            appEl.style.pointerEvents = 'none';
          }
        }, 50);
      } else {
        // Decrement locks and only restore when all are released
        cls._transparencyLocks = Math.max(0, (cls._transparencyLocks || 0) - 1);
        if (cls._transparencyLocks > 0) return;

        // Cancel any pending dim
        if (cls._pendingTransparentTimeout) { clearTimeout(cls._pendingTransparentTimeout); cls._pendingTransparentTimeout = null; }

        // Restore original styles immediately with a smooth transition
        appEl.style.transition = 'opacity 0.2s ease-out';
        const originalOpacity = appEl._nexusOriginalOpacity ?? '1';
        const originalPE = appEl._nexusOriginalPointerEvents ?? 'auto';
        appEl.style.opacity = originalOpacity;
        appEl.style.pointerEvents = originalPE;

        // Cleanup after the fade completes
        if (cls._pendingRestoreTimeout) { clearTimeout(cls._pendingRestoreTimeout); }
        cls._pendingRestoreTimeout = setTimeout(() => {
          appEl.style.transition = '';
          delete appEl._nexusOriginalOpacity;
          delete appEl._nexusOriginalPointerEvents;
          cls._pendingRestoreTimeout = null;
        }, 250);
      }
    } catch (_) {}
  }
}
