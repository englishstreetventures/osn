# @shared/osn-auth-client

Verifies OSN-issued access tokens (ES256, `aud: "osn-access"`) via JWKS
with an LRU cache (5-min TTL, blocking refetch on expiry) and
rotation-aware refresh on verification miss. Ships framework-agnostic
primitives; each service builds its own middleware on them (cire's is
`cire/api/src/middleware/osn-auth.ts`).

## Verify a request

```ts
import { extractClaims, type OsnAuthOptions } from "@shared/osn-auth-client";

const claims = await extractClaims(req.headers.get("authorization") ?? undefined, jwksUrl, {
  audience: "osn-access",
});
```

`OsnAuthOptions` is the options shape a service's middleware takes: the JWKS
URL, the audience and, optionally, the issuer.
