// The API automation-token store (issue #1026 W4.5).
//
// Governed by docs/technical/smoke-production-spec.md §3 and
// docs/technical/system-scheduler-spec.md §7. Migration 0069 is the table; this
// module is the only thing that writes it and the only thing that reads it.
// Migration 0078 keyed it on (instance, holder) for §3's three holders: the
// scheduler, the analytics producer and the operator.
//
// WHY PROVISIONING LIVES HERE AND NOT IN A SCRIPT. The secret is generated,
// hashed and stored in one place, so no caller ever holds a path by which the
// plaintext reaches the database. `provisionAutomationToken` returns the secret
// exactly once, to whoever asked for it, and the row it wrote cannot reproduce
// it. The delivery half — writing that secret into the instance's state
// directory as a file — belongs to backend/scripts/provision-tokens.ts, the one
// entry module that calls this (smoke spec §3/§5/§9.1).
import { randomBytes } from "node:crypto";
import { sql } from "./client.ts";
import { on, registerQuery, type RegistryDb } from "./registry.ts";
import { hashKey } from "../lib/keys.ts";

/**
 * Who presents a service token — smoke spec §3's three holders.
 *
 * `system-scheduler` was the store's only holder until migration 0078. It is
 * still the default, so a caller that names no holder means what it always did.
 */
export const AUTOMATION_HOLDERS = ["system-scheduler", "analytics-producer", "operator"] as const;
export type AutomationHolder = (typeof AUTOMATION_HOLDERS)[number];

/**
 * Each holder's rights, and no others.
 *
 * `system-scheduler`: "read subjects and sessions, perform lifecycle
 * transitions" (scheduler spec §7). `analytics-producer`: "the analytics
 * ingestion routes". The operator: "the admin routes; this replaces the
 * `ADMIN_TOKEN` environment variable" (smoke spec §3). The first two "hold one
 * API credential and no other kind", so a right from another holder's list is
 * refused rather than recorded. Migration 0078's
 * `automation_tokens_holder_rights_check` holds the same table, so a value that
 * gets past this module is still refused by the database.
 */
export const HOLDER_RIGHTS = {
  "system-scheduler": ["read_subjects", "read_sessions", "lifecycle_transitions"],
  "analytics-producer": ["analytics_ingestion"],
  operator: ["admin"],
} as const satisfies Record<AutomationHolder, readonly string[]>;

/**
 * Every right any holder may carry. The scheduler's three come first, in the
 * order migration 0069 declared them; migration 0078's
 * `automation_tokens_rights_known_check` holds the same list.
 */
export const AUTOMATION_RIGHTS = [
  ...HOLDER_RIGHTS["system-scheduler"],
  ...HOLDER_RIGHTS["analytics-producer"],
  ...HOLDER_RIGHTS.operator,
] as const;
export type AutomationRight = (typeof AUTOMATION_RIGHTS)[number];

export interface AutomationGrant {
  instance: string;
  holder: AutomationHolder;
  rights: AutomationRight[];
}

/**
 * THE TWO STATEMENTS, REGISTERED (smoke-production-spec.md §7.1).
 *
 * Provisioning runs as `rm_owner`: migration 0069 grants the runtime roles
 * SELECT on this table and nothing else, because a token is written by "the
 * same authorized preparation that writes `deployment_identity`" (§3), and
 * that table is "writable only by `rm_owner`" (§4.2).
 *
 * The one entry module that reaches the write is backend/scripts/provision-tokens.ts:
 * `bun smoke`'s `prepare (tokens)` step for `--local blank`/`dump` (§5) and
 * `bun scripts/prod-init.ts provision-tokens` (§9.1 step 5), each inside the
 * mutation fence on the connection performing the write (§2).
 */
const provisionToken = registerQuery({
  role: "rm_owner",
  object: "automation_tokens",
  // UPDATE for ON CONFLICT DO UPDATE; SELECT because it reads EXCLUDED columns.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/db/automation-tokens:provisionAutomationToken",
  purpose: "Provision or rotate one holder's automation token on one instance, storing only its hash.",
  callers: ["scripts/provision-tokens"],
  probe: {
    statement: `INSERT INTO automation_tokens (instance, holder, token_hash, rights)
      VALUES ($1, $2, $3, $4::text[])
      ON CONFLICT (instance, holder) DO UPDATE
        SET token_hash = EXCLUDED.token_hash, rights = EXCLUDED.rights, created_at = now(), created_by = CURRENT_USER`,
    params: ["probe-instance", "system-scheduler", "0000000000000000000000000000000000000000000000000000000000000000", "{read_subjects}"],
  },
});

const lookupToken = registerQuery({
  role: "rm_app",
  object: "automation_tokens",
  privileges: ["SELECT"],
  site: "src/db/automation-tokens:lookupAutomationToken",
  purpose: "Resolve a presented automation token to its grant by hash, for the routes that check a right.",
  callers: ["src/api/routes/swarm-admin", "src/api/routes/swarm-stream"],
  probe: {
    statement: "SELECT instance, holder, rights FROM automation_tokens WHERE token_hash = $1",
    params: ["0000000000000000000000000000000000000000000000000000000000000000"],
  },
});

/** The token's wire prefix, so an operator reading a file knows what it is holding. */
const TOKEN_PREFIX = "rmat_";

/**
 * Provision (or rotate) one holder's token on one instance.
 *
 * Rotation and first issue are the same statement on purpose: smoke spec §3
 * says "Rotation is a re-provision and a container restart", and an UPSERT is
 * what makes that true without a second code path that could drift. The old
 * hash is overwritten, so the old token stops validating the moment this
 * commits — there is no grace window, because a grace window is a second valid
 * credential nobody is tracking.
 *
 * The key is (instance, holder), so re-provisioning one holder replaces that
 * holder's row and no other: "provisioning one never invalidates another's".
 * `holder` defaults to `system-scheduler`, the store's only holder before
 * migration 0078, so existing callers keep their meaning.
 *
 * `db` is the handle the write runs on. The provisioning entry module passes
 * its fenced `rm_owner` transaction (§2: every mutation "runs in a transaction
 * that first takes `pg_advisory_xact_lock` … on the connection performing
 * it"); without one the write goes to the process pool.
 *
 * Returns the secret ONCE. It is not stored and cannot be recovered.
 */
export async function provisionAutomationToken(
  instance: string,
  rights: readonly AutomationRight[],
  options: { holder?: AutomationHolder; db?: RegistryDb } = {},
): Promise<{ instance: string; holder: AutomationHolder; token: string; rights: AutomationRight[] }> {
  const holder = options.holder ?? "system-scheduler";
  if (!(AUTOMATION_HOLDERS as readonly string[]).includes(holder)) {
    throw new Error(
      `provisionAutomationToken: unknown holder "${holder}" — expected ${AUTOMATION_HOLDERS.join(" | ")}`,
    );
  }
  if (rights.length === 0) {
    throw new Error("provisionAutomationToken: a token with no rights authorizes nothing — name at least one");
  }
  const allowed: readonly string[] = HOLDER_RIGHTS[holder];
  for (const right of rights) {
    if (!(AUTOMATION_RIGHTS as readonly string[]).includes(right)) {
      throw new Error(
        `provisionAutomationToken: unknown right "${right}" — expected ${AUTOMATION_RIGHTS.join(" | ")}`,
      );
    }
    if (!allowed.includes(right)) {
      throw new Error(
        `provisionAutomationToken: ${holder} may not hold "${right}" — its rights are ${allowed.join(" | ")}`,
      );
    }
  }
  const unique = [...new Set(rights)];
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await on(options.db ?? sql, provisionToken)`
    INSERT INTO automation_tokens (instance, holder, token_hash, rights)
    VALUES (${instance}, ${holder}, ${hashKey(token)}, ${unique})
    ON CONFLICT (instance, holder) DO UPDATE
      SET token_hash = EXCLUDED.token_hash,
          rights = EXCLUDED.rights,
          created_at = now(),
          created_by = CURRENT_USER`;
  return { instance, holder, token, rights: unique };
}

/**
 * Validate a presented secret against the store.
 *
 * The lookup is BY HASH, which is both the only thing stored and a constant
 * -width equality on a unique index — there is no row to compare against until
 * the hash matches, so there is nothing for a timing comparison to leak beyond
 * "some row exists", which the index answers in constant time anyway.
 *
 * Returns null for an unknown token. That is the whole of "a file on disk
 * establishes nothing by itself": the file is a string, and a string that
 * matches no row is refused exactly like a forged one.
 */
export async function lookupAutomationToken(presented: string | null): Promise<AutomationGrant | null> {
  if (!presented) return null;
  const [row] = await on(sql, lookupToken)<{ instance: string; holder: AutomationHolder; rights: AutomationRight[] }>`
    SELECT instance, holder, rights FROM automation_tokens WHERE token_hash = ${hashKey(presented)}`;
  return row ? { instance: row.instance, holder: row.holder, rights: row.rights } : null;
}
