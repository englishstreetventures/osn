// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, apiUrl: (path: string) => `https://api.test${path}` };
});

import {
  fetchCatalogue,
  fetchPurchase,
  startUpgrade,
  UpgradeApiError,
} from "../../src/lib/upgrade-api";

/**
 * The money path's client half.
 *
 * Two behaviours carry weight here. A 404 is "this deployment has no upgrade
 * surface", which must read as an empty catalogue rather than an error — the
 * routes are unmounted without Stripe configured. And the error CODE must
 * survive: `processing` is what makes the dialog say "wait" instead of inviting
 * a second payment, and it only reaches the dialog if it is parsed out here.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const GOLD = {
  tier: "gold",
  fromTier: "ivory",
  title: "Gold",
  blurb: "…",
  amountMinor: 2900,
  currency: "AUD",
} as const;

const CRIMSON = { ...GOLD, tier: "crimson", title: "Crimson", amountMinor: 5900 } as const;

describe("fetchCatalogue", () => {
  it("returns the wedding's tier and its upgrades, from the wedding's own route", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ tier: "ivory", upgrades: [GOLD, CRIMSON] }));
    expect(await fetchCatalogue(authFetch, "wed_1")).toEqual({
      tier: "ivory",
      upgrades: [GOLD, CRIMSON],
    });
    expect(authFetch).toHaveBeenCalledWith(
      "https://api.test/api/organiser/weddings/wed_1/upgrade/catalogue",
    );
  });

  it("keeps the price a Gold wedding is quoted for Crimson", async () => {
    const fromGold = { ...CRIMSON, fromTier: "gold", amountMinor: 3000 };
    const authFetch = vi.fn().mockResolvedValue(json({ tier: "gold", upgrades: [fromGold] }));
    expect(await fetchCatalogue(authFetch, "wed_1")).toEqual({
      tier: "gold",
      upgrades: [fromGold],
    });
  });

  it("reads a 404 as an empty catalogue, not an error", async () => {
    // No Stripe configured ⇒ the routes are not mounted. The honest portal
    // answer is "no purchase path", not "something broke".
    const authFetch = vi.fn().mockResolvedValue(json({}, 404));
    expect(await fetchCatalogue(authFetch, "wed_1")).toEqual({ tier: null, upgrades: [] });
  });

  it("tolerates a 200 with no upgrades key", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ tier: "crimson" }));
    expect(await fetchCatalogue(authFetch, "wed_1")).toEqual({ tier: "crimson", upgrades: [] });
  });

  it("drops an entry for a tier this build cannot name, and an unknown wedding tier", async () => {
    // The dialog sells a tier by name; one it does not know is not one it can
    // sell, and an unrecognised wedding tier must not read as holding anything.
    const authFetch = vi
      .fn()
      .mockResolvedValue(
        json({ tier: "platinum", upgrades: [GOLD, { ...GOLD, tier: "platinum" }] }),
      );
    expect(await fetchCatalogue(authFetch, "wed_1")).toEqual({ tier: null, upgrades: [GOLD] });
  });

  it("throws with the server's code on any other failure", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ error: "internal" }, 500));
    await expect(fetchCatalogue(authFetch, "wed_1")).rejects.toMatchObject({
      code: "internal",
      status: 500,
    });
  });

  it("escapes a wedding id rather than pasting it into the path", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ upgrades: [] }));
    await fetchCatalogue(authFetch, "wed/../other");
    expect(String(authFetch.mock.calls[0]?.[0])).toContain("wed%2F..%2Fother");
  });
});

describe("startUpgrade", () => {
  it("posts the tier and the module to come back to, and returns the payment page", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(json({ purchaseId: "upg_1", url: "https://pay.test/x", reused: false }));

    expect(await startUpgrade(authFetch, "wed_1", "gold", "registry")).toEqual({
      purchaseId: "upg_1",
      url: "https://pay.test/x",
      reused: false,
    });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_1/upgrade/session");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ tier: "gold", module: "registry" });
  });

  it("leaves the module out when none was given, so the API lands on Overview", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(json({ purchaseId: "upg_1", url: "https://pay.test/x", reused: true }));
    await startUpgrade(authFetch, "wed_1", "crimson");
    const [, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ tier: "crimson" });
  });

  /**
   * THE CODE THAT MUST SURVIVE. A 409 `processing` means an earlier session is
   * paid but unsettled. If the code is lost here the dialog falls through to
   * its generic "try again" — which is how somebody pays twice.
   */
  it("preserves the `processing` code so the dialog can say wait", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ error: "processing" }, 409));
    const err = await startUpgrade(authFetch, "wed_1", "gold").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpgradeApiError);
    expect(err).toMatchObject({ code: "processing", status: 409 });
  });

  it("preserves `already_held` too", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ error: "already_held" }, 409));
    await expect(startUpgrade(authFetch, "wed_1", "gold")).rejects.toMatchObject({
      code: "already_held",
    });
  });

  it("falls back to the status when the body carries no code", async () => {
    // An error page from something in front of the API, say.
    const authFetch = vi.fn().mockResolvedValue(new Response("<html>", { status: 502 }));
    await expect(startUpgrade(authFetch, "wed_1", "gold")).rejects.toMatchObject({
      code: "http_502",
      status: 502,
    });
  });
});

describe("fetchPurchase", () => {
  it("returns the purchase state and the tier it buys", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(json({ purchase: { status: "succeeded", tier: "crimson" } }));
    expect(await fetchPurchase(authFetch, "wed_1", "upg_1")).toEqual({
      status: "succeeded",
      tier: "crimson",
    });
  });

  it("reads a tier it cannot name as null rather than passing it on", async () => {
    // The API answers `tier: null` for a purchase whose product names no tier,
    // and an older API sends no tier at all.
    for (const purchase of [
      { status: "succeeded", tier: null },
      { status: "succeeded", entitlement: "registry" },
      { status: "succeeded", tier: "platinum" },
    ]) {
      const authFetch = vi.fn().mockResolvedValue(json({ purchase }));
      expect(await fetchPurchase(authFetch, "wed_1", "upg_1")).toEqual({
        status: "succeeded",
        tier: null,
      });
    }
  });

  it("returns null for a purchase this wedding does not have", async () => {
    // Wedding-scoped on the server, so another wedding's id is simply absent.
    // Null rather than a throw, because the return handler polls this and a
    // hand-typed id must not surface as an error.
    const authFetch = vi.fn().mockResolvedValue(json({}, 404));
    expect(await fetchPurchase(authFetch, "wed_1", "upg_other")).toBeNull();
  });

  it("escapes the purchase id", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ purchase: { status: "pending" } }));
    await fetchPurchase(authFetch, "wed_1", "upg/../x");
    expect(String(authFetch.mock.calls[0]?.[0])).toContain("upg%2F..%2Fx");
  });

  it("throws on a real failure rather than reporting no purchase", async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ error: "internal" }, 500));
    await expect(fetchPurchase(authFetch, "wed_1", "upg_1")).rejects.toMatchObject({
      status: 500,
    });
  });
});
