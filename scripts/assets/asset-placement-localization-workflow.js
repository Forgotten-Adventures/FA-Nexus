import { NexusLogger as Logger } from '../core/nexus-logger.js';

const DIRECT_R2_URL_PATTERN = /^https?:\/\/r2-public\.forgotten-adventures\.net\//i;

export class AssetPlacementLocalizationWorkflow {
  constructor(manager) {
    if (!manager) throw new Error('AssetPlacementLocalizationWorkflow requires manager.');
    this.manager = manager;
  }

  async ensureAssetLocal(asset) {
    if (!asset) return null;
    if (asset.cachedLocalPath) return asset.cachedLocalPath;
    if (!this._isCloudAsset(asset)) return asset.path || asset.url || null;
    const item = this._buildDownloadItem(asset, { includePath: true });
    const { content, dl } = this._requireContentServices();
    const fullUrl = await content.getFullURL('assets', item, this._getAuthState());
    const local = await dl.ensureLocal('assets', item, fullUrl);
    this._applyLocalAssetPath(asset, local);
    return local;
  }

  async ensureRandomCommitAssetLocal(asset) {
    if (!asset) return null;
    if (asset.cachedLocalPath) return asset.cachedLocalPath;
    if (!this._isCloudAsset(asset)) return asset.path || asset.url || null;
    const filename = String(asset.filename || '');
    try {
      const app = this.manager.app;
      const content = app?._contentService;
      const dl = app?._downloadManager;
      const item = this._buildDownloadItem(asset, { includePath: false });
      const authState = this._getAuthState();
      const fullUrl = content?.getFullURL ? await content.getFullURL('assets', item, authState) : null;
      const local = dl?.ensureLocal && fullUrl ? await dl.ensureLocal('assets', item, fullUrl) : null;
      if (local) {
        this._applyLocalAssetPath(asset, local, {
          beforeGridUpdate: () => Logger.info('Placement.lazyDownload.done', { filename, local })
        });
      }
      return local;
    } catch (e) {
      Logger.warn('Placement.lazyDownload.failed', String(e?.message || e));
      return null;
    }
  }

  _isCloudAsset(asset) {
    return String(asset?.source || '').toLowerCase() === 'cloud';
  }

  _buildDownloadItem(asset, { includePath }) {
    const item = {
      file_path: asset.file_path || asset.path,
      filename: String(asset.filename || ''),
      tier: asset.tier || 'free'
    };
    if (includePath) {
      item.path = asset.folder_path || asset.path || asset.file_path || '';
    }
    return item;
  }

  _requireContentServices() {
    const app = this.manager.app;
    const content = app?._contentService;
    const dl = app?._downloadManager;
    if (!content || !dl) throw new Error('Content services unavailable');
    return { content, dl };
  }

  _getAuthState() {
    const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
    return auth && auth.authenticated && auth.state ? auth.state : undefined;
  }

  _applyLocalAssetPath(asset, local, { beforeGridUpdate = null } = {}) {
    if (!local) return;
    if (!DIRECT_R2_URL_PATTERN.test(local)) {
      asset.cachedLocalPath = local;
    }
    asset.path = local;
    asset.url = local;
    if (typeof beforeGridUpdate === 'function') beforeGridUpdate();
    try { this.manager._updateGridCardDownloaded(asset.file_path || asset.path, local); }
    catch (_) {}
  }
}
