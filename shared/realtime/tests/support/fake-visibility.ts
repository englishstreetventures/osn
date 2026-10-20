/**
 * The slice of `document` the client reads to pause in a hidden tab, driven by
 * hand: `hide()` and `show()` change the state and fire `visibilitychange`.
 */
export class FakeVisibility extends EventTarget {
  visibilityState: DocumentVisibilityState;

  constructor(initial: DocumentVisibilityState = "visible") {
    super();
    this.visibilityState = initial;
  }

  hide(): void {
    this.visibilityState = "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }

  show(): void {
    this.visibilityState = "visible";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
