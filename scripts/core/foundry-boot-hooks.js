// Foundry fires its boot hooks (init, i18nInit, setup, ready) from its own DOMContentLoaded listener and does not wait
// for a module's top-level await. nexus-app.js imports the mapmaking runtime behind one, so on a slow host such as The
// Forge a runtime module can finish loading after a boot hook has fired (measured on Foundry 14.369: init at 3204 ms,
// the Layer Manager's init listener at 3634 ms). A plain Hooks.once registered then never runs.
//
// This module is imported statically by both entry scripts, so its listeners are in place before init and it knows
// which boot hooks have fired. onFoundryBoot() waits for a hook that is still to come and runs the callback at once
// for one that has passed.

const BOOT_HOOKS = Object.freeze(['init', 'i18nInit', 'setup', 'ready']);
const fired = new Set();

// In Foundry, Hooks exists before any module script runs. The deterministic checks import these modules in Node with
// no Hooks or a partial double; there the tracker stays unarmed and onFoundryBoot behaves exactly like Hooks.once.
if (typeof globalThis.Hooks?.once === 'function') {
  for (const name of BOOT_HOOKS) globalThis.Hooks.once(name, () => { fired.add(name); });
}

function assertBootHook(name) {
  if (!BOOT_HOOKS.includes(name)) throw new Error(`FA Nexus: "${name}" is not a Foundry boot hook.`);
}

export function hasFoundryBootHookFired(name) {
  assertBootHook(name);
  return fired.has(name);
}

function reportLateBootFailure(name, error) {
  const onError = globalThis.Hooks?.onError;
  if (typeof onError === 'function') {
    onError.call(globalThis.Hooks, 'FA Nexus late boot hook', error, { msg: `FA Nexus "${name}" work failed`, log: 'error' });
  } else {
    console.error(`fa-nexus | "${name}" work failed`, error);
  }
}

/**
 * Hooks.once for a Foundry boot hook that also works for a module loaded after that hook fired: the callback then runs
 * at once. A failure is reported as Foundry reports one from a hook, so it stays visible either way.
 */
export function onFoundryBoot(name, callback) {
  assertBootHook(name);
  if (!fired.has(name)) {
    globalThis.Hooks.once(name, callback);
    return;
  }
  try {
    const result = callback();
    if (typeof result?.catch === 'function') result.catch((error) => reportLateBootFailure(name, error));
  } catch (error) {
    reportLateBootFailure(name, error);
  }
}
