import {
  GAP_KIND_DOOR,
  GAP_KIND_GAP,
  GAP_KIND_SEAMLESS_SECRET_DOOR,
  GAP_KIND_WINDOW,
  PORTAL_TEXTURE_MISSING_RETRY_MS,
  PORTAL_TYPES
} from './constants.js';
import {
  hasSmallPortalTextureToken,
  isSmallPortalTexturePath,
  parsePortalTextureGridWidth
} from '../../portals/portal-texture-path.js';
import { normalizePortalTextureWidthScale } from '../../portals/portal-texture-scale.js';
import { applyHsbcToImageData, isNeutralHsbc } from '../../core/hsbc.js';
import { positionBuildingV2DoorFramePillars } from '../v2/building-v2-door-frame.js';

const VALID_PORTAL_TYPES = Object.freeze([
  'opening',
  GAP_KIND_DOOR,
  GAP_KIND_WINDOW,
  GAP_KIND_SEAMLESS_SECRET_DOOR
]);

export const portalPanelMethods = {
  _updatePortalPanelVisibility(show) {
    this._registerPortalToolOptionsCallback();
    if (show) {
      this._ensurePortalPanel();
      if (this._portalPanel) {
        this._portalPanel.classList.remove('is-hidden');
        this._updatePortalPanelState();
      }
      this._registerPortalToolOptionsCallback();
    } else {
      if (this._portalPanel) {
        this._portalPanel.classList.add('is-hidden');
      }
    }
  },

  _registerPortalToolOptionsCallback() {
    if (this._portalToolOptionsCallback) return;
    const manager = this._buildingManager;
    if (!manager || typeof manager.setToolOptionsChangeCallback !== 'function') return;

    this._portalToolOptionsCallback = (state) => {
      this.syncFillSelectionFromToolOptions(state);
      const portalState = this._getPortalPanelState();
      if (portalState?.supportedKinds) {
        const subtab = portalState.portalMode ? 'portals' : 'building';
        if (this._activeSubtab !== subtab) this._setActiveSubtab(subtab, { fromEditor: true });
      }
      if (this._activeSubtab !== 'portals' || !this._portalPanel) return;
      const canUsePortals = this._canUsePortals();
      if (this._portalPanelCanUse !== canUsePortals) {
        this._portalPanelCanUse = canUsePortals;
        this._portalPreviewSignature = null;
        this._updatePortalPanelState();
        if (canUsePortals) this._refreshPortalTextureThumbnails();
        return;
      }
      const nextKind = portalState?.activeKind || this._resolvePortalKindFromState(state);
      if (nextKind && nextKind !== this._activePortalType) {
        this._activePortalType = nextKind;
        this._updatePortalPanelState();
        return;
      }
      this._refreshPortalTextureThumbnails();
    };
    this._portalToolOptionsCallbackDisposer = manager.setToolOptionsChangeCallback(this._portalToolOptionsCallback);
  },

  _unregisterPortalToolOptionsCallback() {
    if (!this._portalToolOptionsCallback) return;
    const disposer = this._portalToolOptionsCallbackDisposer;
    if (typeof disposer === 'function') {
      disposer();
    } else {
      const manager = this._buildingManager;
      if (manager && typeof manager.setToolOptionsChangeCallback === 'function') {
        manager.setToolOptionsChangeCallback(null);
      }
    }
    this._portalToolOptionsCallbackDisposer = null;
    this._portalToolOptionsCallback = null;
  },

  _getPortalPanelState() {
    return this._buildingManager?.getPortalPanelState?.() || null;
  },

  _ensurePortalPanel() {
    const wrapper = this._gridWrapper;
    if (!wrapper) return;
    if (this._portalPanel && wrapper.contains(this._portalPanel)) {
      return;
    }
    const panel = document.createElement('div');
    panel.className = 'fa-portals-panel';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Portal placement options');

    const canUsePortals = this._canUsePortals();
    this._portalPanelCanUse = canUsePortals;
    if (!canUsePortals) {
      panel.innerHTML = `
        <div class="fa-portals-panel__blocker">
          <i class="fas fa-info-circle" aria-hidden="true"></i>
          <span>Start a wall session first</span>
          <p class="fa-portals-panel__hint">Select a wall path from the Walls tab to begin.</p>
        </div>
      `;
    } else {
      panel.innerHTML = this._buildPortalPanelContent();
    }

    const subtabContainer = wrapper.querySelector('.fa-buildings-subtabs');
    if (subtabContainer && subtabContainer.nextSibling) {
      wrapper.insertBefore(panel, subtabContainer.nextSibling);
    } else {
      wrapper.appendChild(panel);
    }

    this._portalPanel = panel;
    if (canUsePortals) {
      this._bindPortalPanelHandlers();
    }
  },

  _resolvePortalKindFromState(state) {
    if (!state || !state.portalMode) return null;
    if (state.doorControls) return GAP_KIND_DOOR;
    if (state.windowControls) return GAP_KIND_WINDOW;
    if (state.seamlessSecretDoorControls) return GAP_KIND_SEAMLESS_SECRET_DOOR;
    return null;
  },

  _buildPortalPanelContent() {
    const supportedKinds = this._getPortalPanelState()?.supportedKinds;
    const types = supportedKinds ? [
      ...Object.values(PORTAL_TYPES),
      { id: 'opening', label: 'Opening', icon: 'fa-door-open', tooltip: 'Create an open passage with an optional frame' }
    ] : Object.values(PORTAL_TYPES);
    const activeType = this._activePortalType || GAP_KIND_DOOR;

    const buttonsHtml = types.map((type) => `
      <button type="button"
              class="fa-portals-panel__type-btn${type.id === activeType ? ' is-active' : ''}"
              data-portal-type="${type.id}"
              ${supportedKinds && !supportedKinds.includes(type.id) ? 'disabled aria-disabled="true"' : ''}
              title="${type.tooltip}"
              aria-pressed="${type.id === activeType}">
        <i class="fas ${type.icon}" aria-hidden="true"></i>
        <span>${type.label}</span>
      </button>
    `).join('');

    const texturesHtml = this._buildPortalTexturesHtml(activeType);

    return `
      <div class="fa-portals-panel__types" role="radiogroup" aria-label="Portal type selection">
        ${buttonsHtml}
      </div>
      <div class="fa-portals-panel__textures" data-portal-textures>
        ${texturesHtml}
      </div>
    `;
  },

  _buildPortalTexturesHtml(portalType) {
    if (portalType === GAP_KIND_GAP || portalType === 'opening') {
      if (this._getPortalPanelState()?.supportedTexturePickers?.includes('opening-frame')) return `
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Opening Frame</span>
          <div class="fa-portals-panel__thumb-wrap">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="opening-frame" title="Select opening frame" aria-label="Select opening frame">
              <i class="fas fa-border-all" aria-hidden="true"></i>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="opening-frame" title="Clear opening frame" aria-label="Clear opening frame">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
          <span class="fa-portals-panel__hint">Optional frame around an open passage.</span>
        </div>`;
      return `
        <div class="fa-portals-panel__texture-hint">
          <i class="fas fa-info-circle" aria-hidden="true"></i>
          <span>Openings create empty spaces in walls without textures.</span>
        </div>
      `;
    }

    if (portalType === GAP_KIND_DOOR) {
      return `
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Door Texture</span>
          <div class="fa-portals-panel__thumb-wrap" data-has-texture="false">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="door" title="Click to select door texture" aria-label="Select door texture">
              <div class="fa-portals-panel__thumb-placeholder">
                <i class="fas fa-door-closed" aria-hidden="true"></i>
                <span>Select...</span>
              </div>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="door" title="Clear door texture" aria-label="Clear door texture">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Door Frame</span>
          <div class="fa-portals-panel__thumb-wrap" data-has-texture="false">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="door-frame" title="Click to select door frame texture" aria-label="Select door frame texture">
              <div class="fa-portals-panel__thumb-placeholder">
                <i class="fas fa-border-all" aria-hidden="true"></i>
                <span>Select...</span>
              </div>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="door-frame" title="Clear door frame texture" aria-label="Clear door frame texture">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="fa-portals-panel__preview" data-portal-preview="door">
          <span class="fa-portals-panel__preview-label">Preview</span>
          <div class="fa-portals-panel__preview-frame">
            <canvas class="fa-portals-panel__preview-canvas" width="280" height="120"></canvas>
            <div class="fa-portals-panel__preview-placeholder">
              <i class="fas fa-eye" aria-hidden="true"></i>
              <span>Select textures to preview</span>
            </div>
          </div>
        </div>
      `;
    }

    if (portalType === GAP_KIND_WINDOW) {
      return `
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Window Sill</span>
          <div class="fa-portals-panel__thumb-wrap" data-has-texture="false">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="window-sill" title="Click to select window sill texture" aria-label="Select window sill texture">
              <div class="fa-portals-panel__thumb-placeholder">
                <i class="fas fa-layer-group" aria-hidden="true"></i>
                <span>Select...</span>
              </div>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="window-sill" title="Clear window sill texture" aria-label="Clear window sill texture">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Window Glass</span>
          <div class="fa-portals-panel__thumb-wrap" data-has-texture="false">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="window-texture" title="Click to select window texture" aria-label="Select window texture">
              <div class="fa-portals-panel__thumb-placeholder">
                <i class="fas fa-border-all" aria-hidden="true"></i>
                <span>Select...</span>
              </div>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="window-texture" title="Clear window texture" aria-label="Clear window texture">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="fa-portals-panel__texture-group">
          <span class="fa-portals-panel__texture-label">Window Frame</span>
          <div class="fa-portals-panel__thumb-wrap" data-has-texture="false">
            <button type="button" class="fa-portals-panel__texture-thumb" data-portal-picker="window-frame" title="Click to select window frame texture" aria-label="Select window frame texture">
              <div class="fa-portals-panel__thumb-placeholder">
                <i class="fas fa-columns" aria-hidden="true"></i>
                <span>Select...</span>
              </div>
            </button>
            <button type="button" class="fa-portals-panel__texture-clear" data-portal-clear="window-frame" title="Clear window frame texture" aria-label="Clear window frame texture">
              <i class="fas fa-times" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="fa-portals-panel__preview" data-portal-preview="window">
          <span class="fa-portals-panel__preview-label">Preview</span>
          <div class="fa-portals-panel__preview-frame">
            <canvas class="fa-portals-panel__preview-canvas" width="280" height="120"></canvas>
            <div class="fa-portals-panel__preview-placeholder">
              <i class="fas fa-eye" aria-hidden="true"></i>
              <span>Select textures to preview</span>
            </div>
          </div>
        </div>
      `;
    }

    if (portalType === GAP_KIND_SEAMLESS_SECRET_DOOR) {
      return `
        <div class="fa-portals-panel__texture-hint fa-portals-panel__texture-hint--seamless">
          <i class="fas fa-user-secret" aria-hidden="true"></i>
          <span>Seamless Secret Door artwork matches the exact Wall span. Animation opens the concealed passage.</span>
        </div>
        ${this._getPortalPanelState()?.supportedTexturePickers?.includes('opening-frame') ? this._buildPortalTexturesHtml('opening').replaceAll('Opening Frame', 'Optional Frame').replaceAll('open passage', 'secret door') : ''}
        <div class="fa-portals-panel__preview" data-portal-preview="seamlessSecretDoor">
          <span class="fa-portals-panel__preview-label">Wall-derived preview</span>
          <div class="fa-portals-panel__preview-frame">
            <div class="fa-portals-panel__preview-placeholder">
              <i class="fas fa-eye" aria-hidden="true"></i>
              <span>Move over a straight wall span to preview</span>
            </div>
          </div>
        </div>
      `;
    }

    return '';
  },

  _bindPortalPanelHandlers() {
    const panel = this._portalPanel;
    if (!panel) return;

    this._unbindPortalPanelHandlers();
    const handlers = [];

    const typeButtons = panel.querySelectorAll('[data-portal-type]');
    typeButtons.forEach((btn) => {
      const handler = (event) => {
        event.preventDefault();
        const type = btn.dataset.portalType;
        this._setActivePortalType(type);
      };
      btn.addEventListener('click', handler);
      handlers.push(() => btn.removeEventListener('click', handler));
    });

    const thumbButtons = panel.querySelectorAll('[data-portal-picker]');
    thumbButtons.forEach((btn) => {
      const handler = (event) => {
        event.preventDefault();
        const picker = btn.dataset.portalPicker;
        this._openPortalTexturePicker(picker);
      };
      btn.addEventListener('click', handler);
      handlers.push(() => btn.removeEventListener('click', handler));
    });

    const clearButtons = panel.querySelectorAll('[data-portal-clear]');
    clearButtons.forEach((btn) => {
      const handler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const picker = btn.dataset.portalClear;
        this._clearPortalTexture(picker);
      };
      btn.addEventListener('click', handler);
      handlers.push(() => btn.removeEventListener('click', handler));
    });

    this._portalPanelHandlers = handlers;
  },

  _unbindPortalPanelHandlers() {
    if (Array.isArray(this._portalPanelHandlers)) {
      while (this._portalPanelHandlers.length) {
        const off = this._portalPanelHandlers.pop();
        try { off?.(); } catch (_) {}
      }
    }
    this._portalPanelHandlers = null;
  },

  _setActivePortalType(type) {
    const supported = this._getPortalPanelState()?.supportedKinds;
    if (supported && !supported.includes(type)) return;
    if (!VALID_PORTAL_TYPES.includes(type)) type = GAP_KIND_DOOR;
    const manager = this._buildingManager;
    const managerKind = manager?.isActive
      ? this._getPortalPanelState()?.activeKind
      : this._activePortalType;
    if (!supported && this._activePortalType === type && managerKind === type) return;

    const previousType = this._activePortalType;
    this._activePortalType = type;
    this._portalPreviewSignature = null;

    if (manager?.isActive) {
      const delegateKind = manager.setPortalPanelKind?.(type);
      if (delegateKind === false) this._activePortalType = previousType;
      if (delegateKind && VALID_PORTAL_TYPES.includes(delegateKind)) {
        this._activePortalType = delegateKind;
      }
    }

    this._updatePortalPanelState();
  },

  _updatePortalPanelState() {
    const panel = this._portalPanel;
    if (!panel) return;

    const canUsePortals = this._canUsePortals();
    this._portalPanelCanUse = canUsePortals;
    const currentBlocker = panel.querySelector('.fa-portals-panel__blocker');

    if (!canUsePortals && !currentBlocker) {
      this._portalPreviewSignature = null;
      panel.innerHTML = `
        <div class="fa-portals-panel__blocker">
          <i class="fas fa-info-circle" aria-hidden="true"></i>
          <span>Start a wall session first</span>
          <p class="fa-portals-panel__hint">Select a wall path from the Walls tab to begin.</p>
        </div>
      `;
      this._unbindPortalPanelHandlers();
      return;
    }

    if (canUsePortals && currentBlocker) {
      this._portalPreviewSignature = null;
      panel.innerHTML = this._buildPortalPanelContent();
      this._bindPortalPanelHandlers();
    }

    if (!canUsePortals) return;

    const manager = this._buildingManager;
    if (manager?.isActive) {
      const delegateKind = this._getPortalPanelState()?.activeKind;
      if (delegateKind && delegateKind !== this._activePortalType) {
        if (VALID_PORTAL_TYPES.includes(delegateKind)) this._activePortalType = delegateKind;
      }
    }

    const typeButtons = panel.querySelectorAll('[data-portal-type]');
    typeButtons.forEach((btn) => {
      const type = btn.dataset.portalType;
      const isActive = type === this._activePortalType;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    const texturesContainer = panel.querySelector('[data-portal-textures]');
    if (texturesContainer) {
      this._portalPreviewSignature = null;
      texturesContainer.innerHTML = this._buildPortalTexturesHtml(this._activePortalType);
      const portalState = this._getPortalPanelState();
      if (portalState?.supportedTexturePickers) {
        for (const button of texturesContainer.querySelectorAll('[data-portal-picker]')) {
          if (!portalState.supportedTexturePickers.includes(button.dataset.portalPicker)) button.closest('.fa-portals-panel__texture-group')?.remove();
        }
        const clear = texturesContainer.querySelector('[data-portal-clear="door"]');
        if (clear) clear.disabled = !portalState.canClearDoorTexture;
        const clearFrame = texturesContainer.querySelector('[data-portal-clear="door-frame"]');
        if (clearFrame && typeof portalState.canClearDoorFrame === 'boolean') clearFrame.disabled = !portalState.canClearDoorFrame;
      }
      this._bindPortalPanelHandlers();
      this._refreshPortalTextureThumbnails();
    }
  },

  _refreshPortalTextureThumbnails() {
    const panel = this._portalPanel;
    if (!panel) return;

    const portalState = this._getPortalPanelState();
    if (!portalState) return;
    const clear = panel.querySelector('[data-portal-clear="door"]');
    if (clear && portalState.supportedKinds) clear.disabled = !portalState.canClearDoorTexture;
    const clearFrame = panel.querySelector('[data-portal-clear="door-frame"]');
    if (clearFrame && typeof portalState.canClearDoorFrame === 'boolean') clearFrame.disabled = !portalState.canClearDoorFrame;
    const doorConfig = portalState.doorConfig || {};
    const windowConfig = portalState.windowConfig || {};

    const signature = this._buildPortalPreviewSignature(doorConfig, windowConfig);
    if (signature === this._portalPreviewSignature) return;
    this._portalPreviewSignature = signature;

    this._updateTextureThumbnail(panel, 'door', doorConfig.textureLocal || doorConfig.textureKey);
    this._updateTextureThumbnail(panel, 'door-frame', doorConfig.frame?.textureLocal || doorConfig.frame?.textureKey);
    this._updateTextureThumbnail(panel, 'opening-frame', doorConfig.frame?.textureLocal || doorConfig.frame?.textureKey);
    this._updateTextureThumbnail(panel, 'window-sill', windowConfig.sill?.textureLocal || windowConfig.sill?.textureKey);
    this._updateTextureThumbnail(panel, 'window-texture', windowConfig.texture?.textureLocal || windowConfig.texture?.textureKey);
    this._updateTextureThumbnail(panel, 'window-frame', windowConfig.frame?.textureLocal || windowConfig.frame?.textureKey);

    this._updatePortalCompositePreview(panel, { doorConfig, windowConfig });
  },

  _updateTextureThumbnail(panel, pickerId, texturePath) {
    const thumb = panel.querySelector(`[data-portal-picker="${pickerId}"]`);
    if (!thumb) return;
    const wrap = thumb.closest?.('.fa-portals-panel__thumb-wrap');

    let textureKey = String(texturePath || '');
    if (textureKey && this._isPortalTextureMissing(textureKey)) {
      textureKey = '';
    }

    const existingImg = thumb.querySelector('img.fa-portals-panel__thumb-img');
    const existingSrc = existingImg?.getAttribute('src') || '';
    if (textureKey) {
      if (existingImg && existingSrc === textureKey) {
        if (wrap) wrap.dataset.hasTexture = 'true';
        return;
      }
      const filename = textureKey.split('/').pop() || 'Selected';
      const img = document.createElement('img');
      img.className = 'fa-portals-panel__thumb-img';
      img.src = textureKey;
      img.alt = filename;
      img.loading = 'lazy';
      img.addEventListener('load', () => {
        this._portalPreviewMissingCache.delete(textureKey);
      });
      img.addEventListener('error', () => {
        const cleared = this._handleMissingPortalTexture(pickerId, textureKey);
        if (!cleared) this._updateTextureThumbnail(panel, pickerId, null);
      });
      thumb.innerHTML = '';
      thumb.appendChild(img);
      if (wrap) wrap.dataset.hasTexture = 'true';
    } else {
      const placeholder = thumb.querySelector('.fa-portals-panel__thumb-placeholder');
      if (!existingImg && placeholder && wrap?.dataset?.hasTexture === 'false') return;
      const icons = {
        door: 'fa-door-closed',
        'door-frame': 'fa-border-all',
        'window-sill': 'fa-layer-group',
        'window-texture': 'fa-border-all',
        'window-frame': 'fa-columns'
      };
      const icon = icons[pickerId] || 'fa-image';
      thumb.innerHTML = `
        <div class="fa-portals-panel__thumb-placeholder">
          <i class="fas ${icon}" aria-hidden="true"></i>
          <span>Select...</span>
        </div>
      `;
      if (wrap) wrap.dataset.hasTexture = 'false';
    }
  },

  _buildPortalPreviewSignature(doorConfig = {}, windowConfig = {}) {
    const safeString = (value) => String(value || '');
    const round = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      return Math.round(numeric * 1000) / 1000;
    };
    const normalizeFlip = (config = {}) => {
      const raw = config?.textureFlip && typeof config.textureFlip === 'object' ? config.textureFlip : {};
      return {
        horizontal: Object.prototype.hasOwnProperty.call(raw, 'horizontal')
          ? !!raw.horizontal
          : !!(config?.flipHorizontal ?? config?.flipX),
        vertical: Object.prototype.hasOwnProperty.call(raw, 'vertical')
          ? !!raw.vertical
          : !!config?.flip
      };
    };
    const normalizeHsbc = (value) => {
      const hsbc = value && typeof value === 'object' ? value : {};
      return {
        hue: round(Number.isFinite(Number(hsbc.hue)) ? hsbc.hue : 0),
        saturation: round(Number.isFinite(Number(hsbc.saturation)) ? hsbc.saturation : 1),
        brightness: round(Number.isFinite(Number(hsbc.brightness)) ? hsbc.brightness : 1),
        contrast: round(Number.isFinite(Number(hsbc.contrast)) ? hsbc.contrast : 1)
      };
    };
    const normalizeFrame = (frame) => {
      const cfg = frame && typeof frame === 'object' ? frame : {};
      const opaqueBounds = cfg.opaqueBounds && typeof cfg.opaqueBounds === 'object'
        ? Object.fromEntries(['minX', 'minY', 'maxX', 'maxY'].map(key => [key, round(cfg.opaqueBounds[key])]))
        : null;
      return {
        texture: safeString(cfg.textureLocal || cfg.textureKey),
        mode: cfg.mode || 'split',
        sourceWidth: round(cfg.sourceWidth),
        sourceHeight: round(cfg.sourceHeight),
        scale: round(cfg.scale),
        offsetX: round(cfg.offsetX),
        offsetY: round(cfg.offsetY),
        rotation: round(cfg.rotation),
        ...(opaqueBounds ? { opaqueBounds } : {}),
        hsbc: normalizeHsbc(cfg.hsbc)
      };
    };
    const door = doorConfig && typeof doorConfig === 'object' ? doorConfig : {};
    const window = windowConfig && typeof windowConfig === 'object' ? windowConfig : {};
    return JSON.stringify({
      door: {
        texture: safeString(door.textureLocal || door.textureKey),
        widthScale: round(door.widthScale),
        textureFlip: normalizeFlip(door),
        appearance: { hsbc: normalizeHsbc(door.appearance?.hsbc) },
        frame: normalizeFrame(door.frame)
      },
      window: {
        textureFlip: normalizeFlip(window),
        sill: {
          texture: safeString(window.sill?.textureLocal || window.sill?.textureKey),
          scale: round(window.sill?.scale),
          offsetX: round(window.sill?.offsetX),
          offsetY: round(window.sill?.offsetY)
        },
        texture: {
          texture: safeString(window.texture?.textureLocal || window.texture?.textureKey),
          scale: round(window.texture?.scale),
          offsetX: round(window.texture?.offsetX),
          offsetY: round(window.texture?.offsetY)
        },
        frame: normalizeFrame(window.frame)
      }
    });
  },

  _isPortalTextureMissing(path) {
    const key = String(path || '');
    if (!key) return false;
    const missingAt = this._portalPreviewMissingCache.get(key);
    if (!missingAt) return false;
    if (Date.now() - missingAt > PORTAL_TEXTURE_MISSING_RETRY_MS) {
      this._portalPreviewMissingCache.delete(key);
      return false;
    }
    return true;
  },

  _markPortalTextureMissing(path) {
    const key = String(path || '');
    if (!key) return;
    this._portalPreviewMissingCache.set(key, Date.now());
    this._portalPreviewImageCache.delete(key);
  },

  _handleMissingPortalTexture(pickerType, texturePath) {
    const key = String(texturePath || '');
    if (!key) return false;
    this._markPortalTextureMissing(key);
    if (this._getPortalPanelState()?.supportedKinds) return false;
    const cleared = this._clearPortalTexture(pickerType, { suppressNotice: true });
    if (cleared) this._portalPreviewMissingCache.delete(key);
    return cleared;
  },

  _clearPortalTexture(pickerType, { suppressNotice = false } = {}) {
    const manager = this._buildingManager;
    if (!manager?.canHandlePortalPanelActions?.()) {
      if (!suppressNotice) {
        ui?.notifications?.warn?.('Start a building session first.');
      }
      return false;
    }

    const result = manager.clearPortalTexture?.(pickerType);
    if (result && typeof result.then === 'function') {
      return result
        .then((cleared) => {
          if (cleared) this._refreshPortalTextureThumbnails();
          return !!cleared;
        });
    }

    if (result) this._refreshPortalTextureThumbnails();
    return !!result;
  },

  _updatePortalCompositePreview(panel, { doorConfig = {}, windowConfig = {} } = {}) {
    const seq = ++this._portalPreviewRenderSeq;
    void this._renderPortalPreview(panel, 'door', doorConfig, seq);
    void this._renderPortalPreview(panel, 'window', windowConfig, seq);
  },

  async _renderPortalPreview(panel, previewId, config = {}, seq = 0) {
    const root = panel.querySelector(`[data-portal-preview="${previewId}"]`);
    if (!root) return;
    const canvas = root.querySelector('canvas.fa-portals-panel__preview-canvas');
    const placeholder = root.querySelector('.fa-portals-panel__preview-placeholder');
    if (!canvas) return;
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const isDoor = previewId === 'door';
    const isWindow = previewId === 'window';
    if (!isDoor && !isWindow) return;

    const data = config && typeof config === 'object' ? config : {};
    const resolveTextureFlip = (cfg = {}) => {
      const raw = cfg?.textureFlip && typeof cfg.textureFlip === 'object' ? cfg.textureFlip : {};
      return {
        horizontal: Object.prototype.hasOwnProperty.call(raw, 'horizontal')
          ? !!raw.horizontal
          : !!(cfg?.flipHorizontal ?? cfg?.flipX),
        vertical: Object.prototype.hasOwnProperty.call(raw, 'vertical')
          ? !!raw.vertical
          : !!cfg?.flip
      };
    };

    const doorPath = isDoor ? String(data.textureLocal || data.textureKey || '') : '';
    const doorFlip = isDoor ? resolveTextureFlip(data) : { horizontal: false, vertical: false };
    const doorAppearance = isDoor && data.appearance && typeof data.appearance === 'object' ? data.appearance : {};
    const frameConfig = data.frame && typeof data.frame === 'object' ? data.frame : {};
    const framePath = String(frameConfig.textureLocal || frameConfig.textureKey || '');

    const sillConfig = isWindow ? (data.sill && typeof data.sill === 'object' ? data.sill : {}) : {};
    const glassConfig = isWindow ? (data.texture && typeof data.texture === 'object' ? data.texture : {}) : {};
    const sillPath = String(sillConfig.textureLocal || sillConfig.textureKey || '');
    const glassPath = String(glassConfig.textureLocal || glassConfig.textureKey || '');
    const glassFlip = isWindow ? resolveTextureFlip(data) : { horizontal: false, vertical: false };

    const hasAny =
      (isDoor && (doorPath || framePath)) ||
      (isWindow && (sillPath || glassPath || framePath));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!hasAny) {
      if (placeholder) placeholder.style.display = '';
      return;
    }
    if (placeholder) placeholder.style.display = 'none';

    const CANVAS_W = canvas.width || 280;
    const CANVAS_H = canvas.height || 120;
    const PADDING = 10;
    const GRID_SIZE = 100;
    const ASSET_GRID = 200;
    const BASE_ASSET_SCALE = GRID_SIZE / ASSET_GRID;

    const clamp = (value, min, max, fallback) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return fallback;
      return Math.max(min, Math.min(max, numeric));
    };

    const loadImage = (path) => {
      const key = String(path || '');
      if (!key) return Promise.resolve(null);
      if (this._isPortalTextureMissing(key)) return Promise.resolve(null);
      const cached = this._portalPreviewImageCache.get(key);
      if (cached) return cached;
      const promise = new Promise((resolve) => {
        const img = new Image();
        // HSBC reads pixels; request CORS access before loading remote artwork.
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => {
          this._portalPreviewMissingCache.delete(key);
          resolve(img);
        };
        img.onerror = () => {
          this._markPortalTextureMissing(key);
          resolve(null);
        };
        img.src = key;
      });
      this._portalPreviewImageCache.set(key, promise);
      return promise;
    };

    const toCommandsForElement = ({ img, width, height, offsetX = 0, offsetY = 0, flipX = false, flipY = false, z = 0 }) => {
      const sw = img?.naturalWidth || img?.width || 0;
      const sh = img?.naturalHeight || img?.height || 0;
      if (!sw || !sh) return [];
      const scaleX = (width / sw) * (flipX ? -1 : 1);
      const scaleY = (height / sh) * (flipY ? -1 : 1);
      return [{
        img,
        sx: 0,
        sy: 0,
        sw,
        sh,
        cx: offsetX,
        cy: offsetY,
        scaleX,
        scaleY,
        rotation: 0,
        z
      }];
    };

    const toCommandsForFrame = ({ img, frameCfg, gapLen, z = 10 }) => {
      const baseW = img?.naturalWidth || img?.width || 0;
      const baseH = img?.naturalHeight || img?.height || 0;
      if (!baseW || !baseH) return [];
      const mode = String(frameCfg?.mode || 'split').toLowerCase();
      const usesCapturedOpaqueBasis = mode === 'pillar' && !!frameCfg?.opaqueBounds;
      const geometryW = usesCapturedOpaqueBasis && Number(frameCfg?.sourceWidth) > 0
        ? Number(frameCfg.sourceWidth)
        : baseW;
      const geometryH = usesCapturedOpaqueBasis && Number(frameCfg?.sourceHeight) > 0
        ? Number(frameCfg.sourceHeight)
        : baseH;
      const userScale = normalizePortalTextureWidthScale(frameCfg?.scale);
      const assetScale = BASE_ASSET_SCALE * userScale;
      const heightScene = Math.max(1, geometryH * assetScale);
      const offsetX = clamp(frameCfg?.offsetX, -1, 1, 0);
      const offsetY = clamp(frameCfg?.offsetY, -1, 1, 0);
      const rotationDeg = clamp(frameCfg?.rotation, -180, 180, 0);
      const rotationRad = (rotationDeg * Math.PI) / 180;

      const splitPillarWidthPx = Math.max(1, Math.min(baseH, Math.floor(baseW / 2)));
      const pillarWidthPx = mode === 'pillar' ? geometryW : splitPillarWidthPx;
      const pillarWidthScene = pillarWidthPx * assetScale;
      const targetWidth = Math.max(pillarWidthScene * 2 + 1, gapLen + pillarWidthScene * 2);
      const groupCenterX = targetWidth / 2;
      const groupCenterY = heightScene / 2;

      const offsetXPx = offsetX * targetWidth * 0.5;
      const offsetYPx = offsetY * heightScene * 0.5;

      if (mode === 'scale') {
        return [{
          img,
          sx: 0,
          sy: 0,
          sw: baseW,
          sh: baseH,
          cx: 0,
          cy: 0,
          scaleX: targetWidth / baseW,
          scaleY: assetScale,
          rotation: 0,
          z
        }];
      }

      if (mode === 'pillar') {
        const positions = positionBuildingV2DoorFramePillars({
          sourceWidth: geometryW,
          sourceHeight: geometryH,
          opaqueBounds: frameCfg?.opaqueBounds,
          assetScale,
          gapLength: gapLen,
          targetWidth,
          offsetX,
          rotation: rotationRad
        });
        const leftCenterX = groupCenterX + positions.left;
        const leftCenterY = heightScene * 0.5 + offsetYPx;
        const rightCenterX = groupCenterX + positions.right;
        const rightCenterY = heightScene * 0.5 + offsetYPx;
        return [
          {
            img,
            sx: 0,
            sy: 0,
            sw: baseW,
            sh: baseH,
            cx: leftCenterX - groupCenterX,
            cy: leftCenterY - groupCenterY,
            scaleX: (geometryW * assetScale) / baseW,
            scaleY: (geometryH * assetScale) / baseH,
            rotation: rotationRad,
            z
          },
          {
            img,
            sx: 0,
            sy: 0,
            sw: baseW,
            sh: baseH,
            cx: rightCenterX - groupCenterX,
            cy: rightCenterY - groupCenterY,
            scaleX: -(geometryW * assetScale) / baseW,
            scaleY: (geometryH * assetScale) / baseH,
            rotation: -rotationRad,
            z
          }
        ];
      }

      const leftRectW = splitPillarWidthPx;
      const leftCenterX = pillarWidthScene * 0.5 + offsetXPx;
      const leftCenterY = heightScene * 0.5 + offsetYPx;
      const rightCenterX = targetWidth - pillarWidthScene * 0.5 - offsetXPx;
      const rightCenterY = heightScene * 0.5 + offsetYPx;
      return [
        {
          img,
          sx: 0,
          sy: 0,
          sw: leftRectW,
          sh: baseH,
          cx: leftCenterX - groupCenterX,
          cy: leftCenterY - groupCenterY,
          scaleX: assetScale,
          scaleY: assetScale,
          rotation: 0,
          z
        },
        {
          img,
          sx: Math.max(0, baseW - leftRectW),
          sy: 0,
          sw: leftRectW,
          sh: baseH,
          cx: rightCenterX - groupCenterX,
          cy: rightCenterY - groupCenterY,
          scaleX: assetScale,
          scaleY: assetScale,
          rotation: 0,
          z
        }
      ];
    };

    const [
      doorImg,
      frameImg,
      sillImg,
      glassImg
    ] = await Promise.all([
      isDoor ? loadImage(doorPath) : Promise.resolve(null),
      framePath ? loadImage(framePath) : Promise.resolve(null),
      isWindow ? loadImage(sillPath) : Promise.resolve(null),
      isWindow ? loadImage(glassPath) : Promise.resolve(null)
    ]);

    if (seq !== this._portalPreviewRenderSeq) return;

    let clearedMissing = false;
    if (isDoor && doorPath && !doorImg) {
      clearedMissing = this._handleMissingPortalTexture('door', doorPath) || clearedMissing;
    }
    if (framePath && !frameImg) {
      const picker = isDoor ? 'door-frame' : 'window-frame';
      clearedMissing = this._handleMissingPortalTexture(picker, framePath) || clearedMissing;
    }
    if (isWindow && sillPath && !sillImg) {
      clearedMissing = this._handleMissingPortalTexture('window-sill', sillPath) || clearedMissing;
    }
    if (isWindow && glassPath && !glassImg) {
      clearedMissing = this._handleMissingPortalTexture('window-texture', glassPath) || clearedMissing;
    }
    if (clearedMissing) return;

    const renderHsbcImage = (img, hsbc, target) => {
      if (!img) return img;
      const targetCanvas = document.createElement('canvas');
      targetCanvas.width = img.naturalWidth || img.width;
      targetCanvas.height = img.naturalHeight || img.height;
      const targetContext = targetCanvas.getContext('2d', { willReadFrequently: true });
      if (!targetContext) throw new Error(`Nexus Portal preview could not create the ${target} HSBC canvas.`);
      targetContext.drawImage(img, 0, 0);
      const targetPixels = targetContext.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
      if (!isNeutralHsbc(hsbc)) applyHsbcToImageData(targetPixels, hsbc);
      targetContext.putImageData(targetPixels, 0, 0);
      return targetCanvas;
    };

    const renderedDoorImg = renderHsbcImage(doorImg, doorAppearance.hsbc, 'Door leaf');
    const renderedFrameImg = renderHsbcImage(frameImg, frameConfig.hsbc, 'frame');

    const roundToHalf = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return 0;
      return Math.round(numeric * 2) / 2;
    };

    const guessGapSquares = (img, path, fallback = 2) => {
      const namedWidth = parsePortalTextureGridWidth(path);
      if (Number.isFinite(namedWidth) && namedWidth > 0) return Math.max(0.5, namedWidth);
      if (!img || !img.naturalWidth) return fallback;
      const raw = img.naturalWidth / ASSET_GRID;
      let squares = roundToHalf(raw);
      if (!Number.isFinite(squares) || squares <= 0) squares = fallback;
      squares = Math.max(0.5, squares);
      const isSmall = hasSmallPortalTextureToken(path) && squares <= 1;
      if (isSmall) squares = 0.5;
      return squares;
    };

    const gapSquares = isDoor
      ? guessGapSquares(doorImg, doorPath, 2)
      : guessGapSquares(glassImg || sillImg, glassImg ? glassPath : sillPath, 2);
    const gapLen = Math.max(1, gapSquares * GRID_SIZE);

    const commands = [];
    if (isDoor) {
      if (doorImg) {
        const desiredW = gapLen;
        const widthScale = normalizePortalTextureWidthScale(data?.widthScale);
        const desiredH = Math.max(
          1,
          doorImg.naturalHeight * (gapLen / Math.max(1, doorImg.naturalWidth)) * widthScale
        );
        commands.push(
          ...toCommandsForElement({
            img: renderedDoorImg,
            width: desiredW,
            height: desiredH,
            offsetX: 0,
            offsetY: 0,
            flipX: doorFlip.horizontal,
            flipY: doorFlip.vertical,
            z: 0
          })
        );
      }
      if (frameImg) {
        commands.push(
          ...toCommandsForFrame({
            img: renderedFrameImg,
            frameCfg: frameConfig,
            gapLen,
            z: 10
          })
        );
      }
    } else if (isWindow) {
      if (sillImg) {
        const userScale = normalizePortalTextureWidthScale(sillConfig?.scale);
        const height = Math.max(1, sillImg.naturalHeight * BASE_ASSET_SCALE * userScale);
        const width = gapLen * (isSmallPortalTexturePath(sillPath) ? 2 : 1);
        const offsetX = clamp(sillConfig?.offsetX, -1, 1, 0) * width * 0.5;
        const offsetY = clamp(sillConfig?.offsetY, -1, 1, 0) * height * 0.5;
        commands.push(...toCommandsForElement({ img: sillImg, width, height, offsetX, offsetY, flipX: false, flipY: false, z: 0 }));
      }
      if (glassImg) {
        const userScale = normalizePortalTextureWidthScale(glassConfig?.scale);
        const height = Math.max(1, glassImg.naturalHeight * BASE_ASSET_SCALE * userScale);
        const width = gapLen * (isSmallPortalTexturePath(glassPath) ? 2 : 1);
        const offsetX = clamp(glassConfig?.offsetX, -1, 1, 0) * width * 0.5;
        const offsetY = clamp(glassConfig?.offsetY, -1, 1, 0) * height * 0.5;
        commands.push(...toCommandsForElement({ img: glassImg, width, height, offsetX, offsetY, flipX: glassFlip.horizontal, flipY: glassFlip.vertical, z: 5 }));
      }
      if (frameImg) {
        commands.push(
          ...toCommandsForFrame({
            img: renderedFrameImg,
            frameCfg: frameConfig,
            gapLen,
            z: 10
          })
        );
      }
    }

    if (!commands.length) {
      if (placeholder) placeholder.style.display = '';
      return;
    }

    const coreH = (() => {
      if (isDoor && doorImg && doorImg.naturalWidth && doorImg.naturalHeight) {
        return Math.max(1, doorImg.naturalHeight * (gapLen / Math.max(1, doorImg.naturalWidth)));
      }
      if (isWindow && glassImg && glassImg.naturalHeight) {
        return Math.max(1, glassImg.naturalHeight * BASE_ASSET_SCALE);
      }
      if (isWindow && sillImg && sillImg.naturalHeight) {
        return Math.max(1, sillImg.naturalHeight * BASE_ASSET_SCALE);
      }
      return GRID_SIZE * 2;
    })();

    const commandFitBounds = (() => {
      let halfWidth = Math.max(1, gapLen * 0.5);
      let halfHeight = Math.max(1, coreH * 0.5);
      for (const cmd of commands) {
        const sw = Math.max(1, Number(cmd.sw) || 0);
        const sh = Math.max(1, Number(cmd.sh) || 0);
        const scaledHalfW = Math.abs(Number(cmd.scaleX) || 0) * sw * 0.5;
        const scaledHalfH = Math.abs(Number(cmd.scaleY) || 0) * sh * 0.5;
        const rotation = Number(cmd.rotation) || 0;
        const cos = Math.abs(Math.cos(rotation));
        const sin = Math.abs(Math.sin(rotation));
        const boundHalfW = scaledHalfW * cos + scaledHalfH * sin;
        const boundHalfH = scaledHalfW * sin + scaledHalfH * cos;
        halfWidth = Math.max(halfWidth, Math.abs(Number(cmd.cx) || 0) + boundHalfW);
        halfHeight = Math.max(halfHeight, Math.abs(Number(cmd.cy) || 0) + boundHalfH);
      }
      return {
        width: Math.max(1, halfWidth * 2),
        height: Math.max(1, halfHeight * 2)
      };
    })();

    const scale = Math.min(
      (CANVAS_W - PADDING * 2) / commandFitBounds.width,
      (CANVAS_H - PADDING * 2) / commandFitBounds.height
    );

    try {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const y = CANVAS_H / 2;
      ctx.moveTo(PADDING, y);
      ctx.lineTo(CANVAS_W - PADDING, y);
      ctx.stroke();
      ctx.restore();
    } catch (_) {}

    commands.sort((a, b) => (a.z || 0) - (b.z || 0));
    for (const cmd of commands) {
      try {
        ctx.save();
        const x = cmd.cx * scale + CANVAS_W / 2;
        const y = cmd.cy * scale + CANVAS_H / 2;
        ctx.translate(x, y);
        if (cmd.rotation) ctx.rotate(cmd.rotation);
        ctx.scale(cmd.scaleX * scale, cmd.scaleY * scale);
        ctx.drawImage(cmd.img, cmd.sx, cmd.sy, cmd.sw, cmd.sh, -cmd.sw / 2, -cmd.sh / 2, cmd.sw, cmd.sh);
        ctx.restore();
      } catch (_) {}
    }
  },

  _openPortalTexturePicker(pickerType) {
    const manager = this._buildingManager;
    if (!manager?.canHandlePortalPanelActions?.()) {
      ui?.notifications?.warn?.('Start a building session first.');
      return false;
    }

    const result = manager.openPortalTexturePicker?.(pickerType);
    if (result && typeof result.then === 'function') {
      return result;
    }
    return result;
  },

  _canUsePortals() {
    if (typeof canvas === 'undefined' || !canvas?.ready || !canvas?.stage) {
      return false;
    }
    const manager = this._buildingManager;
    if (manager?.isActive) return true;
    const scene = canvas.scene;
    if (scene?.tiles?.size > 0) {
      for (const tile of scene.tiles) {
        const flags = tile.flags?.['fa-nexus'] || null;
        if (flags?.building || flags?.buildingFill) return true;
      }
    }
    if (scene?.walls?.size > 0) {
      for (const wall of scene.walls) {
        const flags = wall.flags?.['fa-nexus']?.buildingWall;
        if (flags) return true;
      }
    }
    return false;
  },

  _destroyPortalPanel() {
    this._unbindPortalPanelHandlers();
    this._unregisterPortalToolOptionsCallback();
    if (this._portalPanel?.parentElement) {
      try { this._portalPanel.parentElement.removeChild(this._portalPanel); } catch (_) {}
    }
    this._portalPanel = null;
  }
};
