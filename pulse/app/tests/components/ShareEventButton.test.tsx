import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-toast", async () => {
  const { solidToastMock } = await import("../helpers/toast");
  return solidToastMock();
});
import { mockToastSuccess } from "../helpers/toast";

const mockRecordShareInvoked = vi.fn(() => Promise.resolve());
vi.mock("../../src/lib/rsvps", () => ({
  recordShareInvoked: (...args: unknown[]) => mockRecordShareInvoked(...args),
}));

// Default to desktop (Popover) so the trigger renders the popover branch.
// Tests that need the mobile Dialog branch override this mock per-render.
const mockIsMobile = vi.fn(() => false);
vi.mock("../../src/lib/useIsMobile", () => ({
  createIsMobile: () => mockIsMobile,
}));

import { ShareEventButton } from "../../src/components/ShareEventButton";

const writeText = vi.fn(() => Promise.resolve());
const navigatorShare = vi.fn(() => Promise.resolve());
const windowOpen = vi.fn();

beforeEach(() => {
  // Stable origin for URL construction.
  Object.defineProperty(window, "location", {
    value: { origin: "https://pulse.app" },
    writable: true,
  });
  // Clipboard + share-sheet stubs. Tests that exercise the missing-API
  // fallback re-stub these per-test.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  Object.defineProperty(navigator, "share", {
    value: navigatorShare,
    configurable: true,
  });
  vi.stubGlobal("open", windowOpen);
});

afterEach(() => {
  cleanup();
  mockRecordShareInvoked.mockClear();
  mockToastSuccess.mockReset();
  writeText.mockClear();
  navigatorShare.mockClear();
  windowOpen.mockClear();
  mockIsMobile.mockReturnValue(false);
  vi.unstubAllGlobals();
});

// Kobalte portals popover/dialog content — scan the whole document with `screen`.
function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: /share event/i }));
}

describe("ShareEventButton", () => {
  it("opens a Popover and renders all destinations on desktop", async () => {
    render(() => <ShareEventButton eventId="evt_1" eventTitle="Party" />);
    openPicker();
    for (const label of [
      "WhatsApp",
      "X / Twitter",
      "Facebook",
      "Instagram",
      "TikTok",
      "Copy link",
      "More…",
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await screen.findByText(label)).toBeTruthy();
    }
  });

  it("WhatsApp opens wa.me with a sourced URL and records the share", async () => {
    render(() => <ShareEventButton eventId="evt_1" eventTitle="Party" />);
    openPicker();
    fireEvent.click(await screen.findByText("WhatsApp"));
    await waitFor(() => {
      expect(windowOpen).toHaveBeenCalledTimes(1);
      const [intentUrl] = windowOpen.mock.calls[0]!;
      expect(intentUrl).toContain("https://wa.me/");
      expect(intentUrl).toContain(encodeURIComponent("https://pulse.app/events/evt_1"));
      expect(intentUrl).toContain(encodeURIComponent("?source=whatsapp"));
      expect(mockRecordShareInvoked).toHaveBeenCalledWith("evt_1", "whatsapp", null);
    });
  });

  it("X / Twitter opens the tweet intent with the sourced URL and title", async () => {
    render(() => <ShareEventButton eventId="evt_1" eventTitle="Party" />);
    openPicker();
    fireEvent.click(await screen.findByText("X / Twitter"));
    await waitFor(() => {
      const [intentUrl] = windowOpen.mock.calls[0]!;
      expect(intentUrl).toContain("twitter.com/intent/tweet");
      expect(intentUrl).toContain(encodeURIComponent("?source=x"));
      expect(mockRecordShareInvoked).toHaveBeenCalledWith("evt_1", "x", null);
    });
  });

  it("Facebook opens the sharer with the sourced URL", async () => {
    render(() => <ShareEventButton eventId="evt_1" eventTitle="Party" />);
    openPicker();
    fireEvent.click(await screen.findByText("Facebook"));
    await waitFor(() => {
      const [intentUrl] = windowOpen.mock.calls[0]!;
      expect(intentUrl).toContain("facebook.com/sharer/sharer.php");
      expect(intentUrl).toContain(encodeURIComponent("?source=facebook"));
      expect(mockRecordShareInvoked).toHaveBeenCalledWith("evt_1", "facebook", null);
    });
  });

  it("Instagram falls back to clipboard with a sourced URL", async () => {
    render(() => <ShareEventButton eventId="evt_1" eventTitle="Party" />);
    openPicker();
    fireEvent.click(await screen.findByText("Instagram"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://pulse.app/events/evt_1?source=instagram");
      expect(mockRecordShareInvoked).toHaveBeenCalledWith("evt_1", "instagram", null);
      expect(mockToastSuccess).toHaveBeenCalled();
    });
  });

  it("Copy link writes the sourced URL to the clipboard", async () => {
    render(() => <ShareEventButton eventId="evt_1" eventTitle="Party" />);
    openPicker();
    fireEvent.click(await screen.findByText("Copy link"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://pulse.app/events/evt_1?source=copy_link");
      expect(mockRecordShareInvoked).toHaveBeenCalledWith("evt_1", "copy_link", null);
    });
  });

  it("'More…' uses navigator.share when available, tagged source=other", async () => {
    render(() => <ShareEventButton eventId="evt_1" eventTitle="Party" />);
    openPicker();
    fireEvent.click(await screen.findByText("More…"));
    await waitFor(() => {
      expect(navigatorShare).toHaveBeenCalledWith({
        url: "https://pulse.app/events/evt_1?source=other",
        title: "Party",
      });
      expect(mockRecordShareInvoked).toHaveBeenCalledWith("evt_1", "other", null);
    });
  });

  it("'More…' falls back to clipboard when navigator.share is missing", async () => {
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    render(() => <ShareEventButton eventId="evt_1" eventTitle="Party" />);
    openPicker();
    fireEvent.click(await screen.findByText("More…"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://pulse.app/events/evt_1?source=other");
      expect(mockRecordShareInvoked).toHaveBeenCalledWith("evt_1", "other", null);
    });
  });

  it("forwards the access token to the share telemetry ping when provided", async () => {
    render(() => <ShareEventButton eventId="evt_1" eventTitle="Party" accessToken="tok" />);
    openPicker();
    fireEvent.click(await screen.findByText("Copy link"));
    await waitFor(() => {
      expect(mockRecordShareInvoked).toHaveBeenCalledWith("evt_1", "copy_link", "tok");
    });
  });

  it("encodes the event id into the shared URL path", async () => {
    render(() => <ShareEventButton eventId="evt /a#b" eventTitle="Party" />);
    openPicker();
    fireEvent.click(await screen.findByText("Copy link"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://pulse.app/events/evt%20%2Fa%23b?source=copy_link",
      );
    });
  });

  it("on mobile, the trigger opens a Dialog with the same destination grid", async () => {
    mockIsMobile.mockReturnValue(true);
    render(() => <ShareEventButton eventId="evt_1" eventTitle="Party" />);
    openPicker();
    expect(await screen.findByText("Share event")).toBeTruthy();
    expect(await screen.findByText("WhatsApp")).toBeTruthy();
  });
});
