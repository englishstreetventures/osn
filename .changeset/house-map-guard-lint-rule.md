---
"@tools/oxlint-house": patch
---

Add `house/no-in-operator-key-guard`, an oxlint rule that fails a type predicate decided by the `in` operator.

`in` walks the prototype chain, so a guard written as `value is keyof typeof MAP` returning `value in MAP` also accepts `constructor`, `toString` and `__proto__` — and then tells every caller downstream that an inherited `Object.prototype` member is a real entry in the map. `Object.hasOwn(MAP, value)` asks the question the guard meant to ask.

The rule matches the parameter the predicate narrows rather than the literal `keyof typeof` syntax, so it catches the aliased form too. It stays quiet on a string-literal discriminant (`"foo" in value`), on `#brand in value`, and on any `in` outside a type predicate.

The rule lives in a new `@tools/oxlint-house` workspace, kept separate from the vendored `tools/oxlint/anti-slop` tree, which is a verbatim upstream copy and must not gain files.
