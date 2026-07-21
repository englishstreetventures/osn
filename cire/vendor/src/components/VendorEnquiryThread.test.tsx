// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAuthFetch = vi.fn();

vi.mock("@osn/client/solid", () => ({
  AuthProvider: (props: any) => props.children,
  useAuth: () => ({
    session: () => ({ profile: { id: "p-vendor" } }),
    authFetch: mockAuthFetch,
    logout: vi.fn(),
  }),
}));

// Mutable mock functions so each test can configure them.
const mockGetEnquiryMessages = vi.fn();
const mockReplyToEnquiry = vi.fn();
const mockSubmitQuote = vi.fn();
const mockFriendlyEnquiryError = vi.fn((err: unknown) =>
  err instanceof Error ? err.message : String(err),
);

vi.mock("../lib/enquiries-store", () => ({
  getEnquiryMessages: (...args: any[]) => mockGetEnquiryMessages(...args),
  replyToEnquiry: (...args: any[]) => mockReplyToEnquiry(...args),
  submitQuote: (...args: any[]) => mockSubmitQuote(...args),
  friendlyEnquiryError: (...args: any[]) => mockFriendlyEnquiryError(...args),
}));

// Mock solid-toast so we can verify toast calls without a real DOM toaster.
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock("solid-toast", () => ({
  toast: {
    success: (...args: any[]) => mockToastSuccess(...args),
    error: (...args: any[]) => mockToastError(...args),
  },
  Toaster: () => null,
}));

import VendorEnquiryThread from "./VendorEnquiryThread";

// ── Test data ─────────────────────────────────────────────────────────────────

const makeMessage = (
  overrides: Partial<{
    id: string;
    senderProfileId: string;
    body: string;
    createdAt: number;
  }> = {},
) => ({
  id: "msg-1",
  senderProfileId: "p-couple",
  body: "Hello, are you available?",
  createdAt: Date.now() - 60_000,
  ...overrides,
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VendorEnquiryThread", () => {
  // ── Non-E2E notice ────────────────────────────────────────────────────────

  it("renders the non-E2E encryption notice", async () => {
    mockGetEnquiryMessages.mockResolvedValue([]);
    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));
    await waitFor(() =>
      expect(screen.getByText(/Enquiries aren't end-to-end encrypted/i)).toBeInTheDocument(),
    );
    // Full exact text match
    expect(
      screen.getByText(/cire can read these messages to keep the marketplace safe/i),
    ).toBeInTheDocument();
  });

  // ── Message bubbles ────────────────────────────────────────────────────────

  it("renders messages with correct data-mine attribute", async () => {
    const mine = makeMessage({ id: "msg-mine", senderProfileId: "p-vendor", body: "My reply" });
    const theirs = makeMessage({
      id: "msg-theirs",
      senderProfileId: "p-couple",
      body: "Their message",
    });
    mockGetEnquiryMessages.mockResolvedValue([mine, theirs]);

    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));

    await waitFor(() => expect(screen.getByText("My reply")).toBeInTheDocument());
    expect(screen.getByText("Their message")).toBeInTheDocument();

    // Find bubble wrappers by data-mine attribute
    const myBubble = screen.getByText("My reply").closest("[data-mine]");
    const theirBubble = screen.getByText("Their message").closest("[data-mine]");
    expect(myBubble?.getAttribute("data-mine")).toBe("true");
    expect(theirBubble?.getAttribute("data-mine")).toBe("false");
  });

  // ── Back button ────────────────────────────────────────────────────────────

  it("calls onBack when the back button is clicked", async () => {
    mockGetEnquiryMessages.mockResolvedValue([]);
    const onBack = vi.fn();
    render(() => <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={onBack} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  // ── Reply box ─────────────────────────────────────────────────────────────

  it("calls replyToEnquiry and refetches on send", async () => {
    const msg = makeMessage({ body: "First message" });
    mockGetEnquiryMessages
      .mockResolvedValueOnce([msg])
      .mockResolvedValueOnce([msg, makeMessage({ id: "msg-2", body: "Reply sent" })]);
    mockReplyToEnquiry.mockResolvedValue(makeMessage({ id: "msg-2", body: "Reply sent" }));

    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));

    await waitFor(() => expect(screen.getByText("First message")).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText(/write a reply/i);
    fireEvent.input(textarea, { target: { value: "Hello back!" } });

    const sendBtn = screen.getByRole("button", { name: /^send$/i });
    fireEvent.click(sendBtn);

    await waitFor(() =>
      expect(mockReplyToEnquiry).toHaveBeenCalledWith(mockAuthFetch, "enq_1", "Hello back!"),
    );
    // Refetch triggered — messages updated
    await waitFor(() => expect(mockGetEnquiryMessages).toHaveBeenCalledTimes(2));
  });

  it("disables send button when textarea is empty", async () => {
    mockGetEnquiryMessages.mockResolvedValue([]);
    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument());
    // The Send button should be disabled while textarea is empty
    const sendBtn = screen.getByRole("button", { name: /^send$/i });
    expect(sendBtn).toBeDisabled();
  });

  it("shows toast.error and preserves text on reply failure", async () => {
    mockGetEnquiryMessages.mockResolvedValue([]);
    mockReplyToEnquiry.mockRejectedValue(new Error("network error"));

    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));

    await waitFor(() => expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText(/write a reply/i);
    fireEvent.input(textarea, { target: { value: "My text" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    // Text should still be present in textarea (not cleared on error)
    expect((screen.getByPlaceholderText(/write a reply/i) as HTMLTextAreaElement).value).toBe(
      "My text",
    );
  });

  // ── Quote form ─────────────────────────────────────────────────────────────

  it("submits a quote in minor units", async () => {
    mockGetEnquiryMessages.mockResolvedValue([]);
    mockSubmitQuote.mockResolvedValue({
      id: "enq_1",
      status: "quoted",
      quotedMinor: 1500,
      weddingId: "w1",
      directoryVendorId: "dv1",
      vendorId: "v1",
      zapChatId: null,
      createdBy: "p-couple",
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      vendorName: "Acme",
      category: "florals",
      weddingName: "Alex & Sam",
    });

    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));

    await waitFor(() => expect(screen.getByLabelText(/quote amount/i)).toBeInTheDocument());

    fireEvent.input(screen.getByLabelText(/quote amount/i), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: /send quote/i }));

    await waitFor(() =>
      expect(mockSubmitQuote).toHaveBeenCalledWith(mockAuthFetch, "enq_1", 1500, undefined),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Quote sent");
  });

  it("sends the optional note when provided", async () => {
    mockGetEnquiryMessages.mockResolvedValue([]);
    mockSubmitQuote.mockResolvedValue({
      id: "enq_1",
      status: "quoted",
      quotedMinor: 5000,
      weddingId: "w1",
      directoryVendorId: "dv1",
      vendorId: "v1",
      zapChatId: null,
      createdBy: "p-couple",
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      vendorName: "Acme",
      category: "florals",
      weddingName: "Alex & Sam",
    });

    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));

    await waitFor(() => expect(screen.getByLabelText(/quote amount/i)).toBeInTheDocument());

    fireEvent.input(screen.getByLabelText(/quote amount/i), { target: { value: "50" } });
    const noteInput = screen.getByPlaceholderText(/note/i);
    fireEvent.input(noteInput, { target: { value: "Includes setup" } });
    fireEvent.click(screen.getByRole("button", { name: /send quote/i }));

    await waitFor(() =>
      expect(mockSubmitQuote).toHaveBeenCalledWith(mockAuthFetch, "enq_1", 5000, "Includes setup"),
    );
  });

  it("disables send quote button when amount is 0", async () => {
    mockGetEnquiryMessages.mockResolvedValue([]);
    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));

    await waitFor(() => expect(screen.getByLabelText(/quote amount/i)).toBeInTheDocument());

    fireEvent.input(screen.getByLabelText(/quote amount/i), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: /send quote/i })).toBeDisabled();
  });

  it("disables send quote button when amount is empty", async () => {
    mockGetEnquiryMessages.mockResolvedValue([]);
    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));

    await waitFor(() => expect(screen.getByLabelText(/quote amount/i)).toBeInTheDocument());
    // Default empty — button should be disabled
    expect(screen.getByRole("button", { name: /send quote/i })).toBeDisabled();
  });

  it("calls onQuoted after a successful quote submission", async () => {
    mockGetEnquiryMessages.mockResolvedValue([]);
    mockSubmitQuote.mockResolvedValue({
      id: "enq_1",
      status: "quoted",
      quotedMinor: 1500,
      weddingId: "w1",
      directoryVendorId: "dv1",
      vendorId: "v1",
      zapChatId: null,
      createdBy: "p-couple",
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      vendorName: "Acme",
      category: "florals",
      weddingName: "Alex & Sam",
    });

    const onQuoted = vi.fn();
    render(() => (
      <VendorEnquiryThread
        enquiryId="enq_1"
        ownProfileId="p-vendor"
        onBack={() => {}}
        onQuoted={onQuoted}
      />
    ));

    await waitFor(() => expect(screen.getByLabelText(/quote amount/i)).toBeInTheDocument());
    fireEvent.input(screen.getByLabelText(/quote amount/i), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: /send quote/i }));

    await waitFor(() => expect(onQuoted).toHaveBeenCalledOnce());
  });

  it("shows toast.error on quote submission failure", async () => {
    mockGetEnquiryMessages.mockResolvedValue([]);
    mockSubmitQuote.mockRejectedValue(new Error("quote_already_submitted"));

    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));

    await waitFor(() => expect(screen.getByLabelText(/quote amount/i)).toBeInTheDocument());
    fireEvent.input(screen.getByLabelText(/quote amount/i), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: /send quote/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  });

  // ── Loading / error states ─────────────────────────────────────────────────

  it("shows a loading state while fetching messages", () => {
    mockGetEnquiryMessages.mockReturnValue(new Promise(() => {}));
    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));
    expect(screen.getByText(/loading messages/i)).toBeInTheDocument();
  });

  it("shows an error state when message fetch fails", async () => {
    mockGetEnquiryMessages.mockRejectedValue(new Error("network error"));
    render(() => (
      <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p-vendor" onBack={() => {}} />
    ));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
