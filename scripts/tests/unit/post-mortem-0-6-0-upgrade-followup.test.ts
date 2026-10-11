// Follow-up amendments to the v0.6.0 upgrade post-mortem (issue 1267).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const text = readFileSync(
  new URL(
    "../../../docs/post-mortems/2026-10-09T1704Z-0.6.0-upgrade.md",
    import.meta.url,
  ),
  "utf8",
);
const lines = text.split("\n");

// Text from the matching heading to the next heading of the same or higher level.
function section(re: RegExp): string {
  const start = lines.findIndex((l) => re.test(l));
  expect(start).toBeGreaterThanOrEqual(0);
  const level = lines[start]!.match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#+) /);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const summaryRows = section(/^## Summary/)
  .split("\n")
  .filter((l) => /^\| \d+ \|/.test(l));
const headings = lines.filter((l) => /^### \d+\. /.test(l));

describe("post-mortem 0.6.0 follow-up", () => {
  test("summary row 7 has no PREDICTED", () => {
    const row = summaryRows.find((l) => l.startsWith("| 7 |"))!;
    expect(row).toBeDefined();
    expect(row).not.toContain("PREDICTED");
  });
  test("finding 7 records observed windows", () => {
    const f7 = section(/^### 7\. /);
    expect(f7).toMatch(/Observed 2026-10-\d\d/);
    for (const w of [
      "Vault 6.00 h",
      "woon 12.00 h",
      "allocation 18.00 h",
      "treasury 24.00 h",
    ]) {
      expect(f7).toContain(w);
    }
  });
  test("one summary row per numbered finding, none PREDICTED with an Observed body", () => {
    expect(summaryRows.length).toBe(headings.length);
    for (const h of headings) {
      const n = h.match(/^### (\d+)\./)![1]!;
      const row = summaryRows.find((l) => l.startsWith(`| ${n} |`));
      expect(row).toBeDefined();
      const body = section(new RegExp(`^### ${n}\\. `));
      if (/Observed/.test(body)) expect(row).not.toContain("PREDICTED");
    }
  });
  test("release-process finding", () => {
    const h = headings.find(
      (l) => /^### (2\d|[3-9]\d)\./.test(l) && /release/i.test(l),
    )!;
    expect(h).toBeDefined();
    const n = h.match(/^### (\d+)\./)![1]!;
    const body = section(new RegExp(`^### ${n}\\. `));
    for (const s of ["D62", "v0.6.0 was never tagged", "squash"])
      expect(body).toContain(s);
  });
  test("version, archive and force-with-lease", () => {
    for (const s of [
      "v0.6.1-rc.0",
      "archive/releases-0.6.x-2026-10-09",
      "force-with-lease",
    ]) {
      expect(text).toContain(s);
    }
  });
  test("deployed-source paragraph", () => {
    const para = text
      .split(/\n\s*\n/)
      .find((p) => p.includes("RM_BUILD_COMMIT"))!;
    expect(para).toBeDefined();
    expect(para).toContain("e96d4598");
    expect(para).toContain("fa5a5bbe");
  });
  test("disclosure names migration 0117", () => {
    expect(section(/^## Disclosure/)).toContain("migration 0117");
  });
  test("implementation status is current", () => {
    expect(section(/^## Implementation status/)).not.toContain(
      "Nothing is committed",
    );
  });
  test("no bare issue numbers", () => {
    expect(text.match(/#[0-9]+/g)).toBeNull();
  });
});
