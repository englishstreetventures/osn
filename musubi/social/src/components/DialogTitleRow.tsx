import { DialogHeader, DialogTitle } from "@shared/ui/ui/dialog";
import type { JSX } from "solid-js";

/**
 * A dialog's header: its title alone, centred, over the header's hairline.
 * Every app dialog opens with one; a dialog's Cancel sits in its footer,
 * first, beside the commit (DESIGN.md §Responsive layout, Dialogs).
 *
 * The classes match `@osn/auth-ui`'s `AuthHeader` in a dialog, so the
 * sign-in, step-up and app dialogs read alike. The title breaks anywhere,
 * so a long handle in it never widens the sheet, and a title that wraps
 * balances its centred lines.
 */
export function DialogTitleRow(props: { children: JSX.Element }) {
  return (
    <DialogHeader class="justify-center">
      <DialogTitle class="text-center">
        <span class="block text-balance wrap-anywhere">{props.children}</span>
      </DialogTitle>
    </DialogHeader>
  );
}
