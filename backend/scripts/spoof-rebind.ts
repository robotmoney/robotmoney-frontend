// THE DATABASE HALF OF `--spoof-keys` — smoke-production-spec.md §6.4 steps
// (1) and (2), §2, §4.3; issue #1026 criteria 35, 146, 147.
//
// WHAT IT DOES. For the named in-house members of a REHEARSAL target (default:
// every member with `operator = robotmoney`), it persists a generation of fresh
// keypairs and bearers in the instance's state directory — never the
// `RM_CREDENTIALS` path — and then rebinds every one of those members to its
// generation key in ONE fenced `rm_owner` transaction, keyed by member id.
// scripts/lib/swarm/spoof-keys.ts `spoofKeys` owns the order, the guards and
// the resume rule; this module supplies the statements it runs.
//
// THE KEY MECHANISM IS THE EXISTING ONE (D55 (6)). A rebind supersedes the
// member's active key rows with `active = false` — the tombstone `rotate-key`
// writes — and inserts the new active row carrying the generation's public key,
// the generation id (`spoof_generation_id`, migration 0087) and, once issued,
// ONLY the hash of the generation's bearer (`token_hash`, the column the API
// authenticates a member bearer against). Nothing is deleted: the superseded
// rows stay as the verification history past takes and judgements were signed
// against, and a submission signed with a superseded key is refused (§6.4).
//
// ONE FENCED TRANSACTION (§2). Every statement of the rebind runs inside
// `withMutationFence`, whose first statement is `pg_advisory_xact_lock` on the
// target key, on the `rm_owner` connection performing the write. Either every
// named member moved to the generation or none did, and a competitor that won
// the session lock after the coordinator died still waits for this commit.
//
// RESUMABLE, NOT ATOMIC (§6.4). The generation file is written BEFORE the
// fence opens. A run killed before the commit leaves the file and an untouched
// database: the rerun reads the SAME generation back and rebinds under it. A
// run killed after the commit leaves the database at the generation: the rerun
// reads every spoofed member's active key, finds the generation id on all of
// them, skips the rebind, and the boot's reconciliation replaces the containers
// (steps 3 and 4).
//
// WHO RUNS IT. `bun smoke --spoof-keys` as its `prepare (spoof-keys)` step, as
// `bun --no-env-file backend/scripts/spoof-rebind.ts` with one JSON request in
// RM_SPOOF_REQUEST (scripts/lib/swarm/spoof-keys.ts `runSpoofRebind`) and no
// secret in it. It reads rm_owner from the instance's generated role passwords
// (§5: a Postgres smoke owns) and proves through `observeTargetLock` that the
// boot still holds the session target lock before it writes. A remote target
// has no generated owner password, so a boot against one refuses
// `no_owner_credential` (§6.4: a typed owner is the remote form).
import { writeFileSync } from "node:fs";
import { on, registerQuery, type RegistryDb } from "../src/db/registry.ts";
import { hashKey } from "../src/lib/keys.ts";
import { urlForRole } from "../../scripts/lib/env-role.ts";
import { instancePaths, readRolePasswords } from "../../scripts/lib/smoke-state.ts";
import {
  SpoofKeysRefusal,
  spoofKeys,
  type SpoofGeneration,
  type SpoofKeysOutcome,
  type SpoofRebindDeps,
  type SpoofRebindRequest,
  type SpoofRebindResult,
} from "../../scripts/lib/swarm/spoof-keys.ts";
import type { HeldTargetLock, LockHolder } from "../src/db/target-lock.ts";

const SPOOF_CLI = "scripts/spoof-rebind";

// ── THE STATEMENTS, REGISTERED (spec §7.1) ──────────────────────────────────
// Every one runs as rm_owner, on the fence's own transaction, from this entry
// module alone.

const readMembers = registerQuery({
  role: "rm_owner",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "scripts/spoof-rebind:readMembers",
  purpose: "Resolve every member's id, handle and operator under the target lock, so --spoof-keys spoofs in-house members by id and never a third party's.",
  callers: [SPOOF_CLI],
  probe: { statement: "SELECT id, handle, operator FROM swarm_members ORDER BY id" },
});

const readActiveGenerations = registerQuery({
  role: "rm_owner",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "scripts/spoof-rebind:readInstalledGeneration",
  purpose: "Read the spoof generation id on each named member's active key, to tell a rerun after the rebind committed from one before it.",
  callers: [SPOOF_CLI],
  probe: {
    statement: "SELECT member_id, spoof_generation_id FROM swarm_member_keys WHERE active AND member_id = ANY($1::text[])",
    params: ["{m-probe}"],
  },
});

const supersedeActiveKeys = registerQuery({
  role: "rm_owner",
  object: "swarm_member_keys",
  // SELECT because the WHERE clause reads member_id and active.
  privileges: ["SELECT", "UPDATE"],
  site: "scripts/spoof-rebind:supersedeActiveKeys",
  purpose: "Retire a spoofed member's active key rows with the rotate-key tombstone (active = false); history is kept, never deleted.",
  callers: [SPOOF_CLI],
  probe: {
    statement: "UPDATE swarm_member_keys SET active = false WHERE member_id = $1 AND active = true",
    params: ["m-probe"],
  },
});

const insertGenerationKey = registerQuery({
  role: "rm_owner",
  object: "swarm_member_keys",
  privileges: ["INSERT"],
  site: "scripts/spoof-rebind:insertGenerationKey",
  purpose: "Insert a spoofed member's new active key row carrying the generation's public key and generation id.",
  callers: [SPOOF_CLI],
  probe: {
    statement: "INSERT INTO swarm_member_keys (member_id, public_key, active, spoof_generation_id) SELECT $1, $2, true, $3 WHERE false",
    params: ["m-probe", "probe-public-key", "gen-probe"],
  },
});

const issueGenerationBearer = registerQuery({
  role: "rm_owner",
  object: "swarm_member_keys",
  // SELECT because the WHERE clause reads member_id, active and the generation.
  privileges: ["SELECT", "UPDATE"],
  site: "scripts/spoof-rebind:issueGenerationBearer",
  purpose: "Store only the hash of a spoofed member's generation bearer on the key row the rebind just inserted.",
  callers: [SPOOF_CLI],
  probe: {
    statement: "UPDATE swarm_member_keys SET token_hash = $1 WHERE member_id = $2 AND active = true AND spoof_generation_id = $3",
    params: ["0000000000000000000000000000000000000000000000000000000000000000", "m-probe", "gen-probe"],
  },
});

/**
 * The fenced statements `spoofKeys` needs, over one owner connection: the
 * rebind's writes on the fence's own transaction, and the rerun read on the
 * owner connection outside it.
 */
export function spoofRebindDeps(options: {
  readonly ownerUrl: string;
  readonly withMutationFence: <T>(opts: { databaseUrl: string; label: string }, body: (tx: RegistryDb) => Promise<T>) => Promise<T>;
  readonly reader: RegistryDb;
  /** A lock the caller holds; proven held immediately before the fence opens. */
  readonly lock?: HeldTargetLock;
  readonly assertStillHeld?: (lock: HeldTargetLock, phase: string) => Promise<void>;
}): SpoofRebindDeps {
  let tx: RegistryDb | undefined;
  const inFence = (what: string): RegistryDb => {
    if (!tx) throw new Error(`${what} ran outside the fenced transaction; every rebind statement is fenced (spec §2)`);
    return tx;
  };
  return {
    async withFencedTransaction<T>(fn: () => Promise<T>): Promise<T> {
      if (options.lock && options.assertStillHeld) await options.assertStillHeld(options.lock, "prepare spoof-keys");
      return options.withMutationFence({ databaseUrl: options.ownerUrl, label: "spoof-keys" }, async (fenced) => {
        tx = fenced;
        try {
          return await fn();
        } finally {
          tx = undefined;
        }
      });
    },
    async rebindMemberKey(memberId: string, publicKeyB64: string, generationId: string): Promise<void> {
      const db = inFence("rebindMemberKey");
      await on(db, supersedeActiveKeys)`UPDATE swarm_member_keys SET active = false WHERE member_id = ${memberId} AND active = true`;
      await on(db, insertGenerationKey)`INSERT INTO swarm_member_keys (member_id, public_key, active, spoof_generation_id) VALUES (${memberId}, ${publicKeyB64}, true, ${generationId})`;
    },
    async issueMemberToken(memberId: string, bearer: string, generationId: string): Promise<void> {
      const db = inFence("issueMemberToken");
      const issued = await on(db, issueGenerationBearer)`UPDATE swarm_member_keys SET token_hash = ${hashKey(bearer)} WHERE member_id = ${memberId} AND active = true AND spoof_generation_id = ${generationId}`;
      if (issued.count !== 1) {
        throw new Error(`the generation bearer for member ${memberId} landed on ${issued.count} key rows, not the one this rebind inserted`);
      }
    },
    async readInstalledGeneration(generation: SpoofGeneration): Promise<string | null> {
      const ids = Object.values(generation.members).map((m) => m.memberId);
      if (ids.length === 0) return null;
      const rows = await on(options.reader, readActiveGenerations)<{ member_id: string; spoof_generation_id: string | null }>`SELECT member_id, spoof_generation_id FROM swarm_member_keys WHERE active AND member_id = ANY(${ids})`;
      // The database is AT a generation only when every named member has
      // exactly one active key and all of them carry the same id — which the
      // one-transaction rebind guarantees for all of them or none.
      if (rows.length !== ids.length) return null;
      const generations = new Set(rows.map((r) => r.spoof_generation_id));
      if (generations.size !== 1) return null;
      return [...generations][0] ?? null;
    },
  };
}

/** Everything one rebind needs once the caller holds a lock and an owner URL. */
export interface SpoofRebindOptions {
  /** An `rm_owner` URL on a direct connection. Never logged. */
  readonly ownerUrl: string;
  readonly instance: string;
  readonly stateRoot: string;
  readonly names: readonly string[];
  readonly flagExplicit: boolean;
  readonly rmEnv: "prod" | "stage" | null;
  readonly credentialPath: string | null;
  /** A lock the caller holds; proven held immediately before the fenced write. */
  readonly lock?: HeldTargetLock;
}

/**
 * Steps (1) and (2) of §6.4 against the target `ownerUrl` names, as rm_owner.
 *
 * The four guards run on the target's own enrollment, read on the owner
 * connection: `RM_ENV` must not be prod, `deployment_identity` must be
 * rehearsal, the owner credential is in hand (it is: this function holds its
 * URL), and the flag was explicit. Then `spoofKeys` persists or reuses the
 * generation and rebinds in one fence.
 *
 * Refusals: every `SpoofKeysRefusal`; a lock that cannot be proven held; any
 * failure of the fenced transaction, which rolls every rebind back.
 */
export async function spoofRebind(options: SpoofRebindOptions): Promise<SpoofKeysOutcome> {
  const { default: postgres } = await import("postgres");
  const { assertStillHeld, readTargetState, withMutationFence } = await import("../src/db/target-lock.ts");
  const owner = postgres(options.ownerUrl, { max: 1, onnotice: () => {} });
  try {
    const state = await readTargetState(owner);
    const members = await on(owner, readMembers)<{ id: string; handle: string | null; operator: string | null }>`SELECT id, handle, operator FROM swarm_members ORDER BY id`;
    const resolved = members.map((m) => ({ name: m.handle ?? m.id, memberId: m.id, operator: m.operator ?? "" }));
    const db = spoofRebindDeps({
      ownerUrl: options.ownerUrl,
      reader: owner,
      withMutationFence,
      ...(options.lock ? { lock: options.lock, assertStillHeld } : {}),
    });
    return await spoofKeys({
      guards: {
        rmEnv: options.rmEnv,
        deploymentIdentity: state.identity === "missing" ? null : state.identity,
        hasOwnerCredential: true,
        flagExplicit: options.flagExplicit,
        credentialPath: options.credentialPath,
      },
      instance: options.instance,
      stateRoot: options.stateRoot,
      names: options.names,
      members: resolved,
      db,
    });
  } finally {
    await owner.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** The owner and reader URLs a request names, from the instance's generated role passwords. */
function requestUrls(request: SpoofRebindRequest): { ownerUrl: string; readerUrl: string } {
  const connection = {
    host: request.target.host,
    port: String(request.target.port),
    database: request.target.database,
    sslmode: request.target.sslmode,
  };
  let passwords: ReturnType<typeof readRolePasswords>;
  try {
    passwords = readRolePasswords(instancePaths(request.stateRoot, request.instance));
  } catch {
    throw new SpoofKeysRefusal(
      "no_owner_credential",
      "--spoof-keys refuses: this instance holds no generated rm_owner password (a remote target's owner is typed, never stored)",
    );
  }
  const readerUrl = urlForRole({ ...connection, rm_readonly: passwords.rm_readonly }, "rm_readonly");
  const ownerUrl = urlForRole({ ...connection, rm_owner: passwords.rm_owner }, "rm_owner");
  if (!readerUrl || !ownerUrl) {
    throw new SpoofKeysRefusal("no_owner_credential", "--spoof-keys refuses: the instance's role passwords do not name rm_owner");
  }
  return { ownerUrl, readerUrl };
}

/** The direct-run form: `bun smoke --spoof-keys`'s `prepare (spoof-keys)` step. */
async function main(request: SpoofRebindRequest): Promise<SpoofKeysOutcome> {
  const { ownerUrl, readerUrl } = requestUrls(request);
  // backend/src/config.ts validates at IMPORT. It is the read-only role here,
  // which can write nothing; the owner credential never enters the environment.
  process.env.DATABASE_URL = readerUrl;
  process.env.WORKER_DATABASE_URL = readerUrl;
  process.env.RM_ENV = "stage";
  const { default: postgres } = await import("postgres");
  const { observeTargetLock } = await import("../src/db/target-lock.ts");
  const reader = postgres(readerUrl, { max: 1, onnotice: () => {} });
  try {
    const lock = observeTargetLock(reader, request.lock.backendPid, request.lock.holder as unknown as LockHolder);
    return await spoofRebind({
      ownerUrl,
      instance: request.instance,
      stateRoot: request.stateRoot,
      names: request.names,
      flagExplicit: request.flagExplicit,
      rmEnv: request.rmEnv,
      credentialPath: request.credentialPath,
      lock,
    });
  } finally {
    await reader.end({ timeout: 5 }).catch(() => undefined);
  }
}

if (import.meta.main) {
  // A terminal's Ctrl-C is the boot's to honour at its next phase boundary,
  // never this step's to die of halfway through a fenced write.
  process.on("SIGINT", () => {});
  let request: SpoofRebindRequest | null = null;
  let result: SpoofRebindResult;
  try {
    request = JSON.parse(process.env.RM_SPOOF_REQUEST ?? "null") as SpoofRebindRequest | null;
    if (request === null) throw new Error("no request: RM_SPOOF_REQUEST is unset (this process is started by `bun smoke --spoof-keys`)");
    result = { ok: true, ...(await main(request)) };
  } catch (error) {
    result = {
      ok: false,
      ...(error instanceof SpoofKeysRefusal ? { reason: error.reason } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
    console.error(`[smoke:spoof-keys] ${result.error}`);
  }
  if (request?.resultFile) writeFileSync(request.resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  process.exit(result.ok ? 0 : 1);
}
