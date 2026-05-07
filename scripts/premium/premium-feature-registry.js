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

  premiumFeatureBroker.registerFeature('path.edit.v2', {
    entitlementKey: 'path.edit',
    bundleId: 'path-editor-v2',
    factory: (mod) => ({
      create(app) {
        if (typeof mod?.createPathManagerV2 === 'function') return mod.createPathManagerV2(app);
        const Klass = mod?.PathManagerV2 || mod?.default;
        if (typeof Klass !== 'function') throw new Error('Premium path v2 bundle missing PathManagerV2 export');
        return new Klass(app);
      }
    })
  });

  premiumFeatureBroker.registerFeature('building.edit', {
    entitlementKey: 'building.edit',
    bundleId: 'building-editor',
    factory: (mod) => ({
      create(app) {
        if (typeof mod?.createBuildingManager === 'function') return mod.createBuildingManager(app);
        const Klass = mod?.BuildingManager || mod?.default;
        if (typeof Klass !== 'function') throw new Error('Premium building bundle missing BuildingManager export');
        return new Klass(app);
      }
    })
  });

  registered = true;
}
