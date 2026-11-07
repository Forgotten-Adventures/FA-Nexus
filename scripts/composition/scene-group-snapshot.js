// Portable data only. Live documents and placement belong to scene-group-copy-runtime.
import { resolveSceneGroupIconColor, validateSceneGroupIconColor } from './scene-group-icons.js';
export const PREFAB_SCHEMA_VERSION = 1;
export const PREFAB_SCENE_ID = 'NexusPrefabScene';
export const COMPOSITION_COLLECTIONS = Object.freeze({
  Tile: 'tiles', Wall: 'walls', AmbientLight: 'lights', AmbientSound: 'sounds', Region: 'regions'
});

export function cloneCompositionValue(value) { return structuredClone(value); }

export function remapCompositionReferences(value, identities, key = '') {
  // Labels and paths are user content, even if they happen to contain an ID.
  if (typeof value === 'string') {
    if (['name', 'label', 'description', 'text', 'src', 'path', 'url', 'archiveId', 'archiveSceneId'].includes(key)) return value;
    if (identities.has(value)) return identities.get(value);
    if (key === 'elevationKey') return value.replace(/^(ground|foreground):([^:]+):/,(_all,band,id)=>`${band}:${identities.get(id)||id}:`);
    return value.replace(/Scene\.([A-Za-z0-9]+)\.(Tile|Wall|AmbientLight|AmbientSound|Region|Level)\.([A-Za-z0-9]+)/g,
      uuid => identities.get(uuid) || uuid);
  }
  if (Array.isArray(value)) return value.map(entry => remapCompositionReferences(entry, identities, key));
  if (!value || typeof value !== 'object') return value;
  const identityKeys = ['groups', 'wallVisibilityStates', 'sections', 'memberships'].includes(key);
  return Object.fromEntries(Object.entries(value).map(([field, entry]) => [
    (identityKeys || /^[A-Za-z0-9]{16}$/.test(field) || field.startsWith('Scene.')) ? identities.get(field) || field : field,
    remapCompositionReferences(entry, identities, field)]));
}

export function compositionIdentityMap(snapshot, { sceneId, randomId, levelIds = new Map() }) {
  const identities = new Map([[snapshot.sceneId, sceneId], ...levelIds]);
  identities.set(`Scene.${snapshot.sceneId}`, `Scene.${sceneId}`);
  for (const [source, target] of levelIds) identities.set(`Scene.${snapshot.sceneId}.Level.${source}`, `Scene.${sceneId}.Level.${target}`);
  const add = id => { if (id && !identities.has(id)) identities.set(id, randomId()); };
  for (const item of snapshot.documents) {
    add(item.source._id);
    identities.set(`Scene.${snapshot.sceneId}.${item.type}.${item.source._id}`,
      `Scene.${sceneId}.${item.type}.${identities.get(item.source._id)}`);
    // These are aggregate identities, unlike editor-local vertex/segment IDs.
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (['buildingId', 'generationId', 'maskSlotId'].includes(key) && typeof entry === 'string') add(entry);
        else if (entry && typeof entry === 'object') visit(entry);
      }
    };
    visit(item.source.flags?.['fa-nexus']);
    const flags = item.source.flags?.['fa-nexus'];
    for (const binding of flags?.flattened?.composition?.identities || []) {
      const parts = binding.currentId.split('.');
      if (parts[0] === 'Scene' && parts.length === 4) {
        add(parts[3]);
        identities.set(binding.currentId, `Scene.${sceneId}.${parts[2]}.${identities.get(parts[3])}`);
      } else add(binding.currentId);
    }
    for (const path of [flags?.pathV2, ...(flags?.pathsV2?.paths || [])]) add(path?.foundryWalls?.groupId);
    add(flags?.pathWall?.groupId);
    for (const behavior of item.source.behaviors || []) add(behavior._id);
  }
  Object.keys(snapshot.registry.groups).forEach(add);
  Object.keys(snapshot.layerFolders?.sections || {}).forEach(add);
  snapshot.registry.relationships.forEach(relation => add(relation.id));
  return identities;
}

export function captureCompositionTree(registry, groupId, resolveSource) {
  if (!registry.groups[groupId]) throw new Error('The selected Scene Group no longer exists.');
  const groupIds = new Set([groupId]);
  for (const id of groupIds) {
    for (const group of Object.values(registry.groups)) if (group.parentId === id) groupIds.add(group.id);
  }
  const uuids = new Set([...groupIds].flatMap(id => registry.groups[id].directMemberUuids));
  for (const uuid of uuids) {
    for (const relation of registry.relationships) if (relation.ownerUuid === uuid) uuids.add(relation.dependentUuid);
  }
  const groups = Object.fromEntries([...groupIds].map(id => [id, cloneCompositionValue(registry.groups[id])]));
  if (groups[groupId].parentId && !groups[groupId].iconColor) {
    groups[groupId].iconColor = resolveSceneGroupIconColor(groupId, registry.groups);
  }
  groups[groupId].parentId = null;
  return {
    registry: { schemaVersion: 1, groups,
      relationships: cloneCompositionValue(registry.relationships.filter(relation => uuids.has(relation.ownerUuid))),
      wallVisibilityStates: cloneCompositionValue(Object.fromEntries(Object.entries(registry.wallVisibilityStates || {})
        .filter(([id]) => uuids.has(id) || [...uuids].some(uuid => uuid.endsWith(`.Wall.${id}`))))) },
    documents: [...uuids].map(uuid => {
      const document = resolveSource(uuid);
      if (!document || !COMPOSITION_COLLECTIONS[document.type]) throw new Error(`Cannot capture group member ${uuid}.`);
      const source = cloneCompositionValue(document.source);
      delete source._stats;
      return { type: document.type, source };
    })
  };
}

export function captureCompositionMembers(registry, memberUuids, resolveSource, {groupId, name}) {
  const incoming = new Map(registry.relationships.map(relation=>[relation.dependentUuid,relation]));
  const selected = new Set(memberUuids.map(uuid=>{
    const seen = new Set();
    while (incoming.get(uuid)?.type === 'generated-by') {
      if (seen.has(uuid)) throw new Error('Cannot copy cyclic generated ownership.');
      seen.add(uuid); uuid = incoming.get(uuid).ownerUuid;
    }
    return uuid;
  }));
  if (!selected.size) throw new Error('Select a Building or Path to copy.');
  // Selected owners already capture their descendants; never add a dependent
  // as a second direct member or include its owner's unrelated Scene Group.
  const members = [...selected].filter(uuid=>{
    const seen = new Set();
    for (let parent = incoming.get(uuid)?.ownerUuid; parent; parent = incoming.get(parent)?.ownerUuid) {
      if (seen.has(parent)) throw new Error('Cannot copy cyclic ownership.');
      seen.add(parent); if (selected.has(parent)) return false;
    }
    return true;
  });
  return captureCompositionTree({...registry,groups:{[groupId]:{
    id:groupId,name,parentId:null,directMemberUuids:members,pivotMode:'automatic',frameAngle:0
  }}},groupId,resolveSource);
}

export function validateCompositionSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== PREFAB_SCHEMA_VERSION || snapshot?.kind !== 'fa-nexus-prefab') {
    throw new Error('Unsupported Prefab format or version.');
  }
  if (!snapshot.registry?.groups?.[snapshot.rootGroupId] || !snapshot.documents?.length) throw new Error('Prefab has no root group or members.');
  if (!snapshot.sceneId || !Array.isArray(snapshot.levels)) throw new Error('Prefab Scene and Level data are missing.');
  const identities = new Set();
  for (const {type, source} of snapshot.documents) {
    if (!COMPOSITION_COLLECTIONS[type] || !/^[a-zA-Z0-9]{16}$/.test(source?._id || '')) throw new Error('Invalid Prefab document identity.');
    const uuid = `Scene.${snapshot.sceneId}.${type}.${source._id}`;
    if (identities.has(uuid)) throw new Error(`Duplicate Prefab member ${uuid}.`);
    identities.add(uuid);
  }
  const groups = snapshot.registry.groups;
  if (groups[snapshot.rootGroupId].parentId != null) throw new Error('Prefab root must have no parent.');
  const reached = new Set([snapshot.rootGroupId]);
  for (const id of reached) for (const group of Object.values(groups)) if (group.parentId === id) reached.add(group.id);
  if (reached.size !== Object.keys(groups).length) throw new Error('Prefab groups must form one complete tree.');
  if (snapshot.placementKind && !['group','composite'].includes(snapshot.placementKind)) throw new Error('Unknown Prefab placement kind.');
  if (snapshot.placementKind === 'composite' && (Object.keys(groups).length !== 1 || groups[snapshot.rootGroupId]?.parentId)) {
    throw new Error('Composite Prefabs cannot contain Scene Groups.');
  }
  const members = new Set();
  for (const [id, group] of Object.entries(groups)) {
    if (id !== group.id || !Array.isArray(group.directMemberUuids)) throw new Error('Invalid Prefab group.');
    if (group.iconColor != null) validateSceneGroupIconColor(group.iconColor);
    for (const uuid of group.directMemberUuids) {
      if (!identities.has(uuid) || members.has(uuid)) throw new Error('Invalid or duplicate Prefab membership.');
      members.add(uuid);
    }
  }
  const dependents = new Set(), relationIds = new Set();
  for (const relation of snapshot.registry.relationships) {
    if (!identities.has(relation.ownerUuid) || !identities.has(relation.dependentUuid)
      || members.has(relation.dependentUuid) || dependents.has(relation.dependentUuid) || relationIds.has(relation.id)) {
      throw new Error('Invalid Prefab dependency closure.');
    }
    dependents.add(relation.dependentUuid); relationIds.add(relation.id);
  }
  for (const uuid of members) for (const relation of snapshot.registry.relationships) {
    if (relation.ownerUuid === uuid) members.add(relation.dependentUuid);
  }
  if (members.size !== identities.size) throw new Error('Prefab contains unowned documents or cyclic dependencies.');
  if (snapshot.layerFolders != null) {
    const folders=snapshot.layerFolders,sections=folders.sections,memberships=folders.memberships;
    if(folders.version!==1 || !sections || Array.isArray(sections) || typeof sections!=='object'
      || !memberships || Array.isArray(memberships) || typeof memberships!=='object')throw new Error('Invalid Prefab layer folders.');
    for(const [id,section] of Object.entries(sections)) {
      if(!id || typeof section?.name!=='string' || !section.name.trim())throw new Error('Invalid Prefab layer folder name.');
      const parents=new Set([id]);let parent=section.parentId;
      while(parent!=null) {
        if(!sections[parent] || parents.has(parent))throw new Error('Invalid Prefab layer folder hierarchy.');
        parents.add(parent);parent=sections[parent].parentId;
      }
    }
    const tiles=new Set(snapshot.documents.filter(item=>item.type==='Tile').map(item=>item.source._id));
    for(const [tile,folder] of Object.entries(memberships)) {
      if(!tiles.has(tile) || !sections[folder])throw new Error('Prefab layer folder membership is outside the captured Tiles.');
    }
  }
  return snapshot;
}
