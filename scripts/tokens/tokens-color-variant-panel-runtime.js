import {
  contentDimensions,
  contentFilename,
  contentFolder,
  contentGrid,
  contentPath,
  inventoryItemKey
} from '../content/cloud-inventory-v2.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { applyTokenCardCachedState, isDirectTokenCacheUrl } from './token-card-cache-state.js';
import { TokenDragDropManager } from './token-dragdrop-manager.js';
import { lockedPremiumContentMessage } from '../premium/patreon-auth-contract.js';

function getHostTheme(hostDocument = null) {
  const doc = hostDocument || (typeof document !== 'undefined' ? document : null);
  const body = doc?.body;
  if (!body) return 'dark';
  return body.classList.contains('theme-dark') ? 'dark' : 'light';
}

function applyThemeToElement(el) {
  if (!el) return;
  const theme = getHostTheme(el.ownerDocument || null);
  el.classList.toggle('fa-theme-dark', theme === 'dark');
  el.classList.toggle('fa-theme-light', theme !== 'dark');
}

function createFaIcon(iconClass, hostDocument = null) {
  const doc = hostDocument || (typeof document !== 'undefined' ? document : null);
  const icon = doc.createElement('i');
  icon.className = `fas ${iconClass}`;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function setIconOnlyContent(element, iconClass) {
  if (!element) return;
  element.replaceChildren(createFaIcon(iconClass, element.ownerDocument || null));
}

export class TokensColorVariantPanelRuntime {
  constructor(tab) {
    this.tab = tab;
    this.panelEl = null;
    this.cleanup = null;
    this.activeBase = null;
    this.boundContextMenu = null;
    this.contextGrid = null;
    this.themeObserver = null;
  }

  installContext() {
    const grid = this.tab?.app?.element?.querySelector?.('#fa-nexus-grid');
    if (!grid) return;

    const onContext = (event) => {
      try { if (!game.settings.get('fa-nexus', 'mainColorOnly')) return; } catch (_) {}
      const card = event.target.closest('.fa-nexus-card');
      if (!card || !grid.contains(card)) return;
      event.preventDefault();
      event.stopPropagation();

      const filename = card.getAttribute('data-filename') || '';
      if (!filename) return;
      const base = this._resolveBaseForCard(card, filename);
      if (this.activeBase && this.activeBase === base) {
        this.hide();
        return;
      }

      const variants = this._sortVariants(this._resolveVariants(base));
      if (!variants.length || variants.length === 1) return;
      this.show(card, base, variants);
    };

    this.uninstallContext();
    grid.addEventListener('contextmenu', onContext);
    this.boundContextMenu = onContext;
    this.contextGrid = grid;
    if (this.tab?.app) this.tab.app._hideColorVariantsPanel = () => { try { this.hide(); } catch (_) {} };
  }

  uninstallContext() {
    if (this.contextGrid && this.boundContextMenu) {
      try { this.contextGrid.removeEventListener('contextmenu', this.boundContextMenu); } catch (_) {}
    }
    this.boundContextMenu = null;
    this.contextGrid = null;
  }

  hide() {
    if (this.panelEl) {
      try { this.panelEl.remove(); } catch (_) {}
      this.panelEl = null;
    }
    if (this.cleanup) {
      try { this.cleanup(); } catch (_) {}
      this.cleanup = null;
    }
    try { this.themeObserver?.disconnect?.(); } catch (_) {}
    this.themeObserver = null;
    this.activeBase = null;
  }

  destroy() {
    this.hide();
    this.uninstallContext();
  }

  notifyPremiumTokenLocked(context = 'color-variant', details = null) {
    try { ui.notifications?.error?.(lockedPremiumContentMessage(game.settings.get('fa-nexus', 'patreon_auth_data'), 'premium tokens')); } catch (_) {}
    try {
      const payload = details && typeof details === 'object' ? { context, ...details } : { context };
      Logger.info('TokensTab.premium.locked', payload);
    } catch (_) {}
  }

  show(anchorCard, baseName, variants) {
    this.hide();
    try { this.tab?._tokenPreview?.hidePreview?.(); } catch (_) {}

    const doc = anchorCard?.ownerDocument || this.tab?.app?.element?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const hostWindow = doc?.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!doc?.body) {
      Logger.debug('TokensTab.colorVariants.noHostDocument', {
        baseName: String(baseName ?? ''),
        variants: Array.isArray(variants) ? variants.length : 0
      });
      return;
    }

    const createElement = (tag) => doc.createElement(tag);
    const requestFrame = typeof hostWindow?.requestAnimationFrame === 'function'
      ? hostWindow.requestAnimationFrame.bind(hostWindow)
      : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 16));

    const panel = createElement('div');
    panel.className = 'fa-nexus-color-variants-panel  application';
    try { applyThemeToElement(panel); } catch (_) {}
    try {
      const MutationObserverCtor = hostWindow?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      if (!MutationObserverCtor) throw new Error('MutationObserver unavailable');
      this.themeObserver = new MutationObserverCtor(() => {
        try { applyThemeToElement(panel); } catch (_) {}
      });
      this.themeObserver.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    } catch (_) {}

    const header = createElement('div');
    header.className = 'fa-nexus-variant-header';
    const title = createElement('span');
    title.className = 'fa-nexus-variant-title';
    title.textContent = String(baseName ?? '');
    const closeButton = createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'fa-nexus-variant-close';
    closeButton.title = 'Close';
    closeButton.textContent = '\u00d7';
    header.append(title, closeButton);

    const grid = createElement('div');
    grid.className = 'fa-nexus-variant-grid';
    panel.replaceChildren(header, grid);

    for (const it of (Array.isArray(variants) ? variants : [])) {
      const item = this._createVariantItem({
        record: it,
        anchorCard,
        baseName,
        doc,
        hostWindow
      });
      grid.appendChild(item);
    }

    doc.body.appendChild(panel);
    const panelRect = () => panel.getBoundingClientRect();
    const cardRect = anchorCard.getBoundingClientRect();
    let left = cardRect.right + 10;
    let top = cardRect.top;
    requestFrame(() => {
      const pr = panelRect();
      const vw = hostWindow?.innerWidth || 1920;
      const vh = hostWindow?.innerHeight || 1080;
      if (left + pr.width > vw) left = Math.max(8, cardRect.left - pr.width - 10);
      if (top + pr.height > vh) top = Math.max(8, vh - pr.height - 8);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.classList.add('visible');
    });

    const closeBtn = panel.querySelector('.fa-nexus-variant-close');
    const onCloseBtn = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.hide();
    };
    const onOutside = (event) => {
      if (!panel.contains(event.target)) this.hide();
    };
    const onResize = () => {
      this.hide();
    };
    // Escape closes this panel and nothing else; left to Foundry it would close the Nexus window behind the panel.
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.hide();
    };
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('click', onOutside, true);
    hostWindow?.addEventListener?.('resize', onResize);
    closeBtn?.addEventListener('click', onCloseBtn);
    this.cleanup = () => {
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('click', onOutside, true);
      hostWindow?.removeEventListener?.('resize', onResize);
      closeBtn?.removeEventListener('click', onCloseBtn);
    };
    this.panelEl = panel;
    this.activeBase = baseName;
  }

  _createVariantItem({ record, anchorCard, baseName, doc, hostWindow }) {
    const createElement = (tag) => doc.createElement(tag);
    const item = createElement('div');
    item.className = 'fa-nexus-variant-item';
    item._variantRecord = record;

    const filename = contentFilename(record);
    const filePath = contentPath(record);
    const folderPath = contentFolder(record);
    const [gridWidth, gridHeight] = contentGrid(record);
    const dims = contentDimensions(record);
    const colorVariant = record?.color?.variant ?? null;
    const colorGroup = record?.color?.group || '';

    item.setAttribute('data-content-id', inventoryItemKey(record));
    item.setAttribute('data-content-path', filePath);
    item.setAttribute('data-folder', folderPath);
    item.setAttribute('data-name', record.name || filename || '');
    item.setAttribute('data-filename', filename || '');
    item.setAttribute('data-path', folderPath || '');
    if (filePath) item.setAttribute('data-file-path', filePath);
    item.setAttribute('data-url', filePath || '');
    item.setAttribute('data-source', record.source || 'local');
    item.setAttribute('data-file-size', record?.selected_source?.size || '');
    if (record.name) item.setAttribute('data-display-name', record.name);
    item.setAttribute('data-width', String(dims.width));
    item.setAttribute('data-height', String(dims.height));
    if (record.tier) item.setAttribute('data-tier', record.tier);
    item.setAttribute('data-grid-w', String(gridWidth));
    item.setAttribute('data-grid-h', String(gridHeight));
    if (record.scale != null) item.setAttribute('data-scale', String(record.scale));
    if (colorVariant != null) item.setAttribute('data-color-variant', String(colorVariant));
    if (colorGroup) item.setAttribute('data-color-group', colorGroup);

    let authed = false;
    let cachedLocalPath = '';
    try {
      const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
      authed = !!(auth && auth.authenticated && auth.state);
    } catch (_) {}
    try {
      if (String(record.source || '') === 'cloud') {
        const dl = this.tab?.app?._downloadManager;
        if (dl) cachedLocalPath = dl.getLocalPath('tokens', record) || '';
      }
    } catch (_) {}
    Logger.trace('tokenVariants', 'TokensTab._showColorVariantsPanel.cachedLocalPath', { cachedLocalPath });
    if (cachedLocalPath) {
      applyTokenCardCachedState(item, cachedLocalPath, {
        iconSelector: null,
        setResolvedLocalPath: false,
        removeLocked: false
      });
    }

    const isLocal = String(record.source || '').toLowerCase() === 'local';
    const isCloud = String(record.source || '').toLowerCase() === 'cloud';
    const isPremium = record.tier === 'premium';
    const iconClass = (() => {
      if (isLocal) return 'fa-folder';
      if (isCloud) {
        if (cachedLocalPath) return 'fa-cloud-check';
        if (isPremium && !authed) return 'fa-lock';
        if (isPremium) return 'fa-cloud-plus';
        return 'fa-cloud';
      }
      return 'fa-cloud';
    })();

    const cv = (colorVariant || '').toString().padStart(2, '0');
    const thumb = createElement('div');
    thumb.className = 'thumb';
    const img = createElement('img');
    img.alt = String(record.name || filename || '');
    thumb.appendChild(img);
    const variantNumber = createElement('div');
    variantNumber.className = 'fa-nexus-variant-number';
    variantNumber.textContent = cv;
    const statusIcon = createElement('div');
    statusIcon.className = 'fa-nexus-token-status-icon';
    statusIcon.title = isLocal ? 'Local storage' : (isPremium ? (authed || cachedLocalPath ? 'Premium (unlocked)' : 'Premium (locked)') : (cachedLocalPath ? 'Downloaded' : 'Cloud'));
    setIconOnlyContent(statusIcon, iconClass);
    item.replaceChildren(thumb, variantNumber, statusIcon);

    try {
      const iconEl = item.querySelector('.fa-nexus-token-status-icon');
      if (iconEl) {
        iconEl.classList.remove('local', 'cloud', 'premium', 'cached', 'cloud-plus');
        if (isLocal) iconEl.classList.add('local');
        else if (isCloud) {
          if (isPremium && !(authed || cachedLocalPath)) {
            iconEl.classList.add('premium');
            item.classList.add('locked-token');
          }
          if (isPremium) iconEl.classList.add('cloud-plus');
          else iconEl.classList.add('cloud');
          if (cachedLocalPath) {
            iconEl.classList.remove('cloud-plus', 'cloud', 'premium');
            iconEl.classList.add('cloud', 'cached');
          }
        }
      }
    } catch (_) {}

    this._setVariantThumbnail(item, record, filePath);
    this._bindVariantHover(item);
    this._bindVariantDrag(item, {
      record,
      anchorCard,
      baseName,
      colorVariant,
      filename,
      cachedLocalPathRef: () => cachedLocalPath,
      setCachedLocalPath: (value) => { cachedLocalPath = value; },
      doc,
      hostWindow
    });
    this._bindVariantClick(item, {
      baseName
    });

    return item;
  }

  _setVariantThumbnail(item, record, filePath) {
    try {
      const imgEl = item.querySelector('img');
      if (!imgEl) return;
      if (String(record.source || '') === 'cloud') {
        const svc = this.tab?.app?._contentService;
        if (svc) imgEl.src = svc.getThumbnailURL('tokens', record);
      } else if (record.enhanced_thumbnail && record.thumbnail_url) {
        imgEl.src = record.thumbnail_url;
      } else {
        imgEl.src = filePath || '';
      }
    } catch (_) {}
  }

  _bindVariantHover(item) {
    item.addEventListener('mouseover', () => {
      try {
        Logger.trace('tokenVariants', 'TokensTab._showColorVariantsPanel.mouseover', {
          isHoverSuppressed: TokenDragDropManager?.isHoverSuppressed?.(),
          item
        });
        try { if (TokenDragDropManager?.isHoverSuppressed?.()) return; } catch (_) {}
        const source = item.getAttribute('data-source') || '';
        const tier = item.getAttribute('data-tier') || '';
        let authed = false;
        try {
          const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
          authed = !!(auth && auth.authenticated && auth.state);
        } catch (_) {}
        const hasLocal = !!item.getAttribute('data-url');
        if (source === 'cloud' && tier === 'premium' && !authed && !hasLocal) return;
        const img = item.querySelector('img');
        this.tab?._tokenPreview?.showPreviewWithDelay?.(img, item, 300);
      } catch (_) {}
    });
    item.addEventListener('mouseout', (event) => {
      try {
        const to = event.relatedTarget;
        if (to && item.contains(to)) return;
        this.tab?._tokenPreview?.hidePreview?.();
      } catch (_) {}
    });
  }

  _bindVariantDrag(item, {
    record,
    anchorCard,
    baseName,
    colorVariant,
    filename,
    cachedLocalPathRef,
    setCachedLocalPath,
    doc,
    hostWindow
  }) {
    try { item.setAttribute('draggable', 'false'); } catch (_) {}
    item.addEventListener('mousedown', async (event) => {
      Logger.trace('tokenVariants', 'TokensTab._showColorVariantsPanel.mousedown', { ev: event });
      if (event.button !== 0) return;
      const source = item.getAttribute('data-source') || '';
      const tier = item.getAttribute('data-tier') || '';
      let authed = false;
      try {
        const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
        authed = !!(auth && auth.authenticated && auth.state);
      } catch (_) {}
      const cachedFlag = item.getAttribute('data-cached') === 'true';
      Logger.trace('tokenVariants', 'TokensTab._showColorVariantsPanel.dragState', {
        tier,
        authed,
        cachedLocalPath: cachedLocalPathRef(),
        cachedFlag
      });
      if (!this._ensureVariantUnlocked(item, {
        context: 'variant-mousedown',
        baseName,
        filename,
        colorVariant
      })) return;
      if (source === 'cloud') {
        try {
          await this.tab?._dragDrop?._prepareCloudForDrag?.(item);
          if (item._ensureLocalPromise && !cachedLocalPathRef()) {
            const isMainVariant = !!(record.color?.main || String(colorVariant || '') === '01');
            item._ensureLocalPromise.then((localPath) => {
              try {
                if (localPath) {
                  const isDirectUrl = isDirectTokenCacheUrl(localPath);
                  applyTokenCardCachedState(item, localPath, {
                    iconSelector: isDirectUrl ? null : '.fa-nexus-token-status-icon',
                    iconClassesToRemove: ['premium', 'cloud-plus'],
                    setResolvedLocalPath: false,
                    removeLocked: false
                  });
                  if (!isDirectUrl) {
                    setCachedLocalPath(cachedLocalPathRef() || localPath);
                    if (isMainVariant && anchorCard) {
                      applyTokenCardCachedState(anchorCard, localPath, {
                        iconSelector: '.fa-nexus-status-icon',
                        iconClassesToRemove: [],
                        setResolvedLocalPath: false,
                        removeLocked: false
                      });
                    }
                  }
                }
              } catch (_) {}
            }).catch((error) => {
              Logger.warn('TokensTab.colorVariants.ensureLocal.failed', {
                base: baseName,
                filename,
                variant: colorVariant || '',
                error: String(error?.message || error)
              });
            });
          }
        } catch (_) {}
      }

      const startX = event.clientX;
      const startY = event.clientY;
      const threshold = 4;
      item._faVariantDragging = false;
      const listenerDocument = item.ownerDocument || doc;
      const defer = typeof hostWindow?.setTimeout === 'function'
        ? hostWindow.setTimeout.bind(hostWindow)
        : setTimeout;
      const move = (moveEvent) => {
        const dx = Math.abs((moveEvent.clientX || 0) - startX);
        const dy = Math.abs((moveEvent.clientY || 0) - startY);
        if (dx + dy > threshold) {
          listenerDocument.removeEventListener('mousemove', move, true);
          listenerDocument.removeEventListener('mouseup', up, true);
          item._faVariantDragging = true;
          try {
            TokenDragDropManager.setHoverSuppressed(true);
            this.tab?._dragDrop?._startQueuedDrag?.(item, moveEvent.clientX, moveEvent.clientY);
          } catch (_) {}
        }
      };
      const up = () => {
        listenerDocument.removeEventListener('mousemove', move, true);
        listenerDocument.removeEventListener('mouseup', up, true);
        defer(() => { item._faVariantDragging = false; }, 0);
      };
      listenerDocument.addEventListener('mousemove', move, true);
      listenerDocument.addEventListener('mouseup', up, true);
    }, { capture: true });
  }

  _bindVariantClick(item, { baseName }) {
    item.addEventListener('click', (event) => {
      if (event.button !== 0) return;
      if (item._faVariantDragging) {
        item._faVariantDragging = false;
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const source = item.getAttribute('data-source') || '';
      const tier = item.getAttribute('data-tier') || '';
      let authed = false;
      try {
        const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
        authed = !!(auth && auth.authenticated && auth.state);
      } catch (_) {}
      const cached = item.getAttribute('data-cached') === 'true';
      if (!cached && source === 'cloud' && tier === 'premium' && !authed) {
        this._ensureVariantUnlocked(item, {
          context: 'variant-click',
          baseName,
          filename: item.getAttribute('data-filename') || '',
          colorVariant: item.getAttribute('data-color-variant') || ''
        });
        return;
      }

      try { TokenDragDropManager.setHoverSuppressed(true); } catch (_) {}
      this.hide();
      const placementPromise = this.tab?._placement?.startPlacementFromCard?.(item, {
        sticky: event.shiftKey,
        pointerEvent: event
      });
      Promise.resolve(placementPromise)
        .catch((error) => {
          Logger.warn('TokensTab.place.variant.failed', {
            base: baseName,
            filename: item.getAttribute('data-filename') || '',
            variant: item.getAttribute('data-color-variant') || '',
            error: String(error?.message || error)
          });
        })
        .finally(() => {
          if (!this.tab?._placement?.isPlacementActive) {
            try { TokenDragDropManager.setHoverSuppressed(false); } catch (_) {}
          }
        });
    });
  }

  _resolveBaseForCard(card, filename) {
    const cardItem = card?._assetItem || null;
    return cardItem?.color?.group
      || card?.getAttribute?.('data-color-group')
      || (String(filename || '').replace(/\.[^/.]+$/, '').match(/^(.+)_\d+$/) || [null, String(filename || '').replace(/\.[^/.]+$/, '')])[1];
  }

  _resolveVariants(base) {
    const all = Array.isArray(this.tab?._items) ? this.tab._items : [];
    return all.filter((item) => {
      if (item?.color?.group) return item.color.group === base;
      const noExt = String(contentFilename(item) || '').replace(/\.[^/.]+$/, '');
      const match = noExt.match(/^(.+)_\d+$/);
      return match && match[1] === base;
    });
  }

  _sortVariants(variants) {
    return variants.sort((left, right) => {
      if (left?.color?.variant || right?.color?.variant) {
        return (parseInt(left?.color?.variant || '0', 10) || 0) - (parseInt(right?.color?.variant || '0', 10) || 0);
      }
      const leftNoExt = String(contentFilename(left) || '').replace(/\.[^/.]+$/, '');
      const rightNoExt = String(contentFilename(right) || '').replace(/\.[^/.]+$/, '');
      const leftMatch = leftNoExt.match(/^(.+)_(\d+)$/);
      const rightMatch = rightNoExt.match(/^(.+)_(\d+)$/);
      if (!leftMatch || !rightMatch) return 0;
      const leftNum = parseInt(leftMatch[2], 10) || 0;
      const rightNum = parseInt(rightMatch[2], 10) || 0;
      return leftNum - rightNum;
    });
  }

  _isVariantLocked(item) {
    try {
      const sourceAttr = (item.getAttribute('data-source') || '').toLowerCase();
      if (sourceAttr !== 'cloud') return false;
      const tierAttr = (item.getAttribute('data-tier') || '').toLowerCase();
      if (tierAttr !== 'premium') return false;
      if (item.getAttribute('data-cached') === 'true') return false;
      let authedNow = false;
      try {
        const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
        authedNow = !!(auth && auth.authenticated && auth.state);
      } catch (_) {}
      return !authedNow;
    } catch (_) {
      return false;
    }
  }

  _reportLockedVariant(item, { context, baseName, filename, colorVariant }) {
    const now = Date.now();
    const last = Number(item._faLockWarned || 0);
    if (!Number.isFinite(last) || (now - last) > 600) {
      this.notifyPremiumTokenLocked('color-variant', {
        context,
        base: baseName,
        filename,
        variant: colorVariant || ''
      });
    }
    item._faLockWarned = now;
  }

  _ensureVariantUnlocked(item, details) {
    if (!this._isVariantLocked(item)) return true;
    this._reportLockedVariant(item, details);
    return false;
  }
}
