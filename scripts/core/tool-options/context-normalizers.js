export function prepareDeclarativeRangeState(raw = {}) {
  if (!raw || typeof raw !== 'object' || raw.available === false) return null;
  const clamp = (value, min, max, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  };
  const min = Number.isFinite(raw.min) ? Number(raw.min) : 0;
  const max = Number.isFinite(raw.max) ? Number(raw.max) : 100;
  const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
  const fallbackValue = Number.isFinite(raw.defaultValue)
    ? Number(raw.defaultValue)
    : (Number.isFinite(raw.value) ? Number(raw.value) : min);
  const value = clamp(raw.value, min, max, fallbackValue);
  const display = typeof raw.display === 'string' && raw.display.length
    ? raw.display
    : String(value);
  const defaultValue = Number.isFinite(raw.defaultValue) ? Number(raw.defaultValue) : null;
  return {
    min,
    max,
    step,
    value,
    display,
    defaultValue,
    disabled: !!raw.disabled
  };
}

export function prepareFlipContext(raw) {
  if (!raw || typeof raw !== 'object' || !raw.available) {
    return { available: false };
  }
  const coerceString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
  const coerceBool = (value) => !!value;
  const buildAxis = (axisRaw = {}) => {
    const data = axisRaw && typeof axisRaw === 'object' ? axisRaw : {};
    const randomButtonVisible = data.randomButtonVisible !== undefined ? !!data.randomButtonVisible : true;
    return {
      active: coerceBool(data.active),
      label: coerceString(data.label, 'Flip'),
      tooltip: coerceString(data.tooltip, ''),
      disabled: coerceBool(data.disabled),
      aria: coerceString(data.aria, 'Toggle mirroring'),
      previewDiff: coerceBool(data.previewDiff),
      randomEnabled: coerceBool(data.randomEnabled),
      randomLabel: coerceString(data.randomLabel, 'Random'),
      randomTooltip: coerceString(data.randomTooltip, data.randomEnabled ? 'Disable random' : 'Enable random'),
      randomDisabled: coerceBool(data.randomDisabled),
      randomAria: coerceString(data.randomAria, 'Toggle random mirroring'),
      randomPreviewDiff: coerceBool(data.randomPreviewDiff),
      randomButtonVisible
    };
  };
  return {
    available: true,
    display: coerceString(raw.display, 'None'),
    previewDisplay: coerceString(raw.previewDisplay, ''),
    randomHint: coerceString(raw.randomHint, ''),
    horizontal: buildAxis(raw.horizontal),
    vertical: buildAxis(raw.vertical)
  };
}

export function prepareScaleContext(raw) {
  if (!raw || typeof raw !== 'object' || !raw.available) {
    return { available: false };
  }
  const clamp = (value, min, max, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  };
  const min = Number.isFinite(raw.min) ? Number(raw.min) : 10;
  const max = Number.isFinite(raw.max) ? Number(raw.max) : 250;
  const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
  const value = clamp(raw.value, min, max, Math.max(min, Math.min(max, 100)));
  const randomEnabled = !!raw.randomEnabled;
  const randomMode = raw.randomMode === 'range' ? 'range' : 'strength';
  const strengthMin = Number.isFinite(raw.strengthMin) ? Number(raw.strengthMin) : 0;
  const strengthMax = Number.isFinite(raw.strengthMax) ? Number(raw.strengthMax) : 100;
  const strengthStep = Number.isFinite(raw.strengthStep) && Number(raw.strengthStep) > 0 ? Number(raw.strengthStep) : 1;
  const strength = clamp(raw.strength, strengthMin, strengthMax, strengthMin);
  const randomMinSeed = clamp(raw.randomMin, min, max, value);
  const randomMaxSeed = clamp(raw.randomMax, min, max, randomMinSeed);
  const randomMin = Math.min(randomMinSeed, randomMaxSeed);
  const randomMax = Math.max(randomMinSeed, randomMaxSeed);
  const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
  const strengthDisplay = typeof raw.strengthDisplay === 'string'
    ? raw.strengthDisplay
    : `±${Math.round(strength)}%`;
  const randomMinDisplay = typeof raw.randomMinDisplay === 'string'
    ? raw.randomMinDisplay
    : `${Math.round(randomMin)}%`;
  const randomMaxDisplay = typeof raw.randomMaxDisplay === 'string'
    ? raw.randomMaxDisplay
    : `${Math.round(randomMax)}%`;
  const randomLabel = typeof raw.randomLabel === 'string' ? raw.randomLabel : 'Random';
  const randomTooltip = typeof raw.randomTooltip === 'string'
    ? raw.randomTooltip
    : (randomEnabled ? 'Disable random scale' : 'Enable random scale');
  const randomAria = typeof raw.randomAria === 'string'
    ? raw.randomAria
    : (randomEnabled ? 'Disable random scale' : 'Enable random scale');
  const randomHint = typeof raw.randomHint === 'string' ? raw.randomHint : '';
  const randomButtonVisible = raw.randomButtonVisible !== undefined ? !!raw.randomButtonVisible : true;
  return {
    available: true,
    min,
    max,
    step,
    value,
    display,
    disabled: !!raw.disabled,
    defaultValue: Number.isFinite(raw.defaultValue) ? Number(raw.defaultValue) : null,
    randomEnabled,
    randomMode,
    randomAria,
    randomMin,
    randomMax,
    randomMinDisplay,
    randomMaxDisplay,
    randomMinDefault: Number.isFinite(raw.randomMinDefault) ? Number(raw.randomMinDefault) : null,
    randomMaxDefault: Number.isFinite(raw.randomMaxDefault) ? Number(raw.randomMaxDefault) : null,
    randomMinAriaLabel: typeof raw.randomMinAriaLabel === 'string' ? raw.randomMinAriaLabel : 'Minimum random scale',
    randomMaxAriaLabel: typeof raw.randomMaxAriaLabel === 'string' ? raw.randomMaxAriaLabel : 'Maximum random scale',
    strength,
    strengthMin,
    strengthMax,
    strengthStep,
    strengthDisplay,
    strengthDefault: Number.isFinite(raw.strengthDefault) ? Number(raw.strengthDefault) : null,
    randomLabel,
    randomTooltip,
    randomHint,
    randomButtonVisible
  };
}

export function prepareRotationContext(raw) {
  if (!raw || typeof raw !== 'object' || !raw.available) {
    return { available: false };
  }
  const clamp = (value, min, max, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  };
  const min = Number.isFinite(raw.min) ? Number(raw.min) : 0;
  const max = Number.isFinite(raw.max) ? Number(raw.max) : 360;
  const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
  const value = clamp(raw.value, min, max, min);
  const randomEnabled = !!raw.randomEnabled;
  const randomMode = raw.randomMode === 'range' ? 'range' : 'strength';
  const strengthMin = Number.isFinite(raw.strengthMin) ? Number(raw.strengthMin) : 0;
  const strengthMax = Number.isFinite(raw.strengthMax) ? Number(raw.strengthMax) : 180;
  const strengthStep = Number.isFinite(raw.strengthStep) && Number(raw.strengthStep) > 0 ? Number(raw.strengthStep) : 1;
  const strength = clamp(raw.strength, strengthMin, strengthMax, strengthMin);
  const randomMinSeed = clamp(raw.randomMin, min, max, value);
  const randomMaxSeed = clamp(raw.randomMax, min, max, randomMinSeed);
  const randomMin = Math.min(randomMinSeed, randomMaxSeed);
  const randomMax = Math.max(randomMinSeed, randomMaxSeed);
  const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}°`;
  const strengthDisplay = typeof raw.strengthDisplay === 'string'
    ? raw.strengthDisplay
    : (strength > 0 ? `±${Math.round(strength)}°` : '±0°');
  const randomMinDisplay = typeof raw.randomMinDisplay === 'string'
    ? raw.randomMinDisplay
    : `${Math.round(randomMin)}°`;
  const randomMaxDisplay = typeof raw.randomMaxDisplay === 'string'
    ? raw.randomMaxDisplay
    : `${Math.round(randomMax)}°`;
  const randomLabel = typeof raw.randomLabel === 'string' ? raw.randomLabel : 'Random';
  const randomTooltip = typeof raw.randomTooltip === 'string'
    ? raw.randomTooltip
    : (randomEnabled ? 'Disable random rotation' : 'Enable random rotation');
  const randomAria = typeof raw.randomAria === 'string'
    ? raw.randomAria
    : (randomEnabled ? 'Disable random rotation' : 'Enable random rotation');
  const randomHint = typeof raw.randomHint === 'string' ? raw.randomHint : '';
  const randomButtonVisible = raw.randomButtonVisible !== undefined ? !!raw.randomButtonVisible : true;
  return {
    available: true,
    min,
    max,
    step,
    value,
    display,
    disabled: !!raw.disabled,
    defaultValue: Number.isFinite(raw.defaultValue) ? Number(raw.defaultValue) : null,
    randomEnabled,
    randomMode,
    randomAria,
    randomMin,
    randomMax,
    randomMinDisplay,
    randomMaxDisplay,
    randomMinDefault: Number.isFinite(raw.randomMinDefault) ? Number(raw.randomMinDefault) : null,
    randomMaxDefault: Number.isFinite(raw.randomMaxDefault) ? Number(raw.randomMaxDefault) : null,
    randomMinAriaLabel: typeof raw.randomMinAriaLabel === 'string' ? raw.randomMinAriaLabel : 'Minimum random rotation',
    randomMaxAriaLabel: typeof raw.randomMaxAriaLabel === 'string' ? raw.randomMaxAriaLabel : 'Maximum random rotation',
    strength,
    strengthMin,
    strengthMax,
    strengthStep,
    strengthDisplay,
    strengthDefault: Number.isFinite(raw.strengthDefault) ? Number(raw.strengthDefault) : null,
    randomLabel,
    randomTooltip,
    randomHint,
    randomButtonVisible
  };
}

export function prepareShapeStackingContext(raw) {
  const shapeStackingRaw = raw && typeof raw === 'object' ? raw : null;
  return shapeStackingRaw && shapeStackingRaw.available
    ? {
        available: true,
        hasSelection: !!shapeStackingRaw.hasSelection,
        orderLabel: typeof shapeStackingRaw.orderLabel === 'string' ? shapeStackingRaw.orderLabel : '',
        elevationLabel: typeof shapeStackingRaw.elevationLabel === 'string' ? shapeStackingRaw.elevationLabel : '',
        pushTopDisabled: !!shapeStackingRaw.pushTopDisabled,
        pushBottomDisabled: !!shapeStackingRaw.pushBottomDisabled,
        hint: typeof shapeStackingRaw.hint === 'string' ? shapeStackingRaw.hint : ''
      }
    : { available: false };
}

export function prepareTextureOffsetContext(raw) {
  if (!raw || typeof raw !== 'object' || !raw.available) {
    return { available: false };
  }
  const buildAxis = (axisRaw = {}) => {
    const min = Number.isFinite(axisRaw.min) ? Number(axisRaw.min) : -500;
    const max = Number.isFinite(axisRaw.max) ? Number(axisRaw.max) : 500;
    const step = Number.isFinite(axisRaw.step) && Number(axisRaw.step) > 0 ? Number(axisRaw.step) : 1;
    const value = Number.isFinite(axisRaw.value) ? Number(axisRaw.value) : 0;
    const display = typeof axisRaw.display === 'string' ? axisRaw.display : `${Math.round(value)} px`;
    const defaultValue = Number.isFinite(axisRaw.defaultValue) ? Number(axisRaw.defaultValue) : null;
    return {
      min,
      max,
      step,
      value,
      display,
      defaultValue
    };
  };
  const disabled = !!raw.disabled;
  const hint = typeof raw.hint === 'string' ? raw.hint : '';
  const x = buildAxis(raw.x || {});
  const y = buildAxis(raw.y || {});
  return {
    available: true,
    hint,
    disabled,
    x: { ...x, disabled: !!(x.disabled || disabled) },
    y: { ...y, disabled: !!(y.disabled || disabled) }
  };
}

export function prepareLayerOpacityContext(raw) {
  if (!raw || typeof raw !== 'object' || !raw.available) {
    return { available: false };
  }
  const min = Number.isFinite(raw.min) ? Number(raw.min) : 0;
  const max = Number.isFinite(raw.max) ? Number(raw.max) : 100;
  const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
  const value = Number.isFinite(raw.value) ? Number(raw.value) : max;
  const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
  return {
    available: true,
    min,
    max,
    step,
    value,
    display,
    defaultValue: Number.isFinite(raw.defaultValue) ? Number(raw.defaultValue) : null
  };
}

export function preparePathFeatherContext(raw) {
  if (!raw || typeof raw !== 'object' || raw.available === false) {
    return { available: false };
  }
  const unitLabel = typeof raw.unitLabel === 'string' && raw.unitLabel.trim().length ? raw.unitLabel.trim() : 'grid';
  const hint = typeof raw.hint === 'string' ? raw.hint : '';
  const normalizeLength = (lengthRaw = {}) => {
    const min = Number.isFinite(lengthRaw.min) ? Number(lengthRaw.min) : 0;
    const max = Number.isFinite(lengthRaw.max) ? Number(lengthRaw.max) : 10;
    const step = Number.isFinite(lengthRaw.step) && Number(lengthRaw.step) > 0 ? Number(lengthRaw.step) : 0.1;
    const value = Number.isFinite(lengthRaw.value) ? Number(lengthRaw.value) : 0;
    const clamped = Math.min(max, Math.max(min, value));
    const display = typeof lengthRaw.display === 'string' ? lengthRaw.display : `${clamped.toFixed(2)} ${unitLabel}`;
    const defaultValue = Number.isFinite(lengthRaw.defaultValue) ? Number(lengthRaw.defaultValue) : null;
    return {
      min,
      max,
      step,
      value: clamped,
      display,
      defaultValue,
      disabled: !!lengthRaw.disabled
    };
  };
  const normalizeEndpoint = (endpointRaw = {}) => {
    const enabled = !!endpointRaw.enabled;
    const length = normalizeLength(endpointRaw.length || {});
    return { enabled, length };
  };
  const start = normalizeEndpoint(raw.start);
  const end = normalizeEndpoint(raw.end);
  return {
    available: true,
    unitLabel,
    hint,
    start,
    end
  };
}

export function prepareOpacityFeatherContext(raw) {
  if (!raw || typeof raw !== 'object' || raw.available === false) {
    return { available: false };
  }
  const unitLabel = typeof raw.unitLabel === 'string' && raw.unitLabel.trim().length ? raw.unitLabel.trim() : 'grid';
  const hint = typeof raw.hint === 'string' ? raw.hint : '';
  const normalizeEndpoint = (endpointRaw = {}) => {
    const enabled = !!endpointRaw.enabled;
    const lengthRaw = endpointRaw.length || {};
    const min = Number.isFinite(lengthRaw.min) ? Number(lengthRaw.min) : 0;
    const max = Number.isFinite(lengthRaw.max) ? Number(lengthRaw.max) : 10;
    const step = Number.isFinite(lengthRaw.step) && Number(lengthRaw.step) > 0 ? Number(lengthRaw.step) : 0.1;
    const value = Number.isFinite(lengthRaw.value) ? Number(lengthRaw.value) : 0;
    const clamped = Math.min(max, Math.max(min, value));
    const display = typeof lengthRaw.display === 'string' ? lengthRaw.display : `${clamped.toFixed(2)} ${unitLabel}`;
    const defaultValue = Number.isFinite(lengthRaw.defaultValue) ? Number(lengthRaw.defaultValue) : null;
    return {
      enabled,
      length: {
        min,
        max,
        step,
        value: clamped,
        display,
        defaultValue,
        disabled: !!lengthRaw.disabled
      }
    };
  };
  const start = normalizeEndpoint(raw.start || {});
  const end = normalizeEndpoint(raw.end || {});
  return {
    available: true,
    unitLabel,
    hint,
    start,
    end
  };
}

export function preparePathShadowContext(raw) {
  if (!raw || typeof raw !== 'object' || !raw.available) {
    return { available: false };
  }
  const coerceNumber = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };
  const coerceString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
  const coerceBool = (value) => !!value;
  const normalizeSlider = (config = {}, defaults = {}) => ({
    min: coerceNumber(config.min, defaults.min ?? 0),
    max: coerceNumber(config.max, defaults.max ?? 1),
    step: coerceNumber(config.step, defaults.step ?? 0.1),
    value: coerceNumber(config.value, defaults.value ?? 0),
    defaultValue: Number.isFinite(config.defaultValue)
      ? Number(config.defaultValue)
      : (Number.isFinite(defaults.defaultValue) ? Number(defaults.defaultValue) : null),
    display: coerceString(config.display, defaults.display ?? String(coerceNumber(config.value, defaults.value ?? 0))),
    disabled: coerceBool(config.disabled),
    hint: coerceString(config.hint, '')
  });
  const normalizePreset = (entry, index) => {
    const data = entry && typeof entry === 'object' ? entry : {};
    const saved = coerceBool(data.saved);
    const idx = Number.isInteger(data.index) ? Number(data.index) : index;
    const label = coerceString(data.label, String(index + 1));
    const baseTooltip = saved
      ? `Click to apply preset ${index + 1}.`
      : `Shift+Click to save preset ${index + 1}.`;
    const tooltip = coerceString(data.tooltip, baseTooltip);
    return {
      index: idx,
      label,
      saved,
      active: coerceBool(data.active),
      tooltip
    };
  };
  return {
    available: true,
    enabled: coerceBool(raw.enabled),
    disabled: coerceBool(raw.disabled),
    editMode: coerceBool(raw.editMode),
    editAvailable: raw.editAvailable !== false,
    editDisabled: coerceBool(raw.editDisabled),
    editReset: (() => {
      const resetRaw = raw.editReset && typeof raw.editReset === 'object' ? raw.editReset : null;
      if (!resetRaw) return null;
      return {
        disabled: coerceBool(resetRaw.disabled),
        tooltip: coerceString(resetRaw.tooltip, '')
      };
    })(),
    shadowOnly: (() => {
      const optionRaw = raw.shadowOnly && typeof raw.shadowOnly === 'object' ? raw.shadowOnly : null;
      if (!optionRaw?.available) return { available: false };
      return {
        available: true,
        enabled: coerceBool(optionRaw.enabled),
        disabled: coerceBool(optionRaw.disabled),
        label: coerceString(optionRaw.label, 'Shadow only'),
        tooltip: coerceString(optionRaw.tooltip, '')
      };
    })(),
    activePreset: Number.isInteger(raw.activePreset) ? Number(raw.activePreset) : -1,
    presets: Array.isArray(raw.presets) ? raw.presets.map((entry, index) => normalizePreset(entry, index)) : [],
    presetsHint: coerceString(raw.presetsHint, ''),
    reset: (() => {
      const resetRaw = raw.reset && typeof raw.reset === 'object' ? raw.reset : {};
      return {
        disabled: coerceBool(resetRaw.disabled),
        tooltip: coerceString(resetRaw.tooltip, '')
      };
    })(),
    context: (() => {
      const contextRaw = raw.context && typeof raw.context === 'object' ? raw.context : {};
      return {
        display: coerceString(contextRaw.display, '0'),
        note: coerceString(contextRaw.note, '')
      };
    })(),
    scale: normalizeSlider(raw.scale, {
      min: 10,
      max: 250,
      step: 1,
      value: 100,
      display: '100%',
      disabled: false
    }),
    offset: normalizeSlider(raw.offset, { min: 0, max: 0, step: 0.01, value: 0, display: '0' }),
    alpha: normalizeSlider(raw.alpha, { min: 0, max: 1, step: 0.01, value: 1, display: '100%' }),
    blur: normalizeSlider(raw.blur, { min: 0, max: 5, step: 0.1, value: 0, display: '0 px' }),
    dilation: normalizeSlider(raw.dilation, { min: 0, max: 5, step: 0.1, value: 0, display: '0 px' })
  };
}

export function prepareDropShadowControls(raw, dropShadowState) {
  if (!raw || typeof raw !== 'object' || !raw.available) {
    return { available: false };
  }
  const disabled = !!raw.disabled || !!dropShadowState?.disabled;
  const coerceNumber = (value, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return num;
  };
  const coerceString = (val, fallback) => {
    if (val === undefined || val === null) return fallback;
    const str = String(val);
    return str.length ? str : fallback;
  };
  const coerceEntry = (entry, defaults) => {
    const data = entry && typeof entry === 'object' ? entry : {};
    const entryDisabled = disabled || !!data.disabled;
    return {
      label: coerceString(data.label, defaults.label),
      value: coerceString(data.value ?? defaults.value, defaults.value),
      min: coerceNumber(data.min, defaults.min),
      max: coerceNumber(data.max, defaults.max),
      step: coerceNumber(data.step, defaults.step),
      defaultValue: coerceNumber(data.defaultValue, defaults.defaultValue ?? defaults.value),
      display: coerceString(data.display, defaults.display),
      hint: coerceString(data.hint, ''),
      disabled: entryDisabled
    };
  };
  const alpha = coerceEntry(raw.alpha, { label: 'Opacity', value: '65', defaultValue: 65, min: 0, max: 100, step: 1, display: '65%' });
  const dilation = coerceEntry(raw.dilation, { label: 'Spread', value: '1.6', defaultValue: 1.6, min: 0, max: 20, step: 0.1, display: '1.6 px' });
  const blur = coerceEntry(raw.blur, { label: 'Blur', value: '1.8', defaultValue: 1.8, min: 0, max: 12, step: 0.1, display: '1.8 px' });
  const offsetRaw = raw.offset && typeof raw.offset === 'object' ? raw.offset : {};
  const offset = {
    distance: Number(offsetRaw.distance ?? 0) || 0,
    angle: Number(offsetRaw.angle ?? 0) || 0,
    maxDistance: Number(offsetRaw.maxDistance ?? 40) || 40,
    maxDistanceDefault: coerceNumber(offsetRaw.maxDistanceDefault, 40),
    maxDistanceMin: coerceNumber(offsetRaw.maxDistanceMin, 1),
    maxDistanceLimit: coerceNumber(offsetRaw.maxDistanceLimit, 512),
    maxDistanceStep: coerceNumber(offsetRaw.maxDistanceStep, 1),
    maxDistanceHint: coerceString(offsetRaw.maxDistanceHint, ''),
    offsetMaxHandlerId: coerceString(offsetRaw.offsetMaxHandlerId, ''),
    mode: coerceString(offsetRaw.mode, ''),
    displayDistance: coerceString(offsetRaw.displayDistance, '0.0 px'),
    displayAngle: coerceString(offsetRaw.displayAngle, '0°'),
    hint: coerceString(offsetRaw.hint, ''),
    disabled
  };
  const collapsed = !!raw.collapsed;
  const presets = Array.isArray(raw.presets)
    ? raw.presets.map((entry, index) => {
      const data = entry && typeof entry === 'object' ? entry : {};
      return {
        index,
        label: coerceString(data.label, String(index + 1)),
        saved: !!data.saved,
        active: !!data.active,
        tooltip: coerceString(data.tooltip, data.saved ? `Click to apply preset ${index + 1}.` : `Shift+Click to save preset ${index + 1}.`)
      };
    })
    : [];
  const shadowOnlyRaw = raw.shadowOnly && typeof raw.shadowOnly === 'object' ? raw.shadowOnly : null;
  const shadowOnly = shadowOnlyRaw?.available
    ? {
        available: true,
        enabled: !!shadowOnlyRaw.enabled,
        disabled: disabled || !!shadowOnlyRaw.disabled,
        label: coerceString(shadowOnlyRaw.label, 'Shadow only'),
        tooltip: coerceString(shadowOnlyRaw.tooltip, '')
      }
    : { available: false };
  const contextRaw = raw.context && typeof raw.context === 'object' ? raw.context : {};
  const context = {
    display: coerceString(contextRaw.display, ''),
    status: coerceString(contextRaw.status, ''),
    note: coerceString(contextRaw.note, ''),
    tileCount: coerceNumber(contextRaw.tileCount, 0) || 0,
    hasTiles: !!contextRaw.hasTiles,
    source: coerceString(contextRaw.source, '')
  };
  return {
    available: true,
    disabled,
    collapsed,
    presets,
    alpha,
    dilation,
    blur,
    offset,
    shadowOnly,
    context,
    preview: raw.preview && typeof raw.preview === 'object' ? raw.preview : null
  };
}

export function prepareShowWidthTangentsContext(raw) {
  if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
  return {
    available: true,
    enabled: !!raw.enabled,
    label: typeof raw.label === 'string' ? raw.label : 'Show Width Tangents',
    tooltip: typeof raw.tooltip === 'string' ? raw.tooltip : 'Display width adjustment handles.',
    disabled: !!raw.disabled
  };
}

export function preparePathScaleContext(raw) {
  if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
  const value = Number(raw.value ?? 100);
  const min = Number(raw.min ?? 10);
  const max = Number(raw.max ?? 250);
  const step = Number(raw.step ?? 1);
  const disabled = !!raw.disabled;
  const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
  return {
    available: true,
    min,
    max,
    step,
    value,
    display,
    defaultValue: Number.isFinite(raw.defaultValue) ? Number(raw.defaultValue) : null,
    disabled
  };
}

export function preparePathTensionContext(raw) {
  if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
  const value = Number(raw.value ?? 0);
  const min = Number(raw.min ?? 0);
  const max = Number(raw.max ?? 1);
  const step = Number(raw.step ?? 0.01);
  const disabled = !!raw.disabled;
  const display = typeof raw.display === 'string' ? raw.display : value.toFixed(2);
  return {
    available: true,
    min,
    max,
    step,
    value,
    display,
    defaultValue: Number.isFinite(raw.defaultValue) ? Number(raw.defaultValue) : null,
    disabled
  };
}

export function prepareFreehandSimplifyContext(raw) {
  if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
  const value = Number(raw.value ?? 0);
  const min = Number(raw.min ?? 0);
  const max = Number(raw.max ?? 1);
  const step = Number(raw.step ?? 0.01);
  const disabled = !!raw.disabled;
  const display = typeof raw.display === 'string' ? raw.display : value.toFixed(2);
  const hint = typeof raw.hint === 'string' ? raw.hint : '';
  return {
    available: true,
    min,
    max,
    step,
    value,
    display,
    defaultValue: Number.isFinite(raw.defaultValue) ? Number(raw.defaultValue) : null,
    hint,
    disabled
  };
}

export function preparePathAppearanceContext(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const layerOpacity = prepareLayerOpacityContext(data.layerOpacity);
  const textureOffset = prepareTextureOffsetContext(data.textureOffset);
  const scale = preparePathScaleContext(data.scale);
  const tension = preparePathTensionContext(data.tension);
  const freehandSimplify = prepareFreehandSimplifyContext(data.freehandSimplify);
  const showWidthTangents = prepareShowWidthTangentsContext(data.showWidthTangents);
  const hint = typeof data.hint === 'string' ? data.hint : '';
  return {
    available: !!(layerOpacity.available || textureOffset.available || scale.available || tension.available || freehandSimplify.available || showWidthTangents.available),
    hint,
    layerOpacity,
    textureOffset,
    scale,
    tension,
    freehandSimplify,
    showWidthTangents
  };
}
