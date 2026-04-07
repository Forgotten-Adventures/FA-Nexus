import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { getPremiumEntitlementSnapshotOverride, handlePremiumRuntimeSettingChange } from './premium-runtime-config.js';

const DEFAULT_ENDPOINT = 'foundry-nexus-premium-entitlements';
const MODULE_ID = 'fa-nexus';

function getModuleVersion() {
  try {
    return game?.modules?.get?.(MODULE_ID)?.version;
  } catch (_) {
    return null;
  }
}

export class PremiumGateError extends Error {
  constructor(code, message, details) {
    super(message || code || 'Premium gate error');
    this.name = 'PremiumGateError';
    this.code = code || 'UNKNOWN';
    if (details) this.details = details;
  }
}

/**
 * Lightweight event emitter for entitlement changes.
 */
class ChangeEmitter {
  constructor() { this._listeners = new Set(); }
  on(fn) { if (typeof fn === 'function') this._listeners.add(fn); return () => this.off(fn); }
  off(fn) { this._listeners.delete(fn); }
  emit(payload) {
    for (const fn of this._listeners) {
      try { fn(payload); }
      catch (err) { Logger.warn('PremiumEntitlementsService.change.emit', { error: String(err?.message || err) }); }
    }
  }
  clear() { this._listeners.clear(); }
}

export class PremiumEntitlementsService {
  constructor({ base, endpoint, moduleVersion } = {}) {
    this.base = base || 'https://n8n.forgotten-adventures.net/webhook';
    this.endpoint = endpoint || DEFAULT_ENDPOINT;
    this._moduleVersion = moduleVersion || getModuleVersion();
    this._state = {
      status: 'idle',
      entitlements: Object.create(null),
      sessionToken: null,
      expiresAt: null,
      bundles: new Map()
    };
    this._latestRefresh = null;
    this._changeEmitter = new ChangeEmitter();
    this._inflight = null;
    this._refreshSequence = 0;
    this._activeRefreshId = 0;
    this._settingsHook = null;
    this._installSettingsHook();
  }

  onChange(handler) { return this._changeEmitter.on(handler); }

  get status() { return this._state.status; }
  get entitlements() { return this._state.entitlements; }
  get sessionToken() { return this._state.sessionToken; }
  get expiresAt() { return this._state.expiresAt; }

  get bundles() { return this._state.bundles; }

  snapshot() {
    return {
      status: this._state.status,
      entitlements: { ...this._state.entitlements },
      sessionToken: this._state.sessionToken,
      expiresAt: this._state.expiresAt,
      bundles: new Map(this._state.bundles)
    };
  }

  async refresh({ signal, force = false, bundle } = {}) {
    if (this._inflight && !force) return this._inflight;
    const requestId = ++this._refreshSequence;
    this._activeRefreshId = requestId;
    const task = this._doRefresh({ signal, bundle, requestId }).finally(() => {
      if (this._inflight === task) this._inflight = null;
    });
    this._inflight = task;
    return task;
  }

  async _doRefresh({ signal, bundle, requestId }) {
    try {
      const overrideSnapshot = await getPremiumEntitlementSnapshotOverride();
      if (overrideSnapshot) {
        if (!this._applyRefreshState(overrideSnapshot, requestId)) return this.snapshot();
        this._latestRefresh = Date.now();
        Logger.info('PremiumEntitlementsService.refresh.devBridge', {
          bundle: bundle || null,
          bundles: Array.from(overrideSnapshot.bundles.keys())
        });
        return this.snapshot();
      }

      const state = this._resolvePatreonState();
      if (!state) {
        this.clear({ silent: true, reason: 'missing-state', requestId });
        throw new PremiumGateError('STATE_MISSING', 'No stored Patreon state; authenticate first.');
      }

      const url = new URL(`${this.base.replace(/\/$/, '')}/${this.endpoint}`);
      url.searchParams.set('state', state);
      const bundleId = bundle || '';
      if (bundleId) url.searchParams.set('bundle', bundleId);
      const currentModuleVersion = getModuleVersion();
      Logger.info('PremiumEntitlementsService.refresh.version', { detectedVersion: currentModuleVersion });
      if (currentModuleVersion) url.searchParams.set('moduleVersion', currentModuleVersion);

      if (!this._applyRefreshState({ status: 'refreshing' }, requestId)) return this.snapshot();

      const res = await fetch(url.toString(), { method: 'GET', signal });
      const payload = await this._safeJson(res);
      if (!res.ok || !payload?.success) {
        const code = payload?.error || `HTTP_${res.status}`;
        throw new PremiumGateError(code, payload?.message || 'Premium entitlement request failed', payload);
      }

      const entitlements = this._normalizeEntitlements(payload);
      const bundles = this._normalizeBundles(payload);
      const expiresAt = payload.expires_at ? Number(new Date(payload.expires_at).getTime() || 0) : null;
      const sessionToken = payload.session_token || null;

      const snapshot = {
        status: 'ready',
        entitlements,
        bundles,
        expiresAt,
        sessionToken
      };

      if (!this._applyRefreshState(snapshot, requestId)) return this.snapshot();
      this._latestRefresh = Date.now();
      Logger.info('PremiumEntitlementsService.refresh.success', {
        expiresAt,
        entitlements: Object.keys(entitlements)
      });
      return this.snapshot();
    } catch (err) {
      Logger.warn('PremiumEntitlementsService.refresh.failed', {
        error: String(err?.message || err),
        code: err?.code || err?.name
      });
      if (!this._isActiveRefreshRequest(requestId)) {
        Logger.info('PremiumEntitlementsService.refresh.staleFailureIgnored', {
          requestId,
          activeRequestId: this._activeRefreshId,
          code: err?.code || err?.name
        });
        return this.snapshot();
      }
      this._applyRefreshState({ status: 'error' }, requestId);
      throw err;
    }
  }

  getBundleDescriptor(bundleId) {
    if (!bundleId) return null;
    return this._state.bundles.get(bundleId) || null;
  }

  _normalizeEntitlements(payload) {
    const output = Object.create(null);
    if (payload?.entitlements && typeof payload.entitlements === 'object') {
      for (const [key, value] of Object.entries(payload.entitlements)) {
        output[String(key)] = !!value;
      }
    } else if (payload?.success) {
      output['premium.all'] = true;
    }
    return output;
  }

  _normalizeBundles(payload) {
    const result = new Map();
    const list = Array.isArray(payload?.bundles) ? payload.bundles : [];
    for (const item of list) {
      if (!item) continue;
      const id = String(item.id || '').trim();
      if (!id) continue;
      result.set(id, {
        id,
        downloadUrl: item.download_url || item.url || null,
        signature: item.signature || null,
        hash: item.hash || null,
        fileVersion: item.file_version || null,
        version: item.version || null,
        minModule: item.min_module || null,
        maxModule: item.max_module || null,
        meta: item.meta || null,
        expiresAt: item.expires_at ? Number(new Date(item.expires_at).getTime() || 0) : null
      });
    }
    return result;
  }

  _resolvePatreonState() {
    try {
      const data = game.settings.get('fa-nexus', 'patreon_auth_data');
      return data?.state || null;
    } catch (err) {
      Logger.warn('PremiumEntitlementsService.resolveState.failed', { error: String(err?.message || err) });
      return null;
    }
  }

  async _safeJson(res) {
    try {
      return await res.json();
    } catch (err) {
      Logger.warn('PremiumEntitlementsService.safeJson.failed', { error: String(err?.message || err) });
      return null;
    }
  }

  _updateState(partial) {
    const next = { ...this._state };
    if (partial.status) next.status = partial.status;
    if (partial.entitlements) next.entitlements = partial.entitlements;
    if (partial.sessionToken !== undefined) next.sessionToken = partial.sessionToken;
    if (partial.expiresAt !== undefined) next.expiresAt = partial.expiresAt;
    if (partial.bundles instanceof Map) next.bundles = partial.bundles;
    this._state = next;
    this._changeEmitter.emit(this.snapshot());
  }

  _isActiveRefreshRequest(requestId) {
    return requestId == null || requestId === this._activeRefreshId;
  }

  _applyRefreshState(partial, requestId) {
    if (!this._isActiveRefreshRequest(requestId)) {
      Logger.info('PremiumEntitlementsService.refresh.staleIgnored', {
        requestId,
        activeRequestId: this._activeRefreshId,
        status: partial?.status || null
      });
      return false;
    }
    this._updateState(partial);
    return true;
  }

  clear({ silent = false, reason = 'manual', requestId = null } = {}) {
    if (requestId != null && !this._isActiveRefreshRequest(requestId)) {
      Logger.info('PremiumEntitlementsService.clear.staleIgnored', {
        requestId,
        activeRequestId: this._activeRefreshId,
        reason
      });
      return false;
    }
    this._inflight = null;
    this._latestRefresh = null;
    if (requestId == null) {
      this._activeRefreshId = ++this._refreshSequence;
    }
    const snapshot = {
      status: 'idle',
      entitlements: Object.create(null),
      sessionToken: null,
      expiresAt: null,
      bundles: new Map()
    };
    this._updateState(snapshot);
    if (!silent) {
      try { Logger.info('PremiumEntitlementsService.clear', { reason }); }
      catch (_) {}
    }
    return true;
  }

  destroy() {
    try {
      if (this._settingsHook && globalThis?.Hooks?.off) {
        globalThis.Hooks.off('updateSetting', this._settingsHook);
      }
    } catch (_) {}
    this._settingsHook = null;
    this._changeEmitter.clear();
    this._refreshSequence = 0;
    this._activeRefreshId = 0;
    this._state = {
      status: 'idle',
      entitlements: Object.create(null),
      sessionToken: null,
      expiresAt: null,
      bundles: new Map()
    };
  }

  _installSettingsHook() {
    try {
      const hookApi = globalThis?.Hooks;
      if (!hookApi?.on || this._settingsHook) return;
      this._settingsHook = (setting) => {
        try {
          handlePremiumRuntimeSettingChange(setting, {
            clear: (options) => this.clear(options)
          });
        } catch (error) {
          Logger.warn('PremiumEntitlementsService.settingsHook.error', { error: String(error?.message || error) });
        }
      };
      hookApi.on('updateSetting', this._settingsHook);
    } catch (error) {
      Logger.warn('PremiumEntitlementsService.settingsHook.installFailed', { error: String(error?.message || error) });
    }
  }
}

export const premiumEntitlementsService = new PremiumEntitlementsService();
