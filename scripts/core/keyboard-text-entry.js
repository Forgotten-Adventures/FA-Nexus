// A key typed into a text box belongs to the text box, not to the tool whose
// session happens to be open behind it.

const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image']);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);
const TEXT_EDITING_SHORTCUT_KEYS = new Set(['a', 'c', 'v', 'x', 'y', 'z']);

/**
 * True when a key event types into, or edits, a text box: a search box, a name
 * field, a number box, a drop-down. Escape there clears or leaves the box; it
 * must not cancel an editor session.
 *
 * Still for the session: a modifier key on its own (sessions track what is held),
 * and Ctrl/Cmd shortcuts other than the ones a text box uses itself (Ctrl+S
 * commits; left alone, the browser would offer to save the page).
 *
 * A dialog handles its own keys, and an editor follows its own dialogs: fields
 * inside a dialog are not covered.
 */
export function isKeyEventForTextEntry(event) {
  const target = event?.target;
  if (!target || typeof target.closest !== 'function') return false;
  const field = target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  if (!field) return false;
  if (field.tagName === 'INPUT' && NON_TEXT_INPUT_TYPES.has(String(field.type || 'text').toLowerCase())) return false;
  if (field.closest('dialog, .dialog')) return false;
  const key = String(event.key || '');
  if (MODIFIER_KEYS.has(key)) return false;
  if (event.ctrlKey || event.metaKey) return TEXT_EDITING_SHORTCUT_KEYS.has(key.toLowerCase());
  return true;
}
