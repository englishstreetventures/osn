/**
 * The names the domain move rehearsal acts on, and nothing else
 * (.github/workflows/domain-move-rehearsal.yml, scripts/domain-move-rehearsal.ts,
 * rehearsal/alchemy.run.ts beside this file).
 *
 * The rehearsal moves one host of the dev zone from a throwaway Pages project
 * to a Worker and back, as a flip release moves a production site's host.
 * The moved host is one label under the zone, as `vendor.cireweddings.com` is
 * under its zone, and the Worker's spare host two, as
 * `next.vendor.cireweddings.com`. Both sit under the investigation stage
 * `domain-move`, where no dev stack serves.
 *
 * This file imports only production-sites.ts, which imports nothing, so a
 * step that installs nothing loads it.
 */

import { PRODUCTION_HOSTS, zoneOf } from "../src/production-sites";

/** A name the rehearsal refuses. Plain Error: this file loads with no install. */
export class RehearsalNameError extends Error {
  readonly _tag = "RehearsalNameError";

  constructor(message: string) {
    super(message);
    this.name = "RehearsalNameError";
  }
}

/** The Alchemy stage the rehearsal's Worker deploys at: an investigation stage on the dev tier. */
export const REHEARSAL_STAGE = "domain-move";

/** The Alchemy stack's name, which keys its rows in the dev account's state store. */
export const REHEARSAL_STACK = "domain-move-rehearsal";

/** The rehearsal Worker's script name; the destroy step deletes this name and no other. */
export const REHEARSAL_WORKER = "osn-domain-move-rehearsal";

/** Every rehearsal Pages project's name starts with this; the cleanup removes every project that does. */
export const REHEARSAL_PROJECT_PREFIX = "osn-move-rehearsal-";

/** What each side serves, so a probe can tell which one answered. Neither contains the other. */
export const REHEARSAL_MARKERS = {
  pages: "osn-domain-move-rehearsal:pages",
  worker: "osn-domain-move-rehearsal:worker",
} as const;

/** Where the rehearsal Worker's domain is: its spare host, or the moved host, as a site's `staged` and `worker` modes. */
export type RehearsalMode = "staged" | "worker";

export const REHEARSAL_MODES: readonly RehearsalMode[] = ["staged", "worker"];

export interface RehearsalHosts {
  /** The zone's name: DEV_DOMAIN itself. */
  readonly zone: string;
  /** The host that moves from the Pages project to the Worker and back. */
  readonly host: string;
  /** The Worker's host while the moved host is on Pages. */
  readonly spare: string;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Shared suffixes whose hosts are `<script>.<subdomain>.<suffix>`, as hosts.ts refuses them. */
const SHARED_SUFFIXES: readonly string[] = ["workers.dev", "pages.dev"];

const under = (name: string, zone: string): boolean => name === zone || name.endsWith(`.${zone}`);

/** The zones production serves from: the zone of each production host. */
export function rehearsalProductionZones(): readonly string[] {
  return [...new Set(Object.values(PRODUCTION_HOSTS).map(zoneOf))];
}

/**
 * The rehearsal's hosts in the dev zone `devDomain` names. Throws
 * RehearsalNameError for a name that is not a bare lower-case domain of two
 * or more labels, is under workers.dev or pages.dev, or is a production zone
 * or a name under one.
 */
export function rehearsalHosts(devDomain: string): RehearsalHosts {
  const labels = devDomain.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw new RehearsalNameError(
      `DEV_DOMAIN '${devDomain}' is not a bare lower-case domain name with at least two labels.`,
    );
  }
  const production = rehearsalProductionZones().find((zone) => under(devDomain, zone));
  if (production !== undefined) {
    throw new RehearsalNameError(
      `DEV_DOMAIN '${devDomain}' is the production zone ${production} or a name under it; the rehearsal runs on the dev zone alone.`,
    );
  }
  if (SHARED_SUFFIXES.some((suffix) => under(devDomain, suffix))) {
    throw new RehearsalNameError(
      `DEV_DOMAIN '${devDomain}' is under workers.dev or pages.dev, which hold no custom domain.`,
    );
  }
  const host = `${REHEARSAL_STAGE}.${devDomain}`;
  return { zone: devDomain, host, spare: `next.${host}` };
}

/** The host the rehearsal Worker serves at `mode`. */
export function rehearsalDomain(hosts: RehearsalHosts, mode: RehearsalMode): string {
  return mode === "worker" ? hosts.host : hosts.spare;
}

/** The longest Pages project name Cloudflare takes. */
const MAX_PROJECT_NAME = 58;

/**
 * The Pages project of the run `runId` names. One per run: a project's
 * `*.pages.dev` subdomain is `<name>.pages.dev` only while that name is free,
 * and pages-domain.ts points the host at `<project>.pages.dev`.
 */
export function rehearsalProject(runId: string): string {
  const name = `${REHEARSAL_PROJECT_PREFIX}${runId}`;
  if (!/^[0-9]+$/.test(runId) || name.length > MAX_PROJECT_NAME) {
    throw new RehearsalNameError(
      `'${runId}' is not a run id: GITHUB_RUN_ID is digits, and the project name it makes must be at most ${MAX_PROJECT_NAME} characters.`,
    );
  }
  return name;
}
