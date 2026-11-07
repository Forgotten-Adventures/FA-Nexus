import { planCompositionPlacement, placeComposition, prefabGridScale } from './scene-group-copy-runtime.js';
import { sceneGroupHandleLayout, createSceneGroupTransformHandles, drawSceneGroupTransformHandles } from './scene-group-transform-handles.js';
import { CompositionPlacementPreview } from './composition-placement-preview.js';
import { createCanvasGestureSession } from '../canvas/canvas-gesture-session.js';
import { createPrefabToolOptions } from './prefab-tool-options.js';
import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';
import { snapPlacementPoint } from '../core/grid-snap-utils.js';
import { compositionReflectionBlocker } from './composition-reflection.js';
import { getZoomAtCursorView } from '../canvas/canvas-pointer-utils.js';

let active = null;
export function isPrefabPlacementActive() { return active !== null; }
export function cancelPrefabPlacement() { if (!active) return false; active.cancel(); return true; }
const stop = event => {event.preventDefault();event.stopImmediatePropagation();};
const rotate = (p, angle) => {const a=angle*Math.PI/180;return {x:p.x*Math.cos(a)-p.y*Math.sin(a),y:p.x*Math.sin(a)+p.y*Math.cos(a)};};

export function defaultPrefabSizeMode(snapshot, scene) {
  return snapshot.grid.type && snapshot.grid.type===scene.grid.type && snapshot.grid.units===scene.grid.units
    && snapshot.grid.distance===scene.grid.distance ? 'grid' : 'pixels';
}

/** One staged placement. Accept is the only route to persistent Scene creation. */
export async function beginPrefabPlacement(snapshot, {scene=canvas.scene,levelId=canvas.level?.id,
  mode=defaultPrefabSizeMode(snapshot,scene),label='Prefab Placement',onReady,signal}={}) {
  signal?.throwIfAborted();
  const { getTileFlattenManager } = await import('../layers/layer-manager-tab.js');
  signal?.throwIfAborted();
  if (getTileFlattenManager().isBusy()) {
    throw new Error('Finish the active Flatten or capture operation before placing a Prefab.');
  }
  if (active) {active.cancel();await active.done;}
  signal?.throwIfAborted();
  if (!canvas.ready || canvas.scene!==scene || canvas.level?.id!==levelId) throw new Error('Open the destination Scene and Level before pasting.');
  const start = {...canvas.mousePosition};
  if (![start.x,start.y].every(Number.isFinite)) Object.assign(start,{x:scene.dimensions.sceneX+scene.width/2,y:scene.dimensions.sceneY+scene.height/2});
  start.x=Math.round(start.x);start.y=Math.round(start.y);
  const state = {point:start,scale:1,rotation:0,mode,flipX:false,flipY:false};
  const baseFactor=prefabGridScale(snapshot,scene,mode);
  let preview,session,graphics,handles,panHook,frameRequest,options,drag=null,panning=false,anchored=false,finished=false,ready=false,sHeld=false,sToggle=false;
  const snapHooks=[];
  let snapInput={point:start,bypass:false};
  let resolve,reject,drawPromise;
  const done=new Promise((yes,no)=>{resolve=yes;reject=no;});
  // The bar is dark whatever the page's colour scheme, so its controls take Foundry's dark theme.
  const bar=document.createElement('section');bar.className='fa-nexus-prefab-placement themed theme-dark';
  bar.setAttribute('aria-label','Prefab placement');
  bar.dataset.faNexusToolOverlay='true';bar.hidden=true;
  bar.innerHTML=`<button type="button" data-placement-accept disabled><i class="fa-solid fa-check"></i> Accept</button><button type="button" data-placement-cancel>Cancel</button>`;
  document.body.append(bar);
  const effectiveScale=()=>state.scale*prefabGridScale(snapshot,scene,state.mode)/baseFactor;
  const snappedPoint=()=>{
    const anchor=preview?.customBounds ? geometry().corners[0] : state.point;
    const offset={x:anchor.x-state.point.x,y:anchor.y-state.point.y};
    const point=snapPlacementPoint({x:snapInput.point.x+offset.x,y:snapInput.point.y+offset.y},
      {enabled:!snapInput.bypass&&toolOptionsController.isGridSnapEnabled(),gridSize:scene.grid.size,subdivisions:toolOptionsController.getGridSnapSubdivisions()});
    return {x:point.x-offset.x,y:point.y-offset.y};
  };
  const pointFor=(event,pointer)=>{snapInput={point:{...pointer.world},bypass:event.shiftKey};return snappedPoint();};
  const geometry=()=>{
    const f=preview.frame,scale=effectiveScale();
    const project=p=>{const v=rotate({x:(p.x-start.x)*scale*(state.flipX?-1:1),y:(p.y-start.y)*scale*(state.flipY?-1:1)},state.rotation);return {x:v.x+state.point.x,y:v.y+state.point.y};};
    const center=project(f.center);
    const frame={center,width:f.width*scale,height:f.height*scale,angle:state.rotation+(state.flipX!==state.flipY?-f.angle:f.angle)};
    return {...sceneGroupHandleLayout(frame),frame,center};
  };
  const drawFrame=()=>{
    if(!ready||finished)return;
    drawSceneGroupTransformHandles(handles,geometry().frame,state.point);
    positionBar();
  };
  const positionBar=()=>{
    if(!anchored||!ready||finished)return;
    bar.hidden=false;
    const rect=canvas.app.view.getBoundingClientRect(),screen=canvas.app.renderer.screen;
    const points=geometry().corners.map(p=>canvas.stage.toGlobal(p)).map(p=>({x:rect.left+p.x*rect.width/screen.width,y:rect.top+p.y*rect.height/screen.height}));
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y),width=bar.offsetWidth,height=bar.offsetHeight;
    // Keep the action bar below the artwork, clamping to the viewport for an
    // offscreen lower edge. Putting it above the box covers the rotation handle.
    const top=Math.max(...ys)+10;
    bar.style.left=`${Math.round(Math.max(rect.left+8,Math.min((Math.min(...xs)+Math.max(...xs)-width)/2,rect.right-width-8)))}px`;
    bar.style.top=`${Math.round(Math.max(rect.top+8,Math.min(top,rect.bottom-height-8)))}px`;
  };
  const flush=()=>{
    if(frameRequest)cancelAnimationFrame(frameRequest);frameRequest=null;
    if(!ready||finished)return;
    if(preview.update({...state,scale:effectiveScale()}) || (anchored&&bar.hidden))drawFrame();
  };
  const schedule=()=>{if(!frameRequest)frameRequest=requestAnimationFrame(()=>{try{flush();}catch(error){finish(false,error);}});};
  const finish=async(accept,error)=>{
    if(finished)return;
    if(accept&&!ready)return;
    try {if(accept)flush();} catch(cause){error=cause;accept=false;}
    finished=true;bar.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);
    signal?.removeEventListener('abort',abort);
    if(frameRequest)cancelAnimationFrame(frameRequest);
    session?.stop('prefab-placement-complete');
    options?.destroy();
    if(panHook!==undefined)Hooks.off('canvasPan',panHook);
    for(const [name,id] of snapHooks)Hooks.off(name,id);
    try {
      try { await drawPromise; } catch(cause) { error ||= cause; }
      try { await preview?.destroy(); } catch(cause) { error ||= cause; }
      if(graphics&&!graphics.destroyed)graphics.destroy({children:true});bar.remove();
      if(error)throw error;
      if(accept && (canvas.scene!==scene || canvas.level?.id!==levelId))throw new Error('The destination changed. Place the group again.');
      let result=null;
      if(accept) {
        try {result=await placeComposition(snapshot,scene,{...state,levelId});}
        catch(cause) {
          if(cause.cleanup && await foundry.applications.api.DialogV2.confirm({window:{title:'Clean Up Incomplete Placement'},
            content:`<p>Placement failed. Remove the remaining objects created by this attempt?</p><ul>${cause.residue.map(uuid=>`<li>${foundry.utils.escapeHTML(uuid)}</li>`).join('')}</ul>`,
            yes:{label:'Retry Cleanup'},rejectClose:false})) await cause.cleanup();
          throw cause;
        }
      }
      resolve(result);
    } catch(cause){bar.remove();reject(cause);}
    finally{if(active?.done===done)active=null;}
  };
  active={cancel:()=>finish(false),done};
  const abort=()=>finish(false);
  signal?.addEventListener('abort',abort,{once:true});
  bar.querySelector('[data-placement-cancel]').addEventListener('click',()=>finish(false));
  bar.querySelector('[data-placement-accept]').addEventListener('click',()=>finish(true));
  const change=values=>{
    if(finished)return;
    if('scale' in values)values.scale=Math.min(5,Math.max(.01,values.scale));
    Object.assign(state,values);options?.sync();schedule();
  };
  session=createCanvasGestureSession({
    pointerdown:(event,{pointer})=>{
      if(event.button===2&&pointer.overCanvas&&pointer.zOk){panning=true;return false;}
      if(event.button!==0||!pointer.overCanvas||!pointer.zOk||!ready)return false;
      stop(event);
      if(!anchored){state.point=pointFor(event,pointer);anchored=true;schedule();return true;}
      const g=geometry(),hit=p=>Math.hypot(p.x-pointer.world.x,p.y-pointer.world.y)<g.hitRadius;
      const cornerHit=g.corners.some(p=>Math.abs(p.x-pointer.world.x)<g.handleSize&&Math.abs(p.y-pointer.world.y)<g.handleSize);
      const kind=hit(g.rotationHandle)?'rotate':cornerHit?'scale':hit(state.point)||new PIXI.Polygon(g.corners.flatMap(p=>[p.x,p.y])).contains(pointer.world.x,pointer.world.y)?'move':null;
      if(kind)drag={kind,origin:{...pointer.world},point:{...state.point},scale:state.scale,rotation:state.rotation};
      return true;
    },
    pointermove:(event,{pointer})=>{
      if(panning||(event.buttons&2)||!ready||!pointer.world||(!drag&&(!pointer.overCanvas||!pointer.zOk)))return false;
      if(!anchored){state.point=pointFor(event,pointer);schedule();return true;}
      if(!drag)return false;
      if(drag.kind==='move')state.point=pointFor(event,{world:{x:drag.point.x+pointer.world.x-drag.origin.x,y:drag.point.y+pointer.world.y-drag.origin.y}});
      else if(drag.kind==='scale'){
        const distance=Math.hypot(drag.origin.x-drag.point.x,drag.origin.y-drag.point.y);
        state.scale=Math.min(5,Math.max(.01,drag.scale*Math.hypot(pointer.world.x-drag.point.x,pointer.world.y-drag.point.y)/Math.max(1,distance)));
        if(!event.shiftKey)state.scale=Math.round(state.scale*100)/100;
      }else{
        const a=Math.atan2(pointer.world.y-drag.point.y,pointer.world.x-drag.point.x)-Math.atan2(drag.origin.y-drag.point.y,drag.origin.x-drag.point.x);
        state.rotation=drag.rotation+a*180/Math.PI;
      }
      if(drag.kind!=='move')options?.sync();schedule();return true;
    },
    wheel:(event,{pointer})=>{
      if(!ready||!pointer.overCanvas||!pointer.zOk||event.altKey)return false;
      if(sHeld&&!event.ctrlKey&&!event.metaKey){stop(event);sToggle=false;void toolOptionsController.nudgeGridSnapSubdivision(event.deltaY<0?1:-1);return true;}
      if(event.ctrlKey||event.metaKey){stop(event);change({rotation:(state.rotation+(event.deltaY>0?1:-1)*(event.shiftKey?1:15)+360)%360});return true;}
      if(event.shiftKey){stop(event);change({scale:state.scale*Math.pow(1.05,event.deltaY<0?1:-1)});return true;}
      stop(event);
      const view=getZoomAtCursorView({canvasEl:pointer.canvas,screenX:pointer.screen.x,screenY:pointer.screen.y,
        targetScale:canvas.stage.scale.x*Math.pow(1.25,event.deltaY<0?1:-1)});
      if(view)void canvas.animatePan({...view,duration:50}).catch(error=>finish(false,error));
      return true;
    },
    pointerup:event=>{if(event.button===2){panning=false;return false;}if(event.button!==0||!drag)return false;drag=null;flush();stop(event);return true;},
    pointercancel:()=>{drag=null;panning=false;return true;},
    keydown:event=>{
      if(event.key==='Shift'&&ready&&!anchored){snapInput.bypass=true;state.point=snappedPoint();schedule();}
      if(event.key==='Escape'){stop(event);finish(false);return true;}
      if(event.key==='Enter'&&!event.target.closest?.('input,select,textarea')){stop(event);finish(true);return true;}
      if(event.key.toLowerCase()==='s'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.target.closest?.('input,select,textarea,[contenteditable=true]')){
        stop(event);if(!event.repeat){sHeld=true;sToggle=true;}return true;
      }
      return false;
    },
    keyup:event=>{
      if(event.key==='Shift'&&ready&&!anchored){snapInput.bypass=false;state.point=snappedPoint();schedule();}
      if(event.key.toLowerCase()!=='s'||!sHeld)return false;
      stop(event);sHeld=false;if(sToggle)void toolOptionsController.toggleGridSnapShortcut();sToggle=false;return true;
    }
  },{exclusiveInput:true,lockPlaceableInteractivity:true,onStop:()=>finish(false),onCanvasTearDown:()=>finish(false),onHandlerError:error=>{finish(false,error);return true;}});
  drawPromise=(async()=>{
    const plan=await planCompositionPlacement(snapshot,scene,{point:start,levelId,mode});
    if(finished)return;
    preview=new CompositionPlacementPreview(plan,scene,start);await preview.draw();
    if(finished)return;
    handles=createSceneGroupTransformHandles('fa-nexus-prefab-placement-handles');graphics=handles.container;canvas.interface.addChild(graphics);
    ready=true;drawFrame();
    options=createPrefabToolOptions(state,{name:snapshot.name,label,gridCompatible:defaultPrefabSizeMode(snapshot,scene)==='grid',reflectionBlocker:compositionReflectionBlocker(snapshot.documents),change});
    bar.dataset.ready='true';
    bar.querySelector('[data-placement-accept]').disabled=false;
    panHook=Hooks.on('canvasPan',drawFrame);
    for(const name of ['fa-nexus:gridSnapChanged','fa-nexus:gridSnapSubdivisionsChanged']){
      snapHooks.push([name,Hooks.on(name,()=>{if(!ready||finished)return;state.point=snappedPoint();schedule();})]);
    }
    onReady?.();
  })();
  drawPromise.catch(error=>finish(false,error));
  return done;
}
