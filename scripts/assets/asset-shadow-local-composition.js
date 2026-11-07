import { buildLayerShadowRenderInputs } from './asset-shadow-rebuild-workflow.js';
import { resolveTileRenderOrder } from '../canvas/tile-band-utils.js';

/** Rasterize unpersisted native Tiles with the committed shadow pipeline once.
 * The caller owns this handle; it never registers Tiles in the Scene or manager.
 */
export async function prepareLocalCompositionShadows(manager, documents, pivot) {
  manager._updateRenderer();
  const renderer = manager._renderer;
  if (!renderer) throw new Error('The shadow renderer is not ready.');
  const groups = new Map(), resources = [];
  const destroy = () => {
    for (const {root,target} of resources.splice(0)) {
      if(!root.destroyed)root.destroy({children:true,texture:false,baseTexture:false});
      target.renderTexture?.destroy(true);target.rawRenderTexture?.destroy(true);
    }
  };
  try {
    for (const doc of documents.filter(d=>d.documentName==='Tile' && manager._isShadowRenderableTile(d))) {
      const order = manager.resolvePreviewShadowLayerOrder({elevation:doc.elevation,sort:doc.sort,renderOrder:resolveTileRenderOrder(doc)});
      const {tileConfigs} = buildLayerShadowRenderInputs(manager,[doc],{elevation:doc.elevation});
      for (const entry of tileConfigs) {
        const {alpha,blur} = entry.config;
        if (alpha<=0) continue;
        const key=JSON.stringify([order.sortLayer,order.elevation,order.sort,alpha,blur]);
        if(!groups.has(key))groups.set(key,{order,alpha,blur,entries:[]});
        groups.get(key).entries.push(entry);
      }
    }
    for (const group of groups.values()) {
      let bounds=null,maxDilation=0,maxOffsetX=0,maxOffsetY=0;
      for(const entry of group.entries){
        bounds=manager._mergeWorldBounds(bounds,manager._computeShadowEntryBounds(entry));
        maxDilation=Math.max(maxDilation,entry.config.dilation||0);
        maxOffsetX=Math.max(maxOffsetX,Math.abs(entry.config.offsetX||0));
        maxOffsetY=Math.max(maxOffsetY,Math.abs(entry.config.offsetY||0));
      }
      if(!bounds)continue;
      const sceneRect=manager._applyShadowMargins(manager._rectFromWorldBounds(bounds,8),{dilation:maxDilation,offsetX:maxOffsetX,offsetY:maxOffsetY,blur:group.blur});
      const scale=manager._computeTextureScale(sceneRect);
      const options={alpha:group.alpha,blur:group.blur,maxDilation};
      const target={},root=new PIXI.Container();
      root.name='fa-nexus-composition-shadow';root.eventMode='none';
      Object.assign(root,{sortLayer:group.order.sortLayer,sort:group.order.sort,zIndex:group.order.sort,elevation:group.order.elevation});
      resources.push({root,target});
      const tempDisplayObjects=[],tempTextures=[],tempTextureViews=[];let draw;
      try {
        draw=await manager._buildLayerShadowDrawContainer(group.entries,{renderer,scale,sceneRect,tempDisplayObjects,tempTextures,tempTextureViews});
        if(!draw.children.length)continue;
        const texture=manager._renderLayerToTexture({container:null,options,renderTexture:null},draw,renderer,
          Math.max(4,Math.ceil(sceneRect.width*scale)),Math.max(4,Math.ceil(sceneRect.height*scale)),{renderTarget:target,scale,layerOptions:options});
        if(!texture)throw new Error('Could not render placement shadows.');
        const sprite=new PIXI.Sprite(texture);sprite.position.set(sceneRect.x-pivot.x,sceneRect.y-pivot.y);
        sprite.scale.set(1/scale);sprite.alpha=group.alpha;root.addChild(sprite);
        root.position.set(pivot.x,pivot.y);group.order.parent.addChild(root);
        group.order.parent.sortDirty=true;
      } finally {
        for(const display of tempDisplayObjects)display.destroy({children:true,texture:false,baseTexture:false});
        draw?.destroy({children:false});
        for(const texture of tempTextures)texture.destroy(true);
        for(const texture of tempTextureViews)texture.destroy(false);
      }
    }
    return {update({point,scale=1,rotation=0,flipX=false,flipY=false}){
      for(const {root} of resources){root.position.set(point.x,point.y);root.scale.set(scale*(flipX?-1:1),scale*(flipY?-1:1));root.angle=rotation;}
    },destroy};
  } catch(error){destroy();throw error;}
}
