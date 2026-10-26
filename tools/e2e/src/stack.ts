/**
 * The stack the flows run against: which apps boot, in what order, with what
 * environment, and how the launcher knows each one is ready.
 *
 * The frontends run their own package's `dev:app` script, exactly what
 * `PORTLESS=0 bun run dev` runs. The APIs run their `src/local.ts` entry — what
 * `dev:app` runs, minus `--watch` — directly, because the clock preload and
 * `--no-env-file` are Bun flags, and `BUN_OPTIONS` breaks `bun run <script>`.
 * `dev-env` adds nothing without `PORTLESS_URL`, so every sibling origin is set
 * here explicitly.
 */

import { resolve } from "node:path";

import {
  CIRE_INTERNAL_REVOKE_SECRET,
  CIRE_OIDC,
  CIRE_RSVP_DEADLINE,
  CLOCK_T0,
  DB_FILES,
  DEV_LOGIN_SECRET,
  E2E_RESEND_KEY,
  INTERNAL_SERVICE_SECRET,
  ORIGINS,
  PORTS,
  PULSE_OIDC,
  REPO_ROOT,
  type AppName,
} from "./config";

export const CLOCK_MODULE = resolve(import.meta.dirname, "clock.mjs");

/** `@cire/vendor`'s dev origin (`DEV_APPS`). Not booted; cire-api is told it. */
export const VENDOR_PORTAL_ORIGIN = "http://localhost:4326";

/**
 * The only variables a child inherits from the shell that starts the suite.
 * Everything else (a developer's `REDIS_URL`, `OSN_ENV`, Turnstile keys,
 * `NODE_ENV=test`, an agent marker that sends `astro dev` to the background)
 * stays out, so a run on a laptop and a run in CI see the same environment.
 */
export const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  "BUN_INSTALL",
  "CI",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
] as const;

/** An API's `src/local.ts`, on the suite clock, ignoring the package's `.env` files. */
export const API_COMMAND = [
  "bun",
  "--no-env-file",
  "--preload",
  CLOCK_MODULE,
  "src/local.ts",
] as const;

export interface AppSpec {
  readonly name: AppName;
  /** Package directory, relative to the repository root. */
  readonly dir: string;
  readonly command: readonly string[];
  /** Polled until it answers with any status below 500: the server is listening and serving. */
  readonly readyUrl: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The environment a child process starts with. */
export interface ChildEnv {
  [name: string]: string;
}

/** Variables every child gets: the shared clock and no CAPTCHA. */
export function baseEnv(
  shell: Readonly<Record<string, string | undefined>>,
  realStart: number,
): ChildEnv {
  const env: ChildEnv = {};
  for (const key of INHERITED_ENV) {
    const value = shell[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    PORTLESS: "0",
    E2E_CLOCK_T0: String(CLOCK_T0),
    E2E_CLOCK_R0: String(realStart),
    NODE_OPTIONS: `--import ${CLOCK_MODULE}`,
    // Astro moves `astro dev` into the background when it thinks an agent
    // started it, and the launcher would then lose the process it waits on.
    ASTRO_DEV_BACKGROUND: "1",
    // No calls home from the dev servers: telemetry is noise in CI and a
    // proxy refusal in sandboxed environments.
    ASTRO_TELEMETRY_DISABLED: "1",
    WRANGLER_SEND_METRICS: "false",
    // Nothing here may ask for a CAPTCHA.
    TURNSTILE_SECRET_KEY: "",
    VITE_TURNSTILE_SITEKEY: "",
    PUBLIC_TURNSTILE_SITEKEY: "",
  };
}

/** Boot order matters: pulse-api registers its service key with osn-api once, at start. */
export function appSpecs(): AppSpec[] {
  return [
    {
      name: "osnApi",
      dir: "osn/api",
      command: API_COMMAND,
      readyUrl: `${ORIGINS.osnApi}/.well-known/jwks.json`,
      env: {
        PORT: String(PORTS.osnApi),
        OSN_ENV: "local",
        OSN_DATABASE_URL: DB_FILES.osn,
        OSN_ISSUER_URL: ORIGINS.osnApi,
        OSN_RP_ID: "localhost",
        OSN_RP_NAME: "Musubi",
        // Musubi first: an /authorize request that needs the user goes to the
        // first origin's /authorize page.
        OSN_ORIGIN: [ORIGINS.musubi, ORIGINS.pulseWeb].join(","),
        OSN_CORS_ORIGIN: [ORIGINS.musubi, ORIGINS.pulseWeb].join(","),
        INTERNAL_SERVICE_SECRET,
        PULSE_API_URL: ORIGINS.pulseApi,
        RESEND_API_KEY: E2E_RESEND_KEY,
        RESEND_API_URL: ORIGINS.mail,
        OSN_EMAIL_FROM: "Musubi <no-reply@e2e.test>",
        // The organiser signs in to cire's portal as the dev principal, which
        // owns cire's sample wedding, and is sent back to the portal after.
        DEV_LOGIN_SECRET,
        DEV_LOGIN_RETURN_ORIGINS: ORIGINS.cireHost,
        // Sign out everywhere else, and revoking cire's connection, end the
        // account's cire organiser sessions through this cire-api.
        CIRE_INTERNAL_REVOKE_URL: ORIGINS.cireApi,
        CIRE_INTERNAL_REVOKE_SECRET,
        CIRE_OIDC_CLIENT_ID: CIRE_OIDC.clientId,
      },
    },
    {
      name: "pulseApi",
      dir: "pulse/api",
      command: API_COMMAND,
      readyUrl: `${ORIGINS.pulseApi}/`,
      env: {
        PORT: String(PORTS.pulseApi),
        OSN_ENV: "local",
        PULSE_DATABASE_URL: DB_FILES.pulse,
        OSN_API_URL: ORIGINS.osnApi,
        OSN_ISSUER_URL: ORIGINS.osnApi,
        OSN_JWKS_URL: `${ORIGINS.osnApi}/.well-known/jwks.json`,
        PULSE_API_ORIGIN: ORIGINS.pulseApi,
        PULSE_CORS_ORIGIN: ORIGINS.pulseWeb,
        PULSE_LOGIN_URL: ORIGINS.pulseWeb,
        OSN_OIDC_CLIENT_ID: PULSE_OIDC.clientId,
        OSN_OIDC_CLIENT_SECRET: PULSE_OIDC.secret,
        INTERNAL_SERVICE_SECRET,
      },
    },
    {
      name: "cireApi",
      dir: "cire/api",
      command: API_COMMAND,
      readyUrl: `${ORIGINS.cireApi}/`,
      env: {
        PORT: String(PORTS.cireApi),
        CIRE_LOCAL_DB_PATH: DB_FILES.cire,
        CIRE_E2E_RSVP_DEADLINE: CIRE_RSVP_DEADLINE,
        // Adds the gift-list wedding (`CIRE_GIFT_LIST`) to cire-api's seed.
        CIRE_E2E_REGISTRY: "1",
        // Keeps the client address a request sends, so the organiser's claim
        // (`claimFromOrganiserAddress`) spends its own limiter window.
        CIRE_E2E_CLIENT_ADDRESS: "1",
        // Adds the organiser weddings (`CIRE_ORGANISER`) to cire-api's seed.
        CIRE_E2E_ORGANISER: "1",
        // Guest site, organiser portal, vendor portal — the order `local.ts`
        // reads them in. The vendor portal is not in the stack; naming its
        // dev origin keeps cire-api from minting production vendor links.
        WEB_ORIGIN: [ORIGINS.cireInvites, ORIGINS.cireHost, VENDOR_PORTAL_ORIGIN].join(","),
        // Organiser sign-in through osn-api, as a first-party client.
        OSN_ISSUER_URL: ORIGINS.osnApi,
        OSN_JWKS_URL: `${ORIGINS.osnApi}/.well-known/jwks.json`,
        CIRE_API_ORIGIN: ORIGINS.cireApi,
        CIRE_OIDC_CLIENT_ID: CIRE_OIDC.clientId,
        CIRE_OIDC_CLIENT_SECRET: CIRE_OIDC.secret,
        // A Stripe key and no Connect webhook secret: a deployment that could
        // open a payment page but never record the gift, so cire-api must offer
        // guests no money at all. The gift-list flows check that it does not.
        // Not a real key, and nothing in a flow sends it anywhere: no flow
        // reaches a route that calls Stripe.
        STRIPE_SECRET_KEY: "e2e-placeholder-no-stripe-account",
        // What osn-api presents to end organiser sessions; the same value as its own.
        CIRE_INTERNAL_REVOKE_SECRET,
      },
    },
    {
      name: "musubi",
      dir: "musubi/social",
      command: ["bun", "run", "dev:app"],
      readyUrl: `${ORIGINS.musubi}/`,
      env: { PORT: String(PORTS.musubi), VITE_OSN_ISSUER_URL: ORIGINS.osnApi },
    },
    {
      name: "pulseWeb",
      dir: "pulse/web",
      command: ["bun", "run", "dev:app"],
      readyUrl: `${ORIGINS.pulseWeb}/`,
      env: {
        PORT: String(PORTS.pulseWeb),
        VITE_API_URL: ORIGINS.pulseApi,
        VITE_OSN_ISSUER_URL: ORIGINS.osnApi,
      },
    },
    {
      name: "cireInvites",
      dir: "cire/invites",
      // One `astro dev` per package directory unless told otherwise; the
      // port preflight already guarantees this one owns its port.
      command: ["bun", "run", "dev:app", "--ignore-lock"],
      readyUrl: `${ORIGINS.cireInvites}/`,
      env: { PORT: String(PORTS.cireInvites), PUBLIC_API_URL: ORIGINS.cireApi },
    },
    {
      // The organiser portal. Like cire landing, its font pipeline fetches
      // Google Fonts when `astro dev` starts, and serves fallback faces when
      // there is no network.
      name: "cireHost",
      dir: "cire/host",
      command: ["bun", "run", "dev:app", "--ignore-lock"],
      readyUrl: `${ORIGINS.cireHost}/login`,
      env: {
        PORT: String(PORTS.cireHost),
        PUBLIC_CIRE_API_URL: ORIGINS.cireApi,
        PUBLIC_CIRE_WEB_URL: ORIGINS.cireInvites,
        PUBLIC_MARKETING_URL: ORIGINS.cireLanding,
      },
    },
    {
      // cireweddings.com: static, no API. Its font pipeline fetches Google
      // Fonts when `astro dev` starts; with no network it warns and serves
      // fallback faces rather than failing to start.
      name: "cireLanding",
      dir: "cire/landing",
      command: ["bun", "run", "dev:app", "--ignore-lock"],
      readyUrl: `${ORIGINS.cireLanding}/privacy`,
      env: { PORT: String(PORTS.cireLanding) },
    },
  ];
}

export function appDir(spec: AppSpec): string {
  return resolve(REPO_ROOT, spec.dir);
}
