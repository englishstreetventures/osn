---
title: Email Verification API status
tags: [osn, auth, email, sign-up, browser-api]
related:
  - "[[passkey-primary]]"
  - "[[identity-model]]"
  - "[[account-recovery-factors]]"
last-reviewed: 2026-11-06
---

# Email Verification API status

The record of where the browser Email Verification API stands, and of when our flag-gated sign-up path may become the default or go. Englishstreetventures/osn#2089 stays open until one of the two exit tests below passes. Re-check the status each time you read this page, and update the dates.

## Status

*As of 2026-11-06. Source: Resend, [Email Verification API](https://resend.com/blog/email-verification-api), published 2026-08-25, updated 2026-09-17.*

| Fact | Source and date |
|---|---|
| A proposal from the WICG, at `github.com/WICG/email-verification`, "in the proposal stage" | Resend post, updated 2026-09-17 |
| Chrome is the only browser that supports it, through an origin trial | Resend post, updated 2026-09-17 |
| Gmail is the only issuer: mailbox verification works with Gmail alone | Resend post, updated 2026-09-17 |

The mailbox provider is the issuer. The browser and the issuer create a token together, and the page puts it in a hidden form input. Our server is the verifier and checks it.

This page cites only the Resend post. The WICG repository was not read when this page was written, so it makes no claim about the token format.

## Our code

Not built yet — set when englishstreetventures/osn#2088 lands. That issue adds the flag and the verifier. This section then names the sign-up code that reads the flag and the spec text it follows.

## Exit test: turn the flag on by default

All three hold:

1. The API ships in stable Chrome with no origin trial.
2. At least one more browser, or one more issuer, supports it.
3. The spec's token format has not changed for 12 weeks.

The 12 weeks is a proposal; the owner may change it.

## Exit test: drop the flag

The origin trial ends with no move to stable Chrome. Then remove the flag and the verifier.

See [[passkey-primary]] for the sign-up and login contract this path sits beside.
