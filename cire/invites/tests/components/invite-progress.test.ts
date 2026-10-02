import { describe, expect, it } from "vitest";

import { inviteProgress } from "../../src/components/invite-progress";
import type { FamilyMember, RsvpSummary } from "../../src/components/types";

type Member = Pick<FamilyMember, "guestId" | "eventIds" | "plusOneOf">;
type Row = Pick<RsvpSummary, "guestId" | "eventId" | "status">;

const ana: Member = { guestId: "g-ana", eventIds: ["ceremony", "party"], plusOneOf: null };
const ben: Member = { guestId: "g-ben", eventIds: ["ceremony"], plusOneOf: null };
// Ana's guest, invited to Ana's events.
const guest: Member = { guestId: "g-guest", eventIds: ["ceremony", "party"], plusOneOf: "g-ana" };

function row(guestId: string, eventId: string, status: Row["status"] = "attending"): Row {
  return { guestId, eventId, status };
}

describe("inviteProgress", () => {
  it("is not-started when the household has no replies on file", () => {
    expect(inviteProgress([ana, ben], [])).toBe("not-started");
  });

  it("is partial when some invited (member, event) pairs are answered and some are not", () => {
    expect(inviteProgress([ana, ben], [row("g-ana", "ceremony")])).toBe("partial");
    expect(inviteProgress([ana, ben], [row("g-ana", "ceremony"), row("g-ana", "party")])).toBe(
      "partial",
    );
  });

  it("is complete when every invited member has answered every event they are invited to", () => {
    expect(
      inviteProgress(
        [ana, ben],
        [row("g-ana", "ceremony"), row("g-ana", "party"), row("g-ben", "ceremony")],
      ),
    ).toBe("complete");
  });

  it("counts a decline and a maybe as answers — each is a reply on file", () => {
    expect(
      inviteProgress(
        [ana, ben],
        [
          row("g-ana", "ceremony", "declined"),
          row("g-ana", "party", "maybe"),
          row("g-ben", "ceremony", "declined"),
        ],
      ),
    ).toBe("complete");
  });

  it("does not wait for a plus-one, as the tick on each event does not", () => {
    // Same rule as `hasHouseholdResponded`: once every card shows its tick, the
    // panel must not say replies are still owed.
    expect(
      inviteProgress(
        [ana, guest, ben],
        [row("g-ana", "ceremony"), row("g-ana", "party"), row("g-ben", "ceremony")],
      ),
    ).toBe("complete");
  });

  it("treats a household that saved only its plus-one's reply as started, with replies owed", () => {
    // A save may cover any subset of the household. The plus-one's row is a
    // reply this household gave, so it is not a first visit; nobody the couple
    // invited has answered yet, so it is not complete either.
    expect(inviteProgress([ana, guest, ben], [row("g-guest", "ceremony")])).toBe("partial");
  });

  it("treats a reply to an event the household is no longer invited to as started", () => {
    // The API sends every row the household has on file, whatever its current
    // invitations. The household replied before, so this is not a first visit,
    // and the current invitations are still unanswered.
    expect(inviteProgress([ana, ben], [row("g-ana", "brunch")])).toBe("partial");
  });

  it("is complete for a household with replies on file and nothing currently owed", () => {
    const uninvited: Member = { guestId: "g-ana", eventIds: [], plusOneOf: null };
    expect(inviteProgress([uninvited], [row("g-ana", "brunch")])).toBe("complete");
  });

  it("is not-started for a household with nothing owed and nothing on file", () => {
    const uninvited: Member = { guestId: "g-ana", eventIds: [], plusOneOf: null };
    expect(inviteProgress([uninvited], [])).toBe("not-started");
  });

  it("reads an older API's member, with no plusOneOf, as invited", () => {
    const older = { guestId: "g-ana", eventIds: ["ceremony"] };
    expect(inviteProgress([older], [row("g-ana", "ceremony")])).toBe("complete");
  });
});
