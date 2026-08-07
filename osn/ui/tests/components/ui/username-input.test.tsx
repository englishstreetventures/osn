// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, it, expect, afterEach, vi } from "vitest";

import { UsernameInput, type UsernameInputStatus } from "../../../src/components/ui/username-input";

function renderUsername(initial = "", status?: UsernameInputStatus, invalidMessage?: string) {
  const [value, setValue] = createSignal(initial);
  const onInput = vi.fn((v: string) => setValue(v));
  render(() => (
    <UsernameInput
      id="handle"
      value={value()}
      onInput={onInput}
      status={status}
      invalidMessage={invalidMessage}
    />
  ));
  return { value, onInput };
}

describe("UsernameInput", () => {
  afterEach(() => cleanup());

  it("shows a fixed @ ahead of the box", () => {
    renderUsername();
    expect(screen.getByText("@")).toBeTruthy();
  });

  it("typing calls onInput with the raw value — the @ is decoration, not part of it", () => {
    const { onInput } = renderUsername();
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "alice" } });
    expect(onInput).toHaveBeenCalledWith("alice");
  });

  it("shows nothing extra at idle (no status passed)", () => {
    renderUsername("alice");
    expect(screen.queryByText(/Checking/)).toBeNull();
    expect(screen.queryByText(/is available/)).toBeNull();
    expect(screen.queryByText(/is taken/)).toBeNull();
  });

  it("shows the checking state", () => {
    renderUsername("alice", "checking");
    expect(screen.getByText(/Checking/)).toBeTruthy();
  });

  it("shows the handle as available", () => {
    renderUsername("alice", "available");
    expect(screen.getByText("@alice is available")).toBeTruthy();
  });

  it("shows the handle as taken", () => {
    renderUsername("alice", "taken");
    expect(screen.getByText("@alice is taken")).toBeTruthy();
  });

  it("shows the caller's invalid message", () => {
    renderUsername(
      "a".repeat(31),
      "invalid",
      "1-30 chars: lowercase letters, numbers, underscores",
    );
    expect(screen.getByText(/1-30 chars/)).toBeTruthy();
  });

  it("shows a generic error when the availability check itself failed", () => {
    renderUsername("alice", "error");
    expect(screen.getByText(/Couldn.t check availability/)).toBeTruthy();
  });

  it("forwards id so an outer <label for> still associates with the input", () => {
    renderUsername();
    expect(screen.getByRole("textbox").id).toBe("handle");
  });
});
