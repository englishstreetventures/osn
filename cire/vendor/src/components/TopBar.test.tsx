// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TopBar from "./TopBar";
// Side-effect import, deliberately unused. `TopBar` pulls `ProfileMenu` through
// `lazy()`, and vitest transforms it and the whole Kobalte graph on demand — a
// multi-second cost that balloons under a concurrent `turbo run test`. Paying it
// here puts it in the module-load phase, where vitest does not impose a timeout;
// doing it in a `beforeAll` instead capped it at 10s and failed the whole file
// (12 tests skipped) the moment the machine was busy. Production serves a
// prebuilt chunk, so this latency was never the thing under test — the swap is.
import "./ProfileMenu";
import ViewTabs from "./ViewTabs";

/**
 * The chrome's contract.
 *
 * `ViewTabs` leans on `createSlidingPill`, which measures with
 * `getBoundingClientRect` and a `ResizeObserver` — neither of which happy-dom
 * computes. The pill's *geometry* is therefore tested in `lib/sliding-pill`,
 * against fed rectangles. What is testable here is everything a keyboard or a
 * screen reader depends on: what the controls are called, which one says it is
 * current, and what happens when they are pressed.
 */

const session = {
  displayName: "Acme Florals",
  handle: "acme",
  email: "hello@acme.test",
} as never;

beforeEach(() => {
  // happy-dom has no ResizeObserver; the pill observes the track and each item.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ViewTabs", () => {
  it("names both views and marks only the open one as current", () => {
    render(() => <ViewTabs value="listings" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Listings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Enquiries" })).not.toHaveAttribute("aria-current");
  });

  it("reports the view that was picked", () => {
    const onChange = vi.fn();
    render(() => <ViewTabs value="listings" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Enquiries" }));
    expect(onChange).toHaveBeenCalledWith("enquiries");
  });

  it("is not announced as an ARIA tablist", () => {
    // These swap the whole page and push history. The tab pattern promises a
    // panel that is a sibling of the strip plus roving arrow-key focus, and
    // neither is true here — so claiming the role would describe a control the
    // keyboard does not actually provide.
    render(() => <ViewTabs value="listings" onChange={() => {}} />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("keeps the moving highlight out of the accessibility tree", () => {
    const { container } = render(() => <ViewTabs value="enquiries" onChange={() => {}} />);
    const pill = container.querySelector("[aria-hidden='true']");
    expect(pill).not.toBeNull();
    // It must not eat the clicks meant for the labels underneath it.
    expect(pill).toHaveClass("pointer-events-none");
  });
});

describe("TopBar", () => {
  it("removes the boot chrome once the real bar exists", () => {
    const boot = document.createElement("header");
    boot.id = "boot-chrome";
    document.body.append(boot);

    render(() => (
      <TopBar
        session={session}
        view="listings"
        onView={() => {}}
        onHome={() => {}}
        onSignOut={() => {}}
      />
    ));

    expect(document.getElementById("boot-chrome")).toBeNull();
  });

  it("says where the wordmark goes, since it is a control and not a logo", () => {
    render(() => (
      <TopBar
        session={session}
        view="listings"
        onView={() => {}}
        onHome={() => {}}
        onSignOut={() => {}}
      />
    ));
    // The glyph and the word are both aria-hidden, so the label is the only
    // name this button has — a logo that navigates and doesn't announce it is a
    // trap for anyone not looking at it.
    expect(screen.getByRole("button", { name: /cire — your listings/i })).toBeInTheDocument();
  });

  it("takes the wordmark home", () => {
    const onHome = vi.fn();
    render(() => (
      <TopBar
        session={session}
        view="enquiries"
        onView={() => {}}
        onHome={onHome}
        onSignOut={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: /cire — your listings/i }));
    expect(onHome).toHaveBeenCalled();
  });

  it("carries the view tabs and passes a pick straight through", () => {
    const onView = vi.fn();
    render(() => (
      <TopBar
        session={session}
        view="listings"
        onView={onView}
        onHome={() => {}}
        onSignOut={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Enquiries" }));
    expect(onView).toHaveBeenCalledWith("enquiries");
  });

  it("puts the account behind a menu rather than in the bar", () => {
    render(() => (
      <TopBar
        session={session}
        view="listings"
        onView={() => {}}
        onHome={() => {}}
        onSignOut={() => {}}
      />
    ));
    // Sign out used to be a third bare button beside the two view toggles,
    // which put "leave" one mis-click from "switch view".
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /account menu/i })).toBeInTheDocument();
  });

  // ── The deferred account menu (P-W1) ──────────────────────────────────────
  //
  // Kobalte's dropdown-menu is the package's only consumer of the library and
  // is ~28.6 KB gzip, so it is behind a `lazy()`. What has to stay true is that
  // deferring it costs the vendor nothing they can perceive: the placeholder is
  // named, it is a real control, and a press on it is not swallowed.

  // Generous because Suspense settling and Kobalte mounting are not instant,
  // but no longer covering a module transform — see the static import at the
  // top of this file.
  const CHUNK = { timeout: 5000 };

  const renderBar = (onSignOut = () => {}) =>
    render(() => (
      <TopBar
        session={session}
        view="listings"
        onView={() => {}}
        onHome={() => {}}
        onSignOut={onSignOut}
      />
    ));

  it("does not pull Kobalte onto the first frame", () => {
    renderBar();
    // The placeholder is a plain button. The real trigger is a Kobalte one and
    // carries `aria-expanded`; its absence is what proves the library has not
    // been mounted yet.
    const trigger = screen.getByRole("button", { name: /account menu/i });
    expect(trigger).not.toHaveAttribute("aria-expanded");
  });

  it("names the placeholder, so the wait is not a mystery to a screen reader", () => {
    renderBar();
    const trigger = screen.getByRole("button", { name: /account menu/i });
    // Reachable by keyboard while it is up, so it must announce what it is and
    // that it opens something.
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger.tagName).toBe("BUTTON");
  });

  it("shows the same avatar before and after the swap, so nothing flashes", async () => {
    renderBar();
    const before = screen.getByRole("button", { name: /account menu/i });
    // "Acme Florals" → "A", the same initial the real trigger renders.
    expect(before.textContent).toBe("A");
    const boxBefore = before.className;

    fireEvent.pointerEnter(before);

    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /account menu/i })).toHaveAttribute(
          "aria-expanded",
        ),
      CHUNK,
    );
    const after = screen.getByRole("button", { name: /account menu/i });
    expect(after.textContent).toBe("A");
    // Same box, so the swap moves nothing.
    expect(after.className).toBe(boxBefore);
  });

  it("loads the menu on focus, before a click can arrive", async () => {
    renderBar();
    fireEvent.focus(screen.getByRole("button", { name: /account menu/i }));
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /account menu/i })).toHaveAttribute(
          "aria-expanded",
        ),
      CHUNK,
    );
  });

  it("does not swallow a click that lands before the chunk does", async () => {
    // The failure this guards: the button you pressed is replaced by a
    // different button that is not open, and your press did nothing.
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));

    // Asserted on the menu's contents rather than the trigger's
    // `aria-expanded`: Kobalte's menu is modal, so while it is open the trigger
    // is outside the accessible tree and a role query cannot reach it. The
    // items being reachable is the stronger claim anyway — it is what "the
    // click was not swallowed" actually means.
    expect(await screen.findByRole("menuitem", { name: /sign out/i }, CHUNK)).toBeInTheDocument();
  });

  it("leaves the menu closed when it was merely warmed, not pressed", async () => {
    renderBar();
    fireEvent.pointerEnter(screen.getByRole("button", { name: /account menu/i }));

    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /account menu/i })).toHaveAttribute(
          "aria-expanded",
        ),
      CHUNK,
    );
    // Hovering is not asking for it to open.
    expect(screen.getByRole("button", { name: /account menu/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("menuitem", { name: /sign out/i })).not.toBeInTheDocument();
  });

  it("signs out through the loaded menu", async () => {
    const onSignOut = vi.fn();
    renderBar(onSignOut);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));

    const item = await screen.findByRole("menuitem", { name: /sign out/i }, CHUNK);
    fireEvent.pointerDown(item, { button: 0 });
    fireEvent.pointerUp(item, { button: 0 });
    fireEvent.click(item);

    await waitFor(() => expect(onSignOut).toHaveBeenCalled());
  });
});
