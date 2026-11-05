---
description: 'A new `@cire/host` component, `SealColourPicker`, that draws its own eyebrow label, its own swatch radio buttons with a colour transition that also fades the focus ring, and a line restating its own heading, beside an `EnvelopePicker` whose changed heading is drawn by hand too. `Eyebrow` and `Button`''s `choice` variant are on the base, out of the diff. Tests whether a design review finds each hand-drawn element and names the shared component that replaces it, catches the animated focus ring and the restating line, leaves the seal''s content colours and a correct `Notice` alone, and invents no measured number it could not take.'
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Review `feat/cire-envelope-seal-colour` for how it looks

You are in a checkout of the repository, on the branch `feat/cire-envelope-seal-colour`. The branch adds a seal-colour row to the host portal's invite builder: four swatches under the envelope picker, chosen and saved at once.

Review this branch's diff against its base for departures from the portal's design system and its shared components, and report your findings in this repository's review conventions.

## Environment

- There is no network. `git push` and every `gh` command will fail. Say where a finding would be filed rather than claiming to have filed it.
- Package tooling is not installed, and there is no browser. Do not run `bun install`, a dev server or the test suite — read the code, the stylesheets and the design documents instead.
- This is a review, not a fix. Do not modify source files.

## Deliverable

Write your findings to `DESIGN-REVIEW.md` at the root of the repository. That file is the only thing that gets read — a finding stated anywhere else does not count as found.
