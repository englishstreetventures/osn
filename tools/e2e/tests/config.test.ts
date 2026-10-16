import { describe, expect, test } from "bun:test";

import { DEV_APPS } from "@shared/dev-urls";

import { PORTS } from "../src/config";

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
  });

  test("the mail stand-in's port belongs to no dev app", () => {
    const devPorts = Object.values(DEV_APPS).map((app) => app.port);
    expect(devPorts).not.toContain(PORTS.mail);
  });
});
