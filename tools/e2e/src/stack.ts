/**
 * The stack the flows run against: which apps boot, in what order, with what
 * environment, and how the launcher knows each one is ready.
 *
 * The frontends run their own package's `dev:app` script, exactly what
 * `PORTLESS=0 bun run dev` runs, except Musubi, which runs as it deploys: built,
 * and served with its `_headers` (below). The APIs run their `src/local.ts` entry — what
 * `dev:app` runs, minus `--watch` — directly, because the clock preload and
 * `--no-env-file` are Bun flags, and `BUN_OPTIONS` breaks `bun run <script>`.
 * `dev-env` adds nothing without `PORTLESS_URL`, so every sibling origin is set
 * here explicitly.
 */

import { resolve } from "node:path";

import {
  CHANGE_NOTICE_SECRET,
  CHANGE_NOTICES_FILE,
  CIRE_INTERNAL_REVOKE_SECRET,
  CIRE_OIDC,
  CIRE_RSVP_DEADLINE,
  CLOCK_T0,
  DB_FILES,
  DEV_LOGIN_SECRET,
  E2E_RESEND_KEY,
  INTERNAL_SERVICE_SECRET,
  ORIGINS,
  OSN_ARC_KID_SECRET,
  PORTS,
  PULSE_OIDC,
  REPO_ROOT,
  TURNSTILE_TEST_SITEKEY,
  STRIPE_CONNECT_WEBHOOK_SECRET,
  STRIPE_PLATFORM_WEBHOOK_SECRET,
  type AppName,
} from "./config";
import type { CireArcKey } from "./seed";
import { STRIPE_STANDIN_GOLD_PRICE } from "./stripe";

export const CLOCK_MODULE = resolve(import.meta.dirname, "clock.mjs");

/** The repository's Wrangler, which serves Musubi's build. */
const WRANGLER = resolve(REPO_ROOT, "node_modules/.bin/wrangler");

/** Where Wrangler finds Musubi's build and how it serves it. */
export const MUSUBI_WRANGLER_CONFIG = resolve(
  import.meta.dirname,
  "../musubi-social.wrangler.jsonc",
);

/** `@cire/vendor`'s dev origin (`DEV_APPS`). Not booted; cire-api is told it. */
export const VENDOR_PORTAL_ORIGIN = "http://localhost:4326";

/**
 * The only variables a child inherits from the shell that starts the suite.
 * Everything else (a developer's `OSN_DATABASE_URL`, `OSN_ENV`, Turnstile keys,
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
  /** Run to completion, in `dir` with `env`, before `command` starts; a failure stops the run. */
  readonly build?: readonly string[];
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

/**
 * Where every API listens, as the stand-ins do: the secrets the stack hands
 * the APIs are committed placeholders, so no other machine may reach them.
 * Clients still name `localhost`, which reaches it.
 */
const API_HOSTNAME = "127.0.0.1";

/** The Stripe key both cire-apis hold. Not a real key: it only ever reaches the stand-in. */
const CIRE_STRIPE_KEY = "e2e-placeholder-no-stripe-account";

/** cire-api's three site origins, in the order `local.ts` reads them. */
const CIRE_WEB_ORIGINS = [ORIGINS.cireInvites, ORIGINS.cireHost, VENDOR_PORTAL_ORIGIN].join(",");

/**
 * What cire-api holds in the run against Stripe's test mode
 * (`src/stripe-test-mode-launcher.ts`) in place of the stand-in's settings: the
 * sandbox's test key and the signing secret `stripe listen` printed.
 */
export interface StripeTestModeSettings {
  readonly secretKey: string;
  readonly webhookSecret: string;
}

/**
 * cire-api's Stripe settings. On the stand-in: a placeholder key, the
 * stand-in's URLs, both webhook secrets, a Connect client id and a Gold Price.
 * In test mode: the test key and the listen secret alone, so every call goes to
 * Stripe and only the Connect webhook is mounted; no Gold Price or platform
 * webhook, since the run buys no upgrade, and no Connect client id, since it
 * connects no account.
 */
function cireStripeEnv(testMode: StripeTestModeSettings | undefined): AppSpec["env"] {
  if (testMode !== undefined) {
    return { STRIPE_SECRET_KEY: testMode.secretKey, STRIPE_WEBHOOK_SECRET: testMode.webhookSecret };
  }
  return {
    // A Stripe key and the Connect webhook's secret: guests may give
    // money, and a gift is recorded when the signed event the flow
    // delivers arrives. The key only ever reaches the Stripe stand-in
    // (`src/stripe.ts`), which every Stripe call goes to: the OAuth
    // connect, a guest's gift (`cire-registry-money`), and an upgrade's
    // Checkout and refund (`cire-checklist-starter`).
    STRIPE_SECRET_KEY: CIRE_STRIPE_KEY,
    STRIPE_API_URL: ORIGINS.stripe,
    STRIPE_CONNECT_URL: ORIGINS.stripe,
    STRIPE_WEBHOOK_SECRET: STRIPE_CONNECT_WEBHOOK_SECRET,
    // A client id of the right shape, which only the stand-in ever sees:
    // with it and CIRE_API_ORIGIN, the portal offers "Connect a Stripe
    // account you already have".
    STRIPE_CONNECT_CLIENT_ID: "ca_e2eStandIn",
    // A Gold Price and the platform webhook's secret: the stack sells Gold,
    // and grants it when the signed `checkout.session.completed` the flow
    // delivers arrives. No Crimson Price, so nothing sells Crimson.
    STRIPE_UPGRADE_PRICE_GOLD: STRIPE_STANDIN_GOLD_PRICE.id,
    STRIPE_PLATFORM_WEBHOOK_SECRET,
  };
}

/**
 * Boot order matters: pulse-api registers its service key with osn-api once, at
 * start. `cireArc` is cire-api's ARC key, which `seedOsn` registered with
 * osn-api; without it cire-api finds no owner's address and mails no owner.
 * `stripeTestMode` replaces cire-api's Stripe settings (`cireStripeEnv`).
 */
export function appSpecs(cireArc?: CireArcKey, stripeTestMode?: StripeTestModeSettings): AppSpec[] {
  // cire-api's way to the owners' addresses: osn-api, over ARC, with the key
  // `seedOsn` registered. None without the key.
  const ownerAddresses: Record<string, string> = {};
  if (cireArc) {
    ownerAddresses.OSN_API_URL = ORIGINS.osnApi;
    ownerAddresses.CIRE_API_ARC_KEY_ID = cireArc.keyId;
    ownerAddresses.CIRE_API_ARC_PRIVATE_KEY = cireArc.privateJwk;
  }
  return [
    {
      name: "osnApi",
      dir: "osn/api",
      command: API_COMMAND,
      readyUrl: `${ORIGINS.osnApi}/.well-known/jwks.json`,
      env: {
        PORT: String(PORTS.osnApi),
        OSN_LOCAL_HOSTNAME: API_HOSTNAME,
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
        // Keys a MAC on its ARC key ids; Pulse and cire check it.
        OSN_ARC_KID_SECRET,
        PULSE_API_URL: ORIGINS.pulseApi,
        RESEND_API_KEY: E2E_RESEND_KEY,
        RESEND_API_URL: ORIGINS.mail,
        OSN_EMAIL_FROM: "Musubi <no-reply@e2e.test>",
        // `musubi-change-notice` sends a notice of the suite's own to every
        // account this osn-api holds.
        OSN_CHANGE_NOTICE_SECRET: CHANGE_NOTICE_SECRET,
        OSN_CHANGE_NOTICES_FILE: CHANGE_NOTICES_FILE,
        // The organiser signs in to cire's portal as the dev principal, which
        // owns cire's sample wedding, and is sent back to the portal after.
        DEV_LOGIN_SECRET,
        DEV_LOGIN_RETURN_ORIGINS: ORIGINS.cireHost,
        // Sign out everywhere else, revoking cire's connection and an
        // account's deletion end its cire organiser sessions through this
        // cire-api, and the deletion's preview and erasure reach it here.
        CIRE_API_URL: ORIGINS.cireApi,
        CIRE_INTERNAL_REVOKE_SECRET,
        CIRE_OIDC_CLIENT_ID: CIRE_OIDC.clientId,
        // cire's organiser portal: where a confirmed cire step-up request
        // returns, and the origin cire's manage-your-data link may sit on.
        CIRE_ORGANISER_ORIGIN: ORIGINS.cireHost,
        // `musubi-account-deletion` moves its deletion job past its window
        // and waits for the sweeps (`osn/api/src/local.ts`): every 2 s here,
        // not 6 h. A pass finds nothing to do unless a job is due, and no
        // other flow writes one.
        OSN_DELETION_SWEEPER_INTERVAL_MS: "2000",
        // Keeps the client address a request sends, so `musubi-account-deletion`
        // (`callOsnApiFrom`) spends its own limiter windows.
        OSN_E2E_CLIENT_ADDRESS: "1",
      },
    },
    {
      // A second osn-api that takes browser Email Verification API tokens,
      // with its own database and limiter windows. Musubi reaches it only in
      // the flows that call `throughEmailVerificationApi`. Its verifier
      // resolves and fetches through the issuer stand-in (`src/issuer.ts`);
      // its mail goes to the same Resend stand-in as the first's.
      name: "osnApiEvt",
      dir: "osn/api",
      command: API_COMMAND,
      readyUrl: `${ORIGINS.osnApiEvt}/.well-known/jwks.json`,
      env: {
        PORT: String(PORTS.osnApiEvt),
        OSN_LOCAL_HOSTNAME: API_HOSTNAME,
        OSN_ENV: "local",
        OSN_DATABASE_URL: DB_FILES.osnEvt,
        OSN_ISSUER_URL: ORIGINS.osnApiEvt,
        OSN_RP_ID: "localhost",
        OSN_RP_NAME: "Musubi",
        // Musubi first: the token's audience is the first origin's.
        OSN_ORIGIN: ORIGINS.musubi,
        OSN_CORS_ORIGIN: ORIGINS.musubi,
        INTERNAL_SERVICE_SECRET,
        RESEND_API_KEY: E2E_RESEND_KEY,
        RESEND_API_URL: ORIGINS.mail,
        OSN_EMAIL_FROM: "Musubi <no-reply@e2e.test>",
        OSN_EMAIL_VERIFICATION_API: "on",
        OSN_EMAIL_VERIFICATION_EMULATOR_URL: `http://127.0.0.1:${PORTS.issuer}`,
      },
    },
    {
      name: "pulseApi",
      dir: "pulse/api",
      command: API_COMMAND,
      readyUrl: `${ORIGINS.pulseApi}/`,
      env: {
        PORT: String(PORTS.pulseApi),
        PULSE_LOCAL_HOSTNAME: API_HOSTNAME,
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
        OSN_ARC_KID_SECRET,
      },
    },
    {
      name: "cireApi",
      dir: "cire/api",
      command: API_COMMAND,
      readyUrl: `${ORIGINS.cireApi}/`,
      env: {
        PORT: String(PORTS.cireApi),
        CIRE_LOCAL_HOSTNAME: API_HOSTNAME,
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
        WEB_ORIGIN: CIRE_WEB_ORIGINS,
        // Organiser sign-in through osn-api, as a first-party client.
        OSN_ISSUER_URL: ORIGINS.osnApi,
        OSN_JWKS_URL: `${ORIGINS.osnApi}/.well-known/jwks.json`,
        CIRE_API_ORIGIN: ORIGINS.cireApi,
        CIRE_OIDC_CLIENT_ID: CIRE_OIDC.clientId,
        CIRE_OIDC_CLIENT_SECRET: CIRE_OIDC.secret,
        ...cireStripeEnv(stripeTestMode),
        // Owner notices (an automatic refund's among them): mail to the
        // stand-in, and each owner's address from osn-api over ARC.
        RESEND_API_KEY: E2E_RESEND_KEY,
        RESEND_API_URL: ORIGINS.mail,
        ...ownerAddresses,
        // What osn-api presents to end organiser sessions; the same value as its own.
        CIRE_INTERNAL_REVOKE_SECRET,
        // osn-api's ARC key ids are checked under it before any key fetch.
        OSN_ARC_KID_SECRET,
      },
    },
    {
      // A second cire-api with the Stripe key and no Connect webhook secret:
      // a deployment that could open a gift's payment page but never record
      // the gift, so it must offer guests no money at all. Its own database,
      // seeded with the gift-list wedding, and its own limiter windows. The
      // browser reaches it only in the flows that call `throughKeyOnlyCireApi`
      // (`cire-registry-claimed`, `cire-registry-preview`), which check that
      // it offers none. Nothing else: no organiser sign-in, owner mail or
      // client address, which neither flow needs.
      name: "cireApiKeyOnly",
      dir: "cire/api",
      command: API_COMMAND,
      readyUrl: `${ORIGINS.cireApiKeyOnly}/`,
      env: {
        PORT: String(PORTS.cireApiKeyOnly),
        CIRE_LOCAL_HOSTNAME: API_HOSTNAME,
        CIRE_LOCAL_DB_PATH: DB_FILES.cireKeyOnly,
        CIRE_E2E_REGISTRY: "1",
        WEB_ORIGIN: CIRE_WEB_ORIGINS,
        STRIPE_SECRET_KEY: CIRE_STRIPE_KEY,
        STRIPE_API_URL: ORIGINS.stripe,
        STRIPE_CONNECT_URL: ORIGINS.stripe,
      },
    },
    {
      // Built, then served by Wrangler's asset server with the build's
      // `_headers` applied, as the deployed Worker serves it: every Musubi
      // page in the flows runs under the Content-Security-Policy that ships.
      // The dev server sends no such header. The build carries Turnstile's
      // test sitekey, so the sign-in and registration forms load the widget as
      // the deployed tiers do; osn-api holds no secret and checks nothing, as
      // on dev, and the fixtures stand in for Turnstile at its real URLs.
      // `--inspector-port 0`: workerd binds the devtools socket on a port the
      // kernel picks at bind time. Left unset, Wrangler picks the first free
      // port from 9229 and binds it later, and cire invites' `astro dev` picks
      // from 9229 the same way, so the two can pick one port and Musubi exits
      // with `Address already in use (socket "direct:1:default")`.
      name: "musubi",
      dir: "musubi/social",
      build: ["bun", "run", "build"],
      command: [
        WRANGLER,
        "dev",
        "--config",
        MUSUBI_WRANGLER_CONFIG,
        "--port",
        String(PORTS.musubi),
        "--ip",
        "localhost",
        "--inspector-port",
        "0",
        "--show-interactive-dev-session=false",
      ],
      readyUrl: `${ORIGINS.musubi}/`,
      env: {
        VITE_OSN_ISSUER_URL: ORIGINS.osnApi,
        VITE_TURNSTILE_SITEKEY: TURNSTILE_TEST_SITEKEY,
      },
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
        // Where "Remove my Cire data" sends the person to confirm: this
        // stack's Musubi.
        PUBLIC_OSN_ACCOUNT_URL: ORIGINS.musubi,
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
