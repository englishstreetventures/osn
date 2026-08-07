/**
 * Test seam for the invite islands' `fetch`.
 *
 * The packs make three different calls: the public invite revalidation
 * (`GET /api/invite/:slug`), the claim (`POST /api/claim`) and — since the
 * session-restore work — `GET /api/claim/session` on mount.
 *
 * Most InvitePage tests stub `fetch` with a single mock that answers every URL
 * with a claim payload. Once the restore endpoint existed, that fixture started
 * meaning "this guest ALREADY has a session", so the invite opened by itself and
 * the code-entry path under test never ran. `noSession` pins the intended
 * precondition instead of leaving it to URL-agnostic luck: the restore gets the
 * 401 a guest without a cookie really receives, and every other request falls
 * through to the wrapped mock untouched — so assertions on that mock's calls are
 * unaffected, since it never sees the restore request at all.
 *
 * Tests that want the OTHER precondition — a returning guest — should stub the
 * restore explicitly rather than reaching for this.
 */
export function noSession(inner: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes("/api/claim/session")) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return inner(input, init);
  }) as typeof fetch;
}

/**
 * The mirror of {@link noSession}: a returning guest whose `cire_session` cookie
 * still resolves, so `GET /api/claim/session` hands back their invite. Other
 * requests fall through to `inner`.
 */
export function withSession(payload: unknown, inner: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes("/api/claim/session")) {
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return inner(input, init);
  }) as typeof fetch;
}
