import { NexusLogger as Logger } from './nexus-logger.js';
import { preserveCurrentTileSelectionForNexus } from '../canvas/tile-selection-context.js';

const MODULE_ID = 'fa-nexus';
let themeObserver = null;
let dragState = null;

/** Check if floating mode is enabled */
function isFloatingMode() {
  try {
    return game?.settings?.get(MODULE_ID, 'floatingLauncher') ?? false;
  } catch (_) {
    return false;
  }
}

/** Get saved launcher position */
function getSavedPosition() {
  try {
    return game?.settings?.get(MODULE_ID, 'launcherPosition') ?? { left: null, top: null };
  } catch (_) {
    return { left: null, top: null };
  }
}

/** Save launcher position */
function savePosition(left, top) {
  try {
    game?.settings?.set(MODULE_ID, 'launcherPosition', { left, top });
  } catch (err) {
    Logger?.warn?.('Launcher.savePosition.failed', err);
  }
}

/** Apply floating position to the panel */
function applyFloatingPosition(panel) {
  const pos = getSavedPosition();
  const rect = panel.getBoundingClientRect();

  // Default position: bottom-left corner, above players area
  let left = pos.left ?? 15;
  let top = pos.top ?? (window.innerHeight - rect.height - 120);

  // Clamp to viewport bounds
  left = Math.max(0, Math.min(left, window.innerWidth - rect.width));
  top = Math.max(0, Math.min(top, window.innerHeight - rect.height));

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

/** Setup drag handlers for floating mode */
function setupDragHandlers(panel, handle) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // Only left click
    e.preventDefault();
    e.stopPropagation();

    const rect = panel.getBoundingClientRect();
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top
    };

    panel.classList.add('fa-nexus-launcher--dragging');
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  });

  function onDragMove(e) {
    if (!dragState) return;

    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;

    let newLeft = dragState.startLeft + dx;
    let newTop = dragState.startTop + dy;

    // Clamp to viewport
    const rect = panel.getBoundingClientRect();
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - rect.width));
    newTop = Math.max(0, Math.min(newTop, window.innerHeight - rect.height));

    panel.style.left = `${newLeft}px`;
    panel.style.top = `${newTop}px`;
  }

  function onDragEnd(e) {
    if (!dragState) return;

    panel.classList.remove('fa-nexus-launcher--dragging');
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);

    // Save final position
    const rect = panel.getBoundingClientRect();
    savePosition(rect.left, rect.top);

    dragState = null;
  }
}

/** Ensure the launcher button exists and wires the open handler. */
function ensureLauncher(onOpen) {
  // Only show launcher for GMs
  if (!game?.user?.isGM) return null;

  const floating = isFloatingMode();
  const existing = document.getElementById('fa-nexus-launcher');

  // If mode changed, remove existing and recreate
  if (existing) {
    const wasFloating = existing.classList.contains('fa-nexus-launcher--floating');
    if (wasFloating === floating) return existing;
    existing.remove();
  }

  const panel = document.createElement('div');
  panel.id = 'fa-nexus-launcher';
  panel.className = 'fa-nexus-launcher';

  if (floating) {
    panel.classList.add('fa-nexus-launcher--floating');
    panel.innerHTML = `
      <div class="fa-nexus-launcher-drag-handle" title="Drag to move">
      </div>
      <button type="button" class="fa-nexus-launch-btn ui-control" title="Open Nexus">
        <img src="modules/fa-nexus/images/Foundry_FA.png" alt="FA Icon" />
        <span>Nexus</span>
      </button>
    `;
  } else {
    panel.innerHTML = `
      <button type="button" class="fa-nexus-launch-btn ui-control" title="Open Nexus">
        <img src="modules/fa-nexus/images/Foundry_FA.png" alt="FA Icon" />
        <span>Nexus</span>
      </button>
    `;
  }

  const button = panel.querySelector('.fa-nexus-launch-btn');
  if (button) {
    const preserveTileSelection = (source) => {
      try { preserveCurrentTileSelectionForNexus(source); }
      catch (err) { Logger?.warn?.('Launcher.tileSelectionContext.preserveFailed', { source, error: String(err?.message || err) }); }
    };
    button.addEventListener('pointerdown', () => preserveTileSelection('launcher-pointerdown'), { capture: true });
    button.addEventListener('mousedown', () => preserveTileSelection('launcher-mousedown'), { capture: true });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      preserveTileSelection('launcher-click');
      try { onOpen?.(); }
      catch (err) { Logger?.warn?.('Launcher.open.failed', err); }
    });
  }

  if (floating) {
    // Floating mode: append to body with fixed positioning
    document.body.appendChild(panel);
    applyFloatingPosition(panel);

    // Setup drag on the handle
    const handle = panel.querySelector('.fa-nexus-launcher-drag-handle');
    if (handle) {
      setupDragHandlers(panel, handle);
    }
  } else {
    // Docked mode: insert before players list
    const players = document.getElementById('players');
    if (!players || !players.parentElement) return null;
    players.parentElement.insertBefore(panel, players);
  }

  try { applyThemeToElement(panel); }
  catch (err) { Logger?.warn?.('Launcher.theme.failed', err); }
  return panel;
}

/** Observe Foundry theme mutations and keep launcher/app in sync. */
function observeHostTheme() {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => {
    try {
      const panel = document.getElementById('fa-nexus-launcher');
      if (panel) applyThemeToElement(panel);
      const app = foundry.applications.instances.get('fa-nexus-app');
      if (app?.element) applyThemeToElement(app.element);
    } catch (err) {
      Logger?.warn?.('Launcher.theme.observeFailed', err);
    }
  });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function getHostTheme() {
  const body = document.body;
  const isDark = body.classList.contains('theme-dark');
  return isDark ? 'dark' : 'light';
}

export function applyThemeToElement(element) {
  if (!element) return;
  const theme = getHostTheme();
  element.classList.toggle('fa-theme-dark', theme === 'dark');
  element.classList.toggle('fa-theme-light', theme !== 'dark');
}

export function initializeNexusLauncher({ onOpen } = {}) {
  Hooks.once('ready', () => {
    try { ensureLauncher(onOpen); }
    catch (err) { Logger?.warn?.('Launcher.inject.failed', err); }

    try { observeHostTheme(); }
    catch (err) { Logger?.warn?.('Launcher.observe.failed', err); }

    // Listen for floating mode setting changes
    Hooks.on('updateSetting', (change) => {
      if (change?.namespace === MODULE_ID && change?.key === 'floatingLauncher') {
        try { ensureLauncher(onOpen); }
        catch (err) { Logger?.warn?.('Launcher.floatingToggle.failed', err); }
      }
    });
  });

  Hooks.on('renderPlayerList', () => {
    try { ensureLauncher(onOpen); }
    catch (err) { Logger?.warn?.('Launcher.inject.renderPlayerListFailed', err); }
  });
}
