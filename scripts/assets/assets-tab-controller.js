import { AssetsDataService } from './assets-data-service.js';
import { AssetPlacementManager } from './asset-placement-manager.js';
import { TexturePaintManager } from '../textures/texture-paint-manager.js';
import { PathManager } from '../paths/path-manager.js';
import { PathManagerV2 } from '../paths/path-manager-v2.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { collectLocalInventory, getEnabledFolders, mergeLocalAndCloudRecords, NexusContentService } from '../content/nexus-content-service.js';
import { NexusDownloadManager } from '../content/nexus-download-manager.js';
import { abortError, formatCatalogLoaderText, isAbortError, loadAndMergeCloudRecords } from '../content/catalog-pipeline.js';
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
  status: 'idle',
  version: 0,
  folderStats: new Map()
};

const SHARED_ASSET_CLOUD_WARM_CACHE = {
  items: null,
  latest: null,
  loadPromise: null,
  status: 'idle',
  error: null,
  mode: 'idle',
  abortController: null,
  timer: null,
  generation: 0
};

const SETTINGS_TRIGGERING_RELOAD = new Set(['assetFolders', 'cloudAssetsEnabled']);
const ASSET_TAB_INSTANCES = new Set();
let sharedSettingsHookInstalled = false;
let sharedWarmupContentService = null;

function normalizeMode(requested) {
  const mode = String(requested || 'assets').toLowerCase();
  return ['textures', 'paths'].includes(mode) ? mode : 'assets';
}

function clearWarmCloudAssetTimer() {
  if (!SHARED_ASSET_CLOUD_WARM_CACHE.timer) return;
  try { clearTimeout(SHARED_ASSET_CLOUD_WARM_CACHE.timer); } catch (_) {}
  SHARED_ASSET_CLOUD_WARM_CACHE.timer = null;
}

function shouldWarmAssetCloud() {
  if (!game?.user?.isGM) return false;
  try {
    if (!game?.settings?.get?.('fa-nexus', 'cloudAssetsEnabled')) return false;
  } catch (_) {
    return false;
  }
  if (typeof navigator !== 'undefined' && navigator?.onLine === false) return false;
  return true;
}

function getSharedWarmupContentService() {
  if (!(sharedWarmupContentService instanceof NexusContentService)) {
    sharedWarmupContentService = new NexusContentService();
  }
  return sharedWarmupContentService;
}

function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (!signal) return;
      try { signal.removeEventListener('abort', onAbort); } catch (_) {}
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    try { signal.addEventListener('abort', onAbort, { once: true }); } catch (_) {}
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }).catch((error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function scheduleWarmCloudYield(mode = 'idle') {
  return new Promise((resolve) => {
    if (mode === 'interactive') {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
      return;
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 50 });
      return;
    }
    setTimeout(resolve, 16);
  });
}

function getWarmCloudReuseState(latest = null) {
  const cache = SHARED_ASSET_CLOUD_WARM_CACHE;
  const expectedLatest = String(latest || '').trim();
  if (!expectedLatest) return { ready: false, loading: false, latest: null };
  return {
    ready: cache.status === 'ready' && cache.latest === expectedLatest && Array.isArray(cache.items),
    loading: cache.latest === expectedLatest && !!cache.loadPromise,
    latest: cache.latest
  };
}

function invalidateSharedAssetCatalog(reason = 'unknown') {
  SHARED_ASSET_CATALOG.dirty = true;
  SHARED_ASSET_CATALOG.status = 'stale';
  SHARED_ASSET_CATALOG.items = null;
  SHARED_ASSET_CATALOG.version += 1;
  SHARED_ASSET_CATALOG.loadPromise = null;
  try { SHARED_ASSET_CATALOG.folderStats.clear(); } catch (_) {}
  for (const tab of ASSET_TAB_INSTANCES) {
    try { tab?._markNeedsReload?.(`settings:${reason}`); } catch (_) {}
  }
}

export function invalidateWarmCloudAssetCache(reason = 'unknown') {
  const cache = SHARED_ASSET_CLOUD_WARM_CACHE;
  clearWarmCloudAssetTimer();
  cache.generation += 1;
  const controller = cache.abortController;
  cache.abortController = null;
  cache.loadPromise = null;
  cache.items = null;
  cache.latest = null;
  cache.error = null;
  cache.mode = 'idle';
  cache.status = 'stale';
  if (controller) {
    try { controller.abort(`invalidate:${reason}`); } catch (_) {}
  }
  Logger.info('AssetsWarmup.invalidate', { reason });
}

function normalizeCloudAssetRecord(record) {
  if (!record) return null;
  const file_path = String(record.file_path || '').trim();
  if (!file_path) return null;
  const filename = String(record.filename || file_path.split('/').pop() || '').trim();
  const path = resolveFolderPath(null, { ...record, file_path, filename });
  return {
    ...record,
    filename,
    file_path,
    path,
    source: 'cloud',
    tier: (record.tier === 'premium' || record.tier === 'free') ? record.tier : 'free'
  };
}

async function materializeWarmCloudAssetRecords(cache, { latest, service, controller, generation }) {
  const svc = service || getSharedWarmupContentService();
  const db = svc?._dbAssets;
  if (!db?.streamAll) throw new Error('Cloud asset database unavailable');
  const items = [];
  let processed = 0;
  let lastLogged = 0;
  const signal = controller?.signal || null;
  const now = () => (globalThis.performance?.now?.() ?? Date.now());

  await db.streamAll('assets', {
    signal,
    preferChunks: true,
    onChunk: async (records, info = {}) => {
      let index = 0;
      while (index < records.length) {
        if (signal?.aborted) throw abortError();
        const sliceStart = now();
        let sliceCount = 0;
        while (index < records.length && sliceCount < 500) {
          if (sliceCount > 0 && (now() - sliceStart) >= 8) break;
          const normalized = normalizeCloudAssetRecord(records[index]);
          index += 1;
          if (!normalized) continue;
          items.push(normalized);
          processed += 1;
          sliceCount += 1;
        }
        if ((processed - lastLogged) >= 5000) {
          lastLogged = processed;
          Logger.info('AssetsWarmup.records.processed', {
            latest,
            count: processed,
            mode: cache.mode,
            sourceMode: info.mode || 'unknown'
          });
        }
        if (index < records.length) {
          await scheduleWarmCloudYield(cache.mode);
        }
      }
    }
  });

  Logger.info('AssetsWarmup.records.processed', {
    latest,
    count: processed,
    mode: cache.mode,
    complete: true
  });

  if (cache.generation !== generation) {
    return Array.isArray(cache.items) ? cache.items : items;
  }
  return items;
}

async function startWarmCloudAssetMaterialization({
  expectedLatest,
  priority = 'idle',
  signal = null,
  service = null,
  controller = null,
  generation = null
} = {}) {
  const cache = SHARED_ASSET_CLOUD_WARM_CACHE;
  if (signal?.aborted) throw abortError();
  if (!expectedLatest) return null;
  const safePriority = priority === 'interactive' ? 'interactive' : 'idle';
  const nextGeneration = Number.isFinite(generation) ? generation : (cache.generation + 1);
  if (!Number.isFinite(generation)) cache.generation = nextGeneration;
  const activeController = controller || new AbortController();

  cache.items = null;
  cache.latest = expectedLatest;
  cache.error = null;
  cache.mode = safePriority;
  cache.status = 'loading';
  cache.abortController = activeController;

  let loadPromise = null;
  loadPromise = (async () => {
    Logger.time(`AssetsWarmup.materialize:${expectedLatest}`);
    try {
      const items = await materializeWarmCloudAssetRecords(cache, {
        latest: expectedLatest,
        service,
        controller: activeController,
        generation: nextGeneration
      });
      if (cache.generation === nextGeneration) {
        cache.items = items;
        cache.error = null;
        cache.status = 'ready';
      }
      return items;
    } catch (error) {
      if (cache.generation === nextGeneration) {
        if (isAbortError(error)) {
          cache.status = 'aborted';
          cache.error = null;
        } else {
          cache.status = 'error';
          cache.items = null;
          cache.error = String(error?.message || error);
        }
      }
      if (isAbortError(error)) {
        Logger.info('AssetsWarmup.aborted', { latest: expectedLatest, mode: safePriority });
      } else {
        Logger.warn('AssetsWarmup.failed', { latest: expectedLatest, error: String(error?.message || error) });
      }
      throw error;
    } finally {
      if (cache.generation === nextGeneration) {
        cache.mode = 'idle';
        if (cache.abortController === activeController) cache.abortController = null;
        if (cache.loadPromise === loadPromise) cache.loadPromise = null;
      }
      Logger.timeEnd(`AssetsWarmup.materialize:${expectedLatest}`);
    }
  })();

  cache.loadPromise = loadPromise;
  return awaitWithAbort(loadPromise, signal);
}

export async function getWarmCloudAssetRecords({
  signal = null,
  priority = 'idle',
  expectedLatest = null,
  createIfMissing = true,
  service = null
} = {}) {
  ensureSharedSettingsHook();
  const cache = SHARED_ASSET_CLOUD_WARM_CACHE;
  const safePriority = priority === 'interactive' ? 'interactive' : 'idle';
  if (safePriority === 'interactive') {
    clearWarmCloudAssetTimer();
  }
  if (signal?.aborted) throw abortError();

  if (expectedLatest && cache.status === 'ready' && cache.latest === expectedLatest && Array.isArray(cache.items)) {
    Logger.info('AssetsWarmup.cache.hit', {
      latest: expectedLatest,
      count: cache.items.length,
      priority: safePriority
    });
    return cache.items;
  }

  if (expectedLatest && cache.loadPromise && cache.latest === expectedLatest) {
    if (safePriority === 'interactive' && cache.mode !== 'interactive') {
      const previousMode = cache.mode;
      cache.mode = 'interactive';
      Logger.info('AssetsWarmup.promoted', { latest: expectedLatest, from: previousMode, to: 'interactive' });
    }
    return awaitWithAbort(cache.loadPromise, signal);
  }

  if (!createIfMissing) {
    Logger.info('AssetsWarmup.cache.miss', {
      latest: expectedLatest,
      cacheLatest: cache.latest,
      status: cache.status,
      priority: safePriority
    });
    return null;
  }

  return startWarmCloudAssetMaterialization({
    expectedLatest,
    priority: safePriority,
    signal,
    service
  });
}

async function runAssetCloudWarmup({ reason = 'startup' } = {}) {
  const cache = SHARED_ASSET_CLOUD_WARM_CACHE;
  clearWarmCloudAssetTimer();
  if (!shouldWarmAssetCloud()) {
    Logger.info('AssetsWarmup.skip', {
      reason,
      isGM: !!game?.user?.isGM,
      cloudEnabled: (() => {
        try { return !!game?.settings?.get?.('fa-nexus', 'cloudAssetsEnabled'); }
        catch (_) { return false; }
      })(),
      online: !(typeof navigator !== 'undefined' && navigator?.onLine === false)
    });
    return null;
  }
  if (cache.status === 'syncing' || cache.status === 'loading') {
    return cache.loadPromise || null;
  }

  const generation = cache.generation + 1;
  cache.generation = generation;
  const controller = new AbortController();
  cache.abortController = controller;
  cache.status = 'syncing';
  cache.mode = 'idle';
  cache.error = null;

  const svc = getSharedWarmupContentService();
  let syncError = null;
  try {
    Logger.time('AssetsWarmup.sync:assets');
    try {
      await svc.sync('assets', {
        signal: controller.signal,
        progressBatch: 500
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      syncError = String(error?.message || error);
      Logger.warn('AssetsWarmup.sync.failed', { reason, error: syncError });
    } finally {
      Logger.timeEnd('AssetsWarmup.sync:assets');
    }

    const meta = await svc.getMeta?.('assets');
    const latest = meta?.latest || null;
    Logger.info('AssetsWarmup.sync.done', {
      reason,
      latest,
      count: Number(meta?.count) || 0,
      error: syncError
    });

    if (!latest) {
      if (syncError) throw new Error(syncError);
      cache.status = 'idle';
      cache.abortController = null;
      return null;
    }

    if (cache.latest === latest && Array.isArray(cache.items)) {
      Logger.info('AssetsWarmup.cache.hit', {
        latest,
        count: cache.items.length,
        priority: 'idle',
        reason
      });
      cache.abortController = null;
      return cache.items;
    }

    const items = await startWarmCloudAssetMaterialization({
      expectedLatest: latest,
      priority: 'idle',
      service: svc,
      controller,
      generation
    });
    if (cache.generation === generation && syncError && Array.isArray(items)) {
      cache.error = syncError;
    }
    return items;
  } catch (error) {
    if (cache.generation === generation) {
      if (isAbortError(error)) {
        cache.status = 'aborted';
      } else {
        cache.status = 'error';
        cache.error = String(error?.message || error);
      }
      if (cache.abortController === controller) cache.abortController = null;
    }
    if (isAbortError(error)) {
      Logger.info('AssetsWarmup.aborted', { reason, latest: cache.latest || null, stage: 'sync' });
      return null;
    }
    Logger.warn('AssetsWarmup.failed', { reason, error: String(error?.message || error) });
    return null;
  }
}

export function scheduleAssetCloudWarmup({ reason = 'startup' } = {}) {
  ensureSharedSettingsHook();
  clearWarmCloudAssetTimer();
  const cache = SHARED_ASSET_CLOUD_WARM_CACHE;
  const delayMs = reason === 'startup' ? 2000 : 0;
  if (!shouldWarmAssetCloud()) {
    Logger.info('AssetsWarmup.skip', {
      reason,
      isGM: !!game?.user?.isGM,
      cloudEnabled: (() => {
        try { return !!game?.settings?.get?.('fa-nexus', 'cloudAssetsEnabled'); }
        catch (_) { return false; }
      })(),
      online: !(typeof navigator !== 'undefined' && navigator?.onLine === false)
    });
    return null;
  }
  if (cache.status === 'syncing' || cache.status === 'loading') {
    return cache.loadPromise || null;
  }
  cache.status = 'scheduled';
  Logger.info('AssetsWarmup.startup.scheduled', { reason, delayMs });
  cache.timer = setTimeout(() => {
    SHARED_ASSET_CLOUD_WARM_CACHE.timer = null;
    runAssetCloudWarmup({ reason }).catch((error) => {
      Logger.warn('AssetsWarmup.failed', { reason, error: String(error?.message || error) });
    });
  }, delayMs);
  return cache.timer;
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
    this._pathManager = tab._pathManager || null;
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

  get pathManager() {
    return this._pathManager || null;
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

  if (!forceReload && !shared.dirty && shared.status === 'ready' && Array.isArray(shared.items)) {
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

  if (shared.loadPromise) {
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
      return { items: [], error: String(e?.message || e), partial: false };
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
      return { items: [], error: String(error?.message || error), partial: false };
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
    } else {
      shared.items = result.items;
      shared.dirty = false;
      shared.status = 'ready';
      shared.version += 1;
    }
  } catch (e) {
    result = { items: [], error: String(e?.message || e), partial: false };
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
    if (shared.items === finalItems && shared.items !== tab._items) shared.items = tab._items;
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
      update: (_count, total) => {
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
          onProgress: (count, total) => cloudLoader?.update?.(count, total),
          onTotal: (total) => cloudLoader?.update?.(cloudLoader.state?.count ?? 0, total)
        });
        if (result?.error && !result.partial) {
          throw new Error(result.error);
        }
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
    const warm = getWarmCloudReuseState(latest);
    const label = indexing ? 'Indexing cloud assets...' : 'Loading Cloud Assets...';
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
    const filename = String(rec?.filename || '').trim();
    let raw = filename;
    if (!raw) {
      raw = normalizePathKey(rec?.file_path || rec?.path || '');
      if (raw) {
        const parts = raw.split('/');
        raw = parts[parts.length - 1] || '';
      }
    }
    if (!raw) return '';
    return raw.replace(/\.[^/.]+$/, '').toLowerCase();
  };
  const pathKey = (rec) => {
    const raw = normalizePathKey(rec?.file_path || rec?.path || '');
    if (!raw) return '';
    return raw.replace(/\.[^/.]+$/, '').toLowerCase();
  };
  const enhanceLocalRecord = (localRecord, cloudRecord) => {
    if (!svc || !cloudRecord?.filename) return localRecord;
    try {
      const thumb = svc.getThumbnailURL?.(kind, cloudRecord);
      if (!thumb) return localRecord;
      if (String(localRecord.thumbnail_url || localRecord.file_path || '').includes(thumb)) return localRecord;
      return {
        ...localRecord,
        original_thumbnail: localRecord.file_path || localRecord.thumbnail_url,
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
          const eExisting = extRank(existing?.filename || existing?.file_path);
          const eIncoming = extRank(incoming?.filename || incoming?.file_path);
          if (eIncoming > eExisting) return incoming;
          if (eIncoming < eExisting) return existing;
          const lmExisting = Date.parse(existing?.last_modified || existing?.lastModified || '') || 0;
          const lmIncoming = Date.parse(incoming?.last_modified || incoming?.lastModified || '') || 0;
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
  let hadCachedIndex = false;
  let syncError = null;
  let latest = null;
  try {
    const meta = await svc.getMeta?.(kind);
    hadCachedIndex = !!meta?.latest;
    latest = meta?.latest || null;
  } catch (_) {}

  if (latest) {
    const warm = getWarmCloudReuseState(latest);
    if (warm.ready || warm.loading) {
      try {
        const warmItems = await getWarmCloudAssetRecords({
          signal,
          priority: 'interactive',
          expectedLatest: latest,
          createIfMissing: false,
          service: svc
        });
        if (Array.isArray(warmItems)) {
          Logger.info('AssetsWarmup.cache.hit', {
            latest,
            count: warmItems.length,
            priority: 'interactive',
            stage: 'pre-sync'
          });
          return {
            items: warmItems,
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

  Logger.info('AssetsTab.cloud.sync', { mode: tab._mode, kind, hadCachedIndex });
  try {
    await svc.sync(kind, {
      signal,
      onManifestProgress: ({ count, total }) => {
        if (signal?.aborted) return;
        try { onProgress?.(count, total); } catch (_) {}
      },
      progressBatch: 500
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    syncError = String(error?.message || error);
    Logger.warn('AssetsTab.cloud.sync.failed', { error: syncError, hadCachedIndex });
  }

  try {
    const meta = await svc.getMeta?.(kind);
    latest = meta?.latest || null;
  } catch (_) {}

  if (latest && SHARED_ASSET_CLOUD_WARM_CACHE.latest && SHARED_ASSET_CLOUD_WARM_CACHE.latest !== latest) {
    invalidateWarmCloudAssetCache(`latest:${SHARED_ASSET_CLOUD_WARM_CACHE.latest}->${latest}`);
  }

  if (signal?.aborted) throw abortError();
  try {
    const warmItems = latest ? await getWarmCloudAssetRecords({
      signal,
      priority: 'interactive',
      expectedLatest: latest,
      createIfMissing: true,
      service: svc
    }) : null;
    if (Array.isArray(warmItems)) {
      return {
        items: warmItems,
        error: syncError,
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
      onProgress: (count, total) => {
        if (signal?.aborted) return;
        try { onProgress?.(count, total); } catch (_) {}
      },
      progressBatch: 500
    });
    items = Array.isArray(result?.items) ? result.items : [];
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
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

  return {
    items: out,
    error: syncError,
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
  const skipSolid = tab?.isTexturesMode && typeof tab._isSolidTextureItem === 'function';
  for (const item of items) {
    if (!matchesMode(tab, item)) continue;
    if (skipSolid && tab._isSolidTextureItem(item)) continue;
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
