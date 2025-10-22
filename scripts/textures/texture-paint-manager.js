import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { premiumEntitlementsService } from '../premium/premium-entitlements-service.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import './masked-tiles.js';
import { toolOptionsController } from '../core/tool-options-controller.js';

export class TexturePaintManager {
  constructor(app) {
    this._app = app;
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._delegateListenerBound = false;
    this._syncToolOptionsState();
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  async _ensureDelegate() {
    if (this._delegate) {
      this._bindDelegate(this._delegate);
      return this._delegate;
    }
    ensurePremiumFeaturesRegistered();
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const helper = await premiumFeatureBroker.resolve('texture.paint');
      let instance = null;
      if (helper?.create) instance = helper.create(this._app);
      else if (typeof helper === 'function') instance = new helper(this._app);
      if (!instance) throw new Error('Premium texture editor bundle missing TexturePaintManager implementation');
      this._delegate = instance;
      this._bindDelegate(instance);
      return instance;
    })();
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  }

  _bindDelegate(delegate) {
    if (!delegate || this._delegateListenerBound) return delegate;
    try {
      delegate.setToolOptionsListener?.((options = {}) => {
        const suppressRender = options && typeof options === 'object' && 'suppressRender' in options
          ? !!options.suppressRender
          : false;
        this._syncToolOptionsState({ suppressRender });
      });
      this._delegateListenerBound = true;
    } catch (_) {}
    return delegate;
  }

  async start(...args) {
    const delegate = await this._ensureDelegate();
    let result;
    try {
      result = delegate.start?.(...args);
      this._syncToolOptionsState({ suppressRender: false });
      toolOptionsController.activateTool('texture.paint', { label: 'Texture Painter' });
      this._beginToolWindowMonitor('texture.paint', delegate);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool('texture.paint');
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
      throw new Error('Installed texture painter bundle does not support editing existing tiles.');
    }
    let result;
    try {
      result = delegate.editTile(targetTile, options);
      this._syncToolOptionsState({ suppressRender: false });
      toolOptionsController.activateTool('texture.paint', { label: 'Texture Painter' });
      this._beginToolWindowMonitor('texture.paint', delegate);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool('texture.paint');
        });
      }
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  stop(...args) {
    this._cancelToolWindowMonitor();
    if (!this._delegate) {
      toolOptionsController.deactivateTool('texture.paint');
      return;
    }
    try {
      return this._delegate.stop?.(...args);
    } finally {
      toolOptionsController.deactivateTool('texture.paint');
    }
  }

  async save(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.save?.(...args);
  }

  async saveMask(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.saveMask?.(...args);
  }

  async placeMaskedTiling(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.placeMaskedTiling?.(...args);
  }

  _scheduleEntitlementProbe() {
    ensurePremiumFeaturesRegistered();
    if (this._entitlementProbe) return this._entitlementProbe;
    const probe = (async () => {
      try {
        await premiumFeatureBroker.require('texture.paint', { revalidate: true, reason: 'texture-paint:revalidate' });
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
    this._delegateListenerBound = false;
    const hasAuth = this._hasPremiumAuth();
    if (!hasAuth) {
      Logger.info?.('TexturePaintManager.entitlement.skipDisconnect', {
        code: error?.code || error?.name,
        message: String(error?.message || error)
      });
      return;
    }
    const message = '🔐 Authentication expired - premium texture painting has been disabled. Please reconnect Patreon.';
    if (this._isAuthFailure(error)) {
      try { premiumEntitlementsService?.clear?.({ reason: 'texture-revalidate-failed' }); }
      catch (_) {}
      try { game?.settings?.set?.('fa-nexus', 'patreon_auth_data', null); }
      catch (_) {}
      ui?.notifications?.warn?.(message);
    } else {
      const fallback = `Unable to confirm premium access: ${error?.message || error}`;
      ui?.notifications?.error?.(fallback);
    }
    try { Hooks?.callAll?.('fa-nexus-premium-auth-lost', { featureId: 'texture.paint', error }); }
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
    try {
      const delegateState = this._delegate?.buildToolOptionsState?.();
      if (delegateState && typeof delegateState === 'object') return delegateState;
    } catch (_) {}
    return {
      hints: [
        'LMB paint the texture;',
        'E to toggle erase mode.',
        'Ctrl/Cmd+Wheel adjusts brush size.',
        'Alt+Wheel changes tile elevation (Shift boosts).',
        'Press S to save the tile, ESC to exit.'
      ],
      texturePaint: { available: false },
      textureOffset: { available: false },
      rotation: { available: false },
      scale: { available: false },
      layerOpacity: { available: false }
    };
  }

  _syncToolOptionsState({ suppressRender = true } = {}) {
    try {
      const handlers = {
        setTextureMode: (modeId) => {
          const fn = this._delegate?.setTextureMode;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, modeId); }
          catch (_) { return false; }
        },
        handleTextureAction: (actionId) => {
          const fn = this._delegate?.handleTextureAction;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, actionId); }
          catch (_) { return false; }
        },
        setTextureOpacity: (value, commit) => {
          const fn = this._delegate?.setTextureOpacity;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setRotation: (value, commit) => {
          const fn = this._delegate?.setRotation || this._delegate?.setTextureRotation;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setScale: (value, commit) => {
          const fn = this._delegate?.setScale || this._delegate?.setTextureScale;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setTextureOffset: (axis, value, commit) => {
          const fn = this._delegate?.setTextureOffset;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, axis, value, commit); }
          catch (_) { return false; }
        },
        setLayerOpacity: (value, commit) => {
          const fn = this._delegate?.setLayerOpacity;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        }
      };
      toolOptionsController.setToolOptions('texture.paint', {
        state: this._buildToolOptionsState(),
        handlers,
        suppressRender
      });
    } catch (_) {}
  }
}

export default TexturePaintManager;
