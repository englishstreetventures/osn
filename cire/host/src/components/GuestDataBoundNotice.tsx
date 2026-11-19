import Button from "@cire/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { createMemo, onMount, Show } from "solid-js";

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

/** The bound on screen, whether it is leaving, and the key it is mounted under. */
interface Shown {
  bound: GuestDataBound;
  leaving: boolean;
  key: string;
}

/**
 * The warning as the dashboard holds it, over every module.
 *
 * Keyed on its arrival, state and reason, so a bound that appears, or changes
 * state, mounts afresh. One there when the dashboard first paints is a standing
 * note; one that mounts after that does so in answer to a save the host made
 * with focus in the editor below it, so it is announced.
 *
 * When a save clears the bound, the last one stays mounted while it leaves:
 * the wrapper takes `hidden` and `inert`, and `bound-leave` shrinks and fades
 * it (the owner's choice for this banner, `cire/host/DESIGN.md` §A wedding's
 * guest list close to its three years), at once under reduced motion.
 *
 * `main` sets its children 32px apart (`gap-8`). The banner holds that space
 * as its own padding, inside the part that shrinks, and hands the gap back
 * with `-mb-8`, so the space closes with the banner rather than after it.
 */
export function GuestDataBoundBanner(props: {
  bound?: GuestDataBound;
  callerRole: WeddingRole;
  /** Open the events editor, where the dates are set. */
  onFix: () => void;
}) {
  let painted = false;
  onMount(() => {
    painted = true;
  });
  let arrivals = 0;
  const shown = createMemo<Shown | undefined>((prev) => {
    const bound = props.bound;
    if (!bound) return prev && { ...prev, leaving: true };
    if (!prev || prev.leaving) arrivals += 1;
    return { bound, leaving: false, key: `${arrivals}:${bound.state}:${bound.reason}` };
  });
  const key = () => (surfacesFor(props.callerRole).canEdit ? shown()?.key : undefined);
  return (
    <Show when={key()} keyed>
      {(_key) => {
        const announce = painted;
        return (
          <div class="bound-leave -mb-8" hidden={shown()?.leaving} inert={shown()?.leaving}>
            <div class="min-h-0 overflow-hidden">
              <div class="pb-8">
                <GuestDataBoundNotice
                  bound={shown()!.bound}
                  callerRole={props.callerRole}
                  announce={announce}
                  onFix={props.onFix}
                />
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
