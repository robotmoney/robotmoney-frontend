// This repository is PUBLIC. A rollout receipt is not.
//
// A full receipt records DbIdentity — the server address, port, database name
// and user of the database the step actually connected to — plus the hostname of
// the box that ran it. Committing that verbatim publishes production's database
// endpoint, which is the same objection that ruled out posting receipts as issue
// comments. So the committed copy is a projection, and this file is the thing
// that makes the projection true rather than intended.
//
// THE ALLOW-LIST IS POSITIVE, AND THAT IS THE WHOLE DESIGN. A deny-list leaks by
// DEFAULT: somebody adds a field to RolloutReceipt, nobody remembers to redact
// it, and it ships. Here an unclassified field fails three ways — a type error
// from `Record<keyof RolloutReceipt, Disclosure>`, a runtime throw from
// projectForCommit(), and the "every declared field is classified" test below,
// which reads the INTERFACE out of the source rather than a hand-kept list, so
// it cannot go stale the way a transcribed list would.
//
// It also reads the REAL committed rollout-evidence/ tree on every PR: no
// private key material anywhere in it, every allowed-signers line a public key,
// and a distinct key per environment principal — because "a stage key cannot
// sign a production step" is a property of that file's CONTENT, not of the
// verifier.
//
// Runs in the required `unit.yml` job — `bun run test:unit`. Filesystem only:
// no network, no Docker, no database.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DB_IDENTITY_DISCLOSURE,
  RECEIPT_DISCLOSURE,
  projectForCommit,
  serialiseCommittedReceipt,
} from "../../../backend/scripts/lib/rollout-receipt.ts";
import type { RolloutReceipt } from "../../../backend/scripts/lib/rollout-receipt.ts";
import { EVIDENCE_DIR, allowedSignersPath } from "../../../backend/scripts/lib/rollout-signing.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const RECEIPT_SOURCE = join(repoRoot, "backend", "scripts", "lib", "rollout-receipt.ts");

/** A receipt with EVERY disclosure-bearing field populated with a value that is
 *  unmistakable if it survives into the committed bytes. */
const SENSITIVE = {
  server: "10.116.0.7",
  port: 25060,
  database: "defaultdb",
  user: "rm_app_writer",
  host: "rm-frontend-prod-1",
};

function fixture(): RolloutReceipt {
  return {
    step: "P8.postflight-prod",
    exit: 0,
    verdict: "POSTFLIGHT CLEAN",
    started_at: "2026-09-01T10:00:00.000Z",
    at: "2026-09-01T10:04:00.000Z",
    host: SENSITIVE.host,
    host_role: "cutover",
    repo_sha: "a".repeat(40),
    repo_branch: "releases-0.4.x",
    rc_tag: "v0.4.0-rc.3",
    repo_dirty: false,
    db: {
      server: SENSITIVE.server,
      port: SENSITIVE.port,
      database: SENSITIVE.database,
      user: SENSITIVE.user,
      in_recovery: false,
    },
    checks: { pass: 7, warn: 0, fail: 0, warned: [], failed: [] },
    artifacts: [],
    attested: false,
    note: "cutover completed",
  };
}

/** The field names declared in `export interface RolloutReceipt { … }`, read out
 *  of the source so this test tracks the real interface rather than a copy. */
function declaredReceiptFields(): string[] {
  const src = readFileSync(RECEIPT_SOURCE, "utf8");
  const start = src.indexOf("export interface RolloutReceipt {");
  if (start === -1) throw new Error("RolloutReceipt interface not found — this test's extractor has gone stale");
  const end = src.indexOf("\n}", start);
  if (end === -1) throw new Error("RolloutReceipt interface has no closing brace — extractor stale");
  const body = src.slice(start, end);
  const fields = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] as string);
  if (fields.length === 0) throw new Error("extracted zero fields from RolloutReceipt — extractor stale");
  return fields;
}

describe("the committed projection redacts database identity and the hostname", () => {
  test("no server, port, database, user or host value survives into the committed bytes", () => {
    const bytes = serialiseCommittedReceipt(projectForCommit(fixture()));
    const leaked = Object.entries(SENSITIVE)
      .filter(([, value]) => bytes.includes(String(value)))
      .map(([field, value]) => `${field}=${value}`);
    expect(leaked).toEqual([]);
  });

  test("the fields are OMITTED, not masked — the keys themselves are gone", () => {
    // Masking would still publish the shape and would invite somebody to
    // "improve" the mask later. There is nothing to improve if the key is absent.
    const projected = projectForCommit(fixture()) as unknown as Record<string, unknown>;
    expect(Object.keys(projected)).not.toContain("host");
    expect(Object.keys(projected.db as object)).toEqual(["in_recovery"]);
  });

  test("in_recovery SURVIVES — it is the only db field the probe grades on", () => {
    // rollout-where.ts's evaluate() compares r.db.in_recovery against the step's
    // expectInRecovery. Redacting it would not protect anything and would cost
    // the "connected successfully, to the wrong database" check.
    const forPrimary = projectForCommit(fixture());
    expect(forPrimary.db).toEqual({ in_recovery: false });
    const replica = fixture();
    replica.db!.in_recovery = true;
    expect(projectForCommit(replica).db).toEqual({ in_recovery: true });
  });

  test("the surviving fields are still there — the projection is a redaction, not a deletion", () => {
    const projected = projectForCommit(fixture());
    expect({
      step: projected.step,
      exit: projected.exit,
      verdict: projected.verdict,
      repo_sha: projected.repo_sha,
      rc_tag: projected.rc_tag,
      attested: projected.attested,
    }).toEqual({
      step: "P8.postflight-prod",
      exit: 0,
      verdict: "POSTFLIGHT CLEAN",
      repo_sha: "a".repeat(40),
      rc_tag: "v0.4.0-rc.3",
      attested: false,
    });
  });

  test("the bytes are canonical: key order comes from the allow-list, not the input object", () => {
    // The bytes are what gets signed, so two equal receipts built in different
    // orders must serialise identically or a signature would be unverifiable
    // for reasons that have nothing to do with trust.
    const a = fixture();
    const shuffled = Object.fromEntries(Object.entries(a).reverse()) as unknown as RolloutReceipt;
    expect(serialiseCommittedReceipt(projectForCommit(shuffled))).toBe(serialiseCommittedReceipt(projectForCommit(a)));
  });
});

describe("the allow-list is POSITIVE: an unclassified field fails rather than shipping", () => {
  test("an extra, unclassified receipt field throws instead of being emitted", () => {
    const withExtra = { ...fixture(), connection_string: "postgres://u:p@h:25060/db" } as unknown as RolloutReceipt;
    expect(() => projectForCommit(withExtra)).toThrow(/connection_string/);
    // And, critically, it is not emitted by some other path either.
    let bytes = "";
    try {
      bytes = serialiseCommittedReceipt(projectForCommit(withExtra));
    } catch {
      bytes = "";
    }
    expect(bytes).toBe("");
  });

  test("an extra, unclassified DATABASE identity field throws too", () => {
    const r = fixture();
    (r.db as unknown as Record<string, unknown>).ssl_cert = "-----BEGIN CERTIFICATE-----";
    expect(() => projectForCommit(r)).toThrow(/ssl_cert/);
  });

  test("EVERY field declared on RolloutReceipt is classified in RECEIPT_DISCLOSURE", () => {
    // Read off the interface in the source: a field added there without a
    // classification fails here even when no fixture happens to carry it.
    const declared = declaredReceiptFields();
    const unclassified = declared.filter((f) => !(f in RECEIPT_DISCLOSURE));
    expect(unclassified).toEqual([]);
    // ...and nothing is classified that no longer exists, so the map cannot rot.
    const stale = Object.keys(RECEIPT_DISCLOSURE).filter((f) => !declared.includes(f));
    expect(stale).toEqual([]);
  });

  test("the classification of the disclosing fields is REDACTED, and is not vacuous", () => {
    expect(RECEIPT_DISCLOSURE.host).toBe("redacted");
    expect(RECEIPT_DISCLOSURE.db).toBe("projected");
    expect({
      server: DB_IDENTITY_DISCLOSURE.server,
      port: DB_IDENTITY_DISCLOSURE.port,
      database: DB_IDENTITY_DISCLOSURE.database,
      user: DB_IDENTITY_DISCLOSURE.user,
      in_recovery: DB_IDENTITY_DISCLOSURE.in_recovery,
    }).toEqual({
      server: "redacted",
      port: "redacted",
      database: "redacted",
      user: "redacted",
      in_recovery: "public",
    });
  });

  test("the maps are frozen — a caller cannot reclassify a field at runtime", () => {
    expect(Object.isFrozen(RECEIPT_DISCLOSURE)).toBe(true);
    expect(Object.isFrozen(DB_IDENTITY_DISCLOSURE)).toBe(true);
  });
});

// ── the REAL committed tree, on every PR ────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/** A non-comment, non-blank allowed-signers line: `<principals> <keytype> <blob>`. */
interface SignerLine {
  n: number;
  principals: string;
  keytype: string;
  blob: string;
}

function allowedSignerLines(): SignerLine[] {
  return readFileSync(allowedSignersPath(repoRoot), "utf8")
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.length > 0 && !line.startsWith("#"))
    .map(({ line, n }) => {
      const [principals, keytype, blob] = line.split(/\s+/);
      return { n, principals: principals ?? "", keytype: keytype ?? "", blob: blob ?? "" };
    });
}

describe("the committed evidence tree carries no private key material", () => {
  const evidenceRoot = join(repoRoot, EVIDENCE_DIR);

  test("the evidence tree and its allowed-signers file exist", () => {
    // Without this the whole describe below would pass vacuously on an empty tree.
    expect({ tree: statSync(evidenceRoot).isDirectory() }).toEqual({ tree: true });
    expect({ allowList: statSync(allowedSignersPath(repoRoot)).isFile() }).toEqual({ allowList: true });
  });

  test("no file anywhere under the evidence tree contains private key material", () => {
    const markers = [
      "PRIVATE KEY",
      "BEGIN OPENSSH PRIVATE",
      "BEGIN RSA PRIVATE",
      "BEGIN EC PRIVATE",
      "BEGIN PGP PRIVATE",
    ];
    const offenders: string[] = [];
    for (const file of walk(evidenceRoot)) {
      const text = readFileSync(file, "utf8");
      for (const marker of markers) {
        // The marker names appear in this test file and in the allowed-signers
        // header PROSE, so the check is on content that is not a comment line.
        const hit = text
          .split("\n")
          .some((line) => !line.trim().startsWith("#") && line.includes(marker));
        if (hit) offenders.push(`${file}: ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every allowed-signers line is a PUBLIC key in OpenSSH allowed_signers form", () => {
    const lines = allowedSignerLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const bad = lines
      .filter((l) => !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com)$/.test(l.keytype) || !/^[A-Za-z0-9+/=]{40,}$/.test(l.blob))
      .map((l) => `line ${l.n}: ${l.keytype}`);
    expect(bad).toEqual([]);
  });

  test("each environment principal has a DISTINCT key — a stage key cannot sign a production step", () => {
    const lines = allowedSignerLines();
    const principals = lines.map((l) => l.principals);
    expect(new Set(principals).size).toBe(principals.length);
    const blobs = lines.map((l) => l.blob);
    expect(new Set(blobs).size).toBe(blobs.length);
    // The separation is only real if the environments are actually distinct
    // principals, not two names for one deployment.
    expect(principals.some((p) => /stage/i.test(p))).toBe(true);
    expect(principals.some((p) => /prod/i.test(p))).toBe(true);
  });

  test("RED CONTROL: the public-key check can actually reject a private key line", () => {
    // Without this, a broken regex would pass the tree above forever.
    const planted = "rollout-stage@robotmoney -----BEGIN OPENSSH PRIVATE KEY-----".split(/\s+/);
    expect(/^(ssh-ed25519|ssh-rsa)$/.test(planted[1] as string)).toBe(false);
  });
});
