import { fireEvent, screen, within } from "@solidjs/testing-library";
import { expect } from "vitest";

/**
 * The six boxes of the row named `name`. A row of code boxes (`@shared/ui`'s
 * `OtpInput`) is found as a reader meets it: a group named by its label, or
 * "Verification code" when the row has none, holding six text boxes.
 */
export function codeBoxes(name: string | RegExp): HTMLInputElement[] {
  return within(screen.getByRole("group", { name })).getAllByRole("textbox") as HTMLInputElement[];
}

/** The six boxes of the row named `name`, once it has mounted. */
export async function findCodeBoxes(name: string | RegExp): Promise<HTMLInputElement[]> {
  const group = await screen.findByRole("group", { name });
  return within(group).getAllByRole("textbox") as HTMLInputElement[];
}

/**
 * Enters `code` into the row named `name` as an autofill or a paste lands:
 * the whole code into box 1, which `OtpInput` takes as the value.
 */
export async function enterCode(name: string | RegExp, code: string): Promise<HTMLInputElement[]> {
  const boxes = await findCodeBoxes(name);
  fireEvent.input(boxes[0]!, { target: { value: code } });
  return boxes;
}

/**
 * Every box is described by the line `lineId` names, and marked invalid
 * exactly when `invalid` is `"true"`.
 */
export function expectTied(
  boxes: readonly HTMLInputElement[],
  lineId: string,
  invalid: "true" | null,
): void {
  expect(boxes).toHaveLength(6);
  expect(lineId).not.toBe("");
  for (const box of boxes) {
    expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(lineId);
    expect(box.getAttribute("aria-invalid")).toBe(invalid);
  }
}
