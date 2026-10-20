/**
 * Turns a `NoticeTabs` block (`components/NoticeTabs.astro`) into WAI-ARIA tabs
 * with automatic activation.
 *
 * The markup already works without this: the tabs are links to each panel's
 * id, and every panel's text is in the HTML. An inline script in the component
 * has already chosen the panel the address names and listens for hash
 * changes, so the page paints the right panel before this module loads. This
 * adds what a tab list needs on top — the roles and states a screen reader
 * announces, one tab in the tab order, arrow keys, Home and End — and keeps
 * the address in step without adding history entries or scrolling.
 */
export function enhanceNoticeTabs(root: HTMLElement): void {
  const list = root.querySelector<HTMLElement>("[data-notice-tablist]");
  const tabs = [...root.querySelectorAll<HTMLAnchorElement>("[data-notice-tab]")];
  if (!list || tabs.length === 0) return;

  const idOf = (tab: HTMLAnchorElement): string => tab.dataset["noticeTab"] ?? "";
  const panelOf = (id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-notice-panel="${CSS.escape(id)}"]`);

  list.setAttribute("role", "tablist");
  const label = root.dataset["label"];
  if (label) list.setAttribute("aria-label", label);
  for (const tab of tabs) {
    const section = panelOf(idOf(tab));
    const body = section?.querySelector<HTMLElement>("[data-notice-body]");
    tab.setAttribute("role", "tab");
    if (!section || !body) continue;
    // The tab panel is the body, labelled by its tab. The section around it
    // stops being a named region, so the notice is not announced twice.
    section.removeAttribute("aria-labelledby");
    tab.setAttribute("aria-controls", body.id);
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-labelledby", tab.id);
    // In the tab order, as the WAI-ARIA tabs pattern asks of a panel that
    // opens with text rather than a control.
    body.tabIndex = 0;
  }

  function select(id: string, focus: boolean): void {
    root.dataset["selected"] = id;
    for (const tab of tabs) {
      const on = idOf(tab) === id;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
  }

  function choose(id: string): void {
    select(id, true);
    history.replaceState(history.state, "", `#${id}`);
  }

  /** The panel the address names, directly or by naming something inside it. */
  function fromHash(): { id: string; target: HTMLElement } | null {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (!hash) return null;
    const target = document.getElementById(hash);
    const panel = target?.closest<HTMLElement>("[data-notice-panel]");
    if (!target || !panel || !root.contains(panel)) return null;
    return { id: panel.dataset["noticePanel"] ?? "", target };
  }

  const initial = fromHash();
  select(initial?.id ?? root.dataset["selected"] ?? idOf(tabs[0]!), false);
  // The browser cannot scroll to an element inside a panel that was hidden
  // when it looked; the panel itself it reaches on its own.
  if (initial && initial.target.dataset["noticePanel"] === undefined) {
    initial.target.scrollIntoView();
  }

  list.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const tab = (event.target as Element).closest<HTMLAnchorElement>("[data-notice-tab]");
    if (!tab) return;
    event.preventDefault();
    choose(idOf(tab));
  });

  /** The tab a key moves to from `index`; arrows wrap, as the WAI-ARIA tabs pattern has them. */
  function keyTarget(key: string, index: number): number | null {
    switch (key) {
      case "ArrowRight":
        return (index + 1) % tabs.length;
      case "ArrowLeft":
        return (index - 1 + tabs.length) % tabs.length;
      case "Home":
        return 0;
      case "End":
        return tabs.length - 1;
      default:
        return null;
    }
  }

  list.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(document.activeElement as HTMLAnchorElement);
    const next = index === -1 ? null : keyTarget(event.key, index);
    if (next === null) return;
    event.preventDefault();
    choose(idOf(tabs[next]!));
  });

  // A link elsewhere on the page, or a hash typed into the address bar. The
  // browser looked for the target before the panel holding it was shown.
  window.addEventListener("hashchange", () => {
    const found = fromHash();
    if (!found) return;
    select(found.id, false);
    found.target.scrollIntoView();
  });
}
