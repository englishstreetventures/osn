---
"@pulse/api": patch
---

Emit nullable fields in the OpenAPI document as a JSON Schema type array rather than an `anyOf` with a `null` member.

`anyOf: [X, { type: "null" }]` is correct for OpenAPI 3.1, but swift-openapi-generator has no representation for it: it warns `Schema "null" is not supported` and drops the property from the generated client entirely. That was 254 occurrences — around half of every event field, including `latitude` and `longitude`. `type: ["number", "null"]` is equivalent and generates `Swift.Double?` with no warning, so `generate-openapi.ts` now rewrites one into the other. Unions of string constants collapse to an `enum` at the same time, which is the only spelling a type array can carry.

The served routes and their runtime validation are unchanged — this only affects how the committed document describes them.
