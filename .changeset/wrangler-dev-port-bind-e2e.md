---
"@tools/e2e": patch
---

The stack starts Musubi's `wrangler dev` with `--inspector-port 0`, so workerd binds the devtools socket on a port the kernel picks. Wrangler and cire invites' `astro dev` no longer both pick from 9229 and race for it, which made Musubi exit with `Address already in use (socket "direct:1:default")`.
