import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumEntitlementsService } from './premium-entitlements-service.js';
import { premiumFeatureBroker } from './premium-feature-broker.js';
import { ensurePremiumFeaturesRegistered } from './premium-feature-registry.js';
import { renderPatreonAuthHeader } from './patreon-auth-header.js';
import { shouldWarmPremiumWithoutAuth } from './premium-runtime-config.js';
import {
  MAIN_PATREON_SOURCE_ID,
  PATREON_AUTH_CHECK_URL,
  PatreonAuthContractError,
  findAccessSource,
  normalizeFoundryAuthCheckResponse
} from './patreon-auth-contract.js';
import {
  PATREON_AUTH_ACCESS_GRACE_ATTEMPTS,
  PATREON_AUTH_MAX_POLL_ATTEMPTS,
  PATREON_AUTH_POLL_INTERVAL_MS,
  PATREON_AUTH_POLL_START_DELAY_MS,
  buildPatreonPollingProgress,
  classifyPatreonPollingFailure
} from './patreon-auth-polling-policy.js';

export function sanitizePatreonStateForLog(state) {
  const stateText = typeof state === 'string' ? state : '';
  return {
    statePresent: stateText.length > 0,
    stateLength: stateText.length
  };
}

export function sanitizePatreonAuthResultForLog(authResult) {
  const data = authResult && typeof authResult === 'object' ? authResult : {};
  const accessSources = Array.isArray(data.accessSources) ? data.accessSources : [];
  return {
    authenticated: data.authenticated === true,
    schemaVersion: Number.isInteger(data.schemaVersion) ? data.schemaVersion : null,
    accessSourceCount: accessSources.length,
    mainPatreonSourcePresent: Boolean(findAccessSource(data, MAIN_PATREON_SOURCE_ID)),
    timestamp: Number.isFinite(data.timestamp) ? data.timestamp : null,
    ...sanitizePatreonStateForLog(data.state)
  };
}

export function sanitizePatreonAuthErrorForLog(error) {
  const data = error && typeof error === 'object' ? error : {};
  return {
    hasMessage: typeof data.message === 'string' && data.message.length > 0,
    hasError: typeof data.error === 'string' && data.error.length > 0,
    hasCode: typeof data.code === 'string' && data.code.length > 0,
    hasErrorCode: typeof data.errorCode === 'string' && data.errorCode.length > 0,
    hasStatus: data.status != null
  };
}

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
    window: { title: 'FA Nexus Access', icon: 'fas fa-user-shield', resizable: true },
    position: { width: 500, height: 450 },
    classes: ['patreon-oauth']
  };

  static PARTS = {
    form: { template: 'modules/fa-nexus/templates/premium/oauth-window.hbs' }
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
    try { Logger.info('PatreonOAuth.open', sanitizePatreonStateForLog(state)); } catch (_) {}
    window.open(authUrl, '_blank');
    const button = this.element.querySelector('#start-auth-btn');
    const status = this.element.querySelector('#auth-status');
    if (button) { button.disabled = true; button.textContent = 'Waiting for Patreon…'; }
    if (status) {
      status.textContent = 'Complete authorization in your browser. Status checks will begin shortly.';
      status.className = 'auth-status waiting';
    }
    this.startPolling(state);
  }

  /**
   * Begin periodic polling of the auth-check endpoint
   * @param {string} state
   */
  startPolling(state) {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    try { Logger.info('PatreonOAuth.poll:start', sanitizePatreonStateForLog(state)); } catch (_) {}
    let pollAttempts = 0;
    let pollInFlight = false;
    let pollComplete = false;
    const completePolling = async (authData = null, errorMessage = null) => {
      if (pollComplete) return;
      pollComplete = true;
      this.stopPolling();
      await this.handleAuthComplete(authData, errorMessage);
    };
    const poll = async () => {
      if (pollInFlight || pollComplete) return;
      pollInFlight = true;
      pollAttempts++;
      const progress = buildPatreonPollingProgress(pollAttempts);
      const status = this.element?.querySelector?.('#auth-status');
      if (status) {
        status.textContent = progress.statusText;
        status.className = 'auth-status waiting';
      }
      try {
        const response = await fetch(`${PATREON_AUTH_CHECK_URL}?state=${encodeURIComponent(state)}`, { method: 'GET', headers: { 'Accept': 'application/json' } });
        if (!response.ok) {
          let errorPayload = null;
          try { errorPayload = await response.json(); } catch (_) { errorPayload = null; }
          const failure = classifyPatreonPollingFailure({
            httpStatus: response.status,
            errorPayload,
            pollAttempt: pollAttempts,
            maxPollAttempts: PATREON_AUTH_MAX_POLL_ATTEMPTS,
            accessGraceAttempts: PATREON_AUTH_ACCESS_GRACE_ATTEMPTS
          });
          if (!failure.terminal) {
            try {
              Logger.info('PatreonOAuth.poll:retry', {
                ...sanitizePatreonStateForLog(state),
                pollAttempts,
                maxPollAttempts: PATREON_AUTH_MAX_POLL_ATTEMPTS,
                status: response.status,
                error: sanitizePatreonAuthErrorForLog(errorPayload)
              });
            } catch (_) {}
            return;
          }
          Logger.error('PatreonOAuthApp.poll:httpError', {
            status: response.status,
            pollAttempts,
            error: sanitizePatreonAuthErrorForLog(errorPayload)
          });
          await completePolling(null, failure.message);
          return;
        }
        const data = await response.json();
        const normalized = normalizeFoundryAuthCheckResponse(data, { expectedState: state });
        await completePolling(normalized);
      } catch (error) {
        Logger.error('PatreonOAuthApp.poll:error', error);
        if (error instanceof PatreonAuthContractError) {
          await completePolling(null, error.message);
        } else if (pollAttempts >= PATREON_AUTH_MAX_POLL_ATTEMPTS) {
          await completePolling(null, 'Patreon authentication could not be checked. Check your connection and try again.');
        }
      } finally {
        pollInFlight = false;
      }
    };
    this._startPollTimeout = setTimeout(() => {
      poll();
      this.pollingInterval = setInterval(poll, PATREON_AUTH_POLL_INTERVAL_MS);
    }, PATREON_AUTH_POLL_START_DELAY_MS);
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
    if (button) { button.disabled = false; button.textContent = 'Continue to Patreon'; }
    if (errorMessage) {
      Logger.error('PatreonOAuthApp.auth:failed', errorMessage);
      if (status) { status.textContent = errorMessage; status.className = 'auth-status error'; }
      ui.notifications.error(errorMessage);
    } else {
      try {
        await this.patreonAuthService.handleAuthResult(authData);
        if (status) { status.textContent = 'Patreon connected.'; status.className = 'auth-status success'; }
        setTimeout(() => this.close(), 1500);
      } catch (e) {
        await this.handleAuthComplete(null, e.message);
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
      if (
        !authData?.linked
        || !Array.isArray(authData.accessSources)
        || !this._pendingState
        || authData.state !== this._pendingState
      ) {
        throw new Error('The authentication response did not match this request.');
      }
      const authResult = {
        authenticated: true,
        schemaVersion: authData.schemaVersion,
        checkedAt: authData.checkedAt,
        linked: true,
        accessSources: authData.accessSources,
        timestamp: Date.now(),
        state: authData.state
      };
      await game.settings.set('fa-nexus', 'patreon_auth_data', authResult);
      try { await game.settings.set('fa-nexus', 'hideLocked', false); } catch (_) {}
      delete this._pendingState;
      Logger.info('PatreonAuth.success', sanitizePatreonAuthResultForLog(authResult));
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
      if (!app) return;
      if (!app.rendered) {
        await app.render(true);
        return;
      }
      try {
        renderPatreonAuthHeader({
          app,
          getAuthService: () => app._getAuthService?.() ?? this
        });
        app._setPatreonHeaderVisibility?.(!app.minimized);
      } catch (_) {}
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
          this._cleanupActiveAuth(app);
          await this.refreshAfterAuth(app, authData);
        }
      }, 1000);
      this._activePollingTimeout = setTo(() => { this._cleanupActiveAuth(app); }, 300000);
    } catch (error) {
      Logger.error('PatreonAuth.connect:failed', error);
      ui.notifications.error(`Failed to open authentication: ${error.message}`);
      this._cleanupActiveAuth(app);
    }
  }

  async refreshAfterAuth(app, authData) {
    const connected = !!(authData && authData.authenticated);
    try {
      await warmPremiumFeatureBundles({ reason: connected ? 'auth-success' : 'auth-disconnect' });
    } catch (e) {
      Logger.error('PatreonAuth.refresh:error', e);
    }
    await this.updateAuthUI(app);
    try {
      if (app?.rendered) {
        if (typeof app.refreshActiveGridAfterAuthenticationChange !== 'function') {
          throw new Error('Nexus does not expose an authentication grid refresh operation.');
        }
        await app.refreshActiveGridAfterAuthenticationChange();
      }
    } catch (error) {
      Logger.error('PatreonAuth.refreshGrid:failed', {
        connected,
        error: String(error?.message || error)
      });
      ui.notifications.error(`Patreon ${connected ? 'connected' : 'disconnected'}, but the active Nexus grid could not refresh. Reopen Nexus and try again.`);
      return false;
    }
    ui.notifications.info(connected ? 'Patreon connected.' : 'Disconnected from Patreon.');
    return true;
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
      await this.refreshAfterAuth(app, null);
      Logger.info('PatreonAuth.disconnect:done');
    } catch (error) {
      Logger.error('PatreonAuth.disconnect:failed', error);
      ui.notifications.error(`Failed to disconnect: ${error.message}`);
    }
  }
}

export async function warmPremiumFeatureBundles({ reason = 'auth', features } = {}) {
  const devBridgeEnabled = await shouldWarmPremiumWithoutAuth();
  if (!devBridgeEnabled) {
    try {
      const authData = game?.settings?.get?.('fa-nexus', 'patreon_auth_data');
      const hasAuth = !!(authData && authData.authenticated && authData.state);
      if (!hasAuth) return false;
    } catch (_) {
      return false;
    }
  }

  ensurePremiumFeaturesRegistered();

  try {
    await premiumFeatureBroker.refresh({ force: true, reason: `warm:${reason}` });
  } catch (error) {
    Logger.warn('PatreonAuth.warmPremium.refresh.failed', { reason, error: String(error?.message || error) });
    return false;
  }

  const list = Array.isArray(features) && features.length
    ? features
    : ['texture.paint', 'path.edit.v2', 'building.edit'];

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
