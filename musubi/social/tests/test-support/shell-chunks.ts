/**
 * The chunks a shell waits for before it draws, for browser tests that wait
 * for a shell to arrive.
 *
 * `Reserved` in `src/App.tsx` draws the rail (`Sidebar`) or the phone top bar
 * (`MobileChrome`) only once that shell's chunk and the shell dialogs' chunk
 * (`ShellDialogSet`) have both loaded. These import the same pair, so a test
 * that awaits one after `render` resolves when the shell can draw, however long
 * the dev server takes to transform the modules; a `waitFor` after it covers
 * only the render that follows. Change them with `Reserved`.
 *
 * The specifiers resolve to the URLs the app imports, so the page holds one
 * copy of each module and this joins the load the app started rather than
 * fetching a second one. Call it after `render`, or a test that watches a cold
 * arrival starts the load itself. A chunk that fails to load rejects here,
 * naming its module.
 */

/** The rail's pair: `Sidebar` and the shell dialogs. */
export async function railChunks(): Promise<void> {
  await Promise.all([
    import("../../src/components/Sidebar"),
    import("../../src/components/ShellDialogSet"),
  ]);
}

/** The phone top bar's pair: `MobileChrome` and the shell dialogs. */
export async function topBarChunks(): Promise<void> {
  await Promise.all([
    import("../../src/components/MobileChrome"),
    import("../../src/components/ShellDialogSet"),
  ]);
}
