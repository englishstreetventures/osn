# @shared/openapi-tools

## 0.1.0

### Minor Changes

- 87bd5f8: Generate an OpenAPI document for `@osn/api`, and share the post-processing with `@pulse/api`.

  `@osn/api` now mounts `@elysiajs/openapi` and gains an `openapi:generate` script that boots the real app, fetches its own `/openapi/json`, and writes `shared/openapi/osn.json` — the same pipeline Pulse already used, so the committed spec cannot drift from what the app serves. CI regenerates both documents and fails on a diff.

  The ~290 lines of document post-processing that lived in Pulse's generator script moved to a new `@shared/openapi-tools` package, now covered by tests. `shared/openapi/pulse.json` regenerates byte-identical.

  The ARC-gated internal routes (`/graph/internal/*`, `/organisations/internal/*`, `/internal/*`) are excluded from the OSN document: only other OSN services call them, and they authenticate with signed ES256 tokens rather than a user session.
