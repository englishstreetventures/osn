import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { verifyDigestStopToken } from "../lib/digest-stop";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { runCire } from "../observability";
import { rsvpDigestService } from "../services/rsvp-digest";

/**
 * One-click stop for the daily RSVP digest, without signing in:
 *
 *   GET  /api/rsvp-digest/stop?t=<token>   a page asking to confirm
 *   POST /api/rsvp-digest/stop?t=<token>   turns the digest off
 *
 * Each digest email links the GET and names the POST in its
 * `List-Unsubscribe` / `List-Unsubscribe-Post` headers (RFC 8058), so a mail
 * client can stop it in one click. The token (`lib/digest-stop.ts`) names one
 * person and one wedding and is HMAC-signed; nothing happens without a valid
 * one.
 *
 * GET never changes anything: mail scanners and link previews fetch every link
 * in a message, and a stop that fired on GET would turn digests off nobody
 * asked to stop. The page's button POSTs back to the same URL.
 *
 * Mounted BEFORE the app-wide CSRF origin guard. A mail provider's one-click
 * POST carries no Origin, and the confirm page's own form carries this API's
 * origin, which is not a portal origin; the guard would refuse both. The
 * signed token is what authorises the request, and all it can do is turn one
 * person's digest off.
 *
 * Answers the same "stopped" page whether or not the person still holds a
 * seat that receives the digest, so the link says nothing about who is a host
 * now. Without a signing key (no `CIRE_OIDC_CLIENT_SECRET`) no email carries a
 * link, and the route answers 503.
 */

export interface RsvpDigestStopRouteOptions {
  /** The stop-link MAC key, or `null` when stop links are off. */
  key: Promise<CryptoKey> | null;
  /** Per-IP limiter. Generous: a real person clicks once. */
  limiter: RateLimiterBackend;
}

const PATH = "/api/rsvp-digest/stop";

/** Fixed pages, so nothing from the request is ever written into the HTML. */
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:48px 24px;line-height:1.5}button{font:inherit;padding:10px 18px;border-radius:6px;border:1px solid #0a0a0a;background:#0a0a0a;color:#fff;cursor:pointer}p.muted{color:#666;font-size:14px}</style></head><body>${body}<p class="muted">Cire Weddings</p></body></html>`;

const CONFIRM = page(
  "Stop the daily RSVP summary",
  `<h1>Stop the daily RSVP summary?</h1><p>You will stop getting the daily email about RSVP changes for this wedding. Your co-hosts keep theirs.</p><form method="post"><button type="submit">Stop these emails</button></form>`,
);

const STOPPED = page(
  "Daily RSVP summary stopped",
  `<h1>Done</h1><p>You will not get the daily RSVP summary for this wedding again. To turn it back on, sign in and tick "Email me a daily summary" on the wedding's Overview page.</p>`,
);

const INVALID = page(
  "Link not recognised",
  `<h1>This link is not recognised</h1><p>It may be incomplete. To stop the daily RSVP summary, sign in and untick "Email me a daily summary" on the wedding's Overview page.</p>`,
);

const UNAVAILABLE = page(
  "Not available",
  `<h1>This link is not available right now</h1><p>To stop the daily RSVP summary, sign in and untick "Email me a daily summary" on the wedding's Overview page.</p>`,
);

const FAILED = page(
  "Something went wrong",
  `<h1>Something went wrong</h1><p>Your daily RSVP summary was not stopped. Please try again in a moment.</p>`,
);

/**
 * The token is in the URL, so the page must not leak it onward: no referrer,
 * no caching, no framing, no script, and a form that may only post here.
 */
const html = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });

type StopOutcome = "stopped" | "no_seat" | "invalid";

const logOutcome = (outcome: StopOutcome) =>
  // The outcome only — never the token or the ids it carries.
  runCire(Effect.logInfo("rsvp digest stop", { outcome }));

export const createRsvpDigestStopRoutes = (db: Db, { key, limiter }: RsvpDigestStopRouteOptions) =>
  new Elysia()
    .use(rateLimitMiddleware(limiter))
    .get(PATH, async ({ query }) => {
      if (!key) return html(UNAVAILABLE, 503);
      const token = typeof query.t === "string" ? query.t : "";
      const target = await verifyDigestStopToken(await key, token);
      if (!target) {
        await logOutcome("invalid");
        return html(INVALID, 400);
      }
      return html(CONFIRM, 200);
    })
    .post(
      PATH,
      async ({ query }) => {
        if (!key) return html(UNAVAILABLE, 503);
        const token = typeof query.t === "string" ? query.t : "";
        const target = await verifyDigestStopToken(await key, token);
        if (!target) {
          await logOutcome("invalid");
          return html(INVALID, 400);
        }
        const outcome = await runCire(
          rsvpDigestService.stop(target).pipe(
            Effect.provideService(DbService, db),
            Effect.catch(() => Effect.succeed(null)),
            Effect.catchDefect(() => Effect.succeed(null)),
          ),
        );
        if (outcome === null) {
          await runCire(Effect.logError("rsvp digest stop failed"));
          return html(FAILED, 500);
        }
        await logOutcome(outcome);
        return html(STOPPED, 200);
      },
      // Read nothing from the body. A one-click POST is form-encoded
      // (`List-Unsubscribe=One-Click`) and says nothing the token does not, and
      // a body the framework could not parse must not fail the request first.
      { parse: () => ({}) },
    );
