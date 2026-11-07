import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { openSceneGroupsWindow } from '../composition/scene-groups-window.js';

export class LayerManagerListInteractionController {
  constructor(tab) {
    if (!tab) throw new Error('Layer manager list interaction controller requires a tab.');
    this.tab = tab;
  }

  bindRender(root) {
    if (!root) return;
    const tab = this.tab;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    const searchInput = root.querySelector('input[data-action="search-layers"]');
    const resetFiltersButton = root.querySelector('button[data-action="reset-filters"]');
    const toggleAllGroupsButton = root.querySelector('button[data-action="toggle-all-groups"]');
    const selectionLockButton = root.querySelector('button[data-action="toggle-selection-lock"]');
    const selectionDeleteButton = root.querySelector('button[data-action="delete-selection"]');
    const minInput = root.querySelector('input[data-range="min"]');
    const maxInput = root.querySelector('input[data-range="max"]');
    const skipLockedInput = root.querySelector('input[data-action="skip-locked"]');
    const skipHiddenInput = root.querySelector('input[data-action="skip-hidden"]');
    const skipFilteredInput = root.querySelector('input[data-action="skip-filtered"]');
    const flattenButton = root.querySelector('button[data-action="flatten"]');
    const renameInput = root.querySelector('.fa-nexus-layer-manager__rename-input');
    const groupNameInput = root.querySelector('.fa-nexus-layer-manager__separator-group-name-input');
    const folderNameInput = root.querySelector('.fa-nexus-layer-manager__separator-folder-name-input');
    const groupElevationInput = root.querySelector('.fa-nexus-layer-manager__separator-group-elevation-input');
    const selectionOptionsToggle = root.querySelector('button[data-action="toggle-selection-options"]');
    const helpButton = root.querySelector('button[data-action="open-help"]');
    const sceneGroupsButton = root.querySelector('button[data-action="open-scene-groups"]');
    const sceneGroupMemberSelectionButtons = root.querySelectorAll(
      'button[data-scene-member-selection-mode-value]'
    );

    if (sceneGroupsButton) {
      sceneGroupsButton.addEventListener('click', (event) => {
        this._consume(event);
        void openSceneGroupsWindow().catch((error) => {
          Logger.error('LayerManager.sceneGroups.openFailed', {
            sceneId: canvas?.scene?.id || null,
            error: String(error?.message || error)
          });
          ui?.notifications?.error?.(`Could not open Scene Groups: ${error?.message || error}`);
        });
      });
    }

    for (const button of sceneGroupMemberSelectionButtons) {
      button.addEventListener('click', (event) => {
        this._consume(event);
        tab._setSceneGroupMemberSelectionMode(button.dataset.sceneMemberSelectionModeValue);
      });
    }

    if (selectionOptionsToggle) {
      selectionOptionsToggle.addEventListener('click', (event) => {
        this._consume(event);
        tab._toggleSelectionOptions();
      });
    }

    if (helpButton) {
      helpButton.addEventListener('click', (event) => {
        this._consume(event);
        tab._openLayerManagerHelp();
      });
    }

    if (list) {
      list.addEventListener('click', (event) => tab._onListClick(event));
      list.addEventListener('dblclick', (event) => tab._onListDoubleClick(event));
      list.addEventListener('contextmenu', (event) => tab._onListContextMenu(event));
      list.addEventListener('mouseover', (event) => tab._onListHover(event));
      list.addEventListener('mouseleave', () => tab._clearHover());
      list.addEventListener('wheel', (event) => tab._onListWheel(event), { passive: false });
      list.addEventListener('dragstart', (event) => tab._onListDragStart(event));
      list.addEventListener('dragover', (event) => tab._onListDragOver(event));
      list.addEventListener('dragleave', (event) => tab._onListDragLeave(event));
      list.addEventListener('drop', (event) => tab._onListDrop(event));
      list.addEventListener('dragend', (event) => tab._onListDragEnd(event));
    }

    if (searchInput) {
      searchInput.addEventListener('input', (event) => tab._onSearchInput(event));
    }

    if (resetFiltersButton) {
      resetFiltersButton.addEventListener('click', (event) => {
        this._consume(event);
        tab._resetListFilters();
      });
    }

    if (toggleAllGroupsButton) {
      toggleAllGroupsButton.addEventListener('click', (event) => {
        this._consume(event);
        tab._toggleAllElevationGroups(toggleAllGroupsButton);
      });
    }

    for (const chipButton of root.querySelectorAll('button[data-action="toggle-filter-chip"]')) {
      chipButton.addEventListener('click', (event) => {
        this._consume(event);
        tab._toggleFilterChip(chipButton);
      });
    }

    if (selectionLockButton) {
      selectionLockButton.addEventListener('click', (event) => {
        this._consume(event);
        tab._toggleSelectionLock();
      });
    }

    if (selectionDeleteButton) {
      selectionDeleteButton.addEventListener('click', (event) => {
        this._consume(event);
        tab._deleteSelection();
      });
    }

    tab._bindSelectionFilterControls({ minInput, maxInput, skipLockedInput, skipHiddenInput, skipFilteredInput });
    this._bindFlattenButton(flattenButton);
    tab._bindInlineEditInputs({ renameInput, folderNameInput, groupNameInput, groupElevationInput });
    tab._restoreSearchFocus(searchInput);
  }

  handleListClick(event) {
    const targetNode = event?.target;
    if (targetNode?.closest?.('.fa-nexus-layer-manager__rename-input')) return;
    if (targetNode?.closest?.('.fa-nexus-layer-manager__separator-group-name-input')) return;
    if (targetNode?.closest?.('.fa-nexus-layer-manager__separator-folder-name-input')) return;
    if (targetNode?.closest?.('.fa-nexus-layer-manager__separator-group-elevation-input')) return;

    const tab = this.tab;
    const sceneMarkerVisibilityToggle = targetNode?.closest?.('[data-action="toggle-scene-marker-visibility"]');
    if (sceneMarkerVisibilityToggle) {
      this._consume(event);
      tab._toggleSceneMarkerVisibility(sceneMarkerVisibilityToggle);
      return;
    }

    const sceneMarker = targetNode?.closest?.('[data-scene-marker]');
    if (sceneMarker) {
      this._consume(event);
      return;
    }

    const levelBoundary = targetNode?.closest?.('.fa-nexus-layer-manager__separator--level-boundary');
    if (levelBoundary) {
      this._consume(event);
      tab._selectCurrentLevelBand(levelBoundary);
      return;
    }

    const sectionVisibilityToggle = targetNode?.closest?.('[data-action="toggle-section-visibility"]');
    if (sectionVisibilityToggle) {
      this._consume(event);
      tab._toggleSectionVisibility(sectionVisibilityToggle);
      return;
    }

    const sectionCollapseToggle = targetNode?.closest?.('[data-action="toggle-section-collapse"]');
    if (sectionCollapseToggle) {
      this._consume(event);
      tab._toggleSectionCollapse(sectionCollapseToggle);
      return;
    }

    const elevationToggle = targetNode?.closest?.('[data-action="toggle-elevation-visibility"]');
    if (elevationToggle) {
      this._consume(event);
      tab._toggleElevationVisibility(elevationToggle);
      return;
    }

    const collapseToggle = targetNode?.closest?.('[data-action="toggle-elevation-collapse"]');
    if (collapseToggle) {
      this._consume(event);
      tab._toggleElevationCollapse(collapseToggle);
      return;
    }

    const visibilityToggle = targetNode?.closest?.('[data-action="toggle-visibility"]');
    if (visibilityToggle) {
      this._consume(event);
      tab._toggleVisibility(visibilityToggle);
      return;
    }

    const lockToggle = targetNode?.closest?.('[data-action="toggle-lock"]');
    if (lockToggle) {
      this._consume(event);
      tab._toggleLock(lockToggle);
      return;
    }

    const previewRow = targetNode?.closest?.('[data-preview-id]');
    if (previewRow) {
      this._consume(event);
      tab._handlePreviewRowClick(previewRow);
      return;
    }

    const separator = targetNode?.closest?.('.fa-nexus-layer-manager__separator:not(.fa-nexus-layer-manager__separator--level-boundary)');
    if (separator) {
      this._consume(event);
      if (separator.dataset?.sectionId) {
        tab._selectSection(separator, event);
        return;
      }
      const renameTarget = targetNode?.closest?.('.fa-nexus-layer-manager__separator-name, .fa-nexus-layer-manager__separator-elevation');
      if (renameTarget) {
        if ((Number(event?.detail) || 0) > 1) return;
        tab._selectElevation(separator, {
          ctrlKey: !!event?.ctrlKey,
          metaKey: !!event?.metaKey,
          shiftKey: !!event?.shiftKey
        });
        return;
      }
      tab._selectElevation(separator, event);
      return;
    }

    const target = targetNode?.closest?.('[data-tile-id]');
    if (!target) return;
    this._consume(event);
    tab._handleListTileClick(event, target);
  }

  _bindFlattenButton(flattenButton) {
    if (!flattenButton) return;
    if (flattenButton._faNexusFlattenHandler) {
      flattenButton.removeEventListener('click', flattenButton._faNexusFlattenHandler);
    }
    const handler = (event) => this.tab._onFlattenFooterClick(event);
    flattenButton._faNexusFlattenHandler = handler;
    flattenButton.addEventListener('click', handler);
  }

  _consume(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
  }
}
