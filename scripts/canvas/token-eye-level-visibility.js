import { NexusLogger as Logger } from '../core/nexus-logger.js';

const MODULE_ID = 'fa-nexus';
const EYE_LEVEL_HEIGHT_FLAG = 'eyeLevelHeightFt';
const OVERWRITE_EYE_LEVEL_SETTING = 'overwriteEyeLevel';
const PATCHED_KEY = Symbol.for('fa-nexus.TokenDocument.eyeLevelVisibility.patched');
const ORIGINAL_GET_VISION_ORIGIN_KEY = Symbol.for('fa-nexus.TokenDocument.eyeLevelVisibility.originalGetVisionOrigin');
const ORIGINAL_GET_VISIBILITY_TEST_POINTS_KEY = Symbol.for('fa-nexus.TokenDocument.eyeLevelVisibility.originalGetVisibilityTestPoints');

export const TOKEN_EYE_LEVEL_HEIGHT_FLAG_PATH = `flags.${MODULE_ID}.${EYE_LEVEL_HEIGHT_FLAG}`;

function resolveTokenDocumentPrototype() {
  const TokenDocumentClass = globalThis?.CONFIG?.Token?.documentClass ?? globalThis?.TokenDocument;
  const prototype = TokenDocumentClass?.prototype;
  if (!prototype) throw new Error('TokenDocument prototype is unavailable');
  if (typeof prototype.getVisionOrigin !== 'function') throw new Error('TokenDocument#getVisionOrigin is unavailable');
  if (typeof prototype.getVisibilityTestPoints !== 'function') {
    throw new Error('TokenDocument#getVisibilityTestPoints is unavailable');
  }
  return prototype;
}

function resolveGridDistance(tokenDocument) {
  const grid = tokenDocument?.parent?.grid ?? globalThis?.BaseScene?.defaultGrid;
  const distance = Number(grid?.distance);
  if (!Number.isFinite(distance) || distance <= 0) {
    throw new Error(`Invalid token visibility grid distance: ${grid?.distance}`);
  }
  return distance;
}

function isOverwriteEyeLevelEnabled() {
  try {
    if (!globalThis?.game?.settings?.get) return false;
    return globalThis.game.settings.get(MODULE_ID, OVERWRITE_EYE_LEVEL_SETTING) === true;
  } catch (error) {
    Logger.error('TokenEyeLevelVisibility.settingRead.failed', {
      setting: OVERWRITE_EYE_LEVEL_SETTING,
      error: String(error?.message || error)
    });
    throw error;
  }
}

function getRawEyeLevelHeight(tokenDocument) {
  try {
    if (typeof tokenDocument?.getFlag === 'function') {
      const value = tokenDocument.getFlag(MODULE_ID, EYE_LEVEL_HEIGHT_FLAG);
      if (value !== undefined) return value;
    }
  } catch (error) {
    Logger.error('TokenEyeLevelVisibility.flagRead.failed', {
      tokenId: tokenDocument?.id || null,
      tokenName: tokenDocument?.name || null,
      error: String(error?.message || error)
    });
    throw error;
  }
  return tokenDocument?._source?.flags?.[MODULE_ID]?.[EYE_LEVEL_HEIGHT_FLAG]
    ?? tokenDocument?.flags?.[MODULE_ID]?.[EYE_LEVEL_HEIGHT_FLAG];
}

export function getConfiguredTokenEyeLevelHeight(tokenDocument) {
  const raw = getRawEyeLevelHeight(tokenDocument);
  if ((raw === undefined) || (raw === null) || (raw === '')) return null;
  const height = Number(raw);
  if (!Number.isFinite(height) || height < 0) {
    throw new Error(`Invalid token eye level height flag: ${raw}`);
  }
  return height;
}

function logRuntimeFailure(action, tokenDocument, error) {
  Logger.error(`TokenEyeLevelVisibility.${action}.failed`, {
    tokenId: tokenDocument?.id || null,
    tokenName: tokenDocument?.name || null,
    sceneId: tokenDocument?.parent?.id || null,
    elevation: tokenDocument?.elevation ?? null,
    depth: tokenDocument?.depth ?? null,
    error: String(error?.message || error)
  });
}

export function getTokenVisibilityEyeElevation(tokenDocument, data = {}) {
  const eyeLevelHeight = getConfiguredTokenEyeLevelHeight(tokenDocument);
  const elevation = Number(data.elevation ?? tokenDocument?.elevation);
  if (!Number.isFinite(elevation)) {
    throw new Error(`Invalid token visibility elevation: ${data.elevation ?? tokenDocument?.elevation}`);
  }
  if (eyeLevelHeight !== null) return elevation + eyeLevelHeight;
  if (!isOverwriteEyeLevelEnabled()) return null;
  const depth = Number(data.depth ?? tokenDocument?.depth);
  if (!Number.isFinite(depth) || depth < 0) {
    throw new Error(`Invalid token visibility depth: ${data.depth ?? tokenDocument?.depth}`);
  }
  return elevation + (depth * resolveGridDistance(tokenDocument));
}

function getDefaultEyeLevelPlaceholder(tokenDocument) {
  const depth = Number(tokenDocument?.depth ?? tokenDocument?._source?.depth);
  if (!Number.isFinite(depth) || depth < 0) return '';
  try {
    const multiplier = isOverwriteEyeLevelEnabled() ? 1 : 0.5;
    return String(Math.round((depth * resolveGridDistance(tokenDocument) * multiplier) * 100) / 100);
  } catch (error) {
    Logger.error('TokenEyeLevelVisibility.config.placeholderFailed', {
      tokenId: tokenDocument?.id || null,
      tokenName: tokenDocument?.name || null,
      error: String(error?.message || error)
    });
    return '';
  }
}

function getTokenConfigEyeLevelValue(app) {
  try {
    const raw = getRawEyeLevelHeight(app?.token ?? app?.document);
    if ((raw === undefined) || (raw === null) || (raw === '')) return '';
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && (numeric >= 0)) return String(numeric);
    Logger.error('TokenEyeLevelVisibility.config.invalidStoredValue', {
      appId: app?.id || null,
      value: raw
    });
    return String(raw);
  } catch (error) {
    Logger.error('TokenEyeLevelVisibility.config.valueReadFailed', {
      appId: app?.id || null,
      error: String(error?.message || error)
    });
    return '';
  }
}

function injectTokenConfigEyeLevelField(app, element) {
  try {
    const root = element instanceof HTMLElement ? element : element?.[0];
    const visionTab = root?.querySelector?.('.tab[data-tab="vision"]');
    if (!visionTab || visionTab.querySelector('[data-fa-nexus-eye-level-height]')) return;

    const rangeInput = visionTab.querySelector('input[name="sight.range"]');
    const anchor = rangeInput?.closest?.('.form-group');
    if (!anchor) throw new Error('Unable to locate Token Config sight range field');

    const token = app?.token ?? app?.document;
    const gridUnits = token?.parent?.grid?.units || globalThis?.canvas?.scene?.grid?.units || 'ft';
    const rootId = app?.id || 'fa-nexus-token-config';
    const id = `${rootId}-fa-nexus-eye-level-height`;

    const group = document.createElement('div');
    group.className = 'form-group slim fa-nexus-eye-level-height';
    group.dataset.faNexusEyeLevelHeight = '1';

    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = 'Eye Level Height ';
    const units = document.createElement('span');
    units.className = 'units';
    units.textContent = `(${gridUnits})`;
    label.appendChild(units);

    const fields = document.createElement('div');
    fields.className = 'form-fields';

    const input = document.createElement('input');
    input.type = 'number';
    input.name = TOKEN_EYE_LEVEL_HEIGHT_FLAG_PATH;
    input.id = id;
    input.min = '0';
    input.step = '0.01';
    input.dataset.dtype = 'Number';
    input.className = 'placeholder-fa-solid';
    input.placeholder = getDefaultEyeLevelPlaceholder(token);
    input.value = getTokenConfigEyeLevelValue(app);
    fields.appendChild(input);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Height above token elevation used for this token\'s vision origin and visibility test points. Leave blank to use the module setting or Foundry default.';

    group.append(label, fields, hint);
    anchor.after(group);
  } catch (error) {
    Logger.error('TokenEyeLevelVisibility.config.injectFailed', {
      appId: app?.id || null,
      error: String(error?.message || error)
    });
  }
}

function tokenEyeLevelChanged(changes = {}) {
  const utils = globalThis?.foundry?.utils;
  if (utils?.hasProperty?.(changes, TOKEN_EYE_LEVEL_HEIGHT_FLAG_PATH)) return true;
  if (Object.prototype.hasOwnProperty.call(changes, TOKEN_EYE_LEVEL_HEIGHT_FLAG_PATH)) return true;
  const moduleFlags = changes?.flags?.[MODULE_ID] || {};
  return Object.prototype.hasOwnProperty.call(moduleFlags, EYE_LEVEL_HEIGHT_FLAG)
    || Object.prototype.hasOwnProperty.call(moduleFlags, `-=${EYE_LEVEL_HEIGHT_FLAG}`);
}

function refreshTokenVisionForEyeLevelChange(tokenDocument) {
  try {
    tokenDocument?.object?.initializeSources?.();
    globalThis?.canvas?.perception?.update?.({ refreshVision: true });
  } catch (error) {
    Logger.error('TokenEyeLevelVisibility.refresh.failed', {
      tokenId: tokenDocument?.id || null,
      tokenName: tokenDocument?.name || null,
      error: String(error?.message || error)
    });
    throw error;
  }
}

function refreshAllTokenVisionForEyeLevelChange() {
  try {
    for (const token of globalThis?.canvas?.tokens?.placeables || []) {
      token?.initializeSources?.();
    }
    globalThis?.canvas?.perception?.update?.({ refreshVision: true });
  } catch (error) {
    Logger.error('TokenEyeLevelVisibility.refreshAll.failed', {
      error: String(error?.message || error)
    });
    throw error;
  }
}

export function installTokenEyeLevelVisibilityPatch({ phase = 'manual', required = false } = {}) {
  try {
    const prototype = resolveTokenDocumentPrototype();
    if (prototype[PATCHED_KEY]) return true;

    const originalGetVisionOrigin = prototype.getVisionOrigin;
    const originalGetVisibilityTestPoints = prototype.getVisibilityTestPoints;

    prototype.getVisionOrigin = function faNexusGetEyeLevelVisionOrigin(data = {}) {
      const origin = originalGetVisionOrigin.call(this, data);
      if (!origin || typeof origin !== 'object') {
        throw new Error('TokenDocument#getVisionOrigin did not return a point');
      }
      try {
        const elevation = getTokenVisibilityEyeElevation(this, data);
        if (elevation !== null) origin.elevation = elevation;
      } catch (error) {
        logRuntimeFailure('visionOrigin', this, error);
        throw error;
      }
      return origin;
    };

    prototype.getVisibilityTestPoints = function faNexusGetEyeLevelVisibilityTestPoints(data = {}) {
      const points = originalGetVisibilityTestPoints.call(this, data);
      if (!Array.isArray(points)) {
        throw new Error('TokenDocument#getVisibilityTestPoints did not return an array');
      }
      let elevation;
      try {
        elevation = getTokenVisibilityEyeElevation(this, data);
      } catch (error) {
        logRuntimeFailure('visibilityTestPoints', this, error);
        throw error;
      }
      if (elevation === null) return points;
      for (const point of points) {
        if (!point || typeof point !== 'object') {
          throw new Error('TokenDocument#getVisibilityTestPoints returned a non-point entry');
        }
        point.elevation = elevation;
      }
      return points;
    };

    prototype[ORIGINAL_GET_VISION_ORIGIN_KEY] = originalGetVisionOrigin;
    prototype[ORIGINAL_GET_VISIBILITY_TEST_POINTS_KEY] = originalGetVisibilityTestPoints;
    prototype[PATCHED_KEY] = true;
    Logger.info('TokenEyeLevelVisibility.patchInstalled', {
      phase,
      flagPath: TOKEN_EYE_LEVEL_HEIGHT_FLAG_PATH
    });
    return true;
  } catch (error) {
    const payload = { phase, error: String(error?.message || error) };
    if (required) Logger.error('TokenEyeLevelVisibility.patchFailed', payload);
    else Logger.warn('TokenEyeLevelVisibility.patchDeferred', payload);
    return false;
  }
}

try {
  Hooks.on('renderTokenConfig', injectTokenConfigEyeLevelField);
  Hooks.on('renderPrototypeTokenConfig', injectTokenConfigEyeLevelField);
  Hooks.on('updateToken', (tokenDocument, changes) => {
    if (tokenEyeLevelChanged(changes)) refreshTokenVisionForEyeLevelChange(tokenDocument);
  });
  Hooks.on('fa-nexus-overwrite-eye-level-changed', refreshAllTokenVisionForEyeLevelChange);
  Hooks.once('init', () => installTokenEyeLevelVisibilityPatch({ phase: 'init' }));
  Hooks.once('ready', () => installTokenEyeLevelVisibilityPatch({ phase: 'ready', required: true }));
} catch (error) {
  Logger.error('TokenEyeLevelVisibility.hookRegistrationFailed', {
    error: String(error?.message || error)
  });
}
