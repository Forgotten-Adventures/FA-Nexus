import { NexusLogger as Logger } from '../../nexus-logger.js';
import { sceneGroupIconClass } from '../../../composition/scene-group-icons.js';

function normalizeSearchTabDefinition(definition = {}) {
  if (!definition || typeof definition !== 'object') return null;
  const id = String(definition.id || '').trim();
  if (!id) return null;
  const searchApplyOptions = definition.searchApplyOptions && typeof definition.searchApplyOptions === 'object'
    ? { ...definition.searchApplyOptions }
    : null;
  return Object.freeze({ id, searchApplyOptions });
}

/**
 * SearchController
 * Manages search input, debouncing, and per-tab state for FA Nexus
 */
export class SearchController {
  constructor(app, { tabDefinitions = [], defaultTabId = '' } = {}) {
    this.app = app;
    const definitions = tabDefinitions.map(normalizeSearchTabDefinition).filter(Boolean);
    const seenTabIds = new Set();
    for (const definition of definitions) {
      if (seenTabIds.has(definition.id)) {
        throw new Error(`SearchController received duplicate tab definition: ${definition.id}`);
      }
      seenTabIds.add(definition.id);
    }
    this._tabDefinitions = definitions;
    if (!this._tabDefinitions.length) {
      throw new Error('SearchController requires at least one tab definition.');
    }
    this._defaultTabId = this._tabDefinitions.some((definition) => definition.id === defaultTabId)
      ? defaultTabId
      : this._tabDefinitions[0].id;
    this._searchApplyOptionsByTab = new Map(this._tabDefinitions
      .filter((definition) => definition.searchApplyOptions)
      .map((definition) => [definition.id, definition.searchApplyOptions]));
    this._searchDebounceId = null;
    this._tabSearch = {};
    this._events = null;
    this._renderCleanup = [];
  }

  /**
   * Initialize search functionality
   * @param {EventManager} events - Shared event manager
   */
  initialize(events) {
    this._events = events;
    this._ensureTabSearchStore();
    this._cleanupRenderBindings();
    this._wireSearchInput();
  }

  /**
   * Ensure tab search store exists with default values
   * @private
   */
  _ensureTabSearchStore() {
    if (!this._tabSearch || typeof this._tabSearch !== 'object') this._tabSearch = {};
    for (const definition of this._tabDefinitions) {
      if (!Object.prototype.hasOwnProperty.call(this._tabSearch, definition.id)) {
        this._tabSearch[definition.id] = '';
      }
    }
  }

  _getSearchApplyOptions(tabId, extraOptions = null) {
    const base = this._searchApplyOptionsByTab.get(String(tabId || '').trim());
    if (!base && !extraOptions) return undefined;
    return { ...(base || {}), ...(extraOptions || {}) };
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
      const currentTab = this.app._activeTab || this._defaultTabId;
      searchInput.value = String(this._tabSearch[currentTab] || '');
    } catch (_) {}
    updateSearchUI();

    // Handle input with debouncing
    const onInput = () => {
      updateSearchUI();
      if (this._searchDebounceId) this._events.clearTimeout(this._searchDebounceId);

      // The tab and the text at the time of input: a tab switch replaces the text of this box with the other
      // tab's search, and a pause that read the box afterwards saved that text for the tab the user had typed in.
      const tabAtInput = this.app._activeTab || this._defaultTabId;
      const typed = searchInput.value;
      const apply = () => {
        this._pendingSearchApply = null;
        const query = typed.trim();
        // Save per-tab using the tab where the input originated
        this._ensureTabSearchStore();
        this._tabSearch[tabAtInput] = query;
        // Only apply if the same tab is still active; otherwise the new tab will handle its own apply
        if (this.app._activeTab === tabAtInput) {
          const applyOptions = this._getSearchApplyOptions(tabAtInput);
          try {
            this.app._activeTabObj?.applySearch?.(query, applyOptions);
          } catch (error) {
            Logger.warn('SearchController.applySearch.failed', {
              tabId: tabAtInput,
              query,
              error
            });
          }
        }
        this._searchDebounceId = null;
      };
      this._pendingSearchApply = apply;
      this._searchDebounceId = this._events.setTimeout(apply, 250);
    };
    searchInput.addEventListener('input', onInput);
    this._renderCleanup.push(() => {
      try { searchInput.removeEventListener('input', onInput); } catch (_) {}
    });

    // Handle clear search button
    if (clearBtn) {
      const onClear = (ev) => {
        ev.preventDefault();
        searchInput.value = '';
        updateSearchUI();
        const tabAtClick = this.app._activeTab || this._defaultTabId;
        this._ensureTabSearchStore();
        this._tabSearch[tabAtClick] = '';
        // Only apply clear on current tab; switching tabs will restore their own query
        if (this.app._activeTab === tabAtClick) {
          const applyOptions = this._getSearchApplyOptions(tabAtClick);
          try {
            this.app._activeTabObj?.applySearch?.('', applyOptions);
          } catch (error) {
            Logger.warn('SearchController.clearSearch.failed', {
              tabId: tabAtClick,
              error
            });
          }
        }
        try { searchInput.focus(); } catch (_) {}
      };
      clearBtn.addEventListener('click', onClear);
      this._renderCleanup.push(() => {
        try { clearBtn.removeEventListener('click', onClear); } catch (_) {}
      });
    }

    // Handle clear folders button
    if (clearFoldersBtn) {
      const onClearFolders = (ev) => {
        ev.preventDefault();
        if (this.app._collections?.active) {
          this.app._collections.run(() => this.app._collections.selectScope('collections', null));
          return;
        }
        this.app.clearFolderSelections?.(this.app._activeTab || this._defaultTabId);
      };
      clearFoldersBtn.addEventListener('click', onClearFolders);
      this._renderCleanup.push(() => {
        try { clearFoldersBtn.removeEventListener('click', onClearFolders); } catch (_) {}
      });
    }
  }

  /**
   * Apply search query to a specific tab
   * @param {string} tabId - Tab identifier
   * @param {string} query - Search query
   */
  applySearchToTab(tabId, query, options = {}) {
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
    const shouldApply = options.apply !== false;
    if (this.app._activeTab === tabId && shouldApply) {
      const applyOptions = this._getSearchApplyOptions(tabId, options);
      try {
        this.app._activeTabObj?.applySearch?.(query, applyOptions);
      } catch (error) {
        Logger.warn('SearchController.applySearchToTab.failed', {
          tabId,
          query,
          error
        });
      }
    }
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

      const tabId = this.app._activeTab || this._defaultTabId;
      const controller = this.app._folderFilterController;
      const folderSelection = controller?.getSelectionForTab?.(tabId) || null;

      // Check if folders are selected (not "all" type or has includes/excludes)
      const collections = this.app._collections;
      const hasFolderFilter = collections?.active ? !!collections.state.selectedId : controller?.hasActiveFilter?.(tabId) ?? false;
      const entry = collections?.library.collections.find(entry => entry.id === collections.state.selectedId);
      const clear = searchWrap.querySelector('.clear-folders');
      if (clear) {
        clear.title = collections?.active ? `Clear Collection: ${entry?.name || 'Unavailable'}` : 'Clear folder filters';
        clear.setAttribute('aria-label', clear.title);
        if (clear.firstElementChild) clear.firstElementChild.className = collections?.active ? sceneGroupIconClass(entry?.icon, 'fa-folder') : 'fas fa-folder';
        clear.style.color = collections?.active ? entry?.color || '' : '';
      }

      // Add/remove folder indicator class
      searchWrap.classList.toggle('has-folder-filter', !!hasFolderFilter);

      Logger.debug('Updated search bar folder indicator:', { tabId, hasFolderFilter, folderSelection });
    } catch (e) {
      Logger.debug('Failed to update search bar folder indicator:', e);
    }
  }

  /**
   * Apply a typed search that is still waiting for its pause, now. A tab switch calls this before the tab is left,
   * so the search is applied to, and saved for, the tab it was typed in.
   * @returns {boolean} whether a search was waiting
   */
  flushPendingSearch() {
    const apply = this._pendingSearchApply;
    if (typeof apply !== 'function') return false;
    if (this._searchDebounceId) this._events?.clearTimeout?.(this._searchDebounceId);
    this._searchDebounceId = null;
    apply();
    return true;
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
    this._cleanupRenderBindings();
    this._events = null;
  }

  _cleanupRenderBindings() {
    if (this._searchDebounceId) {
      try { this._events?.clearTimeout?.(this._searchDebounceId); } catch (_) {}
      this._searchDebounceId = null;
    }
    this._pendingSearchApply = null;
    while (this._renderCleanup.length) {
      const off = this._renderCleanup.pop();
      try { off?.(); } catch (_) {}
    }
  }
}
