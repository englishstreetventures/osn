---
type: llm
weight: 1
focus: { source: file, path: NEW-FEAT.md }
---

The file is a plan for a change wholly under `cire/api`. That needs a changeset naming `@cire/api`, a version-less package that never shares a changeset with a versioned one.

PASS if the plan says a changeset is needed and that it names `@cire/api`, and only version-less `@cire/*` packages.

FAIL if the changeset is missing, names another package, or mixes in a versioned package.

FAIL also if the file is missing or empty.
