export class PortalControlRuntime {
  constructor(host) {
    this.host = host || null;
    this._syncTimer = null;
    this._destroyed = false;
  }

  get root() {
    return this.host?.element || null;
  }

  get controller() {
    return this.host?._controller || null;
  }

  getControl(controlId = '') {
    return this.host?._getPreparedPortalControl?.(controlId) || null;
  }

  getControlFromEvent(event) {
    const root = event?.currentTarget?.closest?.('[data-fa-nexus-portal-root]')
      || event?.target?.closest?.('[data-fa-nexus-portal-root]')
      || null;
    if (!root) return null;
    return this.getControl(root.getAttribute('data-fa-nexus-portal-root') || '');
  }

  coerceValue(value, mode = 'string') {
    return this.host._coercePortalControlValue(value, mode);
  }

  syncControls() {
    if (this._destroyed) return;
    const element = this.root;
    if (!element) return;
    const roots = Array.from(element.querySelectorAll('[data-fa-nexus-portal-root]'));
    for (const root of roots) {
      const controlId = root.getAttribute('data-fa-nexus-portal-root') || '';
      const control = this.getControl(controlId);
      if (!control) {
        root.style.display = 'none';
        continue;
      }
      root.style.display = '';
      this.bindRoot(root);
      this.syncControlRoot(root, control);
    }
  }

  bindRoot(root) {
    if (!root || root._faPortalBound) return;
    root._faPortalBound = true;
    for (const button of root.querySelectorAll('[data-fa-nexus-portal-action]')) {
      button.addEventListener('click', (event) => this.handleAction(event));
    }
    for (const input of root.querySelectorAll('[data-fa-nexus-portal-toggle]')) {
      input.addEventListener('change', (event) => this.handleToggle(event));
    }
    for (const select of root.querySelectorAll('[data-fa-nexus-portal-select]')) {
      select.addEventListener('change', (event) => this.handleSelect(event));
    }
    for (const input of root.querySelectorAll('[data-fa-nexus-portal-color-target]')) {
      input.addEventListener('change', (event) => this.handleColorTarget(event));
    }
    for (const slider of root.querySelectorAll('[data-fa-nexus-portal-setting-input]')) {
      slider.addEventListener('input', (event) => this.handleSetting(event, false));
      slider.addEventListener('change', (event) => this.handleSetting(event, true));
    }
    for (const display of root.querySelectorAll('[data-fa-nexus-portal-setting-display]')) {
      this.host._bindDisplayInput(display, null, (event) => this.handleSetting(event, true));
    }
    for (const button of root.querySelectorAll('[data-fa-nexus-portal-section-toggle]')) {
      button.addEventListener('click', (event) => this.handleSectionToggle(event));
    }
  }

  scheduleSync() {
    if (this._destroyed) return;
    if (this._syncTimer) {
      try { clearTimeout(this._syncTimer); } catch (_) {}
      this._syncTimer = null;
    }
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      this.syncControls();
    }, 75);
  }

  syncAndSchedule() {
    if (this._destroyed) return;
    this.syncControls();
    this.scheduleSync();
  }

  destroy() {
    this._destroyed = true;
    if (this._syncTimer) {
      try { clearTimeout(this._syncTimer); } catch (_) {}
      this._syncTimer = null;
    }
    this.host = null;
  }

  syncControlRoot(root, control) {
    const selection = root.querySelector('[data-fa-nexus-portal-selection]');
    if (selection) selection.textContent = control.selectionLabel || '';
    const selectionHint = root.querySelector('[data-fa-nexus-portal-selection-hint]');
    if (selectionHint) {
      const value = control.selectionHint || '';
      selectionHint.textContent = value;
      selectionHint.style.display = value ? '' : 'none';
    }

    const actionLabelNodes = root.querySelectorAll('[data-fa-nexus-portal-action-label]');
    for (const node of actionLabelNodes) {
      const actionId = node.getAttribute('data-fa-nexus-portal-action-label') || '';
      const action = control.actionMap?.[actionId];
      if (!action) continue;
      if (node.textContent !== action.label) node.textContent = action.label;
    }
    for (const button of root.querySelectorAll('[data-fa-nexus-portal-action]')) {
      const actionId = button.getAttribute('data-fa-nexus-portal-action') || '';
      const action = control.actionMap?.[actionId];
      if (!action) continue;
      button.disabled = !!action.disabled;
      if (action.title) button.title = action.title;
      else button.removeAttribute('title');
    }

    for (const groupRoot of root.querySelectorAll('[data-fa-nexus-portal-toggle-group]')) {
      const groupId = groupRoot.getAttribute('data-fa-nexus-portal-toggle-group') || '';
      const group = control.toggleGroupMap?.[groupId];
      groupRoot.style.display = group?.visible === false ? 'none' : '';
    }
    for (const input of root.querySelectorAll('[data-fa-nexus-portal-toggle]')) {
      const toggleId = input.getAttribute('data-fa-nexus-portal-toggle') || '';
      const toggle = control.toggleMap?.[toggleId];
      if (!toggle) continue;
      input.checked = !!toggle.checked;
      input.disabled = !!toggle.disabled;
      if (toggle.title) input.closest('label')?.setAttribute('title', toggle.title);
    }

    for (const groupRoot of root.querySelectorAll('[data-fa-nexus-portal-select-group]')) {
      const groupId = groupRoot.getAttribute('data-fa-nexus-portal-select-group') || '';
      const group = control.selectGroupMap?.[groupId];
      groupRoot.style.display = group?.visible === false ? 'none' : '';
    }
    for (const select of root.querySelectorAll('[data-fa-nexus-portal-select]')) {
      const selectId = select.getAttribute('data-fa-nexus-portal-select') || '';
      const config = control.selectMap?.[selectId];
      if (!config) continue;
      select.disabled = !!config.disabled;
      const nextValue = String(config.value ?? '');
      const hasOption = Array.from(select.options || []).some((option) => option?.value === nextValue);
      if (select.value !== nextValue && hasOption) {
        select.value = nextValue;
      } else if (select.value !== nextValue && !select.options.length) {
        select.value = nextValue;
      }
    }

    const colorRoot = root.querySelector('[data-fa-nexus-portal-color]');
    if (colorRoot) {
      colorRoot.style.display = control.color?.visible === false ? 'none' : '';
    }
    const colorTargetGroup = root.querySelector('[data-fa-nexus-portal-color-target-group]');
    if (colorTargetGroup) {
      colorTargetGroup.style.display = control.color?.target?.visible === false ? 'none' : '';
    }
    for (const input of root.querySelectorAll('[data-fa-nexus-portal-color-target]')) {
      const targetId = input.getAttribute('data-fa-nexus-portal-color-target') || '';
      const item = Array.isArray(control.color?.target?.items)
        ? control.color.target.items.find((entry) => entry?.id === targetId) || null
        : null;
      if (!item) continue;
      input.checked = !!item.enabled;
      input.disabled = !!item.disabled;
      const optionRoot = input.closest('.fa-nexus-declarative-segmented__option');
      if (optionRoot) {
        optionRoot.classList.toggle('is-active', !!item.enabled);
        optionRoot.classList.toggle('is-disabled', !!item.disabled);
        if (item.title) optionRoot.title = item.title;
        else optionRoot.removeAttribute('title');
      }
    }

    for (const sectionRoot of root.querySelectorAll('[data-fa-nexus-portal-section]')) {
      const sectionId = sectionRoot.getAttribute('data-fa-nexus-portal-section') || '';
      const section = sectionId === 'color'
        ? (control.color && typeof control.color === 'object'
          ? control.color
          : null)
        : control.sectionMap?.[sectionId];
      sectionRoot.style.display = section?.visible === false ? 'none' : '';
      const collapsed = !!section?.collapsed;
      sectionRoot.classList.toggle('is-collapsed', collapsed);
      const toggle = sectionRoot.querySelector('[data-fa-nexus-portal-section-toggle]');
      if (toggle) {
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.title = `${collapsed ? 'Expand' : 'Collapse'} ${section?.label || ''}`.trim();
      }
      const body = sectionRoot.querySelector('[data-fa-nexus-portal-section-body]');
      if (body) body.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    }
    for (const settingsRoot of root.querySelectorAll('[data-fa-nexus-portal-settings]')) {
      const settingsId = settingsRoot.getAttribute('data-fa-nexus-portal-settings') || '';
      const section = Object.values(control.sectionMap || {}).find?.((entry) => entry?.settings?.id === settingsId) || null;
      settingsRoot.style.display = section?.settings?.visible === false ? 'none' : '';
    }
    for (const slider of root.querySelectorAll('[data-fa-nexus-portal-setting-input]')) {
      const rowId = slider.getAttribute('data-fa-nexus-portal-setting-input') || '';
      const row = control.settingMap?.[rowId];
      if (!row) continue;
      if (row.min !== undefined) slider.min = String(row.min);
      if (row.max !== undefined) slider.max = String(row.max);
      if (row.step !== undefined) slider.step = String(row.step);
      const next = String(row.value ?? '');
      if (slider.value !== next) slider.value = next;
      this.host._applyDefaultValue(slider, row.defaultValue);
      slider.disabled = !!row.disabled;
      if (row.hint) slider.title = row.hint;
      else slider.removeAttribute('title');
    }
    for (const display of root.querySelectorAll('[data-fa-nexus-portal-setting-display]')) {
      const rowId = display.getAttribute('data-fa-nexus-portal-setting-display') || '';
      const row = control.settingMap?.[rowId];
      if (!row) continue;
      this.host._syncDisplayValue(display, row, { disabled: row.disabled });
    }
  }

  handleAction(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const button = event?.currentTarget || event?.target;
    const actionId = button?.getAttribute?.('data-fa-nexus-portal-action') || '';
    if (!actionId) return;
    const control = this.getControlFromEvent(event);
    const action = control?.actionMap?.[actionId];
    const handlerId = typeof action?.handlerId === 'string' ? action.handlerId : '';
    if (!handlerId || !this.controller?.invokeToolHandler) return;
    this.invokeAndSync(() => this.controller.invokeToolHandler(handlerId));
  }

  handleToggle(event) {
    const input = event?.currentTarget || event?.target;
    const toggleId = input?.getAttribute?.('data-fa-nexus-portal-toggle') || '';
    if (!toggleId) return;
    const control = this.getControlFromEvent(event);
    const toggle = control?.toggleMap?.[toggleId];
    const handlerId = typeof toggle?.handlerId === 'string' ? toggle.handlerId : '';
    if (!handlerId || !this.controller?.invokeToolHandler) return;
    this.invokeAndSync(() => this.controller.invokeToolHandler(handlerId, !!input.checked));
  }

  handleColorTarget(event) {
    const input = event?.currentTarget || event?.target;
    if (!input?.checked) return;
    const targetId = input.getAttribute?.('data-fa-nexus-portal-color-target') || '';
    if (!targetId) return;
    const control = this.getControlFromEvent(event);
    const handlerId = typeof control?.color?.target?.handlerId === 'string' ? control.color.target.handlerId : '';
    if (!handlerId || !this.controller?.invokeToolHandler) return;
    this.invokeAndSync(() => this.controller.invokeToolHandler(handlerId, targetId));
  }

  handleSelect(event) {
    const select = event?.currentTarget || event?.target;
    const selectId = select?.getAttribute?.('data-fa-nexus-portal-select') || '';
    if (!selectId) return;
    const control = this.getControlFromEvent(event);
    const config = control?.selectMap?.[selectId];
    const handlerId = typeof config?.handlerId === 'string' ? config.handlerId : '';
    if (!handlerId || !this.controller?.invokeToolHandler) return;
    const value = this.coerceValue(select.value, config.valueMode);
    this.invokeAndSync(() => this.controller.invokeToolHandler(handlerId, value));
  }

  handleSectionToggle(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const button = event?.currentTarget || event?.target;
    const sectionId = button?.getAttribute?.('data-fa-nexus-portal-section-toggle') || '';
    const root = button?.closest?.('[data-fa-nexus-portal-root]') || null;
    const controlId = root?.getAttribute?.('data-fa-nexus-portal-root') || '';
    if (!controlId || !sectionId) return;
    this.host._togglePortalSectionCollapsed(controlId, sectionId);
    this.syncControls();
  }

  handleSetting(event, commit) {
    const input = event?.currentTarget || event?.target;
    const rowId = input?.getAttribute?.('data-fa-nexus-portal-setting-input')
      || input?.getAttribute?.('data-fa-nexus-portal-setting-display')
      || '';
    if (!rowId) return;
    const control = this.getControlFromEvent(event);
    const row = control?.settingMap?.[rowId];
    const handlerId = typeof row?.handlerId === 'string' ? row.handlerId : '';
    if (!handlerId || !this.controller?.invokeToolHandler) return;
    const value = this.coerceValue(input.value, row.valueMode);
    this.invokeAndSync(() => this.controller.invokeToolHandler(handlerId, value, !!commit));
  }

  invokeAndSync(invoke) {
    const report = (error) => {
      const message = String(error?.message || error || 'Unknown Portal action failure.');
      console.error('[fa-nexus] Portal control action failed.', error);
      globalThis.ui?.notifications?.error?.(`Portal action failed: ${message}`);
    };
    try {
      const result = invoke();
      if (result?.then) result.catch(report).finally(() => this.syncAndSchedule());
      else this.syncAndSchedule();
    } catch (error) {
      report(error);
      this.syncAndSchedule();
    }
  }
}
