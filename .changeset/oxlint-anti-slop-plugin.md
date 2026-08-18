---
"@osn/api": patch
---

Adopt the `anti-slop` oxlint plugin, vendored at `tools/oxlint/anti-slop` from
upstream commit `446268e`. The rules target the type-system escape hatches that
generated code reaches for instead of modelling the domain — chained `as`
assertions, `unknown` in signatures, `object` parameters, runtime `typeof`
branching, index-signature dictionaries.

Upstream ships all 15 rules at `error`. Enabling them here produced 4686
diagnostics across 541 files, so `oxlintrc.json` runs them as a ratchet
instead: seven rules that are already clean in application source are `error`,
five with bounded debt are `warn`, and three whose debt runs into the hundreds
or thousands are `off` with the counts recorded inline. A test override turns
off the rules whose only violations are test idioms — `Reflect.get` in Proxy
traps, `vi.mock`, `body: object` request helpers.

No behaviour change: `bun run lint` still reports zero errors.
