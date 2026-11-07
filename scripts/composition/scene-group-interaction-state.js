import { sceneGroupViewState } from './scene-group-view-state.js';
export const SCENE_GROUP_INTERACTION_HOOK = 'fa-nexus-scene-group-interaction-changed';

function normalizeIdentity(value) {
  return String(value || '').trim();
}

class SceneGroupInteractionState {
  constructor() {
    this._sceneId = null;
    this._selectedGroupIds = new Set();
    this._selectedMemberUuids = new Set();
    this._groupIds = new Set();
    this._groupSelectionAnchorId = null;
    this._memberSelectionAnchorUuid = null;
    this._primaryGroupId = null;
  }

  _syncScene(scene) {
    const sceneId = normalizeIdentity(scene?.id);
    if (sceneId === this._sceneId) return;
    this._sceneId = sceneId || null;
    this._selectedGroupIds.clear();
    this._selectedMemberUuids.clear();
    this._groupIds.clear();
    this._groupSelectionAnchorId = null;
    this._memberSelectionAnchorUuid = null;
    this._primaryGroupId = null;
  }

  _publish(reason) {
    Hooks.callAll(SCENE_GROUP_INTERACTION_HOOK, this.snapshot(), reason);
  }

  snapshot(scene = canvas?.scene) {
    this._syncScene(scene);
    return {
      sceneId: this._sceneId,
      selectedGroupIds: [...this._selectedGroupIds],
      selectedMemberUuids: [...this._selectedMemberUuids],
      collapsedGroupIds: [...this._groupIds].filter(id => !sceneGroupViewState.expanded(scene, 'groups', id)),
      groupSelectionAnchorId: this._groupSelectionAnchorId,
      memberSelectionAnchorUuid: this._memberSelectionAnchorUuid,
      primaryGroupId: this._primaryGroupId
    };
  }

  reconcile(scene, projection = []) {
    this._syncScene(scene);
    const groupIds = new Set(projection.map((row) => normalizeIdentity(row?.id)).filter(Boolean));
    const memberUuids = new Set(projection.flatMap((row) => (
      Array.isArray(row?.members) ? row.members.map((member) => normalizeIdentity(member?.uuid)) : []
    )).filter(Boolean));
    for (const groupId of [...this._selectedGroupIds]) {
      if (!groupIds.has(groupId)) this._selectedGroupIds.delete(groupId);
    }
    for (const uuid of [...this._selectedMemberUuids]) {
      if (!memberUuids.has(uuid)) this._selectedMemberUuids.delete(uuid);
    }
    this._groupIds = groupIds;
    if (!groupIds.has(this._groupSelectionAnchorId)) {
      this._groupSelectionAnchorId = this._selectedGroupIds.values().next().value || null;
    }
    if (!memberUuids.has(this._memberSelectionAnchorUuid)) {
      this._memberSelectionAnchorUuid = this._selectedMemberUuids.values().next().value || null;
    }
    if (!groupIds.has(this._primaryGroupId)) {
      this._primaryGroupId = this._selectedGroupIds.values().next().value || null;
    }
    return this.snapshot(scene);
  }

  selectGroup(scene, groupId, { retain = false, toggle = false } = {}) {
    this._syncScene(scene);
    const id = normalizeIdentity(groupId);
    if (!id) throw new Error('Scene Group selection requires a group identity.');
    if (!retain) {
      this._selectedGroupIds.clear();
    }
    this._selectedMemberUuids.clear();
    this._memberSelectionAnchorUuid = null;
    if (toggle && this._selectedGroupIds.has(id)) this._selectedGroupIds.delete(id);
    else this._selectedGroupIds.add(id);
    this._groupSelectionAnchorId = id;
    this._primaryGroupId = this._selectedGroupIds.has(id)
      ? id
      : this._selectedGroupIds.values().next().value || null;
    this._publish('select-group');
    return this.snapshot(scene);
  }

  selectGroups(scene, groupIds, {
    retain = false,
    anchorId = null,
    primaryGroupId = null
  } = {}) {
    this._syncScene(scene);
    const ids = [...new Set((Array.isArray(groupIds) ? groupIds : [])
      .map(normalizeIdentity)
      .filter(Boolean))];
    if (!retain) this._selectedGroupIds.clear();
    this._selectedMemberUuids.clear();
    this._memberSelectionAnchorUuid = null;
    for (const id of ids) this._selectedGroupIds.add(id);
    this._groupSelectionAnchorId = normalizeIdentity(anchorId) || ids.at(-1) || null;
    const requestedPrimaryId = normalizeIdentity(primaryGroupId);
    this._primaryGroupId = requestedPrimaryId && this._selectedGroupIds.has(requestedPrimaryId)
      ? requestedPrimaryId
      : ids.at(-1) || this._selectedGroupIds.values().next().value || null;
    this._publish('select-groups');
    return this.snapshot(scene);
  }

  selectMember(scene, uuid, { retain = false, toggle = false } = {}) {
    this._syncScene(scene);
    const id = normalizeIdentity(uuid);
    if (!id) throw new Error('Scene Group member selection requires a document UUID.');
    if (!retain) {
      this._selectedMemberUuids.clear();
    }
    this._selectedGroupIds.clear();
    this._groupSelectionAnchorId = null;
    this._primaryGroupId = null;
    if (toggle && this._selectedMemberUuids.has(id)) this._selectedMemberUuids.delete(id);
    else this._selectedMemberUuids.add(id);
    this._memberSelectionAnchorUuid = id;
    this._publish('select-member');
    return this.snapshot(scene);
  }

  selectMembers(scene, uuids, { retain = false, anchorUuid = null } = {}) {
    this._syncScene(scene);
    const ids = [...new Set((Array.isArray(uuids) ? uuids : [])
      .map(normalizeIdentity)
      .filter(Boolean))];
    if (!retain) this._selectedMemberUuids.clear();
    this._selectedGroupIds.clear();
    this._groupSelectionAnchorId = null;
    this._primaryGroupId = null;
    for (const id of ids) this._selectedMemberUuids.add(id);
    this._memberSelectionAnchorUuid = normalizeIdentity(anchorUuid) || ids.at(-1) || null;
    this._publish('select-members');
    return this.snapshot(scene);
  }

  discardMember(scene, uuid, reason = 'discard-member') {
    this._syncScene(scene);
    const id = normalizeIdentity(uuid);
    if (!id || !this._selectedMemberUuids.delete(id)) return this.snapshot(scene);
    if (this._memberSelectionAnchorUuid === id) {
      this._memberSelectionAnchorUuid = this._selectedMemberUuids.values().next().value || null;
    }
    this._publish(reason);
    return this.snapshot(scene);
  }

  toggleGroupDisclosure(scene, groupId) {
    this._syncScene(scene);
    const id = normalizeIdentity(groupId);
    if (!id) throw new Error('Scene Group tree disclosure requires a group identity.');
    sceneGroupViewState.toggle(scene, 'groups', id);
    this._publish('toggle-group-disclosure');
    return this.snapshot(scene);
  }

  setGroupsCollapsed(scene, groupIds, collapsed) {
    this._syncScene(scene);
    for (const groupId of groupIds) {
      const id = normalizeIdentity(groupId);
      if (!id) throw new Error('Scene Group tree disclosure requires a group identity.');
    }
    sceneGroupViewState.setExpanded(scene, 'groups', groupIds, !collapsed);
    this._publish('set-group-disclosures');
    return this.snapshot(scene);
  }

  revealGroups(scene, groupIds, projection) {
    this._syncScene(scene);
    const byId = new Map(projection.map((row) => [row.id, row]));
    const ancestors = new Set();
    for (const id of groupIds) {
      let parent = byId.get(id)?.parentId;
      while (parent) {
        ancestors.add(parent);
        parent = byId.get(parent)?.parentId;
      }
    }
    const closed = [...ancestors].filter(id => !sceneGroupViewState.expanded(scene, 'groups', id));
    if (closed.length) sceneGroupViewState.setExpanded(scene, 'groups', closed, true);
    return this.snapshot(scene);
  }

  discardGroup(scene, groupId, reason = 'discard-group') {
    this._syncScene(scene);
    const id = normalizeIdentity(groupId);
    if (!id) return this.snapshot(scene);
    const changed = this._selectedGroupIds.delete(id);
    this._groupIds.delete(id);
    if (this._groupSelectionAnchorId === id) {
      this._groupSelectionAnchorId = this._selectedGroupIds.values().next().value || null;
    }
    if (this._primaryGroupId === id) {
      this._primaryGroupId = this._selectedGroupIds.values().next().value || null;
    }
    if (changed) this._publish(reason);
    return this.snapshot(scene);
  }

  clear(scene, reason = 'clear') {
    this._syncScene(scene);
    this._selectedGroupIds.clear();
    this._selectedMemberUuids.clear();
    this._groupSelectionAnchorId = null;
    this._memberSelectionAnchorUuid = null;
    this._primaryGroupId = null;
    this._publish(reason);
    return this.snapshot(scene);
  }

  reset(scene, reason = 'reset') {
    this._syncScene(scene);
    this._selectedGroupIds.clear();
    this._selectedMemberUuids.clear();
    this._groupSelectionAnchorId = null;
    this._memberSelectionAnchorUuid = null;
    this._primaryGroupId = null;
    this._publish(reason);
    return this.snapshot(scene);
  }
}

export const sceneGroupInteractionState = new SceneGroupInteractionState();
