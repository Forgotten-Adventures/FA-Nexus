const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { forgeIntegration } from '../../core/forge-integration.js';
import { ContentSourcesIndexer } from './content-sources-indexer.js';
import {
  normalizeContentSourcePath,
  contentSourceKey,
  parseContentSourcesSetting,
  serializeContentSourcesSetting
} from './content-sources-service.js';

/**
 * BaseContentSourcesDialog
 * - Generic multi-folder selector with enable/disable, edit, remove, and custom label support
 * - Persists into a settings key under the 'fa-nexus' namespace
 */
export class BaseContentSourcesDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    tag: 'form',
    window: { frame: true, positioned: true, resizable: true, title: 'Folder Selection' },
    position: { width: 630, height: 700 }
  };
  /**
   * @param {object} options
   * @param {string} options.id - application id
   * @param {string} options.title - window title
   * @param {string} options.settingsKey - settings key under 'fa-nexus' namespace
   * @param {string} options.template - handlebars template path
   */
  constructor({ id, title, settingsKey, template, cacheType = null, indexer = null } = {}) {
    super({ id, window: { title: title || 'Folder Selection' } });
    this.folders = [];
    this._handlers = {};
    this._settingsKey = settingsKey;
    this._template = template;
    this._cacheType = cacheType;
    this._cacheDb = null;
    this._indexRunner = typeof indexer === 'function' ? indexer : null;
    this._indexManager = new ContentSourcesIndexer({
      runIndex: this._indexRunner,
      normalizePath: (value) => this._normalizePath(value),
      listeners: [(folder, state) => this._handleIndexStateChange(folder, state)]
    });
    this._initializePromise = null;
    this._initializationError = null;
    this._initialized = false;
    this._renderTimer = null;
    this._pendingScrollTop = null;
    this._lastScrollTop = 0;
    this._cacheEntries = [];
    this._cacheNeedsRefresh = !!cacheType;
    this._cacheFetchPromise = null;
    this._cacheFetchToken = 0;
    this._cloudContext = null;
    this._cloudCacheMeta = this._cloudCacheMeta || { count: 0, folder: 'cloud' };
    this._cloudEnabledSetting = this._cloudEnabledSetting || null;
    this._cloudToggleId = `${this.id}-cloud-toggle`;
    this._cloudInitialEnabled = null;
    this._cloudPendingEnabled = null;
    // Ensure template PARTS are set before first render
    BaseContentSourcesDialog.setupTemplateOn(this);
    this._beginInitialization();
  }

  static PARTS = {
    form: { template: null }
  };

  /** Resolve template path from constructor */
  static setupTemplateOn(instance) {
    if (!instance || !instance._template) return;
    const parts = Object.assign({}, BaseContentSourcesDialog.PARTS);
    parts.form = { template: instance._template };
    instance.constructor.PARTS = parts;
  }

  _beginInitialization() {
    this._initializationError = null;
    this._initialized = false;
    this._initializePromise = this.initialize()
      .then(() => {
        this._initialized = true;
        return true;
      })
      .catch((error) => {
        this._initializationError = error;
        this._initialized = false;
        throw error;
      });
  }

  async _ensureInitialized() {
    if (this._initialized) return true;
    if (this._initializationError) throw this._initializationError;
    if (!this._initializePromise) this._beginInitialization();
    return this._initializePromise;
  }

  async initialize() {
    if (!this._settingsKey) {
      this.folders = [];
      return;
    }
    try {
      const raw = game.settings.get('fa-nexus', this._settingsKey);
      this.folders = parseContentSourcesSetting(raw, { normalizePath: (value) => this._normalizePath(value) });
    } catch (error) {
      this.folders = [];
      Logger.error('ContentSources.initialize:failed', { key: this._settingsKey, error });
      if (ui?.notifications?.error) {
        ui.notifications.error('Failed to load content source settings.');
      }
      throw error;
    }
  }

  /** Bind dynamic events after render */
  _onRender(context, options) {
    super._onRender(context, options);
    this._bindEvents();
    this._restoreScrollPosition();
  }

  /** Unbind events on close */
  _onClose(options = {}) {
    this._cancelAllIndexing('close');
    this._clearRenderTimer();
    this._unbindEvents();
    this._cloudPendingEnabled = null;
    this._cloudInitialEnabled = null;
    this._cloudContext = null;
    super._onClose(options);
  }

  /**
   * Provide template context data
   * @returns {Promise<{folders:Array,hasFolders:boolean,enabledCount:number,totalCount:number}>}
   */
  async _prepareContext() {
    await this._ensureInitialized();
    const enabledCount = this.folders.filter(f => f.enabled).length;
    const totalCount = this.folders.length;
    const cacheEntries = await this._getCacheEntries();

    const cacheMap = {};
    let cacheTotalCount = 0;
    for (const entry of cacheEntries) {
      const folder = entry?.folder;
      if (!folder) continue;
      const count = Number(entry?.count || 0);
      cacheMap[folder] = (cacheMap[folder] || 0) + count;
      cacheTotalCount += count;
    }

    const normalizedFolders = new Set(this.folders.map((folder) => this._normalizePath(folder.path)));

    const orphanCaches = [];
    if (this._cacheType) {
      for (const entry of cacheEntries) {
        const folder = entry?.folder;
        if (!folder) continue;
        const normalized = this._normalizePath(folder);
        if (!normalizedFolders.has(normalized)) orphanCaches.push(entry);
      }
    }

    const folders = this.folders.map((folder) => {
      const cacheCount = cacheMap[folder.path] || 0;
      const rawState = this._indexManager.getState(folder.path) || null;
      const indexState = this._buildIndexState(folder.path, rawState);
      return Object.assign({}, folder, {
        cacheCount,
        hasCache: cacheCount > 0,
        indexState,
        isIndexing: !!indexState?.isRunning,
        folderKey: this._folderKey(folder.path)
      });
    });

    const runningIndexes = this._indexManager.getStates().filter((state) => state?.status === 'running').length;
    const cloud = await this._buildCloudContext();

    return {
      cloud,
      hasCloud: !!cloud,
      folders,
      hasFolders: totalCount > 0,
      enabledCount,
      totalCount,
      cacheType: this._cacheType,
      hasAnyCache: cacheEntries.length > 0,
      cacheFolderCount: cacheEntries.length,
      cacheTotalCount,
      orphanCaches,
      orphanCacheCount: orphanCaches.length,
      hasOrphanCaches: orphanCaches.length > 0,
      canIndex: !!this._indexRunner,
      runningIndexCount: runningIndexes,
      hasRunningIndex: runningIndexes > 0
    };
  }

  /** Attach DOM event listeners for UI widgets */
  _bindEvents() {
    const root = this.element; if (!root) return;
    this._handlers = { checkboxes: [], labels: [], removes: [], edits: [], clears: [], orphanClears: [], indexes: [], cloudToggle: null, cloudClear: null };

    const addBtn = root.querySelector('#fa-nexus-add-folder-btn');
    if (addBtn) {
      this._handlers.add = () => this._addFolder();
      addBtn.addEventListener('click', this._handlers.add);
    }

    root.querySelectorAll('.fa-nexus-folder-checkbox').forEach((cb, idx) => {
      const onCheckboxChange = (ev) => {
        const target = ev.currentTarget || ev.target;
        const i = Number(target?.dataset?.index);
        this._toggleEnabled(i, target?.checked);
      };
      this._handlers.checkboxes[idx] = onCheckboxChange;
      cb.addEventListener('change', onCheckboxChange);
    });

    root.querySelectorAll('.fa-nexus-folder-label').forEach((label, idx) => {
      const onLabelClick = (ev) => {
        const target = ev.currentTarget || ev.target;
        const i = Number(target?.dataset?.index);
        this._editLabel(i);
      };
      this._handlers.labels[idx] = onLabelClick;
      label.addEventListener('click', onLabelClick);
    });

    root.querySelectorAll('.fa-nexus-remove-folder-btn').forEach((btn, idx) => {
      const onRemoveClick = async (ev) => {
        const target = ev.currentTarget || ev.target;
        const i = Number(target?.dataset?.index);
        await this._removeFolder(i);
      };
      this._handlers.removes[idx] = onRemoveClick;
      btn.addEventListener('click', onRemoveClick);
    });

    root.querySelectorAll('.fa-nexus-edit-folder-btn').forEach((btn, idx) => {
      const onEditClick = async (ev) => {
        const target = ev.currentTarget || ev.target;
        const i = Number(target?.dataset?.index);
        await this._editFolder(i);
      };
      this._handlers.edits[idx] = onEditClick;
      btn.addEventListener('click', onEditClick);
    });

    if (this._indexRunner) {
      root.querySelectorAll('.fa-nexus-index-folder-btn').forEach((btn, idx) => {
        const onIndexButtonClick = async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const el = ev.currentTarget || btn;
          const folder = el?.dataset?.folder || ev.target?.dataset?.folder;
          if (!folder) return;
          const action = (el?.dataset?.action || 'start').toLowerCase();
          if (action === 'cancel') await this._handleCancelIndex(folder, el);
          else await this._handleIndexFolder(folder, el);
        };
        this._handlers.indexes[idx] = onIndexButtonClick;
        btn.addEventListener('click', onIndexButtonClick);
      });
    }

    if (this._cacheType) {
      root.querySelectorAll('.fa-nexus-clear-cache-btn').forEach((btn, idx) => {
        const onClearCacheClick = async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const folder = ev.currentTarget?.dataset?.folder || ev.target?.dataset?.folder;
          if (!folder) return;
          await this._handleClearCache(folder, ev.currentTarget || btn);
        };
        this._handlers.clears[idx] = onClearCacheClick;
        btn.addEventListener('click', onClearCacheClick);
      });
      const clearAll = root.querySelector('#fa-nexus-clear-all-cache-btn');
      if (clearAll) {
        this._handlers.clearAll = async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          await this._handleClearAllCaches(clearAll);
        };
        clearAll.addEventListener('click', this._handlers.clearAll);
      }
      const clearOrphan = root.querySelector('#fa-nexus-clear-orphan-cache-btn');
      if (clearOrphan) {
        this._handlers.clearOrphan = async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          await this._handleClearOrphanCaches(clearOrphan);
        };
        clearOrphan.addEventListener('click', this._handlers.clearOrphan);
      }
      root.querySelectorAll('[data-action="clear-orphan-cache"]').forEach((btn, idx) => {
        const onClearOrphanClick = async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const folder = ev.currentTarget?.dataset?.folder || ev.target?.dataset?.folder;
          if (!folder) return;
          await this._handleClearCache(folder, ev.currentTarget || btn);
        };
        this._handlers.orphanClears[idx] = onClearOrphanClick;
        btn.addEventListener('click', onClearOrphanClick);
      });
    }

    const cloudCtx = this._cloudContext;
    if (cloudCtx?.toggleId && this._getCloudConfig()) {
      const cloudToggle = root.querySelector(`#${cloudCtx.toggleId}`);
      if (cloudToggle) {
        this._handlers.cloudToggle = async (ev) => {
          ev.preventDefault();
          await this._toggleCloudEnabled(ev.currentTarget || cloudToggle);
        };
        cloudToggle.addEventListener('change', this._handlers.cloudToggle);
      }
    }

    if (cloudCtx && this._getCloudConfig()) {
      const clearBtn = root.querySelector('.fa-nexus-cloud-clear-btn');
      if (clearBtn) {
        this._handlers.cloudClear = async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          await this._handleClearCloudIndexes(ev.currentTarget || clearBtn);
        };
        clearBtn.addEventListener('click', this._handlers.cloudClear);
      }
    }

    const saveBtn = root.querySelector('#fa-nexus-save-folders-btn');
    if (saveBtn) {
      this._handlers.save = () => this._save();
      saveBtn.addEventListener('click', this._handlers.save);
    }
    const cancelBtn = root.querySelector('#fa-nexus-cancel-folders-btn');
    if (cancelBtn) {
      this._handlers.cancel = () => this.close();
      cancelBtn.addEventListener('click', this._handlers.cancel);
    }
  }

  /** Detach DOM event listeners */
  _unbindEvents() {
    const root = this.element; if (!root) return;
    try { root.querySelector('#fa-nexus-add-folder-btn')?.removeEventListener('click', this._handlers.add); } catch(_) {}
    try { root.querySelector('#fa-nexus-save-folders-btn')?.removeEventListener('click', this._handlers.save); } catch(_) {}
    try { root.querySelector('#fa-nexus-cancel-folders-btn')?.removeEventListener('click', this._handlers.cancel); } catch(_) {}
    root.querySelectorAll('.fa-nexus-folder-checkbox').forEach((cb, idx) => { try { cb.removeEventListener('change', this._handlers.checkboxes?.[idx]); } catch(_) {} });
    root.querySelectorAll('.fa-nexus-folder-label').forEach((el, idx) => { try { el.removeEventListener('click', this._handlers.labels?.[idx]); } catch(_) {} });
    root.querySelectorAll('.fa-nexus-remove-folder-btn').forEach((el, idx) => { try { el.removeEventListener('click', this._handlers.removes?.[idx]); } catch(_) {} });
    root.querySelectorAll('.fa-nexus-edit-folder-btn').forEach((el, idx) => { try { el.removeEventListener('click', this._handlers.edits?.[idx]); } catch(_) {} });
    if (this._cacheType) {
      root.querySelectorAll('.fa-nexus-clear-cache-btn').forEach((el, idx) => { try { el.removeEventListener('click', this._handlers.clears?.[idx]); } catch(_) {} });
      try { root.querySelector('#fa-nexus-clear-all-cache-btn')?.removeEventListener('click', this._handlers.clearAll); } catch(_) {}
      try { root.querySelector('#fa-nexus-clear-orphan-cache-btn')?.removeEventListener('click', this._handlers.clearOrphan); } catch(_) {}
      root.querySelectorAll('[data-action="clear-orphan-cache"]').forEach((el, idx) => { try { el.removeEventListener('click', this._handlers.orphanClears?.[idx]); } catch(_) {} });
    }
    if (this._indexRunner) {
      root.querySelectorAll('.fa-nexus-index-folder-btn').forEach((el, idx) => { try { el.removeEventListener('click', this._handlers.indexes?.[idx]); } catch(_) {} });
    }
    if (this._handlers.cloudToggle && this._cloudContext?.toggleId) {
      try { root.querySelector(`#${this._cloudContext.toggleId}`)?.removeEventListener('change', this._handlers.cloudToggle); } catch(_) {}
    }
    if (this._handlers.cloudClear) {
      try { root.querySelector('.fa-nexus-cloud-clear-btn')?.removeEventListener('click', this._handlers.cloudClear); } catch(_) {}
    }
    this._clearRenderTimer();
    this._handlers = {};
  }

  _captureScrollPosition() {
    try {
      const list = this.element?.querySelector('.fa-nexus-folder-items');
      if (!list) return;
      const current = list.scrollTop;
      this._lastScrollTop = current;
      if (this._pendingScrollTop == null) this._pendingScrollTop = current;
    } catch (_) {}
  }

  _clearRenderTimer() {
    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
  }

  _restoreScrollPosition() {
    const target = this._pendingScrollTop != null ? this._pendingScrollTop : this._lastScrollTop;
    if (target == null) return;
    try {
      const list = this.element?.querySelector('.fa-nexus-folder-items');
      if (list) list.scrollTop = target;
    } catch (_) {}
    this._pendingScrollTop = null;
  }

  _requestRender({ preserveScroll = false, immediate = false } = {}) {
    if (preserveScroll) this._captureScrollPosition();
    if (immediate) {
      this._clearRenderTimer();
      this.render();
      return;
    }
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this.render();
    }, 80);
  }

  _normalizePath(path) {
    return normalizeContentSourcePath(path);
  }

  _folderKey(path) {
    return contentSourceKey(path);
  }

  _pathsEqual(a, b) {
    return this._normalizePath(a) === this._normalizePath(b);
  }

  _isDuplicatePath(path, ignoreIndex = -1) {
    return this.folders.some((folder, idx) => idx !== ignoreIndex && this._pathsEqual(folder.path, path));
  }

  /** Ensure cache database instance is available */
  async _ensureCacheDb() {
    if (!this._cacheType) return null;
    if (!this._cacheDb) {
      try {
        const { NexusIndexDB } = await import('../cache-index.js');
        this._cacheDb = new NexusIndexDB('fa-nexus-index');
      } catch (error) {
        Logger.error('Folders.cache:db-failed', error);
        if (ui?.notifications?.error) ui.notifications.error('Unable to access cached indexes.');
        return null;
      }
    }
    return this._cacheDb;
  }

  /** Retrieve cached index metadata for current type */
  async _getCacheEntries() {
    if (!this._cacheType) return [];
    if (!this._cacheNeedsRefresh && Array.isArray(this._cacheEntries)) return this._cacheEntries;
    if (!this._cacheFetchPromise) {
      const token = ++this._cacheFetchToken;
      this._cacheFetchPromise = this._fetchCacheEntries()
        .then((entries) => {
          if (token === this._cacheFetchToken) {
            this._cacheEntries = entries;
            this._cacheNeedsRefresh = false;
          }
          return entries;
        })
        .catch((error) => {
          Logger.error('Folders.cache:fetch-failed', error);
          return [];
        })
        .finally(() => {
          if (this._cacheFetchToken === token) {
            this._cacheFetchPromise = null;
          }
        });
    }
    return this._cacheFetchPromise;
  }

  async _fetchCacheEntries() {
    try {
      const db = await this._ensureCacheDb();
      if (!db) return [];
      const entries = await db.list(this._cacheType);
      return Array.isArray(entries) ? entries : [];
    } catch (error) {
      Logger.error('Folders.cache:list-failed', error);
      return [];
    }
  }

  async _handleClearCache(folder, button = null, { showNotification = true, refresh = true } = {}) {
    const db = await this._ensureCacheDb();
    if (!db || !folder) return false;
    const original = button?.innerHTML;
    if (button) {
      button.disabled = true;
      button.setAttribute('data-loading', 'true');
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    if (refresh) this._captureScrollPosition();
    try {
      const cleared = await db.clear(this._cacheType, folder);
      if (cleared) {
        this._markCacheDirty();
        if (showNotification && ui?.notifications?.info) ui.notifications.info(`Cleared cached index for ${folder}`);
      } else {
        if (showNotification && ui?.notifications?.warn) ui.notifications.warn(`No cached index found for ${folder}`);
      }
      return cleared;
    } catch (error) {
      Logger.error('Folders.cache:clear-failed', { folder, error });
      if (showNotification && ui?.notifications?.error) ui.notifications.error('Failed to clear cached index.');
      return false;
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute('data-loading');
        if (original) button.innerHTML = original;
      }
      if (refresh) this._requestRender({ preserveScroll: true, immediate: true });
    }
  }

  async _handleClearAllCaches(button) {
    const db = await this._ensureCacheDb();
    if (!db) return;
    const original = button?.innerHTML;
    if (button) {
      button.disabled = true;
      button.setAttribute('data-loading', 'true');
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    this._captureScrollPosition();
    try {
      await db.clearAll(this._cacheType);
      this._markCacheDirty();
      if (ui?.notifications?.info) ui.notifications.info(`Cleared all cached ${this._cacheType} indexes.`);
    } catch (error) {
      Logger.error('Folders.cache:clear-all-failed', error);
      if (ui?.notifications?.error) ui.notifications.error('Failed to clear cached indexes.');
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute('data-loading');
        if (original) button.innerHTML = original;
      }
      this._requestRender({ preserveScroll: true, immediate: true });
    }
  }

  async _handleClearOrphanCaches(button) {
    const db = await this._ensureCacheDb();
    if (!db || !this._cacheType) return;
    const original = button?.innerHTML;
    if (button) {
      button.disabled = true;
      button.setAttribute('data-loading', 'true');
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    this._captureScrollPosition();
    try {
      const entries = await db.list(this._cacheType);
      const known = new Set(this.folders.map((f) => this._normalizePath(f.path)));
      for (const entry of entries) {
        if (!entry?.folder) continue;
        if (known.has(this._normalizePath(entry.folder))) continue;
        await db.clear(this._cacheType, entry.folder);
      }
      this._markCacheDirty();
      if (ui?.notifications?.info) ui.notifications.info('Cleared cached indexes for folders no longer tracked.');
    } catch (error) {
      Logger.error('Folders.cache:clear-orphan-failed', error);
      if (ui?.notifications?.error) ui.notifications.error('Failed to clear unlisted cached indexes.');
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute('data-loading');
        if (original) button.innerHTML = original;
      }
      this._requestRender({ preserveScroll: true, immediate: true });
    }
  }

  async _handleIndexFolder(folder, button) {
    if (!this._indexRunner || !this._indexManager || !folder) return;
    if (button) button.disabled = true;
    this._captureScrollPosition();
    try {
      const state = await this._indexManager.start(folder, { onBeforeStart: () => this._captureScrollPosition() });
      if (state?.status === 'done') {
        const count = Number.isFinite(state.count) ? Number(state.count) : 0;
        this._markCacheDirty();
        this._requestRender({ immediate: true, preserveScroll: true });
        if (ui?.notifications?.info) ui.notifications.info(`Indexed ${count} item(s) for ${folder}`);
      } else if (state?.status === 'cancelled') {
        this._requestRender({ immediate: true, preserveScroll: true });
      }
    } catch (error) {
      const cause = error?.cause || error;
      if (cause?.name !== 'AbortError') {
        Logger.error('ContentSources.index:failed', { folder, error: cause });
        if (ui?.notifications?.error) ui.notifications.error(`Failed to index folder: ${folder}`);
      }
      this._requestRender({ immediate: true, preserveScroll: true });
    } finally {
      if (button && button.isConnected) button.disabled = false;
    }
  }

  async _handleCancelIndex(folder, button) {
    if (!this._indexManager || !folder) return;
    if (button) button.disabled = true;
    this._indexManager.cancel(folder, 'user-cancelled');
  }

  _handleIndexStateChange(folder, state) {
    this._renderIndexState(folder, state);
  }

  _buildIndexState(folder, state) {
    if (!state) return { folder, status: 'idle', count: 0, isRunning: false, icon: '', text: '', css: '', expireAt: null };
    const status = state.status || 'idle';
    const count = Number.isFinite(state.count) ? Number(state.count) : 0;
    const expireAt = state.expireAt || null;
    if (expireAt && Date.now() > expireAt && status !== 'running') {
      return { folder, status: 'idle', count, isRunning: false, icon: '', text: '', css: '', expireAt: null };
    }
    const info = { ...state, folder, status, count, isRunning: status === 'running', expireAt };
    let icon = '';
    let text = '';
    let css = '';
    if (status === 'running') {
      icon = 'fa-spinner fa-spin';
      text = `Indexing… ${count}`;
      css = 'is-running';
    } else if (status === 'done') {
      icon = 'fa-check';
      text = count ? `Indexed ${count} item(s)` : 'Index updated';
      css = 'is-done';
    } else if (status === 'error') {
      icon = 'fa-exclamation-triangle';
      text = state.error || 'Index failed';
      css = 'is-error';
    } else if (status === 'cancelled') {
      icon = 'fa-ban';
      text = 'Index cancelled';
      css = 'is-cancelled';
    } else if (count) {
      icon = 'fa-check';
      text = `Last indexed ${count} item(s)`;
      css = 'is-complete';
    }
    return Object.assign(info, { icon, text, css, expireAt });
  }

  _cancelAllIndexing(reason = 'cancelled') {
    if (!this._indexManager) return;
    this._indexManager.cancelAll(reason);
  }

  _cancelIndexFor(folder, reason = 'cancelled') {
    if (!this._indexManager || !folder) return;
    this._indexManager.cancel(folder, reason);
  }

  _findFolderRow(folder) {
    const root = this.element;
    if (!root || !folder) return null;
    const key = this._folderKey(folder);
    if (!key) return null;
    return root.querySelector(`.fa-nexus-folder-item[data-folder-key="${key}"]`);
  }

  _renderIndexState(folder, state = null) {
    if (!folder) return;
    const row = this._findFolderRow(folder);
    if (!row) return;
    const currentState = state ?? this._indexManager?.getState(folder) ?? null;
    const view = this._buildIndexState(folder, currentState);
    const info = row.querySelector('.fa-nexus-folder-info');
    if (!info) return;

    let statusEl = info.querySelector('.fa-nexus-folder-index-status');
    if (!view || !view.text) {
      if (statusEl) statusEl.remove();
    } else {
      if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.className = 'fa-nexus-folder-index-status';
        info.appendChild(statusEl);
      }
      const classes = ['fa-nexus-folder-index-status'];
      if (view.css) classes.push(view.css);
      statusEl.className = classes.join(' ');
      const icon = view.icon || 'fa-info-circle';
      statusEl.innerHTML = `<i class="fas ${icon}"></i> <span>${view.text}</span>`;
    }

    const indexBtn = row.querySelector('.fa-nexus-index-folder-btn');
    if (indexBtn) {
      if (view?.isRunning) {
        indexBtn.disabled = false;
        indexBtn.dataset.action = 'cancel';
        indexBtn.classList.add('is-cancel');
        indexBtn.innerHTML = '<i class="fas fa-ban"></i>';
        indexBtn.title = 'Cancel indexing';
      } else {
        indexBtn.disabled = false;
        indexBtn.dataset.action = 'start';
        indexBtn.classList.remove('is-cancel');
        indexBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';
        indexBtn.title = 'Rebuild index';
      }
    }
  }

  async _buildCloudContext() {
    const config = this._getCloudConfig();
    if (!config) {
      this._cloudContext = null;
      return null;
    }
    const enabledSetting = this._cloudPendingEnabled != null ? this._cloudPendingEnabled : this._getCloudEnabled(config);
    if (this._cloudInitialEnabled === null) this._cloudInitialEnabled = enabledSetting;
    const cacheCount = Number(config.cacheCount ?? this._cloudCacheMeta?.count ?? 0) || 0;
    const cloudId = config.id || 'cloud';
    const rawState = this._indexManager.getState(cloudId) || null;
    const indexState = this._buildIndexState(cloudId, rawState);
    const context = {
      id: cloudId,
      label: config.label || 'Cloud Library',
      description: config.description || '',
      icon: config.icon || 'fa-cloud',
      path: config.path || 'FA Nexus Cloud',
      version: config.version || this._cloudCacheMeta?.latest || null,
      setting: config.setting || this._cloudEnabledSetting,
      toggleId: config.toggleId || this._cloudToggleId,
      folderKey: this._folderKey(cloudId),
      cacheCount,
      hasCache: cacheCount > 0,
      enabled: enabledSetting,
      isCloud: true,
      indexState
    };
    this._cloudContext = context;
    return context;
  }

  _getCloudConfig() {
    return null;
  }

  _getCloudEnabled(config) {
    if (!config?.setting) return true;
    try {
      const value = game.settings.get('fa-nexus', config.setting);
      if (typeof value === 'boolean') return value;
    } catch (_) {}
    return true;
  }

  async _setCloudEnabled(enabled) {
    const config = this._getCloudConfig();
    if (!config?.setting) return;
    await game.settings.set('fa-nexus', config.setting, !!enabled);
  }

  async _toggleCloudEnabled(toggle) {
    const config = this._getCloudConfig();
    if (!config) return;
    const checkbox = toggle;
    const desired = !!checkbox?.checked;
    if (this._cloudContext) this._cloudContext.enabled = desired;
    if (this._cloudInitialEnabled != null && desired === this._cloudInitialEnabled) {
      this._cloudPendingEnabled = null;
    } else {
      this._cloudPendingEnabled = desired;
    }
    this._renderCloudRow();
  }

  _renderCloudRow(context = this._cloudContext) {
    const root = this.element;
    if (!root || !context) return;
    const row = root.querySelector(`.fa-nexus-cloud-row[data-folder-key="${context.folderKey}"]`);
    if (!row) return;
    row.classList.toggle('fa-nexus-folder-disabled', !context.enabled);
    const toggle = row.querySelector(`#${context.toggleId}`);
    if (toggle) toggle.checked = !!context.enabled;
    const cacheWrap = row.querySelector('.fa-nexus-folder-cache');
    if (cacheWrap) {
      cacheWrap.classList.toggle('is-present', context.cacheCount > 0);
      cacheWrap.classList.toggle('is-empty', context.cacheCount <= 0);
      const span = cacheWrap.querySelector('span');
      if (span) span.textContent = `${context.cacheCount} item(s)`;
    }
  }

  async _handleClearCloudIndexes(button) {
    const config = this._getCloudConfig();
    if (!config?.db || !config?.store) return;
    const original = button?.innerHTML;
    if (button) {
      button.disabled = true;
      button.setAttribute('data-loading', 'true');
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    try {
      const { CloudDB } = await import('../cloud-db.js');
      const db = new CloudDB(config.db);
      await db.clear(config.store);
      this._cloudCacheMeta = { ...this._cloudCacheMeta, count: 0, latest: null };
      if (this._cloudContext) {
        this._cloudContext.cacheCount = 0;
        this._cloudContext.hasCache = false;
        this._cloudContext.version = null;
      }
      this._renderCloudRow();
      if (ui?.notifications?.info) ui.notifications.info(`Cleared ${config.label || 'cloud'} index`);
    } catch (error) {
      Logger.error('Folders.cloud.clear:failed', error);
      if (ui?.notifications?.error) ui.notifications.error('Failed to clear cloud index.');
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute('data-loading');
        if (original) button.innerHTML = original;
      }
    }
  }

  _markCacheDirty() {
    if (!this._cacheType) return;
    this._cacheNeedsRefresh = true;
    this._cacheFetchToken += 1;
    this._cacheFetchPromise = null;
  }

  async _prepareForgeFilePicker(filePicker) {
    if (!filePicker) {
      try { Logger.warn('Folders.filePickerInit:missingInstance'); } catch (_) {}
      return { source: null, options: {} };
    }
    try {
      try { Logger.debug('Folders.filePickerInit:start'); } catch (_) {}
      await forgeIntegration.initialize();
      const context = forgeIntegration.getFilePickerContext();
      try {
        const storages = game?.data?.files?.storages;
        Logger.debug?.('Folders.filePickerInit:context', {
          storages,
          context,
          hasForgeStorage: forgeIntegration.hasForgeStorage(),
          detectedBucket: forgeIntegration.detectCurrentForgeBucket?.()
        });
      } catch (_) {}
      if (context?.source === 'forgevtt') {
        const bucketOptions = Object.assign({}, context.options || {});
        try {
          Logger.debug?.('Folders.filePickerInit:forgeContext', {
            bucketOptions,
            existingSources: Object.keys(filePicker.sources || {})
          });
        } catch (_) {}
        filePicker.activeSource = 'forgevtt';
        filePicker.options = Object.assign({}, filePicker.options || {}, bucketOptions);
        if (bucketOptions.bucketKey !== undefined) {
          filePicker.options.bucketKey = bucketOptions.bucketKey;
        }
        filePicker.__faNexusForgeContext = { source: 'forgevtt', options: bucketOptions };
        const handler = (app, html) => {
          if (app !== filePicker) return;
          Hooks.off('renderFilePicker', handler);
          try { app.activeSource = 'forgevtt'; } catch (_) {}
          const root = html && typeof html === 'object' && 'length' in html ? html[0] || null : html;
          if (!root) return;
          const forgeTab = root.querySelector('[data-tab="forgevtt"]');
          if (forgeTab) {
            forgeTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }
          setTimeout(() => {
            try {
              const ctx = app.__faNexusForgeContext;
              if (!ctx || ctx.source !== 'forgevtt') return;
              const select = root.querySelector('select[name="bucket"]');
              const selectValue = ctx.options?.bucketKey ?? (ctx.options?.bucket !== undefined ? String(ctx.options.bucket) : null);
              if (select && selectValue !== null) {
                const value = String(selectValue);
                Logger.debug?.('Folders.filePickerInit:bucketSelect', { selectValue: value });
                if (select.value !== value) {
                  select.value = value;
                  select.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }
            } catch (bucketError) {
              try { Logger.debug('Folders.filePickerForgeBucketFailed', bucketError); } catch (_) {}
            }
          }, 75);
        };
        Hooks.once('renderFilePicker', handler);
      }
      return context;
    } catch (error) {
      try { Logger.debug('Folders.filePickerForgeConfigFailed', error); } catch (_) {}
      return { source: null, options: {} };
    }
  }

  /** Open a FilePicker to add a new folder entry */
  async _addFolder() {
    try { Logger.info('Folders.add:open'); } catch (_) {}
    const FilePickerBase = foundry.applications.apps.FilePicker ?? globalThis.FilePicker;
    const FilePickerClass = FilePickerBase?.implementation ?? FilePickerBase ?? globalThis.FilePicker;
    const fp = new FilePickerClass({
      type: 'folder', title: 'Select Folder',
      callback: (path) => {
        try {
          const src = fp?.activeSource;
          if (src && (src === 'forge-bazaar' || src === 'bazaar') && !/^[^:]+:/.test(path)) {
            const norm = path.startsWith('/') ? path.slice(1) : path;
            path = `${src === 'bazaar' ? 'forge-bazaar' : src}:${norm}`;
          }
        } catch(_) {}
        const label = path.split('/').pop() || path;
        if (this._isDuplicatePath(path)) {
          if (ui?.notifications?.warn) ui.notifications.warn('That folder has already been added.');
          return;
        }
        this.folders.push({ path, label, enabled: true, customLabel: null });
        try { Logger.info('Folders.add:done', { path }); } catch (_) {}
        this._requestRender({ preserveScroll: true });
      }
    });
    const context = await this._prepareForgeFilePicker(fp);
    const fallbackSource = 'data';
    const attempts = [];
    if (context?.source) attempts.push({ source: context.source, options: context.options || {} });
    if (!attempts.length || attempts[0].source !== fallbackSource) {
      attempts.push({ source: fallbackSource, options: {} });
    }
    try { Logger.debug?.('Folders.add:browseAttempts', { attempts, initialSources: Object.keys(fp.sources || {}) }); } catch (_) {}

    for (const attempt of attempts) {
      const { source, options } = attempt;
      if (!source) continue;
      try {
        if (!fp.sources[source]) {
          fp.sources[source] = { target: '' };
        } else if (typeof fp.sources[source] !== 'object') {
          fp.sources[source] = { target: '' };
        }
        const sourceConfig = fp.sources[source];
        sourceConfig.target = sourceConfig.target ?? '';
        if (options && typeof options === 'object') {
          if (options.bucket !== undefined) sourceConfig.bucket = options.bucket;
          if (options.bucketKey !== undefined) sourceConfig.bucketKey = options.bucketKey;
          if (options.buckets !== undefined) sourceConfig.buckets = options.buckets;
        }
        fp.activeSource = source;
        if (options && typeof options === 'object' && Object.keys(options).length) {
          fp.options = Object.assign({}, fp.options || {}, options);
        }
        Logger.debug?.('Folders.add:browseAttempt', { source, options: fp.options, sourceConfig });
        await fp.browse(undefined, Object.assign({}, options));
        return;
      } catch (error) {
        try { Logger.warn('Folders.add:browseFailed', { source, error }); } catch (_) {}
        continue;
      }
    }
    if (ui?.notifications?.warn) ui.notifications.warn('Unable to open file storage; please configure your Forge buckets.');
  }

  /** Toggle enabled state for a folder row */
  _toggleEnabled(index, enabled) {
    if (index >= 0 && index < this.folders.length) {
      this.folders[index].enabled = !!enabled;
      this._requestRender({ preserveScroll: true });
    }
  }

  /** Open a FilePicker to edit an existing folder path */
  async _editFolder(index) {
    const existing = this.folders[index];
    if (!existing) return;
    try { Logger.info('Folders.edit:open', { index, existing }); } catch (_) {}
    const FilePickerBase = foundry.applications.apps.FilePicker ?? globalThis.FilePicker;
    const FilePickerClass = FilePickerBase?.implementation ?? FilePickerBase ?? globalThis.FilePicker;
    const fp = new FilePickerClass({
      type: 'folder', title: 'Select Folder',
      callback: async (path) => {
        try {
          const src = fp?.activeSource;
          if (src && (src === 'forge-bazaar' || src === 'bazaar') && !/^[^:]+:/.test(path)) {
            const norm = path.startsWith('/') ? path.slice(1) : path;
            path = `${src === 'bazaar' ? 'forge-bazaar' : src}:${norm}`;
          }
        } catch(_) {}
        const label = path.split('/').pop() || path;
        if (this._isDuplicatePath(path, index)) {
          if (ui?.notifications?.warn) ui.notifications.warn('That folder has already been added.');
          return;
        }
        const previousPath = existing.path;
        this.folders[index] = { ...existing, path, label };
        try { Logger.info('Folders.edit:done', { index, path }); } catch (_) {}
        if (path !== previousPath) {
          this._cancelIndexFor(previousPath, 'folder-edited');
          if (this._cacheType) {
            await this._handleClearCache(previousPath, null, { showNotification: false, refresh: false });
          }
        }
        this._requestRender({ preserveScroll: true });
      }
    });
    const context = await this._prepareForgeFilePicker(fp);
    const fallbackSource = 'data';
    const attempts = [];
    if (context?.source) attempts.push({ source: context.source, options: context.options || {} });
    if (!attempts.length || attempts[0].source !== fallbackSource) {
      attempts.push({ source: fallbackSource, options: {} });
    }
    try { Logger.debug?.('Folders.edit:browseAttempts', { attempts, initialSources: Object.keys(fp.sources || {}) }); } catch (_) {}

    for (const attempt of attempts) {
      const { source, options } = attempt;
      if (!source) continue;
      try {
        if (!fp.sources[source]) {
          fp.sources[source] = { target: '' };
        } else if (typeof fp.sources[source] !== 'object') {
          fp.sources[source] = { target: '' };
        }
        const sourceConfig = fp.sources[source];
        sourceConfig.target = sourceConfig.target ?? '';
        if (options && typeof options === 'object') {
          if (options.bucket !== undefined) sourceConfig.bucket = options.bucket;
          if (options.bucketKey !== undefined) sourceConfig.bucketKey = options.bucketKey;
          if (options.buckets !== undefined) sourceConfig.buckets = options.buckets;
        }
        fp.activeSource = source;
        if (options && typeof options === 'object' && Object.keys(options).length) {
          fp.options = Object.assign({}, fp.options || {}, options);
        }
        Logger.debug?.('Folders.edit:browseAttempt', { source, options: fp.options, sourceConfig });
        await fp.browse(undefined, Object.assign({}, options));
        return;
      } catch (error) {
        try { Logger.warn('Folders.edit:browseFailed', { source, error }); } catch (_) {}
        continue;
      }
    }
    if (ui?.notifications?.warn) ui.notifications.warn('Unable to open file storage; please configure your Forge buckets.');
  }

  /** Inline-edit the label for a folder */
  _editLabel(index) {
    const folder = this.folders[index];
    if (!folder) return;
    try { Logger.debug('Folders.label:edit', { index, current: folder.customLabel || folder.label }); } catch (_) {}
    const root = this.element;
    const labelEl = root?.querySelector(`[data-index="${index}"].fa-nexus-folder-label`);
    if (!labelEl) return;
    const current = folder.customLabel || folder.label;
    const input = document.createElement('input');
    input.type = 'text'; input.value = current; input.className = 'fa-nexus-folder-label-input';
    labelEl.innerHTML = ''; labelEl.appendChild(input);
    input.focus(); input.select();
    const save = () => {
      const v = (input.value || '').trim();
      folder.customLabel = v || null;
      this._requestRender({ preserveScroll: true });
    };
    const cancel = () => {
      this._requestRender({ preserveScroll: true });
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); save(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', save);
  }

  /** Remove a folder entry by index */
  async _removeFolder(index) {
    if (index >= 0 && index < this.folders.length) {
      const [removed] = this.folders.splice(index, 1);
      try { Logger.info('Folders.remove', { index }); } catch (_) {}
      if (removed?.path) {
        this._cancelIndexFor(removed.path, 'folder-removed');
      }
      if (removed?.path && this._cacheType) {
        await this._handleClearCache(removed.path, null, { showNotification: false, refresh: false });
      }
      this._requestRender({ preserveScroll: true });
    }
  }

  /** Persist current folders to the configured settings key */
  async _save() {
    try {
      await this._ensureInitialized();
      const payload = serializeContentSourcesSetting(this.folders, { normalizePath: (value) => this._normalizePath(value) });
      const tasks = [game.settings.set('fa-nexus', this._settingsKey, payload)];
      const cloudConfig = this._getCloudConfig();
      const pending = this._cloudPendingEnabled;
      if (cloudConfig?.setting) {
        const initial = this._cloudInitialEnabled;
        const desired = (pending != null) ? pending : initial;
        if (desired != null && desired !== initial) {
          tasks.push(this._setCloudEnabled(desired));
        }
      }
      if (tasks.length > 0) await Promise.all(tasks);
      if (cloudConfig?.setting) {
        const desired = (pending != null) ? pending : this._getCloudEnabled(cloudConfig);
        this._cloudInitialEnabled = desired;
        this._cloudPendingEnabled = null;
        if (this._cloudContext) {
          this._cloudContext.enabled = desired;
          this._renderCloudRow();
        }
      }
      try { Logger.info('Folders.save', { key: this._settingsKey, count: this.folders.length }); } catch (_) {}
      ui.notifications.info(`Saved ${this.folders.length} folder(s)`);
      this.close();
    } catch (e) {
      Logger.error('Folders.save:failed', e);
      ui.notifications.error('Failed to save folder configuration');
    }
  }
}
