// The data-only guard (issue 1609, D80): robotmoney/csv-backups holds csv/**, README.md and .gitignore and nothing
// else. It reads the tracked files (`git ls-files`), so untracked or ignored files such as reports/ and node_modules
// never trip it.
import { execFileSync } from "node:child_process";

export const ALLOWED_ROOT_FILES = ["README.md", ".gitignore"];

export const isAllowedPath = (p: string): boolean => p.startsWith("csv/") || ALLOWED_ROOT_FILES.includes(p);

/** The tracked paths of a data repo that are outside csv/, README.md and .gitignore. Throws when `root` is not a git repo. */
export function strayPaths(root: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  } catch (e) {
    const msg = ((e as { stderr?: Buffer | string }).stderr ?? "").toString().trim();
    throw new Error(`${root} is not a git repository (git ls-files failed${msg ? `: ${msg}` : ""})`);
  }
  return out.split("\0").filter((p) => p && !isAllowedPath(p)).sort();
}
