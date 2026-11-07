import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { createBuildingWallFieldRuntime } from '../buildings/building-wall-fields-v14.js';

/** The behaviours offered for the Foundry Walls a Path makes: the presets a Building's walls have. */
export const PATH_WALL_BEHAVIORS = Object.freeze(['Solid', 'Terrain', 'Invisible', 'Ethereal']);

/** What a Path's Walls did before a behaviour could be chosen, and what a Path without a choice still does. */
export const DEFAULT_PATH_WALL_BEHAVIOR = 'Solid';

export const PATH_WALL_BEHAVIOR_TOOLTIPS = Object.freeze({
  Solid: 'Foundry Walls block movement, sight, light and sound.',
  Terrain: 'Foundry Walls block movement; sight, light and sound pass one such wall.',
  Invisible: 'Foundry Walls block movement only (a fence, a railing).',
  Ethereal: 'Foundry Walls block sight and light; movement and sound pass.'
});

export const PATH_WALL_BEHAVIOR_OFF_TOOLTIP = 'Turn on "Foundry Walls" to choose what they block.';

export function normalizePathWallBehavior(value) {
  const name = String(value ?? '').trim();
  if (!name) return DEFAULT_PATH_WALL_BEHAVIOR;
  const known = PATH_WALL_BEHAVIORS.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (known) return known;
  Logger.warn?.('PathWallBehavior.unknown', { value: name, used: DEFAULT_PATH_WALL_BEHAVIOR });
  return DEFAULT_PATH_WALL_BEHAVIOR;
}

let presets = null;

/** The Wall fields of a behaviour, taken from the presets a Building uses so the two cannot drift apart. */
export function resolvePathWallBehaviorFields(value) {
  presets ||= createBuildingWallFieldRuntime().presets;
  const preset = presets[normalizePathWallBehavior(value)];
  return { move: preset.move, sight: preset.sight, light: preset.light, sound: preset.sound };
}
