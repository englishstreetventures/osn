import { describe, expect, test } from "bun:test";

import { DEV_APPS } from "@shared/dev-urls";
import { PING, PING_INTERVAL_MS, PONG } from "@shared/realtime";

import { PORTS, REALTIME_KEEPALIVE } from "../src/config";
import { VENDOR_PORTAL_ORIGIN } from "../src/stack";

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

  test("the mail stand-in's port belongs to no dev app", () => {
    const devPorts = Object.values(DEV_APPS).map((app) => app.port);
    expect(devPorts).not.toContain(PORTS.mail);
  });
});

// The hub stand-in's keepalive is written out for Node too. A word that drifts
// leaves a portal socket unanswered, and after two ping intervals the client
// drops it and re-reads; an interval that drifts moves the page clock in
// `cire-checklist-starter` short of the ping it waits for.
describe("REALTIME_KEEPALIVE", () => {
  test("is the realtime protocol's ping, pong and ping interval", () => {
    expect(REALTIME_KEEPALIVE).toEqual({ ping: PING, pong: PONG, intervalMs: PING_INTERVAL_MS });
  });
});
