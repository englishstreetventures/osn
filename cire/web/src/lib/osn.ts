// OSN identity API origin for the optional guest "Link my Pulse account" flow.
// Dev default matches `bun run dev:cire`, which starts @osn/api on :4000.
// Production is the cire deployment's issuer, `id.cireweddings.com` (see root
// CLAUDE.md). Mirrors the organiser portal's `cire/organiser/src/lib/osn.ts`.
export const OSN_ISSUER_URL = import.meta.env.PUBLIC_OSN_ISSUER_URL ?? "http://localhost:4000";
