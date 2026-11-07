import { FolderFilter } from './folder-filter.js';
import { FolderFilterWindow } from './folder-filter-window.js';
import { cloneFolderSelection, summarizeFolderSelection } from '../../../content/content-sources/content-sources-utils.js';
import { NexusLogger as Logger } from '../../nexus-logger.js';

const DEFAULT_FOLDER_FILTER_LABELS = Object.freeze({
  label: 'Folders',
  allLabel: 'All',
  unassignedLabel: 'Unsorted'
});

function normalizeFolderFilterLabels(labels = null) {
  if (!labels || typeof labels !== 'object') return null;
  const requiredFields = ['label', 'allLabel', 'unassignedLabel'];
  for (const field of requiredFields) {
    if (typeof labels[field] !== 'string' || !labels[field].trim()) {
      throw new Error(`FolderFilterController received invalid folderFilterLabels.${field}`);
    }
  }
  return Object.freeze({
    label: labels.label.trim(),
    allLabel: labels.allLabel.trim(),
    unassignedLabel: labels.unassignedLabel.trim()
  });
}

function normalizeFolderFilterTabDefinition(definition = {}) {
  if (!definition || typeof definition !== 'object') return null;
  const id = String(definition.id || '').trim();
  if (!id) return null;
  return Object.freeze({
    id,
    folderFilterLabels: normalizeFolderFilterLabels(definition.folderFilterLabels)
  });
}

/**
 * FolderFilterController
 * Encapsulates the folder filter window, data hydration, and per-tab
 * selection persistence for FaNexusApp.
 */
export class FolderFilterController {
  constructor(app, { tabDefinitions = [] } = {}) {
    this.app = app;
    const definitions = tabDefinitions.map(normalizeFolderFilterTabDefinition).filter(Boolean);
    const seenTabIds = new Set();
    for (const definition of definitions) {
      if (seenTabIds.has(definition.id)) {
        throw new Error(`FolderFilterController received duplicate tab definition: ${definition.id}`);
      }
      seenTabIds.add(definition.id);
    }
    this._folderFilterLabelsByTab = new Map(definitions
      .filter((definition) => definition.folderFilterLabels)
      .map((definition) => [definition.id, definition.folderFilterLabels]));

    this._folderFilter = new FolderFilter();
    this._folderFilterWindow = null;
    this._folderFilterCollapsed = true;
    this._folderFilterData = new Map();
    this._folderFilterSelections = new Map();
    this._suppressFolderFilterCollapse = false;
    this._suppressSelectionStore = false;

    this._handleFolderFilterCollapse = this._handleFolderFilterCollapse.bind(this);

    this._folderFilter.setSelectionHandler((selection) => this._handleFolderSelection(selection));
    this._folderFilter.setCollapseHandler(this._handleFolderFilterCollapse);
  }

  /**
   * Provide read-only access to the current selection map.
   * Primarily consumed by SearchController for indicator state.
   */
  get selections() {
    return this._folderFilterSelections;
  }

  /**
   * Attach folder filter to the current DOM whenever the app renders.
   */
  onAppRender() {
    this._ensureFolderFilter();
  }

  /**
   * Refresh the folder filter shell and hydrate data for the active tab.
   */
  refreshBrowser() {
    this._ensureFolderFilter();
    if (!this._folderFilter) return;

    const supports = this._activeTabSupportsFolderFilter();
    this._folderFilter.setAvailable(supports);

    this._withCollapseSuppressed(() => {
      this._folderFilter.setCollapsed(this._folderFilterCollapsed, { force: true });
    });

    this._syncFolderFilterShell(supports);
    if (!supports) return;
    this._applyActiveTabData();
  }

  /**
   * Store folder filter data for a specific tab.
   * @param {string} tabId
   * @param {object} data
   */
  setFolderData(tabId, data) {
    if (!tabId) return;
    const payload = { ...data };
    const fallbackLabels = this._getFolderFilterLabels(tabId);
    if (!payload.label) payload.label = fallbackLabels.label;
    if (!payload.allLabel) payload.allLabel = fallbackLabels.allLabel;
    if (!payload.unassignedLabel) payload.unassignedLabel = fallbackLabels.unassignedLabel;

    const storedSelection = this._folderFilterSelections.get(tabId);
    if (payload.selection) payload.selection = cloneFolderSelection(payload.selection);
    else if (storedSelection) payload.selection = cloneFolderSelection(storedSelection);

    this._folderFilterData.set(tabId, payload);
    if (payload.selection) {
      this._folderFilterSelections.set(tabId, cloneFolderSelection(payload.selection));
    }

    try {
      Logger.debug('FolderSelection.setData', {
        tab: tabId,
        hasSelection: !!payload.selection,
        selection: summarizeFolderSelection(payload.selection)
      });
    } catch (_) {}

    if (this._getActiveTabId() !== tabId) return;

    this._ensureFolderFilter();
    if (!this._folderFilter) return;

    const dataClone = { ...payload };
    if (dataClone.selection) dataClone.selection = cloneFolderSelection(dataClone.selection);
    try {
      Logger.debug('FolderSelection.setData:active', {
        tab: tabId,
        selection: summarizeFolderSelection(dataClone.selection)
      });
    } catch (_) {}

    this._folderFilter.setData(dataClone);
    if (dataClone.selection) {
      this._folderFilter.setSelection(cloneFolderSelection(dataClone.selection), { notify: false });
    }
    this._storeActiveSelection();
  }

  /**
   * Update selection for a tab. By default this mirrors updates initiated by the tab
   * itself, so we avoid feeding the change back into the tab unless explicitly asked.
   * @param {string} tabId
   * @param {object|null} selection
   * @param {object} [options]
   * @param {boolean} [options.notifyTab=false] - Whether to call onFolderSelectionChange on the active tab.
   */
  updateFolderSelection(tabId, selection, options = {}) {
    if (!tabId) return;
    const { notifyTab = false } = options;
    const previousSelectionState = this._snapshotFolderSelectionState(tabId);

    const clone = selection ? cloneFolderSelection(selection) : null;
    if (clone) this._folderFilterSelections.set(tabId, clone);
    else this._folderFilterSelections.delete(tabId);

    const data = this._folderFilterData.get(tabId);
    if (data) data.selection = clone ? cloneFolderSelection(clone) : null;

    try {
      Logger.debug('FolderSelection.update', {
        tab: tabId,
        selection: summarizeFolderSelection(clone)
      });
    } catch (_) {}

    if (this._getActiveTabId() !== tabId) return;

    this._ensureFolderFilter();
    if (!this._folderFilter) return;

    const effective = clone || { type: 'all', includePaths: [], excludePaths: [] };
    this._folderFilter.setSelection(cloneFolderSelection(effective), { notify: false });

    if (notifyTab) {
      try {
        this._notifyActiveTabFolderSelection(effective, 'update');
      } catch (error) {
        this._restoreFolderSelectionState(tabId, previousSelectionState);
        this._restoreActiveFolderFilterSelection(tabId, previousSelectionState);
        throw error;
      }
    }

    this._storeActiveSelection();
    this._updateSearchIndicator();
  }

  /**
   * Clear stored selection for a tab and reset UI to the default "all" state.
   * @param {string} tabId
   */
  clearSelections(tabId) {
    if (!tabId) return;
    const previousSelectionState = this._snapshotFolderSelectionState(tabId);
    const defaultSelection = { type: 'all', includePaths: [], excludePaths: [] };
    if (previousSelectionState.storedSelection?.includeSubfolders === false) defaultSelection.includeSubfolders = false;

    if (defaultSelection.includeSubfolders === false) this._folderFilterSelections.set(tabId, defaultSelection);
    else this._folderFilterSelections.delete(tabId);
    const data = this._folderFilterData.get(tabId);
    if (data) data.selection = defaultSelection.includeSubfolders === false ? defaultSelection : null;

    if (this._getActiveTabId() === tabId) {
      this._ensureFolderFilter();
      if (this._folderFilter) {
        this._folderFilter.setSelection(defaultSelection, { notify: false });
      }
      try {
        this._notifyActiveTabFolderSelection(defaultSelection, 'clear');
      } catch (error) {
        this._restoreFolderSelectionState(tabId, previousSelectionState);
        this._restoreActiveFolderFilterSelection(tabId, previousSelectionState);
        throw error;
      }
      this._updateSearchIndicator();
    }

    Logger.info('Folder selections cleared for tab', { tabId });
  }

  /**
   * Return the stored selection for a given tab.
   * @param {string} tabId
   * @param {object} [options]
   * @param {boolean} [options.clone=true]
   * @returns {object|null}
   */
  getSelectionForTab(tabId, options = {}) {
    const { clone = true } = options;
    if (!tabId) return null;
    const selection = this._folderFilterSelections.get(tabId) || null;
    if (!selection) return null;
    return clone ? cloneFolderSelection(selection) : selection;
  }

  /**
   * Determine if the given tab currently has an active (non-default) folder filter.
   * @param {string} tabId
   */
  hasActiveFilter(tabId) {
    const selection = this._folderFilterSelections.get(tabId);
    if (!selection) return false;
    if (selection.type !== 'all') return true;
    const includeCount = selection.includePaths?.length || 0;
    const excludeCount = selection.excludePaths?.length || 0;
    return includeCount > 0 || excludeCount > 0;
  }

  _getFolderFilterLabels(tabId) {
    return this._folderFilterLabelsByTab.get(String(tabId || '').trim()) || DEFAULT_FOLDER_FILTER_LABELS;
  }

  _snapshotFolderSelectionState(tabId) {
    const data = this._folderFilterData.get(tabId);
    return {
      hasStoredSelection: this._folderFilterSelections.has(tabId),
      storedSelection: this._folderFilterSelections.has(tabId)
        ? cloneFolderSelection(this._folderFilterSelections.get(tabId))
        : null,
      hasData: !!data,
      dataHasSelection: !!data && Object.prototype.hasOwnProperty.call(data, 'selection'),
      dataSelection: data?.selection ? cloneFolderSelection(data.selection) : null
    };
  }

  _restoreFolderSelectionState(tabId, state) {
    if (!state) return;
    if (state.hasStoredSelection) this._folderFilterSelections.set(tabId, cloneFolderSelection(state.storedSelection));
    else this._folderFilterSelections.delete(tabId);

    const data = this._folderFilterData.get(tabId);
    if (data && state.hasData) {
      if (state.dataHasSelection) data.selection = state.dataSelection ? cloneFolderSelection(state.dataSelection) : null;
      else delete data.selection;
    }
  }

  _restoreActiveFolderFilterSelection(tabId, state) {
    if (this._getActiveTabId() !== tabId || !this._folderFilter || !state) return;
    const selection = state.hasStoredSelection && state.storedSelection
      ? cloneFolderSelection(state.storedSelection)
      : { type: 'all', includePaths: [], excludePaths: [] };
    this._folderFilter.setSelection(selection, { notify: false });
    this._updateSearchIndicator();
  }

  /**
   * Sync the floating folder window with the main app position.
   */
  syncWindowPosition() {
    if (!this._folderFilterWindow?.rendered) return;
    const parentPos = this.app.position || {};
    const gutter = 0;
    const offsetTop = 70;
    const next = {};

    if (Number.isFinite(parentPos.top)) next.top = parentPos.top + offsetTop;
    if (Number.isFinite(parentPos.left) && Number.isFinite(parentPos.width)) {
      next.left = parentPos.left + parentPos.width + gutter;
    }

    this._folderFilterWindow.setPosition(next);

    if (Number.isFinite(parentPos.height)) {
      this._folderFilterWindow.setMaxHeight(Math.max(240, parentPos.height - offsetTop));
    } else {
      this._folderFilterWindow.setMaxHeight(null);
    }
    try { this._folderFilterWindow.requestFitToContent(); } catch (_) {}
  }

  /**
   * Cleanup resources during app shutdown.
   */
  cleanup() {
    if (this._folderFilterWindow) {
      try { this._folderFilterWindow.close({ animate: false }); } catch (_) {}
      this._folderFilterWindow = null;
    }
    try { this._folderFilter.attach({ panel: null, toggleButton: null }); } catch (_) {}
  }

  /**
   * Window render hook — invoked by FolderFilterWindow.
   * @param {FolderFilterWindow} win
   */
  _onFilterWindowRendered(win) {
    this.app._collections?.attachWindow(win.element);
    const toggle = this.app.element?.querySelector('.fa-nexus-folder-toggle') || null;
    const panel = win?.getPanelElement?.() || null;
    if (!toggle) return;

    this._folderFilter.attach({ panel, toggleButton: toggle });
    this._withCollapseSuppressed(() => {
      this._folderFilter.setCollapsed(this._folderFilterCollapsed, { force: true });
    });

    const supports = this._activeTabSupportsFolderFilter();
    this._folderFilter.setAvailable(supports);
    this.syncWindowPosition();
    this._applyActiveTabData();
  }

  /**
   * Window close hook — invoked by FolderFilterWindow.
   */
  _onFilterWindowClosed() {
    const toggle = this.app.element?.querySelector('.fa-nexus-folder-toggle') || null;
    if (!this._folderFilter?.isCollapsed?.()) {
      this._folderFilterCollapsed = true;
      this._withCollapseSuppressed(() => {
        this._folderFilter.setCollapsed(true, { force: true });
      });
    }
    this._folderFilter.attach({ panel: null, toggleButton: toggle });
  }

  // ------------------------------
  // Internal helpers
  // ------------------------------

  _handleFolderSelection(selection) {
    const tab = this._getActiveTab();
    if (!tab || !tab.supportsFolderBrowser?.()) return;
    const activeTabId = this._getActiveTabId();
    const previousSelectionState = activeTabId ? this._snapshotFolderSelectionState(activeTabId) : null;

    try {
      Logger.debug('FolderSelection.handle', {
        tab: activeTabId,
        selection: summarizeFolderSelection(selection)
      });
    } catch (_) {}

    try {
      this._notifyActiveTabFolderSelection(selection, 'user-selection');
    } catch (error) {
      if (activeTabId) {
        this._restoreFolderSelectionState(activeTabId, previousSelectionState);
        this._restoreActiveFolderFilterSelection(activeTabId, previousSelectionState);
      }
      throw error;
    }
    this._storeActiveSelection();
    this._updateSearchIndicator();
  }

  _notifyActiveTabFolderSelection(selection, context) {
    const tab = this._getActiveTab();
    const handler = tab?.onFolderSelectionChange;
    if (typeof handler !== 'function') return;
    try {
      handler.call(tab, selection);
    } catch (error) {
      let summary = null;
      try { summary = summarizeFolderSelection(selection); } catch (_) {}
      Logger.error('FolderSelection.notifyTab.failed', {
        tab: this._getActiveTabId(),
        context,
        selection: summary,
        error: String(error?.message || error)
      });
      throw error;
    }
  }

  _handleFolderFilterCollapse(collapsed) {
    this._folderFilterCollapsed = collapsed;
    if (this._suppressFolderFilterCollapse) return;
    this._syncFolderFilterShell(this._activeTabSupportsFolderFilter());
  }

  _ensureFolderFilter() {
    if (!this.app.element) return;
    const toggle = this.app.element.querySelector('.fa-nexus-folder-toggle');
    if (!toggle) return;
    const panel = this._folderFilterWindow?.getPanelElement?.() || null;
    this._folderFilter.attach({ panel, toggleButton: toggle });
    this._withCollapseSuppressed(() => {
      this._folderFilter.setCollapsed(this._folderFilterCollapsed, { force: true });
    });
  }

  _ensureFilterWindow() {
    if (this._folderFilterWindow) return this._folderFilterWindow;
    this._folderFilterWindow = new FolderFilterWindow(this);
    return this._folderFilterWindow;
  }

  _syncFolderFilterShell(supports) {
    const shouldShow = supports && !this._folderFilter?.isCollapsed?.();
    if (!shouldShow) {
      if (this._folderFilterWindow?.rendered) {
        try { this._folderFilterWindow.close({ animate: false }); } catch (_) {}
        this._folderFilter.attach({ panel: null, toggleButton: this.app.element?.querySelector('.fa-nexus-folder-toggle') || null });
      }
      this._folderFilter?.setAvailable(supports);
      return;
    }

    const filterWindow = this._ensureFilterWindow();
    if (!filterWindow) return;
    if (typeof this.app?.renderChild !== 'function') {
      Logger.error('FolderFilter.renderChild.unavailable', {
        appId: this.app?.id ?? null,
        windowId: filterWindow.id ?? null
      });
      return;
    }

    const hydrateRenderedWindow = () => {
      this.syncWindowPosition();
      const panel = filterWindow.getPanelElement();
      const toggle = this.app.element?.querySelector('.fa-nexus-folder-toggle') || null;
      if (toggle) this._folderFilter.attach({ panel, toggleButton: toggle });
      this._folderFilter?.setAvailable(supports);
      this._applyActiveTabData();
      try { filterWindow.requestFitToContent?.(); } catch (_) {}
    };

    Promise.resolve(this.app.renderChild(filterWindow)).then(() => {
      hydrateRenderedWindow();
    }).catch((error) => {
      Logger.error('FolderFilter.renderChild.failed', {
        error: String(error?.message || error),
        appId: this.app?.id ?? null,
        windowId: filterWindow.id ?? null
      });
    });

    this.syncWindowPosition();
    const panel = filterWindow.getPanelElement();
    const toggle = this.app.element?.querySelector('.fa-nexus-folder-toggle') || null;
    if (toggle) this._folderFilter.attach({ panel, toggleButton: toggle });
    this._applyActiveTabData();
  }

  _applyActiveTabData() {
    if (!this._folderFilter) return;
    const activeTabId = this._getActiveTabId();
    if (!activeTabId) return;

    const storedSelection = cloneFolderSelection(this._folderFilterSelections.get(activeTabId));
    const rawData = this._folderFilterData.get(activeTabId);
    let selectionToApply = storedSelection || (rawData?.selection ? cloneFolderSelection(rawData.selection) : null);

    try {
      Logger.debug('FolderSelection.apply:start', {
        tab: activeTabId,
        stored: summarizeFolderSelection(storedSelection),
        hasData: !!rawData
      });
    } catch (_) {}

    this._withSelectionStoreSuppressed(() => {
      if (rawData) {
        const data = { ...rawData };
        if (selectionToApply) data.selection = cloneFolderSelection(selectionToApply);
        try {
          Logger.debug('FolderSelection.apply:data', {
            tab: activeTabId,
            selection: summarizeFolderSelection(data.selection)
          });
        } catch (_) {}
        this._folderFilter.setData(data);
        if (selectionToApply) {
          this._folderFilter.setSelection(cloneFolderSelection(selectionToApply), { notify: false });
        }
        rawData.selection = selectionToApply ? cloneFolderSelection(selectionToApply) : null;
      } else {
        if (!selectionToApply) selectionToApply = { type: 'all', includePaths: [], includePathLowers: [] };
        const fallbackClone = cloneFolderSelection(selectionToApply);
        const fallbackLabels = this._getFolderFilterLabels(activeTabId);
        try {
          Logger.debug('FolderSelection.apply:fallback', {
            tab: activeTabId,
            selection: summarizeFolderSelection(fallbackClone)
          });
        } catch (_) {}
        const data = { ...fallbackLabels, paths: [], unassignedCount: 0, selection: fallbackClone };
        this._folderFilter.setData(data);
        if (fallbackClone) {
          this._folderFilter.setSelection(cloneFolderSelection(fallbackClone), { notify: false });
        }
        this._folderFilterData.set(activeTabId, { ...data, selection: cloneFolderSelection(fallbackClone) });
        selectionToApply = fallbackClone;
      }

      if (selectionToApply) {
        const clone = cloneFolderSelection(selectionToApply);
        this._folderFilterSelections.set(activeTabId, clone);
      }
    });
  }

  _storeActiveSelection() {
    if (this._suppressSelectionStore) return;
    const activeTabId = this._getActiveTabId();
    if (!activeTabId) return;

    let snapshot = null;
    const tabSelection = this._getActiveTab()?.getActiveFolderSelection?.();
    if (tabSelection) snapshot = cloneFolderSelection(tabSelection);
    else snapshot = this._folderFilter?.getSelection?.();
    if (!snapshot) return;

    const clone = cloneFolderSelection(snapshot);
    this._folderFilterSelections.set(activeTabId, clone);
    const data = this._folderFilterData.get(activeTabId);
    if (data) data.selection = cloneFolderSelection(snapshot);
    try {
      Logger.debug('FolderSelection.store', {
        tab: activeTabId,
        selection: summarizeFolderSelection(clone)
      });
    } catch (_) {}
  }

  _withSelectionStoreSuppressed(callback) {
    this._suppressSelectionStore = true;
    try {
      callback();
    } finally {
      this._suppressSelectionStore = false;
    }
  }

  _withCollapseSuppressed(callback) {
    this._suppressFolderFilterCollapse = true;
    try {
      callback();
    } finally {
      this._suppressFolderFilterCollapse = false;
    }
  }

  _updateSearchIndicator() {
    try { this.app._searchController?.updateFolderIndicator(); } catch (_) {}
  }

  _activeTabSupportsFolderFilter() {
    const tab = this._getActiveTab();
    return !!tab?.filterItems && (tab.id !== 'prefabs' || !!this.app._collections);
  }

  _getActiveTabId() {
    return this.app._tabManager?.getActiveTabId?.() || this.app._activeTab || null;
  }

  _getActiveTab() {
    return this.app._tabManager?.getActiveTab?.() || this.app._activeTabObj || null;
  }
}
