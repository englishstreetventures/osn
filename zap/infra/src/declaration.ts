import { join } from "node:path";

import {
  origin,
  physicalName,
  refuseProductionTier,
  type ApiWorkerInput,
  type RetainedD1Input,
  type StageHosts,
} from "@shared/infra";

/** A Worker binding described as data; the stack turns each into an Alchemy value. */
export type BindingDescription = { readonly kind: "d1" };

/** zap-api's Worker input apart from the values only the stack holds: resources and secrets. */
export interface ZapApiDeclaration extends Omit<ApiWorkerInput, "bindings" | "secrets"> {
  readonly bindings: Readonly<Record<string, BindingDescription>>;
}

/** zap-api's database, migrated by Alchemy from the flattened chain. */
export interface ZapDbDeclaration extends RetainedD1Input {
  readonly migrations: string;
}

export interface ZapDeclaration {
  readonly zapApi: ZapApiDeclaration;
  readonly zapDb: ZapDbDeclaration;
}

/**
 * Every name, var, binding, domain and setting the zap stack declares at
 * `stage`: zap-api and its database. Pure; every host comes from `hosts`.
 * The production tier is refused until its stack is declared.
 */
export function zapDeclaration(input: {
  readonly stage: string;
  readonly hosts: StageHosts;
  readonly generatedDir: string;
}): ZapDeclaration {
  const { stage, hosts, generatedDir } = input;
  refuseProductionTier(stage);
  const issuer = origin(hosts.osnApi);
  return {
    zapApi: {
      worker: "zap-api",
      name: physicalName(
        { base: "zap-api", dev: "zap-api-dev", production: "zap-api-production" },
        stage,
      ),
      stage,
      main: "../api/src/index.ts",
      bundle: true,
      assets: null,
      // Wrangler's flags plus the module registry Wrangler deploys with; a
      // bundled Worker gets the new registry unless this flag is listed.
      compatibility: {
        date: "2025-03-01",
        flags: ["nodejs_compat", "nodejs_compat_populate_process_env", "legacy_module_registry"],
      },
      domain: hosts.zapApi,
      crons: [],
      workersDev: false,
      // Off until per-pull-request previews (englishstreetventures/osn#1578):
      // each version's preview URL is a public workers.dev host that no
      // Access application covers.
      previewUrls: false,
      // Exactly the names production's Wrangler config sets. OSN_ISSUER_URL
      // must equal osn-api's own issuer byte for byte, or every
      // authenticated request is refused.
      vars: {
        OSN_JWKS_URL: `${issuer}/.well-known/jwks.json`,
        OSN_ISSUER_URL: issuer,
        OSN_API_URL: issuer,
      },
      bindings: { DB: { kind: "d1" } },
      // Invocation logs on, as zap-api's Wrangler config leaves them when unset.
      observability: {
        headSamplingRate: 1,
        redactQueryString: false,
        traces: { enabled: true, headSamplingRate: 1 },
        invocationLogs: true,
        issues: true,
      },
    },
    zapDb: {
      name: physicalName({ base: "zap-db", dev: "zap-db-dev", production: "zap-db-prod" }, stage),
      stage,
      readReplication: "disabled",
      jurisdiction: "default",
      locationHint: "oc",
      migrations: join(generatedDir, "migrations", "zap-db"),
      importFiles: [],
    },
  };
}
