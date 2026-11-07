import { notifySceneGroupFailure, sceneGroupFailureMessage, isSceneGroupOperationBlocked } from './scene-group-notifications.js';
import { copyGroup, copyGroupToClipboard, saveGroupPrefab, openPrefabLibrary, cancelPrefabPlacement } from './prefab-ui.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { isPrefabsEnabled } from '../core/feature-areas.js';
import {
  readSceneGroupDropData,
  writeSceneDocumentDragData,
  writeSceneGroupDragData
} from './scene-group-drag-data.js';
import { resolveSceneGroupDragSelection } from './scene-group-drag-selection.js';
import { sceneGroupViewState } from './scene-group-view-state.js';
import { createSceneGroupAppearanceControl, chooseSceneGroupIcon, sceneGroupIconClass, resolveSceneGroupIconColor, validateSceneGroupIconColor } from './scene-group-icons.js';
import { selectSceneMembers, focusSceneMember, buildSceneMemberContextItems, revealHomogeneousSceneMembers } from './scene-group-member-actions.js';
import { selectSceneGroupArea, reviewSceneGroupCapture } from './scene-group-capture-ui.js';
import { organizeContextMenu } from '../core/ui/context-menu-sections.js';
import { planSceneGroupDropOwnership } from './scene-group-layer-tree.js';
import {
  SCENE_GROUP_INTERACTION_HOOK,
  sceneGroupInteractionState
} from './scene-group-interaction-state.js';
import { hasLayerHiddenChange } from '../canvas/layer-hidden-state.js';
import { SceneGroupWorkflow } from './scene-group-workflow.js';
import { editSceneGroupBounds } from './scene-group-bounds-editor.js';
import { inspectCompositionRegistryLocks, releaseInterruptedCompositionRegistryLock } from './composition-registry-transaction.js';
import { confirmDeleteSceneGroups } from './scene-group-delete-command.js';
import {
  createGenericSceneGroupNameIntent,
  createSceneGroupNameIntentForDocumentTypes
} from './scene-group-naming.js';
import {
  planSceneGroupContextSelection,
  planSceneGroupMemberPresentation,
  planSceneGroupWindowDrop,
  planSceneGroupWindowRows,
  planSceneGroupWindowSelection,
  resolveCreateSubgroupEligibility
} from './scene-group-window-selection.js';
import { PathGeneratedWallOwnership } from '../paths/path-generated-wall-ownership.js';
import { createFoundryBuildingFillOwnershipService } from '../buildings/ownership/building-fill-ownership.js';
import { createFoundryBuildingV2FillOwnershipService } from '../buildings/v2/building-v2-fill-ownership-runtime.js';
import {
  isSceneGroupNativeDeletionPending,
  SCENE_GROUP_NATIVE_DELETION_STATE_HOOK
} from './scene-group-native-deletion-state.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const OVERLAY_DRAG_MARKER = Symbol.for('fa-nexus.scene-group-overlay-drag-active');

const MEMBER_META = Object.freeze({
  Tile: Object.freeze({ label: 'Tile', icon: 'fa-solid fa-image' }),
  Wall: Object.freeze({ label: 'Wall', icon: 'fa-solid fa-grip-lines-vertical' }),
  AmbientLight: Object.freeze({ label: 'Light', icon: 'fa-solid fa-lightbulb' }),
  AmbientSound: Object.freeze({ label: 'Sound', icon: 'fa-solid fa-volume-high' }),
  Region: Object.freeze({ label: 'Region', icon: 'fa-solid fa-draw-polygon' })
});

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function reportWindowFailure(scope, error) {
  Logger[isSceneGroupOperationBlocked(error) ? 'debug' : 'error'](scope, {
    sceneId: canvas?.scene?.id || null,
    stage: error?.stage || null,
    code: error?.code || null,
    identities: error?.identities || [],
    rollback: error?.rollback || null,
    error: String(error?.message || error)
  });
  notifySceneGroupFailure(error, 'Scene Groups action failed');
}

export class SceneGroupsWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-scene-groups-window',
    classes: ['fa-nexus-scene-groups-window'],
    tag: 'section',
    window: {
      frame: true,
      positioned: true,
      resizable: true,
      minimizable: true,
      icon: 'fa-solid fa-object-group',
      title: 'FA Nexus — Scene Groups'
    },
    position: { width: 440, height: 640 }
  };

  static PARTS = {
    content: { template: 'modules/fa-nexus/templates/composition/scene-groups-window.hbs' }
  };

  constructor(options = {}) {
    super({ ...options, position: { ...sceneGroupViewState.windowPosition(), ...options.position } });
    this._workflow = options.sceneGroupWorkflow instanceof SceneGroupWorkflow
      ? options.sceneGroupWorkflow
      : new SceneGroupWorkflow();
    this._pathGeneratedWallOwnership = options.pathGeneratedWallOwnership || new PathGeneratedWallOwnership();
    this._buildingFillOwnership = options.buildingFillOwnership || createFoundryBuildingFillOwnershipService();
    this._buildingV2FillOwnership = options.buildingV2FillOwnership || createFoundryBuildingV2FillOwnershipService();
    this._busy = false;
    this._externalRevision = 0;
    this._externalRenderFrame = null;
    this._externalRenderPromise = null;
    this._closingPromise = null;
    this._closed = false;
    this._error = '';
    this._listenerRoot = null;
    this._htmlDragActive = false;
    this._htmlDragSource = null;
    this._listScrollTop = 0;
    this._presentationSceneId = null;
    this._revealSelection = true;
    this._contextMenuRequest = 0;
    this._contextMenuCleanup = null;
    this._rootListeners = Object.freeze({
      click: (event) => this._onClick(event),
      dblclick: (event) => this._onDoubleClick(event),
      contextmenu: (event) => this._onContextMenu(event),
      dragstart: (event) => this._onDragStart(event),
      dragend: () => {
        this._htmlDragActive = false;
        this._htmlDragSource = null;
        this._clearDropState();
      },
      dragover: (event) => this._onDragOver(event),
      dragleave: (event) => this._onDragLeave(event),
      drop: (event) => this._onDrop(event)
    });
    this._keyDownListener = (event) => this._onKeyDown(event);
    globalThis.addEventListener('keydown', this._keyDownListener, true);
    this._interactionHookId = Hooks.on(SCENE_GROUP_INTERACTION_HOOK, (state, reason) => {
      const sameIds = (a, b) => a.length === b.length && a.every(id => b.includes(id));
      const local = this._localSelection && sameIds(state.selectedGroupIds, this._localSelection.groups)
        && sameIds(state.selectedMemberUuids, this._localSelection.members);
      if (!local && ['select-group', 'select-groups', 'select-member', 'select-members'].includes(reason)) this._revealSelection = true;
      this._renderFromExternalState();
    });
    this._nativeDeletionStateHookId = Hooks.on(
      SCENE_GROUP_NATIVE_DELETION_STATE_HOOK,
      (scene, pending) => {
        if (scene?.id !== canvas?.scene?.id || pending === true) return;
        this._renderFromExternalState();
      }
    );
    this._sceneUpdateHookId = Hooks.on('updateScene', (scene, changes) => {
      if (scene?.id !== canvas?.scene?.id) return;
      if (!Object.keys(changes?.flags?.['fa-nexus'] || {}).includes('compositionRegistry')) return;
      this._renderFromExternalState();
    });
    this._canvasReadyHookId = Hooks.on('canvasReady', () => this._renderFromExternalState());
    this._canvasTearDownHookId = Hooks.on('canvasTearDown', () => {
      this._areaSelection?.cancel();
      this._closeContextMenu();
    });
    this._memberUpdateHooks = ['Tile', 'Wall', 'AmbientLight', 'AmbientSound', 'Region'].map(type => [type, Hooks.on(`update${type}`, (document, changes) => {
      if (document.parent?.id !== canvas?.scene?.id) return;
      // Coordinates and shape changes do not affect tree rows. A transform
      // emits an update per Wall; rebuilding the whole tree for each one queues
      // hundreds of Application renders after mouse-up.
      const keys = Object.keys(changes);
      if (!hasLayerHiddenChange(changes) && !keys.some(key => ['name', 'hidden', 'locked', 'texture', 'flags'].includes(key)
        || key.startsWith('flags.') || key.startsWith('texture.'))) return;
      this._renderFromExternalState();
    })]);
  }

  async _prepareContext() {
    return { ...await this._prepareSceneGroupsContext(), prefabsEnabled: isPrefabsEnabled() };
  }

  async _prepareSceneGroupsContext() {
    const scene = canvas?.scene || null;
    if (!scene) {
      return {
        canvasReady: false,
        busy: this._busy,
        error: 'No active Scene is available.',
        hasError: true,
        rows: [],
        groupCount: 0,
        empty: true
      };
    }

    if (this._presentationSceneId !== scene.id) {
      this._presentationSceneId = scene.id;
      this._listScrollTop = 0;
      this._revealSelection = true;
      this._error = '';
      this._lastRowClick = null;
      this._localSelection = null;
    }

    try {
      const result = await this._workflow.execute({
        scene,
        user: game?.user,
        action: { type: 'read' }
      });
      const state = sceneGroupInteractionState.reconcile(scene, result.projection);
      this._missingUuids = new Set(result.missingUuids);
      const interruptedLocks = inspectCompositionRegistryLocks(scene).filter(lock => lock.recoverable);
      const selectedGroups = new Set(state.selectedGroupIds);
      const selectedMembers = new Set(state.selectedMemberUuids);
      const decoratedProjection = result.projection.map((group) => ({
        ...group,
        members: group.members.map((member) => ({
          ...member,
          canHide: !member.missing,
          visibilityAction: member.hidden ? 'show-member' : 'hide-member',
          visibilityIcon: member.hidden ? 'fa-eye-slash' : 'fa-eye',
          icon: member.missing ? 'fa-solid fa-triangle-exclamation' : MEMBER_META[member.documentName]?.icon || 'fa-solid fa-file',
          typeLabel: member.relationshipType === 'generated-by'
            ? `Generated ${MEMBER_META[member.documentName]?.label || member.documentName}`
            : (MEMBER_META[member.documentName]?.label || member.documentName),
          relationshipDepthStyle: `--fa-nexus-scene-group-relationship-depth: ${member.relationshipDepth || 0}`,
          selected: selectedMembers.has(member.uuid)
        }))
      }));
      if (this._revealSelection) {
        const revealGroups = new Set(state.selectedGroupIds);
        for (const group of result.projection) {
          const selected = group.members.filter(member => selectedMembers.has(member.uuid));
          if (!selected.length) continue;
          revealGroups.add(group.id);
          if (!sceneGroupViewState.expanded(scene, 'groups', group.id)) sceneGroupViewState.setExpanded(scene, 'groups', [group.id], true);
          for (const member of selected) {
            if (!member.ownerUuid) continue;
            if (!sceneGroupViewState.expanded(scene, 'structures', member.ownerUuid)) sceneGroupViewState.setExpanded(scene, 'structures', [member.ownerUuid], true);
            if (member.documentName === 'Wall' && !sceneGroupViewState.expanded(scene, 'walls', member.ownerUuid)) sceneGroupViewState.setExpanded(scene, 'walls', [member.ownerUuid], true);
          }
        }
        state.collapsedGroupIds = sceneGroupInteractionState.revealGroups(scene, [...revealGroups], result.projection).collapsedGroupIds;
      }
      const plannedRows = planSceneGroupWindowRows({
        projection: decoratedProjection,
        collapsedGroupIds: state.collapsedGroupIds
      });
      const rows = plannedRows.map((group) => {
        const members = group.members;
        const iconColor = resolveSceneGroupIconColor(group.id, result.registry.groups);
        const memberPresentation = planSceneGroupMemberPresentation({
          members,
          collapsedStructureUuids: new Set(members.filter(member => !sceneGroupViewState.expanded(scene, 'structures', member.uuid)).map(member => member.uuid)),
          expandedWallOwnerUuids: new Set(sceneGroupViewState.read(scene).walls || [])
        });
        return {
          ...group,
          selected: selectedGroups.has(group.id),
          primary: state.primaryGroupId === group.id,
          members,
          ...memberPresentation,
          structures: memberPresentation.structures.map(structure => ({...structure,
            iconColor: validateSceneGroupIconColor(structure.anchor.groupIconColor || '') || iconColor})),
          hasSubtree: group.childGroupIds.length > 0 || members.length > 0,
          hasMembers: group.showDirectMembers,
          depthStyle: `--fa-nexus-scene-group-depth: ${group.depth}`,
          visibilityAction: group.visibilityState === 'hidden' ? 'show-group' : 'hide-group',
          visibilityTitle: group.visibilityState === 'hidden' ? 'Show complete group' : 'Hide complete group',
          visibilityIcon: group.visibilityState === 'hidden'
            ? 'fa-eye-slash'
            : group.visibilityState === 'mixed' ? 'fa-eye-low-vision' : 'fa-eye',
          lockAction: group.lockState === 'locked' ? 'unlock-group' : 'lock-group',
          canLock: !group.lockBlockers.length,
          locked: group.lockState !== 'unlocked',
          displayIcon: sceneGroupIconClass(group.icon),
          displayIconColor: iconColor,
          lockTitle: group.lockState === 'locked' ? 'Unlock complete group' : 'Lock complete group',
          lockIcon: group.lockState === 'locked'
            ? 'fa-lock'
            : group.lockState === 'mixed' ? 'fa-lock-keyhole' : 'fa-lock-open'
        };
      });
      return {
        canvasReady: true,
        busy: this._busy,
        error: this._error,
        hasError: !!this._error,
        hasRecovery: this._missingUuids.size > 0 || interruptedLocks.length > 0,
        recoveryMessage: [this._missingUuids.size ? `${this._missingUuids.size} references point to deleted items.` : '',
          interruptedLocks.length ? 'An interrupted Scene operation is blocking changes.' : ''].filter(Boolean).join(' '),
        rows,
        groupCount: result.projection.length,
        selectionCount: selectedGroups.size + selectedMembers.size,
        allGroupsCollapsed: result.projection.length > 0
          && result.projection.every((group) => state.collapsedGroupIds.includes(group.id)),
        empty: rows.length === 0,
        hasSelection: selectedGroups.size > 0 || selectedMembers.size > 0
      };
    } catch (error) {
      Logger.error('SceneGroupsWindow.prepare.failed', {
        sceneId: scene.id,
        stage: error?.stage || null,
        code: error?.code || null,
        error: String(error?.message || error)
      });
      return {
        canvasReady: true,
        busy: this._busy,
        error: sceneGroupFailureMessage(error),
        hasError: true,
        rows: [],
        groupCount: 0,
        empty: true,
        hasSelection: false
      };
    }
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    const list = root.querySelector?.('.fa-nexus-scene-groups__list');
    if (list) list.scrollTop = this._listScrollTop;
    if (list && this._revealSelection) {
      this._revealSelection = false;
      const row = root.querySelector('.fa-nexus-scene-groups__group.is-primary > .fa-nexus-scene-groups__group-row, .fa-nexus-scene-groups__member.is-selected');
      if (row) {
        const bounds = list.getBoundingClientRect(), target = row.getBoundingClientRect();
        list.scrollTop += (target.top + target.height / 2) - (bounds.top + bounds.height / 2);
        this._listScrollTop = list.scrollTop;
      }
    }
    if (this._listenerRoot && this._listenerRoot !== root) this._unbindRoot(this._listenerRoot);
    if (this._listenerRoot === root) return;
    this._listenerRoot = root;
    for (const [type, listener] of Object.entries(this._rootListeners)) root.addEventListener(type, listener);
  }

  _onPosition(position) {
    super._onPosition(position);
    if (!this.minimized && !this._closingPromise && !this._closed) sceneGroupViewState.setWindowPosition(this.position);
  }

  close(options = {}) {
    if (!this._closingPromise) {
      this._closingPromise = super.close(options).finally(() => { this._closingPromise = null; });
    }
    return this._closingPromise;
  }

  _onClose(options) {
    this._closed = true;
    cancelPrefabPlacement();
    this._cancelExternalRender();
    this._areaSelection?.cancel();
    this._closeContextMenu();
    if (this._listenerRoot) this._unbindRoot(this._listenerRoot);
    if (this._interactionHookId != null) Hooks.off(SCENE_GROUP_INTERACTION_HOOK, this._interactionHookId);
    if (this._nativeDeletionStateHookId != null) {
      Hooks.off(SCENE_GROUP_NATIVE_DELETION_STATE_HOOK, this._nativeDeletionStateHookId);
    }
    if (this._sceneUpdateHookId != null) Hooks.off('updateScene', this._sceneUpdateHookId);
    Hooks.off('canvasReady', this._canvasReadyHookId);
    Hooks.off('canvasTearDown', this._canvasTearDownHookId);
    for (const [type, id] of this._memberUpdateHooks) Hooks.off(`update${type}`, id);
    globalThis.removeEventListener('keydown', this._keyDownListener, true);
    this._interactionHookId = null;
    this._nativeDeletionStateHookId = null;
    this._sceneUpdateHookId = null;
    if (sceneGroupsWindow === this) sceneGroupsWindow = null;
    return super._onClose(options);
  }

  _unbindRoot(root) {
    for (const [type, listener] of Object.entries(this._rootListeners)) root.removeEventListener(type, listener);
    if (this._listenerRoot === root) this._listenerRoot = null;
  }

  _renderFromExternalState() {
    this._externalRevision++;
    this._scheduleExternalRender();
  }

  _cancelExternalRender() {
    if (this._externalRenderFrame != null) cancelAnimationFrame(this._externalRenderFrame);
    this._externalRenderFrame = null;
  }

  _scheduleExternalRender() {
    if (isSceneGroupNativeDeletionPending(canvas?.scene)) return;
    if (!this.rendered || this._busy || this._closed || this._closingPromise || this._externalRenderFrame != null || this._externalRenderPromise) return;
    this._externalRenderFrame = requestAnimationFrame(() => {
      this._externalRenderFrame = null;
      if (this._busy || this._closed || this._closingPromise || isSceneGroupNativeDeletionPending(canvas?.scene)) return;
      this._closeContextMenu();
      this._captureListScroll();
      const revision = this._externalRevision;
      this._externalRenderPromise = this.render({ force: true })
        .catch(error => reportWindowFailure('SceneGroupsWindow.externalRender.failed', error))
        .finally(() => {
          this._externalRenderPromise = null;
          if (revision !== this._externalRevision) this._scheduleExternalRender();
        });
    });
  }

  async _run(scope, task) {
    if (this._busy) return null;
    this._captureListScroll();
    this._busy = true;
    this._cancelExternalRender();
    this._error = '';
    let renderedRevision = this._externalRevision;
    try {
      await this._externalRenderPromise;
      const result = await task();
      renderedRevision = this._externalRevision;
      if (!this._closed && !this._closingPromise) await this.render({ force: true });
      return result;
    } catch (error) {
      this._error = sceneGroupFailureMessage(error);
      reportWindowFailure(`SceneGroupsWindow.${scope}.failed`, error);
      renderedRevision = this._externalRevision;
      if (!this._closed && !this._closingPromise) await this.render({ force: true });
      return null;
    } finally {
      this._busy = false;
      this._localSelection = null;
      if (renderedRevision !== this._externalRevision) this._scheduleExternalRender();
    }
  }

  _captureListScroll() {
    const list = this.element?.querySelector?.('.fa-nexus-scene-groups__list');
    if (list) this._listScrollTop = list.scrollTop;
  }

  _onClick(event) {
    const contentRoot = event.target?.closest?.('.fa-nexus-scene-groups');
    const actionElement = contentRoot?.contains?.(event.target)
      ? event.target?.closest?.('[data-action]')
      : null;
    const action = normalizeIdentity(actionElement?.dataset?.action);
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      const groupId = normalizeIdentity(actionElement?.dataset?.sceneGroupId);
      if (action === 'prefab-library') {
        void this._run('prefabLibrary', () => openPrefabLibrary()).then(app => app?.bringToFront());
        return;
      }
      if (action === 'recover-registry') {
        void this._run('recoverRegistry', async () => {
          const scene = canvas.scene;
          const { missingUuids } = await this._workflow.execute({ scene, user: game.user, action: { type: 'read' } });
          const locks = inspectCompositionRegistryLocks(scene).filter(lock => lock.recoverable);
          const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: 'Recover Scene Groups' }, modal: true, rejectClose: false,
            content: `<p>Remove ${missingUuids.length} references to deleted items and folders left empty by them. All remaining scene objects are preserved.</p>${locks.length ? '<p>Also release the interrupted operation. Continue only when no other client is editing or committing this Scene.</p>' : ''}`,
            yes: { label: 'Recover' }
          });
          if (!confirmed) return;
          if (canvas.scene !== scene) throw new Error('The active Scene changed before recovery.');
          for (const lock of locks) await releaseInterruptedCompositionRegistryLock(scene, lock);
          await this._workflow.execute({ scene, user: game.user, action: { type: 'repair-missing-references' } });
        });
        return;
      }
      if (action === 'canvas-select') {
        void this._run('canvasSelect', () => this._captureCanvasArea());
        return;
      }
      if (action === 'toggle-disclosure') {
        sceneGroupInteractionState.toggleGroupDisclosure(canvas?.scene, groupId);
        return;
      }
      if (action === 'toggle-all-groups') {
        void this._run('toggleAllGroups', async () => {
          const { projection } = await this._execute({ type: 'read' });
          const state = sceneGroupInteractionState.snapshot(canvas?.scene);
          const groupIds = projection.map((group) => group.id);
          const collapse = !groupIds.every((id) => state.collapsedGroupIds.includes(id));
          sceneGroupInteractionState.setGroupsCollapsed(canvas?.scene, groupIds, collapse);
        });
        return;
      }
      const ownerUuid = normalizeIdentity(actionElement.dataset.ownerUuid);
      if (['hide-member', 'show-member', 'unlock-member'].includes(action)) {
        void this._run(action, () => this._execute({ type: action, memberUuid: actionElement.dataset.memberUuid }));
        return;
      }
      if (action === 'toggle-structure' || action === 'toggle-structure-walls') {
        sceneGroupViewState.toggle(canvas.scene, action === 'toggle-structure' ? 'structures' : 'walls', ownerUuid);
        this._renderFromExternalState();
        return;
      }
      if (['rename-structure', 'hide-structure', 'show-structure', 'lock-structure', 'unlock-structure'].includes(action)) {
        void this._runStructureAction(action, ownerUuid);
        return;
      }
      if ([
        'ungroup',
        'delete-group',
        'rename-group',
        'hide-group',
        'show-group',
        'lock-group',
        'unlock-group'
      ].includes(action)) {
        void this._runGroupRowAction(action, groupId);
        return;
      }
      throw new Error(`Unsupported Scene Groups window action: ${action}.`);
    }

    const ctrlKey = !!(event.ctrlKey || event.metaKey);
    const shiftKey = !!event.shiftKey;
    const state = sceneGroupInteractionState.snapshot(canvas?.scene);
    const member = event.target?.closest?.('[data-scene-group-member-uuid]');
    const clickedGroup = event.target?.closest?.('[data-scene-group-id]');
    const clickIdentity = member?.dataset.sceneGroupMemberUuid || clickedGroup?.dataset.sceneGroupId;
    const now = performance.now();
    if (clickIdentity && !ctrlKey && !shiftKey && this._lastRowClick?.id === clickIdentity && now - this._lastRowClick.at < 400) {
      this._lastRowClick = null;
      this._onDoubleClick(event);
    } else this._lastRowClick = clickIdentity ? { id: clickIdentity, at: now } : null;
    if (member) {
      event.preventDefault();
      const uuid = normalizeIdentity(member.dataset.sceneGroupMemberUuid);
      if (this._missingUuids?.has(uuid)) return;
      const plan = planSceneGroupWindowSelection({
        id: uuid,
        visibleIds: this._visibleRowIds('member'),
        selectedIds: state.selectedMemberUuids,
        anchorId: state.memberSelectionAnchorUuid,
        ctrlKey,
        shiftKey
      });
      void this._run('selectMember', async () => {
        this._localSelection = { groups: [], members: plan.selectedIds };
        await selectSceneMembers(plan.selectedIds, uuid);
        await Promise.resolve();
        sceneGroupInteractionState.selectMembers(canvas?.scene, plan.selectedIds, {
          anchorUuid: plan.anchorId
        });
      });
      return;
    }
    const row = event.target?.closest?.('[data-scene-group-id]');
    if (!row) return;
    event.preventDefault();
    const groupId = normalizeIdentity(row.dataset.sceneGroupId);
    const plan = planSceneGroupWindowSelection({
      id: groupId,
      visibleIds: this._visibleRowIds('group'),
      selectedIds: state.selectedGroupIds,
      anchorId: state.groupSelectionAnchorId,
      ctrlKey,
      shiftKey
    });
    const scene = canvas?.scene;
    void this._run('selectGroup', async () => {
      this._localSelection = { groups: plan.selectedIds, members: [] };
      const result = await this._workflow.execute({
        scene,
        user: game?.user,
        action: { type: 'select-group', groupId: plan.selectedIds.length === 1 ? plan.selectedIds[0] : groupId }
      });
      if (plan.selectedIds.length === 1) await revealHomogeneousSceneMembers(result.selection.memberUuids);
      this._releaseNativePlaceableSelection();
      sceneGroupInteractionState.selectGroups(scene, plan.selectedIds, {
        anchorId: plan.anchorId,
        primaryGroupId: groupId
      });
    });
  }

  _visibleRowIds(kind) {
    const selector = kind === 'group'
      ? '.fa-nexus-scene-groups__group[data-scene-group-id]'
      : '.fa-nexus-scene-groups__member[data-scene-group-member-uuid]';
    const dataKey = kind === 'group' ? 'sceneGroupId' : 'sceneGroupMemberUuid';
    return Array.from(this.element?.querySelectorAll?.(selector) || [])
      .map((row) => normalizeIdentity(row.dataset?.[dataKey]))
      .filter(Boolean);
  }

  _onDoubleClick(event) {
    if (event.target.closest('[data-action]')) return;
    const member = event.target.closest('[data-scene-group-member-uuid]');
    const group = event.target.closest('[data-scene-group-id]');
    const id = member?.dataset.sceneGroupMemberUuid || group?.dataset.sceneGroupId;
    if (member && this._missingUuids?.has(id)) return;
    if (!id) return;
    const now = performance.now();
    if (this._lastFocus?.id === id && now - this._lastFocus.at < 400) return;
    this._lastFocus = { id, at: now };
    event.preventDefault();
    const task = member ? focusSceneMember(member.dataset.sceneGroupMemberUuid) : group ? this._execute({ type: 'read' }).then(result => {
      const entry = result.projection.find(item => item.id === group.dataset.sceneGroupId);
      if (entry) return canvas.animatePan({ ...entry.pivot, duration: 250 });
    }) : null;
    task?.catch(error => reportWindowFailure('SceneGroupsWindow.focus.failed', error));
  }

  async _chooseIcon(target, current = '', options = {}) {
    const appearance = await chooseSceneGroupIcon(current, options);
    if (appearance == null || appearance === false) return;
    return this._run('setGroupIcon', () => this._execute({ type: 'set-group-icon', ...appearance, ...target }));
  }

  async _captureCanvasArea() {
    const scene = canvas.scene;
    this._areaSelection = selectSceneGroupArea();
    const area = await this._areaSelection.promise;
    this._areaSelection = null;
    if (!area) return false;
    const {getLayerManagerSelectionOptions}=await import('../layers/layer-manager-tab.js');
    const prepared = await this._execute({ type: 'prepare-capture-area', area, selectionOptions:getLayerManagerSelectionOptions() });
    if (!prepared.candidates.length) {
      ui.notifications.info('No eligible objects in this area. Check the current Level and Selection Options.');
      return false;
    }
    const memberUuids = prepared.candidates.flatMap(candidate => candidate.memberUuids);
    const chosen = await reviewSceneGroupCapture(prepared.candidates, { anchor:area.anchor,
      refresh:async () => (await this._workflow.execute({scene, user:game.user,
        action:{type:'prepare-capture-area', area, memberUuids, selectionOptions:getLayerManagerSelectionOptions()}})).candidates });
    if (!chosen) return false;
    if (canvas.scene !== scene) throw new Error('The active Scene changed during selection.');
    const result = await this._execute({ type: 'create-captured-group', area, ...chosen, selectionOptions:getLayerManagerSelectionOptions() });
    sceneGroupInteractionState.selectGroup(scene, result.group.id);
    sceneGroupInteractionState.setGroupsCollapsed(scene, [result.group.id], false);
    return result;
  }

  _runStructureAction(type, ownerUuid) {
    return this._run(type, async () => {
      let name;
      if (type === 'rename-structure') {
        const { projection } = await this._execute({ type: 'read' });
        const member = projection.flatMap((group) => group.members).find((member) => member.uuid === ownerUuid);
        name = await this._promptGroupName({ initialName: member?.name, title: 'Rename Structure', acceptLabel: 'Rename' });
        if (name == null) return false;
      }
      return this._execute({ type, ownerUuid, name });
    });
  }

  _runGroupRowAction(action, groupId) {
    if (action === 'ungroup' || action === 'dissolve-group') {
      return this._run(action, () => this._execute({ type: action, groupId }));
    }
    if (action === 'delete-group') {
      return this._run('delete', () => this._deleteGroup(groupId));
    }
    if (action === 'rename-group') {
      return this._run('rename', () => this._renameGroup(groupId));
    }
    if (['hide-group', 'show-group', 'lock-group', 'unlock-group'].includes(action)) {
      return this._run(action, () => this._execute({ type: action, groupId }));
    }
    throw new Error(`Unsupported Scene Group row action: ${action || 'missing'}.`);
  }

  _onContextMenu(event) {
    const contentRoot = event.target?.closest?.('.fa-nexus-scene-groups');
    if (!contentRoot || !this.element?.contains?.(contentRoot)) return;
    const member = event.target?.closest?.('.fa-nexus-scene-groups__member[data-scene-group-member-uuid]');
    const group = member
      ? null
      : event.target?.closest?.('.fa-nexus-scene-groups__group[data-scene-group-id]');
    event.preventDefault();
    event.stopPropagation();
    if (!member && !group) {
      this._closeContextMenu();
      return;
    }
    const target = member
      ? { structure: !!member.dataset.structureOwnerUuid, kind: 'member', id: normalizeIdentity(member.dataset.sceneGroupMemberUuid) }
      : { kind: 'group', id: normalizeIdentity(group.dataset.sceneGroupId) };
    if (member && this._missingUuids?.has(target.id)) return;
    const anchor = {
      clientX: Number(event.clientX) || 0,
      clientY: Number(event.clientY) || 0
    };
    void this._openRowContextMenu(target, anchor);
  }

  async _openRowContextMenu(target, anchor) {
    this._closeContextMenu();
    const request = ++this._contextMenuRequest;
    const menuItems = await this._run('contextMenuSelection', async () => {
      const scene = canvas?.scene;
      const state = sceneGroupInteractionState.snapshot(scene);
      if (target.kind === 'group') {
        const plan = planSceneGroupContextSelection({
          id: target.id,
          selectedIds: state.selectedGroupIds,
          anchorId: state.groupSelectionAnchorId
        });
        this._localSelection = { groups: plan.selectedIds, members: [] };
        const result = await this._workflow.execute({
          scene,
          user: game?.user,
          action: { type: 'select-group', groupId: target.id }
        });
        if (plan.selectedIds.length === 1) await revealHomogeneousSceneMembers(result.selection.memberUuids);
        this._releaseNativePlaceableSelection();
        sceneGroupInteractionState.selectGroups(scene, plan.selectedIds, {
          anchorId: plan.anchorId,
          primaryGroupId: target.id
        });
      } else {
        const plan = planSceneGroupContextSelection({
          id: target.id,
          selectedIds: state.selectedMemberUuids,
          anchorId: state.memberSelectionAnchorUuid
        });
        this._localSelection = { groups: [], members: plan.selectedIds };
        await selectSceneMembers(plan.selectedIds, target.id);
        sceneGroupInteractionState.selectMembers(scene, plan.selectedIds, {
          anchorUuid: plan.anchorId
        });
      }
      return await this._buildContextMenuItems(target);
    });
    if (this.rendered && request === this._contextMenuRequest && menuItems?.length) this._showContextMenu(anchor, menuItems);
  }

  async _buildContextMenuItems(target) {
    const result = await this._execute({ type: 'read' });
    if (target.kind === 'group') {
      const group = result.projection.find((entry) => entry.id === target.id);
      if (!group) throw new Error(`Scene Group not found for context menu: ${target.id}.`);
      const lockAction = group.lockState === 'locked' ? 'unlock-group' : 'lock-group';
      return [
        {label:'Edit Bounds',iconClass:'fa-solid fa-vector-square',action:()=>this._run('editBounds',()=>editSceneGroupBounds(group.id))},
        ...(result.registry.groups[group.id]?.bounds ? [{label:'Reset Bounds',iconClass:'fa-solid fa-expand',
          action:()=>this._run('resetBounds',()=>this._execute({type:'set-group-bounds',groupId:group.id,bounds:null}))}] : []),
        {label:'Flip Horizontally',iconClass:'fa-solid fa-left-right',
          action:()=>this._run('flipGroup',()=>this._execute({type:'reflect-group',groupId:group.id,axis:'horizontal'}))},
        {label:'Flip Vertically',iconClass:'fa-solid fa-up-down',
          action:()=>this._run('flipGroup',()=>this._execute({type:'reflect-group',groupId:group.id,axis:'vertical'}))},
        { label: 'Duplicate Group…', iconClass: 'fa-solid fa-copy',
          action: () => this._run('duplicate', () => copyGroup(group.id)) },
        { label: 'Copy (Ctrl+C)', iconClass: 'fa-solid fa-copy',
          action: () => this._run('copy', () => copyGroupToClipboard(group.id)) },
        ...(isPrefabsEnabled() ? [{ label: 'Save as Prefab…', iconClass: 'fa-solid fa-box-archive',
          action: async () => { if (await this._run('savePrefab', () => saveGroupPrefab(group.id, {
            updateId: result.registry.groups[group.id]?.provenance?.prefabId
          }))) await openPrefabLibrary(); } }] : []),
        {
          label: 'Rename',
          iconClass: 'fa-solid fa-i-cursor',
          action: () => this._runGroupRowAction('rename-group', group.id)
        },
        {
          label: 'Icon & Color…', iconClass: 'fa-solid fa-icons',
          action: () => this._chooseIcon({ groupId: group.id }, group.icon, {color:group.iconColor || '',
            inheritedColor:resolveSceneGroupIconColor(group.parentId,result.registry.groups)})
        },
        {
          label: lockAction === 'unlock-group' ? 'Unlock' : 'Lock',
          iconClass: lockAction === 'unlock-group' ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock',
          action: () => this._runGroupRowAction(lockAction, group.id)
        },
        {
          label: 'Ungroup',
          iconClass: 'fa-solid fa-object-ungroup',
          action: () => this._runGroupRowAction('ungroup', group.id)
        },
        {
          label: 'Dissolve Group',
          iconClass: 'fa-solid fa-layer-minus',
          title: 'Remove this group and all subgroups, keeping their objects.',
          action: () => this._runGroupRowAction('dissolve-group', group.id)
        },
        ...(group.parentId ? [{label:'Remove from Scene Group',iconClass:'fa-solid fa-arrow-right-from-bracket',
          action:()=>this._removeSceneGroupSelection({groupIds:sceneGroupInteractionState.snapshot(canvas.scene).selectedGroupIds})}] : []),
        {
          label: 'Delete',
          iconClass: 'fa-solid fa-trash',
          danger: true,
          action: () => this._runGroupRowAction('delete-group', group.id)
        }
      ];
    }

    if (target.structure) {
      const group = result.projection.find((group) => group.members.some((member) => member.uuid === target.id));
      const member = group?.members.find((member) => member.uuid === target.id);
      if (!member) return [];
      const structure = planSceneGroupMemberPresentation({ members: group.members }).structures.find((entry) => entry.ownerUuid === target.id);
      if (!structure) return [];
      const nativeItems = await buildSceneMemberContextItems(member, {
        execute: action => this._run(action.type, () => this._execute(action))
      });
      const items = [
        ...nativeItems.filter(item => ['Nexus Edit', 'Configure'].includes(item.label)),
        {label:'Remove from Scene Group',iconClass:'fa-solid fa-arrow-right-from-bracket',
          action:()=>this._removeSceneGroupSelection({memberUuids:[target.id]})},
        { label: 'Rename', iconClass: 'fa-solid fa-i-cursor', action: () => this._runStructureAction('rename-structure', target.id) },
        { label: 'Icon & Color…', iconClass: 'fa-solid fa-icons', action: () => this._chooseIcon({ ownerUuid: target.id }, member.groupIcon,
          {color:member.groupIconColor || '',inheritedColor:resolveSceneGroupIconColor(group.id,result.registry.groups)}) },
        { label: structure.lockAction === 'unlock-structure' ? 'Unlock' : 'Lock', iconClass: `fa-solid ${structure.lockIcon}`,
          action: () => this._runStructureAction(structure.lockAction, target.id) }
      ];
      const root = canvas.scene.tiles.get(member.id);
      if ([4, 5].includes(Number(root?.flags?.['fa-nexus']?.building?.schemaVersion))) items.push({
        label: 'Reset Building Scale', iconClass: 'fa-solid fa-arrows-to-circle',
        action: () => this._run('resetBuildingScale', () => this._execute({ type: 'reset-building-scale', ownerUuid: target.id }))
      });
      return items;
    }
    const directParentByMemberUuid = new Map();
    for (const group of result.projection) {
      for (const member of group.members || []) {
        if (member.direct) directParentByMemberUuid.set(member.uuid, group.id);
      }
    }
    const targetMember = result.projection
      .flatMap((group) => group.members || [])
      .find((member) => member.uuid === target.id) || null;
    const memberItems = targetMember ? await buildSceneMemberContextItems(targetMember, {
      execute: action => this._run(action.type, () => this._execute(action)),
      rename: async document => {
        const name = await this._promptGroupName({ initialName: document.name, title: 'Rename Tile', acceptLabel: 'Rename' });
        if (name != null) return document.update({ name });
      }
    }) : [];
    if (targetMember?.relationshipType === 'generated-by'
      && targetMember?.generator === 'building'
      && targetMember?.documentName === 'Tile') {
      const fillId = normalizeIdentity(targetMember.uuid).split('.').pop();
      const fill = canvas?.scene?.tiles?.get?.(fillId)
        || canvas?.scene?.getEmbeddedDocument?.('Tile', fillId)
        || null;
      const marker = fill?.getFlag?.('fa-nexus', 'buildingFill')
        || fill?.flags?.['fa-nexus']?.buildingFill
        || fill?._source?.flags?.['fa-nexus']?.buildingFill
        || null;
      const rootTileId = normalizeIdentity(marker?.wallTileId);
      const ownerTileId = normalizeIdentity(targetMember.ownerUuid).split('.').pop();
      if (rootTileId && rootTileId === ownerTileId) {
        const root = canvas?.scene?.tiles?.get?.(rootTileId) || null;
        const building = root?.getFlag?.('fa-nexus', 'building')
          || root?.flags?.['fa-nexus']?.building
          || root?._source?.flags?.['fa-nexus']?.building
          || null;
        if ([4, 5].includes(Number(building?.schemaVersion))) return memberItems;
        const fillOwnership = [4, 5].includes(Number(building?.schemaVersion))
          ? this._buildingV2FillOwnership
          : this._buildingFillOwnership;
        const eligibility = await fillOwnership.inspectManagedFill({
          sceneId: canvas?.scene?.id,
          rootTileId
        });
        const allowed = eligibility.status === 'ready' && eligibility.fillUuid === normalizeIdentity(targetMember.uuid);
        const reason = allowed
          ? null
          : (eligibility.reason === 'active-edit-session'
              ? 'Commit or Cancel the active Building Edit session before making its Fill independent.'
              : (eligibility.reason === 'managed-fill-already-direct'
                  ? 'This Fill Tile is already an independent group member.'
                  : (eligibility.reason === 'root-group-ambiguous'
                      ? 'The Building root belongs to zero or several Scene Groups.'
                      : 'This Fill no longer has one exact Building ownership relationship and cannot be made independent.')));
        return [...memberItems, {
          label: 'Make Fill Independent',
          iconClass: 'fa-solid fa-link-slash',
          disabled: !allowed,
          title: reason,
          action: () => this._run('makeFillIndependent', () => this._makeFillIndependent({
            rootTileId,
            fillUuid: normalizeIdentity(targetMember.uuid),
            schemaVersion: Number(building?.schemaVersion) || null
          }))
        }];
      }
    }
    if (targetMember?.relationshipType === 'generated-by' && targetMember?.generator === 'path-v2') {
      const eligibility = this._pathGeneratedWallOwnership.getMakeIndependentEligibility({
        scene: canvas?.scene,
        wallUuid: targetMember.uuid
      });
      return [...memberItems, {
        label: 'Make Independent',
        iconClass: 'fa-solid fa-link-slash',
        disabled: !eligibility.allowed,
        title: eligibility.reason,
        action: () => this._run('makeIndependent', () => (
          this._pathGeneratedWallOwnership.makeIndependent({
            scene: canvas?.scene,
            user: game?.user,
            wallUuid: targetMember.uuid
          })
        ))
      }];
    }
    const selectedMemberUuids = sceneGroupInteractionState.snapshot(canvas?.scene).selectedMemberUuids;
    const removableMemberUuids = selectedMemberUuids.filter(uuid => directParentByMemberUuid.has(uuid));
    const eligibility = resolveCreateSubgroupEligibility({
      selectedMemberUuids,
      directParentByMemberUuid
    });
    return [...memberItems, ...(removableMemberUuids.length ? [{label:'Remove from Scene Group',iconClass:'fa-solid fa-arrow-right-from-bracket',
      action:()=>this._removeSceneGroupSelection({memberUuids:removableMemberUuids})}] : []), {
      label: 'Create Subgroup…',
      iconClass: 'fa-solid fa-folder-plus',
      disabled: !eligibility.allowed,
      title: eligibility.reason,
      action: () => this._run('createSubgroup', () => this._createSubgroupFromSelection(
        selectedMemberUuids,
        eligibility.parentGroupId
      ))
    }];
  }

  _showContextMenu(anchor, items = []) {
    const menuItems = organizeContextMenu(items);
    if (!menuItems.length) return;
    const menu = document.createElement('div');
    menu.className = 'fa-nexus-scene-groups__context-menu';
    menu.setAttribute('role', 'menu');
    for (const item of menuItems) {
      if (item.separator) {
        const separator = document.createElement('div');
        separator.className = 'fa-nexus-context-menu-separator'; separator.setAttribute('role','separator');
        menu.append(separator); continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `fa-nexus-scene-groups__context-menu-item${item.danger ? ' is-danger' : ''}`;
      button.setAttribute('role', 'menuitem');
      if (item.disabled) {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
      }
      if (item.title) button.title = item.title;
      const icon = document.createElement('i');
      icon.className = `${item.iconClass || 'fa-solid fa-circle'} fa-nexus-scene-groups__context-menu-icon`;
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = item.label;
      button.append(icon, label);
      if (item.disabled && item.title) {
        button.classList.add('has-reason');
        const reason = document.createElement('small');
        reason.className = 'fa-nexus-scene-groups__context-menu-reason';
        reason.textContent = item.title;
        button.append(reason);
      }
      button.addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        if (button.disabled || typeof item.action !== 'function') return;
        this._closeContextMenu();
        Promise.resolve(item.action()).catch((error) => reportWindowFailure(
          'SceneGroupsWindow.contextMenu.action.failed',
          error
        ));
      });
      menu.appendChild(button);
    }
    (document.body || this.element)?.appendChild(menu);
    const margin = 8;
    const maxLeft = Math.max(margin, innerWidth - menu.offsetWidth - margin);
    const maxTop = Math.max(margin, innerHeight - menu.offsetHeight - margin);
    menu.style.left = `${Math.min(Math.max(margin, anchor.clientX + 2), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(margin, anchor.clientY + 2), maxTop)}px`;

    let listenersBound = false;
    const closeForOutsidePointer = (pointerEvent) => {
      if (!menu.contains(pointerEvent.target)) this._closeContextMenu();
    };
    const closeForContext = (contextEvent) => {
      if (!menu.contains(contextEvent.target)) this._closeContextMenu();
    };
    const closeForEscape = (keyEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopImmediatePropagation();
      this._closeContextMenu();
    };
    const closeForWindowChange = (event) => {
      if (event.type === 'scroll' && event.target !== document && !this.element?.contains(event.target)) return;
      this._closeContextMenu();
    };
    const bindTimer = setTimeout(() => {
      listenersBound = true;
      document.addEventListener('pointerdown', closeForOutsidePointer, true);
      document.addEventListener('contextmenu', closeForContext, true);
      document.addEventListener('keydown', closeForEscape, true);
      window.addEventListener('resize', closeForWindowChange);
      window.addEventListener('blur', closeForWindowChange);
      window.addEventListener('scroll', closeForWindowChange, true);
    }, 0);
    this._contextMenuCleanup = () => {
      clearTimeout(bindTimer);
      menu.remove();
      if (!listenersBound) return;
      document.removeEventListener('pointerdown', closeForOutsidePointer, true);
      document.removeEventListener('contextmenu', closeForContext, true);
      document.removeEventListener('keydown', closeForEscape, true);
      window.removeEventListener('resize', closeForWindowChange);
      window.removeEventListener('blur', closeForWindowChange);
      window.removeEventListener('scroll', closeForWindowChange, true);
    };
  }

  _closeContextMenu() {
    this._contextMenuRequest++;
    const cleanup = this._contextMenuCleanup;
    this._contextMenuCleanup = null;
    cleanup?.();
  }

  _onDragStart(event) {
    this._htmlDragActive = true;
    this._htmlDragSource = null;
    if (event.target?.closest?.('button')) {
      this._htmlDragActive = false;
      event.preventDefault();
      return;
    }
    const state = sceneGroupInteractionState.snapshot(canvas?.scene);
    const selected = [
      ...state.selectedGroupIds.map((id) => ({ kind: 'group', id })),
      ...state.selectedMemberUuids.map((id) => ({ kind: 'document', id }))
    ];
    const member = event.target?.closest?.('[data-scene-group-member-uuid]');
    if (member) {
      if (this._missingUuids?.has(member.dataset.sceneGroupMemberUuid)) { event.preventDefault(); this._htmlDragActive = false; return; }
      this._htmlDragSource = 'groups-window';
      const resolved = resolveSceneGroupDragSelection({
        origin: { kind: 'document', id: member.dataset.sceneGroupMemberUuid },
        selected
      });
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', JSON.stringify({
        type: 'SceneGroupMembers',
        uuids: resolved.memberUuids
      }));
      writeSceneDocumentDragData(event.dataTransfer, resolved.memberUuids.map((uuid) => ({ uuid })));
      return;
    }
    const row = event.target?.closest?.('[data-scene-group-id]');
    const groupId = normalizeIdentity(row?.dataset?.sceneGroupId);
    if (!groupId) {
      this._htmlDragActive = false;
      event.preventDefault();
      return;
    }
    this._htmlDragSource = 'groups-window';
    const resolved = resolveSceneGroupDragSelection({
      origin: { kind: 'group', id: groupId },
      selected
    });
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', JSON.stringify({
      type: 'SceneGroups',
      groupIds: resolved.groupIds
    }));
    writeSceneGroupDragData(event.dataTransfer, resolved.groupIds);
  }

  _onKeyDown(event) {
    const key = String(event?.key || '').toLowerCase();
    if (key !== 'escape') return;
    if (cancelPrefabPlacement()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (this._areaSelection) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this._areaSelection.cancel();
      return;
    }
    if (this._contextMenuCleanup || globalThis.document?.querySelector('.fa-nexus-layer-manager__context-menu')) return;
    const state = sceneGroupInteractionState.snapshot(canvas?.scene);
    if (!state.selectedGroupIds.length) return;
    const target = event.target instanceof Element ? event.target : globalThis.document?.activeElement;
    if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    const owningApplication = target?.closest?.('.application, .window-app');
    if (owningApplication && !this.element?.contains?.(target)) return;
    if (globalThis.ui?.context || this._htmlDragActive) return;
    if (globalThis[OVERLAY_DRAG_MARKER]) return;
    const nativeDragActive = ['tiles', 'walls', 'lighting', 'sounds', 'regions'].some((layerKey) => (
      (canvas?.[layerKey]?.placeables || []).some((placeable) => placeable?.mouseInteractionManager?.isDragging)
    ));
    if (nativeDragActive) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sceneGroupInteractionState.clear(canvas?.scene, 'escape-clear-group-selection');
  }

  _releaseNativePlaceableSelection() {
    for (const layerKey of ['tiles', 'walls', 'lighting', 'sounds', 'regions']) {
      for (const placeable of [...(canvas?.[layerKey]?.controlled || [])]) {
        placeable.release({ renderSidebar: false });
      }
    }
    globalThis.ui?.placeables?.render?.();
  }

  _resolveDropTarget(event) {
    const element = event.target?.closest?.('[data-scene-group-drop]');
    if (!element) return null;
    const mode = normalizeIdentity(element.dataset.sceneGroupDrop);
    return {
      element,
      mode,
      parentGroupId: normalizeIdentity(element.dataset.sceneGroupId) || null
    };
  }

  _onDragOver(event) {
    const target = this._resolveDropTarget(event);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    target.element.classList.add('is-drop-target');
  }

  _onDragLeave(event) {
    const target = this._resolveDropTarget(event);
    if (!target) return;
    const related = event.relatedTarget;
    if (related && target.element.contains(related)) return;
    target.element.classList.remove('is-drop-target');
  }

  _onDrop(event) {
    this._htmlDragActive = false;
    const internalSource = this._htmlDragSource;
    this._htmlDragSource = null;
    const target = this._resolveDropTarget(event);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    this._clearDropState();
    void this._run('drop', async () => {
      const parsedPayload = readSceneGroupDropData(event);
      const payload = {
        ...parsedPayload,
        source: internalSource || parsedPayload.source
      };
      return await this._applyDropPayload(payload, target);
    });
  }

  _clearDropState() {
    for (const element of this.element?.querySelectorAll?.('.is-drop-target') || []) {
      element.classList.remove('is-drop-target');
    }
  }

  async _applyDropPayload(payload, target) {
    if (payload.memberUuids.length) {
      const scene = canvas.scene;
      const {registry} = await this._execute({type:'read'});
      const ownership = planSceneGroupDropOwnership(payload, registry);
      let includeOwners = true;
      if (ownership.requiredOwnerUuids.length) {
        const removing = target.mode === 'root';
        const names = ownership.requiredOwnerUuids.map(uuid => {
          const doc = globalThis.fromUuidSync(uuid);
          return foundry.utils.escapeHTML(doc?.flags?.['fa-nexus']?.name || doc?.name || 'Building or Path');
        });
        const choice = await foundry.applications.api.DialogV2.wait({
          window:{title:removing ? 'Remove the whole Building or Path?' : 'Include the whole Building or Path?'}, modal:true, rejectClose:false,
          position:{width:430}, content:`<p>These generated parts belong to ${names.join(', ')}. ${removing
            ? 'Remove their complete owner structures from Scene Groups?'
            : 'Add their complete owner structures to the Scene Group?'}</p>`,
          buttons:[{action:'include',label:removing ? 'Remove Whole Building / Path' : 'Add Whole Building / Path',default:true,callback:()=> 'include'},
            {action:'skip',label:'Skip These Parts',callback:()=> 'skip'},
            {action:'cancel',label:'Cancel',callback:()=> false}]
        });
        if (!choice) return false;
        if (canvas.scene !== scene) throw new Error('The active Scene changed during the drop.');
        includeOwners = choice === 'include';
      }
      payload = includeOwners ? ownership.payload : planSceneGroupDropOwnership(payload, registry, {includeOwners:false}).payload;
      if (!payload.memberUuids.length && !payload.groupIds.length) return false;
    }
    if (payload.layerTree && target.mode !== 'root') {
      const result = await this._execute({type:'create-layer-groups',layerTree:payload.layerTree,parentGroupId:target.parentGroupId});
      if (result.selection?.groupId) sceneGroupInteractionState.selectGroup(canvas.scene, result.selection.groupId);
      return result;
    }
    const documentTypes = await this._resolvePayloadDocumentTypes(payload);
    const plan = planSceneGroupWindowDrop({
      targetMode: target.mode,
      parentGroupId: target.parentGroupId,
      source: payload.source,
      memberUuids: payload.memberUuids,
      groupIds: payload.groupIds,
      documentTypes
    });
    if (plan.operation === 'create-group') {
      const namingIntent = payload.groupIds.length
        ? createGenericSceneGroupNameIntent()
        : createSceneGroupNameIntentForDocumentTypes(documentTypes);
      return await this._createGroupFromDrop(payload, {
        namingIntent,
        parentGroupId: plan.parentGroupId,
        allowParentChange: plan.allowParentChange
      });
    }
    const result = await this._execute({
      type: 'reparent-items',
      memberUuids: payload.memberUuids,
      groupIds: payload.groupIds,
      parentGroupId: plan.parentGroupId
    });
    if (result?.selection?.groupId) {
      sceneGroupInteractionState.selectGroup(canvas?.scene, result.selection.groupId);
    }
    return result;
  }

  async _execute(action) {
    return await this._workflow.execute({ scene: canvas?.scene, user: game?.user, action });
  }

  _removeSceneGroupSelection({memberUuids = [], groupIds = []}) {
    return this._run('removeFromSceneGroup', () => this._execute({type:'reparent-items',memberUuids,groupIds,parentGroupId:null}));
  }

  async _promptGroupName({
    initialName,
    title = 'Create Scene Group',
    acceptLabel = 'Create Group',
    acceptIcon = 'fa-solid fa-object-group',
    chooseAppearance = false
  } = {}) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) throw new Error('DialogV2.wait is unavailable for Scene Group naming.');
    const appearance=chooseAppearance?createSceneGroupAppearanceControl():null;
    const escapedName = foundry.utils.escapeHTML(normalizeIdentity(initialName));
    const result = await DialogV2.wait({
      window: { title },
      position: { width: 380, height: 'auto' },
      modal: true,
      content: `<div class="form-group"><label>Name</label><div class="form-fields"><input type="text" name="name" aria-label="Scene Group name" value="${escapedName}" autocomplete="off"></div></div>${appearance?.html||''}`,
      render:(_event,dialog)=>appearance?.bind(dialog.element),
      buttons: [
        {
          action: 'accept',
          label: acceptLabel,
          icon: acceptIcon,
          default: true,
          callback: (_event, _button, dialog) => normalizeIdentity(
            dialog?.element?.querySelector?.('input[name="name"]')?.value
          )
        },
        { action: 'cancel', label: 'Cancel', callback: () => false }
      ],
      close: () => null
    });
    if (result == null || result === false) return null;
    const name = normalizeIdentity(result);
    if (!name) throw new Error('Scene Group name is required.');
    return appearance?{name,...appearance.value}:name;
  }

  async _resolvePayloadDocumentTypes(payload) {
    const documentTypes = [];
    for (const uuid of payload.memberUuids) {
      const document = typeof globalThis.fromUuid === 'function'
        ? await globalThis.fromUuid(uuid)
        : globalThis.fromUuidSync?.(uuid);
      if (!document) throw new Error(`Cannot resolve Scene Group member for naming: ${uuid}.`);
      documentTypes.push(document.documentName);
    }
    return documentTypes;
  }

  async _resolveDropNamingIntent(payload) {
    if (payload.groupIds.length) return createGenericSceneGroupNameIntent();
    return createSceneGroupNameIntentForDocumentTypes(
      await this._resolvePayloadDocumentTypes(payload)
    );
  }

  async _createGroupFromDrop(payload, {
    namingIntent = null,
    parentGroupId,
    allowParentChange = false
  } = {}) {
    if (!game?.user?.isGM) throw new Error('Only a GM can create Scene Groups.');
    const resolvedNamingIntent = namingIntent || await this._resolveDropNamingIntent(payload);
    const prepareAction = {
      type: 'prepare-create-group',
      memberUuids: payload.memberUuids,
      groupIds: payload.groupIds,
      namingIntent: resolvedNamingIntent,
      allowParentChange
    };
    if (parentGroupId !== undefined) prepareAction.parentGroupId = parentGroupId;
    const prepared = await this._execute({
      ...prepareAction
    });
    const appearance = await this._promptGroupName({ initialName: prepared.proposedName, chooseAppearance:true });
    if (appearance == null) return false;
    const result = await this._execute({
      type: 'create-group',
      ...appearance,
      memberUuids: payload.memberUuids,
      groupIds: payload.groupIds,
      parentGroupId: prepared.parentGroupId,
      allowParentChange
    });
    sceneGroupInteractionState.selectGroup(canvas?.scene, result.group.id);
    ui?.notifications?.info?.(`Created Scene Group "${result.group.name}".`);
    return result;
  }

  async _createSubgroupFromSelection(memberUuids, parentGroupId) {
    if (!game?.user?.isGM) throw new Error('Only a GM can create Scene Groups.');
    const payload = {
      memberUuids: [...memberUuids],
      groupIds: [],
      source: 'groups-window'
    };
    return await this._createGroupFromDrop(payload, {
      parentGroupId,
      allowParentChange: false
    });
  }

  async _renameGroup(groupId) {
    const current = await this._execute({ type: 'read' });
    const group = current.projection.find((entry) => entry.id === groupId);
    if (!group) throw new Error(`Scene Group not found for Rename: ${groupId}.`);
    const name = await this._promptGroupName({
      initialName: group.name,
      title: `Rename ${group.name}`,
      acceptLabel: 'Rename',
      acceptIcon: 'fa-solid fa-i-cursor'
    });
    if (name == null) return false;
    const result = await this._execute({ type: 'rename-group', groupId, name });
    ui?.notifications?.info?.(`Renamed Scene Group to "${result.group.name}".`);
    return result;
  }

  async _deleteGroup(groupId) {
    return confirmDeleteSceneGroups({ scene: canvas.scene, groupIds: [groupId], workflow: this._workflow });
  }

  async _makeFillIndependent({ rootTileId, fillUuid, schemaVersion = null } = {}) {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Make Fill Independent?' },
      content: '<p>This preserves the current Fill Tile in place, but later Building commits will stop managing it. This action cannot be undone; choosing a Fill later creates a fresh managed Tile.</p>',
      modal: true,
      rejectClose: false
    });
    if (confirmed !== true) return false;
    const fillOwnership = [4, 5].includes(Number(schemaVersion))
      ? this._buildingV2FillOwnership
      : this._buildingFillOwnership;
    const result = await fillOwnership.makeFillIndependent({
      sceneId: canvas?.scene?.id,
      rootTileId,
      expectedFillUuid: normalizeIdentity(fillUuid)
    });
    if (result?.kind !== 'committed') {
      throw new Error(`Make Fill Independent is no longer available (${normalizeIdentity(result?.reason) || 'unknown reason'}).`);
    }
    ui?.notifications?.info?.('The Fill is now an ordinary Tile in the same Scene Group. Later Building commits will ignore it.');
    return result;
  }
}

let sceneGroupsWindow = null;

export function getSceneGroupsWindow() {
  return sceneGroupsWindow;
}

export async function openSceneGroupsWindow({ focus = true } = {}) {
  // A queued render on a closing instance would recreate its DOM after _onClose
  // has removed its hooks. Finish closing before constructing the next window.
  if (sceneGroupsWindow?._closingPromise) await sceneGroupsWindow._closingPromise;
  if (!sceneGroupsWindow) sceneGroupsWindow = new SceneGroupsWindow();
  const window = sceneGroupsWindow;
  await window.render({ force: true });
  if (focus) window.bringToFront?.();
  return window;
}
