// Vendor the contract's runtime JS into the no-build frontend (a file copy, not a
// bundler) so static serving needs no symlinks. `--check` makes drift fail CI.
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "contract/src/routes.js");
const destDir = join(root, "frontend/public/assets/js/app/contract");
const dest = join(destDir, "routes.js");

if (process.argv.includes("--check")) {
  const [source, vendored] = await Promise.all([
    readFile(src, "utf8"),
    readFile(dest, "utf8").catch(() => ""),
  ]);
  if (source !== vendored) {
    console.error("vendored frontend contract is stale; run `bun run sync-contract`");
    process.exit(1);
  }
  console.log("vendored frontend contract is current");
  process.exit(0);
}

await mkdir(destDir, { recursive: true });
await cp(src, dest);
console.log(`synced contract runtime -> ${dest}`);
