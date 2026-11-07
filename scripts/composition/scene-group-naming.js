export const SCENE_GROUP_NAME_INTENT_KINDS = Object.freeze({
  GENERIC: 'generic',
  TYPE: 'type'
});

export const SCENE_GROUP_TYPE_NAME_BASES = Object.freeze({
  Tile: 'Tiles',
  Wall: 'Walls',
  AmbientLight: 'Lights',
  AmbientSound: 'Sounds',
  Region: 'Regions'
});

function normalizeText(value) {
  return String(value || '').trim();
}

export function createGenericSceneGroupNameIntent() {
  return Object.freeze({ kind: SCENE_GROUP_NAME_INTENT_KINDS.GENERIC });
}

export function createTypeSceneGroupNameIntent(documentType) {
  const normalizedType = normalizeText(documentType);
  if (!SCENE_GROUP_TYPE_NAME_BASES[normalizedType]) {
    throw new Error(`Unsupported Scene Group type naming intent: ${normalizedType || 'missing'}.`);
  }
  return Object.freeze({
    kind: SCENE_GROUP_NAME_INTENT_KINDS.TYPE,
    documentType: normalizedType
  });
}

export function createSceneGroupNameIntentForDocumentTypes(documentTypes = []) {
  const types = [...new Set(Array.from(documentTypes, normalizeText).filter(Boolean))];
  return types.length === 1 && SCENE_GROUP_TYPE_NAME_BASES[types[0]]
    ? createTypeSceneGroupNameIntent(types[0])
    : createGenericSceneGroupNameIntent();
}

export function resolveSceneGroupNameBase(namingIntent) {
  const kind = normalizeText(namingIntent?.kind);
  if (kind === SCENE_GROUP_NAME_INTENT_KINDS.GENERIC) return 'Group';
  if (kind === SCENE_GROUP_NAME_INTENT_KINDS.TYPE) {
    const documentType = normalizeText(namingIntent?.documentType);
    const base = SCENE_GROUP_TYPE_NAME_BASES[documentType];
    if (base) return base;
  }
  throw new Error(`Invalid Scene Group naming intent: ${kind || 'missing'}.`);
}

export function resolveNextSceneGroupName({
  groups,
  parentGroupId = null,
  namingIntent
} = {}) {
  const entries = Array.isArray(groups)
    ? groups
    : Object.values(groups || {});
  const normalizedParentId = normalizeText(parentGroupId) || null;
  const base = resolveSceneGroupNameBase(namingIntent);
  const siblingNames = new Set(entries
    .filter((group) => (normalizeText(group?.parentId) || null) === normalizedParentId)
    .map((group) => normalizeText(group?.name).toLowerCase())
    .filter(Boolean));

  for (let number = 1; Number.isSafeInteger(number); number += 1) {
    const candidate = `${base} ${number}`;
    if (!siblingNames.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`Scene Group name space is exhausted for ${base}.`);
}
