import { describe, expect, test } from "bun:test";

import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import {
  checkAdoptedStorage,
  DEV_BUCKET_SETTINGS,
  DEV_DATABASE_SETTINGS,
  readLiveStorage,
  type DeclaredStorage,
} from "../storage-preflight.ts";

// A fake Cloudflare API: the same distilled client and decoders the live run
// uses, answering from `routes` instead of the network. Each route is keyed
// by method and path; a request with no route fails the test.

const ACCOUNT = "acct";
const DB_ID = "bf0510eb-6998-4ee3-b5a0-833c646ef855";

type Route = { readonly status?: number; readonly body: object };

const ok = (result: unknown, extra: object = {}): Route => ({
  body: { success: true, errors: [], messages: [], result, ...extra },
});
const fail = (status: number, code: number, message: string): Route => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});

function fakeCloudflare(routes: Readonly<Record<string, Route>>, seen: string[] = []) {
  const http = HttpClient.make((request, url) => {
    const key = `${request.method} ${url.pathname}`;
    seen.push(`${key}${url.search}`);
    const route = routes[key];
    if (!route) return Effect.die(new Error(`no fake route for ${key}`));
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  return Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Credentials.fromApiToken({ apiToken: "test-token" }),
    Layer.succeed(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken",
        apiToken: Redacted.make("test-token"),
        accountId: ACCOUNT,
        source: { type: "env" },
      }),
    ),
  );
}

const bucketPath = (name: string, rest = "") =>
  `GET /client/v4/accounts/${ACCOUNT}/r2/buckets/${name}${rest}`;
const d1Path = (rest = "") => `GET /client/v4/accounts/${ACCOUNT}/d1/database${rest}`;

const defaultMultipartRule = {
  id: "Default Multipart Abort Rule",
  enabled: true,
  conditions: { prefix: "" },
  abortMultipartUploadsTransition: { condition: { maxAge: 604800, type: "Age" as const } },
};

/** A bucket and a database configured with everything the declaration leaves out. */
const populated: Record<string, Route> = {
  [bucketPath("cire-sheets-dev")]: ok({
    name: "cire-sheets-dev",
    location: "ENAM",
    storage_class: "InfrequentAccess",
  }),
  [bucketPath("cire-sheets-dev", "/lifecycle")]: ok({ rules: [defaultMultipartRule] }),
  [bucketPath("cire-sheets-dev", "/cors")]: ok({
    rules: [{ id: "browser", allowed: { methods: ["GET"], origins: ["https://example.com"] } }],
  }),
  [bucketPath("cire-sheets-dev", "/domains/managed")]: ok({
    bucketId: "b",
    domain: "pub-x.r2.dev",
    enabled: true,
  }),
  [d1Path()]: ok(
    [
      { uuid: "11111111-1111-4111-8111-111111111111", name: "cire-db-dev-old" },
      { uuid: DB_ID, name: "cire-db-dev" },
    ],
    { result_info: { page: 1, per_page: 20, count: 2, total_count: 2, total_pages: 1 } },
  ),
  [d1Path(`/${DB_ID}`)]: ok({
    uuid: DB_ID,
    name: "cire-db-dev",
    read_replication: { mode: "auto" },
  }),
};

/** A bucket and a database exactly as the declaration says. */
const matching: Record<string, Route> = {
  ...populated,
  [bucketPath("cire-sheets-dev")]: ok({ name: "cire-sheets-dev", storage_class: "Standard" }),
  [bucketPath("cire-sheets-dev", "/lifecycle")]: ok({ rules: [] }),
  [bucketPath("cire-sheets-dev", "/cors")]: fail(
    404,
    10059,
    "The CORS configuration does not exist.",
  ),
  [bucketPath("cire-sheets-dev", "/domains/managed")]: ok({
    bucketId: "b",
    domain: "pub-x.r2.dev",
    enabled: false,
  }),
  [d1Path(`/${DB_ID}`)]: ok({
    uuid: DB_ID,
    name: "cire-db-dev",
    read_replication: { mode: "disabled" },
  }),
};

const declared: DeclaredStorage = {
  buckets: { "cire-sheets-dev": DEV_BUCKET_SETTINGS },
  databases: { "cire-db-dev": { id: DB_ID, ...DEV_DATABASE_SETTINGS } },
};

const read = (routes: Record<string, Route>, seen?: string[]) =>
  Effect.runPromise(
    readLiveStorage(["cire-sheets-dev"], ["cire-db-dev"]).pipe(
      Effect.provide(fakeCloudflare(routes, seen)),
    ),
  );

const check = (routes: Record<string, Route>) =>
  Effect.runPromiseExit(checkAdoptedStorage(declared).pipe(Effect.provide(fakeCloudflare(routes))));

describe("readLiveStorage against a fake Cloudflare API", () => {
  test("every setting the API reports reaches the comparison", async () => {
    const seen: string[] = [];
    const live = await read(populated, seen);
    expect(live.buckets["cire-sheets-dev"]).toEqual({
      storageClass: "InfrequentAccess",
      lifecycleRules: [defaultMultipartRule],
      corsRules: [
        { id: "browser", allowed: { methods: ["GET"], origins: ["https://example.com"] } },
      ],
      publicAccess: true,
    });
    expect(live.databases["cire-db-dev"]).toEqual({ id: DB_ID, readReplicationMode: "auto" });
    expect(seen.some((request) => request.startsWith(`${d1Path()}?name=cire-db-dev`))).toBe(true);
  });

  test("a missing bucket, no CORS configuration and no database read as such", async () => {
    const live = await read({
      ...matching,
      [bucketPath("cire-sheets-dev")]: fail(404, 10006, "The specified bucket does not exist."),
      [d1Path()]: ok([], {
        result_info: { page: 1, per_page: 20, count: 0, total_count: 0, total_pages: 0 },
      }),
    });
    expect(live.buckets["cire-sheets-dev"]).toBeUndefined();
    expect(live.databases["cire-db-dev"]).toBeUndefined();

    const noCors = await read(matching);
    expect(noCors.buckets["cire-sheets-dev"]?.corsRules).toEqual([]);
  });
});

describe("checkAdoptedStorage", () => {
  test("passes when the live storage matches the declaration", async () => {
    expect(Exit.isSuccess(await check(matching))).toBe(true);
  });

  test("refuses the run when a live setting differs", async () => {
    const exit = await check({
      ...matching,
      [bucketPath("cire-sheets-dev", "/lifecycle")]: ok({ rules: [defaultMultipartRule] }),
    });
    expect(Exit.isFailure(exit)).toBe(true);
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
    expect(message).toContain("Refusing to adopt dev storage");
    expect(message).toContain("Default Multipart Abort Rule");
  });

  test("refuses the run when a read fails, naming the read", async () => {
    const exit = await check({
      ...matching,
      // A status and code the client does not retry, so the failure is immediate.
      [bucketPath("cire-sheets-dev", "/lifecycle")]: fail(400, 10999, "Bad request"),
    });
    expect(Exit.isFailure(exit)).toBe(true);
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
    expect(message).toContain("Reading R2 bucket cire-sheets-dev lifecycle rules failed");
  });
});
