// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach } from "vitest";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
const isTauri = vi.fn(() => true);

class FakeChannel<T> {
  onmessage: ((response: T) => void) | undefined;
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  isTauri: () => isTauri(),
  Channel: FakeChannel,
}));

/**
 * `nativeTabBarActive` is module state by design — the DOM tabs read it from
 * anywhere. Each test therefore gets a fresh copy of the module.
 */
async function freshModule() {
  vi.resetModules();
  return import("../../src/lib/nativeTabBar");
}

const TABS = [{ id: "home", title: "Home", systemImage: "sparkles", enabled: true }];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  isTauri.mockReturnValue(true);
});

describe("installNativeTabBar", () => {
  it("sends the tabs and the selection channel in one call", async () => {
    const { installNativeTabBar, nativeTabBarActive } = await freshModule();

    expect(await installNativeTabBar(TABS, "home", () => {})).toBe(true);
    expect(nativeTabBarActive()).toBe(true);

    const [cmd, args] = invoke.mock.calls[0]!;
    expect(cmd).toBe("plugin:pulse-tabbar|set_tabs");
    const payload = args as { options: unknown; onSelect: unknown };
    expect(payload.options).toEqual({ tabs: TABS, selectedId: "home" });
    expect(payload.onSelect).toBeInstanceOf(FakeChannel);
  });

  it("routes a tap on the native bar back to the caller", async () => {
    const { installNativeTabBar } = await freshModule();
    const onSelect = vi.fn();
    await installNativeTabBar(TABS, "home", onSelect);

    const channel = (invoke.mock.calls[0]![1] as { onSelect: FakeChannel<{ id: string }> })
      .onSelect;
    channel.onmessage?.({ id: "calendar" });

    expect(onSelect).toHaveBeenCalledWith("calendar");
  });

  it("stays inactive off iOS, so the DOM tabs keep rendering", async () => {
    const { installNativeTabBar, nativeTabBarActive } = await freshModule();
    invoke.mockRejectedValue("a native tab bar is only available on iOS");

    expect(await installNativeTabBar(TABS, "home", () => {})).toBe(false);
    expect(nativeTabBarActive()).toBe(false);
  });

  it("does not reach for the IPC outside a Tauri webview at all", async () => {
    const { installNativeTabBar } = await freshModule();
    isTauri.mockReturnValue(false);

    expect(await installNativeTabBar(TABS, "home", () => {})).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("setSelectedNativeTab", () => {
  it("does nothing while no native bar is installed", async () => {
    const { setSelectedNativeTab } = await freshModule();
    await setSelectedNativeTab("home");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("moves the highlight once a bar is up", async () => {
    const { installNativeTabBar, setSelectedNativeTab } = await freshModule();
    await installNativeTabBar(TABS, "home", () => {});
    invoke.mockClear();

    await setSelectedNativeTab("calendar");
    expect(invoke).toHaveBeenCalledWith("plugin:pulse-tabbar|set_selected_tab", {
      options: { id: "calendar" },
    });
  });

  it("swallows a rejection for a route with no tab of its own", async () => {
    const { installNativeTabBar, setSelectedNativeTab } = await freshModule();
    await installNativeTabBar(TABS, "home", () => {});
    invoke.mockRejectedValue("no tab with id `hosting`");

    await expect(setSelectedNativeTab("hosting")).resolves.toBeUndefined();
  });
});

describe("clearNativeTabs", () => {
  it("tears the bar down with an empty tab list and goes inactive", async () => {
    const { installNativeTabBar, clearNativeTabs, nativeTabBarActive } = await freshModule();
    await installNativeTabBar(TABS, "home", () => {});
    invoke.mockClear();

    await clearNativeTabs();

    expect(nativeTabBarActive()).toBe(false);
    const [cmd, args] = invoke.mock.calls[0]!;
    expect(cmd).toBe("plugin:pulse-tabbar|set_tabs");
    expect((args as { options: { tabs: unknown[] } }).options.tabs).toEqual([]);
  });

  it("does not reach for the IPC outside a Tauri webview", async () => {
    const { clearNativeTabs } = await freshModule();
    isTauri.mockReturnValue(false);

    await clearNativeTabs();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels an install still in flight rather than letting it land", async () => {
    const { installNativeTabBar, clearNativeTabs, nativeTabBarActive } = await freshModule();

    // The router can reach `/welcome` before the install for the previous
    // route has come back. The stale install must not put a bar on screen.
    let settle!: () => void;
    invoke.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const install = installNativeTabBar(TABS, "home", () => {});

    await clearNativeTabs();
    settle();

    expect(await install).toBe(false);
    expect(nativeTabBarActive()).toBe(false);
  });
});
