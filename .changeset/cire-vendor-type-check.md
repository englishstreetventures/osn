---
"@cire/vendor": patch
---

Put `@cire/vendor` behind `astro check` and fix the six type errors that had
accumulated while it was outside the gate.

The package had no `check` script, so `bun run check` silently skipped it — the
portal was the only Astro app in the repo not type-checked, and `cire/organiser`
is maintained as its twin, so the pair had been drifting. Adds the script (and
the `@astrojs/check` + `typescript` devDependencies the organiser already has),
which takes the turbo `check` task from 24 packages to 25.

The errors it was hiding, all pre-existing:

- `ListingEditor.test.tsx` / `OrgPicker.test.tsx` rendered `AuthProvider` with
  `config={{ issuerUrl }}` — a leftover from the pre-OIDC `@osn/client`
  provider. `@shared/rp-auth`'s config field is `apiBase`, so the tests were
  passing an object the provider never read.
- `SignInPanel.test.tsx` declared its `resumeSession` mock zero-arity while
  spreading arguments into it; matches the organiser's `(..._args: unknown[])`
  signature now.
- `VendorEnquiryThread.test.tsx` had the same spread-arity mismatch on
  `friendlyEnquiryError`.
- `VendorApp.tsx` passed a function child to a non-`keyed` `<Show>`. The child
  never used the resolved value, so it becomes a plain element — which is what
  that overload wants, and what was actually intended.
