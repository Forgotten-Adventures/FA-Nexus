import { contentPath } from '../content/cloud-inventory-v2.js';

/** One operation's catalog lookups; the application remains the catalog owner. */
export function createPrefabCatalogLookup(service) {
  const folders = new Map();
  return async ref => {
    const folder = ref.path.slice(0, Math.max(0, ref.path.lastIndexOf('/')));
    const key = `${ref.kind}:${folder}`;
    if (!folders.has(key)) folders.set(key, service.list(ref.kind, { pathPrefix: folder })
      .then(result => new Map(result.items.map(item => [contentPath(item), item]))));
    return (await folders.get(key)).get(ref.path) || null;
  };
}

export async function describePrefabContent(refs, lookup = null) {
  const contentRefs = [];
  let premium = false, unknown = 0;
  for (const ref of refs || []) {
    const tier = ref.tier || (lookup ? (await lookup(ref))?.tier : null);
    if (tier === 'premium') premium = true;
    else if (tier !== 'free') unknown++;
    contentRefs.push(['free', 'premium'].includes(tier) ? { ...ref, tier } : { ...ref });
  }
  return { premium, unknown, contentRefs };
}

export function prefabAccessBlocker(access, auth = globalThis.game?.settings?.get('fa-nexus', 'patreon_auth_data')) {
  if (!access) return 'Checking artwork requirements…';
  if (access.missingPremium && (!auth?.authenticated || !auth.state)) return 'This prefab needs premium artwork that is not installed. Connect Patreon to download it, or add the required files to your local library.';
  if (access.unknown) return 'Artwork requirements could not be verified. Refresh the catalog and try again.';
  return '';
}

export function beginPrefabPreparationNotice(name) {
  const notification = ui.notifications.info(prefabPreparationMessage(name), {progress:true,console:false});
  let closed = false;
  return {
    update(progress) { if (!closed) ui.notifications.update(notification, {message:prefabPreparationMessage(name,progress),
      pct:progress.phase==='preview' ? .95 : progress.phase==='verifying' ? .9 : progress.phase==='resolved' ? .85
        : progress.phase==='download' ? .25+.6*progress.completed/progress.total : progress.total ? .25*progress.completed/progress.total : 0}); },
    close() { if (!closed) ui.notifications.remove(notification); closed = true; }
  };
}

export function prefabPreparationError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, userMessage: message });
}

export function prefabPreparationMessage(name, { phase, completed = 0, total = 0, file = '' } = {}) {
  const label = String(name || 'Prefab');
  if (phase === 'download') return `${label}: Downloading artwork ${completed + 1}/${total} — ${file}`;
  if (phase === 'checking') return `${label}: Checking artwork ${completed}/${total}`;
  if (phase === 'resolved') return `${label}: Artwork ready ${completed}/${total}`;
  if (phase === 'verifying') return `${label}: Verifying artwork…`;
  if (phase === 'preview') return `${label}: Preparing placement preview…`;
  return `${label}: Preparing…`;
}
