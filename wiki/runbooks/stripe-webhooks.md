---
title: Stripe webhooks (cire-api) — recreate, run locally, verify
tags: [runbooks, cire, stripe, payments, deploy]
related:
  - "[[production-deploy]]"
  - "[[dev-environment]]"
  - "[[cire-upgrades]]"
  - "[[cire-registry]]"
  - "[[cire-entitlements]]"
  - "[[subprocessors]]"
last-reviewed: 2026-09-17
---

# Stripe webhooks (cire-api)

`cire-api` registers **two** Stripe webhook endpoints, and they are not
interchangeable. Every question about which secret, which events or why a
delivery is being refused resolves to which of the two you are holding.

| | Gifts | Upgrades |
|---|---|---|
| Path | `/api/stripe/webhook` | `/api/stripe/platform-webhook` |
| Stripe scope | **Connected accounts** | **Your account** (the platform) |
| Merchant of record | the couple | **cire** |
| Charge type | direct, on the couple's account | platform charge |
| Signing secret | `STRIPE_WEBHOOK_SECRET` | `STRIPE_PLATFORM_WEBHOOK_SECRET` |
| `event.account` | always present | must be **absent** |
| Unset secret ⇒ | route not mounted | route not mounted |
| System page | [[cire-registry]] | [[cire-upgrades]] |

A Stripe endpoint is scoped to one or the other, each carries its own signing
secret, and a verifier holds exactly one. That is why there are two routes
rather than one route with a branch on `event.account`: a platform event is
never delivered to a Connect-scoped endpoint at all, so the branch would be
one no event could reach — and green in every test, because a test signs with
whatever secret it is handed.

> [!warning]
> Swapping the two secrets is the failure that costs the most time. Every
> delivery to the mis-keyed endpoint is refused with a 400, Stripe retries for
> days, and nothing settles or grants. The dashboard shows a wall of failed
> deliveries and the Worker logs show a signature error, with no hint that the
> cause is the *other* endpoint's secret.

---

## Where the dashboard keeps this

Webhook management lives in **Workbench**, which replaced the Developers
Dashboard. `Settings → Developers` does not hold it.

- **Developers → Workbench → Webhooks**, or press <kbd>~</kbd> anywhere in the
  dashboard, or go straight to `dashboard.stripe.com/workbench/webhooks`.
- Endpoints are scoped to the **sandbox or mode you are currently in**. Switch
  first (top-left switcher), then create. A sandbox issues its own `whsec_`,
  and it will not verify a live delivery.
- Retry behaviour differs by mode: a sandbox retries three times over a few
  hours, live retries for days. A sandbox that stops retrying has not
  succeeded — it has given up.

---

## Recreate — the Connect endpoint (gifts)

Needed for the registry's card contributions. Without it a gift is written
`pending` and never settles, a couple's Connect capabilities are never cached,
and a revoked account is never noticed.

1. Workbench → Webhooks → **Create new destination**.
2. URL:
   - dev — `https://api.dev.cireweddings.com/api/stripe/webhook`
   - production — `https://api.cireweddings.com/api/stripe/webhook`
3. Events from: **Connected accounts**. This is the whole point of this
   endpoint; an account-scoped one hears nothing a couple's account does.
4. Subscribe to these nine, and nothing else — an unrecognised type is
   acknowledged and dropped, so extra subscriptions are noise rather than
   breakage:

   | Event | What it does |
   |---|---|
   | `account.updated` | caches `charges_enabled` / `payouts_enabled` on the wedding |
   | `account.application.deauthorized` | the couple revoked cire; clears the account id |
   | `checkout.session.completed` | **writes the gift** — the only place a contribution settles |
   | `checkout.session.async_payment_succeeded` | a delayed debit (BECS, SEPA) that landed |
   | `checkout.session.async_payment_failed` | a delayed debit that bounced |
   | `checkout.session.expired` | guest opened checkout and walked away |
   | `charge.refunded` | marks a settled gift refunded |
   | `charge.dispute.created` | a guest's bank pulled a gift back |
   | `charge.dispute.closed` | how the dispute went, in `status` |

5. Copy that endpoint's signing secret, then:

   ```bash
   cd cire/api
   bunx wrangler secret put STRIPE_WEBHOOK_SECRET --env dev
   ```

The Connect **platform** side also has to exist before any of this does
anything: Connect enabled on the account, and the platform profile complete
enough for Stripe to mint Express accounts. `POST …/registry/stripe/session`
creates them with `card_payments` + `transfers`, in the country
`STRIPE_ACCOUNT_COUNTRY` names (an ordinary var, default `AU` in code). Stripe
fixes an account's country at creation, so that is a per-deployment decision,
not one a couple can change later.

## Recreate — the platform endpoint (upgrades)

1. Workbench → Webhooks → **Create new destination**.
2. URL:
   - dev — `https://api.dev.cireweddings.com/api/stripe/platform-webhook`
   - production — `https://api.cireweddings.com/api/stripe/platform-webhook`
3. Events from: **Your account**. Not connected accounts.
4. Subscribe to exactly three:

   | Event | What it does |
   |---|---|
   | `checkout.session.completed` | **grants the entitlement** and writes the `platform_sales` row |
   | `checkout.session.expired` | closes the pending purchase so the module can be bought again |
   | `checkout.session.async_payment_failed` | the same, for a debit that bounced |

5. Copy **that** endpoint's secret — not the Connect one:

   ```bash
   cd cire/api
   bunx wrangler secret put STRIPE_PLATFORM_WEBHOOK_SECRET --env dev
   ```

The upgrade path also needs a **Price per purchasable module**, or nothing is
for sale. Test-mode Prices for dev, live-mode for production; a test id in
production fails at checkout. They are ordinary vars, in `wrangler.toml` under
each tier's own `[env.<env>.vars]` — named envs inherit no vars:

```toml
STRIPE_UPGRADE_PRICE_VENDORS  = "price_..."
STRIPE_UPGRADE_PRICE_REGISTRY = "price_..."
```

## After either secret changes

`wrangler secret put` does not cycle warm isolates. Redeploy, or the old value
keeps serving:

```bash
cd cire/api && bunx wrangler deploy --env dev
```

---

## Local development

One `stripe listen` covers both endpoints, with two different flags:

```bash
stripe listen --forward-connect-to localhost:8787/api/stripe/webhook \
              --forward-to         localhost:8787/api/stripe/platform-webhook
```

`--forward-connect-to` carries events that happened on a connected account —
the gifts. `--forward-to` carries the platform's own — the upgrades. They are
two flags because they carry two different things, not two spellings of one.

It prints **one** signing secret for everything it forwards, so locally both
secrets take the same value:

```bash
STRIPE_SECRET_KEY=sk_test_… \
STRIPE_WEBHOOK_SECRET=whsec_… STRIPE_PLATFORM_WEBHOOK_SECRET=whsec_… \
STRIPE_UPGRADE_PRICE_VENDORS=price_… STRIPE_UPGRADE_PRICE_REGISTRY=price_… \
  bun run --cwd cire/api dev:app
```

Two secrets holding one value is a **local-only** property. Deployed tiers have
two dashboard endpoints and two different secrets, and that difference is what
the wrong-secret test pins — so a change that only ever ran locally can still
be wrong in dev.

Fire one by hand without touching a card, to check the route is mounted and the
signature verifies:

```bash
stripe trigger checkout.session.completed
```

It will not settle anything real — the handlers find no row for the session id
Stripe invents — but a 200 in `stripe listen`'s output proves mounting and
signature. A 400 there is a secret mismatch; a 404 means the route is not
mounted, so the secret is unset.

---

## Verify a deployed tier

Work down this list; each step rules out the failure the next one would
otherwise be blamed for.

**1. The routes exist.** An unmounted route 404s, and a mounted one refuses an
unsigned body with a 400. That difference is the whole check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://api.dev.cireweddings.com/api/stripe/platform-webhook -d '{}'
# 400 ⇒ mounted, signature refused (correct)
# 404 ⇒ STRIPE_PLATFORM_WEBHOOK_SECRET is unset, or the deploy has not cycled
```

**2. Watch the Worker while you test.** The deliveries and the refusals both
show here, and this is the first thing to read rather than the last:

```bash
cd cire/api && bunx wrangler tail --env dev --format pretty
```

**3. Buy something.** As a wedding **owner**, open a locked module's nav row →
Upgrade → pay with a Stripe test card (`4242 4242 4242 4242`, any future expiry
and CVC) → you should land back in the portal with the module open.

**4. Prove it was the webhook that granted it, not the browser.** The return
from Stripe only polls; nothing in the query string can grant. So check the
rows:

```bash
cd cire/api
bunx wrangler d1 execute cire-db-dev --env dev --remote --command \
  "SELECT entitlement, source, granted_at FROM wedding_entitlements WHERE source = 'purchase'"

bunx wrangler d1 execute cire-db-dev --env dev --remote --command \
  "SELECT id, entitlement, status, checkout_session_id FROM wedding_upgrade_purchases ORDER BY created_at DESC LIMIT 5"

bunx wrangler d1 execute cire-db-dev --env dev --remote --command \
  "SELECT purchase_id, entitlement, amount_minor, currency FROM platform_sales ORDER BY settled_at DESC LIMIT 5"
```

A purchase stuck at `pending` with a real `checkout_session_id` is the
signature that the endpoint is wrong, mis-keyed or unmounted — the money was
taken and nothing granted. That is the one state worth alerting on, and it is
also what the observability gap measures: `cire.upgrade.checkout.started`
without a matching `cire.upgrade.purchase.settled`.

**5. Read the delivery log.** Workbench → Webhooks → the endpoint → recent
deliveries. A 400 there names the secret; a 404 names the mounting; a timeout
names the handler. Stripe gives a webhook handler twenty seconds.

**6. For gifts, the same shape.** A contribution that stays `pending` after a
successful test payment means the Connect endpoint is missing, scoped to the
platform by mistake, or holding the wrong secret:

```bash
bunx wrangler d1 execute cire-db-dev --env dev --remote --command \
  "SELECT id, status, stripe_payment_intent_id FROM registry_contributions ORDER BY created_at DESC LIMIT 5"
```

---

## How each failure looks

| Symptom | Cause |
|---|---|
| Endpoint 404s, nothing is delivered | its signing secret is unset, so the route is not mounted |
| Every delivery 400s in the dashboard | wrong secret — most often the other endpoint's |
| Gifts settle, upgrades never do | only the Connect endpoint exists |
| Upgrades settle, gifts never do | only the platform endpoint exists |
| Upgrade endpoint 200s but grants nothing | the delivery carried `event.account` — a Connect event reached the platform route, which refuses it by design |
| Module missing from the upgrade dialog | no `STRIPE_UPGRADE_PRICE_*` for that key in this tier. Absent configuration never means free |
| Checkout 404s | the same, from the session route |
| Secret changed and nothing changed | warm isolates. Redeploy |

---

## Related

- [[cire-upgrades]] — the upgrade purchase lifecycle, the double-charge guard, retention
- [[cire-registry]] — gifts, Connect onboarding, the seven gift events in context
- [[cire-entitlements]] — what a granted row unlocks
- [[production-deploy]] §3.8, §3.9 — where these sit in the deploy checklist
- [[dev-environment]] — what the dev tier is and how a merge reaches it
- [[subprocessors]] — Stripe's standing as a processor
