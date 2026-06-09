const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
import { EventManager } from './core/event-manager.js';
import { PatreonAuthService, warmPremiumFeatureBundles } from './premium/patreon-auth-service.js';
import { TokensTab } from './tokens/tokens-tab.js';
import { NexusLogger as Logger } from './core/nexus-logger.js';
import { NexusContentService } from './content/nexus-content-service.js';
import { NexusDownloadManager } from './content/nexus-download-manager.js';
import { BookmarkManager } from './core/bookmarks/bookmark-manager.js';
import { BookmarkToolbar } from './core/bookmarks/bookmark-toolbar.js';
import { SearchController } from './core/search/search-controller.js';
import { GridManager } from './core/ui/grid-manager.js';
import { TabManager } from './core/tab-manager.js';
import { FolderFilterController } from './core/folder-filter/folder-filter-controller.js';
import { initializeNexusLauncher, applyThemeToElement } from './core/nexus-launcher.js';
import { renderPatreonAuthHeader } from './premium/patreon-auth-header.js';
import {
  setPremiumDevBridgeEnabled,
  shouldRefreshPremiumHeaderForSetting
} from './premium/premium-runtime-config.js';
import { FooterController } from './core/footer-controller.js';
import { scheduleAssetCloudWarmup } from './assets/assets-tab-controller.js';
import './tokens/token-elevation-offset.js';
import './scene-import/scene-asset-import-helper.js';
import './canvas/scene-transition-readiness.js';
import './canvas/active-session-level-switch-guard.js';
import './canvas/tile-placement-level.js';
import './canvas/region-surface-invalidation.js';
import './canvas/region-perception-refresh.js';
import './canvas/tile-config.js';
import {
  clearNexusTileSelectionContext,
  installNexusTileSelectionContextHooks,
  preserveCurrentTileSelectionForNexus
} from './canvas/tile-selection-context.js';

const PREMIUM_DISCLAIMER_TABS = new Set(['textures', 'paths', 'buildings']);

function logAppLifecycleFailure(scope, error, details = {}) {
  Logger.warn(scope, { ...details, error });
}

/**
 * FaNexusApp
 * Main UI shell (ApplicationV2 + Handlebars) for FA Nexus, orchestrating tabs,
 * search, cloud/download services, and auth header.
 */
class FaNexusApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-app',
    tag: 'section',
    window: {
      resizable: true,
      minimizable: true
    },
    position: { width: 900, height: 640 }
  };

  static PARTS = {
    body: { template: 'modules/fa-nexus/templates/nexus-app.hbs' }
  };

  constructor(...args) {
    super(...args);
    this._folderFilterController = new FolderFilterController(this);

    Object.defineProperty(this, '_activeTab', {
      get: () => this._tabManager?.getActiveTabId() || null,
      configurable: true
    });
    Object.defineProperty(this, '_activeTabObj', {
      get: () => this._tabManager?.getActiveTab() || null,
      configurable: true
    });
    this._bookmarkManager = new BookmarkManager();
    this._searchController = new SearchController(this);
    this._gridManager = new GridManager(this);
    this._tabManager = new TabManager(this);
    this._footerController = new FooterController({ app: this });
    this._bookmarkToolbar = new BookmarkToolbar({
      app: this,
      bookmarkManager: this._bookmarkManager,
      tabManager: this._tabManager,
      searchController: this._searchController,
      folderController: this._folderFilterController
    });
  }

  /**
   * Persist window position/size on move/resize
   * @param {object} position
   */
  setPosition(position) {
    const result = super.setPosition(position);
    try {
      const p = this.position || position || {};
      const state = { left: p.left, top: p.top, width: p.width, height: p.height };
      this._saveWindowPosition(state);
    } catch (error) {
      logAppLifecycleFailure('App.windowPos.scheduleSaveFailed', error);
    }
    try { this._folderFilterController.syncWindowPosition(); }
    catch (error) { logAppLifecycleFailure('App.folderFilter.syncPositionFailed', error); }
    return result;
  }

  /**
   * Initialize services, wire search, build tabs/grid, and inject auth header.
   * @param {boolean} initial
   * @param {object} context
   */
  _onRender(initial, context) {
    super._onRender(initial, context);
    try { preserveCurrentTileSelectionForNexus('app-render'); }
    catch (error) { logAppLifecycleFailure('App.tileSelectionContext.preserveRenderFailed', error); }
    try { applyThemeToElement(this.element); }
    catch (error) { logAppLifecycleFailure('App.theme.applyFailed', error); }
    Logger.info('App._onRender', { initial: !!initial });
    // Ensure shared cloud services are ready for tabs/drag
    try {
      const authProvider = () => this._getAuthService();
      if (!this._contentService) this._contentService = new NexusContentService({ app: this, authService: authProvider });
      else this._contentService.setAuthContext({ app: this, authService: authProvider });
    } catch (error) {
      logAppLifecycleFailure('App.contentService.initFailed', error);
    }
    try {
      if (!this._downloadManager) {
        this._downloadManager = new NexusDownloadManager();
        this._downloadManager.initialize();
      }
    } catch (error) {
      logAppLifecycleFailure('App.downloadManager.initFailed', error);
    }
    // Restore window position/size/state
    try {
      const pos = game.settings.get('fa-nexus', 'windowPos') || {};
      if (pos && typeof pos === 'object') {
        const { left, top, width, height } = pos;
        const p = Object.assign({}, this.position);
        if (Number.isFinite(left)) p.left = left;
        if (Number.isFinite(top)) p.top = top;
        if (Number.isFinite(width)) p.width = width;
        if (Number.isFinite(height)) p.height = height;
        this.setPosition(p);
      }
    } catch (error) {
      logAppLifecycleFailure('App.windowPos.restoreFailed', error);
    }
    // Wire search with debounce via SearchController
    if (!this._events) this._events = new EventManager();
    this._searchController.initialize(this._events);
    this._bookmarkToolbar.initialize(this._events);
    this._footerController.initialize(this._events);
    try { this._folderFilterController.onAppRender(); } catch (e) { Logger.warn('FolderFilter.onRender failed', e); }

    // Initialize/rebind grid to current DOM container on render
    const gridContainer = this.element.querySelector('#fa-nexus-grid');
    try { this._tabManager.initializeTabs(); Logger.info('App.ensureTabs'); } catch (e) { Logger.warn('App.ensureTabs failed', e); }

    // Ensure we have an active tab
    let activeTabId = this._tabManager.getActiveTabId();
    if (!activeTabId) {
      activeTabId = this._tabManager.loadActiveTabFromSettings();
    }

    // If the grid doesn't exist or points to an old container, (re)activate the current tab
    if (gridContainer && (!this._grid || this._grid.container !== gridContainer)) {
      try {
        if (this._grid && this._grid.container !== gridContainer) {
          try { this._grid.destroy(); }
          catch (error) { logAppLifecycleFailure('App.grid.destroyBeforeRebindFailed', error); }
          this._grid = null;
        }
        Logger.info('App.reactivateTab', { tab: activeTabId });
        // Always reactivate the current tab when grid container changes
        this._tabManager.switchToTab(activeTabId);
      } catch (e) { Logger.error('App.reactivateTab failed', e); }
    }
    this._tabManager.bindTabButtons({ element: this.element, events: this._events });
    this._footerController.bindGlobalFooter();
    try { this._folderFilterController.refreshBrowser(); }
    catch (error) { logAppLifecycleFailure('App.folderFilter.refreshBrowserFailed', error); }

    // Auth header (Patreon) setup injected into window header
    try {
      renderPatreonAuthHeader({
        app: this,
        getAuthService: () => this._getAuthService()
      });
      this._setPatreonHeaderVisibility(!this.minimized);
    } catch (e) { Logger.warn('Auth header render failed', e); }

    // React to auth setting changes to refresh header quickly
    try {
      if (!this._authSettingHook) {
        this._authSettingHook = (setting) => {
          if (!shouldRefreshPremiumHeaderForSetting(setting)) return;
          try {
            renderPatreonAuthHeader({
              app: this,
              getAuthService: () => this._getAuthService()
            });
            this._setPatreonHeaderVisibility(!this.minimized);
            this._syncPremiumDisclaimer();
          } catch (err) { Logger.warn('Auth header refresh failed', err); }
        };
        Hooks.on('updateSetting', this._authSettingHook);
      }
    } catch (error) {
      logAppLifecycleFailure('App.authHeader.hookInstallFailed', error);
    }
    this._syncPremiumDisclaimer();
  }

  _onAttach(fromDocument, toDocument) {
    this._handleHostDocumentChanged('attach', fromDocument, toDocument);
  }

  _onDetach(fromDocument, toDocument) {
    this._handleHostDocumentChanged('detach', fromDocument, toDocument);
  }

  _handleHostDocumentChanged(reason, fromDocument, toDocument) {
    try {
      Logger.info('App.hostDocumentChanged', {
        reason,
        from: fromDocument?.location?.href || null,
        to: toDocument?.location?.href || null
      });
    } catch (_) {}
    try { applyThemeToElement(this.element); }
    catch (error) { logAppLifecycleFailure('App.hostDocumentChanged.themeApplyFailed', error, { reason }); }
    const activeTab = this._tabManager?.getActiveTab?.() || null;
    let handledByTab = false;
    if (activeTab && typeof activeTab.onHostDocumentChanged === 'function') {
      handledByTab = true;
      try { activeTab.onHostDocumentChanged({ reason, fromDocument, toDocument }); }
      catch (error) {
        handledByTab = false;
        logAppLifecycleFailure('App.hostDocumentChanged.activeTabFailed', error, {
          reason,
          tab: this._tabManager?.getActiveTabId?.() || null
        });
      }
    }
    if (!handledByTab) {
      try { this._grid?._syncHostWindow?.(); }
      catch (error) { logAppLifecycleFailure('App.hostDocumentChanged.gridSyncFailed', error, { reason }); }
      try { this._grid?._onResize?.(); }
      catch (error) { logAppLifecycleFailure('App.hostDocumentChanged.gridResizeFailed', error, { reason }); }
      try { this._grid?.refreshMounted?.(); }
      catch (error) { logAppLifecycleFailure('App.hostDocumentChanged.gridRefreshFailed', error, { reason }); }
    }
    try { this._folderFilterController?.syncWindowPosition?.(); }
    catch (error) { logAppLifecycleFailure('App.hostDocumentChanged.folderFilterSyncFailed', error, { reason }); }
  }

  async minimize() {
    if (this.minimized) return;
    await super.minimize();
    this._setPatreonHeaderVisibility(false);
  }

  async maximize() {
    if (!this.minimized) return;
    await super.maximize();
    this._setPatreonHeaderVisibility(true);
  }

  /** Cleanup tabs, timers, grid and listeners; persist UI state */
  _onClose(options = {}) {
    try {
      Logger.info('App._onClose');
      try { this._footerController?.destroy?.(); }
      catch (error) { logAppLifecycleFailure('App.close.footerDestroyFailed', error); }
      try { this._tabManager.setTabsLocked(false); }
      catch (error) { logAppLifecycleFailure('App.close.unlockTabsFailed', error); }
      try { this._tabManager.cancelActiveOperations('app-close'); }
      catch (error) { logAppLifecycleFailure('App.close.cancelActiveOperationsFailed', error); }
      try { this._tabManager.getActiveTab()?.onDeactivate?.(); }
      catch (error) { logAppLifecycleFailure('App.close.deactivateTabFailed', error, { tab: this._tabManager?.getActiveTabId?.() || null }); }
      // Persist window position/size
      try {
        const p = this.position || {};
        const state = { left: p.left, top: p.top, width: p.width, height: p.height };
        this._saveWindowPosition(state);
      } catch (error) {
        logAppLifecycleFailure('App.close.windowPos.scheduleSaveFailed', error);
      }
      try { this._tabManager.saveActiveTabToSettings(this._tabManager.getActiveTabId() || 'tokens'); }
      catch (error) { logAppLifecycleFailure('App.close.saveActiveTabFailed', error); }
      if (this._tokenPreview) {
        this._tokenPreview.hidePreview?.();
        this._tokenPreview.destroy();
        this._tokenPreview = null;
      }
      if (this._dragDrop) {
        try { this._dragDrop._cleanupPreview?.(); }
        catch (error) { logAppLifecycleFailure('App.close.dragDropPreviewCleanupFailed', error); }
        this._dragDrop = null; // listeners are on shared EventManager and get cleaned up below
      }
      if (this._grid) {
        this._grid.destroy();
        this._grid = null;
      }
      if (this._events) {
        this._events.cleanup();
        this._events = null;
      }
      if (this._authSettingHook) {
        try { Hooks.off('updateSetting', this._authSettingHook); }
        catch (error) { logAppLifecycleFailure('App.close.authHookRemoveFailed', error); }
        this._authSettingHook = null;
      }
      try { this._folderFilterController.cleanup(); }
      catch (error) { logAppLifecycleFailure('App.close.folderFilterCleanupFailed', error); }
      try { this._bookmarkToolbar.cleanup(); }
      catch (error) { logAppLifecycleFailure('App.close.bookmarkToolbarCleanupFailed', error); }
      if (this._searchController) {
        this._searchController.cleanup();
        this._searchController = null;
      }
      if (this._gridManager) {
        this._gridManager.cleanup();
        this._gridManager = null;
      }
      if (this._tabManager) {
        this._tabManager.cleanup();
        this._tabManager = null;
      }
      try { clearNexusTileSelectionContext('app-close'); }
      catch (error) { logAppLifecycleFailure('App.close.tileSelectionContextClearFailed', error); }
    } catch (error) {
      logAppLifecycleFailure('App.close.failed', error);
    }
    super._onClose(options);
  }

  setFolderFilterData(tabId, data) {
    this._folderFilterController.setFolderData(tabId, data);
  }

  updateFolderFilterSelection(tabId, selection, options = {}) {
    this._folderFilterController.updateFolderSelection(tabId, selection, options);
  }

  clearFolderSelections(tabId) {
    this._folderFilterController.clearSelections(tabId);
  }

  _clearFolderSelections(tabId) {
    this.clearFolderSelections(tabId);
  }

  /** Enable or disable tab switching (used during long-running operations) */
  setTabsLocked(locked, message = '') {
    this._tabManager.setTabsLocked(locked, message);
  }

  _setPatreonHeaderVisibility(visible) {
    try {
      const header = this.element?.querySelector('.header-patreon-auth');
      if (header) header.hidden = !visible;
    } catch (error) {
      logAppLifecycleFailure('App.authHeader.visibilityFailed', error, { visible: !!visible });
    }
  }

  _hasPremiumAuth() {
    try {
      const auth = game?.settings?.get?.('fa-nexus', 'patreon_auth_data');
      return !!(auth && auth.authenticated && auth.state);
    } catch (error) {
      logAppLifecycleFailure('App.premiumAuth.readFailed', error);
      return false;
    }
  }

  _syncPremiumDisclaimer() {
    try {
      const notice = this.element?.querySelector('.fa-nexus-premium-disclaimer');
      if (!notice) return;
      const activeTab = this._tabManager?.getActiveTabId?.() || null;
      const visible = PREMIUM_DISCLAIMER_TABS.has(activeTab) && !this._hasPremiumAuth();
      notice.hidden = !visible;
      notice.setAttribute('aria-hidden', visible ? 'false' : 'true');
    } catch (error) {
      logAppLifecycleFailure('App.premiumDisclaimer.syncFailed', error);
    }
  }

  showGridLoader(message = '', { owner = null } = {}) {
    return this._gridManager.showGridLoader(message, { owner });
  }

  updateGridLoader(message = '', { owner = null } = {}) {
    return this._gridManager.updateGridLoader(message, { owner });
  }

  hideGridLoader(owner = null) {
    return this._gridManager.hideGridLoader(owner);
  }

  isGridLoaderOwnedBy(owner) {
    return this._gridManager.isGridLoaderOwnedBy(owner);
  }

  showGridPlaceholder({ tab = null, width, height, gap } = {}) {
    return this._gridManager.showGridPlaceholder({ tab, width, height, gap });
  }

  updateGridPlaceholderSize({ tab = null, width, height, gap } = {}) {
    return this._gridManager.updateGridPlaceholderSize({ tab, width, height, gap });
  }

  hideGridPlaceholder(tab = null) {
    return this._gridManager.hideGridPlaceholder(tab);
  }


  /** Lazily create the PatreonAuthService */
  _getAuthService() {
    if (!this._authService) this._authService = new PatreonAuthService();
    return this._authService;
  }

  /** Persist window position settings with error logging */
  async _saveWindowPosition(state) {
    try {
      await game.settings.set('fa-nexus', 'windowPos', state);
    } catch (err) {
      Logger.warn('App.windowPos.saveFailed', err);
    }
  }

  /**
   * Get bookmarks for the current tab
   * @returns {Array<Object>}
   */
  getCurrentTabBookmarks() {
    return this._bookmarkToolbar?.getCurrentTabBookmarks?.() || [];
  }

  saveCurrentStateAsBookmark(title) {
    return this._bookmarkToolbar?.saveCurrentStateAsBookmark?.(title);
  }

  loadBookmark(bookmarkId) {
    return this._bookmarkToolbar?.loadBookmark?.(bookmarkId) ?? false;
  }

  updateBookmark(bookmarkId, updates) {
    return this._bookmarkToolbar?.updateBookmark?.(bookmarkId, updates);
  }

  deleteBookmark(bookmarkId) {
    return this._bookmarkToolbar?.deleteBookmark?.(bookmarkId);
  }

  _handleBookmarkSave() {
    return this._bookmarkToolbar?.promptSaveCurrentState?.();
  }

  _refreshBookmarkToolbar() {
    this._bookmarkToolbar?.refresh?.();
  }

  /** Bind footer controls shared across all tabs */
  bindFooter() {
    try {
      this._footerController?.bindGlobalFooter?.();
    } catch (e) {
      Logger.warn('bindFooter failed', e);
    }
  }

}

/**
 * Open or focus FA Nexus application
 * @returns {FaNexusApp|null}
 */
function renderFaNexus() {
  // Only GMs can access the module
  if (!game?.user?.isGM) return null;
  try { preserveCurrentTileSelectionForNexus('app-open'); }
  catch (error) { logAppLifecycleFailure('App.tileSelectionContext.preserveOpenFailed', error); }

  try {
    const existing = foundry.applications.instances.get('fa-nexus-app');
    if (existing) {
      // If already rendered, just bring to front; avoid duplicate _onRender triggers mid-layout
      if (!existing.rendered) existing.render(true);
      else existing.bringToFront?.();
      try { preserveCurrentTileSelectionForNexus('app-focus-existing'); }
      catch (error) { logAppLifecycleFailure('App.tileSelectionContext.preserveExistingFailed', error); }
      return existing;
    }
  } catch (error) {
    logAppLifecycleFailure('App.render.lookupExistingFailed', error);
  }
  const app = new FaNexusApp();
  app.render(true);
  return app;
}

initializeNexusLauncher({ onOpen: renderFaNexus });

async function enablePremiumDevBridge(options = {}) {
  const enabled = await setPremiumDevBridgeEnabled(true, options);
  if (!enabled) return false;
  try {
    await warmPremiumFeatureBundles({ reason: 'dev-bridge-enable' });
  } catch (error) {
    Logger.warn('FaNexusApp.enablePremiumDevBridge.warmFailed', { error: String(error?.message || error) });
  }
  return true;
}

async function disablePremiumDevBridge(options = {}) {
  return await setPremiumDevBridgeEnabled(false, options);
}

Hooks.once('ready', () => {
  try { installNexusTileSelectionContextHooks(); }
  catch (error) { logAppLifecycleFailure('App.ready.tileSelectionContextInstallFailed', error); }
  // Register drag/drop globally via TokensTab (tokens-only feature)
  try { TokensTab.registerGlobalDragDrop?.(); }
  catch (error) { logAppLifecycleFailure('App.ready.registerGlobalDragDropFailed', error); }

  // Preload templates for synchronous rendering
  try {
    const templates = [
      'modules/fa-nexus/templates/tokens/token-card.hbs',
      'modules/fa-nexus/templates/tokens/actor-update-dialog.hbs'
    ];
    foundry.applications.handlebars.loadTemplates(templates)
      .then(() => foundry.applications.handlebars.getTemplate('modules/fa-nexus/templates/tokens/token-card.hbs'))
      .then((template) => {
        try { FaNexusApp.CARD_TEMPLATE = template; }
        catch (error) { logAppLifecycleFailure('App.ready.cacheCardTemplateFailed', error); }
      })
      .catch((error) => {
        logAppLifecycleFailure('App.ready.preloadTokenTemplatesFailed', error);
      });
  } catch (error) {
    logAppLifecycleFailure('App.ready.scheduleTemplatePreloadFailed', error);
  }

  try {
    warmPremiumFeatureBundles({ reason: 'startup' }).catch((error) => {
      Logger.warn('FaNexusApp.premiumWarmup.failed', { error: String(error?.message || error) });
    });
  } catch (error) {
    logAppLifecycleFailure('App.ready.schedulePremiumWarmupFailed', error);
  }

  try {
    scheduleAssetCloudWarmup({ reason: 'startup' });
  } catch (error) {
    Logger.warn('FaNexusApp.assetWarmup.scheduleFailed', { error: String(error?.message || error) });
  }
});

// Expose a small API for macros/console if needed later
window.faNexus = Object.assign(window.faNexus || {}, {
  open: renderFaNexus,
  enablePremiumDevBridge,
  disablePremiumDevBridge
});
