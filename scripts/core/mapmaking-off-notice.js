import { getFaNexusTileCapabilities } from '../canvas/tile-capabilities.js';
import { isMapmakingEnabled } from './feature-areas.js';

// "Enable Mapmaking" off loads nothing of FA Nexus mapmaking, the code that draws its layers included: a Path then
// shows its source picture and a Scatter one asset. That is the meaning of the switch and it changes no Scene. The
// Gamemaster is told once for each Scene that has such layers, so that a map that looks wrong is not a riddle.
const toldScenes = new Set();

function countLayersDrawnByMapmaking(scene) {
  return scene.tiles.filter((tile) => {
    if (getFaNexusTileCapabilities(tile).isCustomRendered) return true;
    return (tile.flags?.['fa-nexus']?.flattened?.chunks?.length ?? 0) > 0;
  }).length;
}

Hooks.on('canvasReady', (readyCanvas) => {
  const scene = readyCanvas?.scene;
  if (!scene || isMapmakingEnabled() || !game.user?.isGM || toldScenes.has(scene.id)) return;
  const count = countLayersDrawnByMapmaking(scene);
  if (!count) return;
  toldScenes.add(scene.id);
  ui.notifications.warn(`FA Nexus: ${count} ${count === 1 ? 'layer' : 'layers'} of this Scene ${count === 1 ? 'was' : 'were'} made with the Nexus mapmaking tools and ${count === 1 ? 'is' : 'are'} not drawn as saved while "Enable Mapmaking" is off. The Scene is not changed: switch it on in Configure Settings, FA Nexus.`);
});
