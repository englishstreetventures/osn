---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of the guest site's consent framework. The consent cookie is written under the bare name `cire_consent`, with no `__Host-` prefix, so a script on any sibling origin under the same registrable domain can set a `Domain`-scoped cookie of the same name that shadows a guest's stored refusal. `Secure`, `HttpOnly` and `SameSite` do not close this. Browsers reject a `__Host-` cookie over plain http, which breaks local development unless the fix handles it.

PASS if the review's fix for the cookie name also handles `__Host-` being rejected over plain http in local development: a development fallback name, or an explicit note that development breaks.

FAIL if there is no cookie-name finding, or its fix says nothing about plain-http development.

FAIL also if the file is missing or empty.
