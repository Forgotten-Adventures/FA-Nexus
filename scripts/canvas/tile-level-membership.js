function normalizeLevelId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function normalizeLevelIds(levels) {
  const values = [];
  const append = (value) => {
    const normalized = normalizeLevelId(value);
    if (normalized) values.push(normalized);
  };

  if (levels instanceof Set || Array.isArray(levels)) {
    for (const value of levels) append(value);
  } else if (typeof levels === 'string') {
    append(levels);
  } else if (levels && (typeof levels.values === 'function')) {
    for (const value of levels.values()) append(value);
  }

  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

export function hasStructuredLevelValues(value) {
  return Array.isArray(value)
    || (value instanceof Set)
    || (typeof value === 'string')
    || !!(value && (typeof value.values === 'function'));
}

export function hasOwnLevelField(data) {
  return !!(data && (typeof data === 'object') && Object.prototype.hasOwnProperty.call(data, 'levels'));
}

export function getRawLevelIds(data) {
  if (!data || (typeof data !== 'object')) return [];

  const directLevels = data.levels;
  const sourceLevels = data._source?.levels;
  const directHasLevelField = hasStructuredLevelValues(directLevels)
    || hasOwnLevelField(data)
    || data?.schema?.has?.('levels');
  const sourceHasLevelField = hasStructuredLevelValues(sourceLevels)
    || hasOwnLevelField(data?._source);

  if (directHasLevelField) {
    const directIds = normalizeLevelIds(directLevels);
    if (directIds.length || !sourceHasLevelField) return directIds;
  }

  if (sourceHasLevelField) return normalizeLevelIds(sourceLevels);

  return [];
}
