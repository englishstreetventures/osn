#!/usr/bin/env bun
/**
 * A flip release's check, in its `stack-<stack>-verify` job, of the flip
 * host's DNS records, before the detach.
 *
 *   bun run scripts/flip-record-check.ts
 *
 * The flip's detach (scripts/pages-domain.ts) keeps the host's CNAME to its
 * Pages project, and the deploy's Worker custom-domain attach replaces that
 * CNAME in one request (the provider patch's `Workers/ReplaceCname`, given
 * OSN_WORKER_DOMAIN_REPLACE_CNAME). This reads the host's records with the
 * deploy's own token, as the deploy will, and refuses what the deploy would
 * refuse (`replaceRefusal`): the CNAME to the target must be the one record
 * that routes the host, and a zone's apex must hold no record beside it. A
 * refusal fails the verify job, so the release stops before anything moves.
 * On a pass it writes to the job summary what the deploy will replace, for
 * the approver of the detach.
 *
 * The zone is looked up by name (`GET /zones?name=<zone>`) and must be in
 * the account CLOUDFLARE_ACCOUNT_ID names. The deploy token reaches more
 * than pages-domain.ts's reach check allows, and the job's token step has
 * already checked it reaches only the production account.
 *
 * Environment:
 *   REPLACE_CNAME          the hosts step's `replace_cname`:
 *                          `<host>=<project>.pages.dev`, which must be the
 *                          value a flip of some site deploys with
 *                          (`flipReplaceCname`).
 *   CLOUDFLARE_ACCOUNT_ID  the production account.
 *   CLOUDFLARE_API_TOKEN   the production deploy token. Sent only to
 *                          api.cloudflare.com. No message carries it or the
 *                          account id.
 *   GITHUB_STEP_SUMMARY    where the summary goes; stdout when unset.
 *
 * Imports nothing outside this repository's import-free files.
 *
 * Exit codes: 0 the deploy can replace the CNAME; 1 refused, or the API
 * failed; 2 a usage error, before any request.
 */

import { appendFileSync } from "node:fs";

import {
  flipReplaceCname,
  PAGES_PROJECTS,
  SITE_SURFACES,
  zoneOf,
} from "../shared/infra/src/production-sites";
import { ApiError, pagesDnsApi, replaceRefusal } from "./pages-domain";

export interface FlipRecordCheckInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly out: (text: string) => void;
  /** How a read waits before trying again; a real wait unless a test passes its own. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Appends to the job summary; appendFileSync unless a test passes its own. */
  readonly writeSummary?: (path: string, text: string) => void;
}

/** Every value a flip deploys with, one per site with a Pages project. */
const FLIP_VALUES: readonly string[] = SITE_SURFACES.filter(
  (site) => PAGES_PROJECTS[site] !== undefined,
).map(flipReplaceCname);

export async function runFlipRecordCheck(input: FlipRecordCheckInput): Promise<number> {
  const { env, out } = input;
  const error = (message: string) => out(`::error::flip-record-check: ${message}\n`);
  const value = (env.REPLACE_CNAME ?? "").trim();
  if (!FLIP_VALUES.includes(value)) {
    error(
      value === ""
        ? "REPLACE_CNAME is empty: a flip release's hosts step names the CNAME its deploy replaces."
        : `REPLACE_CNAME is '${value}', which no site's flip deploys with; it must be one of ${FLIP_VALUES.join(", ")}.`,
    );
    return 2;
  }
  const account = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = (env.CLOUDFLARE_API_TOKEN ?? "").trim();
  if (account === "" || token === "") {
    error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
    return 2;
  }
  const [host = "", target = ""] = value.split("=");
  const zoneName = zoneOf(host);
  const api = pagesDnsApi({
    account,
    token,
    fetch: input.fetch,
    sleep: input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });
  try {
    const listed = await api.call(
      "GET",
      `/zones?name=${encodeURIComponent(zoneName)}`,
      `finding the ${zoneName} zone`,
    );
    const zones = Array.isArray(listed.result)
      ? (listed.result as { id?: unknown; name?: unknown; account?: { id?: unknown } }[])
      : [];
    const zone = zones.find(
      (candidate) =>
        candidate.name === zoneName &&
        candidate.account?.id === account &&
        typeof candidate.id === "string",
    );
    if (zone === undefined) {
      error(
        `the deploy token finds no ${zoneName} zone in the account CLOUDFLARE_ACCOUNT_ID names, which ${host} is in.`,
      );
      return 1;
    }
    const records = await api.records(String(zone.id), host);
    const refusal = replaceRefusal(host, records, target);
    if (refusal !== null) {
      error(`${refusal}. The release stops here, before the detach; nothing moved.`);
      return 1;
    }
    out(
      `${host} holds its CNAME to ${target} as the one record that routes it; the deploy can replace it.\n`,
    );
    const summary = `### Flip record check\n\nThe deploy will replace ${host}'s CNAME to ${target} with the Worker's custom domain.\n`;
    const summaryFile = env.GITHUB_STEP_SUMMARY ?? "";
    if (summaryFile === "") out(summary);
    else (input.writeSummary ?? appendFileSync)(summaryFile, summary);
    return 0;
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.message);
      return 1;
    }
    throw failure;
  }
}

if (import.meta.main) {
  const code = await runFlipRecordCheck({
    env: process.env,
    fetch,
    out: (text) => process.stdout.write(text),
  });
  process.exit(code);
}
