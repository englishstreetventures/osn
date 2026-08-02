import { AuthProvider } from "@osn/client/solid";
import { clsx } from "@osn/ui/lib/utils";
import { Route, Router, useLocation } from "@solidjs/router";
import { createSignal, lazy, onCleanup, onMount, Show } from "solid-js";
import { Toaster } from "solid-toast";

import { OSN_ISSUER_URL } from "./lib/auth";

import "./App.css";

// Split out of the entry chunk: the consent screen never renders it, and that
// route is a cold cross-origin landing where the shell is dead weight.
const Sidebar = lazy(() => import("./components/Sidebar").then((m) => ({ default: m.Sidebar })));
const MobileChrome = lazy(() =>
  import("./components/MobileChrome").then((m) => ({ default: m.MobileChrome })),
);

const ConnectionsPage = lazy(() =>
  import("./pages/ConnectionsPage").then((m) => ({ default: m.ConnectionsPage })),
);
const DiscoverPage = lazy(() =>
  import("./pages/DiscoverPage").then((m) => ({ default: m.DiscoverPage })),
);
const SearchPage = lazy(() =>
  import("./pages/SearchPage").then((m) => ({ default: m.SearchPage })),
);
const OrganisationsPage = lazy(() =>
  import("./pages/OrganisationsPage").then((m) => ({ default: m.OrganisationsPage })),
);
const OrgDetailPage = lazy(() =>
  import("./pages/OrgDetailPage").then((m) => ({ default: m.OrgDetailPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const AuthorizePage = lazy(() =>
  import("./pages/AuthorizePage").then((m) => ({ default: m.AuthorizePage })),
);

/**
 * The consent screen runs bare: no navigation out of the flow, nothing to
 * click but the decision itself.
 */
const BARE_ROUTES = new Set(["/authorize"]);

/**
 * Bare routes also run outside `AuthProvider`. Mounting it bootstraps a
 * session — `POST /token`, which rotates the refresh session — and then lists
 * profiles; the consent screen reads neither, since `/authorize/context`
 * already carries both. It mounts its own provider around the sign-in island
 * when a ceremony is actually needed.
 */
function Layout(props: { children?: import("solid-js").JSX.Element }) {
  const location = useLocation();
  // Normalise a trailing slash before the lookup: the router matches
  // `/authorize/` to the consent route, but an exact-string `BARE_ROUTES` miss
  // would render it inside the full app shell — sidebar nav mid-consent and an
  // AuthProvider mount that rotates the refresh session.
  const bare = () => BARE_ROUTES.has(location.pathname.replace(/(.)\/$/, "$1"));
  const isMobile = useIsMobile();
  return (
    <div class="px-safe flex h-dvh flex-col overflow-hidden md:flex-row">
      <Show
        when={bare()}
        fallback={
          <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
            {/* Mount only the active shell (P-W1): one chunk fetched, one
                shell hydrating, and a single mounted auth-dialog surface at
                any width (S-L1). The CSS hidden classes on each shell remain
                as a paint-level fallback around the breakpoint flip. */}
            <Show when={isMobile()} fallback={<Sidebar />}>
              <MobileChrome />
            </Show>
            <Content padForMobileNav>{props.children}</Content>
          </AuthProvider>
        }
      >
        <Content>{props.children}</Content>
      </Show>
      <Toaster
        position={isMobile() ? "top-center" : "bottom-right"}
        containerStyle={
          isMobile()
            ? // Clear the mobile top bar (3rem) plus the notch inset.
              { top: "calc(3rem + env(safe-area-inset-top, 0px) + 8px)" }
            : undefined
        }
      />
    </div>
  );
}

/** Tracks the `md` breakpoint so shell mounting and JS-positioned chrome (the
 *  toaster) follow the same mobile/desktop split as the CSS. Client-only SPA,
 *  so the signal initialises synchronously — correct from the first render
 *  (P-I2), no post-mount flip. */
function useIsMobile() {
  const mq = window.matchMedia("(max-width: 767px)");
  const [isMobile, setIsMobile] = createSignal(mq.matches);
  onMount(() => {
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener?.("change", onChange);
    onCleanup(() => mq.removeEventListener?.("change", onChange));
  });
  return isMobile;
}

function Content(props: { children?: import("solid-js").JSX.Element; padForMobileNav?: boolean }) {
  return (
    <div
      class={clsx(
        "flex flex-1 flex-col overflow-y-auto",
        props.padForMobileNav && "pb-nav md:pb-0",
      )}
    >
      {props.children}
    </div>
  );
}

export default function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={ConnectionsPage} />
      <Route path="/connections" component={ConnectionsPage} />
      <Route path="/search" component={SearchPage} />
      <Route path="/discover" component={DiscoverPage} />
      <Route path="/organisations" component={OrganisationsPage} />
      <Route path="/organisations/:id" component={OrgDetailPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/authorize" component={AuthorizePage} />
    </Router>
  );
}
