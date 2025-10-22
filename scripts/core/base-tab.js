/**
 * BaseTab: minimal interface for Nexus tabs
 * Tabs encapsulate their own data loading, search, grid rendering and footer/UI bindings.
 */
export class BaseTab {
  /**
   * @param {import('../nexus-app.js').FaNexusApp} app - Host application
   */
  constructor(app) { this.app = app; }

  /** Unique id for the tab (e.g., 'tokens', 'assets') */
  get id() { return 'base'; }

  /** @returns {boolean} true when this tab should surface the folder browser panel */
  supportsFolderBrowser() { return false; }

  /**
   * React to folder browser selections.
   * @param {{type:'all'|'folder'|'unassigned',path?:string}} _selection
   */
  // eslint-disable-next-line no-unused-vars
  onFolderSelectionChange(_selection) {}

  /**
   * Provide VirtualGridManager options: `createRow`, `onMountItem`, `onUnmountItem`, card sizing, etc.
   * Return null to reuse existing grid.
   * @returns {null|{rowHeight:number,overscan?:number,card?:{width:number,height:number,gap?:number},createRow:function,onMountItem?:function,onUnmountItem?:function}}
   */
  getGridOptions() { return null; }

  /** Called when app renders to allow initial wiring before activation. */
  onInit() {}

  /** Called when this tab becomes active; should prepare data and bind UI. */
  async onActivate() {}

  /** Called when another tab becomes active; should cleanup transient UI. */
  onDeactivate() {}

  /**
   * Apply search over this tab's dataset and update grid.
   * @param {string} query
   */
  applySearch(query) {}

  /** Bind per-tab footer controls (checkboxes/actions). */
  bindFooter() {}

  /** Unbind per-tab footer controls. */
  unbindFooter() {}

  /**
   * Called when thumb size slider changes (if supported by tab).
   * @param {number} width
   */
  onThumbSizeChange(width) {}

  /**
   * Return items count and shown count for footer stats.
   * @returns {{shown:number,total:number}}
   */
  getStats() { return { shown: 0, total: 0 }; }
}
