import { contentReference, referenceKey, emptyCollections, collectionMemberKeys, collectionDescendants } from './collections-model.js';
import { readCollections, writeCollectionChange } from './collections-library.js';
import { CONTENT_KIND_DESCRIPTORS } from './content-kind-descriptors.js';
import { chooseSceneGroupIcon, sceneGroupIconClass } from '../composition/scene-group-icons.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

export const COLLECTION_DRAG_MIME = 'application/x-fa-nexus-collection-items';
const escape = value => foundry.utils.escapeHTML(String(value ?? ''));
const { DialogV2 } = foundry.applications.api;

export class CollectionsController {
  constructor(app) {
    this.app = app;
    this.library = emptyCollections();
    this.state = { mode: 'folders', selectedId: null, includeChildren: true, collapsed: [], ...game.settings.get('fa-nexus', 'collectionBrowser') };
    this.selected = new Map();
    this.refs = new WeakMap();
    this.organizing = false;
    this.keys = null;
    this.roots = Object.fromEntries(Object.entries(CONTENT_KIND_DESCRIPTORS).map(([kind, descriptor]) => [kind,
      [...new Set([game.settings.get('fa-nexus', descriptor.downloadDirSetting), descriptor.downloadDirDefault, descriptor.legacyDownloadDir, descriptor.freeBaseUrl].filter(Boolean))]]));
  }
  get active() { return this.state.mode === 'collections'; }
  get tab() { return this.app._activeTabObj; }
  async initialize() {
    if (!this.ready) {
      this.ready = (this.active ? this.refresh() : Promise.resolve()).catch(error => { this.ready = null; throw error; });
    }
    if (this.hook === undefined) {
      this.hook = Hooks.on('fa-nexus-collections-changed', () => this.run(() => this.refresh()));
      this.socket = message => { if (message?.type === 'collections-changed') this.run(() => this.refresh()); };
      game.socket?.on('module.fa-nexus', this.socket);
    }
    await this.ready;
  }
  async refresh() {
    const request = this.refreshRequest = (this.refreshRequest || 0) + 1;
    const library = await readCollections();
    if (request !== this.refreshRequest) return;
    this.library = library;
    this.rebuildKeys(); this.render();
    if (this.active && this.state.selectedId) this.apply();
  }
  rebuildKeys() {
    this.keys = this.state.selectedId ? collectionMemberKeys(this.library, this.state.selectedId, this.state.includeChildren) : null;
  }
  reference(item, tabId) {
    if (!item || typeof item !== 'object') return null;
    let cached = this.refs.get(item);
    const kind = tabId === 'prefabs' ? 'prefabs' : tabId === 'tokens' ? 'tokens' : 'assets';
    if (!cached || cached.kind !== kind) {
      const ref = contentReference(item, tabId, this.roots);
      cached = { kind, ref, key: ref ? referenceKey(ref) : null };
      this.refs.set(item, cached);
    }
    return cached;
  }
  filter(items, tabId) {
    if (!this.active || !this.keys) return items;
    return items.filter(item => this.keys.has(this.reference(item, tabId)?.key));
  }
  decorate(card, item, tabId) {
    const identity = this.reference(item, tabId);
    card._collectionIdentity = identity?.key ? identity : null;
    card.classList.toggle('fa-nexus-collection-selected', this.organizing && this.selected.has(identity?.key));
    card.draggable = this.organizing && !!identity?.key;
  }
  apply() {
    if (this.tab && this.app._grid) this.tab.applySearch(this.tab.getCurrentSearchValue());
    this.app._searchController?.updateFolderIndicator();
    const search = this.app.element?.querySelector('#fa-nexus-search');
    if (search) {
      const entry = this.library.collections.find(entry => entry.id === this.state.selectedId);
      search.title = this.active && this.state.selectedId ? `Collection: ${entry?.name || 'Unavailable'}` : '';
    }
  }
  async selectScope(mode, selectedId = this.state.selectedId) {
    this.state = { ...this.state, mode, selectedId };
    if (mode === 'folders') { this.organizing = false; this.paintSelection(); }
    this.rebuildKeys();
    await this.persist(); this.render(); this.apply();
  }
  async persist() { await game.settings.set('fa-nexus', 'collectionBrowser', this.state); }
  run(operation) {
    return Promise.resolve().then(operation).catch(error => {
      Logger.error('Collections.action.failed', { error: String(error) });
      ui.notifications.error(error.message || 'Collection action failed.');
    });
  }
  async change(action) {
    this.library = await writeCollectionChange(action, this.library.revision);
    this.refreshRequest = (this.refreshRequest || 0) + 1;
    this.rebuildKeys(); this.render(); this.apply();
  }
  attachWindow(root) {
    if (this.root === root) { this.render(); return; }
    this.windowAbort?.abort(); this.root = root;
    this.windowAbort = new AbortController();
    const options = { signal: this.windowAbort.signal };
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-collection-action]');
      if (!button) return;
      event.preventDefault();
      this.run(() => this.action(button.dataset.collectionAction, button.dataset.collectionId));
    }, options);
    root.addEventListener('change', event => {
      if (event.target.matches('[name="includeCollections"]')) this.run(async () => {
        this.state.includeChildren = event.target.checked; await this.persist(); this.rebuildKeys(); this.apply();
      });
    }, options);
    root.addEventListener('contextmenu', event => {
      const row = event.target.closest('[data-collection-row]');
      if (!row) return;
      event.preventDefault(); event.stopPropagation(); this.run(() => this.showMenu(row, row.dataset.collectionRow));
    }, options);
    root.addEventListener('dragover', event => {
      if (event.target.closest('[data-collection-row]') && Array.from(event.dataTransfer.types).includes(COLLECTION_DRAG_MIME)) {
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
      }
    }, options);
    root.addEventListener('drop', event => {
      const row = event.target.closest('[data-collection-row]');
      const raw = event.dataTransfer.getData(COLLECTION_DRAG_MIME);
      if (!row || !raw) return;
      event.preventDefault(); event.stopPropagation();
      this.run(async () => { const members = JSON.parse(raw); await this.change({ type: 'add', id: row.dataset.collectionRow, members }); });
    }, options);
    this.render();
    this.run(() => this.refresh());
  }
  render() {
    if (!this.root?.isConnected) return;
    const folders = this.root.querySelector('.fa-nexus-folder-browser');
    const shortcuts = this.root.querySelector('.fa-nexus-folder-shortcuts');
    if (folders) folders.style.display = this.active ? 'none' : '';
    if (shortcuts) shortcuts.hidden = this.active;
    for (const button of this.root.querySelectorAll('[data-collection-action="folders"],[data-collection-action="collections"]')) {
      button.classList.toggle('active', button.dataset.collectionAction === this.state.mode);
      button.setAttribute('aria-pressed', String(button.dataset.collectionAction === this.state.mode));
    }
    const pane = this.root.querySelector('.fa-nexus-collections-browser');
    if (!pane) return;
    pane.hidden = !this.active;
    const branch = (parentId, depth = 0) => this.library.collections.filter(entry => entry.parentId === parentId).map(entry => {
      const closed = this.state.collapsed.includes(entry.id);
      return `<div class="fa-nexus-collection-row ${entry.id === this.state.selectedId ? 'selected' : ''}" data-collection-row="${entry.id}" style="--collection-depth:${depth}">
        <button type="button" data-collection-action="disclose" data-collection-id="${entry.id}" aria-label="${closed ? 'Expand' : 'Collapse'} ${escape(entry.name)}"><i class="fa-solid fa-chevron-${closed ? 'right' : 'down'}"></i></button>
        <button type="button" data-collection-action="select" data-collection-id="${entry.id}"><i class="${sceneGroupIconClass(entry.icon, 'fa-folder')}" style="color:${entry.color}"></i> <span>${escape(entry.name)}</span></button>
      </div>${closed ? '' : branch(entry.id, depth + 1)}`;
    }).join('');
    pane.innerHTML = `<div class="fa-nexus-collection-toolbar"><button type="button" data-collection-action="create"><i class="fa-solid fa-folder-plus"></i> New</button>
      <button type="button" data-collection-action="organize" class="${this.organizing ? 'active' : ''}">${this.organizing ? 'Done Selecting' : 'Select Items'}</button></div>
      <label class="fa-nexus-collection-include"><input type="checkbox" name="includeCollections" ${this.state.includeChildren ? 'checked' : ''}> Include subcollections</label>
      <button type="button" data-collection-action="all" class="fa-nexus-collection-all ${!this.state.selectedId ? 'active' : ''}">All items</button>
      ${this.state.selectedId && !this.library.collections.some(entry => entry.id === this.state.selectedId) ? '<p>Selected Collection is unavailable.</p>' : ''}
      <div class="fa-nexus-collection-tree">${branch(null) || '<p>Create a Collection to organize your content.</p>'}</div>
      ${this.organizing ? `<div class="fa-nexus-collection-selection"><span>${this.selected.size} selected</span><button type="button" data-collection-action="add" ${!this.selected.size ? 'disabled' : ''}>Add to Collection…</button><button type="button" data-collection-action="clear">Clear</button><small>Click to select · Ctrl to add · Shift for a range<br>Drag selected items onto a Collection.</small></div>` : ''}`;
    if (!game.user.isGM) for (const button of pane.querySelectorAll('[data-collection-action="create"],[data-collection-action="organize"]')) button.disabled = true;
  }
  async action(type, id) {
    if (type === 'folders' || type === 'collections') return this.selectScope(type);
    if (type === 'select' || type === 'all') return this.selectScope('collections', type === 'all' ? null : id);
    if (type === 'disclose') {
      this.state.collapsed = this.state.collapsed.includes(id) ? this.state.collapsed.filter(value => value !== id) : [...this.state.collapsed, id];
      await this.persist(); this.render(); return;
    }
    if (type === 'organize') { this.organizing = !this.organizing; this.app._activeTabObj?._preview?.hidePreview(); this.paintSelection(); this.render(); return; }
    if (type === 'clear') { this.selected.clear(); this.paintSelection(); this.render(); return; }
    if (type === 'add') return this.addSelected();
    if (type === 'create') return this.create(id || null);
  }
  async create(parentId = null) {
    const name = await DialogV2.prompt({ window: { title: 'New Collection' }, content: '<label>Name <input name="collectionName" required></label>',
      ok: { label: 'Create', callback: (_event, _button, dialog) => dialog.element.querySelector('input').value.trim() }, rejectClose: false });
    if (typeof name !== 'string' || !name) return;
    const id = foundry.utils.randomID();
    await this.change({ type: 'create', id, parentId, name });
    return id;
  }
  showMenu(row, id, event) {
    const entry = this.library.collections.find(entry => entry.id === id);
    if (!entry || !game.user.isGM) return;
    this.menu?.close({ animate: false });
    const items = [
      { label: 'New Subcollection', icon: 'fa-solid fa-folder-plus', onClick: () => this.run(() => this.create(id)) },
      { label: 'Rename', icon: 'fa-solid fa-i-cursor', onClick: () => this.run(async () => {
        const name = await DialogV2.prompt({ window: { title: 'Rename Collection' }, content: `<input name="collectionName" value="${escape(entry.name)}" required>`, ok: { callback: (_e, _b, d) => d.element.querySelector('input').value.trim() }, rejectClose: false });
        if (typeof name === 'string' && name) await this.change({ type: 'edit', id, name });
      }) },
      { label: 'Icon & Color…', icon: 'fa-solid fa-icons', onClick: () => this.run(async () => {
        const choice = await chooseSceneGroupIcon(entry.icon, { color: entry.color, inheritedColor: '#e9cb68', title: 'Collection Icon & Color', defaultIcon: 'fa-folder', inherit: false });
        if (choice) await this.change({ type: 'edit', id, icon: choice.icon || 'fa-solid fa-folder', color: choice.iconColor || '#e9cb68' });
      }) },
      { label: 'Move to…', icon: 'fa-solid fa-folder-tree', onClick: () => this.run(async () => {
        const parentId = await this.chooseCollection({ title: 'Move Collection', exclude: collectionDescendants(this.library, id), allowRoot: true });
        if (parentId !== false) await this.change({ type: 'edit', id, parentId });
      }) },
      { label: 'Delete Collection', icon: 'fa-solid fa-trash', onClick: () => this.run(async () => {
        if (await DialogV2.confirm({ window: { title: 'Delete Collection' }, content: `<p>Delete ${escape(entry.name)} and its subcollections? The items themselves remain.</p>`, rejectClose: false })) await this.change({ type: 'delete', id });
      }) }
    ];
    this.menu = new foundry.applications.ux.ContextMenu(row, '[data-collection-row]', items, { jQuery: false, fixed: true, eventName: 'nexus-collection-context' });
    return this.menu.render(row);
  }
  async chooseCollection({ title = 'Add to Collection', exclude = new Set(), allowRoot = false } = {}) {
    const entries = this.library.collections.filter(entry => !exclude.has(entry.id));
    if (!entries.length && !allowRoot) return (await this.create()) || false;
    return DialogV2.wait({ window: { title }, content: `<select name="collectionTarget">${allowRoot ? '<option value="">Top level</option>' : ''}${entries.map(entry => `<option value="${entry.id}" ${entry.id === this.state.selectedId ? 'selected' : ''}>${escape(this.fullName(entry))}</option>`).join('')}</select>`,
      buttons: [{ action: 'accept', label: allowRoot ? 'Move' : 'Add', default: true, callback: (_e, _b, d) => d.element.querySelector('select').value || null }, { action: 'cancel', label: 'Cancel', callback: () => false }], rejectClose: false });
  }
  fullName(entry) {
    const names = [entry.name];
    for (let parent = entry.parentId; parent;) { const p = this.library.collections.find(value => value.id === parent); names.unshift(p.name); parent = p.parentId; }
    return names.join(' / ');
  }
  async addSelected(members = [...this.selected.values()]) {
    if (!members.length) return;
    // Card context actions are available before the Content Browser is opened.
    await this.refresh();
    const id = await this.chooseCollection();
    if (id) await this.change({ type: 'add', id, members });
  }
  bindGrid() {
    this.gridAbort?.abort();
    this.gridAbort = new AbortController();
    const root = this.app.element, options = { capture: true, signal: this.gridAbort.signal };
    const cardAt = event => event.target.closest?.('.fa-nexus-card');
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'dblclick']) root.addEventListener(type, event => {
      if (this.organizing && cardAt(event)) event.stopImmediatePropagation();
    }, options);
    root.addEventListener('click', event => {
      const card = cardAt(event);
      if (!this.organizing || !card) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const value = card._collectionIdentity;
      if (!value) return;
      if (event.shiftKey && this.anchor) {
        const entries = (this.app._grid?.items || []).map(item => this.reference(item, this.tab.id)).filter(item => item?.key);
        const from = entries.findIndex(entry => entry.key === this.anchor), to = entries.findIndex(entry => entry.key === value.key);
        if (from >= 0 && to >= 0) for (const entry of entries.slice(Math.min(from, to), Math.max(from, to) + 1)) this.selected.set(entry.key, entry.ref);
      } else if (event.ctrlKey || event.metaKey) {
        if (this.selected.has(value.key)) this.selected.delete(value.key); else this.selected.set(value.key, value.ref);
      } else { this.selected.clear(); this.selected.set(value.key, value.ref); }
      this.anchor = value.key; this.paintSelection(); this.render();
    }, options);
    root.addEventListener('keydown', event => {
      if (!this.organizing || !cardAt(event) || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation(); cardAt(event).click();
    }, options);
    root.addEventListener('dragstart', event => {
      const identity = cardAt(event)?._collectionIdentity;
      if (!this.organizing || !identity) return;
      event.stopImmediatePropagation();
      const members = this.selected.has(identity.key) ? [...this.selected.values()] : [identity.ref];
      event.dataTransfer.setData(COLLECTION_DRAG_MIME, JSON.stringify(members)); event.dataTransfer.effectAllowed = 'copy';
    }, options);
    root.addEventListener('contextmenu', event => {
      const card = cardAt(event), identity = card?._collectionIdentity;
      if (!this.organizing || !identity) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const members = this.selected.has(identity.key) ? [...this.selected.values()] : [identity.ref];
      const items = [{ label: 'Add to Collection…', icon: 'fa-solid fa-folder-plus', onClick: () => this.run(() => this.addSelected(members)) }];
      if (this.state.selectedId) items.push({ label: this.state.includeChildren ? 'Remove from this Collection and subcollections' : 'Remove from this Collection', icon: 'fa-solid fa-folder-minus', onClick: () => this.run(() => this.change({ type: 'remove', id: this.state.selectedId, includeChildren: this.state.includeChildren, members })) });
      this.menu?.close({ animate: false });
      this.menu = new foundry.applications.ux.ContextMenu(card, '.fa-nexus-card', items, { jQuery: false, fixed: true, eventName: 'nexus-collection-context' });
      this.run(() => this.menu.render(card));
    }, options);
  }
  paintSelection() {
    for (const card of this.app.element?.querySelectorAll('.fa-nexus-card') || []) {
      card.classList.toggle('fa-nexus-collection-selected', this.organizing && this.selected.has(card._collectionIdentity?.key)); card.draggable = this.organizing && !!card._collectionIdentity;
    }
  }
  destroy() {
    this.windowAbort?.abort(); this.gridAbort?.abort(); this.menu?.close({ animate: false });
    if (this.hook !== undefined) Hooks.off('fa-nexus-collections-changed', this.hook);
    if (this.socket) game.socket?.off('module.fa-nexus', this.socket);
    this.hook = undefined; this.socket = null; this.refreshRequest = (this.refreshRequest || 0) + 1;
    this.ready = null; this.root = null; this.organizing = false; this.selected.clear();
  }
}
