export class ToolOptionsDropShadowControlsWorkflow {
  constructor(host) {
    this._host = host;
    this._root = null;
    this._controlId = '';
    this._scaleSlider = null;
    this._alphaSlider = null;
    this._dilationSlider = null;
    this._blurSlider = null;
    this._offsetSlider = null;
    this._offsetControl = null;
    this._offsetCircle = null;
    this._offsetHandle = null;
    this._previewRoot = null;
    this._previewImage = null;
    this._offsetMaxDistance = 40;
    this._offsetPointerId = null;
    this._offsetPointerActive = false;
    this._scaleDisplay = null;
    this._alphaDisplay = null;
    this._dilationDisplay = null;
    this._blurDisplay = null;
    this._offsetDisplay = null;
    this._offsetDistanceDisplay = null;
    this._offsetAngleDisplay = null;
    this._offsetMaxDisplay = null;
    this._elevationDisplay = null;
    this._statusDisplay = null;
    this._noteDisplay = null;
    this._collapseButton = null;
    this._body = null;
    this._editRoot = null;
    this._editToggle = null;
    this._editResetButton = null;
    this._onlyRoot = null;
    this._onlyToggle = null;
    this._presetsRoot = null;
    this._presetButtons = [];
    this._resetButton = null;
    this._boundOffsetPointerDown = (event) => this.handleOffsetPointerDown(event);
    this._boundOffsetPointerMove = (event) => this.handleOffsetPointerMove(event);
    this._boundOffsetPointerUp = (event) => this.handleOffsetPointerUp(event);
  }

  get controlId() {
    return this._controlId;
  }

  bind() {
    const host = this._host;
    const root = host.element?.querySelector('[data-fa-nexus-drop-shadow-root]') || null;
    if (!root) {
      this.unbind();
      return;
    }
    if (this._root === root) {
      host._syncDropShadowControl();
      this.sync();
      return;
    }
    this.unbind();
    this._root = root;
    this._controlId = String(root.getAttribute('data-fa-nexus-drop-shadow-root') || '');
    this._scaleDisplay = root.querySelector('[data-fa-nexus-drop-shadow-scale-display]') || null;
    this._alphaDisplay = root.querySelector('[data-fa-nexus-drop-shadow-alpha-display]') || null;
    this._dilationDisplay = root.querySelector('[data-fa-nexus-drop-shadow-dilation-display]') || null;
    this._blurDisplay = root.querySelector('[data-fa-nexus-drop-shadow-blur-display]') || null;
    this._offsetDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-display]') || null;
    this._offsetDistanceDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-distance-display]') || null;
    this._offsetAngleDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-angle-display]') || null;
    this._offsetMaxDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-max-display]') || null;
    this._elevationDisplay = root.querySelector('[data-fa-nexus-drop-shadow-elevation]') || null;
    this._statusDisplay = root.querySelector('[data-fa-nexus-drop-shadow-status]') || null;
    this._noteDisplay = root.querySelector('[data-fa-nexus-drop-shadow-note]') || null;
    this._collapseButton = root.querySelector('[data-fa-nexus-drop-shadow-toggle]') || null;
    if (this._collapseButton) {
      this._collapseButton.addEventListener('click', host._boundDropShadowCollapse);
    }
    this._body = root.querySelector('[data-fa-nexus-drop-shadow-body]') || null;
    this._editRoot = root.querySelector('[data-fa-nexus-drop-shadow-edit-row]')
      || root.querySelector('[data-fa-nexus-drop-shadow-edit-root]')
      || null;
    this._editToggle = root.querySelector('[data-fa-nexus-drop-shadow-edit]') || null;
    if (this._editToggle) {
      this._editToggle.addEventListener('change', host._boundDropShadowEditToggle);
    }
    this._editResetButton = root.querySelector('[data-fa-nexus-drop-shadow-edit-reset]') || null;
    if (this._editResetButton) {
      this._editResetButton.addEventListener('click', host._boundDropShadowEditReset);
    }
    this._onlyRoot = root.querySelector('[data-fa-nexus-drop-shadow-only-row]') || null;
    this._onlyToggle = root.querySelector('[data-fa-nexus-drop-shadow-only]') || null;
    if (this._onlyToggle) {
      this._onlyToggle.addEventListener('change', host._boundDropShadowOnlyToggle);
    }
    this._presetsRoot = root.querySelector('[data-fa-nexus-drop-shadow-presets]') || null;
    if (this._presetsRoot) {
      this._presetButtons = Array.from(this._presetsRoot.querySelectorAll('[data-fa-nexus-drop-shadow-preset]'));
      for (const button of this._presetButtons) {
        button.addEventListener('click', host._boundDropShadowPresetClick);
        button.addEventListener('contextmenu', host._boundDropShadowPresetContext);
      }
    } else {
      this._presetButtons = [];
    }
    this._resetButton = root.querySelector('[data-fa-nexus-drop-shadow-reset]') || null;
    if (this._resetButton) {
      this._resetButton.addEventListener('click', host._boundDropShadowReset);
    }

    const scaleSlider = root.querySelector('[data-fa-nexus-drop-shadow-scale]');
    if (scaleSlider) {
      scaleSlider.addEventListener('input', host._boundDropShadowScaleInput);
      scaleSlider.addEventListener('change', host._boundDropShadowScaleCommit);
      this._scaleSlider = scaleSlider;
    }
    host._bindDisplayInput(this._scaleDisplay, host._boundDropShadowScaleInput, host._boundDropShadowScaleCommit);
    const alphaSlider = root.querySelector('[data-fa-nexus-drop-shadow-alpha]');
    if (alphaSlider) {
      alphaSlider.addEventListener('input', host._boundDropShadowAlphaInput);
      alphaSlider.addEventListener('change', host._boundDropShadowAlphaCommit);
      this._alphaSlider = alphaSlider;
    }
    host._bindDisplayInput(this._alphaDisplay, host._boundDropShadowAlphaInput, host._boundDropShadowAlphaCommit);
    const dilationSlider = root.querySelector('[data-fa-nexus-drop-shadow-dilation]');
    if (dilationSlider) {
      dilationSlider.addEventListener('input', host._boundDropShadowDilationInput);
      dilationSlider.addEventListener('change', host._boundDropShadowDilationCommit);
      this._dilationSlider = dilationSlider;
    }
    host._bindDisplayInput(this._dilationDisplay, host._boundDropShadowDilationInput, host._boundDropShadowDilationCommit);
    const blurSlider = root.querySelector('[data-fa-nexus-drop-shadow-blur]');
    if (blurSlider) {
      blurSlider.addEventListener('input', host._boundDropShadowBlurInput);
      blurSlider.addEventListener('change', host._boundDropShadowBlurCommit);
      this._blurSlider = blurSlider;
    }
    host._bindDisplayInput(this._blurDisplay, host._boundDropShadowBlurInput, host._boundDropShadowBlurCommit);
    const offsetSlider = root.querySelector('[data-fa-nexus-drop-shadow-offset]');
    if (offsetSlider) {
      offsetSlider.addEventListener('input', host._boundDropShadowOffsetInput);
      offsetSlider.addEventListener('change', host._boundDropShadowOffsetCommit);
      this._offsetSlider = offsetSlider;
    }
    host._bindDisplayInput(this._offsetDisplay, host._boundDropShadowOffsetInput, host._boundDropShadowOffsetCommit);
    const offsetControl = root.querySelector('[data-fa-nexus-drop-shadow-offset-control]');
    if (offsetControl) {
      offsetControl.addEventListener('pointerdown', this._boundOffsetPointerDown);
      offsetControl.addEventListener('contextmenu', host._boundDropShadowOffsetContext);
      this._offsetControl = offsetControl;
      this._offsetMaxDistance = Number(offsetControl.dataset.maxDistance) || 40;
    }
    host._bindDisplayInput(
      this._offsetMaxDisplay,
      null,
      host._boundDropShadowOffsetMaxCommit
    );
    if (this._offsetMaxDisplay) {
      this._offsetMaxDisplay.addEventListener('input', host._boundDropShadowOffsetMaxInput);
    }
    this._offsetCircle = root.querySelector('[data-fa-nexus-drop-shadow-offset-circle]') || null;
    this._previewRoot = root.querySelector('[data-fa-nexus-drop-shadow-offset-preview]') || null;
    this._previewImage = root.querySelector('[data-fa-nexus-drop-shadow-offset-preview-image]') || null;
    this._offsetHandle = root.querySelector('[data-fa-nexus-drop-shadow-offset-handle]') || null;

    host._syncDropShadowControl();
    this.sync();
  }

  unbind() {
    const host = this._host;
    if (this._scaleSlider) {
      try {
        this._scaleSlider.removeEventListener('input', host._boundDropShadowScaleInput);
        this._scaleSlider.removeEventListener('change', host._boundDropShadowScaleCommit);
      } catch (_) {}
    }
    host._unbindDisplayInput(this._scaleDisplay, host._boundDropShadowScaleInput, host._boundDropShadowScaleCommit);
    if (this._alphaSlider) {
      try {
        this._alphaSlider.removeEventListener('input', host._boundDropShadowAlphaInput);
        this._alphaSlider.removeEventListener('change', host._boundDropShadowAlphaCommit);
      } catch (_) {}
    }
    host._unbindDisplayInput(this._alphaDisplay, host._boundDropShadowAlphaInput, host._boundDropShadowAlphaCommit);
    if (this._dilationSlider) {
      try {
        this._dilationSlider.removeEventListener('input', host._boundDropShadowDilationInput);
        this._dilationSlider.removeEventListener('change', host._boundDropShadowDilationCommit);
      } catch (_) {}
    }
    host._unbindDisplayInput(this._dilationDisplay, host._boundDropShadowDilationInput, host._boundDropShadowDilationCommit);
    if (this._blurSlider) {
      try {
        this._blurSlider.removeEventListener('input', host._boundDropShadowBlurInput);
        this._blurSlider.removeEventListener('change', host._boundDropShadowBlurCommit);
      } catch (_) {}
    }
    host._unbindDisplayInput(this._blurDisplay, host._boundDropShadowBlurInput, host._boundDropShadowBlurCommit);
    if (this._offsetSlider) {
      try {
        this._offsetSlider.removeEventListener('input', host._boundDropShadowOffsetInput);
        this._offsetSlider.removeEventListener('change', host._boundDropShadowOffsetCommit);
      } catch (_) {}
    }
    host._unbindDisplayInput(this._offsetDisplay, host._boundDropShadowOffsetInput, host._boundDropShadowOffsetCommit);
    host._unbindDisplayInput(
      this._offsetMaxDisplay,
      null,
      host._boundDropShadowOffsetMaxCommit
    );
    if (this._offsetMaxDisplay) {
      try { this._offsetMaxDisplay.removeEventListener('input', host._boundDropShadowOffsetMaxInput); } catch (_) {}
    }
    if (this._offsetControl) {
      try { this._offsetControl.removeEventListener('pointerdown', this._boundOffsetPointerDown); } catch (_) {}
      try { this._offsetControl.removeEventListener('contextmenu', host._boundDropShadowOffsetContext); } catch (_) {}
    }
    if (this._collapseButton) {
      try { this._collapseButton.removeEventListener('click', host._boundDropShadowCollapse); } catch (_) {}
    }
    if (this._editToggle) {
      try { this._editToggle.removeEventListener('change', host._boundDropShadowEditToggle); } catch (_) {}
    }
    if (this._editResetButton) {
      try { this._editResetButton.removeEventListener('click', host._boundDropShadowEditReset); } catch (_) {}
    }
    if (this._onlyToggle) {
      try { this._onlyToggle.removeEventListener('change', host._boundDropShadowOnlyToggle); } catch (_) {}
    }
    if (Array.isArray(this._presetButtons)) {
      for (const button of this._presetButtons) {
        try { button.removeEventListener('click', host._boundDropShadowPresetClick); } catch (_) {}
        try { button.removeEventListener('contextmenu', host._boundDropShadowPresetContext); } catch (_) {}
      }
    }
    if (this._resetButton) {
      try { this._resetButton.removeEventListener('click', host._boundDropShadowReset); } catch (_) {}
    }
    this.releaseOffsetPointer();
    this._root = null;
    this._controlId = '';
    this._scaleSlider = null;
    this._alphaSlider = null;
    this._dilationSlider = null;
    this._blurSlider = null;
    this._offsetSlider = null;
    this._offsetControl = null;
    this._offsetCircle = null;
    this._previewRoot = null;
    this._previewImage = null;
    this._offsetHandle = null;
    this._scaleDisplay = null;
    this._alphaDisplay = null;
    this._dilationDisplay = null;
    this._blurDisplay = null;
    this._offsetDisplay = null;
    this._offsetDistanceDisplay = null;
    this._offsetAngleDisplay = null;
    this._offsetMaxDisplay = null;
    this._elevationDisplay = null;
    this._statusDisplay = null;
    this._noteDisplay = null;
    this._collapseButton = null;
    this._body = null;
    this._editRoot = null;
    this._editToggle = null;
    this._editResetButton = null;
    this._onlyRoot = null;
    this._onlyToggle = null;
    this._presetsRoot = null;
    this._presetButtons = [];
    this._resetButton = null;
  }

  sync() {
    const host = this._host;
    host._syncDropShadowControl();
    const state = host._getDropShadowControlsState();
    const available = !!state?.available;
    if (this._root) {
      this._root.classList.toggle('is-hidden', !available);
    }
    if (!this._root || !available) return;

    const assign = (slider, display, entry) => {
      if (!slider || !entry) return;
      if (entry.min !== undefined) slider.min = entry.min;
      if (entry.max !== undefined) slider.max = entry.max;
      if (entry.step !== undefined) slider.step = entry.step;
      if (entry.value !== undefined) slider.value = entry.value;
      host._applyDefaultValue(slider, entry.defaultValue);
      slider.disabled = !!entry.disabled;
      if (display) host._syncDisplayValue(display, entry);
    };
    const collapsed = !!(state.collapse?.collapsed ?? state.collapsed);
    if (this._root) {
      this._root.classList.toggle('is-collapsed', collapsed);
    }
    if (this._body) {
      if (collapsed) this._body.setAttribute('aria-hidden', 'true');
      else this._body.removeAttribute('aria-hidden');
    }
    if (this._collapseButton) {
      const collapseAvailable = state.collapse?.available !== false;
      this._collapseButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this._collapseButton.setAttribute('aria-label', collapsed ? 'Expand shadow settings' : 'Collapse shadow settings');
      this._collapseButton.classList.toggle('is-collapsed', collapsed);
      this._collapseButton.classList.toggle('is-hidden', !collapseAvailable);
      this._collapseButton.disabled = !collapseAvailable || !!(state.collapse?.disabled ?? state.disabled);
      this._collapseButton.title = collapsed ? 'Expand shadow settings' : 'Collapse shadow settings';
    }
    if (this._editRoot) {
      this._editRoot.classList.toggle('is-hidden', !state.edit?.available);
    }
    if (this._editToggle) {
      this._editToggle.checked = !!state.edit?.enabled;
      this._editToggle.disabled = !state.edit?.available || !!state.edit?.disabled;
    }
    if (this._editResetButton) {
      const editReset = state.edit?.reset || null;
      this._editResetButton.classList.toggle('is-hidden', !editReset);
      if (editReset) {
        this._editResetButton.disabled = !!editReset.disabled;
        this._editResetButton.textContent = editReset.label || 'Reset';
        if (editReset.tooltip) this._editResetButton.title = editReset.tooltip;
        else this._editResetButton.removeAttribute('title');
      }
    }
    if (this._onlyRoot) {
      this._onlyRoot.classList.toggle('is-hidden', !state.shadowOnly?.available);
    }
    if (this._onlyToggle) {
      this._onlyToggle.checked = !!state.shadowOnly?.enabled;
      this._onlyToggle.disabled = !state.shadowOnly?.available || !!state.shadowOnly?.disabled;
      if (state.shadowOnly?.tooltip) this._onlyToggle.closest?.('label')?.setAttribute?.('title', state.shadowOnly.tooltip);
    }
    assign(this._scaleSlider, this._scaleDisplay, state.scale);
    assign(this._alphaSlider, this._alphaDisplay, state.alpha);
    assign(this._dilationSlider, this._dilationDisplay, state.dilation);
    assign(this._blurSlider, this._blurDisplay, state.blur);
    if (state.offset) {
      const disabled = !!state.offset.disabled;
      if (state.offset.mode === 'polar' && this._offsetControl) {
        this._offsetMaxDistance = Number(state.offset.maxDistance) || this._offsetMaxDistance || 40;
        this._offsetControl.dataset.maxDistance = String(this._offsetMaxDistance);
        this._offsetControl.dataset.disabled = disabled ? 'true' : 'false';
        this._offsetControl.classList.toggle('is-disabled', disabled);
      } else if (this._offsetControl) {
        this._offsetControl.dataset.disabled = 'true';
        this._offsetControl.classList.add('is-disabled');
      }
      if (state.offset.mode === 'polar') {
        if (disabled) this.releaseOffsetPointer();
        if (this._offsetDistanceDisplay) {
          this._offsetDistanceDisplay.textContent = state.offset.displayDistance ?? '';
        }
        if (this._offsetAngleDisplay) {
          this._offsetAngleDisplay.textContent = state.offset.displayAngle ?? '';
        }
        if (state.offset.offsetMaxHandlerId && this._offsetMaxDisplay) {
          host._syncDisplayValue(this._offsetMaxDisplay, {
            value: Math.round(Number(state.offset.maxDistance) || 0),
            min: state.offset.maxDistanceMin,
            max: state.offset.maxDistanceLimit,
            step: state.offset.maxDistanceStep,
            defaultValue: state.offset.maxDistanceDefault,
            display: state.offset.maxDistanceHint || '',
            disabled
          }, { disabled });
        }
        this.positionOffsetHandle(state.offset.distance, state.offset.angle, state.offset.maxDistance);
      } else {
        this.releaseOffsetPointer();
        assign(this._offsetSlider, this._offsetDisplay, state.offset);
      }
    } else {
      this.releaseOffsetPointer();
      if (this._offsetSlider) this._offsetSlider.disabled = true;
      if (this._offsetDisplay) this._offsetDisplay.disabled = true;
      if (this._offsetDistanceDisplay) this._offsetDistanceDisplay.textContent = '';
      if (this._offsetAngleDisplay) this._offsetAngleDisplay.textContent = '';
      if (this._offsetMaxDisplay) {
        host._syncDisplayValue(this._offsetMaxDisplay, { value: '', disabled: true }, { disabled: true });
      }
    }
    const presetEntries = Array.isArray(state.presets) ? state.presets : [];
    if (Array.isArray(this._presetButtons)) {
      for (const button of this._presetButtons) {
        const index = Number(button.dataset.faNexusDropShadowPreset);
        const entry = Number.isInteger(index) && presetEntries[index] ? presetEntries[index] : presetEntries.find?.((item) => item?.index === index);
        const saved = !!entry?.saved;
        const active = !!entry?.active;
        button.classList.toggle('is-empty', !saved);
        button.classList.toggle('is-active', active);
        button.disabled = !!state.disabled;
        if (entry?.label) button.textContent = entry.label;
        button.title = entry?.tooltip || (saved ? 'Click to apply preset.' : 'Shift+Click to save preset.');
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
    if (this._resetButton) {
      const reset = state.reset || null;
      this._resetButton.disabled = !!reset?.disabled;
      this._resetButton.textContent = reset?.label || 'Reset';
      if (reset?.tooltip) this._resetButton.title = reset.tooltip;
      else this._resetButton.removeAttribute('title');
    }
    const context = state.context || {};
    if (this._elevationDisplay) {
      if (context.display) {
        this._elevationDisplay.textContent = `Elevation ${context.display}`;
        this._elevationDisplay.classList.remove('is-hidden');
      } else {
        this._elevationDisplay.textContent = '';
        this._elevationDisplay.classList.add('is-hidden');
      }
    }
    if (this._statusDisplay) {
      this._statusDisplay.textContent = context.status || '';
      this._statusDisplay.classList.toggle('is-hidden', !context.status);
    }
    if (this._noteDisplay) {
      this._noteDisplay.textContent = context.note || '';
      this._noteDisplay.classList.toggle('is-hidden', !context.note);
    }
    this.syncPreview(state.preview || null);
  }

  syncPreview(preview) {
    const root = this._previewRoot;
    const image = this._previewImage;
    if (!root || !image) return;
    const hasPreview = preview && typeof preview === 'object' && typeof preview.src === 'string' && preview.src.length > 0;
    if (hasPreview) {
      if (image.src !== preview.src) image.src = preview.src;
      if (preview.alt !== undefined) image.alt = String(preview.alt || '');
      root.classList.remove('is-empty');
    } else {
      if (image.hasAttribute('src')) image.removeAttribute('src');
      image.alt = '';
      root.classList.add('is-empty');
    }
  }

  handleOffsetPointerDown(event) {
    if (!this._offsetControl || event.button !== 0) return;
    if (this._offsetControl.dataset.disabled === 'true') return;
    this._offsetPointerId = event.pointerId;
    this._offsetPointerActive = true;
    try { this._offsetControl.setPointerCapture(event.pointerId); } catch (_) {}
    window.addEventListener('pointermove', this._boundOffsetPointerMove, { passive: false });
    window.addEventListener('pointerup', this._boundOffsetPointerUp, { passive: false });
    window.addEventListener('pointercancel', this._boundOffsetPointerUp, { passive: false });
    event.preventDefault();
    this.updateOffsetFromPointer(event, false);
  }

  handleOffsetPointerMove(event) {
    if (!this._offsetPointerActive) return;
    if (this._offsetPointerId !== null && event.pointerId !== this._offsetPointerId) return;
    event.preventDefault();
    this.updateOffsetFromPointer(event, false);
  }

  handleOffsetPointerUp(event) {
    if (!this._offsetPointerActive) return;
    if (this._offsetPointerId !== null && event.pointerId !== this._offsetPointerId) return;
    event.preventDefault();
    this.updateOffsetFromPointer(event, true);
    this.releaseOffsetPointer();
  }

  releaseOffsetPointer() {
    if (this._offsetPointerId !== null && this._offsetControl) {
      try { this._offsetControl.releasePointerCapture(this._offsetPointerId); } catch (_) {}
    }
    window.removeEventListener('pointermove', this._boundOffsetPointerMove, false);
    window.removeEventListener('pointerup', this._boundOffsetPointerUp, false);
    window.removeEventListener('pointercancel', this._boundOffsetPointerUp, false);
    this._offsetPointerId = null;
    this._offsetPointerActive = false;
  }

  updateOffsetFromPointer(event, commit) {
    const host = this._host;
    if (!this._offsetCircle || !host._controller) return;
    const control = host._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.offset?.handlerId === 'string'
      ? control.controls.offset.handlerId
      : 'setDropShadowOffset';
    if (!handlerId) return;
    const rect = this._offsetCircle.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const radius = Math.min(rect.width, rect.height) / 2;
    if (radius <= 0) return;
    const maxDistance = this._offsetMaxDistance || 40;
    const radial = Math.min(1, Math.sqrt(dx * dx + dy * dy) / radius);
    const distance = Math.min(maxDistance, Math.max(0, radial * maxDistance));
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    if (!Number.isFinite(angle)) angle = 0;
    angle = (angle + 360) % 360;
    this.positionOffsetHandle(distance, angle, maxDistance);
    host._invokeDropShadowHandlerAndSync(host._controller, handlerId, distance, angle, !!commit);
  }

  positionOffsetHandle(distance, angle, maxDistance) {
    if (!this._offsetHandle || !this._offsetCircle) return;
    const rect = this._offsetCircle.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const radius = Math.min(rect.width, rect.height) / 2;
    if (radius <= 0) return;
    const effectiveMax = Number(maxDistance) || this._offsetMaxDistance || 40;
    const ratio = effectiveMax > 0 ? Math.min(1, Math.max(0, distance / effectiveMax)) : 0;
    const theta = (Number(angle) || 0) * (Math.PI / 180);
    const offsetX = Math.cos(theta) * radius * ratio;
    const offsetY = Math.sin(theta) * radius * ratio;
    this._offsetHandle.style.setProperty('--fa-nexus-drop-shadow-offset-x', `${offsetX}px`);
    this._offsetHandle.style.setProperty('--fa-nexus-drop-shadow-offset-y', `${offsetY}px`);
  }
}
