import { localToTokenInventoryRecord } from '../content/inventory-utils.js';
import { NexusIndexDB } from '../content/cache-index.js';
import { forgeIntegration } from '../core/forge-integration.js';

/**
 * TokenDataService (local-only scaffold)
 * - Scans configured local folder
 * - Indexes into cloud-parity inventory records
 */
export class TokenDataService {
  constructor() {
    this.indexDB = new NexusIndexDB('fa-nexus-index');
    this._sizeCache = new Map();
    this._sizeInflight = new Map();
  }

  async loadCachedTokens(folder) {
    return await this.indexDB.load('tokens', folder);
  }

  async saveTokensIndex(folder, records) {
    return await this.indexDB.save('tokens', folder, records);
  }

  async clearTokensIndex(folder) {
    return await this.indexDB.clear('tokens', folder);
  }

  /**
   * Public helper to get file size with simple caching across calls.
   * @param {string} url
   * @returns {Promise<number>} bytes (0 if unknown)
   */
  async getFileSize(url) {
    if (!url) return 0;
    if (this._sizeCache.has(url)) return this._sizeCache.get(url);
    if (this._sizeInflight.has(url)) return this._sizeInflight.get(url);
    const p = this._fetchFileSize(url).then((n) => {
      const size = Number.isFinite(n) ? n : 0;
      this._sizeCache.set(url, size);
      this._sizeInflight.delete(url);
      return size;
    }).catch(() => {
      this._sizeInflight.delete(url);
      return 0;
    });
    this._sizeInflight.set(url, p);
    return p;
  }

  /**
   * Stream local tokens in batches and emit canonical records per batch
   * (indexing-time file size fetching removed for performance)
   * @param {string} folder
   * @param {(records:Array<object>)=>Promise<void>|void} onBatch
   * @param {{batchSize?:number,sleepMs?:number}} options
   * @returns {Promise<number>} total files discovered
   */
  async streamLocalTokens(folder, onBatch, options = {}) {
    if (!folder) return 0;
    await forgeIntegration.initialize();
    const FilePickerBase = foundry.applications.apps.FilePicker ?? globalThis.FilePicker;
    const FilePickerImpl = FilePickerBase?.implementation ?? FilePickerBase;
    if (!FilePickerImpl?.browse) {
      console.warn('fa-nexus | token stream missing FilePicker implementation');
      return 0;
    }
    const { source: resolvedSource, target: initialTarget, options: resolvedOptions, fallbacks } =
      forgeIntegration.resolveFilePickerContext(folder);
    const primarySource = resolvedSource || (forgeIntegration.isRunningOnForge() ? 'forgevtt' : 'data');
    const baseOptions = Object.assign({}, resolvedOptions || {});
    const fallbackSources = Array.isArray(fallbacks) ? fallbacks.slice() : [];
    const allowedExtensions = new Set(['.png', '.webp', '.jpg', '.jpeg']);
    const batchSize = Math.max(25, Math.min(500, Number(options.batchSize) || 200));
    const sleepMs = Math.max(0, Math.min(50, Number(options.sleepMs) || 8));
    const signal = options.signal || null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const abortError = () => {
      try { return new DOMException(signal?.reason || 'Cancelled', 'AbortError'); }
      catch (_) {
        const err = new Error(signal?.reason || 'Cancelled');
        err.name = 'AbortError';
        return err;
      }
    };
    const checkAbort = () => {
      if (signal?.aborted) throw abortError();
    };

    const queue = [forgeIntegration.normalizeFilePickerTarget(primarySource, initialTarget || '')];
    const visited = new Set();
    let batch = [];
    let total = 0;

    const browseWithFallback = async (targetPath) => {
      const attempts = [];
      attempts.push({ source: primarySource, options: baseOptions });
      for (const fb of fallbackSources) {
        if (!fb || fb === primarySource) continue;
        const opts = fb === 'forgevtt' ? baseOptions : {};
        attempts.push({ source: fb, options: opts });
      }
      let lastError = null;
      for (const attempt of attempts) {
        try {
          const opts = Object.keys(attempt.options || {}).length ? Object.assign({}, attempt.options) : {};
          return await FilePickerImpl.browse(attempt.source, targetPath, opts);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    };

    while (queue.length) {
      checkAbort();
      const nextTarget = String(queue.shift() ?? '');
      if (visited.has(nextTarget)) continue;
      visited.add(nextTarget);
      let listing;
      try {
        listing = await browseWithFallback(nextTarget);
      } catch (error) {
        console.warn('fa-nexus | stream scan error', error);
        continue;
      }
      checkAbort();
      for (const filePath of listing.files) {
        checkAbort();
        const dotIndex = filePath.lastIndexOf('.');
        const ext = dotIndex !== -1 ? filePath.slice(dotIndex).toLowerCase() : '';
        if (!ext || !allowedExtensions.has(ext)) continue;
        const filename = filePath.split('/').pop();
        try {
          const record = localToTokenInventoryRecord({ path: filePath, url: filePath, filename });
          if (forgeIntegration.isRunningOnForge()) {
            if (record.path) record.path = forgeIntegration.optimizeCacheURL(record.path);
            if (record.url) record.url = forgeIntegration.optimizeCacheURL(record.url);
            if (record.cachedLocalPath) record.cachedLocalPath = forgeIntegration.optimizeCacheURL(record.cachedLocalPath);
          }
          batch.push(record);
        } catch (_) {}
        if (batch.length >= batchSize) {
          const emitBatch = batch.slice();
          try { await onBatch?.(emitBatch); } catch (e) { console.warn('fa-nexus | onBatch error:', e); }
          total += batch.length;
          batch = [];
          if (sleepMs) {
            await sleep(sleepMs);
            checkAbort();
          }
        }
      }
      for (const dir of listing.dirs || []) {
        checkAbort();
        const normalized = forgeIntegration.normalizeFilePickerTarget(primarySource, dir);
        queue.push(normalized);
      }
    }
    if (batch.length) {
      const emitBatch = batch.slice();
      try { await onBatch?.(emitBatch); } catch (e) { console.warn('fa-nexus | onBatch error:', e); }
      total += batch.length;
    }
    return total;
  }

  // Size fetching is used on-demand via getFileSize(url) during hover preview

  async _fetchFileSize(url) {
    // Try HEAD first
    try {
      const resp = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      const h = resp.headers.get('content-length') || resp.headers.get('Content-Length');
      const size = h ? Number(h) : NaN;
      if (Number.isFinite(size)) return size;
    } catch (_) {}
    // Fallback: Range GET first byte to read Content-Range
    try {
      const resp = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      const cr = resp.headers.get('content-range') || resp.headers.get('Content-Range');
      if (cr && /\/(\d+)$/.test(cr)) {
        const m = cr.match(/\/(\d+)$/);
        const size = m ? Number(m[1]) : NaN;
        if (Number.isFinite(size)) return size;
      }
      const h = resp.headers.get('content-length') || resp.headers.get('Content-Length');
      const size = h ? Number(h) : NaN;
      if (Number.isFinite(size)) return size;
    } catch (_) {}
    return 0;
  }
}
