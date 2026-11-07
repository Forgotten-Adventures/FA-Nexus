import { NexusLogger as Logger } from '../nexus-logger.js';
import { preserveCurrentTileSelectionForNexus } from '../../canvas/tile-selection-context.js';

function normalizeTabDefinition(definition = {}) {
  if (!definition || typeof definition !== 'object') return null;
  const id = String(definition.id || '').trim();
  const TabClass = definition.TabClass;
  if (!id || typeof TabClass !== 'function') return null;
  return Object.freeze({ ...definition, id, TabClass });
}

/**
 * TabManager
 * Manages tab lifecycle, switching, and persistence for FA Nexus
 */
export class TabManager {
  constructor(app, { tabDefinitions = [], defaultTabId = '' } = {}) {
    this.app = app;
    const definitions = tabDefinitions.map(normalizeTabDefinition).filter(Boolean);
    const seenTabIds = new Set();
    for (const definition of definitions) {
      if (seenTabIds.has(definition.id)) {
        throw new Error(`TabManager received duplicate tab definition: ${definition.id}`);
      }
      seenTabIds.add(definition.id);
    }
    this._tabDefinitions = definitions;
    if (!this._tabDefinitions.length) {
      throw new Error('TabManager requires at least one tab definition.');
    }
    this._defaultTabId = this._tabDefinitions.some((definition) => definition.id === defaultTabId)
      ? defaultTabId
      : this._tabDefinitions[0].id;
    this._tabs = null;
    this._activeTab = null;
    this._activeTabObj = null;
    this._tabsLocked = false;
    this._tabLockMessage = '';
  }

  _logLifecycleFailure(scope, error, details = {}) {
    Logger.warn(scope, { ...details, error });
  }

  /**
   * Initialize tab instances if not already created
   */
  initializeTabs() {
    if (!this._tabs) {
      const tabs = {};
      for (const definition of this._tabDefinitions) {
        tabs[definition.id] = new definition.TabClass(this.app, definition.constructorOptions);
      }
      this._tabs = tabs;
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
      const tabId = game.settings.get('fa-nexus', 'activeTab') || this._defaultTabId;
      return this._getSafeTabId(tabId);
    } catch (error) {
      this._logLifecycleFailure('TabManager.activeTab.loadFailed', error);
      return this._defaultTabId;
    }
  }

  /**
   * Save active tab to settings
   * @param {string} tabId - Tab ID to save
   */
  saveActiveTabToSettings(tabId) {
    try {
      game.settings.set('fa-nexus', 'activeTab', tabId);
    } catch (error) {
      this._logLifecycleFailure('TabManager.activeTab.saveFailed', error, { tab: tabId });
    }
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

  bindTabButtons({ element, events }) {
    if (!element || !events) return;
    const buttons = element.querySelectorAll('.fa-nexus-tabs .fa-nexus-tab');
    if (!buttons?.length) return;

    buttons.forEach((button) => {
      const preserveTileSelection = () => {
        const requested = button?.dataset?.nexusTab || this._defaultTabId;
        try { preserveCurrentTileSelectionForNexus(`tab-button:${requested}`); }
        catch (error) { this._logLifecycleFailure('TabSwitch.tileSelectionContext.buttonPreserveFailed', error, { requested }); }
      };
      events.on(button, 'pointerdown', preserveTileSelection, { capture: true });
      events.on(button, 'mousedown', preserveTileSelection, { capture: true });
      events.on(button, 'click', () => {
        const requested = button?.dataset?.nexusTab || this._defaultTabId;
        Logger.info('TabSwitch.click', { requested, locked: this.areTabsLocked() });
        if (this.areTabsLocked()) return;
        this._requestUserTabSwitch(requested, button);
      });
    });

    this._syncTabButtons();
  }

  /**
   * A click on another tab first asks the tab being left (requestTabExit): an open session there may commit,
   * discard or keep the user on it. The tab says why when it refuses.
   * @private
   */
  async _requestUserTabSwitch(requested, button) {
    const leaving = this._activeTabObj;
    if (requested !== this._activeTab && typeof leaving?.requestTabExit === 'function') {
      const label = String(button?.textContent || requested).trim();
      let exit;
      try {
        exit = await leaving.requestTabExit({ leaveLabel: `opening the ${label} tab` });
      } catch (error) {
        this._logLifecycleFailure('TabSwitch.exitRequestFailed', error, { from: this._activeTab, to: requested });
        ui.notifications.error(`FA Nexus stays on this tab: ${String(error?.message || error)}`);
        return;
      }
      if (exit && !exit.proceed) return;
      if (this._activeTabObj !== leaving) return;
    }
    return this.switchToTab(requested);
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
    try { preserveCurrentTileSelectionForNexus('tab-switch-start'); }
    catch (error) { this._logLifecycleFailure('TabSwitch.tileSelectionContext.preserveFailed', error, { requested: tabId }); }

    this.initializeTabs();
    const safeId = this._getSafeTabId(tabId);

    // Always proceed with tab activation to ensure proper state
    // Note: Removed early return logic as it was preventing proper reactivation

    Logger.info('TabSwitch._activateTab:proceed', { from: this._activeTab, to: safeId });

    // A search typed a moment ago belongs to the tab that is being left.
    this.app._searchController?.flushPendingSearch?.();

    // Deactivate current tab
    try { this._activeTabObj?.onDeactivate?.(); }
    catch (error) {
      this._logLifecycleFailure('TabSwitch.deactivateFailed', error, { tab: this._activeTab });
    }

    // Update active tab
    this._activeTab = safeId;
    this._activeTabObj = this._tabs[safeId] || null;
    try { this.app._syncPremiumDisclaimer?.(); }
    catch (error) { this._logLifecycleFailure('TabSwitch.premiumDisclaimerSyncFailed', error, { tab: safeId }); }

    // Save to settings
    this.saveActiveTabToSettings(safeId);

    // Clean up old grid
    if (this.app._grid) {
      try { this.app._grid.destroy(); }
      catch (error) {
        this._logLifecycleFailure('TabSwitch.gridDestroyFailed', error, { from: this._activeTab, to: safeId });
      }
      this.app._grid = null;
    }

    // Notify other services of tab switch
    this.app._searchController.onTabSwitched(safeId);

    const tabInstance = this._activeTabObj;

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
    try { this.app._footerController?.bindGlobalFooter?.(); }
    catch (error) { this._logLifecycleFailure('TabSwitch.bindGlobalFooterFailed', error, { tab: safeId }); }
    try { tabInstance?.bindFooter?.(); }
    catch (error) { this._logLifecycleFailure('TabSwitch.bindTabFooterFailed', error, { tab: safeId }); }

    Logger.info('TabSwitch.scheduleActivation', { tab: safeId });

    const activationPromise = this._scheduleTabActivation(tabInstance);

    Logger.info('TabSwitch.syncButtonsFinal', { tab: safeId });
    try { this._syncTabButtons(); }
    catch (error) { this._logLifecycleFailure('TabSwitch.syncButtonsFailed', error, { tab: safeId }); }

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

    const active = this._activeTab || this._defaultTabId;
    tabs.forEach(btn => {
      const id = btn.dataset.nexusTab || this._defaultTabId;
      const isActive = id === active;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    this._applyTabLockState();
  }

  _getSafeTabId(tabId) {
    const id = String(tabId || '').trim();
    return (id && this._tabDefinitions.some((definition) => definition.id === id))
      ? id
      : this._defaultTabId;
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
        catch (suppressionError) {
          this._logLifecycleFailure('TabSwitch.placeholderSuppressionReleaseFailed', suppressionError, { tab: owner.id });
        }
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
      try { tab.cancelActiveOperations?.(reason); }
      catch (error) {
        this._logLifecycleFailure('TabManager.cancelActiveOperationsFailed', error, {
          tab: tab?.id || null,
          reason
        });
      }
    }
  }

  /**
   * Cleanup tab manager resources
   */
  cleanup() {
    // Cancel any active operations
    this.cancelActiveOperations('cleanup');

    // Deactivate current tab
    try { this._activeTabObj?.onDeactivate?.(); }
    catch (error) {
      this._logLifecycleFailure('TabManager.cleanupDeactivateFailed', error, { tab: this._activeTab });
    }

    for (const [tabId, tab] of Object.entries(this._tabs || {})) {
      try { tab?.destroy?.(); }
      catch (error) {
        this._logLifecycleFailure('TabManager.cleanupDestroyFailed', error, { tab: tabId });
      }
    }

    // Clear references
    this._tabs = null;
    this._activeTab = null;
    this._activeTabObj = null;
  }
}
