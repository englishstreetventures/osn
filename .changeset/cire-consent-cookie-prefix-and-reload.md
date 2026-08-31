---
"@cire/invites": patch
---

Two consent-cookie fixes.

S-L1 (osn-tracker#163): the `cire_consent` cookie now writes as
`__Host-cire_consent` whenever the document is on a secure origin, so a
script on a sibling `*.cireweddings.com` origin can no longer plant a
`Domain`-scoped cookie of the same name and silently override a guest's
stored refusal back to "allowed". Reads accept both names and prefer the
prefixed one, so an existing guest's choice survives the change and a
planted domain cookie can never outrank it. Falls back to the bare name on
http dev, where `__Host-` cookies are rejected outright.

CON-S-M1 (osn-tracker#162): withdrawing consent for a category with a
`"gated"` vendor (currently `embeds` — Pinterest, Google Maps) now reloads
the page, so a third party's already-executed globals, listeners and
storage are actually torn down rather than merely stopped from loading
further. The reload only fires on a granted → revoked transition, and only
once a read-back of `document.cookie` confirms the refusal was actually
persisted — a reload on a failed write would have thrown the refusal away
on the very reload meant to enforce it.
