---
"@tools/lab": patch
---

The lab depends on `@osn/client` and gains `osn/auth-ui/SignIn` → `Default`: the sign-in view a signed-out person sees in musubi's "Sign in" dialog, in a frame that dialog's width. It is the first `@osn/auth-ui` story that calls `useAuth`, so it sets the pattern for the rest: a fixed signed-out value through `AuthContext.Provider`, and stub clients whose every call never answers, so Continue holds at "Verifying…" and nothing reaches an issuer.
