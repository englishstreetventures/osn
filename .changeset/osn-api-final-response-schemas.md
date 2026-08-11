---
"@osn/api": patch
---

Describe the response bodies of the last nine operations: profiles, recommendations, account erasure and account export. Every operation in the OpenAPI document now declares its success and error shapes, so a generated client no longer has to guess.

Account export keeps its 200 out of the `response` map on purpose — the success path streams a raw NDJSON `Response`, and an Elysia response schema is a runtime validator as much as a document. It is described through `detail.responses` instead.
