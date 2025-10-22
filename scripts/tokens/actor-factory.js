/**
 * Actor Factory for FA Nexus Drag & Drop
 * Handles system-aware actor creation with fallback strategies
 */

import * as SystemDetection from './system-detection.js';

/**
 * Generate a clean actor name from filename
 * @param {string} filename - Original filename (e.g., "dragon_large_scale150.png")
 * @returns {string} Clean actor name (e.g., "Dragon")
 */
function generateActorName(filename) {
  if (!filename || typeof filename !== 'string') {
    return 'Unknown Actor';
  }

  // Remove file extension
  let name = filename.replace(/\.[^/.]+$/, '');
  
  // Replace underscores and dashes with spaces FIRST
  name = name.replace(/[_-]/g, ' ');
  
  // Remove size indicators using word boundaries
  name = name.replace(/\b(tiny|small|medium|large|huge|gargantuan)\b/gi, '');
  
  // Remove scale indicators using word boundaries
  name = name.replace(/\bscale\d+\b/gi, '');
  
  // Remove dimension patterns like "30x25" or "14x30"
  name = name.replace(/\b\d+x\d+\b/g, '');
  
  // Clean up extra spaces and capitalize first letter of each word
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/\b\w/g, l => l.toUpperCase());
  
  // Return cleaned name or fallback
  return name || 'Unknown Actor';
}

/**
 * Actor Factory - Main entry point for creating actors from dropped tokens
 */
export class ActorFactory {
  
  /**
   * Create an actor from drag data with system-appropriate settings
   * @param {Object} dragData - The drag data from the token drop
   * @param {Object} dropCoordinates - Drop coordinates {screen: {x, y}, world: {x, y}}
   * @returns {Promise<Object>} Created actor and token documents
   */
  static async createActorFromDragData(dragData, dropCoordinates, options = {}) {
    try {
      // Validate system readiness
      if (!SystemDetection.isSystemReady()) {
        throw new Error('Game system not ready for actor creation');
      }
      
      // Generate actor name from filename
      const actorName = generateActorName(dragData.filename);
      
      // Create actor with system-specific logic
      const actor = await this._createActorWithFallback(actorName, dragData);
      
      if (!actor) {
        throw new Error('Failed to create actor with all fallback strategies');
      }
      
      let tokenOptions = {};
      if (options && typeof options.beforeTokenCreate === 'function') {
        try {
          const result = await options.beforeTokenCreate(actor);
          if (result && typeof result === 'object') tokenOptions = result;
        } catch (error) {
          console.warn('fa-nexus | ActorFactory: beforeTokenCreate hook failed', error);
          tokenOptions = {};
        }
      }

      // Create token on canvas
      const token = await this._createTokenOnCanvas(actor, dragData, dropCoordinates, tokenOptions);
      
      return { actor, token };
      
    } catch (error) {
      console.error('fa-nexus | ActorFactory: Error creating actor:', error);
      ui.notifications.error(`Failed to create actor: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Create actor with multi-tier fallback strategy
   * @param {string} actorName - Name for the actor
   * @param {Object} dragData - Drag data containing token information
   * @returns {Promise<Actor>} Created actor or null if all strategies fail
   */
  static async _createActorWithFallback(actorName, dragData) {
    const fallbackTypes = SystemDetection.getFallbackActorTypes();
    
    // Try each fallback type in sequence
    for (const actorType of fallbackTypes) {
      try {
        // Get actor data for this type
        const actorData = this._buildActorData(actorName, actorType, dragData);
        
        // Validate the data
        if (!SystemDetection.validateActorData(actorData)) {
          console.warn(`fa-nexus | ActorFactory: Actor data validation failed for type "${actorType}"`);
          continue;
        }
        
        // Attempt to create the actor
        const actor = await ActorFactory._createActorInTargetFolder(actorData);
        
        if (actor) {
          return actor;
        }
        
      } catch (error) {
        console.warn(`fa-nexus | ActorFactory: Failed to create actor with type "${actorType}":`, error.message);
        // Continue to next fallback type
      }
    }
    
    // If all typed attempts failed, try minimal data approach
    console.warn('fa-nexus | ActorFactory: All typed actor creation attempts failed, trying minimal data approach');
    
    try {
      const minimalData = SystemDetection.getMinimalActorData(actorName, dragData.url);
      const actor = await ActorFactory._createActorInTargetFolder(minimalData);
      
      if (actor) {
        console.log(`fa-nexus | ActorFactory: Created minimal actor: ${actorName}`);
        return actor;
      }
      
    } catch (error) {
      console.error('fa-nexus | ActorFactory: Minimal data approach also failed:', error.message);
    }
    
    return null;
  }

  /**
   * Create actor in a user-configured folder if available.
   */
  static async _createActorInTargetFolder(actorData) {
    try {
      const folderPath = game.settings.get('fa-nexus', 'actorCreationFolder') || '';
      if (folderPath) {
        // Try to find or create nested folders by path (e.g., Characters/Nexus)
        const parts = String(folderPath).split('/').filter(Boolean);
        let parent = null;
        for (const name of parts) {
          let folder = game.folders.find(f => f.type === 'Actor' && f.name === name && f.folder?.id === parent?.id);
          if (!folder) {
            folder = await Folder.create({ name, type: 'Actor', folder: parent?.id || null });
          }
          parent = folder;
        }
        if (parent?.id) {
          actorData.folder = parent.id;
        }
      }
    } catch (_) {}
    return await Actor.create(actorData);
  }
  
  /**
   * Build actor data for a specific type and system
   * @param {string} actorName - Name for the actor
   * @param {string} actorType - Type of actor to create
   * @param {Object} dragData - Drag data containing token information
   * @returns {Object} Actor data object
   */
  static _buildActorData(actorName, actorType, dragData) {
    // Get base actor data from system detection
    const tokenData = this._buildTokenData(dragData);
    const actorData = SystemDetection.getActorDataForType(actorType, actorName, dragData.url, tokenData);
    
    // Add system-specific enhancements
    const systemId = SystemDetection.getCurrentSystemId();

    switch (systemId) {
      case 'dnd5e':
        return this._enhanceForDnd5e(actorData, actorType, dragData);
      case 'pf2e':
        return this._enhanceForPf2e(actorData, actorType, dragData);
      case 'pf1':
        return this._enhanceForPf1(actorData, actorType, dragData);
      case 'dsa5':
        return this._enhanceForDsa5(actorData, actorType, dragData);
      case 'black-flag':
        return this._enhanceForBlackFlag(actorData, actorType, dragData);
      case 'daggerheart':
        return this._enhanceForDaggerheart(actorData, actorType, dragData);
      default:
        return actorData; // Keep minimal data for unknown systems
    }
  }
  
  /**
   * Build token prototype data from drag information
   * @param {Object} dragData - Drag data containing token size and URL
   * @returns {Object} Token prototype data
   */
  static _buildTokenData(dragData) {
    const { gridWidth, gridHeight, scale } = dragData.tokenSize;
    
    // Check if this is a gargantuan token with explicit dimensions that can be optimized
    const optimizedDimensions = this._optimizeGargantuanDimensions(dragData.filename, gridWidth, gridHeight, scale);
    
    const baseScale = Number.isFinite(optimizedDimensions.scale) ? optimizedDimensions.scale : 1;
    const scaleX = baseScale * (dragData?.mirrorX ? -1 : 1);
    const scaleY = baseScale * (dragData?.mirrorY ? -1 : 1);

    return {
      width: optimizedDimensions.gridWidth,
      height: optimizedDimensions.gridHeight,
      texture: {
        src: dragData.url,
        scaleX, // Negative scale indicates a mirrored axis in Foundry
        scaleY,
        fit: optimizedDimensions.fit
      },
      actorLink: true // Link to actor data
      // Let Foundry's Prototype Token Overrides handle display settings
      // (displayName, displayBars, disposition, sight, etc.)
    };
  }

  /**
   * Optimize gargantuan token dimensions for easier canvas handling
   * @param {string} filename - The token filename to parse
   * @param {number} originalGridWidth - Original grid width
   * @param {number} originalGridHeight - Original grid height  
   * @param {number} originalScale - Original scale
   * @returns {Object} Optimized dimensions {gridWidth, gridHeight, scale, fit}
   */
  static _optimizeGargantuanDimensions(filename, originalGridWidth, originalGridHeight, originalScale) {
    const name = filename.toLowerCase();
    
    // Only optimize gargantuan tokens with explicit size patterns like "38x33"
    if (!name.includes('gargantuan')) {
      return {
        gridWidth: originalGridWidth,
        gridHeight: originalGridHeight, 
        scale: originalScale,
        fit: 'contain'
      };
    }
    
    // Look for explicit size pattern like "38x33"
    const sizeMatch = name.match(/(\d+)x(\d+)/);
    if (!sizeMatch) {
      return {
        gridWidth: originalGridWidth,
        gridHeight: originalGridHeight,
        scale: originalScale, 
        fit: 'contain'
      };
    }
    
    const actualWidth = parseInt(sizeMatch[1]);
    const actualHeight = parseInt(sizeMatch[2]);
    
    // Constants for optimization
    const MIN_GARGANTUAN_SIZE = 4; // Minimum gargantuan grid size
    const MAX_SCALE = 3; // Maximum scale multiplier
    
    // Find the smaller actual dimension to base calculations on
    const smallerDimension = Math.min(actualWidth, actualHeight);
    const isWidthSmaller = actualWidth < actualHeight;
    
    // Calculate optimal grid size: smaller_dimension / max_scale
    let optimalGridSize = Math.ceil(smallerDimension / MAX_SCALE);
    
    // Ensure minimum gargantuan size
    optimalGridSize = Math.max(optimalGridSize, MIN_GARGANTUAN_SIZE);
    
    // Calculate the scale needed to represent the smaller dimension
    const calculatedScale = smallerDimension / optimalGridSize;
    
    // Ensure scale doesn't exceed maximum
    const finalScale = Math.min(calculatedScale, MAX_SCALE);
    
    // Use square dimensions (both width and height use the optimal size)
    const finalGridWidth = optimalGridSize;
    const finalGridHeight = optimalGridSize;
    
    // Set texture fit mode based on which original dimension was smaller
    const textureFit = isWidthSmaller ? 'width' : 'height';
    
    console.log(`fa-nexus | Gargantuan Optimization: ${filename}`);
    console.log(`fa-nexus | Original: ${actualWidth}x${actualHeight} → ${originalGridWidth}x${originalGridHeight} grid @ ${originalScale}x scale`);
    console.log(`fa-nexus | Optimized: ${actualWidth}x${actualHeight} → ${finalGridWidth}x${finalGridHeight} grid @ ${finalScale.toFixed(2)}x scale, fit: ${textureFit}`);
    
    return {
      gridWidth: finalGridWidth,
      gridHeight: finalGridHeight,
      scale: finalScale,
      fit: textureFit
    };
  }
  
  /**
   * Get creature size from grid dimensions
   * @param {number} gridWidth - Grid width in squares
   * @param {number} gridHeight - Grid height in squares
   * @returns {string} Size category
   */
  static _getCreatureSizeFromGridDimensions(gridWidth, gridHeight) {
    return SystemDetection.getCreatureSizeFromDimensions(gridWidth, gridHeight);
  }

  /**
   * Enhance actor data for D&D 5e system
   * @param {Object} actorData - Base actor data
   * @param {string} actorType - Actor type
   * @param {Object} dragData - Drag data
   * @returns {Object} Enhanced actor data
   */
  static _enhanceForDnd5e(actorData, actorType, dragData) {
    // Safely extract token size with fallbacks
    const tokenSize = dragData.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };
    const { gridWidth, gridHeight } = tokenSize;
    const sizeCategory = this._getCreatureSizeFromGridDimensions(gridWidth, gridHeight);
    
    // Add D&D 5e specific data structure
    if (actorType === 'npc') {
      actorData.system = {
        abilities: {
          str: { value: 10 },
          dex: { value: 10 },
          con: { value: 10 },
          int: { value: 10 },
          wis: { value: 10 },
          cha: { value: 10 }
        },
        attributes: {
          hp: { value: 10, max: 10 },
          ac: { value: 10 }
        },
        details: {
          type: { value: 'humanoid' },
          cr: 0
        },
        traits: {
          size: sizeCategory
        }
      };
    } else {
      // For character actors, just set the size trait
      actorData.system = actorData.system || {};
      actorData.system.traits = actorData.system.traits || {};
      actorData.system.traits.size = sizeCategory;
    }
    
    return actorData;
  }
  
  /**
   * Enhance actor data for Pathfinder 2e system
   * @param {Object} actorData - Base actor data
   * @param {string} actorType - Actor type
   * @param {Object} dragData - Drag data
   * @returns {Object} Enhanced actor data
   */
  static _enhanceForPf2e(actorData, actorType, dragData) {
    // Safely extract token size with fallbacks
    const tokenSize = dragData.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };
    const { gridWidth, gridHeight, scale } = tokenSize;
    const sizeCategory = this._getCreatureSizeFromGridDimensions(gridWidth, gridHeight);
    
    // Set actor system data with appropriate size
    actorData.system = actorData.system || {};
    actorData.system.traits = actorData.system.traits || {};
    actorData.system.traits.size = { value: sizeCategory };
    
    // Apply custom scale to prototype token and prevent PF2e from overriding it
    if (actorData.prototypeToken) {
      // Set flags to preserve our custom scale
      actorData.prototypeToken.flags = actorData.prototypeToken.flags || {};
      actorData.prototypeToken.flags['fa-nexus'] = {
        customScale: true,
        originalScale: scale
      };
      
      // Apply the parsed scale to the texture
      if (actorData.prototypeToken.texture) {
        actorData.prototypeToken.texture.scaleX = scale;
        actorData.prototypeToken.texture.scaleY = scale;
      }
      
      // Disable PF2e's automatic scale adjustments
      actorData.prototypeToken.flags.pf2e = actorData.prototypeToken.flags.pf2e || {};
      actorData.prototypeToken.flags.pf2e.linkToActorSize = false;
    }
    
    console.log(`fa-nexus | PF2e: Set creature size to "${sizeCategory}" (${gridWidth}x${gridHeight}) with ${scale}x scale for ${actorData.name}`);
    return actorData;
  }
  
  /**
   * Enhance actor data for Pathfinder 1e system
   * @param {Object} actorData - Base actor data
   * @param {string} actorType - Actor type
   * @param {Object} dragData - Drag data
   * @returns {Object} Enhanced actor data
   */
  static _enhanceForPf1(actorData, actorType, dragData) {
    // Safely extract token size with fallbacks
    const tokenSize = dragData.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };
    const { gridWidth, gridHeight, scale } = tokenSize;
    const sizeCategory = this._getCreatureSizeFromGridDimensions(gridWidth, gridHeight);
    
    // Set actor system data with appropriate size
    actorData.system = actorData.system || {};
    actorData.system.traits = actorData.system.traits || {};
    actorData.system.traits.size = sizeCategory; // PF1 uses string directly, not { value: }
    
    // Apply custom scale to prototype token and prevent PF1 from overriding it
    if (actorData.prototypeToken) {
      // Set flags to preserve our custom scale
      actorData.prototypeToken.flags = actorData.prototypeToken.flags || {};
      actorData.prototypeToken.flags['fa-nexus'] = {
        customScale: true,
        originalScale: scale
      };
      
      // Apply the parsed scale to the texture
      if (actorData.prototypeToken.texture) {
        actorData.prototypeToken.texture.scaleX = scale;
        actorData.prototypeToken.texture.scaleY = scale;
      }
      
      // Disable PF1's automatic scale adjustments
      actorData.prototypeToken.flags.pf1 = actorData.prototypeToken.flags.pf1 || {};
      actorData.prototypeToken.flags.pf1.linkToActorSize = false;
    }
    
    console.log(`fa-nexus | PF1: Set creature size to "${sizeCategory}" (${gridWidth}x${gridHeight}) with ${scale}x scale for ${actorData.name}`);
    return actorData;
  }

  /**
   * Enhance actor data for DSA5 system
   * @param {Object} actorData - Base actor data
   * @param {string} actorType - Actor type
   * @param {Object} dragData - Drag data
   * @returns {Object} Enhanced actor data
   */
  static _enhanceForDsa5(actorData, actorType, dragData) {
    // Safely extract token size with fallbacks
    const tokenSize = dragData.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };
    const { gridWidth, gridHeight, scale } = tokenSize;
    const sizeCategory = this._getCreatureSizeFromGridDimensions(gridWidth, gridHeight);

    actorData.system = actorData.system || {};
    actorData.system.status = actorData.system.status || {};
    actorData.system.status.size = { value: sizeCategory };

    switch (actorType) {
      case 'character':
        actorData.system.status.wounds = { value: 10, max: 10 };
        actorData.system.status.astralenergy = { value: 10, max: 10 };
        actorData.system.status.karmaenergy = { value: 0, max: 0 };
        break;

      case 'creature':
        actorData.system.description = actorData.system.description || { value: '' };
        actorData.system.behavior = actorData.system.behavior || { value: '' };
        actorData.system.flight = actorData.system.flight || { value: '' };
        actorData.system.specialRules = actorData.system.specialRules || { value: '' };
        break;

      case 'npc':
        actorData.system.status.wounds = { value: 10, max: 10 };
        actorData.system.status.astralenergy = { value: 10, max: 10 };
        actorData.system.status.karmaenergy = { value: 0, max: 0 };
        break;
    }

    // Apply custom scale to prototype token and prevent DSA5 from overriding it
    if (actorData.prototypeToken) {
      actorData.prototypeToken.flags = actorData.prototypeToken.flags || {};
      actorData.prototypeToken.flags['fa-nexus'] = {
        customScale: true,
        originalScale: scale
      };

      if (actorData.prototypeToken.texture) {
        actorData.prototypeToken.texture.scaleX = scale;
        actorData.prototypeToken.texture.scaleY = scale;
      }

      actorData.prototypeToken.flags.dsa5 = actorData.prototypeToken.flags.dsa5 || {};
      actorData.prototypeToken.flags.dsa5.linkToActorSize = false;
      actorData.prototypeToken.scale = scale;
    }

    console.log(`fa-nexus | DSA5: Created ${actorType} with size category "${sizeCategory}" (${gridWidth}x${gridHeight}) with ${scale}x scale for ${actorData.name}`);
    return actorData;
  }

  /**
   * Enhance actor data for Black Flag system
   * @param {Object} actorData - Base actor data
   * @param {string} actorType - Actor type
   * @param {Object} dragData - Drag data
   * @returns {Object} Enhanced actor data
   */
  static _enhanceForBlackFlag(actorData, actorType, dragData) {
    // Safely extract token size with fallbacks
    const tokenSize = dragData.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };
    const { gridWidth, gridHeight } = tokenSize;
    const sizeCategory = this._getCreatureSizeFromGridDimensions(gridWidth, gridHeight);
    
    actorData.system = actorData.system || {};
    actorData.system.traits = actorData.system.traits || {};
    actorData.system.traits.size = sizeCategory;
    
    console.log(`fa-nexus | Black Flag: Set creature size to "${sizeCategory}" for ${actorData.name} (${gridWidth}x${gridHeight} grid)`);
    return actorData;
  }

  /**
   * Enhance actor data for Daggerheart system
   * @param {Object} actorData - Base actor data
   * @param {string} actorType - Actor type
   * @param {Object} dragData - Drag data
   * @returns {Object} Enhanced actor data
   */
  static _enhanceForDaggerheart(actorData, actorType, dragData) {
    // Safely extract token size with fallbacks
    const tokenSize = dragData.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };
    const { gridWidth, gridHeight } = tokenSize;
    const sizeCategory = this._getCreatureSizeFromGridDimensions(gridWidth, gridHeight);
    
    actorData.system = actorData.system || {};
    actorData.system.bio = actorData.system.bio || {};
    actorData.system.bio.size = sizeCategory;
    
    console.log(`fa-nexus | Daggerheart: Set creature size to "${sizeCategory}" for ${actorData.name} (${gridWidth}x${gridHeight} grid)`);
    return actorData;
  }
  
  /**
   * Create token on canvas from actor and drop data
   * @param {Actor} actor - The created actor
   * @param {Object} dragData - Drag data containing token information
   * @param {Object} dropCoordinates - Drop coordinates (already snapped)
   * @returns {Promise<TokenDocument>} Created token document
   */
  static async _createTokenOnCanvas(actor, dragData, dropCoordinates, tokenOptions = {}) {
    const { world } = dropCoordinates;

    // Use the optimized dimensions from the actor's prototype token data
    // This ensures we use the optimized dimensions for gargantuan tokens
    const prototypeToken = actor.prototypeToken;
    const gridWidth = prototypeToken.width;
    const gridHeight = prototypeToken.height;
    const prototypeScaleX = Number(prototypeToken.texture.scaleX ?? 1) || 1;
    const prototypeScaleY = Number(prototypeToken.texture.scaleY ?? 1) || 1;
    const baseScaleX = Math.abs(prototypeScaleX);
    const baseScaleY = Math.abs(prototypeScaleY);
    const textureFit = prototypeToken.texture.fit;
    const textureMirrorX = prototypeScaleX < 0;
    const textureMirrorY = prototypeScaleY < 0;
    const tokenRotation = Number.isFinite(dragData?.rotation) ? Number(dragData.rotation) : 0;

    // Get grid size for calculating token dimensions
    const gridSize = canvas.grid.size;

    // Calculate actual token dimensions in pixels using optimized dimensions
    const tokenWidth = gridWidth * gridSize;
    const tokenHeight = gridHeight * gridSize;
    
    // Center the token on the cursor position
    // Since Foundry token coordinates are top-left corner, we need to offset by half dimensions
    const tokenX = world.x - (tokenWidth / 2);
    const tokenY = world.y - (tokenHeight / 2);
    
    // Create base token data with positioning and optimized texture settings
    const actorLink = tokenOptions?.actorLink ?? prototypeToken?.actorLink ?? false;
    const hpOverride = tokenOptions?.hpOverride ?? null;

    const requestMirrorX = dragData?.mirrorX !== undefined ? !!dragData.mirrorX : textureMirrorX;
    const requestMirrorY = dragData?.mirrorY !== undefined ? !!dragData.mirrorY : textureMirrorY;
    const appliedScaleX = baseScaleX * (requestMirrorX ? -1 : 1);
    const appliedScaleY = baseScaleY * (requestMirrorY ? -1 : 1);

    const baseTokenData = {
      name: actor.name,
      actorId: actor.id,
      actorLink,
      x: tokenX,
      y: tokenY,
      width: gridWidth,
      height: gridHeight,
      texture: {
        src: dragData.url,
        scaleX: appliedScaleX,
        scaleY: appliedScaleY,
        fit: textureFit
      },
      rotation: tokenRotation,
      lockRotation: false,
      randomImg: false,
      flags: {
        'fa-nexus': {
          customScale: true,
          originalScale: baseScaleX
        }
      }
    };

    if (hpOverride && actorLink === false) {
      ActorFactory._applyHpOverrideToTokenData(baseTokenData, hpOverride);
    }
    
    // Create token document
    const tokenDoc = await TokenDocument.create(baseTokenData, { parent: canvas.scene });

    if (dragData?.mirrorX !== undefined || dragData?.mirrorY !== undefined) {
      try {
        await tokenDoc.update({
          'texture.scaleX': appliedScaleX,
          'texture.scaleY': appliedScaleY
        }, { animate: false });
      } catch (_) {}
    }

    // Reapply/restore scale for systems that override prototype values
    try {
      const systemId = SystemDetection.getCurrentSystemId();
      if (systemId === 'pf2e') {
        // Ensure PF2e doesn't relink size; preserve custom scale
        await tokenDoc.update({
          'texture.scaleX': appliedScaleX,
          'texture.scaleY': appliedScaleY,
          'flags.pf2e.linkToActorSize': false,
          'flags.fa-nexus.customScale': true,
          'flags.fa-nexus.originalScale': baseScaleX
        }, { animate: false });
      } else if (systemId === 'dsa5') {
        // DSA5 can override scales after placement; reapply after a tick
        setTimeout(async () => {
          try {
            await tokenDoc.update({
              'texture.scaleX': appliedScaleX,
              'texture.scaleY': appliedScaleY
            }, { animate: false });
          } catch (_) {}
        }, 50);
      }
    } catch (_) {}

    return tokenDoc;
  }

  static _applyHpOverrideToTokenData(target, override) {
    if (!target || !override) return false;
    const utils = foundry?.utils;
    const hpPath = override.path || 'system.attributes.hp';
    const valuePath = `actorData.${hpPath}.value`;
    const maxPath = `actorData.${hpPath}.max`;
    try {
      if (utils?.setProperty) {
        utils.setProperty(target, valuePath, override.value);
        utils.setProperty(target, maxPath, override.max);
        return true;
      }
    } catch (error) {
      console.warn('fa-nexus | ActorFactory: Failed to inject HP override into token data', error);
    }

    const apply = (path, value) => {
      const parts = String(path).split('.').filter((part) => part.length);
      if (!parts.length) return;
      let cursor = target;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const key = parts[i];
        if (cursor[key] === undefined || cursor[key] === null) cursor[key] = {};
        cursor = cursor[key];
      }
      cursor[parts[parts.length - 1]] = value;
    };

    apply(valuePath, override.value);
    apply(maxPath, override.max);
    return true;
  }
  
  /**
   * Update an actor's prototype token with new token data
   * @param {Actor} actor - The actor to update
   * @param {Object} dropData - The token drop data
   * @param {Object} options - Update options
   * @returns {Promise<void>}
   */
  static async updateActorPrototypeToken(actor, dropData, options = {}) {
    const tokenSize = dropData.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };
    const systemId = SystemDetection.getCurrentSystemId();
    const baseScale = Number(tokenSize.scale ?? 1) || 1;
    const textureScaleX = baseScale * (dropData?.mirrorX ? -1 : 1);
    const textureScaleY = baseScale * (dropData?.mirrorY ? -1 : 1);
    
    // Determine if using wildcard (could be implemented later)
    const useWildcard = options.useWildcard || false;
    let tokenUrl = dropData.url;
    
    // Convert to wildcard path if requested
    if (useWildcard && typeof tokenUrl === 'string') {
      tokenUrl = ActorFactory._convertToWildcardPath(tokenUrl);
    }
    
    // Start with base prototype token update data
    const prototypeTokenUpdate = {
      texture: {
        src: tokenUrl,
        scaleX: textureScaleX,
        scaleY: textureScaleY
      },
      width: tokenSize.gridWidth,
      height: tokenSize.gridHeight,
      scale: Math.abs(baseScale),
      lockRotation: false,
      randomImg: useWildcard,
      // Disable Dynamic Rings subject texture to avoid overriding image path
      ring: {
        enabled: false,
        subject: { texture: null }
      }
    };
    
    // System-specific handling
    const sizeCategory = SystemDetection.getCreatureSizeFromDimensions(tokenSize.gridWidth, tokenSize.gridHeight);
    
    if (systemId === 'pf2e') {
      // Pathfinder 2nd Edition specific handling
      prototypeTokenUpdate.flags = prototypeTokenUpdate.flags || {};
      prototypeTokenUpdate.flags['fa-nexus'] = {
        customScale: true,
        originalScale: Math.abs(baseScale)
      };
      prototypeTokenUpdate.flags.pf2e = prototypeTokenUpdate.flags.pf2e || {};
      prototypeTokenUpdate.flags.pf2e.linkToActorSize = false;
      
      // Update actor's size trait to match token dimensions
      await actor.update({
        'system.traits.size': { value: sizeCategory }
      });
      
    } else if (systemId === 'pf1') {
      // Pathfinder 1st Edition specific handling
      prototypeTokenUpdate.flags = prototypeTokenUpdate.flags || {};
      prototypeTokenUpdate.flags['fa-nexus'] = {
        customScale: true,
        originalScale: Math.abs(baseScale)
      };
      prototypeTokenUpdate.flags.pf1 = prototypeTokenUpdate.flags.pf1 || {};
      prototypeTokenUpdate.flags.pf1.linkToActorSize = false;
      
      // Update actor's size trait (PF1 uses string directly)
      await actor.update({
        'system.traits.size': sizeCategory
      });
      
    } else if (systemId === 'dnd5e') {
      // D&D 5e specific handling
      await actor.update({
        'system.traits.size': sizeCategory
      });
      
    } else if (systemId === 'dsa5') {
      // DSA5 specific handling
      prototypeTokenUpdate.flags = prototypeTokenUpdate.flags || {};
      prototypeTokenUpdate.flags['fa-nexus'] = {
        customScale: true,
        originalScale: Math.abs(baseScale)
      };
      prototypeTokenUpdate.flags.dsa5 = prototypeTokenUpdate.flags.dsa5 || {};
      prototypeTokenUpdate.flags.dsa5.linkToActorSize = false;
      
      await actor.update({
        'system.status.size': { value: sizeCategory }
      });
    }
    
    // Prepare actor update data
    const actorUpdateData = {
      prototypeToken: prototypeTokenUpdate
    };
    
    // Update actor portrait if requested
    if (options.updateActorImage) {
      actorUpdateData.img = dropData.url;
    }
    
    // Update the actor with the prototype token changes
    await actor.update(actorUpdateData);

    // If wildcard is requested, trigger background download of all color variants
    try {
      if (useWildcard) {
        // Only run wildcard downloads for cloud-sourced tokens
        const isCloudSource = String(dropData?.originSource || '').toLowerCase() === 'cloud';
        if (!isCloudSource) return; // skip for local source tokens
        // Fire-and-forget; do not block the UI
        ActorFactory._downloadWildcardVariants(dropData).catch(() => {});
      }
    } catch (_) {}
  }

  /**
   * Convert a token path to wildcard format by replacing variant number with '*'
   * Example: My_Token_01.webp -> My_Token_*.webp
   * @param {string} tokenPath
   * @returns {string}
   * @private
   */
  static _convertToWildcardPath(tokenPath) {
    try {
      const parts = String(tokenPath).split('/');
      const filename = parts.pop() || '';
      const dot = filename.lastIndexOf('.');
      const nameOnly = dot >= 0 ? filename.slice(0, dot) : filename;
      const ext = dot >= 0 ? filename.slice(dot + 1) : '';
      
      // Detect trailing _NN pattern
      const m = nameOnly.match(/^(.*)_(\d{2})$/);
      if (!m) {
        // No color variant detected, return original path
        parts.push(filename);
        return parts.join('/');
      }
      
      const base = m[1];
      let wildcardFilename = `${base}_*.${ext || 'webp'}`;
      wildcardFilename = ActorFactory._escapeWildcardSpecialChars(wildcardFilename);
      parts.push(wildcardFilename);
      return parts.join('/');
    } catch (e) {
      return tokenPath;
    }
  }

  /**
   * Escape special characters that might cause issues with wildcard filenames
   * @param {string} filename
   * @returns {string}
   * @private
   */
  static _escapeWildcardSpecialChars(filename) {
    return String(filename)
      .replace(/!/g, '?')
      .replace(/\[/g, '?')
      .replace(/\]/g, '?');
  }

  /**
   * Trigger download of all color variants for the dropped token when wildcard is used.
   * Skips variants already cached/downloaded locally.
   * @param {{filename:string}} dropData
   * @returns {Promise<void>}
   * @private
   */
  static async _downloadWildcardVariants(dropData) {
    try {
      const filename = String(dropData?.filename || '').trim();
      if (!filename) return;

      // Extract base name and extension: "Name_01.webp" -> base="Name", ext="webp"
      const m = filename.match(/^(.*)_([0-9]{2})\.(webp|png|jpg|jpeg)$/i);
      if (!m) return; // no color variant pattern detected
      const base = m[1];
      const ext = m[3];

      // Resolve shared services from the main app
      const app = foundry.applications.instances.get('fa-nexus-app');
      const svc = app?._contentService;
      const dl = app?._downloadManager;
      if (!svc || !dl) return;

      // Pull auth state (if premium is involved)
      let state = null;
      try { const auth = game.settings.get('fa-nexus', 'patreon_auth_data'); state = auth?.state || null; } catch (_) {}

      // Query cloud DB for candidates with the same base (narrow using text filter)
      // We'll post-filter to exact variant pattern for safety
      const { items } = await svc.list('tokens', { text: base });
      if (!Array.isArray(items) || !items.length) return;

      // Filter to exact filename pattern and collect variants in order
      const re = new RegExp(`^${base.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&')}_(\\d{2})\\.${ext}$`, 'i');
      const variants = items.filter(it => re.test(String(it.filename || '')));
      if (!variants.length) return;
      variants.sort((a, b) => {
        const am = String(a.filename||'').match(/_(\d{2})\.[^.]+$/);
        const bm = String(b.filename||'').match(/_(\d{2})\.[^.]+$/);
        const av = am ? parseInt(am[1], 10) : 0;
        const bv = bm ? parseInt(bm[1], 10) : 0;
        return av - bv;
      });

      // Build the worklist: variants not cached and accessible (free or authed)
      const toDownload = [];
      for (const it of variants) {
        try {
          const already = dl.getLocalPath('tokens', { filename: it.filename, path: it.file_path || it.path });
          const tier = String(it.tier || 'free');
          const canAccess = (tier === 'free') || !!state;
          if (!already && canAccess) toDownload.push(it);
        } catch (_) {}
      }

      if (!toDownload.length) {
        try { ui.notifications?.info?.(`All color variants already cached for ${base}`); } catch (_) {}
        return;
      }

      try { ui.notifications?.info?.(`Downloading ${toDownload.length} color variant(s) for ${base}…`); } catch (_) {}

      // Download missing variants sequentially to avoid overwhelming host
      let success = 0;
      for (const it of toDownload) {
        try {
          const url = await svc.getFullURL('tokens', it, state);
          const localPath = await dl.ensureLocal('tokens', it, url);
          // Reflect cached state in main grid cards for this filename
          try { ActorFactory._updateMainGridVariantCached(it.filename, localPath); } catch (_) {}
          success++;
        } catch (_) { /* skip individual failures */ }
      }

      try { ui.notifications?.info?.(`Downloaded ${success} of ${toDownload.length} color variant(s) for ${base}`); } catch (_) {}
    } catch (_) { /* swallow errors to keep UI responsive */ }
  }

  /**
   * Update status icon and attributes for all main-grid cards matching filename to "cached".
   * @param {string} filename
   * @param {string} localPath
   * @private
   */
  static _updateMainGridVariantCached(filename, localPath) {
    if (!filename || !localPath) return;
    try {
      const app = foundry.applications.instances.get('fa-nexus-app');
      const root = app?.element;
      if (!root) return;
      const cards = root.querySelectorAll(`.fa-nexus-grid .fa-nexus-card[data-filename="${CSS.escape(filename)}"], .fa-nexus-card[data-filename="${CSS.escape(filename)}"]`);
      cards.forEach(card => {
        try {
          // Update attributes so subsequent drags use local path
          card.setAttribute('data-url', localPath);
          card.setAttribute('data-cached', 'true');
          card.classList.remove('locked-token');
          // Update icon
          const icon = card.querySelector('.fa-nexus-status-icon');
          if (icon) {
            icon.classList.remove('cloud-plus', 'cloud');
            icon.classList.add('cloud', 'cached');
            icon.title = 'Downloaded';
            icon.innerHTML = '<i class="fas fa-cloud-check"></i>';
          }
        } catch (_) {}
      });
    } catch (_) {}
  }
}
