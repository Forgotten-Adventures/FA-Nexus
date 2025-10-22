import { localToAssetInventoryRecord } from '../content/inventory-utils.js';
import { NexusIndexDB } from '../content/cache-index.js';
import { forgeIntegration } from '../core/forge-integration.js';

export class AssetsDataService {
  /** Create a new assets data service */
  constructor() {
    this.indexDB = new NexusIndexDB('fa-nexus-index');
    this._dimCache = new Map();
    this._dimInflight = new Map();
  }

  /** Load cached assets index for a folder from IndexedDB */
  async loadCachedAssets(folder) {
    return await this.indexDB.load('assets', folder);
  }

  /** Save assets index for a folder to IndexedDB */
  async saveAssetsIndex(folder, records) {
    return await this.indexDB.save('assets', folder, records);
  }

  /**
   * Stream local assets in batches and emit canonical records per batch
   * @param {string} folder
   * @param {(records:Array<object>)=>Promise<void>|void} onBatch
   * @param {{batchSize?:number,sleepMs?:number}} options
   * @returns {Promise<number>} total files discovered
   */
  async streamLocalAssets(folder, onBatch, options = {}) {
    if (!folder) return 0;
    await forgeIntegration.initialize();
    const FilePickerBase = foundry.applications.apps.FilePicker ?? globalThis.FilePicker;
    const FilePickerImpl = FilePickerBase?.implementation ?? FilePickerBase;
    if (!FilePickerImpl?.browse) {
      console.warn('fa-nexus | asset stream missing FilePicker implementation');
      return 0;
    }
    const { source: resolvedSource, target: initialTarget, options: resolvedOptions, fallbacks } =
      forgeIntegration.resolveFilePickerContext(folder);
    const primarySource = resolvedSource || (forgeIntegration.isRunningOnForge() ? 'forgevtt' : 'data');
    const baseOptions = Object.assign({}, resolvedOptions || {});
    const fallbackSources = Array.isArray(fallbacks) ? fallbacks.slice() : [];
    const allowedExtensions = new Set(['.png', '.webp', '.jpg', '.jpeg', '.webm', '.mp4', '.ogg']);
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
        console.warn('fa-nexus | asset stream scan error', error);
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
          const record = localToAssetInventoryRecord({ path: filePath, url: filePath, filename });
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

  async getActualDimensions(asset) {
    if (!asset) return null;
    const key = this._dimensionKey(asset);
    if (!key) return null;
    if (this._dimCache.has(key)) return this._dimCache.get(key);
    if (this._dimInflight.has(key)) return this._dimInflight.get(key);
    const promise = this._computeDimensions(asset, key).finally(() => {
      this._dimInflight.delete(key);
    });
    this._dimInflight.set(key, promise);
    return promise;
  }

  _dimensionKey(asset) {
    const local = asset?.cachedLocalPath || asset?.cached || asset?.localPath;
    if (local) return String(local);
    const fallback = asset?.file_path || asset?.path || '';
    return fallback ? String(fallback) : null;
  }

  async _computeDimensions(asset, key) {
    const url = this._dimensionSource(asset);
    if (!url) return null;
    const lower = String(url).toLowerCase();
    const isVideo = /(\.webm|\.mp4|\.ogg)$/i.test(lower);
    const loader = isVideo ? document.createElement('video') : new Image();
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        try {
          if (isVideo) {
            loader.onloadedmetadata = loader.onerror = null;
            loader.removeAttribute('src');
            loader.load?.();
          } else {
            loader.onload = loader.onerror = null;
          }
        } catch (_) {}
      };
      const finish = (dims) => {
        if (settled) return;
        cleanup();
        if (dims && dims.width && dims.height) {
          const rounded = {
            width: Math.round(dims.width),
            height: Math.round(dims.height)
          };
          this._dimCache.set(key, rounded);
          resolve(rounded);
        } else {
          resolve(null);
        }
      };
      const onError = () => finish(null);
      if (isVideo) {
        loader.preload = 'metadata';
        loader.onloadedmetadata = () => {
          finish({ width: loader.videoWidth || 0, height: loader.videoHeight || 0 });
        };
        loader.onerror = onError;
        loader.src = url;
      } else {
        loader.onload = () => {
          finish({ width: loader.naturalWidth || loader.width || 0, height: loader.naturalHeight || loader.height || 0 });
        };
        loader.onerror = onError;
        try { loader.crossOrigin = 'anonymous'; } catch (_) {}
        loader.src = url;
      }
    });
  }

  _dimensionSource(asset) {
    let local = asset?.cachedLocalPath || asset?.file_path || asset?.path || '';
    if (!local) return null;
    if (/^https?:/i.test(local)) return local;
    if (forgeIntegration.isRunningOnForge() && !/^modules\//i.test(local) && !/^systems\//i.test(local) && !/^worlds\//i.test(local) && !/^data:/i.test(local)) {
      local = forgeIntegration.optimizeCacheURL(local);
      if (/^https?:/i.test(local)) return local;
    }
    return this._encodePath(local);
  }

  _encodePath(p) {
    try { return encodeURI(decodeURI(String(p))); }
    catch (_) {
      try { return encodeURI(String(p)); }
      catch (_) { return String(p); }
    }
  }
}
