/**
 * What each app needs to know about the others in the local devloop.
 *
 * Split out of `cli.ts` so it can be tested without spawning anything: the CLI
 * is a thin process wrapper, and everything worth asserting is here.
 *
 * Every variable below is one an app already reads, with the same name the
 * deployed tiers set from `wrangler.toml`. This is only the local answer, and
 * only when the devloop runs behind portless.
 */
import { DEV_APPS, devOriginList, devRpId, devUrls, type DevAppId, type DevEnv } from "./index";

type Urls = Record<DevAppId, string>;

/**
 * Keyed by package name; each entry returns the env vars that app needs.
 *
 * When adding a variable here, check the consumer actually reads that exact
 * name — every one of them has a `?? "http://localhost:<port>"` default, so a
 * typo does not throw, it just leaves that one hop pointing at a dead port.
 */
export const DEV_ENV = {
  "@osn/api": (urls: Urls, self: DevAppId, env: DevEnv) => {
    // Browsers that fetch this Worker with credentials. The same list feeds the
    // CSRF origin guard, so it stays as tight as the deployed one.
    const browsers = devOriginList(
      ["@osn/social", "@pulse/web", "@cire/invites", "@cire/host", "@cire/vendor"],
      self,
      env,
    );
    return {
      OSN_ISSUER_URL: urls["@osn/api"],
      // Passkeys are created on `musubi.*` and verified here on `id.musubi.*`,
      // so the RP ID has to be the parent both share. See `devRpId`.
      OSN_RP_ID: devRpId(self, env),
      OSN_ORIGIN: browsers,
      OSN_CORS_ORIGIN: browsers,
      // Redirect targets for `GET /dev/login?return_to=…`. Its own list, kept
      // separate from the CORS one exactly as in `wrangler.toml`.
      DEV_LOGIN_RETURN_ORIGINS: devOriginList(
        ["@osn/social", "@cire/host", "@cire/vendor", "@cire/invites"],
        self,
        env,
      ),
      // Server-to-server, for account export and erasure fan-out.
      PULSE_API_URL: urls["@pulse/api"],
      ZAP_API_URL: urls["@zap/api"],
    };
  },
  "@cire/api": (urls: Urls, self: DevAppId, env: DevEnv) => ({
    WEB_ORIGIN: devOriginList(["@cire/invites", "@cire/host", "@cire/vendor"], self, env),
    OSN_ISSUER_URL: urls["@osn/api"],
    OSN_JWKS_URL: `${urls["@osn/api"]}/.well-known/jwks.json`,
    // Builds the organiser sign-in redirect URI, which has to match the one
    // registered with the OSN client.
    CIRE_API_ORIGIN: urls["@cire/api"],
    ZAP_API_URL: urls["@zap/api"],
  }),
  "@pulse/api": (urls: Urls, _self: DevAppId, _env: DevEnv) => ({
    OSN_ISSUER_URL: urls["@osn/api"],
    OSN_JWKS_URL: `${urls["@osn/api"]}/.well-known/jwks.json`,
    // Not the same var as the issuer: `lib/osn-bridge.ts` and
    // `lib/outbound-arc.ts` call osn-api server-to-server through `OSN_API_URL`
    // (step-up verify, app-enrollment join/leave, ARC key registration).
    OSN_API_URL: urls["@osn/api"],
    PULSE_API_ORIGIN: urls["@pulse/api"],
    PULSE_CORS_ORIGIN: urls["@pulse/web"],
    // Where an unauthenticated request is sent back to sign in.
    PULSE_LOGIN_URL: `${urls["@pulse/web"]}/`,
  }),
  "@zap/api": (urls: Urls, self: DevAppId, env: DevEnv) => ({
    // Zap's graph bridge calls osn-api server-to-server.
    OSN_API_URL: urls["@osn/api"],
    // Browsers that reach zap directly: pulse event chats, and the account app.
    ZAP_CORS_ORIGIN: devOriginList(["@pulse/web", "@osn/social"], self, env),
  }),
  "@osn/social": (urls: Urls, _self: DevAppId, _env: DevEnv) => ({
    VITE_OSN_ISSUER_URL: urls["@osn/api"],
  }),
  "@osn/landing": (urls: Urls, _self: DevAppId, _env: DevEnv) => ({
    PUBLIC_APP_URL: urls["@osn/social"],
  }),
  "@pulse/web": (urls: Urls, _self: DevAppId, _env: DevEnv) => ({
    VITE_API_URL: urls["@pulse/api"],
    VITE_OSN_ISSUER_URL: urls["@osn/api"],
  }),
  "@pulse/landing": (urls: Urls, _self: DevAppId, _env: DevEnv) => ({
    PUBLIC_APP_URL: urls["@pulse/web"],
  }),
  "@cire/invites": (urls: Urls, _self: DevAppId, _env: DevEnv) => ({
    PUBLIC_API_URL: urls["@cire/api"],
    PUBLIC_MARKETING_URL: urls["@cire/landing"],
    PUBLIC_SITE_URL: urls["@cire/invites"],
  }),
  "@cire/host": (urls: Urls, _self: DevAppId, _env: DevEnv) => ({
    PUBLIC_API_URL: urls["@cire/api"],
    PUBLIC_CIRE_API_URL: urls["@cire/api"],
    PUBLIC_CIRE_WEB_URL: urls["@cire/invites"],
    PUBLIC_OSN_ACCOUNT_URL: urls["@osn/social"],
  }),
  "@cire/vendor": (urls: Urls, _self: DevAppId, _env: DevEnv) => ({
    PUBLIC_API_URL: urls["@cire/api"],
    PUBLIC_CIRE_API_URL: urls["@cire/api"],
    PUBLIC_OSN_ACCOUNT_URL: urls["@osn/social"],
  }),
  "@cire/landing": (urls: Urls, _self: DevAppId, _env: DevEnv) => ({
    PUBLIC_ORGANISER_URL: urls["@cire/host"],
    PUBLIC_DEMO_INVITE_URL: urls["@cire/invites"],
  }),
} satisfies Record<DevAppId, (urls: Urls, self: DevAppId, env: DevEnv) => Record<string, string>>;

/**
 * The env vars to add for `self`, or `{}` when the devloop is not behind
 * portless — there is no `PORTLESS_URL` then, and every app keeps the fixed
 * localhost defaults it had before.
 */
export function buildDevEnv(self: DevAppId, env: DevEnv = process.env): Record<string, string> {
  if (!env.PORTLESS_URL) return {};
  return DEV_ENV[self](devUrls(self, env), self, env);
}

/**
 * Map a package name to its `DEV_APPS` key.
 *
 * Throws rather than guessing: a package the launcher does not know is one
 * whose siblings it cannot address, and falling through silently would give a
 * dev server that boots and then talks to dead origins.
 */
export function resolveSelfId(packageName: string | undefined): DevAppId {
  if (!packageName || !(packageName in DEV_APPS)) {
    throw new Error(
      `dev-env: ${packageName || "this package"} is not in DEV_APPS (shared/dev-urls/src/index.ts). Add it there, in that package's "portless" key, and in DEV_ENV (src/app-env.ts).`,
    );
  }
  return packageName as DevAppId;
}
