const ICON_PATTERN = /^(?:(?:fa-solid|fa-regular|fa-light|fa-thin|fa-duotone|fa-brands) )?fa-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DEFAULT_SCENE_GROUP_ICON_COLOR = '#b9a4ff';

export function validateSceneGroupIconColor(color) {
  if (typeof color !== 'string' || (color && !/^#[0-9a-f]{6}$/i.test(color))) {
    throw new Error('Use a six-digit hex color, such as #69b5ff.');
  }
  return color.toLowerCase();
}

export function resolveSceneGroupIconColor(groupId, groups) {
  const seen = new Set();
  while (groupId) {
    if (seen.has(groupId)) throw new Error('Scene Group color inheritance contains a cycle.');
    seen.add(groupId);
    const group = groups instanceof Map ? groups.get(groupId) : groups?.[groupId];
    if (group?.iconColor) return validateSceneGroupIconColor(group.iconColor);
    groupId = group?.parentId;
  }
  return DEFAULT_SCENE_GROUP_ICON_COLOR;
}

export function validateSceneGroupIcon(icon) {
  if (typeof icon !== 'string' || (icon && !ICON_PATTERN.test(icon))) throw new Error('Unknown Scene Group icon.');
  return icon;
}

export function sceneGroupIconClass(icon, fallback = 'fa-object-group') {
  const value = validateSceneGroupIcon(icon || fallback);
  return value.includes(' ') ? value : `fa-solid ${value}`;
}

// Read Foundry's installed catalog rather than shipping a copied list or using
// a network service. Aliases remain searchable by their own names.
export function readSceneGroupIconCatalog(styleSheets = document.styleSheets) {
  const icons = new Map();
  const visited = new Set();
  const read = sheet => {
    if (visited.has(sheet)) return;
    visited.add(sheet);
    if (sheet.href && globalThis.location && new URL(sheet.href, location.href).origin !== location.origin) return;
    const installedIcons = /fontawesome/i.test(sheet.href || '');
    let family = 'fa-solid';
    const visit = rules => {
      for (const rule of rules) {
        if (rule.styleSheet) read(rule.styleSheet);
        if (rule.cssRules) visit(rule.cssRules);
        if (!installedIcons) continue;
        const font = rule.style?.getPropertyValue('font-family') || '';
        if (rule.type === 5 && /Font Awesome/i.test(font)) family = /Brands/i.test(font) ? 'fa-brands' : 'fa-solid';
        const glyph = rule.style?.getPropertyValue('--fa') || rule.style?.getPropertyValue('content');
        if (!glyph || /var\(/.test(glyph)) continue;
        for (const selector of (rule.selectorText || '').split(',')) {
          const match = selector.trim().match(/^\.(fa-[a-z0-9-]+)(?:::?before)?$/);
          if (!match) continue;
          const value = family === 'fa-solid' ? match[1] : `${family} ${match[1]}`;
          icons.set(value, { value, family, label: match[1].slice(3).replaceAll('-', ' ') });
        }
      }
    };
    visit(sheet.cssRules);
  };
  for (const sheet of styleSheets) read(sheet);
  if (!icons.size) throw new Error('The installed Foundry icon catalog is unavailable.');
  return [{ value: '', label: 'Default', family: 'fa-solid' }, ...[...icons.values()].sort((a, b) => a.label.localeCompare(b.label))];
}

export async function chooseSceneGroupIcon(current = '', {color = '', inheritedColor = DEFAULT_SCENE_GROUP_ICON_COLOR, title = 'Group Icon & Color', defaultIcon = 'fa-object-group', inherit = true} = {}) {
  const catalog = readSceneGroupIconCatalog();
  const escape = foundry.utils.escapeHTML;
  let selected = current, page = 0, query = '', family = 'all';
  let selectedColor = validateSceneGroupIconColor(color);
  inheritedColor = validateSceneGroupIconColor(inheritedColor) || DEFAULT_SCENE_GROUP_ICON_COLOR;
  const palette = [['Red','#ef7373'],['Orange','#f5a05b'],['Gold','#e9cb68'],['Green','#7bc895'],
    ['Teal','#66cfc9'],['Blue','#69b5ff'],['Purple','#b9a4ff'],['Pink','#ed94cf'],['White','#e5e5e5']];
  const size = 84;
  return foundry.applications.api.DialogV2.wait({
    modal: true,
    classes: ['fa-nexus-scene-group-icon-dialog'],
    window: { title }, position: { width: 520 },
    content: `<div class="fa-nexus-scene-group-color-controls">
      <div class="fa-nexus-scene-group-color-palette" role="group" aria-label="Icon color">
        <button type="button" data-icon-color="" class="fa-nexus-scene-group-color-default" title="${inherit ? 'Inherit the parent color, or use the default' : 'Use the default color'}">${inherit ? 'Inherit / Default' : 'Default'}</button>
        ${palette.map(([name,value])=>`<button type="button" data-icon-color="${value}" class="fa-nexus-scene-group-color-swatch" style="--swatch-color:${value}" title="${name}" aria-label="${name}"></button>`).join('')}
      </div>
      <label class="fa-nexus-scene-group-custom-color">Custom color <input type="color" name="iconColorPicker" aria-label="Choose custom color"><input type="text" name="iconColorHex" placeholder="${inheritedColor}" aria-label="Hex color" maxlength="7" spellcheck="false"></label>
      <p class="fa-nexus-scene-group-color-error" role="alert" hidden></p>
      </div><div class="fa-nexus-scene-group-icon-search"><input type="search" name="iconSearch" placeholder="Search icons…" aria-label="Search icons"><select name="iconFamily" aria-label="Icon family"><option value="all">All icons</option><option value="fa-solid">Symbols</option><option value="fa-brands">Brands</option></select></div>
      <div class="fa-nexus-scene-group-icon-current"></div><div class="fa-nexus-scene-group-icon-picker"></div>
      <div class="fa-nexus-scene-group-icon-pages"><button type="button" data-icon-page="-1" aria-label="Previous icons"><i class="fa-solid fa-chevron-left"></i></button><span aria-live="polite"></span><button type="button" data-icon-page="1" aria-label="Next icons"><i class="fa-solid fa-chevron-right"></i></button></div>`,
    render: (_event, dialog) => {
      const root = dialog.element;
      const renderColor = () => {
        root.style.setProperty('--fa-nexus-scene-group-icon-color', selectedColor || inheritedColor);
        root.querySelector('[name="iconColorPicker"]').value = selectedColor || inheritedColor;
        root.querySelector('[name="iconColorHex"]').value = selectedColor;
        for (const button of root.querySelectorAll('[data-icon-color]')) {
          button.setAttribute('aria-pressed', button.dataset.iconColor === selectedColor ? 'true' : 'false');
        }
      };
      const setColor = value => {
        const error = root.querySelector('.fa-nexus-scene-group-color-error');
        try {
          selectedColor = validateSceneGroupIconColor(value.trim());
          error.hidden = true;
          root.querySelector('[data-action="apply"]').disabled = false;
          renderColor();
        } catch (failure) {
          error.textContent = failure.message;
          error.hidden = false;
          root.querySelector('[data-action="apply"]').disabled = true;
        }
      };
      const render = () => {
        const terms = query.toLowerCase().replace(/^fa-/, '').split(/[\s-]+/).filter(Boolean);
        const filtered = catalog.filter(icon => (family === 'all' || icon.family === family) && terms.every(term => icon.label.includes(term)));
        const pages = Math.max(1, Math.ceil(filtered.length / size));
        page = Math.max(0, Math.min(page, pages - 1));
        root.querySelector('.fa-nexus-scene-group-icon-current').innerHTML = `<i class="${sceneGroupIconClass(selected, defaultIcon)}"></i> ${escape(catalog.find(icon => icon.value === selected)?.label || selected || 'Default')}`;
        root.querySelector('.fa-nexus-scene-group-icon-picker').innerHTML = filtered.slice(page * size, (page + 1) * size).map(icon =>
          `<label title="${escape(icon.label)}"><input type="radio" name="groupIcon" value="${icon.value}" ${icon.value === selected ? 'checked' : ''}><i class="${sceneGroupIconClass(icon.value, defaultIcon)}" aria-hidden="true"></i><span>${escape(icon.label)}</span></label>`).join('') || '<p>No matching icons.</p>';
        root.querySelector('.fa-nexus-scene-group-icon-pages span').textContent = `${filtered.length} icons · ${page + 1} / ${pages}`;
        root.querySelector('[data-icon-page="-1"]').disabled = page === 0;
        root.querySelector('[data-icon-page="1"]').disabled = page === pages - 1;
      };
      root.addEventListener('input', event => {
        if (event.target.name === 'iconSearch') { query = event.target.value; page = 0; render(); }
        if (['iconColorPicker','iconColorHex'].includes(event.target.name)) setColor(event.target.value);
      });
      root.addEventListener('change', event => {
        if (event.target.name === 'iconFamily') { family = event.target.value; page = 0; render(); }
        if (event.target.name === 'groupIcon') {
          selected = event.target.value;
          root.querySelector('.fa-nexus-scene-group-icon-current').innerHTML = `<i class="${sceneGroupIconClass(selected, defaultIcon)}"></i> ${escape(catalog.find(icon => icon.value === selected)?.label || 'Default')}`;
        }
      });
      root.addEventListener('click', event => {
        const swatch = event.target.closest('[data-icon-color]');
        if (swatch) setColor(swatch.dataset.iconColor);
        const button = event.target.closest('[data-icon-page]');
        if (button) { page += Number(button.dataset.iconPage); render(); }
      });
      renderColor();
      render();
    },
    buttons: [
      { action: 'apply', label: 'Apply', default: true, callback: () => ({icon:selected,iconColor:selectedColor}) },
      { action: 'cancel', label: 'Cancel', callback: () => false }
    ], rejectClose: false
  });
}

/** Reuse the full icon/color picker while keeping creation entirely provisional. */
export function createSceneGroupAppearanceControl() {
  let appearance={icon:'',iconColor:''};
  return {
    get value(){return {...appearance};},
    html:'<button type="button" data-group-appearance><i class="fa-solid fa-object-group"></i> Icon &amp; color…</button>',
    bind(root){
      const button=root.querySelector('[data-group-appearance]');
      button.addEventListener('click',async()=>{
        button.disabled=true;
        try{
          const chosen=await chooseSceneGroupIcon(appearance.icon,{color:appearance.iconColor});
          if(chosen){appearance=chosen;const icon=button.querySelector('i');icon.className=sceneGroupIconClass(chosen.icon);icon.style.color=chosen.iconColor||DEFAULT_SCENE_GROUP_ICON_COLOR;}
        }catch(error){ui.notifications.error(`Could not choose a group icon: ${error.message}`);}
        finally{button.disabled=false;}
      });
    }
  };
}
