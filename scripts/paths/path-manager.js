import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { premiumEntitlementsService } from '../premium/premium-entitlements-service.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import './path-tiles.js';
import { toolOptionsController } from '../core/tool-options-controller.js';
import { requestSelectionFilterRefresh } from '../canvas/selection-filter-refresh.js';

const MODULE_ID = 'fa-nexus';
const PATH_SUBTOOL_SETTING_KEY = 'pathToolActiveSubtool';
const PATH_SUBTOOL_IDS = new Set(['curve', 'draw']);

export class PathManager {
  constructor(app) {
    this._app = app;
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._lastPersistedSubtool = null;
    this._toolDefaultsPersistTimer = null;
    this._syncToolOptionsState();
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  get pathTension() {
    return this._delegate?.pathTension ?? 0;
  }

  setPathTension(value) {
    if (!this._delegate) return value;
    return this._delegate.setPathTension(value);
  }

  async _ensureDelegate() {
    if (this._delegate) return this._delegate;
    ensurePremiumFeaturesRegistered();
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const helper = await premiumFeatureBroker.resolve('path.edit');
      let instance = null;
      if (helper?.create) instance = helper.create(this._app);
      else if (typeof helper === 'function') instance = new helper(this._app);
      if (!instance) throw new Error('Premium path editor bundle missing PathManager implementation');
      this._delegate = instance;
      try { instance.attachHost?.(this); }
      catch (_) {}
      try {
        Logger.info?.('PathEditor.bundle.loaded', { version: instance?.version || '0.0.15' });
        const hooks = globalThis?.Hooks;
        hooks?.callAll?.('fa-nexus-path-editor-loaded', { version: instance?.version || '0.0.15' });
      } catch (logError) {
        Logger.warn?.('PathEditor.bundle.loaded.logFailed', String(logError?.message || logError));
      }
      return instance;
    })();
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  }

  async start(...args) {
    const delegate = await this._ensureDelegate();
    let result;
    try {
      this._refreshDelegateToolDefaults();
      result = delegate.start?.(...args);
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({
        suppressSubtoolPersistence: true,
        suppressToolDefaultsPersistence: true
      });
      toolOptionsController.activateTool('path.edit', { label: 'Path Editor' });
      this._beginToolWindowMonitor('path.edit', delegate);
      this._restoreSubtoolPreference();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool('path.edit');
        });
      }
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  async editTile(targetTile, options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed path editor bundle does not support editing existing tiles.');
    }
    let result;
    try {
      this._refreshDelegateToolDefaults();
      result = delegate.editTile(targetTile, options);
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({
        suppressSubtoolPersistence: true,
        suppressToolDefaultsPersistence: true
      });
      toolOptionsController.activateTool('path.edit', { label: 'Path Editor' });
      this._beginToolWindowMonitor('path.edit', delegate);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool('path.edit');
        });
      }
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  stop(...args) {
    this._cancelToolWindowMonitor();
    const finalize = () => {
      toolOptionsController.deactivateTool('path.edit');
      requestSelectionFilterRefresh({
        reason: 'path-editor-stop',
        source: 'path-manager'
      });
    };
    if (!this._delegate) {
      finalize();
      return;
    }
    try {
      if (this._delegate?.isActive) this._persistDelegateToolDefaults();
      const result = this._delegate.stop?.(...args);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(finalize);
      }
      finalize();
      return result;
    } catch (error) {
      finalize();
      throw error;
    }
  }

  async savePath(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.savePath?.(...args);
  }

  async save(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.save?.(...args);
  }

  _scheduleEntitlementProbe() {
    ensurePremiumFeaturesRegistered();
    if (this._entitlementProbe) return this._entitlementProbe;
    const probe = (async () => {
      try {
        await premiumFeatureBroker.require('path.edit', { revalidate: true, reason: 'path-edit:revalidate' });
      } catch (error) {
        this._handleEntitlementFailure(error);
      } finally {
        if (this._entitlementProbe === probe) this._entitlementProbe = null;
      }
    })();
    this._entitlementProbe = probe;
    probe.catch(() => {});
    return probe;
  }

  _handleEntitlementFailure(error) {
    try { this.stop?.(); }
    catch (_) {}
    this._delegate = null;
    const hasAuth = this._hasPremiumAuth();
    if (!hasAuth) {
      Logger.info?.('PathManager.entitlement.skipDisconnect', {
        code: error?.code || error?.name,
        message: String(error?.message || error)
      });
      return;
    }
    const message = '🔐 Authentication expired - premium path editing has been disabled. Please reconnect Patreon.';
    if (this._isAuthFailure(error)) {
      try { premiumEntitlementsService?.clear?.({ reason: 'path-revalidate-failed' }); }
      catch (_) {}
      try { game?.settings?.set?.('fa-nexus', 'patreon_auth_data', null); }
      catch (_) {}
      ui?.notifications?.warn?.(message);
    } else {
      const fallback = `Unable to confirm premium access: ${error?.message || error}`;
      ui?.notifications?.error?.(fallback);
    }
    try { Hooks?.callAll?.('fa-nexus-premium-auth-lost', { featureId: 'path.edit', error }); }
    catch (_) {}
  }

  _isAuthFailure(error) {
    if (!error) return false;
    const code = String(error?.code || error?.name || '').toUpperCase();
    if (code && (/AUTH/.test(code) || ['STATE_MISSING', 'ENTITLEMENT_REQUIRED', 'HTTP_401', 'HTTP_403', 'SESSION_EXPIRED', 'STATE_INVALID'].includes(code))) {
      return true;
    }
    const message = String(error?.message || '').toLowerCase();
    return message.includes('auth') || message.includes('state');
  }

  _hasPremiumAuth() {
    try {
      const authData = game?.settings?.get?.('fa-nexus', 'patreon_auth_data');
      return !!(authData && authData.authenticated && authData.state);
    } catch (_) {
      return false;
    }
  }

  _beginToolWindowMonitor(toolId, delegate) {
    this._cancelToolWindowMonitor();
    if (!delegate) return;
    const token = { cancelled: false, handle: null, usingTimeout: false, toolId };
    const schedule = (callback) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        token.usingTimeout = false;
        token.handle = window.requestAnimationFrame(callback);
      } else {
        token.usingTimeout = true;
        token.handle = setTimeout(callback, 200);
      }
    };
    const tick = () => {
      if (token.cancelled) return;
      let active = false;
      try { active = !!delegate?.isActive; }
      catch (_) { active = false; }
      if (!active) {
        requestSelectionFilterRefresh({
          reason: 'path-editor-monitor-stop',
          source: 'path-manager'
        });
        toolOptionsController.deactivateTool(toolId);
        this._cancelToolWindowMonitor();
        return;
      }
      schedule(tick);
    };
    this._toolMonitor = token;
    schedule(tick);
  }

  _cancelToolWindowMonitor() {
    const token = this._toolMonitor;
    if (!token) return;
    token.cancelled = true;
    if (token.handle != null) {
      try {
        if (token.usingTimeout) clearTimeout(token.handle);
        else if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(token.handle);
      } catch (_) {}
    }
    this._toolMonitor = null;
  }

  _buildToolOptionsState() {
    const baseHints = [
      'LMB adds control points;',
      'LMB Drag existing points to adjust;',
      'Shift+LMB inserts along the path;',
      'Alt+LMB deletes the closest point.',
      'Ctrl/Cmd+Wheel adjusts scale;',
      'Alt+Wheel changes elevation (Shift=coarse, Ctrl/Cmd=fine).',
      'Press S to save the path; ESC to exit.'
    ];
    let delegateState = {};
    let handlers = {};
    try {
      const descriptor = this._delegate?.getToolOptionsDescriptor?.();
      if (descriptor) {
        if (descriptor.state && typeof descriptor.state === 'object') delegateState = descriptor.state;
        if (descriptor.handlers && typeof descriptor.handlers === 'object') handlers = descriptor.handlers;
      }
    } catch (_) {}
    const mergedHints = [...baseHints];
    if (Array.isArray(delegateState?.hints)) {
      for (const hint of delegateState.hints) {
        if (typeof hint === 'string' && hint.trim()) mergedHints.push(hint.trim());
      }
    }
    const state = { ...delegateState, hints: mergedHints };
    return { state, handlers };
  }

  _syncToolOptionsState({
    suppressRender = false,
    suppressSubtoolPersistence = false,
    suppressToolDefaultsPersistence = false
  } = {}) {
    try {
      const descriptor = this._buildToolOptionsState();
      toolOptionsController.setToolOptions('path.edit', {
        state: descriptor.state,
        handlers: descriptor.handlers,
        suppressRender
      });
      this._persistSubtoolFromState(descriptor.state, { suppress: suppressSubtoolPersistence });
      if (!suppressToolDefaultsPersistence) this._scheduleToolDefaultsPersist();
    } catch (_) {}
  }

  requestToolOptionsUpdate(options = {}) {
    this._syncToolOptionsState(options);
  }

  _persistDelegateToolDefaults() {
    const delegate = this._delegate;
    if (!delegate) return;
    if (typeof delegate._persistToolDefaults !== 'function') return;
    try { delegate._persistToolDefaults(); } catch (_) {}
  }

  _refreshDelegateToolDefaults() {
    const delegate = this._delegate;
    if (!delegate) return;
    try {
      if (typeof delegate._readToolDefaults === 'function') {
        const defaults = delegate._readToolDefaults();
        delegate._toolDefaults = defaults && typeof defaults === 'object' ? defaults : null;
      } else if ('_toolDefaults' in delegate) {
        delegate._toolDefaults = null;
      }
    } catch (_) {}
  }

  _scheduleToolDefaultsPersist() {
    if (!this._delegate?.isActive) return;
    if (this._toolDefaultsPersistTimer) return;
    this._toolDefaultsPersistTimer = setTimeout(() => {
      this._toolDefaultsPersistTimer = null;
      if (!this._delegate?.isActive) return;
      this._persistDelegateToolDefaults();
    }, 200);
  }

  _readSubtoolPreference() {
    try {
      const value = game?.settings?.get?.(MODULE_ID, PATH_SUBTOOL_SETTING_KEY);
      const normalized = typeof value === 'string' ? value : '';
      return PATH_SUBTOOL_IDS.has(normalized) ? normalized : null;
    } catch (_) {
      return null;
    }
  }

  _persistSubtoolPreference(value) {
    if (!value || !PATH_SUBTOOL_IDS.has(value)) return;
    if (this._lastPersistedSubtool === value) return;
    this._lastPersistedSubtool = value;
    try { game?.settings?.set?.(MODULE_ID, PATH_SUBTOOL_SETTING_KEY, value); } catch (_) {}
  }

  _extractActiveSubtoolId(state) {
    const toggles = Array.isArray(state?.subtoolToggles) ? state.subtoolToggles : [];
    for (const toggle of toggles) {
      if (!toggle || typeof toggle !== 'object') continue;
      if (!toggle.enabled) continue;
      const id = String(toggle.id || '');
      if (PATH_SUBTOOL_IDS.has(id)) return id;
    }
    return null;
  }

  _persistSubtoolFromState(state, { suppress = false } = {}) {
    if (suppress) return;
    const active = this._extractActiveSubtoolId(state);
    if (!active) return;
    this._persistSubtoolPreference(active);
  }

  _restoreSubtoolPreference() {
    const preferred = this._readSubtoolPreference();
    if (!preferred) return;
    this._lastPersistedSubtool = preferred;
    const apply = () => {
      try {
        const result = toolOptionsController?.requestCustomToggle?.(preferred, true);
        if (result === false) {
          setTimeout(() => {
            try { toolOptionsController?.requestCustomToggle?.(preferred, true); } catch (_) {}
          }, 50);
        }
      } catch (_) {}
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(apply);
    else setTimeout(apply, 0);
  }
}

export default PathManager;
