---
"@cire/api": patch
---

Fix every type error in `cire/api`'s test suite and wire up `bun run check` as
the gate. `tsc -p cire/api/tsconfig.json --noEmit` now reports 0 errors across
the package, tests included, and the package finally has a `check` script so
`bun run check` stops skipping it.

The fixes fall into a few classes:

- Drizzle's `BaseSQLiteDatabase<"sync" | "async", ...>` resolves
  `.select().all()` and `.get()` to `T[] | Promise<T[]>`, which breaks indexing
  and iteration. Test helpers holding a concrete in-memory sync database now
  annotate with the exported `TestDb` rather than the general `Db` union, and
  stay structurally assignable back to `Db` for any caller.
- Helpers that declared `Promise<Response>` while returning `app.fetch(...)`
  directly (typed `MaybePromise<Response>`) now wrap the call in
  `Promise.resolve(...)`.
- `@cloudflare/workers-types`' ambient `Headers` does not expose
  `getSetCookie()` under this package's lib and types combination, so cookie
  reads use `res.headers.getAll("set-cookie")`.
- New `test-helpers.ts#jsonBody` returns a real `JsonValue` instead of
  bun-types' `Response.json(): Promise<any>`, so `expect(await jsonBody(res))`
  picks the right `expect()` overload instead of the `(actual?: never)` one
  that `any` accidentally matches.
- New `test-helpers.ts#mockFetch` builds a mock assignable to `typeof fetch`
  (the real `fetch` carries a `preconnect` method a bare async function lacks).

No `as any`, `as unknown as`, `@ts-expect-error`, `@ts-nocheck` or lint-disable
comments were introduced, and no assertion was weakened.
