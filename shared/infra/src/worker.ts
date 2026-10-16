import type * as Cloudflare from "alchemy/Cloudflare";
import { Data, type Redacted } from "effect";

import { tierOf } from "./stage";

export interface ApiWorkerObservability {
  readonly headSamplingRate: number;
  readonly redactQueryString: boolean;
  readonly traces: { readonly enabled: boolean; readonly headSamplingRate?: number };
  /** Off unless set: cire-api and cire-invites carry wedding slugs and names in request paths. */
  readonly invocationLogs?: boolean;
}

/** Every setting where Alchemy's default differs from today's Wrangler config is required. */
export interface ApiWorkerInput {
  /** The deployed script name; adoption keys on it. */
  readonly name: string;
  readonly stage: string;
  /** The entry module, relative to the stack's working directory. */
  readonly main: string;
  readonly compatibility: { readonly date: string; readonly flags: readonly string[] };
  /** The custom-domain hostname, or null to hold none. */
  readonly domain: string | null;
  readonly crons: readonly string[];
  /** Serve the stable workers.dev URL. Version preview URLs follow the tier instead. */
  readonly workersDev: boolean;
  readonly vars: Readonly<Record<string, string>>;
  readonly bindings: Cloudflare.WorkerBindingProps;
  readonly secrets: Readonly<Record<string, Redacted.Redacted<string>>>;
  readonly observability: ApiWorkerObservability;
}

export interface SiteWorkerInput {
  readonly name: string;
  readonly stage: string;
  /** The built site; Alchemy applies its `_headers` and `_redirects`. */
  readonly directory: string;
  readonly domain: string | null;
  readonly workersDev: boolean;
  readonly htmlHandling:
    | "auto-trailing-slash"
    | "force-trailing-slash"
    | "drop-trailing-slash"
    | "none";
  readonly notFoundHandling: "none" | "404-page" | "single-page-application";
}

export class BindingNameClashError extends Data.TaggedError("BindingNameClashError")<{
  readonly names: readonly string[];
  readonly message: string;
}> {}

export class ProductionObservabilityError extends Data.TaggedError("ProductionObservabilityError")<{
  readonly worker: string;
  readonly message: string;
}> {}

/** Alchemy binds `ALCHEMY_*` plain-text values first and skips any later env key with the same name. */
const ALCHEMY_RESERVED_PREFIX = "ALCHEMY_";

/** Names that appear in more than one group, or that Alchemy reserves. */
function clashingNames(groups: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const clashes = new Set<string>();
  for (const names of groups) {
    for (const name of names) {
      if (seen.has(name) || name.startsWith(ALCHEMY_RESERVED_PREFIX)) clashes.add(name);
      seen.add(name);
    }
  }
  return [...clashes].toSorted();
}

const previewsEnabled = (stage: string): boolean => tierOf(stage) !== "production";

/**
 * Production request paths carry ids and slugs, so production keeps query
 * strings redacted and native traces off — the rule
 * `scripts/check-trace-redaction.ts` holds today's API Workers to.
 */
function checkProductionObservability(input: ApiWorkerInput): void {
  if (tierOf(input.stage) !== "production") return;
  const problems = [
    input.observability.redactQueryString ? "" : "redactQueryString must be true",
    input.observability.traces.enabled ? "native traces must be off" : "",
  ].filter((problem) => problem !== "");
  if (problems.length > 0) {
    throw new ProductionObservabilityError({
      worker: input.name,
      message: `${input.name} on production: ${problems.join("; ")}.`,
    });
  }
}

export function apiWorkerProps(input: ApiWorkerInput): Cloudflare.WorkerProps {
  const clashes = clashingNames([
    Object.keys(input.vars),
    Object.keys(input.bindings),
    Object.keys(input.secrets),
  ]);
  if (clashes.length > 0) {
    throw new BindingNameClashError({
      names: clashes,
      message: `Binding names used twice or reserved by Alchemy: ${clashes.join(", ")}.`,
    });
  }
  checkProductionObservability(input);
  const { observability } = input;
  return {
    name: input.name,
    main: input.main,
    compatibility: { date: input.compatibility.date, flags: [...input.compatibility.flags] },
    domain: input.domain,
    crons: [...input.crons],
    workersDev: { enabled: input.workersDev, previewsEnabled: previewsEnabled(input.stage) },
    observability: {
      enabled: true,
      headSamplingRate: observability.headSamplingRate,
      redactQueryString: observability.redactQueryString,
      logs: { enabled: true, invocationLogs: observability.invocationLogs ?? false },
      traces:
        observability.traces.headSamplingRate === undefined
          ? { enabled: observability.traces.enabled }
          : {
              enabled: observability.traces.enabled,
              headSamplingRate: observability.traces.headSamplingRate,
            },
    },
    env: { ...input.vars, ...input.bindings, ...input.secrets },
  };
}

export function siteWorkerProps(input: SiteWorkerInput): Cloudflare.WorkerProps {
  return {
    name: input.name,
    assets: {
      directory: input.directory,
      htmlHandling: input.htmlHandling,
      notFoundHandling: input.notFoundHandling,
    },
    domain: input.domain,
    workersDev: { enabled: input.workersDev, previewsEnabled: previewsEnabled(input.stage) },
    // A site's URLs can carry parameters a user should not see logged (the
    // OIDC authorize screen's), and serving static files needs no traces.
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: false },
    },
  };
}
