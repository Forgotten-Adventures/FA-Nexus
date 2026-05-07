const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TOOL_HELP_COPY = Object.freeze({
  'asset-placement': Object.freeze({
    summary: 'Place single assets or paint scatter sessions with shared snap, rotation, elevation, and placement controls.',
    notes: Object.freeze([
      'Single placement drops one asset at a time, while scatter brush mode paints repeated stamps until you commit or cancel the session.',
      'Scatter edit sessions let you add new stamps, erase existing stamps, and merge the result back into the tile.',
      'Panel controls drive randomization, shading, mirroring, and transform ranges before placement.'
    ])
  }),
  'token-placement': Object.freeze({
    summary: 'Place tokens onto the canvas or actor sidebar targets with shared rotation, mirroring, grid snap, and place-as controls.',
    notes: Object.freeze([
      'Placement can target either the canvas or an actor row in the sidebar.',
      'Place As controls decide how new actors, links, names, and HP are derived for each drop.'
    ])
  }),
  'texture-paint': Object.freeze({
    summary: 'Paint or erase masked tiling directly on a tile, including shape selections and height-aware masking.',
    notes: Object.freeze([
      'Brush, fill, and selection tools all write into the current tile mask until you commit the session.',
      'Height Map turns the texture into a smart paint mask, so you can paint only the parts of the texture that read as raised or recessed instead of painting the whole image evenly.'
    ])
  }),
  'path-editor-v2': Object.freeze({
    summary: 'Draw, reshape, and re-edit path tiles with live previews, draw/curve modes, and path, placement, feathering, and shadow controls.',
    notes: Object.freeze([
      'Curve mode adds controlled points, while Draw mode sketches freehand segments.',
      'Edit Shapes reopens existing paths so you can move points, retune textures, and change stacking.',
      'In Edit Shapes, press X while hovering a non-endpoint to split the hovered open path at that point.',
      'Path, placement, feathering, and shadow panels all update the live preview before you commit.'
    ])
  }),
  'building-editor': Object.freeze({
    summary: 'Block out outer walls, inner walls, and portals, then refine shapes, stacking, and appearance in-place.',
    notes: Object.freeze([
      'Outer walls create closed geometry, while inner walls stay open and use the polygon lasso workflow.',
      'Edit Shapes lets you retune vertices, arcs, fill elevation, and stacking without starting over.',
      'In Edit Shapes, right-click a wall segment to target it for per-segment texture, offset, opacity, HSBC, and shadow overrides. Ctrl/Cmd+right-click adds more segments to the selection.',
      'Use the Portals tab after the wall geometry exists to add doors, windows, and gaps.'
    ])
  })
});

function normalizeHelpNotes(lines) {
  if (!Array.isArray(lines)) return [];
  return Array.from(new Set(
    lines
      .filter((line) => typeof line === 'string' && line.trim().length)
      .map((line) => line.trim())
  ));
}

export function getToolHelpCopy(helpTopicId) {
  const id = String(helpTopicId || '');
  return TOOL_HELP_COPY[id] || {};
}

export function getToolHelpNotes(helpTopicId, { state = {}, hints = [] } = {}) {
  if (helpTopicId === 'building-editor' && state?.portalMode) {
    return [
      'Portal mode places the configured door or window on the hovered wall.',
      'Use the portal controls to tune the selected door or window without leaving the editor.',
      'Switch back to wall editing when you need to change geometry, fills, or stacking.'
    ];
  }

  const topicNotes = normalizeHelpNotes(getToolHelpCopy(helpTopicId)?.notes || []);
  if (helpTopicId === 'asset-placement') {
    const dynamicNotes = [];
    for (const line of hints) {
      if (/^preview frozen\b/i.test(line)) dynamicNotes.push('Preview is currently frozen.');
      else if (/^editing scatter tile\b/i.test(line)) dynamicNotes.push('Editing an existing scatter tile instead of placing a new one.');
    }
    return normalizeHelpNotes([...dynamicNotes, ...topicNotes]);
  }

  if (helpTopicId === 'texture-paint') {
    const dynamicNotes = [];
    if (state?.rotation?.available === false && state?.scale?.available === false && state?.textureOffset?.available === false) {
      dynamicNotes.push('Mask Tile sessions keep the same paint workflow but hide transform controls that do not apply.');
    }
    return normalizeHelpNotes([...dynamicNotes, ...topicNotes]);
  }

  if (topicNotes.length) return topicNotes;
  return normalizeHelpNotes(hints);
}

export function buildToolHelpContext({
  toolId = null,
  activeToolId = null,
  getToolNormalized = null,
  getToolState = null,
  getToolLabel = null,
  getToolSectionLayout = null
} = {}) {
  const id = String(toolId || activeToolId || '');
  if (!id || typeof getToolNormalized !== 'function' || typeof getToolState !== 'function') {
    return { available: false };
  }
  const normalized = getToolNormalized(id);
  const state = getToolState(id);
  const descriptor = normalized?.descriptor && typeof normalized.descriptor === 'object'
    ? normalized.descriptor
    : {};
  const helpTopicId = typeof descriptor.helpTopicId === 'string' ? descriptor.helpTopicId : '';
  const topicCopy = getToolHelpCopy(helpTopicId);
  const toolLabel = typeof getToolLabel === 'function' ? getToolLabel(id) : id;
  const selectionSummary = descriptor.selectionSummary ?? null;
  const hints = (() => {
    const raw = state?.hints;
    if (Array.isArray(raw)) {
      return raw
        .filter((line) => typeof line === 'string' && line.trim().length)
        .map((line) => line.trim());
    }
    if (typeof raw === 'string' && raw.trim().length) return [raw.trim()];
    return [];
  })();
  const shortcuts = Array.isArray(normalized?.shortcuts)
    ? normalized.shortcuts
      .filter((entry) => entry && typeof entry === 'object' && !entry.hidden)
      .map((entry) => ({
        action: typeof entry.action === 'string' ? entry.action : '',
        binding: typeof entry.binding === 'string' ? entry.binding : '',
        label: typeof entry.label === 'string' ? entry.label : '',
        description: typeof entry.description === 'string' ? entry.description : ''
      }))
      .filter((entry) => entry.action || entry.binding || entry.label)
    : [];
  const sections = typeof getToolSectionLayout === 'function'
    ? getToolSectionLayout(id)
      .map((section) => ({
        id: typeof section?.id === 'string' ? section.id : '',
        label: typeof section?.label === 'string' ? section.label : ''
      }))
      .filter((section) => section.id && section.label)
    : [];
  const notes = getToolHelpNotes(helpTopicId, { state, hints });
  const summary = typeof topicCopy.summary === 'string' ? topicCopy.summary : '';
  const available = !!(summary || shortcuts.length || notes.length || sections.length);
  return {
    available,
    toolId: id,
    toolLabel,
    helpTopicId,
    summary,
    selectionSummary,
    dirty: !!descriptor.dirty,
    sections,
    shortcuts,
    notes
  };
}

export class ToolHelpWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-tool-help',
    tag: 'section',
    position: { width: 460, height: 'auto' },
    window: {
      title: 'Tool Help',
      icon: 'fas fa-circle-question',
      minimizable: true,
      resizable: true
    },
    classes: ['fa-nexus-tool-help-window']
  };

  static PARTS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.PARTS ?? {}),
    {
      body: { template: 'modules/fa-nexus/templates/tool-help-modal.hbs' }
    },
    { inplace: false }
  );

  constructor({ controller, helpContext = {} } = {}) {
    super();
    this._controller = controller;
    this._helpContext = helpContext && typeof helpContext === 'object' ? helpContext : {};
  }

  setHelpContext(helpContext = {}, { suppressRender = false } = {}) {
    this._helpContext = helpContext && typeof helpContext === 'object' ? helpContext : {};
    if (this.rendered && !suppressRender) this.render(false);
  }

  _resolveWindowTitle() {
    const label = typeof this._helpContext?.toolLabel === 'string' ? this._helpContext.toolLabel.trim() : '';
    return label ? `${label} Help` : 'Tool Help';
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

  async _prepareContext() {
    const help = this._helpContext && typeof this._helpContext === 'object' ? this._helpContext : {};
    return {
      toolLabel: typeof help.toolLabel === 'string' ? help.toolLabel : '',
      summary: typeof help.summary === 'string' ? help.summary : '',
      selectionSummary: help.selectionSummary ?? null,
      dirty: !!help.dirty,
      sections: Array.isArray(help.sections) ? help.sections : [],
      shortcuts: Array.isArray(help.shortcuts) ? help.shortcuts : [],
      notes: Array.isArray(help.notes) ? help.notes : []
    };
  }

  _onRender(initial, ctx) {
    super._onRender(initial, ctx);
    this._syncWindowTitle();
  }

  async _preClose(options = {}) {
    try { this._controller?._handleHelpWindowClosing(this); } catch (_) {}
    return super._preClose(options);
  }

  _onClose(options = {}) {
    try { this._controller?._handleHelpWindowClosed(this); } catch (_) {}
    return super._onClose(options);
  }
}
