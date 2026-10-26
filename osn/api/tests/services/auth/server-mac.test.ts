import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createServerMac } from "../../../src/services/auth/server-mac";

const SECRET = "s".repeat(32);

/**
 * A probe key stands in for an account id in a store key. It is derived from
 * the identifier a caller typed — often an email address, and often one that
 * names nobody — so it must not be something anyone with a list of addresses
 * can recompute.
 */
describe("createServerMac().probeKey", () => {
  it("is the same for the same identifier under the same secret, and account-id shaped", () => {
    const mac = createServerMac(SECRET);
    const key = mac.probeKey("someone@example.com");
    expect(key).toBe(createServerMac(SECRET).probeKey("someone@example.com"));
    expect(key).toMatch(/^prb_[0-9a-f]{12}$/);
    expect(key).toHaveLength("acc_0123456789ab".length);
    expect(mac.probeKey("someone-else@example.com")).not.toBe(key);
  });

  it("depends on the secret, so a list of addresses does not reverse it", () => {
    const identifier = "someone@example.com";
    const key = createServerMac(SECRET).probeKey(identifier);
    expect(createServerMac("t".repeat(32)).probeKey(identifier)).not.toBe(key);
    // The unkeyed digest a list of addresses could be run through.
    const unkeyed = createHash("sha256").update(`recovery-probe:${identifier}`).digest("hex");
    expect(key).not.toBe(`prb_${unkeyed.slice(0, 12)}`);
  });

  it("with no secret, keys under one made for this process, never a fixed one", () => {
    const a = createServerMac(undefined).probeKey("someone@example.com");
    const b = createServerMac(undefined).probeKey("someone@example.com");
    expect(a).toMatch(/^prb_[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
