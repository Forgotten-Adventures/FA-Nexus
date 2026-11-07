import { AssetsDataService } from './assets-data-service.js';
import { AssetPlacementManager } from './asset-placement-manager.js';
import { TexturePaintManager } from '../textures/texture-paint-manager.js';
import { PathManagerV2 } from '../paths/path-manager-v2.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  collectLocalInventory,
  formatOperationalError,
  getEnabledFolders,
  mergeLocalAndCloudRecords,
  NexusContentService
} from '../content/nexus-content-service.js';
import { NexusDownloadManager } from '../content/nexus-download-manager.js';
import {
  contentFilename,
  contentFolder,
  contentPath,
  inventoryItemKey
} from '../content/cloud-inventory-v2.js';
import { normalizeAssetInventoryRecord } from '../content/inventory-utils.js';
import { abortError, formatCatalogLoaderText, isAbortError, loadAndMergeCloudRecords } from '../content/catalog-pipeline.js';
import { readFaNexusCloudEnabledSetting } from '../core/cloud-enabled-settings.js';
import {
  computeFolderBrowserStats,
  createEmptyFolderBrowserStats,
  syncFolderBrowserFilterState
} from '../core/folder-browser-state.js';
import { normalizeFolderPath as normalizeSharedFolderPath } from '../storage/path-utils.js';
import {
  getFolderPathInfo as getSharedFolderPathInfo,
  resolveFolderPathFromRecord
} from '../storage/folder-path-info.js';
import {
  cancelWarmCloudAssetBackgroundWork,
  clearWarmCloudAssetTimer,
  getWarmCloudAssetCacheLatest,
  getWarmCloudAssetRecords as getWarmCloudAssetRecordsFromCache,
  getWarmCloudReuseState,
  invalidateWarmCloudAssetCache as invalidateWarmCloudAssetCacheFromCache,
  normalizeCloudAssetRecord,
  scheduleAssetCloudWarmup as scheduleAssetCloudWarmupFromCache,
  seedWarmCloudAssetCache
} from './asset-cloud-warm-cache.js';

const SHARED_ASSET_CATALOG = {
  items: null,
  mode: null,
  loadPromise: null,
  dirty: false,
  status: 'idle',
  version: 0,
  folderStats: new Map()
};

const SETTINGS_TRIGGERING_RELOAD = new Set(['assetFolders', 'cloudAssetsEnabled']);
const ASSET_TAB_INSTANCES = new Set();
let sharedSettingsHookInstalled = false;

function normalizeMode(requested) {
  const mode = String(requested || 'assets').toLowerCase();
  return ['textures', 'paths', 'buildings'].includes(mode) ? mode : 'assets';
}

function isBuildingsTab(tab) {
  return tab?.id === 'buildings' || tab?._tabId === 'buildings' || tab?._mode === 'buildings';
}

function getCloudAssetClassFilter(tab) {
  if (isBuildingsTab(tab)) return null;
  if (tab?.isTexturesMode) return 'texture';
  if (tab?.isPathsMode) return 'path';
  return 'asset';
}

function getWarmCacheAssetClass(tab) {
  return isBuildingsTab(tab) ? 'buildings' : getCloudAssetClassFilter(tab);
}

function filterCloudAssetsForTab(tab, records) {
  if (!Array.isArray(records)) return [];
  if (isBuildingsTab(tab)) {
    return records.filter((item) => {
      const assetClass = String(item?.asset_class || '').toLowerCase();
      return assetClass === 'path' || assetClass === 'texture';
    });
  }
  const assetClass = getCloudAssetClassFilter(tab);
  return assetClass
    ? records.filter((item) => String(item?.asset_class || 'asset') === assetClass)
    : records;
}

export function invalidateSharedAssetCatalog(reason = 'unknown') {
  SHARED_ASSET_CATALOG.dirty = true;
  SHARED_ASSET_CATALOG.status = 'stale';
  SHARED_ASSET_CATALOG.items = null;
  SHARED_ASSET_CATALOG.mode = null;
  SHARED_ASSET_CATALOG.version += 1;
  SHARED_ASSET_CATALOG.loadPromise = null;
  try { SHARED_ASSET_CATALOG.folderStats.clear(); } catch (_) {}
  for (const tab of ASSET_TAB_INSTANCES) {
    try { tab?._markNeedsReload?.(`settings:${reason}`); } catch (_) {}
  }
}

export function invalidateWarmCloudAssetCache(reason = 'unknown') {
  return invalidateWarmCloudAssetCacheFromCache(reason);
}

export async function getWarmCloudAssetRecords(options = {}) {
  ensureSharedSettingsHook();
  return getWarmCloudAssetRecordsFromCache(options);
}

export function scheduleAssetCloudWarmup({ reason = 'startup' } = {}) {
  ensureSharedSettingsHook();
  return scheduleAssetCloudWarmupFromCache({ reason });
}

function ensureSharedSettingsHook() {
  if (sharedSettingsHookInstalled) return;
  const hookApi = globalThis.Hooks;
  if (!hookApi || typeof hookApi.on !== 'function') return;
  hookApi.on('updateSetting', (setting) => {
    try {
      if (!setting || setting.namespace !== 'fa-nexus') return;
      if (!SETTINGS_TRIGGERING_RELOAD.has(setting.key)) return;
      if (setting.key === 'cloudAssetsEnabled') {
        invalidateWarmCloudAssetCache(setting.key);
        if (setting.value === true) {
          scheduleAssetCloudWarmup({ reason: 'setting-enabled' });
        }
      }
      invalidateSharedAssetCatalog(setting.key);
    } catch (_) {}
  });
  sharedSettingsHookInstalled = true;
}

export class AssetsTabController {
  constructor(tab, options = {}) {
    this.tab = tab;
    this.tab._mode = normalizeMode(options?.mode ?? tab?._mode ?? 'assets');
    ensureSharedSettingsHook();
    ASSET_TAB_INSTANCES.add(tab);
    this._placement = tab._placement || null;
    this._texturePaint = tab._texturePaint || null;
    this._pathManagerV2 = tab._pathManagerV2 || null;
    this._content = tab._content || null;
    this._download = tab._download || null;
    this._assets = tab._assets instanceof AssetsDataService ? tab._assets : new AssetsDataService();
    tab._assets = this._assets;
  }

  dispose() {
    ASSET_TAB_INSTANCES.delete(this.tab);
  }

  get sharedCatalog() {
    return SHARED_ASSET_CATALOG;
  }

  get placementManager() {
    return this._placement || null;
  }

  get texturePaintManager() {
    return this._texturePaint || null;
  }

  get pathManagerV2() {
    return this._pathManagerV2 || null;
  }

  get contentService() {
    return this._content || null;
  }

  get downloadManager() {
    return this._download || null;
  }

  get assetsService() {
    return this._assets;
  }

  markNeedsReload(reason = 'settings') {
    markNeedsReload(this.tab, reason);
  }

  cancelActiveOperations(reason = 'cancelled') {
    cancelActiveOperations(this.tab, reason);
  }

  setIndexingLock(active, message) {
    setIndexingLock(this.tab, active, message);
  }

  async ensureServices() {
    await ensureServices(this.tab);
  }

  async loadAssets(options = {}) {
    try {
      const result = await loadAssets(this.tab, options);
      // For backward compatibility, return just items if no error, or throw error if present
      if (result.error) {
        throw (result.errorObject || new Error(result.error));
      }
      return result.items;
    } catch (error) {
      if (isAbortError(error)) throw error;
      Logger.error('AssetsTab.loadAssets:failed', {
        code: error?.code || null,
        source: error?.source || null,
        settingKey: error?.settingKey || null,
        folder: error?.folder || null,
        error: String(error?.message || error)
      });
      try {
        ui?.notifications?.error?.(formatOperationalError(error, 'Failed to load asset sources.'));
      } catch (_) {}
      throw error;
    }
  }

  async loadAssetsInternal(options = {}) {
    return loadAssetsInternal(this.tab, options);
  }

  async loadAndMergeCloud(includeLocal, options = {}) {
    const result = await loadAndMergeCloud(this.tab, includeLocal, options);
    // For backward compatibility, return just items if no error, or throw error if present
    if (result.error && !result.partial) {
      throw (result.errorObject || new Error(result.error));
    }
    return result.items;
  }

  async loadCloudAssetsSafe(onProgress, signal) {
    return loadCloudAssetsSafe(this.tab, onProgress, signal);
  }

  computeFolderStats(items) {
    return computeFolderStats(this.tab, items);
  }

  updateFolderFilter() {
    return updateFolderFilter(this.tab);
  }

  matchesMode(item) {
    return matchesMode(this.tab, item);
  }

  normalizeFolderPath(path) {
    return normalizeFolderPath(this.tab, path);
  }

  resolveFolderPath(item) {
    return resolveFolderPath(this.tab, item);
  }

  getFolderPathInfo(item, hydrate = false) {
    return getFolderPathInfo(this.tab, item, hydrate);
  }

  getNormalizedFolderPath(item) {
    return getNormalizedFolderPath(this.tab, item);
  }

  isCloudEnabled() {
    return isCloudEnabled(this.tab);
  }
}

function setIndexingLock(tab, active, message = 'Indexing cloud assets...') {
  if (active) {
    tab._indexingLocks = Math.max(0, tab._indexingLocks || 0) + 1;
    try { tab.app?.setTabsLocked?.(true, message); } catch (_) {}
  } else {
    tab._indexingLocks = Math.max(0, (tab._indexingLocks || 0) - 1);
    if (tab._indexingLocks === 0) {
      try { tab.app?.setTabsLocked?.(false); } catch (_) {}
    }
  }
}

function cancelActiveOperations(tab, reason = 'cancelled') {
  cancelInFlight(tab, reason);
}

function cancelInFlight(tab, reason = 'cancelled') {
  tab._loadId = (tab._loadId || 0) + 1;
  if (tab._cloudAbort) {
    try { tab._cloudAbort.abort(reason); } catch (_) {}
    tab._cloudAbort = null;
  }
  setIndexingLock(tab, false);
}

function markNeedsReload(tab, reason = 'settings') {
  tab._needsReload = true;
  try { cancelInFlight(tab, `invalidate:${reason}`); } catch (_) {}
}

async function ensureServices(tab) {
  const app = tab.app;
  const controller = tab._controller || null;
  if (!controller) return;

  if (!tab.isTexturesMode && !tab.isPathsMode) {
    if (!(controller._placement instanceof AssetPlacementManager)) {
      controller._placement = tab._placement instanceof AssetPlacementManager ? tab._placement : new AssetPlacementManager(app);
    }
    tab._placement = controller._placement;
  }

  if (tab.isTexturesMode) {
    if (!(controller._texturePaint instanceof TexturePaintManager)) {
      controller._texturePaint = tab._texturePaint instanceof TexturePaintManager ? tab._texturePaint : new TexturePaintManager(app);
    }
    tab._texturePaint = controller._texturePaint;
  }

  if (tab.isPathsMode) {
    if (!(controller._pathManagerV2 instanceof PathManagerV2)) {
      controller._pathManagerV2 = tab._pathManagerV2 instanceof PathManagerV2 ? tab._pathManagerV2 : new PathManagerV2(app);
    }
    tab._pathManagerV2 = controller._pathManagerV2;
  }

  if (!controller._content) {
    if (tab._content) {
      controller._content = tab._content;
    } else if (app && app._contentService) {
      controller._content = app._contentService;
    } else {
      const authProvider = (app && typeof app._getAuthService === 'function') ? () => app._getAuthService() : undefined;
      controller._content = new NexusContentService({ app: app || null, authService: authProvider });
    }
  }
  tab._content = controller._content;
  try {
    const authProvider = (app && typeof app._getAuthService === 'function') ? () => app._getAuthService() : undefined;
    controller._content?.setAuthContext?.({ app: app || null, authService: authProvider });
  } catch (_) {}

  if (!controller._download) {
    controller._download = tab._download || (app && app._downloadManager) || new NexusDownloadManager();
  }
  tab._download = controller._download;
  try { await controller._download?.initialize?.(); } catch (_) {}

  if (!controller._assets) {
    controller._assets = tab._assets instanceof AssetsDataService ? tab._assets : new AssetsDataService();
  }
  tab._assets = controller._assets;
}

async function loadAssets(tab, options = {}) {
  const shared = SHARED_ASSET_CATALOG;
  const forceReload = !!options.forceReload;
  const mode = normalizeMode(tab._mode);

  if (!forceReload && !shared.dirty && shared.status === 'ready' && shared.mode === mode && Array.isArray(shared.items)) {
    tab._items = shared.items;
    if (typeof tab._injectSolidTextureItem === 'function') {
      tab._items = tab._injectSolidTextureItem(tab._items);
      if (shared.items !== tab._items) shared.items = tab._items;
    }
    const cachedStats = shared.folderStats.get(tab._mode);
    if (cachedStats && !tab.isTexturesMode) {
      tab._folderStats = cachedStats;
    } else {
      computeFolderStats(tab, tab._items);
      shared.folderStats.set(tab._mode, tab._folderStats);
    }
    if (tab.app?._activeTab === tab.id && tab.app?._grid) {
      await tab.applySearchAsync(tab.getCurrentSearchValue());
    }
    if (tab.app?._activeTab === tab.id) {
      try { updateFolderFilter(tab); } catch (_) {}
    }
    return { items: shared.items, error: null, partial: false };
  }

  if (shared.loadPromise && shared.mode === mode) {
    let result = null;
    try {
      result = await shared.loadPromise;
    } catch (e) {
      shared.status = isAbortError(e) ? 'aborted' : 'error';
      Logger.warn('AssetsTab.loadAssets.shared.await.failed', { error: String(e?.message || e) });
      // Reset the promise on failure so future calls can retry
      if (shared.loadPromise) {
        shared.loadPromise = null;
        shared.dirty = true;
      }
      return { items: [], error: String(e?.message || e), partial: false, errorObject: e ?? null };
    }

    const items = Array.isArray(result?.items) ? result.items : [];
    tab._items = items;
    if (typeof tab._injectSolidTextureItem === 'function') {
      tab._items = tab._injectSolidTextureItem(tab._items);
      if (shared.items !== tab._items && shared.items === items) shared.items = tab._items;
    }
    const cachedStats = shared.folderStats.get(tab._mode);
    if (cachedStats && !tab.isTexturesMode) {
      tab._folderStats = cachedStats;
    } else {
      computeFolderStats(tab, tab._items);
      shared.folderStats.set(tab._mode, tab._folderStats);
    }
    if (tab.app?._activeTab === tab.id && tab.app?._grid) {
      await tab.applySearchAsync(tab.getCurrentSearchValue());
    }
    if (tab.app?._activeTab === tab.id) {
      try { updateFolderFilter(tab); } catch (_) {}
    }
    if (result?.aborted) {
      shared.dirty = true;
      shared.status = 'aborted';
    }
    if (!result?.aborted && (!forceReload || !shared.dirty)) return result || { items, error: null, partial: false };
  }

  shared.dirty = true;
  shared.status = 'loading';
  shared.mode = mode;
  shared.folderStats.clear();
  const loadPromise = (async () => {
    try {
      const loadDetail = await loadAssetsInternal(tab, options);
      const items = Array.isArray(tab._items) ? tab._items : [];
      return {
        items,
        error: null,
        partial: false,
        uiReady: !!loadDetail?.uiReady
      };
    } catch (error) {
      if (isAbortError(error)) {
        Logger.info('AssetsTab.loadAssetsInternal.aborted', { mode: tab._mode });
        const fallbackItems = Array.isArray(shared.items) ? shared.items : [];
        return { items: fallbackItems, error: null, partial: false, aborted: true };
      }
      Logger.warn('AssetsTab.loadAssetsInternal.failed', { error: String(error?.message || error) });
      return { items: [], error: String(error?.message || error), partial: false, errorObject: error ?? null };
    }
  })();

  shared.loadPromise = loadPromise;
  let result = null;
  try {
    result = await loadPromise;
    if (result?.aborted) {
      shared.dirty = true;
      shared.status = 'aborted';
    } else if (result.error) {
      shared.dirty = true;
      shared.status = 'error';
    } else if (shared.mode === mode) {
      shared.items = result.items;
      shared.dirty = false;
      shared.status = 'ready';
      shared.version += 1;
    }
  } catch (e) {
    result = { items: [], error: String(e?.message || e), partial: false, errorObject: e ?? null };
    shared.dirty = true;
    shared.status = isAbortError(e) ? 'aborted' : 'error';
    Logger.warn('AssetsTab.loadAssets.shared.failed', { error: String(e?.message || e) });
  } finally {
    if (shared.loadPromise === loadPromise) shared.loadPromise = null;
  }

  const finalItems = Array.isArray(result?.items) ? result.items : [];
  tab._items = finalItems;
  if (typeof tab._injectSolidTextureItem === 'function') {
    tab._items = tab._injectSolidTextureItem(tab._items);
    if (shared.mode === mode && shared.items === finalItems && shared.items !== tab._items) shared.items = tab._items;
  }
  if (!result?.uiReady) {
    computeFolderStats(tab, tab._items);
    shared.folderStats.set(tab._mode, tab._folderStats);
    if (tab.app?._activeTab === tab.id && tab.app?._grid) {
      await tab.applySearchAsync(tab.getCurrentSearchValue());
    }
    if (tab.app?._activeTab === tab.id) {
      try { updateFolderFilter(tab); } catch (_) {}
    }
  }
  return result;
}

async function loadAssetsInternal(tab, _options = {}) {
  const app = tab.app;
  const shared = SHARED_ASSET_CATALOG;
  Logger.info('AssetsTab.loadAssets:start');
  if (!app.rendered || !app.element || !app._grid) throw abortError();

  cancelInFlight(tab, 'restart');

  const loadId = (++tab._loadId);
  const controller = new AbortController();
  tab._cloudAbort = controller;
  const { signal } = controller;
  const isCancelled = () => signal.aborted || loadId !== tab._loadId || !app.rendered || !app.element || !app._grid;

  const showGridLoader = (message) => {
    try { tab.app?.showGridLoader?.(message, { owner: tab.id }); } catch (_) {}
  };
  const hideGridLoader = () => {
    try { tab.app?.hideGridLoader?.(tab.id); } catch (_) {}
  };
  const updateGridLoader = (message) => {
    try { tab.app?.updateGridLoader?.(message, { owner: tab.id }); } catch (_) {}
  };

  const startCloudLoader = async () => {
    const cloudState = await getCloudLoaderState(tab);
    if (!cloudState) return null;
    if (cloudState.warmReady && !cloudState.indexing) {
      Logger.info('AssetsTab.cloud.loader.skip', {
        mode: tab._mode,
        latest: cloudState.latest,
        total: cloudState.total,
        reason: 'warm-cache-ready'
      });
      return null;
    }
    showGridLoader(formatCatalogLoaderText(cloudState.label, cloudState.count, cloudState.total, 'Loading Cloud Assets...'));
    return {
      state: cloudState,
      update: (_count, total, phase = null) => {
        if (phase === 'waiting') cloudState.label = 'Waiting for cloud asset index...';
        else if (phase === 'download') cloudState.label = 'Downloading cloud asset index...';
        else if (phase === 'replaceAll') cloudState.label = 'Indexing cloud assets...';
        if (Number.isFinite(total) && total > 0) {
          cloudState.total = Math.max(0, Math.floor(total));
        }
        if (Number.isFinite(_count) && _count >= 0) {
          cloudState.count = Math.max(0, Math.floor(_count));
        }
        const message = formatCatalogLoaderText(cloudState.label, cloudState.count, cloudState.total, 'Loading Cloud Assets...');
        updateGridLoader(message);
      }
    };
  };

  try {
    await ensureServices(tab);
    const folderSettingKey = 'assetFolders';
    const folders = getEnabledFolders(folderSettingKey);
    Logger.info('AssetsTab.loadAssets:folders', { mode: tab._mode, settingKey: folderSettingKey, count: Array.isArray(folders) ? folders.length : 0, folders });
    if (signal.aborted) throw abortError();

    const hasLocalFolders = Array.isArray(folders) && folders.length > 0;

    if (!hasLocalFolders && !shared.dirty && Array.isArray(shared.items) && shared.items.length) {
      tab._items = shared.items;
      computeFolderStats(tab, tab._items);
      shared.folderStats.set(tab._mode, tab._folderStats);
      updateFolderFilter(tab);
      await tab.applySearchAsync(tab.getCurrentSearchValue());
      return;
    }

    if (!tab._activeFolderSelection || typeof tab._activeFolderSelection !== 'object') {
      tab._activeFolderSelection = { type: 'all', includePaths: [], includePathLowers: [] };
    }

    let localLockActive = false;
    const assets = tab._controller?.assetsService || tab._assets;
    Logger.info('AssetsTab.loadAssets:services', {
      hasAssetsService: !!assets,
      hasLoadCached: !!assets?.loadCachedAssets,
      hasStream: !!assets?.streamLocalAssets
    });
    const loadCachedAssets = assets?.loadCachedAssets?.bind(assets);
    const saveAssetsIndex = assets?.saveAssetsIndex?.bind(assets);
    const streamLocalAssets = assets?.streamLocalAssets?.bind(assets);
    const localResult = hasLocalFolders ? await collectLocalInventory({
      loggerTag: 'AssetsTab.local',
      folders,
      loadCached: loadCachedAssets ? async (folder) => {
        const records = await loadCachedAssets(folder);
        return Array.isArray(records) ? records.map((record) => normalizeAssetInventoryRecord(record)) : records;
      } : async () => [],
      saveIndex: saveAssetsIndex ? (folder, records) => saveAssetsIndex(folder, records) : async () => {},
      streamFolder: streamLocalAssets ? (folder, onBatch, options) => streamLocalAssets(folder, onBatch, options) : async () => {},
      streamOptions: { batchSize: 1500, sleepMs: 8 },
      isCancelled,
      keySelector: (rec) => inventoryItemKey(rec) || contentPath(rec) || '',
      onCachedReady: (cachedItems) => {
        if (isCancelled()) return;
        tab._items = cachedItems;
        if (cachedItems.length) {
          showGridLoader(`Loading assets... (cached ${cachedItems.length})`);
          Logger.info('AssetsTab.cache.ready', { cached: cachedItems.length });
        } else {
          showGridLoader('Indexing local assets... 0');
        }
      },
      onStreamProgress: (count) => {
        if (isCancelled()) return;
        updateGridLoader(`Indexing local assets... ${count}`);
        if (!localLockActive) { setIndexingLock(tab, true, 'Indexing local assets...'); localLockActive = true; }
      }
    }) : {
      cachedItems: [],
      localItems: [],
      streamedCount: 0,
      cancelled: false
    };

    if (localResult.cancelled || isCancelled()) {
      hideGridLoader();
      if (localLockActive) setIndexingLock(tab, false);
      throw abortError();
    }

    tab._items = localResult.localItems;
    computeFolderStats(tab, tab._items);
    Logger.info('AssetsTab.local.complete', {
      cached: localResult.cachedItems.length,
      streamed: localResult.streamedCount,
      total: tab._items.length
    });
    if (localLockActive) setIndexingLock(tab, false);

    const cloudEnabled = isCloudEnabled(tab);
    Logger.info('AssetsTab.loadAssets:cloudCheck', { mode: tab._mode, cloudEnabled });
    if (cloudEnabled) {
      const cloudLoader = await startCloudLoader();
      const shouldLock = !!cloudLoader?.state?.indexing;
      const lockMessage = cloudLoader?.state?.label || 'Indexing cloud assets...';
      if (shouldLock) setIndexingLock(tab, true, lockMessage);
      try {
        const result = await loadAndMergeCloud(tab, hasLocalFolders, {
          signal,
          onProgress: (count, total, phase) => cloudLoader?.update?.(count, total, phase),
          onTotal: (total) => cloudLoader?.update?.(cloudLoader.state?.count ?? 0, total)
        });
        if (result?.error && !result.partial) {
          throw (result.errorObject || new Error(result.error));
        }
        if (!isCancelled() && result && Array.isArray(result.items)) {
          hideGridLoader();
          tab._items = result.items;
          computeFolderStats(tab, tab._items);
          SHARED_ASSET_CATALOG.folderStats.set(tab._mode, tab._folderStats);
          updateFolderFilter(tab);
          await tab.applySearchAsync(tab.getCurrentSearchValue());
          Logger.info('AssetsTab.streaming:done', {
            total: tab._items.length,
            streamed: localResult.streamedCount,
            cloud: result.items.length,
            partial: result.partial,
            error: result.error
          });
          // If there was a partial failure, log a warning
          if (result.partial && result.error) {
            Logger.warn('AssetsTab.cloud.partial', { error: result.error, localCount: result.items.length });
          }
        } else if (signal.aborted) {
          throw abortError();
        } else {
          hideGridLoader();
        }
        return { uiReady: !tab.isTexturesMode };
      } catch (e) {
        hideGridLoader();
        if (isAbortError(e)) {
          Logger.info('AssetsTab.loadAssets:aborted');
          throw e;
        } else {
          Logger.warn('AssetsTab.cloud.load.error', String(e?.message || e));
          throw e;
        }
      } finally {
        if (shouldLock) setIndexingLock(tab, false);
      }
    } else {
      hideGridLoader();
      computeFolderStats(tab, tab._items);
      SHARED_ASSET_CATALOG.folderStats.set(tab._mode, tab._folderStats);
      updateFolderFilter(tab);
      await tab.applySearchAsync(tab.getCurrentSearchValue());
      return { uiReady: !tab.isTexturesMode };
    }
  } finally {
    if (tab._cloudAbort === controller) tab._cloudAbort = null;
    if (signal.aborted) hideGridLoader();
  }
}

async function getCloudLoaderState(tab) {
  try {
    const svc = tab._controller?.contentService || tab._content || tab.app?._contentService;
    const db = svc?._dbAssets;
    const cacheAssetClass = getWarmCacheAssetClass(tab);
    let total = null;
    let indexing = true;
    let latest = null;
    if (db?.getMeta) {
      const meta = await db.getMeta('assets');
      if (meta) {
        const count = Number(meta.count);
        if (Number.isFinite(count) && count > 0) total = Math.max(0, Math.floor(count));
        latest = meta.latest || null;
        if (latest) indexing = false;
      }
    }
    const warm = getWarmCloudReuseState(latest, cacheAssetClass);
    const label = indexing ? 'Preparing cloud asset index...' : 'Loading Cloud Assets...';
    return { label, count: null, total, indexing, latest, warmReady: warm.ready, warmLoading: warm.loading };
  } catch (_) {
    return { label: 'Loading Cloud Assets...', count: null, total: null, indexing: false, latest: null, warmReady: false, warmLoading: false };
  }
}

async function loadAndMergeCloud(tab, includeLocal, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const signal = options.signal || null;
  const localItems = includeLocal ? (Array.isArray(tab._items) ? tab._items.slice() : []) : [];
  const svc = tab._controller?.contentService || tab._content || tab.app?._contentService;
  const kind = 'assets';
  const normalizePathKey = (value) => {
    let raw = String(value || '').trim();
    if (!raw) return '';
    for (let i = 0; i < 3; i += 1) {
      try {
        const decoded = decodeURIComponent(raw);
        if (!decoded || decoded === raw) break;
        raw = decoded;
      } catch (_) {
        break;
      }
    }
    return raw
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+/, '');
  };
  const baseNameKey = (rec) => {
    if (!rec) return '';
    const filename = contentFilename(rec);
    let raw = filename;
    if (!raw) {
      raw = normalizePathKey(contentPath(rec) || rec?.id || '');
      if (raw) {
        const parts = raw.split('/');
        raw = parts[parts.length - 1] || '';
      }
    }
    if (!raw) return '';
    return raw.replace(/\.[^/.]+$/, '').toLowerCase();
  };
  const pathKey = (rec) => {
    const raw = normalizePathKey(rec?.id || contentPath(rec) || '');
    if (!raw) return '';
    return raw.replace(/\.[^/.]+$/, '').toLowerCase();
  };
  const enhanceLocalRecord = (localRecord, cloudRecord) => {
    if (!svc || !contentFilename(cloudRecord)) return localRecord;
    try {
      const thumb = svc.getThumbnailURL?.(kind, cloudRecord);
      if (!thumb) return localRecord;
      if (String(localRecord.thumbnail_url || contentPath(localRecord) || '').includes(thumb)) return localRecord;
      return {
        ...localRecord,
        original_thumbnail: contentPath(localRecord) || localRecord.thumbnail_url,
        thumbnail_url: thumb,
        enhanced_thumbnail: true,
        cloud_tier: cloudRecord.tier
      };
    } catch (_) {
      return localRecord;
    }
  };
  const resolvePathMatchedCloud = (localRecord, candidates) => {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    const localPath = pathKey(localRecord);
    if (!localPath) return null;
    const exact = [];
    const suffix = [];
    for (const candidate of candidates) {
      const candidatePath = pathKey(candidate);
      if (!candidatePath) continue;
      if (localPath === candidatePath) {
        exact.push(candidate);
        continue;
      }
      if (localPath.endsWith(`/${candidatePath}`)) {
        suffix.push(candidate);
      }
    }
    const selectBest = (matches) => {
      if (!matches.length) return null;
      if (matches.length === 1) return matches[0];
      const ranked = matches
        .map((record) => ({ record, key: pathKey(record) }))
        .filter((entry) => !!entry.key)
        .sort((a, b) => b.key.length - a.key.length);
      if (!ranked.length) return null;
      if (ranked.length === 1) return ranked[0].record;
      return ranked[0].key.length > ranked[1].key.length ? ranked[0].record : null;
    };
    return selectBest(exact) || selectBest(suffix);
  };
  const matchedCloudKeys = new Set();
  let matchedLocalCount = 0;
  let enhancedLocalCount = 0;
  let cloudSource = 'unknown';
  let usedWarmCache = false;
  let latest = null;
  const result = await loadAndMergeCloudRecords({
    cloudEnabled: isCloudEnabled(tab),
    localItems,
    signal,
    fetchCloud: () => fetchCloudAssets(tab, onProgress, signal),
    onTotal: options.onTotal,
    onCloudItems: (cloudItems, cloudResult) => {
      cloudSource = String(cloudResult?.source || 'unknown');
      usedWarmCache = !!cloudResult?.usedWarmCache;
      latest = cloudResult?.latest || null;
      Logger.info('AssetsTab.cloud.items', {
        mode: tab._mode,
        count: Array.isArray(cloudItems) ? cloudItems.length : 0,
        source: cloudSource,
        usedWarmCache
      });
    },
    onCloudError: (cloudError) => {
      Logger.warn('AssetsTab.cloud.load.error', cloudError);
    },
    mergeItems: ({ localItems: nextLocalItems, cloudItems }) => {
      if (!Array.isArray(nextLocalItems) || !nextLocalItems.length) {
        Logger.info('AssetsTab.merge.cloudOnly', {
          mode: tab._mode,
          cloud: Array.isArray(cloudItems) ? cloudItems.length : 0,
          source: cloudSource,
          usedWarmCache
        });
        return Array.isArray(cloudItems) ? cloudItems : [];
      }
      const cloudByBase = new Map();
      for (const rec of cloudItems) {
        const base = baseNameKey(rec);
        if (!base) continue;
        const list = cloudByBase.get(base) || [];
        list.push(rec);
        cloudByBase.set(base, list);
      }
      const enhancedLocalItems = nextLocalItems.map((localRecord) => {
        const base = baseNameKey(localRecord);
        if (!base) return localRecord;
        const cloudRecord = resolvePathMatchedCloud(localRecord, cloudByBase.get(base) || []);
        if (!cloudRecord) return localRecord;
        const cloudPath = pathKey(cloudRecord);
        if (cloudPath) matchedCloudKeys.add(cloudPath);
        matchedLocalCount += 1;
        const enhanced = enhanceLocalRecord(localRecord, cloudRecord);
        if (enhanced !== localRecord) enhancedLocalCount += 1;
        return enhanced;
      });
      const remainingCloudItems = cloudItems.filter((cloudRecord) => {
        const cloudPath = pathKey(cloudRecord);
        if (!cloudPath) return true;
        return !matchedCloudKeys.has(cloudPath);
      });
      return mergeLocalAndCloudRecords({
        kind,
        local: enhancedLocalItems,
        cloud: remainingCloudItems,
        keySelector: (rec) => {
          const base = baseNameKey(rec);
          const source = String(rec?.source || '').toLowerCase();
          const pKey = pathKey(rec);
          if (source === 'local') {
            if (pKey) return `local:${pKey}`;
            return base ? `local:${base}` : '';
          }
          if (pKey) return `cloud:${pKey}`;
          return base ? `cloud:${base}` : '';
        },
        choosePreferred: (existing, incoming) => {
          const rank = (it) => {
            if (!it) return 0;
            if (it.source === 'local') return 3;
            if (it.source === 'cloud' && (it.cachedLocalPath || it.cached || it.isCached)) return 2;
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
          const eExisting = extRank(contentFilename(existing) || contentPath(existing));
          const eIncoming = extRank(contentFilename(incoming) || contentPath(incoming));
          if (eIncoming > eExisting) return incoming;
          if (eIncoming < eExisting) return existing;
          const lmExisting = Date.parse(existing?.selected_source?.mtime || existing?.updated || existing?.lastModified || '') || 0;
          const lmIncoming = Date.parse(incoming?.selected_source?.mtime || incoming?.updated || incoming?.lastModified || '') || 0;
          return lmIncoming >= lmExisting ? incoming : existing;
        },
        onStats: ({ collisions, preferLocal, preferCloud, enhanced, localCount, cloudCount, mergedCount }) => {
          try {
            Logger.info('AssetsTab.merge', {
              collisions,
              preferLocal,
              preferCloud,
              enhanced,
              matchedLocalCount,
              shadowedCloudItems: matchedCloudKeys.size,
              enhancedLocalCount,
              local: localCount,
              cloud: cloudCount,
              merged: mergedCount
            });
          } catch (_) {}
        }
      });
    },
    onResult: (result, detail) => {
      Logger.info('AssetsTab.cloud.merge', {
        mode: tab._mode,
        local: detail.localItems.length,
        cloud: detail.cloudItems.length,
        merged: result.items.length,
        partial: result.partial,
        error: result.error
      });
    }
  });
  return {
    ...result,
    cloudSource,
    usedWarmCache,
    latest
  };
}

async function fetchCloudAssets(tab, onProgress, signal) {
  if (signal?.aborted) throw abortError();
  clearWarmCloudAssetTimer();
  await ensureServices(tab);
  const controller = tab._controller;
  let svc = controller?.contentService || tab._content;
  if (!svc) {
    const app = tab.app || null;
    const authProvider = (app && typeof app._getAuthService === 'function') ? () => app._getAuthService() : undefined;
    svc = new NexusContentService({ app, authService: authProvider });
    if (controller) controller._content = svc;
    tab._content = svc;
  } else {
    try {
      const app = tab.app || null;
      const authProvider = (app && typeof app._getAuthService === 'function') ? () => app._getAuthService() : undefined;
      svc?.setAuthContext?.({ app, authService: authProvider });
    } catch (_) {}
  }

  const kind = 'assets';
  const requestedAssetClass = getCloudAssetClassFilter(tab);
  const cacheAssetClass = getWarmCacheAssetClass(tab);
  const filterForMode = (records) => filterCloudAssetsForTab(tab, records);
  let hadCachedIndex = false;
  let syncError = null;
  let syncErrorObject = null;
  let latest = null;
  try {
    const meta = await svc.getMeta?.(kind);
    hadCachedIndex = !!meta?.latest;
    latest = meta?.latest || null;
  } catch (_) {}

  if (latest) {
    const warm = getWarmCloudReuseState(latest, cacheAssetClass);
    if (warm.ready || warm.loading) {
      try {
        const warmItems = await getWarmCloudAssetRecords({
          signal,
          priority: 'interactive',
          expectedLatest: latest,
          createIfMissing: false,
          service: svc,
          assetClass: cacheAssetClass
        });
        if (Array.isArray(warmItems)) {
          const filteredWarmItems = filterForMode(warmItems);
          Logger.info('AssetsWarmup.cache.hit', {
            latest,
            count: filteredWarmItems.length,
            priority: 'interactive',
            stage: 'pre-sync'
          });
          return {
            items: filteredWarmItems,
            error: null,
            partial: false,
            source: 'warm-cache',
            usedWarmCache: true,
            latest
          };
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        Logger.warn('AssetsWarmup.cache.reuse.failed', {
          latest,
          stage: 'pre-sync',
          error: String(error?.message || error)
        });
      }
    }
  }

  cancelWarmCloudAssetBackgroundWork('foreground-cloud-sync');
  Logger.info('AssetsTab.cloud.sync', { mode: tab._mode, kind, hadCachedIndex });
  try {
    await svc.sync(kind, {
      signal,
      onManifestProgress: ({ phase, count, total }) => {
        if (signal?.aborted) return;
        try { onProgress?.(count, total, phase); } catch (_) {}
      },
      progressBatch: 500
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw abortError();
    syncError = String(error?.message || error);
    syncErrorObject = error ?? null;
    Logger.warn('AssetsTab.cloud.sync.failed', { error: syncError, hadCachedIndex });
  }

  try {
    const meta = await svc.getMeta?.(kind);
    latest = meta?.latest || null;
  } catch (_) {}

  const warmCacheLatest = getWarmCloudAssetCacheLatest();
  if (latest && warmCacheLatest && warmCacheLatest !== latest) {
    invalidateWarmCloudAssetCache(`latest:${warmCacheLatest}->${latest}`);
  }

  if (signal?.aborted) throw abortError();
  try {
    const warmItems = latest ? await getWarmCloudAssetRecords({
      signal,
      priority: 'interactive',
      expectedLatest: latest,
      createIfMissing: true,
      service: svc,
      assetClass: cacheAssetClass
    }) : null;
    if (Array.isArray(warmItems)) {
      return {
        items: filterForMode(warmItems),
        error: syncError,
        errorObject: syncErrorObject,
        partial: !!syncError && (hadCachedIndex || warmItems.length > 0),
        source: 'warm-cache',
        usedWarmCache: true,
        latest
      };
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    Logger.warn('AssetsWarmup.cache.reuse.failed', { latest, error: String(error?.message || error) });
  }

  let items = [];
  try {
    const result = await svc.list(kind, {
      signal,
      assetClass: requestedAssetClass,
      onProgress: (count, total) => {
        if (signal?.aborted) return;
        try { onProgress?.(count, total); } catch (_) {}
      },
      progressBatch: 500
    });
    items = Array.isArray(result?.items) ? result.items : [];
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw abortError();
    const listError = String(error?.message || error);
    if (syncError) {
      throw new Error(`Cloud asset sync failed (${syncError}); cached index unavailable (${listError})`);
    }
    throw error;
  }

  if (signal?.aborted) throw abortError();
  const out = [];
  for (const it of items) {
    const rec = normalizeCloudAssetRecord(it);
    if (!rec) continue;
    try {
      const download = controller?.downloadManager || tab._download;
      const local = download?.getLocalPath?.('assets', rec);
      if (local) rec.cachedLocalPath = local;
    } catch (_) {}
    out.push(rec);
    if (signal?.aborted) throw abortError();
  }

  seedWarmCloudAssetCache({ latest, items: out, reason: 'foreground-cloud-list', assetClass: cacheAssetClass });

  return {
    items: out,
    error: syncError,
    errorObject: syncErrorObject,
    partial: !!syncError && (hadCachedIndex || out.length > 0),
    source: 'cloud-list',
    usedWarmCache: false,
    latest
  };
}

async function loadCloudAssetsSafe(tab, onProgress, signal) {
  const result = await fetchCloudAssets(tab, onProgress, signal);
  return Array.isArray(result?.items) ? result.items : [];
}

function matchesMode(tab, item) {
  if (!item) return false;
  const assetClass = String(item.asset_class || '').toLowerCase();
  if (tab.isTexturesMode) {
    if (assetClass) return assetClass === 'texture';
    if (typeof tab._isTextureItem === 'function') return tab._isTextureItem(item);
    return item.type === 'texture';
  }
  if (tab.isPathsMode) {
    if (assetClass) return assetClass === 'path';
    if (typeof tab._isPathsItem === 'function') return tab._isPathsItem(item);
    return item.type === 'path';
  }
  if (assetClass) return assetClass === 'asset';
  if (typeof tab._isTextureItem === 'function' && tab._isTextureItem(item)) return false;
  if (typeof tab._isPathsItem === 'function' && tab._isPathsItem(item)) return false;
  return !item.type || item.type === 'asset';
}

function resolveFolderPath(tab, item) {
  return contentFolder(item) || resolveFolderPathFromRecord(item);
}

function normalizeFolderPath(tab, path) {
  return normalizeSharedFolderPath(path);
}

function getFolderPathInfo(tab, item, hydrate = false) {
  const folder = contentFolder(item);
  if (folder) {
    const normalized = normalizeFolderPath(tab, folder);
    return {
      raw: folder,
      normalized,
      lower: normalized.toLowerCase(),
      path: normalized,
      hydrated: !!hydrate
    };
  }
  return getSharedFolderPathInfo(item, { hydrate });
}

function computeFolderStats(tab, items) {
  const skipSolid = tab?.isTexturesMode && typeof tab._isSolidTextureItem === 'function';
  tab._folderStats = computeFolderBrowserStats(items, {
    enabled: !!tab.supportsFolderBrowser?.(),
    previousStats: tab._folderStats,
    includeItem: (item) => {
      if (!tab._matchesMode(item)) return false;
      if (skipSolid && tab._isSolidTextureItem(item)) return false;
      return true;
    },
    getFolderInfo: (item) => getFolderPathInfo(tab, item, true)
  });
  return tab._folderStats;
}

function getNormalizedFolderPath(tab, item) {
  return getFolderPathInfo(tab, item).lower;
}

function updateFolderFilter(tab) {
  if (!tab.supportsFolderBrowser?.()) return;
  const modeLabels = {
    assets: { label: 'Asset Folders', allLabel: 'All Assets', unassignedLabel: 'Unsorted' },
    textures: { label: 'Texture Folders', allLabel: 'All Textures', unassignedLabel: 'Unsorted' },
    paths: { label: 'Path Folders', allLabel: 'All Paths', unassignedLabel: 'Unsorted' },
    buildings: { label: 'Building Folders', allLabel: 'All Building Materials', unassignedLabel: 'Unsorted' }
  };
  const labels = modeLabels[tab._mode] || modeLabels.assets;
  const result = syncFolderBrowserFilterState({
    app: tab.app,
    tabId: tab.id,
    selection: tab._activeFolderSelection,
    stats: tab._folderStats || createEmptyFolderBrowserStats(),
    normalizePath: (value) => normalizeFolderPath(tab, value),
    labels,
    logger: Logger,
    loggerLabel: 'AssetsTab.selection.updateFolderFilter.final'
  });
  tab._activeFolderSelection = result.nextSelection;
}

function isCloudEnabled(tab) {
  return readFaNexusCloudEnabledSetting({
    setting: 'cloudAssetsEnabled',
    warningKey: 'AssetsTab.cloudEnabled.readFailed',
    context: { tabId: tab?.id || '' }
  });
}
