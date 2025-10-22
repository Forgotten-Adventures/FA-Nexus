import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumEntitlementsService, PremiumGateError } from './premium-entitlements-service.js';

const DEFAULT_FEATURE_ENTITLEMENT = 'premium.all';
const MODULE_ID = 'fa-nexus';

function getModuleVersion() {
  try { return game?.modules?.get?.(MODULE_ID)?.version; }
  catch (_) { return null; }
}

class EventSignal {
  constructor() { this._map = new Map(); }
  on(event, fn) {
    if (!this._map.has(event)) this._map.set(event, new Set());
    const set = this._map.get(event);
    set.add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    const set = this._map.get(event);
    if (set) set.delete(fn);
  }
  emit(event, payload) {
    const set = this._map.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); }
      catch (err) { Logger.warn('PremiumFeatureBroker.emit.failed', { event, error: String(err?.message || err) }); }
    }
  }
  clear() { this._map.clear(); }
}

export class PremiumFeatureBroker {
  constructor({ service = premiumEntitlementsService } = {}) {
    this.service = service;
    this._features = new Map();
    this._bundleCache = new Map();
    this._events = new EventSignal();
    this._unsubscribe = this.service.onChange?.((snapshot) => this._handleServiceChange(snapshot));
    this._lastSnapshot = this.service.snapshot?.() || null;
    this._moduleVersion = getModuleVersion();
  }

  destroy() {
    if (typeof this._unsubscribe === 'function') this._unsubscribe();
    this._events.clear();
    this._features.clear();
    this._bundleCache.clear();
  }

  on(event, fn) { return this._events.on(event, fn); }

  registerFeature(featureId, config) {
    if (!featureId) throw new Error('featureId required');
    const normalized = {
      featureId,
      entitlementKey: config?.entitlementKey || DEFAULT_FEATURE_ENTITLEMENT,
      bundleId: config?.bundleId || null,
      factory: config?.factory || null,
      eager: !!config?.eager
    };
    this._features.set(featureId, normalized);
    return normalized;
  }

  can(featureId) {
    const feature = this._features.get(featureId);
    if (!feature) return false;
    const entitlements = this.service.entitlements || {};
    return !!(entitlements[feature.entitlementKey] || entitlements[DEFAULT_FEATURE_ENTITLEMENT]);
  }

  async require(featureId, options = {}) {
    const feature = this._features.get(featureId);
    if (!feature) throw new Error(`Unknown premium feature: ${featureId}`);

    const revalidate = !!options.revalidate;
    const bundleId = options.bundleId || feature.bundleId || null;
    const reason = options.reason || (revalidate ? `require:revalidate:${featureId}` : `require:${featureId}`);

    if (!revalidate && this.can(featureId)) return true;

    await this.refresh({ force: revalidate, reason, bundle: bundleId });
    if (this.can(featureId)) return true;
    throw new PremiumGateError('ENTITLEMENT_REQUIRED', `Premium entitlement required for ${featureId}`);
  }

  async refresh({ force = false, reason, bundle, signal } = {}) {
    try {
      Logger.info('PremiumFeatureBroker.refresh', { force, reason, bundle });
      return await this.service.refresh({ force, bundle, signal });
    } catch (err) {
      this._events.emit('error', err);
      throw err;
    }
  }

  async resolve(featureId, options = {}) {
    const feature = this._features.get(featureId);
    if (!feature) throw new Error(`Unknown premium feature: ${featureId}`);

    const bundleId = feature.bundleId || null;

    await this.require(featureId, { bundleId });

    if (!feature.bundleId) {
      if (typeof feature.factory === 'function') return feature.factory();
      return null;
    }

    const module = await this._loadBundle(feature.bundleId, options);
    if (typeof feature.factory === 'function') return feature.factory(module, options);
    return module;
  }

  async preload(featureId, options = {}) {
    const feature = this._features.get(featureId);
    if (!feature) throw new Error(`Unknown premium feature: ${featureId}`);

    const {
      revalidate = false,
      skipRequire = false,
      forceReload = false,
      signal
    } = options;

    const bundleId = feature.bundleId || null;

    if (!skipRequire) {
      const reason = options.reason || (revalidate ? `preload:revalidate:${featureId}` : `preload:${featureId}`);
      await this.require(featureId, { bundleId, revalidate, reason, signal });
    } else if (!this.can(featureId)) {
      return false;
    }

    if (!bundleId) return true;
    if (this._bundleCache.has(bundleId) && !forceReload) return true;

    await this._loadBundle(bundleId, { signal });
    return true;
  }

  async _loadBundle(bundleId, options = {}) {
    const cached = this._bundleCache.get(bundleId);
    if (cached) return cached;

    const descriptor = this.service.getBundleDescriptor(bundleId);
    if (!descriptor) {
      throw new PremiumGateError('BUNDLE_MISSING', `Bundle descriptor not available for ${bundleId}`);
    }

    this._ensureCompatibility(bundleId, descriptor);

    Logger.info('PremiumFeatureBroker.bundle.fetch', { bundleId, expiresAt: descriptor.expiresAt });

    const response = await fetch(descriptor.downloadUrl, { cache: 'no-store', signal: options.signal });
    if (!response.ok) {
      throw new PremiumGateError('BUNDLE_FETCH_FAILED', `Bundle request failed (${response.status})`, { status: response.status });
    }
    let blob = await response.blob();

    if (descriptor.hash) {
      const verified = await this._verifyBlobHash(blob, descriptor.hash);
      if (!verified.ok) {
        throw new PremiumGateError('BUNDLE_HASH_MISMATCH', `Hash mismatch for bundle ${bundleId}`, {
          expected: verified.expected,
          actual: verified.actual
        });
      }
      blob = verified.blob;
    }

    const objectUrl = URL.createObjectURL(blob);
    try {
      const module = await import(/* webpackIgnore: true */ objectUrl);
      this._bundleCache.set(bundleId, module);
      this._events.emit('bundleLoaded', { bundleId, module });
      return module;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  _handleServiceChange(snapshot) {
    this._lastSnapshot = snapshot;
    this._events.emit('change', snapshot);
    const noEntitlements = !snapshot?.entitlements || Object.keys(snapshot.entitlements).length === 0;
    const lostSession = !snapshot?.sessionToken;
    if (snapshot.status === 'error' || noEntitlements || lostSession) {
      this._bundleCache.clear();
    }
  }

  _ensureCompatibility(bundleId, descriptor) {
    try {
      const moduleVersion = getModuleVersion();
      const { minModule, maxModule } = descriptor || {};
      if (minModule && PremiumFeatureBroker._compareVersions(moduleVersion, minModule) < 0) {
        throw new PremiumGateError('MODULE_UPDATE_REQUIRED', `Update FA Nexus to at least ${minModule} for ${bundleId}.`);
      }
      if (maxModule && PremiumFeatureBroker._compareVersions(moduleVersion, maxModule) > 0) {
        throw new PremiumGateError('MODULE_TOO_NEW', `FA Nexus ${moduleVersion} is newer than supported (${maxModule}) for ${bundleId}.`);
      }
    } catch (err) {
      if (err instanceof PremiumGateError) throw err;
      Logger.warn('PremiumFeatureBroker.compatibility.check.failed', String(err?.message || err));
    }
  }

  static _compareVersions(a, b) {
    const partsA = PremiumFeatureBroker._toVersionParts(a);
    const partsB = PremiumFeatureBroker._toVersionParts(b);
    const length = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < length; i++) {
      const segmentA = partsA[i] ?? 0;
      const segmentB = partsB[i] ?? 0;
      if (segmentA > segmentB) return 1;
      if (segmentA < segmentB) return -1;
    }
    return 0;
  }

  static _toVersionParts(value) {
    if (!value) return [0];
    try {
      return String(value)
        .split('.')
        .map((segment) => Number.parseInt(segment, 10))
        .filter((num) => Number.isFinite(num));
    } catch (_) {
      return [0];
    }
  }

  async _verifyBlobHash(blob, expectedHash) {
    try {
      if (!blob) return { ok: false, expected: expectedHash, actual: null, blob }; // fall through to error
      if (!globalThis.crypto?.subtle) {
        Logger.warn('PremiumFeatureBroker.hash.verify.unavailable', 'WebCrypto unavailable; skipping hash validation.');
        return { ok: true, expected: null, actual: null, blob };
      }
      const buffer = await blob.arrayBuffer();
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
      const actualHex = PremiumFeatureBroker._hexStringFromBuffer(digest);
      const normalizedExpected = PremiumFeatureBroker._normalizeHash(expectedHash);
      if (normalizedExpected && actualHex !== normalizedExpected) {
        return { ok: false, expected: normalizedExpected, actual: actualHex, blob };
      }
      const typed = blob.type ? { type: blob.type } : undefined;
      return { ok: true, expected: normalizedExpected, actual: actualHex, blob: new Blob([buffer], typed) };
    } catch (err) {
      Logger.warn('PremiumFeatureBroker.hash.verify.failed', String(err?.message || err));
      return { ok: false, expected: expectedHash, actual: null, blob };
    }
  }

  static _hexStringFromBuffer(buffer) {
    try {
      const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer || buffer);
      return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return null;
    }
  }

  static _normalizeHash(value) {
    if (!value) return null;
    try {
      return String(value).trim().toLowerCase().replace(/^0x/, '');
    } catch (_) {
      return null;
    }
  }
}

export const premiumFeatureBroker = new PremiumFeatureBroker();
