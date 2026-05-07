export const MODULE_ID = 'fa-nexus';
export const SETTING_ACTIVE_SUBTAB = 'buildingsActiveSubtab';
export const SETTING_SEARCH_STATE = 'buildingsSubtabSearch';
export const BUILDING_TEXTURE_BOOKMARK_TAB = 'buildings:textures';
export const BUILDING_TEXTURE_THUMB_SETTING = 'thumbWidthBuildingTextures';
export const DEFAULT_SUBTAB = 'building';
export const SUBTABS = Object.freeze(['building', 'portals']);
export const SUBTAB_LABELS = Object.freeze({
  building: 'Walls',
  portals: 'Portals'
});
export const PORTAL_TYPES = Object.freeze({
  door: { id: 'door', label: 'Add Door', icon: 'fa-door-closed', tooltip: 'Insert animated Foundry doors' },
  window: { id: 'window', label: 'Add Window', icon: 'fa-border-all', tooltip: 'Insert windows with sill, glass, and frame' },
  gap: { id: 'gap', label: 'Add Gap', icon: 'fa-expand', tooltip: 'Insert gaps in walls' }
});
export const GAP_KIND_GAP = 'gap';
export const GAP_KIND_DOOR = 'door';
export const GAP_KIND_WINDOW = 'window';
export const WALL_BIAS_QUERY = 'wall';
export const TEXTURE_DEPRIORITIZED_PATH_TOKEN = '!wilderness';
export const TEXTURE_DEPRIORITIZED_NAME_TOKENS = Object.freeze(['roof', 'grate', 'overlay']);
export const WALL_SEGMENT_TOKENS = Object.freeze(['wall', 'walls']);
export const WALL_SEGMENT_PATTERN = /^walls?(?![_-]?hangings)/;
export const NONE_TEXTURE_KEY = '__fa-nexus__/fill-none';
export const NONE_TEXTURE_ITEM = Object.freeze({
  id: '__fa-nexus-building-fill-none',
  file_path: NONE_TEXTURE_KEY,
  path: NONE_TEXTURE_KEY,
  filename: 'None',
  displayName: 'No Fill',
  source: 'local',
  tier: 'free',
  isNoneTexture: true
});
export const PORTAL_TEXTURE_MISSING_RETRY_MS = 15000;
