// Repo guard (frontend 1103): no manifest or fixture may carry a manifest key
// the one-deployment-scheme contract set removed. Exit 1 on a hit, 0 on a
// clean tree. Usage: bun scripts/checks/check-old-manifest-keys.ts [root]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { OLD_MANIFEST_KEYS } from "../../backend/src/chain/deployment-manifest.ts";

// Where deployment manifests and their fixtures live. The parser and its
// tests name the old keys on purpose and are not scanned.
const SCAN = ["test-fixtures", "deployments", "frontend/public/data", "shared-fixtures"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name !== "node_modules" && name !== ".git") walk(p, out);
    } else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

export function findOldKeys(root: string): string[] {
  const hits: string[] = [];
  for (const sub of SCAN) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const f of walk(dir)) {
      const text = readFileSync(f, "utf8");
      for (const k of OLD_MANIFEST_KEYS) {
        if (text.includes(`"${k}"`)) hits.push(`${relative(root, f)}: old manifest key "${k}"`);
      }
    }
  }
  return hits;
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(import.meta.dir, "../..");
  const hits = findOldKeys(root);
  for (const h of hits) console.error(h);
  process.exit(hits.length ? 1 : 0);
}
