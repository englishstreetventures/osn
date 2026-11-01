// The Worker's module: its fetch/scheduled handler and the Durable Object class
// it hosts. Kept apart from `index.ts` because `@shared/coordination/store`
// imports `cloudflare:workers`, which only workerd provides — Bun tests import
// the handler from `index.ts` and must never load it. Type-checked on its own
// by `tsconfig.entry.json`, against the Workers types.
export { CoordinationStore } from "@shared/coordination/store";
export { default } from "./index";
