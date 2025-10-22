const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * FolderFilterWindow
 * Lightweight companion window for the folder filter drawer that tethers to
 * the main FA Nexus shell while preserving the existing filter logic.
 */
export class FolderFilterWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  // Clone parent defaults so FA-specific ids/width do not leak onto other ApplicationV2 windows.
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.DEFAULT_OPTIONS ?? {}),
    {
      id: 'fa-nexus-folder-window',
      tag: 'section',
      position: { width: 265 },
      window: {
        resizable: false,
        minimizable: false,
        title: 'Folders Filter'
      }
    },
    { inplace: false }
  );

  static PARTS = {
    body: { template: 'modules/fa-nexus/templates/folder-filter.hbs' }
  };

  constructor(parentApp) {
    super();
    this._parentApp = parentApp;
    this._maxHeight = null;
  }

  /**
   * Expose the folder filter panel element so the shared FolderFilter helper
   * can attach event listeners and render the tree.
   */
  getPanelElement() {
    return this.element?.querySelector('.fa-nexus-folder-browser') || null;
  }

  /**
   * Ensure the parent app can reattach the FolderFilter whenever the window
   * renders or rerenders.
   */
  _onRender(initial, context) {
    super._onRender(initial, context);
    try { this.element?.classList?.add('fa-nexus-folder-window-root'); } catch (_) {}
    /*try { this._disableWindowTransitions(); } catch (_) {}*/
    try { this._applyMaxHeightStyles(); } catch (_) {}
    try { this._parentApp?._onFilterWindowRendered?.(this); } catch (_) {}
    try { this.requestFitToContent(); } catch (_) {}
  }

  _onClose(options = {}) {
    try { this._parentApp?._onFilterWindowClosed?.(); } catch (_) {}
    super._onClose(options);
  }

  setMaxHeight(value) {
    if (Number.isFinite(value) && value > 0) this._maxHeight = value;
    else this._maxHeight = null;
    this._applyMaxHeightStyles();
    this.requestFitToContent();
  }

  requestFitToContent() {
    this._applyAutoHeight();
  }

  _applyAutoHeight() {
    const root = this.element;
    if (!root) return;

    if (this.options?.position && Object.prototype.hasOwnProperty.call(this.options.position, 'height')) {
      delete this.options.position.height;
    }

    root.style.removeProperty('height');
    root.style.height = 'auto';

    const content = this._getWindowContentElement(root);
    if (content) {
      content.style.removeProperty('height');
      content.style.height = 'auto';
    }

    this._applyMaxHeightStyles();
  }

  _disableWindowTransitions() {
    const root = this.element;
    if (!root) return;
    root.style.transition = 'none';
    root.style.animationDuration = '0s';
    const content = this._getWindowContentElement(root);
    if (content) {
      content.style.transition = 'none';
      content.style.animationDuration = '0s';
    }
  }

  _getWindowHeaderElement(root) {
    if (!root?.children) return null;
    for (const child of root.children) {
      if (child?.classList?.contains('window-header')) return child;
    }
    return null;
  }

  _getWindowContentElement(root) {
    if (!root?.children) return null;
    for (const child of root.children) {
      if (child?.classList?.contains('window-content')) return child;
    }
    return null;
  }

  _getWindowHeaderHeight(root) {
    const header = this._getWindowHeaderElement(root);
    const fallbackHeight = Math.ceil(this.constructor.DEFAULT_OPTIONS?.window?.headerHeight ?? 36) + 2;
    if (!header) return fallbackHeight;

    const rectHeight = Math.ceil(header.getBoundingClientRect?.().height || 0);
    const offsetHeight = Math.ceil(header.offsetHeight || 0);
    let height = Math.max(rectHeight, offsetHeight, 0);

    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const styles = window.getComputedStyle(header);
      const marginTop = parseFloat(styles?.marginTop ?? '0') || 0;
      const marginBottom = parseFloat(styles?.marginBottom ?? '0') || 0;
      height += marginTop + marginBottom;
    }

    height = Math.ceil(height);
    return height > 0 ? height + 2 : fallbackHeight;
  }

  _applyMaxHeightStyles() {
    const root = this.element;
    if (!root) return;
    const maxHeight = Number.isFinite(this._maxHeight) ? this._maxHeight : null;
    if (maxHeight) root.style.maxHeight = `${maxHeight}px`;
    else root.style.removeProperty('max-height');

    const content = this._getWindowContentElement(root);
    if (!content) return;
    const headerHeight = this._getWindowHeaderHeight(root);
    if (maxHeight) {
      const contentMax = Math.max(maxHeight - headerHeight, 0);
      content.style.maxHeight = `${contentMax}px`;
    } else {
      content.style.removeProperty('max-height');
    }
  }
}
