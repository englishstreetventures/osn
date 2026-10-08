import { describe, expect, it, vi } from "vitest";

import { redeemUnlockCode } from "../../src/lib/unlock-code";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("redeemUnlockCode", () => {
  it("POSTs the typed code to the wedding's unlock-code route", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ tier: "gold" }));
    expect(await redeemUnlockCode(authFetch, "wed_1", " 3F9A-0C1E-B7D2-48AA ")).toEqual({
      ok: true,
      tier: "gold",
    });
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/organiser\/weddings\/wed_1\/unlock-code$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ unlockCode: "3F9A-0C1E-B7D2-48AA" });
  });

  it("encodes the wedding id into its own path segment", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ tier: "gold" }));
    await redeemUnlockCode(authFetch, "wed/1", "x");
    expect(String(authFetch.mock.calls[0]![0])).toContain("/weddings/wed%2F1/unlock-code");
  });

  it.each([
    [404, { error: "unlock_code_invalid" }, /not valid.*expired.*used/i],
    [409, { error: "tier_already_held", tier: "crimson" }, /already on Crimson.*not been used/i],
    [409, { error: "purchase_in_flight" }, /upgrade payment.*still open/i],
    [403, { error: "forbidden" }, /only an owner/i],
    [429, { error: "Too many requests" }, /too many attempts/i],
    [500, { error: "internal" }, /could not check the code/i],
    [404, { error: "wedding_not_found" }, /could not check the code/i],
  ])("words a %i %j for the owner", async (status, body, message) => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes(body, status));
    const outcome = await redeemUnlockCode(authFetch, "wed_1", "x");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toMatch(message);
  });

  it("does not take a body naming a key of Object for a refusal it knows", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "constructor" }, 400));
    const outcome = await redeemUnlockCode(authFetch, "wed_1", "x");
    expect(outcome).toEqual({ ok: false, message: "Could not check the code. Try again." });
  });

  it("treats a 200 that names no paid tier as a failure, not an upgrade", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ tier: "ivory" }));
    expect((await redeemUnlockCode(authFetch, "wed_1", "x")).ok).toBe(false);
  });

  it("survives a body that is not JSON", async () => {
    const authFetch = vi.fn().mockResolvedValue(new Response("<html>", { status: 502 }));
    expect(await redeemUnlockCode(authFetch, "wed_1", "x")).toEqual({
      ok: false,
      message: "Could not check the code. Try again.",
    });
  });
});
