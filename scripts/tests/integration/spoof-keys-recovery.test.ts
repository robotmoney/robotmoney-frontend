// `--spoof-keys` RECOVERS, IT IS NOT ATOMIC — smoke-production-spec.md §6.4,
// §2; criteria 147 (and 146, 35), issue #1026.
//
//   "This is recoverable, not atomic. Between (2) and (4) a container may hold
//    the old key … A crash between (2) and (4) is recovered by rerunning
//    `--spoof-keys`, which finds the database already at the persisted
//    generation and performs only (3)–(4)."
//
// Everything here is the REAL thing: a Postgres container provisioned the way
// production is (remote-db-harness.ts: the four roles, the snapshot schema,
// enrolled `rehearsal`), the rebind child process a boot runs
// (backend/scripts/spoof-rebind.ts, started exactly as `runSpoofRebind` starts
// it, as rm_owner under a session target lock this test holds), and the
// participant containers on the real daemon, reconciled through the boot's own
// composition (planParticipants → renderParticipantServices →
// applyParticipantPlan).
//
//   1. INTERRUPTED REBIND. A competitor holds the fence; the rebind child writes
//      its generation, then WAITS on the fence (seen in pg_locks) — and is
//      killed there. The database is untouched, the generation is on disk, and
//      the rerun rebinds under that SAME generation. A competitor blocks the
//      rebind (criterion 35), and nothing was written before the fence.
//   2. CRASH AFTER COMMIT, BEFORE CONTAINER REPLACEMENT. The rebind commits and
//      the participants are NOT replaced. The rerun finds the database at the
//      persisted generation and rebinds nothing; the boot's reconciliation then
//      stops the old-key containers and starts them on the generation's key
//      and bearer; a later plain boot keeps them there (criterion 146).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { acquireTargetLock, readTargetStateAt, TARGET_LOCK_KEY, withMutationFence, type TargetLock } from "../../../backend/src/db/target-lock.ts";
import { instancePaths } from "../../lib/smoke-state.ts";
import { readSpoofGeneration, runSpoofRebind, type SpoofRebindRequest } from "../../lib/swarm/spoof-keys.ts";
import { planParticipants, type CredentialFile } from "../../lib/swarm/credential-file.ts";
import { applyParticipantPlan, listRunningParticipants, type DockerRun } from "../../lib/participant-compose.ts";
import { hashKey } from "../../../backend/src/lib/keys.ts";
import { startRemoteDb, type RemoteDb } from "./remote-db-harness.ts";
import { credentialEntry, entriesOf, repoRoot, writeParticipantOverlay } from "./participant-fixture.ts";

const DEMO_FILES = ["docker-compose.yml"] as const;
let db: RemoteDb;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  db = await startRemoteDb("spoofrec");
  db.setIdentity("rehearsal");
}, 300_000);

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {
      // a teardown must not mask the test's own failure
    }
  }
  db?.close();
}, 180_000);

const readerUrl = () => `postgres://rm_readonly:${db.passwords.rm_readonly}@${db.host}:${db.port}/${db.database}?sslmode=disable`;

/** Two in-house members seated with their ORIGINAL keys, and the credential file that holds them. */
async function seatInHouse(): Promise<{ file: CredentialFile; ids: string[] }> {
  const tag = randomBytes(3).toString("hex");
  const athena = credentialEntry(`athena${tag}`);
  const robot = credentialEntry(`robot${tag}`);
  for (const [handle, entry] of [[`athena-${tag}`, athena], [`robot-money-${tag}`, robot]] as const) {
    db.superuser(
      `INSERT INTO swarm_members (id, handle, name, status, operator, role) VALUES ('${entry.memberId}', '${handle}', '${handle}', 'active', 'robotmoney', 'member');\n` +
        `INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash) VALUES ('${entry.memberId}', '${entry.publicKeyB64}', true, '${hashKey(entry.bearer)}');`,
    );
  }
  return {
    file: { agents: { [`athena-${tag}`]: athena, [`robot-money-${tag}`]: robot }, judges: {} },
    ids: [athena.memberId, robot.memberId],
  };
}

/** A fresh instance whose saved role passwords are this database's (a `--local` instance's shape). */
function instanceFor(name: string): { root: string; instance: string } {
  const root = mkdtempSync(join(tmpdir(), "rm-spoof-recovery-"));
  const paths = instancePaths(root, name, { create: true });
  writeFileSync(paths.rolePasswordsFile, `${JSON.stringify(db.passwords, null, 2)}\n`, { mode: 0o600 });
  chmodSync(paths.rolePasswordsFile, 0o600);
  return { root, instance: name };
}

async function holdSessionLock(): Promise<TargetLock> {
  const acquired = await acquireTargetLock({
    databaseUrl: readerUrl(),
    holder: { tool: "smoke", planId: null, instance: "rm_it_spoof", host: "test", pid: process.pid },
    timeoutMs: 10_000,
    expected: await readTargetStateAt(readerUrl()),
  });
  if (!acquired.acquired) throw new Error(acquired.reason);
  return acquired.lock;
}

function request(root: string, instance: string, lock: TargetLock, names: readonly string[]): Omit<SpoofRebindRequest, "resultFile"> {
  return {
    instance,
    stateRoot: root,
    target: { host: db.host, port: db.port, database: db.database, sslmode: "disable" },
    lock: { backendPid: lock.backendPid, holder: { ...lock.holder } },
    names,
    flagExplicit: true,
    seatAll: false,
    rmEnv: "stage",
    credentialPath: null,
  };
}

const childEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });

type KeyRow = { member_id: string; active: boolean; spoof_generation_id: string | null; token_hash: string | null; public_key: string };
/** The key rows of `ids`, read by the database's own superuser (doadmin's stand-in), in insertion order. */
const keysOf = async (ids: readonly string[]): Promise<KeyRow[]> =>
  JSON.parse(
    db.superuser(
      `SELECT coalesce(json_agg(k ORDER BY k.id), '[]') FROM (SELECT id, member_id, active, spoof_generation_id, token_hash, public_key ` +
        `FROM swarm_member_keys WHERE member_id IN (${ids.map((id) => `'${id}'`).join(", ")})) k`,
    ),
  ).map(({ id: _id, ...row }: KeyRow & { id: number }) => row);

/** Backend pids waiting (not granted) on the target key's advisory lock. */
const fenceWaiters = (): number[] =>
  db.superuser(
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = ${TARGET_LOCK_KEY.toString()}::bigint`,
  ).split("\n").filter(Boolean).map(Number);

describe("an interrupted rebind recovers to the persisted generation (criteria 147, 35)", () => {
  test("killed while waiting on a competitor's fence: nothing written, the generation kept, the rerun completes it", async () => {
    const { file, ids } = await seatInHouse();
    const names = Object.keys(file.agents);
    const { root, instance } = instanceFor("rm_it_spoof_interrupt");
    const lock = await holdSessionLock();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let fenced!: () => void;
    const isFenced = new Promise<void>((resolve) => (fenced = resolve));
    // A competitor INSIDE a fenced mutation, on a connection of its own.
    const competing = withMutationFence({ databaseUrl: readerUrl(), label: "competitor" }, async () => {
      fenced();
      await held;
    });
    try {
      await isFenced;
      const before = await keysOf(ids);
      // The child exactly as runSpoofRebind starts it, but held so it can be killed.
      const resultFile = join(instancePaths(root, instance).dir, "killed-result.json");
      const child = Bun.spawn(["bun", "--no-env-file", join(repoRoot, "backend", "scripts", "spoof-rebind.ts")], {
        cwd: join(repoRoot, "backend"),
        env: { ...childEnv(), RM_SPOOF_REQUEST: JSON.stringify({ ...request(root, instance, lock, names), resultFile }) },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Wait until the child's rebind connection is WAITING on the fence.
      let waiter: number | undefined;
      const deadline = Date.now() + 60_000;
      while (waiter === undefined && Date.now() < deadline) {
        waiter = fenceWaiters()[0];
        if (waiter === undefined) await Bun.sleep(100);
      }
      expect(waiter).toBeDefined();
      // (1) happened first: the generation is on disk before the fence.
      const persisted = readSpoofGeneration(root, instance);
      expect(persisted).not.toBeNull();
      expect(Object.keys(persisted!.members).sort()).toEqual([...names].sort());
      // The waiting rebind holds nothing on the key table: the fence is its first statement.
      const touching = db.superuser(
        `SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = ${waiter!} AND c.relname = 'swarm_member_keys'`,
      );
      expect(touching).toBe("0");

      // The process dies while it waits.
      child.kill("SIGKILL");
      await child.exited;
      release();
      await competing;

      // The database is exactly as it was: no key superseded, none inserted.
      expect(await keysOf(ids)).toEqual(before);
      expect(existsSync(resultFile)).toBe(false);

      // The rerun reads the SAME generation and completes it, fenced.
      const rerun = await runSpoofRebind(repoRoot, request(root, instance, lock, names), childEnv());
      expect(rerun.ok).toBe(true);
      if (!rerun.ok) return;
      expect(rerun.generationId).toBe(persisted!.generationId);
      expect(rerun.resumed).toBe(false);
      const after = await keysOf(ids);
      for (const member of Object.values(persisted!.members)) {
        const rows = after.filter((r) => r.member_id === member.memberId);
        expect(rows.filter((r) => r.active)).toEqual([
          expect.objectContaining({ public_key: member.identity.publicKeyB64, spoof_generation_id: persisted!.generationId, token_hash: hashKey(member.bearer) }),
        ]);
        // The original key is superseded and KEPT, never deleted.
        expect(rows.filter((r) => !r.active)).toHaveLength(1);
      }
    } finally {
      release();
      await competing.catch(() => undefined);
      await lock.release();
    }
  }, 300_000);
});

describe("a crash after the rebind commits, before the containers are replaced, recovers (criteria 147, 146)", () => {
  test("the rerun rebinds nothing; the boot's reconciliation moves the containers onto the generation; a plain boot keeps them there", async () => {
    const { file, ids } = await seatInHouse();
    const names = Object.keys(file.agents);
    const { root, instance } = instanceFor("rm_it_spoof_crash");
    const project = `rm_it_spoof_${randomBytes(4).toString("hex")}`;
    const docker: DockerRun = (args) => {
      const r = Bun.spawnSync(["docker", ...args], {
        cwd: repoRoot,
        env: {
          ...(process.env as Record<string, string>),
          SMOKE_PROJECT: project,
          RM_STACK_ENV_CLASS: "local",
          RM_STACK_ENV_HASH: "spoofrec",
          RM_INSTANCE: instance,
          RM_INSTANCE_STATE_DIR: instancePaths(root, instance).dir,
          WEB_PORT: "1",
          POSTGRES_PORT: "2",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { exitCode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    };
    cleanups.push(() => {
      const containers = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]).stdout.split("\n").filter(Boolean);
      if (containers.length > 0) docker(["rm", "-f", "-v", ...containers]);
      docker(["network", "rm", `${project}_default`]);
      const images = docker(["images", "-q", "--filter", `reference=${project}-*`]).stdout.split("\n").filter(Boolean);
      if (images.length > 0) docker(["rmi", "-f", ...images]);
    });
    const built = docker(["compose", "--env-file", "/dev/null", "-p", project, ...DEMO_FILES.flatMap((f) => ["-f", f]), "build", "api"]);
    if (built.exitCode !== 0) throw new Error(`building the api image failed: ${built.stderr}`);
    const image = docker(["images", "-q", "--no-trunc", `${project}-api`]).stdout.trim().split("\n")[0]!;
    const instanceDir = instancePaths(root, instance).dir;
    mkdirSync(instanceDir, { recursive: true });

    /** One boot's participants phase: plan (with the instance's generation), render, apply. */
    const reconcile = () => {
      const running = listRunningParticipants(project, docker);
      const plan = planParticipants({ configured: true, path: "/etc/rm/credential.json", origin: "flag" }, running, () => file, {
        spoofState: { stateRoot: root, instance },
      });
      const overlay = writeParticipantOverlay([...plan.start, ...plan.keep], instance, instanceDir, image);
      applyParticipantPlan(plan, overlay.rendered.services.map((s) => s.service), { project, composeFiles: [...DEMO_FILES, overlay.overlay], run: docker });
      return plan;
    };
    const inspect = (container: string) =>
      JSON.parse(docker(["inspect", container]).stdout)[0] as { Id: string; Config: { Env: string[]; Labels: Record<string, string> } };

    // Before any spoof: the participants run on the credential file's own keys.
    reconcile();
    const onFileKeys = listRunningParticipants(project, docker);
    expect(onFileKeys.map((p) => p.name).sort()).toEqual([...names].sort());
    expect(onFileKeys.every((p) => p.generation === undefined)).toBe(true);

    // `--spoof-keys`: the rebind COMMITS, and the process dies before (3)/(4).
    const lock = await holdSessionLock();
    try {
      const first = await runSpoofRebind(repoRoot, request(root, instance, lock, names), childEnv());
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect([...first.rebound].sort()).toEqual([...names].sort());
      const generation = readSpoofGeneration(root, instance)!;
      // Nothing replaced the containers: they still hold the file's keys, which
      // the server now refuses (§6.4's tolerated window).
      expect(listRunningParticipants(project, docker).every((p) => p.generation === undefined)).toBe(true);

      // THE RERUN: the database is already at the persisted generation.
      const rerun = await runSpoofRebind(repoRoot, request(root, instance, lock, names), childEnv());
      expect(rerun.ok).toBe(true);
      if (!rerun.ok) return;
      expect(rerun.generationId).toBe(generation.generationId);
      expect(rerun.resumed).toBe(true);
      expect(rerun.rebound).toEqual([]);
      const keys = await keysOf(ids);
      expect(keys.filter((k) => k.active).every((k) => k.spoof_generation_id === generation.generationId)).toBe(true);

      // (3) and (4): the boot's reconciliation replaces both, stop-then-start.
      const replacing = reconcile();
      expect(replacing.stop.map((p) => p.name).sort()).toEqual([...names].sort());
      expect(replacing.start.map((e) => e.name).sort()).toEqual([...names].sort());
      const onGeneration = listRunningParticipants(project, docker);
      expect(onGeneration.map((p) => `${p.name}@${p.generation}`).sort()).toEqual(names.map((n) => `${n}@${generation.generationId}`).sort());
      for (const p of onGeneration) {
        const member = Object.values(generation.members).find((m) => m.name === p.name)!;
        const env = inspect(p.containerName).Config.Env.join("\n");
        // The generation's bearer and key, never RM_CREDENTIALS'.
        expect(env).toContain(`RM_MEMBER_TOKEN=${member.bearer}`);
        expect(env).toContain(`RM_SPOOF_GENERATION_ID=${generation.generationId}`);
        expect(env).not.toContain(file.agents[p.name]!.bearer);
        expect(env).toContain(`RM_INFERENCE_KEY=${file.agents[p.name]!.modelKey}`);
      }

      // A LATER PLAIN BOOT keeps them on the generation: nothing to replace.
      const idsBefore = onGeneration.map((p) => inspect(p.containerName).Id).sort();
      const plain = reconcile();
      expect(plain.start).toEqual([]);
      expect(plain.stop).toEqual([]);
      expect(listRunningParticipants(project, docker).map((p) => inspect(p.containerName).Id).sort()).toEqual(idsBefore);
    } finally {
      await lock.release();
    }
  }, 900_000);
});
