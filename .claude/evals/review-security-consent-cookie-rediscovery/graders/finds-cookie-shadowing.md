---
type: llm
weight: 2
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of the guest site's cookie and third-party consent framework. The consent cookie is written under the bare name `cire_consent`, with no `__Host-` prefix, so a script on any sibling origin under the same registrable domain can set a `Domain`-scoped cookie of the same name that shadows a guest's stored refusal. `Secure`, `HttpOnly` and `SameSite` do not close this. Browsers reject a `__Host-` cookie over plain http, which breaks local development unless the fix handles it.

PASS if the review carries a finding, not a dismissed note, that the cookie's bare name lets a script on a sibling origin set a same-named cookie that shadows the guest's stored decision.

FAIL if the finding is absent, the sibling-origin vector is raised and dismissed, or the cross-subdomain consequence is missing.

FAIL also if the file is missing or empty.
