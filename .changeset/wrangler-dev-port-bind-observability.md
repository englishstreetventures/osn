---
"@shared/observability": patch
---

`test:wrangler` starts `wrangler dev` with `--port 0 --inspector-port 0` and reads the port from its `Ready on` line, in place of ports it picked and closed first, which another bind could take before workerd's.
