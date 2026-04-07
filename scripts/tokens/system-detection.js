/**
 * System Detection Utility for FA Nexus Drag & Drop
 * Identifies the current game system and provides system-specific actor type mappings.
 */

/**
 * Actor type mapping for different game systems.
 * Each system maps to its preferred actor types and required fields.
 */
const ACTOR_TYPE_MAPPINGS = {
  // D&D 5th Edition
  'dnd5e': {
    defaultType: 'npc',
    supportedTypes: ['character', 'npc', 'vehicle'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'D&D 5th Edition'
  },

  // Pathfinder 2nd Edition
  'pf2e': {
    defaultType: 'npc',
    supportedTypes: ['character', 'npc', 'familiar', 'vehicle'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Pathfinder 2nd Edition'
  },

  // Pathfinder 1st Edition
  'pf1': {
    defaultType: 'npc',
    supportedTypes: ['character', 'npc'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Pathfinder 1st Edition'
  },

  // Savage Worlds Adventure Edition
  'swade': {
    defaultType: 'npc',
    supportedTypes: ['character', 'npc', 'vehicle'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Savage Worlds Adventure Edition'
  },

  // Warhammer Fantasy Roleplay 4th Edition
  'wfrp4e': {
    defaultType: 'npc',
    supportedTypes: ['character', 'npc', 'creature', 'vehicle'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Warhammer Fantasy Roleplay 4th Edition'
  },

  // Call of Cthulhu 7th Edition
  'coc7': {
    defaultType: 'npc',
    supportedTypes: ['character', 'npc', 'creature'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Call of Cthulhu 7th Edition'
  },

  // Cyberpunk RED
  'cyberpunk-red-core': {
    defaultType: 'character',
    supportedTypes: ['character', 'npc'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Cyberpunk RED'
  },

  // Shadowrun 5th Edition
  'shadowrun5e': {
    defaultType: 'character',
    supportedTypes: ['character', 'npc', 'spirit', 'vehicle'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Shadowrun 5th Edition'
  },

  // Alien RPG
  'alien-rpg': {
    defaultType: 'character',
    supportedTypes: ['character', 'npc', 'creature'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Alien RPG'
  },

  // Forbidden Lands
  'forbidden-lands': {
    defaultType: 'npc',
    supportedTypes: ['character', 'npc', 'monster'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Forbidden Lands'
  },

  // Das Schwarze Auge / The Dark Eye 5th Edition
  'dsa5': {
    defaultType: 'creature',
    supportedTypes: ['character', 'creature', 'npc'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Das Schwarze Auge / The Dark Eye 5th Edition'
  },

  // Black Flag Roleplaying
  'black-flag': {
    defaultType: 'npc',
    supportedTypes: ['pc', 'npc', 'lair', 'siege', 'vehicle'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Black Flag Roleplaying'
  },

  // Daggerheart
  'daggerheart': {
    defaultType: 'adversary',
    supportedTypes: ['character', 'companion', 'adversary', 'environment'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Daggerheart'
  },

  // Starfinder
  'sfrpg': {
    defaultType: 'npc',
    supportedTypes: ['character', 'npc', 'vehicle', 'starship'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Starfinder'
  },

  // Vampire: The Masquerade 5th Edition
  'vtm5e': {
    defaultType: 'character',
    supportedTypes: ['character'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Vampire: The Masquerade 5th Edition'
  },

  // Shadowdark
  'shadowdark': {
    defaultType: 'NPC',
    supportedTypes: ['Player', 'NPC'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Shadowdark RPG'
  },

  // Rolemaster Unified
  'rmu': {
    defaultType: 'Creature',
    supportedTypes: ['Creature', 'Character'],
    requiredFields: ['name', 'type'],
    optionalFields: ['img'],
    description: 'Rolemaster Unified'
  },

  // Generic fallback for unknown systems
  'generic': {
    defaultType: 'character',
    supportedTypes: ['character', 'npc'],
    requiredFields: ['name'],
    optionalFields: ['type', 'img'],
    description: 'Generic System'
  }
};

/**
 * General fallback actor types if runtime discovery is unavailable.
 */
const FALLBACK_ACTOR_TYPES = ['npc', 'character', 'creature', 'monster', 'adversary', 'enemy'];
const NPC_HINT_KEYWORDS = [
  'npc',
  'npcs',
  'non player',
  'creature',
  'creatures',
  'monster',
  'monsters',
  'adversary',
  'adversaries',
  'enemy',
  'enemies',
  'beast',
  'foe',
  'villain',
  'minion',
  'hazard',
  'mob',
  'mook',
  'threat',
  'bestiary',
  'lair',
  'siege'
];
const PC_HINT_KEYWORDS = [
  'pc',
  'pcs',
  'player',
  'players',
  'character',
  'characters',
  'hero',
  'heroes',
  'investigator',
  'adventurer',
  'protagonist',
  'survivor'
];
const SPECIAL_HINT_KEYWORDS = [
  'vehicle',
  'vehicles',
  'starship',
  'starships',
  'ship',
  'familiar',
  'companion',
  'companions',
  'pet',
  'mount',
  'mounts',
  'environment',
  'party',
  'parties',
  'group',
  'groups',
  'army',
  'crew',
  'crews',
  'squad',
  'squads',
  'unit',
  'units',
  'settlement',
  'base'
];
const MAX_COMPENDIUM_PACKS = 8;
const STATIC_FALLBACK_LOGGED = new Set();
const UNKNOWN_SYSTEM_LOGGED = new Set();
const ACTOR_TYPE_FALLBACK_CACHE = new Map();
const COMPENDIUM_HINT_CACHE = new Map();

function uniqueStrings(values = []) {
  return [...new Set(
    values
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length)
  )];
}

function normalizeHintText(value) {
  return String(value || '')
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bnon player characters?\b/gi, ' npc ')
    .replace(/\bnon player\b/gi, ' npc ')
    .replace(/\bplayer characters?\b/gi, ' pc ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKeyword(text, keyword) {
  const normalizedText = normalizeHintText(text);
  const normalizedKeyword = normalizeHintText(keyword);
  if (!normalizedText || !normalizedKeyword) return false;
  return new RegExp(`(?:^|\\s)${escapeRegExp(normalizedKeyword)}(?=$|\\s)`).test(normalizedText);
}

function localizeMaybe(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return game?.i18n?.localize ? game.i18n.localize(value) : value;
  } catch (_) {
    return value;
  }
}

function logDetection(message, details) {
  if (details === undefined) console.info(`fa-nexus | System detection: ${message}`);
  else console.info(`fa-nexus | System detection: ${message}`, details);
}

function countKeywordMatches(texts, keywords) {
  let matches = 0;
  for (const text of texts) {
    for (const keyword of keywords) {
      if (matchesKeyword(text, keyword)) matches += 1;
    }
  }
  return matches;
}

function containsKeyword(text, keywords) {
  return keywords.some((keyword) => matchesKeyword(text, keyword));
}

function getRuntimeActorTypes() {
  const actorConfig = globalThis.CONFIG?.Actor ?? {};
  const baseType = globalThis.CONST?.BASE_DOCUMENT_TYPE ?? 'base';
  const types = uniqueStrings([
    ...(Array.isArray(game?.documentTypes?.Actor) ? game.documentTypes.Actor : []),
    ...(Array.isArray(globalThis.Actor?.TYPES) ? globalThis.Actor.TYPES : []),
    ...Object.keys(actorConfig.dataModels ?? {}),
    ...Object.keys(actorConfig.typeLabels ?? {}),
    ...Object.keys(actorConfig.sheetClasses ?? {})
  ]);

  return types.filter((type) => normalizeHintText(type) !== normalizeHintText(baseType));
}

function getActorTypeSheetConfigs(actorType) {
  const configs = globalThis.CONFIG?.Actor?.sheetClasses?.[actorType];
  return (configs && typeof configs === 'object') ? Object.values(configs) : [];
}

function getActorTypeSignals(actorType) {
  const actorConfig = globalThis.CONFIG?.Actor ?? {};
  const localizedTypeLabel = localizeMaybe(actorConfig.typeLabels?.[actorType] ?? '');
  const textSources = [
    actorType,
    actorType.split('.').pop() || actorType,
    localizedTypeLabel
  ];
  const defaultSheets = [];

  for (const config of getActorTypeSheetConfigs(actorType)) {
    const label = localizeMaybe(config?.label ?? '');
    const className = String(config?.cls?.name || config?.sheetClass?.name || '').trim();
    if (label) textSources.push(label);
    if (className) textSources.push(className);
    if (config?.default) {
      if (label) textSources.push(label);
      if (className) textSources.push(className);
      defaultSheets.push(label || className || config?.id || '');
    }
  }

  const normalizedTexts = textSources
    .map((text) => normalizeHintText(text))
    .filter((text) => text.length);

  return {
    actorType,
    label: localizedTypeLabel || actorType,
    textSources: uniqueStrings(textSources),
    defaultSheets: uniqueStrings(defaultSheets),
    npcMatches: countKeywordMatches(normalizedTexts, NPC_HINT_KEYWORDS),
    pcMatches: countKeywordMatches(normalizedTexts, PC_HINT_KEYWORDS),
    specialMatches: countKeywordMatches(normalizedTexts, SPECIAL_HINT_KEYWORDS)
  };
}

function classifyActorType(signals) {
  if ((signals.npcMatches > signals.pcMatches) && (signals.npcMatches >= 1)) return 'npc';
  if ((signals.pcMatches > signals.npcMatches) && (signals.pcMatches >= 1)) return 'pc';
  if ((signals.specialMatches >= 1) && !signals.npcMatches) return 'special';
  return 'neutral';
}

function scoreActorType(signals, options = {}) {
  const preferredTypes = Array.isArray(options.preferredTypes) ? options.preferredTypes : [];
  const preferredIndex = preferredTypes.findIndex((type) => type === signals.actorType);
  const compendiumHint = options.compendiumHints?.[signals.actorType] ?? null;
  const kind = classifyActorType(signals);
  let score = 0;

  switch (kind) {
    case 'npc':
      score += 120;
      break;
    case 'neutral':
      score += 70;
      break;
    case 'special':
      score += 35;
      break;
    case 'pc':
      score += 10;
      break;
  }

  score += signals.npcMatches * 14;
  score -= signals.pcMatches * 8;
  score -= signals.specialMatches * 5;

  if (!signals.npcMatches && !signals.pcMatches && !signals.specialMatches) score += 8;
  if (options.defaultType && signals.actorType === options.defaultType) score += 30;
  if (preferredIndex !== -1) score += Math.max(0, 20 - (preferredIndex * 4));
  if (signals.actorType.includes('.')) score -= 2;

  if (compendiumHint) {
    score += Math.round(Math.sqrt(compendiumHint.count) * 8);
    score += Math.round(Math.sqrt(compendiumHint.npcCount) * 10);
    score -= Math.round(Math.sqrt(compendiumHint.pcCount) * 8);
  }

  return {
    ...signals,
    kind,
    score,
    compendium: compendiumHint ? {
      count: compendiumHint.count,
      npcCount: compendiumHint.npcCount,
      pcCount: compendiumHint.pcCount,
      packs: compendiumHint.packs
    } : null
  };
}

function rankActorTypes(actorTypes, options = {}) {
  const kindPriority = { npc: 3, neutral: 2, special: 1, pc: 0 };

  return uniqueStrings(actorTypes)
    .map((actorType) => scoreActorType(getActorTypeSignals(actorType), options))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (kindPriority[right.kind] !== kindPriority[left.kind]) return kindPriority[right.kind] - kindPriority[left.kind];
      if (right.npcMatches !== left.npcMatches) return right.npcMatches - left.npcMatches;
      if (left.pcMatches !== right.pcMatches) return left.pcMatches - right.pcMatches;
      return left.actorType.localeCompare(right.actorType);
    });
}

function summarizeRankings(rankings) {
  return rankings.map((entry) => ({
    actorType: entry.actorType,
    label: entry.label,
    kind: entry.kind,
    score: entry.score,
    npcMatches: entry.npcMatches,
    pcMatches: entry.pcMatches,
    specialMatches: entry.specialMatches,
    defaultSheets: entry.defaultSheets,
    compendium: entry.compendium ? {
      count: entry.compendium.count,
      npcCount: entry.compendium.npcCount,
      pcCount: entry.compendium.pcCount
    } : null
  }));
}

function getFallbackCacheKey(systemId, actorTypes = []) {
  return `${systemId}::${uniqueStrings(actorTypes).join('|')}`;
}

async function getCompendiumTypeHints(systemId, actorTypes = []) {
  const availableTypes = uniqueStrings(actorTypes);
  if ((availableTypes.length < 2) || !game?.packs?.size) return {};

  const cacheKey = getFallbackCacheKey(systemId, availableTypes);
  if (COMPENDIUM_HINT_CACHE.has(cacheKey)) return await COMPENDIUM_HINT_CACHE.get(cacheKey);

  const task = (async () => {
    const packs = Array.from(game.packs).filter((pack) => pack?.documentName === 'Actor');
    if (!packs.length) return {};

    const relevantPacks = packs
      .map((pack) => {
        const title = String(pack.title || pack.metadata?.label || pack.collection || '').trim();
        const normalizedTitle = normalizeHintText(title);
        const npcPack = containsKeyword(normalizedTitle, NPC_HINT_KEYWORDS);
        const pcPack = containsKeyword(normalizedTitle, PC_HINT_KEYWORDS);
        let relevance = 0;
        if (pack.metadata?.packageType === 'system') relevance += 20;
        if (pack.metadata?.packageName === systemId) relevance += 30;
        if (pack.metadata?.packageType === 'world') relevance += 5;
        if (npcPack) relevance += 15;
        if (pcPack) relevance += 8;
        return { pack, title, npcPack, pcPack, relevance };
      })
      .sort((left, right) => right.relevance - left.relevance)
      .slice(0, MAX_COMPENDIUM_PACKS);

    const availableTypeSet = new Set(availableTypes);
    const hints = {};
    const inspectedPacks = [];

    for (const candidate of relevantPacks) {
      try {
        const index = await candidate.pack.getIndex({ fields: ['type'] });
        const entries = index?.values ? Array.from(index.values()) : Array.from(index || []);
        let matches = 0;

        for (const entry of entries) {
          const actorType = typeof entry?.type === 'string' ? entry.type.trim() : '';
          if (!actorType || !availableTypeSet.has(actorType)) continue;

          const hint = hints[actorType] ||= {
            count: 0,
            npcCount: 0,
            pcCount: 0,
            packs: []
          };

          hint.count += 1;
          if (candidate.npcPack) hint.npcCount += 1;
          if (candidate.pcPack) hint.pcCount += 1;
          if (!hint.packs.includes(candidate.pack.collection)) hint.packs.push(candidate.pack.collection);
          matches += 1;
        }

        if (matches > 0) {
          inspectedPacks.push({
            collection: candidate.pack.collection,
            title: candidate.title,
            relevance: candidate.relevance,
            matches
          });
        }
      } catch (error) {
        console.warn(`fa-nexus | System detection: Failed to inspect actor compendium "${candidate.pack?.collection || 'unknown'}"`, error);
      }
    }

    if (inspectedPacks.length) {
      logDetection(`Compendium hints for "${systemId}"`, {
        inspectedPacks,
        hints: Object.fromEntries(
          Object.entries(hints).map(([actorType, hint]) => [actorType, {
            count: hint.count,
            npcCount: hint.npcCount,
            pcCount: hint.pcCount
          }])
        )
      });
    }

    return hints;
  })();

  COMPENDIUM_HINT_CACHE.set(cacheKey, task);
  return await task;
}

async function getDynamicFallbackData(systemId, mapping) {
  const availableTypes = getRuntimeActorTypes();
  if (!availableTypes.length) return null;

  const cacheKey = getFallbackCacheKey(systemId, availableTypes);
  if (ACTOR_TYPE_FALLBACK_CACHE.has(cacheKey)) return await ACTOR_TYPE_FALLBACK_CACHE.get(cacheKey);

  const task = (async () => {
    const knownMapping = ACTOR_TYPE_MAPPINGS[systemId];
    const preferredTypes = knownMapping && (systemId !== 'generic')
      ? uniqueStrings([mapping.defaultType, ...(mapping.supportedTypes || [])])
      : [];
    const defaultType = knownMapping && (systemId !== 'generic') ? mapping.defaultType : null;
    const compendiumHints = await getCompendiumTypeHints(systemId, availableTypes);
    const ranking = rankActorTypes(availableTypes, {
      defaultType,
      preferredTypes,
      compendiumHints
    });
    const prioritizedKnownTypes = preferredTypes.filter((type) => availableTypes.includes(type));
    const allTypes = uniqueStrings([
      ...prioritizedKnownTypes,
      ...ranking.map((entry) => entry.actorType),
      ...FALLBACK_ACTOR_TYPES
    ]);

    logDetection(`Resolved fallback actor types for "${systemId}"`, {
      availableTypes,
      prioritizedKnownTypes,
      rankedTypes: summarizeRankings(ranking),
      fallbackOrder: allTypes
    });

    return { availableTypes, ranking, allTypes };
  })();

  ACTOR_TYPE_FALLBACK_CACHE.set(cacheKey, task);
  return await task;
}

/**
 * Get the current game system identifier.
 * @returns {string} The current system ID (e.g., 'dnd5e', 'pf2e', 'generic')
 */
export function getCurrentSystemId() {
  if (!game || !game.system) {
    console.warn('fa-nexus | System detection: game.system not available, defaulting to generic');
    return 'generic';
  }

  const systemId = game.system.id;
  if (!ACTOR_TYPE_MAPPINGS[systemId] && !UNKNOWN_SYSTEM_LOGGED.has(systemId)) {
    UNKNOWN_SYSTEM_LOGGED.add(systemId);
    logDetection(`Unknown system "${systemId}", using runtime actor type heuristics`, {
      availableTypes: getRuntimeActorTypes()
    });
  }

  return systemId;
}

/**
 * Get system mapping for the current or specified system.
 * @param {string} [systemId] - Optional system ID to check. Defaults to current system.
 * @returns {Object} System mapping object with defaultType, supportedTypes, etc.
 */
export function getSystemMapping(systemId = null) {
  const targetSystem = systemId || getCurrentSystemId();
  return ACTOR_TYPE_MAPPINGS[targetSystem] || ACTOR_TYPE_MAPPINGS.generic;
}

/**
 * Get runtime actor types exposed by the active system.
 * @returns {string[]} Array of actor types registered in the current Foundry session
 */
export function getAvailableActorTypes() {
  return getRuntimeActorTypes();
}

/**
 * Get the default actor type for the current or specified system.
 * Uses runtime discovery for unknown systems and validates explicit mappings against registered actor types.
 * @param {string} [systemId] - Optional system ID. Defaults to current system.
 * @returns {string} Default actor type
 */
export function getDefaultActorType(systemId = null) {
  const targetSystem = systemId || getCurrentSystemId();
  const mapping = getSystemMapping(targetSystem);
  const availableTypes = getRuntimeActorTypes();

  if (availableTypes.length) {
    if (availableTypes.includes(mapping.defaultType)) return mapping.defaultType;

    const knownMapping = ACTOR_TYPE_MAPPINGS[targetSystem];
    const preferredTypes = knownMapping && (targetSystem !== 'generic')
      ? uniqueStrings([mapping.defaultType, ...(mapping.supportedTypes || [])])
      : [];
    const ranking = rankActorTypes(availableTypes, {
      defaultType: knownMapping && (targetSystem !== 'generic') ? mapping.defaultType : null,
      preferredTypes
    });

    if (ranking.length) return ranking[0].actorType;
  }

  return mapping.defaultType;
}

/**
 * Get fallback actor types to try in order.
 * Uses the system mapping first when it matches runtime types, then runtime heuristics, then generic fallbacks.
 * @param {string} [systemId] - Optional system ID. Defaults to current system.
 * @returns {Promise<string[]>} Array of actor types to try in order
 */
export async function getFallbackActorTypes(systemId = null) {
  const targetSystem = systemId || getCurrentSystemId();
  const mapping = getSystemMapping(targetSystem);
  const dynamicData = await getDynamicFallbackData(targetSystem, mapping);
  if (dynamicData?.allTypes?.length) return dynamicData.allTypes;

  const staticTypes = uniqueStrings([
    mapping.defaultType,
    ...(mapping.supportedTypes || []),
    ...FALLBACK_ACTOR_TYPES
  ]);

  if (!STATIC_FALLBACK_LOGGED.has(targetSystem)) {
    STATIC_FALLBACK_LOGGED.add(targetSystem);
    logDetection(`Using static fallback actor types for "${targetSystem}"`, staticTypes);
  }

  return staticTypes;
}

/**
 * Check if the game system is ready for actor creation.
 * @returns {boolean} True if system is ready
 */
export function isSystemReady() {
  return !!(game && game.system && game.system.id && game.ready);
}

/**
 * Map grid dimensions to creature size categories.
 * @param {number} gridWidth - Token width in grid units
 * @param {number} gridHeight - Token height in grid units
 * @returns {string} Creature size category
 */
export function getCreatureSizeFromDimensions(gridWidth, gridHeight) {
  const maxDimension = Math.max(gridWidth, gridHeight);

  if (game.system.id === 'dsa5') {
    // DSA5's size values: tiny, small, average, big, giant
    if (maxDimension >= 4) return 'giant';
    if (maxDimension >= 3) return 'giant';
    if (maxDimension >= 2) return 'big';
    return 'average';
  }

  // D&D 5e and most systems use: tiny, sm, med, lg, huge, grg
  if (maxDimension >= 4) return 'grg';
  if (maxDimension >= 3) return 'huge';
  if (maxDimension >= 2) return 'lg';
  return 'med';
}

/**
 * Validate actor data against system requirements.
 * @param {Object} actorData - Actor data to validate
 * @returns {boolean} True if valid, false otherwise
 */
export function validateActorData(actorData) {
  if (!actorData || typeof actorData !== 'object') {
    return false;
  }

  const systemMapping = getSystemMapping();
  const requiredFields = systemMapping.requiredFields || ['name'];

  for (const field of requiredFields) {
    if (!actorData[field]) {
      console.warn(`fa-nexus | System detection: Missing required field "${field}" in actor data`);
      return false;
    }
  }

  const availableTypes = getRuntimeActorTypes();
  const actorType = typeof actorData.type === 'string' ? actorData.type.trim() : '';
  if (availableTypes.length && actorType && !availableTypes.includes(actorType)) {
    console.warn(`fa-nexus | System detection: Actor type "${actorType}" is not registered for system "${getCurrentSystemId()}"`, {
      availableTypes
    });
    return false;
  }

  return true;
}

/**
 * Get basic actor data template for a specific actor type.
 * @param {string} actorType - Type of actor to create
 * @param {string} actorName - Name for the actor
 * @param {string} imageUrl - Image URL for the actor
 * @param {Object} tokenData - Token data for prototype token
 * @returns {Object} Basic actor data template
 */
export function getActorDataForType(actorType, actorName, imageUrl, tokenData = {}) {
  return {
    name: actorName,
    type: actorType,
    img: imageUrl,
    system: {},
    prototypeToken: {
      name: actorName,
      texture: {
        src: imageUrl
      },
      ...tokenData
    }
  };
}

/**
 * Get minimal actor data for systems where we don't have specific support.
 * @param {string} actorName - Name for the actor
 * @param {string} imageUrl - Image URL for the actor
 * @param {string|null} [actorType] - Optional actor type override
 * @returns {Object} Minimal actor data
 */
export function getMinimalActorData(actorName, imageUrl, actorType = null) {
  const defaultType = actorType || getDefaultActorType();

  return {
    name: actorName,
    type: defaultType,
    img: imageUrl,
    system: {},
    prototypeToken: {
      name: actorName,
      texture: {
        src: imageUrl
      }
    }
  };
}
