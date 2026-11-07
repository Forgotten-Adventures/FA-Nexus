// Which Levels a layer made by a Nexus tool belongs to.
//
// "all" (the default): no Level in particular, which Foundry reads as every Level. A storey drawn above another
// then shows the storey below through its windows, and a surface Region hides what must not be seen.
// "own": Foundry's own membership for the Level the layer is made on, so Foundry draws it there only and deletes
// it with that Level.
//
// The setting decides new layers only. A layer that exists keeps its membership until it is changed in Foundry's
// own Tile sheet or palette.

const MODULE_ID = 'fa-nexus';

export const NEW_LAYER_LEVELS_SETTING = 'newLayerLevels';
export const NEW_LAYER_LEVELS_ALL = 'all';
export const NEW_LAYER_LEVELS_OWN = 'own';

export const NEW_LAYER_LEVELS_CHOICES = Object.freeze({
  [NEW_LAYER_LEVELS_ALL]: 'Every Level',
  [NEW_LAYER_LEVELS_OWN]: 'Only their own Level'
});

export function newLayersBelongToOwnLevel() {
  const settings = globalThis.game?.settings;
  if (!settings?.settings?.has?.(`${MODULE_ID}.${NEW_LAYER_LEVELS_SETTING}`)) return false;
  return settings.get(MODULE_ID, NEW_LAYER_LEVELS_SETTING) === NEW_LAYER_LEVELS_OWN;
}

function viewedLevelId(scene) {
  const canvas = globalThis.canvas;
  if (scene && scene === canvas?.scene && canvas?.level?.parent === scene) return String(canvas.level.id || '').trim();
  const view = scene?._view ?? null;
  return String((view && scene?.levels?.get?.(view)?.id) || '').trim();
}

/**
 * The Level membership of a new layer: nothing for "all"; for "own" the Level it is placed on, or the viewed
 * Level when it names none. A Scene without Levels has nothing to belong to.
 */
export function resolveNewLayerLevels({ placementLevelId = null, scene = globalThis.canvas?.scene } = {}) {
  if (!newLayersBelongToOwnLevel()) return [];
  const levelId = String(placementLevelId || '').trim() || viewedLevelId(scene);
  if (!levelId || (scene?.levels?.get && !scene.levels.get(levelId))) return [];
  return [levelId];
}
