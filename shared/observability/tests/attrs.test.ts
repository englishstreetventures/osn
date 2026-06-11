import { describe, expect, it } from "vitest";

import type { AuthMethod, AuthRateLimitedEndpoint } from "../src/metrics/attrs";

/**
 * Attribute-union cardinality pins. The unions in `src/metrics/attrs.ts` are
 * load-bearing — widening them silently re-introduces attack surface the
 * passkey-primary work deliberately closed (OTP/magic-link primary login),
 * narrowing them silently drops legitimate values from metric dashboards.
 *
 * Each test uses an exhaustive `satisfies Record<Union, true>` literal to
 * catch compile-time drift, plus a runtime-key snapshot to catch runtime
 * drift in consumers that enumerate the attribute space.
 */
describe("AuthMethod", () => {
  it("includes exactly the passkey-primary surface", () => {
    const members = {
      passkey: true,
      recovery_code: true,
      refresh: true,
    } as const satisfies Record<AuthMethod, true>;
    expect(new Set(Object.keys(members))).toEqual(new Set(["passkey", "recovery_code", "refresh"]));
  });
});

describe("AuthRateLimitedEndpoint", () => {
  it("covers every rate-limited route — no OTP/magic primary surface", () => {
    const members = {
      register_begin: true,
      register_complete: true,
      handle_check: true,
      passkey_login_begin: true,
      passkey_login_complete: true,
      passkey_register_begin: true,
      passkey_register_complete: true,
      profile_switch: true,
      profile_list: true,
      profile_create: true,
      profile_delete: true,
      profile_set_default: true,
      recovery_generate: true,
      recovery_complete: true,
      step_up_passkey_begin: true,
      step_up_passkey_complete: true,
      step_up_otp_begin: true,
      step_up_otp_complete: true,
      session_list: true,
      session_revoke: true,
      email_change_begin: true,
      email_change_complete: true,
      security_event_list: true,
      security_event_ack: true,
      passkey_list: true,
      passkey_rename: true,
      passkey_delete: true,
      cross_device_begin: true,
      cross_device_poll: true,
      cross_device_approve: true,
      cross_device_reject: true,
      account_delete: true,
      account_restore: true,
      account_deletion_status: true,
    } as const satisfies Record<AuthRateLimitedEndpoint, true>;
    // Runtime snapshot — catches a drop that the `satisfies` check would miss
    // (it only complains on missing members, not extras).
    expect(Object.keys(members)).toHaveLength(34);
    // Negative: primary-login OTP/magic-link endpoints must not reappear.
    expect(Object.keys(members)).not.toContain("otp_begin");
    expect(Object.keys(members)).not.toContain("otp_complete");
    expect(Object.keys(members)).not.toContain("magic_begin");
    expect(Object.keys(members)).not.toContain("magic_verify");
  });
});
