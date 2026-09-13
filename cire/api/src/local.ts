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
const port = Number(process.env.PORT ?? 8787);

const r2 = createR2Stub();
const assets = createAssetsStub();

// Stripe, key-optional exactly as the Worker is (see index.ts): no
// `STRIPE_SECRET_KEY` and the organiser Connect routes are not mounted, no
// `STRIPE_WEBHOOK_SECRET` and `/api/stripe/webhook` does not exist. Both come
// from the shell, never from a committed file — the webhook secret in
// particular is whatever `stripe listen` prints for THIS session:
//
//   stripe listen --forward-connect-to localhost:8787/api/stripe/webhook
//   STRIPE_WEBHOOK_SECRET=whsec_… bun run --cwd cire/api dev:app
//
// `--forward-connect-to`, not `--forward-to`: every gift event happens on the
// couple's connected account, and the handler reads `event.account`.
const stripe = createStripeClientFromEnv({ STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY });

const app = createApp(db, {
  webOrigin,
  allowedOrigins: origins,
  r2,
  assets,
  osnJwksUrl: process.env.OSN_JWKS_URL,
  osnIssuerUrl: process.env.OSN_ISSUER_URL,
  osnAudience: process.env.OSN_AUDIENCE,
  stripe,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
  stripeAccountCountry: process.env.STRIPE_ACCOUNT_COUNTRY,
});

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
