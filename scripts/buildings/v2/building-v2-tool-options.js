import {
  addDeclarativeActionRowControl, addDeclarativeRangeControl,
  addDeclarativeSelectControl, addDeclarativeToggleControl
} from '../../core/tool-options/tool-options-control-builders.js';

export function buildingV2WindowBehaviorControls(controls, window) {
  if (!window?.available) return [];
  const toggle = (id, label, value, handlerId) => addDeclarativeToggleControl(controls, {
    id, label, value, disabled: window.disabled, handlerId
  });
  const ids = [toggle('window-animated', 'Animated Window', window.animated, 'setWindowAnimated')];
  if (window.animated) ids.push(
    addDeclarativeSelectControl(controls, { id: 'window-animation', label: 'Animation',
      state: { value: window.selectedAnimation, options: window.animations, disabled: window.disabled }, handlerId: 'setWindowAnimation' }),
    addDeclarativeSelectControl(controls, { id: 'window-direction', label: 'Open Direction',
      state: { value: window.direction, options: window.directions, disabled: window.disabled }, handlerId: 'setWindowDirection' }),
    toggle('window-hinge-flip', 'Flip Hinge', window.directionFlip, 'setWindowDirectionFlip'),
    toggle('window-double', 'Double Window', window.double, 'setWindowDouble')
  );
  ids.push(
    toggle('window-flip-horizontal', 'Flip Horizontal', window.textureFlip.horizontal, 'setWindowFlipHorizontal'),
    toggle('window-flip-vertical', 'Flip Vertical', window.textureFlip.vertical, 'setWindowFlipVertical')
  );
  return ids.filter(Boolean);
}

export function appendBuildingV2InteriorPathControls(controls, sections, state) {
  const path = state?.interiorPathControls;
  if (!path?.available) return;
  const ids = [];
  if (path.drawing) {
    controls['interior-path-family'] = { id: 'interior-path-family', type: 'segmented', handlerId: 'setInteriorPathFamily',
      options: [{ id: 'polyline', label: 'Poly-line' }, { id: 'spline', label: 'Smooth Spline' }]
        .map(option => ({ ...option, enabled: path.family === option.id, disabled: path.familyDisabled })) };
    controls['interior-path-purpose'] = { id: 'interior-path-purpose', type: 'segmented', variant: 'construction-mode',
      handlerId: 'setNextInteriorPathPurpose', options: [{ id: 'wall', label: 'Inner Wall' }, { id: 'fill-divider', label: 'Fill Divider' }]
        .map(option => ({ ...option, enabled: path.purpose === option.id, disabled: path.familyDisabled })) };
    sections.push({ id: 'interior-path-drawing', label: 'Path Type', region: 'header', collapsible: false,
      controls: ['interior-path-family', 'interior-path-purpose'] });
  }
  if (path.family === 'spline') ids.push(addDeclarativeRangeControl(controls, { id: 'interior-path-tension', label: 'Tension', compact: true,
    state: { value: path.tension, min: 0, max: 1, step: 0.05, defaultValue: 0.5, disabled: path.tensionDisabled }, handlerId: 'setInteriorPathTension' }));
  if (ids.length) sections.unshift({ id: 'interior-path-controls', label: 'Smooth Spline', collapsible: false, controls: ids.filter(Boolean) });
}

/** V2 uses the shared declarative sections so collapse and selection behave like Wall controls. */
export function appendBuildingV2PortalControls(controls, sections, state) {
  if (state.portalConversionControls?.available) sections.unshift({ id: 'portal-conversion', label: 'Convert Portal', collapsible: false,
    controls: [addDeclarativeSelectControl(controls, { id: 'portal-conversion-kind', label: 'Convert to',
      state: state.portalConversionControls, handlerId: 'setPortalConversionKind' })].filter(Boolean) });
  const opening = state.openingFrameControls;
  if (opening?.available) {
    const frame = opening.frame;
    if (!frame) return;
    const fields = [
      ['scale', 'Scale', 0.1, 3, 0.01, 1], ['offsetX', 'Offset X', -1, 1, 0.01, 0], ['offsetY', 'Offset Y', -1, 1, 0.01, 0],
      ...(frame.mode === 'pillar' ? [['rotation', 'Rotation', -180, 180, 1, 0]] : [])
    ];
    sections.push({ id: 'opening-frame-transforms', label: opening.label || 'Opening Frame', controls: fields.map(([field, label, min, max, step, defaultValue]) =>
      addDeclarativeRangeControl(controls, { id: `opening-frame-${field}`, label, compact: true,
        state: { value: frame[field], min, max, step, defaultValue, disabled: opening.disabled },
        handlerId: `setDoorFrame${field[0].toUpperCase()}${field.slice(1)}` })).filter(Boolean) });
    sections.push({ id: 'opening-frame-color', label: 'Frame Color', controls: ['hue', 'saturation', 'brightness', 'contrast'].map(field =>
      addDeclarativeRangeControl(controls, { id: `opening-frame-${field}`, label: field[0].toUpperCase() + field.slice(1), compact: true,
        state: { value: field === 'hue' ? frame.hsbc?.hue ?? 0 : ((frame.hsbc?.[field] ?? 1) - 1) * 100,
          min: field === 'hue' ? -180 : -100, max: field === 'hue' ? 180 : 100, step: 1, defaultValue: 0, disabled: opening.disabled },
        handlerId: `setOpeningFrame${field[0].toUpperCase()}${field.slice(1)}` })).filter(Boolean) });
    return;
  }
  const kind = state.doorControls?.available ? 'Door' : 'Window';
  const portal = kind === 'Door' ? state.doorControls : state.windowControls;
  if (!portal?.available) return;
  const prefix = kind.toLowerCase();
  const range = config => addDeclarativeRangeControl(controls, { compact: true, ...config });
  sections.unshift({ id: 'portal-defaults', label: portal.hasSelection ? `Selected ${kind}` : `New ${kind} Defaults`,
    collapsible: false, controls: [addDeclarativeActionRowControl(controls, { id: 'portal-defaults-actions', handlerId: 'handlePortalDefaultsAction', actions: [
      { id: 'use-selected', label: 'Use Selected as Defaults', disabled: portal.disabled || !portal.hasSelection },
      { id: 'apply-defaults', label: 'Apply Defaults to Selected', disabled: portal.disabled || !portal.hasSelection }
    ] }, { includeHandlerId: true })] });

  controls['portal-transform-target'] = { id: 'portal-transform-target', type: 'segmented',
    handlerId: `set${kind}TransformTarget`, options: portal.transformTarget.options };
  const transformIds = ['portal-transform-target'];
  const target = portal.transformTarget.value;
  if (kind === 'Door' && target === 'door') {
    const appearance = state.doorAppearance;
    transformIds.push(addDeclarativeToggleControl(controls, { id: 'door-artwork-lock-aspect-ratio', label: 'Lock Aspect Ratio',
      value: appearance.lockAspectRatio, disabled: portal.disabled, handlerId: 'setDoorAspectRatioLock' }));
    transformIds.push(range({ id: 'door-artwork-widthScale', label: 'Artwork Width',
      state: appearance.widthScale, handlerId: 'setDoorArtworkWidth' }));
  } else {
    const element = target === 'texture' ? portal.textureSettings : target === 'sill' ? portal.sillSettings : portal.frameSettings;
    const elementName = target === 'texture' ? 'Texture' : target === 'sill' ? 'Sill' : 'Frame';
    const animatedSurface = kind === 'Window' && target === 'texture' && portal.animated;
    if (animatedSurface) transformIds.push(addDeclarativeToggleControl(controls, { id: 'window-lock-aspect-ratio', label: 'Lock Aspect Ratio',
      value: portal.lockAspectRatio, disabled: portal.disabled, handlerId: 'setWindowAspectRatioLock' }));
    if (element) {
      for (const field of ['scale', ...(!animatedSurface ? ['offsetX', 'offsetY'] : []),
        ...(element.rotation !== undefined && !element.rotationDisabled ? ['rotation'] : [])]) {
        const rail = field.startsWith('offset') ? 'offset' : field;
        const label = { scale: animatedSurface ? 'Artwork Width' : 'Scale', offsetX: 'Offset X', offsetY: 'Offset Y', rotation: 'Rotation' }[field];
        transformIds.push(range({ id: `${prefix}-${target}-${field.replace(/[XY]/g, axis => `-${axis.toLowerCase()}`)}`, label,
          state: { value: element[field], min: element[`${rail}Min`], max: element[`${rail}Max`], step: element[`${rail}Step`],
            defaultValue: element[`${field}Default`], display: element[`${field}Display`], disabled: portal.disabled },
          handlerId: `set${kind}${elementName}${field[0].toUpperCase()}${field.slice(1)}` }));
      }
    }
  }
  sections.push({ id: 'portal-transforms', label: `${kind} Transforms`, controls: transformIds.filter(Boolean) });

  if (portal.colorTarget?.available) {
    controls['portal-color-target'] = { id: 'portal-color-target', type: 'segmented',
      handlerId: `set${kind}HsbcTarget`, options: portal.colorTarget.options };
    sections.push({ id: 'portal-color', label: 'Color', controls: ['portal-color-target',
      ...['hue', 'saturation', 'brightness', 'contrast'].map(field => range({
        id: `${prefix}-hsbc-${field}`, label: field[0].toUpperCase() + field.slice(1), state: portal.hsbc[field],
        handlerId: `set${kind}Hsbc${field[0].toUpperCase()}${field.slice(1)}` }))].filter(Boolean) });
  }
}
