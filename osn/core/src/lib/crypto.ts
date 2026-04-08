export function base64urlEncode(buffer: ArrayBuffer): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export async function verifyPkceChallenge(
  verifier: string,
  storedChallenge: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const computed = base64urlEncode(digest);
  return computed === storedChallenge;
}
