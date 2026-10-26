/**
 * The repository patches alchemy's D1 import (`patches/alchemy@2.0.0-beta.83.patch`)
 * so it reads every Cloudflare reply the way wrangler does, and so a failed
 * import reports Cloudflare's error or the reply itself, with no presigned
 * upload URL and no R2 error body in the message. Each case runs against
 * alchemy's `src/` copy, which Bun loads in a deploy, and its `lib/` copy,
 * which Node-style resolution loads, over a scripted Cloudflare API, so this
 * file fails if the patch stops applying to either.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Credentials } from "alchemy/Cloudflare";
import { Cause, Clock, Duration, Effect, Exit, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, test } from "vitest";

interface ImportResult {
  readonly filename: string;
  readonly numQueries: number;
}

/** The part of alchemy's `Cloudflare/D1/ImportDatabase` module this file drives. */
interface ImportModule {
  readonly importD1Database: (options: {
    readonly accountId: string;
    readonly databaseId: string;
    readonly sqlData: string;
  }) => Effect.Effect<ImportResult, unknown, unknown>;
}

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** The installed alchemy's root directory, as this package resolves it. */
function alchemyDir(): string {
  let dir = dirname(createRequire(join(packageDir, "index.js")).resolve("alchemy"));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, "utf8")) as { readonly name?: string }).name === "alchemy"
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no alchemy package.json above its entry point");
    dir = parent;
  }
}

/** Both copies alchemy ships. A computed path keeps the type-checker out of alchemy's source. */
const COPIES = [
  { copy: "src", path: "src/Cloudflare/D1/ImportDatabase.ts" },
  { copy: "lib", path: "lib/Cloudflare/D1/ImportDatabase.js" },
] as const;

const load = (path: string): Promise<ImportModule> =>
  import(/* @vite-ignore */ join(alchemyDir(), path)) as Promise<ImportModule>;

const API = "https://api.cloudflare.test/client/v4";
const SIGNATURE = "c0ffee5ignature0123456789abcdef";
const UPLOAD_URL = `https://upload.r2.test/import.sql?X-Amz-Expires=3600&X-Amz-Signature=${SIGNATURE}`;
const ERROR = "seating table plan is not a plan of its event: SQLITE_CONSTRAINT";

interface Reply {
  readonly status: number;
  readonly body: string;
}

const json = (value: unknown, status = 200): Reply => ({ status, body: JSON.stringify(value) });

/** A successful Cloudflare v4 envelope around `result`. */
const ok = (result: unknown): Reply => json({ success: true, errors: [], messages: [], result });

/** The replies the scripted API gives; polls are answered in order. */
interface Script {
  readonly init?: Reply;
  readonly put?: Reply;
  readonly ingest?: Reply;
  readonly polls?: readonly Reply[];
}

interface SentRequest {
  readonly method: string;
  readonly body: string;
}

interface Run {
  readonly exit: Exit.Exit<ImportResult, unknown>;
  readonly requests: readonly SentRequest[];
  readonly sleeps: readonly number[];
}

/** A clock that records each sleep's length and returns at once. */
const recordingClock = (live: Clock.Clock, sleeps: number[]): Clock.Clock => ({
  currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
  currentTimeMillis: live.currentTimeMillis,
  currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
  currentTimeNanos: live.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: live.monotonicTimeNanos,
  sleep: (duration) =>
    Effect.sync(() => {
      sleeps.push(Duration.toMillis(duration));
    }),
});

/** Runs one import against the scripted API. An exhausted poll script answers 599. */
async function run(module: ImportModule, script: Script): Promise<Run> {
  const requests: SentRequest[] = [];
  const sleeps: number[] = [];
  const polls = [...(script.polls ?? [])];

  const route = (method: string, body: string): Reply => {
    if (method === "PUT") return script.put ?? { status: 200, body: "" };
    const { action } = JSON.parse(body) as { readonly action?: string };
    if (action === "init") {
      return script.init ?? ok({ upload_url: UPLOAD_URL, filename: "import-abc.sql" });
    }
    if (action === "ingest")
      return script.ingest ?? ok({ success: true, at_bookmark: "bm-ingest" });
    return polls.shift() ?? { status: 599, body: "script exhausted" };
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new globalThis.Request(input, init);
    const body = await request.text();
    requests.push({ method: request.method, body });
    const reply = route(request.method, body);
    return new Response(reply.body, {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };

  const program = Clock.clockWith((live) =>
    module
      .importD1Database({ accountId: "account", databaseId: "database", sqlData: "SELECT 1;" })
      .pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken" as const,
            apiToken: Redacted.make("token"),
            apiBaseUrl: API,
          }),
        ),
        Effect.provideService(Clock.Clock, recordingClock(live, sleeps)),
      ),
  ) as Effect.Effect<ImportResult, unknown, never>;

  return { exit: await Effect.runPromiseExit(program), requests, sleeps };
}

/** The failure's message, or its name and message when it is an Error. */
function failure(exit: Exit.Exit<ImportResult, unknown>): string {
  if (Exit.isSuccess(exit)) {
    throw new Error(`expected the import to fail; it returned ${JSON.stringify(exit.value)}`);
  }
  const error = Cause.squash(exit.cause);
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function success(exit: Exit.Exit<ImportResult, unknown>): ImportResult {
  if (Exit.isFailure(exit)) {
    throw new Error(`expected the import to succeed; it failed: ${Cause.pretty(exit.cause)}`);
  }
  return exit.value;
}

const bodies = (requests: readonly SentRequest[]) =>
  requests
    .filter((request) => request.method === "POST")
    .map(
      (request) =>
        JSON.parse(request.body) as {
          readonly action?: string;
          readonly current_bookmark?: string;
        },
    );

const actions = (requests: readonly SentRequest[]) =>
  requests.map((request) =>
    request.method === "PUT"
      ? "put"
      : ((JSON.parse(request.body) as { action?: string }).action ?? "?"),
  );

const pollBookmarks = (requests: readonly SentRequest[]) =>
  bodies(requests)
    .filter((body) => body.action === "poll")
    .map((body) => body.current_bookmark);

describe.each(COPIES)("alchemy's D1 import, $copy copy", ({ path }) => {
  test("a: a poll reply with success false dies with Cloudflare's error", async () => {
    const { exit } = await run(await load(path), { polls: [ok({ success: false, error: ERROR })] });
    expect(failure(exit)).toContain(ERROR);
  });

  test("a′: a poll reply with status error and a bookmark dies with its error, polling no more", async () => {
    const { exit, requests } = await run(await load(path), {
      polls: [ok({ success: true, status: "error", error: ERROR, at_bookmark: "bm-ingest" })],
    });
    expect(failure(exit)).toContain(ERROR);
    expect(pollBookmarks(requests)).toEqual(["bm-ingest"]);
  });

  test("a″: a poll reply with status error and an errors list carries the list, polling no more", async () => {
    const { exit, requests } = await run(await load(path), {
      polls: [
        ok({
          success: true,
          status: "error",
          errors: [ERROR],
          messages: ["Import failed"],
          at_bookmark: "bm-ingest",
        }),
      ],
    });
    expect(failure(exit)).toContain(ERROR);
    expect(pollBookmarks(requests)).toEqual(["bm-ingest"]);
  });

  test("b: a poll reply with no status, error or bookmark carries the reply", async () => {
    const { exit } = await run(await load(path), {
      polls: [ok({ success: true, messages: ["the import stopped"] })],
    });
    const message = failure(exit);
    expect(message).toContain("poll reply missing bookmark");
    expect(message).toContain("the import stopped");
  });

  test("c: a complete poll reply with no result succeeds with no queries counted", async () => {
    const { exit } = await run(await load(path), {
      polls: [ok({ success: true, status: "complete", at_bookmark: "bm-ingest" })],
    });
    expect(success(exit).numQueries).toBe(0);
  });

  test("d: a poll envelope with a null result dies with the envelope, not a TypeError", async () => {
    const { exit } = await run(await load(path), {
      polls: [json({ success: true, errors: [], messages: ["import queue full"], result: null })],
    });
    const message = failure(exit);
    expect(message).not.toMatch(/^TypeError/);
    expect(message).toContain("import queue full");
  });

  test("d′: a poll envelope with success false carries the envelope's errors", async () => {
    const { exit } = await run(await load(path), {
      polls: [
        json({
          success: false,
          errors: [{ code: 7500, message: "import ran out of time" }],
          messages: [],
          result: {},
        }),
      ],
    });
    expect(failure(exit)).toContain("import ran out of time");
  });

  test("e: an ingest reply with no bookmark and no error carries the reply", async () => {
    const { exit } = await run(await load(path), {
      ingest: ok({ success: true, messages: ["the file was not found"] }),
    });
    const message = failure(exit);
    expect(message).toContain("ingest reply missing bookmark");
    expect(message).toContain("the file was not found");
  });

  test("e′: an ingest reply that reports a failure dies with its error and sends no poll", async () => {
    const { exit, requests } = await run(await load(path), {
      ingest: ok({ success: false, error: ERROR, at_bookmark: "bm-ingest" }),
    });
    expect(failure(exit)).toContain(ERROR);
    expect(pollBookmarks(requests)).toEqual([]);
  });

  test("e″: an ingest reply that reports completion succeeds and sends no poll", async () => {
    const { exit, requests } = await run(await load(path), {
      ingest: ok({ success: true, status: "complete", result: { num_queries: 3 } }),
    });
    expect(success(exit).numQueries).toBe(3);
    expect(pollBookmarks(requests)).toEqual([]);
  });

  test.each([
    {
      name: "an ingest reply with no bookmark",
      script: { ingest: ok({ success: true, upload_url: UPLOAD_URL }) },
    },
    {
      name: "a failed poll reply with no error",
      script: { polls: [ok({ success: false, upload_url: UPLOAD_URL })] },
    },
    {
      name: "a poll reply with no bookmark",
      script: { polls: [ok({ success: true, upload_url: UPLOAD_URL })] },
    },
    {
      name: "a poll envelope with success false",
      script: {
        polls: [
          json({
            success: false,
            errors: [{ code: 7500, message: "bad import" }],
            upload_url: UPLOAD_URL,
            result: { upload_url: UPLOAD_URL },
          }),
        ],
      },
    },
    {
      name: "a poll envelope with a null result",
      script: {
        polls: [
          json({ success: true, errors: [], messages: [], upload_url: UPLOAD_URL, result: null }),
        ],
      },
    },
  ])("f: $name names no upload URL", async ({ script }) => {
    const { exit } = await run(await load(path), script);
    const message = failure(exit);
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(SIGNATURE);
  });

  test.each([
    {
      name: "an S3 error echoing the signature",
      body:
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code>' +
        "<Message>The request signature we calculated does not match the signature you provided.</Message>" +
        `<SignatureProvided>${SIGNATURE}</SignatureProvided>` +
        `<CanonicalRequest>PUT /import.sql X-Amz-Signature=${SIGNATURE}</CanonicalRequest></Error>`,
      shows: "(403): SignatureDoesNotMatch",
    },
    {
      name: "a plain-text error echoing the upload URL",
      body: `403 Forbidden: PUT ${UPLOAD_URL} refused`,
      shows: "(403)",
    },
  ])("f′: a failed upload answered with $name reports no signature", async ({ body, shows }) => {
    const { exit } = await run(await load(path), { put: { status: 403, body } });
    const message = failure(exit);
    expect(message).toContain(shows);
    expect(message).not.toContain(SIGNATURE);
  });

  test("g: an in-progress reply is polled again with its bookmark, a second after it lands", async () => {
    const { exit, requests, sleeps } = await run(await load(path), {
      polls: [
        ok({ success: true, at_bookmark: "bm-2", messages: ["running"] }),
        ok({ success: true, status: "complete", at_bookmark: "bm-2", result: { num_queries: 7 } }),
      ],
    });
    expect(success(exit)).toEqual({ filename: "import-abc.sql", numQueries: 7 });
    expect(pollBookmarks(requests)).toEqual(["bm-ingest", "bm-2"]);
    expect(sleeps).toEqual([1000, 1000]);
  });

  test("h: a poll answered with a body that is not JSON carries the body", async () => {
    const { exit } = await run(await load(path), {
      polls: [{ status: 200, body: "<html>upstream timed out</html>" }],
    });
    expect(failure(exit)).toContain("upstream timed out");
  });

  test("i: an init reply with no upload URL polls the import it started, with no upload or ingest", async () => {
    const { exit, requests } = await run(await load(path), {
      init: ok({ success: true, at_bookmark: "bm-init", filename: "import-abc.sql" }),
      polls: [
        ok({
          success: true,
          status: "complete",
          at_bookmark: "bm-init",
          result: { num_queries: 4 },
        }),
      ],
    });
    expect(success(exit)).toEqual({ filename: "import-abc.sql", numQueries: 4 });
    expect(actions(requests)).toEqual(["init", "poll"]);
    expect(pollBookmarks(requests)).toEqual(["bm-init"]);
  });

  test("i′: an init reply with no upload URL and no bookmark carries the reply", async () => {
    const { exit } = await run(await load(path), {
      init: ok({ success: true, messages: ["init gave no upload slot"] }),
    });
    expect(failure(exit)).toContain("init gave no upload slot");
  });

  test("i″: an init reply with no upload URL that reports completion succeeds with its count", async () => {
    const { exit, requests } = await run(await load(path), {
      init: ok({
        success: true,
        status: "complete",
        filename: "import-abc.sql",
        result: { num_queries: 5 },
      }),
    });
    expect(success(exit)).toEqual({ filename: "import-abc.sql", numQueries: 5 });
    expect(actions(requests)).toEqual(["init"]);
  });

  test.each([
    { name: "status error", reply: { success: true, status: "error", error: ERROR } },
    { name: "success false", reply: { success: false, error: ERROR, at_bookmark: "bm-init" } },
  ])(
    "i‴: an init reply with no upload URL and $name dies with its error, sending nothing more",
    async ({ reply }) => {
      const { exit, requests } = await run(await load(path), { init: ok(reply) });
      expect(failure(exit)).toContain(ERROR);
      expect(actions(requests)).toEqual(["init"]);
    },
  );
});
