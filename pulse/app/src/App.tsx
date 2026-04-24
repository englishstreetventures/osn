import { AuthProvider } from "@osn/client/solid";
import { Router, Route, useLocation } from "@solidjs/router";
import { lazy, Show } from "solid-js";
import { Toaster } from "solid-toast";

import { Header } from "./components/Header";
import { OSN_ISSUER_URL } from "./lib/auth";

import "./App.css";

// Route-level code-splitting: each page is lazy-loaded so its transitive
// dependencies don't bloat the entry bundle.
const ExplorePage = lazy(() =>
  import("./explore/ExplorePage").then((m) => ({ default: m.ExplorePage })),
);
const EventDetailPage = lazy(() =>
  import("./pages/EventDetailPage").then((m) => ({ default: m.EventDetailPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const SeriesDetailPage = lazy(() =>
  import("./pages/SeriesDetailPage").then((m) => ({ default: m.SeriesDetailPage })),
);

/**
 * Root layout. The Explore home page provides its own ExploreNav, so we
 * only render the legacy Header on non-home routes.
 */
function Layout(props: { children?: unknown }) {
  const location = useLocation();
  const isHome = () => location.pathname === "/";

  return (
    <>
      <Show when={!isHome()}>
        <Header />
      </Show>
      {props.children}
      <Toaster position="bottom-right" />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
      <Router root={Layout}>
        <Route path="/" component={ExplorePage} />
        <Route path="/events/:id" component={EventDetailPage} />
        <Route path="/series/:id" component={SeriesDetailPage} />
        <Route path="/settings" component={SettingsPage} />
      </Router>
    </AuthProvider>
  );
}
