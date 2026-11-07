// The Layer Manager's place in Foundry's sidebar. Foundry builds the sidebar's tab buttons and their content slots from
// Sidebar.TABS on its first render, so the entry must be there by then. This module is small and is loaded with the
// entry script, so the slot exists at init even when the Layer Manager itself (layer-manager-tab.js) loads later.

export const LAYER_MANAGER_TAB_ID = 'layer-manager';

function insertLayerManagerTabIntoSidebar(SidebarClass) {
  const tabs = SidebarClass?.TABS;
  if (!tabs || typeof tabs !== 'object') return false;
  if (tabs[LAYER_MANAGER_TAB_ID]) return false;
  const descriptor = {
    // The module registers no language file: a key here was shown as it is written.
    tooltip: 'Layer Manager',
    icon: 'fa-solid fa-layer-group',
    gmOnly: true
  };
  const next = [];
  let inserted = false;
  for (const [key, value] of Object.entries(tabs)) {
    next.push([key, value]);
    if (key === 'scenes') {
      next.push([LAYER_MANAGER_TAB_ID, descriptor]);
      inserted = true;
    }
  }
  if (!inserted) next.push([LAYER_MANAGER_TAB_ID, descriptor]);
  SidebarClass.TABS = Object.fromEntries(next);
  return true;
}

/** Adds the Layer Manager entry after Scenes to the configured sidebar class and Foundry's own. */
export function insertLayerManagerSidebarSlot() {
  const sidebarClasses = [
    globalThis.CONFIG?.ui?.sidebar,
    globalThis.foundry?.applications?.sidebar?.Sidebar
  ].filter((SidebarClass, index, classes) => SidebarClass && classes.indexOf(SidebarClass) === index);
  for (const SidebarClass of sidebarClasses) insertLayerManagerTabIntoSidebar(SidebarClass);
}
