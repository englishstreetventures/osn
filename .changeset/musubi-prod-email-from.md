---
"@musubi/infra": patch
"@osn/api": patch
---

Production osn-api sends account email as `Musubi <hello@musubi.social>` instead of `hello@cireweddings.com`, so sign-up, recovery and step-up links and security notices come from Musubi's own verified domain and no longer share cire's sending reputation. `OSN_EMAIL_FROM` in `osn/api/wrangler.toml` matches it.
