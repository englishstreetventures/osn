import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";

/**
 * The one thing about push only a real browser can answer: does an idle,
 * untouched tab drop a wedding the organiser was removed from, over the
 * browser's own WebSocket? Everything but the socket is stubbed as in
 * `OrganiserApp.test.tsx`; the subscription itself (`@shared/realtime`) runs
 * for real against a WebSocket server the Vitest process holds.
 */

const realtime = vi.hoisted(() => ({ base: "" }));
const authFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@shared/rp-auth/solid", async () => {
  const { createContext, useContext } = await import("solid-js");
  const base = {
    authFetch: (...args: unknown[]) => authFetchMock(...args),
    logout: async () => {},
    session: () => ({
      osnProfileId: "usr_cohost",
      displayName: "Co Host",
      handle: "cohost",
      email: null,
      avatarUrl: null,
      expiresAt: "2099-01-01T00:00:00Z",
    }),
  };
  const AuthContext = createContext<typeof base>();
  return {
    AuthContext,
    AuthProvider: (props: { children: unknown }) => props.children,
    useAuth: () => useContext(AuthContext) ?? base,
  };
});
// Every name the portal imports from it: in the browser a missing named export
// is a SyntaxError at import, not an undefined at use.
vi.mock("@shared/toast", () => ({
  Toaster: () => null,
  toast: { success: () => {}, error: () => {} },
}));
// The same shape `PreviewInviteButton.browser.test.tsx` mocks it with.
// `test-support/mocks`' `organiserApiMock` cannot be loaded from a
// browser-mode factory.
vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    apiUrl: (path: string) => `https://api.test${path}`,
    isAuthExpired: () => false,
    redirectToLogin: () => {},
  };
});
// Point the dashboard's topic at the command-held server instead of cire-api.
vi.mock("../../src/lib/realtime", () => ({
  weddingTopicUrl: (weddingId: string) =>
    `${realtime.base}/realtime/${encodeURIComponent(`cire:wedding:${weddingId}`)}`,
  reportRealtimeFallback: () => {},
}));
// Plain DOM nodes, not JSX, and built through `vi.hoisted`: a browser-mode
// factory runs before the file's imports and top-level consts, and compiled
// JSX calls `solid-js/web` helpers imported at the top. A Solid component may
// return a DOM node.
const { testNode } = vi.hoisted(() => ({
  testNode: (testId: string, text = ""): HTMLElement => {
    const node = document.createElement("div");
    node.dataset.testid = testId;
    node.textContent = text;
    return node;
  },
}));
vi.mock("../../src/components/WeddingList", () => ({
  default: () => testNode("wedding-list"),
}));
vi.mock("../../src/components/ModuleShell", () => ({
  default: (props: { weddingId: string }) => testNode("module-shell", props.weddingId),
}));
vi.mock("../../src/components/PreviewInviteButton", () => ({ default: () => null }));
vi.mock("../../src/components/SecurityPanel", () => ({ default: () => null }));

import OrganiserApp from "../../src/components/OrganiserApp";
import {
  __resetVendorsCache,
  peekCachedVendors,
  setCachedVendors,
  type VendorRow,
} from "../../src/lib/vendors-store";
import { __resetWeddingScope } from "../../src/lib/wedding-scope";

// The same row `OrganiserApp.test.tsx` caches (its `vendorRow`).
const vendorRow = (weddingId: string): VendorRow => ({
  id: `ven_${weddingId}`,
  weddingId,
  directoryVendorId: null,
  name: "Florist",
  category: "florals",
  status: "researching",
  contactName: "Sam",
  email: "sam@example.com",
  phone: "0400 000 000",
  notes: null,
  quotedMinor: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
});

function listResponse(weddings: { id: string; role?: string }[]) {
  return new Response(
    JSON.stringify({
      weddings: weddings.map((w) => ({
        slug: w.id,
        displayName: w.id,
        role: "editor",
        entitlements: [],
        guestCap: 100,
        ...w,
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const SIGNAL = JSON.stringify({ topic: "cire:wedding:wed_a", kind: "members-changed", at: 1 });

beforeAll(async () => {
  const { port } = await commands.startRealtimeServer();
  realtime.base = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await commands.stopRealtimeServer();
});

afterEach(() => {
  cleanup();
  authFetchMock.mockReset();
  __resetWeddingScope();
  __resetVendorsCache();
  history.replaceState(null, "", window.location.pathname + window.location.search);
});

async function openRemovableWedding(): Promise<{ remove: () => void }> {
  history.replaceState(null, "", "#/w/wed_a");
  let removed = false;
  authFetchMock.mockImplementation(async () => listResponse(removed ? [] : [{ id: "wed_a" }]));
  render(() => <OrganiserApp />);
  await waitFor(() => expect(screen.getByTestId("module-shell").textContent).toContain("wed_a"));
  setCachedVendors("wed_a", [vendorRow("wed_a")]);
  await expect.poll(() => commands.realtimeSocketCount()).toBe(1);
  return { remove: () => (removed = true) };
}

describe("OrganiserApp — push, in a real browser", () => {
  it("drops a removed co-host's rows from an idle tab, with no interaction", async () => {
    const wedding = await openRemovableWedding();

    wedding.remove();
    await commands.pushRealtime(SIGNAL);

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(peekCachedVendors("wed_a")).toBeNull();
    // Off the wedding, the tab stops listening.
    await expect.poll(() => commands.realtimeSocketCount()).toBe(0);
  });

  it("re-reads when the socket is dropped, as on a deploy or an eviction", async () => {
    const wedding = await openRemovableWedding();

    wedding.remove();
    await commands.dropRealtime(4001);

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(peekCachedVendors("wed_a")).toBeNull();
  });
});
