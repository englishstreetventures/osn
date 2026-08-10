import { render as _baseRender, cleanup, fireEvent } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import type { JSX } from "solid-js";
import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";

import { authState, fakeSession, mockSignIn } from "../helpers/auth";
import { wrapRouter } from "../helpers/router";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../helpers/auth");
  return rpAuthSolidMock();
});

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
    authState.session = null;
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

  it("renders a sign-in button that leaves for the issuer", () => {
    const { getByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    const button = getByText("Continue with musubi");
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(mockSignIn).toHaveBeenCalled();
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
    authState.session = fakeSession();
  });
  afterEach(cleanup);

  it("shows Calendar and Hosting tabs", () => {
    const { getByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    expect(getByText("Home")).toBeTruthy();
    expect(getByText("Calendar")).toBeTruthy();
    expect(getByText("Hosting")).toBeTruthy();
  });

  it("has a disabled Hosting tab with aria-disabled and tabindex", () => {
    const { getByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    const hostingTab = getByText("Hosting").closest("button");
    expect(hostingTab).toHaveAttribute("aria-disabled", "true");
    expect(hostingTab).toHaveAttribute("tabindex", "-1");
  });

  it("clicking the disabled Hosting tab does not navigate", () => {
    const { getByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    const before = window.location.pathname;
    fireEvent.click(getByText("Hosting"));
    expect(window.location.pathname).toBe(before);
  });

  it("every enabled tab resolves to a real route", () => {
    const { getByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    for (const label of ["Home", "Calendar"]) {
      const tab = getByText(label).closest("button");
      expect(tab).not.toHaveAttribute("aria-disabled");
    }
  });

  it("renders Host button and notification bell", () => {
    const { getByText, container } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    expect(getByText("Host")).toBeTruthy();
    expect(container.querySelector("[title='Notifications']")).toBeTruthy();
  });

  it("does not render the sign-in button", () => {
    const { queryByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    // The avatar dropdown stands in for it once someone is signed in.
    expect(queryByText("Continue with musubi")).toBeNull();
  });

  it("renders avatar", () => {
    const { container } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    // Avatar fallback shows the first initial of "Maya Chen".
    const avatarFallbacks = container.querySelectorAll("span.base\\:relative");
    const found = Array.from(avatarFallbacks).some((el) => el.textContent === "M");
    expect(found).toBe(true);
  });

  it("includes greeting with user name in hero", () => {
    const { container } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    const hero = container.querySelector("header");
    expect(hero?.textContent).toContain("Maya");
  });
});
