#!/usr/bin/env bun
/**
 * Read, and move, a production site's custom domain between its Cloudflare
 * Pages project and its Worker.
 *
 * A site moves from Pages to a Worker one domain at a time
 * (shared/infra/src/production-sites.ts): its mode turns from `staged` to
 * `worker`, and a release dispatched with `flip` naming it moves the domain.
 * Alchemy attaches a Worker custom domain, but cannot take one from a Pages
 * project, so this does that half.
 *
 *   bun run scripts/pages-domain.ts check <surface>...
 *     Prints, per site, where its production host is: `pages <project>`
 *     when exactly one Pages project lists it; `free` when none does and the
 *     zone holds no DNS record for it but a Worker's; anything else, or any
 *     API error, fails. Exit 0 when every host reads `pages` or `free`.
 *   bun run scripts/pages-domain.ts precheck
 *     The release's check before any plan (FLIP, STACKS from the plan job):
 *     every `worker` site of a shipping stack must read `free`, except the
 *     flip's own, which must read `pages`. A cron release therefore never
 *     moves a domain, and a flip names a domain that is on Pages.
 *   bun run scripts/pages-domain.ts detach <surface>
 *     Takes the host off its Pages project and deletes the zone's CNAME to
 *     `<project>.pages.dev`, and only that record. Refused unless the host
 *     reads `pages` on the site's own project and the site is `worker`.
 *   bun run scripts/pages-domain.ts attach <surface>
 *     The rollback: puts the CNAME back and adds the host to the Pages
 *     project, making only what is missing, so it also finishes a detach or
 *     an attach that stopped part-way. Refused while another Pages project
 *     lists the host or the zone holds any record for it but that CNAME
 *     (remove the Worker's custom domain first).
 *
 * How the API shows a Worker's custom-domain record, `meta.origin_worker_id`
 * or a read-only AAAA to `100::`, is unverified until the dev-zone rehearsal
 * that precedes the first flip records Cloudflare's answers; a record that
 * matches neither fails the check, so the check fails closed.
 *
 * Environment:
 *   CLOUDFLARE_ACCOUNT_ID       the production account.
 *   CLOUDFLARE_PAGES_DNS_TOKEN  a token holding Pages Edit on the account and
 *                               DNS Edit on the production zones, and nothing
 *                               else. Sent only to api.cloudflare.com. No
 *                               message carries it or the account id.
 *   FLIP, STACKS                precheck only: the plan job's `flip` and
 *                               `stacks` outputs.
 *
 * Imports nothing outside this repository's import-free files, so a step
 * that holds the token runs it before any install.
 *
 * Exit codes: 0 done; 1 refused, or the API failed; 2 a usage error, before
 * any request.
 */

import {
  PAGES_PROJECTS,
  type PerSite,
  PRODUCTION_SITE_MODES,
  productionHost,
  SITE_SURFACES,
  type SiteMode,
  type SiteSurface,
  zoneOf,
} from "../shared/infra/src/production-sites";
import { surface, type StackKey } from "./deploy-surfaces";

const API = "https://api.cloudflare.com/client/v4";

/** A DNS record as the zone's records list gives it, the fields this reads. */
export interface DnsRecord {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly meta?: { readonly origin_worker_id?: unknown; readonly read_only?: unknown };
}

export interface PagesProject {
  readonly name: string;
  readonly domains: readonly string[];
}

export type DomainState =
  | { readonly kind: "pages"; readonly project: string }
  | { readonly kind: "free" }
  | { readonly kind: "unclear"; readonly reason: string };

/** A record a Worker custom domain made. */
export function isWorkerRecord(record: DnsRecord): boolean {
  const worker = record.meta?.origin_worker_id;
  if (typeof worker === "string" && worker !== "") return true;
  return record.type === "AAAA" && record.content === "100::" && record.meta?.read_only === true;
}

/** Where `host` is, from every Pages project's domains and the zone's records for it. */
export function classify(
  host: string,
  projects: readonly PagesProject[],
  records: readonly DnsRecord[],
): DomainState {
  const holders = projects.filter((project) => project.domains.includes(host));
  if (holders.length === 1) return { kind: "pages", project: holders[0]?.name ?? "" };
  if (holders.length > 1) {
    return {
      kind: "unclear",
      reason: `${holders.length} Pages projects list it: ${holders.map((p) => p.name).join(", ")}`,
    };
  }
  if (records.every(isWorkerRecord)) return { kind: "free" };
  return {
    kind: "unclear",
    reason: `no Pages project lists it, and the zone holds a ${records
      .filter((record) => !isWorkerRecord(record))
      .map((record) => record.type)
      .join(", ")} record for it that is not a Worker's`,
  };
}

class ApiError extends Error {}

/** The most pages of Pages projects read before the listing gives up, failing. */
const MAX_PROJECT_PAGES = 20;

/** The few Cloudflare calls this makes, with the token; any failure throws ApiError naming the call. */
function cloudflare(env: Readonly<Record<string, string | undefined>>, fetcher: typeof fetch) {
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = env.CLOUDFLARE_PAGES_DNS_TOKEN ?? "";
  const call = async (method: string, path: string, what: string, body?: unknown) => {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetcher(`${API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(`${what}: no answer`);
    }
    const parsed = (await response.json().catch(() => null)) as {
      success?: unknown;
      result?: unknown;
      result_info?: { total_pages?: unknown };
      errors?: readonly { code?: unknown }[];
    } | null;
    if (!response.ok || parsed?.success !== true) {
      const codes = (parsed?.errors ?? [])
        .map((error) => error.code)
        .filter((code) => typeof code === "number");
      throw new ApiError(
        `${what}: Cloudflare answered ${response.status}${codes.length > 0 ? ` (codes ${codes.join(", ")})` : ""}`,
      );
    }
    return parsed;
  };
  const accountPath = `/accounts/${encodeURIComponent(account)}`;
  return {
    async projects(): Promise<PagesProject[]> {
      // One page at a time, each read after the last. The list ends at
      // `total_pages` when the answer gives it, else at the first page that
      // holds no project. Anything that leaves the end unknown throws: an
      // answer for another page than the one asked, or a list longer than
      // MAX_PROJECT_PAGES pages, so a host on a page never read can never
      // read as free.
      const readFrom = async (page: number): Promise<string[]> => {
        if (page > MAX_PROJECT_PAGES) {
          throw new ApiError(
            `listing Pages projects: the list runs past ${MAX_PROJECT_PAGES} pages, so where a host is cannot be known`,
          );
        }
        const listed = await call(
          "GET",
          `${accountPath}/pages/projects?page=${page}`,
          "listing Pages projects",
        );
        const answered = listed.result_info?.page;
        if (typeof answered === "number" && answered !== page) {
          throw new ApiError(
            `listing Pages projects: asked for page ${page}, Cloudflare answered page ${answered}`,
          );
        }
        const result = Array.isArray(listed.result) ? (listed.result as { name?: unknown }[]) : [];
        const names = result.flatMap((project) =>
          typeof project.name === "string" ? [project.name] : [],
        );
        const total = listed.result_info?.total_pages;
        const last = typeof total === "number" ? page >= total : names.length === 0;
        return last ? names : [...names, ...(await readFrom(page + 1))];
      };
      const names = [...new Set(await readFrom(1))];
      return Promise.all(
        names.map(async (name) => {
          const listed = await call(
            "GET",
            `${accountPath}/pages/projects/${encodeURIComponent(name)}/domains`,
            `listing ${name}'s domains`,
          );
          const result = Array.isArray(listed.result)
            ? (listed.result as { name?: unknown }[])
            : [];
          return {
            name,
            domains: result.flatMap((domain) =>
              typeof domain.name === "string" ? [domain.name] : [],
            ),
          };
        }),
      );
    },
    async zone(name: string): Promise<string> {
      const listed = await call(
        "GET",
        `/zones?name=${encodeURIComponent(name)}`,
        `finding the ${name} zone`,
      );
      const zones = Array.isArray(listed.result) ? (listed.result as { id?: unknown }[]) : [];
      const [zone] = zones;
      if (zones.length !== 1 || typeof zone?.id !== "string") {
        throw new ApiError(
          `finding the ${name} zone: the token sees ${zones.length} zones of that name`,
        );
      }
      return zone.id;
    },
    async records(zone: string, host: string): Promise<DnsRecord[]> {
      const listed = await call(
        "GET",
        `/zones/${zone}/dns_records?name=${encodeURIComponent(host)}`,
        `listing ${host}'s DNS records`,
      );
      return Array.isArray(listed.result) ? (listed.result as DnsRecord[]) : [];
    },
    deleteRecord: (zone: string, id: string, host: string) =>
      call(
        "DELETE",
        `/zones/${zone}/dns_records/${encodeURIComponent(id)}`,
        `deleting ${host}'s CNAME`,
      ),
    createCname: (zone: string, host: string, target: string) =>
      call("POST", `/zones/${zone}/dns_records`, `creating ${host}'s CNAME`, {
        type: "CNAME",
        name: host,
        content: target,
        proxied: true,
      }),
    removeDomain: (project: string, host: string) =>
      call(
        "DELETE",
        `${accountPath}/pages/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(host)}`,
        `taking ${host} off ${project}`,
      ),
    addDomain: (project: string, host: string) =>
      call(
        "POST",
        `${accountPath}/pages/projects/${encodeURIComponent(project)}/domains`,
        `adding ${host} to ${project}`,
        { name: host },
      ),
  };
}

export interface PagesDomainInput {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly out: (text: string) => void;
  /** The site modes, PRODUCTION_SITE_MODES unless a test passes its own. */
  readonly modes?: PerSite<SiteMode>;
}

const isSiteSurface = (value: string): value is SiteSurface =>
  SITE_SURFACES.some((site) => site === value);

const pagesTarget = (project: string): string => `${project}.pages.dev`;

/** One site's host as read: its zone, the zone's records for it, and where it is. */
interface Located {
  readonly site: SiteSurface;
  readonly host: string;
  readonly zone: string;
  readonly records: readonly DnsRecord[];
  readonly state: DomainState;
}

export async function runPagesDomain(input: PagesDomainInput): Promise<number> {
  const { env, out } = input;
  const modes = input.modes ?? PRODUCTION_SITE_MODES;
  const error = (message: string) => out(`::error::pages-domain: ${message}\n`);
  const usage = (message: string): number => {
    error(message);
    return 2;
  };
  const [command = "", ...names] = input.args;
  if (!["check", "precheck", "detach", "attach"].includes(command)) {
    return usage(
      "usage: pages-domain.ts check <surface>... | precheck | detach <surface> | attach <surface>",
    );
  }
  const unknown = names.filter((name) => !isSiteSurface(name));
  if (unknown.length > 0) {
    return usage(`'${unknown.join("', '")}' is not a site; use any of ${SITE_SURFACES.join(", ")}`);
  }
  const sites = names.filter(isSiteSurface);
  if (
    (command === "check" && sites.length === 0) ||
    ((command === "detach" || command === "attach") && sites.length !== 1)
  ) {
    return usage(`${command} takes ${command === "check" ? "one or more sites" : "one site"}`);
  }
  if (command === "precheck" && sites.length > 0)
    return usage("precheck takes no site; it reads FLIP and STACKS");
  const flip = env.FLIP ?? "";
  if (flip !== "" && !isSiteSurface(flip))
    return usage(`FLIP names '${flip}', which is not a site`);
  const stacks = (env.STACKS ?? "").split(/\s+/).filter((name) => name !== "");
  if (
    (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim() === "" ||
    (env.CLOUDFLARE_PAGES_DNS_TOKEN ?? "").trim() === ""
  ) {
    return usage("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_PAGES_DNS_TOKEN");
  }

  const api = cloudflare(env, input.fetch);
  /** Where a site's host is, with its zone and records, read after the Pages projects. */
  const locate = async (site: SiteSurface, projects: readonly PagesProject[]): Promise<Located> => {
    const host = productionHost(site);
    const zone = await api.zone(zoneOf(host));
    const records = await api.records(zone, host);
    return { site, host, zone, records, state: classify(host, projects, records) };
  };
  try {
    if (command === "precheck") {
      const wanted = SITE_SURFACES.filter(
        (site) => modes[site] === "worker" && stacks.includes(surface(site).stack),
      );
      if (flip !== "" && !wanted.includes(flip as SiteSurface)) {
        error(
          `FLIP names ${flip}, which is not a worker site of a stack this release ships (${stacks.join(", ") || "none"}).`,
        );
        return 1;
      }
      if (wanted.length === 0) {
        out("No worker site ships in this release; nothing to check.\n");
        return 0;
      }
      const projects = await api.projects();
      const read = await Promise.all(wanted.map((site) => locate(site, projects)));
      let refused = false;
      for (const { site, host, state } of read) {
        out(`${site} ${host} ${state.kind}${state.kind === "pages" ? ` ${state.project}` : ""}\n`);
        if (state.kind === "unclear") {
          error(`${site}: ${host}: ${state.reason}.`);
          refused = true;
        } else if (state.kind === "pages" && site !== flip) {
          const owner: StackKey = surface(site).stack;
          error(
            `${site} serves from its Worker in this commit, but ${host} is still on the ${state.project} Pages project. Move it with a release dispatched with flip: ${site} and surfaces: ${site}, at low traffic; until then, dispatch releases whose surfaces leave out the ${owner} stack's sites.`,
          );
          refused = true;
        } else if (state.kind === "free" && site === flip) {
          error(
            `FLIP names ${site}, but ${host} is on no Pages project: there is nothing to move.`,
          );
          refused = true;
        }
      }
      return refused ? 1 : 0;
    }

    const projects = await api.projects();
    const read = await Promise.all(sites.map((site) => locate(site, projects)));
    for (const { site, host, state } of read) {
      out(`${site} ${host} ${state.kind}${state.kind === "pages" ? ` ${state.project}` : ""}\n`);
    }
    if (command === "check") {
      const unclear = read.flatMap(({ site, host, state }) =>
        state.kind === "unclear" ? [`${site}: ${host}: ${state.reason}.`] : [],
      );
      for (const message of unclear) error(message);
      return unclear.length > 0 ? 1 : 0;
    }
    // detach and attach name one site.
    const [{ site, host, zone, records, state }] = read as [Located];
    const project = PAGES_PROJECTS[site];
    if (project === undefined) {
      error(
        `${site} has no Pages project to ${command === "detach" ? "take its host from" : "give its host back to"}.`,
      );
      return 1;
    }
    if (command === "detach") {
      if (modes[site] !== "worker") {
        error(
          `${site} is ${modes[site]} in this commit; only a worker site's host moves to its Worker.`,
        );
        return 1;
      }
      if (state.kind !== "pages" || state.project !== project) {
        error(
          `${host} is not on the ${project} Pages project (${state.kind === "pages" ? `it is on ${state.project}` : state.kind}); nothing is detached.`,
        );
        return 1;
      }
      await api.removeDomain(project, host);
      const cnames = records.filter(
        (record) => record.type === "CNAME" && record.content === pagesTarget(project),
      );
      await Promise.all(cnames.map((record) => api.deleteRecord(zone, record.id, host)));
      out(
        `Took ${host} off ${project} and deleted ${cnames.length} CNAME record${cnames.length === 1 ? "" : "s"} to ${pagesTarget(project)}.\n`,
      );
      return 0;
    }
    // attach also finishes a detach or an attach that stopped part-way: the
    // host's own CNAME to the project, and the project listing the host, are
    // each kept or made; anything else holding the host refuses.
    const ownCname = (record: DnsRecord) =>
      record.type === "CNAME" && record.content === pagesTarget(project);
    const holders = projects.filter((held) => held.domains.includes(host)).map((held) => held.name);
    if (holders.some((name) => name !== project) || !records.every(ownCname)) {
      error(
        `${host} is on another Pages project or has a DNS record that is not its CNAME to ${pagesTarget(project)}; remove the Worker's custom domain for it first, then attach.`,
      );
      return 1;
    }
    const pointed = records.length > 0;
    const listed = holders.includes(project);
    if (pointed && listed) {
      out(`${host} is already on ${project}; nothing to do.\n`);
      return 0;
    }
    if (!pointed) await api.createCname(zone, host, pagesTarget(project));
    if (!listed) await api.addDomain(project, host);
    out(
      `${pointed ? "Kept" : "Made"} ${host}'s CNAME to ${pagesTarget(project)} and ${listed ? "kept" : "added"} it on ${project}; Pages now validates it and issues its certificate.\n`,
    );
    return 0;
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.message);
      return 1;
    }
    throw failure;
  }
}

if (import.meta.main) {
  const code = await runPagesDomain({
    args: process.argv.slice(2),
    env: process.env,
    fetch,
    out: (text) => process.stdout.write(text),
  });
  process.exit(code);
}
