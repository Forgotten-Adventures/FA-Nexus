import { sceneGroupIconClass, resolveSceneGroupIconColor } from './scene-group-icons.js';
import { isSceneGroupsEnabled } from '../core/feature-areas.js';

export const SCENE_GROUP_MEMBER_SELECTION_SETTING = 'sceneGroupMemberSelectionMode';

export const SCENE_GROUP_MEMBER_SELECTION_MODES = Object.freeze({
  INDIVIDUAL: 'individual',
  DIRECT_GROUP: 'direct-group',
  ROOT_GROUP: 'root-group'
});

export const SCENE_GROUP_MEMBER_SELECTION_DEFAULT = SCENE_GROUP_MEMBER_SELECTION_MODES.INDIVIDUAL;

export const SCENE_GROUP_MEMBER_SELECTION_OPTIONS = Object.freeze([
  Object.freeze({
    value: SCENE_GROUP_MEMBER_SELECTION_MODES.INDIVIDUAL,
    label: 'Individual',
    title: 'Select individual scene documents'
  }),
  Object.freeze({
    value: SCENE_GROUP_MEMBER_SELECTION_MODES.DIRECT_GROUP,
    label: 'Direct Group',
    title: 'Select the immediate owning Scene Group'
  }),
  Object.freeze({
    value: SCENE_GROUP_MEMBER_SELECTION_MODES.ROOT_GROUP,
    label: 'Root Group',
    title: 'Select the topmost owning Scene Group'
  })
]);

const VALID_MODES = new Set(Object.values(SCENE_GROUP_MEMBER_SELECTION_MODES));
const NATIVE_TILE_GROUP_MOVE_HANDLE = 'translate';
const NATIVE_TILE_GROUP_NOOP_HANDLES = new Set(['rotate', 'scale', 'scaleX', 'scaleY']);

function normalizeIdentity(value) {
  return String(value || '').trim();
}

export function normalizeSceneGroupMemberSelectionMode(value) {
  const mode = normalizeIdentity(value);
  return VALID_MODES.has(mode) ? mode : SCENE_GROUP_MEMBER_SELECTION_DEFAULT;
}

// The mode in effect: with Scene Groups switched off every layer is selected on its own, whatever the stored
// client setting says, so the groups of a Scene neither select nor move together.
export function readSceneGroupMemberSelectionMode() {
  if (!isSceneGroupsEnabled()) return SCENE_GROUP_MEMBER_SELECTION_MODES.INDIVIDUAL;
  return normalizeSceneGroupMemberSelectionMode(globalThis.game?.settings?.get?.('fa-nexus', SCENE_GROUP_MEMBER_SELECTION_SETTING));
}

export function isSceneGroupMemberSelectionBypassed(event = {}) {
  const button = event?.button == null ? 0 : Number(event.button);
  return button !== 0;
}

export function resolveSceneGroupMemberSelection({
  documentUuid,
  mode = SCENE_GROUP_MEMBER_SELECTION_DEFAULT,
  index,
  event = {}
} = {}) {
  const uuid = normalizeIdentity(documentUuid);
  if (!uuid) throw new Error('Scene Member Selection Mode requires a document UUID.');
  const normalizedMode = normalizeSceneGroupMemberSelectionMode(mode);
  if (normalizedMode === SCENE_GROUP_MEMBER_SELECTION_MODES.INDIVIDUAL
    || isSceneGroupMemberSelectionBypassed(event)) {
    return { kind: 'individual', documentUuid: uuid };
  }
  const owners = normalizedMode === SCENE_GROUP_MEMBER_SELECTION_MODES.ROOT_GROUP
    ? index?.rootOwnerByUuid
    : index?.directOwnerByUuid;
  const groupId = normalizeIdentity(owners?.get?.(uuid));
  return groupId
    ? { kind: 'group', groupId, documentUuid: uuid }
    : { kind: 'individual', documentUuid: uuid };
}

export function resolveSceneGroupMemberTileHandleGesture({
  documentUuid,
  handleName,
  mode = SCENE_GROUP_MEMBER_SELECTION_DEFAULT,
  index
} = {}) {
  const uuid = normalizeIdentity(documentUuid);
  const normalizedHandleName = normalizeIdentity(handleName);
  if (!uuid) throw new Error('Scene Member Tile handle routing requires a document UUID.');
  const selection = resolveSceneGroupMemberSelection({ documentUuid: uuid, mode, index });
  if (selection.kind !== 'group') {
    return { kind: 'individual', documentUuid: uuid, handleName: normalizedHandleName };
  }
  if (normalizedHandleName === NATIVE_TILE_GROUP_MOVE_HANDLE) {
    return {
      kind: 'group-move', groupId: selection.groupId, documentUuid: uuid, handleName: normalizedHandleName
    };
  }
  if (NATIVE_TILE_GROUP_NOOP_HANDLES.has(normalizedHandleName)) {
    return {
      kind: 'noop', groupId: selection.groupId, documentUuid: uuid, handleName: normalizedHandleName
    };
  }
  return { kind: 'individual', documentUuid: uuid, handleName: normalizedHandleName };
}

export function resolveSceneGroupMarqueeSelection({
  documentUuids = [],
  mode = SCENE_GROUP_MEMBER_SELECTION_DEFAULT,
  index
} = {}) {
  const groupIds = new Set();
  const individualUuids = new Set();
  for (const documentUuid of Array.isArray(documentUuids) ? documentUuids : []) {
    const selection = resolveSceneGroupMemberSelection({
      documentUuid,
      mode,
      index
    });
    if (selection.kind === 'group') groupIds.add(selection.groupId);
    else individualUuids.add(selection.documentUuid);
  }
  return {
    groupIds: [...groupIds],
    individualUuids: [...individualUuids]
  };
}

export function deriveSceneGroupMemberPresentation({
  documentUuid,
  mode = SCENE_GROUP_MEMBER_SELECTION_DEFAULT,
  index,
  selectedGroupIds = []
} = {}) {
  const uuid = normalizeIdentity(documentUuid);
  const directGroupId = normalizeIdentity(index?.directOwnerByUuid?.get?.(uuid)) || null;
  if (!directGroupId) {
    return {
      grouped: false,
      visible: false,
      iconClass: '',
      iconColor: '',
      directGroupId: null,
      directGroupName: null,
      rootGroupId: null,
      rootGroupName: null,
      tooltip: '',
      selectedGroupMember: false
    };
  }
  const rootGroupId = normalizeIdentity(index?.rootOwnerByUuid?.get?.(uuid)) || directGroupId;
  const directGroupName = normalizeIdentity(index?.groupsById?.get?.(directGroupId)?.name) || directGroupId;
  const rootGroupName = normalizeIdentity(index?.groupsById?.get?.(rootGroupId)?.name) || rootGroupId;
  const normalizedMode = normalizeSceneGroupMemberSelectionMode(mode);
  const visible = normalizedMode !== SCENE_GROUP_MEMBER_SELECTION_MODES.INDIVIDUAL;
  const shownGroupId = normalizedMode === SCENE_GROUP_MEMBER_SELECTION_MODES.ROOT_GROUP ? rootGroupId : directGroupId;
  const selectedGroupMember = visible && (Array.isArray(selectedGroupIds) ? selectedGroupIds : [])
    .some((groupId) => index?.effectiveMemberUuidsByGroupId?.get?.(normalizeIdentity(groupId))?.has?.(uuid));
  return {
    grouped: true,
    visible,
    iconClass: visible ? sceneGroupIconClass(index?.groupsById?.get?.(shownGroupId)?.icon) : '',
    iconColor: visible ? resolveSceneGroupIconColor(shownGroupId, index?.groupsById) : '',
    directGroupId,
    directGroupName,
    rootGroupId,
    rootGroupName,
    tooltip: !visible ? '' : directGroupId === rootGroupId
      ? `Group: ${directGroupName}`
      : normalizedMode === SCENE_GROUP_MEMBER_SELECTION_MODES.ROOT_GROUP
        ? `Root group: ${rootGroupName}\nDirect group: ${directGroupName}`
        : `Direct group: ${directGroupName}\nRoot group: ${rootGroupName}`,
    selectedGroupMember
  };
}

export function buildSceneGroupMemberSelectionControl(mode) {
  const selectedMode = normalizeSceneGroupMemberSelectionMode(mode);
  return {
    mode: selectedMode,
    options: SCENE_GROUP_MEMBER_SELECTION_OPTIONS.map((option) => ({
      ...option,
      active: option.value === selectedMode
    }))
  };
}

// Generated outputs are represented by their selected Tile generator when
// choosing a navigation layer. Attached and independently authored members
// remain distinct, so a Building with an attached Light is still mixed.
export function resolveSceneGroupNavigationMembers(documents, index) {
  const byUuid = new Map(documents.map(document => [document?.uuid, document]));
  return documents.filter(document => {
    let uuid = document?.uuid;
    const visited = new Set();
    while (uuid && !visited.has(uuid)) {
      visited.add(uuid);
      const relationship = index?.relationshipByDependentUuid?.get(uuid);
      if (relationship?.type !== 'generated-by') break;
      const owner = byUuid.get(relationship.ownerUuid);
      if (!owner) break;
      if (owner.documentName === 'Tile') return false;
      uuid = owner.uuid;
    }
    return true;
  });
}
