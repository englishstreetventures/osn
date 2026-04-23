import { render as _baseRender, cleanup, fireEvent } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import type { JSX } from "solid-js";
import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";

import { wrapRouter } from "../helpers/router";

let mockSession: () => { accessToken: string } | null = () => null;

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    session: () => mockSession(),
    login: vi.fn(),
    logout: vi.fn(),
    profiles: () => [
      {
        id: "usr_test",
        handle: "maya",
        email: "maya@example.com",
        displayName: "Maya Chen",
        avatarUrl: null,
      },
    ],
    activeProfileId: () => "usr_test",
    switchProfile: vi.fn(),
    deleteProfile: vi.fn(),
    createProfile: vi.fn(),
  }),
}));

vi.mock("../../src/lib/authClients", () => ({
  registrationClient: {
    checkHandle: vi.fn(),
    beginRegistration: vi.fn(),
    completeRegistration: vi.fn(),
  },
  loginClient: { passkeyBegin: vi.fn(), passkeyComplete: vi.fn() },
  recoveryClient: { generateRecoveryCodes: vi.fn(), loginWithRecoveryCode: vi.fn() },
}));

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => false,
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

vi.mock("solid-toast", async () => {
  const { solidToastMock } = await import("../helpers/toast");
  return solidToastMock();
});

// Must import AFTER mocks are set up
const { ExploreNav } = await import("../../src/explore/ExploreNav");

const render: typeof _baseRender = ((factory: () => JSX.Element) =>
  _baseRender(wrapRouter(factory))) as unknown as typeof _baseRender;

describe("ExploreNav — unauthenticated", () => {
  beforeEach(() => {
    mockSession = () => null;
  });
  afterEach(cleanup);

  it("renders the Pulse brand", () => {
    const { getByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    expect(getByText("Pulse")).toBeTruthy();
  });

  it("shows only Home tab when logged out", () => {
    const { getByText, queryByText } = render(() => (
      <ExploreNav query="" onQueryChange={() => {}} />
    ));
    expect(getByText("Home")).toBeTruthy();
    expect(queryByText("Calendar")).toBeNull();
    expect(queryByText("Hosting")).toBeNull();
  });

  it("renders a Sign in button", () => {
    const { getByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    expect(getByText("Sign in")).toBeTruthy();
  });

  it("does not render Host button or notification bell", () => {
    const { queryByText, queryByTitle } = render(() => (
      <ExploreNav query="" onQueryChange={() => {}} />
    ));
    expect(queryByText("Host")).toBeNull();
    expect(queryByTitle("Notifications")).toBeNull();
  });

  it("renders search input with placeholder", () => {
    const { container } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).toContain("Search events");
  });

  it("calls onQueryChange on search input", () => {
    const onQueryChange = vi.fn();
    const { container } = render(() => <ExploreNav query="" onQueryChange={onQueryChange} />);
    const input = container.querySelector("input")!;
    fireEvent.input(input, { target: { value: "jazz" } });
    expect(onQueryChange).toHaveBeenCalledWith("jazz");
  });

  it("renders hero headline", () => {
    const { container } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toContain("pulsing");
  });

  it("renders keyboard shortcut indicator", () => {
    const { getByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    expect(getByText("⌘K")).toBeTruthy();
  });

  it("renders event count stat when provided", () => {
    const { getByText } = render(() => (
      <ExploreNav query="" onQueryChange={() => {}} eventCount={14} />
    ));
    expect(getByText("14")).toBeTruthy();
    expect(getByText("events nearby")).toBeTruthy();
  });

  it("renders live count stat when provided and > 0", () => {
    const { getByText } = render(() => (
      <ExploreNav query="" onQueryChange={() => {}} liveCount={3} />
    ));
    expect(getByText("3")).toBeTruthy();
    expect(getByText("happening now")).toBeTruthy();
  });

  it("omits live count stat when 0", () => {
    const { queryByText } = render(() => (
      <ExploreNav query="" onQueryChange={() => {}} liveCount={0} />
    ));
    expect(queryByText("happening now")).toBeNull();
  });

  it("omits stats when not provided", () => {
    const { queryByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    expect(queryByText("events nearby")).toBeNull();
    expect(queryByText("happening now")).toBeNull();
  });
});

describe("ExploreNav — authenticated", () => {
  beforeEach(() => {
    mockSession = () => ({
      accessToken:
        "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c3JfdGVzdCIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSIsImhhbmRsZSI6Im1heWEiLCJkaXNwbGF5TmFtZSI6Ik1heWEgQ2hlbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxODAwMDAwMDAwLCJhdWQiOiJvc24tYWNjZXNzIn0.fakesig",
    });
  });
  afterEach(cleanup);

  it("shows Calendar and Hosting tabs", () => {
    const { getByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    expect(getByText("Home")).toBeTruthy();
    expect(getByText("Calendar")).toBeTruthy();
    expect(getByText("Hosting")).toBeTruthy();
  });

  it("renders Host button and notification bell", () => {
    const { getByText, container } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    expect(getByText("Host")).toBeTruthy();
    expect(container.querySelector("[title='Notifications']")).toBeTruthy();
  });

  it("does not render Sign in button", () => {
    const { queryByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    // Should not have a standalone "Sign in" button (avatar dropdown is shown instead)
    const signIn = queryByText("Sign in");
    expect(signIn).toBeNull();
  });

  it("renders avatar", () => {
    const { container } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    // Avatar fallback should show "MA" for "Maya Chen" initials → first 2 chars
    const avatarFallbacks = container.querySelectorAll("span.base\\:relative");
    const found = Array.from(avatarFallbacks).some((el) => el.textContent === "MA");
    expect(found).toBe(true);
  });

  it("includes greeting with user name in hero", () => {
    const { container } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    const hero = container.querySelector("header");
    expect(hero?.textContent).toContain("Maya");
  });
});
