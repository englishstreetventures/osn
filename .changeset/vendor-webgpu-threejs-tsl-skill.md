---
"@tools/lab": patch
---

Vendor the third-party `webgpu-threejs-tsl` skill (`dgreenheck/webgpu-claude-skill`)
so WebGPU and TSL guidance reaches every agent session working in `@tools/lab`,
remote and CI included. `npx skills add` puts the text in
`.agents/skills/webgpu-threejs-tsl/` with a `.claude/skills/webgpu-threejs-tsl`
symlink to it and a root `skills-lock.json` holding the hash the CLI wrote at
install time and checks on update.

No file any package ships changes, so no package is a wholly honest name for
this; `@tools/lab` is the surface the skill exists to serve, and the gate
requires a changeset because the commit touches `oxlintrc.json` and
`lefthook.yml` — two of the files that decide whether a guard runs at all.

Those two, and three more, keep our tooling out of someone else's text:
`oxlintrc.json` ignores `.agents` and the symlink path both — oxlint walks
through the link and reports the same file under its second name — both lefthook
pre-commit commands exclude `.agents/**`, and `skill-eval.yml`'s quality loop now
skips a symlinked skill, because a finding we fix in the installed folder
either stops the next `npx skills update` or is thrown away by it. The same workflow's trigger paths gain `.agents/skills/**`
and `skills-lock.json`, so an update — which touches nothing under `.claude/` —
still reaches the review gate. `.github/CODEOWNERS` gains rules for both
paths again, as it must whenever such a tree exists: it is someone else's
instructions running with full agent permissions. The changeset allowlist in
`scripts/changeset-required.sh` never lost its two arms — they were left in
place and labelled retired — so the change there is to the comments that say
why they exist, plus a test case per arm.
