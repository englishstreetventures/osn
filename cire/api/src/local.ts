import { BOOTSTRAP_WEDDING_ID, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "./app";
import { createDb, seedDb } from "./db/setup";
import { runCireSync } from "./observability";
import { createAssetsStub } from "./services/invite-assets";
import { createR2Stub } from "./services/r2-imports";
import { createStripeClientFromEnv } from "./services/stripe";

const db = createDb(":memory:");
await seedDb(db);

// Dev convenience: the in-memory seed gives the sample wedding the fixed local
// dev owner (usr_dev_bootstrap_owner — see DEV_OWNER_PROFILE_ID in db/setup),
// so the organiser dashboard lists nothing for a real signed-in account. Re-point
// it at your OSN profile id via env so the wedding shows up. Find yours in osn.db:
// SELECT id FROM users WHERE handle=...  (this is a post-seed override for the
// running local server; deployed tiers never run this seed.)
const devOwner = process.env.CIRE_DEV_OWNER_PROFILE_ID;
if (devOwner) {
  db.update(weddings)
    .set({ ownerOsnProfileId: devOwner })
    .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
    .run();
  runCireSync(
    Effect.logInfo("dev: bootstrap wedding owner repointed", { ownerOsnProfileId: devOwner }),
  );
}

const origins = (process.env.WEB_ORIGIN ?? "http://localhost:4321,http://localhost:4322")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const webOrigin = origins[0];
// Entry 1 is the organiser portal, as it is in the Worker (`index.ts` reads the
// same comma-list). Without this `createApp` falls back to its PRODUCTION
// default, so every Stripe return URL minted in local dev sends the developer
// to host.cireweddings.com — which makes the upgrade flow untestable locally
// and silently points a test payment's return at the live portal.
const organiserOrigin = origins[1];
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

const appOptions: Parameters<typeof createApp>[1] = {
  webOrigin,
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
    vendors: process.env.STRIPE_UPGRADE_PRICE_VENDORS,
    registry: process.env.STRIPE_UPGRADE_PRICE_REGISTRY,
  },
  stripeAccountCountry: process.env.STRIPE_ACCOUNT_COUNTRY,
};
// Only when WEB_ORIGIN actually named one: an explicit `undefined` would beat
// createApp's default parameter and leave the origin empty rather than falling
// back to it.
if (organiserOrigin) appOptions.organiserOrigin = organiserOrigin;

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
