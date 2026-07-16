---
"@cire/web": patch
---

Fix the broken guest-site (cire/web) production deploy: strip the unsupported
`legacy_env` field from the adapter-generated Worker config before `wrangler
deploy`.

`@astrojs/cloudflare` writes a top-level `"legacy_env": true` into the generated
`dist/server/wrangler.json`. Wrangler **4.111.0 removed support** for that field
and now hard-errors (`The "legacy_env" field is no longer supported`). Because
`cire/web` pins no wrangler, the deploy job's `bunx wrangler` fetches the latest,
so the guest-site deploy has failed on every merge since 4.111 shipped —
`cireweddings.com` was frozen at the last-good build (the site stayed up; new
`cire/web` changes just stopped reaching prod). `cire-api` was unaffected: it
uses a hand-written `wrangler.toml` (no `legacy_env`) and pins `wrangler ^4.96`.

`deploy.yml`'s `deploy-cire-web` job now deletes `legacy_env` from the generated
config between build and deploy. Removing it is behaviour-neutral — `legacy_env:
true` was already the default (each environment deploys as its own Worker), so
the deploy is byte-identical minus the rejected field. Verified by building
`cire/web` and running `wrangler@4.111.0 deploy --dry-run` against the stripped
config: it bundles + validates cleanly (no second unsupported field behind it).
