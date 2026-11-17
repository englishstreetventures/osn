---
"@osn/api": patch
"@pulse/api": patch
"@musubi/infra": patch
---

The local Bun servers listen on the address their own variable names: `OSN_LOCAL_HOSTNAME` for `@osn/api`, `PULSE_LOCAL_HOSTNAME` for `@pulse/api`. Unset, as under `bun run dev`, each listens on every interface. `@musubi/infra`'s check of what osn-api reads on dev lists `OSN_LOCAL_HOSTNAME` among the names the dev stack leaves unset.
