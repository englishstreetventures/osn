import { createContext, useContext, type ParentProps } from "solid-js";

import { createOrgClient, type OrgClient } from "../organisations";
import { useAuth } from "./context";

const OrgContext = createContext<OrgClient>();

/** An organisations client on the enclosing `AuthProvider`'s `authFetch`. */
export function OrgProvider(props: ParentProps & { issuerUrl: string }) {
  const { authFetch } = useAuth();
  // Read once: the issuer does not change while the page is open.
  const issuerUrl = props.issuerUrl;
  const client = createOrgClient({ issuerUrl, authFetch });
  return <OrgContext.Provider value={client}>{props.children}</OrgContext.Provider>;
}

export function useOrgs(): OrgClient {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrgs must be used within <OrgProvider>");
  return ctx;
}
