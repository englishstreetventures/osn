---
title: OSN and Musubi
aliases:
  - what is OSN
  - what is Musubi
  - naming
tags:
  - architecture
  - conventions
related:
  - "[[monorepo-structure]]"
  - "[[identity-model]]"
  - "[[oidc-provider]]"
  - "[[musubi-identity-migration]]"
last-reviewed: 2026-09-17
---

# OSN and Musubi

Two names, two things. They were entangled until 2026-09-09: "OSN" meant the
concept, the package prefix, the deployed Worker, the repository, the token
audience and the environment variables, while "Musubi" meant nothing but a set
of hostnames. This page is the line between them.

## The definitions

**OSN** — the *system*. A specification, plus the headless core that implements
it: identity, the social graph, authorisation, and the OpenID Connect issuer. It
ships no user interface. Anyone can run it for their own private social graph.

**Musubi** — *our implementation*, and the product built on it: the social app,
its marketing site, the brand, and `musubi.social`, the instance we host.

**An instance** — a deployment. `musubi.social` is ours. Someone else's
deployment is theirs, and is not Musubi.

> [!note] The analogy
> Musubi is to OSN as Mastodon is to the fediverse. Mastodon is server software
> and a hosted flagship; the fediverse is the thing several implementations
> agree on.

## The rule

> [!important] The discriminator
> If an independent implementation must use the same string to interoperate, it
> is **OSN**. Otherwise it is **Musubi**.

That settles new cases without re-arguing the definitions. It also lands the
cost where it belongs: the strings that are expensive to change — token
audiences, well-known paths, claim names — are exactly the ones that stay OSN.

## What is which

| | OSN — the system | Musubi — our implementation |
|---|---|---|
| Packages | `@osn/api`, `@osn/db`, `@osn/client`, `@shared/osn-auth-client` | `@musubi/social`, `@musubi/landing` |
| Directory | `osn/` | `musubi/` |
| Identifiers | `aud: "osn-access"`, `aud: "osn-step-up"`, `/.well-known/jwks.json`, claim names, pairwise `sub` derivation, ARC token format | WebAuthn RP ID `musubi.social`, the hosted instance's configuration |
| Surfaces | none — the core is headless | `musubi.social`, `id.musubi.social` |
| Product label | `product:osn-core` | `product:musubi` |

### Where the UI packages landed

Applying the discriminator to user-interface code: no independent
implementation has to spell `Button`, `Card` or `Modal` the way we do in order
to interoperate, so none of it is OSN. It is also not Musubi's alone — cire and
pulse render the same primitives. That makes it neither, and it lives under
`shared/`:

| Package | Holds | Why there |
|---|---|---|
| `@shared/ui` | The primitives — `Button`, `Card`, `Modal`, `Field`, `Table`, the rest, plus `cn()`/`clsx()` | Interoperation never depends on them; five products consume them |
| `@osn/auth-ui` | The auth views — `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`, `RecoveryCodesView`, `SessionsView`, `TotpView`, `ChangeEmailForm` | Each one is a client of a named OSN ceremony, and its shape is fixed by that protocol, not by our styling |
| `@cire/ui` | cire's house style — gold primary, 4px corners | One product's own chrome |

`@osn/auth-ui` is the line's real test. It renders `@shared/ui` primitives, so
it looks like product code; what keeps it in `osn/` is that every view is
paired with an endpoint in the spec, and an independent implementation
rebuilding those ceremonies would rebuild these screens too.

`@shared/rp-auth` is a relying-party helper that works against any OSN issuer,
so it is not Musubi's either, and sits under `shared/` for the same reason.

The repository is still called `xchromo/osn` and the Cloudflare Pages projects
are still called `osn-social`, `osn-social-dev` and `osn-landing`. Neither is
observable by a third party, and renaming a Pages project attached to a live
apex is a deploy operation rather than a rename.

> [!warning] `osn-social` is not `osn/social`
> One character apart, different things. `osn-social` is a Cloudflare Pages
> project and must not be renamed; `osn/social` was a filesystem path and is
> now `musubi/social`. Both appear within a few lines of each other in
> `wiki/shared/production-deploy.md`. Never run a blind find-and-replace
> across this vault.

## Why the social lens stays in the spec

OSN's graph is general. Edges carry their own semantics, so `follows` and
`reports-to` are the same primitive with different labels. A corporate
directory is therefore a *profile* of OSN — the same identity-and-edges model
plus a policy layer — rather than a different product that would need the
social framing stripped out of the specification.

## What has not happened yet

There is no separate specification repository, and no formal conformance
surface. OSN today is the reference implementation plus the wire contract it
defines. Extracting a written specification waits until a second implementer
exists; doing it earlier would mean maintaining a document nobody reads against
a contract only one codebase uses.

Related: [[monorepo-structure]] for the directory layout, [[identity-model]] for
the account and profile model, [[oidc-provider]] for the issuer contract, and
[[musubi-identity-migration]] for how identity reached `musubi.social` in the
first place.
