// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnquiryListItem, EnquiryMessage } from "../lib/enquiries-store";
import { __resetEnquiriesCache, setCachedEnquiries } from "../lib/enquiries-store";

/**
 * EnquiriesView — the container that wires the store + API helpers into the
 * EnquiryInbox ↔ EnquiryThread surface. Tests:
 * - inbox rows render from a pre-seeded store;
 * - clicking an inbox row fetches messages and shows the thread;
 * - the non-E2E notice is visible in the thread;
 * - Back returns to the inbox;
 * - when the store is empty the container calls fetchEnquiries.
 */

const authFetch = vi.fn();
const activeProfileId = vi.fn(() => "p_me");

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch, activeProfileId }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  redirectToLogin: vi.fn(),
}));

const makeItem = (over: Partial<EnquiryListItem> = {}): EnquiryListItem => ({
  id: "enq_1",
  weddingId: "wed_1",
  directoryVendorId: "dv_1",
  vendorId: "ven_1",
  zapChatId: null,
  status: "open",
  createdBy: "p_me",
  quotedMinor: null,
  lastMessageAt: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  vendorName: "Blue Roses",
  category: "florals",
  ...over,
});

const makeMessage = (over: Partial<EnquiryMessage> = {}): EnquiryMessage => ({
  id: "msg_1",
  senderProfileId: "p_vendor",
  body: "Hello, we would love to work with you!",
  createdAt: Date.now(),
  ...over,
});

beforeEach(() => {
  __resetEnquiriesCache();
  authFetch.mockReset();
  activeProfileId.mockReturnValue("p_me");
});

afterEach(() => {
  cleanup();
});

// Lazy import so mocks take effect before module evaluation.
async function importComponent() {
  const { default: EnquiriesView } = await import("./EnquiriesView");
  return EnquiriesView;
}

describe("EnquiriesView", () => {
  it("renders inbox rows from the pre-seeded store", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", [makeItem()]);
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    expect(await screen.findByText("Blue Roses")).toBeInTheDocument();
  });

  it("shows an empty-state when the store has no enquiries", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", []);
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    expect(await screen.findByText(/no enquiries yet/i)).toBeInTheDocument();
  });

  it("calls fetchEnquiries (authFetch GET) when the store is empty", async () => {
    const EnquiriesView = await importComponent();
    // Store is empty (reset in beforeEach). The container should call authFetch
    // with a GET to the enquiries endpoint.
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ enquiries: [makeItem()] }), { status: 200 }),
    );
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/enquiries$/);
    expect(await screen.findByText("Blue Roses")).toBeInTheDocument();
  });

  it("clicking an inbox row fetches messages and renders the thread", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", [makeItem()]);
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [makeMessage({ body: "Hello from vendor!" })] }), {
        status: 200,
      }),
    );
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    fireEvent.click(await screen.findByText("Blue Roses"));
    // Thread renders the message body.
    expect(await screen.findByText("Hello from vendor!")).toBeInTheDocument();
    // authFetch called with messages URL.
    const [url] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/messages$/);
  });

  it("shows the non-E2E notice in the thread view", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", [makeItem()]);
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    fireEvent.click(await screen.findByText("Blue Roses"));
    expect(await screen.findByText(/Enquiries aren't end-to-end encrypted/i)).toBeInTheDocument();
  });

  it("clicking Back returns to the inbox", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", [makeItem()]);
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    fireEvent.click(await screen.findByText("Blue Roses"));
    // Wait for thread to render.
    await screen.findByText(/Enquiries aren't end-to-end encrypted/i);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    // Back to inbox.
    expect(await screen.findByText("Blue Roses")).toBeInTheDocument();
    expect(screen.queryByText(/Enquiries aren't end-to-end encrypted/i)).not.toBeInTheDocument();
  });
});
