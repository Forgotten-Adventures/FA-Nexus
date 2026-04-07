import { NexusLogger as Logger } from '../core/nexus-logger.js';

const DEFAULT_MODULE_ID = 'fa-nexus';
const PREMIUM_DEV_BRIDGE_IMPORT = '../../premium_features/dev-bridge.js';
const PREMIUM_DEV_BRIDGE_FLAG = 'premiumDevBridge';

export const PREMIUM_AUTH_SETTING = 'patreon_auth_data';

const RUNTIME_STATE = {
  moduleId: DEFAULT_MODULE_ID,
  registerWorldSetting: null,
  bridge: null,
  loadPromise: null,
  missing: false,
  settingsRegistered: false
};

function getPremiumDevBridgeStorageKey(moduleId = DEFAULT_MODULE_ID) {
  return `${moduleId}.${PREMIUM_DEV_BRIDGE_FLAG}`;
}

function parsePremiumDevBridgeFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function readPremiumDevBridgeStorageFlag(storage, moduleId = DEFAULT_MODULE_ID) {
  try {
    if (!storage?.getItem) return null;
    return parsePremiumDevBridgeFlag(storage.getItem(getPremiumDevBridgeStorageKey(moduleId)));
  } catch (_) {
    return null;
  }
}

function shouldAttemptPremiumRuntimeBridgeLoad() {
  const moduleId = RUNTIME_STATE.moduleId || DEFAULT_MODULE_ID;

  // Do not probe the optional dev bridge in public releases; developers must opt in explicitly.
  try {
    if (globalThis.window?.faNexus?.[PREMIUM_DEV_BRIDGE_FLAG] === true) return true;
    if (globalThis.window?.faNexus?.[PREMIUM_DEV_BRIDGE_FLAG] === false) return false;
  } catch (_) {}

  const sessionFlag = readPremiumDevBridgeStorageFlag(globalThis.sessionStorage, moduleId);
  if (sessionFlag != null) return sessionFlag;

  const localFlag = readPremiumDevBridgeStorageFlag(globalThis.localStorage, moduleId);
  if (localFlag != null) return localFlag;

  return false;
}

function writePremiumDevBridgeStorageFlag(storage, moduleId = DEFAULT_MODULE_ID, enabled) {
  try {
    if (!storage?.setItem || !storage?.removeItem) return false;
    const key = getPremiumDevBridgeStorageKey(moduleId);
    if (enabled == null) storage.removeItem(key);
    else storage.setItem(key, enabled ? 'true' : 'false');
    return true;
  } catch (_) {
    return false;
  }
}

function setPremiumDevBridgeWindowFlag(enabled) {
  try {
    globalThis.window.faNexus = Object.assign(globalThis.window.faNexus || {}, {
      [PREMIUM_DEV_BRIDGE_FLAG]: enabled === true
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function loadPremiumRuntimeBridge() {
  if (RUNTIME_STATE.bridge) return RUNTIME_STATE.bridge;
  if (!shouldAttemptPremiumRuntimeBridgeLoad()) return null;
  if (RUNTIME_STATE.missing) return null;
  if (!RUNTIME_STATE.loadPromise) {
    RUNTIME_STATE.loadPromise = import(PREMIUM_DEV_BRIDGE_IMPORT)
      .then((bridge) => {
        RUNTIME_STATE.bridge = bridge || null;
        RUNTIME_STATE.missing = !bridge;
        Logger.info('PremiumRuntimeConfig.devBridge.loaded', {
          moduleId: RUNTIME_STATE.moduleId,
          importPath: PREMIUM_DEV_BRIDGE_IMPORT
        });
        registerBridgeSettings();
        return RUNTIME_STATE.bridge;
      })
      .catch((error) => {
        RUNTIME_STATE.bridge = null;
        RUNTIME_STATE.missing = true;
        Logger.error('PremiumRuntimeConfig.devBridge.load.failed', {
          moduleId: RUNTIME_STATE.moduleId,
          importPath: PREMIUM_DEV_BRIDGE_IMPORT,
          error: String(error?.message || error)
        });
        return null;
      })
      .finally(() => {
        RUNTIME_STATE.loadPromise = null;
      });
  }
  return RUNTIME_STATE.loadPromise;
}

function getLoadedPremiumRuntimeBridge() {
  if (!RUNTIME_STATE.bridge && !RUNTIME_STATE.missing) {
    void loadPremiumRuntimeBridge();
  }
  return RUNTIME_STATE.bridge;
}

function registerBridgeSettings() {
  if (RUNTIME_STATE.settingsRegistered) return true;
  const bridge = RUNTIME_STATE.bridge;
  if (!bridge || typeof RUNTIME_STATE.registerWorldSetting !== 'function') return false;
  if (typeof bridge.registerPremiumRuntimeSettings !== 'function') {
    RUNTIME_STATE.settingsRegistered = true;
    return true;
  }
  try {
    bridge.registerPremiumRuntimeSettings({
      moduleId: RUNTIME_STATE.moduleId,
      registerWorldSetting: RUNTIME_STATE.registerWorldSetting
    });
    RUNTIME_STATE.settingsRegistered = true;
    return true;
  } catch (_) {
    return false;
  }
}

export function configurePremiumRuntime({ moduleId = DEFAULT_MODULE_ID, registerWorldSetting } = {}) {
  RUNTIME_STATE.moduleId = moduleId || DEFAULT_MODULE_ID;
  if (typeof registerWorldSetting === 'function') {
    RUNTIME_STATE.registerWorldSetting = registerWorldSetting;
  }
  registerBridgeSettings();
  void loadPremiumRuntimeBridge();
}

export function isPremiumDevBridgeBootstrapEnabled() {
  return shouldAttemptPremiumRuntimeBridgeLoad() === true;
}

export async function setPremiumDevBridgeBootstrapEnabled(enabled, { persist = 'local' } = {}) {
  const moduleId = RUNTIME_STATE.moduleId || DEFAULT_MODULE_ID;
  const normalized = enabled === true;

  setPremiumDevBridgeWindowFlag(normalized);

  if (persist === 'session') {
    writePremiumDevBridgeStorageFlag(globalThis.localStorage, moduleId, null);
    writePremiumDevBridgeStorageFlag(globalThis.sessionStorage, moduleId, normalized);
  } else if (persist === 'local') {
    writePremiumDevBridgeStorageFlag(globalThis.sessionStorage, moduleId, null);
    writePremiumDevBridgeStorageFlag(globalThis.localStorage, moduleId, normalized);
  } else if (persist === 'none') {
    writePremiumDevBridgeStorageFlag(globalThis.sessionStorage, moduleId, null);
    writePremiumDevBridgeStorageFlag(globalThis.localStorage, moduleId, null);
  }

  if (!normalized) return false;

  RUNTIME_STATE.missing = false;
  return (await loadPremiumRuntimeBridge()) != null;
}

export async function setPremiumDevBridgeEnabled(enabled, { persist = 'local' } = {}) {
  const normalized = enabled === true;
  const bridgeLoaded = await setPremiumDevBridgeBootstrapEnabled(normalized, { persist });
  const bridge = normalized ? (RUNTIME_STATE.bridge || await loadPremiumRuntimeBridge()) : RUNTIME_STATE.bridge;
  const settingKey = bridge?.PREMIUM_DEV_LOCAL_BUNDLES_SETTING || null;
  const fullKey = settingKey ? `${RUNTIME_STATE.moduleId}.${settingKey}` : null;

  if (!settingKey || !fullKey || !game?.settings?.settings?.has?.(fullKey)) {
    if (normalized) {
      Logger.error('PremiumRuntimeConfig.devBridge.setting.missing', {
        moduleId: RUNTIME_STATE.moduleId,
        settingKey,
        bridgeLoaded
      });
    }
    return bridgeLoaded;
  }

  try {
    await game.settings.set(RUNTIME_STATE.moduleId, settingKey, normalized);
    Logger.info('PremiumRuntimeConfig.devBridge.setting.updated', {
      moduleId: RUNTIME_STATE.moduleId,
      settingKey,
      enabled: normalized
    });
    return true;
  } catch (error) {
    Logger.error('PremiumRuntimeConfig.devBridge.setting.updateFailed', {
      moduleId: RUNTIME_STATE.moduleId,
      settingKey,
      enabled: normalized,
      error: String(error?.message || error)
    });
    return false;
  }
}

export async function getPremiumEntitlementSnapshotOverride() {
  const bridge = await loadPremiumRuntimeBridge();
  if (typeof bridge?.getPremiumEntitlementSnapshotOverride !== 'function') return null;
  try {
    return bridge.getPremiumEntitlementSnapshotOverride({ moduleId: RUNTIME_STATE.moduleId });
  } catch (_) {
    return null;
  }
}

export async function shouldWarmPremiumWithoutAuth() {
  const bridge = await loadPremiumRuntimeBridge();
  if (typeof bridge?.shouldWarmPremiumWithoutAuth !== 'function') return false;
  try {
    return bridge.shouldWarmPremiumWithoutAuth({ moduleId: RUNTIME_STATE.moduleId }) === true;
  } catch (_) {
    return false;
  }
}

export function getPremiumHeaderBadge() {
  const bridge = getLoadedPremiumRuntimeBridge();
  if (typeof bridge?.getPremiumHeaderBadge !== 'function') return null;
  try {
    return bridge.getPremiumHeaderBadge({ moduleId: RUNTIME_STATE.moduleId });
  } catch (_) {
    return null;
  }
}

export function shouldRefreshPremiumHeaderForSetting(setting) {
  if (!setting || setting.namespace !== RUNTIME_STATE.moduleId) return false;
  if (setting.key === PREMIUM_AUTH_SETTING) return true;
  const bridge = getLoadedPremiumRuntimeBridge();
  if (typeof bridge?.shouldRefreshPremiumHeaderForSetting !== 'function') return false;
  try {
    return bridge.shouldRefreshPremiumHeaderForSetting(setting, {
      moduleId: RUNTIME_STATE.moduleId,
      authSetting: PREMIUM_AUTH_SETTING
    }) === true;
  } catch (_) {
    return false;
  }
}

export function handlePremiumRuntimeSettingChange(setting, { clear } = {}) {
  if (!setting || setting.namespace !== RUNTIME_STATE.moduleId) return false;
  if (setting.key === PREMIUM_AUTH_SETTING) {
    const value = setting.value ?? setting._source?.value ?? null;
    if (!value && typeof clear === 'function') {
      clear({ silent: true, reason: 'settings-update' });
    }
    return true;
  }
  const bridge = getLoadedPremiumRuntimeBridge();
  if (typeof bridge?.handlePremiumRuntimeSettingChange !== 'function') return false;
  try {
    return bridge.handlePremiumRuntimeSettingChange(setting, {
      moduleId: RUNTIME_STATE.moduleId,
      authSetting: PREMIUM_AUTH_SETTING,
      clear
    }) === true;
  } catch (_) {
    return false;
  }
}

void loadPremiumRuntimeBridge();
