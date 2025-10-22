import { NexusLogger as Logger } from '../nexus-logger.js';

/**
 * GridManager
 * Manages grid loading states, placeholders, and virtual grid for FA Nexus
 */
export class GridManager {
  constructor(app) {
    this.app = app;
    this._gridLoader = null;
    this._gridPlaceholder = null;
    this._suppressGridPlaceholder = true;
    this._grid = null;
  }

  /**
   * Show a loading overlay on the grid
   * @param {string} message - Loading message to display
   * @param {object} options - Options
   * @param {any} options.owner - Owner identifier for the loader
   * @returns {HTMLElement|null} The loader element
   */
  showGridLoader(message = '', { owner = null } = {}) {
    const root = this.app.element;
    if (!root) return null;

    // If another loader is active and owned by a different owner, hide it first
    if (this._gridLoader?.owner && owner && this._gridLoader.owner !== owner) {
      this.hideGridLoader(this._gridLoader.owner);
    }

    this.hideGridPlaceholder(owner);

    const body = root.querySelector('.fa-nexus-body');
    const grid = root.querySelector('#fa-nexus-grid');
    const footer = root.querySelector('.fa-nexus-footer');

    if (!grid || !body) return null;

    let loader = root.querySelector('.fa-nexus-grid-loader');
    if (!loader) {
      loader = document.createElement('div');
      loader.className = 'fa-nexus-grid-loader';
      loader.innerHTML = '<div class="fa-nexus-loading"><i class="fas fa-spinner fa-spin"></i><span class="text"></span></div>';
      if (footer && footer.parentElement === body) {
        body.insertBefore(loader, footer);
      } else {
        grid.parentElement?.insertBefore(loader, grid.nextSibling);
      }
    }

    const textEl = loader.querySelector('.text');
    if (textEl && typeof message === 'string') textEl.textContent = message;

    loader.dataset.owner = owner || '';
    loader.dataset.visible = 'true';
    loader.style.display = '';

    grid.style.display = 'none';

    this._gridLoader = { element: loader, owner: owner || null };
    return loader;
  }

  /**
   * Update the loading message on an existing loader
   * @param {string} message - New loading message
   * @param {object} options - Options
   * @param {any} options.owner - Owner identifier
   */
  updateGridLoader(message = '', { owner = null } = {}) {
    const state = this._gridLoader;
    if (!state?.element) return;
    if (owner && state.owner && state.owner !== owner) return;

    const textEl = state.element.querySelector('.text');
    if (textEl && typeof message === 'string') textEl.textContent = message;
  }

  /**
   * Hide the loading overlay
   * @param {any} owner - Owner identifier
   */
  hideGridLoader(owner = null) {
    const state = this._gridLoader;
    if (!state?.element) return;
    if (owner && state.owner && state.owner !== owner) return;

    const loader = state.element;
    loader.remove();

    const grid = this.app.element?.querySelector('#fa-nexus-grid');
    if (grid) grid.style.display = '';

    // Animate grid visibility restoration
    if (grid) {
      const restoreVisibility = () => {
        try {
          this._grid?._onResize?.();
          this._grid?._onScroll?.();
        } catch (_) {}
        if (grid.dataset.faPendingReveal === 'phase1') {
          grid.dataset.faPendingReveal = 'phase2';
          return;
        }
        if (grid.dataset.faPendingReveal === 'phase2') {
          const prevVisibility = grid.dataset.faPrevVisibility ?? '';
          if (prevVisibility) {
            grid.style.visibility = prevVisibility;
          } else {
            grid.style.removeProperty('visibility');
          }
          delete grid.dataset.faPrevVisibility;
          delete grid.dataset.faPendingReveal;
        }
      };

      grid.dataset.faPendingReveal = 'phase1';
      if (grid.dataset.faPrevVisibility === undefined) {
        grid.dataset.faPrevVisibility = grid.style.visibility || '';
        if (!grid.style.visibility) grid.style.visibility = 'hidden';
      }

      const scheduleReveal = (cb) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(cb);
        } else {
          cb();
        }
      };

      scheduleReveal(() => {
        restoreVisibility();
        scheduleReveal(restoreVisibility);
      });
    }

    this._gridLoader = null;
  }

  /**
   * Check if the grid loader is owned by a specific owner
   * @param {any} owner - Owner identifier
   * @returns {boolean} True if the loader is owned by the specified owner
   */
  isGridLoaderOwnedBy(owner) {
    return !!owner && !!this._gridLoader && this._gridLoader.owner === owner;
  }

  /**
   * Show a skeleton placeholder for the grid
   * @param {object} options - Placeholder options
   * @param {string} options.tab - Tab identifier
   * @param {number} options.width - Card width
   * @param {number} options.height - Card height
   * @param {number} options.gap - Gap between cards
   */
  showGridPlaceholder({ tab = null, width, height, gap } = {}) {
    if (this._suppressGridPlaceholder) return;

    const root = this.app.element;
    if (!root) return;

    const main = root.querySelector('.fa-nexus-main');
    const grid = root.querySelector('#fa-nexus-grid');

    if (!main || !grid) return;

    let placeholder = main.querySelector('.fa-nexus-grid-placeholder');
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'fa-nexus-grid-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      main.appendChild(placeholder);
    }

    const metrics = this._resolvePlaceholderMetrics({ width, height, gap });
    this._applyGridPlaceholderMetrics(placeholder, metrics);
    this._ensurePlaceholderContent(placeholder);
    this._syncGridPlaceholderLayout(placeholder);

    try { cancelAnimationFrame(placeholder._faLayoutRaf); } catch (_) {}
    placeholder._faLayoutRaf = requestAnimationFrame(() => this._syncGridPlaceholderLayout(placeholder));

    placeholder.dataset.visible = 'true';
    placeholder.dataset.owner = tab || '';

    this._gridPlaceholder = { element: placeholder, owner: tab || null, config: metrics };
  }

  /**
   * Update the size of the grid placeholder
   * @param {object} options - Size options
   * @param {string} options.tab - Tab identifier
   * @param {number} options.width - Card width
   * @param {number} options.height - Card height
   * @param {number} options.gap - Gap between cards
   */
  updateGridPlaceholderSize({ tab = null, width, height, gap } = {}) {
    const state = this._gridPlaceholder;
    if (!state?.element) return;
    if (tab && state.owner && state.owner !== tab) return;

    const metrics = this._resolvePlaceholderMetrics({ width, height, gap }, state.config);
    this._applyGridPlaceholderMetrics(state.element, metrics);
    this._ensurePlaceholderContent(state.element);
    this._syncGridPlaceholderLayout(state.element);

    try { cancelAnimationFrame(state.element._faLayoutRaf); } catch (_) {}
    state.element._faLayoutRaf = requestAnimationFrame(() => this._syncGridPlaceholderLayout(state.element));

    state.config = metrics;
  }

  /**
   * Hide the grid placeholder
   * @param {string} tab - Tab identifier
   */
  hideGridPlaceholder(tab = null) {
    const state = this._gridPlaceholder;
    if (!state?.element) return;
    if (tab && state.owner && state.owner !== tab) return;

    try { cancelAnimationFrame(state.element._faLayoutRaf); } catch (_) {}
    state.element.dataset.visible = 'false';
    state.element.dataset.owner = '';

    this._gridPlaceholder = { element: state.element, owner: null, config: state.config };
  }

  /**
   * Release initial grid placeholder suppression
   */
  releaseInitialGridPlaceholderSuppression() {
    if (!this._suppressGridPlaceholder) return;
    this._suppressGridPlaceholder = false;
  }

  /**
   * Resolve placeholder metrics from requested values and fallbacks
   * @private
   * @param {object} requested - Requested metrics
   * @param {object} fallback - Fallback metrics
   * @returns {object} Resolved metrics
   */
  _resolvePlaceholderMetrics(requested = {}, fallback = null) {
    const base = fallback || {
      width: 120,
      height: 140,
      gap: 12
    };

    const width = Number(requested?.width) || base.width;
    const height = Number(requested?.height) || base.height;
    const gap = Number.isFinite(requested?.gap) ? Number(requested.gap) : (Number.isFinite(base.gap) ? base.gap : 12);

    return {
      width: Math.max(32, Math.round(width)),
      height: Math.max(32, Math.round(height)),
      gap: Math.max(2, Math.round(gap))
    };
  }

  /**
   * Apply placeholder metrics as CSS custom properties
   * @private
   * @param {HTMLElement} element - Placeholder element
   * @param {object} metrics - Metrics to apply
   */
  _applyGridPlaceholderMetrics(element, metrics) {
    if (!element || !metrics) return;
    element.style.setProperty('--fa-nexus-skeleton-card-width', `${metrics.width}px`);
    element.style.setProperty('--fa-nexus-skeleton-card-height', `${metrics.height}px`);
    element.style.setProperty('--fa-nexus-skeleton-card-gap', `${metrics.gap}px`);
  }

  /**
   * Ensure the placeholder has the correct number of skeleton cards
   * @private
   * @param {HTMLElement} element - Placeholder element
   */
  _ensurePlaceholderContent(element) {
    if (!element) return;
    const desired = 64;
    const count = element.childElementCount;
    if (count === desired) return;

    if (count > desired) {
      while (element.childElementCount > desired) {
        element.lastElementChild?.remove?.();
      }
      return;
    }

    while (element.childElementCount < desired) {
      const card = document.createElement('div');
      card.className = 'fa-nexus-grid-placeholder__card';
      element.appendChild(card);
    }
  }

  /**
   * Sync placeholder layout to match grid positioning
   * @private
   * @param {HTMLElement} placeholder - Placeholder element
   */
  _syncGridPlaceholderLayout(placeholder) {
    if (!placeholder) return;

    const root = this.app.element;
    const main = root?.querySelector('.fa-nexus-main');
    const grid = root?.querySelector('#fa-nexus-grid');

    if (!main || !grid) return;

    const mainRect = main.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();

    if (!mainRect || !gridRect) return;

    const left = gridRect.left - mainRect.left;
    const top = gridRect.top - mainRect.top;
    const width = gridRect.width;
    const height = gridRect.height;

    if (Number.isFinite(left)) placeholder.style.left = `${Math.max(0, left)}px`;
    if (Number.isFinite(top)) placeholder.style.top = `${Math.max(0, top)}px`;
    if (Number.isFinite(width)) {
      placeholder.style.width = `${Math.max(0, width)}px`;
      placeholder.style.right = 'auto';
    }
    if (Number.isFinite(height)) {
      placeholder.style.height = `${Math.max(0, height)}px`;
      placeholder.style.bottom = 'auto';
    }
  }

  /**
   * Get the current virtual grid instance
   * @returns {VirtualGridManager|null} The grid instance
   */
  getGrid() {
    return this._grid;
  }

  /**
   * Set the virtual grid instance
   * @param {VirtualGridManager} grid - The grid instance
   */
  setGrid(grid) {
    // Clean up existing grid if different
    if (this._grid && this._grid !== grid) {
      try { this._grid.destroy(); } catch (_) {}
    }
    this._grid = grid;
  }

  /**
   * Destroy the current grid
   */
  destroyGrid() {
    if (this._grid) {
      try { this._grid.destroy(); } catch (_) {}
      this._grid = null;
    }
  }

  /**
   * Cleanup all grid manager resources
   */
  cleanup() {
    this.hideGridLoader();
    this.hideGridPlaceholder();
    this.destroyGrid();

    // Clean up any pending animation frames
    if (this._gridPlaceholder?.element?._faLayoutRaf) {
      try { cancelAnimationFrame(this._gridPlaceholder.element._faLayoutRaf); } catch (_) {}
    }
  }
}
