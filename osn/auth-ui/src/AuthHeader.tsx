import { Button } from "@shared/ui/ui/button";
// Imported for the dialog host alone, so the page host pays for it too: in
// Musubi, `/authorize`'s sign-in chunk loads the dialog module (6.80 kB, 2.39
// kB gzipped, from `vite build`) it never runs. Kept over a header split in two,
// which would make the dialog host hand its header to `SignIn` and `Register`.
import { DialogHeader, DialogTitle } from "@shared/ui/ui/dialog";
import { Show } from "solid-js";

interface Titled {
  /**
   * The view's title, such as "Sign in to Musubi". A view whose title changes
   * (`SignIn`'s "Recover your account") passes the new one here; it never
   * mounts a second header.
   */
  title: string;
}

/**
 * Inside `@shared/ui`'s `Dialog`. The title is the dialog's `DialogTitle`,
 * centred in a `DialogHeader`, so the dialog takes its name from it. Throws
 * outside a `Dialog`. A dialog holds one of these at a time: every
 * `DialogTitle` in one dialog gets the same id, so two at once share it, and
 * when either goes the dialog is left with no name.
 *
 * It draws no Cancel: a dialog's Cancel sits in its footer, first, beside the
 * step's own action (`ViewStep`).
 */
export interface DialogHostHeader extends Titled {
  host: "dialog";
}

/**
 * On a page, such as `/authorize`. The title is a plain `h2` in the dialog
 * title's type, and the row draws no padding or rule, so the page's own
 * heading above it leads. Cancel, when the page gives one, sits at the row's
 * end, since a page has no footer.
 */
export interface PageHostHeader extends Titled {
  host: "page";
  /** Called by Cancel. Absent: no Cancel. */
  onCancel?: () => void;
  /**
   * Cancel's words, for a page where going back means something else ("Sign
   * in instead"). Absent or blank: "Cancel", so the button always has a name.
   */
  cancelLabel?: string;
  /** True while a call the view started runs, so nothing leaves the view meanwhile. */
  cancelDisabled?: boolean;
}

/** What the view is mounted in. Required: neither can stand in for the other. */
export type AuthHeaderProps = DialogHostHeader | PageHostHeader;

/**
 * The title row of a sign-in or create-account view, and of every dialog the
 * package draws. Cancel, on a page, calls `onCancel` and closes nothing itself.
 */
export function AuthHeader(props: AuthHeaderProps) {
  return (
    <Show
      when={props.host === "page" ? (props as PageHostHeader) : undefined}
      fallback={
        <DialogHeader class="justify-center">
          {/* The host's product name, or a passkey's 64-character name, sits
              in the title, so it breaks anywhere rather than widen the sheet. */}
          <DialogTitle class="text-center">
            <span class="wrap-anywhere">{props.title}</span>
          </DialogTitle>
        </DialogHeader>
      }
    >
      {(page) => (
        <div class="flex items-center justify-between gap-3">
          {/* DialogTitle's own type (`shared/ui/src/ui/dialog.tsx`), so the
              title reads the same in both hosts. Musubi's
              `AuthHeader.browser.test.tsx` fails when the two differ. */}
          <h2 class="text-ui-ink text-ui-md font-ui-title wrap-anywhere">{page().title}</h2>
          <Show when={page().onCancel}>
            {(onCancel) => (
              <Button
                type="button"
                // On a page Cancel switches views rather than dismissing
                // anything, so it is `ghost`.
                variant="ghost"
                size="sm"
                class="shrink-0 max-md:h-10"
                disabled={page().cancelDisabled}
                onClick={() => onCancel()()}
              >
                {page().cancelLabel?.trim() || "Cancel"}
              </Button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
