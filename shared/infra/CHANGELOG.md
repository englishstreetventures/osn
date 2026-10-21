# @shared/infra

## 0.1.1

### Patch Changes

- 569c73b: Dependency maintenance. The `effect` family moves from 4.0.3 to 4.0.5, a
  patch release. Audit fixes take `fast-uri` to 3.1.8, `http-cache-semantics` to
  4.3.0 and `smol-toml` to 1.9.0, and `valibot` is overridden to ^1.4.2 so the
  `@prisma/dev` tree stops pinning 1.2.0. No runtime API changes are expected
  from these bumps; the repo's typecheck and test suites pass, apart from three
  `cire/host` component tests that also fail on the base branch.

## 0.1.0

### Minor Changes

- f7a4c9f: Add `@shared/infra`: Alchemy pinned at 2.0.0-beta.83 with one Effect copy, builders for API Workers, static-assets Workers and retained D1 databases and R2 buckets, stage and naming rules, the credential names for each tier's Cloudflare account, the secret inventory for every deployed Worker and tier with `requireSecrets()`, read-only checks of the inventory against live Workers and GitHub Environments, a check that a tier's token reaches only its own account, and scripts to bootstrap and check a tier's Alchemy state store. Nothing deploys through it yet.
