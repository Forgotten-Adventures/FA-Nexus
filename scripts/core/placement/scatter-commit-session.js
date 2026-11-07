import { ScatterPlacementSessionHistory } from './scatter-session-history.js';

const formatError = (error) => String(error?.message || error);

export class ScatterPlacementCommitSession {
  constructor({
    historyLimit = 30,
    quantizeElevation,
    getSessionKey,
    logger = null
  } = {}) {
    this._history = new ScatterPlacementSessionHistory({
      historyLimit,
      quantizeElevation,
      getSessionKey
    });
    this._logger = logger;
    this._queue = [];
    this._queueRunning = false;
    this._queuePromise = null;
  }

  get active() { return this._history.active; }
  set active(value) { this._history.active = value; }

  get dirty() { return this._history.dirty; }
  set dirty(value) { this._history.dirty = value; }

  get groups() { return this._history.groups; }
  set groups(value) { this._history.groups = value; }

  get queuePromise() { return this._queuePromise; }

  beginMergeSession({
    editing = false,
    ensurePreviewSession,
    beginPreviewSession,
    recordSnapshot
  } = {}) {
    if (editing) return false;
    if (this.active) {
      ensurePreviewSession?.();
      return false;
    }
    this._history.beginMergeSession();
    beginPreviewSession?.();
    recordSnapshot?.({ force: true });
    return true;
  }

  resetMergeSession({ clearPreviewSession } = {}) {
    this._history.resetMergeSession();
    this.clearQueue();
    clearPreviewSession?.();
  }

  resetHistory() {
    this._history.resetHistory();
  }

  canUndo() {
    return this._history.canUndo();
  }

  canRedo() {
    return this._history.canRedo();
  }

  recordSnapshot(context = {}, options = {}) {
    return this._history.recordSnapshot({ ...context, ...options });
  }

  applySnapshot(snapshot, callbacks = {}) {
    return this._history.applySnapshot(snapshot, callbacks);
  }

  undo(callbacks = {}) {
    return this._history.undo(callbacks);
  }

  redo(callbacks = {}) {
    return this._history.redo(callbacks);
  }

  registerInstances(instances, elevation, shadow = {}) {
    this._history.registerInstances(instances, elevation, shadow);
  }

  collectCommitGroups(context = {}) {
    return this._history.collectCommitGroups(context);
  }

  hasChanges({ enabled = false, editing = false, previewInstances = [] } = {}) {
    if (!enabled) return false;
    if (editing) return true;
    const instances = Array.isArray(previewInstances) ? previewInstances.length : 0;
    const sessions = this.groups?.size || 0;
    return instances > 0 || sessions > 0;
  }

  moveGroup(sourceKey, targetKey, { elevation = null, sort = null } = {}) {
    if (!sourceKey || !targetKey || sourceKey === targetKey) return false;
    const group = this.groups?.get?.(sourceKey);
    if (!group) return false;
    this.groups.delete(sourceKey);
    if (Number.isFinite(elevation)) group.elevation = elevation;
    if (Number.isFinite(sort)) group.sort = sort;
    this.groups.set(targetKey, group);
    return true;
  }

  updateGroupSort(key, sort) {
    const group = key ? this.groups?.get?.(key) : null;
    if (!group || !Number.isFinite(sort)) return false;
    group.sort = sort;
    return true;
  }

  updateGroupShadowSettings(key, settings) {
    const group = key ? this.groups?.get?.(key) : null;
    if (!group) return false;
    group.shadowSettings = settings && typeof settings === 'object' ? { ...settings } : settings;
    return true;
  }

  removeInstancesById(instanceIds) {
    const ids = instanceIds instanceof Set ? instanceIds : new Set(instanceIds || []);
    if (!ids.size || !this.active) return 0;
    let removed = 0;
    for (const [key, group] of this.groups) {
      const original = Array.isArray(group.instances) ? group.instances : [];
      const filtered = original.filter((instance) => !ids.has(instance?.id));
      removed += original.length - filtered.length;
      if (filtered.length) {
        group.instances = filtered;
      } else {
        this.groups.delete(key);
      }
    }
    return removed;
  }

  clearQueue() {
    this._queue = [];
    this._queueRunning = false;
    this._queuePromise = null;
  }

  enqueueStamp(worldX, worldY, { action = 'tile', processQueue } = {}) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return false;
    this._queue.push({ x: worldX, y: worldY, action });
    if (!this._queueRunning) processQueue?.();
    return true;
  }

  processQueue({
    isPlacementActive,
    isBrushMode,
    handlers = {}
  } = {}) {
    if (this._queueRunning) return this._queuePromise;
    this._queueRunning = true;
    let current = null;
    const runner = (async () => {
      try {
        while (
          this._queue.length
          && isPlacementActive?.()
          && isBrushMode?.()
        ) {
          current = this._queue.shift();
          if (!current) continue;
          const handler = handlers[current.action] || handlers.tile;
          if (typeof handler !== 'function') {
            this._warn('Placement.scatter.queue.unknownAction', { action: current.action });
            continue;
          }
          await handler(current);
        }
      } catch (error) {
        this._warn('Placement.scatter.queue.failed', {
          action: current?.action || null,
          error: formatError(error)
        });
      }
    })();
    this._queuePromise = runner;
    runner.finally(() => {
      this._queueRunning = false;
      if (this._queuePromise === runner) this._queuePromise = null;
    });
    return runner;
  }

  async drainQueue({ loggerTag = 'Placement.scatter.queue.drain.failed' } = {}) {
    const queuePromise = this._queuePromise;
    if (!queuePromise) return false;
    try {
      await queuePromise;
      return true;
    } catch (error) {
      this._warn(loggerTag, { error: formatError(error) });
      return false;
    }
  }

  _warn(tag, payload) {
    try {
      this._logger?.warn?.(tag, payload);
    } catch (_) {}
  }
}
