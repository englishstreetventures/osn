// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import EnquiryInbox from "../../src/components/EnquiryInbox";
import type { EnquiryListItem } from "../../src/lib/enquiries-store";

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

  // `selectedId` only matters where the inbox and the thread are on screen
  // together (the wide master-detail layout) — the row has to say which
  // conversation is being read.
  it("marks the open enquiry with aria-current", () => {
    render(() => (
      <EnquiryInbox
        items={[item(), item({ id: "enq_2", vendorName: "Southbank Strings" })]}
        currency="AUD"
        selectedId="enq_2"
        onOpen={() => {}}
      />
    ));
    expect(screen.getByRole("button", { name: /Southbank Strings/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("button", { name: /Blue Roses/ })).not.toHaveAttribute("aria-current");
  });

  it("marks no row when nothing is open", () => {
    render(() => <EnquiryInbox items={[item()]} currency="AUD" onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: /Blue Roses/ })).not.toHaveAttribute("aria-current");
  });

  // A selection can outlive its row — the list is refetched after every reply,
  // and an enquiry can disappear from it. No row should claim to be the open one.
  it("marks no row when the selection matches nothing in the list", () => {
    render(() => (
      <EnquiryInbox items={[item()]} currency="AUD" selectedId="enq_missing" onOpen={() => {}} />
    ));
    expect(screen.getByRole("button", { name: /Blue Roses/ })).not.toHaveAttribute("aria-current");
  });

  // Cardinality is what assistive tech acts on, and it's the property the sibling
  // module rail already asserts (`ModuleSidebar` uses aria-current="page"; rows
  // here are "true" — a list item, not a navigation target).
  it("marks exactly one row across a longer list", () => {
    render(() => (
      <EnquiryInbox
        items={[
          item(),
          item({ id: "enq_2", vendorName: "Southbank Strings" }),
          item({ id: "enq_3", vendorName: "Ivy & Ash" }),
        ]}
        currency="AUD"
        selectedId="enq_2"
        onOpen={() => {}}
      />
    ));
    const marked = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") !== null);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveAccessibleName(/Southbank Strings/);
  });
});
