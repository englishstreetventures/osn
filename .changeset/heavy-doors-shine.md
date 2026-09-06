---
"@shared/dev-urls": patch
---

Take @changesets/cli 3.0.1, and make the `privatePackages` setting explicit first.

`@changesets/config` changed its default between the two CLI majors: with no `privatePackages` key, 3.1.4 (used by CLI 2.31.1) resolves `{ version: true, tag: false }`, while 4.0.0 (used by CLI 3.0.1) resolves `{ version: false, tag: false }`. Every one of the 38 workspace packages is `private: true`, so on the new default all of them would be skipped, `versionablePackages` would be empty, and `changeset add` would abort with "No versionable packages found" — breaking the command every PR here is required to run.

Writing `{ "version": true, "tag": false }` into `.changeset/config.json` pins the behaviour the repo already had. Verified as a no-op on 2.31.1 (identical 28-package queue before and after) and then verified again on 3.0.1 by a real `changeset version` pass, which produced correct version bumps and CHANGELOG entries across 66 files.

Because that key is load-bearing and its absence fails loudly but obscurely, `CLAUDE.md`'s Changesets row now records it: a future tidy-up of `.changeset/config.json` would otherwise read the line as redundant and delete it.
