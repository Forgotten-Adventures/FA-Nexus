import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../core/forge-integration.js';

export class AssetsTabProbeHelper {
  constructor(tab) {
    this.tab = tab;
    this.loader = null;
  }

  ensureLoader() {
    if (forgeIntegration.isRunningOnForge()) return null;
    if (this.loader) return this.loader;
    this.loader = { idleDelay: 120, timer: null, queue: new Set(), running: false };
    return this.loader;
  }

  reset() {
    const L = this.loader;
    if (!L) return;
    try { if (L.timer) clearTimeout(L.timer); } catch (_) {}
    try { if (L.queue) L.queue.clear(); } catch (_) {}
    L.timer = null;
    L.running = false;
  }

  dispose() {
    this.reset();
    this.loader = null;
  }

  scheduleVisibleCards() {
    const L = this.ensureLoader();
    if (!L) return;
    if (this.tab.isThumbSizeAdjustActive) {
      this.tab._pendingProbeAfterThumbAdjust = true;
      try { if (L.timer) { clearTimeout(L.timer); L.timer = null; } } catch (_) {}
      return;
    }
    try { if (L.timer) clearTimeout(L.timer); } catch (_) {}
    L.timer = setTimeout(() => this.runQueue(), L.idleDelay);
  }

  queueCard(cardElement, item) {
    const L = this.ensureLoader();
    if (!L) return;
    L.queue.add(cardElement);
    cardElement._probeJob = { cancelled: false, item };
    this.scheduleVisibleCards();
  }

  runQueue() {
    if (forgeIntegration.isRunningOnForge()) return;
    const L = this.loader;
    if (!L || L.running) return;
    if (this.tab.isThumbSizeAdjustActive) {
      this.tab._pendingProbeAfterThumbAdjust = true;
      return;
    }
    try { if (L.timer) { clearTimeout(L.timer); L.timer = null; } } catch (_) {}
    const next = L.queue?.values?.().next?.();
    if (!next || next.done) return;
    const card = next.value;
    L.queue.delete(card);
    L.running = true;
    this._probeCard(card).finally(() => {
      L.running = false;
      this.runQueue();
    });
  }

  async _probeCard(card) {
    if (forgeIntegration.isRunningOnForge()) return;
    try {
      const item = card._assetItem || null;
      const download = this.tab.downloadManager;
      const filename = card.getAttribute('data-filename') || item?.filename || '';
      const filePathAttr = card.getAttribute('data-file-path') || '';
      const folderPathAttr = card.getAttribute('data-path') || '';
      if (!download || typeof download.probeLocal !== 'function' || !filename) return;
      const job = card._probeJob || { cancelled: false, item };
      card._probeJob = job;
      const found = await download.probeLocal('assets', { filename, file_path: filePathAttr, path: folderPathAttr });
      if (job.cancelled || !found || !card.isConnected) return;
      try { card.setAttribute('data-url', found); } catch (_) {}
      try { card.setAttribute('data-cached', 'true'); } catch (_) {}
      if (item) item.cachedLocalPath = item.cachedLocalPath || found;
      const icon = card.querySelector('.fa-nexus-status-icon');
      if (icon) {
        icon.classList.remove('cloud-plus', 'cloud', 'premium');
        icon.classList.add('cloud', 'cached');
        icon.title = 'Downloaded';
        icon.innerHTML = '<i class="fas fa-cloud-check"></i>';
      }
    } catch (error) {
      Logger.warn('AssetsTab.probe.error', { error: String(error?.message || error) });
    }
  }
}
