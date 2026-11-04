/// <reference types="@testing-library/jest-dom/vitest" />
import { createAutoSize } from "@cire/ui/lib/auto-size";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";

import EnquiryThread from "../../src/components/EnquiryThread";
import type { EnquiryListItem } from "../../src/lib/enquiries-store";

/**
 * The reply box grows as its words wrap, and every module view sits inside
 * `ModuleShell`'s auto-sized frame, which animates a height change at a fixed
 * width as a change of content. Each wrapped line is one such change. The
 * frame must still hand its height back to the layout once the box stops
 * growing: a frame left holding a pixel height and `overflow: hidden` clips
 * the next line and the focus ring under it.
 *
 * Only a real engine wraps text, fires `ResizeObserver` and runs the CSS
 * transition the frame waits on, so this is a browser test.
 */

const enquiry: EnquiryListItem = {
  id: "enq_1",
  weddingId: "wed_1",
  directoryVendorId: "dv_1",
  vendorId: "v_1",
  zapChatId: null,
  status: "open",
  createdBy: "p_organiser",
  quotedMinor: null,
  lastMessageAt: Date.UTC(2026, 9, 14, 9),
  createdAt: Date.UTC(2026, 9, 14, 9),
  updatedAt: Date.UTC(2026, 9, 14, 9),
  vendorName: "Blue Roses",
  category: "florals",
};

/** `ModuleShell`'s panel: a frame the hook sizes, holding a measured `flow-root`. */
function Framed(props: { onFrame: (el: HTMLElement) => void }) {
  const size = createAutoSize();
  return (
    <div
      ref={(el) => {
        props.onFrame(el);
        size.frame(el);
      }}
      style={{ width: "360px" }}
    >
      <div ref={size.content} class="flow-root">
        <EnquiryThread
          enquiry={enquiry}
          messages={[
            {
              id: "msg_1",
              senderProfileId: "p_vendor",
              body: "We have your date free.",
              createdAt: Date.UTC(2026, 9, 14, 9),
            },
          ]}
          loading={false}
          error={null}
          ownProfileId="p_organiser"
          currency="AUD"
          canEdit
          onBack={() => {}}
          onSend={vi.fn().mockResolvedValue(undefined)}
          onAddToBudget={vi.fn().mockResolvedValue(undefined)}
        />
      </div>
    </div>
  );
}

afterEach(() => cleanup());

describe("EnquiryThread inside the module's auto-sized frame", () => {
  it("hands the frame's height back after three wrapped lines are typed", async () => {
    let frame: HTMLElement | undefined;
    render(() => <Framed onFrame={(el) => (frame = el)} />);
    const box = screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
    const oneLine = box.getBoundingClientRect().height;

    // Every height the frame was given while the words went in: proof it moved.
    const heldHeights: string[] = [];
    const watcher = new MutationObserver(() => {
      if (frame?.style.height) heldHeights.push(frame.style.height);
    });
    watcher.observe(frame!, { attributes: true, attributeFilter: ["style"] });

    await userEvent.type(
      box,
      "Could you send a quote for the ceremony arch, twelve table posies " +
        "and the bridal bouquet, all in white and pale gold please?",
    );

    // Three lines or more: the box grew two lines past its first, so the frame moved.
    const line = parseFloat(getComputedStyle(box).lineHeight);
    expect(box.getBoundingClientRect().height).toBeGreaterThanOrEqual(oneLine + 2 * line);
    await waitFor(() => expect(heldHeights.length).toBeGreaterThan(0));

    // The transition's end, or the 800ms backstop, lets go of the height.
    await waitFor(
      () => {
        expect(frame!.style.height).toBe("");
        expect(frame!.style.overflow).toBe("");
      },
      { timeout: 2000 },
    );
    watcher.disconnect();
    expect(frame!.getBoundingClientRect().height).toBe(
      frame!.firstElementChild!.getBoundingClientRect().height,
    );
  });
});
