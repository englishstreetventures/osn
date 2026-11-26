import { shells } from "../../src/App";

// The loads a shell waits for before it draws, for browser tests that wait
// for a shell to arrive, and the shell dialogs' chunk, for tests that wait for
// a signed-out shell's Sign in.
//
// `Reserved` in `src/App.tsx` draws the rail (`Sidebar`) or the phone top bar
// (`MobileChrome`) only once that shell's `load` in `shells` has resolved.
// These return the same `load`, so a test that awaits one after
// `render` resolves when the shell can draw, however long the dev server takes
// to transform the modules; a `waitFor` after it covers only the render that
// follows. A load added to a shell reaches these waits with no edit here.
//
// A shell draws its Sign in and Create account `invisible` until the shell
// dialogs have loaded, which the app starts through `ShellDialogsProvider`
// once the session has settled with none. A test cannot reach that load;
// `dialogChunk` is a plain import, whose specifier resolves to the URL the app
// imports, so the page still holds one copy of the module. Call these after
// `render`, or a test that watches a cold arrival starts the load itself. A
// chunk that fails to load rejects here, naming its module.

/** The rail's load: `Sidebar`. */
export function railChunks(): Promise<void> {
  return shells.rail.load();
}

/** The phone top bar's load: `MobileChrome`. */
export function topBarChunks(): Promise<void> {
  return shells.topBar.load();
}

/** The shell dialogs' chunk, which a signed-out shell's Sign in waits for. */
export function dialogChunk(): Promise<void> {
  return import("../../src/components/ShellDialogSet").then(() => undefined);
}
