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
 * the detach, for hosts in a zone named by their last two labels, as every
 * production host's zone is; the patch takes the zone's name from Cloudflare.
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
  readonly zone: string;
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
  readonly routesHost: (host: string, zone: string, record: DnsRecord) => boolean;
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
/** How a refusal before any domain moved ends. */
const UNCHANGED = "no custom domain or DNS record was changed";
/** How a refusal in the attach, after the reconcile removed the Worker's other domains, ends. */
const NOT_REPLACED = "its CNAME was not replaced";
/** The line a deploy logs when the named host holds no record that routes it. */
const GONE = "was already gone, so it attaches as usual";

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
const A: DnsRecord = { id: "rec-a", type: "A", content: "192.0.2.1" };

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
  /** The name of the zone `ZONE` is; the apex `cireweddings.com` unless set. */
  zone?: string;
  /** Answers to the zone read, in turn; "down" is a network failure. */
  zoneReads?: (Reply | "down")[];
  /** Answers to the DNS read, in turn; "down" is a network failure. */
  reads?: (Reply | "down")[];
  /** Answers to the override PUT, in turn; "down" is a network failure. */
  puts?: (Reply | "down")[];
  /** Answers to the custom-domain listing, in turn; "down" is a network failure. */
  lists?: (Reply | "down")[];
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
  /** Each log line as `<level> <message>`. */
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

const ZONE_READ = `GET /zones/${ZONE}`;
const RECORDS_READ = `GET /zones/${ZONE}/dns_records?name.exact=`;
const PUT = `PUT /accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/domains/records`;
const LISTING = `GET /accounts/${ACCOUNT}/workers/domains?`;

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
    /** The zone the attach hook is handed, when it is not the one the check read. */
    readonly attachZoneId?: string;
  } = {},
): Promise<Run> {
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const zoneLookups: string[] = [];
  const desired = options.desired ?? [HOST];
  const zoneReads = [...(w.zoneReads ?? [])];
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
    const call = `${request.method} ${path}`;
    if (call === ZONE_READ) {
      return answer(zoneReads.shift(), () => ok({ id: ZONE, name: w.zone ?? APEX }));
    }
    if (call.startsWith(RECORDS_READ)) {
      return answer(reads.shift(), () =>
        ok(
          replaced
            ? (w.after ?? [...w.before.filter((record) => record.type !== "CNAME"), WORKER_RECORD])
            : w.before,
        ),
      );
    }
    if (call === PUT) {
      const next = puts.shift();
      if (next === undefined || (next !== "down" && next.status === 200)) replaced = true;
      return answer(next, () => ok([{ hostname: host, zone_id: ZONE }]));
    }
    if (call.startsWith(LISTING)) {
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
        zoneId: options.attachZoneId ?? ZONE,
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
      Effect.provide(
        Logger.layer([
          Logger.make((log) => logs.push(`${log.logLevel} ${JSON.stringify(log.message)}`)),
        ]),
      ),
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
const calls = (r: Run, prefix: string) =>
  r.sent.filter((sent) => `${sent.method} ${sent.path}`.startsWith(prefix));
const flipEnv = (host = HOST, target = TARGET) => ({ [ENV]: `${host}=${target}` });
const CHECKED: Replacement = { host: HOST, target: TARGET, zoneId: ZONE, zone: APEX };

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
      expect(failure(r)).toContain(UNCHANGED);
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
    expect(failure(r)).toContain(UNCHANGED);
    expect(r.sent).toEqual([]);
  });

  test("R4: a host holding exactly its CNAME to the target is read in its zone, read again, replaced in one PUT of Wrangler's fields, then read back for its id and zone", async () => {
    const r = await run(await load(path), { before: [cname(TARGET)] }, { env: flipEnv() });
    expect(success(r)).toEqual({
      replacement: CHECKED,
      attached: { hostname: HOST, id: "wd-1", zoneId: ZONE },
    });
    expect(r.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
      ZONE_READ,
      `${RECORDS_READ}${HOST}&per_page=100`,
      `${RECORDS_READ}${HOST}&per_page=100`,
      PUT,
      `${RECORDS_READ}${HOST}&per_page=100`,
      `${LISTING}hostname=${HOST}&service=${SCRIPT}`,
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
    expect(r.sleeps).toEqual([]);
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
  ])("R5: a CNAME to $name stops the attach, with no domain or DNS write", async ({ records }) => {
    const r = await run(await load(path), { before: records }, { env: flipEnv() });
    expect(failure(r)).toContain(`${HOST} holds`);
    expect(failure(r)).toContain(UNCHANGED);
    expect(writes(r)).toEqual([]);
  });

  test.each([
    { type: "A", record: A },
    { type: "AAAA", record: { id: "aaaa", type: "AAAA", content: "2001:db8::1" } },
    { type: "HTTPS", record: { id: "https", type: "HTTPS", content: '1 . alpn="h2"' } },
    { type: "a Worker's AAAA", record: WORKER_RECORD },
    { type: "NS", record: { id: "ns", type: "NS", content: "ns1.example.net" } },
  ])(
    "R6: the CNAME beside $type stops the attach, with no domain or DNS write",
    async ({ record }) => {
      const r = await run(
        await load(path),
        { before: [cname(TARGET), record] },
        { env: flipEnv() },
      );
      expect(failure(r)).toContain(`${HOST} holds`);
      expect(writes(r)).toEqual([]);
    },
  );

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

  test.each([
    { name: "a record that routes the host is added", second: [cname(TARGET), A] },
    { name: "the CNAME is pointed elsewhere", second: [cname("cire-host.pages.dev")] },
    { name: "a second CNAME appears", second: [cname(TARGET), cname(TARGET, "rec-2")] },
  ])(
    "when $name between the check and the attach, the attach stops before its PUT",
    async ({ second }) => {
      const r = await run(
        await load(path),
        { before: [cname(TARGET)], reads: [ok([cname(TARGET)]), ok(second)] },
        { env: flipEnv() },
      );
      const message = failure(r);
      expect(message).toContain(`${HOST} holds`);
      expect(message).toContain(NOT_REPLACED);
      expect(writes(r)).toEqual([]);
      expect(calls(r, RECORDS_READ)).toHaveLength(2);
    },
  );

  test("an apex that gains a record beside its CNAME between the check and the attach stops before the PUT", async () => {
    const r = await run(
      await load(path),
      {
        before: [cname(APEX_TARGET)],
        reads: [ok([cname(APEX_TARGET)]), ok([cname(APEX_TARGET), TXT])],
      },
      { env: flipEnv(APEX, APEX_TARGET), desired: [APEX] },
    );
    expect(failure(r)).toContain(ALLOW_APEX);
    expect(failure(r)).toContain(NOT_REPLACED);
    expect(writes(r)).toEqual([]);
  });

  test("a CNAME gone between the check and the attach leaves the host to the provider's own attach, with a warning", async () => {
    const r = await run(
      await load(path),
      { before: [cname(TARGET)], reads: [ok([cname(TARGET)]), ok([TXT])] },
      { env: flipEnv() },
    );
    expect(success(r)).toEqual({ replacement: CHECKED, attached: undefined });
    expect(writes(r)).toEqual([]);
    const line = r.logs.find((log) => log.includes(GONE));
    expect(line).toBeDefined();
    expect(line?.startsWith("Warn ")).toBe(true);
  });

  test("a record that routes the host, written while a refused PUT waits to be sent again, stops the attach before the next PUT", async () => {
    const r = await run(
      await load(path),
      {
        before: [cname(TARGET)],
        puts: [refused(409, 100116)],
        reads: [ok([cname(TARGET)]), ok([cname(TARGET)]), ok([cname(TARGET), A])],
      },
      { env: flipEnv() },
    );
    expect(failure(r)).toContain(`${HOST} holds`);
    expect(writes(r)).toHaveLength(1);
    expect(r.sleeps).toEqual([2_000]);
  });

  test("a record beside the CNAME at the attach's read, gone after the PUT, stops the deploy naming it", async () => {
    const r = await run(
      await load(path),
      { before: [cname(TARGET)], reads: [ok([cname(TARGET)]), ok([cname(TARGET), TXT])] },
      { env: flipEnv() },
    );
    const message = failure(r);
    expect(message).toContain(`${HOST}'s TXT record is gone after its CNAME was replaced`);
    expect(message).not.toContain("v=spf1");
    expect(writes(r)).toHaveLength(1);
  });

  test("an attach zone that differs from the zone the check read stops before any write", async () => {
    const r = await run(
      await load(path),
      { before: [cname(TARGET)] },
      { env: flipEnv(), attachZoneId: "zone-other" },
    );
    expect(failure(r)).toContain("two different zones");
    expect(writes(r)).toEqual([]);
  });

  test("a failed re-read after the replacement names the host, sends one write and leaks nothing", async () => {
    const leak = `account ${ACCOUNT} token ${TOKEN}`;
    const r = await run(
      await load(path),
      {
        before: [cname(TARGET), TXT],
        reads: [ok([cname(TARGET), TXT]), ok([cname(TARGET), TXT]), refused(403, 9109, leak)],
      },
      { env: flipEnv() },
    );
    const message = failure(r);
    expect(message).toContain("check its other records by hand");
    expect(message).toContain(HOST);
    expect(writes(r)).toHaveLength(1);
    expect(message).not.toContain(ACCOUNT);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(leak);
    expect(message).not.toContain("refused");
    expect(r.logs.join("\n")).not.toContain(ACCOUNT);
    expect(r.logs.join("\n")).not.toContain(TOKEN);
  });

  test("M2: an apex holding any other record beside its CNAME stops before the PUT unless the apex is allowed", async () => {
    const env = flipEnv(APEX, APEX_TARGET);
    const records = [cname(APEX_TARGET), TXT, MX];
    const held = await run(await load(path), { before: records }, { env, desired: [APEX] });
    expect(failure(held)).toContain(ALLOW_APEX);
    expect(failure(held)).toContain(UNCHANGED);
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

  test("the apex is the zone Cloudflare names: a three-label zone's apex holding a TXT beside its CNAME stops, a host below it goes ahead", async () => {
    const zone = "example.co.uk";
    const target = "example.pages.dev";
    const apex = await run(
      await load(path),
      { zone, before: [cname(target), TXT] },
      { env: flipEnv(zone, target), desired: [zone] },
    );
    expect(failure(apex)).toContain(`${zone} is its zone's apex`);
    expect(failure(apex)).toContain(ALLOW_APEX);
    expect(writes(apex)).toEqual([]);
    const below = await run(
      await load(path),
      { zone, before: [cname(target), TXT] },
      { env: flipEnv(`a.${zone}`, target), desired: [`a.${zone}`] },
    );
    expect(success(below).replacement).toEqual({
      host: `a.${zone}`,
      target,
      zoneId: ZONE,
      zone,
    });
    expect(writes(below)).toHaveLength(1);
  });

  test("a zone whose name does not hold the host stops before its records are read", async () => {
    const r = await run(
      await load(path),
      { zone: "musubi.social", before: [cname(TARGET)] },
      { env: flipEnv() },
    );
    expect(failure(r)).toContain(`${HOST} is not in the musubi.social zone`);
    expect(failure(r)).toContain(UNCHANGED);
    expect(calls(r, RECORDS_READ)).toEqual([]);
    expect(writes(r)).toEqual([]);
  });

  test.each([
    { name: "a 403", zoneReads: [refused(403, 9109)] },
    { name: "a result with no name", zoneReads: [ok({ id: ZONE })] },
    { name: "three 5xx", zoneReads: [refused(500, 0), refused(502, 0), refused(503, 0)] },
  ])("a zone read answered with $name stops before the records are read", async ({ zoneReads }) => {
    const r = await run(
      await load(path),
      { before: [cname(TARGET)], zoneReads },
      { env: flipEnv() },
    );
    expect(failure(r)).toContain(`reading ${HOST}'s zone`);
    expect(failure(r)).toContain(UNCHANGED);
    expect(calls(r, RECORDS_READ)).toEqual([]);
    expect(writes(r)).toEqual([]);
  });

  test("R8: a host holding no record that routes it attaches as before, warning that its CNAME was already gone", async () => {
    for (const before of [[], [TXT]]) {
      const r = await run(await load(path), { before }, { env: flipEnv() });
      expect(success(r)).toEqual({ replacement: undefined, attached: undefined });
      expect(writes(r)).toEqual([]);
      const line = r.logs.find((log) => log.includes(`its CNAME to ${TARGET} ${GONE}`));
      expect(line?.startsWith("Warn ")).toBe(true);
    }
  });

  test.each([
    { name: "a 403", reply: refused(403, 10000, "Authentication error") },
    { name: "code 100117", reply: refused(409, 100117, "Hostname already has a DNS record") },
    { name: "a 500", reply: refused(500, 0) },
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

  test("R9a: an override PUT answered 100116 or 10007 is sent again on its schedule, each try after a fresh read", async () => {
    const conflict = await run(
      await load(path),
      { before: [cname(TARGET)], puts: [refused(409, 100116), refused(409, 100116)] },
      { env: flipEnv() },
    );
    expect(success(conflict).attached?.id).toBe("wd-1");
    expect(writes(conflict)).toHaveLength(3);
    expect(conflict.sleeps).toEqual([2_000, 2_000]);
    // The check's read, one before each of the three tries, one after.
    expect(calls(conflict, RECORDS_READ)).toHaveLength(5);
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
    { name: "a 404", reads: [refused(404, 7003)] },
    { name: "a result that is no list", reads: [ok({ id: "x" })] },
    { name: "a second page", reads: [ok([cname(TARGET)], { total_count: 101 })] },
  ])(
    "R10: a DNS read answered with $name stops the attach at once, with no domain or DNS write",
    async ({ reads }) => {
      const r = await run(await load(path), { before: [cname(TARGET)], reads }, { env: flipEnv() });
      expect(failure(r)).toContain(`reading ${HOST}'s DNS records`);
      expect(failure(r)).toContain(UNCHANGED);
      expect(writes(r)).toEqual([]);
      expect(calls(r, RECORDS_READ)).toHaveLength(1);
      expect(r.sleeps).toEqual([]);
    },
  );

  test.each([
    { name: "a 500", reply: refused(500, 0) },
    { name: "a 429", reply: refused(429, 971) },
    { name: "no answer", reply: "down" as const },
  ])(
    "R10: a DNS read answered with $name is sent again 1 s then 2 s later, and stops after the third",
    async ({ reply }) => {
      const once = await run(
        await load(path),
        { before: [cname(TARGET)], reads: [reply] },
        { env: flipEnv() },
      );
      expect(success(once).attached?.id).toBe("wd-1");
      expect(once.sleeps).toEqual([1_000]);
      expect(writes(once)).toHaveLength(1);
      const always = await run(
        await load(path),
        { before: [cname(TARGET)], reads: [reply, reply, reply] },
        { env: flipEnv() },
      );
      expect(failure(always)).toContain(`reading ${HOST}'s DNS records`);
      expect(always.sleeps).toEqual([1_000, 2_000]);
      expect(calls(always, RECORDS_READ)).toHaveLength(3);
      expect(writes(always)).toEqual([]);
    },
  );

  test("R10: the attach's read failing stops it before the PUT", async () => {
    const r = await run(
      await load(path),
      { before: [cname(TARGET)], reads: [ok([cname(TARGET)]), refused(403, 9109)] },
      { env: flipEnv() },
    );
    expect(failure(r)).toContain(`reading ${HOST}'s DNS records`);
    expect(failure(r)).toContain(NOT_REPLACED);
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
    expect(calls(never, LISTING)).toHaveLength(9);
  });

  test("L4: the custom-domain read refused with a 4xx other than 429 stops the deploy at once", async () => {
    for (const reply of [refused(403, 10000), refused(400, 10001), refused(404, 10007)]) {
      const r = await run(
        await load(path),
        { before: [cname(TARGET)], lists: [reply] },
        { env: flipEnv() },
      );
      expect(failure(r)).toContain(`listing ${SCRIPT}'s custom domain for ${HOST}`);
      expect(calls(r, LISTING)).toHaveLength(1);
      expect(r.sleeps).toEqual([]);
    }
    const throttled = await run(
      await load(path),
      { before: [cname(TARGET)], lists: [refused(429, 971), "down"] },
      { env: flipEnv() },
    );
    expect(success(throttled).attached?.id).toBe("wd-1");
    expect(throttled.sleeps).toEqual([2_000, 2_000]);
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
      await run(
        await load(path),
        { before: [cname(TARGET)], zoneReads: [refused(403, 9109, leak)] },
        { env: flipEnv() },
      ),
      await run(
        await load(path),
        { before: [cname(TARGET)], reads: [ok([cname(TARGET)]), refused(403, 9109, leak)] },
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
      // The hook gets the check's result, and a replacement ends the attach.
      const flat = (text: string): string => text.replace(/\s+/g, " ");
      expect(flat(reconcile)).toContain("const replacement = yield* checkReplaceCname({");
      const wired = flat(attach);
      const call = wired.indexOf("const replaced = yield* replacingAttach(replacement, {");
      expect(call).toBeGreaterThan(-1);
      const early = wired.indexOf("if (replaced !== undefined) return replaced;");
      expect(early).toBeGreaterThan(call);
      expect(early).toBeLessThan(wired.indexOf(".putDomain("));
      expect(wired.split("if (replaced !== undefined) return replaced;").length).toBe(2);
    },
  );

  test.each(COPIES)(
    "$copy resolves the checked host's zone once: the check fills the cache the attach reads",
    ({ provider }) => {
      const source = readFileSync(join(CLOUDFLARE_DIR, provider), "utf8");
      const reconcile = body(source, /const reconcileDomains = /).replace(/\s+/g, " ");
      const declared = [
        ...reconcile.matchAll(/const zoneCache = new Map(?:<string, string>)?\(\);/g),
      ];
      expect(declared).toHaveLength(1);
      const check = reconcile.indexOf("checkReplaceCname(");
      expect(declared[0]!.index).toBeLessThan(check);
      expect(reconcile).toContain(
        "zoneIdOf: (hostname) => inferZoneIdForHostname(hostname, zoneCache, zone),",
      );
      expect(reconcile).not.toContain("new Map(), zone)");
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
    A,
    { id: "https", type: "HTTPS", content: '1 . alpn="h2"' },
    { id: "svcb", type: "SVCB", content: "1 . port=443" },
    { id: "ns", type: "NS", content: "ns1.example.net" },
    { id: "loc", type: "LOC", content: "51 30 12.748 N" },
    TXT,
    MX,
    CAA,
  ];

  test.each(COPIES)(
    "matches scripts/pages-domain.ts's decides on every record, at an apex and below it, in two-label zones ($copy)",
    async ({ path }) => {
      const { routesHost } = await load(path);
      const { decides } = (await import(
        /* @vite-ignore */ fileURLToPath(
          new URL("../../../scripts/pages-domain.ts", import.meta.url),
        )
      )) as { decides: (host: string, record: DnsRecord) => boolean };
      for (const [host, zone] of [
        [HOST, APEX],
        [APEX, APEX],
        ["musubi.social", "musubi.social"],
        ["www.musubi.social", "musubi.social"],
      ] as const) {
        for (const record of RECORDS) {
          expect({ host, record: record.id, routes: routesHost(host, zone, record) }).toEqual({
            host,
            record: record.id,
            routes: decides(host, record),
          });
        }
      }
    },
  );

  test.each(COPIES)(
    "takes the apex from the zone's name: a three-label zone's own NS routes nothing at its apex, and delegates below it ($copy)",
    async ({ path }) => {
      const { routesHost } = await load(path);
      const ns: DnsRecord = { id: "ns", type: "NS", content: "ns1.example.net" };
      expect(routesHost("example.co.uk", "example.co.uk", ns)).toBe(false);
      expect(routesHost("a.example.co.uk", "example.co.uk", ns)).toBe(true);
    },
  );
});
