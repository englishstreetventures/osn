import { AuthProvider } from "@osn/client/solid";
import { Router, Route } from "@solidjs/router";
import { lazy } from "solid-js";
import { Toaster } from "solid-toast";

import { EventList } from "./components/EventList";
import { Header } from "./components/Header";
import { OSN_ISSUER_URL } from "./lib/auth";

import "./App.css";

// P-W3: route-level code-splitting. EventDetailPage pulls in
// `MapPreview`, which transitively imports Leaflet (~150KB) + its CSS.
// Lazy-loading the route boundary keeps Leaflet out of the initial
// bundle so the home feed doesn't pay for a dependency it doesn't use.
// Settings is split for the same reason — it's a low-traffic page.
const EventDetailPage = lazy(() =>
  import("./pages/EventDetailPage").then((m) => ({ default: m.EventDetailPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);

function Layout(props: { children?: unknown }) {
  return (
    <>
      <Header />
      {props.children}
      <Toaster position="bottom-right" />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
      <Router root={Layout}>
        <Route path="/" component={EventList} />
        <Route path="/events/:id" component={EventDetailPage} />
        <Route path="/settings" component={SettingsPage} />
      </Router>
    </AuthProvider>
  );
}
