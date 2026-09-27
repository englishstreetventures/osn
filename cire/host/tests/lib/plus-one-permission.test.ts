// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, apiUrl: (path: string) => `https://api.test${path}` };
});

import {
  householdPermission,
  isPlusOne,
  placePlusOnesAfterInviters,
  plusOnesRemovedBy,
  putPlusOnePermission,
  sameGuests,
  supportsPlusOnes,
  withPermission,
} from "../../src/lib/plus-one-permission";

/**
 * The portal's half of the plus-one permission. The helpers decide what the
 * table shows and what the confirmation names; the request decides which
 * answers the table treats as "a plus-one is named — ask first".
 */

interface Row {
  guestId: string;
  familyId: string;
  plusOneAllowed?: boolean;
  plusOneOf?: string | null;
}

const ada: Row = { guestId: "g_ada", familyId: "fam_a", plusOneAllowed: true, plusOneOf: null };
const bo: Row = { guestId: "g_bo", familyId: "fam_a", plusOneAllowed: true, plusOneOf: null };
const cy: Row = { guestId: "g_cy", familyId: "fam_a", plusOneAllowed: false, plusOneOf: null };
const sam: Row = { guestId: "g_sam", familyId: "fam_a", plusOneAllowed: false, plusOneOf: "g_ada" };
const kit: Row = { guestId: "g_kit", familyId: "fam_a", plusOneAllowed: false, plusOneOf: "g_bo" };
const dee: Row = { guestId: "g_dee", familyId: "fam_b", plusOneAllowed: true, plusOneOf: null };
const lou: Row = { guestId: "g_lou", familyId: "fam_b", plusOneAllowed: false, plusOneOf: "g_dee" };

const ROWS = [sam, ada, bo, cy, kit, dee, lou];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("isPlusOne", () => {
  it("is true only for a row that names who brought it", () => {
    expect(isPlusOne(sam)).toBe(true);
    expect(isPlusOne(ada)).toBe(false);
    expect(isPlusOne({ plusOneOf: undefined })).toBe(false);
  });
});

describe("supportsPlusOnes", () => {
  it("is true when the API sends the permission", () => {
    expect(supportsPlusOnes(ROWS)).toBe(true);
  });

  it("is false for rows from an API older than the columns", () => {
    expect(supportsPlusOnes([{}, {}])).toBe(false);
    expect(supportsPlusOnes([])).toBe(false);
  });
});

describe("placePlusOnesAfterInviters", () => {
  it("puts each plus-one straight after the guest who brought them", () => {
    const placed = placePlusOnesAfterInviters([sam, ada, bo, kit, cy]);
    expect(placed.map((r) => r.guestId)).toEqual(["g_ada", "g_sam", "g_bo", "g_kit", "g_cy"]);
  });

  it("keeps a plus-one whose inviter is not in the list where it was", () => {
    const placed = placePlusOnesAfterInviters([bo, sam, cy]);
    expect(placed.map((r) => r.guestId)).toEqual(["g_bo", "g_sam", "g_cy"]);
  });

  it("leaves a list with no plus-ones alone", () => {
    expect(placePlusOnesAfterInviters([cy, ada, bo])).toEqual([cy, ada, bo]);
  });
});

describe("householdPermission", () => {
  it("counts the household's own guests, never its plus-ones", () => {
    expect(householdPermission([sam, ada, bo, cy, kit])).toEqual({ allowed: 2, total: 3 });
    expect(householdPermission([dee, lou])).toEqual({ allowed: 1, total: 1 });
    expect(householdPermission([])).toEqual({ allowed: 0, total: 0 });
  });
});

describe("plusOnesRemovedBy", () => {
  it("names the one plus-one a guest brought", () => {
    expect(plusOnesRemovedBy(ROWS, { kind: "guest", guestId: "g_ada" })).toEqual([sam]);
    expect(plusOnesRemovedBy(ROWS, { kind: "guest", guestId: "g_cy" })).toEqual([]);
  });

  it("names every plus-one in a household, and none from another", () => {
    expect(plusOnesRemovedBy(ROWS, { kind: "household", familyId: "fam_a" })).toEqual([sam, kit]);
  });
});

describe("withPermission", () => {
  it("sets one guest's permission and leaves everyone else alone", () => {
    const next = withPermission(ROWS, { kind: "guest", guestId: "g_cy" }, true);
    expect(next.find((r) => r.guestId === "g_cy")?.plusOneAllowed).toBe(true);
    expect(next.filter((r) => r.guestId !== "g_cy")).toEqual(ROWS.filter((r) => r !== cy));
  });

  it("sets every household member's permission and never a plus-one's", () => {
    const next = withPermission(ROWS, { kind: "household", familyId: "fam_a" }, true);
    const byId = new Map(next.map((r) => [r.guestId, r]));
    expect(byId.get("g_cy")?.plusOneAllowed).toBe(true);
    expect(byId.get("g_sam")).toBe(sam);
    expect(byId.get("g_dee")).toBe(dee);
  });

  it("drops the guest's plus-one when permission goes off", () => {
    const next = withPermission(ROWS, { kind: "guest", guestId: "g_ada" }, false);
    expect(next.map((r) => r.guestId)).not.toContain("g_sam");
    expect(next.find((r) => r.guestId === "g_ada")?.plusOneAllowed).toBe(false);
    expect(next.map((r) => r.guestId)).toContain("g_kit");
  });

  it("drops every plus-one in the household when it goes off for all", () => {
    const next = withPermission(ROWS, { kind: "household", familyId: "fam_a" }, false);
    expect(next.map((r) => r.guestId)).toEqual(["g_ada", "g_bo", "g_cy", "g_dee", "g_lou"]);
    expect(next.filter((r) => r.familyId === "fam_a").every((r) => !r.plusOneAllowed)).toBe(true);
  });

  it("returns new rows and leaves the input untouched", () => {
    const before = structuredClone(ROWS);
    withPermission(ROWS, { kind: "household", familyId: "fam_a" }, false);
    expect(ROWS).toEqual(before);
  });
});

describe("sameGuests", () => {
  it("compares by id in any order", () => {
    expect(sameGuests([sam, kit], [kit, sam])).toBe(true);
    expect(sameGuests([sam], [kit])).toBe(false);
    expect(sameGuests([sam], [sam, kit])).toBe(false);
    expect(sameGuests([], [])).toBe(true);
  });
});

describe("putPlusOnePermission", () => {
  const call = (authFetch: ReturnType<typeof vi.fn>) => {
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    return { url, method: init.method, body: JSON.parse(String(init.body)) as unknown };
  };

  it("PUTs a guest's permission without the remove flag unless asked", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(json({ guestId: "g_cy", plusOneAllowed: true, plusOneRemoved: false }));
    const answer = await putPlusOnePermission(
      authFetch,
      "wed_1",
      { kind: "guest", guestId: "g_cy" },
      true,
      false,
    );
    expect(answer).toEqual({ kind: "saved", removed: 0 });
    expect(call(authFetch)).toEqual({
      url: "https://api.test/api/organiser/weddings/wed_1/guests/g_cy/plus-one",
      method: "PUT",
      body: { allowed: true },
    });
  });

  it("sends `removePlusOne` for a guest only when told to, and counts the removal", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(json({ guestId: "g_ada", plusOneAllowed: false, plusOneRemoved: true }));
    const answer = await putPlusOnePermission(
      authFetch,
      "wed_1",
      { kind: "guest", guestId: "g_ada" },
      false,
      true,
    );
    expect(answer).toEqual({ kind: "saved", removed: 1 });
    expect(call(authFetch).body).toEqual({ allowed: false, removePlusOne: true });
  });

  it("uses the household route and its `removePlusOnes` flag", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(
        json({ familyId: "fam_a", plusOneAllowed: false, guestsUpdated: 3, plusOnesRemoved: 2 }),
      );
    const answer = await putPlusOnePermission(
      authFetch,
      "wed_1",
      { kind: "household", familyId: "fam_a" },
      false,
      true,
    );
    expect(answer).toEqual({ kind: "saved", removed: 2 });
    expect(call(authFetch)).toEqual({
      url: "https://api.test/api/organiser/weddings/wed_1/families/fam_a/plus-one",
      method: "PUT",
      body: { allowed: false, removePlusOnes: true },
    });
  });

  it("reads `plus_one_named` as 'ask first', with the count", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ error: "plus_one_named", named: 2 }, 409));
    const answer = await putPlusOnePermission(
      authFetch,
      "wed_1",
      { kind: "household", familyId: "fam_a" },
      false,
      false,
    );
    expect(answer).toEqual({ kind: "named", named: 2 });
  });

  it("does not read the other 409, `plus_one_cannot_invite`, as a named plus-one", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ error: "plus_one_cannot_invite" }, 409));
    const answer = await putPlusOnePermission(
      authFetch,
      "wed_1",
      { kind: "guest", guestId: "g_sam" },
      true,
      false,
    );
    expect(answer).toEqual({ kind: "refused", status: 409, error: "plus_one_cannot_invite" });
  });

  it("reports a viewer's refusal and a missing guest with their codes", async () => {
    const readOnly = vi.fn().mockResolvedValue(json({ error: "read_only_role" }, 403));
    expect(
      await putPlusOnePermission(readOnly, "w", { kind: "guest", guestId: "g" }, true, false),
    ).toEqual({ kind: "refused", status: 403, error: "read_only_role" });

    const gone = vi.fn().mockResolvedValue(json({ error: "guest_not_found" }, 404));
    expect(
      await putPlusOnePermission(gone, "w", { kind: "guest", guestId: "g" }, true, false),
    ).toEqual({ kind: "refused", status: 404, error: "guest_not_found" });
  });

  it("reads a 401 as a lost session and a body that is not JSON as no code", async () => {
    const expired = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    expect(
      await putPlusOnePermission(expired, "w", { kind: "guest", guestId: "g" }, true, false),
    ).toEqual({ kind: "unauthenticated" });

    const broken = vi.fn().mockResolvedValue(new Response("<html>", { status: 502 }));
    expect(
      await putPlusOnePermission(broken, "w", { kind: "guest", guestId: "g" }, true, false),
    ).toEqual({ kind: "refused", status: 502, error: null });
  });

  it("encodes the ids into the path", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({}));
    await putPlusOnePermission(authFetch, "w/1", { kind: "guest", guestId: "a b" }, true, false);
    expect(call(authFetch).url).toBe(
      "https://api.test/api/organiser/weddings/w%2F1/guests/a%20b/plus-one",
    );
  });
});
