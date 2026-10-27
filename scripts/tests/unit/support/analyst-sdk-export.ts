// Shared by the analyst SDK unit tests (issue 1404): export ONLY the package's
// tracked files (git ls-files, contents from the working tree, no node_modules)
// into a fresh temporary folder, and run a process there.
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "../../../..");
const PKG = "packages/analyst-sdk";

export function exportPackage(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const ls = Bun.spawnSync(["git", "ls-files", "-z", PKG], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (ls.exitCode !== 0) throw new Error(`git ls-files failed: ${ls.stderr.toString()}`);
  const files = ls.stdout.toString().split("\0").filter(Boolean);
  if (files.length < 20) throw new Error(`only ${files.length} tracked files under ${PKG}`);
  for (const f of files) {
    const to = join(dir, f.slice(PKG.length + 1));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(root, f), to);
  }
  return dir;
}

export async function sh(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}
