import { createEffect, createSignal, onCleanup } from "solid-js";

import { rsvpDeadlineState, RSVP_SOON_WINDOW_DAYS, type RsvpDeadlineState } from "./rsvp-deadline";
import type { RsvpDeadline } from "./types";

/** setTimeout's delay is clamped to a signed 32-bit int (~24.8 days); a longer
 *  one fires immediately, which would flip the invite closed months early. */
const MAX_TIMEOUT_MS = 2_147_483_647;

const SOON_WINDOW_MS = RSVP_SOON_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Where the wedding's RSVP deadline stands, as a reactive accessor.
 *
 * The claim payload's `closed` flag is a snapshot — a guest can leave the
 * invite open across the deadline, and a stale "Respond" button that leads to a
 * server 403 is a worse experience than one that simply locks. So this waits
 * for the moment the state changes and re-derives it. Nothing polls; nothing
 * wakes a sleeping phone.
 *
 * The API remains the authority: every write is re-checked server-side.
 */
export function createRsvpDeadlineState(
  deadline: () => RsvpDeadline | null | undefined,
): () => RsvpDeadlineState | null {
  const [now, setNow] = createSignal(new Date());

  createEffect(() => {
    const current = deadline();
    // Reading the clock signal here is what chains the timers: each firing
    // re-runs this effect, which then waits for the NEXT boundary. One timer is
    // ever live, and both boundaries are reached even when only the first was
    // inside `setTimeout`'s range when the invite opened.
    const at = now();
    if (!current) return;
    const closesAt = Date.parse(current.closesAt);
    if (Number.isNaN(closesAt)) return;

    const nowMs = at.getTime();
    const soonAt = closesAt - SOON_WINDOW_MS;
    const next = nowMs < soonAt ? soonAt : closesAt;

    // Already past it (nothing to wait for), or so far off that no session will
    // still be open — either way, don't schedule.
    const delay = next - nowMs;
    if (delay <= 0 || delay > MAX_TIMEOUT_MS) return;

    // A second of slack so the re-read lands strictly after the boundary, not
    // on a timer that fired a tick early and would compute the state it just
    // left.
    const timer = setTimeout(() => setNow(new Date()), delay + 1000);
    onCleanup(() => clearTimeout(timer));
  });

  return () => rsvpDeadlineState(deadline(), now());
}
