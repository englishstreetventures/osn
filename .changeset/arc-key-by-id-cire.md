---
"@cire/api": patch
---

cire-api asks osn-api for the one ARC key a token names (through `@shared/osn-auth-client`), as the kid came when it holds no `OSN_ARC_KID_SECRET`; osn-api checks that kid itself. Its test stand-in for osn-api answers by kid.
