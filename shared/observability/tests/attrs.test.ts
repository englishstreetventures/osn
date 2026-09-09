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
 *
 * The point of the pin is that adding a member costs an argument, not a
 * keystroke. So: **what makes a new `AuthMethod` legitimate.** Not "it is not
 * called OTP" — `email_recovery` is an emailed six-digit code, which is
 * precisely the shape that was removed. What separates it is where it lands.
 * A primary login factor mints an `osn-access` session that reaches every route
 * and every downstream service. The two recovery factors mint a **restricted**
 * one: `aud: "osn-recovery"`, a 15-minute absolute lifetime that rotation
 * carries forward rather than extending, refused by all four verifiers in
 * osn-api and by the three services that verify over JWKS, and accepted by
 * exactly one resolver — `resolvePasskeyEnrollPrincipal`. It can enrol a
 * passkey and do nothing else, and doing so is what lifts the restriction.
 *
 * A future member that does not clear that bar does not belong here, whatever
 * it is called. See `wiki/architecture/account-recovery-factors.md` §B.
 */
describe("AuthMethod", () => {
  it("includes exactly the passkey-primary surface plus the restricted recovery factors", () => {
    const members = {
      passkey: true,
      recovery_code: true,
      // Restricted-session recovery only — see the header. Neither of these is
      // a login factor, and neither mints an `osn-access` audience.
      email_recovery: true,
      totp_recovery: true,
      refresh: true,
    } as const satisfies Record<AuthMethod, true>;
    expect(new Set(Object.keys(members))).toEqual(
      new Set(["passkey", "recovery_code", "email_recovery", "totp_recovery", "refresh"]),
    );
    // The negative that still holds: no member names an unrestricted OTP or
    // magic-link primary login.
    expect(Object.keys(members)).not.toContain("otp");
    expect(Object.keys(members)).not.toContain("magic_link");
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
      recovery_status: true,
      recovery_complete: true,
      // The three unauthenticated account-recovery routes. `recovery_email_begin`
      // is the only one of the three that sends mail, which is why it carries a
      // per-ACCOUNT cap as well as this per-IP one.
      recovery_email_begin: true,
      recovery_email_complete: true,
      recovery_totp_complete: true,
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
      oidc_authorize: true,
      oidc_authorize_context: true,
      oidc_authorize_decision: true,
      oidc_token: true,
      oidc_connections_list: true,
      oidc_connections_revoke: true,
      oidc_client_create: true,
      oidc_client_list: true,
      oidc_client_disable: true,
      step_up_totp_complete: true,
      totp_enroll_begin: true,
      totp_enroll_complete: true,
      totp_disable: true,
      totp_status: true,
    } as const satisfies Record<AuthRateLimitedEndpoint, true>;
    // Runtime snapshot — catches a drop that the `satisfies` check would miss
    // (it only complains on missing members, not extras).
    expect(Object.keys(members)).toHaveLength(52);
    // Negative: primary-login OTP/magic-link endpoints must not reappear.
    expect(Object.keys(members)).not.toContain("otp_begin");
    expect(Object.keys(members)).not.toContain("otp_complete");
    expect(Object.keys(members)).not.toContain("magic_begin");
    expect(Object.keys(members)).not.toContain("magic_verify");
  });
});
