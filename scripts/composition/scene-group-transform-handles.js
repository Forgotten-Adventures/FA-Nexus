const COLOR = 0xcf9f47;

export function sceneGroupFrameCorners(frame) {
  const radians=frame.angle*Math.PI/180, cos=Math.cos(radians), sin=Math.sin(radians);
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>({
    x:frame.center.x+x*frame.width/2*cos-y*frame.height/2*sin,
    y:frame.center.y+x*frame.width/2*sin+y*frame.height/2*cos
  }));
}

export function sceneGroupHandleLayout(frame) {
  const corners=sceneGroupFrameCorners(frame);
  const handleSize=Math.max(10,Math.min(18,Math.min(frame.width,frame.height)*.05));
  const offset=Math.max(32,handleSize*2.5), radians=frame.angle*Math.PI/180;
  const top={x:(corners[0].x+corners[1].x)/2,y:(corners[0].y+corners[1].y)/2};
  return {corners,top,handleSize,hitRadius:Math.max(12,handleSize*.8),
    rotationHandle:{x:top.x+Math.sin(radians)*offset,y:top.y-Math.cos(radians)*offset}};
}

// Both staged prefabs and committed groups use these same graphics and hit areas.
// Callers own event routing and lifetime, not a separate visual implementation.
export function drawSceneGroupTransformHandles({graphics,pivotHandle,scaleHandles,rotationHandle},frame,pivot,{multiple=false,boundsOnly=false}={}) {
  const {corners,top,rotationHandle:rotationPosition,handleSize,hitRadius}=sceneGroupHandleLayout(frame);
  graphics.clear().lineStyle(3,COLOR,.95).drawPolygon(corners.flatMap(p=>[p.x,p.y]));
  if(!multiple&&!boundsOnly)graphics.lineStyle(2,COLOR,.9).moveTo(top.x,top.y).lineTo(rotationPosition.x,rotationPosition.y);
  graphics.lineStyle(2,COLOR,1).drawCircle(pivot.x,pivot.y,8);
  const circle=(handle,position)=>{
    const radius=Math.max(8,handleSize*.55);
    handle.clear().lineStyle(2,0xffffff,.95).beginFill(COLOR,.95).drawCircle(0,0,radius).endFill();
    handle.hitArea=new PIXI.Circle(0,0,hitRadius);handle.position.set(position.x,position.y);
    return radius;
  };
  if(pivotHandle){circle(pivotHandle,pivot);pivotHandle.visible=true;}
  for(const [index,handle] of scaleHandles.entries()){
    handle.clear().lineStyle(2,0xffffff,.95).beginFill(COLOR,.95).drawRect(-handleSize/2,-handleSize/2,handleSize,handleSize).endFill();
    handle.hitArea=new PIXI.Rectangle(-handleSize,-handleSize,handleSize*2,handleSize*2);
    handle.position.set(corners[index].x,corners[index].y);handle.visible=!multiple;
  }
  if(rotationHandle){
    const radius=circle(rotationHandle,rotationPosition);
    rotationHandle.lineStyle(2,0xffffff,.95).arc(0,0,radius*.48,-Math.PI*.85,Math.PI*.55)
      .moveTo(radius*.5,radius*.2).lineTo(radius*.62,radius*.55).lineTo(radius*.22,radius*.48);
    rotationHandle.visible=!multiple&&!boundsOnly;
  }
}

export function createSceneGroupTransformHandles(name) {
  const container=new PIXI.Container();container.name=name;container.eventMode='none';
  const graphics=new PIXI.Graphics(),pivotHandle=new PIXI.Graphics(),rotationHandle=new PIXI.Graphics();
  const scaleHandles=Array.from({length:4},()=>new PIXI.Graphics());
  container.addChild(graphics,pivotHandle,...scaleHandles,rotationHandle);
  return {container,graphics,pivotHandle,scaleHandles,rotationHandle};
}
