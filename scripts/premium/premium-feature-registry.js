import { premiumFeatureBroker } from './premium-feature-broker.js';

let registered = false;

export function ensurePremiumFeaturesRegistered() {
  if (registered) return;

  premiumFeatureBroker.registerFeature('texture.paint', {
    entitlementKey: 'texture.edit',
    bundleId: 'texture-editor',
    factory: (mod) => ({
      create(app) {
        if (typeof mod?.createTexturePaintManager === 'function') return mod.createTexturePaintManager(app);
        const Klass = mod?.TexturePaintManager || mod?.default;
        if (typeof Klass !== 'function') throw new Error('Premium texture bundle missing TexturePaintManager export');
        return new Klass(app);
      }
    })
  });

  premiumFeatureBroker.registerFeature('path.edit', {
    entitlementKey: 'path.edit',
    bundleId: 'path-editor',
    factory: (mod) => ({
      create(app) {
        if (typeof mod?.createPathManager === 'function') return mod.createPathManager(app);
        const Klass = mod?.PathManager || mod?.default;
        if (typeof Klass !== 'function') throw new Error('Premium path bundle missing PathManager export');
        return new Klass(app);
      }
    })
  });

  registered = true;
}
