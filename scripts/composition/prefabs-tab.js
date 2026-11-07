import { GridBrowseTab } from '../core/ui/grid-browse-tab.js';
import { listLocalPrefabs, readLocalPrefab, inspectPrefabAccess } from './prefab-library.js';
import { createPrefabCatalogLookup, prefabAccessBlocker, beginPrefabPreparationNotice } from './prefab-content-access.js';
import { runPrefabLibraryAction, saveGroupPrefab, cancelPrefabPlacement, importPrefabFile } from './prefab-ui.js';
import { notifySceneGroupFailure } from './scene-group-notifications.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { PrefabPreviewManager } from './prefab-preview-manager.js';
import { createPrefabThumbnail } from './prefab-thumbnail.js';
import { SCENE_GROUP_DRAG_MIME, readSceneGroupDropData } from './scene-group-drag-data.js';

// Foundry's ContextMenu entries have no native disabled state.
class PrefabContextMenu extends foundry.applications.ux.ContextMenu {
  async _onRenderEntries(menu,options){
    await super._onRenderEntries(menu,options);
    for(const entry of this.menuItems)if(entry.element&&entry.disabled!==undefined){
      entry.element.setAttribute('aria-disabled',String(entry.disabled));
      entry.element.title=entry.disabled?entry.disabledReason:'';
    }
  }
  _onClickItem(event,options){
    if(event.target.closest('[aria-disabled="true"]')){event.preventDefault();event.stopPropagation();return;}
    return super._onClickItem(event,options);
  }
}

export class PrefabsTab extends GridBrowseTab {
  get id(){return 'prefabs';}
  createPreviewManager(){return new PrefabPreviewManager();}
  getGridOptions(){return {rowHeight:40,overscan:3,card:{width:this._thumbSize||128,height:this._thumbSize||128,gap:4},
    createRow:item=>this._card(item)};}
  filterItems(items,query){const q=String(query||'').toLowerCase();return (this.app._collections?.filter(items,this.id)||items).filter(item=>item.name.toLowerCase().includes(q));}
  getStats(){return {shown:this.app._grid?.items.length||0,total:this._items.length};}
  bindFooter(){
    this._footerControls=Array.from(this.app.element.querySelectorAll('.fa-nexus-footer-control')).map(element=>({element,display:element.style.display}));
    for(const {element} of this._footerControls)element.style.display='none';
  }
  unbindFooter(){
    for(const {element,display} of this._footerControls||[])element.style.display=display;
    this._footerControls=null;
  }
  async onActivate(){
    this._thumbSize=Math.min(200,Math.max(64,Number(game.settings.get('fa-nexus','thumbWidthPrefabs'))||128));
    await super.onActivate();
    if(this.app?._activeTab!==this.id)return;
    this._removeBindings();
    this._releaseThumbnails();
    this._active=true;
    this._importButton=document.createElement('button');
    Object.assign(this._importButton,{type:'button',className:'fa-nexus-icon-button',title:'Import Prefab'});
    this._importButton.setAttribute('aria-label','Import Prefab');this._importButton.innerHTML='<i class="fa-solid fa-file-import"></i>';
    this._importInput=document.createElement('input');Object.assign(this._importInput,{type:'file',accept:'.fanxprefab',hidden:true});
    this._importButton.addEventListener('click',()=>this._importInput.click());
    this._importInput.addEventListener('change',async()=>{
      const file=this._importInput.files[0];if(!file||this._importing)return;
      this._importing=true;this._importButton.disabled=true;
      try{await importPrefabFile(file);}catch(error){Logger.error('PrefabsTab.import.failed',{error:String(error)});if(error.userMessage)ui.notifications.error(error.userMessage);else notifySceneGroupFailure(error,'Could not import Prefab');}
      finally{this._importing=false;if(this._importButton)this._importButton.disabled=false;if(this._importInput)this._importInput.value='';}
    });
    this.app.element.querySelector('.fa-nexus-folder-toggle').before(this._importButton,this._importInput);
    this._thumbnailUrls=new Map();
    const grid=this.getGridContainer();
    const accepts=event=>Array.from(event.dataTransfer?.types||[]).includes(SCENE_GROUP_DRAG_MIME);
    this._dropHandlers={
      dragover:event=>{if(!accepts(event))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';grid.classList.add('fa-nexus-prefab-drop');},
      dragleave:event=>{if(!grid.contains(event.relatedTarget))grid.classList.remove('fa-nexus-prefab-drop');},
      drop:event=>{
        if(!accepts(event))return;
        event.preventDefault();event.stopPropagation();grid.classList.remove('fa-nexus-prefab-drop');
        void this._saveDrop(event);
      }
    };
    for(const [event,handler] of Object.entries(this._dropHandlers))grid.addEventListener(event,handler);
    this._authHook=Hooks.on('updateSetting',setting=>{if(setting.key==='fa-nexus.patreon_auth_data'||setting.namespace==='fa-nexus'&&setting.key==='patreon_auth_data')this._repaintAccess();});
    this._hook=Hooks.on('fa-nexus-prefab-library-changed',()=>this._action('refresh'));
    await this.refresh();
  }
  async refresh(){
    const entries=await listLocalPrefabs();if(!this._active)return;
    this._closeContextMenu();this._preview?.hidePreview();this._releaseThumbnails();
    this._items=entries.sort((a,b)=>a.name.localeCompare(b.name));this.applySearch(this.getCurrentSearchValue());
    void this._loadContentAccess(this._items);
  }
  async _loadContentAccess(items){
    const lookup=createPrefabCatalogLookup(this.app._contentService),listings=new Map();
    const generation=this._contentCheckGeneration=(this._contentCheckGeneration||0)+1;
    for(const item of items){
      if(!this._active||this._items!==items||this._contentCheckGeneration!==generation)return;
      let access;
      try{if(!item.contentRefs||!item.previewBounds){const record=await readLocalPrefab(item.id);item.contentRefs=record.contentRefs||[];item.previewBounds=record.previewBounds;item.grid=record.grid;}access=await inspectPrefabAccess(item,{lookup,listings});}
      catch(error){access={unknown:1,error:true};Logger.error('PrefabsTab.contentCheck.failed',{id:item.id,error:String(error)});}
      if(!this._active||this._items!==items||this._contentCheckGeneration!==generation)return;
      item._access=access;
      for(const card of this.getGridContainer()?.querySelectorAll(`[data-prefab-id="${item.id}"]`)||[])this._paintContentAccess(card,item);
    }
  }
  _repaintAccess(){this._closeContextMenu();for(const item of this._items)for(const card of this.getGridContainer()?.querySelectorAll(`[data-prefab-id="${item.id}"]`)||[])this._paintContentAccess(card,item);}
  _paintContentAccess(card,item){
    card.querySelector('.fa-nexus-prefab-access')?.remove();
    const access=item._access,blocked=prefabAccessBlocker(access);
    card.setAttribute('aria-disabled',String(!!blocked));card.title=blocked||`Place ${item.name}`;
    if(item.previewBounds&&item.grid?.size){card.dataset.gridW=item.previewBounds.width/item.grid.size;card.dataset.gridH=item.previewBounds.height/item.grid.size;}
    this._preview?.refreshGrid(card);
    card.setAttribute('aria-label',`Place ${item.name}${access?.premium?' (contains premium artwork)':''}`);
    const badge=document.createElement('span');badge.className='fa-nexus-prefab-access';
    badge.textContent=access?.unknown?'Content not verified':access?.missingPremium?'Premium download required'
      :access?.missingCount?'Download required':access?'Available locally':'Checking content…';
    badge.title=blocked||(access?.missingCount?'Missing artwork will be downloaded before placement.'
      :`${access?.premium?'Contains premium artwork. ':''}Required FA artwork is installed; no Patreon connection is needed.`);
    card.append(badge);
  }
  async _saveDrop(event){
    if(this._savingDrop)return;
    this._savingDrop=true;this._preview?.hidePreview();
    try{
      const {groupIds,sceneId}=readSceneGroupDropData(event);
      if(sceneId!==canvas.scene?.id)throw new Error('Return to the source Scene before saving this Prefab.');
      if(!groupIds.length)throw new Error('Drag a Scene Group to save a Prefab.');
      await saveGroupPrefab(groupIds);
    }catch(error){Logger.error('PrefabsTab.drop.failed',{error:String(error)});notifySceneGroupFailure(error,'Could not save Prefab');}
    finally{this._savingDrop=false;}
  }
  _updateEmptyState(){
    super._updateEmptyState();
    const empty=this.app.element?.querySelector('.fa-nexus-empty-state');
    if(empty&&!this.getCurrentSearchValue())empty.textContent=this.app._collections?.active&&this.app._collections.state.selectedId
      ? 'No prefabs in this Collection' : 'Drag a Scene Group here to save a prefab';
  }
  async _action(action,id){
    this._preview?.hidePreview();
    const preparingAction=['place','prepare'].includes(action);
    if(preparingAction&&this._preparing)return;
    if(preparingAction){const blocker=prefabAccessBlocker(this._items.find(item=>item.id===id)?._access);if(blocker){ui.notifications.warn(blocker);return;}}
    let preparing,notification;
    const ready=()=>{
      if(notification){notification.close();notification=null;}
      preparing?.signal.removeEventListener('abort',ready);
      if(preparing&&this._preparing===preparing){this._preparing=null;this.getGridContainer()?.removeAttribute('aria-busy');}
    };
    try{
      if(action==='refresh')return await this.refresh();
      if(preparingAction){
        preparing=this._preparing=new AbortController();this.getGridContainer()?.setAttribute('aria-busy','true');
        const name=this._items.find(item=>item.id===id)?.name;
        notification=beginPrefabPreparationNotice(name);
        preparing.signal.addEventListener('abort',ready,{once:true});
        await runPrefabLibraryAction(action,id,{signal:preparing.signal,onReady:ready,onProgress:progress=>notification?.update(progress)});
      }else await runPrefabLibraryAction(action,id);
    }
    catch(error){if(error.name!=='AbortError'){Logger.error('PrefabsTab.action.failed',{action,id,error:String(error),cause:String(error.cause||'')});
      if(error.userMessage)ui.notifications.error(error.userMessage);else notifySceneGroupFailure(error,'Prefab action failed');}}
    finally{ready();if(preparingAction&&this._active)void this._loadContentAccess(this._items);}
  }
  _card(item){
    const card=document.createElement('div');card.className='fa-nexus-card fa-nexus-prefab-card';card.dataset.prefabId=item.id;card.dataset.name=item.name;card.tabIndex=0;
    card.dataset.url=`${foundry.utils.getRoute(item.preview)}?v=${item.hash}`;
    card.setAttribute('role','button');card.setAttribute('aria-label',`Place ${item.name}`);
    const img=document.createElement('img');img.src=`${foundry.utils.getRoute(item.thumbnail)}?v=${item.hash}`;img.alt=item.name;img.draggable=false;
    if(item.thumbnailVersion!==2)img.addEventListener('load',()=>this._cropLegacyThumbnail(img,item),{once:true});
    const label=document.createElement('span');label.className='fa-nexus-card-name';label.textContent=item.name;
    card.append(img,label);card.addEventListener('click',()=>this._action('place',item.id));
    this._paintContentAccess(card,item);
    card.addEventListener('keydown',event=>{if(event.target!==card||!['Enter',' '].includes(event.key))return;event.preventDefault();this._action('place',item.id);});
    const context=new PrefabContextMenu(card,'.fa-nexus-prefab-card',[
      {label:'Prepare required assets',icon:'fa-solid fa-download',classes:'fa-nexus-prefab-prepare',
        get disabled(){return !!prefabAccessBlocker(item._access);},get disabledReason(){return prefabAccessBlocker(item._access);},onClick:()=>this._action('prepare',item.id)},
      {label:'Save as Prefab…',icon:'fa-solid fa-box-archive',onClick:()=>this._action('save-as',item.id)},
      {label:'Add to Collection…',icon:'fa-solid fa-folder-plus',condition:()=>!!this.app._collections,onClick:()=>this.app._collections.run(()=>this.app._collections.addSelected([{type:'prefab',id:item.id}]))},
      {label:'Rename',icon:'fa-solid fa-i-cursor',onClick:()=>this._action('rename',item.id)},
      {label:'Export Prefab…',icon:'fa-solid fa-file-export',onClick:()=>this._action('export',item.id)},
      {label:'Delete',icon:'fa-solid fa-trash',onClick:()=>this._action('delete',item.id)}
    ],{jQuery:false,fixed:true,onOpen:()=>{this._preview?.hidePreview();this._contextMenu=context;}});
    return card;
  }
  async _cropLegacyThumbnail(img,item){
    const cache=this._thumbnailUrls;if(!cache)return;
    const key=`${item.id}:${item.hash}`;
    try{
      if(!cache.has(key))cache.set(key,createPrefabThumbnail(img).then(blob=>{
        if(this._thumbnailUrls!==cache)return null;
        return URL.createObjectURL(blob);
      }));
      const url=await cache.get(key);if(url&&img.isConnected&&this._thumbnailUrls===cache)img.src=url;
    }catch(error){Logger.error('PrefabsTab.thumbnail.failed',{id:item.id,error:String(error)});notifySceneGroupFailure(error,'Could not crop Prefab thumbnail');}
  }
  _releaseThumbnails(){
    for(const pending of this._thumbnailUrls?.values()||[])pending.then(url=>{if(url)URL.revokeObjectURL(url);},()=>{});
    this._thumbnailUrls=this._active?new Map():null;
  }
  _closeContextMenu(){this._contextMenu?.close({animate:false});this._contextMenu=null;}
  _bindThumbSizeSlider(){
    let input=this.app.element.querySelector('#fa-nexus-thumb-size');if(!input)return;
    const next=input.cloneNode(true);input.replaceWith(next);input=next;
    Object.assign(input,{min:64,max:200,step:2,value:this._thumbSize||128});
    input.addEventListener('input',()=>{this._thumbSize=Number(input.value);this.app._grid.setCardSize(this._thumbSize,this._thumbSize);});
    input.addEventListener('change',()=>game.settings.set('fa-nexus','thumbWidthPrefabs',this._thumbSize));
  }
  _removeBindings(){
    this._importButton?.remove();this._importInput?.remove();this._importButton=null;this._importInput=null;
    const grid=this.getGridContainer();
    for(const [event,handler] of Object.entries(this._dropHandlers||{}))grid?.removeEventListener(event,handler);
    grid?.classList.remove('fa-nexus-prefab-drop');this._dropHandlers=null;
    if(this._authHook!==undefined)Hooks.off('updateSetting',this._authHook);this._authHook=undefined;
    if(this._hook!==undefined)Hooks.off('fa-nexus-prefab-library-changed',this._hook);this._hook=undefined;
  }
  onDeactivate(){
    this._preparing?.abort();
    this._removeBindings();
    this._closeContextMenu();this._active=false;this._releaseThumbnails();
    cancelPrefabPlacement();super.onDeactivate();
  }
  destroy(){this.onDeactivate();}
}
