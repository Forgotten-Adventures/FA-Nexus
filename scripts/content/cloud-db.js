// CloudDB — IndexedDB wrapper for cloud manifests (tokens, assets)
// Stores: items_<kind> (key: id), meta_<kind> (single key 'meta')

import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { contentFilename, toInventoryV2Item } from './cloud-inventory-v2.js';

/**
 * @typedef {import('../core/fa-nexus-types.js').FaNexusFolderCountEntry} FaNexusFolderCountEntry
 * @typedef {import('../core/fa-nexus-types.js').FaNexusInventoryDeltaOperation} FaNexusInventoryDeltaOperation
 * @typedef {import('../core/fa-nexus-types.js').FaNexusInventoryListResult} FaNexusInventoryListResult
 * @typedef {import('../core/fa-nexus-types.js').FaNexusInventoryRecord} FaNexusInventoryRecord
 * @typedef {import('../core/fa-nexus-types.js').FaNexusManifestMeta} FaNexusManifestMeta
 * @typedef {import('../core/fa-nexus-types.js').FaNexusStreamAllResult} FaNexusStreamAllResult
 */

function abortError() {
  return new DOMException('Operation aborted', 'AbortError');
}

/**
 * CloudDB
 * Lightweight IndexedDB wrapper for storing cloud manifests for tokens and assets.
 *
 * Object stores per kind:
 * - `items_<kind>`: keyed by `id`, holds inventory records
 * - `meta_<kind>`: single record keyed by `id='meta'`, tracks `latest` hash and counts
 */
export class CloudDB {
  // Track live instances so we can proactively close all connections to enable deleteDatabase
  static _instances = new Set();
  static _safeCloseInstance(inst) {
    try { inst?.db?.close?.(); } catch (_) {}
    try { inst.db = null; } catch (_) {}
    try { CloudDB._instances.delete(inst); } catch (_) {}
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
    this._rebuildInFlight = new Map();
  }

  close() {
    CloudDB._safeCloseInstance(this);
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
            const s = db.createObjectStore(items, { keyPath: 'id' });
            try { s.createIndex('folder', 'folder', { unique: false }); } catch (_) {}
            try { s.createIndex('tier', 'tier', { unique: false }); } catch (_) {}
            try { s.createIndex('asset_class', 'asset_class', { unique: false }); } catch (_) {}
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
        try { CloudDB._instances.add(this); } catch (_) {}
        try {
          db.onversionchange = () => {
            if (this.db === db) this.close();
            else {
              try { db.close(); } catch (_) {}
            }
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
   * @param {FaNexusInventoryRecord[]} items - Canonical inventory records
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
      let tx = null;
      let operationError = null;
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
        try { tx?.abort(); } catch (_) {}
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
        // Keep the previous catalog intact unless every item and chunk commits.
        tx = db.transaction([`items_${kind}`, `items2_${kind}`], 'readwrite');
        const sPut = tx.objectStore(`items_${kind}`);
        const sChunks = tx.objectStore(`items2_${kind}`);
        tx.oncomplete = () => {
          inserted = total;
          emit(true);
          finishResolve(true);
        };
        tx.onerror = () => finishReject(operationError || tx.error || new Error(`Could not replace ${kind} catalog.`));
        tx.onabort = () => finishReject(signal?.aborted
          ? abortError()
          : (operationError || tx.error || new Error(`Could not replace ${kind} catalog.`)));

        let clearsRemaining = 2;
        const populate = () => {
          clearsRemaining -= 1;
          if (clearsRemaining > 0 || settled) return;
          if (checkAbort() || !total) return;
          let i = 0;
          const putNext = () => {
            if (settled) return;
            if (checkAbort()) return;
            if (i >= arr.length) {
              let chunkIndex = 0;
              const sorted = arr.slice().sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || '')));
              for (let j = 0; j < sorted.length; j += this.CHUNK_SIZE) {
                if (settled) return;
                if (checkAbort()) return;
                const slice = sorted.slice(j, j + this.CHUNK_SIZE);
                inserted = Math.min(total, j + slice.length);
                emit();
                const chunkRequest = sChunks.put({ chunk: chunkIndex++, records: slice });
                chunkRequest.onerror = () => { operationError = chunkRequest.error; };
              }
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
            req.onerror = () => { operationError = req.error; };
          };
          putNext();
        };
        for (const store of [sPut, sChunks]) {
          const clearRequest = store.clear();
          clearRequest.onsuccess = populate;
          clearRequest.onerror = () => { operationError = clearRequest.error; };
        }
      } catch (e) { finishReject(e); }
    });
  }

  /**
   * Apply a JSON-lines delta operation
   * @param {'tokens'|'assets'} kind
   * @param {FaNexusInventoryDeltaOperation} op
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
          const normalized = toInventoryV2Item(kind, op.item, 'cloud');
          const req = items.put(normalized);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        } else if (op.op === 'del') {
          const key = String(op.path || op.id || '').trim();
          if (!key) { reject(new Error(`Missing ${kind} v2 delta delete path.`)); return; }
          const req = items.delete(key);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        } else reject(new Error(`Unknown ${kind} v2 delta op: ${String(op.op || '')}`));
      } catch (e) { reject(e); }
    });
  }

  /**
   * Rebuild chunked store from per-item store (used if chunks missing)
   * @param {'tokens'|'assets'} kind
   * @returns {Promise<boolean>}
   */
  async rebuildChunks(kind) {
    if (this._rebuildInFlight?.has(kind)) return this._rebuildInFlight.get(kind);
    const task = (async () => {
      const db = await this._open();
      try {
        await new Promise((resolve, reject) => {
          try {
            const tx = db.transaction([`items_${kind}`, `items2_${kind}`], 'readwrite');
            const items = tx.objectStore(`items_${kind}`);
            const chunks = tx.objectStore(`items2_${kind}`);
            let chunkIndex = 0;
            let buffer = [];
            const fail = (error) => {
              try { tx.abort(); } catch (_) {}
              reject(error);
            };
            const flush = () => {
              if (!buffer.length) return;
              const records = buffer;
              buffer = [];
              const chunk = chunkIndex++;
              const req = chunks.put({ chunk, records });
              req.onerror = () => fail(req.error || new Error(`Could not write ${kind} chunk ${chunk}.`));
            };
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error || new Error(`Could not rebuild ${kind} chunks.`));
            tx.onabort = () => reject(tx.error || new Error(`Could not rebuild ${kind} chunks.`));
            const clearReq = chunks.clear();
            clearReq.onerror = () => fail(clearReq.error || new Error(`Could not clear ${kind} chunks.`));
            const cursorReq = items.openCursor();
            cursorReq.onsuccess = (event) => {
              try {
                const cursor = event.target.result;
                if (!cursor) {
                  flush();
                  return;
                }
                buffer.push(cursor.value);
                if (buffer.length >= this.CHUNK_SIZE) flush();
                cursor.continue();
              } catch (error) { fail(error); }
            };
            cursorReq.onerror = () => fail(cursorReq.error || new Error(`Could not read ${kind} records for chunk rebuild.`));
          } catch (e) { reject(e); }
        });
        return true;
      } catch (error) {
        Logger.warn('CloudDB.rebuildChunks.failed', {
          kind,
          error: String(error?.message || error)
        });
        return false;
      }
    })();
    try { this._rebuildInFlight?.set(kind, task); } catch (_) {}
    try { return await task; }
    finally { try { this._rebuildInFlight?.delete(kind); } catch (_) {} }
  }

  _scheduleBackgroundChunkRebuild(kind, source = 'unknown') {
    try {
      return this.rebuildChunks(kind)
        .then((ok) => {
          if (!ok) Logger.warn('CloudDB.rebuildChunks.background.incomplete', { kind, source });
          return ok;
        })
        .catch((error) => {
          Logger.warn('CloudDB.rebuildChunks.background.failed', {
            kind,
            source,
            error: String(error?.message || error)
          });
          return false;
        });
    } catch (error) {
      Logger.warn('CloudDB.rebuildChunks.background.startFailed', {
        kind,
        source,
        error: String(error?.message || error)
      });
      return Promise.resolve(false);
    }
  }

  /**
   * Persist meta info for a kind
   * @param {'tokens'|'assets'} kind
   * @param {FaNexusManifestMeta} meta
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
   * @returns {Promise<FaNexusManifestMeta|null>}
   */
  async getMeta(kind) {
    const db = await this._open();
    const s = db.transaction([`meta_${kind}`], 'readonly').objectStore(`meta_${kind}`);
    return new Promise((resolve, reject) => {
      try {
        const req = s.get('meta');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error(`Could not read ${kind} metadata.`));
      } catch (error) {
        reject(error);
      }
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
    return new Promise((resolve, reject) => {
      try {
        const req = s.count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error || new Error(`Could not count ${kind} records.`));
      } catch (error) { reject(error); }
    });
  }

  /**
   * Incrementally stream all items for a kind in stable key order.
   * Uses chunked storage when fresh, otherwise falls back to batched cursor reads
   * from the per-item store and schedules a chunk rebuild in the background.
   * @param {'tokens'|'assets'} kind
   * @param {{onChunk?:(records:FaNexusInventoryRecord[],info:{kind:string,mode:string,batch:number,totalHint:number})=>Promise<void>|void,preferChunks?:boolean,chunkSize?:number,signal?:AbortSignal}} [options]
   * @returns {Promise<FaNexusStreamAllResult>}
   */
  async streamAll(kind, options = {}) {
    const db = await this._open();
    const signal = options.signal || null;
    const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;
    const preferChunks = options.preferChunks !== false;
    const chunkSize = Math.max(100, Number(options.chunkSize) || this.CHUNK_SIZE);
    const meta = await this.getMeta(kind);
    const latest = meta?.latest || null;
    const chunksLatest = meta?.chunksLatest || null;
    const totalHint = Math.max(0, Number(meta?.count) || 0);
    const useChunks = !!preferChunks && !!latest && !!chunksLatest && latest === chunksLatest;
    const items = onChunk ? null : [];
    let total = 0;
    let batch = 0;

    const checkAbort = () => {
      if (signal?.aborted) throw abortError();
    };

    const emitChunk = async (records, mode) => {
      const arr = Array.isArray(records) ? records : [];
      if (!arr.length) return;
      checkAbort();
      if (items) items.push(...arr);
      total += arr.length;
      batch += 1;
      if (onChunk) {
        await onChunk(arr, { kind, mode, batch, totalHint });
      }
    };

    const countChunkRecords = async () => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([`items2_${kind}`], 'readonly');
        const store = tx.objectStore(`items2_${kind}`);
        const req = store.count();
        req.onsuccess = () => resolve(Math.max(0, Number(req.result) || 0));
        req.onerror = () => reject(req.error || new Error(`Could not count ${kind} chunks.`));
      } catch (error) { reject(error); }
    });

    const readChunkRecord = async (chunkIndex) => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([`items2_${kind}`], 'readonly');
        const store = tx.objectStore(`items2_${kind}`);
        const req = store.get(chunkIndex);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error(`Could not read ${kind} chunk ${chunkIndex}.`));
      } catch (error) { reject(error); }
    });

    const readCursorBatch = async (afterKey = null) => new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, callback = resolve) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      try {
        const tx = db.transaction([`items_${kind}`], 'readonly');
        const store = tx.objectStore(`items_${kind}`);
        const range = afterKey ? IDBKeyRange.lowerBound(afterKey, true) : undefined;
        const out = [];
        let lastKey = afterKey;
        const req = store.openCursor(range);
        req.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) {
            finish({ records: out, lastKey });
            return;
          }
          out.push(cursor.value);
          lastKey = cursor.primaryKey ?? cursor.key ?? cursor.value?.id ?? lastKey;
          if (out.length >= chunkSize) {
            finish({ records: out, lastKey });
            return;
          }
          cursor.continue();
        };
        req.onerror = () => finish(req.error, reject);
      } catch (error) {
        finish(error, reject);
      }
    });

    Logger.time(`CloudDB.streamAll:${kind}`);
    Logger.info('CloudDB.streamAll:start', {
      kind,
      mode: useChunks ? 'chunks' : 'cursor',
      totalHint,
      latest
    });

    try {
      checkAbort();
      if (useChunks) {
        const chunkCount = await countChunkRecords();
        Logger.info('CloudDB.streamAll:mode', { kind, mode: 'chunks', chunks: chunkCount });
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          checkAbort();
          const record = await readChunkRecord(chunkIndex);
          const records = Array.isArray(record?.records) ? record.records : [];
          await emitChunk(records, 'chunks');
        }
      } else {
        if (preferChunks) {
          Logger.info('CloudDB.streamAll:chunks.stale', { kind, latest, chunksLatest });
          this._scheduleBackgroundChunkRebuild(kind, 'streamAll:stale-chunks');
        }
        Logger.info('CloudDB.streamAll:mode', { kind, mode: 'cursor', chunkSize });
        let afterKey = null;
        while (true) {
          checkAbort();
          const result = await readCursorBatch(afterKey);
          const records = Array.isArray(result?.records) ? result.records : [];
          if (!records.length) break;
          afterKey = result?.lastKey ?? afterKey;
          await emitChunk(records, 'cursor');
          if (!afterKey) break;
        }
      }
    } finally {
      Logger.info('CloudDB.streamAll:done', { kind, total, mode: useChunks ? 'chunks' : 'cursor' });
      Logger.timeEnd(`CloudDB.streamAll:${kind}`);
    }

    return {
      items: items || [],
      total,
      latest,
      mode: useChunks ? 'chunks' : 'cursor'
    };
  }

  /**
   * Query items with simple client-side filtering and pagination
   * @param {'tokens'|'assets'} kind
   * @param {{text?:string,tier?:string,pathPrefix?:string,assetClass?:string,offset?:number,limit?:number,onProgress?:(count:number,total:number)=>void,progressBatch?:number,signal?:AbortSignal}} [opts]
   * @returns {Promise<FaNexusInventoryListResult>}
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
    const text = String(opts.text || '').toLowerCase();
    const tier = opts.tier || null;
    const pathPrefix = opts.pathPrefix || '';
    const assetClass = opts.assetClass || opts.asset_class || null;
    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.max(0, Number(opts.limit) || 0);
    const sortBy = opts.sortBy || 'id';
    const sortDir = opts.sortDir === 'desc' ? 'desc' : 'asc';
    const wantsFastPath = !text && !tier && !pathPrefix && !assetClass && !offset && !limit;

    let metaSnapshot = null;
    let totalHint = 0;
    if (onProgress || wantsFastPath) {
      metaSnapshot = await this.getMeta(kind);
      if (onProgress) {
        totalHint = Number(metaSnapshot?.count) || 0;
        Logger.info('CloudDB.query:meta', { kind, totalHint });
      }
    }

    const store = db.transaction([`items_${kind}`], 'readonly').objectStore(`items_${kind}`);
    Logger.time(`CloudDB.query:${kind}`);
    if (signal?.aborted) throw abortError();

    // Helper to build a folder range for prefix scans
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

    if (wantsFastPath) {
      const latest = metaSnapshot?.latest || null;
      const chunksLatest = metaSnapshot?.chunksLatest || null;
      const chunksFresh = !!latest && !!chunksLatest && latest === chunksLatest;
      if (!chunksFresh) {
        Logger.info('CloudDB.query:chunks.stale', { kind, latest, chunksLatest });
      }
      if (chunksFresh) {
        // Try chunked
        const chunks = await promiseWithAbort(({ resolve, reject }) => {
          try {
            const s2 = db.transaction([`items2_${kind}`], 'readonly').objectStore(`items2_${kind}`);
            const req = s2.getAll();
            req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
            req.onerror = () => reject(req.error || new Error(`Could not read ${kind} chunks.`));
          } catch (error) { reject(error); }
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
          if (sortBy === 'id' && sortDir === 'desc') merged.reverse();
          const total = merged.length;
          if (onProgress && !totalHint && total && lastProgressCount < total) formatProgress(total, total);
          Logger.timeEnd(`CloudDB.query:${kind}`);
          return { items: merged, total };
        }
      }
      // Fallback to getAll and rebuild chunks in background
      Logger.info('CloudDB.query:mode', { kind, mode: 'cursor-fallback' });
      this._scheduleBackgroundChunkRebuild(kind, 'query:cursor-fallback');
      const items = await promiseWithAbort(({ resolve, reject }) => {
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
          req.onerror = () => reject(req.error || new Error(`Could not read ${kind} records.`));
        } catch (error) { reject(error); }
      });
      if (signal?.aborted) throw abortError();
      if (onProgress && items.length > lastProgressCount) formatProgress(items.length, totalHint || items.length);
      if (sortBy === 'id') {
        items.sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || '')));
        if (sortDir === 'desc') items.reverse();
      }
      const total = items.length;
      Logger.timeEnd(`CloudDB.query:${kind}`);
      return { items, total };
    }

    // Choose primary scan source to minimize iteration:
    // Priority: asset class, folder prefix, tier, else full store
    let primarySource = store;
    let useRange = null;
    let needsPostFilterTier = false;
    let needsPostFilterPath = false;
    let needsPostFilterAssetClass = false;
    try {
      if (assetClass) {
        primarySource = store.index('asset_class');
        useRange = IDBKeyRange.only(assetClass);
        needsPostFilterTier = !!tier;
        needsPostFilterPath = !!pathPrefix;
      } else if (pathRange) {
        primarySource = store.index('folder');
        useRange = pathRange;
        needsPostFilterTier = !!tier;
      } else if (tier) {
        primarySource = store.index('tier');
        useRange = IDBKeyRange.only(tier);
      }
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error;
      // If indexes are missing for any reason, fall back to full store
      primarySource = store;
      useRange = null;
      needsPostFilterTier = !!tier;
      needsPostFilterPath = !!pathPrefix;
      needsPostFilterAssetClass = !!assetClass;
    }

    // Collect matching items, then sort and paginate
    const matched = await promiseWithAbort(({ resolve, reject }) => {
      const out = [];
      try {
        Logger.info('CloudDB.query:mode', { kind, mode: 'filtered-cursor', hasText: !!text, hasTier: !!tier, hasPrefix: !!pathPrefix, assetClass });
        const req = primarySource.openCursor ? primarySource.openCursor(useRange || undefined) : store.openCursor();
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) { resolve(out); return; }
          const v = cursor.value;
          let ok = true;
          if (needsPostFilterTier) ok = ok && String(v.tier || '') === tier;
          if (needsPostFilterPath) ok = ok && String(v.folder || '').startsWith(pathPrefix);
          if (needsPostFilterAssetClass) ok = ok && String(v.asset_class || '') === assetClass;
          if (ok && text) {
            const tagsText = Array.isArray(v.tags) ? v.tags.join(' ') : v.tags;
            const fields = [v.name, contentFilename(v), v.folder, tagsText];
            ok = fields.some(val => String(val || '').toLowerCase().includes(text));
          }
          if (ok) {
            out.push(v);
            emitProgress(out.length);
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error || new Error(`Could not read filtered ${kind} records.`));
      } catch (error) { reject(error); }
    });
    if (signal?.aborted) throw abortError();
    if (onProgress && matched.length > lastProgressCount) formatProgress(matched.length, totalHint || matched.length);

    const total = matched.length;
    if (sortBy === 'id') {
      matched.sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || '')));
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
