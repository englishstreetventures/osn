import type { FamilyMember } from "./types";

// Plus-ones on the invite: who is one. Read on every invite page — the
// greeting, completeness and the account link ask it — so this module stays
// small; what only the plus-one prompt needs is in `plus-one-updates.ts`,
// which loads with the prompt.

/** Whether this member is someone a guest brought, rather than one the couple
 *  invited. An API that predates the field sends no `plusOneOf`: an ordinary
 *  member. */
export function isPlusOne(member: Pick<FamilyMember, "plusOneOf">): boolean {
  return typeof member.plusOneOf === "string";
}

/** The household as the couple invited it — plus-ones left out. What the
 *  greeting names, what completeness counts, and whose seat can be linked. */
export function invitedMembers<T extends Pick<FamilyMember, "plusOneOf">>(
  members: readonly T[],
): T[] {
  return members.filter((m) => !isPlusOne(m));
}
