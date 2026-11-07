import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../storage/forge-integration.js';
import {
  contentFilename,
  contentFolder,
  contentPath
} from '../content/cloud-inventory-v2.js';
import { applyTokenCardCachedState } from './token-card-cache-state.js';

export class TokensTabProbeHelper {
  constructor(tab) {
    this.tab = tab;
    this.loader = null;
    this.scrollHandler = null;
    this.scrollGrid = null;
  }

  ensureLoader() {
    if (forgeIntegration.isRunningOnForge()) return null;
    if (this.loader) return this.loader;
    this.loader = { idleDelay: 120, timer: null, queue: new Set(), running: false };
    return this.loader;
  }

  reset() {
    const loader = this.loader;
    if (!loader) return;
    try {
      if (loader.timer) {
        clearTimeout(loader.timer);
        loader.timer = null;
      }
    } catch (_) {}
    try { loader.queue?.clear?.(); } catch (_) {}
    loader.running = false;
  }

  dispose() {
    this.reset();
    this.loader = null;
  }

  installScrollHandler() {
    const grid = this.tab?.getGridContainer?.();
    if (!grid || this.scrollHandler) return;
    const onScroll = () => { this.scheduleVisibleCards(); };
    grid.addEventListener('scroll', onScroll, { passive: true });
    this.scrollHandler = onScroll;
    this.scrollGrid = grid;
  }

  uninstallScrollHandler() {
    const grid = this.scrollGrid || this.tab?.getGridContainer?.();
    if (grid && this.scrollHandler) {
      try { grid.removeEventListener('scroll', this.scrollHandler); } catch (_) {}
    }
    this.scrollHandler = null;
    this.scrollGrid = null;
  }

  scheduleVisibleCards() {
    const loader = this.ensureLoader();
    if (!loader) return;
    try {
      if (loader.timer) clearTimeout(loader.timer);
    } catch (_) {}
    loader.timer = setTimeout(() => { this.runVisibleCards(); }, loader.idleDelay);
  }

  runVisibleCards() {
    if (forgeIntegration.isRunningOnForge()) return;
    const loader = this.loader;
    if (!loader) return;
    try {
      if (loader.timer) {
        clearTimeout(loader.timer);
        loader.timer = null;
      }
    } catch (_) {}
    const grid = this.tab?.getGridContainer?.();
    if (!grid) return;
    const cards = grid.querySelectorAll('.fa-nexus-card[data-source="cloud"]:not([data-cached="true"])');
    loader.queue.clear();
    for (const card of cards) loader.queue.add(card);
    this.runQueue();
  }

  queueCard(cardElement, item) {
    const loader = this.ensureLoader();
    if (!loader || !cardElement) return;
    loader.queue.add(cardElement);
    cardElement._probeJob = { cancelled: false, item };
    this.scheduleVisibleCards();
  }

  cancelCard(cardElement) {
    try {
      if (cardElement?._probeJob) {
        cardElement._probeJob.cancelled = true;
        delete cardElement._probeJob;
      }
    } catch (_) {}
  }

  runQueue() {
    const loader = this.loader;
    if (!loader || loader.running) return;
    const next = loader.queue?.values?.().next?.();
    if (!next || next.done) return;
    const card = next.value;
    loader.queue.delete(card);
    loader.running = true;
    this._probeCard(card).finally(() => {
      loader.running = false;
      this.runQueue();
    });
  }

  async _probeCard(card) {
    if (forgeIntegration.isRunningOnForge()) return;
    const item = card?._assetItem || null;
    let filename = '';
    let resolvedPath = '';
    let folderPathAttr = '';
    try {
      const downloadManager = this.tab?.app?._downloadManager;
      filename = contentFilename(item) || card?.getAttribute?.('data-filename') || '';
      const filePathAttr = contentPath(item) || card?.getAttribute?.('data-content-path') || card?.getAttribute?.('data-file-path') || '';
      folderPathAttr = contentFolder(item) || card?.getAttribute?.('data-folder') || card?.getAttribute?.('data-path') || '';
      resolvedPath = filePathAttr || (folderPathAttr && filename ? `${folderPathAttr.replace(/\/+$/, '')}/${filename}` : '');
      if (!downloadManager || typeof downloadManager.probeLocal !== 'function' || !filename) return;
      const job = card._probeJob || { cancelled: false, item };
      card._probeJob = job;
      const found = await downloadManager.probeLocal('tokens', item || {
        filename,
        file_path: resolvedPath,
        path: folderPathAttr
      });
      if (job.cancelled || !found || !card.isConnected) return;
      applyTokenCardCachedState(card, found, {
        iconSelector: '.fa-nexus-status-icon',
        setResolvedLocalPath: false
      });
    } catch (error) {
      Logger.debug('TokensTab.probe.error', {
        filename,
        file_path: resolvedPath,
        path: folderPathAttr,
        error: String(error?.message || error)
      });
    }
  }
}
