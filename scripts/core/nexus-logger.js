/**
 * NexusLogger
 * Centralized debug logger for FA Nexus. Use game setting `fa-nexus.debugLogging`
 * or `window.faNexus.debug=true` to enable verbose logs.
 */
export const NexusLogger = {
  _isEnabled() {
    try {
      const s = globalThis.game?.settings?.get?.('fa-nexus', 'debugLogging');
      if (s === true) return true;
    } catch (_) {}
    try { if (globalThis.window?.faNexus?.debug === true) return true; } catch (_) {}
    return false;
  },
  info(...args) {
    if (this._isEnabled()) console.info('[fa-nexus]', ...args);
  },
  debug(...args) {
    if (this._isEnabled()) console.debug('[fa-nexus]', ...args);
  },
  warn(...args) { console.warn('[fa-nexus]', ...args); },
  error(...args) { console.error('[fa-nexus]', ...args); },
  time(label) { if (this._isEnabled()) console.time(`[fa-nexus] ${label}`); },
  timeEnd(label) { if (this._isEnabled()) console.timeEnd(`[fa-nexus] ${label}`); },
  setDebug(enabled) {
    try { globalThis.window.faNexus = Object.assign(globalThis.window.faNexus || {}, { debug: !!enabled }); } catch (_) {}
  }
};

