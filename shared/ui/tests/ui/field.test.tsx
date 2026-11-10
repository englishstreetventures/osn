// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import { Field } from "../../src/ui/field";
import { Input } from "../../src/ui/input";

afterEach(cleanup);

describe("Field's hint", () => {
  it("builds a JSX hint once, however often the field rereads it", async () => {
    // A JSX prop reaches a component as a getter, so every `props.hint` read
    // builds the element again. Field reads the hint to decide whether to draw
    // it, to draw it, and each time it works out `aria-describedby`, which
    // reruns whenever `errors` changes. A hint holding a component — a
    // popover, a running total with its own effects — would then be built
    // several times over, the extras running unseen beside the one on screen.
    let mounts = 0;
    function Total() {
      mounts += 1;
      return <span>12 of 40 seats</span>;
    }
    const [errors, setErrors] = createSignal<readonly string[]>([]);
    render(() => (
      <Field label="Seats" hint={<Total />} errors={errors()}>
        {(field) => <Input {...field} />}
      </Field>
    ));

    setErrors(["Too many"]);
    await Promise.resolve();
    setErrors([]);
    await Promise.resolve();

    expect(mounts).toBe(1);
    expect(screen.getAllByText("12 of 40 seats")).toHaveLength(1);
    const hintId = screen.getByRole("textbox").getAttribute("aria-describedby");
    expect(document.getElementById(hintId!)?.textContent).toBe("12 of 40 seats");
  });

  it("follows a hint that changes, disappears and comes back", async () => {
    // Held once is not read once: a time-zone note that follows the chosen
    // date, a quote total that follows the amount, a note shown only while a
    // box is empty. A hint frozen at its first value would keep a stale note
    // on screen, and `aria-describedby` would point at a hint that is gone.
    const [hint, setHint] = createSignal<string | undefined>("Whole dollars");
    render(() => (
      <Field label="Total budget" hint={hint()}>
        {(field) => <Input {...field} />}
      </Field>
    ));
    const input = screen.getByRole("textbox");
    const describedHint = () => {
      const id = input.getAttribute("aria-describedby");
      return id === null ? null : document.getElementById(id);
    };

    expect(input.getAttribute("aria-describedby")).toMatch(/-hint$/);
    expect(describedHint()?.textContent).toBe("Whole dollars");

    setHint("Whole cents");
    await Promise.resolve();
    expect(screen.queryByText("Whole dollars")).toBeNull();
    expect(screen.getAllByText("Whole cents")).toHaveLength(1);
    expect(describedHint()?.textContent).toBe("Whole cents");

    setHint(undefined);
    await Promise.resolve();
    expect(screen.queryByText("Whole cents")).toBeNull();
    expect(input.parentElement!.querySelector("p")).toBeNull();
    expect(input.hasAttribute("aria-describedby")).toBe(false);

    setHint("Whole dollars");
    await Promise.resolve();
    expect(screen.getAllByText("Whole dollars")).toHaveLength(1);
    expect(input.getAttribute("aria-describedby")).toMatch(/-hint$/);
    expect(describedHint()?.textContent).toBe("Whole dollars");
  });
});
