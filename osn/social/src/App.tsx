import { AuthProvider } from "@osn/client/solid";
import { Route, Router, useLocation } from "@solidjs/router";
import { lazy, Show } from "solid-js";
import { Toaster } from "solid-toast";

import { OSN_ISSUER_URL } from "./lib/auth";

import "./App.css";

// Split out of the entry chunk: the consent screen never renders it, and that
// route is a cold cross-origin landing where the shell is dead weight.
const Sidebar = lazy(() => import("./components/Sidebar").then((m) => ({ default: m.Sidebar })));

const ConnectionsPage = lazy(() =>
  import("./pages/ConnectionsPage").then((m) => ({ default: m.ConnectionsPage })),
);
const DiscoverPage = lazy(() =>
  import("./pages/DiscoverPage").then((m) => ({ default: m.DiscoverPage })),
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
  const bare = () => BARE_ROUTES.has(location.pathname);
  return (
    <div class="flex h-screen overflow-hidden">
      <Show
        when={bare()}
        fallback={
          <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
            <Sidebar />
            <Content>{props.children}</Content>
          </AuthProvider>
        }
      >
        <Content>{props.children}</Content>
      </Show>
      <Toaster position="bottom-right" />
    </div>
  );
}

function Content(props: { children?: import("solid-js").JSX.Element }) {
  return <div class="flex flex-1 flex-col overflow-y-auto">{props.children}</div>;
}

export default function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={ConnectionsPage} />
      <Route path="/connections" component={ConnectionsPage} />
      <Route path="/discover" component={DiscoverPage} />
      <Route path="/organisations" component={OrganisationsPage} />
      <Route path="/organisations/:id" component={OrgDetailPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/authorize" component={AuthorizePage} />
    </Router>
  );
}
