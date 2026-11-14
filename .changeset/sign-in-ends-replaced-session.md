---
"@osn/api": patch
---

Every route that sets a new session cookie (passkey sign-in, recovery-code sign-in, the sign-up, email-recovery and cross-device polls, TOTP recovery, and dev sign-in) now ends the family of the session cookie the request carried, once the new session exists. A `/token` grant sent with the old cookie that answers after the sign-in can then never leave a live old session in the browser: its rotated cookie names no session, and the next renewal with it is refused. A sign-in with no cookie, or one that is refused or not finished, ends nothing; a failure to end the old family is logged and the sign-in still answers with its cookie.
