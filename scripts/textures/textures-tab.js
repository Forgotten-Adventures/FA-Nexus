import { AssetsTab } from '../assets/assets-tab.js';

/**
 * TexturesTab
 * Specialised assets tab that routes card clicks into the texture paint workflow.
 */
export class TexturesTab extends AssetsTab {
  constructor(app) {
    super(app, { mode: 'textures' });
  }
}
