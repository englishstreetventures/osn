import { Notice } from "@shared/ui/ui/notice";
import { useLocation } from "@solidjs/router";
import { createEffect, ErrorBoundary, on, type JSX } from "solid-js";

/**
 * Catches a page that throws while it renders, so one broken page does not
 * blank the app: the rail, the tab bar and the account banners sit outside it
 * and stay drawn. The fallback never shows the error's own text. It offers
 * Try again, and resets by itself when the path changes, so the navigation
 * still leads somewhere.
 *
 * Free of `@osn/client`: it is in the entry chunk, which the cold
 * `/authorize` landing downloads too. The fallback is drawn from that chunk
 * alone, never loaded on demand: a page most often fails because its own
 * chunk did not arrive, and a fallback that needed a fetch would fail the
 * same way and blank the app.
 */
export function PageErrorBoundary(props: { children?: JSX.Element }) {
  const location = useLocation();
  return (
    <ErrorBoundary
      fallback={(_error, reset) => {
        // Owned by the fallback, so it ends when the page renders again.
        createEffect(
          on(
            () => location.pathname,
            () => reset(),
            { defer: true },
          ),
        );
        return (
          <div class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
            <Notice tone="danger" size="inline" alert>
              This page didn't load.{" "}
              <button
                type="button"
                class="focus-visible:ring-ui-focus cursor-pointer font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-hidden"
                onClick={() => reset()}
              >
                Try again
              </button>
            </Notice>
          </div>
        );
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}
