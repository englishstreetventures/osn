---
"@cire/api": patch
"@cire/db": patch
---

Add a disposable preview tier so a feature branch can be reviewed on real
infrastructure: `api-preview.cireweddings.com`, `invite-preview.cireweddings.com`
and `cire-organiser-preview.pages.dev`, deployed by
`.github/workflows/deploy-cire-preview.yml`.

The preview API runs `--env preview` against its own D1 (`cire-db-preview`) and
the `-preview` R2 buckets, so a branch's migrations — including destructive ones
— run against disposable data and production is never touched. That separation
is the point: a schema change cannot be reviewed end-to-end until the schema has
actually changed.

Identity is shared with production (a reviewer signs in with their real
passkey). `ZAP_API_URL` is deliberately unset on the preview env so
vendor-enquiry delivery fails closed — a preview must never email a real vendor.
`cire/db/seed/preview-seed.sql` seeds three sample invites that differ only in
colour scheme. See `[[preview-tier]]`.
