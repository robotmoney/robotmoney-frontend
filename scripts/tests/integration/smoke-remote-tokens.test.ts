// A REMOTE REHEARSAL BOOT NEVER MINTS SERVICE TOKENS — criterion 43, the "never
// from a boot" half, at runtime (smoke-production-spec.md §3, §5).
//
//   §5: "A remote rehearsal target's tokens come only from an explicit
//        provisioning command, never from a boot."
//
// The real `bun --no-env-file scripts/smoke.ts` process — the command an
// operator types — against a "remote" database enrolled `rehearsal`
// (./remote-db-harness.ts: the four roles, rm_owner owning the database, the
// schema bootstrapped from the snapshot), under RM_ENV=stage, from an operator
// whose `$HOME/.env` holds only the §3 keys and whose instance holds NO token
// files. The boot refuses at its token decision (scripts/lib/smoke-main.ts,
// the `tokenReuseRefusal(paths, "remote")` check after the target read and
// before the plan journal, the lock, or any write), naming the provisioning
// command, with:
//   - a non-zero exit;
//   - no journal record past the plan, and none for `prepare (tokens)`;
//   - no token file written under the instance;
//   - `SELECT count(*) FROM automation_tokens` still 0 on the target.
//
// The unit tier's prod-init.test.ts pins the provisioning COMMAND; this file is
// the runtime proof that the BOOT has no minting path for a remote target.
//
// Integration tier: the remote database is a container of its own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PROVISION_TOKENS_COMMAND } from "../../lib/smoke-secret.ts";
import { instancePaths, SERVICE_TOKEN_HOLDERS } from "../../lib/smoke-state.ts";
import { readJournal } from "../../lib/smoke-journal.ts";
import { repoRoot, startRemoteDb, type RemoteDb } from "./remote-db-harness.ts";

let db: RemoteDb;

beforeAll(async () => {
  db = await startRemoteDb("remote_tokens");
}, 180_000);

afterAll(() => db?.close());

describe("a remote rehearsal boot with no token files refuses and mints nothing (criterion 43)", () => {
  test("refuses before any write, naming the provisioning command; no journal record, no file, no automation_tokens row", async () => {
    db.setIdentity("rehearsal");
    expect(db.superuser("SELECT count(*) FROM automation_tokens;")).toBe("0");
    const op = db.operator("notokens");
    const instance = "rm_it_remote_notokens";
    const paths = instancePaths(op.root, instance);
    // No --migrate, no --seed: nothing prompts, so the boot runs straight to
    // the token decision with no terminal.
    const r = Bun.spawnSync(
      ["bun", "--no-env-file", "scripts/smoke.ts", "--instance", instance, "--credentials", op.roster, "--lock-timeout", "10"],
      { cwd: repoRoot, env: { ...op.env, RM_ENV: "stage" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 600_000 },
    );
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect({ code: r.exitCode === 0 ? 0 : "non-zero" }).toEqual({ code: "non-zero" });
    expect({ refusal: out.includes("A boot never provisions a remote target's tokens") && out.includes(PROVISION_TOKENS_COMMAND), tail: out.includes(PROVISION_TOKENS_COMMAND) ? "" : out.slice(-4000) })
      .toEqual({ refusal: true, tail: "" });

    // The refusal is the TOKEN decision and not an earlier one that would make
    // this proof vacuous: the target was reachable and read (the plan names
    // it), and nothing else refused first.
    expect(out).not.toContain("could not be read");
    expect(out).not.toMatch(/deployment_identity is (production|no identity row)/);
    const phases = (readJournal(paths)?.phases ?? []).map((p) => `${p.phase}:${p.step ?? ""}:${p.status}`);
    expect(phases.filter((p) => !p.startsWith("plan:"))).toEqual([]);
    expect(phases.some((p) => p.startsWith("prepare:tokens:"))).toBe(false);

    // Nothing minted, on disk or in the store.
    for (const holder of SERVICE_TOKEN_HOLDERS) {
      expect({ holder, exists: existsSync(paths.tokenFiles[holder]) }).toEqual({ holder, exists: false });
    }
    expect(db.superuser("SELECT count(*) FROM automation_tokens;")).toBe("0");

    // Red control: once the instance holds files (as `provision-tokens` leaves
    // it), the same boot is NOT refused for want of tokens — it proceeds past
    // the target lock and the matrix — so the refusal above is caused by their
    // absence, not by anything else about this target. It still mints nothing:
    // a remote boot reuses files, it never writes the store. Stopped at a
    // boundary (Ctrl-C) once the lock step committed; nothing is replaced.
    for (const holder of SERVICE_TOKEN_HOLDERS) {
      mkdirSync(dirname(paths.tokenFiles[holder]), { recursive: true, mode: 0o700 });
      writeFileSync(paths.tokenFiles[holder], `rmat_placeholder_${holder}\n`, { mode: 0o600 });
    }
    const again = Bun.spawn(
      ["bun", "--no-env-file", "scripts/smoke.ts", "--instance", instance, "--credentials", op.roster, "--lock-timeout", "10"],
      { cwd: repoRoot, env: { ...op.env, RM_ENV: "stage" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    let text = "";
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    };
    const pumps = Promise.all([pump(again.stdout as ReadableStream<Uint8Array>), pump(again.stderr as ReadableStream<Uint8Array>)]);
    const lockCommitted = () => (readJournal(paths)?.phases ?? []).some((p) => p.phase === "prepare" && p.step === "lock" && p.status === "committed");
    const deadline = Date.now() + 540_000;
    while (!lockCommitted() && again.exitCode === null && Date.now() < deadline) await Bun.sleep(500);
    again.kill("SIGINT");
    await again.exited;
    await pumps;
    expect({ lockCommitted: lockCommitted(), tail: lockCommitted() ? "" : text.slice(-4000) }).toEqual({ lockCommitted: true, tail: "" });
    expect(text).not.toContain("A boot never provisions a remote target's tokens");
    expect((readJournal(paths)?.phases ?? []).some((p) => p.phase === "prepare" && p.step === "tokens")).toBe(false);
    expect(db.superuser("SELECT count(*) FROM automation_tokens;")).toBe("0");
  }, 660_000);
});
