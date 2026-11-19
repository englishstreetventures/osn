import Button from "@cire/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { Show } from "solid-js";

import { guestDataBoundWords } from "../lib/guest-data-bound";
import { surfacesFor } from "../lib/wedding-roles";
import type { WeddingRole } from "../lib/wedding-roles";
import type { GuestDataBound } from "./CreateWeddingForm";

/**
 * The warning over a wedding's dashboard when Cire is close to deleting its
 * guest list three years after it was created, or already is: a `warn` notice
 * from 90 days before, a `danger` one after (`cire/host/DESIGN.md` §7, "A
 * wedding's guest list close to its three years").
 *
 * Only a seat that can set the events' dates sees it. The API sends the bound
 * to owners and editors alone; this holds the same line for a role that
 * changed in this tab since the list was read.
 *
 * A standing note when it was there as the host arrived; `announce` makes it
 * an alert, for one that appears or changes in answer to a save. Its sentence
 * breaks anywhere, since an event's name can be one long word.
 */
export default function GuestDataBoundNotice(props: {
  bound: GuestDataBound;
  callerRole: WeddingRole;
  /** It appeared, or changed state, after the dashboard first painted. */
  announce?: boolean;
  /** Open the events editor, where the dates are set. */
  onFix: () => void;
}) {
  const words = () =>
    surfacesFor(props.callerRole).canEdit ? guestDataBoundWords(props.bound) : null;
  return (
    <Show when={words()}>
      {(w) => (
        <Notice
          tone={w().tone}
          alert={props.announce}
          class="max-w-prose"
          data-testid="guest-data-bound"
        >
          <div class="flex flex-col gap-3">
            <p class="font-medium">{w().headline}</p>
            <p class="wrap-anywhere">{w().detail}</p>
            <div>
              <Button variant="outline" size="sm" onClick={() => props.onFix()}>
                {w().action}
              </Button>
            </div>
          </div>
        </Notice>
      )}
    </Show>
  );
}
