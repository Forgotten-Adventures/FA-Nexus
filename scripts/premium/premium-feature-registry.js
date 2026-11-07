import { ACTIVE_PREMIUM_BUNDLES } from './active-premium-bundles.js';
import { premiumFeatureBroker } from './premium-feature-broker.js';

let registered = false;

function requireBundleFactory(mod, factoryName, bundleLabel) {
  const factory = mod?.[factoryName];
  if (typeof factory !== 'function') {
    throw new Error(`Premium ${bundleLabel} bundle missing ${factoryName} export`);
  }
  return factory;
}

function requireRuntimeAdapterCapabilities(mod, bundleLabel) {
  const capabilities = mod?.requiredPremiumRuntimeCapabilities;
  if (!Array.isArray(capabilities) || !capabilities.length) {
    throw new Error(`Premium ${bundleLabel} bundle missing requiredPremiumRuntimeCapabilities export`);
  }
  return Object.freeze(Array.from(new Set(
    capabilities.map((value) => String(value || '').trim()).filter(Boolean)
  )));
}

export function ensurePremiumFeaturesRegistered() {
  if (registered) return;
  for (const bundle of ACTIVE_PREMIUM_BUNDLES) {
    premiumFeatureBroker.registerFeature(bundle.featureId, {
      entitlementKey: bundle.entitlementKey,
      bundleId: bundle.bundleId,
      factory: (mod) => ({
        requiredRuntimeAdapterCapabilities: requireRuntimeAdapterCapabilities(mod, bundle.factoryLabel),
        create(app) {
          return requireBundleFactory(mod, bundle.factoryExport, bundle.factoryLabel)(app);
        }
      })
    });
  }

  registered = true;
}
