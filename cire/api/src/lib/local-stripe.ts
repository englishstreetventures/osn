/**
 * Where the local dev server sends Stripe calls when a stand-in answers them:
 * `STRIPE_API_URL` for the API host, `STRIPE_CONNECT_URL` for Connect's OAuth
 * token and deauthorize calls. The E2E suite sets both, to its own stand-in.
 *
 * Read by `src/local.ts` alone. Every call carries the platform's secret key,
 * so each must be a loopback origin and nothing else; anything else stops the
 * server rather than sending the key somewhere. The Worker never reads either,
 * and the secret inventory forbids both on every deployed tier. A refusal names
 * the variable, never its value.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function loopbackOrigin(name: string, raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL; it may only name a local Stripe stand-in`);
  }
  const bare = url.pathname === "/" && url.search === "" && url.hash === "";
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    !bare
  ) {
    throw new Error(`${name} must be a loopback origin (a local Stripe stand-in) and nothing else`);
  }
  return url.origin;
}

/** The stand-in's origins, each present only when its variable is set. */
export interface LocalStripeOrigins {
  apiBase?: string;
  connectBase?: string;
}

export function localStripeOrigins(env: {
  readonly STRIPE_API_URL?: string;
  readonly STRIPE_CONNECT_URL?: string;
}): LocalStripeOrigins {
  const origins: LocalStripeOrigins = {};
  const apiBase = loopbackOrigin("STRIPE_API_URL", env.STRIPE_API_URL);
  if (apiBase !== undefined) origins.apiBase = apiBase;
  const connectBase = loopbackOrigin("STRIPE_CONNECT_URL", env.STRIPE_CONNECT_URL);
  if (connectBase !== undefined) origins.connectBase = connectBase;
  return origins;
}
