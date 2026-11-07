export class ScatterPlacementSessionHistory {
  constructor({ historyLimit = 30, quantizeElevation, getSessionKey } = {}) {
    this._historyLimit = Math.max(1, Number(historyLimit) || 30);
    this._quantizeElevation = typeof quantizeElevation === 'function'
      ? quantizeElevation
      : (value) => Number(value) || 0;
    this._getSessionKey = typeof getSessionKey === 'function'
      ? getSessionKey
      : (value) => String(this._quantizeElevation(value));
    this._active = false;
    this._groups = new Map();
    this.resetHistory();
  }

  get active() { return this._active; }
  set active(value) { this._active = !!value; }

  get groups() { return this._groups; }
  set groups(value) { this._groups = value instanceof Map ? value : new Map(); }

  get dirty() { return this._dirty; }
  set dirty(value) { this._dirty = !!value; }

  beginMergeSession() {
    if (this._active) return false;
    this._active = true;
    this._groups = new Map();
    this.resetHistory();
    return true;
  }

  resetMergeSession() {
    this._active = false;
    this._groups = new Map();
  }

  resetHistory() {
    this._history = [];
    this._historyIndex = -1;
    this._dirty = false;
  }

  canUndo() {
    return this._historyIndex > 0;
  }

  canRedo() {
    return this._historyIndex >= 0 && this._historyIndex < this._history.length - 1;
  }

  registerInstances(instances, elevation, shadow = {}) {
    if (!this._active) return;
    if (!Array.isArray(instances) || !instances.length) return;
    const key = this._getSessionKey(elevation);
    let group = this._groups.get(key);
    if (!group) {
      const normalizedElevation = this._quantizeElevation(Number(elevation) || 0);
      const cachedShadow = shadow.read?.(key);
      const shadowSettings = cachedShadow ? { ...cachedShadow } : shadow.snapshot?.();
      if (!cachedShadow && shadowSettings) shadow.write?.(key, { ...shadowSettings });
      group = { elevation: normalizedElevation, instances: [], shadowSettings };
      this._groups.set(key, group);
    }
    for (const instance of instances) {
      if (!instance) continue;
      instance._scatterGroupKey = key;
      instance._scatterElevation = group.elevation;
      group.instances.push(instance);
    }
  }

  recordSnapshot({
    force = false,
    enabled = false,
    brushModeActive = false,
    editing = false,
    instances = [],
    previewElevation = 0,
    shadowSettings = []
  } = {}) {
    if (!enabled || !brushModeActive) return false;
    if (!this._active && !editing) return false;
    if (!force && !this._dirty) return false;
    const snapshot = {
      instances: Array.isArray(instances) ? instances.map((instance) => ({ ...instance })) : [],
      groups: Array.from(this._groups.entries()).map(([key, group]) => ({
        key,
        elevation: Number.isFinite(group?.elevation) ? group.elevation : 0,
        sort: Number.isFinite(group?.sort) ? group.sort : null,
        shadowSettings: group?.shadowSettings ? { ...group.shadowSettings } : null
      })),
      shadowSettings: ScatterPlacementSessionHistory._cloneShadowSettings(shadowSettings),
      previewElevation,
      sessionActive: !!this._active
    };
    if (this._historyIndex < this._history.length - 1) this._history.splice(this._historyIndex + 1);
    this._history.push(snapshot);
    if (this._history.length > this._historyLimit) {
      const overflow = this._history.length - this._historyLimit;
      this._history.splice(0, overflow);
      this._historyIndex = Math.max(-1, this._historyIndex - overflow);
    }
    this._historyIndex = this._history.length - 1;
    this._dirty = false;
    return true;
  }

  undo(callbacks = {}) {
    if (!this.canUndo()) return false;
    this._historyIndex -= 1;
    return this.applySnapshot(this._history[this._historyIndex], callbacks);
  }

  redo(callbacks = {}) {
    if (!this.canRedo()) return false;
    this._historyIndex += 1;
    return this.applySnapshot(this._history[this._historyIndex], callbacks);
  }

  applySnapshot(snapshot, callbacks = {}) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const previewElevation = callbacks.previewElevation;
    const state = this._buildSnapshotState(snapshot, previewElevation);
    this._active = state.sessionActive;
    this._groups = new Map();
    callbacks.beginPreviewSession?.(state.instances, {
      elevation: previewElevation,
      shadowSettings: state.shadowSettings
    });
    if (this._active) {
      const grouped = new Map();
      for (const instance of state.instances) {
        const key = instance?._scatterGroupKey || this._getSessionKey(instance?._scatterElevation);
        if (!key) continue;
        let group = grouped.get(key);
        if (!group) {
          group = { elevation: instance._scatterElevation ?? state.fallbackElevation, instances: [] };
          grouped.set(key, group);
        }
        group.instances.push(instance);
      }
      const shadow = callbacks.shadow || {};
      for (const group of grouped.values()) {
        this.registerInstances(group.instances, group.elevation, shadow);
      }
    }
    callbacks.syncOrdering?.();
    this._dirty = false;
    callbacks.syncToolOptions?.();
    return true;
  }

  collectCommitGroups({
    previewGroups = new Map(),
    fallbackInstances = [],
    previewElevation = 0,
    previewSort = null,
    readShadowSettings,
    snapshotShadowSettings
  } = {}) {
    const groups = [];
    for (const [key, group] of this._groups.entries()) {
      if (!group?.instances?.length) continue;
      const previewGroup = previewGroups?.get?.(key) || null;
      groups.push({
        elevation: group.elevation,
        sort: Number.isFinite(group.sort) ? group.sort : (Number.isFinite(previewGroup?.sort) ? previewGroup.sort : null),
        instances: group.instances.slice(),
        shadowSettings: group.shadowSettings ? { ...group.shadowSettings } : null
      });
    }
    if (!groups.length && Array.isArray(fallbackInstances) && fallbackInstances.length) {
      const key = this._getSessionKey(previewElevation);
      const shadowSettings = readShadowSettings?.(key) || snapshotShadowSettings?.();
      const previewGroup = previewGroups?.get?.(key) || null;
      groups.push({
        elevation: previewElevation,
        sort: Number.isFinite(previewGroup?.sort) ? previewGroup.sort : (Number.isFinite(previewSort) ? previewSort : null),
        instances: fallbackInstances.slice(),
        shadowSettings
      });
    }
    return groups;
  }

  _buildSnapshotState(snapshot, previewElevation) {
    const instances = Array.isArray(snapshot.instances)
      ? snapshot.instances.map((entry) => ({ ...entry }))
      : [];
    const groupMap = new Map();
    if (Array.isArray(snapshot.groups)) {
      for (const group of snapshot.groups) {
        if (group?.key) groupMap.set(group.key, { ...group });
      }
    }
    const shadowSettings = ScatterPlacementSessionHistory._cloneShadowSettings(snapshot.shadowSettings);
    const fallbackElevation = this._quantizeElevation(Number(previewElevation) || 0);
    for (const instance of instances) {
      const rawElevation = Number.isFinite(instance?._scatterElevation) ? instance._scatterElevation : null;
      const keyCandidate = instance?._scatterGroupKey || (rawElevation != null ? this._getSessionKey(rawElevation) : null);
      const group = keyCandidate ? groupMap.get(keyCandidate) : null;
      const elevation = Number.isFinite(rawElevation) ? rawElevation : (group?.elevation ?? fallbackElevation);
      const key = keyCandidate || this._getSessionKey(elevation);
      instance._scatterGroupKey = key;
      instance._scatterElevation = this._quantizeElevation(elevation);
      if (!groupMap.has(key)) groupMap.set(key, { key, elevation: instance._scatterElevation });
    }
    return {
      instances,
      shadowSettings,
      fallbackElevation,
      sessionActive: !!snapshot.sessionActive || !!instances.length
    };
  }

  static _cloneShadowSettings(value) {
    const entries = value instanceof Map
      ? Array.from(value.entries())
      : (Array.isArray(value) ? value : []);
    return entries.map(([key, settings]) => [
      key,
      settings && typeof settings === 'object' ? { ...settings } : settings
    ]);
  }
}
