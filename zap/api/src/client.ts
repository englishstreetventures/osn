import { treaty, type Treaty } from "@elysiajs/eden";
import type { App } from "./index";

export const createClient = (baseUrl: string): Treaty.Create<App> => treaty<App>(baseUrl);
