// scripts/flip-record-check.ts runs in a flip release's verify job, before
// the detach: with the deploy's own token it reads the flip host's records
// and refuses what the deploy's attach would refuse. These drive it with an
// injected fetch standing in for the Cloudflare API.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runFlipRecordCheck } from "../flip-record-check";
import type { DnsRecord } from "../pages-domain";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "production-deploy-token-for-tests";
const API = "https://api.cloudflare.com/client/v4";
const ENV = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };
const VENDOR = "vendor.cireweddings.com=cire-vendor.pages.dev";

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
const failed = (status: number, code: number, message = "refused") =>
  new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });

const cname = (target: string, id = "rec-cname"): DnsRecord => ({
  id,
  type: "CNAME",
  content: target,
  proxied: true,
});

interface World {
  records: Record<string, readonly DnsRecord[]>;
  zones?: { id: string; name: string; account: { id: string } }[];
  fail?: Record<string, Response>;
}

async function run(env: Record<string, string | undefined>, world: World) {
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const files: Record<string, string> = {};
  const lines: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const path = url.slice(API.length);
    calls.push({ method, path, auth: new Headers(init?.headers).get("authorization") });
    const failure = world.fail?.[`${method} ${path.split("?")[0]}`];
    if (failure !== undefined) return failure;
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    const zones = world.zones ?? [
      { id: "zone-cire", name: "cireweddings.com", account: { id: ACCOUNT } },
    ];
    if (method === "GET" && path.startsWith("/zones?")) {
      return ok(zones.filter((zone) => zone.name === query.get("name")));
    }
    const byId = /^\/zones\/([^/?]+)$/.exec(path);
    if (method === "GET" && byId !== null) {
      return ok(zones.find((zone) => zone.id === byId[1]) ?? null);
    }
    if (method === "GET" && /^\/zones\/[^/]+\/dns_records\?/.test(path)) {
      return ok(world.records[query.get("name") ?? ""] ?? []);
    }
    throw new Error(`test fetched an unlisted URL: ${method} ${url}`);
  };
  const code = await runFlipRecordCheck({
    env: { ...ENV, GITHUB_STEP_SUMMARY: "/tmp/summary.md", ...env },
    fetch: fetch as unknown as typeof globalThis.fetch,
    out: (text) => lines.push(text),
    sleep: async () => {},
    writeSummary: (path, text) => {
      files[path] = (files[path] ?? "") + text;
    },
  });
  return { code, calls, output: lines.join(""), summary: files["/tmp/summary.md"] ?? "" };
}

describe("flip-record-check.ts", () => {
  test("FR1: imports nothing but node:fs and the repository's own import-free files", () => {
    const source = readFileSync(join(import.meta.dir, "..", "flip-record-check.ts"), "utf8");
    const imports = [...source.matchAll(/^import (?!type )[^;]*from "([^"]+)";/gm)].map(
      (m) => m[1],
    );
    expect(imports.toSorted()).toEqual(
      ["../shared/infra/src/production-sites", "./pages-domain", "node:fs"].toSorted(),
    );
  });

  test.each([
    { what: "no value", env: { REPLACE_CNAME: "" } },
    { what: "two pairs", env: { REPLACE_CNAME: `${VENDOR} host.cireweddings.com=x.pages.dev` } },
    { what: "a target outside pages.dev", env: { REPLACE_CNAME: "vendor.cireweddings.com=x.net" } },
    {
      what: "a pair no site's flip deploys with",
      env: { REPLACE_CNAME: "vendor.cireweddings.com=cire-host.pages.dev" },
    },
    { what: "no token", env: { REPLACE_CNAME: VENDOR, CLOUDFLARE_API_TOKEN: "" } },
  ])("FR2: $what exits 2 before any request", async ({ env }) => {
    const result = await run(env, { records: {} });
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
  });

  test("FR3: a host holding its own CNAME alone passes, looked up by zone name, and the summary names the replacement", async () => {
    const result = await run(
      { REPLACE_CNAME: VENDOR },
      {
        records: {
          "vendor.cireweddings.com": [
            cname("cire-vendor.pages.dev"),
            { id: "t", type: "TXT", content: "v" },
          ],
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /zones?name=cireweddings.com",
      "GET /zones/zone-cire",
      "GET /zones/zone-cire/dns_records?name=vendor.cireweddings.com",
    ]);
    expect(result.calls.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(result.summary).toContain(
      "The deploy will replace vendor.cireweddings.com's CNAME to cire-vendor.pages.dev with the Worker's custom domain.",
    );
    expect(result.output).toContain("vendor.cireweddings.com");
  });

  test.each([
    { what: "another target", records: [cname("cire-host.pages.dev")] },
    {
      what: "an AAAA beside the CNAME",
      records: [cname("cire-vendor.pages.dev"), { id: "a", type: "AAAA", content: "2001:db8::1" }],
    },
    { what: "no record", records: [] },
  ])("FR4: a host holding $what is refused, before the detach", async ({ records }) => {
    const result = await run(
      { REPLACE_CNAME: VENDOR },
      { records: { "vendor.cireweddings.com": records } },
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("::error::flip-record-check:");
    expect(result.output).toContain("not exactly its CNAME to cire-vendor.pages.dev");
    expect(result.summary).toBe("");
  });

  test("FR4: an apex holding a TXT beside its CNAME is refused", async () => {
    const result = await run(
      { REPLACE_CNAME: "cireweddings.com=cire-landing.pages.dev" },
      {
        records: {
          "cireweddings.com": [
            cname("cire-landing.pages.dev"),
            { id: "t", type: "TXT", content: "v" },
          ],
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("apex");
  });

  test("FR5: a zone the token does not see, or in another account, or an API failure, is refused naming the call, never the token or the account", async () => {
    const worlds: [string, World, string][] = [
      ["no zone", { records: {}, zones: [] }, "finds no cireweddings.com zone"],
      [
        "another account's zone",
        {
          records: {},
          zones: [{ id: "z", name: "cireweddings.com", account: { id: "f".repeat(32) } }],
        },
        "finds no cireweddings.com zone",
      ],
      [
        "a refused read",
        {
          records: {},
          fail: { "GET /zones/zone-cire/dns_records": failed(403, 10000, `no ${ACCOUNT}`) },
        },
        "listing vendor.cireweddings.com's DNS records: Cloudflare answered 403 (codes 10000)",
      ],
      [
        "a refused read of the zone by its id, which the deploy makes",
        {
          records: {},
          fail: { "GET /zones/zone-cire": failed(403, 9109, `no ${ACCOUNT}`) },
        },
        "reading the cireweddings.com zone by its id: Cloudflare answered 403 (codes 9109)",
      ],
    ];
    for (const [what, world, message] of worlds) {
      const result = await run({ REPLACE_CNAME: VENDOR }, world);
      expect({ what, code: result.code, said: result.output.includes(message) }).toEqual({
        what,
        code: 1,
        said: true,
      });
      expect(result.output).not.toContain(TOKEN);
      expect(result.output).not.toContain(ACCOUNT);
    }
    // A zone read the deploy token gets no answer to stops the check before the host's records.
    const byId = await run({ REPLACE_CNAME: VENDOR }, worlds[3]![1]);
    expect(byId.calls.some((call) => call.path.includes("/dns_records"))).toBe(false);
  });
});
