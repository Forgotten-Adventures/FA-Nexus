function normalizeIdentity(value) {
  return String(value || '').trim();
}

function normalizeIdentities(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizeIdentity)
      .filter(Boolean)
  ));
}

function clone(value) {
  return globalThis.structuredClone(value);
}

export class SceneGroupGeneratedMemberReplacementError extends Error {
  constructor(code, stage, { identities = [], message = null } = {}) {
    super(message || code);
    this.name = 'SceneGroupGeneratedMemberReplacementError';
    this.code = code;
    this.stage = stage;
    this.identities = normalizeIdentities(identities);
  }
}

export function planSceneGroupGeneratedMemberReplacement({
  registry,
  previousMemberUuids = [],
  nextMemberUuids = []
} = {}) {
  const previousUuids = normalizeIdentities(previousMemberUuids);
  const nextUuids = normalizeIdentities(nextMemberUuids);
  if (!previousUuids.length) {
    throw new SceneGroupGeneratedMemberReplacementError(
      'previous-generated-members-required',
      'validate-input'
    );
  }

  const nextRegistry = clone(registry);
  const previousSet = new Set(previousUuids);
  const affectedGroups = Object.values(nextRegistry.groups || {}).filter((group) => (
    Array.isArray(group?.directMemberUuids)
    && group.directMemberUuids.some((uuid) => previousSet.has(normalizeIdentity(uuid)))
  ));
  if (!affectedGroups.length) {
    return { registry: nextRegistry, changed: false, groupId: null };
  }
  if (affectedGroups.length !== 1) {
    throw new SceneGroupGeneratedMemberReplacementError(
      'generated-member-replacement-ambiguous',
      'validate-input',
      { identities: affectedGroups.map((group) => group?.id) }
    );
  }

  const targetGroup = affectedGroups[0];
  const ownedMemberUuids = new Set(
    targetGroup.directMemberUuids.map(normalizeIdentity).filter(Boolean)
  );
  const unownedPreviousUuids = previousUuids.filter((uuid) => !ownedMemberUuids.has(uuid));
  if (unownedPreviousUuids.length) {
    throw new SceneGroupGeneratedMemberReplacementError(
      'generated-member-replacement-incomplete-ownership',
      'validate-input',
      { identities: unownedPreviousUuids }
    );
  }

  const removedUuids = previousUuids.filter((uuid) => !nextUuids.includes(uuid));
  const removedSet = new Set(removedUuids);
  const affectedRelationships = (nextRegistry.relationships || []).filter((relationship) => (
    removedSet.has(normalizeIdentity(relationship?.ownerUuid))
    || removedSet.has(normalizeIdentity(relationship?.dependentUuid))
  ));
  if (affectedRelationships.length) {
    throw new SceneGroupGeneratedMemberReplacementError(
      'generated-member-relationship-replacement-unsupported',
      'validate-relationships',
      {
        identities: affectedRelationships
          .map((relationship) => normalizeIdentity(relationship?.id))
          .filter(Boolean)
      }
    );
  }

  const visibilityStates = removedUuids
    .map((uuid) => nextRegistry.wallVisibilityStates?.[uuid])
    .filter(Boolean);
  const serializedVisibilityStates = new Set(
    visibilityStates.map((state) => JSON.stringify(state))
  );
  if (serializedVisibilityStates.size > 1) {
    throw new SceneGroupGeneratedMemberReplacementError(
      'generated-member-visibility-replacement-ambiguous',
      'validate-input',
      { identities: removedUuids }
    );
  }

  const originalRegistry = clone(nextRegistry);
  targetGroup.directMemberUuids = [
    ...targetGroup.directMemberUuids.filter((uuid) => !previousSet.has(normalizeIdentity(uuid))),
    ...nextUuids
  ];
  const replacementVisibilityState = visibilityStates[0] ? clone(visibilityStates[0]) : null;
  nextRegistry.wallVisibilityStates ||= {};
  for (const uuid of removedUuids) delete nextRegistry.wallVisibilityStates[uuid];
  if (replacementVisibilityState) {
    for (const uuid of nextUuids) {
      if (!previousSet.has(uuid)) {
        nextRegistry.wallVisibilityStates[uuid] = clone(replacementVisibilityState);
      }
    }
  }

  return {
    registry: nextRegistry,
    changed: JSON.stringify(nextRegistry) !== JSON.stringify(originalRegistry),
    groupId: normalizeIdentity(targetGroup.id)
  };
}
