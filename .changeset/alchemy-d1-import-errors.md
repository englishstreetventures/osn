---
"@shared/infra": patch
---

Patch alchemy's D1 import so a failed seed import reports Cloudflare's error instead of `D1 import poll missing bookmark`.

`patches/alchemy@2.0.0-beta.83.patch` changes `Cloudflare/D1/ImportDatabase` in both `src/` (what Bun loads in a deploy) and `lib/`. Every reply — init when it has no upload URL, ingest, and each poll — is now read as wrangler reads it: a failure dies with Cloudflare's error, or with the reply when it carries none; completion ends the import, with or without a result; a reply still in progress is polled again with its bookmark one second later. An envelope with no result, or one that is not JSON, dies with its content. When Cloudflare already holds a file with the same content, init returns no upload URL and the import it starts is polled, where alchemy used to fail. No message carries the presigned upload URL: a failed upload reports only R2's error code and message, or the kind of error when it cannot connect.

`shared/infra/tests/d1-import.test.ts` runs both copies against a scripted Cloudflare API and fails if the patch stops applying.
