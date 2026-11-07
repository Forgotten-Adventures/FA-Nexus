import { planFlattenNativeTransform } from './flatten-composition.js';
import { readSceneGroupMemberTransformState, buildSceneGroupTransformRestore } from '../composition/scene-group-workflow.js';
import {
  captureTilePreviewDisplay, capturePreservedTilePreviewDisplays, beginMemberSemanticPreview,
  clearMemberSemanticPreview, syncMemberSemanticPreview, refreshMemberPreviewObject
} from '../composition/scene-member-render-preview.js';
import { beginLocalWallPerceptionPreview } from '../canvas/local-wall-perception-preview.js';
import { doorTransformPreviewRuntime } from '../portals/door-transform-preview-runtime.js';

// Transient presentation only. The registry and the ordinary native transform
// planner still own membership and the final document writes.
const states = new Map();
const sourceState = document => readSceneGroupMemberTransformState(document, 'rotate');

function restoreSources(state) {
  for (const record of state.records) {
    record.document.updateSource(buildSceneGroupTransformRestore(sourceState(record.document), record.original));
  }
}

function refresh(record, operation = 'transform') {
  refreshMemberPreviewObject(record.document, { operation });
  record.document.object?.applyRenderFlags?.();
  syncMemberSemanticPreview(record, { acceptReplacement: true });
}

export function syncFlattenCompositionPreview(document, preview) {
  const composition = document?.flags?.['fa-nexus']?.flattened?.composition;
  if (!composition || composition.ownerUuid !== document.uuid) return false;
  let state = states.get(document);
  if (state?.committing) return false;
  if (state) restoreSources(state);
  try {
    const plan = planFlattenNativeTransform(document, preview.document);
    if (!state) {
      const records = plan.originals.map(item => {
        const member = document.parent.getEmbeddedDocument(item.documentName, item.source._id);
        return { document: member, original: sourceState(member), originalTileDocument: member.toObject(),
          originalTileSize: { width: member.width, height: member.height },
          displayPreview: captureTilePreviewDisplay(member),
          preservedDisplayPreviews: capturePreservedTilePreviewDisplays(member) };
      });
      state = { document, preview, records, committing: false, plan: null, perception: null, portals: null };
      states.set(document, state);
      state.perception = beginLocalWallPerceptionPreview(records.map(r => r.document), { source: `flatten-native:${document.id}` });
      state.portals = doorTransformPreviewRuntime.begin({ documents: records.map(r => r.document), source: `flatten-native:${document.id}` });
    }
    state.plan = plan;
    for (const update of plan.updates) {
      const record = state.records.find(r => r.document.documentName === update.type && r.document.id === update.source._id);
      if (!record) throw new Error('Flatten ownership changed during its native preview.');
      beginMemberSemanticPreview(record);
      record.document.updateSource(update.source);
      refresh(record, plan.operations[0].operation);
    }
    state.perception?.apply();
    preview.faNexusFlattenCompositionPreview = { members: state.records.length };
    return true;
  } catch (error) {
    cancelFlattenCompositionPreview(document);
    throw error;
  }
}

export function prepareFlattenCompositionPreview(document) {
  const state = states.get(document);
  if (!state || state.committing) return;
  if (['x', 'y', 'width', 'height', 'rotation'].every(key => document[key] === state.preview.document[key])) {
    cancelFlattenCompositionPreview(document);
    return;
  }
  state.committing = true;
  for (const record of state.records) {
    const object = record.document.object;
    object?.applyRenderFlags?.();
    if (record.document.documentName === 'Region') object?.geometry?._updateBuffers?.();
    clearMemberSemanticPreview(record, { sync: false, preservePathPreview: true, preserveDisplayPreview: true });
  }
  // Keep the held displays, but restore baseline sources so the authoritative
  // update can detect every coordinate change and rebuild native Wall Edges.
  restoreSources(state);
  state.portals?.prepareCommit();
}

export async function completeFlattenCompositionPreview(document) {
  const state = states.get(document);
  if (!state) return;
  try {
    for (const record of state.records) clearMemberSemanticPreview(record, { sync: false });
    state.perception?.complete();
    await state.portals?.commit();
  } catch (error) {
    // Document commit has already succeeded. Release preview suppression without
    // putting baseline sources over the authoritative saved pose.
    state.portals?.cancel();
    throw error;
  } finally {
    states.delete(document);
  }
}

export function cancelFlattenCompositionPreview(document, { includingCommit = true } = {}) {
  const state = states.get(document);
  if (!state || (state.committing && !includingCommit)) return;
  const failures = [];
  try {
    restoreSources(state);
    for (const record of state.records) {
      try { clearMemberSemanticPreview(record, { sync: false }); refresh(record); }
      catch (error) { failures.push(error); }
    }
  } catch (error) { failures.push(error); }
  for (const handle of [state.perception, state.portals]) {
    try { handle?.cancel(); } catch (error) { failures.push(error); }
  }
  states.delete(document);
  if (failures.length) throw new AggregateError(failures, 'Flatten preview restoration failed.');
}

export function clearFlattenCompositionPreviews() {
  for (const document of states.keys()) cancelFlattenCompositionPreview(document);
}
