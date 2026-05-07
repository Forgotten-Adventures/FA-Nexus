import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { toolOptionsController } from '../../core/tool-options-controller.js';

function stringifyError(error) {
  return String(error?.message || error);
}

export function syncHostedToolOptions({
  toolId,
  descriptor = null,
  suppressRender = false,
  legacyState = null,
  persistSubtoolFromState = null,
  suppressSubtoolPersistence = false,
  scheduleToolDefaultsPersist = null,
  suppressToolDefaultsPersistence = false,
  beforeSync = null,
  afterSync = null,
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  try {
    beforeSync?.();

    const resolvedDescriptor = descriptor && typeof descriptor === 'object' ? descriptor : {};
    const resolvedLegacyState = legacyState ?? resolvedDescriptor?.legacyState ?? resolvedDescriptor?.state ?? null;

    toolOptionsController.setToolOptions(String(toolId || ''), {
      ...resolvedDescriptor,
      suppressRender
    });

    if (!suppressSubtoolPersistence && typeof persistSubtoolFromState === 'function') {
      persistSubtoolFromState(resolvedLegacyState);
    }

    if (!suppressToolDefaultsPersistence && typeof scheduleToolDefaultsPersist === 'function') {
      scheduleToolDefaultsPersist();
    }

    afterSync?.({
      descriptor: resolvedDescriptor,
      legacyState: resolvedLegacyState,
      handlers: resolvedDescriptor?.handlers || {}
    });

    return resolvedDescriptor;
  } catch (error) {
    Logger.warn?.(`${loggerPrefix}.toolOptions.syncFailed`, {
      toolId: String(toolId || ''),
      error: stringifyError(error)
    });
    return null;
  }
}

export function syncHostedToolOptionsOnMonitorTick({
  token = null,
  assignToken = null,
  sync = null,
  minIntervalMs = 200,
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  try {
    assignToken?.(token);

    const now = Date.now();
    const lastSync = token?.lastOptionsSync || 0;
    if (lastSync && now - lastSync < minIntervalMs) return false;
    if (token) token.lastOptionsSync = now;

    sync?.();
    return true;
  } catch (error) {
    Logger.warn?.(`${loggerPrefix}.toolOptions.monitorSyncFailed`, {
      error: stringifyError(error)
    });
    return false;
  }
}

export function scheduleHostedToolOptionsRefresh({
  refresh = null,
  shouldRefresh = null,
  includeMicrotask = true,
  delaysMs = [0, 50],
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  const runRefresh = () => {
    try {
      if (typeof shouldRefresh === 'function' && !shouldRefresh()) return false;
      refresh?.();
      return true;
    } catch (error) {
      Logger.warn?.(`${loggerPrefix}.toolOptions.postLaunchRefreshFailed`, {
        error: stringifyError(error)
      });
      return false;
    }
  };

  if (includeMicrotask) {
    try { queueMicrotask(runRefresh); }
    catch (_) {}
  }

  const delays = Array.isArray(delaysMs) ? delaysMs : [];
  for (const delay of delays) {
    const timeoutMs = Number(delay);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) continue;
    try { setTimeout(runRefresh, timeoutMs); } catch (_) {}
  }
}
