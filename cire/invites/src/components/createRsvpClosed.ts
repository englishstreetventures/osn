import { createEffect, createSignal, onCleanup } from "solid-js";

import { isRsvpClosed } from "./rsvp-deadline";
import type { RsvpDeadline } from "./types";

/** setTimeout's delay is clamped to a signed 32-bit int (~24.8 days); a longer
 *  one fires immediately, which would flip the invite closed months early. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Whether the wedding's RSVP deadline has passed, as a reactive accessor.
 *
 * The claim payload's `closed` flag is a snapshot — a guest can leave the invite
 * open across the deadline, and a stale "Respond" button that leads to a server
 * 403 is a worse experience than one that simply locks. So this schedules a
 * single re-read at the moment the door shuts (nothing polls, nothing wakes a
 * sleeping phone) and re-derives the verdict from `closesAt`.
 *
 * The API remains the authority: every write is re-checked server-side.
 */
export function createRsvpClosed(deadline: () => RsvpDeadline | null | undefined): () => boolean {
  const [now, setNow] = createSignal(new Date());

  createEffect(() => {
    const current = deadline();
    if (!current) return;
    const closesAt = Date.parse(current.closesAt);
    if (Number.isNaN(closesAt)) return;

    // Already shut (nothing to wait for), or so far off that no session will
    // still be open — either way, don't schedule.
    const delay = closesAt - Date.now();
    if (delay <= 0 || delay > MAX_TIMEOUT_MS) return;

    // A second of slack so the re-read lands strictly after the instant, not on
    // a timer that fired a tick early.
    const timer = setTimeout(() => setNow(new Date()), delay + 1000);
    onCleanup(() => clearTimeout(timer));
  });

  return () => isRsvpClosed(deadline(), now());
}
