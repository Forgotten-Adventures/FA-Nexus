/**
 * VirtualGridManager
 * Grid-based virtualization for card layouts.
 * Renders only cards intersecting the viewport +/- overscan.
 * Requires card configuration (width, height) for proper grid layout.
 *
 * @template T
 */
import { NexusLogger as Logger } from '../nexus-logger.js';

export class VirtualGridManager {
  /**
   * @param {HTMLElement} container - Scrollable container element
   * @param {object} options
   * @param {number} options.rowHeight - Fixed row height in px (legacy, not used in grid mode)
   * @param {number} [options.overscan=4] - Extra rows to render above/below
   * @param {(item:T, index:number)=>HTMLElement} options.createRow - Factory to create a row element
   * @param {object} options.card - Card configuration {width, height, gap}
   * @param {function} [options.onMountItem] - Callback when item is mounted
   * @param {function} [options.onUnmountItem] - Callback when item is unmounted
   */
  constructor(container, { rowHeight, overscan = 4, createRow, card, onMountItem = null, onUnmountItem = null }) {
    // Validate required card configuration
    if (!card || typeof card.width !== 'number' || typeof card.height !== 'number') {
      throw new Error('VirtualGridManager requires card configuration with width and height properties');
    }
    
    this.container = container;
    this.rowHeight = rowHeight;
    this.overscan = overscan;
    this.createRow = createRow;
    this.card = card; // { width, height, gap }
    this.onMountItem = onMountItem;
    this.onUnmountItem = onUnmountItem;
    this.items = [];
    this._mounted = new Map(); // index -> element
    this._onScroll = this._onScroll.bind(this);
    this._onResize = this._onResize.bind(this);
    this._resizeRaf = null;
    this._padding = document.createElement('div');
    this._padding.style.height = '0px';
    this.container.innerHTML = '';
    this.container.appendChild(this._padding);
    this.container.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onResize, { passive: true });
    // Also observe container size changes (window resize may not catch all cases)
    try {
      this._ro = new ResizeObserver(() => {
        if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
        this._resizeRaf = requestAnimationFrame(() => {
          this._resizeRaf = null;
          try { this._render(true); } catch (e) {}
        });
      });
      this._ro.observe(this.container);
    } catch (e) {}
  }

  /**
   * Update card size and force layout recalculation.
   * @param {number} width
   * @param {number} height
   */
  setCardSize(width, height) {
    try { Logger.debug('VGrid.setCardSize', { width, height }); } catch (_) {}
    this.card.width = width;
    this.card.height = height;
    this._render();
  }

  /**
   * Set/replace data and re-render.
   * @param {T[]} items
   */
  setData(items) {
    this.items = items || [];
    try { Logger.debug('VGrid.setData', { count: this.items.length }); } catch (_) {}
    // Clear currently mounted nodes to avoid stale content when dataset switches
    for (const [, el] of this._mounted) el.remove();
    this._mounted.clear();
    // Update scroll height and force a fresh render for current viewport
    const viewportW = this.container.clientWidth;
    const gap = this.card.gap ?? 12;
    const cols = Math.max(1, Math.floor((viewportW + gap) / (this.card.width + gap)));
    const rowH = this.card.height + gap;
    const totalRows = Math.ceil(this.items.length / cols);
    this._padding.style.height = `${Math.max(0, totalRows * rowH)}px`;
    this._render();
  }

  /** Cleanup all listeners and nodes */
  destroy() {
    try { Logger.debug('VGrid.destroy'); } catch (_) {}
    this.container.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
    try { this._ro?.disconnect(); } catch (e) {}
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this.container.innerHTML = '';
    this._mounted.clear();
  }

  _onScroll() { this._render(); }
  _onResize() { this._render(); }

  _render() {    
    // Grid mode is required - card configuration must be provided
    if (!this.card || !this.card.width || !this.card.height) {
      const error = 'VirtualGridManager requires card configuration (width, height) for grid mode';
      try { Logger.error('VGrid.render', { error, card: this.card }); } catch (_) {}
      console.error('[fa-nexus]', error, this.card);
      return;
    }
      const gap = this.card.gap ?? 12;
      const viewportW = this.container.clientWidth;
      // Choose columns based on desired base width; then stretch cards to fill available width
      const cols = Math.max(1, Math.floor((viewportW + gap) / (this.card.width + gap)));
      const innerWidth = Math.max(0, viewportW - gap * (cols + 1));
      const colWidth = Math.max(1, Math.floor(innerWidth / cols));
      if (cols !== this._lastCols || colWidth !== this._lastColWidth) {
        // Record new layout metrics but do not clear mounted nodes.
        // We'll simply reposition existing nodes to avoid flicker during resize.
        this._lastCols = cols;
        this._lastColWidth = colWidth;
      }
      const rowH = this.card.height + gap;
      const totalRows = Math.ceil(this.items.length / cols);
      // Update padding height to full virtual content height
      this._padding.style.height = `${Math.max(0, totalRows * rowH)}px`;

      const scrollTop = this.container.scrollTop;
      const viewportH = this.container.clientHeight;
      const startRow = Math.max(0, Math.floor(scrollTop / rowH) - this.overscan);
      const endRow = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportH) / rowH) + this.overscan);
      const startIndex = startRow * cols;
      const endIndex = Math.min(this.items.length - 1, (endRow + 1) * cols - 1);

      // Unmount outside range
      for (const [idx, el] of this._mounted) {
        if (idx < startIndex || idx > endIndex) {
          try { if (typeof this.onUnmountItem === 'function') this.onUnmountItem(el, this.items[idx], idx); } catch (_) {}
          el.remove();
          this._mounted.delete(idx);
        }
      }

      // Mount visible range
      for (let i = startIndex; i <= endIndex; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        const top = row * rowH + gap * 0.5;
        const left = col * (colWidth + gap) + gap * 0.5;
        if (!this._mounted.has(i)) {
          const el = this.createRow(this.items[i], i);
          el.classList.add('fa-nexus-card');
          el.style.top = `${top}px`;
          el.style.left = `${left}px`;
          el.style.width = `${colWidth}px`;
          el.style.height = `${this.card.height}px`;
          this.container.appendChild(el);
          this._mounted.set(i, el);
          try { if (typeof this.onMountItem === 'function') this.onMountItem(el, this.items[i], i); } catch (_) {}
        } else {
          const el = this._mounted.get(i);
          el.style.top = `${top}px`;
          el.style.left = `${left}px`;
          el.style.width = `${colWidth}px`;
          el.style.height = `${this.card.height}px`;
        }
      }
  }
}

