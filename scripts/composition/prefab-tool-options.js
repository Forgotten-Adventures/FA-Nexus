import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';
import { createNormalizedToolOptionsDescriptor } from '../core/tool-options/tool-options-descriptor.js';
import { addDeclarativeScalarControl, addDeclarativeSelectControl, addDeclarativeAxisTogglePairControl } from '../core/tool-options/tool-options-control-builders.js';

const TOOL='prefab.placement';
export function createPrefabToolOptions(state,{name,label='Prefab Placement',gridCompatible,reflectionBlocker,change}) {
  const sync=()=>{
    const controls={},ids=[];
    ids.push(addDeclarativeSelectControl(controls,{id:'prefab-size-mode',label:'Size',handlerId:'setMode',state:{value:state.mode,
      options:[{value:'grid',label:'Match grid',disabled:!gridCompatible},{value:'pixels',label:'Original pixels'}]}}));
    ids.push(addDeclarativeScalarControl(controls,{id:'prefab-scale',label:'Scale',ariaLabel:'Prefab scale',handlerId:'setScale',variant:'scale',
      state:{available:true,min:1,max:500,step:1,value:state.scale*100,defaultValue:100,display:`${Math.round(state.scale*100)}%`}}));
    ids.push(addDeclarativeScalarControl(controls,{id:'prefab-rotation',label:'Rotation',ariaLabel:'Prefab rotation',handlerId:'setRotation',variant:'rotation',
      state:{available:true,min:0,max:359,step:1,wrap:true,value:((state.rotation%360)+360)%360,defaultValue:0,display:`${Math.round(((state.rotation%360)+360)%360)}°`}}));
    ids.push(addDeclarativeAxisTogglePairControl(controls,{id:'prefab-flip',label:'Flip / Mirror',horizontalHandlerId:'flipX',verticalHandlerId:'flipY',
      state:{available:true,randomHint:reflectionBlocker||'',
        horizontal:{active:state.flipX,label:'Flip H',aria:'Flip horizontally',disabled:!!reflectionBlocker,tooltip:reflectionBlocker||'Flip horizontally',randomButtonVisible:false},
        vertical:{active:state.flipY,label:'Flip V',aria:'Flip vertically',disabled:!!reflectionBlocker,tooltip:reflectionBlocker||'Flip vertically',randomButtonVisible:false}}}));
    const descriptor=createNormalizedToolOptionsDescriptor({descriptor:{toolId:TOOL,toolLabel:label,selectionSummary:name},controls,
      sections:[{id:'appearance',label:'Placement',controls:ids}],handlers:{
        setMode:value=>change({mode:value}),setScale:value=>change({scale:Math.max(.01,Number(value)/100)}),
        setRotation:value=>change({rotation:((Number(value)%360)+360)%360}),
        flipX:()=>change({flipX:!state.flipX}),flipY:()=>change({flipY:!state.flipY})},
      shortcuts:[{id:'scale',binding:'Shift+Wheel',label:'Scale'},{id:'rotate',binding:'Ctrl/Cmd+Wheel',label:'Rotate (Shift: 1°)'},
        {id:'grid',binding:'S / S+Wheel',label:'Grid snap / density'},{id:'accept',binding:'Enter',label:'Accept'},{id:'cancel',binding:'Escape',label:'Cancel'}]});
    toolOptionsController.setToolOptions(TOOL,{...descriptor,suppressRender:true});
  };
  sync();toolOptionsController.activateTool(TOOL,{label});
  return {sync,destroy:()=>toolOptionsController.deactivateTool(TOOL)};
}
