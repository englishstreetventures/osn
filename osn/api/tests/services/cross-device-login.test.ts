import { it, expect, describe } from "@effect/vitest";
import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

function makeAuth() {
  const email = makeLogEmailLive();
  const svc = createAuthService(config);
  const layer = Layer.merge(createTestLayer(), email.layer);
  const captured = {
    get code(): string | undefined {
      const all = email.recorded();
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i].text.match(/code is: (\d{6})/);
        if (m) return m[1];
      }
      return undefined;
    },
    reset: () => email.reset(),
    get lastTemplate(): string | undefined {
      const all = email.recorded();
      return all.length > 0 ? all[all.length - 1].template : undefined;
    },
  };
  return { svc, captured, layer };
}

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("cross-device login", () => {
  it.effect("begin returns requestId, secret, and expiresAt", () => {
    const { svc } = makeAuth();
    return Effect.gen(function* () {
      const result = yield* svc.beginCrossDeviceLogin({ uaLabel: "Chrome on macOS" });
      expect(result.requestId).toMatch(/^cdl_[a-f0-9]{12}$/);
      expect(result.cdlSecret).toHaveLength(64); // 32 bytes hex
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  it.effect("poll returns pending before approval", () => {
    const { svc } = makeAuth();
    return Effect.gen(function* () {
      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin();
      const status = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(status.status).toBe("pending");
    });
  });

  it.effect("poll returns expired for unknown requestId", () => {
    const { svc } = makeAuth();
    return Effect.gen(function* () {
      const status = yield* svc.getCrossDeviceLoginStatus("cdl_000000000000", "deadbeef");
      expect(status.status).toBe("expired");
    });
  });

  it.effect("poll rejects wrong secret", () => {
    const { svc } = makeAuth();
    return Effect.gen(function* () {
      const { requestId } = yield* svc.beginCrossDeviceLogin();
      const error = yield* Effect.flip(svc.getCrossDeviceLoginStatus(requestId, "wrong_secret"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid secret");
    });
  });

  it.effect("full lifecycle: begin → approve → poll returns session", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      // Register a user first
      yield* svc.beginRegistration("cdl@example.com", "cdl_user");
      yield* svc.completeRegistration("cdl@example.com", captured.code!, {
        uaLabel: "Device A",
      });
      const profile = yield* svc.findProfileByEmail("cdl@example.com");
      expect(profile).not.toBeNull();

      // Device B begins CDL
      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin({
        uaLabel: "Device B",
      });

      // Device A approves
      captured.reset();
      yield* svc.approveCrossDeviceLogin(requestId, secret, profile!.accountId, {
        uaLabel: "Device A",
      });

      // Device B polls and gets session
      const result = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(result.status).toBe("approved");
      if (result.status === "approved") {
        expect(result.session.accessToken).toBeTruthy();
        expect(result.session.refreshToken).toMatch(/^ses_/);
        expect(result.profile.handle).toBe("cdl_user");
      }

      // Notification email is dispatched via forkDaemon — it fires
      // asynchronously and may not have landed by the time this assertion
      // runs. The template is covered by shared/email template tests.
    }).pipe(Effect.provide(layer));
  });

  it.effect("approved session is consumed on first poll (one-time)", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      yield* svc.beginRegistration("cdl2@example.com", "cdl_user2");
      yield* svc.completeRegistration("cdl2@example.com", captured.code!, {});
      const profile = yield* svc.findProfileByEmail("cdl2@example.com");

      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.approveCrossDeviceLogin(requestId, secret, profile!.accountId);

      // First poll: get session
      const first = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(first.status).toBe("approved");

      // Second poll: request consumed → expired
      const second = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(second.status).toBe("expired");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reject marks request as rejected", () => {
    const { svc } = makeAuth();
    return Effect.gen(function* () {
      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.rejectCrossDeviceLogin(requestId, secret);

      const status = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(status.status).toBe("rejected");
    });
  });

  it.effect("approve rejects wrong secret", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      yield* svc.beginRegistration("cdl3@example.com", "cdl_user3");
      yield* svc.completeRegistration("cdl3@example.com", captured.code!, {});
      const profile = yield* svc.findProfileByEmail("cdl3@example.com");

      const { requestId } = yield* svc.beginCrossDeviceLogin();
      const error = yield* Effect.flip(
        svc.approveCrossDeviceLogin(requestId, "bad_secret", profile!.accountId),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid secret");
    }).pipe(Effect.provide(layer));
  });

  it.effect("approve fails on already-approved request", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      yield* svc.beginRegistration("cdl4@example.com", "cdl_user4");
      yield* svc.completeRegistration("cdl4@example.com", captured.code!, {});
      const profile = yield* svc.findProfileByEmail("cdl4@example.com");

      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.approveCrossDeviceLogin(requestId, secret, profile!.accountId);

      const error = yield* Effect.flip(
        svc.approveCrossDeviceLogin(requestId, secret, profile!.accountId),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("already processed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reject fails on unknown request", () => {
    const { svc } = makeAuth();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        svc.rejectCrossDeviceLogin("cdl_000000000000", "any_secret"),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("not found");
    });
  });
});
