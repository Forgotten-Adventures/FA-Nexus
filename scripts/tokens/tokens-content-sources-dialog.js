import { BaseContentSourcesDialog } from '../content/content-sources/content-sources-dialog.js';
import { TokenDataService } from './token-data-service.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

export class FaNexusTokensFolderSelectionDialog extends BaseContentSourcesDialog {
  /** Configure dialog for token folders */
  constructor(options = {}) {
    const dataService = new TokenDataService();
    const indexer = async (folder, { onProgress, signal } = {}) => {
      if (!folder) return { count: 0 };
      const abortError = () => {
        try { return new DOMException(signal?.reason || 'Cancelled', 'AbortError'); }
        catch (_) {
          const err = new Error(signal?.reason || 'Cancelled');
          err.name = 'AbortError';
          return err;
        }
      };
      const checkAbort = () => { if (signal?.aborted) throw abortError(); };
      const emit = (info) => { if (typeof onProgress === 'function') { try { onProgress(info); } catch (_) {} } };
      emit({ folder, count: 0, batchCount: 0 });
      const records = [];
      checkAbort();
      await dataService.streamLocalTokens(folder, async (batch) => {
        if (!Array.isArray(batch) || !batch.length) return;
        records.push(...batch);
        emit({ folder, count: records.length, batchCount: batch.length });
      }, { batchSize: 220, sleepMs: 8, signal });
      checkAbort();
      await dataService.saveTokensIndex(folder, records);
      return { count: records.length };
    };
    super({
      id: 'fa-nexus-tokens-folder-selection',
      title: 'Token Sources Config',
      settingsKey: 'tokenFolders',
      template: 'modules/fa-nexus/templates/tokens/tokens-content-sources-dialog.hbs',
      cacheType: 'tokens',
      indexer
    });
    this._tokenDataService = dataService;
    this._cloudEnabledSetting = 'cloudTokensEnabled';
    this._cloudCacheMeta = { count: 0, folder: 'cloud:tokens', latest: null };
    this._indexControllers = new Map(); // Initialize controller tracking for cloud indexing
    this._loadCloudMeta().catch(() => {});
  }

  async _loadCloudMeta() {
    try {
      const { NexusContentService } = await import('../content/nexus-content-service.js');
      const app = foundry?.applications?.instances?.get?.('fa-nexus-app') || null;
      const authProvider = (app && typeof app._getAuthService === 'function') ? () => app._getAuthService() : undefined;
      const svc = new NexusContentService({ app, authService: authProvider });
      const meta = await svc.getMeta('tokens');
      if (meta) {
        this._cloudCacheMeta = { count: Number(meta.count) || 0, folder: 'cloud:tokens', latest: meta.latest || null };
        if (this.rendered) {
          if (this._cloudContext) {
            this._cloudContext.cacheCount = this._cloudCacheMeta.count;
            this._cloudContext.hasCache = this._cloudCacheMeta.count > 0;
            this._cloudContext.version = this._cloudCacheMeta.latest || this._cloudContext.version || null;
          }
          this._renderCloudRow();
        }
      }
    } catch (_) {}
  }

  _getCloudConfig() {
    return {
      id: 'cloud-tokens',
      label: 'FA Cloud Tokens',
      setting: this._cloudEnabledSetting,
      cacheCount: this._cloudCacheMeta?.count ?? 0,
      description: 'Access the Forgotten Adventures cloud tokens library.',
      icon: 'fa-cloud',
      path: 'FA Nexus Cloud Library',
      db: 'fa-nexus-cloud-tokens-v1',
      store: 'tokens'
    };
  }

  async _handleIndexFolder(folder, button) {
    // Handle cloud indexing specially
    const cloudConfig = this._getCloudConfig();
    if (cloudConfig && this._pathsEqual(folder, cloudConfig.id)) {
      return this._handleIndexCloud(button);
    }
    // Fall back to base implementation for local folders
    return super._handleIndexFolder(folder, button);
  }

  async _handleIndexCloud(button) {
    const cloudConfig = this._getCloudConfig();
    if (!cloudConfig) return;

    const folder = cloudConfig.id || 'cloud-tokens';
    const normalized = this._normalizePath(folder);
    if (this._indexControllers.has(normalized)) return;

    const controller = new AbortController();
    this._indexControllers.set(normalized, controller);

    this._captureScrollPosition();
    this._renderIndexState(folder, { status: 'running', count: 0, error: null, startedAt: Date.now() });

    const emitProgress = (info = {}) => {
      const count = Number.isFinite(info?.count) ? Number(info.count) : 0;
      this._renderIndexState(folder, { status: 'running', count: Math.max(0, count), updatedAt: Date.now() });
    };

    try {
      const { NexusContentService } = await import('../content/nexus-content-service.js');
      const app = foundry?.applications?.instances?.get?.('fa-nexus-app') || null;
      const authProvider = (app && typeof app._getAuthService === 'function') ? () => app._getAuthService() : undefined;
      const svc = new NexusContentService({ app, authService: authProvider });

      // Sync cloud tokens
      await svc.sync('tokens', {
        signal: controller.signal,
        onManifestProgress: ({ count, total }) => {
          emitProgress({ count });
        },
        progressBatch: 500
      });

      // Update cache meta
      const meta = await svc.getMeta('tokens');
      const finalCount = Number(meta?.count) || 0;
      if (meta) {
        this._cloudCacheMeta = { count: finalCount, folder: 'cloud-tokens', latest: meta.latest || null };
        if (this._cloudContext) {
          this._cloudContext.cacheCount = this._cloudCacheMeta.count;
          this._cloudContext.hasCache = this._cloudCacheMeta.count > 0;
          this._cloudContext.version = this._cloudCacheMeta.latest || this._cloudContext.version || null;
        }
        this._renderCloudRow();
      }

      this._renderIndexState(folder, { status: 'done', count: finalCount, finishedAt: Date.now(), error: null });
      this._markCacheDirty();
      this._captureScrollPosition();
      this._requestRender({ immediate: true, preserveScroll: true });
      if (ui?.notifications?.info) ui.notifications.info(`Indexed ${finalCount} cloud token(s)`);
    } catch (error) {
      if (error?.name === 'AbortError') {
        this._renderIndexState(folder, { status: 'cancelled', finishedAt: Date.now() });
      } else {
        Logger.error('Folders.cloud.index:failed', error);
        this._renderIndexState(folder, { status: 'error', error: error?.message || String(error), finishedAt: Date.now() });
        if (ui?.notifications?.error) ui.notifications.error('Failed to index cloud tokens.');
      }
      this._captureScrollPosition();
      this._requestRender({ immediate: true, preserveScroll: true });
    } finally {
      this._indexControllers.delete(normalized);
      if (button && button.isConnected) {
        button.disabled = false;
      }
    }
  }
}

// Expose for settings menu lazy wrapper (back-compat)
try { window.faNexus = Object.assign(window.faNexus || {}, { TokensFolderDialog: FaNexusTokensFolderSelectionDialog }); } catch (_) {}
