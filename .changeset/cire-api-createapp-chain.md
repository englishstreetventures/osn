---
"@cire/api": patch
---

Mount every route that needs no Stripe client inside `createApp`'s typed route
chain, and type `createApp`'s return as `AnyElysia`. No route, method, hook or
registration order changes. The comments that said the chain was at
TypeScript's instantiation-depth limit are gone: measured on TypeScript 7.1,
`tsc` reports that error once the chain reaches 99 calls, and the chain makes
66. Only the upgrade routes and the platform webhook still mount after the
chain, because the upgrade service they share exists only with a Stripe
client.
