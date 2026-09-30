import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import {
  __resetGuestsCache,
  ensureGuestsLoaded,
  guestsAccessor,
  hasCachedGuests,
  invalidateGuests,
  type OrganiserGuestRow,
  setCachedGuests,
} from "../../src/lib/guests-store";
import { markHouseholdShared } from "../../src/lib/mark-shared";

/**
 * Telling the API a household's code went out, and keeping the cached guest
 * rows in step so Guests → Households shows "Sent" on its next mount without a
 * reload. The helper patches only a list that is loaded and fresh: a cold list
 * is left cold and a stale one is left for its refetch, so a patch never builds
 * a list from nothing or lands under a load that will overwrite it.
 */

const URL = "https://api.test/api/organiser/weddings/wed_1/families/fam_a/mark-shared";

function row(over: Partial<OrganiserGuestRow>): OrganiserGuestRow {
  return {
    guestId: "g",
    familyId: "fam_a",
    publicId: "CODE-A",
    familyName: "Sharma",
    firstName: "Ada",
    lastName: "Sharma",
    nickname: null,
    events: [],
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
    ...over,
  };
}

/** Two of fam_a's rows — the second a plus-one — and one of fam_b's. */
const ROWS = [
  row({ guestId: "g1" }),
  row({ guestId: "g2", firstName: "Guest", plusOneOf: "g1" }),
  row({ guestId: "g3", familyId: "fam_b", publicId: "CODE-B", familyName: "Jones" }),
];

function answer(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("markHouseholdShared", () => {
  afterEach(() => {
    __resetGuestsCache();
  });

  it("POSTs the household's mark-shared route and reports success", async () => {
    const authFetch = vi.fn(async () => answer({ familyId: "fam_a", codeSharedAt: 5 }));

    await expect(markHouseholdShared(authFetch, "wed_1", "fam_a")).resolves.toBe(true);
    expect(authFetch).toHaveBeenCalledWith(URL, { method: "POST" });
  });

  it("reports failure on a refused answer, and touches no cache", async () => {
    await ensureGuestsLoaded("wed_1", async () => ROWS);
    const authFetch = vi.fn(async () => answer({ error: "forbidden" }, 403));

    await expect(markHouseholdShared(authFetch, "wed_1", "fam_a")).resolves.toBe(false);
    expect(guestsAccessor("wed_1")()).toBe(ROWS);
    expect(hasCachedGuests("wed_1")).toBe(true);
  });

  it("never throws: a network failure reports failure", async () => {
    const authFetch = vi.fn(async () => {
      throw new TypeError("network down");
    });

    await expect(markHouseholdShared(authFetch, "wed_1", "fam_a")).resolves.toBe(false);
  });

  it("stamps the server's time on every row of the household in a fresh list", async () => {
    await ensureGuestsLoaded("wed_1", async () => ROWS);
    const authFetch = vi.fn(async () => answer({ familyId: "fam_a", codeSharedAt: 5 }));

    await markHouseholdShared(authFetch, "wed_1", "fam_a");

    const rows = guestsAccessor("wed_1")()!;
    expect(rows.map((r) => [r.guestId, r.codeSharedAt])).toEqual([
      ["g1", 5],
      ["g2", 5],
      ["g3", null],
    ]);
    // Another household's row keeps its object, so a keyed view keeps its DOM.
    expect(rows[2]).toBe(ROWS[2]);
    expect(hasCachedGuests("wed_1")).toBe(true);
  });

  it("reads the list after the POST answers, so a write made meanwhile survives", async () => {
    await ensureGuestsLoaded("wed_1", async () => ROWS);
    let settle: (res: Response) => void = () => {};
    const authFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );

    const marking = markHouseholdShared(authFetch, "wed_1", "fam_a");
    // A plus-one switch lands while the POST is in flight.
    setCachedGuests(
      "wed_1",
      ROWS.map((r) => (r.guestId === "g3" ? { ...r, plusOneAllowed: true } : r)),
    );
    settle(answer({ familyId: "fam_a", codeSharedAt: 5 }));
    await marking;

    const rows = guestsAccessor("wed_1")()!;
    expect(rows.find((r) => r.guestId === "g3")!.plusOneAllowed).toBe(true);
    expect(rows.find((r) => r.guestId === "g1")!.codeSharedAt).toBe(5);
  });

  it("leaves a cold list cold, and makes the next load ask the server", async () => {
    const authFetch = vi.fn(async () => answer({ familyId: "fam_a", codeSharedAt: 5 }));

    // Recorded by the server, so still a success for the caller.
    await expect(markHouseholdShared(authFetch, "wed_1", "fam_a")).resolves.toBe(true);

    expect(guestsAccessor("wed_1")()).toBeNull();
    const fetcher = vi.fn(async () => ROWS);
    await ensureGuestsLoaded("wed_1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not write into a stale list, and keeps it stale for its refetch", async () => {
    await ensureGuestsLoaded("wed_1", async () => ROWS);
    invalidateGuests("wed_1");
    const authFetch = vi.fn(async () => answer({ familyId: "fam_a", codeSharedAt: 5 }));

    await expect(markHouseholdShared(authFetch, "wed_1", "fam_a")).resolves.toBe(true);

    expect(guestsAccessor("wed_1")()).toBe(ROWS);
    expect(hasCachedGuests("wed_1")).toBe(false);
  });

  it("accepts an answer without a time, and still marks the household", async () => {
    await ensureGuestsLoaded("wed_1", async () => ROWS);
    const authFetch = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(markHouseholdShared(authFetch, "wed_1", "fam_a")).resolves.toBe(true);
    // Unreadable answer: the list is sent back to the server rather than guessed at.
    expect(hasCachedGuests("wed_1")).toBe(false);
  });
});
