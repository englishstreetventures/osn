---
"@pulse/api": patch
---

Name the shared response schemas (`Event`, `Rsvp`, `Series`, `Venue`) with Elysia's `.model()` and reference them with `t.Ref`, so the OpenAPI document hoists each into `components/schemas` once instead of inlining it at every route. The spec generator resolves the bare `$ref` names TypeBox emits for nested refs, and fails the build on a name that matches no component.
