import { createContext, useContext, type ParentProps } from "solid-js";

import { createOrgClient, type OrgClient, type OrgClientConfig } from "../organisations";

const OrgContext = createContext<OrgClient>();

export function OrgProvider(props: ParentProps & { config: OrgClientConfig }) {
  const client = createOrgClient(props.config);
  return <OrgContext.Provider value={client}>{props.children}</OrgContext.Provider>;
}

export function useOrgs(): OrgClient {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrgs must be used within <OrgProvider>");
  return ctx;
}
