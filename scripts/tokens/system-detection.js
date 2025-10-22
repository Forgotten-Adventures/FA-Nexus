/**
 * System Detection Utility for FA Nexus Drag & Drop
 * Identifies the current game system and provides system-specific actor type mappings
 */

/**
 * Actor type mapping for different game systems
 * Each system maps to its preferred actor types and required fields
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
 * Fallback actor types in order of preference
 * These will be tried in sequence if the preferred type fails
 */
const FALLBACK_ACTOR_TYPES = ['npc', 'character'];

/**
 * Get the current game system identifier
 * @returns {string} The current system ID (e.g., 'dnd5e', 'pf2e', 'generic')
 */
export function getCurrentSystemId() {
  if (!game || !game.system) {
    console.warn('fa-nexus | System detection: game.system not available, defaulting to generic');
    return 'generic';
  }
  
  const systemId = game.system.id;
  
  // Check if this is a known system, log warning if using generic fallback
  if (!ACTOR_TYPE_MAPPINGS[systemId]) {
    console.info(`fa-nexus | System detection: Unknown system "${systemId}", using generic fallback`);
  }
  
  return systemId;
}

/**
 * Get system mapping for the current or specified system
 * @param {string} [systemId] - Optional system ID to check. Defaults to current system.
 * @returns {Object} System mapping object with defaultType, supportedTypes, etc.
 */
export function getSystemMapping(systemId = null) {
  const targetSystem = systemId || getCurrentSystemId();
  return ACTOR_TYPE_MAPPINGS[targetSystem] || ACTOR_TYPE_MAPPINGS.generic;
}

/**
 * Get the default actor type for the current or specified system
 * @param {string} [systemId] - Optional system ID. Defaults to current system.
 * @returns {string} Default actor type
 */
export function getDefaultActorType(systemId = null) {
  const mapping = getSystemMapping(systemId);
  return mapping.defaultType;
}

/**
 * Get fallback actor types to try in order (default type first, then other supported types, then general fallbacks)
 * @param {string} [systemId] - Optional system ID. Defaults to current system.
 * @returns {string[]} Array of actor types to try in order
 */
export function getFallbackActorTypes(systemId = null) {
  const mapping = getSystemMapping(systemId);
  const defaultType = mapping.defaultType;
  const supportedTypes = mapping.supportedTypes || [];
  
  // Start with default type, then other supported types, then general fallbacks
  const allTypes = [defaultType, ...supportedTypes, ...FALLBACK_ACTOR_TYPES];
  return [...new Set(allTypes)]; // Remove duplicates while preserving order
}

/**
 * Check if the game system is ready for actor creation
 * @returns {boolean} True if system is ready
 */
export function isSystemReady() {
  return !!(game && game.system && game.system.id && game.ready);
}

/**
 * Map grid dimensions to creature size categories
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
 * Validate actor data against system requirements
 * @param {Object} actorData - Actor data to validate
 * @returns {boolean} True if valid, false otherwise
 */
export function validateActorData(actorData) {
  if (!actorData || typeof actorData !== 'object') {
    return false;
  }
  
  const systemMapping = getSystemMapping();
  const requiredFields = systemMapping.requiredFields || ['name'];
  
  // Check all required fields are present
  for (const field of requiredFields) {
    if (!actorData[field]) {
      console.warn(`fa-nexus | System detection: Missing required field "${field}" in actor data`);
      return false;
    }
  }
  
  return true;
}

/**
 * Get basic actor data template for a specific actor type
 * @param {string} actorType - Type of actor to create
 * @param {string} actorName - Name for the actor
 * @param {string} imageUrl - Image URL for the actor
 * @param {Object} tokenData - Token data for prototype token
 * @returns {Object} Basic actor data template
 */
export function getActorDataForType(actorType, actorName, imageUrl, tokenData = {}) {
  const systemId = getCurrentSystemId();
  
  // Base actor data
  const actorData = {
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
  
  return actorData;
}

/**
 * Get minimal actor data for systems where we don't have specific support
 * @param {string} actorName - Name for the actor
 * @param {string} imageUrl - Image URL for the actor
 * @returns {Object} Minimal actor data
 */
export function getMinimalActorData(actorName, imageUrl) {
  const defaultType = getDefaultActorType();
  
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
