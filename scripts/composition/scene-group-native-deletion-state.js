import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { notifySceneGroupFailure } from './scene-group-notifications.js';

export const SCENE_GROUP_NATIVE_DELETION_STATE_HOOK = 'fa-nexus-scene-group-native-deletion-state';

const pendingSceneKeys = new Set();
const observedDeletions = new Map();

function referencesMember(scene, uuid) {
  const registry = scene?.getFlag?.('fa-nexus', 'compositionRegistry');
  return Object.values(registry?.groups || {}).some(group => group.directMemberUuids?.includes(uuid))
    || (registry?.relationships || []).some(edge => edge.ownerUuid === uuid || edge.dependentUuid === uuid);
}

function finishObservedDeletion(scene) {
  const key = sceneKey(scene), state = observedDeletions.get(key);
  if (!state) return;
  clearTimeout(state.timeout);
  observedDeletions.delete(key);
  if (!pendingSceneKeys.has(key)) globalThis.Hooks?.callAll?.(SCENE_GROUP_NATIVE_DELETION_STATE_HOOK, scene, false);
}

/** Read-only observers wait for the initiating client's authoritative registry write. */
export function observeSceneGroupNativeDeletion(document) {
  const scene = document?.parent, uuid = document?.uuid;
  if (!scene || !uuid || !referencesMember(scene, uuid)) return;
  const key = sceneKey(scene), wasPending = isSceneGroupNativeDeletionPending(scene);
  let state = observedDeletions.get(key);
  if (!state) {
    state = { members: new Set(), timeout: null };
    observedDeletions.set(key, state);
    state.timeout = setTimeout(() => {
      const missing = [...state.members].filter(member => referencesMember(scene, member));
      finishObservedDeletion(scene);
      if (!missing.length) return;
      const error = Object.assign(new Error('Scene Group deletion reconciliation did not finish within 30 seconds.'),
        { code: 'missing-document', identities: missing });
      Logger.error('SceneGroupRuntime.nativeDeletion.observerTimeout', { sceneId: scene.id, memberUuids: missing });
      notifySceneGroupFailure(error, 'Scene Groups could not finish updating after deletion');
    }, 30000);
  }
  state.members.add(uuid);
  if (!wasPending) globalThis.Hooks?.callAll?.(SCENE_GROUP_NATIVE_DELETION_STATE_HOOK, scene, true);
}

function sceneKey(scene) {
  return String(scene?.uuid || scene?.id || '').trim();
}

export function isSceneGroupNativeDeletionPending(scene) {
  const key = sceneKey(scene);
  return !!key && (pendingSceneKeys.has(key) || observedDeletions.has(key));
}

export function markSceneGroupNativeDeletionPending(scene) {
  const key = sceneKey(scene);
  if (!key || pendingSceneKeys.has(key)) return;
  const wasPending = isSceneGroupNativeDeletionPending(scene);
  pendingSceneKeys.add(key);
  if (!wasPending) globalThis.Hooks?.callAll?.(SCENE_GROUP_NATIVE_DELETION_STATE_HOOK, scene, true);
}

export function markSceneGroupNativeDeletionSettled(scene) {
  const key = sceneKey(scene);
  if (!key || !pendingSceneKeys.delete(key)) return;
  // The initiator knows its operation has completed, including a reported
  // failure. Observers instead settle only after the registry broadcast.
  if (observedDeletions.has(key)) finishObservedDeletion(scene);
  else globalThis.Hooks?.callAll?.(SCENE_GROUP_NATIVE_DELETION_STATE_HOOK, scene, false);
}

globalThis.Hooks?.on?.('updateScene', (scene, changes) => {
  if (!Object.hasOwn(changes?.flags?.['fa-nexus'] || {}, 'compositionRegistry')) return;
  const state = observedDeletions.get(sceneKey(scene));
  if (!state) return;
  for (const uuid of state.members) if (!referencesMember(scene, uuid)) state.members.delete(uuid);
  if (!state.members.size) finishObservedDeletion(scene);
});

globalThis.Hooks?.on?.('deleteScene', scene => {
  pendingSceneKeys.delete(sceneKey(scene));
  finishObservedDeletion(scene);
});
