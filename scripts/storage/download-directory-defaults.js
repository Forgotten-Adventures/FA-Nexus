import { CONTENT_KIND_DESCRIPTORS } from '../content/content-kind-descriptors.js';

// Released worlds may have used an implicit default without storing the setting.
// Pin existing download roots before starting the downloader; never move files or
// rewrite document references. Explicit choices (including custom roots) win.
export async function preserveDownloadDirectoryDefaults({ settings, isGM, browseRoot }) {
  if (!isGM) return;
  const storage = settings.storage.get('world');
  const pending = Object.values(CONTENT_KIND_DESCRIPTORS).filter(descriptor =>
    !storage.getSetting(`fa-nexus.${descriptor.downloadDirSetting}`));
  if (!pending.length) return;
  const listing = await browseRoot();
  for (const descriptor of pending) {
    // Another GM may have chosen a directory while the browse was pending.
    if (storage.getSetting(`fa-nexus.${descriptor.downloadDirSetting}`)) continue;
    const legacyExists = listing.dirs.some(dir => decodeURIComponent(dir).replace(/\/+$/, '').split('/').at(-1) === descriptor.legacyDownloadDir);
    await settings.set('fa-nexus', descriptor.downloadDirSetting,
      legacyExists ? descriptor.legacyDownloadDir : descriptor.downloadDirDefault);
  }
}
