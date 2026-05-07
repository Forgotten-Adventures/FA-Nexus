export const LIST_FILTER_FLAG_KEYS = Object.freeze(['locked', 'hidden', 'hsbc', 'mask']);

export const LIST_FILTER_CHIPS = Object.freeze([
  { key: 'asset', kind: 'type', label: 'Asset', icon: 'fa-solid fa-image' },
  { key: 'scatter', kind: 'type', label: 'Scatter', icon: 'fa-solid fa-braille' },
  { key: 'building', kind: 'type', label: 'Wall/Building', icon: 'fa-solid fa-building' },
  { key: 'path', kind: 'type', label: 'Path', icon: 'fa-solid fa-route' },
  { key: 'texture', kind: 'type', label: 'Texture', icon: 'fa-solid fa-paint-roller' },
  { key: 'locked', kind: 'flag', label: 'Locked', icon: 'fa-solid fa-lock' },
  { key: 'hidden', kind: 'flag', label: 'Hidden', icon: 'fa-solid fa-eye-slash' },
  { key: 'hsbc', kind: 'flag', label: 'HSBC', icon: 'fa-solid fa-sliders' }
  /* { key: 'mask', kind: 'flag', label: 'Mask', icon: 'fa-solid fa-mask' } */
]);

export function normalizeTileTypeKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'asset' || normalized === 'image') return 'asset';
  if (normalized === 'scatter') return 'scatter';
  if (normalized === 'building' || normalized === 'wall' || normalized === 'wall/building') return 'building';
  if (normalized === 'path' || normalized === 'paths') return 'path';
  if (normalized === 'texture' || normalized === 'paint') return 'texture';
  return null;
}

export function isFilterFlagKey(value) {
  return LIST_FILTER_FLAG_KEYS.includes(String(value ?? '').trim().toLowerCase());
}

export function createParsedListSearchClause() {
  return {
    includeText: [],
    excludeText: [],
    includeTypes: new Set(),
    excludeTypes: new Set(),
    includeFlags: new Set(),
    excludeFlags: new Set()
  };
}

export function isParsedListSearchClauseEmpty(parsed) {
  return !parsed
    || (
      !(parsed.includeText?.length)
      && !(parsed.excludeText?.length)
      && !(parsed.includeTypes?.size)
      && !(parsed.excludeTypes?.size)
      && !(parsed.includeFlags?.size)
      && !(parsed.excludeFlags?.size)
    );
}

export function parseListSearchClause(tokens = []) {
  const parsed = createParsedListSearchClause();
  let negateNext = false;
  for (const rawToken of tokens) {
    if (!rawToken) continue;
    if (/^not$/i.test(rawToken)) {
      negateNext = true;
      continue;
    }
    let token = String(rawToken).trim();
    let negated = negateNext;
    negateNext = false;
    if (token.startsWith('-') && token.length > 1) {
      negated = true;
      token = token.slice(1);
    }
    if (
      (token.startsWith('"') && token.endsWith('"'))
      || (token.startsWith('\'') && token.endsWith('\''))
    ) {
      token = token.slice(1, -1);
    }
    const normalized = token.trim().toLowerCase();
    if (!normalized) continue;
    const typeMatch = normalized.match(/^(?:type|kind):(.+)$/);
    if (typeMatch) {
      const typeKey = normalizeTileTypeKey(typeMatch[1]);
      if (typeKey) {
        (negated ? parsed.excludeTypes : parsed.includeTypes).add(typeKey);
        continue;
      }
    }
    if (isFilterFlagKey(normalized)) {
      (negated ? parsed.excludeFlags : parsed.includeFlags).add(normalized);
      continue;
    }
    (negated ? parsed.excludeText : parsed.includeText).push(normalized);
  }
  return parsed;
}

export function isListSearchOrToken(rawToken) {
  const token = String(rawToken ?? '').trim();
  return /^or$/i.test(token) || token === '|' || token === '||';
}

export function parseListSearchQuery(query) {
  const rawTokens = String(query ?? '').match(/"[^"]+"|\S+/g) || [];
  const clauseTokens = [];
  let currentClause = [];
  for (const rawToken of rawTokens) {
    if (!rawToken) continue;
    if (isListSearchOrToken(rawToken)) {
      if (currentClause.length) clauseTokens.push(currentClause);
      currentClause = [];
      continue;
    }
    currentClause.push(rawToken);
  }
  if (currentClause.length) clauseTokens.push(currentClause);
  const clauses = clauseTokens
    .map((tokens) => parseListSearchClause(tokens))
    .filter((parsed) => !isParsedListSearchClauseEmpty(parsed));
  if (!clauses.length) {
    const empty = createParsedListSearchClause();
    return { ...empty, clauses: [empty] };
  }
  if (clauses.length === 1) {
    return { ...clauses[0], clauses };
  }
  const empty = createParsedListSearchClause();
  return { ...empty, clauses };
}

export function entryMatchesFilterFlag(entry, flag) {
  switch (flag) {
    case 'locked': return !!entry?.locked;
    case 'hidden': return !!entry?.hidden;
    case 'hsbc': return !!entry?.hasHsbc;
    case 'mask': return !!entry?.hasMask;
    default: return false;
  }
}

export function entryMatchesParsedSearchClause(entry, parsedQuery) {
  if (!entry || entry.preview || entry.marker || entry.separator) return true;
  if (parsedQuery?.includeTypes?.size && !parsedQuery.includeTypes.has(entry.typeKey)) return false;
  if (parsedQuery?.excludeTypes?.has(entry.typeKey)) return false;
  for (const key of parsedQuery?.includeFlags || []) {
    if (!entryMatchesFilterFlag(entry, key)) return false;
  }
  for (const key of parsedQuery?.excludeFlags || []) {
    if (entryMatchesFilterFlag(entry, key)) return false;
  }
  const haystack = String(entry?.searchText || '').toLowerCase();
  for (const term of parsedQuery?.includeText || []) {
    if (!haystack.includes(term)) return false;
  }
  for (const term of parsedQuery?.excludeText || []) {
    if (haystack.includes(term)) return false;
  }
  return true;
}

export function entryMatchesListFilters(entry, sessionState, parsedQuery) {
  if (!entry || entry.preview || entry.marker || entry.separator) return true;
  if (sessionState?.typeFilters instanceof Set && sessionState.typeFilters.size) {
    if (!sessionState.typeFilters.has(entry.typeKey)) return false;
  }
  const chipFlags = sessionState?.flagFilters || {};
  for (const key of LIST_FILTER_FLAG_KEYS) {
    if (!chipFlags[key]) continue;
    if (!entryMatchesFilterFlag(entry, key)) return false;
  }
  const clauses = Array.isArray(parsedQuery?.clauses) && parsedQuery.clauses.length
    ? parsedQuery.clauses
    : [parsedQuery];
  return clauses.some((clause) => entryMatchesParsedSearchClause(entry, clause));
}

export function listFiltersActive(sessionState) {
  if (!sessionState) return false;
  if (String(sessionState.searchQuery ?? '').trim()) return true;
  if (sessionState.typeFilters instanceof Set && sessionState.typeFilters.size) return true;
  return LIST_FILTER_FLAG_KEYS.some((key) => !!sessionState.flagFilters?.[key]);
}

export function buildFilterChipContext(sessionState) {
  return LIST_FILTER_CHIPS.map((chip) => ({
    ...chip,
    active: chip.kind === 'type'
      ? !!sessionState?.typeFilters?.has?.(chip.key)
      : !!sessionState?.flagFilters?.[chip.key]
  }));
}
