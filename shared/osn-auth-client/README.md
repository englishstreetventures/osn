# @shared/osn-auth-client

Verifies OSN-issued access tokens (ES256, `aud: "osn-access"`) via JWKS
with an LRU cache and stale-while-revalidate refresh. Ships
framework-agnostic primitives plus per-framework middleware adapters.

## Usage — Hono (cire)

```ts
import { osnAuth } from "@shared/osn-auth-client/middleware/hono";

app.use("/api/organiser/*", osnAuth({
  jwksUrl: process.env.OSN_JWKS_URL!,
  audience: "osn-access",
}));
```

## Usage — Elysia (pulse, osn)

```ts
import { osnAuth } from "@shared/osn-auth-client/middleware/elysia";

new Elysia().use(osnAuth({
  jwksUrl: process.env.OSN_JWKS_URL!,
  audience: "osn-access",
}));
```

## Direct verification

```ts
import { extractClaims } from "@shared/osn-auth-client/verify";
const claims = await extractClaims(req.headers.get("authorization"), jwksUrl);
```
