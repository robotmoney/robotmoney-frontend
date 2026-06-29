// Vendor the contract's runtime JS into the no-build frontend (a file copy, not a
// bundler) so static serving needs no symlinks. Run: `bun run sync-contract`.
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "contract/src/routes.js");
const destDir = join(root, "frontend/public/assets/js/app/contract");

await mkdir(destDir, { recursive: true });
await cp(src, join(destDir, "routes.js"));
console.log(`synced contract runtime -> ${destDir}/routes.js`);
