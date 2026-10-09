// scripts/tests/unit/release-credentials-init.test.ts — release step R6.2a
// (scripts/release/credentials-init.ts): the in-house roster's credential.json,
// scripted (D61 rule 3). Red controls: a missing member, an inactive member, a
// wrong role, an existing file with a different roster, no model key, and a run
// whose output and receipt must never carry a key, a bearer or the model key.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IN_HOUSE_ROSTER, UNBOUND_BEARER_PREFIX, buildCredentialFile, defaultCredentialPath, planInit, resolveRoster, rosterDifferences, type MemberRow,
} from "../../release/credentials-init.ts";
import { loadCredentialFile, parseCredentialFile, rosterEntries } from "../../lib/swarm/credential-file.ts";
import { RELEASE_STEPS, stepIds } from "../../release/steps.ts";

const ROWS: MemberRow[] = [
  { id: "m-athena", handle: "athena", role: "member", status: "active" },
  { id: "m-noop", handle: "noop-analyst", role: "member", status: "active" },
  { id: "m-rm", handle: "robot-money", role: "member", status: "active" },
  { id: "m-themis", handle: "themis", role: "judge", status: "active" },
];
const IDS = { athena: "m-athena", "noop-analyst": "m-noop", "robot-money": "m-rm", themis: "m-themis" };
const MODEL_KEY = "sk-model-SECRET-123";

const input = (patch: Partial<Parameters<typeof planInit>[0]> = {}) => ({
  home: "/home/x",
  homeEnv: { host: "h", database: "d", OPENCODE_API_KEY: MODEL_KEY } as Record<string, string>,
  rows: ROWS,
  load: loadCredentialFile,
  exists: () => false,
  ...patch,
});

describe("the roster from the database", () => {
  test("the four in-house handles resolve to their member ids", () => {
    expect(resolveRoster(ROWS)).toEqual({ ids: IDS });
  });
  test("red: a missing member, an inactive member, a wrong role each refuse", () => {
    expect(resolveRoster(ROWS.filter((r) => r.handle !== "themis"))).toEqual({ problems: ["no member has handle themis"] });
    expect(resolveRoster(ROWS.map((r) => (r.handle === "athena" ? { ...r, status: "inactive" } : r)))).toEqual({ problems: ["athena is inactive, not active"] });
    expect(resolveRoster(ROWS.map((r) => (r.handle === "themis" ? { ...r, role: "member" } : r)))).toEqual({ problems: ["themis has role member, not judge"] });
  });
});

describe("the file it writes", () => {
  test("a valid credential file: the roster, fresh distinct keys, the model key, placeholder bearers", () => {
    const file = buildCredentialFile(IDS, MODEL_KEY);
    const parsed = parseCredentialFile(JSON.stringify(file), "t");
    expect(Object.keys(parsed.agents).sort()).toEqual([...IN_HOUSE_ROSTER.agents].sort());
    expect(Object.keys(parsed.judges)).toEqual(["themis"]);
    const entries = rosterEntries(parsed);
    expect(entries.map((e) => e.credential.memberId).sort()).toEqual(Object.values(IDS).sort());
    expect(new Set(entries.map((e) => e.credential.publicKeyB64)).size).toBe(4);
    for (const e of entries) {
      expect(e.credential.modelKey).toBe(MODEL_KEY);
      expect(e.credential.bearer.startsWith(UNBOUND_BEARER_PREFIX)).toBe(true);
      expect(Buffer.from(e.credential.publicKeyB64, "base64").length).toBe(32);
      expect(e.credential.privateJwk.kty).toBe("OKP");
    }
  });

  test("plan: no file yet writes at ~/.config/robotmoney/credential.json and appends RM_CREDENTIALS", () => {
    const plan = planInit(input());
    expect(plan.action).toBe("write");
    expect(plan.path).toBe(defaultCredentialPath("/home/x"));
    expect(plan.action === "write" && plan.appendEnv).toBe(true);
  });

  test("red: no OPENCODE_API_KEY and no file refuses (R6.2a must run before R6.2)", () => {
    const plan = planInit(input({ homeEnv: { host: "h", database: "d" } }));
    expect(plan.action).toBe("refuse");
  });

  test("idempotent: an existing file with the same roster is kept, without a model key", () => {
    const dir = mkdtempSync(join(tmpdir(), "creds-"));
    const path = join(dir, "credential.json");
    writeFileSync(path, JSON.stringify(buildCredentialFile(IDS, MODEL_KEY)), { mode: 0o600 });
    const plan = planInit(input({ homeEnv: { RM_CREDENTIALS: path }, exists: () => true }));
    expect(plan).toEqual({ action: "keep", path, appendEnv: false });
  });

  test("red: an existing file with a different roster or other member ids refuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "creds-"));
    const path = join(dir, "credential.json");
    const other = buildCredentialFile(IDS, MODEL_KEY);
    delete (other.agents as Record<string, unknown>)["robot-money"];
    writeFileSync(path, JSON.stringify(other), { mode: 0o600 });
    const plan = planInit(input({ homeEnv: { RM_CREDENTIALS: path }, exists: () => true }));
    expect(plan.action).toBe("refuse");
    expect(plan.action === "refuse" && plan.problems.join()).toContain("agents are [athena, noop-analyst]");
    expect(rosterDifferences(buildCredentialFile(IDS, MODEL_KEY), { ...IDS, themis: "m-other" }).join()).toContain("judges.themis names member m-themis");
  });

  test("red: RM_CREDENTIALS naming a missing file refuses; it never creates a file at a path the operator named", () => {
    expect(planInit(input({ homeEnv: { RM_CREDENTIALS: "/nowhere/c.json", OPENCODE_API_KEY: MODEL_KEY } })).action).toBe("refuse");
  });
});

describe("the step", () => {
  test("a run never prints or receipts a key, a bearer or the model key", () => {
    // Drive the pure plan and the receipt shape the script writes: the receipt
    // is built from the plan's path, the roster and the rows, never from the file.
    const dir = mkdtempSync(join(tmpdir(), "creds-run-"));
    const home = join(dir, "home");
    mkdirSync(home);
    const plan = planInit(input({ home }));
    expect(plan.action).toBe("write");
    if (plan.action !== "write") return;
    mkdirSync(join(home, ".config", "robotmoney"), { recursive: true, mode: 0o700 });
    writeFileSync(plan.path, JSON.stringify(plan.file), { mode: 0o600 });
    expect(statSync(plan.path).mode & 0o777).toBe(0o600);
    const src = readFileSync(join(import.meta.dir, "..", "..", "release", "credentials-init.ts"), "utf8");
    const printed = [...src.matchAll(/console\.(log|error)\(([^;]*)\);/g)].map((m) => m[2]).join("\n");
    expect(printed).not.toMatch(/plan\.file|modelKey\b|\.bearer|privateJwk|publicKeyB64|OPENCODE_API_KEY\]/);
    const receiptBlock = src.slice(src.indexOf("const receipt = {"), src.indexOf("mkdirSync(receiptDir"));
    expect(receiptBlock).not.toMatch(/plan\.file|homeEnv\[/);
  });
});
