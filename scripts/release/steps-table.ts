#!/usr/bin/env bun
// scripts/release/steps-table.ts — the step list as the runbook's table, from
// the one source (./steps.ts). The docs never hand-copy a step.
//
//   bun scripts/release/steps-table.ts                       print the table
//   bun scripts/release/steps-table.ts --write <doc.md>      replace the region between the markers
//   bun scripts/release/steps-table.ts --check <doc.md>      exit 1 when the region differs (docs lint)
//   bun scripts/release/steps-table.ts --check-ids <doc.md>  exit 1 when a `| R… |` row names a step that is not in the list
//
// The region in a doc is the text between `<!-- steps-table:begin -->` and
// `<!-- steps-table:end -->`, on their own lines.
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_MAX_MINUTES, RELEASE_STEPS, type StepTemplate } from "./steps.ts";

export const BEGIN = "<!-- steps-table:begin -->";
export const END = "<!-- steps-table:end -->";

const hostOf = (s: StepTemplate) => {
  const base = s.host === "control" ? "control" : s.checkout === "legacy" ? `${s.host}, legacy checkout` : s.host;
  const only = s.onlyFor ? `, ${s.onlyFor} only` : "";
  const wait = s.notBefore ? `, not before ${s.notBefore.afterStep} + ${s.notBefore.hours === "watchHours" ? "`watchHours`" : `${s.notBefore.hours} h`}` : "";
  const same = s.sameCheckoutAs ? `; skipped when it is ${s.sameCheckoutAs}'s checkout` : "";
  return `${base}${only}${wait}${same}`;
};
const cmdOf = (s: StepTemplate) => s.cmds.map((argv) => `\`${argv.join(" ").replace(/\|/g, "\\|")}\``).join("; ");
const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** PURE. The markdown table for a step list. */
export function stepsTable(steps: readonly StepTemplate[] = RELEASE_STEPS): string {
  const lines = [
    "| Id | Host | Does | Command | Irreversible | Bound | Standing |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const s of steps) {
    lines.push(`| ${s.id} | ${cell(hostOf(s))} | ${cell(s.description)} | ${cmdOf(s)} | ${s.irreversible ? "**yes**" : "no"} | ${s.maxMinutes ?? DEFAULT_MAX_MINUTES} min | ${s.standing.join(", ") || "—"} |`);
  }
  return lines.join("\n");
}

/** PURE. The doc with its region replaced; undefined when the markers are missing. */
export function replaceRegion(doc: string, table: string): string | undefined {
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  if (a < 0 || b < 0 || b < a) return undefined;
  return `${doc.slice(0, a + BEGIN.length)}\n${table}\n${doc.slice(b)}`;
}

/** PURE. Step ids a doc's tables name (`| R1.2 |`, `| S8.1 |`, `| W1 |`) that the list lacks. */
export function unknownStepIds(doc: string, steps: readonly StepTemplate[] = RELEASE_STEPS): string[] {
  const known = new Set(steps.map((s) => s.id));
  const seen = new Set<string>();
  for (const m of doc.matchAll(/^\| ((?:R\d+\.\d+[a-z]?|S\d+\.\d+|W\d+)) \|/gm)) if (!known.has(m[1]!)) seen.add(m[1]!);
  return [...seen].sort();
}

if (import.meta.main) {
  const [mode, file] = process.argv.slice(2);
  if (mode === undefined) {
    console.log(stepsTable());
  } else if ((mode === "--write" || mode === "--check") && file) {
    const doc = readFileSync(file, "utf8");
    const next = replaceRegion(doc, stepsTable());
    if (next === undefined) { console.error(`${file}: no ${BEGIN} … ${END} region`); process.exit(2); }
    if (mode === "--write") { writeFileSync(file, next); console.log(`${file}: step table written`); }
    else if (next !== doc) { console.error(`${file}: the step table is stale; run: bun scripts/release/steps-table.ts --write ${file}`); process.exit(1); }
    else console.log(`${file}: step table current`);
  } else if (mode === "--check-ids" && file) {
    const unknown = unknownStepIds(readFileSync(file, "utf8"));
    if (unknown.length > 0) { console.error(`${file}: rows name steps not in scripts/release/steps.ts: ${unknown.join(", ")}`); process.exit(1); }
    console.log(`${file}: every step row is a step of the list`);
  } else {
    console.error("usage: steps-table.ts [--write <doc>|--check <doc>|--check-ids <doc>]");
    process.exit(2);
  }
}
