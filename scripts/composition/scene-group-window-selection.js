import { sceneGroupIconClass } from './scene-group-icons.js';

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function uniqueIdentities(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeIdentity)
    .filter(Boolean))];
}

function orderSelection(selectedIds, visibleIds) {
  const selected = new Set(uniqueIdentities(selectedIds));
  const ordered = uniqueIdentities(visibleIds).filter((id) => selected.delete(id));
  return [...ordered, ...selected];
}

export function planSceneGroupMemberPresentation({
  members = [],
  pathStructureExpanded = true,
  pathWallsExpanded = false,
  buildingStructureExpanded = true,
  buildingWallsExpanded = false,
  collapsedStructureUuids = new Set(),
  expandedWallOwnerUuids = new Set()
} = {}) {
  const entries = Array.isArray(members) ? members : [];
  const buildingRelationships = entries.filter((member) => (
    normalizeIdentity(member?.relationshipType) === 'generated-by'
    && ['building', 'flatten'].includes(normalizeIdentity(member?.generator))
  ));
  const buildingOwnerUuids = uniqueIdentities(buildingRelationships.map((member) => member?.ownerUuid));
  const consumedUuids = new Set();
  const buildingStructures = buildingOwnerUuids.flatMap((ownerUuid) => {
    const anchor = entries.find((member) => (
      member?.direct === true && normalizeIdentity(member?.uuid) === ownerUuid
    )) || null;
    if (!anchor) return [];
    const relationships = buildingRelationships.filter((member) => (
      normalizeIdentity(member?.ownerUuid) === ownerUuid
    ));
    consumedUuids.add(ownerUuid);
    for (const member of relationships) consumedUuids.add(normalizeIdentity(member?.uuid));
    const walls = relationships.filter((member) => normalizeIdentity(member?.documentName) === 'Wall');
    const wallUuids = new Set(walls.map((member) => normalizeIdentity(member?.uuid)));
    return [{
      ownerUuid,
      kind: relationships[0]?.generator === 'flatten' ? 'flatten' : 'building',
      label: anchor.name || 'Building Structure',
      expanded: buildingStructureExpanded !== false && !collapsedStructureUuids.has(ownerUuid),
      anchor,
      generatedMembers: relationships.filter((member) => !wallUuids.has(normalizeIdentity(member?.uuid))),
      wallCollection: walls.length
        ? { expanded: buildingWallsExpanded === true || expandedWallOwnerUuids.has(ownerUuid), members: walls }
        : null
    }];
  });
  const pathRelationships = entries.filter((member) => (
    normalizeIdentity(member?.relationshipType) === 'generated-by'
    && normalizeIdentity(member?.generator) === 'path-v2'
  ));
  const ownerUuids = uniqueIdentities(pathRelationships.map((member) => member?.ownerUuid));
  const pathStructures = [];
  for (const ownerUuid of ownerUuids) {
    const anchor = entries.find((member) => (
      member?.direct === true && normalizeIdentity(member?.uuid) === ownerUuid
    )) || null;
    if (anchor) {
      const relationships = pathRelationships.filter((member) => normalizeIdentity(member.ownerUuid) === ownerUuid);
      consumedUuids.add(ownerUuid);
      for (const member of relationships) consumedUuids.add(normalizeIdentity(member?.uuid));
      const walls = relationships.filter((member) => normalizeIdentity(member?.documentName) === 'Wall');
      const wallUuids = new Set(walls.map((member) => normalizeIdentity(member?.uuid)));
      const generatedMembers = relationships.filter((member) => !wallUuids.has(normalizeIdentity(member?.uuid)));
      const wallCollection = walls.length > 1
        ? { expanded: pathWallsExpanded === true || expandedWallOwnerUuids.has(ownerUuid), members: walls }
        : null;
      if (!wallCollection) generatedMembers.push(...walls);
      pathStructures.push({
        ownerUuid,
        kind: 'path',
        label: anchor.name || 'Path Structure',
        expanded: pathStructureExpanded !== false && !collapsedStructureUuids.has(ownerUuid),
        anchor,
        generatedMembers,
        wallCollection
      });
    }
  }
  const ordinaryMembers = entries.filter((member) => !consumedUuids.has(normalizeIdentity(member?.uuid)));
  return {
    ordinaryMembers,
    pathStructure: pathStructures.length === 1 ? pathStructures[0] : null,
    pathStructures,
    structures: [...buildingStructures, ...pathStructures].map((structure) => {
      const members = [structure.anchor, ...structure.generatedMembers, ...(structure.wallCollection?.members || [])];
      const hidden = members.every((member) => member.hidden);
      const locked = members.every((member) => member.locked);
      return { ...structure, selected: structure.anchor.selected,
        icon: sceneGroupIconClass(structure.anchor.groupIcon, structure.kind === 'flatten' ? 'fa-layer-group' : structure.kind === 'building' ? 'fa-building' : 'fa-route'),
        locked,
        typeLabel: structure.kind === 'flatten' ? 'Flattened picture' : structure.kind === 'building' ? 'Building' : 'Path',
        visibilityAction: hidden ? 'show-structure' : 'hide-structure',
        visibilityIcon: hidden ? 'fa-eye-slash' : 'fa-eye',
        canLock: members.every((member) => member.supportsLock === true),
        lockAction: locked ? 'unlock-structure' : 'lock-structure',
        lockIcon: locked ? 'fa-lock' : 'fa-lock-open' };
    }),
    buildingStructures,
    buildingStructure: buildingStructures.length === 1 ? buildingStructures[0] : null
  };
}

export function planSceneGroupWindowRows({
  projection = [],
  collapsedGroupIds = []
} = {}) {
  const rows = Array.isArray(projection) ? projection : [];
  const byId = new Map(rows.map((row) => [normalizeIdentity(row?.id), row]));
  const collapsed = new Set(uniqueIdentities(collapsedGroupIds));
  const hiddenByCollapsedAncestor = (row) => {
    const visited = new Set();
    let parentId = normalizeIdentity(row?.parentId);
    while (parentId) {
      if (visited.has(parentId)) {
        throw new Error(`Scene Group disclosure ancestry contains a cycle at ${parentId}.`);
      }
      visited.add(parentId);
      if (collapsed.has(parentId)) return true;
      parentId = normalizeIdentity(byId.get(parentId)?.parentId);
    }
    return false;
  };

  return rows
    .filter((row) => !hiddenByCollapsedAncestor(row))
    .map((row) => {
      const id = normalizeIdentity(row?.id);
      const expanded = !collapsed.has(id);
      return {
        ...row,
        expanded,
        showDirectMembers: expanded && (Array.isArray(row?.members) ? row.members.length > 0 : false)
      };
    });
}

export function planSceneGroupWindowSelection({
  id,
  visibleIds = [],
  selectedIds = [],
  anchorId = null,
  ctrlKey = false,
  shiftKey = false
} = {}) {
  const targetId = normalizeIdentity(id);
  const visible = uniqueIdentities(visibleIds);
  if (!targetId || !visible.includes(targetId)) {
    throw new Error(`Scene Group window selection target is not visible: ${targetId || 'missing'}.`);
  }

  const selected = new Set(uniqueIdentities(selectedIds));
  const normalizedAnchorId = normalizeIdentity(anchorId);
  if (!shiftKey) {
    if (ctrlKey) {
      if (selected.has(targetId)) selected.delete(targetId);
      else selected.add(targetId);
      return {
        selectedIds: orderSelection([...selected], visible),
        anchorId: targetId
      };
    }
    return { selectedIds: [targetId], anchorId: targetId };
  }

  const rangeAnchorId = visible.includes(normalizedAnchorId) ? normalizedAnchorId : targetId;
  const anchorIndex = visible.indexOf(rangeAnchorId);
  const targetIndex = visible.indexOf(targetId);
  const range = visible.slice(
    Math.min(anchorIndex, targetIndex),
    Math.max(anchorIndex, targetIndex) + 1
  );
  const nextSelected = ctrlKey ? new Set([...selected, ...range]) : new Set(range);
  return {
    selectedIds: orderSelection([...nextSelected], visible),
    anchorId: rangeAnchorId
  };
}

export function planSceneGroupContextSelection({
  id,
  selectedIds = [],
  anchorId = null
} = {}) {
  const targetId = normalizeIdentity(id);
  if (!targetId) throw new Error('Scene Group context selection requires a row identity.');
  const selected = uniqueIdentities(selectedIds);
  if (selected.includes(targetId)) {
    return {
      selectedIds: selected,
      anchorId: normalizeIdentity(anchorId) || targetId
    };
  }
  return { selectedIds: [targetId], anchorId: targetId };
}

export function resolveCreateSubgroupEligibility({
  selectedMemberUuids = [],
  directParentByMemberUuid = new Map()
} = {}) {
  const memberUuids = uniqueIdentities(selectedMemberUuids);
  if (!memberUuids.length) {
    return {
      allowed: false,
      parentGroupId: null,
      reason: 'Create Subgroup requires at least one selected member row.'
    };
  }
  const parentIds = new Set();
  for (const uuid of memberUuids) {
    const parentId = normalizeIdentity(directParentByMemberUuid?.get?.(uuid));
    if (!parentId) {
      return {
        allowed: false,
        parentGroupId: null,
        reason: 'Create Subgroup requires member rows with the same direct parent.'
      };
    }
    parentIds.add(parentId);
  }
  if (parentIds.size !== 1) {
    return {
      allowed: false,
      parentGroupId: null,
      reason: 'Create Subgroup requires member rows with the same direct parent.'
    };
  }
  return {
    allowed: true,
    parentGroupId: parentIds.values().next().value,
    reason: null
  };
}

export function planSceneGroupWindowDrop({
  targetMode,
  parentGroupId = null,
  source = '',
  memberUuids = [],
  groupIds = [],
  documentTypes = []
} = {}) {
  const mode = normalizeIdentity(targetMode);
  const normalizedParentId = normalizeIdentity(parentGroupId) || null;
  const normalizedSource = normalizeIdentity(source);
  const members = uniqueIdentities(memberUuids);
  const groups = uniqueIdentities(groupIds);
  const types = uniqueIdentities(documentTypes);
  if (!members.length && !groups.length) {
    throw new Error('Scene Group drop planning requires documents or groups.');
  }
  if (mode === 'create') {
    if (normalizedSource === 'groups-window' && members.length) {
      throw new Error('Use Create Subgroup to form a child group from Groups-window member rows.');
    }
    return {
      operation: 'create-group',
      parentGroupId: null,
      allowParentChange: members.length > 0
    };
  }
  if (mode === 'root') {
    return {
      operation: 'reparent-items',
      parentGroupId: null,
      allowParentChange: false
    };
  }
  if (mode !== 'parent' || !normalizedParentId) {
    throw new Error(`Unsupported Scene Group drop target: ${mode || 'missing'}.`);
  }
  const homogeneousExternalMembers = ['layer-manager', 'foundry-placeables'].includes(normalizedSource)
    && members.length >= 2
    && types.length === 1;
  return {
    operation: homogeneousExternalMembers ? 'create-group' : 'reparent-items',
    parentGroupId: normalizedParentId,
    allowParentChange: homogeneousExternalMembers
  };
}
