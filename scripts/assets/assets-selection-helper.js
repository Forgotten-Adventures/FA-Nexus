import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { GridSelectionHelper } from '../core/placement/grid-selection-helper.js';

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
          const filePath = String(item.file_path || '') || '';
          if (filePath) return filePath;
          const folder = tab._resolveFolderPath?.(item) || '';
          const filename = String(item.filename || '');
          if (folder && filename) return `${folder}/${filename}`;
          if (!folder && filename) return filename;
          return folder || '';
        } catch (_) {
          return '';
        }
      },
      keyFromCard: (cardElement) => {
        if (!cardElement) return '';
        try {
          const key = cardElement.getAttribute('data-key');
          if (key) return key;
          const fp = cardElement.getAttribute('data-file-path');
          if (fp) return fp;
          const path = cardElement.getAttribute('data-path') || '';
          const filename = cardElement.getAttribute('data-filename') || '';
          if (path && filename) return `${path}/${filename}`;
          if (!path && filename) return filename;
          return path || '';
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
      const gridWidthVal = Number(item?.grid_width || 1) || 1;
      const gridHeightVal = Number(item?.grid_height || 1) || 1;
      const widthPx = Number(item?.width || (gridWidthVal * 200)) || (gridWidthVal * 200);
      const heightPx = Number(item?.height || (gridHeightVal * 200)) || (gridHeightVal * 200);
      const localOrPath = item?.cachedLocalPath || filePath || folderPath;
      const url = localOrPath || '';
      prepared.push({
        source: item?.source || (isCloud ? 'cloud' : 'local'),
        tier: item?.tier || 'free',
        file_path: filePath,
        path: localOrPath || filePath || folderPath || '',
        cachedLocalPath: item?.cachedLocalPath || '',
        filename: item?.filename || '',
        url,
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
    try {
      placement?.startPlacementRandom?.(prepared, true);
    } catch (_) {
      placement?.startPlacement?.(prepared[0], true);
    }
  }
}
