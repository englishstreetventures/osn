// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";

/**
 * The enquiry thread is its own chunk, kept off the island's first load and
 * fetched once the enquiries view shows. Its own file, because a module is
 * requested once per file: the first request is what this test watches.
 */

const { threadRequested } = vi.hoisted(() => ({ threadRequested: vi.fn() }));

vi.mock("../../src/components/VendorEnquiryThread", () => {
  threadRequested();
  return { default: () => null };
});

vi.mock("@shared/rp-auth/solid", () => ({
  AuthProvider: (props: any) => props.children,
  useAuth: () => ({
    session: () => ({ profile: { id: "p1" } }),
    activeProfileId: () => "p-vendor",
    authFetch: vi.fn(),
    logout: vi.fn(),
  }),
}));
vi.mock("../../src/lib/vendor-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/vendor-store")>()),
  listMyOrgs: vi.fn().mockResolvedValue([]),
  fetchListing: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/lib/enquiries-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/enquiries-store")>()),
  listEnquiries: vi.fn().mockResolvedValue({ enquiries: [], nextCursor: null }),
}));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  redirectToLogin: vi.fn(),
  signOutToLogin: vi.fn(async () => {}),
}));

import VendorApp from "../../src/components/VendorApp";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

it("fetches the thread's chunk when the enquiries view shows, not before", async () => {
  render(() => <VendorApp />);
  // The listings view has drawn and settled.
  expect(await screen.findByText(/organisation/i)).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(threadRequested).not.toHaveBeenCalled();

  history.replaceState(null, "", "/#/enquiries");
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  // No enquiry is open: only the warm-up can have asked for it.
  await waitFor(() => expect(threadRequested).toHaveBeenCalledOnce());
  expect(document.querySelector("[data-panel='enquiries:inbox']")).not.toBeNull();
});
