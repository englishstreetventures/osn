---
"@osn/api": patch
"@osn/client": patch
---

Stop a bot fleet from spending half the daily Worker budget on pointless
`POST /token` grants. Roughly 33k requests a day were arriving at
`osn-api-production` from one AWS region, all of them anonymous bootstrap
grants fired by page loads of the `osn-social.pages.dev` copy of the app.

Two causes, both fixed here:

- **The client asked for a session it had no reason to think existed.** A
  cold page load with no stored account always replayed the cookie against
  `/token`, even in a browser that had never signed in. The API now sets a
  readable `osn_has_session` marker cookie beside the HttpOnly session cookie;
  the client skips the grant when the marker is absent. The marker holds no secret — a forged one buys a single
  400. It carries `Domain` from the new `OSN_COOKIE_DOMAIN` var, because the
  issuer (`id.musubi.social`) and the app (`musubi.social`) are different
  hosts; the session cookie itself stays `__Host-` and host-only. Where there
  is no `document` — iOS, SSR — the gate is inert.

- **Every refusal was retried as if it were a blip.** A cross-origin CORS
  refusal surfaces as an opaque `TypeError`, indistinguishable from a network
  failure, and the client ran the full transient ladder over it: three
  requests per blocked page load. The network path now retries once. A real
  transient status (429/5xx) keeps the full ladder.

The session cookie is never cleared on a rejected grant — that path also
covers a storage blip, and clearing would harden a transient failure into a
permanent logout.
