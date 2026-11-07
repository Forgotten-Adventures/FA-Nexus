const MODULE_ID = 'fa-nexus';
const BOOT_STORAGE_PREFIX = `${MODULE_ID}.featureArea.`;

export const FEATURE_AREA_SETTINGS = Object.freeze({
  tokens: 'tokensEnabled',
  mapmaking: 'mapmakingEnabled',
  sceneGroups: 'sceneGroupsEnabled',
  prefabs: 'prefabsEnabled'
});

function getFeatureAreaSettingKey(area) {
  const key = FEATURE_AREA_SETTINGS[area];
  if (!key) throw new Error(`Unknown FA Nexus feature area: ${area}`);
  return key;
}

function parseStoredBoolean(value) {
  if (value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  return null;
}

export function writeFeatureAreaBootstrapValue(area, enabled) {
  getFeatureAreaSettingKey(area);
  try {
    globalThis.localStorage?.setItem?.(`${BOOT_STORAGE_PREFIX}${area}`, enabled === false ? 'false' : 'true');
  } catch (error) {
    console.warn('fa-nexus | feature area bootstrap write failed', { area, error });
  }
}

export function isFeatureAreaEnabled(area) {
  const key = getFeatureAreaSettingKey(area);
  try {
    const bootstrapValue = parseStoredBoolean(globalThis.localStorage?.getItem?.(`${BOOT_STORAGE_PREFIX}${area}`));
    if (bootstrapValue != null) return bootstrapValue;
  } catch (error) {
    console.warn('fa-nexus | feature area bootstrap read failed', { area, error });
  }
  const settings = globalThis.game?.settings;
  const stored = settings?.storage?.get?.('world')?.getSetting?.(`${MODULE_ID}.${key}`, null);
  const storedValue = parseStoredBoolean(stored?._source?.value ?? stored?.value);
  if (storedValue != null) return storedValue;
  if (!settings?.settings?.has?.(`${MODULE_ID}.${key}`)) return true;
  return settings.get(MODULE_ID, key) !== false;
}

export const isTokensEnabled = () => isFeatureAreaEnabled('tokens');
export const isMapmakingEnabled = () => isFeatureAreaEnabled('mapmaking');
// Scene Groups and Prefabs are parts of Mapmaking, and a Prefab is saved from and placed as a Scene Group.
// Switched off, only their interface goes: Buildings, Paths, Flatten and Undo keep using the composition registry.
export const isSceneGroupsEnabled = () => isMapmakingEnabled() && isFeatureAreaEnabled('sceneGroups');
export const isPrefabsEnabled = () => isSceneGroupsEnabled() && isFeatureAreaEnabled('prefabs');
