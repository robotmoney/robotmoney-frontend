// Issue #883 regression guard.
//
// docs/decisions.md's D35 declares `robotmoney.network` the canonical public
// origin, with `robotmoney.net` deliberately retained for mail and for the
// `swarm.`/`app.`/`site.`/`staging.` deploy subdomains. architecture.md's
// "Network topology" section predated D35 and still described the
// canonical/Marketing surface as `robotmoney.net`. This test locks the
// reconciled state: the section's canonical/Marketing references read
// `robotmoney.network`, while the deploy-subdomain rows and the two
// historical "clean rewrite" / "marketing UI" mentions near the top of the
// document — which describe the pre-rewrite legacy site, not current
// topology — are untouched, per D35's own `robotmoney\.net(?!work)` substring
// hazard warning against a blanket rename.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const ARCHITECTURE_MD = "docs/architecture.md";
const architecture = readFileSync(join(repoRoot, ARCHITECTURE_MD), "utf8");

const SECTION_HEADING = "## Network topology — DNS, origins & vendors";
const NEXT_TOP_LEVEL_HEADING = "\n## 10. Relationship to existing decisions";

function networkTopologySection(): string {
  const start = architecture.indexOf(SECTION_HEADING);
  const end = architecture.indexOf(NEXT_TOP_LEVEL_HEADING, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return architecture.slice(start, end);
}

describe("architecture.md Network topology section names robotmoney.network for the canonical/Marketing surface", () => {
  const section = networkTopologySection();

  // Canary against a vacuous pass: the section must actually have been found
  // and must contain the surface-map table this guard depends on.
  test("the Network topology section was found and contains the subdomain map table", () => {
    expect(section.length).toBeGreaterThan(1000);
    expect(section).toContain("## 3. The surfaces — subdomain map");
  });

  test("the section's introductory sentence reads robotmoney.network", () => {
    expect(section).toContain(
      "How `robotmoney.network` presents several independent product surfaces as one",
    );
    expect(section).not.toMatch(/How `robotmoney\.net`,? presents/);
  });

  test("the surface-map table's Marketing row reads robotmoney.network", () => {
    expect(section).toContain("| `robotmoney.network`, `www.` | Marketing |");
    expect(section).not.toContain("| `robotmoney.net`, `www.` | Marketing |");
  });

  test("the DNS & TLS prose for the Marketing origin reads robotmoney.network", () => {
    expect(section).toContain(
      "- **Marketing** (`robotmoney.network` via CNAME-flattening, and `www`)",
    );
    expect(section).not.toContain(
      "- **Marketing** (`robotmoney.net` via CNAME-flattening, and `www`)",
    );
  });
});

describe("architecture.md Network topology section leaves the deploy subdomains on robotmoney.net", () => {
  const section = networkTopologySection();

  test("the swarm. subdomain row and prose are unchanged", () => {
    expect(section).toContain("| `swarm.robotmoney.net` |");
    expect(section).toContain("**App subdomains** (`swarm.`, `app.`)");
  });

  test("the app. subdomain row is unchanged", () => {
    expect(section).toContain("| `app.robotmoney.net` |");
  });
});

describe("architecture.md's two historical robotmoney.net mentions near the top are unchanged", () => {
  test('the "clean rewrite" sentence still names robotmoney.net', () => {
    expect(architecture).toContain(
      "Robot Money frontend + analytics backend. A clean rewrite of robotmoney.net that",
    );
  });

  test('the "preserve the marketing UI" bullet still names robotmoney.net', () => {
    expect(architecture).toContain(
      "- **Preserve the marketing UI** of robotmoney.net (reproduce the look exactly).",
    );
  });
});
