import type * as Cloudflare from "alchemy/Cloudflare";
import { Data, type Redacted } from "effect";

import { SECRET_INVENTORY, tierSecrets, type WorkerKey } from "./secrets/inventory";
import { tierOf, type Tier } from "./stage";

export interface ApiWorkerObservability {
  readonly headSamplingRate: number;
  readonly redactQueryString: boolean;
  readonly traces: { readonly enabled: boolean; readonly headSamplingRate?: number };
  /** Off unless set: cire-api and cire-invites carry wedding slugs and names in request paths. */
  readonly invocationLogs?: boolean;
  /** Workers Issues error detection. Alchemy turns it off on the next full deploy when omitted. */
  readonly issues: boolean;
}

/** Every setting where Alchemy's default differs from today's Wrangler config is required. */
export interface ApiWorkerInput {
  /** The Worker's entry in the secret inventory, which `secrets` must match for the stage's tier. */
  readonly worker: WorkerKey;
  /** The deployed script name; adoption keys on it. */
  readonly name: string;
  readonly stage: string;
  /** The entry module, relative to the stack's working directory. */
  readonly main: string;
  readonly compatibility: { readonly date: string; readonly flags: readonly string[] };
  /** The custom-domain hostname, or null to hold none. */
  readonly domain: string | null;
  readonly crons: readonly string[];
  /** Serve the stable workers.dev URL. */
  readonly workersDev: boolean;
  /** Serve each version at its own workers.dev preview URL; refused on production. */
  readonly previewUrls: boolean;
  /** Plain-text values. Never a name the secret inventory lists for this Worker. */
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
  /** Serve each version at its own workers.dev preview URL; refused on production. */
  readonly previewUrls: boolean;
  readonly htmlHandling:
    | "auto-trailing-slash"
    | "force-trailing-slash"
    | "drop-trailing-slash"
    | "none";
  readonly notFoundHandling: "none" | "404-page" | "single-page-application";
  /** Workers Issues error detection. Alchemy turns it off on the next full deploy when omitted. */
  readonly issues: boolean;
}

export class BindingNameClashError extends Data.TaggedError("BindingNameClashError")<{
  readonly names: readonly string[];
  readonly message: string;
}> {}

export class ProductionObservabilityError extends Data.TaggedError("ProductionObservabilityError")<{
  readonly worker: string;
  readonly message: string;
}> {}

export class ProductionPreviewUrlsError extends Data.TaggedError("ProductionPreviewUrlsError")<{
  readonly worker: string;
  readonly message: string;
}> {}

export class SecretAsPlainBindingError extends Data.TaggedError("SecretAsPlainBindingError")<{
  readonly worker: WorkerKey;
  /** The vars or bindings keys the inventory lists for the Worker. Never values. */
  readonly names: readonly string[];
  readonly message: string;
}> {}

export class UndeclaredSecretsError extends Data.TaggedError("UndeclaredSecretsError")<{
  readonly worker: WorkerKey;
  readonly tier: Tier;
  /** Names the inventory requires of the Worker on this tier that `secrets` leaves out. Never values. */
  readonly missing: readonly string[];
  /** Names in `secrets` the inventory neither requires nor allows on this tier. Never values. */
  readonly unexpected: readonly string[];
  readonly message: string;
}> {}

/**
 * An upload keeps only the secrets it declares and deletes every other secret
 * the Worker holds, so `secrets` holds every name the inventory requires of
 * the Worker on the stage's tier, and no name the inventory does not declare.
 */
function checkDeclaredSecrets(input: ApiWorkerInput): void {
  const tier = tierOf(input.stage);
  const row = tierSecrets(input.worker, tier);
  const passed = new Set(Object.keys(input.secrets));
  const declared = new Set([...row.secrets, ...row.optional]);
  const missing = row.secrets.filter((name) => !passed.has(name));
  const unexpected = [...passed].filter((name) => !declared.has(name)).toSorted();
  if (missing.length === 0 && unexpected.length === 0) return;
  const parts = [
    missing.length > 0 ? `required by the inventory but not passed: ${missing.join(", ")}` : "",
    unexpected.length > 0 ? `not in the inventory: ${unexpected.join(", ")}` : "",
  ].filter((part) => part !== "");
  throw new UndeclaredSecretsError({
    worker: input.worker,
    tier,
    missing,
    unexpected,
    message: `${input.name} (${input.worker}, ${tier} tier) secrets ${parts.join("; ")}. Pass requireSecrets() for this Worker and stage.`,
  });
}

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

/**
 * Each version's preview URL is a public `workers.dev` host outside any
 * Access gate, so the stack turns it on by name, and production never does.
 */
function previewsEnabled(name: string, stage: string, previewUrls: boolean): boolean {
  if (previewUrls && tierOf(stage) === "production") {
    throw new ProductionPreviewUrlsError({
      worker: name,
      message: `${name} on production: version preview URLs must be off.`,
    });
  }
  return previewUrls;
}

/**
 * A var reaches the Worker as plain text that `wrangler secret list` never
 * shows, and a binding is no secret either, so neither may take a name the
 * inventory lists for the Worker on any tier: required, optional or
 * forbidden.
 */
function checkPlainBindings(input: ApiWorkerInput): void {
  const entry = SECRET_INVENTORY.find((candidate) => candidate.worker === input.worker);
  const listed = new Set<string>();
  for (const tier of ["dev", "production"] as const) {
    const row = entry?.tiers[tier];
    for (const name of [row?.secrets, row?.optional, row?.forbidden].flat()) {
      if (name !== undefined) listed.add(name);
    }
  }
  const names = [...Object.keys(input.vars), ...Object.keys(input.bindings)]
    .filter((name) => listed.has(name))
    .toSorted();
  if (names.length > 0) {
    throw new SecretAsPlainBindingError({
      worker: input.worker,
      names,
      message: `${input.name} (${input.worker}) vars or bindings take names the secret inventory lists: ${names.join(", ")}. Pass a secret through secrets, and never a forbidden name.`,
    });
  }
}

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
  checkDeclaredSecrets(input);
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
  checkPlainBindings(input);
  checkProductionObservability(input);
  const { observability } = input;
  return {
    name: input.name,
    main: input.main,
    compatibility: { date: input.compatibility.date, flags: [...input.compatibility.flags] },
    domain: input.domain,
    crons: [...input.crons],
    workersDev: {
      enabled: input.workersDev,
      previewsEnabled: previewsEnabled(input.name, input.stage, input.previewUrls),
    },
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
      issues: { enabled: observability.issues },
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
    workersDev: {
      enabled: input.workersDev,
      previewsEnabled: previewsEnabled(input.name, input.stage, input.previewUrls),
    },
    // A site's URLs can carry parameters a user should not see logged (the
    // OIDC authorize screen's), and serving static files needs no traces.
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: false },
      issues: { enabled: input.issues },
    },
  };
}
