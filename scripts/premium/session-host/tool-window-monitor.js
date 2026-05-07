import { toolOptionsController } from '../../core/tool-options-controller.js';
import { syncHostedToolOptionsOnMonitorTick } from './tool-options-sync.js';

function scheduleMonitorTick(token, callback, timeoutMs) {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    token.usingTimeout = false;
    token.handle = window.requestAnimationFrame(callback);
    return;
  }
  token.usingTimeout = true;
  token.handle = setTimeout(callback, timeoutMs);
}

export function startToolWindowMonitor({
  delegate,
  isHostReady = null,
  onInactive = null,
  onHostUnavailable = null,
  onHostRecovered = null,
  onTick = null,
  timeoutMs = 200
} = {}) {
  if (!delegate) return null;

  const token = {
    cancelled: false,
    handle: null,
    usingTimeout: false,
    hostFailureAt: 0,
    hostFailureLogged: false
  };

  const schedule = () => {
    if (token.cancelled) return;
    scheduleMonitorTick(token, tick, timeoutMs);
  };

  const tick = () => {
    if (token.cancelled) return;

    let active = false;
    try { active = !!delegate?.isActive; }
    catch (_) { active = false; }

    if (!active) {
      try { onInactive?.({ token }); }
      catch (_) {}
      return;
    }

    if (typeof isHostReady === 'function') {
      let hostReady = false;
      try { hostReady = !!isHostReady({ token }); }
      catch (_) { hostReady = false; }

      if (!hostReady) {
        const now = Date.now();
        if (!token.hostFailureAt) token.hostFailureAt = now;
        const durationMs = now - token.hostFailureAt;
        const firstFailure = !token.hostFailureLogged;
        token.hostFailureLogged = true;

        let continueMonitoring = true;
        try {
          const result = onHostUnavailable?.({ token, durationMs, firstFailure });
          if (result === false) continueMonitoring = false;
        } catch (_) {
          continueMonitoring = false;
        }

        if (continueMonitoring) schedule();
        return;
      }

      if (token.hostFailureAt || token.hostFailureLogged) {
        token.hostFailureAt = 0;
        token.hostFailureLogged = false;
        try { onHostRecovered?.({ token }); }
        catch (_) {}
      }
    }

    try { onTick?.({ token }); }
    catch (_) {}

    schedule();
  };

  schedule();
  return token;
}

function deactivateMonitoredTool(toolId) {
  if (!toolId) return;
  toolOptionsController.deactivateTool(toolId);
}

function runInactiveMonitorCleanup({
  toolId,
  clearEditingTile = null,
  cancelMonitor = null,
  deactivateBeforeCancel = true,
  onInactive = null
} = {}) {
  clearEditingTile?.();
  if (deactivateBeforeCancel) deactivateMonitoredTool(toolId);
  cancelMonitor?.();
  if (!deactivateBeforeCancel) deactivateMonitoredTool(toolId);
  onInactive?.();
}

export function startHostedToolWindowMonitor({
  delegate,
  toolId,
  isHostReady = null,
  clearEditingTile = null,
  cancelMonitor = null,
  deactivateBeforeCancel = true,
  onInactive = null,
  stopOrphanedSession = null,
  hostUnavailableReason = 'host-context-unavailable',
  hostFailureGraceMs = 0,
  onHostFirstUnavailable = null,
  onHostRecovered = null,
  syncToolOptions = null,
  assignMonitorToken = null,
  monitorSyncLoggerPrefix = 'PremiumSessionHost',
  monitorSyncMinIntervalMs = 200,
  timeoutMs = 200
} = {}) {
  const graceMs = Math.max(0, Number(hostFailureGraceMs) || 0);
  return startToolWindowMonitor({
    delegate,
    isHostReady,
    timeoutMs,
    onInactive: () => runInactiveMonitorCleanup({
      toolId,
      clearEditingTile,
      cancelMonitor,
      deactivateBeforeCancel,
      onInactive
    }),
    onHostUnavailable: ({ token, durationMs, firstFailure }) => {
      if (firstFailure) onHostFirstUnavailable?.({ token, durationMs, firstFailure });
      if (graceMs > 0 && durationMs < graceMs) return true;
      stopOrphanedSession?.({ reason: hostUnavailableReason });
      return false;
    },
    onHostRecovered,
    onTick: typeof syncToolOptions === 'function'
      ? ({ token }) => syncHostedToolOptionsOnMonitorTick({
        token,
        assignToken: assignMonitorToken,
        sync: syncToolOptions,
        minIntervalMs: monitorSyncMinIntervalMs,
        loggerPrefix: monitorSyncLoggerPrefix
      })
      : null
  });
}

export function cancelToolWindowMonitor(token) {
  if (!token) return null;
  token.cancelled = true;
  if (token.handle != null) {
    try {
      if (token.usingTimeout) clearTimeout(token.handle);
      else if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(token.handle);
      } else if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(token.handle);
      }
    } catch (_) {}
  }
  token.handle = null;
  return null;
}
