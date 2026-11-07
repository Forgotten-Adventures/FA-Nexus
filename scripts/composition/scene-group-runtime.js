import { notifySceneGroupFailure } from './scene-group-notifications.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { COMPOSITION_REGISTRY_FLAG, SceneGroupWorkflow } from './scene-group-workflow.js';
import { shouldIgnoreSceneGroupNativeDeletion } from './scene-group-native-deletion-policy.js';
import {
  markSceneGroupNativeDeletionPending,
  markSceneGroupNativeDeletionSettled,
  observeSceneGroupNativeDeletion
} from './scene-group-native-deletion-state.js';
import { canDeleteTileDuringBuildingEdit } from '../buildings/building-edit-delete-guard.js';
import './composition-registry-scene-rebind.js';

const DELETE_HOOK_DOCUMENT_TYPES = Object.freeze([
  'Tile',
  'Wall',
  'AmbientLight',
  'AmbientSound',
  'Region'
]);

const workflow = new SceneGroupWorkflow();
const pendingSceneReconciliations = new Map();

// The registry as it was before each native deletion that this session reconciled, kept for Foundry's Undo of
// that deletion: the Undo makes the document again, and its Scene Group membership is given back from here.
// Foundry's history lasts as long as the canvas, and so do these.
const NATIVE_DELETION_UNDO_LIMIT = 50;
const nativeDeletionUndoRecords = new Map();

function sceneKeyOf(scene) {
  return String(scene?.uuid || scene?.id || '').trim();
}

function reconciliationStateOf(scene) {
  const sceneKey = sceneKeyOf(scene);
  let state = pendingSceneReconciliations.get(sceneKey);
  if (!state) {
    state = {
      scene,
      sceneKey,
      memberUuids: new Set(),
      locallyInitiatedUuids: new Set(),
      restores: new Map(),
      pending: Promise.resolve(),
      scheduled: false,
      restoreScheduled: false
    };
    pendingSceneReconciliations.set(sceneKey, state);
  }
  return state;
}

function rememberNativeDeletion(scene, memberUuids, before) {
  const groups = Object.values(before?.groups || {});
  const uuids = new Set(memberUuids.filter((uuid) => groups.some((group) => group?.directMemberUuids?.includes?.(uuid))));
  if (!uuids.size) return;
  const sceneKey = sceneKeyOf(scene);
  const records = nativeDeletionUndoRecords.get(sceneKey) || [];
  records.push({ uuids, before });
  while (records.length > NATIVE_DELETION_UNDO_LIMIT) records.shift();
  nativeDeletionUndoRecords.set(sceneKey, records);
}

function scheduleNativeUndoRestore(state) {
  if (state.restoreScheduled) return;
  state.restoreScheduled = true;
  queueMicrotask(() => {
    state.restoreScheduled = false;
    const batches = Array.from(state.restores, ([before, uuids]) => ({ before, memberUuids: Array.from(uuids) }));
    state.restores.clear();
    for (const { before, memberUuids } of batches) {
      state.pending = state.pending
        .then(() => workflow.execute({
          scene: state.scene,
          user: game?.user,
          action: { type: 'restore-native-deletion', memberUuids, before }
        }))
        .then((result) => {
          const count = result?.unrestoredMemberUuids?.length || 0;
          if (count) {
            ui?.notifications?.warn?.(`Undo brought ${count === 1 ? 'the layer' : `${count} layers`} back, but not into ${count === 1 ? 'its' : 'their'} Scene Group: the group it was nested in no longer exists.`);
          }
        })
        .catch((error) => {
          Logger.error('SceneGroupRuntime.nativeDeletion.restoreFailed', {
            sceneId: state.scene?.id || null,
            memberUuids,
            stage: error?.stage || null,
            code: error?.code || null,
            error: String(error?.message || error)
          });
          notifySceneGroupFailure(error, 'Scene Groups could not be restored after Undo');
        });
    }
  });
}

function enqueueNativeUndoRestore(document, options = {}, userId = null) {
  if (options?.isUndo !== true || (userId && userId !== game?.user?.id)) return;
  const scene = document?.parent;
  const uuid = String(document?.uuid || '').trim();
  const records = nativeDeletionUndoRecords.get(sceneKeyOf(scene));
  if (!scene || !uuid || !records?.length) return;
  const index = records.findLastIndex((record) => record.uuids.has(uuid));
  if (index < 0) return;
  const record = records[index];
  record.uuids.delete(uuid);
  if (!record.uuids.size) records.splice(index, 1);
  const state = reconciliationStateOf(scene);
  if (!state.restores.has(record.before)) state.restores.set(record.before, new Set());
  state.restores.get(record.before).add(uuid);
  scheduleNativeUndoRestore(state);
}

// SESSION-LOCAL initiator tracking (#101 fail-closed rule): Foundry fires `preDelete<Type>` hooks
// exclusively on the client that initiated a deletion; broadcast receivers only ever see
// `delete<Type>`. A userId comparison cannot make this distinction — two sessions of the same GM
// share the userId, and a freshly loading or stale second session would then run the DESTRUCTIVE
// dependent cascade for deletions it never observed happening (the proven #101 Building-loss
// chain). Only the initiating session cascades and reconciles the registry.
// Observers must not remove ownership edges before that cascade reads them.
const LOCAL_DELETE_INITIATIONS = new Map();
const LOCAL_DELETE_INITIATION_TTL_MS = 60000;

function recordLocalDeleteInitiation(document) {
  try {
    const now = Date.now();
    for (const [uuid, initiation] of LOCAL_DELETE_INITIATIONS) {
      if (now - initiation.at > LOCAL_DELETE_INITIATION_TTL_MS) LOCAL_DELETE_INITIATIONS.delete(uuid);
    }
    const uuid = String(document?.uuid || '').trim();
    if (uuid) LOCAL_DELETE_INITIATIONS.set(uuid, { at: now, levelSideEffects: [] });
  } catch (_) {}
  return true;
}

function recordLocalLevelDeletionSideEffect(document, options, userId) {
  const scene = document?.parent;
  const levels = Array.from(document?.levels || []);
  if (!scene || !levels.length) return false;
  // Foundry deletes documents scoped only to removed Levels on the server.
  // Those side effects skip preDelete<Type>, but the initiating client saw
  // preDeleteLevel. Reuse that session-local evidence; a same-GM observer must
  // still never cascade or race the initiating registry writer.
  const initiations = levels.map(id => LOCAL_DELETE_INITIATIONS.get(`${scene.uuid}.Level.${id}`));
  if (!initiations.every(entry => entry && Date.now() - entry.at <= LOCAL_DELETE_INITIATION_TTL_MS)) return false;
  // Side-effect document hooks precede deleteLevel while that Level is still
  // in the client collection. Wait for its completion before reconciling the
  // entire batch, so later side effects cannot race an ownership cascade.
  initiations[0].levelSideEffects.push({ document, options, userId });
  return true;
}

function reportReconciliationFailure(scene, memberUuids, error) {
  Logger.error('SceneGroupRuntime.nativeDeletion.reconcileFailed', {
    sceneId: scene?.id || null,
    memberUuids,
    stage: error?.stage || null,
    code: error?.code || null,
    identities: error?.identities || [],
    error: String(error?.message || error)
  });
  notifySceneGroupFailure(error, 'Scene Groups could not finish updating after deletion');
}

function scheduleReconciliation(state) {
  if (state.scheduled) return;
  state.scheduled = true;
  queueMicrotask(() => {
    state.scheduled = false;
    const memberUuids = Array.from(state.memberUuids);
    const locallyInitiatedUuids = memberUuids.filter((uuid) => state.locallyInitiatedUuids.has(uuid));
    state.memberUuids.clear();
    state.locallyInitiatedUuids.clear();
    if (!memberUuids.length) return;
    state.pending = state.pending
      .then(async () => {
        const before = locallyInitiatedUuids.length
          ? foundry.utils.deepClone(state.scene.getFlag('fa-nexus', COMPOSITION_REGISTRY_FLAG) ?? null)
          : null;
        const result = await workflow.execute({
          scene: state.scene,
          user: game?.user,
          action: { type: 'reconcile-native-deletion', memberUuids, locallyInitiatedUuids }
        });
        if (before) rememberNativeDeletion(state.scene, locallyInitiatedUuids, before);
        return result;
      })
      .catch((error) => reportReconciliationFailure(state.scene, memberUuids, error))
      .finally(() => {
        if (state.memberUuids.size) scheduleReconciliation(state);
        else markSceneGroupNativeDeletionSettled(state.scene);
      });
  });
}

function enqueueNativeDeletion(document, options = {}, userId = null) {
  if (shouldIgnoreSceneGroupNativeDeletion(options)) return;
  observeSceneGroupNativeDeletion(document);
  if (userId && userId !== game?.user?.id) return;
  // Only the initiating session may reconcile. A second tab pruning the
  // registry first can erase the very edges the initiator needs to cascade.
  if (!LOCAL_DELETE_INITIATIONS.delete(String(document?.uuid || '').trim())) {
    recordLocalLevelDeletionSideEffect(document, options, userId);
    return;
  }
  const scene = document?.parent;
  const memberUuid = String(document?.uuid || '').trim();
  const sceneKey = String(scene?.uuid || scene?.id || '').trim();
  if (!scene || !memberUuid || !sceneKey) {
    Logger.error('SceneGroupRuntime.nativeDeletion.invalidHookPayload', {
      sceneId: scene?.id || null,
      memberUuid: memberUuid || null,
      userId: userId || null
    });
    return;
  }
  const state = reconciliationStateOf(scene);
  state.memberUuids.add(memberUuid);
  state.locallyInitiatedUuids.add(memberUuid);
  markSceneGroupNativeDeletionPending(scene);
  scheduleReconciliation(state);
}

Hooks.on('preDeleteLevel', recordLocalDeleteInitiation);
Hooks.on('deleteLevel', (level) => {
  const initiation = LOCAL_DELETE_INITIATIONS.get(level.uuid);
  LOCAL_DELETE_INITIATIONS.delete(level.uuid);
  for (const { document, options, userId } of initiation?.levelSideEffects || []) {
    recordLocalDeleteInitiation(document);
    enqueueNativeDeletion(document, options, userId);
  }
});

for (const documentType of DELETE_HOOK_DOCUMENT_TYPES) {
  Hooks.on(`preDelete${documentType}`, (document, options = {}) => {
    if (documentType === 'Tile' && !canDeleteTileDuringBuildingEdit(document, options)) return false;
    return recordLocalDeleteInitiation(document);
  });
  Hooks.on(`delete${documentType}`, enqueueNativeDeletion);
  Hooks.on(`create${documentType}`, enqueueNativeUndoRestore);
}
Hooks.on('canvasTearDown', () => nativeDeletionUndoRecords.clear());
