// Access stage: choose the data source for a run. Default is the hermetic
// seededProvider; only PROVIDER=live opts into the real keyless FetcherProvider
// (pre-fetched/warmed here so the synchronous getSeries contract holds). The
// seeded default and the analytics math are untouched.
import { seededProvider, type Provider } from "./provider.ts";
import { createFetcherProvider } from "./fetcher-provider.ts";
import { config } from "../../config.ts";

export async function selectProvider(asof: string): Promise<Provider> {
  if (config.analyticsProvider !== "live") return seededProvider;
  const fetcher = createFetcherProvider();
  await fetcher.warm(asof);
  return fetcher;
}
