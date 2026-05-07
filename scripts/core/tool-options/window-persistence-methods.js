import { NexusLogger as Logger } from '../nexus-logger.js';
import { MODULE_ID, TOOL_WINDOW_SETTING_KEY } from './shared.js';

class ToolOptionsWindowPersistenceMethods {
  _persistWindowPosition() {
    if (this._restoringPosition) return;
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.set !== 'function') return;
    try {
      const pos = this.position;
      if (!pos) return;
      const state = {};
      if (Number.isFinite(pos.left)) state.left = pos.left;
      if (Number.isFinite(pos.top)) state.top = pos.top;
      if (Number.isFinite(pos.width)) state.width = pos.width;
      if (Number.isFinite(pos.height)) state.height = pos.height;
      if (!Object.keys(state).length) return;
      const maybePromise = settings.set(MODULE_ID, TOOL_WINDOW_SETTING_KEY, state);
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch (_) {}
  }

  _handleResizeObserverStart(event) {
    if (!event?.target?.closest?.('.window-resizable-handle')) return;
    this._userResizing = true;
  }

  _handleResizeObserverEnd() {
    this._userResizing = false;
    this._savedHeight = this.position?.height || this._savedHeight;
  }

  _setupResizeObserver() {
    if (this._resizeObserver) return;
    try {
      const frame = this.element?.querySelector('.window-frame');
      if (!frame) return;
      this._resizeObserverFrame = frame;

      this._resizeObserver = new ResizeObserver((entries) => {
        if (this._userResizing || !this._savedHeight) return;

        for (const entry of entries) {
          const { height } = entry.contentRect;
          if (Math.abs(height - this._savedHeight) > 10) { // Allow some tolerance
            // Height changed significantly, likely due to auto-sizing
            this._forceSavedHeight();
            break;
          }
        }
      });
      this._resizeObserver.observe(frame);

      frame.addEventListener('mousedown', this._boundResizeObserverStart);
      frame.addEventListener('touchstart', this._boundResizeObserverStart);
      document.addEventListener('mouseup', this._boundResizeObserverEnd);
      document.addEventListener('touchend', this._boundResizeObserverEnd);

    } catch (error) {
      Logger.warn('ToolOptionsWindow.resizeObserver.setupFailed', error);
    }
  }

  _cleanupResizeObserver() {
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch (_) {}
      this._resizeObserver = null;
    }
    if (this._resizeObserverFrame) {
      try { this._resizeObserverFrame.removeEventListener('mousedown', this._boundResizeObserverStart); } catch (_) {}
      try { this._resizeObserverFrame.removeEventListener('touchstart', this._boundResizeObserverStart); } catch (_) {}
      this._resizeObserverFrame = null;
    }
    try { document.removeEventListener('mouseup', this._boundResizeObserverEnd); } catch (_) {}
    try { document.removeEventListener('touchend', this._boundResizeObserverEnd); } catch (_) {}
    this._userResizing = false;
    this._savedHeight = null;
  }

}

export function installToolOptionsWindowPersistenceMethods(ToolOptionsWindowClass) {
  const descriptors = Object.getOwnPropertyDescriptors(ToolOptionsWindowPersistenceMethods.prototype);
  delete descriptors.constructor;
  Object.defineProperties(ToolOptionsWindowClass.prototype, descriptors);
}
