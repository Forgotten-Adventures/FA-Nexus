import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { isProTierRefusal, proTierMessage } from '../premium/session-host/auth-state.js';
import { TileFlattenManager } from '../flatten/flatten-manager.js';
import { getFaNexusTileCapabilities } from './tile-capabilities.js';
import { getTileExplicitPlacementLevelId } from './tile-band-utils.js';
import { resolveTileDocument as resolveSharedTileDocument } from './tile-targets.js';
import { hasStandardMaskCustomBaseSource } from '../textures/standard-mask-custom-base.js';
import { resolveBuildingGeneratedDocumentOwner, createBuildingGeneratedDocumentEditorOptions,
  formatBuildingGeneratedDocumentOwnershipExplanation } from '../buildings/building-generated-document-runtime.js';

const BUTTON_ACTION = 'fa-nexus-edit';
const FLATTENED_PICTURE_EDIT_REFUSAL = 'A flattened picture has no editor of its own. Use Apply Mask to hide parts of it, or Deconstruct to get its layers back.';
const MASK_BUTTON_ACTION = 'fa-nexus-mask';
const FLATTEN_ACTION = 'fa-nexus-flatten';
const DECONSTRUCT_ACTION = 'fa-nexus-deconstruct';
const STANDARD_TILE_MASK_HUD_ENABLED = true;
const PARENT_LEVEL_SWITCH_TIMEOUT_MS = 15000;

let _tileFlattenManager = null;

function getTileFlattenManager() {
  if (!_tileFlattenManager) _tileFlattenManager = new TileFlattenManager();
  return _tileFlattenManager;
}

function resolveTileDocument(hud) {
  try {
    if (!hud) return null;
    return resolveSharedTileDocument(hud?.object || hud?.document || hud) || null;
  } catch (error) {
    Logger.warn('TileHud.resolveDocument.failed', { error: String(error?.message || error) });
    return null;
  }
}

function getEditorButtonLabel(mode, { canLaunch = true } = {}) {
  if (!canLaunch && mode === 'paths') return 'Legacy Path Requires Migration';
  return mode === 'paths'
    ? 'Edit Path in FA Nexus'
    : mode === 'buildings'
      ? 'Edit Building in FA Nexus'
      : mode === 'textures'
        ? 'Edit Mask in FA Nexus'
        : 'Edit Asset in FA Nexus';
}

function getTileEditorState(doc) {
  const ownership = resolveBuildingGeneratedDocumentOwner({ scene: doc?.parent, document: doc });
  const capabilities = getFaNexusTileCapabilities(ownership?.ownerDocument || doc);
  if (ownership && !ownership.ownerDocument) return {
    mode: 'buildings', canLaunch: false, capabilities,
    label: getEditorButtonLabel('buildings'),
    tooltip: formatBuildingGeneratedDocumentOwnershipExplanation(ownership),
    errorMessage: `${formatBuildingGeneratedDocumentOwnershipExplanation(ownership)} The owning Tile is unavailable.`,
    reasonCode: 'building-owner-missing'
  };
  const mode = capabilities?.editMode || null;
  if (!mode && capabilities?.hasFlattened) {
    return {
      mode: null,
      canLaunch: false,
      capabilities,
      label: null,
      tooltip: null,
      errorMessage: FLATTENED_PICTURE_EDIT_REFUSAL,
      reasonCode: 'flattened-picture'
    };
  }
  if (!mode) {
    return {
      mode: null,
      canLaunch: false,
      capabilities,
      label: null,
      tooltip: null,
      errorMessage: 'This tile does not support FA Nexus editing.',
      reasonCode: 'unsupported-tile'
    };
  }

  if (capabilities.requiresLegacyPathMigration) {
    return {
      mode,
      canLaunch: false,
      capabilities,
      label: getEditorButtonLabel(mode, { canLaunch: false }),
      tooltip: 'Legacy FA Nexus path tiles must be migrated to v2 before editing in Foundry v14.',
      errorMessage: 'Legacy FA Nexus path tiles must be migrated to v2 before editing in Foundry v14.',
      reasonCode: 'legacy-path-migration-required'
    };
  }

  const label = getEditorButtonLabel(mode);
  return {
    mode,
    canLaunch: true,
    capabilities,
    label,
    tooltip: label,
    errorMessage: null,
    reasonCode: null
  };
}

export function getFaNexusTileEditMode(doc) {
  const state = getTileEditorState(doc);
  return state.canLaunch ? state.mode : null;
}

/** Why "Nexus Edit" is not offered for a Tile that the user may well expect to edit, or null. For menus. */
export function getFaNexusTileEditRefusal(doc) {
  const state = getTileEditorState(doc);
  return state.reasonCode === 'flattened-picture' ? { reasonCode: state.reasonCode, message: state.errorMessage } : null;
}

function resolveHudElement(hud, payload) {
  if (payload) {
    if (payload instanceof HTMLElement) return payload;
    if (payload.element instanceof HTMLElement) return payload.element;
    if (Array.isArray(payload) && payload[0] instanceof HTMLElement) return payload[0];
    if (payload.jquery && payload[0] instanceof HTMLElement) return payload[0];
  }
  if (hud?.element instanceof HTMLElement) return hud.element;
  if (hud?.element?.[0] instanceof HTMLElement) return hud.element[0];
  return null;
}

function ensureButton(root, editorState) {
  if (!root) return null;
  const column = root.querySelector('.col.right');
  if (!column) return null;
  let button = column.querySelector(`button[data-action="${BUTTON_ACTION}"]`);
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'control-icon fa-nexus-edit';
    button.dataset.action = BUTTON_ACTION;
    column.appendChild(button);
  }
  const mode = editorState?.mode || '';
  const canLaunch = editorState?.canLaunch !== false;
  const label = editorState?.label || getEditorButtonLabel(mode, { canLaunch });
  const tooltip = editorState?.tooltip || label;
  const iconClass = canLaunch
    ? (mode === 'textures' ? 'fas fa-mask' : 'fas fa-pen')
    : 'fas fa-triangle-exclamation';
  button.innerHTML = `<i class="${iconClass}"></i>`;
  button.dataset.mode = mode;
  button.dataset.tooltip = tooltip;
  button.dataset.launchable = String(canLaunch);
  button.setAttribute('aria-label', label);
  button.title = tooltip;
  return button;
}

export function canLaunchFaNexusTileMask(doc) {
  try {
    if (!STANDARD_TILE_MASK_HUD_ENABLED) return false;
    if (!doc) return false;
    if (resolveBuildingGeneratedDocumentOwner({ scene: doc.parent, document: doc })) return false;
    const capabilities = getFaNexusTileCapabilities(doc);
    if (capabilities.hasMaskedTiling) return false;
    if (capabilities.hasVideoTexture) return false;
    const hasCustomBase = hasStandardMaskCustomBaseSource(doc);
    if (capabilities.hasLegacyPath && !capabilities.hasPathV2 && !capabilities.hasPathsV2) return false;
    return !!(capabilities.hasImageTexture || capabilities.hasFlattened || hasCustomBase);
  } catch (_) {
    return false;
  }
}

function shouldShowStandardMaskButton(doc) {
  return canLaunchFaNexusTileMask(doc);
}

function isFaNexusFlattenedTile(doc) {
  return !!getFaNexusTileCapabilities(doc)?.hasFlattened;
}

function ensureStandardMaskButton(root, doc) {
  const column = root?.querySelector?.('.col.right') || null;
  const existing = column?.querySelector?.(`button[data-action="${MASK_BUTTON_ACTION}"]`) || null;
  if (!column || !shouldShowStandardMaskButton(doc)) {
    if (existing) existing.remove();
    return null;
  }
  let button = existing;
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'control-icon fa-nexus-mask';
    button.dataset.action = MASK_BUTTON_ACTION;
    button.innerHTML = '<i class="fas fa-mask"></i>';
    column.appendChild(button);
  }
  const hasMask = !!doc?.getFlag?.('fa-nexus', 'standardTileMask');
  const label = hasMask ? 'Edit Mask in FA Nexus' : 'Mask Tile in FA Nexus';
  button.dataset.tooltip = label;
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

function ensureFlattenButton(root, count, allowSingleMerged) {
  const column = root?.querySelector?.('.col.right') || null;
  const existing = column?.querySelector?.(`button[data-action="${FLATTEN_ACTION}"]`) || null;

  if (!column || count < 1) {
    if (existing) existing.remove();
    return null;
  }

  let button = existing;
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'control-icon fa-nexus-flatten';
    button.dataset.action = FLATTEN_ACTION;
    button.innerHTML = '<i class="fas fa-compress-arrows-alt"></i>';
    column.appendChild(button);
  }

  const label = count > 1
    ? `Flatten ${count} selected tile${count === 1 ? '' : 's'} in FA Nexus`
    : (allowSingleMerged ? 'Flatten merged tile in FA Nexus' : 'Flatten selected tile in FA Nexus');
  button.dataset.count = String(count);
  button.dataset.tooltip = label;
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

function ensureDeconstructButton(root, doc) {
  const column = root?.querySelector?.('.col.right') || null;
  const existing = column?.querySelector?.(`button[data-action="${DECONSTRUCT_ACTION}"]`) || null;
  const isFlattened = isFaNexusFlattenedTile(doc);

  if (!column || !doc || !isFlattened) {
    if (existing) existing.remove();
    return null;
  }

  let button = existing;
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'control-icon fa-nexus-deconstruct';
    button.dataset.action = DECONSTRUCT_ACTION;
    button.innerHTML = '<i class="fas fa-object-ungroup"></i>';
    column.appendChild(button);
  }

  let metadata = null;
  try { metadata = doc.getFlag?.('fa-nexus', 'flattened'); } catch (_) {}
  const tileCount = Number(metadata?.originalTileCount ?? metadata?.tiles?.length ?? 0) || 0;
  const label = tileCount
    ? `Deconstruct into ${tileCount} tile${tileCount === 1 ? '' : 's'} in FA Nexus`
    : 'Deconstruct flattened tiles in FA Nexus';
  button.dataset.count = tileCount ? String(tileCount) : '';
  button.dataset.tooltip = label;
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

function worldToScreen(point) {
  try {
    if (!point || !canvas?.stage) return null;
    const stagePoint = canvas.stage.worldTransform.apply(new PIXI.Point(point.x, point.y));
    const canvasEl = canvas.app?.view || document.querySelector('canvas#board');
    if (!canvasEl) return null;
    const rect = canvasEl.getBoundingClientRect();
    return { x: rect.left + stagePoint.x, y: rect.top + stagePoint.y };
  } catch (error) {
    Logger.warn('TileHud.worldToScreen.failed', { error: String(error?.message || error) });
    return null;
  }
}

function getTileVisualCenterWorld(doc) {
  const x = Number(doc?.x || 0);
  const y = Number(doc?.y || 0);
  const width = Number(doc?.width || 0);
  const height = Number(doc?.height || 0);
  const anchorX = Number(doc?.texture?.anchorX);
  const anchorY = Number(doc?.texture?.anchorY);
  const resolvedAnchorX = Number.isFinite(anchorX) ? anchorX : 0.5;
  const resolvedAnchorY = Number.isFinite(anchorY) ? anchorY : 0.5;
  return {
    x: x + (width * (0.5 - resolvedAnchorX)),
    y: y + (height * (0.5 - resolvedAnchorY))
  };
}

function buildPointerPayload(doc) {
  if (!doc) return null;
  try {
    const center = getTileVisualCenterWorld(doc);
    const screen = worldToScreen(center);
    if (screen) {
      return { pointer: { x: screen.x, y: screen.y }, world: center };
    }
    return { world: center };
  } catch (error) {
    Logger.warn('TileHud.pointerPayload.failed', { error: String(error?.message || error) });
    return null;
  }
}

function normalizeLevelId(value) {
  if (value && typeof value === 'object' && typeof value.id === 'string') return String(value.id).trim() || null;
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeLevelIdList(values) {
  const normalized = [];
  const append = (value) => {
    const levelId = normalizeLevelId(value);
    if (levelId) normalized.push(levelId);
  };
  if (values instanceof Set || Array.isArray(values)) {
    for (const value of values) append(value);
  } else if (typeof values === 'string' || (values && typeof values === 'object')) {
    append(values);
  }
  return Array.from(new Set(normalized));
}

function resolveSceneLevel(scene, levelId) {
  const normalized = normalizeLevelId(levelId);
  if (!scene || !normalized) return null;
  try {
    const byId = scene.levels?.get?.(normalized);
    if (byId) return byId;
  } catch (_) {}
  const sorted = Array.isArray(scene?.levels?.sorted) ? scene.levels.sorted : [];
  return sorted.find((level) => normalizeLevelId(level?.id) === normalized) || null;
}

function getCurrentViewedLevelId(scene = canvas?.scene) {
  return normalizeLevelId(canvas?.level?.id || scene?._view);
}

function getActiveLevelSwitchBlockers() {
  try {
    const collect = globalThis?.faNexus?.collectActiveSessionLevelSwitchBlockers;
    const blockers = typeof collect === 'function' ? collect() : [];
    return Array.isArray(blockers) ? blockers.filter(Boolean) : [];
  } catch (error) {
    Logger.warn('TileHud.parentLevelSwitch.blockerCheckFailed', {
      error: String(error?.message || error)
    });
    return [];
  }
}

async function waitForViewedParentLevel(levelId, { scene = canvas?.scene, timeoutMs = PARENT_LEVEL_SWITCH_TIMEOUT_MS } = {}) {
  const expected = normalizeLevelId(levelId);
  if (!expected) return;
  const sceneId = normalizeLevelId(scene?.id);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const activeSceneId = normalizeLevelId(canvas?.scene?.id);
    const currentLevelId = normalizeLevelId(canvas?.scene?._view || canvas?.level?.id);
    if (activeSceneId === sceneId && currentLevelId === expected && canvas?.ready === true) return;
    if (Date.now() > deadline) {
      Logger.error('TileHud.parentLevelSwitch.timeout', {
        expectedLevelId: expected,
        currentLevelId,
        sceneId,
        activeSceneId,
        canvasReady: canvas?.ready === true
      });
      throw new Error(`Timed out waiting for Foundry to switch to tile Parent Level "${expected}".`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function ensureTileParentLevelViewed(doc, { mode = null, source = null } = {}) {
  let parentLevelId = getTileExplicitPlacementLevelId(doc);
  const building = doc?.flags?.['fa-nexus']?.building;
  const nativeBuilding = mode === 'buildings' && [4, 5].includes(Number(building?.schemaVersion));
  if (nativeBuilding) {
    const { readBuildingV2NativeWallLevelIds } = await import('../buildings/v2/building-v2-existing-edit-runtime.js');
    const levels = readBuildingV2NativeWallLevelIds(doc);
    const viewed = getCurrentViewedLevelId(doc.parent);
    if (levels.length === 1) parentLevelId = levels[0];
    else if (!levels.length || levels.includes(viewed)) parentLevelId = viewed;
    else if (!levels.includes(parentLevelId)) {
      throw new Error('View one of the Building native Wall Levels before opening Edit.');
    }
  }
  if (!parentLevelId) {
    Logger.debug?.('TileHud.parentLevelSwitch.skippedNoParentLevel', {
      tileId: doc?.id || null,
      mode,
      source
    });
    return null;
  }

  const scene = doc?.parent || canvas?.scene || null;
  const sceneId = normalizeLevelId(scene?.id);
  const activeSceneId = normalizeLevelId(canvas?.scene?.id);
  if (!scene || !sceneId || sceneId !== activeSceneId) {
    Logger.error('TileHud.parentLevelSwitch.inactiveScene', {
      tileId: doc?.id || null,
      parentLevelId,
      sceneId,
      activeSceneId,
      mode,
      source
    });
    throw new Error('Cannot switch to the tile Parent Level because the tile is not on the active canvas scene.');
  }

  const targetLevel = resolveSceneLevel(scene, parentLevelId);
  if (!targetLevel) {
    Logger.error('TileHud.parentLevelSwitch.parentLevelMissing', {
      tileId: doc?.id || null,
      parentLevelId,
      sceneId,
      mode,
      source
    });
    // The id is in the log line above; the reader of the notification needs to know what to do.
    throw new Error('The Level this layer was made on no longer exists. In the Layer Manager, drag its row onto an Elevation of another Level, then edit it.');
  }

  const currentLevelId = getCurrentViewedLevelId(scene);
  if (currentLevelId === parentLevelId) {
    Logger.debug?.('TileHud.parentLevelSwitch.alreadyOnParentLevel', {
      tileId: doc?.id || null,
      parentLevelId,
      mode,
      source
    });
    return { levelId: parentLevelId, level: targetLevel, switched: false };
  }

  if (typeof scene.view !== 'function') {
    Logger.error('TileHud.parentLevelSwitch.sceneViewMissing', {
      tileId: doc?.id || null,
      parentLevelId,
      sceneId,
      currentLevelId,
      mode,
      source
    });
    throw new Error('Foundry Scene.view is unavailable; cannot switch to the tile Parent Level.');
  }

  const blockers = getActiveLevelSwitchBlockers();
  if (blockers.length) {
    Logger.warn('TileHud.parentLevelSwitch.blockedActiveSession', {
      tileId: doc?.id || null,
      parentLevelId,
      currentLevelId,
      blockers,
      mode,
      source
    });
    throw new Error('Finish or cancel the active FA Nexus session before editing this tile on its Parent Level.');
  }

  const levelName = String(targetLevel?.name || parentLevelId).trim() || parentLevelId;
  Logger.info('TileHud.parentLevelSwitch.begin', {
    tileId: doc?.id || null,
    fromLevelId: currentLevelId,
    parentLevelId,
    parentLevelName: levelName,
    mode,
    source
  });
  ui?.notifications?.info?.(`Switching to ${nativeBuilding ? 'Building Wall' : 'Parent'} Level: ${levelName}`);
  await scene.view({ level: parentLevelId });
  await waitForViewedParentLevel(parentLevelId, { scene });
  Logger.info('TileHud.parentLevelSwitch.complete', {
    tileId: doc?.id || null,
    parentLevelId,
    parentLevelName: levelName,
    mode,
    source
  });
  return { levelId: parentLevelId, level: targetLevel, switched: true };
}

function applyParentLevelLaunchOptions(launchOptions, parentLevelContext, { doc = null, mode = null } = {}) {
  const parentLevelId = normalizeLevelId(parentLevelContext?.levelId);
  if (!parentLevelId) return;

  const optionLevelId = normalizeLevelId(launchOptions?.placementLevelId);
  if (optionLevelId && optionLevelId !== parentLevelId) {
    Logger.error('TileHud.parentLevelSwitch.optionLevelConflict', {
      tileId: doc?.id || null,
      mode,
      parentLevelId,
      optionLevelId
    });
    throw new Error(`Tile edit requested level "${optionLevelId}", but the tile Parent Level is "${parentLevelId}".`);
  }

  const hasPlacementLevels = Object.prototype.hasOwnProperty.call(launchOptions, 'placementLevels');
  const optionLevels = normalizeLevelIdList(launchOptions?.placementLevels);
  if (hasPlacementLevels && optionLevels.length && !(optionLevels.length === 1 && optionLevels[0] === parentLevelId)) {
    Logger.error('TileHud.parentLevelSwitch.optionLevelsConflict', {
      tileId: doc?.id || null,
      mode,
      parentLevelId,
      optionLevels
    });
    throw new Error(`Tile edit requested Levels [${optionLevels.join(', ')}], but the tile Parent Level is "${parentLevelId}".`);
  }

  launchOptions.placementLevelId = parentLevelId;
  launchOptions.placementLevels = [parentLevelId];
  launchOptions.parentLevelSwitch = {
    levelId: parentLevelId,
    switched: parentLevelContext.switched === true
  };
}

async function ensureAppReady(app) {
  if (!app) throw new Error('FA Nexus app unavailable');
  if (app.rendered && app.element) return app;
  await new Promise((resolve) => {
    const handler = (renderedApp) => {
      if (renderedApp === app) resolve();
    };
    Hooks.once('renderFaNexusApp', handler);
  });
  return app;
}

export async function ensureTileHudTabServices(tab, tabId) {
  if (!tab?._controller?.ensureServices) return false;
  try {
    await tab._controller.ensureServices();
    return true;
  } catch (error) {
    Logger.error('TileHud.ensureServices.failed', {
      tab: tabId,
      error: String(error?.message || error)
    });
    throw error;
  }
}

async function openTab(app, tabId) {
  const tabManager = app?._tabManager;
  if (!tabManager) throw new Error('FA Nexus tab manager unavailable');
  if (tabManager.getActiveTabId() !== tabId) {
    await tabManager.switchToTab(tabId);
  }
  tabManager.initializeTabs();
  const tabs = tabManager.getTabs();
  const tab = tabs?.[tabId];
  if (!tab) throw new Error(`FA Nexus tab missing: ${tabId}`);
  await ensureTileHudTabServices(tab, tabId);
  return tab;
}

async function stopEmptyExistingEditorSession(mode) {
  const existing = foundry?.applications?.instances?.get?.('fa-nexus-app') || null;
  const tabs = existing?._tabManager?.getTabs?.() || null;
  const manager = mode === 'buildings'
    ? (tabs?.buildings?.buildingManager || tabs?.buildings?._buildingManager || null)
    : null;
  if (!manager?.isActive) return true;
  // Tracer-specific: its stop routes through the tracer's own exit prompt. A LIVE bundle
  // session keeps the fail-closed path below (changed sessions refuse HUD re-entry).
  if (manager.isCurrentBuildingEditTracerActive) {
    const outcome = await Promise.resolve(manager.stop?.({ reason: 'opening another Building' }));
    return !manager.isActive && !['continued', 'blocked'].includes(outcome?.kind);
  }
  if (manager.hasSessionChanges?.()) {
    throw new Error('Finish or cancel the active FA Nexus session before editing another Tile.');
  }
  await Promise.resolve(manager.stop?.({ reason: 'tile-hud-edit-reentry' }));
  return !manager.isActive;
}

function resolveBuildingModeFromTile(doc) {
  try {
    const flag = doc?.getFlag?.('fa-nexus', 'building')
      || doc?.flags?.['fa-nexus']?.building
      || doc?._source?.flags?.['fa-nexus']?.building
      || null;
    const wallMode = flag?.wall?.mode;
    if (wallMode === 'inner' || wallMode === 'outer') return wallMode;
  } catch (_) {}
  return null;
}

async function launchEditor(doc, mode, options = {}) {
  if (!doc) throw new Error('Tile document not available');
  if (mode === 'buildings') {
    const { waitForSceneGroupOverlayTransformSettlement } = await import('../composition/scene-group-overlay-runtime.js');
    await waitForSceneGroupOverlayTransformSettlement();
  }
  const editorState = getTileEditorState(doc);
  if (mode === 'paths' && !editorState.canLaunch) {
    throw new Error(editorState.errorMessage || 'This tile cannot be edited in FA Nexus.');
  }
  const launchOptions = { ...(options && typeof options === 'object' ? options : {}) };
  if (!await stopEmptyExistingEditorSession(mode)) return { kind: 'continued' };
  const parentLevelContext = await ensureTileParentLevelViewed(doc, {
    mode,
    source: launchOptions.source || 'tile-hud'
  });
  applyParentLevelLaunchOptions(launchOptions, parentLevelContext, { doc, mode });
  const pointerPayload = buildPointerPayload(doc) || {};
  const appFactory = window.faNexus?.open;
  if (typeof appFactory !== 'function') throw new Error('FA Nexus open helper missing');
  const app = appFactory();
  await ensureAppReady(app);
  app?.bringToFront?.();
  try { canvas?.tiles?.activate?.(); } catch (_) {}
  const tab = await openTab(app, mode);
  if (mode === 'buildings') {
    const buildingMode = resolveBuildingModeFromTile(doc);
    const desiredSubtab = buildingMode === 'inner' ? 'single-wall' : (buildingMode === 'outer' ? 'building' : null);
    if (desiredSubtab && typeof tab?._setActiveSubtab === 'function') {
      try { tab._setActiveSubtab(desiredSubtab, { silent: true }); } catch (_) {}
    }
  }
  if (mode === 'buildings' && typeof tab?.forceNoFillSelection === 'function') {
    try { await tab.forceNoFillSelection({ notifyManager: false }); }
    catch (error) { Logger.warn('TileHud.forceNoFill.failed', { error: String(error?.message || error) }); }
  }
  let manager = null;
  if (mode === 'paths') {
    manager = tab?.pathManagerV2 || null;
  }
  else if (mode === 'buildings') manager = tab?.buildingManager;
  else if (mode === 'textures') manager = tab?.texturePaintManager;
  else manager = tab?.placementManager;
  if (!manager) throw new Error('FA Nexus editor manager unavailable');
  if (pointerPayload.pointer) launchOptions.pointer = pointerPayload.pointer;
  if (pointerPayload.world) launchOptions.pointerWorld = pointerPayload.world;
  if (!launchOptions.source) launchOptions.source = 'tile-hud';
  if (mode === 'textures' && launchOptions.standardTileMask) {
    launchOptions.standardTileMask = true;
    await manager.editStandardTile(doc, launchOptions);
    return;
  }
  const sessionView = await manager.editTile(doc, launchOptions);
  if (mode === 'buildings' && typeof tab?.syncFillSelectionFromSession === 'function') {
    tab.syncFillSelectionFromSession(sessionView);
  }
  if (mode === 'buildings' && manager.isActive) {
    tab?._attachEscapeListener?.();
  }
}

export async function openFaNexusTileEditor(doc, options = {}) {
  const editorState = getTileEditorState(doc);
  if (!editorState.mode) {
    Logger.error('TileHud.openEditor.unsupportedTile', {
      tileId: doc?.id || null,
      reasonCode: editorState.reasonCode || null
    });
    throw new Error(editorState.errorMessage || 'This tile does not support FA Nexus editing.');
  }
  if (!editorState.canLaunch) {
    Logger.error('TileHud.openEditor.launchBlocked', {
      tileId: doc?.id || null,
      mode: editorState.mode,
      reasonCode: editorState.reasonCode,
      customRenderFeatures: editorState.capabilities?.customRenderFeatures || []
    });
    throw new Error(editorState.errorMessage || 'This tile cannot be edited in FA Nexus.');
  }
  const ownership = resolveBuildingGeneratedDocumentOwner({ scene: doc?.parent, document: doc });
  const launchOptions = ownership ? {
    ...createBuildingGeneratedDocumentEditorOptions(doc, { source: options?.source || 'tile-hud' }),
    ...options
  } : options;
  try {
    return await launchEditor(ownership?.ownerDocument || doc, editorState.mode, launchOptions);
  } catch (error) {
    throw explainEditorAccessRefusal(error, editorState.mode);
  }
}

const PRO_TOOL_LABELS = Object.freeze({ buildings: 'The Building Tool', paths: 'Paths', textures: 'Texture Painting' });

/**
 * Nexus Edit without a Patreon login, or on a tier without the Pro tools, is a refusal the user can act on: give it
 * a sentence they understand (userMessage) instead of the entitlement service's code-level text.
 */
function explainEditorAccessRefusal(error, mode) {
  const label = PRO_TOOL_LABELS[mode] || 'This editor';
  const code = String(error?.code || '').toUpperCase();
  if (code === 'STATE_MISSING') error.userMessage = `${label} is a Pro tool. Connect Patreon to edit this layer.`;
  else if (isProTierRefusal(error)) error.userMessage = proTierMessage(label);
  else if (mode === 'buildings') {
    const sentence = v053RefusalSentence(error);
    if (sentence) error.userMessage = sentence;
  }
  return error;
}

// A Building made with Nexus 0.5.3 opens in the new Building Tool only when it can be rebuilt exactly; the premium
// editor refuses the rest with a coded preflight result (error.code, error.preflight). Those codes and their facts
// get a sentence the user can act on; the technical message stays in the log.
const V053_FACT_SENTENCES = Object.freeze({
  'linked-walls-missing': 'its Foundry Walls are no longer there',
  'linked-inner-wall-missing': 'some of its inner Walls are no longer there',
  'native-portal-missing': 'some of its doors or windows are no longer there',
  'scene-group-transform-history-ambiguous': 'it is in a Scene Group, so Nexus cannot tell how the group moved it'
});
function v053RefusalSentence(error) {
  const code = String(error?.code || '');
  // Missing or ambiguous facts carry the fact's own code (for example linked-walls-missing), so the preflight result
  // attached to the error is what marks a 0.5.3 refusal.
  if (!code.startsWith('building-v053-preflight') && !error?.preflight?.preflight) return null;
  const lead = 'This Building was made with Nexus 0.5.3 and the new Building Tool cannot open it safely';
  if (code === 'building-v053-preflight-unsupported-rotation') return `${lead}: it has been rotated. Turn it back to 0° to edit it.`;
  if (code === 'building-v053-preflight-unsupported-scale') return `${lead}: it has been resized. Set its scale back to 100% to edit it.`;
  if (code === 'building-v053-preflight-unsupported-editor-version' || code === 'building-v053-preflight-unsupported-schema') {
    return 'This Building was made with an older Building Tool than the one in Nexus 0.5.3, and the new Building Tool cannot open it.';
  }
  const facts = error?.preflight?.preflight?.facts || {};
  const factCodes = [code, ...[...(facts.missing || []), ...(facts.ambiguous || [])].map((fact) => String(fact?.code || ''))];
  const reasons = [...new Set(factCodes.map((factCode) => V053_FACT_SENTENCES[factCode]).filter(Boolean))];
  return reasons.length ? `${lead}: ${reasons.join(', and ')}.` : `${lead}. It still draws and works as it is.`;
}

export async function openFaNexusTileMaskEditor(doc, options = {}) {
  if (!canLaunchFaNexusTileMask(doc)) {
    Logger.error('TileHud.openMaskEditor.unsupportedTile', {
      tileId: doc?.id || null
    });
    throw new Error('This tile does not support FA Nexus mask editing.');
  }
  return launchEditor(doc, 'textures', { ...(options || {}), standardTileMask: true });
}

Hooks.on('renderTileHUD', (hud, html) => {
  try {
    const doc = resolveTileDocument(hud);
    const root = resolveHudElement(hud, html);
    if (!root) return;

    const manager = getTileFlattenManager();
    let updateFlattenState = () => {};
    let updateDeconstructState = () => {};
    const refreshStates = () => {
      try { updateFlattenState(); } catch (_) {}
      try { updateDeconstructState(); } catch (_) {}
    };

    const selectedTiles = TileFlattenManager.getSelectedTiles();
    const flattenableTiles = TileFlattenManager.getFlattenableTiles(selectedTiles);
    const flattenCount = Array.isArray(flattenableTiles) ? flattenableTiles.length : 0;
    const selectedSingleFlattened = selectedTiles.length === 1 && isFaNexusFlattenedTile(selectedTiles[0]);
    const allowSingleMerged = flattenCount === 1 && TileFlattenManager.isMergedTile(flattenableTiles[0]);
    const flattenButton = ensureFlattenButton(root, selectedSingleFlattened ? 0 : flattenCount, allowSingleMerged);
    if (flattenButton) {
      if (flattenButton._faNexusFlattenHandler) {
        flattenButton.removeEventListener('click', flattenButton._faNexusFlattenHandler);
      }
      updateFlattenState = () => {
        const selection = TileFlattenManager.getSelectedTiles();
        const flattenSelection = TileFlattenManager.getFlattenableTiles(selection);
        const count = Array.isArray(flattenSelection) ? flattenSelection.length : 0;
        const canFlatten = TileFlattenManager.canFlattenSelection(selection);
        const singleMerged = count === 1 && TileFlattenManager.isMergedTile(flattenSelection[0]);
        const singleFlattened = selection.length === 1 && isFaNexusFlattenedTile(selection[0]);
        const busy = manager?.isBusy ? manager.isBusy() : !!manager?._flattening;
        const disabled = busy || singleFlattened || !canFlatten;
        flattenButton.disabled = disabled;
        flattenButton.classList.toggle('disabled', disabled || singleFlattened);
        flattenButton.dataset.count = String(count);
        const label = count > 1
          ? `Flatten ${count} selected tile${count === 1 ? '' : 's'} in FA Nexus`
          : (singleMerged ? 'Flatten merged tile in FA Nexus' : 'Flatten selected tile in FA Nexus');
        flattenButton.dataset.tooltip = label;
        flattenButton.setAttribute('aria-label', label);
        flattenButton.title = label;
        if (busy) flattenButton.setAttribute('aria-busy', 'true');
        else flattenButton.removeAttribute('aria-busy');
      };
      const handler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        refreshStates();
        manager.showFlattenDialog().catch((error) => {
          Logger.warn('TileHud.flatten.failed', { error: String(error?.message || error) });
          ui?.notifications?.error?.(`Failed to flatten tiles: ${error?.message || error}`);
        }).finally(() => {
          setTimeout(refreshStates, 10);
        });
      };
      flattenButton._faNexusFlattenHandler = handler;
      flattenButton.addEventListener('click', handler);
      // Ensure UI reflects current manager state
      updateFlattenState();
    }

    const deconstructButton = ensureDeconstructButton(root, doc);
    if (deconstructButton) {
      if (deconstructButton._faNexusDeconstructHandler) {
        deconstructButton.removeEventListener('click', deconstructButton._faNexusDeconstructHandler);
      }
      updateDeconstructState = () => {
        const busy = manager?.isBusy ? manager.isBusy() : !!manager?._flattening || !!manager?._deconstructing;
        deconstructButton.disabled = busy;
        deconstructButton.classList.toggle('disabled', busy);
        if (busy) deconstructButton.setAttribute('aria-busy', 'true');
        else deconstructButton.removeAttribute('aria-busy');
      };
      const handler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        refreshStates();
        manager.confirmAndDeconstructTile(doc).catch((error) => {
          Logger.warn('TileHud.deconstruct.failed', { error: String(error?.message || error) });
          ui?.notifications?.error?.(`Failed to deconstruct tile: ${error?.message || error}`);
        }).finally(() => {
          setTimeout(refreshStates, 10);
        });
      };
      deconstructButton._faNexusDeconstructHandler = handler;
      deconstructButton.addEventListener('click', handler);
      updateDeconstructState();
    } else {
      updateDeconstructState = () => {};
    }

    const editorState = getTileEditorState(doc);
    if (!editorState.mode) {
      // No editor: no pen. The Mask button is decided on its own below (a flattened picture can be masked).
      const existing = root.querySelector(`button[data-action="${BUTTON_ACTION}"]`);
      if (existing) existing.remove();
    } else {
      const button = ensureButton(root, editorState);
      if (!button) return;
      if (button._faNexusHandler) {
        button.removeEventListener('click', button._faNexusHandler);
        delete button._faNexusHandler;
      }
      const handler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const launch = openFaNexusTileEditor(doc, { source: 'tile-hud' });
        button._faNexusLaunchPromise = launch;
        launch.catch((error) => {
          Logger.warn('TileHud.launchEditor.failed', { error: String(error?.message || error) });
          if (error?.userMessage) ui?.notifications?.warn?.(error.userMessage);
          else ui?.notifications?.error?.(`Failed to open FA Nexus editor: ${error?.message || error}`);
        });
      };
      button._faNexusHandler = handler;
      button.addEventListener('click', handler);
    }

    const maskButton = ensureStandardMaskButton(root, doc);
    if (!maskButton) return;
    if (maskButton._faNexusHandler) {
      maskButton.removeEventListener('click', maskButton._faNexusHandler);
      delete maskButton._faNexusHandler;
    }
    const maskHandler = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openFaNexusTileMaskEditor(doc, { source: 'tile-hud' }).catch((error) => {
        Logger.error('TileHud.launchStandardMaskEditor.failed', {
          tileId: doc?.id || null,
          error: String(error?.message || error)
        });
        ui?.notifications?.error?.(`Failed to open FA Nexus mask editor: ${error?.message || error}`);
      });
    };
    maskButton._faNexusHandler = maskHandler;
    maskButton.addEventListener('click', maskHandler);
  } catch (error) {
    Logger.warn('TileHud.render.failed', { error: String(error?.message || error) });
  }
});
