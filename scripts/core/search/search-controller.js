import { NexusLogger as Logger } from '../nexus-logger.js';

/**
 * SearchController
 * Manages search input, debouncing, and per-tab state for FA Nexus
 */
export class SearchController {
  constructor(app) {
    this.app = app;
    this._searchDebounceId = null;
    this._tabSearch = {};
    this._events = null;
  }

  /**
   * Initialize search functionality
   * @param {EventManager} events - Shared event manager
   */
  initialize(events) {
    this._events = events;
    this._ensureTabSearchStore();
    this._wireSearchInput();
  }

  /**
   * Ensure tab search store exists with default values
   * @private
   */
  _ensureTabSearchStore() {
    if (!this._tabSearch || typeof this._tabSearch !== 'object') this._tabSearch = {};
    if (!Object.prototype.hasOwnProperty.call(this._tabSearch, 'tokens')) this._tabSearch.tokens = '';
    if (!Object.prototype.hasOwnProperty.call(this._tabSearch, 'assets')) this._tabSearch.assets = '';
    if (!Object.prototype.hasOwnProperty.call(this._tabSearch, 'textures')) this._tabSearch.textures = '';
    if (!Object.prototype.hasOwnProperty.call(this._tabSearch, 'paths')) this._tabSearch.paths = '';
  }

  /**
   * Wire up search input event handlers
   * @private
   */
  _wireSearchInput() {
    if (!this._events || !this.app.element) return;

    const searchInput = this.app.element.querySelector('#fa-nexus-search');
    const searchWrap = this.app.element.querySelector('.fa-nexus-search-input');
    const searchIcon = searchWrap?.querySelector('.fa-search');
    const clearBtn = searchWrap?.querySelector('.clear-search');
    const clearFoldersBtn = searchWrap?.querySelector('.clear-folders');

    if (!searchInput) return;

    // Helper to reflect UI state
    const updateSearchUI = () => {
      const hasText = !!searchInput.value.trim();
      if (searchIcon) searchIcon.style.display = hasText ? 'none' : 'unset';
      if (clearBtn) clearBtn.style.display = hasText ? 'unset' : 'none';
      searchWrap?.classList.toggle('has-text', hasText);
      this.updateFolderIndicator();
    };

    // Populate input from current tab's saved query
    try {
      const currentTab = this.app._activeTab || 'tokens';
      searchInput.value = String(this._tabSearch[currentTab] || '');
    } catch (_) {}
    updateSearchUI();

    let debounceId = null;

    // Handle input with debouncing
    this._events.on(searchInput, 'input', () => {
      updateSearchUI();
      if (debounceId) this._events.clearTimeout(debounceId);

      // Capture tab at the time of input to avoid cross-tab application on fast switches
      const tabAtInput = this.app._activeTab || 'tokens';
      debounceId = this._events.setTimeout(() => {
        const query = searchInput.value.trim();
        // Save per-tab using the tab where the input originated
        this._ensureTabSearchStore();
        this._tabSearch[tabAtInput] = query;
        // Only apply if the same tab is still active; otherwise the new tab will handle its own apply
        if (this.app._activeTab === tabAtInput) {
          try { this.app._activeTabObj?.applySearch?.(query); } catch (_) {}
        }
      }, 250);
    });

    // Handle clear search button
    if (clearBtn) {
      this._events.on(clearBtn, 'click', (ev) => {
        ev.preventDefault();
        searchInput.value = '';
        updateSearchUI();
        const tabAtClick = this.app._activeTab || 'tokens';
        this._ensureTabSearchStore();
        this._tabSearch[tabAtClick] = '';
        // Only apply clear on current tab; switching tabs will restore their own query
        if (this.app._activeTab === tabAtClick) {
          try { this.app._activeTabObj?.applySearch?.(''); } catch (_) {}
        }
        try { searchInput.focus(); } catch (_) {}
      });
    }

    // Handle clear folders button
    if (clearFoldersBtn) {
      this._events.on(clearFoldersBtn, 'click', (ev) => {
        ev.preventDefault();
        this.app.clearFolderSelections?.(this.app._activeTab || 'tokens');
      });
    }
  }

  /**
   * Apply search query to a specific tab
   * @param {string} tabId - Tab identifier
   * @param {string} query - Search query
   */
  applySearchToTab(tabId, query) {
    if (!tabId) return;
    this._ensureTabSearchStore();
    this._tabSearch[tabId] = query;

    // Update UI if this is the active tab
    if (this.app._activeTab === tabId && this.app.element) {
      const searchInput = this.app.element.querySelector('#fa-nexus-search');
      if (searchInput) {
        searchInput.value = query;
        this._updateSearchUI();
      }
    }

    // Apply to tab if it's active
    if (this.app._activeTab === tabId) {
      try { this.app._activeTabObj?.applySearch?.(query); } catch (_) {}
    }
  }

  /**
   * Clear search for a specific tab
   * @param {string} tabId - Tab identifier
   */
  clearSearch(tabId) {
    this.applySearchToTab(tabId, '');
  }

  /**
   * Update search UI elements to reflect current state
   * @private
   */
  _updateSearchUI() {
    if (!this.app.element) return;

    const searchWrap = this.app.element.querySelector('.fa-nexus-search-input');
    const searchIcon = searchWrap?.querySelector('.fa-search');
    const clearBtn = searchWrap?.querySelector('.clear-search');
    const searchInput = this.app.element.querySelector('#fa-nexus-search');

    if (!searchInput) return;

    const hasText = !!searchInput.value.trim();
    if (searchIcon) searchIcon.style.display = hasText ? 'none' : 'unset';
    if (clearBtn) clearBtn.style.display = hasText ? 'unset' : 'none';
  }

  /**
   * Update the search bar to show folder selection indicator
   */
  updateFolderIndicator() {
    try {
      if (!this.app.element) return;

      const searchWrap = this.app.element.querySelector('.fa-nexus-search-input');
      if (!searchWrap) return;

      const tabId = this.app._activeTab || 'tokens';
      const controller = this.app._folderFilterController || this.app._folderBrowserController;
      const folderSelection = controller?.getSelectionForTab?.(tabId) || null;

      // Check if folders are selected (not "all" type or has includes/excludes)
      const hasFolderFilter = controller?.hasActiveFilter?.(tabId) ?? false;

      // Add/remove folder indicator class
      searchWrap.classList.toggle('has-folder-filter', !!hasFolderFilter);

      Logger.debug('Updated search bar folder indicator:', { tabId, hasFolderFilter, folderSelection });
    } catch (e) {
      Logger.error('Failed to update search bar folder indicator:', e);
    }
  }

  /**
   * Handle tab switch - update search input to show tab's saved query
   * @param {string} tabId - New active tab
   */
  onTabSwitched(tabId) {
    if (!this.app.element) return;

    const searchInput = this.app.element.querySelector('#fa-nexus-search');
    if (!searchInput) return;

    this._ensureTabSearchStore();
    const query = String(this._tabSearch[tabId] || '');
    searchInput.value = query;
    this._updateSearchUI();
  }

  /**
   * Get search query for a specific tab
   * @param {string} tabId - Tab identifier
   * @returns {string} Search query
   */
  getSearchQuery(tabId) {
    this._ensureTabSearchStore();
    return this._tabSearch[tabId] || '';
  }

  /**
   * Cleanup event handlers
   */
  cleanup() {
    if (this._searchDebounceId) {
      try { this._events?.clearTimeout?.(this._searchDebounceId); } catch (_) {}
      this._searchDebounceId = null;
    }
    // Event cleanup is handled by the shared EventManager
  }
}
