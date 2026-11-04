/**
 * The sign-in panel in its card, measured in Chromium against cire's two
 * ramps, at the width a 390px phone gives it: the page frame's 20px gutters
 * leave a 350px card, and its 1px edges and 32px padding a 284px button.
 *
 * Each case is one way the page can stop reading as the owner chose it: copy,
 * a button label or a danger notice's words under 4.5:1 on the opaque card,
 * and a press whose "Connecting to musubi…" wraps or resizes the button.
 */

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import { signInCardClass } from "../src/sign-in-card-class";
import SignInPanel, { type SignInAuth } from "../src/sign-in-panel";
import { inkRatio } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

afterEach(cleanup);

function stubAuth(marker: string | null): SignInAuth {
  return {
    startSignIn: () => {},
    resumeSession: () => Promise.resolve(false),
    readAuthError: () => marker,
    clearAuthError: () => {},
  };
}

/** The page's ground, the card at the phone's width, the panel inside it. */
function Page(props: { ramp: Ramp; children: JSX.Element }) {
  return (
    <div
      data-ramp={props.ramp === "light" ? "light" : undefined}
      class="bg-ui-ground text-ui-ink w-87.5"
    >
      <div class={signInCardClass}>{props.children}</div>
    </div>
  );
}

describe("SignInPanel in its card", () => {
  for (const ramp of RAMPS) {
    it(`holds every word at 4.5:1 on the opaque card, ${ramp}`, () => {
      render(() => (
        <Page ramp={ramp}>
          <SignInPanel apiBase="https://api.cire.test" auth={stubAuth("sign_in_declined")} />
        </Page>
      ));
      const words = [
        ...screen.getAllByText(/musubi account|create one on the next screen/i),
        screen.getByRole("button"),
        screen.getByText(/cancelled/i),
      ];
      for (const word of words) expect(inkRatio(word)).toBeGreaterThanOrEqual(4.5);
    });

    it(`keeps the button's box when the press changes its label, ${ramp}`, () => {
      render(() => (
        <Page ramp={ramp}>
          <SignInPanel apiBase="https://api.cire.test" auth={stubAuth(null)} />
        </Page>
      ));
      const button = screen.getByRole("button");
      const before = button.getBoundingClientRect();
      expect(before.width).toBeCloseTo(284, 0);
      fireEvent.click(button);
      expect(button.textContent).toBe("Connecting to musubi…");
      const after = button.getBoundingClientRect();
      expect([after.width, after.height]).toEqual([before.width, before.height]);
    });
  }
});
