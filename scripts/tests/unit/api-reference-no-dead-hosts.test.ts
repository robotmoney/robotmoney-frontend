// Issue #354 compliance-FAIL regression guard.
//
// The prior PR (#328) claimed the committee API reference no longer named
// either dead committee.* host, but the claim was false: both strings still
// appeared verbatim inside an HTML COMMENT at api-reference.html:12 — a
// place no prior check looked, because nothing asserted on the file's raw
// text, only on its rendered/parsed structure. This test reads the file as
// plain text (comments included) so a dead hostname creeping back in
// anywhere — prose, table cell, or comment — turns the suite red.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const API_REFERENCE = "frontend/public/views/docs/investment-committee/api-reference.html";

// The two hostnames the audit found dead (both answer DEPLOYMENT_NOT_FOUND).
// Kept as plain strings (not a shared constant) so this test still catches a
// literal reintroduction even if some other module's copy of the string ever
// changed.
const DEAD_HOSTS = ["committee.robotmoney.net", "committee.staging.robotmoney.net"];

describe("api-reference.html never names a dead committee.* API host", () => {
  const raw = read(API_REFERENCE);

  // Canary against a vacuous pass: the file must actually exist and be
  // non-trivial, so an empty-string false pass can't hide behind this test.
  test("the file is non-empty", () => {
    expect(raw.length).toBeGreaterThan(0);
  });

  for (const host of DEAD_HOSTS) {
    test(`does not contain "${host}" anywhere, including inside comments`, () => {
      expect(raw).not.toContain(host);
    });
  }

  // Belt-and-suspenders: a pattern match in addition to the literal
  // toContain() checks above, so a future edit that varies casing/whitespace
  // around the dead hostnames still trips this guard.
  test("no committee.*.robotmoney.net pattern appears anywhere in the file", () => {
    expect(raw).not.toMatch(/committee\.(?:staging\.)?robotmoney\.net/i);
  });
});
