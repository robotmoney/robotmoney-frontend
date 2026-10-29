// Payloads published before D78 replay up to rounding — decision D78,
// issue 1498.
//
// D78 computes every published reduction in error-free arithmetic, so a report
// published before it no longer replays byte for byte. Each place that promises
// byte-for-byte replay must say so in the same sentence:
//
//   - docs/technical/release-runbooks.md section 11 (the SDK release notes);
//   - docs/technical/analytics-requirements.md section 2 (Principles);
//   - docs/technical/analyst-sdk-requirements.md, the "Calculation identity" item.
//
// A sentence that promises byte-for-byte or byte-identical output passes only
// when it also names D78 and says "up to rounding". Red controls plant the old
// wording and require the check to refuse it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

const BYTE_PROMISE = /byte[ -]for[ -]byte|byte-identical/i;

/** The text from a `## ` heading to the next `## ` heading, or null. */
export function headingSection(text: string, heading: string): string | null {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

/** The one list item that starts with `- **<name>.**`, or null. */
export function listItem(text: string, name: string): string | null {
  const line = text.split("\n").find((l) => l.startsWith(`- **${name}.**`));
  return line ?? null;
}

/**
 * The sentences of a markdown passage. A list item or table row starts a new
 * block, indented lines continue it, and a block splits after a full stop.
 */
export function sentences(text: string): string[] {
  const blocks: string[] = [];
  for (const line of text.split("\n")) {
    const starts = /^\s*$/.test(line) || /^(- |\d+\. |\||#)/.test(line);
    if (starts || blocks.length === 0) blocks.push(line.trim());
    else blocks[blocks.length - 1] += ` ${line.trim()}`;
  }
  return blocks.flatMap((b) => b.split(/(?<=\.)\s+(?=[A-Z*_`])/)).filter((s) => s.length > 0);
}

/** The sentences that promise byte-for-byte replay but omit the D78 caveat. */
export function uncaveatedPromises(passage: string | null): string[] | null {
  if (passage === null) return null;
  const promises = sentences(passage).filter((s) => BYTE_PROMISE.test(s));
  if (promises.length === 0) return null;
  return promises.filter((s) => !(/\bD78\b/.test(s) && /up to rounding/.test(s)));
}

const runbook11 = () => headingSection(read("docs/technical/release-runbooks.md"), "11. Analyst SDK releases");
const principles = () => headingSection(read("docs/technical/analytics-requirements.md"), "2. Principles");
const calcIdentity = () => listItem(read("docs/technical/analyst-sdk-requirements.md"), "Calculation identity");

describe("each byte-for-byte replay sentence says pre-D78 payloads replay up to rounding", () => {
  test("release-runbooks.md section 11, release-note item 2", () => {
    expect(uncaveatedPromises(runbook11())).toEqual([]);
  });

  test("analytics-requirements.md section 2, Principles", () => {
    expect(uncaveatedPromises(principles())).toEqual([]);
  });

  test("analyst-sdk-requirements.md, Calculation identity", () => {
    expect(uncaveatedPromises(calcIdentity())).toEqual([]);
  });
});

describe("red controls: the pre-D78 wording is refused", () => {
  test("the old release-note item 2 is refused", () => {
    const old = "**Release notes.** Each tag gets a GitHub release. Its notes state:\n\n1. the archive format it reads;\n2. that it replays published report payloads byte for byte;\n";
    expect(uncaveatedPromises(old)).toEqual(["2. that it replays published report payloads byte for byte;"]);
  });

  test("the old Same inputs, same bytes principle is refused", () => {
    const old =
      "- **Same inputs, same bytes.** Given identical effective input observations, dates, schedules and options, backend and SDK produce byte-identical report payloads, both before and after the refactor.";
    expect(uncaveatedPromises(old)).toHaveLength(1);
  });

  test("the old Calculation identity item is refused, and naming D78 without up to rounding is not enough", () => {
    const old =
      "- **Calculation identity.** Replay records the original methodology and code revision for audit. With identical pinned inputs and options, replay through the refactored module preserves the original serialized report byte for byte.";
    expect(uncaveatedPromises(old)).toHaveLength(1);
    expect(uncaveatedPromises("Replay preserves every report byte for byte under D78.")).toHaveLength(1);
  });

  test("a missing section or one with no byte-for-byte sentence fails instead of passing empty", () => {
    expect(uncaveatedPromises(headingSection("# Doc\n\n## 2. Other\n", "11. Analyst SDK releases"))).toBeNull();
    expect(uncaveatedPromises("Payloads replay up to rounding since D78.")).toBeNull();
    expect(uncaveatedPromises(null)).not.toEqual([]);
  });
});
