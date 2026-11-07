export class ToolOptionsPlaceAsControlsWorkflow {
  constructor(host) {
    this._host = host;
    this._root = null;
    this._searchInput = null;
    this._list = null;
    this._linkedToggle = null;
    this._actorTypeSelect = null;
    this._actorTypeHint = null;
    this._appendNumberToggle = null;
    this._prependAdjectiveToggle = null;
    this._toggleButton = null;
    this._filterButton = null;
    this._hpModeSelect = null;
    this._hpPercentInput = null;
    this._hpStaticInput = null;
    this._hpModeHint = null;
    this._hpPercentHint = null;
    this._hpStaticHint = null;
    this._hpStaticError = null;
    this._hpPercentRow = null;
    this._hpStaticRow = null;
    this._boundSearch = (event) => this.handleSearch(event);
    this._boundOptionClick = (event) => this.handleOptionClick(event);
    this._boundLinkedChange = (event) => this.handleLinked(event);
    this._boundActorTypeChange = (event) => this.handleActorType(event);
    this._boundAppendNumberChange = (event) => this.handleAppendNumber(event);
    this._boundPrependAdjectiveChange = (event) => this.handlePrependAdjective(event);
    this._boundToggle = (event) => this.handleToggle(event);
    this._boundFilter = (event) => this.handleFilter(event);
    this._boundHpMode = (event) => this.handleHpMode(event);
    this._boundHpPercent = (event) => this.handleHpPercent(event);
    this._boundHpStatic = (event) => this.handleHpStatic(event);
  }

  get _document() {
    return this._root?.ownerDocument || this._host?.element?.ownerDocument || globalThis.document || null;
  }

  bind() {
    const root = this._host?.element || null;
    if (!root) {
      this.unbind();
      return;
    }
    if (this._root === root) {
      this.sync();
      return;
    }
    this.unbind();
    this._root = root;

    this._toggleButton = root.querySelector('[data-place-as-toggle]');
    if (this._toggleButton) this._toggleButton.addEventListener('click', this._boundToggle);

    this._filterButton = root.querySelector('[data-place-as-filter]');
    if (this._filterButton) this._filterButton.addEventListener('click', this._boundFilter);

    this._searchInput = root.querySelector('#fa-nexus-place-as-search');
    if (this._searchInput) this._searchInput.addEventListener('input', this._boundSearch);

    this._list = root.querySelector('[data-fa-nexus-place-as-list]');
    if (this._list) this._list.addEventListener('click', this._boundOptionClick);

    this._linkedToggle = root.querySelector('[data-place-as-linked]');
    if (this._linkedToggle) this._linkedToggle.addEventListener('change', this._boundLinkedChange);

    this._actorTypeSelect = root.querySelector('[data-place-as-actor-type]');
    if (this._actorTypeSelect) this._actorTypeSelect.addEventListener('change', this._boundActorTypeChange);

    this._appendNumberToggle = root.querySelector('[data-place-as-append-number]');
    if (this._appendNumberToggle) this._appendNumberToggle.addEventListener('change', this._boundAppendNumberChange);

    this._prependAdjectiveToggle = root.querySelector('[data-place-as-prepend-adjective]');
    if (this._prependAdjectiveToggle) this._prependAdjectiveToggle.addEventListener('change', this._boundPrependAdjectiveChange);

    this._hpModeSelect = root.querySelector('[data-place-as-hp-mode]');
    if (this._hpModeSelect) this._hpModeSelect.addEventListener('change', this._boundHpMode);

    this._hpPercentInput = root.querySelector('[data-place-as-hp-percent]');
    if (this._hpPercentInput) this._hpPercentInput.addEventListener('input', this._boundHpPercent);

    this._hpStaticInput = root.querySelector('[data-place-as-hp-static]');
    if (this._hpStaticInput) this._hpStaticInput.addEventListener('input', this._boundHpStatic);

    this._hpModeHint = root.querySelector('[data-place-as-hp-mode-hint]');
    this._actorTypeHint = root.querySelector('[data-place-as-actor-type-hint]');
    this._hpPercentHint = root.querySelector('[data-place-as-hp-percent-hint]');
    this._hpStaticHint = root.querySelector('[data-place-as-hp-static-hint]');
    this._hpStaticError = root.querySelector('[data-place-as-hp-static-error]');
    this._hpPercentRow = root.querySelector('[data-place-as-hp-percent-row]');
    this._hpStaticRow = root.querySelector('[data-place-as-hp-static-row]');
    this.sync();
  }

  unbind() {
    if (this._toggleButton) {
      try { this._toggleButton.removeEventListener('click', this._boundToggle); } catch (_) {}
    }
    if (this._filterButton) {
      try { this._filterButton.removeEventListener('click', this._boundFilter); } catch (_) {}
    }
    if (this._searchInput) {
      try { this._searchInput.removeEventListener('input', this._boundSearch); } catch (_) {}
    }
    if (this._list) {
      try { this._list.removeEventListener('click', this._boundOptionClick); } catch (_) {}
    }
    if (this._linkedToggle) {
      try { this._linkedToggle.removeEventListener('change', this._boundLinkedChange); } catch (_) {}
    }
    if (this._actorTypeSelect) {
      try { this._actorTypeSelect.removeEventListener('change', this._boundActorTypeChange); } catch (_) {}
    }
    if (this._appendNumberToggle) {
      try { this._appendNumberToggle.removeEventListener('change', this._boundAppendNumberChange); } catch (_) {}
    }
    if (this._prependAdjectiveToggle) {
      try { this._prependAdjectiveToggle.removeEventListener('change', this._boundPrependAdjectiveChange); } catch (_) {}
    }
    if (this._hpModeSelect) {
      try { this._hpModeSelect.removeEventListener('change', this._boundHpMode); } catch (_) {}
    }
    if (this._hpPercentInput) {
      try { this._hpPercentInput.removeEventListener('input', this._boundHpPercent); } catch (_) {}
    }
    if (this._hpStaticInput) {
      try { this._hpStaticInput.removeEventListener('input', this._boundHpStatic); } catch (_) {}
    }
    this._root = null;
    this._searchInput = null;
    this._list = null;
    this._linkedToggle = null;
    this._actorTypeSelect = null;
    this._actorTypeHint = null;
    this._appendNumberToggle = null;
    this._prependAdjectiveToggle = null;
    this._toggleButton = null;
    this._filterButton = null;
    this._hpModeSelect = null;
    this._hpPercentInput = null;
    this._hpStaticInput = null;
    this._hpModeHint = null;
    this._hpPercentHint = null;
    this._hpStaticHint = null;
    this._hpStaticError = null;
    this._hpPercentRow = null;
    this._hpStaticRow = null;
  }

  sync() {
    const state = this._host?._toolOptionState?.placeAs || {};
    this._syncToggle(state);
    this._syncSearch(state);
    this._syncLinked(state);
    this._syncActorType(state.actorType || {});
    this._syncNaming(state.naming || {});
    this._syncSelectedList(state);
    this._syncHp(state.hp || {});
  }

  _syncToggle(state) {
    const toggle = this._toggleButton;
    if (toggle) {
      toggle.setAttribute('aria-expanded', state.open ? 'true' : 'false');
      const labelEl = toggle.querySelector('.fa-nexus-place-as__selection-label');
      if (labelEl) {
        const nextLabel = state.selectedLabel || 'Create new basic actor';
        if (labelEl.textContent !== nextLabel) labelEl.textContent = nextLabel;
      }
      const subtitle = state.selectedSubtitle || '';
      let subtitleEl = toggle.querySelector('.fa-nexus-place-as__selection-subtitle');
      if (subtitle) {
        if (!subtitleEl) {
          const doc = this._document;
          subtitleEl = doc?.createElement?.('span') || null;
          if (subtitleEl) {
            subtitleEl.className = 'fa-nexus-place-as__selection-subtitle';
            subtitleEl.textContent = subtitle;
            const wrapper = toggle.querySelector('.fa-nexus-place-as__selection-text');
            if (wrapper) wrapper.appendChild(subtitleEl);
          }
        } else if (subtitleEl.textContent !== subtitle) {
          subtitleEl.textContent = subtitle;
        }
        if (subtitleEl) subtitleEl.hidden = false;
      } else if (subtitleEl) {
        subtitleEl.textContent = '';
        subtitleEl.hidden = true;
      }
    }

    const container = this._root?.querySelector?.('.fa-nexus-place-as') || null;
    if (container) container.classList.toggle('is-open', !!state.open);
  }

  _syncSearch(state) {
    if (!this._searchInput) return;
    this._searchInput.value = state.searchValue || '';
    if (!state.open) return;

    const doc = this._document;
    const el = this._searchInput;
    if (doc?.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
    }
    const len = el.value.length;
    try { el.setSelectionRange(len, len); } catch (_) {}
  }

  _syncLinked(state) {
    if (!this._linkedToggle) return;
    this._linkedToggle.checked = !!state.linked;
    this._linkedToggle.disabled = !!state.linkedDisabled;
    const label = this._linkedToggle.closest('label');
    if (label && state.linkedTooltip) label.title = state.linkedTooltip;
  }

  _syncActorType(actorTypeState) {
    if (this._actorTypeSelect) {
      const actorTypeOptions = Array.isArray(actorTypeState.options)
        ? actorTypeState.options.filter((option) => !!option?.id)
        : [];
      const currentValues = Array.from(this._actorTypeSelect.options, (option) => option.value);
      const nextValues = actorTypeOptions.map((option) => String(option.id));
      const needsRebuild = currentValues.length !== nextValues.length
        || currentValues.some((value, index) => value !== nextValues[index]);
      if (needsRebuild) {
        const doc = this._document;
        const fragment = doc?.createDocumentFragment?.();
        if (fragment) {
          for (const entry of actorTypeOptions) {
            const optionElement = doc.createElement('option');
            optionElement.value = String(entry.id);
            optionElement.textContent = entry.label || String(entry.id);
            optionElement.selected = !!entry.selected;
            optionElement.disabled = !!entry.disabled;
            fragment.appendChild(optionElement);
          }
          this._actorTypeSelect.replaceChildren(fragment);
        }
      } else {
        const optionMap = new Map();
        for (const option of actorTypeOptions) {
          optionMap.set(String(option.id), option);
        }
        for (const optionElement of this._actorTypeSelect.options) {
          const entry = optionMap.get(optionElement.value);
          if (!entry) continue;
          optionElement.disabled = !!entry.disabled;
          optionElement.selected = !!entry.selected;
          if (entry.label && optionElement.textContent !== entry.label) {
            optionElement.textContent = entry.label;
          }
        }
      }
      if (actorTypeState.value) this._actorTypeSelect.value = actorTypeState.value;
      this._actorTypeSelect.disabled = !!actorTypeState.disabled;
    }
    if (this._actorTypeHint) {
      const hint = actorTypeState.hint || '';
      this._actorTypeHint.textContent = hint;
      this._actorTypeHint.hidden = !hint;
    }
  }

  _syncNaming(namingState) {
    if (this._appendNumberToggle) {
      this._appendNumberToggle.checked = !!namingState.appendNumber;
      this._appendNumberToggle.disabled = !namingState.available;
      const label = this._appendNumberToggle.closest('label');
      if (label && namingState.appendNumberTooltip) label.title = namingState.appendNumberTooltip;
    }
    if (this._prependAdjectiveToggle) {
      this._prependAdjectiveToggle.checked = !!namingState.prependAdjective;
      this._prependAdjectiveToggle.disabled = !namingState.available;
      const label = this._prependAdjectiveToggle.closest('label');
      if (label && namingState.prependAdjectiveTooltip) label.title = namingState.prependAdjectiveTooltip;
    }
  }

  _syncSelectedList(state) {
    if (!this._list) return;
    const selectedId = state.selectedId || '';
    const buttons = this._list.querySelectorAll('[data-place-as-option]');
    for (const button of buttons) {
      const id = button.getAttribute('data-place-as-option');
      button.classList.toggle('is-selected', !!selectedId && id === selectedId);
    }
  }

  _syncHp(hpState) {
    if (this._hpModeSelect) {
      if (Array.isArray(hpState.modeOptions)) {
        const optionMap = new Map();
        for (const option of hpState.modeOptions) {
          if (!option) continue;
          optionMap.set(String(option.id), option);
        }
        for (const optionElement of this._hpModeSelect.options) {
          const entry = optionMap.get(optionElement.value);
          if (!entry) continue;
          optionElement.disabled = !!entry.disabled;
          if (entry.label && optionElement.textContent !== entry.label) {
            optionElement.textContent = entry.label;
          }
          optionElement.selected = !!entry.selected;
        }
      }
      if (hpState.mode) this._hpModeSelect.value = hpState.mode;
    }
    if (this._hpModeHint) {
      const hint = hpState.modeHint || '';
      this._hpModeHint.textContent = hint;
      this._hpModeHint.hidden = !hint;
    }
    if (this._hpPercentRow) this._hpPercentRow.hidden = !hpState.showPercent;
    if (this._hpPercentInput) {
      const doc = this._document;
      const percentFocused = doc?.activeElement === this._hpPercentInput;
      const percentValue = hpState.percentValue !== undefined && hpState.percentValue !== null
        ? String(hpState.percentValue)
        : '';
      if (!percentFocused && this._hpPercentInput.value !== percentValue) {
        this._hpPercentInput.value = percentValue;
      }
      this._hpPercentInput.disabled = !hpState.showPercent;
    }
    if (this._hpPercentHint) {
      const hint = hpState.percentHint || '';
      this._hpPercentHint.textContent = hint;
      this._hpPercentHint.hidden = !hpState.showPercent || !hint;
    }
    if (this._hpStaticRow) this._hpStaticRow.hidden = !hpState.showStatic;
    if (this._hpStaticInput) {
      const doc = this._document;
      const staticFocused = doc?.activeElement === this._hpStaticInput;
      const staticValue = typeof hpState.staticValue === 'string' ? hpState.staticValue : '';
      if (!staticFocused && this._hpStaticInput.value !== staticValue) {
        this._hpStaticInput.value = staticValue;
      }
      this._hpStaticInput.classList.toggle('has-error', !!hpState.staticError);
      if (hpState.staticError) {
        this._hpStaticInput.setAttribute('aria-invalid', 'true');
      } else {
        this._hpStaticInput.removeAttribute('aria-invalid');
      }
      this._hpStaticInput.disabled = !hpState.showStatic;
    }
    if (this._hpStaticHint) {
      const hint = hpState.staticHint || '';
      this._hpStaticHint.textContent = hint;
      this._hpStaticHint.hidden = !hpState.showStatic || !hint;
    }
    if (this._hpStaticError) {
      const error = hpState.staticError || '';
      this._hpStaticError.textContent = error;
      this._hpStaticError.hidden = !error;
    }
  }

  _invokeAndSync(handlerName, ...args) {
    const result = this._host?._controller?.invokeToolHandler?.(handlerName, ...args);
    if (result?.then) result.finally(() => this.sync());
    else this.sync();
    return result;
  }

  handleSearch(event) {
    const value = event?.currentTarget?.value ?? '';
    return this._invokeAndSync('setPlaceAsSearch', value);
  }

  handleOptionClick(event) {
    const button = event?.target?.closest?.('[data-place-as-option]');
    if (!button) return null;
    event.preventDefault?.();
    event.stopPropagation?.();
    const optionId = button.getAttribute('data-place-as-option') || '';
    return this._invokeAndSync('selectPlaceAsOption', optionId);
  }

  handleLinked(event) {
    return this._invokeAndSync('setPlaceAsLinked', !!event?.currentTarget?.checked);
  }

  handleActorType(event) {
    const value = event?.currentTarget?.value ?? '';
    return this._invokeAndSync('setPlaceAsActorType', value);
  }

  handleAppendNumber(event) {
    return this._invokeAndSync('setPlaceAsAppendNumber', !!event?.currentTarget?.checked);
  }

  handlePrependAdjective(event) {
    return this._invokeAndSync('setPlaceAsPrependAdjective', !!event?.currentTarget?.checked);
  }

  handleToggle(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    return this._invokeAndSync('togglePlaceAsOpen');
  }

  handleFilter(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    return this._host?._controller?.invokeToolHandler?.('openCompendiumFilterDialog');
  }

  handleHpMode(event) {
    const value = event?.currentTarget?.value ?? '';
    return this._invokeAndSync('setPlaceAsHpMode', value);
  }

  handleHpPercent(event) {
    const value = event?.currentTarget?.value ?? '';
    return this._invokeAndSync('setPlaceAsHpPercent', value);
  }

  handleHpStatic(event) {
    const value = event?.currentTarget?.value ?? '';
    return this._invokeAndSync('setPlaceAsHpStatic', value);
  }
}
