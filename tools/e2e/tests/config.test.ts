import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { DEV_APPS } from "@shared/dev-urls";
import { PING, PING_INTERVAL_MS, PONG } from "@shared/realtime";

import { PORTS, REALTIME_KEEPALIVE } from "../src/config";
import { VENDOR_PORTAL_ORIGIN } from "../src/stack";

// The clock's start is read once, when `config.ts` loads, so each case loads it
// in a process of its own. The run against Stripe's test mode sets it to the
// real now: Stripe refuses a Checkout session that closes before real now plus
// 30 minutes, and cire-api an event signed more than five minutes from its now.
describe("CLOCK_T0", () => {
  const load = (start: string | undefined) => {
    const env: Record<string, string> = { PATH: process.env["PATH"] ?? "" };
    if (start !== undefined) env["E2E_STRIPE_CLOCK_T0"] = start;
    const config = join(import.meta.dirname, "..", "src", "config.ts");
    const script = `const c = await import(${JSON.stringify(config)}); process.stdout.write(JSON.stringify([c.CLOCK_T0, c.CLOCK_T0_ISO]));`;
    return spawnSync("bun", ["-e", script], { env, encoding: "utf8" });
  };

  test("is the fixed instant when the test-mode start is not set", () => {
    const out = load(undefined);
    expect(JSON.parse(out.stdout)).toEqual([
      Date.parse("2026-10-01T00:00:00.000Z"),
      "2026-10-01T00:00:00.000Z",
    ]);
  });

  test("is the test-mode start when one is set, and its ISO form follows", () => {
    const out = load("1794960000000");
    expect(JSON.parse(out.stdout)).toEqual([1794960000000, "2026-11-18T00:00:00.000Z"]);
  });

  test("refuses a start that is not a whole number of milliseconds", () => {
    for (const bad of ["", "soon", "1.5", "-3"]) {
      const out = load(bad);
      expect(out.status, bad).not.toBe(0);
      expect(out.stderr, bad).toContain("E2E_STRIPE_CLOCK_T0");
    }
  });
});

// The suite's ports are written out for Node; they must stay the ones the
// devloop itself uses with `PORTLESS=0`.
describe("PORTS", () => {
  test("match DEV_APPS for every app the suite boots", () => {
    expect(PORTS.osnApi).toBe(DEV_APPS["@osn/api"].port);
    expect(PORTS.pulseApi).toBe(DEV_APPS["@pulse/api"].port);
    expect(PORTS.cireApi).toBe(DEV_APPS["@cire/api"].port);
    expect(PORTS.musubi).toBe(DEV_APPS["@musubi/social"].port);
    expect(PORTS.pulseWeb).toBe(DEV_APPS["@pulse/web"].port);
    expect(PORTS.cireInvites).toBe(DEV_APPS["@cire/invites"].port);
    expect(PORTS.cireHost).toBe(DEV_APPS["@cire/host"].port);
    expect(PORTS.cireLanding).toBe(DEV_APPS["@cire/landing"].port);
  });

  test("the vendor portal origin cire-api is told is the vendor dev app's", () => {
    expect(VENDOR_PORTAL_ORIGIN).toBe(`http://localhost:${DEV_APPS["@cire/vendor"].port}`);
  });

  test("the stand-ins' ports belong to no dev app", () => {
    const devPorts = Object.values(DEV_APPS).map((app) => app.port);
    expect(devPorts).not.toContain(PORTS.mail);
    expect(devPorts).not.toContain(PORTS.stripe);
    expect(devPorts).not.toContain(PORTS.issuer);
    expect(devPorts).not.toContain(PORTS.osnApiEvt);
    expect(devPorts).not.toContain(PORTS.cireApiKeyOnly);
  });
});

// The hub stand-in's keepalive is written out for Node too; it must stay the
// one the realtime client and hub speak. A ping word that drifts fails the
// checklist flow, but a shorter interval would still pass it.
describe("REALTIME_KEEPALIVE", () => {
  test("matches @shared/realtime's ping, pong and interval", () => {
    expect(REALTIME_KEEPALIVE).toEqual({ ping: PING, pong: PONG, intervalMs: PING_INTERVAL_MS });
  });
});
