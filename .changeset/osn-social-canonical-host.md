---
"@osn/social": patch
---

Send `osn-social.pages.dev` to `musubi.social` before the app boots. Cloudflare gives every Pages project that subdomain and offers no way to switch it off, and nothing works on it — the WebAuthn RP ID is the custom domain and the API's CORS allowlist names only the custom domain — so a crawler fleet loading it was costing tens of thousands of refused requests a day. Preview deployments (`<branch>.osn-social.pages.dev`) are untouched.
