import { describe, expect, it, vi } from "vitest";

import {
  AuthExpiredError,
  clearAuthError,
  createAuthFetch,
  fetchSession,
  isAuthExpired,
  readAuthError,
  signInUrl,
  signOut,
  startSignIn,
  type RpAuthConfig,
} from "../src/index";

const API_BASE = "https://api.test.invalid";

/** A `fetch` that answers with `response` and records every call. */
const stubFetch = (response: Response | (() => Response | Promise<Response>)) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    return typeof response === "function" ? response() : response;
  };
  return { fetch: fn as unknown as typeof fetch, calls };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const config = (overrides: Partial<RpAuthConfig> = {}): RpAuthConfig => ({
  apiBase: API_BASE,
  ...overrides,
});

const SIGNED_IN = {
  signedIn: true,
  osnProfileId: "usr_organiser",
  email: "organiser@example.test",
  handle: "organiser",
  displayName: "Test Organiser",
  avatarUrl: "https://cdn.test.invalid/a.png",
  expiresAt: "2026-08-03T00:00:00.000Z",
};

describe("signInUrl", () => {
  it("points at the API's start leg with the destination attached", () => {
    const url = new URL(signInUrl(config(), "https://host.test.invalid/weddings"));
    expect(url.origin).toBe(API_BASE);
    expect(url.pathname).toBe("/api/auth/oidc/start");
    expect(url.searchParams.get("return_to")).toBe("https://host.test.invalid/weddings");
  });

  it("honours a relying party that mounts the auth routes elsewhere", () => {
    const url = new URL(signInUrl(config({ basePath: "/v2/auth" }), "https://app.test.invalid/"));
    expect(url.pathname).toBe("/v2/auth/oidc/start");
  });

  it("tolerates a trailing slash on the API base rather than doubling it", () => {
    const url = new URL(
      signInUrl(config({ apiBase: `${API_BASE}/` }), "https://app.test.invalid/"),
    );
    expect(url.pathname).toBe("/api/auth/oidc/start");
  });
});

describe("fetchSession", () => {
  it("maps a signed-in answer onto the session shape", async () => {
    const stub = stubFetch(json(SIGNED_IN));
    const session = await fetchSession(config({ fetch: stub.fetch }));
    expect(session).toEqual({
      osnProfileId: "usr_organiser",
      email: "organiser@example.test",
      handle: "organiser",
      displayName: "Test Organiser",
      avatarUrl: "https://cdn.test.invalid/a.png",
      expiresAt: "2026-08-03T00:00:00.000Z",
    });
  });

  it("sends the cookie — without it the API always answers signed-out", async () => {
    const stub = stubFetch(json(SIGNED_IN));
    await fetchSession(config({ fetch: stub.fetch }));
    expect(stub.calls[0]!.url).toBe(`${API_BASE}/api/auth/session`);
    expect(stub.calls[0]!.init?.credentials).toBe("include");
  });

  it("reads a signed-out answer as null", async () => {
    const stub = stubFetch(json({ signedIn: false }));
    expect(await fetchSession(config({ fetch: stub.fetch }))).toBeNull();
  });

  it("treats an unreachable API as signed out rather than throwing", async () => {
    const fetchFn = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await fetchSession(config({ fetch: fetchFn }))).toBeNull();
  });

  it("treats a non-200 as signed out", async () => {
    const stub = stubFetch(json({ error: "boom" }, 500));
    expect(await fetchSession(config({ fetch: stub.fetch }))).toBeNull();
  });

  it("refuses a signed-in answer with no profile id", async () => {
    const stub = stubFetch(json({ signedIn: true, expiresAt: "2026-08-03T00:00:00.000Z" }));
    expect(await fetchSession(config({ fetch: stub.fetch }))).toBeNull();
  });

  it("survives a body that is not JSON", async () => {
    const stub = stubFetch(new Response("<html>maintenance</html>", { status: 200 }));
    expect(await fetchSession(config({ fetch: stub.fetch }))).toBeNull();
  });

  it("keeps missing optional claims as null", async () => {
    const stub = stubFetch(
      json({ signedIn: true, osnProfileId: "usr_x", expiresAt: "2026-08-03T00:00:00.000Z" }),
    );
    const session = await fetchSession(config({ fetch: stub.fetch }));
    expect(session).toMatchObject({
      email: null,
      handle: null,
      displayName: null,
      avatarUrl: null,
    });
  });
});

describe("signOut", () => {
  it("POSTs to the signout route with the cookie", async () => {
    const stub = stubFetch(json({ ok: true }));
    await signOut(config({ fetch: stub.fetch }));
    expect(stub.calls[0]!.url).toBe(`${API_BASE}/api/auth/signout`);
    expect(stub.calls[0]!.init?.method).toBe("POST");
    expect(stub.calls[0]!.init?.credentials).toBe("include");
  });

  it("asks for every device when told to", async () => {
    const stub = stubFetch(json({ ok: true }));
    await signOut(config({ fetch: stub.fetch }), { allDevices: true });
    expect(stub.calls[0]!.url).toBe(`${API_BASE}/api/auth/signout?all=1`);
  });

  it("swallows a network failure — the UI still has to end up signed out", async () => {
    const fetchFn = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    await expect(signOut(config({ fetch: fetchFn }))).resolves.toBeUndefined();
  });
});

describe("createAuthFetch", () => {
  it("attaches the cookie and keeps the caller's init", async () => {
    const stub = stubFetch(json({ ok: true }));
    const authFetch = createAuthFetch(config({ fetch: stub.fetch }));
    await authFetch("https://api.test.invalid/api/organiser/weddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(stub.calls[0]!.init?.method).toBe("POST");
    expect(stub.calls[0]!.init?.credentials).toBe("include");
  });

  it("turns a 401 into AuthExpiredError so callers can bounce to sign-in", async () => {
    const stub = stubFetch(json({ error: "unauthorized" }, 401));
    const authFetch = createAuthFetch(config({ fetch: stub.fetch }));
    await expect(authFetch("https://api.test.invalid/api/organiser/weddings")).rejects.toThrow(
      AuthExpiredError,
    );
  });

  it("passes a 403 through — forbidden is not expired, and must not log anyone out", async () => {
    const stub = stubFetch(json({ error: "read_only_role" }, 403));
    const authFetch = createAuthFetch(config({ fetch: stub.fetch }));
    const res = await authFetch("https://api.test.invalid/api/organiser/weddings/w1");
    expect(res.status).toBe(403);
  });

  it("passes other failures through as responses, not exceptions", async () => {
    const stub = stubFetch(json({ error: "boom" }, 500));
    const authFetch = createAuthFetch(config({ fetch: stub.fetch }));
    expect((await authFetch("https://api.test.invalid/x")).status).toBe(500);
  });
});

describe("isAuthExpired", () => {
  it("recognises the error this package throws", () => {
    expect(isAuthExpired(new AuthExpiredError())).toBe(true);
  });

  it("recognises a structurally tagged error from another realm", () => {
    expect(isAuthExpired({ _tag: "AuthExpiredError" })).toBe(true);
  });

  it("does not claim unrelated failures", () => {
    expect(isAuthExpired(new Error("network"))).toBe(false);
    expect(isAuthExpired(null)).toBe(false);
    expect(isAuthExpired("AuthExpiredError")).toBe(false);
  });
});

describe("startSignIn", () => {
  it("navigates the whole page — a popup would strand the session cookie", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign, href: "https://host.test.invalid/weddings" } });
    try {
      startSignIn(config());
      expect(assign).toHaveBeenCalledWith(
        signInUrl(config(), "https://host.test.invalid/weddings"),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("readAuthError / clearAuthError", () => {
  it("reads the marker the callback appends", () => {
    expect(readAuthError("?auth_error=sign_in_declined")).toBe("sign_in_declined");
  });

  it("is null when sign-in went through", () => {
    expect(readAuthError("?tab=guests")).toBeNull();
  });

  it("strips the marker without adding a history entry", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://host.test.invalid/weddings?tab=guests&auth_error=sign_in_failed" },
      history: { replaceState },
    });
    try {
      clearAuthError();
      expect(replaceState).toHaveBeenCalledTimes(1);
      const next = new URL(replaceState.mock.calls[0]![2] as string);
      expect(next.searchParams.get("auth_error")).toBeNull();
      expect(next.searchParams.get("tab")).toBe("guests");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves the address bar alone when there is no marker", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://host.test.invalid/weddings" },
      history: { replaceState },
    });
    try {
      clearAuthError();
      expect(replaceState).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
