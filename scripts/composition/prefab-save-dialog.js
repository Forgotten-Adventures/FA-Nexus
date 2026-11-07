const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PrefabSaveDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    // A modal <dialog>, as Foundry's DialogV2 opens one: in the top layer it stays in front of the Nexus window, which
    // a drop onto the Prefabs tab or a click in it could otherwise raise over the Save button.
    id: 'fa-nexus-prefab-save', tag: 'dialog',
    window: { title: 'Save as Prefab', resizable: true },
    position: { width: 440, height: 'auto' },
    actions: { accept: PrefabSaveDialog.accept, cancel: PrefabSaveDialog.cancel }
  };
  static PARTS = { body: { template: 'modules/fa-nexus/templates/composition/prefab-save.hbs' } };

  static async choose({ name, entries, suggestedId = null }) {
    const dialog = new this();
    dialog.entries = entries;
    dialog.defaultName = name;
    dialog.selectedId = entries.some(entry => entry.id === suggestedId) ? suggestedId : null;
    const result = new Promise(resolve => { dialog.resolveChoice = resolve; });
    await dialog.render({ force: true });
    return result;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    if (!this.element.open) this.element.showModal();
  }

  _prepareContext() {
    return { name: this.defaultName, entries: this.entries.map(entry => ({ ...entry,
      url: `${foundry.utils.getRoute(entry.thumbnail)}?v=${entry.hash}`, selected: entry.id === this.selectedId })) };
  }

  _onRender(initial, context) {
    super._onRender(initial, context);
    this.element.addEventListener('change', () => this.sync());
    this.element.querySelector('[name="targetSearch"]').addEventListener('input', event => {
      const query = event.target.value.trim().toLocaleLowerCase();
      for (const row of this.element.querySelectorAll('[data-prefab-target]')) row.hidden = !row.dataset.name.toLocaleLowerCase().includes(query);
    });
    this.sync();
  }

  sync() {
    const replacing = this.element.querySelector('[name="saveMode"]:checked').value === 'replace';
    this.element.querySelector('[data-new-prefab]').hidden = replacing;
    this.element.querySelector('[data-replace-prefab]').hidden = !replacing;
    const accept = this.element.querySelector('[data-action="accept"]');
    accept.textContent = replacing ? 'Replace' : 'Save';
    accept.disabled = replacing && !this.element.querySelector('[name="prefabTarget"]:checked');
  }

  static async accept() {
    const replacing = this.element.querySelector('[name="saveMode"]:checked').value === 'replace';
    const id = replacing ? this.element.querySelector('[name="prefabTarget"]:checked')?.value : null;
    const target = this.entries.find(entry => entry.id === id);
    const input = this.element.querySelector('[name="prefabName"]');
    if (!replacing && !input.value.trim()) { input.reportValidity(); return; }
    if (replacing && !target) return;
    // Two Prefabs of one name cannot be told apart in the library. Ask before a second one is saved.
    const name = input.value.trim();
    if (!replacing && this.entries.some(entry => String(entry.name || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      const second = await foundry.applications.api.DialogV2.confirm({
        window: { title: 'Prefab Name In Use' },
        content: `<p>A Prefab named <strong>${foundry.utils.escapeHTML(name)}</strong> is already in the library.</p><p>Save a second one under the same name? To update the one that is there, answer No and choose "Replace Existing".</p>`,
        // Modal, so that it opens above this modal dialog.
        modal: true,
        rejectClose: false
      });
      if (second !== true) return;
    }
    this.resolveChoice({ id, name: replacing ? target.name : input.value.trim(), expectedRevision: target?.revision, expectedHash: target?.hash });
    await this.close();
  }
  static async cancel() { await this.close(); }
  _onClose(options) { this.resolveChoice?.(null); super._onClose(options); }
}
