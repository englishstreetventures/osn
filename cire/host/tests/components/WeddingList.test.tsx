// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * WeddingList is the portal landing view: it lists the organiser's weddings,
 * opens one on click, and offers a create affordance. CreateWeddingForm is
 * stubbed so this test covers only the list/selector wiring across the 0/1/many
 * cases.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

vi.mock("../../src/components/CreateWeddingForm", () => ({
  default: (props: { onCreated: (w: unknown) => void }) => (
    <button
      data-testid="create-form"
      onClick={() =>
        props.onCreated({ id: "wed_new", slug: "new-x", displayName: "Brand New", role: "owner" })
      }
    >
      stub-create
    </button>
  ),
}));

import type { DeletedWeddingSummary, WeddingSummary } from "../../src/components/CreateWeddingForm";
import WeddingList from "../../src/components/WeddingList";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

const ONE: WeddingSummary[] = [
  {
    id: "wed_a",
    slug: "alice-bob",
    displayName: "Alice & Bob",
    role: "owner",
    entitlements: [],
    guestCap: 100,
  },
];
const MANY: WeddingSummary[] = [
  ...ONE,
  {
    id: "wed_c",
    slug: "cara-dan",
    displayName: "Cara & Dan",
    role: "editor",
    entitlements: [],
    guestCap: 100,
  },
];

describe("WeddingList", () => {
  afterEach(() => cleanup());

  it("shows the empty state and the create form when there are no weddings", () => {
    render(() => <WeddingList weddings={[]} onSelect={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByText(/don't host any weddings yet/i)).toBeTruthy();
    // The create form is always visible (not behind a toggle) when empty.
    expect(screen.getByTestId("create-form")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create a wedding/i })).toBeNull();
  });

  it("lists a single wedding and opens it on click", () => {
    const onSelect = vi.fn();
    render(() => <WeddingList weddings={ONE} onSelect={onSelect} onCreated={vi.fn()} />);
    expect(screen.getByText("Alice & Bob")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Alice & Bob/i }));
    expect(onSelect).toHaveBeenCalledWith(ONE[0]);
  });

  it("lists many weddings, each selectable", () => {
    const onSelect = vi.fn();
    render(() => <WeddingList weddings={MANY} onSelect={onSelect} onCreated={vi.fn()} />);
    expect(screen.getByText("Alice & Bob")).toBeTruthy();
    expect(screen.getByText("Cara & Dan")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Cara & Dan/i }));
    expect(onSelect).toHaveBeenCalledWith(MANY[1]);
  });

  it("reveals the create form behind a toggle when weddings already exist", () => {
    render(() => <WeddingList weddings={ONE} onSelect={vi.fn()} onCreated={vi.fn()} />);
    // Form is hidden until the affordance is clicked.
    expect(screen.queryByTestId("create-form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Create a wedding/i }));
    expect(screen.getByTestId("create-form")).toBeTruthy();
  });

  it("bubbles a created wedding up to onCreated", () => {
    const onCreated = vi.fn();
    render(() => <WeddingList weddings={ONE} onSelect={vi.fn()} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: /Create a wedding/i }));
    fireEvent.click(screen.getByTestId("create-form"));
    expect(onCreated).toHaveBeenCalledWith({
      id: "wed_new",
      slug: "new-x",
      displayName: "Brand New",
      role: "owner",
    });
  });
});

describe("WeddingList — recently deleted", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
  });

  const GONE: DeletedWeddingSummary[] = [
    {
      id: "wed_gone",
      slug: "gone-1a2b3c",
      displayName: "Gone & Back",
      deletedAt: "2026-10-01T12:00:00.000Z",
      restoreUntil: "2026-10-08T12:00:00.000Z",
    },
  ];

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("is not shown when nothing is restorable", () => {
    render(() => <WeddingList weddings={ONE} onSelect={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.queryByText(/Recently deleted/i)).toBeNull();
  });

  it("lists each restorable wedding with its last day", () => {
    render(() => (
      <WeddingList weddings={ONE} deleted={GONE} onSelect={vi.fn()} onCreated={vi.fn()} />
    ));
    expect(screen.getByText(/Recently deleted/i)).toBeTruthy();
    expect(screen.getByText("Gone & Back")).toBeTruthy();
    expect(screen.getByText(/restore it until 8 October 2026/i)).toBeTruthy();
  });

  it("restores a wedding and reports it", async () => {
    authFetchMock.mockResolvedValueOnce(respond({ restored: true, weddingId: "wed_gone" }));
    const onRestored = vi.fn();
    render(() => (
      <WeddingList
        weddings={ONE}
        deleted={GONE}
        onSelect={vi.fn()}
        onCreated={vi.fn()}
        onRestored={onRestored}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith("wed_gone"));
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_gone/restore");
    expect(init.method).toBe("POST");
  });

  it("says when it is too late, and drops the wedding", async () => {
    authFetchMock.mockResolvedValueOnce(respond({ error: "restore_window_passed" }, 409));
    const onRestoreExpired = vi.fn();
    render(() => (
      <WeddingList
        weddings={ONE}
        deleted={GONE}
        onSelect={vi.fn()}
        onCreated={vi.fn()}
        onRestoreExpired={onRestoreExpired}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText(/too late to restore/i)).toBeTruthy();
    expect(onRestoreExpired).toHaveBeenCalledWith("wed_gone");
  });
});
