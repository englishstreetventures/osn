/**
 * The token grant against osn-api's own code and its description of itself.
 *
 * The client reads a refused grant as "status unknown" from the text osn-api
 * puts in the body's `message`, and names the active profile in a field the
 * route must accept. Both live in osn-api, so this file builds each from
 * osn-api's own source: the message from `ROTATION_RACE_MESSAGE` and
 * `DatabaseError` printed the way the route prints them (`String(e)`), and
 * the field from `shared/openapi/osn.json`, which CI regenerates from the
 * routes. If either side changes alone, this file fails.
 *
 * Reads files outside the package, so it runs as the `repo` project
 * (`test:repo`), which turbo reruns when those files change.
 */

import { Effect, type Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import openapi from "../../../shared/openapi/osn.json";
import { ROTATION_RACE_MESSAGE } from "../../api/src/lib/grant-failure";
import { AuthError, DatabaseError } from "../../api/src/services/auth/errors";
import { createOsnAuthRuntime } from "../src/runtime";
import { Storage, createEphemeralStorage } from "../src/storage";

const ISSUER = "https://osn.example.com";
const KEY = "@osn/client:account_session";
const SUB = "usr_default00001";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jwt(claims: object): string {
  const enc = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

function seeded(): Layer.Layer<Storage> {
  const storage = createEphemeralStorage();
  const now = Math.floor(Date.now() / 1000);
  const account = {
    hasSession: true,
    activeProfileId: SUB,
    profileTokens: {
      [SUB]: {
        accessToken: jwt({ sub: SUB, iat: now - 301, exp: now - 1 }),
        expiresAt: Date.now() - 1_000,
      },
    },
    scopes: [],
    idToken: null,
  };
  Effect.runSync(
    Effect.flatMap(Storage, (s) => s.set(KEY, JSON.stringify(account))).pipe(
      Effect.provide(storage),
    ),
  );
  return storage;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("a refused grant osn-api marks as 'status unknown'", () => {
  it.each([
    ["the rotation race", new AuthError({ message: ROTATION_RACE_MESSAGE })],
    ["a DatabaseError", new DatabaseError({ cause: "down" })],
  ])("%s, printed as the route prints it, is retried once", async (_name, failure) => {
    let grants = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== `${ISSUER}/token`) return json(200, { ok: true });
      grants += 1;
      if (grants === 1) {
        // What `POST /token` answers a failed grant with (routes/auth/tokens.ts).
        return json(400, { error: "invalid_grant", message: String(failure) });
      }
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: jwt({ sub: SUB, iat: now, exp: now + 300 }),
        token_type: "Bearer",
        expires_in: 300,
        scope: "openid",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createOsnAuthRuntime({ issuerUrl: ISSUER }, { storage: seeded() });

    const res = await runtime.authFetch(`${ISSUER}/thing`);

    expect(res.status).toBe(200);
    expect(grants).toBe(2);
  });
});

describe("the grant's profile_id", () => {
  it("is a field POST /token accepts, in the form the client sends", () => {
    const body = (
      openapi as unknown as {
        paths: Record<
          string,
          Record<
            string,
            {
              requestBody: {
                content: Record<string, { schema: { properties: Record<string, unknown> } }>;
              };
            }
          >
        >;
      }
    ).paths["/token"]!["post"]!.requestBody.content["application/x-www-form-urlencoded"]!;

    expect(Object.keys(body.schema.properties)).toContain("profile_id");
  });
});
