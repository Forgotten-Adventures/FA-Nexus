import { NexusLogger as Logger } from '../nexus-logger.js';
import {
  GRID_SNAP_SUBDIV_SETTING_KEY,
  GRID_SNAP_SUBDIV_DEFAULT,
  normalizeGridSnapSubdivision,
  readGridSnapSubdivisionSetting
} from '../grid-snap-utils.js';
import { normalizeToolOptionsPayload } from '../tool-options-descriptor.js';
import {
  GRID_SNAP_SETTING_KEY,
  MODULE_ID,
  SECTIONS_SETTING_KEY,
  SHORTCUTS_SETTING_KEY
} from './shared.js';
import {
  buildToolHelpContext,
  ToolHelpWindow
} from './help.js';
import {
  buildCollapsedSectionState,
  didToolSectionLayoutChange,
  getToolSectionLayout as buildToolSectionLayout,
  isSectionCollapsed,
  sectionStatesEqual,
  serializeCollapsedSectionState,
  toggleSectionCollapseState
} from './sections.js';

const { ApplicationV2 } = foundry.applications.api;

export class ToolOptionsController {
  constructor({ ToolOptionsWindowClass = null } = {}) {
    this._ToolOptionsWindowClass = ToolOptionsWindowClass;
    this._window = null;
    this._helpWindow = null;
    this._activeTools = new Map();
    this._sectionCollapsedByTool = new Map();
    this._needsGridSnapResync = false;
    this._gridSnapEnabled = this._readGridSnapSetting();
    this._needsGridSnapSubdivResync = false;
    this._gridSnapSubdivisions = this._readGridSnapSubdivisionSetting();
    this._settingsHook = null;
    this._settingsAvailable = this._canAccessSettings();
    this._restoreSectionState();
    this._ensureSettingsListener();
    this._toolOptions = new Map();
    this._stateListeners = new Set();
  }

  activateTool(toolId, { label } = {}) {
    if (!toolId) return;
    const id = String(toolId);
    const entry = { id, label: label ? String(label) : id };
    this._activeTools.set(id, entry);
    const win = this._ensureWindow();
    const options = this._getToolState(id);
    if (options) win.setActiveToolOptions(options, { suppressRender: true });
    else win.setActiveToolOptions({}, { suppressRender: true });
    win.setActiveTool(entry);
    if (!win.rendered) win.render(true);
    else win.render(false);
    try { win.bringToFront?.(); } catch (_) {}
    this._syncHelpWindow({ suppressRender: false });
    this._notifyStateListeners();
  }

  updateTool(toolId, { label } = {}) {
    if (!toolId || !this._activeTools.has(String(toolId))) return;
    const id = String(toolId);
    const existing = this._activeTools.get(id);
    const next = {
      id,
      label: label ? String(label) : (existing?.label ?? id)
    };
    this._activeTools.set(id, next);
    if (this._window) this._window.setActiveTool(next);
    this._syncHelpWindow({ suppressRender: false });
    this._notifyStateListeners();
  }

  deactivateTool(toolId) {
    if (!toolId) return;
    const id = String(toolId);
    const current = this._window?.activeTool?.id ?? null;
    const removed = this._activeTools.delete(id);

    if (!removed) {
      this._notifyStateListeners();
      return;
    }

    if (!this._activeTools.size) {
      if (this._helpWindow?.rendered) {
        try { this._helpWindow.close({ animate: false }); } catch (_) {}
      } else {
        this._helpWindow = null;
      }
      if (this._window?.rendered) {
        try { this._window.close({ animate: false }); } catch (_) {}
      } else if (this._window) {
        try { this._window.setActiveTool(null); } catch (_) {}
        this._window = null;
      }
      this._notifyStateListeners();
      return;
    }

    if (current === id) {
      const [, lastEntry] = Array.from(this._activeTools).pop() || [];
      if (lastEntry) this._window?.setActiveTool(lastEntry);
      else if (this._window) {
        try { this._window.setActiveTool(null); } catch (_) {}
      }
    }
    this._syncHelpWindow({ suppressRender: false });
    this._notifyStateListeners();
  }

  _ensureWindow() {
    if (this._window) return this._window;
    const ToolOptionsWindowClass = this._ToolOptionsWindowClass;
    if (typeof ToolOptionsWindowClass !== 'function') {
      throw new Error('ToolOptionsController requires ToolOptionsWindowClass.');
    }
    const available = this.supportsGridSnap();
    this._window = new ToolOptionsWindowClass({
      controller: this,
      gridSnapEnabled: this._gridSnapEnabled,
      gridSnapAvailable: available,
      gridSnapSubdivisions: this._gridSnapSubdivisions,
      toolOptions: this._getToolState(null)
    });
    return this._window;
  }

  setToolOptions(toolId, payload = {}) {
    if (!toolId) return;
    const id = String(toolId);
    const previous = this._toolOptions.get(id);
    const normalized = normalizeToolOptionsPayload(id, payload);
    this._toolOptions.set(id, {
      state: normalized.state,
      handlers: normalized.handlers,
      normalized: normalized.normalized
    });
    if (this._window && this._window.activeTool?.id === id) {
      this._window.setActiveToolOptions(normalized.state, { suppressRender: normalized.suppressRender });
      const needsLayoutRender = this._window.rendered
        && this._didSectionLayoutChange(previous?.normalized || null, normalized.normalized || null);
      if (needsLayoutRender && normalized.suppressRender) {
        this._window.render(false);
      } else {
        this._window.refreshToolSections?.();
      }
    }
    if (this._helpWindow && this._getActiveToolId() === id) {
      this._syncHelpWindow({ suppressRender: normalized.suppressRender });
    }
  }

  reopenWindow({ focus = true } = {}) {
    if (!this._activeTools.size) {
      this._notifyStateListeners();
      return false;
    }
    const win = this._ensureWindow();
    let entry = null;
    const activeId = win?.activeTool?.id;
    if (activeId && this._activeTools.has(activeId)) {
      entry = this._activeTools.get(activeId);
    } else {
      const entries = Array.from(this._activeTools.values());
      entry = entries.length ? entries[entries.length - 1] : null;
    }
    if (entry) {
      const state = this._getToolState(entry.id);
      if (state) win.setActiveToolOptions(state, { suppressRender: true });
      else win.setActiveToolOptions({}, { suppressRender: true });
      win.setActiveTool(entry);
    } else {
      win.setActiveToolOptions({}, { suppressRender: true });
      try { win.setActiveTool(null); } catch (_) {}
    }
    if (!win.rendered) win.render(true);
    else win.render(false);
    if (win?.minimized) {
      try { win.maximize(); } catch (_) {}
    }
    if (focus) {
      try { win.bringToFront?.(); } catch (_) {}
    }
    this._syncHelpWindow({ suppressRender: false });
    this._notifyStateListeners();
    return true;
  }

  getGridSnapSubdivisions() {
    return this._gridSnapSubdivisions;
  }

  isGridSnapEnabled() {
    return !!this._gridSnapEnabled;
  }

  toggleGridSnapShortcut() {
    return this.requestGridSnapToggle(!this._gridSnapEnabled);
  }

  nudgeGridSnapSubdivision(delta = 0) {
    const next = this._normalizeGridSnapSubdivisionValue(this._gridSnapSubdivisions + (Number(delta) || 0));
    if (next === this._gridSnapSubdivisions) return true;
    return this.requestGridSnapSubdivisionChange(next);
  }

  requestDropShadowToggle(enabled) {
    const activeId = this._window?.activeTool?.id;
    if (!activeId) return false;
    const handler = this._getToolHandlers(activeId).setDropShadowEnabled;
    if (typeof handler !== 'function') return false;
    try {
      const result = handler(enabled);
      if (result?.then) return result;
      return result;
    } catch (_) {
      return false;
    }
  }

  requestCustomToggle(toggleId, enabled) {
    const activeId = this._window?.activeTool?.id;
    if (!activeId || !toggleId) return false;
    const customHandlers = this._getToolHandlers(activeId).customToggles || {};
    const handler = customHandlers?.[toggleId];
    if (typeof handler !== 'function') return false;
    try {
      const result = handler(enabled);
      if (result?.then) return result;
      return result;
    } catch (_) {
      return false;
    }
  }

  invokeToolHandler(handlerName, ...args) {
    if (!handlerName) return false;
    const activeId = this._window?.activeTool?.id;
    if (!activeId) return false;
    const handler = this._getToolHandlers(activeId)?.[handlerName];
    if (typeof handler !== 'function') return false;
    try {
      const result = handler(...args);
      if (result?.then) {
        return result.catch((error) => {
          Logger.error('ToolOptionsController.handler.failed', {
            toolId: activeId,
            handlerName,
            error: String(error?.message || error)
          });
          throw error;
        });
      }
      return result;
    } catch (error) {
      Logger.error('ToolOptionsController.handler.failed', {
        toolId: activeId,
        handlerName,
        error: String(error?.message || error)
      });
      return false;
    }
  }

  updateDropShadowPreview(toolId, preview) {
    if (!toolId) return;
    const id = String(toolId);
    if (!this._toolOptions.has(id)) return;
    const entry = this._toolOptions.get(id);
    if (!entry || typeof entry !== 'object') return;
    const state = entry.state && typeof entry.state === 'object' ? entry.state : {};
    const controls = state.dropShadowControls && typeof state.dropShadowControls === 'object'
      ? state.dropShadowControls
      : {};
    const normalized = preview && typeof preview === 'object' && typeof preview.src === 'string' && preview.src.length > 0
      ? {
          src: preview.src,
          width: Number.isFinite(preview.width) ? Number(preview.width) : null,
          height: Number.isFinite(preview.height) ? Number(preview.height) : null,
          signature: typeof preview.signature === 'string' ? preview.signature : null,
          updatedAt: Number.isFinite(preview.updatedAt) ? Number(preview.updatedAt) : Date.now(),
          alt: typeof preview.alt === 'string' ? preview.alt : ''
        }
      : null;
    if (normalized) controls.preview = normalized;
    else delete controls.preview;
    state.dropShadowControls = controls;
    entry.state = state;
    this._toolOptions.set(id, entry);
    if (this._window?.activeTool?.id === id) {
      this._window.applyDropShadowPreview(normalized);
    }
  }

  _getToolState(toolId) {
    if (!toolId) return {};
    return this._toolOptions.get(String(toolId))?.state || {};
  }

  _getToolHandlers(toolId) {
    if (!toolId) return {};
    return this._toolOptions.get(String(toolId))?.handlers || {};
  }

  _getToolNormalized(toolId) {
    if (!toolId) return null;
    return this._toolOptions.get(String(toolId))?.normalized || null;
  }

  _getActiveToolId() {
    const activeId = this._window?.activeTool?.id;
    if (activeId) return activeId;
    const keys = Array.from(this._activeTools.keys());
    return keys.length ? keys[keys.length - 1] : null;
  }

  _getToolLabel(toolId) {
    const id = String(toolId || '');
    if (!id) return '';
    const active = this._activeTools.get(id);
    if (active?.label) return String(active.label);
    const normalized = this._getToolNormalized(id);
    const descriptorLabel = normalized?.descriptor?.toolLabel;
    return typeof descriptorLabel === 'string' && descriptorLabel.trim().length
      ? descriptorLabel.trim()
      : id;
  }

  _sectionStatesEqual(next) {
    return sectionStatesEqual(this._sectionCollapsedByTool, next);
  }

  _restoreSectionState() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.get !== 'function') return;
    try {
      const saved = settings.get(MODULE_ID, SECTIONS_SETTING_KEY);
      this._applySectionSetting(saved);
    } catch (error) {
      Logger.warn('ToolOptionsController.sectionState.restoreFailed', error);
    }
  }

  _applySectionSetting(raw) {
    const next = buildCollapsedSectionState(raw);
    if (this._sectionStatesEqual(next)) return false;

    this._sectionCollapsedByTool.clear();
    for (const [toolId, collapsedSections] of next.entries()) {
      this._sectionCollapsedByTool.set(toolId, collapsedSections);
    }
    return true;
  }

  applySectionSetting(raw) {
    const changed = this._applySectionSetting(raw);
    if (changed) this._window?.refreshToolSections?.();
  }

  _persistSectionState() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.set !== 'function') return;
    try {
      const payload = serializeCollapsedSectionState(this._sectionCollapsedByTool);
      const maybePromise = settings.set(MODULE_ID, SECTIONS_SETTING_KEY, payload);
      if (maybePromise?.catch) {
        maybePromise.catch((error) => {
          Logger.warn('ToolOptionsController.sectionState.persistFailed', error);
        });
      }
    } catch (error) {
      Logger.warn('ToolOptionsController.sectionState.persistFailed', error);
    }
  }

  _isSectionCollapsed(toolId, sectionId) {
    return isSectionCollapsed(this._sectionCollapsedByTool, toolId, sectionId);
  }

  toggleSectionCollapse(toolId, sectionId) {
    const collapsed = toggleSectionCollapseState(this._sectionCollapsedByTool, toolId, sectionId);
    this._persistSectionState();
    return collapsed;
  }

  getToolSectionLayout(toolId = null) {
    return buildToolSectionLayout({
      toolId,
      activeToolId: this._getActiveToolId(),
      getToolNormalized: (id) => this._getToolNormalized(id),
      getToolState: (id) => this._getToolState(id),
      isSectionCollapsed: (id, sectionId) => this._isSectionCollapsed(id, sectionId)
    });
  }

  _didSectionLayoutChange(previousNormalized, nextNormalized) {
    return didToolSectionLayoutChange(previousNormalized, nextNormalized);
  }

  getToolHelpContext(toolId = null) {
    return buildToolHelpContext({
      toolId,
      activeToolId: this._getActiveToolId(),
      getToolNormalized: (id) => this._getToolNormalized(id),
      getToolState: (id) => this._getToolState(id),
      getToolLabel: (id) => this._getToolLabel(id),
      getToolSectionLayout: (id) => this.getToolSectionLayout(id)
    });
  }

  openActiveToolHelp({ focus = true } = {}) {
    const helpContext = this.getToolHelpContext();
    if (!helpContext?.available) return false;
    if (!this._helpWindow) {
      this._helpWindow = new ToolHelpWindow({
        controller: this,
        helpContext
      });
    } else {
      this._helpWindow.setHelpContext(helpContext, { suppressRender: true });
    }
    if (!this._helpWindow.rendered) this._helpWindow.render(true);
    else this._helpWindow.render(false);
    if (focus) {
      try { this._helpWindow.bringToFront?.(); } catch (_) {}
    }
    return true;
  }

  _syncHelpWindow({ suppressRender = false } = {}) {
    if (!this._helpWindow) return;
    if (this._helpWindow.state === ApplicationV2.RENDER_STATES.CLOSING) return;
    const helpContext = this.getToolHelpContext();
    if (!helpContext?.available) {
      if (this._helpWindow.rendered) {
        try { this._helpWindow.close({ animate: false }); } catch (_) {}
      } else {
        this._helpWindow = null;
      }
      return;
    }
    this._helpWindow.setHelpContext(helpContext, { suppressRender });
    if (!this._helpWindow.rendered) this._helpWindow.render(true);
  }

  supportsGridSnap() {
    this._ensureSettingsListener();
    const available = this._canAccessSettings();
    const availabilityChanged = this._settingsAvailable !== available;
    if (availabilityChanged) {
      this._settingsAvailable = available;
      if (!available) {
        if (this._window) this._window.setGridSnapAvailable(false);
      }
    }
    if (available && (availabilityChanged || this._needsGridSnapResync)) {
      const stored = this._readGridSnapSetting();
      this._updateGridSnapState(stored, { syncWindow: true });
    }
    if (available && (availabilityChanged || this._needsGridSnapSubdivResync)) {
      const storedSubdiv = this._readGridSnapSubdivisionSetting();
      this._updateGridSnapSubdivisionsState(storedSubdiv, { syncWindow: true });
    }
    if (this._window) this._window.setGridSnapAvailable(available);
    return available;
  }

  isGridSnapSettingAvailable() {
    return this._settingsAvailable;
  }

  async requestGridSnapToggle(enabled) {
    const next = !!enabled;
    const previous = !!this._gridSnapEnabled;
    const canPersist = this.supportsGridSnap();
    this._updateGridSnapState(next, { syncWindow: true });
    if (!canPersist) return true;
    try {
      await game.settings.set(MODULE_ID, GRID_SNAP_SETTING_KEY, next);
      return true;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnap.saveFailed', error);
      this._updateGridSnapState(previous, { syncWindow: true });
      try {
        ui?.notifications?.warn?.('Failed to update grid snapping. Please try again.');
      } catch (_) {}
      return false;
    }
  }

  async requestGridSnapSubdivisionChange(value) {
    const next = this._normalizeGridSnapSubdivisionValue(value);
    const canPersist = this.supportsGridSnap();
    const previous = this._gridSnapSubdivisions;
    if (next === previous) {
      if (!canPersist) return true;
      try {
        await game.settings.set(MODULE_ID, GRID_SNAP_SUBDIV_SETTING_KEY, next);
        return true;
      } catch (error) {
        Logger.warn('ToolOptionsController.gridSnapSubdiv.saveFailed', error);
        try {
          ui?.notifications?.warn?.('Failed to update snap density. Please try again.');
        } catch (_) {}
        return false;
      }
    }
    this._updateGridSnapSubdivisionsState(next, { syncWindow: true });
    if (!canPersist) return true;
    try {
      await game.settings.set(MODULE_ID, GRID_SNAP_SUBDIV_SETTING_KEY, next);
      return true;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnapSubdiv.saveFailed', error);
      this._updateGridSnapSubdivisionsState(previous, { syncWindow: true });
      try {
        ui?.notifications?.warn?.('Failed to update snap density. Please try again.');
      } catch (_) {}
      return false;
    }
  }

  _ensureSettingsListener() {
    if (this._settingsHook || !globalThis?.Hooks || typeof globalThis.Hooks.on !== 'function') return;
    const handler = (setting) => this._handleSettingUpdated(setting);
    try {
      globalThis.Hooks.on('updateSetting', handler);
      this._settingsHook = handler;
    } catch (error) {
      Logger.warn('ToolOptionsController.settingsHookFailed', error);
      this._settingsHook = null;
    }
  }

  _handleSettingUpdated(setting) {
    if (!setting || setting.namespace !== MODULE_ID) return;
    if (setting.key === GRID_SNAP_SETTING_KEY) {
      this._updateGridSnapState(!!setting.value, { syncWindow: true });
      return;
    }
    if (setting.key === GRID_SNAP_SUBDIV_SETTING_KEY) {
      this._updateGridSnapSubdivisionsState(setting.value, { syncWindow: true });
      return;
    }
    if (setting.key === SECTIONS_SETTING_KEY) {
      this.applySectionSetting(setting.value);
      return;
    }
    if (setting.key === SHORTCUTS_SETTING_KEY) {
      this._window?.applyShortcutsSetting?.(setting.value);
    }
  }

  _updateGridSnapState(value, { syncWindow = false } = {}) {
    const next = !!value;
    if (this._gridSnapEnabled === next) {
      if (syncWindow && this._window) this._window.setGridSnapEnabled(next);
      return;
    }
    this._gridSnapEnabled = next;
    if (syncWindow && this._window) this._window.setGridSnapEnabled(next);
    try {
      const hooks = globalThis?.Hooks;
      hooks?.callAll?.('fa-nexus:gridSnapChanged', next);
    } catch (_) {}
  }

  _normalizeGridSnapSubdivisionValue(value) {
    return normalizeGridSnapSubdivision(value);
  }

  _updateGridSnapSubdivisionsState(value, { syncWindow = false } = {}) {
    const next = this._normalizeGridSnapSubdivisionValue(value);
    if (this._gridSnapSubdivisions === next) {
      if (syncWindow && this._window) this._window.setGridSnapSubdivisions(next);
      return;
    }
    this._gridSnapSubdivisions = next;
    if (syncWindow && this._window) this._window.setGridSnapSubdivisions(next);
    try {
      const hooks = globalThis?.Hooks;
      hooks?.callAll?.('fa-nexus:gridSnapSubdivisionsChanged', { value: next });
    } catch (_) {}
  }

  _readGridSnapSetting() {
    if (!this._canAccessSettings()) {
      this._needsGridSnapResync = true;
      return true;
    }
    try {
      const value = !!game.settings.get(MODULE_ID, GRID_SNAP_SETTING_KEY);
      this._needsGridSnapResync = false;
      return value;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnap.readFailed', error);
      this._needsGridSnapResync = true;
      return true;
    }
  }

  _readGridSnapSubdivisionSetting() {
    if (!this._canAccessSettings()) {
      this._needsGridSnapSubdivResync = true;
      return GRID_SNAP_SUBDIV_DEFAULT;
    }
    try {
      const value = readGridSnapSubdivisionSetting();
      this._needsGridSnapSubdivResync = false;
      return value;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnapSubdiv.readFailed', error);
      this._needsGridSnapSubdivResync = true;
      return GRID_SNAP_SUBDIV_DEFAULT;
    }
  }

  _canAccessSettings() {
    const settings = globalThis?.game?.settings;
    return !!(settings && typeof settings.get === 'function' && typeof settings.set === 'function');
  }

  _handleWindowClosed(instance) {
    if (this._window === instance) {
      this._window = null;
    }
    if (this._helpWindow?.rendered) {
      try { this._helpWindow.close({ animate: false }); } catch (_) {}
    } else {
      this._helpWindow = null;
    }
    this._notifyStateListeners();
  }

  _handleHelpWindowClosing(instance) {
    if (this._helpWindow === instance) this._helpWindow = null;
  }

  _handleHelpWindowClosed(instance) {
    if (this._helpWindow === instance) this._helpWindow = null;
  }

  addStateListener(listener) {
    if (typeof listener !== 'function') return () => {};
    this._stateListeners.add(listener);
    try {
      listener(this.getWindowState());
    } catch (_) {}
    return () => {
      this._stateListeners.delete(listener);
    };
  }

  getWindowState() {
    return this._collectStateSnapshot();
  }

  _collectStateSnapshot() {
    return {
      hasActiveTool: this._activeTools.size > 0,
      isWindowOpen: !!this._window,
      activeToolId: this._window?.activeTool?.id ?? null
    };
  }

  _notifyStateListeners() {
    if (!this._stateListeners.size) return;
    const snapshot = this._collectStateSnapshot();
    for (const listener of this._stateListeners) {
      try {
        listener(snapshot);
      } catch (_) {}
    }
  }
}
