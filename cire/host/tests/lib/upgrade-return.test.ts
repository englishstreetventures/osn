import { describe, expect, it } from "vitest";

import {
  clearUpgradeParams,
  POLL_ATTEMPTS,
  pollDelayMs,
  readUpgradeReturn,
} from "../../src/lib/upgrade-return";

/**
 * Reading the receipt Stripe sends the organiser back with.
 *
 * The params are in the QUERY rather than the fragment because the portal is
 * hash-routed and the hash is the route. Stripping them is not tidiness: the
 * dashboard rebuilds the URL as `pathname + search + hash` on every hash write
 * and the login bounce carries `search` through, so anything left here survives
 * every later navigation and re-runs the handler.
 */

describe("readUpgradeReturn", () => {
  it("reads a full receipt", () => {
    expect(readUpgradeReturn("?upgrade=upg_1&w=wed_1&m=registry")).toEqual({
      purchaseId: "upg_1",
      weddingId: "wed_1",
      module: "registry",
    });
  });

  it("is absent when there is no receipt", () => {
    expect(readUpgradeReturn("")).toBeNull();
    expect(readUpgradeReturn("?foo=bar")).toBeNull();
    // The cancel URL: a wedding and module, but nothing was bought.
    expect(readUpgradeReturn("?w=wed_1&m=registry")).toBeNull();
  });

  it("needs the wedding, since the poll is scoped to it", () => {
    expect(readUpgradeReturn("?upgrade=upg_1")).toBeNull();
  });

  it("refuses a module it does not recognise rather than routing to it", () => {
    // `m` decides a route. An unvalidated value puts the shell into a state its
    // own parser cannot produce.
    expect(readUpgradeReturn("?upgrade=upg_1&w=wed_1&m=../../etc")?.module).toBeNull();
    expect(readUpgradeReturn("?upgrade=upg_1&w=wed_1&m=constructor")?.module).toBeNull();
    expect(readUpgradeReturn("?upgrade=upg_1&w=wed_1")?.module).toBeNull();
  });
});

describe("clearUpgradeParams", () => {
  it("removes the receipt and keeps everything else", () => {
    const url = new URL("https://host.test/?upgrade=upg_1&w=wed_1&m=registry&keep=1#/w/wed_1");
    expect(clearUpgradeParams(url)).toBe("/?keep=1#/w/wed_1");
  });

  it("leaves a path with no query at all clean", () => {
    const url = new URL("https://host.test/?upgrade=upg_1&w=wed_1&m=registry#/w/wed_1/registry");
    expect(clearUpgradeParams(url)).toBe("/#/w/wed_1/registry");
  });

  it("preserves the hash, which is the route", () => {
    const url = new URL("https://host.test/?upgrade=upg_1&w=wed_1#/w/wed_1/vendors/list");
    expect(clearUpgradeParams(url)).toContain("#/w/wed_1/vendors/list");
  });
});

describe("polling", () => {
  it("backs off and stops climbing", () => {
    // Stripe is usually inside a second, so the first checks are quick; after
    // that, slowing down beats hammering an endpoint waiting on someone else.
    expect(pollDelayMs(0)).toBe(500);
    expect(pollDelayMs(1)).toBe(1_000);
    expect(pollDelayMs(2)).toBe(2_000);
    expect(pollDelayMs(10)).toBe(8_000);
  });

  it("is bounded, so a webhook that never lands cannot spin", () => {
    expect(POLL_ATTEMPTS).toBeGreaterThan(0);
    expect(POLL_ATTEMPTS).toBeLessThanOrEqual(12);
    const total = Array.from({ length: POLL_ATTEMPTS }, (_, i) => pollDelayMs(i)).reduce(
      (a, b) => a + b,
      0,
    );
    // Long enough to outlast an ordinary delivery, short enough that the page
    // stops asking well before the organiser has given up on it.
    expect(total).toBeGreaterThan(15_000);
    expect(total).toBeLessThan(90_000);
  });
});
