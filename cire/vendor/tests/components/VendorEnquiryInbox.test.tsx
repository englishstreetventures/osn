// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import VendorEnquiryInbox from "../../src/components/VendorEnquiryInbox";
import type { VendorEnquiryListItem, VendorEnquiryPage } from "../../src/lib/enquiries-store";
import { createEnquiryInbox } from "../../src/lib/enquiry-inbox";

// ── The inbox's page source ───────────────────────────────────────────────────

/** Stands in for `listEnquiries`: called with the cursor, or nothing for page one. */
const mockListEnquiries = vi.fn<(cursor?: string) => Promise<VendorEnquiryPage>>();

const pageOf = (enquiries: VendorEnquiryListItem[], nextCursor: string | null = null) => ({
  enquiries,
  nextCursor,
});

function renderInbox(onOpen: (id: string) => void = vi.fn()) {
  // Made once, outside the JSX: a component prop is a getter, so an inline
  // call would make a new holder on every read.
  return render(() => {
    const inbox = createEnquiryInbox(mockListEnquiries);
    return <VendorEnquiryInbox inbox={inbox} onOpen={onOpen} />;
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Test data ─────────────────────────────────────────────────────────────────

const baseItem: VendorEnquiryListItem = {
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
    renderInbox();
    expect(screen.getByText(/loading enquiries/i)).toBeInTheDocument();
  });

  it("renders a row with weddingName and category label", async () => {
    mockListEnquiries.mockResolvedValue(pageOf([baseItem]));
    renderInbox();
    await waitFor(() => expect(screen.getByText("Alex & Sam")).toBeInTheDocument());
    expect(screen.getByText("Florals")).toBeInTheDocument();
  });

  it("calls onOpen with the enquiry id when a row is clicked", async () => {
    mockListEnquiries.mockResolvedValue(pageOf([baseItem]));
    const onOpen = vi.fn();
    renderInbox(onOpen);
    await waitFor(() => expect(screen.getByText("Alex & Sam")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Alex & Sam/i }));
    expect(onOpen).toHaveBeenCalledWith("enq-1");
  });

  it("shows an empty-state message when there are no enquiries", async () => {
    mockListEnquiries.mockResolvedValue(pageOf([]));
    renderInbox();
    await waitFor(() => expect(screen.getByText(/no enquiries yet/i)).toBeInTheDocument());
  });

  it("shows an error state when listEnquiries rejects", async () => {
    mockListEnquiries.mockRejectedValue(new Error("network error"));
    renderInbox();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("shows the status chip", async () => {
    mockListEnquiries.mockResolvedValue(pageOf([baseItem]));
    renderInbox();
    await waitFor(() => expect(screen.getByText("Alex & Sam")).toBeInTheDocument());
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("shows the quoted amount when quotedMinor is set", async () => {
    const quotedItem = { ...baseItem, quotedMinor: 250000 }; // $2500.00
    mockListEnquiries.mockResolvedValue(pageOf([quotedItem]));
    renderInbox();
    await waitFor(() => expect(screen.getByText("Alex & Sam")).toBeInTheDocument());
    // Check that a currency-formatted amount is shown (contains "2,500" or "2500")
    expect(screen.getByText(/2[,.]?500/)).toBeInTheDocument();
  });

  // ── Relative age ─────────────────────────────────────────────────────

  it("never renders a negative age when the server clock runs ahead", async () => {
    // `lastMessageAt` and `Date.now()` come from two different clocks. A message
    // written a second ago on a machine whose clock is a minute fast used to
    // render as "-1m ago".
    mockListEnquiries.mockResolvedValue(
      pageOf([{ ...baseItem, lastMessageAt: Date.now() + 90_000 }]),
    );
    renderInbox();

    const age = await screen.findByText(/ago$/);
    expect(age).toHaveTextContent("0m ago");
  });

  it("formats the three bands it has", async () => {
    for (const [offsetMs, expected] of [
      [5 * 60_000, "5m ago"],
      [3 * 3600_000, "3h ago"],
      [6 * 86_400_000, "6d ago"],
    ] as const) {
      mockListEnquiries.mockResolvedValue(
        pageOf([{ ...baseItem, lastMessageAt: Date.now() - offsetMs }]),
      );
      const { unmount } = renderInbox();
      const age = await screen.findByText(/ago$/);
      expect({ expected, got: age.textContent }).toEqual({ expected, got: expected });
      unmount();
    }
  });

  // ── Pages ────────────────────────────────────────────────────────────

  it("loads the next page under the first, and stops offering one after the last", async () => {
    mockListEnquiries
      .mockResolvedValueOnce(pageOf([baseItem], "1700.enq-1"))
      .mockResolvedValueOnce(
        pageOf([{ ...baseItem, id: "enq-0", weddingName: "Kim & Lee" }], null),
      );
    renderInbox();

    fireEvent.click(await screen.findByRole("button", { name: "Load more enquiries" }));

    expect(await screen.findByText("Kim & Lee")).toBeInTheDocument();
    expect(screen.getByText("Alex & Sam")).toBeInTheDocument();
    expect(mockListEnquiries).toHaveBeenLastCalledWith("1700.enq-1");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument(),
    );
  });

  it("keeps the rows shown and says so when the next page fails", async () => {
    mockListEnquiries
      .mockResolvedValueOnce(pageOf([baseItem], "1700.enq-1"))
      .mockRejectedValueOnce(new Error("network down"));
    renderInbox();

    fireEvent.click(await screen.findByRole("button", { name: "Load more enquiries" }));

    expect(await screen.findByText(/could not load more enquiries/i)).toBeInTheDocument();
    expect(screen.getByText("Alex & Sam")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more enquiries" })).toBeEnabled();
  });

  it("still holds the loaded pages when it mounts again after a thread", async () => {
    mockListEnquiries
      .mockResolvedValueOnce(pageOf([baseItem], "1700.enq-1"))
      .mockResolvedValueOnce(pageOf([{ ...baseItem, id: "enq-0", weddingName: "Kim & Lee" }], null))
      // Page one, read again on the second mount.
      .mockResolvedValueOnce(pageOf([baseItem], "1700.enq-1"));
    const [shown, setShown] = createSignal(true);
    render(() => {
      const inbox = createEnquiryInbox(mockListEnquiries);
      return (
        <Show when={shown()}>
          <VendorEnquiryInbox inbox={inbox} onOpen={vi.fn()} />
        </Show>
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: "Load more enquiries" }));
    await screen.findByText("Kim & Lee");

    setShown(false);
    setShown(true);

    // Shown at once from what is held, and still there once page one is back.
    expect(screen.getByText("Kim & Lee")).toBeInTheDocument();
    await waitFor(() => expect(mockListEnquiries).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Kim & Lee")).toBeInTheDocument();
    expect(screen.getByText("Alex & Sam")).toBeInTheDocument();
  });
});
