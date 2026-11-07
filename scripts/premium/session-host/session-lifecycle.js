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

export function syncHostedPreviewLaunchState({
  applyLaunchPlacementAnchorTileId = null,
  syncPreviewRenderSort = null,
  applyCurrentPreviewLayerOrdering = null,
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  try {
    canvas?.tiles?.releaseAll?.();
  } catch (error) {
    Logger.warn?.(`${loggerPrefix}.previewLaunch.releaseAllFailed`, {
      error: stringifyError(error)
    });
  }
  applyLaunchPlacementAnchorTileId?.();
  syncPreviewRenderSort?.();
  applyCurrentPreviewLayerOrdering?.();
  globalThis.Hooks?.callAll?.('fa-nexus-preview-layers-changed', {
    source: 'premium-preview-launch-sync'
  });
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
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  if (!delegate?.isActive) return false;
  try {
    if (typeof delegate?.hasSessionChanges === 'function') {
      return !!delegate.hasSessionChanges();
    }
  } catch (error) {
    Logger.warn?.(`${loggerPrefix}.session.hasChangesFailed`, {
      error: stringifyError(error)
    });
  }
  return false;
}

export function hasHostedSessionUnresolvedTransientState(delegate, {
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  if (!delegate?.isActive) return false;
  try {
    if (typeof delegate?.hasUnresolvedTransientState === 'function') {
      return !!delegate.hasUnresolvedTransientState();
    }
  } catch (error) {
    Logger.warn?.(`${loggerPrefix}.session.hasUnresolvedTransientStateFailed`, {
      error: stringifyError(error)
    });
  }
  return false;
}

export function canCommitHostedSession(delegate, {
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  if (!delegate?.isActive) return false;
  try {
    if (typeof delegate?.canCommitSession === 'function') {
      return !!delegate.canCommitSession();
    }
  } catch (error) {
    Logger.warn?.(`${loggerPrefix}.session.canCommitFailed`, {
      error: stringifyError(error)
    });
  }
  return false;
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
  // A refusal the user can act on is not a fault: no login or tier (the entitlement codes) or a 0.5.3 Building the
  // editor declined to open (its error carries the preflight result).
  const refused = !!error?.preflight || ['STATE_MISSING', 'PRO_TIER_REQUIRED', 'ENTITLEMENT_REQUIRED'].includes(String(error?.code || '').toUpperCase());
  Logger[refused ? 'warn' : 'error']?.(`${loggerPrefix}.session.launchFailed`, {
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
