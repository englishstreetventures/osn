---
"@shared/db-utils": patch
"@osn/api": patch
---

The rows-affected guard (`tests/no-raw-rows-affected.test.ts`) runs as `@shared/db-utils`'s `test:repo` task, whose inputs are the Worker source trees it scans and every Worker's Wrangler config, so turbo reruns it whenever one of them changes. It flags a member, bracket or destructured read of `changes` or `rowsAffected` taken from anything but a plain name, and fails when a Worker that binds D1 is not scanned. osn-api reads a change notice's fields, among them `changes`, its list of change lines, by destructuring the notice; the notice digest is unchanged, and a test pins it.
