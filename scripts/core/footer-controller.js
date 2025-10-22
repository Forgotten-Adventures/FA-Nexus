import { NexusLogger as Logger } from './nexus-logger.js';
import { toolOptionsController } from './tool-options-controller.js';

/**
 * Manages shared footer controls for the Nexus application shell.
 */
export class FooterController {
  constructor({ app } = {}) {
    this.app = app;
    this._events = null;
    this._toolOptionsButton = null;
    this._boundToolOptionsClick = null;
    this._unregisterToolOptionsListener = null;
  }

  initialize(events) {
    this._events = events;
    this._ensureToolOptionsListener();
  }

  bindGlobalFooter() {
    try {
      const root = this.app?.element;
      if (!root) return;
      const button = root.querySelector('.fa-nexus-tool-options-button');
      if (this._toolOptionsButton && this._boundToolOptionsClick && this._toolOptionsButton !== button) {
        try { this._toolOptionsButton.removeEventListener('click', this._boundToolOptionsClick); } catch (_) {}
        this._toolOptionsButton = null;
      }
      if (!button) {
        if (this._toolOptionsButton && this._boundToolOptionsClick) {
          try { this._toolOptionsButton.removeEventListener('click', this._boundToolOptionsClick); } catch (_) {}
          this._toolOptionsButton = null;
        }
        return;
      }
      if (!this._boundToolOptionsClick) {
        this._boundToolOptionsClick = (event) => this._handleToolOptionsClick(event);
      }
      if (this._toolOptionsButton !== button) {
        button.addEventListener('click', this._boundToolOptionsClick);
        this._toolOptionsButton = button;
      }
      this._ensureToolOptionsListener();
      this._updateToolOptionsButtonState(toolOptionsController?.getWindowState?.());
    } catch (error) {
      Logger.warn('FooterController.bindGlobalFooter.failed', error);
    }
  }

  _handleToolOptionsClick(event) {
    try {
      event?.preventDefault?.();
      event?.stopPropagation?.();
    } catch (_) {}
    try {
      const opened = toolOptionsController?.reopenWindow?.({ focus: true });
      if (opened === false) {
        ui?.notifications?.warn?.('No active tool options are available right now.');
      }
      this._updateToolOptionsButtonState(toolOptionsController?.getWindowState?.());
    } catch (error) {
      Logger.warn('FooterController.toolOptions.openFailed', error);
    }
  }

  destroy() {
    if (this._toolOptionsButton && this._boundToolOptionsClick) {
      try { this._toolOptionsButton.removeEventListener('click', this._boundToolOptionsClick); } catch (_) {}
    }
    this._toolOptionsButton = null;
    this._boundToolOptionsClick = null;
    if (typeof this._unregisterToolOptionsListener === 'function') {
      try { this._unregisterToolOptionsListener(); } catch (_) {}
    }
    this._unregisterToolOptionsListener = null;
    this._events = null;
  }

  _ensureToolOptionsListener() {
    if (this._unregisterToolOptionsListener || typeof toolOptionsController?.addStateListener !== 'function') return;
    this._unregisterToolOptionsListener = toolOptionsController.addStateListener((state) => {
      this._updateToolOptionsButtonState(state);
    });
  }

  _updateToolOptionsButtonState(state) {
    const button = this._toolOptionsButton;
    if (!button) return;
    const hasActiveTool = !!state?.hasActiveTool;
    const isWindowOpen = !!state?.isWindowOpen;
    const shouldShow = hasActiveTool && !isWindowOpen;
    button.toggleAttribute('hidden', !shouldShow);
    button.disabled = !shouldShow;
    button.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  }
}
