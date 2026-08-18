---
"@osn/api": patch
"@osn/client": patch
"@osn/social": patch
"@pulse/api": patch
"@pulse/web": patch
"@shared/crypto": patch
"@shared/db-utils": patch
"@shared/feature-flags": patch
"@shared/observability": patch
"@shared/openapi-tools": patch
"@shared/osn-auth-client": patch
---

Clear every `anti-slop/no-unsafe-dictionary-type` hit in application source and
raise the rule from `warn` to `error`. `Record<string, unknown>` says only "an
object with string keys" — it accepts any key, guarantees no field, and hides
whichever shape the code actually meant. Each of the 67 hits was one of four
things, and each got a different fix.

**A shape that was always known.** `@shared/crypto` exports an `Es256Jwk`
interface and `validateEs256Jwk` asserts against it, so `importKeyFromJwk` takes
`unknown` and does the checking itself instead of trusting a caller's cast —
`@osn/api`'s boot path now hands it the raw string. `@osn/api`'s auth helpers
name the four claim sets it signs (`AccessTokenClaims`, `StepUpTokenClaims`,
`IdTokenClaims`, `OidcAccessTokenClaims`), and `verifyJwt` returns a
`VerifiedJwtClaims` whose every field stays `unknown` on purpose: one key signs
all four sets, so callers must still narrow on `aud`. `@pulse/api`'s account
export becomes a discriminated union on `section`, so a reader that switches on
the tag knows exactly which record fields it has.

**A drizzle update set.** `@osn/api`'s organisation update and both `@cire/api`
registry updates are typed `Partial<typeof table.$inferInsert>`, so a key that
isn't a column fails at the assignment rather than at the D1 boundary.
`@shared/db-utils` replaces seven `S extends Record<string, unknown>` schema
constraints with a real `DrizzleSchema`.

**An untrusted payload.** The CSP report normaliser, the osn-bridge org
decoder, the crop validator and the guest claim-response guard now name the
wire shape with every field left `unknown`, or narrow with `in` and drop the
stand-in type entirely. Nothing gains a guarantee the wire never made.

**A cast that was hiding a working type.** `@shared/feature-flags` uses
GrowthBook's own `FeatureDefinitions` / `SavedGroupsValues`, which removes the
`payload as never` at `initSync`. `@shared/observability`'s redactor and
`@shared/openapi-tools`' normaliser drop casts their narrowing had already
earned; `generate.ts` now throws on a non-object OpenAPI document instead of
asserting one. `@osn/api`'s public-error walker reads through
`Object.getOwnPropertyDescriptor` rather than indexing a widened object.

Test files still hold 102 hits — nearly all a stub request body or a drizzle row
the test then asserts on field by field — so the rule stays off in the test
override.
