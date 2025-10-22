/**
 * Bookmark Dialog for FA Nexus
 * Handles saving, editing, and deleting bookmarks
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class BookmarkDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.mode = options.mode || 'save'; // 'save' | 'edit'
    this.titleValue = options.titleValue || '';
    this.bookmarkId = options.bookmarkId || null;
    this.searchQuery = options.searchQuery || '';
    this.folderSelection = options.folderSelection || null;
    this._resolver = null;
  }

  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-bookmark-dialog',
    window: {
      title: 'Bookmark',
      icon: 'fas fa-bookmark',
      resizable: false
    },
    position: { width: 400, height: 'auto' },
    classes: ['fa-nexus-bookmark-dialog']
  };

  static PARTS = {
    content: {
      template: 'modules/fa-nexus/templates/bookmark-dialog.hbs'
    }
  };

  async _prepareContext() {
    const isEdit = this.mode === 'edit';
    const hasSearch = !!this.searchQuery.trim();
    const hasFolders = this.folderSelection &&
                      (this.folderSelection.includePaths?.length > 0 ||
                       this.folderSelection.excludePaths?.length > 0);

    const folderInfo = hasFolders ? this._getFolderInfo() : null;

    return {
      dialogMode: this.mode,
      title: this.titleValue,
      searchQuery: this.searchQuery,
      hasSearch,
      hasFolders,
      folderInfo
    };
  }

  _getFolderInfo() {
    if (!this.folderSelection) return null;

    const includePaths = this.folderSelection.includePaths || [];
    const excludePaths = this.folderSelection.excludePaths || [];

    const result = {};

    if (includePaths.length > 0) {
      // Show up to 3 included folders, then "and X more"
      const shown = includePaths.slice(0, 4);
      const remaining = includePaths.length - shown.length;
      const includeText = shown.join(', ');
      result.includeText = remaining > 0 ? `${includeText} and ${remaining} more` : includeText;
    }

    if (excludePaths.length > 0) {
      // Show up to 3 excluded folders, then "and X more"
      const shown = excludePaths.slice(0, 4);
      const remaining = excludePaths.length - shown.length;
      const excludeText = shown.join(', ');
      result.excludeText = remaining > 0 ? `${excludeText} and ${remaining} more` : excludeText;
    }

    return result;
  }

  _onRender() {
    super._onRender();
    const root = this.element;
    const input = root.querySelector('#bookmark-title');
    const save = root.querySelector('button.save');
    const remove = root.querySelector('button.remove');
    const cancel = root.querySelector('button.cancel');

    if (input) input.focus();

    if (save) {
      save.addEventListener('click', () => {
        const title = (input?.value || '').trim();
        if (!title) return; // Don't allow empty titles

        this._resolveAndClose(this.mode === 'save' ? title : { action: 'save', title });
      });
    }

    if (remove && this.mode === 'edit') {
      remove.addEventListener('click', () => this._resolveAndClose({ action: 'remove' }));
    }

    if (cancel) {
      cancel.addEventListener('click', () => this._resolveAndClose(null));
    }

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const title = (input?.value || '').trim();
        if (title) {
          this._resolveAndClose(this.mode === 'save' ? title : { action: 'save', title });
        }
      }
      if (e.key === 'Escape') this._resolveAndClose(null);
    });
  }

  _resolveAndClose(value) {
    if (this._resolver) this._resolver(value);
    this.close({ force: true });
  }

  /**
   * Show the dialog and return a promise that resolves with the result
   * @returns {Promise<string|null|{action: string, title?: string}>}
   */
  prompt() {
    return new Promise((resolve) => {
      this._resolver = resolve;
      this.render(true);
    });
  }
}

