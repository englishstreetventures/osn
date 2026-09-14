import { useAuth } from "@osn/client/solid";
import { ErrorBoundary, lazy, Show, Suspense } from "solid-js";

/**
 * Mounts the account-health banners once a session exists, and not before.
 *
 * This module is in the entry chunk, which every anonymous visitor downloads
 * and which `/authorize` — a cold cross-origin landing — downloads before it
 * can paint. The banners are not: they reach `@simplewebauthn/browser` through
 * the step-up ceremony, so the stack is behind `lazy()` and behind a session
 * check, and the two have to stay in that order. `lazy()` calls its import
 * thunk on first render and `Show` reads its children only when the condition
 * holds, so a signed-out visitor fetches none of it. Putting the stack in a
 * prop that is evaluated eagerly — a `fallback`, say — would fetch it for
 * everybody and show nothing for it.
 *
 * The session is read here, outside `Suspense`. Read inside, the boundary
 * tracks the session resource and would blank the banners every time the
 * session refetches: adopting one, switching profile, deleting a profile,
 * signing out.
 *
 * `ErrorBoundary` renders nothing because this is shell code. Both banners
 * read rate-limited endpoints, a Solid resource rethrows its fetch error on
 * read, and a throw here would blank every route in the app rather than one
 * page.
 */
const AccountBannerStack = lazy(() => import("./AccountBannerStack"));

export function AccountBanners() {
  const { session } = useAuth();
  const accessToken = () => session()?.accessToken ?? null;

  return (
    <ErrorBoundary fallback={null}>
      <Show when={accessToken()}>
        {(token) => (
          <Suspense>
            <AccountBannerStack accessToken={token()} />
          </Suspense>
        )}
      </Show>
    </ErrorBoundary>
  );
}
