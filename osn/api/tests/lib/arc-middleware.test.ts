import type { Db } from "@osn/db/service";
import { clearPublicKeyCache } from "@shared/crypto";
import { Effect } from "effect";
import { describe, it, expect, beforeEach } from "vitest";

import { requireArc } from "../../src/lib/arc-middleware";
import { createTestLayer } from "../helpers/db";

// ---------------------------------------------------------------------------
// T-S1: requireArc — untrusted-input fast-path and peekClaims edge cases
//
// The route integration tests cover the happy path (valid ARC token) and the
// basic 401 cases (wrong audience, wrong scope, expired). These unit tests
// cover the untrusted-input parse paths that short-circuit before the DB is
// touched, ensuring no 500 leaks implementation details.
// ---------------------------------------------------------------------------

const dbLayer = createTestLayer();
const run = <A>(eff: Effect.Effect<A, unknown, Db>) =>
  Effect.runPromise(eff.pipe(Effect.provide(dbLayer)) as Effect.Effect<A, never, never>);

function makeSet(): { status?: number | string } {
  return {};
}

/** base64url-encode a plain object (no padding). */
function b64u(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

beforeEach(() => {
  clearPublicKeyCache();
});

describe("requireArc — missing / non-ARC authorization", () => {
  it("returns null + 401 when Authorization header is missing", async () => {
    const set = makeSet();
    const result = await requireArc(undefined, set, run, "osn-api", "graph:read");
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });

  it("returns null + 401 for Bearer scheme (not ARC)", async () => {
    const set = makeSet();
    const result = await requireArc("Bearer some-jwt", set, run, "osn-api", "graph:read");
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });

  it("returns null + 401 for empty string", async () => {
    const set = makeSet();
    const result = await requireArc("", set, run, "osn-api", "graph:read");
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });
});

describe("requireArc — malformed ARC token structure", () => {
  it("returns null + 401 for a token with only two segments", async () => {
    const set = makeSet();
    const result = await requireArc("ARC header.payload", set, run, "osn-api", "graph:read");
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });

  it("returns null + 401 for a token with non-JSON header", async () => {
    const set = makeSet();
    // Raw bytes that decode to non-JSON
    const result = await requireArc(
      "ARC bm90anNvbg.payload.sig",
      set,
      run,
      "osn-api",
      "graph:read",
    );
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });

  it("returns null + 401 for header missing kid field", async () => {
    const header = b64u({ alg: "ES256" }); // no kid
    const payload = b64u({ iss: "pulse-api", scope: "graph:read" });
    const set = makeSet();
    const result = await requireArc(
      `ARC ${header}.${payload}.fakesig`,
      set,
      run,
      "osn-api",
      "graph:read",
    );
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });

  it("returns null + 401 for payload missing iss field", async () => {
    const header = b64u({ alg: "ES256", kid: "some-kid" });
    const payload = b64u({ scope: "graph:read" }); // no iss
    const set = makeSet();
    const result = await requireArc(
      `ARC ${header}.${payload}.fakesig`,
      set,
      run,
      "osn-api",
      "graph:read",
    );
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });
});

describe("requireArc — valid structure but unregistered service", () => {
  it("returns null + 401 when kid is not in the DB", async () => {
    const header = b64u({ alg: "ES256", kid: "no-such-key" });
    const payload = b64u({ iss: "unknown-svc", scope: "graph:read" });
    const set = makeSet();
    const result = await requireArc(
      `ARC ${header}.${payload}.fakesig`,
      set,
      run,
      "osn-api",
      "graph:read",
    );
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });
});
