import { NexusLogger as Logger } from '../../core/nexus-logger.js';

const DEFAULT_EXPIRE = {
  error: 6000,
  cancelled: 3000,
  done: 4000,
  complete: 4000
};

export class ContentSourcesIndexer {
  constructor({ runIndex, normalizePath = (value) => value || '', listeners = [] } = {}) {
    if (runIndex && typeof runIndex !== 'function') throw new TypeError('runIndex must be a function');
    this._runIndex = runIndex;
    this._normalizePath = normalizePath;
    this._states = new Map();
    this._controllers = new Map();
    this._cleanupTimers = new Map();
    this._listeners = new Set(listeners.filter((fn) => typeof fn === 'function'));
  }

  getState(folder) {
    const normalized = this._normalize(folder);
    return this._states.get(normalized) || null;
  }

  getStates() {
    return Array.from(this._states.values());
  }

  async start(folder, { onBeforeStart = null } = {}) {
    const normalized = this._normalize(folder);
    if (!normalized) throw new Error('Invalid folder path for indexing');
    if (this._controllers.has(normalized)) return this._states.get(normalized) || null;
    if (!this._runIndex) throw new Error('No index runner configured');

    if (typeof onBeforeStart === 'function') {
      try { onBeforeStart(folder); }
      catch (error) {
        try { Logger.warn?.('ContentSourcesIndexer.beforeStart:failed', { folder, error }); }
        catch (_) {}
      }
    }

    const controller = new AbortController();
    this._controllers.set(normalized, controller);

    this._patchState(normalized, { folder, status: 'running', count: 0, error: null, startedAt: Date.now(), batchCount: 0 });

    const emitProgress = (info = {}) => {
      const progressCount = Number.isFinite(info?.count) ? Number(info.count)
        : Number(info?.total ?? info?.processed ?? 0) || 0;
      const batch = Number.isFinite(info?.batchCount) ? Number(info.batchCount)
        : Number(info?.batch ?? info?.batchSize ?? 0) || 0;
      this._patchState(normalized, {
        status: 'running',
        count: Math.max(0, progressCount),
        batchCount: Math.max(0, batch),
        updatedAt: Date.now()
      });
    };

    try {
      const result = await this._runIndex(folder, { signal: controller.signal, onProgress: emitProgress });
      const count = this._coerceCount(result, normalized);
      const state = this._patchState(normalized, {
        status: 'done',
        count,
        batchCount: 0,
        error: null,
        finishedAt: Date.now()
      });
      return state;
    } catch (error) {
      if (error?.name === 'AbortError') {
        return this._patchState(normalized, { status: 'cancelled', finishedAt: Date.now() });
      }
      const state = this._patchState(normalized, {
        status: 'error',
        error: error?.message || String(error),
        finishedAt: Date.now()
      });
      throw Object.assign(new Error('Content sources indexing failed'), { cause: error, state });
    } finally {
      this._controllers.delete(normalized);
    }
  }

  cancel(folder, reason = 'user-cancelled') {
    const normalized = this._normalize(folder);
    if (!normalized) return;
    const controller = this._controllers.get(normalized);
    if (controller) {
      try { controller.abort(reason); }
      catch (_) {}
      this._controllers.delete(normalized);
    }
    const state = this._states.get(normalized);
    if (state) {
      this._patchState(normalized, { status: 'cancelled', finishedAt: Date.now() });
    }
  }

  cancelAll(reason = 'cancelled') {
    for (const controller of this._controllers.values()) {
      try { controller.abort(reason); }
      catch (_) {}
    }
    this._controllers.clear();
    for (const [normalized, state] of this._states.entries()) {
      const folder = state?.folder;
      if (folder) {
        this._patchState(normalized, { status: 'cancelled', finishedAt: Date.now() });
      } else {
        this._clearState(normalized);
      }
    }
  }

  dispose() {
    this.cancelAll('disposed');
    for (const timer of this._cleanupTimers.values()) {
      try { clearTimeout(timer); }
      catch (_) {}
    }
    this._cleanupTimers.clear();
    this._states.clear();
    this._listeners.clear();
  }

  _normalize(folder) {
    try {
      return this._normalizePath(folder);
    } catch (error) {
      try { Logger.error?.('ContentSourcesIndexer.normalize:failed', { folder, error }); }
      catch (_) {}
      return folder || '';
    }
  }

  _patchState(normalized, patch = {}) {
    if (!normalized) return null;
    const previous = this._states.get(normalized) || { folder: patch.folder, status: 'idle', count: 0 };
    const folder = patch.folder ?? previous.folder;
    const prevStatus = previous.status || 'idle';
    const status = patch.status ?? prevStatus;
    const base = { folder, status, count: patch.count ?? previous.count ?? 0 };
    const merged = Object.assign({}, previous, patch, base);
    merged.expireAt = this._computeExpireAt(prevStatus, merged);
    this._states.set(normalized, merged);
    this._scheduleCleanup(normalized, merged);
    this._emit(folder, merged);
    return merged;
  }

  _clearState(normalized) {
    this._states.delete(normalized);
    const timer = this._cleanupTimers.get(normalized);
    if (timer) {
      try { clearTimeout(timer); }
      catch (_) {}
      this._cleanupTimers.delete(normalized);
    }
  }

  _emit(folder, state) {
    for (const listener of this._listeners) {
      try { listener(folder, state); }
      catch (error) {
        try { Logger.warn?.('ContentSourcesIndexer.listener:failed', { folder, error }); }
        catch (_) {}
      }
    }
  }

  _scheduleCleanup(normalized, state) {
    const timer = this._cleanupTimers.get(normalized);
    if (timer) {
      try { clearTimeout(timer); }
      catch (_) {}
      this._cleanupTimers.delete(normalized);
    }
    if (!state || state.status === 'running') return;
    const expireAt = state.expireAt;
    if (!Number.isFinite(expireAt)) return;
    const delay = expireAt - Date.now();
    if (delay <= 0) {
      this._clearState(normalized);
      return;
    }
    const handle = setTimeout(() => {
      this._cleanupTimers.delete(normalized);
      this._states.delete(normalized);
      this._emit(state.folder, null);
    }, delay);
    this._cleanupTimers.set(normalized, handle);
  }

  _computeExpireAt(previousStatus, state) {
    if (!state || state.status === 'running' || state.status === 'idle') return null;
    if (state.expireAt != null && Number.isFinite(state.expireAt)) return state.expireAt;
    if (state.status === previousStatus && state.expireAt) return state.expireAt;
    const now = Date.now();
    if (state.status === 'error') return now + (DEFAULT_EXPIRE.error);
    if (state.status === 'cancelled') return now + (DEFAULT_EXPIRE.cancelled);
    if (state.status === 'done') return now + (DEFAULT_EXPIRE.done);
    if (state.count) return now + (DEFAULT_EXPIRE.complete);
    return null;
  }

  _coerceCount(result, normalized) {
    if (result == null) {
      return Number(this._states.get(normalized)?.count || 0) || 0;
    }
    if (typeof result === 'number') {
      return Number.isFinite(result) ? Number(result) : 0;
    }
    if (typeof result === 'object') {
      const value = Number(result.count ?? result.total ?? result.items ?? result.length);
      if (Number.isFinite(value)) return Number(value);
    }
    try { Logger.warn?.('ContentSourcesIndexer.count:unknown', { result }); }
    catch (_) {}
    return Number(this._states.get(normalized)?.count || 0) || 0;
  }
}
