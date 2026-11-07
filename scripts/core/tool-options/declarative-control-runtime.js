import { NexusLogger as Logger } from '../nexus-logger.js';
import { bindWrappingRange } from './wrapping-range.js';

export class DeclarativeControlRuntime {
  constructor(host) {
    this.host = host || null;
    this.toggleControls = new Map();
    this.selectControls = new Map();
    this.scalarRandomizedControls = new Map();
    this._boundToggleChange = (event) => this.handleToggleChange(event);
    this._boundSelectChange = (event) => this.handleSelectChange(event);
    this._boundScalarRandomizedInput = (event) => this.handleScalarRandomizedInput(event, false);
    this._boundScalarRandomizedCommit = (event) => this.handleScalarRandomizedInput(event, true);
    this._boundScalarRandomizedStrengthInput = (event) => this.handleScalarRandomizedStrength(event, false);
    this._boundScalarRandomizedStrengthCommit = (event) => this.handleScalarRandomizedStrength(event, true);
    this._boundScalarRandomizedMin = (event) => this.handleScalarRandomizedRange(event, 'min');
    this._boundScalarRandomizedMax = (event) => this.handleScalarRandomizedRange(event, 'max');
    this._boundScalarRandomizedRandom = (event) => this.handleScalarRandomizedRandom(event);
  }

  get root() {
    return this.host?.element || null;
  }

  get controller() {
    return this.host?._controller || null;
  }

  getControl(controlId) {
    return this.host?._getPreparedDeclarativeControl?.(controlId) || null;
  }

  bindDisplayInput(display, inputHandler, commitHandler) {
    if (!display || display.tagName !== 'INPUT') return;
    const isNumberInput = display.type === 'number';
    if (inputHandler && !isNumberInput) display.addEventListener('input', inputHandler);
    if (commitHandler) {
      display.addEventListener('change', commitHandler);
      if (isNumberInput) {
        const existingHandler = display._faNexusCommitKeydown;
        if (existingHandler) {
          try { display.removeEventListener('keydown', existingHandler); } catch (_) {}
        }
        const keydownHandler = (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          try { display._faNexusForceSyncOnCommit = true; } catch (_) {}
          commitHandler(event);
        };
        display.addEventListener('keydown', keydownHandler);
        display._faNexusCommitKeydown = keydownHandler;
      }
    }
  }

  unbindDisplayInput(display, inputHandler, commitHandler) {
    if (!display || display.tagName !== 'INPUT') return;
    if (inputHandler) {
      try { display.removeEventListener('input', inputHandler); } catch (_) {}
    }
    if (commitHandler) {
      try { display.removeEventListener('change', commitHandler); } catch (_) {}
    }
    const keydownHandler = display._faNexusCommitKeydown;
    if (keydownHandler) {
      try { display.removeEventListener('keydown', keydownHandler); } catch (_) {}
      try { delete display._faNexusCommitKeydown; } catch (_) {}
    }
    try { delete display._faNexusForceSyncOnCommit; } catch (_) {}
  }

  applyDefaultValue(target, value) {
    if (!target || typeof target.setAttribute !== 'function') return;
    const hasValue = value !== undefined && value !== null && value !== '';
    if (!hasValue || (typeof value === 'number' && !Number.isFinite(value))) {
      try { target.removeAttribute('data-fa-nexus-default-value'); } catch (_) {}
      return;
    }
    try { target.setAttribute('data-fa-nexus-default-value', String(value)); } catch (_) {}
  }

  readNumericControlValue(target) {
    if (!target) return null;
    const value = typeof target.value === 'string' ? target.value : '';
    if (target.type === 'number') {
      if (!value.trim()) return null;
      if (target.validity?.badInput) return null;
    }
    return value;
  }

  readDeclarativeNumericValue(input, {
    controlId = '',
    commit = false,
    sync = null,
    logTag = 'ToolOptions.declarative.invalidNumericInput'
  } = {}) {
    const value = this.readNumericControlValue(input);
    if (value !== null) return value;
    Logger.warn(logTag, {
      controlId: String(controlId || ''),
      commit: !!commit,
      inputType: String(input?.type || ''),
      rawValue: typeof input?.value === 'string' ? input.value : null
    });
    if (typeof sync === 'function') sync.call(this.host);
    return null;
  }

  inferStepDecimals(step) {
    const numeric = Number(step);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    if (numeric >= 1) return 0;
    const text = String(step);
    const dot = text.indexOf('.');
    if (dot === -1) return 0;
    const decimals = text.length - dot - 1;
    return decimals > 0 ? decimals : 0;
  }

  normalizeNumericInputValue(value, step) {
    if (value === '' || value === null || value === undefined) return value;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return value;
    const decimals = this.inferStepDecimals(step);
    if (decimals === null) return numeric;
    return Number(numeric.toFixed(decimals));
  }

  syncDisplayValue(display, data = {}, { disabled = false } = {}) {
    if (!display) return;
    const text = data.display || '';
    if (display.tagName === 'INPUT') {
      const isFocused = (typeof document !== 'undefined' && document.activeElement === display);
      const forceSync = display._faNexusForceSyncOnCommit === true;
      const rawValue = data.value ?? '';
      const normalizedValue = (display.type === 'number')
        ? this.normalizeNumericInputValue(rawValue, data.step ?? display.step)
        : rawValue;
      const nextValue = normalizedValue === null || normalizedValue === undefined ? '' : String(normalizedValue);
      if ((forceSync || !isFocused) && display.value !== nextValue) display.value = nextValue;
      if (forceSync) {
        try { delete display._faNexusForceSyncOnCommit; } catch (_) {}
      }
      if (data.min !== undefined) display.min = String(data.min);
      if (data.max !== undefined) display.max = String(data.max);
      if (data.step !== undefined) display.step = String(data.step);
      this.applyDefaultValue(display, data.defaultValue);
      display.disabled = !!data.disabled || !!disabled;
      if (text) display.title = text;
      else display.removeAttribute('title');
    } else if (display.textContent !== text) {
      display.textContent = text;
    }
  }

  bindToggleControls() {
    this.unbindToggleControls();
    const root = this.root;
    if (!root) return;
    const roots = Array.from(root.querySelectorAll('[data-fa-nexus-toggle-control]'));
    for (const controlRoot of roots) {
      const controlId = String(controlRoot.getAttribute('data-fa-nexus-toggle-control') || '');
      if (!controlId) continue;
      const input = controlRoot.querySelector(`[data-fa-nexus-toggle-input="${controlId}"]`);
      if (input) input.addEventListener('change', this._boundToggleChange);
      this.toggleControls.set(controlId, {
        root: controlRoot,
        input,
        label: controlRoot.querySelector('[data-fa-nexus-toggle-label]') || null,
        hint: controlRoot.querySelector('[data-fa-nexus-toggle-hint]') || null
      });
    }
    this.syncToggleControls();
  }

  unbindToggleControls() {
    if (!this.toggleControls.size) return;
    for (const { input } of this.toggleControls.values()) {
      if (!input) continue;
      input.removeEventListener('change', this._boundToggleChange);
    }
    this.toggleControls.clear();
  }

  syncToggleControls() {
    if (!this.toggleControls.size) return;
    for (const [controlId, refs] of this.toggleControls.entries()) {
      const control = this.getControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'toggle') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.input) {
        refs.input.checked = !!control.value;
        refs.input.disabled = !!control.disabled;
        if (control.tooltip) refs.input.title = control.tooltip;
        else refs.input.removeAttribute('title');
      }
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      root.classList.toggle('is-active', !!control.value);
      if (control.tooltip) root.title = control.tooltip;
      else root.removeAttribute('title');
      this.syncHint(refs.hint, control.hint);
    }
  }

  handleToggleChange(event) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-toggle-input')
      || input.closest?.('[data-fa-nexus-toggle-control]')?.getAttribute?.('data-fa-nexus-toggle-control')
      || '';
    const control = this.getControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    if (!handlerId) return;
    const controller = this.controller;
    if (!controller?.invokeToolHandler) return;
    const hasHandlerArg = control?.handlerArg !== undefined;
    this.invokeAndFinalize(
      () => (hasHandlerArg
        ? controller.invokeToolHandler(handlerId, control.handlerArg, !!input.checked)
        : controller.invokeToolHandler(handlerId, !!input.checked)),
      () => this.syncToggleControls()
    );
  }

  bindSelectControls() {
    this.unbindSelectControls();
    const root = this.root;
    if (!root) return;
    const roots = Array.from(root.querySelectorAll('[data-fa-nexus-select-control]'));
    for (const controlRoot of roots) {
      const controlId = String(controlRoot.getAttribute('data-fa-nexus-select-control') || '');
      if (!controlId) continue;
      const input = controlRoot.querySelector(`[data-fa-nexus-select-input="${controlId}"]`);
      if (input) input.addEventListener('change', this._boundSelectChange);
      this.selectControls.set(controlId, {
        root: controlRoot,
        input,
        label: controlRoot.querySelector('[data-fa-nexus-select-label]') || null,
        hint: controlRoot.querySelector('[data-fa-nexus-select-hint]') || null
      });
    }
    this.syncSelectControls();
  }

  unbindSelectControls() {
    if (!this.selectControls.size) return;
    for (const { input } of this.selectControls.values()) {
      if (!input) continue;
      input.removeEventListener('change', this._boundSelectChange);
    }
    this.selectControls.clear();
  }

  syncSelectOptions(select, control) {
    if (!select || !control || control.type !== 'select') return;
    const options = Array.isArray(control.options) ? control.options : [];
    const signature = JSON.stringify(options.map((option) => ({
      value: String(option?.value ?? ''),
      label: String(option?.label || ''),
      disabled: !!option?.disabled
    })));
    if (select.dataset.faNexusOptionSignature !== signature) {
      while (select.firstChild) select.removeChild(select.firstChild);
      const documentRef = select.ownerDocument || document;
      for (const option of options) {
        const node = documentRef.createElement('option');
        node.value = String(option?.value ?? '');
        node.textContent = String(option?.label || option?.value || '');
        node.disabled = !!option?.disabled;
        select.appendChild(node);
      }
      select.dataset.faNexusOptionSignature = signature;
    }
    const selectedValue = String(
      control.value
      ?? options.find((option) => option?.selected)?.value
      ?? options[0]?.value
      ?? ''
    );
    const hasSelectedValue = options.some((option) => String(option?.value ?? '') === selectedValue);
    const nextValue = hasSelectedValue
      ? selectedValue
      : String(options[0]?.value ?? '');
    if (select.value !== nextValue) select.value = nextValue;
  }

  syncSelectControls() {
    if (!this.selectControls.size) return;
    for (const [controlId, refs] of this.selectControls.entries()) {
      const control = this.getControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'select') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      if (refs.input) {
        refs.input.disabled = !!control.disabled;
        if (control.tooltip) refs.input.title = control.tooltip;
        else refs.input.removeAttribute('title');
        this.syncSelectOptions(refs.input, control);
      }
      if (control.tooltip) root.title = control.tooltip;
      else root.removeAttribute('title');
      this.syncHint(refs.hint, control.hint);
    }
  }

  handleSelectChange(event) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-select-input')
      || input.closest?.('[data-fa-nexus-select-control]')?.getAttribute?.('data-fa-nexus-select-control')
      || '';
    const control = this.getControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    if (!handlerId) return;
    const controller = this.controller;
    if (!controller?.invokeToolHandler) return;
    const value = this.host._coercePortalControlValue(input.value, control?.valueMode || 'string');
    this.invokeAndFinalize(
      () => controller.invokeToolHandler(handlerId, value),
      () => {
        this.syncSelectControls();
        this.host?._syncEditorActions?.();
      }
    );
  }

  bindScalarRandomizedControls() {
    this.unbindScalarRandomizedControls();
    const rootElement = this.root;
    if (!rootElement) return;
    const roots = Array.from(rootElement.querySelectorAll('[data-fa-nexus-scalar-control]'));
    for (const controlRoot of roots) {
      const controlId = String(controlRoot.getAttribute('data-fa-nexus-scalar-control') || '');
      if (!controlId) continue;
      const slider = controlRoot.querySelector(`[data-fa-nexus-scalar-slider="${controlId}"]`);
      const display = controlRoot.querySelector(`[data-fa-nexus-scalar-display="${controlId}"]`);
      const randomButton = controlRoot.querySelector(`[data-fa-nexus-scalar-random="${controlId}"]`);
      const randomRangeShell = controlRoot.querySelector(`[data-fa-nexus-scalar-random-range-shell="${controlId}"]`);
      const randomMinSlider = controlRoot.querySelector(`[data-fa-nexus-scalar-random-min-slider="${controlId}"]`);
      const randomMaxSlider = controlRoot.querySelector(`[data-fa-nexus-scalar-random-max-slider="${controlId}"]`);
      const randomMinDisplay = controlRoot.querySelector(`[data-fa-nexus-scalar-random-min-display="${controlId}"]`);
      const randomMaxDisplay = controlRoot.querySelector(`[data-fa-nexus-scalar-random-max-display="${controlId}"]`);
      const strengthSlider = controlRoot.querySelector(`[data-fa-nexus-scalar-strength-slider="${controlId}"]`);
      const strengthDisplay = controlRoot.querySelector(`[data-fa-nexus-scalar-strength-display="${controlId}"]`);
      if (slider) {
        slider.addEventListener('input', this._boundScalarRandomizedInput);
        slider.addEventListener('change', this._boundScalarRandomizedCommit);
      }
      this.bindDisplayInput(display, this._boundScalarRandomizedInput, this._boundScalarRandomizedCommit);
      if (randomButton) randomButton.addEventListener('click', this._boundScalarRandomizedRandom);
      if (randomMinSlider) {
        randomMinSlider.addEventListener('input', this._boundScalarRandomizedMin);
        randomMinSlider.addEventListener('change', this._boundScalarRandomizedMin);
      }
      if (randomMaxSlider) {
        randomMaxSlider.addEventListener('input', this._boundScalarRandomizedMax);
        randomMaxSlider.addEventListener('change', this._boundScalarRandomizedMax);
      }
      this.bindDisplayInput(randomMinDisplay, this._boundScalarRandomizedMin, this._boundScalarRandomizedMin);
      this.bindDisplayInput(randomMaxDisplay, this._boundScalarRandomizedMax, this._boundScalarRandomizedMax);
      if (strengthSlider) {
        strengthSlider.addEventListener('input', this._boundScalarRandomizedStrengthInput);
        strengthSlider.addEventListener('change', this._boundScalarRandomizedStrengthCommit);
      }
      this.bindDisplayInput(strengthDisplay, this._boundScalarRandomizedStrengthInput, this._boundScalarRandomizedStrengthCommit);
      this.scalarRandomizedControls.set(controlId, {
        root: controlRoot,
        label: controlRoot.querySelector('[data-fa-nexus-scalar-label]') || null,
        slider,
        unbindWrappingRange: slider && this.getControl(controlId)?.wrap ? bindWrappingRange(slider) : null,
        display,
        randomButton,
        randomRangeShell,
        randomMinSlider,
        randomMaxSlider,
        randomMinDisplay,
        randomMaxDisplay,
        strengthRow: controlRoot.querySelector(`[data-fa-nexus-scalar-strength-row="${controlId}"]`) || null,
        strengthLabel: controlRoot.querySelector(`[data-fa-nexus-scalar-strength-label="${controlId}"]`) || null,
        strengthSlider,
        strengthDisplay,
        hint: controlRoot.querySelector('[data-fa-nexus-scalar-hint]') || null
      });
    }
    this.syncScalarRandomizedControls();
  }

  unbindScalarRandomizedControls() {
    if (!this.scalarRandomizedControls.size) return;
    for (const {
      slider,
      unbindWrappingRange,
      display,
      randomButton,
      randomMinSlider,
      randomMaxSlider,
      randomMinDisplay,
      randomMaxDisplay,
      strengthSlider,
      strengthDisplay
    } of this.scalarRandomizedControls.values()) {
      unbindWrappingRange?.();
      if (slider) {
        try {
          slider.removeEventListener('input', this._boundScalarRandomizedInput);
          slider.removeEventListener('change', this._boundScalarRandomizedCommit);
        } catch (_) {}
      }
      this.unbindDisplayInput(display, this._boundScalarRandomizedInput, this._boundScalarRandomizedCommit);
      if (randomButton) {
        try { randomButton.removeEventListener('click', this._boundScalarRandomizedRandom); } catch (_) {}
      }
      if (randomMinSlider) {
        try {
          randomMinSlider.removeEventListener('input', this._boundScalarRandomizedMin);
          randomMinSlider.removeEventListener('change', this._boundScalarRandomizedMin);
        } catch (_) {}
      }
      if (randomMaxSlider) {
        try {
          randomMaxSlider.removeEventListener('input', this._boundScalarRandomizedMax);
          randomMaxSlider.removeEventListener('change', this._boundScalarRandomizedMax);
        } catch (_) {}
      }
      this.unbindDisplayInput(randomMinDisplay, this._boundScalarRandomizedMin, this._boundScalarRandomizedMin);
      this.unbindDisplayInput(randomMaxDisplay, this._boundScalarRandomizedMax, this._boundScalarRandomizedMax);
      if (strengthSlider) {
        try {
          strengthSlider.removeEventListener('input', this._boundScalarRandomizedStrengthInput);
          strengthSlider.removeEventListener('change', this._boundScalarRandomizedStrengthCommit);
        } catch (_) {}
      }
      this.unbindDisplayInput(strengthDisplay, this._boundScalarRandomizedStrengthInput, this._boundScalarRandomizedStrengthCommit);
    }
    this.scalarRandomizedControls.clear();
  }

  syncScalarRandomizedRangeShell(shell, control) {
    if (!shell || !control) return;
    const min = Number(control.min);
    const max = Number(control.max);
    const lower = Number(control.randomMin);
    const upper = Number(control.randomMax);
    const span = Math.max(0.0001, max - min);
    const start = ((lower - min) / span) * 100;
    const end = ((upper - min) / span) * 100;
    shell.style.setProperty('--fa-nexus-range-start', `${Math.max(0, Math.min(100, start))}%`);
    shell.style.setProperty('--fa-nexus-range-end', `${Math.max(0, Math.min(100, end))}%`);
  }

  syncScalarRandomizedControls() {
    if (!this.scalarRandomizedControls.size) return;
    for (const [controlId, refs] of this.scalarRandomizedControls.entries()) {
      const control = this.getControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || (control.type !== 'scalar' && control.type !== 'scalar-randomized')) {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      if (refs.slider) {
        refs.slider.min = String(control.min);
        refs.slider.max = String(control.max);
        refs.slider.step = String(control.step);
        const nextValue = String(control.value);
        if (refs.slider.value !== nextValue) refs.slider.value = nextValue;
        refs.slider.disabled = !!control.disabled;
        refs.slider.setAttribute('aria-label', control.ariaLabel || control.label);
        this.applyDefaultValue(refs.slider, control.defaultValue);
      }
      if (refs.display) {
        this.syncDisplayValue(refs.display, {
          min: control.min,
          max: control.max,
          step: control.step,
          value: control.value,
          display: control.display,
          defaultValue: control.defaultValue,
          disabled: control.disabled
        });
      }
      const randomVisible = control.randomButtonVisible !== false;
      if (refs.randomButton) {
        refs.randomButton.hidden = !randomVisible;
        refs.randomButton.classList.toggle('is-active', randomVisible && !!control.randomEnabled);
        refs.randomButton.setAttribute('aria-pressed', randomVisible && control.randomEnabled ? 'true' : 'false');
        refs.randomButton.setAttribute('aria-label', control.randomAria || control.randomTooltip || control.randomLabel || 'Toggle random');
        if (control.randomTooltip) refs.randomButton.title = control.randomTooltip;
        else refs.randomButton.removeAttribute('title');
        refs.randomButton.disabled = !randomVisible || !!control.disabled || !control.randomHandlerId;
        const label = refs.randomButton.querySelector('span');
        const nextLabel = control.randomLabel || 'Random';
        if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
      }
      const rangeMode = control.randomMode === 'range';
      const rangeVisible = randomVisible && !!control.randomEnabled && rangeMode;
      const strengthVisible = randomVisible && !!control.randomEnabled && !rangeMode;
      if (refs.randomRangeShell) {
        refs.randomRangeShell.hidden = !rangeVisible;
        if (rangeVisible) this.syncScalarRandomizedRangeShell(refs.randomRangeShell, control);
      }
      if (refs.randomMinSlider) {
        refs.randomMinSlider.min = String(control.min);
        refs.randomMinSlider.max = String(control.max);
        refs.randomMinSlider.step = String(control.step);
        const nextValue = String(control.randomMin);
        if (refs.randomMinSlider.value !== nextValue) refs.randomMinSlider.value = nextValue;
        refs.randomMinSlider.disabled = !rangeVisible || !control.randomMinHandlerId;
        refs.randomMinSlider.setAttribute('aria-label', control.randomMinAriaLabel || 'Minimum');
        this.applyDefaultValue(refs.randomMinSlider, control.randomMinDefault);
      }
      if (refs.randomMaxSlider) {
        refs.randomMaxSlider.min = String(control.min);
        refs.randomMaxSlider.max = String(control.max);
        refs.randomMaxSlider.step = String(control.step);
        const nextValue = String(control.randomMax);
        if (refs.randomMaxSlider.value !== nextValue) refs.randomMaxSlider.value = nextValue;
        refs.randomMaxSlider.disabled = !rangeVisible || !control.randomMaxHandlerId;
        refs.randomMaxSlider.setAttribute('aria-label', control.randomMaxAriaLabel || 'Maximum');
        this.applyDefaultValue(refs.randomMaxSlider, control.randomMaxDefault);
      }
      if (refs.randomMinDisplay) {
        this.syncDisplayValue(refs.randomMinDisplay, {
          min: control.min,
          max: control.max,
          step: control.step,
          value: control.randomMin,
          display: control.randomMinDisplay,
          defaultValue: control.randomMinDefault,
          disabled: !rangeVisible || !control.randomMinHandlerId
        });
      }
      if (refs.randomMaxDisplay) {
        this.syncDisplayValue(refs.randomMaxDisplay, {
          min: control.min,
          max: control.max,
          step: control.step,
          value: control.randomMax,
          display: control.randomMaxDisplay,
          defaultValue: control.randomMaxDefault,
          disabled: !rangeVisible || !control.randomMaxHandlerId
        });
      }
      if (refs.strengthRow) refs.strengthRow.hidden = !strengthVisible;
      if (refs.strengthLabel && refs.strengthLabel.textContent !== control.strengthLabel) refs.strengthLabel.textContent = control.strengthLabel;
      if (refs.strengthSlider) {
        refs.strengthSlider.min = String(control.strengthMin);
        refs.strengthSlider.max = String(control.strengthMax);
        refs.strengthSlider.step = String(control.strengthStep);
        const nextValue = String(control.strength);
        if (refs.strengthSlider.value !== nextValue) refs.strengthSlider.value = nextValue;
        refs.strengthSlider.disabled = !strengthVisible || !control.strengthHandlerId;
        refs.strengthSlider.setAttribute('aria-label', control.strengthAriaLabel || control.strengthLabel);
        this.applyDefaultValue(refs.strengthSlider, control.strengthDefault);
      }
      if (refs.strengthDisplay) {
        this.syncDisplayValue(refs.strengthDisplay, {
          min: control.strengthMin,
          max: control.strengthMax,
          step: control.strengthStep,
          value: control.strength,
          display: control.strengthDisplay,
          defaultValue: control.strengthDefault,
          disabled: !strengthVisible || !control.strengthHandlerId
        });
      }
      this.syncHint(refs.hint, control.hint);
    }
  }

  handleScalarRandomizedInput(event, commit) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-scalar-slider')
      || input.getAttribute?.('data-fa-nexus-scalar-display')
      || input.closest?.('[data-fa-nexus-scalar-control]')?.getAttribute?.('data-fa-nexus-scalar-control')
      || '';
    const control = this.getControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    const controller = this.controller;
    if (!handlerId || !controller?.invokeToolHandler) return;
    const value = this.readDeclarativeNumericValue(input, {
      controlId,
      commit,
      sync: () => this.syncScalarRandomizedControls(),
      logTag: 'ToolOptions.declarativeScalar.invalidNumericInput'
    });
    if (value === null) return;
    this.invokeAndFinalize(
      () => controller.invokeToolHandler(handlerId, value, !!commit),
      () => this.syncScalarRandomizedControls()
    );
  }

  handleScalarRandomizedStrength(event) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-scalar-strength-slider')
      || input.getAttribute?.('data-fa-nexus-scalar-strength-display')
      || input.closest?.('[data-fa-nexus-scalar-control]')?.getAttribute?.('data-fa-nexus-scalar-control')
      || '';
    const control = this.getControl(controlId);
    const handlerId = typeof control?.strengthHandlerId === 'string' ? control.strengthHandlerId : '';
    const controller = this.controller;
    if (!handlerId || !controller?.invokeToolHandler) return;
    const value = this.readDeclarativeNumericValue(input, {
      controlId,
      sync: () => this.syncScalarRandomizedControls(),
      logTag: 'ToolOptions.declarativeScalarStrength.invalidNumericInput'
    });
    if (value === null) return;
    this.invokeAndFinalize(
      () => controller.invokeToolHandler(handlerId, value),
      () => this.syncScalarRandomizedControls()
    );
  }

  handleScalarRandomizedRange(event, boundary) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.(`data-fa-nexus-scalar-random-${boundary}-slider`)
      || input.getAttribute?.(`data-fa-nexus-scalar-random-${boundary}-display`)
      || input.closest?.('[data-fa-nexus-scalar-control]')?.getAttribute?.('data-fa-nexus-scalar-control')
      || '';
    const control = this.getControl(controlId);
    const handlerId = boundary === 'min'
      ? (typeof control?.randomMinHandlerId === 'string' ? control.randomMinHandlerId : '')
      : (typeof control?.randomMaxHandlerId === 'string' ? control.randomMaxHandlerId : '');
    const controller = this.controller;
    if (!handlerId || !controller?.invokeToolHandler) return;
    const value = this.readDeclarativeNumericValue(input, {
      controlId: `${controlId}:${boundary}`,
      sync: () => this.syncScalarRandomizedControls(),
      logTag: 'ToolOptions.declarativeScalarRange.invalidNumericInput'
    });
    if (value === null) return;
    this.invokeAndFinalize(
      () => controller.invokeToolHandler(handlerId, value),
      () => this.syncScalarRandomizedControls()
    );
  }

  handleScalarRandomizedRandom(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const target = event?.currentTarget || event?.target;
    const controlId = String(target?.getAttribute?.('data-fa-nexus-scalar-random') || '');
    if (!controlId) return;
    const control = this.getControl(controlId);
    const handlerId = typeof control?.randomHandlerId === 'string' ? control.randomHandlerId : '';
    const controller = this.controller;
    if (!handlerId || !controller?.invokeToolHandler) return;
    this.invokeAndFinalize(
      () => controller.invokeToolHandler(handlerId),
      () => this.syncScalarRandomizedControls()
    );
  }

  syncHint(hint, textValue = '') {
    if (!hint) return;
    const text = textValue || '';
    hint.textContent = text;
    hint.hidden = !text;
  }

  invokeAndFinalize(invoke, finalize) {
    try {
      const result = invoke();
      if (result?.then) {
        result.catch(() => {}).finally(finalize);
      } else {
        finalize();
      }
    } catch (_) {
      finalize();
    }
  }
}
