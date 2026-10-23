// The pipeline worker's import graph reaches no database module (issue 1034,
// decision D75).
//
// Only the api holds a database credential. The worker reaches the database
// through /api/pipeline/** (src/worker/pipeline-client.ts), so nothing it
// loads may open a pool: no module under src/db/, and no `postgres` import
// anywhere in the graph. The graph is read the way Bun loads it: every runtime
// import, static or dynamic, from src/worker/index.ts outward. A type-only
// import is erased at runtime and is not an edge.
//
// RED CONTROL: the same walk from a module that does hold the pool (the api's
// pipeline router) finds the database modules, so an empty answer above is a
// finding and not a broken walk.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const BACKEND = join(import.meta.dir, "..");
const transpiler = new Bun.Transpiler({ loader: "ts" });

interface Graph {
  /** Every backend module the entry reaches, relative to backend/. */
  modules: Set<string>;
  /** `importer -> imported` for every edge into src/db/ or onto `postgres`. */
  databaseEdges: string[];
}

/** Every runtime import reachable from `entry` (a path relative to backend/). */
export function runtimeGraph(entry: string): Graph {
  const modules = new Set<string>();
  const databaseEdges: string[] = [];
  const queue = [resolve(BACKEND, entry)];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const id = relative(BACKEND, file);
    if (modules.has(id)) continue;
    modules.add(id);
    const source = readFileSync(file, "utf8");
    for (const imp of transpiler.scanImports(source)) {
      if (imp.path === "postgres" || imp.path.startsWith("postgres/")) {
        databaseEdges.push(`${id} -> postgres`);
        continue;
      }
      if (!imp.path.startsWith(".")) continue;
      let target = resolve(dirname(file), imp.path);
      if (!existsSync(target) && existsSync(`${target}.ts`)) target = `${target}.ts`;
      if (!existsSync(target)) continue; // a JSON import or a contract file outside backend/
      const targetId = relative(BACKEND, target);
      if (targetId.startsWith("src/db/")) databaseEdges.push(`${id} -> ${targetId}`);
      if (target.startsWith(BACKEND) && target.endsWith(".ts")) queue.push(target);
    }
  }
  return { modules, databaseEdges };
}

describe("the pipeline worker holds no database module (D75)", () => {
  test("the import graph from src/worker/index.ts reaches no module under src/db/ and no `postgres` import", () => {
    const graph = runtimeGraph("src/worker/index.ts");
    // Non-vacuous: the walk reaches the runtime, the loop, every handler and the client.
    for (const reached of [
      "src/worker/runtime.ts",
      "src/worker/loop.ts",
      "src/worker/pipeline-client.ts",
      "src/worker/handlers/index.ts",
      "src/worker/handlers/wallet.ts",
      "src/worker/handlers/projects.ts",
      "src/worker/handlers/repair.ts",
      "src/ops/wallet-backfill.ts",
      "src/chain/buyback-indexer.ts",
    ]) {
      expect({ reached, present: graph.modules.has(reached) }).toEqual({ reached, present: true });
    }
    expect(graph.modules.size).toBeGreaterThan(60);
    expect(graph.databaseEdges).toEqual([]);
    expect([...graph.modules].filter((m) => m.startsWith("src/db/") || m.startsWith("src/pipeline/"))).toEqual([]);
  });

  test("backend/src/db/worker-client.ts does not exist", () => {
    expect(existsSync(join(BACKEND, "src", "db", "worker-client.ts"))).toBe(false);
  });

  test("RED CONTROL: the same walk from the api's pipeline router finds the database modules", () => {
    const graph = runtimeGraph("src/api/routes/pipeline.ts");
    expect(graph.databaseEdges.length).toBeGreaterThan(0);
    expect(graph.databaseEdges.some((e) => e.endsWith("-> src/db/client.ts"))).toBe(true);
    expect(graph.databaseEdges.some((e) => e.endsWith("-> postgres"))).toBe(true);
  });
});
