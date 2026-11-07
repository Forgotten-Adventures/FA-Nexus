function normalizeIdentity(value) {
  return String(value || '').trim();
}

function normalizeKind(value) {
  const kind = normalizeIdentity(value);
  if (kind === 'document' || kind === 'group') return kind;
  throw new Error(`Unsupported Scene Group drag selection kind: ${kind || 'missing'}.`);
}

/**
 * Apply one selection-aware drag rule to every Scene Group drag source.
 */
export function resolveSceneGroupDragSelection({ origin, selected = [] } = {}) {
  const originKind = normalizeKind(origin?.kind);
  const originId = normalizeIdentity(origin?.id);
  if (!originId) throw new Error('Scene Group drag selection requires an origin identity.');

  const normalizedSelected = [];
  const seen = new Set();
  for (const item of Array.isArray(selected) ? selected : []) {
    const kind = normalizeKind(item?.kind);
    const id = normalizeIdentity(item?.id);
    if (!id) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedSelected.push({ kind, id });
  }

  const originKey = `${originKind}:${originId}`;
  const originIsSelected = seen.has(originKey);
  const resolved = originIsSelected
    ? normalizedSelected.filter((item) => item.kind === originKind)
    : [{ kind: originKind, id: originId }];

  return {
    memberUuids: originKind === 'document' ? resolved.map((item) => item.id) : [],
    groupIds: originKind === 'group' ? resolved.map((item) => item.id) : []
  };
}
