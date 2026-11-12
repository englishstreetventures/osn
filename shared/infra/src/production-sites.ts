/**
 * Which production sites the stacks deploy, and which hosts they serve.
 *
 *  - `PRODUCTION_SITE_MODES`: one switch per site. `off`, the stack declares
 *    no Worker for it; `worker`, the Worker serves its production host.
 *  - `PRODUCTION_HOST_HOLDS`: production hosts held off their Workers. A
 *    held site keeps its Worker and gets each release's build, but serves no
 *    host, and the plan guard refuses any plan in which a site Worker would
 *    serve a held host.
 *
 * This file imports nothing, so scripts that run with no install
 * (scripts/deploy-surfaces.ts) load it by relative path.
 */

export type SiteMode = "off" | "worker";

/** Every site a production stack can deploy, by its key in scripts/deploy-surfaces.ts. */
export type SiteSurface =
  | "cire_host"
  | "cire_vendor"
  | "cire_landing"
  | "osn_social"
  | "musubi_landing"
  | "pulse_landing";

/** One value for each site. */
export interface PerSite<T> {
  readonly cire_host: T;
  readonly cire_vendor: T;
  readonly cire_landing: T;
  readonly osn_social: T;
  readonly musubi_landing: T;
  readonly pulse_landing: T;
}

/** The workspace that builds a site, and the directory its build writes, from the repository root. */
export interface SiteBuild {
  readonly package: string;
  readonly directory: string;
}

export const SITE_SURFACES: readonly SiteSurface[] = [
  "cire_host",
  "cire_vendor",
  "cire_landing",
  "osn_social",
  "musubi_landing",
  "pulse_landing",
];

/**
 * The switch. A site turned to `worker` in a pull request has its production
 * host attached to its Worker by its stack's next release. Pulse landing
 * stays `off` until englishstreetventures/osn#1794 settles its host and app
 * link.
 */
export const PRODUCTION_SITE_MODES: PerSite<SiteMode> = {
  cire_host: "worker",
  cire_vendor: "worker",
  cire_landing: "worker",
  osn_social: "worker",
  musubi_landing: "worker",
  pulse_landing: "off",
};

/** This file, from the repository root: the plan guard and the smoke check name it. */
export const HOST_HOLDS_FILE = "shared/infra/src/production-sites.ts";

/** A production host held off its site's Worker. */
export interface HostHold {
  readonly site: SiteSurface;
  /** The site's production host, named so the entry and every refusal read plainly. */
  readonly host: string;
  /**
   * One line stating the constraint that keeps the host off. It is public:
   * this file, the plan guard's run summary and the smoke check's notice
   * print it. Never an incident, a finding or an issue reference.
   */
  readonly reason: string;
}

/**
 * Production hosts held off their sites' Workers, so a host taken off its
 * Worker in the Cloudflare dashboard stays off through every release. The
 * stack declares a held site's Worker with no custom domain, the plan guard
 * refuses any plan in which a site Worker would serve a held host, and the
 * site's smoke check passes once it has read that the host is off its
 * Worker. A pull request that removes an entry brings its host back with
 * the next release; one that adds or removes an entry takes an @shared/infra
 * changeset. The runbook is wiki/shared/production-deploy.md §5.8.
 */
export const PRODUCTION_HOST_HOLDS: readonly HostHold[] = [];

/**
 * Names of the production API Workers, databases and buckets the stacks
 * adopt: each existed before Alchemy deployed it, and each stack declares it
 * under its existing name. The builders refuse any other production name, so
 * a new production Worker, database or bucket is a change to this list.
 */
export const PRODUCTION_ADOPTIONS: readonly string[] = [
  // musubi
  "osn-api-production",
  "osn-db-prod",
  // cire
  "cire-api-production",
  "cire-invites",
  "cire-db",
  "cire-assets",
  "cire-sheets",
  // zap
  "zap-api-production",
  "zap-db-prod",
];

/**
 * Today's production host of every surface, keyed as `StageHosts` in
 * hosts.ts. Each is the custom domain its Wrangler config or its site
 * Worker serves, and musubi landing's the one its build names
 * (musubi/landing/astro.config.mjs). Pulse landing's is the one
 * pulse/landing/astro.config.mjs names; it is `off`, so nothing serves it.
 */
export const PRODUCTION_HOSTS = {
  musubiSocial: "musubi.social",
  osnApi: "id.musubi.social",
  musubiLanding: "www.musubi.social",
  cireLanding: "cireweddings.com",
  cireApi: "api.cireweddings.com",
  cireInvites: "invite.cireweddings.com",
  cireHost: "host.cireweddings.com",
  cireVendor: "vendor.cireweddings.com",
  zapApi: "zap.cireweddings.com",
  pulseLanding: "pulse.events",
} as const;

/** The `PRODUCTION_HOSTS` key of each site. */
export const SITE_HOST_KEYS = {
  cire_host: "cireHost",
  cire_vendor: "cireVendor",
  cire_landing: "cireLanding",
  osn_social: "musubiSocial",
  musubi_landing: "musubiLanding",
  pulse_landing: "pulseLanding",
} as const satisfies Readonly<Record<SiteSurface, keyof typeof PRODUCTION_HOSTS>>;

/** Each site's build. */
export const SITE_BUILDS: PerSite<SiteBuild> = {
  cire_host: { package: "@cire/host", directory: "cire/host/dist" },
  cire_vendor: { package: "@cire/vendor", directory: "cire/vendor/dist" },
  cire_landing: { package: "@cire/landing", directory: "cire/landing/dist" },
  osn_social: { package: "@musubi/social", directory: "musubi/social/dist" },
  musubi_landing: { package: "@musubi/landing", directory: "musubi/landing/dist" },
  pulse_landing: { package: "@pulse/landing", directory: "pulse/landing/dist" },
};

/** Every API Worker a production stack deploys, by its key in scripts/deploy-surfaces.ts. */
export type ApiSurface = "cire_api" | "cire_invites" | "osn_api" | "zap_api";

export const API_SURFACES: readonly ApiSurface[] = [
  "cire_api",
  "cire_invites",
  "osn_api",
  "zap_api",
];

/** The `PRODUCTION_HOSTS` key of each API Worker: the custom domain its stack declares. */
export const API_HOST_KEYS = {
  cire_api: "cireApi",
  cire_invites: "cireInvites",
  osn_api: "osnApi",
  zap_api: "zapApi",
} as const satisfies Readonly<Record<ApiSurface, keyof typeof PRODUCTION_HOSTS>>;

/**
 * Each API Worker whose stack uploads a build made outside it: the guest
 * site, whose Astro build writes the Worker's server modules and its static
 * assets under one directory. Production builds it in the release's `sites`
 * job, beside the sites.
 */
export const PREBUILT_WORKER_BUILDS = {
  cire_invites: { package: "@cire/invites", directory: "cire/invites/dist" },
} as const satisfies Readonly<Partial<Record<ApiSurface, SiteBuild>>>;

/** The site's production host. */
export function productionHost(surface: SiteSurface): string {
  return PRODUCTION_HOSTS[SITE_HOST_KEYS[surface]];
}

/** The hold on the site's host, or undefined when `holds` holds none. */
export function heldHost(
  surface: SiteSurface,
  holds: readonly HostHold[] = PRODUCTION_HOST_HOLDS,
): HostHold | undefined {
  return holds.find((hold) => hold.site === surface);
}

/**
 * The host a site's Worker serves: its production host as a worker, none
 * when off or when `holds` holds it.
 */
export function siteDomain(
  surface: SiteSurface,
  mode: SiteMode,
  holds: readonly HostHold[] = PRODUCTION_HOST_HOLDS,
): string | null {
  if (mode === "off" || heldHost(surface, holds) !== undefined) return null;
  return productionHost(surface);
}

/**
 * What the `production-hosts` command writes, one GitHub step output each:
 * `<surface>_origin`, the origin of each non-off site's production host and
 * of each API Worker's, which the production stack jobs' smoke checks probe.
 * A held site's is written too; its smoke check reads the hold and probes
 * nothing.
 */
export function productionHostOutputs(
  modes: Readonly<Record<SiteSurface, SiteMode>> = PRODUCTION_SITE_MODES,
): ReadonlyMap<string, string> {
  return new Map([
    ...API_SURFACES.map((surface): [string, string] => [
      `${surface}_origin`,
      `https://${PRODUCTION_HOSTS[API_HOST_KEYS[surface]]}`,
    ]),
    ...SITE_SURFACES.flatMap((surface): [string, string][] =>
      modes[surface] === "off" ? [] : [[`${surface}_origin`, `https://${productionHost(surface)}`]],
    ),
  ]);
}

/** The zone a production host is in: its last two labels. */
export const zoneOf = (host: string): string => host.split(".").slice(-2).join(".");
