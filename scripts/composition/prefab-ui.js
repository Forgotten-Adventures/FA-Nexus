import { captureSceneGroup } from './scene-group-copy-runtime.js';
import { getSceneGroupOrientedFrame } from './scene-group-workflow.js';
import { listLocalPrefabs, readLocalPrefab, readLocalPrefabPreview, saveLocalPrefab, renameLocalPrefab, deleteLocalPrefab, checkPrefabResources, resolvePrefabContent, importLocalPrefab, inspectPrefabAccess } from './prefab-library.js';
import { prefabAccessBlocker, beginPrefabPreparationNotice } from './prefab-content-access.js';
import { PrefabSaveDialog } from './prefab-save-dialog.js';
import { beginPrefabPlacement } from './prefab-placement.js';
export { beginPrefabPlacement, cancelPrefabPlacement } from './prefab-placement.js';
import { sceneGroupInteractionState } from './scene-group-interaction-state.js';
import { notifySceneGroupFailure } from './scene-group-notifications.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

const { DialogV2 } = foundry.applications.api;
const escape = value => foundry.utils.escapeHTML(String(value ?? ''));
let groupClipboard = null;

async function capturePreview(capture) {
  const { documents, pivot } = capture;
  const assertCurrent = () => {
    if (documents.some(doc => doc.parent !== canvas.scene)) throw new Error('Return to the source Scene before capturing the group.');
    const current = documents.map(doc => {const source=doc.toObject();delete source._stats;return {type:doc.documentName,source};});
    if (JSON.stringify(current)!==JSON.stringify(capture.sourceDocuments)) throw new Error('The group changed while its preview was being captured. Please retry.');
  };
  assertCurrent();
  const frame = getSceneGroupOrientedFrame(documents, 0);
  let bounds = { x: frame.center.x-frame.width/2-8, y:frame.center.y-frame.height/2-8,
    width:Math.max(16,frame.width+16),height:Math.max(16,frame.height+16) };
  const lights = documents.filter(doc=>doc.documentName==='AmbientLight');
  const tiles = documents.filter(doc => doc.documentName === 'Tile');
  if (!tiles.length && lights.length) {
    const extents=lights.map(doc=>{const r=Math.max(doc.config.dim,doc.config.bright)*canvas.scene.grid.size/canvas.scene.grid.distance;
      return {left:doc.x-r,right:doc.x+r,top:doc.y-r,bottom:doc.y+r};});
    const x=Math.min(...extents.map(e=>e.left)),y=Math.min(...extents.map(e=>e.top));
    bounds={x,y,width:Math.max(16,Math.max(...extents.map(e=>e.right))-x),height:Math.max(16,Math.max(...extents.map(e=>e.bottom))-y)};
  }
  capture.snapshot.previewBounds = { ...bounds, x:bounds.x-Math.round(pivot.x), y:bounds.y-Math.round(pivot.y) };
  if (tiles.length || lights.length) {
    const { getTileFlattenManager } = await import('../layers/layer-manager-tab.js');
    const preview = await getTileFlattenManager().captureCompositionPreview(tiles, bounds, {
      lightIds:lights.map(doc=>doc.id),
      wallIds:documents.filter(doc=>doc.documentName==='Wall').map(doc=>doc.id)
    });
    assertCurrent();
    return preview;
  }
  // A group of nonvisual objects gets a diagram of their actual positions.
  const image = document.createElement('canvas'), size = Math.min(1,768/Math.max(bounds.width,bounds.height));
  image.width = Math.ceil(bounds.width*size); image.height=Math.ceil(bounds.height*size);
  const ctx=image.getContext('2d');ctx.scale(size,size);ctx.translate(-bounds.x,-bounds.y);
  ctx.strokeStyle='#d9b273';ctx.fillStyle='#d9b273';ctx.lineWidth=2/size;
  for(const doc of documents) {
    if(doc.documentName==='Wall'){ctx.beginPath();ctx.moveTo(doc.c[0],doc.c[1]);ctx.lineTo(doc.c[2],doc.c[3]);ctx.stroke();}
    else {const box=getSceneGroupOrientedFrame([doc],0);ctx.strokeRect(box.center.x-box.width/2,box.center.y-box.height/2,Math.max(box.width,8/size),Math.max(box.height,8/size));}
  }
  const blob=await new Promise(resolve=>image.toBlob(resolve,'image/webp',.9));
  if(!blob)throw new Error('Could not capture the group preview.');return blob;
}

async function promptName(name, title, label='Save') {
  return DialogV2.wait({window:{title},position:{width:360,height:'auto'},modal:true,
    content:`<div class="form-group"><label>Name</label><input name="prefabName" type="text" value="${escape(name)}" required></div>`,
    buttons:[{action:'save',label,default:true,callback:(_e,_b,dialog)=>dialog.element.querySelector('[name=prefabName]').value.trim()},
      {action:'cancel',label:'Cancel',callback:()=>false}],rejectClose:false});
}

export async function saveGroupPrefab(groupId, { updateId = null } = {}) {
  const sourceScene=canvas.scene;
  let capture=await captureSceneGroup(sourceScene,groupId);
  const choice=await PrefabSaveDialog.choose({name:capture.snapshot.name,entries:await listLocalPrefabs(),suggestedId:updateId});
  if(!choice)return null;
  if(canvas.scene!==sourceScene)throw new Error('Return to the source Scene before saving this Prefab.');
  capture=await captureSceneGroup(sourceScene,groupId);
  const preview=await capturePreview(capture);
  const record=await saveLocalPrefab(capture.snapshot,{...choice,preview});
  // The card appears in the Prefabs tab, which is usually not the tab in view.
  ui.notifications.info(`${record.name}: ${choice.id?'updated in':'saved to'} the Prefab library.`);
  return record;
}

export async function copyGroupToClipboard(groupIds, {memberUuids} = {}) {
  const source = canvas.scene;
  const pending=captureSceneGroup(source,groupIds,{memberUuids}).then(capture => capture.snapshot);
  groupClipboard = pending;
  try { await pending; } catch(error) {if(groupClipboard===pending)groupClipboard=null;throw error;}
}

export async function copyGroup(groupId) {
  const {snapshot}=await captureSceneGroup(canvas.scene,groupId);
  return beginPrefabPlacement(snapshot,{mode:'pixels',label:'Duplicate Placement'});
}

// Keyboard clipboard survives Scene changes but yields to text editing and
// ordinary native copying unless selected Tiles include a Building/Path owner.
globalThis.addEventListener('keydown',event=>{
  if(!game?.user?.isGM || !canvas?.ready || event.repeat || event.altKey || event.shiftKey || !(event.ctrlKey||event.metaKey)
    || event.target.closest?.('input,textarea,select,[contenteditable="true"],.dialog'))return;
  const key=event.key.toLowerCase();
  if(key!=='c'&&key!=='v')return;
  const groups=sceneGroupInteractionState.snapshot(canvas.scene).selectedGroupIds;
  const tiles = canvas.activeLayer===canvas.tiles ? canvas.tiles.controlled.map(tile=>tile.document) : [];
  const structureCopy = tiles.some(document=>{
    const flags = document.flags?.['fa-nexus'] || {};
    return flags.building || flags.buildingGenerated || flags.buildingFill || flags.buildingSills || flags.pathV2 || flags.pathsV2 || flags.flattened?.composition;
  });
  if(key==='c'&&!groups.length&&!structureCopy){groupClipboard=null;return;}
  if(key==='v'&&!groupClipboard)return;
  event.preventDefault();event.stopImmediatePropagation();
  const action=key==='c' ? copyGroupToClipboard(groups,groups.length ? {} : {memberUuids:tiles.map(tile=>tile.uuid)})
    : groupClipboard.then(snapshot=>beginPrefabPlacement(snapshot,{label:'Paste Placement'}));
  action.catch(error=>{Logger.error('SceneGroup.clipboard.failed',{error:String(error)});notifySceneGroupFailure(error,'Could not copy or paste group');});
},true);

export async function runPrefabLibraryAction(action,id,{onProgress,onReady,signal}={}) {
  if(action==='export'){
    const { exportPrefabPackage } = await import('./prefab-package.js');
    const record = await readLocalPrefab(id), blob = await exportPrefabPackage(id);
    foundry.utils.saveDataToFile(blob, 'application/octet-stream', `${record.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.fanxprefab`);
    return;
  }
  if(action==='save-as'){
    const source=await readLocalPrefab(id);
    const choice=await PrefabSaveDialog.choose({name:source.name,entries:await listLocalPrefabs(),suggestedId:id});
    if(!choice)return null;
    const preview=await readLocalPrefabPreview(id);
    if((await readLocalPrefab(id)).hash!==source.hash)throw new Error('The source Prefab changed. Please retry.');
    return saveLocalPrefab(source,{...choice,preview});
  }
  if(action==='save'){
    const selected=sceneGroupInteractionState.snapshot(canvas.scene).selectedGroupIds;
    if(selected.length!==1)throw new Error('Select one Scene Group to save.');
    return saveGroupPrefab(selected[0]);
  }
  if(action==='delete'){
    if(await DialogV2.confirm({window:{title:'Delete Local Prefab'},content:'<p>Remove this Prefab from the library? Placed copies remain.</p>',rejectClose:false}))return deleteLocalPrefab(id);
    return null;
  }
  if(action==='rename'){
    const record=await readLocalPrefab(id);
    const name=await promptName(record.name,'Rename Prefab','Rename');
    if(typeof name!=='string'||!name.trim())return null;
    return renameLocalPrefab(id,name,{expectedRevision:record.revision});
  }
  const scene=canvas.scene,levelId=canvas.level?.id;
  signal?.throwIfAborted();
  const record=await resolvePrefabContent(await readLocalPrefab(id),{onProgress,signal});
  signal?.throwIfAborted();onProgress?.({phase:'verifying'});
  const missing=await checkPrefabResources(record);
  signal?.throwIfAborted();
  if(action==='prepare'){
    if(missing.length)throw new Error(`Prefab artwork is unavailable: ${missing.map(path=>path.split('/').at(-1)).join(', ')}`);
    ui.notifications.info(`${record.name}: Required assets are ready.`);return record;
  }
  if(missing.length&&!await DialogV2.confirm({window:{title:'Missing Prefab Assets'},content:`<p>These source files are unavailable:</p><ul>${missing.map(path=>`<li>${escape(path)}</li>`).join('')}</ul><p>Place anyway using their original paths?</p>`,yes:{label:'Place Anyway'},rejectClose:false}))return null;
  signal?.throwIfAborted();onProgress?.({phase:'preview'});
  return beginPrefabPlacement(record,{scene,levelId,onReady,signal});
}

export async function importPrefabFile(file) {
  const { readPrefabPackage } = await import('./prefab-package.js');
  const bundle = await readPrefabPackage(file), source = bundle.record;
  const existing = (await listLocalPrefabs()).find(entry=>entry.id===source.id);
  if(existing?.hash===source.hash){ui.notifications.info('This Prefab is already installed.');return null;}
  let access;
  try{access=await inspectPrefabAccess(source);}
  catch(error){Logger.error('Prefab.import.contentCheck.failed',{error:String(error)});access={unknown:1};}
  const blocked=prefabAccessBlocker(access);
  let download=false;
  const mode = await DialogV2.wait({window:{title:'Import Prefab'},modal:true,
    content:`<p><strong>${escape(source.name)}</strong> · ${source.documents.length} members${access.premium?' · Requires premium':''}</p><p>${existing ? `A different version of <strong>${escape(existing.name)}</strong> is installed. Replace changes its library contents; placed copies stay unchanged.` : 'Adds this prefab to the local library. Ordinary artwork remains linked to its original sources.'}</p>
      <label><input type="checkbox" name="downloadRequiredAssets" ${blocked?'disabled':'checked'}> Download required assets</label>${blocked?`<p>${escape(blocked)}</p>`:''}`,
    buttons:[...(existing ? [{action:'copy',label:'Import as Copy',default:true},{action:'replace',label:'Replace Existing'}] : [{action:'new',label:'Import',default:true}]),{action:'cancel',label:'Cancel'}].map(button=>({...button,callback:(_event,_button,dialog)=>{download=!blocked&&dialog.element.querySelector('[name="downloadRequiredAssets"]').checked;return button.action;}})),rejectClose:false});
  if(!['new','copy','replace'].includes(mode))return null;
  const result = await importLocalPrefab(bundle,{mode,expectedHash:existing?.hash});
  if(result.unchanged)ui.notifications.info('This Prefab is already installed.');
  if(download){
    const notice=beginPrefabPreparationNotice(result.record.name);
    try{await runPrefabLibraryAction('prepare',result.record.id,{onProgress:notice.update});}
    catch(cause){throw Object.assign(new Error(`Prefab imported, but preparation failed: ${cause.userMessage||cause.message}`,{cause}),{userMessage:`Prefab imported, but preparation failed: ${cause.userMessage||cause.message}`});}
    finally{notice.close();}
  }
  return result.record;
}

export async function openPrefabLibrary(){
  if(!game.user.isGM)throw new Error('Only a GM can open the Prefab library.');
  const app=globalThis.faNexus.open();
  if(!app.rendered)await app.render({force:true});
  await app._tabManager.switchToTab('prefabs');
  app.bringToFront();return app;
}
