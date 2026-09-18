---
"@shared/ui": minor
"@osn/auth-ui": major
"@shared/design-tokens": minor
"@shared/toast": minor
"@musubi/social": patch
"@pulse/web": patch
"@tools/lab": patch
"@tools/metrics": patch
---

Split `@osn/ui` into `@shared/ui` and `@osn/auth-ui`, and re-key the design-token
contract from `--osn-*` to `--ui-*`.

`wiki/architecture/osn-and-musubi.md` states the discriminator: if an independent
implementation must use the same string to interoperate, it is OSN; otherwise it
is not. A `Button` fails that test — nobody has to spell it the way we do — so
the primitives were never OSN's, and the old page carved them out by hand
("it keeps its name because `@pulse/web` and `tools/lab` consume it as well")
rather than applying the rule. The carve-out is gone.

| Was | Is | Holds |
|---|---|---|
| `@osn/ui/ui/*`, `@osn/ui/lib/utils` | `@shared/ui/ui/*`, `@shared/ui/lib/utils` | The primitives: `Button`, `Card`, `Modal`, `Field`, `Table`, `cn()` |
| `@osn/ui/auth`, `@osn/ui/auth/*` | `@osn/auth-ui`, `@osn/auth-ui/*` | The auth views: `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`, … |

`@osn/auth-ui` stays under `osn/` because every view in it is the client half of
a named ceremony in the spec — its shape is fixed by the protocol, not by our
styling — and it now depends on `@shared/ui` like any other consumer. Its
subpaths flatten (`@osn/ui/auth/SignIn` → `@osn/auth-ui/SignIn`), and the
package's bare specifier is the barrel that `@osn/ui/auth` used to be.

The token prefix moves with it. `--ui-surface` becomes `--ui-surface`,
`bg-ui-ground` becomes `bg-ui-ground`, `.ui-toast` becomes `.ui-toast`, and
`--ui-modal-enter` becomes `--ui-modal-enter`. A prefix naming the system a
component is *not* part of was the last thing asserting the old shape. Apps map
the new names in exactly one place each, the contract block in their global
stylesheet.

The rename was driven by an explicit allowlist of the contract's own token
suffixes rather than a blanket `osn-` → `ui-` substitution, because the same
compound shape carries protocol identifiers that must not move: `osn-access`,
`osn-step-up`, `osn-kid`, `osn-pairwise-salt`, the `osn-api`/`osn-social`
Cloudflare project names. A missed token fails safe by staying `osn-`; a
mangled audience string would not.

One string is deliberately left spelled the old way: `ProfileOnboarding`'s
`localStorage` key. Every browser that has already dismissed that prompt holds
it under `@osn/ui:profile_onboarding_dismissed`, and renaming the key would show
the prompt again to exactly the people who said no.
