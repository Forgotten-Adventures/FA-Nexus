export function hasNativeSceneMemberLock(document) {
  if (typeof document?.schema?.has === 'function') return document.schema.has('locked');
  return typeof document?._source?.locked === 'boolean' || typeof document?.locked === 'boolean';
}

export function isSceneMemberLocked(document) {
  return hasNativeSceneMemberLock(document)
    ? (document?._source?.locked ?? document?.locked) === true
    : document?.flags?.['fa-nexus']?.sceneLocked === true;
}

export function buildSceneMemberLockUpdate(document, locked) {
  if (hasNativeSceneMemberLock(document)) return { _id: document.id, locked: !!locked };
  return locked
    ? { _id: document.id, 'flags.fa-nexus.sceneLocked': true }
    : { _id: document.id, 'flags.fa-nexus.-=sceneLocked': null };
}
