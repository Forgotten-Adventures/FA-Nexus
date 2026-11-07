import { NexusLogger as Logger } from '../nexus-logger.js';
import {
  GRID_SNAP_SUBDIV_MIN,
  GRID_SNAP_SUBDIV_MAX,
  GRID_SNAP_SUBDIV_DEFAULT,
  normalizeGridSnapSubdivision,
  formatGridSnapSubdivisionLabel
} from '../grid-snap-utils.js';
import { isHelpShortcut } from '../editor-shortcuts.js';
import {
  TOOL_OPTIONS_RENDERER_MODE
} from './tool-options-descriptor.js';
import { DeclarativeControlRuntime } from './declarative-control-runtime.js';
import { PortalControlRuntime } from './portal-control-runtime.js';
import {
  DEFAULT_WINDOW_TITLE,
  MODULE_ID,
  SHORTCUTS_SETTING_KEY,
  TOOL_OPTIONS_ACTIVITY_EVENT,
  TOOL_WINDOW_SETTING_KEY,
  getToolSectionLabel
} from './shared.js';
import {
  prepareDeclarativeRangeState,
  prepareDropShadowControls,
  prepareFlipContext,
  prepareFreehandSimplifyContext,
  prepareLayerOpacityContext,
  prepareOpacityFeatherContext,
  preparePathAppearanceContext,
  preparePathFeatherContext,
  preparePathScaleContext,
  preparePathShadowContext,
  preparePathTensionContext,
  prepareRotationContext,
  prepareScaleContext,
  prepareShapeStackingContext,
  prepareShowWidthTangentsContext,
  prepareTextureOffsetContext
} from './context-normalizers.js';

class ToolOptionsWindowControlMethods {
  _ensurePlaceAsNamingSection() {
    const naming = this._toolOptionState?.placeAs?.naming || {};
    if (!naming?.available) return;
    const root = this.element;
    if (!root) return;
    const hasToggle = !!(
      root.querySelector('[data-place-as-append-number]')
      || root.querySelector('[data-place-as-prepend-adjective]')
      || root.querySelector('.fa-nexus-place-as__naming')
    );
    if (hasToggle) return;

    // The tool state can update while a render is in-flight, leaving the DOM in an older layout.
    // If the state expects the naming section but the DOM doesn't have it, force a follow-up render.
    const revision = this._toolOptionState?.layoutRevision ?? null;
    if (revision !== this._placeAsNamingRerenderRevision) {
      this._placeAsNamingRerenderRevision = revision;
      this._placeAsNamingRerenderCount = 0;
    }
    if (this._placeAsNamingRerenderCount >= 2) return;
    if (this._placeAsNamingRerenderJob) return;
    this._placeAsNamingRerenderCount += 1;
    this._placeAsNamingRerenderJob = setTimeout(() => {
      this._placeAsNamingRerenderJob = null;
      try {
        if (this.rendered) this.render(false);
      } catch (_) {}
    }, 0);
  }

  _measureScrollState() {
    try {
      const container = this._getScrollContainer();
      if (!container) return null;
      return {
        top: Number(container.scrollTop) || 0,
        left: Number(container.scrollLeft) || 0
      };
    } catch (_) {
      return null;
    }
  }

  _applyScrollState(container, state) {
    if (!container || !state || typeof state !== 'object') return;
    if (Number.isFinite(state.top)) container.scrollTop = state.top;
    if (Number.isFinite(state.left)) container.scrollLeft = state.left;
  }

  _scheduleScrollStateRestore(state) {
    if (!state || typeof state !== 'object') return;
    const requestFrame = globalThis?.requestAnimationFrame;
    if (typeof requestFrame !== 'function') return;
    const top = Number(state.top);
    const left = Number(state.left);
    if (!Number.isFinite(top) && !Number.isFinite(left)) return;
    const snapshot = {
      top: Number.isFinite(top) ? top : 0,
      left: Number.isFinite(left) ? left : 0
    };
    const token = (this._scrollRestoreToken || 0) + 1;
    this._scrollRestoreToken = token;
    const restore = () => {
      if (this._scrollRestoreToken !== token) return;
      const container = this._getScrollContainer();
      if (!container) return;
      this._applyScrollState(container, snapshot);
    };
    // Foundry/browser focus work can run after _onRender; keep the measured scroll through the next paints.
    requestFrame(() => {
      restore();
      requestFrame(restore);
    });
  }

  _restoreScrollState() {
    const container = this._getScrollContainer();
    if (!container) {
      this._pendingScrollState = null;
      return;
    }
    const state = this._pendingScrollState;
    if (state && typeof state === 'object') {
      this._applyScrollState(container, state);
      this._scheduleScrollStateRestore(state);
    } else if (this._resetScrollNextRender) {
      const resetState = { top: 0, left: 0 };
      this._applyScrollState(container, resetState);
    }
    this._pendingScrollState = null;
  }

  _getScrollContainer() {
    const root = this.element;
    if (!root) return null;
    return (
      root.querySelector('[data-fa-nexus-scroll-container]')
      || root.querySelector('.fa-nexus-tool-options__content')
      || root.querySelector('.fa-nexus-tool-options')
      || root.querySelector('.window-content')
      || root
    );
  }

  _measureContentStyle() {
    try {
      const content = this.element?.querySelector('.window-content');
      if (!content) return null;
      return content.getAttribute('style') ?? '';
    } catch (_) {
      return null;
    }
  }

  _restoreContentStyle() {
    const style = this._pendingContentStyle;
    this._pendingContentStyle = null;
    if (style === null || style === undefined) return;
    const content = this.element?.querySelector('.window-content');
    if (!content) return;
    if (style === '') content.removeAttribute('style');
    else content.setAttribute('style', style);
  }

  _emitToolPanelActivity() {
    try {
      const target = this.element || document;
      target?.dispatchEvent?.(new CustomEvent(TOOL_OPTIONS_ACTIVITY_EVENT, {
        bubbles: true,
        detail: {
          active: !!this._toolPanelActivityActive,
          toolId: this._activeTool?.id ?? null
        }
      }));
    } catch (_) {}
  }

  _setToolPanelActivity(active) {
    const next = !!active;
    if (this._toolPanelActivityActive === next) {
      if (next) this._emitToolPanelActivity();
      return next;
    }
    this._toolPanelActivityActive = next;
    this._emitToolPanelActivity();
    return next;
  }

  _syncToolPanelActivityState() {
    const root = this.element;
    if (!root) return this._setToolPanelActivity(false);
    const hovered = !!root.matches?.(':hover');
    return this._setToolPanelActivity(hovered);
  }

  _handleToolPanelFocusOut(event) {
    const relatedTarget = event?.relatedTarget;
    if (relatedTarget && this.element?.contains?.(relatedTarget)) return;
    const defer = typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (callback) => setTimeout(callback, 0);
    defer(() => this._syncToolPanelActivityState());
  }

  _bindDisplayInput(display, inputHandler, commitHandler) {
    this._getDeclarativeControlRuntime().bindDisplayInput(display, inputHandler, commitHandler);
  }

  _unbindDisplayInput(display, inputHandler, commitHandler) {
    this._getDeclarativeControlRuntime().unbindDisplayInput(display, inputHandler, commitHandler);
  }

  _applyDefaultValue(target, value) {
    this._getDeclarativeControlRuntime().applyDefaultValue(target, value);
  }

  _readNumericControlValue(target) {
    return this._getDeclarativeControlRuntime().readNumericControlValue(target);
  }

  _readDeclarativeNumericValue(input, {
    controlId = '',
    commit = false,
    sync = null,
    logTag = 'ToolOptions.declarative.invalidNumericInput'
  } = {}) {
    return this._getDeclarativeControlRuntime().readDeclarativeNumericValue(input, {
      controlId,
      commit,
      sync,
      logTag
    });
  }

  _inferStepDecimals(step) {
    return this._getDeclarativeControlRuntime().inferStepDecimals(step);
  }

  _normalizeNumericInputValue(value, step) {
    return this._getDeclarativeControlRuntime().normalizeNumericInputValue(value, step);
  }

  _syncDisplayValue(display, data = {}, { disabled = false } = {}) {
    this._getDeclarativeControlRuntime().syncDisplayValue(display, data, { disabled });
  }

  _bindControls() {
    this._unbindControls();
    try {
      const root = this.element;
      if (!root) return;
      root.addEventListener('contextmenu', this._boundResettableContext);
      root.addEventListener('wheel', this._boundSliderWheel, { passive: false });
      root.addEventListener('keydown', this._boundWindowKeyDown);
      root.addEventListener('pointerenter', this._boundToolPanelPointerEnter);
      root.addEventListener('pointerleave', this._boundToolPanelPointerLeave);
      root.addEventListener('focusin', this._boundToolPanelFocusIn);
      root.addEventListener('focusout', this._boundToolPanelFocusOut);
      this._resettableContextRoot = root;
      this._sliderWheelRoot = root;
      this._helpKeyRoot = root;
      this._toolPanelActivityRoot = root;
      this._bindToolSectionControls();
      const helpButton = root.querySelector('[data-fa-nexus-help-open]');
      if (helpButton) {
        helpButton.addEventListener('click', this._boundHelpOpen);
        this._helpButton = helpButton;
      }
      const gridToggle = root.querySelector('#fa-nexus-grid-snap-toggle');
      if (gridToggle) {
        gridToggle.checked = !!this._gridSnapEnabled;
        const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
        const canToggle = this._gridSnapAvailable && (controllerAllows !== false);
        gridToggle.disabled = !canToggle;
        gridToggle.addEventListener('change', this._boundGridSnapChange);
        this._gridSnapToggle = gridToggle;
      }
      this._bindGridSnapResolutionControl();
      const dropToggle = root.querySelector('#fa-nexus-drop-shadow-toggle');
      if (dropToggle) {
        const dropState = this._toolOptionState?.dropShadow || {};
        dropToggle.checked = !!dropState.enabled;
        dropToggle.disabled = !!dropState.disabled;
        dropToggle.addEventListener('change', this._boundDropShadowChange);
        this._dropShadowToggle = dropToggle;
      }
      this._bindDropShadowControls();
      this._bindDeclarativeSegmentedControls();
      this._bindEditorActions();
      this._bindDeclarativeToggleControls();
      this._bindDeclarativeSelectControls();
      this._bindDeclarativeRangeControls();
      this._bindDeclarativeRangePairControls();
      this._bindDeclarativeAxisPairControls();
      this._bindDeclarativeScalarRandomizedControls();
      this._bindDeclarativeStackOrderControls();
      this._bindPathAppearanceControls();
      this._bindFlipControls();
      this._bindScaleControls();
      this._bindRotationControls();
      this._bindPathShadowControls();
      this._bindPathFeatherControls();
      this._bindOpacityFeatherControls();
      this._bindCustomToggles();
      this._bindPlacementControls();
      this._syncPortalControls();
      this._bindShortcutsControls();
      this._bindPlaceAsControls();
      this._syncToolPanelActivityState();
    } catch (_) {}
  }

  _unbindControls() {
    if (this._toolPanelActivityRoot) {
      try { this._toolPanelActivityRoot.removeEventListener('pointerenter', this._boundToolPanelPointerEnter); } catch (_) {}
      try { this._toolPanelActivityRoot.removeEventListener('pointerleave', this._boundToolPanelPointerLeave); } catch (_) {}
      try { this._toolPanelActivityRoot.removeEventListener('focusin', this._boundToolPanelFocusIn); } catch (_) {}
      try { this._toolPanelActivityRoot.removeEventListener('focusout', this._boundToolPanelFocusOut); } catch (_) {}
      this._toolPanelActivityRoot = null;
    }
    if (this._resettableContextRoot) {
      try { this._resettableContextRoot.removeEventListener('contextmenu', this._boundResettableContext); }
      catch (_) {}
      this._resettableContextRoot = null;
    }
    if (this._sliderWheelRoot) {
      try { this._sliderWheelRoot.removeEventListener('wheel', this._boundSliderWheel); } catch (_) {}
      this._sliderWheelRoot = null;
    }
    if (this._helpKeyRoot) {
      try { this._helpKeyRoot.removeEventListener('keydown', this._boundWindowKeyDown); } catch (_) {}
      this._helpKeyRoot = null;
    }
    if (this._helpButton) {
      try { this._helpButton.removeEventListener('click', this._boundHelpOpen); } catch (_) {}
      this._helpButton = null;
    }
    if (this._gridSnapToggle) {
      try { this._gridSnapToggle.removeEventListener('change', this._boundGridSnapChange); }
      catch (_) {}
      this._gridSnapToggle = null;
    }
    this._unbindGridSnapResolutionControl();
    if (this._dropShadowToggle) {
      try { this._dropShadowToggle.removeEventListener('change', this._boundDropShadowChange); }
      catch (_) {}
      this._dropShadowToggle = null;
    }
    this._unbindDropShadowControls();
    this._unbindDeclarativeSegmentedControls();
    this._unbindEditorActions();
    this._unbindDeclarativeToggleControls();
    this._unbindDeclarativeSelectControls();
    this._unbindDeclarativeRangeControls();
    this._unbindDeclarativeRangePairControls();
    this._unbindDeclarativeAxisPairControls();
    this._unbindDeclarativeScalarRandomizedControls();
    this._unbindDeclarativeStackOrderControls();
    this._unbindPathAppearanceControls();
    this._unbindFlipControls();
    this._unbindScaleControls();
    this._unbindRotationControls();
    this._unbindPathShadowControls();
    this._unbindPathFeatherControls();
    this._unbindOpacityFeatherControls();
    this._unbindPlacementControls();
    this._unbindToolSectionControls();
    this._unbindShortcutsControls();
    if (this._customToggleBindings?.size) {
      for (const [toggle, handler] of this._customToggleBindings.entries()) {
        try { toggle.removeEventListener('change', handler); } catch (_) {}
      }
      this._customToggleBindings.clear();
    }
    this._unbindPlaceAsControls();
  }

  _handleResettableContext(event) {
    if (!event || event.defaultPrevented) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const input = target.closest('input[type="range"], input[type="number"]');
    if (!input || input.disabled) return;
    const defaultValue = input.dataset?.faNexusDefaultValue;
    if (defaultValue === undefined || defaultValue === null || defaultValue === '') return;
    event.preventDefault();
    event.stopPropagation();
    if (input.value !== String(defaultValue)) {
      input.value = String(defaultValue);
    }
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
  }

  _handleSliderWheel(event) {
    if (!event || event.defaultPrevented) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const slider = target.closest('input[type="range"]');
    if (!slider || slider.disabled) return;
    if (typeof slider.matches === 'function' && slider.matches('[data-fa-nexus-grid-snap-slider]')) return;
    if (event.ctrlKey) {
      const delta = Number(event.deltaY) || Number(event.deltaX) || 0;
      if (!delta) return;
      const min = Number(slider.min ?? 0);
      const max = Number(slider.max ?? 0);
      let step = Number(slider.step ?? 1);
      if (!Number.isFinite(step) || step <= 0) step = 1;
      const direction = delta < 0 ? 1 : -1;
      const current = Number(slider.value);
      const base = Number.isFinite(current) ? current : min;
      let next = base + (step * direction);
      const clampMin = Number.isFinite(min) ? min : 0;
      const clampMax = Number.isFinite(max) ? max : clampMin;
      next = Math.min(clampMax, Math.max(clampMin, next));
      const decimals = this._inferStepDecimals(step);
      if (decimals !== null) next = Number(next.toFixed(decimals));
      if (next !== base) {
        slider.value = String(next);
        try {
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {}
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const container = this._getScrollContainer();
    if (container) {
      const deltaY = Number(event.deltaY) || 0;
      const deltaX = Number(event.deltaX) || 0;
      if (deltaY) container.scrollTop += deltaY;
      if (deltaX) container.scrollLeft += deltaX;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  _handleGridSnapChange(event) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    target.indeterminate = false;
    const next = !!target.checked;
    const controller = this._controller;
    if (!controller?.requestGridSnapToggle) {
      this.setGridSnapEnabled(next);
      return;
    }
    try {
      const result = controller.requestGridSnapToggle(next);
      if (result?.then) {
        result.then((success) => {
          if (!success) target.checked = !!this._gridSnapEnabled;
        }).catch(() => {
          target.checked = !!this._gridSnapEnabled;
        });
      } else if (result === false) {
        target.checked = !!this._gridSnapEnabled;
      }
    } catch (_) {
      target.checked = !!this._gridSnapEnabled;
    }
  }

  _handleDropShadowChange(event) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const next = !!target.checked;
    const control = this._getPreparedDropShadowControl();
    const fallbackState = control?.toggle || this._getDropShadowLegacyToggleState();
    const handlerId = typeof control?.toggle?.handlerId === 'string' ? control.toggle.handlerId : '';
    const controller = this._controller;
    if (!controller) {
      target.checked = !!fallbackState.enabled;
      return;
    }
    try {
      const result = handlerId
        ? controller.invokeToolHandler?.(handlerId, next)
        : controller.requestDropShadowToggle?.(next);
      if (result?.then) {
        result.then((success) => {
          if (!success) target.checked = !!fallbackState.enabled;
        }).catch(() => {
          target.checked = !!fallbackState.enabled;
        });
      } else if (result === false) {
        target.checked = !!fallbackState.enabled;
      }
    } catch (_) {
      target.checked = !!fallbackState.enabled;
    }
  }

  setGridSnapEnabled(enabled) {
    const next = !!enabled;
    if (this._gridSnapEnabled === next) return;
    this._gridSnapEnabled = next;
    this._syncGridSnapControl();
  }

  setGridSnapAvailable(available) {
    const next = !!available;
    if (this._gridSnapAvailable === next) return;
    this._gridSnapAvailable = next;
    this._syncGridSnapControl();
  }

  _syncGridSnapControl() {
    const toggle = this._gridSnapToggle;
    if (!toggle) return;
    toggle.checked = !!this._gridSnapEnabled;
    const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
    const canToggle = this._gridSnapAvailable && (controllerAllows !== false);
    toggle.disabled = !canToggle;
    this._syncGridSnapResolutionControl();
  }

  _normalizeGridSnapSubdivision(value) {
    return normalizeGridSnapSubdivision(value);
  }

  _formatGridSnapResolutionDisplay(value) {
    return formatGridSnapSubdivisionLabel(value);
  }

  _syncGridSnapResolutionControl() {
    const root = this._gridSnapResolutionRoot;
    if (!root) return;
    const slider = this._gridSnapResolutionSlider;
    const display = this._gridSnapResolutionDisplay;
    const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
    const available = this._gridSnapAvailable && (controllerAllows !== false);
    root.classList.toggle('is-disabled', !available);
    if (slider) {
      slider.disabled = !available;
      slider.value = String(this._gridSnapSubdivisions);
      this._applyDefaultValue(slider, GRID_SNAP_SUBDIV_DEFAULT);
    }
    if (display) {
      const formattedValue = this._formatGridSnapResolutionDisplay(this._gridSnapSubdivisions);
      this._syncDisplayValue(display, {
        min: slider?.min,
        max: slider?.max,
        step: slider?.step,
        value: formattedValue,
        display: formattedValue,
        defaultValue: this._formatGridSnapResolutionDisplay(GRID_SNAP_SUBDIV_DEFAULT),
        disabled: !available
      }, { disabled: !available });
    }
  }

  _bindGridSnapResolutionControl() {
    const root = this.element?.querySelector('[data-fa-nexus-grid-snap-root]');
    if (!root) {
      this._unbindGridSnapResolutionControl();
      return;
    }
    this._gridSnapResolutionRoot = root;
    const slider = root.querySelector('[data-fa-nexus-grid-snap-slider]');
    this._gridSnapResolutionSlider = slider || null;
    this._gridSnapResolutionDisplay = root.querySelector('[data-fa-nexus-grid-snap-display]') || null;
    if (slider) {
      slider.value = String(this._gridSnapSubdivisions);
      slider.addEventListener('input', this._boundGridSnapResolutionInput);
      slider.addEventListener('change', this._boundGridSnapResolutionCommit);
    }
    this._bindDisplayInput(this._gridSnapResolutionDisplay, this._boundGridSnapResolutionInput, this._boundGridSnapResolutionCommit);
    this._syncGridSnapResolutionControl();
  }

  _unbindGridSnapResolutionControl() {
    if (this._gridSnapResolutionSlider) {
      try {
        this._gridSnapResolutionSlider.removeEventListener('input', this._boundGridSnapResolutionInput);
        this._gridSnapResolutionSlider.removeEventListener('change', this._boundGridSnapResolutionCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._gridSnapResolutionDisplay, this._boundGridSnapResolutionInput, this._boundGridSnapResolutionCommit);
    this._gridSnapResolutionSlider = null;
    this._gridSnapResolutionDisplay = null;
    this._gridSnapResolutionRoot = null;
  }

  _handleGridSnapResolutionInput(event, commit) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const value = this._normalizeGridSnapSubdivision(target.value);
    this._gridSnapSubdivisions = value;
    if (this._gridSnapResolutionDisplay) {
      const formattedValue = this._formatGridSnapResolutionDisplay(value);
      this._syncDisplayValue(this._gridSnapResolutionDisplay, {
        value: formattedValue,
        display: formattedValue,
        defaultValue: this._formatGridSnapResolutionDisplay(GRID_SNAP_SUBDIV_DEFAULT)
      });
    }
    if (!commit) return;
    const controller = this._controller;
    if (!controller?.requestGridSnapSubdivisionChange) return;
    try {
      const result = controller.requestGridSnapSubdivisionChange(value);
      if (result?.then) {
        result.catch(() => this._resetGridSnapResolutionControl());
      } else if (result === false) {
        this._resetGridSnapResolutionControl();
      }
    } catch (_) {
      this._resetGridSnapResolutionControl();
    }
  }

  _resetGridSnapResolutionControl() {
    const controllerValue = this._controller?.getGridSnapSubdivisions?.();
    if (controllerValue === undefined || controllerValue === null) return;
    this._gridSnapSubdivisions = this._normalizeGridSnapSubdivision(controllerValue);
    if (this._gridSnapResolutionSlider) {
      this._gridSnapResolutionSlider.value = String(this._gridSnapSubdivisions);
    }
    if (this._gridSnapResolutionDisplay) {
      const formattedValue = this._formatGridSnapResolutionDisplay(this._gridSnapSubdivisions);
      this._syncDisplayValue(this._gridSnapResolutionDisplay, {
        value: formattedValue,
        display: formattedValue,
        defaultValue: this._formatGridSnapResolutionDisplay(GRID_SNAP_SUBDIV_DEFAULT)
      });
    }
  }

  setGridSnapSubdivisions(value) {
    const normalized = this._normalizeGridSnapSubdivision(value);
    if (this._gridSnapSubdivisions === normalized) return;
    this._gridSnapSubdivisions = normalized;
    this._syncGridSnapResolutionControl();
  }

  _getPreparedDropShadowControl() {
    const controlId = String(
      this._dropShadowControlsWorkflow.controlId
      || this._dropShadowToggle?.getAttribute?.('data-fa-nexus-drop-shadow-toggle-input')
      || ''
    );
    if (!controlId) return null;
    const control = this._getPreparedDeclarativeControl(controlId);
    return control?.type === 'drop-shadow' ? control : null;
  }

  _getDropShadowLegacyToggleState() {
    const state = this._toolOptionState?.dropShadow;
    return state && typeof state === 'object' ? state : {};
  }

  _getDropShadowControlsState() {
    const control = this._getPreparedDropShadowControl();
    if (control?.controls && typeof control.controls === 'object') return control.controls;
    const state = this._toolOptionState?.dropShadowControls;
    return state && typeof state === 'object' ? state : null;
  }

  _syncDropShadowControl() {
    const toggle = this._dropShadowToggle;
    if (!toggle) return;
    const control = this._getPreparedDropShadowControl();
    const state = control?.toggle || this._getDropShadowLegacyToggleState();
    toggle.checked = !!state.enabled;
    toggle.disabled = !!state.disabled;
  }

  _bindDropShadowControls() {
    this._dropShadowControlsWorkflow.bind();
  }

  _unbindDropShadowControls() {
    this._dropShadowControlsWorkflow.unbind();
  }

  _syncDropShadowControls() {
    this._dropShadowControlsWorkflow.sync();
  }

  _invokeDropShadowHandlerAndSync(controller, handlerId, ...args) {
    const result = controller.invokeToolHandler(handlerId, ...args);
    if (result?.then) {
      result.catch(() => {}).finally(() => this._syncDropShadowControls());
    } else {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowOffsetMaxSlider(event, commit) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const control = this._getPreparedDropShadowControl();
    const rawMaxHandler = control?.controls?.offset?.offsetMaxHandlerId;
    const handlerId = (typeof rawMaxHandler === 'string' && rawMaxHandler.length)
      ? rawMaxHandler
      : (control ? '' : 'setDropShadowOffsetMax');
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      this._invokeDropShadowHandlerAndSync(controller, handlerId, target.value, !!commit);
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowSlider(event, key, commit) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.[key]?.handlerId === 'string'
      ? control.controls[key].handlerId
      : ({
          alpha: 'setDropShadowAlpha',
          dilation: 'setDropShadowDilation',
          blur: 'setDropShadowBlur'
        }[key] || '');
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      this._invokeDropShadowHandlerAndSync(controller, handlerId, target.value, !!commit);
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowCollapse(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.collapse?.handlerId === 'string'
      ? control.controls.collapse.handlerId
      : 'toggleDropShadowCollapsed';
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      this._invokeDropShadowHandlerAndSync(controller, handlerId);
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowEditToggle(event) {
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.edit?.handlerId === 'string'
      ? control.controls.edit.handlerId
      : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    const enabled = !!(event?.currentTarget?.checked ?? event?.target?.checked);
    try {
      this._invokeDropShadowHandlerAndSync(this._controller, handlerId, enabled);
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowEditReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.edit?.reset?.handlerId === 'string'
      ? control.controls.edit.reset.handlerId
      : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      this._invokeDropShadowHandlerAndSync(this._controller, handlerId);
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowOnlyToggle(event) {
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.shadowOnly?.handlerId === 'string'
      ? control.controls.shadowOnly.handlerId
      : 'setDropShadowOnly';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    const enabled = !!(event?.currentTarget?.checked ?? event?.target?.checked);
    try {
      this._invokeDropShadowHandlerAndSync(this._controller, handlerId, enabled);
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowPresetClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const index = Number(button.dataset.faNexusDropShadowPreset);
    if (!Number.isInteger(index)) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const save = !!(event?.shiftKey || event?.altKey || event?.metaKey);
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.presetHandlerId === 'string'
      ? control.controls.presetHandlerId
      : 'handleDropShadowPreset';
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      this._invokeDropShadowHandlerAndSync(controller, handlerId, index, save);
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowPresetContext(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const index = Number(button.dataset.faNexusDropShadowPreset);
    if (!Number.isInteger(index)) return;
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.presetHandlerId === 'string'
      ? control.controls.presetHandlerId
      : 'handleDropShadowPreset';
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      this._invokeDropShadowHandlerAndSync(controller, handlerId, index, true);
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.reset?.handlerId === 'string'
      ? control.controls.reset.handlerId
      : 'resetDropShadow';
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      this._invokeDropShadowHandlerAndSync(controller, handlerId);
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowOffsetContext(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.offset?.resetHandlerId === 'string'
      ? control.controls.offset.resetHandlerId
      : 'resetDropShadowOffset';
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      this._invokeDropShadowHandlerAndSync(controller, handlerId);
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowOffsetPointerDown(event) {
    this._dropShadowControlsWorkflow.handleOffsetPointerDown(event);
  }

  _handleDropShadowOffsetPointerMove(event) {
    this._dropShadowControlsWorkflow.handleOffsetPointerMove(event);
  }

  _handleDropShadowOffsetPointerUp(event) {
    this._dropShadowControlsWorkflow.handleOffsetPointerUp(event);
  }

  _releaseDropShadowOffsetPointer() {
    this._dropShadowControlsWorkflow.releaseOffsetPointer();
  }

  _updateDropShadowOffsetFromPointer(event, commit) {
    this._dropShadowControlsWorkflow.updateOffsetFromPointer(event, commit);
  }

  _positionDropShadowOffsetHandle(distance, angle, maxDistance) {
    this._dropShadowControlsWorkflow.positionOffsetHandle(distance, angle, maxDistance);
  }

  _bindDeclarativeSegmentedControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-segmented-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-segmented-control') || '');
      if (!controlId) continue;
      const optionRefs = new Map();
      const inputs = Array.from(root.querySelectorAll('[data-fa-nexus-segmented-input]'));
      for (const input of inputs) {
        const key = String(input.getAttribute('data-fa-nexus-segmented-input') || '');
        if (!key.startsWith(`${controlId}:`)) continue;
        const optionId = key.slice(controlId.length + 1);
        if (!optionId) continue;
        input.addEventListener('change', this._boundDeclarativeSegmentedChange);
        const optionRoot = input.closest('.fa-nexus-declarative-segmented__option') || null;
        optionRefs.set(optionId, {
          input,
          root: optionRoot,
          label: optionRoot?.querySelector('span') || null
        });
      }
      this._declarativeSegmentedControls.set(controlId, { root, optionRefs });
    }
    this._syncDeclarativeSegmentedControls();
  }

  _unbindDeclarativeSegmentedControls() {
    if (!this._declarativeSegmentedControls?.size) return;
    for (const { optionRefs } of this._declarativeSegmentedControls.values()) {
      for (const refs of optionRefs?.values?.() || []) {
        try { refs?.input?.removeEventListener('change', this._boundDeclarativeSegmentedChange); } catch (_) {}
      }
    }
    this._declarativeSegmentedControls.clear();
  }

  _syncDeclarativeSegmentedControls() {
    if (!this._declarativeSegmentedControls?.size) return;
    for (const [controlId, refs] of this._declarativeSegmentedControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'segmented' || !control.handlerId) {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      const stateMap = new Map();
      for (const option of Array.isArray(control.options) ? control.options : []) {
        if (!option?.id) continue;
        stateMap.set(option.id, option);
      }
      for (const [optionId, optionRefs] of refs.optionRefs.entries()) {
        const state = stateMap.get(optionId) || null;
        const optionRoot = optionRefs?.root || null;
        const input = optionRefs?.input || null;
        if (!state) {
          if (optionRoot) optionRoot.hidden = true;
          continue;
        }
        if (optionRoot) {
          optionRoot.hidden = false;
          optionRoot.classList.toggle('is-active', !!state.enabled);
          optionRoot.classList.toggle('is-disabled', !!state.disabled);
          if (state.tooltip) optionRoot.title = state.tooltip;
          else optionRoot.removeAttribute('title');
        }
        if (input) {
          input.checked = !!state.enabled;
          input.disabled = !!state.disabled;
          if (state.tooltip) input.title = state.tooltip;
          else input.removeAttribute('title');
        }
        if (optionRefs?.label && optionRefs.label.textContent !== state.label) {
          optionRefs.label.textContent = state.label;
        }
      }
    }
  }

  _handleDeclarativeSegmentedChange(event) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const key = String(input.getAttribute?.('data-fa-nexus-segmented-input') || '');
    const separator = key.indexOf(':');
    if (separator <= 0) return;
    const controlId = key.slice(0, separator);
    const optionId = key.slice(separator + 1);
    if (!controlId || !optionId) return;
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    if (!handlerId) return;
    if (control.inputType === 'radio' && !input.checked) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    const finalize = () => {
      this._syncDeclarativeSegmentedControls();
      this._syncEditorActions();
    };
    try {
      const result = control.inputType === 'checkbox'
        ? controller.invokeToolHandler(handlerId, optionId, !!input.checked)
        : controller.invokeToolHandler(handlerId, optionId);
      if (result?.then) {
        result.catch(() => {}).finally(finalize);
      } else {
        finalize();
      }
    } catch (_) {
      finalize();
    }
  }

  _bindEditorActions() {
    this._unbindEditorActions();
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-editor-actions-root]'));
    for (const [index, root] of roots.entries()) {
      const controlId = String(root.getAttribute('data-fa-nexus-editor-actions-root') || '');
      const rowKey = controlId || `__legacy__${index}`;
      if (!rowKey) continue;
      const buttons = Array.from(root.querySelectorAll('[data-fa-nexus-editor-action]'));
      const buttonMap = new Map();
      for (const button of buttons) {
        button.addEventListener('click', this._boundEditorActionClick);
        button.addEventListener('pointerenter', this._boundEditorActionPointerEnter);
        button.addEventListener('pointerleave', this._boundEditorActionPointerLeave);
        button.addEventListener('focus', this._boundEditorActionFocus);
        button.addEventListener('blur', this._boundEditorActionBlur);
        const id = button.dataset?.faNexusEditorAction || '';
        if (id) buttonMap.set(id, button);
      }
      this._declarativeActionRows.set(rowKey, {
        controlId,
        root,
        buttons,
        buttonMap
      });
    }
    this._syncEditorActions();
  }

  _unbindEditorActions() {
    if (this._declarativeActionRows?.size) {
      for (const { buttons } of this._declarativeActionRows.values()) {
        for (const button of buttons || []) {
          try { button.removeEventListener('click', this._boundEditorActionClick); }
          catch (_) {}
          try { button.removeEventListener('pointerenter', this._boundEditorActionPointerEnter); }
          catch (_) {}
          try { button.removeEventListener('pointerleave', this._boundEditorActionPointerLeave); }
          catch (_) {}
          try { button.removeEventListener('focus', this._boundEditorActionFocus); }
          catch (_) {}
          try { button.removeEventListener('blur', this._boundEditorActionBlur); }
          catch (_) {}
        }
      }
      this._declarativeActionRows.clear();
    }
  }

  _syncEditorActions() {
    if (!this._declarativeActionRows?.size) return;
    for (const refs of this._declarativeActionRows.values()) {
      const controlId = String(refs?.controlId || '');
      const control = controlId ? this._getPreparedDeclarativeControl(controlId) : null;
      const root = refs?.root || null;
      if (!root) continue;
      const actions = controlId
        ? (control?.type === 'action-row' && Array.isArray(control.actions) ? control.actions : [])
        : (Array.isArray(this._toolOptionState?.editorActions) ? this._toolOptionState.editorActions : []);
      if (!actions.length) {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      const stateMap = new Map();
      for (const entry of actions) {
        const id = String(entry?.id || '');
        if (!id) continue;
        stateMap.set(id, {
          id,
          label: String(entry?.label || ''),
          tooltip: String(entry?.tooltip || ''),
          primary: !!entry?.primary,
          disabled: !!entry?.disabled
        });
      }
      for (const button of refs.buttons || []) {
        const id = button.dataset?.faNexusEditorAction || '';
        const actionState = stateMap.get(id);
        if (!actionState) {
          button.hidden = true;
          continue;
        }
        button.hidden = false;
        button.disabled = !!actionState.disabled;
        button.classList.toggle('is-primary', !!actionState.primary);
        if (actionState.tooltip) button.title = actionState.tooltip;
        else button.removeAttribute('title');
        const labelEl = button.querySelector('span');
        if (labelEl && actionState.label && labelEl.textContent !== actionState.label) {
          labelEl.textContent = actionState.label;
        }
      }
    }
  }

  _handleEditorActionClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const id = button.dataset?.faNexusEditorAction;
    if (!id) return;
    const controlId = button.closest?.('[data-fa-nexus-editor-actions-root]')?.getAttribute?.('data-fa-nexus-editor-actions-root') || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' && control.handlerId.length
      ? control.handlerId
      : 'handleEditorAction';
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler(handlerId, id);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncEditorActions());
      } else {
        this._syncEditorActions();
      }
    } catch (_) {
      this._syncEditorActions();
    }
  }

  _handleEditorActionPreview(event, phase) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const id = button.dataset?.faNexusEditorAction;
    if (!id || button.disabled) return;
    const controlId = button.closest?.('[data-fa-nexus-editor-actions-root]')?.getAttribute?.('data-fa-nexus-editor-actions-root') || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.previewHandlerId === 'string' ? control.previewHandlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId, id, phase);
      if (result?.then) result.catch(() => {});
    } catch (_) {}
  }

  _getDeclarativeControlRuntime() {
    if (!this._declarativeControlRuntime) {
      this._declarativeControlRuntime = new DeclarativeControlRuntime(this);
    }
    return this._declarativeControlRuntime;
  }

  _getPortalControlRuntime() {
    if (!this._portalControlRuntime) {
      this._portalControlRuntime = new PortalControlRuntime(this);
    }
    return this._portalControlRuntime;
  }

  _bindDeclarativeToggleControls() {
    this._getDeclarativeControlRuntime().bindToggleControls();
  }

  _unbindDeclarativeToggleControls() {
    this._declarativeControlRuntime?.unbindToggleControls();
  }

  _syncDeclarativeToggleControls() {
    this._declarativeControlRuntime?.syncToggleControls();
  }

  _handleDeclarativeToggleChange(event) {
    this._getDeclarativeControlRuntime().handleToggleChange(event);
  }

  _bindDeclarativeSelectControls() {
    this._getDeclarativeControlRuntime().bindSelectControls();
  }

  _unbindDeclarativeSelectControls() {
    this._declarativeControlRuntime?.unbindSelectControls();
  }

  _syncDeclarativeSelectOptions(select, control) {
    this._getDeclarativeControlRuntime().syncSelectOptions(select, control);
  }

  _syncDeclarativeSelectControls() {
    this._declarativeControlRuntime?.syncSelectControls();
  }

  _handleDeclarativeSelectChange(event) {
    this._getDeclarativeControlRuntime().handleSelectChange(event);
  }

  _getPreparedDeclarativeControl(controlId) {
    const id = String(controlId || '');
    if (!id) return null;
    const normalized = this._activeNormalizedOptions
      || (this._activeTool?.id ? this._controller?._getToolNormalized?.(this._activeTool.id) || null : null);
    const controls = normalized?.controls && typeof normalized.controls === 'object'
      ? normalized.controls
      : {};
    return this._prepareDeclarativeControl(controls[id]);
  }

  _bindDeclarativeRangeControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-range-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-range-control') || '');
      if (!controlId) continue;
      const slider = root.querySelector(`[data-fa-nexus-range-slider="${controlId}"]`);
      const display = root.querySelector(`[data-fa-nexus-range-display="${controlId}"]`);
      const toggle = root.querySelector(`[data-fa-nexus-range-toggle="${controlId}"]`);
      if (slider) {
        slider.addEventListener('input', this._boundDeclarativeRangeInput);
        slider.addEventListener('change', this._boundDeclarativeRangeCommit);
      }
      if (toggle) {
        toggle.addEventListener('change', this._boundDeclarativeRangeToggle);
      }
      this._bindDisplayInput(display, this._boundDeclarativeRangeInput, this._boundDeclarativeRangeCommit);
      this._declarativeRangeControls.set(controlId, {
        root,
        slider,
        display,
        label: root.querySelector('[data-fa-nexus-range-label]') || null,
        toggle,
        toggleLabel: root.querySelector('[data-fa-nexus-range-toggle-label]') || null,
        hint: root.querySelector('[data-fa-nexus-range-hint]') || null
      });
    }
    this._syncDeclarativeRangeControls();
  }

  _unbindDeclarativeRangeControls() {
    if (this._declarativeRangeControls?.size) {
      for (const { slider, display, toggle } of this._declarativeRangeControls.values()) {
        if (slider) {
          try {
            slider.removeEventListener('input', this._boundDeclarativeRangeInput);
            slider.removeEventListener('change', this._boundDeclarativeRangeCommit);
          } catch (_) {}
        }
        if (toggle) {
          try { toggle.removeEventListener('change', this._boundDeclarativeRangeToggle); } catch (_) {}
        }
        this._unbindDisplayInput(display, this._boundDeclarativeRangeInput, this._boundDeclarativeRangeCommit);
      }
      this._declarativeRangeControls.clear();
    }
  }

  _syncDeclarativeRangeControls() {
    if (!this._declarativeRangeControls?.size) return;
    for (const [controlId, refs] of this._declarativeRangeControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'range') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      if (refs.label) {
        if (control.tooltip) refs.label.title = control.tooltip;
        else refs.label.removeAttribute('title');
      }
      if (refs.toggle) {
        const headerToggle = control.headerToggle && typeof control.headerToggle === 'object'
          ? control.headerToggle
          : null;
        if (headerToggle) {
          refs.toggle.checked = !!headerToggle.value;
          refs.toggle.disabled = !!headerToggle.disabled;
          if (headerToggle.tooltip) refs.toggle.title = headerToggle.tooltip;
          else refs.toggle.removeAttribute('title');
          if (headerToggle.ariaLabel) refs.toggle.setAttribute('aria-label', headerToggle.ariaLabel);
          else refs.toggle.removeAttribute('aria-label');
          if (refs.toggleLabel && refs.toggleLabel.textContent !== headerToggle.label) {
            refs.toggleLabel.textContent = headerToggle.label || '';
          }
        } else {
          refs.toggle.checked = false;
          refs.toggle.disabled = true;
          refs.toggle.removeAttribute('title');
          refs.toggle.removeAttribute('aria-label');
          if (refs.toggleLabel) refs.toggleLabel.textContent = '';
        }
      }
      if (control.tooltip) root.title = control.tooltip;
      else root.removeAttribute('title');
      if (refs.slider) {
        refs.slider.min = String(control.min);
        refs.slider.max = String(control.max);
        refs.slider.step = String(control.step);
        const nextValue = String(control.value);
        if (refs.slider.value !== nextValue) refs.slider.value = nextValue;
        refs.slider.disabled = !!control.disabled;
        if (control.ariaLabel) refs.slider.setAttribute('aria-label', control.ariaLabel);
        if (control.tooltip) refs.slider.title = control.tooltip;
        else refs.slider.removeAttribute('title');
        this._applyDefaultValue(refs.slider, control.defaultValue);
      }
      if (refs.display) {
        this._syncDisplayValue(refs.display, control);
      }
      if (refs.hint) {
        const text = control.hint || '';
        refs.hint.textContent = text;
        refs.hint.hidden = !text;
      }
    }
  }

  _handleDeclarativeRangeInput(event, commit) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-range-slider')
      || input.getAttribute?.('data-fa-nexus-range-display')
      || input.closest?.('[data-fa-nexus-range-control]')?.getAttribute?.('data-fa-nexus-range-control')
      || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    if (!handlerId) return;
    const hasHandlerArg = control?.handlerArg !== undefined;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    const value = this._readDeclarativeNumericValue(input, {
      controlId,
      commit,
      sync: this._syncDeclarativeRangeControls,
      logTag: 'ToolOptions.declarativeRange.invalidNumericInput'
    });
    if (value === null) return;
    try {
      const result = hasHandlerArg
        ? controller.invokeToolHandler(handlerId, control.handlerArg, value, !!commit)
        : controller.invokeToolHandler(handlerId, value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeRangeControls());
      } else {
        this._syncDeclarativeRangeControls();
      }
    } catch (_) {
      this._syncDeclarativeRangeControls();
    }
  }

  _handleDeclarativeRangeToggle(event) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-range-toggle')
      || input.closest?.('[data-fa-nexus-range-control]')?.getAttribute?.('data-fa-nexus-range-control')
      || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const headerToggle = control?.headerToggle && typeof control.headerToggle === 'object'
      ? control.headerToggle
      : null;
    const handlerId = typeof headerToggle?.handlerId === 'string' ? headerToggle.handlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    const hasHandlerArg = headerToggle?.handlerArg !== undefined;
    try {
      const result = hasHandlerArg
        ? this._controller.invokeToolHandler(handlerId, headerToggle.handlerArg, !!input.checked)
        : this._controller.invokeToolHandler(handlerId, !!input.checked);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeRangeControls());
      } else {
        this._syncDeclarativeRangeControls();
      }
    } catch (_) {
      this._syncDeclarativeRangeControls();
    }
  }

  _bindDeclarativeRangePairControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-range-pair-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-range-pair-control') || '');
      if (!controlId) continue;
      const itemRoots = new Map();
      const rows = Array.from(root.querySelectorAll('[data-fa-nexus-range-pair-item]'));
      for (const row of rows) {
        const itemId = String(row.getAttribute('data-fa-nexus-range-pair-item') || '');
        if (!itemId) continue;
        const slider = row.querySelector(`[data-fa-nexus-range-pair-slider="${controlId}:${itemId}"]`);
        const display = row.querySelector(`[data-fa-nexus-range-pair-display="${controlId}:${itemId}"]`);
        if (slider) {
          slider.addEventListener('input', this._boundDeclarativeRangePairInput);
          slider.addEventListener('change', this._boundDeclarativeRangePairCommit);
        }
        this._bindDisplayInput(display, this._boundDeclarativeRangePairInput, this._boundDeclarativeRangePairCommit);
        itemRoots.set(itemId, {
          row,
          slider,
          display
        });
      }
      this._declarativeRangePairControls.set(controlId, {
        root,
        label: root.querySelector('[data-fa-nexus-range-pair-label]') || null,
        hint: root.querySelector('[data-fa-nexus-range-pair-hint]') || null,
        items: itemRoots
      });
    }
    this._syncDeclarativeRangePairControls();
  }

  _unbindDeclarativeRangePairControls() {
    if (this._declarativeRangePairControls?.size) {
      for (const { items } of this._declarativeRangePairControls.values()) {
        for (const { slider, display } of items.values()) {
          if (slider) {
            try {
              slider.removeEventListener('input', this._boundDeclarativeRangePairInput);
              slider.removeEventListener('change', this._boundDeclarativeRangePairCommit);
            } catch (_) {}
          }
          this._unbindDisplayInput(display, this._boundDeclarativeRangePairInput, this._boundDeclarativeRangePairCommit);
        }
      }
      this._declarativeRangePairControls.clear();
    }
  }

  _syncDeclarativeRangePairControls() {
    if (!this._declarativeRangePairControls?.size) return;
    for (const [controlId, refs] of this._declarativeRangePairControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'range-pair') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      const itemMap = new Map(Array.isArray(control.items) ? control.items.map((item) => [item.id, item]) : []);
      for (const [itemId, itemRefs] of refs.items.entries()) {
        const item = itemMap.get(itemId) || null;
        const row = itemRefs?.row || null;
        if (!row) continue;
        if (!item) {
          row.hidden = true;
          continue;
        }
        row.hidden = false;
        if (itemRefs.slider) {
          itemRefs.slider.min = String(item.min);
          itemRefs.slider.max = String(item.max);
          itemRefs.slider.step = String(item.step);
          const nextValue = String(item.value);
          if (itemRefs.slider.value !== nextValue) itemRefs.slider.value = nextValue;
          itemRefs.slider.disabled = !!item.disabled;
          if (item.ariaLabel) itemRefs.slider.setAttribute('aria-label', item.ariaLabel);
          this._applyDefaultValue(itemRefs.slider, item.defaultValue);
        }
        if (itemRefs.display) {
          this._syncDisplayValue(itemRefs.display, item);
        }
      }
      if (refs.hint) {
        const text = control.hint || '';
        refs.hint.textContent = text;
        refs.hint.hidden = !text;
      }
    }
  }

  _handleDeclarativeRangePairInput(event, commit) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlKey = input.getAttribute?.('data-fa-nexus-range-pair-slider')
      || input.getAttribute?.('data-fa-nexus-range-pair-display')
      || '';
    const [controlId, itemId] = String(controlKey || '').split(':');
    if (!controlId || !itemId) return;
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    const item = Array.isArray(control?.items) ? control.items.find((entry) => entry.id === itemId) || null : null;
    if (!handlerId || !item) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    const value = this._readDeclarativeNumericValue(input, {
      controlId: `${controlId}:${itemId}`,
      commit,
      sync: this._syncDeclarativeRangePairControls,
      logTag: 'ToolOptions.declarativeRangePair.invalidNumericInput'
    });
    if (value === null) return;
    try {
      const result = controller.invokeToolHandler(handlerId, item.handlerArg, value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeRangePairControls());
      } else {
        this._syncDeclarativeRangePairControls();
      }
    } catch (_) {
      this._syncDeclarativeRangePairControls();
    }
  }

  _bindDeclarativeAxisPairControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-axis-pair-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-axis-pair-control') || '');
      if (!controlId) continue;
      const axes = new Map();
      const rows = Array.from(root.querySelectorAll('[data-fa-nexus-axis-pair-axis]'));
      for (const row of rows) {
        const axisKey = String(row.getAttribute('data-fa-nexus-axis-pair-axis') || '');
        const [rowControlId, axisId] = axisKey.split(':');
        if (rowControlId !== controlId || !axisId) continue;
        const button = row.querySelector(`[data-fa-nexus-axis-pair-button="${controlId}:${axisId}"]`);
        const randomButton = row.querySelector(`[data-fa-nexus-axis-pair-random="${controlId}:${axisId}"]`);
        if (button) button.addEventListener('click', this._boundDeclarativeAxisPairToggle);
        if (randomButton) randomButton.addEventListener('click', this._boundDeclarativeAxisPairRandomToggle);
        axes.set(axisId, {
          row,
          button,
          randomButton
        });
      }
      this._declarativeAxisPairControls.set(controlId, {
        root,
        label: root.querySelector('[data-fa-nexus-axis-pair-label]') || null,
        display: root.querySelector('[data-fa-nexus-axis-pair-display]') || null,
        preview: root.querySelector('[data-fa-nexus-axis-pair-preview]') || null,
        hint: root.querySelector('[data-fa-nexus-axis-pair-hint]') || null,
        axes
      });
    }
    this._syncDeclarativeAxisPairControls();
  }

  _unbindDeclarativeAxisPairControls() {
    if (this._declarativeAxisPairControls?.size) {
      for (const { axes } of this._declarativeAxisPairControls.values()) {
        for (const { button, randomButton } of axes.values()) {
          if (button) {
            try { button.removeEventListener('click', this._boundDeclarativeAxisPairToggle); } catch (_) {}
          }
          if (randomButton) {
            try { randomButton.removeEventListener('click', this._boundDeclarativeAxisPairRandomToggle); } catch (_) {}
          }
        }
      }
      this._declarativeAxisPairControls.clear();
    }
  }

  _syncDeclarativeAxisPairControls() {
    if (!this._declarativeAxisPairControls?.size) return;
    for (const [controlId, refs] of this._declarativeAxisPairControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'axis-toggle-pair') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      if (refs.display) {
        const text = control.display || 'None';
        if (refs.display.textContent !== text) refs.display.textContent = text;
      }
      if (refs.preview) {
        const preview = control.previewDisplay || '';
        refs.preview.textContent = preview;
        refs.preview.hidden = !preview;
      }
      if (refs.hint) {
        const text = control.hint || '';
        refs.hint.textContent = text;
        refs.hint.hidden = !text;
      }
      const axisMap = new Map(Array.isArray(control.axes) ? control.axes.map((axis) => [axis.id, axis]) : []);
      const syncAxisButton = (button, axisState) => {
        if (!button || !axisState) return;
        const active = !!axisState.active;
        const previewDiff = !!axisState.previewDiff;
        button.classList.toggle('is-active', active);
        button.classList.toggle('has-preview-diff', previewDiff);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.setAttribute('aria-label', axisState.aria || axisState.label || 'Toggle');
        if (axisState.tooltip) button.title = axisState.tooltip;
        else button.removeAttribute('title');
        button.disabled = !!axisState.disabled || !axisState.handlerId;
        const label = button.querySelector('[data-fa-nexus-button-label]')
          || Array.from(button.querySelectorAll('span')).find((span) => !span.classList.contains('fa-nexus-flip__button-icon'))
          || null;
        if (label && label.textContent !== axisState.label) label.textContent = axisState.label;
      };
      const syncAxisRandomButton = (button, axisState) => {
        if (!button || !axisState) return;
        const visible = !!axisState.randomButtonVisible;
        button.hidden = !visible;
        if (!visible) return;
        const enabled = !!axisState.randomEnabled;
        button.classList.toggle('is-active', enabled);
        button.classList.toggle('has-preview-diff', !!axisState.randomPreviewDiff);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.setAttribute('aria-label', axisState.randomAria || 'Toggle random');
        if (axisState.randomTooltip) button.title = axisState.randomTooltip;
        else button.removeAttribute('title');
        button.disabled = !!axisState.randomDisabled || !axisState.randomHandlerId;
        const label = button.querySelector('span');
        const nextLabel = axisState.randomLabel || 'Random';
        if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
      };
      for (const [axisId, axisRefs] of refs.axes.entries()) {
        const axisState = axisMap.get(axisId) || null;
        const row = axisRefs?.row || null;
        if (!row) continue;
        if (!axisState) {
          row.hidden = true;
          continue;
        }
        row.hidden = false;
        syncAxisButton(axisRefs.button, axisState);
        syncAxisRandomButton(axisRefs.randomButton, axisState);
      }
    }
  }

  _handleDeclarativeAxisPairToggle(event, random = false) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const axisKey = random
      ? target.getAttribute?.('data-fa-nexus-axis-pair-random')
      : target.getAttribute?.('data-fa-nexus-axis-pair-button');
    const [controlId, axisId] = String(axisKey || '').split(':');
    if (!controlId || !axisId) return;
    const control = this._getPreparedDeclarativeControl(controlId);
    const axis = Array.isArray(control?.axes) ? control.axes.find((entry) => entry.id === axisId) || null : null;
    const handlerId = random ? axis?.randomHandlerId : axis?.handlerId;
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeAxisPairControls());
      } else {
        this._syncDeclarativeAxisPairControls();
      }
    } catch (_) {
      this._syncDeclarativeAxisPairControls();
    }
  }

  _bindDeclarativeScalarRandomizedControls() {
    this._getDeclarativeControlRuntime().bindScalarRandomizedControls();
  }

  _unbindDeclarativeScalarRandomizedControls() {
    this._declarativeControlRuntime?.unbindScalarRandomizedControls();
  }

  _syncDeclarativeScalarRandomizedRangeShell(shell, control) {
    this._getDeclarativeControlRuntime().syncScalarRandomizedRangeShell(shell, control);
  }

  _syncDeclarativeScalarRandomizedControls() {
    this._declarativeControlRuntime?.syncScalarRandomizedControls();
  }

  _handleDeclarativeScalarRandomizedInput(event, commit) {
    this._getDeclarativeControlRuntime().handleScalarRandomizedInput(event, commit);
  }

  _handleDeclarativeScalarRandomizedStrength(event) {
    this._getDeclarativeControlRuntime().handleScalarRandomizedStrength(event);
  }

  _handleDeclarativeScalarRandomizedRange(event, boundary) {
    this._getDeclarativeControlRuntime().handleScalarRandomizedRange(event, boundary);
  }

  _handleDeclarativeScalarRandomizedRandom(event) {
    this._getDeclarativeControlRuntime().handleScalarRandomizedRandom(event);
  }

  _bindDeclarativeStackOrderControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-stack-order-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-stack-order-control') || '');
      if (!controlId) continue;
      const raiseButton = root.querySelector(`[data-fa-nexus-stack-order-raise="${controlId}"]`);
      const lowerButton = root.querySelector(`[data-fa-nexus-stack-order-lower="${controlId}"]`);
      const topButton = root.querySelector(`[data-fa-nexus-stack-order-top="${controlId}"]`);
      const bottomButton = root.querySelector(`[data-fa-nexus-stack-order-bottom="${controlId}"]`);
      if (raiseButton) raiseButton.addEventListener('click', this._boundDeclarativeStackOrderRaise);
      if (lowerButton) lowerButton.addEventListener('click', this._boundDeclarativeStackOrderLower);
      if (topButton) topButton.addEventListener('click', this._boundDeclarativeStackOrderTop);
      if (bottomButton) bottomButton.addEventListener('click', this._boundDeclarativeStackOrderBottom);
      this._declarativeStackOrderControls.set(controlId, {
        root,
        label: root.querySelector('[data-fa-nexus-stack-order-label]') || null,
        orderValue: root.querySelector('[data-fa-nexus-stack-order-value]') || null,
        elevationValue: root.querySelector('[data-fa-nexus-stack-order-elevation]') || null,
        raiseButton,
        lowerButton,
        topButton,
        bottomButton,
        hint: root.querySelector('[data-fa-nexus-stack-order-hint]') || null
      });
    }
    this._syncDeclarativeStackOrderControls();
  }

  _unbindDeclarativeStackOrderControls() {
    if (this._declarativeStackOrderControls?.size) {
      for (const { raiseButton, lowerButton, topButton, bottomButton } of this._declarativeStackOrderControls.values()) {
        if (raiseButton) {
          try { raiseButton.removeEventListener('click', this._boundDeclarativeStackOrderRaise); } catch (_) {}
        }
        if (lowerButton) {
          try { lowerButton.removeEventListener('click', this._boundDeclarativeStackOrderLower); } catch (_) {}
        }
        if (topButton) {
          try { topButton.removeEventListener('click', this._boundDeclarativeStackOrderTop); } catch (_) {}
        }
        if (bottomButton) {
          try { bottomButton.removeEventListener('click', this._boundDeclarativeStackOrderBottom); } catch (_) {}
        }
      }
      this._declarativeStackOrderControls.clear();
    }
  }

  _syncDeclarativeStackOrderControls() {
    if (!this._declarativeStackOrderControls?.size) return;
    for (const [controlId, refs] of this._declarativeStackOrderControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'stack-order') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      if (refs.orderValue) {
        const text = control.orderLabel || '';
        refs.orderValue.textContent = text;
        refs.orderValue.hidden = !text;
      }
      if (refs.elevationValue) {
        const text = control.elevationLabel || '';
        refs.elevationValue.textContent = text;
        refs.elevationValue.hidden = !text;
      }
      if (refs.raiseButton) {
        refs.raiseButton.disabled = !!control.raiseDisabled || !control.raiseHandlerId;
        const label = refs.raiseButton.querySelector('span');
        if (label && label.textContent !== control.raiseLabel) label.textContent = control.raiseLabel;
      }
      if (refs.lowerButton) {
        refs.lowerButton.disabled = !!control.lowerDisabled || !control.lowerHandlerId;
        const label = refs.lowerButton.querySelector('span');
        if (label && label.textContent !== control.lowerLabel) label.textContent = control.lowerLabel;
      }
      if (refs.topButton) {
        refs.topButton.disabled = !!control.pushTopDisabled || !control.pushTopHandlerId;
        const label = refs.topButton.querySelector('span');
        if (label && label.textContent !== control.pushTopLabel) label.textContent = control.pushTopLabel;
      }
      if (refs.bottomButton) {
        refs.bottomButton.disabled = !!control.pushBottomDisabled || !control.pushBottomHandlerId;
        const label = refs.bottomButton.querySelector('span');
        if (label && label.textContent !== control.pushBottomLabel) label.textContent = control.pushBottomLabel;
      }
      if (refs.hint) {
        const text = control.hint || '';
        refs.hint.textContent = text;
        refs.hint.hidden = !text;
      }
    }
  }

  _handleDeclarativeStackOrderAction(event, direction = 'top') {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const attribute = {
      raise: 'data-fa-nexus-stack-order-raise',
      lower: 'data-fa-nexus-stack-order-lower',
      bottom: 'data-fa-nexus-stack-order-bottom',
      top: 'data-fa-nexus-stack-order-top'
    }[direction] || 'data-fa-nexus-stack-order-top';
    const controlId = String(target.getAttribute?.(attribute) || '');
    if (!controlId) return;
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = {
      raise: control?.raiseHandlerId,
      lower: control?.lowerHandlerId,
      bottom: control?.pushBottomHandlerId,
      top: control?.pushTopHandlerId
    }[direction];
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeStackOrderControls());
      } else {
        this._syncDeclarativeStackOrderControls();
      }
    } catch (_) {
      this._syncDeclarativeStackOrderControls();
    }
  }

  _bindPathAppearanceControls() {
    this._bindPathOpacityControl();
    this._bindPathScaleControl();
    this._bindPathOffsetControls();
    this._bindPathTensionControls();
    this._bindPathSimplifyControls();
    this._bindShowWidthTangentsControls();
    this._syncPathAppearanceControls();
  }

  _unbindPathAppearanceControls() {
    this._unbindPathOpacityControl();
    this._unbindPathScaleControl();
    this._unbindPathOffsetControls();
    this._unbindPathTensionControls();
    this._unbindPathSimplifyControls();
    this._unbindShowWidthTangentsControls();
  }

  _syncPathAppearanceControls() {
    this._syncPathOpacityControl();
    this._syncPathScaleControl();
    this._syncPathOffsetControls();
    this._syncPathTensionControls();
    this._syncPathSimplifyControls();
    this._syncShowWidthTangentsControls();
  }

  _bindPathOpacityControl() {
    const root = this.element?.querySelector('[data-fa-nexus-path-opacity-root]') || null;
    if (!root) {
      this._unbindPathOpacityControl();
      return;
    }
    this._pathOpacityRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-opacity]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathOpacityInput);
      slider.addEventListener('change', this._boundPathOpacityCommit);
    }
    this._pathOpacitySlider = slider;
    this._pathOpacityDisplay = root.querySelector('[data-fa-nexus-path-opacity-display]') || null;
    this._bindDisplayInput(this._pathOpacityDisplay, this._boundPathOpacityInput, this._boundPathOpacityCommit);
  }

  _unbindPathOpacityControl() {
    if (this._pathOpacitySlider) {
      try { this._pathOpacitySlider.removeEventListener('input', this._boundPathOpacityInput); } catch (_) {}
      try { this._pathOpacitySlider.removeEventListener('change', this._boundPathOpacityCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathOpacityDisplay, this._boundPathOpacityInput, this._boundPathOpacityCommit);
    this._pathOpacityRoot = null;
    this._pathOpacitySlider = null;
    this._pathOpacityDisplay = null;
  }

  _syncPathOpacityControl() {
    if (!this._pathOpacityRoot) return;
    const state = this._toolOptionState?.pathAppearance?.layerOpacity || { available: false };
    if (!state.available) {
      this._pathOpacityRoot.hidden = true;
      return;
    }
    this._pathOpacityRoot.hidden = false;
    if (this._pathOpacitySlider) {
      if (state.min !== undefined) this._pathOpacitySlider.min = String(state.min);
      if (state.max !== undefined) this._pathOpacitySlider.max = String(state.max);
      if (state.step !== undefined) this._pathOpacitySlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathOpacitySlider.value !== next) this._pathOpacitySlider.value = next;
      }
      this._applyDefaultValue(this._pathOpacitySlider, state.defaultValue);
      this._pathOpacitySlider.disabled = !!state.disabled;
    }
    if (this._pathOpacityDisplay) {
      this._syncDisplayValue(this._pathOpacityDisplay, state);
    }
  }

  _handlePathOpacity(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = this._readNumericControlValue(slider);
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    if (value === null) {
      this._syncPathOpacityControl();
      return;
    }
    try {
      const result = controller.invokeToolHandler('setLayerOpacity', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathOpacityControl());
      else this._syncPathOpacityControl();
    } catch (_) {
      this._syncPathOpacityControl();
    }
  }

  _bindPathScaleControl() {
    const root = this.element?.querySelector('[data-fa-nexus-path-scale-root]') || null;
    if (!root) {
      this._unbindPathScaleControl();
      return;
    }
    this._pathScaleRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-scale]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathScaleInput);
      slider.addEventListener('change', this._boundPathScaleCommit);
    }
    this._pathScaleSlider = slider;
    this._pathScaleDisplay = root.querySelector('[data-fa-nexus-path-scale-display]') || null;
    this._bindDisplayInput(this._pathScaleDisplay, this._boundPathScaleInput, this._boundPathScaleCommit);
  }

  _unbindPathScaleControl() {
    if (this._pathScaleSlider) {
      try { this._pathScaleSlider.removeEventListener('input', this._boundPathScaleInput); } catch (_) {}
      try { this._pathScaleSlider.removeEventListener('change', this._boundPathScaleCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathScaleDisplay, this._boundPathScaleInput, this._boundPathScaleCommit);
    this._pathScaleRoot = null;
    this._pathScaleSlider = null;
    this._pathScaleDisplay = null;
  }

  _syncPathScaleControl() {
    if (!this._pathScaleRoot) return;
    const state = this._toolOptionState?.pathAppearance?.scale || { available: false };
    if (!state.available) {
      this._pathScaleRoot.hidden = true;
      return;
    }
    this._pathScaleRoot.hidden = false;
    if (this._pathScaleSlider) {
      if (state.min !== undefined) this._pathScaleSlider.min = String(state.min);
      if (state.max !== undefined) this._pathScaleSlider.max = String(state.max);
      if (state.step !== undefined) this._pathScaleSlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathScaleSlider.value !== next) this._pathScaleSlider.value = next;
      }
      this._applyDefaultValue(this._pathScaleSlider, state.defaultValue);
      this._pathScaleSlider.disabled = !!state.disabled;
    }
    if (this._pathScaleDisplay) {
      this._syncDisplayValue(this._pathScaleDisplay, state);
    }
  }

  _handlePathScale(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = this._readNumericControlValue(slider);
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    if (value === null) {
      this._syncPathScaleControl();
      return;
    }
    try {
      const result = controller.invokeToolHandler('setPathScale', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathScaleControl());
      else this._syncPathScaleControl();
    } catch (_) {
      this._syncPathScaleControl();
    }
  }

  _handlePathScaleWheel(event) {
    if (!event) return;
    const slider = event.currentTarget || this._pathScaleSlider;
    if (!slider || slider.disabled) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    const state = this._toolOptionState?.pathAppearance?.scale || {};
    const min = Number(slider.min ?? state.min ?? 0);
    const max = Number(slider.max ?? state.max ?? 0);
    const rawStep = Number(slider.step ?? state.step ?? 1);
    const baseStep = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 1;
    const fine = event.ctrlKey || event.metaKey;
    const coarse = event.shiftKey;
    const step = Math.max(0.01, (fine ? baseStep / 10 : baseStep) * (coarse ? 5 : 1));
    const current = Number(slider.value);
    const safeCurrent = Number.isFinite(current) ? current : Number(state.value ?? min) || min;
    const direction = event.deltaY < 0 ? 1 : -1;
    const clamp = (val, lo, hi) => Math.min(hi, Math.max(lo, val));
    const nextValue = clamp(Math.round((safeCurrent + (direction * step)) * 100) / 100, Number.isFinite(min) ? min : safeCurrent, Number.isFinite(max) && max > 0 ? max : safeCurrent);
    slider.value = String(nextValue);
    this._handlePathScale({ currentTarget: slider }, true);
  }

  _bindPathOffsetControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-offset-root]') || null;
    if (!root) {
      this._unbindPathOffsetControls();
      return;
    }
    this._pathOffsetRoot = root;
    const xSlider = root.querySelector('[data-fa-nexus-path-offset-x]') || null;
    if (xSlider) {
      xSlider.addEventListener('input', this._boundPathOffsetXInput);
      xSlider.addEventListener('change', this._boundPathOffsetXCommit);
    }
    this._pathOffsetXSlider = xSlider;
    const ySlider = root.querySelector('[data-fa-nexus-path-offset-y]') || null;
    if (ySlider) {
      ySlider.addEventListener('input', this._boundPathOffsetYInput);
      ySlider.addEventListener('change', this._boundPathOffsetYCommit);
    }
    this._pathOffsetYSlider = ySlider;
    this._pathOffsetXDisplay = root.querySelector('[data-fa-nexus-path-offset-x-display]') || null;
    this._pathOffsetYDisplay = root.querySelector('[data-fa-nexus-path-offset-y-display]') || null;
    this._bindDisplayInput(this._pathOffsetXDisplay, this._boundPathOffsetXInput, this._boundPathOffsetXCommit);
    this._bindDisplayInput(this._pathOffsetYDisplay, this._boundPathOffsetYInput, this._boundPathOffsetYCommit);
  }

  _unbindPathOffsetControls() {
    if (this._pathOffsetXSlider) {
      try { this._pathOffsetXSlider.removeEventListener('input', this._boundPathOffsetXInput); } catch (_) {}
      try { this._pathOffsetXSlider.removeEventListener('change', this._boundPathOffsetXCommit); } catch (_) {}
    }
    if (this._pathOffsetYSlider) {
      try { this._pathOffsetYSlider.removeEventListener('input', this._boundPathOffsetYInput); } catch (_) {}
      try { this._pathOffsetYSlider.removeEventListener('change', this._boundPathOffsetYCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathOffsetXDisplay, this._boundPathOffsetXInput, this._boundPathOffsetXCommit);
    this._unbindDisplayInput(this._pathOffsetYDisplay, this._boundPathOffsetYInput, this._boundPathOffsetYCommit);
    this._pathOffsetRoot = null;
    this._pathOffsetXSlider = null;
    this._pathOffsetYSlider = null;
    this._pathOffsetXDisplay = null;
    this._pathOffsetYDisplay = null;
  }

  _syncPathOffsetControls() {
    if (!this._pathOffsetRoot) return;
    const state = this._toolOptionState?.pathAppearance?.textureOffset || { available: false };
    if (!state.available) {
      this._pathOffsetRoot.hidden = true;
      return;
    }
    this._pathOffsetRoot.hidden = false;
    if (this._pathOffsetXSlider) {
      const x = state.x || {};
      if (x.min !== undefined) this._pathOffsetXSlider.min = String(x.min);
      if (x.max !== undefined) this._pathOffsetXSlider.max = String(x.max);
      if (x.step !== undefined) this._pathOffsetXSlider.step = String(x.step);
      if (x.value !== undefined) {
        const next = String(x.value);
        if (this._pathOffsetXSlider.value !== next) this._pathOffsetXSlider.value = next;
      }
      this._applyDefaultValue(this._pathOffsetXSlider, x.defaultValue);
      this._pathOffsetXSlider.disabled = !!x.disabled || !!state.disabled;
    }
    if (this._pathOffsetYSlider) {
      const y = state.y || {};
      if (y.min !== undefined) this._pathOffsetYSlider.min = String(y.min);
      if (y.max !== undefined) this._pathOffsetYSlider.max = String(y.max);
      if (y.step !== undefined) this._pathOffsetYSlider.step = String(y.step);
      if (y.value !== undefined) {
        const next = String(y.value);
        if (this._pathOffsetYSlider.value !== next) this._pathOffsetYSlider.value = next;
      }
      this._applyDefaultValue(this._pathOffsetYSlider, y.defaultValue);
      this._pathOffsetYSlider.disabled = !!y.disabled || !!state.disabled;
    }
    if (this._pathOffsetXDisplay) {
      this._syncDisplayValue(this._pathOffsetXDisplay, state.x || {}, { disabled: state.disabled });
    }
    if (this._pathOffsetYDisplay) {
      this._syncDisplayValue(this._pathOffsetYDisplay, state.y || {}, { disabled: state.disabled });
    }
  }

  _handlePathOffset(event, axis, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setTextureOffset', axis, value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathOffsetControls());
      else this._syncPathOffsetControls();
    } catch (_) {
      this._syncPathOffsetControls();
    }
  }

  _bindPathTensionControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-tension-root]') || null;
    if (!root) {
      this._unbindPathTensionControls();
      return;
    }
    this._pathTensionRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-tension]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathTensionInput);
      slider.addEventListener('change', this._boundPathTensionCommit);
    }
    this._pathTensionSlider = slider;
    this._pathTensionDisplay = root.querySelector('[data-fa-nexus-path-tension-display]') || null;
    this._bindDisplayInput(this._pathTensionDisplay, this._boundPathTensionInput, this._boundPathTensionCommit);
  }

  _unbindPathTensionControls() {
    if (this._pathTensionSlider) {
      try { this._pathTensionSlider.removeEventListener('input', this._boundPathTensionInput); } catch (_) {}
      try { this._pathTensionSlider.removeEventListener('change', this._boundPathTensionCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathTensionDisplay, this._boundPathTensionInput, this._boundPathTensionCommit);
    this._pathTensionRoot = null;
    this._pathTensionSlider = null;
    this._pathTensionDisplay = null;
  }

  _syncPathTensionControls() {
    if (!this._pathTensionRoot) return;
    const state = this._toolOptionState?.pathAppearance?.tension || { available: false };
    if (!state.available) {
      this._pathTensionRoot.hidden = true;
      return;
    }
    this._pathTensionRoot.hidden = false;
    if (this._pathTensionSlider) {
      if (state.min !== undefined) this._pathTensionSlider.min = String(state.min);
      if (state.max !== undefined) this._pathTensionSlider.max = String(state.max);
      if (state.step !== undefined) this._pathTensionSlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathTensionSlider.value !== next) this._pathTensionSlider.value = next;
      }
      this._applyDefaultValue(this._pathTensionSlider, state.defaultValue);
      this._pathTensionSlider.disabled = !!state.disabled;
    }
    if (this._pathTensionDisplay) {
      this._syncDisplayValue(this._pathTensionDisplay, state);
    }
  }

  _handlePathTension(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setPathTensionValue', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathTensionControls());
      else this._syncPathTensionControls();
    } catch (_) {
      this._syncPathTensionControls();
    }
  }

  _bindPathSimplifyControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-simplify-root]') || null;
    if (!root) {
      this._unbindPathSimplifyControls();
      return;
    }
    this._pathSimplifyRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-simplify]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathSimplifyInput);
      slider.addEventListener('change', this._boundPathSimplifyCommit);
    }
    this._pathSimplifySlider = slider;
    this._pathSimplifyDisplay = root.querySelector('[data-fa-nexus-path-simplify-display]') || null;
    this._bindDisplayInput(this._pathSimplifyDisplay, this._boundPathSimplifyInput, this._boundPathSimplifyCommit);
  }

  _unbindPathSimplifyControls() {
    if (this._pathSimplifySlider) {
      try { this._pathSimplifySlider.removeEventListener('input', this._boundPathSimplifyInput); } catch (_) {}
      try { this._pathSimplifySlider.removeEventListener('change', this._boundPathSimplifyCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathSimplifyDisplay, this._boundPathSimplifyInput, this._boundPathSimplifyCommit);
    this._pathSimplifyRoot = null;
    this._pathSimplifySlider = null;
    this._pathSimplifyDisplay = null;
  }

  _syncPathSimplifyControls() {
    if (!this._pathSimplifyRoot) return;
    const state = this._toolOptionState?.pathAppearance?.freehandSimplify || { available: false };
    if (!state.available) {
      this._pathSimplifyRoot.hidden = true;
      return;
    }
    this._pathSimplifyRoot.hidden = false;
    if (this._pathSimplifySlider) {
      if (state.min !== undefined) this._pathSimplifySlider.min = String(state.min);
      if (state.max !== undefined) this._pathSimplifySlider.max = String(state.max);
      if (state.step !== undefined) this._pathSimplifySlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathSimplifySlider.value !== next) this._pathSimplifySlider.value = next;
      }
      this._applyDefaultValue(this._pathSimplifySlider, state.defaultValue);
      this._pathSimplifySlider.disabled = !!state.disabled;
    }
    if (this._pathSimplifyDisplay) {
      this._syncDisplayValue(this._pathSimplifyDisplay, state);
    }
  }

  _handlePathSimplify(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setFreehandSimplify', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathSimplifyControls());
      else this._syncPathSimplifyControls();
    } catch (_) {
      this._syncPathSimplifyControls();
    }
  }

  _bindShowWidthTangentsControls() {
    const root = this.element?.querySelector('[data-fa-nexus-show-width-tangents-root]') || null;
    if (!root) {
      this._unbindShowWidthTangentsControls();
      return;
    }
    this._showWidthTangentsRoot = root;
    const toggle = root.querySelector('[data-fa-nexus-show-width-tangents]') || null;
    if (toggle) {
      toggle.addEventListener('change', this._boundShowWidthTangentsChange);
    }
    this._showWidthTangentsToggle = toggle;
  }

  _unbindShowWidthTangentsControls() {
    if (this._showWidthTangentsToggle) {
      try { this._showWidthTangentsToggle.removeEventListener('change', this._boundShowWidthTangentsChange); } catch (_) {}
    }
    this._showWidthTangentsRoot = null;
    this._showWidthTangentsToggle = null;
  }

  _syncShowWidthTangentsControls() {
    if (!this._showWidthTangentsRoot) return;
    const state = this._toolOptionState?.pathAppearance?.showWidthTangents || { available: false };
    if (!state.available) {
      this._showWidthTangentsRoot.hidden = true;
      return;
    }
    this._showWidthTangentsRoot.hidden = false;
    if (this._showWidthTangentsToggle) {
      this._showWidthTangentsToggle.checked = !!state.enabled;
      this._showWidthTangentsToggle.disabled = !!state.disabled;
    }
  }

  _handleShowWidthTangentsChange(event) {
    const toggle = event?.currentTarget || event?.target;
    if (!toggle) return;
    const enabled = toggle.checked;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setShowWidthTangents', enabled);
      if (result?.then) result.catch(() => {}).finally(() => this._syncShowWidthTangentsControls());
      else this._syncShowWidthTangentsControls();
    } catch (_) {
      this._syncShowWidthTangentsControls();
    }
  }

  _bindFlipControls() {
    const root = this.element?.querySelector('[data-fa-nexus-flip-root]') || null;
    if (!root) {
      this._unbindFlipControls();
      return;
    }
    this._flipRoot = root;
    this._flipDisplay = root.querySelector('[data-fa-nexus-flip-display]') || null;
    this._flipPreviewDisplay = root.querySelector('[data-fa-nexus-flip-preview]') || null;

    const horizontalButton = root.querySelector('[data-fa-nexus-flip-horizontal]');
    if (horizontalButton) {
      horizontalButton.addEventListener('click', this._boundFlipHorizontal);
      this._flipHorizontalButton = horizontalButton;
    }
    const horizontalRandomButton = root.querySelector('[data-fa-nexus-flip-horizontal-random]');
    if (horizontalRandomButton) {
      horizontalRandomButton.addEventListener('click', this._boundFlipHorizontalRandom);
      this._flipHorizontalRandomButton = horizontalRandomButton;
    }
    const verticalButton = root.querySelector('[data-fa-nexus-flip-vertical]');
    if (verticalButton) {
      verticalButton.addEventListener('click', this._boundFlipVertical);
      this._flipVerticalButton = verticalButton;
    }
    const verticalRandomButton = root.querySelector('[data-fa-nexus-flip-vertical-random]');
    if (verticalRandomButton) {
      verticalRandomButton.addEventListener('click', this._boundFlipVerticalRandom);
      this._flipVerticalRandomButton = verticalRandomButton;
    }

    this._syncFlipControls();
  }

  _unbindFlipControls() {
    if (this._flipHorizontalButton) {
      try { this._flipHorizontalButton.removeEventListener('click', this._boundFlipHorizontal); } catch (_) {}
    }
    if (this._flipHorizontalRandomButton) {
      try { this._flipHorizontalRandomButton.removeEventListener('click', this._boundFlipHorizontalRandom); } catch (_) {}
    }
    if (this._flipVerticalButton) {
      try { this._flipVerticalButton.removeEventListener('click', this._boundFlipVertical); } catch (_) {}
    }
    if (this._flipVerticalRandomButton) {
      try { this._flipVerticalRandomButton.removeEventListener('click', this._boundFlipVerticalRandom); } catch (_) {}
    }
    this._flipRoot = null;
    this._flipDisplay = null;
    this._flipPreviewDisplay = null;
    this._flipHorizontalButton = null;
    this._flipVerticalButton = null;
    this._flipHorizontalRandomButton = null;
    this._flipVerticalRandomButton = null;
  }

  _syncFlipControls() {
    if (!this._flipRoot) return;
    const state = this._toolOptionState?.flip || {};
    if (!state.available) {
      this._flipRoot.hidden = true;
      return;
    }
    this._flipRoot.hidden = false;
    if (this._flipDisplay) {
      const text = state.display || 'None';
      if (this._flipDisplay.textContent !== text) this._flipDisplay.textContent = text;
    }
    if (this._flipPreviewDisplay) {
      const preview = state.previewDisplay || '';
      if (preview) {
        this._flipPreviewDisplay.textContent = preview;
        this._flipPreviewDisplay.hidden = false;
      } else {
        this._flipPreviewDisplay.textContent = '';
        this._flipPreviewDisplay.hidden = true;
      }
    }
    const horizontal = state.horizontal || {};
    const vertical = state.vertical || {};
    const syncAxisButton = (button, axisState) => {
      if (!button || !axisState) return;
      const active = !!axisState.active;
      const previewDiff = !!axisState.previewDiff;
      const aria = axisState.aria || axisState.label || 'Toggle mirroring';
      const tooltip = axisState.tooltip || '';
      button.classList.toggle('is-active', active);
      button.classList.toggle('has-preview-diff', previewDiff);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.setAttribute('aria-label', aria);
      if (tooltip) button.title = tooltip;
      else button.removeAttribute('title');
      button.disabled = !!axisState.disabled;
      const labelSpan = button.querySelector('[data-fa-nexus-button-label]')
        || Array.from(button.querySelectorAll('span')).find((span) => !span.classList.contains('fa-nexus-flip__button-icon'))
        || null;
      if (labelSpan && axisState.label && labelSpan.textContent !== axisState.label) {
        labelSpan.textContent = axisState.label;
      }
    };
    const syncAxisRandomButton = (button, axisState, defaultAria) => {
      if (!button || !axisState) return;
      const enabled = !!axisState.randomEnabled;
      const label = axisState.randomLabel || 'Random';
      const tooltip = axisState.randomTooltip || '';
      const aria = axisState.randomAria || defaultAria;
      button.classList.toggle('is-active', enabled);
      button.classList.toggle('has-preview-diff', !!axisState.randomPreviewDiff);
      button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      button.setAttribute('aria-label', aria);
      if (tooltip) button.title = tooltip;
      else button.removeAttribute('title');
      button.disabled = !!axisState.randomDisabled;
      const labelSpan = button.querySelector('span');
      if (labelSpan && labelSpan.textContent !== label) {
        labelSpan.textContent = label;
      }
    };

    if (this._flipHorizontalButton) {
      syncAxisButton(this._flipHorizontalButton, horizontal);
    }
    if (this._flipHorizontalRandomButton) {
      syncAxisRandomButton(this._flipHorizontalRandomButton, horizontal, 'Toggle random horizontal mirroring');
    }
    if (this._flipVerticalButton) {
      syncAxisButton(this._flipVerticalButton, vertical);
    }
    if (this._flipVerticalRandomButton) {
      syncAxisRandomButton(this._flipVerticalRandomButton, vertical, 'Toggle random vertical mirroring');
    }
  }

  _bindScaleControls() {
    const root = this.element?.querySelector('[data-fa-nexus-scale-root]') || null;
    if (!root) {
      this._unbindScaleControls();
      return;
    }
    this._scaleRoot = root;
    this._scaleDisplay = root.querySelector('[data-fa-nexus-scale-display]') || null;
    this._bindDisplayInput(this._scaleDisplay, this._boundScaleInput, this._boundScaleInput);

    const baseSlider = root.querySelector('[data-fa-nexus-scale-base]');
    if (baseSlider) {
      baseSlider.addEventListener('input', this._boundScaleInput);
      baseSlider.addEventListener('change', this._boundScaleInput);
      this._scaleBaseSlider = baseSlider;
    }

    const randomButton = root.querySelector('[data-fa-nexus-scale-random]');
    if (randomButton) {
      randomButton.addEventListener('click', this._boundScaleRandom);
      this._scaleRandomButton = randomButton;
    }

    const strengthRow = root.querySelector('[data-fa-nexus-scale-strength-row]') || null;
    this._scaleStrengthRow = strengthRow;

    const strengthSlider = root.querySelector('[data-fa-nexus-scale-strength]');
    if (strengthSlider) {
      strengthSlider.addEventListener('input', this._boundScaleStrength);
      strengthSlider.addEventListener('change', this._boundScaleStrength);
      this._scaleStrengthSlider = strengthSlider;
    }
    this._scaleStrengthDisplay = root.querySelector('[data-fa-nexus-scale-strength-label]') || null;
    this._bindDisplayInput(this._scaleStrengthDisplay, this._boundScaleStrength, this._boundScaleStrength);

    this._syncScaleControls();
  }

  _unbindScaleControls() {
    if (this._scaleBaseSlider) {
      try {
        this._scaleBaseSlider.removeEventListener('input', this._boundScaleInput);
        this._scaleBaseSlider.removeEventListener('change', this._boundScaleInput);
      } catch (_) {}
    }
    if (this._scaleStrengthSlider) {
      try {
        this._scaleStrengthSlider.removeEventListener('input', this._boundScaleStrength);
        this._scaleStrengthSlider.removeEventListener('change', this._boundScaleStrength);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._scaleDisplay, this._boundScaleInput, this._boundScaleInput);
    this._unbindDisplayInput(this._scaleStrengthDisplay, this._boundScaleStrength, this._boundScaleStrength);
    if (this._scaleRandomButton) {
      try { this._scaleRandomButton.removeEventListener('click', this._boundScaleRandom); }
      catch (_) {}
    }
    this._scaleRoot = null;
    this._scaleDisplay = null;
    this._scaleBaseSlider = null;
    this._scaleRandomButton = null;
    this._scaleStrengthRow = null;
    this._scaleStrengthSlider = null;
    this._scaleStrengthDisplay = null;
  }

  _syncScaleControls() {
    if (!this._scaleRoot) return;
    const state = this._toolOptionState?.scale || {};
    if (this._scaleDisplay) {
      this._syncDisplayValue(this._scaleDisplay, state);
    }
    if (this._scaleBaseSlider) {
      if (state.min !== undefined) this._scaleBaseSlider.min = String(state.min);
      if (state.max !== undefined) this._scaleBaseSlider.max = String(state.max);
      if (state.step !== undefined) this._scaleBaseSlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._scaleBaseSlider.value !== nextValue) this._scaleBaseSlider.value = nextValue;
      }
      this._applyDefaultValue(this._scaleBaseSlider, state.defaultValue);
      this._scaleBaseSlider.disabled = !!state.disabled;
    }
    const randomVisible = state.randomButtonVisible !== false;
    if (this._scaleRandomButton) {
      this._scaleRandomButton.hidden = !randomVisible;
      this._scaleRandomButton.classList.toggle('is-hidden', !randomVisible);
      const active = randomVisible && !!state.randomEnabled;
      this._scaleRandomButton.classList.toggle('is-active', active);
      this._scaleRandomButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      this._scaleRandomButton.disabled = !randomVisible || !!state.disabled;
      if (state.randomTooltip) this._scaleRandomButton.title = state.randomTooltip;
      const labelSpan = this._scaleRandomButton.querySelector('span');
      if (labelSpan && state.randomLabel && labelSpan.textContent !== state.randomLabel) {
        labelSpan.textContent = state.randomLabel;
      }
    }
    const strengthVisible = randomVisible && !!state.randomEnabled;
    if (this._scaleStrengthRow) {
      this._scaleStrengthRow.hidden = !strengthVisible;
    }
    if (this._scaleStrengthSlider) {
      if (state.strengthMin !== undefined) this._scaleStrengthSlider.min = String(state.strengthMin);
      if (state.strengthMax !== undefined) this._scaleStrengthSlider.max = String(state.strengthMax);
      const step = state.strengthStep !== undefined ? state.strengthStep : 1;
      this._scaleStrengthSlider.step = String(step);
      if (state.strength !== undefined) {
        const nextStrength = String(state.strength);
        if (this._scaleStrengthSlider.value !== nextStrength) this._scaleStrengthSlider.value = nextStrength;
      }
      this._applyDefaultValue(this._scaleStrengthSlider, state.strengthDefault);
      this._scaleStrengthSlider.disabled = !strengthVisible;
    }
    if (this._scaleStrengthDisplay) {
      this._syncDisplayValue(this._scaleStrengthDisplay, {
        min: state.strengthMin,
        max: state.strengthMax,
        step: state.strengthStep,
        value: state.strength,
        display: state.strengthDisplay || '',
        defaultValue: state.strengthDefault
      });
    }
  }

  _handleFlipHorizontal(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipHorizontal');
  }

  _handleFlipVertical(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipVertical');
  }

  _handleFlipRandomHorizontal(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipHorizontalRandom');
  }

  _handleFlipRandomVertical(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipVerticalRandom');
  }

  _handleScaleInput(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    const commit = event?.type === 'change';
    if (this._controller?.invokeToolHandler) {
      try {
        const result = this._controller.invokeToolHandler('setScale', value, commit);
        if (result?.then) {
          result.catch(() => {}).finally(() => this._syncScaleControls());
        } else {
          this._syncScaleControls();
        }
      } catch (_) {
        this._syncScaleControls();
      }
    }
  }

  _handleScaleStrength(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setScaleRandomStrength', value);
    }
  }

  _handleScaleRandom(event) {
    event?.preventDefault?.();
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('toggleScaleRandom');
    }
  }

  _bindRotationControls() {
    const root = this.element?.querySelector('[data-fa-nexus-rotation-root]') || null;
    if (!root) {
      this._unbindRotationControls();
      return;
    }
    this._rotationRoot = root;
    this._rotationDisplay = root.querySelector('[data-fa-nexus-rotation-display]') || null;
    this._bindDisplayInput(this._rotationDisplay, this._boundRotationInput, this._boundRotationInput);

    const baseSlider = root.querySelector('[data-fa-nexus-rotation-base]');
    if (baseSlider) {
      baseSlider.addEventListener('input', this._boundRotationInput);
      baseSlider.addEventListener('change', this._boundRotationInput);
      this._rotationBaseSlider = baseSlider;
    }

    const randomButton = root.querySelector('[data-fa-nexus-rotation-random]');
    if (randomButton) {
      randomButton.addEventListener('click', this._boundRotationRandom);
      this._rotationRandomButton = randomButton;
    }

    const strengthRow = root.querySelector('[data-fa-nexus-rotation-strength-row]') || null;
    this._rotationStrengthRow = strengthRow;
    const strengthSlider = root.querySelector('[data-fa-nexus-rotation-strength]');
    if (strengthSlider) {
      strengthSlider.addEventListener('input', this._boundRotationStrength);
      strengthSlider.addEventListener('change', this._boundRotationStrength);
      this._rotationStrengthSlider = strengthSlider;
    }
    this._rotationStrengthDisplay = root.querySelector('[data-fa-nexus-rotation-strength-label]') || null;
    this._bindDisplayInput(this._rotationStrengthDisplay, this._boundRotationStrength, this._boundRotationStrength);

    this._syncRotationControls();
  }

  _unbindRotationControls() {
    if (this._rotationBaseSlider) {
      try {
        this._rotationBaseSlider.removeEventListener('input', this._boundRotationInput);
        this._rotationBaseSlider.removeEventListener('change', this._boundRotationInput);
      } catch (_) {}
    }
    if (this._rotationStrengthSlider) {
      try {
        this._rotationStrengthSlider.removeEventListener('input', this._boundRotationStrength);
        this._rotationStrengthSlider.removeEventListener('change', this._boundRotationStrength);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._rotationDisplay, this._boundRotationInput, this._boundRotationInput);
    this._unbindDisplayInput(this._rotationStrengthDisplay, this._boundRotationStrength, this._boundRotationStrength);
    if (this._rotationRandomButton) {
      try { this._rotationRandomButton.removeEventListener('click', this._boundRotationRandom); }
      catch (_) {}
    }
    this._rotationRoot = null;
    this._rotationDisplay = null;
    this._rotationBaseSlider = null;
    this._rotationRandomButton = null;
    this._rotationStrengthRow = null;
    this._rotationStrengthSlider = null;
    this._rotationStrengthDisplay = null;
  }

  _syncRotationControls() {
    if (!this._rotationRoot) return;
    const state = this._toolOptionState?.rotation || {};
    if (this._rotationDisplay) {
      this._syncDisplayValue(this._rotationDisplay, state);
    }
    if (this._rotationBaseSlider) {
      if (state.min !== undefined) this._rotationBaseSlider.min = String(state.min);
      if (state.max !== undefined) this._rotationBaseSlider.max = String(state.max);
      if (state.step !== undefined) this._rotationBaseSlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._rotationBaseSlider.value !== nextValue) this._rotationBaseSlider.value = nextValue;
      }
      this._applyDefaultValue(this._rotationBaseSlider, state.defaultValue);
      this._rotationBaseSlider.disabled = !!state.disabled;
    }
    const randomVisible = state.randomButtonVisible !== false;
    if (this._rotationRandomButton) {
      this._rotationRandomButton.hidden = !randomVisible;
      this._rotationRandomButton.classList.toggle('is-hidden', !randomVisible);
      const active = randomVisible && !!state.randomEnabled;
      this._rotationRandomButton.classList.toggle('is-active', active);
      this._rotationRandomButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      this._rotationRandomButton.disabled = !randomVisible || !!state.disabled;
      if (state.randomTooltip) this._rotationRandomButton.title = state.randomTooltip;
      const labelSpan = this._rotationRandomButton.querySelector('span');
      if (labelSpan && state.randomLabel && labelSpan.textContent !== state.randomLabel) {
        labelSpan.textContent = state.randomLabel;
      }
    }
    const strengthVisible = randomVisible && !!state.randomEnabled;
    if (this._rotationStrengthRow) {
      this._rotationStrengthRow.hidden = !strengthVisible;
    }
    if (this._rotationStrengthSlider) {
      if (state.strengthMin !== undefined) this._rotationStrengthSlider.min = String(state.strengthMin);
      if (state.strengthMax !== undefined) this._rotationStrengthSlider.max = String(state.strengthMax);
      const step = state.strengthStep !== undefined ? state.strengthStep : 1;
      this._rotationStrengthSlider.step = String(step);
      if (state.strength !== undefined) {
        const nextStrength = String(state.strength);
        if (this._rotationStrengthSlider.value !== nextStrength) this._rotationStrengthSlider.value = nextStrength;
      }
      this._applyDefaultValue(this._rotationStrengthSlider, state.strengthDefault);
      this._rotationStrengthSlider.disabled = !strengthVisible;
    }
    if (this._rotationStrengthDisplay) {
      this._syncDisplayValue(this._rotationStrengthDisplay, {
        min: state.strengthMin,
        max: state.strengthMax,
        step: state.strengthStep,
        value: state.strength,
        display: state.strengthDisplay || '',
        defaultValue: state.strengthDefault
      });
    }
  }

  _handleRotationInput(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    const commit = event?.type === 'change';
    if (this._controller?.invokeToolHandler) {
      try {
        const result = this._controller.invokeToolHandler('setRotation', value, commit);
        if (result?.then) {
          result.catch(() => {}).finally(() => this._syncRotationControls());
        } else {
          this._syncRotationControls();
        }
      } catch (_) {
        this._syncRotationControls();
      }
    }
  }

  _handleRotationStrength(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setRotationRandomStrength', value);
    }
  }

  _handleRotationRandom(event) {
    event?.preventDefault?.();
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('toggleRotationRandom');
    }
  }

  _bindPathShadowControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-shadow]') || null;
    if (!root) {
      this._unbindPathShadowControls();
      return;
    }
    if (this._pathShadowRoot === root) {
      this._syncPathShadowControls();
      return;
    }
    this._unbindPathShadowControls();
    this._pathShadowRoot = root;
    const toggle = root.querySelector('[data-fa-nexus-path-shadow-toggle]') || null;
    if (toggle) {
      toggle.addEventListener('change', this._boundPathShadowToggle);
      this._pathShadowToggle = toggle;
    }
    const editToggle = root.querySelector('[data-fa-nexus-path-shadow-edit]') || null;
    if (editToggle) {
      editToggle.addEventListener('change', this._boundPathShadowEditToggle);
      this._pathShadowEditToggle = editToggle;
    }
    this._pathShadowEditRoot = root.querySelector('[data-fa-nexus-path-shadow-edit-row]')
      || root.querySelector('[data-fa-nexus-path-shadow-edit-root]')
      || (editToggle ? editToggle.closest('label') : null);
    this._pathShadowPresetsRoot = root.querySelector('[data-fa-nexus-path-shadow-presets]') || null;
    if (this._pathShadowPresetsRoot) {
      this._pathShadowPresetButtons = Array.from(this._pathShadowPresetsRoot.querySelectorAll('[data-fa-nexus-path-shadow-preset]'));
      for (const button of this._pathShadowPresetButtons) {
        button.addEventListener('click', this._boundPathShadowPresetClick);
        button.addEventListener('contextmenu', this._boundPathShadowPresetContext);
      }
    } else {
      this._pathShadowPresetButtons = [];
    }
    this._pathShadowResetButton = root.querySelector('[data-fa-nexus-path-shadow-reset]') || null;
    if (this._pathShadowResetButton) {
      this._pathShadowResetButton.addEventListener('click', this._boundPathShadowReset);
    }
    this._pathShadowEditResetButton = root.querySelector('[data-fa-nexus-path-shadow-edit-reset]') || null;
    if (this._pathShadowEditResetButton) {
      this._pathShadowEditResetButton.addEventListener('click', this._boundPathShadowEditReset);
    }
    this._pathShadowElevationDisplay = root.querySelector('[data-fa-nexus-path-shadow-elevation]') || null;
    this._pathShadowNoteDisplay = root.querySelector('[data-fa-nexus-path-shadow-note]') || null;
    const scaleSlider = root.querySelector('[data-fa-nexus-path-shadow-scale]') || null;
    if (scaleSlider) {
      scaleSlider.addEventListener('input', this._boundPathShadowScaleInput);
      scaleSlider.addEventListener('change', this._boundPathShadowScaleCommit);
      this._pathShadowScaleSlider = scaleSlider;
    }
    const offsetSlider = root.querySelector('[data-fa-nexus-path-shadow-offset]') || null;
    if (offsetSlider) {
      offsetSlider.addEventListener('input', this._boundPathShadowOffsetInput);
      offsetSlider.addEventListener('change', this._boundPathShadowOffsetCommit);
      this._pathShadowOffsetSlider = offsetSlider;
    }
    const alphaSlider = root.querySelector('[data-fa-nexus-path-shadow-alpha]') || null;
    if (alphaSlider) {
      alphaSlider.addEventListener('input', this._boundPathShadowAlphaInput);
      alphaSlider.addEventListener('change', this._boundPathShadowAlphaCommit);
      this._pathShadowAlphaSlider = alphaSlider;
    }
    const blurSlider = root.querySelector('[data-fa-nexus-path-shadow-blur]') || null;
    if (blurSlider) {
      blurSlider.addEventListener('input', this._boundPathShadowBlurInput);
      blurSlider.addEventListener('change', this._boundPathShadowBlurCommit);
      this._pathShadowBlurSlider = blurSlider;
    }
    const dilationSlider = root.querySelector('[data-fa-nexus-path-shadow-dilation]') || null;
    if (dilationSlider) {
      dilationSlider.addEventListener('input', this._boundPathShadowDilationInput);
      dilationSlider.addEventListener('change', this._boundPathShadowDilationCommit);
      this._pathShadowDilationSlider = dilationSlider;
    }
    this._pathShadowScaleDisplay = root.querySelector('[data-fa-nexus-path-shadow-scale-display]') || null;
    this._pathShadowOffsetDisplay = root.querySelector('[data-fa-nexus-path-shadow-offset-display]') || null;
    this._pathShadowAlphaDisplay = root.querySelector('[data-fa-nexus-path-shadow-alpha-display]') || null;
    this._pathShadowBlurDisplay = root.querySelector('[data-fa-nexus-path-shadow-blur-display]') || null;
    this._pathShadowDilationDisplay = root.querySelector('[data-fa-nexus-path-shadow-dilation-display]') || null;
    this._bindDisplayInput(this._pathShadowScaleDisplay, this._boundPathShadowScaleInput, this._boundPathShadowScaleCommit);
    this._bindDisplayInput(this._pathShadowOffsetDisplay, this._boundPathShadowOffsetInput, this._boundPathShadowOffsetCommit);
    this._bindDisplayInput(this._pathShadowAlphaDisplay, this._boundPathShadowAlphaInput, this._boundPathShadowAlphaCommit);
    this._bindDisplayInput(this._pathShadowBlurDisplay, this._boundPathShadowBlurInput, this._boundPathShadowBlurCommit);
    this._bindDisplayInput(this._pathShadowDilationDisplay, this._boundPathShadowDilationInput, this._boundPathShadowDilationCommit);
    this._syncPathShadowControls();
  }

  _unbindPathShadowControls() {
    if (this._pathShadowToggle) {
      try { this._pathShadowToggle.removeEventListener('change', this._boundPathShadowToggle); }
      catch (_) {}
    }
    if (this._pathShadowEditToggle) {
      try { this._pathShadowEditToggle.removeEventListener('change', this._boundPathShadowEditToggle); }
      catch (_) {}
    }
    if (Array.isArray(this._pathShadowPresetButtons) && this._pathShadowPresetButtons.length) {
      for (const button of this._pathShadowPresetButtons) {
        try { button.removeEventListener('click', this._boundPathShadowPresetClick); } catch (_) {}
        try { button.removeEventListener('contextmenu', this._boundPathShadowPresetContext); } catch (_) {}
      }
    }
    if (this._pathShadowResetButton) {
      try { this._pathShadowResetButton.removeEventListener('click', this._boundPathShadowReset); }
      catch (_) {}
    }
    if (this._pathShadowEditResetButton) {
      try { this._pathShadowEditResetButton.removeEventListener('click', this._boundPathShadowEditReset); }
      catch (_) {}
    }
    if (this._pathShadowScaleSlider) {
      try {
        this._pathShadowScaleSlider.removeEventListener('input', this._boundPathShadowScaleInput);
        this._pathShadowScaleSlider.removeEventListener('change', this._boundPathShadowScaleCommit);
      } catch (_) {}
    }
    if (this._pathShadowOffsetSlider) {
      try {
        this._pathShadowOffsetSlider.removeEventListener('input', this._boundPathShadowOffsetInput);
        this._pathShadowOffsetSlider.removeEventListener('change', this._boundPathShadowOffsetCommit);
      } catch (_) {}
    }
    if (this._pathShadowAlphaSlider) {
      try {
        this._pathShadowAlphaSlider.removeEventListener('input', this._boundPathShadowAlphaInput);
        this._pathShadowAlphaSlider.removeEventListener('change', this._boundPathShadowAlphaCommit);
      } catch (_) {}
    }
    if (this._pathShadowBlurSlider) {
      try {
        this._pathShadowBlurSlider.removeEventListener('input', this._boundPathShadowBlurInput);
        this._pathShadowBlurSlider.removeEventListener('change', this._boundPathShadowBlurCommit);
      } catch (_) {}
    }
    if (this._pathShadowDilationSlider) {
      try {
        this._pathShadowDilationSlider.removeEventListener('input', this._boundPathShadowDilationInput);
        this._pathShadowDilationSlider.removeEventListener('change', this._boundPathShadowDilationCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._pathShadowScaleDisplay, this._boundPathShadowScaleInput, this._boundPathShadowScaleCommit);
    this._unbindDisplayInput(this._pathShadowOffsetDisplay, this._boundPathShadowOffsetInput, this._boundPathShadowOffsetCommit);
    this._unbindDisplayInput(this._pathShadowAlphaDisplay, this._boundPathShadowAlphaInput, this._boundPathShadowAlphaCommit);
    this._unbindDisplayInput(this._pathShadowBlurDisplay, this._boundPathShadowBlurInput, this._boundPathShadowBlurCommit);
    this._unbindDisplayInput(this._pathShadowDilationDisplay, this._boundPathShadowDilationInput, this._boundPathShadowDilationCommit);
    this._pathShadowRoot = null;
    this._pathShadowToggle = null;
    this._pathShadowEditToggle = null;
    this._pathShadowEditRoot = null;
    this._pathShadowPresetsRoot = null;
    this._pathShadowPresetButtons = [];
    this._pathShadowResetButton = null;
    this._pathShadowEditResetButton = null;
    this._pathShadowScaleSlider = null;
    this._pathShadowOffsetSlider = null;
    this._pathShadowAlphaSlider = null;
    this._pathShadowBlurSlider = null;
    this._pathShadowDilationSlider = null;
    this._pathShadowScaleDisplay = null;
    this._pathShadowOffsetDisplay = null;
    this._pathShadowAlphaDisplay = null;
    this._pathShadowBlurDisplay = null;
    this._pathShadowDilationDisplay = null;
    this._pathShadowElevationDisplay = null;
    this._pathShadowNoteDisplay = null;
  }

  _syncPathShadowControls() {
    const state = this._toolOptionState?.pathShadow || { available: false };
    if (this._pathShadowRoot) {
      this._pathShadowRoot.classList.toggle('is-hidden', !state.available);
    }
    if (!state.available) return;
    const editAvailable = state.editAvailable !== false;
    if (this._pathShadowEditRoot) {
      this._pathShadowEditRoot.classList.toggle('is-hidden', !editAvailable);
    }
    if (this._pathShadowToggle) {
      this._pathShadowToggle.checked = !!state.enabled;
      this._pathShadowToggle.disabled = !!state.disabled;
    }
    if (this._pathShadowEditToggle) {
      this._pathShadowEditToggle.checked = !!state.editMode;
      this._pathShadowEditToggle.disabled = !state.enabled || !!state.editDisabled || !editAvailable;
    }
    if (this._pathShadowElevationDisplay) {
      const displayValue = state.context?.display ?? '0';
      this._pathShadowElevationDisplay.textContent = `Elevation ${displayValue}`;
    }
    if (this._pathShadowNoteDisplay) {
      const note = state.context?.note ?? '';
      if (note) {
        this._pathShadowNoteDisplay.textContent = note;
        this._pathShadowNoteDisplay.classList.remove('is-hidden');
      } else {
        this._pathShadowNoteDisplay.textContent = '';
        this._pathShadowNoteDisplay.classList.add('is-hidden');
      }
    }
    const hasPresets = Array.isArray(state.presets) && state.presets.length > 0;
    if (this._pathShadowPresetsRoot) {
      this._pathShadowPresetsRoot.classList.toggle('is-hidden', !hasPresets);
    }
    if (hasPresets && Array.isArray(this._pathShadowPresetButtons) && this._pathShadowPresetButtons.length) {
      for (const button of this._pathShadowPresetButtons) {
        const index = Number(button.dataset.faNexusPathShadowPreset);
        const preset = state.presets.find((entry) => Number(entry?.index) === index)
          ?? state.presets[index] ?? null;
        const saved = !!preset?.saved;
        const active = !!preset?.active;
        button.classList.toggle('is-active', active);
        button.classList.toggle('is-empty', !saved);
        if (preset?.label) button.textContent = preset.label;
        if (preset?.tooltip) button.title = preset.tooltip;
        button.disabled = !!state.disabled;
      }
    }
    if (this._pathShadowResetButton) {
      const disabled = !!state.reset?.disabled;
      this._pathShadowResetButton.disabled = disabled;
      const tooltip = state.reset?.tooltip;
      if (tooltip && tooltip.length) this._pathShadowResetButton.title = tooltip;
    }
    if (this._pathShadowEditResetButton) {
      const disabled = !!state.editReset?.disabled;
      this._pathShadowEditResetButton.disabled = disabled;
      const tooltip = state.editReset?.tooltip;
      if (tooltip && tooltip.length) this._pathShadowEditResetButton.title = tooltip;
    }
    const syncSlider = (slider, display, cfg) => {
      if (!slider || !cfg) return;
      if (cfg.min !== undefined) slider.min = String(cfg.min);
      if (cfg.max !== undefined) slider.max = String(cfg.max);
      if (cfg.step !== undefined) slider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (slider.value !== next) slider.value = next;
      }
      this._applyDefaultValue(slider, cfg.defaultValue);
      slider.disabled = !!cfg.disabled;
      if (display) this._syncDisplayValue(display, cfg);
    };
    if (this._pathShadowScaleSlider && state.scale) {
      const cfg = state.scale;
      syncSlider(this._pathShadowScaleSlider, this._pathShadowScaleDisplay, cfg);
    }
    if (this._pathShadowOffsetSlider && state.offset) {
      const cfg = state.offset;
      syncSlider(this._pathShadowOffsetSlider, this._pathShadowOffsetDisplay, cfg);
    }
    if (this._pathShadowAlphaSlider && state.alpha) {
      const cfg = state.alpha;
      syncSlider(this._pathShadowAlphaSlider, this._pathShadowAlphaDisplay, cfg);
    }
    if (this._pathShadowBlurSlider && state.blur) {
      const cfg = state.blur;
      syncSlider(this._pathShadowBlurSlider, this._pathShadowBlurDisplay, cfg);
    }
    if (this._pathShadowDilationSlider && state.dilation) {
      const cfg = state.dilation;
      syncSlider(this._pathShadowDilationSlider, this._pathShadowDilationDisplay, cfg);
    }
  }

  _handlePathShadowToggle(event) {
    if (!this._controller?.invokeToolHandler) return;
    const enabled = !!(event?.currentTarget?.checked ?? event?.target?.checked);
    try { this._controller.invokeToolHandler('setPathShadowEnabled', enabled); }
    catch (_) {}
  }

  _handlePathShadowEdit(event) {
    if (!this._controller?.invokeToolHandler) return;
    const enabled = !!(event?.currentTarget?.checked ?? event?.target?.checked);
    try { this._controller.invokeToolHandler('setPathShadowEditMode', enabled); }
    catch (_) {}
  }

  _handlePathShadowSlider(event, handlerId, commit) {
    if (!this._controller?.invokeToolHandler) return;
    const value = event?.currentTarget?.value ?? event?.target?.value;
    const numeric = Number(value);
    const payload = Number.isFinite(numeric) ? numeric : value;
    try { this._controller.invokeToolHandler(handlerId, payload, !!commit); }
    catch (_) {}
  }

  _handlePathShadowPresetClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const index = Number(button.dataset.faNexusPathShadowPreset);
    if (!Number.isInteger(index)) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const save = !!(event?.shiftKey || event?.altKey || event?.metaKey);
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handlePathShadowPreset', index, save);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _handlePathShadowPresetContext(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const index = Number(button.dataset.faNexusPathShadowPreset);
    if (!Number.isInteger(index)) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handlePathShadowPreset', index, true);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _handlePathShadowReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('resetPathShadowSettings');
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _handlePathShadowEditReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('resetPathShadowEdit');
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _bindPathFeatherControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-feather]') || null;
    if (!root) {
      this._unbindPathFeatherControls();
      return;
    }
    this._pathFeatherRoot = root;
    const startToggle = root.querySelector('[data-fa-nexus-feather-start-toggle]') || null;
    const endToggle = root.querySelector('[data-fa-nexus-feather-end-toggle]') || null;
    if (startToggle) {
      startToggle.addEventListener('change', this._boundPathFeatherStartToggle);
      this._pathFeatherStartToggle = startToggle;
    }
    if (endToggle) {
      endToggle.addEventListener('change', this._boundPathFeatherEndToggle);
      this._pathFeatherEndToggle = endToggle;
    }
    this._pathFeatherStartSlider = root.querySelector('[data-fa-nexus-feather-start-length]') || null;
    this._pathFeatherEndSlider = root.querySelector('[data-fa-nexus-feather-end-length]') || null;
    if (this._pathFeatherStartSlider) {
      this._pathFeatherStartSlider.addEventListener('input', this._boundPathFeatherStartInput);
      this._pathFeatherStartSlider.addEventListener('change', this._boundPathFeatherStartCommit);
    }
    if (this._pathFeatherEndSlider) {
      this._pathFeatherEndSlider.addEventListener('input', this._boundPathFeatherEndInput);
      this._pathFeatherEndSlider.addEventListener('change', this._boundPathFeatherEndCommit);
    }
    this._pathFeatherStartValue = root.querySelector('[data-fa-nexus-feather-start-display]') || null;
    this._pathFeatherEndValue = root.querySelector('[data-fa-nexus-feather-end-display]') || null;
    this._bindDisplayInput(this._pathFeatherStartValue, this._boundPathFeatherStartInput, this._boundPathFeatherStartCommit);
    this._bindDisplayInput(this._pathFeatherEndValue, this._boundPathFeatherEndInput, this._boundPathFeatherEndCommit);
    this._pathFeatherHint = root.querySelector('[data-fa-nexus-feather-hint]') || null;
    this._syncPathFeatherControls();
  }

  _unbindPathFeatherControls() {
    if (this._pathFeatherStartToggle) {
      try { this._pathFeatherStartToggle.removeEventListener('change', this._boundPathFeatherStartToggle); }
      catch (_) {}
    }
    if (this._pathFeatherEndToggle) {
      try { this._pathFeatherEndToggle.removeEventListener('change', this._boundPathFeatherEndToggle); }
      catch (_) {}
    }
    if (this._pathFeatherStartSlider) {
      try {
        this._pathFeatherStartSlider.removeEventListener('input', this._boundPathFeatherStartInput);
        this._pathFeatherStartSlider.removeEventListener('change', this._boundPathFeatherStartCommit);
      } catch (_) {}
    }
    if (this._pathFeatherEndSlider) {
      try {
        this._pathFeatherEndSlider.removeEventListener('input', this._boundPathFeatherEndInput);
        this._pathFeatherEndSlider.removeEventListener('change', this._boundPathFeatherEndCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._pathFeatherStartValue, this._boundPathFeatherStartInput, this._boundPathFeatherStartCommit);
    this._unbindDisplayInput(this._pathFeatherEndValue, this._boundPathFeatherEndInput, this._boundPathFeatherEndCommit);
    this._pathFeatherRoot = null;
    this._pathFeatherStartToggle = null;
    this._pathFeatherEndToggle = null;
    this._pathFeatherStartSlider = null;
    this._pathFeatherEndSlider = null;
    this._pathFeatherStartValue = null;
    this._pathFeatherEndValue = null;
    this._pathFeatherHint = null;
  }

  _syncPathFeatherControls() {
    const state = this._toolOptionState?.pathFeather || { available: false };
    if (this._pathFeatherRoot) {
      this._pathFeatherRoot.classList.toggle('is-hidden', !state.available);
    }
    if (!state.available) return;
    if (this._pathFeatherStartToggle && state.start) {
      this._pathFeatherStartToggle.checked = !!state.start.enabled;
    }
    if (this._pathFeatherEndToggle && state.end) {
      this._pathFeatherEndToggle.checked = !!state.end.enabled;
    }
    if (this._pathFeatherStartSlider && state.start?.length) {
      const length = state.start.length;
      if (length.min !== undefined) this._pathFeatherStartSlider.min = String(length.min);
      if (length.max !== undefined) this._pathFeatherStartSlider.max = String(length.max);
      if (length.step !== undefined) this._pathFeatherStartSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._pathFeatherStartSlider.value !== next) this._pathFeatherStartSlider.value = next;
      }
      this._applyDefaultValue(this._pathFeatherStartSlider, length.defaultValue);
      this._pathFeatherStartSlider.disabled = !!length.disabled;
      if (this._pathFeatherStartValue) {
        this._syncDisplayValue(this._pathFeatherStartValue, length);
      }
    }
    if (this._pathFeatherEndSlider && state.end?.length) {
      const length = state.end.length;
      if (length.min !== undefined) this._pathFeatherEndSlider.min = String(length.min);
      if (length.max !== undefined) this._pathFeatherEndSlider.max = String(length.max);
      if (length.step !== undefined) this._pathFeatherEndSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._pathFeatherEndSlider.value !== next) this._pathFeatherEndSlider.value = next;
      }
      this._applyDefaultValue(this._pathFeatherEndSlider, length.defaultValue);
      this._pathFeatherEndSlider.disabled = !!length.disabled;
      if (this._pathFeatherEndValue) {
        this._syncDisplayValue(this._pathFeatherEndValue, length);
      }
    }
    if (this._pathFeatherHint) {
      const text = state.hint || '';
      this._pathFeatherHint.textContent = text;
      this._pathFeatherHint.classList.toggle('is-hidden', !text);
    }
  }

  _handlePathFeatherToggle(event, endpoint) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setFeatherShrinkEnabled', endpoint, !!input.checked);
    }
  }

  _handlePathFeatherLength(event, endpoint, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setFeatherLength', endpoint, slider.value, !!commit);
    }
  }

  _bindOpacityFeatherControls() {
    const root = this.element?.querySelector('[data-fa-nexus-opacity-feather]') || null;
    if (!root) {
      this._unbindOpacityFeatherControls();
      return;
    }
    this._opacityFeatherRoot = root;
    const startToggle = root.querySelector('[data-fa-nexus-opacity-start-toggle]');
    const endToggle = root.querySelector('[data-fa-nexus-opacity-end-toggle]');
    if (startToggle) {
      startToggle.addEventListener('change', this._boundOpacityFeatherStartToggle);
      this._opacityFeatherStartToggle = startToggle;
    }
    if (endToggle) {
      endToggle.addEventListener('change', this._boundOpacityFeatherEndToggle);
      this._opacityFeatherEndToggle = endToggle;
    }
    const startSlider = root.querySelector('[data-fa-nexus-opacity-start-length]');
    const endSlider = root.querySelector('[data-fa-nexus-opacity-end-length]');
    if (startSlider) {
      startSlider.addEventListener('input', this._boundOpacityFeatherStartInput);
      startSlider.addEventListener('change', this._boundOpacityFeatherStartCommit);
      this._opacityFeatherStartSlider = startSlider;
    }
    if (endSlider) {
      endSlider.addEventListener('input', this._boundOpacityFeatherEndInput);
      endSlider.addEventListener('change', this._boundOpacityFeatherEndCommit);
      this._opacityFeatherEndSlider = endSlider;
    }
    this._opacityFeatherStartValue = root.querySelector('[data-fa-nexus-opacity-start-display]') || null;
    this._opacityFeatherEndValue = root.querySelector('[data-fa-nexus-opacity-end-display]') || null;
    this._bindDisplayInput(this._opacityFeatherStartValue, this._boundOpacityFeatherStartInput, this._boundOpacityFeatherStartCommit);
    this._bindDisplayInput(this._opacityFeatherEndValue, this._boundOpacityFeatherEndInput, this._boundOpacityFeatherEndCommit);
    this._opacityFeatherHint = root.querySelector('[data-fa-nexus-opacity-hint]') || null;
    this._syncOpacityFeatherControls();
  }

  _unbindOpacityFeatherControls() {
    if (this._opacityFeatherStartToggle) {
      try { this._opacityFeatherStartToggle.removeEventListener('change', this._boundOpacityFeatherStartToggle); }
      catch (_) {}
    }
    if (this._opacityFeatherEndToggle) {
      try { this._opacityFeatherEndToggle.removeEventListener('change', this._boundOpacityFeatherEndToggle); }
      catch (_) {}
    }
    if (this._opacityFeatherStartSlider) {
      try {
        this._opacityFeatherStartSlider.removeEventListener('input', this._boundOpacityFeatherStartInput);
        this._opacityFeatherStartSlider.removeEventListener('change', this._boundOpacityFeatherStartCommit);
      } catch (_) {}
    }
    if (this._opacityFeatherEndSlider) {
      try {
        this._opacityFeatherEndSlider.removeEventListener('input', this._boundOpacityFeatherEndInput);
        this._opacityFeatherEndSlider.removeEventListener('change', this._boundOpacityFeatherEndCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._opacityFeatherStartValue, this._boundOpacityFeatherStartInput, this._boundOpacityFeatherStartCommit);
    this._unbindDisplayInput(this._opacityFeatherEndValue, this._boundOpacityFeatherEndInput, this._boundOpacityFeatherEndCommit);
    this._opacityFeatherRoot = null;
    this._opacityFeatherStartToggle = null;
    this._opacityFeatherEndToggle = null;
    this._opacityFeatherStartSlider = null;
    this._opacityFeatherEndSlider = null;
    this._opacityFeatherStartValue = null;
    this._opacityFeatherEndValue = null;
    this._opacityFeatherHint = null;
  }

  _syncOpacityFeatherControls() {
    const state = this._toolOptionState?.opacityFeather || { available: false };
    if (this._opacityFeatherRoot) {
      this._opacityFeatherRoot.classList.toggle('is-hidden', !state.available);
    }
    if (!state.available) return;
    if (this._opacityFeatherStartToggle && state.start) {
      this._opacityFeatherStartToggle.checked = !!state.start.enabled;
    }
    if (this._opacityFeatherEndToggle && state.end) {
      this._opacityFeatherEndToggle.checked = !!state.end.enabled;
    }
    if (this._opacityFeatherStartSlider && state.start?.length) {
      const length = state.start.length;
      if (length.min !== undefined) this._opacityFeatherStartSlider.min = String(length.min);
      if (length.max !== undefined) this._opacityFeatherStartSlider.max = String(length.max);
      if (length.step !== undefined) this._opacityFeatherStartSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._opacityFeatherStartSlider.value !== next) this._opacityFeatherStartSlider.value = next;
      }
      this._applyDefaultValue(this._opacityFeatherStartSlider, length.defaultValue);
      this._opacityFeatherStartSlider.disabled = !state.start.enabled || !!length.disabled;
      if (this._opacityFeatherStartValue) {
        this._syncDisplayValue(this._opacityFeatherStartValue, length, { disabled: !state.start.enabled });
      }
    }
    if (this._opacityFeatherEndSlider && state.end?.length) {
      const length = state.end.length;
      if (length.min !== undefined) this._opacityFeatherEndSlider.min = String(length.min);
      if (length.max !== undefined) this._opacityFeatherEndSlider.max = String(length.max);
      if (length.step !== undefined) this._opacityFeatherEndSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._opacityFeatherEndSlider.value !== next) this._opacityFeatherEndSlider.value = next;
      }
      this._applyDefaultValue(this._opacityFeatherEndSlider, length.defaultValue);
      this._opacityFeatherEndSlider.disabled = !state.end.enabled || !!length.disabled;
      if (this._opacityFeatherEndValue) {
        this._syncDisplayValue(this._opacityFeatherEndValue, length, { disabled: !state.end.enabled });
      }
    }
    if (this._opacityFeatherHint) {
      const text = state.hint || '';
      this._opacityFeatherHint.textContent = text;
      this._opacityFeatherHint.classList.toggle('is-hidden', !text);
    }
  }

  _handleOpacityFeatherToggle(event, endpoint) {
    const checkbox = event?.currentTarget || event?.target;
    if (!checkbox) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setOpacityFeatherEnabled', endpoint, !!checkbox.checked);
    }
  }

  _handleOpacityFeatherLength(event, endpoint, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setOpacityFeatherLength', endpoint, slider.value, !!commit);
    }
  }

  _bindCustomToggles() {
    if (!this.element) return;
    const toggles = this.element.querySelectorAll('[data-fa-nexus-custom-toggle]');
    for (const toggle of toggles) {
      if (this._customToggleBindings.has(toggle)) continue;
      const id = toggle.getAttribute('data-fa-nexus-custom-toggle');
      if (!id) continue;
      const handler = (event) => {
        event.target.indeterminate = false;
        const next = !!event.target.checked;
        const result = this._controller?.requestCustomToggle?.(id, next);
        if (result && typeof result.then === 'function') {
          result.then((success) => {
            if (success === false) event.target.checked = !next;
          }).catch(() => {
            event.target.checked = !next;
          });
        } else if (result === false) {
          event.target.checked = !next;
        }
      };
      toggle.addEventListener('change', handler);
      this._customToggleBindings.set(toggle, handler);
    }
    this._syncCustomToggles();
  }

  _syncCustomToggles() {
    if (!this.element) return;
    const stateList = [];
    if (Array.isArray(this._toolOptionState?.customToggles)) {
      stateList.push(...this._toolOptionState.customToggles);
    }
    if (Array.isArray(this._toolOptionState?.subtoolToggles)) {
      stateList.push(...this._toolOptionState.subtoolToggles);
    }
    const stateMap = new Map();
    for (const toggle of stateList) {
      if (!toggle || typeof toggle !== 'object') continue;
      const id = String(toggle.id || '');
      if (!id) continue;
      stateMap.set(id, toggle);
    }
    const toggles = this.element.querySelectorAll('[data-fa-nexus-custom-toggle]');
    for (const toggle of toggles) {
      const id = toggle.getAttribute('data-fa-nexus-custom-toggle');
      let state = stateMap.get(id) || null;
      if (!state) {
        const controlId = toggle.closest?.('[data-fa-nexus-declarative-control]')?.getAttribute?.('data-fa-nexus-declarative-control') || '';
        const control = this._getPreparedDeclarativeControl(controlId);
        if (control?.type === 'segmented') {
          state = Array.isArray(control.options) ? control.options.find((option) => option.id === id) || null : null;
        } else if (control?.type === 'toggle-list') {
          state = Array.isArray(control.items) ? control.items.find((item) => item.id === id) || null : null;
        }
      }
      state = state || {};
      toggle.checked = !!state.enabled;
      toggle.disabled = !!state.disabled;
      if (state.tooltip) toggle.title = String(state.tooltip);
      const optionRoot = toggle.closest('.fa-nexus-declarative-segmented__option');
      if (optionRoot) {
        optionRoot.classList.toggle('is-active', !!state.enabled);
        optionRoot.classList.toggle('is-disabled', !!state.disabled);
        if (state.tooltip) optionRoot.title = String(state.tooltip);
      }
    }
  }

  _handlePlacementPush(event, direction = 'top') {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const handlerId = direction === 'bottom' ? 'pushSelectedWallToBottom' : 'pushSelectedWallToTop';
    try { this._controller?.invokeToolHandler?.(handlerId); }
    catch (_) {}
  }

  _bindPlacementControls() {
    const root = this.element?.querySelector('[data-fa-nexus-placement-root]');
    if (!root) {
      this._unbindPlacementControls();
      return;
    }
    this._placementRoot = root;
    this._placementSwitchRoots = Array.from(root.querySelectorAll('[data-fa-nexus-switch]') || []);
    const pushTop = root.querySelector('[data-fa-nexus-stack-top]');
    if (pushTop) {
      pushTop.addEventListener('click', this._boundPlacementPushTop);
      this._placementPushTopButton = pushTop;
    }
    const pushBottom = root.querySelector('[data-fa-nexus-stack-bottom]');
    if (pushBottom) {
      pushBottom.addEventListener('click', this._boundPlacementPushBottom);
      this._placementPushBottomButton = pushBottom;
    }
    this._placementOrderDisplay = root.querySelector('[data-fa-nexus-placement-order]') || null;
    this._placementHint = root.querySelector('[data-fa-nexus-placement-hint]') || null;
    this._placementStateLabels = Array.from(root.querySelectorAll('[data-fa-nexus-switch-state]') || []);
    this._syncPlacementControls();
  }

  _unbindPlacementControls() {
    if (this._placementPushTopButton) {
      try { this._placementPushTopButton.removeEventListener('click', this._boundPlacementPushTop); }
      catch (_) {}
      this._placementPushTopButton = null;
    }
    if (this._placementPushBottomButton) {
      try { this._placementPushBottomButton.removeEventListener('click', this._boundPlacementPushBottom); }
      catch (_) {}
      this._placementPushBottomButton = null;
    }
    this._placementRoot = null;
    this._placementOrderDisplay = null;
    this._placementHint = null;
    this._placementStateLabels = [];
    this._placementSwitchRoots = [];
  }

  _syncPlacementControls() {
    if (!this._placementRoot) return;
    const stateList = Array.isArray(this._toolOptionState?.customToggles)
      ? this._toolOptionState.customToggles
      : [];
    const stateMap = new Map();
    for (const toggle of stateList) {
      if (!toggle || typeof toggle !== 'object') continue;
      const id = String(toggle.id || '');
      if (!id.length) continue;
      stateMap.set(id, toggle);
    }
    if (Array.isArray(this._placementSwitchRoots)) {
      for (const root of this._placementSwitchRoots) {
        const id = root?.dataset?.faNexusSwitch || root?.getAttribute?.('data-fa-nexus-switch') || '';
        if (!id) continue;
        const state = stateMap.get(id) || {};
        const input = root.querySelector('input[type="checkbox"]');
        if (input) {
          input.checked = !!state.enabled;
          input.disabled = !!state.disabled;
        }
        root.classList.toggle('is-on', !!state.enabled);
        root.classList.toggle('is-disabled', !!state.disabled);
      }
    }
    if (Array.isArray(this._placementStateLabels)) {
      for (const label of this._placementStateLabels) {
        const rawId = label?.dataset?.faNexusSwitchState || label?.getAttribute?.('data-fa-nexus-switch-state') || '';
        if (!rawId) continue;
        const baseId = rawId.replace(/-on$|-off$/, '');
        const state = stateMap.get(baseId) || {};
        const isOn = !!state.enabled;
        const onLabel = typeof state.onLabel === 'string' && state.onLabel.length ? state.onLabel : 'On';
        const offLabel = typeof state.offLabel === 'string' && state.offLabel.length ? state.offLabel : 'Off';
        const wantOn = rawId.endsWith('-on');
        const text = wantOn ? onLabel : offLabel;
        if (label.textContent !== text) label.textContent = text;
        label.classList.toggle('is-active', (wantOn && isOn) || (!wantOn && !isOn));
      }
    }
    const stacking = this._toolOptionState?.shapeStacking || { available: false };
    const available = !!stacking.available;
    if (this._placementPushTopButton) {
      this._placementPushTopButton.disabled = !available || !!stacking.pushTopDisabled;
    }
    if (this._placementPushBottomButton) {
      this._placementPushBottomButton.disabled = !available || !!stacking.pushBottomDisabled;
    }
    if (this._placementOrderDisplay) {
      const text = available ? (stacking.orderLabel || '') : '';
      this._placementOrderDisplay.textContent = text;
      this._placementOrderDisplay.classList.toggle('is-hidden', !text);
    }
    if (this._placementHint) {
      const hint = available ? (stacking.hint || '') : '';
      this._placementHint.textContent = hint;
      this._placementHint.classList.toggle('is-hidden', !hint);
    }
  }

  _getPreparedPortalControl(controlId = '') {
    const id = String(controlId || '');
    if (!id) return null;
    const control = this._getPreparedDeclarativeControl(id);
    return control?.type === 'portal-controls' ? control : null;
  }

  _getPreparedPortalControlFromEvent(event) {
    return this._getPortalControlRuntime().getControlFromEvent(event);
  }

  _coercePortalControlValue(value, mode = 'string') {
    switch (mode) {
      case 'number': {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : 0;
      }
      case 'door-direction': {
        const numeric = Number(value);
        return numeric === -1 ? -1 : 1;
      }
      default:
        return value ?? '';
    }
  }

  _getPortalSectionCollapseKey(controlId = '', sectionId = '') {
    const activeId = String(this._activeTool?.id || '');
    const controlKey = String(controlId || '');
    const sectionKey = String(sectionId || '');
    if (!activeId || !controlKey || !sectionKey) return '';
    return `${activeId}::${controlKey}::${sectionKey}`;
  }

  _isPortalSectionCollapsed(controlId = '', sectionId = '') {
    const key = this._getPortalSectionCollapseKey(controlId, sectionId);
    return key ? !!this._portalSectionCollapsedByKey.get(key) : false;
  }

  _togglePortalSectionCollapsed(controlId = '', sectionId = '') {
    const key = this._getPortalSectionCollapseKey(controlId, sectionId);
    if (!key) return false;
    const next = !this._portalSectionCollapsedByKey.get(key);
    if (next) this._portalSectionCollapsedByKey.set(key, true);
    else this._portalSectionCollapsedByKey.delete(key);
    return next;
  }

  _syncPortalControls() {
    this._getPortalControlRuntime().syncControls();
  }

  _schedulePortalControlsSync() {
    this._getPortalControlRuntime().scheduleSync();
  }

  _syncPortalControlRoot(root, control) {
    this._getPortalControlRuntime().syncControlRoot(root, control);
  }

  _handlePortalAction(event) {
    this._getPortalControlRuntime().handleAction(event);
  }

  _handlePortalToggle(event) {
    this._getPortalControlRuntime().handleToggle(event);
  }

  _handlePortalColorTarget(event) {
    this._getPortalControlRuntime().handleColorTarget(event);
  }

  _handlePortalSelect(event) {
    this._getPortalControlRuntime().handleSelect(event);
  }

  _handlePortalSectionToggle(event) {
    this._getPortalControlRuntime().handleSectionToggle(event);
  }

  _handlePortalSetting(event, commit) {
    this._getPortalControlRuntime().handleSetting(event, commit);
  }

  _bindShortcutsControls() {
    this._shortcutsRoot = null;
    this._shortcutsToggle = null;
    this._shortcutsContent = null;
    const root = this.element?.querySelector('[data-fa-nexus-shortcuts-root]');
    if (!root) return;
    this._shortcutsRoot = root;
    const toggle = root.querySelector('[data-fa-nexus-shortcuts-toggle]');
    if (toggle) {
      toggle.addEventListener('click', this._boundShortcutsToggle);
      this._shortcutsToggle = toggle;
    }
    this._shortcutsContent = root.querySelector('[data-fa-nexus-shortcuts-content]');
    this._syncShortcutsControls();
  }

  _unbindShortcutsControls() {
    if (this._shortcutsToggle) {
      try { this._shortcutsToggle.removeEventListener('click', this._boundShortcutsToggle); }
      catch (_) {}
    }
    this._shortcutsRoot = null;
    this._shortcutsToggle = null;
    this._shortcutsContent = null;
  }

  _restoreShortcutsState() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.get !== 'function') return;
    try {
      const saved = settings.get(MODULE_ID, SHORTCUTS_SETTING_KEY);
      this._applyShortcutsSetting(saved);
    } catch (_) {
      // ignore malformed data
    }
  }

  _applyShortcutsSetting(raw) {
    const next = new Map();
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        const toolId = String(key || '');
        if (!toolId || !value) continue;
        next.set(toolId, true);
      }
    }

    let changed = next.size !== this._shortcutsCollapsedByTool.size;
    if (!changed) {
      for (const [toolId] of next) {
        if (!this._shortcutsCollapsedByTool.has(toolId)) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        for (const key of this._shortcutsCollapsedByTool.keys()) {
          if (!next.has(key)) {
            changed = true;
            break;
          }
        }
      }
    }

    if (!changed) {
      // Still ensure current collapsed flag reflects persisted data
      const activeId = this._activeTool?.id;
      this._shortcutsCollapsed = !!(activeId && next.has(activeId));
      this._syncShortcutsControls();
      return;
    }

    this._shortcutsCollapsedByTool.clear();
    for (const [toolId] of next) {
      this._shortcutsCollapsedByTool.set(toolId, true);
    }

    const activeId = this._activeTool?.id;
    this._shortcutsCollapsed = !!(activeId && this._shortcutsCollapsedByTool.has(activeId));
    this._syncShortcutsControls();
  }

  applyShortcutsSetting(raw) {
    this._applyShortcutsSetting(raw);
  }

  _persistShortcutsState() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.set !== 'function') return;
    try {
      const payload = {};
      for (const [toolId] of this._shortcutsCollapsedByTool) {
        if (!toolId) continue;
        payload[toolId] = true;
      }
      const maybePromise = settings.set(MODULE_ID, SHORTCUTS_SETTING_KEY, payload);
      if (maybePromise?.catch) {
        maybePromise.catch((error) => {
          Logger.warn('ToolOptionsWindow.shortcuts.persistFailed', {
            toolIds: Object.keys(payload),
            error: String(error?.message || error)
          });
        });
      }
    } catch (error) {
      Logger.warn('ToolOptionsWindow.shortcuts.persistFailed', {
        error: String(error?.message || error)
      });
    }
  }

  _syncShortcutsControls() {
    const root = this._shortcutsRoot;
    if (!root) return;
    const collapsed = !!this._shortcutsCollapsed;
    root.classList.toggle('is-collapsed', collapsed);
    if (this._shortcutsToggle) {
      this._shortcutsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    if (this._shortcutsContent) {
      this._shortcutsContent.hidden = collapsed;
    }
  }

  _handleShortcutsToggle(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._shortcutsCollapsed = !this._shortcutsCollapsed;
    const activeId = this._activeTool?.id;
    if (activeId) {
      if (this._shortcutsCollapsed) this._shortcutsCollapsedByTool.set(activeId, true);
      else this._shortcutsCollapsedByTool.delete(activeId);
      this._persistShortcutsState();
    }
    this._syncShortcutsControls();
  }

  _shouldIgnoreWindowShortcut(event) {
    try {
      const target = event?.target ?? document?.activeElement ?? null;
      if (!target || target === document.body) return false;
      if (target.dataset?.faNexusHotkeys === 'allow') return false;
      if (typeof target.isContentEditable === 'boolean' && target.isContentEditable) return true;
      const tag = target.tagName ? String(target.tagName).toLowerCase() : '';
      if (!tag) return false;
      if (tag === 'textarea' || tag === 'select') return true;
      if (tag !== 'input') return false;
      const type = typeof target.type === 'string' ? target.type.toLowerCase() : '';
      const allowTypes = ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden'];
      if (!type) return true;
      return !allowTypes.includes(type);
    } catch (_) {
      return false;
    }
  }

  _handleHelpOpen(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    this._controller?.openActiveToolHelp?.({ focus: true });
  }

  _handleWindowKeyDown(event) {
    if (!isHelpShortcut(event)) return;
    if (this._shouldIgnoreWindowShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    this._controller?.openActiveToolHelp?.({ focus: true });
  }

  _bindPlaceAsControls() {
    this._placeAsControlsWorkflow.bind();
  }

  _unbindPlaceAsControls() {
    this._placeAsControlsWorkflow.unbind();
  }

  _syncPlaceAsControls() {
    this._placeAsControlsWorkflow.sync();
  }

  _handlePlaceAsSearch(event) {
    return this._placeAsControlsWorkflow.handleSearch(event);
  }

  _handlePlaceAsOptionClick(event) {
    return this._placeAsControlsWorkflow.handleOptionClick(event);
  }

  _handlePlaceAsLinked(event) {
    return this._placeAsControlsWorkflow.handleLinked(event);
  }

  _handlePlaceAsActorType(event) {
    return this._placeAsControlsWorkflow.handleActorType(event);
  }

  _handlePlaceAsAppendNumber(event) {
    return this._placeAsControlsWorkflow.handleAppendNumber(event);
  }

  _handlePlaceAsPrependAdjective(event) {
    return this._placeAsControlsWorkflow.handlePrependAdjective(event);
  }

  _handlePlaceAsToggle(event) {
    return this._placeAsControlsWorkflow.handleToggle(event);
  }

  _handlePlaceAsFilter(event) {
    return this._placeAsControlsWorkflow.handleFilter(event);
  }

  _handlePlaceAsHpMode(event) {
    return this._placeAsControlsWorkflow.handleHpMode(event);
  }

  _handlePlaceAsHpPercent(event) {
    return this._placeAsControlsWorkflow.handleHpPercent(event);
  }

  _handlePlaceAsHpStatic(event) {
    return this._placeAsControlsWorkflow.handleHpStatic(event);
  }

}

export function installToolOptionsWindowControlMethods(ToolOptionsWindowClass) {
  const descriptors = Object.getOwnPropertyDescriptors(ToolOptionsWindowControlMethods.prototype);
  delete descriptors.constructor;
  Object.defineProperties(ToolOptionsWindowClass.prototype, descriptors);
}
