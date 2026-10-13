// The three reconciliation checks over fixtures, and the receipt's shape
// (backend/src/db/ledger-reconcile.ts; smoke-production-spec.md §8.1, §9.1;
// D67). No database and no git: the pure `reconcile` takes the lists and
// hash maps the runner would read. The runner itself is proved in
// ledger-reconcile-runner.test.ts.
//
// The fixtures are production's own shapes: its ledger applied seven files out
// of number order (0032 after 0033, 0061 after 0062, 0056 to 0062 after 0081)
// and records fourteen duplicate 4-digit prefixes. Both must pass, because
// no check reads a prefix or an applied_at.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appliedBytes,
  ledgerNotInRepo,
  pendingSet,
  reconcile,
  type ReconcileInput,
  type ReconcileReceipt,
} from "../src/db/ledger-reconcile.ts";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const READ_AT = new Date("2026-10-12T12:00:00Z");

/** A repository of `names`, each file's bytes being its own name. */
function repo(names: readonly string[]): Map<string, string> {
  return new Map(names.map((name) => [name, sha(`-- ${name}\n`)]));
}

const REPO_FILES = [
  "0001_backends.sql",
  "0032_append_only_history.sql",
  "0032_wallet_balance_samples_strategy_nav_idle_only.sql",
  "0033_swarm_member_uuid_ids.sql",
  "0033_wallet_backfill.sql",
  "0056_swarm_judge_requires_model.sql",
  "0061_rm_worker_wallet_backfill_grant.sql",
  "0062_rm_readonly_sequence_select.sql",
  "0062_rm_worker_analytics_ledger_read_grant.sql",
  "0080_analytics_ledger_compaction.sql",
  "0081_deployment_identity.sql",
  "0115_token_market_samples.sql",
  "0116_subject_epochs.sql",
  "0117_subject_daily_epochs.sql",
];
const APPLIED = REPO_FILES.filter((f) => f <= "0115_token_market_samples.sql");
const PENDING = REPO_FILES.filter((f) => f > "0115_token_market_samples.sql");

function input(over: Partial<ReconcileInput> = {}): ReconcileInput {
  const checkout = repo(REPO_FILES);
  return { readAt: READ_AT, migrationsDir: "/checkout/backend/migrations", ledger: APPLIED, checkout, pin: { ref: "v0.6.1", commit: "a".repeat(40), files: checkout }, ...over };
}

describe("the healthy fixture", () => {
  test("verdict ok, pending equal to repo minus ledger, every applied file matching the pin", () => {
    const receipt = reconcile(input());
    expect(receipt.verdict).toBe("ok");
    expect(receipt.pending).toEqual(PENDING);
    expect(receipt.missingFromRepo).toEqual([]);
    expect(receipt.unexpectedPending).toEqual([]);
    expect({ ledgerSize: receipt.ledgerSize, repoSize: receipt.repoSize }).toEqual({ ledgerSize: APPLIED.length, repoSize: REPO_FILES.length });
    expect(receipt.perFile.map((f) => f.name)).toEqual(APPLIED);
    expect(receipt.perFile.every((f) => f.verdict === "match" && f.pinSha256 === f.sha256)).toBe(true);
    expect({ pinRef: receipt.pinRef, pinCommit: receipt.pinCommit, readAt: receipt.readAt }).toEqual({ pinRef: "v0.6.1", pinCommit: "a".repeat(40), readAt: READ_AT.toISOString() });
  });

  test("without a pin ref, checks 1 and 2 still run and check 3 is not claimed: perFile is empty", () => {
    const receipt = reconcile(input({ pin: null }));
    expect(receipt.verdict).toBe("ok");
    expect({ pinRef: receipt.pinRef, pinCommit: receipt.pinCommit, perFile: receipt.perFile }).toEqual({ pinRef: null, pinCommit: null, perFile: [] });
    expect(receipt.pending).toEqual(PENDING);
  });

  test("the intended list equal to the pending set passes, in any order", () => {
    expect(reconcile(input({ intended: [...PENDING].reverse() })).verdict).toBe("ok");
  });
});

describe("check 1: the ledger is a subset of the repository", () => {
  test("a ledger name missing from the repo yields ledger-not-subset naming the file", () => {
    const ledger = [...APPLIED, "0090_applied_then_deleted.sql"];
    const receipt = reconcile(input({ ledger }));
    expect(receipt.verdict).toBe("ledger-not-subset");
    expect(receipt.missingFromRepo).toEqual(["0090_applied_then_deleted.sql"]);
    expect(ledgerNotInRepo(ledger, REPO_FILES)).toEqual(["0090_applied_then_deleted.sql"]);
    // The other two checks still report, so one receipt says everything.
    expect(receipt.pending).toEqual(PENDING);
    expect(receipt.perFile.map((f) => f.name)).toEqual(APPLIED);
  });

  test("check 1 outranks every other verdict: a missing name and an edited file report ledger-not-subset", () => {
    const pinned = new Map(repo(REPO_FILES));
    pinned.set("0001_backends.sql", sha("other"));
    const receipt = reconcile(input({ ledger: [...APPLIED, "0090_x.sql"], pin: { ref: "v", commit: "b".repeat(40), files: pinned } }));
    expect(receipt.verdict).toBe("ledger-not-subset");
    expect(receipt.perFile.find((f) => f.name === "0001_backends.sql")?.verdict).toBe("bytes-differ");
  });
});

describe("check 2: pending is exactly repo minus ledger", () => {
  test("an unexpected pending file (intended list passed) yields unexpected-pending naming the file", () => {
    const receipt = reconcile(input({ intended: ["0116_subject_epochs.sql"] }));
    expect(receipt.verdict).toBe("unexpected-pending");
    expect(receipt.unexpectedPending).toEqual(["0117_subject_daily_epochs.sql"]);
    expect(receipt.pending).toEqual(PENDING);
  });

  test("an intended file that is not pending (already applied, or absent) is named too", () => {
    const receipt = reconcile(input({ intended: [...PENDING, "0115_token_market_samples.sql", "0118_not_in_repo.sql"] }));
    expect(receipt.verdict).toBe("unexpected-pending");
    expect(receipt.unexpectedPending).toEqual(["0115_token_market_samples.sql", "0118_not_in_repo.sql"]);
    expect(pendingSet(APPLIED, REPO_FILES, ["0118_not_in_repo.sql"]).unexpected).toEqual([...PENDING, "0118_not_in_repo.sql"].sort());
  });

  test("with no intended list, nothing is unexpected", () => {
    expect(pendingSet(APPLIED, REPO_FILES)).toEqual({ pending: PENDING, unexpected: [] });
  });
});

describe("check 3: applied bytes equal the pin's", () => {
  test("an edited applied file yields bytes-differ with both sha256 values in perFile", () => {
    const checkout = repo(REPO_FILES);
    const edited = sha("-- 0062_rm_readonly_sequence_select.sql, edited after it ran\n");
    checkout.set("0062_rm_readonly_sequence_select.sql", edited);
    const receipt = reconcile(input({ checkout, pin: { ref: "v0.6.1", commit: "a".repeat(40), files: repo(REPO_FILES) } }));
    expect(receipt.verdict).toBe("bytes-differ");
    const file = receipt.perFile.find((f) => f.name === "0062_rm_readonly_sequence_select.sql")!;
    expect(file).toEqual({ name: "0062_rm_readonly_sequence_select.sql", sha256: edited, pinSha256: sha("-- 0062_rm_readonly_sequence_select.sql\n"), verdict: "bytes-differ" });
    expect(receipt.perFile.filter((f) => f.verdict !== "match")).toHaveLength(1);
  });

  test("an edited PENDING file is not an applied-bytes difference: nothing ran it", () => {
    const checkout = repo(REPO_FILES);
    checkout.set("0117_subject_daily_epochs.sql", sha("edited before it runs"));
    expect(reconcile(input({ checkout, pin: { ref: "v", commit: "a".repeat(40), files: repo(REPO_FILES) } })).verdict).toBe("ok");
  });

  test("an applied name absent at the pin ref is unpinned, reported under bytes-differ", () => {
    const pinned = repo(REPO_FILES.filter((f) => f !== "0062_rm_readonly_sequence_select.sql"));
    const receipt = reconcile(input({ pin: { ref: "v0.5.0", commit: "c".repeat(40), files: pinned } }));
    expect(receipt.verdict).toBe("bytes-differ");
    expect(receipt.perFile.find((f) => f.name === "0062_rm_readonly_sequence_select.sql")).toMatchObject({ pinSha256: null, verdict: "unpinned" });
    expect(appliedBytes(["0062_rm_readonly_sequence_select.sql"], repo(REPO_FILES), pinned)[0]?.verdict).toBe("unpinned");
  });

  test("an unresolvable pin ref yields pin-ref-unresolved, with no perFile and no fallback", () => {
    const receipt = reconcile(input({ pin: { ref: "v9.9.9", commit: null, files: new Map() } }));
    expect(receipt.verdict).toBe("pin-ref-unresolved");
    expect({ pinRef: receipt.pinRef, pinCommit: receipt.pinCommit, perFile: receipt.perFile }).toEqual({ pinRef: "v9.9.9", pinCommit: null, perFile: [] });
  });
});

describe("what the checks never read: number order and prefixes", () => {
  test("the out-of-order fixture passes: 0032 after 0033, 0061 after 0062, 0056 to 0062 after 0081", () => {
    // applied_at order, as production's ledger recorded it. The checks take
    // the names alone; the order is given here to show it is not an input.
    const appliedAtOrder = [
      "0001_backends.sql",
      "0033_swarm_member_uuid_ids.sql",
      "0033_wallet_backfill.sql",
      "0032_append_only_history.sql",
      "0032_wallet_balance_samples_strategy_nav_idle_only.sql",
      "0062_rm_readonly_sequence_select.sql",
      "0061_rm_worker_wallet_backfill_grant.sql",
      "0080_analytics_ledger_compaction.sql",
      "0081_deployment_identity.sql",
      "0056_swarm_judge_requires_model.sql",
      "0062_rm_worker_analytics_ledger_read_grant.sql",
      "0115_token_market_samples.sql",
    ];
    expect([...appliedAtOrder].sort()).toEqual(APPLIED);
    const receipt = reconcile(input({ ledger: appliedAtOrder }));
    expect(receipt.verdict).toBe("ok");
    expect(receipt.pending).toEqual(PENDING);
  });

  test("the grandfathered-duplicates fixture passes: two files per prefix on 0032, 0033 and 0062", () => {
    const duplicates = APPLIED.filter((f) => ["0032", "0033", "0062"].includes(f.slice(0, 4)));
    expect(duplicates).toHaveLength(6);
    const receipt = reconcile(input({ ledger: duplicates }));
    expect(receipt.verdict).toBe("ok");
    expect(receipt.ledgerSize).toBe(6);
    expect(receipt.perFile.map((f) => f.name)).toEqual(duplicates);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The receipt's shape, against the JSON schema fixture
// ───────────────────────────────────────────────────────────────────────────

type Schema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
};

/** The subset of JSON Schema the fixture uses: type, required, properties, additionalProperties, items, enum. */
function violations(value: unknown, schema: Schema, at = "$"): string[] {
  const out: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) out.push(`${at}: ${actual} is not ${types.join("|")}`);
  if (actual === "object" && schema.properties) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) out.push(`${at}.${key}: required`);
    for (const [key, child] of Object.entries(object)) {
      const sub = schema.properties[key];
      if (sub) out.push(...violations(child, sub, `${at}.${key}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${key}: not in the schema`);
    }
  }
  if (actual === "array" && schema.items) (value as unknown[]).forEach((item, i) => out.push(...violations(item, schema.items!, `${at}[${i}]`)));
  return out;
}

describe("the receipt JSON matches backend/tests/fixtures/ledger-reconcile-receipt.schema.json", () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "ledger-reconcile-receipt.schema.json"), "utf8")) as Schema;

  const receipts: Record<string, ReconcileReceipt> = {
    ok: reconcile(input()),
    noPin: reconcile(input({ pin: null })),
    notSubset: reconcile(input({ ledger: [...APPLIED, "0090_x.sql"] })),
    unexpected: reconcile(input({ intended: [] })),
    unresolved: reconcile(input({ pin: { ref: "v9", commit: null, files: new Map() } })),
    unpinned: reconcile(input({ pin: { ref: "v", commit: "c".repeat(40), files: repo(REPO_FILES.slice(1)) } })),
  };

  for (const [name, receipt] of Object.entries(receipts)) {
    test(`${name}: every named field is present, nothing else, and the enums hold — through JSON`, () => {
      const json = JSON.parse(JSON.stringify(receipt)) as unknown;
      expect(violations(json, schema)).toEqual([]);
      expect(Object.keys(json as object)).toEqual(schema.required!);
    });
  }

  test("red control: a receipt with a field renamed, and one with an unknown verdict, fail the schema", () => {
    const { ledgerSize, ...renamed } = JSON.parse(JSON.stringify(receipts.ok)) as Record<string, unknown>;
    expect(violations({ ...renamed, ledger_size: ledgerSize }, schema)).toEqual(["$.ledgerSize: required", "$.ledger_size: not in the schema"]);
    expect(violations({ ...(receipts.ok as object), verdict: "fine" }, schema)).toEqual(['$.verdict: "fine" is not one of ["ok","ledger-not-subset","unexpected-pending","bytes-differ","pin-ref-unresolved"]']);
  });
});
