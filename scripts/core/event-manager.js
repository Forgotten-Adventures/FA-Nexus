/**
 * Minimal EventManager for FA Nexus
 * - Tracks timeouts/intervals for cleanup
 * - Simple DOM handler registration convenience
 */
export class EventManager {
  /** Create a new event manager */
  constructor() {
    this._timeouts = new Set();
    this._intervals = new Set();
    this._handlers = [];
  }

  /**
   * Track a timeout for later cleanup
   * @param {Function} fn
   * @param {number} ms
   * @returns {number} timeout id
   */
  setTimeout(fn, ms) {
    const id = setTimeout(() => { this._timeouts.delete(id); fn(); }, ms);
    this._timeouts.add(id);
    return id;
  }

  /** Clear a tracked timeout */
  clearTimeout(id) {
    if (!id) return;
    clearTimeout(id);
    this._timeouts.delete(id);
  }

  /**
   * Track an interval for later cleanup
   * @param {Function} fn
   * @param {number} ms
   * @returns {number} interval id
   */
  setInterval(fn, ms) {
    const id = setInterval(fn, ms);
    this._intervals.add(id);
    return id;
  }

  /** Clear a tracked interval */
  clearInterval(id) {
    if (!id) return;
    clearInterval(id);
    this._intervals.delete(id);
  }

  /**
   * Add a DOM event listener and return an off() function. Tracked for cleanup.
   * @param {Element|Window|Document} element
   * @param {string} event
   * @param {(ev:Event)=>void} handler
   * @param {AddEventListenerOptions|boolean} [options]
   * @returns {Function} off function
   */
  on(element, event, handler, options) {
    if (!element) return () => {};
    element.addEventListener(event, handler, options);
    const off = () => {
      try { element.removeEventListener(event, handler, options); } catch (e) {}
    };
    this._handlers.push(off);
    return off;
  }

  /** Clear all tracked timers and DOM handlers */
  cleanup() {
    for (const id of this._timeouts) clearTimeout(id);
    for (const id of this._intervals) clearInterval(id);
    this._timeouts.clear();
    this._intervals.clear();
    while (this._handlers.length) {
      try { this._handlers.pop()(); } catch (e) {}
    }
  }
}

