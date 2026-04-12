import { treaty } from "@elysiajs/eden";

import type { App } from "./index";

export const createClient = (baseUrl: string) => treaty<App>(baseUrl);
