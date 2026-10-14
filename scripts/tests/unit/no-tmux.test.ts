// scripts/tests/unit/no-tmux.test.ts — no shipped code runs or requires tmux
// (owner, 2026-10-14). The release runner drives every host over ssh with
// `env -i` (D61), and the stack runs under docker compose; a tmux session is
// neither a tool a step needs nor a process a step manages. Comments and the
// guards that refuse a `tmuxSession` key may still name it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const repoRoot = join(import.meta.dir, "..", "..", "..");
/**
 * A tmux command or tool check: the word tmux on a code line. Prose that names
 * "a tmux session" (the guards' refusal reasons) and the refused `tmuxSession`
 * key are not invocations.
 */
const INVOKES_TMUX = /\btmux\b(?! session)/;

test("no script or backend source invokes or requires tmux", () => {
  const hits: string[] = [];
  for (const pattern of ["scripts/**/*.ts", "backend/**/*.ts", "scripts/**/*.sh"]) {
    for (const rel of new Glob(pattern).scanSync({ cwd: repoRoot })) {
      if (rel.includes("node_modules") || rel.includes("/tests/") || rel.startsWith("backend/scripts/upgrades/")) continue;
      readFileSync(join(repoRoot, rel), "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|#)/.test(line)) return;
        if (INVOKES_TMUX.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  expect(hits).toEqual([]);
});

test("red control: the old host-identity tool check is caught", () => {
  expect(INVOKES_TMUX.test(`for (const [tool, args] of [["bun", ["--version"]], ["tmux", ["-V"]]] as const) {`)).toBe(true);
  expect(INVOKES_TMUX.test(`sh -c "for t in bun docker tmux git; do"`)).toBe(true);
  expect(INVOKES_TMUX.test(`  tmuxSession: "no release step drives or stops a tmux session",`)).toBe(false);
  expect(INVOKES_TMUX.test(`tmux kill-session -t driver`)).toBe(true);
});
