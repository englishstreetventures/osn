// @vitest-environment happy-dom
import { render, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import { AuthExpiredError } from "../src/index";
import { AuthProvider, useAuth } from "../src/solid";

const API_BASE = "https://api.test.invalid";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const SIGNED_IN = {
  signedIn: true,
  osnProfileId: "usr_organiser",
  email: "organiser@example.test",
  handle: "organiser",
  displayName: "Test Organiser",
  avatarUrl: null,
  expiresAt: "2026-08-03T00:00:00.000Z",
};

/** Answers each URL from `routes`; 404s anything else so a typo is loud. */
const routedFetch = (routes: Record<string, () => Response>) => {
  const seen: string[] = [];
  const fn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    const route = routes[new URL(url).pathname + (new URL(url).search || "")];
    return route ? route() : json({ error: "not_found" }, 404);
  };
  return { fetch: fn as unknown as typeof fetch, seen };
};

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="state">
        {auth.session.loading ? "loading" : auth.session() ? "in" : "out"}
      </span>
      <Show when={auth.session()}>
        {(session) => <span data-testid="profile">{session().osnProfileId}</span>}
      </Show>
      <span data-testid="active">{auth.activeProfileId() ?? "none"}</span>
      <button type="button" onClick={() => void auth.logout()}>
        sign out
      </button>
    </div>
  );
}

describe("AuthProvider", () => {
  it("reports the signed-in profile once the probe lands", async () => {
    const stub = routedFetch({ "/api/auth/session": () => json(SIGNED_IN) });
    const { getByTestId } = render(() => (
      <AuthProvider config={{ apiBase: API_BASE, fetch: stub.fetch }}>
        <Probe />
      </AuthProvider>
    ));

    await waitFor(() => expect(getByTestId("state").textContent).toBe("in"));
    expect(getByTestId("profile").textContent).toBe("usr_organiser");
    // The app's rows are keyed on the real `usr_*` id, never the pairwise sub.
    expect(getByTestId("active").textContent).toBe("usr_organiser");
  });

  it("settles on signed-out when there is no session cookie", async () => {
    const stub = routedFetch({ "/api/auth/session": () => json({ signedIn: false }) });
    const { getByTestId } = render(() => (
      <AuthProvider config={{ apiBase: API_BASE, fetch: stub.fetch }}>
        <Probe />
      </AuthProvider>
    ));

    await waitFor(() => expect(getByTestId("state").textContent).toBe("out"));
    expect(getByTestId("active").textContent).toBe("none");
  });

  it("drops to signed-out on logout without waiting for the re-probe", async () => {
    let signedIn = true;
    const stub = routedFetch({
      "/api/auth/session": () => json(signedIn ? SIGNED_IN : { signedIn: false }),
      "/api/auth/signout": () => {
        signedIn = false;
        return json({ ok: true });
      },
    });
    const { getByTestId, getByRole } = render(() => (
      <AuthProvider config={{ apiBase: API_BASE, fetch: stub.fetch }}>
        <Probe />
      </AuthProvider>
    ));

    await waitFor(() => expect(getByTestId("state").textContent).toBe("in"));
    getByRole("button", { name: "sign out" }).click();

    await waitFor(() => expect(getByTestId("state").textContent).toBe("out"));
    expect(stub.seen).toContain(`POST ${API_BASE}/api/auth/signout`);
  });

  it("hands out an authFetch that raises AuthExpiredError on 401", async () => {
    const stub = routedFetch({
      "/api/auth/session": () => json(SIGNED_IN),
      "/api/organiser/weddings": () => json({ error: "unauthorized" }, 401),
    });
    let thrown: unknown;

    function Caller() {
      const auth = useAuth();
      void auth
        .authFetch(`${API_BASE}/api/organiser/weddings`)
        .catch((err: unknown) => (thrown = err));
      return null;
    }

    render(() => (
      <AuthProvider config={{ apiBase: API_BASE, fetch: stub.fetch }}>
        <Caller />
      </AuthProvider>
    ));

    await waitFor(() => expect(thrown).toBeInstanceOf(AuthExpiredError));
  });

  it("sends the browser to the issuer when signIn is called", async () => {
    const assign = vi.fn();
    const stub = routedFetch({ "/api/auth/session": () => json({ signedIn: false }) });
    vi.spyOn(window.location, "assign").mockImplementation(assign);

    function Caller() {
      const auth = useAuth();
      return (
        <button type="button" onClick={() => auth.signIn("https://host.test.invalid/weddings")}>
          sign in
        </button>
      );
    }

    const { getByRole } = render(() => (
      <AuthProvider config={{ apiBase: API_BASE, fetch: stub.fetch }}>
        <Caller />
      </AuthProvider>
    ));

    getByRole("button", { name: "sign in" }).click();
    expect(assign).toHaveBeenCalledTimes(1);
    const target = new URL(assign.mock.calls[0]![0] as string);
    expect(target.pathname).toBe("/api/auth/oidc/start");
    expect(target.searchParams.get("return_to")).toBe("https://host.test.invalid/weddings");
    vi.restoreAllMocks();
  });
});

describe("useAuth", () => {
  it("refuses to run outside a provider rather than returning a hollow session", () => {
    expect(() => render(() => <Probe />)).toThrow(/within <AuthProvider>/);
  });
});
