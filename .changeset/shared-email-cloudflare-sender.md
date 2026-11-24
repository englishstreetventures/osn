---
"@shared/email": patch
"@osn/api": patch
---

The Cloudflare fallback email transport sends Cloudflare's documented Email Sending request: it posts to `/accounts/{id}/email/sending/send`, with `to` and `from` as `{ address, name? }` objects. A configured sender of the form `Name <address>` goes out as a display name and a bare address; a bare address goes out unchanged. A malformed sender makes `makeCloudflareEmailLive` throw when the layer is built, and the new `cloudflareSenderProblem` export gives the reason. osn-api checks `OSN_EMAIL_FROM` with it when it selects the Cloudflare transport and refuses to boot on a malformed one, naming the variable.
