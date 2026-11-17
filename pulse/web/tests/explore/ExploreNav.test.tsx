import { render as _baseRender, cleanup } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import type { JSX } from "solid-js";
import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";

import { authState, fakeSession } from "../helpers/auth";
import { wrapRouter } from "../helpers/router";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../helpers/auth");
  return rpAuthSolidMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../helpers/toast");
  return toastMock();
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

  it("shows only Home tab when logged out", () => {
    const { getByText, queryByText } = render(() => (
      <ExploreNav query="" onQueryChange={() => {}} />
    ));
    expect(getByText("Home")).toBeTruthy();
    expect(queryByText("Calendar")).toBeNull();
    expect(queryByText("Hosting")).toBeNull();
  });

  it("does not render Host button or notification bell", () => {
    const { queryByText, queryByTitle } = render(() => (
      <ExploreNav query="" onQueryChange={() => {}} />
    ));
    expect(queryByText("Host")).toBeNull();
    expect(queryByTitle("Notifications")).toBeNull();
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

  it("has a disabled Hosting tab with aria-disabled and tabindex", () => {
    const { getByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    const hostingTab = getByText("Hosting").closest("button");
    expect(hostingTab).toHaveAttribute("aria-disabled", "true");
    expect(hostingTab).toHaveAttribute("tabindex", "-1");
  });

  it("does not render the sign-in button", () => {
    const { queryByText } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    // The avatar dropdown stands in for it once someone is signed in.
    expect(queryByText("Continue with musubi")).toBeNull();
  });

  it("includes greeting with user name in hero", () => {
    const { container } = render(() => <ExploreNav query="" onQueryChange={() => {}} />);
    const hero = container.querySelector("header");
    expect(hero?.textContent).toContain("Maya");
  });
});
