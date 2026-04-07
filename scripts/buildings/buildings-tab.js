import { AssetsTab } from '../assets/assets-tab.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { VirtualGridManager } from '../core/ui/virtual-grid-manager.js';
import { BookmarkToolbar } from '../core/bookmarks/bookmark-toolbar.js';
import { BuildingManager } from './building-manager.js';
import './building-tiles.js';

const MODULE_ID = 'fa-nexus';
const SETTING_ACTIVE_SUBTAB = 'buildingsActiveSubtab';
const SETTING_SEARCH_STATE = 'buildingsSubtabSearch';
const BUILDING_TEXTURE_BOOKMARK_TAB = 'buildings:textures';
const BUILDING_TEXTURE_THUMB_SETTING = 'thumbWidthBuildingTextures';
const DEFAULT_SUBTAB = 'building';
const SUBTABS = Object.freeze(['building', 'portals']);
const SUBTAB_LABELS = Object.freeze({
  building: 'Walls',
  portals: 'Portals'
});
const PORTAL_TYPES = Object.freeze({
  door: { id: 'door', label: 'Add Door', icon: 'fa-door-closed', tooltip: 'Insert animated Foundry doors' },
  window: { id: 'window', label: 'Add Window', icon: 'fa-border-all', tooltip: 'Insert windows with sill, glass, and frame' },
  gap: { id: 'gap', label: 'Add Gap', icon: 'fa-expand', tooltip: 'Insert gaps in walls' }
});
const GAP_KIND_GAP = 'gap';
const GAP_KIND_DOOR = 'door';
const GAP_KIND_WINDOW = 'window';
const WALL_BIAS_QUERY = 'wall';
const TEXTURE_DEPRIORITIZED_PATH_TOKEN = '!wilderness';
const TEXTURE_DEPRIORITIZED_NAME_TOKENS = Object.freeze(['roof', 'grate', 'overlay']);
const WALL_SEGMENT_TOKENS = Object.freeze(['wall', 'walls']);
const WALL_SEGMENT_PATTERN = /^walls?(?![_-]?hangings)/;
const NONE_TEXTURE_KEY = '__fa-nexus__/fill-none';
const NONE_TEXTURE_ITEM = Object.freeze({
  id: '__fa-nexus-building-fill-none',
  file_path: NONE_TEXTURE_KEY,
  path: NONE_TEXTURE_KEY,
  filename: 'None',
  displayName: 'No Fill',
  source: 'local',
  tier: 'free',
  isNoneTexture: true
});
const PORTAL_TEXTURE_MISSING_RETRY_MS = 15000;

function loadSetting(key, fallback) {
  try {
    if (!game?.settings?.storage) return fallback;
    const value = game.settings.get(MODULE_ID, key);
    if (value === undefined || value === null) return fallback;
    return value;
  } catch (error) {
    Logger?.warn?.('BuildingsTab.loadSetting.failed', { key, error });
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    if (!game?.settings?.storage) return;
    game.settings.set(MODULE_ID, key, value);
  } catch (error) {
    Logger?.warn?.('BuildingsTab.saveSetting.failed', { key, error });
  }
}

function isBenignBuildingCommitError(error) {
  const message = String(error?.message || error || '').trim();
  return message === 'No geometry to commit' || message === 'Missing wall texture';
}

export class BuildingsTab extends AssetsTab {
  constructor(app) {
    super(app, { mode: 'assets' });
    this._tabId = 'buildings';
    this._activeSubtab = this._loadInitialSubtab();
    this._subtabSearch = this._loadSubtabSearch();
    this._boundButtonHandlers = new Map();
    this._subtabContainer = null;
    this._gridWrapper = null;
    this._texturesGrid = null;
    this._texturesGridContainer = null;
    this._pathsSection = null;
    this._texturesSection = null;
    this._pathsShown = 0;
    this._texturesShown = 0;
    this._noneTextureItem = NONE_TEXTURE_ITEM;
    this._selectedOuterWallPathKey = '';
    this._selectedFillTextureKey = NONE_TEXTURE_KEY;
    this._buildingManager = null;
    this._boundEscapeHandler = (event) => this._handleGlobalKeydown(event);
    this._escapeListenerAttached = false;
    this._escapeListenerTarget = null;
    this._cards.handleAssetCardClick = (event, card, item) => {
      try {
        const result = this._handleBuildingAssetCardClick(event, card, item);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => Logger.warn?.('BuildingsTab.assetClick.failed', { error: String(error?.message || error) }));
        }
      } catch (error) {
        Logger.warn?.('BuildingsTab.assetClick.syncFailed', { error: String(error?.message || error) });
      }
    };
    this._cards.handleTextureCardClick = async () => {}; // building tool hijacks texture selection, disable paint
    this._cards.handlePathCardClick = async () => {}; // defer to building tool placement flow later
    this._resetTextureControlsState();
    this._textureSearchHandlers = [];
    this._textureSearchDebounceId = null;
    this._textureBookmarkToolbar = null;
    this._textureSearchAdapter = null;
    this._folderSelectionScope = null;
    this._textureHoverHandlers = null;
    this._gridSplitRatio = 0.6;
    this._gridResizer = null;
    this._gridResizerHandlers = null;
    this._gridResizerDragCleanup = null;
    // Portal panel state
    this._portalPanel = null;
    this._portalPanelHandlers = null;
    this._activePortalType = GAP_KIND_DOOR; // Default to door per plan
    this._portalToolOptionsCallback = null;
    this._portalPreviewImageCache = new Map();
    this._portalPreviewMissingCache = new Map();
    this._portalPreviewRenderSeq = 0;
    this._portalPanelCanUse = null;
    this._portalPreviewSignature = null;
  }

  setFolderSelectionScope(scope) {
    if (scope === 'textures') this._folderSelectionScope = 'textures';
    else if (scope === 'paths') this._folderSelectionScope = 'paths';
    else this._folderSelectionScope = null;
  }

  get id() { return this._tabId; }

  get buildingManager() {
    return this._getBuildingManager();
  }

  _loadInitialSubtab() {
    // Opening the Building Tool should always land on Walls.
    return DEFAULT_SUBTAB;
  }

  _loadSubtabSearch() {
    const stored = loadSetting(SETTING_SEARCH_STATE, {});
    if (!stored || typeof stored !== 'object') return {};
    const clone = { ...stored };
    if (Object.prototype.hasOwnProperty.call(clone, 'subtab:building') &&
      !Object.prototype.hasOwnProperty.call(clone, 'subtab:building:paths')) {
      clone['subtab:building:paths'] = clone['subtab:building'];
    }
    clone['subtab:building:textures'] = '';
    return clone;
  }

  async onActivate() {
    await super.onActivate();
    if (!this.app || this.app._activeTab !== this.id) return;
    this._setActiveSubtab(DEFAULT_SUBTAB, { silent: true });
    this._syncSearchField({ apply: false });
  }

  onDeactivate() {
    this._stopBuildingSession({ reason: 'tab-deactivate' });
    super.onDeactivate();
    this._teardownSubtabListeners();
    this._destroyPortalPanel();
    try { this._texturesGrid?.destroy?.(); } catch (_) {}
    this._texturesGrid = null;
    this._texturesGridContainer = null;
    this._teardownTextureControls();
    this._uninstallTextureHoverPreview();
    this._teardownGridResizer();
    if (this.app?.element) {
      const main = this.app.element.querySelector('.fa-nexus-main');
      const wrapper = this._gridWrapper || main?.querySelector('.fa-buildings-grid-wrapper');
      const grid = wrapper?.querySelector('#fa-nexus-grid');
      if (wrapper) {
        try {
          const parent = wrapper.parentElement;
          if (grid) {
            grid.classList.remove('fa-buildings-grid');
            const currentParent = grid.parentElement;
            if (currentParent) currentParent.removeChild(grid);
            if (parent) parent.insertBefore(grid, wrapper);
            else {
              const fallback =
                main ||
                this.app?.element ||
                (typeof document !== 'undefined' ? document.body : null);
              if (fallback && !fallback.contains(grid)) fallback.appendChild(grid);
            }
          }
          if (parent) parent.removeChild(wrapper);
          else wrapper.remove();
        } catch (_) {}
      }
    }
    this._gridWrapper = null;
    this._pathsSection = null;
    this._texturesSection = null;
    this._subtabContainer = null;
    this._pathsShown = 0;
    this._texturesShown = 0;
    this._selectedOuterWallPathKey = '';
    this._selectedFillTextureKey = NONE_TEXTURE_KEY;
  }

  _ensureSubtabControls() {
    if (!this.app?.element) return;
    const main = this.app.element.querySelector('.fa-nexus-main');
    if (!main) return;
    const grid = main.querySelector('#fa-nexus-grid');
    if (!grid) return;

    let wrapper = main.querySelector('.fa-buildings-grid-wrapper');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'fa-buildings-grid-wrapper';
      const parent = grid.parentElement;
      if (parent) {
        parent.replaceChild(wrapper, grid);
        wrapper.appendChild(grid);
      }
    }
    this._gridWrapper = wrapper;

    let container = wrapper.querySelector('.fa-buildings-subtabs');
    if (!container) {
      container = document.createElement('div');
      container.className = 'fa-buildings-subtabs';
      container.setAttribute('role', 'tablist');
      wrapper.insertBefore(container, wrapper.firstChild || null);
    }

    if (container === this._subtabContainer && container.childElementCount === SUBTABS.length) {
      this._updateSubtabSelection();
      return;
    }

    container.innerHTML = '';
    this._boundButtonHandlers.forEach((handler, button) => {
      try { button.removeEventListener('click', handler); } catch (_) {}
    });
    this._boundButtonHandlers.clear();

    SUBTABS.forEach((subtab) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.buildingSubtab = subtab;
      button.className = 'fa-buildings-subtab';
      const label = SUBTAB_LABELS[subtab] || (subtab.charAt(0).toUpperCase() + subtab.slice(1));
      button.textContent = label;
      button.setAttribute('aria-selected', subtab === this._activeSubtab ? 'true' : 'false');
      const handler = () => this._setActiveSubtab(subtab);
      button.addEventListener('click', handler);
      this._boundButtonHandlers.set(button, handler);
      if (subtab === 'portals') {
        button.setAttribute('title', 'Cross-session portal placement');
      }
      container.appendChild(button);
    });

    this._subtabContainer = container;
    this._updateSubtabSelection();

    this._ensureGridSections(wrapper, grid);
    this._updateSectionVisibility();
  }

  _teardownSubtabListeners() {
    this._boundButtonHandlers.forEach((handler, button) => {
      try { button.removeEventListener('click', handler); } catch (_) {}
    });
    this._boundButtonHandlers.clear();
  }

  _setActiveSubtab(subtab, { silent = false } = {}) {
    if (!SUBTABS.includes(subtab)) subtab = DEFAULT_SUBTAB;
    const unchanged = this._activeSubtab === subtab;

    this._activeSubtab = subtab;
    saveSetting(SETTING_ACTIVE_SUBTAB, subtab);

    // Always refresh layout so the texture split/resizer tracks the active subtab.
    this._ensureSubtabControls();
    this._updateSubtabSelection();
    this._updateSectionVisibility();
    this._applyGridSplitRatio();
    this._restoreSubtabSelections();
    this._applySubtabThumbSize();

    if (this._buildingManager) {
      if (subtab === 'portals') {
        this._buildingManager.setPortalMode(true);
        // Always default Portals to Door on entry.
        this._activePortalType = null;
        this._setActivePortalType(GAP_KIND_DOOR);
      } else {
        this._buildingManager.setPortalMode(false);
        this._buildingManager.forceExitPortalEditing?.();
      }
    }

    if (silent) return;
    if (unchanged) return;

    this._syncSearchField();
    try { this.applySearch(this.getCurrentSearchValue()); } catch (_) {}
  }

  _applySubtabThumbSize() {
    const grid = this.app?._grid;
    if (!grid || !this.app?.element) return;
    const size = this._getStoredThumbSize?.();
    const dims = this._computeThumbDimensions?.(size);
    if (dims && dims.width && dims.height) {
      try { grid.setCardSize(dims.width, dims.height); } catch (_) {}
      try {
        this.app?.updateGridPlaceholderSize?.({
          tab: this.id,
          width: dims.width,
          height: dims.height,
          gap: this.getGridOptions?.()?.card?.gap ?? 4
        });
      } catch (_) {}
    }
    try { this._bindThumbSizeSlider?.(); } catch (_) {}
  }

  _updateSubtabSelection() {
    if (!this._subtabContainer) return;
    this._subtabContainer.querySelectorAll('.fa-buildings-subtab').forEach((btn) => {
      const subtab = btn.dataset.buildingSubtab;
      const active = subtab === this._activeSubtab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  _syncSearchField({ apply = true } = {}) {
    const activeKey = this._getSubtabSearchKey(this._activeSubtab, 'paths');
    let query = this._subtabSearch[activeKey];
    if (query === undefined && this._activeSubtab === 'building') {
      query = this._getBuildingPathSearch();
    }
    if (query === undefined || query === null) query = '';
    try {
      const controller = this.app?._searchController;
      // Store the query under the real tab id so SearchController updates its input.
      controller?.applySearchToTab?.('buildings', query, { refreshTextures: false, apply });
    } catch (_) {}
  }

  _getSubtabSearchKey(subtab, kind = 'paths') {
    if (subtab === 'building') {
      return kind === 'textures' ? 'subtab:building:textures' : 'subtab:building:paths';
    }
    return `subtab:${subtab}`;
  }

  _getBuildingPathSearch() {
    const key = this._getSubtabSearchKey('building', 'paths');
    if (Object.prototype.hasOwnProperty.call(this._subtabSearch, key)) {
      return this._subtabSearch[key] || '';
    }
    return this._subtabSearch['subtab:building'] || '';
  }

  _getBuildingTextureSearch() {
    const key = this._getSubtabSearchKey('building', 'textures');
    return this._subtabSearch[key] || '';
  }

  filterItems(items, query) {
    return super.filterItems(items, query);
  }

  applySearch(query, options = {}) {
    const key = this._getSubtabSearchKey(this._activeSubtab, 'paths');
    const q = query || '';
    this._subtabSearch[key] = q;
    saveSetting(SETTING_SEARCH_STATE, this._subtabSearch);
    if (this._activeSubtab !== 'building') {
      if (this._texturesGrid) {
        try { this._texturesGrid.setData([]); } catch (_) {}
      }
      this._updateSectionVisibility();
      super.applySearch(query);
      this._restoreSubtabSelections();
      return;
    }

    const scope = this._folderSelectionScope;
    if (scope) this._folderSelectionScope = null;

    let refreshPaths = true;
    let refreshTextures = true;
    if (Object.prototype.hasOwnProperty.call(options, 'refreshPaths')) refreshPaths = !!options.refreshPaths;
    if (Object.prototype.hasOwnProperty.call(options, 'refreshTextures')) refreshTextures = !!options.refreshTextures;

    if (scope === 'textures') {
      refreshPaths = false;
      refreshTextures = true;
    }

    if (!this._texturesGrid && !refreshTextures) refreshTextures = true;

    this._refreshOuterWallsGrids({ pathQuery: q, refreshPaths, refreshTextures });
  }

  _refreshOuterWallsGrids({ pathQuery, refreshPaths = true, refreshTextures = true } = {}) {
    if (!refreshPaths && !refreshTextures) return;
    const qPaths = typeof pathQuery === 'string' ? pathQuery : this._getBuildingPathSearch();
    const qTextures = this._getBuildingTextureSearch();
    this._ensureSubtabControls();

    let pathItems = null;
    if (refreshPaths) {
      this.beforeApplySearch(qPaths);
      pathItems = this._filterOuterWallsItems(qPaths, 'paths');
      this.app?.hideGridPlaceholder?.(this.id);

      if (this.app?._grid) {
        try { this.app._grid.setData(pathItems); } catch (_) {}
        try {
          this.app._grid._onResize?.();
          if (this.app._grid.container) this.app._grid.container.scrollTop = 0;
          this.app._grid._onScroll?.();
        } catch (_) {}
      }
      this._pathsShown = pathItems.length;
    }

    if (refreshTextures) {
      const textureItems = this._filterOuterWallsItems(qTextures, 'textures');
      const texturesWithNone = this._injectNoneTextureItem(textureItems);

    if (!this._texturesGrid && this._texturesGridContainer) {
      const options = this.getGridOptions();
      const textureOptions = this._buildTextureGridOptions(options);
      this._texturesGrid = new VirtualGridManager(this._texturesGridContainer, textureOptions);
      const initialSize = this._getStoredTextureThumbSize();
      try { this._texturesGrid.setCardSize(initialSize, initialSize); } catch (_) {}
      this._installTextureHoverPreview();
    }

      if (this._texturesGrid) {
        try { this._texturesGrid.setData(texturesWithNone); } catch (_) {}
        try {
          this._texturesGrid._onResize?.();
          if (this._texturesGrid.container) this._texturesGrid.container.scrollTop = 0;
          this._texturesGrid._onScroll?.();
        } catch (_) {}
      }

      this._texturesShown = textureItems.length;
      this._refreshVisibleTextureSelection();
      this._syncTextureSearchField();
      this._applyTextureThumbSize(this._getTextureThumbSliderValue());
      this._ensureTextureBookmarkToolbar();
    }

    this._updateSectionVisibility();
    try { this._updateFooterStats(); } catch (_) {}

    if (refreshPaths && pathItems) {
      this.afterApplySearch(pathItems, qPaths);
      this._restoreSubtabSelections();
    }
  }

  _filterOuterWallsItems(query, kind) {
    const allItems = Array.isArray(this._items) ? this._items : [];
    const normalizedQuery = query || '';
    const filtered = AssetsTab.prototype.filterItems.call(this, allItems, normalizedQuery);
    if (kind === 'textures') {
      const textures = filtered.filter((item) => this._isTextureItem?.(item) && !this._isPathsItem?.(item));
      return this._sortFillTextureItems(textures, { query: normalizedQuery });
    }
    const paths = filtered.filter((item) => this._isPathsItem?.(item));
    return this._sortBuildingPathItems(paths, { query: normalizedQuery });
  }

  applyTextureSearch(query) {
    const key = this._getSubtabSearchKey('building', 'textures');
    const q = query || '';
    this._subtabSearch[key] = q;
    if (this._activeSubtab === 'building') {
      this._refreshOuterWallsGrids({ refreshPaths: false, refreshTextures: true });
    } else {
      this._syncTextureSearchField();
    }
  }

  onFolderSelectionChange(selection) {
    try {
      return AssetsTab.prototype.onFolderSelectionChange.call(this, selection);
    } finally {
      this._folderSelectionScope = null;
      this._updateTextureFolderIndicator();
    }
  }

  _buildTextureControls(section) {
    if (!section) return;
    if (!section.querySelector('.fa-buildings-texture-controls')) {
      const controls = document.createElement('div');
      controls.className = 'fa-nexus-controls fa-buildings-texture-controls';
      controls.innerHTML = `
        <div class="fa-nexus-search-input fa-buildings-texture-search">
          <input type="text" id="fa-buildings-texture-search" placeholder="Search fill textures..." aria-label="Search fill textures" />
          <button class="clear-folders" type="button" title="Clear folder filters" aria-label="Clear folder filters">
            <i class="fas fa-folder"></i>
          </button>
          <i class="fas fa-search"></i>
          <button class="clear-search" type="button" title="Clear fill texture search" aria-label="Clear fill texture search">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="fa-nexus-controls-right fa-buildings-texture-controls-right">
          <div class="thumb-size fa-buildings-texture-thumb">
            <i class="fas fa-grid-2" title="Fill texture thumbnail size"></i>
            <input id="fa-buildings-texture-thumb-size" type="range" min="${this.thumbSliderMin}" max="${this.thumbSliderMax}" step="${this.thumbSliderStep || 2}" aria-label="Fill texture thumbnail size" />
          </div>
          <button class="fa-nexus-icon-button fa-nexus-bookmark-save fa-buildings-texture-bookmark-save" type="button" title="Save fill texture bookmark" aria-label="Save fill texture bookmark">
            <i class="fas fa-bookmark"></i>
          </button>
        </div>
      `;
      section.appendChild(controls);
    }
    if (!section.querySelector('[data-buildings-texture-bookmarks="true"]')) {
      const bookmarks = document.createElement('div');
      bookmarks.className = 'fa-nexus-bookmarks fa-buildings-texture-bookmarks';
      bookmarks.dataset.buildingsTextureBookmarks = 'true';
      bookmarks.innerHTML = `
        <div class="fa-nexus-bookmark-toolbar">
          <div class="fa-nexus-bookmark-items"></div>
          <button class="fa-nexus-bookmark-overflow" type="button" title="More fill texture bookmarks" aria-label="More fill texture bookmarks">
            <i class="fas fa-ellipsis-h"></i>
          </button>
        </div>
      `;
      section.appendChild(bookmarks);
    }
  }

  _initTextureControls(section) {
    if (!section) return;
    if (!section.querySelector('.fa-buildings-texture-controls')) this._buildTextureControls(section);
    this._textureControls.section = section;
    this._textureControls.controls = section.querySelector('.fa-buildings-texture-controls');
    this._textureControls.bookmarks = section.querySelector('[data-buildings-texture-bookmarks="true"]');
    this._textureControls.searchWrap = section.querySelector('.fa-buildings-texture-search');
    this._textureControls.searchInput = section.querySelector('#fa-buildings-texture-search');
    this._textureControls.clearButton = section.querySelector('.fa-buildings-texture-search .clear-search');
    this._textureControls.clearFoldersButton = section.querySelector('.fa-buildings-texture-search .clear-folders');
    this._textureControls.slider = section.querySelector('#fa-buildings-texture-thumb-size');
    this._bindTextureSearchInput();
    this._bindTextureThumbSlider();
    this._ensureTextureBookmarkToolbar();
    this._syncTextureSearchField();
    this._updateTextureFolderIndicator();
  }

  _bindTextureSearchInput() {
    const input = this._textureControls?.searchInput;
    if (!input) return;
    this._removeTextureSearchHandlers();
    const updateUI = () => this._updateTextureSearchUI();
    const handleInput = () => {
      updateUI();
      this._clearTextureSearchDebounce();
      this._textureSearchDebounceId = window.setTimeout(() => {
        this._textureSearchDebounceId = null;
        this.applyTextureSearch(input.value.trim());
      }, 250);
    };
    const handleKeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this._clearTextureSearchDebounce();
        this.applyTextureSearch(input.value.trim());
      } else if (event.key === 'Escape') {
        event.preventDefault();
        input.value = '';
        this._clearTextureSearchDebounce();
        updateUI();
        this.applyTextureSearch('');
      }
    };
    input.addEventListener('input', handleInput);
    input.addEventListener('keydown', handleKeydown);
    const handlers = [
      () => input.removeEventListener('input', handleInput),
      () => input.removeEventListener('keydown', handleKeydown)
    ];
    const clearBtn = this._textureControls?.clearButton;
    if (clearBtn) {
      const handleClear = (event) => {
        event.preventDefault();
        input.value = '';
        this._clearTextureSearchDebounce();
        updateUI();
        this.applyTextureSearch('');
        try { input.focus(); } catch (_) {}
      };
      clearBtn.addEventListener('click', handleClear);
      handlers.push(() => clearBtn.removeEventListener('click', handleClear));
    }
    const clearFoldersBtn = this._textureControls?.clearFoldersButton;
    if (clearFoldersBtn) {
      const handleClearFolders = (event) => {
        event.preventDefault();
        this.setFolderSelectionScope('textures');
        this.app?.clearFolderSelections?.('buildings');
        this._updateTextureFolderIndicator();
      };
      clearFoldersBtn.addEventListener('click', handleClearFolders);
      handlers.push(() => clearFoldersBtn.removeEventListener('click', handleClearFolders));
    }
    this._textureSearchHandlers = handlers;
    updateUI();
  }

  _removeTextureSearchHandlers() {
    if (Array.isArray(this._textureSearchHandlers)) {
      while (this._textureSearchHandlers.length) {
        const off = this._textureSearchHandlers.pop();
        try { off?.(); } catch (_) {}
      }
    }
  }

  _clearTextureSearchDebounce() {
    if (this._textureSearchDebounceId) {
      clearTimeout(this._textureSearchDebounceId);
      this._textureSearchDebounceId = null;
    }
  }

  _syncTextureSearchField() {
    const input = this._textureControls?.searchInput;
    if (!input) return;
    input.value = this._getBuildingTextureSearch();
    this._updateTextureSearchUI();
  }

  _updateTextureSearchUI() {
    const wrap = this._textureControls?.searchWrap;
    const input = this._textureControls?.searchInput;
    if (!wrap || !input) return;
    const clearBtn = this._textureControls?.clearButton;
    const hasText = !!input.value.trim();
    wrap.classList.toggle('has-text', hasText);
    if (clearBtn) clearBtn.style.display = hasText ? 'inline-flex' : 'none';
    const icon = wrap.querySelector('.fa-search');
    if (icon) icon.style.display = hasText ? 'none' : 'unset';
    this._updateTextureFolderIndicator();
  }

  _updateTextureFolderIndicator() {
    const wrap = this._textureControls?.searchWrap;
    const clearFoldersBtn = this._textureControls?.clearFoldersButton;
    if (!wrap || !clearFoldersBtn) return;
    const controller = this.app?._folderFilterController;
    const hasFilter = controller?.hasActiveFilter?.('buildings') ?? false;
    wrap.classList.toggle('has-folder-filter', hasFilter);
    clearFoldersBtn.style.display = hasFilter ? 'inline-flex' : 'none';
  }

  _bindTextureThumbSlider() {
    let slider = this._textureControls?.slider;
    if (!slider) return;
    if (slider._faTextureSliderBound) {
      this._applyTextureThumbSize(this._getTextureThumbSliderValue());
      return;
    }
    const parent = slider.parentElement;
    if (parent) {
      const clone = slider.cloneNode(true);
      parent.replaceChild(clone, slider);
      slider = clone;
      this._textureControls.slider = slider;
    }
    const min = this.thumbSliderMin;
    const max = this.thumbSliderMax;
    const step = this.thumbSliderStep || 2;
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    const saved = this._getStoredTextureThumbSize();
    slider.value = String(saved);
    this._applyTextureThumbSize(saved);

    const handleInput = () => {
      const value = this._sanitizeThumbSize(Number(slider.value) || saved);
      this._applyTextureThumbSize(value);
    };
    const handleChange = async () => {
      const value = this._sanitizeThumbSize(Number(slider.value) || saved);
      this._applyTextureThumbSize(value);
      try { await game.settings.set('fa-nexus', BUILDING_TEXTURE_THUMB_SETTING, value); } catch (_) {}
    };
    slider.addEventListener('input', handleInput);
    slider.addEventListener('change', handleChange);

    const handlePointerDown = () => {
      this._beginThumbSizeAdjust?.();
      const endAdjust = () => {
        this._endThumbSizeAdjust?.();
        window.removeEventListener('pointerup', endAdjust, true);
        window.removeEventListener('pointercancel', endAdjust, true);
      };
      window.addEventListener('pointerup', endAdjust, true);
      window.addEventListener('pointercancel', endAdjust, true);
    };
    slider.addEventListener('pointerdown', handlePointerDown, { passive: true });
    slider._faTextureSliderBound = true;
  }

  _getStoredTextureThumbSize() {
    try {
      const value = Number(game.settings.get('fa-nexus', BUILDING_TEXTURE_THUMB_SETTING) || 0);
      if (value) return this._sanitizeThumbSize(value);
    } catch (_) {}
    return this._sanitizeThumbSize(this.thumbSliderDefault);
  }

  _getTextureThumbSliderValue() {
    const slider = this._textureControls?.slider;
    if (slider && slider.value !== undefined) {
      const numeric = Number(slider.value);
      if (Number.isFinite(numeric)) return this._sanitizeThumbSize(numeric);
    }
    return this._getStoredTextureThumbSize();
  }

  _computeTextureThumbDimensions(value) {
    const base = Math.max(1, Math.round(value));
    return { width: base, height: base };
  }

  _applyTextureThumbSize(value) {
    const sanitized = this._sanitizeThumbSize(value);
    const dims = this._computeTextureThumbDimensions(sanitized);
    if (this._texturesGrid) {
      try { this._texturesGrid.setCardSize(dims.width, dims.height); } catch (_) {}
    }
    const container = this._texturesGrid?.container || this._texturesGridContainer;
    if (container) {
      const min = this.thumbSliderMin;
      const max = this.thumbSliderMax;
      const t = Math.max(0, Math.min(1, (sanitized - min) / (max - min || 1)));
      container.style.setProperty('--fa-nexus-card-pad', `${2 + (6 - 2) * t}px`);
      container.style.setProperty('--fa-nexus-title-size', `${0.68 + (0.78 - 0.68) * t}rem`);
      container.style.setProperty('--fa-nexus-details-size', `${0.58 + (0.68 - 0.58) * t}rem`);
      container.style.setProperty('--fa-nexus-footer-pt', `${(4 * t)}px`);
    }
  }

  _ensureTextureBookmarkToolbar() {
    if (!this._textureControls?.section) return;
    const bookmarkManager = this.app?._bookmarkManager;
    const tabManager = this.app?._tabManager;
    if (!bookmarkManager || !tabManager) return;
    if (!this._textureBookmarkToolbar) {
      const scopedApp = Object.create(this.app || {});
      Object.defineProperty(scopedApp, 'element', {
        get: () => this._textureControls?.section || null,
        configurable: true
      });
      const originalClear = this.app?.clearFolderSelections?.bind(this.app);
      if (originalClear) {
        scopedApp.clearFolderSelections = (tabId) => {
          if (tabId === BUILDING_TEXTURE_BOOKMARK_TAB) {
            this._folderSelectionScope = 'textures';
            originalClear('buildings');
            return;
          }
          originalClear(tabId);
        };
      }
      const textureTabProxy = {
        getActiveFolderSelection: () => this.getActiveFolderSelection?.(),
        onFolderSelectionChange: (selection) => {
          this._folderSelectionScope = 'textures';
          this.onFolderSelectionChange(selection);
        }
      };
      const scopedTabManager = Object.create(tabManager);
      scopedTabManager.getActiveTabId = () => BUILDING_TEXTURE_BOOKMARK_TAB;
      scopedTabManager.getActiveTab = () => textureTabProxy;
      this._textureSearchAdapter = this._textureSearchAdapter || {
        getSearchQuery: () => this._getBuildingTextureSearch(),
        applySearchToTab: (_tabId, value) => this.applyTextureSearch(value || '')
      };
      this._textureBookmarkToolbar = new BookmarkToolbar({
        app: scopedApp,
        bookmarkManager,
        tabManager: scopedTabManager,
        searchController: this._textureSearchAdapter,
        folderController: this.app?._folderFilterController
      });
      this._textureBookmarkToolbar.initialize(this.app?._events);
    } else {
      try { this._textureBookmarkToolbar.refresh(); } catch (_) {}
    }
  }

  _destroyTextureBookmarkToolbar() {
    if (this._textureBookmarkToolbar) {
      try { this._textureBookmarkToolbar.cleanup(); } catch (_) {}
    }
    this._textureBookmarkToolbar = null;
    this._textureSearchAdapter = null;
  }

  _ensureGridResizer(pathsSection, texturesSection) {
    const wrapper = this._gridWrapper;
    if (!wrapper || !pathsSection || !texturesSection) return;
    let handle = this._gridResizer;
    if (!handle || !wrapper.contains(handle)) {
      handle = document.createElement('div');
      handle.className = 'fa-buildings-grid-resizer';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'horizontal');
      handle.setAttribute('aria-label', 'Adjust grid heights');
      wrapper.insertBefore(handle, texturesSection);
      this._gridResizer = handle;
      this._bindGridResizer(handle);
    } else if (handle.nextElementSibling !== texturesSection) {
      wrapper.insertBefore(handle, texturesSection);
    }
    this._updateGridResizerVisibility();
  }

  _bindGridResizer(handle) {
    if (!handle) return;
    if (this._gridResizerHandlers?.pointerdown) {
      handle.removeEventListener('pointerdown', this._gridResizerHandlers.pointerdown);
    }
    const onPointerDown = (event) => this._onGridResizerPointerDown(event);
    handle.addEventListener('pointerdown', onPointerDown);
    this._gridResizerHandlers = { pointerdown: onPointerDown };
  }

  _onGridResizerPointerDown(event) {
    if (event.button !== 0 || this._activeSubtab !== 'building') return;
    const pathsSection = this._pathsSection;
    const texturesSection = this._texturesSection;
    const handle = this._gridResizer;
    if (!pathsSection || !texturesSection || !handle) return;
    const pathRect = pathsSection.getBoundingClientRect();
    const texturesRect = texturesSection.getBoundingClientRect();
    const totalHeight = pathRect.height + texturesRect.height;
    if (!totalHeight) return;
    event.preventDefault();
    const startRatio = this._clampGridSplitRatio(pathRect.height / totalHeight || this._gridSplitRatio || 0.6);
    const startY = event.clientY;
    const pointerId = event.pointerId;
    try { handle.setPointerCapture(pointerId); } catch (_) {}
    handle.classList.add('is-dragging');

    const onMove = (moveEvent) => {
      const delta = (moveEvent.clientY - startY) / totalHeight;
      const next = this._clampGridSplitRatio(startRatio + delta);
      if (Math.abs(next - this._gridSplitRatio) < 0.001) return;
      this._gridSplitRatio = next;
      this._applyGridSplitRatio();
    };
    const finishDrag = () => {
      try { handle.releasePointerCapture(pointerId); } catch (_) {}
      handle.classList.remove('is-dragging');
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', finishDrag, true);
      window.removeEventListener('pointercancel', finishDrag, true);
      this._gridResizerDragCleanup = null;
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', finishDrag, true);
    window.addEventListener('pointercancel', finishDrag, true);
    this._gridResizerDragCleanup = finishDrag;
  }

  _applyGridSplitRatio() {
    if (!this._pathsSection || !this._texturesSection) return;
    if (this._activeSubtab !== 'building' || this._texturesSection.classList.contains('is-hidden')) {
      this._resetGridSplitStyles();
      this._updateGridResizerVisibility();
      return;
    }
    const ratio = this._clampGridSplitRatio(this._gridSplitRatio);
    this._gridSplitRatio = ratio;
    const pathGrow = ratio;
    const textureGrow = Math.max(0.1, 1 - ratio);
    this._pathsSection.style.flexGrow = pathGrow;
    this._pathsSection.style.flexBasis = '0%';
    this._pathsSection.style.flexShrink = '1';
    this._texturesSection.style.flexGrow = textureGrow;
    this._texturesSection.style.flexBasis = '0%';
    this._texturesSection.style.flexShrink = '1';
    this._updateGridResizerVisibility();
    try { this.app?._grid?._onResize?.(); } catch (_) {}
    try { this._texturesGrid?._onResize?.(); } catch (_) {}
  }

  _clampGridSplitRatio(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0.6;
    return Math.min(0.75, Math.max(0.2, numeric));
  }

  _resetGridSplitStyles() {
    if (this._pathsSection) {
      this._pathsSection.style.removeProperty('flex-grow');
      this._pathsSection.style.removeProperty('flex-basis');
      this._pathsSection.style.removeProperty('flex-shrink');
    }
    if (this._texturesSection) {
      this._texturesSection.style.removeProperty('flex-grow');
      this._texturesSection.style.removeProperty('flex-basis');
      this._texturesSection.style.removeProperty('flex-shrink');
    }
  }

  _updateGridResizerVisibility() {
    if (!this._gridResizer) return;
    const show = this._activeSubtab === 'building' && !this._texturesSection?.classList.contains('is-hidden');
    this._gridResizer.classList.toggle('is-hidden', !show);
  }

  _teardownGridResizer() {
    this._cancelGridResizerDrag();
    if (this._gridResizerHandlers?.pointerdown && this._gridResizer) {
      this._gridResizer.removeEventListener('pointerdown', this._gridResizerHandlers.pointerdown);
    }
    this._gridResizerHandlers = null;
    if (this._gridResizer?.parentElement) {
      try { this._gridResizer.parentElement.removeChild(this._gridResizer); } catch (_) {}
    }
    this._gridResizer = null;
  }

  _cancelGridResizerDrag() {
    if (typeof this._gridResizerDragCleanup === 'function') {
      try { this._gridResizerDragCleanup(); } catch (_) {}
      this._gridResizerDragCleanup = null;
    }
  }

  _sortBuildingPathItems(items, { query = '' } = {}) {
    if (!Array.isArray(items) || items.length < 2) return items;

    const weights = this._computeWallQueryWeights(items);
    const hasWeights = weights && weights.size > 0;
    const folderMap = this._computeFolderPriorityMap(items);
    const decorate = items.map((item, index) => ({
      item,
      index,
      weight: this._computeWallItemWeight(item, { weights, hasWeights }),
      wall: this._isStrongWallItem(item) ? 1 : 0,
      folder: this._getFolderPriority(item, folderMap),
      name: this._getPathSortLabel(item)
    }));

    decorate.sort((a, b) => {
      if (a.wall !== b.wall) return b.wall - a.wall;
      if (a.folder !== b.folder) return b.folder - a.folder;
      if (hasWeights && a.weight !== b.weight) return b.weight - a.weight;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.index - b.index;
    });

    return decorate.map((entry) => entry.item);
  }

  _computeWallQueryWeights(items) {
    const search = this._search;
    if (!search || typeof search.filter !== 'function') return new Map();
    let ranked = [];
    try { ranked = search.filter(items, WALL_BIAS_QUERY) || []; }
    catch (_) { ranked = []; }
    const weights = new Map();
    const base = ranked.length;
    ranked.forEach((item, idx) => { weights.set(item, base - idx); });
    return weights;
  }

  _computeWallItemWeight(item, { weights, hasWeights }) {
    const strongWall = this._isStrongWallItem(item);
    if (!strongWall) return 0;
    if (!hasWeights || !weights) return 1;
    return weights.get(item) || 1;
  }

  _isStrongWallItem(item) {
    const label = this._getPathSortLabel(item);
    if (label && /\bwall\b/.test(label)) return true;
    const folder = (this._getNormalizedFolderPath?.(item) || '');
    if (folder) {
      const segments = folder.split('/').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (segments.some((seg) => seg.includes('curb_'))) return false;
      if (segments.some((seg) => WALL_SEGMENT_TOKENS.includes(seg))) return true;
      if (segments.some((seg) => WALL_SEGMENT_PATTERN.test(seg))) return true;
    }
    return false;
  }

  _sortFillTextureItems(items, { query = '' } = {}) {
    if (!Array.isArray(items) || items.length < 2) return items;
    const hasQuery = !!(query && String(query).trim());
    if (hasQuery) return items;

    const folderMap = this._computeFolderPriorityMap(items);
    const decorate = items.map((item, index) => ({
      item,
      index,
      penalty: this._computeFillTexturePenalty(item),
      folder: this._getFolderPriority(item, folderMap),
      name: this._getPathSortLabel(item)
    }));

    decorate.sort((a, b) => {
      if (a.penalty !== b.penalty) return a.penalty - b.penalty;
      if (a.folder !== b.folder) return b.folder - a.folder;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.index - b.index;
    });

    return decorate.map((entry) => entry.item);
  }

  _computeFillTexturePenalty(item) {
    let penalty = 0;
    const path = String(item?.path || item?.file_path || '').toLowerCase();
    if (path.includes(TEXTURE_DEPRIORITIZED_PATH_TOKEN)) penalty += 2;

    const label = this._getPathSortLabel(item);
    if (label) {
      for (const token of TEXTURE_DEPRIORITIZED_NAME_TOKENS) {
        if (label.includes(token)) penalty += 1;
      }
    }
    return penalty;
  }

  _computeFolderPriorityMap(items) {
    const folders = new Set();
    for (const item of items) {
      const lower = this._getNormalizedFolderPath?.(item) || '';
      if (lower) folders.add(lower);
    }
    const sorted = Array.from(folders).sort((a, b) => a.localeCompare(b));
    const total = sorted.length;
    const map = new Map();
    sorted.forEach((folder, idx) => { map.set(folder, total - idx); });
    return map;
  }

  _getFolderPriority(item, folderMap) {
    if (!folderMap || !(folderMap instanceof Map)) return 0;
    const lower = this._getNormalizedFolderPath?.(item) || '';
    return folderMap.get(lower) || 0;
  }

  _getPathSortLabel(item) {
    const filename = String(item?.filename || '').toLowerCase();
    if (filename) return filename;
    const display = String(item?.displayName || '').toLowerCase();
    if (display) return display;
    const path = String(item?.path || item?.file_path || '').toLowerCase();
    if (path) {
      const parts = path.split('/');
      return parts[parts.length - 1] || path;
    }
    return '';
  }

  _installTextureHoverPreview() {
    if (this._textureHoverHandlers) return;
    const container = this._texturesGrid?.container || this._texturesGridContainer;
    if (!container || this._activeSubtab !== 'building') return;
    this._ensurePreviewManager();
    if (!this._preview || typeof this._preview.showPreviewWithDelay !== 'function') return;

    let hoveredCard = null;
    const onOver = (event) => {
      const card = event.target?.closest?.('.fa-nexus-card');
      if (!card || !container.contains(card)) return;
      if (hoveredCard === card) return;
      const media = card.querySelector?.('img, video');
      if (!media) return;
      const shouldShow = this.onHoverCardEnter(card, media);
      if (shouldShow === false) return;
      hoveredCard = card;
      const delay = this.getHoverPreviewDelay(card, media);
      this._preview.showPreviewWithDelay(media, card, delay);
    };
    const clearHover = () => {
      if (!hoveredCard) return;
      this.onHoverCardLeave(hoveredCard);
      hoveredCard = null;
      this._preview.hidePreview();
    };
    const onOut = (event) => {
      if (!hoveredCard) return;
      const to = event.relatedTarget;
      if (to && hoveredCard.contains(to)) return;
      clearHover();
    };
    const onLeave = () => { clearHover(); };
    container.addEventListener('mouseover', onOver);
    container.addEventListener('mouseout', onOut);
    container.addEventListener('mouseleave', onLeave);
    this._textureHoverHandlers = { container, over: onOver, out: onOut, leave: onLeave };
  }

  _uninstallTextureHoverPreview() {
    const handlers = this._textureHoverHandlers;
    if (!handlers) return;
    const { container, over, out, leave } = handlers;
    try { container.removeEventListener('mouseover', over); } catch (_) {}
    try { container.removeEventListener('mouseout', out); } catch (_) {}
    try { container.removeEventListener('mouseleave', leave); } catch (_) {}
    this._textureHoverHandlers = null;
  }

  _resetTextureControlsState() {
    this._textureControls = {
      section: null,
      controls: null,
      bookmarks: null,
      searchInput: null,
      searchWrap: null,
      clearButton: null,
      clearFoldersButton: null,
      slider: null
    };
  }

  _teardownTextureControls() {
    this._clearTextureSearchDebounce();
    this._removeTextureSearchHandlers();
    this._destroyTextureBookmarkToolbar();
    this._resetTextureControlsState();
  }

  _setIndexingLock(active, message = 'Indexing cloud assets...') {
    super._setIndexingLock(active, message);
    if (this._texturesGridContainer) {
      this._texturesGridContainer.classList.toggle('is-locked', !!active);
      if (active) this._texturesGridContainer.setAttribute('aria-busy', 'true');
      else this._texturesGridContainer.removeAttribute('aria-busy');
    }
  }

  _matchesMode(item) {
    if (!item) return false;
    const isPath = !!this._isPathsItem?.(item);
    const isTexture = !!this._isTextureItem?.(item);
    if (this._activeSubtab === 'building') return isPath || isTexture;
    return isPath;
  }

  _usesWidePathThumbs() {
    if (this._activeSubtab === 'building') return true;
    return super._usesWidePathThumbs();
  }

  getStats() {
    if (this._activeSubtab !== 'building') return super.getStats();
    const allItems = Array.isArray(this._items) ? this._items : [];
    const total = allItems.filter((item) => this._matchesMode(item)).length;
    const shown = (this._pathsShown || 0) + (this._texturesShown || 0);
    return { shown, total };
  }

  onThumbSizeChange(width) {
    super.onThumbSizeChange(width);
    if (this._texturesGrid) {
      const size = Math.max(54, Math.min(108, Number(width) || 72));
      try { this._texturesGrid.setCardSize(size, size); } catch (_) {}
    }
  }

  _ensureGridSections(wrapper, grid) {
    let pathsSection = wrapper.querySelector('.fa-buildings-grid-section[data-grid="paths"]');
    if (!pathsSection) {
      pathsSection = this._createGridSection(wrapper, 'paths', 'Wall Paths');
    }
    const pathsContainer = pathsSection.querySelector('.fa-buildings-grid-container');
    if (pathsContainer && grid.parentElement !== pathsContainer) {
      pathsContainer.appendChild(grid);
      grid.classList.add('fa-buildings-grid');
    }
    this._pathsSection = pathsSection;

    let texturesSection = wrapper.querySelector('.fa-buildings-grid-section[data-grid="textures"]');
    if (!texturesSection) {
      texturesSection = this._createGridSection(wrapper, 'textures', 'Fill Textures');
    }
    this._texturesSection = texturesSection;
    const container = texturesSection.querySelector('.fa-buildings-grid-container');
    if (container && container !== this._texturesGridContainer) {
      this._uninstallTextureHoverPreview();
      this._texturesGridContainer = container;
    }
    this._installTextureHoverPreview();
    this._initTextureControls(texturesSection);
    this._ensureGridResizer(pathsSection, texturesSection);
    this._applyGridSplitRatio();
  }

  _createGridSection(wrapper, type, title) {
    const section = document.createElement('section');
    section.className = 'fa-buildings-grid-section';
    section.dataset.grid = type;

    const header = document.createElement('header');
    header.className = 'fa-buildings-grid-title';
    header.textContent = title;
    section.appendChild(header);

    if (type === 'textures') {
      this._buildTextureControls(section);
    }

    const container = document.createElement('div');
    container.className = 'fa-buildings-grid-container';
    if (type === 'textures') {
      container.classList.add('fa-nexus-grid');
    }
    section.appendChild(container);

    wrapper.appendChild(section);
    return section;
  }

  _updateSectionVisibility() {
    const showTextures = this._activeSubtab === 'building';
    const showPortals = this._activeSubtab === 'portals';
    if (this._texturesSection) {
      this._texturesSection.classList.toggle('is-hidden', !showTextures);
    }
    if (this._pathsSection) {
      this._pathsSection.classList.toggle('is-hidden', showPortals);
    }
    // Show/hide portal panel
    this._updatePortalPanelVisibility(showPortals);
  }

  // ─── Portal Panel UI ──────────────────────────────────────────────────────────

  _updatePortalPanelVisibility(show) {
    if (show) {
      this._ensurePortalPanel();
      if (this._portalPanel) {
        this._portalPanel.classList.remove('is-hidden');
        this._updatePortalPanelState();
      }
      // Register callback to refresh thumbnails when textures change
      this._registerPortalToolOptionsCallback();
    } else {
      if (this._portalPanel) {
        this._portalPanel.classList.add('is-hidden');
      }
      // Unregister callback when not in portal mode
      this._unregisterPortalToolOptionsCallback();
    }
  }

  _registerPortalToolOptionsCallback() {
    if (this._portalToolOptionsCallback) return; // Already registered
    const manager = this._buildingManager;
    if (!manager || typeof manager.setToolOptionsChangeCallback !== 'function') return;

    this._portalToolOptionsCallback = (state) => {
      // Refresh thumbnails when tool options change (texture selection)
      if (this._activeSubtab !== 'portals' || !this._portalPanel) return;
      const canUsePortals = this._canUsePortals();
      if (this._portalPanelCanUse !== canUsePortals) {
        this._portalPanelCanUse = canUsePortals;
        this._portalPreviewSignature = null;
        this._updatePortalPanelState();
        if (canUsePortals) this._refreshPortalTextureThumbnails();
        return;
      }
      const nextKind = this._resolvePortalKindFromState(state);
      if (nextKind && nextKind !== this._activePortalType) {
        this._setActivePortalType(nextKind);
        return;
      }
      this._refreshPortalTextureThumbnails();
    };
    manager.setToolOptionsChangeCallback(this._portalToolOptionsCallback);
  }

  _unregisterPortalToolOptionsCallback() {
    if (!this._portalToolOptionsCallback) return;
    const manager = this._buildingManager;
    if (manager && typeof manager.setToolOptionsChangeCallback === 'function') {
      manager.setToolOptionsChangeCallback(null);
    }
    this._portalToolOptionsCallback = null;
  }

  _ensurePortalPanel() {
    const wrapper = this._gridWrapper;
    if (!wrapper) return;
    if (this._portalPanel && wrapper.contains(this._portalPanel)) {
      return;
    }
    // Create the portal panel
    const panel = document.createElement('div');
    panel.className = 'fa-portals-panel';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Portal placement options');

    // Check if we can show the panel (need active session or walls)
    const canUsePortals = this._canUsePortals();
    this._portalPanelCanUse = canUsePortals;
    if (!canUsePortals) {
      panel.innerHTML = `
        <div class="fa-portals-panel__blocker">
          <i class="fas fa-info-circle" aria-hidden="true"></i>
          <span>Start a wall session first</span>
          <p class="fa-portals-panel__hint">Select a wall path from the Walls tab to begin.</p>
        </div>
      `;
    } else {
      panel.innerHTML = this._buildPortalPanelContent();
    }

    // Insert after subtabs
    const subtabContainer = wrapper.querySelector('.fa-buildings-subtabs');
    if (subtabContainer && subtabContainer.nextSibling) {
      wrapper.insertBefore(panel, subtabContainer.nextSibling);
    } else {
      wrapper.appendChild(panel);
    }

    this._portalPanel = panel;
    if (canUsePortals) {
      this._bindPortalPanelHandlers();
    }
  }

  _resolvePortalKindFromState(state) {
    if (!state || !state.portalMode) return null;
    if (state.doorControls) return GAP_KIND_DOOR;
    if (state.windowControls) return GAP_KIND_WINDOW;
    return null;
  }

  _buildPortalPanelContent() {
    const types = Object.values(PORTAL_TYPES);
    const activeType = this._activePortalType || GAP_KIND_DOOR;

    // Build portal type buttons
    const buttonsHtml = types.map((type) => `
      <button type="button"
              class="fa-portals-panel__type-btn${type.id === activeType ? ' is-active' : ''}"
              data-portal-type="${type.id}"
              title="${type.tooltip}"
              aria-pressed="${type.id === activeType}">
        <i class="fas ${type.icon}" aria-hidden="true"></i>
        <span>${type.label}</span>
      </button>
    `).join('');

    // Build texture thumbnails section (door/window specific)
    const texturesHtml = this._buildPortalTexturesHtml(activeType);

    return `
      <div class="fa-portals-panel__types" role="radiogroup" aria-label="Portal type selection">
        ${buttonsHtml}
      </div>
      <div class="fa-portals-panel__textures" data-portal-textures>
        ${texturesHtml}
      </div>
    `;
  }

  _buildPortalTexturesHtml(portalType) {
    if (portalType === GAP_KIND_GAP) {
      return `
        <div class="fa-portals-panel__texture-hint">
          <i class="fas fa-info-circle" aria-hidden="true"></i>
          <span>Gaps create empty spaces in walls without textures.</span>
        </div>
      `;
    }

    if (portalType === GAP_KIND_DOOR) {
      return `
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Door Texture</span>
          <div class="fa-portals-panel__thumb-wrap" data-has-texture="false">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="door" title="Click to select door texture" aria-label="Select door texture">
              <div class="fa-portals-panel__thumb-placeholder">
                <i class="fas fa-door-closed" aria-hidden="true"></i>
                <span>Select...</span>
              </div>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="door" title="Clear door texture" aria-label="Clear door texture">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Door Frame</span>
          <div class="fa-portals-panel__thumb-wrap" data-has-texture="false">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="door-frame" title="Click to select door frame texture" aria-label="Select door frame texture">
              <div class="fa-portals-panel__thumb-placeholder">
                <i class="fas fa-border-all" aria-hidden="true"></i>
                <span>Select...</span>
              </div>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="door-frame" title="Clear door frame texture" aria-label="Clear door frame texture">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="fa-portals-panel__preview" data-portal-preview="door">
          <span class="fa-portals-panel__preview-label">Preview</span>
          <div class="fa-portals-panel__preview-frame">
            <canvas class="fa-portals-panel__preview-canvas" width="280" height="120"></canvas>
            <div class="fa-portals-panel__preview-placeholder">
              <i class="fas fa-eye" aria-hidden="true"></i>
              <span>Select textures to preview</span>
            </div>
          </div>
        </div>
      `;
    }

    if (portalType === GAP_KIND_WINDOW) {
      return `
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Window Sill</span>
          <div class="fa-portals-panel__thumb-wrap" data-has-texture="false">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="window-sill" title="Click to select window sill texture" aria-label="Select window sill texture">
              <div class="fa-portals-panel__thumb-placeholder">
                <i class="fas fa-layer-group" aria-hidden="true"></i>
                <span>Select...</span>
              </div>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="window-sill" title="Clear window sill texture" aria-label="Clear window sill texture">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Window Glass</span>
          <div class="fa-portals-panel__thumb-wrap" data-has-texture="false">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="window-texture" title="Click to select window texture" aria-label="Select window texture">
              <div class="fa-portals-panel__thumb-placeholder">
                <i class="fas fa-border-all" aria-hidden="true"></i>
                <span>Select...</span>
              </div>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="window-texture" title="Clear window texture" aria-label="Clear window texture">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Window Frame</span>
          <div class="fa-portals-panel__thumb-wrap" data-has-texture="false">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="window-frame" title="Click to select window frame texture" aria-label="Select window frame texture">
              <div class="fa-portals-panel__thumb-placeholder">
                <i class="fas fa-columns" aria-hidden="true"></i>
                <span>Select...</span>
              </div>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="window-frame" title="Clear window frame texture" aria-label="Clear window frame texture">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="fa-portals-panel__preview" data-portal-preview="window">
          <span class="fa-portals-panel__preview-label">Preview</span>
          <div class="fa-portals-panel__preview-frame">
            <canvas class="fa-portals-panel__preview-canvas" width="280" height="120"></canvas>
            <div class="fa-portals-panel__preview-placeholder">
              <i class="fas fa-eye" aria-hidden="true"></i>
              <span>Select textures to preview</span>
            </div>
          </div>
        </div>
      `;
    }

    return '';
  }

  _bindPortalPanelHandlers() {
    const panel = this._portalPanel;
    if (!panel) return;

    this._unbindPortalPanelHandlers();
    const handlers = [];

    // Portal type button clicks
    const typeButtons = panel.querySelectorAll('[data-portal-type]');
    typeButtons.forEach((btn) => {
      const handler = (event) => {
        event.preventDefault();
        const type = btn.dataset.portalType;
        this._setActivePortalType(type);
      };
      btn.addEventListener('click', handler);
      handlers.push(() => btn.removeEventListener('click', handler));
    });

    // Texture thumbnail clicks (picker launchers)
    const thumbButtons = panel.querySelectorAll('[data-portal-picker]');
    thumbButtons.forEach((btn) => {
      const handler = (event) => {
        event.preventDefault();
        const picker = btn.dataset.portalPicker;
        this._openPortalTexturePicker(picker);
      };
      btn.addEventListener('click', handler);
      handlers.push(() => btn.removeEventListener('click', handler));
    });

    // Clear texture buttons
    const clearButtons = panel.querySelectorAll('[data-portal-clear]');
    clearButtons.forEach((btn) => {
      const handler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const picker = btn.dataset.portalClear;
        this._clearPortalTexture(picker);
      };
      btn.addEventListener('click', handler);
      handlers.push(() => btn.removeEventListener('click', handler));
    });

    this._portalPanelHandlers = handlers;
  }

  _unbindPortalPanelHandlers() {
    if (Array.isArray(this._portalPanelHandlers)) {
      while (this._portalPanelHandlers.length) {
        const off = this._portalPanelHandlers.pop();
        try { off?.(); } catch (_) {}
      }
    }
    this._portalPanelHandlers = null;
  }

  _setActivePortalType(type) {
    const validTypes = [GAP_KIND_GAP, GAP_KIND_DOOR, GAP_KIND_WINDOW];
    if (!validTypes.includes(type)) type = GAP_KIND_DOOR;
    if (this._activePortalType === type) return;

    this._activePortalType = type;
    this._portalPreviewSignature = null;

    // Update building manager's gap edit mode
    const manager = this._buildingManager;
    if (manager?.isActive) {
      try {
        manager._delegate?._setGapEditMode?.(true, type);
      } catch (_) {}
    }

    // Update portal panel UI
    this._updatePortalPanelState();
  }

  _updatePortalPanelState() {
    const panel = this._portalPanel;
    if (!panel) return;

    const canUsePortals = this._canUsePortals();
    this._portalPanelCanUse = canUsePortals;
    const currentBlocker = panel.querySelector('.fa-portals-panel__blocker');

    if (!canUsePortals && !currentBlocker) {
      // Need to show blocker
      this._portalPreviewSignature = null;
      panel.innerHTML = `
        <div class="fa-portals-panel__blocker">
          <i class="fas fa-info-circle" aria-hidden="true"></i>
          <span>Start a wall session first</span>
          <p class="fa-portals-panel__hint">Select a wall path from the Walls tab to begin.</p>
        </div>
      `;
      this._unbindPortalPanelHandlers();
      return;
    }

    if (canUsePortals && currentBlocker) {
      // Remove blocker and rebuild panel
      this._portalPreviewSignature = null;
      panel.innerHTML = this._buildPortalPanelContent();
      this._bindPortalPanelHandlers();
      return;
    }

    if (!canUsePortals) return;

    // Sync last-used portal type from the building manager
    const manager = this._buildingManager;
    if (manager?.isActive) {
      const delegateKind = manager._delegate?._gapEditKind;
      if (delegateKind && delegateKind !== this._activePortalType) {
        // Keep Door as the default when returning to Portals.
        if (delegateKind !== GAP_KIND_GAP) {
          this._activePortalType = delegateKind;
        }
      }
    }

    // Update button states
    const typeButtons = panel.querySelectorAll('[data-portal-type]');
    typeButtons.forEach((btn) => {
      const type = btn.dataset.portalType;
      const isActive = type === this._activePortalType;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    // Update textures section
    const texturesContainer = panel.querySelector('[data-portal-textures]');
    if (texturesContainer) {
      this._portalPreviewSignature = null;
      texturesContainer.innerHTML = this._buildPortalTexturesHtml(this._activePortalType);
      // Rebind only texture handlers
      const thumbButtons = texturesContainer.querySelectorAll('[data-portal-picker]');
      thumbButtons.forEach((btn) => {
        const handler = (event) => {
          event.preventDefault();
          const picker = btn.dataset.portalPicker;
          this._openPortalTexturePicker(picker);
        };
        btn.addEventListener('click', handler);
        if (!this._portalPanelHandlers) this._portalPanelHandlers = [];
        this._portalPanelHandlers.push(() => btn.removeEventListener('click', handler));
      });
      const clearButtons = texturesContainer.querySelectorAll('[data-portal-clear]');
      clearButtons.forEach((btn) => {
        const handler = (event) => {
          event.preventDefault();
          event.stopPropagation();
          const picker = btn.dataset.portalClear;
          this._clearPortalTexture(picker);
        };
        btn.addEventListener('click', handler);
        if (!this._portalPanelHandlers) this._portalPanelHandlers = [];
        this._portalPanelHandlers.push(() => btn.removeEventListener('click', handler));
      });

      // Update texture thumbnails with current selections
      this._refreshPortalTextureThumbnails();
    }
  }

  _refreshPortalTextureThumbnails() {
    const panel = this._portalPanel;
    if (!panel) return;

    const manager = this._buildingManager;
    const delegate = manager?._delegate;
    if (!delegate) return;
    // Prefer currently selected portal configs; fall back to defaults
    let doorConfig = delegate._doorDefaults || {};
    let windowConfig = delegate._windowDefaults || {};
    const selection = delegate._portalSelection || null;
    if (selection?.gapId) {
      const gap = typeof delegate._getGapById === 'function'
        ? delegate._getGapById(selection.gapId)
        : null;
      if (gap) {
        if (gap.kind === 'door' && gap.door) doorConfig = gap.door;
        if (gap.kind === 'window' && gap.window) windowConfig = gap.window;
      }
    }

    const signature = this._buildPortalPreviewSignature(doorConfig, windowConfig);
    if (signature === this._portalPreviewSignature) return;
    this._portalPreviewSignature = signature;

    // Update door texture thumbnails
    this._updateTextureThumbnail(panel, 'door', doorConfig.textureLocal || doorConfig.textureKey);
    this._updateTextureThumbnail(panel, 'door-frame', doorConfig.frame?.textureLocal || doorConfig.frame?.textureKey);

    // Update window texture thumbnails
    this._updateTextureThumbnail(panel, 'window-sill', windowConfig.sill?.textureLocal || windowConfig.sill?.textureKey);
    this._updateTextureThumbnail(panel, 'window-texture', windowConfig.texture?.textureLocal || windowConfig.texture?.textureKey);
    this._updateTextureThumbnail(panel, 'window-frame', windowConfig.frame?.textureLocal || windowConfig.frame?.textureKey);

    this._updatePortalCompositePreview(panel, { doorConfig, windowConfig });
  }

  _updateTextureThumbnail(panel, pickerId, texturePath) {
    const thumb = panel.querySelector(`[data-portal-picker="${pickerId}"]`);
    if (!thumb) return;
    const wrap = thumb.closest?.('.fa-portals-panel__thumb-wrap');

    let textureKey = String(texturePath || '');
    if (textureKey && this._isPortalTextureMissing(textureKey)) {
      textureKey = '';
    }

    const existingImg = thumb.querySelector('img.fa-portals-panel__thumb-img');
    const existingSrc = existingImg?.getAttribute('src') || '';
    if (textureKey) {
      if (existingImg && existingSrc === textureKey) {
        if (wrap) wrap.dataset.hasTexture = 'true';
        return;
      }
      const filename = textureKey.split('/').pop() || 'Selected';
      const img = document.createElement('img');
      img.className = 'fa-portals-panel__thumb-img';
      img.src = textureKey;
      img.alt = filename;
      img.loading = 'lazy';
      img.addEventListener('load', () => {
        this._portalPreviewMissingCache.delete(textureKey);
      });
      img.addEventListener('error', () => {
        const cleared = this._handleMissingPortalTexture(pickerId, textureKey);
        if (!cleared) this._updateTextureThumbnail(panel, pickerId, null);
      });
      thumb.innerHTML = '';
      thumb.appendChild(img);
      if (wrap) wrap.dataset.hasTexture = 'true';
    } else {
      const placeholder = thumb.querySelector('.fa-portals-panel__thumb-placeholder');
      if (!existingImg && placeholder && wrap?.dataset?.hasTexture === 'false') return;
      // Show placeholder based on picker type
      const icons = {
        'door': 'fa-door-closed',
        'door-frame': 'fa-border-all',
        'window-sill': 'fa-layer-group',
        'window-texture': 'fa-border-all',
        'window-frame': 'fa-columns'
      };
      const icon = icons[pickerId] || 'fa-image';
      thumb.innerHTML = `
        <div class="fa-portals-panel__thumb-placeholder">
          <i class="fas ${icon}" aria-hidden="true"></i>
          <span>Select...</span>
        </div>
      `;
      if (wrap) wrap.dataset.hasTexture = 'false';
    }
  }

  _buildPortalPreviewSignature(doorConfig = {}, windowConfig = {}) {
    const safeString = (value) => String(value || '');
    const round = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      return Math.round(numeric * 1000) / 1000;
    };
    const normalizeFrame = (frame) => {
      const cfg = frame && typeof frame === 'object' ? frame : {};
      return {
        texture: safeString(cfg.textureLocal || cfg.textureKey),
        mode: cfg.mode || 'split',
        scale: round(cfg.scale),
        offsetX: round(cfg.offsetX),
        offsetY: round(cfg.offsetY),
        rotation: round(cfg.rotation)
      };
    };
    const door = doorConfig && typeof doorConfig === 'object' ? doorConfig : {};
    const window = windowConfig && typeof windowConfig === 'object' ? windowConfig : {};
    return JSON.stringify({
      door: {
        texture: safeString(door.textureLocal || door.textureKey),
        flip: !!door.flip,
        frame: normalizeFrame(door.frame)
      },
      window: {
        flip: !!window.flip,
        sill: {
          texture: safeString(window.sill?.textureLocal || window.sill?.textureKey),
          scale: round(window.sill?.scale),
          offsetX: round(window.sill?.offsetX),
          offsetY: round(window.sill?.offsetY)
        },
        texture: {
          texture: safeString(window.texture?.textureLocal || window.texture?.textureKey),
          scale: round(window.texture?.scale),
          offsetX: round(window.texture?.offsetX),
          offsetY: round(window.texture?.offsetY)
        },
        frame: normalizeFrame(window.frame)
      }
    });
  }

  _isPortalTextureMissing(path) {
    const key = String(path || '');
    if (!key) return false;
    const missingAt = this._portalPreviewMissingCache.get(key);
    if (!missingAt) return false;
    if (Date.now() - missingAt > PORTAL_TEXTURE_MISSING_RETRY_MS) {
      this._portalPreviewMissingCache.delete(key);
      return false;
    }
    return true;
  }

  _markPortalTextureMissing(path) {
    const key = String(path || '');
    if (!key) return;
    this._portalPreviewMissingCache.set(key, Date.now());
    this._portalPreviewImageCache.delete(key);
  }

  _handleMissingPortalTexture(pickerType, texturePath) {
    const key = String(texturePath || '');
    if (!key) return false;
    this._markPortalTextureMissing(key);
    const cleared = this._clearPortalTexture(pickerType, { suppressNotice: true });
    if (cleared) this._portalPreviewMissingCache.delete(key);
    return cleared;
  }

  _clearPortalTexture(pickerType, { suppressNotice = false } = {}) {
    const manager = this._buildingManager;
    const delegate = manager?._delegate;
    if (!delegate) {
      if (!suppressNotice) {
        ui?.notifications?.warn?.('Start a building session first.');
      }
      return false;
    }

    const clearMap = {
      'door': '_handleDoorTextureSelected',
      'door-frame': '_handleDoorFrameTextureSelected',
      'window-sill': '_handleWindowSillTextureSelected',
      'window-texture': '_handleWindowTextureSelected',
      'window-frame': '_handleWindowFrameTextureSelected'
    };
    const method = clearMap[pickerType];
    if (!method || typeof delegate[method] !== 'function') return false;

    try {
      delegate[method](null);
    } catch (error) {
      Logger.warn?.('BuildingsTab.clearPortalTexture.failed', { pickerType, error: String(error?.message || error) });
      return false;
    }

    this._refreshPortalTextureThumbnails();
    return true;
  }

  _updatePortalCompositePreview(panel, { doorConfig = {}, windowConfig = {} } = {}) {
    const seq = ++this._portalPreviewRenderSeq;
    void this._renderPortalPreview(panel, 'door', doorConfig, seq);
    void this._renderPortalPreview(panel, 'window', windowConfig, seq);
  }

  async _renderPortalPreview(panel, previewId, config = {}, seq = 0) {
    const root = panel.querySelector(`[data-portal-preview="${previewId}"]`);
    if (!root) return;
    const canvas = root.querySelector('canvas.fa-portals-panel__preview-canvas');
    const placeholder = root.querySelector('.fa-portals-panel__preview-placeholder');
    if (!canvas) return;
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const isDoor = previewId === 'door';
    const isWindow = previewId === 'window';
    if (!isDoor && !isWindow) return;

    const data = config && typeof config === 'object' ? config : {};

    const doorPath = isDoor ? String(data.textureLocal || data.textureKey || '') : '';
    const doorFlip = isDoor ? !!data.flip : false;
    const frameConfig = isDoor ? (data.frame && typeof data.frame === 'object' ? data.frame : {}) : (isWindow ? (data.frame && typeof data.frame === 'object' ? data.frame : {}) : {});
    const framePath = String(frameConfig.textureLocal || frameConfig.textureKey || '');

    const sillConfig = isWindow ? (data.sill && typeof data.sill === 'object' ? data.sill : {}) : {};
    const glassConfig = isWindow ? (data.texture && typeof data.texture === 'object' ? data.texture : {}) : {};
    const sillPath = String(sillConfig.textureLocal || sillConfig.textureKey || '');
    const glassPath = String(glassConfig.textureLocal || glassConfig.textureKey || '');
    const glassFlip = isWindow ? !!data.flip : false;

    const hasAny =
      (isDoor && (doorPath || framePath)) ||
      (isWindow && (sillPath || glassPath || framePath));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!hasAny) {
      if (placeholder) placeholder.style.display = '';
      return;
    }
    if (placeholder) placeholder.style.display = 'none';

	    const CANVAS_W = canvas.width || 280;
	    const CANVAS_H = canvas.height || 120;
	    const PADDING = 10;
	    const GRID_SIZE = 100;
	    const ASSET_GRID = 200;
	    const BASE_ASSET_SCALE = GRID_SIZE / ASSET_GRID;

    const clamp = (value, min, max, fallback) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return fallback;
      return Math.max(min, Math.min(max, numeric));
    };

    const loadImage = (path) => {
      const key = String(path || '');
      if (!key) return Promise.resolve(null);
      if (this._isPortalTextureMissing(key)) return Promise.resolve(null);
      const cached = this._portalPreviewImageCache.get(key);
      if (cached) return cached;
      const promise = new Promise((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => {
          this._portalPreviewMissingCache.delete(key);
          resolve(img);
        };
        img.onerror = () => {
          this._markPortalTextureMissing(key);
          resolve(null);
        };
        img.src = key;
      });
      this._portalPreviewImageCache.set(key, promise);
      return promise;
    };

	    const toCommandsForElement = ({ img, width, height, offsetX = 0, offsetY = 0, flipX = false, flipY = false, z = 0 }) => {
	      if (!img || !img.naturalWidth || !img.naturalHeight) return [];
	      const sw = img.naturalWidth;
	      const sh = img.naturalHeight;
	      const scaleX = (width / sw) * (flipX ? -1 : 1);
	      const scaleY = (height / sh) * (flipY ? -1 : 1);
	      return [{
	        img,
	        sx: 0,
	        sy: 0,
        sw,
        sh,
        cx: offsetX,
        cy: offsetY,
        scaleX,
        scaleY,
        rotation: 0,
        z
      }];
    };

    const toCommandsForFrame = ({ img, frameCfg, gapLen, z = 10 }) => {
      if (!img || !img.naturalWidth || !img.naturalHeight) return [];
      const baseW = img.naturalWidth;
      const baseH = img.naturalHeight;
      const mode = String(frameCfg?.mode || 'split').toLowerCase();
      const userScale = clamp(frameCfg?.scale, 0.1, 3, 1);
      const assetScale = BASE_ASSET_SCALE * userScale;
      const heightScene = Math.max(1, baseH * assetScale);
      const offsetX = clamp(frameCfg?.offsetX, -1, 1, 0);
      const offsetY = clamp(frameCfg?.offsetY, -1, 1, 0);
      const rotationDeg = clamp(frameCfg?.rotation, -180, 180, 0);
      const rotationRad = (rotationDeg * Math.PI) / 180;

      const splitPillarWidthPx = Math.max(1, Math.min(baseH, Math.floor(baseW / 2)));
      const pillarWidthPx = mode === 'pillar' ? baseW : splitPillarWidthPx;
      const pillarWidthScene = pillarWidthPx * assetScale;
      const targetWidth = Math.max(pillarWidthScene * 2 + 1, gapLen + pillarWidthScene * 2);
      const groupCenterX = targetWidth / 2;
      const groupCenterY = heightScene / 2;

      const offsetXPx = offsetX * targetWidth * 0.5;
      const offsetYPx = offsetY * heightScene * 0.5;

      if (mode === 'scale') {
        // Match applyDoorFrameTile: stretch full texture to docWidth, ignore offsets/rotation.
        return [{
          img,
          sx: 0,
          sy: 0,
          sw: baseW,
          sh: baseH,
          cx: 0,
          cy: 0,
          scaleX: targetWidth / baseW,
          scaleY: assetScale,
          rotation: 0,
          z
        }];
      }

      if (mode === 'pillar') {
        const leftCenterX = pillarWidthScene * 0.5 + offsetXPx;
        const leftCenterY = heightScene * 0.5 + offsetYPx;
        const rightCenterX = targetWidth - pillarWidthScene * 0.5 - offsetXPx;
        const rightCenterY = heightScene * 0.5 + offsetYPx;
        return [
          {
            img,
            sx: 0,
            sy: 0,
            sw: baseW,
            sh: baseH,
            cx: leftCenterX - groupCenterX,
            cy: leftCenterY - groupCenterY,
            scaleX: assetScale,
            scaleY: assetScale,
            rotation: rotationRad,
            z
          },
          {
            img,
            sx: 0,
            sy: 0,
            sw: baseW,
            sh: baseH,
            cx: rightCenterX - groupCenterX,
            cy: rightCenterY - groupCenterY,
            scaleX: -assetScale,
            scaleY: assetScale,
            rotation: -rotationRad,
            z
          }
        ];
      }

      // Split mode
      const leftRectW = splitPillarWidthPx;
      const leftCenterX = pillarWidthScene * 0.5 + offsetXPx;
      const leftCenterY = heightScene * 0.5 + offsetYPx;
      const rightCenterX = targetWidth - pillarWidthScene * 0.5 - offsetXPx;
      const rightCenterY = heightScene * 0.5 + offsetYPx;
      return [
        {
          img,
          sx: 0,
          sy: 0,
          sw: leftRectW,
          sh: baseH,
          cx: leftCenterX - groupCenterX,
          cy: leftCenterY - groupCenterY,
          scaleX: assetScale,
          scaleY: assetScale,
          rotation: 0,
          z
        },
        {
          img,
          sx: Math.max(0, baseW - leftRectW),
          sy: 0,
          sw: leftRectW,
          sh: baseH,
          cx: rightCenterX - groupCenterX,
          cy: rightCenterY - groupCenterY,
          scaleX: assetScale,
          scaleY: assetScale,
          rotation: 0,
          z
        }
      ];
    };

    // Gather images
    const [
      doorImg,
      frameImg,
      sillImg,
      glassImg
    ] = await Promise.all([
      isDoor ? loadImage(doorPath) : Promise.resolve(null),
      framePath ? loadImage(framePath) : Promise.resolve(null),
      isWindow ? loadImage(sillPath) : Promise.resolve(null),
      isWindow ? loadImage(glassPath) : Promise.resolve(null)
    ]);

    if (seq !== this._portalPreviewRenderSeq) return;

    let clearedMissing = false;
    if (isDoor && doorPath && !doorImg) {
      clearedMissing = this._handleMissingPortalTexture('door', doorPath) || clearedMissing;
    }
    if (framePath && !frameImg) {
      const picker = isDoor ? 'door-frame' : 'window-frame';
      clearedMissing = this._handleMissingPortalTexture(picker, framePath) || clearedMissing;
    }
    if (isWindow && sillPath && !sillImg) {
      clearedMissing = this._handleMissingPortalTexture('window-sill', sillPath) || clearedMissing;
    }
    if (isWindow && glassPath && !glassImg) {
      clearedMissing = this._handleMissingPortalTexture('window-texture', glassPath) || clearedMissing;
    }
    if (clearedMissing) return;

    const roundToHalf = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return 0;
	      return Math.round(numeric * 2) / 2;
	    };

	    const guessGapSquares = (img, path, fallback = 2) => {
	      if (!img || !img.naturalWidth) return fallback;
	      const raw = img.naturalWidth / ASSET_GRID;
	      let squares = roundToHalf(raw);
	      if (!Number.isFinite(squares) || squares <= 0) squares = fallback;
	      squares = Math.max(0.5, squares);
	      const isSmall = String(path || '').toLowerCase().includes('small');
	      if (isSmall) squares = Math.min(squares, 0.5);
	      return squares;
	    };

	    const gapSquares = isDoor
	      ? guessGapSquares(doorImg, doorPath, 2)
	      : guessGapSquares(glassImg, glassPath, 2);
	    const gapLen = Math.max(1, gapSquares * GRID_SIZE);

	    const commands = [];
	    if (isDoor) {
	      if (doorImg) {
	        const desiredW = gapLen;
	        const desiredH = Math.max(1, doorImg.naturalHeight * (gapLen / Math.max(1, doorImg.naturalWidth)));
	        commands.push(
	          ...toCommandsForElement({
	            img: doorImg,
	            width: desiredW,
	            height: desiredH,
	            offsetX: 0,
	            offsetY: 0,
	            flipX: doorFlip,
	            flipY: false,
	            z: 0
	          })
	        );
	      }
	      if (frameImg) {
	        commands.push(
	          ...toCommandsForFrame({
	            img: frameImg,
	            frameCfg: frameConfig,
	            gapLen,
	            z: 10
	          })
	        );
	      }
	    } else if (isWindow) {
	      if (sillImg) {
	        const userScale = clamp(sillConfig?.scale, 0.1, 3, 1);
	        const height = Math.max(1, sillImg.naturalHeight * BASE_ASSET_SCALE * userScale);
	        const width = gapLen;
	        const offsetX = clamp(sillConfig?.offsetX, -1, 1, 0) * width * 0.5;
	        const offsetY = clamp(sillConfig?.offsetY, -1, 1, 0) * height * 0.5;
	        commands.push(...toCommandsForElement({ img: sillImg, width, height, offsetX, offsetY, flipX: false, flipY: false, z: 0 }));
	      }
	      if (glassImg) {
	        const userScale = clamp(glassConfig?.scale, 0.1, 3, 1);
	        const height = Math.max(1, glassImg.naturalHeight * BASE_ASSET_SCALE * userScale);
	        const width = gapLen;
	        const offsetX = clamp(glassConfig?.offsetX, -1, 1, 0) * width * 0.5;
	        const offsetY = clamp(glassConfig?.offsetY, -1, 1, 0) * height * 0.5;
	        // Non-animated window glass uses a separate tile and flips on the other axis (match placement behavior).
	        commands.push(...toCommandsForElement({ img: glassImg, width, height, offsetX, offsetY, flipX: false, flipY: glassFlip, z: 5 }));
	      }
	      if (frameImg) {
	        commands.push(
	          ...toCommandsForFrame({
	            img: frameImg,
	            frameCfg: frameConfig,
	            gapLen,
	            z: 10
	          })
	        );
	      }
	    }

    if (!commands.length) {
      if (placeholder) placeholder.style.display = '';
      return;
    }

	    // Scale/center from the "core gap" only so frame/sill resizing doesn't rescale the entire preview.
	    const coreH = (() => {
	      if (isDoor && doorImg && doorImg.naturalWidth && doorImg.naturalHeight) {
	        return Math.max(1, doorImg.naturalHeight * (gapLen / Math.max(1, doorImg.naturalWidth)));
	      }
	      if (isWindow && glassImg && glassImg.naturalHeight) {
	        return Math.max(1, glassImg.naturalHeight * BASE_ASSET_SCALE);
	      }
	      if (isWindow && sillImg && sillImg.naturalHeight) {
	        return Math.max(1, sillImg.naturalHeight * BASE_ASSET_SCALE);
	      }
	      return GRID_SIZE * 2;
	    })();
	    const scale = Math.min(
	      (CANVAS_W - PADDING * 2) / Math.max(1, gapLen),
	      (CANVAS_H - PADDING * 2) / Math.max(1, coreH)
	    );

	    // Draw a subtle baseline (wall reference)
	    try {
	      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
	      ctx.lineWidth = 2;
	      ctx.beginPath();
	      const y = CANVAS_H / 2;
	      ctx.moveTo(PADDING, y);
	      ctx.lineTo(CANVAS_W - PADDING, y);
	      ctx.stroke();
	      ctx.restore();
    } catch (_) {}

    // Draw commands in z-order
	    commands.sort((a, b) => (a.z || 0) - (b.z || 0));
	    for (const cmd of commands) {
	      try {
	        ctx.save();
	        const x = cmd.cx * scale + CANVAS_W / 2;
	        const y = cmd.cy * scale + CANVAS_H / 2;
	        ctx.translate(x, y);
	        if (cmd.rotation) ctx.rotate(cmd.rotation);
	        ctx.scale(cmd.scaleX * scale, cmd.scaleY * scale);
	        ctx.drawImage(cmd.img, cmd.sx, cmd.sy, cmd.sw, cmd.sh, -cmd.sw / 2, -cmd.sh / 2, cmd.sw, cmd.sh);
	        ctx.restore();
      } catch (_) { }
    }
  }

  _openPortalTexturePicker(pickerType) {
    const manager = this._buildingManager;
    const delegate = manager?._delegate;
    if (!delegate) {
      ui?.notifications?.warn?.('Start a building session first.');
      return;
    }

    // Map picker types to the delegate's picker methods
    const pickerMap = {
      'door': '_openDoorTexturePicker',
      'door-frame': '_openDoorFrameTexturePicker',
      'window-sill': '_openWindowSillTexturePicker',
      'window-texture': '_openWindowTexturePicker',
      'window-frame': '_openWindowFrameTexturePicker'
    };

    const method = pickerMap[pickerType];
    if (method && typeof delegate[method] === 'function') {
      try {
        delegate[method]();
      } catch (error) {
        Logger.warn?.('BuildingsTab.openPortalPicker.failed', { pickerType, error: String(error?.message || error) });
      }
    }
  }

  _canUsePortals() {
    // Check canvas readiness
    if (typeof canvas === 'undefined' || !canvas?.ready || !canvas?.stage) {
      return false;
    }
    // Check if building manager is active or if we have walls in the scene
    const manager = this._buildingManager;
    if (manager?.isActive) return true;
    // Check if there are any wall tiles in the scene that could be edited
    const scene = canvas.scene;
    if (scene?.tiles?.size > 0) {
      // Look for tiles with building wall flags
      for (const tile of scene.tiles) {
        const flags = tile.flags?.['fa-nexus']?.buildingWall;
        if (flags) return true;
      }
    }
    return false;
  }

  _destroyPortalPanel() {
    this._unbindPortalPanelHandlers();
    this._unregisterPortalToolOptionsCallback();
    if (this._portalPanel?.parentElement) {
      try { this._portalPanel.parentElement.removeChild(this._portalPanel); } catch (_) {}
    }
    this._portalPanel = null;
  }

  _buildTextureGridOptions(baseOptions) {
    const cardOptions = baseOptions?.card ? { ...baseOptions.card } : undefined;
    return {
      ...baseOptions,
      card: cardOptions,
      createRow: (item) => this._createTextureGridCard(item),
      onMountItem: (el, item) => this._mountTextureGridCard(el, item),
      onUnmountItem: (el, item) => this._unmountTextureGridCard(el, item)
    };
  }

  _createTextureGridCard(item) {
    if (this._isNoneTextureItem(item)) {
      return this._createNoneTextureCard();
    }
    return super._createAssetCard(item);
  }

  _mountTextureGridCard(cardElement, item) {
    if (this._isNoneTextureItem(item)) {
      this._mountNoneTextureCard(cardElement);
      return;
    }
    super._mountAssetCard(cardElement, item);
    this._syncTextureSelectionForCard(cardElement, item);
  }

  _unmountTextureGridCard(cardElement, item) {
    if (this._isNoneTextureItem(item)) {
      this._unmountNoneTextureCard(cardElement);
      return;
    }
    super._unmountAssetCard(cardElement, item);
  }

  _createNoneTextureCard() {
    const card = document.createElement('div');
    card.className = 'fa-nexus-card fa-buildings-none-texture-card';
    card.setAttribute('data-key', NONE_TEXTURE_KEY);
    card.setAttribute('data-none-texture', 'true');
    card.innerHTML = `
      <div class="fa-buildings-none-thumb">
        <div class="fa-buildings-none-icon"><i class="fas fa-ban"></i></div>
        <div class="fa-buildings-none-label">No Fill</div>
      </div>
    `;
    return card;
  }

  _mountNoneTextureCard(cardElement) {
    if (!cardElement) return;
    const clickHandler = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!(await this._ensureBuildingEditorAccess())) return;
      const previousKey = this._selectedFillTextureKey;
      this._selectFillTexture(NONE_TEXTURE_KEY);
      this._refreshVisibleTextureSelection();
      if (previousKey !== NONE_TEXTURE_KEY) {
        await this._handleFillTextureSelectionChanged({ key: NONE_TEXTURE_KEY, item: this._noneTextureItem, cardElement, triggerEvent: event });
      }
    };
    cardElement.addEventListener('click', clickHandler);
    cardElement._faNoneTextureClick = clickHandler;
    this._markTextureCardSelected(cardElement, this._selectedFillTextureKey === NONE_TEXTURE_KEY);
  }

  _unmountNoneTextureCard(cardElement) {
    if (!cardElement) return;
    const handler = cardElement._faNoneTextureClick;
    if (handler) {
      cardElement.removeEventListener('click', handler);
      delete cardElement._faNoneTextureClick;
    }
  }

  async _handleBuildingAssetCardClick(event, cardElement, item) {
    event.preventDefault();
    event.stopPropagation();
    if (!(await this._ensureBuildingEditorAccess())) {
      return;
    }
    const key = this._extractItemKey(item, cardElement);
    if (!key && !this._isNoneTextureItem(item)) return;

    if (this._activeSubtab === 'building') {
      if (this._isPathsItem(item)) {
        if (this._isCardPremiumLocked(item, cardElement)) {
          ui?.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
          return;
        }
        const ready = await this._ensureBuildingAssetReady(cardElement, item, {
          triggerEvent: event,
          label: 'Preparing wall path...'
        });
        if (!ready) return;
        this._selectOuterWallPath(key);
        const wallPathLocal = this._resolveAssetLocalPath(item, cardElement);
        if (this._buildingManager?.isActive) {
          try {
            await this._buildingManager.updateWallPath?.({ wallPathKey: key, wallPath: item, wallPathLocal });
          } catch (error) {
            Logger.warn?.('BuildingsTab.updateWallPath.failed', { error: String(error?.message || error), key, wallPathLocal });
            ui?.notifications?.error?.(`Failed to update wall path: ${error?.message || error}`);
          }
        } else {
          await this._startBuildingSession('outer', { triggerEvent: event });
        }
        return;
      }
      if (this._isTextureItem(item)) {
        if (!this._isNoneTextureItem(item) && this._isCardPremiumLocked(item, cardElement)) {
          ui?.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
          return;
        }
        if (!this._isNoneTextureItem(item)) {
          const ready = await this._ensureBuildingAssetReady(cardElement, item, {
            triggerEvent: event,
            label: 'Preparing fill texture...'
          });
          if (!ready) return;
        }
        this._selectFillTexture(key);
        this._refreshVisibleTextureSelection();
        await this._handleFillTextureSelectionChanged({ key, item, cardElement, triggerEvent: event });
        return;
      }
    }
  }

  _extractItemKey(item, cardElement) {
    if (this._isNoneTextureItem(item)) return NONE_TEXTURE_KEY;
    const keyFromItem = this._computeItemKey?.(item);
    if (keyFromItem) return keyFromItem;
    if (!cardElement) return '';
    return cardElement.getAttribute('data-key') || cardElement.getAttribute('data-file-path') || '';
  }

  _selectOuterWallPath(key) {
    this._selectedOuterWallPathKey = key || '';
    this._applyPathSelection(this._selectedOuterWallPathKey);
  }

  _selectFillTexture(key) {
    const normalized = key || NONE_TEXTURE_KEY;
    this._selectedFillTextureKey = normalized;
  }

  async _handleFillTextureSelectionChanged({ key = NONE_TEXTURE_KEY, item = null, cardElement = null } = {}) {
    const manager = this._buildingManager;
    if (!manager || !manager.isActive) return;
    const payload = {
      fillTextureKey: key || NONE_TEXTURE_KEY,
      fillTexture: item && !this._isNoneTextureItem(item) ? item : null,
      fillTextureLocal: ''
    };
    if (payload.fillTexture && cardElement) {
      payload.fillTextureLocal = this._resolveAssetLocalPath(payload.fillTexture, cardElement);
    }
    try {
      await manager.updateFillTexture?.(payload);
    } catch (error) {
      Logger.warn?.('BuildingsTab.updateFillTexture.failed', { error: String(error?.message || error), payload });
      ui?.notifications?.error?.(`Failed to update fill texture: ${error?.message || error}`);
    }
  }

  _applyPathSelection(key) {
    if (!this._selection) return;
    try { this._selection.selectedKeys.clear(); } catch (_) {}
    if (key) {
      try { this._selection.selectedKeys.add(key); } catch (_) {}
    }
    try {
      this._selection.lastClickedIndex = key ? this._indexOfVisibleKey(key) : -1;
      this._refreshSelectionUIInView();
    } catch (_) {}
  }

  _restoreSubtabSelections() {
    if (this._activeSubtab === 'building') {
      this._applyPathSelection(this._selectedOuterWallPathKey);
      this._refreshVisibleTextureSelection();
    } else {
      this._applyPathSelection('');
    }
  }

  _injectNoneTextureItem(textureItems) {
    const list = Array.isArray(textureItems) ? [...textureItems] : [];
    if (!list.length || !this._isNoneTextureItem(list[0])) {
      list.unshift(this._noneTextureItem);
    }
    return list;
  }

  _isNoneTextureItem(item) {
    return !!(item && (item.isNoneTexture || item.id === NONE_TEXTURE_ITEM.id));
  }

  _syncTextureSelectionForCard(cardElement, item) {
    if (!cardElement) return;
    const key = this._extractItemKey(item, cardElement);
    this._markTextureCardSelected(cardElement, key === this._selectedFillTextureKey);
  }

  _refreshVisibleTextureSelection() {
    const container = this._texturesGrid?.container;
    if (!container) return;
    container.querySelectorAll('.fa-nexus-card').forEach((card) => {
      const key = card.getAttribute('data-key') || card.getAttribute('data-file-path') || '';
      this._markTextureCardSelected(card, key === this._selectedFillTextureKey);
    });
  }

  _markTextureCardSelected(card, selected) {
    if (!card) return;
    card.classList.toggle('fa-nexus-selected', !!selected);
    if (selected) card.setAttribute('data-selected', 'true');
    else card.removeAttribute('data-selected');
  }

  forceNoFillSelection({ notifyManager = true } = {}) {
    const previousKey = this._selectedFillTextureKey;
    this._selectFillTexture(NONE_TEXTURE_KEY);
    this._refreshVisibleTextureSelection();
    if (notifyManager && previousKey !== NONE_TEXTURE_KEY) {
      return this._handleFillTextureSelectionChanged({
        key: NONE_TEXTURE_KEY,
        item: this._noneTextureItem,
        cardElement: null
      });
    }
    return null;
  }

  _getBuildingManager() {
    if (!this._buildingManager) {
      this._buildingManager = new BuildingManager(this.app);
    }
    return this._buildingManager;
  }

  async _ensureBuildingAssetReady(cardElement, item, { triggerEvent = null, label = 'Preparing asset...' } = {}) {
    if (!item || this._isNoneTextureItem(item)) return true;
    if (this._isCardPremiumLocked(item, cardElement)) {
      ui?.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
      return false;
    }
    const ensureLocal = this._cards?.ensureLocalAssetForCard;
    if (!ensureLocal) return true;
    const localPath = await ensureLocal.call(this._cards, cardElement, item, { triggerEvent, label });
    if (localPath) return true;

    const source = (cardElement?.getAttribute?.('data-source') || item?.source || '').toLowerCase();
    if (source && source !== 'cloud') {
      const fallback = cardElement?.getAttribute?.('data-file-path') || this._resolveFilePath?.(item) || item?.file_path || item?.path || item?.url || '';
      if (fallback) {
        item.cachedLocalPath = item.cachedLocalPath || fallback;
        return true;
      }
    }
    return false;
  }

  async _prepareSessionAssets(mode, { triggerEvent = null } = {}) {
    const wallKey = this._selectedOuterWallPathKey;
    if (!wallKey) {
      ui?.notifications?.warn?.('Select a wall path asset to start Building Tool.');
      return null;
    }
    const wallAsset = this._findItemByKey(wallKey);
    if (!wallAsset) return null;
    const wallCard = this._findCardElementByKey(wallKey, 'paths');
    const wallReady = await this._ensureBuildingAssetReady(wallCard, wallAsset, {
      triggerEvent,
      label: 'Preparing wall path...'
    });
    if (!wallReady) return null;

    let fillAsset = null;
    let fillTextureLocal = '';
    if (mode === 'outer' && this._selectedFillTextureKey && this._selectedFillTextureKey !== NONE_TEXTURE_KEY) {
      fillAsset = this._findItemByKey(this._selectedFillTextureKey);
      if (fillAsset) {
        const fillCard = this._findCardElementByKey(this._selectedFillTextureKey, 'textures');
        const fillReady = await this._ensureBuildingAssetReady(fillCard, fillAsset, {
          triggerEvent,
          label: 'Preparing fill texture...'
        });
        if (!fillReady) return null;
        fillTextureLocal = this._resolveAssetLocalPath(fillAsset, fillCard);
      }
    }

    const wallPathLocal = this._resolveAssetLocalPath(wallAsset, wallCard);

    return { wallKey, wallAsset, fillAsset, wallPathLocal, fillTextureLocal };
  }

  _findCardElementByKey(key, scope = 'paths') {
    if (!key) return null;
    const container = scope === 'textures' ? this._texturesGrid?.container : this.app?._grid?.container;
    if (!container) return null;
    const cards = container.querySelectorAll('.fa-nexus-card');
    for (const card of cards) {
      const dataKey = card.getAttribute('data-key') || card.getAttribute('data-file-path') || '';
      if (dataKey === key) return card;
    }
    return null;
  }

  _resolveAssetLocalPath(item, cardElement) {
    if (!item) return '';
    if (item.cachedLocalPath) return item.cachedLocalPath;
    const cardUrl = cardElement?.getAttribute?.('data-url');
    if (cardUrl) {
      item.cachedLocalPath = cardUrl;
      return cardUrl;
    }
    const filePath = cardElement?.getAttribute?.('data-file-path') || this._resolveFilePath?.(item) || item?.file_path || item?.path || item?.url || '';
    if (filePath) item.cachedLocalPath = filePath;
    return filePath;
  }

  async _startBuildingSession(mode = 'outer', { triggerEvent = null } = {}) {
    const manager = this._getBuildingManager();
    if (!manager) return;

    const assets = await this._prepareSessionAssets(mode, { triggerEvent });
    if (!assets) return;

    const { wallKey, wallAsset, fillAsset, wallPathLocal, fillTextureLocal } = assets;
    const session = {
      mode,
      wallPathKey: wallKey,
      wallPath: wallAsset,
      wallPathLocal,
      fillTextureKey: this._selectedFillTextureKey,
      fillTexture: fillAsset,
      fillTextureLocal,
      portalMode: this._activeSubtab === 'portals'
    };

    try {
      await manager.start(session);
      this._attachEscapeListener();
    } catch (error) {
      Logger.warn?.('BuildingsTab.building.start.failed', { mode, error: String(error?.message || error) });
      const code = String(error?.code || error?.name || '').toUpperCase();
      if (code === 'ENTITLEMENT_REQUIRED' || /premium/i.test(String(error?.message || ''))) {
        ui?.notifications?.warn?.('Building Editor is a premium feature. Please connect Patreon to continue.');
      } else {
        ui?.notifications?.error?.(`Failed to start Building Editor: ${error?.message || error}`);
      }
      this._detachEscapeListener();
    }
  }

  _findItemByKey(key) {
    if (!key || !Array.isArray(this._items)) return null;
    return this._items.find((item) => this._computeItemKey?.(item) === key) || null;
  }

  _isCardPremiumLocked(item, cardElement) {
    try {
      const authed = typeof this._hasPremiumAuth === 'function' ? this._hasPremiumAuth() : false;
      return !!this._isAssetLocked?.(item, cardElement, { authed });
    } catch (_) {
      return false;
    }
  }

  async _ensureBuildingEditorAccess() {
    const helper = this._cards;
    if (helper && typeof helper._requirePremiumFeature === 'function') {
      return helper._requirePremiumFeature('building.edit', { label: 'Building Editor' });
    }
    const authed = typeof this._hasPremiumAuth === 'function' ? this._hasPremiumAuth() : false;
    if (authed) return true;
    ui?.notifications?.error?.('Building Editor is a premium feature. Please connect Patreon.');
    return false;
  }

  _stopBuildingSession({ reason = 'manual' } = {}) {
    const manager = this._buildingManager;
    if (!manager) return;
    if (!manager.isActive) {
      this._stopBuildingManager(manager, { reason });
      return;
    }
    if (reason === 'tab-deactivate') {
      const hasChanges = typeof manager.hasSessionChanges === 'function'
        ? manager.hasSessionChanges()
        : true;
      if (!hasChanges) {
        this._stopBuildingManager(manager, { reason });
        return;
      }
      const canCommit = typeof manager.canCommitSession === 'function'
        ? manager.canCommitSession()
        : true;
      if (!canCommit) {
        Logger.info?.('BuildingsTab.building.commit.skipped', { reason, cause: 'session-not-committable' });
        this._stopBuildingManager(manager, { reason: `${reason}-discard` });
        return;
      }
      if (typeof manager.commitBuilding === 'function') {
        Promise.resolve()
          .then(() => manager.commitBuilding({ reason }))
          .catch((error) => {
            if (isBenignBuildingCommitError(error)) {
              Logger.info?.('BuildingsTab.building.commit.discarded', {
                reason,
                error: String(error?.message || error)
              });
              return this._stopBuildingManager(manager, { reason: `${reason}-discard` });
            }
            Logger.warn?.('BuildingsTab.building.commit.failed', { reason, error: String(error?.message || error) });
            return null;
          })
          .finally(() => {
            if (!manager.isActive) this._detachEscapeListener();
          });
        return;
      }
    }
    if (reason === 'esc') {
      if (typeof manager.requestCancelSession === 'function') {
        const cancelPromise = manager.requestCancelSession({ reason });
        if (cancelPromise?.catch) {
          cancelPromise.catch((error) => {
            Logger.warn?.('BuildingsTab.building.cancel.failed', { reason, error: String(error?.message || error) });
          });
        }
        Promise.resolve(cancelPromise).then((cancelled) => {
          if (cancelled || !manager.isActive) this._detachEscapeListener();
        });
        return;
      }
    }
    this._stopBuildingManager(manager, { reason });
  }

  _stopBuildingManager(manager, { reason = 'manual' } = {}) {
    try {
      const stopPromise = manager?.stop?.({ reason });
      Promise.resolve(stopPromise)
        .catch((error) => {
          Logger.warn?.('BuildingsTab.building.stop.failed', { reason, error: String(error?.message || error) });
        })
        .finally(() => {
          this._detachEscapeListener();
        });
      return stopPromise;
    } catch (error) {
      Logger.warn?.('BuildingsTab.building.stop.failed', { reason, error: String(error?.message || error) });
      this._detachEscapeListener();
      return null;
    }
  }

  _attachEscapeListener() {
    if (this._escapeListenerAttached) return;
    const target = globalThis?.window || globalThis;
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener('keydown', this._boundEscapeHandler, true);
    this._escapeListenerAttached = true;
    this._escapeListenerTarget = target;
  }

  _detachEscapeListener() {
    if (!this._escapeListenerAttached || !this._escapeListenerTarget) return;
    try {
      this._escapeListenerTarget.removeEventListener('keydown', this._boundEscapeHandler, true);
    } catch (_) {}
    this._escapeListenerAttached = false;
    this._escapeListenerTarget = null;
  }

  _handleGlobalKeydown(event) {
    if (!event || event.key !== 'Escape') return;
    if (!this._buildingManager?.isActive) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    this._stopBuildingSession({ reason: 'esc' });
  }
}

export default BuildingsTab;
