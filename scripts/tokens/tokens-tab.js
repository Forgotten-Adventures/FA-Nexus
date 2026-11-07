import { createFolderSelectionPredicate } from '../content/content-sources/content-sources-utils.js';
import { GridBrowseTab } from '../core/ui/grid-browse-tab.js';
import { applyGridDensityStyles } from '../core/ui/grid-density-styles.js';
import {
  collectLocalInventory,
  formatOperationalError,
  getEnabledFolders
} from '../content/nexus-content-service.js';
import { abortError, formatCatalogLoaderText, isAbortError, loadAndMergeCloudRecords } from '../content/catalog-pipeline.js';
import { readFaNexusCloudEnabledSetting } from '../core/cloud-enabled-settings.js';
import { normalizeTokenInventoryRecord } from '../content/inventory-utils.js';
import {
  contentDimensions,
  contentFilename,
  contentFolder,
  contentGrid,
  contentPath,
  inventoryItemKey
} from '../content/cloud-inventory-v2.js';
import { TokenDataService } from './token-data-service.js';
import { TokenPreviewManager } from './token-preview-manager.js';
import { FaNexusTokensFolderSelectionDialog } from './tokens-content-sources-dialog.js';
import { TokenDragDropManager } from './token-dragdrop-manager.js';
import { TokenPlacementManager } from './token-placement-manager.js';
import { TokenSelectionHelper } from './token-selection-helper.js';
import { mergeTokenLocalAndCloudRecords } from './token-cloud-local-merge-policy.js';
import { buildTokenPlacementEntryFromRecord } from './token-placement-entry.js';
import { applyTokenCardCachedState } from './token-card-cache-state.js';
import { TokensTabProbeHelper } from './tokens-probe-helper.js';
import { TokensColorVariantPanelRuntime } from './tokens-color-variant-panel-runtime.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { hasContentProductAccess, lockedPremiumContentMessage } from '../premium/patreon-auth-contract.js';
import {
  applyFolderBrowserSelectionChange,
  computeFolderBrowserStats,
  createEmptyFolderBrowserStats,
  readFolderBrowserSelection,
  syncFolderBrowserFilterState
} from '../core/folder-browser-state.js';
import { normalizeFolderPath as normalizeSharedFolderPath } from '../storage/path-utils.js';
import { getFolderPathInfo as getSharedFolderPathInfo } from '../storage/folder-path-info.js';

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
    this._indexingLocks = 0;
    this._placement = new TokenPlacementManager(app);
    this._selection = new TokenSelectionHelper(this);
    this._probe = new TokensTabProbeHelper(this);
    this._colorVariants = new TokensColorVariantPanelRuntime(this);
    this._activeFolderSelection = { type: 'all', includePaths: [], includePathLowers: [] };
    this._folderStats = createEmptyFolderBrowserStats();
    this._deferredActivationTimeout = null;
    this._didDeactivate = false;
    this._cloudAbort = null;
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
    return readFolderBrowserSelection({
      selection: this._activeFolderSelection,
      normalizePath: (value) => this._normalizeFolderPath(value),
      supportsUnassigned: true,
      logger: Logger,
      loggerLabel: 'TokensTab.selection.getActiveFolderSelection'
    });
  }

  onFolderSelectionChange(selection) {
    applyFolderBrowserSelectionChange({
      app: this.app,
      tabId: this.id,
      selection,
      normalizePath: (value) => this._normalizeFolderPath(value),
      supportsUnassigned: true,
      logger: Logger,
      loggerLabel: 'TokensTab.selection.normalize',
      getSelection: () => this._activeFolderSelection,
      setSelection: (nextSelection) => {
        this._activeFolderSelection = nextSelection;
      },
      afterSync: () => {
        this.applySearch(this.getCurrentSearchValue());
      }
    });
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


  /**
   * Activate the tab: build grid, bind events, and load/merge token data
   * @returns {Promise<void>}
   */
  async onActivate() {
    const app = this.app;
    Logger.info('TokensTab.onActivate');
    this._didDeactivate = false;
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
    try { this._placement?.primeActorTypeChoices?.(); } catch (_) {}

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
    this._didDeactivate = true;
    this._cancelInFlight('tab-deactivate');
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
      this._colorVariants?.uninstallContext?.();
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

  destroy() {
    try { this.onDeactivate(); } catch (_) {}
    try { this._placement?.destroy?.(); } catch (_) {}
    this._placement = null;
    try { this._colorVariants?.destroy?.(); } catch (_) {}
    this._colorVariants = null;
    try { this._dragDrop?.destroy?.(); } catch (_) {}
    this._dragDrop = null;
    try { this._tokenPreview?.destroy?.(); } catch (_) {}
    this._tokenPreview = null;
    if (super.destroy) super.destroy();
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

  _cancelInFlight(reason = 'cancelled') {
    this._loadId = (this._loadId || 0) + 1;
    if (this._cloudAbort) {
      try { this._cloudAbort.abort(reason); } catch (_) {}
      this._cloudAbort = null;
    }
    this._indexingLocks = 0;
    try { this.app?.setTabsLocked?.(false); } catch (_) {}
    try { this.app?.hideGridLoader?.(this.id); } catch (_) {}
  }

  filterItems(items, query) {
    let filtered = super.filterItems(items, query);
    try {
      const mainOnly = game.settings.get('fa-nexus', 'mainColorOnly');
      if (mainOnly) {
        filtered = filtered.filter((it) => {
          const variant = String(it?.color?.variant ?? '').trim();
          return !variant || !!it?.color?.main || variant === '01';
        });
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
            if (this.app?._downloadManager) {
              const localPath = this.app._downloadManager.getLocalPath('tokens', {
                id: inventoryItemKey(token),
                selected_source: token.selected_source || { ext: '.webp' },
                tier: token.tier || 'free'
              });
              return !!localPath;
            }
          } catch (_) {}
          return false;
        });
      }
    } catch (_) {}

    if (!this.app._collections?.active) {
      const matchesFolder = createFolderSelectionPredicate(this._activeFolderSelection);
      filtered = filtered.filter((token) => matchesFolder(this._getNormalizedFolderPath(token)));
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
    if (!app?.rendered || !app?.element) return;
    this._cancelInFlight('restart');
    const loadId = (++this._loadId);
    const controller = new AbortController();
    this._cloudAbort = controller;
    const { signal } = controller;
    const isUiActive = () => !!(app?.rendered && app?.element && app?._grid && app?._activeTab === this.id && !this._didDeactivate);
    const isCancelled = () => signal.aborted || (loadId !== this._loadId) || !app?.rendered || !app?.element;

    const showGridLoader = (message) => {
      if (!isUiActive()) return;
      try { this.app?.showGridLoader?.(message, { owner: this.id }); } catch (_) {}
    };
    const hideGridLoader = () => {
      try { this.app?.hideGridLoader?.(this.id); } catch (_) {}
    };
    const updateGridLoader = (message) => {
      if (!isUiActive()) return;
      try { this.app?.updateGridLoader?.(message, { owner: this.id }); } catch (_) {}
    };
    const cloudEnabled = this._isCloudEnabled();
    const getCloudIndexingState = async () => {
      try {
        const svc = this.app?._contentService;
        if (!svc) return { indexing: false, label: 'Loading cloud tokens…', count: null, total: null };
        if (typeof svc.getMeta === 'function') {
          const meta = await svc.getMeta('tokens');
          const hasIndex = !!meta?.latest;
          const totalCount = Number(meta?.count);
          const total = Number.isFinite(totalCount) && totalCount > 0 ? Math.max(0, Math.floor(totalCount)) : null;
          return {
            indexing: !hasIndex,
            label: hasIndex ? 'Loading cloud tokens…' : 'Preparing cloud token index...',
            count: null,
            total
          };
        }
        const latest = await svc.getLatest?.('tokens');
        return { indexing: !latest, label: latest ? 'Loading cloud tokens…' : 'Preparing cloud token index...', count: null, total: null };
      } catch (_) { return { indexing: false, label: 'Loading cloud tokens…', count: null, total: null }; }
    };
    const startCloudLoader = async () => {
      const state = await getCloudIndexingState();
      showGridLoader(formatCatalogLoaderText(state?.label, state?.count, state?.total, 'Loading cloud tokens...'));
      return {
        state,
        update: (count, total, phase = null) => {
          if (phase === 'waiting') state.label = 'Waiting for cloud token index...';
          else if (phase === 'download') state.label = 'Downloading cloud token index...';
          else if (phase === 'replaceAll') state.label = 'Indexing cloud tokens...';
          if (Number.isFinite(total) && total > 0) state.total = Math.max(0, Math.floor(total));
          if (Number.isFinite(count) && count >= 0) state.count = Math.max(0, Math.floor(count));
          updateGridLoader(formatCatalogLoaderText(state?.label, state?.count, state?.total, 'Loading cloud tokens...'));
        }
      };
    };
    const withCloudLock = async (fn) => {
      let locked = false; let label = 'Indexing cloud tokens…';
      try {
        const st = await getCloudIndexingState();
        if (st?.indexing && isUiActive()) { this._setIndexingLock(true, st.label || label); locked = true; }
      } catch (_) {}
      try { return await fn(); } finally { if (locked) this._setIndexingLock(false); }
    };

    try {
      const folders = getEnabledFolders('tokenFolders');
      Logger.info('TokensTab.loadTokens:folders', { count: folders.length, folders });
      if (!folders.length) {
        // No local folders: show cloud only. Clear current locals immediately and show a loader.
        this._items = [];
        this._computeFolderStats(this._items);
        if (isUiActive()) {
          try { app._grid.setData([]); } catch (_) {}
        }
        if (cloudEnabled) {
          const cloudLoader = isUiActive() ? await startCloudLoader() : null;
          await withCloudLock(async () => {
            if (isCancelled()) throw abortError();
            const result = await this._loadAndMergeCloud(false, {
              signal,
              onProgress: (count, total, phase) => cloudLoader?.update?.(count, total, phase),
              onTotal: (total) => {
                const count = Number.isFinite(cloudLoader?.state?.count) && cloudLoader.state.count > 0
                  ? cloudLoader.state.count
                  : total;
                cloudLoader?.update?.(count, total);
              }
            });
            if (result?.error && !result.partial) {
              throw (result.errorObject || new Error(result.error));
            }
            if (isCancelled()) throw abortError();
            hideGridLoader();
            this._items = Array.isArray(result?.items) ? result.items : [];
            this._computeFolderStats(this._items);
            if (isUiActive()) {
              await this.applySearchAsync(this.getCurrentSearchValue());
            }
            Logger.info('TokensTab.cloud.only:done', {
              total: this._items.length,
              partial: !!result?.partial,
              error: result?.error || null
            });
            if (result?.partial && result?.error) {
              Logger.warn('TokensTab.cloud.partial', { error: result.error, localCount: this._items.length });
            }
            if (this.app?._activeTab === this.id) {
              try { this._updateFolderFilter(); } catch (_) {}
            }
          });
        } else {
          hideGridLoader();
          this._computeFolderStats(this._items);
          if (isUiActive()) {
            await this.applySearchAsync(this.getCurrentSearchValue());
          }
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
        loadCached: async (folder) => {
          const records = await this._tokenData.loadCachedTokens(folder);
          return Array.isArray(records) ? records.map((record) => normalizeTokenInventoryRecord(record)) : records;
        },
        saveIndex: (folder, records) => this._tokenData.saveTokensIndex(folder, records),
        streamFolder: (folder, onBatch, options) => this._tokenData.streamLocalTokens(folder, onBatch, options),
        streamOptions: { batchSize: 1500, sleepMs: 8 },
        isCancelled,
        keySelector: (rec) => inventoryItemKey(rec) || contentPath(rec) || '',
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
          if (!localLockActive && isUiActive()) { this._setIndexingLock(true, 'Indexing local tokens...'); localLockActive = true; }
        }
      });

      if (localResult.cancelled || isCancelled()) {
        hideGridLoader();
        if (localLockActive) this._setIndexingLock(false);
        throw abortError();
      }

      this._items = localResult.localItems;
      this._computeFolderStats(this._items);
      Logger.info('TokensTab.local.complete', { cached: localResult.cachedItems.length, streamed: localResult.streamedCount });

      if (localLockActive) this._setIndexingLock(false);

      if (cloudEnabled) {
        const cloudLoader = isUiActive() ? await startCloudLoader() : null;
        await withCloudLock(async () => {
          if (isCancelled()) throw abortError();
          const result = await this._loadAndMergeCloud(true, {
            signal,
            onProgress: (count, total, phase) => cloudLoader?.update?.(count, total, phase),
            onTotal: (total) => {
              const count = Number.isFinite(cloudLoader?.state?.count) && cloudLoader.state.count > 0
                ? cloudLoader.state.count
                : total;
              cloudLoader?.update?.(count, total);
            }
          });
          if (result?.error && !result.partial) {
            throw (result.errorObject || new Error(result.error));
          }
          if (isCancelled()) throw abortError();
          hideGridLoader();
          this._items = Array.isArray(result?.items) ? result.items : [];
          this._computeFolderStats(this._items);
          if (isUiActive()) {
            await this.applySearchAsync(this.getCurrentSearchValue());
          }
          Logger.info('TokensTab.streaming:done', {
            total: this._items.length,
            streamed: localResult.streamedCount,
            partial: !!result?.partial,
            error: result?.error || null
          });
          if (result?.partial && result?.error) {
            Logger.warn('TokensTab.cloud.partial', { error: result.error, localCount: this._items.length });
          }
          if (this.app?._activeTab === this.id) {
            try { this._updateFolderFilter(); } catch (_) {}
          }
        });
      } else {
        hideGridLoader();
        this._computeFolderStats(this._items);
        if (isUiActive()) {
          await this.applySearchAsync(this.getCurrentSearchValue());
        }
        if (this.app?._activeTab === this.id) {
          try { this._updateFolderFilter(); } catch (_) {}
        }
      }
    } catch (error) {
      hideGridLoader();
      if (isAbortError(error) || isCancelled()) {
        Logger.info('TokensTab.loadTokens:aborted');
        return;
      }
      Logger.error('TokensTab.loadTokens:failed', {
        code: error?.code || null,
        source: error?.source || null,
        settingKey: error?.settingKey || null,
        folder: error?.folder || null,
        error: String(error?.message || error)
      });
      try {
        ui?.notifications?.error?.(formatOperationalError(error, 'Failed to load token sources.'));
      } catch (_) {}
    } finally {
      if (this._cloudAbort === controller) this._cloudAbort = null;
      if (signal.aborted) hideGridLoader();
    }
  }

  async _fetchCloudTokens(options = {}) {
    const signal = options.signal || null;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    if (signal?.aborted) throw abortError();

    const svc = this.app?._contentService;
    if (!svc) throw new Error('Cloud token content service unavailable');

    let hadCachedIndex = false;
    let syncError = null;
    let syncErrorObject = null;
    try {
      const meta = await svc.getMeta?.('tokens');
      hadCachedIndex = !!meta?.latest;
    } catch (_) {}

    Logger.info('TokensTab.cloud.sync', { hadCachedIndex });
    try {
      await svc.sync('tokens', {
        signal,
        onManifestProgress: ({ phase, count, total }) => {
          if (signal?.aborted) return;
          try { onProgress?.(count, total, phase); } catch (_) {}
        },
        progressBatch: 500
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (isAbortError(error)) throw error;
      syncError = String(error?.message || error);
      syncErrorObject = error ?? null;
      Logger.warn('TokensTab.cloud.sync.failed', { error: syncError, hadCachedIndex });
    }

    let items = [];
    try {
      const result = await svc.list('tokens', {
        signal,
        onProgress: (count, total) => {
          if (signal?.aborted) return;
          try { onProgress?.(count, total); } catch (_) {}
        },
        progressBatch: 500
      });
      items = Array.isArray(result?.items) ? result.items : [];
      Logger.info('TokensTab.cloud.list', { count: items.length, total: result?.total ?? items.length });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (isAbortError(error)) throw error;
      const listError = String(error?.message || error);
      if (syncError) {
        throw new Error(`Cloud token sync failed (${syncError}); cached index unavailable (${listError})`);
      }
      throw error;
    }

    if (signal?.aborted) throw abortError();

    const downloadManager = this.app?._downloadManager;
    const out = [];
    for (const item of items) {
      const record = {
        ...item,
        source: 'cloud',
        tier: item?.tier === 'premium' || item?.tier === 'free' ? item.tier : 'free'
      };
      try {
        const local = downloadManager?.getLocalPath?.('tokens', record);
        if (local) record.cachedLocalPath = local;
      } catch (_) {}
      out.push(record);
      if (signal?.aborted) throw abortError();
    }

    return {
      items: out,
      error: syncError,
      errorObject: syncErrorObject,
      partial: !!syncError && (hadCachedIndex || out.length > 0)
    };
  }

  async _loadAndMergeCloud(includeLocal, options = {}) {
    const collectedLocal = includeLocal ? (Array.isArray(this._items) ? this._items.slice() : []) : [];
    const signal = options.signal || null;
    const svc = this.app?._contentService;
    return loadAndMergeCloudRecords({
      cloudEnabled: this._isCloudEnabled(),
      localItems: collectedLocal,
      signal,
      fetchCloud: () => this._fetchCloudTokens(options),
      onTotal: options.onTotal,
      onCloudItems: (cloudItems) => {
        Logger.info('TokensTab.cloud.items', { count: cloudItems.length });
      },
      onCloudError: (cloudError) => {
        Logger.warn('TokensTab.cloud.load.error', cloudError);
      },
      mergeItems: ({ localItems: nextLocalItems, cloudItems }) => {
        return mergeTokenLocalAndCloudRecords({
          localItems: nextLocalItems,
          cloudItems,
          contentService: svc,
          logger: Logger
        });
      },
      onResult: (result, detail) => {
        Logger.info('TokensTab.cloud.merge', {
          local: detail.localItems.length,
          cloud: detail.cloudItems.length,
          merged: result.items.length,
          partial: result.partial,
          error: result.error
        });
      }
    });
  }

  _normalizeFolderPath(path) {
    return normalizeSharedFolderPath(path);
  }

  _getFolderPathInfo(item, hydrate = false) {
    return getSharedFolderPathInfo(item, { hydrate });
  }

  _getNormalizedFolderPath(item) {
    return this._getFolderPathInfo(item).lower;
  }

  _computeFolderStats(items) {
    this._folderStats = computeFolderBrowserStats(items, {
      previousStats: this._folderStats,
      getFolderInfo: (item) => this._getFolderPathInfo(item, true)
    });
    return this._folderStats;
  }


  _updateFolderFilter() {
    const result = syncFolderBrowserFilterState({
      app: this.app,
      tabId: this.id,
      selection: this._activeFolderSelection,
      stats: this._folderStats || createEmptyFolderBrowserStats(),
      normalizePath: (value) => this._normalizeFolderPath(value),
      labels: {
        label: 'Token Folders',
        allLabel: 'All Tokens',
        unassignedLabel: 'Unsorted'
      },
      logger: Logger,
      loggerLabel: 'TokensTab.selection.updateFolderFilter.final',
      supportsUnassigned: true,
      onSelectionChanged: () => {
        if (this.app?._activeTab === this.id) {
          this.applySearchAsync(this.getCurrentSearchValue());
        }
      }
    });
    this._activeFolderSelection = result.nextSelection;
  }


  describeEmptyState() {
    if (!this._isCloudEnabled() && !getEnabledFolders('tokenFolders').length) {
      return 'No token source is enabled. Enable FA Cloud Tokens or a local folder in Configure Settings, FA Nexus, Token Sources.';
    }
    return super.describeEmptyState();
  }

  _isCloudEnabled() {
    return readFaNexusCloudEnabledSetting({
      setting: 'cloudTokensEnabled',
      warningKey: 'TokensTab.cloudEnabled.readFailed'
    });
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
      const filename = contentFilename(item);
      const folderPath = contentFolder(item);
      const filePath = contentPath(item);
      const [gridWidth, gridHeight] = contentGrid(item);
      const dims = contentDimensions(item);
      const fileSize = Number(item?.selected_source?.size || 0);
      cardElement.setAttribute('data-content-id', inventoryItemKey(item));
      cardElement.setAttribute('data-content-path', filePath);
      cardElement.setAttribute('data-folder', folderPath);
      cardElement.setAttribute('data-name', item.name || filename || '');
      if (filename) cardElement.setAttribute('data-filename', filename);
      if (filePath) cardElement.setAttribute('data-file-path', filePath);
      if (folderPath) cardElement.setAttribute('data-path', folderPath);
      if (item.name) cardElement.setAttribute('data-display-name', item.name);
      if (filePath) {
        cardElement.setAttribute('data-url', filePath);
      }
      cardElement.setAttribute('data-grid-w', String(gridWidth));
      cardElement.setAttribute('data-grid-h', String(gridHeight));
      cardElement.setAttribute('data-width', String(dims.width));
      cardElement.setAttribute('data-height', String(dims.height));
      if (item.scale != null) cardElement.setAttribute('data-scale', String(item.scale));
      if (fileSize > 0) cardElement.setAttribute('data-file-size', String(fileSize));
      if (item.size) cardElement.setAttribute('data-size', item.size);
      if (item.creature_type) cardElement.setAttribute('data-ctype', item.creature_type);
      if (item.variant) cardElement.setAttribute('data-variant', item.variant);
      if (item.color?.variant) cardElement.setAttribute('data-color-variant', String(item.color.variant));
      if (item.color?.group) cardElement.setAttribute('data-color-group', String(item.color.group));
      if (item.source) cardElement.setAttribute('data-source', item.source);
      if (item.tier) cardElement.setAttribute('data-tier', item.tier);
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
      try { cardElement._assetItem = item; } catch (_) {}
      const img = cardElement.querySelector('img');
      const label = cardElement.querySelector('.label');
      const sizeEl = cardElement.querySelector('.token-size');
      const scaleEl = cardElement.querySelector('.token-scale');
      const ctypeEl = cardElement.querySelector('.token-creature-type');
      const statusIcon = cardElement.querySelector('.fa-nexus-status-icon');
      const variantTag = cardElement.querySelector('.fa-nexus-variant-tag');
      const filename = contentFilename(item);
      const filePath = contentPath(item);
      const folderPath = contentFolder(item);
      const [gridWidth, gridHeight] = contentGrid(item);
      const dims = contentDimensions(item);
      const colorVariant = item?.color?.variant ?? null;
      const colorGroup = item?.color?.group || '';
      try {
        cardElement.setAttribute('data-content-id', inventoryItemKey(item));
        cardElement.setAttribute('data-content-path', filePath);
        cardElement.setAttribute('data-folder', folderPath);
        cardElement.setAttribute('data-name', item.name || filename || '');
        if (filename) cardElement.setAttribute('data-filename', filename);
        if (filePath) cardElement.setAttribute('data-file-path', filePath);
        if (folderPath) cardElement.setAttribute('data-path', folderPath);
        cardElement.setAttribute('data-grid-w', String(gridWidth));
        cardElement.setAttribute('data-grid-h', String(gridHeight));
        cardElement.setAttribute('data-width', String(dims.width));
        cardElement.setAttribute('data-height', String(dims.height));
        if (item.name) cardElement.setAttribute('data-display-name', item.name);
        if (colorVariant != null) cardElement.setAttribute('data-color-variant', String(colorVariant));
        if (colorGroup) cardElement.setAttribute('data-color-group', colorGroup);
      } catch (_) {}
      if (label) label.textContent = item.name || '';
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
        const v = item.variant || colorVariant || '';
        variantTag.textContent = v;
        variantTag.style.display = v ? 'inline-flex' : 'none';
      }
      // If this is a cloud token, check if it has already been downloaded and cached
      try {
        if (String(item.source||'') === 'cloud') {
          const dl = this.app?._downloadManager;
          if (dl && typeof dl.getLocalPath === 'function') {
            const localPath = dl.getLocalPath('tokens', item);
            if (localPath) {
              applyTokenCardCachedState(cardElement, localPath, { iconSelector: '.fa-nexus-status-icon' });
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
        let src = filePath || cardElement.getAttribute('data-url') || cardElement.getAttribute('data-file-path') || '';
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
      if (cardElement?._faNexusTokenPlacementClick) {
        try { cardElement.removeEventListener('click', cardElement._faNexusTokenPlacementClick); } catch (_) {}
        delete cardElement._faNexusTokenPlacementClick;
      }
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
          ui.notifications?.error?.(this._lockedPremiumTokenMessage());
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
            const entries = this._buildRandomColorPlacementEntries(item, cardElement);
            if (entries.length > 1) {
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
    this._probe?.cancelCard?.(cardElement);
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
    const baseName = baseItem.color?.group || entry?.variant_group || this._extractVariantBase(contentFilename(baseItem));
    if (!baseName) return [];
    const items = Array.isArray(this._items) ? this._items : [];
    return items.filter((candidate) => {
      if (!candidate) return false;
      const candidateName = candidate.color?.group || this._extractVariantBase(contentFilename(candidate));
      if (candidateName !== baseName) return false;
      if (inventoryItemKey(candidate) === inventoryItemKey(baseItem)) return false;
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
      const filePath = contentPath(item);
      if (filePath) return filePath.toLowerCase();
      return '';
    };
    for (let index = 0; index < list.length; index++) {
      const record = list[index];
      if (!record) continue;
      const key = computeKey(record);
      if (!key || seen.has(key)) continue;
      const card = (index === 0 && primaryCard) ? primaryCard : null;
      if (this._isTokenLocked(record, card, { authed })) continue;
      const entry = buildTokenPlacementEntryFromRecord(record, { card, downloadManager });
      if (entry) entries.push(entry);
      seen.add(key);
    }
    return entries;
  }

  _buildRandomColorPlacementEntries(item, cardElement = null) {
    const baseItem = item || cardElement?._assetItem || null;
    if (!baseItem) return [];
    const variants = this._resolveRandomColorVariants({
      item: baseItem,
      source_item: baseItem,
      variant_group: baseItem?.color?.group || cardElement?.getAttribute?.('data-color-group') || ''
    });
    return this._buildEntriesFromItems([baseItem, ...variants], { primaryCard: cardElement });
  }

  /** Whether the stored Patreon login's tier includes premium tokens (see patreon-auth-contract.js). */
  _hasPremiumContentAccess() {
    try {
      return hasContentProductAccess(game.settings.get('fa-nexus', 'patreon_auth_data'), 'tokens');
    } catch (_) {
      return false;
    }
  }

  /** The message for a click on a locked premium token card. */
  _lockedPremiumTokenMessage() {
    let authData = null;
    try { authData = game.settings.get('fa-nexus', 'patreon_auth_data'); } catch (_) {}
    return lockedPremiumContentMessage(authData, 'premium tokens');
  }

  _isTokenLocked(item, cardElement = null, { authed = null } = {}) {
    try {
      const isCloud = String(item?.source || '').toLowerCase() === 'cloud';
      const tier = String(item?.tier || '').toLowerCase();
      const isPremium = tier === 'premium';
      if (!isCloud || !isPremium) return false;
      const effectiveAuthed = authed != null ? !!authed : this._hasPremiumAuth();
      if (effectiveAuthed && this._hasPremiumContentAccess()) return false;

      const cachedAttr = cardElement?.getAttribute?.('data-cached') === 'true';
      const hasLocalPath = !!(item?.cachedLocalPath);
      if (cachedAttr || hasLocalPath) return false;

      try {
        const dl = this.app?._downloadManager;
        if (dl) {
          const local = dl.getLocalPath('tokens', item);
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
    return this._probe?.ensureLoader?.();
  }

  _resetProbeLoader() {
    this._probe?.dispose?.();
  }

  _installProbeScrollHandler() {
    this._probe?.installScrollHandler?.();
  }

  _uninstallProbeScrollHandler() {
    this._probe?.uninstallScrollHandler?.();
  }

  _scheduleProbeVisibleCards() {
    this._probe?.scheduleVisibleCards?.();
  }

  _runProbeVisibleCards() {
    this._probe?.runVisibleCards?.();
  }

  _enqueueCacheProbe(cardElement, item) {
    this._probe?.queueCard?.(cardElement, item);
  }

  _drainProbeQueue() {
    this._probe?.runQueue?.();
  }

  _installColorVariantContext() {
    this._colorVariants?.installContext?.();
  }

  _hideColorVariantsPanel() {
    this._colorVariants?.hide?.();
  }

  _notifyPremiumTokenLocked(context = 'color-variant', details = null) {
    this._colorVariants?.notifyPremiumTokenLocked?.(context, details);
  }

  _showColorVariantsPanel(anchorCard, baseName, variants) {
    this._colorVariants?.show?.(anchorCard, baseName, variants);
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
      applyGridDensityStyles(gridContainer, t, {
        titleSize: [0.72, 0.85, 'rem'],
        detailsSize: [0.60, 0.75, 'rem'],
        footerPaddingTop: [0, 6, 'px']
      });
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
