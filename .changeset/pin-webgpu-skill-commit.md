---
"@tools/lab": patch
---

Pin the third-party `webgpu-threejs-tsl` skill to the upstream commit it was
installed from, and check the installed tree against its lock on every pull
request.

`skills-lock.json` now records `ref` — commit `af2319bd` of
`dgreenheck/webgpu-claude-skill`, whose `skills/webgpu-threejs-tsl` folder is
byte-identical to ours — written by the pinned CLI itself. The install recipe
in `wiki/conventions/agent-tooling.md` names the CLI version (`skills@1.7.0`),
a `--before` date that puts the CLI's own dependencies under the same
three-day soak as `bun install`, and a commit SHA for the source.

`scripts/check-skills-lock.ts` recomputes the CLI's folder hash, which the CLI
itself never checks again, and fails on an unpinned entry, a folder edited
after install, or a folder with no lock entry.

No file any package ships changes. `@tools/lab` is named because it is the
surface the skill serves, and the gate requires a changeset because the
comments in `oxlintrc.json` and `lefthook.yml` change: both said the CLI
checks the hash on update, which it does not.
