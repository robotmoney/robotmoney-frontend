// Preload of the spawned `bun run fetch` in tests/supplementary.test.ts (issue
// 1751): every request through the src/extract/http.ts seam is answered with the
// recorded Yahoo chart beside this file. A request outside the seam still fails.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configureHttp } from "../../../src/extract/http.ts";

const body = readFileSync(join(import.meta.dir, "yahoo-GSPC.json"), "utf8");
globalThis.fetch = (() => {
  throw new Error("analyst-sdk tests must not use the network (globalThis.fetch is a thrower)");
}) as unknown as typeof fetch;
configureHttp({ fetch: (async () => new Response(body, { headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
