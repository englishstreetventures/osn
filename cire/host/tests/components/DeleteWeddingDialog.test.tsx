// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import DeleteWeddingDialog from "../../src/components/DeleteWeddingDialog";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

const SLUG = "aisha-and-ben-1a2b3c";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EXPORT_HREF = "#/w/wed_1/settings/export";

function open(onDeleted = vi.fn(), onOpenExport = vi.fn()) {
  render(() => (
    <DeleteWeddingDialog
      weddingId="wed_1"
      slug={SLUG}
      onDeleted={onDeleted}
      exportPage={{ href: EXPORT_HREF, onOpen: onOpenExport }}
    />
  ));
  fireEvent.click(screen.getByRole("button", { name: "Delete wedding…" }));
  return { onDeleted, input: screen.getByLabelText(/to confirm/i) as HTMLInputElement };
}

const confirmButton = () => screen.getByRole("button", { name: "Delete wedding" });

describe("DeleteWeddingDialog", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
  });

  it("keeps Delete disabled until the slug is typed exactly", () => {
    const { input } = open();
    expect(confirmButton()).toBeDisabled();
    for (const near of [SLUG.toUpperCase(), ` ${SLUG}`, SLUG.slice(0, -1)]) {
      fireEvent.input(input, { target: { value: near } });
      expect(confirmButton()).toBeDisabled();
    }
    fireEvent.input(input, { target: { value: SLUG } });
    expect(confirmButton()).toBeEnabled();
  });

  // 18. The dialog does not point the owner at the whole-wedding download
  //     before they delete, or following it leaves them where they were.
  it("18. points at the whole-wedding download, opened in the dashboard on a plain click", () => {
    const onOpenExport = vi.fn();
    open(vi.fn(), onOpenExport);
    const link = screen.getByRole("link", { name: "Download the whole wedding" });
    expect(link.getAttribute("href")).toBe(EXPORT_HREF);

    // `fireEvent` answers false when the click's default was prevented: a
    // modified click is the browser's to follow, a plain one the dashboard's.
    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(onOpenExport).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(false);
    expect(onOpenExport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["gift_in_flight", /gift is still being paid/i],
    ["purchase_in_flight", /upgrade payment is still going through/i],
    ["change_in_progress", /still being applied/i],
  ])("explains a %s refusal and stays open", async (error, copy) => {
    authFetchMock.mockResolvedValueOnce(json({ error }, 409));
    const { input, onDeleted } = open();
    fireEvent.input(input, { target: { value: SLUG } });
    fireEvent.click(confirmButton());

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
