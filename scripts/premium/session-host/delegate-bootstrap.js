import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium-feature-broker.js';
import { ensurePremiumFeaturesRegistered } from '../premium-feature-registry.js';

function stringifyError(error) {
  return String(error?.message || error);
}

export async function resolvePremiumFeatureDelegate({
  featureId,
  app = null,
  host = null,
  assignDelegate = null,
  missingMessage = 'Premium feature bundle missing implementation',
  loadedLogName = null,
  loadedHookName = null,
  fallbackVersion = '0.0.0',
  afterAttach = null
} = {}) {
  ensurePremiumFeaturesRegistered();
  const helper = await premiumFeatureBroker.resolve(featureId);
  let instance = null;
  if (helper?.create) instance = helper.create(app);
  else if (typeof helper === 'function') instance = new helper(app);
  if (!instance) throw new Error(missingMessage);

  assignDelegate?.(instance);
  try { instance.attachHost?.(host); } catch (_) {}
  afterAttach?.(instance);

  if (loadedLogName || loadedHookName) {
    const version = instance?.version || fallbackVersion;
    try {
      if (loadedLogName) Logger.info?.(loadedLogName, { version });
      if (loadedHookName) globalThis?.Hooks?.callAll?.(loadedHookName, { version });
    } catch (logError) {
      if (loadedLogName) Logger.warn?.(`${loadedLogName}.logFailed`, stringifyError(logError));
    }
  }

  return instance;
}
