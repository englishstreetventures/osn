// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * WeddingList is the portal landing view: it lists the organiser's weddings,
 * opens one on click, and offers a create affordance. CreateWeddingForm is
 * stubbed so this test covers only the list/selector wiring across the 0/1/many
 * cases.
 */

vi.mock("./CreateWeddingForm", () => ({
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

import WeddingList from "./WeddingList";

const ONE = [
  { id: "wed_a", slug: "alice-bob", displayName: "Alice & Bob", role: "owner" as const },
];
const MANY = [
  { id: "wed_a", slug: "alice-bob", displayName: "Alice & Bob", role: "owner" as const },
  { id: "wed_c", slug: "cara-dan", displayName: "Cara & Dan", role: "host" as const },
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
