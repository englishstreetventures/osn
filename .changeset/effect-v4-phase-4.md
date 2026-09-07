---
"@osn/api": patch
"@osn/client": patch
"@pulse/api": patch
"@zap/api": patch
---

Migrate the Effect Schema surface of the four service packages to v4.

v3's constraint combinators are v4 *checks*, applied through a schema's
`.check(...)` rather than `.pipe(...)`: `maxLength`/`minLength`/`minItems`/
`maxItems` collapse onto `isMaxLength`/`isMinLength`, `int` becomes `isInt`, and
`between(a, b)` becomes `isBetween({ minimum, maximum })` — still inclusive at
both ends, so no range moved. `Schema.filter` becomes
`Schema.check(Schema.makeFilter(…))`, and because a v4 filter carries its own
failure message in its return value, the `{ message: () => "…" }` option becomes
the predicate returning that string; every validator keeps its exact wording.
`Schema.Literal` takes a single literal, so enums (and the spreads over
`SUPPORTED_CURRENCIES`, `SHARE_SOURCES` and `INTEREST_CATEGORIES`) become
`Schema.Literals([…])`. `Schema.decodeUnknown` becomes
`Schema.decodeUnknownEffect`, and `Schema.Record` takes its key and value
positionally.

Three copies of a workaround are deleted rather than ported. `@pulse/api`'s
events, series and discovery services each carried a hand-rolled "validate the
string, then transform to a Date" pair because v3's `DateFromString` accepted a
string that parses to an Invalid Date. v4's rejects it, so all three are now
`Schema.DateFromString`.

`@osn/client`'s `isAuthExpiredError` keeps all three of its arms, but the
comments no longer claim a `FiberFailure` is what arrives: v4 removed the
wrapper and `runPromise` rejects with the squashed error itself, so `instanceof`
now carries the common path. The printout arm stays for a consumer bundle built
against v3, and for any boundary that strips both the prototype and the `_tag`.

Every migrated check was verified to still *reject*, not merely type-check.
