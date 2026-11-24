---
"@musubi/infra": patch
---

Production osn-api sends account email as `Musubi <hello@musubi.social>` instead of `hello@cireweddings.com`, so sign-up, step-up and recovery codes come from Musubi's own verified domain and no longer share cire's sending reputation. `OSN_EMAIL_FROM` in `osn/api/wrangler.toml` matches it.
