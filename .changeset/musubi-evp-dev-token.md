---
"@musubi/social": patch
"@osn/auth-ui": patch
---

Chrome fills the email verification token on dev Musubi: the dev trial token names `musubi.esv.tools` itself, and the sign-up form sets the hidden field's nonce after the field is in the page.
