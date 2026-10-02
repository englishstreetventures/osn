import { invitedMembers } from "./plus-one";
import type { FamilyMember, RsvpSummary } from "./types";

/**
 * How far a household has got with its replies.
 *
 * - `not-started` — no reply on file at all.
 * - `partial` — some replies on file, but an invited member still owes one
 *   for an event they are invited to.
 * - `complete` — every invited member has a reply on file for every event
 *   they are invited to.
 */
export type InviteProgress = "not-started" | "partial" | "complete";

/**
 * Where this household stands with its replies, from the reply rows alone.
 * Every row counts, whoever wrote it: a reply an organiser recorded by phone
 * answers the event as surely as the household's own, as the tick on each
 * event card says. Whether the household is greeted as returning is a
 * different question, which only the server can answer (`householdReplied`
 * on the claim payload); this one decides whether replies are still owed.
 *
 * `not-started` means no row on file at all, whichever member and event it
 * names: a save that covered only a plus-one, or a reply to an event the
 * household has since been taken off, is still a reply on file.
 *
 * Between `partial` and `complete`, only the people the couple invited count,
 * and only for the events they are invited to now. A plus-one's reply is not
 * waited for — the rule `hasHouseholdResponded` uses for the tick on each
 * event, so a household whose every event shows a tick is `complete` here too.
 * Any status counts as an answer, a "maybe" included.
 */
export function inviteProgress(
  members: ReadonlyArray<Pick<FamilyMember, "guestId" | "eventIds" | "plusOneOf">>,
  rsvps: ReadonlyArray<Pick<RsvpSummary, "guestId" | "eventId">>,
): InviteProgress {
  if (rsvps.length === 0) return "not-started";
  const answered = new Set(rsvps.map((r) => `${r.guestId}\u0000${r.eventId}`));
  const owesReply = invitedMembers(members).some((m) =>
    m.eventIds.some((eventId) => !answered.has(`${m.guestId}\u0000${eventId}`)),
  );
  return owesReply ? "partial" : "complete";
}
