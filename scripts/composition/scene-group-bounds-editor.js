import { createCanvasGestureSession } from '../canvas/canvas-gesture-session.js';
import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';
import { snapPlacementPoint, expandFrameToGrid, GRID_SNAP_SUBDIV_LABELS } from '../core/grid-snap-utils.js';
import { SceneGroupWorkflow, getSceneGroupFrame, getSceneGroupOrientedFrame } from './scene-group-workflow.js';
import { sceneGroupInteractionState } from './scene-group-interaction-state.js';
import { createSceneGroupTransformHandles, drawSceneGroupTransformHandles, sceneGroupHandleLayout } from './scene-group-transform-handles.js';

let active=null;
export function cancelSceneGroupBoundsEdit() { if(!active)return false;active.cancel();return true; }
const copy=value=>structuredClone(value);
const stop=event=>{event.preventDefault();event.stopPropagation();};
const rotate=(p,angle)=>{const r=angle*Math.PI/180;return {x:p.x*Math.cos(r)-p.y*Math.sin(r),y:p.x*Math.sin(r)+p.y*Math.cos(r)};};

export async function editSceneGroupBounds(groupId) {
  if(active){active.cancel();await active.done;}
  const scene=canvas.scene, workflow=new SceneGroupWorkflow();
  const selected=await workflow.execute({scene,user:game.user,action:{type:'select-group',groupId}});
  const documents=await Promise.all(selected.selection.memberUuids.map(uuid=>fromUuid(uuid)));
  if(documents.some(doc=>!doc))throw new Error('Reload the Scene before editing a group with missing items.');
  const original=getSceneGroupFrame(documents,selected.group);
  let frame=copy(original),drag=null,session,panHook,finished=false,resolve,reject;
  const snapHooks=[];
  const done=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const handles=createSceneGroupTransformHandles('fa-nexus-scene-group-bounds-editor');
  // The bar is dark whatever the page's colour scheme, so its controls take Foundry's dark theme.
  const bar=document.createElement('section');bar.className='fa-nexus-prefab-placement fa-nexus-bounds-editor themed theme-dark';
  bar.dataset.faNexusToolOverlay='true';bar.setAttribute('aria-label','Edit Scene Group Bounds');
  bar.innerHTML=`<span>Edit Bounds</span><label title="S toggles snapping; hold Shift to bypass it"><input type="checkbox" data-bounds-snap> Snap to grid</label>
    <select aria-label="Bounds snap spacing" data-bounds-spacing>${GRID_SNAP_SUBDIV_LABELS.map((label,index)=>`<option value="${index}">${label}</option>`).join('')}</select>
    <button type="button" data-bounds-fit>Fit Contents</button>
    <button type="button" data-bounds-expand="2" title="Expand outwards to half-square lines along the bounds axes">Expand ½ grid</button>
    <button type="button" data-bounds-expand="1" title="Expand outwards to full-square lines along the bounds axes">Expand full grid</button>
    <button type="button" data-bounds-accept>Accept</button><button type="button" data-bounds-cancel>Cancel</button>`;
  const finish=async(accept,error)=>{
    if(finished)return;finished=true;
    session?.stop('group-bounds-complete');if(panHook!==undefined)Hooks.off('canvasPan',panHook);
    for(const [event,id] of snapHooks)Hooks.off(event,id);
    handles.container.destroy({children:true});bar.remove();
    try{
      if(error)throw error;
      if(accept){
        if(canvas.scene!==scene)throw new Error('The Scene changed while editing bounds.');
        await workflow.execute({scene,user:game.user,action:{type:'set-group-bounds',groupId,expectedFrame:original,
          bounds:{center:frame.center,width:frame.width,height:frame.height}}});
      }
      resolve(accept);
    }catch(cause){reject(cause);}
    finally{
      if(canvas.scene===scene&&scene.getFlag('fa-nexus','compositionRegistry')?.groups[groupId])sceneGroupInteractionState.selectGroup(scene,groupId);
      if(active?.done===done)active=null;
    }
  };
  const draw=()=>{
    drawSceneGroupTransformHandles(handles,frame,frame.center,{boundsOnly:true});
    const points=sceneGroupHandleLayout(frame).corners.map(p=>canvas.stage.toGlobal(p));
    const rect=canvas.app.view.getBoundingClientRect(),screen=canvas.app.renderer.screen;
    const xs=points.map(p=>rect.left+p.x*rect.width/screen.width),ys=points.map(p=>rect.top+p.y*rect.height/screen.height);
    bar.style.left=`${Math.round(Math.max(rect.left+8,Math.min((Math.min(...xs)+Math.max(...xs)-bar.offsetWidth)/2,rect.right-bar.offsetWidth-8)))}px`;
    const bottom=Math.max(...ys)+10;
    bar.style.top=`${Math.round(Math.max(rect.top+8,Math.min(bottom,rect.bottom-bar.offsetHeight-8)))}px`;
    handles.container.faNexusSceneGroupFrame=copy(frame);
  };
  const snap=(point,event)=>snapPlacementPoint(point,{enabled:!event.shiftKey&&toolOptionsController.isGridSnapEnabled(),
    gridSize:scene.grid.size,subdivisions:toolOptionsController.getGridSnapSubdivisions()});
  const move=(event,pointer)=>{
    if(!drag||!pointer.world)return false;
    const start=drag.frame,corner=sceneGroupHandleLayout(start).corners[0];
    if(drag.kind==='move'){
      const target=snap({x:corner.x+pointer.world.x-drag.origin.x,y:corner.y+pointer.world.y-drag.origin.y},event);
      frame={...start,center:{x:start.center.x+target.x-corner.x,y:start.center.y+target.y-corner.y}};
    }else{
      const opposite=sceneGroupHandleLayout(start).corners[(drag.index+2)%4],target=snap(pointer.world,event);
      const local=rotate({x:target.x-opposite.x,y:target.y-opposite.y},-start.angle);
      const size={x:Math.sign(local.x||1)*Math.max(1,Math.abs(local.x)),y:Math.sign(local.y||1)*Math.max(1,Math.abs(local.y))};
      const offset=rotate({x:size.x/2,y:size.y/2},start.angle);
      frame={...start,center:{x:opposite.x+offset.x,y:opposite.y+offset.y},width:Math.abs(size.x),height:Math.abs(size.y)};
    }
    draw();stop(event);return true;
  };
  active={cancel:()=>finish(false),done};
  sceneGroupInteractionState.clear(scene,'edit-bounds');
  canvas.interface.addChild(handles.container);document.body.append(bar);
  bar.querySelector('[data-bounds-accept]').addEventListener('click',()=>finish(true));
  bar.querySelector('[data-bounds-cancel]').addEventListener('click',()=>finish(false));
  bar.querySelector('[data-bounds-fit]').addEventListener('click',()=>{frame=getSceneGroupOrientedFrame(documents,original.angle);draw();});
  const syncSnap=()=>{
    bar.querySelector('[data-bounds-snap]').checked=toolOptionsController.isGridSnapEnabled();
    bar.querySelector('[data-bounds-spacing]').value=String(toolOptionsController.getGridSnapSubdivisions());
  };
  bar.querySelector('[data-bounds-snap]').addEventListener('change',event=>void toolOptionsController.requestGridSnapToggle(event.target.checked));
  bar.querySelector('[data-bounds-spacing]').addEventListener('change',event=>void toolOptionsController.requestGridSnapSubdivisionChange(Number(event.target.value)));
  for(const button of bar.querySelectorAll('[data-bounds-expand]')){
    button.disabled=!(scene.grid.size>0);
    button.addEventListener('click',()=>{frame=expandFrameToGrid(frame,scene.grid.size/Number(button.dataset.boundsExpand));draw();});
  }
  for(const event of ['fa-nexus:gridSnapChanged','fa-nexus:gridSnapSubdivisionsChanged'])snapHooks.push([event,Hooks.on(event,syncSnap)]);
  syncSnap();
  try{
    session=createCanvasGestureSession({
      pointerdown:(event,{pointer})=>{
        if(event.button!==0||!pointer.overCanvas||!pointer.zOk)return false;
        stop(event);const layout=sceneGroupHandleLayout(frame);
        const index=layout.corners.findIndex(p=>Math.abs(p.x-pointer.world.x)<layout.handleSize&&Math.abs(p.y-pointer.world.y)<layout.handleSize);
        const inside=new PIXI.Polygon(layout.corners.flatMap(p=>[p.x,p.y])).contains(pointer.world.x,pointer.world.y);
        if(index>=0||inside)drag={kind:index>=0?'resize':'move',index,origin:{...pointer.world},frame:copy(frame)};
        return true;
      },
      pointermove:(event,{pointer})=>move(event,pointer),
      pointerup:(event,{pointer})=>{if(event.button!==0||!drag)return false;move(event,pointer);drag=null;return true;},
      pointercancel:()=>{if(drag){frame=drag.frame;drag=null;draw();}return true;},
      keydown:event=>{
        if(event.key==='Escape'||event.key==='Enter'){stop(event);finish(event.key==='Enter');return true;}
        if(event.key.toLowerCase()==='s'&&!event.ctrlKey&&!event.altKey&&!event.metaKey){stop(event);if(!event.repeat)void toolOptionsController.toggleGridSnapShortcut();return true;}
        return false;
      }
    },{exclusiveInput:true,lockPlaceableInteractivity:true,onStop:()=>finish(false),onCanvasTearDown:()=>finish(false),onHandlerError:error=>{finish(false,error);return true;}});
    panHook=Hooks.on('canvasPan',draw);draw();
  }catch(error){finish(false,error);}
  return done;
}
