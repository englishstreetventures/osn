import { join } from "node:path";

import {
  adoptedWorkerOf,
  declaredDomains,
  origin,
  physicalName,
  PRODUCTION_STAGE_HOSTS,
  refuseProductionTier,
  type AdoptedResources,
  type ApiSurface,
  type ApiWorkerInput,
  type DeclaredDomains,
  type ResourceKinds,
  type RetainedD1Input,
  type StageHosts,
} from "@shared/infra";

/** A Worker binding described as data; the stack turns each into an Alchemy value. */
export type BindingDescription = { readonly kind: "d1" };

/** zap-api's Worker input apart from the values only the stack holds: resources and secrets. */
interface ZapApiDeclaration extends Omit<ApiWorkerInput, "bindings" | "secrets"> {
  readonly bindings: Readonly<Record<string, BindingDescription>>;
}

/** zap-api's database, migrated by Alchemy from the flattened chain. */
interface ZapDbDeclaration extends RetainedD1Input {
  readonly migrations: string;
}

interface ZapDeclaration {
  readonly zapApi: ZapApiDeclaration;
  readonly zapDb: ZapDbDeclaration;
}

/**
 * Every name, var, binding, domain and setting the zap stack declares at
 * `stage`: zap-api and its database. Pure; every host comes from `hosts`.
 * The production tier is refused: `zapProductionApis` declares it.
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
      // Production's Wrangler names, plus OSN_ENV, which marks a deployed
      // tier so zap-api runs its fail-closed checks on the JWKS URL, the
      // issuer and the CORS list, and ZAP_CORS_ORIGIN, the one browser origin
      // on dev that calls it. OSN_ISSUER_URL must equal osn-api's own issuer
      // byte for byte, or every authenticated request is refused.
      vars: {
        OSN_ENV: "dev",
        ZAP_CORS_ORIGIN: origin(hosts.musubiSocial),
        OSN_JWKS_URL: `${issuer}/.well-known/jwks.json`,
        OSN_ISSUER_URL: issuer,
        OSN_API_URL: issuer,
      },
      bindings: { DB: { kind: "d1" } },
      // Invocation logs on, as zap-api's Wrangler config leaves them when unset.
      observability: {
        logs: true,
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

/** zap-api's logical id, the dev one, which keys its state row on every stage. */
export const API_LOGICAL_IDS = { zap_api: "ZapApi" } as const satisfies Readonly<
  Partial<Record<ApiSurface, string>>
>;

/** Every resource the zap stack declares on production, by logical id, with its kind for the plan guard. */
export const PRODUCTION_RESOURCE_KINDS: ResourceKinds = {
  ZapApi: "api-worker",
  ZapDb: "d1",
};

/** zap-api and its database on production. */
interface ZapProductionApis {
  readonly zapApi: ZapApiDeclaration;
  readonly zapDb: RetainedD1Input;
}

/**
 * What the zap stack declares on production: zap-api and its database, each
 * under today's name and adopted in place. Every var, binding, domain and
 * setting is `[env.production]`'s in `zap/api/wrangler.toml`
 * (tests/parity.test.ts holds them equal), plus `legacy_module_registry` for
 * the bundled Worker. Its Wrangler config sets no `observability.enabled`,
 * so Workers Logs stay off, as Wrangler uploads it. No secret: production's
 * stay on the Worker. The database names no migrations: Wrangler migrates it,
 * in the stack job, before the deploy. Pure; every host comes from `hosts`.
 */
export function zapProductionApis(input: { readonly hosts: StageHosts }): ZapProductionApis {
  const issuer = origin(input.hosts.osnApi);
  return {
    zapApi: {
      worker: "zap-api",
      name: "zap-api-production",
      stage: "production",
      main: "../api/src/index.ts",
      bundle: true,
      assets: null,
      compatibility: {
        date: "2025-03-01",
        flags: ["nodejs_compat", "nodejs_compat_populate_process_env", "legacy_module_registry"],
      },
      domain: input.hosts.zapApi,
      crons: [],
      workersDev: false,
      previewUrls: false,
      vars: {
        OSN_JWKS_URL: `${issuer}/.well-known/jwks.json`,
        OSN_ISSUER_URL: issuer,
        OSN_API_URL: issuer,
      },
      bindings: { DB: { kind: "d1" } },
      observability: {
        logs: false,
        headSamplingRate: 1,
        redactQueryString: true,
        traces: { enabled: false },
        invocationLogs: false,
        issues: false,
      },
    },
    zapDb: {
      name: "zap-db-prod",
      stage: "production",
      readReplication: "disabled",
      jurisdiction: "default",
      locationHint: null,
      migrations: null,
      importFiles: [],
    },
  };
}

/** The zap stack's adopted resources on production, by logical id, as the live read and the plan guard compare them. */
export const PRODUCTION_ADOPTED: AdoptedResources = (() => {
  const apis = zapProductionApis({ hosts: PRODUCTION_STAGE_HOSTS });
  return {
    workers: { [API_LOGICAL_IDS.zap_api]: adoptedWorkerOf(apis.zapApi) },
    databases: {
      ZapDb: { name: apis.zapDb.name, readReplication: apis.zapDb.readReplication },
    },
    buckets: {},
  };
})();

/** The host zap-api is declared with on production, which the plan guard reads. */
export const PRODUCTION_DOMAINS: DeclaredDomains = declaredDomains(API_LOGICAL_IDS, {
  [API_LOGICAL_IDS.zap_api]: zapProductionApis({ hosts: PRODUCTION_STAGE_HOSTS }).zapApi,
});
