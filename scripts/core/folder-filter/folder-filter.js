import { NexusLogger as Logger } from '../nexus-logger.js';
import {
  normalizeFolderSelection,
  folderSelectionKey,
  enforceFolderSelectionAvailability,
  mergeFolderSelectionExcludes
} from '../../content/content-sources/content-sources-utils.js';
import { ensureFolderTreeIndex } from '../../content/folder-tree-index.js';

const ROOT_KEY = '__ROOT__';
const DEFAULT_ALL_LABEL = 'All Items';
const DEFAULT_HEADER_LABEL = 'Folders';
const DEFAULT_UNASSIGNED_LABEL = 'Unsorted';

/**
 * FolderFilter
 * Lightweight folder navigation tree with collapse/expand behaviour and
 * selection callbacks shared between Tokens and Assets tabs.
 */
export class FolderFilter {
  constructor() {
    this._panel = null;
    this._toggleButton = null;
    this._collapseButton = null;
    this._treeContainer = null;
    this._headerLabel = null;
    this._available = false;
    this._collapsed = true;
    this._structure = [];
    this._pathLookup = new Set();
    this._pathMap = new Map();
    this._nodeMap = new Map();
    this._allNodeEl = null;
    this._unassignedNodeEl = null;
    this._treeVersion = null;
    this._selection = { type: 'all' };
    this._selectionKey = 'all';
    this._expanded = new Set([ROOT_KEY]);
    this._includeSelection = new Set();
    this._excludeSelection = new Set();
    this._dataset = {
      label: DEFAULT_HEADER_LABEL,
      allLabel: DEFAULT_ALL_LABEL,
      unassignedLabel: DEFAULT_UNASSIGNED_LABEL,
      unassignedCount: 0,
      totalCount: 0
    };
    this._boundToggleClick = (event) => this._handleToggleClick(event);
    this._boundTreeClick = (event) => this._handleTreeClick(event);
    this._boundTreeContextMenu = (event) => this._handleTreeContextMenu(event);
    this._selectionHandler = null;
    this._collapseHandler = null;
  }

  /** Attach the browser to current DOM nodes (call on each render) */
  attach({ panel, toggleButton } = {}) {
    const nextPanel = panel || null;
    const nextToggle = toggleButton || null;
    const samePanel = this._panel === nextPanel && this._toggleButton === nextToggle;
    Logger.info('FolderFilter.attach', {
      samePanel,
      hasContainer: !!this._treeContainer,
      containerEmpty: !this._treeContainer?.childElementCount,
      available: this._available
    });
    if (samePanel) {
      this._applyAvailability();
      this._applyCollapsed();
      // Only render if container is empty (avoid unnecessary rebuilds)
      const needsRender = !this._treeContainer?.childElementCount;
      Logger.info('FolderFilter.attach:samePanel', { needsRender });
      if (needsRender) this._render({ structureChanged: true, datasetChanged: true });
      return;
    }
    this._detach();
    this._panel = nextPanel;
    this._toggleButton = nextToggle;
    if (this._panel) {
      this._headerLabel = this._panel.querySelector('.fa-nexus-folder-header .title');
      this._collapseButton = this._panel.querySelector('.fa-nexus-folder-header button[data-action="collapse"]');
      this._treeContainer = this._panel.querySelector('[data-role="folder-tree"]');
      if (this._collapseButton) this._collapseButton.addEventListener('click', this._boundToggleClick);
      if (this._treeContainer) {
        this._treeContainer.addEventListener('click', this._boundTreeClick);
        this._treeContainer.addEventListener('contextmenu', this._boundTreeContextMenu);
      }
    }
    if (this._toggleButton) this._toggleButton.addEventListener('click', this._boundToggleClick);
    this._applyAvailability();
    this._applyCollapsed(true);
    // Only rebuild structure if container is empty
    const needsStructure = !this._treeContainer?.childElementCount;
    Logger.info('FolderFilter.attach:newPanel', { needsStructure });
    this._render({ structureChanged: needsStructure, datasetChanged: true });
  }

  /** Detach listeners from the current DOM (called automatically before attach) */
  _detach() {
    if (this._collapseButton) this._collapseButton.removeEventListener('click', this._boundToggleClick);
    if (this._treeContainer) {
      this._treeContainer.removeEventListener('click', this._boundTreeClick);
      this._treeContainer.removeEventListener('contextmenu', this._boundTreeContextMenu);
    }
    if (this._toggleButton) this._toggleButton.removeEventListener('click', this._boundToggleClick);
    this._panel = null;
    this._toggleButton = null;
    this._collapseButton = null;
    this._treeContainer = null;
    this._headerLabel = null;
    this._allNodeEl = null;
    this._unassignedNodeEl = null;
    this._nodeMap.clear();
    this._includeSelection.clear();
    this._excludeSelection.clear();
  }

  /** Provide a callback when selection changes */
  setSelectionHandler(fn) {
    this._selectionHandler = typeof fn === 'function' ? fn : null;
  }

  /** Provide a callback when collapsed/expanded */
  setCollapseHandler(fn) {
    this._collapseHandler = typeof fn === 'function' ? fn : null;
  }

  /** Persist collapsed state externally (force parameter to reapply classes) */
  setCollapsed(collapsed, { force = false } = {}) {
    const next = !!collapsed;
    if (!force && next === this._collapsed) {
      this._applyCollapsed();
      return;
    }
    this._collapsed = next;
    this._applyCollapsed();
    if (this._collapseHandler) {
      try { this._collapseHandler(this._collapsed); } catch (_) {}
    }
  }

  /** Toggle collapse state */
  toggleCollapsed() {
    if (!this._available) return;
    this.setCollapsed(!this._collapsed);
  }

  /** Enable or disable the browser (hidden when unavailable) */
  setAvailable(available) {
    const next = !!available;
    if (next === this._available) {
      this._applyAvailability();
      return;
    }
    this._available = next;
    if (!this._available) this.setCollapsed(true);
    this._applyAvailability();
    this._render();
  }

  isCollapsed() {
    return !!this._collapsed;
  }

  /**
   * Store dataset (paths, counts, labels) and rebuild tree
   * @param {{label?:string,allLabel?:string,unassignedLabel?:string,paths?:Array<string>,unassignedCount?:number,selection?:object}} data
   */
  setData(data = {}) {
    const normalized = this._normalizeDataset(data);
    const prevDataset = this._dataset;
    const prevStructure = this._structure;
    const prevVersion = this._treeVersion;

    const nextDataset = normalized.dataset;
    const nextStructure = normalized.structure;
    const nextVersion = normalized.treeVersion ?? null;

    const datasetChanged = !this._datasetsEqual(prevDataset, nextDataset);
    const structureChanged = prevStructure !== nextStructure;
    const versionChanged = nextVersion !== prevVersion;

    this._dataset = nextDataset;
    this._structure = nextStructure;
    this._pathLookup = normalized.pathLookup;
    this._pathMap = normalized.pathMap;
    this._treeVersion = nextVersion;
    this._reconcileExpanded();
    if (data && Object.prototype.hasOwnProperty.call(data, 'selection')) {
      this._applySelection(data.selection, false);
    } else {
      this._ensureSelectionValidity();
      this._syncSelectionsFromSelection();
    }
    const needsStructure = versionChanged || structureChanged || !this._treeContainer?.childElementCount;
    this._render({ structureChanged: needsStructure, datasetChanged });
  }

  /** Update only the active selection */
  setSelection(selection, { notify = false } = {}) {
    this._applySelection(selection, notify);
    this._updateExpansionForSelection();
    this._renderSelection();
  }

  /** Return current selection snapshot */
  getSelection() {
    let payload;
    if (this._selection?.type === 'folder') {
      payload = { type: 'folder', path: this._selection.path, pathLower: this._selection.pathLower };
    } else if (this._selection?.type === 'folders') {
      payload = {
        type: 'folders',
        paths: Array.isArray(this._selection.paths) ? this._selection.paths.slice() : [],
        pathLowers: Array.isArray(this._selection.pathLowers) ? this._selection.pathLowers.slice() : []
      };
    } else {
      payload = { type: this._selection?.type || 'all' };
    }

    if (Array.isArray(this._selection?.includePaths) && this._selection.includePaths.length) {
      payload.includePaths = this._selection.includePaths.slice();
    }
    if (Array.isArray(this._selection?.includePathLowers) && this._selection.includePathLowers.length) {
      payload.includePathLowers = this._selection.includePathLowers.slice();
    }
    if (Array.isArray(this._selection?.excludePaths) && this._selection.excludePaths.length) {
      payload.excludePaths = this._selection.excludePaths.slice();
    }
    if (Array.isArray(this._selection?.excludePathLowers) && this._selection.excludePathLowers.length) {
      payload.excludePathLowers = this._selection.excludePathLowers.slice();
    }

    return payload;
  }

  /** Convert selection external form */
  _applySelection(selection, notify) {
    const normalized = this._normalizeSelection(selection);
    const key = this._selectionToKey(normalized);
    const selectionChanged = key !== this._selectionKey;
    try {
      Logger?.debug?.('FolderFilter.applySelection', {
        changed: selectionChanged,
        selection: {
          type: normalized?.type,
          includePaths: Array.isArray(normalized?.includePaths) ? normalized.includePaths.slice() : undefined,
          excludePaths: Array.isArray(normalized?.excludePaths) ? normalized.excludePaths.slice() : undefined
        }
      });
    } catch (_) {}
    this._selection = normalized;
    this._selectionKey = key;
    this._ensureSelectionValidity();
    this._expanded.add(ROOT_KEY);
    this._syncSelectionsFromSelection();
    if (!notify && selectionChanged) this._expandToSelection();
    if (notify && this._selectionHandler) {
      try { this._selectionHandler(this.getSelection()); } catch (_) {}
    }
  }

  _normalizeSelection(selection) {
    let normalized = normalizeFolderSelection(selection, {
      normalizePath: (value) => this._normalizePath(value)
    });
    const preservedExcludePaths = Array.isArray(normalized?.excludePaths) ? normalized.excludePaths.slice() : undefined;
    const preservedExcludeLowers = Array.isArray(normalized?.excludePathLowers) ? normalized.excludePathLowers.slice() : undefined;

    if (normalized.type === 'folder') {
      const lower = String(normalized.pathLower || normalized.path || '').toLowerCase();
      if (lower) {
        const canonical = this._pathMap.get(lower) || normalized.path;
        const normalizedPath = this._normalizePath(canonical) || canonical;
        const canonicalLower = normalizedPath.toLowerCase();
        normalized = {
          type: 'folder',
          path: normalizedPath,
          pathLower: canonicalLower,
          includePaths: [normalizedPath],
          includePathLowers: [canonicalLower]
        };
        if (preservedExcludePaths) normalized.excludePaths = preservedExcludePaths.slice();
        if (preservedExcludeLowers) normalized.excludePathLowers = preservedExcludeLowers.slice();
      }
    } else if (normalized.type === 'folders') {
      const nextPaths = [];
      const nextLowers = [];
      const seen = new Set();
      const count = Math.max(
        Array.isArray(normalized.paths) ? normalized.paths.length : 0,
        Array.isArray(normalized.pathLowers) ? normalized.pathLowers.length : 0
      );
      for (let i = 0; i < count; i += 1) {
        const rawLower = String(normalized.pathLowers?.[i] || normalized.paths?.[i] || '').toLowerCase();
        if (!rawLower || seen.has(rawLower)) continue;
        seen.add(rawLower);
        const canonical = this._pathMap.get(rawLower) || normalized.paths?.[i] || rawLower;
        const normalizedPath = this._normalizePath(canonical) || canonical;
        const canonicalLower = normalizedPath.toLowerCase();
        nextPaths.push(normalizedPath);
        nextLowers.push(canonicalLower);
      }
      if (!nextPaths.length) {
        normalized = { type: 'all', includePaths: [], includePathLowers: [] };
      } else if (nextPaths.length === 1) {
        const path = nextPaths[0];
        const lower = path.toLowerCase();
        normalized = {
          type: 'folder',
          path,
          pathLower: lower,
          includePaths: [path],
          includePathLowers: [lower]
        };
        if (preservedExcludePaths) normalized.excludePaths = preservedExcludePaths.slice();
        if (preservedExcludeLowers) normalized.excludePathLowers = preservedExcludeLowers.slice();
      } else {
        normalized.paths = nextPaths;
        normalized.pathLowers = nextLowers;
        normalized.includePaths = nextPaths.slice();
        normalized.includePathLowers = nextLowers.slice();
        if (preservedExcludePaths) normalized.excludePaths = preservedExcludePaths.slice();
        if (preservedExcludeLowers) normalized.excludePathLowers = preservedExcludeLowers.slice();
      }
    }

    if (Array.isArray(normalized.excludePaths) || Array.isArray(normalized.excludePathLowers)) {
      normalized = mergeFolderSelectionExcludes({
        selection: normalized,
        normalizePath: (value) => this._normalizePath(value),
        availableLowers: this._pathLookup
      }) || normalized;
    }

    if (!normalized.includePaths) normalized.includePaths = [];
    if (!normalized.includePathLowers) normalized.includePathLowers = [];

    return normalized;
  }

  _selectionToKey(selection) {
    return folderSelectionKey(selection);
  }

  _ensureSelectionValidity() {
    const hasPathEntries = this._pathLookup && this._pathLookup.size > 0;
    const hasUnassignedEntries = Number(this._dataset?.unassignedCount || 0) > 0;

    if (!hasPathEntries) {
      // When folder metadata hasn't loaded yet, preserve the current selection
      // so include/exclude filters survive through subsequent data refreshes.
      if (this._selection.type === 'unassigned' && !hasUnassignedEntries) {
        // Keep explicit unassigned filters even if counts are unknown.
        this._selection.includePaths = Array.isArray(this._selection.includePaths) ? this._selection.includePaths : [];
        this._selection.includePathLowers = Array.isArray(this._selection.includePathLowers)
          ? this._selection.includePathLowers
          : [];
      }
      this._selectionKey = folderSelectionKey(this._selection);
      return;
    }

    const enforced = enforceFolderSelectionAvailability(this._selection, {
      availableLowers: this._pathLookup,
      supportsUnassigned: hasUnassignedEntries,
      normalizePath: (value) => this._normalizePath(value)
    });

    const merged = mergeFolderSelectionExcludes({
      selection: enforced,
      previousSelection: this._selection,
      normalizePath: (value) => this._normalizePath(value),
      availableLowers: this._pathLookup
    }) || enforced;

    this._selection = merged;
    if (!Array.isArray(this._selection.includePaths)) this._selection.includePaths = [];
    if (!Array.isArray(this._selection.includePathLowers)) this._selection.includePathLowers = [];
    this._selectionKey = folderSelectionKey(this._selection);
  }

  _datasetsEqual(a, b) {
    if (!a || !b) return false;
    return a.label === b.label
      && a.allLabel === b.allLabel
      && a.unassignedLabel === b.unassignedLabel
      && Number(a.unassignedCount || 0) === Number(b.unassignedCount || 0)
      && Number(a.totalCount || 0) === Number(b.totalCount || 0);
  }

  _normalizeDataset(data) {
    const index = ensureFolderTreeIndex(data);
    const unassignedCount = Math.max(0, Number(data?.unassignedCount) || 0);
    const dataset = {
      label: data?.label ? String(data.label) : DEFAULT_HEADER_LABEL,
      allLabel: data?.allLabel ? String(data.allLabel) : DEFAULT_ALL_LABEL,
      unassignedLabel: data?.unassignedLabel ? String(data.unassignedLabel) : DEFAULT_UNASSIGNED_LABEL,
      unassignedCount,
      totalCount: Math.max(0, Number(index?.totalCount) || 0) + unassignedCount
    };
    const nodes = Array.isArray(index?.nodes) ? index.nodes : [];
    const pathLookup = index?.pathSet instanceof Set
      ? index.pathSet
      : new Set(Array.isArray(index?.pathKeys) ? index.pathKeys.map((value) => String(value || '').toLowerCase()).filter(Boolean) : []);
    const pathMap = index?.pathMap instanceof Map
      ? index.pathMap
      : new Map();
    if (pathMap.size === 0 && nodes.length) {
      const queue = nodes.slice();
      while (queue.length) {
        const node = queue.pop();
        if (!node) continue;
        const lower = typeof node.pathLower === 'string' ? node.pathLower.toLowerCase() : '';
        const path = typeof node.path === 'string' ? node.path : '';
        if (lower && path && !pathMap.has(lower)) pathMap.set(lower, path);
        if (Array.isArray(node.children) && node.children.length) {
          for (const child of node.children) queue.push(child);
        }
      }
    }
    const treeVersion = Number.isFinite(index?.version)
      ? Number(index.version)
      : Number.isFinite(data?.version)
        ? Number(data.version)
        : null;
    return {
      dataset,
      structure: nodes,
      pathLookup,
      pathMap,
      treeVersion
    };
  }

  _normalizePath(value) {
    if (!value && value !== '') return '';
    const raw = String(value || '');
    const normalized = raw
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    return normalized.trim();
  }

  _reconcileExpanded() {
    const next = new Set([ROOT_KEY]);
    if (this._expanded) {
      for (const key of this._expanded) {
        if (key === ROOT_KEY) {
          next.add(ROOT_KEY);
          continue;
        }
        if (this._pathLookup.has(key)) next.add(key);
      }
    }
    this._expanded = next;
  }

  _applyAvailability() {
    const hidden = !this._available;
    if (this._panel) {
      this._panel.classList.toggle('is-hidden', hidden);
      this._panel.setAttribute('aria-hidden', hidden || this._collapsed ? 'true' : 'false');
    }
    if (this._toggleButton) {
      this._toggleButton.classList.toggle('is-hidden', hidden);
      this._toggleButton.disabled = hidden;
      this._toggleButton.setAttribute('aria-hidden', hidden ? 'true' : 'false');
      this._toggleButton.setAttribute('aria-expanded', (!hidden && !this._collapsed) ? 'true' : 'false');
    }
    this._applyFilterIndicator();
  }

  _applyCollapsed(force = false) {
    if (!this._panel) return;
    this._panel.classList.toggle('collapsed', this._collapsed);
    this._panel.setAttribute('aria-hidden', this._collapsed ? 'true' : 'false');
    if (this._toggleButton) {
      this._toggleButton.classList.toggle('is-collapsed', this._collapsed);
      this._toggleButton.setAttribute('aria-expanded', this._collapsed ? 'false' : 'true');
    }
    if (force && this._treeContainer) {
      this._treeContainer.scrollTop = 0;
    }
  }

  _render({ structureChanged = true, datasetChanged = true } = {}) {
    if (!this._panel || !this._treeContainer) return;

    if (structureChanged) {
      if (this._headerLabel) this._headerLabel.textContent = this._dataset.label;
      this._treeContainer.textContent = '';
      this._nodeMap.clear();
      this._allNodeEl = null;
      this._unassignedNodeEl = null;

      const list = document.createElement('ul');
      list.className = 'fa-nexus-folder-filter-list level-0';
      list.setAttribute('role', 'tree');
      list.setAttribute('aria-multiselectable', 'true');
      this._treeContainer.appendChild(list);

      const allItem = this._createListItem({
        nodeType: 'all',
        label: this._dataset.allLabel,
        count: this._dataset.totalCount,
        level: 0,
        expandable: false
      });
      this._allNodeEl = allItem;
      list.appendChild(allItem);

      if (this._dataset.unassignedCount > 0) {
        const unsortedItem = this._createListItem({
          nodeType: 'unassigned',
          label: this._dataset.unassignedLabel,
          count: this._dataset.unassignedCount,
          level: 0,
          expandable: false
        });
        this._unassignedNodeEl = unsortedItem;
        list.appendChild(unsortedItem);
      }

      const treeFragment = document.createDocumentFragment();
      for (const node of this._structure) {
        treeFragment.appendChild(this._renderNode(node));
      }
      list.appendChild(treeFragment);

      if (this._dataset.totalCount === 0) {
        const empty = document.createElement('div');
        empty.className = 'fa-nexus-folder-empty';
        empty.textContent = 'No folders available yet.';
        this._treeContainer.appendChild(empty);
      }
    } else if (datasetChanged) {
      this._updateDatasetUI();
    }

    this._renderSelection();
    this._syncExpansionState();
    this._applyDescendantIndicators();
  }

  _updateDatasetUI() {
    if (this._headerLabel) this._headerLabel.textContent = this._dataset.label;
    if (this._allNodeEl) {
      const labelBtn = this._allNodeEl.querySelector('.label');
      if (labelBtn) labelBtn.textContent = this._dataset.allLabel;
      const countEl = this._allNodeEl.querySelector('.count');
      if (countEl) countEl.textContent = this._formatCount(this._dataset.totalCount);
    }
    if (this._unassignedNodeEl) {
      const labelBtn = this._unassignedNodeEl.querySelector('.label');
      if (labelBtn) labelBtn.textContent = this._dataset.unassignedLabel;
      const countEl = this._unassignedNodeEl.querySelector('.count');
      if (countEl) countEl.textContent = this._formatCount(this._dataset.unassignedCount);
    }
  }

  _renderNode(node) {
    const li = document.createElement('li');
    li.className = 'fa-nexus-folder-node';
    if (node.children.length) li.classList.add('has-children');
    else li.classList.add('is-leaf');
    li.dataset.nodeType = 'folder';
    li.dataset.nodePath = node.path;
    li.dataset.nodeKey = node.pathLower;
    li.dataset.nodeName = node.name;
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String(node.level + 1));

    const row = document.createElement('div');
    row.className = 'fa-nexus-folder-row';
    li.appendChild(row);

    if (node.children.length) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'toggle';
      toggle.setAttribute('data-action', 'toggle');
      toggle.setAttribute('aria-label', 'Expand folder');
      toggle.innerHTML = '<i class="fas fa-caret-right"></i>';
      row.appendChild(toggle);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'toggle-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      row.appendChild(spacer);
    }

    const labelBtn = document.createElement('button');
    labelBtn.type = 'button';
    labelBtn.className = 'label';
    labelBtn.setAttribute('data-action', 'select');
    labelBtn.textContent = node.name;
    row.appendChild(labelBtn);

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = this._formatCount(node.count);
    row.appendChild(count);

    if (node.children.length) {
      const childrenList = document.createElement('ul');
      childrenList.className = 'children';
      for (const child of node.children) {
        childrenList.appendChild(this._renderNode(child));
      }
      li.appendChild(childrenList);
    }

    this._nodeMap.set(node.pathLower, li);
    return li;
  }

  _createListItem({ nodeType, label, count, level, expandable }) {
    const li = document.createElement('li');
    li.className = `fa-nexus-folder-node ${nodeType}`;
    if (expandable) li.classList.add('has-children');
    li.dataset.nodeType = nodeType;
    li.setAttribute('role', nodeType === 'all' ? 'treeitem' : 'treeitem');
    li.setAttribute('aria-level', String(level + 1));
    const row = document.createElement('div');
    row.className = 'fa-nexus-folder-row';
    li.appendChild(row);

    if (expandable) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'toggle';
      toggle.setAttribute('data-action', 'toggle');
      toggle.innerHTML = '<i class="fas fa-caret-right"></i>';
      row.appendChild(toggle);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'toggle-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      row.appendChild(spacer);
    }

    const labelBtn = document.createElement('button');
    labelBtn.type = 'button';
    labelBtn.className = 'label';
    labelBtn.setAttribute('data-action', 'select');
    labelBtn.textContent = label;
    row.appendChild(labelBtn);

    const counter = document.createElement('span');
    counter.className = 'count';
    counter.textContent = this._formatCount(count);
    row.appendChild(counter);
    return li;
  }

  _formatCount(count) {
    const num = Number(count) || 0;
    if (typeof Intl !== 'undefined' && Intl.NumberFormat) {
      try { return new Intl.NumberFormat().format(num); }
      catch (_) { /* ignore */ }
    }
    return String(num);
  }

  /** Update expansion state to show folders relevant to current selection */
  _updateExpansionForSelection() {
    // Start with only root expanded
    this._expanded = new Set([ROOT_KEY]);

    // Auto-expand folders that are part of the current selection
    const pathsToExpand = new Set();

    // Add include paths and their parents
    for (const path of this._includeSelection) {
      this._addPathAndParents(pathsToExpand, path);
    }

    // Add exclude paths and their parents
    for (const path of this._excludeSelection) {
      this._addPathAndParents(pathsToExpand, path);
    }

    // Add single folder selection and its parents
    if (this._selection?.type === 'folder' && this._selection?.path) {
      this._addPathAndParents(pathsToExpand, this._selection.path.toLowerCase());
    }

    // Add multi-folder selection paths and their parents
    if (this._selection?.type === 'folders' && Array.isArray(this._selection?.paths)) {
      for (const path of this._selection.paths) {
        this._addPathAndParents(pathsToExpand, path.toLowerCase());
      }
    }

    // Expand all collected paths
    for (const path of pathsToExpand) {
      this._expanded.add(path);
    }

    // Sync the expansion state to the DOM
    this._syncExpansionState();

    // Update descendant indicators since expansion state changed
    this._applyDescendantIndicators();
  }

  /** Add a path and all its parents to the expansion set */
  _addPathAndParents(expansionSet, path) {
    if (!path || typeof path !== 'string') return;

    const parts = path.split('/').filter(p => p);
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      expansionSet.add(currentPath.toLowerCase());
    }
  }

  _renderSelection() {
    const type = this._selection.type;
    const includeKeys = new Set(Array.from(this._includeSelection.values()));
    const excludeKeys = new Set(Array.from(this._excludeSelection.values()));
    const hasIncludes = includeKeys.size > 0;
    const hasExcludes = excludeKeys.size > 0;

    if (this._allNodeEl) {
      const isActive = type === 'all' && !hasExcludes && !hasIncludes;
      const isPartial = type === 'all' && (hasIncludes || hasExcludes);
      this._allNodeEl.classList.toggle('is-active', isActive);
      this._allNodeEl.classList.toggle('is-partial', isPartial);
      this._allNodeEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    if (this._unassignedNodeEl) {
      const isActive = type === 'unassigned';
      this._unassignedNodeEl.classList.toggle('is-active', isActive);
      this._unassignedNodeEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }

    for (const [key, el] of this._nodeMap.entries()) {
      const normalizedKey = String(key || '').toLowerCase();
      const isIncluded = includeKeys.has(normalizedKey);
      const isExcluded = excludeKeys.has(normalizedKey);
      el.classList.toggle('is-active', isIncluded);
      el.classList.toggle('is-excluded', isExcluded);
      el.setAttribute('aria-selected', isIncluded ? 'true' : 'false');
    }

    this._applyDescendantIndicators();
    this._applyFilterIndicator();
  }

  _syncExpansionState() {
    for (const [key, el] of this._nodeMap.entries()) {
      const expanded = this._expanded.has(key);
      this._setNodeExpanded(el, expanded);
    }
  }

  _isSelectionFiltered() {
    const type = this._selection?.type || 'all';
    if (type !== 'all') return true;
    if (this._includeSelection.size > 0) return true;
    if (this._excludeSelection.size > 0) return true;
    return false;
  }

  _applyFilterIndicator() {
    if (!this._toggleButton) return;
    const filtered = this._isSelectionFiltered();
    this._toggleButton.classList.toggle('is-filtered', filtered);
    this._toggleButton.setAttribute('data-filtered', filtered ? 'true' : 'false');

    const baseLabel = this._toggleButton.getAttribute('data-base-label')
      || this._toggleButton.getAttribute('aria-label')
      || 'Toggle folder browser';
    if (!this._toggleButton.hasAttribute('data-base-label')) {
      this._toggleButton.setAttribute('data-base-label', baseLabel);
    }
    const nextLabel = filtered ? `${baseLabel} (filters active)` : baseLabel;
    this._toggleButton.setAttribute('aria-label', nextLabel);

    const baseTitle = this._toggleButton.getAttribute('data-base-title')
      || this._toggleButton.getAttribute('title')
      || '';
    if (baseTitle && !this._toggleButton.hasAttribute('data-base-title')) {
      this._toggleButton.setAttribute('data-base-title', baseTitle);
    }
    if (baseTitle) {
      const nextTitle = filtered ? `${baseTitle} – filters active` : baseTitle;
      this._toggleButton.setAttribute('title', nextTitle);
    }
  }

  _applyDescendantIndicators() {
    if (!this._nodeMap.size) return;
    const includeKeys = Array.from(this._includeSelection.values());
    const excludeKeys = Array.from(this._excludeSelection.values());

    for (const [key, el] of this._nodeMap.entries()) {
      const normalizedKey = String(key || '').toLowerCase();

      let hasIncludeDescendant = false;
      if (includeKeys.length) {
        for (const includeKey of includeKeys) {
          if (!includeKey || includeKey === normalizedKey) continue;
          if (includeKey.startsWith(`${normalizedKey}/`)) { hasIncludeDescendant = true; break; }
        }
      }

      let hasExcludeDescendant = false;
      if (excludeKeys.length) {
        for (const excludeKey of excludeKeys) {
          if (!excludeKey || excludeKey === normalizedKey) continue;
          if (excludeKey.startsWith(`${normalizedKey}/`)) { hasExcludeDescendant = true; break; }
        }
      }

      el.classList.toggle('has-active-descendant', hasIncludeDescendant);
      el.classList.toggle('has-excluded-descendant', hasExcludeDescendant);
    }
  }

  _expandToSelection() {
    const addCrumbs = (path) => {
      if (!path) return;
      const segments = String(path).split('/');
      let current = '';
      for (const segment of segments) {
        if (!segment) continue;
        current = current ? `${current}/${segment}` : segment;
        this._expanded.add(current.toLowerCase());
      }
    };

    if (this._selection.type === 'folder') {
      addCrumbs(this._selection.path);
    } else if (this._selection.type === 'folders') {
      const paths = Array.isArray(this._selection.paths) ? this._selection.paths : [];
      for (const path of paths) addCrumbs(path);
    }
  }

  _handleToggleClick(event) {
    event.preventDefault();
    this.toggleCollapsed();
  }

  _handleTreeClick(event) {
    const toggle = event.target.closest('button[data-action="toggle"]');
    if (toggle) {
      event.preventDefault();
      const nodeEl = toggle.closest('.fa-nexus-folder-node[data-node-key]');
      if (!nodeEl) return;
      const key = nodeEl.dataset.nodeKey;
      if (!key) return;
      if (this._expanded.has(key)) this._expanded.delete(key);
      else this._expanded.add(key);
      this._setNodeExpanded(nodeEl, this._expanded.has(key));
      this._applyDescendantIndicators();
      return;
    }

    const select = event.target.closest('[data-action="select"]');
    if (select) {
      event.preventDefault();
      const hostNode = select.closest('.fa-nexus-folder-node');
      if (!hostNode) return;
      const type = hostNode.dataset.nodeType || 'folder';
      const wantsExclude = event.altKey && type === 'folder';
      const wantsMulti = !wantsExclude && (event.ctrlKey || event.metaKey) && type === 'folder';
      if (type === 'all') {
        this._applySelection({ type: 'all' }, true);
      } else if (type === 'unassigned') {
        this._applySelection({ type: 'unassigned' }, true);
      } else if (wantsExclude) {
        this._toggleFolderExcludeSelection(hostNode, true);
      } else if (wantsMulti) {
        this._toggleFolderMultiSelection(hostNode, true);
      } else {
        const path = hostNode.dataset.nodePath || '';
        this._applySelection({ type: 'folder', path }, true);
      }
      this._renderSelection();
    }
  }

  _handleTreeContextMenu(event) {
    const nodeEl = event.target.closest('.fa-nexus-folder-node[data-node-key]');
    if (!nodeEl) return;
    if (!nodeEl.classList.contains('has-children')) {
      // allow default context menu for leaf/all/unassigned nodes
      return;
    }
    event.preventDefault();
    const key = nodeEl.dataset.nodeKey;
    if (!key) return;
    const willExpand = !this._expanded.has(key);
    if (willExpand) this._expanded.add(key);
    else this._expanded.delete(key);
    this._setNodeExpanded(nodeEl, willExpand);
    this._applyDescendantIndicators();
  }

  _setNodeExpanded(nodeEl, expanded) {
    if (!nodeEl) return;
    nodeEl.classList.toggle('is-expanded', !!expanded);
    const toggle = nodeEl.querySelector('button[data-action="toggle"]');
    if (toggle) {
      const label = nodeEl.dataset.nodeName || 'folder';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${label}`);
    }
  }

  _syncSelectionsFromSelection() {
    this._includeSelection.clear();
    this._excludeSelection.clear();
    if (this._selection.type === 'folder') {
      const key = String(this._selection.pathLower || '').toLowerCase();
      if (key) this._includeSelection.add(key);
    } else if (this._selection.type === 'folders') {
      const lowers = Array.isArray(this._selection.includePathLowers)
        ? this._selection.includePathLowers
        : Array.isArray(this._selection.pathLowers) ? this._selection.pathLowers : [];
      for (const lower of lowers) {
        if (!lower) continue;
        this._includeSelection.add(String(lower).toLowerCase());
      }
    }

    const excludeLowers = Array.isArray(this._selection.excludePathLowers)
      ? this._selection.excludePathLowers
      : [];
    for (const lower of excludeLowers) {
      if (!lower) continue;
      this._excludeSelection.add(String(lower).toLowerCase());
    }
  }

  _toggleFolderMultiSelection(nodeEl, notify) {
    if (!nodeEl) return;
    const path = this._normalizePath(nodeEl.dataset.nodePath || '');
    const key = String(nodeEl.dataset.nodeKey || '').toLowerCase();
    if (!path || !key) return;

    if (this._includeSelection.has(key)) this._includeSelection.delete(key);
    else this._includeSelection.add(key);

    if (this._includeSelection.has(key) && this._excludeSelection.has(key)) {
      this._excludeSelection.delete(key);
    }

    this._applyFromCollections(notify);
  }

  _toggleFolderExcludeSelection(nodeEl, notify) {
    if (!nodeEl) return;
    const path = this._normalizePath(nodeEl.dataset.nodePath || '');
    const key = String(nodeEl.dataset.nodeKey || '').toLowerCase();
    if (!path || !key) return;

    if (this._excludeSelection.has(key)) this._excludeSelection.delete(key);
    else {
      this._excludeSelection.add(key);
      this._includeSelection.delete(key);
    }

    this._applyFromCollections(notify);
  }

  _applyFromCollections(notify) {
    const selection = this._buildSelectionPayload();
    const exclusion = this._buildExclusionPayload();
    if (exclusion.excludePaths.length) {
      selection.excludePaths = exclusion.excludePaths;
      selection.excludePathLowers = exclusion.excludePathLowers;
    }
    this._applySelection(selection, notify);
  }

  _buildSelectionPayload() {
    if (this._selection.type === 'unassigned' && !this._includeSelection.size && !this._excludeSelection.size) {
      return { type: 'unassigned', includePaths: [], includePathLowers: [] };
    }

    const includeKeys = Array.from(this._includeSelection.values());
    if (!includeKeys.length) {
      return { type: 'all', includePaths: [], includePathLowers: [] };
    }

    const paths = [];
    const lowers = [];
    const seen = new Set();
    for (const lower of includeKeys) {
      if (!lower) continue;
      const normalizedLower = String(lower).toLowerCase();
      if (seen.has(normalizedLower)) continue;
      seen.add(normalizedLower);
      const canonical = this._pathMap.get(normalizedLower) || normalizedLower;
      paths.push(canonical);
      lowers.push(normalizedLower);
    }

    if (paths.length === 1) {
      return {
        type: 'folder',
        path: paths[0],
        pathLower: lowers[0],
        includePaths: paths.slice(),
        includePathLowers: lowers.slice()
      };
    }
    return {
      type: 'folders',
      paths,
      pathLowers: lowers,
      includePaths: paths.slice(),
      includePathLowers: lowers.slice()
    };
  }

  _buildExclusionPayload() {
    const excludeKeys = Array.from(this._excludeSelection.values());
    const excludePaths = [];
    const excludeLowers = [];
    const seen = new Set();
    for (const lower of excludeKeys) {
      if (!lower) continue;
      const normalizedLower = String(lower).toLowerCase();
      if (seen.has(normalizedLower)) continue;
      seen.add(normalizedLower);
      const canonical = this._pathMap.get(normalizedLower) || normalizedLower;
      excludePaths.push(canonical);
      excludeLowers.push(normalizedLower);
    }
    return { excludePaths, excludePathLowers: excludeLowers };
  }
}
