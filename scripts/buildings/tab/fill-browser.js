import { AssetsTab } from '../../assets/assets-tab.js';
import { BookmarkToolbar } from '../../core/bookmarks/bookmark-toolbar.js';
import {
  BUILDING_TEXTURE_BOOKMARK_TAB,
  BUILDING_TEXTURE_THUMB_SETTING,
  MODULE_ID,
  NONE_TEXTURE_KEY
} from './constants.js';

export const fillBrowserMethods = {
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
          <button class="fa-nexus-icon-button fa-nexus-sort-mode fa-buildings-texture-sort-mode" type="button" title="Sorting by newest. Click for category." aria-label="Sorting by newest. Click for category." data-sort-mode="newest">
            <i class="fas fa-arrow-down-wide-short"></i>
          </button>
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
  },

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
    this._bindTextureSortModeButton();
    this._ensureTextureBookmarkToolbar();
    this._syncTextureSearchField();
    this._updateTextureFolderIndicator();
  },

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
  },

  _removeTextureSearchHandlers() {
    if (Array.isArray(this._textureSearchHandlers)) {
      while (this._textureSearchHandlers.length) {
        const off = this._textureSearchHandlers.pop();
        try { off?.(); } catch (_) {}
      }
    }
  },

  _clearTextureSearchDebounce() {
    if (this._textureSearchDebounceId) {
      clearTimeout(this._textureSearchDebounceId);
      this._textureSearchDebounceId = null;
    }
  },

  _syncTextureSearchField() {
    const input = this._textureControls?.searchInput;
    if (!input) return;
    input.value = this._getBuildingTextureSearch();
    this._updateTextureSearchUI();
  },

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
  },

  _updateTextureFolderIndicator() {
    const wrap = this._textureControls?.searchWrap;
    const clearFoldersBtn = this._textureControls?.clearFoldersButton;
    if (!wrap || !clearFoldersBtn) return;
    const controller = this.app?._folderFilterController;
    const hasFilter = controller?.hasActiveFilter?.('buildings') ?? false;
    wrap.classList.toggle('has-folder-filter', hasFilter);
    clearFoldersBtn.style.display = hasFilter ? 'inline-flex' : 'none';
  },

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
      try { await game.settings.set(MODULE_ID, BUILDING_TEXTURE_THUMB_SETTING, value); } catch (_) {}
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
  },

  _bindTextureSortModeButton() {
    const section = this._textureControls?.section;
    if (!section || typeof this._bindSortModeButton !== 'function') return;
    this._bindSortModeButton({
      root: section,
      selector: '.fa-buildings-texture-sort-mode',
      scope: BUILDING_TEXTURE_BOOKMARK_TAB,
      getQuery: () => this._getBuildingTextureSearch(),
      onChange: () => this.applyTextureSearch(this._getBuildingTextureSearch())
    });
  },

  _getStoredTextureThumbSize() {
    try {
      const value = Number(game.settings.get(MODULE_ID, BUILDING_TEXTURE_THUMB_SETTING) || 0);
      if (value) return this._sanitizeThumbSize(value);
    } catch (_) {}
    return this._sanitizeThumbSize(this.thumbSliderDefault);
  },

  _getTextureThumbSliderValue() {
    const slider = this._textureControls?.slider;
    if (slider && slider.value !== undefined) {
      const numeric = Number(slider.value);
      if (Number.isFinite(numeric)) return this._sanitizeThumbSize(numeric);
    }
    return this._getStoredTextureThumbSize();
  },

  _computeTextureThumbDimensions(value) {
    const base = Math.max(1, Math.round(value));
    return { width: base, height: base };
  },

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
      container.style.setProperty('--fa-nexus-footer-pt', `${4 * t}px`);
    }
  },

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
  },

  _destroyTextureBookmarkToolbar() {
    if (this._textureBookmarkToolbar) {
      try { this._textureBookmarkToolbar.cleanup(); } catch (_) {}
    }
    this._textureBookmarkToolbar = null;
    this._textureSearchAdapter = null;
  },

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
  },

  _bindGridResizer(handle) {
    if (!handle) return;
    if (this._gridResizerHandlers?.pointerdown) {
      handle.removeEventListener('pointerdown', this._gridResizerHandlers.pointerdown);
    }
    const onPointerDown = (event) => this._onGridResizerPointerDown(event);
    handle.addEventListener('pointerdown', onPointerDown);
    this._gridResizerHandlers = { pointerdown: onPointerDown };
  },

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
  },

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
  },

  _clampGridSplitRatio(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0.6;
    return Math.min(0.75, Math.max(0.2, numeric));
  },

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
  },

  _updateGridResizerVisibility() {
    if (!this._gridResizer) return;
    const show = this._activeSubtab === 'building' && !this._texturesSection?.classList.contains('is-hidden');
    this._gridResizer.classList.toggle('is-hidden', !show);
  },

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
  },

  _cancelGridResizerDrag() {
    if (typeof this._gridResizerDragCleanup === 'function') {
      try { this._gridResizerDragCleanup(); } catch (_) {}
      this._gridResizerDragCleanup = null;
    }
  },

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
  },

  _uninstallTextureHoverPreview() {
    const handlers = this._textureHoverHandlers;
    if (!handlers) return;
    const { container, over, out, leave } = handlers;
    try { container.removeEventListener('mouseover', over); } catch (_) {}
    try { container.removeEventListener('mouseout', out); } catch (_) {}
    try { container.removeEventListener('mouseleave', leave); } catch (_) {}
    this._textureHoverHandlers = null;
  },

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
  },

  _teardownTextureControls() {
    this._clearTextureSearchDebounce();
    this._removeTextureSearchHandlers();
    this._destroyTextureBookmarkToolbar();
    this._resetTextureControlsState();
  },

  _setIndexingLock(active, message = 'Indexing cloud assets...') {
    AssetsTab.prototype._setIndexingLock.call(this, active, message);
    if (this._texturesGridContainer) {
      this._texturesGridContainer.classList.toggle('is-locked', !!active);
      if (active) this._texturesGridContainer.setAttribute('aria-busy', 'true');
      else this._texturesGridContainer.removeAttribute('aria-busy');
    }
  },

  _buildTextureGridOptions(baseOptions) {
    const cardOptions = baseOptions?.card ? { ...baseOptions.card } : undefined;
    return {
      ...baseOptions,
      card: cardOptions,
      createRow: (item) => this._createTextureGridCard(item),
      onMountItem: (el, item) => this._mountTextureGridCard(el, item),
      onUnmountItem: (el, item) => this._unmountTextureGridCard(el, item)
    };
  },

  _createTextureGridCard(item) {
    if (this._isNoneTextureItem(item)) {
      return this._createNoneTextureCard();
    }
    return AssetsTab.prototype._createAssetCard.call(this, item);
  },

  _mountTextureGridCard(cardElement, item) {
    if (this._isNoneTextureItem(item)) {
      this._mountNoneTextureCard(cardElement);
      return;
    }
    AssetsTab.prototype._mountAssetCard.call(this, cardElement, item);
    this._syncTextureSelectionForCard(cardElement, item);
  },

  _unmountTextureGridCard(cardElement, item) {
    if (this._isNoneTextureItem(item)) {
      this._unmountNoneTextureCard(cardElement);
      return;
    }
    AssetsTab.prototype._unmountAssetCard.call(this, cardElement, item);
  },

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
  },

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
  },

  _unmountNoneTextureCard(cardElement) {
    if (!cardElement) return;
    const handler = cardElement._faNoneTextureClick;
    if (handler) {
      cardElement.removeEventListener('click', handler);
      delete cardElement._faNoneTextureClick;
    }
  }
};
