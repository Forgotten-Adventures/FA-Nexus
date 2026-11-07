import { captureSceneGroupCommandHistoryContext, recordSceneGroupCommand } from '../composition/scene-group-command-history.js';
import { readSceneGroupMemberTransformState } from '../composition/scene-group-workflow.js';
import { waitForNativeTileTransformTransactions } from './native-tile-transform-transactions.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

const PATCH = Symbol.for('fa-nexus.native-tile-transform-history');

export function captureNativeTileTransformHistoryContext(scene, options) {
  // Foundry shares options across all Roots in the initiating Tile batch.
  // Preserve its original history intent before any family suppresses native history.
  if (!Object.hasOwn(options, 'faNexusNativeTileTransformHistoryContext')) {
    options.faNexusNativeTileTransformHistoryContext = options.isUndo
      ? null : captureSceneGroupCommandHistoryContext(scene);
  }
  options.isUndo = true;
  return options.faNexusNativeTileTransformHistoryContext;
}

// Foundry's descendant callbacks bracket the complete initiating Tile batch.
// Reserve one shared native-history entry there, before later user operations,
// then finalize it only after all owner/dependent writes have been verified.
// Families provide their pending plan via a per-Tile token map; the plan supplies
// tileId, originalTileSource, originals, operations and the shared historyContext.
export function installNativeTileTransformHistory(tokenKey, getPlan, SceneClass = globalThis.CONFIG?.Scene?.documentClass) {
  const prototype = SceneClass?.prototype;
  if (!prototype) return false;
  if (prototype[PATCH]) {
    prototype[PATCH].set(tokenKey, getPlan);
    return true;
  }
  const pre = prototype._preUpdateDescendantDocuments;
  const post = prototype._onUpdateDescendantDocuments;
  if (typeof pre !== 'function' || typeof post !== 'function') return false;
  const providers = new Map([[tokenKey, getPlan]]);
  const batches = new WeakMap();
  prototype._preUpdateDescendantDocuments = function(parent, collection, changes, options, userId) {
    const roots = [...providers].flatMap(([key, resolvePlan]) => Object.entries(options[key] || {})
      .filter(([id]) => changes.some(change => change._id === id))
      .map(([, token]) => resolvePlan(token))).filter(plan => plan?.historyContext != null);
    if (parent === this && collection === 'tiles' && roots.length && userId === globalThis.game?.userId) {
      const originals = new Map();
      const add = (document, source = document.toObject()) => originals.set(document.uuid, { document, source });
      for (const change of changes) add(this.tiles.get(change._id));
      // Include relationship-owned outputs of other selected Tiles, such as Paths.
      for (const uuid of originals.keys()) {
        for (const relation of this.flags?.['fa-nexus']?.compositionRegistry?.relationships || []) {
          if (relation.ownerUuid !== uuid || originals.has(relation.dependentUuid)) continue;
          const [, sceneId, type, id] = relation.dependentUuid.split('.');
          if (sceneId !== this.id) throw new Error('Native Tile history found a foreign dependent.');
          add(this.getEmbeddedDocument(type, id));
        }
      }
      for (const plan of roots) {
        add(this.tiles.get(plan.tileId), plan.originalTileSource);
        for (const entry of plan.originals) add(this.getEmbeddedDocument(entry.documentName,entry.source._id),entry.source);
      }
      const operation = roots.some(p=>p.operations.some(o=>o.operation.startsWith('scale'))) ? 'scale'
        : roots.some(p=>p.operations.some(o=>o.operation==='rotate')) ? 'rotate' : 'move';
      const plans = [...originals.values()].map(({document,source}) => ({
        uuid:document.uuid, id:document.id, documentName:document.documentName,
        original:readSceneGroupMemberTransformState({...source,_source:source,documentName:document.documentName,uuid:document.uuid},operation)
      }));
      let resolve, reject;
      const settlement = new Promise((yes,no)=>{resolve=yes;reject=no;});
      void settlement.catch(()=>{});
      recordSceneGroupCommand(this, {
        groupId:this.tiles.get(roots[0].tileId).uuid, operation, actionType:'native-tile-transform',
        plans:plans.map(plan=>({...plan,target:plan.original}))
      },roots[0].historyContext,{settlement});
      batches.set(options,{plans,operation,resolve,reject});
    }
    return pre.call(this,parent,collection,changes,options,userId);
  };
  prototype._onUpdateDescendantDocuments = function(parent,collection,documents,changes,options,userId) {
    const result = post.call(this,parent,collection,documents,changes,options,userId);
    const batch = batches.get(options);
    if (parent !== this || collection !== 'tiles' || !batch) return result;
    batches.delete(options);
    void Promise.all(documents.map(document=>waitForNativeTileTransformTransactions(document))).then(()=>{
      batch.resolve(batch.plans.map(plan=>({...plan,
        target:readSceneGroupMemberTransformState(this.getEmbeddedDocument(plan.documentName,plan.id),batch.operation)
      })));
    }).catch(error=>{
      batch.reject(error);
      Logger.error('NativeTiles.transform.historyFailed',{error:String(error)});
      globalThis.ui?.notifications?.error?.(`Tile transform Undo could not be recorded: ${error.message || error}`);
    });
    return result;
  };
  Object.defineProperty(prototype,PATCH,{value:providers});
  return true;
}
