#!/usr/bin/env bun
/**
 * Operator tool for vendor claims held for review. A vendor who redeems a
 * claim link does not get the listing: cire-api records the claim on the
 * listing (`directory_vendors.review_*`) and waits for an operator, because the
 * link went to an address the organiser chose. This script lists those claims
 * and confirms or rejects one, by running SQL on the cire D1 through
 * `wrangler d1 execute`, so each change is made under the operator's own
 * Cloudflare login.
 *
 *   bun scripts/cire-vendor-claim-review.ts list    --env production
 *   bun scripts/cire-vendor-claim-review.ts confirm dv_… --env production          # dry run
 *   bun scripts/cire-vendor-claim-review.ts confirm dv_… --env production --apply
 *   bun scripts/cire-vendor-claim-review.ts reject  dv_… --env production --apply
 *
 * `--env` has no default: `local` (wrangler's local D1), `dev` or `production`.
 * Confirm and reject are dry runs unless `--apply` is given; a dry run reads
 * the claim, runs every check and prints the SQL it would send.
 *
 * Confirm moves the pending org and profile into `owner_org_id` and
 * `claimed_by_profile_id`, puts the listing live and stamps `handoff_due_at`;
 * the daily cron then hands the vendor the enquiries couples sent while the
 * listing was unclaimed. Reject clears the pending claim, which leaves the
 * listing unowned and claimable again.
 *
 * `wrangler d1 execute --command` takes no bound parameters, so every value
 * that reaches SQL is checked against a strict pattern first (`ID_PATTERN`),
 * and every UPDATE repeats the state it was checked against in its WHERE, so a
 * change made between the check and the write matches no row and is reported.
 */

export type Env = "local" | "dev" | "production";
export type Command = "list" | "confirm" | "reject";

export interface Args {
  command: Command;
  listingId: string | null;
  env: Env;
  apply: boolean;
}

/** The characters a cire listing, OSN org or OSN profile id is made of. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LISTING_PATTERN = /^dv_[A-Za-z0-9_-]{1,124}$/;

const USAGE =
  "usage: cire-vendor-claim-review.ts <list | confirm <listingId> | reject <listingId>> --env <local|dev|production> [--apply]";

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const positional: string[] = [];
  let env: Env | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--apply") apply = true;
    else if (arg === "--env") {
      const value = argv[++i];
      if (value !== "local" && value !== "dev" && value !== "production") {
        return { error: `--env must be local, dev or production\n${USAGE}` };
      }
      env = value;
    } else if (arg.startsWith("-")) return { error: `unknown flag ${arg}\n${USAGE}` };
    else positional.push(arg);
  }
  if (!env) return { error: `--env is required\n${USAGE}` };
  const [command, listingId, extra] = positional;
  if (extra !== undefined) return { error: USAGE };
  if (command === "list") {
    if (listingId !== undefined || apply) return { error: USAGE };
    return { command, listingId: null, env, apply: false };
  }
  if (command === "confirm" || command === "reject") {
    if (!listingId || !LISTING_PATTERN.test(listingId)) {
      return { error: `a listing id (dv_…) is required\n${USAGE}` };
    }
    return { command, listingId, env, apply };
  }
  return { error: USAGE };
}

/** The wrangler arguments that point `d1 execute` at one tier's cire D1. */
export function targetArgs(env: Env): string[] {
  // Database names and env blocks as `cire/db/package.json` db:migrate:* use them.
  if (env === "local") return ["cire-db", "--local"];
  if (env === "dev") return ["cire-db-dev", "--env", "dev", "--remote"];
  return ["cire-db", "--env", "production", "--remote"];
}

const quote = (id: string): string => {
  if (!ID_PATTERN.test(id)) throw new Error(`refusing to put ${JSON.stringify(id)} in SQL`);
  return `'${id}'`;
};

export const listSql = (): string =>
  "SELECT id, name, email, website, review_org_id, review_profile_id, " +
  "datetime(review_requested_at, 'unixepoch') AS requested_at " +
  "FROM directory_vendors WHERE review_org_id IS NOT NULL ORDER BY review_requested_at, id;";

export const showSql = (listingId: string): string =>
  "SELECT d.id, d.name, d.email, d.website, d.owner_org_id, d.review_org_id, d.review_profile_id, " +
  "(SELECT o.id FROM directory_vendors o WHERE o.owner_org_id = d.review_org_id) AS org_owns " +
  `FROM directory_vendors d WHERE d.id = ${quote(listingId)};`;

export const confirmSql = (listingId: string, orgId: string, profileId: string): string =>
  "UPDATE directory_vendors SET owner_org_id = review_org_id, " +
  "claimed_by_profile_id = review_profile_id, listed = 'live', " +
  "review_org_id = NULL, review_profile_id = NULL, review_requested_at = NULL, " +
  "handoff_due_at = unixepoch(), updated_at = unixepoch() " +
  `WHERE id = ${quote(listingId)} AND review_org_id = ${quote(orgId)} ` +
  `AND review_profile_id = ${quote(profileId)} AND owner_org_id IS NULL;`;

export const rejectSql = (listingId: string, orgId: string): string =>
  "UPDATE directory_vendors SET review_org_id = NULL, review_profile_id = NULL, " +
  "review_requested_at = NULL, updated_at = unixepoch() " +
  `WHERE id = ${quote(listingId)} AND review_org_id = ${quote(orgId)};`;

export interface ClaimRow {
  id: string;
  name: string;
  email: string | null;
  website: string | null;
  owner_org_id: string | null;
  review_org_id: string | null;
  review_profile_id: string | null;
  org_owns: string | null;
}

/** Why a claim cannot be confirmed or rejected now, or null when it can. */
export function refusal(command: "confirm" | "reject", row: ClaimRow | undefined): string | null {
  if (!row) return "no listing has that id";
  if (row.review_org_id === null || row.review_profile_id === null) {
    return "the listing has no claim waiting for review";
  }
  if (!ID_PATTERN.test(row.review_org_id) || !ID_PATTERN.test(row.review_profile_id)) {
    return "the pending org or profile id has characters an id never has; fix it by hand";
  }
  if (command === "reject") return null;
  if (row.owner_org_id !== null) return `the listing is already owned by ${row.owner_org_id}`;
  if (row.org_owns !== null) {
    return `org ${row.review_org_id} already owns listing ${row.org_owns}; an org owns at most one`;
  }
  return null;
}

/** One statement's result, as `wrangler d1 execute --json` prints it. */
interface D1Result {
  results?: unknown[];
  meta?: { changes?: number };
}

/** Runs one SQL statement on the tier and returns wrangler's parsed `--json` output. */
export type Runner = (env: Env, sql: string) => Promise<D1Result[]>;

export const wranglerRunner: Runner = async (env, sql) => {
  const proc = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "--config",
      "cire/api/wrangler.toml",
      "d1",
      "execute",
      ...targetArgs(env),
      "--json",
      "--command",
      sql,
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "inherit" },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("wrangler d1 execute failed");
  return JSON.parse(out) as D1Result[];
};

const firstResults = (out: D1Result[]): unknown[] => out[0]?.results ?? [];
const changes = (out: D1Result[]): number => out.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);

/** The whole tool, with the output and the wrangler call passed in. Returns the exit code. */
export async function run(
  argv: readonly string[],
  runner: Runner,
  print: (line: string) => void,
): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    print(args.error);
    return 2;
  }

  if (args.command === "list") {
    const rows = firstResults(await runner(args.env, listSql()));
    if (rows.length === 0) print("No vendor claims are waiting for review.");
    for (const row of rows) print(JSON.stringify(row));
    return 0;
  }

  const listingId = args.listingId!;
  const [row] = firstResults(await runner(args.env, showSql(listingId))) as ClaimRow[];
  const refused = refusal(args.command, row);
  if (refused) {
    print(`${args.command} refused: ${refused}`);
    return 1;
  }
  const claim = row!;
  print(
    `Listing ${claim.id} "${claim.name}" (email ${claim.email ?? "none"}, website ${claim.website ?? "none"})`,
  );
  print(`Claimed by org ${claim.review_org_id}, profile ${claim.review_profile_id}`);

  const sql =
    args.command === "confirm"
      ? confirmSql(claim.id, claim.review_org_id!, claim.review_profile_id!)
      : rejectSql(claim.id, claim.review_org_id!);
  if (!args.apply) {
    print(`Dry run (${args.env}). Would run:\n${sql}\nAdd --apply to run it.`);
    return 0;
  }

  const changed = changes(await runner(args.env, sql));
  if (changed !== 1) {
    print(
      `${args.command} changed ${changed} rows; the claim changed after the check. Run it again.`,
    );
    return 1;
  }
  print(
    args.command === "confirm"
      ? "Confirmed. The listing is live; the daily cron (04:00 UTC) hands the vendor their buffered enquiries."
      : "Rejected. The listing is unowned and can be claimed again.",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await run(Bun.argv.slice(2), wranglerRunner, (line) => console.log(line)));
}
