// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});
vi.mock("../../src/lib/download", () => ({ downloadBlob: () => {} }));
const haptic = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/touch-feedback", () => ({ haptic }));

import WeddingExport from "../../src/components/WeddingExport";
import { __resetWeddingArchives } from "../../src/lib/wedding-archive";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

/**
 * 14. Anyone but an owner who opens the page is offered no download (the API
 *     would refuse it with a 403) and is told only an owner can take one, and
 *     to ask one. An owner's download is what the `cire-seating` E2E flow
 *     presses; it is rendered here only so the refusal is not read off a
 *     button that no longer exists under that name.
 * 19. A refusal is never shown to the owner, or shown without what to do: the
 *     download limit's words say to try again later, as an alert, with no
 *     saved state claimed.
 * 20. While a download runs the button is not marked busy, or the saved state
 *     is claimed before the file is saved.
 */
describe("WeddingExport", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    haptic.mockReset();
    __resetWeddingArchives();
  });

  const owner = () =>
    render(() => <WeddingExport weddingId="wed_1" weddingSlug="a-and-b" canManage />);
  const saved = () => screen.queryByRole("status", { name: "Wedding downloaded" });

  const download = () => screen.queryByRole("button", { name: "Download wedding" });

  it("14. offers a non-owner no download, says only an owner can, and to ask one", () => {
    render(() => <WeddingExport weddingId="wed_1" weddingSlug="a-and-b" canManage />);
    expect(download()).not.toBeNull();
    cleanup();

    render(() => (
      <WeddingExport
        weddingId="wed_1"
        weddingSlug="a-and-b"
        canManage={false}
        coHosts={{ href: "#/w/wed_1/settings/hosts", onOpen: () => {} }}
      />
    ));
    expect(download()).toBeNull();
    expect(screen.getByText(/only an owner can download the whole wedding/i)).not.toBeNull();
    expect(screen.getByText(/ask one of its owners/i)).not.toBeNull();
    expect(screen.getByRole("link", { name: "Co-hosts" }).getAttribute("href")).toBe(
      "#/w/wed_1/settings/hosts",
    );
  });

  it("19. tells the owner of a refusal in its words, as an alert, claiming nothing saved", async () => {
    authFetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    owner();
    fireEvent.click(download()!);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/try again later/i);
    expect(saved()).toBeNull();
    expect(haptic).toHaveBeenCalledWith("reject");
  });

  it("20. marks the button busy while it runs, and claims the file only once saved", async () => {
    let finish: () => void = () => {};
    const end = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...Array.from({ length: 18 }, () => 0)]);
    authFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2_000));
            finish = () => {
              controller.enqueue(end);
              controller.close();
            };
          },
        }),
        { status: 200 },
      ),
    );
    owner();
    expect(download()!.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(download()!);

    await waitFor(() => expect(download()!.getAttribute("aria-disabled")).toBe("true"));
    expect(screen.getByText("Preparing your download…")).not.toBeNull();
    expect(await screen.findByText("2 KB so far")).not.toBeNull();
    expect(saved()).toBeNull();

    finish();
    await waitFor(() => expect(saved()).not.toBeNull());
    expect(saved()!.textContent).toContain("cire-wedding-a-and-b.zip");
    expect(download()!.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText("Preparing your download…")).toBeNull();
    expect(haptic).not.toHaveBeenCalled();
  });
});
