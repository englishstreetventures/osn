// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnquiryListItem, EnquiryMessage } from "../lib/enquiries-store";
import EnquiryThread from "./EnquiryThread";

// Stub solid-toast so toast.error doesn't throw in tests.
const toastError = vi.fn();
vi.mock("solid-toast", () => ({
  toast: { error: (m: string) => toastError(m) },
}));

const enquiry = (o: Partial<EnquiryListItem> = {}): EnquiryListItem => ({
  id: "enq_1",
  weddingId: "wed_1",
  directoryVendorId: "dv_1",
  vendorId: "v_1",
  zapChatId: null,
  status: "open",
  createdBy: "p_organiser",
  quotedMinor: 500000, // $5000
  lastMessageAt: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  vendorName: "Blue Roses",
  category: "florals",
  ...o,
});

const msg = (over: Partial<EnquiryMessage>): EnquiryMessage => ({
  id: "msg_1",
  senderProfileId: "p_organiser",
  body: "Hello vendor",
  createdAt: Date.now(),
  ...over,
});

const base = {
  enquiry: enquiry(),
  messages: [
    msg({ id: "msg_mine", senderProfileId: "p_organiser", body: "Hello vendor" }),
    msg({ id: "msg_theirs", senderProfileId: "p_vendor", body: "Hi there" }),
  ],
  loading: false,
  error: null,
  ownProfileId: "p_organiser",
  currency: "AUD",
  canEdit: true,
  onBack: vi.fn(),
  onSend: vi.fn().mockResolvedValue(undefined),
  onAddToBudget: vi.fn().mockResolvedValue(undefined),
};

afterEach(() => {
  cleanup();
  toastError.mockReset();
  vi.mocked(base.onSend).mockReset().mockResolvedValue(undefined);
  vi.mocked(base.onAddToBudget).mockReset().mockResolvedValue(undefined);
  vi.mocked(base.onBack).mockReset();
});

describe("EnquiryThread", () => {
  it("renders the non-E2E notice text", () => {
    render(() => <EnquiryThread {...base} />);
    expect(
      screen.getByText(
        /Enquiries aren't end-to-end encrypted\. cire can read these messages to keep the marketplace safe/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders mine vs theirs bubbles with correct data-mine attribute", () => {
    render(() => <EnquiryThread {...base} />);
    const mineBubble = screen.getByText("Hello vendor").closest("[data-mine]");
    const theirsBubble = screen.getByText("Hi there").closest("[data-mine]");
    expect(mineBubble).toHaveAttribute("data-mine", "true");
    expect(theirsBubble).toHaveAttribute("data-mine", "false");
  });

  it("sends a reply and clears the box", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(() => <EnquiryThread {...base} onSend={onSend} />);
    const box = screen.getByPlaceholderText(/write a reply/i) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "hello there" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello there"));
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("shows a quote card with Add to budget when quotedMinor is set", () => {
    render(() => <EnquiryThread {...base} />);
    // $5000 from minor 500000
    expect(screen.getByText(/\$5,000/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add to budget/i })).toBeInTheDocument();
  });

  it("calls onAddToBudget when clicking Add to budget", async () => {
    const onAddToBudget = vi.fn().mockResolvedValue(undefined);
    render(() => <EnquiryThread {...base} onAddToBudget={onAddToBudget} />);
    fireEvent.click(screen.getByRole("button", { name: /add to budget/i }));
    await waitFor(() => expect(onAddToBudget).toHaveBeenCalledTimes(1));
  });

  it("hides the send box when canEdit is false", () => {
    render(() => <EnquiryThread {...base} canEdit={false} />);
    expect(screen.queryByPlaceholderText(/write a reply/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send/i })).not.toBeInTheDocument();
  });

  it("hides Add to budget when canEdit is false", () => {
    render(() => <EnquiryThread {...base} canEdit={false} />);
    expect(screen.queryByRole("button", { name: /add to budget/i })).not.toBeInTheDocument();
  });

  it("does not show quote card when quotedMinor is null", () => {
    render(() => <EnquiryThread {...base} enquiry={enquiry({ quotedMinor: null })} />);
    expect(screen.queryByRole("button", { name: /add to budget/i })).not.toBeInTheDocument();
  });

  it("shows a loading line when loading is true", () => {
    render(() => <EnquiryThread {...base} messages={[]} loading={true} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an error block when error is set", () => {
    render(() => <EnquiryThread {...base} messages={[]} error="Something went wrong" />);
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  it("calls onBack when the back button is clicked", () => {
    const onBack = vi.fn();
    render(() => <EnquiryThread {...base} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("send button is disabled when draft is empty", () => {
    render(() => <EnquiryThread {...base} />);
    const sendBtn = screen.getByRole("button", { name: /send/i });
    expect(sendBtn).toBeDisabled();
  });

  it("keeps text and calls toast.error when onSend rejects", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("network error"));
    render(() => <EnquiryThread {...base} onSend={onSend} />);
    const box = screen.getByPlaceholderText(/write a reply/i) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "test message" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(box.value).toBe("test message");
  });
});
