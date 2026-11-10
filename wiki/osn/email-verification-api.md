---
title: Email Verification API status
tags: [osn, auth, email, sign-up, browser-api]
related:
  - "[[passkey-primary]]"
  - "[[identity-model]]"
  - "[[email-links]]"
  - "[[account-recovery-factors]]"
last-reviewed: 2026-11-11
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

## Our code

The flag is **`OSN_EMAIL_VERIFICATION_API`**, an osn-api variable, **off** unless it reads `true`, `1`, `yes` or `on`. It is read in one place, `emailVerificationConfig` in [`build-deps.ts`](../../osn/api/src/build-deps.ts), which sets `AuthConfig.emailVerification`; every other part checks that. No tier's `wrangler.toml` sets it, so it is off everywhere deployed.

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
5. The issuer comes from the sign-up address's own domain: exactly one `iss=` TXT record at `_email-verification.<domain>`, never anything the token says. The EVT's `iss` names that host, the metadata at `https://<host>/.well-known/email-verification` names the same issuer when it names one, and a key from its `jwks_uri` verifies the EVT — the key its `kid` names, or each key in turn when there is no `kid`.

**What a lookup may reach.** Every request goes to `https:` on the default port, to a host name (never an IP literal) whose every A and AAAA answer is a public address. Loopback, private, link-local, shared, multicast and reserved ranges are refused, IPv6 forms that carry an IPv4 address are judged as that address, and a host with no answer is refused. No redirect is followed, to any host. A response must be 200, JSON, and at most 64 KiB; each request has 3 seconds, and the whole check 5. On workerd `fetch` resolves the host again by itself, so the address check cannot pin the address it checked; Cloudflare's network does not carry a Worker's subrequest to a private address.

**A begin with a token.** The token is checked after the age gate, the handle checks and any `previous` retire, and before the taken probe, so a taken and a free address pay the same lookups. A token that verifies makes one more write on the request whatever the address: a free address's request is confirmed then, as its link would be, and no mail is sent; a taken or held address's request is written back unchanged and goes on as on the link path. Every begin answers `{ requestId, claimSecret, pairingCode, expiresAt }`. The account is made by the tab's first status poll, and the first passkey is enrolled after it, as on every sign-up. A refused token changes nothing the person sees: the link goes as ever.

**Departures from the text read.** Each fails closed, to the emailed link:

- The nonce is bound to the tab by `nonceSecret`, which the tab holds in memory, not by a session: sign-up has none.
- `iss` may be the issuer's origin (draft-02) or its bare host (draft-00 deployments); the EVT's `typ` may be `evt+jwt` (the drafts) or `evp-sd-jwt` (the WICG explainer's example); `alg` may be `EdDSA`, `Ed25519` or `ES256`. We have not seen a real Gmail token.
- DNSSEC is not required: the resolver is reached over HTTPS, and `gmail.com` is unsigned.

**Observability.** Span `auth.email_verification.verify`; counter `osn.auth.email_verification.tokens{outcome}`, where `outcome` is `verified`, `malformed`, `issuer`, `signature`, `binding`, `email`, `expired`, `replayed` or `unavailable`. Neither the token, the address nor the issuer is logged or put in an attribute; `emailVerificationToken` and `nonceSecret` are on the log redaction list.

**What leaves our network.** See [[subprocessors#Outbound lookups (not processors)]]. The resolver learns the address's domain and the issuer's host names; the issuer's hosts get plain GETs of their public metadata and keys. Neither ever gets the address's local part or the token.

**Tests.** The refusals: [`email-verification-token.test.ts`](../../osn/api/tests/services/auth/email-verification-token.test.ts) and [`email-verification-begin.test.ts`](../../osn/api/tests/routes/email-verification-begin.test.ts); the same store calls for a free, taken or held address in `begin-op-sequence.test.ts`. End to end, the E2E flow `musubi-email-verification` signs up through Musubi against the stack's second osn-api, which has the flag on and reaches an issuer stand-in (`tools/e2e/src/issuer.ts`) through `OSN_EMAIL_VERIFICATION_EMULATOR_URL`. That variable is honoured only when `OSN_ENV` is exactly `local` and it names a loopback origin; any other tier refuses to boot with it, and the production deploy refuses to run while a Worker secret of that name exists.

## Before the flag goes on in any tier

The owner's, in this order:

1. Register an origin-trial token for the sign-up origin, `https://musubi.social` (trial "Email Verification", developer.chrome.com/origintrials), and serve it on the sign-up page — a code change to Musubi's `index.html` or `_headers`.
2. Check with a real Chrome, signed in to Gmail, against a production build served with `_headers`. Musubi's `Content-Security-Policy` arrives in a header, and the HTML standard then hides a `nonce` attribute from the page once the element is in the document; the WICG text has the browser read "the value of the `nonce` attribute". If Chrome reads it empty, no token comes.
3. Run one captured real Gmail token through the verifier, so the departures above are checked against a real issuer.
4. Set `OSN_EMAIL_VERIFICATION_API` in the tier's `wrangler.toml` vars, through a pull request.

## Exit test: turn the flag on by default

All three hold:

1. The API ships in stable Chrome with no origin trial.
2. At least one more browser, or one more issuer, supports it.
3. The spec's token format has not changed for 12 weeks.

The 12 weeks is a proposal; the owner may change it.

## Exit test: drop the flag

The origin trial ends with no move to stable Chrome. Then remove the flag and the verifier.

See [[passkey-primary]] for the sign-up and login contract this path sits beside, and [[email-links]] for the link path it falls back to.
