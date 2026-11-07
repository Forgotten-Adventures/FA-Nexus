import { ensureNestedFilePickerDirectory } from '../storage/file-picker-directory.js';
import { emptyCollections, validateCollections, changeCollections } from './collections-model.js';

export const COLLECTIONS_ROOT = 'fa-nexus/collections';
const file = `${COLLECTIONS_ROOT}/library.json`;
const picker = () => foundry.applications.apps.FilePicker.implementation;
let queue = Promise.resolve();

export async function readCollections() {
  let folder = '';
  for (const part of COLLECTIONS_ROOT.split('/')) {
    const listing = await picker().browse('data', folder);
    folder = folder ? `${folder}/${part}` : part;
    if (!listing.dirs.includes(folder)) return emptyCollections();
  }
  if (!(await picker().browse('data', folder)).files.includes(file)) return emptyCollections();
  const response = await fetch(foundry.utils.getRoute(file), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not read Collections (${response.status}).`);
  return validateCollections(await response.json());
}

export function writeCollectionChange(action, expectedRevision) {
  const operation = queue.catch(() => {}).then(async () => {
    if (!game.user.isGM) throw new Error('Only a GM can edit Collections.');
    const previous = await readCollections();
    if (previous.revision !== expectedRevision) throw new Error('Collections changed in another window. Reopen the browser and retry.');
    const next = changeCollections(previous, action);
    await ensureNestedFilePickerDirectory(COLLECTIONS_ROOT);
    if (JSON.stringify(await readCollections()) !== JSON.stringify(previous)) throw new Error('Collections changed while saving. Reopen the browser and retry.');
    const upload = await picker().upload('data', COLLECTIONS_ROOT,
      new File([JSON.stringify(next)], 'library.json', { type: 'application/json' }), {}, { notify: false });
    if (!upload?.path) throw new Error('Could not save Collections.');
    Hooks.callAll('fa-nexus-collections-changed');
    game.socket?.emit('module.fa-nexus', { type: 'collections-changed' });
    return next;
  });
  queue = operation;
  return operation;
}
