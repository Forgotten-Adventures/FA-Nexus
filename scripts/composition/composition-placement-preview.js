import { createCompositionScene, transformCompositionScene, restoreCompositionCoordinates } from './scene-group-copy-runtime.js';
import { getSceneGroupFrame, readSceneGroupMemberTransformState, buildSceneGroupMemberTransformTarget, resolveSceneGroupMoveDelta } from './scene-group-workflow.js';
import { COMPOSITION_COLLECTIONS } from './scene-group-snapshot.js';
import { capturePreservedTilePreviewDisplays, beginMemberSemanticPreview, clearMemberSemanticPreview,
  refreshMemberPreviewObject, syncMemberSemanticPreview } from './scene-member-render-preview.js';
import { waitForCustomTileRender } from '../canvas/custom-tile-render-scheduler.js';
import { syncPortalTextureFlipForDocument } from '../portals/portal-texture-flip-runtime.js';
import { getAssetShadowManager } from '../assets/asset-shadow-manager.js';
import { DoorShadowManager } from '../portals/door-shadow-manager.js';
import { beginLocalWallPerceptionPreview } from '../canvas/local-wall-perception-preview.js';

const documentsOf = scene => Object.values(COMPOSITION_COLLECTIONS).flatMap(key => scene[key].contents);

/** Owns unpersisted native placeables, their Door meshes, and local light/edge sources.
 * The source plan is immutable. No preview document enters a Scene collection.
 */
export class CompositionPlacementPreview {
  constructor(plan, scene, pivot) {
    this.plan = plan;
    this.scene = scene;
    this.pivot = {...pivot};
    this.records = [];
    this.closed = false;
    this.documents = plan.documents.map(({type,source}) => new CONFIG[type].documentClass(structuredClone(source), {parent:scene}));
    for (const doc of this.documents) restoreCompositionCoordinates(doc);
    const group = plan.registry.groups[plan.rootGroupId];
    this.frame = getSceneGroupFrame(this.documents,group);
    this.customBounds = !!group.bounds;
    this.transformKey = '1:0:false:false';
    this.moveDelta = {x:0,y:0};
    this.moveStates = this.documents.map(doc => readSceneGroupMemberTransformState(doc, 'move'));
  }

  async draw() {
    try {
      // Native illumination uses the same ephemeral Wall edges as Door geometry.
      for (const doc of this.documents) if (doc.documentName === 'Wall') doc.initializeEdge();
      this.perception = beginLocalWallPerceptionPreview(this.documents,{source:'prefab-placement'});
      for (const doc of this.documents) {
        if (this.closed) return;
        if (!doc.viewed) continue;
        const object = doc.object;
        if (!object) throw new Error(`Cannot preview ${doc.documentName}.`);
        object.faNexusLocalCompositionPreview=true;
        // Unpersisted items deliberately have no row in Foundry's placeables
        // sidebar. Its entry filter must not hide this locally owned preview.
        Object.defineProperty(object,'isFilteredOut',{value:false,configurable:true});
        // Native AmbientSound.draw normally registers playback immediately.
        // This instance is only a placement guide until Accept creates it.
        if (doc.documentName === 'AmbientSound') object.initializeSoundSource = () => {};
        const record = {document:doc, object};
        this.records.push(record);
        object.faNexusPreviewOwnerTile = this.documents.find(candidate => candidate.id === doc.flags?.['fa-nexus']?.buildingWall?.tileId);
        doc.layer.preview.addChild(object);
        await object.draw();
        if (this.closed) return;
        object.renderFlags.set({refresh:true});
        object.applyRenderFlags();
        object.eventMode = 'none';
        if (doc.documentName === 'Tile') {
          await waitForCustomTileRender(object);
          record.original = readSceneGroupMemberTransformState(doc, 'scale');
          record.originalTileDocument = doc.toObject();
          record.originalTileSize = {width:doc.width,height:doc.height};
          record.preservedDisplayPreviews = capturePreservedTilePreviewDisplays(doc);
          beginMemberSemanticPreview(record);
        } else if (doc.documentName === 'AmbientLight') object.initializeLightSource();
        else if (doc.documentName === 'Wall') {
          syncPortalTextureFlipForDocument(doc, [...object.doorMeshes], {reason:'prefab-preview'});
          record.doorShadow=await DoorShadowManager.getInstance().preparePlacementPreview(doc);
        }
        this._hideControls(object);
      }
      this.shadows = await getAssetShadowManager().prepareLocalCompositionShadows(this.documents,this.pivot);
      canvas.perception.update({refreshLighting:true,refreshVision:true});
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }

  update({point, scale, rotation, flipX=false, flipY=false}) {
    if (this.closed) return;
    const key = `${scale}:${rotation}:${flipX}:${flipY}`;
    const shapeChanged = key !== this.transformKey;
    const delta = resolveSceneGroupMoveDelta(this.documents,{x:point.x-this.pivot.x,y:point.y-this.pivot.y});
    // Foundry emulates pointermove after refreshing placeables. Re-applying an
    // unchanged pose would feed that event back into perpetual rendering work.
    if (!shapeChanged && delta.x === this.moveDelta.x && delta.y === this.moveDelta.y) return false;
    if (shapeChanged) {
      const virtual = createCompositionScene(this.plan);
      if (flipX || flipY) transformCompositionScene(virtual, this.pivot, {operation:'reflect',flipX,flipY});
      if (scale !== 1) transformCompositionScene(virtual, this.pivot, {operation:'scale',factor:scale});
      if (rotation) transformCompositionScene(virtual, this.pivot, {operation:'rotate',angle:rotation});
      const targets = new Map(documentsOf(virtual).map(doc => [doc.id,doc.toObject()]));
      for (const doc of this.documents) {
        doc.updateSource(targets.get(doc.id));
        restoreCompositionCoordinates(doc);
      }
      // Thresholds and one-way senses can change with scale/reflection. Rebase
      // the shared Edge preview only for those changes, never for translation.
      this.perception?.cancel();
      for (const doc of this.documents) if (doc.documentName === 'Wall') doc.initializeEdge();
      this.perception = beginLocalWallPerceptionPreview(this.documents,{source:'prefab-placement'});
      this.moveStates = this.documents.map(doc => readSceneGroupMemberTransformState(doc, 'move'));
      this.transformKey = key;
    }
    // Same held-move contract as the Scene Group overlay. The immutable plan is
    // only recompiled when its shape changes, never for cursor translation.
    for (const [i,doc] of this.documents.entries()) {
      doc.updateSource(buildSceneGroupMemberTransformTarget(doc,this.moveStates[i],null,{operation:'move',delta}));
      restoreCompositionCoordinates(doc);
      if (doc.documentName === 'Wall' && !this.perception?.supported) doc.initializeEdge();
    }
    this.perception?.apply();
    for (const record of this.records) {
      const {document:doc,object} = record;
      // Sound placement previews are visual only: do not start ambient playback.
      if (doc.documentName === 'AmbientSound') object.renderFlags.set({refreshTransform:true,refreshField:true});
      else refreshMemberPreviewObject(doc, {operation:shapeChanged ? 'transform' : 'move'});
      object.applyRenderFlags();
      syncMemberSemanticPreview(record);
      if(record.doorShadow)DoorShadowManager.getInstance().syncDetachedPreview(record.doorShadow);
      this._hideControls(object);
    }
    this.shadows?.update({point:{x:this.pivot.x+delta.x,y:this.pivot.y+delta.y},scale,rotation,flipX,flipY});
    canvas.perception.update({refreshLighting:true,refreshVision:true});
    this.moveDelta = delta;
    return true;
  }

  _hideControls(object) {
    object.eventMode = 'none';
    const type=object.document.documentName;
    if (['Wall','AmbientLight'].includes(type)) object.visible = false;
    for (const key of ['frame','controlIcon','doorControl']) if (object[key]) object[key].visible = false;
    if (['Region','AmbientSound'].includes(type)) {
      object.visible=type!=='Region'||!object.document.flags?.['fa-nexus']?.buildingGenerated;
      if(object.controls){object.controls.visible=true;if(object.controls.handles)object.controls.handles.visible=false;}
    }
  }

  async destroy() {
    if (this.closed) return;
    this.closed = true;
    const failures = [];
    try { this.perception?.cancel(); } catch(error) { failures.push(error); }
    try { this.shadows?.destroy(); } catch(error) { failures.push(error); }
    for (const record of this.records.toReversed()) {
      try {
        if(record.doorShadow)DoorShadowManager.getInstance().releaseDetachedPreview(record.doorShadow);
        if(record.object.destroyed)continue;
        clearMemberSemanticPreview(record, {sync:false});
        if (record.document.documentName === 'AmbientLight') record.object.initializeLightSource({deleted:true});
        record.object.destroy({children:true});
      } catch (error) { failures.push(error); }
    }
    for (const doc of this.documents) if (doc.documentName === 'Wall') {
      try { doc.initializeEdge({deleted:true}); } catch (error) { failures.push(error); }
    }
    this.records.length = 0;
    canvas.perception.update({refreshLighting:true,refreshVision:true});
    if (failures.length) throw new AggregateError(failures, 'Could not clean up every placement preview object.');
  }
}
