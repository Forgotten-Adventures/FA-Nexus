/**
 * Bookmark Manager for FA Nexus
 * Handles saving, loading, and managing search bookmarks per tab
 */

import { cloneFolderSelection } from '../../content/content-sources/content-sources-utils.js';

export class BookmarkManager {
  constructor() {
    this._bookmarks = {};
    this._loadBookmarks();
  }

  /**
   * Load bookmarks from game settings
   * @private
   */
  _loadBookmarks() {
    try {
      const stored = game.settings.get('fa-nexus', 'bookmarks') || {};
      this._bookmarks = { ...stored };
    } catch (e) {
      console.warn('fa-nexus | Failed to load bookmarks:', e);
      this._bookmarks = {};
    }
  }

  /**
   * Save bookmarks to game settings
   * @private
   */
  _saveBookmarks() {
    try {
      game.settings.set('fa-nexus', 'bookmarks', { ...this._bookmarks });
    } catch (e) {
      console.warn('fa-nexus | Failed to save bookmarks:', e);
    }
  }

  /**
   * Get bookmarks for a specific tab
   * @param {string} tabId
   * @returns {Array<Object>} Array of bookmark objects
   */
  getBookmarksForTab(tabId) {
    return this._bookmarks[tabId] || [];
  }

  /**
   * Replace the bookmark array for a tab and persist.
   * @param {string} tabId
   * @param {Array<Object>} bookmarks
   */
  _setBookmarksForTab(tabId, bookmarks) {
    this._bookmarks[tabId] = Array.isArray(bookmarks) ? bookmarks : [];
    this._saveBookmarks();
  }

  /**
   * Create a new bookmark
   * @param {string} tabId - The tab this bookmark belongs to
   * @param {string} title - User-provided title
   * @param {string} searchQuery - Current search query
   * @param {Object} folderSelection - Current folder browser selection
   * @returns {Object} The created bookmark
   */
  createBookmark(tabId, title, searchQuery, folderSelection) {
    const bookmark = {
      id: `bookmark_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: title.trim(),
      searchQuery: (searchQuery || '').trim(),
      folderSelection: folderSelection ? cloneFolderSelection(folderSelection) : null,
      tab: tabId,
      created: Date.now()
    };

    if (!this._bookmarks[tabId]) {
      this._bookmarks[tabId] = [];
    }

    this._bookmarks[tabId].push(bookmark);
    this._saveBookmarks();
    return bookmark;
  }

  /**
   * Update an existing bookmark
   * @param {string} tabId
   * @param {string} bookmarkId
   * @param {Object} updates - Partial bookmark updates
   * @returns {boolean} Success
   */
  updateBookmark(tabId, bookmarkId, updates) {
    const bookmarks = this.getBookmarksForTab(tabId);
    const index = bookmarks.findIndex(b => b.id === bookmarkId);

    if (index === -1) return false;

    const bookmark = bookmarks[index];
    const updated = {
      ...bookmark,
      ...updates,
      updated: Date.now()
    };

    if (updates.title !== undefined) {
      updated.title = updates.title.trim();
    }

    bookmarks[index] = updated;
    this._saveBookmarks();
    return true;
  }

  /**
   * Delete a bookmark
   * @param {string} tabId
   * @param {string} bookmarkId
   * @returns {boolean} Success
   */
  deleteBookmark(tabId, bookmarkId) {
    const bookmarks = this.getBookmarksForTab(tabId);
    const filtered = bookmarks.filter(b => b.id !== bookmarkId);

    if (filtered.length === bookmarks.length) return false;

    this._bookmarks[tabId] = filtered;
    this._saveBookmarks();
    return true;
  }

  /**
   * Move a bookmark to a new index inside the same tab.
   * @param {string} tabId
   * @param {string} bookmarkId
   * @param {number} newIndex
   * @returns {boolean}
   */
  moveBookmark(tabId, bookmarkId, newIndex) {
    const bookmarks = this.getBookmarksForTab(tabId);
    const currentIndex = bookmarks.findIndex(b => b.id === bookmarkId);
    if (currentIndex === -1) return false;

    const targetIndex = Number.isFinite(newIndex) ? Math.max(0, Math.min(Math.floor(newIndex), bookmarks.length - 1)) : currentIndex;
    if (targetIndex === currentIndex) return true;

    const [bookmark] = bookmarks.splice(currentIndex, 1);
    bookmarks.splice(targetIndex, 0, bookmark);
    this._setBookmarksForTab(tabId, bookmarks);
    return true;
  }

  /**
   * Reorder a bookmark relative to another bookmark within the same tab.
   * @param {string} tabId
   * @param {string} draggedId
   * @param {string} targetId
   * @param {boolean} insertBefore
   * @returns {boolean}
   */
  reorderRelative(tabId, draggedId, targetId, insertBefore = false) {
    if (draggedId === targetId) return false;
    const bookmarks = this.getBookmarksForTab(tabId);
    const draggedIndex = bookmarks.findIndex(b => b.id === draggedId);
    const targetIndex = bookmarks.findIndex(b => b.id === targetId);
    if (draggedIndex === -1 || targetIndex === -1) return false;

    const [dragged] = bookmarks.splice(draggedIndex, 1);
    let nextIndex = insertBefore ? targetIndex : targetIndex + 1;
    if (!insertBefore && draggedIndex < targetIndex) nextIndex -= 1;
    bookmarks.splice(nextIndex, 0, dragged);
    this._setBookmarksForTab(tabId, bookmarks);
    return true;
  }

  /**
   * Get a specific bookmark
   * @param {string} tabId
   * @param {string} bookmarkId
   * @returns {Object|null}
   */
  getBookmark(tabId, bookmarkId) {
    const bookmarks = this.getBookmarksForTab(tabId);
    return bookmarks.find(b => b.id === bookmarkId) || null;
  }

  /**
   * Get all bookmarks across all tabs
   * @returns {Object} Bookmarks keyed by tabId
   */
  getAllBookmarks() {
    return { ...this._bookmarks };
  }
}
