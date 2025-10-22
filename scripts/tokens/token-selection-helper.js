import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { GridSelectionHelper } from '../core/placement/grid-selection-helper.js';

export class TokenSelectionHelper extends GridSelectionHelper {
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
          const filePath = String(item.file_path || item.path || '') || '';
          if (filePath) return filePath;
          const filename = String(item.filename || '');
          if (filename) return filename;
          const base = String(item.base_name_no_variant || item.display_name || '').toLowerCase();
          const variant = String(item.color_variant || '').toLowerCase();
          return variant ? `${base}__${variant}` : base;
        } catch (_) {
          return '';
        }
      },
      keyFromCard: (cardElement) => {
        if (!cardElement) return '';
        try {
          const key = cardElement.getAttribute('data-key');
          if (key) return key;
          const filePath = cardElement.getAttribute('data-file-path') || cardElement.getAttribute('data-url') || '';
          if (filePath) return filePath;
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
        try { return !!tab._isTokenLocked?.(item, card, ctx); }
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
      cardSelector: '.fa-nexus-card',
      logger: Logger,
      loggerTag: 'TokensTab.select'
    });
    this.tab = tab;
  }

  _joinPath(folder, name) {
    const filename = String(name || '').trim();
    if (!filename) return String(folder || '');
    const base = String(folder || '').trim();
    if (!base) return filename;
    return `${base.replace(/\/+$/, '')}/${filename}`;
  }

  _normalizeFilePath(filePath, folderPath, filename) {
    const direct = String(filePath || '').trim();
    if (direct) return direct;
    const folder = String(folderPath || '').trim();
    const name = String(filename || '').trim();
    if (folder && name) return this._joinPath(folder, name);
    return name;
  }

  _normalizeFolderPath(folderPath, filePath) {
    const direct = String(folderPath || '').trim();
    if (direct) return direct;
    const resolved = String(filePath || '').trim();
    if (!resolved) return '';
    const idx = resolved.lastIndexOf('/');
    if (idx <= 0) return '';
    return resolved.slice(0, idx);
  }

  preparePlacementEntries({ expandColorVariants = false, resolveVariants = null } = {}) {
    const tab = this.tab;
    const items = Array.isArray(tab._items) ? tab._items : [];
    if (!items.length) return [];
    const keys = new Set(this.selectedKeys);
    if (!keys.size) return [];

    const grid = tab.getGridContainer();
    const cardMap = new Map();
    if (grid) {
      const selector = '.fa-nexus-card';
      try {
        const cards = grid.querySelectorAll(selector);
        for (const card of cards) {
          const key = this.keyFromCard(card);
          if (key) cardMap.set(key, card);
        }
      } catch (_) {}
    }

    const authed = typeof tab._hasPremiumAuth === 'function' ? tab._hasPremiumAuth() : false;
    const ctx = { authed };
    const prepared = [];
    let removedLocked = false;

    const downloadManager = tab.app?._downloadManager || null;

    const addEntryForItem = (item, cardHint = null, forceInclude = false) => {
      const key = this.computeItemKey(item);
      if (!key) return;
      if (!forceInclude && !keys.has(key)) return;
      if (forceInclude) keys.add(key);
      const card = cardHint || cardMap.get(key) || null;
      if (tab._isTokenLocked?.(item, card, ctx)) {
        this.selectedKeys.delete(key);
        keys.delete(key);
        removedLocked = true;
        try { Logger.info('TokensTab.select.skipLocked', { key }); } catch (_) {}
        return;
      }
      let cachedLocalPath = item?.cachedLocalPath || '';
      if (!cachedLocalPath && downloadManager && item?.filename) {
        try {
          const local = downloadManager.getLocalPath('tokens', { filename: item.filename });
          if (local) cachedLocalPath = local;
        } catch (_) {}
      }
      if (!cachedLocalPath && card) {
        try {
          if (card._resolvedLocalPath) cachedLocalPath = card._resolvedLocalPath;
        } catch (_) {}
      }
      if (!cachedLocalPath && card) {
        try {
          const attr = card.getAttribute('data-url') || '';
          const isCached = card.getAttribute('data-cached') === 'true';
          if (attr && (isCached || attr.startsWith('file:') || attr.match(/^[A-Za-z]:\\/))) {
            cachedLocalPath = attr;
          }
        } catch (_) {}
      }
      const filename = item?.filename || card?.getAttribute?.('data-filename') || '';
      const filePathAttr = item?.file_path || card?.getAttribute?.('data-file-path') || '';
      const folderPathAttr = item?.path || card?.getAttribute?.('data-path') || '';
      const normalizedFilePath = this._normalizeFilePath(filePathAttr, folderPathAttr, filename);
      const normalizedFolder = this._normalizeFolderPath(folderPathAttr, normalizedFilePath);
      prepared.push({
        key,
        item,
        card,
        source: item?.source || card?.getAttribute?.('data-source') || 'local',
        tier: item?.tier || card?.getAttribute?.('data-tier') || 'free',
        filename,
        file_path: normalizedFilePath,
        path: cachedLocalPath || normalizedFolder,
        cachedLocalPath,
        display_name: item?.display_name || card?.getAttribute?.('data-display-name') || '',
        grid_width: Number(item?.grid_width ?? card?.getAttribute?.('data-grid-w') ?? 1) || 1,
        grid_height: Number(item?.grid_height ?? card?.getAttribute?.('data-grid-h') ?? 1) || 1,
        scale: Number(item?.scale ?? card?.getAttribute?.('data-scale') ?? 1) || 1,
        color_variant: item?.color_variant ?? card?.getAttribute?.('data-variant') ?? null,
        base_name_no_variant: item?.base_name_no_variant || '',
        has_color_variant: !!item?.has_color_variant,
        variant_group: item?.base_name_no_variant || item?.display_name || '',
        thumbnail_url: item?.thumbnail_url || '',
        source_item: item
      });
    };

    for (const item of items) {
      addEntryForItem(item);
    }

    if (expandColorVariants && typeof resolveVariants === 'function') {
      const additional = [];
      for (const entry of prepared) {
        try {
          const variants = resolveVariants(entry);
          if (!Array.isArray(variants) || !variants.length) continue;
          for (const variant of variants) {
            additional.push({
              ...variant,
              card: variant.card || null,
              source_item: variant.item || variant
            });
          }
        } catch (_) {}
      }
      for (const extra of additional) {
        const base = extra.source_item || extra;
        addEntryForItem(base, extra.card || null, true);
      }
    }

    if (removedLocked) {
      try { this.refreshSelectionUI(); } catch (_) {}
    }
    return prepared;
  }
}
