import { AssetsDataService } from './assets-data-service.js';
import { AssetPlacementManager } from './asset-placement-manager.js';
import { TexturePaintManager } from '../textures/texture-paint-manager.js';
import { PathManager } from '../paths/path-manager.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { collectLocalInventory, getEnabledFolders, mergeLocalAndCloudRecords, NexusContentService } from '../content/nexus-content-service.js';
import { NexusDownloadManager } from '../content/nexus-download-manager.js';
import {
  normalizeFolderSelection,
  enforceFolderSelectionAvailability,
  mergeFolderSelectionExcludes,
  folderSelectionKey,
  logFolderSelection
} from '../content/content-sources/content-sources-utils.js';
import { createEmptyFolderTreeIndex, createFolderTreeIndex } from '../content/folder-tree-index.js';

const SHARED_ASSET_CATALOG = {
  items: null,
  loadPromise: null,
  dirty: false,
  version: 0,
  folderStats: new Map()
};

const SETTINGS_TRIGGERING_RELOAD = new Set(['assetFolders', 'cloudAssetsEnabled']);
const ASSET_TAB_INSTANCES = new Set();
let sharedSettingsHookInstalled = false;

function normalizeMode(requested) {
  const mode = String(requested || 'assets').toLowerCase();
  return ['textures', 'paths'].includes(mode) ? mode : 'assets';
}

function abortError() {
  return new DOMException('Operation aborted', 'AbortError');
}

function invalidateSharedAssetCatalog(reason = 'unknown') {
  SHARED_ASSET_CATALOG.dirty = true;
  SHARED_ASSET_CATALOG.items = null;
  SHARED_ASSET_CATALOG.version += 1;
  SHARED_ASSET_CATALOG.loadPromise = null;
  try { SHARED_ASSET_CATALOG.folderStats.clear(); } catch (_) {}
  for (const tab of ASSET_TAB_INSTANCES) {
    try { tab?._markNeedsReload?.(`settings:${reason}`); } catch (_) {}
  }
}

function ensureSharedSettingsHook() {
  if (sharedSettingsHookInstalled) return;
  const hookApi = globalThis.Hooks;
  if (!hookApi || typeof hookApi.on !== 'function') return;
  hookApi.on('updateSetting', (setting) => {
    try {
      if (!setting || setting.namespace !== 'fa-nexus') return;
      if (!SETTINGS_TRIGGERING_RELOAD.has(setting.key)) return;
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
    this._pathManager = tab._pathManager || null;
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

  get pathManager() {
    return this._pathManager || null;
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
    const result = await loadAssets(this.tab, options);
    // For backward compatibility, return just items if no error, or throw error if present
    if (result.error) {
      throw new Error(result.error);
    }
    return result.items;
  }

  async loadAssetsInternal(options = {}) {
    return loadAssetsInternal(this.tab, options);
  }

  async loadAndMergeCloud(includeLocal, options = {}) {
    const result = await loadAndMergeCloud(this.tab, includeLocal, options);
    // For backward compatibility, return just items if no error, or throw error if present
    if (result.error && !result.partial) {
      throw new Error(result.error);
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
    if (!(controller._pathManager instanceof PathManager)) {
      controller._pathManager = tab._pathManager instanceof PathManager ? tab._pathManager : new PathManager(app);
    }
    tab._pathManager = controller._pathManager;
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

  if (!forceReload && !shared.dirty && Array.isArray(shared.items)) {
    tab._items = shared.items;
    const cachedStats = shared.folderStats.get(tab._mode);
    if (cachedStats) tab._folderStats = cachedStats;
    else {
      computeFolderStats(tab, tab._items);
      shared.folderStats.set(tab._mode, tab._folderStats);
    }
    await tab.applySearchAsync(tab.getCurrentSearchValue());
    if (tab.app?._activeTab === tab.id) {
      try { updateFolderFilter(tab); } catch (_) {}
    }
    return { items: shared.items, error: null, partial: false };
  }

  if (shared.loadPromise) {
    let result = null;
    try {
      result = await shared.loadPromise;
    } catch (e) {
      Logger.warn('AssetsTab.loadAssets.shared.await.failed', { error: String(e?.message || e) });
      // Reset the promise on failure so future calls can retry
      if (shared.loadPromise) {
        shared.loadPromise = null;
        shared.dirty = true;
      }
      return { items: [], error: String(e?.message || e), partial: false };
    }

    const items = Array.isArray(result?.items) ? result.items : [];
    tab._items = items;
    const cachedStats = shared.folderStats.get(tab._mode);
    if (cachedStats) tab._folderStats = cachedStats;
    else {
      computeFolderStats(tab, tab._items);
      shared.folderStats.set(tab._mode, tab._folderStats);
    }
    await tab.applySearchAsync(tab.getCurrentSearchValue());
    if (tab.app?._activeTab === tab.id) {
      try { updateFolderFilter(tab); } catch (_) {}
    }
    if (!forceReload || !shared.dirty) return result || { items, error: null, partial: false };
  }

  shared.dirty = true;
  shared.folderStats.clear();
  const loadPromise = (async () => {
    try {
      await loadAssetsInternal(tab, options);
      const items = Array.isArray(tab._items) ? tab._items : [];
      return { items, error: null, partial: false };
    } catch (error) {
      Logger.warn('AssetsTab.loadAssetsInternal.failed', { error: String(error?.message || error) });
      return { items: [], error: String(error?.message || error), partial: false };
    }
  })();

  shared.loadPromise = loadPromise;
  let result = null;
  try {
    result = await loadPromise;
    if (result.error) {
      shared.dirty = true;
    } else {
      shared.items = result.items;
      shared.dirty = false;
      shared.version += 1;
    }
  } catch (e) {
    result = { items: [], error: String(e?.message || e), partial: false };
    shared.dirty = true;
    Logger.warn('AssetsTab.loadAssets.shared.failed', { error: String(e?.message || e) });
  } finally {
    if (shared.loadPromise === loadPromise) shared.loadPromise = null;
  }

  const finalItems = Array.isArray(result?.items) ? result.items : [];
  tab._items = finalItems;
  computeFolderStats(tab, finalItems);
  shared.folderStats.set(tab._mode, tab._folderStats);
  await tab.applySearchAsync(tab.getCurrentSearchValue());
  if (tab.app?._activeTab === tab.id) {
    try { updateFolderFilter(tab); } catch (_) {}
  }
  return result;
}

async function loadAssetsInternal(tab, _options = {}) {
  const app = tab.app;
  const shared = SHARED_ASSET_CATALOG;
  Logger.info('AssetsTab.loadAssets:start');
  if (!app.rendered || !app.element || !app._grid) return;

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

  const formatCloudLoaderText = (label, count, total) => {
    const safeLabel = String(label || '').trim() || 'Loading Cloud Assets...';
    const safeTotal = Number.isFinite(total) && total > 0 ? Math.max(0, Math.floor(total)) : null;
    const safeCount = Number.isFinite(count) && count >= 0 ? Math.max(0, Math.floor(count)) : null;

    if (safeTotal == null) return safeLabel;
    if (safeCount != null && safeCount > 0) {
      return `${safeLabel} (${safeCount} / ${safeTotal})`;
    }
    return `${safeLabel} (${safeTotal})`;
  };
  const startCloudLoader = async () => {
    const cloudState = await getCloudLoaderState(tab);
    if (!cloudState) return null;
    showGridLoader(formatCloudLoaderText(cloudState.label, cloudState.count, cloudState.total));
    return {
      state: cloudState,
      update: (_count, total) => {
        if (Number.isFinite(total) && total > 0) {
          cloudState.total = Math.max(0, Math.floor(total));
        }
        if (Number.isFinite(_count) && _count >= 0) {
          cloudState.count = Math.max(0, Math.floor(_count));
        }
        const message = formatCloudLoaderText(cloudState.label, cloudState.count, cloudState.total);
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
      await tab.applySearchAsync(tab.getCurrentSearchValue());
      tab.app?.updateFolderFilterSelection?.(tab.id, tab._activeFolderSelection);
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
      loadCached: loadCachedAssets ? (folder) => loadCachedAssets(folder) : async () => [],
      saveIndex: saveAssetsIndex ? (folder, records) => saveAssetsIndex(folder, records) : async () => {},
      streamFolder: streamLocalAssets ? (folder, onBatch, options) => streamLocalAssets(folder, onBatch, options) : async () => {},
      streamOptions: { batchSize: 1500, sleepMs: 8 },
      isCancelled,
      keySelector: (rec) => String(rec?.file_path || rec?.path || rec?.url || ''),
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
      return;
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
          onProgress: (count, total) => cloudLoader?.update?.(count, total),
          onTotal: (total) => cloudLoader?.update?.(cloudLoader.state?.count ?? 0, total)
        });
        if (!isCancelled() && result && Array.isArray(result.items)) {
          hideGridLoader();
          tab._items = result.items;
          computeFolderStats(tab, tab._items);
          SHARED_ASSET_CATALOG.folderStats.set(tab._mode, tab._folderStats);
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
      } catch (e) {
        if (e?.name === 'AbortError') {
          Logger.info('AssetsTab.loadAssets:aborted');
        } else {
          Logger.warn('AssetsTab.cloud.load.error', String(e?.message || e));
        }
        hideGridLoader();
      } finally {
        if (shouldLock) setIndexingLock(tab, false);
      }
    } else {
      hideGridLoader();
      computeFolderStats(tab, tab._items);
      SHARED_ASSET_CATALOG.folderStats.set(tab._mode, tab._folderStats);
      await tab.applySearchAsync(tab.getCurrentSearchValue());
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
    let total = null;
    let indexing = true;
    if (db?.getMeta) {
      const meta = await db.getMeta('assets');
      if (meta) {
        const count = Number(meta.count);
        if (Number.isFinite(count) && count > 0) total = Math.max(0, Math.floor(count));
        if (meta.latest) indexing = false;
      }
    }
    const label = indexing ? 'Indexing cloud assets...' : 'Loading Cloud Assets...';
    return { label, count: null, total, indexing };
  } catch (_) {
    return { label: 'Loading Cloud Assets...', count: null, total: null, indexing: false };
  }
}

async function loadAndMergeCloud(tab, includeLocal, options = {}) {
  if (!isCloudEnabled(tab)) {
    const localItems = includeLocal ? (Array.isArray(tab._items) ? tab._items.slice() : []) : [];
    return { items: localItems, error: null, partial: false };
  }
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const signal = options.signal || null;
  if (signal?.aborted) throw abortError();

  const localItems = includeLocal ? (Array.isArray(tab._items) ? tab._items.slice() : []) : [];
  let cloudItems = [];
  let cloudError = null;
  let partial = false;

  try {
    cloudItems = await loadCloudAssetsSafe(tab, onProgress, signal);
    try { options.onTotal?.(Array.isArray(cloudItems) ? cloudItems.length : 0); } catch (_) {}
    Logger.info('AssetsTab.cloud.items', {
      mode: tab._mode,
      count: Array.isArray(cloudItems) ? cloudItems.length : 0
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    cloudError = String(e?.message || e);
    partial = true;
    Logger.warn('AssetsTab.cloud.load.error', cloudError);
  }

  if (signal?.aborted) throw abortError();

  const svc = tab._controller?.contentService || tab._content || tab.app?._contentService;
  const kind = 'assets';
  const merged = mergeLocalAndCloudRecords({
    kind,
    local: localItems,
    cloud: cloudItems,
    keySelector: (rec) => String(rec?.filename || rec?.file_path || rec?.path || '').replace(/\.[^/.]+$/, '').toLowerCase(),
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
      const eExisting = extRank(existing?.filename || existing?.file_path);
      const eIncoming = extRank(incoming?.filename || incoming?.file_path);
      if (eIncoming > eExisting) return incoming;
      if (eIncoming < eExisting) return existing;
      const lmExisting = Date.parse(existing?.last_modified || existing?.lastModified || '') || 0;
      const lmIncoming = Date.parse(incoming?.last_modified || incoming?.lastModified || '') || 0;
      return lmIncoming >= lmExisting ? incoming : existing;
    },
    onEnhanceLocal: ({ localRecord, cloudRecord }) => {
      if (!svc || !cloudRecord?.filename) return null;
      try {
        const thumb = svc.getThumbnailURL?.(kind, cloudRecord);
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
        Logger.info('AssetsTab.merge', { collisions, preferLocal, preferCloud, enhanced, local: localCount, cloud: cloudCount, merged: mergedCount });
      } catch (_) {}
    }
  });

  Logger.info('AssetsTab.cloud.merge', {
    mode: tab._mode,
    local: localItems.length,
    cloud: cloudItems.length,
    merged: merged.length,
    partial,
    error: cloudError
  });

  return {
    items: merged,
    error: cloudError,
    partial
  };
}

async function loadCloudAssetsSafe(tab, onProgress, signal) {
  if (signal?.aborted) throw abortError();
  try {
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
    Logger.info('AssetsTab.cloud.sync', { mode: tab._mode, kind });
    await svc.sync(kind, {
      signal,
      onManifestProgress: ({ count, total }) => {
        if (signal?.aborted) return;
        try { onProgress?.(count, total); } catch (_) {}
      },
      progressBatch: 500
    });
    const { items } = await svc.list(kind, {
      signal,
      onProgress: (count, total) => {
        if (signal?.aborted) return;
        try { onProgress?.(count, total); } catch (_) {}
      },
      progressBatch: 500
    });
    if (signal?.aborted) throw abortError();
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const it of items) {
      const file_path = String(it.file_path || '');
      if (!file_path) continue;
      const filename = String(it.filename || file_path.split('/').pop() || '');
      const folderPath = resolveFolderPath(tab, { ...it, file_path, filename });
      const rec = {
        ...it,
        filename,
        file_path,
        path: folderPath,
        source: 'cloud',
        tier: (it.tier === 'premium' || it.tier === 'free') ? it.tier : 'free'
      };
      try {
        const download = controller?.downloadManager || tab._download;
        const local = download?.getLocalPath?.('assets', rec);
        if (local) rec.cachedLocalPath = local;
      } catch (_) {}
      out.push(rec);
      if (signal?.aborted) throw abortError();
    }
    return out;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    Logger.warn('AssetsTab.cloud.sync.failed', { error: String(error?.message || error) });
    return [];
  }
}

function matchesMode(tab, item) {
  if (!item) return false;
  if (tab.isTexturesMode) {
    if (typeof tab._isTextureItem === 'function') return tab._isTextureItem(item);
    return item.type === 'texture';
  }
  if (tab.isPathsMode) {
    if (typeof tab._isPathsItem === 'function') return tab._isPathsItem(item);
    return item.type === 'path';
  }
  if (typeof tab._isTextureItem === 'function' && tab._isTextureItem(item)) return false;
  if (typeof tab._isPathsItem === 'function' && tab._isPathsItem(item)) return false;
  return !item.type || item.type === 'asset';
}

function resolveFolderPath(tab, item) {
  if (!item) return '';
  const filePath = String(item.file_path || '');
  const inferredFilename = filePath ? filePath.split('/').pop() : '';
  const filename = String(item.filename || inferredFilename || '');
  const rawPath = String(item.path || '');
  if (rawPath) {
    if (filename && rawPath.endsWith(`/${filename}`)) {
      return rawPath.slice(0, rawPath.length - (filename.length + 1));
    }
    return rawPath;
  }
  if (!filePath) return '';
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash >= 0 ? filePath.slice(0, lastSlash) : '';
}

function normalizeFolderPath(tab, path) {
  if (!path && path !== '') return '';
  const raw = String(path || '');
  const normalized = raw
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .trim();
  return normalized;
}

function getFolderPathInfo(tab, item, hydrate = false) {
  if (!item || typeof item !== 'object') return { normalized: '', lower: '' };
  if (!hydrate && typeof item._faFolderLower === 'string') {
    return {
      normalized: item._faFolderNormalized || '',
      lower: item._faFolderLower
    };
  }
  const basePath = typeof item.path === 'string' ? item.path : resolveFolderPath(tab, item);
  const normalized = normalizeFolderPath(tab, basePath);
  const lower = normalized ? normalized.toLowerCase() : '';
  item._faFolderNormalized = normalized;
  item._faFolderLower = lower;
  return { normalized, lower };
}

function computeFolderStats(tab, items) {
  if (!tab.supportsFolderBrowser?.()) {
    const version = (tab._folderStats?.version || 0) + 1;
    tab._folderStats = {
      pathCounts: [],
      lowerKeys: new Set(),
      unassignedCount: 0,
      tree: createEmptyFolderTreeIndex(version),
      version
    };
    return tab._folderStats;
  }
  const pathCountsMap = new Map();
  const lowerKeys = new Set();
  let unassignedCount = 0;
  for (const item of items) {
    if (!matchesMode(tab, item)) continue;
    const info = getFolderPathInfo(tab, item, true);
    if (info.lower) {
      pathCountsMap.set(info.normalized, (pathCountsMap.get(info.normalized) || 0) + 1);
      lowerKeys.add(info.lower);
    } else {
      unassignedCount += 1;
    }
  }
  const version = (tab._folderStats?.version || 0) + 1;
  const tree = createFolderTreeIndex(pathCountsMap, { version });
  tab._folderStats = {
    pathCounts: pathCountsMap.size ? Array.from(pathCountsMap.entries()) : [],
    lowerKeys,
    unassignedCount,
    tree,
    version
  };
  return tab._folderStats;
}

function getNormalizedFolderPath(tab, item) {
  return getFolderPathInfo(tab, item).lower;
}

function updateFolderFilter(tab) {
  if (!tab.supportsFolderBrowser?.()) return;
  const app = tab.app;
  const stats = tab._folderStats || {
    pathCounts: [],
    lowerKeys: new Set(),
    unassignedCount: 0,
    tree: createEmptyFolderTreeIndex(),
    version: 0
  };
  const baseVersion = Number.isFinite(stats.version) ? Number(stats.version) : 0;
  const tree = (stats.tree && typeof stats.tree === 'object')
    ? stats.tree
    : createFolderTreeIndex(stats.pathCounts || [], { version: baseVersion });
  if (tree && tree.version == null) tree.version = baseVersion;
  const lowerKeys = stats.lowerKeys instanceof Set ? stats.lowerKeys : new Set(stats.lowerKeys || []);
  const availableLowers = lowerKeys.size ? lowerKeys : null;

  const prevSelection = normalizeFolderSelection(tab._activeFolderSelection, {
    normalizePath: (value) => normalizeFolderPath(tab, value)
  });
  const constrainedSelection = enforceFolderSelectionAvailability(prevSelection, {
    availableLowers,
    normalizePath: (value) => normalizeFolderPath(tab, value)
  });
  const nextSelection = mergeFolderSelectionExcludes({
    selection: constrainedSelection,
    previousSelection: prevSelection,
    normalizePath: (value) => normalizeFolderPath(tab, value),
    availableLowers
  }) || { type: 'all', includePaths: [], includePathLowers: [] };

  tab._activeFolderSelection = nextSelection;
  const prevKey = folderSelectionKey(prevSelection);
  const currentKey = folderSelectionKey(nextSelection);

  logFolderSelection('AssetsTab.selection.updateFolderFilter.final', nextSelection, { logger: Logger });

  const modeLabels = {
    assets: { label: 'Asset Folders', allLabel: 'All Assets', unassignedLabel: 'Unsorted' },
    textures: { label: 'Texture Folders', allLabel: 'All Textures', unassignedLabel: 'Unsorted' },
    paths: { label: 'Path Folders', allLabel: 'All Paths', unassignedLabel: 'Unsorted' }
  };
  const labels = modeLabels[tab._mode] || modeLabels.assets;

  try {
    app?.setFolderFilterData?.(tab.id, {
      label: labels.label,
      allLabel: labels.allLabel,
      unassignedLabel: labels.unassignedLabel,
      pathCounts: stats.pathCounts,
      tree,
      totalCount: tree.totalCount,
      unassignedCount: stats.unassignedCount,
      version: stats.version,
      selection: tab._activeFolderSelection
    });
  } catch (_) {}

  if (prevKey !== currentKey) {
    try { app?.updateFolderFilterSelection?.(tab.id, tab._activeFolderSelection); } catch (_) {}
  }
}

function isCloudEnabled(tab) {
  try { return !!game.settings.get('fa-nexus', 'cloudAssetsEnabled'); }
  catch (_) { return true; }
}
