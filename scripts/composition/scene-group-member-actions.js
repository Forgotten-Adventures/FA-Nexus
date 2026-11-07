import { getFaNexusTileEditMode } from '../canvas/tile-hud-edit.js';
import { openContextMenuNexusTileEditor } from '../layers/actions/context-actions.js';
import { isSceneMemberLocked } from './scene-member-lock-state.js';
import { getSceneGroupInteractionIndex } from './scene-group-interaction-resolver.js';
import { resolveSceneGroupNavigationMembers } from './scene-group-member-selection.js';

const LAYERS = { Tile: 'tiles', Wall: 'walls', AmbientLight: 'lighting', AmbientSound: 'sounds', Region: 'regions' };

export async function revealHomogeneousSceneMembers(uuids) {
  const resolved = await Promise.all(uuids.map(uuid => fromUuid(uuid)));
  if (!resolved.length || resolved.some(doc => !doc)) return false;
  const documents = resolveSceneGroupNavigationMembers(resolved, getSceneGroupInteractionIndex(resolved[0].parent));
  if (!documents.length || documents.some(doc => !doc.object)) return false;
  if (new Set(documents.map(doc => doc.documentName)).size !== 1) return false;
  await revealSceneMember(documents[0]);
  return true;
}

export async function revealSceneMember(document) {
  const layer = LAYERS[document?.documentName];
  if (!layer || !document.object) throw new Error('This Scene member is not available on the canvas.');
  await ui.controls.activate({ control: layer, tool: 'select' });
  const sidebar = document.documentName === 'Tile' ? 'layer-manager' : 'placeables';
  ui[sidebar].activate();
  if (sidebar === 'placeables') {
    ui.placeables.changeTab(layer, 'sheet');
    await ui.placeables.render({ force: true, tabs: true });
  } else await ui['layer-manager'].render({ force: true });
}

export async function selectSceneMembers(uuids, primaryUuid) {
  const primary = await fromUuid(primaryUuid);
  await revealSceneMember(primary);
  const selected = new Set(uuids);
  for (const key of Object.values(LAYERS)) {
    for (const object of [...(canvas[key]?.controlled || [])]) {
      if (!selected.has(object.document.uuid)) object.release({ renderSidebar: false });
    }
  }
  for (const uuid of uuids) {
    const document = await fromUuid(uuid);
    if (!document?.object) throw new Error(`Scene member is no longer available: ${uuid}.`);
    document.object.control({ force: true, releaseOthers: false, renderSidebar: true });
  }
}

export async function focusSceneMember(uuid) {
  const document = await fromUuid(uuid);
  const object = document?.object;
  let center = object?.center;
  if (document?.documentName === 'Wall') {
    const c = document.c;
    center = { x: (c[0] + c[2]) / 2, y: (c[1] + c[3]) / 2 };
  }
  if (![center?.x, center?.y].every(Number.isFinite)) throw new Error('Scene member has no canvas position.');
  await canvas.animatePan({ x: center.x, y: center.y, duration: 250 });
}

// Use the active Foundry tab's own configure/duplicate/delete actions. Ownership
// dependents remain managed by their editor and cannot be duplicated or deleted here.
export async function buildSceneMemberContextItems(member, { execute, rename } = {}) {
  const document = await fromUuid(member.uuid);
  await revealSceneMember(document);
  const items = [];
  if (document.documentName === 'Tile') {
    if (getFaNexusTileEditMode(document)) items.push({ label: 'Nexus Edit', iconClass: 'fa-solid fa-wand-magic-sparkles', action: () => openContextMenuNexusTileEditor(document) });
    items.push({ label: 'Rename', iconClass: 'fa-solid fa-i-cursor', action: () => rename(document) });
    items.push({ label: 'Configure', iconClass: 'fa-solid fa-gear', action: () => document.sheet.render({ force: true }) });
    if ([4, 5].includes(Number(document.flags?.['fa-nexus']?.building?.schemaVersion))) items.push({
      label: 'Reset Building Scale', iconClass: 'fa-solid fa-arrows-to-circle',
      action: () => execute({ type: 'reset-building-scale', ownerUuid: document.uuid })
    });
  } else {
    const tab = ui.placeables.tab;
    const row = tab.element.querySelector(`[data-entry-id="${document.id}"]`);
    if (!row) throw new Error('Scene member is missing from its Placeables tab.');
    const excluded = /\.(Hide|Show|Lock|Unlock)$/;
    for (const option of tab._getEntryContextOptions()) {
      if (excluded.test(option.label) || (option.visible && !option.visible(row))) continue;
      if ((member.relationshipType || isSceneMemberLocked(document)) && /\.(Delete|Duplicate)$/.test(option.label)) continue;
      items.push({ label: game.i18n.localize(option.label), iconClass: option.icon, action: () => option.onClick(null, row) });
    }
  }
  const locked = isSceneMemberLocked(document);
  items.push({ label: locked ? 'Unlock' : 'Lock', iconClass: `fa-solid fa-lock${locked ? '-open' : ''}`,
    action: () => execute({ type: locked ? 'unlock-member' : 'lock-member', memberUuid: member.uuid }) });
  if (document.documentName === 'Tile' && !member.relationshipType && !locked) items.push({
    label: 'Delete', iconClass: 'fa-solid fa-trash', danger: true, action: () => document.deleteDialog()
  });
  return items;
}
