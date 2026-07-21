// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnquiryListItem } from "../lib/enquiries-store";

const authFetch = vi.fn();

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  redirectToLogin: vi.fn(),
}));

vi.mock("../lib/enquiries-store", () => ({
  upsertCachedEnquiry: vi.fn(),
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

beforeEach(() => {
  authFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

async function importComponent() {
  const { default: EnquireDialog } = await import("./EnquireDialog");
  return EnquireDialog;
}

const baseProps = {
  weddingId: "wed_1",
  directoryVendorId: "dv_1",
  category: "florals",
  vendorName: "Blue Roses",
  onClose: vi.fn(),
  onSent: vi.fn(),
};

describe("EnquireDialog", () => {
  it("renders nothing when open={false}", async () => {
    const EnquireDialog = await importComponent();
    render(() => <EnquireDialog {...baseProps} open={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/enquire with/i)).not.toBeInTheDocument();
  });

  it("renders the dialog when open={true}", async () => {
    const EnquireDialog = await importComponent();
    render(() => <EnquireDialog {...baseProps} open={true} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/enquire with blue roses/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("Send is disabled when message is empty", async () => {
    const EnquireDialog = await importComponent();
    render(() => <EnquireDialog {...baseProps} open={true} />);
    const sendBtn = screen.getByRole("button", { name: /send/i });
    expect(sendBtn).toBeDisabled();
  });

  it("Send is enabled when message is non-empty", async () => {
    const EnquireDialog = await importComponent();
    render(() => <EnquireDialog {...baseProps} open={true} />);
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "Hello!" } });
    const sendBtn = screen.getByRole("button", { name: /send/i });
    expect(sendBtn).not.toBeDisabled();
  });

  it("typing a message + clicking Send calls authFetch POST, then calls onSent and onClose", async () => {
    const EnquireDialog = await importComponent();
    const onClose = vi.fn();
    const onSent = vi.fn();
    const returnedItem = makeItem();

    authFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          enquiry: {
            id: returnedItem.id,
            weddingId: returnedItem.weddingId,
            directoryVendorId: returnedItem.directoryVendorId,
            vendorId: returnedItem.vendorId,
            zapChatId: returnedItem.zapChatId,
            status: returnedItem.status,
            createdBy: returnedItem.createdBy,
            quotedMinor: returnedItem.quotedMinor,
            lastMessageAt: returnedItem.lastMessageAt,
            createdAt: returnedItem.createdAt,
            updatedAt: returnedItem.updatedAt,
          },
        }),
        { status: 200 },
      ),
    );

    render(() => <EnquireDialog {...baseProps} open={true} onClose={onClose} onSent={onSent} />);

    fireEvent.input(screen.getByRole("textbox"), {
      target: { value: "We'd love to work with you!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());

    // authFetch was called with a POST to the enquiries endpoint
    expect(authFetch).toHaveBeenCalledTimes(1);
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/enquiries$/);
    expect(init?.method).toBe("POST");

    const body = JSON.parse(init?.body as string);
    expect(body.directoryVendorId).toBe("dv_1");
    expect(body.category).toBe("florals");
    expect(body.message).toBe("We'd love to work with you!");

    // onSent called with the merged item (vendorName + category merged in)
    expect(onSent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: returnedItem.id,
        vendorName: "Blue Roses",
        category: "florals",
      }),
    );
  });

  it("on 401 error calls redirectToLogin", async () => {
    const EnquireDialog = await importComponent();
    const { redirectToLogin } = await import("../lib/api");
    const onClose = vi.fn();

    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );

    render(() => <EnquireDialog {...baseProps} open={true} onClose={onClose} />);
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Cancel button calls onClose", async () => {
    const EnquireDialog = await importComponent();
    const onClose = vi.fn();
    render(() => <EnquireDialog {...baseProps} open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
