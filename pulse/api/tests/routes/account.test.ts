import { Db } from "@pulse/db/service";
import { makeAccessTokenSigner, type AccessTokenSigner } from "@shared/crypto/testing";
import { Effect, ManagedRuntime } from "effect";
import { describe, it, expect, beforeAll, vi } from "vitest";

import { createTestLayer } from "../helpers/db";

/**
 * Route-level coverage for the `/account` group (T-R1). The DSAR-critical
 * handlers were rewired from per-request `Effect.provide(dbLayer)` to a
 * factory-scoped `ManagedRuntime` with `as Effect.Effect<…, Db>` casts —
 * these tests prove the runtime wiring the casts assert: one request per
 * handler through `runtime.runPromise`, plus the 401/403 gates.
 */
vi.mock("../../src/lib/osn-bridge", () => ({
  OsnBridgeError: class OsnBridgeError {
    _tag = "OsnBridgeError";
    constructor(public args: { cause: unknown }) {}
  },
  verifyStepUp: vi.fn(() => Effect.succeed({ ok: true, accountId: "acc_test" } as const)),
  notifyAppLeft: vi.fn(() => Effect.succeed({ closed: true } as const)),
}));

import { createAccountRoutes } from "../../src/routes/account";
import { webSessionService, type WebIdentity } from "../../src/services/webSession";
import { TEST_VERIFICATION } from "../helpers/verification";

let signer: AccessTokenSigner;
let testPublicKey: CryptoKey;

beforeAll(async () => {
  signer = await makeAccessTokenSigner();
  testPublicKey = signer.publicKey;
});

const makeToken = (profileId: string) => signer.sign(profileId);

function makeApp() {
  return createAccountRoutes(createTestLayer(), TEST_VERIFICATION, testPublicKey);
}

/**
 * An app plus a runtime over the SAME layer, so a session minted here is one
 * the app's own `resolveCaller` can read. `makeApp()` builds its layer
 * internally, which is right for a case that only needs isolation — but a
 * cookie test needs to write a session row the app will then look up.
 */
function makeAppWithSharedDb() {
  const layer = createTestLayer();
  return {
    app: createAccountRoutes(layer, TEST_VERIFICATION, testPublicKey),
    runtime: ManagedRuntime.make(layer),
  };
}

const identity: WebIdentity = {
  osnProfileId: "usr_cookie",
  osnSub: "pairwise-sub-for-pulse",
  email: "cookie@example.com",
  handle: "cookie",
  displayName: "Cookie",
  avatarUrl: null,
};

describe("account routes — auth gates", () => {
  // One app for the cases rejected inside `resolveCaller`, which never reach a
  // handler and so never touch the database — a fresh schema-applied in-memory
  // DB and a `ManagedRuntime` per case bought isolation nothing needed, and
  // left a sqlite handle open each time. The step-up case below is the
  // exception and says so.
  const app = makeApp();

  it.each([
    ["DELETE", "/account"],
    ["POST", "/account/restore"],
    ["GET", "/account/deletion-status"],
  ] as const)("%s %s returns 401 without a bearer token", async (method, path) => {
    const init: RequestInit =
      method === "DELETE"
        ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify({}) }
        : { method };
    const res = await app.handle(new Request(`http://localhost${path}`, init));
    expect(res.status).toBe(401);
  });

  it("GET /account/deletion-status returns 401 with an expired bearer token", async () => {
    // Route-level coverage: an access token that verifies structurally but
    // is past `exp` must be rejected at the route, not just at the
    // `resolveCaller` lib layer (see caller.test.ts). Distinct from a
    // stale *cookie session* — this is a bearer token, no cookie involved.
    const expired = await signer.sign("usr_expired", { expiresIn: "-120s" });
    const res = await app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { authorization: `Bearer ${expired}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("DELETE /account returns 403 without a step-up token", async () => {
    const token = await makeToken("usr_gate");
    // Its own app: this is the one case in the block that gets PAST
    // `resolveCaller` and reaches a handler, so it touches the database and
    // wants isolation like the runtime-wiring cases below.
    const res = await makeApp().handle(
      new Request("http://localhost/account", {
        method: "DELETE",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("step_up_required");
  });
});

// `/account` holds the DSAR-critical handlers, and the web app cannot present
// a bearer token — it authenticates with the `pulse_web_session` cookie that
// `makeCallerResolver` accepts as the second credential. Every case in this
// file used a bearer token, so if `createAccountRoutes` stopped forwarding
// `headers["cookie"]`, or a handler read `headers.authorization` directly
// instead of going through `resolveCaller`, every web client would lose
// delete, restore and deletion-status while the suite stayed green.
describe("account routes — cookie credential", () => {
  const mintCookie = async (runtime: ManagedRuntime.ManagedRuntime<Db, never>) => {
    const created = await runtime.runPromise(webSessionService.create(identity));
    return `pulse_web_session=${created.token}`;
  };

  it("GET /account/deletion-status authenticates with the session cookie", async () => {
    const { app, runtime } = makeAppWithSharedDb();
    const res = await app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { cookie: await mintCookie(runtime) },
      }),
    );
    expect(res.status).toBe(200);
    // The same body the bearer path returns — the credential decides who the
    // caller is, not what they get back.
    expect(await res.json()).toEqual({ scheduled: false });
  });

  it("POST /account/restore authenticates with the session cookie", async () => {
    const { app, runtime } = makeAppWithSharedDb();
    const res = await app.handle(
      new Request("http://localhost/account/restore", {
        method: "POST",
        headers: { cookie: await mintCookie(runtime) },
      }),
    );
    expect(res.status).toBe(200);
  });

  // The negative half: a cookie that names no live session is not a
  // credential. Without this the two cases above would pass just as happily
  // against a handler that ignored the cookie and authenticated nobody.
  it("returns 401 for a session cookie that names no live session", async () => {
    const { app } = makeAppWithSharedDb();
    const res = await app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { cookie: "pulse_web_session=not-a-real-token" },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("account routes — runtime wiring (ManagedRuntime)", () => {
  it("GET /deletion-status reaches the DB through the factory runtime", async () => {
    const token = await makeToken("usr_status");
    const res = await makeApp().handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scheduled: boolean }).scheduled).toBe(false);
  });

  it("POST /restore is a no-op 200 when nothing is scheduled", async () => {
    const token = await makeToken("usr_restore");
    const res = await makeApp().handle(
      new Request("http://localhost/account/restore", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cancelled: boolean }).cancelled).toBe(false);
  });

  it("DELETE /account schedules erasure (202) with verified step-up", async () => {
    const app = makeApp();
    const token = await makeToken("usr_delete");
    const res = await app.handle(
      new Request("http://localhost/account", {
        method: "DELETE",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ step_up_token: "stub-step-up" }),
      }),
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as { scheduled_for: string; already_pending: boolean };
    expect(json.already_pending).toBe(false);
    expect(json.scheduled_for).toBeTruthy();

    // Same runtime, same DB: the status endpoint now sees the scheduled row.
    const status = await app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(((await status.json()) as { scheduled: boolean }).scheduled).toBe(true);
  });
});
