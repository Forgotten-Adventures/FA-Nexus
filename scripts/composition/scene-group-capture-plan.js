export function validateCaptureArea(area) {
  if (!area || !['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(area[key]))
    || area.maxX <= area.minX || area.maxY <= area.minY) throw new Error('Draw a non-empty selection area.');
  return area;
}

export function capturePassesSelectionOptions(document, options = {}) {
  return !(options.skipLocked && document.locked || options.skipHidden && document.hidden || options.skipFiltered && document.filtered
    || Number.isFinite(options.min) && document.elevation < options.min || Number.isFinite(options.max) && document.elevation > options.max);
}

export function planSceneGroupCapture({ area, documents, registry, memberUuids = null }) {
  validateCaptureArea(area);
  const docs = new Map(documents.map(doc => [doc.uuid, doc]));
  const owners = new Map(registry.relationships.map(link => [link.dependentUuid, link.ownerUuid]));
  const memberships = new Map(Object.values(registry.groups).flatMap(group => group.directMemberUuids.map(uuid => [uuid, group.id])));
  const areaHits = new Set(documents.filter(doc => doc.eligible && doc.bounds.minX <= area.maxX && doc.bounds.maxX >= area.minX
    && doc.bounds.minY <= area.maxY && doc.bounds.maxY >= area.minY).map(doc => doc.uuid));
  const hits = memberUuids ? new Set(memberUuids.filter(uuid => docs.get(uuid)?.eligible)) : areaHits;
  const descendants = uuid => {
    const uuids = [uuid];
    for (let i = 0; i < uuids.length; i++) for (const [child, owner] of owners) if (owner === uuids[i]) uuids.push(child);
    return uuids;
  };
  const groupMembers = id => {
    const groupIds = [id];
    for (let i = 0; i < groupIds.length; i++) for (const group of Object.values(registry.groups)) if (group.parentId === groupIds[i]) groupIds.push(group.id);
    return groupIds.flatMap(id => registry.groups[id].directMemberUuids.flatMap(descendants));
  };
  const candidates = new Map();
  for (const hit of hits) {
    let root = hit;
    while (owners.has(root)) root = owners.get(root);
    let groupId = memberships.get(root);
    if (groupId) while (registry.groups[groupId].parentId) groupId = registry.groups[groupId].parentId;
    const key = groupId ? `group:${groupId}` : `member:${root}`;
    if (candidates.has(key)) continue;
    const document = docs.get(root);
    if (!document) throw new Error(`Capture owner is missing: ${root}.`);
    const memberUuids = [...new Set(groupId ? groupMembers(groupId) : descendants(root))].sort();
    // Relationships are indivisible. Selection limits apply to their owners,
    // since generated parts are normally locked against individual editing.
    // A locked/hidden/filtered direct member excludes the complete group.
    if(memberUuids.some(uuid=>!owners.has(uuid)&&docs.get(uuid)?.captureExcluded))continue;
    candidates.set(key, {
      key, groupId: groupId || null, memberUuid: groupId ? null : root,
      category: groupId ? 'Existing Groups' : document.category,
      label: groupId ? registry.groups[groupId].name : document.label,
      documentName: groupId ? null : document.documentName,
      elevation: groupId ? null : document.elevation,
      folderPath: groupId ? [] : document.folderPath || [],
      bounds: memberUuids.reduce((bounds, uuid) => {
        const part = docs.get(uuid)?.bounds;
        if (!part) throw new Error(`Capture member is missing: ${uuid}.`);
        return { minX: Math.min(bounds.minX, part.minX), minY: Math.min(bounds.minY, part.minY),
          maxX: Math.max(bounds.maxX, part.maxX), maxY: Math.max(bounds.maxY, part.maxY) };
      }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }),
      memberUuids, outsideCount: memberUuids.filter(uuid => !areaHits.has(uuid)).length
    });
  }
  return [...candidates.values()].sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

export function sameCaptureOwnership(current, reviewed) {
  return !!current && !!reviewed && current.key === reviewed.key && current.groupId === reviewed.groupId
    && current.memberUuid === reviewed.memberUuid && JSON.stringify(current.memberUuids) === JSON.stringify(reviewed.memberUuids);
}

export function captureReviewTree(candidates, options) {
  const roots = [];
  for (const candidate of candidates) {
    const path = [{key:`type:${candidate.category}`, name:candidate.category},
      ...(planCaptureSubgroups([candidate], options)[0]?.path || [])];
    let children = roots, key = '';
    for (const part of path) {
      key += `/${JSON.stringify(part.key)}`;
      let branch = children.find(node => node.key === key);
      if (!branch) { branch = {key, name:part.name, children:[]}; children.push(branch); }
      children = branch.children;
    }
    children.push({candidate});
  }
  return roots;
}

// A candidate is an indivisible ownership unit. Optional organization only
// changes its destination; it never splits an existing group or structure.
export function planCaptureSubgroups(selected, { groupByElevation = false, groupByFolder = false } = {}) {
  const units = selected.filter(candidate => !candidate.groupId);
  const typed = new Set(units.map(candidate => candidate.category)).size > 1 || selected.some(candidate => candidate.groupId);
  return units.map(candidate => {
    const path = [];
    if (typed) path.push({ key: `type:${candidate.category}`, name: candidate.category });
    if (groupByElevation) path.push({ key: `elevation:${candidate.elevation ?? 0}`, name: `Elevation ${candidate.elevation ?? 0}` });
    if (groupByFolder && candidate.documentName === 'Tile') {
      path.push(...(candidate.folderPath || []).map(folder => ({ key: `folder:${folder.id}`, name: folder.name })));
    }
    return { candidate, path };
  });
}
