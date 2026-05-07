import { NexusLogger as Logger } from '../../core/nexus-logger.js';

function stringifyError(error) {
  return String(error?.message || error);
}

export function wrapSessionLaunchResult(result, onFailure = null) {
  if (!result || typeof result.then !== 'function') return result;
  return Promise.resolve(result).catch(async (error) => {
    await onFailure?.(error);
    throw error;
  });
}

export async function runHostedSessionLaunch({
  beforeLaunch = null,
  launchSession = null,
  awaitLaunch = false,
  afterLaunch = null,
  handleLaunchFailure = null,
  scheduleEntitlementProbe = null
} = {}) {
  let result;
  try {
    beforeLaunch?.();
    result = launchSession?.();
    if (awaitLaunch && result && typeof result.then === 'function') {
      result = await Promise.resolve(result);
    }
    afterLaunch?.(result);
    if (!awaitLaunch) {
      result = wrapSessionLaunchResult(result, handleLaunchFailure);
    }
    return result;
  } catch (error) {
    await handleLaunchFailure?.(error);
    throw error;
  } finally {
    try { scheduleEntitlementProbe?.(); } catch (_) {}
  }
}

export function stopSessionWithFinalize({
  delegate = null,
  beforeStop = null,
  persistToolDefaults = null,
  stopSession = null,
  finalize = null,
  onStopError = null
} = {}) {
  beforeStop?.();

  if (!delegate) {
    return finalize?.();
  }

  try {
    if (delegate?.isActive) persistToolDefaults?.(delegate);
    const result = stopSession ? stopSession(delegate) : delegate?.stop?.();
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result)
        .catch((error) => {
          onStopError?.(error);
          throw error;
        })
        .finally(() => finalize?.());
    }
    finalize?.();
    return result;
  } catch (error) {
    finalize?.();
    onStopError?.(error);
    throw error;
  }
}

export function hasHostedSessionChanges(delegate, {
  fallbackWhenActive = true
} = {}) {
  if (!delegate?.isActive) return false;
  try {
    if (typeof delegate?.hasSessionChanges === 'function') {
      return !!delegate.hasSessionChanges();
    }
  } catch (_) {}
  return !!fallbackWhenActive;
}

export function canCommitHostedSession(delegate, {
  fallback = null
} = {}) {
  if (!delegate?.isActive) return false;
  try {
    if (typeof delegate?.canCommitSession === 'function') {
      return !!delegate.canCommitSession();
    }
    if (typeof delegate?._canCommitSession === 'function') {
      return !!delegate._canCommitSession();
    }
  } catch (_) {}
  if (typeof fallback === 'function') return !!fallback(delegate);
  return hasHostedSessionChanges(delegate);
}

export async function handleSessionLaunchFailure({
  error,
  phase = 'start',
  loggerPrefix = 'PremiumSessionHost',
  details = null,
  cancelToolWindowMonitor = null,
  stopSession = null,
  onFallbackCleanup = null
} = {}) {
  Logger.error?.(`${loggerPrefix}.session.launchFailed`, {
    phase,
    error: stringifyError(error),
    ...(details && typeof details === 'object' ? details : {})
  });

  try { cancelToolWindowMonitor?.(); } catch (_) {}

  try {
    await Promise.resolve(stopSession?.({ reason: `${phase}-failed` }));
  } catch (stopError) {
    Logger.error?.(`${loggerPrefix}.session.launchFailed.stopFailed`, {
      phase,
      error: stringifyError(stopError)
    });
    try { onFallbackCleanup?.(stopError); } catch (_) {}
  }
}

export function stopOrphanedSession({
  reason = 'host-context-unavailable',
  loggerPrefix = 'PremiumSessionHost',
  details = null,
  cancelToolWindowMonitor = null,
  stopSession = null,
  onFallbackCleanup = null
} = {}) {
  Logger.error?.(`${loggerPrefix}.session.orphaned`, {
    reason,
    ...(details && typeof details === 'object' ? details : {})
  });

  try { cancelToolWindowMonitor?.(); } catch (_) {}

  const handleStopFailure = (stopError) => {
    Logger.error?.(`${loggerPrefix}.session.orphaned.stopFailed`, {
      reason,
      error: stringifyError(stopError)
    });
    try { onFallbackCleanup?.(stopError); } catch (_) {}
  };

  try {
    const result = stopSession?.({ reason });
    if (result && typeof result.catch === 'function') {
      result.catch(handleStopFailure);
    }
    return result;
  } catch (stopError) {
    handleStopFailure(stopError);
    return null;
  }
}
