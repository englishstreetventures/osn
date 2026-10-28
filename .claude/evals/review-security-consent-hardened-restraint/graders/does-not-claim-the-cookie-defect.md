---
type: llm
weight: 1.5
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review. This version of the guest site's consent framework has the usual defects fixed. `cire/invites/src/lib/consent/cookie.ts` exports `PREFIXED_CONSENT_COOKIE_NAME` (`__Host-cire_consent`) and writes it on every secure origin. The bare `CONSENT_COOKIE_NAME` survives only as a read fallback and always loses to the prefixed value when both are present, so a cookie planted by a sibling origin cannot shadow the guest's choice.

PASS if the review does not report that the cookie lacks a `__Host-` prefix, that it can be shadowed or overridden by a same-named cookie from a sibling origin, that the prefix should be added, or that the bare `CONSENT_COOKIE_NAME` export is the defect.

FAIL if it reports any of those.

FAIL also if the file is missing or empty.
