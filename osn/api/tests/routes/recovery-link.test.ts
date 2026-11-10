/**
 * Email account recovery through the emailed link, over the routes: what the
 * link can and cannot do, and that an address with no account answers exactly
 * as one with.
 *
 * Each case is a refusal the recovery flow must make: a `GET` never approves,
 * wrong secrets and wrong picks are counted against the account, the device
 * that confirms gets no session, only the tab holding the claim secret gets
 * one — and only the restricted recovery session — and the limits hold
 * without letting a stranger spend the owner's. The happy path end to end is
 * the E2E flow `musubi-recovery`.
 */

import { Database } from "bun:sqlite";

import { accounts, securityEvents, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { EmailService, makeLogEmailLive, type SendEmailInput } from "@shared/email";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createInMemoryRecoveryLockoutStore,
  type LockoutReading,
  type RecoveryLockoutStore,
} from "../../src/lib/recovery-lockout-store";
import { createAuthService, type AuthConfig } from "../../src/services/auth";
import {
  RECOVERY_LINKS_PER_ACCOUNT_CEILING,
  RECOVERY_LINKS_PER_ADDRESS_MAX,
  RECOVERY_RESENDS_PER_ACCOUNT_MAX,
  RECOVERY_TOKEN_AUDIENCE,
} from "../../src/services/auth/constants";
import { createDefaultCeremonyStores } from "../../src/services/auth/stores";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settledHandle } from "../helpers/background";
import {
  beginRecoveryThroughRoutes,
  latestRecoveryLinkTo,
  recoveryLinksTo,
  recoveryResendThroughRoutes,
  recoveryStatusThroughRoutes,
} from "../helpers/recovery-link";
import {
  beginThroughRoutes,
  candidatesThroughRoutes,
  confirmThroughRoutes,
  latestLinkTo,
} from "../helpers/registration";
import { createAuthRoutes } from "../helpers/routes";

let config: AuthConfig;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

afterEach(() => {
  vi.useRealTimers();
});

const WRONG_SECRET = "0".repeat(64);
const MINUTE = 60_000;

/** A client address of its own: each per-address limit is keyed on it. */
const from = (n: number): Record<string, string> => ({ "x-forwarded-for": `198.51.100.${n}` });

/** A route app, a service and the raw database over one layer. */
function harness(overrides: Partial<AuthConfig> = {}, emailLayer?: Layer.Layer<EmailService>) {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle({ client: sqlite });
  const mail = makeLogEmailLive();
  const layer = Layer.merge(Layer.succeed(Db, { db }), emailLayer ?? mail.layer);
  // One set of ceremony stores for the routes and the service, so a request
  // the routes opened is the one the service reads.
  const merged = { ...config, ceremonyStores: createDefaultCeremonyStores(), ...overrides };
  const app = createAuthRoutes(merged, layer);
  const auth = createAuthService(merged);
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
  const seed = (email: string, handle: string) => svc(auth.registerProfile(email, handle));
  const events = async (accountId: string) =>
    (await db.select().from(securityEvents).where(eq(securityEvents.accountId, accountId))).map(
      (e) => e.kind,
    );
  return { app, auth, db, sqlite, svc, seed, events, recorded: () => mail.recorded() };
}

type Harness = ReturnType<typeof harness>;

/** A begun recovery for `email` from address `n`, and the link mailed for it. */
async function begun(h: Harness, email: string, n: number) {
  const before = recoveryLinksTo(h.recorded(), email);
  const { res, body } = await beginRecoveryThroughRoutes(h.app, email, from(n));
  expect(res.status).toBe(202);
  expect(recoveryLinksTo(h.recorded(), email)).toBe(before + 1);
  const link = latestRecoveryLinkTo(h.recorded(), email)!;
  expect(link.requestId).toBe(body.requestId);
  return { ...body, link };
}

const confirm = (h: Harness, requestId: string, linkSecret: string, pick: string, n = 50) =>
  confirmThroughRoutes(h.app, requestId, linkSecret, pick, from(n));

/** A typed number that is not `right`. */
function wrongNumber(right: string): string {
  return right === "00" ? "01" : "00";
}

/** A poll's body with its number reduced to its shape, as two requests draw different numbers. */
function pollShape(body: unknown): unknown {
  const { pairingCode, ...rest } = body as { pairingCode?: unknown };
  if (pairingCode === undefined) return rest;
  return {
    ...rest,
    pairingCode:
      typeof pairingCode === "string" && /^[0-9]{2}$/.test(pairingCode)
        ? "two digits"
        : pairingCode,
  };
}

const payloadOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

describe("a GET never approves", () => {
  it("answers 404 to a GET on the link's routes and the status route, and the request stays pending", async () => {
    const h = harness();
    await h.seed("rl-get@example.com", "rlget");
    const r = await begun(h, "rl-get@example.com", 1);

    for (const path of [
      `/email-link/${r.requestId}/confirm`,
      `/email-link/${r.requestId}/candidates`,
      `/login/recovery/email/${r.requestId}/status`,
      `/verify/${r.requestId}`,
    ]) {
      const res = await h.app.handle(new Request(`http://localhost${path}`, { headers: from(1) }));
      expect(res.status).toBe(404);
      expect(res.headers.getSetCookie()).toEqual([]);
    }

    const polled = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(polled.status).toBe(200);
    expect(await polled.json()).toEqual({ status: "pending", pairingCode: r.pairingCode });
  });
});

describe("an address with no account answers as one with", () => {
  it("begins alike: same status, keys, shapes and headers, and mails only the account", async () => {
    const h = harness();
    await h.seed("rl-known@example.com", "rlknown");

    const known = await beginRecoveryThroughRoutes(h.app, "rl-known@example.com", from(1));
    const nobody = await beginRecoveryThroughRoutes(h.app, "rl-nobody@example.com", from(2));

    for (const { res, body } of [known, nobody]) {
      expect(res.status).toBe(202);
      expect(Object.keys(body).toSorted()).toEqual([
        "claimSecret",
        "expiresAt",
        "pairingCode",
        "requestId",
      ]);
      expect(body.requestId).toMatch(/^recovery_[a-f0-9]{12}$/);
      expect(body.claimSecret).toMatch(/^[a-f0-9]{64}$/);
      expect(body.pairingCode).toMatch(/^[0-9]{2}$/);
      expect(body.expiresAt).toBeGreaterThan(Date.now() / 1000 + 9 * 60);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(recoveryLinksTo(h.recorded(), "rl-known@example.com")).toBe(1);
    expect(h.recorded().filter((m) => m.to === "rl-nobody@example.com")).toEqual([]);
  });

  it("refuses a handle, and mails nothing", async () => {
    const h = harness();
    await h.seed("rl-handle@example.com", "rlhandle");
    const { res } = await beginRecoveryThroughRoutes(h.app, "rlhandle", from(1));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(h.recorded()).toEqual([]);
  });

  it("polls alike over the request's whole life", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();
    await h.seed("rl-life@example.com", "rllife");
    const known = await beginRecoveryThroughRoutes(h.app, "rl-life@example.com", from(1));
    const nobody = await beginRecoveryThroughRoutes(h.app, "rl-nolife@example.com", from(2));

    const answers = async () => {
      const a = await recoveryStatusThroughRoutes(
        h.app,
        known.body.requestId,
        known.body.claimSecret,
        from(1),
      );
      const b = await recoveryStatusThroughRoutes(
        h.app,
        nobody.body.requestId,
        nobody.body.claimSecret,
        from(2),
      );
      return {
        known: { status: a.status, body: pollShape(await a.json()) },
        nobody: { status: b.status, body: pollShape(await b.json()) },
      };
    };

    const atStart = await answers();
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    const midway = await answers();
    vi.setSystemTime(Date.now() + 6 * MINUTE);
    const after = await answers();

    expect(atStart.nobody).toEqual(atStart.known);
    expect(midway.nobody).toEqual(midway.known);
    expect(after.nobody).toEqual(after.known);
    expect(atStart.known).toEqual({
      status: 200,
      body: { status: "pending", pairingCode: "two digits" },
    });
    expect(after.known).toEqual({ status: 200, body: { status: "expired" } });
  });

  it("resends alike, and mails only the account", async () => {
    const h = harness();
    await h.seed("rl-resend@example.com", "rlresend");
    const known = await beginRecoveryThroughRoutes(h.app, "rl-resend@example.com", from(1));
    const nobody = await beginRecoveryThroughRoutes(h.app, "rl-noresend@example.com", from(2));

    const a = await recoveryResendThroughRoutes(
      h.app,
      known.body.requestId,
      known.body.claimSecret,
      from(1),
    );
    const b = await recoveryResendThroughRoutes(
      h.app,
      nobody.body.requestId,
      nobody.body.claimSecret,
      from(2),
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(a.status);
    expect(await a.json()).toEqual({ status: "sent" });
    expect(await b.json()).toEqual({ status: "sent" });
    expect(recoveryLinksTo(h.recorded(), "rl-resend@example.com")).toBe(2);
    expect(h.recorded().filter((m) => m.to === "rl-noresend@example.com")).toEqual([]);
  });
});

describe("the limits on recovery mail", () => {
  it("a begin from another address gets its link after one address used its allowance and the account's Resends", async () => {
    const h = harness();
    await h.seed("rl-owner@example.com", "rlowner");
    const owner = "rl-owner@example.com";

    // One address uses up its allowance...
    const theirs = [];
    for (let i = 0; i < RECOVERY_LINKS_PER_ADDRESS_MAX; i++) theirs.push(await begun(h, owner, 1));
    const fourth = await beginRecoveryThroughRoutes(h.app, owner, from(1));
    expect(fourth.res.status).toBe(202);
    expect(Object.keys(fourth.body).toSorted()).toEqual([
      "claimSecret",
      "expiresAt",
      "pairingCode",
      "requestId",
    ]);
    expect(recoveryLinksTo(h.recorded(), owner)).toBe(RECOVERY_LINKS_PER_ADDRESS_MAX);

    // ...and, from other addresses, the account's Resends for the day.
    for (let i = 0; i < RECOVERY_RESENDS_PER_ACCOUNT_MAX; i++) {
      const r = theirs[i % theirs.length]!;
      const res = await recoveryResendThroughRoutes(
        h.app,
        r.requestId,
        r.claimSecret,
        from(10 + i),
      );
      expect(await res.json()).toEqual({ status: "sent" });
    }
    const spent = theirs[0]!;
    const over = await recoveryResendThroughRoutes(
      h.app,
      spent.requestId,
      spent.claimSecret,
      from(20),
    );
    expect(await over.json()).toEqual({ status: "sent" });
    const mailed = RECOVERY_LINKS_PER_ADDRESS_MAX + RECOVERY_RESENDS_PER_ACCOUNT_MAX;
    expect(recoveryLinksTo(h.recorded(), owner)).toBe(mailed);

    // A begin from another address still gets its link.
    await begun(h, owner, 2);
    expect(recoveryLinksTo(h.recorded(), owner)).toBe(mailed + 1);
  });

  it("caps an account's recovery mail a day, whatever addresses ask, and only that account's", async () => {
    const h = harness();
    await h.seed("rl-flood@example.com", "rlflood");
    await h.seed("rl-other@example.com", "rlother");
    const owner = "rl-flood@example.com";
    for (let sent = 0; sent < RECOVERY_LINKS_PER_ACCOUNT_CEILING; sent++) {
      await begun(h, owner, 100 + Math.floor(sent / RECOVERY_LINKS_PER_ADDRESS_MAX));
    }
    const fresh =
      100 + Math.ceil(RECOVERY_LINKS_PER_ACCOUNT_CEILING / RECOVERY_LINKS_PER_ADDRESS_MAX);

    const over = await beginRecoveryThroughRoutes(h.app, owner, from(fresh));
    const nobody = await beginRecoveryThroughRoutes(
      h.app,
      "rl-nobody-flood@example.com",
      from(fresh),
    );
    expect(over.res.status).toBe(nobody.res.status);
    expect(Object.keys(over.body).toSorted()).toEqual(Object.keys(nobody.body).toSorted());
    expect(recoveryLinksTo(h.recorded(), owner)).toBe(RECOVERY_LINKS_PER_ACCOUNT_CEILING);

    // Another account's mail is its own.
    await begun(h, "rl-other@example.com", fresh);
  });
});

describe("the account lockout", () => {
  it("wrong link secrets end only their own request, and lock nothing", async () => {
    const h = harness();
    const profile = await h.seed("rl-secret@example.com", "rlsecret");
    const owner = await begun(h, "rl-secret@example.com", 1);
    const stranger = await begun(h, "rl-secret@example.com", 2);

    for (let i = 0; i < 6; i++) {
      const res = await confirm(h, stranger.requestId, WRONG_SECRET, stranger.pairingCode, 2);
      expect(await res.json()).toEqual({ status: "expired" });
    }
    // Five wrong secrets ended the stranger's request...
    const late = await confirm(
      h,
      stranger.requestId,
      stranger.link.linkSecret,
      stranger.pairingCode,
      2,
    );
    expect(await late.json()).toEqual({ status: "expired" });

    // ...and nothing else: the owner's request confirms and completes.
    const right = await confirm(h, owner.requestId, owner.link.linkSecret, owner.pairingCode, 1);
    expect(await right.json()).toEqual({ status: "confirmed" });
    const done = await recoveryStatusThroughRoutes(
      h.app,
      owner.requestId,
      owner.claimSecret,
      from(1),
    );
    expect(done.status).toBe(201);
    expect(await h.events(profile.accountId)).not.toContain("recovery_otp_lockout");
  });

  it("five wrong typed numbers lock the account: a right number is refused, nothing more is mailed", async () => {
    const h = harness();
    const profile = await h.seed("rl-lock@example.com", "rllock");
    // Seven requests, each mailed from an address of its own, before any strike.
    const requests = [];
    for (let n = 1; n <= 7; n++) requests.push(await begun(h, "rl-lock@example.com", n));
    const [a, b, c, d, e, held, extra] = requests as [
      (typeof requests)[number],
      (typeof requests)[number],
      (typeof requests)[number],
      (typeof requests)[number],
      (typeof requests)[number],
      (typeof requests)[number],
      (typeof requests)[number],
    ];

    for (const [i, r] of [a, b, c, d, e].entries()) {
      const res = await confirm(
        h,
        r.requestId,
        r.link.linkSecret,
        wrongNumber(r.pairingCode),
        30 + i,
      );
      expect(await res.json()).toEqual({ status: "expired" });
      // A wrong number ends its request at once.
      const after = await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode, 30 + i);
      expect(await after.json()).toEqual({ status: "expired" });
    }
    expect(await h.events(profile.accountId)).toEqual(["recovery_otp_lockout"]);

    const right = await confirm(h, held.requestId, held.link.linkSecret, held.pairingCode);
    expect(await right.json()).toEqual({ status: "expired" });
    const polled = await recoveryStatusThroughRoutes(
      h.app,
      held.requestId,
      held.claimSecret,
      from(6),
    );
    expect(await polled.json()).toEqual({ status: "expired" });
    expect(polled.headers.getSetCookie()).toEqual([]);

    const after = await beginRecoveryThroughRoutes(h.app, "rl-lock@example.com", from(8));
    expect(after.res.status).toBe(202);
    expect(recoveryLinksTo(h.recorded(), "rl-lock@example.com")).toBe(7);

    // One more wrong number past the threshold writes no second row.
    await confirm(h, extra.requestId, extra.link.linkSecret, wrongNumber(extra.pairingCode));
    expect(await h.events(profile.accountId)).toEqual(["recovery_otp_lockout"]);
  });

  it("anything but digits or a decline is refused alike, and spends nothing", async () => {
    const h = harness();
    await h.seed("rl-digits@example.com", "rldigits");
    const r = await begun(h, "rl-digits@example.com", 1);
    for (const typed of ["", "4a", "abc", "1234567", " 42", "-1", "4.2"]) {
      const res = await confirm(h, r.requestId, r.link.linkSecret, typed);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "expired" });
    }
    const right = await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode);
    expect(await right.json()).toEqual({ status: "confirmed" });
  });

  it("offers no candidates to read: the number is typed", async () => {
    const h = harness();
    await h.seed("rl-read@example.com", "rlread");
    const r = await begun(h, "rl-read@example.com", 1);
    const read = await candidatesThroughRoutes(h.app, r.requestId, r.link.linkSecret, from(1));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ status: "expired" });
    const unknown = await candidatesThroughRoutes(
      h.app,
      "recovery_000000000000",
      r.link.linkSecret,
      from(1),
    );
    expect(await unknown.json()).toEqual({ status: "expired" });
    // The read spent nothing.
    const right = await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode);
    expect(await right.json()).toEqual({ status: "confirmed" });
  });

  it("a decline counts no strike, and records one event", async () => {
    const h = harness();
    const profile = await h.seed("rl-decline@example.com", "rldecline");
    for (let n = 1; n <= 6; n++) {
      const r = await begun(h, "rl-decline@example.com", n);
      const res = await confirm(h, r.requestId, r.link.linkSecret, "none", n);
      expect(await res.json()).toEqual({ status: "declined" });
      // The same decline sent again is answered the same, and recorded once.
      const again = await confirm(h, r.requestId, r.link.linkSecret, "none", n);
      expect(await again.json()).toEqual({ status: "declined" });
      const polled = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(n));
      expect(await polled.json()).toEqual({ status: "expired" });
    }
    expect(await h.events(profile.accountId)).toEqual(
      Array.from({ length: 6 }, () => "recovery_link_declined"),
    );
    const last = await begun(h, "rl-decline@example.com", 7);
    const right = await confirm(h, last.requestId, last.link.linkSecret, last.pairingCode, 7);
    expect(await right.json()).toEqual({ status: "confirmed" });
    const done = await recoveryStatusThroughRoutes(
      h.app,
      last.requestId,
      last.claimSecret,
      from(7),
    );
    expect(done.status).toBe(201);
  });

  it("a counter that cannot be read refuses a right pick and keeps the request", async () => {
    const real = createInMemoryRecoveryLockoutStore();
    let unreadable = false;
    const store: RecoveryLockoutStore = {
      backend: "memory",
      status: (key): Promise<LockoutReading> =>
        unreadable ? Promise.resolve({ status: "unknown" }) : real.status(key),
      recordFailure: (key) => real.recordFailure(key),
      reset: (key, failures) => real.reset(key, failures),
    };
    const h = harness({ recoveryOtpLockoutStore: store });
    const profile = await h.seed("rl-unk@example.com", "rlunk");
    const r = await begun(h, "rl-unk@example.com", 1);

    unreadable = true;
    const refused = await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode, 1);
    expect(refused.status).toBe(503);
    const polled = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(pollShape(await polled.json())).toEqual({
      status: "pending",
      pairingCode: "two digits",
    });
    expect(await h.events(profile.accountId)).toEqual([]);

    unreadable = false;
    const confirmed = await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode, 1);
    expect(await confirmed.json()).toEqual({ status: "confirmed" });
  });
});

describe("only the tab holding the claim secret gets a session", () => {
  it("the confirming device gets none; the claim gets the restricted session, once", async () => {
    const h = harness();
    await h.seed("rl-claim@example.com", "rlclaim");
    const r = await begun(h, "rl-claim@example.com", 1);

    const confirmed = await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode, 9);
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.getSetCookie()).toEqual([]);
    expect(await confirmed.json()).toEqual({ status: "confirmed" });

    const stranger = await recoveryStatusThroughRoutes(h.app, r.requestId, "f".repeat(64), from(9));
    expect(stranger.status).toBe(200);
    expect(stranger.headers.getSetCookie()).toEqual([]);
    expect(await stranger.json()).toEqual({ status: "expired" });

    const claimed = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(claimed.status).toBe(201);
    expect(claimed.headers.get("cache-control")).toBe("no-store");
    expect(claimed.headers.getSetCookie().some((c) => c.startsWith("osn_session="))).toBe(true);
    const body = (await claimed.json()) as {
      status: string;
      session: Record<string, unknown> & { access_token: string };
      profile: { handle: string };
    };
    expect(Object.keys(body).toSorted()).toEqual(["profile", "session", "status"]);
    expect(body.status).toBe("complete");
    expect(body.profile.handle).toBe("rlclaim");
    expect(Object.keys(body.session).toSorted()).toEqual([
      "access_token",
      "expires_in",
      "scope",
      "token_type",
    ]);
    expect(payloadOf(body.session.access_token)["aud"]).toBe(RECOVERY_TOKEN_AUDIENCE);

    const again = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(again.headers.getSetCookie()).toEqual([]);
    expect(await again.json()).toEqual({ status: "expired" });
  });

  it("two polls at once with the claim secret get one session between them", async () => {
    const h = harness();
    await h.seed("rl-race@example.com", "rlrace");
    const r = await begun(h, "rl-race@example.com", 1);
    const confirmed = await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode, 9);
    expect(await confirmed.json()).toEqual({ status: "confirmed" });

    const polls = await Promise.all(
      [1, 2].map(() => recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1))),
    );
    expect(polls.map((p) => p.status).toSorted()).toEqual([200, 201]);
    expect(polls.filter((p) => p.headers.getSetCookie().length > 0)).toHaveLength(1);
  });

  it("a confirm sent again before the claim answers confirmed, and the claim still lands", async () => {
    const h = harness();
    await h.seed("rl-repeat@example.com", "rlrepeat");
    const r = await begun(h, "rl-repeat@example.com", 1);
    for (let i = 0; i < 2; i++) {
      const res = await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode, 9);
      expect(await res.json()).toEqual({ status: "confirmed" });
    }
    const claimed = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(claimed.status).toBe(201);
  });

  it("an expired link confirms, reads, polls and resends nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();
    await h.seed("rl-old@example.com", "rlold");
    const r = await begun(h, "rl-old@example.com", 1);
    vi.setSystemTime(Date.now() + 11 * MINUTE);

    const confirmed = await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode, 1);
    expect(await confirmed.json()).toEqual({ status: "expired" });
    const read = await candidatesThroughRoutes(h.app, r.requestId, r.link.linkSecret, from(1));
    expect(await read.json()).toEqual({ status: "expired" });
    const polled = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(await polled.json()).toEqual({ status: "expired" });
    const resent = await recoveryResendThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(await resent.json()).toEqual({ status: "expired" });
  });

  it("a request begun before the account's email changed is not claimed", async () => {
    const h = harness();
    const profile = await h.seed("rl-moved@example.com", "rlmoved");
    const r = await begun(h, "rl-moved@example.com", 1);
    await h.db
      .update(accounts)
      .set({ email: "rl-new@example.com" })
      .where(eq(accounts.id, profile.accountId));

    const confirmed = await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode, 1);
    expect(await confirmed.json()).toEqual({ status: "confirmed" });
    const polled = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(polled.headers.getSetCookie()).toEqual([]);
    expect(await polled.json()).toEqual({ status: "expired" });
  });
});

describe("a poll whose finish fails after the claim", () => {
  it("a session that would not write after the recovery committed is finished by the next poll", async () => {
    const h = harness();
    const profile = await h.seed("rl-fault@example.com", "rlfault");
    const r = await begun(h, "rl-fault@example.com", 1);
    await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode, 9);

    // The wipe, the audit row and the cooldown commit; the session's insert
    // fails, as a database fault would.
    h.sqlite.run(`
      CREATE TRIGGER refuse_sessions BEFORE INSERT ON sessions
      BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: sessions'); END;
    `);
    const failed = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(failed.status).toBe(500);
    expect(failed.headers.getSetCookie()).toEqual([]);
    h.sqlite.run("DROP TRIGGER refuse_sessions");
    const [committed] = await h.db
      .select({ lastRecoveredAt: accounts.lastRecoveredAt })
      .from(accounts)
      .where(eq(accounts.id, profile.accountId));
    expect(committed!.lastRecoveredAt).not.toBeNull();

    // The next poll is the same recovery, not a second one the cooldown refuses.
    const done = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(done.status).toBe(201);
    expect(done.headers.getSetCookie().some((c) => c.startsWith("osn_session="))).toBe(true);
    const body = (await done.json()) as { session: { access_token: string } };
    expect(payloadOf(body.session.access_token)["aud"]).toBe(RECOVERY_TOKEN_AUDIENCE);
    expect(
      (await h.events(profile.accountId)).filter((kind) => kind === "account_recovered"),
    ).toHaveLength(1);
    const [after] = await h.db
      .select({ lastRecoveredAt: accounts.lastRecoveredAt })
      .from(accounts)
      .where(eq(accounts.id, profile.accountId));
    expect(after!.lastRecoveredAt).toBe(committed!.lastRecoveredAt);

    // Delivered once: the request is spent.
    const again = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(again.headers.getSetCookie()).toEqual([]);
    expect(await again.json()).toEqual({ status: "expired" });
  });
});

describe("a request belongs to its own flow", () => {
  it("a recovery request polled as a sign-up, and a sign-up polled as a recovery, are unknown", async () => {
    const h = harness();
    await h.seed("rl-cross@example.com", "rlcross");
    const recovery = await begun(h, "rl-cross@example.com", 1);
    const { body: signUp } = await beginThroughRoutes(
      h.app,
      { email: "rl-signup@example.com", handle: "rlsignup" },
      from(2),
    );
    const signUpLink = latestLinkTo(h.recorded(), "rl-signup@example.com")!;

    // Both confirmed, so only the flow check stands between each and a session.
    await confirm(h, recovery.requestId, recovery.link.linkSecret, recovery.pairingCode, 1);
    await confirm(h, signUp.requestId, signUpLink.linkSecret, signUp.pairingCode, 2);

    expect(
      await h.svc(h.auth.registrationStatus(recovery.requestId, recovery.claimSecret)),
    ).toEqual({ status: "expired" });
    expect(await h.svc(h.auth.emailRecoveryStatus(signUp.requestId, signUp.claimSecret))).toEqual({
      status: "expired",
    });

    const asSignUp = await settledHandle(
      h.app,
      new Request(`http://localhost/register/${recovery.requestId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...from(1) },
        body: JSON.stringify({ claimSecret: recovery.claimSecret }),
      }),
    );
    expect(asSignUp.status).toBeGreaterThanOrEqual(400);
    expect(asSignUp.headers.getSetCookie()).toEqual([]);
    const asRecovery = await recoveryStatusThroughRoutes(
      h.app,
      signUp.requestId,
      signUp.claimSecret,
      from(2),
    );
    expect(asRecovery.status).toBeGreaterThanOrEqual(400);
    expect(asRecovery.headers.getSetCookie()).toEqual([]);

    // Neither poll spent the other flow's request: each finishes its own.
    const mine = await recoveryStatusThroughRoutes(
      h.app,
      recovery.requestId,
      recovery.claimSecret,
      from(1),
    );
    expect(mine.status).toBe(201);
    const theirs = await settledHandle(
      h.app,
      new Request(`http://localhost/register/${signUp.requestId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...from(2) },
        body: JSON.stringify({ claimSecret: signUp.claimSecret }),
      }),
    );
    expect(theirs.status).toBe(201);
  });
});

describe("completion", () => {
  it("revokes every other session, records the recovery and mails the notice", async () => {
    const h = harness();
    const profile = await h.seed("rl-done@example.com", "rldone");
    await h.svc(
      h.auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
    const before = await h.db
      .select()
      .from(sessions)
      .where(eq(sessions.accountId, profile.accountId));
    expect(before).toHaveLength(1);

    const r = await begun(h, "rl-done@example.com", 1);
    await confirm(h, r.requestId, r.link.linkSecret, r.pairingCode, 9);
    const claimed = await recoveryStatusThroughRoutes(h.app, r.requestId, r.claimSecret, from(1));
    expect(claimed.status).toBe(201);

    const after = await h.db
      .select()
      .from(sessions)
      .where(eq(sessions.accountId, profile.accountId));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(before[0]!.id);
    expect(after[0]!.restrictedUntil).not.toBeNull();
    expect(after[0]!.restrictedAmr).toBe("otp");
    expect(await h.events(profile.accountId)).toContain("account_recovered");
    const [account] = await h.db
      .select({ lastRecoveredAt: accounts.lastRecoveredAt })
      .from(accounts)
      .where(eq(accounts.id, profile.accountId));
    expect(account!.lastRecoveredAt).not.toBeNull();
    const notices = h.recorded().filter((m) => m.template === "recovery-used");
    expect(notices.map((m) => m.to)).toEqual(["rl-done@example.com"]);
  });

  it(
    "answers begin without waiting for the send, and the send still lands",
    // Shorter than the send's own 10-second timeout, so an awaited send fails
    // here rather than passing slowly.
    { timeout: 4000 },
    async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sent: SendEmailInput[] = [];
      const hanging = Layer.succeed(EmailService, {
        send: (input: SendEmailInput) =>
          Effect.promise(async () => {
            await gate;
            sent.push(input);
          }),
      });
      const h = harness({}, hanging);
      await h.seed("rl-hang@example.com", "rlhang");

      const res = await h.app.handle(
        new Request("http://localhost/login/recovery/email/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...from(1) },
          body: JSON.stringify({ identifier: "rl-hang@example.com" }),
        }),
      );
      expect(res.status).toBe(202);
      expect(sent).toHaveLength(0);

      release();
      for (let i = 0; i < 100 && sent.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(sent.map((s) => [s.template, s.to])).toEqual([
        ["link-recovery", "rl-hang@example.com"],
      ]);
    },
  );
});
