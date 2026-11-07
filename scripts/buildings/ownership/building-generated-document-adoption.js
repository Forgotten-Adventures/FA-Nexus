function normalizeIdentity(value) {
  return String(value || '').trim();
}

function uniqueIdentities(values = []) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : []).map(normalizeIdentity).filter(Boolean)
  ));
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof globalThis.structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function planBuildingGeneratedDocumentAdoption({
  registry,
  ownerUuid,
  dependentUuids = [],
  previousDependentUuids = [],
  reconciledOwnerUuids = []
} = {}) {
  const owner = normalizeIdentity(ownerUuid);
  const dependents = uniqueIdentities(dependentUuids);
  const previousDependents = uniqueIdentities(previousDependentUuids);
  const reconciledOwners = new Set(uniqueIdentities(reconciledOwnerUuids));
  const nextRegistry = clone(registry || {});
  nextRegistry.groups = nextRegistry.groups && typeof nextRegistry.groups === 'object'
    ? nextRegistry.groups
    : {};
  nextRegistry.relationships = Array.isArray(nextRegistry.relationships)
    ? nextRegistry.relationships
    : [];

  for (const relationship of nextRegistry.relationships) {
    const dependentUuid = normalizeIdentity(relationship?.dependentUuid);
    if (!dependents.includes(dependentUuid)) continue;
    const existingOwnerUuid = normalizeIdentity(relationship?.ownerUuid);
    if (existingOwnerUuid && existingOwnerUuid !== owner && !reconciledOwners.has(existingOwnerUuid)) {
      throw new Error(`Building generated dependent ${dependentUuid} already belongs to composition owner ${existingOwnerUuid}.`);
    }
  }

  const ownerGroup = Object.values(nextRegistry.groups).find((group) => (
    Array.isArray(group?.directMemberUuids)
    && group.directMemberUuids.some((uuid) => normalizeIdentity(uuid) === owner)
  )) || null;
  const generatedSet = new Set(dependents);
  const previousSet = new Set(previousDependents);
  for (const group of Object.values(nextRegistry.groups)) {
    const directMemberUuids = Array.isArray(group?.directMemberUuids) ? group.directMemberUuids : [];
    group.directMemberUuids = directMemberUuids.filter((uuid) => {
      const normalized = normalizeIdentity(uuid);
      return !generatedSet.has(normalized) && !previousSet.has(normalized);
    });
  }
  let prunedGroup = true;
  while (prunedGroup) {
    prunedGroup = false;
    const parentIds = new Set(Object.values(nextRegistry.groups)
      .map((group) => normalizeIdentity(group?.parentId))
      .filter(Boolean));
    for (const [groupId, group] of Object.entries(nextRegistry.groups)) {
      if ((group?.directMemberUuids || []).length || parentIds.has(normalizeIdentity(groupId))) continue;
      delete nextRegistry.groups[groupId];
      prunedGroup = true;
    }
  }

  nextRegistry.relationships = nextRegistry.relationships.filter((relationship) => {
    if (
      normalizeIdentity(relationship?.type) !== 'generated-by'
      || normalizeIdentity(relationship?.generator) !== 'building'
    ) return true;
    const relationshipOwner = normalizeIdentity(relationship?.ownerUuid);
    const relationshipDependent = normalizeIdentity(relationship?.dependentUuid);
    return relationshipOwner !== owner
      && !(generatedSet.has(relationshipDependent) && reconciledOwners.has(relationshipOwner))
      && !(previousSet.has(relationshipDependent) && reconciledOwners.has(relationshipOwner));
  });
  nextRegistry.relationships.push(...dependents.map((dependentUuid) => ({
    id: `generated-by:${owner}:${dependentUuid}`,
    type: 'generated-by',
    ownerUuid: owner,
    dependentUuid,
    generator: 'building'
  })));
  return {
    registry: nextRegistry,
    groupId: normalizeIdentity(ownerGroup?.id) || null
  };
}
