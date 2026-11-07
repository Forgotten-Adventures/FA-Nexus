function stringifyError(error) {
  return String(error?.message || error);
}

function logCancelDialogFailure(logger, eventName, details = {}) {
  logger?.warn?.(eventName, details);
}

function forceConfirmCancelDialog(dialog, {
  logger = null,
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  if (!dialog) return false;
  try {
    const button = dialog.element?.querySelector?.('button[data-action="yes"]');
    if (button) {
      button.click();
      return true;
    }
  } catch (error) {
    logCancelDialogFailure(logger, `${loggerPrefix}.cancelDialog.forceClickFailed`, {
      error: stringifyError(error)
    });
  }
  try { dialog.close?.({ submitted: true }); }
  catch (error) {
    logCancelDialogFailure(logger, `${loggerPrefix}.cancelDialog.forceCloseFailed`, {
      error: stringifyError(error)
    });
  }
  return true;
}

/**
 * The one wording of the Discard question that Escape and Cancel ask in every editor (design A1):
 * "Discard <Noun> Session" / "Discard the current <noun> edits? This cannot be undone." with Discard / Keep Editing.
 */
export function buildDiscardQuestionText(noun) {
  const name = String(noun || 'session').trim().toLowerCase();
  return {
    title: `Discard ${name.charAt(0).toUpperCase()}${name.slice(1)} Session`,
    message: `Discard the current ${name} edits? This cannot be undone.`
  };
}

export function forceHostedCancelSessionDialog(state = {}, options = {}) {
  return forceConfirmCancelDialog(state.dialog, options);
}

export function createHostedCancelSessionState(manager) {
  return {
    get promise() { return manager?._cancelConfirmPromise || null; },
    set promise(value) {
      if (manager) manager._cancelConfirmPromise = value;
    },
    get dialog() { return manager?._cancelConfirmDialog || null; },
    set dialog(value) {
      if (manager) manager._cancelConfirmDialog = value;
    }
  };
}

export async function requestHostedCancelSession({
  state = null,
  source = 'manual',
  hasSessionChanges = null,
  stopSession = null,
  title = 'Discard Session',
  message = 'Discard the current edits? This cannot be undone.',
  logger = null,
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  if (typeof hasSessionChanges === 'function' && !hasSessionChanges()) {
    await Promise.resolve(stopSession?.());
    return true;
  }
  const force = source === 'escape' && !!state?.promise;
  const confirmed = await confirmHostedCancelSession({
    state,
    force,
    hasSessionChanges,
    title,
    message,
    logger,
    loggerPrefix
  });
  if (!confirmed) return false;
  await Promise.resolve(stopSession?.());
  return true;
}

export async function confirmHostedCancelSession({
  state = null,
  force = false,
  hasSessionChanges = null,
  title = 'Discard Session',
  message = 'Discard the current edits? This cannot be undone.',
  confirmLabel = 'Discard',
  cancelLabel = 'Keep Editing',
  logger = null,
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  if (typeof hasSessionChanges === 'function' && !hasSessionChanges()) return true;
  if (!state || typeof state !== 'object') {
    throw new Error('Cancel session confirmation requires a mutable state object.');
  }
  if (state.promise) {
    if (force) forceHostedCancelSessionDialog(state, { logger, loggerPrefix });
    return state.promise;
  }
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  // Without the dialog the question cannot be asked; Discard is never assumed.
  if (!DialogV2?.wait) throw new Error('The Discard question could not be shown: Foundry DialogV2 is unavailable.');
  const promise = DialogV2.wait({
    window: { title },
    modal: true,
    content: `<p>${message}</p>`,
    buttons: [
      { action: 'yes', label: confirmLabel, icon: 'fas fa-trash', default: false, callback: () => true },
      { action: 'no', label: cancelLabel, default: true, callback: () => false }
    ],
    close: () => false,
    render: (_event, dialog) => {
      state.dialog = dialog;
    }
  });
  state.promise = Promise.resolve(promise)
    .then((result) => {
      state.promise = null;
      state.dialog = null;
      return !!result;
    })
    .catch((error) => {
      logCancelDialogFailure(logger, `${loggerPrefix}.cancelDialog.waitFailed`, {
        title,
        error: stringifyError(error)
      });
      state.promise = null;
      state.dialog = null;
      return false;
    });
  if (force) forceHostedCancelSessionDialog(state, { logger, loggerPrefix });
  return state.promise;
}

let openSessionExitQuestions = 0;

/**
 * True while a leave question is open. A key pressed then belongs to the question: Escape closes it as Continue
 * Editing and must not also reach the editor behind it (which would ask its own Discard question).
 */
export function isSessionExitQuestionOpen() {
  return openSessionExitQuestions > 0;
}

/**
 * The question asked when a session with unsaved changes is left by closing FA Nexus or opening another tab:
 * Commit, Discard or Continue Editing. Resolves 'commit', 'discard' or 'continue'; closing the dialog, Escape
 * included, is Continue Editing. While a question is open, asking again returns the same answer.
 * `commitUnavailableReason`, when given, disables Commit and says why.
 */
export function askHostedSessionExitQuestion({
  state,
  noun = 'session',
  leaveLabel = 'leaving',
  commitUnavailableReason = null
} = {}) {
  if (!state || typeof state !== 'object') throw new Error('The leave question requires a mutable state object.');
  if (state.promise) return state.promise;
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) throw new Error('The leave question could not be shown: Foundry DialogV2 is unavailable.');
  const escape = (text) => foundry.utils.escapeHTML(String(text));
  const title = `Leave ${noun.charAt(0).toUpperCase()}${noun.slice(1)} Session`;
  const reason = String(commitUnavailableReason || '').trim();
  openSessionExitQuestions += 1;
  const promise = DialogV2.wait({
    window: { title },
    classes: ['fa-nexus-session-exit-question'],
    modal: true,
    content: `<p>Commit the current ${escape(noun)} edits before ${escape(leaveLabel)}?</p>`
      + (reason ? `<p class="hint">Commit is unavailable: ${escape(reason)}</p>` : ''),
    buttons: [
      { action: 'commit', label: 'Commit', icon: 'fas fa-check', disabled: !!reason, callback: () => 'commit' },
      { action: 'discard', label: 'Discard', icon: 'fas fa-trash', callback: () => 'discard' },
      { action: 'continue', label: 'Continue Editing', default: true, callback: () => 'continue' }
    ],
    close: () => 'continue',
    render: (_event, dialog) => { state.dialog = dialog; }
  });
  state.promise = Promise.resolve(promise)
    .then((answer) => (['commit', 'discard'].includes(answer) ? answer : 'continue'))
    .finally(() => {
      state.promise = null;
      state.dialog = null;
      // A frame later: the key press that closed the question is still being dispatched to other listeners.
      setTimeout(() => { openSessionExitQuestions -= 1; }, 0);
    });
  return state.promise;
}
