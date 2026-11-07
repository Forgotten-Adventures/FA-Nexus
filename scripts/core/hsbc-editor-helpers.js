// Editor-facing HSBC operations are exposed through a facade whose dependency
// remains the canonical, stable public HSBC module. Version-querying this file
// never installs a second HSBC hook owner.
export {
  HSBC_DEFAULTS,
  applyHsbcToDisplayObject,
  buildHsbcToolOptionsControls,
  buildHsbcToolOptionsHandlers,
  buildHsbcToolOptionsState,
  clearHsbcFromDisplayObject,
  cloneHsbc,
  createNeutralHsbc,
  getDefaultHsbc,
  isNeutralHsbc,
  normalizeHsbc,
  readDocumentHsbc,
  serializeHsbc,
  updateHsbcFilter
} from './hsbc.js';
