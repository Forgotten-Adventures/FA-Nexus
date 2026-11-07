// NexusContentService — unified cloud content service for tokens/assets
import { CloudDB } from './cloud-db.js';
import {
  buildContentKindPublicUrl,
  encodeCloudPath,
  getContentKindDescriptor
} from './content-kind-descriptors.js';
import {
  contentPath,
  isCloudManifestV2Payload,
  toInventoryV2Items
} from './cloud-inventory-v2.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { isStateMismatchResponse } from '../premium/session-host/auth-state.js';
import { PREMIUM_DOWNLOAD_TIER_MESSAGE } from '../premium/patreon-auth-contract.js';

const SYNC_SLOTS_BY_KIND = new Map();

/**
 * @typedef {import('../core/fa-nexus-types.js').FaNexusInventoryListResult} FaNexusInventoryListResult
 * @typedef {import('../core/fa-nexus-types.js').FaNexusInventoryRecord} FaNexusInventoryRecord
 * @typedef {import('../core/fa-nexus-types.js').FaNexusTokenInventoryRecord} FaNexusTokenInventoryRecord
 * @typedef {import('../core/fa-nexus-types.js').LoadAndMergeCloudRecordsOptions} LoadAndMergeCloudRecordsOptions
 * @typedef {import('../core/fa-nexus-types.js').LocalInventoryConfig} LocalInventoryConfig
 * @typedef {import('../core/fa-nexus-types.js').MergeLocalAndCloudRecordsOptions} MergeLocalAndCloudRecordsOptions
 * @typedef {import('../core/fa-nexus-types.js').NexusContentServiceOptions} NexusContentServiceOptions
 * @typedef {import('../core/fa-nexus-types.js').NexusSyncOptions} NexusSyncOptions
 * @typedef {import('../core/fa-nexus-types.js').FaNexusAuthContext} FaNexusAuthContext
 * @typedef {import('../core/fa-nexus-types.js').ProgressEmitterLike} ProgressEmitterLike
 * @typedef {import('../core/fa-nexus-types.js').RetryWithBackoffOptions} RetryWithBackoffOptions
 * @typedef {import('../core/fa-nexus-types.js').UrlCacheLike} UrlCacheLike
 */

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
 * Retry a function with exponential backoff
 * @template T
 * @param {() => Promise<T>|T} fn - Function to retry
 * @param {RetryWithBackoffOptions} [options]
 * @returns {Promise<T>}
 */
async function retryWithBackoff(fn, {
  maxRetries = 3,
  initialDelay = 1000,
  maxDelay = 30000,
  onRetry,
  shouldRetry,
  signal
} = {}) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (signal?.aborted) {
        throw new DOMException('Operation aborted', 'AbortError');
      }

      return await fn();
    } catch (error) {
      lastError = error;

      if (error?.name === 'AbortError' || signal?.aborted) {
        throw error;
      }

      if (typeof shouldRetry === 'function' && !shouldRetry(error)) {
        throw error;
      }

      if (attempt >= maxRetries) {
        break;
      }

      const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
      const offlineHint = typeof navigator !== 'undefined' && navigator?.onLine === false;
      Logger.info('Service.retry', { attempt: attempt + 1, maxRetries, delay, offlineHint, error: String(error?.message || error) });

      try {
        onRetry?.({ attempt: attempt + 1, maxRetries, delay, error });
      } catch (_) {}

      await new Promise(resolve => {
        const timeout = setTimeout(resolve, delay);
        const onAbort = () => {
          clearTimeout(timeout);
          signal?.removeEventListener?.('abort', onAbort);
          resolve();
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
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

  _pruneExpired(now = Date.now()) {
    for (const [key, value] of this._m) {
      if (!value || !(now < value.exp)) this._m.delete(key);
    }
  }

  /**
   * Retrieve a cached URL
   * @param {string} key
   * @returns {string|null}
   */
  get(key) {
    this._pruneExpired();
    const v = this._m.get(key);
    return v ? v.url : null;
  }
  /**
   * Cache a URL value
   * @param {string} key
   * @param {string} url
   */
  set(key, url) {
    const now = Date.now();
    this._m.set(key, { url, exp: now + this.ttlMs });
    this._pruneExpired(now);
  }
  /** Clear all cached entries */
  clear() { this._m.clear(); }
}

export class NexusContentService {
  /**
   * Unified content service for both tokens and assets.
   * Handles manifest syncing, listing, and URL resolution (including signed URLs for premium).
   * @param {NexusContentServiceOptions} [options]
   */
  constructor(options = {}) {
    this.settingsNamespace = options.settingsNamespace || 'fa-nexus';
    this.base = options.base || 'https://n8n.forgotten-adventures.net/webhook';
    // Separate DBs per kind
    this._dbTokens = options.dbTokens || new CloudDB(getContentKindDescriptor('tokens').dbName);
    this._dbAssets = options.dbAssets || new CloudDB(getContentKindDescriptor('assets').dbName);
    this.urlCache = options.urlCache || new UrlCache();
    this.progressEmitter = options.progressEmitter || new ProgressEmitter();
    this._authApp = null;
    this._authService = null;
    this._authServiceFactory = null;
    this._authDisconnectInFlight = false;
    this._lastAuthFailureAt = 0;
    this._authDisconnectCooldownMs = Number.isFinite(options.authDisconnectCooldownMs)
      ? options.authDisconnectCooldownMs
      : 15000;
    this.setAuthContext({ app: options.app, authService: options.authService });
  }

  /**
   * Get DB instance by kind
   * @param {'tokens'|'assets'} kind
   * @returns {CloudDB}
   * @private
   */
  _dbFor(kind) {
    return getContentKindDescriptor(kind).kind === 'assets' ? this._dbAssets : this._dbTokens;
  }

  /** Build update endpoint URL for kind */
  _updateEndpoint(kind) {
    return `${this.base}/${getContentKindDescriptor(kind).updateEndpointPath}`;
  }

  /** Build download endpoint URL for kind and file */
  _downloadEndpoint(kind, file_path, state) {
    const descriptor = getContentKindDescriptor(kind);
    const q = new URLSearchParams({ state });
    q.set(descriptor.downloadQueryParam, file_path);
    return `${this.base}/${descriptor.downloadEndpointPath}?${q}`;
  }

  /**
   * Sync local IndexedDB with remote manifests.
   * Handles both full and delta modes and updates meta with latest hash.
   * @param {'tokens'|'assets'} kind
   * @param {NexusSyncOptions} [options]
   * @returns {Promise<string>} latest hash
   */
  async sync(kind, options = {}) {
    const onManifestProgress = typeof options.onManifestProgress === 'function' ? options.onManifestProgress : null;
    const releaseSyncSlot = await this._acquireSyncSlot(kind, options.signal || null, onManifestProgress);
    try {
      return await this._syncNow(kind, options);
    } finally {
      releaseSyncSlot();
    }
  }

  async _acquireSyncSlot(kind, signal = null, onManifestProgress = null) {
    const slotKey = getContentKindDescriptor(kind).kind;
    const previous = SYNC_SLOTS_BY_KIND.get(slotKey) || null;
    const waitForPrevious = previous?.catch?.(() => undefined) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const slot = waitForPrevious.then(() => current);
    SYNC_SLOTS_BY_KIND.set(slotKey, slot);

    const releaseCurrent = () => {
      release();
      slot.finally(() => {
        if (SYNC_SLOTS_BY_KIND.get(slotKey) === slot) {
          SYNC_SLOTS_BY_KIND.delete(slotKey);
        }
      });
    };

    try {
      if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
      if (previous) {
        try { onManifestProgress?.({ phase: 'waiting', count: 0, total: 0 }); } catch (_) {}
        await new Promise((resolve, reject) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
          };
          const onAbort = () => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener?.('abort', onAbort);
            reject(new DOMException('Operation aborted', 'AbortError'));
          };
          signal?.addEventListener?.('abort', onAbort, { once: true });
          waitForPrevious.then(done, done);
        });
      }
      if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
    } catch (error) {
      releaseCurrent();
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
    };
  }

  async _syncNow(kind, options = {}) {
    const db = this._dbFor(kind);
    const signal = options.signal || null;
    const forceFull = options.forceFull === true;
    const onManifestProgress = typeof options.onManifestProgress === 'function' ? options.onManifestProgress : null;
    const fetchJsonOptions = () => {
      const requestOptions = { headers: { 'Accept': 'application/json' }, signal };
      if (forceFull) requestOptions.cache = 'no-store';
      return requestOptions;
    };
    const emitProgress = (phase, count, total) => {
      if (!onManifestProgress || signal?.aborted) return;
      try { onManifestProgress({ phase, count, total }); } catch (_) {}
    };
    const scheduleChunkRebuild = async (expectedLatest, expectedCount, expectedBuiltAt) => {
      if (!expectedLatest) return false;
      let rebuild;
      try {
        rebuild = db.rebuildChunks(kind);
      } catch (error) {
        Logger.warn('ContentService.sync:chunkRebuild.startFailed', {
          kind,
          latest: expectedLatest,
          error: String(error?.message || error)
        });
        return false;
      }

      let ok = false;
      try {
        ok = await rebuild;
      } catch (error) {
        Logger.warn('ContentService.sync:chunkRebuild.failed', {
          kind,
          latest: expectedLatest,
          error: String(error?.message || error)
        });
        return false;
      }
      if (!ok) {
        Logger.warn('ContentService.sync:chunkRebuild.failed', {
          kind,
          latest: expectedLatest,
          reason: 'rebuild-returned-false'
        });
        return false;
      }
      try {
        const meta = await db.getMeta(kind);
        if (!meta || meta.latest !== expectedLatest) return false;
        const count = Number.isFinite(meta.count) ? Number(meta.count) : (Number(expectedCount) || 0);
        const builtAt = meta.builtAt || expectedBuiltAt || new Date().toISOString();
        await db.setMeta(kind, {
          id: 'meta',
          latest: meta.latest,
          count,
          builtAt,
          schemaVersion: meta.schemaVersion || 2,
          recordShape: meta.recordShape || 'cloud-inventory-v2',
          chunksLatest: meta.latest,
          chunksBuiltAt: new Date().toISOString()
        });
        return true;
      } catch (error) {
        Logger.warn('ContentService.sync:chunkMetaUpdate.failed', {
          kind,
          latest: expectedLatest,
          error: String(error?.message || error)
        });
        return false;
      }
    };

    // Emit sync start event
    this.progressEmitter.emit('sync:start', { kind });

    try {
      const metaLocal = await db.getMeta(kind);
      const latestLocal = forceFull ? null : (metaLocal?.latest || null);
      Logger.info('ContentService.sync:start', { kind, from: latestLocal || null, forceFull });
      const url = latestLocal ? `${this._updateEndpoint(kind)}?from=${encodeURIComponent(latestLocal)}` : this._updateEndpoint(kind);

      // Use retry logic for the initial manifest fetch
      const plan = await retryWithBackoff(
        async () => {
          this.progressEmitter.emit('sync:fetch', { kind, url });
          const res = await fetch(url, fetchJsonOptions());
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
      const localIsV2 = Number(metaLocal?.schemaVersion) === 2 && metaLocal?.recordShape === 'cloud-inventory-v2';
      const upToDate = !forceFull && localIsV2 && plan && plan.latest && plan.latest === latestLocal && (
        (plan.mode === 'full') || (plan.mode === 'deltas' && (!Array.isArray(plan.deltas) || plan.deltas.length === 0))
      );
      if (upToDate) {
        Logger.info('ContentService.sync:noop', { kind, latest: plan.latest, mode: plan.mode });
        const meta = await db.getMeta(kind);
        const latest = meta?.latest || plan.latest || null;
        const chunksLatest = meta?.chunksLatest || null;
        if (latest && chunksLatest !== latest) {
          await scheduleChunkRebuild(latest, meta?.count, meta?.builtAt);
        }
        this.progressEmitter.emit('sync:complete', { kind, mode: plan.mode, latest: plan.latest, upToDate: true });
        return plan.latest;
      }

      if (plan.mode === 'full') {
        Logger.time(`ContentService.full:${kind}`);
        try {
          this.progressEmitter.emit('sync:phase', { kind, phase: 'full', url: plan.full.url });
          emitProgress('download', 0, 0);

          const items = await retryWithBackoff(
            async () => {
              const fullRes = await fetch(plan.full.url, fetchJsonOptions());
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

          if (!isCloudManifestV2Payload(items, plan)) {
            throw new Error(`Unexpected ${kind} cloud inventory response; manifests_v2 payload required.`);
          }
          const normalizedItems = toInventoryV2Items(kind, items, 'cloud');

          await db.replaceAll(kind, normalizedItems, {
            onProgress: (count, total) => emitProgress('replaceAll', count, total),
            progressBatch: options.progressBatch,
            signal
          });
          const builtAt = new Date().toISOString();
          await db.setMeta(kind, {
            id: 'meta',
            latest: plan.latest,
            count: normalizedItems.length,
            builtAt,
            schemaVersion: 2,
            recordShape: 'cloud-inventory-v2',
            chunksLatest: plan.latest,
            chunksBuiltAt: builtAt
          });
          emitProgress('meta', normalizedItems.length, normalizedItems.length);
          Logger.info('ContentService.sync:done', { kind, mode: 'full', latest: plan.latest, count: normalizedItems.length });
          this.progressEmitter.emit('sync:complete', { kind, mode: 'full', latest: plan.latest, count: normalizedItems.length });
          return plan.latest;
        } finally {
          Logger.timeEnd(`ContentService.full:${kind}`);
        }
      }

      if (plan.mode === 'deltas') {
        Logger.time(`ContentService.deltas:${kind}`);
        try {
          this.progressEmitter.emit('sync:phase', { kind, phase: 'deltas', count: plan.deltas?.length || 0 });

          for (const [index, d] of (plan.deltas || []).entries()) {
            await retryWithBackoff(
              async () => {
                this.progressEmitter.emit('sync:delta', { kind, index, total: plan.deltas.length, url: d.url });
                const res = await fetch(d.url, fetchJsonOptions());
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
          const builtAt = new Date().toISOString();
          const prevMeta = await db.getMeta(kind);
          const prevChunksLatest = prevMeta?.chunksLatest ?? prevMeta?.latest ?? null;
          const prevChunksBuiltAt = prevMeta?.chunksBuiltAt ?? null;
          await db.setMeta(kind, {
            id: 'meta',
            latest: plan.latest,
            count,
            builtAt,
            schemaVersion: 2,
            recordShape: 'cloud-inventory-v2',
            chunksLatest: prevChunksLatest,
            chunksBuiltAt: prevChunksBuiltAt
          });
          // Rebuild chunked index before releasing the same-kind sync slot.
          await scheduleChunkRebuild(plan.latest, count, builtAt);
          emitProgress('meta', count, count);
          Logger.info('ContentService.sync:done', { kind, mode: 'deltas', latest: plan.latest, count });
          this.progressEmitter.emit('sync:complete', { kind, mode: 'deltas', latest: plan.latest, count });
          return plan.latest;
        } finally {
          Logger.timeEnd(`ContentService.deltas:${kind}`);
        }
      }
      throw new Error('Unexpected update response');
    } catch (error) {
      const errorMsg = String(error?.message || error);
      if (error?.name === 'AbortError' || signal?.aborted) {
        Logger.info('ContentService.sync:aborted', { kind, error: errorMsg });
        this.progressEmitter.emit('sync:aborted', { kind, error: errorMsg });
        throw error;
      }
      Logger.error('ContentService.sync:error', { kind, error: errorMsg });
      this.progressEmitter.emit('sync:error', { kind, error: errorMsg });
      throw error;
    }
  }

  /**
   * List items for a kind with optional simple filters
   * @param {'tokens'|'assets'} kind
   * @param {{text?:string,tier?:string,pathPrefix?:string,assetClass?:string,offset?:number,limit?:number}} [opts]
   * @returns {Promise<FaNexusInventoryListResult>}
   */
  async list(kind, opts = {}) { return this._dbFor(kind).query(kind, opts); }

  /**
   * Get a public thumbnail URL for an item
   * @param {'tokens'|'assets'} kind
   * @param {{id?:string,selected_source?:object}} item
   * @returns {string}
   */
  getThumbnailURL(kind, item) {
    return buildContentKindPublicUrl(kind, 'thumbnail', contentPath(item));
  }

  /**
   * Resolve a full download URL for an item, using signed URLs for premium content.
   * Results are cached in-memory by `urlCache`.
   * @param {'tokens'|'assets'} kind
   * @param {{id?:string,selected_source?:object,tier?:'free'|'premium'}} item
   * @param {string} [state] - OAuth state used for premium signed URLs
   * @param {{notifyTierRefusal?: boolean}} [options] - hover previews pass false: a refusal there stays silent
   * @returns {Promise<string>} Full URL or local path
   */
  async getFullURL(kind, item, state, { notifyTierRefusal = true } = {}) {
    if (!item) throw new Error('Missing item');
    getContentKindDescriptor(kind);
    const pRaw = contentPath(item);
    if (!pRaw) throw new Error('Missing item content path');
    const p = encodeCloudPath(pRaw);

    this.progressEmitter.emit('url:resolve', { kind, file_path: pRaw, tier: item.tier });

    if (item.tier === 'free') {
      const url = buildContentKindPublicUrl(kind, 'free', pRaw);
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
      // Since the 2026-10-26 tier split the download gate answers 401 for a tier without premium downloads and 403
      // for a missing or non-premium file. Only a 400 state/IP mismatch means the login expired (auth-state.js).
      const refusal = (status, payload, rawText) => {
        if (isStateMismatchResponse(status, payload?.error, payload?.message, rawText)) {
          return Object.assign(new Error('AUTH'), { code: 'STATE_INVALID', status, noRetry: true });
        }
        if (status === 401) {
          return createOperationalError(`Patreon tier refused for ${pRaw}`, {
            code: 'PATREON_TIER_REQUIRED', kind, source: 'getFullURL:fetch', operation: 'download',
            userMessage: PREMIUM_DOWNLOAD_TIER_MESSAGE, details: { status, message: payload?.message || null }
          });
        }
        if (status === 403) {
          return Object.assign(createOperationalError(`Premium file not available: ${pRaw} (403)`, {
            code: 'FA_NEXUS_CLOUD_FILE_UNAVAILABLE', kind, source: 'getFullURL:fetch', operation: 'download',
            userMessage: `This premium file isn't available for download: ${item.filename || pRaw} (403).`,
            details: { status, message: payload?.message || null }
          }), { status, faNexusCloudFileMissing: true });
        }
        return null;
      };
      const dl = this._downloadEndpoint(kind, p, state);
      const body = await retryWithBackoff(
        async () => {
          this.progressEmitter.emit('url:fetch', { kind, file_path: pRaw, url: dl });
          const res = await fetch(dl, { headers: { 'Accept': 'application/json' } });
          const rawText = await res.text();
          let payload = null;
          if (rawText) {
            try { payload = JSON.parse(rawText); } catch (_) {}
          }
          const refused = refusal(res.status, payload, rawText);
          if (refused) throw Object.assign(refused, { noRetry: true });
          if (!res.ok) throw new Error(`Signed URL fetch failed (${res.status})`);
          return payload;
        },
        {
          maxRetries: 2,
          initialDelay: 1000,
          maxDelay: 8000,
          shouldRetry: (error) => !error?.noRetry,
          onRetry: ({ attempt, maxRetries, delay }) => {
            this.progressEmitter.emit('url:retry', { kind, file_path: pRaw, attempt, maxRetries, delay });
            Logger.info('ContentService.url.retry', { kind, file_path: pRaw, attempt, maxRetries, delay });
          }
        }
      );

      if (!body || !body.success || !body.download_url) {
        throw new Error('Signed URL fetch failed');
      }

      this.urlCache.set(key, body.download_url);
      this.progressEmitter.emit('url:resolved', { kind, file_path: pRaw, tier: 'premium', url: body.download_url });
      return body.download_url;
    } catch (error) {
      const errorMsg = error?.message === 'AUTH' ? 'AUTH' : String(error?.message || error);
      if (error?.code === 'PATREON_TIER_REQUIRED' && notifyTierRefusal) this._notifyTierRefusal(error);
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
      // A refusal the server answered on purpose (expired login, tier, missing file) is not a client error.
      const logUrlError = (errorMsg === 'AUTH' || error?.noRetry) ? Logger.warn.bind(Logger) : Logger.error.bind(Logger);
      logUrlError('ContentService.url:error', { kind, file_path: pRaw, error: errorMsg });
      this.progressEmitter.emit('url:error', { kind, file_path: pRaw, error: errorMsg });
      throw error instanceof Error ? error : new Error(errorMsg);
    }
  }

  /**
   * Update the auth context used for automatic disconnect handling.
   * @param {FaNexusAuthContext} [context]
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

  /**
   * A signed-in member whose tier has no premium downloads stays connected. One message per burst of refusals: a
   * multi-select download asks once per file.
   */
  _notifyTierRefusal(error) {
    error.faNexusNotified = true;
    const now = Date.now();
    if (this._lastTierRefusalAt && (now - this._lastTierRefusalAt) < 5000) return;
    this._lastTierRefusalAt = now;
    Logger.warn('ContentService.download.tierRefused', { kind: error.kind, message: error.details?.message || null });
    ui?.notifications?.warn?.(error.userMessage);
  }

  /** Handle premium auth failures by clearing cache and disconnecting */
  async _handleAuthFailure({ reason = 'AUTH', kind = null, source = null, message = null, notify = true } = {}) {
    if (this._authDisconnectInFlight) return;
    const authData = this._readAuthData();
    const hasAuth = !!(authData && authData.authenticated && authData.state);
    if (!hasAuth) return;
    const now = Date.now();
    if (this._lastAuthFailureAt && (now - this._lastAuthFailureAt) < this._authDisconnectCooldownMs) {
      return;
    }
    this._lastAuthFailureAt = now;
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
    for (const db of [this._dbTokens, this._dbAssets]) {
      try { db?.close?.(); }
      catch (error) {
        Logger.warn('ContentService.destroy.dbCloseFailed', {
          db: db?.dbName || null,
          error: String(error?.message || error)
        });
      }
    }
  }
}

export class FaNexusOperationalError extends Error {
  constructor(message, {
    code = 'FA_NEXUS_OPERATION_FAILED',
    source = '',
    operation = '',
    settingKey = '',
    folder = '',
    kind = '',
    userMessage = '',
    cause = null,
    details = null
  } = {}) {
    super(message);
    this.name = 'FaNexusOperationalError';
    this.code = String(code || 'FA_NEXUS_OPERATION_FAILED');
    this.source = String(source || '');
    this.operation = String(operation || '');
    this.settingKey = String(settingKey || '');
    this.folder = String(folder || '');
    this.kind = String(kind || '');
    this.userMessage = String(userMessage || message || '');
    if (cause != null) this.cause = cause;
    if (details && typeof details === 'object') this.details = details;
  }
}

export function createOperationalError(message, options = {}) {
  return new FaNexusOperationalError(message, options);
}

function looksOperational(error) {
  if (!error || typeof error !== 'object') return false;
  return error instanceof FaNexusOperationalError
    || error.name === 'FaNexusOperationalError'
    || typeof error.code === 'string'
    || typeof error.userMessage === 'string'
    || typeof error.source === 'string';
}

export function wrapOperationalError(error, options = {}) {
  if (looksOperational(error)) return error;
  const message = options.message || String(error?.message || error || 'FA Nexus operation failed.');
  return new FaNexusOperationalError(message, {
    ...options,
    cause: options.cause ?? error ?? null
  });
}

export function formatOperationalError(error, fallback = 'FA Nexus operation failed.') {
  if (looksOperational(error)) {
    const userMessage = String(error?.userMessage || '').trim();
    if (userMessage) return userMessage;
    const message = String(error?.message || '').trim();
    return message || fallback;
  }
  const message = String(error?.message || error || '').trim();
  return message || fallback;
}

export function requireFilePickerMethod(method, {
  source = 'ContentService.requireFilePickerMethod',
  operation = '',
  settingKey = '',
  folder = '',
  kind = '',
  userMessage = ''
} = {}) {
  const runtimeFoundry = globalThis.foundry;
  const FilePickerBase = runtimeFoundry?.applications?.apps?.FilePicker ?? globalThis.FilePicker;
  const FilePickerImpl = FilePickerBase?.implementation ?? FilePickerBase;
  if (typeof FilePickerImpl?.[method] === 'function') return FilePickerImpl;
  throw createOperationalError(`FA Nexus could not resolve FilePicker.${method}.`, {
    code: 'FILEPICKER_UNAVAILABLE',
    source,
    operation: operation || method,
    settingKey,
    folder,
    kind,
    userMessage: userMessage || 'FA Nexus requires the Foundry FilePicker runtime for this operation.'
  });
}

function folderSettingLabel(settingKey) {
  if (settingKey === 'assetFolders') return 'Asset Sources';
  if (settingKey === 'tokenFolders') return 'Token Sources';
  return String(settingKey || 'folder settings');
}

/**
 * Parse enabled folder paths from the given fa-nexus setting key.
 * @param {string} settingKey
 * @returns {string[]}
 */
export function getEnabledFolders(settingKey) {
  if (!settingKey) return [];
  const label = folderSettingLabel(settingKey);
  const gameSettings = globalThis.game?.settings;
  if (!gameSettings?.get) {
    throw createOperationalError(`FA Nexus could not read the ${label} setting because game.settings.get is unavailable.`, {
      code: 'SETTINGS_UNAVAILABLE',
      source: 'ContentService.getEnabledFolders',
      operation: 'read-enabled-folders',
      settingKey,
      userMessage: `FA Nexus could not read the ${label} setting because the Foundry settings runtime is unavailable.`
    });
  }

  let raw;
  try {
    raw = gameSettings.get('fa-nexus', settingKey);
  } catch (error) {
    throw wrapOperationalError(error, {
      code: 'SETTINGS_READ_FAILED',
      source: 'ContentService.getEnabledFolders',
      operation: 'read-enabled-folders',
      settingKey,
      message: `FA Nexus could not read the ${label} setting.`,
      userMessage: `FA Nexus could not read the ${label} setting.`
    });
  }

  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch (error) {
    throw createOperationalError(`FA Nexus found invalid JSON in the ${label} setting.`, {
      code: 'SETTINGS_JSON_INVALID',
      source: 'ContentService.getEnabledFolders',
      operation: 'parse-enabled-folders',
      settingKey,
      userMessage: `FA Nexus found invalid JSON in the ${label} setting. Open the source dialog and resave that configuration.`,
      cause: error,
      details: { rawPreview: String(raw || '').slice(0, 160) }
    });
  }

  if (!Array.isArray(parsed)) {
    throw createOperationalError(`FA Nexus found invalid data in the ${label} setting.`, {
      code: 'SETTINGS_INVALID_SHAPE',
      source: 'ContentService.getEnabledFolders',
      operation: 'parse-enabled-folders',
      settingKey,
      userMessage: `FA Nexus found invalid data in the ${label} setting. Open the source dialog and resave that configuration.`,
      details: { valueType: typeof parsed }
    });
  }

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
}

const defaultKeySelector = (rec) => {
  if (!rec) return '';
  return String(rec.id || rec.url || '').trim();
};

/**
 * Collect cached and freshly streamed local items for an inventory-style tab.
 * @param {LocalInventoryConfig} config
 * @param {string} [config.loggerTag] - label used for logging context
 * @param {string[]} [config.folders] - explicit folder list (defaults to settingsKey)
 * @param {string} [config.settingsKey] - fa-nexus setting key containing folder entries
 * @param {{batchSize?:number,sleepMs?:number}} [config.streamOptions]
 * @returns {Promise<{folders:string[],cachedItems:FaNexusInventoryRecord[],localItems:FaNexusInventoryRecord[],streamedCount:number,cancelled:boolean}>}
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
      Logger.error(`${loggerTag}.cache.error`, { folder, error: String(e?.message || e) });
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
      const wrapped = wrapOperationalError(e, {
        code: 'LOCAL_STREAM_FAILED',
        source: `${loggerTag}.stream`,
        operation: 'collect-local-inventory',
        settingKey: settingsKey,
        folder,
        userMessage: `FA Nexus could not scan the configured folder "${folder}".`
      });
      Logger.error(`${loggerTag}.stream.error`, {
        folder,
        code: wrapped.code,
        source: wrapped.source,
        error: String(wrapped.message || wrapped)
      });
      throw wrapped;
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
 * @param {MergeLocalAndCloudRecordsOptions} [options]
 * @returns {FaNexusInventoryRecord[]}
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
