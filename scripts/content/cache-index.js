import { NexusLogger as Logger } from '../core/nexus-logger.js';

export class NexusIndexDB {
  /**
   * IndexedDB wrapper for caching large, folder-scoped indexes.
   * Provides both legacy single-record and chunked multi-record storage.
   * @param {string} [dbName='fa-nexus-index']
   */
  constructor(dbName = 'fa-nexus-index') {
    this.dbName = dbName;
    this.db = null;
    // Reasonable chunk size to keep individual records small
    this.CHUNK_SIZE = 7000;
  }

  /**
   * Open the database and ensure stores are created/upgraded
   * @returns {Promise<IDBDatabase>}
   * @private
   */
  async _open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Legacy single-record store
        if (!db.objectStoreNames.contains('indexes')) {
          const store = db.createObjectStore('indexes', { keyPath: ['type', 'folder'] });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('folder', 'folder', { unique: false });
        }
        // New chunked store for very large folders
        if (!db.objectStoreNames.contains('indexes2')) {
          const s2 = db.createObjectStore('indexes2', { keyPath: ['type', 'folder', 'chunk'] });
          s2.createIndex('type', 'type', { unique: false });
          s2.createIndex('folder', 'folder', { unique: false });
          s2.createIndex('tf', ['type', 'folder'], { unique: false });
        }
      };
      req.onsuccess = () => resolve((this.db = req.result));
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Load cached records for a given type and folder
   * @param {'assets'|'tokens'|string} type
   * @param {string} folder
   * @returns {Promise<Array<object>>}
   */
  async load(type, folder) {
    try {
      const db = await this._open();
      Logger.info('IndexDB.load:start', { type, folder });
      Logger.time(`idb-load:${type}:${folder}`);
      // Try chunked store first
      const chunked = await new Promise((resolve, reject) => {
        try {
          const tx = db.transaction('indexes2', 'readonly');
          const store = tx.objectStore('indexes2');
          const idx = store.index('tf');
          const out = [];
          const req = idx.openCursor(IDBKeyRange.only([type, folder]));
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) { out.push(cursor.value); cursor.continue(); }
            else resolve(out);
          };
          req.onerror = () => reject(req.error);
        } catch (e) {
          resolve([]);
        }
      });
      if (Array.isArray(chunked) && chunked.length) {
        // Sort by chunk index and concatenate
        chunked.sort((a,b) => (a.chunk||0) - (b.chunk||0));
        const merged = [];
        for (const c of chunked) if (Array.isArray(c.records)) merged.push(...c.records);
        Logger.info('IndexDB.load:chunked', { type, folder, chunks: chunked.length, count: merged.length });
        Logger.timeEnd(`idb-load:${type}:${folder}`);
        return merged;
      }
      // Fallback to legacy single-record store
      const legacy = await new Promise((resolve, reject) => {
        const tx = db.transaction('indexes', 'readonly');
        const store = tx.objectStore('indexes');
        const get = store.get([type, folder]);
        get.onsuccess = () => resolve(get.result?.records || []);
        get.onerror = () => reject(get.error);
      });
      Logger.info('IndexDB.load:legacy', { type, folder, count: Array.isArray(legacy) ? legacy.length : 0 });
      Logger.timeEnd(`idb-load:${type}:${folder}`);
      return legacy;
    } catch (_) { return []; }
  }

  /**
   * Save records for a given type and folder. Uses chunked storage when large.
   * @param {'assets'|'tokens'|string} type
   * @param {string} folder
   * @param {Array<object>} records
   * @returns {Promise<boolean>}
   */
  async save(type, folder, records) {
    try {
      const db = await this._open();
      const recs = Array.isArray(records) ? records : [];
      Logger.info('IndexDB.save:start', { type, folder, count: recs.length });
      Logger.time(`idb-save:${type}:${folder}`);
      // Use chunked store when large
      if (recs.length > this.CHUNK_SIZE) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('indexes2', 'readwrite');
          const store = tx.objectStore('indexes2');
          const idx = store.index('tf');
          // First delete existing chunks for this key
          const delReq = idx.openCursor(IDBKeyRange.only([type, folder]));
          delReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) { cursor.delete(); cursor.continue(); }
            else {
              // Put new chunks
              let chunkIndex = 0;
              for (let i = 0; i < recs.length; i += this.CHUNK_SIZE) {
                const slice = recs.slice(i, i + this.CHUNK_SIZE);
                store.put({ type, folder, chunk: chunkIndex++, records: slice });
              }
              resolve();
            }
          };
          delReq.onerror = () => reject(delReq.error);
        });
        Logger.info('IndexDB.save:chunked', { type, folder, chunks: Math.ceil(recs.length / this.CHUNK_SIZE) });
        Logger.timeEnd(`idb-save:${type}:${folder}`);
        return true;
      }
      // Small payloads go to legacy store for simplicity
      const payload = { type, folder, records: recs.slice() };
      await new Promise((resolve, reject) => {
        const tx = db.transaction('indexes', 'readwrite');
        const store = tx.objectStore('indexes');
        const put = store.put(payload);
        put.onsuccess = () => resolve();
        put.onerror = () => reject(put.error);
      });
      Logger.info('IndexDB.save:legacy', { type, folder, count: recs.length });
      Logger.timeEnd(`idb-save:${type}:${folder}`);
      return true;
    } catch (_) { return false; }
  }

  /**
   * Clear cached records for a given type and folder
   * @param {'assets'|'tokens'|string} type
   * @param {string} folder
   * @returns {Promise<boolean>}
   */
  async clear(type, folder) {
    try {
      const db = await this._open();
      Logger.info('IndexDB.clear', { type, folder });
      // Clear legacy
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['indexes','indexes2'], 'readwrite');
        // Legacy store
        try {
          const s1 = tx.objectStore('indexes');
          s1.delete([type, folder]);
        } catch (_) {}
        // Chunked store
        try {
          const s2 = tx.objectStore('indexes2');
          const idx = s2.index('tf');
          const req = idx.openCursor(IDBKeyRange.only([type, folder]));
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) { cursor.delete(); cursor.continue(); }
            else resolve();
          };
          req.onerror = () => reject(req.error);
        } catch (_) { resolve(); }
      });
      return true;
    } catch (_) { return false; }
  }

  /**
   * List known folders for a type with approximate record counts
   * @param {'assets'|'tokens'|string} type
   * @returns {Promise<Array<{folder:string,count:number}>>}
   */
  async list(type) {
    try {
      const db = await this._open();
      Logger.info('IndexDB.list:start', { type });
      const counts = new Map();
      // Aggregate chunked store
      await new Promise((resolve, reject) => {
        try {
          const tx = db.transaction('indexes2', 'readonly');
          const store = tx.objectStore('indexes2');
          const idx = store.index('type');
          const req = idx.openCursor(IDBKeyRange.only(type));
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              const { folder, records } = cursor.value || {};
              const n = Array.isArray(records) ? records.length : 0;
              counts.set(folder, (counts.get(folder) || 0) + n);
              cursor.continue();
            } else resolve();
          };
          req.onerror = () => reject(req.error);
        } catch (_) { resolve(); }
      });
      // Add legacy entries
      await new Promise((resolve, reject) => {
        try {
          const tx = db.transaction('indexes', 'readonly');
          const store = tx.objectStore('indexes');
          const idx = store.index('type');
          const req = idx.openCursor(IDBKeyRange.only(type));
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              const val = cursor.value;
              const n = Array.isArray(val.records) ? val.records.length : 0;
              counts.set(val.folder, Math.max(counts.get(val.folder) || 0, n));
              cursor.continue();
            } else resolve();
          };
          req.onerror = () => reject(req.error);
        } catch (_) { resolve(); }
      });
      const result = Array.from(counts.entries()).map(([folder, count]) => ({ folder, count }));
      Logger.info('IndexDB.list:done', { type, entries: result.length });
      return result;
    } catch (_) { return []; }
  }

  /**
   * Clear all cached folders for the given type
   * @param {'assets'|'tokens'|string} type
   * @returns {Promise<boolean>}
   */
  async clearAll(type) {
    try {
      const db = await this._open();
      const entries = await this.list(type);
      for (const { folder } of entries) {
        await this.clear(type, folder);
      }
      return true;
    } catch (_) { return false; }
  }
}
