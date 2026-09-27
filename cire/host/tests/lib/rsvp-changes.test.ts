import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import {
  describeChangeKinds,
  fetchRsvpChanges,
  formatChangeTime,
  markRsvpChangesSeen,
  newRowCheck,
  setRsvpDigest,
} from "../../src/lib/rsvp-changes";

const CHANGES = {
  markSeq: 7,
  households: 1,
  truncated: false,
  items: [
    { familyId: "f1", familyName: "Sharma", kinds: ["reply_new"], at: "2026-09-26T08:00:00.000Z" },
  ],
  rows: [{ guestId: "g1", eventId: "e1" }],
  digest: { available: true, enabled: true },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("describeChangeKinds", () => {
  it("words each kind in the order given", () => {
    expect(describeChangeKinds(["reply_new", "plus_one_added"])).toBe("replied, added a plus-one");
    expect(describeChangeKinds(["reply_edited"])).toBe("changed their reply");
  });

  it("skips a kind this build does not know", () => {
    expect(describeChangeKinds(["reply_new", "something_later"])).toBe("replied");
  });
});

describe("newRowCheck", () => {
  it("matches a changed pair, and every row of a guest whose change has no event", () => {
    const isNew = newRowCheck([
      { guestId: "g1", eventId: "e1" },
      { guestId: "g2", eventId: null },
    ]);
    expect(isNew("g1", "e1")).toBe(true);
    expect(isNew("g1", "e2")).toBe(false);
    expect(isNew("g2", "e1")).toBe(true);
    expect(isNew("g2", "e9")).toBe(true);
    expect(isNew("g3", "e1")).toBe(false);
  });
});

describe("formatChangeTime", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");

  it("reads recent changes in minutes and hours", () => {
    expect(formatChangeTime("2026-09-27T11:59:40Z", now)).toBe("just now");
    expect(formatChangeTime("2026-09-27T11:45:00Z", now)).toBe("15 min ago");
    expect(formatChangeTime("2026-09-27T09:00:00Z", now)).toBe("3 h ago");
  });

  it("reads older changes in days, and an unreadable time as nothing", () => {
    expect(formatChangeTime("2026-09-25T12:00:00Z", now)).toBe("2 days ago");
    expect(formatChangeTime("2026-09-26T11:00:00Z", now)).toBe("1 day ago");
    expect(formatChangeTime("nonsense", now)).toBe("");
  });
});

describe("fetchRsvpChanges", () => {
  const authFetch = vi.fn();
  afterEach(() => authFetch.mockReset());

  it("returns the feed for a good answer", async () => {
    authFetch.mockResolvedValueOnce(json(CHANGES));
    expect(await fetchRsvpChanges(authFetch, "wed_a")).toEqual(CHANGES);
    expect(authFetch).toHaveBeenCalledWith(
      "https://api.test/api/organiser/weddings/wed_a/rsvp-changes",
    );
  });

  it("returns null for an error status, a thrown fetch, or a body of the wrong shape", async () => {
    authFetch.mockResolvedValueOnce(json({ error: "forbidden" }, 403));
    expect(await fetchRsvpChanges(authFetch, "wed_a")).toBeNull();
    authFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchRsvpChanges(authFetch, "wed_a")).toBeNull();
    for (const body of [{}, [], { ...CHANGES, rows: "x" }, { ...CHANGES, digest: null }]) {
      authFetch.mockResolvedValueOnce(json(body));
      expect(await fetchRsvpChanges(authFetch, "wed_a")).toBeNull();
    }
  });
});

describe("markRsvpChangesSeen / setRsvpDigest", () => {
  const authFetch = vi.fn();
  afterEach(() => authFetch.mockReset());

  it("posts the seen marker and never throws", async () => {
    authFetch.mockResolvedValueOnce(json({ seenSeq: 7 }));
    await markRsvpChangesSeen(authFetch, "wed_a", 7);
    const [url, init] = authFetch.mock.calls[0]!;
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_a/rsvp-changes/seen");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ seq: 7 }) });
    authFetch.mockRejectedValueOnce(new Error("offline"));
    await expect(markRsvpChangesSeen(authFetch, "wed_a", 7)).resolves.toBeUndefined();
  });

  it("puts the digest switch and says whether it was saved", async () => {
    authFetch.mockResolvedValueOnce(json({ enabled: false }));
    expect(await setRsvpDigest(authFetch, "wed_a", false)).toBe(true);
    const [url, init] = authFetch.mock.calls[0]!;
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_a/rsvp-changes/digest");
    expect(init).toMatchObject({ method: "PUT", body: JSON.stringify({ enabled: false }) });
    authFetch.mockResolvedValueOnce(json({ error: "read_only_role" }, 403));
    expect(await setRsvpDigest(authFetch, "wed_a", false)).toBe(false);
    authFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await setRsvpDigest(authFetch, "wed_a", true)).toBe(false);
  });
});
