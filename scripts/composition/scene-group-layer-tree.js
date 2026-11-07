import { normalizeLayerManagerSections, getSectionMoveRootIds } from '../layers/model/section-metadata.js';

// Resolve a drop against the current ownership registry before asking the user.
// Dependents never become independent members; include promotes the first
// occurrence to its root, while skip omits roots absent from the original drag.
export function planSceneGroupDropOwnership(payload, registry, {includeOwners = true} = {}) {
  const owners = new Map((registry.relationships || []).map(link => [link.dependentUuid, link.ownerUuid]));
  const rootOf = uuid => {
    const seen = new Set();
    while (owners.has(uuid)) {
      if (seen.has(uuid)) throw new Error('Scene Group ownership contains a cycle.');
      seen.add(uuid); uuid = owners.get(uuid);
    }
    return uuid;
  };
  const originals = new Set(payload.memberUuids);
  const requiredOwnerUuids = [...new Set([...originals].map(rootOf).filter(uuid => !originals.has(uuid)))];
  const emitted = new Set();
  const replace = uuids => uuids.flatMap(uuid => {
    const owner = rootOf(uuid);
    if (owner !== uuid && (originals.has(owner) || !includeOwners)) return [];
    if (emitted.has(owner)) return [];
    emitted.add(owner); return [owner];
  });
  const rewrite = node => ({...node, memberUuids:replace(node.memberUuids), children:node.children.map(rewrite)});
  const layerTree = payload.layerTree ? {...payload.layerTree,
    nodes:payload.layerTree.nodes.map(rewrite), memberUuids:replace(payload.layerTree.memberUuids)} : null;
  const memberUuids = layerTree ? [...emitted] : replace(payload.memberUuids);
  return {requiredOwnerUuids, payload:{...payload,memberUuids,...(layerTree ? {layerTree} : {})}};
}

// This is a drag snapshot of Layer Manager's canonical folders, not a second
// folder store. Scene Groups receive ordinary independent groups on drop.
export function buildLayerManagerSceneTree({ documents, metadata, sectionIds = null, name = null }) {
  const {sections, memberships} = normalizeLayerManagerSections(metadata);
  const selectedRoots = sectionIds ? new Set(getSectionMoveRootIds(metadata, sectionIds)) : null;
  const nodes = [], loose = [];
  for (const doc of documents) {
    const path = [];
    let id = memberships[doc.id];
    while (id) {
      path.unshift(id);
      if (selectedRoots?.has(id)) break;
      id = sections[id].parentId;
    }
    if (selectedRoots && !selectedRoots.has(path[0])) path.length = 0;
    let children = nodes, parent = null;
    for (const folderId of path) {
      let node = children.find(node => node.folderId === folderId);
      if (!node) { node = {folderId, name:sections[folderId].name, memberUuids:[], children:[]}; children.push(node); }
      parent = node; children = node.children;
    }
    if (parent) parent.memberUuids.push(doc.uuid); else loose.push(doc.uuid);
  }
  return name ? {nodes:[{name,memberUuids:loose,children:nodes}],memberUuids:[]}
    : {nodes,memberUuids:loose};
}
