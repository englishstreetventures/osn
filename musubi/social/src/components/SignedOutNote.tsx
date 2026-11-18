import { clsx } from "@shared/ui/lib/utils";
import { Button } from "@shared/ui/ui/button";
import type { JSX } from "solid-js";

import { EmptyNote } from "./EmptyNote";
import { useShellDialogs } from "./ShellDialogs";

/**
 * A signed-out page's whole content: the page's line saying what signing in
 * gives, and a Sign in under it that opens the shell's sign-in dialog.
 *
 * The button is the shell's Sign in in the same look, `secondary`, so the
 * page never shows a second filled button beside the shell's Create account.
 *
 * Until the shell's dialogs have loaded the button is drawn invisible —
 * not painted, not focusable, out of the accessibility tree — so it never
 * offers a dialog that cannot open, and the note does not grow when they
 * land. If they never load, the space stays empty and the shell's frame says
 * to reload.
 */
export function SignedOutNote(props: { children: JSX.Element }) {
  const dialogs = useShellDialogs();
  return (
    <EmptyNote
      action={
        <Button
          variant="secondary"
          size="sm"
          // One class string, not `classList`: Button writes `class` itself,
          // and a rewrite of it would drop a `classList` entry.
          class={clsx("max-md:h-10", !dialogs.ready() && "invisible")}
          onClick={() => dialogs.open("sign-in")}
        >
          Sign in
        </Button>
      }
    >
      {props.children}
    </EmptyNote>
  );
}
