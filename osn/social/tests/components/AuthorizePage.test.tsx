// @vitest-environment happy-dom
import { AuthorizeError } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the authorize client before importing the page so the page's
// module-level `authorizeClient` reference picks up the mock.
const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  submitDecision: vi.fn(),
}));

vi.mock("../../src/lib/authorize", () => ({ authorizeClient: mocks }));
// The sign-in island carries its own AuthProvider and the WebAuthn client;
// the page only cares that it reports success.
vi.mock("../../src/components/AuthorizeSignIn", () => ({
  AuthorizeSignIn: (props: { onSuccess: () => void }) => (
    <button type="button" onClick={() => props.onSuccess()}>
      finish sign-in
    </button>
  ),
}));
vi.mock("../../src/lib/authClients", () => ({
  loginClient: {},
  recoveryClient: {},
  registrationClient: {},
  passkeysClient: {},
  stepUpClient: {},
}));

import { AuthorizePage } from "../../src/pages/AuthorizePage";

const REQUEST_ID = "oar_0123456789ab";

const alice = {
  id: "usr_1",
  handle: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  avatarUrl: null,
};

const bob = {
  id: "usr_2",
  handle: "bob",
  email: "alice@example.com",
  displayName: "Bob",
  avatarUrl: null,
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    client: {
      clientId: "cli_abc",
      name: "Cire",
      logoUrl: null,
      firstParty: false,
    },
    scopes: ["openid", "profile", "email"],
    signedIn: true,
    profiles: [alice],
    linkedProfileId: null,
    ...overrides,
  };
}

function authProvider() {
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  const authValue = {
    session: resource(null),
    profiles: resource([]),
    activeProfileId: () => null,
    logout: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile: () => Promise.reject(new Error("unused")),
    createProfile: () => Promise.reject(new Error("unused")),
    deleteProfile: () => Promise.resolve(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required for this test
  return authValue as any;
}

function renderPage(search = `?request=${REQUEST_ID}`) {
  const history = createMemoryHistory();
  history.set({ value: `/authorize${search}` });
  return render(() => (
    <AuthContext.Provider value={authProvider()}>
      <MemoryRouter history={history}>
        <Route path="/authorize" component={AuthorizePage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal("location", { assign, href: "http://localhost/authorize" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("<AuthorizePage />", () => {
  it("refuses a malformed request id without calling the API", async () => {
    renderPage("?request=nonsense");

    expect(await screen.findByText("This sign-in link is not valid.")).toBeDefined();
    expect(mocks.getContext).not.toHaveBeenCalled();
  });

  it("shows a terminal expired state on 404 and offers no retry", async () => {
    mocks.getContext.mockRejectedValue(
      new AuthorizeError("invalid_request", 404, "Unknown or expired request"),
    );

    renderPage();

    expect(await screen.findByText("This sign-in request has expired.")).toBeDefined();
    // No client name was ever loaded, so the copy stays generic.
    expect(screen.getByText("Go back to the app you came from and try again.")).toBeDefined();
    expect(screen.queryByText("Allow")).toBeNull();
  });

  it("renders the client, the humanised scopes and the email warning", async () => {
    mocks.getContext.mockResolvedValue(context());

    renderPage();

    expect(await screen.findByText("Cire")).toBeDefined();
    expect(screen.getByText("wants to use your OSN account")).toBeDefined();
    expect(screen.getByText("Confirm who you are")).toBeDefined();
    expect(screen.getByText("See your profile")).toBeDefined();
    expect(screen.getByText("See your email address")).toBeDefined();
    expect(
      screen.getByText(
        "Your email belongs to your account, not this profile — every app you allow sees the same one.",
      ),
    ).toBeDefined();
    expect(mocks.getContext).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("posts an approval with the selected profile and assigns the redirect verbatim", async () => {
    const redirectTo = "https://app.example.com/cb?code=abc&state=xyz";
    mocks.getContext.mockResolvedValue(context());
    mocks.submitDecision.mockResolvedValue({ redirectTo });

    renderPage();
    fireEvent.click(await screen.findByText("Allow"));

    await waitFor(() =>
      expect(mocks.submitDecision).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        profileId: "usr_1",
        approved: true,
      }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith(redirectTo));
    expect(await screen.findByText("Taking you back…")).toBeDefined();
  });

  it("treats Cancel as a decision, not an abandonment", async () => {
    mocks.getContext.mockResolvedValue(context());
    mocks.submitDecision.mockResolvedValue({
      redirectTo: "https://app.example.com/cb?error=access_denied",
    });

    renderPage();
    fireEvent.click(await screen.findByText("Cancel"));

    await waitFor(() =>
      expect(mocks.submitDecision).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        profileId: "usr_1",
        approved: false,
      }),
    );
  });

  it("keeps the request alive on login_required and asks for a fresh sign-in", async () => {
    mocks.getContext.mockResolvedValue(context());
    mocks.submitDecision.mockRejectedValue(
      new AuthorizeError("login_required", 400, "Re-authentication required"),
    );

    renderPage();
    fireEvent.click(await screen.findByText("Allow"));

    expect(await screen.findByText("Please sign in again to continue.")).toBeDefined();
    // Not terminal: the client card is still on screen, the expired copy is not.
    expect(screen.getByText("Cire")).toBeDefined();
    expect(screen.queryByText("This sign-in request has expired.")).toBeNull();
  });

  it("goes terminal when the client is disabled mid-flow", async () => {
    mocks.getContext.mockResolvedValue(context());
    mocks.submitDecision.mockRejectedValue(
      new AuthorizeError("invalid_client", 401, "Client is no longer available"),
    );

    renderPage();
    fireEvent.click(await screen.findByText("Allow"));

    expect(await screen.findByText("This app is no longer able to sign you in.")).toBeDefined();
    expect(screen.getByText("Go back to Cire and start again.")).toBeDefined();
  });

  it("shows the sign-in surface, not consent, when the browser has no session", async () => {
    mocks.getContext.mockResolvedValue(context({ signedIn: false, profiles: [] }));

    renderPage();

    expect(await screen.findByText("Cire")).toBeDefined();
    expect(screen.queryByText("Allow")).toBeNull();
  });

  it("leads with the profile picker when the app has seen none of several profiles", async () => {
    mocks.getContext.mockResolvedValue(context({ profiles: [alice, bob] }));
    mocks.submitDecision.mockResolvedValue({ redirectTo: "https://app.example.com/cb" });

    renderPage();

    expect(await screen.findByText("Choose a profile")).toBeDefined();
    fireEvent.click(screen.getByText("Bob"));

    fireEvent.click(await screen.findByText("Allow"));
    await waitFor(() =>
      expect(mocks.submitDecision).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        profileId: "usr_2",
        approved: true,
      }),
    );
  });

  it("skips the picker and defaults to the profile the app already knows", async () => {
    mocks.getContext.mockResolvedValue(
      context({ profiles: [alice, bob], linkedProfileId: "usr_2" }),
    );
    mocks.submitDecision.mockResolvedValue({ redirectTo: "https://app.example.com/cb" });

    renderPage();
    fireEvent.click(await screen.findByText("Allow"));

    await waitFor(() =>
      expect(mocks.submitDecision).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        profileId: "usr_2",
        approved: true,
      }),
    );
  });

  it("honours reason=select_account even when the app already knows a profile", async () => {
    mocks.getContext.mockResolvedValue(
      context({ profiles: [alice, bob], linkedProfileId: "usr_2" }),
    );

    renderPage(`?request=${REQUEST_ID}&reason=select_account`);

    expect(await screen.findByText("Choose a profile")).toBeDefined();
  });

  it("puts the ceremony before the decision when reason=login", async () => {
    mocks.getContext.mockResolvedValue(context());

    renderPage(`?request=${REQUEST_ID}&reason=login`);

    // A session exists, but the flow demands a fresh one: no Allow yet.
    expect(await screen.findByText("finish sign-in")).toBeDefined();
    expect(screen.queryByText("Allow")).toBeNull();

    fireEvent.click(screen.getByText("finish sign-in"));

    expect(await screen.findByText("Allow")).toBeDefined();
  });

  it("replays the held answer once the same account signs in again", async () => {
    mocks.getContext.mockResolvedValue(context());
    mocks.submitDecision.mockRejectedValueOnce(
      new AuthorizeError("login_required", 400, "Re-authentication required"),
    );
    mocks.submitDecision.mockResolvedValue({ redirectTo: "https://app.example.com/cb" });

    renderPage();
    fireEvent.click(await screen.findByText("Allow"));
    fireEvent.click(await screen.findByText("finish sign-in"));

    await waitFor(() => expect(mocks.submitDecision).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://app.example.com/cb"));
  });

  it("drops the held answer when a different account signs in", async () => {
    mocks.getContext.mockResolvedValueOnce(context());
    mocks.getContext.mockResolvedValue(context({ profiles: [bob] }));
    mocks.submitDecision.mockRejectedValueOnce(
      new AuthorizeError("login_required", 400, "Re-authentication required"),
    );

    renderPage();
    fireEvent.click(await screen.findByText("Allow"));
    fireEvent.click(await screen.findByText("finish sign-in"));

    expect(
      await screen.findByText(
        "You signed in as a different account — check this before continuing.",
      ),
    ).toBeDefined();
    // The answer Alice gave is not posted for Bob.
    expect(mocks.submitDecision).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Allow")).toBeDefined();
  });

  it("offers a retry when the context read is rate limited", async () => {
    mocks.getContext.mockRejectedValueOnce(
      new AuthorizeError("rate_limited", 429, "Too many attempts. Try again in a minute."),
    );
    mocks.getContext.mockResolvedValue(context());

    renderPage();

    expect(await screen.findByText("Could not load this request")).toBeDefined();
    expect(screen.getByText("Too many attempts. Try again in a minute.")).toBeDefined();

    fireEvent.click(screen.getByText("Try again"));

    expect(await screen.findByText("Allow")).toBeDefined();
  });
});
