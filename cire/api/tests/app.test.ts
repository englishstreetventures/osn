import { describe, it, expect } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";
import { sql } from "drizzle-orm";

import { createApp } from "../src/app";
import { createDb } from "../src/db/setup";
import { appRequest, jsonBody } from "./test-helpers";

// CORS + not-found behavior only — no DB rows needed.
const db = createDb(":memory:");
const app = createApp(db, {
  webOrigin: "http://localhost:4321",
  allowedOrigins: ["http://localhost:4321", "http://localhost:4322"],
  claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
});

// This is credentialed CORS on an auth API: echo the request origin verbatim
// when allowlisted, never `*`, and emit no header on mismatch.
describe("CORS", () => {
  it("echoes an allowlisted Origin verbatim with credentials", async () => {
    const res = await appRequest(app, "/api/claim", {
      method: "POST",
      headers: { Origin: "http://localhost:4322", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4322");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("answers preflight with the requesting origin, never *", async () => {
    const res = await appRequest(app, "/api/claim", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:4321",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4321");
  });

  it("omits Access-Control-Allow-Origin for a disallowed origin", async () => {
    const res = await appRequest(app, "/api/claim", {
      method: "POST",
      headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("not-found handler", () => {
  it("returns the JSON 404 contract for unknown paths", async () => {
    const res = await appRequest(app, "/nope");
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "Not found" });
  });

  // `GET /api/primary-wedding` was a PUBLIC, unauthenticated read returning the
  // most-recently-created wedding's slug. On a multi-tenant product that let any
  // anonymous caller learn whose invite was newest, and made the guest bare
  // domain serve one arbitrary couple's invite. It was deleted rather than
  // rescoped — there is no correct single wedding to resolve.
  //
  // A removal made for a disclosure reason deserves a contract, not just an
  // absent file: a re-mount during a merge or revert would otherwise be silent.
  it("no longer serves the removed public primary-wedding lookup", async () => {
    const res = await appRequest(app, "/api/primary-wedding");
    expect(res.status).toBe(404);
  });
});

/**
 * Capture everything Effect's logger writes for one run. The cire redacting
 * logger emits through `globalThis.console`, so we temporarily swap those
 * methods for a sink. (`globalThis.console` rather than the bare `console`
 * global so the no-console lint rule isn't tripped by this test-only code.)
 */
async function captureLogs(run: () => unknown | Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const sink = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  // `console` is an ambient `const` in both the Workers and Bun type
  // declarations, so it never merges into `typeof globalThis`'s properties —
  // it exists on the real global object at runtime regardless.
  const c = (globalThis as typeof globalThis & { console: Console }).console;
  const original = { log: c.log, info: c.info, warn: c.warn, error: c.error, debug: c.debug };
  Object.assign(c, { log: sink, info: sink, warn: sink, error: sink, debug: sink });
  try {
    await run();
  } finally {
    Object.assign(c, original);
  }
  return lines.join("\n");
}

// Build an app whose DB is missing the tables the claim path touches, so the
// claim handler throws an unhandled defect (a SQLite "no such table" error)
// that reaches the `onError` boundary.
function brokenClaimApp(): ReturnType<typeof createApp> {
  const brokenDb = createDb(":memory:");
  // guest_account_links references guests/families, so it must be dropped
  // first — otherwise its dangling FK trips the later DROPs (foreign_keys=ON).
  brokenDb.run(sql`DROP TABLE guest_account_links`);
  brokenDb.run(sql`DROP TABLE rsvps`);
  brokenDb.run(sql`DROP TABLE guest_events`);
  brokenDb.run(sql`DROP TABLE guests`);
  brokenDb.run(sql`DROP TABLE sessions`);
  brokenDb.run(sql`DROP TABLE families`);
  return createApp(brokenDb, {
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
  });
}

// Elysia's default error renderer would put `error.message` (D1 error
// strings, Effect causes) in the body; the onError hook must keep defects
// generic.
describe("unhandled errors", () => {
  it("returns a generic 500 body, not the internal error message", async () => {
    const res = await appRequest(brokenClaimApp(), "/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
    });
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({ error: "Internal error" });
  });

  // The structured error log must carry a NON-SENSITIVE identifier
  // (the Elysia `code` + the error `name`/`_tag`) but NEVER the free-form
  // `error.message` — `redact()` scrubs by object key, not by substring, so a
  // raw message echoing a D1 internal or guest input would land verbatim.
  it("logs the error name/code, not the raw error message", async () => {
    const out = await captureLogs(() =>
      appRequest(brokenClaimApp(), "/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
      }),
    );

    // This used to isolate our `onError` line out of the capture, because
    // Effect v3's *default* logger also emitted a separate DEBUG "Fiber
    // terminated…" stack dump. Two things changed under v4: `Logger.layer`
    // replaces the whole active set, so there is no default logger left to
    // emit that dump; and the local renderer is indented, so our own entry is
    // no longer one line and a line filter would only ever catch a fragment of
    // it. The whole capture IS our entry now — which makes the negative
    // assertion below strictly stronger, since nothing is filtered out of it.

    // The structured entry + the error NAME are present (triage signal).
    expect(out).toContain("unhandled request error");
    expect(out).toContain("name");
    expect(out).toContain("SQLiteError"); // the error NAME survives
    // The raw SQLite message (a D1-internal echo) must NOT appear anywhere —
    // "no such table: families" is exactly what would have leaked under the old
    // `message: error.message` log.
    expect(out).not.toContain("no such table");
  });
});
