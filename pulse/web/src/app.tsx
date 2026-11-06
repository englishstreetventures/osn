import { AuthProvider } from "@shared/rp-auth/solid";
import { Toaster } from "@shared/toast";
import { type RouteSectionProps, Router, useLocation } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { onMount, Show, Suspense } from "solid-js";

import { AuthErrorToast } from "./components/AuthErrorToast";
import { Header } from "./components/Header";
import { OnboardingGate } from "./components/OnboardingGate";
import { authConfig } from "./lib/auth";

import "./app.css";

/**
 * Marks the document once the page under it has hydrated: until then a
 * server-rendered control is markup without its handlers, and a press on it
 * is lost. Anything that drives the page, the E2E suite included, waits for
 * `html[data-hydrated]` before it presses. Inside the layout's `<Suspense>`,
 * so it runs only once the route's own content has hydrated.
 */
function HydratedMark() {
  onMount(() => document.documentElement.setAttribute("data-hydrated", ""));
  return null;
}

/**
 * Root layout. The Explore home page provides its own ExploreNav, so we
 * only render the legacy Header on non-home routes.
 *
 * Everything that reads the session sits inside the `<Suspense>`: on the
 * server a resource read outside a boundary renders its loading state into
 * the HTML even once it has resolved, so the header would arrive signed out.
 */
function Layout(props: RouteSectionProps) {
  const location = useLocation();
  const isHome = () => location.pathname === "/";
  const isWelcome = () => location.pathname === "/welcome";

  return (
    <>
      <AuthErrorToast />
      <Suspense>
        <OnboardingGate />
        <Show when={!isHome() && !isWelcome()}>
          <Header />
        </Show>
        {props.children}
        <HydratedMark />
      </Suspense>
      <Toaster position="bottom-right" />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider config={authConfig}>
      <Router root={Layout}>
        <FileRoutes />
      </Router>
    </AuthProvider>
  );
}
