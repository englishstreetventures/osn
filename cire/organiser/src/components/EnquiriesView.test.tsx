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

vi.mock("@shared/rp-auth/solid", () => ({
  useAuth: () => ({ authFetch, activeProfileId }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const redirectToLogin = vi.fn();

// T-U5: `isAuthExpired` comes from the REAL module, not a stand-in. A
// hand-written copy would only re-implement one arm, so the point of
// consolidating on the shared helper — that `lib/api.test.ts`'s shape
// assertions transitively protect this call site — would be lost.
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  redirectToLogin,
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

/** Mirror of `EnquiryInbox`'s private `shortDate` — what a row actually renders. */
const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const makeMessage = (over: Partial<EnquiryMessage> = {}): EnquiryMessage => ({
  id: "msg_1",
  senderProfileId: "p_vendor",
  body: "Hello, we would love to work with you!",
  createdAt: Date.now(),
  ...over,
});

beforeEach(() => {
  __resetEnquiriesCache();
  redirectToLogin.mockReset();
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

  // The bug this replaced: the old inlined predicate read `_tag` first and
  // returned false for any OTHER tag, so an Effect-wrapped expiry never reached
  // the printout check and the organiser was left on an empty inbox.
  it("redirects to sign-in when the initial load fails with an expiry", async () => {
    const EnquiriesView = await importComponent();
    authFetch.mockRejectedValue(
      Object.assign(new Error("boom"), {
        toString: () => "(FiberFailure) AuthExpiredError: session gone",
      }),
    );

    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalled());
  });

  it("does not redirect on an unrelated load failure", async () => {
    const EnquiriesView = await importComponent();
    authFetch.mockRejectedValue(new Error("network down"));

    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(redirectToLogin).not.toHaveBeenCalled();
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

  it("offers the detail-column placeholder until an enquiry is picked", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", [makeItem()]);
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    await screen.findByText("Blue Roses");
    expect(screen.getByText(/pick an enquiry/i)).toBeInTheDocument();
  });

  // A draft belongs to ONE enquiry. Side by side you can click another row
  // mid-reply without going Back, which keeps the thread's `Show` truthy — an
  // unkeyed one would hand vendor A's half-typed reply to vendor B.
  it("gives a freshly selected enquiry an empty send box", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", [
      makeItem(),
      makeItem({ id: "enq_2", vendorName: "Southbank Strings" }),
    ]);
    authFetch.mockImplementation(
      () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);

    fireEvent.click(await screen.findByRole("button", { name: /Blue Roses/ }));
    const draft = await screen.findByPlaceholderText(/write a reply/i);
    fireEvent.input(draft, { target: { value: "pricing note meant for Blue Roses" } });
    expect((draft as HTMLTextAreaElement).value).toBe("pricing note meant for Blue Roses");

    fireEvent.click(screen.getByRole("button", { name: /Southbank Strings/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Southbank Strings/ })).toHaveAttribute(
        "aria-current",
        "true",
      ),
    );
    expect((screen.getByPlaceholderText(/write a reply/i) as HTMLTextAreaElement).value).toBe("");
  });

  // Same root cause as the draft: the resource yields its previous value while
  // the new enquiry's fetch is in flight, so the messages have to be checked
  // against the open enquiry rather than rendered on trust.
  it("never shows the previous enquiry's messages while the next one loads", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", [
      makeItem(),
      makeItem({ id: "enq_2", vendorName: "Southbank Strings" }),
    ]);
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [makeMessage({ body: "BLUE-ROSES-ONLY" })] }), {
        status: 200,
      }),
    );
    // The second thread's fetch never settles, so the loading window stays open
    // for the assertion — no timers involved.
    authFetch.mockImplementationOnce(() => new Promise(() => {}));
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);

    fireEvent.click(await screen.findByRole("button", { name: /Blue Roses/ }));
    expect(await screen.findByText("BLUE-ROSES-ONLY")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Southbank Strings/ }));
    await screen.findByText(/loading messages/i);
    expect(screen.queryByText("BLUE-ROSES-ONLY")).not.toBeInTheDocument();
  });

  // A selection the refreshed list no longer contains resolves to the
  // placeholder, not to a thread with no subject.
  it("falls back to the placeholder when the open enquiry leaves the list", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", [makeItem()]);
    authFetch.mockImplementation(
      () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /Blue Roses/ }));
    await screen.findByText(/Enquiries aren't end-to-end encrypted/i);

    setCachedEnquiries("wed_1", []);
    await waitFor(() => expect(screen.getByText(/pick an enquiry/i)).toBeInTheDocument());
    expect(screen.queryByText(/Enquiries aren't end-to-end encrypted/i)).not.toBeInTheDocument();
  });

  // The inbox is mounted throughout a reply now, so the post-send refresh has to
  // reach the signal it is actually subscribed to. Deleting the cache entry
  // (what `invalidateEnquiries` does) mints a new signal and leaves the row
  // showing its pre-reply state forever.
  //
  // ENQ-P-I1 changed HOW that refresh happens — an optimistic local upsert
  // instead of refetching the whole inbox — so the observable moved from the
  // row's status to the row's timestamp. Status was never the honest signal
  // here anyway: the server's reply path sets only `lastMessageAt` +
  // `updatedAt`, so the old test's "now quoted" refetch mock described a
  // response the API does not produce.
  it("refreshes the inbox row through the live signal after a reply", async () => {
    const EnquiriesView = await importComponent();
    // Relative to now, so "then" and "today" can never format alike.
    const lastYear = Date.now() - 200 * 86_400_000;
    setCachedEnquiries("wed_1", [makeItem({ lastMessageAt: lastYear })]);
    // 1: thread messages. 2: POST reply. Everything after: thread refetch.
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: makeMessage() }), { status: 200 }),
    );
    authFetch.mockImplementation(
      () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );

    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    expect(await screen.findByText(shortDate(lastYear))).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /Blue Roses/ }));
    const draft = await screen.findByPlaceholderText(/write a reply/i);
    fireEvent.input(draft, { target: { value: "Sounds good, please send a quote." } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    // The still-mounted inbox re-renders, so the update reached the signal it
    // subscribes to rather than an orphaned one.
    expect(await screen.findByText(shortDate(Date.now()))).toBeInTheDocument();
    expect(screen.queryByText(shortDate(lastYear))).not.toBeInTheDocument();
  });

  // ENQ-P-I1: the row is derived locally, so replying must not cost a
  // list-sized read. Pinned because the regression is invisible — a reinstated
  // refetch would leave every assertion above still passing.
  it("does not refetch the whole inbox to send a reply", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", [makeItem()]);
    authFetch.mockImplementation((url: string) =>
      url.includes("/messages") || url.includes("/reply")
        ? new Response(JSON.stringify({ messages: [], message: makeMessage() }), { status: 200 })
        : new Response(JSON.stringify({ enquiries: [makeItem()] }), { status: 200 }),
    );

    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /Blue Roses/ }));
    const draft = await screen.findByPlaceholderText(/write a reply/i);
    fireEvent.input(draft, { target: { value: "Thanks!" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await screen.findByText(shortDate(Date.now()));

    const listReads = authFetch.mock.calls.filter(
      ([url]: [string]) => !String(url).includes("/messages") && !String(url).includes("/reply"),
    );
    expect(listReads).toHaveLength(0);
  });

  // The master-detail contract: opening a thread no longer UNMOUNTS the inbox.
  // On a wide panel the two sit side by side; on a narrow one the inbox is
  // hidden with `@max-3xl/enquiries:hidden`, which happy-dom never applies — so
  // here we can assert the row survived, and that it is marked as the open one.
  it("keeps the inbox mounted, and marked, while a thread is open", async () => {
    const EnquiriesView = await importComponent();
    setCachedEnquiries("wed_1", [makeItem()]);
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );
    render(() => <EnquiriesView weddingId="wed_1" currency="AUD" canEdit={true} />);
    fireEvent.click(await screen.findByText("Blue Roses"));
    await screen.findByText(/Enquiries aren't end-to-end encrypted/i);
    const row = screen.getByRole("button", { name: /Blue Roses/ });
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-current", "true");
  });

  // Renamed from "clicking Back returns to the inbox": the inbox row now
  // survives the thread either way, so its mere presence proves nothing. What
  // Back actually does is clear the selection — observable as the unmarked row
  // and the returned placeholder.
  it("clicking Back clears the selection and unmarks the row", async () => {
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
    // Thread closed, row no longer the open one, detail column back to its
    // placeholder.
    expect(screen.queryByText(/Enquiries aren't end-to-end encrypted/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Blue Roses/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByText(/pick an enquiry/i)).toBeInTheDocument();
  });
});
