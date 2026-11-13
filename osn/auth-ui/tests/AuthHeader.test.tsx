// @vitest-environment happy-dom
import { Dialog, DialogContent } from "@shared/ui/ui/dialog";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, Show, type JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthHeader } from "../src/AuthHeader";
import { withoutAnimations } from "./helpers/motion";

withoutAnimations();
afterEach(cleanup);

/**
 * An open sheet, as musubi's sign-in and create-account dialogs are, holding a
 * view's root `div`. The `div` matters: a lone dynamic child of `DialogContent`
 * is never removed under happy-dom once the focus trap has put its guards
 * beside it, and every view has a root element of its own.
 */
function OpenDialog(props: { children: JSX.Element }) {
  return (
    <Dialog open>
      <DialogContent presentation="sheet">
        <div>{props.children}</div>
      </DialogContent>
    </Dialog>
  );
}

function cancelButton(name = "Cancel"): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

describe("AuthHeader in a dialog", () => {
  it("names the dialog by its title", () => {
    render(() => (
      <OpenDialog>
        <AuthHeader host="dialog" title="Sign in to Musubi" />
      </OpenDialog>
    ));
    expect(screen.getByRole("dialog", { name: "Sign in to Musubi" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Sign in to Musubi" })).toBeTruthy();
  });

  it("renames the dialog when the title changes", () => {
    const [title, setTitle] = createSignal("Sign in to Musubi");
    render(() => (
      <OpenDialog>
        <AuthHeader host="dialog" title={title()} />
      </OpenDialog>
    ));
    setTitle("Recover your account");
    expect(screen.getByRole("dialog", { name: "Recover your account" })).toBeTruthy();
  });

  it("keeps the dialog named, by one element, when one header replaces another", () => {
    const [first, setFirst] = createSignal(true);
    render(() => (
      <OpenDialog>
        <Show when={first()} fallback={<AuthHeader host="dialog" title="Recover your account" />}>
          <AuthHeader host="dialog" title="Sign in to Musubi" />
        </Show>
      </OpenDialog>
    ));
    const named = (name: string) => {
      const dialog = screen.getByRole("dialog", { name });
      const id = dialog.getAttribute("aria-labelledby");
      expect(id).toBeTruthy();
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    };
    named("Sign in to Musubi");
    setFirst(false);
    named("Recover your account");
    setFirst(true);
    named("Sign in to Musubi");
  });

  it("hands Cancel to the view, once, and leaves closing to it", () => {
    const onCancel = vi.fn();
    render(() => (
      <OpenDialog>
        <AuthHeader host="dialog" title="Sign in to Musubi" onCancel={onCancel} />
      </OpenDialog>
    ));
    fireEvent.click(cancelButton());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Sign in to Musubi" })).toBeTruthy();
  });
});

describe("AuthHeader on a page", () => {
  it("is a level-2 heading with no dialog around it", () => {
    render(() => <AuthHeader host="page" title="Create your Musubi account" />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Create your Musubi account" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows no Cancel when the view has nowhere to go back to", () => {
    render(() => <AuthHeader host="page" title="Sign in to Musubi" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("labels Cancel in the host's words, and Cancel by default", () => {
    render(() => (
      <>
        <AuthHeader
          host="page"
          title="Create your Musubi account"
          cancelLabel="Sign in instead"
          onCancel={() => {}}
        />
        <AuthHeader host="page" title="Sign in to Musubi" onCancel={() => {}} />
      </>
    ));
    expect(cancelButton("Sign in instead")).toBeTruthy();
    expect(cancelButton("Cancel")).toBeTruthy();
  });

  it("refuses Cancel while the view's call runs", () => {
    const onCancel = vi.fn();
    render(() => (
      <AuthHeader host="page" title="Sign in to Musubi" onCancel={onCancel} cancelDisabled />
    ));
    const cancel = cancelButton();
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("never submits a form it sits in", () => {
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    const onCancel = vi.fn();
    render(() => (
      <form onSubmit={onSubmit}>
        <AuthHeader host="page" title="Sign in to Musubi" onCancel={onCancel} />
      </form>
    ));
    fireEvent.click(cancelButton());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
