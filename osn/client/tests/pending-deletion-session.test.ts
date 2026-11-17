import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOsnAuthRuntime, type SessionChange } from "../src/runtime";
import { OsnAuth } from "../src/service";
import { createEphemeralStorage } from "../src/storage";
import { isPendingDeletionToken } from "../src/tokens";

/**
 * A session of an account whose deletion is pending mints access tokens with
 * the audience `osn-pending-deletion`, which every route but the deletion
 * status, the export and the restore refuses with 401. Such a 401 says the
 * route will not serve the session, not that the session has ended: the
 * runtime keeps it, and tells its listeners when the audience it holds
 * changes. One test per way that can go wrong (NEW-FEAT.md, client tests 1–3).
 */

const ISSUER = "https://osn.example.com";
const API = `${ISSUER}/graph/connections`;
const KEY = "@osn/client:account_session";
const PROFILE = "usr_default00001";
const PENDING = "osn-pending-deletion";
const ORDINARY = "osn-access";

afterEach(() => {
  vi.unstubAllGlobals();
});

const nowSec = () => Math.floor(Date.now() / 1000);

let minted = 0;
/** An unsigned JWT with `aud`: the client reads its claims without verifying. */
function jwt(aud: string): string {
  minted += 1;
  const enc = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${enc({ alg: "none" })}.${enc({ sub: PROFILE, aud, iat: nowSec(), exp: nowSec() + 300, n: minted })}.sig`;
}

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** What `/token` answers: a fresh token on `aud`. */
const grantOn = (aud: string) =>
  json(200, { access_token: jwt(aud), token_type: "Bearer", expires_in: 300 });

/** A signed-in page holding a token on `held`, whose `/token` mints on `renewed` and whose route answers `api`. */
async function page(held: string, renewed: string, api: (bearerAud: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === `${ISSUER}/token`) return grantOn(renewed);
      const bearer = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length) ?? "";
      return api(isPendingDeletionToken(bearer) ? PENDING : ORDINARY);
    }),
  );
  const storage = createEphemeralStorage();
  const runtime = createOsnAuthRuntime({ issuerUrl: ISSUER }, { storage });
  await runtime.run(
    Effect.flatMap(OsnAuth, (auth) =>
      auth.setSession({
        accessToken: jwt(held),
        idToken: null,
        expiresAt: Date.now() + 120_000,
        scopes: [],
      }),
    ),
  );
  const changes: SessionChange[] = [];
  runtime.onSessionChange((change) => changes.push(change));
  const session = () => runtime.run(Effect.flatMap(OsnAuth, (auth) => auth.getSession()));
  const stored = () => runtime.run(Effect.flatMap(OsnAuth, (auth) => auth.getActiveProfile()));
  return { runtime, changes, calls, session, stored, key: KEY };
}

describe("isPendingDeletionToken", () => {
  it("reads the audience of a pending-deletion token, and of nothing else", () => {
    expect(isPendingDeletionToken(jwt(PENDING))).toBe(true);
    expect(isPendingDeletionToken(jwt(ORDINARY))).toBe(false);
    expect(isPendingDeletionToken("not-a-jwt")).toBe(false);
  });
});

describe("authFetch with a pending-deletion session", () => {
  it("1: an ordinary token refused, renewed onto the pending audience and refused again, keeps the session and says it is pending", async () => {
    // The device that just asked for the deletion, or another tab of the
    // account: its ordinary token is refused once the account is tombstoned.
    const p = await page(ORDINARY, PENDING, () => json(401, { error: "unauthorized" }));

    const res = await p.runtime.authFetch(API);

    expect(res.status).toBe(401);
    expect(p.changes).toEqual([{ kind: "pending-deletion", pending: true }]);
    expect(await p.stored()).toBe(PROFILE);
    const held = await p.session();
    expect(held !== null && isPendingDeletionToken(held.accessToken)).toBe(true);
  });

  it("2: a pending token refused and renewed onto the same audience keeps the session, with no notice", async () => {
    const p = await page(PENDING, PENDING, () => json(401, { error: "unauthorized" }));

    const res = await p.runtime.authFetch(API);

    expect(res.status).toBe(401);
    expect(p.changes).toEqual([]);
    expect(await p.stored()).toBe(PROFILE);
  });

  it("3: a pending token renewed onto the ordinary audience (kept elsewhere) retries with it and says so", async () => {
    const p = await page(PENDING, ORDINARY, (aud) =>
      aud === PENDING ? json(401, { error: "unauthorized" }) : json(200, { ok: true }),
    );

    const res = await p.runtime.authFetch(API);

    expect(res.status).toBe(200);
    expect(p.changes).toEqual([{ kind: "pending-deletion", pending: false }]);
  });
});
