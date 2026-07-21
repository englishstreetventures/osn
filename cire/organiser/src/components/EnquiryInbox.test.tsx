// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnquiryListItem } from "../lib/enquiries-store";
import EnquiryInbox from "./EnquiryInbox";

const item = (o: Partial<EnquiryListItem> = {}): EnquiryListItem => ({
  id: "enq_1",
  weddingId: "w",
  directoryVendorId: "dv",
  vendorId: "v",
  zapChatId: "c",
  status: "quoted",
  createdBy: "p",
  quotedMinor: 250000,
  lastMessageAt: 1,
  createdAt: 1,
  updatedAt: 1,
  vendorName: "Blue Roses",
  category: "florals",
  ...o,
});
afterEach(cleanup);

describe("EnquiryInbox", () => {
  it("shows an empty state when there are no enquiries", () => {
    render(() => <EnquiryInbox items={[]} currency="AUD" onOpen={() => {}} />);
    expect(screen.getByText(/no enquiries yet/i)).toBeInTheDocument();
  });
  it("renders a row and fires onOpen", () => {
    const onOpen = vi.fn();
    render(() => <EnquiryInbox items={[item()]} currency="AUD" onOpen={onOpen} />);
    expect(screen.getByText("Blue Roses")).toBeInTheDocument();
    expect(screen.getByText("Florals")).toBeInTheDocument();
    expect(screen.getByText(/\$2,500\.00/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Blue Roses"));
    expect(onOpen).toHaveBeenCalledWith("enq_1");
  });
});
