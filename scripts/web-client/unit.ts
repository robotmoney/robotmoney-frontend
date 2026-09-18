// Run the web client's unit tests: the files named in frontend/test/unit.list.
// `bun run --cwd frontend test`.
//
// The list is a maintained subset of scripts/tests/unit/ (see the list's own
// header). A missing path is an error, never a silent skip, and an empty
// selection is red — a gate that collects zero tests proves nothing.
import { join } from "node:path";
import { repoRoot } from "./version.ts";

const listPath = join(repoRoot, "frontend/test/unit.list");

export async function listedUnitTests(): Promise<string[]> {
  const text = await Bun.file(listPath).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

if (import.meta.main) {
  const files = await listedUnitTests();
  const missing: string[] = [];
  for (const f of files) if (!(await Bun.file(join(repoRoot, f)).exists())) missing.push(f);
  if (missing.length > 0) {
    console.error(`frontend/test/unit.list names files that do not exist:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error("frontend/test/unit.list is empty — refusing to report a green gate over zero tests");
    process.exit(1);
  }
  const proc = Bun.spawn(["bun", "test", ...files, ...process.argv.slice(2)], { cwd: repoRoot, stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}
