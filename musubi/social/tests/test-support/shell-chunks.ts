import { shells } from "../../src/App";

/**
 * The loads a shell waits for before it draws, for browser tests that wait
 * for a shell to arrive.
 *
 * `Reserved` in `src/App.tsx` draws the rail (`Sidebar`) or the phone top bar
 * (`MobileChrome`) only once that shell's `load` in `shells` has resolved.
 * These return the same `load`, so a test that awaits one after
 * `render` resolves when the shell can draw, however long the dev server takes
 * to transform the modules; a `waitFor` after it covers only the render that
 * follows. A load added to a shell reaches these waits with no edit here.
 *
 * The shell's own chunk loads through the app's `lazy()`, so this joins the
 * load the app started. The app loads the dialogs' chunk through
 * `ShellDialogsProvider`, which a test cannot reach; here it is a plain
 * import, whose specifier resolves to the URL the app imports, so the page
 * still holds one copy of the module. Call these after `render`, or a test
 * that watches a cold arrival starts the load itself. A chunk that fails to
 * load rejects here, naming its module.
 */

const loadDialogs = () => import("../../src/components/ShellDialogSet").then(() => undefined);

/** The rail's loads: `Sidebar` and the shell dialogs. */
export function railChunks(): Promise<void> {
  return shells.rail.load(loadDialogs);
}

/** The phone top bar's loads: `MobileChrome` and the shell dialogs. */
export function topBarChunks(): Promise<void> {
  return shells.topBar.load(loadDialogs);
}
