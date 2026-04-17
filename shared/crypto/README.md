# @osn/crypto

Cryptographic primitives used across the OSN identity stack.

Currently exports **ARC tokens** (ASAP-style ES256 JWTs for
service-to-service authentication between OSN components and third-party
apps that need to call OSN APIs without a user context). See the "ARC
Tokens" section of the root `CLAUDE.md` for the full protocol.

```ts
import { createArcToken, verifyArcToken, getOrCreateArcToken } from "@osn/crypto/arc";
```

Signal Protocol primitives for E2E messaging are planned but not yet shipped.

## Consumed by

`@osn/core` (for verifying incoming ARC tokens from third-party callers)
and any future `@pulse/api` endpoints that need to call OSN over HTTP.
