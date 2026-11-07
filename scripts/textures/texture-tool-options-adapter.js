import {
  createNormalizedToolOptionsDescriptor,
  TOOL_OPTIONS_RENDERER_MODE
} from '../core/tool-options/tool-options-descriptor.js';
import {
  createShortcut,
  createStandardEditorShortcuts,
  mergeShortcutLists,
  resolveEffectivePolarity
} from '../core/editor-shortcuts.js';
import { normalizeMaskedTextureBlendMode } from './texture-blend-runtime.js';

export class TextureToolOptionsAdapter {
  constructor({
    buildToolOptionsState = () => ({}),
    buildDeclarativeToolOptionsConfig = () => ({ controls: {}, sections: [] }),
    getToolOptionsHostState = () => ({}),
    getCustomToggleHandlers = () => ({}),
    callDelegateToolOption = () => undefined,
    hasSessionChanges = () => false,
    getEditingTileId = () => null
  } = {}) {
    this._buildToolOptionsState = buildToolOptionsState;
    this._buildDeclarativeToolOptionsConfig = buildDeclarativeToolOptionsConfig;
    this._getToolOptionsHostState = getToolOptionsHostState;
    this._getCustomToggleHandlers = getCustomToggleHandlers;
    this._callDelegateToolOption = callDelegateToolOption;
    this._hasSessionChanges = hasSessionChanges;
    this._getEditingTileId = getEditingTileId;
  }

  buildDescriptor() {
    const legacyState = this._buildToolOptionsState();
    const activeMode = Array.isArray(legacyState?.texturePaint?.modes)
      ? (legacyState.texturePaint.modes.find((mode) => mode?.active)?.id || null)
      : null;
    const hostState = this._getToolOptionsHostState();
    const basePolarity = hostState.basePolarity === 'erase' ? 'erase' : 'paint';
    const invertHeld = hostState.polarityInvertHeld === true;
    const { controls, sections } = this._buildDeclarativeToolOptionsConfig(legacyState);
    const shortcuts = mergeShortcutLists(
      createStandardEditorShortcuts({ includePolarity: true }),
      [
        createShortcut('paint-texture', {
          binding: 'LMB',
          label: 'Paint',
          description: 'Paint or apply fills, depending on the active mode.'
        }),
        createShortcut('brush-size', {
          binding: 'Ctrl/Cmd+Wheel',
          label: 'Brush Size',
          description: 'Adjust brush size.'
        }),
        createShortcut('adjust-elevation-wheel', {
          binding: 'Alt+Wheel',
          label: 'Elevation Wheel',
          description: 'Adjust tile elevation by 0.01; add Shift for 0.1 or Ctrl/Cmd for 0.001.'
        }),
        createShortcut('adjust-elevation-keys', {
          binding: 'Alt+[ / ] or Alt+Up / Down',
          label: 'Elevation Keys',
          description: 'Nudge tile elevation with the same step modifiers as Alt+Wheel.'
        })
      ]
    );
    return createNormalizedToolOptionsDescriptor({
      rendererMode: TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE,
      descriptor: {
        toolId: 'texture.paint',
        toolLabel: 'Texture Painter',
        activeMode,
        activeSubtool: activeMode,
        polarity: {
          supported: true,
          base: basePolarity,
          effective: resolveEffectivePolarity(basePolarity, invertHeld),
          inverted: invertHeld
        },
        dirty: this._hasSessionChanges(),
        selectionSummary: legacyState?.texturePaint?.status || null,
        helpTopicId: 'texture-paint'
      },
      legacyState,
      controls,
      sections,
      handlers: this.buildHandlers(legacyState),
      shortcuts,
      sessionState: {
        editingTileId: this._getEditingTileId() || null,
        toolMode: activeMode,
        dirty: this._hasSessionChanges()
      },
      renderState: {
        previewElevation: Number.isFinite(hostState.previewElevation) ? Number(hostState.previewElevation) : 0,
        selectionActive: hostState.selectionActive === true
      },
      persistedState: {
        documentFlags: ['flags.fa-nexus.maskedTiling', 'flags.fa-nexus.standardTileMask', 'flags.fa-nexus.hsbc']
      }
    });
  }

  buildHandlers(legacyState = {}) {
    const handlers = {
      setTextureMode: (modeId) => this._callDelegateToolOption('setTextureMode', 'setTextureMode', [modeId]),
      handleTextureAction: (actionId) => this._callDelegateToolOption('handleTextureAction', 'handleTextureAction', [actionId]),
      handleEditorAction: (actionId) => this._callDelegateToolOption('handleEditorAction', 'handleEditorAction', [actionId]),
      setTextureOpacity: (value, commit) => this._callDelegateToolOption('setTextureOpacity', 'setTextureOpacity', [value, commit]),
      setBrushSize: (value, commit) => this._callDelegateToolOption('setBrushSize', 'setBrushSize', [value, commit]),
      setParticleSize: (value, commit) => this._callDelegateToolOption('setParticleSize', 'setParticleSize', [value, commit]),
      setParticleDensity: (value, commit) => this._callDelegateToolOption('setParticleDensity', 'setParticleDensity', [value, commit]),
      setSprayDeviation: (value, commit) => this._callDelegateToolOption('setSprayDeviation', 'setSprayDeviation', [value, commit]),
      setBrushSpacing: (value, commit) => this._callDelegateToolOption('setBrushSpacing', 'setBrushSpacing', [value, commit]),
      setElevation: (value, commit) => this._callDelegateToolOption('setElevation', 'setElevation', [value, commit]),
      setRotation: (value, commit) => this._callDelegateToolOption('setRotation', 'setRotation', [value, commit]),
      setScale: (value, commit) => this._callDelegateToolOption('setScale', 'setScale', [value, commit]),
      setTextureOffset: (axis, value, commit) => this._callDelegateToolOption('setTextureOffset', 'setTextureOffset', [axis, value, commit]),
      setLayerOpacity: (value, commit) => this._callDelegateToolOption('setLayerOpacity', 'setLayerOpacity', [value, commit]),
      setTextureBlendMode: (value) => this._callDelegateToolOption('setTextureBlendMode', 'setTextureBlendMode', [normalizeMaskedTextureBlendMode(value)]),
      setHue: (value, commit) => this._callDelegateToolOption('setHue', 'setHue', [value, commit]),
      setSaturation: (value, commit) => this._callDelegateToolOption('setSaturation', 'setSaturation', [value, commit]),
      setBrightness: (value, commit) => this._callDelegateToolOption('setBrightness', 'setBrightness', [value, commit]),
      setContrast: (value, commit) => this._callDelegateToolOption('setContrast', 'setContrast', [value, commit]),
      setBlackPixelGateEnabled: (enabled) => this._callDelegateToolOption('setBlackPixelGateEnabled', 'setBlackPixelGateEnabled', [enabled]),
      setBlackPixelGateFuzziness: (value, commit) => this._callDelegateToolOption('setBlackPixelGateFuzziness', 'setBlackPixelGateFuzziness', [value, commit]),
      setHeightThreshold: (axis, value, commit) => this._callDelegateToolOption('setHeightThreshold', 'setHeightThreshold', [axis, value, commit]),
      setHeightContrast: (value, commit) => this._callDelegateToolOption('setHeightContrast', 'setHeightContrast', [value, commit]),
      setHeightLift: (value, commit) => this._callDelegateToolOption('setHeightLift', 'setHeightLift', [value, commit]),
      toggleHeightMapCollapsed: () => this._callDelegateToolOption('toggleHeightMapCollapsed', 'toggleHeightMapCollapsed')
    };
    const customToggles = this._getCustomToggleHandlers();
    const mergedCustomToggles = customToggles && typeof customToggles === 'object'
      ? { ...customToggles }
      : {};
    const textureModes = Array.isArray(legacyState?.texturePaint?.modes)
      ? legacyState.texturePaint.modes
      : [];
    for (const mode of textureModes) {
      const modeId = String(mode?.id || '');
      if (!modeId) continue;
      mergedCustomToggles[modeId] = (enabled) => {
        if (!enabled) return true;
        return handlers.setTextureMode(modeId);
      };
    }
    if (Object.keys(mergedCustomToggles).length) handlers.customToggles = mergedCustomToggles;
    return handlers;
  }
}

export default TextureToolOptionsAdapter;
