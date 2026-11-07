export function normalizeMatchString(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeMatchString(value) {
  const normalized = normalizeMatchString(value);
  if (!normalized) return [];
  return normalized.split(' ');
}

export function buildMatchTokens(...values) {
  const tokens = new Set();
  for (const value of values) {
    if (!value) continue;
    const parts = tokenizeMatchString(value);
    for (const part of parts) {
      if (part) tokens.add(part);
    }
  }
  return Array.from(tokens);
}

export function stripFileExtension(value) {
  if (!value) return '';
  return String(value).replace(/\.[^./\\]+$/, '');
}

export function derivePlaceAsMatchKey(payload, card) {
  const displayName = payload?.displayName || card?.getAttribute?.('data-display-name') || '';
  const filename = payload?.filename || card?.getAttribute?.('data-filename') || '';
  const variant = payload?.variant_group || payload?.variantGroup || '';
  const fileStem = stripFileExtension(filename).replace(/[_-]+/g, ' ');
  const baseName = displayName || fileStem || filename || variant || '';
  const tokens = buildMatchTokens(displayName, fileStem, filename, variant);
  const normalized = normalizeMatchString(baseName);
  return {
    raw: baseName,
    normalized,
    tokens
  };
}

export function scorePlaceAsOption(option, { tokens = [], normalized = '' } = {}) {
  if (!option) return 0;
  const optionTokens = option.matchTokens && option.matchTokens.length
    ? option.matchTokens
    : tokenizeMatchString(option.label);
  const optionNormalized = option.matchNormalized || normalizeMatchString(option.label);
  const tokenSet = new Set(optionTokens);
  let score = 0;

  if (normalized) {
    if (optionNormalized === normalized) score += 50;
    else if (optionNormalized.startsWith(normalized) && normalized.length >= 3) score += 20;
    else if (normalized.startsWith(optionNormalized) && optionNormalized.length >= 3) score += 12;
    else if (optionNormalized.includes(normalized) && normalized.length >= 3) score += 10;
  }

  let matchCount = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (tokenSet.has(token)) {
      matchCount += 1;
      score += 12;
    } else if (optionNormalized.includes(token)) {
      matchCount += 0.5;
      score += 6;
    }
    const sourceTokens = option.sourceTokens;
    if (sourceTokens && sourceTokens.includes(token)) score += 3;
    const packTokens = option.packTokens;
    if (packTokens && packTokens.includes(token)) score += 2;
  }

  if (tokens.length && matchCount >= tokens.length) score += 8;

  if (tokens.length) {
    const diff = Math.abs(optionTokens.length - tokens.length);
    score -= diff * 1.5;
  }

  if (option.type === 'world') score += 2;

  if (normalized && option.sourceNormalized && option.sourceNormalized.includes(normalized)) {
    score += 4;
  }

  return Math.max(score, 0);
}

export function rankPlaceAsOptions({
  worldOptions = [],
  compendiumOptions = [],
  excludedPacks = new Set(),
  tokens = [],
  normalized = '',
  includeCompendium = true,
  limit = 10,
  allowZero = false
} = {}) {
  const candidates = [...worldOptions];
  if (includeCompendium) {
    const filteredCompendium = compendiumOptions.filter(
      (option) => !excludedPacks.has(option.pack)
    );
    candidates.push(...filteredCompendium);
  }
  const results = new Map();

  candidates.forEach((option, index) => {
    const score = scorePlaceAsOption(option, { tokens, normalized });
    if (score <= 0 && !allowZero) return;
    const existing = results.get(option.id);
    if (existing) {
      if (score > existing.score) {
        existing.score = score;
        existing.order = index;
      }
      return;
    }
    results.set(option.id, {
      option,
      score,
      rank: option.type === 'world' ? 0 : 1,
      order: index
    });
  });

  let ranked = Array.from(results.values());

  if (allowZero && ranked.length < limit) {
    const seen = new Set(ranked.map((entry) => entry.option.id));
    for (let i = 0; i < candidates.length && ranked.length < limit; i += 1) {
      const option = candidates[i];
      if (!option || seen.has(option.id)) continue;
      ranked.push({
        option,
        score: 0,
        rank: option.type === 'world' ? 0 : 1,
        order: ranked.length + i
      });
      seen.add(option.id);
    }
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.rank !== b.rank) return a.rank - b.rank;
    const aSort = a.option.sort || '';
    const bSort = b.option.sort || '';
    if (aSort !== bSort) return aSort.localeCompare(bSort);
    return a.order - b.order;
  });

  return ranked.slice(0, limit);
}
