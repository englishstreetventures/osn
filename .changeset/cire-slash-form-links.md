---
"@cire/landing": patch
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
"@cire/ui": patch
"@cire/api": patch
"@tools/e2e": patch
---

Cire's own links reach each page of its sites in one request. The marketing site's footer, privacy row and legal pages, the guest site's privacy and terms links, the portals' sign-in redirects and the claim page, and cire-api's vendor claim email and sign-in failure landings all name the page with its trailing slash (`/privacy/`, `/login/`, `/claim/?token=…`), the address the sites serve it at, rather than the slash-less address that Cloudflare's asset server redirects. A check after the build fails on any such link that drops the slash.
