export const SHORTCUT_ACTION = Object.freeze({
  HELP: 'help',
  COMMIT: 'commit',
  CANCEL: 'cancel',
  UNDO: 'undo',
  REDO: 'redo',
  TOGGLE_GRID_SNAP: 'toggle-grid-snap',
  ADJUST_GRID_SNAP: 'adjust-grid-snap',
  TOGGLE_POLARITY: 'toggle-polarity',
  TEMPORARY_INVERT_POLARITY: 'temporary-invert-polarity'
});

export const SHORTCUT_BINDING = Object.freeze({
  [SHORTCUT_ACTION.HELP]: 'F1',
  [SHORTCUT_ACTION.COMMIT]: 'Ctrl/Cmd+S',
  [SHORTCUT_ACTION.CANCEL]: 'Escape',
  [SHORTCUT_ACTION.UNDO]: 'Ctrl/Cmd+Z',
  [SHORTCUT_ACTION.REDO]: 'Ctrl/Cmd+Y / Ctrl/Cmd+Shift+Z',
  [SHORTCUT_ACTION.TOGGLE_GRID_SNAP]: 'S',
  [SHORTCUT_ACTION.ADJUST_GRID_SNAP]: 'S + Wheel',
  [SHORTCUT_ACTION.TOGGLE_POLARITY]: 'E',
  [SHORTCUT_ACTION.TEMPORARY_INVERT_POLARITY]: 'Hold Alt'
});

export function createShortcut(action, {
  binding = SHORTCUT_BINDING[action] || '',
  label = '',
  description = '',
  hidden = false
} = {}) {
  return {
    action: typeof action === 'string' ? action : '',
    binding: typeof binding === 'string' ? binding : '',
    label: typeof label === 'string' ? label : '',
    description: typeof description === 'string' ? description : '',
    hidden: !!hidden
  };
}

export function createStandardEditorShortcuts({ includePolarity = false } = {}) {
  const shortcuts = [
    createShortcut(SHORTCUT_ACTION.HELP, {
      label: 'Help',
      description: 'Open contextual tool help.'
    }),
    createShortcut(SHORTCUT_ACTION.COMMIT, {
      label: 'Commit',
      description: 'Commit the current session.'
    }),
    createShortcut(SHORTCUT_ACTION.CANCEL, {
      label: 'Cancel',
      description: 'Cancel the current session.'
    }),
    createShortcut(SHORTCUT_ACTION.UNDO, {
      label: 'Undo',
      description: 'Undo the last change.'
    }),
    createShortcut(SHORTCUT_ACTION.REDO, {
      label: 'Redo',
      description: 'Redo the last undone change.'
    }),
    createShortcut(SHORTCUT_ACTION.TOGGLE_GRID_SNAP, {
      label: 'Grid Snap',
      description: 'Tap to toggle grid snapping.'
    }),
    createShortcut(SHORTCUT_ACTION.ADJUST_GRID_SNAP, {
      label: '"Snap To" Grid Density',
      description: 'Hold while scrolling to adjust subgrid density without toggling snap.'
    })
  ];
  if (includePolarity) {
    shortcuts.push(
      createShortcut(SHORTCUT_ACTION.TOGGLE_POLARITY, {
        label: 'Toggle Eraser',
        description: 'Toggle the erase mode.'
      }),
      createShortcut(SHORTCUT_ACTION.TEMPORARY_INVERT_POLARITY, {
        label: 'Temp Eraser',
        description: 'Temporarily activate the erase mode while held.'
      })
    );
  }
  return shortcuts;
}

export function normalizeShortcutList(shortcuts) {
  if (!Array.isArray(shortcuts)) return [];
  return shortcuts
    .map((shortcut) => {
      if (!shortcut || typeof shortcut !== 'object') return null;
      return createShortcut(shortcut.action, shortcut);
    })
    .filter((shortcut) => shortcut && shortcut.action);
}

export function mergeShortcutLists(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    for (const shortcut of normalizeShortcutList(list)) {
      if (!shortcut || shortcut.hidden) continue;
      const key = [
        String(shortcut.action || '').trim().toLowerCase(),
        String(shortcut.binding || '').trim().toLowerCase(),
        String(shortcut.label || '').trim().toLowerCase()
      ].join('::');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(shortcut);
    }
  }
  return merged;
}

export function isCommitShortcut(event) {
  return !!event
    && !event.altKey
    && (event.ctrlKey || event.metaKey)
    && String(event.key || '').toLowerCase() === 's';
}

export function isHelpShortcut(event) {
  return !!event
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && String(event.key || '') === 'F1';
}

export function isGridSnapShortcut(event) {
  return !!event
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && String(event.key || '').toLowerCase() === 's';
}

export function isPolarityShortcut(event) {
  return !!event
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && String(event.key || '').toLowerCase() === 'e';
}

export function invertPolarity(value) {
  if (value === 'subtract') return 'add';
  if (value === 'erase') return 'paint';
  if (value === 'remove') return 'add';
  if (value === 'add') return 'subtract';
  if (value === 'paint') return 'erase';
  return value;
}

export function resolveEffectivePolarity(basePolarity, inverted = false) {
  const normalized = typeof basePolarity === 'string' ? basePolarity : null;
  if (!normalized) return null;
  return inverted ? invertPolarity(normalized) : normalized;
}
