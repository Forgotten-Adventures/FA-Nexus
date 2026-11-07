const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
import { EventManager } from './core/event-manager.js';
import { PatreonAuthService, warmPremiumFeatureBundles } from './premium/patreon-auth-service.js';
import { NexusLogger as Logger } from './core/nexus-logger.js';
import { NexusContentService } from './content/nexus-content-service.js';
import { NexusDownloadManager } from './content/nexus-download-manager.js';
import { BookmarkManager } from './core/ui/bookmarks/bookmark-manager.js';
import { CollectionsController } from './content/collections-controller.js';
import { CONTENT_COLLECTIONS_ENABLED } from './content/collections-availability.js';
import { BookmarkToolbar } from './core/ui/bookmarks/bookmark-toolbar.js';
import { SearchController } from './core/ui/search/search-controller.js';
import { GridManager } from './core/ui/grid-manager.js';
import { TabManager } from './core/application/tab-manager.js';
import { FolderFilterController } from './core/ui/folder-filter/folder-filter-controller.js';
import { initializeNexusLauncher, applyThemeToElement } from './core/application/nexus-launcher.js';
import { renderPatreonAuthHeader } from './premium/patreon-auth-header.js';
import {
  setPremiumDevBridgeEnabled,
  shouldRefreshPremiumHeaderForSetting
} from './premium/premium-runtime-config.js';
import { FooterController } from './core/application/footer-controller.js';
import { onFoundryBoot } from './core/foundry-boot-hooks.js';
import { isMapmakingEnabled, isPrefabsEnabled, isTokensEnabled } from './core/feature-areas.js';
import { insertLayerManagerSidebarSlot } from './layers/layer-manager-sidebar-slot.js';
import './core/mapmaking-off-notice.js';
import {
  clearNexusTileSelectionContext,
  installNexusTileSelectionContextHooks,
  preserveCurrentTileSelectionForNexus
} from './canvas/tile-selection-context.js';
import {
  isUsableExpandedNexusPosition,
  resolvePersistableNexusPosition,
  resolveRestorableNexusPosition
} from './core/application/nexus-window-position-state.js';
import { premiumEntitlementsService } from './premium/premium-entitlements-service.js';

const TOKENS_ENABLED = isTokensEnabled();
const MAPMAKING_ENABLED = isMapmakingEnabled();

let TokensTab = null;
let scheduleAssetCloudWarmup = null;
const NEXUS_TAB_DEFINITIONS = [];

if (TOKENS_ENABLED) {
  ({ TokensTab } = await import('./tokens/tokens-tab.js'));
  NEXUS_TAB_DEFINITIONS.push(Object.freeze({
    id: 'tokens',
    label: 'Tokens',
    TabClass: TokensTab,
    folderFilterLabels: Object.freeze({ label: 'Token Folders', allLabel: 'All Tokens', unassignedLabel: 'Unsorted' })
  }));
}

// The Layer Manager's sidebar slot is set here, before the await below: Foundry builds its sidebar from Sidebar.TABS
// and may do so before layer-manager-tab.js has loaded (see core/foundry-boot-hooks.js).
if (MAPMAKING_ENABLED) Hooks.once('init', insertLayerManagerSidebarSlot);

if (MAPMAKING_ENABLED) {
  const [
    { AssetsTab },
    { BuildingsTab },
    assetsTabController
  ] = await Promise.all([
    import('./assets/assets-tab.js'),
    import('./buildings/tab/buildings-tab.js'),
    import('./assets/assets-tab-controller.js'),
    import('./tokens/token-elevation-offset.js'),
    import('./scene-import/scene-asset-import-helper.js'),
    import('./canvas/scene-transition-readiness.js'),
    import('./canvas/active-session-level-switch-guard.js'),
    import('./canvas/tile-placement-level.js'),
    import('./canvas/tile-config.js'),
    import('./canvas/tile-selection.js'),
    import('./canvas/tile-flag-undo-history.js'),
    import('./textures/masked-tiling-native-resize.js'),
    import('./textures/mask-file-undo-guard.js'),
    import('./paths/path-native-tile-transform.js'),
    import('./paths/path-generated-wall-runtime.js'),
    import('./buildings/building-native-tile-transform.js'),
    import('./buildings/building-generated-document-runtime.js'),
    import('./assets/asset-shadow-native-tile-preview-runtime.js'),
    import('./assets/asset-scatter-native-tile-transform.js'),
    import('./flatten/flatten-native-tile-transform.js'),
    import('./portals/door-transform-native-tile-preview-runtime.js'),
    import('./canvas/custom-tile-overhead.js'),
    import('./flatten/tile-flatten-chunks.js'),
    import('./cleanup/generated-cleanup-delete-hook.js'),
    import('./canvas/tile-hud-edit.js'),
    import('./textures/texture-paint-manager.js'),
    import('./portals/seamless-secret-door-runtime.js'),
    import('./portals/portal-texture-flip-runtime.js'),
    import('./portals/door-visual-proxy-manager.js'),
    import('./portals/door-shadow-manager.js'),
    import('./layers/layer-manager-tab.js'),
    import('./composition/scene-group-runtime.js'),
    Promise.all([
      import('./composition/scene-group-native-history-runtime.js'),
      import('./composition/scene-group-overlay-runtime.js')
    ]).then(([{initializeSceneGroupNativeHistoryRuntime}, {sceneGroupOverlayRuntime}]) =>
      initializeSceneGroupNativeHistoryRuntime({
        getPendingOverlayTransform: () => sceneGroupOverlayRuntime.pendingTransform
      })),
    import('./composition/scene-group-interaction-runtime.js'),
    import('./composition/placeable-scene-group-drag-runtime.js')
  ]);
  scheduleAssetCloudWarmup = assetsTabController.scheduleAssetCloudWarmup;
  const PrefabsTab = isPrefabsEnabled() ? (await import('./composition/prefabs-tab.js')).PrefabsTab : null;
  NEXUS_TAB_DEFINITIONS.push(Object.freeze({
    id: 'assets',
    label: 'Assets',
    TabClass: AssetsTab,
    folderFilterLabels: Object.freeze({ label: 'Asset Folders', allLabel: 'All Assets', unassignedLabel: 'Unsorted' })
  }),
  Object.freeze({
    id: 'textures',
    label: 'Textures',
    TabClass: AssetsTab,
    constructorOptions: Object.freeze({ mode: 'textures' }),
    premium: true,
    folderFilterLabels: Object.freeze({ label: 'Texture Folders', allLabel: 'All Textures', unassignedLabel: 'Unsorted' })
  }),
  Object.freeze({
    id: 'paths',
    label: 'Paths',
    TabClass: AssetsTab,
    constructorOptions: Object.freeze({ mode: 'paths' }),
    premium: true,
    folderFilterLabels: Object.freeze({ label: 'Path Folders', allLabel: 'All Paths', unassignedLabel: 'Unsorted' })
  }),
  Object.freeze({
    id: 'buildings',
    label: 'Building Tool',
    TabClass: BuildingsTab,
    premium: true,
    folderFilterLabels: Object.freeze({ label: 'Asset Folders', allLabel: 'All Assets', unassignedLabel: 'Unsorted' }),
    bookmarkFolderScope: 'paths',
    searchApplyOptions: Object.freeze({ refreshTextures: false })
  }));
  if (PrefabsTab) NEXUS_TAB_DEFINITIONS.push(Object.freeze({
    id: 'prefabs',
    label: 'Prefabs',
    experimental: true,
    TabClass: PrefabsTab
  }));
}

Object.freeze(NEXUS_TAB_DEFINITIONS);
const DEFAULT_TAB_ID = NEXUS_TAB_DEFINITIONS[0]?.id || 'tokens';
const PREMIUM_DISCLAIMER_TABS = new Set(NEXUS_TAB_DEFINITIONS
  .filter((definition) => definition.premium)
  .map((definition) => definition.id));

function logAppLifecycleFailure(scope, error, details = {}) {
  Logger.warn(scope, { ...details, error });
}

function buildNexusTabContext(activeTabId = DEFAULT_TAB_ID) {
  const active = String(activeTabId || DEFAULT_TAB_ID);
  return NEXUS_TAB_DEFINITIONS.map((definition) => {
    const selected = definition.id === active;
    return {
      id: definition.id,
      label: definition.label || definition.id,
      experimental: definition.experimental === true,
      active: selected,
      activeClass: selected ? ' active' : '',
      ariaSelected: selected ? 'true' : 'false'
    };
  });
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
    body: { template: 'modules/fa-nexus/templates/application/nexus-app.hbs' }
  };

  constructor(...args) {
    super(...args);
    this._lastExpandedPosition = resolvePersistableNexusPosition(this.position, null);
    this._folderFilterController = new FolderFilterController(this, {
      tabDefinitions: NEXUS_TAB_DEFINITIONS
    });

    Object.defineProperty(this, '_activeTab', {
      get: () => this._tabManager?.getActiveTabId() || null,
      configurable: true
    });
    Object.defineProperty(this, '_activeTabObj', {
      get: () => this._tabManager?.getActiveTab() || null,
      configurable: true
    });
    this._bookmarkManager = new BookmarkManager();
    this._collections = CONTENT_COLLECTIONS_ENABLED ? new CollectionsController(this) : null;
    this._searchController = new SearchController(this, {
      tabDefinitions: NEXUS_TAB_DEFINITIONS,
      defaultTabId: DEFAULT_TAB_ID
    });
    this._gridManager = new GridManager(this);
    this._tabManager = new TabManager(this, {
      tabDefinitions: NEXUS_TAB_DEFINITIONS,
      defaultTabId: DEFAULT_TAB_ID
    });
    this._footerController = new FooterController({ app: this });
    this._bookmarkToolbar = new BookmarkToolbar({
      app: this,
      bookmarkManager: this._bookmarkManager,
      tabManager: this._tabManager,
      searchController: this._searchController,
      folderController: this._folderFilterController,
      tabDefinitions: NEXUS_TAB_DEFINITIONS,
      defaultTabId: DEFAULT_TAB_ID
    });
  }

  async _prepareContext() {
    const activeTabId = this._tabManager?.getActiveTabId?.() || DEFAULT_TAB_ID;
    return {
      nexusTabs: buildNexusTabContext(activeTabId)
    };
  }

  /**
   * Persist window position/size on move/resize
   * @param {object} position
   */
  setPosition(position) {
    const result = super.setPosition(position);
    try {
      const p = this.position || position || {};
      const state = isUsableExpandedNexusPosition(p)
        ? resolvePersistableNexusPosition(p, null)
        : null;
      if (state) {
        this._lastExpandedPosition = state;
        this._saveWindowPosition(state);
      }
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
    this._installResizePointerCapture();
    if (MAPMAKING_ENABLED) {
      try { preserveCurrentTileSelectionForNexus('app-render'); }
      catch (error) { logAppLifecycleFailure('App.tileSelectionContext.preserveRenderFailed', error); }
    }
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
        const p = resolveRestorableNexusPosition(pos, this.position);
        if (Object.keys(pos).length && !isUsableExpandedNexusPosition(pos)) {
          Logger.warn('App.windowPos.recoveredCollapsedState', { saved: pos, restored: p });
        }
        this._lastExpandedPosition = p;
        this.setPosition(p);
      }
    } catch (error) {
      logAppLifecycleFailure('App.windowPos.restoreFailed', error);
    }
    // Wire search with debounce via SearchController
    if (!this._events) this._events = new EventManager();
    this._searchController.initialize(this._events);
    this._bookmarkToolbar.initialize(this._events);
    this._collections?.bindGrid();
    this._footerController.initialize(this._events);
    try { this._folderFilterController.onAppRender(); } catch (e) { Logger.warn('FolderFilter.onRender failed', e); }

    // Initialize/rebind grid to current DOM container on render
    const gridContainer = this.element.querySelector('#fa-nexus-grid');
    try {
      this._tabManager.initializeTabs();
      Logger.info('App.ensureTabs');
    } catch (error) {
      Logger.error('App.ensureTabs failed', error);
      throw error;
    }

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
      // A Pro-tier refusal changes the tool tabs' notice without any setting change.
      if (!this._stopEntitlementWatch) {
        this._stopEntitlementWatch = premiumEntitlementsService.onChange(() => this._syncPremiumDisclaimer());
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

  async close(options = {}) {
    const buildingTab = this._tabManager?.getTabs?.()?.buildings || null;
    const manager = buildingTab?._buildingManager || null;
    if (manager) {
      try {
        const outcome = await manager.requestApplicationClose({ reason: 'closing FA Nexus' });
        if (['continued', 'blocked'].includes(outcome?.kind)) return this;
      } catch (error) {
        ui?.notifications?.error?.(`FA Nexus could not finish Building Edit before closing: ${String(error?.message || error)}`);
        throw error;
      }
    }
    // A Texture or Path session with changes is saved while its window still exists. Saved after the
    // window is gone, the session has no host and is torn down in the middle of the save.
    try {
      await this._tabManager?.getActiveTab?.()?.saveSessionBeforeApplicationClose?.();
    } catch (error) {
      manager?.cancelApplicationClose?.();
      Logger.error('App.close.sessionSaveFailed', { tab: this._tabManager?.getActiveTabId?.() || null, error: String(error?.message || error) });
      ui?.notifications?.error?.(`FA Nexus stays open: the open session could not be saved (${String(error?.message || error)}). Commit or cancel it, then close.`);
      return this;
    }
    try {
      // From here on this window gives up its search, grid and tabs. It is not drawn again: a window asked for
      // while it closes is a new one that waits for this promise (renderFaNexus).
      this._closePromise = super.close(options);
      return await this._closePromise;
    } catch (error) {
      this._closePromise = null;
      manager?.cancelApplicationClose?.();
      ui?.notifications?.error?.(`FA Nexus close failed: ${String(error?.message || error)}`);
      throw error;
    }
  }

  /** A window opened while the one before it is still closing waits for that close: both carry the same id. */
  async render(options, _options) {
    if (this._renderAfter) {
      await Promise.resolve(this._renderAfter).catch(() => {});
      this._renderAfter = null;
      const other = foundry.applications.instances.get('fa-nexus-app');
      if (other && other !== this) throw new Error('FA Nexus is still open: its window did not close.');
    }
    return super.render(options, _options);
  }

  /** Cleanup tabs, timers, grid and listeners; persist UI state */
  _onClose(options = {}) {
    this._resizePointerCaptureAbort?.abort?.();
    this._resizePointerCaptureAbort = null;
    this._resizePointerCaptureHandle = null;
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
        const state = resolvePersistableNexusPosition(p, this._lastExpandedPosition);
        if (state) this._saveWindowPosition(state);
        else Logger.warn('App.close.windowPos.noExpandedState', { position: p });
      } catch (error) {
        logAppLifecycleFailure('App.close.windowPos.scheduleSaveFailed', error);
      }
      try { this._tabManager.saveActiveTabToSettings(this._tabManager.getActiveTabId() || DEFAULT_TAB_ID); }
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
      if (this._stopEntitlementWatch) {
        this._stopEntitlementWatch();
        this._stopEntitlementWatch = null;
      }
      this._collections?.destroy();
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
      if (MAPMAKING_ENABLED) {
        try { clearNexusTileSelectionContext('app-close'); }
        catch (error) { logAppLifecycleFailure('App.close.tileSelectionContextClearFailed', error); }
      }
    } catch (error) {
      logAppLifecycleFailure('App.close.failed', error);
    } finally {
      if (this._contentService) {
        try { this._contentService.destroy?.(); }
        catch (error) { logAppLifecycleFailure('App.close.contentServiceDestroyFailed', error); }
        finally { this._contentService = null; }
      }
    }
    super._onClose(options);
  }

  _installResizePointerCapture() {
    const handle = this.element?.querySelector?.('.window-resize-handle');
    if (!handle || this._resizePointerCaptureHandle === handle) return;
    this._resizePointerCaptureAbort?.abort?.();
    const controller = new AbortController();
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      try {
        // Foundry normally waits for the first move before capturing. A fast
        // resize can leave this tiny handle before that move is delivered.
        handle.setPointerCapture(event.pointerId);
      } catch (error) {
        logAppLifecycleFailure('App.windowResize.pointerCaptureFailed', error, {
          pointerId: event.pointerId
        });
      }
    }, { capture: true, signal: controller.signal });
    this._resizePointerCaptureHandle = handle;
    this._resizePointerCaptureAbort = controller;
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
      const notice = this.element?.querySelector('.fa-nexus-premium-disclaimer:not(.fa-nexus-experimental-notice)');
      if (!notice) return;
      const activeTab = this._tabManager?.getActiveTabId?.() || null;
      // Signed out: connect Patreon. Signed in, but the tools endpoint refused the tier: the Pro tier is needed.
      const signedIn = this._hasPremiumAuth();
      const proRefused = signedIn && !!premiumEntitlementsService.proTierRefusal;
      const visible = PREMIUM_DISCLAIMER_TABS.has(activeTab) && (!signedIn || proRefused);
      notice.hidden = !visible;
      notice.setAttribute('aria-hidden', visible ? 'false' : 'true');
      notice.dataset.reason = proRefused ? 'pro-tier' : 'signed-out';
      for (const line of notice.querySelectorAll('[data-premium-reason]')) line.hidden = line.dataset.premiumReason !== notice.dataset.reason;
      const experimental = this.element?.querySelector('.fa-nexus-experimental-notice');
      if (experimental) {
        const shown = NEXUS_TAB_DEFINITIONS.find((definition) => definition.id === activeTab)?.experimental === true;
        experimental.hidden = !shown;
        experimental.setAttribute('aria-hidden', shown ? 'false' : 'true');
      }
    } catch (error) {
      logAppLifecycleFailure('App.premiumDisclaimer.syncFailed', error);
    }
  }

  /**
   * Re-materialize the visible browse grid after Patreon access changes.
   * Setting hooks can arrive before entitlement state settles, so auth completion
   * owns one authoritative refresh instead of relying on incidental tab changes.
   */
  async refreshActiveGridAfterAuthenticationChange() {
    this._syncPremiumDisclaimer();
    if (!this.rendered || !this.element) {
      return { refreshed: false, reason: 'app-not-rendered' };
    }
    const activeTab = this._tabManager?.getActiveTab?.() || null;
    if (!activeTab) {
      throw new Error('Nexus has no active tab to refresh after authentication changed.');
    }
    if (typeof activeTab.applySearchAsync !== 'function') {
      Logger.info('App.authGridRefresh:skipped', {
        tab: this._tabManager?.getActiveTabId?.() || null,
        reason: 'active-tab-has-no-grid-search'
      });
      return { refreshed: false, reason: 'active-tab-has-no-grid-search' };
    }
    if (!this._grid) {
      throw new Error('The active Nexus browse tab has no mounted grid to refresh.');
    }
    const query = typeof activeTab.getCurrentSearchValue === 'function'
      ? activeTab.getCurrentSearchValue()
      : '';
    await activeTab.applySearchAsync(query);
    this._syncPremiumDisclaimer();
    Logger.info('App.authGridRefresh:complete', {
      tab: this._tabManager?.getActiveTabId?.() || null
    });
    return { refreshed: true, reason: 'active-grid-rematerialized' };
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

// The window that will open once the one that is closing is gone.
let reopeningApp = null;

/**
 * Open or focus FA Nexus application
 * @returns {FaNexusApp|null}
 */
function renderFaNexus() {
  // Only GMs can access the module
  if (!game?.user?.isGM) return null;
  if (MAPMAKING_ENABLED) {
    try { preserveCurrentTileSelectionForNexus('app-open'); }
    catch (error) { logAppLifecycleFailure('App.tileSelectionContext.preserveOpenFailed', error); }
  }

  try {
    const existing = foundry.applications.instances.get('fa-nexus-app');
    if (existing?._closePromise) {
      // The window is closing and has given up, or is giving up, its controllers: drawn again it was an empty
      // shell. A fresh window takes its place as soon as it is gone; every caller within that time gets the same one.
      if (!reopeningApp) {
        const app = new FaNexusApp();
        app._renderAfter = existing._closePromise;
        reopeningApp = app;
        app.render(true)
          .catch((error) => logAppLifecycleFailure('App.render.afterCloseFailed', error))
          .finally(() => { if (reopeningApp === app) reopeningApp = null; });
      }
      return reopeningApp;
    }
    if (existing) {
      // If already rendered, just bring to front; avoid duplicate _onRender triggers mid-layout
      if (!existing.rendered) existing.render(true);
      else existing.bringToFront?.();
      if (MAPMAKING_ENABLED) {
        try { preserveCurrentTileSelectionForNexus('app-focus-existing'); }
        catch (error) { logAppLifecycleFailure('App.tileSelectionContext.preserveExistingFailed', error); }
      }
      return existing;
    }
  } catch (error) {
    logAppLifecycleFailure('App.render.lookupExistingFailed', error);
  }
  const app = new FaNexusApp();
  app.render(true);
  return app;
}

if (NEXUS_TAB_DEFINITIONS.length) {
  initializeNexusLauncher({ onOpen: renderFaNexus, preserveTileSelection: MAPMAKING_ENABLED });
}

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

// Registered after the runtime imports above have finished, which on a slow host can be after ready.
onFoundryBoot('ready', () => {
  if (MAPMAKING_ENABLED) {
    try { installNexusTileSelectionContextHooks(); }
    catch (error) { logAppLifecycleFailure('App.ready.tileSelectionContextInstallFailed', error); }
  }
  // Preload templates for synchronous rendering
  if (TOKENS_ENABLED) try {
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

  if (NEXUS_TAB_DEFINITIONS.length) try {
    warmPremiumFeatureBundles({ reason: 'startup' }).catch((error) => {
      Logger.warn('FaNexusApp.premiumWarmup.failed', { error: String(error?.message || error) });
    });
  } catch (error) {
    logAppLifecycleFailure('App.ready.schedulePremiumWarmupFailed', error);
  }

  if (MAPMAKING_ENABLED) try {
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
