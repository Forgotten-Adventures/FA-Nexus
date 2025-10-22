import { NexusLogger as Logger } from '../core/nexus-logger.js';

const BUTTON_ACTION = 'fa-nexus-edit';

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
    if (doc.getFlag('fa-nexus', 'path')) return 'paths';
    if (doc.getFlag('fa-nexus', 'maskedTiling')) return 'textures';
  } catch (error) {
    Logger.warn('TileHud.checkFlags.failed', { error: String(error?.message || error) });
  }
  return null;
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
  const label = mode === 'paths' ? 'Edit Path in FA Nexus' : 'Edit Mask in FA Nexus';
  button.dataset.mode = mode;
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

async function launchEditor(doc, mode) {
  if (!doc) throw new Error('Tile document not available');
  const pointerPayload = buildPointerPayload(doc) || {};
  const appFactory = window.faNexus?.open;
  if (typeof appFactory !== 'function') throw new Error('FA Nexus open helper missing');
  const app = appFactory();
  await ensureAppReady(app);
  app?.bringToFront?.();
  try { canvas?.tiles?.activate?.(); } catch (_) {}
  const tab = await openTab(app, mode);
  const manager = mode === 'paths' ? tab?.pathManager : tab?.texturePaintManager;
  if (!manager) throw new Error('FA Nexus editor manager unavailable');
  const options = {};
  if (pointerPayload.pointer) options.pointer = pointerPayload.pointer;
  if (pointerPayload.world) options.pointerWorld = pointerPayload.world;
  options.source = 'tile-hud';
  await manager.editTile(doc, options);
}

Hooks.on('renderTileHUD', (hud, html) => {
  try {
    const doc = resolveTileDocument(hud);
    const mode = getTileMode(doc);
    const root = resolveHudElement(hud, html);
    if (!root) return;
    if (!mode) {
      const existing = root.querySelector(`button[data-action="${BUTTON_ACTION}"]`);
      if (existing) existing.remove();
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
  } catch (error) {
    Logger.warn('TileHud.render.failed', { error: String(error?.message || error) });
  }
});
