import { MemoryRouter, Route } from "@solidjs/router";
import type { JSX } from "solid-js";

/**
 * Wraps a component in a `MemoryRouter` so tests can exercise
 * components that use `@solidjs/router` primitives (`<A>`, `useParams`,
 * etc.) without mounting the full App routing tree.
 *
 * Pass a factory that returns the JSX under test. The factory is
 * mounted as the single route component, which keeps Solid's reactive
 * scope correct (critical — calling the factory eagerly outside the
 * router context is what broke the old render pattern).
 *
 * Usage:
 *   const { getByText } = render(wrapRouter(() => <MyComponent />));
 */
export function wrapRouter(component: () => JSX.Element) {
  return () => (
    <MemoryRouter>
      <Route path="*" component={component} />
    </MemoryRouter>
  );
}
