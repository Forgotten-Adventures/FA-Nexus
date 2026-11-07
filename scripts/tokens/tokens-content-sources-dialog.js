import {
  BaseContentSourcesDialog,
  createContentSourcesLocalIndexer
} from '../content/content-sources/content-sources-dialog.js';
import { TokenDataService } from './token-data-service.js';

const TOKEN_CONTENT_SOURCES_PRESENTATION = Object.freeze({
  pluralNoun: 'tokens',
  emptyState: 'Click “Add Folder” to select a local token folder.'
});

export class FaNexusTokensFolderSelectionDialog extends BaseContentSourcesDialog {
  /** Configure dialog for token folders */
  constructor(options = {}) {
    const dataService = new TokenDataService();
    const indexer = createContentSourcesLocalIndexer({
      dataService,
      streamMethod: 'streamLocalTokens',
      saveMethod: 'saveTokensIndex'
    });
    super({
      id: 'fa-nexus-tokens-folder-selection',
      title: 'Token Sources Config',
      settingsKey: 'tokenFolders',
      presentation: TOKEN_CONTENT_SOURCES_PRESENTATION,
      cacheType: 'tokens',
      indexer,
      cloudConfig: {
        id: 'cloud-tokens',
        label: 'FA Cloud Tokens',
        setting: 'cloudTokensEnabled',
        kind: 'tokens',
        store: 'tokens',
        metaFolder: 'cloud:tokens',
        description: 'Access the Forgotten Adventures cloud tokens library.',
        icon: 'fa-cloud',
        path: 'FA Nexus Cloud Library',
        itemLabel: 'token',
        indexFailureMessage: 'Failed to index cloud tokens.',
        metaFailureLogTag: 'TokensContentSources.cloudMeta.loadFailed'
      }
    });
    this._tokenDataService = dataService;
  }
}

// Expose for settings menu lazy wrapper (back-compat)
try { window.faNexus = Object.assign(window.faNexus || {}, { TokensFolderDialog: FaNexusTokensFolderSelectionDialog }); } catch (_) {}
