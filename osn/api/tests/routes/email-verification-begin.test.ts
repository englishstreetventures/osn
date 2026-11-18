/**
 * Sign-up with a browser Email Verification API token, over the routes. Each
 * case is a refusal or a uniformity the token path must keep: a taken address
 * answers as a free one and is mailed nothing, the flag off ignores a token
 * entirely, and a token is accepted once. The happy path end to end is the
 * E2E flow `musubi-email-verification`.
 */

import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuthService, type AuthConfig } from "../../src/services/auth";
import { createAuthContext } from "../../src/services/auth/context";
import { createIssuerNetwork } from "../../src/services/auth/email-verification-network";
import { createEmailVerificationModule } from "../../src/services/auth/email-verification-token";
import { createInMemoryChallengeClaimStore } from "../../src/services/auth/stores";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";
import { createFakeIssuer, type FakeIssuer } from "../helpers/email-verification";
import {
  beginThroughRoutes,
  linksTo,
  registerThroughRoutes,
  statusThroughRoutes,
} from "../helpers/registration";
import { createAuthRoutes } from "../helpers/routes";

/** The test config's origin, which `frontendOrigin` answers: the token's audience. */
const AUDIENCE = "http://localhost:5173";

let base: AuthConfig;
let issuer: FakeIssuer;

beforeAll(async () => {
  // One pepper, so a nonce one app minted opens in another.
  base = { ...(await makeTestAuthConfig()), sessionIpPepper: "test-pepper-email-verification" };
  issuer = await createFakeIssuer();
});

const flagOn = (): AuthConfig => ({
  ...base,
  emailVerification: { network: createIssuerNetwork(issuer.fetch) },
});

function harness(config: AuthConfig) {
  const mail = makeLogEmailLive();
  const app = createAuthRoutes(config, Layer.merge(createTestLayer(), mail.layer));
  return { app, recorded: () => mail.recorded() };
}

type App = ReturnType<typeof harness>["app"];

async function nonceFrom(app: App) {
  const res = await app.handle(
    new Request("http://localhost/register/email-verification-nonce", { method: "POST" }),
  );
  return {
    res,
    body:
      res.status === 200 ? ((await res.json()) as { nonce: string; nonceSecret: string }) : null,
  };
}

/** A begin carrying a token the stand-in issuer minted for `email` and this app's nonce. */
async function beginWithToken(app: App, email: string, handle: string, nonceApp: App = app) {
  const { body: minted } = await nonceFrom(nonceApp);
  if (!minted) throw new Error("no nonce");
  const token = await issuer.mint({ email, nonce: minted.nonce, aud: AUDIENCE });
  const begun = await beginThroughRoutes(app, {
    email,
    handle,
    emailVerificationToken: token,
    nonceSecret: minted.nonceSecret,
  });
  return { ...begun, token, nonceSecret: minted.nonceSecret };
}

const shape = (body: Record<string, unknown>) => ({
  keys: Object.keys(body).toSorted(),
  requestId: /^signup_[a-f0-9]{12}$/.test(String(body.requestId)),
  claimSecret: /^[a-f0-9]{64}$/.test(String(body.claimSecret)),
  pairingCode: /^[1-9][0-9]$/.test(String(body.pairingCode)),
  expiresAt: typeof body.expiresAt === "number",
});

describe("a taken address with a valid token", () => {
  it("answers begin exactly as a free address with a valid token and as the link path, is mailed nothing, and its poll stays pending", async () => {
    const h = harness(flagOn());
    const takenEmail = `taken@${issuer.domain}`;
    await registerThroughRoutes(h.app, h.recorded, takenEmail, "takenone");
    const mailedBefore = h.recorded().length;

    const free = await beginWithToken(h.app, `free@${issuer.domain}`, "freeone");
    const taken = await beginWithToken(h.app, takenEmail, "takentwo");
    const linkPath = await beginThroughRoutes(h.app, {
      email: "plain@example.com",
      handle: "plain",
    });

    expect(taken.res.status).toBe(200);
    expect(free.res.status).toBe(200);
    expect(linkPath.res.status).toBe(200);
    const takenShape = shape(taken.body as never);
    expect(takenShape).toEqual(shape(free.body as never));
    expect(takenShape).toEqual(shape(linkPath.body as never));

    // The free address verified: no link; the link path mailed one; the taken
    // address got nothing.
    expect(linksTo(h.recorded(), `free@${issuer.domain}`)).toHaveLength(0);
    expect(linksTo(h.recorded(), "plain@example.com")).toHaveLength(1);
    expect(
      h
        .recorded()
        .slice(mailedBefore)
        .filter((m) => m.to === takenEmail),
    ).toHaveLength(0);

    const takenPoll = await statusThroughRoutes(
      h.app,
      taken.body.requestId,
      taken.body.claimSecret,
    );
    expect(((await takenPoll.json()) as { status: string }).status).toBe("pending");
    const freePoll = await statusThroughRoutes(h.app, free.body.requestId, free.body.claimSecret);
    expect(freePoll.status).toBe(201);
  });
});

describe("the flag off", () => {
  it("answers the nonce route 404, and ignores the same valid token: the link goes and the poll stays pending", async () => {
    const on = harness(flagOn());
    const off = harness(base);

    expect((await nonceFrom(off.app)).res.status).toBe(404);

    const email = `off@${issuer.domain}`;
    // A token that would verify on the flag-on app, sent to the flag-off one.
    const begun = await beginWithToken(off.app, email, "offone", on.app);
    expect(begun.res.status).toBe(200);
    expect(linksTo(off.recorded(), email)).toHaveLength(1);
    const poll = await statusThroughRoutes(off.app, begun.body.requestId, begun.body.claimSecret);
    expect(((await poll.json()) as { status: string }).status).toBe("pending");
  });
});

describe("a token sent twice", () => {
  it("is accepted once; the second is refused as a replay", async () => {
    const config = flagOn();
    const module = createEmailVerificationModule(createAuthContext(config));
    const minted = module.mintNonce();
    if (!minted) throw new Error("no nonce");
    const email = `twice@${issuer.domain}`;
    const token = await issuer.mint({ email, nonce: minted.nonce, aud: AUDIENCE });
    const input = { emailVerificationToken: token, nonceSecret: minted.nonceSecret };

    expect(await Effect.runPromise(module.verify(email, input))).toBe(true);
    expect(await Effect.runPromise(module.verify(email, input))).toBe(false);
  });
});

describe("a begin with a token", () => {
  it("still runs the age gate first, and spends no nonce on a refused begin", async () => {
    // One claim store for the service and the module below, so a nonce the
    // begin spent would be refused there.
    const config: AuthConfig = {
      ...flagOn(),
      emailVerificationNonceClaims: createInMemoryChallengeClaimStore("email_verification_nonce"),
    };
    const auth = createAuthService(config);
    const minted = auth.emailVerificationNonce();
    if (!minted) throw new Error("no nonce");
    const email = `young@${issuer.domain}`;
    const token = await issuer.mint({ email, nonce: minted.nonce, aud: AUDIENCE });
    const layer = Layer.merge(createTestLayer(), makeLogEmailLive().layer);

    const tooYoung = await Effect.runPromise(
      Effect.result(
        auth
          .beginRegistration(email, "young", "2020-01-01", undefined, undefined, {
            emailVerificationToken: token,
            nonceSecret: minted.nonceSecret,
          })
          .pipe(Effect.provide(layer)),
      ),
    );
    expect(tooYoung._tag).toBe("Failure");
    // The nonce was not spent: the same token verifies after the refusal.
    const module = createEmailVerificationModule(createAuthContext(config));
    expect(
      await Effect.runPromise(
        module.verify(email, { emailVerificationToken: token, nonceSecret: minted.nonceSecret }),
      ),
    ).toBe(true);
  });
});
