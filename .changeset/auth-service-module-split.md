---
"@osn/api": patch
---

Refactor the auth monoliths into module directories, behaviour-preserving. `services/auth.ts` (~4,500 lines) becomes `services/auth/` — domain factories (profiles, registration, tokens, passkeys, passkey management, profile switch, sessions, recovery, security events, step-up, email change, cross-device) composed over a shared `AuthContext` by `index.ts`; the three duplicated security-notification mailers collapse into one shared helper. `routes/auth.ts` (~1,800 lines) becomes `routes/auth/` — one Elysia route group per domain over a shared `AuthRouteContext`, mounted by `index.ts`. Public surfaces and import paths are unchanged.
