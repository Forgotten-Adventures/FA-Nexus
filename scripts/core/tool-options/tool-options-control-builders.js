export function addDeclarativeHintControl(controls, { id, text } = {}) {
  if (!id || typeof text !== 'string' || !text.trim().length) return null;
  controls[id] = {
    id,
    type: 'hint',
    text: text.trim()
  };
  return id;
}

export function addDeclarativeRangeControl(controls, {
  id,
  label,
  state,
  handlerId,
  handlerArg,
  headerToggle,
  compact = false,
  ariaLabel = '',
  inputOnly = false
} = {}, {
  includeHandlerArg = false,
  includeHeaderToggle = false
} = {}) {
  if (!id || !state || typeof state !== 'object') return null;
  controls[id] = {
    id,
    type: 'range',
    label,
    ...(includeHeaderToggle ? {
      headerToggle: headerToggle && typeof headerToggle === 'object' ? { ...headerToggle } : null
    } : {}),
    compact,
    ariaLabel,
    handlerId,
    ...(includeHandlerArg || handlerArg !== undefined ? { handlerArg } : {}),
    min: state.min,
    max: state.max,
    step: state.step,
    value: state.value,
    display: state.display,
    defaultValue: state.defaultValue,
    disabled: !!state.disabled,
    hint: typeof state.hint === 'string' ? state.hint : '',
    tooltip: typeof state.tooltip === 'string' ? state.tooltip : '',
    inputOnly: !!inputOnly || !!state.inputOnly
  };
  return id;
}

export function addDeclarativeRangePairControl(controls, {
  id,
  label,
  state,
  handlerId,
  hint = state?.hint,
  ariaLabelX = '',
  ariaLabelY = '',
  items = null
} = {}) {
  if (!id || !state || typeof state !== 'object') return null;
  const sourceItems = Array.isArray(items)
    ? items
    : [
      { id: 'x', label: 'X', ariaLabel: ariaLabelX, handlerArg: 'x', state: state.x },
      { id: 'y', label: 'Y', ariaLabel: ariaLabelY, handlerArg: 'y', state: state.y }
    ];
  const pairItems = sourceItems
    .map((item) => ({
      id: String(item?.id || ''),
      label: String(item?.label || item?.id || ''),
      ariaLabel: typeof item?.ariaLabel === 'string' ? item.ariaLabel : '',
      ...(item?.handlerArg !== undefined ? { handlerArg: item.handlerArg } : {}),
      ...(item?.state && typeof item.state === 'object' ? item.state : {})
    }))
    .filter((item) => item.id.length);
  if (!pairItems.length) return null;
  controls[id] = {
    id,
    type: 'range-pair',
    label,
    handlerId,
    hint: typeof hint === 'string' ? hint : '',
    items: pairItems
  };
  return id;
}

export function addDeclarativeToggleControl(controls, {
  id,
  label,
  value = false,
  disabled = false,
  tooltip = '',
  hint = '',
  handlerId = '',
  handlerArg
} = {}, {
  includeHandlerArg = false
} = {}) {
  if (!id) return null;
  controls[id] = {
    id,
    type: 'toggle',
    label,
    value: !!value,
    disabled: !!disabled,
    tooltip,
    hint,
    handlerId,
    ...(includeHandlerArg || handlerArg !== undefined ? { handlerArg } : {})
  };
  return id;
}

export function addDeclarativeSelectControl(controls, {
  id,
  label,
  state,
  handlerId,
  valueMode = 'string'
} = {}) {
  if (!id || !state || typeof state !== 'object') return null;
  const options = Array.isArray(state.options)
    ? state.options
      .map((option) => ({
        value: String(option?.value ?? option?.id ?? ''),
        label: String(option?.label ?? option?.value ?? option?.id ?? ''),
        selected: !!option?.selected,
        disabled: !!option?.disabled
      }))
      .filter((option) => option.value.length)
    : [];
  if (!options.length) return null;
  controls[id] = {
    id,
    type: 'select',
    label,
    handlerId,
    valueMode,
    value: String(state.value ?? options.find((option) => option.selected)?.value ?? options[0]?.value ?? ''),
    options,
    disabled: !!state.disabled,
    hint: typeof state.hint === 'string' ? state.hint : '',
    tooltip: typeof state.tooltip === 'string' ? state.tooltip : ''
  };
  return id;
}

export function addDeclarativeToggleListControl(controls, { id, items } = {}) {
  if (!id || !Array.isArray(items) || !items.length) return null;
  controls[id] = {
    id,
    type: 'toggle-list',
    items
  };
  return id;
}

export function addDeclarativeActionRowControl(controls, { id, handlerId = '', previewHandlerId = '', actions } = {}, {
  includeHandlerId = false
} = {}) {
  if (!id) return null;
  const list = Array.isArray(actions)
    ? actions.filter((action) => action && typeof action === 'object')
    : [];
  if (!list.length) return null;
  controls[id] = {
    id,
    type: 'action-row',
    ...(includeHandlerId || handlerId ? { handlerId } : {}),
    ...(previewHandlerId ? { previewHandlerId } : {}),
    actions: list
  };
  return id;
}

export function addDeclarativeAxisTogglePairControl(controls, {
  id,
  label,
  state,
  horizontalHandlerId,
  verticalHandlerId,
  horizontalRandomHandlerId = '',
  verticalRandomHandlerId = ''
} = {}) {
  if (!id || !state || typeof state !== 'object') return null;
  controls[id] = {
    id,
    type: 'axis-toggle-pair',
    label,
    state,
    horizontalHandlerId,
    verticalHandlerId,
    horizontalRandomHandlerId,
    verticalRandomHandlerId
  };
  return id;
}

export function addDeclarativeScalarControl(controls, {
  id,
  label,
  ariaLabel = '',
  state,
  variant = 'scale',
  handlerId
} = {}) {
  if (!id || !state || typeof state !== 'object') return null;
  controls[id] = {
    id,
    type: 'scalar',
    variant,
    label: typeof state.label === 'string' && state.label.trim().length ? state.label.trim() : label,
    ariaLabel,
    state,
    handlerId
  };
  return id;
}

export function addDeclarativeScalarRandomizedControl(controls, {
  id,
  label,
  ariaLabel = '',
  state,
  variant = 'scale',
  handlerId,
  randomHandlerId = '',
  strengthHandlerId = '',
  randomMinHandlerId,
  randomMaxHandlerId
} = {}) {
  if (!id || !state || typeof state !== 'object') return null;
  controls[id] = {
    id,
    type: 'scalar-randomized',
    variant,
    label: typeof state.label === 'string' && state.label.trim().length ? state.label.trim() : label,
    ariaLabel,
    state,
    handlerId,
    randomHandlerId,
    strengthHandlerId,
    ...(randomMinHandlerId !== undefined ? { randomMinHandlerId } : {}),
    ...(randomMaxHandlerId !== undefined ? { randomMaxHandlerId } : {})
  };
  return id;
}
