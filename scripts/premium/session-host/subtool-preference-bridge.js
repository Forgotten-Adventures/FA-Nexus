import { NexusLogger as Logger } from '../../core/nexus-logger.js';

function stringifyError(error) {
  return String(error?.message || error);
}

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
  loggerPrefix = 'SubtoolPreferenceBridge',
  persistDelayMs = 200
} = {}) {
  const activeIds = toIdSet(activeSubtoolIds);
  const persistedIds = toIdSet(persistedSubtoolIds);
  let lastPersistedSubtool = null;
  let toolDefaultsPersistTimer = null;
  const missingDelegateMethodsReported = new Set();

  const getCurrentDelegate = () => {
    try { return getDelegate?.() || null; }
    catch (error) {
      Logger.warn?.(`${loggerPrefix}.delegate.lookupFailed`, {
        settingKey,
        error: stringifyError(error)
      });
      return null;
    }
  };

  const reportMissingDelegateMethod = (methodName, eventName) => {
    if (missingDelegateMethodsReported.has(methodName)) return;
    missingDelegateMethodsReported.add(methodName);
    Logger.error?.(`${loggerPrefix}.delegateToolDefaults.${eventName}`, {
      settingKey,
      methodName
    });
  };

  const bridge = {
    persistDelegateToolDefaults() {
      const delegate = getCurrentDelegate();
      if (!delegate) return;
      if (typeof delegate.persistToolDefaults !== 'function') {
        reportMissingDelegateMethod('persistToolDefaults', 'persistMethodMissing');
        return;
      }
      const logPersistFailure = (error) => {
        Logger.warn?.(`${loggerPrefix}.delegateToolDefaults.persistFailed`, {
          settingKey,
          error: stringifyError(error)
        });
      };
      try {
        const result = delegate.persistToolDefaults();
        if (result?.catch) result.catch(logPersistFailure);
      } catch (error) {
        logPersistFailure(error);
      }
    },

    refreshDelegateToolDefaults() {
      const delegate = getCurrentDelegate();
      if (!delegate) return;
      if (typeof delegate.refreshToolDefaults !== 'function') {
        reportMissingDelegateMethod('refreshToolDefaults', 'refreshMethodMissing');
        return;
      }
      const logRefreshFailure = (error) => {
        Logger.warn?.(`${loggerPrefix}.delegateToolDefaults.refreshFailed`, {
          settingKey,
          error: stringifyError(error)
        });
      };
      try {
        const result = delegate.refreshToolDefaults();
        if (result?.catch) result.catch(logRefreshFailure);
      } catch (error) {
        logRefreshFailure(error);
      }
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
      } catch (error) {
        Logger.warn?.(`${loggerPrefix}.subtoolPreference.readFailed`, {
          settingKey,
          error: stringifyError(error)
        });
        return null;
      }
    },

    persistSubtoolPreference(value) {
      if (!value || !persistedIds.has(value)) return;
      if (lastPersistedSubtool === value) return;
      lastPersistedSubtool = value;
      const logWriteFailure = (error) => {
        Logger.warn?.(`${loggerPrefix}.subtoolPreference.writeFailed`, {
          settingKey,
          value,
          error: stringifyError(error)
        });
      };
      try {
        const result = globalThis?.game?.settings?.set?.(moduleId, settingKey, value);
        if (result?.catch) result.catch(logWriteFailure);
      } catch (error) {
        logWriteFailure(error);
      }
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
      const logRestoreFailure = (eventName, details = {}) => {
        Logger.warn?.(`${loggerPrefix}.subtoolPreference.${eventName}`, {
          settingKey,
          value: preferred,
          ...details
        });
      };
      const apply = () => {
        const applyToggle = (isRetry = false) => {
          const eventName = isRetry ? 'restoreRetryFailed' : 'restoreFailed';
          const handleFalse = () => {
            if (isRetry) {
              logRestoreFailure(eventName, { reason: 'request-returned-false' });
              return;
            }
            setTimeout(() => applyToggle(true), 50);
          };
          try {
            const result = requestSubtoolToggle?.(preferred, true);
            if (result?.then) {
              result
                .then((value) => {
                  if (value === false) handleFalse();
                })
                .catch((error) => {
                  logRestoreFailure(eventName, { error: stringifyError(error) });
                });
              return;
            }
            if (result === false) handleFalse();
          } catch (error) {
            logRestoreFailure(eventName, { error: stringifyError(error) });
          }
        };
        applyToggle(false);
      };
      if (typeof queueMicrotask === 'function') queueMicrotask(apply);
      else setTimeout(apply, 0);
    }
  };

  return bridge;
}
