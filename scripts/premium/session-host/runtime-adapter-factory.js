import { createPremiumRuntimeAdapter } from './runtime-adapter-contract.js';

export const PREMIUM_RUNTIME_CAPABILITY = Object.freeze({
  TOOL_OPTIONS_GET_GRID_SNAP_STATE: 'toolOptions.getGridSnapState',
  TOOL_OPTIONS_SET_GRID_SNAP_ENABLED: 'toolOptions.setGridSnapEnabled',
  TOOL_OPTIONS_SET_GRID_SNAP_SUBDIVISIONS: 'toolOptions.setGridSnapSubdivisions',
  TOOL_OPTIONS_TOGGLE_GRID_SNAP: 'toolOptions.toggleGridSnap',
  TOOL_OPTIONS_NUDGE_GRID_SNAP_SUBDIVISIONS: 'toolOptions.nudgeGridSnapSubdivisions',
  TOOL_OPTIONS_OPEN_ACTIVE_HELP: 'toolOptions.openActiveHelp',
  ASSET_SHADOWS_GET_ELEVATION_SETTINGS: 'assetShadows.getElevationSettings',
  ASSET_SHADOWS_APPLY_ELEVATION_SETTINGS: 'assetShadows.applyElevationSettings',
  ASSET_SHADOWS_SUSPEND_TILE: 'assetShadows.suspendTile',
  ASSET_SHADOWS_RESUME_TILE: 'assetShadows.resumeTile',
  ASSET_SHADOWS_REFRESH_ALL: 'assetShadows.refreshAll',
  ASSET_SHADOWS_WAIT_FOR_REBUILDS: 'assetShadows.waitForRebuilds',
  ASSET_SHADOWS_RESOLVE_STANDARD_MASK_PREVIEW: 'assetShadows.resolveStandardMaskPreviewConfig',
  ASSET_SHADOWS_COMPUTE_STANDARD_MASK_BLUR_QUALITY: 'assetShadows.computeStandardMaskPreviewBlurQuality',
  ASSET_SHADOWS_RENDER_STANDARD_MASK_PREVIEW: 'assetShadows.renderStandardMaskPreviewComposite',
  MASKED_TEXTURES_APPLY_MASKED_TILING: 'maskedTextures.applyMaskedTiling',
  MASKED_TEXTURES_APPLY_STANDARD_TILE_MASK: 'maskedTextures.applyStandardTileMask',
  MASKED_TEXTURES_CLEAR_STANDARD_TILE_MASK: 'maskedTextures.clearStandardTileMask',
  MASKED_TEXTURES_SCHEDULE_RETRY: 'maskedTextures.scheduleRetry',
  MASKED_TEXTURES_CLEAR_RETRY: 'maskedTextures.clearRetry',
  MASKED_TEXTURES_REHYDRATE_ALL: 'maskedTextures.rehydrateAll',
  MASKED_TEXTURES_CANCEL_GLOBAL_REHYDRATE: 'maskedTextures.cancelGlobalRehydrate',
  MASKED_TEXTURES_CANCEL_TILE_APPLIES: 'maskedTextures.cancelTileApplies',
  STANDARD_MASK_CUSTOM_BASE_CREATE_DISPLAY: 'standardMaskCustomBase.createDisplay',
  STANDARD_MASK_CUSTOM_BASE_GET_KEY: 'standardMaskCustomBase.getKey',
  STANDARD_MASK_CUSTOM_BASE_HAS_SOURCE: 'standardMaskCustomBase.hasSource',
  SHARED_TEXTURE_CACHE_GET: 'sharedTextureCache.get',
  SHARED_TEXTURE_CACHE_LOAD: 'sharedTextureCache.load',
  SHARED_TEXTURE_CACHE_RECOVER: 'sharedTextureCache.recover',
  FORGE_FILES_INITIALIZE: 'forgeFiles.initialize',
  FORGE_FILES_RESOLVE_PICKER_CONTEXT: 'forgeFiles.resolveFilePickerContext',
  FORGE_FILES_OPTIMIZE_CACHE_URL: 'forgeFiles.optimizeCacheUrl',
  LAYER_MANAGER_COLLECT_PREVIEW_ENTRIES: 'layerManager.collectPreviewEntries',
  LAYER_MANAGER_GET_PREVIEW_ENTRY_BY_ID: 'layerManager.getPreviewEntryById',
  LAYER_MANAGER_ROUTE_PREVIEW_WHEEL_ADJUSTMENT: 'layerManager.routePreviewWheelAdjustment',
  LAYER_MANAGER_RESOLVE_PREVIEW_SORT_NUDGE: 'layerManager.resolvePreviewSortNudge',
  LAYER_MANAGER_CAPTURE_PREVIEW_ANCHORS_FOR_TILE_DROP: 'layerManager.capturePreviewAnchorsForTileDrop',
  LAYER_MANAGER_APPLY_PREVIEW_ANCHORS_AFTER_TILE_DROP: 'layerManager.applyPreviewAnchorsAfterTileDrop',
  LAYER_MANAGER_APPLY_PREVIEW_DROP_REORDER: 'layerManager.applyPreviewDropReorder',
  BUILDING_V2_GET_RUNTIME_CAPABILITIES: 'buildingV2.getRuntimeCapabilities',
  BUILDING_PORTAL_PICKER_GET_DEPS: 'buildingPortalPicker.getDeps'
});

function bindRequired(owner, methodName, label) {
  const method = owner?.[methodName];
  if (typeof method !== 'function') {
    throw new Error(`Premium Runtime Adapter requires ${label || methodName}().`);
  }
  return method.bind(owner);
}

export function createCanonicalPremiumRuntimeAdapter({
  getApp = () => null,
  toolOptionsController,
  getAssetShadowManager,
  maskedTextures,
  standardMaskCustomBase,
  sharedTextureCache,
  forgeIntegration,
  layerManagerPreview,
  getBuildingV2RuntimeCapabilities,
  loadBuildingPortalPickerDeps
} = {}) {
  if (typeof getAssetShadowManager !== 'function') {
    throw new Error('Premium Runtime Adapter requires getAssetShadowManager().');
  }
  if (typeof loadBuildingPortalPickerDeps !== 'function') {
    throw new Error('Premium Runtime Adapter requires loadBuildingPortalPickerDeps().');
  }
  if (typeof getBuildingV2RuntimeCapabilities !== 'function') {
    throw new Error('Premium Runtime Adapter requires getBuildingV2RuntimeCapabilities().');
  }
  const isGridSnapEnabled = bindRequired(toolOptionsController, 'isGridSnapEnabled', 'Tool Options isGridSnapEnabled');
  const getGridSnapSubdivisions = bindRequired(toolOptionsController, 'getGridSnapSubdivisions', 'Tool Options getGridSnapSubdivisions');
  const setGridSnapEnabled = bindRequired(toolOptionsController, 'requestGridSnapToggle', 'Tool Options requestGridSnapToggle');
  const setGridSnapSubdivisions = bindRequired(toolOptionsController, 'requestGridSnapSubdivisionChange', 'Tool Options requestGridSnapSubdivisionChange');
  const toggleGridSnap = bindRequired(toolOptionsController, 'toggleGridSnapShortcut', 'Tool Options toggleGridSnapShortcut');
  const nudgeGridSnapSubdivisions = bindRequired(toolOptionsController, 'nudgeGridSnapSubdivision', 'Tool Options nudgeGridSnapSubdivision');
  const openActiveHelp = bindRequired(toolOptionsController, 'openActiveToolHelp', 'Tool Options openActiveToolHelp');

  const applyMaskedTiling = bindRequired(maskedTextures, 'applyMaskedTilingToTile');
  const applyStandardTileMask = bindRequired(maskedTextures, 'applyStandardTileMaskToTile');
  const clearStandardTileMask = bindRequired(maskedTextures, 'clearStandardTileMask');
  const scheduleMaskedRetry = bindRequired(maskedTextures, 'scheduleMaskedTileRetry');
  const clearMaskedRetry = bindRequired(maskedTextures, 'clearMaskedTileRetry');
  const rehydrateAllMaskedTextures = bindRequired(maskedTextures, 'rehydrateAllMaskedTiles');
  const cancelGlobalRehydrate = bindRequired(maskedTextures, 'cancelGlobalRehydrate');
  const cancelTileApplies = bindRequired(maskedTextures, 'cancelTileApplies');
  const createStandardMaskCustomBaseDisplay = bindRequired(standardMaskCustomBase, 'createStandardMaskCustomBaseDisplay');
  const getStandardMaskCustomBaseKey = bindRequired(standardMaskCustomBase, 'getStandardMaskCustomBaseKey');
  const hasStandardMaskCustomBaseSource = bindRequired(standardMaskCustomBase, 'hasStandardMaskCustomBaseSource');
  const getCachedTexture = bindRequired(sharedTextureCache, 'getCachedFoundryTexture');
  const loadTexture = bindRequired(sharedTextureCache, 'loadFoundryTexture');
  const recoverTexture = bindRequired(sharedTextureCache, 'recoverFoundryTexture');
  const initializeForge = bindRequired(forgeIntegration, 'initialize');
  const resolveFilePickerContext = bindRequired(forgeIntegration, 'resolveFilePickerContext');
  const optimizeCacheUrl = bindRequired(forgeIntegration, 'optimizeCacheURL');
  const collectPreviewEntries = bindRequired(layerManagerPreview, 'collectLayerManagerPreviewEntries');
  const getPreviewEntryById = bindRequired(layerManagerPreview, 'getLayerManagerPreviewEntryById');
  const routePreviewWheelAdjustment = bindRequired(layerManagerPreview, 'routeLayerManagerPreviewWheelAdjustment');
  const resolvePreviewSortNudge = bindRequired(layerManagerPreview, 'resolveLayerManagerPreviewSortNudge');
  const capturePreviewAnchorsForTileDrop = bindRequired(layerManagerPreview, 'captureLayerManagerPreviewAnchorsForTileDrop');
  const applyPreviewAnchorsAfterTileDrop = bindRequired(layerManagerPreview, 'applyLayerManagerPreviewAnchorsAfterTileDrop');
  const applyPreviewDropReorder = bindRequired(layerManagerPreview, 'applyLayerManagerPreviewDropReorder');

  const callShadowManager = (methodName, args) => {
    const manager = getAssetShadowManager(getApp());
    return bindRequired(manager, methodName, `Asset Shadow ${methodName}`)(...args);
  };

  return createPremiumRuntimeAdapter({
    capabilities: {
      [PREMIUM_RUNTIME_CAPABILITY.TOOL_OPTIONS_GET_GRID_SNAP_STATE]: () => ({
        enabled: isGridSnapEnabled(),
        subdivisions: getGridSnapSubdivisions()
      }),
      [PREMIUM_RUNTIME_CAPABILITY.TOOL_OPTIONS_SET_GRID_SNAP_ENABLED]: setGridSnapEnabled,
      [PREMIUM_RUNTIME_CAPABILITY.TOOL_OPTIONS_SET_GRID_SNAP_SUBDIVISIONS]: setGridSnapSubdivisions,
      [PREMIUM_RUNTIME_CAPABILITY.TOOL_OPTIONS_TOGGLE_GRID_SNAP]: toggleGridSnap,
      [PREMIUM_RUNTIME_CAPABILITY.TOOL_OPTIONS_NUDGE_GRID_SNAP_SUBDIVISIONS]: nudgeGridSnapSubdivisions,
      [PREMIUM_RUNTIME_CAPABILITY.TOOL_OPTIONS_OPEN_ACTIVE_HELP]: openActiveHelp,
      [PREMIUM_RUNTIME_CAPABILITY.ASSET_SHADOWS_GET_ELEVATION_SETTINGS]: (...args) => callShadowManager('getElevationSettings', args),
      [PREMIUM_RUNTIME_CAPABILITY.ASSET_SHADOWS_APPLY_ELEVATION_SETTINGS]: (...args) => callShadowManager('applyElevationSettings', args),
      [PREMIUM_RUNTIME_CAPABILITY.ASSET_SHADOWS_SUSPEND_TILE]: (...args) => callShadowManager('suspendTileAndWait', args),
      [PREMIUM_RUNTIME_CAPABILITY.ASSET_SHADOWS_RESUME_TILE]: (...args) => callShadowManager('resumeTile', args),
      [PREMIUM_RUNTIME_CAPABILITY.ASSET_SHADOWS_REFRESH_ALL]: (...args) => callShadowManager('refreshAll', args),
      [PREMIUM_RUNTIME_CAPABILITY.ASSET_SHADOWS_WAIT_FOR_REBUILDS]: (...args) => callShadowManager('waitForRebuilds', args),
      [PREMIUM_RUNTIME_CAPABILITY.ASSET_SHADOWS_RESOLVE_STANDARD_MASK_PREVIEW]: (...args) => callShadowManager('resolveStandardMaskPreviewConfig', args),
      [PREMIUM_RUNTIME_CAPABILITY.ASSET_SHADOWS_COMPUTE_STANDARD_MASK_BLUR_QUALITY]: (...args) => callShadowManager('computeStandardMaskPreviewBlurQuality', args),
      [PREMIUM_RUNTIME_CAPABILITY.ASSET_SHADOWS_RENDER_STANDARD_MASK_PREVIEW]: (...args) => callShadowManager('renderStandardMaskPreviewComposite', args),
      [PREMIUM_RUNTIME_CAPABILITY.MASKED_TEXTURES_APPLY_MASKED_TILING]: applyMaskedTiling,
      [PREMIUM_RUNTIME_CAPABILITY.MASKED_TEXTURES_APPLY_STANDARD_TILE_MASK]: applyStandardTileMask,
      [PREMIUM_RUNTIME_CAPABILITY.MASKED_TEXTURES_CLEAR_STANDARD_TILE_MASK]: clearStandardTileMask,
      [PREMIUM_RUNTIME_CAPABILITY.MASKED_TEXTURES_SCHEDULE_RETRY]: scheduleMaskedRetry,
      [PREMIUM_RUNTIME_CAPABILITY.MASKED_TEXTURES_CLEAR_RETRY]: clearMaskedRetry,
      [PREMIUM_RUNTIME_CAPABILITY.MASKED_TEXTURES_REHYDRATE_ALL]: rehydrateAllMaskedTextures,
      [PREMIUM_RUNTIME_CAPABILITY.MASKED_TEXTURES_CANCEL_GLOBAL_REHYDRATE]: cancelGlobalRehydrate,
      [PREMIUM_RUNTIME_CAPABILITY.MASKED_TEXTURES_CANCEL_TILE_APPLIES]: cancelTileApplies,
      [PREMIUM_RUNTIME_CAPABILITY.STANDARD_MASK_CUSTOM_BASE_CREATE_DISPLAY]: createStandardMaskCustomBaseDisplay,
      [PREMIUM_RUNTIME_CAPABILITY.STANDARD_MASK_CUSTOM_BASE_GET_KEY]: getStandardMaskCustomBaseKey,
      [PREMIUM_RUNTIME_CAPABILITY.STANDARD_MASK_CUSTOM_BASE_HAS_SOURCE]: hasStandardMaskCustomBaseSource,
      [PREMIUM_RUNTIME_CAPABILITY.SHARED_TEXTURE_CACHE_GET]: getCachedTexture,
      [PREMIUM_RUNTIME_CAPABILITY.SHARED_TEXTURE_CACHE_LOAD]: loadTexture,
      [PREMIUM_RUNTIME_CAPABILITY.SHARED_TEXTURE_CACHE_RECOVER]: recoverTexture,
      [PREMIUM_RUNTIME_CAPABILITY.FORGE_FILES_INITIALIZE]: initializeForge,
      [PREMIUM_RUNTIME_CAPABILITY.FORGE_FILES_RESOLVE_PICKER_CONTEXT]: resolveFilePickerContext,
      [PREMIUM_RUNTIME_CAPABILITY.FORGE_FILES_OPTIMIZE_CACHE_URL]: optimizeCacheUrl,
      [PREMIUM_RUNTIME_CAPABILITY.LAYER_MANAGER_COLLECT_PREVIEW_ENTRIES]: collectPreviewEntries,
      [PREMIUM_RUNTIME_CAPABILITY.LAYER_MANAGER_GET_PREVIEW_ENTRY_BY_ID]: getPreviewEntryById,
      [PREMIUM_RUNTIME_CAPABILITY.LAYER_MANAGER_ROUTE_PREVIEW_WHEEL_ADJUSTMENT]: routePreviewWheelAdjustment,
      [PREMIUM_RUNTIME_CAPABILITY.LAYER_MANAGER_RESOLVE_PREVIEW_SORT_NUDGE]: resolvePreviewSortNudge,
      [PREMIUM_RUNTIME_CAPABILITY.LAYER_MANAGER_CAPTURE_PREVIEW_ANCHORS_FOR_TILE_DROP]: capturePreviewAnchorsForTileDrop,
      [PREMIUM_RUNTIME_CAPABILITY.LAYER_MANAGER_APPLY_PREVIEW_ANCHORS_AFTER_TILE_DROP]: applyPreviewAnchorsAfterTileDrop,
      [PREMIUM_RUNTIME_CAPABILITY.LAYER_MANAGER_APPLY_PREVIEW_DROP_REORDER]: applyPreviewDropReorder,
      [PREMIUM_RUNTIME_CAPABILITY.BUILDING_V2_GET_RUNTIME_CAPABILITIES]: getBuildingV2RuntimeCapabilities,
      [PREMIUM_RUNTIME_CAPABILITY.BUILDING_PORTAL_PICKER_GET_DEPS]: loadBuildingPortalPickerDeps
    }
  });
}
