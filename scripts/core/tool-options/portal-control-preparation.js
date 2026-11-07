export function prepareDeclarativePortalControl(control, id, { isSectionCollapsed = () => false } = {}) {
  const inferredVariant = (() => {
    if (control?.variant === 'door' || control?.type === 'door-controls') return 'door';
    if (control?.variant === 'window' || control?.type === 'window-controls') return 'window';
    if (control?.variant === 'seamlessSecretDoor' || control?.type === 'seamless-secret-door-controls') {
      return 'seamlessSecretDoor';
    }
    return '';
  })();
  if (!inferredVariant) return null;
  const raw = control?.state && typeof control.state === 'object' ? control.state : null;
  if (!raw?.available) return null;

  const coerceString = (value, fallback = '') => {
    if (value === undefined || value === null) return fallback;
    const text = String(value);
    return text.length ? text : fallback;
  };
  const coerceNumber = (value, fallback = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  };
  const disabled = !!raw.disabled;

  const makeOptions = (entries = [], fallbackValue) => {
    const list = Array.isArray(entries) ? entries : [];
    return list.map((entry, index) => {
      const data = entry && typeof entry === 'object' ? entry : {};
      const fallback = typeof fallbackValue === 'function' ? fallbackValue(data, index) : index;
      const value = data.value ?? data.id ?? fallback;
      return {
        value: String(value),
        label: coerceString(data.label, String(index + 1)),
        selected: !!data.selected
      };
    });
  };

  const makeAction = ({
    id: actionId,
    handlerId,
    title = '',
    icon = '',
    label = '',
    disabled: actionDisabled = false,
    primary = false
  } = {}) => ({
    id: String(actionId || ''),
    handlerId: String(handlerId || ''),
    title: coerceString(title, ''),
    icon: coerceString(icon, ''),
    label: coerceString(label, ''),
    disabled: !!actionDisabled,
    primary: !!primary
  });

  const makeToggle = ({ id: toggleId, label, title = '', checked = false, disabled: toggleDisabled = false, handlerId } = {}) => ({
    id: String(toggleId || ''),
    label: coerceString(label, ''),
    title: coerceString(title, ''),
    checked: !!checked,
    disabled: !!toggleDisabled,
    handlerId: String(handlerId || '')
  });

  const makeSelect = ({
    id: selectId,
    label,
    handlerId,
    value,
    options = [],
    disabled: selectDisabled = false,
    valueMode = 'string'
  } = {}) => {
    const selectedValue = String(value ?? '');
    return {
      id: String(selectId || ''),
      label: coerceString(label, ''),
      handlerId: String(handlerId || ''),
      value: selectedValue,
      disabled: !!selectDisabled,
      valueMode,
      options: (Array.isArray(options) ? options : []).map((option) => ({
        value: String(option?.value ?? ''),
        label: coerceString(option?.label, ''),
        selected: String(option?.value ?? '') === selectedValue || !!option?.selected
      }))
    };
  };

  const makeRow = ({
    id: rowId,
    label,
    handlerId,
    min,
    max,
    step,
    value,
    defaultValue,
    display = '',
    disabled: rowDisabled = false,
    hint = ''
  } = {}) => ({
    id: String(rowId || ''),
    label: coerceString(label, ''),
    handlerId: String(handlerId || ''),
    min: coerceNumber(min, 0),
    max: coerceNumber(max, 0),
    step: coerceNumber(step, 1),
    value: coerceNumber(value, 0),
    defaultValue: defaultValue === undefined ? undefined : coerceNumber(defaultValue, 0),
    display: coerceString(display, ''),
    disabled: !!rowDisabled,
    hint: coerceString(hint, ''),
    valueMode: 'number'
  });

  const makeColorTarget = ({
    id: targetId,
    handlerId,
    groupName,
    visible = true,
    items = []
  } = {}) => ({
    id: String(targetId || ''),
    handlerId: String(handlerId || ''),
    groupName: coerceString(groupName, ''),
    visible: visible !== false,
    items: (Array.isArray(items) ? items : []).map((item) => ({
      id: String(item?.id || ''),
      groupName: coerceString(groupName, ''),
      label: coerceString(item?.label, ''),
      title: coerceString(item?.tooltip ?? item?.title, ''),
      enabled: !!item?.enabled,
      disabled: !!item?.disabled
    }))
  });

  const makePickerActions = ({
    id: pickerId,
    icon,
    label,
    pickHandlerId,
    clearHandlerId,
    title = '',
    clearTitle = 'Clear',
    hidden = false
  } = {}) => {
    const pickId = `${pickerId}-pick`;
    const clearId = `${pickerId}-clear`;
    return {
      visible: !hidden,
      pickAction: makeAction({
        id: pickId,
        handlerId: pickHandlerId,
        title,
        icon,
        label,
        disabled
      }),
      clearAction: makeAction({
        id: clearId,
        handlerId: clearHandlerId,
        title: clearTitle,
        label: 'Clear',
        disabled
      })
    };
  };

  const actionMap = Object.create(null);
  const toggleMap = Object.create(null);
  const selectMap = Object.create(null);
  const settingMap = Object.create(null);
  const toggleGroupMap = Object.create(null);
  const selectGroupMap = Object.create(null);
  const sectionMap = Object.create(null);

  const registerAction = (action) => {
    if (action?.id) actionMap[action.id] = action;
    return action;
  };
  const registerToggleGroup = (group) => {
    if (group?.id) toggleGroupMap[group.id] = group;
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      if (item?.id) toggleMap[item.id] = item;
    }
    return group;
  };
  const registerSelectGroup = (group) => {
    if (group?.id) selectGroupMap[group.id] = group;
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      if (item?.id) selectMap[item.id] = item;
    }
    return group;
  };
  const registerSettingRows = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.id) settingMap[row.id] = row;
    }
  };
  const registerSection = (section) => {
    if (section?.id) sectionMap[section.id] = section;
    if (section?.picker?.pickAction) registerAction(section.picker.pickAction);
    if (section?.picker?.clearAction) registerAction(section.picker.clearAction);
    registerSettingRows(section?.settings?.rows);
    return section;
  };

  const selectionLabel = coerceString(raw.selectionLabel, '');
  const selectionDisabled = disabled || !raw.hasSelection;
  const buildPortalHeaderActions = ({ defaultsKind = null, transferOnly = false } = {}) => [
    ...(defaultsKind ? [
      registerAction(makeAction({
        id: 'apply-selected-to-defaults',
        handlerId: defaultsKind === 'door' ? 'applyDoorDefaults' : 'applyWindowDefaults',
        title: `Use the selected ${defaultsKind} as the default for new placements`,
        icon: 'fas fa-arrow-up-right-dots',
        label: 'Use Selected as Defaults',
        disabled: selectionDisabled
      })),
      registerAction(makeAction({
        id: 'apply-defaults-to-selected',
        handlerId: defaultsKind === 'door' ? 'applyDoorDefaultsToSelected' : 'applyWindowDefaultsToSelected',
        title: `Apply the current ${defaultsKind} defaults to the selected ${defaultsKind}`,
        icon: 'fas fa-file-import',
        label: 'Apply Defaults to Selected',
        disabled: selectionDisabled,
        primary: true
      }))
    ] : []),
    ...(!transferOnly ? [registerAction(makeAction({
      id: 'advanced',
      handlerId: 'openPortalAdvanced',
      title: 'Edit native Foundry restrictions, state, sound, and animation fields',
      icon: 'fas fa-sliders',
      label: 'Advanced',
      disabled
    })),
    registerAction(makeAction({
      id: 'convert',
      handlerId: 'convertPortal',
      title: 'Convert this Portal to another kind',
      icon: 'fas fa-repeat',
      label: 'Convert',
      disabled: selectionDisabled
    })),
    registerAction(makeAction({
      id: 'clear-selection',
      handlerId: 'clearPortalSelection',
      title: 'Return to new Portal defaults without changing the selected Portal',
      icon: 'fas fa-xmark',
      label: 'Clear Selection',
      disabled: selectionDisabled
    })),
    registerAction(makeAction({
      id: 'delete',
      handlerId: 'deletePortal',
      title: 'Delete this Portal from the Building draft',
      icon: 'fas fa-trash',
      label: 'Delete',
      disabled: selectionDisabled
    }))] : [])
  ];
  const normalizePortalTextureFlip = (source = {}) => {
    const flip = source?.textureFlip && typeof source.textureFlip === 'object' ? source.textureFlip : {};
    return {
      horizontal: Object.prototype.hasOwnProperty.call(flip, 'horizontal')
        ? !!flip.horizontal
        : !!(source?.flipHorizontal ?? source?.flipX),
      vertical: Object.prototype.hasOwnProperty.call(flip, 'vertical')
        ? !!flip.vertical
        : !!source?.flip
    };
  };

  if (inferredVariant === 'door') {
    const animations = makeOptions(raw.animations, (_, index) => index);
    const directions = makeOptions(raw.directions, (_, index) => (index === 0 ? -1 : 1));
    const initialStates = makeOptions(raw.initialStates, (_, index) => index);
    const doorSounds = makeOptions(raw.doorSounds, (_, index) => index);
    const selectedAnimation = coerceString(
      raw.selectedAnimation,
      animations.find((option) => option.selected)?.value || ''
    );
    const selectedDirection = String(coerceNumber(raw.direction, 1) === -1 ? -1 : 1);
    const texture = raw.textureSettings && typeof raw.textureSettings === 'object' ? raw.textureSettings : null;
    const frame = raw.frameSettings && typeof raw.frameSettings === 'object' ? raw.frameSettings : null;
    const colorTarget = raw.colorTarget && typeof raw.colorTarget === 'object' ? raw.colorTarget : null;
    const hsbc = raw.hsbc && typeof raw.hsbc === 'object' ? raw.hsbc : null;
    const textureFlip = normalizePortalTextureFlip(raw);

    const headerActions = buildPortalHeaderActions({ defaultsKind: 'door', transferOnly: raw.frameOnly === true });

    const toggleGroups = raw.frameOnly ? [] : [
      registerToggleGroup({
        id: 'primary',
        visible: true,
        items: [
          makeToggle({
            id: 'flip-horizontal',
            label: 'Flip Horizontal',
            title: 'Mirror the selected door texture along the portal width',
            disabled,
            checked: !!textureFlip.horizontal,
            handlerId: 'setDoorFlipHorizontal'
          }),
          makeToggle({
            id: 'flip-vertical',
            label: 'Flip Vertical',
            title: 'Mirror the selected door texture across the wall thickness',
            checked: !!textureFlip.vertical,
            disabled,
            handlerId: 'setDoorFlipVertical'
          }),
          makeToggle({
            id: 'double',
            label: 'Double Door',
            title: 'Spawn a paired door leaf',
            checked: !!raw.double,
            disabled,
            handlerId: 'setDoorDouble'
          }),
          makeToggle({
            id: 'direction-flip',
            label: 'Flip Hinge',
            title: 'Swap door endpoints (hinge flip)',
            checked: !!raw.directionFlip,
            disabled,
            handlerId: 'setDoorDirectionFlip'
          })
        ]
      })
    ];

    const selectGroups = raw.frameOnly ? [] : [
      registerSelectGroup({
        id: 'primary',
        visible: true,
        items: [
          makeSelect({
            id: 'initial-state',
            label: raw.hasSelection ? 'Live State' : 'Initial State',
            handlerId: 'setPortalInitialState',
            value: raw.initialState,
            options: initialStates,
            disabled,
            valueMode: 'number'
          }),
          makeSelect({
            id: 'sound',
            label: 'Door Sound',
            handlerId: 'setPortalSound',
            value: raw.doorSound ?? '',
            options: doorSounds,
            disabled
          }),
          makeSelect({
            id: 'animation',
            label: 'Animation',
            handlerId: 'setDoorAnimation',
            value: selectedAnimation,
            options: animations,
            disabled
          }),
          makeSelect({
            id: 'direction',
            label: 'Open Direction',
            handlerId: 'setDoorDirection',
            value: selectedDirection,
            options: directions,
            disabled,
            valueMode: 'door-direction'
          })
        ]
      })
    ];

    const nativeRows = [
      makeRow({
        id: 'portal-width',
        label: 'Width',
        handlerId: 'setPortalWidth',
        min: raw.width?.min,
        max: raw.width?.max,
        step: raw.width?.step,
        value: raw.width?.value,
        defaultValue: raw.width?.defaultValue,
        display: raw.width?.display,
        disabled
      }),
      makeRow({
        id: 'animation-duration',
        label: 'Duration',
        handlerId: 'setPortalAnimationDuration',
        min: raw.duration?.min,
        max: raw.duration?.max,
        step: raw.duration?.step,
        value: raw.duration?.value,
        defaultValue: raw.duration?.defaultValue,
        display: raw.duration?.display,
        disabled
      }),
      makeRow({
        id: 'animation-strength',
        label: 'Strength',
        handlerId: 'setPortalAnimationStrength',
        min: raw.strength?.min,
        max: raw.strength?.max,
        step: raw.strength?.step,
        value: raw.strength?.value,
        defaultValue: raw.strength?.defaultValue,
        display: raw.strength?.display,
        disabled
      })
    ];
    registerSettingRows(nativeRows);
    const sections = [
      registerSection({
        id: 'native-behavior',
        label: 'Native Behavior',
        visible: true,
        collapsed: !!isSectionCollapsed('native-behavior'),
        picker: null,
        settings: { id: 'native-behavior', visible: true, rows: nativeRows }
      }),
      registerSection({
        id: 'door-texture',
        label: 'Door Texture',
        visible: !raw.hideTexturePickers || !!texture,
        collapsed: !!isSectionCollapsed('door-texture'),
        summary: coerceString(raw.textureLabel, 'None'),
        picker: makePickerActions({
          id: 'door-texture',
          icon: 'fas fa-door-closed',
          label: coerceString(raw.textureLabel, 'Pick Door Texture'),
          pickHandlerId: 'pickDoorTexture',
          clearHandlerId: 'clearDoorTexture',
          hidden: !!raw.hideTexturePickers
        }),
        settings: {
          id: 'door-texture',
          visible: !!texture,
          rows: texture ? [
            makeRow({
              id: 'door-texture-width',
              label: 'Width',
              handlerId: 'setDoorTextureWidth',
              min: texture.widthScaleMin,
              max: texture.widthScaleMax,
              step: texture.widthScaleStep,
              value: texture.widthScale,
              defaultValue: texture.widthScaleDefault,
              display: texture.widthScaleDisplay,
              disabled
            })
          ] : []
        }
      }),
      registerSection({
        id: 'door-frame',
        label: 'Door Frame',
        visible: !raw.hideTexturePickers || !!frame,
        collapsed: !!isSectionCollapsed('door-frame'),
        summary: coerceString(raw.frameLabel, 'None'),
        picker: makePickerActions({
          id: 'door-frame',
          icon: 'fas fa-border-all',
          label: coerceString(raw.frameLabel, 'Pick Door Frame'),
          pickHandlerId: 'pickDoorFrameTexture',
          clearHandlerId: 'clearDoorFrameTexture',
          hidden: !!raw.hideTexturePickers
        }),
        settings: {
          id: 'door-frame',
          visible: !!frame,
          rows: frame ? [
            makeRow({
              id: 'door-frame-scale',
              label: 'Scale',
              handlerId: 'setDoorFrameScale',
              min: frame.scaleMin,
              max: frame.scaleMax,
              step: frame.scaleStep,
              value: frame.scale,
              defaultValue: frame.scaleDefault,
              display: frame.scaleDisplay,
              disabled
            }),
            makeRow({
              id: 'door-frame-offset-x',
              label: 'Offset X',
              handlerId: 'setDoorFrameOffsetX',
              min: frame.offsetMin,
              max: frame.offsetMax,
              step: frame.offsetStep,
              value: frame.offsetX,
              defaultValue: frame.offsetXDefault,
              display: frame.offsetXDisplay,
              disabled
            }),
            makeRow({
              id: 'door-frame-offset-y',
              label: 'Offset Y',
              handlerId: 'setDoorFrameOffsetY',
              min: frame.offsetMin,
              max: frame.offsetMax,
              step: frame.offsetStep,
              value: frame.offsetY,
              defaultValue: frame.offsetYDefault,
              display: frame.offsetYDisplay,
              disabled
            }),
            makeRow({
              id: 'door-frame-rotation',
              label: 'Rotation',
              handlerId: 'setDoorFrameRotation',
              min: frame.rotationMin,
              max: frame.rotationMax,
              step: frame.rotationStep,
              value: frame.rotation,
              defaultValue: frame.rotationDefault,
              display: frame.rotationDisplay,
              disabled: disabled || !!frame.rotationDisabled,
              hint: coerceString(frame.rotationHint, '')
            })
          ] : []
        }
      })
    ].filter(section => !raw.frameOnly || section.id === 'door-frame');

    const colorSection = registerSection({
      id: 'color',
      label: 'Color',
      visible: !!(colorTarget?.available && hsbc?.available),
      collapsed: !!isSectionCollapsed('color'),
      picker: null,
      settings: null
    });

    const color = {
      ...colorSection,
      label: 'Color',
      hint: coerceString(hsbc?.hint, ''),
      target: makeColorTarget({
        id: 'door-color-target',
        handlerId: 'setDoorHsbcTarget',
        groupName: `fa-nexus-portal-color-${id}`,
        visible: !!colorTarget?.available,
        items: Array.isArray(colorTarget?.options) ? colorTarget.options : []
      }),
      rows: hsbc?.available ? [
        makeRow({
          id: 'door-hsbc-hue',
          label: 'Hue',
          handlerId: 'setDoorHsbcHue',
          min: hsbc?.hue?.min,
          max: hsbc?.hue?.max,
          step: hsbc?.hue?.step,
          value: hsbc?.hue?.value,
          defaultValue: hsbc?.hue?.defaultValue,
          display: hsbc?.hue?.display,
          disabled: disabled || !!hsbc?.hue?.disabled,
          hint: coerceString(hsbc?.hue?.tooltip || hsbc?.hint, '')
        }),
        makeRow({
          id: 'door-hsbc-saturation',
          label: 'Saturation',
          handlerId: 'setDoorHsbcSaturation',
          min: hsbc?.saturation?.min,
          max: hsbc?.saturation?.max,
          step: hsbc?.saturation?.step,
          value: hsbc?.saturation?.value,
          defaultValue: hsbc?.saturation?.defaultValue,
          display: hsbc?.saturation?.display,
          disabled: disabled || !!hsbc?.saturation?.disabled,
          hint: coerceString(hsbc?.saturation?.tooltip || hsbc?.hint, '')
        }),
        makeRow({
          id: 'door-hsbc-brightness',
          label: 'Brightness',
          handlerId: 'setDoorHsbcBrightness',
          min: hsbc?.brightness?.min,
          max: hsbc?.brightness?.max,
          step: hsbc?.brightness?.step,
          value: hsbc?.brightness?.value,
          defaultValue: hsbc?.brightness?.defaultValue,
          display: hsbc?.brightness?.display,
          disabled: disabled || !!hsbc?.brightness?.disabled,
          hint: coerceString(hsbc?.brightness?.tooltip || hsbc?.hint, '')
        }),
        makeRow({
          id: 'door-hsbc-contrast',
          label: 'Contrast',
          handlerId: 'setDoorHsbcContrast',
          min: hsbc?.contrast?.min,
          max: hsbc?.contrast?.max,
          step: hsbc?.contrast?.step,
          value: hsbc?.contrast?.value,
          defaultValue: hsbc?.contrast?.defaultValue,
          display: hsbc?.contrast?.display,
          disabled: disabled || !!hsbc?.contrast?.disabled,
          hint: coerceString(hsbc?.contrast?.tooltip || hsbc?.hint, '')
        })
      ] : []
    };
    registerSettingRows(color.rows);

    return {
      ...control,
      id,
      type: 'portal-controls',
      variant: inferredVariant,
      title: raw.frameOnly ? 'Door Frame' : 'Door Options',
      selectionLabel,
      selectionHint: coerceString(raw.selectionHint, ''),
      headerActions,
      toggleGroups,
      selectGroups,
      color,
      sections,
      actionMap,
      toggleMap,
      selectMap,
      settingMap,
      toggleGroupMap,
      selectGroupMap,
      sectionMap
    };
  }

  if (inferredVariant === 'seamlessSecretDoor') {
    const animations = makeOptions(raw.animations, (_, index) => index);
    const directions = makeOptions(raw.directions, (_, index) => (index === 0 ? -1 : 1));
    const initialStates = makeOptions(raw.initialStates, (_, index) => index);
    const doorSounds = makeOptions(raw.doorSounds, (_, index) => index);
    const headerActions = buildPortalHeaderActions();
    const toggleGroups = [
      registerToggleGroup({
        id: 'primary',
        visible: true,
        items: [
          makeToggle({
            id: 'double',
            label: 'Double Door',
            title: 'Use two native DoorMesh leaves',
            checked: !!raw.double,
            disabled,
            handlerId: 'setSeamlessSecretDoorDouble'
          }),
          makeToggle({
            id: 'direction-flip',
            label: 'Flip Hinge',
            title: 'Swap the Portal endpoints',
            checked: !!raw.directionFlip,
            disabled,
            handlerId: 'setSeamlessSecretDoorDirectionFlip'
          })
        ]
      })
    ];
    const selectGroups = [
      registerSelectGroup({
        id: 'primary',
        visible: true,
        items: [
          makeSelect({
            id: 'initial-state',
            label: raw.hasSelection ? 'Live State' : 'Initial State',
            handlerId: 'setPortalInitialState',
            value: raw.initialState,
            options: initialStates,
            disabled,
            valueMode: 'number'
          }),
          makeSelect({
            id: 'sound',
            label: 'Door Sound',
            handlerId: 'setPortalSound',
            value: raw.doorSound ?? '',
            options: doorSounds,
            disabled
          }),
          makeSelect({
            id: 'animation',
            label: 'Animation',
            handlerId: 'setSeamlessSecretDoorAnimation',
            value: raw.selectedAnimation,
            options: animations,
            disabled
          }),
          makeSelect({
            id: 'direction',
            label: 'Open Direction',
            handlerId: 'setSeamlessSecretDoorDirection',
            value: raw.direction,
            options: directions,
            disabled,
            valueMode: 'number'
          })
        ]
      })
    ];
    const rows = [
      makeRow({
        id: 'portal-width',
        label: 'Width',
        handlerId: 'setPortalWidth',
        min: raw.width?.min,
        max: raw.width?.max,
        step: raw.width?.step,
        value: raw.width?.value,
        defaultValue: raw.width?.defaultValue,
        display: raw.width?.display,
        disabled
      }),
      makeRow({
        id: 'animation-duration',
        label: 'Duration',
        handlerId: 'setPortalAnimationDuration',
        min: raw.duration?.min,
        max: raw.duration?.max,
        step: raw.duration?.step,
        value: raw.duration?.value,
        defaultValue: raw.duration?.defaultValue,
        display: raw.duration?.display,
        disabled
      }),
      makeRow({
        id: 'animation-strength',
        label: 'Strength',
        handlerId: 'setPortalAnimationStrength',
        min: raw.strength?.min,
        max: raw.strength?.max,
        step: raw.strength?.step,
        value: raw.strength?.value,
        defaultValue: raw.strength?.defaultValue,
        display: raw.strength?.display,
        disabled
      })
    ];
    registerSettingRows(rows);
    const sections = [registerSection({
      id: 'native-behavior',
      label: 'Native Behavior',
      visible: true,
      collapsed: !!isSectionCollapsed('native-behavior'),
      picker: null,
      settings: { id: 'native-behavior', visible: true, rows }
    })];
    return {
      ...control,
      id,
      type: 'portal-controls',
      variant: inferredVariant,
      title: 'Seamless Secret Door Options',
      selectionLabel,
      selectionHint: coerceString(raw.selectionHint, ''),
      headerActions,
      toggleGroups,
      selectGroups,
      color: { visible: false, rows: [] },
      sections,
      actionMap,
      toggleMap,
      selectMap,
      settingMap,
      toggleGroupMap,
      selectGroupMap,
      sectionMap
    };
  }

  const animations = makeOptions(raw.animations, (_, index) => index);
  const directions = makeOptions(raw.directions, (_, index) => (index === 0 ? -1 : 1));
  const initialStates = makeOptions(raw.initialStates, (_, index) => index);
  const doorSounds = makeOptions(raw.doorSounds, (_, index) => index);
  const selectedAnimation = coerceString(
    raw.selectedAnimation,
    animations.find((option) => option.selected)?.value || ''
  );
  const selectedDirection = String(coerceNumber(raw.direction, 1) === -1 ? -1 : 1);
  const sill = raw.sillSettings && typeof raw.sillSettings === 'object' ? raw.sillSettings : null;
  const texture = raw.textureSettings && typeof raw.textureSettings === 'object' ? raw.textureSettings : null;
  const frame = raw.frameSettings && typeof raw.frameSettings === 'object' ? raw.frameSettings : null;
  const colorTarget = raw.colorTarget && typeof raw.colorTarget === 'object' ? raw.colorTarget : null;
  const hsbc = raw.hsbc && typeof raw.hsbc === 'object' ? raw.hsbc : null;
  const textureFlip = normalizePortalTextureFlip(raw);
  const showInitialState = raw.showInitialState !== false;
  const showSound = raw.showSound !== false;
  const showDuration = raw.showDuration !== false;
  const showStrength = raw.showStrength !== false;

  const headerActions = buildPortalHeaderActions({ defaultsKind: 'window' });

  const toggleGroups = [
    registerToggleGroup({
      id: 'primary',
      visible: true,
      items: [
        makeToggle({
          id: 'animated',
          label: 'Animated Window',
          title: 'Use Foundry animated window instead of static texture',
          checked: !!raw.animated,
          disabled,
          handlerId: 'setWindowAnimated'
        }),
        makeToggle({
          id: 'flip-horizontal',
          label: 'Flip Horizontal',
          title: 'Mirror window glass texture along the portal width',
          checked: !!textureFlip.horizontal,
          disabled,
          handlerId: 'setWindowFlipHorizontal'
        }),
        makeToggle({
          id: 'flip-vertical',
          label: 'Flip Vertical',
          title: 'Mirror window glass texture across the wall thickness',
          checked: !!textureFlip.vertical,
          disabled,
          handlerId: 'setWindowFlipVertical'
        })
      ]
    }),
    registerToggleGroup({
      id: 'animated-secondary',
      visible: !!raw.animated,
      items: [
        makeToggle({
          id: 'double',
          label: 'Double',
          title: 'Animate both panes',
          checked: !!raw.double,
          disabled,
          handlerId: 'setWindowDouble'
        }),
        makeToggle({
          id: 'direction-flip',
          label: 'Flip Hinge',
          title: 'Swap window endpoints (hinge flip)',
          checked: !!raw.directionFlip,
          disabled,
          handlerId: 'setWindowDirectionFlip'
        })
      ]
    })
  ];

  const selectGroups = [
    registerSelectGroup({
      id: 'primary',
      visible: true,
      items: [
        showInitialState ? makeSelect({
          id: 'initial-state',
          label: raw.hasSelection ? 'Live State' : 'Initial State',
          handlerId: 'setPortalInitialState',
          value: raw.initialState,
          options: initialStates,
          disabled,
          valueMode: 'number'
        }) : null,
        showSound ? makeSelect({
          id: 'sound',
          label: 'Door Sound',
          handlerId: 'setPortalSound',
          value: raw.doorSound ?? '',
          options: doorSounds,
          disabled: disabled || !raw.animated
        }) : null,
        makeSelect({
          id: 'animation',
          label: 'Animation',
          handlerId: 'setWindowAnimation',
          value: selectedAnimation,
          options: animations,
          disabled: disabled || !raw.animated
        }),
        makeSelect({
          id: 'direction',
          label: 'Open Direction',
          handlerId: 'setWindowDirection',
          value: selectedDirection,
          options: directions,
          disabled: disabled || !raw.animated,
          valueMode: 'number'
        })
      ].filter(Boolean)
    })
  ];

  const nativeRows = [
    makeRow({
      id: 'portal-width',
      label: 'Width',
      handlerId: 'setPortalWidth',
      min: raw.width?.min,
      max: raw.width?.max,
      step: raw.width?.step,
      value: raw.width?.value,
      defaultValue: raw.width?.defaultValue,
      display: raw.width?.display,
      disabled
    }),
    showDuration ? makeRow({
      id: 'animation-duration',
      label: 'Duration',
      handlerId: 'setPortalAnimationDuration',
      min: raw.duration?.min,
      max: raw.duration?.max,
      step: raw.duration?.step,
      value: raw.duration?.value,
      defaultValue: raw.duration?.defaultValue,
      display: raw.duration?.display,
      disabled: disabled || !raw.animated
    }) : null,
    showStrength ? makeRow({
      id: 'animation-strength',
      label: 'Strength',
      handlerId: 'setPortalAnimationStrength',
      min: raw.strength?.min,
      max: raw.strength?.max,
      step: raw.strength?.step,
      value: raw.strength?.value,
      defaultValue: raw.strength?.defaultValue,
      display: raw.strength?.display,
      disabled: disabled || !raw.animated
    }) : null
  ].filter(Boolean);
  registerSettingRows(nativeRows);
  const sections = [
    registerSection({
      id: 'native-behavior',
      label: 'Native Behavior',
      visible: true,
      collapsed: !!isSectionCollapsed('native-behavior'),
      picker: null,
      settings: { id: 'native-behavior', visible: true, rows: nativeRows }
    }),
    registerSection({
      id: 'window-sill',
      label: 'Window Sill',
      visible: !raw.hideTexturePickers || !!sill,
      collapsed: !!isSectionCollapsed('window-sill'),
      summary: coerceString(raw.sillLabel, 'None'),
      picker: makePickerActions({
        id: 'window-sill',
        icon: 'fas fa-layer-group',
        label: coerceString(raw.sillLabel, 'Pick Sill'),
        pickHandlerId: 'pickWindowSillTexture',
        clearHandlerId: 'clearWindowSillTexture',
        hidden: !!raw.hideTexturePickers
      }),
      settings: {
        id: 'window-sill',
        visible: !!sill,
        rows: sill ? [
          makeRow({
            id: 'window-sill-scale',
            label: 'Scale',
            handlerId: 'setWindowSillScale',
            min: sill.scaleMin,
            max: sill.scaleMax,
            step: sill.scaleStep,
            value: sill.scale,
            defaultValue: sill.scaleDefault,
            display: sill.scaleDisplay,
            disabled
          }),
          makeRow({
            id: 'window-sill-offset-x',
            label: 'Offset X',
            handlerId: 'setWindowSillOffsetX',
            min: sill.offsetMin,
            max: sill.offsetMax,
            step: sill.offsetStep,
            value: sill.offsetX,
            defaultValue: sill.offsetXDefault,
            display: sill.offsetXDisplay,
            disabled
          }),
          makeRow({
            id: 'window-sill-offset-y',
            label: 'Offset Y',
            handlerId: 'setWindowSillOffsetY',
            min: sill.offsetMin,
            max: sill.offsetMax,
            step: sill.offsetStep,
            value: sill.offsetY,
            defaultValue: sill.offsetYDefault,
            display: sill.offsetYDisplay,
            disabled
          })
        ] : []
      }
    }),
    registerSection({
      id: 'window-texture',
      label: 'Window Texture',
      visible: !raw.hideTexturePickers || !!texture,
      collapsed: !!isSectionCollapsed('window-texture'),
      summary: coerceString(raw.textureLabel, 'None'),
      picker: makePickerActions({
        id: 'window-texture',
        icon: 'fas fa-border-all',
        label: coerceString(raw.textureLabel, 'Pick Window Texture'),
        pickHandlerId: 'pickWindowTexture',
        clearHandlerId: 'clearWindowTexture',
        hidden: !!raw.hideTexturePickers
      }),
      settings: {
        id: 'window-texture',
        visible: !!texture,
        rows: texture ? [
          makeRow({
            id: 'window-texture-scale',
            label: 'Width',
            handlerId: 'setWindowTextureScale',
            min: texture.scaleMin,
            max: texture.scaleMax,
            step: texture.scaleStep,
            value: texture.scale,
            defaultValue: texture.scaleDefault,
            display: texture.scaleDisplay,
            disabled
          }),
          makeRow({
            id: 'window-texture-offset-x',
            label: 'Offset X',
            handlerId: 'setWindowTextureOffsetX',
            min: texture.offsetMin,
            max: texture.offsetMax,
            step: texture.offsetStep,
            value: texture.offsetX,
            defaultValue: texture.offsetXDefault,
            display: texture.offsetXDisplay,
            disabled
          }),
          makeRow({
            id: 'window-texture-offset-y',
            label: 'Offset Y',
            handlerId: 'setWindowTextureOffsetY',
            min: texture.offsetMin,
            max: texture.offsetMax,
            step: texture.offsetStep,
            value: texture.offsetY,
            defaultValue: texture.offsetYDefault,
            display: texture.offsetYDisplay,
            disabled
          })
        ] : []
      }
    }),
    registerSection({
      id: 'window-frame',
      label: 'Window Frame',
      visible: !raw.hideTexturePickers || !!frame,
      collapsed: !!isSectionCollapsed('window-frame'),
      summary: coerceString(raw.frameLabel, 'None'),
      picker: makePickerActions({
        id: 'window-frame',
        icon: 'fas fa-columns',
        label: coerceString(raw.frameLabel, 'Pick Window Frame'),
        pickHandlerId: 'pickWindowFrameTexture',
        clearHandlerId: 'clearWindowFrameTexture',
        hidden: !!raw.hideTexturePickers
      }),
      settings: {
        id: 'window-frame',
        visible: !!frame,
        rows: frame ? [
          makeRow({
            id: 'window-frame-scale',
            label: 'Scale',
            handlerId: 'setWindowFrameScale',
            min: frame.scaleMin,
            max: frame.scaleMax,
            step: frame.scaleStep,
            value: frame.scale,
            defaultValue: frame.scaleDefault,
            display: frame.scaleDisplay,
            disabled
          }),
          makeRow({
            id: 'window-frame-offset-x',
            label: 'Offset X',
            handlerId: 'setWindowFrameOffsetX',
            min: frame.offsetMin,
            max: frame.offsetMax,
            step: frame.offsetStep,
            value: frame.offsetX,
            defaultValue: frame.offsetXDefault,
            display: frame.offsetXDisplay,
            disabled
          }),
          makeRow({
            id: 'window-frame-offset-y',
            label: 'Offset Y',
            handlerId: 'setWindowFrameOffsetY',
            min: frame.offsetMin,
            max: frame.offsetMax,
            step: frame.offsetStep,
            value: frame.offsetY,
            defaultValue: frame.offsetYDefault,
            display: frame.offsetYDisplay,
            disabled
          }),
          makeRow({
            id: 'window-frame-rotation',
            label: 'Rotation',
            handlerId: 'setWindowFrameRotation',
            min: frame.rotationMin,
            max: frame.rotationMax,
            step: frame.rotationStep,
            value: frame.rotation,
            defaultValue: frame.rotationDefault,
            display: frame.rotationDisplay,
            disabled: disabled || !!frame.rotationDisabled,
            hint: coerceString(frame.rotationHint, '')
          })
        ] : []
      }
    })
  ];

  const colorSection = registerSection({
    id: 'color',
    label: 'Color',
    visible: !!(colorTarget?.available && hsbc?.available),
    collapsed: !!isSectionCollapsed('color'),
    picker: null,
    settings: null
  });

  const color = {
    ...colorSection,
    label: 'Color',
    hint: coerceString(hsbc?.hint, ''),
    target: makeColorTarget({
      id: 'window-color-target',
      handlerId: 'setWindowHsbcTarget',
      groupName: `fa-nexus-portal-color-${id}`,
      visible: !!colorTarget?.available,
      items: Array.isArray(colorTarget?.options) ? colorTarget.options : []
    }),
    rows: hsbc?.available ? [
      makeRow({
        id: 'window-hsbc-hue',
        label: 'Hue',
        handlerId: 'setWindowHsbcHue',
        min: hsbc?.hue?.min,
        max: hsbc?.hue?.max,
        step: hsbc?.hue?.step,
        value: hsbc?.hue?.value,
        defaultValue: hsbc?.hue?.defaultValue,
        display: hsbc?.hue?.display,
        disabled: disabled || !!hsbc?.hue?.disabled,
        hint: coerceString(hsbc?.hue?.tooltip || hsbc?.hint, '')
      }),
      makeRow({
        id: 'window-hsbc-saturation',
        label: 'Saturation',
        handlerId: 'setWindowHsbcSaturation',
        min: hsbc?.saturation?.min,
        max: hsbc?.saturation?.max,
        step: hsbc?.saturation?.step,
        value: hsbc?.saturation?.value,
        defaultValue: hsbc?.saturation?.defaultValue,
        display: hsbc?.saturation?.display,
        disabled: disabled || !!hsbc?.saturation?.disabled,
        hint: coerceString(hsbc?.saturation?.tooltip || hsbc?.hint, '')
      }),
      makeRow({
        id: 'window-hsbc-brightness',
        label: 'Brightness',
        handlerId: 'setWindowHsbcBrightness',
        min: hsbc?.brightness?.min,
        max: hsbc?.brightness?.max,
        step: hsbc?.brightness?.step,
        value: hsbc?.brightness?.value,
        defaultValue: hsbc?.brightness?.defaultValue,
        display: hsbc?.brightness?.display,
        disabled: disabled || !!hsbc?.brightness?.disabled,
        hint: coerceString(hsbc?.brightness?.tooltip || hsbc?.hint, '')
      }),
      makeRow({
        id: 'window-hsbc-contrast',
        label: 'Contrast',
        handlerId: 'setWindowHsbcContrast',
        min: hsbc?.contrast?.min,
        max: hsbc?.contrast?.max,
        step: hsbc?.contrast?.step,
        value: hsbc?.contrast?.value,
        defaultValue: hsbc?.contrast?.defaultValue,
        display: hsbc?.contrast?.display,
        disabled: disabled || !!hsbc?.contrast?.disabled,
        hint: coerceString(hsbc?.contrast?.tooltip || hsbc?.hint, '')
      })
    ] : []
  };
  registerSettingRows(color.rows);

  return {
    ...control,
    id,
    type: 'portal-controls',
    variant: inferredVariant,
    title: 'Window Options',
    selectionLabel,
    selectionHint: coerceString(raw.selectionHint, ''),
    headerActions,
    toggleGroups,
    selectGroups,
    color,
    sections,
    actionMap,
    toggleMap,
    selectMap,
    settingMap,
    toggleGroupMap,
    selectGroupMap,
    sectionMap
  };
}
