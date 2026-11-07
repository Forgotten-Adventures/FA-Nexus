// World switches for what FA Nexus changes in how Foundry itself behaves or draws beyond the layers made with it.
// Each can be switched off on its own when it gets in the way of a system or another module; "Enable Mapmaking" off
// loads none of them. docs/architecture/native-foundry-adjustments.md lists every change and its switch.
const MODULE_ID = 'fa-nexus';

export const NATIVE_ADJUSTMENTS = Object.freeze({
  sceneDraw: Object.freeze({
    setting: 'adjustSceneDraw',
    name: 'Wait for Nexus layers when a Scene is drawn',
    hint: 'Holds the Scene transition until the layers made with FA Nexus are ready and draws the Scene a second time when they are, so that they do not pop in. Switch off if a Scene opens slowly or another module misbehaves when one is opened; Nexus layers may then appear a moment after the Scene.',
    requiresReload: false
  }),
  textureBlendFilter: Object.freeze({
    setting: 'adjustTextureBlendFilter',
    name: 'Overlay and Soft Light blend modes',
    hint: 'A painted Texture with the blend mode Overlay or Soft Light needs the picture beneath it, and for that FA Nexus replaces part of the canvas renderer (PIXI filter handling) from the first such Texture on. Switch off if filters of the system or another module are drawn wrongly; these Textures are then drawn with normal blending.',
    requiresReload: true
  })
});

function definition(id) {
  const found = NATIVE_ADJUSTMENTS[id];
  if (!found) throw new Error(`Unknown FA Nexus native adjustment: ${id}`);
  return found;
}

/**
 * Whether one of the switchable changes to Foundry is on. Asked when the change is about to act, which is after
 * Foundry's init: the setting is then registered, and a missing one is an error instead of a guess.
 */
export function isNativeAdjustmentEnabled(id) {
  return globalThis.game.settings.get(MODULE_ID, definition(id).setting) !== false;
}
