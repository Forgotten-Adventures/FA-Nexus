import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium-feature-broker.js';
import { premiumEntitlementsService } from '../premium-entitlements-service.js';
import { ensurePremiumFeaturesRegistered } from '../premium-feature-registry.js';
import { hasPremiumAuth, isPremiumAuthFailure, isProTierRefusal } from './auth-state.js';

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
  probe.catch((error) => {
    Logger.error?.('PremiumSessionHost.entitlement.revalidationFailed', {
      featureId,
      reason: revalidateReason,
      error: stringifyError(error)
    });
  });
  return probe;
}

export async function handleEntitlementRevalidationFailure({
  error,
  featureId,
  loggerPrefix = 'PremiumSessionHost',
  clearReason = 'premium-revalidate-failed',
  editorLabel = 'Pro editor',
  warningMessage = `Authentication expired. Your current ${editorLabel} remains open; reconnect Patreon before starting another Pro tool.`
} = {}) {
  if (!hasPremiumAuth()) {
    Logger.info?.(`${loggerPrefix}.entitlement.skipDisconnect`, {
      code: error?.code || error?.name,
      message: stringifyError(error)
    });
    return;
  }

  if (isPremiumAuthFailure(error)) {
    await Promise.resolve(premiumEntitlementsService.clear({ reason: clearReason }));
    await Promise.resolve(game?.settings?.set?.('fa-nexus', 'patreon_auth_data', null));
    ui?.notifications?.warn?.(`🔐 ${warningMessage}`);
    Hooks?.callAll?.('fa-nexus-premium-auth-lost', { featureId, error });
    return;
  }
  // A member whose tier no longer includes the Pro tools stays signed in: Premium content still works. The failed
  // refresh already emptied the entitlements, so the next Pro tool start is refused.
  if (isProTierRefusal(error)) {
    Logger.info?.(`${loggerPrefix}.entitlement.proTierRefused`, { featureId, code: error?.code || error?.name });
    ui?.notifications?.warn?.(`Your Patreon tier no longer includes the Pro tools. Your current ${editorLabel} remains open; the Pro tier is needed to start another.`);
    return;
  }
  ui?.notifications?.error?.(`Unable to confirm Pro tool access: ${stringifyError(error)}`);
}
