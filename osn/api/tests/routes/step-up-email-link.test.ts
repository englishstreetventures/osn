/**
 * Step-up and email change through the emailed link, over the routes: the
 * refusals each flow must make. A `GET` never approves; a wrong number and a
 * decline end the request; a link-minted step-up token passes only the gates
 * whose allow-list admits an emailed factor, and only for the purpose the
 * request was begun for; a taken new address answers as a free one; the
 * result reaches only the tab holding the claim secret, signed in as the
 * account that began; and one flow's request is no other flow's. The happy
 * paths end to end are the E2E flow `musubi-step-up-email`.
 */

import { Database } from "bun:sqlite";

import { accounts, securityEvents } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuthService, type AuthConfig } from "../../src/services/auth";
import { createDefaultCeremonyStores } from "../../src/services/auth/stores";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settledHandle } from "../helpers/background";
import { beginThroughRoutes, latestLinkTo } from "../helpers/registration";
import { createAuthRoutes } from "../helpers/routes";
import {
  beginEmailChangeThroughRoutes,
  beginStepUpThroughRoutes,
  completeEmailChangeThroughRoutes,
  confirmLinkThroughRoutes,
  emailChangeStatusThroughRoutes,
  linkForRequest,
  stepUpStatusThroughRoutes,
  stepUpThroughService,
} from "../helpers/step-up-link";

let config: AuthConfig;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

const WRONG_SECRET = "0".repeat(64);

/** A route app, a service and the raw database over one layer. */
function harness() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle({ client: sqlite });
  const mail = makeLogEmailLive();
  const layer = Layer.merge(Layer.succeed(Db, { db }), mail.layer);
  const merged = { ...config, ceremonyStores: createDefaultCeremonyStores() };
  const app = createAuthRoutes(merged, layer);
  const auth = createAuthService(merged);
  const svc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
  /** An account and an access token for it. */
  const signedIn = async (email: string, handle: string) => {
    const profile = await svc(auth.registerProfile(email, handle));
    const tokens = await svc(
      auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
    return { profile, accessToken: tokens.accessToken };
  };
  return { app, auth, db, svc, signedIn, recorded: () => mail.recorded() };
}

type Harness = ReturnType<typeof harness>;

/** A typed or picked number that is not `right`. */
const wrongNumber = (right: string): string => (right === "10" ? "11" : "10");

const payloadOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

/** A begun step-up for `purpose` and the link mailed for it. */
async function begunStepUp(h: Harness, accessToken: string, purpose = "account_export" as const) {
  const { res, body } = await beginStepUpThroughRoutes(h.app, accessToken, purpose);
  expect(res.status).toBe(200);
  const link = linkForRequest(h.recorded(), body.requestId);
  expect(link).not.toBeNull();
  return { ...body, link: link! };
}

const statusBody = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("a GET never approves", () => {
  it("answers 404 on every route of a step-up request and leaves it pending", async () => {
    const h = harness();
    const { accessToken } = await h.signedIn("f1@example.com", "fone");
    const begun = await begunStepUp(h, accessToken);
    for (const path of [
      `/email-link/${begun.requestId}/confirm`,
      `/email-link/${begun.requestId}/candidates`,
      `/step-up/email/${begun.requestId}/status`,
    ]) {
      const res = await settledHandle(
        h.app,
        new Request(`http://localhost${path}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    const polled = await statusBody(
      await stepUpStatusThroughRoutes(h.app, accessToken, begun.requestId, begun.claimSecret),
    );
    expect(polled).toEqual({ status: "pending", pairingCode: begun.pairingCode });
  });
});

describe("a wrong number ends the request", () => {
  it("refuses the wrong number, then the right one, and the poll reads expired", async () => {
    const h = harness();
    const { accessToken } = await h.signedIn("f2@example.com", "ftwo");
    const begun = await begunStepUp(h, accessToken);
    const wrong = await confirmLinkThroughRoutes(
      h.app,
      begun.requestId,
      begun.link.linkSecret,
      wrongNumber(begun.pairingCode),
    );
    expect(await statusBody(wrong)).toEqual({ status: "expired" });
    const right = await confirmLinkThroughRoutes(
      h.app,
      begun.requestId,
      begun.link.linkSecret,
      begun.pairingCode,
    );
    expect(await statusBody(right)).toEqual({ status: "expired" });
    const polled = await stepUpStatusThroughRoutes(
      h.app,
      accessToken,
      begun.requestId,
      begun.claimSecret,
    );
    expect(await statusBody(polled)).toEqual({ status: "expired" });
  });
});

describe("a decline ends the request", () => {
  it("answers declined, the poll reads expired, and no security event is written", async () => {
    const h = harness();
    const { profile, accessToken } = await h.signedIn("f3@example.com", "fthree");
    const begun = await begunStepUp(h, accessToken);
    const declined = await confirmLinkThroughRoutes(
      h.app,
      begun.requestId,
      begun.link.linkSecret,
      "none",
    );
    expect(await statusBody(declined)).toEqual({ status: "declined" });
    const polled = await stepUpStatusThroughRoutes(
      h.app,
      accessToken,
      begun.requestId,
      begun.claimSecret,
    );
    expect(await statusBody(polled)).toEqual({ status: "expired" });
    const rows = await h.db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.accountId, profile.accountId));
    expect(rows).toEqual([]);
  });
});

describe("a link-minted token passes only the gates that admit an emailed factor", () => {
  it("is refused at passkey_delete and accepted at email_change and account_export", async () => {
    const h = harness();
    const { profile } = await h.signedIn("f4@example.com", "ffour");
    const mint = (purpose: "passkey_delete" | "email_change" | "account_export") =>
      h.svc(stepUpThroughService(h.auth, profile.accountId, purpose, h.recorded));

    const forDelete = await mint("passkey_delete");
    const refused = await h.svc(
      h.auth.verifyStepUpForPasskeyDelete(profile.accountId, forDelete, "pk_any").pipe(Effect.flip),
    );
    expect(refused._tag).toBe("AuthError");
    expect(refused.message).toBe("Step-up factor not permitted");

    const forChange = await mint("email_change");
    await h.svc(h.auth.verifyStepUpForEmailChange(profile.accountId, forChange));
    const forExport = await mint("account_export");
    await h.svc(h.auth.verifyStepUpForAccountExport(profile.accountId, forExport));
  });
});

describe("a link for one purpose mints no token for another", () => {
  it("names the purpose the request was begun for, which other gates refuse", async () => {
    const h = harness();
    const { profile, accessToken } = await h.signedIn("f5@example.com", "ffive");
    const begun = await begunStepUp(h, accessToken, "account_export");
    await confirmLinkThroughRoutes(
      h.app,
      begun.requestId,
      begun.link.linkSecret,
      begun.pairingCode,
    );
    const done = await statusBody(
      await stepUpStatusThroughRoutes(h.app, accessToken, begun.requestId, begun.claimSecret),
    );
    expect(done.status).toBe("complete");
    const token = done.step_up_token as string;
    expect(payloadOf(token).purpose).toBe("account_export");
    expect(payloadOf(token).amr).toEqual(["otp"]);

    for (const verify of [
      h.auth.verifyStepUpForAccountDelete(profile.accountId, token),
      h.auth.verifyStepUpForEmailChange(profile.accountId, token),
      h.auth.verifyStepUpForRecoveryGenerate(profile.accountId, token),
    ]) {
      const refused = await h.svc(verify.pipe(Effect.flip));
      expect(refused._tag).toBe("AuthError");
    }
    // The purpose it was begun for still takes it: the refusals above spent nothing.
    await h.svc(h.auth.verifyStepUpForAccountExport(profile.accountId, token));
  });
});

describe("an email change to a taken address answers as a free one", () => {
  it("answers the same shape, mails only the free address, and the taken one waits", async () => {
    const h = harness();
    await h.signedIn("taken@example.com", "takenone");
    const { accessToken } = await h.signedIn("f6@example.com", "fsix");
    const free = await beginEmailChangeThroughRoutes(h.app, accessToken, "free@example.com");
    const taken = await beginEmailChangeThroughRoutes(h.app, accessToken, "Taken@example.com");
    for (const { res, body } of [free, taken]) {
      expect(res.status).toBe(200);
      expect(Object.keys(body).toSorted()).toEqual([
        "claimSecret",
        "expiresAt",
        "pairingCode",
        "requestId",
      ]);
      expect(body.requestId).toMatch(/^emailchange_[a-f0-9]{12}$/);
      expect(body.pairingCode).toMatch(/^[0-9]{2}$/);
    }
    expect(h.recorded().filter((m) => m.to === "free@example.com")).toHaveLength(1);
    expect(h.recorded().filter((m) => m.to === "taken@example.com")).toHaveLength(0);
    const polled = await emailChangeStatusThroughRoutes(
      h.app,
      accessToken,
      taken.body.requestId,
      taken.body.claimSecret,
    );
    expect(await statusBody(polled)).toEqual({
      status: "pending",
      pairingCode: taken.body.pairingCode,
    });
  });
});

describe("the result reaches only the tab holding the claim secret", () => {
  it("step-up: the confirm carries nothing; a wrong secret or another account gets nothing; one token, once", async () => {
    const h = harness();
    const { accessToken } = await h.signedIn("f7@example.com", "fseven");
    const other = await h.signedIn("f7-other@example.com", "fsevenother");
    const begun = await begunStepUp(h, accessToken);

    const confirmed = await confirmLinkThroughRoutes(
      h.app,
      begun.requestId,
      begun.link.linkSecret,
      begun.pairingCode,
    );
    expect(confirmed.headers.get("set-cookie")).toBeNull();
    expect(await statusBody(confirmed)).toEqual({ status: "confirmed" });

    const wrongSecret = await stepUpStatusThroughRoutes(
      h.app,
      accessToken,
      begun.requestId,
      WRONG_SECRET,
    );
    expect(await statusBody(wrongSecret)).toEqual({ status: "expired" });
    const otherAccount = await stepUpStatusThroughRoutes(
      h.app,
      other.accessToken,
      begun.requestId,
      begun.claimSecret,
    );
    expect(await statusBody(otherAccount)).toEqual({ status: "expired" });

    const claimed = await stepUpStatusThroughRoutes(
      h.app,
      accessToken,
      begun.requestId,
      begun.claimSecret,
    );
    expect(claimed.headers.get("set-cookie")).toBeNull();
    const body = await statusBody(claimed);
    expect(Object.keys(body).toSorted()).toEqual(["expires_in", "status", "step_up_token"]);
    expect(body.expires_in).toBe(300);
    const again = await stepUpStatusThroughRoutes(
      h.app,
      accessToken,
      begun.requestId,
      begun.claimSecret,
    );
    expect(await statusBody(again)).toEqual({ status: "expired" });
  });

  it("email change: another account cannot complete a request it did not begin", async () => {
    const h = harness();
    const owner = await h.signedIn("f7b@example.com", "fsevenb");
    const other = await h.signedIn("f7b-other@example.com", "fsevenbother");
    const { body } = await beginEmailChangeThroughRoutes(
      h.app,
      owner.accessToken,
      "moved@example.com",
    );
    const link = linkForRequest(h.recorded(), body.requestId)!;
    const confirmed = await confirmLinkThroughRoutes(
      h.app,
      body.requestId,
      link.linkSecret,
      body.pairingCode,
    );
    expect(await statusBody(confirmed)).toEqual({ status: "confirmed" });

    const otherToken = await h.svc(
      stepUpThroughService(h.auth, other.profile.accountId, "email_change", h.recorded),
    );
    const refused = await completeEmailChangeThroughRoutes(
      h.app,
      other.accessToken,
      body.requestId,
      body.claimSecret,
      otherToken,
    );
    expect(refused.status).toBe(400);
    const [ownerRow] = await h.db
      .select({ email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, owner.profile.accountId));
    const [otherRow] = await h.db
      .select({ email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, other.profile.accountId));
    expect(ownerRow?.email).toBe("f7b@example.com");
    expect(otherRow?.email).toBe("f7b-other@example.com");
  });
});

describe("one flow's request is no other flow's", () => {
  it("refuses a step-up id at the sign-up and email-change routes, and a sign-up id at step-up's", async () => {
    const h = harness();
    const { profile, accessToken } = await h.signedIn("f8@example.com", "feight");
    const begun = await begunStepUp(h, accessToken);
    await confirmLinkThroughRoutes(
      h.app,
      begun.requestId,
      begun.link.linkSecret,
      begun.pairingCode,
    );

    // At the routes, another flow's prefix fails the parameter pattern.
    for (const path of [
      `/register/${begun.requestId}/status`,
      `/login/recovery/email/${begun.requestId}/status`,
      `/account/email/${begun.requestId}/status`,
    ]) {
      const res = await settledHandle(
        h.app,
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ claimSecret: begun.claimSecret }),
        }),
      );
      // A refusal of the request, never a server error.
      expect({ path, refused: res.status >= 400 && res.status < 500 }).toEqual({
        path,
        refused: true,
      });
    }
    // In the service, where no pattern stands in front, another flow's status reads it as unknown.
    expect(await h.svc(h.auth.registrationStatus(begun.requestId, begun.claimSecret))).toEqual({
      status: "expired",
    });
    expect(
      await h.svc(h.auth.emailChangeStatus(profile.accountId, begun.requestId, begun.claimSecret)),
    ).toEqual({ status: "expired" });

    const signUp = await beginThroughRoutes(h.app, {
      email: "f8-signup@example.com",
      handle: "feightsignup",
    });
    const signUpLink = latestLinkTo(h.recorded(), "f8-signup@example.com")!;
    expect(signUpLink.requestId).toMatch(/^signup_/);
    const atStepUp = await stepUpStatusThroughRoutes(
      h.app,
      accessToken,
      signUpLink.requestId,
      signUp.body.claimSecret,
    );
    expect(atStepUp.status).toBeGreaterThanOrEqual(400);
    expect(atStepUp.status).toBeLessThan(500);
    // The step-up request is untouched by the refusals: it still mints once.
    const done = await statusBody(
      await stepUpStatusThroughRoutes(h.app, accessToken, begun.requestId, begun.claimSecret),
    );
    expect(done.status).toBe("complete");
  });
});
