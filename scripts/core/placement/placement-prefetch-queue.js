import { NexusLogger as Logger } from '../nexus-logger.js';

/**
 * Maintains a rolling queue of items to prefetch for random placement workflows.
 */
export class PlacementPrefetchQueue {
  constructor(options = {}) {
    this._pool = [];
    this._queue = [];
    this._prefetching = new Set();
    this._prefetchCount = Math.max(0, Number(options.prefetchCount ?? 4) || 0);
    this._getItemKey = typeof options.getItemKey === 'function'
      ? options.getItemKey
      : (item) => {
          const key = item?.file_path || item?.path || item?.filename || '';
          return String(key).toLowerCase();
        };
    this._needsPrefetch = typeof options.needsPrefetch === 'function'
      ? options.needsPrefetch
      : () => false;
    this._prefetchHandler = typeof options.prefetch === 'function'
      ? options.prefetch
      : async () => {};
    this._logger = options.logger || Logger;
    this._loggerTag = options.loggerTag || 'PlacementPrefetch';
  }

  setPool(list = []) {
    try { this._pool = Array.isArray(list) ? list.slice() : []; }
    catch (_) { this._pool = []; }
    this.reset();
  }

  reset() {
    this._queue = [];
    this._prefetching.clear();
  }

  setPrefetchCount(count) {
    this._prefetchCount = Math.max(0, Number(count) || 0);
  }

  /**
   * Prime the queue without consuming an item (useful before showing preview).
   * @param {any|null} currentItem Optional item to exclude from prefetch duplication.
   */
  prime(currentItem = null) {
    this._ensurePrefetch(currentItem);
  }

  /**
   * Retrieve the next item for placement, ensuring the queue continues to fill.
   * @param {any|null} currentItem Item that is currently in use to avoid requeueing.
   */
  next(currentItem = null) {
    if (!Array.isArray(this._pool) || !this._pool.length) return null;
    let picked = null;
    if (this._queue.length) {
      picked = this._queue.shift();
      this._log('next.queue', { remaining: this._queue.length, key: this._key(picked) });
    } else {
      picked = this._randomFromPool();
      this._log('next.random', { key: this._key(picked) });
    }
    this._ensurePrefetch(picked || currentItem || null);
    return picked;
  }

  _randomFromPool() {
    if (!this._pool.length) return null;
    const idx = Math.floor(Math.random() * this._pool.length);
    return this._pool[idx] || null;
  }

  _ensurePrefetch(currentItem = null) {
    if (!this._prefetchCount) return;
    const used = new Set();
    if (currentItem) used.add(this._key(currentItem));
    for (const queued of this._queue) {
      used.add(this._key(queued));
    }
    const available = [];
    for (const item of this._pool) {
      const key = this._key(item);
      if (!key || used.has(key)) continue;
      available.push(item);
    }
    while (this._queue.length < this._prefetchCount && available.length) {
      const idx = Math.floor(Math.random() * available.length);
      const picked = available.splice(idx, 1)[0];
      if (!picked) break;
      this._queue.push(picked);
      this._log('queue.push', { size: this._queue.length, key: this._key(picked) });
      this._prefetchItem(picked);
    }
  }

  _prefetchItem(item) {
    if (!this._needsPrefetch(item)) return;
    const key = this._key(item);
    if (!key) return;
    if (this._prefetching.has(key)) return;
    this._prefetching.add(key);
    Promise.resolve()
      .then(() => this._prefetchHandler(item))
      .then(() => {
        this._log('prefetch.done', { key });
      })
      .catch((error) => {
        this._log('prefetch.failed', { key, error: String(error?.message || error) }, 'warn');
      })
      .finally(() => {
        this._prefetching.delete(key);
      });
  }

  _key(item) {
    try {
      const value = this._getItemKey(item);
      return String(value || '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  _log(event, payload = {}, level = 'info') {
    const logger = this._logger;
    if (!logger) return;
    try {
      const tag = `${this._loggerTag}.${event}`;
      const fn = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info?.bind(logger);
      fn?.(tag, payload);
    } catch (_) {}
  }
}
