import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium-feature-broker.js';
import { premiumEntitlementsService } from '../premium-entitlements-service.js';
import { ensurePremiumFeaturesRegistered } from '../premium-feature-registry.js';
import { hasPremiumAuth, isPremiumAuthFailure } from './auth-state.js';

function stringifyError(error) {
  return String(error?.message || error);
}

export function scheduleEntitlementRevalidation(owner, {
  featureId,
  revalidateReason,
  onFailure = null
} = {}) {
  if (!owner || !featureId) return null;
  ensurePremiumFeaturesRegistered();
  if (owner._entitlementProbe) return owner._entitlementProbe;

  const probe = (async () => {
    try {
      await premiumFeatureBroker.require(featureId, { revalidate: true, reason: revalidateReason });
    } catch (error) {
      await onFailure?.(error);
    } finally {
      if (owner._entitlementProbe === probe) owner._entitlementProbe = null;
    }
  })();

  owner._entitlementProbe = probe;
  probe.catch(() => {});
  return probe;
}

export async function handleEntitlementRevalidationFailure({
  error,
  featureId,
  loggerPrefix = 'PremiumSessionHost',
  clearReason = 'premium-revalidate-failed',
  warningMessage = 'Authentication expired - premium editing has been disabled. Please reconnect Patreon.',
  stopSession = null,
  resetState = null
} = {}) {
  try {
    await Promise.resolve(stopSession?.());
  } catch (_) {}

  try {
    await Promise.resolve(resetState?.());
  } catch (_) {}

  if (!hasPremiumAuth()) {
    Logger.info?.(`${loggerPrefix}.entitlement.skipDisconnect`, {
      code: error?.code || error?.name,
      message: stringifyError(error)
    });
    return;
  }

  if (isPremiumAuthFailure(error)) {
    try { premiumEntitlementsService?.clear?.({ reason: clearReason }); } catch (_) {}
    try { game?.settings?.set?.('fa-nexus', 'patreon_auth_data', null); } catch (_) {}
    ui?.notifications?.warn?.(`🔐 ${warningMessage}`);
  } else {
    ui?.notifications?.error?.(`Unable to confirm premium access: ${stringifyError(error)}`);
  }

  try { Hooks?.callAll?.('fa-nexus-premium-auth-lost', { featureId, error }); } catch (_) {}
}
