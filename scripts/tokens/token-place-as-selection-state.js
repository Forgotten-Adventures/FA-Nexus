import {
  normalizeMatchString,
  rankPlaceAsOptions
} from './token-place-as-matching.js';

export const DEFAULT_PLACE_AS_SELECTION = 'fa-nexus:create-new';
export const AUTO_NEW_ACTOR_TYPE_SELECTION = 'fa-nexus:auto-actor-type';
export const MAX_PLACE_AS_RESULTS = 60;
export const MAX_PLACE_AS_SUGGESTIONS = 10;
export const MIN_AUTO_PLACE_AS_SCORE = 35;

function result({ resetTokenNamingOverrides = false } = {}) {
  return { resetTokenNamingOverrides: !!resetTokenNamingOverrides };
}

function normalizeOptionList(options) {
  return Array.isArray(options) ? options.filter((option) => option && typeof option === 'object') : [];
}

function normalizeIterable(value) {
  if (!value || typeof value[Symbol.iterator] !== 'function') return [];
  return value;
}

export class TokenPlaceAsSelectionState {
  constructor() {
    this.selectionId = DEFAULT_PLACE_AS_SELECTION;
    this.linked = false;
    this.search = '';
    this.options = [];
    this.worldOptions = [];
    this.compendiumOptions = [];
    this.optionMap = new Map();
    this.loading = false;
    this.loadError = null;
    this.open = false;
    this.matchRaw = '';
    this.matchNormalized = '';
    this.matchTokens = [];
    this.suggestions = [];
    this.userModified = false;
    this.selectionAuto = false;
    this.selectedOption = null;
    this.excludedPacks = new Set();
  }

  get hasOptions() {
    return this.options.length > 0;
  }

  setLoading(value) {
    this.loading = !!value;
  }

  setLoadError(error) {
    this.loadError = error || null;
  }

  setWorldOptions(options) {
    this.worldOptions = normalizeOptionList(options);
    return this._mergeOptions();
  }

  setCompendiumOptions(options) {
    this.compendiumOptions = normalizeOptionList(options);
    return this._mergeOptions();
  }

  _mergeOptions() {
    this.options = this.worldOptions.concat(this.compendiumOptions || []);
    this.rebuildOptionMap();
    return this.syncSelection();
  }

  rebuildOptionMap() {
    this.optionMap.clear();
    for (const option of this.options) {
      if (!option || !option.id) continue;
      this.optionMap.set(option.id, option);
    }
    if (this.selectedOption) {
      const replacement = this.optionMap.get(this.selectedOption.id);
      if (replacement) this.selectedOption = replacement;
    }
  }

  syncSelection() {
    if (this.selectionId !== DEFAULT_PLACE_AS_SELECTION && !this.optionMap.has(this.selectionId)) {
      this.selectionId = DEFAULT_PLACE_AS_SELECTION;
      this.linked = false;
      return result({ resetTokenNamingOverrides: true });
    }
    return result();
  }

  setExcludedPacks(packIds) {
    this.excludedPacks = new Set(Array.isArray(packIds) ? packIds : []);
  }

  getExcludedPackIds() {
    return Array.from(this.excludedPacks);
  }

  isPackExcluded(packId) {
    return this.excludedPacks.has(packId);
  }

  setPackExcluded(packId, excluded) {
    if (excluded) this.excludedPacks.add(packId);
    else this.excludedPacks.delete(packId);
  }

  setMultiplePacksExcluded(packIds, excluded) {
    for (const packId of normalizeIterable(packIds)) {
      this.setPackExcluded(packId, excluded);
    }
  }

  getExcludedPackCount() {
    return this.excludedPacks.size;
  }

  rankOptions({
    tokens = [],
    normalized = '',
    includeCompendium = true,
    limit = MAX_PLACE_AS_SUGGESTIONS,
    allowZero = false
  } = {}) {
    return rankPlaceAsOptions({
      worldOptions: this.worldOptions,
      compendiumOptions: this.compendiumOptions,
      excludedPacks: this.excludedPacks,
      tokens,
      normalized,
      includeCompendium,
      limit,
      allowZero
    });
  }

  refreshSuggestions({ autoSelect = false } = {}) {
    const tokens = Array.isArray(this.matchTokens) ? this.matchTokens : [];
    const normalized = this.matchNormalized || '';
    const allowZero = !tokens.length;
    this.suggestions = this.rankOptions({
      tokens,
      normalized,
      includeCompendium: true,
      limit: MAX_PLACE_AS_SUGGESTIONS,
      allowZero
    });
    if (autoSelect) return this.autoSelectFromSuggestions();
    return result();
  }

  autoSelectFromSuggestions() {
    if (this.userModified) return result();
    const suggestions = this.suggestions || [];
    if (!suggestions.length) {
      let selectionResult = result();
      if (this.selectionAuto && this.selectionId !== DEFAULT_PLACE_AS_SELECTION) {
        selectionResult = this.selectOption(DEFAULT_PLACE_AS_SELECTION, { user: false, auto: false });
      }
      this.selectionAuto = false;
      return selectionResult;
    }
    const top = suggestions[0];
    if (!top || top.score < MIN_AUTO_PLACE_AS_SCORE) {
      let selectionResult = result();
      if (this.selectionAuto && this.selectionId !== DEFAULT_PLACE_AS_SELECTION) {
        selectionResult = this.selectOption(DEFAULT_PLACE_AS_SELECTION, { user: false, auto: false });
      }
      this.selectionAuto = false;
      return selectionResult;
    }
    if (this.selectionId !== DEFAULT_PLACE_AS_SELECTION && !this.selectionAuto) return result();
    if (this.selectionId === top.option.id) {
      this.selectionAuto = true;
      return result();
    }
    return this.selectOption(top.option.id, { user: false, auto: true, option: top.option });
  }

  applyMatchContext(derived = {}, { resetContext = false, autoSelect = true } = {}) {
    this.matchRaw = derived.raw || '';
    this.matchNormalized = derived.normalized || '';
    this.matchTokens = Array.isArray(derived.tokens) ? derived.tokens : [];
    let resetSelection = false;
    if (resetContext) {
      this.userModified = false;
      this.selectionAuto = false;
      this.selectionId = DEFAULT_PLACE_AS_SELECTION;
      this.linked = false;
      this.open = false;
      this.search = '';
      this.selectedOption = null;
      resetSelection = true;
    }
    const refreshResult = this.refreshSuggestions({ autoSelect });
    return result({
      resetTokenNamingOverrides: resetSelection || !!refreshResult?.resetTokenNamingOverrides
    });
  }

  setOpen(value) {
    const next = !!value;
    const wasOpen = !!this.open;
    if (wasOpen === next) return { ...result(), changed: false };
    this.open = next;
    if (!next && this.search) this.search = '';
    if (next) this.refreshSuggestions({ autoSelect: false });
    return { ...result(), changed: true };
  }

  setSearch(value) {
    const next = typeof value === 'string' ? value.slice(0, 120) : '';
    if (this.search === next) return { ...result(), changed: false };
    this.userModified = true;
    this.selectionAuto = false;
    this.search = next;
    return { ...result(), changed: true };
  }

  selectOption(optionId, { user = true, auto = false, option = null } = {}) {
    const previousSelectionId = this.selectionId;
    const id = typeof optionId === 'string' && optionId.length ? optionId : DEFAULT_PLACE_AS_SELECTION;
    if (user) {
      this.userModified = true;
      this.selectionAuto = false;
    } else if (auto) {
      this.userModified = false;
      this.selectionAuto = true;
    }
    if (id === DEFAULT_PLACE_AS_SELECTION) {
      this.selectionId = DEFAULT_PLACE_AS_SELECTION;
      this.linked = false;
      this.open = false;
      this.search = '';
      this.selectedOption = null;
      if (!auto) this.selectionAuto = false;
      return result({
        resetTokenNamingOverrides: previousSelectionId !== this.selectionId
      });
    }
    let resolvedOption = option || this.optionMap.get(id);
    if (!resolvedOption && Array.isArray(this.suggestions)) {
      const entry = this.suggestions.find((suggestion) => suggestion?.option?.id === id);
      if (entry?.option) resolvedOption = entry.option;
    }
    if (!resolvedOption) return { ...this.syncSelection(), found: false };
    if (this.selectionId === id) {
      this.open = false;
      return { ...result(), found: true };
    }
    this.selectionId = id;
    this.open = false;
    this.search = '';
    this.selectedOption = resolvedOption;
    return { ...result({ resetTokenNamingOverrides: previousSelectionId !== this.selectionId }), found: true };
  }

  setLinked(value, { user = true } = {}) {
    const canLink = this.selectionId !== DEFAULT_PLACE_AS_SELECTION;
    const next = !!value && canLink;
    if (this.linked === next) return { ...result(), changed: false };
    if (user) {
      this.userModified = true;
      this.selectionAuto = false;
    }
    this.linked = next;
    return { ...result(), changed: true };
  }

  getActiveSelection() {
    const id = this.selectionId;
    if (!id || id === DEFAULT_PLACE_AS_SELECTION) return { mode: 'new' };
    const option = this.optionMap.get(id) || this.selectedOption;
    if (!option) return { mode: 'new' };
    return {
      mode: 'actor',
      option,
      linked: !!this.linked
    };
  }

  handleMissingOption(optionId) {
    if (!optionId) return result();
    this.optionMap.delete(optionId);
    this.worldOptions = this.worldOptions.filter((option) => option.id !== optionId);
    this.options = this.options.filter((option) => option.id !== optionId);
    if (this.selectionId === optionId) {
      this.selectionId = DEFAULT_PLACE_AS_SELECTION;
      this.linked = false;
    }
    return result();
  }

  formatOption(option) {
    return {
      isHeader: false,
      id: option.id,
      label: option.label,
      subtitle: this.formatSubtitle(option),
      type: option.type,
      selected: this.selectionId === option.id
    };
  }

  formatSubtitle(option) {
    if (!option) return '';
    if (option.type === 'world') return option.source ? option.source : 'World Actor';
    if (option.type === 'compendium') return option.source ? `Compendium • ${option.source}` : 'Compendium Actor';
    return 'Default';
  }

  composeDisplayList() {
    const list = [];
    const defaultSelected = this.selectionId === DEFAULT_PLACE_AS_SELECTION;
    list.push({
      isHeader: false,
      id: DEFAULT_PLACE_AS_SELECTION,
      label: 'Create new basic actor',
      subtitle: 'Creates a new actor for each placement.',
      type: 'default',
      selected: defaultSelected
    });
    const addedIds = new Set([DEFAULT_PLACE_AS_SELECTION]);
    const queryNormalized = normalizeMatchString(this.search);
    const queryTokens = queryNormalized ? queryNormalized.split(' ').filter(Boolean) : [];

    if (queryTokens.length) {
      let ranked = this.rankOptions({
        tokens: queryTokens,
        normalized: queryNormalized,
        includeCompendium: true,
        limit: MAX_PLACE_AS_RESULTS,
        allowZero: false
      });
      if (!ranked.length) {
        ranked = this.rankOptions({
          tokens: queryTokens,
          normalized: queryNormalized,
          includeCompendium: true,
          limit: MAX_PLACE_AS_RESULTS,
          allowZero: true
        });
      }
      for (const entry of ranked) {
        if (!entry?.option) continue;
        if (addedIds.has(entry.option.id)) continue;
        list.push(this.formatOption(entry.option));
        addedIds.add(entry.option.id);
      }
      return list;
    }

    const suggestions = (this.suggestions || []).map((entry) => entry.option).filter(Boolean);
    if (suggestions.length) {
      list.push({ isHeader: true, label: 'Suggested Matches' });
      for (const option of suggestions) {
        if (addedIds.has(option.id)) continue;
        list.push(this.formatOption(option));
        addedIds.add(option.id);
      }
    }

    const existingNonDefault = list.filter((entry) => !entry.isHeader && entry.id !== DEFAULT_PLACE_AS_SELECTION).length;
    const remainingSlots = Math.max(0, MAX_PLACE_AS_RESULTS - existingNonDefault);
    if (remainingSlots > 0 && this.worldOptions.length) {
      const worldOptions = this.worldOptions
        .filter((option) => !addedIds.has(option.id))
        .slice(0, remainingSlots);
      if (worldOptions.length) {
        list.push({ isHeader: true, label: 'All World Actors' });
        for (const option of worldOptions) {
          list.push(this.formatOption(option));
          addedIds.add(option.id);
        }
      }
    }

    return list;
  }

  buildUiState({
    hpState = null,
    namingState = null,
    actorTypeState = null
  } = {}) {
    const options = this.composeDisplayList();
    const selection = this.getActiveSelection();
    const isFiltered = (this.search || '').trim().length > 0;
    const selectedLabel = (() => {
      if (selection.mode === 'actor' && selection.option) return selection.option.label || 'Unnamed Actor';
      return 'Create new basic actor';
    })();
    const actorSubtitle = (() => {
      if (selection.mode === 'actor' && selection.option) return this.formatSubtitle(selection.option);
      return 'Creates a new actor for each placement.';
    })();
    const selectedSubtitle = (() => {
      const parts = [];
      if (actorSubtitle) parts.push(actorSubtitle);
      if (actorTypeState?.summary) parts.push(actorTypeState.summary);
      if (hpState?.summary) parts.push(hpState.summary);
      return parts.join(' • ');
    })();
    const hasSelectableOptions = options.some((entry) => !entry.isHeader && entry.id !== DEFAULT_PLACE_AS_SELECTION);
    const emptyMessage = (() => {
      if (!this.open) return '';
      if (this.loading) return 'Loading actors…';
      if (isFiltered) return hasSelectableOptions ? '' : 'No actors match your search.';
      return hasSelectableOptions ? '' : 'No world actors available. Create or import actors to reuse them.';
    })();
    const linkedDisabled = this.selectionId === DEFAULT_PLACE_AS_SELECTION;
    const excludedPackCount = this.getExcludedPackCount();
    return {
      available: true,
      open: !!this.open,
      searchValue: this.search,
      options,
      hasOptions: options.some((entry) => !entry.isHeader),
      isLoading: !!this.loading,
      loadError: this.loadError || '',
      linked: !linkedDisabled && !!this.linked,
      linkedDisabled,
      linkedLabel: 'Link placed tokens to actor',
      linkedTooltip: linkedDisabled
        ? 'Select an actor to enable linked placement.'
        : 'Linked tokens reuse the actor sheet and update the prototype.',
      emptyMessage,
      isFiltered,
      selectedId: this.selectionId,
      selectedLabel,
      selectedSubtitle,
      hasSelectableOptions,
      actorType: actorTypeState,
      hp: hpState,
      naming: namingState,
      filter: {
        excludedCount: excludedPackCount,
        hasExcluded: excludedPackCount > 0,
        tooltip: excludedPackCount > 0
          ? `${excludedPackCount} compendium${excludedPackCount === 1 ? '' : 's'} excluded`
          : 'Filter compendiums'
      }
    };
  }
}
