import { forcedReplacement, forcedDeletion } from '../../canvas/document-operators.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function sourceId(source) {
  return normalizeIdentity(source?._id || source?.id);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// A free-form object field (every `flags` scope) is MERGED key by key when a plain object is written
// to it, so a wholesale write can never drop a key the live document already carries. Only a forced
// replacement states "this subtree is exactly this". Schema-defined subtrees carry a fixed key set,
// so a plain value there is already exact.
function isFreeFormObjectPath(path) {
  return String(path || '').startsWith('flags.');
}

function legacyDeletionPath(path) {
  const parts = String(path || '').split('.');
  const leaf = parts.at(-1) || '';
  if (!leaf.startsWith('-=')) return null;
  return [...parts.slice(0, -1), leaf.slice(2)].join('.');
}

// Owned paths whose LIVE value Foundry augments from its own document schema: the Building authors
// the projection, Foundry then materialises generated identities and schema defaults inside it.
// Those paths are verified against the authored projection instead of by raw equality; every other
// owned path stays an exact match. See `building-fill-transaction.js`.
export const FOUNDRY_NORMALIZED_VALUE_PATHS = Object.freeze({
  // Region `shapes` entries gain `origin`, and each `behaviors` entry is an embedded sub-document
  // that gains `_id`, `disabled`, `flags`, `_stats` and its behaviour-type `system` defaults.
  Region: Object.freeze(['shapes', 'behaviors'])
});

export function normalizedValuePathsFor(documentName, ...valueSets) {
  const declared = FOUNDRY_NORMALIZED_VALUE_PATHS[normalizeIdentity(documentName)] || [];
  const owned = new Set(valueSets.flatMap((values) => Object.keys(values || {})));
  return Object.freeze(declared.filter((path) => owned.has(path)));
}

// Values Foundry's document schema will NOT persist as written, mapped to the value it actually
// keeps. Measured against Foundry v14's real `BaseWall.cleanData`, not inferred:
//
//   doorSound: new fields.StringField({required: false, blank: true, initial: undefined})
//
// The field is NOT nullable, so a written `null` fails `_validateSpecial` and falls back to
// `initial: undefined` — Foundry drops the field entirely. A planner that writes `null` therefore
// guarantees a post-write verification mismatch on `doorSound` on every Portal Wall. Blank is the
// value the schema keeps for "no door sound", so that is what the planner writes.
//
// This is deliberately NOT a comparison rule: verification stays exact, and a genuinely dropped
// write still fails loudly naming the field. Only what the planner ASKS FOR changes.
const FOUNDRY_PERSISTED_VALUE_NORMALIZERS = Object.freeze({
  Wall: Object.freeze({
    doorSound: (value) => (typeof value === 'string' ? value : '')
  })
});

// The same rule applied to a whole document source. A restore recreates a deleted document from
// the source it had, so it must ask for the value Foundry will keep, exactly as a patch does —
// otherwise the restored document can never equal the source it was restored from.
export function foundryPersistedSource(documentName, source) {
  return foundryPersistedValues(documentName, source);
}

export function foundryPersistedValues(documentName, values) {
  const normalizers = FOUNDRY_PERSISTED_VALUE_NORMALIZERS[normalizeIdentity(documentName)];
  if (!normalizers || !isPlainObject(values)) return values;
  const next = { ...values };
  for (const [path, normalize] of Object.entries(normalizers)) {
    if (Object.hasOwn(next, path)) next[path] = normalize(next[path]);
  }
  return next;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function fingerprint(value) {
  return JSON.stringify(canonicalValue(value));
}

// THE rule for comparing a planned value against a live one, used by every planned-vs-live check in
// the Commit path — preconditions, post-write verification, rollback verification, and the adapter's
// no-change verification. It exists once so a document whose live value Foundry augments cannot be
// compared raw at one call site and by projection at another.
//
// The owned projection of a live value is everything the Building authored at that path and nothing
// else. Every authored key must be present and match EXACTLY, recursively; an authored array must
// have the same length in the same order. Keys Foundry generates from its own document schema
// beneath an authored path (an embedded sub-document identity, a schema default such as a Region
// shape's `origin`) are not authored, so they take no part in the comparison. This is not a
// tolerance: an authored field that differs, is missing, or has moved still fails.
export function matchesOwnedProjection(live, expected) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(live) || live.length !== expected.length) return false;
    return expected.every((entry, index) => matchesOwnedProjection(live[index], entry));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(live)) return false;
    return Object.entries(expected).every(([key, value]) => (
      Object.hasOwn(live, key) && matchesOwnedProjection(live[key], value)
    ));
  }
  return fingerprint(live) === fingerprint(expected);
}

// Every top-level key of an intended document source that the live source does not satisfy. Keys
// declared as Foundry-normalized for the document are verified by owned projection; every other key
// is an exact match.
export function ownedSourceDifferences(documentName, live, intended) {
  const normalized = new Set(FOUNDRY_NORMALIZED_VALUE_PATHS[normalizeIdentity(documentName)] || []);
  const keys = new Set([...Object.keys(live || {}), ...Object.keys(intended || {})]);
  return [...keys].filter((key) => (
    normalized.has(key)
      ? !matchesOwnedProjection(live?.[key], intended?.[key])
      : fingerprint(live?.[key]) !== fingerprint(intended?.[key])
  ));
}

// Translate the planner's owned values into the exact patch that produces them. A path whose value
// is `undefined` is a removal, a free-form object subtree is a forced replacement, and a legacy
// `-=leaf` key produced by an absence-restoring planner is the same removal written the old way.
export function exactBuildingPatch(values) {
  const entries = [];
  for (const [path, value] of Object.entries(values || {})) {
    const deletionTarget = legacyDeletionPath(path);
    if (deletionTarget) {
      entries.push([deletionTarget, forcedDeletion()]);
      continue;
    }
    if (value === undefined) {
      entries.push([path, forcedDeletion()]);
      continue;
    }
    if (isPlainObject(value) && isFreeFormObjectPath(path)) {
      entries.push([path, forcedReplacement(value)]);
      continue;
    }
    entries.push([path, clone(value)]);
  }
  return Object.fromEntries(entries);
}

export function buildBuildingPatchOperation(record, {
  beforePatch,
  afterPatch,
  beforeValues,
  afterValues
} = {}, reason = 'building-current-edit') {
  const documentName = normalizeIdentity(record?.documentName);
  // What the planner ASKS FOR is normalized to what Foundry will keep, so the value it verifies
  // afterwards is the value the document can actually hold.
  const persistedAfterValues = foundryPersistedValues(documentName, afterValues);
  return Object.freeze({
    kind: 'patch-document',
    documentName,
    id: sourceId(record?.source),
    uuid: normalizeIdentity(record?.uuid),
    reason: normalizeIdentity(reason),
    beforePatch: exactBuildingPatch(beforePatch),
    afterPatch: exactBuildingPatch(foundryPersistedValues(documentName, afterPatch)),
    beforeValues: clone(beforeValues),
    afterValues: clone(persistedAfterValues),
    normalizedValuePaths: normalizedValuePathsFor(documentName, beforeValues, persistedAfterValues)
  });
}
