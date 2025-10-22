import { GridBrowseTab } from '../core/ui/grid-browse-tab.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { AssetPreviewManager } from './assets-preview-manager.js';
import { NexusContentService } from '../content/nexus-content-service.js';
import {
  normalizeFolderSelection,
  enforceFolderSelectionAvailability,
  mergeFolderSelectionExcludes,
  folderSelectionKey,
  logFolderSelection
} from '../content/content-sources/content-sources-utils.js';
import { createEmptyFolderTreeIndex } from '../content/folder-tree-index.js';
import { AssetsTabController } from './assets-tab-controller.js';
import { AssetsTabSelectionHelper } from './assets-selection-helper.js';
import { AssetsTabProbeHelper } from './assets-probe-helper.js';
import { AssetsTabCardHelper } from './assets-card-helper.js';

/**
 * AssetsTab
 * Local assets browser tab with virtualized grid, per‑tab search and thumbnail sizing,
 * throttled image loading, hover preview, and click‑to‑place tile placement.
 */
export class AssetsTab extends GridBrowseTab {
  /**
   * @param {import('../nexus-app.js').FaNexusApp} app
   */
  constructor(app, options = {}) {
    super(app);
    this._controller = new AssetsTabController(this, options);
    this._loadId = 0;
    this._boundSettingsChange = null;
    // Cloud integration
    this._cloudAbort = null;
    this._indexingLocks = 0;
    this._selection = new AssetsTabSelectionHelper(this);
    this._probe = new AssetsTabProbeHelper(this);
    this._cards = new AssetsTabCardHelper(this);
    // Deferred cache-state probing (run when scrolling stops)
    this._pendingProbeAfterThumbAdjust = false;
    this._deferredActivationTimeout = null;
    this._needsReload = false;
    this._dropShadowUpdateHandler = null;
    const requestedMode = String(options?.mode || 'assets').toLowerCase();
    this._mode = ['textures', 'paths'].includes(requestedMode) ? requestedMode : 'assets';
    this._activeFolderSelection = { type: 'all', includePaths: [], includePathLowers: [] };
    this._folderStats = {
      pathCounts: [],
      lowerKeys: new Set(),
      unassignedCount: 0,
      tree: createEmptyFolderTreeIndex(),
      version: 0
    };
  }

  get id() { return this._mode; }

  get isTexturesMode() { return this._mode === 'textures'; }

  get isPathsMode() { return this._mode === 'paths'; }

  get asyncSearchThreshold() { return 50000; }

  get placementManager() {
    return this._controller?.placementManager || this._placement || null;
  }

  get texturePaintManager() {
    return this._controller?.texturePaintManager || this._texturePaint || null;
  }

  get pathManager() {
    return this._controller?.pathManager || this._pathManager || null;
  }

  get contentService() {
    return this._controller?.contentService || this._content || null;
  }

  get downloadManager() {
    return this._controller?.downloadManager || this._download || null;
  }

  get assetsService() {
    return this._controller?.assetsService || this._assets || null;
  }

  getPlaceholderCardSize() {
    const base = super.getPlaceholderCardSize();
    const app = this.app;
    const defaultGap = this.getGridOptions?.()?.card?.gap ?? base.gap;
    let width = base.width;
    try {
      const settingKey = this.isTexturesMode ? 'thumbWidthTextures' : this.isPathsMode ? 'thumbWidthPaths' : 'thumbWidthAssets';
      const saved = Number(game.settings.get('fa-nexus', settingKey) || game.settings.get('fa-nexus', 'thumbWidth') || 0);
      if (Number.isFinite(saved) && saved > 0) width = saved;
    } catch (_) {}
    width = Math.max(54, Math.min(108, width));
    const height = width; // square thumbnails for assets/textures/paths
    const gap = Math.max(2, Math.round(defaultGap || 4));
    if (app?._grid?.card) {
      return {
        width: Math.round(app._grid.card.width),
        height: Math.round(app._grid.card.height),
        gap
      };
    }
    return { width: Math.round(width), height: Math.round(height), gap };
  }

  /**
   * VirtualGrid options for asset cards
   * @returns {{rowHeight:number,overscan:number,card:{width:number,height:number,gap:number},createRow:function,onMountItem:function,onUnmountItem:function}}
   */
  getGridOptions() {
    const self = this;
    return {
      rowHeight: 40,
      overscan: 5,
      card: { width: 140, height: 140, gap: 4 },
      createRow: (item) => self._createAssetCard(item),
      onMountItem: (el, item) => self._mountAssetCard(el, item),
      onUnmountItem: (el) => self._unmountAssetCard(el)
    };
  }

  supportsFolderBrowser() {
    return true;
  }

  getActiveFolderSelection() {
    const normalized = normalizeFolderSelection(this._activeFolderSelection, {
      normalizePath: (value) => this._normalizeFolderPath(value)
    });
    logFolderSelection('AssetsTab.selection.getActiveFolderSelection', normalized, { logger: Logger });
    return normalized;
  }

  onFolderSelectionChange(selection) {
    if (!this.supportsFolderBrowser()) return;
    this._activeFolderSelection = normalizeFolderSelection(selection, {
      normalizePath: (value) => this._normalizeFolderPath(value)
    });
    logFolderSelection('AssetsTab.selection.normalize', this._activeFolderSelection, { logger: Logger });

    // Filter the grid first for immediate visual feedback
    this.applySearch(this.getCurrentSearchValue());

    // Then update the folder filter UI (can be slightly delayed)
    try { this.app?.updateFolderFilterSelection?.(this.id, this._activeFolderSelection); } catch (_) {}
  }

  /** Track the visible list for range-selection and refresh selection UI */
  afterApplySearch(filtered, _query) {
    super.afterApplySearch(filtered, _query);
    try { this._selection.resetVisibleItems(filtered); } catch (_) {}
    try { this._selection.refreshSelectionUI(); } catch (_) {}
    try { this._scheduleProbeVisibleCards(); } catch (_) {}
  }

  createPreviewManager() {
    const app = this.app;
    let content = this.contentService;
    if (!content) {
      if (app && app._contentService) {
        content = app._contentService;
        try {
          const authProvider = (app && typeof app._getAuthService === 'function') ? () => app._getAuthService() : undefined;
          content?.setAuthContext?.({ app, authService: authProvider });
        } catch (_) {}
      } else {
        const authProvider = (app && typeof app._getAuthService === 'function') ? () => app._getAuthService() : undefined;
        content = new NexusContentService({ app: app || null, authService: authProvider });
      }
      if (this._controller) this._controller._content = content;
      this._content = content;
    }
    const events = app?._events || null;
    return new AssetPreviewManager(content, events);
  }

  getHoverPreviewDelay() {
    return 100;
  }

  _setIndexingLock(active, message = 'Indexing cloud assets...') {
    this._controller.setIndexingLock(active, message);
  }

  _cancelInFlight(reason = 'cancelled') {
    this._controller.cancelActiveOperations(reason);
  }

  cancelActiveOperations(reason = 'cancelled') {
    this._controller.cancelActiveOperations(reason);
  }

  _markNeedsReload(reason = 'settings') {
    this._controller.markNeedsReload(reason);
  }

  /** Activate the tab: grid, placement manager, footer, hover preview, and data load */
  async onActivate() {
    Logger.info('AssetsTab.onActivate:start', { tab: this.id, hasItems: !!(this._items && this._items.length) });
    const app = this.app;

    await this._controller.ensureServices();

    await super.onActivate();
    try { this._installProbeScrollHandler(); } catch (_) {}

    // Hook settings updates (while Assets tab is active)
    if (!this._boundSettingsChange) {
      const appRef = this.app;
      this._boundSettingsChange = async (setting) => {
        if (!setting || setting.namespace !== 'fa-nexus') return;
        const isActive = appRef?._activeTab === this.id;
        if (setting.key === 'assetFolders' || setting.key === 'cloudAssetsEnabled') {
          if (!isActive) return;
          if (!app.rendered || !app.element || !app._grid) return;
          this._needsReload = false;
          try {
            await this.loadAssets({ forceReload: true });
          } finally {
            this._needsReload = this._controller.sharedCatalog.dirty;
          }
          return;
        }
        if (!isActive) return;
        if (!app.rendered || !app.element || !app._grid) return;
        if (setting.key === 'hideLocked') {
          await this.applySearchAsync(this.getCurrentSearchValue());
        } else if (setting.key === 'patreon_auth_data') {
          this._updateHideLockedVisibility();
          try {
            const auth = setting.value;
            if (auth && auth.authenticated && auth.state) {
              game.settings.set('fa-nexus', 'hideLocked', false);
            }
          } catch (_) {}
          await this.applySearchAsync(this.getCurrentSearchValue());
        } else if (setting.key === 'assetDropShadow') {
          this._updateDropShadowControl();
        }
      };
      try { Hooks.on('updateSetting', this._boundSettingsChange); } catch (_) {}
    }

    // Initial data: unified local/cloud pipeline
    const sharedCatalog = this._controller.sharedCatalog;
    const needsInitialLoad = !Array.isArray(this._items) || this._items.length === 0;
    const shouldForceReload = this._needsReload || sharedCatalog.dirty;
    if (needsInitialLoad || shouldForceReload) {
      const reason = needsInitialLoad ? 'initial' : 'forced';
      Logger.info('AssetsTab.onActivate:loadAssets:start', { tab: this.id, reason });
      this._needsReload = false;
      try {
        const options = shouldForceReload ? { forceReload: true } : {};
        await this.loadAssets(options);
      } finally {
        if (shouldForceReload) this._needsReload = sharedCatalog.dirty;
      }
      Logger.info('AssetsTab.onActivate:loadAssets:complete', { tab: this.id, itemCount: this._items?.length || 0, reason });
    } else {
      Logger.info('AssetsTab.onActivate:useCachedData', { tab: this.id, itemCount: this._items.length });
      // Defer all heavy operations to avoid blocking tab switch completion
      Logger.info('AssetsTab.onActivate:deferOperations', { tab: this.id });
      if (this._deferredActivationTimeout) {
        try { clearTimeout(this._deferredActivationTimeout); } catch (_) {}
      }
      this._deferredActivationTimeout = setTimeout(() => {
        this._deferredActivationTimeout = null;
        if (!this.app || this.app._activeTab !== this.id || !this.app._grid) {
          Logger.info('AssetsTab.onActivate:deferredOps:skipped', { tab: this.id, activeTab: this.app?._activeTab });
          return;
        }
        Logger.info('AssetsTab.onActivate:deferredOps:start', { tab: this.id });
        try {
          if (this.supportsFolderBrowser()) {
            Logger.info('AssetsTab.onActivate:computeFolderStats', { tab: this.id });
            this._computeFolderStats(Array.isArray(this._items) ? this._items : []);
            if (sharedCatalog.items === this._items) {
              sharedCatalog.folderStats.set(this._mode, this._folderStats);
            }
          }
          Logger.info('AssetsTab.onActivate:updateFolderFilter', { tab: this.id });
          this._updateFolderFilter();
          this.app?.updateFolderFilterSelection?.(this.id, this._activeFolderSelection);
        } catch (error) {
          Logger.warn('AssetsTab.onActivate:deferredOps:folderFailed', { tab: this.id, error });
        }

        Logger.info('AssetsTab.onActivate:deferredSearch:start', { tab: this.id });
        this.applySearchAsync(this.getCurrentSearchValue()).then(() => {
          Logger.info('AssetsTab.onActivate:deferredSearch:complete', { tab: this.id });
        }).catch((error) => {
          Logger.warn('AssetsTab.onActivate:deferredSearch:failed', { tab: this.id, error });
        });
        Logger.info('AssetsTab.onActivate:deferredOps:complete', { tab: this.id });
      }, 0);
    }

    // Listen for ESC-based placement cancel to clear selection
    if (!this.isTexturesMode) {
      try {
        if (!this._placementCancelHandler) {
          this._placementCancelHandler = () => {
            try { this._selection.clearSelection(); } catch (_) {}
            try { this._refreshSelectionUIInView(); } catch (_) {}
            Logger.info('AssetsTab.selection.cleared', { reason: 'placement-cancel' });
            this._updateDropShadowControl();
          };
        }
        this.app?.element?.addEventListener?.('fa-nexus:placement-cancelled', this._placementCancelHandler);
      } catch (_) {}
    }

    try {
      if (!this._dropShadowUpdateHandler) {
        this._dropShadowUpdateHandler = () => { this._updateDropShadowControl(); };
      }
      this.app?.element?.addEventListener?.('fa-nexus:drop-shadow-updated', this._dropShadowUpdateHandler);
    } catch (_) {}

    if (this.supportsFolderBrowser()) {
      try { this._updateFolderFilter(); } catch (_) {}
      try { this.app?.updateFolderFilterSelection?.(this.id, this._activeFolderSelection); } catch (_) {}
    }
    this._updateDropShadowControl();
  }

  /** Cleanup listeners and transient UI when leaving the tab */
  onDeactivate() {
    if (this._deferredActivationTimeout) {
      try { clearTimeout(this._deferredActivationTimeout); } catch (_) {}
      this._deferredActivationTimeout = null;
    }
    this._cancelInFlight('deactivate');
    if (this.isTexturesMode) {
      try { this.texturePaintManager?.stop?.(); } catch (_) {}
    } else if (this.isPathsMode) {
      try { this.pathManager?.stop?.(); } catch (_) {}
    } else {
      // Cancel any active placement when leaving assets tab
      try { this.placementManager?.cancelPlacement?.('tab-switch'); } catch (_) {}
      try {
        if (this._placementCancelHandler) {
          this.app?.element?.removeEventListener?.('fa-nexus:placement-cancelled', this._placementCancelHandler);
        }
      } catch (_) {}
    }
    try {
      if (this._dropShadowUpdateHandler) {
        this.app?.element?.removeEventListener?.('fa-nexus:drop-shadow-updated', this._dropShadowUpdateHandler);
      }
    } catch (_) {}
    try {
      if (this._boundSettingsChange) {
        Hooks.off('updateSetting', this._boundSettingsChange);
        this._boundSettingsChange = null;
      }
    } catch (_) {}
    try { this._uninstallProbeScrollHandler(); } catch (_) {}
    super.onDeactivate();
  }

  filterItems(items, query) {
    let filtered = super.filterItems(items, query);
    if (!Array.isArray(filtered)) filtered = [];

    try {
      const hideLocked = game.settings.get('fa-nexus', 'hideLocked');
      if (hideLocked) {
        let authed = false;
        try {
          const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
          authed = !!(auth && auth.authenticated && auth.state);
        } catch (_) {}

        const download = this.downloadManager;
        filtered = filtered.filter((asset) => {
          if (!asset) return false;
          const source = String(asset.source || '').toLowerCase();
          const isPremium = String(asset.tier || '').toLowerCase() === 'premium';
          if (source !== 'cloud' || !isPremium) return true;
          if (authed) return true;

          // Treat downloaded assets as unlocked even if user lacks premium auth.
          if (asset.cachedLocalPath || asset.cached || asset.isCached) return true;
          try {
            const localPath = download?.getLocalPath?.('assets', asset);
            if (localPath) {
              asset.cachedLocalPath = asset.cachedLocalPath || localPath;
              return true;
            }
          } catch (_) {}
          return false;
        });
      }
    } catch (_) {}

    filtered = filtered.filter((asset) => this._matchesMode(asset));

    if (this.supportsFolderBrowser()) {
      const selection = this._activeFolderSelection || { type: 'all', includePaths: [], includePathLowers: [] };
      if (selection.type === 'folder') {
        const target = String(selection.pathLower || selection.path || '').toLowerCase();
        if (target) {
          filtered = filtered.filter((asset) => {
            const folderPath = this._getNormalizedFolderPath(asset);
            if (!folderPath) return false;
            if (folderPath === target) return true;
            return folderPath.startsWith(`${target}/`);
          });
        }
      } else if (selection.type === 'folders') {
        const lowers = Array.isArray(selection.pathLowers) ? selection.pathLowers : [];
        const normalized = lowers.length ? lowers : (Array.isArray(selection.paths) ? selection.paths.map((p) => this._normalizeFolderPath(p)) : []);
        const targets = Array.from(new Set(normalized.filter(Boolean).map((p) => String(p).toLowerCase())));
        if (targets.length) {
          filtered = filtered.filter((asset) => {
            const folderPath = this._getNormalizedFolderPath(asset);
            if (!folderPath) return false;
            for (const target of targets) {
              if (folderPath === target || folderPath.startsWith(`${target}/`)) return true;
            }
            return false;
          });
        } else {
          filtered = [];
        }
      } else if (selection.type === 'unassigned') {
        filtered = filtered.filter((asset) => !this._getNormalizedFolderPath(asset));
      }

      const excludeTargets = new Set();
      if (Array.isArray(selection.excludePathLowers)) {
        for (const lower of selection.excludePathLowers) {
          const key = String(lower || '').toLowerCase();
          if (key) excludeTargets.add(key);
        }
      }
      if (!excludeTargets.size && Array.isArray(selection.excludePaths)) {
        for (const path of selection.excludePaths) {
          const lower = this._normalizeFolderPath(path)?.toLowerCase();
          if (lower) excludeTargets.add(lower);
        }
      }

      if (excludeTargets.size) {
        filtered = filtered.filter((asset) => {
          const folderPath = this._getNormalizedFolderPath(asset);
          if (!folderPath) return true;
          for (const target of excludeTargets) {
            if (folderPath === target || folderPath.startsWith(`${target}/`)) return false;
          }
          return true;
        });
      }
    }

    return filtered;
  }

  _isCloudEnabled() {
    return this._controller.isCloudEnabled();
  }

  destroy() {
    try { this._controller?.dispose?.(); } catch (_) {}
    if (super.destroy) super.destroy();
  }

  /** Bind footer controls (hide main-color toggle; add assets folder button) */
  bindFooter() {
    try {
      const appEl = this.app.element;
      if (!appEl) return;
      const cb = appEl.querySelector('#fa-nexus-maincolor-only');
      const wrap = cb?.closest?.('.fa-nexus-footer-control') || cb?.parentElement;
      if (wrap) wrap.style.display = 'none';
      // Remove token-specific folder button if present
      const tokenBtn = appEl.querySelector('.fa-nexus-footer .actions .fa-nexus-open-folder');
      if (tokenBtn) tokenBtn.remove();
      const hideLockCb = appEl.querySelector('#fa-nexus-hide-locked');
      if (hideLockCb) {
        let authed = false;
        try {
          const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
          authed = !!(auth && auth.authenticated && auth.state);
        } catch (_) {}
        const hideWrap = hideLockCb.closest?.('.fa-nexus-footer-control') || hideLockCb.parentElement;
        if (hideWrap) hideWrap.style.display = authed ? 'none' : '';
        if (!authed) {
          hideLockCb.checked = !!game.settings.get('fa-nexus', 'hideLocked');
          hideLockCb.addEventListener('change', async () => {
            try {
              await game.settings.set('fa-nexus', 'hideLocked', !!hideLockCb.checked);
              await this.applySearchAsync(this.getCurrentSearchValue());
            } catch (_) {}
          });
        }
      }
      // Add assets folder button
      const actions = appEl.querySelector('.fa-nexus-footer .actions');
      if (actions && !actions.querySelector('.fa-nexus-open-asset-folder')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fa-nexus-icon-button fa-nexus-open-asset-folder';
        btn.title = 'Select Asset Sources';
        btn.innerHTML = '<i class="fas fa-folder-open"></i>';
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          try {
            const { FaNexusAssetsFolderSelectionDialog } = window.faNexus || {};
            if (FaNexusAssetsFolderSelectionDialog) { new FaNexusAssetsFolderSelectionDialog().render(true); return; }
          } catch (_) {}
          import('./assets-content-sources-dialog.js').then((m) => {
            new m.FaNexusAssetsFolderSelectionDialog().render(true);
          }).catch(() => {});
        });
        actions.appendChild(btn);
      }
      this._updateHideLockedVisibility();
      this._updateDropShadowControl();
    } catch (_) {}
  }

  /** Unbind footer controls and remove transient buttons */
  unbindFooter() {
    try {
      const appEl = this.app.element;
      const cb = appEl?.querySelector('#fa-nexus-maincolor-only');
      if (cb) {
        const clone = cb.cloneNode(true);
        cb.parentNode.replaceChild(clone, cb);
      }
      const hideLockCb = appEl?.querySelector('#fa-nexus-hide-locked');
      if (hideLockCb) {
        const clone = hideLockCb.cloneNode(true);
        hideLockCb.parentNode.replaceChild(clone, hideLockCb);
      }
      const assetBtn = appEl?.querySelector('.fa-nexus-footer .actions .fa-nexus-open-asset-folder');
      if (assetBtn) assetBtn.remove();
    } catch (_) {}
  }

  _updateHideLockedVisibility() {
    try {
      const appEl = this.app?.element;
      if (!appEl) return;
      const hideLockCb = appEl.querySelector('#fa-nexus-hide-locked');
      if (!hideLockCb) return;
      let authed = false;
      try {
        const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
        authed = !!(auth && auth.authenticated && auth.state);
      } catch (_) {}
      const wrap = hideLockCb.closest?.('.fa-nexus-footer-control') || hideLockCb.parentElement;
      if (wrap) wrap.style.display = authed ? 'none' : '';
      if (!authed) {
        hideLockCb.checked = !!game.settings.get('fa-nexus', 'hideLocked');
      }
    } catch (_) {}
  }

  _updateDropShadowControl() {
    try {
      this.placementManager?.refreshToolOptions?.();
    } catch (_) {}
  }

  onThumbSizeChange() { /* handled via slider binding */ }

  /** Return stats for footer display */
  getStats() {
    const app = this.app;
    // Filter items to only count those relevant to the current tab mode
    const allItems = this._items || [];
    const relevantItems = allItems.filter(item => this._matchesMode(item));
    const total = relevantItems.length;
    const shown = (app._grid && Array.isArray(app._grid.items)) ? app._grid.items.length : 0;
    return { shown, total };
  }

  /** Load cached assets, stream remaining folders, and update grid */
  async loadAssets(options = {}) {
    return this._controller.loadAssets(options);
  }

  async _loadAssetsInternal(options = {}) {
    return this._controller.loadAssetsInternal(options);
  }

  async _loadAndMergeCloud(includeLocal, options = {}) {
    return this._controller.loadAndMergeCloud(includeLocal, options);
  }

  /** Load cloud assets list safely (logs and returns [] on failure) */
  async _loadCloudAssetsSafe(onProgress, signal) {
    return this._controller.loadCloudAssetsSafe(onProgress, signal);
  }

  _createAssetCard(it) {
    return this._cards.createCard(it);
  }

  _mountAssetCard(cardElement, it) {
    return this._cards.mountCard(cardElement, it);
  }

  _unmountAssetCard(cardElement) {
    this._cards.unmountCard(cardElement);
  }

  _handleAssetCardClick(ev, cardElement, it) {
    return this._cards.handleAssetCardClick(ev, cardElement, it);
  }

  async _beginAssetPlacement(cardElement, it, isStickyMode = true, pointerEvent = null) {
    const folderPath = cardElement.getAttribute('data-path') || '';
    const filePathAttr = cardElement.getAttribute('data-file-path') || this._resolveFilePath(it);
    const filename = cardElement.getAttribute('data-filename') || '';
    const isCloud = (cardElement.getAttribute('data-source') === 'cloud');
    const tier = cardElement.getAttribute('data-tier') || '';
    const dataUrlAttr = cardElement.getAttribute('data-url') || '';
    let cachedLocalPath = '';
    let dimensionsReady = false;

    try { await this._controller.ensureServices(); }
    catch (error) { Logger.warn('AssetsTab.place.ensure.failed', { error: String(error?.message || error) }); }
    const download = this.downloadManager;

    if (isCloud) {
      try {
        if (cardElement.getAttribute('data-cached') === 'true') {
          cachedLocalPath = cardElement.getAttribute('data-url') || '';
        }
      } catch (_) {}
      if (!cachedLocalPath && it?.cachedLocalPath) cachedLocalPath = it.cachedLocalPath;
      if (!cachedLocalPath) {
        try {
          cachedLocalPath = download?.getLocalPath?.('assets', { filename, file_path: filePathAttr, path: folderPath }) || '';
        } catch (_) { cachedLocalPath = ''; }
      }
      if (cachedLocalPath) {
        try { cardElement.setAttribute('data-url', cachedLocalPath); } catch (_) {}
        try { cardElement.setAttribute('data-cached', 'true'); } catch (_) {}
        it.cachedLocalPath = cachedLocalPath;
        const icon = cardElement.querySelector('.fa-nexus-status-icon');
        if (icon) {
          icon.classList.remove('cloud-plus', 'cloud', 'premium');
          icon.classList.add('cloud', 'cached');
          icon.title = 'Downloaded';
          icon.innerHTML = '<i class="fas fa-cloud-check"></i>';
        }
        dimensionsReady = await this._cards.ensureAccurateDimensions(it, cardElement);
      }
    } else {
      cachedLocalPath = dataUrlAttr || filePathAttr || folderPath;
      if (cachedLocalPath) {
        try { cardElement.setAttribute('data-url', cachedLocalPath); } catch (_) {}
      }
      dimensionsReady = await this._cards.ensureAccurateDimensions(it, cardElement);
    }

    if (!dimensionsReady && cachedLocalPath) {
      try { dimensionsReady = await this._cards.ensureAccurateDimensions(it, cardElement); } catch (_) {}
    }

    const gridWidthVal = Number(cardElement.getAttribute('data-grid-w') || it?.grid_width || 1) || 1;
    const gridHeightVal = Number(cardElement.getAttribute('data-grid-h') || it?.grid_height || 1) || 1;
    const widthPx = Number(cardElement.getAttribute('data-width') || it?.width || (gridWidthVal * 200)) || (gridWidthVal * 200);
    const heightPx = Number(cardElement.getAttribute('data-height') || it?.height || (gridHeightVal * 200)) || (gridHeightVal * 200);

    const assetData = {
      source: isCloud ? 'cloud' : (it?.source || 'local'),
      tier: tier || it?.tier || 'free',
      file_path: filePathAttr,
      folder_path: folderPath,
      cachedLocalPath,
      path: cachedLocalPath || filePathAttr || folderPath,
      filename,
      url: cachedLocalPath || '',
      grid_width: gridWidthVal,
      grid_height: gridHeightVal,
      width: widthPx,
      height: heightPx,
      actual_width: it?.actual_width || widthPx,
      actual_height: it?.actual_height || heightPx
    };
    try { this.placementManager?.startPlacement(assetData, isStickyMode, { pointerEvent }); } catch (_) {}
  }

  async _handleTextureCardClick(cardElement, item) {
    return this._cards.handleTextureCardClick(cardElement, item);
  }

  async _handlePathCardClick(cardElement, item) {
    return this._cards.handlePathCardClick(cardElement, item);
  }

  // ======== Multi-select helpers ========
  _computeItemKey(item) {
    return this._selection.computeItemKey(item);
  }

  _keyFromCard(cardElement) {
    return this._selection.keyFromCard(cardElement);
  }

  _indexOfVisibleKey(key, fallbackItem = null) {
    return this._selection.indexOfVisibleKey(key, fallbackItem);
  }

  _applyRangeSelection(from, to, mode = 'add') {
    this._selection.applyRangeSelection(from, to, mode);
  }

  _applyRangeSelectionExclusive(from, to) {
    this._selection.applyRangeSelectionExclusive(from, to);
  }

  _setCardSelectionUI(card, selected) {
    this._selection.setCardSelectionUI(card, selected);
  }

  _refreshSelectionUIInView() {
    this._selection.refreshSelectionUI();
  }

  async _startPlacementFromSelection() {
    if (this.isTexturesMode) return;
    try { await this._selection.startPlacementFromSelection(); }
    catch (_) {}
  }

  _updateCardGridBadge(cardElement, item = null) {
    this._cards.updateCardGridBadge(cardElement, item);
  }

  _resolveFilePath(item) {
    if (!item) return '';
    const direct = String(item.file_path || '');
    if (direct) return direct;
    const folder = this._resolveFolderPath(item);
    const filename = String(item.filename || '');
    if (folder && filename) return `${folder.replace(/\/$/, '')}/${filename}`;
    if (!folder && filename) return filename;
    return folder || '';
  }

  _resolveFolderPath(item) {
    return this._controller.resolveFolderPath(item);
  }

  _hasPremiumAuth() {
    try {
      const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
      return !!(auth && auth.authenticated && auth.state);
    } catch (_) {
      return false;
    }
  }

  _isAssetLocked(item, cardElement = null, { authed } = {}) {
    try {
      const el = cardElement || null;
      const hasAuth = typeof authed === 'boolean' ? authed : this._hasPremiumAuth();

      const cachedAttr = el?.getAttribute?.('data-cached') === 'true';
      if (cachedAttr) {
        try { el.removeAttribute('data-locked'); } catch (_) {}
        return false;
      }

      const itemCached = !!(item && (item.cachedLocalPath || item.cached || item.isCached));
      if (itemCached) {
        if (el) {
          try { el.removeAttribute('data-locked'); } catch (_) {}
        }
        return false;
      }

      const source = (el?.getAttribute?.('data-source') || item?.source || '').toLowerCase();
      if (source !== 'cloud') {
        if (el) {
          try { el.removeAttribute('data-locked'); } catch (_) {}
        }
        return false;
      }

      const tier = (el?.getAttribute?.('data-tier') || item?.tier || '').toLowerCase();
      if (tier !== 'premium') {
        if (el) {
          try { el.removeAttribute('data-locked'); } catch (_) {}
        }
        return false;
      }

      if (hasAuth) {
        if (el) {
          try { el.removeAttribute('data-locked'); } catch (_) {}
        }
        return false;
      }

      const download = this.downloadManager;
      if (download && item) {
        const filename = el?.getAttribute?.('data-filename') || item?.filename || '';
        const filePath = el?.getAttribute?.('data-file-path') || item?.file_path || this._resolveFilePath(item) || '';
        const folderPath = el?.getAttribute?.('data-path') || item?.path || this._resolveFolderPath(item) || '';
        try {
          const localPath = download.getLocalPath?.('assets', { filename, file_path: filePath, path: folderPath });
          if (localPath) {
            if (item && !item.cachedLocalPath) item.cachedLocalPath = localPath;
            if (el) {
              try { el.removeAttribute('data-locked'); } catch (_) {}
            }
            return false;
          }
        } catch (_) {}
      }

      if (el) {
        try { el.setAttribute('data-locked', 'true'); } catch (_) {}
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  _normalizeFolderPath(path) {
    return this._controller.normalizeFolderPath(path);
  }

  _getFolderPathInfo(item, hydrate = false) {
    return this._controller.getFolderPathInfo(item, hydrate);
  }

  _computeFolderStats(items) {
    return this._controller.computeFolderStats(items);
  }

  _getNormalizedFolderPath(item) {
    return this._controller.getNormalizedFolderPath(item);
  }


  _updateFolderFilter() {
    return this._controller.updateFolderFilter();
  }

  _isTextureItem(item) {
    if (!item) return false;
    const filePath = String(this._resolveFilePath(item) || '').toLowerCase();
    const folderPath = String(this._resolveFolderPath(item) || '').toLowerCase();
    if (/\/textures\//.test(filePath)) return true;
    if (/\/textures\//.test(folderPath)) return true;
    return false;
  }

  _looksLikePathsSegment(value) {
    if (!value) return false;
    const normalized = String(value).toLowerCase().replace(/\\/g, '/');
    return /(^|[\/\-_])paths?(?=[\/\-_]|$)/.test(normalized);
  }

  _isPathsItem(item) {
    if (!item) return false;
    const filename = String(item.filename || '').toLowerCase();
    if (filename.includes('path')) return true;
    const filePath = this._resolveFilePath(item);
    const folderPath = this._resolveFolderPath(item);
    if (this._looksLikePathsSegment(folderPath)) return true;
    if (this._looksLikePathsSegment(filePath)) return true;
    return false;
  }

  _matchesMode(item) {
    try { return this._controller?.matchesMode(item); }
    catch (_) { return false; }
  }

  _needsActualDimensions(item) {
    return this._cards.needsActualDimensions(item);
  }

  _hasLocalAssetFile(item) {
    return this._cards.hasLocalAssetFile(item);
  }

  async _ensureAccurateDimensions(item, cardElement) {
    return this._cards.ensureAccurateDimensions(item, cardElement);
  }

  // ======== Throttled image loading (assets grid) ========
  // ======== Deferred cache probing (after scroll settles) ========
  _installProbeScrollHandler() {
    const grid = this.getGridContainer();
    if (!grid) return;
    const onScroll = () => { this._scheduleProbeVisibleCards(); };
    grid.addEventListener('scroll', onScroll, { passive: true });
    this._probeScrollHandler = onScroll;
  }

  _uninstallProbeScrollHandler() {
    const grid = this.getGridContainer();
    if (!grid || !this._probeScrollHandler) return;
    try { grid.removeEventListener('scroll', this._probeScrollHandler); } catch (_) {}
    this._probeScrollHandler = null;
    this._probe.dispose();
  }

  _scheduleProbeVisibleCards() {
    this._probe.scheduleVisibleCards();
  }

  _runProbeVisibleCards() {
    const grid = this.getGridContainer(); if (!grid) return;
    const cards = grid.querySelectorAll('.fa-nexus-card[data-source="cloud"]:not([data-cached="true"])');
    const loader = this._probe.ensureLoader();
    loader.queue.clear();
    for (const c of cards) loader.queue.add(c);
    this._probe.runQueue();
  }

  _enqueueCacheProbe(cardElement, item) {
    this._probe.queueCard(cardElement, item);
  }
  _updateFooterStats() {
    try {
      const stats = this.app.element.querySelector('.fa-nexus-footer .stats');
      if (!stats) return;
      const { shown, total } = this.getStats();
      stats.textContent = `${shown} / ${total}`;
    } catch (_) {}
  }

  _bindThumbSizeSlider() {
    const app = this.app;
    const gridContainer = app.element.querySelector('#fa-nexus-grid');
    let sizeInput = app.element.querySelector('#fa-nexus-thumb-size');
    if (!sizeInput || !app._grid) return;
    // Replace node to drop previous listeners (from other tab)
    try { const parent = sizeInput.parentNode; const clone = sizeInput.cloneNode(true); parent.replaceChild(clone, sizeInput); sizeInput = clone; } catch (_) {}

    // Determine which setting key to use based on tab mode
    const settingKey = this.isTexturesMode ? 'thumbWidthTextures' : this.isPathsMode ? 'thumbWidthPaths' : 'thumbWidthAssets';

    // Assets slider range: 54–108
    sizeInput.min = '54'; sizeInput.max = '108'; sizeInput.step = String(Number(sizeInput.step || 2) || 2);
    const sanitize = (value) => Math.max(54, Math.min(108, Number(value) || 72));
    const savedWidth = Number(game.settings.get('fa-nexus', settingKey) || game.settings.get('fa-nexus', 'thumbWidth') || 0) || (app._grid.card?.width || 108);
    sizeInput.value = String(sanitize(savedWidth));

    let pendingWidth = sanitize(sizeInput.value);
    let rafId = null;

    const applyDims = (w) => {
      const clamped = sanitize(w);
      const t = Math.max(0, Math.min(1, (clamped - 54) / (108 - 54)));
      const h = clamped; // square cards for assets
      try { app._grid.setCardSize(clamped, h); } catch (_) {}
      if (gridContainer) {
        gridContainer.style.setProperty('--fa-nexus-card-pad', `${2 + (6 - 2) * t}px`);
        gridContainer.style.setProperty('--fa-nexus-title-size', `${0.68 + (0.78 - 0.68) * t}rem`);
        gridContainer.style.setProperty('--fa-nexus-details-size', `${0.58 + (0.68 - 0.58) * t}rem`);
        gridContainer.style.setProperty('--fa-nexus-footer-pt', `${0 + (4 - 0) * t}px`);
      }
      try { this.app?.updateGridPlaceholderSize?.({ tab: this.id, width: clamped, height: h, gap: this.getGridOptions?.()?.card?.gap ?? 4 }); } catch (_) {}
      try { this._updateFooterStats(); } catch (_) {}
    };

    const flushPending = () => {
      rafId = null;
      applyDims(pendingWidth);
    };

    const scheduleApply = (w) => {
      pendingWidth = sanitize(w);
      if (rafId) return;
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(flushPending);
      } else {
        flushPending();
      }
    };

    scheduleApply(sizeInput.value);

    const onInput = () => {
      const w = sanitize(sizeInput.value);
      scheduleApply(w);
    };

    const onChange = async () => {
      const w = sanitize(sizeInput.value);
      scheduleApply(w);
      try { await game.settings.set('fa-nexus', settingKey, w); } catch (_) {}
    };

    let dragging = false;
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      scheduleApply(sizeInput.value);
      this._endThumbSizeAdjust?.();
      window.removeEventListener('pointerup', endDrag, true);
      window.removeEventListener('pointercancel', endDrag, true);
    };

    sizeInput.addEventListener('pointerdown', () => {
      if (dragging) return;
      dragging = true;
      this._beginThumbSizeAdjust?.();
      window.addEventListener('pointerup', endDrag, true);
      window.addEventListener('pointercancel', endDrag, true);
    });

    sizeInput.addEventListener('input', onInput);
    sizeInput.addEventListener('change', onChange);
  }

  _beginThumbSizeAdjust() {
    super._beginThumbSizeAdjust();
    this._pendingProbeAfterThumbAdjust = true;
    this._probe.reset();
  }

  _endThumbSizeAdjust() {
    super._endThumbSizeAdjust();
    if (!this.isThumbSizeAdjustActive && this._pendingProbeAfterThumbAdjust) {
      this._pendingProbeAfterThumbAdjust = false;
      this._scheduleProbeVisibleCards();
    }
  }

  /**
   * Dedupe assets by filename (no extension), preferring:
   * 1) source: local > cloud(cached) > cloud
   * 2) extension: webp > png > jpg > others
   * 3) newest last_modified
   */
}
