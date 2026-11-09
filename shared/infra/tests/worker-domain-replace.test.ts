/**
 * The repository patches the Alchemy Cloudflare provider
 * (`patches/@alchemy.run%2Fcloudflare@2.0.0-beta.85.patch`) so a flip
 * release's deploy can attach a Worker custom domain to a host that still
 * holds its CNAME to its own Pages project, replacing the record in the one
 * request Wrangler sends, so the zone always holds a record for the host.
 * The patch adds `Workers/ReplaceCname` and calls it from `reconcileDomains`:
 * `checkReplaceCname` at its top, before it reads or deletes a domain, and
 * `replacingAttach` in `attachDomain`, before `putDomain`.
 *
 * Each case runs against the module's `src/` copy, which Bun loads in a
 * deploy, and its `lib/` copy, over a scripted Cloudflare API, one test per
 * way the replacement can go wrong. The routing rule is held to
 * scripts/pages-domain.ts's `decides`, which reads the same records before
 * the detach.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Credentials } from "@alchemy.run/cloudflare";
import { Cause, Clock, ConfigProvider, Duration, Effect, Exit, Logger, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, test } from "vitest";

import { cloudflareDir } from "./support/cloudflare-dir";

interface DnsRecord {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly proxied?: boolean;
  readonly meta?: Readonly<Record<string, unknown>>;
}

interface Replacement {
  readonly host: string;
  readonly target: string;
  readonly zoneId: string;
  readonly kept: readonly DnsRecord[];
}

interface Attached {
  readonly hostname: string;
  readonly id: string;
  readonly zoneId: string;
}

/** The part of the provider's `Workers/ReplaceCname` module this file drives. */
interface ReplaceModule {
  readonly REPLACE_CNAME_ENV: string;
  readonly REPLACE_ALLOW_APEX_ENV: string;
  readonly parseReplaceCname: (
    value: string | undefined,
  ) => { readonly host: string; readonly target: string } | undefined;
  readonly routesHost: (host: string, record: DnsRecord) => boolean;
  readonly checkReplaceCname: (input: {
    readonly accountId: string;
    readonly scriptName: string;
    readonly desired: readonly string[];
    readonly zoneIdOf: (hostname: string) => Effect.Effect<string>;
  }) => Effect.Effect<Replacement | undefined, unknown, unknown>;
  readonly replacingAttach: (
    replacement: Replacement | undefined,
    input: {
      readonly accountId: string;
      readonly scriptName: string;
      readonly hostname: string;
      readonly zoneId: string;
      readonly previewsEnabled?: boolean;
    },
  ) => Effect.Effect<Attached | undefined, unknown, unknown>;
}

/** Both copies the provider ships. A computed path keeps the type-checker out of its source. */
const COPIES = [
  { copy: "src", path: "src/Workers/ReplaceCname.ts", provider: "src/Workers/WorkerProvider.ts" },
  { copy: "lib", path: "lib/Workers/ReplaceCname.js", provider: "lib/Workers/WorkerProvider.js" },
] as const;

const CLOUDFLARE_DIR = cloudflareDir();

const load = (path: string): Promise<ReplaceModule> =>
  import(/* @vite-ignore */ join(CLOUDFLARE_DIR, path)) as Promise<ReplaceModule>;

const API = "https://api.cloudflare.test/client/v4";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "deploy-token-for-tests";
const ZONE = "zone-cire";
const SCRIPT = "cire-vendor-production";
const HOST = "vendor.cireweddings.com";
const TARGET = "cire-vendor.pages.dev";
const APEX = "cireweddings.com";
const APEX_TARGET = "cire-landing.pages.dev";
const ENV = "OSN_WORKER_DOMAIN_REPLACE_CNAME";
const ALLOW_APEX = "OSN_WORKER_DOMAIN_REPLACE_ALLOW_APEX";

const cname = (content: string, id = "rec-cname"): DnsRecord => ({
  id,
  type: "CNAME",
  content,
  proxied: true,
});
const WORKER_RECORD: DnsRecord = {
  id: "rec-worker",
  type: "AAAA",
  content: "100::",
  meta: { origin_worker_id: "abc123", read_only: true },
};
const TXT: DnsRecord = { id: "rec-txt", type: "TXT", content: "v=spf1 ~all" };
const MX: DnsRecord = { id: "rec-mx", type: "MX", content: "mx.example.net" };
const CAA: DnsRecord = { id: "rec-caa", type: "CAA", content: '0 issue "letsencrypt.org"' };

interface Reply {
  readonly status: number;
  readonly body: string;
}

const json = (value: unknown, status = 200): Reply => ({ status, body: JSON.stringify(value) });
const ok = (result: unknown, info?: unknown): Reply =>
  json({ success: true, errors: [], messages: [], result, result_info: info });
const refused = (status: number, code: number, message = "refused"): Reply =>
  json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);

/** The scripted Cloudflare API: what each call answers. A queued answer is used once, then the default. */
interface World {
  /** The host's records before the override PUT is answered. */
  before: DnsRecord[];
  /** The host's records after it; the CNAME replaced by the Worker's record unless set. */
  after?: DnsRecord[];
  /** Answers to the DNS read, in turn; "down" is a network failure. */
  reads?: (Reply | "down")[];
  /** Answers to the override PUT, in turn; "down" is a network failure. */
  puts?: (Reply | "down")[];
  /** Answers to the custom-domain listing, in turn. */
  lists?: Reply[];
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly auth: string | null;
}

interface Run {
  readonly exit: Exit.Exit<{ replacement?: Replacement; attached?: Attached }, unknown>;
  readonly sent: readonly Sent[];
  readonly sleeps: readonly number[];
  readonly logs: readonly string[];
  readonly zoneLookups: readonly string[];
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

/**
 * Runs the check, then the attach hook for the Worker's first desired host,
 * as reconcileDomains runs them, against the scripted API.
 */
async function run(
  module: ReplaceModule,
  w: World,
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly desired?: readonly string[];
    readonly previewsEnabled?: boolean;
  } = {},
): Promise<Run> {
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const zoneLookups: string[] = [];
  const desired = options.desired ?? [HOST];
  const reads = [...(w.reads ?? [])];
  const puts = [...(w.puts ?? [])];
  const lists = [...(w.lists ?? [])];
  let replaced = false;
  const host = desired[0] ?? HOST;

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new globalThis.Request(input, init);
    const text = await request.text();
    const path = request.url.slice(API.length);
    sent.push({
      method: request.method,
      path,
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
      auth: request.headers.get("authorization"),
    });
    const answer = (reply: Reply | "down" | undefined, fallback: () => Reply): Response => {
      if (reply === "down") throw new TypeError(`Unable to connect to ${request.url}`);
      const { status, body } = reply ?? fallback();
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    };
    if (request.method === "GET" && path.startsWith(`/zones/${ZONE}/dns_records?`)) {
      return answer(reads.shift(), () =>
        ok(
          replaced
            ? (w.after ?? [...w.before.filter((record) => record.type !== "CNAME"), WORKER_RECORD])
            : w.before,
        ),
      );
    }
    if (
      request.method === "PUT" &&
      path === `/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/domains/records`
    ) {
      const next = puts.shift();
      if (next === undefined || (next !== "down" && next.status === 200)) replaced = true;
      return answer(next, () => ok([{ hostname: host, zone_id: ZONE }]));
    }
    if (request.method === "GET" && path.startsWith(`/accounts/${ACCOUNT}/workers/domains?`)) {
      return answer(lists.shift(), () =>
        ok([{ id: "wd-1", hostname: host, service: SCRIPT, zone_id: ZONE }]),
      );
    }
    return new Response(JSON.stringify({ success: false, errors: [{ code: 0 }] }), {
      status: 599,
    });
  };

  const program = Clock.clockWith((live) =>
    Effect.gen(function* () {
      const replacement = yield* module.checkReplaceCname({
        accountId: ACCOUNT,
        scriptName: SCRIPT,
        desired,
        zoneIdOf: (hostname) =>
          Effect.sync(() => {
            zoneLookups.push(hostname);
            return ZONE;
          }),
      });
      const attached = yield* module.replacingAttach(replacement, {
        accountId: ACCOUNT,
        scriptName: SCRIPT,
        hostname: host,
        zoneId: ZONE,
        ...(options.previewsEnabled === undefined
          ? {}
          : { previewsEnabled: options.previewsEnabled }),
      });
      return { replacement, attached };
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          type: "apiToken" as const,
          apiToken: Redacted.make(TOKEN),
          apiBaseUrl: API,
        }),
      ),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { ...options.env } }),
      ),
      Effect.provideService(Clock.Clock, recordingClock(live, sleeps)),
      Effect.provide(Logger.layer([Logger.make((log) => logs.push(JSON.stringify(log.message)))])),
    ),
  ) as Effect.Effect<{ replacement?: Replacement; attached?: Attached }, unknown, never>;

  return { exit: await Effect.runPromiseExit(program), sent, sleeps, logs, zoneLookups };
}

/** The failure's message, or its name and message when it is an Error. */
function failure(r: Run): string {
  if (Exit.isSuccess(r.exit)) {
    throw new Error(`expected the attach to stop; it returned ${JSON.stringify(r.exit.value)}`);
  }
  const error = Cause.squash(r.exit.cause);
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function success(r: Run): { replacement?: Replacement; attached?: Attached } {
  if (Exit.isFailure(r.exit)) {
    throw new Error(`expected the attach to go ahead; it failed: ${Cause.pretty(r.exit.cause)}`);
  }
  return r.exit.value;
}

const writes = (r: Run) => r.sent.filter((sent) => sent.method !== "GET");
const flipEnv = (host = HOST, target = TARGET) => ({ [ENV]: `${host}=${target}` });

describe.each(COPIES)("the replacing attach, $copy copy", ({ path }) => {
  test("R1: with the variable unset or empty, nothing is read and the attach goes on as before", async () => {
    const module = await load(path);
    expect([module.REPLACE_CNAME_ENV, module.REPLACE_ALLOW_APEX_ENV]).toEqual([ENV, ALLOW_APEX]);
    const unset: readonly Readonly<Record<string, string>>[] = [
      {},
      { [ENV]: "" },
      { [ENV]: "   " },
    ];
    for (const env of unset) {
      const r = await run(module, { before: [cname(TARGET)] }, { env });
      expect(success(r)).toEqual({ replacement: undefined, attached: undefined });
      expect({ env, sent: r.sent, zones: r.zoneLookups }).toEqual({ env, sent: [], zones: [] });
    }
  });

  test("R2: a variable naming another host leaves this Worker's attach as before, reading nothing", async () => {
    const r = await run(
      await load(path),
      { before: [cname(TARGET)] },
      {
        env: flipEnv("host.cireweddings.com", "cire-host.pages.dev"),
      },
    );
    expect(success(r)).toEqual({ replacement: undefined, attached: undefined });
    expect(r.sent).toEqual([]);
  });

  test.each([
    HOST,
    `${HOST}=`,
    `=${TARGET}`,
    `${HOST}=cire-vendor.example.com`,
    `${HOST}=pages.dev`,
    `${HOST}=a.b.pages.dev`,
    `${HOST}=-cire.pages.dev`,
    `${HOST}=${TARGET}=x`,
    `${HOST}=${TARGET} host.cireweddings.com=cire-host.pages.dev`,
    `${HOST}=${TARGET},host.cireweddings.com=cire-host.pages.dev`,
    `Vendor.cireweddings.com=${TARGET}`,
    `vendor=${TARGET}`,
  ])("R3: the value %j stops every Worker's attach before any request", async (value) => {
    const module = await load(path);
    expect(() => module.parseReplaceCname(value)).toThrow(ENV);
    for (const desired of [[HOST], ["host.cireweddings.com"], []]) {
      const r = await run(module, { before: [cname(TARGET)] }, { env: { [ENV]: value }, desired });
      expect(failure(r)).toContain(ENV);
      expect({ desired, sent: r.sent, zones: r.zoneLookups }).toEqual({
        desired,
        sent: [],
        zones: [],
      });
    }
  });

  test("M1: a Worker with another custom domain beside the named host stops before any request", async () => {
    const r = await run(
      await load(path),
      { before: [cname(TARGET)] },
      { env: flipEnv(), desired: [HOST, "www.cireweddings.com"] },
    );
    expect(failure(r)).toContain("one custom domain");
    expect(r.sent).toEqual([]);
  });

  test("R4: a host holding exactly its CNAME to the target is replaced in one PUT of Wrangler's fields, then read back for its id and zone", async () => {
    const r = await run(await load(path), { before: [cname(TARGET)] }, { env: flipEnv() });
    expect(success(r)).toEqual({
      replacement: { host: HOST, target: TARGET, zoneId: ZONE, kept: [] },
      attached: { hostname: HOST, id: "wd-1", zoneId: ZONE },
    });
    expect(r.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
      `GET /zones/${ZONE}/dns_records?name.exact=${HOST}&per_page=100`,
      `PUT /accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/domains/records`,
      `GET /zones/${ZONE}/dns_records?name.exact=${HOST}&per_page=100`,
      `GET /accounts/${ACCOUNT}/workers/domains?hostname=${HOST}&service=${SCRIPT}`,
    ]);
    expect(writes(r).map((sent) => sent.body)).toEqual([
      {
        override_scope: true,
        override_existing_origin: false,
        override_existing_dns_record: true,
        origins: [{ hostname: HOST, zone_id: ZONE }],
      },
    ]);
    expect(r.sent.every((sent) => sent.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(r.zoneLookups).toEqual([HOST]);
    expect(r.logs.join("\n")).toContain(
      `replaced ${HOST}'s CNAME to ${TARGET} with ${SCRIPT}'s custom domain`,
    );
    // A Worker opted into custom-domain Previews keeps the opt-in.
    const previews = await run(
      await load(path),
      { before: [cname(TARGET)] },
      { env: flipEnv(), previewsEnabled: true },
    );
    expect(writes(previews).map((sent) => sent.body)).toEqual([
      {
        override_scope: true,
        override_existing_origin: false,
        override_existing_dns_record: true,
        origins: [{ hostname: HOST, zone_id: ZONE, previews_enabled: true }],
      },
    ]);
  });

  test("R4a: another host's attach in the same deploy goes on as before", async () => {
    const module = await load(path);
    const r = await run(module, { before: [cname(TARGET)] }, { env: flipEnv() });
    const replacement = success(r).replacement;
    const other = await Effect.runPromise(
      module.replacingAttach(replacement, {
        accountId: ACCOUNT,
        scriptName: SCRIPT,
        hostname: "next.vendor.cireweddings.com",
        zoneId: ZONE,
      }) as Effect.Effect<Attached | undefined>,
    );
    expect(other).toBeUndefined();
  });

  test.each([
    { name: "another project's pages.dev name", records: [cname("cire-host.pages.dev")] },
    { name: "a name outside pages.dev", records: [cname("elsewhere.example.net")] },
    { name: "the target, twice", records: [cname(TARGET), cname(TARGET, "rec-2")] },
  ])("R5: a CNAME to $name stops the attach, writing nothing", async ({ records }) => {
    const r = await run(await load(path), { before: records }, { env: flipEnv() });
    expect(failure(r)).toContain(`${HOST} holds`);
    expect(writes(r)).toEqual([]);
  });

  test.each([
    { type: "A", record: { id: "a", type: "A", content: "192.0.2.1" } },
    { type: "AAAA", record: { id: "aaaa", type: "AAAA", content: "2001:db8::1" } },
    { type: "HTTPS", record: { id: "https", type: "HTTPS", content: '1 . alpn="h2"' } },
    { type: "a Worker's AAAA", record: WORKER_RECORD },
    { type: "NS", record: { id: "ns", type: "NS", content: "ns1.example.net" } },
  ])("R6: the CNAME beside $type stops the attach, writing nothing", async ({ record }) => {
    const r = await run(await load(path), { before: [cname(TARGET), record] }, { env: flipEnv() });
    expect(failure(r)).toContain(`${HOST} holds`);
    expect(writes(r)).toEqual([]);
  });

  test("R7: a host below its zone holding TXT, MX and CAA beside the CNAME is replaced; a TXT gone after it stops the deploy", async () => {
    const kept = await run(
      await load(path),
      { before: [cname(TARGET), TXT, MX, CAA] },
      { env: flipEnv() },
    );
    expect(success(kept).attached).toEqual({ hostname: HOST, id: "wd-1", zoneId: ZONE });
    const lost = await run(
      await load(path),
      { before: [cname(TARGET), TXT, MX, CAA], after: [WORKER_RECORD, MX, CAA] },
      { env: flipEnv() },
    );
    const message = failure(lost);
    expect(message).toContain("TXT");
    expect(message).not.toContain("v=spf1");
    expect(writes(lost)).toHaveLength(1);
  });

  test("M2: an apex holding any other record beside its CNAME stops before the PUT unless the apex is allowed", async () => {
    const env = flipEnv(APEX, APEX_TARGET);
    const records = [cname(APEX_TARGET), TXT, MX];
    const held = await run(await load(path), { before: records }, { env, desired: [APEX] });
    expect(failure(held)).toContain(ALLOW_APEX);
    expect(writes(held)).toEqual([]);
    const allowed = await run(
      await load(path),
      { before: records },
      { env: { ...env, [ALLOW_APEX]: "1" }, desired: [APEX] },
    );
    expect(Exit.isSuccess(allowed.exit)).toBe(true);
    expect(writes(allowed)).toHaveLength(1);
    // An apex holding its CNAME alone needs no allowance.
    const bare = await run(
      await load(path),
      { before: [cname(APEX_TARGET)] },
      { env, desired: [APEX] },
    );
    expect(Exit.isSuccess(bare.exit)).toBe(true);
  });

  test("R8: a host holding no record that routes it attaches as before, saying its CNAME was already gone", async () => {
    for (const before of [[], [TXT]]) {
      const r = await run(await load(path), { before }, { env: flipEnv() });
      expect(success(r)).toEqual({ replacement: undefined, attached: undefined });
      expect(writes(r)).toEqual([]);
      expect(r.logs.join("\n")).toContain(`its CNAME to ${TARGET} was already gone`);
    }
  });

  test.each([
    { name: "a 403", reply: refused(403, 10000, "Authentication error") },
    { name: "code 100117", reply: refused(409, 100117, "Hostname already has a DNS record") },
    { name: "no answer", reply: "down" as const },
  ])(
    "R9: an override PUT answered with $name stops the deploy naming the call, sent once",
    async ({ reply }) => {
      const r = await run(
        await load(path),
        { before: [cname(TARGET)], puts: [reply] },
        {
          env: flipEnv(),
        },
      );
      expect(failure(r)).toContain(`replacing ${HOST}'s CNAME with ${SCRIPT}'s custom domain`);
      expect(writes(r)).toHaveLength(1);
      expect(r.sleeps).toEqual([]);
    },
  );

  test("R9a: an override PUT answered 100116 or 10007 is sent again on its schedule", async () => {
    const conflict = await run(
      await load(path),
      { before: [cname(TARGET)], puts: [refused(409, 100116), refused(409, 100116)] },
      { env: flipEnv() },
    );
    expect(success(conflict).attached?.id).toBe("wd-1");
    expect(writes(conflict)).toHaveLength(3);
    expect(conflict.sleeps).toEqual([2_000, 2_000]);
    const notYet = await run(
      await load(path),
      {
        before: [cname(TARGET)],
        puts: [refused(404, 10007, "workers.api.error.script_not_found")],
      },
      { env: flipEnv() },
    );
    expect(success(notYet).attached?.id).toBe("wd-1");
    expect(writes(notYet)).toHaveLength(2);
    expect(notYet.sleeps).toHaveLength(1);
    // A conflict that never clears stops after its eight retries.
    const stuck = await run(
      await load(path),
      { before: [cname(TARGET)], puts: Array.from({ length: 12 }, () => refused(409, 100116)) },
      { env: flipEnv() },
    );
    expect(failure(stuck)).toContain("100116");
    expect(writes(stuck)).toHaveLength(9);
  });

  test.each([
    { name: "a 403", reads: [refused(403, 9109)] },
    { name: "a 500", reads: [refused(500, 0)] },
    { name: "no answer", reads: ["down" as const] },
    { name: "a result that is no list", reads: [ok({ id: "x" })] },
    { name: "a second page", reads: [ok([cname(TARGET)], { total_count: 101 })] },
  ])("R10: a DNS read answered with $name stops the attach, writing nothing", async ({ reads }) => {
    const r = await run(await load(path), { before: [cname(TARGET)], reads }, { env: flipEnv() });
    expect(failure(r)).toContain(`reading ${HOST}'s DNS records`);
    expect(writes(r)).toEqual([]);
  });

  test("L4: the custom-domain read after the PUT is tried again until it lists the domain, then stops the deploy", async () => {
    const late = await run(
      await load(path),
      { before: [cname(TARGET)], lists: [ok([]), refused(500, 0)] },
      { env: flipEnv() },
    );
    expect(success(late).attached?.id).toBe("wd-1");
    expect(late.sleeps).toEqual([2_000, 2_000]);
    const never = await run(
      await load(path),
      { before: [cname(TARGET)], lists: Array.from({ length: 12 }, () => ok([])) },
      { env: flipEnv() },
    );
    expect(failure(never)).toContain(`listing ${SCRIPT}'s custom domain for ${HOST}`);
    expect(writes(never)).toHaveLength(1);
  });

  test("R11: no message carries the token, the account id or the text of a reply", async () => {
    const leak = `account ${ACCOUNT} token ${TOKEN}`;
    const runs = [
      await run(
        await load(path),
        { before: [cname(TARGET)], reads: [refused(403, 9109, leak)] },
        { env: flipEnv() },
      ),
      await run(
        await load(path),
        { before: [cname(TARGET)], puts: [refused(403, 10000, leak)] },
        { env: flipEnv() },
      ),
      await run(
        await load(path),
        { before: [cname(TARGET)], puts: [{ status: 502, body: `<html>${leak}</html>` }] },
        { env: flipEnv() },
      ),
      await run(
        await load(path),
        { before: [cname(TARGET)], lists: Array.from({ length: 12 }, () => refused(500, 7, leak)) },
        { env: flipEnv() },
      ),
    ];
    for (const r of runs) {
      const message = failure(r);
      expect(message).not.toContain(ACCOUNT);
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain("<html>");
      expect(r.logs.join("\n")).not.toContain(ACCOUNT);
    }
    // Cloudflare's own code and message stay, the account named in neither.
    expect(failure(runs[1]!)).toContain("10000 account <account> token <secret>");
  });
});

describe("the provider's custom-domain reconcile, both copies", () => {
  /**
   * A declaration's text in `source`: from `start` to the first later line
   * indented no deeper than it that does not close its parameter list.
   */
  const body = (source: string, start: RegExp): string => {
    const at = source.search(start);
    expect(at).toBeGreaterThan(-1);
    const lineStart = source.lastIndexOf("\n", at) + 1;
    const indent = /^ */.exec(source.slice(lineStart))?.[0].length ?? 0;
    const rest = source.slice(at).split("\n");
    const end = rest.findIndex(
      (line, index) =>
        index > 0 &&
        line.trim() !== "" &&
        !line.trim().startsWith(")") &&
        /^ */.exec(line)![0].length <= indent,
    );
    return rest.slice(0, end === -1 ? undefined : end + 1).join("\n");
  };

  test.each(COPIES)(
    "L5/F5: $copy checks before it reads or deletes any domain, and the hook runs before putDomain",
    ({ copy, provider }) => {
      const source = readFileSync(join(CLOUDFLARE_DIR, provider), "utf8");
      const extension = copy === "src" ? "ts" : "js";
      expect(source).toContain(
        `import { checkReplaceCname, replacingAttach } from "./ReplaceCname.${extension}";`,
      );
      const reconcile = body(source, /const reconcileDomains = /);
      const check = reconcile.indexOf("checkReplaceCname(");
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(reconcile.indexOf("workers.listDomains("));
      expect(check).toBeLessThan(reconcile.indexOf(".deleteDomain("));
      // Once: one check per reconcile, one hook per attach.
      expect(reconcile.split("checkReplaceCname(").length).toBe(2);
      const attach = body(reconcile, /const attachDomain = /);
      const hook = attach.indexOf("replacingAttach(");
      expect(hook).toBeGreaterThan(-1);
      expect(hook).toBeLessThan(attach.indexOf(".putDomain("));
      expect(attach.split("replacingAttach(").length).toBe(2);
    },
  );
});

describe("the routing rule", () => {
  const RECORDS: DnsRecord[] = [
    cname(TARGET),
    cname("elsewhere.example.net"),
    WORKER_RECORD,
    { id: "w2", type: "A", content: "192.0.2.1", meta: { origin_worker_id: "w" } },
    { id: "ro", type: "AAAA", content: "100::", meta: { read_only: true } },
    { id: "aaaa", type: "AAAA", content: "100::" },
    { id: "a", type: "A", content: "192.0.2.1" },
    { id: "https", type: "HTTPS", content: '1 . alpn="h2"' },
    { id: "svcb", type: "SVCB", content: "1 . port=443" },
    { id: "ns", type: "NS", content: "ns1.example.net" },
    { id: "loc", type: "LOC", content: "51 30 12.748 N" },
    TXT,
    MX,
    CAA,
  ];

  test.each(COPIES)(
    "matches scripts/pages-domain.ts's decides on every record, at an apex and below it ($copy)",
    async ({ path }) => {
      const { routesHost } = await load(path);
      const { decides } = (await import(
        /* @vite-ignore */ fileURLToPath(
          new URL("../../../scripts/pages-domain.ts", import.meta.url),
        )
      )) as { decides: (host: string, record: DnsRecord) => boolean };
      for (const host of [HOST, APEX, "musubi.social", "www.musubi.social"]) {
        for (const record of RECORDS) {
          expect({ host, record: record.id, routes: routesHost(host, record) }).toEqual({
            host,
            record: record.id,
            routes: decides(host, record),
          });
        }
      }
    },
  );
});
