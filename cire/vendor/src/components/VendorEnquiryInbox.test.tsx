// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@osn/client/solid", () => ({
  AuthProvider: (props: any) => props.children,
  useAuth: () => ({
    session: () => ({ profile: { id: "p1" } }),
    authFetch: vi.fn(),
    logout: vi.fn(),
  }),
}));

// Mock enquiries-store so tests resolve predictably without a real backend.
const mockListEnquiries = vi.fn();
vi.mock("../lib/enquiries-store", () => ({
  listEnquiries: (...args: any[]) => mockListEnquiries(...args),
}));

import VendorEnquiryInbox from "./VendorEnquiryInbox";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Test data ─────────────────────────────────────────────────────────────────

const baseItem = {
  id: "enq-1",
  weddingId: "w1",
  directoryVendorId: "dv1",
  vendorId: "v1",
  zapChatId: null,
  status: "open" as const,
  createdBy: "p1",
  quotedMinor: null,
  lastMessageAt: Date.now() - 3600_000, // 1 hour ago
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 3600_000,
  vendorName: "Blooms & Co",
  category: "florals",
  weddingName: "Alex & Sam",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VendorEnquiryInbox", () => {
  it("shows a loading state while fetching", () => {
    // Never resolves during this test
    mockListEnquiries.mockReturnValue(new Promise(() => {}));
    render(() => <VendorEnquiryInbox onOpen={vi.fn()} />);
    expect(screen.getByText(/loading enquiries/i)).toBeInTheDocument();
  });

  it("renders a row with weddingName and category label", async () => {
    mockListEnquiries.mockResolvedValue([baseItem]);
    render(() => <VendorEnquiryInbox onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Alex & Sam")).toBeInTheDocument());
    expect(screen.getByText("Florals")).toBeInTheDocument();
  });

  it("calls onOpen with the enquiry id when a row is clicked", async () => {
    mockListEnquiries.mockResolvedValue([baseItem]);
    const onOpen = vi.fn();
    render(() => <VendorEnquiryInbox onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText("Alex & Sam")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Alex & Sam/i }));
    expect(onOpen).toHaveBeenCalledWith("enq-1");
  });

  it("shows an empty-state message when there are no enquiries", async () => {
    mockListEnquiries.mockResolvedValue([]);
    render(() => <VendorEnquiryInbox onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/no enquiries yet/i)).toBeInTheDocument());
  });

  it("shows an error state when listEnquiries rejects", async () => {
    mockListEnquiries.mockRejectedValue(new Error("network error"));
    render(() => <VendorEnquiryInbox onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("shows the status chip", async () => {
    mockListEnquiries.mockResolvedValue([baseItem]);
    render(() => <VendorEnquiryInbox onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Alex & Sam")).toBeInTheDocument());
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("shows the quoted amount when quotedMinor is set", async () => {
    const quotedItem = { ...baseItem, quotedMinor: 250000 }; // $2500.00
    mockListEnquiries.mockResolvedValue([quotedItem]);
    render(() => <VendorEnquiryInbox onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Alex & Sam")).toBeInTheDocument());
    // Check that a currency-formatted amount is shown (contains "2,500" or "2500")
    expect(screen.getByText(/2[,.]?500/)).toBeInTheDocument();
  });
});
