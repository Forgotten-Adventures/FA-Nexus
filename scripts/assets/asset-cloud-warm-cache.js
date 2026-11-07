import { NexusContentService } from '../content/nexus-content-service.js';
import { abortError, isAbortError } from '../content/catalog-pipeline.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

const SHARED_ASSET_CLOUD_WARM_CACHE = {
  items: null,
  latest: null,
  assetClass: null,
  loadPromise: null,
  status: 'idle',
  error: null,
  mode: 'idle',
  abortController: null,
  timer: null,
  generation: 0
};

let sharedWarmupContentService = null;

export function clearWarmCloudAssetTimer() {
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

function warmCacheMatchesAssetClass(cache, assetClass = null) {
  const requested = assetClass ? String(assetClass) : null;
  return !requested || !cache.assetClass || cache.assetClass === requested;
}

export function getWarmCloudReuseState(latest = null, assetClass = null) {
  const cache = SHARED_ASSET_CLOUD_WARM_CACHE;
  const expectedLatest = String(latest || '').trim();
  if (!expectedLatest) return { ready: false, loading: false, latest: null };
  const classMatch = warmCacheMatchesAssetClass(cache, assetClass);
  return {
    ready: classMatch && cache.status === 'ready' && cache.latest === expectedLatest && Array.isArray(cache.items),
    loading: classMatch && cache.latest === expectedLatest && !!cache.loadPromise,
    latest: cache.latest
  };
}

export function getWarmCloudAssetCacheLatest() {
  return SHARED_ASSET_CLOUD_WARM_CACHE.latest || null;
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
  cache.assetClass = null;
  cache.error = null;
  cache.mode = 'idle';
  cache.status = 'stale';
  if (controller) {
    try { controller.abort(`invalidate:${reason}`); } catch (_) {}
  }
  Logger.info('AssetsWarmup.invalidate', { reason });
}

export function cancelWarmCloudAssetBackgroundWork(reason = 'unknown') {
  const cache = SHARED_ASSET_CLOUD_WARM_CACHE;
  const active = cache.status === 'scheduled' || cache.status === 'syncing' || cache.status === 'loading';
  clearWarmCloudAssetTimer();
  if (!active) return;
  invalidateWarmCloudAssetCache(reason);
}

export function seedWarmCloudAssetCache({ latest, items, reason = 'foreground-load', assetClass = null } = {}) {
  const expectedLatest = String(latest || '').trim();
  if (!expectedLatest || !Array.isArray(items)) return;
  const cache = SHARED_ASSET_CLOUD_WARM_CACHE;
  clearWarmCloudAssetTimer();
  cache.generation += 1;
  const controller = cache.abortController;
  cache.abortController = null;
  cache.loadPromise = null;
  cache.items = items;
  cache.latest = expectedLatest;
  cache.assetClass = assetClass ? String(assetClass) : null;
  cache.error = null;
  cache.mode = 'idle';
  cache.status = 'ready';
  if (controller) {
    try { controller.abort(`seed:${reason}`); } catch (_) {}
  }
  Logger.info('AssetsWarmup.cache.seeded', {
    reason,
    latest: expectedLatest,
    assetClass: cache.assetClass,
    count: items.length
  });
}

export function normalizeCloudAssetRecord(record) {
  if (!record) return null;
  const id = String(record.id || '').trim();
  if (!id) return null;
  return {
    ...record,
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
  const hasGeneration = Number.isFinite(generation);
  const nextGeneration = hasGeneration ? generation : (cache.generation + 1);
  if (hasGeneration && cache.generation !== nextGeneration) throw abortError();
  if (!hasGeneration) cache.generation = nextGeneration;
  const activeController = controller || new AbortController();
  if (activeController.signal?.aborted) throw abortError();

  cache.items = null;
  cache.latest = expectedLatest;
  cache.assetClass = null;
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
  service = null,
  assetClass = null
} = {}) {
  const cache = SHARED_ASSET_CLOUD_WARM_CACHE;
  const safePriority = priority === 'interactive' ? 'interactive' : 'idle';
  if (safePriority === 'interactive') {
    clearWarmCloudAssetTimer();
  }
  if (signal?.aborted) throw abortError();

  if (expectedLatest && warmCacheMatchesAssetClass(cache, assetClass) && cache.status === 'ready' && cache.latest === expectedLatest && Array.isArray(cache.items)) {
    Logger.info('AssetsWarmup.cache.hit', {
      latest: expectedLatest,
      assetClass: cache.assetClass,
      count: cache.items.length,
      priority: safePriority
    });
    return cache.items;
  }

  if (expectedLatest && warmCacheMatchesAssetClass(cache, assetClass) && cache.loadPromise && cache.latest === expectedLatest) {
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
      cacheAssetClass: cache.assetClass,
      assetClass,
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
    const existingMeta = await svc.getMeta?.('assets');
    if (controller.signal.aborted || cache.generation !== generation) throw abortError();
    if (!existingMeta?.latest) {
      cache.status = 'idle';
      cache.abortController = null;
      Logger.info('AssetsWarmup.skip', { reason, cause: 'missing-index' });
      return null;
    }

    Logger.time('AssetsWarmup.sync:assets');
    try {
      await svc.sync('assets', {
        signal: controller.signal,
        progressBatch: 500
      });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) throw abortError();
      syncError = String(error?.message || error);
      Logger.warn('AssetsWarmup.sync.failed', { reason, error: syncError });
    } finally {
      Logger.timeEnd('AssetsWarmup.sync:assets');
    }

    if (controller.signal.aborted || cache.generation !== generation) throw abortError();
    const meta = await svc.getMeta?.('assets');
    if (controller.signal.aborted || cache.generation !== generation) throw abortError();
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

    if (cache.latest === latest && !cache.assetClass && Array.isArray(cache.items)) {
      Logger.info('AssetsWarmup.cache.hit', {
        latest,
        assetClass: cache.assetClass,
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
    cache.timer = null;
    runAssetCloudWarmup({ reason }).catch((error) => {
      Logger.warn('AssetsWarmup.failed', { reason, error: String(error?.message || error) });
    });
  }, delayMs);
  return cache.timer;
}
