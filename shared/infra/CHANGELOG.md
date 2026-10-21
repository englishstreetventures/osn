# @shared/infra

## 0.1.0

### Minor Changes

- f7a4c9f: Add `@shared/infra`: Alchemy pinned at 2.0.0-beta.83 with one Effect copy, builders for API Workers, static-assets Workers and retained D1 databases and R2 buckets, stage and naming rules, the credential names for each tier's Cloudflare account, the secret inventory for every deployed Worker and tier with `requireSecrets()`, read-only checks of the inventory against live Workers and GitHub Environments, a check that a tier's token reaches only its own account, and scripts to bootstrap and check a tier's Alchemy state store. Nothing deploys through it yet.
