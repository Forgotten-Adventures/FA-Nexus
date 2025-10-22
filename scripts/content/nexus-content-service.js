// NexusContentService — unified cloud content service for tokens/assets
import { CloudDB } from './cloud-db.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

/**
 * Lightweight event emitter for progress tracking
 */
export class ProgressEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
  }

  off(event, callback) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  emit(event, data) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      for (const callback of listeners) {
        try {
          callback(data);
        } catch (error) {
          Logger.warn('ProgressEmitter.emit.error', { event, error: String(error?.message || error) });
        }
      }
    }
  }

  clear() {
    this._listeners.clear();
  }
}

/**
 * Check if the client appears to be offline
 * @returns {boolean}
 */
function isOffline() {
  try {
    return !navigator.onLine;
  } catch (_) {
    // navigator.onLine not available, try a simple fetch
    try {
      const testUrl = 'https://www.google.com/favicon.ico';
      fetch(testUrl, { method: 'HEAD', mode: 'no-cors', cache: 'no-cache' })
        .then(() => false)
        .catch(() => true);
      return false; // Assume online if fetch doesn't immediately fail
    } catch (_) {
      return false;
    }
  }
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {Object} options
 * @param {number} options.maxRetries - Maximum number of retries
 * @param {number} options.initialDelay - Initial delay in ms
 * @param {number} options.maxDelay - Maximum delay in ms
 * @param {Function} options.onRetry - Callback before each retry
 * @param {AbortSignal} options.signal - Abort signal
 * @returns {Promise}
 */
async function retryWithBackoff(fn, {
  maxRetries = 3,
  initialDelay = 1000,
  maxDelay = 30000,
  onRetry,
  signal
} = {}) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (signal?.aborted) {
        throw new DOMException('Operation aborted', 'AbortError');
      }

      if (isOffline()) {
        throw new Error('Network appears to be offline');
      }

      return await fn();
    } catch (error) {
      lastError = error;

      if (error?.name === 'AbortError' || signal?.aborted) {
        throw error;
      }

      if (attempt >= maxRetries) {
        break;
      }

      const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
      Logger.info('Service.retry', { attempt: attempt + 1, maxRetries, delay, error: String(error?.message || error) });

      try {
        onRetry?.({ attempt: attempt + 1, maxRetries, delay, error });
      } catch (_) {}

      await new Promise(resolve => {
        const timeout = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      if (signal?.aborted) {
        throw new DOMException('Operation aborted', 'AbortError');
      }
    }
  }

  throw lastError;
}

export class UrlCache {
  /**
   * Simple in-memory URL cache with TTL
   * @param {number} [ttlMs] - Time-to-live for entries in milliseconds
   */
  constructor(ttlMs = 10 * 60 * 1000) { this.ttlMs = ttlMs; this._m = new Map(); }
  /**
   * Retrieve a cached URL
   * @param {string} key
   * @returns {string|null}
   */
  get(key) { const v = this._m.get(key); return v && Date.now() < v.exp ? v.url : null; }
  /**
   * Cache a URL value
   * @param {string} key
   * @param {string} url
   */
  set(key, url) { this._m.set(key, { url, exp: Date.now() + this.ttlMs }); }
  /** Clear all cached entries */
  clear() { this._m.clear(); }
}

export class NexusContentService {
  /**
   * Unified content service for both tokens and assets.
   * Handles manifest syncing, listing, and URL resolution (including signed URLs for premium).
   * @param {{base?:string,dbTokens?:CloudDB,dbAssets?:CloudDB,urlCache?:UrlCache,progressEmitter?:ProgressEmitter}} [options]
   */
  constructor(options = {}) {
    this.settingsNamespace = options.settingsNamespace || 'fa-nexus';
    this.base = options.base || 'https://n8n.forgotten-adventures.net/webhook';
    // Separate DBs per kind
    this._dbTokens = options.dbTokens || new CloudDB('fa-nexus-cloud-tokens-v1');
    this._dbAssets = options.dbAssets || new CloudDB('fa-nexus-cloud-assets-v1');
    this.urlCache = options.urlCache || new UrlCache();
    this.progressEmitter = options.progressEmitter || new ProgressEmitter();
    this._authApp = null;
    this._authService = null;
    this._authServiceFactory = null;
    this._authDisconnectInFlight = false;
    this.setAuthContext({ app: options.app, authService: options.authService });
  }

  /**
   * Get DB instance by kind
   * @param {'tokens'|'assets'} kind
   * @returns {CloudDB}
   * @private
   */
  _dbFor(kind) { return kind === 'assets' ? this._dbAssets : this._dbTokens; }

  /** Build update endpoint URL for kind */
  _updateEndpoint(kind) {
    return `${this.base}/foundry-nexus-${kind}-update`;
  }

  /** Build download endpoint URL for kind and file */
  _downloadEndpoint(kind, file_path, state) {
    const q = new URLSearchParams({ state });
    if (kind === 'tokens') q.set('token_path', file_path);
    else q.set('asset_path', file_path);
    return `${this.base}/foundry-nexus-download?${q}`;
  }

  /**
   * Sync local IndexedDB with remote manifests.
   * Handles both full and delta modes and updates meta with latest hash.
   * @param {'tokens'|'assets'} kind
   * @param {{onManifestProgress?:(info:{phase:string,count:number,total:number})=>void,progressBatch?:number,signal?:AbortSignal}} [options]
   * @returns {Promise<string>} latest hash
   */
  async sync(kind, options = {}) {
    const db = this._dbFor(kind);
    const signal = options.signal || null;
    const onManifestProgress = typeof options.onManifestProgress === 'function' ? options.onManifestProgress : null;
    const emitProgress = (phase, count, total) => {
      if (!onManifestProgress || signal?.aborted) return;
      try { onManifestProgress({ phase, count, total }); } catch (_) {}
    };

    // Emit sync start event
    this.progressEmitter.emit('sync:start', { kind });

    try {
      const latestLocal = await db.getLatest(kind);
      Logger.info('ContentService.sync:start', { kind, from: latestLocal || null });
      const url = latestLocal ? `${this._updateEndpoint(kind)}?from=${encodeURIComponent(latestLocal)}` : this._updateEndpoint(kind);

      // Use retry logic for the initial manifest fetch
      const plan = await retryWithBackoff(
        async () => {
          this.progressEmitter.emit('sync:fetch', { kind, url });
          const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal });
          if (!res.ok) throw new Error(`Update request failed (${res.status})`);
          return res.json();
        },
        {
          maxRetries: 3,
          initialDelay: 1000,
          maxDelay: 10000,
          signal,
          onRetry: ({ attempt, maxRetries, delay }) => {
            this.progressEmitter.emit('sync:retry', { kind, attempt, maxRetries, delay });
            Logger.info('ContentService.sync.retry', { kind, attempt, maxRetries, delay });
          }
        }
      );
      // Short‑circuit: if server reports we're already at latest, skip any full/delta work.
      const upToDate = plan && plan.latest && plan.latest === latestLocal && (
        (plan.mode === 'full') || (plan.mode === 'deltas' && (!Array.isArray(plan.deltas) || plan.deltas.length === 0))
      );
      if (upToDate) {
        Logger.info('ContentService.sync:noop', { kind, latest: plan.latest, mode: plan.mode });
        this.progressEmitter.emit('sync:complete', { kind, mode: plan.mode, latest: plan.latest, upToDate: true });
        return plan.latest;
      }

      if (plan.mode === 'full') {
        Logger.time(`ContentService.full:${kind}`);
        this.progressEmitter.emit('sync:phase', { kind, phase: 'full', url: plan.full.url });

        const items = await retryWithBackoff(
          async () => {
            const fullRes = await fetch(plan.full.url, { headers: { 'Accept': 'application/json' }, signal });
            if (!fullRes.ok) throw new Error(`Full manifest fetch failed (${fullRes.status})`);
            return fullRes.json();
          },
          {
            maxRetries: 2,
            initialDelay: 2000,
            maxDelay: 15000,
            signal,
            onRetry: ({ attempt, maxRetries, delay }) => {
              this.progressEmitter.emit('sync:retry', { kind, phase: 'full', attempt, maxRetries, delay });
            }
          }
        );

        await db.replaceAll(kind, items, {
          onProgress: (count, total) => emitProgress('replaceAll', count, total),
          progressBatch: options.progressBatch,
          signal
        });
        await db.setMeta(kind, { id: 'meta', latest: plan.latest, count: items.length, builtAt: new Date().toISOString() });
        emitProgress('meta', items.length, items.length);
        Logger.timeEnd(`ContentService.full:${kind}`);
        Logger.info('ContentService.sync:done', { kind, mode: 'full', latest: plan.latest, count: items.length });
        this.progressEmitter.emit('sync:complete', { kind, mode: 'full', latest: plan.latest, count: items.length });
        return plan.latest;
      }

      if (plan.mode === 'deltas') {
        Logger.time(`ContentService.deltas:${kind}`);
        this.progressEmitter.emit('sync:phase', { kind, phase: 'deltas', count: plan.deltas?.length || 0 });

        for (const [index, d] of (plan.deltas || []).entries()) {
          await retryWithBackoff(
            async () => {
              this.progressEmitter.emit('sync:delta', { kind, index, total: plan.deltas.length, url: d.url });
              const res = await fetch(d.url, { headers: { 'Accept': 'application/json' }, signal });
              if (!res.ok) throw new Error(`Delta fetch failed (${res.status})`);
              const t = await res.text();
              for (const line of t.split('\n')) {
                if (!line.trim()) continue;
                const op = JSON.parse(line);
                await db.applyDelta(kind, op);
              }
            },
            {
              maxRetries: 2,
              initialDelay: 1500,
              maxDelay: 12000,
              signal,
              onRetry: ({ attempt, maxRetries, delay }) => {
                this.progressEmitter.emit('sync:retry', { kind, phase: 'delta', index, attempt, maxRetries, delay });
              }
            }
          );
        }

        const count = await db.count(kind);
        await db.setMeta(kind, { id: 'meta', latest: plan.latest, count, builtAt: new Date().toISOString() });
        // Rebuild chunked index asynchronously so unfiltered list stays sorted by file_path
        db.rebuildChunks(kind).catch(() => {});
        emitProgress('meta', count, count);
        Logger.timeEnd(`ContentService.deltas:${kind}`);
        Logger.info('ContentService.sync:done', { kind, mode: 'deltas', latest: plan.latest, count });
        this.progressEmitter.emit('sync:complete', { kind, mode: 'deltas', latest: plan.latest, count });
        return plan.latest;
      }
      throw new Error('Unexpected update response');
    } catch (error) {
      const errorMsg = String(error?.message || error);
      Logger.error('ContentService.sync:error', { kind, error: errorMsg });
      this.progressEmitter.emit('sync:error', { kind, error: errorMsg });
      throw error;
    }
  }

  /**
   * List items for a kind with optional simple filters
   * @param {'tokens'|'assets'} kind
   * @param {{text?:string,tier?:string,pathPrefix?:string,offset?:number,limit?:number}} [opts]
   * @returns {Promise<{items:Array<object>, total:number}>}
   */
  async list(kind, opts = {}) { return this._dbFor(kind).query(kind, opts); }

  /**
   * Get a public thumbnail URL for an item
   * @param {'tokens'|'assets'} kind
   * @param {{file_path:string}} item
   * @returns {string}
   */
  getThumbnailURL(kind, item) {
    const p = item?.file_path || '';
    const enc = String(p).split('/').map(encodeURIComponent).join('/');
    if (kind === 'tokens') return `https://r2-public.forgotten-adventures.net/tokens/thumbnails/${enc}`;
    return `https://r2-public.forgotten-adventures.net/assets/thumbnails/${enc}`;
  }

  /**
   * Resolve a full download URL for an item, using signed URLs for premium content.
   * Results are cached in-memory by `urlCache`.
   * @param {'tokens'|'assets'} kind
   * @param {{file_path:string,filename?:string,tier?:'free'|'premium'}} item
   * @param {string} [state] - OAuth state used for premium signed URLs
   * @returns {Promise<string>} Full URL or local path
   */
  async getFullURL(kind, item, state) {
    if (!item) throw new Error('Missing item');
    const pRaw = item.file_path;
    const p = String(pRaw).split('/').map(encodeURIComponent).join('/');

    this.progressEmitter.emit('url:resolve', { kind, file_path: pRaw, tier: item.tier });

    if (item.tier === 'free') {
      const url = kind === 'tokens'
        ? `https://r2-public.forgotten-adventures.net/tokens/free_tokens/${p}`
        : `https://r2-public.forgotten-adventures.net/assets/free_assets/${p}`;
      this.progressEmitter.emit('url:resolved', { kind, file_path: pRaw, tier: 'free', url });
      return url;
    }

    if (!state) {
      try {
        const authData = this._readAuthData();
        if (authData?.authenticated) {
          await this._handleAuthFailure({
            reason: 'MISSING_STATE',
            kind,
            source: 'getFullURL:state',
            message: '🔐 Authentication expired - please reconnect to access premium content.'
          });
        }
      } catch (_) {}
      const error = new Error('Authentication required');
      this.progressEmitter.emit('url:error', { kind, file_path: pRaw, error: 'AUTH' });
      throw error;
    }

    const key = `${kind}:${p}`;
    const cached = this.urlCache.get(key);
    if (cached) {
      this.progressEmitter.emit('url:resolved', { kind, file_path: pRaw, tier: 'premium', cached: true, url: cached });
      return cached;
    }

    try {
      const dl = this._downloadEndpoint(kind, p, state);
      const body = await retryWithBackoff(
        async () => {
          this.progressEmitter.emit('url:fetch', { kind, file_path: pRaw, url: dl });
          const res = await fetch(dl, { headers: { 'Accept': 'application/json' } });
          if (res.status === 401 || res.status === 403) throw new Error('AUTH');
          if (!res.ok) throw new Error(`Signed URL fetch failed (${res.status})`);
          return res.json();
        },
        {
          maxRetries: 2,
          initialDelay: 1000,
          maxDelay: 8000,
          onRetry: ({ attempt, maxRetries, delay }) => {
            this.progressEmitter.emit('url:retry', { kind, file_path: pRaw, attempt, maxRetries, delay });
            Logger.info('ContentService.url.retry', { kind, file_path: pRaw, attempt, maxRetries, delay });
          }
        }
      );

      if (!body.success || !body.download_url) {
        throw new Error('Signed URL fetch failed');
      }

      this.urlCache.set(key, body.download_url);
      this.progressEmitter.emit('url:resolved', { kind, file_path: pRaw, tier: 'premium', url: body.download_url });
      return body.download_url;
    } catch (error) {
      const errorMsg = error?.message === 'AUTH' ? 'AUTH' : String(error?.message || error);
      if (errorMsg === 'AUTH') {
        try {
          await this._handleAuthFailure({
            reason: 'AUTH',
            kind,
            source: 'getFullURL:fetch',
            message: '🔐 Authentication expired - please reconnect to access premium content.'
          });
        } catch (_) {}
      }
      Logger.error('ContentService.url:error', { kind, file_path: pRaw, error: errorMsg });
      this.progressEmitter.emit('url:error', { kind, file_path: pRaw, error: errorMsg });
      throw error instanceof Error ? error : new Error(errorMsg);
    }
  }

  /**
   * Update the auth context used for automatic disconnect handling.
   * @param {{app?:object|null,authService?:object|Function|null}} [context]
   * @returns {this}
   */
  setAuthContext(context = {}) {
    if (Object.prototype.hasOwnProperty.call(context, 'app')) {
      this._authApp = context.app || null;
    }
    if (Object.prototype.hasOwnProperty.call(context, 'authService')) {
      const svc = context.authService;
      if (typeof svc === 'function') {
        this._authServiceFactory = svc;
        this._authService = null;
      } else {
        this._authService = svc || null;
        this._authServiceFactory = null;
      }
    }
    return this;
  }

  /** Resolve the current auth app/service, falling back to global lookup */
  _resolveAuthContext() {
    let app = this._authApp;
    if (!app) {
      try {
        app = foundry?.applications?.instances?.get?.('fa-nexus-app') || null;
        if (app) this._authApp = app;
      } catch (_) { app = null; }
    }

    let svc = this._authService;
    if (!svc && this._authServiceFactory) {
      try {
        svc = this._authServiceFactory(app);
        if (svc) this._authService = svc;
      } catch (error) {
        Logger.warn('ContentService.auth.resolveFactory', { error: String(error?.message || error) });
      }
    }

    if (!svc && app && typeof app._getAuthService === 'function') {
      try {
        svc = app._getAuthService();
        if (svc) this._authService = svc;
      } catch (error) {
        Logger.warn('ContentService.auth.resolveApp', { error: String(error?.message || error) });
      }
    }

    return { app: app || null, authService: svc || null };
  }

  /** Read Patreon auth data from settings */
  _readAuthData() {
    try {
      return game?.settings?.get?.(this.settingsNamespace, 'patreon_auth_data') || null;
    } catch (_) {
      return null;
    }
  }

  /** Handle premium auth failures by clearing cache and disconnecting */
  async _handleAuthFailure({ reason = 'AUTH', kind = null, source = null, message = null, notify = true } = {}) {
    if (this._authDisconnectInFlight) return;
    this._authDisconnectInFlight = true;
    try {
      Logger.warn('ContentService.authDisconnect:start', { reason, kind, source });
    } catch (_) {}
    try { this.urlCache?.clear?.(); } catch (_) {}

    if (notify && ui?.notifications?.warn) {
      try { ui.notifications.warn(message || '🔐 Authentication expired - please reconnect to access premium content.'); }
      catch (_) {}
    }

    try {
      const { app, authService } = this._resolveAuthContext();
      if (authService?.handlePatreonDisconnect) {
        await authService.handlePatreonDisconnect(app, false);
      } else {
        await game?.settings?.set?.(this.settingsNamespace, 'patreon_auth_data', null);
      }
      Logger.info('ContentService.authDisconnect:done', { reason, kind, source });
    } catch (error) {
      Logger.error('ContentService.authDisconnect:error', { reason, kind, source, error: String(error?.message || error) });
      try { await game?.settings?.set?.(this.settingsNamespace, 'patreon_auth_data', null); }
      catch (_) {}
    } finally {
      this._authDisconnectInFlight = false;
    }
  }

  /** Read manifest metadata for a kind */
  async getMeta(kind) { return this._dbFor(kind).getMeta(kind); }
  /** Get latest hash recorded for kind */
  async getLatest(kind) { return this._dbFor(kind).getLatest(kind); }
  /** Clear IndexedDB for a kind */
  async clear(kind) { Logger.info('ContentService.clear', { kind }); return this._dbFor(kind).clear(kind); }
  /** Dispose internal caches */
  destroy() {
    this.urlCache.clear();
    this.progressEmitter.clear();
  }
}

/**
 * Parse enabled folder paths from the given fa-nexus setting key.
 * @param {string} settingKey
 * @returns {string[]}
 */
export function getEnabledFolders(settingKey) {
  if (!settingKey) return [];
  try {
    const raw = game.settings.get('fa-nexus', settingKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const folders = [];
    for (const entry of parsed) {
      if (!entry || !entry.enabled) continue;
      const path = entry.path ?? entry.folder ?? entry.value;
      if (!path) continue;
      const str = String(path).trim();
      if (!str) continue;
      folders.push(str);
    }
    return folders;
  } catch (_) {
    return [];
  }
}

const defaultKeySelector = (rec) => {
  if (!rec) return '';
  return String(rec.file_path || rec.path || rec.url || rec.id || '').trim();
};

/**
 * Collect cached and freshly streamed local items for an inventory-style tab.
 * @param {object} config
 * @param {string} [config.loggerTag] - label used for logging context
 * @param {string[]} [config.folders] - explicit folder list (defaults to settingsKey)
 * @param {string} [config.settingsKey] - fa-nexus setting key containing folder entries
 * @param {Function} config.loadCached - async (folder) => records[]
 * @param {Function} config.saveIndex - async (folder, records[]) => void
 * @param {Function} config.streamFolder - async (folder, onBatch, options) => void
 * @param {Function} [config.isCancelled] - () => boolean, checked between operations
 * @param {Function} [config.onCachedReady] - (cachedItems[]) when cached aggregation completed
 * @param {Function} [config.onStreamProgress] - (count, folder, batchCount) after each streamed batch
 * @param {Function} [config.onStreamFolderComplete] - (folder, records[]) after a folder finishes streaming
 * @param {{batchSize?:number,sleepMs?:number}} [config.streamOptions]
 * @param {Function} [config.keySelector] - builds dedupe key per record
 * @returns {Promise<{folders:string[],cachedItems:object[],localItems:object[],streamedCount:number,cancelled:boolean}>}
 */
export async function collectLocalInventory(config) {
  const {
    loggerTag = 'LocalInventory',
    folders: explicitFolders,
    settingsKey,
    loadCached,
    saveIndex,
    streamFolder,
    isCancelled = () => false,
    onCachedReady,
    onStreamProgress,
    onStreamFolderComplete,
    streamOptions = { batchSize: 1500, sleepMs: 8 },
    keySelector = defaultKeySelector
  } = config || {};

  const folders = Array.isArray(explicitFolders) && explicitFolders.length
    ? explicitFolders.map((f) => String(f)).filter(Boolean)
    : getEnabledFolders(settingsKey);

  const seen = new Set();
  const cached = [];
  const toStream = [];

  const result = {
    folders,
    cachedItems: cached,
    localItems: cached,
    streamedCount: 0,
    cancelled: false
  };

  if (!folders.length) {
    return { ...result, cachedItems: [], localItems: [] };
  }

  for (const folder of folders) {
    if (isCancelled()) {
      result.cancelled = true;
      return { ...result, cachedItems: cached.slice(), localItems: cached.slice() };
    }
    let part = [];
    try {
      part = await loadCached?.(folder);
    } catch (e) {
      Logger.warn(`${loggerTag}.cache.error`, { folder, error: String(e?.message || e) });
    }
    if (Array.isArray(part) && part.length) {
      let added = 0;
      for (const rec of part) {
        const key = keySelector(rec);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        cached.push(rec);
        added++;
      }
      Logger.info(`${loggerTag}.cache.hit`, { folder, count: part.length, added });
    } else {
      Logger.info(`${loggerTag}.cache.miss`, { folder });
      toStream.push(folder);
    }
  }

  result.cachedItems = cached.slice();
  result.localItems = cached.slice();
  try { onCachedReady?.(result.cachedItems.slice()); } catch (_) {}

  if (isCancelled()) {
    result.cancelled = true;
    return result;
  }

  if (!toStream.length) {
    return result;
  }

  for (const folder of toStream) {
    if (isCancelled()) {
      result.cancelled = true;
      return result;
    }
    Logger.info(`${loggerTag}.streaming.folder`, { folder });
    const perFolder = [];
    const handleBatch = async (batch) => {
      for (const rec of batch || []) {
        const key = keySelector(rec);
        if (!key) continue;
        perFolder.push(rec);
        if (seen.has(key)) continue;
        seen.add(key);
        result.localItems.push(rec);
      }
      try { onStreamProgress?.(result.localItems.length, folder, Array.isArray(batch) ? batch.length : 0); } catch (_) {}
    };
    try {
      if (typeof streamFolder === 'function') {
        if (streamFolder.length >= 3) await streamFolder(folder, handleBatch, streamOptions);
        else await streamFolder(folder, handleBatch);
      }
    } catch (e) {
      Logger.warn(`${loggerTag}.stream.error`, { folder, error: String(e?.message || e) });
    }
    try { await saveIndex?.(folder, perFolder); } catch (e) { Logger.warn(`${loggerTag}.save.error`, { folder, error: String(e?.message || e) }); }
    try { onStreamFolderComplete?.(folder, perFolder.slice()); } catch (_) {}
    if (isCancelled()) {
      result.cancelled = true;
      return result;
    }
  }

  result.streamedCount = result.localItems.length - result.cachedItems.length;
  return result;
}

const defaultMergeLogger = (kind, detail) => {
  try { Logger.info(`MergeHelper.${kind}`, detail); } catch (_) {}
};

/**
 * Merge local and cloud records with deduplication and optional enhancement logic.
 * @param {object} options
 * @param {Array<object>} [options.local=[]]
 * @param {Array<object>} [options.cloud=[]]
 * @param {Function} [options.keySelector] - build dedupe key per record
 * @param {Function} [options.choosePreferred] - (localRecord, cloudRecord) => preferredRecord
 * @param {Function} [options.onEnhanceLocal] - ({ localRecord, cloudRecord }) => enhancedLocal
 * @param {Function} [options.onStats] - ({ kind, collisions, preferLocal, preferCloud, enhanced, localCount, cloudCount, mergedCount })
 * @param {string} [options.kind='items']
 * @returns {Array<object>}
 */
export function mergeLocalAndCloudRecords({
  local = [],
  cloud = [],
  keySelector = defaultKeySelector,
  choosePreferred,
  onEnhanceLocal,
  onStats = defaultMergeLogger,
  kind = 'items'
} = {}) {
  const map = new Map();
  const safeLocal = Array.isArray(local) ? local : [];
  const safeCloud = Array.isArray(cloud) ? cloud : [];
  let collisions = 0;
  let preferLocal = 0;
  let preferCloud = 0;
  let enhanced = 0;

  const put = (record) => {
    if (!record) return;
    const key = keySelector(record);
    if (!key) return;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, record);
      return;
    }
    collisions++;
    let preferred = record;
    let other = existing;
    if (typeof choosePreferred === 'function') {
      preferred = choosePreferred(existing, record) || existing;
      other = preferred === existing ? record : existing;
    }
    const preferredIsLocal = String(preferred?.source || '').toLowerCase() === 'local';
    if (preferred === existing) {
      if (preferredIsLocal) {
        preferLocal++;
        if (typeof onEnhanceLocal === 'function') {
          try {
            const enhancedLocal = onEnhanceLocal({ localRecord: existing, cloudRecord: other, key });
            if (enhancedLocal) {
              enhanced++;
              map.set(key, enhancedLocal);
            }
          } catch (_) {}
        }
      } else {
        preferCloud++;
      }
      return;
    }
    map.set(key, preferred);
    if (preferredIsLocal) {
      preferLocal++;
      if (typeof onEnhanceLocal === 'function') {
        try {
          const enhancedLocal = onEnhanceLocal({ localRecord: preferred, cloudRecord: other, key });
          if (enhancedLocal) {
            enhanced++;
            map.set(key, enhancedLocal);
          }
        } catch (_) {}
      }
    } else {
      preferCloud++;
    }
  };

  for (const rec of safeLocal) put(rec);
  for (const rec of safeCloud) put(rec);

  const merged = Array.from(map.values());
  try {
    onStats?.({
      kind,
      collisions,
      preferLocal,
      preferCloud,
      enhanced,
      localCount: safeLocal.length,
      cloudCount: safeCloud.length,
      mergedCount: merged.length
    });
  } catch (_) {}
  return merged;
}
