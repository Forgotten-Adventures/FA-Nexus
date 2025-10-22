import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumEntitlementsService } from './premium-entitlements-service.js';
import { premiumFeatureBroker } from './premium-feature-broker.js';
import { ensurePremiumFeaturesRegistered } from './premium-feature-registry.js';

/**
 * Patreon OAuth service for FA Nexus
 * Adapted from fa-token-browser with minimal changes and Nexus integration.
 */

export class PatreonOAuthApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  /**
   * OAuth popup window UI
   * @param {PatreonAuthService} patreonAuthService
   * @param {object} [options]
   */
  constructor(patreonAuthService, options = {}) {
    super(options);
    this.patreonAuthService = patreonAuthService;
    this.pollingInterval = null;
    this._startPollTimeout = null;
  }

  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-patreon-oauth',
    tag: 'div',
    window: { title: 'Patreon Authentication', icon: 'fas fa-user-shield', resizable: true },
    position: { width: 500, height: 450 },
    classes: ['patreon-oauth']
  };

  static PARTS = {
    form: { template: 'modules/fa-nexus/templates/oauth-window.hbs' }
  };

  async _onRender(initial, context) {
    await super._onRender(initial, context);
    const authButton = this.element.querySelector('#start-auth-btn');
    if (authButton) {
      authButton.addEventListener('click', (ev) => {
        ev.preventDefault();
        this.openExternalAuth();
      });
    }
  }

  /**
   * Open external Patreon auth URL and start polling for completion
   */
  openExternalAuth() {
    const authUrl = this.patreonAuthService.getAuthUrl();
    const state = this.patreonAuthService._pendingState;
    if (!state) { this.handleAuthComplete(null, 'No state token found'); return; }
    try { Logger.info('PatreonOAuth.open', { state }); } catch (_) {}
    window.open(authUrl, '_blank');
    const button = this.element.querySelector('#start-auth-btn');
    const status = this.element.querySelector('#auth-status');
    if (button) { button.disabled = true; button.textContent = 'Waiting for authentication...'; }
    if (status) { status.textContent = 'Please complete authentication in the new tab and return here.'; status.className = 'auth-status waiting'; }
    this.startPolling(state);
  }

  /**
   * Begin periodic polling of the auth-check endpoint
   * @param {string} state
   */
  startPolling(state) {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    try { Logger.info('PatreonOAuth.poll:start', { state }); } catch (_) {}
    const pollUrl = 'https://n8n.forgotten-adventures.net/webhook/foundry-authcheck-v2';
    const pollInterval = 3000;
    const maxPollAttempts = 20;
    const gracePeriodAttempts = 5;
    let pollAttempts = 0;
    this._startPollTimeout = setTimeout(() => {
      this.pollingInterval = setInterval(async () => {
        pollAttempts++;
        try {
          const response = await fetch(`${pollUrl}?state=${encodeURIComponent(state)}`, { method: 'GET', headers: { 'Accept': 'application/json' } });
          if (!response.ok) {
            if (response.status === 400) {
              if (pollAttempts <= gracePeriodAttempts) {
                try {
                  const err = await response.json();
                  const msg = (err.message || err.error || '').toString().toLowerCase();
                  if (msg.includes('invalid state')) {
                    if (pollAttempts >= maxPollAttempts) { this.stopPolling(); this.handleAuthComplete(null, 'Authentication timeout - please try again'); }
                    return;
                  }
                } catch (_) { /* ignore */ }
              }
              this.stopPolling();
              try { const err = await response.json(); this.handleAuthComplete(null, err.message || err.error || 'Authentication failed - invalid request'); }
              catch (_) { this.handleAuthComplete(null, 'Authentication failed - invalid request'); }
              return;
            }
            if (response.status === 401) {
              this.stopPolling();
              try { const err = await response.json(); this.handleAuthComplete(null, err.message || err.error || 'Authentication failed - insufficient access level'); }
              catch (_) { this.handleAuthComplete(null, 'Authentication failed - insufficient access level'); }
              return;
            }
            if (response.status === 404) {
              if (pollAttempts >= maxPollAttempts) { this.stopPolling(); this.handleAuthComplete(null, 'Authentication timeout - please try again'); }
              return;
            }
            this.stopPolling();
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          const data = await response.json();
          this.stopPolling();
          if (data.success === 'true' || data.success === true) this.handleAuthComplete(data);
          else this.handleAuthComplete(null, data.error || 'Authentication failed');
        } catch (error) {
          Logger.error('PatreonOAuthApp.poll:error', error);
          if (pollAttempts >= maxPollAttempts) { this.stopPolling(); this.handleAuthComplete(null, `Authentication failed: ${error.message}`); }
        }
      }, pollInterval);
    }, 3000);
  }

  /** Stop polling if active */
  stopPolling() {
    if (this._startPollTimeout) { try { clearTimeout(this._startPollTimeout); } catch (_) {} this._startPollTimeout = null; }
    if (this.pollingInterval) { clearInterval(this.pollingInterval); this.pollingInterval = null; }
  }

  /**
   * Handle completion of the auth flow and update UI
   * @param {object|null} authData
   * @param {string|null} errorMessage
   */
  async handleAuthComplete(authData = null, errorMessage = null) {
    const button = this.element.querySelector('#start-auth-btn');
    const status = this.element.querySelector('#auth-status');
    if (button) { button.disabled = false; button.textContent = '🔐 Start Authentication'; }
    if (errorMessage) {
      Logger.error('PatreonOAuthApp.auth:failed', errorMessage);
      if (status) { status.textContent = `❌ Error: ${errorMessage}`; status.className = 'auth-status error'; }
      ui.notifications.error(`❌ Authentication failed: ${errorMessage}`);
    } else {
      try {
        const result = await this.patreonAuthService.handleAuthResult(authData);
        if (status) { status.textContent = `✅ Authenticated as ${result.tier} supporter!`; status.className = 'auth-status success'; }
        ui.notifications.info(`🎉 Authenticated as ${result.tier} supporter!`);
        setTimeout(() => this.close(), 1500);
      } catch (e) {
        this.handleAuthComplete(null, e.message);
      }
    }
  }

  async close(options = {}) {
    this.stopPolling();
    if (this.patreonAuthService._activeOAuthWindow === this) this.patreonAuthService._activeOAuthWindow = null;
    return super.close(options);
  }
}

export class PatreonAuthService {
  /** Construct the service */
  constructor() {
    this.config = {
      clientId: 'm5zOd0zkfYoQz9J8JuXTzN728poxUcYiShCBTVymi3D4AVawLvz_RjeugeLF2wY-',
      redirectUri: 'https://n8n.forgotten-adventures.net/webhook/patreonconnection-foundry',
      scopes: 'identity%20identity%5Bemail%5D%20identity.memberships',
      authUrl: 'https://www.patreon.com/oauth2/authorize'
    };
    this._activeOAuthWindow = null;
    this._activePollingInterval = null;
    this._activePollingTimeout = null;
  }

  /**
   * Generate a random state token for OAuth
   * @returns {string}
   */
  static generateStateUUID() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); }
    catch (e) { console.warn('fa-nexus | crypto.randomUUID failed, fallback', e); }
    if (typeof foundry !== 'undefined' && foundry.utils?.randomID) return foundry.utils.randomID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 0x3 | 0x8); return v.toString(16);
    });
  }

  /**
   * Compose the Patreon auth URL and store the pending state
   * @returns {string}
   */
  getAuthUrl() {
    const state = PatreonAuthService.generateStateUUID();
    this._pendingState = state;
    return `${this.config.authUrl}?response_type=code&client_id=${this.config.clientId}&redirect_uri=${encodeURIComponent(this.config.redirectUri)}&scope=${this.config.scopes}&state=${encodeURIComponent(state)}`;
  }

  /**
   * Persist successful auth data to game settings
   * @param {object} authData
   * @returns {Promise<object>}
   */
  async handleAuthResult(authData) {
    try {
      const authResult = {
        authenticated: true,
        tier: authData.tier || 'unknown',
        source: authData.source || 'patreon:main',
        timestamp: Date.now(),
        state: this._pendingState
      };
      await game.settings.set('fa-nexus', 'patreon_auth_data', authResult);
      try { await game.settings.set('fa-nexus', 'hideLocked', false); } catch (_) {}
      delete this._pendingState;
      Logger.info('PatreonAuth.success', authResult);
      return authResult;
    } catch (error) {
      Logger.error('PatreonAuth.failed', error);
      try { await game.settings.set('fa-nexus', 'patreon_auth_data', null); } catch (_) {}
      delete this._pendingState;
      throw error;
    }
  }

  /** Re-render a given Application while preserving its position */
  async updateAuthUI(app) {
    try {
      // Preserve current window position across re-render
      const p = app?.position ? { left: app.position.left, top: app.position.top, width: app.position.width, height: app.position.height } : null;
      if (p) { try { await game.settings.set('fa-nexus', 'windowPos', p); } catch (_) {} }
      await app.render();
      if (p) { try { app.setPosition(p); } catch (_) {} }
    } catch (e) {
      Logger.error('PatreonAuth.refreshUI:failed', e);
    }
  }

  /** Clean up any active OAuth UI and timers */
  _cleanupActiveAuth(app) {
    if (this._activeOAuthWindow?.rendered) {
      try { this._activeOAuthWindow.close(); } catch (e) { console.warn('fa-nexus | Failed to close OAuth window', e); }
    }
    this._activeOAuthWindow = null;
    const ev = app?._events;
    if (this._activePollingInterval) { if (ev) ev.clearInterval(this._activePollingInterval); else clearInterval(this._activePollingInterval); this._activePollingInterval = null; }
    if (this._activePollingTimeout) { if (ev) ev.clearTimeout(this._activePollingTimeout); else clearTimeout(this._activePollingTimeout); this._activePollingTimeout = null; }
  }

  /**
   * Start the Patreon OAuth flow with an embedded window and polling hooks
   * @param {ApplicationV2} app
   */
  async handlePatreonConnect(app) {
    try {
      this._cleanupActiveAuth(app);
      const oauthApp = new PatreonOAuthApp(this);
      this._activeOAuthWindow = oauthApp;
      oauthApp.render(true);
      Logger.info('PatreonAuth.connect:opened');
      const ev = app?._events;
      const setInt = (fn, ms) => ev ? ev.setInterval(fn, ms) : setInterval(fn, ms);
      const setTo = (fn, ms) => ev ? ev.setTimeout(fn, ms) : setTimeout(fn, ms);
      this._activePollingInterval = setInt(async () => {
        const authData = game.settings.get('fa-nexus', 'patreon_auth_data');
        if (authData && authData.authenticated) {
          await this.updateAuthUI(app);
          await this.refreshAfterAuth(app, authData);
          this._cleanupActiveAuth(app);
        }
      }, 1000);
      this._activePollingTimeout = setTo(() => { this._cleanupActiveAuth(app); }, 300000);
    } catch (error) {
      Logger.error('PatreonAuth.connect:failed', error);
      ui.notifications.error(`Failed to open authentication: ${error.message}`);
      this._cleanupActiveAuth(app);
    }
  }

  /**
   * App-specific post-auth refresh hook (placeholder for now)
   */
  async refreshAfterAuth(app, authData) {
    try {
      if (authData && authData.authenticated) ui.notifications.info('✅ Patreon connected');
      else ui.notifications.info('ℹ️ Disconnected from Patreon');
      await warmPremiumFeatureBundles({ reason: authData && authData.authenticated ? 'auth-success' : 'auth-disconnect' });
    } catch (e) { Logger.error('PatreonAuth.refresh:error', e); }
  }

  /**
   * Clear stored Patreon auth data (optionally after a confirmation)
   */
  async handlePatreonDisconnect(app, showConfirmation = false) {
    try {
      if (showConfirmation) {
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: 'Disconnect Patreon' },
          content: '<p>Disconnect your Patreon account?</p><p>You will lose access to premium content until you reconnect.</p>',
          modal: true,
          rejectClose: false,
          yes: { icon: 'fas fa-sign-out-alt', label: 'Disconnect' },
          no: { icon: 'fas fa-times', label: 'Cancel' }
        });
        if (!confirmed) return;
      }
      await game.settings.set('fa-nexus', 'patreon_auth_data', null);
      try { premiumEntitlementsService?.clear?.({ reason: 'disconnect' }); }
      catch (clearError) { Logger.warn('PatreonAuth.disconnect.clearEntitlements', clearError); }
      await this.updateAuthUI(app);
      await this.refreshAfterAuth(app, null);
      Logger.info('PatreonAuth.disconnect:done');
    } catch (error) {
      Logger.error('PatreonAuth.disconnect:failed', error);
      ui.notifications.error(`Failed to disconnect: ${error.message}`);
    }
  }
}

export async function warmPremiumFeatureBundles({ reason = 'auth', features } = {}) {
  try {
    const authData = game?.settings?.get?.('fa-nexus', 'patreon_auth_data');
    const hasAuth = !!(authData && authData.authenticated && authData.state);
    if (!hasAuth) return false;
  } catch (_) {
    return false;
  }

  ensurePremiumFeaturesRegistered();

  try {
    await premiumFeatureBroker.refresh({ force: true, reason: `warm:${reason}` });
  } catch (error) {
    Logger.warn('PatreonAuth.warmPremium.refresh.failed', { reason, error: String(error?.message || error) });
    return false;
  }

  const list = Array.isArray(features) && features.length ? features : ['texture.paint', 'path.edit'];

  for (const featureId of list) {
    if (!premiumFeatureBroker.can(featureId)) continue;
    try {
      await premiumFeatureBroker.preload(featureId, {
        skipRequire: true,
        reason: `warm:${reason}:${featureId}`
      });
    } catch (error) {
      Logger.warn('PatreonAuth.warmPremium.preload.failed', {
        featureId,
        reason,
        error: String(error?.message || error)
      });
    }
  }

  return true;
}
