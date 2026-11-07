import { collectActiveFaNexusSessionBlockers } from '../canvas/active-session-level-switch-guard.js';
import { isPrefabPlacementActive } from '../composition/prefab-placement.js';

/** Capture each source once through Foundry's own Level render lifecycle. */
export async function captureCompositionPreview(manager, tiles, bounds, {size=768,lightIds=[],wallIds=[]}={}) {
  if (manager.isBusy()) throw new Error('Finish the active Flatten operation before saving a Prefab.');
  const scene=canvas.scene,originalLevelId=canvas.level.id,levels=scene.levels.sorted;
  const documents=[...tiles,...wallIds.map(id=>scene.walls.get(id)),...lightIds.map(id=>scene.lights.get(id))];
  if (documents.some(doc=>!doc||doc.parent!==scene)) throw new Error('Return to the source Scene before capturing the group.');
  const jobs=new Map();
  for(const doc of documents){
    const hint=doc.flags?.['fa-nexus']?.placementLevelId;
    const levelId=scene.levels.has(hint)&&doc.includedInLevel(hint)?hint
      :doc.includedInLevel(originalLevelId)?originalLevelId:levels.find(level=>doc.includedInLevel(level.id))?.id;
    if(!levelId) throw new Error(`No available Level can render ${doc.documentName} ${doc.id}.`);
    if(!jobs.has(levelId))jobs.set(levelId,{tiles:[],wallIds:[]});
    const job=jobs.get(levelId);
    if(doc.documentName==='Tile')job.tiles.push(doc);
    else if(doc.documentName==='Wall')job.wallIds.push(doc.id);
  }
  if(!jobs.size)jobs.set(originalLevelId,{tiles:[],wallIds:[]});
  // Authoring previews may render while their committed documents are unchanged.
  // Capturing either one Level or many would mix draft artwork with saved data.
  if(collectActiveFaNexusSessionBlockers().length){
    throw new Error('Finish or cancel the active FA Nexus session before saving a Prefab.');
  }
  if(isPrefabPlacementActive()&&[...jobs.keys()].some(levelId=>levelId!==originalLevelId)){
    throw new Error('Finish or cancel the active Prefab placement before saving a Prefab on other Levels.');
  }
  manager._flattening=true;
  let combined=null;
  try {
    const ppi=scene.grid.size*Math.min(1,size/Math.max(bounds.width,bounds.height));
    for(const level of levels){
      const job=jobs.get(level.id);if(!job)continue;
      if(canvas.scene!==scene)throw new Error('The viewed Scene changed while capturing the group.');
      await manager._viewLevelForExport({levelId:level.id,name:level.name});
      // Selected Lights illuminate every included source Level, just as live.
      const levelLights=lightIds.filter(id=>scene.lights.get(id).includedInLevel(level.id));
      let unlit=null,result=null;
      const visibility={keepDoors:job.wallIds.length>0,doorVisibility:{wallIds:job.wallIds}};
      try {
        if(levelLights.length&&job.tiles.length)unlit=await manager._renderTilesToCanvas(job.tiles,bounds,ppi,{trimToContent:false,paddingExtra:0,paddingSnap:false,visibility});
        result=await manager._renderTilesToCanvas(job.tiles,bounds,ppi,{trimToContent:false,paddingExtra:0,paddingSnap:false,visibility:{...visibility,lightIds:levelLights}});
        if(unlit){const ctx=result.canvas.getContext('2d');ctx.globalCompositeOperation='destination-in';ctx.drawImage(unlit.canvas,0,0);ctx.globalCompositeOperation='source-over';}
        if(!combined){combined=document.createElement('canvas');combined.width=result.canvas.width;combined.height=result.canvas.height;}
        combined.getContext('2d').drawImage(result.canvas,0,0);
      } finally {
        if(unlit)manager._releaseCanvas(unlit.canvas);
        if(result)manager._releaseCanvas(result.canvas);
      }
    }
    const blob=await new Promise(resolve=>combined.toBlob(resolve,'image/webp',.9));
    if(!blob)throw new Error('Could not encode the Prefab preview.');
    return blob;
  } finally {
    try {
      if(canvas.scene===scene&&canvas.level.id!==originalLevelId)await manager._viewLevelForExport({levelId:originalLevelId});
    } finally {
      if(combined)manager._releaseCanvas(combined);
      manager._flattening=false;
    }
  }
}
