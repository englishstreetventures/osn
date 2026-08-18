---
"@osn/api": patch
"@osn/client": patch
"@pulse/api": patch
"@shared/crypto": patch
"@shared/osn-auth-client": patch
---

Clear every `anti-slop/no-conditional-empty-object-spread` hit in application
source and raise the rule from `warn` to `error`. A `...(cond ? { k: v } : {})`
inside an object literal hides an omitted property in the middle of a shape, so
the reader has to run the condition in their head to know what the object
actually holds. Each of the 56 sites is now a named binding built in statements,
with the optional field added after.

Most were option bags handed to a constructor: `cire/api/src/index.ts` and both
Pulse entrypoints (`index.ts`, `local.ts`) now build a typed `AppOptions` and
set the origin, limiter and login-URL fields conditionally, which also makes the
comment explaining each one sit next to the assignment instead of inside a
ternary. `shared/crypto/src/arc.ts` and `shared/osn-auth-client/src/verify.ts`
build a `JWTVerifyOptions` the same way, so the "unset issuer means jose does
not enforce `iss`" rule (X2) is a single readable line.

The rest are wire payloads and drizzle update sets. `pulse/api`'s series
instance update was thirteen consecutive conditional spreads; it is now thirteen
`if` statements over a `Partial<typeof events.$inferInsert>`, same thirteen keys.
`guest-event-draft.ts`, `spreadsheet.ts`, `import.ts` and `zap-bridge.ts` follow
the same shape. `organiser-hosts.ts` gains `HostPersonDto` and `HostSeatDto`, so
the co-host panel's response is a named type rather than an inline literal with
four conditional keys.

Two fixes in `osn/api/src/services/auth/step-up.ts` beyond the rule: the claims
object reuses the exported `StepUpTokenClaims` instead of redeclaring it, and it
is built inside the `Effect.tryPromise` thunk so a throw still maps to
`AuthError`.

Test files still hold 25 hits, all fixture builders folding an optional argument
into a request body, so the rule stays off in the test override.
