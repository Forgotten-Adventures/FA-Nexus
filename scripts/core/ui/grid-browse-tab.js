import { BaseTab } from '../base-tab.js';
import { VirtualGridManager } from './virtual-grid-manager.js';
import { NexusLogger as Logger } from '../nexus-logger.js';
import { NexusSearchManager } from '../search/search-manager.js';

const GRID_SORT_MODE_CATEGORY = 'category';
const GRID_SORT_MODE_NEWEST = 'newest';
const GRID_SORT_SETTING_KEY = 'gridSortModes';

function normalizeGridSortMode(mode) {
  return mode === GRID_SORT_MODE_CATEGORY ? GRID_SORT_MODE_CATEGORY : GRID_SORT_MODE_NEWEST;
}

function normalizeSearchGridSortMode(mode) {
  return mode === GRID_SORT_MODE_NEWEST ? GRID_SORT_MODE_NEWEST : GRID_SORT_MODE_CATEGORY;
}

function parseInventoryTimestamp(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

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
    this._sortModes = null;
    this._searchSortModes = {};
    this._sortSearchActive = {};
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

  get sortModeScope() {
    return this.id || this.logTag;
  }

  _getSortModeScope(scope = null) {
    return String(scope || this.sortModeScope || this.id || this.logTag || 'default');
  }

  _readSortModesSetting() {
    if (this._sortModes && typeof this._sortModes === 'object') return this._sortModes;
    try {
      const stored = game.settings.get('fa-nexus', GRID_SORT_SETTING_KEY);
      this._sortModes = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? { ...stored } : {};
    } catch (error) {
      Logger.warn(`${this.logTag}.sortMode.readFailed`, { error: String(error?.message || error) });
      this._sortModes = {};
    }
    return this._sortModes;
  }

  _getSortMode(scope = null) {
    const key = this._getSortModeScope(scope);
    const modes = this._readSortModesSetting();
    return normalizeGridSortMode(modes[key]);
  }

  _getEffectiveSortMode(scope = null, query = '') {
    const key = this._getSortModeScope(scope);
    if (String(query || '').trim()) {
      const modes = this._searchSortModes || {};
      return normalizeSearchGridSortMode(modes[key]);
    }
    return this._getSortMode(key);
  }

  _prepareSortModeForQuery(scope = null, query = '') {
    const key = this._getSortModeScope(scope);
    const hasQuery = !!String(query || '').trim();
    if (!this._searchSortModes || typeof this._searchSortModes !== 'object') this._searchSortModes = {};
    if (!this._sortSearchActive || typeof this._sortSearchActive !== 'object') this._sortSearchActive = {};
    const wasSearchActive = this._sortSearchActive[key] === true;
    if (hasQuery && !wasSearchActive) {
      delete this._searchSortModes[key];
    } else if (!hasQuery) {
      delete this._searchSortModes[key];
    }
    this._sortSearchActive[key] = hasQuery;
    return this._getEffectiveSortMode(key, query);
  }

  async _setSortMode(mode, { scope = null, button = null, refresh = true, query = '' } = {}) {
    const key = this._getSortModeScope(scope);
    const normalized = normalizeGridSortMode(mode);
    const queryText = String(query || '').trim();
    if (queryText) {
      if (!this._searchSortModes || typeof this._searchSortModes !== 'object') this._searchSortModes = {};
      if (!this._sortSearchActive || typeof this._sortSearchActive !== 'object') this._sortSearchActive = {};
      this._searchSortModes[key] = normalized;
      this._sortSearchActive[key] = true;
      this._syncSortModeButton(button, normalized, { scope: key, query: queryText });
      this._syncSortModeButtonsForScope(key, queryText);
      if (refresh) await this.applySearchAsync(this.getCurrentSearchValue());
      return normalized;
    }
    const modes = { ...this._readSortModesSetting(), [key]: normalized };
    this._sortModes = modes;
    try {
      await game.settings.set('fa-nexus', GRID_SORT_SETTING_KEY, modes);
    } catch (error) {
      Logger.error(`${this.logTag}.sortMode.writeFailed`, {
        scope: key,
        mode: normalized,
        error: String(error?.message || error)
      });
      throw error;
    }
    this._syncSortModeButton(button, normalized, { scope: key, query: queryText });
    this._syncSortModeButtonsForScope(key, queryText);
    if (refresh) await this.applySearchAsync(this.getCurrentSearchValue());
    return normalized;
  }

  _syncSortModeButton(button = null, mode = null, { scope = null, query = null } = {}) {
    const btn = button || this.app?.element?.querySelector?.('.fa-nexus-sort-mode');
    if (!btn) return;
    const resolvedScope = this._getSortModeScope(scope || btn.dataset.sortScope || null);
    const queryText = query === null ? this.getCurrentSearchValue() : query;
    const normalized = mode
      ? normalizeGridSortMode(mode)
      : this._getEffectiveSortMode(resolvedScope, queryText);
    const nextLabel = normalized === GRID_SORT_MODE_NEWEST
      ? 'Sorting by newest. Click for category.'
      : 'Sorting by category. Click for newest.';
    btn.dataset.sortMode = normalized;
    btn.title = nextLabel;
    btn.setAttribute('aria-label', nextLabel);
    const doc = btn.ownerDocument || globalThis.document;
    if (doc?.createElement) {
      const icon = doc.createElement('i');
      icon.className = normalized === GRID_SORT_MODE_NEWEST ? 'fas fa-arrow-down-wide-short' : 'fas fa-arrow-down-a-z';
      btn.replaceChildren(icon);
    }
  }

  _syncSortModeButtonsForScope(scope = null, query = '') {
    const key = this._getSortModeScope(scope);
    const root = this.app?.element;
    if (!root?.querySelectorAll) return;
    for (const button of root.querySelectorAll('.fa-nexus-sort-mode')) {
      if (button?.dataset?.sortScope !== key) continue;
      this._syncSortModeButton(button, null, { scope: key, query });
    }
  }

  _bindSortModeButton({ root = null, selector = '.fa-nexus-sort-mode', scope = null, onChange = null, getQuery = null } = {}) {
    const host = root || this.app?.element;
    let button = host?.querySelector?.(selector) || null;
    if (!button) return null;
    try {
      const parent = button.parentNode;
      const clone = button.cloneNode(true);
      parent.replaceChild(clone, button);
      button = clone;
    } catch (error) {
      Logger.warn(`${this.logTag}.sortMode.rebindFailed`, { error: String(error?.message || error) });
    }
    const resolvedScope = this._getSortModeScope(scope);
    button.dataset.sortScope = resolvedScope;
    const readQuery = () => {
      if (typeof getQuery === 'function') return getQuery() || '';
      return this.getCurrentSearchValue();
    };
    this._prepareSortModeForQuery(resolvedScope, readQuery());
    this._syncSortModeButton(button, null, { scope: resolvedScope, query: readQuery() });
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      const query = readQuery();
      const current = this._getEffectiveSortMode(resolvedScope, query);
      const next = current === GRID_SORT_MODE_NEWEST ? GRID_SORT_MODE_CATEGORY : GRID_SORT_MODE_NEWEST;
      try {
        await this._setSortMode(next, { scope: resolvedScope, button, refresh: false, query });
        if (typeof onChange === 'function') {
          await onChange(next);
        } else {
          await this.applySearchAsync(this.getCurrentSearchValue());
        }
      } catch (error) {
        Logger.error(`${this.logTag}.sortMode.changeFailed`, {
          scope: resolvedScope,
          requestedMode: next,
          error: String(error?.message || error)
        });
      }
    });
    return button;
  }

  _getItemNewestTimestamp(item) {
    const timestamp = parseInventoryTimestamp(item?.last_modified) || parseInventoryTimestamp(item?.lastModified);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  _getGridSortPinRank(_item, _context = {}) {
    return 0;
  }

  _applyGridSortMode(items, { scope = null, query = '' } = {}) {
    const source = Array.isArray(items) ? items : [];
    const key = this._getSortModeScope(scope);
    const mode = this._prepareSortModeForQuery(key, query);
    this._syncSortModeButtonsForScope(key, query);
    if (source.length < 2) return source;
    if (mode !== GRID_SORT_MODE_NEWEST) return source;
    return source
      .map((item, index) => ({
        item,
        index,
        pinRank: Number(this._getGridSortPinRank(item, { scope })) || 0,
        timestamp: this._getItemNewestTimestamp(item)
      }))
      .sort((a, b) => {
        if (a.pinRank !== b.pinRank) return a.pinRank - b.pinRank;
        if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
        return a.index - b.index;
      })
      .map((entry) => entry.item);
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
    try { this._bindSortModeButton?.(); }
    catch (error) { Logger.error(`${this.logTag}.sortMode.bindFailed`, { error: String(error?.message || error) }); }
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
    const filtered = this._applyGridSortMode(this.filterItems(this._items || [], q), { query: q });
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

  _getElementDocument(element) {
    return element?.ownerDocument || globalThis.document || null;
  }

  _isElementConnected(element) {
    if (!element) return false;
    try {
      if (element.isConnected) return true;
      const doc = this._getElementDocument(element);
      return !!doc?.body?.contains?.(element);
    } catch (error) {
      Logger.debug(`${this.logTag}.imageLoad.containsFailed`, { error: String(error?.message || error) });
      return false;
    }
  }

  _createImageForElement(element) {
    const doc = this._getElementDocument(element);
    const ImageCtor = doc?.defaultView?.Image || globalThis.Image;
    if (typeof ImageCtor !== 'function') {
      throw new Error('Image constructor is unavailable for thumbnail loading');
    }
    return new ImageCtor();
  }

  _toDomMediaURL(url, element = null) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return raw;
    try {
      const getRoute = globalThis.foundry?.utils?.getRoute;
      if (typeof getRoute === 'function') return getRoute(raw);
    } catch (error) {
      Logger.debug(`${this.logTag}.imageLoad.routeFailed`, {
        url: raw,
        error: String(error?.message || error)
      });
    }
    try {
      const base = this._getElementDocument(element)?.baseURI;
      if (base) return new URL(raw, base).href;
    } catch (error) {
      Logger.debug(`${this.logTag}.imageLoad.urlResolveFailed`, {
        url: raw,
        error: String(error?.message || error)
      });
    }
    return raw;
  }

  _queueImageLoad(cardEl, imgEl, url, onOk, onErr) {
    this._ensureImageLoader();
    const fallbackUrl = url || cardEl?.getAttribute?.('data-url') || cardEl?.getAttribute?.('data-file-path') || '';
    const domUrl = this._toDomMediaURL(fallbackUrl, imgEl);
    if (!domUrl) {
      try { onErr?.(); } catch (_) {}
      try { imgEl.style.opacity = '1'; } catch (_) {}
      return;
    }
    if (imgEl.src === domUrl && imgEl.complete && imgEl.naturalWidth) {
      try { onOk?.(); } catch (_) {}
      return;
    }
    this._cancelImageLoad(cardEl);
    const job = { imgEl, url: domUrl, rawUrl: fallbackUrl, onOk, onErr, cancelled: false, temp: null, running: false, cardEl };
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
      const { imgEl, url } = job;
      if (!this._isElementConnected(imgEl)) { job.cancelled = true; continue; }
      let tmp;
      try {
        tmp = this._createImageForElement(imgEl);
      } catch (error) {
        Logger.error(`${this.logTag}.imageLoad.createImageFailed`, {
          url: job.rawUrl || url,
          resolvedUrl: url,
          error: String(error?.message || error)
        });
        try { job.onErr?.(); } catch (_) {}
        try { imgEl.style.opacity = '1'; } catch (_) {}
        continue;
      }
      L.active++;
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
            Logger.debug(`${this.logTag}.imageLoad.failed`, {
              url: job.rawUrl || url,
              resolvedUrl: url,
              ownerDocument: imgEl?.ownerDocument?.location?.href || null,
              connected: !!imgEl?.isConnected
            });
            try { job.onErr?.(); } catch (_) {}
            try { job.imgEl.style.opacity = '1'; } catch (_) {}
          }
        } finally {
          this._finalizeImageJob(job);
        }
      };
      try { tmp.src = url; } catch (error) {
        Logger.debug(`${this.logTag}.imageLoad.assignFailed`, {
          url: job.rawUrl || url,
          resolvedUrl: url,
          error: String(error?.message || error)
        });
        this._finalizeImageJob(job);
      }
    }
  }

  onHostDocumentChanged({ reason = 'host-document-changed' } = {}) {
    try { Logger.info(`${this.logTag}.hostDocumentChanged`, { reason, tab: this.id }); } catch (_) {}
    try { this.app?._grid?._syncHostWindow?.(); } catch (error) {
      Logger.warn(`${this.logTag}.hostDocumentChanged.gridSyncFailed`, { error: String(error?.message || error) });
    }
    try { this.app?._grid?._onResize?.(); } catch (error) {
      Logger.warn(`${this.logTag}.hostDocumentChanged.gridResizeFailed`, { error: String(error?.message || error) });
    }
    try { this.app?._grid?.refreshMounted?.(); } catch (error) {
      Logger.warn(`${this.logTag}.hostDocumentChanged.refreshMountedFailed`, { error: String(error?.message || error) });
    }
    try { this._drainImageQueue(); } catch (error) {
      Logger.warn(`${this.logTag}.hostDocumentChanged.imageDrainFailed`, { error: String(error?.message || error) });
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
