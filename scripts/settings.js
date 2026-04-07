import { FaNexusTokensFolderSelectionDialog } from "./tokens/tokens-content-sources-dialog.js";
import { FaNexusAssetsFolderSelectionDialog } from "./assets/assets-content-sources-dialog.js";
import { GeneratedCleanupDialog } from "./cleanup/generated-cleanup-dialog.js";
import { configurePremiumRuntime } from "./premium/premium-runtime-config.js";
import { installFoundryTextureLoaderCachePatch } from "./core/foundry-texture-loader-patch.js";
import { DEFAULT_SHADOW_QUALITY, SHADOW_QUALITY_CHOICES } from "./assets/shadow-quality.js";

installFoundryTextureLoaderCachePatch();

let _cloudDownloadFolderPickerHookInstalled = false;

function isDebugLoggingEnabled() {
  try { return game?.settings?.get?.('fa-nexus', 'debugLogging') === true; } catch (_) { return false; }
}

function cleanFolderPath(value) {
  return String(value ?? '').trim().replace(/^\/+/, '');
}

function ensureTrailingSlash(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  return s.endsWith('/') ? s : `${s}/`;
}

function buildS3FolderUrl(bucket, keyPrefix) {
  const cleanBucket = String(bucket ?? '').trim();
  if (!cleanBucket) return '';

  const prefix = cleanFolderPath(keyPrefix ?? '');
  const join = (baseUrl) => {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const path = prefix ? `/${prefix}` : '';
    return ensureTrailingSlash(`${base}${path}`);
  };

  const s3 = game?.data?.files?.s3 ?? {};
  const forcePathStyle = Boolean(s3.forcePathStyle || s3.pathStyle || s3.usePathStyle);
  const endpointCandidate = s3.endpoint || s3.url || s3.publicUrl || s3.publicURL || '';

  let endpointUrl = null;
  try {
    if (endpointCandidate instanceof URL) endpointUrl = endpointCandidate;
    else if (typeof endpointCandidate === 'string' && endpointCandidate.trim()) {
      const raw = endpointCandidate.trim();
      endpointUrl = new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`);
    } else if (endpointCandidate && typeof endpointCandidate === 'object') {
      const protocol = String(endpointCandidate.protocol || 'https:');
      const host = String(endpointCandidate.host || endpointCandidate.hostname || '').trim();
      if (host) endpointUrl = new URL(`${protocol.endsWith(':') ? protocol : `${protocol}:`}//${host}`);
    }
  } catch (_) {
    endpointUrl = null;
  }

  if (endpointUrl) {
    if (forcePathStyle) {
      return join(`${endpointUrl.origin.replace(/\/+$/, '')}/${cleanBucket}`);
    }
    const host = endpointUrl.hostname;
    const withBucketHost = host.startsWith(`${cleanBucket}.`) ? host : `${cleanBucket}.${host}`;
    const origin = `${endpointUrl.protocol}//${withBucketHost}${endpointUrl.port ? `:${endpointUrl.port}` : ''}`;
    return join(origin);
  }

  const region = s3.region || s3.awsRegion || s3.awsDefaultRegion || '';
  const host = region ? `${cleanBucket}.s3.${region}.amazonaws.com` : `${cleanBucket}.s3.amazonaws.com`;
  return join(`https://${host}`);
}

function normalizePickedStorageFolder(path, filePicker) {
  const result = String(path ?? '').trim();
  if (!result) return '';
  const source = String(filePicker?.activeSource || '').toLowerCase();
  const hasScheme = /^[a-z0-9+.-]+:/.test(result);
  if (source === 's3') {
    if (hasScheme && /^https?:\/\//i.test(result)) return ensureTrailingSlash(result);
    const clean = cleanFolderPath(result);
    const bucket = String(filePicker?.source?.bucket || filePicker?.sources?.s3?.bucket || filePicker?.options?.bucket || '').trim();
    const url = bucket ? buildS3FolderUrl(bucket, clean) : '';
    if (url) return url;
    if (bucket) return clean ? `s3:${bucket}/${clean}` : `s3:${bucket}`;
    return clean ? `s3:${clean}` : 's3:';
  }
  if (!hasScheme && source && source !== 'data') {
    return `${source}:${cleanFolderPath(result)}`;
  }
  return result;
}

function installCloudDownloadFolderPickerHook() {
  if (_cloudDownloadFolderPickerHookInstalled) return;
  _cloudDownloadFolderPickerHookInstalled = true;

  Hooks.on('renderSettingsConfig', (_app, html) => {
    const root = html?.nodeType ? html : (html?.[0] || null);
    if (!root) return;
    const targets = ['cloudDownloadDirTokens', 'cloudDownloadDirAssets'];
    for (const key of targets) {
      const settingName = `fa-nexus.${key}`;
      const pickerElement = root.querySelector(`file-picker[name="${settingName}"]`);
      if (!pickerElement) continue;
      if (pickerElement.dataset.faNexusCloudDownloadPicker === '1') continue;
      pickerElement.dataset.faNexusCloudDownloadPicker = '1';
      if (isDebugLoggingEnabled()) {
        try { console.debug('fa-nexus | installCloudDownloadFolderPickerHook:patched', { settingName, kind: 'file-picker-element' }); } catch (_) {}
      }
      pickerElement.addEventListener('change', (event) => {
        try {
          // Ignore bubbled change events from the inner <input>; only handle changes emitted by the custom element,
          // which occur when the FilePicker callback sets pickerElement.value.
          if (event?.target !== pickerElement) return;

          const fp = pickerElement.picker || null;
          const currentValue = String(pickerElement.value || '').trim();
          const stored = normalizePickedStorageFolder(currentValue, fp);
          if (!stored || stored === currentValue) return;

          if (isDebugLoggingEnabled()) {
            try {
              console.debug('fa-nexus | cloudDownloadFolder:normalized', {
                settingName,
                activeSource: String(fp?.activeSource || ''),
                bucket: fp?.source?.bucket,
                from: currentValue,
                to: stored
              });
            } catch (_) {}
          }
          pickerElement.value = stored;
        } catch (error) {
          try { console.warn('fa-nexus | cloud download folder picker failed', error); } catch (_) {}
        }
      }, { capture: true });
    }
  });
}

/**
 * Register FA Nexus game settings and auxiliary management menus.
 * Includes client-side UI state, local folder configuration, cache managers,
 * cloud manifest tools, and Patreon auth integration hooks.
 */
export function registerFaNexusSettings() {
  const MODULE_ID = 'fa-nexus';
  const client = (key, data) => game.settings.register(MODULE_ID, key, Object.assign({ scope: 'client', config: true }, data));
  const world = (key, data) => game.settings.register(MODULE_ID, key, Object.assign({ scope: 'world', config: true }, data));
  const menu = (key, data) => game.settings.registerMenu(MODULE_ID, key, data);

  // Operates in background; toggled by in-app checkbox
  client('mainColorOnly', { name: 'Show Main Color Only', type: Boolean, default: true, config: false });

  // Enable verbose debug logging to console
  world('debugLogging', { name: 'Enable Debug Logging', type: Boolean, default: false, config: true, restricted: true, hint: 'If enabled, FA Nexus will log detailed debug information to the browser console to help troubleshoot issues.' });

  // Floating launcher mode
  world('floatingLauncher', {
    name: 'Floating Launcher',
    type: Boolean,
    default: false,
    config: true,
    restricted: true,
    hint: 'When enabled, the Nexus launcher button floats freely and can be dragged anywhere on screen instead of being docked above the players list.',
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'floatingLauncher', value }); } catch (_) { }
    }
  });
  client('launcherPosition', { name: 'Launcher Position', type: Object, default: { left: null, top: null }, config: false });

  // New persisted UI state (per tab)
  client('thumbWidthTokens', { name: 'Token Thumbnail Width', type: Number, default: 140, config: false });
  client('thumbWidthAssets', { name: 'Asset Thumbnail Width', type: Number, default: 108, config: false });
  client('thumbWidthTextures', { name: 'Texture Thumbnail Width', type: Number, default: 108, config: false });
  client('thumbWidthPaths', { name: 'Path Thumbnail Width', type: Number, default: 108, config: false });
  client('thumbWidthBuildingTextures', { name: 'Building Fill Texture Thumbnail Width', type: Number, default: 108, config: false });
  client('solidTextureColor', { name: 'Solid Texture Color', type: String, default: '#808080', config: false });
  client('windowPos', { name: 'Window Position', type: Object, default: {}, config: false });
  client('toolOptionsWindowPos', { name: 'Tool Options Window Position', type: Object, default: {}, config: false });
  client('toolOptionsShortcuts', { name: 'Tool Options Shortcuts Collapse State', type: Object, default: {}, config: false });
  client('toolOptionsSections', { name: 'Tool Options Section Collapse State', type: Object, default: {}, config: false });
  client('activeTab', { name: 'Active Tab', type: String, default: 'tokens', config: false });
  client('buildingsActiveSubtab', { name: 'Building Tab Active Subtab', type: String, default: 'building', config: false });
  client('buildingsSubtabSearch', { name: 'Building Tab Search State', type: Object, default: {}, config: false });
  client('buildingPortalDoorDefaults', { name: 'Building Portal Door Defaults', type: Object, default: {}, config: false });
  client('buildingPortalWindowDefaults', { name: 'Building Portal Window Defaults', type: Object, default: {}, config: false });
  client('buildingToolDefaults', { name: 'Building Tool Defaults', type: Object, default: {}, config: false });
  client('buildingToolActiveSubtool', { name: 'Building Tool Active Subtool', type: String, default: '', config: false });
  client('pathToolDefaults', { name: 'Path Tool Defaults', type: Object, default: {}, config: false });
  client('pathToolActiveSubtool', { name: 'Path Tool Active Subtool', type: String, default: '', config: false });
  client('flattenOptions', {
    name: 'Flatten Options',
    type: Object,
    default: {
      ppi: 200,
      quality: 0.85,
      paddingSnap: 'none',
      paddingExtra: 0,
      exportSplitLayers: false,
      exportChunked: false,
      exportAction: 'flatten',
      flattenOutputFolder: 'fa-nexus-assets/__generated/flattened',
      exportOutputFolder: 'fa-nexus-assets/exports'
    },
    config: false
  });
  client('generatedCleanupBackupFirst', {
    name: 'Generated Cleanup Backup First',
    type: Boolean,
    default: true,
    config: false
  });
  world('generatedFlattenRoots', {
    name: 'Generated Flatten Roots',
    type: String,
    default: '[]',
    config: false,
    restricted: true
  });
  client('layerManagerElevationMin', { name: 'Layer Manager Elevation Min', type: String, default: '', config: false });
  client('layerManagerElevationMax', { name: 'Layer Manager Elevation Max', type: String, default: '', config: false });
  client('layerManagerSkipLocked', { name: 'Layer Manager Skip Locked', type: Boolean, default: true, config: false });
  client('layerManagerSkipHidden', { name: 'Layer Manager Skip Hidden', type: Boolean, default: true, config: false });
  client('layerManagerSkipFiltered', { name: 'Layer Manager Skip Filtered', type: Boolean, default: true, config: false });
  client('layerManagerIgnoreForeground', { name: 'Layer Manager All Layers', type: Boolean, default: true, config: false });
  client('layerManagerCollapsedState', {
    name: 'Layer Manager Collapsed State',
    type: String,
    default: '{}',
    config: false,
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'layerManagerCollapsedState', value }); } catch (_) { }
    }
  });
  world('layerManagerNestedGrouping', {
    name: 'Layer Manager Nested Elevation Groups',
    type: Boolean,
    default: true,
    config: true,
    restricted: true,
    hint: 'Group layer elevations into nested upward buckets in the Layer Manager so fractional elevations can be organized as subgroups.',
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'layerManagerNestedGrouping', value }); } catch (_) { }
    }
  });
  // Cloud download directories (separate per kind)
  world('cloudDownloadDirTokens', { name: 'Cloud Download Folder (Tokens)', type: String, filePicker: 'folder', default: 'fa-nexus-tokens', config: true, restricted: true });
  world('cloudDownloadDirAssets', { name: 'Cloud Download Folder (Assets)', type: String, filePicker: 'folder', default: 'fa-nexus-assets', config: true, restricted: true });
  // Use direct URLs for free cloud content instead of downloading/caching locally
  world('useDirectCloudUrls', {
    name: 'Use Direct URLs for Free Cloud Content',
    type: Boolean,
    default: false,
    config: true,
    restricted: true,
    hint: 'When enabled, free cloud tokens and assets will be loaded directly from the public CDN instead of being downloaded and cached locally. This saves disk space but requires an internet connection during gameplay.'
  });
  client('cloudTokensEnabled', {
    name: 'Enable Cloud Tokens', type: Boolean, default: true, config: false, onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'cloudTokensEnabled', value }); } catch (_) { }
    }
  });
  client('cloudAssetsEnabled', {
    name: 'Enable Cloud Assets', type: Boolean, default: true, config: false, onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'cloudAssetsEnabled', value }); } catch (_) { }
    }
  });

  // Multi-folder selection (JSON string array of {path,label,enabled,customLabel})
  client('tokenFolders', {
    name: 'Token Folders', type: String, default: '[]', config: false, onChange: (value) => {
      try {
        // Client-scope settings do not emit the core update hook; mirror it so UIs can react
        Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'tokenFolders', value });
      } catch (_) { }
    }
  });
  client('assetFolders', {
    name: 'Asset Folders', type: String, default: '[]', config: false, onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'assetFolders', value }); } catch (_) { }
    }
  });
  client('hideLocked', { name: 'Hide Locked Items', type: Boolean, default: false, config: false });
  client('gridSnap', { name: 'Snap to Grid', type: Boolean, default: true, config: false });
  client('gridSnapSubdivisions', {
    name: 'Grid Snap Subdivisions',
    type: Number,
    default: 1,
    config: false
  });
  client('textureBrushSize', {
    name: 'Texture Brush Size',
    type: Number,
    default: 128,
    config: false
  });
  client('textureParticleSize', {
    name: 'Texture Particle Size',
    type: Number,
    default: 100,
    config: false
  });
  client('textureParticleDensity', {
    name: 'Texture Particle Density',
    type: Number,
    default: 1,
    config: false
  });
  client('textureSprayDeviation', {
    name: 'Texture Spray Deviation',
    type: Number,
    default: 100,
    config: false
  });
  client('textureBrushSpacing', {
    name: 'Texture Brush Spacing',
    type: Number,
    default: 1,
    config: false
  });
  client('textureBrushOpacity', {
    name: 'Texture Brush Opacity',
    type: Number,
    default: 15,
    config: false
  });
  client('textureFillOpacity', {
    name: 'Texture Fill Opacity',
    type: Number,
    default: 100,
    config: false
  });
  client('textureScale', {
    name: 'Texture Scale',
    type: Number,
    default: 100,
    config: false
  });
  client('textureRotation', {
    name: 'Texture Rotation',
    type: Number,
    default: 0,
    config: false
  });
  client('textureOffsetX', {
    name: 'Texture Offset X',
    type: Number,
    default: 0,
    config: false
  });
  client('textureOffsetY', {
    name: 'Texture Offset Y',
    type: Number,
    default: 0,
    config: false
  });
  client('tokenRandomColorPlacement', { name: 'Random Color on Placement', type: Boolean, default: false, config: false });
  world('assetDropShadow', {
    name: 'Asset Drop Shadow',
    type: Boolean,
    default: true,
    config: true,
    restricted: true,
    hint: 'Enable drop shadows for assets placed via FA Nexus. Individual placements can still toggle shadows while this is enabled.',
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'assetDropShadow', value }); } catch (_) { }
    }
  });
  world('assetDropShadowQuality', {
    name: 'Shadow Quality',
    hint: 'Controls the maximum resolution of shadow render textures. Lower values reduce VRAM usage significantly on large scenes; High is the recommended default.',
    type: String,
    choices: SHADOW_QUALITY_CHOICES,
    default: DEFAULT_SHADOW_QUALITY,
    config: true,
    restricted: true,
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'assetDropShadowQuality', value }); } catch (_) { }
    }
  });
  const notifyShadowSetting = (key) => (value) => {
    try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key, value }); } catch (_) { }
  };
  client('assetDropShadowAlpha', {
    name: 'Asset Shadow Opacity',
    type: Number,
    default: 0.65,
    config: false,
    onChange: notifyShadowSetting('assetDropShadowAlpha')
  });
  client('assetDropShadowDilation', {
    name: 'Asset Shadow Spread',
    type: Number,
    default: 1.6,
    config: false,
    onChange: notifyShadowSetting('assetDropShadowDilation')
  });
  client('assetDropShadowBlur', {
    name: 'Asset Shadow Blur',
    type: Number,
    default: 1.8,
    config: false,
    onChange: notifyShadowSetting('assetDropShadowBlur')
  });
  client('assetDropShadowOffsetDistance', {
    name: 'Asset Shadow Offset Distance',
    type: Number,
    default: 0,
    config: false,
    onChange: notifyShadowSetting('assetDropShadowOffsetDistance')
  });
  client('assetDropShadowOffsetMax', {
    name: 'Asset Shadow Offset Distance Max',
    type: Number,
    default: 40,
    config: false,
    onChange: notifyShadowSetting('assetDropShadowOffsetMax')
  });
  client('assetDropShadowOffsetAngle', {
    name: 'Asset Shadow Offset Angle',
    type: Number,
    default: 135,
    config: false,
    onChange: notifyShadowSetting('assetDropShadowOffsetAngle')
  });
  client('assetDropShadowCollapsed', {
    name: 'Asset Shadow Settings Collapsed',
    type: Boolean,
    default: false,
    config: false,
    onChange: notifyShadowSetting('assetDropShadowCollapsed')
  });
  client('assetDropShadowPresets', {
    name: 'Asset Shadow Presets',
    type: String,
    default: '[]',
    config: false,
    onChange: notifyShadowSetting('assetDropShadowPresets')
  });
  client('assetScatterBrushSize', {
    name: 'Asset Scatter Brush Size',
    type: Number,
    default: 320,
    config: false
  });
  client('assetScatterDensity', {
    name: 'Asset Scatter Density',
    type: Number,
    default: 3,
    config: false
  });
  client('assetScatterSprayDeviation', {
    name: 'Asset Scatter Spray Deviation',
    type: Number,
    default: 50,
    config: false
  });
  client('assetScatterSpacing', {
    name: 'Asset Scatter Spacing',
    type: Number,
    default: 25,
    config: false
  });
  client('assetScatterMerge', {
    name: 'Asset Scatter Merge',
    type: Boolean,
    default: true,
    config: false
  });
  client('assetPlacementScale', {
    name: 'Asset Placement Scale',
    type: Number,
    default: 1,
    config: false
  });
  client('assetPlacementScaleRandomEnabled', {
    name: 'Asset Placement Scale Random Enabled',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetPlacementScaleRandomMin', {
    name: 'Asset Placement Scale Random Min',
    type: Number,
    default: 80,
    config: false
  });
  client('assetPlacementScaleRandomMax', {
    name: 'Asset Placement Scale Random Max',
    type: Number,
    default: 120,
    config: false
  });
  client('assetPlacementScaleRandomStrength', {
    name: 'Asset Placement Scale Random Strength',
    type: Number,
    default: 15,
    config: false
  });
  client('assetPlacementRotation', {
    name: 'Asset Placement Rotation',
    type: Number,
    default: 0,
    config: false
  });
  client('assetPlacementRotationRandomEnabled', {
    name: 'Asset Placement Rotation Random Enabled',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetPlacementRotationRandomMin', {
    name: 'Asset Placement Rotation Random Min',
    type: Number,
    default: 0,
    config: false
  });
  client('assetPlacementRotationRandomMax', {
    name: 'Asset Placement Rotation Random Max',
    type: Number,
    default: 359,
    config: false
  });
  client('assetPlacementRotationRandomStrength', {
    name: 'Asset Placement Rotation Random Strength',
    type: Number,
    default: 45,
    config: false
  });
  client('assetPlacementFlipHorizontal', {
    name: 'Asset Placement Flip Horizontal',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetPlacementFlipVertical', {
    name: 'Asset Placement Flip Vertical',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetPlacementFlipRandomHorizontal', {
    name: 'Asset Placement Flip Random Horizontal',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetPlacementFlipRandomVertical', {
    name: 'Asset Placement Flip Random Vertical',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetPlacementScatterMode', {
    name: 'Asset Placement Scatter Mode',
    type: String,
    default: 'single',
    config: false
  });
  client('assetScatterPlacementTransformsInitialized', {
    name: 'Asset Scatter Placement Transforms Initialized',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetScatterPlacementScale', {
    name: 'Asset Scatter Placement Scale',
    type: Number,
    default: 1,
    config: false
  });
  client('assetScatterPlacementScaleRandomEnabled', {
    name: 'Asset Scatter Placement Scale Random Enabled',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetScatterPlacementScaleRandomMin', {
    name: 'Asset Scatter Placement Scale Random Min',
    type: Number,
    default: 80,
    config: false
  });
  client('assetScatterPlacementScaleRandomMax', {
    name: 'Asset Scatter Placement Scale Random Max',
    type: Number,
    default: 120,
    config: false
  });
  client('assetScatterPlacementRotation', {
    name: 'Asset Scatter Placement Rotation',
    type: Number,
    default: 0,
    config: false
  });
  client('assetScatterPlacementRotationRandomEnabled', {
    name: 'Asset Scatter Placement Rotation Random Enabled',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetScatterPlacementRotationRandomMin', {
    name: 'Asset Scatter Placement Rotation Random Min',
    type: Number,
    default: 0,
    config: false
  });
  client('assetScatterPlacementRotationRandomMax', {
    name: 'Asset Scatter Placement Rotation Random Max',
    type: Number,
    default: 359,
    config: false
  });
  client('assetScatterPlacementFlipHorizontal', {
    name: 'Asset Scatter Placement Flip Horizontal',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetScatterPlacementFlipVertical', {
    name: 'Asset Scatter Placement Flip Vertical',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetScatterPlacementFlipRandomHorizontal', {
    name: 'Asset Scatter Placement Flip Random Horizontal',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetScatterPlacementFlipRandomVertical', {
    name: 'Asset Scatter Placement Flip Random Vertical',
    type: Boolean,
    default: false,
    config: false
  });
  client('assetPlacementDropShadowPreference', {
    name: 'Asset Placement Drop Shadow Preference',
    type: String,
    default: 'global',
    config: false
  });
  client('pathShadowPresets', {
    name: 'Path Shadow Presets',
    type: String,
    default: '[]',
    config: false,
    onChange: notifyShadowSetting('pathShadowPresets')
  });
  client('pathMergeOnCommit', {
    name: 'Path Merge On Commit',
    type: Boolean,
    default: true,
    config: false,
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'pathMergeOnCommit', value }); } catch (_) { }
    }
  });
  world('tokenElevationOffset', {
    name: 'Shift BG & Tile Elevation Down',
    type: Boolean,
    default: true,
    config: true,
    restricted: true,
    hint: 'Shift tile render elevation down by 1 for all tiles below elevation 1 (including negatives), and push the scene background lower, so tokens render above tiles at 0.xxx elevations.',
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'tokenElevationOffset', value }); } catch (_) { }
      try { Hooks.callAll('fa-nexus-token-elevation-offset-changed', { enabled: !!value }); } catch (_) { }
    }
  });
  world('tilePixelSelection', {
    name: 'Pixel-Perfect Tile Selection',
    type: Boolean,
    default: true,
    config: true,
    restricted: true,
    hint: 'Use pixel alpha sampling so tile interactions only trigger on visible pixels. Disable if you prefer the default Foundry hit areas or encounter compatibility issues.',
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'tilePixelSelection', value }); } catch (_) { }
    }
  });
  configurePremiumRuntime({ moduleId: MODULE_ID, registerWorldSetting: world });
  // Patreon auth data (stored client-side; updated by OAuth flow)
  client('patreon_auth_data', {
    name: 'Patreon Auth Data', type: Object, default: null, config: false, onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'patreon_auth_data', value }); } catch (_) { }
    }
  });

  // Bookmarks per tab (array of bookmark objects)
  client('bookmarks', { name: 'Bookmarks', type: Object, default: {}, config: false });

  // Local Token Folders (settings menu opens the dialog)
  menu('folderSelectionMenu', {
    name: 'Token Sources',
    label: 'Configure',
    hint: 'Select your local sources for the Tokens Tab and activate/deactivate FA Cloud Tokens.',
    icon: 'fas fa-folder',
    type: FaNexusTokensFolderSelectionDialog,
    restricted: true
  });
  // Local Asset Folders (settings menu opens the dialog)
  menu('assetFolderSelectionMenu', {
    name: 'Asset Sources',
    label: 'Configure',
    hint: 'Select your local sources for the Assets/Textures/Paths Tabs and activate/deactivate FA Cloud Assets.',
    icon: 'fas fa-folder',
    type: FaNexusAssetsFolderSelectionDialog,
    restricted: true
  });
  menu('generatedCleanupMenu', {
    name: 'Generated Cleanup',
    label: 'Open',
    hint: 'Scan generated masks and flattened outputs, report unused and missing files, and optionally overwrite unused files with a visible marker.',
    icon: 'fas fa-broom',
    type: GeneratedCleanupDialog,
    restricted: true
  });
  // Actor creation target folder
  world('actorCreationFolder', { name: 'Actor Creation Folder', type: String, default: '', config: true, restricted: true });

  // Excluded compendium packs for Place Tokens As (JSON array of pack collection IDs)
  // World-scoped because compendiums differ per world/system
  world('placeAsExcludedPacks', {
    name: 'Place As Excluded Compendiums',
    type: String,
    default: '[]',
    config: false,
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'placeAsExcludedPacks', value }); } catch (_) { }
    }
  });

}
// Register on init, but also attempt immediate registration in case this file
// loads after the init hook has already fired (robustness for load order).
try {
  if (globalThis.game?.settings) registerFaNexusSettings();
} catch (e) { }
try { if (globalThis.Hooks) installCloudDownloadFolderPickerHook(); } catch (_) { }
Hooks.once('init', () => {
  try { registerFaNexusSettings(); } catch (e) { }
  try { installCloudDownloadFolderPickerHook(); } catch (_) { }
});
