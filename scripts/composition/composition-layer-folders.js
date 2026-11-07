import { getSceneLayerManagerSections, normalizeLayerManagerSections, serializeLayerManagerSections } from '../layers/model/section-metadata.js';

export const COMPOSITION_FOLDERS_FLAG='flags.fa-nexus.layerManagerSections';
export function captureCompositionLayerFolders(scene,documents) {
  const metadata=getSceneLayerManagerSections(scene),tiles=new Set(documents.filter(d=>d.documentName==='Tile').map(d=>d.id));
  const memberships=Object.fromEntries(Object.entries(metadata.memberships).filter(([id])=>tiles.has(id)));
  const ids=new Set(Object.values(memberships));
  for(const id of ids){const parent=metadata.sections[id]?.parentId;if(parent)ids.add(parent);}
  return {version:1,sections:Object.fromEntries(Object.entries(metadata.sections).filter(([id])=>ids.has(id))),memberships};
}
export function mergeCompositionLayerFolders(scene,folders) {
  const current=getSceneLayerManagerSections(scene),incoming=normalizeLayerManagerSections(folders);
  for(const id of Object.keys(incoming.sections))if(current.sections[id])throw new Error('A copied folder identity is already in use.');
  return serializeLayerManagerSections({version:1,sections:{...incoming.sections,...current.sections},memberships:{...current.memberships,...incoming.memberships}});
}
export function removeCompositionLayerFolders(scene,folders,{hadFolders=true}={}) {
  const current=getSceneLayerManagerSections(scene),owned=normalizeLayerManagerSections(folders);
  for(const [tile,id] of Object.entries(current.memberships))if(owned.sections[id]&&!owned.memberships[tile])throw new Error('A copied folder contains new Tiles. Undo those changes first.');
  for(const [id,section] of Object.entries(current.sections))if(owned.sections[section.parentId]&&!owned.sections[id])throw new Error('A copied folder contains new folders. Undo those changes first.');
  for(const id of Object.keys(owned.sections))delete current.sections[id];
  for(const tile of Object.keys(owned.memberships))delete current.memberships[tile];
  return !hadFolders&&!Object.keys(current.sections).length
    ? {'flags.fa-nexus.-=layerManagerSections':null}
    : {[COMPOSITION_FOLDERS_FLAG]:serializeLayerManagerSections(current)};
}
