---
"@musubi/social": patch
"@osn/auth-ui": patch
"@pulse/web": patch
---

Docs now describe the code as it stands. `musubi/social/DESIGN.md` says ghost and link buttons are pills, default button labels are 14px, and success and warn are allowed within named uses with their contrast measured; it adds focus, motion, the token contract and how Musubi hosts `@osn/auth-ui`, and lists where the code does not meet a rule yet. A new `osn/auth-ui/DESIGN.md` states the `ui-*` contract the package is held to and how its views stand against it, focus included. The `@pulse/web` README names its one backend, the two ways the app reaches it, the third parties the browser calls, and its OIDC sign-in. No source changes; Musubi's token-contract browser test now holds the default Button label at 14px.
