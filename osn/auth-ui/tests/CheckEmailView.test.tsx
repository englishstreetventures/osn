// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CheckEmailView,
  type CheckEmailPurpose,
  type CheckEmailStatus,
} from "../src/CheckEmailView";

/**
 * The waiting view a flow shows after it emails a link. The parent owns the
 * sending and the status; what is covered here is what the view alone decides:
 * when Resend may be pressed, what the live region says and when, where focus
 * goes, and that its timer lives and dies with it.
 *
 * Fake timers throughout, Date included, so the wait can be stepped and the
 * clock can jump without a tick (a tab left in the background).
 */

const EMAIL = "ada@example.com";

/** The one Resend control, whatever it is called this second. */
function resend(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /^(Resend|Sending|Send a new link)/,
  }) as HTMLButtonElement;
}

function region(): HTMLElement {
  return screen.getByRole("status");
}

function heading(): HTMLElement {
  return screen.getByRole("heading", { level: 3 });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets an awaited `onResend` settle and Solid write what follows it. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CheckEmailView — the wait before Resend", () => {
  it("keeps Resend disabled for the default 30 s, showing the seconds left, then enables it", () => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toContain("30s");

    // The label is one element, since the button is a flex row that spaces
    // each child of its own.
    expect(resend().childNodes).toHaveLength(1);
    expect(resend().firstChild?.nodeType).toBe(Node.ELEMENT_NODE);
    const seconds = resend().querySelector(".tabular-nums");
    expect(seconds?.textContent).toBe("30");
    expect(seconds?.parentElement).not.toBe(resend());

    vi.advanceTimersByTime(29_000);
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toContain("1s");

    vi.advanceTimersByTime(1_000);
    expect(resend().disabled).toBe(false);
    expect(resend().textContent).toBe("Resend link");
  });

  it("rounds the time left up, so a late timer never unlocks Resend early", () => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    // The clock runs 5 ms ahead of the timers, so the last tick lands 995 ms
    // short of the deadline.
    vi.setSystemTime(Date.now() + 5);
    vi.advanceTimersByTime(29_000);
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toContain("1s");
  });

  it("honours a custom resendWaitSeconds", () => {
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        resendWaitSeconds={5}
        onResend={() => {}}
      />
    ));

    vi.advanceTimersByTime(4_000);
    expect(resend().disabled).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(resend().disabled).toBe(false);
  });

  it("calls onResend once while a resend is still pending, however often it is clicked", async () => {
    // No wait, so the pending resend is the only thing that can lock the button.
    const pending = deferred();
    const onResend = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        resendWaitSeconds={0}
        onResend={onResend}
      />
    ));

    fireEvent.click(resend());
    fireEvent.click(resend());
    fireEvent.click(resend());
    expect(onResend).toHaveBeenCalledTimes(1);

    pending.resolve();
    await settle();
    fireEvent.click(resend());
    expect(onResend).toHaveBeenCalledTimes(2);
  });

  it("starts the wait again after a resend", async () => {
    const onResend = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={onResend} />
    ));

    vi.advanceTimersByTime(30_000);
    fireEvent.click(resend());
    await settle();
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(resend().disabled).toBe(true);

    vi.advanceTimersByTime(29_000);
    expect(resend().disabled).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(resend().disabled).toBe(false);
  });

  it("updates the seconds in place, building the label once per wait", () => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    const label = resend().firstElementChild;
    const seconds = resend().querySelector(".tabular-nums");
    expect(seconds?.textContent).toBe("30");

    vi.advanceTimersByTime(3_000);
    expect(resend().firstElementChild).toBe(label);
    expect(resend().querySelector(".tabular-nums")).toBe(seconds);
    expect(seconds?.textContent).toBe("27");
  });

  it("keeps the countdown out of the live region", () => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    vi.advanceTimersByTime(3_000);
    expect(resend().textContent).toContain("27s");
    expect(region().textContent).not.toContain("27s");
    expect(region().contains(resend())).toBe(false);
  });

  it("reads the time left from the clock, so a tab back from the background is not behind", () => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    // The browser held every timer while the tab was hidden: two minutes pass
    // with no tick, then one tick lands.
    vi.setSystemTime(Date.now() + 120_000);
    vi.advanceTimersByTime(1_000);
    expect(resend().disabled).toBe(false);
  });

  it("runs one wait at a time when Resend is pressed while a wait is still running", async () => {
    const [status, setStatus] = createSignal<CheckEmailStatus>("expired");
    const onResend = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status={status()} onResend={onResend} />
    ));

    vi.advanceTimersByTime(10_000);
    fireEvent.click(resend());
    await settle();
    setStatus("waiting");

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(29_000);
    expect(resend().disabled).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(resend().disabled).toBe(false);
  });

  it("treats a wait that is not a number of seconds as no wait", () => {
    render(() => (
      <>
        <CheckEmailView
          email={EMAIL}
          purpose="sign-up"
          status="waiting"
          resendWaitSeconds={Number.NaN}
          onResend={() => {}}
        />
        <CheckEmailView
          email={EMAIL}
          purpose="sign-up"
          status="waiting"
          resendWaitSeconds={-5}
          onResend={() => {}}
        />
      </>
    ));

    const buttons = screen.getAllByRole("button", { name: /^Resend/ }) as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe("Resend link");
    }
  });

  it("stops its timer when it unmounts", () => {
    const { unmount } = render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="waiting" onResend={() => {}} />
    ));

    vi.advanceTimersByTime(5_000);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("CheckEmailView — what the live region says", () => {
  it("says a new link is being sent, then that it was sent, every time, and drops the claim when a resend fails", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const onResend = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        resendWaitSeconds={0}
        onResend={onResend}
      />
    ));

    expect(region().textContent).toContain(`We sent a link to ${EMAIL}.`);

    fireEvent.click(resend());
    expect(resend().textContent).toBe("Sending…");
    expect(region().textContent).toContain("Sending a new link…");
    first.resolve();
    await settle();
    expect(region().textContent).toContain(`We sent a new link to ${EMAIL}.`);

    fireEvent.click(resend());
    expect(region().textContent).toContain("Sending a new link…");
    second.resolve();
    await settle();
    expect(region().textContent).toContain(`We sent a new link to ${EMAIL}.`);

    fireEvent.click(resend());
    third.reject(new Error("rate limited"));
    await settle();
    expect(region().textContent).toContain(`We sent a link to ${EMAIL}.`);
    expect(region().textContent).not.toContain("new link");
  });

  it("offers a new link at once when the link has expired, and drops the waiting copy", () => {
    const onResend = vi.fn().mockReturnValue(deferred().promise);
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status="expired" onResend={onResend} />
    ));

    expect(heading().textContent).toBe("Your link has expired");
    expect(region().textContent).toContain(`Ask for a new link to ${EMAIL}.`);
    expect(region().textContent).not.toContain("We sent");
    expect(screen.queryByText(/This page will update/)).toBeNull();

    expect(resend().disabled).toBe(false);
    expect(resend().textContent).toBe("Send a new link");
    fireEvent.click(resend());
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(region().textContent).toContain("Sending a new link…");
    expect(region().textContent).not.toContain("Ask for a new link");
  });

  it("shows the error inside the live region, with a fallback when none is given", () => {
    const [message, setMessage] = createSignal<string | undefined>(
      "Too many requests. Try again later.",
    );
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="error"
        errorMessage={message()}
        onResend={() => {}}
      />
    ));

    expect(region().textContent).toContain("Too many requests. Try again later.");
    expect(region().textContent).toContain(`We sent a link to ${EMAIL}.`);
    setMessage(undefined);
    expect(region().textContent).toContain("Something went wrong. Try again in a moment.");
    setMessage("   ");
    expect(region().textContent).toContain("Something went wrong. Try again in a moment.");
  });

  it("shows no error outside the error status, even when a message is given", () => {
    const [status, setStatus] = createSignal<CheckEmailStatus>("error");
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status={status()}
        errorMessage="Too many requests. Try again later."
        onResend={() => {}}
      />
    ));

    expect(region().textContent).toContain("Too many requests. Try again later.");
    for (const quiet of ["waiting", "expired"] as const) {
      setStatus("error");
      expect(region().textContent).toContain("Too many requests. Try again later.");
      setStatus(quiet);
      expect(region().textContent).not.toContain("Too many requests. Try again later.");
      expect(region().textContent).not.toContain("Something went wrong. Try again in a moment.");
    }
  });

  it("shows no fallback sentence outside the error status when no message is given", () => {
    const [status, setStatus] = createSignal<CheckEmailStatus>("error");
    render(() => (
      <CheckEmailView email={EMAIL} purpose="sign-up" status={status()} onResend={() => {}} />
    ));

    expect(region().textContent).toContain("Something went wrong. Try again in a moment.");
    for (const quiet of ["waiting", "expired"] as const) {
      setStatus("error");
      setStatus(quiet);
      expect(region().textContent).not.toContain("Something went wrong. Try again in a moment.");
    }
  });
});

describe("CheckEmailView — the words for each flow", () => {
  const LINES: [CheckEmailPurpose, string][] = [
    ["sign-up", "Open it on any device to finish signing up."],
    ["recovery", "Open it on any device to get back into your account."],
    ["step-up", "Open it on any device to confirm it's you."],
    ["email-change", "Open it on any device to confirm your new address."],
  ];

  it.each(LINES)("%s says what opening the link does", (purpose, line) => {
    render(() => (
      <CheckEmailView email={EMAIL} purpose={purpose} status="waiting" onResend={() => {}} />
    ));

    screen.getByText(`${line} This page will update when you do.`);
    const others = LINES.filter(([other]) => other !== purpose).map(([, otherLine]) => otherLine);
    for (const otherLine of others) {
      expect(screen.queryByText(new RegExp(otherLine))).toBeNull();
    }
  });

  it("does not promise recovery sent anything, since recovery answers the same for every address", async () => {
    const onResend = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="recovery"
        status="waiting"
        resendWaitSeconds={0}
        onResend={onResend}
      />
    ));

    expect(region().textContent).toContain(`If ${EMAIL} has an account, a link is on its way.`);
    expect(region().textContent).not.toContain("We sent");
    fireEvent.click(resend());
    await settle();
    expect(region().textContent).toContain(`If ${EMAIL} has an account, a new link is on its way.`);
    expect(region().textContent).not.toContain("We sent");
  });

  it.each([
    ["sign-up", "waiting"],
    ["recovery", "waiting"],
    ["sign-up", "expired"],
  ] as const)(
    "keeps the address out of the browser's page translation (%s, %s)",
    (purpose, status) => {
      render(() => (
        <CheckEmailView email={EMAIL} purpose={purpose} status={status} onResend={() => {}} />
      ));

      expect(screen.getByText(EMAIL).getAttribute("translate")).toBe("no");
    },
  );

  it("names no address when it is given none", () => {
    render(() => (
      <>
        <CheckEmailView purpose="step-up" status="waiting" onResend={() => {}} />
        <CheckEmailView purpose="recovery" status="waiting" onResend={() => {}} />
      </>
    ));

    const [stepUp, recovery] = screen.getAllByRole("status");
    expect(stepUp?.textContent).toContain("We sent a link to your email address.");
    expect(recovery?.textContent).toContain(
      "If that address has an account, a link is on its way.",
    );
  });
});

describe("CheckEmailView — controls and focus", () => {
  it("calls onChangeEmail, and draws no button when there is none", () => {
    const onChangeEmail = vi.fn();
    render(() => (
      <>
        <CheckEmailView
          email={EMAIL}
          purpose="sign-up"
          status="waiting"
          onResend={() => {}}
          onChangeEmail={onChangeEmail}
        />
        <CheckEmailView purpose="step-up" status="waiting" onResend={() => {}} />
      </>
    ));

    const buttons = screen.getAllByRole("button", { name: "Use a different email" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onChangeEmail).toHaveBeenCalledTimes(1);
  });

  it("submits no form it sits inside", () => {
    const onSubmit = vi.fn((e: SubmitEvent) => e.preventDefault());
    render(() => (
      <form onSubmit={onSubmit}>
        <CheckEmailView
          email={EMAIL}
          purpose="sign-up"
          status="waiting"
          resendWaitSeconds={0}
          onResend={() => {}}
          onChangeEmail={() => {}}
        />
      </form>
    ));

    fireEvent.click(resend());
    fireEvent.click(screen.getByRole("button", { name: "Use a different email" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("puts focus on its heading when it appears, and again when Resend disables itself", () => {
    render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status="waiting"
        resendWaitSeconds={0}
        onResend={() => new Promise<void>(() => {})}
      />
    ));

    // A heading with no tabindex cannot take focus in a browser, though
    // happy-dom lets it: the attribute is half of the guarantee.
    expect(heading().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading());

    resend().focus();
    expect(document.activeElement).toBe(resend());
    fireEvent.click(resend());
    expect(resend().disabled).toBe(true);
    expect(document.activeElement).toBe(heading());
  });

  it("writes nothing to the console across a whole run", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const [status, setStatus] = createSignal<CheckEmailStatus>("waiting");
    const onResend = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    const { unmount } = render(() => (
      <CheckEmailView
        email={EMAIL}
        purpose="sign-up"
        status={status()}
        onResend={onResend}
        onChangeEmail={() => {}}
      />
    ));

    vi.advanceTimersByTime(30_000);
    fireEvent.click(resend());
    await settle();
    setStatus("error");
    vi.advanceTimersByTime(30_000);
    fireEvent.click(resend());
    await settle();
    setStatus("expired");
    unmount();

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
