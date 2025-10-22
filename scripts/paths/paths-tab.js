import { AssetsTab } from '../assets/assets-tab.js';

/**
 * PathsTab
 * Dedicated tab for experimenting with path-style assets.
 */
export class PathsTab extends AssetsTab {
  constructor(app) {
    super(app, { mode: 'paths' });
  }
}
