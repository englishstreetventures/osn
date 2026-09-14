// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `SecurityEventsBannerMount` wires the shared `SecurityEventsBanner` to this
 * app's clients — no other test in `musubi/social` renders it. Without this
 * file a prop dropped or misspelled here compiles clean: nothing type-checks
 * this directory (`musubi/social/tsconfig.json` `include` is `["src"]`), and
 * nothing else renders the component to notice at runtime either.
 */

const captured = vi.hoisted(() => ({
  productName: undefined as string | undefined,
}));

vi.mock("@osn/ui/auth/SecurityEventsBanner", () => ({
  SecurityEventsBanner: (props: { productName: string }) => {
    captured.productName = props.productName;
    return <div data-testid="banner">{props.productName}</div>;
  },
}));
vi.mock("../../src/lib/authClients", () => ({
  securityEventsClient: {},
  stepUpClient: {},
  totpClient: {},
}));
vi.mock("../../src/lib/webauthn-ceremony", () => ({
  runPasskeyCeremony: vi.fn(),
}));

import SecurityEventsBannerMount from "../../src/components/SecurityEventsBannerMount";

afterEach(() => cleanup());

describe("<SecurityEventsBannerMount />", () => {
  it("passes the app's product name to the shared banner", () => {
    render(() => <SecurityEventsBannerMount accessToken="acc" />);
    expect(screen.getByTestId("banner").textContent).toBe("Musubi");
    expect(captured.productName).toBe("Musubi");
  });
});
