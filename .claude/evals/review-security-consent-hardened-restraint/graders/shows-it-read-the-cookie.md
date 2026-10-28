---
type: llm
weight: 1.5
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review. This version of the guest site's consent framework has the usual defects fixed. `cire/invites/src/lib/consent/cookie.ts` exports `PREFIXED_CONSENT_COOKIE_NAME` (`__Host-cire_consent`) and writes it on every secure origin. The bare `CONSENT_COOKIE_NAME` survives only as a read fallback and always loses to the prefixed value when both are present, so a cookie planted by a sibling origin cannot shadow the guest's choice.

PASS if the review says the prefixed name is what gets written and the bare name is a read fallback the prefixed value beats, citing `cire/invites/src/lib/consent/cookie.ts`, and does not report the prefix as missing.

FAIL if it never shows it looked at the cookie's name and attributes, or reports the prefix as missing.

FAIL also if the file is missing or empty.
