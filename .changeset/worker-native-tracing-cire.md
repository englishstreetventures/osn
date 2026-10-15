---
"@cire/api": patch
"@cire/host": patch
"@cire/invites": patch
---

Update Wrangler and enable native tracing on the Cire guest Worker. Production traces redact query strings; existing path-based guest links remain supported, and newly generated links use fixed routes with slugs in the query. The fixed routes look the wedding up through `POST /api/invite/resolve`, which answers the guest Worker's server-side call (no `Origin`) and treats a malformed slug as not found; they answer an API error as the path routes do, with the invitation shell. Production API tracing remains off while its path-bearing spans are reviewed.
