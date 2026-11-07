import { transformScatterInstanceGeometry } from '../assets/asset-scatter-instance-transform.js';
const angle = value => ((value % 360) + 360) % 360;

// Current renderers reflect through their semantic authority. Legacy Building
// parts must first pass the existing V2 migration; they cannot be flipped alone.
export function compositionReflectionBlocker(documents) {
  for (const item of documents) {
    const type = item.type || item.documentName;
    const source = item.source || item;
    if (type !== 'Tile') continue;
    const flags = source.flags?.['fa-nexus'] || {};
    if (flags.building && ![4,5].includes(Number(flags.building.schemaVersion))) return 'Open and save this legacy Building in Building Editor V2 before mirroring.';
    if (flags.flattened?.tiles?.length) {
      const blocker = compositionReflectionBlocker(flags.flattened.tiles.map(entry => ({type:'Tile', source:entry.data})));
      if (blocker) return blocker;
    }
    if (['buildingComposite','buildingDoorFrame','buildingWindowFrame','buildingWindowWindow',
      'buildingWindowSill'].some(key => flags[key])) {
      return 'This prefab contains authored Tile geometry that cannot be mirrored yet.';
    }
  }
  return null;
}

/** Reflect native artwork and geometry together, including noncentral anchors. */
export function reflectCompositionMember(document, pivot, {flipX=false,flipY=false}) {
  const sx=flipX?-1:1,sy=flipY?-1:1,odd=sx!==sy;
  const point=p=>({x:pivot.x+(p.x-pivot.x)*sx,y:pivot.y+(p.y-pivot.y)*sy});
  // Native Tile/Wall/Light/Sound coordinates are integers. Resolve them before
  // projecting dependent artwork, so every output uses the pose Foundry saves.
  const nativePoint=p=>{
    const v=point(p),x=Math.round(v.x),y=Math.round(v.y);
    return {x:Object.is(x,-0)?0:x,y:Object.is(y,-0)?0:y};
  };
  const heading=r=>angle(Math.atan2(sy*Math.sin(r*Math.PI/180),sx*Math.cos(r*Math.PI/180))*180/Math.PI);
  const shape = source => {
    const next=structuredClone(source);
    if(next.type==='emanation'){next.base=shape(next.base);return next;}
    if(next.type==='polygon'){
      next.points=next.points.flatMap((v,i,a)=>i%2?[]:Object.values(point({x:v,y:a[i+1]})));
      if(next.origin)next.origin=point(next.origin);
    }else{
      if(!['rectangle','circle','ellipse','cone','ring','line'].includes(next.type))throw new Error(`Cannot flip Region shape ${next.type}.`);
      Object.assign(next,point(next));
      if(next.type==='rectangle') {
        next.rotation=odd?angle(-(next.rotation||0)):(next.rotation||0);
        if(flipX)next.anchorX=1-(next.anchorX||0);
        if(flipY)next.anchorY=1-(next.anchorY||0);
      } else if('rotation' in next)next.rotation=heading(next.rotation||0);
    }
    return next;
  };
  switch(document.documentName){
    case 'Tile': {
      const rotation=document.rotation ?? 0,texture=document.texture || {};
      const anchorX=texture.anchorX ?? .5,anchorY=texture.anchorY ?? .5;
      const target = {...nativePoint(document),rotation:odd?angle(-rotation):rotation,
      'texture.scaleX':(texture.scaleX ?? 1)*sx,'texture.scaleY':(texture.scaleY ?? 1)*sy,
      'texture.anchorX':flipX?1-anchorX:anchorX,
      'texture.anchorY':flipY?1-anchorY:anchorY};
      const flags = reflectTileFlags(document, target, pivot, {flipX,flipY});
      if(flags)target['flags.fa-nexus']=flags;
      return target;
    }
    case 'Wall': {
      const c=document.c.flatMap((v,i,a)=>i%2?[]:Object.values(nativePoint({x:v,y:a[i+1]})));
      return {c,...(odd?{dir:document.dir===1?2:document.dir===2?1:0}:{}),
        ...(odd&&document.animation?{'animation.direction':-document.animation.direction,'animation.flip':!document.animation.flip}:{})};
    }
    case 'AmbientLight': return {...nativePoint(document),rotation:angle(heading(document.rotation+90)-90)};
    case 'AmbientSound': return nativePoint(document);
    case 'Region': return {shapes:document.shapes.map(s=>shape(s.toObject()))};
    default: throw new Error(`Cannot flip ${document.documentName}.`);
  }
}

// Paths and scatter store authored Tile-local pixels, which their renderers
// deliberately counter-scale. Reflect that authority; generated Walls are
// reflected by the same aggregate planner. Building-local data stays immutable.
function reflectTileFlags(document, target, pivot, {flipX,flipY}) {
  const original=document.flags?.['fa-nexus'];
  if(!original)return null;
  const flags=structuredClone(original),sx=flipX?-1:1,sy=flipY?-1:1,odd=sx!==sy;
  const local=p=>({...p,x:flipX?document.width-p.x:p.x,y:flipY?document.height-p.y:p.y});
  const path=entry=>{
    const next=structuredClone(entry);
    // widthLeft/Right are incoming/outgoing knot widths, not strip sides.
    // Reflection preserves traversal and therefore preserves both widths.
    next.controlPoints=entry.controlPoints.map(local);
    if(odd){
      next.textureFlip={...entry.textureFlip,vertical:!entry.textureFlip?.vertical};
      if(next.textureOffset)next.textureOffset.y*=-1;
      if(next.shadow?.offset != null)next.shadow.offset*=-1;
    }
    if(next.shadow?.points)next.shadow.points=next.shadow.points.map(p=>({...local(p),...(odd&&p.offset!=null?{offset:-p.offset}:{})}));
    return next;
  };
  if(flags.pathV2)flags.pathV2=path(flags.pathV2);
  if(flags.pathsV2)flags.pathsV2.paths=flags.pathsV2.paths.map(path);
  if(flags.assetScatter)flags.assetScatter.instances=flags.assetScatter.instances.map(instance=>({
    ...transformScatterInstanceGeometry(instance,{a:sx,b:0,c:0,d:sy}),...local({x:instance.x,y:instance.y})
  }));
  const mask=entry=>{
    if(entry.regions)entry.regions=entry.regions.map(r=>({...r,maskedTiling:mask(r.maskedTiling)}));
    if(entry.maskWorld){
      const dx=target.x-document.x+document.width*((document.texture?.anchorX ?? .5)-target['texture.anchorX']);
      const dy=target.y-document.y+document.height*((document.texture?.anchorY ?? .5)-target['texture.anchorY']);
      if(entry.maskWorld.origin){entry.maskWorld.origin.x+=dx;entry.maskWorld.origin.y+=dy;}
      if(entry.maskWorld.tile)Object.assign(entry.maskWorld.tile,{x:target.x,y:target.y,rotation:target.rotation,
        anchorX:target['texture.anchorX'],anchorY:target['texture.anchorY']});
    }
    return entry;
  };
  if(flags.maskedTiling)flags.maskedTiling=mask(flags.maskedTiling);
  if(flags.flattened){
    const f=flags.flattened,world=p=>({x:pivot.x+(p.x-pivot.x)*sx,y:pivot.y+(p.y-pivot.y)*sy});
    f.transformGeometry ||= {};
    for(const key of ['logicalBounds','renderBounds']){
      const b=f[key];if(!b)continue;
      const corners=f.transformGeometry[key+'Corners'] || [{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}];
      const points=corners.map(world),xs=points.map(p=>p.x),ys=points.map(p=>p.y);
      f.transformGeometry[key+'Corners']=points;
      f[key]={...b,x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
    }
    if(f.originalPosition)f.originalPosition=world(f.originalPosition);
    f.wrapperTransform={...f.wrapperTransform,x:target.x,y:target.y,rotation:target.rotation,
      anchorX:target['texture.anchorX'],anchorY:target['texture.anchorY'],scaleX:target['texture.scaleX'],scaleY:target['texture.scaleY'],
      topLeftX:target.x-document.width*target['texture.anchorX'],topLeftY:target.y-document.height*target['texture.anchorY']};
    f.tiles=f.tiles?.map(entry=>{
      const data=structuredClone(entry.data),update=reflectCompositionMember({...data,documentName:'Tile'},pivot,{flipX,flipY});
      for(const [key,value] of Object.entries(update)){const parts=key.split('.');let obj=data;for(const part of parts.slice(0,-1))obj=obj[part] ||= {};obj[parts.at(-1)]=value;}
      return {...entry,data,faFlags:structuredClone(data.flags?.['fa-nexus'] || {})};
    });
  }
  if(Number.isFinite(flags.shadowOffsetX))flags.shadowOffsetX*=sx;
  if(Number.isFinite(flags.shadowOffsetY))flags.shadowOffsetY*=sy;
  if(Number.isFinite(flags.shadowOffsetAngle))flags.shadowOffsetAngle=angle(Math.atan2(sy*Math.sin(flags.shadowOffsetAngle*Math.PI/180),sx*Math.cos(flags.shadowOffsetAngle*Math.PI/180))*180/Math.PI);
  return flags;
}
