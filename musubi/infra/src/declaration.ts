import { join } from "node:path";

import {
  origin,
  physicalName,
  PRODUCTION_SITE_MODES,
  productionSiteKinds,
  refuseProductionTier,
  siteDomain,
  type ApiWorkerInput,
  type PrebuiltSite,
  type ResourceKind,
  type RetainedD1Input,
  type SiteMode,
  type SiteSurface,
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

/** Each musubi site's logical id, which keys its state row on every stage, so it never changes. */
export const SITE_LOGICAL_IDS = {
  osn_social: "MusubiSocial",
  musubi_landing: "MusubiLanding",
} as const satisfies Readonly<Partial<Record<SiteSurface, string>>>;

type MusubiSite = keyof typeof SITE_LOGICAL_IDS;

const MUSUBI_SITES = Object.keys(SITE_LOGICAL_IDS) as readonly MusubiSite[];

/**
 * musubi social: the account app. The built `_redirects` sends every path to
 * index.html for Pages; on a Worker the single-page fallback serves deep
 * links instead.
 */
const socialSite = (stage: string, domain: string | null): SiteWorkerInput => ({
  name: physicalName(
    { base: "osn-social", dev: "osn-social-dev", production: "osn-social" },
    stage,
  ),
  stage,
  directory: SOCIAL_DIST,
  redirectsFile: false,
  entry: null,
  domain,
  workersDev: false,
  // Off until per-pull-request previews (englishstreetventures/osn#1578):
  // each version's preview URL is a public workers.dev host that no
  // Access application covers.
  previewUrls: false,
  htmlHandling: "auto-trailing-slash",
  notFoundHandling: "single-page-application",
  issues: true,
});

/**
 * musubi landing: the marketing site. It builds no 404.html (its pages are
 * index, privacy and terms), so an unknown path is a plain 404, and ships no
 * `_redirects`.
 */
const landingSite = (stage: string, domain: string | null): SiteWorkerInput => ({
  name: physicalName(
    { base: "musubi-landing", dev: "musubi-landing-dev", production: "musubi-landing" },
    stage,
  ),
  stage,
  directory: LANDING_DIST,
  // A built `_redirects` would apply; the site ships none.
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
 * Each site's build output, and the origins its build bakes in: musubi
 * social osn-api's (VITE_OSN_ISSUER_URL), musubi landing the app's
 * (PUBLIC_APP_URL) and its own (SITE).
 */
interface MusubiSiteSpec {
  readonly declare: (stage: string, domain: string | null) => SiteWorkerInput;
  readonly prebuilt: (hosts: StageHosts) => PrebuiltSite;
}

const SITES = {
  osn_social: {
    declare: socialSite,
    prebuilt: (hosts) => ({
      site: "@musubi/social",
      directory: SOCIAL_DIST,
      origins: [origin(hosts.osnApi)],
    }),
  },
  musubi_landing: {
    declare: landingSite,
    prebuilt: (hosts) => ({
      site: "@musubi/landing",
      directory: LANDING_DIST,
      origins: [origin(hosts.musubiSocial), origin(hosts.musubiLanding)],
    }),
  },
} satisfies Readonly<Record<MusubiSite, MusubiSiteSpec>>;

/** Every resource the musubi stack declares on production, by logical id, with its kind for the plan guard. */
export const PRODUCTION_RESOURCE_KINDS: Readonly<Record<string, ResourceKind>> =
  productionSiteKinds(SITE_LOGICAL_IDS, PRODUCTION_SITE_MODES);

/** The musubi stack on production: its sites, by logical id, and the build each uploads. */
export interface MusubiProductionSites {
  readonly sites: Readonly<Record<string, SiteWorkerInput>>;
  readonly prebuilt: readonly PrebuiltSite[];
}

/**
 * What the musubi stack declares on production: each site `modes` does not
 * turn off, under today's production name, serving its spare host while
 * staged and its production host as a worker. Every build is the
 * production build and bakes in `hosts`, today's production hosts. No
 * osn-api or database: those join the stack in a later step of phase P3.
 * Pure.
 */
export function musubiProductionSites(input: {
  readonly modes: Readonly<Record<SiteSurface, SiteMode>>;
  readonly hosts: StageHosts;
}): MusubiProductionSites {
  const shipped = MUSUBI_SITES.filter((key) => input.modes[key] !== "off");
  return {
    sites: Object.fromEntries(
      shipped.map((key) => [
        SITE_LOGICAL_IDS[key],
        SITES[key].declare("production", siteDomain(key, input.modes[key])),
      ]),
    ),
    prebuilt: shipped.map((key) => SITES[key].prebuilt(input.hosts)),
  };
}

/**
 * Every name, var, binding, domain and setting the musubi stack declares at
 * `stage`: osn-api and its database, musubi social and musubi landing. Pure;
 * every host comes from `hosts`. The production tier is refused:
 * `musubiProductionSites` declares it.
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
        OSN_RP_NAME: `Musubi (${stage})`,
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
        // Resend refuses a sender on a domain it has not verified, so musubi.social must be
        // verified before a deploy (englishstreetventures/osn#1548). Dev shares the address
        // production moves to, by the owner's choice on that issue.
        OSN_EMAIL_FROM: "Musubi <hello@musubi.social>", // not a host: the sender
        // Sign out everywhere else, and revoking cire's connection, end the account's
        // cire organiser sessions through cire-api. Both equal cire-api's own
        // CIRE_API_ORIGIN and CIRE_OIDC_CLIENT_ID (cire/infra/tests/cross-stack.test.ts).
        CIRE_INTERNAL_REVOKE_URL: origin(hosts.cireApi),
        CIRE_OIDC_CLIENT_ID: "cid_cire",
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
    musubiSocial: socialSite(stage, hosts.musubiSocial),
    musubiLanding: landingSite(stage, hosts.musubiLanding),
    seeds: { osn: osnSeed },
    // Each site's build bakes in what deploy.yml's build step sets; SITES
    // says what.
    prebuilt: MUSUBI_SITES.map((key) => SITES[key].prebuilt(hosts)),
  };
}
