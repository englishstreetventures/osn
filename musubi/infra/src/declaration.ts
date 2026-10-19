import { join } from "node:path";

import {
  origin,
  physicalName,
  refuseProductionTier,
  type ApiWorkerInput,
  type PrebuiltSite,
  type RetainedD1Input,
  type SiteWorkerInput,
  type StageHosts,
} from "@shared/infra";

/** A Worker binding described as data; the stack turns each into an Alchemy value. */
export type BindingDescription =
  | { readonly kind: "d1" }
  | {
      readonly kind: "ratelimit";
      readonly namespaceId: number;
      readonly limit: number;
      readonly period: 10 | 60;
    };

/** osn-api's Worker input apart from the values only the stack holds: resources and secrets. */
export interface OsnApiDeclaration extends Omit<ApiWorkerInput, "bindings" | "secrets"> {
  readonly bindings: Readonly<Record<string, BindingDescription>>;
}

/** osn-api's database, migrated by Alchemy from the flattened chain. */
export interface OsnDbDeclaration extends RetainedD1Input {
  readonly migrations: string;
}

export interface MusubiDeclaration {
  readonly osnApi: OsnApiDeclaration;
  readonly osnDb: OsnDbDeclaration;
  readonly musubiSocial: SiteWorkerInput;
  readonly musubiLanding: SiteWorkerInput;
  /** Where the stack writes each generated seed file. */
  readonly seeds: { readonly osn: string };
  /** Each site directory the stack uploads as built, and the origins its build for `stage` holds. */
  readonly prebuilt: readonly PrebuiltSite[];
}

const SOCIAL_DIST = "../social/dist";
const LANDING_DIST = "../landing/dist";

/**
 * osn-api's per-IP auth limiters, one per request budget, each over 60
 * seconds. A namespace id is an account-scoped counter, so dev's ids
 * (2101-2105) are never production's (2001-2005, `osn/api/wrangler.toml`).
 */
const RATE_LIMITS: readonly {
  readonly name: string;
  readonly namespaceId: number;
  readonly limit: number;
}[] = [
  { name: "RL_AUTH_IP_5_60", namespaceId: 2101, limit: 5 },
  { name: "RL_AUTH_IP_10_60", namespaceId: 2102, limit: 10 },
  { name: "RL_AUTH_IP_20_60", namespaceId: 2103, limit: 20 },
  { name: "RL_AUTH_IP_30_60", namespaceId: 2104, limit: 30 },
  { name: "RL_AUTH_IP_60_60", namespaceId: 2105, limit: 60 },
];

/**
 * Every name, var, binding, domain and setting the musubi stack declares at
 * `stage`: osn-api and its database, musubi social and musubi landing. Pure;
 * every host comes from `hosts`. The production tier is refused until its
 * stack is declared.
 */
export function musubiDeclaration(input: {
  readonly stage: string;
  readonly hosts: StageHosts;
  readonly generatedDir: string;
}): MusubiDeclaration {
  const { stage, hosts, generatedDir } = input;
  refuseProductionTier(stage);
  const app = origin(hosts.musubiSocial);
  const osnSeed = join(generatedDir, "seeds", "osn-seed.sql");
  return {
    osnApi: {
      worker: "osn-api",
      name: physicalName(
        { base: "osn-api", dev: "osn-api-dev", production: "osn-api-production" },
        stage,
      ),
      stage,
      main: "../../osn/api/src/index.ts",
      bundle: true,
      assets: null,
      // Wrangler's flags plus the module registry Wrangler deploys with; a
      // bundled Worker gets the new registry unless this flag is listed.
      compatibility: {
        date: "2025-03-01",
        flags: ["nodejs_compat", "nodejs_compat_populate_process_env", "legacy_module_registry"],
      },
      domain: hosts.osnApi,
      crons: ["0 */6 * * *"],
      workersDev: false,
      // Off until per-pull-request previews (englishstreetventures/osn#1578):
      // each version's preview URL is a public workers.dev host that no
      // Access application covers.
      previewUrls: false,
      vars: {
        OSN_ENV: "dev",
        // The app's host: a WebAuthn ceremony runs only on an origin same-site with it.
        OSN_RP_ID: hosts.musubiSocial,
        OSN_RP_NAME: `OSN (${stage})`,
        OSN_ORIGIN: app,
        OSN_ISSUER_URL: origin(hosts.osnApi),
        // Also the CSRF origin guard's list: only the app fetches osn-api from a browser.
        OSN_CORS_ORIGIN: app,
        DEV_LOGIN_RETURN_ORIGINS: [
          hosts.musubiSocial,
          hosts.cireHost,
          hosts.cireVendor,
          hosts.cireInvites,
        ]
          .map(origin)
          .join(","),
        OSN_AUTHORIZE_UI_URL: `${app}/authorize`,
        // The session marker cookie's domain: the app's host, never a parent shared with production.
        OSN_COOKIE_DOMAIN: hosts.musubiSocial,
        OSN_EMAIL_FROM: "dev@cireweddings.com", // not a host: the sender on Resend's verified domain
      },
      bindings: {
        DB: { kind: "d1" },
        ...Object.fromEntries(
          RATE_LIMITS.map((limit): [string, BindingDescription] => [
            limit.name,
            { kind: "ratelimit", namespaceId: limit.namespaceId, limit: limit.limit, period: 60 },
          ]),
        ),
      },
      // Invocation logs on, as osn-api's Wrangler config leaves them when
      // unset. Query strings are redacted: dev sign-in takes its secret in one.
      observability: {
        headSamplingRate: 1,
        redactQueryString: true,
        traces: { enabled: true, headSamplingRate: 1 },
        invocationLogs: true,
        issues: true,
      },
    },
    osnDb: {
      name: physicalName({ base: "osn-db", dev: "osn-db-dev", production: "osn-db-prod" }, stage),
      stage,
      readReplication: "disabled",
      jurisdiction: "default",
      locationHint: "oc",
      migrations: join(generatedDir, "migrations", "osn-db"),
      importFiles: [osnSeed],
    },
    musubiSocial: {
      name: physicalName(
        { base: "osn-social", dev: "osn-social-dev", production: "osn-social" },
        stage,
      ),
      stage,
      directory: SOCIAL_DIST,
      // The built `_redirects` sends every path to index.html for Pages; on a
      // Worker the single-page fallback below serves deep links instead.
      redirectsFile: false,
      entry: null,
      domain: hosts.musubiSocial,
      workersDev: false,
      // Off until per-pull-request previews (englishstreetventures/osn#1578):
      // each version's preview URL is a public workers.dev host that no
      // Access application covers.
      previewUrls: false,
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "single-page-application",
      issues: true,
    },
    musubiLanding: {
      name: physicalName(
        { base: "musubi-landing", dev: "musubi-landing-dev", production: "musubi-landing" },
        stage,
      ),
      stage,
      directory: LANDING_DIST,
      // A built `_redirects` would apply; the site ships none.
      redirectsFile: true,
      entry: null,
      domain: hosts.musubiLanding,
      workersDev: false,
      // Off until per-pull-request previews (englishstreetventures/osn#1578):
      // each version's preview URL is a public workers.dev host that no
      // Access application covers.
      previewUrls: false,
      htmlHandling: "auto-trailing-slash",
      // musubi/landing builds no 404.html (its pages are index, privacy and
      // terms), so an unknown path is a plain 404.
      notFoundHandling: "none",
      issues: true,
    },
    seeds: { osn: osnSeed },
    // Each site's build bakes in what deploy.yml's build step sets: musubi
    // social osn-api's origin (VITE_OSN_ISSUER_URL), musubi landing the app's
    // (PUBLIC_APP_URL) and its own (SITE).
    prebuilt: [
      { site: "@musubi/social", directory: SOCIAL_DIST, origins: [origin(hosts.osnApi)] },
      {
        site: "@musubi/landing",
        directory: LANDING_DIST,
        origins: [app, origin(hosts.musubiLanding)],
      },
    ],
  };
}
