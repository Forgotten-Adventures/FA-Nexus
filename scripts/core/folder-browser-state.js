import {
  normalizeFolderSelection,
  enforceFolderSelectionAvailability,
  mergeFolderSelectionExcludes,
  folderSelectionKey,
  logFolderSelection
} from '../content/content-sources/content-sources-utils.js';
import { createEmptyFolderTreeIndex, createFolderTreeIndex } from '../content/folder-tree-index.js';
import { NexusLogger as Logger } from './nexus-logger.js';

function identityPath(value) {
  return String(value ?? '').trim();
}

function createAllFolderSelection() {
  return { type: 'all', includePaths: [], includePathLowers: [] };
}

function logFolderBrowserFailure(logger, event, error, details = {}) {
  const target = logger || Logger;
  try {
    target.warn?.(event, {
      ...details,
      error
    });
  } catch (_) {
    Logger.warn(event, {
      ...details,
      error
    });
  }
}

export function createEmptyFolderBrowserStats(version = 0) {
  return {
    pathCounts: [],
    lowerKeys: new Set(),
    unassignedCount: 0,
    tree: createEmptyFolderTreeIndex(version),
    version
  };
}

export function readFolderBrowserSelection({
  selection = null,
  normalizePath = identityPath,
  supportsUnassigned = false,
  logger = null,
  loggerLabel = ''
} = {}) {
  const normalized = normalizeFolderSelection(selection, {
    normalizePath,
    supportsUnassigned
  });
  if (loggerLabel) {
    logFolderSelection(loggerLabel, normalized, { logger });
  }
  return normalized;
}

export function applyFolderBrowserSelectionChange({
  app = null,
  tabId = '',
  selection = null,
  normalizePath = identityPath,
  supportsUnassigned = false,
  logger = null,
  loggerLabel = '',
  enabled = true,
  setSelection = null,
  beforeSync = null,
  afterSync = null
} = {}) {
  if (!enabled) return null;

  const normalized = readFolderBrowserSelection({
    selection,
    normalizePath,
    supportsUnassigned,
    logger,
    loggerLabel
  });
  const normalizedTabId = String(tabId || '').trim();

  try { setSelection?.(normalized); } catch (error) {
    logFolderBrowserFailure(logger, 'FolderBrowser.selection.setFailed', error, { tabId: normalizedTabId });
  }
  try { beforeSync?.(normalized); } catch (error) {
    logFolderBrowserFailure(logger, 'FolderBrowser.selection.beforeSyncFailed', error, { tabId: normalizedTabId });
  }
  try { app?.updateFolderFilterSelection?.(normalizedTabId, normalized); } catch (error) {
    logFolderBrowserFailure(logger, 'FolderBrowser.selection.filterSyncFailed', error, { tabId: normalizedTabId });
  }
  try { afterSync?.(normalized); } catch (error) {
    logFolderBrowserFailure(logger, 'FolderBrowser.selection.afterSyncFailed', error, { tabId: normalizedTabId });
  }

  return normalized;
}

function resolveFolderStatsVersion(previousStats) {
  const current = Number(previousStats?.version || 0);
  return Number.isFinite(current) ? current + 1 : 1;
}

export function computeFolderBrowserStats(items, {
  enabled = true,
  previousStats = null,
  includeItem = null,
  getFolderInfo = null
} = {}) {
  const version = resolveFolderStatsVersion(previousStats);
  if (!enabled) return createEmptyFolderBrowserStats(version);

  const pathCountsMap = new Map();
  const lowerKeys = new Set();
  let unassignedCount = 0;
  const include = typeof includeItem === 'function' ? includeItem : () => true;
  const readInfo = typeof getFolderInfo === 'function'
    ? getFolderInfo
    : () => ({ normalized: '', lower: '' });

  for (const item of Array.isArray(items) ? items : []) {
    if (!include(item)) continue;
    const info = readInfo(item) || {};
    if (info.lower) {
      pathCountsMap.set(info.normalized, (pathCountsMap.get(info.normalized) || 0) + 1);
      lowerKeys.add(info.lower);
    } else {
      unassignedCount += 1;
    }
  }

  return {
    pathCounts: pathCountsMap.size ? Array.from(pathCountsMap.entries()) : [],
    lowerKeys,
    unassignedCount,
    tree: createFolderTreeIndex(pathCountsMap, { version }),
    version
  };
}

export function syncFolderBrowserFilterState({
  app = null,
  tabId = '',
  selection = null,
  stats = null,
  normalizePath = identityPath,
  labels = {},
  logger = null,
  loggerLabel = '',
  supportsUnassigned = false,
  onSelectionChanged = null
} = {}) {
  const normalizedTabId = String(tabId || '').trim();
  const safeStats = stats && typeof stats === 'object'
    ? stats
    : createEmptyFolderBrowserStats();
  const baseVersion = Number.isFinite(safeStats.version) ? Number(safeStats.version) : 0;
  const tree = (safeStats.tree && typeof safeStats.tree === 'object')
    ? safeStats.tree
    : createFolderTreeIndex(safeStats.pathCounts || [], { version: baseVersion });
  if (tree && tree.version == null) tree.version = baseVersion;

  const lowerKeys = safeStats.lowerKeys instanceof Set
    ? safeStats.lowerKeys
    : new Set(safeStats.lowerKeys || []);
  const availableLowers = lowerKeys.size ? lowerKeys : null;

  const prevSelection = normalizeFolderSelection(selection, {
    normalizePath,
    supportsUnassigned
  });
  const constrainedSelection = enforceFolderSelectionAvailability(prevSelection, {
    availableLowers,
    supportsUnassigned,
    normalizePath
  });
  const nextSelection = mergeFolderSelectionExcludes({
    selection: constrainedSelection,
    previousSelection: prevSelection,
    normalizePath,
    availableLowers
  }) || createAllFolderSelection();

  const prevKey = folderSelectionKey(prevSelection);
  const currentKey = folderSelectionKey(nextSelection);
  const selectionChanged = currentKey !== prevKey;

  if (loggerLabel) {
    logFolderSelection(loggerLabel, nextSelection, { logger });
  }

  try {
    app?.setFolderFilterData?.(normalizedTabId, {
      label: labels.label || 'Folders',
      allLabel: labels.allLabel || 'All',
      unassignedLabel: labels.unassignedLabel || 'Unsorted',
      pathCounts: Array.isArray(safeStats.pathCounts) ? safeStats.pathCounts : [],
      tree,
      totalCount: tree.totalCount,
      unassignedCount: Number(safeStats.unassignedCount) || 0,
      version: baseVersion,
      selection: nextSelection
    });
  } catch (error) {
    logFolderBrowserFailure(logger, 'FolderBrowser.filterData.setFailed', error, { tabId: normalizedTabId });
  }

  if (selectionChanged) {
    try { app?.updateFolderFilterSelection?.(normalizedTabId, nextSelection); } catch (error) {
      logFolderBrowserFailure(logger, 'FolderBrowser.filterSelection.syncFailed', error, { tabId: normalizedTabId });
    }
    try { onSelectionChanged?.({ nextSelection, prevSelection, stats: safeStats, tree }); } catch (error) {
      logFolderBrowserFailure(logger, 'FolderBrowser.selectionChanged.callbackFailed', error, { tabId: normalizedTabId });
    }
  }

  return {
    nextSelection,
    prevSelection,
    selectionChanged,
    stats: safeStats,
    tree
  };
}
