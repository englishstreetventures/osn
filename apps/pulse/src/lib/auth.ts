export const OSN_ISSUER_URL = import.meta.env.VITE_OSN_ISSUER_URL ?? "http://localhost:4000";
export const OSN_CLIENT_ID = import.meta.env.VITE_OSN_CLIENT_ID ?? "pulse";
export const REDIRECT_URI = () =>
  import.meta.env.VITE_REDIRECT_URI ?? `${window.location.origin}/callback`;
