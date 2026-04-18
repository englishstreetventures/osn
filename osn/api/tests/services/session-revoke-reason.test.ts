/**
 * T-U3: observability coverage for `metricSessionRevoked(reason)` emission.
 *
 * The unified `osn.auth.session.revoked{reason}` counter is the single pivot
 * the security dashboard uses. If a caller accidentally passes the default
 * reason when a specific one (`passkey_register`, `recovery_code_consume`,
 * `logout`) should have been passed, dashboards degrade silently.
 *
 * This file mocks the metrics module and asserts the right reason value at
 * each emission site.
 */

import { Effect } from "effect";
import { it, expect, describe, vi, beforeAll, beforeEach } from "vitest";

// Mock ONLY the metric-emitting functions we care about. The `with*`
// wrappers have to pass through as-is because they decorate Effect
// pipelines — mocking them would collapse the service into no-ops.
vi.mock("../../src/metrics", async () => {
  const actual = await vi.importActual<typeof import("../../src/metrics")>("../../src/metrics");
  return {
    ...actual,
    metricSessionRevoked: vi.fn(),
  };
});

import { metricSessionRevoked } from "../../src/metrics";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

const mockRevoked = metricSessionRevoked as unknown as ReturnType<typeof vi.fn>;

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

beforeEach(() => {
  mockRevoked.mockClear();
});

describe("metricSessionRevoked reason emission", () => {
  it("invalidateSession emits reason=logout by default", async () => {
    const layer = createTestLayer();
    const profile = await Effect.runPromise(
      auth.registerProfile("logout-reason@example.com", "logoutreason").pipe(Effect.provide(layer)),
    );
    const tokens = await Effect.runPromise(
      auth
        .issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        )
        .pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      auth.invalidateSession(tokens.refreshToken).pipe(Effect.provide(layer)),
    );
    expect(mockRevoked).toHaveBeenCalledWith("logout");
  });

  it("invalidateAccountSessions forwards the caller-supplied reason", async () => {
    const layer = createTestLayer();
    const profile = await Effect.runPromise(
      auth.registerProfile("all-sessions@example.com", "allsessions").pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      auth
        .invalidateAccountSessions(profile.accountId, "revoke_all_others")
        .pipe(Effect.provide(layer)),
    );
    expect(mockRevoked).toHaveBeenCalledWith("revoke_all_others");
  });

  it("invalidateOtherAccountSessions forwards the caller-supplied reason", async () => {
    const layer = createTestLayer();
    const profile = await Effect.runPromise(
      auth
        .registerProfile("other-sessions@example.com", "othersessions")
        .pipe(Effect.provide(layer)),
    );
    const tokens = await Effect.runPromise(
      auth
        .issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        )
        .pipe(Effect.provide(layer)),
    );
    const sessionHash = (await import("../../src/services/auth")).hashSessionToken(
      tokens.refreshToken,
    );
    await Effect.runPromise(
      auth
        .invalidateOtherAccountSessions(profile.accountId, sessionHash, "passkey_register")
        .pipe(Effect.provide(layer)),
    );
    expect(mockRevoked).toHaveBeenCalledWith("passkey_register");
  });

  it("generateRecoveryCodesForAccount emits reason=recovery_code_generate", async () => {
    const layer = createTestLayer();
    const profile = await Effect.runPromise(
      auth.registerProfile("recgen@example.com", "recgen").pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      auth.generateRecoveryCodesForAccount(profile.accountId).pipe(Effect.provide(layer)),
    );
    expect(mockRevoked).toHaveBeenCalledWith("recovery_code_generate");
  });

  it("consumeRecoveryCode emits reason=recovery_code_consume on success", async () => {
    const layer = createTestLayer();
    const profile = await Effect.runPromise(
      auth.registerProfile("recuse@example.com", "recuse").pipe(Effect.provide(layer)),
    );
    const { recoveryCodes } = await Effect.runPromise(
      auth.generateRecoveryCodesForAccount(profile.accountId).pipe(Effect.provide(layer)),
    );
    // Clear the generate-emission so the assertion below targets the consume path.
    mockRevoked.mockClear();

    await Effect.runPromise(
      auth.consumeRecoveryCode("recuse@example.com", recoveryCodes[0]!).pipe(Effect.provide(layer)),
    );
    expect(mockRevoked).toHaveBeenCalledWith("recovery_code_consume");
  });
});
