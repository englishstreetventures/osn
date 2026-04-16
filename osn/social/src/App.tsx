import { AuthProvider } from "@osn/client/solid";
import { MagicLinkHandler } from "@osn/ui/auth/MagicLinkHandler";
import { Route, Router } from "@solidjs/router";
import { lazy } from "solid-js";
import { Toaster } from "solid-toast";

import { CallbackHandler } from "./components/CallbackHandler";
import { Sidebar } from "./components/Sidebar";
import { OSN_CLIENT_ID, OSN_ISSUER_URL } from "./lib/auth";
import { loginClient } from "./lib/authClients";

import "./App.css";

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

function Layout(props: { children?: import("solid-js").JSX.Element }) {
  return (
    <div class="flex h-screen overflow-hidden">
      <Sidebar />
      <div class="flex flex-1 flex-col overflow-y-auto">
        <MagicLinkHandler client={loginClient} />
        {props.children}
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL, clientId: OSN_CLIENT_ID }}>
      <Router root={Layout}>
        <Route path="/" component={ConnectionsPage} />
        <Route path="/connections" component={ConnectionsPage} />
        <Route path="/discover" component={DiscoverPage} />
        <Route path="/organisations" component={OrganisationsPage} />
        <Route path="/organisations/:id" component={OrgDetailPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/callback" component={CallbackHandler} />
      </Router>
    </AuthProvider>
  );
}
