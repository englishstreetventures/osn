---
title: Email Verification API status
tags: [osn, auth, email, sign-up, browser-api]
related:
  - "[[passkey-primary]]"
  - "[[identity-model]]"
  - "[[email-links]]"
  - "[[account-recovery-factors]]"
  - "[[dev-environment]]"
last-reviewed: 2026-11-16
---

# Email Verification API status

The record of where the browser Email Verification API stands, what our flag-gated sign-up path does with it, and when that path may become the default or go. Issue englishstreetventures/osn#2089 stays open until one of the two exit tests below passes. Re-check the status each time you read this page, and update the dates.

## Status

*As of 2026-11-10. Sources: the WICG repository, `WICG/email-verification` at commit `395119cbe` (2026-10-02); the protocol draft it defers to, [draft-hardt-email-verification-02](https://www.ietf.org/archive/id/draft-hardt-email-verification-02.html) (2026-08-25); and Chrome's posts on [developer.chrome.com](https://developer.chrome.com/blog/email-verification-protocol-origin-trial) (origin-trial post updated 2026-10-05, "Email verification updates, October 2026" of 2026-10-05).*

| Fact | Source and date |
|---|---|
| A WICG Community Group draft (`index.bs`, "CG-DRAFT"); the explainer lists "Intent to Prototype" and "Intent to Experiment" | WICG repo, 2026-10-02 |
| Chrome runs it under an origin trial: desktop from Chrome 150, Android from Chrome 154. Chrome says it expects no more breaking changes and is "preparing to ship" | Chrome, 2026-10-05 |
| No other browser supports it | Chrome posts and the WICG repo name no other, 2026-11-10 |
| Gmail is the one issuer we found: `_email-verification.gmail.com` names `accounts.google.com` | Live DNS, 2026-11-10 |
| The token format changed twice in 2026: Chrome 153 moved the issuance request to HTTP Message Signatures (issuer side), and Chrome 156 returns the address exactly as typed | Chrome, 2026-08-13 and 2026-10-05 |
| There is no feature detection: a page adds the hidden field and treats the token as optional | Chrome origin-trial post, 2026-10-05 |

*Observed 2026-11-10 — `curl -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=_email-verification.gmail.com&type=TXT'` answers `"iss=accounts.google.com"` with `AD: false` (the zone is not DNSSEC-signed); `https://accounts.google.com/.well-known/email-verification` names `jwks_uri` `https://verifiablecredentials-pa.googleapis.com/.well-known/vc-public-jwks` and `signing_alg_values_supported: ["EdDSA"]`; that key set holds five Ed25519 keys with `alg: "EdDSA"` and no `kid`.*

The mailbox provider is the issuer. When the person picks their address in a form that carries the hidden field, the browser asks the issuer for an Email Verification Token (EVT), binds it to the page's origin and a nonce the page carries, and puts `<EVT>~<KB-JWT>` in the field when the form is submitted. Our server is the verifier.

## Our origin trial

Musubi is registered for Chrome's Email Verification Protocol origin trial (feature `EmailVerificationProtocol`) twice, once per tier. Both tokens are first-party.

| Token | Origin | Covers |
|---|---|---|
| Production | `https://musubi.social`, exactly: no subdomain matching | `musubi.social` |
| Dev | `https://esv.tools`, the dev zone, with subdomain matching | `musubi.esv.tools`, the dev Musubi host (`musubi.<DEV_DOMAIN>`) |

| | |
|---|---|
| Chrome versions | Available in Chrome 150 to 160 |
| Ends | With the rollout of the Chrome release after 160, and no later than 2 March 2027, both tokens' own expiry. Chrome may end it sooner |
| Served from | Two `Origin-Trial` lines in the `/*` rule of [`musubi/social/public/_headers`](../../musubi/social/public/_headers), on every page of both tiers. Cloudflare joins the two lines into one header, the tokens separated by a comma, which Chrome reads as two tokens; it ignores the one whose origin does not match the page |
| Checked by | [`origin-trial.test.ts`](../../musubi/social/tests/origin-trial.test.ts): one token for each origin above, each signed by Chrome's key, for this feature, first-party, matching subdomains only on the dev zone, and more than 14 days from its expiry, so CI fails while there is time to renew |

Local stacks get no token: there Chrome never fills the field, and sign-up takes the emailed link. The dev token names the zone, so a new `DEV_DOMAIN` needs a new token ([[dev-environment#4. Bootstrapping the dev account]]). When Chrome announces the trial's end, decide whether to renew the tokens or remove the lines, and record the decision here.

## Our code

The flag is **`OSN_EMAIL_VERIFICATION_API`**, an osn-api variable, **off** unless it reads `true`, `1`, `yes` or `on`. It is read in one place, `emailVerificationConfig` in [`build-deps.ts`](../../osn/api/src/build-deps.ts), which sets `AuthConfig.emailVerification`; every other part checks that.

| Tier | Flag | Set in |
|---|---|---|
| Dev | **On** since 2026-11-16 (englishstreetventures/osn#2317), by the owner's decision, for the trial in [[#Testing on the dev tier]] | `musubiDeclaration` in [`musubi/infra/src/declaration.ts`](../../musubi/infra/src/declaration.ts), on stage `dev` only; investigation stages leave it off |
| Production | **Off**: unset | Neither `musubiProductionApis` in the same file nor `[env.production.vars]` in [`osn/api/wrangler.toml`](../../osn/api/wrangler.toml), which `musubi/infra/tests/parity.test.ts` (PA1) holds equal |
| Local E2E | On, for the second osn-api only | `tools/e2e/src/stack.ts` |

| Part | File | What it does |
|---|---|---|
| Nonce | `POST /register/email-verification-nonce`, [`routes/auth/registration.ts`](../../osn/api/src/routes/auth/registration.ts) | 404 while the flag is off. On: `{ nonce, nonceSecret }`. `nonceSecret` is 16 random bytes, an expiry 10 minutes out and an HMAC under the session IP pepper (`server-mac.ts`); `nonce` is its SHA-256. No store write |
| Verifier | [`email-verification-token.ts`](../../osn/api/src/services/auth/email-verification-token.ts) | The checks below; every refusal is an outcome, never an error |
| Lookups | [`email-verification-network.ts`](../../osn/api/src/services/auth/email-verification-network.ts) | DNS-over-HTTPS and the guarded fetch below, through one injected `fetch` |
| Sign-up | `beginRegistration`, [`registration.ts`](../../osn/api/src/services/auth/registration.ts) | Reads `emailVerificationToken` and `nonceSecret` from the begin body while the flag is on |
| Form | `Register`, [`Register.tsx`](../../osn/auth-ui/src/Register.tsx), and `emailVerificationNonce` in [`@osn/client`](../../osn/client/src/register.ts) | Adds `<input type="hidden" autocomplete="email-verification-token" nonce=…>` to the details form when osn-api hands out a nonce; sends its value and the nonce secret with begin |

**What a token must pass.** It follows `index.bs` §Verifier Processing Model and draft-02 §2.8, §3, §5.3 and §6.5:

1. Two parts, EVT and KB-JWT, at most 8 KiB, and nothing between them (no selective disclosures).
2. The nonce secret the tab sends was minted here, has not expired, and hashes to the KB-JWT's `nonce`. A token is accepted once: the nonce is claimed in the coordination store `email_verification_nonce` after every other check passes.
3. The KB-JWT's `aud` is the sign-up origin, `frontendOrigin(config)` in `helpers.ts` (the origin of `OSN_AUTHORIZE_UI_URL`, else the first WebAuthn origin); its `sd_hash` is the EVT's hash; its signature verifies under the EVT's `cnf.jwk`.
4. The EVT's `email` is the sign-up address, both ASCII, compared lowercased; `email_verified` is true; both `iat`s are within the last 10 minutes and not more than 60 seconds ahead; any `exp` has not passed.
5. The issuer comes from the sign-up address's own domain: exactly one `iss=` TXT record at `_email-verification.<domain>`, never anything the token says. The EVT's `iss` names that host, the metadata at `https://<host>/.well-known/email-verification` names the same issuer in its `issuer` member, and a key from its `jwks_uri` verifies the EVT — the key its `kid` names, or each key in turn when there is no `kid`.

**What a lookup may reach.** Every request goes to `https:` on the default port, to a host name (never an IP literal) whose every A and AAAA answer is a public address. Loopback, private, link-local, site-local, shared, multicast and reserved ranges are refused, and so is local-use NAT64; IPv6 forms that carry an IPv4 address are judged as that address; and a host with no answer is refused. No redirect is followed, to any host. A response must be 200, JSON, and at most 64 KiB; each request has 3 seconds, and the whole check 5, counted in our code whether or not the runtime stops a stalled response. On workerd `fetch` resolves the host again by itself, so the address check cannot pin the address it checked; Cloudflare's network does not carry a Worker's subrequest to a private address.

**A begin with a token.** The token is checked after the age gate, the handle checks and any `previous` retire, and before the taken probe, so a taken and a free address pay the same lookups. A token that verifies makes one more write on the request whatever the address: a free address's request is confirmed then, as its link would be, and no mail is sent; a taken or held address's request is written back unchanged and goes on as on the link path. Every begin answers `{ requestId, claimSecret, retireSecret, pairingCode, expiresAt }`. The account is made by the tab's first status poll, and the first passkey is enrolled after it, as on every sign-up. A token that fails a check changes nothing the person sees: the link goes as ever.

**Departures from the text read.** Each fails closed, to the emailed link:

- The nonce is bound to the tab by `nonceSecret`, which the tab holds in memory, not by a session: sign-up has none.
- `iss` may be the issuer's origin (draft-02) or its bare host (draft-00 deployments); the EVT's `typ` may be `evt+jwt` (the drafts) or `evp-sd-jwt` (the WICG explainer's example); `alg` may be `EdDSA`, `Ed25519` or `ES256`. We have not seen a real Gmail token.
- DNSSEC is not required: the resolver is reached over HTTPS, and `gmail.com` is unsigned.

**Observability.** Span `auth.email_verification.verify`, with the check's `outcome` as an attribute; counter `osn.auth.email_verification.tokens{outcome}`. `outcome` is `verified`, `malformed`, `issuer`, `signature`, `binding`, `email`, `expired`, `replayed` or `unavailable`. The counter reaches no exporter yet ([[metrics]]), so the dev tier's Workers traces are where an outcome can be read; production's API Workers trace nothing. Our code puts neither the token, the address nor the issuer in a log line or an attribute; `emailVerificationToken` and `nonceSecret` are on the log redaction list. Cloudflare's own outbound-fetch spans do record each lookup's URL ([[tracing]]), so on dev, where osn-api traces every request, a trace holds the issuer's host names and can hold the address's domain, which is in the resolver query; whether dev's `redactQueryString` also covers outbound fetches is unchecked. Cloudflare keeps traces for seven days.

**What leaves our network.** See [[subprocessors#Outbound lookups (not processors)]]. The resolver learns the address's domain and the issuer's host names; the issuer's hosts get plain GETs of their public metadata and keys. Neither ever gets the address's local part or the token.

**Tests.** The refusals: [`email-verification-token.test.ts`](../../osn/api/tests/services/auth/email-verification-token.test.ts) and [`email-verification-begin.test.ts`](../../osn/api/tests/routes/email-verification-begin.test.ts); the same store calls for a free, taken or held address in `begin-op-sequence.test.ts`. End to end, the E2E flow `musubi-email-verification` signs up through Musubi against the stack's second osn-api, which has the flag on and reaches an issuer stand-in (`tools/e2e/src/issuer.ts`) through `OSN_EMAIL_VERIFICATION_EMULATOR_URL`. That variable is honoured only when `OSN_ENV` is exactly `local` and it names a loopback origin; any other tier refuses to boot with it, and the production deploy refuses to run while a Worker secret of that name exists.

## Testing on the dev tier

The dev tier has the flag on and serves the dev token, so a real Chrome can run the whole path against Gmail there. Nothing else has: the E2E flow uses a stand-in issuer under Bun and takes its audience from `OSN_ORIGIN`, so the real DNS-over-HTTPS lookup, the guarded fetch on workerd and the `OSN_AUTHORIZE_UI_URL` audience run for the first time here.

You need desktop Chrome 150 or later, a Chrome profile signed in to a Gmail account, and a place on the dev Access policy ([[dev-environment#5. Access control on dev]]).

1. Open `https://musubi.esv.tools` in that Chrome and pass the Access sign-in. Open DevTools on the Network tab before going on.
2. Press **Create account**. The Network tab shows `POST https://id.musubi.esv.tools/register/email-verification-nonce` answering 200. A 404 means the flag is off: the dev deploy has not run.
3. Click the email field and pick the Gmail address from Chrome's autofill list rather than typing it. Fill in the rest and submit.
4. In the Network tab, open the `register/begin` request. Its body carries `emailVerificationToken`, a long `<EVT>~<KB-JWT>` string, beside `nonceSecret`.
5. Expected: no email arrives. The account is made at the page's first status poll, and the passkey step comes next.

**When the email arrives instead**, find which of three things went wrong.

- **Chrome sent no token**: the begin body has no `emailVerificationToken`. Suspect first the `nonce` attribute. Musubi's `Content-Security-Policy` arrives in a header, so the HTML standard hides the hidden field's `nonce` attribute from the page once the field is in the document; DevTools' Elements tab then shows `nonce=""`. The WICG text has the browser read "the value of the `nonce` attribute". If Chrome reads the attribute as the page now sees it, empty, no token ever comes. Then check the trial itself: DevTools → Application → Frames → `top` lists the page's origin trials, and `EmailVerificationProtocol` should show the dev token as valid. Last, check the address came from the autofill list and the profile is signed in to that Gmail account.
- **Chrome sent a token and the verifier refused it**: read the `outcome` attribute on the `auth.email_verification.verify` span in osn-api-dev's traces, in the dev account's Cloudflare dashboard (Workers Observability). The counter `osn.auth.email_verification.tokens{outcome}` records the same value but reaches no exporter yet.
- **The begin failed outright**, with an error on the page and no email: read osn-api-dev's Workers Logs. Dev is on Workers Free, which allows 10 ms of CPU time a request ([[free-tier-limits#Cloudflare Workers]]), and a token with no `kid` makes the verifier try each of Gmail's keys in turn.

| `outcome` | What it means |
|---|---|
| `verified` | Every check passed and the nonce was claimed: the address is proven, and no email goes |
| `malformed` | The token's shape: not two parts, over 8 KiB, a part that does not decode, an EVT `alg` other than `EdDSA`, `Ed25519` or `ES256`, a `typ` not listed under the departures above, or no `iss`, `email`, `email_verified: true` or `cnf.jwk`. Gmail's real token differs from the drafts we read |
| `email` | The token's address is not the one typed, compared lowercased, or either is not ASCII |
| `binding` | The nonce secret was not minted here; the KB-JWT's `aud` is not `https://musubi.esv.tools`, its `nonce` is not the tab's, or its `sd_hash` does not match; or the KB-JWT's signature fails under the EVT's `cnf` key |
| `expired` | The nonce is over 10 minutes old, an `iat` is more than 10 minutes back or 60 seconds ahead, or the EVT's `exp` has passed |
| `issuer` | The lookup found no single `iss=` record for `gmail.com`, an issuer that disagrees with the token or its metadata, no key set, or a host it refused: not a public address, not plain `https:`, a redirect, a status other than 200, not JSON, or too large |
| `signature` | No key in the issuer's key set verifies the EVT |
| `replayed` | The nonce was used already: the same token came twice |
| `unavailable` | A lookup or the whole check ran out of time (3 seconds a request, 5 in all), the resolver failed, or the coordination store did not answer |

Never write a real address into an issue, a pull request or this page; a captured token holds one.

## Before the flag goes on in production

The owner's, in this order:

1. Serve an origin-trial token on the sign-up origin. Done: see [[#Our origin trial]].
2. Check with a real Chrome, signed in to Gmail, against a build served with `_headers`: [[#Testing on the dev tier]]. The `nonce` question there is the first unknown it settles.
3. Check one real Gmail token against the verifier, so the departures above are tested against a real issuer: on dev, an `outcome` of `verified` does it.
4. Confirm the transfer basis for the DNS lookups ([[subprocessors#Outbound lookups (not processors)]]), then set `OSN_EMAIL_VERIFICATION_API` for production through a pull request, in both places PA1 holds equal: `musubiProductionApis` in `musubi/infra/src/declaration.ts` and `[env.production.vars]` in `osn/api/wrangler.toml`.

## Exit test: turn the flag on by default

All three hold:

1. The API ships in stable Chrome with no origin trial.
2. At least one more browser, or one more issuer, supports it.
3. The spec's token format has not changed for 12 weeks.

The 12 weeks is a proposal; the owner may change it.

## Exit test: drop the flag

The origin trial ends with no move to stable Chrome. Then remove the flag and the verifier.

See [[passkey-primary]] for the sign-up and login contract this path sits beside, and [[email-links]] for the link path it falls back to.
