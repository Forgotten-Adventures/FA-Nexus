import { NexusLogger as Logger } from '../nexus-logger.js';

/**
 * Shared helper for grid-based multi-selection flows (assets, tokens, etc.).
 * Handles basic selection state, range toggles, and card UI updates.
 */
export class GridSelectionHelper {
  /**
   * @param {object} options
   * @param {() => HTMLElement|null} [options.getGridContainer] Returns the grid container element.
   * @param {() => any[]} [options.getGridItems] Returns the current grid items (fallback when no visibleItems cache).
   * @param {(item:any) => string} [options.computeItemKey] Produces a stable selection key for an item.
   * @param {(card:HTMLElement) => string} [options.keyFromCard] Extracts selection key from a rendered card element.
   * @param {(card:HTMLElement, selected:boolean) => void} [options.setCardSelectionUI] Applies visual selection UI to a card.
   * @param {(item:any, card:HTMLElement|null, context:object) => boolean} [options.isItemLocked] Returns true if item cannot be selected.
   * @param {() => object} [options.getSelectionContext] Provides additional context (auth, etc.) for selection checks.
   * @param {string} [options.cardSelector] Query selector for cards (defaults to '.fa-nexus-card').
   * @param {import('../nexus-logger.js').NexusLogger} [options.logger] Optional logger instance.
   * @param {string} [options.loggerTag] Logger namespace suffix.
   */
  constructor(options = {}) {
    this._options = options || {};
    this.selectedKeys = new Set();
    this.lastClickedIndex = -1;
    this.visibleItems = [];
    this._logger = options.logger || Logger;
    this._loggerTag = options.loggerTag || 'GridSelection';
  }

  resetVisibleItems(list) {
    try {
      this.visibleItems = Array.isArray(list) ? list.slice() : [];
    } catch (_) {
      this.visibleItems = [];
    }
  }

  clearSelection() {
    this.selectedKeys.clear();
    this.lastClickedIndex = -1;
  }

  computeItemKey(item) {
    try {
      if (this._options.computeItemKey) {
        return String(this._options.computeItemKey(item) || '').toLowerCase();
      }
    } catch (_) {}
    if (!item) return '';
    try {
      const fp = String(item.file_path || item.path || '') || '';
      if (fp) return fp.toLowerCase();
      const filename = String(item.filename || '');
      if (filename) return filename.toLowerCase();
    } catch (_) {}
    return '';
  }

  keyFromCard(cardElement) {
    if (!cardElement) return '';
    try {
      if (this._options.keyFromCard) {
        const key = this._options.keyFromCard(cardElement);
        if (key) return String(key).toLowerCase();
      }
    } catch (_) {}
    try {
      const direct = cardElement.getAttribute('data-key');
      if (direct) return String(direct).toLowerCase();
      const fp = cardElement.getAttribute('data-file-path') || cardElement.getAttribute('data-url');
      if (fp) return String(fp).toLowerCase();
      const path = cardElement.getAttribute('data-path') || '';
      const filename = cardElement.getAttribute('data-filename') || '';
      if (path || filename) return `${path}`.toLowerCase() + (filename ? `/${filename}`.toLowerCase() : '');
    } catch (_) {}
    return '';
  }

  indexOfVisibleKey(key, fallbackItem = null) {
    try {
      const list = this._getVisibleList();
      if (!list.length) return -1;
      if (key) {
        const normalized = String(key).toLowerCase();
        const idx = list.findIndex((it) => this.computeItemKey(it) === normalized);
        if (idx >= 0) return idx;
      }
      if (fallbackItem) {
        const fallback = this.computeItemKey(fallbackItem);
        const idx2 = list.findIndex((it) => this.computeItemKey(it) === fallback);
        if (idx2 >= 0) return idx2;
      }
      return -1;
    } catch (_) {
      return -1;
    }
  }

  applyRangeSelection(from, to, mode = 'add') {
    try {
      const list = this._getVisibleList();
      if (!list.length) return;
      const a = Math.max(0, Math.min(from, to));
      const b = Math.max(0, Math.max(from, to));
      const ctx = this._buildSelectionContext();
      for (let i = a; i <= b; i++) {
        const item = list[i];
        const key = this.computeItemKey(item);
        if (!key) continue;
        if (mode === 'remove') {
          this.selectedKeys.delete(key);
          continue;
        }
        if (this._isItemLocked(item, null, ctx)) {
          this.selectedKeys.delete(key);
          this._log('range.skipLocked', { key });
          continue;
        }
        this.selectedKeys.add(key);
      }
    } catch (_) {}
  }

  applyRangeSelectionExclusive(from, to) {
    try {
      const list = this._getVisibleList();
      if (!list.length) {
        this.selectedKeys.clear();
        return;
      }
      const a = Math.max(0, Math.min(from, to));
      const b = Math.max(0, Math.max(from, to));
      this.selectedKeys.clear();
      const ctx = this._buildSelectionContext();
      for (let i = a; i <= b; i++) {
        const item = list[i];
        const key = this.computeItemKey(item);
        if (!key) continue;
        if (this._isItemLocked(item, null, ctx)) {
          this._log('range.skipLocked', { key });
          continue;
        }
        this.selectedKeys.add(key);
      }
    } catch (_) {}
  }

  setCardSelectionUI(cardElement, selected) {
    try {
      if (this._options.setCardSelectionUI) {
        this._options.setCardSelectionUI(cardElement, selected);
        return;
      }
    } catch (_) {}
    if (!cardElement) return;
    try {
      if (selected) {
        cardElement.classList.add('fa-nexus-selected');
        cardElement.setAttribute('data-selected', 'true');
      } else {
        cardElement.classList.remove('fa-nexus-selected');
        cardElement.removeAttribute('data-selected');
      }
    } catch (_) {}
  }

  refreshSelectionUI() {
    try {
      const grid = this._options.getGridContainer ? this._options.getGridContainer() : null;
      if (!grid) return;
      const selector = this._options.cardSelector || '.fa-nexus-card';
      const cards = grid.querySelectorAll(selector);
      for (const card of cards) {
        const key = this.keyFromCard(card);
        const selected = key && this.selectedKeys.has(key);
        this.setCardSelectionUI(card, !!selected);
      }
    } catch (_) {}
  }

  _getVisibleList() {
    if (Array.isArray(this.visibleItems) && this.visibleItems.length) {
      return this.visibleItems;
    }
    try {
      if (typeof this._options.getGridItems === 'function') {
        const items = this._options.getGridItems();
        if (Array.isArray(items)) return items;
      }
    } catch (_) {}
    return [];
  }

  _buildSelectionContext() {
    try {
      if (typeof this._options.getSelectionContext === 'function') {
        const ctx = this._options.getSelectionContext();
        if (ctx && typeof ctx === 'object') return ctx;
      }
    } catch (_) {}
    return {};
  }

  _isItemLocked(item, card, context) {
    if (!this._options.isItemLocked) return false;
    try {
      return !!this._options.isItemLocked(item, card, context || {});
    } catch (_) {
      return false;
    }
  }

  _log(event, payload = {}, level = 'info') {
    const logger = this._logger;
    if (!logger) return;
    try {
      const tag = `${this._loggerTag}.${event}`;
      const fn = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info?.bind(logger);
      fn?.(tag, payload);
    } catch (_) {}
  }
}
