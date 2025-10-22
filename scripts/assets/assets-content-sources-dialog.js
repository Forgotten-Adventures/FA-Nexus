import { BaseContentSourcesDialog } from '../content/content-sources/content-sources-dialog.js';
import { AssetsDataService } from './assets-data-service.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

export class FaNexusAssetsFolderSelectionDialog extends BaseContentSourcesDialog {
  /** Configure dialog for asset folders */
  constructor(options = {}) {
    const dataService = new AssetsDataService();
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
      await dataService.streamLocalAssets(folder, async (batch) => {
        if (!Array.isArray(batch) || !batch.length) return;
        records.push(...batch);
        emit({ folder, count: records.length, batchCount: batch.length });
      }, { batchSize: 220, sleepMs: 8, signal });
      checkAbort();
      await dataService.saveAssetsIndex(folder, records);
      return { count: records.length };
    };
    super({
      id: 'fa-nexus-assets-folder-selection',
      title: 'Asset Sources Config',
      settingsKey: 'assetFolders',
      template: 'modules/fa-nexus/templates/assets/assets-content-sources-dialog.hbs',
      cacheType: 'assets',
      indexer
    });
    this._assetsDataService = dataService;
    this._cloudEnabledSetting = 'cloudAssetsEnabled';
    this._cloudCacheMeta = { count: 0, folder: 'cloud:assets', latest: null };
    this._indexControllers = new Map(); // Initialize controller tracking for cloud indexing
    this._loadCloudMeta().catch(() => {});
  }

  async _loadCloudMeta() {
    try {
      const { NexusContentService } = await import('../content/nexus-content-service.js');
      const app = foundry?.applications?.instances?.get?.('fa-nexus-app') || null;
      const authProvider = (app && typeof app._getAuthService === 'function') ? () => app._getAuthService() : undefined;
      const svc = new NexusContentService({ app, authService: authProvider });
      const meta = await svc.getMeta('assets');
      if (!meta) return;
      this._cloudCacheMeta = { count: Number(meta.count) || 0, folder: 'cloud:assets', latest: meta.latest || null };
      if (this.rendered) {
        if (this._cloudContext) {
          this._cloudContext.cacheCount = this._cloudCacheMeta.count;
          this._cloudContext.hasCache = this._cloudCacheMeta.count > 0;
          this._cloudContext.version = this._cloudCacheMeta.latest || this._cloudContext.version || null;
        }
        this._renderCloudRow();
      }
    } catch (_) {}
  }

  _getCloudConfig() {
    return {
      id: 'cloud:assets',
      label: 'FA Cloud Assets',
      setting: this._cloudEnabledSetting,
      cacheCount: this._cloudCacheMeta?.count ?? 0,
      description: 'Access the Forgotten Adventures cloud assets library.',
      icon: 'fa-cloud',
      path: 'FA Nexus Cloud Library',
      db: 'fa-nexus-cloud-assets-v1',
      store: 'assets'
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

    const folder = cloudConfig.id || 'cloud:assets';
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

      // Sync cloud assets
      await svc.sync('assets', {
        signal: controller.signal,
        onManifestProgress: ({ count, total }) => {
          emitProgress({ count });
        },
        progressBatch: 500
      });

      // Update cache meta
      const meta = await svc.getMeta('assets');
      const finalCount = Number(meta?.count) || 0;
      if (meta) {
        this._cloudCacheMeta = { count: finalCount, folder: 'cloud:assets', latest: meta.latest || null };
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
      if (ui?.notifications?.info) ui.notifications.info(`Indexed ${finalCount} cloud asset(s)`);
    } catch (error) {
      if (error?.name === 'AbortError') {
        this._renderIndexState(folder, { status: 'cancelled', finishedAt: Date.now() });
      } else {
        Logger.error('Folders.cloud.index:failed', error);
        this._renderIndexState(folder, { status: 'error', error: error?.message || String(error), finishedAt: Date.now() });
        if (ui?.notifications?.error) ui.notifications.error('Failed to index cloud assets.');
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

// Expose for potential external usage
try { window.faNexus = Object.assign(window.faNexus || {}, { AssetsFolderDialog: FaNexusAssetsFolderSelectionDialog }); } catch (_) {}
