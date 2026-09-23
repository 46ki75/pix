import { createHttp, type Http } from "../http.ts";
import type { Provider } from "../types.ts";
import { exa } from "./exa.ts";
import { firecrawl } from "./firecrawl.ts";
import { parallel } from "./parallel.ts";
import { tavily } from "./tavily.ts";
import { tinyfish } from "./tinyfish.ts";

export function createProviders(
  env: NodeJS.ProcessEnv = process.env,
  http: Http = createHttp(),
): Provider[] {
  return [
    exa({ http, key: env.EXA_API_KEY?.trim() }),
    parallel({ http, key: env.PARALLEL_API_KEY?.trim() }),
    firecrawl({ http, key: env.FIRECRAWL_API_KEY?.trim() }),
    tavily({ http, key: env.TAVILY_API_KEY?.trim() }),
    tinyfish({ http, key: env.TINYFISH_API_KEY?.trim() }),
  ];
}
