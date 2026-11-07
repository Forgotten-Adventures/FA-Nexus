import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium-feature-broker.js';
import { ensurePremiumFeaturesRegistered } from '../premium-feature-registry.js';
import {
  attachPremiumSessionHost,
  validatePremiumRuntimeAdapter
} from './runtime-adapter-contract.js';

function stringifyError(error) {
  return String(error?.message || error);
}

export async function resolvePremiumFeatureDelegate({
  featureId,
  app = null,
  creationApp = undefined,
  host = null,
  assignDelegate = null,
  missingMessage = 'Premium feature bundle missing implementation',
  validateInstance = null,
  attachmentHost = undefined,
  exposedRuntimeCapabilities = null,
  loadedLogName = null,
  loadedHookName = null,
  afterAttach = null
} = {}) {
  let instance = null;
  try {
    ensurePremiumFeaturesRegistered();
    const helper = await premiumFeatureBroker.resolve(featureId);
    const runtimeAdapter = validatePremiumRuntimeAdapter({
      adapter: host?.premiumRuntimeAdapter,
      featureId,
      requiredCapabilities: helper?.requiredRuntimeAdapterCapabilities
    });
    const appArgument = creationApp === undefined ? app : creationApp;
    if (helper?.create) instance = helper.create(appArgument);
    else if (typeof helper === 'function') instance = new helper(appArgument);
    if (!instance) throw new Error(missingMessage);
    const version = String(instance?.version || '').trim();
    if (!version) {
      throw new Error(`Premium feature bundle ${featureId || 'unknown'} missing public instance version`);
    }
    if (typeof validateInstance === 'function') validateInstance(instance);
    attachPremiumSessionHost({
      delegate: instance,
      host: attachmentHost === undefined ? host : attachmentHost,
      adapter: runtimeAdapter,
      featureId,
      requiredCapabilities: helper?.requiredRuntimeAdapterCapabilities,
      exposedCapabilities: exposedRuntimeCapabilities,
      beforeAttach: () => assignDelegate?.(instance)
    });
  } catch (error) {
    try { assignDelegate?.(null); } catch (_) {}
    // No login or a tier without the tool is a refusal, not a fault.
    const refused = ['STATE_MISSING', 'PRO_TIER_REQUIRED', 'ENTITLEMENT_REQUIRED'].includes(String(error?.code || '').toUpperCase());
    Logger[refused ? 'warn' : 'error']?.('PremiumFeatureDelegate.attachHost.failed', {
      featureId,
      error: stringifyError(error)
    });
    throw error;
  }
  afterAttach?.(instance);

  const version = String(instance.version).trim();

  if (loadedLogName || loadedHookName) {
    try {
      if (loadedLogName) Logger.info?.(loadedLogName, { version });
      if (loadedHookName) globalThis?.Hooks?.callAll?.(loadedHookName, { version });
    } catch (logError) {
      if (loadedLogName) Logger.warn?.(`${loadedLogName}.logFailed`, stringifyError(logError));
    }
  }

  return instance;
}
