---
"@shared/crypto": minor
"@shared/osn-auth-client": minor
"@osn/api": minor
"@osn/db": patch
"@zap/api": minor
"@pulse/api": minor
"@shared/infra": minor
"@zap/infra": patch
"@musubi/infra": patch
---

osn-api's outbound ARC key ids can carry a MAC under `OSN_ARC_KID_SECRET`, a secret held for that alone, beside the one under `INTERNAL_SERVICE_SECRET`. `@shared/crypto/arc-kid` takes both secrets (`ArcKidSecrets`): `mintArcKid` puts one MAC in the kid for each secret of at least 32 characters, and `checkArcKid` admits a kid one of whose MACs verifies under a secret the app holds, answering what to look the key up by (`ArcKidLookup`), or `null`. A checked kid is looked up and cached by the `<uuid>.<expiry>` its verified MAC covers, through the new `names` argument of `resolvePublicKeyForKid` (`@shared/osn-auth-client/jwks-cache`), never by a part the app did not verify. `OsnArcVerification` takes `kidSecret` and `serviceSecret`. osn-api, Zap and Pulse read `OSN_ARC_KID_SECRET`; unset, each behaves as before. osn-api warns once per key, naming the secret, when either is too short to key a MAC. Every Worker ignores a kid secret equal to the service secret, and osn-api warns of it. The inventory lists the secret as optional for osn-api, zap-api and cire-api on dev and production, one value per tier; dev refuses one under 32 characters, or equal to `INTERNAL_SERVICE_SECRET` on a Worker holding both.
