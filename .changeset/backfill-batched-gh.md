---
"@tools/pr-metrics": patch
---

Batch `backfill`'s GitHub calls: commit counts come from one GraphQL document
per 50 pull requests instead of a REST call each, and the changed-file lists are
fetched eight at a time rather than serially. A `--limit 25` dry run goes from
14.87s to 3.75s with identical output.
