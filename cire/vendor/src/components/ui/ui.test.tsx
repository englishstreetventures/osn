// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import Button, { buttonClass } from "./Button";
import Card, { cardClass, CardEyebrow } from "./Card";
import Chip from "./Chip";
import EmptyState from "./EmptyState";
import Field, { Checkbox, Fieldset, Input, Select, Textarea } from "./Field";
import Loading from "./Loading";
import Notice from "./Notice";

/**
 * What a call site can rely on.
 *
 * Deliberately not assertions about class strings: those pin the current answer
 * rather than the contract, and turn every move of the design into a test edit.
 * What is asserted is that the variants differ from each other, that props reach
 * the DOM, and that the accessibility wiring is there — the three things a
 * caller cannot check for itself.
 */

afterEach(cleanup);

describe("Button", () => {
  it("defaults to type=button so a toolbar control cannot submit its form", () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    render(() => (
      <form onSubmit={onSubmit}>
        <Button>Preview</Button>
      </form>
    ));
    screen.getByRole("button", { name: "Preview" }).click();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("still lets a caller mean submit", () => {
    render(() => <Button type="submit">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
  });

  it("gives each variant and size a distinct look", () => {
    const variants = (["primary", "outline", "quiet", "danger"] as const).map((v) =>
      buttonClass({ variant: v }),
    );
    expect(new Set(variants).size).toBe(variants.length);

    const sizes = (["sm", "md", "icon"] as const).map((s) => buttonClass({ size: s }));
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it("appends the caller's class rather than replacing the variant's", () => {
    render(() => (
      <Button variant="primary" class="self-start">
        Go
      </Button>
    ));
    const el = screen.getByRole("button", { name: "Go" });
    expect(el).toHaveClass("self-start");
    // Whatever the variant decided is still on it.
    expect(el.className.length).toBeGreaterThan("self-start".length);
  });

  it("passes disabled through", () => {
    render(() => <Button disabled>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("hands the same classes to an anchor that cannot be a button", () => {
    // The two links that leave the origin need the button look without the
    // button element. Same source strings, so they cannot drift.
    expect(buttonClass({ variant: "outline" })).toBe(
      buttonClass({ variant: "outline", size: "md" }),
    );
  });
});

describe("Card", () => {
  it("renders its children", () => {
    render(() => (
      <Card>
        <CardEyebrow>Directory listing</CardEyebrow>
        <p>Acme Florals</p>
      </Card>
    ));
    expect(screen.getByText("Directory listing")).toBeInTheDocument();
    expect(screen.getByText("Acme Florals")).toBeInTheDocument();
  });

  it("tells the two tones apart, and marks an interactive card as interactive", () => {
    expect(cardClass({ tone: "default" })).not.toBe(cardClass({ tone: "accent" }));
    // The hover treatment is a promise that the whole rectangle is clickable, so
    // a card that is not a control must not carry it.
    expect(cardClass()).not.toBe(cardClass({ interactive: true }));
    expect(cardClass({ interactive: true })).toContain(cardClass());
  });
});

describe("Notice", () => {
  it("pairs every reported outcome with a shape and a word, not just a hue", () => {
    // error and warn are the closest pair in the palette and the exact pair
    // red-green colour blindness collapses.
    for (const [tone, word] of [
      ["error", "Error"],
      ["warn", "Warning"],
      ["success", "Success"],
    ] as const) {
      const { unmount } = render(() => <Notice tone={tone}>Saving failed</Notice>);
      expect(screen.getByText(`${word}:`, { exact: false })).toBeInTheDocument();
      unmount();
    }
  });

  it("leaves info unmarked, because nothing has happened", () => {
    render(() => <Notice tone="info">Not end-to-end encrypted.</Notice>);
    expect(screen.queryByText(/^(Error|Warning|Success):/)).not.toBeInTheDocument();
  });

  it("only interrupts when it was told to", () => {
    const { unmount } = render(() => <Notice tone="info">Standing note</Notice>);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();

    render(() => (
      <Notice tone="error" alert>
        That just failed
      </Notice>
    ));
    expect(screen.getByRole("alert")).toHaveTextContent("That just failed");
  });
});

describe("EmptyState", () => {
  it("shows the title, the prose and the one thing to do about it", () => {
    render(() => (
      <EmptyState
        title="No organisations yet"
        description="Vendors publish through an organisation."
        action={<Button>Create one</Button>}
      />
    ));
    expect(screen.getByText("No organisations yet")).toBeInTheDocument();
    expect(screen.getByText("Vendors publish through an organisation.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create one" })).toBeInTheDocument();
  });

  it("drops the description and the action when there are none", () => {
    render(() => <EmptyState title="No enquiries yet" />);
    expect(screen.getByText("No enquiries yet")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("Chip", () => {
  it("always carries a word, so the hue is never the only carrier", () => {
    render(() => <Chip tone="live">live</Chip>);
    expect(screen.getByText("live")).toBeInTheDocument();
  });
});

describe("Loading", () => {
  it("announces itself without interrupting", () => {
    render(() => <Loading label="Loading enquiries…" />);
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("Loading enquiries…");
    // `status`, not `alert`: something starting to load is not urgent.
    expect(el).not.toHaveAttribute("role", "alert");
  });
});

describe("Field", () => {
  it("names the control with the label and nothing else", () => {
    render(() => (
      <Field label="Quote amount" hint="$1,200.00">
        {(field) => <Input {...field} />}
      </Field>
    ));
    const input = screen.getByLabelText("Quote amount");
    // The hint is a description. Inside the label it would have become part of
    // the name, and been re-announced on every keystroke.
    expect(input).toHaveAccessibleName("Quote amount");
    expect(input).toHaveAccessibleDescription("$1,200.00");
  });

  it("marks the control wrong and announces why", () => {
    render(() => (
      <Field label="Price min" errors={["Must be a number"]}>
        {(field) => <Input {...field} />}
      </Field>
    ));
    const input = screen.getByLabelText("Price min");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Must be a number");
    expect(input).toHaveAccessibleDescription(/must be a number/i);
  });

  it("puts the error before the hint, so the break is heard before the rule", () => {
    render(() => (
      <Field label="Website" hint="Include https://" errors={["Not a URL"]}>
        {(field) => <Input {...field} />}
      </Field>
    ));
    expect(screen.getByLabelText("Website")).toHaveAccessibleDescription(
      /not a url.*include https/i,
    );
  });

  it("keeps the very same control node when an error appears", async () => {
    // The control is built once, outside tracking, and held. A call in child
    // position would compile to a render effect and rebuild the node on the
    // first rejected save — taking the caret and the focus with it, at the exact
    // moment the vendor is fixing what they typed. The `aria-*` values are
    // getters, so they still update on a node that stays put.
    const [errors, setErrors] = createSignal<string[]>([]);

    render(() => (
      <Field label="Name" errors={errors()}>
        {(field) => <Input {...field} />}
      </Field>
    ));

    const before = screen.getByLabelText("Name");
    before.focus();
    expect(before).toHaveFocus();
    expect(before).not.toHaveAttribute("aria-invalid");

    setErrors(["Name is required"]);
    await Promise.resolve();

    // Identity, not just presence: a rebuilt input would pass a `getByLabelText`
    // and still have thrown the caret away.
    expect(screen.getByLabelText("Name")).toBe(before);
    expect(before).toHaveFocus();
    expect(before).toHaveAttribute("aria-invalid", "true");
  });

  it("hides a label visually while keeping it for a screen reader", () => {
    render(() => (
      <Field label="Reply" labelHidden>
        {(field) => <Textarea {...field} />}
      </Field>
    ));
    expect(screen.getByLabelText("Reply")).toBeInTheDocument();
  });

  it("wires a select the same way", () => {
    render(() => (
      <Field label="Price band">
        {(field) => (
          <Select {...field}>
            <option value="$">$</option>
          </Select>
        )}
      </Field>
    ));
    expect(screen.getByLabelText("Price band")).toBeInTheDocument();
  });

  it("passes the caller's attributes through to the control", () => {
    render(() => (
      <Field label="Email">
        {(field) => <Input {...field} type="email" maxLength={200} autocomplete="off" />}
      </Field>
    ));
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("maxlength", "200");
  });
});

describe("Fieldset and Checkbox", () => {
  it("groups the options under one legend", () => {
    render(() => (
      <Fieldset legend="Categories">
        <Checkbox checked={false} onChange={() => {}} label="Florals" />
        <Checkbox checked onChange={() => {}} label="Catering" />
      </Fieldset>
    ));
    expect(screen.getByRole("group", { name: /categories/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Florals" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Catering" })).toBeChecked();
  });

  it("reports the new state, not the old one", () => {
    const onChange = vi.fn();
    render(() => <Checkbox checked={false} onChange={onChange} label="Florals" />);
    screen.getByRole("checkbox", { name: "Florals" }).click();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
