/**
 * Which production sites the stacks deploy, and where each one serves. One
 * switch per site: `PRODUCTION_SITE_MODES`.
 *
 *  - `off`: the stack declares no Worker for the site.
 *  - `staged`: the stack deploys the site's production build to a Worker on
 *    the site's spare host in its production zone; the Pages project still
 *    serves the production host, and its Pages job in production-release.yml
 *    still deploys it.
 *  - `worker`: the Worker serves the production host.
 *
 * This file imports nothing, so scripts that run with no install
 * (scripts/deploy-surfaces.ts, scripts/pages-domain.ts,
 * scripts/site-parity.ts) load it by relative path.
 */

export type SiteMode = "off" | "staged" | "worker";

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

/** A value for some of the sites. */
export interface SomeSites<T> {
  readonly cire_host?: T;
  readonly cire_vendor?: T;
  readonly cire_landing?: T;
  readonly osn_social?: T;
  readonly musubi_landing?: T;
  readonly pulse_landing?: T;
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
 * The switch. A site moves from `staged` to `worker` in its own pull
 * request, and its domain moves in a release dispatched with `flip` naming
 * it. Pulse landing stays `off` until englishstreetventures/osn#1794 settles
 * its host and app link.
 */
export const PRODUCTION_SITE_MODES: PerSite<SiteMode> = {
  cire_host: "staged",
  cire_vendor: "staged",
  cire_landing: "staged",
  osn_social: "staged",
  musubi_landing: "worker",
  pulse_landing: "off",
};

/**
 * Names of the production API Workers, databases and buckets a stack may
 * adopt. Empty: production stacks declare sites only, and the builders and
 * the plan guard refuse any adoption.
 */
export const PRODUCTION_ADOPTIONS: readonly string[] = [];

/**
 * Today's production host of every surface, keyed as `StageHosts` in
 * hosts.ts. Each is the custom domain its Wrangler config or Pages project
 * serves, and musubi landing's the one its build names
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

/**
 * The spare host in its own production zone each site serves while
 * `staged`, so the zone's settings apply to it as they will to the
 * production host. A site with none cannot be `staged`.
 */
export const PRODUCTION_STAGING_HOSTS: SomeSites<string> = {
  cire_host: "next-host.cireweddings.com",
  cire_vendor: "next-vendor.cireweddings.com",
  cire_landing: "next.cireweddings.com",
  osn_social: "next.musubi.social",
};

/** The Pages project that serves each site's production host today. */
export const PAGES_PROJECTS: SomeSites<string> = {
  cire_host: "cire-host",
  cire_vendor: "cire-vendor",
  cire_landing: "cire-landing",
  osn_social: "osn-social",
};

/** Each site's build. */
export const SITE_BUILDS: PerSite<SiteBuild> = {
  cire_host: { package: "@cire/host", directory: "cire/host/dist" },
  cire_vendor: { package: "@cire/vendor", directory: "cire/vendor/dist" },
  cire_landing: { package: "@cire/landing", directory: "cire/landing/dist" },
  osn_social: { package: "@musubi/social", directory: "musubi/social/dist" },
  musubi_landing: { package: "@musubi/landing", directory: "musubi/landing/dist" },
  pulse_landing: { package: "@pulse/landing", directory: "pulse/landing/dist" },
};

/** A site mode the declaration cannot serve. Plain Error: this file imports nothing. */
export class SiteModeError extends Error {
  readonly _tag = "SiteModeError";
  readonly surface: SiteSurface;

  constructor(surface: SiteSurface, message: string) {
    super(message);
    this.name = "SiteModeError";
    this.surface = surface;
  }
}

/** The site's production host. */
export function productionHost(surface: SiteSurface): string {
  return PRODUCTION_HOSTS[SITE_HOST_KEYS[surface]];
}

/**
 * The host a site's Worker serves at `mode`: its spare host while staged,
 * its production host as a worker, none when off. Throws SiteModeError for a
 * staged site with no spare host.
 */
export function siteDomain(surface: SiteSurface, mode: SiteMode): string | null {
  if (mode === "off") return null;
  if (mode === "worker") return productionHost(surface);
  const staging = PRODUCTION_STAGING_HOSTS[surface];
  if (staging === undefined) {
    throw new SiteModeError(
      surface,
      `${surface} is staged, but it has no spare host in PRODUCTION_STAGING_HOSTS to serve from.`,
    );
  }
  return staging;
}

/**
 * What the `production-hosts` command writes, one GitHub step output each:
 * `<surface>_origin`, the origin each non-off site's Worker serves at its
 * mode, which the production stack job's smoke checks probe.
 */
export function productionHostOutputs(
  modes: Readonly<Record<SiteSurface, SiteMode>> = PRODUCTION_SITE_MODES,
): ReadonlyMap<string, string> {
  return new Map(
    SITE_SURFACES.flatMap((surface): [string, string][] => {
      const host = siteDomain(surface, modes[surface]);
      return host === null ? [] : [[`${surface}_origin`, `https://${host}`]];
    }),
  );
}

/** The zone a production host is in: its last two labels. */
export const zoneOf = (host: string): string => host.split(".").slice(-2).join(".");
