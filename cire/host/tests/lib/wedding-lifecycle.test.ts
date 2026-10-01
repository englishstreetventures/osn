import type { AuthFetch } from "@shared/rp-auth";
import { describe, expect, it } from "vitest";

import {
  deletedWeddingsOf,
  deleteWedding,
  restoreUntilLabel,
  restoreWedding,
} from "../../src/lib/wedding-lifecycle";

/** An `authFetch` that answers every request with `res`. */
const answering = (res: Response): AuthFetch => (async () => res) as unknown as AuthFetch;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("deletedWeddingsOf", () => {
  it("reads the list body's restorable weddings, and nothing from a body without them", () => {
    const deleted = [
      {
        id: "wed_a",
        slug: "a",
        displayName: "A",
        deletedAt: "2026-10-01T00:00:00.000Z",
        restoreUntil: "2026-10-08T00:00:00.000Z",
      },
    ];
    expect(deletedWeddingsOf({ weddings: [], deleted })).toEqual(deleted);
    expect(deletedWeddingsOf({ weddings: [] })).toEqual([]);
    expect(deletedWeddingsOf({ deleted: "nope" })).toEqual([]);
    expect(deletedWeddingsOf(null)).toEqual([]);
  });
});

describe("restoreUntilLabel", () => {
  it("names the day, and nothing for a date it cannot read", () => {
    expect(restoreUntilLabel("2026-10-08T00:00:00.000Z")).toMatch(/October 2026/);
    expect(restoreUntilLabel("not a date")).toBe("");
  });
});

describe("restoreWedding", () => {
  it("drops a wedding the purge has already taken (404 wedding_not_found)", async () => {
    const out = await restoreWedding(answering(json({ error: "wedding_not_found" }, 404)), "wed_a");
    expect(out).toEqual({
      ok: false,
      gone: true,
      message: expect.stringMatching(/deleted for good/),
    });
  });

  it("drops a wedding whose window has closed", async () => {
    const out = await restoreWedding(
      answering(json({ error: "restore_window_passed" }, 409)),
      "wed_a",
    );
    expect(out).toMatchObject({ ok: false, gone: true });
  });

  it("keeps a wedding on a refusal that a retry or another owner can get past", async () => {
    const forbidden = await restoreWedding(answering(json({ error: "forbidden" }, 403)), "wed_a");
    expect(forbidden).toMatchObject({ ok: false, gone: false });

    const limited = await restoreWedding(answering(new Response(null, { status: 429 })), "wed_a");
    expect(limited).toEqual({
      ok: false,
      gone: false,
      message: expect.stringMatching(/Too many attempts/),
    });
  });

  it("falls back to its own copy for an answer it does not know", async () => {
    const out = await restoreWedding(answering(new Response("<html>", { status: 502 })), "wed_a");
    expect(out).toEqual({
      ok: false,
      gone: false,
      message: "Could not restore the wedding. Try again.",
    });
  });
});

describe("deleteWedding", () => {
  it("says to wait on a 429 with no body", async () => {
    const out = await deleteWedding(answering(new Response(null, { status: 429 })), "wed_a", "a");
    expect(out).toEqual({ ok: false, message: expect.stringMatching(/Too many attempts/) });
  });

  it("falls back to its own copy on a 500 that is not JSON", async () => {
    const out = await deleteWedding(answering(new Response("oops", { status: 500 })), "wed_a", "a");
    expect(out).toEqual({ ok: false, message: "Could not delete the wedding. Try again." });
  });

  it("names the refusal it knows", async () => {
    const out = await deleteWedding(
      answering(json({ error: "gift_in_flight" }, 409)),
      "wed_a",
      "a",
    );
    expect(out).toEqual({ ok: false, message: expect.stringMatching(/gift is still being paid/) });
  });
});
