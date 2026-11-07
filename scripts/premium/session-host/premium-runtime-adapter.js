import { getAssetShadowManager } from '../../assets/asset-shadow-manager.js';
import { toolOptionsController } from '../../core/tool-options/tool-options-controller.js';
import { forgeIntegration } from '../../storage/forge-integration.js';
import * as sharedTextureCache from '../../core/foundry-texture-cache.js';
import * as layerManagerPreview from '../../layers/layer-manager-preview-placement-bridge.js';
import * as maskedTextures from '../../textures/texture-mask-runtime.js';
import * as standardMaskCustomBase from '../../textures/standard-mask-custom-base.js';
import { getBuildingV2RuntimeCapabilities } from '../../buildings/v2/building-v2-runtime-capabilities.js';
import { createCanonicalPremiumRuntimeAdapter } from './runtime-adapter-factory.js';

let canonicalApp = null;
let canonicalAdapter = null;

async function loadBuildingPortalPickerDeps() {
  const [assetsModule, cardModule, gridModule] = await Promise.all([
    import('../../assets/assets-tab.js'),
    import('../../assets/assets-card-helper.js'),
    import('../../core/ui/virtual-grid-manager.js')
  ]);
  const missing = [
    typeof assetsModule.AssetsTab !== 'function' ? 'AssetsTab' : null,
    typeof cardModule.AssetsTabCardHelper !== 'function' ? 'AssetsTabCardHelper' : null,
    typeof gridModule.VirtualGridManager !== 'function' ? 'VirtualGridManager' : null
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Building portal picker Runtime dependencies are incomplete: ${missing.join(', ')}`);
  }
  return Object.freeze({
    AssetsTab: assetsModule.AssetsTab,
    AssetsTabCardHelper: cardModule.AssetsTabCardHelper,
    VirtualGridManager: gridModule.VirtualGridManager
  });
}

export function getPremiumRuntimeAdapter(app = null) {
  if (app) canonicalApp = app;
  if (!canonicalAdapter) {
    canonicalAdapter = createCanonicalPremiumRuntimeAdapter({
      getApp: () => canonicalApp,
      toolOptionsController,
      getAssetShadowManager,
      maskedTextures,
      standardMaskCustomBase,
      sharedTextureCache,
      forgeIntegration,
      layerManagerPreview,
      getBuildingV2RuntimeCapabilities,
      loadBuildingPortalPickerDeps
    });
  }
  return canonicalAdapter;
}
