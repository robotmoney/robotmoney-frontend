// scripts/tests/unit/docs-release-cutover-command.test.ts — every
// `bun run release:run` command in the runbook policy is one the runner
// accepts (issue 1528). Section 4.7 once documented the production cutover
// without `--stage-journal`, which the runner refuses under SP.8 (D70).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../release/run.ts";

const doc = readFileSync(join(import.meta.dir, "..", "..", "..", "docs/technical/release-runbooks.md"), "utf8");

/** Every documented command that takes arguments; a bare `bun run release:run` names the tool, not a command. */
function documentedCommands(text: string): string[] {
  return [...text.matchAll(/bun run release:run(?= --)[^`\n]*/g)].map((m) => m[0].trim());
}

/** Why the runner would refuse a documented command line; empty when it accepts it. */
function commandProblems(line: string): string[] {
  const argv = line.replace(/^bun run release:run\s*/, "").replace(/<[^>]*>/g, "PLACEHOLDER").replace(/"/g, "").split(/\s+/).filter(Boolean);
  const parsed = parseArgs(argv);
  if ("error" in parsed) return [`${line}: ${parsed.error}`];
  if (parsed.target === "prod" && parsed.afterPreflight !== undefined && parsed.stageJournal === undefined) {
    return [`${line}: a production cutover needs --stage-journal (SP.8)`];
  }
  return [];
}

test("the policy documents release:run commands, including the production cutover", () => {
  const cmds = documentedCommands(doc);
  expect(cmds.length).toBeGreaterThan(0);
  expect(cmds.some((c) => c.includes("--target prod") && c.includes("--after-preflight"))).toBe(true);
});

test("every documented release:run command parses, and each prod cutover carries --stage-journal", () => {
  expect(documentedCommands(doc).flatMap(commandProblems)).toEqual([]);
});

test("red control: the old section 4.7 line fails the check", () => {
  const old = "bun run release:run --target prod --go <go> --after-preflight <the preflight's journal>";
  expect(commandProblems(old)).toHaveLength(1);
  expect(commandProblems(old)[0]).toContain("--stage-journal");
});
