/**
 * Cross-app dev URLs.
 *
 * Every app in this repo needs the origin of some *other* app in the local
 * devloop: `@cire/host` calls `@cire/api`, `@osn/api` allow-lists the frontends
 * that may fetch it with credentials, `@pulse/web` points at `@pulse/api`.
 * Those used to be hardcoded `http://localhost:<port>` strings, which meant
 * remembering twelve port numbers and one dev stack at a time.
 *
 * The devloop now runs behind [portless](https://github.com/vercel-labs/portless):
 * each app gets a stable hostname (`https://api.cire.localhost`) and portless
 * hands the child process its own URL in `PORTLESS_URL`. In a linked git
 * worktree portless prepends the branch as a subdomain, so the same command in
 * two worktrees gives two independent stacks
 * (`https://api.cire.localhost` and `https://my-branch.api.cire.localhost`).
 *
 * That branch prefix is why sibling URLs cannot be written down anywhere: they
 * are only knowable at run time. Given one app's own `PORTLESS_URL` this module
 * splits off the shared prefix and TLD and rebuilds any sibling's URL from it,
 * so a worktree's apps always talk to their own worktree's siblings.
 *
 * Without portless (`PORTLESS=0`, or running `bun run dev:app` directly) there
 * is no `PORTLESS_URL` and every app falls back to the fixed localhost port it
 * used before.
 */

/** Portless app name + the port that app listens on when portless is off. */
export interface DevApp {
  /** Name registered with the portless proxy (the `"portless"` key in that package's package.json). */
  readonly name: string;
  /** Fixed port used when the devloop runs without portless. */
  readonly port: number;
}

/**
 * Every long-running app in the workspace, keyed by package name.
 *
 * The names mirror production hostnames so a dev URL reads like the real one:
 * `id.musubi` for `id.musubi.social`, `host.cire` for `host.cireweddings.com`.
 * That nesting is also what keeps WebAuthn working — see {@link devRpId}.
 *
 * Keep in step with the `"portless"` key in each app's `package.json`: that is
 * what the proxy reads, this map is what the apps read. `tests/manifest.test.ts`
 * asserts the two agree.
 */
export const DEV_APPS = {
  "@osn/social": { name: "musubi", port: 1422 },
  "@osn/api": { name: "id.musubi", port: 4000 },
  "@osn/landing": { name: "www.musubi", port: 4324 },
  "@pulse/web": { name: "pulse", port: 1420 },
  "@pulse/api": { name: "api.pulse", port: 3001 },
  "@pulse/landing": { name: "www.pulse", port: 4325 },
  "@cire/landing": { name: "cire", port: 4323 },
  "@cire/invites": { name: "invite.cire", port: 4321 },
  "@cire/host": { name: "host.cire", port: 4322 },
  "@cire/vendor": { name: "vendor.cire", port: 4326 },
  "@cire/api": { name: "api.cire", port: 8787 },
  "@zap/api": { name: "zap.cire", port: 3002 },
} as const satisfies Record<string, DevApp>;

export type DevAppId = keyof typeof DEV_APPS;

/** What this module reads out of `process.env`. Narrowed so callers can pass a plain map. */
export type DevEnv = Readonly<Record<string, string | undefined>>;

/**
 * The portless hostname split around the caller's own app name:
 * `https://my-branch.api.cire.localhost` for `@cire/api` is
 * prefix `my-branch.`, tld `localhost`.
 */
interface ProxyAddress {
  readonly protocol: string;
  /** Worktree subdomain including its trailing dot, or `""` in the main worktree. */
  readonly prefix: string;
  /** Everything after the app name — `localhost`, `local.test`, `dev.example.com`. */
  readonly tld: string;
  /** Non-default proxy port (`portless proxy start -p 1355`), or `""`. */
  readonly port: string;
}

/**
 * Recover the prefix/TLD around `name` in `url`.
 *
 * Returns null when the URL is unparseable or does not contain the app's own
 * name as a whole label run — the case where an app was renamed in its
 * `"portless"` key but not here. Callers fall back to fixed ports rather than
 * inventing a hostname that resolves nowhere.
 */
function splitHost(url: string, name: string): ProxyAddress | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  // `lastIndexOf`, not `indexOf`: the app name sits immediately before the TLD,
  // and a worktree prefix can repeat it. On a branch called `cire`, `@cire/landing`
  // is served at `cire.cire.localhost`, where a left-to-right search takes the
  // prefix for the name and derives siblings nobody is serving.
  const index = host.lastIndexOf(`${name}.`);
  // Must start a label: either the host begins with the name, or the character
  // before it is a dot. Without this `cire` would match inside `apicire.dev`.
  if (index < 0 || (index > 0 && host[index - 1] !== ".")) return null;
  const tld = host.slice(index + name.length + 1);
  if (!tld) return null;
  return { protocol: parsed.protocol, prefix: host.slice(0, index), tld, port: parsed.port };
}

/**
 * Origins for every app in the devloop, as seen from `self`.
 *
 * With portless on, the returned URLs carry `self`'s own worktree prefix, so
 * apps in one worktree never address another worktree's stack. With portless
 * off, they are the historical `http://localhost:<port>` origins.
 */
export function devUrls(self: DevAppId, env: DevEnv = process.env): Record<DevAppId, string> {
  const address = env.PORTLESS_URL ? splitHost(env.PORTLESS_URL, DEV_APPS[self].name) : null;
  const entries = Object.entries(DEV_APPS) as [DevAppId, DevApp][];
  return Object.fromEntries(
    entries.map(([id, app]) => [
      id,
      address
        ? `${address.protocol}//${address.prefix}${app.name}.${address.tld}${address.port ? `:${address.port}` : ""}`
        : `http://localhost:${app.port}`,
    ]),
  ) as Record<DevAppId, string>;
}

/** One app's dev origin, as seen from `self`. */
export function devUrl(target: DevAppId, self: DevAppId, env: DevEnv = process.env): string {
  return devUrls(self, env)[target];
}

/**
 * The WebAuthn Relying Party ID for the local devloop.
 *
 * An rpId has to be the origin's host or a registrable suffix of it, and a
 * passkey created under one rpId is invisible under another. `@osn/social`
 * (`musubi.localhost`) creates the passkey and `@osn/api` (`id.musubi.localhost`)
 * verifies it, so the rpId must cover both: `musubi.localhost`, the shared
 * parent. This is exactly why the account apps nest under a common `musubi`
 * label instead of sitting side by side as `musubi` and `osn-api`.
 *
 * The worktree prefix is a *leading* label, so it drops out of the suffix and
 * one rpId covers every worktree. Off portless this is plain `localhost`, which
 * is what every app was already using.
 */
export function devRpId(self: DevAppId, env: DevEnv = process.env): string {
  const address = env.PORTLESS_URL ? splitHost(env.PORTLESS_URL, DEV_APPS[self].name) : null;
  if (!address) return "localhost";
  // The root label of the account family — the last label of `@osn/social`'s
  // name, which every `*.musubi` app shares.
  const root = DEV_APPS["@osn/social"].name.split(".").pop();
  return `${root}.${address.tld}`;
}

/**
 * The port a dev server should listen on: the one portless assigned, or the
 * app's own fixed port when the devloop runs without it.
 *
 * Every `astro.config.mjs` / `vite.config.ts` in the repo calls this, so the
 * coercion lives in one tested place rather than eight copies. A `PORT` that is
 * not a usable port number (empty, `0`, non-numeric, out of range) falls back
 * rather than binding somewhere nobody is proxying to.
 */
export function devPort(fallback: number, env: DevEnv = process.env): number {
  const port = Number(env.PORT);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : fallback;
}

/** Comma-joined origins, the format every `*_ORIGIN` / `*_CORS_ORIGIN` var in this repo takes. */
export function devOriginList(
  targets: readonly DevAppId[],
  self: DevAppId,
  env: DevEnv = process.env,
): string {
  const urls = devUrls(self, env);
  return targets.map((id) => urls[id]).join(",");
}
