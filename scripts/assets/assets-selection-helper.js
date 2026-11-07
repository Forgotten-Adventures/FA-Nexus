import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { GridSelectionHelper } from '../core/placement/grid-selection-helper.js';
import {
  contentDimensions,
  contentFilename,
  contentFolder,
  contentGrid,
  contentPath,
  inventoryItemKey
} from '../content/cloud-inventory-v2.js';

export class AssetsTabSelectionHelper extends GridSelectionHelper {
  constructor(tab) {
    super({
      getGridContainer: () => {
        try { return tab.getGridContainer(); }
        catch (_) { return null; }
      },
      getGridItems: () => {
        try {
          const items = tab.app?._grid?.items;
          return Array.isArray(items) ? items : [];
        } catch (_) {
          return [];
        }
      },
      computeItemKey: (item) => {
        if (!item) return '';
        try {
          return inventoryItemKey(item) || contentPath(item) || '';
        } catch (_) {
          return '';
        }
      },
      keyFromCard: (cardElement) => {
        if (!cardElement) return '';
        try {
          const key = cardElement.getAttribute('data-key');
          if (key) return key;
          const fp = cardElement.getAttribute('data-content-id') || cardElement.getAttribute('data-content-path');
          if (fp) return fp;
          return cardElement.getAttribute('data-folder') || '';
        } catch (_) {
          return '';
        }
      },
      isItemLocked: (item, card, ctx) => {
        try { return !!tab._isAssetLocked?.(item, card, ctx); }
        catch (_) { return false; }
      },
      getSelectionContext: () => {
        try {
          const authed = typeof tab._hasPremiumAuth === 'function' ? tab._hasPremiumAuth() : false;
          return { authed };
        } catch (_) {
          return {};
        }
      },
      setCardSelectionUI: (cardElement, selected) => {
        if (!cardElement) return;
        try {
          if (selected) {
            cardElement.classList.add('fa-nexus-selected');
            cardElement.setAttribute('data-selected', 'true');
          } else {
            cardElement.classList.remove('fa-nexus-selected');
            cardElement.removeAttribute('data-selected');
          }
        } catch (_) {}
      },
      cardSelector: '.fa-nexus-card',
      logger: Logger,
      loggerTag: 'AssetsTab.select'
    });
    this.tab = tab;
  }

  preparePlacementSelection() {
    const tab = this.tab;
    const list = Array.isArray(tab._items) ? tab._items : [];
    if (!list.length) return [];
    const keys = new Set(this.selectedKeys);
    if (!keys.size) return [];

    const prepared = [];
    const hasLockCheck = typeof tab._isAssetLocked === 'function';
    const authed = typeof tab._hasPremiumAuth === 'function' ? tab._hasPremiumAuth() : false;
    const ctx = { authed };
    let removedLocked = false;
    for (const item of list) {
      const key = this.computeItemKey(item);
      if (!keys.has(key)) continue;
      if (hasLockCheck && tab._isAssetLocked(item, null, ctx)) {
        this.selectedKeys.delete(key);
        keys.delete(key);
        removedLocked = true;
        try { Logger.info('AssetsTab.place.selection.skipLocked', { key }); } catch (_) {}
        continue;
      }
      const isCloud = (String(item.source || '').toLowerCase() === 'cloud');
      const filePath = tab._resolveFilePath(item);
      const folderPath = tab._resolveFolderPath(item);
      const [gridWidthVal, gridHeightVal] = contentGrid(item);
      const dims = contentDimensions(item);
      const widthPx = Number(item?.actual_width || dims.width) || dims.width;
      const heightPx = Number(item?.actual_height || dims.height) || dims.height;
      const localOrPath = item?.cachedLocalPath || filePath || folderPath;
      const url = localOrPath || '';
      prepared.push({
        id: inventoryItemKey(item),
        item,
        source: item?.source || (isCloud ? 'cloud' : 'local'),
        tier: item?.tier || 'free',
        file_path: filePath,
        path: localOrPath || filePath || folderPath || '',
        folder_path: contentFolder(item) || folderPath,
        cachedLocalPath: item?.cachedLocalPath || '',
        filename: contentFilename(item),
        url,
        grid: [gridWidthVal, gridHeightVal],
        grid_width: gridWidthVal,
        grid_height: gridHeightVal,
        width: widthPx,
        height: heightPx,
        actual_width: item?.actual_width || widthPx,
        actual_height: item?.actual_height || heightPx
      });
    }
    if (removedLocked) {
      try { this.refreshSelectionUI(); } catch (_) {}
    }
    return prepared;
  }

  async startPlacementFromSelection() {
    const prepared = this.preparePlacementSelection();
    if (!prepared.length) return;
    try { Logger.info('AssetsTab.place.selection.start', { total: prepared.length, lazy: true }); } catch (_) {}
    const placement = this.tab.placementManager;
    if (placement?.updatePlacementAssets) {
      try {
        const updated = await placement.updatePlacementAssets(prepared);
        if (updated) return;
      } catch (error) {
        this.tab._reportAssetPlacementFailure?.('AssetsTab.place.selection.updateFailed', error, { total: prepared.length });
        throw error;
      }
    }
    try {
      if (prepared.length > 1) {
        if (typeof placement?.startPlacementRandom !== 'function') {
          throw new Error('Asset placement manager cannot start random placement.');
        }
        placement.startPlacementRandom(prepared, true);
      } else {
        if (typeof placement?.startPlacement !== 'function') {
          throw new Error('Asset placement manager is unavailable.');
        }
        placement.startPlacement(prepared[0], true);
      }
    } catch (error) {
      this.tab._reportAssetPlacementFailure?.('AssetsTab.place.selection.startFailed', error, { total: prepared.length });
      throw error;
    }
  }
}
