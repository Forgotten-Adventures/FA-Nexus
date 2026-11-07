import { onFoundryBoot } from '../core/foundry-boot-hooks.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

const PATCHED_SYMBOL = Symbol.for('fa-nexus.activeSessionLevelSwitchGuard.patched');
const ORIGINAL_SCENE_VIEW_KEY = '_faNexusOriginalSceneView';
const BLOCKED_MESSAGE = 'Finish or cancel the active FA Nexus session before switching levels.';
const BLOCKED_ELEVATION_MESSAGE = "Finish or cancel the active FA Nexus session before changing the current Level's elevation range.";
const BLOCKED_SCENE_MESSAGE = 'Finish or cancel the active FA Nexus session before switching Scenes: its uncommitted work would be lost.';
// Leaving the Scene ends every session. An editor that holds uncommitted work
// is finished or cancelled first; placing assets holds none and just ends.
const WORK_HOLDING_SESSION_IDS = new Set(['path-editor', 'texture-editor', 'building-editor']);

function stringifyError(error) {
  return String(error?.message || error);
}

function normalizeId(value) {
  if (value && typeof value === 'object' && typeof value.id === 'string') return String(value.id).trim();
  return String(value ?? '').trim();
}

function getFaNexusAppInstance() {
  try {
    return foundry?.applications?.instances?.get?.('fa-nexus-app') || null;
  } catch (error) {
    Logger.warn?.('LevelSwitchGuard.app.lookupFailed', { error: stringifyError(error) });
    return null;
  }
}

function getFaNexusTabs() {
  const app = getFaNexusAppInstance();
  try {
    return app?._tabManager?.getTabs?.() || null;
  } catch (error) {
    Logger.warn?.('LevelSwitchGuard.tabs.lookupFailed', { error: stringifyError(error) });
    return null;
  }
}

function isManagerActive(manager, activeProperty = 'isActive') {
  try {
    return !!manager?.[activeProperty];
  } catch (error) {
    Logger.warn?.('LevelSwitchGuard.manager.inspectFailed', {
      activeProperty,
      error: stringifyError(error)
    });
    return false;
  }
}

function pushActiveBlocker(blockers, id, label, manager, activeProperty = 'isActive') {
  if (!manager || !isManagerActive(manager, activeProperty)) return;
  blockers.push({ id, label });
}

function getControllerManager(tab, key) {
  try {
    return tab?._controller?.[key] || tab?.[`_${key}`] || null;
  } catch (error) {
    Logger.warn?.('LevelSwitchGuard.manager.lookupFailed', { key, error: stringifyError(error) });
    return null;
  }
}

function collectActiveFaNexusSessionBlockers() {
  const blockers = [];
  const tabs = getFaNexusTabs();

  const assetPlacement = tabs?.assets?.placementManager
    || getControllerManager(tabs?.assets, 'placement')
    || tabs?.assets?._placement
    || null;
  pushActiveBlocker(blockers, 'asset-placement', 'Asset Placement', assetPlacement, 'isPlacementActive');

  const pathManager = tabs?.paths?.pathManagerV2
    || getControllerManager(tabs?.paths, 'pathManagerV2')
    || tabs?.paths?._pathManagerV2
    || null;
  pushActiveBlocker(blockers, 'path-editor', 'Path Editor', pathManager);

  const textureManager = tabs?.textures?.texturePaintManager
    || getControllerManager(tabs?.textures, 'texturePaint')
    || tabs?.textures?._texturePaint
    || null;
  pushActiveBlocker(blockers, 'texture-editor', 'Texture Editor', textureManager);

  const buildingManager = tabs?.buildings?._buildingManager
    || globalThis?.faNexus?.premiumFeatures?.buildingEditor?.activeManager
    || null;
  pushActiveBlocker(blockers, 'building-editor', 'Building Editor', buildingManager);

  return blockers;
}

function getCurrentSceneLevelId() {
  return normalizeId(canvas?.level?.id || canvas?.scene?._view || '');
}

function shouldBlockSceneViewLevelSwitch(scene, options = {}) {
  if (!options || !Object.prototype.hasOwnProperty.call(options, 'level')) return null;
  const targetSceneId = normalizeId(scene?.id);
  const currentSceneId = normalizeId(canvas?.scene?.id);
  if (!targetSceneId || targetSceneId !== currentSceneId) return null;

  const targetLevelId = normalizeId(options.level);
  const currentLevelId = getCurrentSceneLevelId();
  if (!targetLevelId || targetLevelId === currentLevelId) return null;

  const blockers = collectActiveFaNexusSessionBlockers();
  if (!blockers.length) return null;

  return {
    blockers,
    sceneId: targetSceneId,
    sceneName: scene?.name || null,
    currentLevelId,
    targetLevelId
  };
}

function shouldBlockSceneSwitch(scene) {
  const targetSceneId = normalizeId(scene?.id);
  const currentSceneId = normalizeId(canvas?.scene?.id);
  if (!targetSceneId || !currentSceneId || targetSceneId === currentSceneId) return null;
  const blockers = collectActiveFaNexusSessionBlockers().filter((blocker) => WORK_HOLDING_SESSION_IDS.has(blocker.id));
  if (!blockers.length) return null;
  return { blockers, sceneId: targetSceneId, sceneName: scene?.name || null, currentSceneId };
}

function notifyBlockedSceneSwitch(details) {
  Logger.warn?.('LevelSwitchGuard.blockedSceneSwitch', details);
  ui?.notifications?.warn?.(BLOCKED_SCENE_MESSAGE);
}

function notifyBlockedLevelSwitch(details) {
  Logger.warn?.('LevelSwitchGuard.blockedActiveSession', details);
  try {
    ui?.notifications?.warn?.(BLOCKED_MESSAGE);
  } catch (error) {
    Logger.warn?.('LevelSwitchGuard.notification.failed', { error: stringifyError(error) });
  }
}

function guardActiveLevelElevationUpdate(level, changes) {
  if (level?.parent?.id !== canvas?.scene?.id || level?.id !== getCurrentSceneLevelId()) return true;
  const flat = foundry.utils.flattenObject(changes);
  const source = level.toObject().elevation;
  if (!['bottom', 'top'].some(key => Object.prototype.hasOwnProperty.call(flat, `elevation.${key}`)
    && !Object.is(flat[`elevation.${key}`], source[key]))) return true;
  const blockers = collectActiveFaNexusSessionBlockers();
  if (!blockers.length) return true;
  Logger.warn('LevelSwitchGuard.blockedActiveLevelElevation', { sceneId: level.parent.id, levelId: level.id, blockers });
  ui.notifications.warn(BLOCKED_ELEVATION_MESSAGE);
  return false;
}

function resolveScenePrototype() {
  try {
    const configured = globalThis?.CONFIG?.Scene?.documentClass?.prototype;
    if (configured?.view) return configured;
  } catch (error) {
    Logger.warn?.('LevelSwitchGuard.prototype.configLookupFailed', { error: stringifyError(error) });
  }
  try {
    const globalScene = globalThis?.Scene?.prototype;
    if (globalScene?.view) return globalScene;
  } catch (error) {
    Logger.warn?.('LevelSwitchGuard.prototype.globalLookupFailed', { error: stringifyError(error) });
  }
  try {
    const currentScene = globalThis?.canvas?.scene;
    const proto = currentScene ? Object.getPrototypeOf(currentScene) : null;
    if (proto?.view) return proto;
  } catch (error) {
    Logger.warn?.('LevelSwitchGuard.prototype.canvasLookupFailed', { error: stringifyError(error) });
  }
  return null;
}

function installActiveSessionLevelSwitchGuard() {
  try {
    const prototype = resolveScenePrototype();
    if (!prototype || typeof prototype.view !== 'function') return false;
    if (prototype[PATCHED_SYMBOL]) return true;

    const originalView = prototype.view;
    prototype[ORIGINAL_SCENE_VIEW_KEY] = originalView;
    prototype.view = async function faNexusGuardedSceneView(options = {}) {
      const blockDetails = shouldBlockSceneViewLevelSwitch(this, options);
      if (blockDetails) {
        notifyBlockedLevelSwitch(blockDetails);
        return this;
      }
      const sceneBlock = shouldBlockSceneSwitch(this);
      if (sceneBlock) {
        notifyBlockedSceneSwitch(sceneBlock);
        return this;
      }
      return originalView.call(this, options);
    };
    prototype[PATCHED_SYMBOL] = true;

    globalThis.faNexus = Object.assign(globalThis.faNexus || {}, {
      collectActiveSessionLevelSwitchBlockers: collectActiveFaNexusSessionBlockers
    });

    Logger.debug?.('LevelSwitchGuard.patch.installed');
    return true;
  } catch (error) {
    Logger.error?.('LevelSwitchGuard.patch.failed', { error: stringifyError(error) });
    return false;
  }
}

try {
  Hooks.on('preUpdateLevel', guardActiveLevelElevationUpdate);
  installActiveSessionLevelSwitchGuard();
  onFoundryBoot('ready', () => {
    if (!installActiveSessionLevelSwitchGuard()) {
      Logger.error?.('LevelSwitchGuard.patch.unavailable', {
        reason: 'Scene.prototype.view missing during ready'
      });
    }
  });
} catch (error) {
  Logger.error?.('LevelSwitchGuard.register.failed', { error: stringifyError(error) });
}

export {
  collectActiveFaNexusSessionBlockers,
  installActiveSessionLevelSwitchGuard
};
