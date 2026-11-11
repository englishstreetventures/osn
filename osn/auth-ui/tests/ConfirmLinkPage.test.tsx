// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfirmLinkPage,
  type ConfirmLinkPurpose,
  type ConfirmOutcome,
} from "../src/ConfirmLinkPage";

/**
 * The page an emailed link opens. The host reads the link and the numbers to
 * pick from, and makes the confirm call; what is covered here is what the page
 * alone decides: that it never confirms without a tap, sends the number tapped
 * once, draws the numbers as given, refuses a set it cannot offer, what each
 * answer shows and says aloud, where focus goes, and that its one timer dies
 * with it.
 *
 * Fake timers throughout, so the slow-confirm line can be stepped.
 */

const EMAIL = "ada@example.com";

const CANDIDATES = ["4821", "0730", "1956"] as const;

const PICK_LINE = "Pick the number shown on the screen where you started.";
const ERROR_LINE = "We couldn't confirm this email just now.";
const SLOW_LINE = "This is taking longer than usual. Keep this page open.";
const EXPIRED_HEADING = "This link no longer works";
const EXPIRED_BODY =
  "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back and ask for a new link.";

const STEP_UP_EXPIRED_WARNING =
  "If you didn't ask for this link, someone else may be signed in to your account, so sign out your other sessions.";

type OnConfirm = (pick: string | null) => Promise<ConfirmOutcome>;

function candidate(number: string): HTMLButtonElement {
  return screen.getByRole("button", { name: number }) as HTMLButtonElement;
}

function candidates(): HTMLButtonElement[] {
  const group = screen.queryByRole("group");
  return group ? ([...group.querySelectorAll("button")] as HTMLButtonElement[]) : [];
}

/** "I didn't ask for this", or "Cancelling…" while it is busy. */
function decline(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /^(I didn't ask for this|Cancelling…)$/,
  }) as HTMLButtonElement;
}

/** "Try again", or the wait it names while it is busy. */
function tryAgain(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /^(Try again|Confirming…|Cancelling…)$/,
  }) as HTMLButtonElement;
}

/** Busy as `Button` draws it: announced busy and unavailable, still enabled, so it keeps focus. */
function expectBusy(button: HTMLButtonElement) {
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.disabled).toBe(false);
}

/** The error line: an alert of its own. */
function errorAlert(): HTMLElement | null {
  return screen.queryByRole("alert");
}

function heading(): HTMLElement {
  return screen.getByRole("heading", { level: 1 });
}

/**
 * A paragraph on the page that reads `text` in full, a number or an address
 * inside it included. The spoken `<output>` repeats some lines, and is not a
 * paragraph.
 */
function paragraph(text: string): HTMLElement | null {
  return (
    screen.queryAllByText((_, el) => el?.tagName === "P" && el.textContent === text)[0] ?? null
  );
}

/** Elements outside the spoken `<output>` whose own text reads `text`. */
function shown(text: string): HTMLElement[] {
  return screen.queryAllByText(text).filter((el) => !el.closest("output"));
}

function announcer(container: HTMLElement): HTMLOutputElement {
  const output = container.querySelector("output");
  if (!output) throw new Error("no <output> in the page");
  return output;
}

/** Every attribute in the document whose value holds `value`, as `TAG[name]`. */
function attributesHolding(value: string): string[] {
  const hits: string[] = [];
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (attribute.value.includes(value)) hits.push(`${element.tagName}[${attribute.name}]`);
    }
  }
  return hits;
}

/** Each number's button as markup with its digits blanked: what tells one from another. */
function candidateShapes(): string[] {
  return candidates().map((button) => {
    const copy = button.cloneNode(true) as HTMLElement;
    const digits = copy.querySelector("[translate='no']");
    if (digits) digits.textContent = "#";
    return copy.outerHTML;
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets an awaited `onConfirm` settle and Solid write what follows it. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

function page(onConfirm: OnConfirm, extra: { purpose?: ConfirmLinkPurpose } = {}) {
  return render(() => (
    <ConfirmLinkPage
      purpose={extra.purpose ?? "sign-up"}
      email={EMAIL}
      candidates={[...CANDIDATES]}
      onConfirm={onConfirm}
    />
  ));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ConfirmLinkPage — only a tap confirms", () => {
  it("never calls onConfirm on mount, on a prop change, or as time passes", async () => {
    const first = vi.fn<OnConfirm>();
    const second = vi.fn<OnConfirm>();
    const [purpose, setPurpose] = createSignal<ConfirmLinkPurpose>("sign-up");
    const [email, setEmail] = createSignal<string | undefined>(EMAIL);
    const [set, setSet] = createSignal<string[]>([...CANDIDATES]);
    const [onConfirm, setOnConfirm] = createSignal<OnConfirm>(first);
    const [onContinue, setOnContinue] = createSignal<(() => void) | undefined>(undefined);
    render(() => (
      <ConfirmLinkPage
        purpose={purpose()}
        email={email()}
        candidates={set()}
        onConfirm={onConfirm()}
        onContinue={onContinue()}
      />
    ));

    await settle();
    setPurpose("recovery");
    setEmail(undefined);
    setSet(["12", "34", "56", "78"]);
    setOnConfirm(() => second);
    setOnContinue(() => () => {});
    await vi.advanceTimersByTimeAsync(60_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(candidates().map((b) => b.textContent)).toEqual(["12", "34", "56", "78"]);
    expect(candidates().every((b) => !b.disabled)).toBe(true);
  });

  it("sends exactly the number tapped, once, marks it busy and disables every other choice while it runs", () => {
    const pending = deferred<ConfirmOutcome>();
    const onConfirm = vi.fn<OnConfirm>(() => pending.promise);
    page(onConfirm);

    fireEvent.click(candidate("0730"));
    fireEvent.click(candidate("0730"));
    fireEvent.click(candidate("4821"));
    fireEvent.click(candidate("1956"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("0730");
    expect(candidates()).toHaveLength(3);
    expectBusy(candidate("0730"));
    expect(candidate("0730").textContent).toBe("0730");
    for (const other of ["4821", "1956"]) {
      expect(candidate(other).disabled).toBe(true);
      expect(candidate(other).getAttribute("aria-busy")).toBeNull();
    }
    expect(decline().disabled).toBe(true);
    fireEvent.click(decline());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(paragraph("You picked 0730. Confirming…")).not.toBeNull();
  });
});

describe("ConfirmLinkPage — the numbers", () => {
  it("draws the numbers as given: in order, as written, under the instruction", () => {
    const given = ["007", "0", "999999", "41", "5"];
    render(() => (
      <ConfirmLinkPage
        purpose="sign-up"
        email={EMAIL}
        candidates={given}
        onConfirm={() => new Promise(() => {})}
      />
    ));

    expect(candidates().map((b) => b.textContent)).toEqual(given);
    const group = screen.getByRole("group", { name: PICK_LINE });
    expect(group.querySelectorAll("button")).toHaveLength(5);
  });

  it("keeps the numbers, and the number picked, out of the browser's page translation", () => {
    page(() => new Promise(() => {}));

    for (const number of CANDIDATES) {
      expect(screen.getByText(number).getAttribute("translate")).toBe("no");
    }
    fireEvent.click(candidate("1956"));
    const line = paragraph("You picked 1956. Confirming…");
    expect(line?.querySelector("[translate='no']")?.textContent).toBe("1956");
  });

  it("draws every number the same way, so only its digits tell one from another", () => {
    page(() => new Promise(() => {}));

    expect(candidateShapes()).toHaveLength(3);
    expect(new Set(candidateShapes()).size).toBe(1);
    fireEvent.click(candidate("0730"));
    // Only the one tapped differs, by the wait it shows; the others stay alike.
    const [first, tapped, third] = candidateShapes();
    expect(first).toBe(third);
    expect(tapped).not.toBe(first);
    expect(candidate("0730").getAttribute("aria-busy")).toBe("true");
  });

  it("puts no number, and not the number picked, in an attribute, the title or the URL", async () => {
    const href = window.location.href;
    page(vi.fn<OnConfirm>().mockRejectedValueOnce(new Error("down")));

    fireEvent.click(candidate("1956"));
    await settle();

    expect(paragraph("You picked 1956.")).not.toBeNull();
    for (const number of CANDIDATES) {
      expect(attributesHolding(number)).toEqual([]);
      expect(document.title).not.toContain(number);
      expect(window.location.href).not.toContain(number);
    }
    expect(window.location.href).toBe(href);
  });

  it.each([
    ["no numbers", []],
    ["two numbers", ["12", "34"]],
    ["six numbers", ["1", "2", "3", "4", "5", "6"]],
    ["a number twice", ["12", "34", "12"]],
    ["a letter", ["12", "34", "12a"]],
    ["seven digits", ["12", "34", "1234567"]],
    ["an empty string", ["12", "34", ""]],
    ["a non-ASCII digit", ["12", "34", "١٢"]],
  ])("shows the expired page, and asks for nothing, when given %s", async (_, given) => {
    const onConfirm = vi.fn<OnConfirm>();
    const { container } = render(() => (
      <ConfirmLinkPage purpose="sign-up" email={EMAIL} candidates={given} onConfirm={onConfirm} />
    ));
    await settle();

    expect(heading().textContent).toBe(EXPIRED_HEADING);
    expect(paragraph(EXPIRED_BODY)).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("group")).toBeNull();
    expect(announcer(container).textContent).toBe("");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("ConfirmLinkPage — what each answer shows", () => {
  it("shows a refused pick exactly as it shows a set it cannot offer, with nothing to try again", async () => {
    const onConfirm = vi.fn<OnConfirm>(() => Promise.resolve<ConfirmOutcome>("expired"));
    const picked = page(onConfirm);
    fireEvent.click(candidate("4821"));
    await settle();

    expect(heading().textContent).toBe(EXPIRED_HEADING);
    expect(paragraph(EXPIRED_BODY)).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const afterPick = picked.container.querySelector("h1")?.parentElement?.textContent;
    cleanup();

    render(() => (
      <ConfirmLinkPage
        purpose="sign-up"
        email={EMAIL}
        candidates={[]}
        onConfirm={() => new Promise(() => {})}
      />
    ));
    expect(heading().parentElement?.textContent).toBe(afterPick);
  });

  it("never says a pick was wrong, in any state", async () => {
    const WRONG = /wrong|incorrect|match|mistake|invalid|didn't pick|not the number/i;
    const answers: (ConfirmOutcome | "throws")[] = ["throws", "expired", "confirmed"];
    for (const answer of answers) {
      const pending = deferred<ConfirmOutcome>();
      const { container } = page(() => pending.promise);
      expect(container.textContent).not.toMatch(WRONG);
      fireEvent.click(candidate("0730"));
      expect(container.textContent).not.toMatch(WRONG);
      if (answer === "throws") pending.reject(new Error("wrong number"));
      else pending.resolve(answer);
      await settle();
      expect(container.textContent).not.toMatch(WRONG);
      cleanup();
    }
  });

  it("turns a thrown error into a fixed line and a Try again that sends the same number, never showing the error's own text", async () => {
    const retry = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockReturnValueOnce(retry.promise);
    const { container } = page(onConfirm);

    fireEvent.click(candidate("1956"));
    await settle();

    expect(heading().textContent).toBe("Confirm this email");
    expect(shown(ERROR_LINE)).toHaveLength(1);
    // An alert of its own, directly above Try again, and not said twice.
    expect(errorAlert()?.textContent).toContain(ERROR_LINE);
    expect(errorAlert()?.parentElement?.nextElementSibling?.contains(tryAgain())).toBe(true);
    expect(announcer(container).textContent).toBe("");
    expect(container.textContent).not.toContain("Failed to fetch");
    expect(paragraph("You picked 1956.")).not.toBeNull();
    for (const button of candidates()) expect(button.disabled).toBe(true);
    expect(decline().disabled).toBe(false);
    expect(tryAgain().disabled).toBe(false);

    fireEvent.click(candidate("4821"));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    tryAgain().focus();
    fireEvent.click(tryAgain());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenLastCalledWith("1956");
    expect(shown(ERROR_LINE)).toHaveLength(0);
    // Try again started the wait, so Try again is the busy one, and keeps focus.
    expectBusy(tryAgain());
    expect(tryAgain().textContent).toBe("Confirming…");
    expect(document.activeElement).toBe(tryAgain());
    for (const button of candidates()) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-busy")).toBeNull();
    }
    expect(decline().disabled).toBe(true);
    fireEvent.click(tryAgain());
    expect(onConfirm).toHaveBeenCalledTimes(2);

    retry.resolve("confirmed");
    await settle();
    expect(heading().textContent).toBe("Confirmed");
  });

  it("sends the same number on every Try again, and never another", async () => {
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(new Promise(() => {}));
    page(onConfirm);

    fireEvent.click(candidate("0730"));
    await settle();
    fireEvent.click(tryAgain());
    await settle();
    fireEvent.click(tryAgain());
    await settle();

    expect(onConfirm.mock.calls).toEqual([["0730"], ["0730"], ["0730"]]);
  });

  it("treats an onConfirm that throws before returning a promise as an error", async () => {
    const onConfirm = vi.fn<OnConfirm>(() => {
      throw new Error("no client");
    });
    page(onConfirm);

    fireEvent.click(candidate("4821"));
    await settle();

    expect(shown(ERROR_LINE)).toHaveLength(1);
    expect(tryAgain().disabled).toBe(false);
  });

  // A host's async function with a missing `return` resolves `undefined`; one
  // typed through `any` can resolve a truthy value such as a `Response`.
  it.each([undefined, "ok", true])(
    "treats an answer that is neither outcome (%s) as an error",
    async (answer) => {
      page(() => Promise.resolve(answer as unknown as ConfirmOutcome));

      fireEvent.click(candidate("4821"));
      await settle();

      expect(shown(ERROR_LINE)).toHaveLength(1);
      expect(tryAgain().disabled).toBe(false);
    },
  );

  it("sends the person back to where they started, and offers Continue only when the host can continue here", async () => {
    const onContinue = vi.fn();
    render(() => (
      <>
        <section aria-label="elsewhere">
          <ConfirmLinkPage
            purpose="sign-up"
            email={EMAIL}
            candidates={[...CANDIDATES]}
            onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
          />
        </section>
        <section aria-label="here">
          <ConfirmLinkPage
            purpose="sign-up"
            email={EMAIL}
            candidates={["11", "22", "33"]}
            onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
            onContinue={onContinue}
          />
        </section>
      </>
    ));

    fireEvent.click(candidate("4821"));
    fireEvent.click(candidate("22"));
    await settle();

    const [elsewhere, here] = screen.getAllByRole("region");
    expect(elsewhere?.querySelector("h1")?.textContent).toBe("Confirmed");
    expect(elsewhere?.textContent).toContain(
      "Go back to where you started to finish signing up. You can close this page.",
    );
    expect(elsewhere?.querySelectorAll("button")).toHaveLength(0);

    expect(here?.querySelector("h1")?.textContent).toBe("Confirmed");
    expect(here?.textContent).toContain("Continue to finish signing up.");
    expect(here?.textContent).not.toContain("Go back");
    const buttons = here?.querySelectorAll("button") ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("Continue");

    fireEvent.click(buttons[0] as HTMLElement);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group")).toBeNull();
  });
});

describe("ConfirmLinkPage — I didn't ask for this", () => {
  it("sends no number, once, marks it busy and disables every number while it runs", () => {
    const pending = deferred<ConfirmOutcome>();
    const onConfirm = vi.fn<OnConfirm>(() => pending.promise);
    const { container } = page(onConfirm);

    expect(decline().getAttribute("type")).toBe("button");
    fireEvent.click(decline());
    fireEvent.click(decline());
    fireEvent.click(candidate("4821"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(null);
    expectBusy(decline());
    expect(decline().textContent).toBe("Cancelling…");
    for (const button of candidates()) expect(button.disabled).toBe(true);
    expect(shown("Cancelling…")).toHaveLength(1);
    expect(announcer(container).textContent).toBe("Cancelling…");
    expect(container.textContent).not.toContain("You picked");
  });

  it.each([
    ["sign-up", "Nothing was confirmed. You can close this page."],
    [
      "step-up",
      "Nothing was confirmed. Someone else may be signed in to your account, so sign out your other sessions.",
    ],
  ] as const)("shows %s's declined page, with nothing more to press", async (purpose, body) => {
    const { container } = page(() => Promise.resolve<ConfirmOutcome>("declined"), { purpose });

    fireEvent.click(decline());
    await settle();

    expect(heading().textContent).toBe("Cancelled");
    expect(paragraph(body)).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(announcer(container).textContent).toBe(`Cancelled. ${body}`);
    expect(document.activeElement).toBe(heading());
  });

  it.each([
    ["a decline answered confirmed", null, "confirmed"],
    ["a number answered declined", "4821", "declined"],
  ] as const)("treats %s as an error, never as that answer", async (_, attempt, answer) => {
    const onConfirm = vi.fn<OnConfirm>(() => Promise.resolve<ConfirmOutcome>(answer));
    const { container } = page(onConfirm);

    fireEvent.click(attempt === null ? decline() : candidate(attempt));
    await settle();

    expect(heading().textContent).toBe("Confirm this email");
    expect(container.textContent).not.toContain("Cancelled");
    expect(container.textContent).not.toContain("Confirmed");
    expect(tryAgain().disabled).toBe(false);
  });

  it("stays on offer after a thrown pick, and sends no number as a new attempt", async () => {
    const declined = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(declined.promise);
    const { container } = page(onConfirm);

    fireEvent.click(candidate("1956"));
    await settle();
    expect(decline().disabled).toBe(false);

    fireEvent.click(decline());
    fireEvent.click(decline());
    expect(onConfirm.mock.calls).toEqual([["1956"], [null]]);
    expect(decline().textContent).toBe("Cancelling…");
    expect(container.textContent).not.toContain("You picked");
    expect(screen.queryByRole("button", { name: /^(Try again|Confirming…)$/ })).toBeNull();
    for (const button of candidates()) expect(button.disabled).toBe(true);
    expectBusy(decline());

    declined.resolve("declined");
    await settle();
    expect(heading().textContent).toBe("Cancelled");
  });

  it("turns a thrown decline into its own line, and a Try again that sends no number again", async () => {
    const retry = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(retry.promise);
    const { container } = page(onConfirm);

    fireEvent.click(decline());
    await settle();

    expect(shown("We couldn't cancel this just now.")).toHaveLength(1);
    expect(errorAlert()?.textContent).toContain("We couldn't cancel this just now.");
    expect(announcer(container).textContent).toBe("");
    expect(shown(ERROR_LINE)).toHaveLength(0);
    expect(decline().disabled).toBe(false);

    fireEvent.click(tryAgain());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenLastCalledWith(null);
    expect(tryAgain().textContent).toBe("Cancelling…");

    retry.resolve("declined");
    await settle();
    expect(heading().textContent).toBe("Cancelled");
  });

  it("shows a refused decline exactly as any other refusal", async () => {
    page(() => Promise.resolve<ConfirmOutcome>("expired"));
    fireEvent.click(decline());
    await settle();
    const afterDecline = heading().parentElement?.textContent;
    cleanup();

    page(() => Promise.resolve<ConfirmOutcome>("expired"));
    fireEvent.click(candidate("0730"));
    await settle();
    expect(heading().parentElement?.textContent).toBe(afterDecline);
    expect(heading().textContent).toBe(EXPIRED_HEADING);
  });
});

describe("ConfirmLinkPage — opening on an answer", () => {
  it.each([
    ["confirmed", "Confirmed", "Continue to finish signing up.", ["Continue"]],
    ["expired", EXPIRED_HEADING, EXPIRED_BODY, []],
  ] as const)(
    "opens on %s with no numbers, and calls nothing",
    async (opening, title, body, labels) => {
      const onConfirm = vi.fn<OnConfirm>();
      const onContinue = vi.fn();
      const { container } = render(() => (
        <ConfirmLinkPage
          purpose="sign-up"
          initialOutcome={opening}
          onConfirm={onConfirm}
          onContinue={onContinue}
        />
      ));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(heading().textContent).toBe(title);
      expect(paragraph(body)).not.toBeNull();
      expect(document.activeElement).toBe(heading());
      expect(screen.queryByRole("group")).toBeNull();
      expect(announcer(container).textContent).toBe("");
      expect(onConfirm).not.toHaveBeenCalled();
      const buttons = screen.queryAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual(labels);
      for (const button of buttons) fireEvent.click(button);
      expect(onContinue).toHaveBeenCalledTimes(labels.length);
    },
  );

  it("will not type-check with neither numbers nor an opening answer", () => {
    render(() => (
      // @ts-expect-error -- a page needs `candidates`, or `initialOutcome` in their place.
      <ConfirmLinkPage purpose="sign-up" onConfirm={() => new Promise(() => {})} />
    ));
    expect(heading().textContent).toBe(EXPIRED_HEADING);
  });

  it("ignores an opening answer it does not know, and shows the expired page", () => {
    const onConfirm = vi.fn<OnConfirm>();
    render(() => (
      <ConfirmLinkPage
        purpose="sign-up"
        initialOutcome={"declined" as "expired"}
        onConfirm={onConfirm}
      />
    ));

    expect(heading().textContent).toBe(EXPIRED_HEADING);
    expect(paragraph(EXPIRED_BODY)).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("ConfirmLinkPage — typing the number", () => {
  const TYPE_LINE = "Type the number shown on the screen where you started.";

  function typed(onConfirm: OnConfirm) {
    return render(() => (
      <ConfirmLinkPage purpose="recovery" email={EMAIL} typeNumber onConfirm={onConfirm} />
    ));
  }

  function field(): HTMLInputElement {
    return screen.getByLabelText(TYPE_LINE) as HTMLInputElement;
  }

  /** Confirm, or "Confirming…" while it is busy. */
  function confirmButton(): HTMLButtonElement {
    return screen.getByRole("button", { name: /^Confirm(ing…)?$/ }) as HTMLButtonElement;
  }

  function enter(value: string) {
    fireEvent.input(field(), { target: { value } });
  }

  /** Dispatches a `beforeinput` at the end of the field; true when the page cancelled it. */
  function refused(init: InputEventInit): boolean {
    const input = field();
    input.setSelectionRange(input.value.length, input.value.length);
    const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("keeps Confirm disabled until the entry is one to six digits", () => {
    typed(() => new Promise(() => {}));

    expect(confirmButton().disabled).toBe(true);
    for (const value of ["", "12a", "1234567", " 12", "١٢"]) {
      enter(value);
      expect(confirmButton().disabled).toBe(true);
    }
    for (const value of ["0", "123456"]) {
      enter(value);
      expect(confirmButton().disabled).toBe(false);
    }
  });

  it("refuses an insertion that would put anything but digits, or a seventh digit, in the field", () => {
    typed(() => new Promise(() => {}));

    expect(refused({ inputType: "insertText", data: "a" })).toBe(true);
    expect(refused({ inputType: "insertText", data: "7" })).toBe(false);
    expect(refused({ inputType: "insertFromPaste", data: "12-34" })).toBe(true);
    enter("123456");
    expect(refused({ inputType: "insertText", data: "7" })).toBe(true);
    expect(refused({ inputType: "deleteContentBackward" })).toBe(false);
    expect(field().value).toBe("123456");
    // A value that got a non-digit past the check, through autofill, can
    // still be deleted.
    enter("12a");
    expect(refused({ inputType: "deleteContentBackward" })).toBe(false);
  });

  it("confirms on Enter once, only with a number, and keeps Enter from a form around the page", () => {
    const onConfirm = vi.fn<OnConfirm>(() => new Promise(() => {}));
    typed(onConfirm);

    enter("12a");
    expect(fireEvent.keyDown(field(), { key: "Enter" })).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();

    enter("4821");
    field().focus();
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("4821");
    // The field disables for the wait, so focus goes to the heading, not the page.
    expectBusy(confirmButton());
    expect(document.activeElement).toBe(heading());
  });

  it("sends exactly what was typed, once, and holds everything still but the busy Confirm while it runs", () => {
    const onConfirm = vi.fn<OnConfirm>(() => new Promise(() => {}));
    typed(onConfirm);

    enter("0730");
    confirmButton().focus();
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    fireEvent.click(decline());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("0730");
    expect(field().disabled).toBe(true);
    expect(field().value).toBe("0730");
    expectBusy(confirmButton());
    expect(confirmButton().textContent).toBe("Confirming…");
    expect(decline().disabled).toBe(true);
    expect(paragraph("You typed 0730. Confirming…")).not.toBeNull();
    expect(document.activeElement).toBe(confirmButton());
  });

  it("lets the person decline with nothing typed", () => {
    const onConfirm = vi.fn<OnConfirm>(() => new Promise(() => {}));
    typed(onConfirm);

    expect(field().value).toBe("");
    expect(decline().disabled).toBe(false);
    fireEvent.click(decline());
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it("never says the entry was wrong, in any state", async () => {
    const WRONG = /wrong|incorrect|match|mistake|invalid|not the number/i;
    const answers: (ConfirmOutcome | "throws")[] = ["throws", "expired", "confirmed"];
    for (const answer of answers) {
      const pending = deferred<ConfirmOutcome>();
      const { container } = typed(() => pending.promise);
      enter("12a");
      expect(container.textContent).not.toMatch(WRONG);
      enter("4821");
      fireEvent.click(confirmButton());
      if (answer === "throws") pending.reject(new Error("wrong number"));
      else pending.resolve(answer);
      await settle();
      expect(container.textContent).not.toMatch(WRONG);
      cleanup();
    }
  });

  it("draws no numbers to pick, even if some are passed", () => {
    render(() => (
      <ConfirmLinkPage
        purpose="recovery"
        typeNumber
        {...({ candidates: [...CANDIDATES] } as object)}
        onConfirm={() => new Promise(() => {})}
      />
    ));

    expect(screen.queryByRole("group")).toBeNull();
    for (const number of CANDIDATES) expect(screen.queryByText(number)).toBeNull();
    expect(field()).not.toBeNull();
  });

  it("will not type-check with numbers to pick and a number to type at once", () => {
    render(() => (
      // @ts-expect-error -- a page either offers numbers or asks for one to be typed.
      <ConfirmLinkPage
        purpose="recovery"
        typeNumber
        candidates={[...CANDIDATES]}
        onConfirm={() => new Promise(() => {})}
      />
    ));
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("keeps the entry after a thrown error, and Try again sends it again", async () => {
    const retry = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(retry.promise);
    typed(onConfirm);

    enter("4821");
    fireEvent.click(confirmButton());
    await settle();

    expect(shown(ERROR_LINE)).toHaveLength(1);
    expect(paragraph("You typed 4821.")).not.toBeNull();
    expect(field().disabled).toBe(true);
    expect(field().value).toBe("4821");
    expect(screen.queryByRole("button", { name: /^Confirm(ing…)?$/ })).toBeNull();
    expect(decline().disabled).toBe(false);

    fireEvent.click(tryAgain());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenLastCalledWith("4821");
    // Try again is the busy one; Confirm does not come back beside it.
    expectBusy(tryAgain());
    expect(screen.getAllByRole("button", { name: "Confirming…" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    retry.resolve("expired");
    await settle();
    expect(heading().textContent).toBe(EXPIRED_HEADING);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("lets the person decline after a thrown error, sending no number as a new attempt", async () => {
    const declined = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(declined.promise);
    const { container } = typed(onConfirm);

    enter("4821");
    fireEvent.click(confirmButton());
    await settle();
    expect(decline().disabled).toBe(false);

    fireEvent.click(decline());
    expect(onConfirm.mock.calls).toEqual([["4821"], [null]]);
    expect(decline().textContent).toBe("Cancelling…");
    expect(container.textContent).not.toContain("You typed");
    expectBusy(decline());

    declined.resolve("declined");
    await settle();
    expect(heading().textContent).toBe("Cancelled");
  });

  it("sends once when Enter is followed by a Confirm click", () => {
    const onConfirm = vi.fn<OnConfirm>(() => new Promise(() => {}));
    typed(onConfirm);

    enter("4821");
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("4821");
  });

  it("blocks the decline while a typed confirm runs, and still says it is slow", async () => {
    const onConfirm = vi.fn<OnConfirm>(() => new Promise(() => {}));
    const { container } = typed(onConfirm);

    enter("4821");
    fireEvent.click(confirmButton());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(decline().disabled).toBe(true);
    fireEvent.click(decline());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(paragraph("You typed 4821. Confirming…")).not.toBeNull();
    expect(paragraph(SLOW_LINE)).not.toBeNull();
    expect(announcer(container).textContent).toBe(SLOW_LINE);
  });

  it("never marks the field invalid, whatever is typed or answered", async () => {
    const onConfirm = vi.fn<OnConfirm>().mockRejectedValueOnce(new Error("down"));
    typed(onConfirm);
    const marked = () => document.querySelectorAll("[aria-invalid], [aria-errormessage]");

    expect(marked()).toHaveLength(0);
    enter("12a");
    expect(marked()).toHaveLength(0);
    enter("4821");
    fireEvent.click(confirmButton());
    expect(marked()).toHaveLength(0);
    await settle();
    expect(shown(ERROR_LINE)).toHaveLength(1);
    expect(marked()).toHaveLength(0);
  });

  it("puts the entry in no attribute, the title or the URL", async () => {
    const href = window.location.href;
    typed(vi.fn<OnConfirm>().mockRejectedValueOnce(new Error("down")));

    enter("905172");
    expect(attributesHolding("905172")).toEqual([]);
    fireEvent.click(confirmButton());
    await settle();

    expect(paragraph("You typed 905172.")).not.toBeNull();
    expect(attributesHolding("905172")).toEqual([]);
    expect(document.title).not.toContain("905172");
    expect(window.location.href).toBe(href);
  });

  it.each(["confirmed", "expired"] as const)(
    "opens on %s with no field, no decline and no call",
    async (opening) => {
      const onConfirm = vi.fn<OnConfirm>();
      render(() => (
        <ConfirmLinkPage
          purpose="recovery"
          typeNumber
          initialOutcome={opening}
          onConfirm={onConfirm}
        />
      ));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(heading().textContent).toBe(opening === "confirmed" ? "Confirmed" : EXPIRED_HEADING);
      expect(screen.queryByLabelText(TYPE_LINE)).toBeNull();
      expect(document.querySelector("input")).toBeNull();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );

  it("asks for digits the way a phone and a translator understand", () => {
    typed(() => new Promise(() => {}));

    const input = field();
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.getAttribute("maxlength")).toBe("6");
    expect(input.getAttribute("translate")).toBe("no");

    enter("4821");
    fireEvent.click(confirmButton());
    const line = paragraph("You typed 4821. Confirming…");
    expect(line?.querySelector("[translate='no']")?.textContent).toBe("4821");
  });
});

describe("ConfirmLinkPage — the words for each flow", () => {
  const FLOWS: [ConfirmLinkPurpose, string, string, string][] = [
    [
      "sign-up",
      `Confirming lets the device that asked finish signing up with ${EMAIL}.`,
      "If you didn't, choose “I didn't ask for this” below.",
      "finish signing up",
    ],
    [
      "recovery",
      "Confirming lets the device that asked back into your account. It also signs out every other device.",
      "If you didn't, choose “I didn't ask for this” below.",
      "get back into your account",
    ],
    [
      "step-up",
      "Confirming lets the device that asked go ahead with something sensitive, such as adding a passkey or deleting the account.",
      "If you didn't, someone else may be signed in to your account. Choose “I didn't ask for this” below, then sign out your other sessions.",
      "finish what you were doing",
    ],
    [
      "email-change",
      `Confirming sets ${EMAIL} as the email of the account that asked.`,
      "If you didn't, choose “I didn't ask for this” below.",
      "finish changing your email",
    ],
  ];

  it.each(FLOWS)(
    "%s says what confirming lets the asking device do, and what to do if you did not ask",
    async (purpose, ready, ifNot, finish) => {
      page(() => Promise.resolve<ConfirmOutcome>("confirmed"), { purpose });

      expect(heading().textContent).toBe("Confirm this email");
      expect(paragraph(ready)).not.toBeNull();
      expect(paragraph(`Only confirm if you asked for this. ${ifNot}`)).not.toBeNull();
      const others = FLOWS.filter(([other]) => other !== purpose).map(([, line]) => line);
      expect(others).toHaveLength(3);
      for (const line of others) expect(paragraph(line)).toBeNull();

      fireEvent.click(candidate("4821"));
      await settle();

      expect(
        paragraph(`Go back to where you started to ${finish}. You can close this page.`),
      ).not.toBeNull();
    },
  );

  it.each([
    ["sign-up", undefined],
    ["recovery", undefined],
    ["step-up", STEP_UP_EXPIRED_WARNING],
    ["email-change", undefined],
  ] as const)(
    "%s's expired page keeps the flow's own warning, if it has one",
    async (purpose, warning) => {
      const { container } = page(() => Promise.resolve<ConfirmOutcome>("expired"), { purpose });

      fireEvent.click(candidate("4821"));
      await settle();

      expect(heading().textContent).toBe(EXPIRED_HEADING);
      const lines = [...heading().parentElement!.querySelectorAll("p")].map((p) => p.textContent);
      expect(lines).toEqual(warning ? [EXPIRED_BODY, warning] : [EXPIRED_BODY]);
      expect(announcer(container).textContent).toBe(
        warning
          ? `${EXPIRED_HEADING}. ${EXPIRED_BODY} ${warning}`
          : `${EXPIRED_HEADING}. ${EXPIRED_BODY}`,
      );
    },
  );

  it("keeps step-up's warning on the expired page however it is reached", () => {
    render(() => (
      <>
        <ConfirmLinkPage
          purpose="step-up"
          initialOutcome="expired"
          onConfirm={vi.fn<OnConfirm>()}
        />
        <ConfirmLinkPage purpose="step-up" candidates={["12"]} onConfirm={vi.fn<OnConfirm>()} />
      </>
    ));

    expect(screen.getAllByText(STEP_UP_EXPIRED_WARNING)).toHaveLength(2);
  });

  it("says 'this address' when it is given none", () => {
    render(() => (
      <>
        <ConfirmLinkPage
          purpose="sign-up"
          candidates={[...CANDIDATES]}
          onConfirm={() => new Promise(() => {})}
        />
        <ConfirmLinkPage
          purpose="email-change"
          candidates={[...CANDIDATES]}
          onConfirm={() => new Promise(() => {})}
        />
      </>
    ));

    expect(
      paragraph("Confirming lets the device that asked finish signing up with this address."),
    ).not.toBeNull();
    expect(
      paragraph("Confirming sets this address as the email of the account that asked."),
    ).not.toBeNull();
  });

  it.each(["sign-up", "email-change"] as const)(
    "%s keeps the address out of the browser's page translation",
    (purpose) => {
      page(() => new Promise(() => {}), { purpose });

      expect(screen.getByText(EMAIL).getAttribute("translate")).toBe("no");
    },
  );
});

describe("ConfirmLinkPage — focus and what is said aloud", () => {
  it("puts focus on its heading on mount, keeps it on a tapped number while it is busy, and brings it to the heading on the answer", async () => {
    const pending = deferred<ConfirmOutcome>();
    page(() => pending.promise);

    // A heading with no tabindex cannot take focus in a browser, though
    // happy-dom lets it: the attribute is half of the guarantee.
    expect(heading().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading());

    candidate("0730").focus();
    expect(document.activeElement).toBe(candidate("0730"));
    fireEvent.click(candidate("0730"));
    expectBusy(candidate("0730"));
    expect(document.activeElement).toBe(candidate("0730"));

    // The error disables every number, so focus goes to the heading.
    pending.reject(new Error("down"));
    await settle();
    expect(candidate("0730").disabled).toBe(true);
    expect(document.activeElement).toBe(heading());
  });

  it("moves focus to the heading when the tap leaves it on nothing busy", () => {
    page(() => new Promise(() => {}));
    // A browser that does not focus a button on click, as Safari does not:
    // focus stays where it was, here on a number that is about to disable.
    candidate("4821").focus();
    fireEvent.click(candidate("0730"));
    expect(candidate("4821").disabled).toBe(true);
    expect(document.activeElement).toBe(heading());
  });

  it.each([
    ["confirmed", "Confirmed"],
    ["expired", EXPIRED_HEADING],
    ["error", "Confirm this email"],
  ] as const)(
    "brings focus back to the heading when the answer is %s, wherever it was moved meanwhile",
    async (answer, title) => {
      const pending = deferred<ConfirmOutcome>();
      render(() => (
        <>
          <button type="button">elsewhere</button>
          <ConfirmLinkPage
            purpose="sign-up"
            email={EMAIL}
            candidates={[...CANDIDATES]}
            onConfirm={() => pending.promise}
          />
        </>
      ));

      fireEvent.click(candidate("4821"));
      const elsewhere = screen.getByRole("button", { name: "elsewhere" });
      elsewhere.focus();
      expect(document.activeElement).toBe(elsewhere);

      if (answer === "error") pending.reject(new Error("down"));
      else pending.resolve(answer);
      await settle();

      expect(heading().textContent).toBe(title);
      expect(document.activeElement).toBe(heading());
    },
  );

  it("says each change aloud through one polite region that stays mounted", async () => {
    const first = deferred<ConfirmOutcome>();
    const second = deferred<ConfirmOutcome>();
    const third = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { container } = page(onConfirm);

    const region = announcer(container);
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.textContent).toBe("");

    fireEvent.click(candidate("4821"));
    expect(announcer(container)).toBe(region);
    expect(region.textContent).toBe("Confirming…");

    first.reject(new Error("down"));
    await settle();
    expect(announcer(container)).toBe(region);
    // The error is its own alert, so the region does not say it again.
    expect(region.textContent).toBe("");
    expect(errorAlert()?.textContent).toContain(ERROR_LINE);

    fireEvent.click(tryAgain());
    expect(region.textContent).toBe("Confirming…");
    second.resolve("expired");
    await settle();
    expect(announcer(container)).toBe(region);
    expect(region.isConnected).toBe(true);
    expect(region.textContent).toBe(`${EXPIRED_HEADING}. ${EXPIRED_BODY}`);

    cleanup();
    const again = render(() => (
      <ConfirmLinkPage
        purpose="recovery"
        candidates={[...CANDIDATES]}
        onConfirm={() => third.promise}
      />
    ));
    const regionAgain = announcer(again.container);
    fireEvent.click(candidate("1956"));
    third.resolve("confirmed");
    await settle();
    expect(announcer(again.container)).toBe(regionAgain);
    expect(regionAgain.textContent).toBe(
      "Confirmed. Go back to where you started to get back into your account. You can close this page.",
    );
  });

  it("says a slow confirm is still working after 10 s, and stops saying it once the answer comes", async () => {
    // Both answers are errors, because the error page keeps the lines the slow
    // one sits among: it must leave them by itself, not with the page.
    const slow = deferred<ConfirmOutcome>();
    const quick = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(quick.promise);
    const { container } = page(onConfirm);

    fireEvent.click(candidate("4821"));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(paragraph(SLOW_LINE)).toBeNull();
    expect(announcer(container).textContent).toBe("Confirming…");

    await vi.advanceTimersByTimeAsync(1);
    expect(paragraph(SLOW_LINE)).not.toBeNull();
    expect(announcer(container).textContent).toBe(SLOW_LINE);

    slow.reject(new Error("down"));
    await settle();
    expect(paragraph(SLOW_LINE)).toBeNull();

    // An answer inside the 10 s: the line never comes, then or later.
    fireEvent.click(tryAgain());
    await vi.advanceTimersByTimeAsync(5_000);
    quick.reject(new Error("down"));
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(paragraph(SLOW_LINE)).toBeNull();
  });

  it("stops its timer when it unmounts mid-confirm", () => {
    const { unmount } = page(() => new Promise(() => {}));

    fireEvent.click(candidate("4821"));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ConfirmLinkPage — around the page", () => {
  it("submits no form it sits inside", async () => {
    const onSubmit = vi.fn((e: SubmitEvent) => e.preventDefault());
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("confirmed");
    render(() => (
      <form onSubmit={onSubmit}>
        <ConfirmLinkPage
          purpose="sign-up"
          email={EMAIL}
          candidates={[...CANDIDATES]}
          onConfirm={onConfirm}
          onContinue={() => {}}
        />
      </form>
    ));

    fireEvent.click(candidate("4821"));
    await settle();
    fireEvent.click(tryAgain());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    cleanup();
    render(() => (
      <form onSubmit={onSubmit}>
        <ConfirmLinkPage
          purpose="sign-up"
          candidates={[...CANDIDATES]}
          onConfirm={() => Promise.resolve<ConfirmOutcome>("declined")}
        />
      </form>
    ));
    fireEvent.click(decline());
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("never touches the address bar or the history, in either mode", async () => {
    const href = window.location.href;
    const length = window.history.length;
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("confirmed")
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("declined");
    render(() => (
      <ConfirmLinkPage
        purpose="sign-up"
        candidates={[...CANDIDATES]}
        onConfirm={onConfirm}
        onContinue={() => {}}
      />
    ));
    fireEvent.click(candidate("4821"));
    await settle();
    fireEvent.click(tryAgain());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    cleanup();

    render(() => <ConfirmLinkPage purpose="recovery" typeNumber onConfirm={onConfirm} />);
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "4821" } });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm(ing…)?$/ }));
    await settle();
    fireEvent.click(decline());
    await settle();

    expect(heading().textContent).toBe("Cancelled");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(window.history.length).toBe(length);
  });

  it("writes nothing to the console across a whole run, an unmount mid-confirm included", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const late = deferred<ConfirmOutcome>();
    const onConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(late.promise);
    const { unmount } = render(() => (
      <ConfirmLinkPage
        purpose="recovery"
        email={EMAIL}
        candidates={[...CANDIDATES]}
        onConfirm={onConfirm}
        onContinue={() => {}}
      />
    ));

    fireEvent.click(candidate("4821"));
    await settle();
    fireEvent.click(tryAgain());
    await vi.advanceTimersByTimeAsync(12_000);
    unmount();
    late.resolve("confirmed");
    await settle();

    const typedLate = deferred<ConfirmOutcome>();
    const typedConfirm = vi
      .fn<OnConfirm>()
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(typedLate.promise);
    const typedRun = render(() => (
      <ConfirmLinkPage purpose="step-up" typeNumber onConfirm={typedConfirm} />
    ));
    const entry = screen.getByRole("textbox");
    fireEvent.input(entry, { target: { value: "12a" } });
    fireEvent.input(entry, { target: { value: "4821" } });
    fireEvent.keyDown(entry, { key: "Enter" });
    await settle();
    fireEvent.click(tryAgain());
    await settle();
    fireEvent.click(decline());
    await vi.advanceTimersByTimeAsync(12_000);
    typedRun.unmount();
    typedLate.resolve("declined");
    await settle();

    expect(typedConfirm.mock.calls).toEqual([["4821"], ["4821"], [null]]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
