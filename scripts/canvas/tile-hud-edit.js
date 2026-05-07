import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { TileFlattenManager } from '../flatten/flatten-manager.js';
import { getFaNexusTileCapabilities } from './tile-capabilities.js';
import { getTileExplicitPlacementLevelId } from './tile-band-utils.js';
import { resolveTileDocument as resolveSharedTileDocument } from './tile-targets.js';
import { hasStandardMaskCustomBaseSource } from '../textures/standard-mask-custom-base.js';

const BUTTON_ACTION = 'fa-nexus-edit';
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
  const capabilities = getFaNexusTileCapabilities(doc);
  const mode = capabilities?.editMode || null;
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
  const parentLevelId = getTileExplicitPlacementLevelId(doc);
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
    throw new Error(`Tile Parent Level "${parentLevelId}" was not found in this scene.`);
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
  ui?.notifications?.info?.(`Switching to Parent Level: ${levelName}`);
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

async function openTab(app, tabId) {
  const tabManager = app?._tabManager;
  if (!tabManager) throw new Error('FA Nexus tab manager unavailable');
  await tabManager.switchToTab(tabId);
  tabManager.initializeTabs();
  const tabs = tabManager.getTabs();
  const tab = tabs?.[tabId];
  if (!tab) throw new Error(`FA Nexus tab missing: ${tabId}`);
  if (tab?._controller?.ensureServices) {
    try { await tab._controller.ensureServices(); }
    catch (error) { Logger.warn('TileHud.ensureServices.failed', { tab: tabId, error: String(error?.message || error) }); }
  }
  return tab;
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
  const editorState = getTileEditorState(doc);
  if (mode === 'paths' && !editorState.canLaunch) {
    throw new Error(editorState.errorMessage || 'This tile cannot be edited in FA Nexus.');
  }
  const launchOptions = { ...(options && typeof options === 'object' ? options : {}) };
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
  await manager.editTile(doc, launchOptions);
}

export async function openFaNexusTileEditor(doc, options = {}) {
  const editorState = getTileEditorState(doc);
  if (!editorState.mode) {
    Logger.error('TileHud.openEditor.unsupportedTile', {
      tileId: doc?.id || null
    });
    throw new Error('This tile does not support FA Nexus editing.');
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
  return launchEditor(doc, editorState.mode, options);
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
      const existing = root.querySelector(`button[data-action="${BUTTON_ACTION}"]`);
      if (existing) existing.remove();
      const maskExisting = root.querySelector(`button[data-action="${MASK_BUTTON_ACTION}"]`);
      if (maskExisting) maskExisting.remove();
      return;
    }
    const button = ensureButton(root, editorState);
    if (!button) return;
    if (button._faNexusHandler) {
      button.removeEventListener('click', button._faNexusHandler);
      delete button._faNexusHandler;
    }
    const handler = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openFaNexusTileEditor(doc, { source: 'tile-hud' }).catch((error) => {
        Logger.warn('TileHud.launchEditor.failed', { error: String(error?.message || error) });
        ui?.notifications?.error?.(`Failed to open FA Nexus editor: ${error?.message || error}`);
      });
    };
    button._faNexusHandler = handler;
    button.addEventListener('click', handler);

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
