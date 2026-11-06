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
});
