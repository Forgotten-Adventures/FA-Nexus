import { GridBrowseTab } from '../core/ui/grid-browse-tab.js';
import { collectLocalInventory, getEnabledFolders, mergeLocalAndCloudRecords } from '../content/nexus-content-service.js';
import { TokenDataService } from './token-data-service.js';
import { TokenPreviewManager } from './token-preview-manager.js';
import { FaNexusTokensFolderSelectionDialog } from './tokens-content-sources-dialog.js';
import { TokenDragDropManager } from './token-dragdrop-manager.js';
import { TokenPlacementManager } from './token-placement-manager.js';
import { TokenSelectionHelper } from './token-selection-helper.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../core/forge-integration.js';
import {
  normalizeFolderSelection,
  enforceFolderSelectionAvailability,
  mergeFolderSelectionExcludes,
  folderSelectionKey,
  logFolderSelection
} from '../content/content-sources/content-sources-utils.js';
import { createEmptyFolderTreeIndex, createFolderTreeIndex } from '../content/folder-tree-index.js';

function getHostTheme() {
  const body = document.body;
  const isDark = body.classList.contains('theme-dark');
  return isDark ? 'dark' : 'light';
}
function applyThemeToElement(el) {
  if (!el) return;
  const theme = getHostTheme();
  el.classList.toggle('fa-theme-dark', theme === 'dark');
  el.classList.toggle('fa-theme-light', theme !== 'dark');
}

export class TokensTab extends GridBrowseTab {
  /**
   * Tokens browser tab: renders virtualized token grid, integrates search, drag-and-drop,
   * hover preview, color variant UI, and local/cloud merge of items.
   * @param {import('../nexus-app.js').FaNexusApp} app
   */
  constructor(app) {
    super(app);
    this._tokenData = new TokenDataService();
    this._dragDrop = null;
    this._boundSettingsChange = null;
    this._variantPanelEl = null;
    this._variantCleanup = null;
    this._activeVariantBase = null;
    this._boundContextMenu = null;
    this._variantThemeObserver = null;
    this._indexingLocks = 0;
    this._placement = new TokenPlacementManager(app);
    this._selection = new TokenSelectionHelper(this);
    // Deferred cache-state probing (run when scrolling stops)
    this._probeLoader = null;
    this._activeFolderSelection = { type: 'all', includePaths: [], includePathLowers: [] };
    this._folderStats = {
      pathCounts: [],
      lowerKeys: new Set(),
      unassignedCount: 0,
      tree: createEmptyFolderTreeIndex(),
      version: 0
    };
    this._deferredActivationTimeout = null;
  }

  get id() { return 'tokens'; }

  supportsFolderBrowser() { return true; }

  get asyncSearchThreshold() { return 40000; }

  getPlaceholderCardSize() {
    const base = super.getPlaceholderCardSize();
    const options = this.getGridOptions?.();
    const gap = Math.max(2, Math.round(options?.card?.gap ?? base.gap ?? 5));
    if (this.app?._grid?.card) {
      return {
        width: Math.round(this.app._grid.card.width),
        height: Math.round(this.app._grid.card.height),
        gap
      };
    }
    let width = base.width;
    try {
      const saved = Number(game.settings.get('fa-nexus', 'thumbWidthTokens') || game.settings.get('fa-nexus', 'thumbWidth') || 0);
      if (Number.isFinite(saved) && saved > 0) width = saved;
    } catch (_) {}
    width = Math.max(92, Math.min(160, width));
    const t = Math.max(0, Math.min(1, (width - 90) / (160 - 90)));
    const baseFooter = 29 + (40 - 29) * t;
    const height = Math.round((width / 140) * (180 - baseFooter)) + baseFooter;
    return { width: Math.round(width), height: Math.round(height), gap };
  }

  getActiveFolderSelection() {
    const normalized = normalizeFolderSelection(this._activeFolderSelection, {
      normalizePath: (value) => this._normalizeFolderPath(value),
      supportsUnassigned: true
    });
    logFolderSelection('TokensTab.selection.getActiveFolderSelection', normalized, { logger: Logger });
    return normalized;
  }

  onFolderSelectionChange(selection) {
    this._activeFolderSelection = normalizeFolderSelection(selection, {
      normalizePath: (value) => this._normalizeFolderPath(value),
      supportsUnassigned: true
    });
    logFolderSelection('TokensTab.selection.normalize', this._activeFolderSelection, { logger: Logger });
    try { this.app?.updateFolderFilterSelection?.(this.id, this._activeFolderSelection); } catch (_) {}
    this.applySearch(this.getCurrentSearchValue());
  }

  /**
   * VirtualGrid options for token cards
   * @returns {{rowHeight:number,overscan:number,card:{width:number,height:number,gap:number},createRow:function,onMountItem:function,onUnmountItem:function}}
   */
  getGridOptions() {
    const self = this;
    return {
      rowHeight: 40,
      overscan: 5,
      card: { width: 140, height: 180, gap: 5 },
      createRow: (item) => self._createTokenCard(item),
      onMountItem: (el, item) => self._mountTokenCard(el, item),
      onUnmountItem: (el) => self._unmountTokenCard(el)
    };
  }

  createPreviewManager() {
    return new TokenPreviewManager(this._tokenData, null);
  }

  onPreviewReady(preview) {
    this._tokenPreview = preview;
    this.app._tokenPreview = preview;
  }

  onHoverCardEnter(card) {
    try {
      if (TokenDragDropManager?.isHoverSuppressed?.()) return false;
    } catch (_) {}
    try { this._dragDrop?.preloadForCard?.(card); } catch (_) {}
    return true;
  }



  onInit() {
    // no-op for now
  }

  /**
   * Activate the tab: build grid, bind events, and load/merge token data
   * @returns {Promise<void>}
   */
  async onActivate() {
    const app = this.app;
    Logger.info('TokensTab.onActivate');
    const gridContainer = this.getGridContainer();
    if (gridContainer) {
      const currentGrid = this._dragDrop?.grid || null;
      if (!this._dragDrop || currentGrid !== gridContainer) {
        try { this._dragDrop?.destroy?.(); } catch (_) {}
        this._dragDrop = new TokenDragDropManager(gridContainer, this.app);
        this._dragDrop.initialize();
      }
    }

    if (!this._placement) {
      this._placement = new TokenPlacementManager(this.app);
    }

    await super.onActivate();
    try { this._installProbeScrollHandler(); } catch (_) {}

    this._installColorVariantContext();

    // Hook settings updates (once)
    if (!this._boundSettingsChange) {
      this._boundSettingsChange = async (setting) => {
        if (!setting || setting.namespace !== 'fa-nexus') return;
        // Allow folder/cloud settings to trigger reloads even for inactive tabs
        if (setting.key === 'tokenFolders' || setting.key === 'cloudTokensEnabled') {
          this.loadTokens();
        } else if (this.app?._activeTab !== 'tokens') {
          return;
        } else if (!app.rendered || !app.element || !app._grid) {
          return;
        } else if (setting.key === 'mainColorOnly') {
          await this.applySearchAsync(this.getCurrentSearchValue());
        } else if (setting.key === 'hideLocked') {
          await this.applySearchAsync(this.getCurrentSearchValue());
        } else if (setting.key === 'patreon_auth_data') {
          // Auth state changed - update hide-locked UI visibility and clear setting if authenticated
          this._updateHideLockedVisibility();
          // Clear hideLocked setting when user authenticates (authenticated users don't have locked tokens)
          try {
            const auth = setting.value;
            if (auth && auth.authenticated && auth.state) {
              game.settings.set('fa-nexus', 'hideLocked', false);
            }
          } catch (_) {}
        }
      };
      try { Hooks.on('updateSetting', this._boundSettingsChange); } catch (_) {}
    }

    if (!this._placementCancelHandler) {
      this._placementCancelHandler = () => {
        try { this._selection?.clearSelection?.(); } catch (_) {}
        try { this._refreshSelectionUIInView?.(); } catch (_) {}
      };
    }
    try { this.app?.element?.addEventListener?.('fa-nexus:placement-cancelled', this._placementCancelHandler); } catch (_) {}

    // Initial data
    if (!this._items || !this._items.length) {
      await this.loadTokens();
      try { this._updateFolderFilter(); } catch (_) {}
      try { this.app?.updateFolderFilterSelection?.(this.id, this._activeFolderSelection); } catch (_) {}
    } else {
      // Defer all heavy operations to avoid blocking tab switch completion
      Logger.info('TokensTab.onActivate:deferOperations', { tab: this.id });
      if (this._deferredActivationTimeout) {
        try { clearTimeout(this._deferredActivationTimeout); } catch (_) {}
      }
      this._deferredActivationTimeout = setTimeout(() => {
        this._deferredActivationTimeout = null;
        if (!this.app || this.app._activeTab !== this.id || !this.app._grid) {
          Logger.info('TokensTab.onActivate:deferredOps:skipped', { tab: this.id, activeTab: this.app?._activeTab });
          return;
        }
        Logger.info('TokensTab.onActivate:deferredOps:start', { tab: this.id });
        try {
          Logger.info('TokensTab.onActivate:computeFolderStats', { tab: this.id });
          this._computeFolderStats(Array.isArray(this._items) ? this._items : []);
          Logger.info('TokensTab.onActivate:updateFolderFilter', { tab: this.id });
          this._updateFolderFilter();
          this.app?.updateFolderFilterSelection?.(this.id, this._activeFolderSelection);
        } catch (error) {
          Logger.warn('TokensTab.onActivate:deferredOps:folderFailed', { tab: this.id, error });
        }

        Logger.info('TokensTab.onActivate:deferredSearch:start', { tab: this.id });
        this.applySearchAsync(this.getCurrentSearchValue()).then(() => {
          Logger.info('TokensTab.onActivate:deferredSearch:complete', { tab: this.id });
        }).catch((error) => {
          Logger.warn('TokensTab.onActivate:deferredSearch:failed', { tab: this.id, error });
        });
        Logger.info('TokensTab.onActivate:deferredOps:complete', { tab: this.id });
      }, 0);
    }
  }

  onDeactivate() {
    if (this._deferredActivationTimeout) {
      try { clearTimeout(this._deferredActivationTimeout); } catch (_) {}
      this._deferredActivationTimeout = null;
    }
    this._hideColorVariantsPanel();
    // Unhook settings handler when not active to avoid concurrent loads
    try {
      if (this._boundSettingsChange) {
        Hooks.off('updateSetting', this._boundSettingsChange);
        this._boundSettingsChange = null;
      }
    } catch (_) {}
    try { this.app?.setTabsLocked?.(false); } catch (_) {}
    try {
      if (this._placementCancelHandler) {
        this.app?.element?.removeEventListener?.('fa-nexus:placement-cancelled', this._placementCancelHandler);
      }
    } catch (_) {}
    try {
      const grid = this.getGridContainer();
      if (grid && this._boundContextMenu) {
        grid.removeEventListener('contextmenu', this._boundContextMenu);
        this._boundContextMenu = null;
      }
    } catch (_) {}
    try { this._dragDrop?.destroy?.(); } catch (_) {}
    this._dragDrop = null;
    try { this._placement?.cancelPlacement?.('tab-switch'); } catch (_) {}
    try { this._uninstallProbeScrollHandler(); } catch (_) {}
    try { this._resetProbeLoader(); } catch (_) {}
    try {
      this._selection?.clearSelection();
      this._selection?.refreshSelectionUI();
    } catch (_) {}
    super.onDeactivate();
  }

  _setIndexingLock(active, message = 'Indexing local tokens...') {
    if (active) {
      this._indexingLocks = Math.max(0, this._indexingLocks || 0) + 1;
      try { this.app?.setTabsLocked?.(true, message); } catch (_) {}
    } else {
      this._indexingLocks = Math.max(0, (this._indexingLocks || 0) - 1);
      if (this._indexingLocks === 0) {
        try { this.app?.setTabsLocked?.(false); } catch (_) {}
      }
    }
  }

  filterItems(items, query) {
    let filtered = super.filterItems(items, query);
    try {
      const mainOnly = game.settings.get('fa-nexus', 'mainColorOnly');
      if (mainOnly) {
        filtered = filtered.filter((it) => !it.has_color_variant || it.is_main_color_variant || (String(it.color_variant || '') === '01'));
      }
    } catch (_) {}

    try {
      const hideLocked = game.settings.get('fa-nexus', 'hideLocked');
      if (hideLocked) {
        let authed = false;
        try {
          const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
          authed = !!(auth && auth.authenticated && auth.state);
        } catch (_) {}

        filtered = filtered.filter((token) => {
          const isLockedToken = token.source === 'cloud' && token.tier === 'premium' && !authed;
          if (!isLockedToken) return true;
          try {
            if (token.filename && this.app?._downloadManager) {
              const localPath = this.app._downloadManager.getLocalPath('tokens', { filename: token.filename });
              return !!localPath;
            }
          } catch (_) {}
          return false;
        });
      }
    } catch (_) {}

    const selection = this._activeFolderSelection || { type: 'all', includePaths: [], includePathLowers: [] };
    if (selection.type === 'folder') {
      const target = String(selection.pathLower || selection.path || '').toLowerCase();
      if (target) {
        filtered = filtered.filter((token) => {
          const folderPath = this._getNormalizedFolderPath(token);
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
        filtered = filtered.filter((token) => {
          const folderPath = this._getNormalizedFolderPath(token);
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
      filtered = filtered.filter((token) => !this._getNormalizedFolderPath(token));
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
      filtered = filtered.filter((token) => {
        const folderPath = this._getNormalizedFolderPath(token);
        if (!folderPath) return true;
        for (const target of excludeTargets) {
          if (folderPath === target || folderPath.startsWith(`${target}/`)) return false;
        }
        return true;
      });
    }

    return filtered;
  }

  beforeApplySearch(_query) {
    try { Logger.time('TokensTab.grid.setData'); } catch (_) {}
  }

  afterApplySearch(filtered, query) {
    try { Logger.timeEnd('TokensTab.grid.setData'); } catch (_) {}
    super.afterApplySearch(filtered, query);
    try { this._selection?.resetVisibleItems(filtered); } catch (_) {}
    try { this._selection?.refreshSelectionUI(); } catch (_) {}
    try { this._scheduleProbeVisibleCards(); } catch (_) {}
  }

  /** Bind footer controls for tokens (main color toggle, folder selection button) */
  bindFooter() {
    const app = this.app;
    try {
      const mainColorCb = app.element.querySelector('#fa-nexus-maincolor-only');
      const randomWrap = app.element.querySelector('.fa-nexus-randomcolor-toggle');
      const randomCb = app.element.querySelector('#fa-nexus-random-color-placement');

      const syncRandomToggleUI = () => {
        if (!randomWrap || !randomCb) return;
        randomWrap.style.display = '';
        const mainEnabled = !!game.settings.get('fa-nexus', 'mainColorOnly');
        const randomEnabled = mainEnabled && this._isRandomColorPlacementEnabled();
        randomCb.checked = randomEnabled;
        randomCb.disabled = !mainEnabled;
      };

      if (mainColorCb) {
        // Ensure visible for tokens tab
        try {
          const wrap = mainColorCb.closest?.('.fa-nexus-footer-control') || mainColorCb.parentElement;
          if (wrap) wrap.style.display = '';
        } catch (_) {}
        mainColorCb.checked = !!game.settings.get('fa-nexus', 'mainColorOnly');
        syncRandomToggleUI();
        mainColorCb.addEventListener('change', async () => {
          const next = !!mainColorCb.checked;
          try {
            await game.settings.set('fa-nexus', 'mainColorOnly', next);
            this.applySearch(this.getCurrentSearchValue());
          } catch (_) {}
          if (!next) {
            try { await this._setRandomColorPlacement(false, { forceUpdate: true }); }
            catch (error) { Logger.warn('TokensTab.randomPlacement.disable.failed', { error: String(error?.message || error) }); }
          } else {
            if (this._isRandomColorPlacementEnabled()) {
              try { await this._setRandomColorPlacement(true, { updateSetting: false, forceUpdate: true }); }
              catch (error) { Logger.warn('TokensTab.randomPlacement.enable-sync.failed', { error: String(error?.message || error) }); }
            }
          }
          syncRandomToggleUI();
        });
      } else {
        syncRandomToggleUI();
      }

      if (randomWrap) randomWrap.style.display = '';
      if (randomCb) {
        randomCb.addEventListener('change', async () => {
          const mainEnabled = !!game.settings.get('fa-nexus', 'mainColorOnly');
          if (!mainEnabled) {
            randomCb.checked = false;
            randomCb.disabled = true;
            return;
          }
          try {
            await this._setRandomColorPlacement(!!randomCb.checked, { forceUpdate: true });
          } catch (error) {
            Logger.warn('TokensTab.randomPlacement.toggle.failed', { error: String(error?.message || error) });
          } finally {
            syncRandomToggleUI();
          }
        });
      }

      // Hide locked checkbox (only show for unauthenticated users)
      const hideLockCb = app.element.querySelector('#fa-nexus-hide-locked');
      if (hideLockCb) {
        let authed = false;
        try {
          const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
          authed = !!(auth && auth.authenticated && auth.state);
        } catch (_) {}

        // Show/hide based on auth status
        const wrap = hideLockCb.closest?.('.fa-nexus-footer-control') || hideLockCb.parentElement;
        if (wrap) wrap.style.display = authed ? 'none' : '';

        if (!authed) {
          hideLockCb.checked = !!game.settings.get('fa-nexus', 'hideLocked');
          hideLockCb.addEventListener('change', async () => {
            try {
              await game.settings.set('fa-nexus', 'hideLocked', !!hideLockCb.checked);
              this.applySearch(this.getCurrentSearchValue());
            } catch (_) {}
          });
        }
      }

      const actions = app.element.querySelector('.fa-nexus-footer .actions');
      if (actions && !actions.querySelector('.fa-nexus-open-folder')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fa-nexus-icon-button fa-nexus-open-folder';
        btn.title = 'Select Token Sources';
        btn.innerHTML = '<i class="fas fa-folder-open"></i>';
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          const d = new FaNexusTokensFolderSelectionDialog();
          d.render(true);
        });
        actions.appendChild(btn);
      }
    } catch (_) {}
  }

  /** Unbind footer controls and remove transient buttons */
  unbindFooter() {
    const app = this.app;
    try {
      const cb = app.element.querySelector('#fa-nexus-maincolor-only');
      if (cb) {
        const clone = cb.cloneNode(true);
        cb.parentNode.replaceChild(clone, cb);
      }

      const hideLockCb = app.element.querySelector('#fa-nexus-hide-locked');
      if (hideLockCb) {
        const clone = hideLockCb.cloneNode(true);
        hideLockCb.parentNode.replaceChild(clone, hideLockCb);
      }

      const randomCb = app.element.querySelector('#fa-nexus-random-color-placement');
      if (randomCb) {
        const clone = randomCb.cloneNode(true);
        randomCb.parentNode.replaceChild(clone, randomCb);
      }
      const randomWrap = app.element.querySelector('.fa-nexus-randomcolor-toggle');
      if (randomWrap) randomWrap.style.display = 'none';

      const btn = app.element.querySelector('.fa-nexus-footer .actions .fa-nexus-open-folder');
      if (btn) btn.remove();
    } catch (_) {}
  }

  /**
   * Return stats for footer display
   * @returns {{shown:number,total:number}}
   */
  getStats() {
    const app = this.app;
    const total = (this._items || []).length;
    const shown = (app._grid && Array.isArray(app._grid.items)) ? app._grid.items.length : 0;
    return { shown, total };
  }

  /**
   * Load local cached indexes, stream additional folders if needed, and merge with cloud items
   * Applies search and updates the grid incrementally with a loader UI.
   */
  async loadTokens() {
    const app = this.app;
    Logger.info('TokensTab.loadTokens:start');
    if (!app.rendered || !app.element || !app._grid) return;
    const loadId = (++this._loadId);
    const isCancelled = () => (loadId !== this._loadId) || !app.rendered || !app.element || !app._grid;

    const folders = getEnabledFolders('tokenFolders');
    Logger.info('TokensTab.loadTokens:folders', { count: folders.length, folders });

    const showGridLoader = (message) => {
      try { this.app?.showGridLoader?.(message, { owner: this.id }); } catch (_) {}
    };
    const hideGridLoader = () => {
      try { this.app?.hideGridLoader?.(this.id); } catch (_) {}
    };
    const updateGridLoader = (message) => {
      try { this.app?.updateGridLoader?.(message, { owner: this.id }); } catch (_) {}
    };

    // Decide cloud loader message based on whether a cached cloud index exists
    const cloudLoaderMessage = async () => {
      try {
        const svc = this.app?._contentService;
        if (!svc) return 'Loading cloud tokens…';
        const latest = await svc.getLatest('tokens');
        return latest ? 'Loading cloud tokens…' : 'Indexing cloud tokens…';
      } catch (_) { return 'Loading cloud tokens…'; }
    };

    const cloudEnabled = this._isCloudEnabled();
    const getCloudIndexingState = async () => {
      try {
        const svc = this.app?._contentService;
        if (!svc) return { indexing: false, label: 'Loading cloud tokens…' };
        if (typeof svc.getMeta === 'function') {
          const meta = await svc.getMeta('tokens');
          const hasIndex = !!meta?.latest;
          return { indexing: !hasIndex, label: hasIndex ? 'Loading cloud tokens…' : 'Indexing cloud tokens…' };
        }
        const latest = await svc.getLatest?.('tokens');
        return { indexing: !latest, label: latest ? 'Loading cloud tokens…' : 'Indexing cloud tokens…' };
      } catch (_) { return { indexing: false, label: 'Loading cloud tokens…' }; }
    };
    const withCloudLock = async (fn) => {
      let locked = false; let label = 'Indexing cloud tokens…';
      try {
        const st = await getCloudIndexingState();
        if (st?.indexing) { this._setIndexingLock(true, st.label || label); locked = true; }
      } catch (_) {}
      try { return await fn(); } finally { if (locked) this._setIndexingLock(false); }
    };

    if (!folders.length) {
      // No local folders: show cloud only. Clear current locals immediately and show a loader.
      this._items = [];
      this._computeFolderStats(this._items);
      try { app._grid.setData([]); } catch (_) {}
      if (cloudEnabled) {
        showGridLoader(await cloudLoaderMessage());
        await withCloudLock(async () => {
          await this._loadAndMergeCloud(false, async (collected) => {
            hideGridLoader();
            this._items = collected;
            this._computeFolderStats(this._items);
            await this.applySearchAsync(this.getCurrentSearchValue());
            if (this.app?._activeTab === this.id) {
              try { this._updateFolderFilter(); } catch (_) {}
            }
          });
        });
      } else {
        hideGridLoader();
        this._computeFolderStats(this._items);
        await this.applySearchAsync(this.getCurrentSearchValue());
        if (this.app?._activeTab === this.id) {
          try { this._updateFolderFilter(); } catch (_) {}
        }
      }
      return;
    }

    let localLockActive = false;
    const localResult = await collectLocalInventory({
      loggerTag: 'TokensTab.local',
      folders,
      loadCached: (folder) => this._tokenData.loadCachedTokens(folder),
      saveIndex: (folder, records) => this._tokenData.saveTokensIndex(folder, records),
      streamFolder: (folder, onBatch, options) => this._tokenData.streamLocalTokens(folder, onBatch, options),
      streamOptions: { batchSize: 1500, sleepMs: 8 },
      isCancelled,
      keySelector: (rec) => String(rec?.file_path || rec?.path || rec?.url || ''),
      onCachedReady: (cachedItems) => {
        if (isCancelled()) return;
        this._items = cachedItems;
        if (cachedItems.length) {
        showGridLoader(`Loading tokens… (cached ${cachedItems.length})`);
          Logger.info('TokensTab.cache.ready', { cached: cachedItems.length });
        } else {
          showGridLoader('Indexing local tokens… 0');
        }
      },
      onStreamProgress: (count) => {
        if (isCancelled()) return;
        updateGridLoader(`Indexing local tokens… ${count}`);
        if (!localLockActive) { this._setIndexingLock(true, 'Indexing local tokens...'); localLockActive = true; }
      }
    });

    if (localResult.cancelled) { hideGridLoader(); if (localLockActive) this._setIndexingLock(false); return; }

    this._items = localResult.localItems;
    this._computeFolderStats(this._items);
    Logger.info('TokensTab.local.complete', { cached: localResult.cachedItems.length, streamed: localResult.streamedCount });

    if (localLockActive) this._setIndexingLock(false);

    if (cloudEnabled) {
      showGridLoader(await cloudLoaderMessage());
      await withCloudLock(async () => {
          await this._loadAndMergeCloud(true, async (merged) => {
            hideGridLoader();
            this._items = merged;
            this._computeFolderStats(this._items);
            await this.applySearchAsync(this.getCurrentSearchValue());
            Logger.info('TokensTab.streaming:done', { total: this._items.length, streamed: localResult.streamedCount });
          if (this.app?._activeTab === this.id) {
            try { this._updateFolderFilter(); } catch (_) {}
          }
        });
      });
    } else {
      hideGridLoader();
      this._computeFolderStats(this._items);
      await this.applySearchAsync(this.getCurrentSearchValue());
      if (this.app?._activeTab === this.id) {
        try { this._updateFolderFilter(); } catch (_) {}
      }
    }
  }

  async _loadAndMergeCloud(includeLocal, applyFn) {
    const app = this.app;
    const collectedLocal = includeLocal ? (Array.isArray(this._items) ? this._items.slice() : []) : [];
    if (!this._isCloudEnabled()) {
      try { await applyFn?.(collectedLocal); } catch (_) {}
      return;
    }
    let cloudItems = [];
    try {
      const svc = app?._contentService;
      if (svc) {
        try { Logger.info('TokensTab.cloud.sync:start'); 
          await svc.sync('tokens'); 
          Logger.info('TokensTab.cloud.sync:done'); 
        } catch (e) { Logger.warn('TokensTab.cloud.sync:error', String(e?.message||e)); }
        const { items, total } = await svc.list('tokens');
        cloudItems = Array.isArray(items) ? items : [];
        Logger.info('TokensTab.cloud.list', { count: cloudItems.length, total });
      }
    } catch (e) { Logger.warn('TokensTab.cloud.load.error', String(e?.message||e)); }

    const svc = this.app?._contentService;
    const merged = mergeLocalAndCloudRecords({
      kind: 'tokens',
      local: collectedLocal,
      cloud: cloudItems,
      keySelector: (rec) => {
        const base = String(rec?.base_name_no_variant || '').toLowerCase();
        const color = String(rec?.color_variant ?? '').toLowerCase();
        if (base && color) return `${base}_${color}`;
        return String(rec?.filename || rec?.file_path || '').replace(/\.[^/.]+$/, '').toLowerCase();
      },
      choosePreferred: (existing, incoming) => {
        const rank = (it) => {
          if (!it) return 0;
          if (String(it.source || '').toLowerCase() === 'local') return 3;
          if (String(it.source || '').toLowerCase() === 'cloud' && it.cachedLocalPath) return 2;
          return 1;
        };
        const extRank = (name) => {
          const lower = String(name || '').toLowerCase();
          if (lower.endsWith('.webp')) return 3;
          if (lower.endsWith('.png')) return 2;
          if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 1;
          return 0;
        };
        const rExisting = rank(existing);
        const rIncoming = rank(incoming);
        if (rIncoming > rExisting) return incoming;
        if (rIncoming < rExisting) return existing;
        const eExisting = extRank(existing?.filename);
        const eIncoming = extRank(incoming?.filename);
        if (eIncoming > eExisting) return incoming;
        if (eIncoming < eExisting) return existing;
        const lmExisting = Date.parse(existing?.last_modified || '') || 0;
        const lmIncoming = Date.parse(incoming?.last_modified || '') || 0;
        return lmIncoming >= lmExisting ? incoming : existing;
      },
      onEnhanceLocal: ({ localRecord, cloudRecord }) => {
        if (!svc || !cloudRecord?.filename) return null;
        try {
          const thumb = svc.getThumbnailURL?.('tokens', cloudRecord);
          if (!thumb) return null;
          if (String(localRecord.thumbnail_url || localRecord.file_path || '').includes(thumb)) return null;
          return {
            ...localRecord,
            original_thumbnail: localRecord.file_path || localRecord.thumbnail_url,
            thumbnail_url: thumb,
            enhanced_thumbnail: true,
            cloud_tier: cloudRecord.tier
          };
        } catch (_) { return null; }
      },
      onStats: ({ collisions, preferLocal, preferCloud, enhanced, localCount, cloudCount, mergedCount }) => {
        try {
          Logger.info('TokensTab.merge', { collisions, preferLocal, preferCloud, enhanced, local: localCount, cloud: cloudCount, merged: mergedCount });
        } catch (_) {}
      }
    });

    try { await applyFn?.(merged); } catch (_) {}
  }

  _normalizeFolderPath(path) {
    if (!path && path !== '') return '';
    const raw = String(path || '');
    return raw
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .trim();
  }

  _getFolderPathInfo(item, hydrate = false) {
    if (!item || typeof item !== 'object') return { normalized: '', lower: '' };
    if (!hydrate && typeof item._faFolderLower === 'string') {
      return {
        normalized: item._faFolderNormalized || '',
        lower: item._faFolderLower
      };
    }
    let folder = this._normalizeFolderPath(item?.path);
    if (!folder) {
      const filePath = this._normalizeFolderPath(item?.file_path);
      if (filePath) {
        const idx = filePath.lastIndexOf('/');
        folder = idx >= 0 ? filePath.slice(0, idx) : '';
        folder = this._normalizeFolderPath(folder);
      }
    }
    const lower = folder ? folder.toLowerCase() : '';
    item._faFolderNormalized = folder;
    item._faFolderLower = lower;
    return { normalized: folder, lower };
  }

  _getNormalizedFolderPath(item) {
    return this._getFolderPathInfo(item).lower;
  }

  _computeFolderStats(items) {
    const pathCountsMap = new Map();
    const lowerKeys = new Set();
    let unassignedCount = 0;
    for (const item of items) {
      const info = this._getFolderPathInfo(item, true);
      if (info.lower) {
        pathCountsMap.set(info.normalized, (pathCountsMap.get(info.normalized) || 0) + 1);
        lowerKeys.add(info.lower);
      } else {
        unassignedCount += 1;
      }
    }
    const pathCounts = pathCountsMap.size ? Array.from(pathCountsMap.entries()) : [];
    const version = (this._folderStats?.version || 0) + 1;
    const tree = createFolderTreeIndex(pathCountsMap, { version });
    this._folderStats = { pathCounts, lowerKeys, unassignedCount, tree, version };
    return this._folderStats;
  }


  _updateFolderFilter() {
    const app = this.app;
    const stats = this._folderStats || {
      pathCounts: [],
      lowerKeys: new Set(),
      unassignedCount: 0,
      tree: createEmptyFolderTreeIndex(),
      version: 0
    };
    const lowerKeys = stats.lowerKeys instanceof Set ? stats.lowerKeys : new Set(stats.lowerKeys || []);
    const availableLowers = lowerKeys.size ? lowerKeys : null;
    const supportsUnassigned = (Number(stats.unassignedCount) || 0) > 0;
    const baseVersion = Number.isFinite(stats.version) ? Number(stats.version) : 0;
    const tree = (stats.tree && typeof stats.tree === 'object')
      ? stats.tree
      : createFolderTreeIndex(stats.pathCounts || [], { version: baseVersion });
    if (tree && tree.version == null) tree.version = baseVersion;

    const prevSelection = normalizeFolderSelection(this._activeFolderSelection, {
      normalizePath: (value) => this._normalizeFolderPath(value),
      supportsUnassigned: true
    });
    const constrainedSelection = enforceFolderSelectionAvailability(prevSelection, {
      availableLowers,
      supportsUnassigned,
      normalizePath: (value) => this._normalizeFolderPath(value)
    });
    const nextSelection = mergeFolderSelectionExcludes({
      selection: constrainedSelection,
      previousSelection: prevSelection,
      normalizePath: (value) => this._normalizeFolderPath(value),
      availableLowers
    }) || { type: 'all', includePaths: [], includePathLowers: [] };

    this._activeFolderSelection = nextSelection;
    const prevKey = folderSelectionKey(prevSelection);
    const currentKey = folderSelectionKey(nextSelection);

    logFolderSelection('TokensTab.selection.updateFolderFilter.final', nextSelection, { logger: Logger });
    try {
      app?.setFolderFilterData?.(this.id, {
        label: 'Token Folders',
        allLabel: 'All Tokens',
        unassignedLabel: 'Unsorted',
        pathCounts: stats.pathCounts,
        tree,
        totalCount: tree.totalCount,
        unassignedCount: stats.unassignedCount,
        selection: nextSelection,
        version: baseVersion
      });
    } catch (_) {}
    const selectionChanged = currentKey !== prevKey;
    if (selectionChanged) {
      try { app?.updateFolderFilterSelection?.(this.id, nextSelection); } catch (_) {}
      if (app?._activeTab === this.id) {
        this.applySearchAsync(this.getCurrentSearchValue());
      }
    }
  }


  _isCloudEnabled() {
    try { return !!game.settings.get('fa-nexus', 'cloudTokensEnabled'); }
    catch (_) { return true; }
  }

  _createTokenCard(item) {
    const cardElement = document.createElement('div');
    try {
      if (this.app.constructor.CARD_TEMPLATE && typeof this.app.constructor.CARD_TEMPLATE === 'function') {
        cardElement.innerHTML = this.app.constructor.CARD_TEMPLATE({});
      } else {
        cardElement.innerHTML = `
          <div class=\"thumb fa-nexus-thumb-placeholder\">
            <img alt=\"\" />
            <div class=\"fa-nexus-status-icon\" title=\"\"></div>
            <div class=\"fa-nexus-variant-tag\"></div>
          </div>
          <div class=\"card-footer\">
            <div class=\"label token-title\"></div>
            <div class=\"token-details\">
              <span class=\"token-size\"></span>
              <span class=\"token-scale\"></span>
              <span class=\"token-creature-type\"></span>
            </div>
          </div>`;
      }
    } catch (_) {}
    if (item && typeof item === 'object') {
      const filename = item.filename || '';
      const folderPath = item.path || '';
      let filePath = item.file_path || '';
      if (!filePath && folderPath && filename) {
        const trimmed = String(folderPath).replace(/\/+$/, '');
        filePath = trimmed ? `${trimmed}/${filename}` : filename;
      }
      if (filename) cardElement.setAttribute('data-filename', filename);
      if (filePath) {
        cardElement.setAttribute('data-file-path', filePath);
        cardElement.setAttribute('data-url', filePath);
      } else if (item.file_path) {
        cardElement.setAttribute('data-url', item.file_path);
      }
      if (folderPath) cardElement.setAttribute('data-path', folderPath);
      if (item.grid_width != null) cardElement.setAttribute('data-grid-w', String(item.grid_width));
      if (item.grid_height != null) cardElement.setAttribute('data-grid-h', String(item.grid_height));
      if (item.width != null) cardElement.setAttribute('data-width', String(item.width));
      if (item.height != null) cardElement.setAttribute('data-height', String(item.height));
      if (item.scale != null) cardElement.setAttribute('data-scale', String(item.scale));
      if (item.file_size != null) cardElement.setAttribute('data-file-size', String(item.file_size));
      if (item.size) cardElement.setAttribute('data-size', item.size);
      if (item.creature_type) cardElement.setAttribute('data-ctype', item.creature_type);
      if (item.variant) cardElement.setAttribute('data-variant', item.variant);
      if (item.source) cardElement.setAttribute('data-source', item.source);
      if (item.tier) cardElement.setAttribute('data-tier', item.tier);
      if (item.display_name) cardElement.setAttribute('data-display-name', item.display_name);
      try {
        const key = this._computeItemKey?.(item);
        if (key) cardElement.setAttribute('data-key', key);
      } catch (_) {}
      // Unified queued drag: disable native drag for all cards
      try { cardElement.setAttribute('draggable', 'false'); } catch (_) {}
    }
    return cardElement;
  }

  _mountTokenCard(cardElement, item) {
    try {
      const img = cardElement.querySelector('img');
      const label = cardElement.querySelector('.label');
      const sizeEl = cardElement.querySelector('.token-size');
      const scaleEl = cardElement.querySelector('.token-scale');
      const ctypeEl = cardElement.querySelector('.token-creature-type');
      const statusIcon = cardElement.querySelector('.fa-nexus-status-icon');
      const variantTag = cardElement.querySelector('.fa-nexus-variant-tag');
      if (label) label.textContent = item.display_name || '';
      if (sizeEl) sizeEl.textContent = item.size || '';
      if (scaleEl) {
        const s = Number(item.scale);
        const show = Number.isFinite(s) ? (s !== 1) : (item.scale && item.scale !== '1x');
        if (show) {
          // Display with trailing 'x' to match local tokens, e.g., 1.5x
          scaleEl.textContent = Number.isFinite(s) ? `${s}x` : String(item.scale);
          scaleEl.style.display = 'inline';
        } else {
          scaleEl.textContent = '';
          scaleEl.style.display = 'none';
        }
      }
      if (ctypeEl) ctypeEl.textContent = item.creature_type || '';
      if (statusIcon) {
        statusIcon.classList.remove('local','cloud','premium','cached', 'cloud-plus');
        let icon = 'fa-cloud';
        let title = 'Cloud';
        const isLocal = String(item.source || '').toLowerCase() === 'local';
        const isCloud = String(item.source || '').toLowerCase() === 'cloud';
        const isPremium = item.tier === 'premium';
        let authed = false;
        try { const auth = game.settings.get('fa-nexus', 'patreon_auth_data'); authed = !!(auth && auth.authenticated && auth.state); } catch (_) {}
        if (isLocal) {
          statusIcon.classList.add('local'); icon = 'fa-folder'; title = 'Local storage';
        } else if (isCloud) {
          // Premium shows lock only if unauthenticated; otherwise unlocked cloud
          if (isPremium && !authed) { 
            cardElement.classList.add('locked-token');
            statusIcon.classList.add('premium'); 
            icon = 'fa-lock'; 
            title = 'Premium (locked)'; }
          else { statusIcon.classList.add( isPremium ? 'cloud-plus' : 'cloud'); icon = isPremium ? 'fa-cloud-plus' : 'fa-cloud'; title = isPremium ? 'Premium (unlocked)' : 'Cloud'; }
        }
        statusIcon.title = title;
        statusIcon.innerHTML = `<i class=\"fas ${icon}\"></i>`;
      }
      if (variantTag) {
        const v = item.variant || '';
        variantTag.textContent = v;
        variantTag.style.display = v ? 'inline-flex' : 'none';
      }
      // If this is a cloud token, check if it has already been downloaded and cached
      try {
        if (String(item.source||'') === 'cloud' && item.filename) {
          const dl = this.app?._downloadManager;
          if (dl && typeof dl.getLocalPath === 'function') {
            const localPath = dl.getLocalPath('tokens', { filename: item.filename });
            if (localPath) {
              try { cardElement.setAttribute('data-url', localPath); } catch (_) {}
              try { cardElement.setAttribute('data-cached', 'true'); } catch (_) {}
              // Do not enable native drag; queued drag handles all sources
              cardElement._resolvedLocalPath = localPath;
              // Update status icon to indicate cached/local
              if (statusIcon) {
                cardElement.classList.remove('locked-token');
                statusIcon.classList.remove('cloud-plus', 'cloud', 'premium');
                statusIcon.classList.add('cloud','cached');
                statusIcon.title = 'Downloaded';
                statusIcon.innerHTML = '<i class=\"fas fa-cloud-check\"></i>';
              }
            } else {
              // Not present in quick inventory: enqueue a deferred probe to avoid spamming during fast scroll
              try { this._enqueueCacheProbe(cardElement, item); } catch (_) {}
            }
          }
        }
      } catch (_) {}

      if (img) {
        const thumb = cardElement.querySelector('.thumb');
        try { thumb?.classList?.add('fa-nexus-thumb-placeholder'); } catch (_) {}
        let src = item.file_path || cardElement.getAttribute('data-url') || cardElement.getAttribute('data-file-path') || '';
        try {
          if (String(item.source||'') === 'cloud') {
            const svc = this.app?._contentService;
            if (svc) src = svc.getThumbnailURL('tokens', item);
          } else if (item.enhanced_thumbnail && item.thumbnail_url) {
            // Use enhanced cloud thumbnail for local tokens when available
            src = item.thumbnail_url;
          }
        } catch (_) {}
        // Throttled image loading (same approach as Assets)
        this._queueImageLoad(cardElement, img, src, () => {
          try { thumb?.classList?.remove('fa-nexus-thumb-placeholder'); } catch(_) {}
        }, () => {
          try { thumb?.classList?.add('fa-nexus-thumb-placeholder'); } catch(_) {}
        });
      }
    } catch (_) {}
    try {
      const onClick = async (event) => {
        if (event.button !== 0) return;
        if (!cardElement.isConnected) return;
        const hoverSuppressed = TokenDragDropManager?.isHoverSuppressed?.();
        if (hoverSuppressed && !this._placement?.isPlacementActive) return;
        const interactive = event.target?.closest?.('button, a, .fa-nexus-card-action');
        if (interactive) return;
        event.preventDefault();
        event.stopPropagation();
        const helper = this._selection;
        const ctrl = !!(event.ctrlKey || event.metaKey);
        const shift = !!event.shiftKey;
        const key = helper ? helper.keyFromCard(cardElement) : '';
        const visibleIndex = helper ? helper.indexOfVisibleKey(key, item) : -1;
        const authed = this._hasPremiumAuth();
        const randomColorEnabled = this._isRandomColorPlacementEnabled();
        if (this._isTokenLocked(item, cardElement, { authed })) {
          ui.notifications?.error?.('Authentication required for premium tokens. Please connect Patreon.');
          try { helper?.selectedKeys?.delete?.(key); } catch (_) {}
          if (helper) helper.lastClickedIndex = -1;
          try { this._refreshSelectionUIInView(); } catch (_) {}
          return;
        }

        if (ctrl || shift) {
          try {
            if (shift) {
              const last = (helper && Number.isInteger(helper.lastClickedIndex) && helper.lastClickedIndex >= 0)
                ? helper.lastClickedIndex
                : visibleIndex;
              if (ctrl) this._applyRangeSelection(last, visibleIndex, 'add');
              else this._applyRangeSelectionExclusive(last, visibleIndex);
            } else if (ctrl) {
              if (helper?.selectedKeys?.has?.(key)) helper.selectedKeys.delete(key);
              else helper?.selectedKeys?.add?.(key);
            }
            if (helper) helper.lastClickedIndex = visibleIndex;
            this._refreshSelectionUIInView();
          } catch (_) {}
          try { await this._startPlacementFromSelection({ pointerEvent: event }); } catch (_) {}
          return;
        }

        try {
          helper?.clearSelection();
          if (key) helper?.selectedKeys?.add?.(key);
          if (helper) helper.lastClickedIndex = visibleIndex;
          this._refreshSelectionUIInView();
        } catch (_) {}

          if (randomColorEnabled) {
            try {
              const entries = helper?.preparePlacementEntries?.({
                expandColorVariants: true,
                resolveVariants: (entryInfo) => this._resolveRandomColorVariants(entryInfo)
              }) || [];
              if (entries.length) {
                await this._placement?.startPlacementFromEntries?.(entries, {
                  sticky: shift,
                  pointerEvent: event,
                  forceRandom: true
                });
                return;
              }
            } catch (error) {
              Logger.warn('TokensTab.place.randomColor.failed', { error: String(error?.message || error) });
            }
          }

          try {
            await this._placement?.startPlacementFromCard?.(cardElement, { sticky: shift, pointerEvent: event });
          } catch (error) {
          Logger.warn('TokensTab.place.card.failed', { error: String(error?.message || error) });
        }
      };
      cardElement.addEventListener('click', onClick);
      cardElement._faNexusTokenPlacementClick = onClick;
    } catch (_) {}
    try { this._dragDrop?.enableForCard?.(cardElement);
     } catch (_) {}
  }

  _unmountTokenCard(cardElement) {
    try { const img = cardElement.querySelector('img'); if (img) { this._cancelImageLoad?.(cardElement); img.onload = img.onerror = null; img.src = ''; } } catch(_) {}
    try { if (cardElement?._probeJob) { cardElement._probeJob.cancelled = true; delete cardElement._probeJob; } } catch (_) {}
    if (cardElement?._faNexusTokenPlacementClick) {
      try { cardElement.removeEventListener('click', cardElement._faNexusTokenPlacementClick); } catch (_) {}
      delete cardElement._faNexusTokenPlacementClick;
    }
  }

  // ======== Multi-select helpers ========
  _computeItemKey(item) {
    return this._selection?.computeItemKey?.(item) || '';
  }

  _keyFromCard(cardElement) {
    return this._selection?.keyFromCard?.(cardElement) || '';
  }

  _indexOfVisibleKey(key, fallbackItem = null) {
    return this._selection?.indexOfVisibleKey?.(key, fallbackItem) ?? -1;
  }

  _applyRangeSelection(from, to, mode = 'add') {
    this._selection?.applyRangeSelection?.(from, to, mode);
  }

  _applyRangeSelectionExclusive(from, to) {
    this._selection?.applyRangeSelectionExclusive?.(from, to);
  }

  _refreshSelectionUIInView() {
    this._selection?.refreshSelectionUI?.();
  }

  async _startPlacementFromSelection({ pointerEvent = null } = {}) {
    try {
      const randomColor = this._isRandomColorPlacementEnabled();
      const entries = this._selection?.preparePlacementEntries?.({
        expandColorVariants: randomColor,
        resolveVariants: randomColor ? (entry) => this._resolveRandomColorVariants(entry) : null
      }) || [];
      if (!entries.length) return;
      await this._placement?.startPlacementFromEntries?.(entries, {
        sticky: true,
        pointerEvent,
        forceRandom: randomColor
      });
    } catch (error) {
      Logger.warn('TokensTab.place.selection.failed', { error: String(error?.message || error) });
    }
  }

  _hasPremiumAuth() {
    try {
      const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
      return !!(auth && auth.authenticated && auth.state);
    } catch (_) {
      return false;
    }
  }

  _isRandomColorPlacementEnabled() {
    try {
      return !!game.settings.get('fa-nexus', 'tokenRandomColorPlacement');
    } catch (_) {
      return false;
    }
  }

  async _setRandomColorPlacement(enabled, { updateSetting = true, forceUpdate = false } = {}) {
    const next = !!enabled;
    let stored = this._isRandomColorPlacementEnabled();
    const settingChanged = stored !== next;
    if (updateSetting && settingChanged) {
      try {
        await game.settings.set('fa-nexus', 'tokenRandomColorPlacement', next);
        stored = next;
      } catch (error) {
        Logger.warn('TokensTab.randomPlacement.setting.failed', { error: String(error?.message || error) });
      }
    }

    const shouldUpdatePlacement = !!(this._placement?.isPlacementActive) && (forceUpdate || settingChanged);
    if (!shouldUpdatePlacement) return stored;

    const entries = this._selection?.preparePlacementEntries?.({
      expandColorVariants: next,
      resolveVariants: next ? (entry) => this._resolveRandomColorVariants(entry) : null
    }) || [];

    if (!entries.length) {
      if (!next) {
        try { this._placement?.cancelPlacement?.('restart'); }
        catch (error) { Logger.warn('TokensTab.randomPlacement.cancel.failed', { error: String(error?.message || error) }); }
      }
      return stored;
    }

    try {
      const forceRandom = !!(next && entries.length > 1);
      await this._placement?.updatePlacementEntries?.(entries, { forceRandom });
    } catch (error) {
      Logger.warn('TokensTab.randomPlacement.update.failed', { error: String(error?.message || error) });
    }
    return stored;
  }

  _extractVariantBase(filename) {
    if (!filename) return '';
    const noExt = String(filename).replace(/\.[^/.]+$/, '');
    const match = noExt.match(/^(.+)_\d+$/);
    return match ? match[1] : noExt;
  }

  _resolveRandomColorVariants(entry) {
    const baseItem = entry?.source_item || entry?.item || entry;
    if (!baseItem) return [];
    const baseName = baseItem.base_name_no_variant || this._extractVariantBase(baseItem.filename || '');
    if (!baseName) return [];
    const items = Array.isArray(this._items) ? this._items : [];
    return items.filter((candidate) => {
      if (!candidate) return false;
      const candidateName = candidate.base_name_no_variant || this._extractVariantBase(candidate.filename || '');
      if (candidateName !== baseName) return false;
      if (String(candidate.filename || '') === String(baseItem.filename || '')) return false;
      return true;
    });
  }

  _buildEntriesFromItems(items, { primaryCard = null } = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];
    const helper = this._selection;
    const authed = this._hasPremiumAuth();
    const entries = [];
    const seen = new Set();
    const downloadManager = this.app?._downloadManager || null;
    const computeKey = (item) => {
      if (helper?.computeItemKey) return helper.computeItemKey(item);
      const filePath = String(item?.file_path || item?.path || '');
      if (filePath) return filePath.toLowerCase();
      const filename = String(item?.filename || '');
      if (filename) return filename.toLowerCase();
      return '';
    };
    for (let index = 0; index < list.length; index++) {
      const record = list[index];
      if (!record) continue;
      const key = computeKey(record);
      if (!key || seen.has(key)) continue;
      const card = (index === 0 && primaryCard) ? primaryCard : null;
      if (this._isTokenLocked(record, card, { authed })) continue;
      let cachedLocalPath = record.cachedLocalPath || '';
      if (!cachedLocalPath && downloadManager && record.filename) {
        try {
          const local = downloadManager.getLocalPath('tokens', { filename: record.filename });
          if (local) cachedLocalPath = local;
        } catch (_) {}
      }
      const entry = {
        source: record.source || 'local',
        tier: record.tier || 'free',
        filename: record.filename || '',
        file_path: record.file_path || '',
        path: record.path || '',
        cachedLocalPath,
        display_name: record.display_name || '',
        grid_width: Number(record.grid_width || 1) || 1,
        grid_height: Number(record.grid_height || 1) || 1,
        scale: Number(record.scale || 1) || 1,
        color_variant: record.color_variant || null,
        base_name_no_variant: record.base_name_no_variant || '',
        has_color_variant: !!record.has_color_variant,
        variant_group: record.base_name_no_variant || record.display_name || '',
        thumbnail_url: record.thumbnail_url || '',
        source_item: record,
        card
      };
      entries.push(entry);
      seen.add(key);
    }
    return entries;
  }

  _isTokenLocked(item, cardElement = null, { authed = null } = {}) {
    try {
      const isCloud = String(item?.source || '').toLowerCase() === 'cloud';
      const tier = String(item?.tier || '').toLowerCase();
      const isPremium = tier === 'premium';
      if (!isCloud || !isPremium) return false;
      const effectiveAuthed = authed != null ? !!authed : this._hasPremiumAuth();
      if (effectiveAuthed) return false;

      const cachedAttr = cardElement?.getAttribute?.('data-cached') === 'true';
      const hasLocalPath = !!(item?.cachedLocalPath);
      if (cachedAttr || hasLocalPath) return false;

      try {
        const dl = this.app?._downloadManager;
        if (dl && item?.filename) {
          const local = dl.getLocalPath('tokens', { filename: item.filename });
          if (local) {
            item.cachedLocalPath = local;
            return false;
          }
        }
      } catch (_) {}

      return true;
    } catch (_) {
      return false;
    }
  }

  // ======== Deferred cache probing (after scroll settles) ========
  _ensureProbeLoader() {
    if (forgeIntegration.isRunningOnForge()) return;
    if (this._probeLoader) return;
    this._probeLoader = { idleDelay: 120, timer: null, queue: new Set(), running: false };
  }

  _resetProbeLoader() {
    const L = this._probeLoader; if (!L) return;
    try { if (L.timer) { clearTimeout(L.timer); L.timer = null; } } catch (_) {}
    try { L.queue.clear(); } catch (_) {}
    this._probeLoader = null;
  }

  _installProbeScrollHandler() {
    const grid = this.getGridContainer(); if (!grid) return;
    const onScroll = () => { this._scheduleProbeVisibleCards(); };
    grid.addEventListener('scroll', onScroll, { passive: true });
    this._probeScrollHandler = onScroll;
  }

  _uninstallProbeScrollHandler() {
    const grid = this.getGridContainer(); if (!grid || !this._probeScrollHandler) return;
    try { grid.removeEventListener('scroll', this._probeScrollHandler); } catch (_) {}
    this._probeScrollHandler = null;
  }

  _scheduleProbeVisibleCards() {
    if (forgeIntegration.isRunningOnForge()) return;
    this._ensureProbeLoader(); const L = this._probeLoader; if (!L) return;
    try { if (L.timer) { clearTimeout(L.timer); } } catch (_) {}
    L.timer = setTimeout(() => { this._runProbeVisibleCards(); }, L.idleDelay);
  }

  _runProbeVisibleCards() {
    if (forgeIntegration.isRunningOnForge()) return;
    const L = this._probeLoader; if (!L) return;
    try { if (L.timer) { clearTimeout(L.timer); L.timer = null; } } catch (_) {}
    const grid = this.getGridContainer(); if (!grid) return;
    const cards = grid.querySelectorAll('.fa-nexus-card[data-source="cloud"]:not([data-cached="true"])');
    L.queue.clear();
    for (const c of cards) L.queue.add(c);
    this._drainProbeQueue();
  }

  _enqueueCacheProbe(cardElement, item) {
    if (forgeIntegration.isRunningOnForge()) return;
    this._ensureProbeLoader(); const L = this._probeLoader; if (!L) return;
    L.queue.add(cardElement);
    cardElement._probeJob = { cancelled: false, item };
    this._scheduleProbeVisibleCards();
  }

  _drainProbeQueue() {
    const L = this._probeLoader; if (!L || L.running) return;
    const next = L.queue.values().next();
    if (next.done) return;
    const card = next.value; L.queue.delete(card); L.running = true;
    try {
      const item = card._assetItem || null;
      const dl = this.app?._downloadManager;
      const filename = card.getAttribute('data-filename') || item?.filename || '';
      const filePathAttr = card.getAttribute('data-file-path') || card.getAttribute('data-url') || '';
      const folderPathAttr = card.getAttribute('data-path') || '';
      if (!dl || typeof dl.probeLocal !== 'function' || !filename) { L.running = false; this._drainProbeQueue(); return; }
      const job = card._probeJob || { cancelled: false, item };
      card._probeJob = job;
      dl.probeLocal('tokens', { filename, file_path: filePathAttr, path: folderPathAttr }).then((found) => {
        if (job.cancelled || !found || !card.isConnected) return;
        try { card.setAttribute('data-url', found); } catch (_) {}
        try { card.setAttribute('data-cached', 'true'); } catch (_) {}
        const statusIcon = card.querySelector('.fa-nexus-status-icon');
        if (statusIcon) { card.classList.remove('locked-token'); statusIcon.classList.remove('cloud-plus','cloud','premium'); statusIcon.classList.add('cloud','cached'); statusIcon.title = 'Downloaded'; statusIcon.innerHTML = '<i class=\"fas fa-cloud-check\"></i>'; }
      }).catch(() => {}).finally(() => { L.running = false; this._drainProbeQueue(); });
    } catch (_) { L.running = false; this._drainProbeQueue(); }
  }

  _installColorVariantContext() {
    const grid = this.app.element.querySelector('#fa-nexus-grid');
    if (!grid) return;
    const onContext = (event) => {
      try { if (!game.settings.get('fa-nexus', 'mainColorOnly')) return; } catch (_) {}
      const card = event.target.closest('.fa-nexus-card');
      if (!card || !grid.contains(card)) return;
      event.preventDefault();
      event.stopPropagation();
      const filename = card.getAttribute('data-filename') || '';
      if (!filename) return;
      const all = Array.isArray(this._items) ? this._items : [];
      const base = (filename.replace(/\.[^/.]+$/, '').match(/^(.+)_\d+$/) || [null, filename.replace(/\.[^/.]+$/, '')])[1];
      if (this._activeVariantBase && this._activeVariantBase === base) { this._hideColorVariantsPanel(); return; }
      const variants = all.filter(it => {
        const noExt = String(it.filename || '').replace(/\.[^/.]+$/, '');
        const m = noExt.match(/^(.+)_\d+$/);
        return m && m[1] === base;
      });
      if (!variants.length || variants.length === 1) return;
      
      // Sort variants by their variant number to ensure proper order (01, 02, 03, etc.)
      variants.sort((a, b) => {
        const aNoExt = String(a.filename || '').replace(/\.[^/.]+$/, '');
        const bNoExt = String(b.filename || '').replace(/\.[^/.]+$/, '');
        const aMatch = aNoExt.match(/^(.+)_(\d+)$/);
        const bMatch = bNoExt.match(/^(.+)_(\d+)$/);
        if (!aMatch || !bMatch) return 0;
        const aNum = parseInt(aMatch[2], 10) || 0;
        const bNum = parseInt(bMatch[2], 10) || 0;
        return aNum - bNum;
      });
      
      this._showColorVariantsPanel(card, base, variants);
    };
    if (this._boundContextMenu) try { grid.removeEventListener('contextmenu', this._boundContextMenu); } catch (_) {}
    grid.addEventListener('contextmenu', onContext);
    this._boundContextMenu = onContext;
    // Expose hide method for drag manager compatibility
    this.app._hideColorVariantsPanel = () => { try { this._hideColorVariantsPanel(); } catch (_) {} };
  }

  _hideColorVariantsPanel() {
    if (this._variantPanelEl) { try { this._variantPanelEl.remove(); } catch (_) {} this._variantPanelEl = null; }
    if (this._variantCleanup) { try { this._variantCleanup(); } catch (_) {} this._variantCleanup = null; }
    try { this._variantThemeObserver?.disconnect?.(); } catch (_) {}
    this._variantThemeObserver = null;
    this._activeVariantBase = null;
  }

  _notifyPremiumTokenLocked(context = 'color-variant', details = null) {
    try { ui.notifications?.error?.('Authentication required for premium tokens. Please connect Patreon.'); } catch (_) {}
    try {
      const payload = details && typeof details === 'object' ? { context, ...details } : { context };
      Logger.info('TokensTab.premium.locked', payload);
    } catch (_) {}
  }

  _showColorVariantsPanel(anchorCard, baseName, variants) {
    this._hideColorVariantsPanel();
    try { this._tokenPreview?.hidePreview?.(); } catch (_) {}
    const panel = document.createElement('div');
    panel.className = 'fa-nexus-color-variants-panel  application';
    try { applyThemeToElement(panel); } catch (_) {}
    try {
      this._variantThemeObserver = new MutationObserver(() => {
        try { applyThemeToElement(panel); } catch (_) {}
      });
      this._variantThemeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch (_) {}
    panel.innerHTML = `
      <div class=\"fa-nexus-variant-header\">
        <span class=\"fa-nexus-variant-title\">${baseName}</span>
        <button class=\"fa-nexus-variant-close\" title=\"Close\">×</button>
      </div>
      <div class=\"fa-nexus-variant-grid\"></div>`;
    const grid = panel.querySelector('.fa-nexus-variant-grid');
    for (const it of variants) {
      const item = document.createElement('div');
      item.className = 'fa-nexus-variant-item';
      item._variantRecord = it;
      item.setAttribute('data-filename', it.filename || '');
      item.setAttribute('data-path', it.path || '');
      item.setAttribute('data-url', it.file_path || '');
      item.setAttribute('data-source', it.source || 'local');
      item.setAttribute('data-file-size', it.file_size || '');
      if (it.display_name) item.setAttribute('data-display-name', it.display_name);
      if (it.width != null) item.setAttribute('data-width', String(it.width));
      if (it.height != null) item.setAttribute('data-height', String(it.height));
      if (it.tier) item.setAttribute('data-tier', it.tier);
      if (it.grid_width != null) item.setAttribute('data-grid-w', String(it.grid_width));
      if (it.grid_height != null) item.setAttribute('data-grid-h', String(it.grid_height));
      if (it.scale != null) item.setAttribute('data-scale', String(it.scale));

      // Resolve auth and cached state for correct status icon
      let authed = false; let cachedLocalPath = '';
      try { const auth = game.settings.get('fa-nexus', 'patreon_auth_data'); authed = !!(auth && auth.authenticated && auth.state); } catch (_) {}
      try { if (String(it.source||'') === 'cloud' && it.filename) { const dl = this.app?._downloadManager; if (dl) cachedLocalPath = dl.getLocalPath('tokens', { filename: it.filename }) || ''; } } catch (_) {}
      Logger.info('TokensTab._showColorVariantsPanel', { cachedLocalPath });
      if (cachedLocalPath) { try { item.setAttribute('data-url', cachedLocalPath); } catch(_) {} try { item.setAttribute('data-cached', 'true'); } catch(_) {} }
      const isLocal = String(it.source||'').toLowerCase() === 'local';
      const isCloud = String(it.source||'').toLowerCase() === 'cloud';
      const isPremium = it.tier === 'premium';
      const iconHTML = (() => {
        if (isLocal) return '<i class="fas fa-folder"></i>';
        if (isCloud) {
          if (cachedLocalPath) return '<i class="fas fa-cloud-check"></i>';
          if (isPremium && !authed) return '<i class="fas fa-lock"></i>';
          if (isPremium) return '<i class="fas fa-cloud-plus"></i>';
          return '<i class="fas fa-cloud"></i>';
        }
        return '<i class="fas fa-cloud"></i>';
      })();
      const cv = (it.color_variant || '').toString().padStart(2,'0');
      item.innerHTML = `
        <div class="thumb"><img alt="${it.filename || ''}"/></div>
        <div class="fa-nexus-variant-number">${cv}</div>
        <div class="fa-nexus-token-status-icon" title="${isLocal ? 'Local storage' : (isPremium ? (authed || cachedLocalPath ? 'Premium (unlocked)' : 'Premium (locked)') : (cachedLocalPath ? 'Downloaded' : 'Cloud'))}">${iconHTML}</div>`;
      try {
        const iconEl = item.querySelector('.fa-nexus-token-status-icon');
        if (iconEl) {
          iconEl.classList.remove('local','cloud','premium','cached', 'cloud-plus');
          if (isLocal) iconEl.classList.add('local');
          else if (isCloud) {
            if (isPremium && !(authed || cachedLocalPath)) {
              iconEl.classList.add('premium');
              item.classList.add('locked-token');
            }
            if (isPremium) iconEl.classList.add('cloud-plus');
            else iconEl.classList.add('cloud');
            if (cachedLocalPath) {
              iconEl.classList.remove('cloud-plus', 'cloud', 'premium');
              iconEl.classList.add('cloud','cached');
            }
          }
        }
      } catch(_) {}

      const isVariantLocked = () => {
        try {
          const sourceAttr = (item.getAttribute('data-source') || '').toLowerCase();
          if (sourceAttr !== 'cloud') return false;
          const tierAttr = (item.getAttribute('data-tier') || '').toLowerCase();
          if (tierAttr !== 'premium') return false;
          if (item.getAttribute('data-cached') === 'true') return false;
          let authedNow = false;
          try {
            const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
            authedNow = !!(auth && auth.authenticated && auth.state);
          } catch (_) {}
          return !authedNow;
        } catch (_) {
          return false;
        }
      };

      const reportLockedVariant = (context) => {
        const now = Date.now();
        const last = Number(item._faLockWarned || 0);
        if (!Number.isFinite(last) || (now - last) > 600) {
          this._notifyPremiumTokenLocked('color-variant', {
            context,
            base: baseName,
            filename: it?.filename || '',
            variant: it?.color_variant || ''
          });
        }
        item._faLockWarned = now;
      };

      const ensureVariantUnlocked = (context) => {
        if (!isVariantLocked()) return true;
        reportLockedVariant(context);
        return false;
      };

      // Set thumbnail for cloud via CDN/signed, enhanced thumbnails for local, else local path
      try {
        const imgEl = item.querySelector('img');
        if (imgEl) {
          if (String(it.source||'') === 'cloud') {
            const svc = this.app?._contentService;
            if (svc) imgEl.src = svc.getThumbnailURL('tokens', it);
          }
          else if (it.enhanced_thumbnail && it.thumbnail_url) {
            // Use enhanced cloud thumbnail for local tokens when available
            imgEl.src = it.thumbnail_url;
          }
          else {
            imgEl.src = it.file_path || '';
          }
        }
      } catch (_) {}

      // Hover preview (skip for locked premium cloud variants that are not cached)
      item.addEventListener('mouseover', () => {
        try {
          Logger.info('TokensTab._showColorVariantsPanel-Mouseover', { isHoverSuppressed: TokenDragDropManager?.isHoverSuppressed?.(), item });
          try { if (TokenDragDropManager?.isHoverSuppressed?.()) return; } catch (_) {}
          const source = item.getAttribute('data-source') || '';
          const tier = item.getAttribute('data-tier') || '';
          let authed = false; try { const auth = game.settings.get('fa-nexus', 'patreon_auth_data'); authed = !!(auth && auth.authenticated && auth.state); } catch(_) {}
          const hasLocal = !!item.getAttribute('data-url');
          if (source === 'cloud' && tier === 'premium' && !authed && !hasLocal) return;
          const img = item.querySelector('img'); this._tokenPreview?.showPreviewWithDelay?.(img, item, 300);
        } catch (_) {}
      });
      item.addEventListener('mouseout', (event) => { try { const to = event.relatedTarget; if (to && item.contains(to)) return; this._tokenPreview?.hidePreview?.(); } catch (_) {} });

      // Unified queued drag: disable native drag and use mousedown-based flow
      try { item.setAttribute('draggable', 'false'); } catch(_) {}
      item.addEventListener('mousedown', async (ev) => {
        Logger.info('TokensTab._showColorVariantsPanel-Mousedown', { ev });
        if (ev.button !== 0) return;
        const source = item.getAttribute('data-source') || '';
        const tier = item.getAttribute('data-tier') || '';
        let authed = false; try { const auth = game.settings.get('fa-nexus', 'patreon_auth_data'); authed = !!(auth && auth.authenticated && auth.state); } catch(_) {}
        const cachedFlag = item.getAttribute('data-cached') === 'true';
        Logger.info('TokensTab._showColorVariantsPanel', { tier, authed, cachedLocalPath, cachedFlag });
        if (!ensureVariantUnlocked('variant-mousedown')) return;
        if (source === 'cloud') {
          try {
            await this._dragDrop?._prepareCloudForDrag?.(item);
            if (item._ensureLocalPromise && !cachedLocalPath) {
              const isMainVariant = !!(it.is_main_color_variant || String(it.color_variant||'') === '01');
              item._ensureLocalPromise.then((localPath) => {
                try {
                  if (localPath) {
                    item.setAttribute('data-url', localPath);
                    item.setAttribute('data-cached', 'true');
                    cachedLocalPath = cachedLocalPath || localPath;
                    const iconEl = item.querySelector('.fa-nexus-token-status-icon');
                    if (iconEl) { iconEl.classList.remove('premium','cloud-plus'); iconEl.classList.add('cloud','cached'); iconEl.title = 'Downloaded'; iconEl.innerHTML = '<i class="fas fa-cloud-check"></i>'; }
                    if (isMainVariant && anchorCard) {
                      try { anchorCard.setAttribute('data-url', localPath); } catch (_) {}
                      try { anchorCard.setAttribute('data-cached', 'true'); } catch (_) {}
                      const statusIcon = anchorCard.querySelector('.fa-nexus-status-icon');
                      if (statusIcon) { statusIcon.classList.add('cloud','cached'); statusIcon.title = 'Downloaded'; statusIcon.innerHTML = '<i class="fas fa-cloud-check"></i>'; }
                    }
                  }
                } catch (_) {}
              }).catch(() => {});
            }
          } catch(_) {}
        }
        const startX = ev.clientX, startY = ev.clientY; const threshold = 4;
        item._faVariantDragging = false;
        const move = (e) => {
          const dx = Math.abs((e.clientX||0) - startX); const dy = Math.abs((e.clientY||0) - startY);
          if (dx + dy > threshold) {
            document.removeEventListener('mousemove', move, true);
            document.removeEventListener('mouseup', up, true);
            item._faVariantDragging = true;
            try { 
              TokenDragDropManager.setHoverSuppressed(true);
              this._dragDrop?._startQueuedDrag?.(item, e.clientX, e.clientY); 
            } catch(_) {}
          }
        };
        const up = () => { document.removeEventListener('mousemove', move, true); document.removeEventListener('mouseup', up, true); setTimeout(() => { item._faVariantDragging = false; }, 0); };
        document.addEventListener('mousemove', move, true);
        document.addEventListener('mouseup', up, true);
      }, { capture: true });

      item.addEventListener('click', (ev) => {
        if (ev.button !== 0) return;
        if (item._faVariantDragging) { item._faVariantDragging = false; return; }
        ev.preventDefault();
        ev.stopPropagation();
        const variantRecord = item._variantRecord || null;
        const source = item.getAttribute('data-source') || '';
        const tier = item.getAttribute('data-tier') || '';
        let authed = false; try { const auth = game.settings.get('fa-nexus', 'patreon_auth_data'); authed = !!(auth && auth.authenticated && auth.state); } catch(_) {}
        const cached = item.getAttribute('data-cached') === 'true';
        if (!cached && source === 'cloud' && tier === 'premium' && !authed) {
          ensureVariantUnlocked('variant-click');
          return;
        }
        try { TokenDragDropManager.setHoverSuppressed(true); } catch (_) {}
        this._hideColorVariantsPanel();
        const randomColorEnabled = this._isRandomColorPlacementEnabled();
        let placementPromise = null;
        if (randomColorEnabled && variantRecord) {
          const variantItems = [variantRecord, ...variants.filter((v) => v && v !== variantRecord)];
          const entries = this._buildEntriesFromItems(variantItems, { primaryCard: item });
          if (entries.length > 0) {
            placementPromise = this._placement?.startPlacementFromEntries?.(entries, {
              sticky: ev.shiftKey,
              pointerEvent: ev,
              forceRandom: true
            });
          }
        }
        if (!placementPromise) {
          placementPromise = this._placement?.startPlacementFromCard?.(item, { sticky: ev.shiftKey, pointerEvent: ev });
        }
        Promise.resolve(placementPromise)
          .catch(() => {})
          .finally(() => {
            if (!this._placement?.isPlacementActive) {
              try { TokenDragDropManager.setHoverSuppressed(false); } catch (_) {}
            }
          });
      });

      grid.appendChild(item);
    }
    document.body.appendChild(panel);
    const panelRect = () => panel.getBoundingClientRect();
    const cardRect = anchorCard.getBoundingClientRect();
    let left = cardRect.right + 10; let top = cardRect.top;
    requestAnimationFrame(() => {
      const pr = panelRect(); const vw = window.innerWidth; const vh = window.innerHeight;
      if (left + pr.width > vw) left = Math.max(8, cardRect.left - pr.width - 10);
      if (top + pr.height > vh) top = Math.max(8, vh - pr.height - 8);
      panel.style.left = `${left}px`; panel.style.top = `${top}px`; panel.classList.add('visible');
    });
    const closeBtn = panel.querySelector('.fa-nexus-variant-close');
    const onCloseBtn = (e) => { e.preventDefault(); e.stopPropagation(); this._hideColorVariantsPanel(); };
    const onOutside = (e) => { if (!panel.contains(e.target)) this._hideColorVariantsPanel(); };
    const onResize = () => { this._hideColorVariantsPanel(); };
    document.addEventListener('click', onOutside, true);
    window.addEventListener('resize', onResize);
    closeBtn?.addEventListener('click', onCloseBtn);
    this._variantCleanup = () => {
      document.removeEventListener('click', onOutside, true);
      window.removeEventListener('resize', onResize);
      closeBtn?.removeEventListener('click', onCloseBtn);
    };
    this._variantPanelEl = panel;
    this._activeVariantBase = baseName;
  }

  /**
   * Update hide-locked checkbox visibility based on authentication status
   */
  _updateHideLockedVisibility() {
    const app = this.app;
    if (!app.element) return;

    const hideLockCb = app.element.querySelector('#fa-nexus-hide-locked');
    if (hideLockCb) {
      let authed = false;
      try {
        const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
        authed = !!(auth && auth.authenticated && auth.state);
      } catch (_) {}

      const wrap = hideLockCb.closest?.('.fa-nexus-footer-control') || hideLockCb.parentElement;
      if (wrap) wrap.style.display = authed ? 'none' : '';
    }
  }

  _bindThumbSizeSlider() {
    const app = this.app;
    const gridContainer = app.element.querySelector('#fa-nexus-grid');
    let sizeInput = app.element.querySelector('#fa-nexus-thumb-size');
    if (!sizeInput || !app._grid) return;
    // Replace node to drop previous listeners (from other tab)
    try { const parent = sizeInput.parentNode; const clone = sizeInput.cloneNode(true); parent.replaceChild(clone, sizeInput); sizeInput = clone; } catch (_) {}
    // Tokens slider range
    sizeInput.min = '92'; sizeInput.max = '160'; sizeInput.step = String(Number(sizeInput.step || 2) || 2);
    const sanitize = (value) => Math.max(92, Math.min(160, Number(value) || 140));
    const savedWidth = Number(game.settings.get('fa-nexus', 'thumbWidthTokens') || game.settings.get('fa-nexus', 'thumbWidth') || 0) || (app._grid.card?.width || 140);
    sizeInput.value = String(sanitize(savedWidth));

    let pendingWidth = sanitize(sizeInput.value);
    let rafId = null;

    const applyDims = (w) => {
      const clamped = sanitize(w);
      const t = Math.max(0, Math.min(1, (clamped - 90) / (160 - 90)));
      const baseFooter = 29 + (40 - 29) * t;
      const h = Math.round((clamped / 140) * (180 - baseFooter)) + baseFooter;
      try { app._grid.setCardSize(clamped, h); } catch (_) {}
      if (gridContainer) {
        gridContainer.style.setProperty('--fa-nexus-card-pad', `${2 + (6 - 2) * t}px`);
        gridContainer.style.setProperty('--fa-nexus-title-size', `${0.72 + (0.85 - 0.72) * t}rem`);
        gridContainer.style.setProperty('--fa-nexus-details-size', `${0.60 + (0.75 - 0.60) * t}rem`);
        gridContainer.style.setProperty('--fa-nexus-footer-pt', `${0 + (6 - 0) * t}px`);
      }
      try { this.app?.updateGridPlaceholderSize?.({ tab: this.id, width: clamped, height: h, gap: this.getGridOptions?.()?.card?.gap ?? 5 }); } catch (_) {}
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
      try { await game.settings.set('fa-nexus', 'thumbWidthTokens', w); } catch (_) {}
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
}
