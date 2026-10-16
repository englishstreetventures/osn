#!/usr/bin/env bun
/**
 * Record each dev Worker's newest deployment before a stack deploy, and name
 * the deployment the deploy made after it.
 *
 * Alchemy reports no version id for a normal deploy, and uploads nothing for a
 * Worker it finds unchanged. So each stack job in .github/workflows/deploy.yml
 * snapshots its Workers' newest deployments before the deploy and compares
 * after; each smoke step takes the answer as SMOKE_DEPLOYMENT, and
 * scripts/smoke-check.ts rolls back only that deployment, and never a Worker
 * the deploy left unchanged.
 *
 *   bun run scripts/worker-deployments.ts snapshot <file> <surface>...
 *     Writes {"<surface>": "<newest deployment id>" | null} to <file>; null for
 *     a Worker that does not exist yet or has no deployment. Writes
 *     `force=true` to $GITHUB_OUTPUT when any listed Worker's newest
 *     deployment is a smoke check's rollback, naming each such Worker, and
 *     `force=false` otherwise. Alchemy plans against its own state, which
 *     still names the version a rollback replaced, so it would leave that
 *     Worker as it is; with `force=true` the stack job deploys with --force,
 *     re-uploading what the commit declares.
 *   bun run scripts/worker-deployments.ts compare <file> <surface>...
 *     Writes `<surface>_deployment=<value>` to $GITHUB_OUTPUT for every
 *     surface: the newest deployment's id, `unchanged` when that is the one
 *     <file> recorded, or `unknown` when the Worker cannot be read or has no
 *     deployment after the deploy. Every line is written before it exits 1
 *     for an `unknown`.
 *
 * Environment:
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
 *                       the dev account's credentials, sent only to
 *                       api.cloudflare.com to list each Worker's deployments.
 *                       No message carries either.
 *   GITHUB_OUTPUT       receives the output lines (stdout when unset).
 *
 * Exit codes: 0 done; 1 the Cloudflare API failed (snapshot then writes
 * nothing); 2 a usage error, before any request.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { isSurfaceKey, SURFACES } from "./deploy-surfaces";
import {
  annotation,
  type Cloudflare,
  cloudflareCredentials,
  type Deployment,
  DEPLOYMENT_ID,
  devTarget,
  isSmokeRollback,
  readDeployments,
} from "./smoke-check";

/** Cloudflare's answer for a Worker that does not exist on the account. */
const NO_SUCH_WORKER = 10_007;

/**
 * `text` with the token's value and every run of 32 hex digits (an account id)
 * replaced, so a Cloudflare answer that echoes either never reaches the log.
 */
export function redact(text: string, token: string): string {
  const withoutToken = token.length >= 8 ? text.replaceAll(token, "<token>") : text;
  return withoutToken.replaceAll(/[0-9a-f]{32}/gi, "<account>");
}

type Newest =
  | { readonly kind: "found"; readonly deployment: Deployment }
  /** The Worker does not exist, or has no deployment. */
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly reason: string };

async function newestOf(api: Cloudflare, worker: string): Promise<Newest> {
  const answer = await readDeployments(api, worker);
  if (!answer.ok) {
    return answer.codes.includes(NO_SUCH_WORKER)
      ? { kind: "none" }
      : { kind: "failed", reason: answer.reason };
  }
  const [newest] = answer.result;
  if (newest === undefined) return { kind: "none" };
  if (typeof newest.id !== "string" || !DEPLOYMENT_ID.test(newest.id)) {
    return { kind: "failed", reason: "Cloudflare answered with a deployment id of the wrong form" };
  }
  return { kind: "found", deployment: newest };
}

/** The snapshot `snapshot` wrote, or undefined when the file is not one. */
function readSnapshot(file: string): ReadonlyMap<string, string | null> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as object | null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string | null] =>
          entry[1] === null || (typeof entry[1] === "string" && DEPLOYMENT_ID.test(entry[1])),
      ),
    );
  } catch {
    return undefined;
  }
}

export interface WorkerDeploymentsInput {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly out: (text: string) => void;
}

export async function runWorkerDeployments(input: WorkerDeploymentsInput): Promise<number> {
  const { env } = input;
  const token = env.CLOUDFLARE_API_TOKEN ?? "";
  const out = (text: string) => input.out(redact(text, token));
  const error = (message: string) => out(annotation("error", `worker-deployments: ${message}`));
  const usage = (message: string): number => {
    error(message);
    return 2;
  };

  const [command = "", file = "", ...names] = input.args;
  if ((command !== "snapshot" && command !== "compare") || file === "" || names.length === 0) {
    return usage("usage: worker-deployments.ts snapshot|compare <file> <surface>...");
  }
  const notDev = names.filter((name) => !isSurfaceKey(name) || devTarget(name) === undefined);
  if (notDev.length > 0) {
    const known = SURFACES.filter((s) => devTarget(s.key) !== undefined).map((s) => s.key);
    return usage(`'${notDev.join("', '")}' is not a dev surface; use any of ${known.join(", ")}`);
  }
  const surfaces = [...new Set(names)].flatMap((name) => {
    if (!isSurfaceKey(name)) return [];
    const target = devTarget(name);
    return target === undefined ? [] : [{ key: name, worker: target.worker }];
  });
  const api = cloudflareCredentials(env, input.fetch);
  if (typeof api === "string") return usage(api);

  const snapshot = command === "compare" ? readSnapshot(file) : undefined;
  if (command === "compare") {
    const missing = surfaces.filter((s) => snapshot?.has(s.key) !== true).map((s) => s.key);
    if (missing.length > 0) {
      return usage(`${file} holds no snapshot of ${missing.join(", ")}; run snapshot first`);
    }
  }

  const write = (lines: string) => {
    const output = env.GITHUB_OUTPUT;
    if (output !== undefined && output !== "") appendFileSync(output, lines);
    else out(lines);
  };
  const results = await Promise.all(
    surfaces.map(async (s) => ({
      key: s.key,
      worker: s.worker,
      newest: await newestOf(api, s.worker),
    })),
  );

  if (command === "snapshot") {
    const failures = results.flatMap((r) =>
      r.newest.kind === "failed"
        ? [`reading the deployments of ${r.worker}: ${r.newest.reason}`]
        : [],
    );
    for (const failure of failures) error(failure);
    if (failures.length > 0) return 1;
    const ids = results.map((r) => ({
      key: r.key,
      worker: r.worker,
      id: r.newest.kind === "found" ? r.newest.deployment.id : null,
      rolledBack: r.newest.kind === "found" && isSmokeRollback(r.newest.deployment),
    }));
    writeFileSync(file, `${JSON.stringify(Object.fromEntries(ids.map((r) => [r.key, r.id])))}\n`);
    for (const r of ids) {
      out(`${r.key} (${r.worker}): ${r.id ?? "no deployment"}\n`);
      if (r.rolledBack) {
        out(
          `${r.worker} still serves a smoke check's rollback; this run deploys with --force to re-upload what the commit declares.\n`,
        );
      }
    }
    write(`force=${ids.some((r) => r.rolledBack)}\n`);
    return 0;
  }

  const lines = results.map((r) => {
    if (r.newest.kind === "found") {
      const id = r.newest.deployment.id;
      return { key: r.key, value: id === snapshot?.get(r.key) ? "unchanged" : id };
    }
    error(
      r.newest.kind === "none"
        ? `${r.worker} has no deployment after the deploy`
        : `reading the deployments of ${r.worker}: ${r.newest.reason}`,
    );
    return { key: r.key, value: "unknown" };
  });
  write(lines.map((l) => `${l.key}_deployment=${l.value}\n`).join(""));
  return lines.some((l) => l.value === "unknown") ? 1 : 0;
}

if (import.meta.main) {
  const code = await runWorkerDeployments({
    args: process.argv.slice(2),
    env: process.env,
    fetch,
    out: (text) => process.stdout.write(text),
  });
  process.exit(code);
}
