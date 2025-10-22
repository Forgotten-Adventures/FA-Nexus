import { NexusLogger as Logger } from '../core/nexus-logger.js';

function ensureHeaderContent(header) {
  let headerContent = header.querySelector('.header-content');
  if (!headerContent) {
    headerContent = document.createElement('div');
    headerContent.className = 'header-content';
    const title = header.querySelector('.window-title');
    if (title) {
      addCustomIcon(title);
      updateTitleWithText(title);
      headerContent.appendChild(title);
    }
    header.insertBefore(headerContent, header.firstChild);
  } else {
    const title = headerContent.querySelector('.window-title');
    if (title) {
      updateTitleWithText(title);
    }
  }
  return headerContent;
}

function addCustomIcon(titleElement) {
  if (!titleElement) return;
  const existingIcon = titleElement.querySelector('.custom-fa-icon');
  if (existingIcon) existingIcon.remove();

  const icon = document.createElement('img');
  icon.className = 'custom-fa-icon';
  icon.src = 'modules/fa-nexus/images/cropped-FA-Icon-Plain-v2.png';
  icon.alt = 'FA Nexus';
  icon.title = 'Forgotten Adventures Nexus';
  titleElement.insertBefore(icon, titleElement.firstChild);
}

function updateTitleWithText(titleElement) {
  if (!titleElement) return;
  const customIcon = titleElement.querySelector('.custom-fa-icon');
  titleElement.innerHTML = '';
  if (customIcon) titleElement.appendChild(customIcon);
  const span = document.createElement('span');
  span.textContent = 'Nexus';
  titleElement.appendChild(span);
}

export function renderPatreonAuthHeader({ app, headerElement, getAuthService }) {
  try {
    const header = headerElement ?? app?.element?.querySelector('.window-header');
    if (!header) return;

    const headerContent = ensureHeaderContent(header);
    const existing = headerContent.querySelector('.header-patreon-auth');
    if (existing) existing.remove();

    const authContainer = document.createElement('div');
    authContainer.className = 'header-patreon-auth';
    authContainer.hidden = Boolean(app?.minimized);
    const preventDrag = (event) => {
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };

    const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
    const authService = getAuthService ? getAuthService() : null;

    if (auth && auth.authenticated) {
      const status = document.createElement('div');
      status.className = 'auth-status-display';
      const tier = String(auth.tier || 'vip');
      const src = String(auth.source || 'patreon:main');
      status.innerHTML = `<i class="fas fa-check-circle"></i><span class="auth-tier-text">${tier} supporter</span><span class="auth-source-text">(${src})</span>`;
      status.title = 'Click to disconnect';
      status.setAttribute('data-disconnect-handler', 'true');
      status.style.pointerEvents = 'auto';
      status.addEventListener('click', (event) => {
        event.preventDefault();
        try { authService?.handlePatreonDisconnect(app, true); }
        catch (err) { Logger.warn('AuthHeader.disconnect.failed', err); }
      });
      status.addEventListener('mousedown', preventDrag);
      status.addEventListener('pointerdown', preventDrag);
      authContainer.appendChild(status);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'patreon-connect-button';
      button.innerHTML = '<i class="fas fa-user-shield"></i><span>Connect Patreon</span>';
      button.style.pointerEvents = 'auto';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        try { authService?.handlePatreonConnect(app); }
        catch (err) { Logger.warn('AuthHeader.connect.failed', err); }
      });
      button.addEventListener('mousedown', preventDrag);
      button.addEventListener('pointerdown', preventDrag);
      authContainer.appendChild(button);
    }

    headerContent.appendChild(authContainer);
  } catch (err) {
    Logger.warn('AuthHeader.render.failed', err);
  }
}
