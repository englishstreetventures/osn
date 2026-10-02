import { vi } from "vitest";

/**
 * A `ResizeObserver` for jsdom, which has none, so a component that observes
 * its own size can mount in the unit tier.
 *
 * The browser reports every observed element once after it is first laid out.
 * jsdom lays nothing out, so this one reports only when a test calls
 * {@link FakeResizeObserver.resize} with the height it wants the element to
 * have. `instances` holds every observer made since the last install.
 */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];

  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.observed.add(el);
  }

  unobserve(el: Element): void {
    this.observed.delete(el);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }

  /** Report `el` at a border-box height of `height` CSS pixels. */
  resize(el: Element, height: number): void {
    const entry = {
      target: el,
      borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

/**
 * Put {@link FakeResizeObserver} on the global for this test file. Undo with
 * `vi.unstubAllGlobals()` in an `afterEach`.
 */
export function installFakeResizeObserver(): void {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
}
