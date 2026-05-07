/**
 * Shared FA Nexus JSDoc typedefs.
 * This module exports no runtime symbols; it only centralizes structural types
 * used across the JavaScript codebase.
 */

/**
 * @typedef {object} FaNexusPoint
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {object} FaNexusTokenSize
 * @property {number} gridWidth
 * @property {number} gridHeight
 * @property {number} scale
 */

/**
 * @typedef {object} FaNexusTokenDragData
 * @property {'fa-nexus'} source
 * @property {'fa-nexus-token'} type
 * @property {string} filename
 * @property {string} url
 * @property {FaNexusTokenSize} tokenSize
 * @property {string} originSource
 * @property {string} originTier
 * @property {string} displayName
 * @property {string} [path]
 * @property {string} [file_path]
 * @property {number} [rotation]
 * @property {boolean} [mirrorX]
 * @property {boolean} [mirrorY]
 * @property {boolean} [_updateActorImage]
 * @property {boolean} [_useWildcard]
 * @property {boolean} [_preserveSize]
 */

/**
 * @typedef {object} FaNexusActorDropCoordinates
 * @property {FaNexusPoint} screen
 * @property {FaNexusPoint} world
 */

/**
 * @typedef {object} FaNexusInventoryRecord
 * @property {string} type
 * @property {'local'|'cloud'} source
 * @property {string} file_path
 * @property {string} path
 * @property {string} filename
 * @property {string} [display_name]
 * @property {string} [variant]
 * @property {string} [size]
 * @property {string} [creature_type]
 * @property {number} [grid_width]
 * @property {number} [grid_height]
 * @property {string} [scale]
 * @property {number} [width]
 * @property {number} [height]
 * @property {string|null} [tier]
 * @property {string|null} [color_variant]
 * @property {boolean} [is_main_color_variant]
 * @property {boolean} [has_color_variant]
 * @property {string} [base_name_no_variant]
 * @property {number} [file_size]
 * @property {string} [content_type]
 * @property {string} [last_modified]
 * @property {string[]} [tags]
 * @property {string} [thumbnail_url]
 * @property {string} [id]
 */

/**
 * @typedef {FaNexusInventoryRecord} FaNexusTokenInventoryRecord
 */

/**
 * @typedef {FaNexusInventoryRecord} FaNexusAssetInventoryRecord
 */

/**
 * @typedef {object} FaNexusInventoryDeltaOperation
 * @property {'add'|'up'|'del'} op
 * @property {FaNexusInventoryRecord} [item]
 * @property {string} [file_path]
 */

/**
 * @typedef {object} FaNexusInventoryListResult
 * @property {FaNexusInventoryRecord[]} items
 * @property {number} total
 */

/**
 * @typedef {object} FaNexusManifestMeta
 * @property {'meta'} [id]
 * @property {string} [latest]
 * @property {number} [count]
 * @property {string} [builtAt]
 * @property {string} [chunksLatest]
 * @property {string} [chunksBuiltAt]
 */

/**
 * @typedef {object} FaNexusStreamAllResult
 * @property {FaNexusInventoryRecord[]} items
 * @property {number} total
 * @property {string|null} latest
 * @property {'chunks'|'cursor'} mode
 */

/**
 * @typedef {object} FaNexusFolderCountEntry
 * @property {string} folder
 * @property {number} count
 */

/**
 * @typedef {object} FaNexusFolderTreeNode
 * @property {string} name
 * @property {string} path
 * @property {string} pathLower
 * @property {number} count
 * @property {FaNexusFolderTreeNode[]} children
 * @property {number} level
 */

/**
 * @typedef {object} FaNexusFolderTreeIndex
 * @property {FaNexusFolderTreeNode[]} nodes
 * @property {Set<string>} pathSet
 * @property {string[]} pathKeys
 * @property {Map<string, string>} pathMap
 * @property {number} totalCount
 * @property {number|null} version
 */

/**
 * @typedef {object} FaNexusFolderTreeIndexInput
 * @property {FaNexusPathCountsInput} [pathCounts]
 * @property {FaNexusFolderTreeIndex|{nodes:FaNexusFolderTreeNode[],pathSet?:Set<string>|string[],pathLookup?:Set<string>|string[],pathMap?:Map<string,string>|Record<string,string>|Array<[string,string]>,pathKeys?:string[],totalCount?:number,version?:number}} [tree]
 * @property {number} [version]
 */

/**
 * @typedef {Array<[string, number]> | Array<FaNexusFolderCountEntry> | Map<string, number> | Record<string, number>} FaNexusPathCountsInput
 */

/**
 * @typedef {object} FaNexusBookmark
 * @property {string} id
 * @property {string} title
 * @property {string} searchQuery
 * @property {FaNexusFolderSelection|null} folderSelection
 * @property {string} tab
 * @property {number} created
 * @property {number} [updated]
 */

/**
 * @typedef {Record<string, FaNexusBookmark[]>} FaNexusBookmarkMap
 */

/**
 * @typedef {object} FaNexusFolderSelection
 * @property {'all'|'folder'|'folders'|'multi'|'multifolder'|'unassigned'} type
 * @property {string[]} [includePaths]
 * @property {string[]} [includePathLowers]
 * @property {string[]} [paths]
 * @property {string[]} [pathLowers]
 * @property {string[]} [excludePaths]
 * @property {string[]} [excludePathLowers]
 * @property {string} [path]
 * @property {string} [pathLower]
 */

/**
 * @typedef {FaNexusInventoryRecord | {file_path?:string,path?:string,filename?:string,url?:string,id?:string,source?:string,tier?:string}} FaNexusSelectionItem
 */

/**
 * @typedef {Record<string, boolean|string|number|null|undefined>} FaNexusSelectionContext
 */

/**
 * @template T
 * @typedef {object} GridSelectionHelperOptions
 * @property {() => HTMLElement|null} [getGridContainer]
 * @property {() => T[]} [getGridItems]
 * @property {(item:T) => string} [computeItemKey]
 * @property {(card:HTMLElement) => string} [keyFromCard]
 * @property {(card:HTMLElement, selected:boolean) => void} [setCardSelectionUI]
 * @property {(item:T, card:HTMLElement|null, context:FaNexusSelectionContext) => boolean} [isItemLocked]
 * @property {() => FaNexusSelectionContext} [getSelectionContext]
 * @property {string} [cardSelector]
 * @property {import('./nexus-logger.js').NexusLogger} [logger]
 * @property {string} [loggerTag]
 */

/**
 * @template T
 * @typedef {object} PlacementPrefetchQueueOptions
 * @property {number} [prefetchCount]
 * @property {(item:T) => string} [getItemKey]
 * @property {(item:T) => boolean} [needsPrefetch]
 * @property {(item:T) => Promise<void>|void} [prefetch]
 * @property {import('./nexus-logger.js').NexusLogger} [logger]
 * @property {string} [loggerTag]
 */

/**
 * @typedef {object} PlacementOverlayOptions
 * @property {FaNexusPoint|null} [pointer]
 * @property {number} [worldWidth]
 * @property {number} [worldHeight]
 * @property {number} [screenWidth]
 * @property {number} [screenHeight]
 * @property {string} [className]
 * @property {number} [zIndex]
 * @property {boolean} [trackZoom]
 * @property {(width:number, height:number) => void} [onSizeChange]
 */

/**
 * @typedef {object} PlacementSpinnerOptions
 * @property {string} [label]
 * @property {string} [iconClass]
 */

/**
 * @typedef {Record<string, boolean|string|number|null|undefined>} ProgressEventPayload
 */

/**
 * @callback ProgressEventCallback
 * @param {ProgressEventPayload} data
 * @returns {void}
 */

/**
 * @typedef {object} ProgressEmitterLike
 * @property {(event:string, callback:ProgressEventCallback) => void} on
 * @property {(event:string, callback:ProgressEventCallback) => void} off
 * @property {(event:string, data:ProgressEventPayload) => void} emit
 * @property {() => void} clear
 */

/**
 * @typedef {object} UrlCacheLike
 * @property {(key:string) => string|null} get
 * @property {(key:string, url:string) => void} set
 * @property {() => void} clear
 */

/**
 * @typedef {object} RetryWithBackoffOptions
 * @property {number} [maxRetries]
 * @property {number} [initialDelay]
 * @property {number} [maxDelay]
 * @property {(info:{attempt:number,maxRetries:number,delay:number,error:Error}) => void} [onRetry]
 * @property {(error:Error) => boolean} [shouldRetry]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} PatreonAuthServiceLike
 * @property {(app:object|null, notify?:boolean) => Promise<void>|void} [handlePatreonDisconnect]
 */

/**
 * @callback PatreonAuthServiceProvider
 * @param {object|null} app
 * @returns {PatreonAuthServiceLike|null}
 */

/**
 * @typedef {object} NexusContentServiceOptions
 * @property {string} [base]
 * @property {string} [settingsNamespace]
 * @property {ProgressEmitterLike} [progressEmitter]
 * @property {import('../content/cloud-db.js').CloudDB} [dbTokens]
 * @property {import('../content/cloud-db.js').CloudDB} [dbAssets]
 * @property {UrlCacheLike} [urlCache]
 * @property {number} [authDisconnectCooldownMs]
 * @property {object|null} [app]
 * @property {PatreonAuthServiceLike|PatreonAuthServiceProvider|null} [authService]
 */

/**
 * @typedef {object} FaNexusAuthContext
 * @property {object|null} [app]
 * @property {PatreonAuthServiceLike|PatreonAuthServiceProvider|null} [authService]
 */

/**
 * @typedef {object} SyncManifestProgressInfo
 * @property {string} phase
 * @property {number} count
 * @property {number} total
 */

/**
 * @typedef {object} NexusSyncOptions
 * @property {(info:SyncManifestProgressInfo) => void} [onManifestProgress]
 * @property {number} [progressBatch]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} LocalInventoryConfig
 * @property {string} [loggerTag]
 * @property {string[]} [folders]
 * @property {string} [settingsKey]
 * @property {(folder:string) => Promise<FaNexusInventoryRecord[]>|FaNexusInventoryRecord[]} loadCached
 * @property {(folder:string, records:FaNexusInventoryRecord[]) => Promise<void>|void} saveIndex
 * @property {(folder:string, onBatch:(records:FaNexusInventoryRecord[]) => Promise<void>|void, options?:{batchSize?:number,sleepMs?:number}) => Promise<void>|void} streamFolder
 * @property {() => boolean} [isCancelled]
 * @property {(cachedItems:FaNexusInventoryRecord[]) => void} [onCachedReady]
 * @property {(count:number, folder:string, batchCount:number) => void} [onStreamProgress]
 * @property {(folder:string, records:FaNexusInventoryRecord[]) => void} [onStreamFolderComplete]
 * @property {{batchSize?:number,sleepMs?:number}} [streamOptions]
 * @property {(record:FaNexusInventoryRecord) => string} [keySelector]
 */

/**
 * @typedef {object} MergeLocalAndCloudRecordsOptions
 * @property {FaNexusInventoryRecord[]} [local]
 * @property {FaNexusInventoryRecord[]} [cloud]
 * @property {(record:FaNexusInventoryRecord) => string} [keySelector]
 * @property {(localRecord:FaNexusInventoryRecord, cloudRecord:FaNexusInventoryRecord) => FaNexusInventoryRecord} [choosePreferred]
 * @property {(info:{localRecord:FaNexusInventoryRecord,cloudRecord:FaNexusInventoryRecord,key:string}) => FaNexusInventoryRecord|void} [onEnhanceLocal]
 * @property {(stats:{kind:string,collisions:number,preferLocal:number,preferCloud:number,enhanced:number,localCount:number,cloudCount:number,mergedCount:number}) => void} [onStats]
 * @property {string} [kind]
 */

/**
 * @template T
 * @typedef {object} LoadAndMergeCloudRecordsOptions
 * @property {boolean} [cloudEnabled]
 * @property {T[]} [localItems]
 * @property {AbortSignal|null} [signal]
 * @property {(context:{signal:AbortSignal|null}) => Promise<{items:T[],error?:string|null,partial?:boolean,errorObject?:Error|object|null}>} fetchCloud
 * @property {(context:{localItems:T[],cloudItems:T[],cloudError:string|null,partial:boolean,signal:AbortSignal|null}) => Promise<T[]>|T[]} mergeItems
 * @property {(items:T[], result?:{items:T[],error?:string|null,partial?:boolean,errorObject?:Error|object|null}) => void} [onCloudItems]
 * @property {(error:string, rawError:Error) => void} [onCloudError]
 * @property {(result:{items:T[],error:string|null,partial:boolean,errorObject?:Error|object|null}, context:{localItems:T[],cloudItems:T[]}) => void} [onResult]
 * @property {(total:number) => void} [onTotal]
 */

/**
 * @typedef {object} CloudSyncConfig
 * @property {string} [loggerTag]
 * @property {string[]} [folders]
 * @property {string} [settingsKey]
 */

/**
 * @typedef {object} FaNexusActorSystemMapping
 * @property {string} defaultType
 * @property {string[]} supportedTypes
 * @property {string[]} requiredFields
 * @property {string[]} optionalFields
 * @property {string} description
 */

/**
 * @typedef {object} FaNexusActorPrototypeTokenData
 * @property {string} name
 * @property {{src:string}} texture
 */

/**
 * @typedef {object} FaNexusActorData
 * @property {string} name
 * @property {string} type
 * @property {string} img
 * @property {object} system
 * @property {FaNexusActorPrototypeTokenData|FaNexusTokenPrototypeData} prototypeToken
 */

/**
 * @typedef {object} FaNexusTokenPrototypeData
 * @property {number} width
 * @property {number} height
 * @property {number} [depth]
 * @property {{src:string,scaleX:number,scaleY:number,fit:'contain'|'width'|'height'}} texture
 * @property {boolean} actorLink
 * @property {boolean} [randomImg]
 * @property {number} [rotation]
 * @property {Record<string, Record<string, boolean|string|number|null|undefined>>} [flags]
 * @property {boolean} [appendNumber]
 * @property {boolean} [prependAdjective]
 */

/**
 * @typedef {object} FaNexusActorFactoryOptions
 * @property {string} [actorTypeOverride]
 * @property {(actor:Actor) => Promise<FaNexusActorTokenOptions|void>|FaNexusActorTokenOptions|void} [beforeTokenCreate]
 */

/**
 * @typedef {object} FaNexusActorUpdateOptions
 * @property {boolean} [preserveSize]
 * @property {boolean} [useWildcard]
 * @property {boolean} [updateActorImage]
 * @property {boolean} [appendNumber]
 * @property {boolean} [prependAdjective]
 */

/**
 * @typedef {object} FaNexusHpOverride
 * @property {string} [path]
 * @property {string} [valuePath]
 * @property {string} [maxPath]
 * @property {number} value
 * @property {number} max
 */

/**
 * @typedef {object} FaNexusActorTokenOptions
 * @property {boolean} [actorLink]
 * @property {FaNexusHpOverride|null} [hpOverride]
 * @property {boolean} [appendNumber]
 * @property {boolean} [prependAdjective]
 */

export {};
