import { BaseTab } from '../base-tab.js';
import { VirtualGridManager } from './virtual-grid-manager.js';
import { NexusLogger as Logger } from '../nexus-logger.js';
import { NexusSearchManager } from '../search/search-manager.js';

/**
 * GridBrowseTab: shared helpers for grid-based browser tabs (assets, tokens, etc.).
 * Provides virtual grid lifecycle wiring, hover preview plumbing, throttled
 * image loading, and convenience hooks for subclasses to customize behaviour.
 */
export class GridBrowseTab extends BaseTab {
  constructor(app) {
    super(app);
    this._items = [];
    this._search = this._createSearchManager();
    this._loadId = 0;
    this._hoverHandlers = null;
    this._preview = null;
    this._imgLoader = null;
    this._thumbSizeAdjustDepth = 0;
  }

  /** @returns {string} label used in log messages */
  get logTag() {
    return this.constructor?.name || 'GridBrowseTab';
  }

  /** Selector used to locate the grid container within the app */
  get gridContainerSelector() {
    return '#fa-nexus-grid';
  }

  /** Delay (ms) before showing hover preview */
  get hoverPreviewDelay() {
    return 300;
  }

  /** Item count threshold that triggers yielding before heavy search/filter work */
  get asyncSearchThreshold() {
    return 20000;
  }

  /** Preferred card size for placeholder skeletons */
  getPlaceholderCardSize() {
    const options = this.getGridOptions?.();
    const card = options?.card || {};
    const width = Math.max(32, Math.round(this.app?._grid?.card?.width || card.width || 120));
    const height = Math.max(32, Math.round(this.app?._grid?.card?.height || card.height || 140));
    const gap = Math.max(2, Math.round(card.gap ?? 12));
    return { width, height, gap };
  }

  /** Factory for the search manager (override if a custom search implementation is needed) */
  _createSearchManager() {
    return new NexusSearchManager();
  }

  /** Locate the grid container element */
  getGridContainer() {
    return this.app?.element?.querySelector?.(this.gridContainerSelector) || null;
  }

  /** Locate the shared search input */
  getSearchInput() {
    return this.app?.element?.querySelector?.('#fa-nexus-search') || null;
  }

  /** Current value from the search input */
  getCurrentSearchValue() {
    const input = this.getSearchInput();
    return (input && typeof input.value === 'string') ? input.value : '';
  }

  /** Ensure the VirtualGridManager is attached to the current container */
  ensureGrid(container) {
    if (!container) return null;
    const app = this.app;
    if (app._grid && app._grid.container !== container) {
      try { app._grid.destroy(); } catch (_) {}
      app._grid = null;
    }
    if (!app._grid) {
      Logger.info(`${this.logTag}: creating grid`, { tab: this.id });
      const options = this.getGridOptions?.();
      if (!options) return null;
      app._grid = new VirtualGridManager(container, options);
      try {
        const placeholderSize = this.getPlaceholderCardSize();
        this.app?.updateGridPlaceholderSize?.({ tab: this.id, ...placeholderSize });
      } catch (_) {}
      Logger.info(`${this.logTag}: grid created`, { tab: this.id });
    }
    return app._grid;
  }

  /** Hook for subclasses to construct the preview manager */
  // eslint-disable-next-line class-methods-use-this
  createPreviewManager() { return null; }

  /** Called after the preview manager instance is ready */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  onPreviewReady(_preview) {}

  /** Allow subclass to veto hover preview or perform side-effects */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  onHoverCardEnter(_card, _mediaEl) { return true; }

  /** Allow subclass to react when hover leaves the current card */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  onHoverCardLeave(_card) {}

  /** Optional hook around applySearch */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  beforeApplySearch(_query) {}

  /** Optional hook after applySearch sets grid data */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  afterApplySearch(_filtered, _query) {
    this._updateEmptyState();
  }

  /** Update empty state display when no results found */
  _updateEmptyState() {
    try {
      const app = this.app;
      const grid = app.element?.querySelector('#fa-nexus-grid');
      if (!grid) return;
      let empty = app.element.querySelector('.fa-nexus-empty-state');
      const shown = (app._grid && Array.isArray(app._grid.items) && app._grid.items.length === 0);
      if (!shown) { if (empty) empty.remove(); return; }
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'fa-nexus-empty-state';
        empty.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color: var(--color-text-light-6, #bbb); pointer-events:none; font-size: 14px;';
        empty.textContent = 'No results found';
        grid.parentElement?.appendChild(empty);
      }
    } catch (_) {}
  }

  async onActivate() {
    Logger.info(`${this.logTag}.onActivate`, { tab: this.id });
    const gridContainer = this.getGridContainer();
    try { this._resetImageLoader(); } catch (_) {}
    if (gridContainer) this.ensureGrid(gridContainer);
    try {
      const placeholderSize = this.getPlaceholderCardSize();
      this.app?.showGridPlaceholder?.({ tab: this.id, ...placeholderSize });
    } catch (_) {}
    try { this.bindFooter?.(); } catch (_) {}
    try { this._bindThumbSizeSlider?.(); } catch (_) {}
    this._installHoverPreview();
    Logger.info(`${this.logTag}.onActivate:complete`, { tab: this.id });
  }

  onDeactivate() {
    // Remove any empty state elements to prevent bleed-over between tabs
    try {
      const empty = this.app?.element?.querySelector('.fa-nexus-empty-state');
      if (empty) empty.remove();
    } catch (_) {}
    try { this.app?.hideGridPlaceholder?.(this.id); } catch (_) {}
    try { this.app?.hideGridLoader?.(this.id); } catch (_) {}
    try { this.unbindFooter?.(); } catch (_) {}
    try { this._preview?.hidePreview?.(); } catch (_) {}
    this._uninstallHoverPreview();
    try { this._resetImageLoader(); } catch (_) {}
  }

  /** Allow tabs to cancel in-flight async work (override when needed) */
  // eslint-disable-next-line class-methods-use-this
  cancelActiveOperations() {}

  /** Default implementation uses NexusSearchManager filtering */
  filterItems(items, query) {
    const source = Array.isArray(items) ? items : [];
    if (!this._search || typeof this._search.filter !== 'function') return source;
    return this._search.filter(source, query || '');
  }

  applySearch(query) {
    const app = this.app;
    if (!app?._grid) return;
    const q = query || '';
    this.beforeApplySearch(q);
    try { Logger.info(`${this.logTag}.applySearch`, { query: q }); } catch (_) {}
    const filtered = this.filterItems(this._items || [], q);
    try { this.app?.hideGridPlaceholder?.(this.id); } catch (_) {}
    app._grid.setData(filtered);
    try { app._grid._onResize?.(); } catch (_) {}
    try { app._grid.container.scrollTop = 0; app._grid._onScroll?.(); } catch (_) {}
    this._updateFooterStats();
    this.afterApplySearch(filtered, q);
  }

  async applySearchAsync(query) {
    const items = Array.isArray(this._items) ? this._items : [];
    if (items.length >= this.asyncSearchThreshold) {
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
        else setTimeout(resolve, 16);
      });
    }
    const q = (typeof query === 'string') ? query : this.getCurrentSearchValue();
    this.applySearch(q);
  }

  _updateFooterStats() {
    try {
      const stats = this.app?.element?.querySelector?.('.fa-nexus-footer .stats');
      if (!stats) return;
      const counts = this.getStats?.();
      if (!counts) return;
      const { shown = 0, total = 0 } = counts;
      stats.textContent = `${shown} / ${total}`;
    } catch (_) {}
  }

  _installHoverPreview() {
    const grid = this.getGridContainer();
    if (!grid) return;
    this._ensurePreviewManager();
    if (!this._preview || typeof this._preview.showPreviewWithDelay !== 'function') return;

    let hoveredCard = null;
    const onOver = (event) => {
      const card = event.target?.closest?.('.fa-nexus-card');
      if (!card || !grid.contains(card)) return;
      if (hoveredCard === card) return;
      const media = card.querySelector?.('img, video');
      if (!media) return;
      const shouldShow = this.onHoverCardEnter(card, media);
      if (shouldShow === false) return;
      hoveredCard = card;
      const delay = this.getHoverPreviewDelay(card, media);
      this._preview.showPreviewWithDelay(media, card, delay);
    };
    const onOut = (event) => {
      if (!hoveredCard) return;
      const to = event.relatedTarget;
      if (to && hoveredCard.contains(to)) return;
      this.onHoverCardLeave(hoveredCard);
      hoveredCard = null;
      this._preview.hidePreview();
    };
    const onLeaveGrid = () => {
      if (!hoveredCard) return;
      this.onHoverCardLeave(hoveredCard);
      hoveredCard = null;
      this._preview.hidePreview();
    };

    grid.addEventListener('mouseover', onOver);
    grid.addEventListener('mouseout', onOut);
    grid.addEventListener('mouseleave', onLeaveGrid);
    this._hoverHandlers = { over: onOver, out: onOut, leave: onLeaveGrid };
  }

  _ensurePreviewManager() {
    if (!this._preview) {
      const preview = this.createPreviewManager?.();
      this._preview = preview || null;
    }
    if (this._preview) {
      try { this._preview.initialize?.(); } catch (_) {}
      try { this.onPreviewReady(this._preview); } catch (_) {}
    }
  }

  _uninstallHoverPreview() {
    const grid = this.getGridContainer();
    if (!grid || !this._hoverHandlers) {
      this._hoverHandlers = null;
      return;
    }
    try { grid.removeEventListener('mouseover', this._hoverHandlers.over); } catch (_) {}
    try { grid.removeEventListener('mouseout', this._hoverHandlers.out); } catch (_) {}
    try { grid.removeEventListener('mouseleave', this._hoverHandlers.leave); } catch (_) {}
    this._hoverHandlers = null;
  }

  getHoverPreviewDelay(_card, _mediaEl) {
    return this.hoverPreviewDelay;
  }

  // ======== Throttled image loading helpers (shared) ========
  _ensureImageLoader() {
    if (this._imgLoader) return;
    this._imgLoader = { limit: 128, active: 0, q: [], running: new Set() };
  }

  _queueImageLoad(cardEl, imgEl, url, onOk, onErr) {
    this._ensureImageLoader();
    const fallbackUrl = url || cardEl?.getAttribute?.('data-url') || cardEl?.getAttribute?.('data-file-path') || '';
    if (!fallbackUrl) {
      try { onErr?.(); } catch (_) {}
      try { imgEl.style.opacity = '1'; } catch (_) {}
      return;
    }
    if (imgEl.src === fallbackUrl && imgEl.complete && imgEl.naturalWidth) {
      try { onOk?.(); } catch (_) {}
      return;
    }
    this._cancelImageLoad(cardEl);
    const job = { imgEl, url: fallbackUrl, onOk, onErr, cancelled: false, temp: null, running: false, cardEl };
    cardEl._imgJob = job;
    imgEl.style.opacity = '0';
    try { imgEl.setAttribute('loading', 'lazy'); } catch (_) {}
    try { imgEl.setAttribute('fetchpriority', 'low'); } catch (_) {}
    this._imgLoader.q.push(job);
    this._drainImageQueue();
  }

  _cancelImageLoad(cardEl) {
    const job = cardEl?._imgJob;
    if (!job) return;
    job.cancelled = true;
    try {
      if (job.running) {
        this._finalizeImageJob(job);
      } else if (job.temp) {
        job.temp.onload = null; job.temp.onerror = null; job.temp.src = '';
      }
    } catch (_) {}
    cardEl._imgJob = null;
  }

  _drainImageQueue() {
    const L = this._imgLoader;
    if (!L) return;
    while (L.active < L.limit && L.q.length) {
      const job = L.q.pop();
      if (!job || job.cancelled) continue;
      if (!job.imgEl || !document.body.contains(job.imgEl)) { job.cancelled = true; continue; }
      L.active++;
      const { imgEl, url } = job;
      const tmp = new Image();
      job.temp = tmp;
      job.running = true;
      L.running.add(job);
      tmp.onload = async () => {
        try {
          if (job.cancelled) return;
          imgEl.src = url;
          try { await imgEl.decode?.(); } catch (_) {}
          imgEl.style.opacity = '1';
          try { job.onOk?.(); } catch (_) {}
        } finally {
          this._finalizeImageJob(job);
        }
      };
      tmp.onerror = () => {
        try {
          if (!job.cancelled) {
            try { job.onErr?.(); } catch (_) {}
            try { job.imgEl.style.opacity = '1'; } catch (_) {}
          }
        } finally {
          this._finalizeImageJob(job);
        }
      };
      try { tmp.src = url; } catch (_) {
        this._finalizeImageJob(job);
      }
    }
  }

  _finalizeImageJob(job) {
    const L = this._imgLoader;
    if (!L) return;
    try {
      if (job.temp) {
        job.temp.onload = null;
        job.temp.onerror = null;
        job.temp = null;
      }
    } catch (_) {}
    if (job.running) {
      job.running = false;
      try { L.running.delete(job); } catch (_) {}
    }
    L.active = Math.max(0, L.active - 1);
    this._drainImageQueue();
  }

  _resetImageLoader() {
    const L = this._imgLoader;
    if (!L) { this._imgLoader = null; return; }
    try {
      for (const job of L.q) {
        try {
          job.cancelled = true;
          if (job.temp) {
            job.temp.onload = null;
            job.temp.onerror = null;
            job.temp.src = '';
            job.temp = null;
          }
        } catch (_) {}
      }
      L.q.length = 0;
      if (L.running && L.running.size) {
        for (const job of Array.from(L.running)) {
          try {
            job.cancelled = true;
            if (job.temp) {
              job.temp.onload = null;
              job.temp.onerror = null;
              job.temp.src = '';
              job.temp = null;
            }
          } catch (_) {}
        }
        L.running.clear();
      }
    } catch (_) {}
    this._imgLoader = null;
  }

  _beginThumbSizeAdjust() {
    this._thumbSizeAdjustDepth = Math.max(0, (this._thumbSizeAdjustDepth || 0)) + 1;
  }

  _endThumbSizeAdjust() {
    this._thumbSizeAdjustDepth = Math.max(0, (this._thumbSizeAdjustDepth || 1) - 1);
  }

  get isThumbSizeAdjustActive() {
    return (this._thumbSizeAdjustDepth || 0) > 0;
  }
}
