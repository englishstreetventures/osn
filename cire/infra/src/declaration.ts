import { join } from "node:path";

import {
  origin,
  physicalName,
  refuseProductionTier,
  type ApiWorkerInput,
  type ApiWorkerObservability,
  type PrebuiltSite,
  type RetainedBucketInput,
  type RetainedD1Input,
  type SiteWorkerInput,
  type StageHosts,
  type StageNames,
} from "@shared/infra";
import type * as Cloudflare from "alchemy/Cloudflare";

/** A Worker binding described as data; the stack turns each into an Alchemy value. */
export type BindingDescription =
  | { readonly kind: "d1" }
  | { readonly kind: "r2" }
  | { readonly kind: "images" }
  | {
      readonly kind: "ratelimit";
      readonly namespaceId: number;
      readonly limit: number;
      readonly period: 10 | 60;
    };

/** cire-api's Worker input apart from the values only the stack holds: resources and secrets. */
export interface CireApiDeclaration extends Omit<ApiWorkerInput, "bindings" | "secrets"> {
  readonly bindings: Readonly<Record<string, BindingDescription>>;
}

/** cire-invites' Worker input apart from its secrets, which the stack reads. */
export type CireInvitesDeclaration = Omit<ApiWorkerInput, "secrets">;

/** cire's database, migrated by Alchemy from the flattened chain and seeded. */
export interface CireDbDeclaration extends RetainedD1Input {
  readonly migrations: string;
}

export interface CireDeclaration {
  readonly cireApi: CireApiDeclaration;
  readonly cireDb: CireDbDeclaration;
  readonly cireAssets: RetainedBucketInput;
  readonly cireSheets: RetainedBucketInput;
  readonly cireInvites: CireInvitesDeclaration;
  readonly cireHost: SiteWorkerInput;
  readonly cireVendor: SiteWorkerInput;
  readonly cireLanding: SiteWorkerInput;
  /** Where the stack writes each generated seed file. */
  readonly seeds: { readonly ownerSeat: string };
  /** Each site directory the stack uploads as built, and the origins its build for `stage` holds. */
  readonly prebuilt: readonly PrebuiltSite[];
}

// The Astro adapter's output for the guest site: the Worker's server modules and its assets.
const INVITES_SERVER = "../invites/dist/server";
const INVITES_CLIENT = "../invites/dist/client";
const HOST_DIST = "../host/dist";
const VENDOR_DIST = "../vendor/dist";
const LANDING_DIST = "../landing/dist";

/** cire/db's dev seed, imported after the migrations on every tier but production. */
const DEV_SEED = "../db/seed/dev-seed.sql";

/**
 * cire-api's per-IP and per-session limiters, each over 60 seconds. A
 * namespace id is an account-scoped counter, so dev's ids (1101-1106) are
 * never production's (1001-1006, `cire/api/wrangler.toml`).
 */
const RATE_LIMITS: readonly {
  readonly name: string;
  readonly namespaceId: number;
  readonly limit: number;
}[] = [
  { name: "CLAIM_RATE_LIMITER", namespaceId: 1101, limit: 5 },
  { name: "CLAIM_SESSION_RATE_LIMITER", namespaceId: 1102, limit: 60 },
  { name: "REGISTRY_PREVIEW_RATE_LIMITER", namespaceId: 1103, limit: 10 },
  { name: "REGISTRY_IMAGE_RATE_LIMITER", namespaceId: 1104, limit: 10 },
  { name: "REGISTRY_THUMB_RATE_LIMITER", namespaceId: 1106, limit: 60 },
  { name: "REGISTRY_GUEST_RATE_LIMITER", namespaceId: 1105, limit: 20 },
];

/**
 * Request paths on cire-api and cire-invites carry wedding slugs and names,
 * so invocation logs stay off. Dev traces every request with query strings
 * redacted: cire-api's OIDC callback takes its code in one, and the guest
 * site takes a claim code in one.
 */
const DEV_OBSERVABILITY: ApiWorkerObservability = {
  headSamplingRate: 1,
  redactQueryString: true,
  traces: { enabled: true, headSamplingRate: 1 },
  invocationLogs: false,
  issues: true,
};

/**
 * Production's one lifecycle rule on `cire-assets` and `cire-sheets`: abort
 * incomplete multipart uploads after 7 days, every prefix. Alchemy's
 * `BucketLifecycleRule` (alchemy src/Cloudflare/R2/Bucket.ts) takes `id`,
 * `enabled` and `prefix`, and its `toLifecyclePutPayload` sends `prefix` as
 * `conditions.prefix` and the transition as it is, which is Cloudflare's own
 * shape.
 */
const ABORT_INCOMPLETE_UPLOADS: NonNullable<Cloudflare.R2.BucketProps["lifecycleRules"]>[number] = {
  id: "Default Multipart Abort Rule",
  enabled: true,
  prefix: "",
  abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * 24 * 60 * 60 } },
};

/** A bucket with production's settings: Standard, default jurisdiction, ENAM, private, no CORS or custom domain. */
const bucket = (names: StageNames, stage: string): RetainedBucketInput => ({
  name: physicalName(names, stage),
  stage,
  storageClass: "Standard",
  jurisdiction: "default",
  locationHint: "enam",
  publicAccess: false,
  lifecycleRules: [ABORT_INCOMPLETE_UPLOADS],
  cors: [],
  domains: [],
});

/**
 * A static cire site. None of host, vendor and landing builds a
 * `404.html`, so an unknown path is a plain 404; the organiser and vendor
 * portals route in the URL hash, so no deep link needs a fallback. Each
 * ships a `_headers` and no `_redirects`.
 */
const site = (
  names: StageNames,
  stage: string,
  directory: string,
  domain: string,
): SiteWorkerInput => ({
  name: physicalName(names, stage),
  stage,
  directory,
  redirectsFile: true,
  entry: null,
  domain,
  workersDev: false,
  // Off until per-pull-request previews (englishstreetventures/osn#1578):
  // each version's preview URL is a public workers.dev host that no
  // Access application covers.
  previewUrls: false,
  htmlHandling: "auto-trailing-slash",
  notFoundHandling: "none",
  issues: true,
});

/**
 * Every name, var, binding, domain and setting the cire stack declares at
 * `stage`: cire-api with its database and buckets, cire-invites, and the
 * host, vendor and landing sites. Pure; every host comes from `hosts`.
 * `ownerSeat` says whether the stack seeds the sample wedding's owner seat.
 * The production tier is refused until its stack is declared.
 */
export function cireDeclaration(input: {
  readonly stage: string;
  readonly hosts: StageHosts;
  readonly generatedDir: string;
  readonly ownerSeat: boolean;
}): CireDeclaration {
  const { stage, hosts, generatedDir } = input;
  refuseProductionTier(stage);
  const issuer = origin(hosts.osnApi);
  const api = origin(hosts.cireApi);
  const ownerSeat = join(generatedDir, "seeds", "cire-owner-seat.sql");
  return {
    cireApi: {
      worker: "cire-api",
      name: physicalName(
        { base: "cire-api", dev: "cire-api-dev", production: "cire-api-production" },
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
      domain: hosts.cireApi,
      crons: ["0 4 * * *"],
      workersDev: false,
      // Off until per-pull-request previews (englishstreetventures/osn#1578):
      // each version's preview URL is a public workers.dev host that no
      // Access application covers.
      previewUrls: false,
      vars: {
        OSN_ENV: "dev",
        // cire-api reads the entries by position: guest site, organiser
        // portal, vendor portal (cire/api/src/lib/web-origin.ts).
        WEB_ORIGIN: [hosts.cireInvites, hosts.cireHost, hosts.cireVendor].map(origin).join(","),
        OSN_JWKS_URL: `${issuer}/.well-known/jwks.json`,
        OSN_ISSUER_URL: issuer,
        OSN_AUDIENCE: "osn-access",
        // Builds the OIDC redirect URI the musubi stack seeds for cid_cire.
        CIRE_API_ORIGIN: origin(hosts.cireApi),
        CIRE_OIDC_CLIENT_ID: "cid_cire",
        GROWTHBOOK_API_HOST: "https://cdn.growthbook.io",
        CIRE_R2_RECONCILE_DISABLED: "false",
        // A var on dev, derived from the dev domain; production holds it as a secret.
        OSN_API_URL: issuer,
      },
      bindings: {
        DB: { kind: "d1" },
        SHEETS: { kind: "r2" },
        ASSETS: { kind: "r2" },
        IMAGES: { kind: "images" },
        ...Object.fromEntries(
          RATE_LIMITS.map((limit): [string, BindingDescription] => [
            limit.name,
            { kind: "ratelimit", namespaceId: limit.namespaceId, limit: limit.limit, period: 60 },
          ]),
        ),
      },
      observability: DEV_OBSERVABILITY,
    },
    cireDb: {
      name: physicalName({ base: "cire-db", dev: "cire-db-dev", production: "cire-db" }, stage),
      stage,
      readReplication: "auto",
      jurisdiction: "default",
      locationHint: "oc",
      migrations: join(generatedDir, "migrations", "cire-db"),
      importFiles: input.ownerSeat ? [DEV_SEED, ownerSeat] : [DEV_SEED],
    },
    cireAssets: bucket(
      { base: "cire-assets", dev: "cire-assets-dev", production: "cire-assets" },
      stage,
    ),
    cireSheets: bucket(
      { base: "cire-sheets", dev: "cire-sheets-dev", production: "cire-sheets" },
      stage,
    ),
    cireInvites: {
      worker: "cire-invites",
      name: physicalName(
        { base: "cire-invites", dev: "cire-invites-dev", production: "cire-invites" },
        stage,
      ),
      stage,
      // The Astro adapter's build, uploaded as it is: the stack job builds
      // it with the dev site values and a fixed ASTRO_KEY before the deploy.
      main: `${INVITES_SERVER}/entry.mjs`,
      bundle: false,
      // The adapter's generated `dist/server/wrangler.json` declares only
      // `"assets": { "binding": "ASSETS", "directory": "../client" }`, so
      // Wrangler's defaults apply, each written out here; the build emits no
      // `404.html`. The adapter's `dist/client/.assetsignore` (`wrangler.json`,
      // `.dev.vars`) applies under Alchemy as under Wrangler.
      assets: {
        directory: INVITES_CLIENT,
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "none",
        runWorkerFirst: false,
      },
      // `cire/invites/wrangler.jsonc`, verbatim: a prebuilt Worker's flags reach Cloudflare as listed.
      compatibility: { date: "2026-04-15", flags: ["nodejs_compat"] },
      domain: hosts.cireInvites,
      crons: [],
      workersDev: false,
      // Off until per-pull-request previews (englishstreetventures/osn#1578):
      // each version's preview URL is a public workers.dev host that no
      // Access application covers.
      previewUrls: false,
      vars: {},
      bindings: {},
      observability: DEV_OBSERVABILITY,
    },
    cireHost: site(
      { base: "cire-host", dev: "cire-host-dev", production: "cire-host" },
      stage,
      HOST_DIST,
      hosts.cireHost,
    ),
    cireVendor: site(
      { base: "cire-vendor", dev: "cire-vendor-dev", production: "cire-vendor" },
      stage,
      VENDOR_DIST,
      hosts.cireVendor,
    ),
    cireLanding: site(
      { base: "cire-landing", dev: "cire-landing-dev", production: "cire-landing" },
      stage,
      LANDING_DIST,
      hosts.cireLanding,
    ),
    seeds: { ownerSeat },
    // Each site's build bakes in what deploy.yml's build step sets. The
    // guest site's client output names cire-api only in its `_headers` CSP;
    // its server output names cire-api, itself and the marketing site
    // (PUBLIC_API_URL, PUBLIC_SITE_URL, PUBLIC_MARKETING_URL). The organiser
    // portal names cire-api, the account app and the guest site; the vendor
    // portal cire-api and the account app; the marketing site itself (SITE)
    // and the organiser portal (PUBLIC_ORGANISER_URL).
    prebuilt: [
      { site: "@cire/invites client", directory: INVITES_CLIENT, origins: [api] },
      {
        site: "@cire/invites server",
        directory: INVITES_SERVER,
        origins: [api, origin(hosts.cireInvites), origin(hosts.cireLanding)],
      },
      {
        site: "@cire/host",
        directory: HOST_DIST,
        origins: [api, origin(hosts.musubiSocial), origin(hosts.cireInvites)],
      },
      { site: "@cire/vendor", directory: VENDOR_DIST, origins: [api, origin(hosts.musubiSocial)] },
      {
        site: "@cire/landing",
        directory: LANDING_DIST,
        origins: [origin(hosts.cireLanding), origin(hosts.cireHost)],
      },
    ],
  };
}
