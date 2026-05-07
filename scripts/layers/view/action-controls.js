export function buildLayerManagerFlattenState({
  selection = [],
  flattenManagerClass = null,
  flattenManager = null,
  canvasReady = !!canvas?.ready
} = {}) {
  const rawCount = Array.isArray(selection) ? selection.length : 0;
  const flattenAnalysis = flattenManagerClass?.getSelectionAnalysis?.(selection) || { targets: [], outOfScope: [], canFlatten: false };
  const flattenableSelection = flattenAnalysis.targets;
  const count = Array.isArray(flattenableSelection) ? flattenableSelection.length : 0;
  const mixedLevelSelection = Array.isArray(flattenAnalysis.outOfScope) && flattenAnalysis.outOfScope.length > 0;
  const singleDoc = rawCount === 1 ? selection[0] : null;
  const singleFlattened = !!singleDoc && !!flattenManagerClass?.isFlattenedTile?.(singleDoc);
  const singleMerged = count === 1 && !!flattenManagerClass?.isMergedTile?.(flattenableSelection[0]);
  const allowExport = rawCount === 0;
  const allowFlatten = !singleFlattened && !!flattenAnalysis.canFlatten;
  const unsupportedSelection = rawCount > 0 && !singleFlattened && !allowFlatten && !mixedLevelSelection;
  const visible = !!canvasReady && (allowExport || allowFlatten || singleFlattened || mixedLevelSelection || unsupportedSelection);
  const busy = !!flattenManager?.isBusy?.();
  const action = singleFlattened ? 'deconstruct' : (allowExport ? 'export' : 'flatten');
  const label = singleFlattened
    ? 'Deconstruct flattened tile'
    : mixedLevelSelection
      ? 'Flatten unavailable across current level boundary'
      : unsupportedSelection
        ? `Flatten unavailable for selected layer${rawCount === 1 ? '' : 's'}`
      : (action === 'export'
        ? 'Flatten / Export Level'
        : (count > 1
          ? `Flatten ${count} selected tile${count === 1 ? '' : 's'}`
          : (singleMerged ? 'Flatten merged tile' : 'Flatten selected tile')));
  const ariaLabel = singleFlattened
    ? 'Deconstruct flattened tile in FA Nexus'
    : mixedLevelSelection
      ? 'Flatten unavailable because the selection crosses the current viewed level boundary'
      : unsupportedSelection
        ? `Flatten unavailable for selected layer${rawCount === 1 ? '' : 's'} in FA Nexus`
      : (action === 'export'
        ? 'Flatten or export the current level in FA Nexus'
        : (count > 1
          ? `Flatten ${count} selected tile${count === 1 ? '' : 's'} in FA Nexus`
          : (singleMerged ? 'Flatten merged tile in FA Nexus' : 'Flatten selected tile in FA Nexus')));
  const iconClass = singleFlattened
    ? 'fa-object-ungroup'
    : (action === 'export' ? 'fa-file-export' : 'fa-compress-arrows-alt');

  return {
    visible,
    disabled: !visible || busy || !canvasReady || mixedLevelSelection || unsupportedSelection,
    label,
    ariaLabel,
    count,
    action,
    iconClass
  };
}

export function applyLayerManagerFlattenFooterState(root, state) {
  const footer = root?.querySelector?.('.fa-nexus-layer-manager__footer');
  const button = root?.querySelector?.('button[data-action="flatten"]');
  if (!footer || !button) return;
  if (state?.visible) footer.removeAttribute('hidden');
  else footer.setAttribute('hidden', 'hidden');
  button.disabled = !!state?.disabled;
  button.classList.toggle('disabled', !!state?.disabled);
  const label = state?.label || 'Flatten tiles';
  const labelEl = button.querySelector('.fa-nexus-layer-manager__flatten-label');
  if (labelEl) labelEl.textContent = label;
  const iconEl = button.querySelector('.fa-nexus-layer-manager__flatten-icon');
  if (iconEl && state?.iconClass) {
    iconEl.className = `fas ${state.iconClass} fa-nexus-layer-manager__flatten-icon`;
  }
  button.dataset.mode = state?.action || 'flatten';
  button.setAttribute('aria-label', state?.ariaLabel || label);
  button.title = state?.ariaLabel || label;
  if (state?.disabled) button.setAttribute('aria-disabled', 'true');
  else button.removeAttribute('aria-disabled');
}

export function buildLayerManagerSelectionActionState(selectedDocs = [], { user = game?.user } = {}) {
  const lockTargets = Array.isArray(selectedDocs)
    ? selectedDocs.filter((doc) => doc?.canUserModify?.(user, 'update'))
    : [];
  const deleteTargets = Array.isArray(selectedDocs)
    ? selectedDocs.filter((doc) => doc?.canUserModify?.(user, 'delete'))
    : [];
  const allLocked = lockTargets.length ? lockTargets.every((doc) => !!doc?.locked) : false;
  const lockLabel = allLocked ? 'Unlock Selected' : 'Lock Selected';
  return {
    lockLabel,
    lockTitle: `${lockLabel} layer${lockTargets.length === 1 ? '' : 's'}`,
    lockDisabled: lockTargets.length === 0,
    deleteDisabled: deleteTargets.length === 0
  };
}

export function applyLayerManagerSelectionActionState(root, state) {
  const lockButton = root?.querySelector?.('button[data-action="toggle-selection-lock"]');
  const deleteButton = root?.querySelector?.('button[data-action="delete-selection"]');
  if (lockButton) {
    lockButton.disabled = !!state?.lockDisabled;
    lockButton.classList.toggle('disabled', !!state?.lockDisabled);
    lockButton.setAttribute('aria-disabled', state?.lockDisabled ? 'true' : 'false');
    lockButton.title = state?.lockTitle || '';
    lockButton.setAttribute('aria-label', state?.lockTitle || '');
  }
  if (deleteButton) {
    deleteButton.disabled = !!state?.deleteDisabled;
    deleteButton.classList.toggle('disabled', !!state?.deleteDisabled);
    deleteButton.setAttribute('aria-disabled', state?.deleteDisabled ? 'true' : 'false');
  }
}
