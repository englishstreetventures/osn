// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChangePreview, { type ChangePlan } from "../../src/components/ChangePreview";

/**
 * ChangePreview is the SHARED diff+warnings renderer both the spreadsheet import
 * and the guests editor use (§8's "extract ImportPanel's plan-rendering into a
 * shared component"). It shows the create/update/remove counts, the confirm-gated
 * impact warnings, and the Confirm / Cancel actions.
 */

function plan(overrides: Partial<ChangePlan> = {}): ChangePlan {
  return {
    eventCreates: [],
    eventUpdates: [],
    eventRemoves: [],
    familyCreates: [],
    familyRemoves: [],
    guestCreates: [],
    guestUpdates: [],
    guestRemoves: [],
    eventLinkCreates: [],
    eventLinkRemoves: [],
    warnings: [],
    ...overrides,
  };
}

describe("ChangePreview", () => {
  afterEach(() => cleanup());

  it("renders the diff counts for each record type", () => {
    render(() => (
      <ChangePreview
        plan={plan({ guestCreates: [{}, {}], familyRemoves: [{}] })}
        warnings={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    // The guests row shows create=2; households row shows remove=1.
    expect(screen.getByText("guests")).toBeTruthy();
    expect(screen.getByText("households")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("counts household RENAMES in the households update cell", () => {
    // A household rename travels as `familyUpdates` (id-matched, in-place).
    render(() => (
      <ChangePreview
        plan={plan({ familyUpdates: [{}, {}, {}] })}
        warnings={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("surfaces confirm-gated impact warnings", () => {
    render(() => (
      <ChangePreview
        plan={plan()}
        warnings={["Deleting the Sharma household disables its already-shared claim code."]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    expect(screen.getByText(/disables its already-shared claim code/i)).toBeTruthy();
    expect(screen.getByText(/Before you apply/i)).toBeTruthy();
  });

  it("names a whole list being removed, apart from the counts", () => {
    render(() => (
      <ChangePreview
        plan={plan()}
        warnings={[]}
        clears={{ events: 3, households: 12 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    expect(screen.getByText(/removes every household \(12\)/i)).toBeTruthy();
    expect(screen.getByText(/removes every event \(3\)/i)).toBeTruthy();
  });

  it("describes the confirm button with the loss, so it is read where focus lands", () => {
    render(() => (
      <ChangePreview
        plan={plan()}
        warnings={[]}
        clears={{ events: 0, households: 12 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    const confirm = screen.getByRole("button", { name: /Apply changes/i });
    const describedBy = confirm.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(
      /removes every household \(12\)/i,
    );
  });

  it("names only the list that is actually emptied", () => {
    render(() => (
      <ChangePreview
        plan={plan()}
        warnings={[]}
        clears={{ events: 0, households: 2 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    expect(screen.getByText(/removes every household \(2\)/i)).toBeTruthy();
    expect(screen.queryByText(/removes every event/i)).toBeNull();
  });

  it("names only the schedule when only the schedule is emptied", () => {
    render(() => (
      <ChangePreview
        plan={plan()}
        warnings={[]}
        clears={{ events: 3, households: 0 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    expect(screen.getByText(/removes every event \(3\)/i)).toBeTruthy();
    expect(screen.queryByText(/removes every household/i)).toBeNull();
  });

  it("says nothing extra when no list is emptied", () => {
    render(() => (
      <ChangePreview
        plan={plan()}
        warnings={[]}
        clears={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    expect(screen.queryByText(/removes every/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Apply changes/i }).getAttribute("aria-describedby"),
    ).toBeNull();
  });

  it("fires onConfirm / onCancel and honours busy + confirmLabel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(() => (
      <ChangePreview
        plan={plan()}
        warnings={[]}
        busy={false}
        confirmLabel="Save changes"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables the actions while busy", () => {
    render(() => (
      <ChangePreview plan={plan()} warnings={[]} busy onConfirm={vi.fn()} onCancel={vi.fn()} />
    ));
    expect(screen.getByRole("button", { name: /Applying…/i })).toHaveProperty("disabled", true);
  });
});
