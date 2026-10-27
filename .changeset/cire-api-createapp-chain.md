---
"@cire/api": patch
---

Mount the six non-Stripe routes that sat after `createApp`'s typed route chain
(seating, the invite-image read, wedding delete and restore, unlock codes and
the realtime fallback beacon) inside it, in the same order, and type
`createApp`'s return as `AnyElysia`. No route, method, hook or registration
order changes. The comments that said the chain was at TypeScript's
instantiation-depth limit now state the two limits measured on TypeScript 7.1:
`tsc` reports TS2589 once the chain reaches 99 calls (it makes 64), and a
conditional between two of the chain's types fails the type-check, which is
why the app is widened to `AnyElysia` before the conditional Stripe mounts.
The Stripe webhooks and upgrade routes still mount after the chain.
