// An unpacked NarWal starts a new build by itself (board #17009). Edge never
// reloads an unpacked extension when the files in its folder change, so a
// person had to press Reload after each new build was put in the folder. The worker now reads the folder's
// dist/build.json (written last by build.mjs) when it starts and every
// minute. When it names a build other than the one running, the worker calls
// chrome.runtime.reload(), which is what Reload in edge://extensions does.
//
// It reloads only an unpacked install (a store install updates itself), and
// only when no work can be lost: no recording or save, no recorder (it also
// makes the transcript after Stop and installs speech models), no popup, and
// no NarWal page in use (src/shared/page-use.js: shown, used in the last ten
// minutes, or holding typed text not saved). A reload closes every NarWal
// page and clears chrome.storage.session, so the worker writes down the NarWal
// tabs first and opens them again, at the same place, when it comes back.
// Before, any open page held the reload, and Saved recordings and replay tabs
// left open in the background held it for twelve days.
//
// One reload per folder build: if the worker that comes back still runs a
// different build (a folder copied by hand from two builds), it does not
// reload again for that folder build, so it can never reload in a loop.

export const BUILD_ALARM = 'narwal-build-check';
export const BUILD_CHECK_MINUTES = 1;
// chrome.storage.local: the last folder build the worker reloaded for.
export const RELOAD_KEY = 'selfUpdate';
// chrome.storage.local: the NarWal tabs to open again after the reload.
export const RESTORE_KEY = 'selfUpdateTabs';
// chrome.storage.local: the folder build whose reload is waiting, and why,
// so a person (or a release tool) can tell why a new build has not started.
export const HELD_KEY = 'selfUpdateHeld';
// Tabs written down longer ago than this are not opened again: that reload
// never happened, or the browser was closed in between.
export const RESTORE_WITHIN_MS = 5 * 60 * 1000;

/**
 * True when the folder's dist/build.json names a build other than the one
 * running. `running` is NARWAL_BUILD plus the manifest version; an unreadable
 * or incomplete build.json is never a new build.
 */
export function isNewBuild(running, folder) {
  if (!running || !folder || typeof folder.short !== 'string' || typeof folder.version !== 'string') return false;
  if (!folder.short || !folder.version) return false;
  return folder.short !== running.commit || folder.version !== running.version;
}

/**
 * The check. Every dependency is passed in, so the unit tests run it without
 * a browser:
 *   running             { version, commit } of the code that runs now
 *   installType()       chrome.management.getSelf().installType
 *   readFolderBuild()   the folder's dist/build.json, or null
 *   blocker()           why a reload would lose work now, or null
 *   lastReload()/saveReload(entry)   chrome.storage.local[RELOAD_KEY]
 *   noteHeld(held)      chrome.storage.local[HELD_KEY]: { short, version, why }
 *                       while a reload waits, null once it goes ahead
 *   beforeReload()      writes down the NarWal tabs to open after the reload
 *   reload()            chrome.runtime.reload; may return a promise to wait on
 * `check(trigger)` answers one word: not-unpacked, unreadable, same, tried,
 * busy:<why> or reloading.
 */
export function createSelfUpdate({ running, installType, readFolderBuild, blocker, lastReload, saveReload, noteHeld = async () => {}, beforeReload = async () => {}, reload, log = () => {} }) {
  return async function check(trigger) {
    if ((await installType().catch(() => null)) !== 'development') return 'not-unpacked';
    const folder = await readFolderBuild().catch(() => null);
    if (!folder) return 'unreadable';
    if (!isNewBuild(running, folder)) {
      // A Reload click or an Edge restart started it: nothing waits any more.
      await noteHeld(null);
      return 'same';
    }
    const tried = await lastReload().catch(() => null);
    if (tried && tried.short === folder.short && tried.version === folder.version) return 'tried';
    const why = await blocker();
    if (why) {
      await noteHeld({ short: folder.short, version: folder.version, why });
      return `busy:${why}`;
    }
    await noteHeld(null);
    await saveReload({ short: folder.short, version: folder.version, from: running.commit, trigger, at: new Date().toISOString() });
    await beforeReload();
    log(`NarWal: build ${folder.short} (${folder.version}) is in the folder; running ${running.commit} (${running.version}): reloading`);
    await reload();
    return 'reloading';
  };
}

/**
 * The HELD_KEY entry to write for `held` ({ short, version, why }) given the
 * saved one, or null when nothing changed (the check runs every minute, so
 * an unchanged wait is not written again). `since` is when this folder build
 * first waited; `at` is when its reason last changed.
 */
export function heldEntry(prev, held, now) {
  const at = now.toISOString();
  const sameBuild = Boolean(prev) && prev.short === held.short && prev.version === held.version;
  if (sameBuild && prev.why === held.why) return null;
  return { short: held.short, version: held.version, why: held.why, since: sameBuild && prev.since ? prev.since : at, at };
}

/**
 * Why a reload now would lose work, or null. `contexts` is
 * chrome.runtime.getContexts({}): every NarWal page and the recorder.
 * `pagesInUse` is true when a page holds PAGE_IN_USE_LOCK; a page that is
 * open but not in use is opened again after the reload.
 */
export function reloadBlocker({ live, stopping, contexts, pagesInUse }) {
  if (live) return 'recording';
  if (stopping) return 'saving';
  const types = new Set((contexts || []).map((c) => c.contextType));
  if (types.has('OFFSCREEN_DOCUMENT')) return 'recorder';
  if (types.has('POPUP')) return 'popup-open';
  if (pagesInUse) return 'page-in-use';
  return null;
}

/**
 * The NarWal tabs to open again after the reload, from chrome.tabs.query({}):
 * every tab showing one of this extension's pages (`prefix` is
 * chrome.runtime.getURL('')), sleeping tabs too.
 */
export function tabsToRestore(tabs, prefix) {
  return (tabs || [])
    .filter((t) => t && typeof t.url === 'string' && t.url.startsWith(prefix) && Number.isInteger(t.id))
    .map((t) => ({ tabId: t.id, windowId: t.windowId, index: t.index, pinned: Boolean(t.pinned), active: Boolean(t.active), url: t.url }));
}

/**
 * Opens the tabs written down before the reload, once (board #17009). A tab
 * the browser kept is loaded again at its address; a closed one is opened in
 * its window at its place, or in the current window when that one is gone.
 * Answers how many it opened or loaded. Dependencies:
 *   saved      chrome.storage.local[RESTORE_KEY]: { at, tabs }, or null
 *   clear()    removes RESTORE_KEY, before any tab opens
 *   getTab(id)/getWindow(id)   the tab or window, or null when it is gone
 *   update(id, props)/create(props)   chrome.tabs.update / chrome.tabs.create
 */
export async function restoreTabs({ saved, now, clear, getTab, getWindow, update, create }) {
  if (!saved) return 0;
  await clear();
  if (!Array.isArray(saved.tabs) || !(now - Date.parse(saved.at) <= RESTORE_WITHIN_MS)) return 0;
  let opened = 0;
  // Left to right, so each index puts the tab back where it was.
  for (const t of [...saved.tabs].sort((a, b) => a.index - b.index)) {
    try {
      const kept = await getTab(t.tabId);
      if (kept && kept.url === t.url && !kept.discarded && kept.status !== 'unloaded') {
        await update(t.tabId, { url: t.url });
      } else if (!kept || kept.url !== t.url) {
        const win = await getWindow(t.windowId);
        await create({ url: t.url, active: t.active, pinned: t.pinned, ...(win ? { windowId: t.windowId, index: t.index } : {}) });
      } else {
        continue; // A sleeping tab loads its page when it is next shown.
      }
      opened++;
    } catch {
      // One tab that cannot open does not stop the others.
    }
  }
  return opened;
}
