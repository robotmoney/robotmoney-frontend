// The SDK owns the HTTP primitives (packages/analyst-sdk/src/extract/http.ts).
// This is the one place the backend wires the real on-disk fetch cache and the
// source ledger into them; every backend extractor shim imports this file first.
import { configureHttp } from "../../../../packages/analyst-sdk/src/extract/http.ts";
import { withFetchCache } from "./fetch-cache.ts";
import { recordSourceFetch } from "../source-ledger.ts";

configureHttp({ cache: withFetchCache, recordFetch: recordSourceFetch });

export * from "../../../../packages/analyst-sdk/src/extract/http.ts";
