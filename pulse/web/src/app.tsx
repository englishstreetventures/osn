import { AuthProvider } from "@osn/client/solid";
import { type RouteSectionProps, Router, useLocation } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Show, Suspense } from "solid-js";
import { Toaster } from "solid-toast";

import { Header } from "./components/Header";
import { OnboardingGate } from "./components/OnboardingGate";
import { OSN_ISSUER_URL } from "./lib/auth";

import "./app.css";

/**
 * Root layout. The Explore home page provides its own ExploreNav, so we
 * only render the legacy Header on non-home routes.
 */
function Layout(props: RouteSectionProps) {
  const location = useLocation();
  const isHome = () => location.pathname === "/";
  const isWelcome = () => location.pathname === "/welcome";

  return (
    <>
      <OnboardingGate />
      <Show when={!isHome() && !isWelcome()}>
        <Header />
      </Show>
      <Suspense>{props.children}</Suspense>
      <Toaster position="bottom-right" />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
      <Router root={Layout}>
        <FileRoutes />
      </Router>
    </AuthProvider>
  );
}
