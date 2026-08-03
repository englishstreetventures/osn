---
"@osn/client": minor
"@pulse/app": patch
---

Keep the auth session out of `localStorage` on iOS.

`@osn/client` promotes its in-memory `Storage` layer to a real export,
`createEphemeralStorage()` (was test-only `createMemoryStorage`), and
`AuthProvider` (`osn/client/src/solid/context.tsx`) gains an optional `storage`
prop that defaults to `StorageLive`. `@pulse/app` passes
`createEphemeralStorage()` on an iOS Tauri webview (`App.tsx`), so no access
token or account metadata ever reaches `localStorage` there — the session
still survives a cold start through the Keychain-backed refresh cookie
(`bootstrapFromCookie`). Browser and desktop Tauri behaviour is unchanged.

The `isIosWebview()` platform check moves out of `nativeSession.ts` into its
own module, `pulse/app/src/lib/platform.ts`, so both `nativeSession.ts` and
`App.tsx` can use it.
