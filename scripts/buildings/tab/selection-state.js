import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import {
  NONE_TEXTURE_ITEM,
  NONE_TEXTURE_KEY
} from './constants.js';

export const selectionStateMethods = {
  _extractItemKey(item, cardElement) {
    if (this._isNoneTextureItem(item)) return NONE_TEXTURE_KEY;
    const keyFromItem = this._computeItemKey?.(item);
    if (keyFromItem) return keyFromItem;
    if (!cardElement) return '';
    return cardElement.getAttribute('data-key') || cardElement.getAttribute('data-file-path') || '';
  },

  _selectOuterWallPath(key) {
    this._selectedOuterWallPathKey = key || '';
    this._applyPathSelection(this._selectedOuterWallPathKey);
  },

  _selectFillTexture(key) {
    const normalized = key || NONE_TEXTURE_KEY;
    this._selectedFillTextureKey = normalized;
  },

  async _handleFillTextureSelectionChanged({ key = NONE_TEXTURE_KEY, item = null, cardElement = null } = {}) {
    const manager = this._buildingManager;
    if (!manager || !manager.isActive) return;
    const payload = {
      fillTextureKey: key || NONE_TEXTURE_KEY,
      fillTexture: item && !this._isNoneTextureItem(item) ? item : null,
      fillTextureLocal: ''
    };
    if (payload.fillTexture && cardElement) {
      payload.fillTextureLocal = this._resolveAssetLocalPath(payload.fillTexture, cardElement);
    }
    try {
      await manager.updateFillTexture?.(payload);
    } catch (error) {
      Logger.warn?.('BuildingsTab.updateFillTexture.failed', { error: String(error?.message || error), payload });
      ui?.notifications?.error?.(`Failed to update fill texture: ${error?.message || error}`);
    }
  },

  _applyPathSelection(key) {
    if (!this._selection) return;
    try { this._selection.selectedKeys.clear(); } catch (_) {}
    if (key) {
      try { this._selection.selectedKeys.add(key); } catch (_) {}
    }
    try {
      this._selection.lastClickedIndex = key ? this._indexOfVisibleKey(key) : -1;
      this._refreshSelectionUIInView();
    } catch (_) {}
  },

  _restoreSubtabSelections() {
    if (this._activeSubtab === 'building') {
      this._applyPathSelection(this._selectedOuterWallPathKey);
      this._refreshVisibleTextureSelection();
    } else {
      this._applyPathSelection('');
    }
  },

  _injectNoneTextureItem(textureItems) {
    const list = Array.isArray(textureItems) ? [...textureItems] : [];
    if (!list.length || !this._isNoneTextureItem(list[0])) {
      list.unshift(this._noneTextureItem);
    }
    return list;
  },

  _isNoneTextureItem(item) {
    return !!(item && (item.isNoneTexture || item.id === NONE_TEXTURE_ITEM.id));
  },

  _syncTextureSelectionForCard(cardElement, item) {
    if (!cardElement) return;
    const key = this._extractItemKey(item, cardElement);
    this._markTextureCardSelected(cardElement, key === this._selectedFillTextureKey);
  },

  _refreshVisibleTextureSelection() {
    const container = this._texturesGrid?.container;
    if (!container) return;
    container.querySelectorAll('.fa-nexus-card').forEach((card) => {
      const key = card.getAttribute('data-key') || card.getAttribute('data-file-path') || '';
      this._markTextureCardSelected(card, key === this._selectedFillTextureKey);
    });
  },

  _markTextureCardSelected(card, selected) {
    if (!card) return;
    card.classList.toggle('fa-nexus-selected', !!selected);
    if (selected) card.setAttribute('data-selected', 'true');
    else card.removeAttribute('data-selected');
  },

  forceNoFillSelection({ notifyManager = true } = {}) {
    const previousKey = this._selectedFillTextureKey;
    this._selectFillTexture(NONE_TEXTURE_KEY);
    this._refreshVisibleTextureSelection();
    if (notifyManager && previousKey !== NONE_TEXTURE_KEY) {
      return this._handleFillTextureSelectionChanged({
        key: NONE_TEXTURE_KEY,
        item: this._noneTextureItem,
        cardElement: null
      });
    }
    return null;
  },

  _findCardElementByKey(key, scope = 'paths') {
    if (!key) return null;
    const container = scope === 'textures' ? this._texturesGrid?.container : this.app?._grid?.container;
    if (!container) return null;
    const cards = container.querySelectorAll('.fa-nexus-card');
    for (const card of cards) {
      const dataKey = card.getAttribute('data-key') || card.getAttribute('data-file-path') || '';
      if (dataKey === key) return card;
    }
    return null;
  },

  _findItemByKey(key) {
    if (!key || !Array.isArray(this._items)) return null;
    return this._items.find((item) => this._computeItemKey?.(item) === key) || null;
  }
};
