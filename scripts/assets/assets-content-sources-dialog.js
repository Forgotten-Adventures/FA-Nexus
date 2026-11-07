import {
  BaseContentSourcesDialog,
  createContentSourcesLocalIndexer
} from '../content/content-sources/content-sources-dialog.js';
import { AssetsDataService } from './assets-data-service.js';

const ASSET_CONTENT_SOURCES_PRESENTATION = Object.freeze({
  pluralNoun: 'assets',
  emptyState: 'Click “Add Folder” to select a local asset folder.'
});

export class FaNexusAssetsFolderSelectionDialog extends BaseContentSourcesDialog {
  /** Configure dialog for asset folders */
  constructor(options = {}) {
    const dataService = new AssetsDataService();
    const indexer = createContentSourcesLocalIndexer({
      dataService,
      streamMethod: 'streamLocalAssets',
      saveMethod: 'saveAssetsIndex'
    });
    super({
      id: 'fa-nexus-assets-folder-selection',
      title: 'Asset Sources Config',
      settingsKey: 'assetFolders',
      presentation: ASSET_CONTENT_SOURCES_PRESENTATION,
      cacheType: 'assets',
      indexer,
      cloudConfig: {
        id: 'cloud:assets',
        label: 'FA Cloud Assets',
        setting: 'cloudAssetsEnabled',
        kind: 'assets',
        store: 'assets',
        metaFolder: 'cloud:assets',
        description: 'Access the Forgotten Adventures cloud assets library.',
        icon: 'fa-cloud',
        path: 'FA Nexus Cloud Library',
        itemLabel: 'asset',
        indexFailureMessage: 'Failed to index cloud assets.',
        metaFailureLogTag: 'AssetsContentSources.cloudMeta.loadFailed'
      }
    });
    this._assetsDataService = dataService;
  }

  async _invalidateCloudAssetCatalog(reason) {
    const {
      invalidateSharedAssetCatalog,
      invalidateWarmCloudAssetCache
    } = await import('./assets-tab-controller.js');
    invalidateWarmCloudAssetCache(reason);
    invalidateSharedAssetCatalog(reason);
  }

  async _afterCloudIndexCleared(config) {
    if (config?.store !== 'assets') return;
    await this._invalidateCloudAssetCatalog('cloud-index-cleared');
  }

  async _beforeCloudIndex(config) {
    if (config?.store !== 'assets') return;
    await this._invalidateCloudAssetCatalog('cloud-index-started');
  }

  async _afterCloudIndexed(config) {
    if (config?.store !== 'assets') return;
    await this._invalidateCloudAssetCatalog('cloud-indexed');
  }
}

// Expose for potential external usage
try { window.faNexus = Object.assign(window.faNexus || {}, { AssetsFolderDialog: FaNexusAssetsFolderSelectionDialog }); } catch (_) {}
