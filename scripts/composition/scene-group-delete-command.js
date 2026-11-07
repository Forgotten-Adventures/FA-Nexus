import { SceneGroupWorkflow } from './scene-group-workflow.js';
import { sceneGroupInteractionState } from './scene-group-interaction-state.js';
import { markSceneGroupNativeDeletionPending, markSceneGroupNativeDeletionSettled } from './scene-group-native-deletion-state.js';

let pending = null;

/** One confirmation and one native Undo command, regardless of entry surface. */
export function confirmDeleteSceneGroups({ scene, groupIds, memberUuids, user = globalThis.game?.user, workflow = new SceneGroupWorkflow() } = {}) {
  if (pending) return pending;
  pending = (async () => {
    const prepared = await workflow.execute({ scene, user, action: { type: 'prepare-delete-group', groupIds, memberUuids } });
    const confirmation = prepared.confirmation;
    // A Path without Walls is a composite with nothing generated: it is not offered "0 part(s)".
    const standalone = confirmation.relationshipDescendants.length
      ? `<p>Delete <strong>${foundry.utils.escapeHTML(confirmation.group.name)}</strong> and its ${confirmation.relationshipDescendants.length} generated or attached part(s)?</p><p>Undo (Ctrl+Z) restores them together.</p>`
      : `<p>Delete <strong>${foundry.utils.escapeHTML(confirmation.group.name)}</strong>?</p><p>Undo (Ctrl+Z) restores what was deleted.</p>`;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: `Delete ${confirmation.group.name}?` },
      content: memberUuids?.length
        ? standalone
        :`<p>Delete <strong>${foundry.utils.escapeHTML(confirmation.group.name)}</strong>, ${confirmation.nestedGroups.length} nested group(s), ${confirmation.directDocuments.length} direct document(s), and ${confirmation.relationshipDescendants.length} generated or attached document(s)?</p><p>Use Undo (Ctrl+Z) on an affected canvas layer to restore them together.</p>`,
      modal: true, rejectClose: false
    });
    if (confirmed !== true) return false;
    if (globalThis.canvas?.scene !== scene) throw new Error('The active Scene changed before deletion.');
    const selection = sceneGroupInteractionState.snapshot(scene);
    markSceneGroupNativeDeletionPending(scene);
    // Release the selected overlay before any batch removes its documents.
    if (memberUuids?.length) canvas.tiles.releaseAll();
    sceneGroupInteractionState.clear(scene, 'delete-group');
    try {
      return await workflow.execute({ scene, user, action: {
        type: 'delete-group', groupIds, memberUuids, confirmed: true, confirmationToken: confirmation.token
      } });
    } catch (error) {
      if (!error.rollback?.residueUuids?.length && !error.rollback?.registryResidue) {
        sceneGroupInteractionState.selectGroups(scene, selection.selectedGroupIds, {
          anchorId: selection.groupSelectionAnchorId, primaryGroupId: selection.primaryGroupId
        });
      }
      throw error;
    } finally {
      markSceneGroupNativeDeletionSettled(scene);
    }
  })().finally(() => { pending = null; });
  return pending;
}

/**
 * A Building or Path saved by the released editors is not in the registry: its generated parts
 * are removed by its own linked cleanup, which a Scene Group delete suppresses. Its Delete key
 * stays with Foundry so that cleanup runs instead of leaving every part behind without an owner.
 */
function hasUnregisteredGeneratedParts(scene, document) {
  const flags = document.flags?.['fa-nexus'];
  if (!flags?.building && !flags?.pathV2 && !flags?.pathsV2) return false;
  const relationships = scene.getFlag('fa-nexus', 'compositionRegistry')?.relationships;
  if (Array.isArray(relationships) && relationships.some(relationship => relationship.ownerUuid === document.uuid)) return false;
  if (flags.building) return true;
  return scene.walls.some(wall => wall.flags?.['fa-nexus']?.pathWall?.tileId === document.id);
}

/**
 * The Tiles to delete as one standalone composite command: a selection that holds a registered
 * Building or Path, or a band of a flattened section, and no released-format Building or Path.
 * Null leaves the deletion to Foundry. The Delete key and the Layer Manager's delete button share
 * this rule, so both give one confirmation and one Undo for an owner and its generated parts.
 */
export function resolveStandaloneCompositeDeleteMembers(scene, documents = []) {
  const flattenedOwner = (document) => document?.flags?.['fa-nexus']?.flattened?.composition?.ownerUuid || null;
  const isComposite = (document) => {
    const flags = document?.flags?.['fa-nexus'];
    return !!(flags?.building || flags?.pathV2 || flags?.pathsV2 || flattenedOwner(document));
  };
  if (!scene || !documents.some(isComposite)) return null;
  if (documents.some((document) => hasUnregisteredGeneratedParts(scene, document))) return null;
  // Any band stands for its section: the owner carries the other bands, the Walls and the Regions.
  return [...new Set(documents.map((document) => flattenedOwner(document) || document.uuid))];
}

export function handleSceneGroupDeleteKey(event, { onError = console.error } = {}) {
  if (!['Delete', 'Backspace'].includes(event.key) || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!globalThis.game?.user?.isGM || !globalThis.canvas?.ready || globalThis.canvas?.loading) return false;
  const target = event.target;
  if (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable], [role="dialog"], dialog')) return false;
  const application = target?.closest?.('.application, .app, .window-app');
  if (application && application.id !== 'fa-nexus-scene-groups-window' && !application.querySelector?.('.fa-nexus-layer-manager')) return false;
  if (globalThis.document?.querySelector?.('dialog[open]')) return false;
  if (globalThis[Symbol.for('fa-nexus.scene-group-overlay-drag-active')]) return false;
  const scene = globalThis.canvas.scene;
  const groupIds = sceneGroupInteractionState.snapshot(scene).selectedGroupIds;
  const tiles = canvas.activeLayer === canvas.tiles ? canvas.tiles.controlled : [];
  const memberUuids = groupIds.length
    ? null : resolveStandaloneCompositeDeleteMembers(scene, tiles.map(tile => tile.document));
  if (!groupIds.length && !memberUuids) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  void confirmDeleteSceneGroups({ scene, groupIds, memberUuids }).catch(onError);
  return true;
}
