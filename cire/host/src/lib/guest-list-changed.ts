// What this tab drops when it changes the guest list itself. Frontend code: no
// Effect.
import { invalidateRsvps } from "./rsvps-store";

/**
 * A change this tab applied or reverted moved what the RSVP replies hold: a
 * household, a guest, who is invited to what, an event's name or a claim code.
 * The replies read again when next shown, and a read in flight is dropped.
 * Called beside the guest, event and household caches' own invalidations, once
 * the change has committed.
 */
export function guestListChanged(weddingId: string): void {
  invalidateRsvps(weddingId);
}
