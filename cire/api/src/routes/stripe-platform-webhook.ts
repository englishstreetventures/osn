/**
 * THE PLATFORM'S side of the conversation.
 *
 *   POST /api/stripe/platform-webhook   (signature-verified, no other auth)
 *
 * **Why this is a second endpoint rather than a branch in the other one.**
 * `/api/stripe/webhook` is registered with Stripe as a CONNECT endpoint: every
 * event it hears about happened on a couple's connected account, which is why
 * `local.ts` forwards to it with `--forward-connect-to` and why every handler
 * there reads `event.account`. An upgrade purchase is the opposite — cire is
 * the merchant, the Checkout Session belongs to the platform account, and a
 * platform event is not delivered to a Connect-scoped endpoint at all. Even
 * where both endpoints are registered at one URL they carry SEPARATE signing
 * secrets, and a verifier holds exactly one. So a branch in the other route
 * would be a branch no event could reach: unreachable in production, green in
 * every test, because a test signs with whatever secret it is handed.
 *
 * **Mounted only when a signing secret exists**, the same rule as the Connect
 * endpoint: with nothing to verify, an endpoint that writes rows is an
 * unauthenticated write API.
 *
 * **Exempt from the CSRF origin guard**, by exact path, in `lib/origin-guard.ts`.
 * Stripe sends no `Origin`, so without that the guard 403s every delivery
 * before its signature is ever checked and Stripe retries the 403 for days.
 *
 * **The raw bytes are the subject.** The signature is over the exact text
 * Stripe sent, so the body is read unparsed and parsed inside the verifier.
 *
 * **`event.account` must be ABSENT.** Belt and braces behind the separate
 * secret: a Connect event misdelivered here names an account, and an account
 * naming itself must never be able to grant a platform entitlement. It is also
 * what keeps a connected account from forging a `client_reference_id` that
 * looks like one of ours.
 *
 * **A 200 does not mean "granted".** Stripe retries any non-2xx for days, so
 * the only things that answer non-2xx are a body we cannot verify (400 — a
 * retry will not make it verifiable) and a database failure (500 — a retry
 * genuinely might). An event this product does not care about is a 200: this
 * endpoint belongs to the platform account, which does whatever else it does,
 * and refusing everything unfamiliar would turn that into a retry storm.
 */

import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { MAX_EVENT_BYTES, readBoundedText } from "../lib/webhook-body";
import { runCire } from "../observability";
import { verifyStripeWebhook } from "../services/stripe";
import type { UpgradeService } from "../services/upgrades";

/** The one event that grants. */
const CHECKOUT_COMPLETED = "checkout.session.completed";
/**
 * A session the organiser opened and walked away from, and a delayed debit that
 * bounced. Both close a pending purchase so it stops blocking the next attempt.
 * There is no `async_payment_succeeded` counterpart: upgrade sessions are
 * created card-only, so none can complete unpaid and settle days later.
 */
const CHECKOUT_EXPIRED = "checkout.session.expired";
const CHECKOUT_ASYNC_FAILED = "checkout.session.async_payment_failed";

export interface StripePlatformWebhookDeps {
  /** Stripe's signing secret for THIS endpoint. Absent ⇒ do not mount. */
  readonly webhookSecret: string;
  readonly upgrades: UpgradeService;
}

interface EventEnvelope {
  type?: unknown;
  /** Set on a Connect event; absent on a platform one. The discriminator. */
  account?: unknown;
  data?: { object?: unknown };
}

interface SessionObject {
  id?: unknown;
  payment_intent?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  /**
   * Our own purchase id. Stripe echoes it back untouched and treats it as
   * opaque, so it is read before any metadata.
   */
  client_reference_id?: unknown;
  metadata?: { purchaseId?: unknown };
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const purchaseIdOf = (session: SessionObject | undefined): string | null =>
  str(session?.client_reference_id) ?? str(session?.metadata?.purchaseId);

export const createStripePlatformWebhookRoutes = (db: Db, deps: StripePlatformWebhookDeps) =>
  new Elysia().post(
    "/api/stripe/platform-webhook",
    async ({ request, set }) => {
      const signatureHeader = request.headers.get("stripe-signature");
      if (!signatureHeader) {
        set.status = 400;
        return { error: "invalid_signature", reason: "malformed" };
      }
      const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > MAX_EVENT_BYTES) {
        set.status = 400;
        return { error: "invalid_signature", reason: "malformed" };
      }
      const payload = await readBoundedText(request, MAX_EVENT_BYTES);
      if (payload === null) {
        set.status = 400;
        return { error: "invalid_signature", reason: "malformed" };
      }
      const now = Math.floor(Date.now() / 1000);

      return runCire(
        Effect.gen(function* () {
          const event = yield* verifyStripeWebhook({
            payload,
            signatureHeader,
            secret: deps.webhookSecret,
            now,
          });
          const envelope = event as EventEnvelope;
          const type = typeof envelope.type === "string" ? envelope.type : "";

          // A Connect event has no business here. Acknowledged so Stripe stops
          // asking, and granted nothing.
          if (str(envelope.account) !== null) {
            return { received: true, outcome: "not_platform" };
          }

          if (type === CHECKOUT_COMPLETED) {
            const session = envelope.data?.object as SessionObject;
            const sessionId = str(session?.id);
            const purchaseId = purchaseIdOf(session);
            if (!sessionId || !purchaseId) {
              // A platform session that is not one of ours — this endpoint is
              // shared with whatever else the account does. A retry cannot add
              // fields Stripe never sent.
              return { received: true, outcome: "unknown" };
            }
            const outcome = yield* deps.upgrades.settlePurchase({
              purchaseId,
              checkoutSessionId: sessionId,
              paid: session?.payment_status === "paid",
              paidAmountMinor:
                typeof session?.amount_total === "number" ? session.amount_total : null,
              paidCurrency: str(session?.currency),
              paymentIntentId: str(session?.payment_intent),
            });
            return { received: true, outcome };
          }

          if (type === CHECKOUT_EXPIRED || type === CHECKOUT_ASYNC_FAILED) {
            const session = envelope.data?.object as SessionObject;
            const sessionId = str(session?.id);
            const purchaseId = purchaseIdOf(session);
            if (!sessionId || !purchaseId) {
              return { received: true, outcome: "unknown" };
            }
            const outcome = yield* deps.upgrades.failPurchase({
              purchaseId,
              checkoutSessionId: sessionId,
              status: type === CHECKOUT_EXPIRED ? "expired" : "failed",
            });
            return { received: true, outcome };
          }

          // Acknowledged, not handled. See the header.
          return { received: true };
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("StripeSignatureError", (error) =>
            Effect.sync(() => {
              set.status = 400;
              // The reason is safe to return and is what tells an operator
              // staring at Stripe's delivery log whether they have the wrong
              // secret, a clock problem, or a proxy rewriting bodies. It says
              // nothing about what was in the body.
              return { error: "invalid_signature", reason: error.reason };
            }),
          ),
          // A defect here is a database failure, and Stripe SHOULD retry it —
          // one of the few 500s in this codebase that is a request to be called
          // again rather than an apology.
          Effect.tapDefect((cause) => Effect.logError("stripe platform webhook defect", cause)),
          Effect.catchDefect(() =>
            Effect.sync(() => {
              set.status = 500;
              return { error: "Internal error" };
            }),
          ),
        ),
      );
    },
    // The body must reach the handler as TEXT, unparsed — see the header.
    { parse: () => ({}) },
  );
