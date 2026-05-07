function toIdSet(ids) {
  if (ids instanceof Set) return new Set(ids);
  if (Array.isArray(ids)) return new Set(ids.map((id) => String(id || '')).filter(Boolean));
  return new Set();
}

export function createSubtoolPreferenceBridge({
  moduleId,
  settingKey,
  activeSubtoolIds = [],
  persistedSubtoolIds = activeSubtoolIds,
  getDelegate = null,
  requestSubtoolToggle = null,
  persistDelayMs = 200
} = {}) {
  const activeIds = toIdSet(activeSubtoolIds);
  const persistedIds = toIdSet(persistedSubtoolIds);
  let lastPersistedSubtool = null;
  let toolDefaultsPersistTimer = null;

  const getCurrentDelegate = () => {
    try { return getDelegate?.() || null; }
    catch (_) { return null; }
  };

  const bridge = {
    persistDelegateToolDefaults() {
      const delegate = getCurrentDelegate();
      if (!delegate) return;
      if (typeof delegate._persistToolDefaults !== 'function') return;
      try { delegate._persistToolDefaults(); } catch (_) {}
    },

    refreshDelegateToolDefaults() {
      const delegate = getCurrentDelegate();
      if (!delegate) return;
      try {
        if (typeof delegate._readToolDefaults === 'function') {
          const defaults = delegate._readToolDefaults();
          delegate._toolDefaults = defaults && typeof defaults === 'object' ? defaults : null;
        } else if ('_toolDefaults' in delegate) {
          delegate._toolDefaults = null;
        }
      } catch (_) {}
    },

    scheduleToolDefaultsPersist() {
      if (!getCurrentDelegate()?.isActive) return;
      if (toolDefaultsPersistTimer) return;
      toolDefaultsPersistTimer = setTimeout(() => {
        toolDefaultsPersistTimer = null;
        if (!getCurrentDelegate()?.isActive) return;
        bridge.persistDelegateToolDefaults();
      }, persistDelayMs);
    },

    readSubtoolPreference() {
      try {
        const value = globalThis?.game?.settings?.get?.(moduleId, settingKey);
        const normalized = typeof value === 'string' ? value : '';
        return persistedIds.has(normalized) ? normalized : null;
      } catch (_) {
        return null;
      }
    },

    persistSubtoolPreference(value) {
      if (!value || !persistedIds.has(value)) return;
      if (lastPersistedSubtool === value) return;
      lastPersistedSubtool = value;
      try { globalThis?.game?.settings?.set?.(moduleId, settingKey, value); } catch (_) {}
    },

    extractActiveSubtoolId(state) {
      const toggles = Array.isArray(state?.subtoolToggles) ? state.subtoolToggles : [];
      for (const toggle of toggles) {
        if (!toggle || typeof toggle !== 'object') continue;
        if (!toggle.enabled) continue;
        const id = String(toggle.id || '');
        if (activeIds.has(id)) return id;
      }
      return null;
    },

    persistSubtoolFromState(state, { suppress = false } = {}) {
      if (suppress) return;
      const active = bridge.extractActiveSubtoolId(state);
      if (!active) return;
      bridge.persistSubtoolPreference(active);
    },

    restoreSubtoolPreference() {
      const preferred = bridge.readSubtoolPreference();
      if (!preferred) return;
      lastPersistedSubtool = preferred;
      const apply = () => {
        try {
          const result = requestSubtoolToggle?.(preferred, true);
          if (result === false) {
            setTimeout(() => {
              try { requestSubtoolToggle?.(preferred, true); } catch (_) {}
            }, 50);
          }
        } catch (_) {}
      };
      if (typeof queueMicrotask === 'function') queueMicrotask(apply);
      else setTimeout(apply, 0);
    }
  };

  return bridge;
}
