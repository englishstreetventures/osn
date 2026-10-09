import { makeResendEmailLive } from "@shared/email";
import { Effect } from "effect";

import { createApp } from "./app";
import { createDb, repointDevOwnerSeat, seedDb } from "./db/setup";
import { localResendConfig } from "./lib/resend-email";
import { siteOriginOptions } from "./lib/web-origin";
import { runCireSync } from "./observability";
import { createAssetsStub } from "./services/invite-assets";
import { createR2Stub } from "./services/r2-imports";
import { createStripeClientFromEnv } from "./services/stripe";

const db = createDb(":memory:");
await seedDb(db);

// Dev convenience: the in-memory seed gives the sample wedding's owner seat to
// the fixed local dev id (usr_dev_bootstrap_owner — see DEV_OWNER_PROFILE_ID in
// db/setup), so the organiser dashboard lists nothing for a real signed-in
// account. Re-point that seat at your OSN profile id via env so the wedding
// shows up. Find yours in osn.db: SELECT id FROM users WHERE handle=...  (this
// is a post-seed override for the running local server; deployed tiers never
// run this seed.) `repointDevOwnerSeat` says what the profile holds afterwards.
const devOwner = process.env.CIRE_DEV_OWNER_PROFILE_ID;
if (devOwner) {
  repointDevOwnerSeat(db, devOwner);
  runCireSync(
    Effect.logInfo("dev: bootstrap wedding owner seat repointed", { osnProfileId: devOwner }),
  );
}

const origins = (process.env.WEB_ORIGIN ?? "http://localhost:4321,http://localhost:4322")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const port = Number(process.env.PORT ?? 8787);

const r2 = createR2Stub();
const assets = createAssetsStub();

// Stripe, key-optional exactly as the Worker is (see index.ts): no
// `STRIPE_SECRET_KEY` and the organiser Connect routes are not mounted, no
// `STRIPE_WEBHOOK_SECRET` and `/api/stripe/webhook` does not exist. Both come
// from the shell, never from a committed file — the webhook secret in
// particular is whatever `stripe listen` prints for THIS session:
//
//   stripe listen --forward-connect-to localhost:8787/api/stripe/webhook \
//                 --forward-to         localhost:8787/api/stripe/platform-webhook
//   STRIPE_WEBHOOK_SECRET=whsec_… STRIPE_PLATFORM_WEBHOOK_SECRET=whsec_… \
//     bun run --cwd cire/api dev:app
//
// BOTH forwarders, because there are two endpoints and they hear about
// different things. `--forward-connect-to` carries the gift events: those
// happen on the couple's connected account and the handler reads
// `event.account`. `--forward-to` carries the platform's own — an upgrade
// purchase, where cire is the merchant — and that endpoint requires
// `event.account` to be ABSENT.
//
// One `stripe listen` prints ONE signing secret for everything it forwards, so
// locally both variables carry the SAME value. Deployed tiers have two
// dashboard endpoints and therefore two different secrets; that difference is
// what the wrong-secret test pins, and it is a deployed property, not a local
// one.
const stripe = createStripeClientFromEnv({ STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY });

// The guest, organiser and vendor origins come from WEB_ORIGIN's three
// entries, read as the Worker reads them. Without the organiser and vendor
// entries `createApp` falls back to its PRODUCTION defaults, so every Stripe
// return URL and vendor claim link minted in local dev would point at the live
// portals, and the CSP collector would label local portal reports `other`.
const appOptions: Parameters<typeof createApp>[1] = {
  ...siteOriginOptions(origins),
  allowedOrigins: origins,
  r2,
  assets,
  osnJwksUrl: process.env.OSN_JWKS_URL,
  osnIssuerUrl: process.env.OSN_ISSUER_URL,
  osnAudience: process.env.OSN_AUDIENCE,
  stripe,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
  stripePlatformWebhookSecret: process.env.STRIPE_PLATFORM_WEBHOOK_SECRET ?? null,
  upgradePrices: {
    gold: process.env.STRIPE_UPGRADE_PRICE_GOLD,
    crimson: process.env.STRIPE_UPGRADE_PRICE_CRIMSON,
    crimsonFromGold: process.env.STRIPE_UPGRADE_PRICE_CRIMSON_FROM_GOLD,
  },
  stripeAccountCountry: process.env.STRIPE_ACCOUNT_COUNTRY,
};
// Mail leaves this dev server only for a local Resend emulator; the rule and
// its refusal of a bad override live in lib/resend-email.ts.
const localResend = localResendConfig({
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_API_URL: process.env.RESEND_API_URL,
});
if (localResend) appOptions.emailLayer = makeResendEmailLive(localResend);

const app = createApp(db, appOptions);

const server = Bun.serve({
  port,
  // Both parameters are contextually typed by `Bun.serve`; naming `Bun.Server`
  // here would need its WebSocket type argument, which this server has not got.
  fetch(request, srv) {
    // Local dev has no Cloudflare edge, so `cf-connecting-ip` is absent and the
    // fail-closed rate limiter (W5) 429s every gated route (claim, preview-code,
    // account-link, invite writes). Inject the socket peer as the trusted client
    // IP so per-IP limiting works locally. Prod (index.ts) is unaffected —
    // Cloudflare sets the real header at the edge.
    const ip = srv.requestIP(request)?.address ?? "127.0.0.1";
    const headers = new Headers(request.headers);
    if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", ip);
    return app.fetch(new Request(request, { headers }));
  },
});
runCireSync(Effect.logInfo("cire-api dev server listening", { port: server.port }));
