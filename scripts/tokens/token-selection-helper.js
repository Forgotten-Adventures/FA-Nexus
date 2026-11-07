import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { GridSelectionHelper } from '../core/placement/grid-selection-helper.js';
import {
  contentPath,
  inventoryItemKey
} from '../content/cloud-inventory-v2.js';
import { buildTokenPlacementEntryFromRecord } from './token-placement-entry.js';

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
          const direct = inventoryItemKey(item) || contentPath(item);
          if (direct) return direct;
          const base = String(item.color?.group || item.name || '').toLowerCase();
          const variant = String(item.color?.variant || '').toLowerCase();
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
          const filePath = cardElement.getAttribute('data-content-id') || cardElement.getAttribute('data-content-path') || cardElement.getAttribute('data-file-path') || cardElement.getAttribute('data-url') || '';
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
      const entry = buildTokenPlacementEntryFromRecord(item, {
        key,
        card,
        downloadManager,
        useCardFallbacks: true,
        pathStrategy: 'cached-or-folder',
        includeItemAlias: true
      });
      if (!entry) return;
      prepared.push(entry);
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
