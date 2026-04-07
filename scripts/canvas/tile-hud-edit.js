import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { TileFlattenManager } from './tile-flatten-manager.js';

const BUTTON_ACTION = 'fa-nexus-edit';
const MASK_BUTTON_ACTION = 'fa-nexus-mask';
const FLATTEN_ACTION = 'fa-nexus-flatten';
const DECONSTRUCT_ACTION = 'fa-nexus-deconstruct';
const STANDARD_TILE_MASK_HUD_ENABLED = false;

let _tileFlattenManager = null;

function getTileFlattenManager() {
  if (!_tileFlattenManager) _tileFlattenManager = new TileFlattenManager();
  return _tileFlattenManager;
}

function resolveTileDocument(hud) {
  try {
    if (!hud) return null;
    const TileDocument = globalThis?.foundry?.documents?.TileDocument;
    if (hud.object?.document) return hud.object.document;
    if (TileDocument && hud.object && hud.object.document === undefined && hud.object instanceof TileDocument) return hud.object;
    if (TileDocument && hud.document instanceof TileDocument) return hud.document;
    return null;
  } catch (error) {
    Logger.warn('TileHud.resolveDocument.failed', { error: String(error?.message || error) });
    return null;
  }
}

function getTileMode(doc) {
  if (!doc) return null;
  try {
    if (doc.getFlag('fa-nexus', 'path') || isPathV2Tile(doc)) return 'paths';
    if (doc.getFlag('fa-nexus', 'maskedTiling')) return 'textures';
    if (doc.getFlag('fa-nexus', 'building')) return 'buildings';
    const src = String(doc.texture?.src || '').trim();
    if (src) return 'assets';
  } catch (error) {
    Logger.warn('TileHud.checkFlags.failed', { error: String(error?.message || error) });
  }
  return null;
}

export function getFaNexusTileEditMode(doc) {
  return getTileMode(doc);
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

function ensureButton(root, mode) {
  if (!root) return null;
  const column = root.querySelector('.col.right');
  if (!column) return null;
  let button = column.querySelector(`button[data-action="${BUTTON_ACTION}"]`);
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'control-icon fa-nexus-edit';
    button.dataset.action = BUTTON_ACTION;
    button.innerHTML = '<i class="fas fa-pen"></i>';
    column.appendChild(button);
  }
  const label = mode === 'paths'
    ? 'Edit Path in FA Nexus'
    : mode === 'buildings'
      ? 'Edit Building in FA Nexus'
    : mode === 'textures'
      ? 'Edit Mask in FA Nexus'
      : 'Edit Asset in FA Nexus';
  button.dataset.mode = mode;
  button.dataset.tooltip = label;
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

function isImageTile(doc) {
  try {
    const src = String(doc?.texture?.src || '').trim();
    if (!src) return false;
    return !/\.(webm|mp4)$/i.test(src);
  } catch (_) {
    return false;
  }
}

function isScatterTile(doc) {
  try {
    const scatter = doc?.getFlag?.('fa-nexus', 'assetScatter');
    if (scatter && typeof scatter === 'object' && Array.isArray(scatter.instances)) return true;
  } catch (_) {}
  try {
    const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
    return !!(flags?.assetScatter && typeof flags.assetScatter === 'object' && Array.isArray(flags.assetScatter.instances));
  } catch (_) {
    return false;
  }
}

function shouldShowStandardMaskButton(doc) {
  try {
    if (!STANDARD_TILE_MASK_HUD_ENABLED) return false;
    if (!doc) return false;
    if (doc.getFlag('fa-nexus', 'path') || isPathV2Tile(doc)) return false;
    if (doc.getFlag('fa-nexus', 'maskedTiling')) return false;
    if (doc.getFlag('fa-nexus', 'building')) return false;
    if (isScatterTile(doc)) return false;
    return isImageTile(doc);
  } catch (_) {
    return false;
  }
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
  const label = hasMask ? 'Edit Standard Tile Mask in FA Nexus' : 'Mask Standard Tile in FA Nexus';
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
  const isFlattened = TileFlattenManager.isFlattenedTile(doc);

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

function buildPointerPayload(doc) {
  if (!doc) return null;
  try {
    const x = Number(doc.x) || 0;
    const y = Number(doc.y) || 0;
    const width = Number(doc.width) || 0;
    const height = Number(doc.height) || 0;
    const center = { x: x + (width / 2), y: y + (height / 2) };
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

function isPathV2Tile(doc) {
  try {
    const flags = doc?.getFlag?.('fa-nexus', 'pathV2')
      || doc?.flags?.['fa-nexus']?.pathV2
      || doc?._source?.flags?.['fa-nexus']?.pathV2
      || null;
    if (flags) return true;
  } catch (_) {}
  try {
    const flags = doc?.getFlag?.('fa-nexus', 'pathsV2')
      || doc?.flags?.['fa-nexus']?.pathsV2
      || doc?._source?.flags?.['fa-nexus']?.pathsV2
      || null;
    return !!flags;
  } catch (_) {}
  return false;
}

async function launchEditor(doc, mode, options = {}) {
  if (!doc) throw new Error('Tile document not available');
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
    const useV2 = isPathV2Tile(doc);
    manager = useV2 ? (tab?.pathManagerV2 || tab?.pathManager) : (tab?.pathManager || tab?.pathManagerV2);
  }
  else if (mode === 'buildings') manager = tab?.buildingManager;
  else if (mode === 'textures') manager = tab?.texturePaintManager;
  else manager = tab?.placementManager;
  if (!manager) throw new Error('FA Nexus editor manager unavailable');
  const launchOptions = { ...(options && typeof options === 'object' ? options : {}) };
  if (pointerPayload.pointer) launchOptions.pointer = pointerPayload.pointer;
  if (pointerPayload.world) launchOptions.pointerWorld = pointerPayload.world;
  launchOptions.source = 'tile-hud';
  if (mode === 'textures' && launchOptions.standardTileMask) {
    await manager.editStandardTile(doc, launchOptions);
    return;
  }
  await manager.editTile(doc, launchOptions);
}

export async function openFaNexusTileEditor(doc, options = {}) {
  const mode = getTileMode(doc);
  if (!mode) {
    Logger.error('TileHud.openEditor.unsupportedTile', {
      tileId: doc?.id || null
    });
    throw new Error('This tile does not support FA Nexus editing.');
  }
  return launchEditor(doc, mode, options);
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
    const selectedSingleFlattened = selectedTiles.length === 1 && TileFlattenManager.isFlattenedTile(selectedTiles[0]);
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
        const singleFlattened = selection.length === 1 && TileFlattenManager.isFlattenedTile(selection[0]);
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

    const mode = getTileMode(doc);
    if (!mode) {
      const existing = root.querySelector(`button[data-action="${BUTTON_ACTION}"]`);
      if (existing) existing.remove();
      const maskExisting = root.querySelector(`button[data-action="${MASK_BUTTON_ACTION}"]`);
      if (maskExisting) maskExisting.remove();
      return;
    }
    const button = ensureButton(root, mode);
    if (!button) return;
    if (button._faNexusHandler) {
      button.removeEventListener('click', button._faNexusHandler);
      delete button._faNexusHandler;
    }
    const handler = (event) => {
      event.preventDefault();
      event.stopPropagation();
      launchEditor(doc, mode).catch((error) => {
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
      launchEditor(doc, 'textures', { standardTileMask: true }).catch((error) => {
        Logger.error('TileHud.launchStandardMaskEditor.failed', {
          tileId: doc?.id || null,
          error: String(error?.message || error)
        });
        ui?.notifications?.error?.(`Failed to open FA Nexus standard tile mask editor: ${error?.message || error}`);
      });
    };
    maskButton._faNexusHandler = maskHandler;
    maskButton.addEventListener('click', maskHandler);
  } catch (error) {
    Logger.warn('TileHud.render.failed', { error: String(error?.message || error) });
  }
});
