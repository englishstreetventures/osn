---
"@shared/db-utils": patch
"@osn/api": patch
---

The rows-affected guard (`tests/no-raw-rows-affected.test.ts`) runs as `@shared/db-utils`'s `test:repo` task, whose inputs are the Worker source trees it scans, so turbo reruns it whenever one of them changes instead of replaying a cached result. osn-api reads a change notice's fields by destructuring, so the guard no longer mistakes `notice.changes`, the notice's list of change lines, for a driver's rows-affected count; the notice digest is unchanged.
