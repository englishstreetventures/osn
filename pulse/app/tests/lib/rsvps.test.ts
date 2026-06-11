// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchCommsSummary,
  fetchLatestRsvps,
  fetchRsvpCounts,
  fetchRsvpsByStatus,
  recordShareExposure,
  recordShareInvoked,
  updateMySettings,
  upsertMyRsvp,
} from "../../src/lib/rsvps";

// Helper: build a Response-shaped stub for `fetch` to return.
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Captures the most recent fetch call so each test can assert on URL/headers.
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── fetchLatestRsvps ─────────────────────────────────────────────────────────

describe("fetchLatestRsvps", () => {
  it("returns the rsvps array on 200", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { rsvps: [{ id: "rsvp_1", profileId: "usr_bob", profile: null }] }),
    );
    const result = await fetchLatestRsvps("evt_1", null);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("rsvp_1");
  });

  it("returns an empty array on non-200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    const result = await fetchLatestRsvps("evt_1", null);
    expect(result).toEqual([]);
  });

  it("attaches the Authorization header when a token is provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rsvps: [] }));
    await fetchLatestRsvps("evt_1", "abc.def.ghi");
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer abc.def.ghi");
  });

  it("omits the Authorization header when token is null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rsvps: [] }));
    await fetchLatestRsvps("evt_1", null);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("uses the requested limit in the query string", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rsvps: [] }));
    await fetchLatestRsvps("evt_1", null, 3);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("limit=3");
  });
});

// ── fetchRsvpsByStatus ───────────────────────────────────────────────────────

describe("fetchRsvpsByStatus", () => {
  it("hits the rsvps endpoint with the status query param", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rsvps: [] }));
    await fetchRsvpsByStatus("evt_1", "going", null);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/events/evt_1/rsvps?status=going");
    expect(String(url)).toContain("limit=200");
  });

  it("returns [] on non-200 instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: "not found" }));
    const result = await fetchRsvpsByStatus("evt_1", "going", null);
    expect(result).toEqual([]);
  });
});

// ── fetchRsvpCounts ──────────────────────────────────────────────────────────

describe("fetchRsvpCounts", () => {
  it("returns the counts object on 200", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { counts: { going: 4, maybe: 2, not_going: 1, invited: 0 } }),
    );
    const counts = await fetchRsvpCounts("evt_1");
    expect(counts.going).toBe(4);
    expect(counts.maybe).toBe(2);
  });

  it("returns zeros on non-200 (graceful UI fallback)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    const counts = await fetchRsvpCounts("evt_1");
    expect(counts).toEqual({ going: 0, maybe: 0, not_going: 0, invited: 0 });
  });

  it("returns zeros when the response body lacks a counts field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const counts = await fetchRsvpCounts("evt_1");
    expect(counts.going).toBe(0);
  });
});

// ── upsertMyRsvp ─────────────────────────────────────────────────────────────

describe("upsertMyRsvp", () => {
  it("returns { ok: true } on success and POSTs the status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rsvp: { id: "rsvp_1" } }));
    const result = await upsertMyRsvp("evt_1", "going", "tok");
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/events/evt_1/rsvps");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ status: "going" });
  });

  it("extracts body.message on failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { message: "Invitation required" }));
    const result = await upsertMyRsvp("evt_1", "going", "tok");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invitation required");
  });

  it("falls back to body.error when message is missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { error: "bad status" }));
    const result = await upsertMyRsvp("evt_1", "going", "tok");
    expect(result.error).toBe("bad status");
  });

  it("falls back to HTTP <status> when both message and error are missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const result = await upsertMyRsvp("evt_1", "going", "tok");
    expect(result.error).toBe("HTTP 500");
  });

  it("survives a JSON-parse error in the failure body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("not json at all", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const result = await upsertMyRsvp("evt_1", "going", "tok");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("HTTP 502");
  });

  it("forwards shareSource on the request body when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rsvp: { id: "rsvp_1" } }));
    await upsertMyRsvp("evt_1", "going", "tok", "tiktok");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      status: "going",
      shareSource: "tiktok",
    });
  });

  it("omits shareSource from the body when null is passed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rsvp: { id: "rsvp_1" } }));
    await upsertMyRsvp("evt_1", "going", "tok", null);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ status: "going" });
    expect("shareSource" in body).toBe(false);
  });
});

// ── recordShareInvoked ───────────────────────────────────────────────────────

describe("recordShareInvoked", () => {
  it("POSTs the source to /events/:id/share with keepalive and no auth header when token is null", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await recordShareInvoked("evt_1", "instagram", null);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/events/evt_1/share");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).keepalive).toBe(true);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ source: "instagram" });
    expect((init as RequestInit).headers).not.toMatchObject({ Authorization: expect.anything() });
  });

  it("attaches the bearer token when one is provided (organiser private-event share)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await recordShareInvoked("evt_1", "instagram", "tok");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("swallows fetch failures so the share UX doesn't break", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(recordShareInvoked("evt_1", "facebook", null)).resolves.toBeUndefined();
  });
});

// ── recordShareExposure ──────────────────────────────────────────────────────

describe("recordShareExposure", () => {
  it("POSTs the source to /events/:id/exposure with no auth header when token is null", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await recordShareExposure("evt_1", "x", null);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/events/evt_1/exposure");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).keepalive).toBe(true);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ source: "x" });
    expect((init as RequestInit).headers).not.toMatchObject({ Authorization: expect.anything() });
  });

  it("attaches the bearer token when one is provided", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await recordShareExposure("evt_1", "whatsapp", "tok");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("swallows fetch failures silently", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(recordShareExposure("evt_1", "copy_link", null)).resolves.toBeUndefined();
  });
});

// ── updateMySettings ─────────────────────────────────────────────────────────

describe("updateMySettings", () => {
  it("PATCHes /me/settings with the JSON body and bearer token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { settings: { profileId: "usr_alice", attendanceVisibility: "no_one" } }),
    );
    const result = await updateMySettings({ attendanceVisibility: "no_one" }, "tok");
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/me/settings");
    expect((init as RequestInit).method).toBe("PATCH");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      attendanceVisibility: "no_one",
    });
  });

  it("returns { ok: false, error } on 401", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: "Unauthorized" }));
    const result = await updateMySettings({ attendanceVisibility: "no_one" }, "tok");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unauthorized");
  });
});

// ── fetchCommsSummary ────────────────────────────────────────────────────────

describe("fetchCommsSummary", () => {
  it("returns the summary on 200", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { channels: ["email"], blasts: [{ id: "evtcomm_1", body: "hi" }] }),
    );
    const result = await fetchCommsSummary("evt_1");
    expect(result?.channels).toEqual(["email"]);
    expect(result?.blasts).toHaveLength(1);
  });

  it("returns null on non-200 (avoids surfacing comms info on missing events)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: "not found" }));
    const result = await fetchCommsSummary("evt_missing");
    expect(result).toBeNull();
  });
});
