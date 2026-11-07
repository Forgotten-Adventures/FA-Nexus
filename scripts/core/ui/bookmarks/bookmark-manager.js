/**
 * Bookmark Manager for FA Nexus
 * Handles saving, loading, and managing search bookmarks per tab
 */

import { cloneFolderSelection } from '../../../content/content-sources/content-sources-utils.js';

const MODULE_ID = 'fa-nexus';
const BOOKMARKS_SETTING_KEY = 'bookmarks';

/**
 * @typedef {import('../../fa-nexus-types.js').FaNexusBookmark} FaNexusBookmark
 * @typedef {import('../../fa-nexus-types.js').FaNexusBookmarkMap} FaNexusBookmarkMap
 * @typedef {import('../../fa-nexus-types.js').FaNexusFolderSelection} FaNexusFolderSelection
 */

export class BookmarkManager {
  constructor() {
    /** @type {FaNexusBookmarkMap} */
    this._bookmarks = {};
    this._loadBookmarks();
  }

  /**
   * Load bookmarks from game settings
   * @private
   */
  _loadBookmarks() {
    try {
      const stored = game.settings.get(MODULE_ID, BOOKMARKS_SETTING_KEY) || {};
      this._bookmarks = { ...stored };
    } catch (e) {
      console.warn('fa-nexus | Failed to load bookmarks:', e);
      this._bookmarks = {};
    }
  }

  /**
   * Get bookmarks for a specific tab
   * @param {string} tabId
   * @returns {FaNexusBookmark[]} Array of bookmark objects
   */
  getBookmarksForTab(tabId) {
    return this._bookmarks[tabId] || [];
  }

  /**
   * Replace the bookmark array for a tab and persist.
   * @param {string} tabId
   * @param {FaNexusBookmark[]} bookmarks
   * @returns {Promise<void>}
   */
  async _setBookmarksForTab(tabId, bookmarks) {
    const candidateBookmarks = {
      ...this._bookmarks,
      [tabId]: Array.isArray(bookmarks) ? bookmarks : []
    };
    await game.settings.set(MODULE_ID, BOOKMARKS_SETTING_KEY, { ...candidateBookmarks });
    this._bookmarks = candidateBookmarks;
  }

  /**
   * Create a new bookmark
   * @param {string} tabId - The tab this bookmark belongs to
   * @param {string} title - User-provided title
   * @param {string} searchQuery - Current search query
   * @param {FaNexusFolderSelection|null} folderSelection - Current folder browser selection
   * @param {{id: string|null, includeChildren: boolean}|null} collectionScope - Optional Collection scope instead of source folders
   * @returns {Promise<FaNexusBookmark>} The created bookmark
   */
  async createBookmark(tabId, title, searchQuery, folderSelection, collectionScope = null) {
    const bookmark = {
      id: `bookmark_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: title.trim(),
      searchQuery: (searchQuery || '').trim(),
      folderSelection: folderSelection ? cloneFolderSelection(folderSelection) : null,
      tab: tabId,
      created: Date.now()
    };
    if (collectionScope) bookmark.collectionScope = structuredClone(collectionScope);

    const candidateTabBookmarks = [...this.getBookmarksForTab(tabId), bookmark];
    await this._setBookmarksForTab(tabId, candidateTabBookmarks);
    return bookmark;
  }

  /**
   * Update an existing bookmark
   * @param {string} tabId
   * @param {string} bookmarkId
   * @param {Partial<FaNexusBookmark>} updates - Partial bookmark updates
   * @returns {Promise<boolean>} Success
   */
  async updateBookmark(tabId, bookmarkId, updates) {
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

    const candidateTabBookmarks = [...bookmarks];
    candidateTabBookmarks[index] = updated;
    await this._setBookmarksForTab(tabId, candidateTabBookmarks);
    return true;
  }

  /**
   * Delete a bookmark
   * @param {string} tabId
   * @param {string} bookmarkId
   * @returns {Promise<boolean>} Success
   */
  async deleteBookmark(tabId, bookmarkId) {
    const bookmarks = this.getBookmarksForTab(tabId);
    const candidateTabBookmarks = bookmarks.filter(b => b.id !== bookmarkId);

    if (candidateTabBookmarks.length === bookmarks.length) return false;

    await this._setBookmarksForTab(tabId, candidateTabBookmarks);
    return true;
  }

  /**
   * Move a bookmark to a new index inside the same tab.
   * @param {string} tabId
   * @param {string} bookmarkId
   * @param {number} newIndex
   * @returns {Promise<boolean>}
   */
  async moveBookmark(tabId, bookmarkId, newIndex) {
    const bookmarks = this.getBookmarksForTab(tabId);
    const currentIndex = bookmarks.findIndex(b => b.id === bookmarkId);
    if (currentIndex === -1) return false;

    const targetIndex = Number.isFinite(newIndex) ? Math.max(0, Math.min(Math.floor(newIndex), bookmarks.length - 1)) : currentIndex;
    if (targetIndex === currentIndex) return true;

    const candidateTabBookmarks = [...bookmarks];
    const [bookmark] = candidateTabBookmarks.splice(currentIndex, 1);
    candidateTabBookmarks.splice(targetIndex, 0, bookmark);
    await this._setBookmarksForTab(tabId, candidateTabBookmarks);
    return true;
  }

  /**
   * Reorder a bookmark relative to another bookmark within the same tab.
   * @param {string} tabId
   * @param {string} draggedId
   * @param {string} targetId
   * @param {boolean} insertBefore
   * @returns {Promise<boolean>}
   */
  async reorderRelative(tabId, draggedId, targetId, insertBefore = false) {
    if (draggedId === targetId) return false;
    const bookmarks = this.getBookmarksForTab(tabId);
    const draggedIndex = bookmarks.findIndex(b => b.id === draggedId);
    const targetIndex = bookmarks.findIndex(b => b.id === targetId);
    if (draggedIndex === -1 || targetIndex === -1) return false;

    const candidateTabBookmarks = [...bookmarks];
    const [dragged] = candidateTabBookmarks.splice(draggedIndex, 1);
    let nextIndex = insertBefore ? targetIndex : targetIndex + 1;
    if (!insertBefore && draggedIndex < targetIndex) nextIndex -= 1;
    candidateTabBookmarks.splice(nextIndex, 0, dragged);
    await this._setBookmarksForTab(tabId, candidateTabBookmarks);
    return true;
  }

  /**
   * Get a specific bookmark
   * @param {string} tabId
   * @param {string} bookmarkId
   * @returns {FaNexusBookmark|null}
   */
  getBookmark(tabId, bookmarkId) {
    const bookmarks = this.getBookmarksForTab(tabId);
    return bookmarks.find(b => b.id === bookmarkId) || null;
  }

  /**
   * Get all bookmarks across all tabs
   * @returns {FaNexusBookmarkMap} Bookmarks keyed by tabId
   */
  getAllBookmarks() {
    return { ...this._bookmarks };
  }
}
