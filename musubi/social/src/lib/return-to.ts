/**
 * Leaves Musubi for the address an app's step-up request returns to, in the
 * same tab. osn-api pins that address to the app's own origin before it
 * answers it; a scheme that is not the web's is still never followed, so a
 * `javascript:` answer can run nothing here.
 *
 * Returns false, and goes nowhere, for anything but an `https:` or `http:`
 * address. Read by `pages/ConfirmRequestPage.tsx`.
 */
export function returnTo(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  window.location.assign(url.href);
  return true;
}
