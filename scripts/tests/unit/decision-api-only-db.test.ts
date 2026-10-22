// Only the api holds a database credential — decision D75, issue 1034.
//
// The rule is recorded where a reader looks for it, and the documents it
// amends say the same thing:
//
//   - docs/decisions.md has a D75 entry stating that no service other than the
//     api holds a database credential, and D52's section carries a
//     "Superseded in part by [D75](#d75)" pointer naming decision 2's
//     rm_worker carve-out;
//   - smoke-production-spec.md §7.2 names `api` as the only database-holding
//     container, and §3's `~/.env` key set holds no rm_worker password.
//
// Red controls plant the old wording and require each check to refuse it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const decisions = () => readFileSync(join(REPO, "docs/decisions.md"), "utf8");
const spec = () => readFileSync(join(REPO, "docs/technical/smoke-production-spec.md"), "utf8");

/** The text of one `## Dnn` section: from its heading to the next `## ` heading. */
export function decisionSection(text: string, id: string): string | null {
  const start = text.search(new RegExp(`^## ${id} — `, "m"));
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.search(/^## /m);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

/** The D75 heading states the rule. */
export function d75StatesTheRule(text: string): boolean {
  const section = decisionSection(text, "D75");
  if (!section) return false;
  const heading = section.split("\n")[0]!;
  return /Only the api holds a database credential/.test(heading) && /No service other than `api` holds a database credential/.test(section);
}

/** D52 points at D75 and names decision 2's rm_worker carve-out. */
export function d52PointsAtD75(text: string): boolean {
  const section = decisionSection(text, "D52");
  if (!section) return false;
  const pointer = /\*\*Superseded in part by \[D75\]\(#d75\)[^*]*\*\*([^\n]*\n>?[^\n]*)/.exec(section);
  return pointer !== null && /Decision 2's `rm_worker`\s*\n?>?\s*carve-out/.test(section.slice(pointer.index, pointer.index + 400));
}

/** §7.2 of the smoke spec: `api` is the only database-holding container. */
export function specNamesApiAlone(text: string): boolean {
  const start = text.indexOf("### 7.2 One library, three callers");
  if (start < 0) return false;
  const end = text.indexOf("### 7.3", start);
  const section = text.slice(start, end < 0 ? undefined : end);
  return /\*\*The database-holding container\*\* — `api`, the only one/.test(section) && !/as `rm_worker`/.test(section);
}

/** §3's `~/.env` key set has no rm_worker password. */
export function envKeySetOmitsWorker(text: string): boolean {
  const line = text.split("\n").find((l) => l.startsWith("**`~/.env`** is the deploying user's home-directory file"));
  if (!line) return false;
  const keySet = /It holds exactly these keys and nothing else: ([^;]*;[^;]*;)/.exec(line);
  return keySet !== null && /`rm_app`/.test(keySet[1]!) && !/rm_worker/.test(keySet[1]!);
}

describe("D75 is recorded and the documents it amends agree (issue 1034)", () => {
  test("docs/decisions.md has a D75 entry stating that no service other than the api holds a database credential", () => {
    expect(d75StatesTheRule(decisions())).toBe(true);
  });

  test("D52's section points at D75 and names decision 2's rm_worker carve-out", () => {
    expect(d52PointsAtD75(decisions())).toBe(true);
  });

  test("smoke-production-spec.md §7.2 names api as the only database-holding container", () => {
    expect(specNamesApiAlone(spec())).toBe(true);
  });

  test("smoke-production-spec.md §3's ~/.env key set has no rm_worker password", () => {
    expect(envKeySetOmitsWorker(spec())).toBe(true);
  });
});

describe("RED CONTROLS: the old wording is refused", () => {
  test("a decisions file with no D75 section, or one that does not state the rule, fails", () => {
    const text = decisions();
    const withoutD75 = text.replace(/^## D75 — /m, "## D99 — ");
    expect(d75StatesTheRule(withoutD75)).toBe(false);
    const weakened = text.replace("No service other than `api` holds a database credential", "Few services hold a database credential");
    expect(d75StatesTheRule(weakened)).toBe(false);
  });

  test("a D52 section without the pointer fails", () => {
    const text = decisions().replace("**Superseded in part by [D75](#d75)", "**Amended by [D75](#d75)");
    expect(d52PointsAtD75(text)).toBe(false);
  });

  test("the pre-D75 §7.2 sentence fails", () => {
    const old = [
      "### 7.2 One library, three callers",
      "",
      "- **The database-holding containers** — `api`, and the pipeline worker running the vault, wallet, buyback and project jobs as `rm_worker` — run checks 1–3 at startup.",
      "",
      "### 7.3 CI isomorphism",
    ].join("\n");
    expect(specNamesApiAlone(old)).toBe(false);
  });

  test("the pre-D75 ~/.env key set fails", () => {
    const old =
      "**`~/.env`** is the deploying user's home-directory file, outside every checkout. It holds exactly these keys and nothing else: the remote connection (host, port, dbname); the runtime role passwords `rm_app`, `rm_worker` and `rm_readonly`; the owner password `rm_owner`.";
    expect(envKeySetOmitsWorker(old)).toBe(false);
  });
});
