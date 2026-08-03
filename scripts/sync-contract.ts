// Vendor the contract's runtime JS into the no-build frontend (a file copy, not a
// bundler) so static serving needs no symlinks. `--check` makes drift fail CI.
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "contract/src");
const destDir = join(root, "frontend/public/assets/js/app/contract");

// Every contract runtime module the no-build frontend needs vendored
// verbatim. Each entry must be import-free (no node_modules dependencies) —
// it's served to the browser as-is, the same discipline `routes.js` already
// follows. `swarm-application.js` carries ONBOARDING_PROMPT (§11 R4) so
// the /swarm/apply page and the demo onboarding prompt can never drift
// onto two different copies of the same prompt.
const FILES = ["routes.js", "swarm-application.js"];

if (process.argv.includes("--check")) {
  let stale = false;
  for (const name of FILES) {
    const [source, vendored] = await Promise.all([
      readFile(join(srcDir, name), "utf8"),
      readFile(join(destDir, name), "utf8").catch(() => ""),
    ]);
    if (source !== vendored) {
      console.error(`vendored frontend contract is stale: ${name}; run \`bun run sync-contract\``);
      stale = true;
    }
  }
  if (stale) process.exit(1);
  console.log("vendored frontend contract is current");
  process.exit(0);
}

await mkdir(destDir, { recursive: true });
for (const name of FILES) {
  await cp(join(srcDir, name), join(destDir, name));
}
console.log(`synced contract runtime -> ${destDir} (${FILES.join(", ")})`);
