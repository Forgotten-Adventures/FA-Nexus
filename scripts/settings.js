import { FaNexusTokensFolderSelectionDialog } from "./tokens/tokens-content-sources-dialog.js";
import { FaNexusAssetsFolderSelectionDialog } from "./assets/assets-content-sources-dialog.js";

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
  client('debugLogging', { name: 'Enable Debug Logging', type: Boolean, default: false, config: true, hint: 'If enabled, FA Nexus will log detailed debug information to the browser console to help troubleshoot issues.' });

  // New persisted UI state (per tab)
  client('thumbWidthTokens', { name: 'Token Thumbnail Width', type: Number, default: 140, config: false });
  client('thumbWidthAssets', { name: 'Asset Thumbnail Width', type: Number, default: 108, config: false });
  client('thumbWidthTextures', { name: 'Texture Thumbnail Width', type: Number, default: 108, config: false });
  client('thumbWidthPaths', { name: 'Path Thumbnail Width', type: Number, default: 108, config: false });
  client('windowPos', { name: 'Window Position', type: Object, default: {}, config: false });
  client('toolOptionsWindowPos', { name: 'Tool Options Window Position', type: Object, default: {}, config: false });
  client('toolOptionsShortcuts', { name: 'Tool Options Shortcuts Collapse State', type: Object, default: {}, config: false });
  client('activeTab', { name: 'Active Tab', type: String, default: 'tokens', config: false });
  // Cloud download directories (separate per kind)
  client('cloudDownloadDirTokens', { name: 'Cloud Download Folder (Tokens)', type: String, filePicker: 'folder', default: 'fa-nexus-tokens', config: true });
  client('cloudDownloadDirAssets', { name: 'Cloud Download Folder (Assets)', type: String, filePicker: 'folder', default: 'fa-nexus-assets', config: true });
  client('cloudTokensEnabled', { name: 'Enable Cloud Tokens', type: Boolean, default: true, config: false, onChange: (value) => {
    try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'cloudTokensEnabled', value }); } catch (_) {}
  }});
  client('cloudAssetsEnabled', { name: 'Enable Cloud Assets', type: Boolean, default: true, config: false, onChange: (value) => {
    try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'cloudAssetsEnabled', value }); } catch (_) {}
  }});

  // Multi-folder selection (JSON string array of {path,label,enabled,customLabel})
  client('tokenFolders', { name: 'Token Folders', type: String, default: '[]', config: false, onChange: (value) => {
    try {
      // Client-scope settings do not emit the core update hook; mirror it so UIs can react
      Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'tokenFolders', value });
    } catch (_) {}
  }});
  client('assetFolders', { name: 'Asset Folders', type: String, default: '[]', config: false, onChange: (value) => {
    try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'assetFolders', value }); } catch (_) {}
  }});
  client('hideLocked', { name: 'Hide Locked Items', type: Boolean, default: false, config: false });
  client('gridSnap', { name: 'Snap to Grid', type: Boolean, default: true, config: false });
  client('tokenRandomColorPlacement', { name: 'Random Color on Placement', type: Boolean, default: false, config: false });
  client('assetDropShadow', {
    name: 'Asset Drop Shadow',
    type: Boolean,
    default: false,
    config: true,
    hint: 'Enable drop shadows for assets placed via FA Nexus. Individual placements can still toggle shadows while this is enabled.',
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'assetDropShadow', value }); } catch (_) {}
    }
  });
  const notifyShadowSetting = (key) => (value) => {
    try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key, value }); } catch (_) {}
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
  client('tokenElevationOffset', {
    name: 'Keep Tokens Above Tile Elevations',
    type: Boolean,
    default: true,
    config: true,
    hint: 'Render tokens slightly above tiles at the same elevation so asset sublayers stay beneath them. Disable if another module manages token elevation order.',
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'tokenElevationOffset', value }); } catch (_) {}
      try { Hooks.callAll('fa-nexus-token-elevation-offset-changed', { enabled: !!value }); } catch (_) {}
    }
  });
  client('tilePixelSelection', {
    name: 'Pixel-Perfect Tile Selection',
    type: Boolean,
    default: true,
    config: true,
    hint: 'Use pixel alpha sampling so tile interactions only trigger on visible pixels. Disable if you prefer the default Foundry hit areas or encounter compatibility issues.',
    onChange: (value) => {
      try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'tilePixelSelection', value }); } catch (_) {}
    }
  });
  // Patreon auth data (stored client-side; updated by OAuth flow)
  client('patreon_auth_data', { name: 'Patreon Auth Data', type: Object, default: null, config: false, onChange: (value) => {
    try { Hooks.callAll('updateSetting', { namespace: MODULE_ID, key: 'patreon_auth_data', value }); } catch (_) {}
  }});

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
  // Actor creation target folder
  client('actorCreationFolder', { name: 'Actor Creation Folder', type: String, default: '', config: true });

}
// Register on init, but also attempt immediate registration in case this file
// loads after the init hook has already fired (robustness for load order).
try {
  if (globalThis.game?.settings) registerFaNexusSettings();
} catch (e) {}
Hooks.once('init', () => {
  try { registerFaNexusSettings(); } catch (e) {}
});

// Broaden Foundry's zoom limits to avoid drift at clamp boundaries during Ctrl+Wheel zoom
Hooks.once('setup', () => {
  try {
    if (globalThis.CONFIG && globalThis.CONFIG.Canvas) {
      // Use very generous bounds; our placement UI clamps sensibly per interaction
      globalThis.CONFIG.Canvas.maxZoom = 4;
      // minZoom is supported in v13+; guard just in case
      globalThis.CONFIG.Canvas.minZoom = 1 / 5;
    }
  } catch (_) {
    // no-op
  }
});
