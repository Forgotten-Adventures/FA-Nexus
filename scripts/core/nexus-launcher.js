import { NexusLogger as Logger } from './nexus-logger.js';

let themeObserver = null;

/** Ensure the launcher button exists and wires the open handler. */
function ensureLauncher(onOpen) {
  const existing = document.getElementById('fa-nexus-launcher');
  if (existing) return existing;

  const players = document.getElementById('players');
  if (!players || !players.parentElement) return null;

  const panel = document.createElement('div');
  panel.id = 'fa-nexus-launcher';
  panel.className = 'fa-nexus-launcher';
  panel.innerHTML = `
    <button type="button" class="fa-nexus-launch-btn ui-control" title="Open Nexus">
      <img src="modules/fa-nexus/images/Foundry_FA.png" alt="FA Icon" />
      <span>Nexus</span>
    </button>
  `;

  const button = panel.querySelector('.fa-nexus-launch-btn');
  if (button) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      try { onOpen?.(); }
      catch (err) { Logger?.warn?.('Launcher.open.failed', err); }
    });
  }

  players.parentElement.insertBefore(panel, players);
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
  });

  Hooks.on('renderPlayerList', () => {
    try { ensureLauncher(onOpen); }
    catch (err) { Logger?.warn?.('Launcher.inject.renderPlayerListFailed', err); }
  });
}
