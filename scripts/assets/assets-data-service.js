import { localToAssetInventoryRecord } from '../content/inventory-utils.js';
import { contentPath } from '../content/cloud-inventory-v2.js';
import { NexusIndexDB } from '../content/cache-index.js';
import { streamLocalContent } from '../content/local-content-scanner.js';
import { forgeIntegration } from '../storage/forge-integration.js';

/**
 * @typedef {import('../core/fa-nexus-types.js').FaNexusInventoryRecord} FaNexusInventoryRecord
 */

const ASSET_LOCAL_CONTENT_EXTENSIONS = Object.freeze([
  '.png',
  '.webp',
  '.jpg',
  '.jpeg',
  '.webm',
  '.mp4'
]);

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
   * @param {(records:FaNexusInventoryRecord[])=>Promise<void>|void} onBatch
   * @param {{batchSize?:number,sleepMs?:number}} options
   * @returns {Promise<number>} total files discovered
   */
  async streamLocalAssets(folder, onBatch, options = {}) {
    return await streamLocalContent({
      folder,
      contentKind: 'assets',
      itemLabel: 'asset',
      owner: 'AssetsDataService.streamLocalAssets',
      supportedExtensions: ASSET_LOCAL_CONTENT_EXTENSIONS,
      mapRecord: localToAssetInventoryRecord,
      onBatch,
      options
    });
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
    const fallback = contentPath(asset) || asset?.file_path || asset?.path || '';
    return fallback ? String(fallback) : null;
  }

  async _computeDimensions(asset, key) {
    const url = this._dimensionSource(asset);
    if (!url) return null;
    const lower = String(url).toLowerCase();
    const isVideo = /(\.webm|\.mp4)$/i.test(lower);
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
    let local = asset?.cachedLocalPath || contentPath(asset) || asset?.file_path || asset?.path || '';
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
