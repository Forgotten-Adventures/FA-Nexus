// CloudDB — IndexedDB wrapper for cloud manifests (tokens, assets)
// Stores: items_<kind> (key: file_path), meta_<kind> (single key 'meta')

import { NexusLogger as Logger } from '../core/nexus-logger.js';

function abortError() {
  return new DOMException('Operation aborted', 'AbortError');
}

/**
 * CloudDB
 * Lightweight IndexedDB wrapper for storing cloud manifests for tokens and assets.
 *
 * Object stores per kind:
 * - `items_<kind>`: keyed by `file_path`, holds inventory records
 * - `meta_<kind>`: single record keyed by `id='meta'`, tracks `latest` hash and counts
 */
export class CloudDB {
  // Track live instances so we can proactively close all connections to enable deleteDatabase
  static _instances = new Set();
  static _safeCloseInstance(inst) {
    try { inst?.db?.close?.(); } catch (_) {}
    try { inst.db = null; } catch (_) {}
  }
  static closeAll(dbName) {
    try {
      for (const inst of CloudDB._instances) {
        if (!dbName || inst?.dbName === dbName) CloudDB._safeCloseInstance(inst);
      }
    } catch (_) {}
  }
  /**
   * @param {string} [dbName='fa-nexus-cloud-v1'] - IndexedDB database name
   */
  constructor(dbName = 'fa-nexus-cloud-v1') {
    this.dbName = dbName;
    this.db = null;
    this.CHUNK_SIZE = 7000;
    try { CloudDB._instances.add(this); } catch (_) {}
  }

  /**
   * Open the IndexedDB connection (creates stores on first open)
   * @returns {Promise<IDBDatabase>}
   * @private
   */
  async _open() {
    if (this.db) return this.db;
    Logger.info('CloudDB.open', { db: this.dbName });
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        const ensureStoresFor = (kind) => {
          const items = `items_${kind}`;
          const meta = `meta_${kind}`;
          const items2 = `items2_${kind}`;
          if (!db.objectStoreNames.contains(items)) {
            const s = db.createObjectStore(items, { keyPath: 'file_path' });
            try { s.createIndex('filename', 'filename', { unique: false }); } catch (_) {}
            try { s.createIndex('path', 'path', { unique: false }); } catch (_) {}
            try { s.createIndex('tier', 'tier', { unique: false }); } catch (_) {}
          }
          if (!db.objectStoreNames.contains(meta)) {
            db.createObjectStore(meta, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(items2)) {
            db.createObjectStore(items2, { keyPath: 'chunk' });
          }
        };
        ensureStoresFor('tokens');
        ensureStoresFor('assets');
      };
      req.onsuccess = () => {
        const db = (this.db = req.result);
        try {
          db.onversionchange = () => {
            try { db.close(); } catch (_) {}
            if (this.db === db) this.db = null;
          };
        } catch (_) {}
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get the `items_<kind>` object store on an active transaction
   * @param {'tokens'|'assets'} kind
   * @param {'readonly'|'readwrite'} [mode='readonly']
   * @returns {IDBObjectStore}
   * @private
   */
  _itemsStore(kind, mode = 'readonly') {
    const tx = this.db.transaction([`items_${kind}`], mode);
    return tx.objectStore(`items_${kind}`);
  }
  /**
   * Get the `meta_<kind>` object store on an active transaction
   * @param {'tokens'|'assets'} kind
   * @param {'readonly'|'readwrite'} [mode='readonly']
   * @returns {IDBObjectStore}
   * @private
   */
  _metaStore(kind, mode = 'readonly') {
    const tx = this.db.transaction([`meta_${kind}`], mode);
    return tx.objectStore(`meta_${kind}`);
  }

  /**
   * Replace all items for a kind
   * @param {'tokens'|'assets'} kind
   * @param {Array<object>} items - Canonical inventory records
   * @param {{onProgress?:(count:number,total:number)=>void,progressBatch?:number,signal?:AbortSignal}} [options]
   * @returns {Promise<boolean>}
   */
  async replaceAll(kind, items, options = {}) {
    const db = await this._open();
    const arr = Array.isArray(items) ? items : [];
    const total = arr.length;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const progressBatch = Math.max(100, Number(options.progressBatch) || 2000);
    const signal = options.signal || null;
    if (signal?.aborted) throw abortError();
    let inserted = 0;
    let lastEmit = -1;
    const emit = (force = false) => {
      if (!onProgress) return;
      const count = Math.min(total, Math.max(0, inserted));
      if (!force && count === lastEmit) return;
      if (!force && count !== total && lastEmit >= 0 && (count - lastEmit) < progressBatch) return;
      lastEmit = count;
      try { onProgress(count, total); } catch (_) {}
    };
    Logger.info('CloudDB.replaceAll:start', { kind, count: total });
    if (onProgress) emit(true); // initial fire (0/total)
    return new Promise((resolve, reject) => {
      let settled = false;
      let txClear = null;
      let txPut = null;
      let txChunks = null;
      const cleanupSignal = () => { if (signal) signal.removeEventListener('abort', onSignalAbort); };
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanupSignal();
        resolve(value);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        cleanupSignal();
        reject(error);
      };
      const abortTransactions = () => {
        try { txClear?.abort(); } catch (_) {}
        try { txPut?.abort(); } catch (_) {}
        try { txChunks?.abort(); } catch (_) {}
      };
      const checkAbort = () => {
        if (!signal?.aborted) return false;
        abortTransactions();
        finishReject(abortError());
        return true;
      };
      const onSignalAbort = () => {
        if (settled) return;
        abortTransactions();
        finishReject(abortError());
      };
      if (signal) {
        if (signal.aborted) { finishReject(abortError()); return; }
        signal.addEventListener('abort', onSignalAbort, { once: true });
      }
      try {
        // Clear both per-item and chunked stores first
        txClear = db.transaction([`items_${kind}`, `items2_${kind}`], 'readwrite');
        txClear.objectStore(`items_${kind}`).clear();
        txClear.objectStore(`items2_${kind}`).clear();
        txClear.oncomplete = () => {
          if (checkAbort()) return;
          if (!total) {
            emit(true);
            finishResolve(true);
            return;
          }
          // Populate per-item store
          txPut = db.transaction([`items_${kind}`], 'readwrite');
          const sPut = txPut.objectStore(`items_${kind}`);
          let i = 0;
          const putNext = () => {
            if (settled) return;
            if (checkAbort()) return;
            if (i >= arr.length) {
              // Build chunked store for fast bulk reads
              txChunks = db.transaction([`items2_${kind}`], 'readwrite');
              const s2 = txChunks.objectStore(`items2_${kind}`);
              let chunkIndex = 0;
              const sorted = arr.slice().sort((a, b) => String(a?.file_path || '').localeCompare(String(b?.file_path || '')));
              for (let j = 0; j < sorted.length; j += this.CHUNK_SIZE) {
                if (settled) return;
                if (checkAbort()) return;
                const slice = sorted.slice(j, j + this.CHUNK_SIZE);
                inserted = Math.min(total, j + slice.length);
                emit();
                s2.put({ chunk: chunkIndex++, records: slice });
              }
              txChunks.oncomplete = () => {
                inserted = total;
                emit(true);
                finishResolve(true);
              };
              txChunks.onerror = () => finishReject(txChunks.error);
              return;
            }
            const rec = arr[i++];
            const req = sPut.put(rec);
            req.onsuccess = () => {
              if (settled) return;
              inserted = i;
              emit();
              putNext();
            };
            req.onerror = () => finishReject(req.error);
          };
          txPut.onerror = () => finishReject(txPut.error);
          putNext();
        };
        txClear.onerror = () => finishReject(txClear.error);
      } catch (e) { finishReject(e); }
    });
  }

  /**
   * Apply a JSON-lines delta operation
   * @param {'tokens'|'assets'} kind
   * @param {{op:'add'|'up'|'del', item?:object, file_path?:string}} op
   * @returns {Promise<boolean>}
   */
  async applyDelta(kind, op) {
    const db = await this._open();
    Logger.debug('CloudDB.applyDelta', { kind, op: op?.op });
    const items = db.transaction([`items_${kind}`], 'readwrite').objectStore(`items_${kind}`);
    return new Promise((resolve, reject) => {
      try {
        if (!op || typeof op !== 'object') { resolve(false); return; }
        if (op.op === 'add' || op.op === 'up') {
          const req = items.put(op.item);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        } else if (op.op === 'del') {
          const req = items.delete(op.file_path);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        } else resolve(false);
      } catch (e) { reject(e); }
    });
  }

  /**
   * Rebuild chunked store from per-item store (used if chunks missing)
   * @param {'tokens'|'assets'} kind
   * @returns {Promise<boolean>}
   */
  async rebuildChunks(kind) {
    const db = await this._open();
    try {
      const all = await new Promise((resolve) => {
        const out = [];
        try {
          const s = db.transaction([`items_${kind}`], 'readonly').objectStore(`items_${kind}`);
          const req = s.openCursor();
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) { out.push(cursor.value); cursor.continue(); }
            else resolve(out);
          };
          req.onerror = () => resolve(out);
        } catch (_) { resolve(out); }
      });
      await new Promise((resolve, reject) => {
        try {
          const tx = db.transaction([`items2_${kind}`], 'readwrite');
          const s2 = tx.objectStore(`items2_${kind}`);
          s2.clear();
          let chunkIndex = 0;
          const sorted = all.slice().sort((a, b) => String(a?.file_path || '').localeCompare(String(b?.file_path || '')));
          for (let i = 0; i < sorted.length; i += this.CHUNK_SIZE) {
            const slice = sorted.slice(i, i + this.CHUNK_SIZE);
            s2.put({ chunk: chunkIndex++, records: slice });
          }
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        } catch (e) { resolve(false); }
      });
      return true;
    } catch (_) { return false; }
  }

  /**
   * Persist meta info for a kind
   * @param {'tokens'|'assets'} kind
   * @param {{id?:'meta',latest?:string,count?:number,builtAt?:string}} meta
   * @returns {Promise<boolean>}
   */
  async setMeta(kind, meta) {
    const db = await this._open();
    const s = db.transaction([`meta_${kind}`], 'readwrite').objectStore(`meta_${kind}`);
    return new Promise((resolve, reject) => {
      const payload = Object.assign({ id: 'meta' }, meta || {});
      const req = s.put(payload);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Read meta info for a kind
   * @param {'tokens'|'assets'} kind
   * @returns {Promise<object|null>}
   */
  async getMeta(kind) {
    const db = await this._open();
    const s = db.transaction([`meta_${kind}`], 'readonly').objectStore(`meta_${kind}`);
    return new Promise((resolve) => {
      const req = s.get('meta');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  /**
   * Get the latest hash recorded for a kind
   * @param {'tokens'|'assets'} kind
   * @returns {Promise<string|null>}
   */
  async getLatest(kind) {
    const meta = await this.getMeta(kind);
    return meta?.latest || null;
  }

  /**
   * Count items stored for a kind
   * @param {'tokens'|'assets'} kind
   * @returns {Promise<number>}
   */
  async count(kind) {
    const db = await this._open();
    const s = db.transaction([`items_${kind}`], 'readonly').objectStore(`items_${kind}`);
    return new Promise((resolve) => {
      try {
        const req = s.count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => resolve(0);
      } catch (_) { resolve(0); }
    });
  }

  /**
   * Query items with simple client-side filtering and pagination
   * @param {'tokens'|'assets'} kind
   * @param {{text?:string,tier?:string,pathPrefix?:string,offset?:number,limit?:number,onProgress?:(count:number,total:number)=>void,progressBatch?:number,signal?:AbortSignal}} [opts]
   * @returns {Promise<{items:Array<object>, total:number}>}
   */
  async query(kind, opts = {}) {
    const db = await this._open();
    const signal = opts.signal || null;
    const promiseWithAbort = (executor) => new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
      const onAbort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(abortError());
      };
      if (signal) {
        if (signal.aborted) { reject(abortError()); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      executor({
        resolve: (value) => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(error);
        }
      });
    });
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const progressBatch = Math.max(25, Number(opts.progressBatch) || 1000);
    let totalHint = 0;
    if (onProgress) {
      try {
        const meta = await this.getMeta(kind);
        totalHint = Number(meta?.count) || 0;
        Logger.info('CloudDB.query:meta', { kind, totalHint });
      } catch (_) {}
    }
    const store = db.transaction([`items_${kind}`], 'readonly').objectStore(`items_${kind}`);
    Logger.time(`CloudDB.query:${kind}`);
    if (signal?.aborted) throw abortError();

    const text = String(opts.text || '').toLowerCase();
    const tier = opts.tier || null;
    const pathPrefix = opts.pathPrefix || '';
    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.max(0, Number(opts.limit) || 0);
    const sortBy = opts.sortBy || 'file_path';
    const sortDir = opts.sortDir === 'desc' ? 'desc' : 'asc';

    // Helper to build a path range for prefix scans
    const pathRange = pathPrefix ? IDBKeyRange.bound(pathPrefix, `${pathPrefix}\uffff`) : null;

    // Fast path: no filters, no pagination -> use chunked store or getAll()
    let lastProgressCount = 0;
    const formatProgress = (count, totalOverride) => {
      if (!onProgress || !count) return;
      lastProgressCount = count;
      const total = totalOverride ?? totalHint ?? 0;
      try {
        onProgress(count, total);
        Logger.info('CloudDB.query:progress', { kind, count, total });
      } catch (_) {}
    };
    const emitProgress = (count, totalOverride) => {
      if (!onProgress || !count) return;
      if (!lastProgressCount || (count - lastProgressCount) >= progressBatch) {
        formatProgress(count, totalOverride);
      }
    };

    if (!text && !tier && !pathPrefix && !offset && !limit) {
      // Try chunked
      const chunks = await promiseWithAbort(({ resolve }) => {
        try {
          const s2 = db.transaction([`items2_${kind}`], 'readonly').objectStore(`items2_${kind}`);
          const req = s2.getAll();
          req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
          req.onerror = () => resolve([]);
        } catch (_) { resolve([]); }
      });
      if (signal?.aborted) throw abortError();
      if (Array.isArray(chunks) && chunks.length) {
        Logger.info('CloudDB.query:mode', { kind, mode: 'chunks', chunks: chunks.length });
        const merged = [];
        let seen = 0;
        for (const c of chunks) {
          if (!Array.isArray(c?.records) || !c.records.length) continue;
          merged.push(...c.records);
          seen += c.records.length;
          emitProgress(seen);
        }
        if (onProgress && seen > lastProgressCount) formatProgress(seen, totalHint || seen);
        if (sortBy === 'file_path' && sortDir === 'desc') merged.reverse();
        const total = merged.length;
        if (onProgress && !totalHint && total && lastProgressCount < total) formatProgress(total, total);
        Logger.timeEnd(`CloudDB.query:${kind}`);
        return { items: merged, total };
      }
      // Fallback to getAll and rebuild chunks in background
      Logger.info('CloudDB.query:mode', { kind, mode: 'cursor-fallback' });
      this.rebuildChunks(kind).catch(() => {});
      const items = await promiseWithAbort(({ resolve }) => {
        const out = [];
        try {
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) { resolve(out); return; }
            out.push(cursor.value);
            emitProgress(out.length, totalHint || 0);
            cursor.continue();
          };
          req.onerror = () => resolve(out);
        } catch (_) { resolve(out); }
      });
      if (signal?.aborted) throw abortError();
      if (onProgress && items.length > lastProgressCount) formatProgress(items.length, totalHint || items.length);
      if (sortBy === 'file_path') {
        items.sort((a, b) => String(a?.file_path || '').localeCompare(String(b?.file_path || '')));
        if (sortDir === 'desc') items.reverse();
      }
      const total = items.length;
      Logger.timeEnd(`CloudDB.query:${kind}`);
      return { items, total };
    }

    // Choose primary scan source to minimize iteration:
    // Priority: path prefix (most selective), else tier index, else full store
    let primarySource = store;
    let useRange = null;
    let needsPostFilterTier = false;
    let needsPostFilterPath = false;
    try {
      if (pathRange) {
        primarySource = store.index('path');
        useRange = pathRange;
        needsPostFilterTier = !!tier;
      } else if (tier) {
        primarySource = store.index('tier');
        useRange = IDBKeyRange.only(tier);
      }
    } catch (_) {
      // If indexes are missing for any reason, fall back to full store
      primarySource = store;
      useRange = null;
      needsPostFilterTier = !!tier;
      needsPostFilterPath = !!pathPrefix;
    }

    // Collect matching items, then sort and paginate
    const matched = await promiseWithAbort(({ resolve }) => {
      const out = [];
      try {
        Logger.info('CloudDB.query:mode', { kind, mode: 'filtered-cursor', hasText: !!text, hasTier: !!tier, hasPrefix: !!pathPrefix });
        const req = primarySource.openCursor ? primarySource.openCursor(useRange || undefined) : store.openCursor();
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) { resolve(out); return; }
          const v = cursor.value;
          let ok = true;
          if (needsPostFilterTier) ok = ok && String(v.tier || '') === tier;
          if (needsPostFilterPath) ok = ok && String(v.path || '').startsWith(pathPrefix);
          if (ok && text) {
            const fields = [v.display_name, v.filename, v.path, ...(Array.isArray(v.tags) ? v.tags.join(' ') : [])];
            ok = fields.some(val => String(val || '').toLowerCase().includes(text));
          }
          if (ok) {
            out.push(v);
            emitProgress(out.length);
          }
          cursor.continue();
        };
        req.onerror = () => resolve(out);
      } catch (_) { resolve(out); }
    });
    if (signal?.aborted) throw abortError();
    if (onProgress && matched.length > lastProgressCount) formatProgress(matched.length, totalHint || matched.length);

    const total = matched.length;
    if (sortBy === 'file_path') {
      matched.sort((a, b) => String(a?.file_path || '').localeCompare(String(b?.file_path || '')));
      if (sortDir === 'desc') matched.reverse();
    }
    const page = limit ? matched.slice(offset, offset + limit) : (offset ? matched.slice(offset) : matched);

    Logger.timeEnd(`CloudDB.query:${kind}`);
    return { items: page, total };
  }

  /**
   * Clear both items and meta for a kind
   * @param {'tokens'|'assets'} kind
   * @returns {Promise<boolean>}
   */
  async clear(kind, options = {}) {
    const useFastDrop = options.fastDrop !== false; // default: try fast path
    // Fast path: drop the entire database for this cloud cache
    if (useFastDrop) {
      try {
        // Proactively close all live connections from this runtime
        CloudDB.closeAll(this.dbName);
        Logger.info('CloudDB.clear:fast-drop:begin', { db: this.dbName, kind });
        const attemptDrop = () => new Promise((resolve) => {
          try {
            const req = indexedDB.deleteDatabase(this.dbName);
            let settled = false;
            const finish = (ok) => { if (settled) return; settled = true; resolve(!!ok); };
            req.onsuccess = () => finish(true);
            req.onerror = () => finish(false);
            // If another connection holds the DB open, don't hang; fall back quickly
            req.onblocked = () => finish(false);
          } catch (_) { resolve(false); }
        });
        // First try immediately after closing, then one retry after a short delay
        let dropped = await attemptDrop();
        if (!dropped) {
          await new Promise(r => setTimeout(r, 50));
          CloudDB.closeAll(this.dbName);
          dropped = await attemptDrop();
        }
        if (dropped) {
          this.db = null;
          Logger.info('CloudDB.clear:fast-drop:done', { db: this.dbName, kind });
          return true;
        }
        Logger.warn('CloudDB.clear:fast-drop:fallback', { db: this.dbName, kind });
      } catch (_) { /* fall through to slow path */ }
    }

    // Fallback: clear per-store contents for this kind only
    const db = await this._open();
    Logger.info('CloudDB.clear:slow', { kind });
    return new Promise((resolve, reject) => {
      try {
        const stores = [`items_${kind}`, `items2_${kind}`, `meta_${kind}`];
        const tx = db.transaction(stores, 'readwrite');
        for (const name of stores) {
          try {
            tx.objectStore(name).clear();
          } catch (err) {
            Logger.warn('CloudDB.clear:store-missing', { kind, store: name, err });
          }
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      } catch (e) { resolve(false); }
    });
  }
}
