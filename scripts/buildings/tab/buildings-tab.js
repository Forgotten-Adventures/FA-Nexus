import { AssetsTab } from '../../assets/assets-tab.js';
import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { VirtualGridManager } from '../../core/ui/virtual-grid-manager.js';
import { BuildingManager } from '../building-manager.js';
import '../building-tiles.js';
import {
  BUILDING_TEXTURE_BOOKMARK_TAB,
  DEFAULT_SUBTAB,
  GAP_KIND_DOOR,
  MODULE_ID,
  NONE_TEXTURE_ITEM,
  SETTING_ACTIVE_SUBTAB,
  SETTING_SEARCH_STATE,
  SUBTABS,
  SUBTAB_LABELS,
  TEXTURE_DEPRIORITIZED_NAME_TOKENS,
  TEXTURE_DEPRIORITIZED_PATH_TOKEN,
  WALL_BIAS_QUERY,
  WALL_SEGMENT_PATTERN,
  WALL_SEGMENT_TOKENS
} from './constants.js';
import { fillBrowserMethods } from './fill-browser.js';
import { launchActionMethods } from './launch-actions.js';
import { portalPanelMethods } from './portal-panel.js';
import { selectionStateMethods } from './selection-state.js';

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

export class BuildingsTab extends AssetsTab {
  constructor(app) {
    super(app, { mode: 'assets' });
    this._tabId = 'buildings';
    this._activeSubtab = DEFAULT_SUBTAB;
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
    this._selectedFillTextureKey = NONE_TEXTURE_ITEM.file_path;
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
    this._cards.handleTextureCardClick = async () => {};
    this._cards.handlePathCardClick = async () => {};
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
    this._portalPanel = null;
    this._portalPanelHandlers = null;
    this._activePortalType = GAP_KIND_DOOR;
    this._portalToolOptionsCallback = null;
    this._portalToolOptionsCallbackDisposer = null;
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
    this._selectedFillTextureKey = NONE_TEXTURE_ITEM.file_path;
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

    this._ensureSubtabControls();
    this._updateSubtabSelection();
    this._updateSectionVisibility();
    this._applyGridSplitRatio();
    this._restoreSubtabSelections();
    this._applySubtabThumbSize();

    if (this._buildingManager) {
      if (subtab === 'portals') {
        this._buildingManager.setPortalMode(true);
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
      const sorted = this._sortFillTextureItems(textures, { query: normalizedQuery });
      return this._applyGridSortMode(sorted, { scope: BUILDING_TEXTURE_BOOKMARK_TAB, query: normalizedQuery });
    }
    const paths = filtered.filter((item) => this._isPathsItem?.(item));
    const sorted = this._sortBuildingPathItems(paths, { query: normalizedQuery });
    return this._applyGridSortMode(sorted, { scope: this.id, query: normalizedQuery });
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
    const folder = this._getNormalizedFolderPath?.(item) || '';
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
    this._updatePortalPanelVisibility(showPortals);
  }

  _getBuildingManager() {
    if (!this._buildingManager) {
      this._buildingManager = new BuildingManager(this.app);
    }
    return this._buildingManager;
  }
}

Object.assign(
  BuildingsTab.prototype,
  fillBrowserMethods,
  portalPanelMethods,
  selectionStateMethods,
  launchActionMethods
);

export default BuildingsTab;
