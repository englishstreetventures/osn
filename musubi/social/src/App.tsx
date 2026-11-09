import { AuthProvider } from "@osn/client/solid";
import { Toaster } from "@shared/toast";
import { clsx } from "@shared/ui/lib/utils";
import { Route, Router, useLocation } from "@solidjs/router";
import { createSignal, lazy, onCleanup, onMount, Show, type Component, type JSX } from "solid-js";

import { AccountBanners } from "./components/AccountBanners";
import { loadShellDialogs, ShellDialogsProvider } from "./components/ShellDialogs";
import { RailFrame, TopBarFrame } from "./components/ShellFrame";
import { osnAuth } from "./lib/auth";

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
const PrivacyPage = lazy(() =>
  import("./pages/PrivacyPage").then((m) => ({ default: m.PrivacyPage })),
);
const TermsPage = lazy(() => import("./pages/TermsPage").then((m) => ({ default: m.TermsPage })));

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
export function Layout(props: { children?: JSX.Element }) {
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
          <AuthProvider auth={osnAuth}>
            <AppShell isMobile={isMobile()}>{props.children}</AppShell>
          </AuthProvider>
        }
      >
        <Content>{props.children}</Content>
      </Show>
      <Toaster
        position={isMobile() ? "top-center" : "bottom-right"}
        style={
          isMobile()
            ? // Clear the mobile top bar (3rem) plus the notch inset.
              { top: "calc(3rem + env(safe-area-inset-top, 0px) + 8px)" }
            : undefined
        }
      />
    </div>
  );
}

function AppShell(props: { isMobile: boolean; children?: JSX.Element }) {
  return (
    <ShellDialogsProvider>
      {/* Mount only the active shell: one chunk fetched, one shell hydrating.
          The dialogs sit above this switch, so one open across a crossing
          stays open. The CSS hidden classes on each shell remain as a
          paint-level fallback around the breakpoint flip. */}
      <Show when={props.isMobile} fallback={<Reserved shell={Sidebar} frame={RailFrame} />}>
        <Reserved shell={MobileChrome} frame={TopBarFrame} />
      </Show>
      {/* Inside the scroll column, above the page: the layout is a row on
          desktop, so a sibling of `Content` would land beside the rail
          rather than over the page. Renders nothing until a session
          exists, and nothing at all on a bare route. */}
      <Content padForMobileNav>
        <AccountBanners />
        {props.children}
      </Content>
    </ShellDialogsProvider>
  );
}

/**
 * Draws a shell's frame until the shell can draw itself, so the page beside
 * it never moves when the shell's chunk lands.
 *
 * The shell shows once its own chunk and the dialogs' chunks have both loaded:
 * a shell drawn earlier would offer a Sign in that cannot open yet. By then
 * `lazy()` holds the module, so the shell renders at once, with no resource
 * and nothing to suspend. A `Suspense` fallback would not do: the shell reads
 * the session and profile resources, and a boundary above it would put the
 * frame back on every refetch.
 *
 * If either load fails (offline, or a chunk renamed by a deploy since the page
 * loaded) the frame stays and says to reload. The rejection is handled here,
 * so the page beside it keeps working.
 */
function Reserved(props: {
  shell: Component & { preload: () => Promise<{ default: Component }> };
  frame: Component<{ failed: boolean }>;
}) {
  const [state, setState] = createSignal<"loading" | "ready" | "failed">("loading");
  Promise.all([props.shell.preload(), loadShellDialogs()]).then(
    () => setState("ready"),
    () => setState("failed"),
  );
  return (
    <Show when={state() === "ready"} fallback={<props.frame failed={state() === "failed"} />}>
      <props.shell />
    </Show>
  );
}

/** Tracks the `md` breakpoint so shell mounting and JS-positioned chrome (the
 *  toaster) follow the same mobile/desktop split as the CSS. Client-only SPA,
 *  so the signal initialises synchronously — correct from the first render,
 *  no post-mount flip. */
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

function Content(props: { children?: JSX.Element; padForMobileNav?: boolean }) {
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
      <Route path="/organisations/:handle" component={OrgDetailPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/authorize" component={AuthorizePage} />
      {/* Reachable signed-out on purpose: a notice you can only read once you have
          already handed over your data is not a notice. */}
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/terms" component={TermsPage} />
    </Router>
  );
}
