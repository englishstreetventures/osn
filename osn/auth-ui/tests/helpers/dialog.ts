import { screen, waitFor } from "@solidjs/testing-library";

/**
 * What the open dialog named `name` is described by, read through its
 * `aria-describedby`: the one line a screen reader hears after its name.
 * Waits for the dialog, which a view mounts after its own update.
 */
export async function dialogDescription(name: string): Promise<string> {
  const dialog = await waitFor(() => screen.getByRole("dialog", { name }));
  const ids = (dialog.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}
