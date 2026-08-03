import { createEphemeralStorage } from "@osn/client";
import { AuthProvider } from "@osn/client/solid";
import { Router, Route, useLocation } from "@solidjs/router";
import { lazy, Show } from "solid-js";
import { Toaster } from "solid-toast";

import { Header } from "./components/Header";
import { NativeTabBar } from "./components/NativeTabBar";
import { OnboardingGate } from "./components/OnboardingGate";
import { OSN_ISSUER_URL } from "./lib/auth";
import { isIosWebview } from "./lib/platform";

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
const CloseFriendsPage = lazy(() =>
  import("./pages/CloseFriendsPage").then((m) => ({ default: m.CloseFriendsPage })),
);
const VenueDetailPage = lazy(() =>
  import("./pages/VenueDetailPage").then((m) => ({ default: m.VenueDetailPage })),
);
const CalendarPage = lazy(() =>
  import("./pages/CalendarPage").then((m) => ({ default: m.CalendarPage })),
);
const WelcomePage = lazy(() =>
  import("./pages/WelcomePage").then((m) => ({ default: m.WelcomePage })),
);

/**
 * Root layout. The Explore home page provides its own ExploreNav, so we
 * only render the legacy Header on non-home routes.
 */
function Layout(props: { children?: unknown }) {
  const location = useLocation();
  const isHome = () => location.pathname === "/";
  const isWelcome = () => location.pathname === "/welcome";

  return (
    <>
      <OnboardingGate />
      {/* Installs the native iOS tab bar where there is one; renders nothing
          otherwise. Lives here because it has to outlive every route. */}
      <NativeTabBar />
      <Show when={!isHome() && !isWelcome()}>
        <Header />
      </Show>
      {props.children}
      <Toaster position="bottom-right" />
    </>
  );
}

export default function App() {
  // On iOS, localStorage must never hold auth session data (no access token,
  // no account metadata) — the session survives a cold start through the
  // Keychain-backed refresh cookie instead (see `nativeSession.ts`).
  const storage = isIosWebview() ? createEphemeralStorage() : undefined;

  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }} storage={storage}>
      <Router root={Layout}>
        <Route path="/" component={ExplorePage} />
        <Route path="/events/:id" component={EventDetailPage} />
        <Route path="/calendar" component={CalendarPage} />
        <Route path="/series/:id" component={SeriesDetailPage} />
        <Route path="/venues/:orgHandle/:venueHandle" component={VenueDetailPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/close-friends" component={CloseFriendsPage} />
        <Route path="/welcome" component={WelcomePage} />
      </Router>
    </AuthProvider>
  );
}
