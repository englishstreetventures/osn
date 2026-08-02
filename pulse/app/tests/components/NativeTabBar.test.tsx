// @vitest-environment happy-dom
import { useLocation, useNavigate } from "@solidjs/router";
import { render, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";

import { wrapRouter } from "../helpers/router";

let mockSession: () => { accessToken: string } | null = () => null;

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ session: () => mockSession() }),
}));

const installNativeTabBar =
  vi.fn<
    (
      tabs: unknown[],
      selectedId: string | undefined,
      onSelect: (id: string) => void,
    ) => Promise<boolean>
  >();
const setSelectedNativeTab = vi.fn(() => Promise.resolve());
const clearNativeTabs = vi.fn(() => Promise.resolve());
const [active, setActive] = createSignal(false);

vi.mock("../../src/lib/nativeTabBar", () => ({
  installNativeTabBar: (...args: Parameters<typeof installNativeTabBar>) =>
    installNativeTabBar(...args),
  setSelectedNativeTab: (id: string) => setSelectedNativeTab(id),
  clearNativeTabs: () => clearNativeTabs(),
  nativeTabBarActive: () => active(),
}));

const { NativeTabBar } = await import("../../src/components/NativeTabBar");

/** The last `onSelect` handed to the plugin — a tap arrives through this. */
function lastOnSelect(): (id: string) => void {
  const call = installNativeTabBar.mock.calls.at(-1);
  if (!call) throw new Error("the tab bar was never installed");
  return call[2];
}

function tabIds(): string[] {
  const call = installNativeTabBar.mock.calls.at(-1);
  if (!call) throw new Error("the tab bar was never installed");
  return (call[0] as { id: string }[]).map((tab) => tab.id);
}

beforeEach(() => {
  installNativeTabBar.mockReset();
  installNativeTabBar.mockResolvedValue(true);
  setSelectedNativeTab.mockClear();
  clearNativeTabs.mockClear();
  setActive(false);
  mockSession = () => null;
});

afterEach(cleanup);

describe("NativeTabBar", () => {
  it("renders nothing — the bar is a UIKit view, not DOM", () => {
    const { container } = render(wrapRouter(() => <NativeTabBar />));
    expect(container.innerHTML).toBe("");
  });

  it("offers a signed-out visitor only the tabs they can use", () => {
    render(wrapRouter(() => <NativeTabBar />));
    expect(tabIds()).toEqual(["home"]);
  });

  it("offers the full set once there is a session", () => {
    mockSession = () => ({ accessToken: "tok" });
    render(wrapRouter(() => <NativeTabBar />));
    expect(tabIds()).toEqual(["home", "calendar", "hosting"]);
  });

  it("marks the placeholder tab disabled rather than dropping it", () => {
    mockSession = () => ({ accessToken: "tok" });
    render(wrapRouter(() => <NativeTabBar />));
    const tabs = installNativeTabBar.mock.calls.at(-1)![0] as {
      id: string;
      enabled: boolean;
    }[];
    expect(tabs.find((tab) => tab.id === "hosting")?.enabled).toBe(false);
  });

  it("navigates when the user taps a tab", async () => {
    const { findByText } = render(
      wrapRouter(() => (
        <>
          <NativeTabBar />
          <CurrentPath />
        </>
      )),
    );

    lastOnSelect()("calendar");
    expect(await findByText("path:/calendar")).toBeTruthy();
  });

  it("reflects a route change back into the bar", async () => {
    setActive(true);
    const { findByText, getByText } = render(
      wrapRouter(() => (
        <>
          <NativeTabBar />
          <CurrentPath />
        </>
      )),
    );

    setSelectedNativeTab.mockClear();
    getByText("go /calendar").click();
    await findByText("path:/calendar");

    expect(setSelectedNativeTab).toHaveBeenCalledWith("calendar");
  });

  it("does not reinstall the bar on every navigation", async () => {
    setActive(true);
    const { findByText, getByText } = render(
      wrapRouter(() => (
        <>
          <NativeTabBar />
          <CurrentPath />
        </>
      )),
    );
    const installs = installNativeTabBar.mock.calls.length;

    getByText("go /calendar").click();
    await findByText("path:/calendar");

    expect(installNativeTabBar.mock.calls.length).toBe(installs);
  });

  it("tears the bar down on the onboarding route", async () => {
    const { findByText, getByText } = render(
      wrapRouter(() => (
        <>
          <NativeTabBar />
          <CurrentPath />
        </>
      )),
    );

    getByText("go /welcome").click();
    await findByText("path:/welcome");

    expect(clearNativeTabs).toHaveBeenCalled();
  });
});

/** Shows the current route and offers links to change it. */
function CurrentPath() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span>path:{location.pathname}</span>
      <button type="button" onClick={() => navigate("/calendar")}>
        go /calendar
      </button>
      <button type="button" onClick={() => navigate("/welcome")}>
        go /welcome
      </button>
    </>
  );
}
