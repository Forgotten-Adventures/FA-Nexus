import { BookmarkDialog } from './bookmark-dialog.js';
import { NexusLogger as Logger } from '../nexus-logger.js';

/**
 * BookmarkToolbar
 * Handles bookmark rendering, overflow, and drag interactions for FA Nexus.
 */
export class BookmarkToolbar {
  constructor({ app, bookmarkManager, tabManager, searchController, folderController }) {
    this.app = app;
    this._bookmarkManager = bookmarkManager;
    this._tabManager = tabManager;
    this._searchController = searchController;
    this._folderController = folderController;

    this._events = null;
    this._bookmarkOverflowObserver = null;
    this._dragPreview = null;
    this._activeDragOperations = 0;
    this._dragBookmarkId = null;
    this._dragBookmarkIndex = null;
    this._dragFromOverflow = false;
    this._lastDropTarget = null;
    this._lastDropInsertBefore = false;
    this._lastDragClientX = null;
    this._lastDragClientY = null;
  }

  /**
   * Initialize toolbar bindings on render.
   * @param {EventManager} events
   */
  initialize(events) {
    this._events = events;
    this._bindSaveButton();
    this.refresh();
    this._setupBookmarkOverflowObserver();
  }

  /** Cleanup DOM observers and overflow handlers */
  cleanup() {
    if (this._bookmarkOverflowObserver) {
      try { this._bookmarkOverflowObserver.disconnect(); } catch (_) {}
      this._bookmarkOverflowObserver = null;
    }

    const overflowBtn = this.app.element?.querySelector('.fa-nexus-bookmark-overflow');
    if (overflowBtn && overflowBtn._overflowClickHandler) {
      overflowBtn.removeEventListener('click', overflowBtn._overflowClickHandler);
      overflowBtn._overflowClickHandler = null;
    }

    this._removeDragPreview();
    this._activeDragOperations = 0;
    this._dragBookmarkId = null;
    this._dragBookmarkIndex = null;
    this._dragFromOverflow = false;
    this._lastDropTarget = null;
    this._lastDropInsertBefore = false;
    this._lastDragClientX = null;
    this._lastDragClientY = null;
  }

  /** Get bookmarks for the active tab */
  getCurrentTabBookmarks() {
    return this._bookmarkManager.getBookmarksForTab(this._getActiveTabId());
  }

  /** Save current search/folder state as a bookmark */
  saveCurrentStateAsBookmark(title) {
    const tabId = this._getActiveTabId();
    const searchQuery = this._searchController.getSearchQuery(tabId);
    const folderSelection = this._tabManager.getActiveTab()?.getActiveFolderSelection?.() || null;
    return this._bookmarkManager.createBookmark(tabId, title, searchQuery, folderSelection);
  }

  /** Load bookmark state into active tab */
  loadBookmark(bookmarkId) {
    const tabId = this._getActiveTabId();
    const bookmark = this._bookmarkManager.getBookmark(tabId, bookmarkId);
    if (!bookmark) return false;

    // Apply folder selection first (if any), then search
    // This avoids duplicate filtering since folder selection change triggers search reapplication
    if (bookmark.folderSelection) {
      this._tabManager.getActiveTab()?.onFolderSelectionChange?.(bookmark.folderSelection);
    } else {
      this.app.clearFolderSelections(tabId);
    }

    // Apply search query (this will be combined with any folder filtering)
    if (bookmark.searchQuery !== undefined) {
      this._searchController.applySearchToTab(tabId, bookmark.searchQuery);
    }

    return true;
  }

  /** Update a bookmark */
  updateBookmark(bookmarkId, updates) {
    return this._bookmarkManager.updateBookmark(this._getActiveTabId(), bookmarkId, updates);
  }

  /** Delete a bookmark */
  deleteBookmark(bookmarkId) {
    return this._bookmarkManager.deleteBookmark(this._getActiveTabId(), bookmarkId);
  }

  /** Prompt user to save current state */
  async promptSaveCurrentState() {
    try {
      const tabId = this._getActiveTabId();
      const searchQuery = this._searchController.getSearchQuery(tabId);
      const folderSelection = this._tabManager.getActiveTab()?.getActiveFolderSelection?.() || null;

      let defaultTitle = '';
      if (searchQuery.trim()) defaultTitle = searchQuery.trim();
      else if (folderSelection?.includePaths?.length) {
        const firstFolder = folderSelection.includePaths[0];
        defaultTitle = firstFolder.split('/').pop() || 'Folder selection';
      } else defaultTitle = 'Bookmark';

      const dialog = new BookmarkDialog({
        mode: 'save',
        titleValue: defaultTitle,
        searchQuery,
        folderSelection
      });

      const result = await dialog.prompt();
      if (result && typeof result === 'string') {
        const bookmark = this.saveCurrentStateAsBookmark(result);
        this.refresh();
        Logger.info('Bookmark saved', { id: bookmark.id, title: bookmark.title });
      }
    } catch (error) {
      Logger.error('Bookmark save failed', error);
    }
  }

  /** Re-render toolbar contents */
  refresh() {
    try {
      const toolbar = this.app.element?.querySelector('.fa-nexus-bookmark-items');
      if (!toolbar) return;

      toolbar.innerHTML = '';
      const bookmarks = this.getCurrentTabBookmarks();

      bookmarks.forEach((bookmark, index) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'fa-nexus-bookmark-wrapper';
        wrapper.setAttribute('data-bookmark-id', bookmark.id);
        wrapper.setAttribute('data-bookmark-index', index);

        const item = document.createElement('div');
        item.className = 'fa-nexus-bookmark-item';
        item.title = bookmark.title;
        item.innerHTML = `<span>${bookmark.title}</span>`;

        wrapper.appendChild(item);

        wrapper.addEventListener('click', (e) => {
          if (this._activeDragOperations === 0) this.loadBookmark(bookmark.id);
        });

        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;

        wrapper.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          if (this._activeDragOperations > 0) return;
          e.preventDefault();
          e.stopPropagation();
          isDragging = false;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
        });

        wrapper.addEventListener('mousemove', (e) => {
          if (isDragging || e.buttons !== 1 || this._activeDragOperations > 0) return;
          const deltaX = Math.abs(e.clientX - dragStartX);
          const deltaY = Math.abs(e.clientY - dragStartY);
          if (deltaX > 5 || deltaY > 5) {
            isDragging = true;
            e.preventDefault();
            e.stopPropagation();
            window.getSelection?.().removeAllRanges?.();
            this._startBookmarkDrag(wrapper, bookmark, index, e);
          }
        });

        wrapper.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          isDragging = false;
          this._showBookmarkContextMenu(e, bookmark);
        });

        toolbar.appendChild(wrapper);
      });

      this._updateBookmarkOverflow();
      this._setupBookmarkOverflowObserver();
    } catch (error) {
      Logger.error('Bookmark toolbar refresh failed', error);
    }
  }

  /** Bind save button click */
  _bindSaveButton() {
    const saveBtn = this.app.element?.querySelector('.fa-nexus-bookmark-save');
    if (!saveBtn || !this._events) return;
    this._events.on(saveBtn, 'click', () => this.promptSaveCurrentState());
  }

  async _showBookmarkContextMenu(event, bookmark) {
    try {
      const dialog = new BookmarkDialog({
        mode: 'edit',
        titleValue: bookmark.title,
        bookmarkId: bookmark.id,
        searchQuery: bookmark.searchQuery,
        folderSelection: bookmark.folderSelection
      });

      const result = await dialog.prompt();

      if (result && typeof result === 'object') {
        if (result.action === 'save') {
          if (result.title !== undefined) {
            this.updateBookmark(bookmark.id, { title: result.title });
          }
          if (result.searchQuery !== undefined || result.folderSelection !== undefined) {
            this.updateBookmark(bookmark.id, {
              searchQuery: result.searchQuery,
              folderSelection: result.folderSelection
            });
          }
          this.refresh();
        } else if (result.action === 'remove') {
          if (this.deleteBookmark(bookmark.id)) {
            this.refresh();
          }
        }
      }
    } catch (error) {
      Logger.error('Bookmark context menu failed', error);
    }
  }

  _updateBookmarkOverflow() {
    try {
      const toolbar = this.app.element?.querySelector('.fa-nexus-bookmark-toolbar');
      const itemsContainer = this.app.element?.querySelector('.fa-nexus-bookmark-items');
      const overflowBtn = this.app.element?.querySelector('.fa-nexus-bookmark-overflow');
      if (!toolbar || !itemsContainer || !overflowBtn) return;

      const bookmarks = this.getCurrentTabBookmarks();

      if (bookmarks.length === 0) {
        itemsContainer.querySelectorAll('.fa-nexus-bookmark-wrapper').forEach(wrapper => {
          wrapper.style.display = 'none';
          wrapper.setAttribute('aria-hidden', 'true');
        });
        overflowBtn.title = '';
        overflowBtn.style.opacity = '0';
        overflowBtn.style.pointerEvents = 'none';
        overflowBtn.setAttribute('aria-hidden', 'true');
        return;
      }

      const wrappers = Array.from(itemsContainer.querySelectorAll('.fa-nexus-bookmark-wrapper'));
      wrappers.forEach(wrapper => {
        wrapper.style.display = '';
        wrapper.setAttribute('aria-hidden', 'false');
      });

      const toolbarRect = toolbar.getBoundingClientRect();
      const overflowRect = overflowBtn.getBoundingClientRect();
      const overflowWidth = overflowRect.width || 32;
      const safetyPadding = 4;
      const availableWidth = toolbarRect.width - overflowWidth - safetyPadding;
      const styles = window.getComputedStyle(itemsContainer);
      const gap = parseFloat(styles.columnGap || styles.gap || '0') || 0;

      let used = 0;
      let hasOverflow = false;
      const visibilityMap = [];

      wrappers.forEach((wrapper, index) => {
        const rect = wrapper.getBoundingClientRect();
        const width = rect.width || 0;
        const totalWidth = width + (index > 0 ? gap : 0);
        const fits = !hasOverflow && (used + totalWidth) <= availableWidth;
        visibilityMap[index] = fits;
        if (fits) used += totalWidth;
        else hasOverflow = true;
      });

      wrappers.forEach((wrapper, index) => {
        const isVisible = visibilityMap[index];
        wrapper.style.display = isVisible ? '' : 'none';
        wrapper.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
      });

      const visibleCount = visibilityMap.filter(Boolean).length;
      const needsOverflow = visibleCount < bookmarks.length;

      if (needsOverflow) {
        const hiddenBookmarks = bookmarks.filter((_, index) => visibilityMap[index] === false);
        const hiddenCount = hiddenBookmarks.length;
        overflowBtn.title = `${hiddenCount} more bookmarks`;
        overflowBtn.style.opacity = '1';
        overflowBtn.style.pointerEvents = 'auto';
        overflowBtn.setAttribute('aria-hidden', 'false');
        if (overflowBtn._overflowClickHandler) {
          overflowBtn.removeEventListener('click', overflowBtn._overflowClickHandler);
        }
        overflowBtn._overflowClickHandler = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const existingMenu = document.querySelector('.fa-nexus-bookmark-overflow-menu');
          if (existingMenu) {
            existingMenu.remove();
            return;
          }
          this._showBookmarkOverflowMenu(e, hiddenBookmarks);
        };
        overflowBtn.addEventListener('click', overflowBtn._overflowClickHandler);
      } else {
        overflowBtn.title = '';
        overflowBtn.style.opacity = '0';
        overflowBtn.style.pointerEvents = 'none';
        overflowBtn.setAttribute('aria-hidden', 'true');
        if (overflowBtn._overflowClickHandler) {
          overflowBtn.removeEventListener('click', overflowBtn._overflowClickHandler);
          overflowBtn._overflowClickHandler = null;
        }
      }
    } catch (error) {
      Logger.error('Bookmark overflow update failed', error);
    }
  }

  _showBookmarkOverflowMenu(event, overflowBookmarks) {
    try {
      const existingMenu = document.querySelector('.fa-nexus-bookmark-overflow-menu');
      if (existingMenu) existingMenu.remove();

      const menu = document.createElement('div');
      menu.className = 'fa-nexus-bookmark-overflow-menu';

      overflowBookmarks.forEach(bookmark => {
        const item = document.createElement('div');
        item.className = 'fa-nexus-bookmark-overflow-item';
        item.textContent = bookmark.title;
        item.title = bookmark.title;
        item.setAttribute('data-bookmark-id', bookmark.id);

        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let mouseDown = false;

        item.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          if (this._activeDragOperations > 0) return;
          mouseDown = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          e.preventDefault();
        });

        item.addEventListener('mousemove', (e) => {
          if (!mouseDown || this._activeDragOperations > 0) return;
          const deltaX = Math.abs(e.clientX - dragStartX);
          const deltaY = Math.abs(e.clientY - dragStartY);
          if (!isDragging && (deltaX > 5 || deltaY > 5)) {
            isDragging = true;
            menu.remove();
            this._startOverflowBookmarkDrag(bookmark, e);
          }
        });

        item.addEventListener('mouseup', (e) => {
          mouseDown = false;
          if (!isDragging && e.button === 0) {
            menu.remove();
            this.loadBookmark(bookmark.id);
          }
          isDragging = false;
        });

        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          mouseDown = false;
          isDragging = false;
          menu.remove();
          setTimeout(() => this._showBookmarkContextMenu(e, bookmark), 10);
        });

        menu.appendChild(item);
      });

      if (overflowBookmarks.length > 0) {
        const separator = document.createElement('div');
        separator.className = 'fa-nexus-bookmark-overflow-separator';
        menu.appendChild(separator);
      }

      const rect = event.target.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.left = `${rect.left}px`;
      menu.style.top = `${rect.bottom + 2}px`;
      menu.style.zIndex = '1000';

      document.body.appendChild(menu);

      const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener('click', closeMenu);
        }
      };
      setTimeout(() => document.addEventListener('click', closeMenu), 10);
    } catch (error) {
      Logger.error('Bookmark overflow menu failed', error);
    }
  }

  _startBookmarkDrag(wrapper, bookmark, index, pointerEvent = null) {
    this._activeDragOperations++;
    wrapper.classList.add('fa-nexus-bookmark-dragging');
    this._dragBookmarkId = bookmark.id;
    this._dragBookmarkIndex = index;
    this._dragFromOverflow = false;
    this._lastDragClientX = pointerEvent?.clientX ?? null;
    this._lastDragClientY = pointerEvent?.clientY ?? null;

    const toolbar = this.app.element?.querySelector('.fa-nexus-bookmark-toolbar');
    if (toolbar) toolbar.classList.add('fa-nexus-bookmark-drag-active');

    this._createDragPreview(bookmark);
    this._setupGlobalDragHandlers();
    if (this._lastDragClientX !== null && this._lastDragClientY !== null) {
      this._updateDragIndicators(this._lastDragClientX, this._lastDragClientY);
      this._updateDragPreview(this._lastDragClientX, this._lastDragClientY);
    }
  }

  _startOverflowBookmarkDrag(bookmark, pointerEvent = null) {
    this._activeDragOperations++;
    this._dragBookmarkId = bookmark.id;
    this._dragBookmarkIndex = -1;
    this._dragFromOverflow = true;
    this._lastDragClientX = pointerEvent?.clientX ?? null;
    this._lastDragClientY = pointerEvent?.clientY ?? null;

    const toolbar = this.app.element?.querySelector('.fa-nexus-bookmark-toolbar');
    if (toolbar) toolbar.classList.add('fa-nexus-bookmark-drag-active');

    this._createDragPreview(bookmark);
    this._setupGlobalDragHandlers();
    if (this._lastDragClientX !== null && this._lastDragClientY !== null) {
      this._updateDragIndicators(this._lastDragClientX, this._lastDragClientY);
      this._updateDragPreview(this._lastDragClientX, this._lastDragClientY);
    }
  }

  _setupGlobalDragHandlers() {
    const handleMouseMove = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._lastDragClientX = e.clientX;
      this._lastDragClientY = e.clientY;
      this._updateDragIndicators(e.clientX, e.clientY);
      this._updateDragPreview(e.clientX, e.clientY);
    };

    const handleMouseUp = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this._lastDropTarget && this._lastDragClientX !== null && this._lastDragClientY !== null) {
        this._updateDragIndicators(this._lastDragClientX, this._lastDragClientY);
      }
      this._finishBookmarkDrag();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }

  _updateDragIndicators(clientX, clientY) {
    if (!this._dragBookmarkId) return;
    const toolbar = this.app.element?.querySelector('.fa-nexus-bookmark-toolbar');
    if (!toolbar) return;

    const wrappers = Array.from(toolbar.querySelectorAll('.fa-nexus-bookmark-wrapper'));
    const draggingWrapper = toolbar.querySelector('.fa-nexus-bookmark-wrapper.fa-nexus-bookmark-dragging');

    wrappers.forEach(wrapper => wrapper.classList.remove('fa-nexus-bookmark-drop-left', 'fa-nexus-bookmark-drop-right'));

    const candidates = wrappers.filter(wrapper => wrapper !== draggingWrapper && this._isWrapperVisible(wrapper));
    if (!candidates.length) {
      this._lastDropTarget = null;
      this._lastDropInsertBefore = false;
      return;
    }

    let targetWrapper = document.elementFromPoint(clientX, clientY)?.closest('.fa-nexus-bookmark-wrapper') || null;
    if (targetWrapper === draggingWrapper || !this._isWrapperVisible(targetWrapper)) {
      targetWrapper = null;
    }

    let insertBefore = false;

    if (targetWrapper) {
      const rect = targetWrapper.getBoundingClientRect();
      insertBefore = clientX <= rect.left + rect.width / 2;
    } else {
      const resolved = this._resolveNearestDropTarget(candidates, clientX);
      if (!resolved) {
        this._lastDropTarget = null;
        this._lastDropInsertBefore = false;
        return;
      }
      targetWrapper = resolved.wrapper;
      insertBefore = resolved.insertBefore;
    }

    if (!targetWrapper) {
      this._lastDropTarget = null;
      this._lastDropInsertBefore = false;
      return;
    }

    targetWrapper.classList.add(insertBefore ? 'fa-nexus-bookmark-drop-left' : 'fa-nexus-bookmark-drop-right');
    this._lastDropTarget = targetWrapper.getAttribute('data-bookmark-id');
    this._lastDropInsertBefore = insertBefore;
  }

  _updateDragPreview(clientX, clientY) {
    if (!this._dragPreview) return;
    this._dragPreview.style.left = `${clientX + 12}px`;
    this._dragPreview.style.top = `${clientY + 12}px`;
  }

  _createDragPreview(bookmark) {
    if (this._dragPreview) this._dragPreview.remove();
    this._dragPreview = document.createElement('div');
    this._dragPreview.className = 'fa-nexus-bookmark-drag-preview';
    this._dragPreview.textContent = bookmark.title;
    Object.assign(this._dragPreview.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '9999'
    });
    document.body.appendChild(this._dragPreview);
  }

  _removeDragPreview() {
    if (!this._dragPreview) return;
    try { this._dragPreview.remove(); } catch (_) {}
    this._dragPreview = null;
  }

  _finishBookmarkDrag() {
    const tabId = this._getActiveTabId();
    let reorderPerformed = false;
    if (this._dragBookmarkId) {
      if (this._lastDropTarget) {
        this._bookmarkManager.reorderRelative(tabId, this._dragBookmarkId, this._lastDropTarget, this._lastDropInsertBefore);
        reorderPerformed = true;
      } else if (this._dragFromOverflow) {
        this._moveBookmarkFromOverflow(tabId, this._dragBookmarkId, 0);
        reorderPerformed = true;
      }
    }

    const toolbar = this.app.element?.querySelector('.fa-nexus-bookmark-toolbar');
    if (toolbar) {
      toolbar.querySelectorAll('.fa-nexus-bookmark-dragging, .fa-nexus-bookmark-drop-left, .fa-nexus-bookmark-drop-right').forEach(el => {
        el.classList.remove('fa-nexus-bookmark-dragging', 'fa-nexus-bookmark-drop-left', 'fa-nexus-bookmark-drop-right');
      });
      toolbar.classList.remove('fa-nexus-bookmark-drag-active');
    }

    this._removeDragPreview();

    this._activeDragOperations = Math.max(0, this._activeDragOperations - 1);
    this._dragBookmarkId = null;
    this._dragBookmarkIndex = null;
    this._dragFromOverflow = false;
    this._lastDropTarget = null;
    this._lastDropInsertBefore = false;
    this._lastDragClientX = null;
    this._lastDragClientY = null;

    if (reorderPerformed) this.refresh();
  }

  _moveBookmarkFromOverflow(tabId, bookmarkId, newIndex = 0) {
    try {
      this._bookmarkManager.moveBookmark(tabId, bookmarkId, newIndex);
      Logger.info('Bookmark moved from overflow to toolbar', { tabId, bookmarkId, index: newIndex });
    } catch (error) {
      Logger.error('Moving bookmark from overflow failed', error);
    }
  }

  _setupBookmarkOverflowObserver() {
    try {
      if (this._bookmarkOverflowObserver) {
        this._bookmarkOverflowObserver.disconnect();
      }

      const toolbar = this.app.element?.querySelector('.fa-nexus-bookmark-toolbar');
      if (!toolbar) return;

      this._bookmarkOverflowObserver = new ResizeObserver(() => {
        this._updateBookmarkOverflow();
      });

      this._bookmarkOverflowObserver.observe(toolbar);
      if (this.app.element) this._bookmarkOverflowObserver.observe(this.app.element);
    } catch (error) {
      Logger.error('Bookmark overflow observer setup failed', error);
    }
  }

  _getActiveTabId() {
    return this._tabManager.getActiveTabId?.() || this.app._activeTab || 'tokens';
  }

  _isWrapperVisible(wrapper) {
    if (!wrapper || wrapper.style.display === 'none') return false;
    const rect = wrapper.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  _resolveNearestDropTarget(wrappers, clientX) {
    let bestWrapper = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let insertBefore = false;

    wrappers.forEach(wrapper => {
      const rect = wrapper.getBoundingClientRect();
      let distance;
      let before;

      if (clientX < rect.left) {
        distance = rect.left - clientX;
        before = true;
      } else if (clientX > rect.right) {
        distance = clientX - rect.right;
        before = false;
      } else {
        const midpoint = rect.left + rect.width / 2;
        distance = Math.abs(clientX - midpoint);
        before = clientX <= midpoint;
      }

      if (distance < bestDistance) {
        bestDistance = distance;
        bestWrapper = wrapper;
        insertBefore = before;
      }
    });

    if (!bestWrapper) return null;
    return { wrapper: bestWrapper, insertBefore };
  }
}
