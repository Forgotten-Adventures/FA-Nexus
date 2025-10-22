import { NexusLogger as Logger } from './nexus-logger.js';
import { TokensTab } from '../tokens/tokens-tab.js';
import { AssetsTab } from '../assets/assets-tab.js';
import { TexturesTab } from '../textures/textures-tab.js';
import { PathsTab } from '../paths/paths-tab.js';

/**
 * TabManager
 * Manages tab lifecycle, switching, and persistence for FA Nexus
 */
export class TabManager {
  constructor(app) {
    this.app = app;
    this._tabs = null;
    this._activeTab = null;
    this._activeTabObj = null;
    this._tabsLocked = false;
    this._tabLockMessage = '';
  }

  /**
   * Initialize tab instances if not already created
   */
  initializeTabs() {
    if (!this._tabs) {
      this._tabs = {
        tokens: new TokensTab(this.app),
        assets: new AssetsTab(this.app),
        textures: new TexturesTab(this.app),
        paths: new PathsTab(this.app)
      };
    }
  }

  /**
   * Get the currently active tab ID
   * @returns {string} Active tab ID
   */
  getActiveTabId() {
    return this._activeTab;
  }

  /**
   * Get the currently active tab instance
   * @returns {object} Active tab instance
   */
  getActiveTab() {
    return this._activeTabObj;
  }

  /**
   * Get all tab instances
   * @returns {object} Map of tab instances
   */
  getTabs() {
    return this._tabs;
  }

  /**
   * Load active tab from settings
   * @returns {string} Active tab ID
   */
  loadActiveTabFromSettings() {
    try {
      return game.settings.get('fa-nexus', 'activeTab') || 'tokens';
    } catch (_) {
      return 'tokens';
    }
  }

  /**
   * Save active tab to settings
   * @param {string} tabId - Tab ID to save
   */
  saveActiveTabToSettings(tabId) {
    try {
      game.settings.set('fa-nexus', 'activeTab', tabId);
    } catch (_) {}
  }

  /**
   * Check if tabs are currently locked
   * @returns {boolean} True if tabs are locked
   */
  areTabsLocked() {
    return this._tabsLocked;
  }

  /**
   * Set tab lock state
   * @param {boolean} locked - Whether tabs should be locked
   * @param {string} message - Optional lock message
   */
  setTabsLocked(locked, message = '') {
    this._tabsLocked = !!locked;
    this._tabLockMessage = locked ? String(message || '') : '';
    this._applyTabLockState();
  }

  syncTabButtons() {
    this._syncTabButtons();
  }

  bindTabButtons({ element, events }) {
    if (!element || !events) return;
    const buttons = element.querySelectorAll('.fa-nexus-tabs .fa-nexus-tab');
    if (!buttons?.length) return;

    buttons.forEach((button) => {
      events.on(button, 'click', () => {
        const requested = button?.dataset?.nexusTab || 'tokens';
        Logger.info('TabSwitch.click', { requested, locked: this.areTabsLocked() });
        if (this.areTabsLocked()) return;
        this.switchToTab(requested);
      });
    });

    this.syncTabButtons();
  }

  /**
   * Apply tab lock state to UI
   * @private
   */
  _applyTabLockState() {
    const tabs = this.app.element?.querySelectorAll('.fa-nexus-tabs .fa-nexus-tab');
    if (!tabs) return;

    const locked = !!this._tabsLocked;
    tabs.forEach(btn => {
      btn.disabled = locked;
      if (locked && this._tabLockMessage) btn.setAttribute('title', this._tabLockMessage);
      else btn.removeAttribute('title');
      btn.classList.toggle('is-disabled', locked);
      btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
    });
  }

  /**
   * Switch to a specific tab
   * @param {string} tabId - Tab ID to switch to
   */
  async switchToTab(tabId) {
    Logger.info('TabSwitch._activateTab:start', { requested: tabId, current: this._activeTab });

    this.initializeTabs();
    const safeId = (tabId && this._tabs && this._tabs[tabId]) ? tabId : 'tokens';

    // Always proceed with tab activation to ensure proper state
    // Note: Removed early return logic as it was preventing proper reactivation

    Logger.info('TabSwitch._activateTab:proceed', { from: this._activeTab, to: safeId });

    // Deactivate current tab
    try { this._activeTabObj?.onDeactivate?.(); } catch (_) {}

    // Update active tab
    this._activeTab = safeId;
    this._activeTabObj = this._tabs[safeId] || null;

    // Save to settings
    this.saveActiveTabToSettings(safeId);

    // Clean up old grid
    if (this.app._grid) {
      try { this.app._grid.destroy(); } catch (_) {}
      this.app._grid = null;
    }

    // Notify other services of tab switch
    this.app._searchController.onTabSwitched(safeId);

    const tabInstance = this._activeTabObj;

    // Show placeholder immediately
    try {
      const placeholderMetrics = tabInstance?.getPlaceholderCardSize?.() || null;
      if (placeholderMetrics) {
        this.app._gridManager.showGridPlaceholder({ tab: safeId, ...placeholderMetrics });
      } else {
        this.app._gridManager.showGridPlaceholder({ tab: safeId });
      }
    } catch (error) {
      Logger.warn('TabSwitch.placeholder.failed', { tab: safeId, error });
    }

    // Bind footer controls
    try { this.app._footerController?.bindGlobalFooter?.(); } catch (_) {}
    try { tabInstance?.bindFooter?.(); } catch (_) {}

    Logger.info('TabSwitch.scheduleActivation', { tab: safeId });

    const activationPromise = this._scheduleTabActivation(tabInstance);

    Logger.info('TabSwitch.syncButtonsFinal', { tab: safeId });
    try { this.syncTabButtons(); } catch (_) {}

    Logger.info('TabSwitch.deferFolderOps', { tab: safeId });
    Promise.resolve().then(() => {
      Logger.info('TabSwitch.deferredOps:start', { tab: safeId });
      try { this.app._folderFilterController?.refreshBrowser(); }
      catch (e) { Logger.warn('TabSwitch.refreshFolderFilter:failed', e); }
      try { this.app._refreshBookmarkToolbar(); } catch (e) { Logger.warn('TabSwitch.refreshBookmarkToolbar:failed', e); }
      try { this.app._searchController.updateFolderIndicator(); } catch (e) { Logger.warn('TabSwitch.updateSearchBar:failed', e); }
      Logger.info('TabSwitch.deferredOps:complete', { tab: safeId });
    });

    return activationPromise;
  }

  /**
   * Update tab button active state in UI
   * @private
   */
  _syncTabButtons() {
    const tabs = this.app.element?.querySelectorAll('.fa-nexus-tabs .fa-nexus-tab');
    if (!tabs) return;

    const active = this._activeTab || 'tokens';
    tabs.forEach(btn => {
      const id = btn.dataset.nexusTab || 'tokens';
      const isActive = id === active;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    this._applyTabLockState();
  }

  /**
   * Schedule tab activation asynchronously
   * @param {object} tabInstance - Tab instance to activate
   * @private
   */
  _scheduleTabActivation(tabInstance) {
    if (!tabInstance || typeof tabInstance.onActivate !== 'function') return Promise.resolve();

    const owner = tabInstance;
    Logger.info('TabSwitch._scheduleTabActivation', { tab: owner.id });

    const startTime = performance.now();

    return new Promise((resolve, reject) => {
      const finish = (error) => {
        try { this.app._gridManager.releaseInitialGridPlaceholderSuppression(); }
        catch (_) {}
        if (error) reject(error);
        else resolve();
      };

      Promise.resolve().then(() => {
        const scheduledTime = performance.now();
        Logger.info('TabSwitch.onActivate:start', { tab: owner.id, delay: scheduledTime - startTime });

        if (this._activeTabObj !== owner) {
          Logger.info('TabSwitch.onActivate:cancelled', { tab: owner.id, currentTab: this._activeTabObj?.id });
          finish();
          return;
        }

        try {
          const result = owner.onActivate();
          if (result && typeof result.then === 'function') {
            result.then(() => {
              if (this._activeTabObj === owner) {
                Logger.info('TabSwitch.onActivate:complete', { tab: owner.id });
              }
              finish();
            }).catch((error) => {
              if (this._activeTabObj === owner) {
                Logger.warn('TabSwitch.onActivateFailed', { tab: owner.id, error });
              }
              finish(error);
            });
          } else {
            Logger.info('TabSwitch.onActivate:complete', { tab: owner.id });
            finish();
          }
        } catch (error) {
          Logger.warn('TabSwitch.onActivateError', { tab: owner.id, error });
          finish(error);
        }
      }).catch((error) => {
        Logger.warn('TabSwitch.onActivate:scheduleFailed', { tab: owner.id, error });
        finish(error);
      });
    });
  }

  /**
   * Cancel active operations on all tabs
   * @param {string} reason - Reason for cancellation
   */
  cancelActiveOperations(reason = 'unknown') {
    if (!this._tabs) return;
    for (const tab of Object.values(this._tabs)) {
      try { tab.cancelActiveOperations?.(reason); } catch (_) {}
    }
  }

  /**
   * Cleanup tab manager resources
   */
  cleanup() {
    // Cancel any active operations
    this.cancelActiveOperations('cleanup');

    // Deactivate current tab
    try { this._activeTabObj?.onDeactivate?.(); } catch (_) {}

    // Clear references
    this._tabs = null;
    this._activeTab = null;
    this._activeTabObj = null;
  }
}
