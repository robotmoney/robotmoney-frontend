// Holds the v0.3.0 rollout manifest (steps.ts) and the runbook prose
// (docs/runbooks/v0-3-0-rollout.md) in agreement mechanically.
//
// Same test as the v0.2.2 one beside it, pointed at this release. The pair is
// deliberate: each release's manifest is checked against ITS OWN runbook, so
// archiving a shipped release's runbook cannot quietly stop testing the live
// one — which is exactly the failure that would otherwise hide here.
//
// WHY. Every bug this test exists to catch has already happened at least once
// in this release:
//   - v0.2.2's §5.6 asked for "all Gate A–D results" after §2 abolished Gate A;
//   - preflight.ts said this release ships four migrations while postflight.ts
//     said six (27ec374 fixed one copy and not the other);
//   - §5.3b was headed "Optional but recommended" while §5.5 called the same
//     step a blocking gate.
// All three are one bug: a fact with two homes. The manifest gives each fact
// one home, and this test fails the moment a second one appears.
//
// It is deliberately filesystem-only — no database, no docker, no network — so
// it runs in any CI job and cannot be skipped for being slow.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { STEPS, THIS_RELEASE_MIGRATIONS } from "../scripts/upgrades/0.2.2-to-0.3.0/steps.ts";
import { APPEND_ONLY_MIGRATION, APPEND_ONLY_TABLES } from "../scripts/upgrades/0.2.2-to-0.3.0/release.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const runbookPath = join(repoRoot, "docs", "runbooks", "v0-3-0-rollout.md");
const runbook = readFileSync(runbookPath, "utf8");

/** Minimal parser for the runbook's ```yaml step blocks. Not a YAML library on
 *  purpose: the blocks are a fixed, flat shape (scalars and `- ` sequences),
 *  and a dependency here would be a dependency in a doc-consistency test. */
function parseStepBlocks(md: string): Record<string, string | string[]>[] {
  const blocks: Record<string, string | string[]>[] = [];
  const re = /```yaml step\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const out: Record<string, string | string[]> = {};
    let currentKey: string | null = null;
    for (const line of m[1]!.split("\n")) {
      if (!line.trim()) continue;
      const seq = line.match(/^\s+-\s+(.*)$/);
      if (seq && currentKey) {
        (out[currentKey] as string[]).push(seq[1]!.trim());
        continue;
      }
      const kv = line.match(/^([a-z-]+):\s*(.*)$/);
      if (!kv) throw new Error(`unparseable line in a yaml step block: ${JSON.stringify(line)}`);
      const [, key, value] = kv;
      if (value!.trim() === "") {
        currentKey = key!;
        out[key!] = [];
      } else {
        currentKey = null;
        out[key!] = value!.trim();
      }
    }
    blocks.push(out);
  }
  return blocks;
}

const blocks = parseStepBlocks(runbook);
const byId = new Map(blocks.map((b) => [b.id as string, b]));

describe("v0.3.0 rollout manifest ↔ runbook", () => {
  test("every step block in the runbook parses and names a known step", () => {
    expect(blocks.length).toBeGreaterThan(0);
    const known = new Set(STEPS.map((s) => s.id));
    for (const b of blocks) {
      expect(typeof b.id).toBe("string");
      expect(known.has(b.id as string)).toBe(true);
    }
  });

  test("every manifest step appears in the runbook exactly once", () => {
    for (const step of STEPS) {
      const hits = blocks.filter((b) => b.id === step.id);
      expect({ id: step.id, blocks: hits.length }).toEqual({ id: step.id, blocks: 1 });
    }
  });

  test("step ids are unique", () => {
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
  });

  test.each(STEPS.map((s) => [s.id, s] as const))("%s — block fields match the manifest", (_id, step) => {
    const b = byId.get(step.id)!;
    expect(b.phase).toBe(step.phase);
    expect(b.section).toBe(step.section);
    expect(b["host-role"]).toBe(step.hostRole);
    expect(b.actor).toBe(step.actor);
    expect(b.verify).toBe(step.verify);
    expect((b.requires as string[] | undefined) ?? []).toEqual(step.requires);
    expect((b["depends-on"] as string[] | undefined) ?? []).toEqual(step.dependsOn);
    expect((b.artifacts as string[] | undefined) ?? []).toEqual(step.artifacts ?? []);
    const ttl: string | null = (b.ttl as string | undefined) ?? null;
    const gate: string | null = (b.gate as string | undefined) ?? null;
    const rec: string | null = (b["expect-in-recovery"] as string | undefined) ?? null;
    expect({ rec }).toEqual({ rec: step.expectInRecovery === undefined ? null : String(step.expectInRecovery) });
    expect({ ttl }).toEqual({ ttl: step.ttlHours ? `${step.ttlHours}h` : null });
    expect({ gate }).toEqual({ gate: step.gate ?? null });
  });

  test("requires references resolve to real steps, and point backwards", () => {
    const index = new Map(STEPS.map((s, i) => [s.id, i]));
    for (const [i, step] of STEPS.entries()) {
      for (const req of step.requires) {
        expect({ step: step.id, req, known: index.has(req) }).toEqual({ step: step.id, req, known: true });
        // A prerequisite that comes LATER in manifest order would make the
        // probe's "first not-ok step is next" rule pick an unreachable step.
        expect({ step: step.id, req, before: index.get(req)! < i }).toEqual({ step: step.id, req, before: true });
      }
    }
  });

  test("a step's TTL never outlives the steps it depends on", () => {
    // A rehearsal cannot be better evidence than the dump proof it consumed.
    // P5.rehearsal-boot used to be 72h against P3.gate-c's 48h, which left a
    // 24h window where the gate read `expired` and the step built on it still
    // read `ok`. This makes the whole class impossible rather than fixing the
    // one instance.
    const byId = new Map(STEPS.map((s) => [s.id, s]));
    for (const step of STEPS) {
      if (!step.ttlHours) continue;
      for (const req of step.requires) {
        const dep = byId.get(req)!;
        if (!dep.ttlHours) continue;
        expect({ step: step.id, req, ok: step.ttlHours <= dep.ttlHours }).toEqual({ step: step.id, req, ok: true });
      }
    }
  });

  test("a step that emits its own receipt is actor:script, not attestable", () => {
    // where.ts refuses `--record` for actor:"script". That refusal guarded
    // NOTHING until this test existed: every script-backed step was
    // actor:"agent", so a rehearsal could be attested by typing --record
    // instead of being run. A step whose verify runs --emit-receipt has a
    // machine that produces its evidence; a human claiming it is not that.
    for (const step of STEPS) {
      if (!step.verify.includes("--emit-receipt")) continue;
      expect({ step: step.id, actor: step.actor }).toEqual({ step: step.id, actor: "script" });
    }
  });

  test("phases are contiguous — manifest order is display order", () => {
    const seen: string[] = [];
    for (const s of STEPS) {
      if (seen[seen.length - 1] !== s.phase) seen.push(s.phase);
    }
    expect(seen.length).toBe(new Set(seen).size);
  });

  test("a step that runs a script declares what invalidates it", () => {
    // Only steps that actually EXECUTE release code. `where.ts --record ...`
    // appears in several verify strings without being the thing being tested,
    // and a psql-only capture (§5.0, §5.4) is legitimately not code-bound.
    const RUNS_CODE = /(preflight|postflight|restore-check|stage-rehearsal)\.ts|bun smoke/;
    for (const step of STEPS) {
      if (!RUNS_CODE.test(step.verify) || step.derived) continue;
      expect({ step: step.id, deps: step.dependsOn.length > 0 }).toEqual({ step: step.id, deps: true });
    }
  });
});

describe("v0.3.0 THIS_RELEASE_MIGRATIONS is the single source", () => {
  test("every named migration exists on disk", () => {
    for (const m of THIS_RELEASE_MIGRATIONS) {
      expect({ m, exists: existsSync(join(repoRoot, "backend", "migrations", m)) }).toEqual({ m, exists: true });
    }
  });

  test("release constants live in release.ts, not in the manifest", () => {
    // THIS release's manifest. Until now this line read 0.2.1-to-0.2.2 — cloned
    // with the rest of the file when #731 forked this suite — so it asserted the
    // PREVIOUS release's manifest twice and left v0.3.0's unchecked.
    const steps = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.2-to-0.3.0", "steps.ts"), "utf8");
    // steps.ts may RE-EXPORT them; declaring them would put display metadata
    // back inside every gate's depends-on, which is what the split undid.
    expect(/const THIS_RELEASE_MIGRATIONS\s*=/.test(steps)).toBe(false);
    // And no gate may depend on the manifest file itself.
    for (const step of STEPS) {
      expect({ step: step.id, dependsOnManifest: step.dependsOn.some((g) => g.endsWith("/steps.ts")) }).toEqual({
        step: step.id,
        dependsOnManifest: false,
      });
    }
  });

  test("no upgrade script declares its own copy", () => {
    for (const f of ["preflight.ts", "postflight.ts"]) {
      const src = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.2-to-0.3.0", f), "utf8");
      // Importing it is fine; re-declaring it is the drift that broke §8's
      // check 2 for three weeks.
      expect({ f, redeclares: /const THIS_RELEASE_MIGRATIONS\s*=/.test(src) }).toEqual({ f, redeclares: false });
    }
  });

  test("the runbook's migration table names every migration this release applies", () => {
    // §2.2 is where an operator reads what the cutover will do to the database.
    // A migration in the manifest but absent from that table is exactly the
    // "fact with two homes" failure — the boot would apply something the
    // runbook never told anyone about.
    const start = runbook.indexOf("### 2.2 🔴 The database delta");
    expect({ found: start >= 0 }).toEqual({ found: true });
    const section = runbook.slice(start, runbook.indexOf("## 3. Go/no-go gates"));
    for (const m of THIS_RELEASE_MIGRATIONS) {
      expect({ m, cited: section.includes(m.replace(/\.sql$/, "")) }).toEqual({ m, cited: true });
    }
  });

  test("the append-only migration constant matches src/db/append-only-guard.ts", () => {
    // release.ts keeps a byte-identical COPY rather than importing the module,
    // because append-only-guard.ts imports db/client.ts, which demands
    // DATABASE_URL at module load and builds the app's writer pool — and these
    // gate scripts must connect exactly once, read-only, from .env.readonly.
    // Nothing else holds the two in agreement, so this does.
    const guard = readFileSync(join(repoRoot, "backend", "src", "db", "append-only-guard.ts"), "utf8");
    const m = guard.match(/APPEND_ONLY_MIGRATION\s*=\s*"([^"]+)"/);
    expect({ found: m !== null }).toEqual({ found: true });
    expect({ copy: APPEND_ONLY_MIGRATION }).toEqual({ copy: m![1]! });
  });

  test("the append-only TABLE ROSTER matches src/db/append-only-guard.ts", () => {
    // Same copy-not-import trade as the constant above, and the same mitigation.
    // postflight's append-only-intact check compares the live triggers against
    // this roster; before it did, ANY non-zero trigger count PASSed, so losing
    // thirteen of fourteen tables read as green. A roster that drifts from the
    // guard would put that hole straight back.
    const guard = readFileSync(join(repoRoot, "backend", "src", "db", "append-only-guard.ts"), "utf8");
    const block = guard.match(/APPEND_ONLY_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/);
    expect({ found: block !== null }).toEqual({ found: true });
    const fromGuard = [...block![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    expect({ tables: [...APPEND_ONLY_TABLES] as string[] }).toEqual({ tables: fromGuard });
  });
});

describe("receipt step ids are wired to the scripts that emit them", () => {
  const wiring: [string, string][] = [
    ["preflight.ts", "P4.preflight-live"],
    ["restore-check.ts", "P3.gate-c"],
    ["stage-rehearsal.ts", "P5.rehearsal-boot"],
    ["postflight.ts", "P5.postflight-twin"],
    ["postflight.ts", "P8.postflight-prod"],
  ];
  test.each(wiring)("%s emits %s", (file, stepId) => {
    const src = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.2-to-0.3.0", file), "utf8");
    expect(src.includes(stepId)).toBe(true);
    expect(STEPS.some((s) => s.id === stepId)).toBe(true);
  });
});

describe("G8 — postflight runs inside the twin's window", () => {
  // The regression this exists to stop. stage-rehearsal.ts is now a thin
  // wrapper over the shared driver (scripts/lib/twin-rehearsal.ts), and the
  // driver tears the twin down in a `finally`. If the wrapper ever stops
  // passing `onReady`, the rehearsal still goes GREEN — it just silently grades
  // restore + boot + serve and never runs a single postflight check, while
  // P5.postflight-twin's step still claims stage-rehearsal.ts is what produces
  // it. That is the exact shape of evidence that is worse than none.
  const rehearsal = readFileSync(
    join(repoRoot, "backend", "scripts", "upgrades", "0.2.2-to-0.3.0", "stage-rehearsal.ts"),
    "utf8",
  );

  test("the rehearsal hands this release's postflight to the driver's onReady window", () => {
    expect({ hook: /onReady\s*:/.test(rehearsal) }).toEqual({ hook: true });
    expect(rehearsal).toContain("0.2.2-to-0.3.0/postflight.ts");
  });

  test("the driver refuses to pass an onReady run it could not reach the twin for", () => {
    // A hook that cannot resolve the twin's URL must FAIL the rehearsal. A
    // "checks did not run" that exits 0 is indistinguishable, in the receipt,
    // from "checks ran and found nothing wrong".
    const driver = readFileSync(join(repoRoot, "scripts", "lib", "twin-rehearsal.ts"), "utf8");
    const guard = driver.slice(driver.indexOf("if (opts.onReady)"));
    expect({ found: guard.length > 0 }).toEqual({ found: true });
    expect(guard.slice(0, guard.indexOf("hookCode"))).toContain("return 1;");
  });

  test("the step that claims the twin postflight names the rehearsal as its verify", () => {
    const step = STEPS.find((s) => s.id === "P5.postflight-twin");
    expect({ found: step !== undefined }).toEqual({ found: true });
    expect(step!.verify).toContain("stage-rehearsal.ts");
  });
});

describe("the runbook names the same checks the scripts actually run", () => {
  // The gap this closes: §6.1 and §9 are TABLES an operator reads to know what
  // a clean run looks like, and nothing held them to the scripts. A check
  // renamed in code and not in the table leaves the operator looking for a row
  // that will never appear — and, worse, not looking for one that will.
  const checkNames = (file: string): string[] => {
    const src = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.2-to-0.3.0", file), "utf8");
    return [...new Set([...src.matchAll(/record\(\s*"([a-z-]+)"/g)].map((m) => m[1]!))].sort();
  };

  test("§6.1 names every check preflight.ts records", () => {
    const section = runbook.slice(
      runbook.indexOf("### 6.1 What it checks"),
      runbook.indexOf("### 6.2"),
    );
    expect({ found: section.length > 0 }).toEqual({ found: true });
    for (const name of checkNames("preflight.ts")) {
      expect({ name, inRunbook: section.includes(`\`${name}\``) }).toEqual({ name, inRunbook: true });
    }
  });

  test("§9 names every check postflight.ts records", () => {
    const section = runbook.slice(
      runbook.indexOf("## 9. Post-cutover verification"),
      runbook.indexOf("### Only when every check is clean"),
    );
    expect({ found: section.length > 0 }).toEqual({ found: true });
    for (const name of checkNames("postflight.ts")) {
      expect({ name, inRunbook: section.includes(`\`${name}\``) }).toEqual({ name, inRunbook: true });
    }
  });
});
