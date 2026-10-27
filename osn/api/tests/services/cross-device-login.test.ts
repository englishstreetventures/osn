import { it, expect, describe } from "@effect/vitest";
import { securityEvents, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { CoordinationNamespace } from "@shared/coordination";
import { makeLogEmailLive } from "@shared/email";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeAll } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createFakeNamespace } from "../helpers/coordination-namespace";
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
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin();
      const status = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(status.status).toBe("pending");
    }).pipe(Effect.provide(layer));
  });

  it.effect("poll returns expired for unknown requestId", () => {
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const status = yield* svc.getCrossDeviceLoginStatus("cdl_000000000000", "deadbeef");
      expect(status.status).toBe("expired");
    }).pipe(Effect.provide(layer));
  });

  it.effect("poll rejects wrong secret", () => {
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const { requestId } = yield* svc.beginCrossDeviceLogin();
      const error = yield* Effect.flip(svc.getCrossDeviceLoginStatus(requestId, "wrong_secret"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid secret");
    }).pipe(Effect.provide(layer));
  });

  it.effect("full lifecycle: begin → approve → poll returns session", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      // Register a user first
      yield* svc.beginRegistration("cdl@example.com", "cdl_user", "1990-01-01");
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

      // The approve path records a cross_device_login audit row in the
      // same request (synchronous — no daemon race).
      const events = yield* svc.listUnacknowledgedSecurityEvents(profile!.accountId);
      expect(events.events.some((e) => e.kind === "cross_device_login")).toBe(true);

      // The notification email is forkDaemon'd — wait for the fiber to
      // complete (same pattern as the passkey-removed test), then pin
      // the template so the shared notify helper's per-call-site wiring is
      // asserted for this flow too.
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 50)));
      expect(captured.lastTemplate).toBe("cross-device-login");
    }).pipe(Effect.provide(layer));
  });

  it.effect("approved session is consumed on first poll (one-time)", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      yield* svc.beginRegistration("cdl2@example.com", "cdl_user2", "1990-01-01");
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
    const { svc, layer } = makeAuth();
    return Effect.gen(function* () {
      const { requestId, cdlSecret: secret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.rejectCrossDeviceLogin(requestId, secret);

      const status = yield* svc.getCrossDeviceLoginStatus(requestId, secret);
      expect(status.status).toBe("rejected");
    }).pipe(Effect.provide(layer));
  });

  it.effect("approve rejects wrong secret", () => {
    const { svc, captured, layer } = makeAuth();
    return Effect.gen(function* () {
      yield* svc.beginRegistration("cdl3@example.com", "cdl_user3", "1990-01-01");
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
      yield* svc.beginRegistration("cdl4@example.com", "cdl_user4", "1990-01-01");
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

/**
 * An approval parks who approved and the profile device B signs in as, never
 * a token: the poll that takes the approved entry mints the session. Run on
 * the Durable Object bundle over a stand-in namespace, with every `read`
 * answering a few milliseconds late, as a round trip does, so two requests'
 * reads overlap however the rest is scheduled.
 */
describe("cross-device login on the shared store", () => {
  const READ_DELAY_MS = 10;

  const slowReads = (ns: CoordinationNamespace): CoordinationNamespace => ({
    getByName(name, options) {
      const stub = ns.getByName(name, options);
      return {
        ...stub,
        read: async () => {
          const value = await stub.read();
          await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
          return value;
        },
      };
    },
  });

  function harness() {
    const fake = createFakeNamespace();
    const bundle = createDurableCoordination(slowReads(fake.ns), () => {});
    const svc = createAuthService({ ...config, ceremonyStores: bundle.ceremonyStores });
    const layer = Layer.merge(createTestLayer(), makeLogEmailLive().layer);
    return { svc, layer, store: bundle.ceremonyStores.crossDeviceRequests };
  }

  const countRows = (accountId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const live = yield* Effect.promise(() =>
        db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, accountId)),
      );
      const events = yield* Effect.promise(() =>
        db
          .select({ id: securityEvents.id })
          .from(securityEvents)
          .where(
            and(
              eq(securityEvents.accountId, accountId),
              eq(securityEvents.kind, "cross_device_login"),
            ),
          ),
      );
      return { sessions: live.length, events: events.length };
    });

  const successes = (results: readonly { readonly _tag: string }[]) =>
    results.filter((r) => r._tag === "Success").length;

  it.live("the approved entry holds the account, the profile and the approval, no token", () => {
    const { svc, layer, store } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-store@example.com", "cdlstore");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);

      const entry = yield* Effect.promise(() => store.get(requestId));
      expect(entry).toMatchObject({
        status: "approved",
        accountId: profile.accountId,
        profile: { id: profile.id, handle: "cdlstore", email: "cdl-store@example.com" },
      });
      expect(Object.keys(entry!)).not.toContain("session");
      const stored = JSON.stringify(entry);
      expect(stored).not.toMatch(/ses_|eyJ|accessToken|refreshToken/);
      // Nothing is minted until device B polls.
      expect((yield* countRows(profile.accountId)).sessions).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("of two polls at once, one gets a session and the other finds nothing", () => {
    const { svc, layer } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-polls@example.com", "cdlpolls");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();
      yield* svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId);

      const polls = yield* Effect.all(
        [
          svc.getCrossDeviceLoginStatus(requestId, cdlSecret),
          svc.getCrossDeviceLoginStatus(requestId, cdlSecret),
        ],
        { concurrency: "unbounded" },
      );
      expect(polls.map((p) => p.status).toSorted()).toEqual(["approved", "expired"]);
      const approved = polls.find((p) => p.status === "approved");
      if (approved?.status !== "approved") throw new Error("no poll was approved");
      expect(approved.session.refreshToken).toMatch(/^ses_/);
      expect(approved.profile.handle).toBe("cdlpolls");
      expect((yield* countRows(profile.accountId)).sessions).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("of two approvals at once, one wins: one session and one security event", () => {
    const { svc, layer } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-approve@example.com", "cdlapprove");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();

      const approvals = yield* Effect.all(
        [
          Effect.result(svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId)),
          Effect.result(svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId)),
        ],
        { concurrency: "unbounded" },
      );
      expect(successes(approvals)).toBe(1);
      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      expect(poll.status).toBe("approved");
      expect(yield* countRows(profile.accountId)).toEqual({ sessions: 1, events: 1 });
    }).pipe(Effect.provide(layer));
  });

  it.live("of an approval and a rejection at once, one wins", () => {
    const { svc, layer } = harness();
    return Effect.gen(function* () {
      const profile = yield* svc.registerProfile("cdl-either@example.com", "cdleither");
      const { requestId, cdlSecret } = yield* svc.beginCrossDeviceLogin();

      const decisions = yield* Effect.all(
        [
          Effect.result(svc.approveCrossDeviceLogin(requestId, cdlSecret, profile.accountId)),
          Effect.result(svc.rejectCrossDeviceLogin(requestId, cdlSecret)),
        ],
        { concurrency: "unbounded" },
      );
      expect(successes(decisions)).toBe(1);
      const poll = yield* svc.getCrossDeviceLoginStatus(requestId, cdlSecret);
      expect(poll.status).toBe(decisions[0]._tag === "Success" ? "approved" : "rejected");
    }).pipe(Effect.provide(layer));
  });
});
