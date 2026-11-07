import { localToTokenInventoryRecord } from '../content/inventory-utils.js';
import { NexusIndexDB } from '../content/cache-index.js';
import { streamLocalContent } from '../content/local-content-scanner.js';

/**
 * @typedef {import('../core/fa-nexus-types.js').FaNexusInventoryRecord} FaNexusInventoryRecord
 */

const TOKEN_LOCAL_CONTENT_EXTENSIONS = Object.freeze(['.png', '.webp', '.jpg', '.jpeg']);

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
   * @param {(records:FaNexusInventoryRecord[])=>Promise<void>|void} onBatch
   * @param {{batchSize?:number,sleepMs?:number}} options
   * @returns {Promise<number>} total files discovered
   */
  async streamLocalTokens(folder, onBatch, options = {}) {
    return await streamLocalContent({
      folder,
      contentKind: 'tokens',
      itemLabel: 'token',
      owner: 'TokenDataService.streamLocalTokens',
      supportedExtensions: TOKEN_LOCAL_CONTENT_EXTENSIONS,
      mapRecord: localToTokenInventoryRecord,
      onBatch,
      options
    });
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
