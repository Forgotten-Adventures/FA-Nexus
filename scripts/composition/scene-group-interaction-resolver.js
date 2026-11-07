export const SCENE_GROUP_INTERACTION_DOCUMENT_TYPES = Object.freeze([
  'Tile',
  'Wall',
  'AmbientLight',
  'AmbientSound',
  'Region'
]);

const SUPPORTED_TYPES = new Set(SCENE_GROUP_INTERACTION_DOCUMENT_TYPES);
let cachedScene = null;
let cachedRegistry = null;
let cachedIndex = null;

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function documentType(document) {
  return normalizeIdentity(document?.documentName || document?.constructor?.metadata?.name);
}

function readRegistry(scene) {
  return scene?.getFlag?.('fa-nexus', 'compositionRegistry') || { groups: {} };
}

function buildIndex(registry) {
  const groupsById = new Map();
  const directOwnerByUuid = new Map();
  for (const [registryId, source] of Object.entries(registry?.groups || {})) {
    const id = normalizeIdentity(source?.id || registryId);
    if (!id || id !== registryId) throw new Error(`Invalid Scene Group identity: ${registryId || 'missing'}.`);
    const parentId = source?.parentId == null ? null : normalizeIdentity(source.parentId);
    const directMemberUuids = Array.isArray(source?.directMemberUuids)
      ? source.directMemberUuids.map(normalizeIdentity).filter(Boolean)
      : null;
    if (directMemberUuids == null) throw new Error(`Scene Group ${id} has invalid direct members.`);
    groupsById.set(id, {
      id,
      name: normalizeIdentity(source?.name) || id,
      icon: source?.icon || '',
      iconColor: source?.iconColor || '',
      parentId,
      directMemberUuids
    });
    for (const uuid of directMemberUuids) {
      if (directOwnerByUuid.has(uuid)) {
        throw new Error(`Scene document ${uuid} belongs directly to more than one Scene Group.`);
      }
      directOwnerByUuid.set(uuid, id);
    }
  }

  const childrenByParent = new Map();
  for (const group of groupsById.values()) {
    if (group.parentId && !groupsById.has(group.parentId)) {
      throw new Error(`Scene Group ${group.id} references missing parent ${group.parentId}.`);
    }
    const parentKey = group.parentId || null;
    const children = childrenByParent.get(parentKey) || [];
    children.push(group.id);
    childrenByParent.set(parentKey, children);
  }

  const effectiveMemberUuidsByGroupId = new Map();
  const collectEffective = (groupId, ancestry = new Set()) => {
    if (effectiveMemberUuidsByGroupId.has(groupId)) return effectiveMemberUuidsByGroupId.get(groupId);
    if (ancestry.has(groupId)) throw new Error(`Scene Group descendants contain a cycle at ${groupId}.`);
    const nextAncestry = new Set(ancestry).add(groupId);
    const group = groupsById.get(groupId);
    const members = new Set(group?.directMemberUuids || []);
    for (const childId of childrenByParent.get(groupId) || []) {
      for (const uuid of collectEffective(childId, nextAncestry)) members.add(uuid);
    }
    effectiveMemberUuidsByGroupId.set(groupId, members);
    return members;
  };
  for (const groupId of groupsById.keys()) collectEffective(groupId);

  const relationshipByDependentUuid = new Map();
  const relationshipsByOwnerUuid = new Map();
  const relationshipIds = new Set();
  for (const relationship of Array.isArray(registry?.relationships) ? registry.relationships : []) {
    const id = normalizeIdentity(relationship?.id);
    const ownerUuid = normalizeIdentity(relationship?.ownerUuid);
    const dependentUuid = normalizeIdentity(relationship?.dependentUuid);
    const type = normalizeIdentity(relationship?.type);
    if (!id || !ownerUuid || !dependentUuid || !['attached-to', 'generated-by'].includes(type)) {
      throw new Error(`Invalid composition relationship: ${id || 'missing'}.`);
    }
    if (relationshipIds.has(id)) throw new Error(`Duplicate composition relationship: ${id}.`);
    if (relationshipByDependentUuid.has(dependentUuid)) {
      throw new Error(`Scene document ${dependentUuid} has more than one composition owner.`);
    }
    if (directOwnerByUuid.has(dependentUuid)) {
      throw new Error(`Relationship-dependent ${dependentUuid} is also a direct Scene Group member.`);
    }
    relationshipIds.add(id);
    relationshipByDependentUuid.set(dependentUuid, relationship);
    const children = relationshipsByOwnerUuid.get(ownerUuid) || [];
    children.push(relationship);
    relationshipsByOwnerUuid.set(ownerUuid, children);
  }

  const compositionRootByUuid = new Map();
  const resolveCompositionRoot = (uuid, ancestry = new Set()) => {
    if (compositionRootByUuid.has(uuid)) return compositionRootByUuid.get(uuid);
    if (ancestry.has(uuid)) throw new Error(`Composition relationships contain a cycle at ${uuid}.`);
    const relationship = relationshipByDependentUuid.get(uuid);
    const rootUuid = relationship
      ? resolveCompositionRoot(normalizeIdentity(relationship.ownerUuid), new Set(ancestry).add(uuid))
      : uuid;
    compositionRootByUuid.set(uuid, rootUuid);
    return rootUuid;
  };
  for (const dependentUuid of relationshipByDependentUuid.keys()) {
    const rootUuid = resolveCompositionRoot(dependentUuid);
    const groupId = directOwnerByUuid.get(rootUuid);
    if (groupId) directOwnerByUuid.set(dependentUuid, groupId);
  }

  const appendRelationshipDescendants = (members, ownerUuid, ancestry = new Set()) => {
    if (ancestry.has(ownerUuid)) throw new Error(`Composition relationships contain a cycle at ${ownerUuid}.`);
    const nextAncestry = new Set(ancestry).add(ownerUuid);
    for (const relationship of relationshipsByOwnerUuid.get(ownerUuid) || []) {
      const dependentUuid = normalizeIdentity(relationship.dependentUuid);
      members.add(dependentUuid);
      appendRelationshipDescendants(members, dependentUuid, nextAncestry);
    }
  };
  for (const members of effectiveMemberUuidsByGroupId.values()) {
    for (const uuid of [...members]) appendRelationshipDescendants(members, uuid);
  }

  const rootOwnerByUuid = new Map();
  for (const [uuid, directGroupId] of directOwnerByUuid) {
    let rootGroupId = directGroupId;
    const ancestry = new Set();
    while (groupsById.get(rootGroupId)?.parentId) {
      if (ancestry.has(rootGroupId)) {
        throw new Error(`Scene Group ancestors contain a cycle at ${rootGroupId}.`);
      }
      ancestry.add(rootGroupId);
      rootGroupId = groupsById.get(rootGroupId).parentId;
    }
    rootOwnerByUuid.set(uuid, rootGroupId);
  }

  return {
    groupsById,
    directOwnerByUuid,
    rootOwnerByUuid,
    childrenByParent,
    effectiveMemberUuidsByGroupId,
    relationshipByDependentUuid,
    relationshipsByOwnerUuid,
    compositionRootByUuid
  };
}

export function invalidateSceneGroupInteractionIndex() {
  cachedScene = null;
  cachedRegistry = null;
  cachedIndex = null;
}

export function getSceneGroupInteractionIndex(scene = globalThis.canvas?.scene, registry = null) {
  const currentRegistry = registry || readRegistry(scene);
  if (cachedScene === scene && cachedRegistry === currentRegistry && cachedIndex) return cachedIndex;
  const index = buildIndex(currentRegistry);
  cachedScene = scene;
  cachedRegistry = currentRegistry;
  cachedIndex = index;
  return index;
}

export function isSceneGroupInteractionDocument(document) {
  return !!document && SUPPORTED_TYPES.has(documentType(document));
}

export function getSelectedSceneGroupMemberUuids(scene, interactionState, registry = null) {
  const index = getSceneGroupInteractionIndex(scene, registry);
  const selected = new Set();
  for (const groupId of interactionState?.selectedGroupIds || []) {
    for (const uuid of index.effectiveMemberUuidsByGroupId.get(groupId) || []) selected.add(uuid);
  }
  return selected;
}
