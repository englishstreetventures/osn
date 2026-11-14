---
"@tools/lab": patch
---

The lab depends on `@osn/client` and gains `osn/auth-ui/SignIn`: `Default`, the sign-in view a signed-out person sees in musubi's "Sign in" dialog at `md` and up, and `Phone`, the same view in the 320px sheet musubi opens below `md`. Both frames are unpadded, as musubi's dialog is, and `SignIn` gets every client musubi passes it, so "Lost your passkey?" opens the same recovery chooser. It is the first `@osn/auth-ui` story that calls `useAuth`, and follows §Stories for auth and cire components: a fixed signed-out value through `AuthContext.Provider`, and stub clients whose calls never answer.
