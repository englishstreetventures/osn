/**
 * Hands `blob` to the browser as a download named `fileName`.
 *
 * An object URL behind a link with `download`, clicked once. The URL is let go
 * a while later rather than at once: Safari and Firefox read it after the
 * click returns, and a URL revoked before they do saves nothing.
 */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
