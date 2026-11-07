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
import { prepareDeclarativePortalControl } from './portal-control-preparation.js';
import {
  shouldForceToolOptionsRenderForStateChange,
  syncToolOptionsWindowInPlace
} from './render-update-plan.js';

class ToolOptionsWindowRenderMethods {
  _syncDropShadowPreview(preview) {
    this._dropShadowControlsWorkflow.syncPreview(preview);
  }

  applyDropShadowPreview(preview) {
    if (!this._toolOptionState || typeof this._toolOptionState !== 'object') {
      this._toolOptionState = {};
    }
    const controls = this._toolOptionState.dropShadowControls && typeof this._toolOptionState.dropShadowControls === 'object'
      ? this._toolOptionState.dropShadowControls
      : {};
    if (preview && typeof preview === 'object' && typeof preview.src === 'string' && preview.src.length > 0) {
      controls.preview = preview;
    } else {
      delete controls.preview;
    }
    this._toolOptionState.dropShadowControls = controls;
    if (this.rendered) this._syncDropShadowPreview(controls.preview || null);
  }


  _shouldForceRenderForStateChange(previousState = {}, nextState = {}) {
    return shouldForceToolOptionsRenderForStateChange(previousState, nextState, {
      preparePortalControl: (control, id) => this._prepareDeclarativePortalControl(control, id)
    });
  }

  setActiveToolOptions(options = {}, { suppressRender = false } = {}) {
    const nextState = options && typeof options === 'object' ? options : {};
    const previousState = this._toolOptionState && typeof this._toolOptionState === 'object'
      ? this._toolOptionState
      : {};
    this._activeNormalizedOptions = this._activeTool?.id
      ? (this._controller?._getToolNormalized?.(this._activeTool.id) || null)
      : null;
    const forceRender = suppressRender && this.rendered && this._shouldForceRenderForStateChange(previousState, nextState);
    this._toolOptionState = nextState;
    if (this.rendered && (!suppressRender || forceRender)) this.render(false);
    else if (this.rendered) syncToolOptionsWindowInPlace(this);
  }

  _resolveWindowTitle() {
    const label = typeof this._activeTool?.label === 'string' ? this._activeTool.label.trim() : '';
    if (label.length > 0) return `${label} Options`;
    return DEFAULT_WINDOW_TITLE;
  }

  _syncWindowTitle() {
    const title = this._resolveWindowTitle();
    try {
      if (!this.options.window || typeof this.options.window !== 'object') this.options.window = {};
      this.options.window.title = title;
    } catch (_) {}
    try {
      const appWindow = this.window;
      if (appWindow) {
        if (typeof appWindow.setTitle === 'function') appWindow.setTitle(title);
        else if (appWindow.title && typeof appWindow.title === 'object') appWindow.title.textContent = title;
      }
    } catch (_) {}
    try {
      const headerTitle = this.element?.querySelector('.window-title');
      if (headerTitle) headerTitle.textContent = title;
    } catch (_) {}
  }

  refreshToolSections() {
    this._syncDynamicSections();
  }

  _shouldUseDynamicSections() {
    const activeId = this._activeTool?.id;
    const normalized = activeId ? this._controller?._getToolNormalized?.(activeId) : null;
    if (!normalized) return false;
    return normalized.rendererMode !== TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE;
  }

  _blockMatchesSelector(block, selector) {
    if (!block || typeof block.matches !== 'function') return false;
    if (block.matches(selector)) return true;
    if (typeof block.querySelector !== 'function') return false;
    return !!block.querySelector(selector);
  }

  _classifyToolOptionBlock(block) {
    if (!block || typeof block.matches !== 'function') return null;
    if (this._blockMatchesSelector(block, '#fa-nexus-drop-shadow-toggle, [data-fa-nexus-drop-shadow-root]')) return 'appearance';
    if (this._blockMatchesSelector(block, '[data-fa-nexus-subtools-root], [data-fa-nexus-subtool-options-root], [data-fa-nexus-texture-tools-root]')) return 'mode';
    if (this._blockMatchesSelector(block, '[data-fa-nexus-editor-actions-root]')) return 'session';
    if (this._blockMatchesSelector(block, '[data-fa-nexus-path-simplify-root], [data-fa-nexus-path-feather], [data-fa-nexus-opacity-feather]')) return 'brush-geometry';
    if (this._blockMatchesSelector(block, '[data-fa-nexus-placement-root]')) return 'placement';
    if (this._blockMatchesSelector(block, '[data-fa-nexus-path-opacity-root], [data-fa-nexus-path-scale-root], [data-fa-nexus-path-offset-root], [data-fa-nexus-path-tension-root], [data-fa-nexus-show-width-tangents-root], [data-fa-nexus-scale-root], [data-fa-nexus-rotation-root], [data-fa-nexus-flip-root], [data-fa-nexus-path-shadow]')) return 'appearance';
    if (block.matches('.fa-nexus-tool-options__toggle') && this._blockMatchesSelector(block, '[data-fa-nexus-custom-toggle]')) return 'placement';
    return null;
  }

  _getDynamicSectionLayout(sectionIds = []) {
    const activeId = this._activeTool?.id;
    const controllerLayout = Array.isArray(this._controller?.getToolSectionLayout?.(activeId))
      ? this._controller.getToolSectionLayout(activeId)
      : [];
    const ordered = new Map();
    for (const section of controllerLayout) {
      const sectionId = String(section?.id || '');
      if (!sectionId) continue;
      ordered.set(sectionId, {
        id: sectionId,
        label: typeof section?.label === 'string' && section.label.trim().length
          ? section.label.trim()
          : getToolSectionLabel(sectionId),
        collapsed: !!section?.collapsed
      });
    }
    for (const rawId of sectionIds) {
      const sectionId = String(rawId || '');
      if (!sectionId || ordered.has(sectionId)) continue;
      ordered.set(sectionId, {
        id: sectionId,
        label: getToolSectionLabel(sectionId),
        collapsed: !!this._controller?._isSectionCollapsed?.(activeId, sectionId)
      });
    }
    return Array.from(ordered.values());
  }

  _createToolSection(section = {}) {
    const sectionId = String(section?.id || '');
    if (!sectionId) return null;
    const label = typeof section?.label === 'string' && section.label.trim().length
      ? section.label.trim()
      : getToolSectionLabel(sectionId);
    const collapsed = !!section?.collapsed;

    const root = document.createElement('section');
    root.className = 'fa-nexus-tool-options__section fa-nexus-tool-section';
    root.setAttribute('data-fa-nexus-tool-section', sectionId);
    if (collapsed) root.classList.add('is-collapsed');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'fa-nexus-tool-section__toggle';
    toggle.setAttribute('data-fa-nexus-section-toggle', sectionId);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.title = `${collapsed ? 'Expand' : 'Collapse'} ${label}`;

    const icon = document.createElement('i');
    icon.className = 'fas fa-chevron-down';
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'fa-nexus-tool-section__label';
    text.textContent = label;

    toggle.append(icon, text);

    const body = document.createElement('div');
    body.className = 'fa-nexus-tool-section__body';
    body.setAttribute('data-fa-nexus-section-body', sectionId);
    if (collapsed) body.setAttribute('aria-hidden', 'true');

    root.append(toggle, body);
    return root;
  }

  _rebuildDynamicSections() {
    if (!this._shouldUseDynamicSections()) return;
    const content = this.element?.querySelector('[data-fa-nexus-scroll-container]');
    if (!content) return;
    const directChildren = Array.from(content.children).filter((node) => node?.nodeType === 1);
    const mainSection = directChildren.find((node) => (
      node.matches?.('.fa-nexus-tool-options__section')
      && !node.classList.contains('fa-nexus-place-as')
      && !node.hasAttribute('data-fa-nexus-tool-section')
      && !node.querySelector?.('.fa-nexus-tool-options__empty')
    ));
    if (!mainSection) return;

    const blocks = Array.from(mainSection.children).filter((node) => node?.nodeType === 1);
    if (!blocks.length) return;

    const grouped = new Map();
    for (const block of blocks) {
      const sectionId = this._classifyToolOptionBlock(block) || 'placement';
      if (!grouped.has(sectionId)) grouped.set(sectionId, []);
      grouped.get(sectionId).push(block);
    }
    if (!grouped.size) return;

    const layout = this._getDynamicSectionLayout(Array.from(grouped.keys()));
    if (!layout.length) return;

    const fragment = document.createDocumentFragment();
    let hasRenderedSection = false;
    for (const section of layout) {
      const nodes = grouped.get(section.id);
      if (!Array.isArray(nodes) || !nodes.length) continue;
      const sectionRoot = this._createToolSection(section);
      const body = sectionRoot?.querySelector?.('[data-fa-nexus-section-body]');
      if (!sectionRoot || !body) continue;
      for (const node of nodes) body.appendChild(node);
      fragment.appendChild(sectionRoot);
      hasRenderedSection = true;
    }
    if (!hasRenderedSection) return;

    content.insertBefore(fragment, mainSection);
    mainSection.remove();
  }

  _bindToolSectionControls() {
    this._sectionRoots.clear();
    this._sectionToggleButtons.clear();
    this._sectionBodies.clear();
    const root = this.element;
    if (!root) return;
    const sections = root.querySelectorAll('[data-fa-nexus-tool-section]');
    for (const sectionRoot of sections) {
      const sectionId = String(sectionRoot.getAttribute('data-fa-nexus-tool-section') || '');
      if (!sectionId) continue;
      this._sectionRoots.set(sectionId, sectionRoot);
      const toggle = sectionRoot.querySelector('[data-fa-nexus-section-toggle]');
      if (toggle) {
        toggle.addEventListener('click', this._boundSectionToggle);
        this._sectionToggleButtons.set(sectionId, toggle);
      }
      const body = sectionRoot.querySelector('[data-fa-nexus-section-body]');
      if (body) this._sectionBodies.set(sectionId, body);
    }
    this._syncDynamicSections();
  }

  _unbindToolSectionControls() {
    for (const toggle of this._sectionToggleButtons.values()) {
      try { toggle.removeEventListener('click', this._boundSectionToggle); } catch (_) {}
    }
    this._sectionRoots.clear();
    this._sectionToggleButtons.clear();
    this._sectionBodies.clear();
  }

  _syncDynamicSections() {
    const activeId = this._activeTool?.id;
    if (!activeId || !this._sectionRoots.size) return;
    for (const [sectionId, sectionRoot] of this._sectionRoots.entries()) {
      const collapsed = !!this._controller?._isSectionCollapsed?.(activeId, sectionId);
      sectionRoot.classList.toggle('is-collapsed', collapsed);
      const toggle = this._sectionToggleButtons.get(sectionId);
      if (toggle) {
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.title = `${collapsed ? 'Expand' : 'Collapse'} ${getToolSectionLabel(sectionId)}`;
      }
      const body = this._sectionBodies.get(sectionId);
      if (body) body.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    }
  }

  _handleSectionToggle(event) {
    const button = event?.currentTarget || event?.target?.closest?.('[data-fa-nexus-section-toggle]');
    const sectionId = String(button?.getAttribute?.('data-fa-nexus-section-toggle') || '');
    const activeId = this._activeTool?.id;
    if (!sectionId || !activeId) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    this._controller?.toggleSectionCollapse?.(activeId, sectionId);
    this._syncDynamicSections();
  }

  async _prepareContext() {
    const tool = this._activeTool;
    const canToggleGridSnap = !!(this._controller?.supportsGridSnap?.() && this._gridSnapAvailable);
    const gridSnapResolution = this._prepareGridSnapResolution();
    const options = this._toolOptionState || {};
    const help = this._controller?.getToolHelpContext?.(tool?.id) || { available: false };
    const normalized = this._activeNormalizedOptions
      || (tool?.id ? this._controller?._getToolNormalized?.(tool.id) || null : null);
    if (normalized?.rendererMode === TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE) {
      return this._prepareDeclarativeContext({
        tool,
        normalized,
        help,
        canToggleGridSnap,
        gridSnapResolution
      });
    }
    const dropShadow = options.dropShadow || {};
    const dropShadowTooltip = typeof dropShadow.tooltip === 'string' && dropShadow.tooltip.length
      ? dropShadow.tooltip
      : 'Toggle drop shadows for asset placements.';
    const dropShadowHint = typeof dropShadow.hint === 'string' ? dropShadow.hint : '';
    const dropShadowControls = prepareDropShadowControls(options.dropShadowControls, dropShadow);
    const hintLines = (() => {
      if (Array.isArray(options.hints)) {
        return options.hints.filter((line) => typeof line === 'string' && line.trim().length).map((line) => line.trim());
      }
      if (typeof options.hints === 'string' && options.hints.trim().length) {
        return [options.hints.trim()];
      }
      return [];
    })();
    const shortcuts = {
      available: hintLines.length > 0,
      collapsed: !!this._shortcutsCollapsed,
      lines: hintLines
    };
    const mapToggle = (toggle) => ({
      id: String(toggle?.id || ''),
      group: typeof toggle?.group === 'string' ? toggle.group : '',
      label: String(toggle?.label || ''),
      tooltip: String(toggle?.tooltip || ''),
      onLabel: typeof toggle?.onLabel === 'string' ? toggle.onLabel : '',
      offLabel: typeof toggle?.offLabel === 'string' ? toggle.offLabel : '',
      enabled: !!toggle?.enabled,
      disabled: !!toggle?.disabled
    });
    const mapAction = (action) => ({
      id: String(action?.id || ''),
      label: String(action?.label || ''),
      tooltip: String(action?.tooltip || ''),
      primary: !!action?.primary,
      disabled: !!action?.disabled
    });
    const allToggleList = Array.isArray(options.customToggles)
      ? options.customToggles.map(mapToggle).filter((toggle) => toggle.id.length)
      : [];
    const subtoolToggleList = Array.isArray(options.subtoolToggles)
      ? options.subtoolToggles.map(mapToggle).filter((toggle) => toggle.id.length)
      : allToggleList.filter((toggle) => toggle.group === 'subtool');
    const subtoolOptionToggleList = allToggleList.filter((toggle) => toggle.group === 'subtool-option');
    const nonSubtoolToggleList = allToggleList.filter((toggle) => !['subtool', 'subtool-option', 'height-map'].includes(toggle.group));
    const placementToggleList = nonSubtoolToggleList.filter((toggle) => toggle.group === 'placement');
    const customToggleList = nonSubtoolToggleList.filter((toggle) => toggle.group !== 'placement');
    const editorActionList = Array.isArray(options.editorActions)
      ? options.editorActions.map(mapAction).filter((action) => action.id.length)
      : [];
    const placeAs = options.placeAs && typeof options.placeAs === 'object' ? options.placeAs : null;
    const scale = prepareScaleContext(options.scale);
    const rotation = prepareRotationContext(options.rotation);
    const flip = prepareFlipContext(options.flip);
    const pathShadow = preparePathShadowContext(options.pathShadow);
    const pathAppearance = preparePathAppearanceContext(options.pathAppearance);
    const pathFeather = preparePathFeatherContext(options.pathFeather);
    const opacityFeather = prepareOpacityFeatherContext(options.opacityFeather);
    const shapeStacking = prepareShapeStackingContext(options.shapeStacking);
    return {
      isDeclarative: false,
      hasActiveTool: !!tool,
      activeToolId: tool?.id ?? null,
      activeToolLabel: tool?.label ?? '',
      gridSnapEnabled: !!this._gridSnapEnabled,
      gridSnapAvailable: canToggleGridSnap,
      gridSnapResolution,
      showDropShadowToggle: !!dropShadow.available,
      dropShadowEnabled: !!dropShadow.enabled,
      dropShadowDisabled: !!dropShadow.disabled,
      dropShadowTooltip,
      dropShadowHint: dropShadowHint,
      dropShadowControls,
      help,
      shortcuts,
      hasSubtoolToggles: subtoolToggleList.length > 0,
      subtoolToggles: subtoolToggleList,
      hasSubtoolOptions: subtoolOptionToggleList.length > 0,
      subtoolOptions: subtoolOptionToggleList,
      hasEditorActions: editorActionList.length > 0,
      editorActions: editorActionList,
      hasPlacementToggles: placementToggleList.length > 0,
      placementToggles: placementToggleList,
      hasCustomToggles: customToggleList.length > 0,
      customToggles: customToggleList,
      flip,
      scale,
      placeAs: placeAs || { available: false },
      rotation,
      pathShadow,
      pathAppearance,
      pathFeather,
      opacityFeather,
      shapeStacking
    };
  }

  _prepareDeclarativeContext({
    tool = null,
    normalized = null,
    help = { available: false },
    canToggleGridSnap = false,
    gridSnapResolution = { available: false }
  } = {}) {
    const sections = Array.isArray(normalized?.sections) ? normalized.sections : [];
    const controls = normalized?.controls && typeof normalized.controls === 'object'
      ? normalized.controls
      : {};
    const preparedSections = [];
    for (const rawSection of sections) {
      const sectionId = String(rawSection?.id || '');
      if (!sectionId) continue;
      const label = typeof rawSection?.label === 'string' && rawSection.label.trim().length
        ? rawSection.label.trim()
        : getToolSectionLabel(sectionId);
      const region = typeof rawSection?.region === 'string' && rawSection.region.trim().length
        ? rawSection.region.trim()
        : 'body';
      const preparedControls = [];
      for (const controlId of Array.isArray(rawSection?.controls) ? rawSection.controls : []) {
        const preparedControl = this._prepareDeclarativeControl(controls[controlId]);
        if (preparedControl) preparedControls.push(preparedControl);
      }
      if (!preparedControls.length) continue;
      const collapsible = region === 'body' && rawSection?.collapsible !== false;
      const headerToggle = this._prepareDeclarativeSectionHeaderToggle({
        label,
        controls: preparedControls
      });
      const sectionControls = headerToggle
        ? preparedControls.map((control) => {
          if (control?.id !== headerToggle.controlId) return control;
          const nextControl = {
            ...control,
            toggleInSectionHeader: true
          };
          if (collapsible && nextControl.controls && typeof nextControl.controls === 'object') {
            const collapse = nextControl.controls.collapse && typeof nextControl.controls.collapse === 'object'
              ? nextControl.controls.collapse
              : {};
            nextControl.controls = {
              ...nextControl.controls,
              collapsed: false,
              collapse: {
                ...collapse,
                available: false,
                collapsed: false
              }
            };
          }
          return nextControl;
        })
        : preparedControls;
      preparedSections.push({
        id: sectionId,
        label,
        region,
        collapsible,
        collapsed: collapsible ? !!this._controller?._isSectionCollapsed?.(tool?.id, sectionId) : false,
        showHeading: rawSection?.showHeading !== false,
        headerToggle,
        controls: sectionControls
      });
    }

    const headerSections = preparedSections.filter((section) => section.region === 'header');
    const bodySections = preparedSections.filter((section) => !['header', 'footer', 'footer-snap'].includes(section.region));
    const footerSections = preparedSections.filter((section) => section.region === 'footer');
    const footerSnapControls = preparedSections
      .filter((section) => section.region === 'footer-snap')
      .flatMap((section) => section.controls);
    const hasModeRail = preparedSections.some((section) => section.controls.some(
      (control) => control?.type === 'segmented' && control?.variant === 'mode-rail'
    ));
    const placeAs = normalized?.legacyState?.placeAs && typeof normalized.legacyState.placeAs === 'object'
      ? normalized.legacyState.placeAs
      : null;

    return {
      isDeclarative: true,
      footerSnapControls,
      hasActiveTool: !!tool,
      activeToolId: tool?.id ?? null,
      activeToolLabel: tool?.label ?? '',
      gridSnapEnabled: !!this._gridSnapEnabled,
      gridSnapAvailable: canToggleGridSnap,
      gridSnapResolution,
      help,
      placeAs: placeAs || { available: false },
      declarative: {
        hasModeRail,
        hasHeaderSections: headerSections.length > 0,
        hasBodySections: bodySections.length > 0,
        hasFooterSections: footerSections.length > 0,
        headerSections,
        bodySections,
        footerSections
      }
    };
  }

  _prepareDeclarativeSectionHeaderToggle({
    label = '',
    controls = []
  } = {}) {
    if (!Array.isArray(controls) || controls.length !== 1) return null;
    const control = controls[0];
    if (!control || control.type !== 'drop-shadow') return null;
    const toggle = control.toggle && typeof control.toggle === 'object' ? control.toggle : null;
    if (!toggle?.available) return null;
    const tooltip = typeof toggle.tooltip === 'string' && toggle.tooltip.length
      ? toggle.tooltip
      : (typeof toggle.hint === 'string' ? toggle.hint : '');
    return {
      controlId: String(control.id || ''),
      checked: !!toggle.enabled,
      disabled: !!toggle.disabled,
      text: 'Enabled',
      ariaLabel: typeof toggle.label === 'string' && toggle.label.trim().length
        ? toggle.label.trim()
        : (label ? `Toggle ${label}` : 'Toggle drop shadow'),
      tooltip
    };
  }

  _prepareDeclarativeControl(control = null) {
    if (!control || typeof control !== 'object') return null;
    const id = String(control.id || '');
    const type = String(control.type || '');
    if (!id || !type) return null;

    const mapToggle = (toggle) => ({
      id: String(toggle?.id || ''),
      group: typeof toggle?.group === 'string' ? toggle.group : '',
      label: String(toggle?.label || ''),
      tooltip: String(toggle?.tooltip || ''),
      onLabel: typeof toggle?.onLabel === 'string' ? toggle.onLabel : '',
      offLabel: typeof toggle?.offLabel === 'string' ? toggle.offLabel : '',
      enabled: !!toggle?.enabled,
      disabled: !!toggle?.disabled,
      icon: typeof toggle?.icon === 'string' ? toggle.icon : '',
      tone: typeof toggle?.tone === 'string' ? toggle.tone : ''
    });
    const mapAction = (action) => ({
      id: String(action?.id || ''),
      label: String(action?.label || ''),
      tooltip: String(action?.tooltip || ''),
      primary: !!action?.primary,
      disabled: !!action?.disabled
    });

    if (type === 'segmented') {
      const options = Array.isArray(control.options)
        ? control.options.map(mapToggle).filter((option) => option.id.length)
        : [];
      if (!options.length) return null;
      return {
        ...control,
        id,
        type,
        inputType: control.multiple ? 'checkbox' : 'radio',
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        options
      };
    }

    if (type === 'toggle-list') {
      const items = Array.isArray(control.items)
        ? control.items.map(mapToggle).filter((item) => item.id.length)
        : [];
      if (!items.length) return null;
      return {
        ...control,
        id,
        type,
        inputType: 'checkbox',
        items
      };
    }

    if (type === 'action-row') {
      const actions = Array.isArray(control.actions)
        ? control.actions.map(mapAction).filter((action) => action.id.length)
        : [];
      if (!actions.length) return null;
      return {
        ...control,
        id,
        type,
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        previewHandlerId: typeof control.previewHandlerId === 'string' ? control.previewHandlerId : '',
        actions
      };
    }

    if (type === 'hint') {
      const text = typeof control.text === 'string' ? control.text.trim() : '';
      if (!text.length) return null;
      return {
        ...control,
        id,
        type,
        text
      };
    }

    if (type === 'toggle') {
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : id,
        tooltip: typeof control.tooltip === 'string' ? control.tooltip : '',
        hint: typeof control.hint === 'string' ? control.hint : '',
        value: !!control.value,
        disabled: !!control.disabled,
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        ...(control.handlerArg !== undefined ? { handlerArg: control.handlerArg } : {})
      };
    }

    if (type === 'select') {
      const options = Array.isArray(control.options)
        ? control.options
          .map((option, index) => {
            const value = option?.value ?? option?.id ?? index;
            return {
              value: String(value),
              label: typeof option?.label === 'string' && option.label.trim().length
                ? option.label.trim()
                : String(value),
              selected: !!option?.selected,
              disabled: !!option?.disabled
            };
          })
          .filter((option) => option.value.length)
        : [];
      if (!options.length) return null;
      const selectedValue = String(
        control.value
        ?? options.find((option) => option.selected)?.value
        ?? options[0]?.value
        ?? ''
      );
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : id,
        tooltip: typeof control.tooltip === 'string' ? control.tooltip : '',
        hint: typeof control.hint === 'string' ? control.hint : '',
        value: selectedValue,
        valueMode: typeof control.valueMode === 'string' && control.valueMode.trim().length
          ? control.valueMode.trim()
          : 'string',
        disabled: !!control.disabled,
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        options
      };
    }

    if (type === 'range') {
      const state = prepareDeclarativeRangeState(control);
      if (!state) return null;
      const rawHeaderToggle = control.headerToggle && typeof control.headerToggle === 'object'
        ? control.headerToggle
        : null;
      const headerToggle = rawHeaderToggle
        ? {
            label: typeof rawHeaderToggle.label === 'string' && rawHeaderToggle.label.trim().length
              ? rawHeaderToggle.label.trim()
              : '',
            value: !!rawHeaderToggle.value,
            disabled: !!rawHeaderToggle.disabled,
            tooltip: typeof rawHeaderToggle.tooltip === 'string' ? rawHeaderToggle.tooltip : '',
            ariaLabel: typeof rawHeaderToggle.ariaLabel === 'string' && rawHeaderToggle.ariaLabel.trim().length
              ? rawHeaderToggle.ariaLabel.trim()
              : '',
            handlerId: typeof rawHeaderToggle.handlerId === 'string' ? rawHeaderToggle.handlerId : '',
            ...(rawHeaderToggle.handlerArg !== undefined ? { handlerArg: rawHeaderToggle.handlerArg } : {})
          }
        : null;
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : id,
        ariaLabel: typeof control.ariaLabel === 'string' && control.ariaLabel.trim().length
          ? control.ariaLabel.trim()
          : '',
        compact: !!control.compact,
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        ...(control.handlerArg !== undefined ? { handlerArg: control.handlerArg } : {}),
        tooltip: typeof control.tooltip === 'string' ? control.tooltip : '',
        hint: typeof control.hint === 'string' ? control.hint : '',
        inputOnly: !!control.inputOnly,
        headerToggle,
        ...state
      };
    }

    if (type === 'range-pair') {
      const items = Array.isArray(control.items)
        ? control.items
          .map((item) => {
            const itemId = typeof item?.id === 'string' && item.id.trim().length ? item.id.trim() : '';
            if (!itemId) return null;
            const state = prepareDeclarativeRangeState(item);
            if (!state) return null;
            return {
              ...item,
              id: itemId,
              label: typeof item.label === 'string' && item.label.trim().length
                ? item.label.trim()
                : itemId.toUpperCase(),
              ariaLabel: typeof item.ariaLabel === 'string' && item.ariaLabel.trim().length
                ? item.ariaLabel.trim()
                : '',
              handlerArg: item.handlerArg ?? itemId,
              ...state
            };
          })
          .filter(Boolean)
        : [];
      if (!items.length) return null;
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : id,
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        hint: typeof control.hint === 'string' ? control.hint : '',
        items
      };
    }

    if (type === 'axis-toggle-pair') {
      const state = prepareFlipContext(control.state);
      if (!state.available) return null;
      const axes = ['horizontal', 'vertical']
        .map((axisId) => {
          const axis = state[axisId];
          if (!axis || typeof axis !== 'object') return null;
          return {
            id: axisId,
            ...axis,
            handlerId: typeof control[`${axisId}HandlerId`] === 'string' ? control[`${axisId}HandlerId`] : '',
            randomHandlerId: typeof control[`${axisId}RandomHandlerId`] === 'string' ? control[`${axisId}RandomHandlerId`] : ''
          };
        })
        .filter(Boolean);
      if (!axes.length) return null;
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : 'Flip / Mirror',
        display: state.display,
        previewDisplay: state.previewDisplay,
        hint: state.randomHint,
        axes
      };
    }

    if (type === 'scalar') {
      const variant = control.variant === 'rotation' ? 'rotation' : 'scale';
      const state = variant === 'rotation'
        ? prepareRotationContext(control.state)
        : prepareScaleContext(control.state);
      if (!state.available) return null;
      return {
        ...control,
        id,
        type,
        variant,
        wrap: variant === 'rotation' && control.state?.wrap === true,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : (variant === 'rotation' ? 'Rotation' : 'Scale'),
        ariaLabel: typeof control.ariaLabel === 'string' && control.ariaLabel.trim().length
          ? control.ariaLabel.trim()
          : (variant === 'rotation' ? 'Rotation' : 'Scale'),
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        hint: typeof control.hint === 'string' ? control.hint : '',
        min: state.min,
        max: state.max,
        step: state.step,
        value: state.value,
        display: state.display,
        disabled: !!state.disabled,
        defaultValue: state.defaultValue
      };
    }

    if (type === 'scalar-randomized') {
      const variant = control.variant === 'rotation' ? 'rotation' : 'scale';
      const state = variant === 'rotation'
        ? prepareRotationContext(control.state)
        : prepareScaleContext(control.state);
      if (!state.available) return null;
      return {
        ...control,
        id,
        type,
        variant,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : (variant === 'rotation' ? 'Rotation' : 'Scale'),
        ariaLabel: typeof control.ariaLabel === 'string' && control.ariaLabel.trim().length
          ? control.ariaLabel.trim()
          : (variant === 'rotation' ? 'Rotation' : 'Scale'),
        strengthLabel: typeof control.strengthLabel === 'string' && control.strengthLabel.trim().length
          ? control.strengthLabel.trim()
          : 'Strength',
        strengthAriaLabel: typeof control.strengthAriaLabel === 'string' && control.strengthAriaLabel.trim().length
          ? control.strengthAriaLabel.trim()
          : (variant === 'rotation' ? 'Random rotation strength' : 'Random scale strength'),
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        randomHandlerId: typeof control.randomHandlerId === 'string' ? control.randomHandlerId : '',
        strengthHandlerId: typeof control.strengthHandlerId === 'string' ? control.strengthHandlerId : '',
        randomMinHandlerId: typeof control.randomMinHandlerId === 'string' ? control.randomMinHandlerId : '',
        randomMaxHandlerId: typeof control.randomMaxHandlerId === 'string' ? control.randomMaxHandlerId : '',
        hint: typeof control.hint === 'string' ? control.hint : state.randomHint,
        min: state.min,
        max: state.max,
        step: state.step,
        value: state.value,
        display: state.display,
        disabled: !!state.disabled,
        defaultValue: state.defaultValue,
        randomEnabled: !!state.randomEnabled,
        randomButtonVisible: state.randomButtonVisible !== false,
        randomMode: state.randomMode,
        randomAria: state.randomAria,
        randomLabel: state.randomLabel,
        randomTooltip: state.randomTooltip,
        randomMin: state.randomMin,
        randomMax: state.randomMax,
        randomMinDisplay: state.randomMinDisplay,
        randomMaxDisplay: state.randomMaxDisplay,
        randomMinDefault: state.randomMinDefault,
        randomMaxDefault: state.randomMaxDefault,
        randomMinAriaLabel: state.randomMinAriaLabel,
        randomMaxAriaLabel: state.randomMaxAriaLabel,
        strength: state.strength,
        strengthMin: state.strengthMin,
        strengthMax: state.strengthMax,
        strengthStep: state.strengthStep,
        strengthDisplay: state.strengthDisplay,
        strengthDefault: state.strengthDefault
      };
    }

    if (type === 'stack-order') {
      const state = prepareShapeStackingContext(control.state);
      if (!state.available) return null;
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : 'Selected Shape',
        orderLabel: state.orderLabel,
        elevationLabel: state.elevationLabel,
        hint: state.hint,
        raiseLabel: typeof control.raiseLabel === 'string' && control.raiseLabel.trim().length
          ? control.raiseLabel.trim()
          : 'Move Above',
        lowerLabel: typeof control.lowerLabel === 'string' && control.lowerLabel.trim().length
          ? control.lowerLabel.trim()
          : 'Move Below',
        pushTopLabel: typeof control.pushTopLabel === 'string' && control.pushTopLabel.trim().length
          ? control.pushTopLabel.trim()
          : 'Push to Top',
        pushBottomLabel: typeof control.pushBottomLabel === 'string' && control.pushBottomLabel.trim().length
          ? control.pushBottomLabel.trim()
          : 'Push to Bottom',
        raiseHandlerId: typeof control.raiseHandlerId === 'string' ? control.raiseHandlerId : '',
        lowerHandlerId: typeof control.lowerHandlerId === 'string' ? control.lowerHandlerId : '',
        pushTopHandlerId: typeof control.pushTopHandlerId === 'string' ? control.pushTopHandlerId : '',
        pushBottomHandlerId: typeof control.pushBottomHandlerId === 'string' ? control.pushBottomHandlerId : '',
        raiseDisabled: !!state.raiseDisabled,
        lowerDisabled: !!state.lowerDisabled,
        pushTopDisabled: !!state.pushTopDisabled,
        pushBottomDisabled: !!state.pushBottomDisabled
      };
    }

    if (type === 'drop-shadow') {
      const prepared = this._prepareDeclarativeDropShadowControl(control, id);
      if (!prepared) return null;
      return prepared;
    }

    if (type === 'portal-controls') {
      const prepared = this._prepareDeclarativePortalControl(control, id);
      if (!prepared) return null;
      return prepared;
    }

    return null;
  }

  _prepareGridSnapResolution() {
    const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
    const available = !!(this._gridSnapAvailable && (controllerAllows !== false));
    if (!available) return { available: false };
    if (this._activeTool?.id === 'token.placement') {
      return { available: false };
    }
    const value = this._normalizeGridSnapSubdivision(this._gridSnapSubdivisions);
    return {
      available: true,
      min: GRID_SNAP_SUBDIV_MIN,
      max: GRID_SNAP_SUBDIV_MAX,
      step: 1,
      value,
      display: this._formatGridSnapResolutionDisplay(value),
      hint: 'Snap to: Full, 1/2, 1/3, 1/4, 1/5',
      disabled: false
    };
  }

  _prepareDeclarativeDropShadowControl(control, id) {
    const variant = control?.variant === 'path' ? 'path' : 'default';
    if (variant === 'path') {
      const state = preparePathShadowContext(control?.state);
      if (!state.available) return null;
      return {
        ...control,
        id,
        type: 'drop-shadow',
        variant,
        toggle: {
          available: true,
          enabled: !!state.enabled,
          disabled: !!state.disabled,
          label: typeof control.toggleLabel === 'string' && control.toggleLabel.trim().length
            ? control.toggleLabel.trim()
            : 'Path Shadow',
          tooltip: typeof control.toggleTooltip === 'string' ? control.toggleTooltip : '',
          hint: typeof control.toggleHint === 'string' ? control.toggleHint : '',
          handlerId: typeof control.toggleHandlerId === 'string' && control.toggleHandlerId.length
            ? control.toggleHandlerId
            : 'setPathShadowEnabled'
        },
        controls: {
          available: true,
          label: typeof control.controlsLabel === 'string' && control.controlsLabel.trim().length
            ? control.controlsLabel.trim()
            : 'Shadow Settings',
          collapsed: false,
          collapse: {
            available: false,
            collapsed: false,
            disabled: !!state.disabled,
            handlerId: ''
          },
          context: {
            display: String(state.context?.display || ''),
            status: '',
            note: String(state.context?.note || '')
          },
          presetHandlerId: typeof control.presetHandlerId === 'string' && control.presetHandlerId.length
            ? control.presetHandlerId
            : 'handlePathShadowPreset',
          presets: Array.isArray(state.presets) ? state.presets : [],
          reset: {
            label: typeof control.resetLabel === 'string' && control.resetLabel.trim().length
              ? control.resetLabel.trim()
              : 'Reset Shadow',
            disabled: !!state.reset?.disabled,
            tooltip: typeof state.reset?.tooltip === 'string' ? state.reset.tooltip : '',
            handlerId: typeof control.resetHandlerId === 'string' && control.resetHandlerId.length
              ? control.resetHandlerId
              : 'resetPathShadowSettings'
          },
          edit: {
            available: state.editAvailable !== false,
            enabled: !!state.editMode,
            disabled: !state.enabled || !!state.editDisabled,
            label: typeof control.editLabel === 'string' && control.editLabel.trim().length
              ? control.editLabel.trim()
              : 'Edit Shadow',
            handlerId: typeof control.editHandlerId === 'string' && control.editHandlerId.length
              ? control.editHandlerId
              : 'setPathShadowEditMode',
            reset: state.editReset
              ? {
                  label: typeof control.editResetLabel === 'string' && control.editResetLabel.trim().length
                    ? control.editResetLabel.trim()
                    : 'Reset',
                  disabled: !!state.editReset.disabled,
                  tooltip: typeof state.editReset.tooltip === 'string' ? state.editReset.tooltip : '',
                  handlerId: typeof control.editResetHandlerId === 'string' && control.editResetHandlerId.length
                    ? control.editResetHandlerId
                    : 'resetPathShadowEdit'
              }
              : null
          },
          shadowOnly: state.shadowOnly?.available
            ? {
                ...state.shadowOnly,
                disabled: !state.enabled || !!state.shadowOnly.disabled,
                handlerId: typeof control.shadowOnlyHandlerId === 'string' && control.shadowOnlyHandlerId.length
                  ? control.shadowOnlyHandlerId
                  : 'setPathShadowOnly'
              }
            : { available: false },
          scale: state.scale
            ? {
                ...state.scale,
                label: typeof control.scaleLabel === 'string' && control.scaleLabel.trim().length
                  ? control.scaleLabel.trim()
                  : 'Scale',
                handlerId: typeof control.scaleHandlerId === 'string' && control.scaleHandlerId.length
                  ? control.scaleHandlerId
                  : 'setPathShadowScale'
              }
            : null,
          offset: state.offset
            ? {
                ...state.offset,
                mode: 'scalar',
                label: typeof control.offsetLabel === 'string' && control.offsetLabel.trim().length
                  ? control.offsetLabel.trim()
                  : 'Offset',
                handlerId: typeof control.offsetHandlerId === 'string' && control.offsetHandlerId.length
                  ? control.offsetHandlerId
                  : 'setPathShadowOffset',
                resetHandlerId: ''
              }
            : null,
          alpha: state.alpha
            ? {
                ...state.alpha,
                label: 'Opacity',
                handlerId: typeof control.alphaHandlerId === 'string' && control.alphaHandlerId.length
                  ? control.alphaHandlerId
                  : 'setPathShadowAlpha'
              }
            : null,
          blur: state.blur
            ? {
                ...state.blur,
                label: 'Blur',
                handlerId: typeof control.blurHandlerId === 'string' && control.blurHandlerId.length
                  ? control.blurHandlerId
                  : 'setPathShadowBlur'
              }
            : null,
          dilation: state.dilation
            ? {
                ...state.dilation,
                label: 'Dilation',
                handlerId: typeof control.dilationHandlerId === 'string' && control.dilationHandlerId.length
                  ? control.dilationHandlerId
                  : 'setPathShadowDilation'
              }
            : null,
          preview: null
        }
      };
    }

    const toggleRaw = control?.toggle && typeof control.toggle === 'object' ? control.toggle : {};
    const controlsState = prepareDropShadowControls(control?.controls, toggleRaw);
    if (!toggleRaw.available && !controlsState.available) return null;
    return {
      ...control,
      id,
      type: 'drop-shadow',
      variant,
      toggle: {
        available: !!toggleRaw.available,
        enabled: !!toggleRaw.enabled,
        disabled: !!toggleRaw.disabled,
        label: typeof control?.toggleLabel === 'string' && control.toggleLabel.trim().length
          ? control.toggleLabel.trim()
          : 'Drop Shadow',
        tooltip: typeof toggleRaw.tooltip === 'string' ? toggleRaw.tooltip : '',
        hint: typeof toggleRaw.hint === 'string' ? toggleRaw.hint : '',
        handlerId: typeof control?.toggleHandlerId === 'string' && control.toggleHandlerId.length
          ? control.toggleHandlerId
          : 'setDropShadowEnabled'
      },
      controls: {
        ...controlsState,
        label: typeof control?.controlsLabel === 'string' && control.controlsLabel.trim().length
          ? control.controlsLabel.trim()
          : 'Shadow Settings',
        presetHandlerId: typeof control?.presetHandlerId === 'string' && control.presetHandlerId.length
          ? control.presetHandlerId
          : 'handleDropShadowPreset',
        collapse: {
          available: true,
          collapsed: !!controlsState.collapsed,
          disabled: !!controlsState.disabled,
          handlerId: typeof control?.collapseHandlerId === 'string' && control.collapseHandlerId.length
            ? control.collapseHandlerId
            : 'toggleDropShadowCollapsed'
        },
        reset: {
          label: typeof control?.resetLabel === 'string' && control.resetLabel.trim().length
            ? control.resetLabel.trim()
            : 'Reset',
          disabled: !!controlsState.disabled,
          tooltip: 'Reset shadow settings to defaults',
          handlerId: typeof control?.resetHandlerId === 'string' && control.resetHandlerId.length
            ? control.resetHandlerId
            : 'resetDropShadow'
        },
        edit: {
          available: false,
          enabled: false,
          disabled: true,
          label: '',
          handlerId: '',
          reset: null
        },
        shadowOnly: controlsState.shadowOnly?.available
          ? {
              ...controlsState.shadowOnly,
              handlerId: typeof control?.shadowOnlyHandlerId === 'string' && control.shadowOnlyHandlerId.length
                ? control.shadowOnlyHandlerId
                : 'setDropShadowOnly'
            }
          : { available: false },
        scale: null,
        offset: controlsState.offset
          ? {
              ...controlsState.offset,
              mode: 'polar',
              label: 'Offset',
              handlerId: typeof control?.offsetHandlerId === 'string' && control.offsetHandlerId.length
                ? control.offsetHandlerId
                : 'setDropShadowOffset',
              resetHandlerId: typeof control?.offsetResetHandlerId === 'string' && control.offsetResetHandlerId.length
                ? control.offsetResetHandlerId
                : 'resetDropShadowOffset',
              offsetMaxHandlerId: typeof control?.offsetMaxHandlerId === 'string' && control.offsetMaxHandlerId.length
                ? control.offsetMaxHandlerId
                : (controlsState.offset.offsetMaxHandlerId || '')
            }
          : null,
        alpha: controlsState.alpha
          ? {
              ...controlsState.alpha,
              handlerId: typeof control?.alphaHandlerId === 'string' && control.alphaHandlerId.length
                ? control.alphaHandlerId
                : 'setDropShadowAlpha'
            }
          : null,
        blur: controlsState.blur
          ? {
              ...controlsState.blur,
              handlerId: typeof control?.blurHandlerId === 'string' && control.blurHandlerId.length
                ? control.blurHandlerId
                : 'setDropShadowBlur'
            }
          : null,
        dilation: controlsState.dilation
          ? {
              ...controlsState.dilation,
              handlerId: typeof control?.dilationHandlerId === 'string' && control.dilationHandlerId.length
                ? control.dilationHandlerId
                : 'setDropShadowDilation'
            }
          : null
      }
    };
  }

  _prepareDeclarativePortalControl(control, id) {
    return prepareDeclarativePortalControl(control, id, {
      isSectionCollapsed: (sectionId) => !!this._isPortalSectionCollapsed?.(id, sectionId)
    });
  }

}

export function installToolOptionsWindowRenderMethods(ToolOptionsWindowClass) {
  const descriptors = Object.getOwnPropertyDescriptors(ToolOptionsWindowRenderMethods.prototype);
  delete descriptors.constructor;
  Object.defineProperties(ToolOptionsWindowClass.prototype, descriptors);
}
