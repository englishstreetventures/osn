// The Worker's module: its fetch/scheduled handler and every Durable Object
// class it hosts. Kept apart from `index.ts` because `@shared/realtime/hub`
// imports `cloudflare:workers`, which only workerd provides — Bun tests import
// the handler from `index.ts` and must never load it.
export { TopicHub } from "@shared/realtime/hub";
export { default } from "./index";
