// Premium editors import this side-effect-free facade instead of importing the
// canonical controller module as their direct dependency. The facade resolves
// the controller at its stable public URL, so split-origin bundles cannot create
// query-variant controller owners.
export {
  announceChange,
  computeLowestSortAtElevation,
  computeNextSortAtElevation,
  getCanvasElement,
  getCanvasInteractionController,
  resolvePlacementSortAtElevation,
  worldFromScreen
} from './canvas-interaction-controller.js';
